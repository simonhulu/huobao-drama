# History Workspace Redesign

Scope: `/history-scripts`; visitor mode: Operate. Preserve existing APIs, saved drafts, source records, background tasks, article and cover tools. The user confirmed production as the default workspace, with collection and direct access to outputs as equally important supporting workflows.

## Direction contract

THESIS: One workspace per production job; selection and drafts survive switching.

OWN-WORLD: Studio white and zinc surfaces, compact sans, fine dividers, blue selection, amber blockers, green completion; restrained 6px controls.

STORY: Inspect production first, resolve blockers, open the related script and outputs, or start another collection. Global task queues and manuscript work have their own room.

FIRST VIEWPORT: A master/detail production desk. Desktop identity, collection commands and workspace tabs share one band; provider switching joins the toolbar. A narrow left rail contains filters, search and compact task summaries. Clicking a task displays its full progress, outputs and actions on the right. Checkboxes control batch selection independently; batch actions stay above the detail. Processing status sits in the footer, settings within the detail scroll area. Phone users switch between task list and detail with an explicit return action. Library drafts survive workspace switches.

FORM: Task-separated workbench, grounded candidate 7; seed 67e69eff. Code-led implementation using real existing content and media.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Functional Boundaries

- Top-level workspaces: script library, Huasheng production, collection tasks.
- Script detail tabs: manuscript, Huasheng, delivery and covers, WeChat article, source and review.
- Preserve version/dirty guards, save conflicts, cancellation, logs, login checks, recovery, upload, exports, and background polling.
- Standard quota blocks remain visibly not started; recovery never silently purchases fast mode.
- Desktop keeps list and current work independently scrollable. Phones switch list/detail and use horizontally scrollable detail tabs.
- At widths of 980px or less, the shared collection strip hides inline counts and keeps commands on the same row as task identity. Counts remain available in the collection workspace and monitoring drawer.
- Desktop production uses a 360px task rail (320px on smaller desktops) and an independently scrolling detail pane. The inspected task persists across refreshes and remains independent of batch selection. Phones at 760px or less switch between list/detail and return focus to the inspected task. Short desktop windows retain a 520px working area with page scrolling.

## Production layout acceptance — 2026-10-25

- Left: status filters, search and compact task summaries. Right: one inspected project's complete state, timestamps, recovery actions and export/article results. Opening a project does not select it for bulk execution.
- The rail is 360px on larger desktops and 320px on smaller desktops. Both panes scroll independently. Phones have an explicit list/detail switch, access to batch actions and focus return; short desktop windows retain a 520px work area rather than collapsing the list.
- Default detail is the first matching task. Refresh keeps the same inspected task; excluding it with filters chooses the first new match. Batch checkboxes retain their existing filtered-selection rules and immutable-version guards.
- Current-project inspection sends only that task ID. Existing downloads, recovery, outputs and upload links retain their original actions and draft protection.
- Validation uses the actual Nuxt page in isolated Playwright browsers with mocked API responses. No test starts production, changes real monitoring or uploads to external platforms.
- Acceptance: 97 production/workspace regressions and 46 collection/motion regressions pass; Nuxt production build succeeds. Desktop/phone screenshots at 1366×768, 1280×720, 1024×650, 390×844 and 812×375 confirm usable columns, task/detail switching and reachable actions. Layout detector reports no findings. Verdict: ready.

## Production Workflow

1. Start a collection job from the persistent header action. CZGTS article collection and existing video-source settings remain available.
2. Successful collection produces and saves an adapted script. Collection, correction and adaptation retain their actual statuses and source records; length and editorial warnings do not block output.
3. The automatic-admission setting sends newly saved adapted scripts to Huasheng. The task belongs to the source and immutable script hash. A conversation alone is not a production start; the platform must show its queue or editor.
4. The production board offers one-off batch checks and a durable recurring-check switch, off by default and independent of automatic creation admission. Its state is persisted on the server. Recurring checks inspect unfinished current versions, skip canceled/completed projects, back off on errors, and do not submit, resume, download, or purchase anything. Quota exhaustion remains not started with its actual cause.
5. A completed row opens the corresponding Huasheng project for manual download, with download named in both visible and accessible labels. The user submits the downloaded file under that source's finished-video tab. After validation, video association and durable article queuing commit atomically. The standalone WeChat article uses the full corrected original and frames from the associated video. Queued, generating, failed and completed article states remain visible. Uploading and generation are separate outcomes: a failed article must not undo a successfully associated video.
6. An uncertain upload result triggers a GET status check while preserving edited publishing fields and cover drafts. A newly associated video confirms submission; an unconfirmed result remains visible for manual checking.

Other video providers can use the same finished-video submission boundary. No provider registry or generalized workflow engine is introduced for a single current provider.
