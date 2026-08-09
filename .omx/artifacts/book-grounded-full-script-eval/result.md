# Human Full-Script Blind-Review Result

Date: 2026-07-31

Status: **FAILED - DO NOT PROMOTE**

## Ballot Validity

- All three pairs were read in full.
- The reviewer completed the ballot without knowing version identity.
- The ballot was frozen before `internal/randomization.json` was opened.

## Unblinded Mapping

| Pair | Candidate | Baseline | Ballot |
| --- | --- | --- | --- |
| `pair-01` | 甲 | 乙 | Both unpublishable |
| `pair-02` | 甲 | 乙 | Both unpublishable |
| `pair-03` | 甲 | 乙 | Both unpublishable |

The reviewer's final qualitative judgment was that the baseline group, 乙, was stronger overall,
although neither version in any pair was publishable.

## Gate Result

| Criterion | Required | Observed | Result |
| --- | ---: | ---: | --- |
| Publishable candidates | 3 of 3 | 0 of 3 | FAIL |
| Candidate wins | At least 2 | 0 | FAIL |
| Candidate losses | 0 | No pair winner; all three were rejected | Not sufficient to pass |
| Overall prose quality | Directly publishable | AI-heavy and low-readability in all three candidates | FAIL |

The candidate method fails the human gate. It must remain outside `polish-video-script`.

## Human-Reported Failure Patterns

1. **Pseudo-cinematic compression without lived detail.** `卫青抬手，人停住` was judged to be
   artificial compression pretending to be polished prose, while omitting time, place, event
   development, and emotionally meaningful detail.
2. **Abstract AI framing.** `它先问的是` was identified as a characteristic AI sentence frame.
3. **Unclear reader pivot.** `先看看今天` did not establish a concrete action or intelligible
   meaning in context.
4. **Formulaic convergence.** `最后都落到……` was identified as a prohibited AI-style sentence
   pattern.
5. **Manufactured sensory atmosphere.** `静得能听见焦木偶尔噼啪一声` was judged unlike natural
   human narration and insufficiently grounded in the event.

These findings are evidence about complete-manuscript quality, not a request to create another
phrase blacklist. A successor method must solve scene development, information selection, sentence
formation, and narrator judgment together, then face a fresh three-script human blind review.

## Consequences

- Do not restore the rejected static-card runtime.
- Do not add this issue-driven book-editing method to the production skill.
- Keep the Markdown corpus and generic source tools offline for future experiments.
- Treat these three manuscripts as regression evidence only; never reuse them to claim a successor
  method passed.
- Record separately that the existing production baselines were also 0 of 3 publishable. Improving
  the baseline skill remains unresolved.
