# Book-Reference Review (书参照审稿)

This pass is a reviewer who has internalized the four writing books. It sits down with one
drafted paragraph, works out what the paragraph is trying to say, consults the books about how
they would say it, and rewrites. The seven steps below are one continuous act per paragraph,
not separate stages.

Load after a paragraph exists — freshly drafted by the writer pass from the transplant map.
This document is not part of writer mode.

The original's corresponding act is the WASH BASELINE — the text this paragraph must NOT
resemble. Keeping any sentence from the raw original source is a hard failure with no
per-sentence exemption; the validator machine-checks every `kept_sentences` entry against
`00-original-source.raw.txt`.

This pass is the craft-authority layer. How a meaning is told — sentence, detail density,
scene construction — is decided here and nowhere else. The editorial audit and the
editorial-board agents that run after it may diagnose craft problems but never treat them:
their craft findings route back to this pass, and the disposition (with its retrieval
evidence) is recorded in this pass's log. On questions of craft taste, the four books outrank
the board agents' house style.

Books: 《中国小说描写辞典》 (description dictionary, five usage categories), 《南周评论写作课》
(opinion structure and sentence relations), 《文案的基本修养》 and 《秒赞》 (copywriting
judgment and spoken plainness).

Assets:

- `references/book-usage-cards.md` — master usage cards distilled from the description
  dictionary: action / 神态 / 心理 / 对话 / 承接词. Learn the move, never the literal wording.
- `data/style-distill/writing-books/` — `principles.jsonl`, `technique-cards.jsonl`,
  `writing-units.jsonl`, `hard-banned-expressions.json`.
- Original-text search (supplement only; the distilled items carry book locators):

      node tools/writing-corpus/search-book-source.mjs '{"book_id":"<id>","query":"...","limit":5}'

Red line for every borrowed move: it must pass three gates before entering the script —
真人味道, no AI sentence pattern, and every inference anchored to the source record.

## Step 0: Hold The Inference Boundary

The reviewer enforces the three permitted inference types and the deletion test defined in
`truth-and-promise.md` (Historical-Fiction Boundary). Restated for this pass:

1. Concretize the source's own wording (`归其父` → 父亲把他接回).
2. Infer the normal state the source implies (`得毋笞骂即足矣` → 挨打是家常便饭).
3. Annotate period background (甘泉居室 = 关犯人的地方).

Forbidden: new events, new dialogue, new objects, invented numbers, other people's motives.
Deletion test: if removing this inference leaves a hole in the source record, it overstepped.

## Step 1: Read The Paragraph's Meaning (读懂意思)

Before any retrieval or diagnosis, state in one or two sentences what this paragraph is
actually trying to express — 这段话究竟想表达什么意思: what it wants the viewer to know,
feel, or see, and what job that meaning does in the whole script. The meaning is the
retrieval query and the rewrite's anchor: the rewrite may change everything about the
telling, never the meaning. If the meaning itself is wrong, that is an upstream angle
problem — stop and return; do not patch a wrong meaning with craft.

## Step 2: Retrieve By Meaning (按意思检索)

Take the meaning from step 1 as the query and ask: 关于这个意思，书里会怎么写？ Retrieve
the books' knowledge about expressing THIS meaning — how the masters establish a man's low
origin and humiliated childhood, how they land a comparison between two people, how they
close a scene on an afterimage — not good sentences to copy. The categories below are the
index into the cards; the meaning decides which entries are pulled:

- 立人叙事: 白描, 抑扬, a detail unit that carries the truth.
- 段落结构: judgment first, compressed evidence, scene-to-insight, 夹叙夹议, rising payload.
- 开头结尾: first sentence sets tone and pace; person + pressure + problem openings; the
  closing concrete afterimage.
- 句间关系: transitions must carry logical force (avoid 另外/接下来 lateral moves; prefer
  adversative / conditional / progressive links); 衬跌 (list then sharp turn); 冷热相间
  (contrast pairs intensify each other); 映衬 (stillness shows motion); period-cut long
  sentences.
