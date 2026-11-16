#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能自检：确认这份安装是完整、能用的。

在任意目录跑：

    python3 scripts/selftest.py          # 人看
    python3 scripts/selftest.py --json   # 机器读（给 agent 用）

全部动作只在系统临时目录里进行，不碰你的工程、不联网、不改配置。检查五件事：

  1. 随包模板齐不齐（引擎、工作台、scene.json）
  2. 版本号四处是否一致（SKILL.md / app.js / index.html / CHANGELOG）
  3. new_project.py 能不能建出可运行工程
  4. validate_scene.py 对新建工程是否 0 错 0 警
  5. build_singlefile.py 能不能打成零外部依赖的单文件，且带上调试工作台

任何一项不过就以退出码 1 结束，方便 agent 拿它当门禁。
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STARTER = ROOT / "assets" / "previs-starter"
VERSION_RE = re.compile(r'\?v=(\d+\.\d+\.\d+)')


def read(path):
    return path.read_text(encoding="utf-8")


def skill_version():
    """从 SKILL.md frontmatter 里取版本号。"""
    m = re.search(r'^---\n(.*?)\n---\n', read(ROOT / "SKILL.md"), re.S)
    if not m:
        return ""
    v = re.search(r'^\s*version:\s*"?([^"\n]+)"?', m.group(1), re.M)
    return v.group(1).strip() if v else ""


def run(args, timeout=180):
    proc = subprocess.run([sys.executable] + [str(a) for a in args],
                          capture_output=True, text=True, timeout=timeout)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main():
    ap = argparse.ArgumentParser(description="zpboom-3d-previs 技能自检")
    ap.add_argument("--json", action="store_true", help="只输出 JSON，供 agent 解析")
    ap.add_argument("--keep", action="store_true", help="保留临时产物便于排查")
    ap.add_argument("--duration", type=float, default=12.0, help="自检工程时长（秒）")
    args = ap.parse_args()

    checks = []

    def add(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not args.json:
            print("  %s %-34s %s" % ("✓" if ok else "✗", name, detail))
        return ok

    if not args.json:
        print("zpboom-3d-previs 自检  %s" % ROOT)

    # 1. 随包模板
    need = ["index.html", "app.js", "scene.json", "styles.css", "workbench.js", "workbench.css"]
    missing = [n for n in need if not (STARTER / n).is_file()]
    add("随包模板齐全", not missing, "缺 " + "、".join(missing) if missing else "%d 个文件" % len(need))

    # 2. 版本号四处一致
    ver = skill_version()
    idx = read(STARTER / "index.html")
    app = read(STARTER / "app.js")
    idx_v = sorted(set(VERSION_RE.findall(idx)))
    app_v = sorted(set(VERSION_RE.findall(app)))
    clog = re.search(r'^## (\d+\.\d+\.\d+)', read(ROOT / "CHANGELOG.md"), re.M)
    clog_v = clog.group(1) if clog else ""
    consistent = ver and ver in idx_v and ver in app_v and clog_v == ver
    add("版本号四处一致", consistent,
        "SKILL.md=%s index=%s app=%s CHANGELOG=%s" % (ver, ",".join(idx_v) or "-", ",".join(app_v) or "-", clog_v or "-"))

    # 3. 工作台已接进页面
    wb = STARTER / "workbench.js"
    wired = "workbench.js?v=" in idx and "workbench.css?v=" in idx
    add("诊断工作台已接入", wired and wb.is_file() and wb.stat().st_size > 8000,
        ("workbench.js %d B" % wb.stat().st_size) if wb.is_file() else "缺 workbench.js")

    tmp = Path(tempfile.mkdtemp(prefix="zp-previs-selftest-"))
    try:
        proj = tmp / "proj"
        code, out = run([HERE / "new_project.py", "--output", proj, "--title", "自检工程",
                         "--duration", args.duration])
        try:
            detail = json.loads(out[out.index("{"):]).get("status", "")[:44]
        except (ValueError, json.JSONDecodeError):
            detail = (out.strip().splitlines() or [""])[0][:60]
        add("new_project 建工程", code == 0 and (proj / "scene.json").is_file(), detail)
        if code != 0:
            raise SystemExit(finish(checks, args, tmp))

        # 4. schema 校验
        code, out = run([HERE / "validate_scene.py", proj / "scene.json"])
        try:
            report = json.loads(out[out.index("{"):])
        except (ValueError, json.JSONDecodeError):
            report = {}
        add("scene.json 校验", code == 0 and report.get("valid") is True,
            "errors=%d warnings=%d" % (len(report.get("errors") or []), len(report.get("warnings") or [])))

        # 5. 单文件打包
        single = tmp / "out.html"
        code, out = run([HERE / "build_singlefile.py", "--project", proj, "--output", single])
        size = single.stat().st_size if single.is_file() else 0
        html = read(single) if single.is_file() else ""
        external = len(re.findall(r'(?:src|href)="(?!data:|#)[^"]+\.(?:js|css|json)"', html))
        add("单文件打包", code == 0 and size > 500_000,
            "%.2f MB" % (size / 1e6) if size else (out.strip().splitlines() or ["失败"])[-1][:70])
        add("单文件零外部依赖", external == 0 and bool(html), "外部引用 %d 处" % external)
        add("单文件含工作台与体检", "wb-tab" in html and "occlusion" in html,
            "workbench + occlusion")
    except SystemExit:
        raise

    return finish(checks, args, tmp)


def finish(checks, args, tmp):
    failed = [c for c in checks if not c["ok"]]
    passed = len(checks) - len(failed)
    keep = args.keep or bool(failed)
    if args.json:
        print(json.dumps({
            "skill": "zpboom-3d-previs",
            "root": str(ROOT),
            "version": skill_version(),
            "passed": passed,
            "failed": len(failed),
            "checks": checks,
            "ok": not failed,
        }, ensure_ascii=False, indent=2))
    else:
        print("\n  %d 项通过 / %d 项失败 —— %s" % (passed, len(failed), "可用" if not failed else "不可用"))
        if failed:
            print("  失败项：" + "、".join(c["name"] for c in failed))
        if keep:
            print("  临时产物保留在 %s" % tmp)
    if not keep:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
