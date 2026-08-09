# Writer Pass (Work Orders, Not Prose)

Load after fact curation (Step 2). This is the material-and-brief pass, not a drafting pass.

## Principle: The Model Assembles Material, The Human Writes The Sentence

The account owner's own instruction: *"大模型只做搜索+骨架，人工润色 — don't expect the LLM to
produce high-quality copy; it is an assistant to human writing, not a replacement. The subject
and every paragraph are human-decided."* This is not a preference to accommodate; it is the
product. Two independent lines of evidence back it:

- **Every commercial writing tool that survives contact with real long-form use puts the
  decision on the human.** Lex's founder: "AI can generate options and ideas, but **the
  decision is on us**." Novelcrafter: "helps people write, **not** a one-click solution that
  writes for people." Sudowrite's Describe returns raw sensory material and its own docs say
  "you typically **won't** use the card's Insert button — copy and paste the lines you like
  instead." No mature product has the model write finished long-form prose and the human merely
  edit it.
- **The account's own catalogued failure mode is a model-writing problem, not a human-writing
  problem.** Every 病句 that shipped from this skill (`退到楼上无路可退`, `人在半空中了弹`,
  `那年三十二岁`, `宅子…叫恒知府胡同`) was written by the model chasing the density rule below.
  A Chinese practitioner's diagnosis of AI-feel generalizes the mechanism: good writing leaves
  "留白的熵" (the entropy of white space); "AI会忍不住去填那些空白，把每一个情绪都解释清楚…
  文本的熵被压得太低" — the model's compulsion to fill and finish is the defect generator, not
  an incidental risk.

So the deliverable per paragraph is a **work order**: the facts, their order, the paragraph's
job, and one open judgment call — never a finished sentence, except for the three opening
candidates (requirement 5 — see `opening-recast.md` — which stay fully drafted because the
first line is machine-gated and disproportionately high-stakes).

## Two Modes, Chosen At Gate #1 By Naming One Word

The account owner ships at two different cadences and the work should match:

| | **quality** (default) | **volume** (multi-ship days) |
| --- | --- | --- |
| Gets a work order | every paragraph | opening block + every beat whose `stance_relation` is `reveal` or `name_cost` |
| Gets prose from the model | nothing (only 3 opening candidates) | remaining paragraphs, each tagged with its spent fact IDs |
| Rationale | the owner's mandate — every paragraph human-decided | batching evidence: a practitioner SOP measured the 2nd script of a day 30% faster than the 1st, the 3rd 30% faster again — some days call for throughput over full hand-authorship |

**Selection inside a mode is deterministic from the beat map, never a model guess.** In
`volume` mode, "which beats are reveal/name_cost" reads directly off `stance_relation` in
`production-run.json` — it is not a judgment call about which paragraphs "matter more." A run
measured this session showed the largest rewrite landing outside the opening (a body paragraph
at similarity 0.65 while the opening sat at 1.00), so guessing position instead of reading the
stance-relation field would have picked wrong.

If the mode is not stated at Gate #1, default to `quality`.

## Input Packet (Unchanged From Before — This Is Still What The Model Reads)

1. `02-fact-pool.md` — 40–60 scored facts, act-assigned. The primary input.
2. Autopsy skeleton — act sequence, hook mechanisms, emotional arc shape, opening_mechanism.
3. Narrator persona contract — `narrator-persona.md`.
4. Opening candidates — from `opening-recast.md`.
5. Production-run contract — beats, reader_relay chain, truth_promise.
6. The human's `00-stance.md` — the stance work orders bind facts against.

The writer does NOT receive: the original's text, autopsy evidence quotes, fingerprint
blocklist (review-side only, so the model cannot copy phrasing it never saw).

## Output: The Work Order (`quality` mode — every paragraph)

Four fields, plus one global constraint card shown once per run rather than repeated per
paragraph (see below). This is deliberately smaller than earlier drafts of this skill's
per-paragraph packet, which also carried "facts not to use here," "alternates," and a
per-paragraph ban re-listing — cut because `information_gap_contract.creator_owned` already
reserves a payoff fact for its intended beat (so a later beat cannot spend it early without
violating that contract), alternates cost nothing to request on demand but cost real reading
time if shown unasked, and repeating 38 bans across 15–57 paragraphs is exactly the
constraint-mass a practitioner warns against: *"Skills越多，模型越不敢犯错，最后…就是戴着镣铐
跳舞。"*

