# task-center-real-tasks - Work Plan

## TL;DR (For humans)

**What you'll get:** Task Center will show **one card per episode** instead of one card per backend task. All background work for an episode — AI 改写, 提取, 图片生成, 视频生成, 配音, 合成, 拼接 — will appear as progress steps inside that single episode card. Cancel/retry still works on individual steps.

**Why this approach:** You clarified that "一集就是一个任务". The current UI treats every backend task row as a top-level task, which makes the task center look like a progress-detail list instead of a task list. Grouping by episode in the frontend fixes this with zero backend changes.

**What it will NOT do:** It will not add backend parent tasks, will not change how tasks are created, will not add episode-level bulk cancel/retry, and will not touch the agent-specific workbench UI (`useAgent`).

**Effort:** Short
**Risk:** Low - frontend-only, additive logic, existing tests extended.
**Decisions I made for you:** (1) Group all backend tasks by `episode_id` into one user-facing card per episode. (2) Keep cancel/retry on individual backend tasks, not on the whole episode. (3) Preserve the existing `compose.episode` → `compose.storyboard` nested hierarchy inside the episode card.

Your next move: approve this plan, then run implementation with `$start-work` or equivalent.

---

> TL;DR (machine): Short effort, low risk, frontend-only episode-level grouping of backend tasks in TaskCenter.vue/taskState.ts.

## Scope
### Must have
- `deriveEpisodeTaskGroups()` in `frontend/app/composables/taskState.ts` that groups raw backend tasks by `episode_id` (fallback `drama_id` for tasks without episode).
- Episode group title: `第 {episodeId} 集制作` for episode-scoped tasks; `项目后台任务` for drama-only tasks; `后台任务` for global tasks.
- Episode group status derived from all children: `running` > `queued` > `failed` > `stale` > `canceled` > `succeeded`.
- Episode group progress: terminal children / total children.
- Inside each episode group, preserve existing `parent_task_id` hierarchy so `compose.episode` still nests its `compose.storyboard` children.
- `TaskCenter.vue` renders episode groups as primary cards and raw tasks as expandable children/progress.
- FAB counts and panel subtitle based on episode groups, not raw task rows.
- Unit tests in `frontend/app/composables/taskState.test.ts` covering episode grouping, status/progress, and parent/child preservation.
- Frontend `npm run build` passes.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No backend schema changes.
- No new task types or route changes.
- No changes to task creation, worker, store, registry, or handlers.
- No changes to `useAgent` composable.
- No episode-level bulk cancel/retry (cancel/retry still targets individual backend tasks).
- No removal of the existing `groupTasks()` function or its tests.
- No per-operation-category grouping (e.g. separate cards for "角色形象生成" vs "视频生成").

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + build verification.
- Evidence: `.omo/evidence/task-<N>-task-center-real-tasks.<ext>`

## Execution strategy
### Parallel execution waves

**Wave 1: Core grouping logic**
- 1: Add `deriveEpisodeTaskGroups()` types and function to `taskState.ts`.
- 2: Add unit tests for `deriveEpisodeTaskGroups()` in `taskState.test.ts`.

**Wave 2: UI rendering**
- 3: Update `TaskCenter.vue` to render episode groups and keep raw tasks as children/progress.
- 4: Update FAB/panel counts and subtitles to use episode groups.

**Wave 3: Verification**
- 5: Run frontend build and fix any errors.
- 6: Run frontend tests and fix any failures.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2, 3 | - |
| 2 | 1 | - | 3 |
| 3 | 1 | 4, 5 | 2 |
| 4 | 3 | 5 | - |
| 5 | 3, 4 | - | 6 |
| 6 | 1, 2, 4 | - | 5 |

## Todos
> Implementation + Test = ONE todo. Never separate.

- [x] 1. `frontend/app/composables/taskState.ts`: add episode-level task grouping logic
  What to do / Must NOT do: Add `EpisodeTaskGroup` type and `deriveEpisodeTaskGroups(tasks)` function. Group tasks by `episode_id` (fallback to `drama_id`, then `global`). Use existing `groupTasks()` inside each episode group to preserve parent/child hierarchy. Derive group status from all children (running > queued > failed > stale > canceled > succeeded). Derive progress as terminal/total. Must NOT mutate input. Must NOT remove or change `groupTasks()`.
  Parallelization: Wave 1 | Blocked by: - | Blocks: 2, 3
  References (executor has NO interview context - be exhaustive): `frontend/app/composables/taskState.ts:1-226` (existing types, `taskValue`, `taskStatus`, `taskScopeType`, `taskScopeId`, `taskParentId`, `groupTasks`), `backend/src/routes/compose.ts:109-121` (existing parent/child pattern).
  Acceptance criteria (agent-executable): New function exists and returns one group per distinct `episode_id`; a group containing 2 `agent.run` tasks + 1 `image.generate` task has status `running` and progress `0/3` while active.
  QA scenarios (name the exact tool + invocation): happy - `node --test --import tsx frontend/app/composables/taskState.test.ts` passes after 2; failure - function returns no groups for empty input; Evidence `.omo/evidence/task-1-task-center-real-tasks.txt`
  Commit: Y | feat(task-center): add episode-level task grouping logic

