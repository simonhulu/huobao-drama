# 五格漫画画面语法（Visual Grammar）

## 目录

1. 画面职责
2. 五格渐进页
3. 人物与语义证据
4. 文字层
5. 声音与时间轴
6. 人工验收

## 1. 画面职责

每张图必须证明当前口播的一个具体命题。验收顺序固定为：

```text
人物数量 -> 人物关系 -> 动作 -> 可见情绪 -> 物理证据 -> 构图与风格
```

不能用寺院、佛像、云雾、山水或抽象光影替代本应出现的人物、关系和动作。经文解释也先落到
人的处境：谁在抓取，谁在逃避，谁在施予，行为造成了什么后果。只有纯停顿才使用器物或风景。

生成图片本身必须无文字、字母、字幕、气泡、拟声词、logo、水印和 panel border。

## 2. 五格渐进页

- 一页固定 5 张内容唯一的 16:9 图片。
- 第一格先全屏；新格用 12 帧缓动进入并重排已读格；第五格进入后形成完整页面。
- 当前格保持最大阅读面积，已读格缩小但仍能辨认人物与关键证据。
- 页面铺满 1280x720，不加外框、画布留边、装饰底板或 letterbox。
- 格子之间只保留约 0.7% 深墨色内部 gutter。
- 每 35–50 秒开启新页。页间使用 8 帧墨色 dip，不能叠化两页人脸，也不能形成持续全黑。
- 一张源图只出现一次；路径不同但内容 SHA-256 相同也拒绝。
- 任意 20 秒内必须进入一个新 semantic beat。

布局尺寸必须稳定。气泡、字幕、金句和图片加载不得改变格子大小或引起页面跳动。

## 3. 人物与语义证据

同一人物连续出现时固定：年龄段、脸型、发型、服装主色、一个辨识锚点。第二张起使用前一张已
批准图片作为 `referencePanelKeys` 依赖；引用只能指向更早 panel，所有依赖总数不超过 3。

接触表逐格核对 manifest 的六字段：

- `subject_count`：实际人数一致；
- `subjects`：角色身份和年龄关系可辨；
- `relationship`：亲疏、权力或情感距离能从空间和姿态读出；
- `action`：不是摆拍，而是正在发生的具体动作；
- `visible_emotion`：表情、身体和距离共同支持情绪；
- `visual_evidence`：命题要求的物理证据真实出现在画面中。

画面若证明了另一个命题，不得靠改 semantic 迁就图片；只有新命题仍直接服务同一句旁白且不破坏
连续性时，才允许在冻结 manifest 之前校正。manifest 冻结后，语义不合格只能退回该图。

## 4. 文字层

### 气泡与说明框

- `speech` 只放角色真实说出或忠实戏剧化的短对白。
- `caption` 只补时间、因果、反转或概念标签。
- 每格最多一个，1–24 字；每页通常 3–4 个，不要求五格全有。
- 坐标使用百分比 `x/y`，避开脸、手和 `visual_evidence`。
- 不重复底部字幕，不拿文字补救空洞底图。

### 金句

- 只用于经文原句、核心义理和收尾落点，不是每页固定组件。
- `text` 1–36 字；有明确出处时 `source` 不超过 24 字。
- 金句必须逐字出现在 `narrationText` 和 TTS title 中。
- 出现时压掉同句字幕；背景需保持可读，但不得用圆角黑卡遮住整页。

金句不是一个通用模板，必须先标类型：

| 类型 | 字体与字号（1280x720） | 入场 | 背景与声音 |
| --- | --- | --- | --- |
| `theme` | Ma Shan Zheng 毛笔体；按长度 84/72/60px | Handwrite 定格逐字：首 pose 2 字、其后每 3 帧 +1 字硬切累积（超过 8 字时压帧，总入场不超过 30 帧）；末 pose 后 6 帧淡出并上移 10px | 径向墨幕；首 pose 落定后 2px 金线 4 帧 easeOut 生长，退场前 2 帧收起；`low-temple-bell-v1` |
| `scripture` | Ma Shan Zheng 毛笔体；58/48/42px；出处同族 24px | 每行 4 帧淡入并上移 8px，逐行错峰 3 帧；出处后入；6 帧淡出并上移 10px | 径向墨幕；出处垫 12% 墨色方印底；`clear-chime-v1` |
| `explanation` | Ma Shan Zheng 毛笔体；64/60/56/48px（≤10/≤15/≤24/更长） | 位于画面中下部；4 帧淡入并上移 8px，逐行错峰 2 帧；6 帧淡出并上移 10px | 椭圆墨洗；默认无 SFX |

主题必须像本段的思想落款，经文必须像原文被郑重托出，解释句必须像讲述者把难句说透。三者不能只换字号而保持同一种牌匾样式。禁止 bounce、glow、霓虹描边、粗金框、圆角卡片和整屏金色。

### 字幕

