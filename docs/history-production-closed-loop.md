# Historical Video Production: Closed Loop

## Outcome

Produce the accepted Huasheng and refined editions independently, prepare each
edition's own publication materials, and obtain a Baijiahao submission receipt.
Expose the actual remaining work and recover the original task without repeating
completed production, rewriting a saved manuscript, or duplicating publication.

## Confirmed Problems

- Huasheng's first 50 jobs are presented as the complete production inventory.
- Platform storyboard readiness is confused with an exported local video.
- An accepted export is projected as a completed production branch.
- Publication candidates are selected from a legacy manuscript-level video path.
- A manuscript with one submitted edition is shown simply as awaiting upload.
- Historical drafts and manual markers are confused with publication receipts.
- Failed packaging and uncertain publications need different recovery actions.

## Terms and Completion

- Manuscript revision: the accepted saved text and its SHA-256 identity.
- Edition: one producer's output for that manuscript revision.
- Platform assets ready: Huasheng can start exporting; this is not a local video.
- Video delivered: a current local video is recorded for the edition.
- Materials ready: the edition has current titles and required cover files.
- Ready to submit: video and materials are ready, with no existing active,
  uncertain, or successful publication of that edition.
- Submitted: a validated platform receipt confirms submission, including review.
- Published: the platform receipt explicitly confirms publication.
- Workflow complete: every required edition has a submission receipt.

Technical rendering validation remains separate from editorial/visual/listening
review. This change must not silently add a human approval prerequisite or claim
an editorial review that did not occur.

## Single Read Model

Read existing durable records; do not introduce another mutable workflow status.
Use the current manuscript revision and latest video per producer. Required
editions are Huasheng and motion for dual production, motion for refined backfill,
and actual current editions for standalone work. Preserve legacy-only records as
needing review rather than asserting they are ready to publish.

Each edition exposes `key`, `scriptId`, `scriptSha256`, `producer`, `videoId`,
`state`, `stage`, `message`, `error`, `action`, `jobId`, `exportJobId`,
`automatic`, `canPublish`, `revisionOfVideoId`, and `previousJobId`.

`state`: `pending`, `producing`, `exporting`, `packaging`, `ready`, `queued`,
`uploading`, `submitted`, `published`, `attention`, `uncertain`, or `stale`.

`stage`: `production`, `export`, `packaging`, or `publication`.

`action`: `none`, `continue_production`, `retry_export`, `retry_packaging`,
`retry_upload`, `reconcile`, `publish`, or `review_legacy`.

The publication inventory returns manuscript rows with an explicit `versions`
array. The publication screen presents and selects individual editions. It groups
them into in progress, ready to submit, needs attention, submitted for review,
and published. Counts use the same edition records as the displayed rows.

## Automation and Recovery

1. Save a current manuscript before accepting production work.
2. Register both required production tasks durably and independently.
3. Huasheng completion requires local delivery, not export acceptance. Observe
   export failures and expose them without stopping the refined branch.
4. Prepare independent publication materials using existing reusable artifacts.
5. Submit each ready edition once; neither edition waits for its sibling.
6. Follow the original upload task and distinguish submitted from published.
7. Continue/resume actions recover the earliest unfinished step. Production is
   not restarted for an edition that already has a valid video.
8. Safe pre-dispatch transient failures may use bounded backoff. Unknown external
   outcomes must reconcile the original checkpoint, never create a second attempt.
9. Terminal material failures are visible, actionable, and not repeatedly polled
   as normal pending work without an explicit retry or changed evidence.

## Cleanup Plan

### Cooperation Between Production and Publication: 2026-11-01

- Remotion owns production, previews, and downloads. Its publication area reads
  the same per-edition state as the publication workspace, including material
  failures before an upload job exists, and links to that exact video edition.
- Historical Episode editing delegates publication to the shared workspace;
  unrelated Episode workflows keep their existing platform controls.
- A new render of an edition with an earlier submission is a revision, not a
  new automatic publication. The original task and receipt remain intact.
  Explicit submission of a ready revision uses the same queue and safeguards.
- An unresolved earlier submission must be recovered or reconciled before a
  revision can create another external publication attempt. New manuscript
  revisions and the sibling producer remain independently scoped.
- Preserve the payload and evidence of any dispatched publication. Edits to
  publication materials cannot change that attempt during recovery.
