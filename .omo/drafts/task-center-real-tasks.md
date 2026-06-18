---
slug: task-center-real-tasks
status: active
intent: unclear
pending-action: execute global placement correction via subagents
approach: frontend-only semantic grouping of backend creation_tasks into episode-level task cards, surfaced globally via a layout-mounted GlobalTaskCenter wrapper; one episode = one task
---

# Draft: task-center-real-tasks

## Correction (user feedback)
> 任务中心只全局的，但是你现在却是只有进入某一集的制作面板，才可以访问。

The Task Center must be **global-level**: accessible from every page, not only inside the episode workbench. The current implementation mounts `<TaskCenter>` inside `pages/drama/[id]/episode/[episodeNumber].vue` and passes episode-scoped tasks. We need to lift it into the layouts (`default.vue` and `studio.vue`) and fetch all tasks globally.

## Components (topology ledger)
| id | outcome | status |
|---|---|---|
| taskState.ts | infer episode-level task groups from raw backend tasks, keyed by `drama_id:episode_id` for global uniqueness | active |
| TaskCenter.vue | render one card per episode, show raw tasks as expandable children/progress | active |
| taskState.test.ts | cover episode grouping, status/progress, parent/child preservation, and drama/episode composite keys | active |
| GlobalTaskCenter.vue | new wrapper: fetches all tasks via `useTasks()`, mounts `<TaskCenter>`, handles cancel/retry | pending |
| layouts/default.vue | mount `<GlobalTaskCenter>` so it appears on project/settings pages | pending |
| layouts/studio.vue | mount `<GlobalTaskCenter>` so it appears inside the episode workbench | pending |
| pages/drama/[id]/episode/[episodeNumber].vue | remove the local `<TaskCenter>` and its local open-state; keep episode-scoped `useTasks` for other workbench logic | pending |
| useTasks.ts | allow global fetch when neither `dramaId` nor `episodeId` is provided | pending |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| What is a "real task"? | One task card per episode; all backend tasks belonging to that episode are its progress steps | Matches user's clarification "一集就是一个任务"; simplest mental model | Yes, can later split into per-operation groups |
| Grouping layer | Frontend inference from task `episode_id` + `drama_id` composite key | Avoids backend migrations and route changes; prevents collisions across dramas | Yes, can later add backend `episode_task_id` |
| Global access | Floating FAB in both layouts (`default` and `studio`) | Task Center should be reachable from any page | Yes, can later add a header nav entry |
| Cancel/retry semantics | Actions still apply to individual backend tasks (children), not the whole episode | Safest default; avoids unintended bulk cancel | Yes, can add episode-level bulk actions later |
| Existing parent/child tasks | `compose.episode` → `compose.storyboard` hierarchy is preserved inside the episode group | Respects existing data model | No |

## Findings (cited - path:lines)
- `frontend/app/components/TaskCenter.vue:54-259` groups by status and renders `grouped.roots` as cards, with a children section for `childrenByParent`.
- `frontend/app/composables/taskState.ts:173-212` defines `groupTasks()` which separates roots and children by `parent_task_id` only.
- `frontend/app/composables/taskState.ts:155-171` maps `agent.run` titles to `AI ${agent_type}`, making each agent invocation a separate card title.
- `backend/src/routes/agent.ts:44-58` creates one `agent.run` task per `/agent/:type/chat` call with `scopeType: 'episode'`; no parent grouping.
- `backend/src/routes/compose.ts:109-121` is the only place using `parentTaskId` + `addTaskDependency`.
- `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue:1491-1500` mounts the only current `<TaskCenter>` inside the workbench.
- `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue:1539` scopes Task Center to one episode via `useTasks({ dramaId, episodeId: epId })`.
- `frontend/app/layouts/default.vue:1-48` is the standard layout used by project/settings pages.
- `frontend/app/layouts/studio.vue:1-9` is the fullscreen workbench layout.
- `frontend/app/composables/useTasks.ts:43-49` currently returns an empty task list when neither `dramaId` nor `episodeId` is set.

## Decisions (with rationale)
1. **Frontend grouping only.** The bug is a presentation problem: every backend task row is shown as a top-level task card. We will not change task creation or add backend parent tasks.
2. **One episode = one task card.** All backend tasks sharing the same `drama_id:episode_id` belong to a single user-facing task. Tasks without `episode_id` are grouped by `drama_id` or shown individually.
3. **Task Center is global.** It is mounted in both layouts and fetches all tasks, not scoped to the current episode.
4. **Preserve individual cancel/retry.** Episode-level bulk actions are OUT OF SCOPE.
5. **Preserve existing `parent_task_id` hierarchy inside the episode group.** `compose.episode` and its children stay nested.

## Scope IN
- Add a `deriveEpisodeTaskGroups()` function in `taskState.ts` keyed by `drama_id:episode_id`.
- Group raw backend tasks by composite `drama_id:episode_id` (fallback `drama_id`, then `global`).
- Derive episode group status and progress from all children.
- Update `TaskCenter.vue` to render episode groups as primary cards.
- Create `GlobalTaskCenter.vue` wrapper that fetches all tasks and renders `<TaskCenter>`.
- Mount `GlobalTaskCenter` in `layouts/default.vue` and `layouts/studio.vue`.
- Remove local `<TaskCenter>` from `pages/drama/[id]/episode/[episodeNumber].vue` while keeping episode-scoped `useTasks` for workbench logic.
- Update `useTasks.ts` to allow global fetch when no filter is provided.
- Add/extend unit tests in `taskState.test.ts`.
- Run frontend build verification.

## Scope OUT (Must NOT have)
- No backend schema changes.
- No new task types or parent/child relationships in routes.
- No changes to `useAgent` composable.
- No episode-level bulk cancel/retry in this iteration.
- No changes to worker, store, registry, or handlers.

## Open questions
(none - correction adopted)

## Approval gate
status: awaiting-approval
