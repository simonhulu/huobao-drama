# Information Gap And Human Incompleteness

Load after the truth boundary and before the beat map. This module prevents an AI draft from
closing every thought, explaining every image, and defending every claim until the script sounds
like an article or an audit report.

## Core Distinction

Human incompleteness is selective speech plus designed error — never deliberate factual error.

- **Truth boundary**: never knowingly invent a decisive event, chronology, relationship, result,
  or source. Resolve unsupported material upstream by removing it, anonymizing it, narrowing the
  claim, or choosing an explicit fictional/legend frame.
- **Narrative boundary**: the spoken script does not need to recite every caveat, background fact,
  exception, interpretation, and conclusion. Say only what this narrator needs at this moment.

Do not use a source disclaimer to repair a story that should have been selected differently. If a
named historical identity is unreliable and irrelevant to the payoff, remove the name before
drafting. Do not stop the story to demonstrate that the writer has done fact-checking.

## Designed Error (必须有错误)

The highest principle requires errors in stance, opinion, and emotion — the script is 一家之言,
not a balanced report. Its purpose is to give the audience something to argue with in the
comments. Required to survive every editing pass:

- at least one disputable judgment the narrator owns without a caveat, a hedge, or a balancing
  counterweight — a take a specific viewer group will reject;
- at least one emotionally loaded reading the narrator does not apologize for;
- no pursuit of the balanced, complete, or "correct" account: objections are not pre-answered,
  counter-cases are not pre-empted, and the stance is not rounded into safety.

A designed error is never a written flaw: no deliberate 病句, no imprecise colloquialisms, no
rough grammar. And it never touches the fact layer: events, dates, names, quotations,
chronology, and causal claims stay inside the truth boundary. An opinion-layer error gives the
audience something to push against; a fact-layer error gives them a reason to distrust
everything else.

## Two Owners Of A Gap

### Creator-owned gap

The answer exists in the script and is paid later. Use it for retention:

- action now, cause later;
- visible cost now, mechanism later;
- choice now, consequence later.

It must be answerable and paid. This is a narrative loop, not fake suspense.

### Viewer-owned gap

The script supplies the concrete situation, but the final answer depends on the viewer's own
experience, judgment, relationship, shame, or memory. Use it for resonance and comments:

- `他放不下的，到底是那个人，还是那次失败留下的自己？` The script may show both
  possibilities; it must not answer on the viewer's behalf.
- show a familiar cost transfer and stop before announcing how the viewer should feel;
- give two materially different readings and let lived experience decide which one fits.

A viewer-owned gap must appear only after enough concrete material exists to make it honest. It
must not be a generic `你怎么看`, an early comment command, a forced binary, or a withheld fact
that the author actually knows.

## Completion Residue Scan

For every sentence, ask: `Was this added because the audience needs it, or because the model felt
uncomfortable leaving the passage incomplete?`

Mark and usually delete:

1. **Defensive completion**: source disclaimers, exception lists, and self-protection that do not
   change the viewer's next inference.
2. **Interpretive tail**: a sentence that explains the meaning after the scene has already shown it.
3. **Summary echo**: a paragraph ending that restates the paragraph in abstract language.
4. **Exhaustive closure**: three or more examples included only to prove every edge case is covered.
5. **Moral sealing**: telling the viewer exactly what to feel after the cost and beneficiary are visible.
6. **Second ending**: answering the title, then explaining the answer again, then adding a slogan.
7. **Risk-disclaimer drift**: pausing the story to prove the narrator is accurate, balanced, or
   difficult to criticize.
8. **Judgment replay (判断复读)**: the same judgment, moral, or mechanism stated again in new
   words in another paragraph. One statement per script; keep the strongest instance, delete
   the rest. A close that restates already-shown facts must compute a new relation — a plain
   re-listing is residue.

Deleting a completion residue is correct only when orientation, decisive causality, and the title
payoff survive. An omission that makes the story misleading, incoherent, or falsely certain is not
human voice; it is a broken fact chain.

## Gap Contract

Before drafting, record:

    information_gap_contract:
      creator_owned:
        - beat_opened: ""
          withheld_answer: ""
          payoff_beat: ""
      viewer_owned:
        - beat_id: ""
          concrete_material_given: ""
          answer_left_to_viewer: ""
          expected_response: ""
      intentional_omissions:
        - omitted: ""
          reason: "not needed for the viewer's pursuit | resolved upstream | viewer-owned"
      closure_budget:
        paragraph_summaries: 0
        explanatory_tails: 0
        final_answers: 1

If comment optimization is disabled, `viewer_owned` may be empty. If it is enabled, use one or at
most two viewer-owned gaps; more turns the script into a questionnaire.

## Paragraph Rule

Each paragraph may close one active question, but it should leave one forward pressure: an unpaid
consequence, a changed relationship, a next action, or a viewer-owned judgment. Do not manufacture
a rhetorical question when the action already supplies the pressure.

## Final Audit

- Can at least one sentence be removed because it only makes the piece feel complete?
- Does the narrator take a disputable position instead of hiding inside caveats?
- Can you point to at least one designed error in stance, opinion, or emotion that survived editing — a 一家之言 judgment a specific group will argue against?
- Is every retained caveat necessary to prevent a materially false claim?
- Does the title promise receive one clear answer, not three paraphrases?
- Does any judgment appear more than once, in any wording?
- If a viewer-owned gap is planned, can only the viewer's lived experience complete it?
- Does the script stop before explaining its final charged image?

Fail the script if every tension is closed, every scene is interpreted, every possible objection
is answered inside the spoken body, the same judgment is restated in multiple paragraphs, or
every stance-, opinion-, and emotion-level error was polished into a safe, balanced account.
