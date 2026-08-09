# Beats And Scenes

Load after author routing. This is the last planning document before writer mode.

## Beat Map

Required per beat:

    beats:
      - id: B1
        retention_job: open | pressure | turn | approach | payoff | aftermath
        fact_ids: []
        persona_temperature: cold | warm | hot
        persona_job: ""
        stance_relation: reveal | prove | restore_context | name_cost | rebut | settle
        detail_mode: slow_scene | compressed_fact | factual_bridge   # only when it is a slow scene
        detail_ref: ""                                              # required for slow_scene
    disclosure:
      kind: first | recall

Optional per beat — write them when the plan genuinely needs them, skip them otherwise:

    author_job: ""
    reader_belief_change: ""      # the viewer's belief shift; the paragraph lock falls back
                                  # to the beat's question_out when this is absent
    state_change:
      actor: ""
      information_or_resource_changed: ""
      option_or_risk_changed: ""
    scene_goal: ""
    next_beat_forced_by: ""

These were required on every beat until they became the largest block of hand-written JSON in
the repo (41% of the beats array on a real 15-beat run) without being read during writing or
review — the review happens on the finished script. They are still validated when supplied, so
a run that wants the fuller plan keeps its guarantees.
      fact_ids: []
      new_meaning: ""
    reader_relay:
      question_in_id: ""
      question_in: ""
      facts_known_before: []
      fact_ids_disclosed_here: []
      resolution: answer | carry
      question_out_id: ""
      question_out: ""
      bridge_to_next: ""
    rhetorical_budget: ""
    scene_char_budget: 0
    scene_carriers: []
    persona_temperature: cold | warm | hot
    persona_job: ""
    stance_relation: reveal | prove | restore_context | name_cost | rebut | settle
    comment_moment:
      enabled: false | true
      type: resonance | confrontation | expression | relation
      trigger_line: ""   # sentence or phrase expected to provoke the comment

Delete or merge a beat when removing it does not alter the answer, reader belief, available options, risk, or eventual payoff.

Two beats may not land the same realization in different words. If two planned beats change the
same belief, merge them, or re-split so one carries the fact and the other carries its
consequence — never the same realization twice. The relay's `question_out` is the practical
test: two beats that leave the listener asking the identical question are one beat.

Load [reader-relay.md](reader-relay.md) before completing this table. The relay is the
load-bearing part — it records what the listener has heard, what they are now asking, and
whether this beat answers or carries it. `reader_belief_change`, when supplied, is a writer's
abstract summary and never a substitute for it. No beat may start by citing a future character,
event, or conclusion merely because the writer already knows it.

## Detail Allocation

- Select 2–4 decisive slow scenes before drafting. Story-led oral scripts normally devote
  120–260 Chinese characters to each; a slow scene below 100 characters is a bridge, not a
  scene, unless it is the one contracted hammer action.
- Slow scenes must be a decision, confrontation, revelation, or irreversible aftermath.
- Every other fact is a two-sentence chronology bridge unless it changes a later choice.
- Keep one approved soul detail only if it changes the viewer reading of a person or a beat. Do not preserve a detail merely because it is colorful.
- `detail_ref` must point to the committed slow-scene ID, compressed fact, or named bridge it serves. A beat cannot invent another slow scene in draft mode.
- A fact receives one `first` disclosure. Later uses must be `recall` and state the new consequence or meaning. Repeating an attendance, promotion, or injury merely to reset the scene is not a recall.

## Scene Contract

Before drafting a slow scene, define:

    scene_goal: ""
    relationship_pressure: ""
    known_factual_action: ""
    permitted_reconstruction: []
    stakes_in_the_room: ""
    required_result: ""

Use at least two scene carriers where they fit: witness reaction, meaningful pause, object change, spatial condition, relationship stake, or immediate consequence. Do not force the same recipe into every scene.

The two carriers must make people legible, not merely make the archive visible. `《史记》写道`
and `史书没有记载` are not scene carriers.

## Emotional Rule

Emotion is a conflict between concrete pulls: duty and kinship, shame and rank, revenge and survival, loyalty and self-protection. A scene must show what wins through an action or omission. “He was angrier” is not a state change.

The narrator’s emotion is also a contract. `cold` exposes the ledger or lie, `warm` restores a constrained person’s conditions, and `hot` names an upward transfer of cost or a moral disguise. Do not substitute generic sadness, admiration, or outrage for a persona job. In particular, do not put `warm` before the script has made its judgment; that recreates AI balance through tone.

## Focal Distance

Mark every beat wide, medium, or close.

- wide: chronology, institutions, travel, repeated results.
- medium: a decision explained through constraints.
- close: a decisive action, relation, or consequence experienced in the room.

If all beats have the same distance or sentence length, reject as flat overview.

## Comment Moment Placement

`comment_moment` is optional. Use it only when the metrics contract sets a `target_comment_rate`.

Allowed locations:
- A `turn` or `approach` beat after the viewer has already invested (i.e., not the opening).
- The `payoff` beat or its immediate `aftermath`, where the viewer has received the answer and now wants to take a stance.

Forbidden locations:
- The `open` beat. Do not trade 3-second orientation for early comments.
- A beat whose primary job is to disclose a new fact for the first time; the fact must land before the comment prompt.
- Any beat where the comment prompt would preempt a pending `turn` or `payoff`.

A `confrontation` comment moment must target a system, action, beneficiary, or cover-up, never a constrained person. It must obey the same heat-target rule as the narrator persona.

## Storyteller Gate

Before writer mode, read the beat map aloud without source names. A listener must still hear a
person in danger, a conflict, a choice, an action, and a consequence. If all that remains is
"which source confirms what", the wrong layer owns the story: return to the audience contract
and retention shell.

Then read only the `persona_job` column. It must form a coherent narrator arc: a clear judgment, the human conditions that explain without excusing it, and a named cost or cover-up. If every beat says "understand both sides", reject the map before prose.
