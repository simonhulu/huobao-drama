# DharmaEpisode 画面语法（Visual Grammar）

`DharmaEpisode` 合成的契约与画面规则。渲染层代码：`remotion/src/DharmaEpisode.tsx`；
props 构建：`backend/src/services/dharma-props.ts`。

## 分层结构（从底到顶）

```text
视觉段落层（video / image，绝对帧位 + 氛围慢叠化 / 人物 dip-to-ink）
  -> 语义叙事层（人物、关系、动作、可见情绪与 visual_evidence）
  -> 静室质感层（柔和压暗 + 暗角）
  -> 静室边框层（深墨青、极细旧金轨道、顶部小灯标记）
  -> 标题 / 金句层（象牙色衬线大字）
  -> 字幕层（全局分句，底部居中）
声音层：narration master（唯一人声声源）+ 长 BGM（实测响度定标、闪避、交叉循环）
```

视觉 profile 为 `emotion-arc-v1`。它以水墨意境为底色，在心理拆解处切入超现实梦境，
在顿悟时刻切入极简光影；借鉴“中心金句 + 边框 + 小出处”的层级，但不复制任何
对标账号的佛像、月亮、账号标识或插画。`Noto Serif SC` 粗体随 Remotion 素材打包，
避免依赖渲染机系统字体。

**视频素材一律 muted**。人声只来自 narration master。这是设计决定，
不是 bug——不要给视频"修复"声音（历史工厂反向踩过这个坑：它的 Video 层
故意放原声，本管线故意静音）。

## 段落与叠化

- 段落 = 相邻同素材、同情绪、同风格、同运镜分镜的并集。AI 生成任务写回同一张图时，
  props 会把其连续分镜合并成一个完整 Ken Burns 段落，不按每个 storyboard 重启动运镜。
- 氛围段落提前 24 帧（0.8s）挂载、不透明度 0→1 爬坡，与 outgoing 形成真叠化。
- 两张人物叙事插画相接时禁止真叠化：在边界前后各 8 帧使用 `dip-to-ink`，暗处完成画面切换，
  避免两组眼睛、鼻子和嘴同时出现。**两种转场都不移动任何旁白边界**。
- 首段落自黑场淡入 18 帧。
- **全片无裸硬切**。禅意内容的剪辑节奏是流动。如果某处需要"顿一下"，
  用更静的素材表达，不要用切断表达。
- 单段落时长建议 8–30s：短于 8s 显得碎，长于 30s 视觉疲劳
  （除非素材本身有丰富的内部运动，如云层 timelapse）。

## 视频段落参数

| 参数 | 来源 | 说明 |
| --- | --- | --- |
| `sourceStartSec` | 指派 video.sourceStartSec | 跳过素材开头的废帧；构建时自动前移保证尾段不超出素材 |
| `playbackRate` | 构建时计算 | 素材偏短时的慢放比（0.6–1）；素材够长恒为 1 |
| `focusX/focusY` | 指派 | objectPosition 百分比，调整 cover 裁剪的视觉重心 |
| `grade` | 指派 | 调色预设，见下 |

调色预设（克制方向，默认 neutral 即不调）：

| grade | 效果 | 适用 |
| --- | --- | --- |
| `zen_muted` | 降饱和 0.72 + 微对比 + 微降亮 | 默认首选，统一不同来源素材的气质 |
| `ink_dark` | 半饱和 + 强对比 + 降亮 | 困境/悬念段 |
| `warm_dawn` | 微暖 sepia + 微提亮 | 结尾祝福段 |

同一剧集尽量全片统一一个 grade（推荐 `zen_muted`），结尾段可切 `warm_dawn`
做情绪落点。不要每段换一个——那就成了滤镜展示。

## AI 关键情绪镜头与 Ken Burns

- AI 静态图首先是语义叙事插画，其次才是情绪镜头。人物、关系、动作或 `visual_evidence`
  变化就必须切换到新图；不能因为风格相同而跨语义复用。目标覆盖全片真实 TTS 时长的 35–65%；动态视频仍须
  至少覆盖 10%，用于运动衔接和呼吸。两者共同组成 hybrid，不把任何一方铺满全片。
- Ken Burns 运镜 ∈ push / pull / hold / drift_left / drift_right。push 用于好奇与冲突，
  pull 用于接纳和释然，hold 专供金句/顿悟，左右漂移用于水墨段的缓慢游目。
- `hold` 必须真正静止；其余运动只使用 transform 与 opacity。不得用逐帧 blur、Canvas
  粒子或高成本 shader 换取“氛围”，避免放大 Remotion 帧渲染成本。
- 三种 treatment 均为轻量 CSS：`ink_wash`（宣纸/墨色层）、`surreal_dream`
  （克制的暗部与异色光）、`minimal_light`（单束光和大留白）。风格由段落 `styleId`
  决定，不允许全片套同一滤镜冒充情绪弧线。
- Remotion 只负责 Ken Burns、叠化和文字层，不负责把错误图片“做对”。接触表看不到 semantic
  里的强制证据时，在渲染前重生图片。

## 标题与金句

