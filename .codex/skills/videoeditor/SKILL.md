---
name: videoeditor
description: Refine full-frame historical or illustrated videos shot by shot using narration, image composition, animated emotional reactions, kinetic titles and synchronized local sound effects. Deliver compact upload-ready H.264 videos with quality and filesize checks. Use directly with episode URLs or automatically from remotion-history-factory; also supports semantic camera motion and verified animated maps.
---

# Video Editor

## 默认：全画幅逐镜精修

用户请求精修、人物情绪、动态大字、声音设计，或历史工厂交接时，读取并执行 [refined-editing.md](references/refined-editing.md)。这是用户认可的全画幅图片 + Remotion 动画叠层 + 本地音效路线；不是五格漫画。

每镜结合锁定旁白、分镜说明和实际看过的图片写编辑决定，包括留白原因。保留原配音和时间，区分底部字幕、画面大字与人物反应。乱线要重绘、汗滴要落下，字体要有可见的入场与停留；静止图标不满足动画需求。音效依据动作与情绪选择，不能按关键词或数量凑数。

使用用户已授权的本地剪映音效库，选定素材后冻结来源和文件；默认不加 BGM。每镜不必有动画，每个动画不必有声音。史料、诗句与哀悼等段落允许安静。保留可复现计划、音效来源与真实检查记录。

工厂交接后直接继续，不再反向要求调用工厂；新稿由 `$remotion-history-factory` 负责原稿/配音/全画幅素材，本 Skill 负责精修直到可播放交付。已有 episode URL 先通过 inspector 查真实 episode ID，不把 URL 的集数当作 ID。

```text
$videoeditor http://127.0.0.1:3013/drama/652/episode/1
```

实际操作、字段和命令以精修参考为准。主要工具：

- `scripts/inspect_episode.mjs`：读取真实 episode 和镜头素材。
- `scripts/build_sound_catalog.mjs`：冻结所选本地音效和来源。
- `scripts/build_refined_plan.mjs`：将逐镜决策、冻结旁白/titles 编译为编辑计划，守恒帧数和原文。
- 项目根目录 `scripts/videoeditor/fine_edit.mjs`、`reference_edit.mjs`、`editorial_sfx.mjs`：底片、连续动画、合并和混音。
- 项目根目录 `scripts/videoeditor/sound_edit_delivery.mjs`：完整视频的带声精选与回看页。

不要调用旧五格 runner，或把底片和动画合成放到同一个 shots 目录。不要把某集镜头编号、动画数量、头部坐标复制给新故事。已有版本保留，新结果使用新版本路径。

## 交付标准

新视频在最终合成编码时直接输出上传版，使用 [refined-editing.md 的上传编码与体积验收](references/refined-editing.md#上传编码与体积验收)。保持分辨率、帧率、字幕/动态层，默认 CRF 24 + slow + 2Mbps 峰值约束；完成状态必须同时满足画质抽检与真实文件体积预算，不新增对既有成片的批量压缩步骤。

完成指完整视频、带声音精选和检查证据已经存在，不只是计划/代码通过。检查代表镜头的连续帧、文字阅读与遮挡、声画同步、旁白可懂度、帧数/时长和音视频包哈希。静态截图不能证明动画，静音浏览器回放不能证明音效好听。不能真实听审时如实说明检查范围。

交付简要给出完整视频和精选链接、这次编辑重点及剩余限制。不自行发布外部平台，不因精修重新生成全片配音或擅改稿件。

## 按需使用的其他路线

- 用户明确指定独立数据库 Remotion 项目时，读取 [remotion-pipeline.md](references/remotion-pipeline.md) 和 [旧工作流操作](references/legacy-workflows.md)。先检查相关工具仍存在；它不是默认历史精修入口。
- 只修改旧任务 API 的摄像机运动时，使用 [旧工作流操作](references/legacy-workflows.md) 与 [editing-rules.md](references/editing-rules.md)。这些路径的元数据回退规则不允许默认精修丢镜头/旁白。
- 地理、行军、战线镜头需要地图时读取 [map-animation.md](references/map-animation.md)，验证真实坐标、路线事实与示意部分；可与精修叠层组合。
