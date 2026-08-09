# Transplant Map (移植映射表)

The transplant map is the step 3 artifact and the only outline form this skill
produces. One row per paragraph, two halves: the left half says what the original's
act contributes (inherit), the right half says what the new paragraph does with it
(replace). Both repetition and shallow wash must become visible in this table, before a
single sentence is drafted.

## 主表

| 段 | 原稿幕 | 继承：功能/情绪/钩子机制 | 替换：本段意思 | 首次披露事实 | 新贡献 | 接力（问进→问出） | 修补 | 约字数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

**There is no "禁带" (do-not-carry) column.** The original's signature examples, metaphors,
and gold sentences never enter the writer's field of view: telling a drafter exactly what
to avoid keeps the forbidden pattern maximally accessible. Avoidance is enforced
review-side instead — the wash scanner (literal) and the creator's side-by-side
source-separation review (semantic). The `fingerprint_blocklist` lives in the autopsy and
in those two review passes only.

## Rendering discipline (左栏机渲)

The left columns (段 / 原稿幕 / 继承：功能/情绪/钩子机制 / 修补) are machine-rendered:

    node .codex/skills/polish-video-script/scripts/render-transplant-map.mjs \
      --autopsy scripts/polish-notes/<article-id>/00-autopsy.json \
      --run scripts/polish-notes/<article-id>/production-run.json \
      --out scripts/polish-notes/<article-id>/04-transplant-map.md

- 原稿幕 comes from `beats[].transplant.original_act_id`; 继承 renders from the AUTOPSY
  act (the dissection truth), never from the beat's own declaration; 修补 renders from
  `beats[].transplant.repair`.
- The agent fills ONLY the right columns (替换：本段意思 / 首次披露事实 / 新贡献 /
  接力（问进→问出） / 约字数).
- Hand-editing any left column is a hard failure: the validator re-renders the left
  columns and diffs them against this file.
- If an autopsy label looks wrong, return to step 0A and fix the dissection. Never
  correct the autopsy silently inside the map.

## 附表 1：修补账

Every declared repair, one row: act, injury class (from the autopsy's `injuries[]`), the
minimal repair, and the rationale. Double-entry rule: a repair exists ⇔ it appears in the
autopsy injury report AND in `beats[].transplant.repair` AND here. Missing any one entry
is a process hole. Cap: ≤30% of acts AND ≤3 acts (validator F6); beyond that, abandon
the original.

## 附表 2：洗深预声明

- Every row's target: zero sentence reuse, zero example reuse, zero metaphor reuse, zero
  gold-sentence cadence reuse.
- The literal guardrail is `scan-wash-overlap.mjs` — a copy-paste guard, not a wash-depth
  verdict; its thresholds are initial values to be recalibrated after the first three
  real transplant runs.
- The semantic guardrail is the user's side-by-side source-separation review (终审并排审).
  A green scanner never means the wash is deep.
- The opening's `skeleton_borrow` is pre-declared in the `opening_fidelity` record.

## 填写规则 (右栏)

1. 替换：本段意思 — the paragraph's meaning, subject to the same uniqueness rule as the
   outline: no two rows share a meaning in any wording, and each judgment lands in exactly
   one row. This meaning is the anchor of the paragraph's later `book_review.meaning`.
2. 首次披露事实 — fact IDs from the whitelisted new-topic material only (see
   `references/truth-and-promise.md` transplant fact-source whitelist). The original's
   facts never appear here.
3. 新贡献 — what this paragraph adds that the viewer did not already have; a restatement
   of a previous row's contribution is a defect.
4. 接力（问进→问出） — the reader-question relay in and out, consistent with the beats.
5. 约字数 — the planned length; slow scenes keep their contracted budgets.

## 内部步骤，无用户门

The map is rendered and filled internally at step 3 — there is no pre-draft user gate.
The writer (step 4) installs it strictly; a row that cannot be written sends you back to
step 3 — no silent rerouting while drafting. The user's checkpoint is the draft review
after step 4: a user-requested structural change returns here and re-renders the map
before the next draft.
