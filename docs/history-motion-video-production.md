# 历史视频精细化制作

本渠道从已保存的历史二创稿 `rewrittenScript` 出发，逐字保持正文，由统一 `remotion-history-factory` 调用模型设计视觉表达，使用受限检索得到的本地视频、缺口补图、按需地图、附着在底层媒体上的信息动画、短标题、完整字幕及本地音效，自动渲染并关联项目。Huasheng 制作继续使用原有链路。用户从 `/history-scripts` 点击“精细化制作”，创建或复用任务并进入 `/remotion/episode/<真实 episodeId>`，不再使用独立精细化工作台。

## 自动生产策略

- 视频素材按排序检查合法候选；明确内容/时代冲突或无法读取时有限顺延，不以主观置信度拦截。短素材可明确记录尾帧停留，不能静默循环。同一成片的视频、图片文件使用实际 SHA-256 去重，同资产换裁切、改入点、翻转或改色仍算重复。
- 导演先确定本镜要解释什么，再选择底层视频、图片或适用地图。时间线、对比、人物关系与引文使用 Remotion 信息叠层，保持视频/图片可见，不能独立做成纯色 PPT。
- 地图、生图、音效失败时记录 `plan.fallbacks`。地图或生图失败可改用尚未使用的合法底层视频/图片；缺媒体的补图仍失败就保留可重试缺口，不交付空画面或独立信息卡。音效缺失可留白。失败原因进入任务界面和报告，不出现在视频内容里。
- 项目串行制作，模型批次串行请求，生图逐项执行并缓存。生图请求在独立有时限进程中执行，保留原生成记录，避免超时后重复提交；重试复用成功工件，仅继续失败步骤，不把同一素材重新分配给另一镜。
- 渲染通过技术检查后自动关联项目，状态进入 `completed`，不会要求人工审核。`automaticDelivery` 明确记录未进行人工视觉及听审。
- 关联失败显示 `failed / stage=rendered`，成片仍可播放下载；点击“重试关联成片”只重新关联，不重复配音、选材或渲染。

`HISTORY_MOTION_IMAGE_TIMEOUT_MS` 默认180秒、范围10至600秒。`HISTORY_MOTION_SFX_ROOT` 默认用户 Downloads 下的 `2174款剪映音效库`。音效按文件名及表达用途匹配，FFmpeg 归一化、低音量混音并淡入淡出；每5秒最多一处，缺失或失败不阻塞成片。

可复用 skill：

- [remotion-history-factory](../.codex/skills/remotion-history-factory/SKILL.md)：统一制作合同、选镜、时间轴与精细化成片；`history-motion-video-factory` 仅作兼容入口。
- [history-map-animation](../.codex/skills/history-map-animation/SKILL.md)：真实地理数据、路线、控制变化与地图交付。
- [videoeditor](../.codex/skills/videoeditor/SKILL.md)：现有全画幅精修经验、逐镜视觉判断、字体动画和声音验收。

## 素材检索边界

大模型不能直接读取 SQLite。导演模型给出检索关键词，`history-motion-production.ts` 调用 `HuashengMaterialLibrary.search()`，管线按排序选首个可用候选，不再把候选交给选镜模型。查询示例：

```json
{
  "query": "红军 瑞金 行进",
  "shotSize": "wide",
  "limit": 20
}
```

`projectId`、`clipId` 可限定素材原项目与分镜；`durationMax` 可限制源片长度，但长素材本可裁切，不应机械设置为目标镜头时长。景别从标注判断，视频宽高比只用于取景。当前为关键词检索，不是向量搜索；服务有限拆词并合并排序，不把完整素材库发送给模型。

候选包含素材 ID、推荐排名、画面描述、来源分镜/检索标注、媒体参数、已校验路径和哈希。默认仅采用已下载、前三名的候选，路径必须位于配置的素材根目录中，符号链接也需通过实际路径检查。手动调整的素材 ID 必须来自该镜头的候选集合；入出点和所需镜头时长由后端校验。

`description` 只承载原素材描述，缺失时留空；`shotText` 和 `query` 分别是原项目文稿和检索标注，三者都不能代替本轮实际画面观察。前端分开展示这些字段，提供候选视频预览。显式计划可用 `sourceNote` 标注“战争题材示意画面”等必要说明，说明会进入实际成片。实际取用前校验文件哈希，避免不同素材 ID 指向同一文件。

影视再现不能自动标为历史实录。素材不足时自动补足画面；主观匹配度不作为任务闸门。任务保留候选、实际选择、替代原因和来源，供成片后回看。

## 接口与任务