```
## P7 · beat B7 · 冲突 · warm
读者带进来的问题：改姓就够了吗？
这段的任务：把制度动作落到一个人手上的物件

可用事实（原文在前，理由在后 — 不要反过来）：
  A4-F2 [score 3][confirmed][源: 中华文史网·财政]
    1924年北京停发最后一笔旗饷；三两饷银的马甲仅领到铜元50枚
    为什么放这：制度层的「断」，一句话能立住
  A4-F6 [score 2][single_source ⚠ 仅八旗史话(360doc)]
    饷银用高丽纸小袋分装，老米色黑无光
    为什么放这：能上手摸到的东西；观众对「停饷」无感，对「五十枚铜元装在纸袋里」有感

留给你的判断：F9（职业栏只允许填一个字：兵）放这段还是下一段？放这段更狠，下一段会空。
```

Rules for building this:

1. **Fact display order is fixed: verbatim source span first, one-line rationale second, never
   reversed.** A measured revision on this skill's own history showed `约50—70两` drift to
   `五六十两` after only the rounded value reached the writer — the rationale line existing
   before the fact does the same thing NotebookLM's citation studies found: "interpretive
   overconfidence," where a claim drifts from what its source actually says because the frame
   arrived before the fact. Never paraphrase a fact into the work order; quote its pool entry.
2. **Fact selection is deterministic**, read from the pool's existing per-act assignment in
   score order — not re-ranked by the model per paragraph. If the pool's top-scored facts for
   this act don't fit the paragraph's job, say so as the open judgment call; do not silently
   substitute a lower-scored fact without flagging why.
3. **One open judgment call, not "alternates."** Name the single real decision left — usually
   an ordering choice, a which-beat-gets-this-fact choice, or a risk-acceptance choice
   (single-source fact, contested date). If there is a second live question, that is a sign the
   paragraph is trying to do two jobs (see rule 2.5 below) — split it rather than listing two
   judgment calls.
4. **No sentence, no scene, no metaphor.** The moment a work order contains a finished Chinese
   sentence describing what happened, it has become a draft in disguise and the human is back
   to reading prose. If the paragraph's job needs illustrating, name the mechanism ("展开动作
   链：围宅→砸门→惊醒→摸枪"), not the prose.

## The Global Constraint Card (Shown Once Per Run, Never Per Paragraph)

Five lines, given to the human alongside the first work order and assumed read once:

    语法：主语不能省略超过一句；固定动宾（中弹/上任/下野）不能被方位词吞字
    禁词：见 hard-banned-expressions.json（清单内全部规则零豁免）；命中就是要改的地方，不是可以商量的地方
    §11-19（你自己抓过的）：点名式开场 / 顿号身份碎片 / 借喻绕弯 / 文言压缩体 /
      总结句代替描述句 / 病句 / 重复用字 / 缺主语 / 判断锤与破折号结论链 — 具体例子见 anti-ai-auditor.md
    一段一件事：这段的收尾问题必须由这段自己给的事实撑得住，不能被自己的事实反驳
    立场只在揭示段说一次，之前的段落只给事实，不许提前评价
    字面表达：AI 输出不得使用明喻、隐喻、类比、拟人或象征标签；只写主体、动作、条件和结果
    「不是…是…」判断锤：全篇建议 ≤4 次（不是硬性上限——已发布稿件实测 4 次，
      这里给的是预算提醒，不是拒稿理由；写到第 5 次时停下来问自己是不是在偷懒）

Do not re-paste this card into every work order. Constraint mass repeated 15–57 times is the
failure mode a practitioner warned against directly: 36 red lines and 20 micro-techniques in a
40,000-character skill produced worse output, "戴着镣铐跳舞." One card, read once, is the
budget. If a paragraph has a constraint so specific it cannot wait for the card, that specific
constraint is exactly what belongs in "留给你的判断" instead.

## What The Human Writes Back

The human writes the paragraph and tells the model its content, or writes a rough version and
asks the model to clean the sentence without changing what it says. Either way, the model's job
at this point is narrow: fix grammar (rule 0 below), never add a fact the human didn't supply,
never soften or sharpen the stance beyond what the human wrote. If the human's draft still hits
a banned pattern or a 病句, name it — do not silently rewrite it into a different sentence
that says something the human did not say.

## Output: Prose (`volume` mode only, for non-reveal/non-name_cost paragraphs)

Full prose, drafted against the same fact-pool assignment, with every rule below still binding.
Tag each paragraph with a comment naming the beat and the fact ids it spent, so Gate #2 can
audit allocation without reading the prose itself:

    <!-- B9 · F14, F17 -->
    军镍加军册津贴，把征服从当场抢光变成税基养战……

