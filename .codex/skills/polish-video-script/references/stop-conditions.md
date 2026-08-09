# Stop Conditions (Canonical List)

Load this file at every audit and every user gate. Reject or return upstream when any condition
below holds. It is not loaded upfront; the workflow steps state which gate or audit reads it.

Reject or return upstream when:

- the title promise cannot be answered at its stated strength;
- `00-stance.md` is missing any of its three mandatory lines (我认定 / 恨我的人相信 / 他们会截图这一句), or the model wrote the stance instead of the human — the model's job at step 0 is the angle brief (lens read-out, original debts, comment evidence), never a scored candidate the human merely approves;
- a stance's decision trace (我差点选___，否掉因为___) leaked from `00-stance.md` into the finished script — it is a process record for the human, and naming the rejected adjacent stance in-script hands the viewer the alternative reading, which undercuts the divisive-stance requirement;
- no primary human switch, story paradox, or viewer payoff is named;
- the target metrics are missing or the script is not judged against them;
- the opening does not deliver a concrete value claim within 15 seconds;
- the opening does not establish a person, opposition, or cost at its very start (no hard character-count bound — the conflict must be present in the first sentence, told as a description with a picture, not a telegraphic summary);
- the opening uses a forbidden hook type (self-intro, meta, false empathy, self-congratulation, pseudo-interactive hooks such as `你有没有想过/感觉/发现`, `有个问题你肯定想过`, `是不是有时候`);
- the clean script contains production-provenance leakage (`原稿`, `用户提供`, `这版故事`, `我不会继续讲`, `根据材料`, `本稿` or equivalent) outside an episode whose subject is the writing/editing process itself;
- the script breaks its own story logic: a character acts without a desire, an action has no consequence, or the ending contradicts the setup;
- every creator-owned loop is closed immediately, every scene is interpreted for the viewer, or the title answer is repeated in multiple paraphrases;
- comment optimization is active but no viewer-owned gap is recorded, or the narrator later answers a gap that was supposed to belong to the viewer;
- the 25–35% mark has no re-engagement beat;
- body segments exceed 3 minutes without a pattern interrupt;
- a source silence has displaced a stronger human conflict as the main story engine;
- the narrator has no concrete `我认定______` stance, or presents understanding before judgment;
- the stance is safe: no specific, nameable group would hate it, or the angle was chosen precisely because nobody could object;
- the opinion layer was polished toward balance, completeness, or correctness — every objection pre-answered, every disputable judgment hedged into safety, no 一家之言 survives;
- a designed error in stance, opinion, or emotion was removed in the name of quality (designed errors are not written flaws: 病句 and factual errors remain violations);
- a beat drops the active viewer question, opens unrelated mysteries, or cites a person or event the viewer has not met;
- a stance depends on a setup first disclosed after its reveal beat;
- the script’s anger targets a constrained person while the beneficiary, designer, or coverer remains unnamed;
- a structure shell manufactures facts or causality;
- author material is being used as biography filler instead of reasoning;
- a slow scene has no decision, relationship pressure, revelation, or aftermath function;
- a line edit makes the paragraph cleaner but flatter;
- a body paragraph contains only restated or rearranged information;
- a paragraph ends with a flat conclusion rather than a forward-leaning bridge (except the final close paragraph);
- the ending answers a different question than the opening;
- the ending contains more than one CTA or uses generic closing phrases;
- a comment-optimizing choice violates the retention priority in `metrics-contract.md`;
- a production-run file or an independent audit record is missing.
- a turn uses a bookish trigger word or a fake drop (然而/却 substituting for spoken 可, or two sides listed in parallel instead of intensifying each other);
- commentary appears before the fact it comments on, praises the text's own technique, or uses literary-criticism vocabulary (预告腔/邀功句);
- a hedge word (几乎/差不多/某种意义上) cushions a claim that the facts could either confirm or delete;
- a paragraph was locked, audited, or persisted without a valid `book_review` record (meaning, retrieved-or-no-footing, gap, rewrite_action) in `audit-log.jsonl`;
- `paragraph-locks.jsonl` was hand-written or hand-edited rather than rendered by `render-paragraph-locks.mjs`, or the script changed after the locks were rendered (`--check` fails) — the locks are derived, so a hand-edited lock file is an unverifiable claim about the script;
- the book-reference review ran degraded: no meaning statement, no retrieval and no no-footing explanation, a pass verdict on a paragraph with a diagnosed gap, or sentence-patch-only treatment;
- a contracted slow scene was compressed to a summary or a bare gesture to fit the clock — duration pressure is resolved at the beat map (drop or merge a beat, compress a transition paragraph), never by flattening a contracted scene;
- an agent finding was deferred, "bundled", recorded as craft 取舍/暂缓/addressed-without-edit, or waived without citing a contract clause;
- drafting began before the opening recast (step 2.5) produced its candidates and `opening_fidelity` record, or the draft's opening is not the selected candidate without the user overruling it at the draft checkpoint;
- two body paragraphs state the same meaning in any wording, or the same judgment appears more than once;
- a close-act recap re-lists already-shown facts without computing a new relation;
- the story beat supply cannot cover the target duration and neither a shorter duration nor more
  scenes were chosen (story budget);
