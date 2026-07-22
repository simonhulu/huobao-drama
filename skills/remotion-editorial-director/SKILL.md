---
name: remotion-editorial-director
description: Use when a task involves reference-video editing analysis, documentary or business-history edit planning, image/text/camera/transition choreography, or end-to-end Remotion production from a script, subtitles, assets, and narration.
---

# Remotion Editorial Director

Turn narration and reference-video evidence into an inspectable edit recipe, then render it through the target project's adapter. Keep semantic choice in this Skill and visual implementation in the project-owned Remotion composition.

## Select The Operation

- `analyze-reference`: classify observed editing techniques from a video plus timed subtitles.
- `plan-edit`: turn a script/timed transcript and asset inventory into a traceable Recipe v2 draft and lock.
- `render-recipe`: validate and render an existing locked Recipe v2 through a compatible project adapter.
- `produce`: run planning, validation, render, inspect, and QA as one resumable operation.

Use `node scripts/director.mjs <operation> --manifest <path>`. Use `--resume <run-id>` only for an unchanged locked run. A changed input, policy, schema, implementation, adapter, or renderer environment requires a new revision that names `supersedesRunId`; never mutate prior artifacts.

## Required Sequence

1. Validate the closed input manifest and exact target profile.
2. Snapshot every recipe-bound input into the run and authenticate its bytes.
3. Build timed semantic units before choosing effects.
4. For reference analysis, derive visual boundaries independently and join them with subtitle semantics before classifying techniques.
5. Select techniques from semantic rules and calibrated/corroborated evidence. Treat unresolved evidence conservatively.
6. Author an explicit `magnates-remotion-recipe-v2` payload with stable IDs and a complete non-rendering decision trace.
7. Validate recipe timing, identities, assets, counters, vocabulary, trace coverage, and audio policy before launching the adapter.
8. Negotiate adapter capabilities, build props once, render those exact props, inspect real-render telemetry, and run global deterministic QA.
9. Report the run directory, locked artifact hashes, output media path/hash, QA status, and any actionable blocker.

Do not bypass stages, render a draft, repair during render, infer support from approximate dimensions, or let the adapter choose editorial treatments.

## Agent Handshake

When `authoringMode` or `reviewMode` is `agent`:

1. Run the operation until it returns `awaiting_agent` with exit 10.
2. Read only the emitted immutable `request.json` for that attempt.
3. Produce one response matching `editorial://schema/agent-response/v1`. Do not call a paid provider directly.
4. Run `node scripts/director.mjs supply-agent-response --run <id> --stage <authoring|review> --input <response.json>`.
5. After `response_accepted`, rerun the original operation with `--resume <run-id>`.

Never overwrite an attempt response. A schema-invalid response may create the one allowed retry attempt; semantic disagreement returns `needs_review`.

Use `replay` for a hash-locked prior raw response. Use `deterministic` for the conservative offline planner, which may select only declared grammar defaults with `hold` camera and `hard_cut` transitions.

## Hard Gates

- Use only controlled camera, transition, text, and graphic enums.
- Never present an unresolved technique as an observed fact.
- Every render-affecting node traces to semantic units and grammar rules.
- Evidence is required unless the selected rule declares the treatment as its default.
- Every subject, asset, and counter identity resolves exactly; counters require metric, unit, period, source note, and claim/evidence binding.
- Shot and cue timing is zero-based, start-inclusive, end-exclusive, positive, ordered, and exact.
- Recipe, props, composition, requested render, telemetry, and manifest frame counts are identical integers.
- Recipe validation completes before any adapter process starts.
- Production never clamps, drops, substitutes, downgrades, or silently repairs invalid values.
- Every staged asset is authenticated before an external consumer and after render.
- Global QA must pass decode, target, duration, audio, black-frame, motion/hold, safe-area, and telemetry checks.

## Evidence Rules

Read [editorial-grammar.md](references/editorial-grammar.md) before classifying or choosing techniques. It contains the controlled technique vocabulary and semantic selection grammar.

Read [evidence-policy.md](references/evidence-policy.md) when analyzing reference material or using a learned technique. Yahoo is the only fully VLM-calibrated source in the initial four-video corpus; do not describe the other three sources as equivalently calibrated.

Read [adapter-and-qa.md](references/adapter-and-qa.md) before `render-recipe` or `produce`. It defines adapter ownership, exact target tuples, telemetry, media conformance, and QA thresholds.

## Recovery

- A handled failure or cancellation preserves the last committed stage and immutable artifacts.
- Resume only when original input and implementation locks match.
- `--from` cannot skip an invalid or missing prerequisite.
- A competing writer is a run-state conflict; report its recorded owner and do not alter the run.
- Treat adapter timeout as retryable only when the operation policy says so. Protocol/malformed output is not automatically retryable.
- Do not globally install or upgrade this Skill during a production run. Distribution uses `scripts/install.mjs` and requires separate approval after all release gates pass.

## Maintenance

- `doctor [--adapter-config <path>] [--render-smoke]`: verify the portable runtime and project adapter.
- `migrate --input <path> --to magnates-remotion-recipe-v2`: emit a new unlocked draft; never overwrite the source.
- `cleanup --output-root <path> --older-than <duration>`: preview reclaimable run files; delete only with `--apply`.

Run maintenance through `node scripts/director.mjs <command> ...`. Global installation remains a separate, explicitly approved action.
