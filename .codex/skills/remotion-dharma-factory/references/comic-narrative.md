# 漫画叙事生产

只在 runner 返回 `MANIFEST_CREATION_REQUIRED` 时读取本文件。这里负责把 TTS beat 翻译成可验证的漫画 manifest，不负责执行生产阶段。

## 固定规格

```text
retro-anime-1980s + gpt-image-2 + progressive_five
+ 1280x720 / 30fps + full-screen / no outer frame
+ renderer overlays for Chinese text
```

不得改变 runner 草案中的固定字段。每页正好五格；所有 prompt 在 manifest 冻结前一次性完成。

## 先找画面命题

每个 TTS beat 先写 `visualProposition`：观众静音时，仍能从画面读出的一个具体命题。不要先想“画面要唯美”，也不要用佛像、寺院、云雾、山水或抽象光影替代本应出现的人物、关系和动作。

选景顺序：

1. 旁白出现人、父母、孩子、伴侣、关系、控制、冷漠或拯救时，先画对应人物数量和关系动作。
2. 抽象词翻译为可见因果。例如“关心变成控制”，画关心的表情、拉紧的手和被迫退回的人。
3. 经文解释也落到人的处境：谁在抓取，谁在逃避，谁在给予，行为造成什么后果。
4. 只有纯停顿或无法落到人物处境的短句，才用器物或风景。

## 六项语义证据

每格必须补齐：

- `subject_count`：画面实际人数；
- `subjects`：人物身份和年龄关系；
- `relationship`：亲疏、权力或情感距离；
- `action`：正在发生的具体动作，不是摆拍；
- `visible_emotion`：由表情、姿势和空间共同证明的情绪；
- `visual_evidence`：不听旁白也能验证命题的物理证据。

`prompt` 必须直接生成这六项事实。不能把关键信息留给观众从旁白脑补。

## 人物连续性

同一人物连续出现时固定年龄段、脸型、发型、服装主色和一个辨识锚点，并写入 `continuity`。第二次出现可用更早、已计划的 panel key 写入 `referencePanelKeys`；引用只能向后看已出现的 key，总引用数不超过三。

不要为了连续性让五格重复同一构图。人物稳定，动作、景别、空间关系和证据仍要随口播推进。

## 五格页面

- 每页五张内容唯一的 16:9 图；不能换路径复用同一图片。
- 每格平均约 6-15 秒；任何相邻 `startSec` 不得相差超过 20 秒。
- 第一格从 0 秒开始，后续严格递增。
- 第一格建立处境，第二至四格推进关系、因果或反转，第五格完成本页落点。
- 下一页必须有新的语义任务，不能只是换景继续表达同一句抽象话。

## 文字层

生成图本身不得出现文字、字母、字幕、气泡、拟声词、logo、水印或 panel border。中文由渲染层叠加。

`bubble` 可选，一格最多一个：

- `speech` 只放角色真实说出或忠实戏剧化的短对白；
- `caption` 只补时间、因果、反转或概念标签；
- 1-24 字，不能重复底部字幕；
- `x/y` 使用 0-85 的百分比，避开脸、手和 `visual_evidence`。

`quote` 只用于经文原句、核心义理或收尾落点：

- `text` 1-36 字，必须逐字出现在该格 `narrationText`；
- 有明确出处时才写 `source`，不超过 24 字；
- 必须写 `kind`：全局思想落点用 `theme`，经文原句用 `scripture`，口语化释义用 `explanation`；
- 同一句不能同时做普通字幕和金句；renderer 会在金句时段压掉字幕；
- 不要每页机械安排金句。

全片至少应把真正统摄全文的一句主题命题识别为 `theme`；经文原句与紧随其后的释义必须分成 `scripture` 和 `explanation`，不能都做成同一种金色牌匾。只有文稿实际存在这些内容时才标记，不为动效硬造金句。

## 清晰度与构图

Prompt 使用清晰的 1980 年代赛璐璐动画语言：粗细明确的黑色线稿、硬边两段式阴影、干净色块、成年人比例、可读面部和分离清楚的前中后景。

禁止 haze、bloom、soft focus、depth-of-field blur、motion blur、film grain、faded wash、泥灰暗部、写实照片、3D 渲染、畸形手、重复脸和多余人物。为气泡和字幕留出空间，但不能牺牲叙事动作。

## 输出契约

以 runner 草案的 `fixedManifestFields` 原样作为顶层字段，把每个 beat 扩写为 panel：

```json
{
  "key": "p_001",
  "startSec": 0,
  "narrationText": "原始 TTS beat",
  "visualProposition": "静音也能读出的具体命题",
  "semantic": {
    "subject_count": 2,
    "subjects": "成年女儿与年迈母亲",
    "relationship": "亲近但正在形成边界",
    "action": "女儿轻轻放下母亲抓住她的手",
    "visible_emotion": "女儿克制坚定，母亲错愕",
    "visual_evidence": "松开的双手、半步距离、仍相对的身体"
  },
  "continuity": "Daughter: early forties, low tied black hair, charcoal cardigan.",
  "prompt": "A middle-aged East Asian daughter gently releases her elderly mother's gripping hand...",
  "referencePanelKeys": [],
  "focusX": 48,
  "focusY": 46
}
```

一次性写完所有 panel 到 runner 指定的 `outputPath`，然后回到 runner。不要在本阶段读取事故 lesson，也不要自行提交图片。
