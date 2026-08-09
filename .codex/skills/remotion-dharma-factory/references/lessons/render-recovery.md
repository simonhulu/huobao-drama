# Render recovery failure

Only use this note for an unowned delivery, invalid native result, or render failure.

- Never overwrite an existing formal delivery.
- If delivery and `result.json` exist, verify output path, `native-comic-v11`, `dharma-text-v4`, subtitle preset (`ink-read-v2`), SFX evidence, frame count, and props fingerprint before recovering state.
- If those facts do not match, preserve the artifact for diagnosis and start a new immutable output path.
- Repair the native renderer or its inputs at the earliest failed stage; do not regenerate TTS or images without evidence that they failed.
- A recovered candidate still needs fresh full-resolution typography frame review. Old approval bound to v10 or another text-presentation fingerprint is invalid.
