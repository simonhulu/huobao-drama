# Lessons Learned（remotion-dharma-factory）

每次生产运行中犯过的错误。每条 = 当时错误的心理模型 + 正确模型 + 可执行防错规则。
新错误追加到文件末尾，不要改写旧条目。

---

## 1.（继承）时序的唯一来源是 TTS 主时间轴，不是任何重新推导

**继承自**：remotion-history-factory lessons-learned #6（Episode 645，画面/字幕
平均落后旁白 2.7s、峰值 8s）。

本管线没有 narrative plan / visual_beats，时序链是：

```text
preTtsTitlesJson（毫秒）-> 分镜旁白顺序定位（locateNarrationWindow）
-> masterTimeAt 插值 -> 绝对帧窗 -> 段落/金句/字幕
```

`buildDharmaProps` 对定位失败的分镜**直接抛错**，没有字数估算降级路径。

### 防错规则

- 任何"按字数比例分摊时长"的念头出现时，停下来——那是 2.7s 平均漂移的来源。
- 每次渲染后跑 `node scripts/videoeditor/check_dharma_sync.mjs <episodeId>`
  （独立重推导，不复用后端代码）；exit≠0 = 数据不同源，回数据层修。
- `storyboards.duration` 是拆分阶段估计值，渲染时序不用它。

---

## 2.（继承）duration 单位是秒；titles 的 time_begin/time_end 是毫秒

**继承自**：remotion-history-factory lessons-learned #2（10813ms 直接写进
duration 秒字段，触发拒绝）。

### 防错规则

- 手写 SQL 改 `storyboards.duration` 时，值域应在 2~20；出现 ≥100 的值就是
  毫秒没换算。
- 构建/校验代码里所有 titles 时间先 `/1000` 再用。

---

## 3.（继承）BGM 必须先于渲染配置

**继承自**：remotion-history-factory lessons-learned #5（第一次渲染没有 BGM）。

本管线更严格：`dharma.episode_render` 对未配置/文件缺失/<180s 的 BGM **硬失败**。
BGM 不是可选项——单轨 BGM 是成片声音设计的一半。

### 防错规则