新制作经 `/api/v1/remotion/history-productions` 与 `/api/v1/remotion/episodes/:episodeId/history-production` 统一入口，详见 [统一执行](../.codex/skills/remotion-history-factory/references/unified-workflow.md)。以下 `/api/v1/history-scripts/motion` 接口保留兼容任务、受限检索和局部操作；响应采用项目常规 `{code,data,message}` 格式。

| 方法与后缀 | 用途 |
| --- | --- |
| `GET /jobs` | 最近100条制作任务 |
| `GET /:id` | 当前稿件制作任务 |
| `POST /:id/produce` | 用 `{scriptRevision,profile}` 启动自动分镜、选材、配音和渲染 |
| `POST /materials/search` | 受限素材检索，返回有限 `candidates` |
| `POST /:id/plan` | 保存显式分镜计划；必须覆盖当前稿件旁白 |
| `GET /:id/jobs/:jobId` | 任务状态、候选、分镜与计划 |
| `POST /:id/jobs/:jobId/search` | 用 `{shotId,query}` 为一个镜头重新检索，并撤销该镜头旧选择 |
| `POST /:id/jobs/:jobId/select` | 用 `shotId` 和选择字段保存人工选片 |
| `POST /:id/jobs/:jobId/retry` | 从已保存工件继续模型/素材/渲染流程 |
| `POST /:id/jobs/:jobId/render` | 使用当前已选镜头继续渲染 |
| `POST /:id/jobs/:jobId/deliver` | 重新关联已有成片，异步返回排队状态，不重新渲染 |
| `POST /:id/jobs/:jobId/approve` | 旧接口兼容：直接重试关联，不写入人工审核记录 |
| `GET/HEAD /:id/jobs/:jobId/assets/:assetId` | 播放当前候选集合内的本地素材，支持 Range |
| `GET/HEAD /:id/jobs/:jobId/video` | 播放当前任务实际产出的 MP4，支持 Range |

任务保存在 SQLite 的 `history_motion_productions` 表，快照含稿件版本、查询、候选和计划。状态使用 `queued/planning/selecting/needs_review/rendering/validating/completed/failed`。同一稿件版本、同一规格尚未结束的任务会复用；修改与继续执行前再次核对稿件版本。已确认成片不接受选材修改。

`needs_review` 只为旧任务和显式手动分镜调整保留；新自动任务不进入人工确认状态。旧 `stage=selection` 可直接继续自动制作；已有 `stage=rendered` 成片只重试交付。服务重启时，处理中任务保留工件并标记可重试失败，排队任务继续调度。

自动关联前核对任务目录、成片路径、技术报告和 SHA-256。`plan.deliveryAssociation.status=attached` 表示已关联；若已有其他成片则返回 `existing_preserved`，保留原关联，本次输出仍可在任务中播放下载。失败保留已渲染视频和配音；重复或并发关联不重复创建交付文件。

素材根目录由 `HUASHENG_MATERIAL_ROOT` 配置，默认 `data/huasheng-recommendations`。稿件/制作任务使用项目 `DB_PATH`；不需要另建一份素材库。配音使用当前 `getNarrationAudioConfig()`，缺省时使用 `getAudioConfig()`，声音由对应 provider 的 `resolveDefaultNarrationVoiceId()` 选择。文本模型复用项目 `callTextModel()` 配置，未增加独立供应商设置。

## 时间轴与渲染

分镜旁白必须按原顺序逐字覆盖已保存的 `rewrittenScript`，制作阶段不得二创、删句或润色。任务绑定稿件 revision，优先复用匹配的配音母带与时间码，再用实际音频时长编译时间轴，累计取整保证总帧数守恒。字幕内部分句若采用字数比例，需要在证据中标明估算；不冒充强制对齐。

自动流程把旁白与配音缓存到 `data/storage/history-motion/<任务UUID>/`，每次渲染使用新的 `render-<时间戳>/movie.mp4`。同一稿件配音缓存有效时复用；源文件、成片和报告保留在本地。任务中的 `decisions.json` 记录候选快照及渲染镜头。

独立渲染入口：

```bash
node scripts/history-motion/render.mjs --plan /绝对路径/plan.json --output /绝对路径/movie.mp4
```

渲染器在当前工作区内读取计划和本地素材，冻结到独立 public 目录。计划应含 `width`、`height`、`fps:30`、`durationInFrames`、`audioPath`、`shots`；每镜包括唯一 `shotId`、`startFrame`、`frames`、视频范围及选用的动画。时间轴必须精确平铺。默认静止取景，Motion 根据语义显式填写；素材不足默认拒绝，明确选定 `shortfallPolicy: "freeze"` 才允许尾帧停留。

