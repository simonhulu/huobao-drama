# Tasks — Persistent Task Queue

## OVERVIEW
SQLite-backed persistent task queue for long-running AI operations (agent runs, image/video generation, TTS, compose, merge). HTTP enqueues; background worker polls, acquires lease, executes. Survives restarts.

## STRUCTURE
```
tasks/
├── README.md          # Implementation docs
├── types.ts           # Task types, statuses, handler signatures
├── store.ts           # CRUD + idempotency + state transitions
├── registry.ts        # Global handler map: type → TaskHandler
├── worker.ts          # Poll-execute loop with lease management
├── recovery.ts        # Stranded/stuck task recovery
├── audit.ts           # Stuck-row classification
└── handlers/
    ├── agent-run.ts           # Agent chat execution
    ├── image-generate.ts      # AI image generation
    ├── video-generate.ts      # AI video generation
    ├── tts-generate.ts        # TTS audio generation
    ├── grid-generate.ts       # Grid image generation + split
    ├── compose-storyboard.ts  # Single storyboard compose (video+audio+subtitle)
    ├── compose-episode.ts     # Episode compose (spawns child tasks)
    └── merge-episode.ts       # Full episode merge (all storyboards → one video)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add handler | `handlers/` + register in `backend/src/index.ts` | Signature: `(task, events$) => Promise<TaskResult>` |
| State machine | `types.ts` | queued → running → completed/failed; cancel_requested flag |
| Debug stuck | `routes/taskAudit.ts` → `GET /api/v1/task-audit/stuck` | recoverable, terminal_unknown, needs_manual_review |
| Dependencies | `creation_task_dependencies` table | Parent/child relationships |
| Idempotency | `store.ts` → `idempotencyKey` | Prevents duplicate task creation |

## CONVENTIONS
- **Lease-based worker** — `leaseOwner` + `leaseExpiresAt` acquired before execution. Heartbeat refreshes. Expired leases recovered.
- **Explicit registration** — `register*Handler()` calls in `backend/src/index.ts`. No auto-discovery.
- **Task events** — `creation_task_events` table logs progress (eventType: progress, error, completed).
- **Progress tracking** — `progressCurrent`/`progressTotal`/`progressMessage` for UI display.
- **Retry** — `attempts`/`maxAttempts`. Failed tasks retried up to limit.
- **Cancel support** — `cancel_requested` flag; handlers must check and honor.
- **Test isolation** — `mkdtempSync` per test, no shared DB fixtures.

## ANTI-PATTERNS
- **Don't add auto-discovery** — handler registration intentionally explicit in `index.ts`.
- **Don't skip null-checks** — `payload`/`payloadJson` can be null; handlers must validate.
- **Don't ignore `cancel_requested`** — handlers must check periodically and abort if set.
