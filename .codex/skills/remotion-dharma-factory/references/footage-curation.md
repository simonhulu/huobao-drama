# 素材获取与验收（Footage Curation）

佛学/哲学口播有两类画面职责：叙事插画必须证明旁白中的人物、关系、动作与心理处境；
氛围承接镜头才负责托住停顿、转场和空间呼吸。不能再用“抽象内容无法图解”作为空寺院、
佛像或山水替代人物关系的理由。

## 来源与授权

| Provider | 环境变量 | License | 说明 |
| --- | --- | --- | --- |
| Pexels | `PEXELS_API_KEY` | Pexels License（可商用免署名） | 风景/禅意素材最丰富 |
| Pixabay | `PIXABAY_API_KEY` | Pixabay Content License | 备选，自然类多 |
| Coverr | `COVERR_API_KEY` | Coverr License | 备选 |

Key 从 `backend/.env` / `backend/.env.local` 自动加载（shell 显式变量优先）。
`stock_videos.mjs` 只选横屏、≥720px、最接近 16:9 的源文件。

**授权证据是硬要求**：每次检索落一份 manifest 到
`data/static/remotion/stock/manifests/<topic>.json`，下载后 manifest 内含
`localPath / sha256 / bytes`。指派时把 `provider / videoId / sourceUrl /
licenseUrl / creator` 一并写进素材指派（footage 路由的 video 字段）。
没有 manifest 的素材不得进入生产。

## 检索词库（按情绪段）

用英文检索（三家库的中文标签覆盖差）。每个主题至少试 2 个 provider、2 组词。

| 情绪段 | 检索词 | 适用旁白 |
| --- | --- | --- |
| 悬念/钩子 | `misty mountains fog`, `dark clouds timelapse`, `lone figure walking fog`, `ocean waves dark` | 反常識開場、認知衝突 |
| 掙扎/困境 | `rain window`, `storm sea`, `wilted flower`, `candle flame dark room` | 故事衝突、絕望段落 |
| 寺院/修行 | `temple incense smoke`, `buddhist monk meditation`, `temple bell`, `zen garden` | 佛經故事、歷史人物困境 |
| 靜物/日常 | `tea cup steam`, `rain drops leaves`, `old book pages`, `wooden table morning light` | 概念翻譯、生活映射 |
| 竹林/山林 | `bamboo forest wind`, `forest sunlight rays`, `mountain stream water`, `moss rocks` | 頓悟、緩衝帶 |
| 開闊/升華 | `sunrise mountains`, `sea horizon calm`, `clouds above sky`, `star night sky timelapse` | 理論升華、認知顛覆 |
| 溫暖/祝福 | `morning light window`, `flower blooming timelapse`, `sunlight through trees`, `gentle waves beach` | 結尾願景、金句收尾 |

## 验收门禁（逐条过，不看 API 标签看实际画面）

1. **情绪匹配**：素材的气质就是这一段旁白的气质。快节奏/强动感的素材
   （车流、人群、激烈运动）永远不合格——即使是免费的。
2. **无出戏元素**：无可读文字、水印、logo；无正对镜头说话的人物
   （打坐/冥想/背影可以）；无与话题冲突的现代物（文稿讲现代生活时放宽）。
3. **画面完整**：横屏、≥720p、主体在画面内（Remotion 以 cover 铺满，
   边缘构图的素材会被裁掉——preview 时注意 focusX/focusY 是否需要在指派里调整）。
4. **时长足够**：素材时长 ≥ 它要覆盖的段落时长。不够的三个选择：
   换更长的素材 / 接受慢放（下限 0.6x，禅意素材慢放通常更好看）/
   把段落拆成两段各配一条。**第四个选择"循环"不存在**。
5. **首段强开场**：第一段必须承担 `curiosity`，第 0 帧就有主体和运动。运动可以来自
   视频内部，也可以来自 AI 图立即开始的 push/drift；不要从全黑/全空渐入——2 秒留存门
   等不起。

## 静室角色门禁

`theme` 是给人看的备注，不是可执行的画面语义。每个指派还必须带一个受控
`role`：

| role | 允许的主画面 | 用途 |
| --- | --- | --- |
| `temple_interior` | 香案、经卷、木格窗、空坐垫、灯影、茶室 | 静室讲法的主骨架 |
| `ritual` | 香火、烛火、钟、合掌、诵经动作 | 经文、转折、金句前后的仪式感 |
| `temple_exterior` | 山门、庭院、檐下、寺院远景 | 进入或离开静室的空间呼吸 |
| `contemplative_nature` | 雾山、竹林、雨、水面、晨光 | 仅用于换气与收束 |
| `human_relationship` | 家庭、师徒、伴侣或亲子之间可读的距离、动作、视线和表情 | 只用于带 semantic 的叙事插画 |