## Core Rules (Binding In Both Modes — For Prose Output And For The Human's Own Writing Alike)

### 0. Grammar Outranks Compression (Hard Priority)

**语法完整 > 压缩密度.** Read this before rule 1, because rule 1 is what breaks it.

The density rule below pushes toward shorter sentences. Past a point, compression stops
removing filler and starts removing grammar — and every 病句 that has shipped from this skill
came from that exact overshoot:

| Over-compressed | What broke | Correct |
| --- | --- | --- |
| `退到楼上无路可退` | 退 twice in 8 characters | `退上二楼，没路了` |
| `人在半空中了弹` | 中弹 lost its 中 to 半空中 | `人在半空中中了弹` |
| `那年三十二岁` | no subject — whose age? | `那年，他三十二岁` |
| `宅子在大东关小什字街，叫恒知府胡同` | 叫 attaches to 宅子; the hutong has that name | `宅子在大东关小什字街，胡同叫恒知府胡同` |

A sentence missing its subject is not dense, it is broken. A swallowed verb character is not
concise, it is a typo. When compression and grammar conflict, **compression yields** — spend
the extra three characters.

Self-check, on any prose output (model's or the human's own draft):

    node .codex/skills/polish-video-script/scripts/scan-sentence-health.mjs --script <draft>

Then reread for what the scanner cannot decide: ambiguous 他/这/那, verbs attached to the wrong
subject, clauses that need a subject restated after the topic changed. Never resolve one of
these findings by compressing further.

### 1. No Filler Sentences

Every sentence must carry at least one incremental concept — a fact, relationship, or causal
chain that changes what the viewer understands. Test: if you delete this sentence, does the
viewer know less? If no → delete it.

This licenses deleting whole sentences that add nothing. It does **not** license amputating
words from a sentence you are keeping (rule 0), and it does **not** mean every paragraph must
be maximally packed — 留白 (deliberate white space) is not filler; a sentence that gives the
listener room to feel a fact land is not the same as a sentence that repeats one.

Specifically banned as filler:
- Scene-setting without stakes ("1912年，北京...")
- Meta-commentary ("我们要破解一个悬案...")
- Generic transitions ("然而", "更可怕的是", "值得一提的是")
- Repeated judgments (the same point in different words)
- Buffers ("众所周知", "让我们回到", "说到这里")

### 2. Facts Generate Transitions

Bridge paragraphs using causal or temporal relationships between facts, not transition words.

Bad: "然而，更可怕的是，旗人不仅断了粮，还被禁止从事任何职业。"
Good: "1924年，北京的最后一笔旗饷停了。同一座城里，旗人的职业栏里只允许填一个字：兵。"

The second example uses two facts in temporal sequence. No transition word needed.

### 2.5. One Paragraph, One Job — And The Closing Question Must Follow From It

A paragraph carries **one** function: scene, or conflict, or judgment, or question. When it
tries to carry several, the closing question stops matching the facts above it.

The real failure this prevents (from a shipped draft): one opening paragraph delivered the
siege scene, the family's official pedigree, a 为什么, the answer (he cut his queue, married a
Han woman, hid guns for the revolutionaries), and then closed on 「满清怎么把最亲的工具，一步步
逼得反了它自己？」 — but the facts it had just supplied show a man who *chose* to turn: he
refused office, cut his own queue, joined the conspiracy. Nothing in the paragraph shows him
being *forced*. The closing question was refuted by its own evidence, one sentence earlier.

This is why the work order names the paragraph's job explicitly (rule 3 of the work-order
section above): naming it forces the one-job check before any sentence is written, instead of
discovering the mismatch after the fact.

### 3. No Commentary

Do not explain what facts mean. Do not tell the viewer how to feel. Present facts in sequence
and let the viewer draw conclusions. The narrator's stance (`我认定`) appears once, at the
contracted reveal beat, as a judgment backed by facts already disclosed — never as commentary
on facts the viewer hasn't seen yet.

### 4. Opening Must Establish Conflict (No Character-Count Ceiling)

The first sentence must:
- Establish a visible conflict, picture, or suspense at the very start — a person in danger,
  two forces in opposition, or a visible action whose cost is felt. There is **no character-count
  limit**; the conflict must simply be present, told as a *description with a picture*
  (「辛亥年腊月初五，奉天城的一栋满人老爷的大宅子被兵围个水泄不通」), never as a telegraphic
  summary (「恒宅被兵围了」).
- NOT match any forbidden opening pattern (预告腔, 场景铺垫, 伪互动)

If the fact pool's Opening-act facts can't produce such a sentence, return to Step 1
for targeted search — do not pad with commentary.

