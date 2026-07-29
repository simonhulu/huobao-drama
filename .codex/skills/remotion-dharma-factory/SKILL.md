---
name: remotion-dharma-factory
description: "Create and render Buddhist/philosophy narration videos through a semantic-illustration Dharma Episode Pipeline: authoritative TTS timing, narration-evidence AI illustrations, restrained atmosphere bridges, lightweight Ken Burns, sacred quote composition, and loudness-aware BGM mixed in Remotion."
---

# Remotion Dharma Factory

用这个 skill 把 **dharma-video-script 产出的佛学/哲学口播稿**渲染成成片。
本 skill 只有一条生产路径：**Dharma Episode Pipeline**（`DharmaEpisode` 合成 +
`dharma.episode_render` 任务）。不要使用 grid（历史叙事）管线的任何阶段——
两条管线共用剧集/TTS/任务系统底座，但视觉层完全不同。

工厂拥有生产。Web 页面（`/dharma`）是状态与审查面，不在页面上触发下载或渲染之外的
破坏性操作。所有持久状态在下游开工前落库；所有长任务走共享任务队列，路由返回
`{ task_id }`，前台轮询直到门禁通过或失败。

## ⚠️ 前置必读

**在任何生产操作之前，先读 [lessons-learned.md](references/lessons-learned.md)。**
其中包含了从历史工厂继承的硬教训（时序契约、单位陷阱、BGM 门禁）和本管线特有的
规则（Remotion 内视频 muted 是设计而非 bug、素材绝不硬循环）。

## 与 remotion-history-factory 的根本差异

| 维度 | 历史工厂（grid v8） | 本工厂（dharma） |
| --- | --- | --- |
| 画面职能 | 叙事证据：每分镜一张制作图，必须直接证明旁白 | **双职能**：语义段用叙事插画证明人物/关系/动作；停顿和转场才用氛围承接镜头 |
| 视觉单元 | Render Shot（一镜一图，≤8s） | **视觉段落**：相邻同素材分镜合并，8–30s 一段 |
| 图片 | 每 Panel 一张 16:9 生成图（付费） | **叙事插画镜头**：按语义 beat 生成，人物、关系、动作和可见证据必须与旁白一致；不按 storyboard 机械平均 |
| 视频 | 受限例外（开场 + 个别 kinetic 镜头，≤10s） | **动态衔接**：至少覆盖 10%，只承担运动、空间进入/离开与呼吸 |
| 叙事层级 | Sequence→Event→Beat→Panel 导入是硬门禁 | **不需要**：分镜旁白直接在 TTS 主时间轴上定位 |
| 连续性设计 | grid.episode_design（相机轨道+锚点） | **轻量需要**：连续出现的核心人物要保持年龄、服饰和关系锚点；不引入 grid 的完整历史叙事系统 |
| 转场 | cut 为主，克制叠化 | 氛围段 **慢叠化**（24f）；人物叙事插画用短 `dip-to-ink`，全片无裸硬切 |
| 文字层 | 镜头标题 + InfoGraphic（bignum/trend/card） | **金句卡**（居中衬线卡）是唯一强调层；无镜头标题 |
| BGM | 多幕 cue + SFX + ffmpeg 侧链混音 | **单首长音床**，实测响度定标 + 旁白闪避 + 交叉循环，Remotion 内混，无后混 |
| SFX | 事件音效计划 | **无**（允许素材自带环境声？不——视频一律 muted） |
| 核查员 | scripture 无关；历史事实核查 | 经文核查在 dharma-video-script 阶段已完成，本工厂不重复 |

## Glossary（硬门禁术语）

- **净稿**：dharma-video-script 的最终产物 `scripts/<article-id>.md`（配 `scripts/dharma-notes/<article-id>/` 证据目录）。本工厂的输入。
- **TTS 主时间轴**：`tts.pre_generate` 写入 `episodes.pre_tts_titles_json` 的
  `[{ text, time_begin, time_end }]`（毫秒）。全片唯一的时序真源。
- **视觉段落（Segment）**：连续使用同一素材、同一情绪、同一风格和同一运镜的相邻
  分镜合并成的播放单元。素材或创作元数据变化 = 段落边界。由同一个生成任务写回的
  连续 AI 图必须合并成一次完整 Ken Burns 运动。
- **视觉命题（Visual proposition）**：一段旁白要求观众从画面直接读出的事实，例如
  “他与家人有情感距离，但不是敌意”。没有视觉命题，不允许写生图 prompt。
- **镜头职能（shot_function）**：`narrative_illustration`（叙事插画）或
  `atmosphere_bridge`（氛围承接）。包含人物、关系、行为、故事或心理因果的旁白必须选前者；
  只有停顿、空间进入/离开和纯情绪换气才能选后者。
- **语义计划（semantic）**：叙事插画必须持久化
  `subject_count / subjects / relationship / action / visible_emotion / visual_evidence`。
  `visual_evidence` 是验收真源：接触表里看不到它，图片就失败，不能以“氛围相近”放行。
- **素材指派（Footage assignment）**：持久化在 `storyboards.grid_cells` 的
  `{ dharma: 1, role, emotion, styleId, theme?, video?|image?, quote? }`。
