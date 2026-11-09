# 全画幅逐镜精修

适用：历史工厂自动交接，或用户要求已有视频加入精细文字、人物情绪动画和声音设计。使用一镜一幅完整场景，不做五格、拼页或静止贴纸。以下命令均从项目根目录运行。

## 1. 锁定本集素材与时间

```bash
node .codex/skills/videoeditor/scripts/inspect_episode.mjs \
  'http://127.0.0.1:3013/drama/DRAMA/episode/NUMBER' \
  --output data/temp/本集新版本/source.json
```

先把占位路径替换成真实 ID 和新版本目录。URL 中的 episode number 不是数据库 episode ID，以 inspector 结果为准。新稿由 history factory 的 `history_intake.mjs --source-only` 准备；交接后继续本流程，不重建五格项目。

通过 `GET /api/v1/episodes/<真实episodeId>` 取 `pre_tts_audio_url` 与 `pre_tts_titles_json`，将后者解为数组，保存成 `titles.json`。格式为 `{text,time_begin,time_end}`，单位毫秒。保留完整 API 快照、确认正文和素材哈希。远端图片/音频下载到本集本地工作目录，确认不是 HTML 错误页。

选用与 titles 对应的干净旁白母带，不从带旧音效/BGM 的成片再次叠音。不因精修改词、改速或重配音。如果只有混音成片，不能宣称已经去掉背景音乐；继续可独立进行的画面检查，并明确缺少干净母带。

底片合并使用 AAC 包复制。如果源为 WAV/MP3，将已有音频转一次 AAC，冻结原文件与转换结果 SHA；不重复转码或重生成：

```bash
ffmpeg -v error -n -i /绝对路径/原旁白.wav \
  -map 0:a:0 -c:a aac -b:a 128k /绝对路径/旁白母带.m4a
```

编译器要求旁白和分镜文字按顺序逐字覆盖，允许标点空白差异；对不匹配先查明版本，不能用截断或模糊匹配蒙混通过。分镜边界优先用真实 titles 边界；句内按字数插值只是估算，必须标注并检查触发点。不得把估算说成逐字对齐。

## 2. 每镜写编辑判断

逐镜检查原图、旁白、场景/动作说明，再写 `decisions.json` 数组。长片可按连续段落分批检查，最终每镜必须有记录。`visualEvidence` 写实际看见的人物位置、视线、头部空间和道具；`intent` 写希望观众理解或感受到什么；`rationale` 解释为何在此处动、或为何留白。不能只从旁白关键词猜人物坐标。

默认 1920×1080、30fps、16:9 源图。其他比例先设计适当取景，不让当前底片缩放把人脸拉伸。基础运镜支持 `hold/push/pull/pan-left/pan-right`，`amount` 为 0–0.045，hold 为 0。让动作集中在信息发生处，构图本身够清晰时可以全镜静止。不要为了“精细”强行推拉摇移。

普通底部字幕负责听读；画面大字负责重点；人物反应负责情绪。三者分别安排，不能把整句旁白同时塞入三层。标题贴合语义，避免擅自把未证实的推论写成史实。

| 表达目的 | 已有动画组件 | 可见的动作与声音落点 |
| --- | --- | --- |
| 想不通、脑中打结 | `reaction-confused` | 乱线持续重绘、方向变化；声音跟混乱加剧处 |
| 紧张、尴尬 | `reaction-sweat` | 汗滴长出、挤压、错峰滑落消失；滴落配轻短音，第二滴可更轻 |
| 思考、试探 | `reaction-thought` | 小泡依次长出、主泡展开、轻呼吸；音型起点贴泡出现 |
| 警觉、震惊 | `reaction-alert/shock` | 短促张开、回弹、放射线消退；冲击音贴爆发帧 |
| 生气、压抑 | `reaction-anger/gloom` | 怒筋收紧/蒸汽脉冲，或压力线下垂；按剧情选声或安静 |
| 突然想到 | `reaction-idea` | 光点错峰闪烁、短亮后收；亮音保留自然尾巴 |
| 信息揭示 | `title-ink`，`motion:brush` | 笔画/遮罩依次揭示，重点字二次强调；擦笔音跟实际揭示 |
| 结论落地 | `title-ink`，`motion:stamp` | 大字压入、短回弹、稳定阅读、收场；重音贴落版而非先响 |
| 章节/书卷信息 | `title-scroll` | 展开、保持、收起；纸声跟展开动作 |
| 指认物件、关系 | `prop-ring/underline/connector` | 线条描出后保持；有必要才配轻点/擦动 |

