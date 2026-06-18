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
import type { CreationTask, TaskContext } from './types.js'

export interface RunWorkerOnceOptions {
  workerId: string
  leaseMs?: number
  heartbeatMs?: number
  cancelPollMs?: number
  signal?: AbortSignal
}

function createTaskContext(task: CreationTask, signal: AbortSignal): TaskContext {
  return {
    taskId: task.id,
    payload: task.payload,
    signal,
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

export async function runWorkerOnce(options: RunWorkerOnceOptions): Promise<boolean> {
  const leaseMs = options.leaseMs ?? 60_000
  const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(leaseMs / 2))
  const cancelPollMs = options.cancelPollMs ?? 1_000
  const handlers = listRegisteredTaskTypes()
  if (!handlers.length) return false
  const task = acquireNextQueuedTask({
    workerId: options.workerId,
    leaseMs,
    types: handlers,
  })
  if (!task) return false

  const handler = getTaskHandler(task.type)
  if (!handler) {
    transitionTask(task.id, 'queued', {
      progressMessage: `No task handler registered for ${task.type}`,
    })
    return false
  }

  if (task.cancelRequested) {
    transitionTask(task.id, 'canceled', {
      progressMessage: 'Canceled before execution.',
    })
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
    const ctx = createTaskContext(task, controller.signal)
    markTaskAttemptStarted(task.id)
    const result = await handler.run(ctx)
    if (getTask(task.id)?.cancelRequested) {
      transitionTask(task.id, 'canceled', {
        progressMessage: 'Canceled during execution.',
      })
    } else {
      transitionTask(task.id, 'succeeded', { result })
    }
  } catch (err: any) {
    const latest = getTask(task.id)
    const error = err instanceof Error ? err : new Error(String(err))
    if (latest?.cancelRequested) {
      transitionTask(task.id, 'canceled', {
        progressMessage: 'Canceled during execution.',
      })
    } else if (latest && latest.attempts < latest.maxAttempts) {
      scheduleTaskRetry(task.id, error)
    } else {
      transitionTask(task.id, 'failed', {
        errorCode: 'handler_failed',
        errorMessage: error.message,
      })
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
  recoverOnStart?: boolean
  onError?: (error: unknown) => void
}

export function startTaskWorkerLoop(options: TaskWorkerLoopOptions) {
  const intervalMs = options.intervalMs ?? 1_000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  if (options.recoverOnStart !== false) {
    recoverExpiredRunningTasks()
  }

  const tick = async () => {
    if (stopped) return
    try {
      await runWorkerOnce(options)
    } catch (error) {
      options.onError?.(error)
    }
    if (stopped) return
    timer = setTimeout(tick, intervalMs)
  }

  void tick()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
