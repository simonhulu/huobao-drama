# Episode creation failure

Only use this note when the runner returns `EPISODE_CREATE_FAILED`.

- Inspect the persisted `drama_create_intent` and `episode_import_intent` before retrying.
- Recover the dedicated drama by its run token; never create a second drama for the same run.
- A dedicated drama may own exactly one imported episode. More than one is a conflict, not a reason to pick one.
- Keep the original script hash, fixed voice, image config, aspect ratio, and BGM unchanged.
- Retry through `advance`; do not call the import API by hand.