- Add regressions for these boundaries before changing production behavior;
  verify UI writes with intercepted requests and real services through reads.

- Replace manuscript-only publication candidacy and merged uploaded-state caches
  with the edition read model.
- Replace branch-flag-only workflow completion with artifact/receipt predicates.
- Remove the manual uploaded marker from the normal publication workflow; retain
  historical receipts as evidence without counting them as current submission.
- Keep existing producers, delivery packaging, and checkpoint-aware upload code.
- Avoid unrelated refactors, new dependencies, destructive schema changes, and
  rewriting or deleting historical tasks.

## Regression and Acceptance Scenarios

Write failing tests for changed behavior before implementation, retaining useful
existing regression coverage.

1. Huasheng assets ready plus accepted export is not delivered/completed.
2. A failed export remains recoverable after the refined edition completes.
3. One submitted edition and one unfinished edition show two distinct states;
   the submitted edition cannot be submitted again.
4. Failed titles/covers are needs-attention, never ready-to-submit.
5. Old manuscript video paths and draft/manual upload markers cannot qualify a
   new revision or falsely complete publication.
6. Unknown submission results resume/reconcile the original task and never create
   a duplicate upload or publish request.
7. Complete means all required edition submission receipts, not platform assets
   or mutable coordinator flags.
8. More than 50 Huasheng records have correct global totals and reachable pages.
9. Explicit selection sends exact video IDs; publishing one edition cannot submit
   or modify its sibling.
10. Restarts and overlapping ticks preserve task identity and existing artifacts.
11. Desktop and mobile show readable per-edition states, meaningful actions, and
    no layout overflow. Existing manuscript editing/navigation remains usable.
12. Remotion and the publication workspace agree on packaging failures before an
    upload job exists; links focus the exact manuscript and delivered video.
13. Focusing a video never selects or submits it. Cached selections and inventory
    refreshes cannot transfer consent from an old render to a new revision.
14. Revisions with an earlier submitted render require explicit submission.
    Unresolved original attempts remain recoverable through the original job,
    including jobs outside the initial queue page and legacy file-bound attempts.
15. Historical Episode publish and confirm APIs return the shared workspace URL
    before creating tasks or writing confirmations; ordinary Episodes still work.

## Delivery Checks

- Focused service/route regression tests and TypeScript checks.
- Frontend component tests and production build.
- Playwright scenarios with intercepted mutation endpoints for recovery and
  submission; read-only real inventory checks for existing data.
- Inspect live worker activity before replacing a process. Load changed code at
  a checkpoint that preserves renders and original upload sessions.
- Do not trigger bulk historical publication merely to verify this change.

## Delivered and Verified: 2026-11-01

- Added the shared edition read model in `history-production-state.ts` and moved
  artifact provenance checks into the pure `history-script-artifacts.ts` module.
- Publication candidates, manuscript filters, and continuation completion now
  agree on required producers, current local files, and validated submission
  receipts. Legacy same-file publication receipts remain recognizable.
- Recovery follows original export, motion, and upload identities. Canceled
  publication attempts with dispatch evidence and old completed records without
  valid receipts resume their original checkpoints; they cannot become fresh
  uploads. Unattempted cancellations remain canceled.
- The publication page selects exact editions, polls unfinished local work, and
  exposes actionable recovery. Removed normal manual-upload marking and the
  obsolete manuscript-level uploaded-state cache merge.
- Huasheng totals cover all pages, platform completion is labeled assets ready,
  and the 1024px production rail keeps its usable list height.
- Saving a changed manuscript clears the previous revision's completion
  immediately. Late responses from an older saved revision are ignored.
- Updated the current publication and continuation documentation. No schema
  reset, deletion of historical tasks, or bulk manual publication was performed.

Validation:

- The integrated backend regression run passed 350 tests. One additional HTTP
  canceled-attempt regression was added afterward; the affected 25 route tests
  passed. Backend TypeScript checking passed after the final change.
- Frontend suites passed: publication 159, Huasheng 83, workspace 17,
  continuation 8, and delivery upload 41. The three affected Huasheng manuscript
  scenarios also passed after the final revision-reset change.
- Nuxt production build passed with an isolated build/output directory, leaving
  the running development server's generated files intact.
- Playwright checked exact sibling-edition selection and recovery hash payloads
  with mocked writes. Real read-only checks at 1440px and 390px showed no script
  errors, horizontal overflow, or mutation requests.