- **视觉角色（role）**：每个素材指派必须声明一个受控空间角色：
  `temple_interior`、`ritual`、`temple_exterior`、`contemplative_nature` 或
  `human_relationship`。前
  三者属于静室讲法的主空间；自然只能承担换气，不能代替寺院语境。
  `human_relationship` 只允许 `narrative_illustration`，且人物互动必须是画面主体。
- **情绪角色（emotion）**：每段必须是 `curiosity / stillness / tension / acceptance /
  insight / release` 之一；全片必须按该顺序完成情绪弧线。
- **情绪风格（styleId）**：新生产只允许 `dharma-emotional-ink-v1`（水墨意境）、
  `dharma-surreal-dream-v1`（超现实梦境）、`dharma-minimal-light-v1`（极简光影）。
- **金句（Quote）**：`quote: { text, source? }`，锚定在该分镜 TTS 中真正说出该短语的位置，
  居中象牙衬线大字 + 金色细线 + 小出处；不是圆角弹窗。出现时压掉同句字幕。
- **前台监控**：每 5–10s 轮询 `GET /api/v1/tasks/:task_id`，记录每次状态迁移，
  当前任务未到终态（succeeded/failed/canceled）不启动同剧集的下一阶段。

## Authoritative Timing Contract（时序契约，与 v8 同源）

```text
preTtsAudioUrl + preTtsTitlesJson（毫秒）
  -> 每个分镜旁白在主时间轴上顺序定位（locateNarrationWindow）
  -> 分镜绝对帧窗（startMs/endMs -> 帧，±1 帧取整容差）
  -> 视觉段落帧窗（相邻同素材分镜合并后的并集）
  -> 金句卡帧窗（quote 短语在 TTS 字符流中的真实位置 + 克制前后停顿）
  -> 全局分句字幕（字符区间在主时间轴插值，绝对秒）
```

- **严禁按字数比例估算任何时序**——不是兜底，不是"临时"。历史工厂实测：字数估算
  导致画面/字幕平均落后旁白 2.7s、峰值 8s。分镜旁白定位失败 = 数据不同源，
  修数据（重新导入文稿或重跑 `tts.pre_generate`），不许在渲染层 paper over。
- 段落/金句/字幕全部按**绝对帧位**挂载（相对渲染 0 帧 = 首个分镜起点），
  主音轨用 `startFrom = audioStartFrame` 同步裁剪，不做累计堆叠。
- `storyboards.duration` 只是拆分阶段的估计值，渲染时序不用它。

**渲染后同步校验（每次 props 构建后必跑，独立重推导）：**

```bash
node scripts/videoeditor/check_dharma_sync.mjs <episodeId>
# canary 片段渲染追加 --allow-partial
```

exit≠0 的 props 是在契约外构建的——拒绝交付，回到数据层修复。

## Creative Workflow

按顺序执行。返工回到最早失败的步骤，不要在下游打补丁。

### 1. 确立剧集（Intake）

输入是 dharma-video-script 的净稿（确认其 production-run.json 的 editorial
评审已通过——文稿质量不在本工厂修复）。

1. `POST /api/v1/dramas`：佛学内容单独建剧，`genre: 'dharma'`，显式
   `media_account_id`（没有佛学账号就先在 `/settings` 建一个）。
2. `POST /api/v1/dramas/:id/import-script`：`script_content` = 净稿全文，
   `title` = 视频标题，`clean: false`（净稿已定型，禁止 AI 再洗）。
   音色默认即可——当前激活 audio config 是本地 qwen3-tts，自动落到
   `qwen3-north-tense-narrator`（"深夜讲述者"，与佛学人设匹配）。
   显式指定就传 `narration_voice_id: 'qwen3-north-tense-narrator'`。
3. 该链路自动调度 extract → `tts.pre_generate` → storyboard breaker →
   分镜按真实 TTS 时间戳修正时长并拆分到 ≤8s。**前台轮询直到 breaker 完成**。

**硬门禁：**

```sql
SELECT pre_tts_audio_url, pre_tts_titles_json FROM episodes WHERE id = ?;  -- 均非空
SELECT COUNT(*) FROM storyboards WHERE episode_id = ?;                     -- > 0
```

### 2. 校验 TTS 主音轨

```bash
node -e "
const fs=require('fs');
const titles=JSON.parse(fs.readFileSync(process.env.TITLES_JSON,'utf8'));
console.log('covered sec:', (titles.at(-1).time_end - titles[0].time_begin)/1000);
"
ffprobe -v error -show_entries format=duration -of csv=p=0 <master_audio_path>
# covered / duration 必须在 0.60–1.05（渲染任务也会强制这道闸）
```

### 3. 语义分镜规划（先成案，再提交）

通读全稿分镜旁白，规划视觉段落。这是本工厂最核心的创意决策：

- **先写视觉命题**：逐段回答“旁白在说谁、谁与谁是什么关系、正在做什么、观众必须看到
  什么才算理解”。抽象概念先翻译为人物处境或可见动作；确实没有人物/事件时才标为
  `atmosphere_bridge`。禁止从风格词、寺院词或素材库反推内容。
- **段落划分**：叙事插画通常覆盖一个 5–15s 语义 beat；氛围承接镜头通常 8–20s，边界落在
  语义换气处（故事切换、概念翻译、
  情绪缓冲带）。相邻分镜用同一条素材就自动合并——规划的单位是"这条素材覆盖
  哪几段旁白"。**每条本地源文件在同一剧集只能占一个连续段落；切走后绝不回来。**
  先按 TTS 总时长计算需要的独立素材数，不够先补库，不许靠复用凑时长。
