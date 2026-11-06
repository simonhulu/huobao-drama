# Storyboard Continuity Design (叙事画格连续性原则)

来源：用户提供的 3 个高质量动作分镜参考（Suzune 斩杀坠落生物 / Raby 废墟跳跃追猎 /
浪人斩机械军团）。这些参考共同定义了「让镜头不割裂、接近视频感」的分镜设计方法。
本文件是 v8 / 叙事画格生产在「设计阶段」必须遵循的规范。

## 两阶段模型

1. **设计阶段（联系表 / 分镜设计）**：产出一张有序的、单色线稿联系表。
   - 每个 Panel = 一个**视觉 BEAT（动作路点）**，按 `P01…P09` 顺序编号；
     当 Event 超过 9 个 Panel 时，继续编号为 `P10…P18`，可拆分为多张 continuation sheets。
   - 每格抬头：`P## / 相机角度 + 景别 / 主体 + 状态`，例如
     `P03 / low angle + medium shot / archer draws bow`；不含运动词。
   - 留白/分隔清晰，顺序与数量优先于排布密度。
2. **成片阶段（连续运镜）**：联系表是**一镜到底的主镜头有序关键姿势**，
   无停顿、无切、无重置、无瞬移；运动穿过每个接触点；VFX 绑定在接触点。

我们管线的对应：设计→`storyboard_panels`（Beat），生图→逐 Panel 成品图，
成片→`grid.episode_videos` + `grid.episode_render`（Remotion 连续运镜）。

## 连续性锚点（每个 Sequence 内必须守住）

- **人物恒定**：面孔、年龄、发型、服装、已有道具在同一 Sequence 内完全一致；
  只允许改变景别、角度、机位、运镜、动作、表情、走位、前景遮挡、对焦。
- **复现物体追踪**：反复出现的物体/敌人必须有**可区分的持久身份**
  （参考："four rocks stay distinct"、"C2/C5/C6 are separate Razorclaws"、
  "R2 Razorwing stays ahead in the open down-right corridor"）。不得混同或凭空替换。
- **屏幕轴线一致**：同一 Sequence 内人物左右关系、运动方向、镜头轴线不跳轴；
  跨格只能用连续运动改变机位，不能硬切翻转。
- **发展式运镜轨道**：景别/角度按「建立→发展→转折→落点」**有意变化**，
  但整体是一条连续发展轨道（参考 "developing track" / "one forward handoff"）；
  用同一支虚拟镜头，不在格间跳变。

## 动作 / 战斗分镜

- 每个 Beat 只承载**一个攻击或闪避目标**；在一个 multi-waypoint Beat 内，所有 waypoints 必须共享同一目标。
- 定义**接触路点**（刀/枪接触点）与**顺势连贯**（"carry-through"）：上一格的动作
  动量带入下一格，不重置姿态。
- 禁止：停顿（hold）、命中定格（hit-stop）、慢动作、重置、瞬移、跳切。
- VFX 只在接触点爆发、源绑定、当帧清场（"source-bound, clear frame"）。

这些参考例子是幻想/动漫战斗，但映射到历史纪录片时概念不变：
"接触点"可以是演讲手势、工具敲击材料、船只触岸；"顺势连贯"指下一格继续上一格的动作动量，而不是硬切到另一个姿态。

## 落地到叙事画格生产

- `designEpisodeSequenceBeats`（episode-level route `grid.episode_design`）
  调用 `designSequenceBeats` 为每 Sequence 产出：统一 `screenAxis`、每 Panel 的
  `cameraAngle` / `shotSize` / `beat` / `continuityAnchors`，并保证相机沿发展轨道变化、
  复现物体身份可追踪、战斗每 Beat 单目标。
- `buildNarrativePanelPrompt`（生图阶段）消费上述计划：把 `cameraAngle`/`shotSize`/
  `continuityAnchors` 写进提示词，并用上一格最终图作为身份/调色/轴线连续性参考。
- 成片阶段（`grid.episode_render`）应按 Sequence 应用**连续发展运镜**，
  而非逐镜独立运镜，使静态 Panel 衔接出视频感。
