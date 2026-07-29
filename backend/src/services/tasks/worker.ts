import {
  acquireNextQueuedTask,
  appendTaskEventWithLease,
  extendTaskLease,
  getTask,
  markTaskAttemptStartedWithLease,
  recordTaskLeaseLoss,
  scheduleTaskRetryWithLease,
  transitionTaskWithLease,
  updateTaskProgressWithLease,
} from './store.js'
import { getTaskHandler, listRegisteredTaskTypes } from './registry.js'
import { recoverExpiredRunningTasks } from './recovery.js'
import { db } from '../../db/index.js'
import { logTaskError } from '../../utils/task-logger.js'
import { classifyImageError, computeRetryDelay } from '../../utils/error-taxonomy.js'
import { reconcileImageGenerationState, syncImageGenerationTaskState } from '../image-generation-sync.js'
import {
  getHeartbeatIntervalMs,
  pruneStaleWorkerHeartbeats,
  recordWorkerHeartbeat,
  removeWorkerHeartbeat,
} from './heartbeat.js'
import type { CreationTask, TaskContext, TransitionTaskInput } from './types.js'

const RECONCILE_INTERVAL_MS = 30_000
const WORKER_RECOVERY_INTERVAL_MS = 60_000

export interface RunWorkerOnceOptions {
  workerId: string
  leaseMs?: number
  heartbeatMs?: number
  cancelPollMs?: number
  signal?: AbortSignal
  nowMs?: number
  types?: string[]
}

/**
 * Progress and event reporters are often invoked from child-process/timer
 * callbacks. Telemetry persistence must not throw out of those callbacks and
 * take down the worker process; a definite lease loss remains a hard stop.
 */
function persistTaskTelemetry(
  task: CreationTask,
  kind: 'progress' | 'event',
  persist: () => unknown | null,
  onLeaseLost: (source: 'progress' | 'event') => void,
): void {
  try {
    if (!persist()) onLeaseLost(kind)
  } catch (error) {
    try {
      logTaskError('Worker', 'task-telemetry-persistence-failed', {
        taskId: task.id,
        type: task.type,
        telemetry: kind,
        errorMessage: error instanceof Error ? error.message : 'Unknown telemetry persistence error',
      })
    } catch {
      // Logging is best effort too; this boundary must never throw to a callback.
    }
  }
}

function createTaskContext(
  task: CreationTask,
  signal: AbortSignal,
  commitState: { passed: boolean },
  workerId: string,
  leaseToken: string,
  onLeaseLost: (source: 'progress' | 'event') => void,
): TaskContext {
  return {
    taskId: task.id,
    workerId,
    leaseToken,
    episodeId: task.episodeId,
    payload: task.payload,
    signal,
    attempts: task.attempts,
    progress(message, current, total) {
      persistTaskTelemetry(task, 'progress', () => updateTaskProgressWithLease(task.id, workerId, leaseToken, {
        progressMessage: message,
        progressCurrent: current,
        progressTotal: total,
      }), onLeaseLost)
    },
    event(type, data) {
      persistTaskTelemetry(task, 'event', () => (
        appendTaskEventWithLease(task.id, workerId, leaseToken, type, data)
      ), onLeaseLost)
    },
    isCancelRequested() {
      return Boolean(getTask(task.id)?.cancelRequested)
    },
    markCommitPoint() {
      commitState.passed = true
    },
    hasPassedCommitPoint() {
      return commitState.passed
    },
  }
}

function createImageSyncCallback(task: CreationTask): TransitionTaskInput['sync'] {
  if (task.type !== 'image.generate') return undefined
  return (tx, updatedTask) => syncImageGenerationTaskState(tx, updatedTask)
}

function withImageSync(task: CreationTask, input: Omit<TransitionTaskInput, 'sync'>): TransitionTaskInput {
  return { ...input, sync: createImageSyncCallback(task) }
}