- **先画情绪弧线，再找素材**：全片必须按
  `curiosity -> stillness -> tension -> acceptance -> insight -> release` 前进，不能把
  相邻 stock 按文件名平均铺开。每个 milestone 至少有一个视觉段落，允许同一情绪连续多段，
  但不能逆序回跳。
- **三风格确定映射**：`curiosity/tension` = 超现实梦境；
  `stillness/acceptance/release` = 水墨意境；`insight` = 极简光影。完整六节点弧线必须实际使用
  这三种风格且不引入第四种；开场必须 `curiosity + 超现实梦境`，结尾必须 `release + 水墨意境`。
- **AI 叙事插画预算**：由语义 beat 数决定，不以固定张数凑配比。按 TTS 总时长缩放最低关键
  段落数；8 分钟及以上通常为 14–20 个，短片按比例缩放但不少于 3–4 个，最终以 preflight
  返回的 `generated_image_segment_budget` 为下限。AI 图
  覆盖全片真实 TTS 时长 35–65%，单张最多覆盖全片 25% 且单段不超过 30 秒。先一次性写完并
  审查全部语义计划和 prompt，再按已验证的 image worker 并发上限批量提交；不允许“生成一张、
  等待、再想下一张”的串行试错。
- **动态视频预算**：视频覆盖至少 10%，用于钩子运动、转折、空间进入/离开和长段换气。
  它不是默认填充层；全片纯 AI 图和全片 stock 轮播都不合格。
- **第一镜必须立即运动**（2s/5s 留存门）：第 0 帧有主体，并从第 0 帧开始视频内部运动
  或 AI 图 push/drift。首镜不再限定必须是视频。
- **第一镜语义门禁**：钩子提到“一个人/两个人/亲情关系/冷漠或孤独”时，第一镜必须直接出现
  对应人物与关系距离。空寺院、佛像、香火、云雾、山水和抽象物件都不能替代。
- **金句规划**：只给真正的情绪核爆点和收尾金句配中央大字（一篇 8–12 分钟的稿子
  通常 3–6 张）。金句是稀缺资源，句句都配等于没有。经文原句必须带 `source`
  （如 `《金刚经》`），个人转述不带。文案以 ≤24 字为宜，**36 字是路由和 props 的硬上限**；
  超出时先拆为一句核心教义，不能靠缩小字号硬塞。有明确出处的经文首次揭示可保持当前情绪
  风格，但必须是可信 AI 图 + `hold`；普通金句仍只允许在 `insight + 极简光影 + hold` 出现。
- **顿悟段硬规则**：`insight` 必须是极简光影 AI 图、`hold` 运镜，并承载金句停顿；
  普通 stock 静态图、视频或移动中的画面都不能替代。
- **氛围配比**：寺院/静室（香火、经卷、木格窗、坐垫、灯影、茶、庭院）是主骨架；
  山水/竹林/雨/水面仅作换气。目标是信徒在安静寺院房间里听法，不是泛自然素材轮播。
- **角色预算**：按 TTS 真实时长计算，`temple_interior`、`ritual`、
  `temple_exterior` 三类合计至少覆盖全片 60%；第一个 60 秒内、相对首个旁白窗口
  25 秒前必须进入其中一类。相邻同一源文件是同一视觉段落，角色必须一致，不能用
  同一条自然素材在不同分镜伪装成不同空间。
- **人物一致性**：同一位父母/子女/讲法者跨连续镜头出现时，prompt 固定年龄段、发型、服装
  主色和一个辨识锚点；从第二张连续人物镜开始，把上一张已通过接触表且已指派的图片作为
  `reference_images` 传入，不能只靠文字 prompt 碰运气。只在人物不再回场时允许重新设计。
- **文字职责**：画面本身不生成可读中文。字幕负责逐句信息；中央金句只在真正的停顿时出现，
  不能用文字层补救语义空洞的底图。
- 读 [footage-curation.md](references/footage-curation.md) 的检索词库与验收门禁，
  读 [visual-grammar.md](references/visual-grammar.md) 的画面语法。

### 4. 素材获取（emotion-directed hybrid，episode-unique）

按职责分两条 lane 并行准备，不按“哪个库里先找到就用哪个”决定画面：

```text
叙事插画 lane：视觉命题 -> semantic 六字段 -> prompts 一次冻结 -> 批量并发 AI 生图 -> 接触表语义审图
动态衔接 lane：本地 stock/manifests -> 本地视频资产 -> 新检索下载 -> 人工审片
```

AI 图请求走 `POST /api/v1/dharma/episode/:id/footage/generate`，每个请求覆盖一个连续
视觉段落并显式携带 `role / emotion / style_id / move / shot_function / semantic`。先把全片
视觉命题和 prompts 固定下来，再以
图片 worker 的生产并发（默认不超过 4，未经基准不要提高）批量提交；只重做失败或审图不合格
的段落。不要把等待单张图片的网络时间串成多个顺序阶段。

动态视频仍先查本地以节省下载时间：

```bash
node scripts/videoeditor/stock_videos.mjs search --provider pexels \
  --query "misty mountains fog" --limit 8 --min-duration 10 \
  --target-width 1280 --target-height 720 \
  --output data/static/remotion/stock/manifests/<topic>.json
node scripts/videoeditor/stock_videos.mjs download \
  --manifest data/static/remotion/stock/manifests/<topic>.json --concurrency 4
```

