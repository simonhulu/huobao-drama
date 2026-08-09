# Book-Grounded Full-Script Blind Evaluation

## Objective

Determine whether issue-driven consultation of four writing books makes complete real scripts more
publishable. The experiment must produce manuscripts for human judgment; corpus conversion,
retrieval success, model scores, and sentence exercises cannot prove success.

## Fixed Protocol

- Use three complete, content-qualified production drafts from different subject types.
- Snapshot each baseline unchanged. Keep topic, factual content, central viewpoint, and title fixed.
- Candidate length must remain within 10 percent of the baseline.
- Do not load `polish-video-script`, author-style systems, static writing cards, or a vector database.
- Diagnose before searching. Preserve passages without a concrete defect.
- Diagnose no more than ten high-impact issue classes per manuscript.
- Retrieve no more than three bounded book excerpts per issue class.
- Edit in three stages: diagnosis, source-grounded conservative edit, rollback audit.
- Reject unsupported facts, viewpoint drift, decorative changes, and source imitation.
- Randomize A/B identity independently for each pair and hide all process artifacts from the human reviewer.

## Human Gate

For each anonymous pair, the reviewer marks whether A and B are independently publishable, then
chooses A, B, tie, or both unacceptable and records the main reason. The candidate method advances
only when all three candidate manuscripts are publishable, candidates win at least two pairs and
lose none, and no hard failure exists. A failed method is removed. Any successor must be evaluated
on a fresh three-script batch; prior samples become regression fixtures only.

## Repository Boundary

- `data/writing-corpus/`: Markdown books, manifest, coverage, and source-unit inventory.
- `tools/writing-corpus/`: import, search, OCR, and overlap utilities.
- `.omx/artifacts/book-grounded-full-script-eval/`: isolated experiment and blind-review artifacts.
- `.codex/skills/polish-video-script/`: unchanged by the experiment until the human gate passes.

## Result

The 2026-07-31 human blind review failed the method. Candidate manuscripts were 甲 in all three
pairs. Every pair was marked "both unpublishable," producing zero publishable candidates and zero
candidate wins; the reviewer also judged the baseline group, 乙, stronger overall. No book-grounded
editing behavior is promoted into `polish-video-script`. The three pairs are now regression evidence,
and any successor requires a fresh three-script batch.