export async function runWorkerOnce(options: RunWorkerOnceOptions): Promise<boolean> {
  const leaseMs = options.leaseMs ?? 60_000
  const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(leaseMs / 2))
  const cancelPollMs = options.cancelPollMs ?? 1_000
  const handlers = options.types ?? listRegisteredTaskTypes()
  if (!handlers.length) return false
  const task = acquireNextQueuedTask({
    workerId: options.workerId,
    leaseMs,
    nowMs: options.nowMs,
    types: handlers,
  })
  if (!task) return false
  const leaseToken = task.leaseToken
  if (!leaseToken) {
    // A tokenless claim cannot prove it still owns the row. Do not perform an
    // unconditional terminal write here: recovery will handle it after expiry.
    logTaskError('Worker', 'lease-token-missing', {
      taskId: task.id,
      type: task.type,
      workerId: options.workerId,
    })
    return true
  }

  // acquireNextQueuedTask changes the task row to running directly. Mirror
  // that transition immediately so Remotion asset polling does not remain at
  // queued while the provider request is already in flight.
  syncImageGenerationTaskState(db, task)

  const handler = getTaskHandler(task.type)
  if (!handler) {
    transitionTaskWithLease(task.id, options.workerId, leaseToken, 'queued', withImageSync(task, {
      progressMessage: `No task handler registered for ${task.type}`,
    }))
    return false
  }

  const maxAttempts = Math.max(task.maxAttempts, handler.maxAttempts ?? 1)

  if (task.cancelRequested) {
    transitionTaskWithLease(task.id, options.workerId, leaseToken, 'canceled', withImageSync(task, {
      progressMessage: 'Canceled before execution.',
    }))
    return true
  }

  const controller = new AbortController()
  const abortFromParent = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) controller.abort(options.signal.reason)
  else options.signal?.addEventListener('abort', abortFromParent, { once: true })
  const abortForCancel = () => {
    if (!controller.signal.aborted) controller.abort(new Error('Task cancel requested'))
  }
  const leaseState = { lost: false }
  const abortForLeaseLoss = (source: string) => {
    if (!leaseState.lost) {
      leaseState.lost = true
      try {
        recordTaskLeaseLoss({
          taskId: task.id,
          workerId: options.workerId,
          leaseToken,
          source,
          nonResumable: !handler.resumable,
        })
      } catch (error) {
        try {
          logTaskError('Worker', 'task-lease-loss-diagnostic-failed', {
            taskId: task.id,
            type: task.type,
            source,
            errorMessage: error instanceof Error ? error.message : 'Unknown task lease-loss diagnostic error',
          })
        } catch {
          // This can be reached from child-process callbacks; diagnostics cannot throw there.
        }
      }
    }
    if (!controller.signal.aborted) controller.abort(new Error('Task lease lost'))
  }
  const abortForLeaseMonitorFailure = (monitor: 'heartbeat' | 'cancel_poll', error: unknown) => {
    try {
      logTaskError('Worker', 'task-lease-monitor-failed', {
        taskId: task.id,
        type: task.type,
        monitor,
        errorMessage: error instanceof Error ? error.message : 'Unknown task lease monitor error',
      })
    } catch {
      // Diagnostics must not become another timer-callback exception.
    }
    abortForLeaseLoss(`${monitor}_persistence_failure`)
  }

  const heartbeat = setInterval(() => {
    try {
      if (!extendTaskLease(task.id, options.workerId, leaseToken, leaseMs)) abortForLeaseLoss('heartbeat')
    } catch (error) {
      abortForLeaseMonitorFailure('heartbeat', error)
    }
  }, heartbeatMs)
  const cancelPoll = setInterval(() => {
    try {
      if (getTask(task.id)?.cancelRequested) abortForCancel()
    } catch (error) {
      abortForLeaseMonitorFailure('cancel_poll', error)
    }
  }, cancelPollMs)

  const commitState = { passed: false }
  try {
    const taskAfterMark = markTaskAttemptStartedWithLease(task.id, options.workerId, leaseToken)
    if (!taskAfterMark) {
      abortForLeaseLoss('attempt_start')
      return true
    }
    const ctx = createTaskContext(
      taskAfterMark,
      controller.signal,
      commitState,
      options.workerId,
      leaseToken,
      abortForLeaseLoss,
    )
    const result = await handler.run(ctx)
    if (leaseState.lost) return true
    const latest = getTask(task.id)
    if (
      !latest
      || latest.status !== 'running'
      || latest.leaseOwner !== options.workerId
      || latest.leaseToken !== leaseToken
    ) return true
    if (latest.cancelRequested && !commitState.passed) {
      transitionTaskWithLease(task.id, options.workerId, leaseToken, 'canceled', withImageSync(task, {
        progressMessage: 'Canceled during execution.',
      }))
    } else {
      transitionTaskWithLease(task.id, options.workerId, leaseToken, 'succeeded', withImageSync(task, { result }))
    }
  } catch (err: any) {
    if (leaseState.lost) return true
    const latest = getTask(task.id)
    const error = err instanceof Error ? err : new Error(String(err))
    const classification = classifyImageError(error)

    logTaskError('Worker', 'task-failed', {
      taskId: task.id,
      type: task.type,
      attempts: latest?.attempts ?? task.attempts,
      maxAttempts,
      errorCode: classification.code,
      errorMessage: error.message,
    })

    if (
      !latest
      || latest.status !== 'running'
      || latest.leaseOwner !== options.workerId
      || latest.leaseToken !== leaseToken
    ) return true
    if (latest.cancelRequested && !commitState.passed) {
      transitionTaskWithLease(task.id, options.workerId, leaseToken, 'canceled', withImageSync(task, {
        progressMessage: 'Canceled during execution.',
      }))
    } else if (latest && latest.attempts < maxAttempts) {
      if (classification.retryable) {
        const delayMs = computeRetryDelay(classification.code, latest.attempts)
        const scheduledAt = new Date(Date.now() + delayMs).toISOString()
        scheduleTaskRetryWithLease(task.id, options.workerId, leaseToken, error, classification.code, scheduledAt, createImageSyncCallback(task))
      } else {
        transitionTaskWithLease(task.id, options.workerId, leaseToken, 'failed', withImageSync(task, {
          errorCode: classification.code,
          errorMessage: error.message,
        }))
      }
    } else {
      transitionTaskWithLease(task.id, options.workerId, leaseToken, 'failed', withImageSync(task, {
        errorCode: classification.code,
        errorMessage: error.message,
      }))
    }
  } finally {
    clearInterval(heartbeat)
    clearInterval(cancelPoll)
    options.signal?.removeEventListener('abort', abortFromParent)
  }

  return true
}