铁律：

- **只渲染本地文件**；manifest 必须保留（provider/sourceUrl/licenseUrl/creator/
  sha256），它是授权证据。
- **每个本地素材源只能覆盖一个连续段落**；切走后绝不回用。AI 静态图也按源文件
  计数，不得跨非连续段复用。
- **AI 图不是逐镜图**：同一生成任务写回一个连续段落，Remotion 只运行一次完整 Ken Burns；
  不要对每个 3–8 秒 storyboard 单独生成和重启动运镜。
- **但语义变化必须换图**：人物、关系、动作或 `visual_evidence` 任一变化就是新叙事插画段落，
  即使情绪/风格相同也不能复用上一张图。Demo 中**实际落入 TTS 预览窗口**的每个语义 beat
  必须使用独立图片；仅被 `onlyStoryboardIds` 选中、但位于精确裁切点之后的 beat 不计入成片段落数。
- **只做低成本 treatment**：`ink_wash / surreal_dream / minimal_light` 使用 transform、
  opacity 和静态 CSS overlay；禁止逐帧 blur、Canvas 粒子或高成本 shader。
- **素材时长 ≥ 段落时长**。不足时渲染层只允许慢放到 0.6x 下限，再短直接换素材
  或拆段——**绝不硬循环**（循环断点在慢节奏画面里极其刺眼，props 构建会硬失败）。
- **审查实际画面**，不是只看 API 标签：无可读文字/水印/logo、无正对镜头的人物
  （打坐/冥想语境除外）、无出戏的现代元素（除非文稿话题就是现代生活）。
- 细节见 [footage-curation.md](references/footage-curation.md)。

### 4.1 快速验证样片（新方案或风格变更时）

只取开头连续 60 秒，先冻结 5–8 个语义 beat，再完成以下一次性链路：

```text
TTS 时间窗 -> semantic 六字段 -> 全部 prompts -> 异步并发生图
-> 接触表逐图核对 visual_evidence -> 一次 60 秒 preview -> 独立帧审查
```

- 接触表失败只重做不合格图片；没有通过接触表，不启动 Remotion。
- 接触表发现“生成结果证明了另一个同样忠于当前旁白的视觉命题”时，允许在渲染前做一次
  **证据校正**：把 semantic 改成肉眼实际可见的人数、关系、动作和证据，再重新审查。仅当
  新命题仍直接证明同一段旁白时可用；离题、空泛、靠旁白脑补或把角色连续镜降级成无关单图的
  结果必须重生。严禁保留画面没有证明的“已松开、空坐垫、同一人物”等声明。
- 同一版素材只允许一次 60 秒 preview；不得用连续 pilot 渲染做创意探索。
- 请求选择的 storyboard 数不等于实际渲染段落数。验收以 props/result 的 `segment_count`、实际
  TTS 裁切窗口和成片接触表为准，不能用请求数组长度宣称“成片使用了几张图”。
- 60 秒上限落在长 storyboard 中间时，props 必须保留该镜到上限前最后一个完整 TTS title，
  然后只留约 1–2 秒视觉/BGM 尾奏；禁止把整个跨界 storyboard 丢掉，制造几十秒无旁白尾巴。
- 精确 60 秒且显式携带连续 `onlyStoryboardIds` 的语义 Demo 使用 `semantic_preview` 门禁：仍校验
  TTS、BGM、素材文件、任务归属、人物 semantic、金句和时序，但不要求尚未重做的后半集旧素材先
  通过整集三风格/hybrid 配比。该模式不得用于 canary、任意时长片段或正式整集。
- 语义方案验证 Demo 可以暂时全用独立 AI 插画，以隔离验证“画面是否服务口播”；它只验语义、
  构图、运镜、金句和声音，不得据此宣称整集 hybrid 已通过。扩展整集时仍恢复动态视频 ≥10% 门禁。
- Demo 通过后才扩展整集。Demo 不通过时，保留已合格图片并修最早失败环节，不推翻 TTS、
  已冻结语义计划或其他无关资产。
- **当前 720p / AI 静帧 Demo 的观测基线**：素材通过接触表后，`props_build` 目标 ≤2 分钟、
  `remotion_render` 目标 ≤4 分钟、任务总时长目标 ≤8 分钟。这是性能告警线，不是降低质量的理由；
  超线先读 task events 的阶段账单，定位响度扫描、代理、帧渲染或编码，不得直接重复提交同一输入。

接触表通过后只提交一次预览；它写 task 专属 preview 文件，不更新 `episodes.video_url`：

```bash
curl -sS -H 'Content-Type: application/json' \
  --data '{"onlyStoryboardIds":[<连续的5-8个storyboardId>],"maxDurationSec":60}' \
  http://127.0.0.1:5679/api/v1/dharma/episode/<episodeId>/render
```

预览仍必须轮询到终态并运行 `check_dharma_sync.mjs <episodeId> --allow-partial`；若失败，先修
数据、素材或渲染契约，不得在未改变已知失败输入的情况下重复排队。

预览还必须做机器初筛和逐边界人工验收：

```bash
ffmpeg -hide_banner -nostats -i <preview.mp4> \
  -vf "blackdetect=d=0.12:pix_th=0.06" -an -f null - 2>&1
```

