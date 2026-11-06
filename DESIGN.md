---
name: History Production Workspace
description: A compact production workspace within Huobao Studio.
colors:
  primary: "#18181b"
  primary-hover: "#3f3f46"
  selection: "#2563eb"
  selection-bg: "#eff6ff"
  blocker: "#9a4c08"
  blocker-queue: "#92400e"
  blocker-bg: "#fff7ed"
  complete: "#15803d"
  danger: "#b91c1c"
  surface: "#ffffff"
  surface-muted: "#fafafa"
  surface-active: "#f4f4f5"
  border: "#e4e4e7"
  border-strong: "#d4d4d8"
  text: "#27272a"
  text-muted: "#71717a"
typography:
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0"
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0"
  manuscript:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.9
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  compact: "5px"
  control: "6px"
  tool: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
  queue-control:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-hover}"
    rounded: "{rounded.compact}"
    padding: "5px 10px"
    height: "32px"
  search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.compact}"
    padding: "0 8px"
    height: "32px"
---

# Design System: History Production Workspace

## Overview

**Creative North Star: "The Content Production Desk"**

The history workspace is a quiet, light, utilitarian part of Huobao Studio. Compact typography, fine dividers and independently scrollable work areas give real content more space than controls. The existing studio identity and global navigation remain unchanged; this document governs `/history-scripts`, not every studio route.

Production, manuscript work and collection are distinct workspaces. Persistent selection connects them without replacing unsaved text or remounting source media. Visual confidence comes from precise state labels and durable results, not decorative summaries.

**Key Characteristics:**

- Task-separated, content-first work areas.
- White and zinc surfaces with semantic blue, amber, green and red accents.
- Compact controls, readable Chinese manuscripts and visible keyboard focus.
- Actual source media, finished videos, covers and article previews.

## Colors

### Primary

Near-black primary actions anchor the neutral workspace. Reserve solid primary buttons for the current command, not every navigation item.

### Secondary

Selection blue identifies active sources, focus and links. Amber identifies blockers and editorial concerns; green identifies verified readiness or completion; red identifies failed operations and destructive commands. Every state also has a text label.

### Neutral

White is the working surface. Muted zinc separates toolbars, filters and table headings. Fine borders establish hierarchy; muted text carries secondary metadata without dimming editable prose.

**The Evidence Rule.** Color never substitutes for a state name or upgrades an uncertain platform observation into success.

## Typography

System sans is intentional for this operating surface. The studio wordmark remains outside the workspace type system. All workspace text has zero letter spacing and fixed-size type rather than viewport-scaled headings.

Page identity uses the heading role; queue and collection headings use the section role. Manuscript prose and the editor share the manuscript role. Controls and rows use body type; labels and metadata stay compact. Counts and timestamps use tabular numerals.

Long titles wrap or truncate inside bounded tracks. A complete title remains available through its link, heading or tooltip. Single-line draft provenance truncates as one complete line, never a clipped second line.

## Layout

Production is the default workspace and uses a master/detail split. At 1100px and above, page identity, collection commands and workspace tabs share one band. Production replaces the permanent collection strip with a header monitoring command that shows running/attention state and opens the existing drawer. Other workspaces keep the collection strip. Video-provider switching shares the production toolbar. A 360px left rail (320px on smaller desktops) contains filters, search and compact task rows. Each row shows title, status and one progress line; clicking it opens the right-hand project detail. Checkboxes independently control batch selection. Batch commands sit above the right-hand detail, processing/concurrency status in the bottom bar. Settings open inside the detail's scroll container and never shrink the left list.

The source library uses a sidebar (304px; 268px on narrower layouts) and flexible detail area. Separate scroll containers keep the list, manuscript and output tools usable without a growing page of stacked panels.

Desktop manuscript comparison uses equal `minmax(0, 1fr)` columns. A focused editor is available when comparison is too narrow. Detail tabs disclose manuscript, production, delivery, article and source/review rather than stacking them.