- **开场**：用 `episodes.title` 做 2–3 秒的安全标题式 invocation；不得读取旧
  `opening_hook`，它可能属于重写前的另一篇故事。开场必须是 `curiosity +
  dharma-surreal-dream-v1`，可以使用视频，也可以使用从第 0 帧就有主体且立即开始
  push/drift 的 AI 图。
- **金句**：不是圆角黑色弹窗。金色只用于细线和边框，正文是带深色描边的象牙色大衬线字；
  出处以小字放在下方。文本长度决定字号，短句应有真正的中心重量。
- 有明确 `source` 的经文首次揭示可以在当前情绪风格中出现，但底图必须是可信 AI 图且运镜
  `hold`；没有出处的普通金句仍只属于 `insight + 极简光影 + hold`。
- 金句出现时隐藏底部字幕，避免同一句话在屏幕上重复两遍。
- 开场标题与金句属于同一层级；若首个金句进入开场窗口，标题必须在金句前完整退场。
  不足 1.5 秒的标题直接不显示，宁可留白，也不能在中心堆两层大字。
- 进场 16 帧淡入上移，出场 14 帧淡出。
- 锚定：用 quote 文本在该分镜 TTS 字符区间中精确定位；只在旁白念到这句话前约 0.45 秒淡入，
  念完后保留约 1.6 秒呼吸。不得覆盖整个分镜或隐藏无关字幕。
- **纪律**：一篇 8–12 分钟的稿子 3–6 张。只给：经文原句亮相（必须带 source）、
  情绪核爆点（父亲的話、佛陀的回答這種）、收尾金句。概念翻译、生活映射、
  CTA 一律不配卡。
- 卡文 ≤ 24 字最佳；超过 36 字考虑只取半句。出处只标经文原句，个人转述不标。

## 字幕

- 全局分句（按 `，。！？；：、` 切分，≤3 字碎片并入前句），绝对秒时间轴，
  主时间轴插值；底部居中、象牙文字、无圆角的平直 lower-third wash、每句 9 帧淡入上移。
- 字幕与旁白不同源是**数据事故**：回到 `check_dharma_sync.mjs` 和 TTS 链路修，
  不在渲染层调。

## BGM（长音床内混）

- props builder 用实际 narration / BGM 的 `loudnorm` 首遍结果计算音床目标：BGM 在无声
  间隙约低于旁白 14 LU，旁白窗口内再降低约 6 dB。**没有固定 `0.14`。**
- 单条 BGM 至少 180 秒；短 loop 不得作为 8–12 分钟成片的音乐床。跨循环用 4 秒交叉淡变，
  不使用 `<Audio loop>` 的硬切循环。
- BGM 曲源太安静、需要超过 0.5 倍增益才达目标时拒绝；热母带会被自动降低。每次 props
  构建把实际 gain、目标响度和曲源时长记录进任务事件。
- 输出即交付：没有 ffmpeg 后混阶段。平台要求另有响度规范时，再加可验证的终混 QC，
  不要回到“固定增益”模式。

## 明确禁止（与历史管线的刻意差异，不要"移植"回来）

- 无镜头标题、无序号、无 InfoGraphic（bignum/trend/card）；
- 无硬切、无 whip/动态转场、无画面震动；
- 无机械逐镜图；连续人物保留轻量身份锚点，但不导入 grid 的完整叙事层级；
- 无 SFX 层、无视频原声；
- 无按字数比例估算的任何时序。

## Props 契约（buildDharmaProps 输出）

```json
{
  "durationInFrames": 16200,
  "audio": "dharma-ep1/audio/master_narration.wav",
  "audioStartFrame": 0,
  "bgm": {
    "src": "dharma-assets/<content-identity>.mp3",
    "volume": 0.367,
    "narrationVolume": 0.184,
    "fadeInSec": 3,
    "fadeOutSec": 5,
    "loopCrossfadeSec": 4,
    "sourceDurationSec": 500.6
  },
  "segments": [
    { "kind": "video", "src": "dharma-ep1/video/seg1.mp4",
      "startFrame": 0, "durationInFrames": 540,
      "sourceStartSec": 2, "playbackRate": 1, "grade": "zen_muted", "theme": "山间迷雾",
      "emotion": "curiosity", "styleId": "dharma-surreal-dream-v1", "treatment": "surreal_dream" },
    { "kind": "image", "src": "dharma-ep1/image/seg7.png",
      "startFrame": 5400, "durationInFrames": 300, "move": "hold",
      "emotion": "insight", "styleId": "dharma-minimal-light-v1", "treatment": "minimal_light" }
  ],
  "quotes": [
    { "text": "应无所住而生其心", "source": "《金刚经》",
      "startFrame": 1230, "durationInFrames": 150 }
  ],
  "subtitles": [ { "text": "你有没有发现，", "startSec": 0.5, "endSec": 2.1 } ]
}
```

上面的 `volume` / `narrationVolume` 是 Episode 693 的实测示意（`Venus` 约 -33 LUFS、
旁白约 -28 LUFS），**不是固定常量**；任何新片都必须重新测量后由 props builder 生成。
