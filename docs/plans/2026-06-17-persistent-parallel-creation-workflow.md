# Persistent Parallel Creation Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让创作流程的任务状态可持久、可恢复、可并行运行，页面刷新和后端重启都不会丢失任务进度。

**Architecture:** 在现有 SQLite/WAL 单机架构上增加统一的持久任务系统。所有长耗时创作动作先落入 `creation_tasks`，再由后端 worker 通过 lease 执行，执行进度写入 `task_events`，业务结果继续写回现有 `episodes`、`characters`、`scenes`、`storyboards`、`image_generations`、`video_generations`、`video_merges` 等表。前端不再依赖组件内存数组判断任务中状态，而是从任务 API 派生 UI 状态。

**Tech Stack:** TypeScript, Hono, better-sqlite3, Drizzle schema, SQLite WAL, Nuxt 3/Vue 3, existing AI adapters, FFmpeg services.

---

## Autoplan Status

本计划按 `$autoplan` 的 CEO、Design、Engineering、DX 四个视角产出，但当前 Codex 环境没有 Claude subagent/AskUserQuestion 原生链路。本轮不伪造双模型结论，采用代码审计 + 本地计划评审的降级模式。

Premise gate: 推荐做完整的统一持久任务系统，而不是只补 `localStorage` 或只给每张业务表加更多状态字段。这个选择会增加一次架构改造成本，但它是唯一同时覆盖页面刷新、后端重启、并行任务、重试、取消、失败可见性的方案。

## Current Workflow Persistence Audit

结论：当前业务产物大多会落库，但执行状态分散且多数不持久。刷新页面主要丢前端 pending/failed 状态；后端重启会让内存中的 poller、async IIFE、FFmpeg merge 失效，留下 `processing` 或 `compose_processing` 行。

