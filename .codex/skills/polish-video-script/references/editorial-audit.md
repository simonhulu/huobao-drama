# Editorial And QA Passes

Load after a paragraph or complete draft exists. This document is not part of writer mode.

## Independent Lanes

Use separate contexts where practical:

1. Truth editor: checks title promise, fact IDs, inference strength, chronology, and reconstruction boundary.
2. Retention critic: checks open loop, stake, reader-belief turns, payoff, focal distance, and structure-shell fit.
3. Human voice editor: checks spoken Chinese, historical texture, action specificity, character-specific emotion, repetition, and AI traces.
4. Persona editor: checks whether the account narrator has a clear judgment, earns compassion through circumstances, and directs heat toward the correct action or structure.

No editor may mark PASS based only on the writer planning labels.

## Paragraph Gate

For each paragraph:

- Is its factual action clear?
- Did it accomplish its beat reader-belief or state change?
- Did it repeat a fact without new meaning?
- Does its disclosure kind match the reader-knowledge state, without naming a family, office, or shorthand before the listener can identify it?
- Did any edit remove orientation, stakes, attitude, or rhythm without a concrete replacement?
- Can the reader identify each new person, office, place, and referent?
- Are emotion and judgment carried by relationship and action rather than labels and commentary?
- Does the paragraph contain at least one incremental concept? If the paragraph only restates or rearranges known information, reject it.
- Does the paragraph end with a forward-leaning bridge or unpaid consequence, except for the final close paragraph?
- Does the final close paragraph decelerate and land on the contracted charged image?

The human voice scan includes abstract placeholders, modern organizational jargon, actor-verb-object mismatches, mirrored slogans, generic cognition phrases, fake causal connectors, hollow commentary tails, time-word stitching, template openings, repeated cadence devices, archive-commentary drift, explanatory conditional templates such as `要……，得……` and its variants, and the following hard AI fingerprints:

- **Hard-coded authorial posture**: `我要说的就是这个`, `说白了`, `核心就一句话`, `关键点在于`, `大家一定要记住` — the narrator announcing his own conclusion instead of letting it emerge from the scene.
- **Direct reader summons**: `你想想那个场景`, `你品`, `你感受一下`, `想象一下`, `你可以理解为` — interrupting the scene to command the viewer to imagine, feel, or agree.
- **Manufactured contrast framing**: artificial `A 很 X，但 B 很 Y` symmetry that makes an ordinary observation sound profound without adding information (`史书把这一战记得很短，但它提出了一个很长的问题`).
- **Abstract action + gory summary**: verbs like `压上去`, `顶上去`, `冲上去` paired with vague horror labels like `一片血肉`, `尸横遍野`, `血流成河` that replace concrete visuals with generic emotional stamps.
- **Fake payload metaphors**: ornamental comparisons that do not change what the viewer understands (`他没有带X，但他带了一样东西：Y`; `他握着一把叫信任的刀`). If removing the metaphor leaves the sentence unchanged, delete the sentence.
- **Defensive completeness**: source caveats, balancing clauses, exception lists, and accuracy demonstrations that exist mainly because the writer is afraid of being wrong. If removing unsupported material upstream solves the risk, do that and keep the audit out of the spoken script.
- **Interpretive sealing**: a scene is followed by its explanation, a paragraph restates itself in abstract language, or the ending answers the same promise two or three times. Delete the completion residue and let the action or charged image keep its gap.

## Narrator Persona Gate

Reject unless all answers are yes:

1. Can a listener repeat the narrator’s `我认定______` sentence after the first third?
2. Does the script name and rebut the comforting moral frame rather than place it beside an equally weighted alternative?
3. Is judgment made before the sympathetic reconstruction of information, time, fear, and limited options?
4. Does every warm passage contain at least one concrete circumstance, rather than an AI-style "we should understand him" disclaimer?
5. Does every hot passage name a specific action, beneficiary, or cover-up, while leaving dignity to the constrained person who bears the result?
6. Is the silent party visible in at least one scene, consequence, or counted loss?
7. Do cold, warm, and hot each occur in a real beat rather than as adjectives in an outline?
8. Could the spoken passage come from this narrator without reciting his resume or imitating a catchphrase? If it would sound identical from a neutral documentary host, return to the beat.

Scan and remove balance reflexes unless a factual contrast genuinely advances the narrator’s rebuttal: `另一方面`, `但是话说回来`, `客观来说`, `也有人说`, `各有道理`, `不能简单地说`.

## Reader Relay Gate

