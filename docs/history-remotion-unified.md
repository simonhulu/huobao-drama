# 历史视频统一制作：架构核实与最小整合

核实日期：2026-10-26。本文件描述源码与接口边界；单部作品是否成功仍以该任务日志、媒体报告和实际回看记录为准，不把文档当成运行证明。

## 真实关系

| 组成 | 已有职责与问题 | 统一后职责 |
| --- | --- | --- |
| `history-scripts` | 保存采集来源、确认稿件、发布包装、Huasheng 与视频交付；早期 motion 入口独立管理制作 | “精细化制作”创建/复用现有生产任务并打开对应 Remotion 详情；Huasheng 保留 |
| `remotion-history-factory` skill | 原来是全画幅图片、配音和分镜准备，再交给 videoeditor 的 agent 指令 | 唯一制作合同，效率优先、视频素材优先；指向实际 factory API |
| Episode | 有确认正文、`preTtsAudioUrl`、`preTtsTitlesJson`、storyboards、既有 `videoUrl` | 作品的统一身份和已有创作资料，不为网页再造一套作品对象 |
| Remotion projects/shots/renders | 已有项目、分镜、渲染持久化；旧 UI 列表依赖 grid productions，工作详情链接缺页 | 展示当前任务投影、素材决定、进度与真实输出，保留旧成片与原编辑器链接 |
| `history-motion-pipeline` | 已实现自动规划、受限检索、补图、地图、字幕、字体动画、SFX、渲染与历史稿交付；任务单独存 SQLite 快照 | 继续作为唯一媒体执行器，不重写同类 pipeline；补图/地图失败保留可重试缺口，不用独立信息卡填空 |
| `history-factory` | 本次新增薄连接层 | 将源稿件、Episode、Remotion 与已有 motion job 绑定，复用输入并登记成片 |
| `videoeditor` | 有逐镜意图、人物反应、道具线条、动态标题、语义运镜、声音及编码工具 | 保留专项精修；通用标题/编码能力被复用，不假称全部专项效果已自动接通 |
| 交付 | 历史稿记录可能已有其他渠道成片 | 本轮输出单独登记，原交付存在时保留；关联失败可单独重试 |

主路径为：保存稿件或既有 Episode → `history-factory` → 同一 motion job → Remotion 完整 composition → renders/Episode → 原稿件交付。

## 已实现和仍需判断的能力

| 能力 | 代码证据 | 边界 |
| --- | --- | --- |
| 受限素材检索 | `history-motion-production.ts` 调用 `HuashengMaterialLibrary.search()` | 关键词检索，限定已下载、推荐前三及当前候选数；不是全库语义视觉搜索 |
| 自动媒体选择/补缺 | `history-motion-pipeline.ts` 的 `materialForShot()` | 按排序取首个可读视频；坏文件有限顺延；每个成片的视频、图片按实际 SHA-256 去重，地图按底图与地理/动作内容共同去重；地图/生图失败会记录可重试 fallback，不证明候选内容已逐镜看过 |
| 固定正文与时间 | `splitMotionNarration()`、`alignMotionShots()`；bridge 的 `seedAudio()`、`attach()` | 文字完整性与累计帧守恒可校验；句内/字幕估算不是逐字识别 |
| 复用已有图/配音/分镜 | `history-factory.ts` | 复用需要对应正文且媒体可读；图片连续性未自动识别 |
| 视频、图片、地图、信息图、大字与完整字幕 | `HistoryMotionFactory.tsx`、`scripts/history-motion/render.mjs` | 已有渲染层；视频默认静音，短片段明确尾帧停留 |
| 现代地理锚点与示意路线 | `history-motion-maps.ts`、`scripts/history-motion/map-data.mjs` | 不等于精确古城、古河道、古道或古国界；无资料时降级 |
| 人物反应/道具动画 | `ReferenceEditorialOverlay.tsx` 和 videoeditor 工具 | 专项工具保留；自动工厂当前主要复用动态标题，头部动态追踪尚未接通 |
| 视频内容抽检 | `history-motion-visual-evidence.ts`、实际作品回看记录 | 新素材最多两帧模型观察，缓存后与本镜叙事核对；明显时代/内容冲突排除。超时标未核验；不能代替连续回看、精确 OCR、人物跟踪或历史事实核查 |
| 自动技术交付 | render 输出检查 + `history-factory.deliver()` | 验证编码、音轨、帧数、时长、体积与文件哈希；不证明审美、历史结论或完整听审 |

原稿和发布包装仍以既有确认值为准，factory 不重新写稿。历史源创建 Episode 时复用已有交付标题与简介；更多平台发布字段继续留在原稿交付记录，不另造包装系统。

## 三条制作不变量与观察边界

- 已保存的 `rewrittenScript` 是本轮唯一正文来源，必须逐字保留；导演规划、字幕分句、重试和交付都不能删改旁白。
- 同一成片内的视频和图片以实际文件 SHA-256 去重；地图按底图哈希与城市、路线、区域和包围动作共同去重，共用地形但内容不同的地图镜头可并存。更换裁切、入点、翻转、改色或文件名不产生新的素材；重试复用已成功工件，但不能分配给第二个镜头。
- 信息动画、时间线、关系线和动态文字只能作为视频或图片上的解释层，保持底层媒体可见，不能独立渲染成纯色 PPT。缺媒体时优先补图；补图/地图失败可重试，暂时没有合法底层媒体就保留缺口，不用信息动画冒充镜头。

