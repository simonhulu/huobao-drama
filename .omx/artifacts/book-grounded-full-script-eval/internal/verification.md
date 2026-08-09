# Final Hard-Constraint Verification

Date: 2026-07-31

This report verifies eligibility for human review only. It does not score prose quality or choose a
winner.

## Frozen Files

| Case | Baseline SHA-256 | Candidate SHA-256 | Baseline length | Candidate length | Ratio |
| --- | --- | --- | ---: | ---: | ---: |
| `case-01-ligan` | `41d67287e135b3ce11252bdeac068b3458535cc20c4111f3a1e7ac6a39863d5f` | `65ca0b917f56c9c1a48a3d93737c86cf1915d6bbe5ef0bde2b73f84b1e2b5a48` | 532 | 513 | 96.43% |
| `case-02-three-places` | `153e4843b828598c410a922e57de7c4d9232eb32d48d40fffa40b0dbf3aa4892` | `e9df457cc32d0027b765baaa1cde6111751137d8a3e0cc8a3715ce02c906a18f` | 1886 | 1731 | 91.78% |
| `case-03-zhouxiande` | `86e2a07e16f43afa549c150703fc66bd7d639ea82de852efb7d906860368a588` | `6a45bb6e8ba7d1277cc5ee054e24d955cd6d91ef2a1cdf49c372f153abcb2448` | 4014 | 3636 | 90.58% |

Lengths are raw Unicode code points, matching the qualification freeze. All candidates are within
the required 90-110 percent range.

## Contract Checks

- Baseline hashes match `qualification.md`: PASS for all three.
- Locked people, events, numbers, quotations, and doctrinal/historical boundaries: PASS for all
  three.
- Title preservation: PASS; candidates remain body-only and the review packet uses the frozen title.
- No stronger certainty, viewpoint drift, or prohibited causal claim: PASS for all three.
- No new named fact or fictional event: PASS for all three.
- Every retained material edit maps to a diagnosed issue and recorded source move: PASS for all
  three after rollback.
- Source overlap at 14 normalized characters: zero matches for all three.
- Formal filler scan (`进一步来说`, `值得一提的是`, `综上所述`, and related forms): zero matches.
- Anonymous review copies match their frozen internal source hashes: PASS for all six copies.
- Review directory contains no baseline/candidate/process labels: PASS.

## Independent Audit

- `case-01-ligan`: initial audit rejected an unsupported claim about Huo Qubing's motive and a new
  count in the ending. Both were rolled back; focused re-audit passed.
- `case-02-three-places`: passed. A diagnosis count was corrected from five to six quoted doctrinal
  anchors; candidate preservation was already complete.
- `case-03-zhouxiande`: passed after the main rollback removed newly invented gestures and events.

The independent audits were hard-constraint checks only. No model recommendation is accepted as
evidence that the editing method improves finished manuscripts.