动画实现位于 `remotion/src/ReferenceEditorialOverlay.tsx` 和 `reference-editorial-core.ts`。全部由 Remotion 帧时钟控制，包含入场、内部运动、阅读停留、退出。不要只给静态 SVG 加透明度。新情绪可以扩展组件；现有词表不是必须轮流用完的套餐。

头部反应用 `space:"image"` 跟随图片运镜，归一化坐标范围 0–1；标题通常用 `space:"screen"` 固定在画面空区。检查帽冠、眼睛、手、关键道具和底部字幕的避让。图像翻转/裁切后必须重新核对坐标。

大字先排版再做动画：层级清晰、用词短、重心稳定，关键字才用对比色与第二次落点。毛笔字体是当前历史画风的默认候选，不能只换字体就算字体动画。用户要求复刻参考时，量出参考的字重、描边、影子、入场方向、速度曲线、停留与退出；只复制这些风格机制，不假称现有预设已经 1:1。

以下示例只说明字段，不能直接套坐标/时间；每镜填实际观察结果。所有事件帧号是镜头内帧号，`endFrame` 不含该帧：

```json
[
  {
    "storyboardNumber": 1,
    "intent": "表现人物迟疑",
    "visualEvidence": "人物在画面右侧，帽冠上方有空白，左侧是书案",
    "rationale": "在反问出现后让头顶乱线动起来，结论处收走，不盖住表情",
    "camera": {"mode":"hold","amount":0,"focusX":0.5,"focusY":0.5},
    "effects": [{
      "id":"hesitation", "kind":"reaction-confused", "space":"image",
      "x":0.62,"y":0.08,"width":0.16,"height":0.13,
      "startFrame":30,"endFrame":90,"trigger":"他迟疑了",
      "timingEvidence":{"method":"titles 句首时间，已对照音轨核对"}
    }],
    "audioCues": [{
      "kind":"confused","frame":37,"gainDb":-11,"effectId":"hesitation",
      "reason":"乱线第一次收紧时加入短眩晕音，随后留白",
      "timingEvidence":{"method":"动画入场后第7帧，与该音效有效起音对齐"}
    }]
  }
]
```

不加动画/音效的镜头写空数组，并在 `rationale` 说明原因。哀悼、绝命诗、纯史料和需要观众自己体会的段落可保持克制。不用“每 N 镜一个效果”或效果总数作为完成标准。

## 3. 选声音并冻结素材

本用户已明确授权 `/Users/mac/Downloads/2174款剪映音效库`，不重复索要授权。候选入口是 [local-sfx-palette.json](local-sfx-palette.json)，选中了才用，不默认全部加载。用户此前认可的是该本地库版；Kenney 游戏音效不是本流程的备用素材。

先听候选的音色、有效起音、时长与衰减，再结合声画选取。文件名/分类不能替代试听；扩展名可能与真实编码不同，用 ffprobe 验证。头部静默可裁；不硬砍尾音来塞满短镜头。长音不适合就换短音或留白。不要按“钱、奏折、门”等词机械加拟音，历史人物情绪也不等于到处用搞笑声。

```bash
node .codex/skills/videoeditor/scripts/build_sound_catalog.mjs \
  --roles confused,sweat,brush \
  --output-dir data/temp/本集新版本/sound-selection
```

辅助程序只冻结所选原文件、SHA、来源与初始音量到 `sound-assets.json`，不会自动安排落点。候选不适合时，可通过 `--palette` 传入同结构、人工选择的本地音效清单；换库用 `--library-root` 并记录当前适用的授权依据。

混音按有效段 RMS 校准，默认 -18dBFS、素材峰值上限 -3dBFS，保留动态和立体声。cue 的 `gainDb` 是随后叠加增益，不等于最终 LUFS；通常从 -6 至 -12dB 听起，必要时再降。默认只让 SFX 在旁白下避让，旁白不被抽吸。最多两条局部音效并发；不要做连续循环底床或每个字都“叮”。无 BGM。

## 4. 编译、渲染、交付

### 上传编码与体积验收

新成片和带声精选默认采用 `scripts/videoeditor/upload_encoding.mjs` 的 `history-upload-h264-v1`：软件 `libx264`、CRF 24、slow、yuv420p、VBV 峰值 2000kbps/缓冲 4000kbit、GOP 150；新 AAC 转换/混音用 128kbps。保留 1920×1080、30fps、全部字幕/动态层和原旁白时间，不降尺寸/帧率、不默认转 H.265/AV1。已有冻结 AAC 在干版拼接时仍包复制，不为了省音频再转码。

