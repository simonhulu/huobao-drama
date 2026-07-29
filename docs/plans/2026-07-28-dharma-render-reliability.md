# Dharma Render Reliability Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` to implement this plan task-by-task.

**Goal:** Make a running Dharma full-render cancellation attributable and deliberate, while exposing render stage, elapsed time, frame rate, and ETA in the task center.

**Architecture:** Keep generic tasks backward compatible. The task route validates a richer cancellation body only for a running `dharma.episode_render`, then passes sanitized audit data to the persistent task event. Dharma's existing stage/progress stream becomes a stable progress message consumed by a pure frontend telemetry helper; the task center renders that helper and collects the cancellation confirmation/reason.

**Tech Stack:** Hono, Drizzle/SQLite task events, TypeScript, Vue 3/Nuxt, Node native test runner.

---

### Task 1: Lock the cancellation contract with route tests

**Files:**
- Modify: `backend/src/routes/tasks.test.ts`
- Modify: `backend/src/services/tasks/store.test.ts`

1. Add a failing route test proving a running `dharma.episode_render` rejects a request without a task-bound confirmation (`CANCEL <taskId>`) and a non-empty reason.
2. Add a failing route test proving a confirmed cancellation persists `reason`, declared actor, user agent, forwarded address, and source in `cancel.requested`.
3. Add a regression test proving a normal queued task remains cancellable without the Dharma-only fields.
4. Run `npx tsx --test src/routes/tasks.test.ts src/services/tasks/store.test.ts` and confirm the new assertions fail for the missing contract.

### Task 2: Implement validated, auditable cancellation

**Files:**
- Modify: `backend/src/services/tasks/types.ts`
- Modify: `backend/src/services/tasks/store.ts`
- Modify: `backend/src/routes/tasks.ts`

1. Add a typed cancellation audit payload with bounded, sanitized public fields.
2. Make `requestCancel` reject missing/non-active tasks before writing state, record the audit payload atomically with `cancel.requested`, and preserve existing internal callers.
3. Parse cancel JSON defensively in the route. For a running Dharma full render, require a task-bound confirmation, an actionable reason, and a declared actor; return 400 otherwise.
4. Run the focused tests and confirm green.

### Task 3: Lock and expose Dharma render telemetry

**Files:**
- Modify: `backend/src/services/tasks/handlers/dharma-episode.test.ts`
- Modify: `backend/src/services/tasks/handlers/dharma-episode.ts`
- Modify: `frontend/app/composables/taskState.test.ts`
- Modify: `frontend/app/composables/taskState.ts`

1. Add a failing pure-helper test for phase, elapsed time, FPS, and ETA derived from a running Dharma render task.
2. Add a failing handler-helper test that stage transitions use stable, user-facing progress messages.
3. Emit those stage messages during `runTimedStage`, without overwriting frame counters during the Remotion frame phase.
4. Implement the pure frontend telemetry helper and run the focused backend/frontend tests.

### Task 4: Render telemetry and deliberate cancellation in the task center

**Files:**
- Modify: `frontend/app/components/TaskCenter.vue`
- Modify: `frontend/app/components/GlobalTaskCenter.vue`
- Modify: `frontend/app/composables/useTasks.ts`
- Modify: `frontend/app/composables/useApi.ts`

1. Change the cancel event to carry a typed request rather than a raw task/object mismatch.
2. Add an in-context modal for a Dharma full render: reason plus a task-bound confirmation input; generic tasks remain one-click cancellable.
3. Render Dharma phase, elapsed time, FPS, and ETA beneath its progress bar.
4. Build the frontend to typecheck the Vue wiring.

### Task 5: Encode the operational rule and verify the whole slice

**Files:**
- Modify: `.codex/skills/remotion-dharma-factory/SKILL.md`
- Modify: `.codex/skills/remotion-dharma-factory/references/lessons-learned.md`

1. State that no agent may cancel a running full render based on prior output alone; it must inspect current input fingerprint/pilot state and submit an attributable reason through the route.
2. State the required live progress report fields and escalation threshold.
3. Run focused task/Dharma tests, `backend npm run typecheck`, `frontend npm run build`, and `check_dharma_sync.mjs 693`.