export interface TaskWorkerLoopOptions extends RunWorkerOnceOptions {
  intervalMs?: number
  concurrency?: number
  recoverOnStart?: boolean
  onError?: (error: unknown) => void
  /**
   * If provided, this worker pool only processes the listed task types.
   * Defaults to all registered task types.
   */
  types?: string[]
  /**
   * If false, this pool does not run global maintenance (expired-task recovery,
   * heartbeat pruning, image-generation reconciliation). Use this for secondary
   * pools so maintenance jobs do not run multiple times.
   */
  runMaintenance?: boolean
}

export function startTaskWorkerLoop(options: TaskWorkerLoopOptions) {
  const intervalMs = options.intervalMs ?? 1_000
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
  const runMaintenance = options.runMaintenance !== false
  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let reconcileTimer: ReturnType<typeof setInterval> | null = null
  let workerHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let workerRecoveryTimer: ReturnType<typeof setInterval> | null = null
  const workerIds = Array.from({ length: concurrency }, (_value, lane) =>
    concurrency === 1 ? options.workerId : `${options.workerId}-${lane + 1}`,
  )
  const shutdownController = new AbortController()
  const inFlight = new Set<Promise<void>>()

  for (const workerId of workerIds) recordWorkerHeartbeat(workerId)

  workerHeartbeatTimer = setInterval(() => {
    if (stopped) return
    for (const workerId of workerIds) recordWorkerHeartbeat(workerId)
  }, getHeartbeatIntervalMs())

  if (runMaintenance && options.recoverOnStart !== false) {
    recoverExpiredRunningTasks()
  }

  if (runMaintenance) {
    reconcileTimer = setInterval(() => {
      if (stopped) return
      try {
        reconcileImageGenerationState()
      } catch (error) {
        options.onError?.(error)
      }
    }, RECONCILE_INTERVAL_MS)

    workerRecoveryTimer = setInterval(() => {
      if (stopped) return
      try {
        pruneStaleWorkerHeartbeats()
        recoverExpiredRunningTasks()
      } catch (error) {
        options.onError?.(error)
      }
    }, WORKER_RECOVERY_INTERVAL_MS)
  }

  const tick = async (lane: number) => {
    if (stopped) return
    const runPromise: Promise<void> = runWorkerOnce({
      ...options,
      workerId: workerIds[lane],
      signal: shutdownController.signal,
    }).then(
      () => {},
      (error) => { options.onError?.(error) },
    )
    inFlight.add(runPromise)
    try {
      await runPromise
    } finally {
      inFlight.delete(runPromise)
    }
    if (stopped) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      void tick(lane)
    }, intervalMs)
    timers.add(timer)
  }

  for (let lane = 0; lane < concurrency; lane++) {
    void tick(lane)
  }

  return {
    stop(timeoutMs = 120_000) {
      return new Promise<void>((resolve) => {
        if (stopped) {
          resolve()
          return
        }
        stopped = true
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        if (reconcileTimer) clearInterval(reconcileTimer)
        if (workerHeartbeatTimer) clearInterval(workerHeartbeatTimer)
        if (workerRecoveryTimer) clearInterval(workerRecoveryTimer)

        const finalize = () => {
          for (const workerId of workerIds) removeWorkerHeartbeat(workerId)
          resolve()
        }

        if (inFlight.size === 0) {
          finalize()
          return
        }

        const interval = setInterval(() => {
          if (inFlight.size === 0) {
            clearInterval(interval)
            clearTimeout(timeout)
            finalize()
          }
        }, 50)

        const timeout = setTimeout(() => {
          clearInterval(interval)
          shutdownController.abort(new Error(`Worker shutdown timeout after ${timeoutMs}ms`))
          // Give in-flight handlers a short grace period to abort and transition state.
          const grace = setTimeout(() => {
            finalize()
          }, 3_000)
        }, timeoutMs)
      })
    },
  }
}
