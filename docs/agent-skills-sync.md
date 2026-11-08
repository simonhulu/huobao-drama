# Agent Skills Synchronization

The production backend does not load agent skills at runtime. Synchronizing
project skills keeps development and production instructions consistent when
Codex runs on another computer. Personal installed skills can be copied
separately without copying agent credentials, MCP configuration, or plugins.

Inspect the four installed skill roots without changing files:

```sh
node scripts/sync-agent-skills.mjs
```

Create a new portable staging directory:

```sh
node scripts/sync-agent-skills.mjs --stage /tmp/huobao-skills-stage
```

The output contains `project/.codex/skills`, `project/.agents/skills`,
`user/.codex/skills`, and `user/.agents/skills`. Install the `project/` contents
under the target checkout and the `user/` contents under the target user's home.
`manifest.json` records copied skills and skipped broken links. References,
scripts, assets, and executable modes are retained. Symlinks are resolved into
ordinary files so the source username or home directory is not required.

The script excludes dependency directories, caches, generated build/video
outputs, native executable binaries, environment files, private key files,
and common credential files. Rebuild any required native tooling on the target
computer through the skill's documented setup. Existing staging directories are
rejected. It does not write to any live skills root, remove broken links, or
install software. A transfer should back up changed target files and avoid
deleting target-only skills; do not use `rsync --delete`.

Built-in hidden skill directories and plugin-managed skills are intentionally
not included. Install their associated plugin on the target computer through
the agent's normal plugin mechanism.