Reject unless all answers are yes:

1. Within the opening, can the listener name who is in danger, what has already happened or is
   visibly about to happen, and why the next paragraph rewinds?
2. If the opening interrupts an action, does it hide only the outcome or cause that the listener
   has enough information to care about, rather than the basic action itself?
3. Does each paragraph enter through the previous paragraph's contracted reader question and
   answer or explicitly carry it before opening a new one?
4. Does every early stance use only names, actions, and fact IDs already disclosed to the
   listener?
5. Would any sentence require the listener to reread because it refers to a person, relation,
   event, shorthand, or “old account” not yet introduced? If so, reorder or introduce it.
6. Does the final prose, rather than only the beat map, satisfy the opening result and paragraph
   relay contract? Check the final-script validator and its paragraph locks after every late edit.

## Audience Motive Gate

Reject unless the following are concrete:

1. The opening activates the declared primary human switch through a person, danger, contradiction,
   or withheld result.
2. The middle gives the viewer the promised experience rather than explaining why the topic is
   historically difficult.
3. The historical boundary appears as a brief guard, not as the main emotional object.
4. Removing source names still leaves a tellable conflict with escalating human cost.
5. Each contracted slow scene has its promised amount of lived action, relationship pressure, and
   aftermath; two bare gestures do not count as scene work.
6. If `target_comment_rate` is set, the script has at least one planned `comment_moment` whose
   `trigger_line` names a specific sentence and whose type matches the declared `comment_strategy`.
7. Any confrontation comment moment targets a system, action, beneficiary, or cover-up, never a
   constrained person.

## Retention-vs-Comment Arbitration

Before final approval, check every comment-optimizing choice against the rules in
`metrics-contract.md`. Record any trade-off in `metric_conflict_resolution`.

Reject the script if:
- A comment tactic lowers 3s retention.
- A comment tactic lowers 5s completion by more than 5%.
- A comment tactic lowers overall completion by more than 5% without a comment-rate gain at least
  3× as large.
- The opening sacrifices conflict or stakes for an early comment prompt.

## Meaning Map (意思图谱)

Before approving the whole script, lay every paragraph's `book_review.meaning` and each
paragraph lock's `new_contribution` side by side:

- Any two body paragraphs with the same meaning — the same sense in different words counts —
  fail. Cut one, or re-split so one carries the facts and the other carries the closure, and
  the closure must add a new relation.
- Each judgment is stated once in the whole script. A restatement in new words is completion
  residue: keep the strongest instance, delete the rest.
- A close-act recap of already-disclosed facts must compute a new relation (contrast, ranking,
  pattern). A plain re-listing is rejected.
- Record the map and its verdicts as a `meaning_map` entry in `audit-log.jsonl`.

## Whole-Script Gate

Reject unless all answers are yes:

1. The title promise has a named answer fact or a named source boundary.
2. The opening establishes a question and a concrete stake.
3. Middle turns change reader understanding; they do not merely add biography.
4. Each slow scene has a distinct reason to be slow.
5. Narrator attitude survives without explanatory paragraph endings.
6. The ending answers the opening promise before reusing an earlier charged image.
7. The final three sentences decelerate and stop on a concrete noun or verb.
8. No high-risk reconstruction carries the article decisive causal proof.
9. The opening follows its chosen information order rather than a generic official-claim-versus-truth hook.
10. Each planned slow scene is one of the scenes actually written; no uncommitted scene displaces the contracted material.
11. The information-gap contract is visible in the prose: creator-owned gaps pay later, viewer-owned gaps remain with the viewer, and intentional omissions do not break the fact chain.
12. At least one completion residue was identified and deleted; “nothing can be removed” is evidence that the draft was optimized for article-like completeness.
13. At least one designed error in stance, opinion, or emotion was identified and deliberately kept — a 一家之言 judgment the audience can argue back against. A script polished into a safe, balanced, complete account fails this gate. Designed errors are not written flaws: 病句 and factual errors remain violations.
14. No two body paragraphs state the same meaning in any wording, no judgment appears more than once, and the `meaning_map` record exists in `audit-log.jsonl`.

## Audit Records

Save concise evidence, not self-certification:

    {
      "finding": "biography_disguised_as_causality",
      "evidence": "B4 cannot name an actor choice changed by the material",
      "repair": "remove B4 or convert it to a factual condition with a next action",
      "verdict": "reject"
    }

An audit record must name the violated contract, concrete evidence, repair, and verdict. “结构清晰”“文风自然”“PASS” are not evidence.
