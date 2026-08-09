# State recovery failure

Only use this note when the runner returns `SCRIPT_CHANGED`.

- A run is bound to the original script SHA-256. Do not silently adopt edited input.
- Preserve the old run state and delivery artifacts for audit.
- Start a new run from the changed script; never mutate the frozen manifest or reuse its approvals.
