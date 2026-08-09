# Angle Workshop (Material For The Human, Not A Gate)

Load at SKILL.md step 0a. This file used to define a candidate-generation-and-scoring gate
where the model picked 3 candidates and the human approved one. That gate is retired: every
market-validated writing tool inverts this relationship (the human decides, the model
supplies raw material), and a model-scored "divisive stance" tends toward stances that merely
*look* edgy while staying safe — the stop-conditions check "the stance is safe: no specific,
nameable group would hate it" exists because RLJF-trained models default there. The fix is
structural, not a stronger prompt: **the human writes the stance in `00-stance.md`**; this
file only produces what step 0a calls `lens_readout`, `original_debts`, and (when available)
`comment_evidence` — reading material, never a recommendation.

**Terminology (do not collapse)**: 题材 (subject) = the original's topic matter, fixed by the
user; 主题 (topic) = the episode's main question or promise about that subject; 角度 (angle) =
the interpretive stance inside the topic. The human's `00-stance.md` IS the 角度 decision;
this workshop never makes it for them.

## Producing `original_debts` (≥10 items)

Assume you are the most critical viewer of the autopsied original. Identify at least 10
loopholes — unpaid promises, missing sides, unresolved questions:

- What promise was made but not delivered?
- Which audience segment will find this useless or irrelevant?
- Which key link is vague, unsupported, or explained by analogy instead of evidence?
- Which modern metaphor, personality label, or generic comparison substitutes for a real
  mechanism?
- Which side of the story is missing?
- Which ending leaves the original question unanswered?

Present these as a plain list of debts (what the original owes and never paid), each with the
specific evidence it grows from — not as candidate topics, not scored, not ranked. The human
reads this list and decides what, if anything, this run should pay off.

## Producing `lens_readout`: The Dark-Nature Lens (黑暗人性透镜)

This account's signature is: **戳穿掩盖在事件上方的虚伪，揭开人们不敢承认的黑暗人性面，从黑
暗人性面重新理解事件** — using the past to mirror the present (借古讽今), aimed at today's
ordinary people (底层百姓) who live inside the same mechanisms.

For the material at hand, read out — do not select or recommend — what each board of the
taxonomy below could support, with the specific evidence for each reading:

1. **机制级黑暗 — 认知与道德的自我麻痹**: 道德脱钩（恶行被"大局/程序/命令"洗白）、
   自以为是的正义感（最大的恶来自确信自己代表真理的好人）、双标与虚伪（对他人
   高道德审判、对自己无死角辩护）。
2. **关系级黑暗 — 权力、支配与剥削**: 异化与物化（人变工具/资产/数据）、统治欲
   （掌控他人命运本身即快感）、情感寄生与操纵（gaslighting 式精神控制）。
3. **群体级黑暗 — 异己排斥与系统性残忍**: 部落主义与替罪羊、去个性化的群体狂热
   （匿名释放暴力）、恶的平庸（制度齿轮里人人尽责、无人担责）。
4. **演化竞争级黑暗 — 零和与损人**: 恶意的嫉妒（宁可自损也要毁掉对方所有）、
   焦土心态（我得不到的谁也别想得到）。
5. **心理精神级黑暗 — 防御与破坏本能**: 死亡本能（无理由的破坏与解构冲动）、
   阴影投射（把自己不敢承认的恶投射到他人身上再施以道德审判）。
6. **底层公理 — D因子**: 最大化私利/快感 + 无视甚至享受对他人的伤害 + 一套完美
   的自我合理化信念。检验一个黑暗解读是否到位的试金石：三件事是否同时在场。

Present 2–3 board readings as options for the human to react to, each with:
1. **Hypocrisy pierced (戳穿什么虚伪)**: the official/pious/mainstream account this reading
   would unmask — the moral packaging, the heroic myth, the "everyone knows" story.
2. **Dark mechanism (揭开哪种黑暗机制)**: the specific board and sub-mechanism.
3. **Present-day resonance (借古讽今落点)**: the modern situation a viewer might recognize
   themselves in.

