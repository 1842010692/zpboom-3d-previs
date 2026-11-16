# 上游来源与改动边界

这份文件回答三个问题：**哪些是别人写的、哪些是本仓库加的、许可是怎么继承的。**

## 一、来源链路

| 顺序 | 项目 | 版本 | 作者 | 许可 |
|---|---|---|---|---|
| 原始 | Azhen.AI 3D 预演技能 | 1.0.0 | Azhen.AI | MIT |
| **上游基线** | [zpboom324-star/zpboom-3d-previs](https://github.com/zpboom324-star/zpboom-3d-previs) | **v2.7.5**（2026-11-09，提交 `4abe4c8`） | ZPboom.AI | MIT |
| 本仓库 | [1842010692/zpboom-3d-previs](https://github.com/1842010692/zpboom-3d-previs) | **v2.9.0** | 1842010692 | MIT |

上游的**完整提交历史原样保留**（7 个提交，作者均为 `zpboom324-star`，未压缩、未改写），`v2.7.4` / `v2.7.5` 两个标签也一并保留，指向真实的原始提交。

本仓库是一个普通仓库，不是 GitHub 的 fork（fork 关系取决于创建方式）。功能上没有区别；想要 fork 徽章可以在网页里 Fork 上游，再把本仓库历史强推过去。

## 二、本仓库新增了什么

分叉点是上游 **v2.7.5**。此后只有 **1 次提交**，**13 个文件 +1400 / −16**。

### v2.8.0 · 台词气泡 + 时间线内容条

- `scene.json` 新增 `dialogues` 段（`speaker` / `text` / `start` / `end`，起止为全片绝对秒）；说话人必须是已定义角色，网页与 `validate_scene.py` 双端校验一致。
- 人物旁自动弹出对话气泡：圆角框 + 姓名 + 逐字推进 + 闪烁光标，锚在头部挂点，随走位与机位实时跟随，出画自动隐藏。
- 气泡按**头部在屏幕上的实际大小**让位（特写时头占半屏也不压脸），两侧放不下就改放头下方或上方，始终留在画框内。
- 时间线下方新增「当前镜头内容」条：镜头编号、标题、时间码、动作描述与台词条（正在说的那条高亮）。
- 气泡层只存在于网页预览，不烧进导出的 MP4；干净模式下一并隐藏。
- 角色名牌缩小到原来的 62%。

### v2.9.0 · 跨平台调试工作台 + 遮挡体检 + 近景压脸处理

- **调试工作台**（顶栏按钮或 `D` 键）：实时读数 / 镜头表 / 台词表 / 体检四个页签，可导出 JSON、Markdown 诊断报告，可载入新的 `scene.json` 热替换。全部只走 `window.__ZPBOOM_PREVIS__` 公开接口。
- **两个体检 API**：`occlusion()`（逐镜逐观察点射线检测，返回遮挡物种类 / id / 距离 / 世界坐标 / 局部坐标）、`overlays()`（头占屏比例 / 名牌是否与头重叠 / 眼带不透明度）。
- **遮挡物白名单**：只算 `world` 子树与道具；角色、名牌、`CameraHelper`、`TransformControls`、粒子都不算——否则逐镜全误报。
- **角色名牌改屏幕空间重叠检测**：名牌是 `depthTest: false` 的 Sprite，永远压在画面最上层；改为把名牌矩形与头部圆形投影到 NDC 比较，重叠才收起，远景保留。
- **弧形眼带近景自动淡出**：白膜人偶的眼带在近景是横贯面门的实心亮带，按头占屏比例淡出（10% 起淡、28% 归零），远景保持实心当视线指示；眼带改用独立材质。
- **单文件打包器** `scripts/build_singlefile.py`：把引擎 + 场景 + 供应商库 + 工作台打成单文件零依赖 HTML，双击即开，绕开 `file://` 下 module script 与 `fetch` 被同时拒绝的限制。
- 文档同步：`README.md` 新增「跨平台调试工作台」一节，`SKILL.md` 新增 3.5 节，`references/scene-format.md` 补两个 API。

## 三、没有动的部分

引擎主干（机位、走位、动作、录制与导出）、`scene.json` 既有字段语义、白膜人偶造型与配色、动捕链路、Blender 导出、供应商库版本——均为上游原样，未做改动。

## 四、许可

MIT。上游版权声明原样保留在 [LICENSE.txt](LICENSE.txt)，未删改：

```
Copyright (c) 2026 ZPboom.AI
Portions Copyright (c) 2026 Azhen.AI (original v1.0.0, MIT)
Modifications for v2.8.0-v2.9.0 Copyright (c) 2026 1842010692 (GitHub), MIT
```

第三方运行库（Three.js r160 / mp4-muxer / fflate / MediaPipe）的许可文件保留在 `assets/previs-starter/vendor/`。

## 五、怎么跟进上游更新

本仓库已把上游配成 `upstream` 远端（只在本地，不影响仓库内容）：

```bash
git remote add upstream https://github.com/zpboom324-star/zpboom-3d-previs.git
git fetch upstream --tags
git log --oneline HEAD..upstream/main      # 上游有哪些新提交
git merge upstream/main                    # 或按需 cherry-pick
```

合并时优先保留本仓库对 `app.js`、`index.html`、`styles.css` 的改动（调试工作台、体检 API、名牌与眼带处理），冲突集中在这些文件属于预期情况。