- [x] 2. `frontend/app/composables/taskState.test.ts`: cover episode-level grouping
  What to do / Must NOT do: Add tests for `deriveEpisodeTaskGroups()` covering: (a) tasks with same `episode_id` grouped into one card, (b) tasks with different `episode_id` grouped into separate cards, (c) `compose.episode` parent keeps its `compose.storyboard` children nested inside the episode group, (d) group status/progress derivation. Must NOT delete existing tests.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: -
  References: `frontend/app/composables/taskState.test.ts:1-104`, `frontend/app/composables/taskState.ts` (Todo 1 output).
  Acceptance criteria (agent-executable): `node --test --import tsx frontend/app/composables/taskState.test.ts` passes.
  QA scenarios: happy - all tests pass; failure - one test with a failed child asserts group status is failed; Evidence `.omo/evidence/task-2-task-center-real-tasks.txt`
  Commit: Y | test(task-center): add episode grouping tests

- [x] 3. `frontend/app/components/TaskCenter.vue`: render episode groups as primary cards
  What to do / Must NOT do: Import `deriveEpisodeTaskGroups`. Replace `statusGroups` computation to iterate over `episodeGroups` instead of raw roots. Keep the existing children section, but populate it from the episode group's raw tasks (respecting existing parent/child nesting). Keep existing emit signatures for cancel/retry so each child action still targets one backend task. Must NOT remove the children/progress UI. Must NOT change the drag/position behavior.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4, 5
  References: `frontend/app/components/TaskCenter.vue:53-104` (body rendering), `frontend/app/components/TaskCenter.vue:237-259` (computed props), `frontend/app/composables/taskState.ts` (Todo 1 output).
  Acceptance criteria (agent-executable): (a) Component template uses `episodeGroups` computed from `deriveEpisodeTaskGroups(props.tasks)` as its top-level iteration. (b) Given a props list of 3 tasks for episode 3 and 2 tasks for episode 5, the component renders exactly 2 episode cards.
  QA scenarios (name the exact tool + invocation): happy - `cd frontend && npm run build` passes; failure - build fails if `episodeGroups` is undefined; Evidence `.omo/evidence/task-3-task-center-real-tasks.txt`
  Commit: Y | feat(task-center): render episode groups in panel

- [x] 4. `frontend/app/components/TaskCenter.vue`: update counts and subtitles to episode groups
  What to do / Must NOT do: Update `activeCount`, `failedCount`, `visibleCount`, and `fabSubtitle` to derive from `episodeGroups` rather than raw `grouped.activeCount`/`failedCount` or `props.tasks.length`. Empty state copy may stay the same.
  Parallelization: Wave 2 | Blocked by: 3 | Blocks: 5
  References: `frontend/app/components/TaskCenter.vue:237-245`.
  Acceptance criteria (agent-executable): (a) `activeCount` equals the number of `episodeGroups` with status `running` or `queued`. (b) `failedCount` equals the number of `episodeGroups` with status `failed` or `stale`. (c) `visibleCount` equals `episodeGroups.length`. (d) A unit test asserts that 2 running `agent.run` tasks for the same episode produce exactly 1 active group.
  QA scenarios (name the exact tool + invocation): happy - `node --test --import tsx frontend/app/composables/taskState.test.ts` passes; failure - count assertions fail; Evidence `.omo/evidence/task-4-task-center-real-tasks.txt`
  Commit: Y | feat(task-center): episode-level counts in FAB and panel

- [x] 5. Frontend build verification
  What to do / Must NOT do: Run `cd frontend && npm run build`. Fix any TypeScript or build errors introduced by 1-4. Must NOT relax types with `as any`.
  Parallelization: Wave 3 | Blocked by: 3, 4 | Blocks: -
  References: `frontend/package.json` (build script), project AGENTS.md commands.
  Acceptance criteria (agent-executable): `cd frontend && npm run build` exits 0.
  QA scenarios: happy - build succeeds; failure - build fails with type error; Evidence `.omo/evidence/task-5-task-center-real-tasks.txt`
  Commit: Y | chore(task-center): fix build errors

