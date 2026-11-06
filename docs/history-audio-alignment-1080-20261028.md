# Episode 1080 Audio Alignment Recovery

Episode: `http://localhost:3013/remotion/episode/1080`  
Title: `朱由校为何传位弟弟真相令人深思。`  
Job: `8c1ce699-533c-4bd0-b0f8-4a0fa83339da`

## Cause

Whisper and its model were available. Recognition completed, but only 67 of
68 internal shot boundaries passed text matching. Shot 47's locked narration
`朱由检即位，是为崇祯帝。` was recognized as `猪油简即位是为重真地`.
All ten characters mapped consecutively to measured tokens; text confidence
was 0.58846, below the ordinary 0.6 threshold. The generic configuration error
hid this actual cause.

## Repair

A narrowly bounded recovery accepts a measured segment tail for a short phrase
only with complete consecutive mapping, matching context on both sides, at least
four consecutive exact characters inside the phrase, and the next phrase anchored
after the segment end. It preserves the actual confidence and a warning. It does
not estimate an internal cut, relax the ordinary threshold, or rewrite captions.
Recognition failures now identify missing programs/models or unmatched shot IDs.
Cached recognition can be reused without rerunning the CLI.

## Verification And Live State

- The original recording replay passes: 69 shots, 68 measured internal boundaries,
  94 captions, 9,840 frames and 328 seconds. Original narration and caption text
  are unchanged. Every frame cut is at or after its measured narration end.
- Shot 47 uses 225,460 ms, following the measured segment tail at 225,300 ms.
- Focused alignment and production tests: 48/48 passed. Backend typecheck passed.
- Recovery saved the original job snapshot, reused the original master and ASR
  cache, and applied the validated timing checkpoint with a compare-and-swap on
  the original snapshot. No factory instance was created in the recovery process.
- Existing retry API accepted the same job, returned `queued`, `error: null`,
  `audioTimingVersion: 2` and 68 measured boundaries. Other active jobs were
  preserved. This is recovery of timing and queuing, not a completed new film.
- The running backend was kept alive to preserve active rendering. Episode 1080
  already has its corrected checkpoint; general code changes load on the next
  safe backend restart.

Artifacts: `data/reports/history-1080-audio-alignment-20261028/` contains
`before-snapshot.json` and `alignment-report.json`. The source recognition and
`whisper-6b23e2a1bca6b5f4-ends.json` remain in the original job directory.
No human listening or phoneme-level forced alignment is claimed.

Changed files: `backend/src/services/history-motion-audio-align.ts`, its test,
`backend/src/services/history-motion-pipeline.ts`,
`backend/src/services/history-motion-production.test.ts`, and the existing
`remotion-history-factory` skill.