支持1920×1080横屏、1080×1920竖屏。最终视频由 Remotion `renderMedia()` 直接输出 H.264；默认 CRF24、slow、yuv420p、2Mbps 峰值与4M缓冲、GOP150、AAC128k。每镜必须有合法底层媒体；`graphic`（timeline/comparison/relationship/quote）是其上的解释层，不能替代 `imagePath/imageSha256` 或视频。顶层 `soundEffects` 保存音效路径、指纹、帧窗口与音量。文字使用本地字体；实际图片、图形与音效进入渲染报告。

效率设置以 `scripts/history-motion/render.mjs` 为准：当前不透明 composition 使用 JPEG、quality 92 的中间帧，OffthreadVideo 缓存为 512 MiB，单帧超时为 90 秒，并显式设置 `colorSpace:'bt709'`，减少中间图像编码和磁盘负担；1080p、30fps、H.264/AAC 的交付标准不变。本流程不要求保留全片 PNG 中间序列，回看用的少量 PNG 代表帧仍保留。单帧超时与视觉抽检的 90 秒任务预算是两个独立设置。

## 地图合同

通用地图层只接受本地、已核实且有来源记录的底图。没有自动默认为任意稿件添加长平地图。地图数据准备遵循独立 skill，缓存文件与叙事按项目留存。

地图由 `history-motion-maps.ts` 提供。保留 `changping-context`；新地区通过 `prepareMotionMap()` 和 `scripts/history-motion/map-data.mjs` 自动准备：复用本地 Natural Earth 地点与河流，缺少地点时有限查询 Wikidata P625，缓存 Terrarium 地形，按同一投影生成城市与示意路线。模型只给地名和路线语义，不给坐标；无法定位、地形下载超时或数据不可靠时自动回退其他画面。默认网络总预算25秒、最多16片新地形瓦片，失败缓存避免逐镜重复请求。现代地理不自动证明古城址，直连路线明确为示意，不自动猜测历史国界。

`HistoryMotionFactory` 的地图输入包括：

```text
enabled: true
backgroundSrc: 本地底图绝对路径
width / height: 底图原始尺寸
provenance:
  verified: true
  source / license / projection / attribution: 实际来源与许可说明
  historyStatus: illustrative 或 sourced
cities: 名称与归一化 x/y
routes: 归一化点列、颜色、镜头内 start/end 秒
territories: 名称、颜色、归一化 points；变化时提供等顶点数 initialPoints、from/to 秒
```

`verified: true` 表示数据准备者已完成核对，不是程序自动证明历史真实性。归一化坐标必须从记录的经纬度和投影生成。地图层保持底图比例，竖屏留边；纯透明度变化不代表领土推进，控制区变化使用 `initialPoints → points` 的边界插值。

长平示例的现代 DEM、河流、城市提供地理背景，控制区和路线是示意；约前260年的历史总览图单独署名。免费现代国界不能换标签当成古代国界。详细来源和长平固定脚本限制见 [地图数据复用说明](../.codex/skills/history-map-animation/references/data-and-reuse.md)。

## 交付文件与检查范围

输出 `movie.mp4` 时，渲染器同时生成：

- `movie.mp4.json`：交付 sidecar。
- `movie-preview.mp4`、`movie-review.html`：精选预览与回看页。
- `movie.mp4.render/`：冻结计划、props、资产、delivery JSON 与代表帧。

技术通过后即可自动交付，`qa.visual/listening=not-reviewed`、`humanReviewRequired=false`。完整视频存在不等于审美通过；需要回看时在产出后检查动画、文字、地图及声音，不阻塞任务完成。

自动视觉抽检默认每任务 90 秒处理预算（`HISTORY_MOTION_REVIEW_BUDGET_MS`），每个新素材最多两帧；这是处理预算，不是已观看 90 秒视频。预算耗尽后标记剩余素材未核验；有限采样不能证明人物身份、历史事件、地点、年代、连续性或地图历史结论。记录必须区分抽帧、连续播放和听审；未执行的检查保持未核验。

## 维护位置

| 文件 | 责任 |
| --- | --- |
| `backend/src/routes/history-motion.ts` | HTTP 接口、稿件版本检查、任务和媒体访问 |
| `backend/src/services/history-motion-production.ts` | 素材检索、路径/选择校验和任务快照 |
| `backend/src/services/history-motion-pipeline.ts` | 导演设计、受限选材、补充画面、配音、时间对齐与渲染调度 |
| `backend/src/services/history-motion-maps.ts` | 当前可供自动制作选择的本地地图包 |
| `backend/src/services/history-motion-assets.ts` | 媒体读取、生图缓存与有时限进程、本地音效选择及归一化 |
| `backend/scripts/history-motion-image.ts` | 复用现有生图服务与原生成记录，输出本地图片 |
| `scripts/history-motion/map-data.mjs` | 通用地形、地点坐标、河流与路线数据准备 |
| `backend/src/services/history-motion-delivery.ts` | 成片路径与指纹复核、安全关联现有交付 |
| `remotion/src/HistoryMotionFactory.tsx` | 视频、地图、字幕和字体动画 |
| `remotion/src/history-motion-factory-entry.tsx` | 独立 Remotion composition |
| `scripts/history-motion/render.mjs` | 素材冻结、渲染、技术核验和回看产物 |

