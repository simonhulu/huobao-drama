# 静态图片视频增强执行计划

## 一、背景与现状

当前 huobao-drama 的 `image_story` 渲染链路已经跑通：

- 分镜表 `storyboards` 保存了 `image_prompt`、`video_prompt`、`bgm_prompt`、`sound_effect`、`narration`、`dialogue` 等字段。
- `backend/src/services/ffmpeg-compose.ts` 会把 `firstFrameImage` 用 FFmpeg `zoompan` 做成带 Ken Burns 运动的镜头，并烧录旁白/对白字幕。
- `backend/src/services/ffmpeg-merge.ts` 把多个镜头简单 concat 成完整视频。

**已具备的基础**：静态图 + 简单 Ken Burns + TTS 旁白 + ASS 字幕。

**明显缺失的“高级感”**：

1. 运动单一：只有随机 zoom/pan，没有 2.5D 视差、没有按镜头语义运动。
2. 声音单调：没有环境音床、没有点音效、没有背景音乐动态映射。
3. 剪辑生硬：镜头之间直接拼接，没有 J/L Cut、没有转场、没有节奏起伏。
4. 视觉包装弱：只有字幕，没有标题卡、章节卡、高亮标注、胶片颗粒/LUT。
5. 动态镜头利用率低：`videoPrompt` 写了但 `image_story` 模式下完全没用。
6. 题材针对性不足：历史/科幻/神话/太空/深海/废土没有各自固定的视听配方。

本计划按 **“先让 80% 视频不单调，再让 20% 视频出彩”** 的原则分三个阶段推进。

---

## 二、总体目标

让 `image_story` 模式产出的视频具备纪录片/YouTube 长视频的视听基本盘：

- 画面有运动层次，不再是一张图定住几秒。
- 声音有环境 bed + 点音效 + 背景音乐三层。
- 剪辑有节奏设计，转场不生硬。
- 关键信息有字幕/标题/高亮辅助。
- 不同题材有差异化的默认配方。

---

## 三、分模块执行计划

### 模块 1：画面运动增强（Ken Burns → 2.5D 视差 + 语义化运动）

#### 现状

`ffmpeg-compose.ts` 的 `buildKenBurnsZoompan` 已能根据 `sb.id` 随机选择 6 种 zoom/pan 预设。这是好的起点，但：

- 运动方向和景别无关（不会根据 `shot_type` / `angle` / `movement` 选择）。
- 单图层，没有前景/背景的深度分离。
- 没有“推近到脸部”“横扫战场”这类语义化运动。

#### 任务拆解

| 阶段 | 任务 | 关键改动 | 依赖 | 验收标准 | 工作量 |
|---|---|---|---|---|---|
| Phase 1 | **语义化 Ken Burns 预设** | 根据 `storyboards.shot_type`/`movement` 选择运动：特写用慢推近，全景用横扫，中景用轻微推拉。改造 `buildKenBurnsZoompan`。 | 现有 `storyboards` 字段已齐全 | 每种 `shot_type` 都有对应运动；同一分镜重复合成结果一致 | S (1–2d) |
| Phase 1 | **关键帧可配置** | 在 `storyboards` 增加可选字段 `motion_json`（开始/结束缩放、位移、锚点），让 agent 或人工能精确控制。 | DB migration + schema + breaker prompt | 字段可写、FFmpeg 能解析、回退到默认预设 | S (1–2d) |
| Phase 2 | **2.5D 视差（单图分层）** | 对重要镜头（establishing shot / 情感高点），用 AI/算法把图拆成 2–3 层，前景移动快、背景移动慢，合成 5–10s 视频。 | 需要图像分割能力（Segment Anything / 手动 mask）或让 image generator 直接出分层图 | 至少 3 个测试镜头能看出明显深度；不引入闪烁/黑边 | M (3–5d) |
| Phase 2 | **镜头间运动衔接** | 在 `ffmpeg-merge.ts` 里对相邻镜头的结束/开始帧做运动方向匹配（上一个 endZoom 大则下一个 startZoom 小），减少跳跃感。 | merge 流程改造 | 随机抽查 5 集，相邻镜头运动方向冲突 ≤1 处 | S (1–2d) |
| Phase 3 | **AI 视频片段增强关键镜头** | 对 `energy_level=high` 或 `renderMode=ai_video` 的镜头，用 `videoPrompt` 调用 image-to-video 模型生成 3–5s 动态片段，替换静态 Ken Burns。 | 接入 video adapter（如 Runway / Pika / Kling / Vidu） | 关键动作镜头有自然运动；成本可控（每集约 3–5 个动态镜头） | L (1–2w) |

