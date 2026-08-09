# Reader Question Relay

## Purpose

The writer knows the whole archive. The listener knows only what the script has already said.
This module prevents the writer from arranging omniscient material blocks while the listener is
still trying to identify the person, event, or stake.

Every beat must answer or deliberately carry one active reader question before it opens the next.
Suspense is not an absence of basic facts. It is a known danger whose outcome, cause, or price
has not yet been paid.

## Opening Function Contract

Record this inside `retention.opening`:

    open_loop_id: "Q1"
    opening:
      opening_mode: result_then_rewind | scene_return | direct_cause | collision
      action_status: result_shown | action_interrupted | no_action
      reader_must_know:
        - "谁正处于什么危险或结果中"
        - "已发生的关键动作或明确后果"
        - "为什么要倒回下一段"
      bridge_to_next_beat: "把开场的人和结果明确接到下一段的原因或冲突。"

### Result First Versus Interrupted Action

- Use `result_then_rewind` when the violent action itself is the hook but the listener does not
  yet know its stakes. State the irreversible result in the first one or two sentences with a
  direct verb: `霍去病射杀了李敢`, not four sentences of bow choreography. Hide the cause,
  not whether the arrow landed.
- Use `scene_return` with `action_interrupted` only when the listener can already identify the
  target, the relation, and the immediate cost within the opening. If any of those three is
  unavailable, show the result first or choose `direct_cause`.
- The next paragraph must state the bridge aloud. `先说这箭为什么会射向他` is a bridge;
  a new unexplained name, a moral slogan, or a new mystery is not.

## Beat Relay Contract

Add this to every beat:

    reader_relay:
      question_in: "读者带进本段的唯一最大问题"
      resolution: answer | carry
      question_out: "本段回答后自然留下的下一问"

The chain's substance is the three fields above: what the listener carries in, whether this
beat answers or carries it, and what they carry out. **The ids are derived, not written** — a
`carry` keeps the incoming id, an `answer` mints the next, and beat 1 enters through
`retention.open_loop_id`. Hand-aligning `question_in_id` / `question_out_id` across every beat
(57 edits on a long script) only asked the author to transcribe a chain the validator could
compute, and each typo cost a full validate/repair cycle while proving nothing about the
script. The final beat may declare `question_out_id: "RESOLVED"` to close the loop — that is
the one id worth writing, because no derivation can infer it.

`facts_known_before`, `fact_ids_disclosed_here`, and `bridge_to_next` are optional. Supply them
when the plan genuinely needs them; when omitted, the paragraph locks derive listener state
from the preceding beat's `question_out` and the bridge from the paragraph's own closing
sentence.

Rules:

1. Beat 1 enters through `retention.open_loop_id`; every later beat enters through the preceding
   beat's outgoing question. This is checked against the derived chain, so supplying a
   conflicting id is an error rather than a silent override.
2. `answer` must either open one new question or end at `RESOLVED`. `carry` may preserve the
   same question, but it must add a fact, cost, or time pressure; a new mystery is not a carry.
   An `answer` whose `question_out` repeats its `question_in` verbatim answered nothing.
3. A beat may not introduce a second unrelated question before its `question_in` has been
   answered or explicitly carried.
4. `fact_ids_disclosed_here` must include each fact first disclosed in the beat. A fact or name
   cannot be used by a stance, pronoun, shorthand, or consequence before its first disclosure.
5. The writer records reader knowledge, not archive knowledge. “李广的旧账” is unavailable
   until Li Guang, his death, and its relation to the current conflict have entered the story.

## Stance Purity

A stance is clear only when the listener can parse it at the moment it arrives.

- A reveal may use only facts first disclosed in or before its `stance_reveal_beat`.
- It can judge an already visible action, but it cannot borrow a later name, death, or motive to
  make itself sound deep.
- If the real judgment needs later context, reveal a narrower early judgment first and let the
  later evidence sharpen it. Do not turn the early stance into a riddle.

## Paragraph Lock

Before drafting paragraph N, state four short lines outside the prose:

    Listener knows: ______
    Listener is asking: ______
    This paragraph answers/carries: ______
    Next paragraph begins by: ______

Reject the paragraph when its first sentence cannot be understood from `Listener knows`, or when
its ending opens a question other than the contracted `question_out`.

## Final-Prose Lock

Planning records are not proof that the prose obeyed them. Before release, write one JSONL record
for every nonempty final paragraph:

    {"paragraph_index":1,"beat_id":"B1","listener_knows":"...","listener_asks":"...","question_in_id":"Q1","question_out_id":"Q1","fact_ids_used":["F5"],"first_sentence":"...","bridge_quote":"..."}

For a `result_shown` opening, set `retention.opening.script_required_patterns` to direct verbs
that must occur in the first paragraph. Run the final script together with these locks through
`validate-production-run.mjs`. A voice edit may not swap a contracted result for an interrupted
arrow merely because the latter avoids a repeated line; the upstream retention contract wins.
