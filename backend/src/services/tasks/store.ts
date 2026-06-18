import { and, eq } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
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
} from './types.js'

const ACTIVE_STATUSES = new Set(['queued', 'running', 'stale'])

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

function normalizeTask(row: typeof schema.creationTasks.$inferSelect): CreationTask {
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
    cancelRequested: false,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const task = getTask(Number(result.lastInsertRowid))
  if (!task) throw new Error('Task insert failed')
  appendTaskEvent(task.id, 'created', { status: task.status, type: task.type })
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

export function acquireNextQueuedTask(input: LeaseTaskInput): CreationTask | null {
  const nowMs = input.nowMs ?? Date.now()
  const leaseExpiresAt = isoFromMs(nowMs + input.leaseMs)
  const candidates = db.select().from(schema.creationTasks).all()
    .filter(row => row.status === 'queued')
    .filter(row => !input.types?.length || input.types.includes(row.type))
    .sort((a, b) => a.id - b.id)

  const row = candidates[0]
  if (!row) return null

  const ts = isoFromMs(nowMs)
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

  return getTask(row.id)
}

export function transitionTask(
  id: number,
  status: CreationTaskStatus,
  input: TransitionTaskInput = {},
): CreationTask {
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

  db.update(schema.creationTasks).set(updates)
    .where(eq(schema.creationTasks.id, id))
    .run()
  appendTaskEvent(id, 'status.changed', { status, ...input })

  const task = getTask(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  return task
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
  return getTask(id)
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

export function scheduleTaskRetry(id: number, error: Error): CreationTask {
  const task = getTask(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  db.update(schema.creationTasks).set({
    status: 'queued',
    errorMessage: error.message,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now(),
  }).where(eq(schema.creationTasks.id, id)).run()
  appendTaskEvent(id, 'retry.scheduled', {
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    error: error.message,
  })
  const updated = getTask(id)
  if (!updated) throw new Error(`Task not found: ${id}`)
  return updated
}

export function appendTaskEvent(taskId: number, eventType: string, data?: unknown): CreationTaskEvent {
  const result = db.insert(schema.creationTaskEvents).values({
    taskId,
    eventType,
    dataJson: stringifyJson(data),
    createdAt: now(),
  }).run()
  const [row] = db.select().from(schema.creationTaskEvents)
    .where(eq(schema.creationTaskEvents.id, Number(result.lastInsertRowid)))
    .all()
  return normalizeEvent(row)
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
  return task
}