| 创作步骤 | 主要入口 | 当前业务结果是否持久 | 当前执行状态是否持久 | 刷新页面风险 | 后端重启风险 | 目标状态 |
|---|---|---:|---:|---|---|---|
| 原始内容保存 | `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`, `backend/src/routes/episodes.ts` | 是，`episodes.content` | 不需要 | 低 | 低 | 保持现状 |
| 剧本改写 Agent | `useAgent.ts`, `routes/agent.ts` | 是，写入 `episodes.script_content` | 否，同步 HTTP 请求 | 刷新会丢运行态 | 请求中断或进程重启后不可恢复 | 转为 `agent.run` task |
| 角色/场景提取 Agent | `routes/agent.ts`, agent tools | 是，写入 `characters`、`scenes`、关联表 | 否 | 刷新丢运行态 | Agent 中断后无任务记录 | 转为 `agent.run` task，并记录 tool events |
| 音色分配 | `routes/characters.ts`, `voice-auto-assign.ts`, Agent voice tools | 是，写入角色 voice 字段 | 否 | 刷新丢运行态 | 批处理不可恢复 | 转为 task 或 agent task 子类型 |
| 试听音频生成 | `generateVoiceSample`, `tts-generation.ts` | 是，写入 `characters.voice_sample_url` | 否，同步批量由前端 `Promise.allSettled` 驱动 | 刷新丢批量进度 | 请求中断不可恢复 | 转为 `tts.character_sample` task |
| 分镜拆解 Agent | `storyboard_breaker`, `routes/agent.ts` | 是，写入 `storyboards`、关联表 | 否 | 刷新丢运行态 | Agent 中断无恢复 | 转为 `agent.run` task |
| 旁白生成 Agent | `narrator`, `routes/agent.ts` | 是，写入 `storyboards.narration` | 否 | 刷新丢运行态 | Agent 中断无恢复 | 转为 `agent.run` task |
| 镜头拆分 Agent | `storyboard_splitter`, `routes/agent.ts` | 是，增改 `storyboards` | 否 | 刷新丢运行态 | Agent 中断无恢复 | 转为 `agent.run` task |
| 角色图片/场景图片/镜头首尾帧 | `routes/images.ts`, `image-generation.ts` | 部分是，`image_generations` 与业务表字段 | 部分是，provider task id 落库，但 poller 在内存 | 前端 pending 数组丢失，可通过结果部分恢复 | `processing` 行会卡住 | 由 worker 接管 image task 和 poll/resume |
| Grid prompt | `routes/grid.ts` | 否，prompt 只返回前端 | 否 | 刷新丢 prompt 和编辑状态 | 请求中断无记录 | 新增 server-side grid draft/task payload |
| Grid image generate | `routes/grid.ts`, `image-generation.ts` | 部分是，走 `image_generations` | 部分是，poller 内存 | localStorage 只能恢复部分图片/assignment | `processing` 行会卡住 | 使用 image task + grid draft |
| Grid split assignment | `routes/grid.ts`, 前端 `localStorage` | 结果是，写入 `storyboards` 图片字段 | assignment 草稿只在 localStorage | 多设备/刷新边界不可靠 | 无后台任务记录 | `grid.split` task + server-side draft |
| 镜头 TTS | `routes/storyboards.ts`, `ffmpeg-compose.ts`, `tts-generation.ts` | 是，写入 `tts_audio_url`、`narration_audio_url` | 否，同步请求 | 批量进度丢 | 请求中断不可恢复 | `tts.storyboard` task |
| 视频生成 | `routes/videos.ts`, `video-generation.ts` | 部分是，`video_generations` 与 `storyboards.video_url` | 部分是，provider task id 落库，但 poller 在内存；Vidu webhook 等待无统一 task | 前端 pending 数组丢失 | 非 webhook provider 的 `processing` 行卡住 | 由 worker 接管 video task 和 poll/webhook reconciliation |
| 单镜头合成 | `routes/compose.ts`, `ffmpeg-compose.ts` | 是，`storyboards.composed_video_url/status` | 部分是，状态在 storyboard | 刷新后可通过 status 部分恢复 | FFmpeg 进程中断后 `compose_processing` 卡住 | `compose.storyboard` task |
| 批量合成 | `routes/compose.ts` async IIFE | 子结果部分持久 | 无父批任务，执行循环在内存 | 可通过 `compose_processing` 部分恢复 | 后端重启后批处理停止 | parent `compose.episode` + child tasks |
| 拼接全集 | `routes/merge.ts`, `ffmpeg-merge.ts` | 是，`video_merges` 与 `episodes.video_url` | 部分是，`video_merges.status`，执行在内存 | 前端可恢复轮询 | 后端重启后 `processing` merge 卡住 | `merge.episode` task |
| Pipeline status | `routes/episodes.ts` | 是，聚合业务结果 | 否，不是任务系统 | 只能看结果，不知道运行者 | 无恢复能力 | 保留为业务进度视图，任务 API 负责执行状态 |

## Recommended Architecture

不要引入 Redis/BullMQ。当前项目是本地 SQLite/WAL 单节点应用，业务数据和文件都在本机；增加外部队列会扩大部署和调试成本。SQLite 任务表 + lease 已足够支撑当前并行创作。

```
Frontend Workbench
  |
  | POST existing APIs or POST /tasks
  v
Task API -------------- GET /tasks?episode_id=...
  |
  v
SQLite
  |-- creation_tasks
  |-- creation_task_events
  |-- creation_task_dependencies
  |-- grid_drafts
  |-- existing business tables
  |
  v
Worker loop with leases
  |
  |-- agent.run -> existing agents/tools
  |-- image.generate -> existing image adapters/pollers
  |-- video.generate -> existing video adapters/pollers/webhooks
  |-- tts.* -> existing TTS service
  |-- compose.* -> existing FFmpeg compose
  |-- merge.episode -> existing FFmpeg merge
```

Task state machine:

```
queued
  |
  v
running --heartbeat/lease expires--> queued or stale
  | \
  |  \--cancel requested--> canceled
  |
  |--success--> succeeded
  |
  '--error retryable--> queued
  |
  '--error terminal--> failed
```

