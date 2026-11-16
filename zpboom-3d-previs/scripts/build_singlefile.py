#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一个 3D 预演工程打成「单文件零依赖」HTML。

为什么要这么干：原工程用 ES module + fetch('./scene.json')，浏览器在 file:// 协议下
会同时拒绝 module script（跨源）和 fetch（file:// 被禁），所以「双击 index.html」打不开，
必须起本地 HTTP 服务——这在换机器、换系统、给同事看的时候都很麻烦。

这里的做法：
  1. 把 three / mp4-muxer / TransformControls / editor / viewtools / weather / videomocap
     这些模块合并成**一个** inline module script。工具模块各自包 IIFE，
     顶层只留 app.js——这样模块之间的顶层同名声明（$ / box / seek …）不会撞车。
  2. scene.json 内联成常量，替换掉 fetch。
  3. CSS 内联进 <style>，workbench.js 内联进 <script>。
结果：一个 .html 文件，拷到任何机器任何系统，双击就能开、就能调。

单文件版不支持（会给出明确提示，请用目录版）：
  · FBX 动作文件（FBXLoader）、场景扩展模块、导出 Blender（GLTFExporter）——依赖动态 import。
  · 视频动捕的 mediapipe wasm（file:// 下取不到跨源 wasm）。
"""
import argparse
import json
import re
from pathlib import Path

# ───────────── 模块处理 ─────────────


def strip_export_blocks(src):
    """删掉 export { ... } 块，返回 (新源码, [(导出名, 内部名), ...])。"""
    exports = []

    def repl(match):
        for item in match.group(1).split(","):
            item = item.strip()
            if not item:
                continue
            if " as " in item:
                internal, exported = item.split(" as ")
                exports.append((exported.strip(), internal.strip()))
            else:
                exports.append((item, item))
        return ""

    return re.sub(r"export\s*\{([^}]*)\}\s*;?", repl, src), exports


def build_three(src):
    """three.module.js → const THREE = (() => { ... return {...}; })()"""
    src, exports = strip_export_blocks(src)
    mapping = ", ".join('"%s": %s' % (e, i) for e, i in exports)
    return "const THREE = (() => {\n%s\nreturn {%s};\n})();\n" % (src, mapping)


def build_transform_controls(src):
    """TransformControls.js → IIFE(THREE)，返回三个类。"""
    names = []

    def grab(match):
        for item in match.group(1).split(","):
            item = item.strip()
            if item:
                names.append(item)
        return ""

    src = re.sub(r"import\s*\{([^}]*)\}\s*from\s*['\"]three['\"]\s*;?", grab, src)
    src, _ = strip_export_blocks(src)
    destructure = "const {%s} = THREE;" % ", ".join(names) if names else ""
    return ("const __TC = (() => {\n%s\n%s\nreturn {TransformControls, TransformControlsGizmo, TransformControlsPlane};\n})();\n"
            % (destructure, src))


def build_simple(src, names, var_name="__MOD", deps=""):
    """普通工具模块：去掉 export 关键字，包 IIFE，返回指定名字。
    var_name 必须逐模块唯一——多个 IIFE 共用同一个 const 名会直接语法报错。"""
    src = re.sub(r"^\s*import\s[^\n]*\n", "", src, flags=re.M)
    src = re.sub(r"\bexport\s+(function|const|let|class|async)\b", r"\1", src)
    src, _ = strip_export_blocks(src)
    return "const %s = (() => {\n%s\n%s\nreturn {%s};\n})();\n" % (var_name, deps, src, ", ".join(names))


def build_app(src, scene_literal):
    """app.js：去掉 import / export，替换 fetch 与动态 import，注入依赖解构。"""
    src = re.sub(r"^\s*import\s[^\n]*\n", "", src, flags=re.M)
    src = re.sub(r"\bexport\s+(function|const|let|class|async)\b", r"\1", src)

    # 场景：fetch → 内联常量
    old_fetch = "const response = await fetch('./scene.json', {cache: 'no-store'}); if (!response.ok) throw new Error(`scene.json HTTP ${response.status}`);\n    const raw = await response.json();"
    new_fetch = "const raw = JSON.parse(__SCENE_JSON__);"
    if src.count(old_fetch) != 1:
        # 兜底：只要匹配到 fetch('./scene.json' 就替换整行
        src = re.sub(r"const response = await fetch\('\./scene\.json'[^\n]*\n\s*const raw = await response\.json\(\);",
                     new_fetch, src)
    else:
        src = src.replace(old_fetch, new_fetch)

    # 动态 import：能用内联的用内联，不能用的给明确提示
    src = src.replace("import('./videomocap.js?v=2.8.0')", "__VIDEOMOCAP__")
    src = src.replace("import('./videomocap.js?v=2.7.5')", "__VIDEOMOCAP__")
    src = src.replace("import('./vendor/addons/loaders/FBXLoader.js')", "__unsupported('FBX 动作文件')")
    src = src.replace("import('./vendor/addons/exporters/GLTFExporter.js')", "__unsupported('导出 Blender（GLB）')")
    src = src.replace("import(new URL(path, location.href).href)", "__unsupported('场景扩展模块')")

    head = ("const __SCENE_JSON__ = %s;\n"
            "const __unsupported = (what) => { throw new Error('单文件工作台不支持「' + what + '」，请改用完整工程目录版'); };\n"
            "const {initEditor} = __EDITOR;\n"
            "const {initViewTools} = __VIEWTOOLS;\n"
            "const {initWeather, cleanWeather, WEATHER_FIELDS, WEATHER_PRESETS} = __WEATHER;\n"
            "const {Muxer, ArrayBufferTarget} = __MUXER;\n" % scene_literal)
    return head + src


# ───────────── 页面组装 ─────────────


def build_single_html(project: Path, title: str, banner: str = ""):
    def read(name):
        return (project / name).read_text(encoding="utf-8")

    scene_text = read("scene.json")
    scene_literal = json.dumps(scene_text, ensure_ascii=False)

    parts = []
    parts.append(build_three(read("vendor/three.module.js")))
    parts.append(build_transform_controls(read("vendor/addons/controls/TransformControls.js")))
    parts.append(build_simple(read("vendor/mp4-muxer.mjs"), ["Muxer", "ArrayBufferTarget"], "__MUXER"))
    parts.append(build_simple(read("editor.js"), ["initEditor"], "__EDITOR", "const {TransformControls} = __TC;"))
    parts.append(build_simple(read("viewtools.js"), ["initViewTools"], "__VIEWTOOLS"))
    parts.append(build_simple(read("weather.js"), ["initWeather", "cleanWeather", "WEATHER_FIELDS", "WEATHER_PRESETS"], "__WEATHER"))
    parts.append(build_simple(read("videomocap.js"), ["openVideoMocap", "_test"], "__VIDEOMOCAP__"))
    parts.append(build_app(read("app.js"), scene_literal))
    engine = "\n".join(parts)

    html = read("index.html")
    css = read("styles.css") + "\n" + read("workbench.css")
    wb_js = read("workbench.js")

    # 去掉 importmap（内联合并后不再需要 bare specifier）
    html = re.sub(r"<script type=\"importmap\">.*?</script>\s*", lambda m: "", html, flags=re.S)
    # CSS → 内联
    html = re.sub(r"<link rel=\"stylesheet\" href=\"\./workbench\.css[^\"]*\">", lambda m: "", html)
    html = re.sub(r"<link rel=\"stylesheet\" href=\"\./styles\.css[^\"]*\">",
                  lambda m: "<style>\n%s\n</style>" % css, html)
    # workbench.js → 内联普通 script
    html = re.sub(r"<script src=\"\./workbench\.js[^\"]*\" defer></script>",
                  lambda m: "<script>\n%s\n</script>" % wb_js.replace("</script", "<\\/script"), html)
    # app.js → 内联 module
    html = re.sub(r"<script type=\"module\" src=\"\./app\.js[^\"]*\"></script>",
                  lambda m: "<script type=\"module\">\n%s\n</script>" % engine, html)
    html = html.replace("<title>", "<title>%s · " % title)

    if banner:
        html = html.replace("<body>", "<body>\n<!-- %s -->" % banner)
    return html


def main():
    ap = argparse.ArgumentParser(description="把预演工程打成单文件零依赖 HTML")
    ap.add_argument("--project", required=True, type=Path, help="工程目录（含 index.html / scene.json / vendor）")
    ap.add_argument("--output", required=True, type=Path, help="输出的单文件 HTML")
    ap.add_argument("--title", default="3D 预演调试工作台")
    ap.add_argument("--banner", default="")
    args = ap.parse_args()

    html = build_single_html(args.project, args.title, args.banner)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html, encoding="utf-8")

    # 自检：不该再有外部依赖
    external = re.findall(r'(?:src|href)="(?!data:|#)([^"]+)"', html)
    external = [u for u in external if not u.startswith(("http", "data:", "#"))]
    print("已生成：%s（%.1f MB）" % (args.output, len(html.encode("utf-8")) / 1024 / 1024))
    print("外部资源引用：%s" % (external or "无（零依赖）"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