自动视觉抽检默认每任务 90 秒处理预算（`HISTORY_MOTION_REVIEW_BUDGET_MS`），每个新素材最多两帧；这不是已观看 90 秒视频。预算耗尽标记后续素材未核验，有限采样不能证实人物身份、历史事件、地点、年代、连续性或地图历史结论。历史真实性需要独立史料审阅，成片质量需要实际观看和听审。

## 最小整合实现

`backend/src/services/history-factory.ts` 包装已有 `createMotionRunner()`，`getHistoryFactory()` 提供进程内单例。执行状态继续写入 `history_motion_productions`；`job.factory` 保存 Episode、Remotion project、来源和正文哈希，Episode metadata 反向记录关联。Remotion 项目进度、逐镜决定和 renders 由该执行状态投影，不再新增执行引擎。

接口由 `backend/src/routes/history-factory.ts` 挂载到 `/api/v1/remotion`：

- `GET/POST /history-productions`：列表及从历史来源开始。
- `GET /episodes/:id/history-production`：原稿、配音、任务、逐镜与输出。
- `POST /episodes/:id/history-production/start|retry`：原 Episode 制作或恢复。
- `GET /episodes/:id/history-production/evidence`：下载任务编辑记录快照。

同输入复用任务，服务重启后的中断任务可恢复，已有渲染只重试登记。新成片写入 `/static/remotion/` 与 render 记录；已有 Episode 视频和历史交付被保留，不用旧 URL 冒充新产物。

当前渲染为不透明 composition 使用 JPEG quality 92 中间帧、512 MiB OffthreadVideo 缓存和 90 秒单帧超时，显式设置 `colorSpace:'bt709'`，仍按 1080p、30fps、H.264/AAC 交付；不再要求保留全片 PNG 序列，仍保留少量回看代表帧。具体配置在 `scripts/history-motion/render.mjs`，这项处理预算与自动视觉抽检预算分别记录。

`/remotion` 是制作列表，`/remotion/episode/:id` 是工作详情。页面围绕“原稿与配音 → 画面 → 成片”组织，显示当前步骤、问题、继续按钮、播放器和来源记录；风格库为次级入口，原 Episode 编辑器仍可访问。UI 不再要求用户理解 grid/comic/五格内部状态。

## 本次验收怎样证明结果

服务与路由测试适合证明幂等开始、输入复用、失败恢复、路径/时间校验和交付登记。真实任务的 `narration.json`、`decisions.json`、render 日志、媒体 sidecar 与输出可证明本轮实际用了什么、运行到哪一步以及技术产物参数。

代表片段须覆盖实际出现的视频素材、补位图片、适用地图和动态文字；地图不适用时记录理由，不为凑类型强塞地图。固定正文与母带后完成整片，交付完整视频及带声精选，明确回看时间段和声音检查方式。

历史事件解释、影视镜头是否容易误导、地图史料推论和观众是否看懂，仍需独立历史审阅或真实观众反馈。实际未听完/看完的范围保持未核验，不能用代码通过、文件存在或动画数量代替。

## v2 真实作品已完成技术交付

source 62 / Episode 1062 的[完整新成片](http://localhost:3013/static/remotion/history-302df8bb-f6b0-4929-9500-713def0241fd-61d2c8de15c8.mp4)和[带声精选](http://localhost:3013/static/remotion/history-302df8bb-f6b0-4929-9500-713def0241fd-61d2c8de15c8-preview.mp4)已交付，旧成片与原来源交付保留。[最终验证记录](../data/temp/history-factory-validation-20261026/v2-verification.json)记录正文逐字一致、配音哈希未变、53 个源文件 SHA-256 互异：25 个视频、27 张图片、1 幅地图；独立 graphic 为 0，解释叠层为 9。输出为 1920×1080、30fps、H.264/AAC，7911 帧、263.744 秒、61,153,035 字节，全片 FFmpeg 解码退出码为 0。

前两次整片尝试分别因主动停止 PNG 方案、浏览器崩溃后超时而未完成；第三次完成全帧后被色彩校验挡住。复用该整片转换为 BT.709 有限范围、保留全部帧并复制 AAC 音轨后通过技术交付；渲染器现已显式输出 BT.709，真实 JPEG 输出回归测试通过，没有用旧片替代本轮结果。

实际视觉检查包含原视频取用段首/中/末帧、27 张图片、21.7 秒代表片段的 6 帧，以及最终片第 1–24 镜的 24 个中点帧（3.40–115.30 秒，见 [final 联系图目录](../data/temp/history-factory-validation-20261026/review/v2/final/)）。这 24 个输出采样未见重大遮挡、重复、独立纯色卡片或需阻断交付的明显错配；第 15 镜的原“庐山”与新标题同时可见但未重叠，第 17 镜仅展示瑞金位置示意。抽帧不等于连续看完或听审；独立历史审阅、全片听审与观众理解验证仍未完成。

操作合同见 [统一工厂 skill](../.codex/skills/remotion-history-factory/SKILL.md)。旧 `history-motion-video-factory` 仅兼容指向此合同，旧五格 runner 只服务明确恢复的历史任务。