路由和 props 构建共同执行以下门禁：

- `temple_interior`、`ritual`、`temple_exterior` 的真实 TTS 覆盖时长合计必须达到
  全片 60%；
- 相对首个旁白窗口的前 25 秒内，必须开始一个上述静室角色；
- 相邻同源视频属于一个视觉段落，角色必须相同。不能把同一段山景按分镜标成
  `ritual` 来凑覆盖率；
- 局部技术 preview 仍校验角色是否合法，但不以它的局部时长判断整集比例。条件 canary
  和正式整集始终先执行整集语义门禁。

这不是机器视觉替代审片。角色是可追溯的策展声明，条件 canary / 正式审核仍要看实际画面；现代公园、
西式马车或旅游人群即使被标成寺院角色，也应在人工审查时淘汰。

## 跨剧集复用、单剧集唯一

新检索之前先查本地：

```bash
ls data/static/remotion/stock/          # 已下载的 stock（查 manifests/ 里的元数据）
```

```text
GET /api/v1/grid/videos/assets          # AI 生成的可复用资产（历史管线攒的，氛围合适的可用）
```

本地命中且情绪/画质合格的直接用，把 provenance 照常写进指派。

**同一剧集内，一条本地源文件只能占一个连续分镜范围。** 相邻分镜共用同一条视频
是一个自然合并的视觉段落；一旦切到另一条素材，前一条素材就不能在后面回来。
`grade`、`focusX/focusY`、`sourceStartSec` 和文件别名都不构成新素材。路由和 props
构建都会硬拒绝 `A -> B -> A`，条件 canary 也不能绕过整集校验。

`static/remotion/stock/proxy/` 和 `remotion/public/dharma-assets/` 是交付代理/Remotion
暂存层，不是创作素材库。指派只能引用原始 manifest 文件；代理由 props 构建按需要自动生成。

这不禁止**跨剧集**复用。先查本地库仍是对的；只是本集需要为每个视觉段落准备独立源。
长片应据真实 TTS 时长规划素材预算：678 秒、每段最多 30 秒至少需要 23 条独立素材，
不要拿 7 条素材反复铺满整集。

## AI 关键镜头与动态视频的 hybrid 配比

抽象内容不能靠无关 stock 图解，但可以通过具体人物处境被看见。先把旁白翻译为视觉命题，
再决定是叙事插画还是氛围承接：

- AI 静态图覆盖全片真实 TTS 时长的 35–65%。每张叙事插画持久化人物数量、人物身份、关系、
  动作、可见情绪和验收证据；语义不变时可覆盖连续分镜，任一字段变化就必须换图。
- 动态视频覆盖至少 10%，放在钩子运动、情绪转折、空间进入/离开与长段换气处。视频不是
  默认填充物，也不能用 30 多条无关 stock 平均轮播整集。
- `curiosity/tension` 使用超现实梦境，`stillness/acceptance/release` 使用水墨意境，
  `insight` 必须使用极简光影 AI 图并 `hold`，给中央金句真正的停顿。
- 同一来源文件只属于一个连续段落；AI 图与 stock 一视同仁，禁止 `A -> B -> A`。

生产时先一次性写完全部 semantic 和 prompt 并人工审查，再按图片 worker 的已验证并发上限批量提交，
不要“生成一张、等待、再规划下一张”串行试错。失败只重做对应关键图；风格 snapshot、emotion、
role、move、shot_function、semantic 随任务固化，剧集默认风格后续变化不能污染已排队任务。

连续人物镜的第一张接触表通过后，后续镜头把紧邻上一张作为 `reference_images` 传入，同时继续在
prompt 锁定年龄、性别、发型、服装和关系槽位。参考图只能来自同一 Episode 已指派图片，最多 3 张；
通常 1 张最稳定。参考图是连续性约束，不替代本镜头自己的 semantic 与 `visual_evidence` 审查。

审图先做接触表，不先渲视频。逐张问：画面里有几个人、他们是什么关系、在做什么、表情是什么、
`visual_evidence` 是否真的出现。任何一问答不出来，图片即失败；统一色调、佛像、香火和漂亮留白
都不能抵消语义缺失。

stock 静态图只在已有授权素材恰好满足情绪时使用；它不能计入“AI 关键图覆盖”。所有来源仍只
渲染本地文件，stock 保留授权证据，AI 图保留生成任务 ID 以便 preflight 审计。

## 静室讲法的素材配比

画面不是泛自然风景轮播。每集至少安排寺院/静室相关的独立段落：香火、经卷、木格窗、
空坐垫、灯影、茶、庭院、钟或山门；山水、竹林、雨、水面用于换气与收束。审片时看到
现代公园、人车、正对镜头的游客或没有语境的重复云海，直接淘汰。中心金句层是品牌语言，
底层素材仍必须独立且与“静室听法”相容。