- 字幕来自 `pre_tts_titles_json`，按真实毫秒时间插值到绝对帧；spoken 结束后驻留 0.35s（与下一句间隙不足 12 帧时减半），退场与下一句入场最多重叠 3 帧。
- 使用随包的 LXGW WenKai Screen（霞鹜文楷屏幕优化版）；1280x720 下基准 44px、合成中黑、3px 深墨描边。
- 每句最多 2 个关键词做 InlineHighlight 变色高亮：文字落定（入场或轴转场完成）后 6 帧，金层 #C7A45A 从 0 到 1 叠在常驻暖白层 #F2EAD8 上交叉淡化，关键词由暖白变为金；这是字幕唯一的高亮手段，不扫块、不描金也不划金线。其余文字暖象牙白；关键词按术语 > 否定 > 转折 > 金句短词提取，逐行独立命中，跨行命中自动丢弃。落定后剩余驻留不足以在退场收线前 2 帧完成变色的行整体跳过变色（保持暖白，退场仍走轴转场或 blur-out）。
- 16 个汉字以内保持单行，超过后平衡拆成两行；单行基准 44px，双行上限 40px，左右安全边距各 112px；末行底部钉在 y=570（保 150px 平台安全区）。
- 入场 8 帧：从下方 18px 以 easeOutCubic 上移并同步淡入，无缩放；两行时第二行晚 2 帧入场。相邻句间隙不超过 3 帧时走 SharedAxisZ 句间轴转场：以下一句窗口起点为 te 的 10 帧内，旧句 1→1.15 放大、blur 0→6 失焦并淡出（前 8 帧收净，金色随文字一起弥散），新句 0.85→1 缩放、blur 5→0 升入对焦，两层同轴交叠不换位置；旧句驻留不足 10 帧或新句驻留不足 10 帧加 0.2s 落定余量时回退普通入退场。末句与孤立句退场 6 帧走 blur-out 失焦消散：blur 0→8 同步淡出，退场窗口内末帧精确收净（窗口不足 5 帧的短段回退线性淡出）。缓动克制、无回弹，不能逐字抖动；退场末帧必须干净，残影标准不变。
- 底部使用常驻透明渐隐暗场保证复杂画面上的对比，不使用不透明黑底或圆角字幕胶囊。
- 不能和气泡、金句重叠（金句窗口压掉同句字幕）；文字出现不改变页面布局。

字体文件必须被 renderer 指纹绑定。系统缺字回退、在线字体下载或字体尚未加载就开始渲染都视为失败。

## 5. 声音与时间轴

唯一时序源：

```text
episodes.pre_tts_audio_url
+ episodes.pre_tts_titles_json（毫秒）
-> narrationWindows（绝对帧）
-> panel emphasisStartFrame
-> quote startFrame/durationInFrames
-> subtitles
```

所有帧位使用 30fps，取整容差最多 1 帧。`storyboards.duration` 和字符数量都不能参与渲染时序。

BGM 是一首不少于 180 秒的长音床。props 构建时实测旁白与 BGM LUFS：无声区 BGM 目标低于旁白
约 14 LU，旁白窗口再闪避约 6 dB，循环做 4 秒交叉淡变。素材本身没有声音层。

主题和经文的提示音由本地确定性合成：长度小于 400ms，综合响度至少比旁白低 24 LU，不使用 whoosh。提示音只标记思想落点，不能盖住首字辅音，也不能每句都响。

## 6. 人工验收

### 素材接触表

- 每格直接证明当前旁白，不靠旁白脑补；
- 人数、关系、动作、情绪和物理证据全部一致；
- 连续人物脸、发型、服装和锚点稳定；
- 无错字、水印、logo、畸形手脸、重复人物或无关现代元素；
- 1K 线稿清晰，没有 haze、bloom、soft focus、motion blur 或泥灰暗部。

### 页面静帧表

- 每页首格和第五格都全屏、无外框、无空白边；
- gutter、当前格和已读格层级清楚；
- 气泡避开脸、手、证据和字幕；
- 金句与旁白时刻一致；
- page reset 后没有旧页残影；
- 所有文字完整显示，没有溢出、遮挡或缩到不可读。

文字审查不能只看缩略接触表。必须打开对应的 1280x720 原始帧，检查：

1. `theme` 入场、稳定、退场，含 Handwrite 定格 pose 帧（`quote:handwrite-pose`）与金线生长帧（`emphasis:theme:underline-grow`）；
2. `scripture` 入场、稳定、退场，且出处层级明显更低；
3. `explanation` 入场、稳定、退场；
4. 普通字幕一行样本和最长的两行样本，含关键词变色中帧（`subtitle:inline-highlight`）、变色落定帧（`subtitle:inline-highlight-settled`）、句间轴转场帧（`subtitle:shared-axis-z`）与 blur-out 退场中点（`subtitle:blur-out-exit`）；
5. 金句开始和结束两侧，普通字幕没有双层叠字或一帧闪现。

参数、文件 SHA 和渲染成功日志都不能证明美观。只有实际帧中字号、对比、层级、节奏和避让同时通过，才允许 Agent 批准。

退场样本固定抽取金句最后一个可见帧，而不是淡出开始帧；最后一帧仍有明显灰字、旧背景或双层文字即判失败。

任何人工门禁失败，都回到最早失败对象。不得先渲正式视频再用视频寻找本可在静帧发现的问题。