参数由编译器冻结进 base/root 两份 `plan.uploadEncoding`。实际出口已接通：`reference_edit.mjs merge` 在拼接最终画面时直接做一次上传编码，不再将高码率镜头流直接复制为交付成片；`fine_edit.mjs compose` 在叠加时直接用同档位。单镜底片和透明/合成中间资产不等于交付文件，不必用上传码率限制它们；`editorial_sfx` 仍复制视频，仅编码最终音轨。不要在完整交付后另加一次整片压缩。

完整 Remotion composition 接通时，把同一冻结配置映射到 `renderMedia()`：`codec:'h264'`、`crf`、`x264Preset`、`hardwareAcceleration:'disable'`、`encodingMaxRate:'2000k'`、`encodingBufferSize:'4000k'`、`gopSize:150`、`pixelFormat:'yuv420p'`。CRF 不与 `videoBitrate` 或硬件编码混用；Node API 要显式传参数，不能仅修改 CLI config。既有硬件字幕专用 worker 的验证合同不因此自动迁移。

全片前对实际复杂插画/小字字幕/动态标题/运镜选择代表短片，以同一 `uploadVideoArgs()` 编码，检查原尺寸截图和连续运动；有 VMAF 时以抽样约 93 以上作为候选参考，不能代替中文字幕笔画、边缘振铃、渐变色块和动效阅读检查。含 GOP 150 的完整默认档位在 18 秒历史插画样本上约 1.78Mbps、VMAF 抽样 94.1，仅是起点，不是所有故事的画质保证。

目标约 10–15MB/分钟（15 分钟约 150–225MB，46 分钟约 460–690MB）。最终以真实 `bytes / duration` 检查，默认预算上限 17MB/分钟，加 0.5MB 启动/封装余量；VBV 限的是短时码率，不保证精确文件大小。合并/合成写 `upload-encoding-report.json` 和 `delivery.json.uploadEncoding`，记录生效参数、字节数、平均总码率及预算状态；音效报告和最终交付报告保留这份证据。超预算不能标完成/上传，混音后再查最终文件，不能只测干版。

如果小字/地图等不通过，先用 CRF 23/22 重测，必要时提高峰值；把参数和具体画质原因写为 JSON，通过编译器 `--upload-encoding reviewed-encoding.json` 编译到新版本目录，不手改已冻结计划。非默认配置必须有 `reason`，提高体积预算也须说明实际画质证据并在交付中披露；不能盲目加 CRF、伪造达标或无说明恢复 6.5–7Mbps。原片不受此新制作规则批量重编码。

### 字幕最终出口

生产目标是完整视频 composition 通过 Remotion `renderMedia()` 直接成片，不得把整片导出为 PNG 序列后再由 FFmpeg 二次合成。只为独立动画素材渲染透明片段时，允许按镜头输出 ProRes 4444；这不等于允许用逐帧图片作为整片中间格式。

已验证的字幕专用渲染器为 `scripts/videoeditor/history_caption_worker.mjs`，使用隔离的 Remotion 4.0.534 runtime。它只处理传入的底片与 caption props；底片不得预先烧录同一字幕。通过条件是结果 sidecar `status=validated`、帧数/尺寸/fps/时长和音轨匹配、`sharedMemoryUsed=true`、实际硬件 H.264 编码器有证据。它没有验证 GPU 绘制；不要把硬件编码写成硬件绘制。

完整历史精修目前尚未普遍接通这个字幕出口：`fine_edit.mjs base` 当前会把逐镜 ASS 字幕烧进底片，而 `HistoryCaptionDirect` 不包含 `ReferenceEditorialOverlay` 的动画层或 SFX。只有在输出分辨率、帧率、样式和全部画面层已进入目标 composition，并准备了无重复字幕的干净底片时，才可调用字幕专用 worker。其整片验收目前限于 1280×720、30fps episode 1044；其他规格须先验证字体、字幕边界、画质/码率、内存、编码器和音频同步。未完成接线前，不得宣称本精修流水线已统一采用该出口或用它跳过现有动画/声音步骤。

输出 sidecar 和 worker 监督记录与 MP4 一起保留。若没有生效共享内存或硬件编码、验证失败、进程清理不完整，任务必须失败并保留证据，禁止静默降级成整片 PNG 序列。字幕渲染后再按本节音频合同复制或混音；有 SFX 时确认最终混音只改音轨且不重编码视频。

