import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { taskEventBus } from './events.js'
import type {
  CreateTaskInput,
  CreationTask,
  CreationTaskDependency,
  CreationTaskEvent,
  CreationTaskStatus,
  LeaseTaskInput,
  TaskProgressInput,
  TaskListFilter,
  TransitionTaskInput,
  TransactionClient,
} from './types.js'

const ACTIVE_STATUSES = new Set(['queued', 'running'])

function parseJson(value: string | null | undefined) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function stringifyJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value)
}

export function normalizeTask(row: typeof schema.creationTasks.$inferSelect): CreationTask {
  return {
    id: row.id,
    type: row.type,
    status: row.status as CreationTaskStatus,
    dramaId: row.dramaId,
    episodeId: row.episodeId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    idempotencyKey: row.idempotencyKey,
    parentTaskId: row.parentTaskId,
    payload: parseJson(row.payloadJson),
    result: parseJson(row.resultJson),
    progressCurrent: row.progressCurrent ?? 0,
    progressTotal: row.progressTotal ?? 0,
    progressMessage: row.progressMessage,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    attempts: row.attempts ?? 0,
    maxAttempts: row.maxAttempts ?? 1,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    cancelRequested: Boolean(row.cancelRequested),
    priority: row.priority ?? 0,
    scheduledAt: row.scheduledAt ?? null,
    provider: row.provider ?? null,
    retryReason: row.retryReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }
}

function normalizeEvent(row: typeof schema.creationTaskEvents.$inferSelect): CreationTaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    eventType: row.eventType,
    data: parseJson(row.dataJson),
    createdAt: row.createdAt,
  }
}

function normalizeDependency(row: typeof schema.creationTaskDependencies.$inferSelect): CreationTaskDependency {
  return {
    id: row.id,
    taskId: row.taskId,
    dependsOnTaskId: row.dependsOnTaskId,
    createdAt: row.createdAt,
  }
}

function getTaskWithClient(client: TransactionClient | typeof db, id: number): CreationTask | null {
  const [row] = client.select().from(schema.creationTasks)
    .where(eq(schema.creationTasks.id, id))
    .all()
  return row ? normalizeTask(row) : null
}

function appendTaskEventWithClient(
  client: TransactionClient | typeof db,
  taskId: number,
  eventType: string,
  data?: unknown,
): CreationTaskEvent {
  const result = client.insert(schema.creationTaskEvents).values({
    taskId,
    eventType,
    dataJson: stringifyJson(data),
    createdAt: now(),
  }).run()
  const [row] = client.select().from(schema.creationTaskEvents)
    .where(eq(schema.creationTaskEvents.id, Number(result.lastInsertRowid)))
    .all()
  return normalizeEvent(row)
}

function findActiveTask(type: string, idempotencyKey?: string | null) {
  if (!idempotencyKey) return null
  const rows = db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, type),
      eq(schema.creationTasks.idempotencyKey, idempotencyKey),
    ))
    .all()
  const active = rows.find(row => ACTIVE_STATUSES.has(row.status))
  return active ? normalizeTask(active) : null
}