Do not rank these, do not mark one "recommended", and do not write a `我认定` sentence for any
of them — that sentence belongs to the human alone. Presenting a ranked recommendation just
re-creates the retired candidate gate under a new label.

Lens discipline (hard rules, unchanged):

- The lens shapes stance and interpretation only. It never licenses inventing facts, motives,
  or events — the truth-and-promise contract still governs every factual claim. A dark
  reading with no factual footing in the material is a forced reading: say so, do not prop it
  up with invented psychology.
- The lens is applied to **systems, rulers, and the self-righteous**, never to blame
  constrained people (victims, the powerless) — the narrator-persona contract's
  heat-aims-upward rule outranks the lens.
- 借古讽今 is delivered by selection and juxtaposition, never by explicit present-day
  commentary that would date or flatten the script.

## Producing `comment_evidence`

When comment data was not waived, quote actual comments verbatim with their like counts —
this is the strongest signal for what the audience already disputes. Do not summarize
comments into adjectives; quote them. If comments were waived, state so and leave this field
empty rather than inventing audience reaction.

## Audience Motive Contract

Filled by the model **from the human's written stance** (step 0c), not derived independently
of it:

    primary_human_switches: []  # one or two only
    secondary_human_switches: []
    story_paradox: ""
    viewer_pursuit: ""
    payoff_experience: ""
    source_boundary_role: guard | engine
    comment_trigger:
      enabled: true | false
      type: resonance | confrontation | expression | relation
      expected_comment: ""  # one-sentence example of what a viewer might say
      target_beat: ""       # beat ID where the trigger is planned

Allowed primary switches:

- `确定性渴求`：修复一个具体困惑、解开异常。
- `优越感满足`：知道少数人注意到的关系、规则或内幕。
- `刺激寻求`：危险、反常、临界动作、局势翻转。
- `共鸣确认`：替观众说出熟悉的委屈、犹豫、羞耻或愤怒。
- `归属驱动`：进入共同身份、共同立场或共同参与。
- `情绪宣泄`：完成压抑、愤怒、荒谬感的释放。
- `懒惰本能`：用极短路径获得原本难懂的判断。
- `贪婪欲望`：获得明确、可使用的收益或方法。
- `好奇心`：一个不合常理的结果，观众想知道它如何发生。
- `真实渴望`：看见未被粉饰的代价、动作或关系。

`story_paradox` 必须是人物、风险或结果之间的反常关系，而不是"史书为何没写"。
例如：`李敢打伤大将军后没有立刻受罚，却仍跟着皇帝走进了后来射杀他的猎场。`

`source_boundary_role` 默认只能是 `guard`。只有存在相互冲突的证据、指控和回应时，
才可用 `engine`；单纯的史料沉默不是调查故事，也不是口播主线。

### Comment trigger types

Use these only when `comment_trigger.enabled` is true. The type names the expected viewer
response, not the narrator's tone.

| Type | Viewer response | Example angle |
| --- | --- | --- |
| `resonance` | "我也是" / "太真实了" / "这就是我" | Shared grievance or relief in a named situation. |
| `confrontation` | "不对，应该是……" / "你漏了一点" | Hard stance that challenges a common belief. |
| `expression` | "学到了" / "原来如此" / 主动复述 | Dense knowledge or method the viewer wants to repeat. |
| `relation` | @某人 / "转发给XX看" | Content that maps to a specific relationship. |

`comment_trigger` is optional. If the run does not set a `target_comment_rate` in the metrics
contract, leave it disabled. Do not force a comment trigger.

## What This File No Longer Does

Retired, and deliberately not replaced: candidate generation, seven-dimension scoring, the
candidate presentation contract, and the pre-gate self-check. Those existed to run a gate
where the model proposed and the human approved. The gate now runs the other direction — see
SKILL.md step 0b — and building material for the human to react to does not require scoring
it first.

Information-delta targets (what this run must beat, expressed as concrete facts the reworking
must surface) live in `00-angle-decision.md`, filled after the human's stance is known, since
what counts as new information depends on what the stance is actually claiming.