```bash
node .codex/skills/videoeditor/scripts/build_refined_plan.mjs \
  --snapshot data/temp/本集新版本/source.json \
  --audio /绝对路径/旁白母带.m4a \
  --titles data/temp/本集新版本/titles.json \
  --decisions data/temp/本集新版本/decisions.json \
  --sound-assets data/temp/本集新版本/sound-selection/sound-assets.json \
  --output-dir data/temp/本集新版本/render --stem episode-ID-refined-v1

node .codex/skills/videoeditor/scripts/validate_edit_plan.mjs \
  data/temp/本集新版本/render/snapshot.json \
  data/temp/本集新版本/render/edit-plan.json

node scripts/videoeditor/fine_edit.mjs base data/temp/本集新版本/render/base
node scripts/videoeditor/reference_edit.mjs stills data/temp/本集新版本/render
node scripts/videoeditor/reference_edit.mjs render data/temp/本集新版本/render
node scripts/videoeditor/reference_edit.mjs merge data/temp/本集新版本/render \
  data/static/merged/episode-ID-refined-v1-dry.mp4
node scripts/videoeditor/editorial_sfx.mjs mix data/temp/本集新版本/render \
  data/static/merged/episode-ID-refined-v1-dry.mp4 \
  data/static/merged/episode-ID-refined-v1.mp4
node scripts/videoeditor/sound_edit_delivery.mjs data/temp/本集新版本/render
```

无音效决策时省略 `--sound-assets` 和 mix，直接把 merge 结果作为最终文件，另从真实成片提取带原声精选。全片无动画时跳过 stills（空接触表没有意义），render 仍会写供 merge 验证的空清单。

编译器输出镜头 ASS、计划、输入哈希、原始和时间对齐后的 snapshot。校验使用 `render/snapshot.json`；`source-snapshot.json` 留作原始证据。累计帧守恒，绝不让每镜独立取整造成长片漂移。每镜都要 decision，缺图须补齐或明确选择合适替代，不能跳镜导致丢旁白。

**底片目录一定是 `render/base`，动画合成目录是 `render`。** 两个执行器都写 `shots/`，若混用同一目录，会覆盖底片或重复叠加。全程使用新版本目录和唯一成片文件名；改变决定后重编到新目录，不手改某份计划造成 base/root 两份失配。merge/mix 拒绝覆盖已有成片。

stills/render 支持末尾加 `1,8,12` 做代表镜头检查；全片 merge 前仍须不带子集再执行 render，生成完整 `overlays.json`。静态图检查构图；运动质量必须看连续帧和视频。先解决重叠/字体/运动问题，再出全片，正常制作无需人为审批关卡。

`sound_edit_delivery` 读取计划与 `sfx/mix-report.json`，输出 `*-highlights.mp4`、`*-review.html`、`delivery.json`。默认选部分有变化镜头；精心选过的 `highlightShots` 更好，应覆盖代表动作、文字、声音与安静段落。可在渲染前计划中设置 `deliveryLabel/soundSummary`；`comparisonFile` 可省略，有值须为同一输出目录中真实存在的 MP4 文件名，配 `comparisonLabel`。不虚构上一版。打包不是审美验收通过。

本执行器依赖此工作区已安装的 Remotion、FFmpeg（中间底片需 VideoToolbox，上传出口需 libx264）、headless Chrome 和本地字体。迁移环境先检查依赖；不下载不明 Lottie 素材或临时联网渲染。需要 Lottie 时先保存素材和授权依据，再用帧时钟确定性驱动，遵循同一时间与坐标合同。

## 5. 验收与复现证据

- 技术：完整帧数/时长，干版旁白包哈希一致，混音版视频包哈希一致；检查音频峰值、响度、有效起音和自然尾巴。输出均为 1080p H.264/AAC，可通过本地 `/static/merged/` 访问。
- 画面：头顶乱线要在连续帧中变形，汗滴要落下，大字应能看出入场、保持与退出。检查头/帽、字幕遮挡、标题安全区、画面运镜和动画位置是否一致。
- 声音：真实播放代表片段，核对反应重音、大字落版、纸页展开的同步，听旁白是否被掩盖、同类音色是否机械重复、安静处是否被噪声填满。不要以“数量多”或“响度合格”代替听审。
- 交付：完整视频、带声音精选、review 页、`edit-plan.json`、`sfx/provenance.json` 和 QA 记录。可用 `check_video_playback.mjs URL 输出目录` 测不超过约80秒的精选是否解码/卡顿；该工具静音播放，不能据此声称听审通过。

QA 记录写清检查镜头/时间、连续帧证据、播放方式和未核验内容。工具不能实际听音时明确标注，仅提交测量与可播放试听，不捏造“已连续听完全片”。不把旧项目的镜头编号、情绪密度、配音错字或图片文字错误当成通用模板。

可选风格研究资料在 `docs/video-editing/`；实际实现优先阅读当前组件、执行脚本和本参考。已有 v7 项目是示例而非运行依赖，清理它的临时目录不应破坏新作品。
