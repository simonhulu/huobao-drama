# Task-Owned Media Storage Implementation Plan

**Goal:** Bound media growth while preserving production, project inputs and unconfirmed uploads.

**Architecture:** Register files and all workflow owners in SQLite. Eligibility is derived from durable, current transcript/render/publication evidence, never from a completed or deleted task flag alone. Recheck immediately before a filesystem mutation and retain an audit record. A manual inspection queue handles evidence that automation cannot establish.

**Tech Stack:** Existing Node filesystem APIs, better-sqlite3, Hono, Nuxt/Vue; no new dependencies.

## Retention Contract

- History/science source acquisition prefers compressed audio. CBA retains real video for editing. Douyin's current downloader has no audio/quality option, so its source and downloader archive are released after complete ASR.
- A complete transcript must retain source URL, source hash, full chunk provenance and durable text before source media is released. Failed or partial ASR is protected.
- Render bundle/copied inputs can be released only with a verified completed movie and intact original assets. Keep manifests, fonts, review evidence, original artwork, narration and the movie.
- A final movie requires receipts for every required destination, exact current video identity, no active/retry consumer and a seven-day retention period. Draft/save/status flags alone do not establish publication. Unsupported publication contracts stay protected.
- Deleting a task preserves media and upload evidence. Shared files retain every owner. Exact immutable material duplicates may share an inode without changing any project path.
- Manual deletion requires inspection of task references, unchanged SHA-256, explicit production/upload verification and platform receipt URLs. Only final movies with no unfinished consumer qualify. Other inputs require an independently verified archive. Before a producer reads archived inputs they are restored as regular files at the original path, preserving canonical-path engineering checks.
- A pin blocks automatic reclamation. Unknown provenance, incomplete jobs, pending uploads and unsafe paths are retained.
- A 10 GiB disk reserve stops new acquisition/render writes; existing uploads remain available. Hourly collection catches task state changes; endpoint and CLI permit immediate scans and cleanup.

## Implementation And Verification

1. Add regression tests for source/transcript retention, missing/current upload receipts, shared ownership, unsafe paths, manual evidence and stale inspection.
2. Change YouTube/history/science acquisition and cleanup in their existing pipeline modules. Prevent CBA task deletion from erasing recovery artifacts.
3. Add storage registry, evidence-driven inventory/cleanup, manual review API, audit log, worker and CLI. Inventory existing tasks including tombstones.
4. Add the storage tab under settings with disk usage, task references, safe cleanup and human inspection.
5. Run focused regression suites/typecheck and desktop/mobile browser checks. Scan the live disk, record a dry-run, apply only evidence-backed operations, then report actual free-space change and protected files.

## Execution Notes

The user authorized design, implementation and cleanup, then clarified that production/upload guarantees and manual inspection are mandatory. Failed-source time-based deletion is therefore excluded. The working tree already contains extensive unrelated changes; preserve them. Do not restart a backend that is executing production merely to activate this feature; a maintenance sidecar can serve the new endpoints until a normal backend restart.