- `blackdetect` 只负责标出候选时间，不自动替代审片。非计划黑场、全黑闪烁或持续黑暗一律 FAIL；
  人物 `dip-to-ink` 允许短暂变暗，但中心仍应保留墨色/残余细节和边框，不能成为突兀全黑帧。
- 抽查每个素材边界的前 0.3 秒、边界帧和后 0.3 秒；人物镜不得出现两套面孔重叠，新画面必须
  从墨色干净升起。接触表通过但转场失败时只修渲染转场，不重生已经通过的图片。

### 5. 素材指派（落库）

```text
POST /api/v1/dharma/episode/:id/footage
{ "assignments": [
  { "storyboardId": 101, "theme": "山间迷雾",
    "role": "contemplative_nature",
    "emotion": "curiosity",
    "style_id": "dharma-surreal-dream-v1",
    "video": { "src": "static/remotion/stock/pexels-26893760.mp4",
               "provider": "pexels", "videoId": "26893760",
               "sourceUrl": "...", "licenseUrl": "...", "creator": "...",
               "durationSec": 20.5, "sourceStartSec": 2, "grade": "zen_muted" } },
  { "storyboardId": 108, "theme": "金句",
    "role": "temple_interior",
    "emotion": "insight",
    "style_id": "dharma-minimal-light-v1",
    "image": { "src": "static/images/<generated-output>.png", "move": "hold" },
    "quote": { "text": "应无所住而生其心", "source": "《金刚经》" } }
] }
```

人物叙事插画请求示例：

```json
{
  "storyboard_ids": [101],
  "kind": "image",
  "model": "gpt-image-2-1k",
  "reference_images": ["static/images/<previous-approved-shot>.png"],
  "prompt": "一位成年子女站在冷色前景，家人在远处暖光中交谈，克制电影构图",
  "role": "human_relationship",
  "emotion": "curiosity",
  "style_id": "dharma-surreal-dream-v1",
  "move": "push",
  "shot_function": "narrative_illustration",
  "semantic": {
    "subject_count": 4,
    "subjects": "一位成年子女与身后三位家人",
    "relationship": "彼此关心，但前景人物不被家人的情绪控制",
    "action": "前景人物安静站立，家人在远处围桌交谈",
    "visible_emotion": "克制、疏离但没有敌意",
    "visual_evidence": "冷色孤立前景与暖色家庭背景同时可见，空间距离明确表达边界"
  }
}
```

`reference_images` 只用于连续人物镜，最多 3 张，且必须已经指派在同一 Episode 并通过接触表。
第一张人物镜不传；后续镜头优先只传紧邻的上一张，避免多张参考图互相污染角色槽位。参考图进入
任务 fingerprint，pcore 仍走 `async: true` 的 generations + poll 链路。

上例的 insight 图片路径只能来自该剧集成功的 `dharma.footage_generate` 任务。实际操作顺序是：
先用 `kind: image + insight + dharma-minimal-light-v1 + hold` 提交连续段落生成任务；任务成功并自动
写回 `generatedSegmentTaskId` 后，再用 `POST footage` 给该段落内一个明确的 storyboard 锚点添加
`quote`。不要手填任意 `static/images/...` 路径伪造 AI 关键图，也不要把同一句金句写到段落的每个
storyboard 上。

`model` 可选，但只能从 Episode 当前绑定生成配置的模型白名单中选择。pcore 仍固定使用
`async: true` 提交并轮询同一资源；`gpt-image-2-1k` 的 16:9 请求使用 `1280x720`，适合 720p
Remotion 成片。不得通过改成同步请求来规避队列或超时。

- 每个分镜必须且只能有 `video` 或 `image` 之一；路由校验文件存在才落库。
- 每个分镜必须有 `role / emotion / style_id`；旧的无情绪元数据指派不能绕过渲染门禁，
  需重新完成素材审查。
- `human_relationship` 必须是 `narrative_illustration`，且 semantic 六字段齐全；路由和 props
  构建都拒绝缺字段或用视频/空氛围冒充。
- 风格必须与情绪确定映射；图片运镜支持 `push / pull / hold / drift_left / drift_right`。
- 相邻分镜指派同一 `video.src` 即声明合并为一个段落——**段落结构由指派表达**。
- `video.src` 必须是 manifest 可追溯的**原始** stock 文件；`static/remotion/stock/proxy/`
  和 `dharma-assets/` 都是渲染缓存，不能作为素材指派来源。
- `quote` 挂在携带金句的分镜上；未提供时保留旧值，显式 `null` 移除。
- **硬门禁**：`GET /api/v1/dharma/episode/:id/footage` 的
  `assigned_count == total`，且每个 `file_exists == true`。

### 6. 选 BGM（渲染前强制）

一首经过试听的长音床覆盖全片。从 `data/static/music/freepacks/` 或 `/library` 音乐库选曲，然后：

