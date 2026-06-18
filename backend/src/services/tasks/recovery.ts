import { getTaskHandler } from './registry.js'
import { listTasks, transitionTask } from './store.js'

export interface RecoverExpiredRunningTasksOptions {
  nowMs?: number
  expiredBeforeMs?: number
}

export function recoverExpiredRunningTasks(options: RecoverExpiredRunningTasksOptions = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const expiredBeforeMs = options.expiredBeforeMs ?? nowMs
  let requeued = 0
  let markedStale = 0
  let skipped = 0

  for (const task of listTasks({ status: 'running' })) {
    const leaseMs = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : null
    const expired = leaseMs == null || leaseMs <= expiredBeforeMs
    if (!expired) {
      skipped += 1
      continue
    }

    const handler = getTaskHandler(task.type)
    if (handler?.resumable) {
      transitionTask(task.id, 'queued', {
        progressMessage: 'Recovered expired running task for retry.',
      })
      requeued += 1
    } else {
      transitionTask(task.id, 'stale', {
        errorCode: handler ? 'task_not_resumable' : 'handler_missing',
        errorMessage: handler
          ? 'Task handler is not resumable after lease expiry.'
          : `No task handler registered for ${task.type}.`,
      })
      markedStale += 1
    }
  }

  return {
    recovered_at: new Date(nowMs).toISOString(),
    requeued,
    markedStale,
    skipped,
  }
}
