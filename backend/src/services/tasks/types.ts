export type CreationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'stale'

export const TASK_CANCEL_REASON_MAX_LENGTH = 500
export const TASK_CANCEL_ACTOR_MAX_LENGTH = 120
export const TASK_EVENT_LIST_MAX_LIMIT = 500

export interface CreateTaskInput {
  type: string
  dramaId?: number | null
  episodeId?: number | null
  scopeType?: string | null
  scopeId?: number | null
  idempotencyKey?: string | null
  parentTaskId?: number | null
  payload?: unknown
  maxAttempts?: number
  priority?: number
  scheduledAt?: string | null
  provider?: string | null
}

export interface TaskListFilter {
  dramaId?: number
  episodeId?: number
  status?: CreationTaskStatus | string
  type?: string
  activeOnly?: boolean
}

export interface TaskEventListOptions {
  afterId?: number
  limit?: number
}

export type TransactionClient = Parameters<Parameters<typeof import('../../db/index.js').db.transaction>[0]>[0]

export interface TransitionTaskInput {
  result?: unknown
  progressCurrent?: number
  progressTotal?: number
  progressMessage?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  sync?: (tx: TransactionClient, task: CreationTask) => void
}

export interface LeaseTaskInput {
  workerId: string
  leaseMs: number
  nowMs?: number
  types?: string[]
}

export interface TaskProgressInput {
  progressCurrent?: number
  progressTotal?: number
  progressMessage?: string | null
}

export interface TaskCancellationRequest {
  reason?: string | null
  confirmation?: string | null
  actor?: string | null
  source?: string | null
  userAgent?: string | null
  forwardedFor?: string | null
  realIp?: string | null
}

export interface ClaimTaskCommitPointInput {
  workerId: string
  /** Opaque per-claim capability; worker ids alone are not a lease fence. */
  leaseToken: string
  /** Runs inside the same SQLite transaction after the task claim is acquired. */
  validate?: (tx: TransactionClient, task: CreationTask) => void
}

export type TaskCancellationOutcome =
  | 'requested'
  | 'already_requested'
  | 'not_found'
  | 'not_active'
  | 'reason_required'
  | 'reason_too_long'
  | 'confirmation_required'
  | 'actor_required'
  | 'actor_too_long'
  | 'commit_claimed'

export interface TaskCancellationResult {
  outcome: TaskCancellationOutcome
  task: CreationTask | null
}

export type DharmaCommitReconciliationResolution = 'retain_published' | 'discard_unpublished'

export interface DharmaCommitReconciliationInput {
  episodeId: number
  resolution: DharmaCommitReconciliationResolution
  reason: string
  actor: string
  expectedOutput: string
  /** Runs in the same transaction as the gate-release update and returns the audited pointer state. */
  validate: (tx: TransactionClient, task: CreationTask) => boolean
}

export type DharmaCommitReconciliationOutcome = 'reconciled' | 'not_found' | 'not_reconcilable'

export interface DharmaCommitReconciliationResult {
  outcome: DharmaCommitReconciliationOutcome
  task: CreationTask | null
}

export type TaskCommitClaimOutcome =
  | 'claimed'
  | 'not_found'
  | 'not_running'
  | 'lease_lost'
  | 'cancel_requested'
  | 'already_claimed'

export interface TaskCommitClaimResult {
  outcome: TaskCommitClaimOutcome
  task: CreationTask | null
}

export interface CreationTask {
  id: number
  type: string
  status: CreationTaskStatus
  dramaId: number | null
  episodeId: number | null
  scopeType: string | null
  scopeId: number | null
  idempotencyKey: string | null
  parentTaskId: number | null
  payload: any
  result: any
  progressCurrent: number
  progressTotal: number
  progressMessage: string | null
  leaseOwner: string | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  attempts: number
  maxAttempts: number
  errorCode: string | null
  errorMessage: string | null
  cancelRequested: boolean
  commitClaimedAt: string | null
  priority: number
  scheduledAt: string | null
  provider: string | null
  retryReason: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface CreationTaskEvent {
  id: number
  taskId: number
  eventType: string
  data: any
  createdAt: string
}

export interface CreationTaskDependency {
  id: number
  taskId: number
  dependsOnTaskId: number
  createdAt: string
}

export interface TaskContext<TPayload = any> {
  taskId: number
  workerId?: string
  /** Opaque capability generated for this exact task claim. */
  leaseToken?: string
  /** Durable task-row ownership scope. Payload fields must not override it. */
  episodeId?: number | null
  payload: TPayload
  signal: AbortSignal
  attempts: number
  progress(message: string, current?: number, total?: number): void
  event(type: string, data?: unknown): void
  isCancelRequested(): boolean
  /**
   * A handler calls this immediately after an irreversible external publish.
   * Cancellation before this point wins; cancellation after it cannot roll
   * back a delivery that has already become visible.
   */
  markCommitPoint?(): void
  hasPassedCommitPoint?(): boolean
}

export interface TaskHandler<TPayload = any, TResult = any> {
  resumable: boolean
  maxAttempts: number
  concurrencyKey?: (payload: TPayload) => string
  run(ctx: TaskContext<TPayload>): Promise<TResult> | TResult
}