```text
PUT /api/v1/episodes/:id  { "bgm_audio_url": "static/music/<auditioned-long-bed>.mp3" }
```

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 backend/data/<bgm_path>
# 必须 ≥ 180s（渲染任务硬门禁）
```

选曲标准与候选清单见 [bgm.md](references/bgm.md)。不要把 `FutureAmbient_2.wav` 这类
36 秒短 loop 用在长片；`Venus` 已在 Episode 734 因旋律存在感过强被否决，不能再作为默认候选。
混音由 props builder 用实测 LUFS 决定：无声间隙约低于旁白 14 LU，旁白窗口再闪避约 6 dB，
跨循环 4 秒淡变。不要手填固定音量。

### 7. 渲染（全片预检，按风险 canary，一次正式渲染）

```text
POST /api/v1/dharma/episode/:id/preflight
# 阅读 production_gate：全片精确 fingerprint、审查报告、是否要求 canary
POST /api/v1/dharma/episode/:id/canary                 # 仅 requirement = required 时
POST /api/v1/dharma/episode/:id/review/approve         # 带 fingerprint、审核人和结论
POST /api/v1/dharma/episode/:id/render  {}             # 只做一次正式渲染
```

- **预检不是缩样**：它编译全片 TTS、字幕、素材、BGM 与 renderer contract，生成精确的
  全片 fingerprint，在代理转码、loudnorm 或 Remotion 帧渲染前失败。
- canary 是风险附加检查，不是固定时长的硬门槛。已审核的 AI 图、正常 Ken Burns 和 24 字以内
  的短金句本身不触发 canary；只有非生成静态图运动、超过 24 字的金句/过长出处、异常慢放或
  过短的混合媒介转场等高风险输入，服务器才选择一个连续的 15–30 秒窗口。客户端不能指定窗口。
- 审批绑定精确 fingerprint。窗口外修改会使全片审批失效；窗口输入变化会使 canary 审核失效。
- canary 写不可变产物
  `static/remotion/dharma-ep<id>-canary-<seconds>s-task<taskId>.mp4`；整集写入
  `static/remotion/dharma-ep<id>-task<taskId>.mp4`。文件名绝不复用或覆盖旧交付；
  `episodes.video_url` 始终只指向正式成片。
- 旧 `dharmaPilot` 可读取和审批，用于历史剧集兼容；**新生产不得创建或依赖 pilot**。
- publish 先在同一事务中 claim 当前 worker 的提交权并核验 input revision/fingerprint，再原子
  rename task-private staging 文件，最后以 `running + lease_owner + commit_claimed_at` CAS 写入
  交付指针。任何一步失去 lease，旧 worker 只能留下不可见的 task 私有文件，不能替换成片。
- `dharma.episode_render` 是 `resumable: false, maxAttempts: 1`；中途失败从头重渲。
- **每次渲染后必跑**：`node scripts/videoeditor/check_dharma_sync.mjs <id>`
  （canary 加 `--allow-partial`）。
- macOS 上确认渲染日志有 `h264_videotoolbox` 编码器行（任务事件里有记录）。

**生产方案 / canary 人工审查清单：**

- 先看接触表：每张叙事插画的 `subject_count / relationship / action / visible_emotion /
  visual_evidence` 都能直接从画面读出；任何一项只能靠旁白脑补就退回重生；
- 开场 2s 有运动主体、5s 画面与钩子的情绪匹配；
- 氛围叠化流畅；人物叙事插画之间使用短 `dip-to-ink`，不得出现两组人脸重叠；无意外黑帧、无裸硬切；
- 字幕与旁白同步（抽查 3 处：开头/中段/结尾），无字叠字；
- 金句出现时机正确（旁白正在念这句话）、可读（亮背景上也有底层压暗）；
- BGM 可闻但不抢人声；听旁白入句和一处交叉循环，确认闪避/循环不可察。固定 `0.14`
  是已废弃的事故模式。
- 情绪弧线可读：开场 `curiosity/超现实梦境`，中段依次经过平静、冲突、接纳，
  金句 `insight/极简光影/AI 图/hold`，结尾 `release/水墨意境`；完整弧线固定使用这三种风格，不引入第四种。
- AI 图覆盖真实 TTS 时长 35–65%，动态视频至少 10%；同一生成任务的连续分镜只启动一次
  Ken Burns，任何素材都没有跨非连续段复用。
- 画面进入寺院静室氛围：开场标题、中心金句、细边框和下方出处有层级；不得有圆角黑卡、
  重复金句字幕或拿现代公园/人车素材冒充禅意。
- 审核全片报告：首 60 秒在 25 秒内已出现真实静室/仪式/寺院空间，而不是只靠自然风景、暗色滤镜或
  文字层营造“佛学感”。

### 8. 交付验证

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate -of json <output.mp4>
ffprobe -v error -show_entries format=duration -of csv=p=0 <output.mp4>
```

要求：H.264 + AAC、1280x720（或 props 声明的画幅）、30fps、单音轨、
时长与 TTS 主音轨一致（±1s）。另需人工确认：

- `check_dharma_sync.mjs` 通过；
- 旁白无缺失/重复（成片完整听一遍或抽查段落边界）；
- 全片无裸硬切（氛围慢叠化、人物叙事插画短 `dip-to-ink`）、无素材循环断点；
- 素材无水印/出戏元素；manifest 授权证据齐全；
- 收尾金句卡 + 最后一段画面的情绪落点与文稿结尾一致。

## Queue Stages and Routes

