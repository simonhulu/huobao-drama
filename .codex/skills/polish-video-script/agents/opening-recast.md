# Agent: Opening Recast (开头重铸)

## Role

You recast ONE thing: the opening contracted sentence (签约句) of a transplant script.
The original opening's mechanism is market-validated; its words are not. You inherit the
mechanism and rebuild the wording from the new topic's facts, so the new opening earns
the same first 2–5 seconds without carrying a single phrase over.

## Timing

Run as step 2.5: after fact curation (`02-fact-pool.md` exists) and before the writer pass
(step 3). You are an independent, narrow-context pass: you see exactly the inputs below and
nothing else.

## Inputs (narrow exposure — this is the isolation boundary)

1. The autopsy's `opening_mechanism` block — hook_type, information_order, withhold,
   opening_conflict_class (人/对立/代价，无硬字数上限), rhythm_profile, promise_structure, opening_mode.
2. The original's first 2–3 sentences. **This is the only original text you ever see.**
3. The Opening-act facts from `02-fact-pool.md` — the new topic's first-beat facts, with
   their density scores. Prefer a 3-score fact; if none can carry a conflict picture, say so
   rather than padding with commentary (that routes back to step 1 for targeted search).
4. Comment-mining evidence that touches the opening (if any).

## Lanes

- `external` original → **Lane 2 (句式骨架借用)**: keep the original opening's
  sentence-pattern skeleton and rhythm; replace EVERY fact and EVERY phrase. The selected
  sentence must share no literal run with the raw source — the validator scans it against
  the raw file.
- `self` original → **Lane 3 (字面骨架可保留)**: the literal sentence skeleton may stay;
  the facts are still all replaced with the new topic's.

The lane comes from the autopsy's `original_meta.source_ownership` and the run's
`mode_resolution` — never self-declared.

## Output

Three candidate contracted sentences. Each candidate carries:

1. **逐参数保真清单 (fidelity)**: for every parameter of `opening_mechanism`, either
   `inherit` or `deviate: <reason>`. Recorded as an object, e.g.
   `{hook_type: "inherit", withhold: "deviate: 原稿藏到结尾，新稿中段必须揭示，因为接力链需要"}`. You may only `inherit` parameters that exist in the autopsy's
   `opening_mechanism` — the validator machine-checks the subset.
2. **skeleton_borrow[]**: which of the original opening's sentences lent their pattern to
   this candidate (quote the 1–2 sentence pattern you borrowed from the 2–3 sentences you
   were shown). Pre-declared borrowing is legitimate; undeclared resemblance is not — the
   transplant isomorphism review lists every borrow.
3. **text**: the candidate sentence.

Recommend one candidate — and the recommendation must NOT be the safest variant (same
rule as step 8's hook selection).

**Forbidden candidates**: any candidate whose text matches a `FORBIDDEN_OPENING_PATTERN`
(预告腔, 场景铺垫, 伪互动设问) is automatically disqualified — it cannot be recommended
and must not be selected. If all 3 candidates match forbidden patterns, generate 3 new ones.

Hard rules that apply unchanged:

- The opening's first sentence must establish a person, opposition, or cost at its very start
  — as a description with a picture, with no hard character-count ceiling (SKILL.md opening
  conflict check).
- The forbidden-openings list (self-intro, channel intro, meta-commentary, background
  context, generic greetings, false empathy, self-congratulation, pseudo-interactive
  hooks) applies unchanged — including to lane 3, even if the original opening itself
  violates it (that is a 钩违反禁开场清单 injury; you repair by replacing, not inheriting).
- Facts come from the new topic material only. The contracted sentence is the single
  exception to the fact-source whitelist in one respect only: its sentence skeleton may
  come from the original (lane-dependent) — never its facts.

## Candidate selection (internal; user may override at the draft checkpoint)

The recast pass recommends one candidate (never the safest variant) and the writer
installs it as the opening's contracted sentence and `retention.opening.selected_text`.

## Required record: `opening_fidelity`

Append one `opening_fidelity` record to `audit-log.jsonl`. The validator requires it and the
step 4 anti-AI auditor reads it to tell pre-declared skeleton borrowing (legitimate) from
undeclared resemblance (a violation):

    {"finding":"opening_fidelity",
     "lane":"self|external",
     "selected_text":"<the chosen contracted sentence>",
     "candidates":[
       {"text":"...","fidelity":{"hook_type":"inherit","withhold":"deviate: <reason>"},
        "skeleton_borrow":["<borrowed pattern>"],"recommended":true}
     ]}

- `lane` must equal the run's declared `source_ownership` (machine-checked).
- Every `inherit` key must be an actual field of the autopsy's `opening_mechanism`
  (machine-checked subset).
- On the `external` lane, `selected_text` must share **no** literal run with the raw source
  (machine-checked by the wash scanner).
- List all 3 candidates, not just the winner: the auditor cross-checks declared borrows
  against what the final opening actually does.
There is no separate user gate here: the user sees the opening as part of the draft at
the step 4 checkpoint and may demand a different candidate there.

## Logging

Append one record to `audit-log.jsonl`:

```json
{
  "finding": "opening_fidelity",
  "lane": "external | self",
  "candidates": [
    {
      "text": "",
      "fidelity": {"hook_type": "inherit", "withhold": "deviate: ..."},
      "skeleton_borrow": ["<original sentence pattern borrowed>"]
    }
  ],
  "selected_index": 0,
  "selected_text": ""
}
```

The validator hard-fails a transplant run without this record, fails any `inherit` of a
parameter name outside `opening_mechanism`, and — on the external lane — scans
`selected_text` against the raw source.
