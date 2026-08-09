---
name: polish-video-script
description: "Create or polish Chinese historical演义 video scripts through one canonical 13-step workflow with seven stable final artifacts: confirmed topic, creative plan, outline, first draft, final script, title, and publishing package; keep research, audits, repairs, and hashes in a temporary workspace and delete them after successful completion. The creator owns judgment and final approval; AI owns routing and diagnostics."
---

# Polish Video Script

## Product Contract

Act as a patient writing teacher and a precise creative tool. The creator owns the topic,
judgment, private experience, final wording, and final approval. AI owns public research, the
production sequence, structural diagnosis, drafting, concrete explanation, and independent risk
review. Once the request is sufficiently specified, AI must route the work to the next production
step without requiring the creator to design that step. The pauses are the source-input question
before Step 1 and the explicit creator confirmations in Step 1 (topic) and Step 12 (title).

### Top-Level Historical演义 Requirements

The product is a compelling historical演义 story for both younger and older viewers. Historical
material is raw story material, not a chronology, evidence set, or paper to be reconstructed.
Historical precision is not a goal, a gate, or an audit target. Do not spend the writer's or
reviewer's attention on source completeness, exact chronology, exact wording, or documentary
certainty. Spend it on story quality: a clear desire, escalating opposition, emotional movement,
causal plausibility, memorable scenes, and a paid-off ending.

This skill has no `科普` or `考据` mode. Do not start factual review, source verification, or an
accuracy gate for any historical演义 request. If a separate request requires documentary accuracy,
it belongs outside this story-first skill and must not redirect this workflow.

Every draft must satisfy all of these requirements:

1. It must tell a story, not report a list of facts. Historical material must enter through a
   person, choice, conflict, consequence, or revealing scene.
2. The plot and audience understanding must advance stage by stage. Each stage must increase the
   stakes, narrow the unanswered question, reverse an expectation, or pay a prior promise.
3. Any scene must contain concrete sensory or situational detail: where and when it happens, what
   is visible or audible, who is present, and what is being done.
4. Any person who materially drives the story must receive concrete character detail, including
   relevant psychology, appearance, physical behavior, speech, or decision-making. Do not replace
   characterization with an abstract label.
5. The prose must be read sentence by sentence for fluency. A draft with a grammatical error,
   unclear reference, missing component, swallowed fixed verb, or other ill-formed sentence fails
   review even when the overall story is compelling.

In this mode, the writer may compress time, combine events or roles, reorder material, invent
dialogue and interiority, and dramatize connective scenes. These are story decisions, not defects.
The only hard boundary is internal story logic: characters must want something, actions must create
consequences, and the ending must pay the promise made by the opening.

The creator remains the final author. These requirements govern AI drafts and revisions; they do
not authorize the assistant to rewrite creator-locked text without an explicit request.

The default pipeline begins with a complete first draft. That draft is explicitly provisional and
must go through whole-script structural review before any section rewrite. Do not confuse a first
draft with final approval, and do not make the creator manually orchestrate the transition between
research, planning, drafting, review, rewriting, and assembly.
Never generate a complete script and ask the creator to approve it afterward; route it through the
remaining audits and targeted repairs first.

The workflow supports two source paths, selected by one required intake question:

- **有原稿:** use the supplied original as a structural reference. It contributes only abstract act
  functions, hook mechanics, answer-state transitions, rhythm, and emotional movement. New facts,
  examples, stance, judgment, scenes, wording, and payoff come from the confirmed topic and creator-
  authorized material. Run `原稿解剖` after topic confirmation, then search and curate before Step 2;
  do not line-edit, wash, or cosmetically rename the original.
- **无原稿:** do not request a missing original. After topic confirmation, gather story material,
  then let history agents design the complete structure in Step 2; this is an independent creation
  path, not an incomplete transplant.

