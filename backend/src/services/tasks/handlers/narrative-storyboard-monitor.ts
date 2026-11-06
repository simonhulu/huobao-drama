import { getNarrativeStoryboardProgress, type NarrativeStoryboardProgress } from '../../narrative-storyboard-progress.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface NarrativeStoryboardMonitorPayload {
  project_id?: number
  projectId?: number
}

interface MonitorDependencies {
  readProgress?: (projectId: number) => NarrativeStoryboardProgress
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

const POLL_INTERVAL_MS = 4_000
const BLOCKED_GRACE_MS = 120_000

function readProjectId(payload: NarrativeStoryboardMonitorPayload) {
  return Number(payload.project_id ?? payload.projectId)
}

function waitWithAbort(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms)
    function done() {
      clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function progressMessage(progress: NarrativeStoryboardProgress) {
  return `故事版画格 ${progress.completed}/${progress.productionPanels}，在途 ${progress.processing}，失败 ${progress.failed}，待提交 ${progress.pending}`
}

export function createNarrativeStoryboardMonitorHandler(
  dependencies: MonitorDependencies = {},
): TaskHandler<NarrativeStoryboardMonitorPayload> {
  const readProgress = dependencies.readProgress || getNarrativeStoryboardProgress
  const wait = dependencies.wait || waitWithAbort
  const now = dependencies.now || Date.now

  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<NarrativeStoryboardMonitorPayload>) {
      const projectId = readProjectId(ctx.payload)
      if (!projectId) throw new Error('project_id is required')

      let lastSignature = ''
      let blockedSince: number | null = null
      while (!ctx.signal.aborted) {
        let progress: NarrativeStoryboardProgress
        try {
          progress = readProgress(projectId)
        } catch (error) {
          if (error instanceof SyntaxError) {
            ctx.event('remotion.narrative_storyboard.state_read_retry', { project_id: projectId })
            await wait(POLL_INTERVAL_MS, ctx.signal)
            continue
          }
          throw error
        }
        if (!progress.available || progress.productionPanels == null || progress.completed == null) {
          throw new Error(`Project ${projectId} has no narrative storyboard production plan`)
        }

        const signature = [progress.completed, progress.processing, progress.failed, progress.pending, progress.status].join(':')
        const message = progressMessage(progress)
        ctx.progress(message, progress.completed, progress.productionPanels)
        if (signature !== lastSignature) {
          ctx.event('remotion.narrative_storyboard.progress', {
            project_id: projectId,
            completed: progress.completed,
            total: progress.productionPanels,
            processing: progress.processing,
            failed: progress.failed,
            pending: progress.pending,
            status: progress.status,
            active_panels: progress.activePanels?.map((panel) => panel.id) || [],
          })
          lastSignature = signature
        }

        if (progress.status === 'complete') {
          return {
            project_id: projectId,
            completed: progress.completed,
            total: progress.productionPanels,
          }
        }
        if (progress.status === 'blocked' && progress.processing === 0 && progress.pending === 0) {
          blockedSince ??= now()
          if (now() - blockedSince >= BLOCKED_GRACE_MS) {
            throw new Error(`Narrative storyboard production stopped with ${progress.failed} failed panels`)
          }
        } else {
          blockedSince = null
        }
        if (ctx.isCancelRequested()) {
          ctx.event('remotion.narrative_storyboard.monitor_canceled', { project_id: projectId })
          return { project_id: projectId, monitor_canceled: true }
        }

        await wait(POLL_INTERVAL_MS, ctx.signal)
      }

      return { project_id: projectId, monitor_canceled: true }
    },
  }
}

export function registerNarrativeStoryboardMonitorHandler() {
  registerTaskHandler('remotion.narrative_storyboard.monitor', createNarrativeStoryboardMonitorHandler())
}