#### 阻塞风险

- 2.5D 视差需要稳定的图像分割或生成“前景透明+背景”图。如果分割质量差，会先降级为“更精细的 Ken Burns”。
- AI 视频成本较高，Phase 3 建议先做小批量 A/B，确认完播率提升再全量。

---

### 模块 2：剪辑节奏与转场（J/L Cut + 智能切镜）

#### 现状

`ffmpeg-merge.ts` 用 `concat` 直接拼接镜头，音频也随镜头一起切。这会导致：

- 旁白说到一半换图，但没有 audio advance/linger，感觉生硬。
- 镜头之间没有淡入淡出或其他过渡。
- 没有按旁白句子的自然停顿切镜。

#### 任务拆解

| 阶段 | 任务 | 关键改动 | 依赖 | 验收标准 | 工作量 |
|---|---|---|---|---|---|
| Phase 1 | **旁白句子级切镜** | 在 `composeStoryboard` 时，根据 `narration` 文本的标点/停顿把单镜头再细分为多个子片段，或在 agent 阶段让 narrator 输出“切镜点”。 | narrator prompt + 中文分句工具 | 一集内切镜点与旁白停顿基本对齐 | S (2–3d) |
| Phase 1 | **简单转场** | 在 `ffmpeg-merge.ts` 的镜头之间加入 `xfade` 淡入淡出（0.3–0.5s），或根据镜头关系选择 wipe/dip。 | FFmpeg 版本支持 xfade | 输出视频有平滑过渡，不闪黑 | S (1–2d) |
| Phase 2 | **J-Cut / L-Cut** | 合成时让下一段旁白音频提前 0.3–0.8s 进入当前画面（J-Cut），或当前旁白延续到下一段画面（L-Cut）。需要按音频波形而非按镜头边界对齐。 | `mixAudioTracks` 改造 + merge 时音频跨镜头计算 | 相邻镜头切换时音频无缝；随机听 5 处无跳变 | M (3–5d) |
| Phase 2 | **节奏模板** | 根据 `pacing_mode`（literal/standard/tight/extreme）决定默认镜头时长、转场速度和运动幅度。 | `episodes.pacing_mode` 已存在 | 同一脚本用不同 pacing 生成，节奏明显不同 | S (1–2d) |
| Phase 3 | **情绪曲线驱动剪辑** | 让 agent 或规则引擎根据 `energy_curve` 自动调整：高能段镜头短、音乐响、转场快；抒情段镜头长、运动慢。 | `episodes.energy_curve` 字段已存在 | 能量曲线与平均镜头时长、音量正相关 | M (3–5d) |

---

### 模块 3：声音设计（环境音床 + 点音效 + BGM 动态映射）

#### 现状

- `storyboards.bgm_prompt` 和 `sound_effect` 已有字段，但 `ffmpeg-compose.ts` 完全未使用。
- 目前只有 TTS 旁白/对白，没有环境声，也没有背景音乐。
- `assets` 表可用于存放音频素材，但缺少分类和检索机制。

#### 任务拆解