Before invoking any agent or treating pasted material as a source, ask exactly one question:
`这次有原稿吗？有的话请直接提供或确认要使用的原稿；没有的话回复“没有”，我会直接进入主题确认。`
If yes but no source is supplied, request only that original and pause. If no, persist `mode = generate`
and enter Step 1 immediately; never ask for a skeleton separately. The creator does not need to
restate the remaining workflow; the assistant owns every later process prompt.

## Invocation Lock

1. An explicit `$polish-video-script` invocation pins this skill for the whole request.
2. Do not recommend or switch to another writing skill.
3. Resolve domain protection internally; never output a ranked menu of workflows.
4. Do not turn scope checks into a workflow menu; the single source-input question above is the
   only required intake choice.

## User-Facing Terminology

Keep `autopsy`, `AUTOPSY_READY`, `autopsy_complete`, and `00-autopsy.md` as internal identifiers only; the same rule applies to `00-autopsy.json` and other compatibility keys.
Use `原稿解剖` as the Chinese display name in creator-facing progress updates, headings, summaries, audit notes, and generated artifact prose. `骨架拆解` is acceptable as a descriptive phrase.
Never render the workflow stage as `尸检`, `验尸`, or `尸体解剖`.
Preserve `尸检` only when it is part of quoted or subject-matter content about an actual forensic examination; never reuse it as workflow metadata.

Say `原稿解剖完成` and `原稿解剖结论速览`, never `尸检完成` or `尸检结论速览`.

## Domain Guard Resolution (Automatic, Not A Workflow)

- For Buddhist scripture, canonical religious text, or named philosophical concepts, load
  `../dharma-video-script/references/concept-boundary.md`.
- Add `../dharma-video-script/agents/scripture-fact-checker.md` as an additional internal audit, not a handoff.
- For historical material, use the creator's story contract and the curated story-material pool.
  Do not add a historical accuracy review or fact-precision gate.
- Historical material is not required to preserve exact dates, quotations, chronology, or recorded
  motives. Review only whether the chosen material supports the story's internal causal chain.
- This skill has no factual-review branch. Do not activate one even if a historical topic sounds like
  a question that could be answered as科普 or考据; keep the work inside the story contract.

## Tier-0 Invariants

No retention, speed, or style benefit may override these rules:

1. **Stance and emotion**: never deliver a script with an unclear position, weak attitude, or
   absent emotional movement. Every publishable script must make its position unmistakable,
   express a distinct and forceful attitude, and move the audience through a deliberate emotional
   arc. If the reader cannot tell what the author supports, opposes, ranks, or wants the audience
   to feel, the draft fails regardless of factual density, fluency, or structural completeness.
2. **Agency**: never infer approval, prewrite future prose, mutate locked text, or adopt a private
   experience on the creator's behalf.
3. **Origin**: `我见过 / 我经历过 / 我发现 / 我认为` must trace to the creator. AI may propose a
   public-evidence judgment, but cannot disguise it as lived experience.
4. **Payment**: promise and payoff must match in value currency, subject, and scope.
5. **Separation**: when an original exists, it supplies skeleton only; no borrowed fact chain,
   example, stance, sentence, or signature phrase may survive. In generate mode, the structure is
   newly designed and has no source-transplant separation requirement.
6. **Story language**: AI-authored publishable prose may use dialogue, interiority, metaphor,
   compression, and dramatic reconstruction when they make the scene or conflict stronger. Do not
   use decoration to replace action, causality, or a meaningful choice.

## Load At Point Of Use

| Need | Load |
| --- | --- |
| Li Mola theory and diagnostics | `references/li-mola-framework.md` |
| Original skeleton extraction (only when an original exists) | `agents/original-autopsy.md` |
| Search design | `references/violent-search.md` |
| Story-material curation | `references/fact-curation.md` |
| Story promise boundaries | `references/truth-and-promise.md` |
| History planning | `history-premise-desire`, `history-character-empathy`, `history-escalating-obstacles`, `history-three-act-oral-structure`, `history-scene-turns`, `history-theme-arc`, `history-audience-emotion-arc`, `history-narration-agent` |
| Historical story structure gate | `agents/historical-story-reviewer.md` |
| Grammar | `agents/sentence-health-auditor.md` |
| Cognitive relay | `slippery-slope-guided-communication` |
| Emotion progression | `agents/logic-emotion-auditor.md` or the installed emotion auditor |
| Topic angle | `viral-topic-creator` |
| Opening and ending | `viral-opening-optimizer`, `viral-ending-engagement` |
| Title | `viral-title-agent` |
| Retention windows and stage relay | `references/prepublish-diagnostics.md`, then `agents/retention-auditor.md` |
| Comment and share motives | `references/prepublish-diagnostics.md`, then `agents/comment-share-auditor.md` |

