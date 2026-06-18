# Persistent Task System

The creation workflow uses SQLite-backed tasks for every long-running operation. The task table is execution truth; final business outputs still live in their existing tables such as `image_generations`, `video_generations`, `storyboards`, and `video_merges`.

## Core Tables

- `creation_tasks`: one row per durable unit of work. Important columns are `type`, `status`, `drama_id`, `episode_id`, `scope_type`, `scope_id`, `idempotency_key`, `parent_task_id`, `payload_json`, progress fields, lease fields, attempts, and cancellation state.
- `creation_task_events`: append-only task timeline for debugging.
- `creation_task_dependencies`: parent/child dependency graph, currently used by batch compose.
- `grid_drafts`: durable grid generation draft metadata.

## Status Model

- `queued`: available for a worker lease.
- `running`: leased by a worker and expected to heartbeat.
- `succeeded`: handler completed and wrote any business output.
- `failed`: terminal failure after retry budget is exhausted.
- `canceled`: user requested cancellation before or during execution.
- `stale`: task could not safely resume after an expired lease, usually because the handler is non-resumable.

## Handler Contract

Handlers are registered in `backend/src/index.ts` through `register*Handler()` calls. A handler receives:

```ts
interface TaskContext<TPayload> {
  taskId: number
  payload: TPayload
  signal: AbortSignal
  progress(message: string, current?: number, total?: number): void
  event(type: string, data?: unknown): void
  isCancelRequested(): boolean
}
```

Handler rules:

- Use `ctx.progress()` for visible progress.
- Use `ctx.event()` for provider ids, command stages, and recovery-relevant breadcrumbs.
- Check `ctx.signal.aborted` or `ctx.isCancelRequested()` around long loops and provider polling.
- Keep business outputs in existing tables; do not make `creation_tasks.result_json` the only source of output truth.
- Set `resumable: false` for handlers whose side effects cannot be retried safely, such as agent runs.

## Idempotency

Creation routes must supply deterministic `idempotency_key` values. `createTask()` reuses active tasks with the same `type` and key, preventing duplicate provider jobs from repeated clicks. Failed terminal tasks with the same key may be retried by creating a new row with the same payload.

Current task types:

- `agent.run`
- `image.generate`
- `video.generate`
- `tts.storyboard`
- `tts.character_sample`
- `grid.generate`
- `grid.split`
- `compose.storyboard`
- `compose.episode`
- `merge.episode`

## Lease, Retry, Recovery

- `runWorkerOnce()` leases one queued task for a worker id.
- A heartbeat extends `lease_expires_at` while a handler runs.
- Retryable failures call `scheduleTaskRetry()` until `attempts >= max_attempts`.
- `recoverExpiredRunningTasks()` runs on worker startup. Resumable handlers are requeued; non-resumable handlers become `stale`.
- `requestCancel()` sets `cancel_requested`. Queued tasks are canceled before execution; running tasks are polled and receive an aborted `AbortSignal`.

## Tests

Run all backend task tests:

```bash
cd backend
npm test
```

Targeted task worker tests:

```bash
cd backend
node --test --import tsx src/services/tasks/worker.test.ts
```

Full validation before shipping task changes:

```bash
cd backend && npm run typecheck && npm test
cd ../frontend && npm run build
```