### 5. Anti-AI Is A Constraint The Human Should See Once, Not A Post-Hoc Audit

`data/style-distill/writing-books/hard-banned-expressions.json` (all listed patterns, zero waivers) and
`agents/anti-ai-auditor.md` §1–19 are compressed into the global constraint card above.
Items 11–18 are the account owner's own hand-caught patterns and rank highest:

| # | Pattern | Wrong | Right |
| --- | --- | --- | --- |
| 11 | 点名式开场 | `杀张榕的赵尔巽，自己也是旗人` | 具名人物 + 立即发生的动作/代价，名字被上下文包裹 |
| 12 | 顿号身份碎片 | `他，汉军镶黄旗` / `田亚斌，满族，二十岁` | `他是汉军镶黄旗` / `田亚斌是满族，才二十岁` |
| 13 | 借喻绕弯 | `最亲的自己人，账本上排最前面被划掉` | 直陈 + 情绪：朝廷筹赔款，第一个砍的就是旗人自己的钱粮 |
| 14 | 文言压缩体 | `旗人恒宝昆，惊醒摸枪跳楼中弹` | 展开动作链：围宅→砸门→惊醒→摸枪→打伤→退楼→跃下→中弹 |
| 15 | 总结句代替描述句 | `恒宅被兵围了` | `奉天城的一栋满人老爷的大宅子被兵围个水泄不通` |
| 16 | 病句（动词拆字） | `人在半空中了弹` | `人在半空中中了弹` |
| 17 | 重复用字 | `退到楼上无路可退` | `退上二楼，没路了` |
| 18 | 缺主语 | `那年三十二岁` | `那年，他三十二岁` |

The step 4 auditor still runs regardless of mode. Its job is the isomorphism layer machine
scans cannot see (同构比喻 / 同构例子 / 金句节奏复刻 / 指纹变体). It should never have to flag
`值得一提的是` — a hit there means the constraint card was not read.

For `volume`-mode prose, run before handing off:

    node .codex/skills/polish-video-script/scripts/scan-forbidden-expressions.mjs --script <draft>

Zero waivers, so any hit must be fixed here rather than argued in review.

### 6. Book Technique On Demand (`volume` mode prose only)

Consult `book-usage-cards.md` for technique guidance on HOW to tell a specific meaning, and
retrieve passages with:

    node tools/writing-corpus/search-book-source.mjs '{"book_id":"<id>","query":"...","limit":5}'

Search by the paragraph's meaning, take 3–5 relevant cards, apply the technique rather than the
surface words. Do not load the full 17KB cards file into context at once.

## Book-Review Recording

Unchanged. After any prose is produced (model's `volume`-mode paragraphs, or the human's own
paragraphs once finalized), record one `book_review` entry per paragraph in `audit-log.jsonl`:

- **Pass paragraphs**: `{"finding":"book_review","paragraph_index":N,"beat_id":"B<N>","verdict":"pass"}`
- **Rewritten paragraphs**: full record with meaning, retrieved technique references, gap
  description, rewrite_action (`full-reproduce` | `partial`), and verdict.

The validator machine-checks that every paragraph has a `book_review` record.

## Scene & Voice Constraints (Bind The Human's Writing Too, Not Only The Model's)

- Narrate as the rural-middle storyteller (`narrator-persona.md`): stand beside the people,
  not beside the document. Bodies, rooms, choices, objects, and consequences before source labels.
- Use `cold` for clean ledgers/false labels, `warm` for the trapped person's conditions,
  `hot` for the designer/beneficiary/coverer of upward cost transfer. Heat targets actions,
  never a constrained person's essence.
- Stance reveal: unmistakable, no "perhaps"/"both sides", backed by facts already disclosed.
- Emotion appears as action: a person stops, refuses, looks away, grips a weapon, leaves a
  sentence unfinished. Never "他很愤怒".
- Scene detail comes from fact pool details + three permitted inference types (concretize,
  infer normal state, annotate background). Never from imagination.
- Delete: `要……得……` templates, buffer sentences, `所以/总之/也就是说` closings, every simile,
  metaphor, analogy, personification, or symbolic label, and `几乎/差不多/某种意义上` hedges
  without hard facts.
- Action chains (decomposing one act into steps) are wanted scene work, not banned parallelism.
- Every paragraph ends forward-leaning (unpaid action, withheld consequence, new pressure).
  Final close paragraph is the only exception: decelerate to the charged image.

The output is judged on story movement, human specificity, and prose outcome — regardless of
who wrote the final sentence.