Do not load the old `references/writer-pass.md` or `references/progressive-coauthoring.md` as an
execution route. They remain only for interpreting legacy artifacts.

## Run Artifacts

Store each run under `scripts/polish-notes/<article-id>/`, but expose only these seven stable,
human-facing files in the completed directory. Do not add version suffixes, agent names, hashes, or
subdirectories to these final names:

这里的“每一步”指七个用户可见的产出阶段；内部 13-step 审查和修复仍按顺序执行，但不单独
生成成品文件。

```text
01-confirmed-topic.md   # confirmed topic, source choice, audience, promise, and story contract
02-creative-plan.md     # creative strategy, central force, conflict, escalation, theme, and stance
03-outline.md           # ordered paragraph/scene outline and each paragraph's job
04-first-draft.md       # the complete glm_writer draft before targeted repairs
05-final-script.md      # the final spoken script; confirmed title is written into its frontmatter
06-title.md             # the confirmed title only; candidate titles are temporary
07-publishing-package.json # database handoff: hooks, creative brief, and editable cover design
```

Search results, source copies, candidate packets, fact/story-material pools, audit reports, repair
versions, hash manifests, timing records, run logs, and agent-review directories are working data,
not deliverables. Write them only in a temporary workspace outside the completed run directory.
They must be removed after Step 13 succeeds. A completed run is invalid if any other file or
subdirectory remains under `scripts/polish-notes/<article-id>/`.

The seven files have one owner and one update rule: Step 1 writes `01-confirmed-topic.md`; the
planning phase writes `02-creative-plan.md` and `03-outline.md`; Step 3 writes
`04-first-draft.md`; Step 11 writes `05-final-script.md`; Step 12 writes `06-title.md` and updates
the frontmatter of `05-final-script.md`; Step 13 writes `07-publishing-package.json`. Never preserve superseded versions beside the current
file. Hashes may be computed in memory or in the temporary workspace, but never become extra final
files.

If a legacy validator needs `03-progressive-run.v2.json`, create it only in the temporary workspace
and delete it during finalization. It is compatibility state, not a user-facing run artifact.

## Canonical 13-Step Workflow

This is the only production route for new and revised runs. Keep the order exactly as written.
The source-input question occurs before Step 1 and is not a second production route. The assistant
routes to the next step automatically after the current step's pass condition is met. Do not ask
the creator to say “continue”. Step 1 and Step 12 are mandatory creator gates; no agent
recommendation can pass either gate. A changed topic, story contract, stance, duration, or paragraph
makes every dependent later artifact stale.

### Step 1. `$viral-topic-creator` 创作主题并确认故事合同

**输入:** the persisted source choice, a broad topic, existing draft or source material when
available, and target audience/platform/duration. A proven original script/transcript is optional;
when present, it is the source for the abstract structure only.

**动作 A — 主题候选:** invoke `$viral-topic-creator`. It must produce at least six angles, one
recommended main plan, two backups, the audience, main hole, promised payoff, story direction,
and risks. It creates topic angles only; it does not write a title or prose. Keep the candidate
packet in the temporary workspace and show the creator the main plan and backups.

**动作 B — 用户确认闸门:** wait for an explicit creator decision such as `确认主方案 1` or
`就用这个主题`. Do not treat silence, a draft's existing topic, or the agent's recommendation as
confirmation. Until confirmation, do not research, dissect the original, call history agents, or
write any prose. If the creator rejects all candidates, rerun `$viral-topic-creator` with the
creator's correction.