At 980px width and below, the shared collection strip hides inline counts and keeps its commands on the same row as the task identity. Counts remain available in the collection workspace and monitoring drawer. At 760px and below, the library and production switch between list and detail, with an explicit return command. Production retains mobile access to batch commands and returns keyboard focus to the inspected task. Collection tables reflow into stacked rows; workspace/detail tabs scroll within their own tracks. On desktop, the production list and detail scroll independently. At 600px viewport height and below, desktop production retains a 520px working area within a scrollable page; phone task lists grow with the page. Never compress the task list into a narrow scroll strip to keep every toolbar fixed.

Use the spacing scale for groups. Dense controls stay together; document and tool boundaries receive the larger steps. Do not add floating cards around page sections.

## Elevation & Depth

Working surfaces are flat. Borders and muted bands establish grouping; editor frames and preview boundaries are functional, not decorative. Drawers and dialogs may use the existing studio overlay shadow and backdrop. Do not add shadows to queue rows or page sections.

Short state transitions use the existing studio ease-out. Loading icons move only while work is active; reduced motion disables their rotation. No decorative entrance sequence is required for repeated production work.

## Shapes

Compact queue controls use the compact radius. Other workspace controls use the control radius; genuinely framed editors and media tools use at most the tool radius. Repeated rows remain rectangular, separated by fine rules. Small status labels may use modest rounding; do not turn navigation into pill collections.

## Components

### Commands And Inputs

Use existing Lucide icons. Icon-only commands have an accessible name and hover title. Binary settings use labeled checkboxes. Commands combine icon and concise Chinese text when their outcome needs a label. Search inputs, disabled controls and saving indicators retain stable dimensions. Focus is visible on keyboard navigation; active editors have an inset focus treatment.

### Navigation

Top-level and detail tabs use underline selection, semantic tab state and roving keyboard focus. Switching a workspace preserves the active draft, source selection and media node. Switching to another source still uses the existing unsaved-change guard. Phone list/detail navigation is explicit.

### Production Rows

Compact rows keep title/source identity, actual platform state and a short progress summary together. The right-hand detail shows the full cause, last-check time, export/article progress and relevant commands. Opening a task does not change batch selection. Refresh preserves the inspected task while it remains in the filtered list; a filter that excludes it selects the first matching task. Support search and all four platform states. Standard quota exhaustion is visibly not started, with an amber cause and recovery action. Real queued/creating/completed observations override stale quota messages. Completed-project links open the corresponding project for manual download and name the download in both visible and accessible labels; the output action opens that source's finished-video area.

One-off checks and recurring monitoring are distinct controls. The recurring switch defaults off, reflects server-confirmed persisted state and is independent of automatic creation admission. A failed check retains the last valid result and its timestamp.

### Delivery And Articles

Video submission uses a Chinese, keyboard-accessible file control and visible upload/validation progress. Validated submission associates the video and durably queues a standalone article atomically. Successfully associated video and article-generation progress are different states. Show pending, active, failed and complete article work with direct navigation to the article. An uncertain upload uses a GET status check and preserves publishing and cover drafts while the result is confirmed. Keep existing covers, article exports and prior outputs available; do not clear an old result while preparing a replacement.

### Errors And Dialogs

Lead with the failed operation and observed cause. Keep detailed logs and status histories in disclosures or the collection drawer. Dialogs have visible cancel and close commands, focus containment, Escape dismissal and focus return. Background updates never steal focus or overwrite a dirty manuscript. Saving, conflict, stopping, interrupted, empty and unavailable-media states remain distinct.

## Do's and Don'ts

### Do:

- Do use real saved content and correctly associated media as visual evidence.
- Do preserve unsaved text, revision conflicts, source provenance and independent task updates.
- Do distinguish a platform conversation, accepted production, export availability and a locally associated finished video.
- Do retain manual download and standard-mode quota decisions; expose blockers honestly.
- Do keep long titles, Chinese labels and working lists usable on phones and short screens.