- [x] 6. Frontend test verification
  What to do / Must NOT do: Run `node --test --import tsx frontend/app/composables/taskState.test.ts`. Fix any failures. Must NOT weaken assertions.
  Parallelization: Wave 3 | Blocked by: 1, 2, 4 | Blocks: -
  References: `frontend/app/composables/taskState.test.ts`, project AGENTS.md (Node native test runner).
  Acceptance criteria (agent-executable): All tests in `taskState.test.ts` pass.
  QA scenarios: happy - tests pass; failure - test fails with assertion message; Evidence `.omo/evidence/task-6-task-center-real-tasks.txt`
  Commit: Y | test(task-center): green test suite

## Global placement correction (added after user feedback)
> User: "任务中心只全局的，但是你现在却是只有进入某一集的制作面板，才可以访问。"
> The Task Center must be reachable from every page, not only the episode workbench. This correction keeps the episode-grouping UI but lifts it into the layouts via a new global wrapper.

### Must have (correction)
- `deriveEpisodeTaskGroups()` groups by a composite `drama_id:episode_id` key so cards are unique across dramas.
- Episode group title includes the drama ID when relevant: `项目 {dramaId} · 第 {episodeId} 集制作`.
- A new `GlobalTaskCenter.vue` wrapper uses `useTasks({ pollMs: 3000 })` (global fetch) and renders `<TaskCenter>` with all tasks.
- `GlobalTaskCenter` is mounted in both `layouts/default.vue` and `layouts/studio.vue`.
- The local `<TaskCenter>` block is removed from `pages/drama/[id]/episode/[episodeNumber].vue`; the page keeps its episode-scoped `useTasks` for other workbench logic.
- `useTasks.ts` allows a global fetch when neither `dramaId` nor `episodeId` is provided.
- Tests are updated for composite grouping keys.

### Additional todos
- [x] 7. `frontend/app/composables/taskState.ts`: use `drama_id:episode_id` composite key for global uniqueness
  What to do / Must NOT do: Update `deriveEpisodeTaskGroups()` so the group key is `drama_{dramaId}:episode_{episodeId}` when both present, `drama_{dramaId}` when only drama, `global` otherwise. Update titles to `项目 {dramaId} · 第 {episodeId} 集制作` / `项目 {dramaId} 后台任务` / `后台任务`. Must NOT change `groupTasks()`.
  Parallelization: Correction wave | Blocked by: - | Blocks: 8, 10
  References: `frontend/app/composables/taskState.ts:236-289` (current implementation).
  Acceptance criteria (agent-executable): `deriveEpisodeTaskGroups([{ drama_id: 1, episode_id: 3 }, { drama_id: 2, episode_id: 3 }])` returns two groups with distinct keys and titles containing different drama IDs.
  QA scenarios: happy - tests pass; failure - two different dramas with same episode_id collapse into one group; Evidence `.omo/evidence/task-7-task-center-real-tasks.txt`
  Commit: Y | feat(task-center): composite drama/episode grouping keys

- [x] 8. `frontend/app/composables/taskState.test.ts`: update tests for composite keys
  What to do / Must NOT do: Update existing `deriveEpisodeTaskGroups` tests and add a new test that tasks with same `episode_id` but different `drama_id` form separate groups.
  Parallelization: Correction wave | Blocked by: 7 | Blocks: -
  References: `frontend/app/composables/taskState.test.ts:107-216`.
  Acceptance criteria (agent-executable): `node --test --import tsx frontend/app/composables/taskState.test.ts` passes.
  QA scenarios: happy - all tests pass; failure - composite-key test fails; Evidence `.omo/evidence/task-8-task-center-real-tasks.txt`
  Commit: Y | test(task-center): composite key coverage

- [x] 9. Create `frontend/app/components/GlobalTaskCenter.vue` and mount it in layouts
  What to do / Must NOT do: Create `GlobalTaskCenter.vue` that calls `useTasks({ pollMs: 3000 })`, loads tasks on mount, starts polling, and renders `<TaskCenter v-model:open ... :tasks ... @cancel @retry />`. Mount it in `layouts/default.vue` and `layouts/studio.vue`. Do NOT mount `<TaskCenter>` directly in layouts. Must NOT change `TaskCenter.vue` props/events.
  Parallelization: Correction wave | Blocked by: - | Blocks: 10
  References: `frontend/app/composables/useTasks.ts:29-68` (fetch logic), `frontend/app/layouts/default.vue:1-48`, `frontend/app/layouts/studio.vue:1-9`, `frontend/app/components/TaskCenter.vue:210-230` (props/emits).
  Acceptance criteria (agent-executable): `cd frontend && npm run build` passes; a grep for `GlobalTaskCenter` is present in both layout files.
  QA scenarios: happy - build passes; failure - missing import or wrong prop type; Evidence `.omo/evidence/task-9-task-center-real-tasks.txt`
  Commit: Y | feat(task-center): global task center wrapper and layout mounts