| 顺序 | 动作 | 路由/任务 | 职责 |
| --- | --- | --- | --- |
| 1 | 剧集导入 | `POST /api/v1/dramas` + `POST /api/v1/dramas/:id/import-script` | 复用现有链路：Episode + TTS 主音轨 + 分镜 |
| 2 | 语义视觉计划 | 规划 `shot_function/semantic/emotion/style_id/role/move` | 先锁定视觉命题、人物关系、可见证据、弧线和素材预算，不写库 |
| 3 | AI 叙事插画批量生成 | `POST /api/v1/dharma/episode/:id/footage/generate`（并发） | 每个语义段落一次任务；任务快照语义、风格与情绪，完成后写回 generatedSegmentTaskId |
| 4 | 素材指派 | `POST /api/v1/dharma/episode/:id/footage` | 写 `storyboards.grid_cells`（dharma 形状），同步返回；每项带 role/emotion/style_id |
| 5 | 全片预检 | `POST /api/v1/dharma/episode/:id/preflight` | 编译全片输入并生成可审核的 production gate |
| 6 | 风险 canary（条件） | `POST /api/v1/dharma/episode/:id/canary` → `dharma.episode_render` | 仅服务端风险窗口；不改写成片指针 |
| 7 | 审批与渲染 | `POST /api/v1/dharma/episode/:id/review/approve` → `POST /api/v1/dharma/episode/:id/render` | 审核精确指纹后一次正式渲染，写回 video_url |

支撑读：

```text
GET /api/v1/dharma/episode/:id/footage    # 指派现状 + 文件存在性 + pre_tts_ready + video_url
GET /api/v1/grid/videos/assets            # 可复用视频资产库
GET /api/v1/library/music                 # BGM 候选
```

### Payload schemas

| 路由 | 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| footage | `assignments[].storyboardId` | number | 必填 | 属于本剧集 |
| footage | `assignments[].theme` | string | 空 | 段落主题（审查面显示） |
| footage | `assignments[].role` | enum | 必填 | `temple_interior` / `ritual` / `temple_exterior` / `contemplative_nature` / `human_relationship` |
| footage | `assignments[].emotion` | enum | 必填 | `curiosity` / `stillness` / `tension` / `acceptance` / `insight` / `release` |
| footage | `assignments[].style_id` | enum | 必填 | 三个 production style 之一，必须与 emotion 映射一致 |
| footage | `assignments[].video` | object | 二选一 | `src` 必填；provider/licenseUrl/creator/durationSec/sourceStartSec/focusX/focusY/grade 可选 |
| footage | `assignments[].image` | object | 二选一 | `src` 必填；`move` ∈ push/pull/hold/drift_left/drift_right |
| footage | `assignments[].quote` | object \| null | 保留旧值 | `{ text, source? }`；null = 移除 |
| footage/generate | `storyboard_ids` | number[] | 必填 | 一个连续视觉段落；不要按单个 storyboard 串行生成 |
| footage/generate | `kind` | enum | 必填 | `image`（关键情绪图）或 `video`（动态衔接） |
| footage/generate | `model` | string | 配置首项 | 只能选择 Episode 绑定配置中的模型；pcore 推荐 720p 成片使用 `gpt-image-2-1k`，始终异步 |
| footage/generate | `reference_images` | string[] | 空 | 连续人物镜可传 1–3 张同 Episode 已指派图片；进入任务 fingerprint，pcore 仍异步 |
| footage/generate | `prompt` | string | 必填 | 已审查的情绪化画面描述，不要把旁白整段原样塞入 |
| footage/generate | `role` / `emotion` / `style_id` | enum/string | 必填 | 固化该生成任务的空间、情绪和风格 snapshot |
| footage/generate | `move` | enum | image 默认风格值 | `push` / `pull` / `hold` / `drift_left` / `drift_right` |
| footage/generate | `shot_function` | enum | 新叙事图必填 | `narrative_illustration` / `atmosphere_bridge` |
| footage/generate | `semantic` | object | 叙事图必填 | `subject_count/subjects/relationship/action/visible_emotion/visual_evidence` |
| review/approve | `fullPlanFingerprint` | string | 必填 | 必须与当前全片预检完全一致 |
| review/approve | `canaryFingerprint` | string | 条件必填 | 仅预检要求 canary 时传入 |
| review/approve | `actor` / `reason` | string | 必填 | 审核审计信息 |
| canary | body | `{}` | 必填 | 服务端选择连续 15–30 秒风险窗口 |

生产请求只能走 `/dharma/episode/:id/preflight`、条件 `/canary`、`/review/approve` 和最终 `/render`；
不要通过通用 `/tasks` 创建 `dharma.episode_render`，也不要让客户端传 canary 的分镜或时长。
历史 camelCase 任务的实际交付类别必须按旧 handler 的读取规则人工核对，不能根据 API 层的宽松解析
把正式成片误判为历史 pilot。

## Stage Gates

| 阶段 | 硬前置 |
| --- | --- |
| 素材指派 | 分镜存在；素材文件在盘上（路由校验）；每项有受控 `role/emotion/style_id`；人物关系镜头有 `narrative_illustration + semantic` 且为 AI 图片 |
| `dharma.episode_render` | preTtsAudioUrl + preTtsTitlesJson；titles 覆盖率 0.60–1.05；**每个**分镜有 dharma 素材指派且文件在盘上；每个源文件仅一个连续分镜范围（`asset_reuse_ready == true`）；视觉角色完整、静室/仪式/寺院覆盖真实时长 ≥60%、首 60 秒在 25 秒内进入该空间；情绪弧线完整、实际使用三种 production style 且不引入第四种；AI 图覆盖 35–65%、动态视频至少 10%；首镜 `curiosity + 超现实梦境` 且第 0 帧有运动，insight/金句为极简光影 AI 图 + hold；BGM 已配置、可测响度、≥180s；素材慢放比 ≥0.6（props 构建硬失败） |
| 正式渲染 | 当前全片 fingerprint 已人工审核；若要求 canary，则其精确 fingerprint、不可变输出和审核也都有效 |