export function createTask(input: CreateTaskInput): CreationTask {
  const existing = findActiveTask(input.type, input.idempotencyKey)
  if (existing) return existing

  const ts = now()
  const scheduledAt = input.scheduledAt ?? null
  const result = db.insert(schema.creationTasks).values({
    type: input.type,
    status: 'queued',
    dramaId: input.dramaId ?? null,
    episodeId: input.episodeId ?? null,
    scopeType: input.scopeType ?? null,
    scopeId: input.scopeId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    parentTaskId: input.parentTaskId ?? null,
    payloadJson: stringifyJson(input.payload),
    progressCurrent: 0,
    progressTotal: 0,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
    priority: input.priority ?? 0,
    scheduledAt,
    provider: input.provider ?? null,
    retryReason: null,
    cancelRequested: false,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const task = getTask(Number(result.lastInsertRowid))
  if (!task) throw new Error('Task insert failed')
  appendTaskEvent(task.id, 'created', { status: task.status, type: task.type })
  taskEventBus.notifyTaskChanged(task, 'created')
  return task
}

export function getTask(id: number): CreationTask | null {
  const [row] = db.select().from(schema.creationTasks)
    .where(eq(schema.creationTasks.id, id))
    .all()
  return row ? normalizeTask(row) : null
}

export function listTasks(filter: TaskListFilter = {}): CreationTask[] {
  let rows = db.select().from(schema.creationTasks).all()
  if (filter.dramaId != null) rows = rows.filter(row => row.dramaId === filter.dramaId)
  if (filter.episodeId != null) rows = rows.filter(row => row.episodeId === filter.episodeId)
  if (filter.status) rows = rows.filter(row => row.status === filter.status)
  if (filter.type) rows = rows.filter(row => row.type === filter.type)
  return rows
    .sort((a, b) => b.id - a.id)
    .map(normalizeTask)
}

function isoFromMs(ms: number) {
  return new Date(ms).toISOString()
}

function parsePayloadJson(payloadJson: string | null | undefined) {
  if (!payloadJson) return null
  try {
    return JSON.parse(payloadJson)
  } catch {
    return null
  }
}

function getTaskDependencyState(taskId: number): { ready: boolean; failed: boolean; reason?: string } {
  const deps = db.select().from(schema.creationTaskDependencies)
    .where(eq(schema.creationTaskDependencies.taskId, taskId))
    .all()
  if (deps.length === 0) return { ready: true, failed: false }

  for (const dep of deps) {
    const [depTask] = db.select().from(schema.creationTasks)
      .where(eq(schema.creationTasks.id, dep.dependsOnTaskId))
      .all()
    if (!depTask) continue
    if (depTask.status === 'succeeded') continue
    if (depTask.status === 'failed' || depTask.status === 'canceled') {
      return {
        ready: false,
        failed: true,
        reason: `Dependency ${depTask.id} ${depTask.status}${depTask.errorMessage ? ': ' + depTask.errorMessage : ''}`,
      }
    }
    return { ready: false, failed: false, reason: `Waiting for dependency ${depTask.id}` }
  }
  return { ready: true, failed: false }
}

export function acquireNextQueuedTask(input: LeaseTaskInput): CreationTask | null {
  const nowMs = input.nowMs ?? Date.now()
  const leaseExpiresAt = isoFromMs(nowMs + input.leaseMs)
  const ts = isoFromMs(nowMs)
  const isoNow = ts

  const candidates = db.select().from(schema.creationTasks).all()
    .filter(row => row.status === 'queued')
    .filter(row => !input.types?.length || input.types.includes(row.type))
    .filter(row => {
      const scheduled = row.scheduledAt
      if (!scheduled) return true
      return scheduled <= isoNow
    })
    .sort((a, b) => {
      const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0)
      if (priorityDiff !== 0) return priorityDiff
      const scheduledA = a.scheduledAt ?? ''
      const scheduledB = b.scheduledAt ?? ''
      if (scheduledA !== scheduledB) return scheduledA.localeCompare(scheduledB)
      return a.id - b.id
    })

  for (const row of candidates) {
    const depState = getTaskDependencyState(row.id)
    if (depState.ready) {
      db.update(schema.creationTasks).set({
        status: 'running',
        leaseOwner: input.workerId,
        leaseExpiresAt,
        startedAt: row.startedAt ?? ts,
        updatedAt: ts,
      }).where(eq(schema.creationTasks.id, row.id)).run()

      appendTaskEvent(row.id, 'leased', {
        workerId: input.workerId,
        leaseExpiresAt,
      })

      const task = getTask(row.id)
      if (task) taskEventBus.notifyTaskChanged(task, 'leased')
      return task
    }
    if (depState.failed) {
      transitionTask(row.id, 'failed', {
        errorCode: 'dependency_failed',
        errorMessage: depState.reason,
      })
    }
  }

  return null
}

export function transitionTask(
  id: number,
  status: CreationTaskStatus,
  input: TransitionTaskInput = {},
): CreationTask {
  const result = db.transaction((tx) => {
    const ts = now()
    const updates: Partial<typeof schema.creationTasks.$inferInsert> = {
      status,
      updatedAt: ts,
    }

    if (status === 'running') updates.startedAt = ts
    if (status === 'succeeded' || status === 'failed' || status === 'canceled') {
      updates.completedAt = ts
      updates.leaseOwner = null
      updates.leaseExpiresAt = null
    }
    if (status === 'queued' || status === 'stale') {
      updates.leaseOwner = null
      updates.leaseExpiresAt = null
    }
    if (input.result !== undefined) updates.resultJson = stringifyJson(input.result)
    if (input.progressCurrent !== undefined) updates.progressCurrent = input.progressCurrent
    if (input.progressTotal !== undefined) updates.progressTotal = input.progressTotal
    if (input.progressMessage !== undefined) updates.progressMessage = input.progressMessage
    if (input.errorCode !== undefined) updates.errorCode = input.errorCode
    if (input.errorMessage !== undefined) updates.errorMessage = input.errorMessage

    tx.update(schema.creationTasks).set(updates)
      .where(eq(schema.creationTasks.id, id))
      .run()

    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found: ${id}`)

    input.sync?.(tx, task)
    appendTaskEventWithClient(tx, id, 'status.changed', { status, ...input })

    return task
  })
  taskEventBus.notifyTaskChanged(result, `status:${status}`)
  return result
}

export function updateTaskProgress(id: number, input: TaskProgressInput): CreationTask {
  const updates: Partial<typeof schema.creationTasks.$inferInsert> = { updatedAt: now() }
  if (input.progressCurrent !== undefined) updates.progressCurrent = input.progressCurrent
  if (input.progressTotal !== undefined) updates.progressTotal = input.progressTotal
  if (input.progressMessage !== undefined) updates.progressMessage = input.progressMessage

  db.update(schema.creationTasks).set(updates)
    .where(eq(schema.creationTasks.id, id))
    .run()
  appendTaskEvent(id, 'progress', input)

  const task = getTask(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  taskEventBus.notifyTaskChanged(task, 'progress')
  return task
}

export function extendTaskLease(id: number, workerId: string, leaseMs: number): CreationTask | null {
  const task = getTask(id)
  if (!task || task.leaseOwner !== workerId || task.status !== 'running') return null
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
  db.update(schema.creationTasks)
    .set({ leaseExpiresAt, updatedAt: now() })
    .where(eq(schema.creationTasks.id, id))
    .run()
  appendTaskEvent(id, 'heartbeat', { workerId, leaseExpiresAt })
  const updated = getTask(id)
  if (updated) taskEventBus.notifyTaskChanged(updated, 'heartbeat')
  return updated
}

export function markTaskAttemptStarted(id: number): CreationTask {
  const task = getTask(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  const attempts = task.attempts + 1
  db.update(schema.creationTasks).set({
    attempts,
    updatedAt: now(),
  }).where(eq(schema.creationTasks.id, id)).run()
  appendTaskEvent(id, 'attempt.started', {
    attempts,
    maxAttempts: task.maxAttempts,
  })
  const updated = getTask(id)
  if (!updated) throw new Error(`Task not found: ${id}`)
  return updated
}

export function scheduleTaskRetry(
  id: number,
  error: Error,
  retryReason?: string,
  scheduledAt?: string,
  sync?: (tx: TransactionClient, task: CreationTask) => void,
): CreationTask {
  const result = db.transaction((tx) => {
    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found: ${id}`)
    const ts = now()
    tx.update(schema.creationTasks).set({
      status: 'queued',
      errorMessage: error.message,
      retryReason: retryReason ?? null,
      scheduledAt: scheduledAt ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: ts,
    }).where(eq(schema.creationTasks.id, id)).run()

    const updated = getTaskWithClient(tx, id)
    if (!updated) throw new Error(`Task not found: ${id}`)

    sync?.(tx, updated)
    appendTaskEventWithClient(tx, id, 'retry.scheduled', {
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      retryReason: retryReason ?? null,
      scheduledAt: scheduledAt ?? null,
      error: error.message,
    })

    return updated
  })
  taskEventBus.notifyTaskChanged(result, 'retry.scheduled')
  return result
}

