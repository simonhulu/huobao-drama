# Task System Runbook

This runbook covers operational checks, safe repair commands, and final QA for the persistent creation task system.

## Quick Checks

Health:

```bash
curl -fsS http://localhost:5679/api/v1/health
```

List tasks for an episode:

```bash
curl -fsS "http://localhost:5679/api/v1/tasks?drama_id=<DRAMA_ID>&episode_id=<EPISODE_ID>"
```

Inspect one task:

```bash
curl -fsS "http://localhost:5679/api/v1/tasks/<TASK_ID>"
curl -fsS "http://localhost:5679/api/v1/tasks/<TASK_ID>/events"
```

Audit legacy stuck rows:

```bash
curl -fsS "http://localhost:5679/api/v1/task-audit/stuck"
```

## Status Meanings

- `queued`: waiting for a worker.
- `running`: worker has leased it; `lease_expires_at` should move forward while active.
- `succeeded`: task completed.
- `failed`: terminal failure; the UI should show the error and allow retry where payload is present.
- `canceled`: user requested cancellation and the worker did not continue it.
- `stale`: worker restart or expired lease left a non-resumable task unsafe to resume.

## Safe Operations

Cancel a queued or running task:

```bash
curl -fsS -X POST "http://localhost:5679/api/v1/tasks/<TASK_ID>/cancel"
```

Retry a failed task by reusing its fields:

```bash
curl -fsS -X POST "http://localhost:5679/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "image.generate",
    "drama_id": 1,
    "episode_id": 2,
    "scope_type": "storyboard",
    "scope_id": 3,
    "idempotency_key": "same-key-as-failed-task",
    "payload": { "image_generation_id": 123 },
    "max_attempts": 2
  }'
```

Start backend without workers for inspection:

```bash
cd backend
TASK_WORKER_DISABLED=1 npm run start
```

Run one-off verification:

```bash
cd backend && npm run typecheck && npm test
cd ../frontend && npm run build
```

## SQLite Inspection

Default database path is `data/huobao_drama.db`, or `DB_PATH` if set.

Read-only inspection:

```bash
sqlite3 data/huobao_drama.db \
  "select id,type,status,episode_id,scope_type,scope_id,lease_expires_at,error_message from creation_tasks order by id desc limit 20;"
```

Find expired running tasks:

```bash
sqlite3 data/huobao_drama.db \
  "select id,type,status,lease_owner,lease_expires_at,updated_at from creation_tasks where status='running' order by updated_at;"
```

Do not directly update task rows unless the backend is stopped and the row has been classified. Prefer API cancel/retry first.

## Repair Guidance

- For `queued` tasks that should not run, use the cancel API.
- For `running` tasks with expired leases, restart the backend worker. Startup recovery will requeue resumable tasks or mark non-resumable tasks `stale`.
- For `failed` or `stale` tasks, retry from the UI Task Center or recreate via `POST /tasks` with the same payload.
- For old `image_generations` / `video_generations` rows stuck in `processing`, first inspect `/task-audit/stuck`. Rows with provider `task_id` are candidates for provider reconciliation; rows without provider ids should be marked failed or retried from the original prompt after review.
- For `storyboards.status='compose_processing'`, rerun compose if source media exists. If no source media exists, clear only after manual review.
- For `video_merges.status in ('pending','processing')`, rerun merge if the source scene list is present.

## Manual QA Checklist

Use a test project with disposable provider credits.

1. Start Agent, character/scene image, storyboard image, video, TTS, compose, and merge tasks in parallel.
2. Open the Task Center and confirm queued/running tasks are grouped by status and type.
3. Refresh the browser while tasks run; active tasks must remain visible.
4. Cancel a queued task; it must show `cancel_requested` and must not execute.
5. Cancel a running cooperative task; it must become `canceled` rather than `failed`.
6. Stop and restart the backend while image/video/compose tasks are active; tasks must resume or become visible as `stale`/`failed`.
7. Retry a failed task from Task Center and confirm a new queued task appears.
8. Confirm batch compose shows parent/child progress.
9. Confirm final merge writes exactly one final episode video URL.
10. Confirm no task remains permanently `running` with an expired lease after restart recovery.

## Final Acceptance Commands

```bash
git diff --check
cd backend && npm run typecheck && npm test
cd ../frontend && ../backend/node_modules/.bin/tsx --test app/composables/taskState.test.ts
cd ../frontend && npm run build
```