## Repair Playbook

瞄准最早失败的阶段，用最小范围返工：

1. 定位问题：`GET /api/v1/dharma/episode/:id/footage` + 渲染任务 events。
2. 素材问题（不满意/文件丢失/时长不足）：重新检索下载 → `POST footage`
   覆盖对应 storyboardId 的指派 → 重渲。
3. 金句卡问题：`POST footage` 只更新对应分镜的 `quote` → 重渲。
4. 时序问题（check_dharma_sync 失败）：**不要碰渲染层**。确认分镜旁白与
   preTtsTitlesJson 同源；必要时重跑 import-script 或 tts.pre_generate。
5. 渲染本身失败（Remotion/ffmpeg）：读任务 events 里的 tail 日志，修复后整片重渲
   （任务不可续跑）。

## Foreground Monitoring

路由返回 `{ task_id }`，每 5–10s 轮询 `GET /api/v1/tasks/:task_id`。
同一剧集同一时刻只跑一个 dharma 阶段：

```sql
SELECT id, type, status, lease_expires_at FROM creation_tasks
WHERE episode_id = ? AND type = 'dharma.episode_render' AND status IN ('queued','running')
ORDER BY created_at DESC;
```

`running` 且 `lease_expires_at < datetime('now')` = worker 可能已死，上报而不是
再排一个。同一剧集只允许一个 active render task；重复点击返回原任务。若该行已有
`commit_claimed_at`，恢复程序会把它标为 `stale`（`task_commit_claimed_reconciliation_required`），
**绝不自动重试或把 task-private 文件重新关联到剧集**；先核对 `video_url`、metadata、任务 events
与交付文件，再由操作者显式做 reconciliation。使用
`POST /api/v1/dharma/episode/:episodeId/render/:taskId/reconcile`，在
`X-Task-Control-Token` 提供控制 token，并提交 `RECONCILE <taskId>`、具体原因、操作者标签和
`resolution`：`retain_published` 只在当前可见指针正好指向该 task 的不可变产物时可用；
`discard_unpublished` 只在当前可见指针**没有**指向该产物时可用。两种决议都会追加对账审计事件，
但绝不自动删除不确定文件或重写可见指针；成功后才允许新 render 或删除剧集。观察 task events 的
`preflight / props_build / remotion_render / output_validation / publish` 计时和帧进度。`props_build`
（含代理转码）默认 15 分钟上限，Remotion 默认 40 分钟上限且 3 分钟无帧进度即中止；渲染可用
`REMOTION_DHARMA_CONCURRENCY`（默认 4，按本机基准后才提高）配置，取消会终止 Remotion/ffmpeg 进程。

任务中心优先通过 SSE 接收 task snapshot 与 `task-event`；断线回退时只用
`GET /api/v1/tasks/:id/events?after_id=<lastEventId>` 取增量。不要在长渲染中每几秒反复拉整段
event history。

**取消正式整集渲染不是普通重试动作。** 正式整集指 payload 没有 `max_duration_sec` 且没有
`only_storyboard_ids`；不得因为旧成片、旧评论或旧任务状态而自主停止它。先核对当前任务的输入版本、
素材指派和 production approval；仍需停止时，必须通过任务中心提交任务编号绑定的确认文本、具体原因和操作者
标签，并在 `X-Task-Control-Token` 传入与后端 `TASK_CONTROL_TOKEN` 匹配的值。生产部署必须将
`TASK_CONTROL_TOKEN` 作为高熵、仅后端可见的 secret 注入；不得写进代码、前端配置、日志或 shell history，
反向代理也不得记录该 header。未配置 token 时正式整集取消必须 fail closed。该 token 仅授权控制操作，
操作者标签仍只是审计声明，不是可信身份。`cancel.requested` 事件必须保留脱敏的确认结果、原因和审计
信息，不能保存确认原文或控制 token。风险 canary 和局部 preview 是可快速取消的低风险任务，但仍应说明
当前审查结论。无原因的 curl / agent
调用正式整集取消是流程违规，不是“节省时间”。

前台每次状态变化应至少给出：当前阶段、该阶段已用时间、总已用时间；进入帧渲染后还应给出
已完成/总帧、平均 fps 和 ETA。超过 60 秒没有阶段变化或超过阶段预算时，先报告阶段账单和日志证据，
再决定诊断、等待或请求人工取消；不允许把“还在跑”概括成“卡住了”。

## Validation Ladder

```text
契约测试（cd backend && npm test，即 `TASK_WORKER_DISABLED=1 tsx --test "src/**/*.test.ts"`；
remotion tsc --noEmit）。测试入口不启动后台 worker；直接 provider 测试仍必须 mock 网络。
-> 全片 preflight + 人工审核精确 fingerprint
-> 条件 canary 渲染 + 审核（仅风险存在时）
-> 一次整集渲染 + 交付验证
```

生产 gate 未通过，不渲整集。生产全程前台监控，不要丢进 tmux 不管。