## 7. 文字层渲染链路（dharma-text-v5：Remotion 文字叠加层）

第 4 节描述的字幕与金句视觉全部由 Remotion composition `DharmaTextOverlay`
（`remotion/src/DharmaTextOverlay.tsx`，1280x720@30fps 透明背景）真渲染，生产链路：

```text
build-props：主 props（textLayers='overlay'）
  + overlay props 显式落盘（data/temp/<slug>.overlay-props.json）：
    subtitles[].displayStartSec/displayEndSec/subtitleKeywords
    quotes[].startFrame/durationInFrames（overlay 侧不允许现算兜底）
render-candidate（pipeline renderOverlayCandidate 统一编排）：
  1. native-comic-v12 → plate 底片（data/temp/<slug>.native/plate.mp4，
     不含 subtitle/emphasis 文字层，result.json 绑定底片字节）
  2. npx remotion render DharmaTextOverlay --sequence → 透明 PNG 序列
     （data/temp/<slug>-overlay-sequence，仓库内 chrome-headless-shell，
     FontFace+delayRender 加载三个随包字体，任一失败 cancelRender）
  3. ffmpeg 底片+序列 overlay、音轨 copy → candidate.mp4
     + 合成记录（candidate.mp4.composite.json）
```

### 指纹与缓存

- 底片 interval 指纹只绑定画面输入（panel 资产、bubble 字体），不绑文字层：改文字不重渲底片。
- overlayFingerprint = sha256(TEXT_OVERLAY_VERSION + composition id + overlay props SHA-256
  + MaShanZheng/LXGWWenKaiScreen/NotoSerifSC 三个字体 SHA-256)；指纹文件与 PNG 帧数
  同时命中才跳过 Remotion 重渲：换画面不重渲文字层。
- 合成记录绑定 plateSha256 + overlayFingerprint + candidateSha256 + 帧数；恢复判定
  （readOverlayCompositeEvidence）逐环对照当前文件字节，任一失配整链判陈旧并触发对应阶段重跑。

### 失败行为（显式报错，无静默回退）

- overlay props 缺 display 窗口、subtitleKeywords 或金句帧窗口 → build-props 失败；
- chrome-headless-shell 缺失、Remotion 非零退出、PNG 帧数与 props 时长不符、
  字体加载失败 → render-candidate 失败；
- ffmpeg 合成非零退出或合成帧数不符（合成按 expectedFrames 显式截断，底片帧不足仍判失败）
  → render-candidate 失败；
- overlay 序列目录含点段（如 .tmp）→ 显式拒绝（Remotion CLI 会把点段误判为扩展名）；
- 任何失败都不允许回退 ffmpeg 仿制文字层；v4 半成品（renderer 内 InlineHighlight/
  SharedAxisZ/Handwrite 代码）冻结保留，不在生产路径。

## 8. history 工厂接入差异（已接入，差异为契约级有意取舍）

history 工厂（remotion-history-factory）已接入本链路：复用同一
`DharmaTextOverlay` composition、`dharma_text_overlay_stage.mjs` 编排函数
（renderTextOverlaySequence/compositeTextOverlay/overlayFingerprint/
readOverlayCompositeEvidence）、同一 plate + Remotion overlay 序列 +
ffmpeg 合成生产形态与指纹缓存契约。与 dharma 的剩余差异是**有意的契约级
取舍**，不是未对齐项：

| 契约点 | dharma（本链路） | history（已接入） |
| --- | --- | --- |
| 字幕 display 窗口 | splitSubtitle + computeSubtitleDisplayWindows 显式落盘 | 同款：自有 splitSubtitle 出 spoken 窗口 + 同一 computeSubtitleDisplayWindows 显式落盘（check_dharma_sync 独立重算通过） |
| subtitleKeywords | extractSubtitleKeywords 规则提取描金 | 恒为空数组：历史叙事不做 InlineHighlight 描金，overlay 只出暖白楷体字幕层（契约字段仍在，缺字段仍 fail） |
| quotes | theme/scripture/explanation 三类金句 | 恒为 []，overlay 金句层不出现 |
| textPresentationVersion | dharma-text-v5 | dharma-text-v5（与 core TEXT_PRESENTATION_VERSION 同源导入，过 native-comic-v12 渲染门） |
| 渲染编排 | plate + Remotion overlay 序列 + ffmpeg 合成 | 同一编排：history_comic_pipeline 导出 renderOverlayCandidate，render-candidate/recover-candidate 走同一三环证据链（plate result + 序列指纹 + 合成记录） |

history 侧 props/overlay props 由 buildProps 显式落盘
（history-comic.overlay-props.json），subtitle 自带 display 窗口与空关键词
数组；缺 display 窗口或 subtitleKeywords 字段时 buildOverlayProps 同样显式
失败，overlay 侧不允许现算兜底。e2e 验收（episode-787 冻结资产子集，
data/temp/history-text-overlay-e2e/run-e2e.mjs）：楷体落定整行暖白无金字、
SharedAxisZ 句间转场弧线、末句 blur-out、净帧、五格底片版面无损。