Core tables:

| Table | Purpose |
|---|---|
| `creation_tasks` | 持久任务主表，包含 type、scope、status、payload、result、error、lease、attempt、progress、parent/child |
| `creation_task_events` | append-only 事件流，记录进度、provider task id、tool call、错误、恢复动作 |
| `creation_task_dependencies` | 任务依赖关系，例如 merge 等待 compose children |
| `grid_drafts` | 保存 grid prompt、cell prompts、active image、assignments，替代纯 localStorage |

`creation_tasks` 关键字段：

```
id, type, status, drama_id, episode_id, scope_type, scope_id,
idempotency_key, parent_task_id, payload_json, result_json,
progress_current, progress_total, progress_message,
lease_owner, lease_expires_at, attempts, max_attempts,
error_code, error_message, cancel_requested,
created_at, updated_at, started_at, completed_at
```

Concurrency defaults:

| Type | Limit | Reason |
|---|---:|---|
| `agent.run` | 1 per episode, 2 global | 避免多个 Agent 同时改同一集数据 |
| `image.generate` | 4 global | 图片任务可并行，但 provider/API 有限流风险 |
| `video.generate` | 2 global | 视频耗时长且成本高 |
| `tts.*` | 4 global | 请求短，可适度并行 |
| `compose.storyboard` | 2 global | FFmpeg CPU/IO 负载 |
| `compose.episode` | 1 per episode | 父任务调度 children，不直接重活 |
| `merge.episode` | 1 global | 防止 FFmpeg 大 IO 并发拖垮本机 |
| `grid.*` | 2 global | 主要依赖 image/split 文件 IO |

## Scope Choices

| Option | Completeness | Decision |
|---|---:|---|
| 只用 `localStorage` 保存前端 pending 状态 | 3/10 | Reject。刷新同浏览器可改善，但后端重启、并行 worker、重试、取消都解决不了 |
| 继续扩展每张业务表的 `status` 字段 | 6/10 | Reject as primary。能补局部问题，但会让 Agent、image、video、compose、merge 继续碎片化 |
| 统一 SQLite 持久任务系统 | 9/10 | Recommend。贴合现有架构，覆盖刷新、重启、并行、恢复和失败可见性 |
| Redis/BullMQ/外部队列 | 8/10 | Reject for now。能力够，但对当前本地 SQLite app 是不必要基础设施 |

## Execution Rule

每个阶段都必须按这个节奏执行：

1. 只实现本阶段文件和测试。
2. 跑本阶段验收命令。
3. 把结果发给用户确认。
4. 用户确认通过后，才进入下一阶段。

如果某阶段发现当前计划错误，先更新本计划，再继续。不要把后续阶段的实现提前混进当前阶段。

## Phase 0: Baseline Audit And Stuck-State Repair Plan

**Plan**

确认现有脏数据、卡住状态和当前 schema 差异。先做只读审计与可回滚的修复工具设计，不改业务执行路径。

**Execute**

Files:

- Create: `backend/src/services/tasks/audit.ts`
- Create: `backend/src/routes/taskAudit.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/tasks/audit.test.ts`

Steps:

1. Add read-only scanner for stuck rows:
   - `image_generations.status in ('pending','processing')`
   - `video_generations.status in ('pending','processing')`
   - `storyboards.status = 'compose_processing'`
   - `video_merges.status in ('pending','processing')`
2. Add `GET /api/v1/task-audit/stuck` returning counts and rows.
3. Add a dry-run repair function that classifies rows as `recoverable`, `terminal_unknown`, or `needs_manual_review`.
4. Do not mutate rows in Phase 0 unless explicitly confirmed later.

Acceptance:

- `cd backend && npm run typecheck` passes.
- `GET /api/v1/task-audit/stuck` works against the current DB.
- Output names each stuck row with table, id, age, status, and recovery recommendation.
- No existing business table data is modified.

## Phase 1: Durable Task Schema And API

**Plan**

