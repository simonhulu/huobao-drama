export type CreationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'stale'

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
}

export interface TaskListFilter {
  dramaId?: number
  episodeId?: number
  status?: CreationTaskStatus | string
  type?: string
}

export interface TransitionTaskInput {
  result?: unknown
  progressCurrent?: number
  progressTotal?: number
  progressMessage?: string | null
  errorCode?: string | null
  errorMessage?: string | null
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
  leaseExpiresAt: string | null
  attempts: number
  maxAttempts: number
  errorCode: string | null
  errorMessage: string | null
  cancelRequested: boolean
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
  payload: TPayload
  signal: AbortSignal
  progress(message: string, current?: number, total?: number): void
  event(type: string, data?: unknown): void
  isCancelRequested(): boolean
}

export interface TaskHandler<TPayload = any, TResult = any> {
  resumable: boolean
  maxAttempts: number
  concurrencyKey?: (payload: TPayload) => string
  run(ctx: TaskContext<TPayload>): Promise<TResult> | TResult
}
