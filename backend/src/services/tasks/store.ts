import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import { taskEventBus } from './events.js'
import { isFormalDharmaRenderPayload } from '../dharma-render-payload.js'
import {
  TASK_CANCEL_ACTOR_MAX_LENGTH,
  TASK_CANCEL_REASON_MAX_LENGTH,
  TASK_EVENT_LIST_MAX_LIMIT,
} from './types.js'
import type {
  CreateTaskInput,
  ClaimTaskCommitPointInput,
  CreationTask,
  CreationTaskDependency,
  CreationTaskEvent,
  CreationTaskStatus,
  DharmaCommitReconciliationInput,
  DharmaCommitReconciliationResult,
  LeaseTaskInput,
  TaskCancellationRequest,
  TaskCancellationResult,
  TaskCommitClaimResult,
  TaskEventListOptions,
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

type WorkerLease = {
  workerId: string
  leaseToken: string
}
type ObservedLease = Pick<
  CreationTask,
  'leaseOwner' | 'leaseToken' | 'leaseExpiresAt' | 'commitClaimedAt' | 'cancelRequested'
>

/**
 * SQLite's lexical TEXT ordering is not sufficient here: malformed timestamps
 * could sort after a valid ISO timestamp and resurrect an expired lease.
 */
function currentWorkerLeaseWhere(id: number, workerId: string, leaseToken: string, checkedAt: string) {
  return and(
    eq(schema.creationTasks.id, id),
    eq(schema.creationTasks.status, 'running'),
    eq(schema.creationTasks.leaseOwner, workerId),
    eq(schema.creationTasks.leaseToken, leaseToken),
    sql`julianday(${schema.creationTasks.leaseExpiresAt}) > julianday(${checkedAt})`,
  )
}

function observedRunningLeaseWhere(id: number, observedLease: ObservedLease) {
  const owner = observedLease.leaseOwner === null
    ? isNull(schema.creationTasks.leaseOwner)
    : eq(schema.creationTasks.leaseOwner, observedLease.leaseOwner)
  const token = observedLease.leaseToken === null
    ? isNull(schema.creationTasks.leaseToken)
    : eq(schema.creationTasks.leaseToken, observedLease.leaseToken)
  const expiresAt = observedLease.leaseExpiresAt === null
    ? isNull(schema.creationTasks.leaseExpiresAt)
    : eq(schema.creationTasks.leaseExpiresAt, observedLease.leaseExpiresAt)
  const commitClaimedAt = observedLease.commitClaimedAt === null
    ? isNull(schema.creationTasks.commitClaimedAt)
    : eq(schema.creationTasks.commitClaimedAt, observedLease.commitClaimedAt)
  const cancelRequested = eq(schema.creationTasks.cancelRequested, observedLease.cancelRequested)
  return and(
    eq(schema.creationTasks.id, id),
    eq(schema.creationTasks.status, 'running'),
    owner,
    token,
    expiresAt,
    commitClaimedAt,
    cancelRequested,
  )
}

function hasCurrentWorkerLease(task: CreationTask, workerId: string, leaseToken: string, checkedAt: string) {
  if (
    task.status !== 'running'
    || task.leaseOwner !== workerId
    || task.leaseToken !== leaseToken
    || !task.leaseExpiresAt
  ) return false
  const expiresAtMs = Date.parse(task.leaseExpiresAt)
  const checkedAtMs = Date.parse(checkedAt)
  return Number.isFinite(expiresAtMs) && Number.isFinite(checkedAtMs) && expiresAtMs > checkedAtMs
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
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    attempts: row.attempts ?? 0,
    maxAttempts: row.maxAttempts ?? 1,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    cancelRequested: Boolean(row.cancelRequested),
    commitClaimedAt: row.commitClaimedAt ?? null,
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

function findActiveTaskForExclusiveEpisode(type: string, episodeId?: number | null) {
  if (type !== 'dharma.episode_render' || episodeId == null) return null
  const rows = db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, type),
      eq(schema.creationTasks.episodeId, episodeId),
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
  let result: { lastInsertRowid: number | bigint }
  try {
    result = db.insert(schema.creationTasks).values({
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
      commitClaimedAt: null,
      leaseToken: null,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  } catch (error) {
    // The database owns the cross-process race. A Dharma episode permits one
    // active render regardless of preview/full payload; callers compare that
    // existing task's payload and return either it or a 409.
    const raced = findActiveTask(input.type, input.idempotencyKey)
      ?? findActiveTaskForExclusiveEpisode(input.type, input.episodeId)
    if (raced) return raced
    throw error
  }

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
  const conditions = []
  if (filter.dramaId != null) conditions.push(eq(schema.creationTasks.dramaId, filter.dramaId))
  if (filter.episodeId != null) conditions.push(eq(schema.creationTasks.episodeId, filter.episodeId))
  if (filter.status) conditions.push(eq(schema.creationTasks.status, filter.status))
  if (filter.type) conditions.push(eq(schema.creationTasks.type, filter.type))
  if (filter.activeOnly) {
    conditions.push(inArray(schema.creationTasks.status, ['queued', 'running']))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const query = db.select().from(schema.creationTasks)
    .where(where)
    .orderBy(desc(schema.creationTasks.id))
  const rows = filter.activeOnly ? query.limit(200).all() : query.all()
  return rows.map(normalizeTask)
}

/**
 * Lifecycle guards must not inherit the task-center's global 200-row cap.
 * These are deliberately targeted SQL reads for one or more episode ids.
 */
export function listActiveTasksForEpisodes(episodeIds: number[]): CreationTask[] {
  const ids = [...new Set(episodeIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return []
  return db.select().from(schema.creationTasks)
    .where(and(
      inArray(schema.creationTasks.episodeId, ids),
      inArray(schema.creationTasks.status, ['queued', 'running']),
    ))
    .orderBy(desc(schema.creationTasks.id))
    .all()
    .map(normalizeTask)
}

/** Claimed, expired Dharma deliveries require explicit reconciliation before deletion. */
export function listPendingDharmaRenderReconciliationsForEpisodes(episodeIds: number[]): CreationTask[] {
  const ids = [...new Set(episodeIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return []
  return db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, 'dharma.episode_render'),
      inArray(schema.creationTasks.episodeId, ids),
      eq(schema.creationTasks.status, 'stale'),
      isNotNull(schema.creationTasks.commitClaimedAt),
      eq(schema.creationTasks.errorCode, 'task_commit_claimed_reconciliation_required'),
    ))
    .orderBy(desc(schema.creationTasks.id))
    .all()
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

/**
 * Atomically turn one queued row into a lease. The conditional update is what
 * prevents two backend processes from both executing a candidate selected
 * before either one wrote its lease.
 */
export function claimQueuedTask(
  id: number,
  input: Pick<LeaseTaskInput, 'workerId' | 'leaseMs' | 'nowMs'>,
): CreationTask | null {
  const nowMs = input.nowMs ?? Date.now()
  const leaseExpiresAt = isoFromMs(nowMs + input.leaseMs)
  const ts = isoFromMs(nowMs)
  const leaseToken = randomUUID()
  const claimed = db.transaction((tx) => {
    const candidate = getTaskWithClient(tx, id)
    if (!candidate || candidate.status !== 'queued') return null

    const result = tx.update(schema.creationTasks).set({
      status: 'running',
      leaseOwner: input.workerId,
      leaseToken,
      leaseExpiresAt,
      startedAt: candidate.startedAt ?? ts,
      updatedAt: ts,
    }).where(and(
      eq(schema.creationTasks.id, id),
      eq(schema.creationTasks.status, 'queued'),
    )).run()
    if (result.changes !== 1) return null

    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found after lease: ${id}`)
    appendTaskEventWithClient(tx, id, 'leased', {
      workerId: input.workerId,
      lease_token: leaseToken,
      leaseExpiresAt,
    })
    return task
  })

  if (claimed) taskEventBus.notifyTaskChanged(claimed, 'leased')
  return claimed
}

export function acquireNextQueuedTask(input: LeaseTaskInput): CreationTask | null {
  const nowMs = input.nowMs ?? Date.now()
  const isoNow = isoFromMs(nowMs)

  const conditions = [
    eq(schema.creationTasks.status, 'queued'),
    or(isNull(schema.creationTasks.scheduledAt), lte(schema.creationTasks.scheduledAt, isoNow)),
  ]
  if (input.types?.length) {
    conditions.push(inArray(schema.creationTasks.type, input.types))
  }

  const candidates = db.select().from(schema.creationTasks)
    .where(and(...conditions))
    .orderBy(
      desc(schema.creationTasks.priority),
      asc(schema.creationTasks.scheduledAt),
      asc(schema.creationTasks.id),
    )
    .all()

  for (const row of candidates) {
    const depState = getTaskDependencyState(row.id)
    if (depState.ready) {
      const task = claimQueuedTask(row.id, {
        workerId: input.workerId,
        leaseMs: input.leaseMs,
        nowMs,
      })
      if (task) return task
      continue
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
  const result = transitionTaskInternal(id, status, input)
  if (!result) throw new Error(`Task not found: ${id}`)
  return result
}

/** A worker may only finalize a lease it still owns and that has not expired. */
export function transitionTaskWithLease(
  id: number,
  workerId: string,
  leaseToken: string,
  status: CreationTaskStatus,
  input: TransitionTaskInput = {},
): CreationTask | null {
  return transitionTaskInternal(id, status, input, { workerId, leaseToken })
}

/**
 * Recovery supplies the exact lease snapshot it observed as expired. The
 * transition only wins when that snapshot is still current, so it cannot
 * overwrite a task that renewed or changed owner after recovery scanned it.
 */
export function transitionTaskWithExpiredLease(
  observedTask: Pick<
    CreationTask,
    'id' | 'leaseOwner' | 'leaseToken' | 'leaseExpiresAt' | 'commitClaimedAt' | 'cancelRequested'
  >,
  status: CreationTaskStatus,
  input: TransitionTaskInput = {},
  expiredBeforeMs = Date.now(),
): CreationTask | null {
  const leaseExpiresAtMs = observedTask.leaseExpiresAt
    ? Date.parse(observedTask.leaseExpiresAt)
    : Number.NaN
  if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > expiredBeforeMs) return null
  return transitionTaskInternal(observedTask.id, status, input, undefined, observedTask)
}

export interface RecordTaskLeaseLossInput {
  taskId: number
  workerId: string
  leaseToken: string
  /** The worker operation whose lease-fenced mutation was rejected. */
  source: string
  /** Non-resumable work cannot safely continue after its render lease expires. */
  nonResumable: boolean
}

/**
 * Record why a lease-fenced worker stopped without allowing that worker to
 * mutate a successor lease. When the exact expired lease is still present on
 * an uncommitted non-resumable task, make its terminal stale state explicit so
 * recovery is not the only record of an aborted production run.
 */
export function recordTaskLeaseLoss(input: RecordTaskLeaseLossInput): CreationTask | null {
  const result = db.transaction((tx) => {
    const observed = getTaskWithClient(tx, input.taskId)
    if (!observed) return null

    const ts = now()
    const leaseExpiresAtMs = observed.leaseExpiresAt ? Date.parse(observed.leaseExpiresAt) : Number.NaN
    const leaseExpired = !Number.isFinite(leaseExpiresAtMs) || leaseExpiresAtMs <= Date.parse(ts)
    const ownerMatches = observed.leaseOwner === input.workerId
    const tokenMatches = observed.leaseToken === input.leaseToken
    const mayMarkStale = input.nonResumable
      && observed.status === 'running'
      && ownerMatches
      && tokenMatches
      && leaseExpired
      && !observed.commitClaimedAt

    const diagnostic = appendTaskEventWithClient(tx, input.taskId, 'task.lease_lost', {
      source: input.source,
      worker_id: input.workerId,
      observed: {
        status: observed.status,
        owner_matches: ownerMatches,
        token_matches: tokenMatches,
        lease_expires_at: observed.leaseExpiresAt,
        lease_expired: leaseExpired,
        commit_claimed: Boolean(observed.commitClaimedAt),
      },
      resolution: mayMarkStale ? 'marked_stale' : 'diagnostic_only',
    })

    if (!mayMarkStale) return { task: observed, diagnostic, statusEvent: null }

    const updated = tx.update(schema.creationTasks).set({
      status: 'stale',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      errorCode: 'task_lease_lost',
      errorMessage: `Task lease was lost during ${input.source}; uncommitted non-resumable work was stopped.`,
      updatedAt: ts,
    }).where(observedRunningLeaseWhere(input.taskId, observed)).run()
    if (updated.changes !== 1) return { task: observed, diagnostic, statusEvent: null }

    const task = getTaskWithClient(tx, input.taskId)
    if (!task) throw new Error(`Task not found after lease-loss transition: ${input.taskId}`)
    const statusEvent = appendTaskEventWithClient(tx, input.taskId, 'status.changed', {
      status: 'stale',
      errorCode: 'task_lease_lost',
      errorMessage: `Task lease was lost during ${input.source}; uncommitted non-resumable work was stopped.`,
    })
    return { task, diagnostic, statusEvent }
  })

  if (!result) return null
  taskEventBus.notifyTaskEventAdded(input.taskId, result.diagnostic)
  if (result.statusEvent) {
    taskEventBus.notifyTaskEventAdded(input.taskId, result.statusEvent)
    taskEventBus.notifyTaskChanged(result.task, 'status:stale')
  }
  return result.task
}

function transitionTaskInternal(
  id: number,
  status: CreationTaskStatus,
  input: TransitionTaskInput,
  workerLease?: WorkerLease,
  observedLease?: ObservedLease,
): CreationTask | null {
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
      updates.leaseToken = null
      updates.leaseExpiresAt = null
    }
    if (status === 'succeeded') updates.cancelRequested = false
    if (status === 'queued' || status === 'stale') {
      updates.leaseOwner = null
      updates.leaseToken = null
      updates.leaseExpiresAt = null
    }
    if (input.result !== undefined) updates.resultJson = stringifyJson(input.result)
    if (input.progressCurrent !== undefined) updates.progressCurrent = input.progressCurrent
    if (input.progressTotal !== undefined) updates.progressTotal = input.progressTotal
    if (input.progressMessage !== undefined) updates.progressMessage = input.progressMessage
    if (input.errorCode !== undefined) updates.errorCode = input.errorCode
    if (input.errorMessage !== undefined) updates.errorMessage = input.errorMessage

    const where = workerLease
      ? currentWorkerLeaseWhere(id, workerLease.workerId, workerLease.leaseToken, ts)
      : observedLease
        ? observedRunningLeaseWhere(id, observedLease)
        : eq(schema.creationTasks.id, id)
    const updated = tx.update(schema.creationTasks).set(updates).where(where).run()
    if (updated.changes !== 1) return null

    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found: ${id}`)

    input.sync?.(tx, task)
    appendTaskEventWithClient(tx, id, 'status.changed', { status, ...input })

    return task
  })
  if (!result) return null
  taskEventBus.notifyTaskChanged(result, `status:${status}`)
  return result
}

export function updateTaskProgress(id: number, input: TaskProgressInput): CreationTask {
  const task = updateTaskProgressInternal(id, input)
  if (!task) throw new Error(`Task not found: ${id}`)
  return task
}

/** Drops stale worker progress rather than letting it overwrite the current lease owner. */
export function updateTaskProgressWithLease(
  id: number,
  workerId: string,
  leaseToken: string,
  input: TaskProgressInput,
): CreationTask | null {
  return updateTaskProgressInternal(id, input, { workerId, leaseToken })
}

function updateTaskProgressInternal(
  id: number,
  input: TaskProgressInput,
  workerLease?: WorkerLease,
): CreationTask | null {
  const result = db.transaction((tx) => {
    const ts = now()
    const updates: Partial<typeof schema.creationTasks.$inferInsert> = { updatedAt: ts }
    if (input.progressCurrent !== undefined) updates.progressCurrent = input.progressCurrent
    if (input.progressTotal !== undefined) updates.progressTotal = input.progressTotal
    if (input.progressMessage !== undefined) updates.progressMessage = input.progressMessage

    const where = workerLease
      ? currentWorkerLeaseWhere(id, workerLease.workerId, workerLease.leaseToken, ts)
      : eq(schema.creationTasks.id, id)
    const updated = tx.update(schema.creationTasks).set(updates).where(where).run()
    if (updated.changes !== 1) return null

    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found after progress update: ${id}`)
    const event = appendTaskEventWithClient(tx, id, 'progress', input)
    return { task, event }
  })
  if (!result) return null
  taskEventBus.notifyTaskEventAdded(id, result.event)
  taskEventBus.notifyTaskChanged(result.task, 'progress')
  return result.task
}

export function extendTaskLease(id: number, workerId: string, leaseToken: string, leaseMs: number): CreationTask | null {
  const ts = now()
  const leaseExpiresAt = new Date(Date.parse(ts) + leaseMs).toISOString()
  const result = db.transaction((tx) => {
    const updated = tx.update(schema.creationTasks)
      .set({ leaseExpiresAt, updatedAt: ts })
      .where(currentWorkerLeaseWhere(id, workerId, leaseToken, ts))
      .run()
    if (updated.changes !== 1) return null

    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found after heartbeat: ${id}`)
    const event = appendTaskEventWithClient(tx, id, 'heartbeat', { workerId, lease_token: leaseToken, leaseExpiresAt })
    return { task, event }
  })
  if (!result) return null
  taskEventBus.notifyTaskEventAdded(id, result.event)
  taskEventBus.notifyTaskChanged(result.task, 'heartbeat')
  return result.task
}

export function markTaskAttemptStarted(id: number): CreationTask {
  const task = markTaskAttemptStartedInternal(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  return task
}

export function markTaskAttemptStartedWithLease(id: number, workerId: string, leaseToken: string): CreationTask | null {
  return markTaskAttemptStartedInternal(id, { workerId, leaseToken })
}

function markTaskAttemptStartedInternal(id: number, workerLease?: WorkerLease): CreationTask | null {
  const result = db.transaction((tx) => {
    const task = getTaskWithClient(tx, id)
    if (!task) return null
    const ts = now()
    const attempts = task.attempts + 1
    const where = workerLease
      ? currentWorkerLeaseWhere(id, workerLease.workerId, workerLease.leaseToken, ts)
      : eq(schema.creationTasks.id, id)
    const updated = tx.update(schema.creationTasks).set({
      attempts,
      updatedAt: ts,
    }).where(where).run()
    if (updated.changes !== 1) return null

    const updatedTask = getTaskWithClient(tx, id)
    if (!updatedTask) throw new Error(`Task not found after attempt start: ${id}`)
    const event = appendTaskEventWithClient(tx, id, 'attempt.started', {
      attempts,
      maxAttempts: task.maxAttempts,
    })
    return { task: updatedTask, event }
  })
  if (!result) return null
  taskEventBus.notifyTaskEventAdded(id, result.event)
  return result.task
}

export function scheduleTaskRetry(
  id: number,
  error: Error,
  retryReason?: string,
  scheduledAt?: string,
  sync?: (tx: TransactionClient, task: CreationTask) => void,
): CreationTask {
  const result = scheduleTaskRetryInternal(id, error, retryReason, scheduledAt, sync)
  if (!result) throw new Error(`Task not found: ${id}`)
  return result
}

export function scheduleTaskRetryWithLease(
  id: number,
  workerId: string,
  leaseToken: string,
  error: Error,
  retryReason?: string,
  scheduledAt?: string,
  sync?: (tx: TransactionClient, task: CreationTask) => void,
): CreationTask | null {
  return scheduleTaskRetryInternal(id, error, retryReason, scheduledAt, sync, { workerId, leaseToken })
}

function scheduleTaskRetryInternal(
  id: number,
  error: Error,
  retryReason?: string,
  scheduledAt?: string,
  sync?: (tx: TransactionClient, task: CreationTask) => void,
  workerLease?: WorkerLease,
): CreationTask | null {
  const result = db.transaction((tx) => {
    const task = getTaskWithClient(tx, id)
    if (!task) return null
    const ts = now()
    const updated = tx.update(schema.creationTasks).set({
      status: 'queued',
      errorMessage: error.message,
      retryReason: retryReason ?? null,
      scheduledAt: scheduledAt ?? null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: ts,
    }).where(workerLease
      ? currentWorkerLeaseWhere(id, workerLease.workerId, workerLease.leaseToken, ts)
      : eq(schema.creationTasks.id, id)).run()
    if (updated.changes !== 1) return null

    const updatedTask = getTaskWithClient(tx, id)
    if (!updatedTask) throw new Error(`Task not found after retry schedule: ${id}`)

    sync?.(tx, updatedTask)
    appendTaskEventWithClient(tx, id, 'retry.scheduled', {
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      retryReason: retryReason ?? null,
      scheduledAt: scheduledAt ?? null,
      error: error.message,
    })

    return updatedTask
  })
  if (!result) return null
  taskEventBus.notifyTaskChanged(result, 'retry.scheduled')
  return result
}

export function appendTaskEvent(taskId: number, eventType: string, data?: unknown): CreationTaskEvent {
  const event = appendTaskEventWithClient(db, taskId, eventType, data)
  taskEventBus.notifyTaskEventAdded(taskId, event)
  return event
}

/** A handler may only append execution telemetry while it still owns the lease. */
export function appendTaskEventWithLease(
  taskId: number,
  workerId: string,
  leaseToken: string,
  eventType: string,
  data?: unknown,
): CreationTaskEvent | null {
  const event = db.transaction((tx) => {
    const ts = now()
    const retained = tx.update(schema.creationTasks)
      .set({ updatedAt: ts })
      .where(currentWorkerLeaseWhere(taskId, workerId, leaseToken, ts))
      .run()
    if (retained.changes !== 1) return null
    return appendTaskEventWithClient(tx, taskId, eventType, data)
  })
  if (event) taskEventBus.notifyTaskEventAdded(taskId, event)
  return event
}

export function listTaskEvents(taskId: number, options: TaskEventListOptions = {}): CreationTaskEvent[] {
  if (options.afterId !== undefined && (!Number.isSafeInteger(options.afterId) || options.afterId < 0)) {
    throw new RangeError('afterId must be a non-negative safe integer')
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new RangeError('limit must be a positive safe integer')
  }

  const where = options.afterId === undefined
    ? eq(schema.creationTaskEvents.taskId, taskId)
    : and(
        eq(schema.creationTaskEvents.taskId, taskId),
        sql`${schema.creationTaskEvents.id} > ${options.afterId}`,
      )
  const query = db.select().from(schema.creationTaskEvents)
    .where(where)
    .orderBy(asc(schema.creationTaskEvents.id))
  const limit = options.limit === undefined
    ? undefined
    : Math.min(options.limit, TASK_EVENT_LIST_MAX_LIMIT)
  const rows = limit === undefined ? query.all() : query.limit(limit).all()
  return rows.map(normalizeEvent)
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

function normalizedCancelText(value?: string | null) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function auditCancelText(value: string | null, maxLength: number) {
  return value ? value.slice(0, maxLength) : null
}

/** Formal full-episode Dharma renders need explicit cancellation confirmation in every active state. */
export function isFormalDharmaRender(task: CreationTask) {
  if (task.type !== 'dharma.episode_render') return false
  return isFormalDharmaRenderPayload(task.payload, task.episodeId ?? undefined)
}

function buildCancelEventData(
  input: TaskCancellationRequest,
  requiresConfirmation: boolean,
  confirmationAccepted: boolean,
) {
  const reason = normalizedCancelText(input.reason)
  const actor = normalizedCancelText(input.actor)
  return {
    reason: auditCancelText(reason, TASK_CANCEL_REASON_MAX_LENGTH),
    confirmation: {
      required: requiresConfirmation,
      confirmed: confirmationAccepted,
    },
    declared_actor: auditCancelText(actor, TASK_CANCEL_ACTOR_MAX_LENGTH),
    source: auditCancelText(normalizedCancelText(input.source), 512),
    user_agent: auditCancelText(normalizedCancelText(input.userAgent), 512),
    forwarded_for: auditCancelText(normalizedCancelText(input.forwardedFor), 512),
    real_ip: auditCancelText(normalizedCancelText(input.realIp), 128),
  }
}

/**
 * Linearizes the point where a task may make an irreversible delivery. A
 * cancellation may win before this transaction, or publishing may win inside
 * it; they cannot both claim success across backend processes.
 */
export function claimTaskCommitPoint(
  id: number,
  input: ClaimTaskCommitPointInput,
): TaskCommitClaimResult {
  const result: TaskCommitClaimResult = db.transaction((tx) => {
    const task = getTaskWithClient(tx, id)
    if (!task) return { outcome: 'not_found', task: null }
    if (task.status !== 'running') return { outcome: 'not_running', task }
    if (task.leaseOwner !== input.workerId) return { outcome: 'lease_lost', task }
    if (task.leaseToken !== input.leaseToken) return { outcome: 'lease_lost', task }
    const claimedAt = now()
    if (!hasCurrentWorkerLease(task, input.workerId, input.leaseToken, claimedAt)) return { outcome: 'lease_lost', task }
    if (task.cancelRequested) return { outcome: 'cancel_requested', task }
    if (task.commitClaimedAt) return { outcome: 'already_claimed', task }

    const claimed = tx.update(schema.creationTasks)
      .set({ commitClaimedAt: claimedAt, updatedAt: claimedAt })
      .where(and(
        currentWorkerLeaseWhere(id, input.workerId, input.leaseToken, claimedAt),
        eq(schema.creationTasks.cancelRequested, false),
        isNull(schema.creationTasks.commitClaimedAt),
      ))
      .run()
    if (claimed.changes !== 1) {
      const latest = getTaskWithClient(tx, id)
      if (!latest) return { outcome: 'not_found', task: null }
      if (latest.status !== 'running') return { outcome: 'not_running', task: latest }
      if (latest.leaseOwner !== input.workerId) return { outcome: 'lease_lost', task: latest }
      if (latest.leaseToken !== input.leaseToken) return { outcome: 'lease_lost', task: latest }
      if (!hasCurrentWorkerLease(latest, input.workerId, input.leaseToken, claimedAt)) return { outcome: 'lease_lost', task: latest }
      if (latest.cancelRequested) return { outcome: 'cancel_requested', task: latest }
      return { outcome: 'already_claimed', task: latest }
    }

    const updated = getTaskWithClient(tx, id)
    if (!updated) throw new Error(`Task not found after commit claim: ${id}`)
    input.validate?.(tx, updated)
    appendTaskEventWithClient(tx, id, 'commit.claimed', {
      worker_id: input.workerId,
      claimed_at: claimedAt,
    })
    return { outcome: 'claimed', task: updated }
  })

  if (result.outcome === 'claimed' && result.task) {
    taskEventBus.notifyTaskChanged(result.task, 'commit.claimed')
  }
  return result
}

/**
 * Runs a publish-pointer mutation only while the caller still owns a claimed
 * delivery. The conditional write takes SQLite's transaction lock before the
 * callback touches domain data, so lease recovery cannot interleave between a
 * stale-worker check and an episode metadata update.
 */
export function mutateClaimedTaskCommit(
  id: number,
  workerId: string,
  leaseToken: string,
  mutate: (tx: TransactionClient, task: CreationTask) => void,
): CreationTask | null {
  const result = db.transaction((tx) => {
    const ts = now()
    const retained = tx.update(schema.creationTasks)
      .set({ updatedAt: ts })
      .where(and(
        currentWorkerLeaseWhere(id, workerId, leaseToken, ts),
        isNotNull(schema.creationTasks.commitClaimedAt),
      ))
      .run()
    if (retained.changes !== 1) return null

    const task = getTaskWithClient(tx, id)
    if (!task) throw new Error(`Task not found after commit lease check: ${id}`)
    mutate(tx, task)
    return task
  })

  if (result) taskEventBus.notifyTaskChanged(result, 'commit.mutated')
  return result
}

export function requestCancel(
  id: number,
  input: TaskCancellationRequest = {},
): TaskCancellationResult {
  const result: TaskCancellationResult = db.transaction((tx) => {
    const task = getTaskWithClient(tx, id)
    if (!task) return { outcome: 'not_found', task: null }
    if (!ACTIVE_STATUSES.has(task.status)) return { outcome: 'not_active', task }
    if (task.commitClaimedAt) return { outcome: 'commit_claimed', task }
    if (task.cancelRequested) return { outcome: 'already_requested', task }

    const requiresConfirmation = isFormalDharmaRender(task)
    const reason = normalizedCancelText(input.reason)
    const actor = normalizedCancelText(input.actor)
    const confirmationAccepted = input.confirmation === `CANCEL ${task.id}`

    if (requiresConfirmation) {
      if (!reason) return { outcome: 'reason_required', task }
      if (reason.length > TASK_CANCEL_REASON_MAX_LENGTH) return { outcome: 'reason_too_long', task }
      if (!confirmationAccepted) return { outcome: 'confirmation_required', task }
      if (!actor) return { outcome: 'actor_required', task }
      if (actor.length > TASK_CANCEL_ACTOR_MAX_LENGTH) return { outcome: 'actor_too_long', task }
    }

    const ts = now()
    tx.update(schema.creationTasks)
      .set({ cancelRequested: true, updatedAt: ts })
      .where(eq(schema.creationTasks.id, id))
      .run()
    const updated = getTaskWithClient(tx, id)
    if (!updated) throw new Error(`Task not found: ${id}`)
    appendTaskEventWithClient(tx, id, 'cancel.requested', buildCancelEventData(
      input,
      requiresConfirmation,
      confirmationAccepted,
    ))
    return { outcome: 'requested', task: updated }
  })

  if (result.outcome === 'requested' && result.task) {
    taskEventBus.notifyTaskChanged(result.task, 'cancel.requested')
  }
  return result
}

/**
 * Records an operator's resolution of a stale Dharma delivery claim. The
 * claim timestamp is retained forever; only the `reconciliation_required`
 * gate changes, and the decision is appended as a task event in the same
 * transaction. Callers may validate the episode pointer through `input` so a
 * stale snapshot cannot authorize an unsafe replacement render.
 */
export function reconcileDharmaCommitClaim(
  id: number,
  input: DharmaCommitReconciliationInput,
): DharmaCommitReconciliationResult {
  const result = db.transaction((tx) => {
    const task = getTaskWithClient(tx, id)
    if (!task) return { outcome: 'not_found' as const, task: null, event: null }
    if (
      task.type !== 'dharma.episode_render'
      || task.episodeId !== input.episodeId
      || task.status !== 'stale'
      || !task.commitClaimedAt
      || task.errorCode !== 'task_commit_claimed_reconciliation_required'
    ) {
      return { outcome: 'not_reconcilable' as const, task, event: null }
    }

    const pointerMatchesOutput = input.validate(tx, task)
    const ts = now()
    const updated = tx.update(schema.creationTasks)
      .set({
        errorCode: 'task_commit_claimed_reconciled',
        errorMessage: `Dharma delivery reconciliation completed: ${input.resolution}`,
        updatedAt: ts,
      })
      .where(and(
        eq(schema.creationTasks.id, id),
        eq(schema.creationTasks.type, 'dharma.episode_render'),
        eq(schema.creationTasks.episodeId, input.episodeId),
        eq(schema.creationTasks.status, 'stale'),
        isNotNull(schema.creationTasks.commitClaimedAt),
        eq(schema.creationTasks.errorCode, 'task_commit_claimed_reconciliation_required'),
      ))
      .run()
    if (updated.changes !== 1) {
      const latest = getTaskWithClient(tx, id)
      return { outcome: latest ? 'not_reconcilable' as const : 'not_found' as const, task: latest, event: null }
    }

    const reconciled = getTaskWithClient(tx, id)
    if (!reconciled) throw new Error(`Task not found after Dharma reconciliation: ${id}`)
    const event = appendTaskEventWithClient(tx, id, 'dharma.episode.render.reconciled', {
      resolution: input.resolution,
      reason: input.reason,
      declared_actor: input.actor,
      expected_output: input.expectedOutput,
      pointer_matches_output: pointerMatchesOutput,
    })
    return { outcome: 'reconciled' as const, task: reconciled, event }
  })

  if (result.outcome === 'reconciled' && result.task && result.event) {
    taskEventBus.notifyTaskEventAdded(id, result.event)
    taskEventBus.notifyTaskChanged(result.task, 'dharma.reconciled')
  }
  return { outcome: result.outcome, task: result.task }
}
