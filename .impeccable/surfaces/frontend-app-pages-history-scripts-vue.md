---
version: 1
slug: "frontend-app-pages-history-scripts-vue"
primary_target: "frontend/app/pages/history-scripts.vue"
related_targets: ["frontend/app/components/HistoryHuasheng.vue", "frontend/app/components/HistoryScriptDelivery.vue", "frontend/app/components/HistoryScriptArticle.vue"]
---

# History Workspace Redesign

Scope: `/history-scripts`; visitor mode: Operate. Preserve existing APIs, saved drafts, source records, background tasks, article and cover tools. The user confirmed production as the default workspace, with collection and direct access to outputs as everyday priorities.

## Direction contract

THESIS: One workspace per production job; selection and drafts survive switching.

OWN-WORLD: Studio white and zinc surfaces, compact sans, fine dividers, blue selection, amber blockers, green completion; restrained 6px controls.

STORY: Collect material, save an adapted script, produce a video, monitor it, then manually download and submit the finished video to automatically produce a standalone article. Global task queues and manuscript editing have their own room.

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
- The platform's completed state proves export availability, not local video presence. Download stays manual; validated video submission atomically associates the video and durably queues standalone article generation, with a direct article action.
- An uncertain upload reconciles through a GET status check while preserving publishing and cover drafts.
- Recurring checks are a visible persistent switch, off by default and independent of automatic creation admission. Checks never create, purchase, download, or resume work.
- Single-project platform uploads live in a detail tab; a separate upload-queue workspace provides selection of associated finished-video projects, with video production remaining the default. Targets default to Baijiahao video/article and Channels video. Flat target rows show exact missing prerequisites per project and format, followed by durable serial upload results. Upload previews and confirmed draft saves are distinct; public publishing is never an automatic outcome.