- 语言质地: plain-speech principle (老百姓的话); word choice passes fact / common-sense /
  logic checks; modal adverbs carry attitude (硬 / 好不容易 / 干脆 / 一口气); degree adverbs
  and ornate adjectives are cut; an adjective's legal seat is differentiation (戴刑具的).
- 名家用法卡: sweep `book-usage-cards.md` by the paragraph's meaning — action, 神态, 心理,
  对话, 承接词 (ten functional groups, 说书 system and modern colloquial side by side). Learn
  the move ("失态+掩饰两个动作连着来"), not the surface words ("匙筋落于地下"); 民国腔 too
  literary for the ear contributes its idea only.

Retrieval stays opportunity-driven: a meaning with no footing in the books or the source
record (e.g. 神态/心理 the record never mentions) is marked "本次无落点" and skipped; never
force a card onto a meaning that has none.

Transplant mode adds a second retrieval source: the original's corresponding act, consulted as
a fifth book — the benchmark. Order is mandatory: finish your own books-driven version FIRST,
then benchmark it against the original's paragraph. The benchmark verdict is recorded in the
`book_review` record's `benchmark` field: `original_locus` (which act/span of the original),
`verdict` (`ours_better` | `original_better` | `both_mediocre`), `borrowed_move`, `technique?`.
Evidence rules: `original_better` must name the borrowed move in `borrowed_move`; `both_mediocre`
must attach both-side quotes and a named book technique in `technique` (the validator
machine-checks the field's shape). The benchmark is a self-reported soft mechanism — it
disciplines this review, it proves nothing by itself; the hard backstop is the user
side-by-side review at step 6.

## Step 3: Diagnose

- State how the paragraph currently expresses its meaning, then name the gap against how the
  books would express it. The gap is the rewrite target.
- Label the paragraph's function: 过渡 / 场景 / 冲突 / 收束 / 设问 / 判断.
- Skeleton diseases: 流水账, 评述脱节, 收束平庸, 作者旁白 — plus 年表腔: a time-word opening,
  no judgment sentence, flat chronicle narration, no structural fault but no human voice
  ("两年以后，他带一万骑兵进河西……"). Test: 这段讲给人听，你会这么开头吗？
- Source recovery: return every fact point in this paragraph to the original record and find
  the details the baseline flattened.

## Step 4: Rewrite

Rewrite expresses the same meaning the way the books would: the meaning from step 1 is fixed;
everything about the telling is in play.

- The draft is fresh from the transplant map, so reproduce only where diagnosis named a
  defect; a clean paragraph passes. But a `kept_sentences` entry matching the raw original
  source is a hard failure regardless of justification; the validator machine-checks each
  entry against
  `00-original-source.raw.txt`.)
- Scene-sourcing order: ① dialogue and action the record itself carries first (last words,
  four-character source phrases — 岂非天哉, 匿讳之 — plain-speech retelling is already a
  scene); ② craft scheduling (order, pacing, where the closure lands, contrast — adds no
  facts, only changes the telling); ③ "do not invent facts" bounds ①'s content only, never
  ②'s freedom of telling.
- Detail densification comes only from the source details recovered in step 3 plus the three
  permitted inference types. No imagination.
- Plain speech at the pen: a named person (议郎周霸) beats "军中有人".

## Step 5: Defense Lines (The Core Review)

1. **功能复核**: conflict and closing paragraphs are high-risk and must pass every line below.
2. **事实链检查**: split every sentence into 谁 → 干什么 → 落在谁身上 and check it against the
   record; a misplaced subject triggers the alarm ("同一件事砸下来" was caught here).
3. **对称反问**: for any parallel or antithetical structure ask "事实本身是这个对称形状吗？"
   No → rewrite; yes → keep.
4. **转折扳机检查**: for every turn check ① the drop is real (the two sides intensify each
   other, not a parallel listing); ② the trigger word is spoken (可 > 却 > 然而 — the more
   written, the weaker); ③ the trigger sits at the head of the heavy-hitting short sentence;
   ④ the sentence after the turn is short (length follows load).