任务状态和服务配置以当前后端实现为准；不要通过手改任务状态伪造完成，也不要改候选快照绕过素材验证。

## 本地样片与验证记录

### v2 真实作品已完成技术交付

source 62 / Episode 1062 的[完整新成片](http://localhost:3013/static/remotion/history-302df8bb-f6b0-4929-9500-713def0241fd-61d2c8de15c8.mp4)及[带声精选](http://localhost:3013/static/remotion/history-302df8bb-f6b0-4929-9500-713def0241fd-61d2c8de15c8-preview.mp4)已交付；[最终验证记录](../data/temp/history-factory-validation-20261026/v2-verification.json)记录正文逐字一致、配音复用、53 个实际源文件 SHA-256 互异，包含 25 个视频、27 张图片、1 幅地图、9 处解释叠层及 0 个独立 graphic。成片为 1920×1080、30fps、H.264/AAC，7911 帧、263.744 秒、61,153,035 字节；全片 FFmpeg 解码退出码为 0，旧成片及原来源交付仍保留。

本轮前两次整片尝试因主动停止 PNG 方案、浏览器崩溃后超时而未完成。第三次已生成全部帧但未通过色彩校验，随后复用该整片转为 BT.709 有限范围、保留全部帧并直接复制 AAC 音轨，最终通过交付；渲染器新增的 BT.709 设置已通过真实 JPEG 输出回归测试。此前旧片没有替代本次新输出。

视觉检查范围为 25 个源视频取用段首/中/末帧、全部 27 张图片、21.7 秒代表片段的 6 个输出帧，以及最终片第 1–24 镜的 24 个中点帧（3.40–115.30 秒，[联系图](../data/temp/history-factory-validation-20261026/review/v2/final/)）。所查 24 个成片采样没有重大遮挡、重复画面、纯色独立卡片或需阻断交付的明显错配；第 15 镜保留的原“庐山”字样与新标题未重叠，第 17 镜明确只作位置示意。未连续观看并听审整片，未独立核验历史身份或历史结论，技术通过与抽帧结果不代表这些项完成。

### 此前技术样片记录

2026-10-26 自动组合验收：`/static/history-motion-production-validation-20261026-final/b5d73c16-f6d7-40a9-bb4f-4b18c01ce384/render-1792996803666/movie.mp4`。14.016 秒、1920×1080、30fps、H.264/AAC，实际组合首候选视频、开封真实地理底图、当前图片服务生成的洪水场景、对比信息动效和两处本地音效。输出 `completed`、技术检查通过、无替代失败记录，HTTP Range 返回206；已查看四镜画面，未做完整听审。

样片由 `backend/scripts/history-motion-validation.ts` 在独立任务数据库中运行，复用 #119 中与样片文字完全一致的句级配音片段，不修改业务稿件的成片关联。验收时 MiniMax 新配音请求因账户 Token Plan 额度用尽失败；没有购买额度或切换供应商。生产任务遇到同样错误会明确失败，保留已有分镜以便额度恢复后重试；已有匹配配音继续复用。

本轮53项后端测试、14项前端测试、后端类型检查通过；渲染器15项回归及横竖版实际渲染测试通过。样片报告保存在同目录的 `validation-result.json`。本地入口已重载新版后端，测试、图片子进程和渲染进程均已结束。

初版组合样片：`/static/history-motion-sample-20261024/movie-review.html`。
恢复渲染样片：`/static/history-motion-recovery-20261025/movie-review.html`。
恢复样片使用受限检索返回的本地镜头，复用已有真实 MiniMax 配音，实际执行 `createMotionRunner(...).schedule(id, true)` 输出 H.264/AAC、1920×1080、30fps、267 帧、8.917333 秒。`recovery-result.json` 记录模型/配音调用均为 0、配音 SHA-256 未变。样片来自隔离验收任务，未关联到生产库中无关稿件。

已检查时间采样画面及实际媒体参数，HTTP Range 返回 206；完整实时回放与听审尚未完成，报告保留待审状态。此样片展示本地素材、动态标题与长平位置地图；势力消长的完整案例见独立地图 skill，不能把位置地图描述为已呈现控制变化。
