# Retention Structure Contract

Load after truth-and-promise passes and before author routing. This adapts the viral-structure handbook as an audience-attention gate, not a prose template.

## First Principles

A viewer continues for three reasons:

1. An answerable question remains open.
2. Someone stands to lose something concrete.
3. The ending visibly pays the original promise.

## Required Contract

    structure_shell: suspense_cause | scene_return | escalation | collision | evidence_reversal | three_proofs
    open_loop: ""
    open_loop_id: "Q1"
    opening:
      first_image_or_action: ""
      known_after_opening: ""
      withheld_until: ""
      forbidden_information_order: ""
      opening_mode: result_then_rewind | scene_return | direct_cause | collision
      action_status: result_shown | action_interrupted | no_action
      reader_must_know: []
      bridge_to_next_beat: ""
      opening_conflict_check:
        conflict_present: true | false
        conflict_quote: ""  # substring of the opening's first sentence establishing person + opposition + stake (no character-count bound)
        recognizable_within_seconds: 3
    stake:
      who: ""
      loss: ""
      why_now: ""
    payoff_fact_id: ""
    middle_turns:
      - fact_id: ""
        reader_belief_before: ""
        reader_belief_after: ""
        next_question: ""
    ending:
      answer_sentence_fact_id: ""
      charged_image: ""
      hard_stop_word: ""
    rhetorical_budget:
      standalone_hammer_beat_id: ""
      max_meta_preview_labels: 0
      max_cheap_surprise_adverbs: 1

The open loop must answer the audience contract's `viewer_pursuit`, not merely catalogue what a
source does not say. A fact used only as atmosphere cannot close it.

Load [reader-relay.md](reader-relay.md) with this contract. `known_after_opening` is not enough:
the opening must state the exact result-or-danger the listener receives, what is withheld, and
the explicit bridge that makes the next paragraph necessary. A half-drawn weapon is not a hook
when the listener does not yet know who the target is or why the action matters.

The opening contract prevents a generic historical-self-media hook from choosing the story for the writer. State the exact image/action, what a viewer understands within the first 3–5 sentences, what remains withheld, and the information order that must not appear. Do not default to “official claim -> denial -> corrected truth” unless the source and chosen shell require it.

### Opening conflict check

The opening's first sentence must establish one of the following immediately:

- a person in danger or a result already paid;
- two concrete forces in opposition;
- a visible action whose cost is immediately felt.

There is **no hard character-count ceiling** on the opening. The old "within the first ~12–15
spoken characters" rule was removed because it produced compressed, summary-like openings that
failed the real job: making the viewer see a scene and feel a stake. The conflict must be told
as a *description with a picture* — e.g. 「奉天城的一栋满人老爷的大宅子被兵围个水泄不通」 —
never as a telegraphic summary like 「恒宅被兵围了」. The narrator's job in the first seconds
is to open a picture that carries a conflict, not to summarize one.

This is not the same as the 15-second value claim. The opening's first job is to make the viewer feel a conflict or stake; the 15-second job is to promise what they will learn. A data-shock or visual-contrast hook may establish stakes without interpersonal conflict, but it must still create immediate tension.

`conflict_quote` must be a literal substring of the opening's first sentence (the validator machine-checks this — no position/count bound). If `conflict_present` is false, the opening mode must be `data_shock` or `visual_contrast` and the stake must appear within the same opening window.

The rhetorical budget is global. One rare hammer line is stronger than four locally effective ones. Treat meta-preview labels as zero-budget by default: do not write “《史记》还记着两件小事”“下面看另一面” or similar scaffolding into the spoken script.

## Structure Shells

Choose one shell. The shell organizes the viewer experience; it never determines historical truth.

| Shell | Use only when | Core movement |
| --- | --- | --- |
| suspense_cause | A factual cause or bounded explanation exists | anomaly -> evidence changes answer -> payoff |
| scene_return | A decisive visual action can be withheld only after target, relation, and stake are oriented | interrupted scene -> necessary path -> scene completed |
| escalation | One person repeatedly gains, loses, or changes method | goal -> obstacle -> choice -> cost |
| collision | Two lines truly converge and the meeting changes both | separate pressure -> approach -> collision |
| evidence_reversal | Each new layer has stronger evidence than the last | familiar view -> evidence -> revised view |
| three_proofs | Three same-kind facts test one narrow judgment | claim -> proof 1/2/3 -> exception or payoff |

The old handbook rule of taking the first matching answer is insufficient. When two shells fit, choose the one whose payoff can be named with a source fact and whose stake is concrete.

## Story Before Archive

For a story-led historical oral script, choose `scene_return`, `collision`, `escalation`, or
`suspense_cause` before considering `evidence_reversal`. The latter is for a real evidentiary
contest. It is not a safe fallback for an unproven motive or an omitted source detail.

The opening must put a person in trouble before it introduces a document, chronicler, or source
boundary. Mention the source only at the exact point where it prevents the narrator from lying.

## Use The Handbook Safely

Retain open loop, stake, payoff, scene-summary distance changes, a structure-choice check before prose, and opening-to-ending comparison.

Do not import into the writer prompt:

- fill-in-the-blank sentences;
- mandatory phrase formulas;
- every paragraph must end with half a question;
- a fixed reaction-pause-detail recipe;
- examples whose historical causality has not passed the truth contract.

An unresolved element may live at the beat level. It does not need to become a rhetorical question at every paragraph end.

## Retention Tests

- After the first 20–30 seconds, can a listener name who is at risk, what may be lost, and what remains unanswered?
- Does each middle turn change the listener model of the answer, rather than add another fact?
- Does the ending answer the opening promise before it reaches the image and hard stop?
- If the shell is removed, does the script still have a distinct audience promise? If not, the shell is doing argumentative work it is not allowed to do.
- Does the opening's `conflict_quote` establish a person, opposition, or cost at the very start of the first sentence (description with a picture, no hard character-count bound)?
- Does every body paragraph end with either a forward-leaning bridge or a deliberate carry, except the final paragraph which must decelerate to the charged image?