- any editorial-board agent reports an unresolved hard blocker (broken action chain, unreadable AI
  sentence, or internal logical contradiction).
- a required editorial-board review (sentence-health auditor) is missing from `scripts/polish-notes/<article-id>/agent-reviews/`. There is no fact-checking review in this workflow — curation records sources, it does not verify them.
- the script contains a 病句 — missing subject, a verb attached to the wrong subject, a swallowed verb character, an action character repeated inside one clause, or an ambiguous 他/这/那. There is no stylistic waiver for a broken sentence, and 口语 permits ellipsis but never mis-attachment or a dropped verb character;
- a 病句 was "fixed" by compressing the sentence differently instead of restoring the missing word — 语法完整 outranks 压缩密度, and over-compression is what produces this defect class in the first place;
- a paragraph carries more than one function, or its closing question is contradicted or already answered by the facts inside that same paragraph (a question the evidence refutes is a logic failure, not a hook);
- the `opening_fidelity` record declares a `skeleton_borrow` the final opening does not use, or the final opening borrows a pattern the record never declared (undeclared borrowing is the violation the record exists to expose).
- the scripture or doctrine guard is active but `scripture-fact-checker.md` is missing or reports an unresolved hard blocker.
- the notes directory is missing `00-original-source.raw.txt` (every run is transplant — the validator machine-checks this; the raw file is what every substring anchor compares against);
- every load-bearing attribution hypothesis in the autopsy is unverified (comments waived or evidence-free) and the transplant was not abandoned;
- the `opening_fidelity` record is missing from the audit log;
- drafting ran in the same session context that read the original, without an explicit user waiver of the fresh-subagent isolation rule.
- a work order (`04-workorders.md`) contains a finished Chinese sentence, a scene description, or a metaphor — a work order that reads like prose has become a hidden draft, defeating the human-writes-every-paragraph mandate;
- a work order shows a fact's rationale before its verbatim source span, or paraphrases a fact instead of quoting its pool entry — fact-before-rationale is the order that prevented a measured `约50—70两` → `五六十两` drift in this skill's own history, and reversing it reproduces that drift;
- a work order lists more than one open judgment call — a second live question is a sign the paragraph is doing two jobs and should be split, not a reason to hand the human two decisions in one card;
- the global constraint card is re-pasted inside individual work orders instead of shown once per run — repeated constraint mass across every paragraph is the failure mode a practitioner warned against directly ("Skills越多，模型越不敢犯错，最后…就是戴着镣铐跳舞");
- `volume` mode's prose paragraphs are selected by guessing paragraph position (e.g. "the opening and first two beats") instead of reading `stance_relation` off the beat map — a measured run had its largest rewrite land on a body paragraph, not the opening, so position-based selection picks the wrong paragraphs;
- Gate #2 (allocation readback) is used to re-present prose for the human to re-read, rather than a derived table of facts spent/unspent and scan results — a re-read gate on already-written material reproduces the batched-approval habituation a measured study found (30.1%→36.8% approval with falling per-item scrutiny across 11,429 reviews).