Add the durable substrate without migrating business flows yet. This phase makes task creation/listing/status/cancel/recover API real, but no image/video/agent route should depend on it yet.

**Execute**

Files:

- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/db/index.ts`
- Create: `backend/src/services/tasks/types.ts`
- Create: `backend/src/services/tasks/store.ts`
- Create: `backend/src/routes/tasks.ts`
- Modify: `backend/src/index.ts`
- Modify: `frontend/app/composables/useApi.ts`
- Test: `backend/src/services/tasks/store.test.ts`

Steps:

1. Add `creation_tasks`, `creation_task_events`, `creation_task_dependencies`, and `grid_drafts` schema definitions.
2. Add matching `CREATE TABLE IF NOT EXISTS` SQL and indexes:
   - `idx_creation_tasks_status_lease`
   - `idx_creation_tasks_episode_status`
   - `idx_creation_tasks_idempotency`
   - `idx_task_events_task_id_created`
3. Implement `createTask`, `getTask`, `listTasks`, `transitionTask`, `appendTaskEvent`, `requestCancel`.
4. Enforce idempotency by `(type, idempotency_key)` returning the existing active task.
5. Add API:
   - `POST /api/v1/tasks`
   - `GET /api/v1/tasks?drama_id=&episode_id=&status=`
   - `GET /api/v1/tasks/:id`
   - `GET /api/v1/tasks/:id/events`
   - `POST /api/v1/tasks/:id/cancel`
6. Add frontend API wrappers under `taskAPI`.

Acceptance:

- Creating the same task twice with the same idempotency key returns one task.
- Task state and events remain after backend process restart.
- `cancel_requested` can be set but no worker behavior is required yet.
- `cd backend && npm run typecheck` passes.
- `cd frontend && npm run build` passes after API wrapper changes.

## Phase 2: Worker, Lease, Retry, And Recovery Engine

**Plan**

Add a generic worker loop that can run registered task handlers. Use SQLite leases so a restarted backend can reclaim stale tasks.

**Execute**

Files:

- Create: `backend/src/services/tasks/registry.ts`
- Create: `backend/src/services/tasks/worker.ts`
- Create: `backend/src/services/tasks/recovery.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/tasks/worker.test.ts`
- Test: `backend/src/services/tasks/recovery.test.ts`

Steps:

1. Implement task handler registry: `registerTaskHandler(type, handler, options)`.
2. Implement lease acquisition with `lease_owner` and `lease_expires_at`.
3. Implement heartbeat that extends lease while a task runs.
4. Implement retry/backoff on retryable errors.
5. Implement startup recovery:
   - expired `running` tasks become `queued` if resumable
   - non-resumable expired tasks become `stale`
   - `stale` tasks show repair action in audit endpoint
6. Implement task event logging for `queued`, `started`, `heartbeat`, `progress`, `retry`, `failed`, `succeeded`, `canceled`, `recovered`.
7. Add a test-only handler in tests to prove lifecycle behavior without touching business flows.

Acceptance:

- A queued test task is picked up and moved to `succeeded`.
- A worker crash simulation leaves a stale lease, and recovery requeues or marks stale according to handler metadata.
- Retry count increments and stops at `max_attempts`.
- Cancel before start prevents handler execution.
- `cd backend && npm run typecheck` passes.

## Phase 3: Durable Agent Workflows

**Plan**

Move long-running Agent workflows from synchronous request lifecycle into `agent.run` tasks. This covers script rewrite, extraction, voice assignment, storyboard breaking, narration, and split shots.

**Execute**

Files:

- Modify: `backend/src/routes/agent.ts`
- Create: `backend/src/services/tasks/handlers/agent-run.ts`
- Modify: `backend/src/agents/index.ts`
- Modify: `frontend/app/composables/useAgent.ts`
- Modify: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`
- Test: `backend/src/services/tasks/handlers/agent-run.test.ts`

Steps:

1. Add `agent.run` handler payload:
   - `agent_type`
   - `message`
   - `drama_id`
   - `episode_id`