**动作 C — 故事合同:** after confirmation, record the exact confirmed topic and lock audience,
duration, desired final feeling, protagonist or central force, desire, core opposition, climax,
and ending payment. In original mode, dissect the original only for abstract hook/act functions,
question-state transitions, rhythm, and emotional movement. In generate mode, skip dissection
entirely. In both modes, gather only story-bearing material in the temporary workspace. The writer
may select, compress, combine, reorder, or invent connective material; there is no
historical-precision inventory to complete.

**产出:** `01-confirmed-topic.md`, containing the source choice, exact confirmed topic, story
contract, and the explicit `topic_confirmed` record. Candidate angles and story material remain in
the temporary workspace. No publishable prose.

**通过:** the creator has explicitly confirmed one topic; the exact confirmed text is persisted;
the story contract names a desire, opposition, escalation, climax, and payoff; and, in original
mode, the original contributes no wording or signature phrase.

**下一步:** Step 2. If the creator selected original mode but the original is missing, remain at
the source-input gate and request that one item; if topic confirmation is missing, remain at the
topic gate and do not continue.

### Step 2. history agents 设计创作方案

**输入:** Step 1 story contract, story-material pool, and either the original-mode abstract skeleton or the
generate-mode topic-driven provisional requirements.

**动作:** use `history-narration-agent` as the planning coordinator and run its required planning
passes: `history-premise-desire`, `history-character-empathy`, `history-escalating-obstacles`,
`history-three-act-oral-structure`, `history-scene-turns`, `history-theme-arc`, and
`history-audience-emotion-arc`. These agents design; they do not write the complete script.

**产出:** `02-creative-plan.md` containing the protagonist/central force and desire, concrete
obstacles in increasing cost (`阻击 / 消耗 / 分裂 / 终局` where applicable), scene turns, causal
three-act shape, author stance and contribution ranking, and theme. Write the ordered paragraph map
and each paragraph's job separately to `03-outline.md`. These are the only two user-facing planning
files; agent-specific plans and material pools remain temporary. Material without a story job is
discarded. The plan may use only three to six load-bearing scenes; coverage of every dynasty,
event, or search result is forbidden.

**通过:** every paragraph has one action, one obstacle, one consequence, one belief change, and a
relay question; the plan names the climax, its payment, and the post-climax release. No paragraph
is a free-standing information bundle. No plan section contains ready-to-read prose.

**下一步:** Step 3. If a required turn lacks a story function, return to Step 2 and remove or
replace the material.

### Step 3. `glm_writer` 写完整初稿

**输入:** the complete Step 1 story contract and story-material pool plus the locked Step 2 plan.

**动作:** call `glm_writer` to write one complete manuscript. It is the only agent allowed to
write publishable prose. The draft must include opening, causal chain, escalating emotion, climax,
payoff, and ending. Do not expose planning labels such as S1-S6 in spoken text. Do not write a
chronology or cover the material pool. Delete anything that does not move the central story.

For every paragraph, enforce this private relay: `current desire -> obstacle -> action/result ->
new audience belief -> next unanswered question`. One paragraph may not contain multiple unrelated
periods, dynasties, or examples merely to increase coverage. Historical material may be compressed,
reordered, merged, or expanded with connective drama when the story needs it. Privilege scene,
choice, reversal, and consequence over explanation and summary.

**产出:** `04-first-draft.md`. Keep its content hash in memory or in the temporary workspace.

**通过:** the manuscript has a visible stance and emotional movement, every paragraph changes the
story state, each handoff creates a necessary next question, and the manuscript reads as a spoken
story rather than a fact list or analysis report. Historical precision is not a pass condition.

**下一步:** Step 4. If the named writer fails, retry `glm_writer`; never substitute another writer
or generate fallback prose.

### Step 4. 句法审查

**输入:** the exact bytes and hash of `04-first-draft.md`.

