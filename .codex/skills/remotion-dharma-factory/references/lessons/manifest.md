# Manifest failure

Only use this note for a manifest or image-dependency error code.

- Repair the earliest validator error and keep the fixed profile unchanged.
- Complete all semantic fields and prompts before freezing the manifest.
- Keep exactly five panels per page, a first panel at zero, strictly increasing starts, and no gap above 20 seconds.
- `referencePanelKeys` may only point backward; at most three total references are allowed.
- A frozen manifest is immutable. If its hash changed, create a new manifest and run state instead of editing the old state.