2. Move `createAgent(...).generate(...)` execution into handler.
3. Persist normalized tool calls and tool results into task events.
4. Keep `POST /agent/:type/chat` as compatibility wrapper:
   - default returns `{ task_id, status: 'queued' }`
   - optional debug query can block until done only for local troubleshooting
5. Update `useAgent` to derive running state from `taskAPI.list`, not component-only `running`.
6. Update action buttons in the episode page to show task status after refresh.

Acceptance:

- Starting a storyboard breaker task returns immediately with a task id.
- Refreshing the page still shows the Agent task running.
- Agent tool calls appear in task events.
- If backend restarts while Agent is running, the task is marked stale or retried based on handler policy; it is never invisible.
- Existing business outputs still land in existing tables.

## Phase 4: Durable Media Generation Tasks

**Plan**

Move image, video, TTS, and grid generation execution into task handlers. Existing generation tables remain the business/provider records; task rows become the durable execution controller.

**Execute**

Files:

- Modify: `backend/src/services/image-generation.ts`
- Modify: `backend/src/services/video-generation.ts`
- Modify: `backend/src/services/tts-generation.ts`
- Modify: `backend/src/routes/images.ts`
- Modify: `backend/src/routes/videos.ts`
- Modify: `backend/src/routes/storyboards.ts`
- Modify: `backend/src/routes/grid.ts`
- Create: `backend/src/services/tasks/handlers/image-generate.ts`
- Create: `backend/src/services/tasks/handlers/video-generate.ts`
- Create: `backend/src/services/tasks/handlers/tts-generate.ts`
- Create: `backend/src/services/tasks/handlers/grid-generate.ts`
- Create: `backend/src/services/tasks/handlers/grid-split.ts`
- Test: `backend/src/services/tasks/handlers/image-generate.test.ts`
- Test: `backend/src/services/tasks/handlers/video-generate.test.ts`
- Test: `backend/src/services/tasks/handlers/tts-generate.test.ts`
- Test: `backend/src/services/tasks/handlers/grid.test.ts`

Steps:

1. Split `generateImage` into enqueue-record and execute-record functions.
2. Remove fire-and-forget `processImageGeneration(...).catch(...)`; worker owns it.
3. Persist provider `task_id` to both `image_generations.task_id` and task events.
4. On worker recovery, resume polling existing `image_generations` rows with provider task id.
5. Repeat the same split for `generateVideo`.
6. Reconcile webhook providers by matching webhook updates to `video_generations.task_id` and the owning creation task.
7. Wrap storyboard TTS and character sample generation as tasks.
8. Persist grid prompt/cell prompts/assignments in `grid_drafts`.
9. Make grid generate create an `image.generate` child task or a `grid.generate` task that delegates to image handler.
10. Make grid split a task so large image splitting survives page refresh.

Acceptance:

- Image/video/TTS/grid tasks all appear in `/tasks`.
- Refreshing page does not lose pending/failed media state.
- Restarting backend during image/video polling resumes or marks stale with visible error.
- Vidu/webhook video completion updates both `video_generations` and the owning task.
- Existing `GET /images/:id`, `GET /videos/:id`, and `GET /grid/status/:id` remain compatible.

## Phase 5: Durable Compose, Merge, And Dependency Graph

**Plan**

Convert FFmpeg work into tasks and model batch work as parent/child tasks. Merge must depend on completed compose tasks, not only trust current UI state.

**Execute**

Files:

- Modify: `backend/src/routes/compose.ts`
- Modify: `backend/src/services/ffmpeg-compose.ts`
- Modify: `backend/src/routes/merge.ts`
- Modify: `backend/src/services/ffmpeg-merge.ts`
- Create: `backend/src/services/tasks/handlers/compose-storyboard.ts`
- Create: `backend/src/services/tasks/handlers/compose-episode.ts`
- Create: `backend/src/services/tasks/handlers/merge-episode.ts`
- Test: `backend/src/services/tasks/handlers/compose.test.ts`
- Test: `backend/src/services/tasks/handlers/merge.test.ts`