**动作:** run the read-only `sentence-health-auditor`. Check sentence fluency, grammar, references,
fixed verb-object compounds, and paragraph-level sentence clarity. The Step 1 story contract and
story-material pool remain input constraints; this step does not verify historical precision. In
original mode, structural and wording separation from the source remains a separate creator
side-by-side review.

**产出:** no completed-directory file. Put the read-only findings in the temporary workspace or
pass them directly to Step 7. Every actionable finding must name paragraph id, severity, exact
quote, violated contract, and the smallest repair direction. Reviewers do not rewrite the
manuscript.

**通过:** all required reports exist and are bound to the same draft hash. `通过` here means the
audit is complete, not that the draft has no findings; all findings wait for Step 7.

**下一步:** Step 5, even when findings exist.

### Step 5. 历史故事结构门 + slippery 审核认知接力

**输入:** the same draft bytes and hash from Step 4.

**动作:** first invoke `agents/historical-story-reviewer.md` as a mandatory story-structure gate.
It checks that material enters through a person, choice, conflict, action, consequence, or scene;
that each paragraph changes the story state; that scenes and driving characters have concrete
detail; and that sentences are readable. It does not check dates, sources, quotations, or external
historical accuracy. The reviewer diagnoses and gives minimum repair directions; it does not rewrite.

Then invoke `slippery-slope-guided-communication` (short name: `slippery`). Make only three
decisions that can change the repair: whether each handoff continues the main question, whether
the next paragraph is made necessary by an unanswered question or consequence, and whether the
ending pays the central promise at the promised scope. Do not duplicate the story-structure,
historical-precision, physical, or emotion review. The slippery agent diagnoses and gives a minimal
repair packet; it does not rewrite prose.

**产出:** no completed-directory file. Keep the historical-story and slippery findings temporary;
if they pass, retain only their hash and short verdict in working memory or the temporary workspace.
If it fails, report only the affected paragraph or handoff, the exact quote, one core failure, and
one minimal repair direction. Do not output a full paragraph matrix or restate successful relays.

**通过:** the historical story reviewer passes, and the slippery report makes a repair decision
for the opening, the handoffs that fail, the climax transition, and the ending payment. Both are
bound to the Step 4 hash. Passing sections need no separate entry.

**下一步:** Step 6, regardless of pass or findings.

### Step 6. emotion auditor 审核情绪推进

**输入:** the same draft bytes and hash from Steps 4-5.

**动作:** invoke the emotion auditor; in this repository its default implementation is
`agents/logic-emotion-auditor.md`. Make only three decisions that can change the repair: whether
the intended feeling is triggered by a concrete fact, action, loss, choice, or consequence;
whether pressure and cost rise or change as the obstacles advance; and whether the climax is earned
and the ending releases the intended feeling. Reject emotion labels that have no concrete trigger.
Do not repeat sentence, historical, physical, cognitive-relay, viewpoint, or information-density
checks. The auditor reports; it does not rewrite.

**产出:** no completed-directory file. Keep the emotion findings temporary; if it passes, retain
only its hash and short verdict in working memory or the temporary workspace. If it fails, report
only the affected paragraph or contiguous passage, the exact quote, one core emotion failure, and
one minimal repair direction. Do not output a start/end emotion matrix, paragraph-by-paragraph
scorecard, or general praise.

**通过:** the report makes a repair decision only for trigger, escalation, climax, or release
failures and is bound to the same hash. Findings are repaired only in Step 7.

**下一步:** Step 7.

### Step 7. 只修失败段，不全文重写

**输入:** all findings from Steps 4-6 and the unchanged draft.

**动作:** give `glm_writer` only the failed paragraph(s), one adjacent paragraph of context on each
side, the relevant story materials, the plan row, and the reviewer repair direction. Rewrite the
smallest contiguous block that fixes the failure. Keep every passing paragraph byte-identical.
Preserve concrete action, authorial voice, stance, and the original emotional intention; do not add
abstract labels, report-like summaries, or generic transitions. New connective drama is allowed
when it repairs the story. Never ask a reviewer to rewrite the full manuscript and never perform a
whole-document “merge polish”. If there are no failed paragraphs, copy the candidate unchanged and
record a no-op; do not invent a rewrite.

