# Baseline Qualification

Qualification was completed before editing. A baseline was not repaired to make it eligible.

## Selected

### case-01-ligan

- Title: `李敢打伤卫青后`
- Baseline: `scripts/2026-07-24_3a8f5d7c9e20_李敢打伤卫青后.md`
- Body length at freeze: 532 characters
- SHA-256: `41d67287e135b3ce11252bdeac068b3458535cc20c4111f3a1e7ac6a39863d5f`
- Form: short historical investigation
- Boundary: `scripts/polish-notes/2026-07-24_3a8f5d7c9e20_李敢打伤卫青后/00-truth-promise.md`
- Production evidence: the matching directory contains a full-production run, beat contracts,
  paragraph locks, and an audit log. The manuscript consistently distinguishes what `史记` states
  from motives the record does not establish.
- Qualification: PASS. The body is complete, its factual claims fit F1-F5, and uncertainty is part
  of the manuscript's stated viewpoint rather than a gap to be filled.

### case-02-three-places

- Title: `三个消业道场：寺庙、山林与善行`
- Baseline: `scripts/huishou-san-chang.md`
- Body length at freeze: 1,886 characters
- SHA-256: `153e4843b828598c410a922e57de7c4d9232eb32d48d40fffa40b0dbf3aa4892`
- Form: Buddhist concept explainer and practical commentary
- Boundary: `scripts/polish-notes/huishou-san-chang/00-truth-promise.md`
- Production evidence: the exact script hash is recorded by
  `scripts/dharma-notes/huishou-san-chang-v2/comic-production.run.json`; a complete comic manifest
  was generated from it.
- Qualification: PASS. Scriptural quotations are bounded, the three-place chain is explicitly an
  editorial interpretation, and the manuscript rejects automatic luck or merit-exchange claims.

### case-03-zhouxiande

- Title: `频率决定命运`
- Baseline: `scripts/2026-07-31_86e2a07e16f4_频率决定命运.md`
- Body length at freeze: 4,014 characters
- SHA-256: `86e2a07e16f43afa549c150703fc66bd7d639ea82de852efb7d906860368a588`
- Form: long-form didactic legend
- Boundary: `scripts/polish-notes/zhouxiande-pinlv-jueding-mingyun/00-truth-promise.md`
- Production evidence: the top-level manuscript is byte-identical to the run's
  `clean-body-final.md`; the run includes complete contracts, paragraph locks, and specialist
  reviews.
- Qualification: PASS. The opening marks the story as legend, all named events belong to that
  fiction frame, and `频率` is explicitly the narrator's modern metaphor rather than scripture or
  science.

## Rejected Before Freeze

- `亲情中最冷的真相`: rejected because the production-run path is stale and the opening attributes
  an unlocated dialogue to Buddhist scripture as a recorded exchange.
- `应无所住而生其心斩内耗`: rejected because its own scripture review records an unresolved hard
  contract violation: the quoted closing verse omits `应作如是观`.
- `韩信的军队为何不属于他`: rejected because the baseline invents guard reactions and private
  psychology where its truth contract explicitly forbids those reconstructions.
- `霍去病为什么敢切断补给线`: rejected because key claims about requesting 800 riders, discarding
  logistics, unlimited authorization, and repeatable supply practice exceed the cited record.
- Ramesses II candidates: rejected because both final-script symlinks are broken; there is no intact
  production manuscript to freeze.
