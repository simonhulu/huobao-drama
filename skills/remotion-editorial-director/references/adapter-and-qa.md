# Adapter And QA Contract

## Ownership

The global director owns semantics, evidence, Recipe v2 validation, run state, asset locks, and global QA. The target repository owns Remotion, composition code, fonts, browser, rendering, and its adapter executable.

The adapter command is an argument array and runs with `shell: false`. It reads exactly one JSON request from stdin and writes exactly one JSON response to stdout. Diagnostic text belongs on stderr. Accepted operations are `capabilities`, `build-props`, `render`, and `inspect` in that order.

The initial project advertises exactly:

- `youtube-1080p`: 1920x1080 at 30 fps, production.
- `youtube-720p`: 1280x720 at 30 fps, preview and fast verification.

Both use a 1280x720 logical design space. Arbitrary tuples fail capability negotiation.

## Render Contract

- `build-props` accepts canonical v2 only and resolves assets from the locked inventory.
- `render` consumes the exact props hash from `build-props`; it does not rebuild props.
- Production selects only `MagnatesEditorial`; preview fixtures are not production capabilities.
- Every shot, cue, transition, and telemetry interval is half-open.
- The complete composition is rendered without a truncating frame range.
- Real-render browser telemetry emits one bounded packet per frame with visible layers sorted by stable layer ID.
- Inspect sorts out-of-order packets, removes byte-equivalent retries, rejects conflicting retries or gaps, and writes lossless RLE telemetry.

## Media Gates

- ffmpeg and ffprobe 7.1 or later.
- Exact negotiated dimensions, fps, and frame count.
- Narration conformed to exact 48 kHz samples using the locked timeline.
- Required/optional/forbidden audio policy enforced on the final mux.
- Full final media decode succeeds.
- No unintended run of more than three frames at 98% black under threshold 3.
- Declared motion is observable; `hold` and reading intervals meet stability thresholds.
- Every cue remains inside the target safe area, default 5% inset.
- Every declared asset reports successful decode during the real render.
- Telemetry covers every output frame and stays within declared packet/layer/total-byte budgets.

Container duration tolerance is the greater of one target frame or 50 ms. Bound narration audio tolerance is two target frames. These tolerances never permit a one-frame mismatch among recipe, props, composition metadata, render request, telemetry, or render manifest.