**产出:** no completed-directory file. Keep the repaired candidate and old/new paragraph hashes in
the temporary workspace until the next audit; never create versioned repair files beside the draft.

**通过:** every blocker has a targeted repair or an explicit creator-approved waiver, and no
unrelated paragraph changed.

**下一步:** Step 8. If a repair changes a new paragraph's meaning, add that paragraph to the next
audit scope rather than expanding the rewrite.

### Step 8. 重新跑 slippery 和 emotion 审核

**输入:** the repaired candidate's exact bytes and new hash.

**动作:** rerun `slippery` and the emotion auditor against the new hash. Rerun only the failed
Step 4 sentence checks for paragraphs touched by the repair, plus any check whose
evidence became stale. Do not reuse a report from another hash.

**产出:** no completed-directory file. Keep the post-repair reports temporary and discard them
after the repaired candidate passes.

**通过:** slippery, emotion, and all affected Step 4 checks pass on the same repaired hash.

**下一步:** Step 9. If any check fails, return to Step 7 with only its failed paragraph(s).

### Step 9. `viral-opening-optimizer` 优化开头

**输入:** the stable body, the confirmed topic promise and any existing cover context, and the
Step 8 hash. The final title does not exist yet; Step 12 creates it.

**动作:** call `viral-opening-optimizer` and use its二维向量法。先读取 `02-creative-plan.md` 或
`03-outline.md`里的情绪设计，选择开头段落已经承担的情绪；再读取创作方案和大纲里的核心冲突、
受众默认判断和下一段任务，选择一种正文主线支持的认知劫持。不要凭题目或个人偏好临时指定
情绪或认知元素。然后把两者组合成同一个“凭什么/怎么可能”的冲突。开头给出第一笔具体事件支付，
但保留完整机制答案。
它可以提出一个推荐开头候选，必要时再提供对照候选；候选长度由情绪、认知和主洞是否完成决定，
`glm_writer` 写最终版本。只改开头，不添加与故事合同无关的内容；历史演义稿可以重构对白、
心理和现场细节，但必须服务冲突。记录所选情绪、认知元素、
触发事实和新 hash。

**产出:** no completed-directory file. Keep the optimizer report and any changed candidate in the
temporary workspace; update only the in-memory current candidate.

**通过:** 开头只使用一种情绪和一种认知劫持，两者由同一个事实冲突连接；观众能产生一个明确
的“凭什么/怎么可能”问题；第一笔事实已经支付但完整答案仍未公布；正文能够论证这个反差；
报告绑定 Step 9 输入 hash，任何改写都记录新 hash。

**下一步:** Step 10. Any changed hash makes prior audits stale; Step 11 must rerun them.

### Step 10. `viral-ending-engagement` 优化结尾

**输入:** the current manuscript and hash after Step 9.

**动作:** call `viral-ending-engagement` to verify that the opening/title promise is paid before
interaction and to identify a concrete viewer-owned judgment gap. `glm_writer` writes a focused
ending repair when needed. Change only the ending paragraphs; do not add unrelated story material,
a generic CTA, or an unearned moral.

**产出:** no completed-directory file. Keep the optimizer report and current candidate temporary.

**通过:** the promise is paid, the ending leaves a specific audience judgment or choice, and the
optimizer report is bound to the Step 10 input hash while any writer repair records its output hash.

**下一步:** Step 11. Any changed hash makes all earlier reports stale.

### Step 11. 最终机械扫描与同哈希终审

**输入:** the exact candidate bytes after Step 10.

**动作:** run the mechanical sentence scan `scan-sentence-health.mjs`, plus
`scan-wash-overlap.mjs` when a transplant original exists. Rerun all required reviewers (historical
story structure, sentence, slippery, emotion, opening, and ending) against the final hash. Run
prepublication retention and comment/share diagnostics as `pass`, `risk`, or `block`, never as
numeric performance forecasts.

