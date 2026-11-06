# History Workflow Optimization

## Outcome

Make a collection batch explain its current end-to-end outcome, reduce transient
provider failures, recover explicitly safe interruptions, and lower storage and
rendering overhead without repeating remote work or weakening deletion checks.

## Delivery Lanes

1. Add a read-only, paginated batch outcome API and matching collection-monitor
   view. Keep historical collection counts immutable. Show current draft,
   production editions, publication receipts, released local media, recovered
   failures, and actionable stagnation separately from human review status.
2. Coordinate text-provider request capacity across processes with bounded,
   cancellable admission and durable shared 429 cooldown. Do not add HTTP replay.
3. Centralize periodic storage cleanup in the independent maintenance service.
   Improve repeated input inspection and startup recovery while preserving live
   receipts, exact references, pins, identities, and atomic authorization.
4. Add bounded recovery for collection tasks explicitly paused by rate limits.
   Persist retry budgets across restarts, honor user stops and newer collections,
   and display stalled work without canceling unknown remote operations.
   Prioritize fresh publication checks within the existing read-only lane.
5. Add a conservative render fast path only where it preserves the existing
   composition, plus broadly applicable asset/bundle reuse. Verify with real
   local short renders; report eligibility and actual measured limits.
6. Audit material updates and make unchanged complete clips incremental. Reuse
   verified local files across projects, repair only missing/invalid files, and
   coordinate in-flight downloads without interrupting the active update.

## Regression and Verification

Use isolated databases and temporary media. Cover old source events beyond the
100-item UI snapshot, recovery versus historical errors, script revisions,
submitted versus published receipts, deleted media versus unfinished work,
cross-process capacity/cooldown, repeated worker ticks, and preservation of
unknown remote outcomes. Run focused backend/frontend tests and typecheck.

Inspect the real #40332 batch through the API and browser at desktop and mobile
sizes. Never restart active paid creation/upload work. Activate services only
after read-only readiness checks or a verified submitted-project polling window.
Keep current publication identities and original production assets intact.

## Progress

- [x] Inspect current implementation and assign independent bounded work.
- [x] Batch outcome API and UI.
- [x] Shared provider admission and cooldown.
- [x] Independent storage scheduling and performance improvements.
- [x] Bounded recovery, stagnation visibility, and publication prioritization.
- [x] Render implementation and representative local measurement.
- [x] Incremental material updates and missing-file recovery.
- [x] Integration, real batch verification, and final report.
- [x] Activate read-only batch monitoring and independent storage scheduling.
- [x] Install a one-shot activation watcher that waits for active production.
- [ ] Main backend activation after collection #40334 and other active production
  finish. See `outputs/history-workflow-optimization-20261102/activation-watch.json`;
  no active collection, paid production, render, or upload is interrupted.
