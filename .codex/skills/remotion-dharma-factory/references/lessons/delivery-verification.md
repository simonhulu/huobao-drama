# Delivery verification failure

Only use this note when the runner returns `DELIVERY_VERIFICATION_FAILED`.

- Blocking failures are command/decode failure, wrong stream count/codecs/dimensions/fps/duration, wrong decoded frame count, audio-video drift, sustained black, TTS sync failure, or loudness above -20 LUFS.
- Short black candidates, bitrate drift, B-frames in the final scan, and ffmpeg diagnostics are warnings when decode, frame count, timing, and viewing output pass.
- Fix the verifier when the product is healthy but the checker lacks profile support; rerun only verification.
- Re-render only when the report proves the delivery itself is invalid.
- When `next_action=repair-delivery`, fix the unavailable verifier tool, then record it with `node <runner> repair-delivery --run <run> --actor <name> --reason "<repair evidence>"`; the next runner action re-runs only verification against the same delivery SHA-256.
- Three automatic checks and two explicit verifier repairs are the hard limit. Do not delete verification history or raise the budget.