**产出:** `05-final-script.md`, containing the final spoken body before title metadata is added.
Keep the final body audit record and hash manifest temporary.

**通过:** every required audit and scan is `pass` or an explicitly documented non-blocking warning,
and every report contains the exact same final content hash. Any text edit, however small, returns
to the stale-audit rule and prevents final handoff until rerun.

**下一步:** Step 12. Do not hand off or send the body to remotion-history-factory before the
confirmed title metadata exists.

### Step 12. `$viral-title-agent` 创作标题、用户确认并写入文稿

**输入:** the exact body from Step 11, its final body hash, the confirmed topic, title/cover
context, and the paid promise.

**动作 A — 标题候选:** invoke `$viral-title-agent`. It must extract real facts, the audience
benefit, and one core promise from the finished body; generate at least 12 candidates across at
least six title methods; then output one recommendation, 3-5 alternatives, the promise each title
makes, and the body evidence that pays it. The agent does not change the body.

**动作 B — 用户确认闸门:** show the candidates and wait for an explicit creator decision such as
`确认标题：<exact title>`. Never select the recommendation automatically. If the creator rejects
all candidates, rerun `$viral-title-agent` with the correction. No title confirmation means no
final handoff.

**动作 C — 写入文稿元数据:** after confirmation, write the exact title once as machine-readable
frontmatter at the top of the final manuscript:

```yaml
---
title: "<JSON-escaped confirmed title>"
---
```

Keep the spoken body byte-for-byte identical below the closing `---`; the title is metadata, not
spoken narration. Write only the confirmed title and its confirmation record to `06-title.md`.
Write the same confirmed title into `05-final-script.md`; keep candidate titles and hashes temporary.

**通过:** the exact title was explicitly confirmed by the creator, appears exactly once in the
frontmatter, parses as a string, and the body hash is unchanged from Step 11. Do not derive another
title from the filename, topic, first sentence, or remotion-history-factory.

**下一步:** Step 13. Do not hand off or send the body to remotion-history-factory before the
publishing package exists.

### Step 13. Publishing package handoff

**输入:** the confirmed title metadata, the final script, `02-creative-plan.md`, `03-outline.md`,
and the opening/ending audit records.

**动作:** load `references/publishing-package.md` and write the machine-readable handoff package
as `07-publishing-package.json`.

The package is the contract between `polish-video-script`, `remotion-history-factory`, and the
platform publishers:

- `title` must exactly equal the confirmed title in `06-title.md` and the frontmatter of
  `05-final-script.md`.
- `opening_hook` and `cliffhanger` are the two social-platform description hooks. They must be
  emotionally specific, create an unanswered question, and be supported by the final script. Do
  not leave them for the publisher to invent.
- `creative_brief` is the structured, extensible projection of the creative plan: stance,
  audience, promise, emotional arc/gap, source anchor, and behavioral payoff.
- `cover_design` contains editable cover copy and the image-generation prompt. It is a design
  specification, not a rendered image. The history factory generates both cover ratios and stores
  their URLs in the episode database.
- `chapter_hooks` (optional) drives the top chapter suspense bar in the rendered video: one hook
  per narrative chapter of `03-outline.md`, each with a `label` (at most 12 Chinese characters,
  written as a suspense hook, not a catalog name) and an optional `anchor` copied from the opening
  of the chapter's first narration sentence. The hook count must equal the episode's narrative
  sequence count; the factory fails on mismatch.

The package may be edited as a normal JSON artifact before factory production. The factory
validates its schema, stores the complete object and its fingerprint in the episode record, and
rejects a title/package mismatch.

**产出:** `07-publishing-package.json` containing `schema_version`, `title`, `opening_hook`,
`cliffhanger`, `creative_brief`, `cover_design`, and optionally `chapter_hooks`.