| 阶段 | 任务 | 关键改动 | 依赖 | 验收标准 | 工作量 |
|---|---|---|---|---|---|
| Phase 1 | **音效字段落地** | 改造 `composeStoryboard`：在 `storyboards.sound_effect` 非空时，尝试从本地/远程音效库加载并混入镜头。 | 建立音效库（可先用免费 SFX 如 freesound / epidemic sound） | 至少 80% 有 `sound_effect` 的镜头能混音；音量不过大 | S (2–3d) |
| Phase 1 | **环境音 bed** | 按 `scenes.location`/`time` 自动匹配环境声（宫殿、太空、深海、风沙、雨声），铺在整个镜头或整集底层。 | 场景 → 环境音映射表；`assets` 表扩展 `category='ambient'` | 每个场景都有对应环境声；与旁白不冲突 | S (2–3d) |
| Phase 2 | **BGM 动态映射** | 引入背景音乐轨道：按 `storyboards.bgm_prompt` 或 `dramas.style` 选择曲目，并在旁白出现时自动 ducking（-12dB）。 | 音乐库或接入 AI 音乐生成（Suno / Udio / AIVA）；`mixAudioTracks` 支持多轨 | 旁白清晰可辨；情绪段落有音乐 swell | M (3–5d) |
| Phase 2 | **音效触发系统** | 对 `sound_effect` 中的关键词（如“脚步”“开门”“爆炸”）做时间轴定位，在画面动作点附近触发点音效。 | 需要 `sound_effect` 带时间偏移描述或从 `action` 推断 | 3 个测试镜头音画同步误差 <0.3s | M (3–5d) |
| Phase 3 | **AI 生成 BGM/SFX** | 对无现成素材的场景，用文本提示生成 15–30s 无缝循环 BGM 或一次性 SFX。 | 接入 AI 音频 adapter | 生成音频无版权风险、风格统一 | L (1–2w) |

#### 阻塞风险

- 版权音乐不能直接用于 YouTube 盈利。Phase 1/2 优先使用免版税库或 AI 生成。
- 环境音和 BGM 需要精心混音，否则会压过旁白。必须做 loudnorm + ducking。

---

### 模块 4：视觉包装（字幕、标题卡、高亮、颗粒、LUT）

#### 现状

- 已有 ASS 字幕烧录，但样式单一。
- 没有标题卡、章节卡、人物/地点标注。
- 没有统一的色彩风格。

#### 任务拆解

| 阶段 | 任务 | 关键改动 | 依赖 | 验收标准 | 工作量 |
|---|---|---|---|---|---|
| Phase 1 | **字幕样式升级** | 支持 `episodes.subtitleFont/color/size/position`，并增加描边/阴影/背景条，提升可读性。改造 `subtitle.ts`。 | 现有字段已存在 | 手机端和电脑端都能清晰阅读 | S (1–2d) |
| Phase 1 | **标题卡/章节卡** | 在 episode 开头和每个章节切换处插入文字卡片（黑底白字或带背景图），使用 `episodes.title`、`opening_hook`、章节标记。 | 章节分段逻辑（可用 `segment_markers` 或 narrator 输出） | 每集开头有标题卡；长视频每 2–3 分钟有章节卡 | S (2–3d) |
| Phase 2 | **画面标注与高亮** | 对关键物件/人物，用 FFmpeg `drawbox`/`drawtext` 或预先生成的 overlay 加箭头、圆圈、放大框。 | agent 输出高亮区域或人工标记 | 3 个测试镜头有有效高亮 | M (3–5d) |
| Phase 2 | **LUT + 胶片颗粒** | 为不同 `dramas.style` 配置默认 LUT（如 cinematic / anime / vintage / sci-fi），并在 `ffmpeg-compose.ts` 的 `buildVideoFromImage` 中应用；可加轻微 film grain。 | 准备 LUT 文件或 FFmpeg `colorbalance`/`noise` 参数 | 同一题材下所有镜头色调一致；颗粒不刺眼 | S (2–3d) |
| Phase 3 | **动态信息图表** | 对历史时间线、人物关系、地图迁移等，生成简单的动画图表（如时间轴推进、地图点位亮起）。 | 可用 Python Pillow + FFmpeg 或引入 motion graphics 库 | 2 种题材有对应图表模板 | M (5–7d) |