- Main backend and the standalone export worker were gracefully reloaded.
  Existing job identities, files, and publication checkpoints were preserved.

At the 09:21 local inventory snapshot, 129 manuscripts represented 217 video
editions: 67 submitted for review, 1 published, 122 needing attention, 18 with
uncertain publication outcomes, and 9 still in production/export. No edition
qualified as ready for a new publication. Counts continue to change as the
already accepted background work advances.

Real records `799`, `803`, and `890` retain their local Huasheng video and now
show material failures with `retry_packaging`; `116` remains incomplete because
its Huasheng export needs recovery even though its refined edition was submitted.
Those historical failures were not bulk retried as part of verification.

Final live check at 09:29 local confirmed the main backend process started at
09:28:29, after the last canceled-attempt HTTP mapping change. Production and
publication pages, the publication queue, and worker health all returned HTTP
200 through port 3013. The export worker remained active with an empty error
log. The current inventory still contained 129 manuscripts and 217 editions:
67 submitted, 1 published, 103 needing attention, 18 uncertain, and 28 in
production/export; none qualified for a new submission. The queue exposed the
18 canceled attempts with dispatch evidence as uncertain, preserving their
original recovery actions. This final check made no publication or recovery
requests.

## Production and Publication Cooperation Delivered

- Remotion reads the canonical source/edition state through
  `GET /api/v1/history-scripts/uploads/sources/:sourceId/state`. Packaging errors
  remain visible before an upload task exists; another edition's receipt cannot
  become the current preview's publication result.
- Publication links carry the source and exact delivered video when known.
  Source-only links show both editions of that manuscript. Opening a link does
  not select, prepare, or submit an edition. Clearing the focus restores the
  global inventory, including when the hidden manuscript list is nonempty.
- Clearing publication focus preserves an unsaved manuscript in the editor.
  Explicitly selecting another manuscript removes the previous video's ID;
  ordinary manuscript-switch and page-leave protections still apply.
- Historical Episode publication and confirmation controls delegate to the
  publication workspace. Their legacy POST APIs return `409` and
  `publicationUrl` before creating or confirming a task.
- An additional render after the same producer's earlier submission requires
  explicit publication. Pending or unresolved original attempts block the
  revision and remain reachable by original job ID, even outside the first
  queue page. A ready revision cannot inherit an old browser selection.
- Automatic enqueue checks revision eligibility inside the SQLite transaction,
  including failed-job reactivation. Exact-file legacy jobs with missing video
  IDs or older fingerprints reuse the original job and dispatched payload.

Verification for this cooperation change:

- The focused backend service/route run passed 275 tests; backend TypeScript
  checking passed. The legacy-entry review also confirmed the exact-file reuse
  and automatic-reactivation fixes with six targeted regressions.
- Frontend publication, Remotion, and Episode suites passed 167, 20, and 7
  tests respectively during implementation. After the final navigation fixes,
  all eight real-Nuxt navigation regressions and all 17 workspace tests passed.
  These include a nonempty hidden library and an unsaved manuscript on clear.
- The final Nuxt production build passed using separate build and output
  directories, preserving the development server's generated files.
- Eight real-data snapshot scenarios passed at 1440px and 390px: exact editions
  `803/102` and `116/98`, manuscript-only `116` and clearing its focus, and
  Remotion Episode `1103`. Each finished with zero script, console, or API errors,
  zero non-GET/HEAD requests, and no horizontal overflow. The video loaded at
  1920x1080; the Remotion receipt matched original job `257` and article
  `1880545428232526606`. Clearing focus showed all 217 snapshot editions with
  zero selected. Evidence is in
  `frontend/.impeccable/review/history-cooperation-live-final-20261101/`.
- The existing floating task-center panel can cover lower Remotion content on
  mobile. The publication status is fully readable after scrolling it into the
  viewport; this shared-layout behavior was outside the changed modules.
- At 12:49 local, the running backend served the new source-state endpoints for
  `803` and `116` through port 3013 with HTTP 200; worker health reported 418/418
  healthy. The standalone export worker was reloaded at 10:45 local.
- Original renders for `149` and `114` retained their completed task IDs and
  output paths. Task `28` retained its original identity and saved inputs after
  a browser crash, and returned to the production queue. Existing failed and
  uncertain external tasks were not bulk retried as an acceptance check.