```sql
SELECT bgm_audio_url FROM episodes WHERE id = ? AND bgm_audio_url IS NOT NULL;
```

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 backend/data/<bgm_path>  # ≥ 180
```

---

## 4. DharmaEpisode 里视频 muted 是设计，不是 bug

**背景**：历史工厂 lessons-learned #4 是"视频被硬编码 muted 丢掉原声"的反向
事故（它的 Video 层现在故意放原声 volume=0.7）。两条管线的决定相反，都正确：

- 历史工厂：Grok 开场视频的环境声是叙事的一部分，要保留。
- 本管线：stock 素材的环境声（风声、人群、音乐）不可控，与单轨 BGM + 人声
  双轨声音设计冲突——**全片唯一人声声源是 narration master，唯一音乐声源是 BGM**。

### 防错规则

- 不要在 DharmaEpisode 的 Video 层加 `volume` 或去掉 `muted`。
- 想要环境音氛围（溪流、风铃）时，正确做法是把环境音 loop 选作 BGM 层
  的一部分（选曲阶段决定），不是放开素材原声。

---

## 5. 素材绝不硬循环——慢放有下限，不足就换

**为什么是规则**：禅意画面的运动极慢，观众对循环断点极其敏感。一段 8s 的
云雾素材循环 3 次覆盖 24s 段落，每次跳回起点都是一次"出戏"。

实现：`resolveVideoWindowTiming`（`backend/src/services/dharma-props.ts`）在
素材时长 < 段落时长时给慢放比，`playbackRate < 0.6` 直接抛错（props 构建失败）。

### 防错规则

- 检索素材时用 `--min-duration 10`，优先 15s+ 的源。
- 指派前算一遍：段落时长（相邻同素材分镜窗口之和）≤ 素材时长 / 0.6。
- 抛错时的两个正确动作：换更长素材 / 把段落拆两段各配一条素材。
  **错误动作**：改代码放宽下限、在 Remotion 层加 loop。

---

## 6. 金句卡是稀缺资源

（预防性规则，来自文稿侧修辞预算的同一哲学。）

一篇稿子 3–6 张。句句都配卡 = 没有卡。只给：经文原句亮相（带 source）、
情绪核爆点、收尾金句。配卡文案 ≤ 24 字最佳，超过 36 字取半句。

---

## 7. 只渲染本地文件，授权证据随指派走

（继承自历史工厂素材规则的浓缩版。）

- stock 必须经 `stock_videos.mjs download` 落盘 + manifest 含 sha256；
  指派写齐 provider/sourceUrl/licenseUrl/creator。
- footage 路由校验文件存在才落库；渲染硬门禁再查一遍。
- 看到远程 URL 出现在指派里 = 流程事故，重新走下载。

---

## 8. 一条素材只属于一个连续视觉段落

**事故**：Episode 693 的 28 个视觉段落只用了 7 条视频；雨窗、竹林和云海在相隔数分钟
后反复出现。即使每次改了 `grade` 或 `sourceStartSec`，观众仍会立刻认出画面回来了。

### 防错规则

- 同一剧集内每个 canonical local source 只能出现一个连续 storyboard range；允许
  `A,A,A`，拒绝 `A,B,A`。视频和静态图同样适用。
- 在 `POST footage` 写库前投影整集后的 assignments 校验一次；`buildDharmaProps` 再对
  全集校验一次，pilot / SQL 直写不能绕过。
- 素材预算先于下载：总时长 / 单段最大 30 秒 = 独立素材最低数。库不够先补库，不能重复铺。

---

## 9. BGM 音量必须以响度差计算，不能固定 gain

**事故**：`FutureAmbient_2.wav` 为 -9.25 LUFS，旁白为 -27.76 LUFS。乘以固定 0.14 后，
音乐约 -26.3 LUFS，仍比人声高约 1.4 LU；36 秒短 loop 又会在 678 秒成片里重复约 19 次。

### 防错规则

- BGM 源至少 180 秒，短 loop 不进长口播。
- props builder 用 `loudnorm` 首遍测 BGM / narration，目标是无声间隙约低人声 14 LU，
  旁白窗口再降约 6 dB。测不出就拒绝，不猜音量。
- 对长片循环使用交叉淡变；试听旁白入句与循环点后才放行整集。

---

## 10. 代理与原子交付是长渲染的生产前提

**事故**：原始 4K/2.5K stock 让 60 秒 pilot 用了 12m44s；转为 720p proxy 后同一 pilot
降到约 110s。此前取消不会杀掉 Chrome，且两个 render 都能直接覆盖同一交付文件。

### 防错规则

- Dharma delivery 以 1280x720 proxy 解码；保留原文件和 provenance，但不要让 720p 成片
  逐帧解码 4K 原片。
- 记录 `preflight / props_build / remotion_render / output_validation / publish` 的耗时及帧进度，
  先看阶段证据再说“慢”。
- 每个任务写 task-private staging；ffprobe 通过后才原子 rename 到交付文件。取消必须终止
  Remotion 进程组并清理 staging；同集 active task 去重。

---

## 11. Pilot、素材来源和代理时限都必须是代码门禁

**事故**：此前任意长度 preview 都可能被标为可审核 pilot；老分镜还把
`stock/proxy/...` 当作素材来源；并且 proxy 阶段没有整体 deadline，worker 会持续续租。
这会把“前 60 秒验收”和“素材原件可追溯”的生产规则退化为人工约定。

### 防错规则

- 只有无分镜子集、`maxDurationSec === 60` 的成片能写入 `metadata.dharmaPilot`；人工审看后
  必须调用 `/pilot/approve`，且素材/旁白/BGM 任一变化会使 approval fingerprint 失效。
- 素材指派永远引用 manifest 对应的原始 stock 路径；delivery proxy 和 `dharma-assets` 仅由
  渲染内部产生，不能被数据库指派引用。
- `props_build`（含所有 ffmpeg proxy）默认 15 分钟总上限，超时向子进程传递 abort，
  SIGTERM 后升级 SIGKILL；事件中必须能看到 `props_build` 和每条 proxy 的耗时。

---

## 12. 响度首遍分析必须异步、可取消，并复用同一输入的结果

**事故**：Episode 693 的 `loudnorm` 首遍用 `spawnSync` 扫描完整旁白和长 BGM。任务本身
仍在正常构建 props，但 Node 事件循环被占住，前台轮询一度超时，表面上看像任务卡死。

### 防错规则

- `loudnorm` 必须用异步子进程执行，接入 props-build 的 `AbortSignal`；单次分析默认最多
  2 分钟，超时先 SIGTERM、必要时 SIGKILL，不能让损坏音频无限续租任务。
- 以真实路径、文件大小、mtime 为 key 缓存成功的响度结果。pilot 与同输入的正式渲染必须
  复用测量，不能为同一段 10 分钟旁白重复扫描。
- 任务事件同时记录 props 阶段总耗时和 BGM mix 结果；轮询超时先检查是否存在同步子进程，
  再判断渲染是否失活。

---

## 13. 媒体元数据探测也不能同步阻塞

**事故**：Episode 693 修复了 `loudnorm` 的同步扫描后，仍发现视频/BGM 时长探测使用无
时限同步 `ffprobe`。损坏的容器或网络挂载文件会重新堵住 Node 事件循环，表现和“任务卡死”
没有区别，并且取消信号无法送达子进程。

### 防错规则

- 所有可能接触外部/下载媒体的 `ffprobe` 都必须异步运行，接入调用链的 `AbortSignal`，
  metadata 探测默认最多 15 秒；超时先 SIGTERM、必要时 SIGKILL。
- `probeMediaDurationSec` 是 Promise；素材指派、渲染 preflight、props 构建必须 `await` 它，
  不许改回 `execFileSync` / `spawnSync`。
- 一个素材指派请求内按绝对路径复用同一探测 Promise；连续分镜共用同源时不能重复 ffprobe。

---

## 14. 中央金句是受限的仪式性排版，不是任意长文本容器

**事故**：对标画面能够庄重，依赖的是单一短句、中心留白和清楚的层级；如果把一整段经文
塞进中央卡，哪怕字号自动变小，也会变成字幕墙，破坏“静室听法”的停留感。

### 防错规则

- 金句以 ≤24 字为最佳，36 字为硬上限；超过时在文稿/分镜阶段拆成一句核心教义。
- `POST footage` 与 props 构建都校验这个上限，旧的 SQL 数据也不能绕过渲染门禁。
- 金句展示期间压掉同句字幕，只保留象牙衬线字、细金分隔线和必要的小出处；不要添加圆角
  气泡、账号水印、英文翻译或装饰性佛像。

---

## 15. 交付规格必须在 publish 前由机器强制，不靠人工 ffprobe

**事故**：早期 output validation 只验证“文件非空且有一个音视频流”。这允许错误的编码器、
分辨率、帧率或多音轨在任务显示成功后才被人工发现，违反工厂的交付契约。

### 防错规则

- 发布前的 ffprobe 必须拒绝非 H.264 视频、非 AAC 音频、非 1280x720、非 30fps、
  非单视频流或非单音频流，以及与 props 时长相差超过 1.5 秒的输出。
- 通过该门禁并不替代 `check_dharma_sync.mjs` 和人工审画；它只保证文件层面可交付，
  不保证旁白、画面和金句的创作质量。

---

## 16. 帧渲完后，watchdog 要盯输出活动，不能继续盯帧数

**事故**：Remotion 报出 `Rendered total/total` 后还会经历编码和封装。旧 watchdog 继续使用
最后一帧时间，三分钟内没有新帧便会终止一个健康的 encode，造成“快完成时反而失败”。

### 防错规则

- 帧渲染期继续用帧进度停滞门禁；frames 完成后改为检查 stdout/stderr 输出活跃度。
- 编码阶段的无输出宽限至少 5 分钟（或帧停滞门限的两倍），但总时长上限始终生效；
  不允许因“避免误杀”而取消全局 deadline。
- 任务事件必须记录 watchdog 的触发阶段和 output-stall 上限，便于区分真正卡死和正常收尾。

---

## 17. 取消整集渲染必须可归因、可复核，不能由旧结论触发

**事故**：Episode 693 的进行中整集渲染被另一会话直接 `POST /tasks/:id/cancel` 终止。该会话把旧版
“素材重复且音频未通过”的结论当作当前输入的结论，没有核对新版素材、BGM、pilot approval 或任务
输入版本。服务端当时只写了无 data 的 `cancel.requested`，只能从本机会话记录反查是谁发出的请求。

### 防错规则

- 仅 running 的**正式整集** `dharma.episode_render`（无 `max_duration_sec`、无
  `only_storyboard_ids`）取消必须提供任务编号绑定的确认文本、可行动的原因和操作者标签；60 秒
  pilot 与局部 preview 保留普通取消路径，不能把低风险试看片误做成高风险整片。
- `cancel.requested` 要持久化 reason、声明的 actor/source、User-Agent 和转发地址。它们在没有认证层时
  只是审计线索，不能伪装成可信身份。
- 在取消前，比较当前 input fingerprint、分镜素材、BGM 和 pilot approval；旧成片的失败结论不构成
  取消当前任务的证据。
- 观察面必须显示阶段、已用时、fps 和 ETA。先拿阶段数据解释“慢”，再决定是否需要人工中断。

---

## 18. claim 后的交付指针也必须受 lease 保护

**事故**：即使 staging 文件已改为 task-private、且 publish 前做了 commit claim，旧 worker 仍可能在
lease 被 recovery 接管后继续写 `episodes.video_url` 或 pilot metadata。这样一个已经失去执行权的
进程仍能让孤儿文件变成可见成片。

### 防错规则

- publish 顺序固定为：同一 SQLite 事务 claim + 输入指纹校验 → 原子 rename 到 task-specific 文件
  → 以 `running + lease_owner + commit_claimed_at` CAS 在事务中更新 episode 指针。三者中任一条件
  不成立就拒绝关联文件。
- 过期的 `commit_claimed_at` 任务只能转为 `stale` 并带
  `task_commit_claimed_reconciliation_required` 审计码；不能自动 retry、不能复用旧 task id 再发布。
- 启动时若历史数据有多个同集 active render，先可审计地保留一个权威任务、其余转 `stale`，再建立
  唯一 active 索引；历史脏数据不得让服务直接无法启动。

---

## 19. 排版正确不等于素材空间正确，静室氛围必须有可执行门禁

**事故**：中心衬线金句、暗场和细金边框可以把画面做得庄重，但一段西式公园、马车或泛自然
素材仍会让“在寺庙静室听法”的空间感彻底失效。自由文本 `theme` 只能描述意图，不能阻止
错误素材进入成片。

### 防错规则

- 每个素材指派必须写受控 `role`：`temple_interior`、`ritual`、
  `temple_exterior` 或 `contemplative_nature`；未知值和旧的无角色数据均拒绝渲染。
- 用 TTS 真实窗口计算角色覆盖：前三类静室角色至少占全片 60%，首个 60 秒的前 25 秒
  必须进入其中一类。不要用 storyboard 的估计 duration 代替主时间轴。
- 同一连续源文件只能有一个角色；否则只是在用标签伪造素材配比。
- 这条结构门禁不替代 pilot 审片。仍要核对实际画面是否真是寺院/仪式空间，不能把角色标签
  当成自动内容识别结果。

---

## 20. 旁路删除与无出口对账都会破坏交付所有权

**事故**：剧集删除曾直接把 active task 写为 `canceled`，绕过正式 Dharma 整集的控制 token、
确认文本、审计事件和 commit-claim fence；同时，恢复程序把已 claim 的任务标为 `stale` 后，
新 render 曾能直接绕过“需人工对账”的状态。若只加阻断而没有受控解除动作，运维又会被迫手改 SQLite。

### 防错规则

- 删除剧集先经 task store 对普通任务写入可审计的 cancellation request；存在正式 Dharma 整集
  或 `task_commit_claimed_reconciliation_required` 时返回 409，绝不代替操作者取消或覆盖状态。
- 已 claim 的 stale render 在 explicit reconciliation 前不允许任何新 render（pilot、局部 preview、
  整集都一样）或删除来源剧集。
- reconciliation 必须由 control token、`RECONCILE <taskId>`、原因和操作者标签保护；
  `retain_published` 要求当前指针精确指向该 task 产物，`discard_unpublished` 要求当前指针不指向它。
  它只解除 gate 并记审计事件，不自动删文件、不自动改可见指针。

---

## 21. 删除门禁和 payload 解释必须与真实执行路径一致

**事故**：删除剧集时曾用任务中心的全局 active 列表作安全判断；它只返回最新 200 条，压力下会
漏掉较早的正式 Dharma render。另一个旁路是 API 对 camelCase `maxDurationSec` 做了宽松解析，
而旧 handler 只读取 snake_case，导致已按正式产物发布的任务可能被 reconciliation 当作 pilot
“未发布”处理。

### 防错规则

- 删除/软删除前按目标 `episode_id` 直接查任务，不可复用带分页、上限或 UI 排序的任务列表。先完整
  预检正式 render 与待 reconciliation blocker，再对普通任务写 cancellation request；409 不得留下
  普通任务已取消的副作用。
- soft-deleted episode 不能再接收 render admission 或 pilot 审核；handler 的 preflight、commit
  validation 和最终指针 update 都必须再带 `deleted_at IS NULL`，以抵抗跨进程竞态。
- 新任务只保存 canonical snake_case render payload，执行器拒绝 camelCase。历史 payload 的 artifact
  identity 必须按当时 handler 实际读取的字段推导；无法确定时按正式交付 fail closed，先人工对账。

---

## 22. Episode 728：机械 stock 轮播不能承载抽象内容

**事故**：Episode 728 用大量泛自然/stock 段落平均铺满全片，靠统一暗色滤镜和字幕营造“佛学感”。
素材没有 `emotion/style_id`，同一类画面在不同段落反复出现，金句没有专门的极简光影停顿；
为了确认质量又反复 pilot，前置时间和渲染时间一起被浪费，成片仍然没有好奇、冲突、接纳和顿悟
的情绪弧线。错误的心理模型是“素材越多越丰富、文字层会补足画面”。抽象口播恰好相反：画面
不能图解，只能在声音停顿处承载心境。

### 防错规则

- 规划先于下载：先锁定 `curiosity -> stillness -> tension -> acceptance -> insight -> release`
  和三种风格映射，再决定动态视频窗口与 AI 关键图窗口。
- AI 关键图覆盖真实 TTS 时长 35–65%，动态视频至少 10%；关键图一次性写 prompt 后按已验证
  worker 并发批量生成，失败只重做对应段落，不串行等待每一张。
- 每个段落固化 `role / emotion / style_id / move`；同一来源只能占一个连续范围，A-B-A
  和同一任务逐镜重启动 Ken Burns 都拒绝。
- `insight`/金句必须是带 `generatedSegmentTaskId` 的极简光影 AI 图并 `hold`；普通 stock
  静态图不能冒充顿悟。
- 生产只做全片 preflight，风险存在时才做一个条件 canary，审批后一次正式渲染；不得把 pilot
  反复试渲当作创意规划或质量保证机制。

---

## 23. 条件 canary 必须按自己的音频起点做同步校验

**事故**：风险 canary 会从全片中段的连续分镜开始渲染，并以 `audioStartFrame` 将主音轨裁到
该窗口。独立校验器曾一律把 partial props 当作第 0 帧开始，错误地把健康的第 64–66 分镜
canary 判为旁白截断；这会诱发无意义的重渲或错误地否决正式生产。

### 防错规则

- partial props 的校验起点优先使用 `audioStartFrame`，而不是默认使用整集首分镜时间。
- `--allow-partial` 默认选择最近生成的 partial props；仍可显式传入 props 路径以固定审查对象。
- canary 同步校验失败时，先确认它是否按自身的 TTS 窗口重定基；不得把校验器的整集起点假设当作
  素材或 Remotion 的时序故障，更不能因此重复提交 canary。

---

## 24. Episode 734：情绪标签不能代替叙事语义

**事故**：首句明确说“活得通透的人在亲情关系里往往最冷”，生成任务却带着 `no people` 和寺院
空间锚点；前 3 个不同旁白段落又共用同一张空氛围图。系统只校验 `role/emotion/style/move`，所以
即使画面没有人物、关系、动作或孤独感，仍返回 `creative_ready=true`。错误心理模型是“抽象口播
只能承载情绪，不能提供叙事证据”。抽象道理不能画成图表，但可以画成具体的人物处境。

### 防错规则

- 镜头先分为 `narrative_illustration` 与 `atmosphere_bridge`。旁白出现人物、关系、动作、故事或
  心理因果时必须用前者；空寺院、佛像、香火、山水只允许承担后者。
- 叙事插画任务持久化 `subject_count / subjects / relationship / action / visible_emotion /
  visual_evidence`；人物关系角色缺任何字段，路由和 props 构建都拒绝。
- prompt 只是执行文本，`visual_evidence` 才是验收真源。先出接触表逐张核对，语义不合格只重生
  对应图片；通过接触表后才允许一次 60 秒 preview。
- 人物、关系、动作或可见证据变化就是新图片段落。同一张图不得跨不同语义段复用，即使风格、
  情绪和空间相同。

---

## 25. Episode 734：预览上限、金句和异步生图都必须绑定真实执行边界

**事故**：`maxDurationSec=60` 曾只保留完整落在 60 秒内的 storyboard。一个 36.8–68.2 秒的
长 storyboard 被整段丢弃，60 秒预览实际只剩 36.8 秒旁白和 23 秒画面尾奏。金句又覆盖整个
storyboard，导致经文比真实口播提前 4.45 秒出现并隐藏无关字幕。pcore 配置虽包含 1K 模型，
接口却只能取列表第一项，供应商连续超时时无法在同一异步线路内切换档位。

### 防错规则

- 预览上限先映射到 TTS 主时间轴最后一个完整 title；跨界 storyboard 保留并裁到该字符/时间边界，
  字幕、旁白窗口和画面段落一起裁，剩余只允许短视觉尾奏。
- quote 文本必须能在当前 storyboard 的 TTS 字符区间精确定位；显示窗口取真实发音位置并加克制
  前后停顿。找不到就失败修数据，不能退回整镜覆盖。
- storyboard 漏掉主 TTS 中间句会造成后续定位空洞；先把原句补回正确位置，不按字数估算或用
  黑场掩盖。
- `footage/generate.model` 只能从绑定配置白名单选择。pcore `gpt-image-2-1k` 用 1280x720 且继续
  `async: true`；模型切换进入任务 fingerprint，不得用同步模式或重复同输入任务冒充重试策略。

---

## 26. Episode 734：写了人物连续性，不等于模型会自动保持人物连续性

**事故**：第三镜的 prompt 和 semantic 声称沿用前两镜同一家庭，但实际生成图把“成年儿子 + 成年
女性手足”变成“少年男孩 + 成年男性”。情绪和谐并不能补偿角色年龄、性别槽位发生变化。错误心理
模型是“把同一人物描述再写一遍，就等于有角色参考”。

### 防错规则

- 连续人物镜从第二张开始传上一张已通过接触表的本地图片作为 `reference_images`；pcore 继续使用
  异步 generations + poll，不得为了图生图改成同步调用。
- 参考图只能来自同一 Episode 已指派图片，最多 3 张，通常只传紧邻上一张；路径进入任务 fingerprint，
  使换参考图一定产生新的可审计任务。
- prompt 仍锁定年龄、性别、发型、服装和关系槽位；参考图不替代 semantic 六字段，也不替代接触表。
- 角色槽位变化是 FAIL，只重生该张；不得把“同一家庭”悄悄改成“另一组家庭”来绕过本来要表达的反转。

---

## 27. 快速语义 Demo 不能被尚未改造的整集旧视觉反向阻塞

**事故**：前 60 秒七张叙事插画已通过接触表，但 props 构建先对 11 分钟整集旧素材执行三风格、
AI 图片数量和单图时长门禁，导致 Demo 在渲染前失败。这样“先用 1 分钟验证新方案”在代码层不可行。

### 防错规则

- 只有“显式连续 storyboard 子集 + 精确 60 秒”可进入 `semantic_preview`；它仍检查 TTS 主时间轴、
  BGM、文件安全、生成任务归属、semantic、金句定位、素材唯一性和精确裁切。
- 独立同步校验器也必须把跨界 storyboard 裁到上限前最后一个完整 TTS title；若仍按“整镜完整落入”
  过滤，它会把健康的 58.654 秒旁白误报成 36.8 秒结束。
- `semantic_preview` 只暂缓整集三风格情绪弧线与 hybrid 配比，不能用于 canary、任意短片或正式整集。
- Demo 通过只证明该分钟的语义、构图、运镜、文字和声音方案；扩展整集后必须重新通过完整 production gate。

---

## 28. 人物叙事插画不能沿用山水素材的慢叠化

**事故**：24 帧真叠化用于山水、光影很柔和，但 Episode 734 的师徒→母子、母子→哭诉场景在
`29.8–30.0s` 和 `36.3–36.6s` 叠出 3–4 张脸。错误心理模型是“转场越慢越高级”；人物脸部对
错位极敏感，慢叠化会制造畸形视觉。

### 防错规则

- 氛围镜头继续使用 24 帧真叠化；任一侧是人物叙事插画且两侧都是静态图时，使用边界前后各
  8 帧的 `dip-to-ink`，在暗处切图，不让两张人物图同时可见。
- `shotFunction` 必须进入 Remotion segment props；渲染器不能靠文件类型猜镜头职责。
- 接触表通过不代表转场通过。最终成片必须抽查每个素材边界，发现双重人脸即 FAIL，只修转场，
  不重生已通过的图片。

---

## 29. 预览请求选中的分镜数，不等于实际成片段落数

**事故**：Episode 734 的 60 秒请求显式选择了 7 个 storyboard，但第 7 个语义 beat 位于最后一个
完整 TTS title 的裁切点之后，最终 props 和成片只有 6 个视觉段落。若按请求数组长度汇报“用了 7 张图”，
会让素材数量、转场数量和审片范围都与真实输出不一致。

### 防错规则

- 预览素材数以最终 props/result 的 `segment_count`、TTS scoped windows 和成片接触表为准，
  `onlyStoryboardIds.length` 只表示允许选择的连续范围。
- 60 秒裁切后的每个实际语义 beat 必须有独立图片；裁切点之后尚未进入成片的图片可以保留给整集，
  但不能计入本次 Demo 的已验证镜头数。
- 汇报耗时时同时列出 `props_build / remotion_render / output_validation / publish`，总耗时超出基线时
  先定位具体阶段，不用重复渲染掩盖统计错误。