**通过:** the JSON parses; all required fields are non-empty; title equality passes; cover main
title is at most 8 Chinese characters; cover subtitle is at most 4 Chinese characters; and the
image prompt explicitly forbids generated text, logos, and watermarks. When `chapter_hooks` is
present, every label is at most 12 Chinese characters and the hook count matches the outline
chapter count.

### Finalization and cleanup

After the creator confirms the title and the publishing package passes validation, delete the
temporary workspace and remove every file and directory in the run folder except the seven canonical artifacts above.
Verify the exact list, verify that `05-final-script.md` contains the
confirmed title, verify that `07-publishing-package.json` has the same title, and only then hand
it off. Never delete creator-provided source material outside the run's temporary workspace.

The factory consumes `07-publishing-package.json` and writes the package fields and generated
cover URLs to the episode database. A publisher must read those database fields and may only
perform platform-specific normalization, such as strict cover resizing; it must not regenerate
the copy.

### Routing and repair rules

- Route automatically from one passed step to the named next step, except that the source-input
  question and Steps 1 and 12 pause for explicit creator confirmation; never create a second
  “legacy” route for new work.
- A reviewer is read-only. `glm_writer` is the sole prose writer and receives only the scope needed
  for its assigned draft or repair.
- An audit contract is a diagnostic checklist, never a sentence template. Concrete scenes, actions,
  causal verbs, and narrator voice outrank abstract audit vocabulary.
- A finding names the smallest affected paragraph. Do not rewrite passing paragraphs to make the
  manuscript “more consistent”.
- Store every report with `sha256(text)` of the exact input. A stale hash invalidates the report.
- Keep two hashes when Step 12 adds metadata: `body_sha256` for all prose audits and
  `manuscript_sha256` for the final file. Adding the confirmed title must not alter `body_sha256`.
- If the creator supplies locked wording, preserve it byte-for-byte unless the creator explicitly
  requests a change. Creator changes reopen only dependent steps.

## Li Mola Operational Rules

Load `references/li-mola-framework.md` and enforce:

- One main hole. Every stage must shrink, deepen, reverse, raise, or pay it.
- A hook creates a precise information absence; a question mark or visible conflict is optional.
- The opening must stand without title/cover and promise something worth waiting for.
- 山 is costly opposition; 海 is belief-changing exploration; 墓 is a real boundary or forbidden
  access; 色 is an emotion/desire that is itself the consumed product.
- Emotion may beat exhaustive explanation, but never causal clarity or promise payment.
- Use a wide instinct to attract and a vertical judgment to retain.
- Public information is raw material. Creator selection and judgment are the nonreplaceable value.

## Prepublication Diagnostic Boundary

Never predict a numeric 2-second bounce, 5-second completion, overall completion, comment, or share rate.
Those are post-publication observations. Before publication, report only `pass`, `risk`, or `block`
with an exact locked quote, the affected stage, and a minimal repair proposal.

A generic CTA is not a comment trigger. A local hook is not sustained retention. The retention
audit passes only when every required window and stage relay passes; the comment/share audit passes
only when both motives are evidenced in locked text. Both audits must bind the current assembly
hash and become stale after any text change.

## Ten-minute Discipline

Optimize active creator time without removing creator authority:

- show one draft per stage;
- keep default rationale to three specific bullets;
- group prose by semantic job, not sentence-by-sentence approval;
- show diffs after revision, not the whole history;
- reuse provided Creator Bible and topic material;
- prefetch evidence in the background, never future prose;
- let one-word answers handle the separate advance question.

Measure required intake, reading, editing, locking, advance confirmation, audit decisions, and
audit-triggered revision. Exclude only skill learning, AI/tool search, model execution, system wait,
and explicit pauses. If a run exceeds ten active minutes, report it honestly; do not skip a stage,
lock, story contract, or permission to protect the metric.

## Legacy Compatibility

Existing V1 `production-run.json`, paragraph locks, and validator outputs remain readable by the
legacy scripts. If a new run needs `03-progressive-run.v2.json` or another compatibility record,
create it only in the temporary workspace and remove it before handoff. Do not rewrite historical
run artifacts in place.