export function appendTaskEvent(taskId: number, eventType: string, data?: unknown): CreationTaskEvent {
  return appendTaskEventWithClient(db, taskId, eventType, data)
}

export function listTaskEvents(taskId: number): CreationTaskEvent[] {
  return db.select().from(schema.creationTaskEvents)
    .where(eq(schema.creationTaskEvents.taskId, taskId))
    .all()
    .sort((a, b) => a.id - b.id)
    .map(normalizeEvent)
}

export function addTaskDependency(taskId: number, dependsOnTaskId: number): CreationTaskDependency {
  const existing = db.select().from(schema.creationTaskDependencies)
    .where(and(
      eq(schema.creationTaskDependencies.taskId, taskId),
      eq(schema.creationTaskDependencies.dependsOnTaskId, dependsOnTaskId),
    ))
    .all()[0]
  if (existing) return normalizeDependency(existing)

  const result = db.insert(schema.creationTaskDependencies).values({
    taskId,
    dependsOnTaskId,
    createdAt: now(),
  }).run()
  const [row] = db.select().from(schema.creationTaskDependencies)
    .where(eq(schema.creationTaskDependencies.id, Number(result.lastInsertRowid)))
    .all()
  appendTaskEvent(taskId, 'dependency.added', { dependsOnTaskId })
  return normalizeDependency(row)
}

export function listTaskDependencies(taskId: number): CreationTaskDependency[] {
  return db.select().from(schema.creationTaskDependencies)
    .where(eq(schema.creationTaskDependencies.taskId, taskId))
    .all()
    .sort((a, b) => a.id - b.id)
    .map(normalizeDependency)
}

export function listTaskDependents(dependsOnTaskId: number): CreationTaskDependency[] {
  return db.select().from(schema.creationTaskDependencies)
    .where(eq(schema.creationTaskDependencies.dependsOnTaskId, dependsOnTaskId))
    .all()
    .sort((a, b) => a.id - b.id)
    .map(normalizeDependency)
}

export function requestCancel(id: number): CreationTask {
  db.update(schema.creationTasks)
    .set({ cancelRequested: true, updatedAt: now() })
    .where(eq(schema.creationTasks.id, id))
    .run()
  appendTaskEvent(id, 'cancel.requested')
  const task = getTask(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  taskEventBus.notifyTaskChanged(task, 'cancel.requested')
  return task
}