### Don't:

- Don't stack every workflow on one page or place cards inside cards.
- Don't add decorative metrics, marketing heroes, gradients or illustration to this operational surface.
- Don't infer completion from a project link or an accepted local request.
- Don't add script-length gates or turn editorial suggestions into production blockers.
- Don't discard old outputs, silently overwrite drafts, bypass login verification or imply that cancellation reverses provider billing.

## CBA video workspace contract

### Source of truth

Status: Active. Refreshed: 2026-10-24. This section extends the same visual language to `/cba-video`; the history-specific interactions above remain scoped to `/history-scripts`.

Evidence: `frontend/app/pages/history-scripts.vue`, `frontend/app/assets/studio.css`, `.codex/skills/cba-video-factory/`, `scripts/cba-video/`, `backend/src/services/social-auto-upload.ts`, and the existing CBA job and rendered files in `data/cba-video/`.

### Goal, user and information architecture

One operator starts a round from the current Hupu CBA homepage, sees which news can become videos, reviews the two actual outputs, and reaches saved drafts on 视频号 and 百家号. The workflow reads news first, researches the event, matches footage, produces a news version and an original-audio highlights version, then uploads to the chosen draft boxes. Deduplicated and unavailable items retain their actual outcomes. Public publication and a general-purpose video editor are outside this surface.

The page prioritizes “继续未完成（N）” for existing interrupted work and provides “采集新新闻” as a separate action. Resuming opens a default-selected list with each task's next action and original upload account/platform; the operator can deselect entries. The backend persists the selected scope, processes it serially, continues after individual failures, and reuses existing progress without rescanning the homepage. A compact queue banner shows current work, outcomes, and a stop action. Waiting behind an existing run must not interrupt it. A searchable task list and selected task remain the main workspace. “成片与上传” is the default detail, with “文稿与来源” as a secondary tab. Run history and platform connections use compact dialogs. Do not add dashboard statistics, decorative heroes, or expose CLI parameters in the main workflow.

### Visual language and components

Use the existing system sans typography, zero letter spacing, zinc surfaces, near-black commands and semantic state colors. Reuse studio buttons and Lucide icons with local compact sizing. Queue rows, preview tools and upload receipts use dividers rather than nested cards. Show a real, playable video with a two-version switch; links expose the corresponding files and covers. Each platform shows separate news/highlights receipts. A rendered video is “成片就绪”; only confirmed saves to all selected destinations qualify as “草稿已保存”.

### Interaction states and accessibility

Read actual task stages; no invented percentage or spinning indicator while idle. Keep the last valid state on polling failure. Stop prevents new work and preserves completed results. Retry reuses upload checkpoints; uncertain uploads are reconciled rather than blindly duplicated. Missing footage, failed creation, expired login and unknown upload outcome have a cause and a relevant recovery action.

Use semantic buttons, named video controls, readable Chinese labels, visible focus, and keyboard-operable detail tabs. Native dialogs contain focus, close with Escape and return focus to the opener. Loading and errors are announced without making the entire detail an alert. Honor reduced motion. On narrow screens, list/detail navigation is explicit; on short screens the page remains scrollable around a usable minimum work area.

### Defaults and implementation constraints

“开始扫描并生产” explicitly authorizes that round of automatic research, editing, A-voice MiniMax narration and rendering. Explain this before submission; do not claim the operator watched a preview. Preserve existing approvals and outputs. Default to the whole current homepage, both video versions, A voice, and saving drafts on both platforms. Persist confirmed run settings. Login controls use the existing upload runtime. No new dependencies or design system.

Use Nuxt/Vue and the real CBA API; tests inject production/upload adapters rather than spending provider credits or posting to platforms. Completion requires a built page, real local media playback, honest task state, and verified recovery/idempotency behavior. Platform login and availability remain external prerequisites, shown on demand. No open design questions block this implementation.
