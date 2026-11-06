# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Chinese-language content producers collecting historical material, editing adapted scripts, producing videos through Huasheng, and preparing standalone WeChat articles and publishing assets. Desktop is the primary production environment; browsing and task checks must also work on phones.

## Product Purpose

Turn collected source material into usable content and durable production records. Success is a saved script, a genuinely accepted video task or exportable video, and independently usable article and publishing assets.

## Operating Context

The existing `/history-scripts` workspace collects CZGTS articles or Douyin video sources, corrects and adapts text, preserves source material, submits saved scripts to Huasheng, inspects production states, and prepares covers and WeChat articles. The user prioritizes reliable output and efficient repeated operation.

## Capabilities and Constraints

- Source text and correction remain read-only; edits to adapted text require explicit durable saves with revision checks and unsaved-draft protection.
- Source selection, search, pagination, collection monitoring, and background polling must preserve unsaved work.
- Huasheng production states are not started, queued, creating, and completed. Only the real platform queue or editor proves creation started; enabled video download proves completion.
- Standard quota exhaustion prevents acceptance into Huasheng's queue. Preserve the project, display the cause, and allow explicit recovery after quota returns. The user requires standard mode for quota-blocked projects; do not automatically use paid fast mode.
- Do not add script length gates. Articles adapt the full original into standalone Chinese content rather than referring readers to a video.
- Keep existing API contracts, collection settings, logs, cancellation, source links, video upload, cover planning and generation, article export, and original media playback.
- Open the production board by default. Keep collection one action away and make script outputs easy to reach from the board; the user confirmed all three as everyday priorities.
- The intended chain is collection, saved adapted script, video production, recurring platform checks, then a manually downloaded and submitted finished video that automatically starts a standalone article. Download remains a deliberate user action on the video provider; no automatic paid export or browser download is required.
- Associate the submitted video with its selected source and saved script before generating an article. Persist accepted article work so closing the page cannot lose it. Do not backfill or regenerate old articles without an explicit request.
- Video production is the provider-neutral workspace; Huasheng is the current provider. Other providers can reuse the existing finished-video submission boundary without changing how sources, scripts, articles, or publishing assets are associated.
- Platform uploads reuse the installed social-auto-upload safety extensions. Default selected targets are Baijiahao video, Baijiahao article and Channels video; articles use a project extension rather than a claimed upstream feature. Missing assets are reported per project and target before a durable serial queue runs.
- Uploads default to saving drafts without repeated confirmation, never public publishing. Explicit upload-only previews remain optional. Preserve receipts and uncertain results across refresh; never blindly repeat an upload or draft save. User login, security verification and platform declarations remain outside automatic decisions.

## Brand Commitments

Keep the Huobao Studio name and existing application navigation. Use direct Chinese workflow labels and honest task states. This request redesigns the history workspace rather than other studio routes.

## Evidence on Hand

Real saved scripts, original source videos and articles, Huasheng project links and production observations, collection logs, cover outputs, and generated article records are available through existing local APIs. No synthetic production result is needed.

## Product Principles

- Put the current content task within immediate reach.
- Separate source processing, platform production, and publishing assets without losing their relationship to a script.
- Surface blockers with their observed cause and a relevant action.
- Preserve drafts and backend tasks across navigation.
- Keep the interface dense enough for repeated production and readable at realistic Chinese title lengths.
