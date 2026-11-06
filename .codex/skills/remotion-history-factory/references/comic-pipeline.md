# History Comic Pipeline — Command Surface

This document is the machine-checkable contract for the history comic runner
(`scripts/history_comic_pipeline.mjs`) and validator
(`scripts/history_comic_validator.mjs`). The architecture tests parse the
fenced blocks and tables below and compare them against the runner exports;
keep them byte-exact when you change the runner.

## Command surface

```text
start --episode <id> [--run <path>]
run [--episode <id> | --run <path>]
status --run <path>
next --run <path>
advance --run <path>
retry-action --run <path>
retry-stage --run <path>
repair-delivery --run <path> --actor <name> --reason <text>
start-new-run --run <path> --actor <name> --reason <text>
```

`start` creates (or replays) the immutable run file and prints the derived
status as a diagnostic. `run` acquires the run lease and drives the machine
loop until a non-machine boundary. `status`/`next` print without side effects.
`advance` executes exactly one machine step. Every repair command
applies its effect under the run lease and then re-enters the machine loop
with `runUntilGate` before emitting the final status.

## Stage machine

| Index | Stage | Owner | Gate |
| --- | --- | --- | --- |
| 1 | intake | runner |  |
| 2 | environment_check | runner+validator |  |
| 3 | tts_verify | validator |  |
| 4 | narrative_plan_verify | validator |  |
| 5 | design_ensure | runner |  |
| 6 | generate_ensure | runner |  |
| 7 | manifest_build | runner+validator |  |
| 8 | asset_review | runner+validator | asset_contact_sheet |
| 9 | props_build | runner |  |
| 10 | candidate_render | runner+validator |  |
| 11 | frame_review | runner+validator |  |
| 12 | publish | runner |  |
| 13 | delivery_verify | runner+validator |  |
| 14 | episode_publish | runner+validator |  |
| 15 | complete | runner |  |

The `episode_publish` action also validates the database publishing package, schedules and waits
for both `4:3` and `3:4` covers, reads their URLs back from `/episodes/:id/covers`, and only then
commits the verified video delivery. Cover generation remains inside this existing stage so the
15-stage state machine and its continuation contract stay stable.

## Action classes

```text
machine: init, check-environment, verify-tts, verify-plan, ensure-design, ensure-generate, build-manifest, contact-sheet, auto-approve-assets, build-props, render-candidate, recover-candidate, auto-approve-frames, publish-candidate, verify, publish-episode
agent: retry-action, retry-stage, repair-delivery, start-new-run
```

## Budgets

| Constant | Value |
| --- | --- |
| storyboardRegenAttempts | 4 |
| actionRepairs | 2 |
| deliveryTransientRetries | 3 |
| deliveryRepairs | 2 |
| gridTaskRequeue | 1 |
| verifyStageRetries | 2 |

## Beat coverage SQL

```sql
SELECT COUNT(DISTINCT sb.id) FROM storyboards sb
JOIN storyboard_panels p ON p.panel_key = 'sb-' || sb.id
JOIN visual_beats vb ON vb.id = p.beat_id AND vb.start_ms IS NOT NULL
JOIN narrative_plans np ON np.id = p.plan_id AND np.kind='full'
WHERE sb.episode_id = ?
```

## Exit contract

- Exit code `0` is reserved for terminal states (`complete`, unrecoverable
  `failed`).
- Any machine or agent continuation exits `75` and prints the marker line
  `AGENT_CONTINUATION_REQUIRED: execute next_action and resume the same run; do not return to the user`
  to stderr. The status JSON always goes to stdout as a single trimmed line:
  no pretty printing, no derived `checks.accounting` block (stage history
  stays in run.json), long id lists are summarized as `{count, sample}` (first
  5), grid task refs are reduced to `{id, status, error}`, and a `complete`
  status attaches only the final-report fields (`delivery.deliveryPath/sha256`,
  `episodePublication.videoUrl`, `verificationReport.passed/metrics`).
- Every `failed` status carries `checks.lesson_path`, the absolute path of the
  recovery note mapped from `error_code` by
  `scripts/history_comic_lessons.mjs` (notes live in `references/lessons/`).
- A mutating command that opens a run last written by a newer runner release
  (`runnerRelease` in run.json) fails immediately with
  `RUNNER_VERSION_MISMATCH` before touching state, budgets, or failure
  history; `status`/`next` stay best-effort reads.

## Run, revision, and lease files

- Run file: `scripts/history-notes/episode-<id>/history-comic.run.json`
  (override with `--run`). The run path is immutable once created; the same
  episode + creation token replays the original run.
- Revision runs: `<stem>.revision-NNN.json` next to the source run, created by
  `start-new-run`; the old run file is never mutated. Budget counters start
  fresh in every revision; the source failure history is archived in the old
  run file and summarized into `revisionSourceFailures` for audit.
- Lease: `<run>.lock` beside the run file (60s heartbeat). A stale lease whose
  owner PID is dead may be stolen; a live lease refuses concurrent drivers.
- Event log: `history-comic.events.log` in the run directory, one JSONL line
  per event. `status` lines record stage/status transitions as observed by
  runner and mutating commands (`status`/`next` stay strictly side-effect
  free); transitions are deduplicated — polling the same state never repeats
  a line. `action_failed`, `action_retried`, `stage_retried`,
  `delivery_repaired`, `run_revised`, `run_superseded`, and
  `artifact_self_healed` lines record explicit events. Monitors subscribe to
  this file instead of polling full status JSON.
- Derived artifacts live in the run directory: `history-comic.manifest.json`,
  `history-comic.props.json`, `history-comic.assets.jpg`,
  `native/`, `candidate.mp4`,
  plus frozen `tts-audio.*` / `tts-titles.json`. An orphaned asset contact
  sheet whose on-disk index still matches the current manifest panel set is
  reattached automatically (self-heal) instead of reported missing.
- Delivery: `data/static/remotion/history-comic-<sha256[:12]>.mp4`, published
  by temp-copy + rename, never overwritten with different bytes.

## Manifest contract

The manifest builder (`scripts/videoeditor/build_history_comic_manifest.mjs`)
must emit `contract: history-comic-five-manifest-v1` and
`factory: history-comic-five-v1`, with `episodeId`, `dramaId`,
`targetDurationSec`, `narrationEndSec` (tail 0-3s), and at least 5 panels
keyed `sb-<storyboardId>[-pN]` with unique, monotonic, non-overlapping
`startSec`/`endSec` windows (500ms tolerance) and integer `ttsTitleStart` /
`ttsTitleEnd` bounds inside the frozen title count.

## Props invariants

`composeHistoryProps` builds the `progressive_five` native props:
1280x720 @ 30fps, `durationInFrames = round(targetDurationSec * fps)`,
`narrationEndFrame = round(narrationEndSec * fps)` with a 0-60 frame tail,
one synthetic hold segment, `quotes: []`, subtitles split from the frozen TTS
titles (each carrying `ttsTitleIndex`), and panels with `focusX`/`focusY`
(default 50) whose `emphasisStartFrame` starts at 0 and strictly increases
below `durationInFrames`. The `artifactChain` binds manifest SHA-256, asset
fingerprint, frozen TTS SHA-256 pair, BGM SHA-256, and episode id. BGM must be
at least 30s; the mix solves narration −14 LU with a 0.5 volume ceiling.
