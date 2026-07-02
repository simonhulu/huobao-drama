import {
  acquireNextQueuedTask,
  appendTaskEvent,
  extendTaskLease,
  getTask,
  markTaskAttemptStarted,
  scheduleTaskRetry,
  transitionTask,
  updateTaskProgress,
} from './store.js'
import { getTaskHandler, listRegisteredTaskTypes } from './registry.js'
import { recoverExpiredRunningTasks } from './recovery.js'
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
}

function createTaskContext(task: CreationTask, signal: AbortSignal): TaskContext {
  return {
    taskId: task.id,
    payload: task.payload,
    signal,
    attempts: task.attempts,
    progress(message, current, total) {
      updateTaskProgress(task.id, {
        progressMessage: message,
        progressCurrent: current,
        progressTotal: total,
      })
    },
    event(type, data) {
      appendTaskEvent(task.id, type, data)
    },
    isCancelRequested() {
      return Boolean(getTask(task.id)?.cancelRequested)
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
  const handlers = listRegisteredTaskTypes()
  if (!handlers.length) return false
  const task = acquireNextQueuedTask({
    workerId: options.workerId,
    leaseMs,
    nowMs: options.nowMs,
    types: handlers,
  })
  if (!task) return false

  const handler = getTaskHandler(task.type)
  if (!handler) {
    transitionTask(task.id, 'queued', withImageSync(task, {
      progressMessage: `No task handler registered for ${task.type}`,
    }))
    return false
  }

  const maxAttempts = Math.max(task.maxAttempts, handler.maxAttempts ?? 1)

  if (task.cancelRequested) {
    transitionTask(task.id, 'canceled', withImageSync(task, {
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

  const heartbeat = setInterval(() => {
    extendTaskLease(task.id, options.workerId, leaseMs)
  }, heartbeatMs)
  const cancelPoll = setInterval(() => {
    if (getTask(task.id)?.cancelRequested) abortForCancel()
  }, cancelPollMs)

  try {
    const taskAfterMark = markTaskAttemptStarted(task.id)
    const ctx = createTaskContext(taskAfterMark, controller.signal)
    const result = await handler.run(ctx)
    if (getTask(task.id)?.cancelRequested) {
      transitionTask(task.id, 'canceled', withImageSync(task, {
        progressMessage: 'Canceled during execution.',
      }))
    } else {
      transitionTask(task.id, 'succeeded', withImageSync(task, { result }))
    }
  } catch (err: any) {
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

    if (latest?.cancelRequested) {
      transitionTask(task.id, 'canceled', withImageSync(task, {
        progressMessage: 'Canceled during execution.',
      }))
    } else if (latest && latest.attempts < maxAttempts) {
      if (classification.retryable) {
        const delayMs = computeRetryDelay(classification.code, latest.attempts)
        const scheduledAt = new Date(Date.now() + delayMs).toISOString()
        scheduleTaskRetry(task.id, error, classification.code, scheduledAt, createImageSyncCallback(task))
      } else {
        transitionTask(task.id, 'failed', withImageSync(task, {
          errorCode: classification.code,
          errorMessage: error.message,
        }))
      }
    } else {
      transitionTask(task.id, 'failed', withImageSync(task, {
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
}

export function startTaskWorkerLoop(options: TaskWorkerLoopOptions) {
  const intervalMs = options.intervalMs ?? 1_000
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
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

  if (options.recoverOnStart !== false) {
    recoverExpiredRunningTasks()
  }

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