Steps:

1. Make single compose create `compose.storyboard` task.
2. Make batch compose create `compose.episode` parent task plus one child per eligible storyboard.
3. Store child ids in `creation_task_dependencies` or parent task result.
4. Preserve existing storyboard status values for UI compatibility, but derive canonical execution state from tasks.
5. Make merge create `merge.episode` task.
6. Before merge execution, validate every storyboard has `composed_video_url`; if not, fail with actionable error listing missing storyboard ids.
7. On FFmpeg failure, clean temp files and record task event with file paths and command stage.
8. On backend startup, classify `compose_processing` and `video_merges.processing` rows from the old system as recoverable/stale.

Acceptance:

- Batch compose has visible parent progress: completed children / total children.
- Refresh page during compose/merge keeps progress visible.
- Backend restart during compose/merge does not leave invisible work; task becomes retryable/stale/failed with reason.
- Merge cannot start while dependent compose tasks are incomplete.
- Old `compose-status` and `merge` status endpoints continue to return useful data.

## Phase 6: Frontend Task Center And Recoverable UX

**Plan**

Replace local pending arrays with task-derived state. Add a task center that makes parallel work visible and recoverable after refresh.

**Execute**

Files:

- Create: `frontend/app/composables/useTasks.ts`
- Create: `frontend/app/components/TaskCenter.vue`
- Modify: `frontend/app/composables/useApi.ts`
- Modify: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`
- Modify: `frontend/app/layouts/default.vue` if a global drawer mount is needed

Steps:

1. Add `useTasks({ dramaId, episodeId })` with polling and task grouping.
2. Add derived helpers:
   - `isTaskRunning(type, scope)`
   - `taskError(type, scope)`
   - `taskProgress(type, scope)`
   - `retryTask(id)`
   - `cancelTask(id)`
3. Replace `pendingCharImageIds`, `pendingSceneImageIds`, `pendingShotFrameKeys`, `pendingVideoIds`, `pendingComposeIds` with computed state from tasks.
4. Keep local UI state only for purely visual dialog state, not task truth.
5. Add `TaskCenter.vue` as a right drawer or bottom sheet:
   - queued/running/succeeded/failed/canceled/stale groups
   - per-task progress text
   - retry/cancel buttons
   - parent/child grouping for batch tasks
6. Update grid dialog to load/save `grid_drafts` from backend; keep localStorage only as emergency fallback.
7. On page mount, load tasks before deciding button states.

Acceptance:

- Start multiple image/video/compose tasks, refresh page, and the same tasks remain visible.
- Failed tasks show actionable message and retry button.
- Canceling queued task prevents execution.
- Parallel tasks are grouped by episode and task type.
- Mobile layout still exposes task center without covering critical controls.
- `cd frontend && npm run build` passes.

## Phase 7: Hardening, Documentation, And Final Unified Acceptance

**Plan**

Close gaps across restart recovery, idempotency, cancellation, stuck-state repair, docs, and manual QA.

**Execute**

Files:

- Create: `backend/src/services/tasks/README.md`
- Create: `docs/task-system-runbook.md`
- Modify: `README.md`
- Modify: `backend/package.json` if adding a test script is needed
- Modify: `frontend/package.json` only if adding explicit typecheck/test commands is needed

Steps:

1. Add backend test script if absent:
   - preferred: `node --test --import tsx "src/**/*.test.ts"`
2. Add restart simulation tests for:
   - stale lease recovery
   - idempotent duplicate click
   - retry exhaustion
   - cancel queued
   - cancel running cooperative handler
   - old stuck row classification
3. Add frontend manual QA checklist.
4. Document task status meanings and recovery rules.
5. Document operational repair commands and safe usage.
6. Run full verification commands.

Acceptance:

- `cd backend && npm run typecheck` passes.
- `cd backend && npm test` passes if test script is added.
- `cd frontend && npm run build` passes.
- Manual QA passes:
  1. Start Agent, image, video, TTS, compose, and merge tasks in parallel.
  2. Refresh browser while tasks run.
  3. Confirm task center still shows active tasks.
  4. Restart backend while image/video/compose tasks run.
  5. Confirm tasks resume or become visible stale/failed states.
  6. Retry a failed task and verify it completes.
  7. Confirm final episode video URL is written once.
  8. Confirm no task remains permanently `running` with expired lease.

## Implementation Notes

Idempotency keys should be deterministic:

| Flow | Key |
|---|---|
| Agent | `agent:{agentType}:episode:{episodeId}:hash(message)` |
| Character image | `image:character:{characterId}:config:{configId}` |
| Scene image | `image:scene:{sceneId}:config:{configId}` |
| Storyboard frame | `image:storyboard:{storyboardId}:{frameType}:hash(prompt+refs)` |
| Video | `video:storyboard:{storyboardId}:hash(prompt+refs+config)` |
| TTS | `tts:storyboard:{storyboardId}:hash(dialogue+narration+voiceConfig)` |
| Compose | `compose:storyboard:{storyboardId}:force:{0|1}:hash(mediaInputs)` |
| Merge | `merge:episode:{episodeId}:hash(composedVideoUrls)` |
| Grid draft | `grid:draft:episode:{episodeId}:mode:{mode}` |

Task handler contract:

```ts
export interface TaskHandler<TPayload = unknown, TResult = unknown> {
  type: string
  concurrencyKey?: (payload: TPayload) => string
  resumable: boolean
  maxAttempts: number
  run(ctx: TaskContext<TPayload>): Promise<TResult>
}
```

Task context must expose:

```ts
export interface TaskContext<TPayload> {
  taskId: number
  payload: TPayload
  signal: AbortSignal
  progress(message: string, current?: number, total?: number): void
  event(type: string, data?: unknown): void
  isCancelRequested(): boolean
}
```

Do not put business truth only in task rows. Task rows are execution truth; final outputs still belong in existing business tables.

## Final Unified Acceptance

The feature is done only when all of these are true:

- Every long-running creation action has a task row.
- Every task can be listed by drama and episode.
- UI task state survives page refresh.
- Backend restart either resumes work or produces visible stale/failed state.
- Existing business outputs remain in their current tables and routes.
- Duplicate clicks do not create duplicate provider jobs.
- Failed tasks have retry path and readable error.
- Batch tasks expose parent/child progress.
- No old `processing` row can remain invisible forever.
- Typecheck/build/test commands pass.

## Decision Audit Trail

| # | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|
| 1 | Use unified SQLite task system | Architecture | Boring by default | Existing app is local SQLite/WAL, so SQLite leases solve the problem without new infra | Redis/BullMQ, localStorage-only |
| 2 | Preserve existing business tables as source of outputs | Data model | Incremental over rewrite | Reduces migration risk and keeps existing APIs useful | Moving all result data into task payloads |
| 3 | Add Task Center UI | UX | State visibility | Parallel tasks need a single visible place for running/failed/retry/cancel | Hidden polling per button only |
| 4 | Phase migration by subsystem | Execution | Small blast radius | Schema and worker can be validated before touching image/video/FFmpeg flows | Big-bang rewrite |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/autoplan` degraded | Scope & product risk | 1 | issues_open | Premise gate remains: confirm unified task system scope |
| Design Review | `/autoplan` degraded | Task visibility UX | 1 | issues_open | Task Center required for parallel recoverable UX |
| Eng Review | `/autoplan` degraded | Architecture & tests | 1 | issues_open | SQLite task system is recommended; tests and restart recovery are required |
| DX Review | `/autoplan` degraded | API/runbook ergonomics | 1 | issues_open | Task API and repair runbook required for debuggability |

**VERDICT:** Plan is ready for user premise approval, not yet approved for implementation.

**UNRESOLVED DECISIONS:**
- Confirm whether to proceed with the recommended unified SQLite task system scope before Phase 0/1 implementation.
