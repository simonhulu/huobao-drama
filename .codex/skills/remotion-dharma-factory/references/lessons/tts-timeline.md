# TTS timeline failure

Only use this note when the runner returns `TTS_TIMELINE_MISMATCH`.

- `pre_tts_titles_json` is the only timing authority. Never replace it with character-count estimates.
- Repair missing, overlapping, decreasing, or out-of-range title timestamps at the TTS source.
- The title coverage ratio must remain within `0.60-1.05` of narration audio duration.
- Do not hide a mismatch by stretching panels, subtitles, the tail, or the final video duration.
- After repairing TTS data, re-run the exact verification action; do not recreate the episode.
