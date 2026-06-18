# task-center-real-tasks - Correction Plan v2

## Oracle Verdict
NEEDS_FIX. The episode-grouping direction is correct, but the current UI still centers backend task rows instead of episode-level tasks, and 30 out-of-scope backend file changes violate the original "No backend changes" guardrail.

## What must change

### 1. Isolate out-of-scope backend changes
- The original plan forbade backend changes. The working tree currently has 30 modified backend files and 37 untracked backend files.
- Action: create a local backup branch, revert modified backend files, and move untracked backend files to `.omo/stash/backend-untracked-backup/` so the task-center PR remains frontend-only.
- Rationale: keeps backend work recoverable while restoring scope fidelity.

### 2. Episode-first UI
- `TaskCenter.vue` must default to showing **only episode-level cards**.
- Backend operations (AI 改写, 提取, image/video generation, TTS, compose, merge) move behind a collapsible "查看详情" affordance.
- Only failed or currently running child steps may be surfaced inline by default, so users see what needs attention without wading through a progress log.
- Remove raw debug metadata from the primary card surface:
  - `#{{ group.key }}`
  - `#{{ taskId(task) }}` in child titles
  - literal "任务详情" heading

### 3. Better progress semantics
- `deriveEpisodeTaskGroups()` keeps terminal/total counts, but `TaskCenter.vue` should present them as a simple progress bar and percentage.
- The progress text should read as episode completion, not a raw count of backend rows.

### 4. Type safety
- Introduce a `CreationTask` interface in `taskState.ts` instead of `any[]`.
- Type exported helpers (`taskValue`, `taskStatus`, `taskId`, etc.) with `CreationTask | unknown` narrowing where safe.
- Keep unavoidable `any` only at trust boundaries (e.g. payload access), not on exported public APIs.

### 5. Tests
- Update `taskState.test.ts` to use typed fixtures.
- Add a test that encodes the exact user complaint: `agent.run` "AI改写" and `agent.run` "提取" for the same episode produce exactly one episode group.
- Add a test that child tasks are collapsed by default in the UI component (if component-level testing is feasible; otherwise cover via unit assertions on `grouped.roots`).

### 6. Verification
- `cd frontend && npm run build` exits 0.
- `node --test --import tsx frontend/app/composables/taskState.test.ts` passes.
- Manual browser QA: confirm global FAB visible on home, settings, drama detail, and studio; confirm episode cards first, details collapsible; confirm cancel/retry on individual steps.

## Files to modify
- `frontend/app/composables/taskState.ts` — types, `deriveEpisodeTaskGroups`
- `frontend/app/components/TaskCenter.vue` — episode-first layout, collapsible details
- `frontend/app/composables/taskState.test.ts` — typed fixtures, complaint regression test

## Files to revert/stash
- All `backend/` modifications and untracked files.

## Files unchanged
- `frontend/app/components/GlobalTaskCenter.vue`
- `frontend/app/composables/useTasks.ts`
- `frontend/app/layouts/default.vue`
- `frontend/app/layouts/studio.vue`
- `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`

## Success criteria
- Task Center shows one card per episode by default.
- Child operations are visible only after expanding details.
- No raw IDs/keys are visible on the card surface.
- Frontend build and tests pass.
- `git diff --name-only | grep -E '^backend/'` is empty.
