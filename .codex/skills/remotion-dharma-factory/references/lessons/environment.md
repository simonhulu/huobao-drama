# Environment failure

Only use this note when the runner returns `ENVIRONMENT_INVALID`.

- Repair the first item in `checks.errors`; do not bypass the check.
- The image configuration must be active `pcore` and include `gpt-image-2`.
- The active audio service config provider must be `minimax`, and the fixed narration voice must exist in `ai_voices` as a `minimax` voice.
- BGM must be the fixed production bed and at least 180 seconds long.
- Re-run the runner's exact environment action after repairing the evidence.