---

### 模块 5：AI 动态镜头的引入时机与成本控制

#### 现状

- `renderMode` 支持 `image_story` 和 `ai_video`。
- `videoPrompt` 已写入分镜，但 `image_story` 模式下未使用。
- `videoGenerations` 表已存在，说明之前有计划做 AI 视频，但链路未跑通或成本高。

#### 任务拆解

| 阶段 | 任务 | 关键改动 | 依赖 | 验收标准 | 工作量 |
|---|---|---|---|---|---|
| Phase 1 | **明确使用策略** | 定义规则：只有 `energy_level=high` 或 `movement` 含“跑、飞、爆炸、水流”等动态词的镜头才生成 AI 视频；其余用 Ken Burns。 | 无 | 文档化规则；单集 AI 视频调用次数可控 | S (0.5d) |
| Phase 2 | **image-to-video adapter 接入** | 接入 1–2 家 image-to-video 服务商（Vidu / Runway / Kling / Pika），复用现有 `videoGenerations` 表和异步轮询模式。 | adapter 注册表已存在 | 能提交任务、轮询、下载、回退到静态图 | M (3–5d) |
| Phase 2 | **首帧/尾帧一致性** | 让 AI 视频的首帧尽量接近已生成的 `firstFrameImage`，避免镜头切换时跳变。 | 需要 reference image 支持 | 3 个测试镜头首尾帧风格一致 | S (2–3d) |
| Phase 3 | **批量成本监控** | 增加 `videoGenerations` 成本字段，按 drama/episode 统计 token/费用；设置单集 AI 视频预算上限。 | DB migration + 账单统计 | 能输出每集视频成本报表 | S (2–3d) |

#### 阻塞风险

- AI 视频目前成本高、一致性差。建议 Phase 2 只做“关键镜头点缀”，而不是全量替换。
- 如果服务商没有 reference image 功能，首帧一致性会差，需要后期做 crossfade 过渡。

---

### 模块 6：按题材定制视听配方

#### 现状

`dramas.genre` 和 `dramas.style` 已分开，但系统没有根据题材自动选择运动、音乐、音效、LUT 的默认配方。

#### 建议配方

| 题材 | 默认风格 | 运动 | 环境声/音效 | BGM 类型 | LUT/颗粒 |
|---|---|---|---|---|---|
| 历史 | realistic / cinematic | 慢速推近、横扫宫殿/战场 | 人群低语、风声、马蹄、金属碰撞 | 管弦乐、民族乐器 | 暖黄/青橙，轻微胶片颗粒 |
| 科幻 | cinematic / sci-fi | 推近到飞船/城市、缓慢平移太空 | 低频 drone、电子蜂鸣、引擎声 | 电子合成器、氛围音乐 | 冷蓝、高对比、去饱和 |
| 神话/奇幻 | fantasy / anime | 环绕式运动、慢速 zoom 到人物 | 雷鸣、风声、魔法音效、兽吼 | 史诗管弦 + 合唱 | 高饱和、梦幻光晕 |
| 太空 | sci-fi / cosmic | 极慢推近星云/行星、横移星舰 | 真空低频、无线电噪声、引擎低频 | 环境电子、管风琴式 pad | 深蓝/紫、高对比、星光颗粒 |
| 深海 | mystery / dark | 缓慢下沉式 zoom、横向扫过海床 | 水压声、气泡、远处鲸歌 | 低沉弦乐、水声采样 | 蓝绿、暗部压缩、微颗粒 |
| 末日废土 | post-apocalyptic | 摇晃 handheld 感、快速 pan | 风沙、金属刮擦、远处爆炸 | 工业噪音、压抑弦乐 | 去饱和、橙灰、粗颗粒 |

#### 任务拆解

