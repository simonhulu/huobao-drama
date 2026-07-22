# Evidence Policy

## Evidence State

Each technique claim records source and time range, subtitle span, semantic role, visual boundary or stable interval, controlled label, confidence, evidence tier, review method, calibration status, detector/model identity, frame references, ambiguity, and reviewer status.

- `calibrated`: accepted against a locked calibration policy.
- `corroborated`: semantic and visual evidence agree, but no accepted calibration binds the claim.
- `unresolved`: evidence is insufficient or conflicting; use a declared conservative fallback or return `needs_review`.

Review provenance is independent:

- `human`
- `vlm`
- `machine_only`

Calibration status is independent:

- `gold`
- `accepted`
- `uncalibrated`
- `not_applicable`

Machine-only evidence cannot become calibrated from confidence or model identity. It requires a referenced human-gold record or an accepted VLM calibration artifact under the grammar release's immutable policy.

## Initial Corpus Boundary

Yahoo is the only fully VLM-calibrated source in the initial corpus. YouTube, Tencent, and Netflix contribute observed and corroborated patterns but are not equivalent validation sources. Preserve this distinction in summaries, selection rationales, and confidence labels.

The initial immutable policy is `yahoo-observable-v5.2-exact-v1`. A claim is calibrated only when its target and every required artifact hash match that policy exactly.

## Selection Rule

Choose an effect only when the narration function, visual evidence, and grammar rule agree. Evidence can refine or support a semantic rule; it cannot override a hard timing, identity, asset, target, or renderer constraint. When evidence is unresolved, select the rule's conservative fallback or stop for review.
