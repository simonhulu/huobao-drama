# Prepublish Retention And Engagement Diagnostics

Use these diagnostics only after the exact locked stages have been assembled. They estimate script
risk; they do not measure platform performance.

## Non-negotiable Boundary

Never predict a numeric 2-second bounce, 5-second completion, overall completion, comment, or share rate.
Those are observed platform outcomes affected by delivery, first frame, editing, audience fit, and
distribution. Before publication, report only `pass`, `risk`, or `block`, with quoted evidence and
a minimal repair location.

## Timing Basis

Prefer real narration timestamps when they already exist. Otherwise run
`scripts/build-attention-timeline.mjs` and label every time claim `character_ratio_estimate`.
Character-ratio timing identifies where to inspect; it does not turn a script into observed data.

## Retention Diagnostic

Inspect five windows:

1. `0_2s`: a concrete person, abnormal result, cost, forbidden boundary, desired experience, or
   other immediate reason not to swipe. Orientation must be clear without title or cover.
2. `2_5s`: the viewer can state the main missing information in one sentence and knows why the
   answer is worth waiting for.
3. `5_15s`: the script supplies its first proof, scene, consequence, or partial payment. Pure
   withholding is clickbait, not retention.
4. `body`: every semantic stage contributes new evidence or emotion, changes the answer-state, and
   hands forward one related pull. Unrelated suspense, repeated judgment, and flat background fail.
5. `ending`: the promised subject, scope, and value currency are paid. An honest open ending still
   pays known evidence, competing explanations, or a useful judgment.

Then inspect the entire stage chain. A locally strong hook cannot pass if later stages stop changing
what the viewer believes or feels.

## Comment And Share Diagnostic

Do not count a generic CTA as engagement design. `你怎么看`, `评论区告诉我`, and `欢迎留言` are not
reasons to comment.

A valid comment trigger needs:

- one exact locked line;
- one mechanism: resonance, confrontation, expression, or relation;
- one plausible example comment;
- a viewer-owned judgment or experience gap that the script does not later answer.

The viewer-owned gap is not an unpaid creator debt. The main hole and factual subholes must still be
paid. What remains open belongs to the viewer: their experience, moral judgment, identity, choice,
or relationship.

A valid share trigger needs:

- one exact locked line;
- a specific recipient or social situation;
- a reason sending the video communicates something for the sender;
- a one-sentence retelling of the story or judgment.

## Verdict And Repair

Bind both diagnostics to the exact assembly hash. A `risk` or `block` finding makes that audit fail.
The auditor may identify the affected stage and propose a minimal patch, but cannot edit locked
text. The creator decides whether to unlock and revise.