| 阶段 | 任务 | 关键改动 | 依赖 | 验收标准 | 工作量 |
|---|---|---|---|---|---|
| Phase 1 | **题材 → 默认参数映射表** | 在代码或配置里建立 `genrePresets`，包含默认 style、LUT、环境声、BGM 风格、运动速度。 | 无 | 6 个题材都有默认预设；新建 drama 时自动带出 | S (2–3d) |
| Phase 1 | **分镜 prompt 注入题材风格** | 在 `storyboard-tools.ts` 的 `readStoryboardContext` 和 agent prompt 中强调 `drama.style` 和 `genrePreset`，让 `image_prompt` / `video_prompt` 自带风格关键词。 | 已完成部分，需补充 `bgm_prompt`/`sound_effect` 也按题材生成 | 抽查 10 个分镜，风格词与题材一致 | S (1–2d) |
| Phase 2 | **按题材选择 LUT/环境音/BGM** | `composeStoryboard` 和 `mergeEpisodeVideos` 根据 `dramas.genre` 自动选择 LUT、环境声、BGM。 | LUT 文件/音频库到位 | 同题材视频风格统一；不同题材切换正确 | S (2–3d) |

---

## 四、整体路线图

### Phase 1：先把“不单调”做到位（约 2–3 周）

**目标**：让 `image_story` 视频具备纪录片基本视听语言。

1. 语义化 Ken Burns 预设 + `motion_json` 可配置。
2. 旁白句子级切镜 + 简单 xfade 转场。
3. 环境音 bed + 点音效混入。
4. 字幕样式升级 + 标题卡/章节卡。
5. 题材默认参数映射表 + prompt 注入。

**验收**：用同一成品稿生成历史/科幻两集，观众能明显听出环境差异、看出镜头运动、读清字幕、章节有卡。

### Phase 2：提升节奏与沉浸感（约 3–4 周）

1. J-Cut / L-Cut 音频跨镜头衔接。
2. BGM 动态映射 + ducking。
3. 2.5D 视差（优先用于 establishing shot 和情绪高点）。
4. LUT + 胶片颗粒统一视觉风格。
5. 画面标注/高亮。
6. image-to-video 关键镜头增强（小批量）。

**验收**：随机 5 集平均观看完成率（或人工评分）较 Phase 1 有提升；音画不同步问题 <3%。

### Phase 3：高级动态与成本可控（约 4–6 周）

1. 情绪曲线驱动剪辑。
2. AI 生成 BGM/SFX。
3. AI 动态镜头批量应用 + 成本监控。
4. 动态信息图表（时间线、地图、人物关系）。

**验收**：单集视频可在 10 分钟内完成从分镜到成片；AI 视频成本可控；信息图表模板覆盖 2 种题材。

---

## 五、关键依赖与阻塞点

| 依赖 | 状态 | 风险等级 |
|---|---|---|
| FFmpeg 支持 `zoompan` / `xfade` / `colorbalance` / `noise` | 已验证 | 低 |
| 免版税/可商用音效库 | 需准备 | 中 |
| 免版税/可商用音乐库或 AI 音乐服务 | 需准备 | 中 |
| image-to-video 服务商账号与 API | 可选，Phase 2 引入 | 中 |
| 图像分割能力（2.5D 视差） | 可选，可降级 | 中 |
| 2.5D 视差/动态图表算力成本 | 可选 | 中 |

**建议先落地的低风险部分**：语义化 Ken Burns、环境音 bed、标题卡、字幕升级、题材映射表。

---

## 六、下一步建议

如果立刻开始，建议按这个顺序：

1. **本周**：做 Phase 1 的语义化 Ken Burns + 字幕升级 + 题材默认映射表。这是改动最小、见效最快的组合。
2. **下周**：加入环境音 bed + 简单 xfade 转场。
3. **第三周**：标题卡/章节卡 + 点音效混入。
4. 完成 Phase 1 后再评估 Phase 2 的 J-Cut、BGM、2.5D 视差的优先级。

这样可以最快让现有 `image_story` 视频从“静态图 PPT”升级到“有基本电影感的纪录片”。