- [x] 10. `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`: remove local TaskCenter
  What to do / Must NOT do: Remove the `<TaskCenter>` template block (lines ~1491-1500), the `TaskCenter` import, and the `taskCenterOpen` ref. Remove `handleCancelTask` and `handleRetryTask` handlers and the `cancelTaskWithToast` / `retryTaskWithToast` destructuring from `useTasks` if no longer used elsewhere. Keep the `useTasks({ dramaId, episodeId: epId, pollMs: 3000 })` call and its `mediaTasks`, `loadCreationTasks`, `startTaskPolling` usage for other workbench logic. Must NOT remove other workbench functionality.
  Parallelization: Correction wave | Blocked by: 9 | Blocks: 11
  References: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue:1491-1500`, `:1529-1538`, `:3283-3295`.
  Acceptance criteria (agent-executable): `cd frontend && npm run build` passes; the file no longer contains `<TaskCenter` or `taskCenterOpen`.
  QA scenarios: happy - build passes; failure - removed too much and workbench breaks; Evidence `.omo/evidence/task-10-task-center-real-tasks.txt`
  Commit: Y | refactor(task-center): remove per-episode task center from workbench

- [x] 11. Frontend build and test verification (correction)
  What to do / Must NOT do: Run `cd frontend && npm run build` and `node --test --import tsx frontend/app/composables/taskState.test.ts`. Fix any failures.
  Parallelization: Correction wave | Blocked by: 7, 9, 10 | Blocks: -
  References: project AGENTS.md commands.
  Acceptance criteria (agent-executable): Build exits 0 and all tests pass.
  QA scenarios: happy - both pass; failure - type or test error; Evidence `.omo/evidence/task-11-task-center-real-tasks.txt`
  Commit: Y | chore(task-center): correction verification

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Verify: every todo implemented as specified; no backend files changed; `groupTasks()` preserved; `useAgent` untouched.
  Tool: `git diff --name-only` and `git diff frontend/app/composables/taskState.ts frontend/app/components/TaskCenter.vue frontend/app/composables/taskState.test.ts frontend/app/components/GlobalTaskCenter.vue frontend/app/layouts/default.vue frontend/app/layouts/studio.vue frontend/app/pages/drama/[id]/episode/[episodeNumber].vue frontend/app/composables/useTasks.ts`
  Evidence: `.omo/evidence/f1-task-center-real-tasks.txt`
- [x] F2. Code quality review
  Verify: no new `as any`, no unused imports, component props/types consistent, function names match plan.
  Tool: `cd frontend && npm run typecheck` (if exists) or `npm run build`; manual diff review.
  Evidence: `.omo/evidence/f2-task-center-real-tasks.txt`
- [ ] F3. Real manual QA
  Verify: open any page, open Task Center, confirm one episode card per episode; expand an episode card and confirm all its backend tasks appear as steps; confirm cancel/retry buttons work on individual steps.
  Tool: browser automation via `/browse` skill or Playwright.
  Status: Attempted; environment could not keep dev servers alive across tool calls for a full end-to-end walkthrough. Build and unit tests pass. Recommending the user run this scenario in the real browser.
  Steps:
    1. `cd backend && npm start` (port 5679).
    2. `cd frontend && npm run dev` (port 3013).
    3. Open `http://localhost:3013/` (project list) — Task Center FAB should already be visible.
    4. Open Task Center; confirm cards like `项目 1 · 第 2 集制作`, `项目 1 · 第 3 集制作`.
    5. Expand one card; confirm the agent/image/video/etc. tasks are listed as steps.
    6. Click 取消 / 重试 on a step and confirm the backend task is canceled/retried.
  Evidence: `.omo/evidence/f3-task-center-real-tasks.png` or `.txt`
- [x] F4. Scope fidelity
  Verify: no changes to `backend/src/services/tasks/*`, `backend/src/routes/*`, no DB migrations, no new task types.
  Tool: `git diff --name-only | grep -E '^backend/'` should be empty.
  Evidence: `.omo/evidence/f4-task-center-real-tasks.txt`

## Commit strategy
- One commit per todo (atomic).
- Commit messages in Chinese or English matching repo style; use `feat(task-center):`, `test(task-center):`, `chore(task-center):` prefixes.
- Do not push until final verification wave passes.

## Success criteria
- Task Center shows one card per episode instead of one card per backend task.
- All backend tasks for the same episode appear as steps/children inside that episode card.
- The existing `compose.episode` → `compose.storyboard` nested hierarchy is preserved inside the episode card.
- Cancel/retry still targets individual backend tasks.
- Frontend build passes and tests pass.
- No backend changes.