5. **腔调检查**:
   - 导览腔: announcement sentences that conclude for the reader ("意思就清楚了",
     "最能说明问题") — delete the announcement, keep the interlocking facts.
   - 预告腔 / 邀功句: sentences whose function is to preview what the reader will discover or
     to praise the text's own technique ("几乎是同一支笔"). Test: delete the sentence — can
     the reader still see the point from the facts themselves? Yes → the sentence was
     grandstanding.
   - hedge 词: 几乎 / 差不多 / 某种意义上 — either confirm with a hard fact or delete the
     sentence; no cushioning. Frequency-calibration uses backed by the record (几乎没驳回)
     are legal.
   - 点评位置规则: commentary may only appear after the fact, as closure; before the fact it
     is 预告腔. Commentary uses spoken words; literary-criticism vocabulary (来路 / 笔触 /
     同一支笔) is banned.
6. **动作链 ≠ 排比**: an action chain that decomposes one act into steps — each sentence a
   different subject, verb, or structure (他提笔，蘸墨，笔尖在姓上顿住) — is wanted scene
   work, not parallelism. The ban targets decorative same-structure listing only. Never
   flatten an action chain by citing the parallelism ban, and never compress a scene by
   citing duration (see the duration arbitration in `metrics-contract.md`).

## Step 6: Machine Scan

After the reviewed body is complete, run:

    node .codex/skills/polish-video-script/scripts/scan-forbidden-expressions.mjs --script <path>

Zero hits required on the hard-banned list (literal and regex). Structural classes the scanner
cannot catch — parallelism, pseudo-interactive questions, cheap-uplift templates — are checked
by hand in step 5. The final persistence gate re-runs this scan on the whole clean script.

## Step 7: Log

Append one `book_review` record per paragraph to `audit-log.jsonl`:

- **Pass paragraphs** (no rewrite needed — diagnosis found no defect, or the paragraph
  already expresses its meaning the way the books would):
  ```json
  {"finding":"book_review","paragraph_index":<N>,"beat_id":"<id>","verdict":"pass"}
  ```

- **Rewritten paragraphs** (diagnosis found a gap and the paragraph was rewritten):
  ```json
  {"finding":"book_review","paragraph_index":<N>,"beat_id":"<id>",
   "meaning":"<what the paragraph is trying to express — step 1>",
   "retrieved":[{"ref":"<card or technique>","locator":"<asset + section>"}],
   "no_footing":"<required when retrieved is empty>",
   "gap":"<how the paragraph currently vs how the books would — step 3>",
   "rewrite_action":"full-reproduce | partial",
   "kept_sentences":[{"sentence":"...","reason":"..."}],
   "verdict":"rewritten"}
  ```

The validator machine-checks that every paragraph has exactly one `book_review` record.
Pass paragraphs must have `verdict: "pass"` with no other fields beyond paragraph_index
and beat_id. Rewritten paragraphs must have all required fields.

Degraded execution (降格执行) is a hard failure:

- A paragraph with no `book_review` record at all — counts as unreviewed.
- `verdict: "pass"` while `gap` names a real gap — diagnosed but not treated.
- `verdict: "rewritten"` with `meaning` missing or empty — step 1 skipped.
- `verdict: "rewritten"` with `retrieved` empty and no `no_footing` — step 2 skipped.
- A `kept_sentences` entry lifted from the raw original source — shallow wash.
- Sentence-patch-only treatment under `verdict: "rewritten"` — fixing a metaphor or deleting
  a tail while the paragraph's telling stays abstract.

Also append the existing `inference`, `interception`, and `overreach` records for densified
details, defense-line catches, and discarded inferences. Board-review dryness findings routed
back to this pass are disposed here: the treatment decision (and its retrieval evidence)
lives in a new `book_review` record for that paragraph, never in the agent-review file.

## One-Line Principle

读懂意思是锚 (step 1); 书教"这个意思他们会怎么写" (steps 2, 4); 史料给"细节本身" (step 3);
防线管"别为修辞压扁事实" (step 5); 机扫管"别出 AI 句式" (step 6); 留档管"每处改动可追溯"
(step 7)。降格执行——只修病句、不过意思与检索——等于未审。
