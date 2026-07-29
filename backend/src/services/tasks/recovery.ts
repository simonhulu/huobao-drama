import { getTaskHandler } from './registry.js'
import { listTasks, transitionTaskWithExpiredLease } from './store.js'

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
    const leaseMs = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : Number.NaN
    const expired = !Number.isFinite(leaseMs) || leaseMs <= expiredBeforeMs
    if (!expired) {
      skipped += 1
      continue
    }

    // A commit claim is an irreversible boundary: retrying the task after a
    // crash could publish a second delivery. Keep the claim for audit, clear
    // the active lease through the stale transition, and require explicit
    // reconciliation before anyone starts a replacement task.
    if (task.commitClaimedAt) {
      const transitioned = transitionTaskWithExpiredLease(task, 'stale', {
        errorCode: 'task_commit_claimed_reconciliation_required',
        errorMessage: 'Task lease expired after its commit point was claimed; automatic retry is forbidden and delivery reconciliation is required.',
      }, expiredBeforeMs)
      if (transitioned) markedStale += 1
      else skipped += 1
      continue
    }

    const handler = getTaskHandler(task.type)
    if (handler?.resumable) {
      const maxAttempts = Math.max(task.maxAttempts, handler.maxAttempts ?? 1)
      if (task.attempts >= maxAttempts) {
        const transitioned = transitionTaskWithExpiredLease(task, 'stale', {
          errorCode: 'task_retry_limit_exceeded',
          errorMessage: `Task lease expired after ${task.attempts} attempts (maximum ${maxAttempts}); automatic retry is forbidden.`,
        }, expiredBeforeMs)
        if (transitioned) markedStale += 1
        else skipped += 1
      } else {
        const transitioned = transitionTaskWithExpiredLease(task, 'queued', {
          progressMessage: 'Recovered expired running task for retry.',
        }, expiredBeforeMs)
        if (transitioned) requeued += 1
        else skipped += 1
      }
    } else {
      const transitioned = transitionTaskWithExpiredLease(task, 'stale', {
        errorCode: handler ? 'task_not_resumable' : 'handler_missing',
        errorMessage: handler
          ? 'Task handler is not resumable after lease expiry.'
          : `No task handler registered for ${task.type}.`,
      }, expiredBeforeMs)
      if (transitioned) markedStale += 1
      else skipped += 1
    }
  }

  return {
    recovered_at: new Date(nowMs).toISOString(),
    requeued,
    markedStale,
    skipped,
  }
}
