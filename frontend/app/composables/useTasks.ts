import { computed, onBeforeUnmount, ref, unref, type MaybeRef } from 'vue'
import { toast } from 'vue-sonner'
import { healthAPI, taskAPI } from './useApi'
import {
  groupTasks,
  deriveDharmaRenderTelemetry,
  isActiveTask,
  isTaskRunningInList,
  latestTaskEventId,
  latestTaskInScope,
  mergeTaskEventHistory,
  mergeTaskListUpdate,
  taskErrorInList,
  taskProgressInfo,
  taskStatus,
  toRetryPayload,
  type CreationTaskEvent,
  type CreationTask,
  type DharmaRenderTelemetry,
  type TaskScopeMatcher,
} from './taskState'

interface UseTasksOptions {
  dramaId?: MaybeRef<number | null | undefined>
  episodeId?: MaybeRef<number | null | undefined>
  pollMs?: number
  enableStreaming?: boolean
  activeOnly?: boolean
}

export interface TaskCancelPayload {
  reason?: string
  confirmation?: string
  actor?: string
  controlToken?: string
}

const STREAM_RECONCILIATION_MIN_MS = 15_000

function optionValue(value: any) {
  return Number(unref(value) || 0)
}

function activeTaskIds(tasks: CreationTask[]) {
  return new Set(tasks.filter(isActiveTask).map(task => Number(task.id)))
}

export function useTasks(options: UseTasksOptions = {}) {
  const tasks = ref<CreationTask[]>([])
  const loading = ref(false)
  const error = ref('')
  const lastLoadedAt = ref<Date | null>(null)
  const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)
  const dharmaTelemetryTimer = ref<ReturnType<typeof setInterval> | null>(null)
  const streamReconciliationTimer = ref<ReturnType<typeof setInterval> | null>(null)
  const eventSource = ref<EventSource | null>(null)
  const streaming = ref(false)
  const streamFailed = ref(false)
  const workerHealth = ref<{ healthy_count: number; total_count: number; timeout_ms: number; workers: any[] } | null>(null)
  const workerHealthError = ref('')
  const telemetryByTaskId = ref<Record<number, DharmaRenderTelemetry>>({})
  const taskEventsByTaskId = ref<Record<number, CreationTaskEvent[]>>({})
  let dharmaTelemetryRequest: Promise<void> | null = null
  let streamReconciliationRequest: Promise<void> | null = null

  const grouped = computed(() => groupTasks(tasks.value))
  const activeTasks = computed(() => tasks.value.filter(isActiveTask))
  const failedTasks = computed(() => grouped.value.byStatus.failed.concat(grouped.value.byStatus.stale))
  const hasVisibleTasks = computed(() => tasks.value.length > 0)
  const activeCount = computed(() => grouped.value.activeCount)
  const failedCount = computed(() => grouped.value.failedCount)
  const isWorkerHealthy = computed(() => {
    if (!workerHealth.value) return true
    return workerHealth.value.healthy_count > 0
  })

  function activeDharmaRenderTasks(rows: CreationTask[]) {
    return rows.filter(task => (
      task.type === 'dharma.episode_render' && taskStatus(task) === 'running'
    ))
  }

  function refreshDharmaRenderTelemetry(rows: CreationTask[]) {
    const activeDharmaTasks = activeDharmaRenderTasks(rows)
    telemetryByTaskId.value = Object.fromEntries(
      activeDharmaTasks.flatMap(task => {
        const telemetry = deriveDharmaRenderTelemetry(
          task,
          taskEventsByTaskId.value[task.id] || [],
        )
        return telemetry ? [[task.id, telemetry] as const] : []
      }),
    )
  }

  async function loadDharmaRenderTelemetry(rows: CreationTask[]) {
    if (dharmaTelemetryRequest) return dharmaTelemetryRequest

    const request = (async () => {
      const activeDharmaTasks = activeDharmaRenderTasks(rows)
      if (!activeDharmaTasks.length) {
        telemetryByTaskId.value = {}
        taskEventsByTaskId.value = {}
        return
      }

      const activeIds = new Set(activeDharmaTasks.map(task => Number(task.id)))
      taskEventsByTaskId.value = Object.fromEntries(
        Object.entries(taskEventsByTaskId.value)
          .filter(([id]) => activeIds.has(Number(id))),
      )

      await Promise.all(activeDharmaTasks.map(async (task) => {
        try {
          const previous = taskEventsByTaskId.value[task.id] || []
          const afterId = latestTaskEventId(previous)
          const events = await taskAPI.events(task.id, afterId)
          const history = mergeTaskEventHistory(
            previous,
            Array.isArray(events) ? events as CreationTaskEvent[] : [],
          )
          taskEventsByTaskId.value = {
            ...taskEventsByTaskId.value,
            [task.id]: history,
          }
        } catch {
          // Keep the last valid event history available for the local telemetry clock.
        }
      }))
      refreshDharmaRenderTelemetry(rows)
    })()
    dharmaTelemetryRequest = request
    try {
      await request
    } finally {
      if (dharmaTelemetryRequest === request) dharmaTelemetryRequest = null
    }
  }

  async function loadTasks() {
    const dramaId = optionValue(options.dramaId)
    const episodeId = optionValue(options.episodeId)

    loading.value = true
    error.value = ''
    try {
      const rows = await taskAPI.list({
        drama_id: dramaId || undefined,
        episode_id: episodeId || undefined,
        active_only: options.activeOnly,
      })
      tasks.value = Array.isArray(rows) ? (rows as CreationTask[]) : []
      await loadDharmaRenderTelemetry(tasks.value)
      lastLoadedAt.value = new Date()
      return tasks.value
    } catch (err: any) {
      error.value = err?.message || '任务列表加载失败'
      tasks.value = []
      telemetryByTaskId.value = {}
      taskEventsByTaskId.value = {}
      return tasks.value
    } finally {
      loading.value = false
    }
  }

  async function loadWorkerHealth() {
    workerHealthError.value = ''
    try {
      workerHealth.value = await healthAPI.workers()
    } catch (err: any) {
      workerHealthError.value = err?.message || '获取 Worker 状态失败'
      workerHealth.value = null
    }
  }

  function stopPolling() {
    if (!pollTimer.value) return
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }

  function startDharmaTelemetryPolling() {
    if (dharmaTelemetryTimer.value) return
    dharmaTelemetryTimer.value = setInterval(() => {
      refreshDharmaRenderTelemetry(tasks.value)
    }, options.pollMs || 3000)
  }

  function stopDharmaTelemetryPolling() {
    if (!dharmaTelemetryTimer.value) return
    clearInterval(dharmaTelemetryTimer.value)
    dharmaTelemetryTimer.value = null
  }

  async function reconcileStreamingState(onTaskSettled?: () => void | Promise<void>) {
    if (streamReconciliationRequest) return streamReconciliationRequest

    const request = (async () => {
      const before = activeTaskIds(tasks.value)
      const activeTasks = tasks.value.filter(isActiveTask)

      await Promise.all(activeTasks.map(async (task) => {
        try {
          const snapshot = await taskAPI.get(Number(task.id))
          if (!snapshot || typeof snapshot !== 'object') return
          tasks.value = mergeTaskListUpdate(
            tasks.value,
            snapshot as CreationTask,
            options.activeOnly === true,
          )
        } catch {
          // A failed reconciliation request must not discard the last streamed snapshot.
        }
      }))
      await loadDharmaRenderTelemetry(tasks.value)

      const after = activeTaskIds(tasks.value)
      const settled = [...before].some(id => !after.has(id))
      if (settled) await onTaskSettled?.()
    })()
    streamReconciliationRequest = request
    try {
      await request
    } finally {
      if (streamReconciliationRequest === request) streamReconciliationRequest = null
    }
  }

  function startStreamReconciliation(onTaskSettled?: () => void | Promise<void>) {
    if (streamReconciliationTimer.value) return
    const intervalMs = Math.max(
      STREAM_RECONCILIATION_MIN_MS,
      (options.pollMs || 3_000) * 5,
    )
    streamReconciliationTimer.value = setInterval(() => {
      void reconcileStreamingState(onTaskSettled)
    }, intervalMs)
  }

  function stopStreamReconciliation() {
    if (!streamReconciliationTimer.value) return
    clearInterval(streamReconciliationTimer.value)
    streamReconciliationTimer.value = null
  }

  function stopStreaming() {
    stopDharmaTelemetryPolling()
    stopStreamReconciliation()
    if (!eventSource.value) return
    try {
      eventSource.value.close()
    } catch {}
    eventSource.value = null
    streaming.value = false
  }

  function startPolling(onTaskSettled?: () => void | Promise<void>) {
    if (pollTimer.value) return
    pollTimer.value = setInterval(() => {
      void (async () => {
        const before = activeTaskIds(tasks.value)
        await Promise.all([loadTasks(), loadWorkerHealth()])
        const after = activeTaskIds(tasks.value)
        const settled = [...before].some(id => !after.has(id))
        if (settled) await onTaskSettled?.()
      })()
    }, options.pollMs || 3000)
  }

  function buildStreamUrl() {
    const dramaId = optionValue(options.dramaId)
    const episodeId = optionValue(options.episodeId)
    const params = new URLSearchParams()
    if (dramaId) params.set('drama_id', String(dramaId))
    if (episodeId) params.set('episode_id', String(episodeId))
    const query = params.toString()
    return `/api/v1/tasks/stream${query ? `?${query}` : ''}`
  }

  function startStreaming(onTaskSettled?: () => void | Promise<void>) {
    if (eventSource.value || streaming.value) return
    if (streamFailed.value) return
    if (options.enableStreaming === false) return
    if (typeof EventSource === 'undefined') {
      streamFailed.value = true
      return
    }

    const es = new EventSource(buildStreamUrl())
    eventSource.value = es
    streaming.value = true
    let connected = false

    es.addEventListener('connected', () => {
      connected = true
      void loadWorkerHealth()
      startDharmaTelemetryPolling()
      startStreamReconciliation(onTaskSettled)
    })

    es.addEventListener('task', event => {
      void (async () => {
        const before = activeTaskIds(tasks.value)
        try {
          const payload = JSON.parse(String((event as MessageEvent).data || '{}'))
          if (!payload?.task || typeof payload.task !== 'object') throw new Error('invalid task stream payload')
          tasks.value = mergeTaskListUpdate(
            tasks.value,
            payload.task as CreationTask,
            options.activeOnly === true,
          )
          await loadDharmaRenderTelemetry(tasks.value)
          lastLoadedAt.value = new Date()
        } catch {
          await loadTasks()
        }
        const after = activeTaskIds(tasks.value)
        const settled = [...before].some(id => !after.has(id))
        if (settled) await onTaskSettled?.()
      })()
    })

    es.addEventListener('task-event', event => {
      try {
        const payload = JSON.parse(String((event as MessageEvent).data || '{}'))
        const taskId = Number(payload?.task_id)
        if (!Number.isSafeInteger(taskId) || !payload?.event || typeof payload.event !== 'object') return
        const existing = taskEventsByTaskId.value[taskId] || []
        taskEventsByTaskId.value = {
          ...taskEventsByTaskId.value,
          [taskId]: mergeTaskEventHistory(existing, [payload.event as CreationTaskEvent]),
        }
        refreshDharmaRenderTelemetry(tasks.value)
        lastLoadedAt.value = new Date()
      } catch {
        // A task snapshot will trigger the cursor-based repair path on the next update.
      }
    })

    es.addEventListener('error', () => {
      if (!connected) {
        streamFailed.value = true
      }
      stopStreaming()
      if (!pollTimer.value) {
        startPolling(onTaskSettled)
      }
    })
  }

  function startUpdates(onTaskSettled?: () => void | Promise<void>) {
    if (options.enableStreaming !== false && typeof EventSource !== 'undefined' && !streamFailed.value) {
      startStreaming(onTaskSettled)
      if (streaming.value) return
    }
    startPolling(onTaskSettled)
  }

  function stopUpdates() {
    stopStreaming()
    stopPolling()
  }

  function latestTask(type: string, scope: TaskScopeMatcher = {}) {
    return latestTaskInScope(tasks.value, type, scope)
  }

  function isTaskRunning(type: string, scope: TaskScopeMatcher = {}) {
    return isTaskRunningInList(tasks.value, type, scope)
  }

  function taskError(type: string, scope: TaskScopeMatcher = {}) {
    return taskErrorInList(tasks.value, type, scope)
  }

  function taskProgress(type: string, scope: TaskScopeMatcher = {}) {
    return taskProgressInfo(latestTask(type, scope))
  }

  async function cancelTask(id: number, payload?: TaskCancelPayload) {
    const body = payload && {
      reason: payload.reason,
      confirmation: payload.confirmation,
      actor: payload.actor,
    }
    await taskAPI.cancel(id, body, payload?.controlToken)
    await loadTasks()
  }

  async function retryTask(taskOrId: CreationTask | number) {
    const task = typeof taskOrId === 'number'
      ? tasks.value.find(item => Number(item.id) === Number(taskOrId))
      : taskOrId
    if (!task) throw new Error('找不到可重试任务')

    const retry = await taskAPI.create(toRetryPayload(task))
    await loadTasks()
    return retry
  }

  async function cancelTaskWithToast(id: number, payload?: TaskCancelPayload) {
    try {
      await cancelTask(id, payload)
      toast.success('已请求取消任务')
      return { ok: true as const }
    } catch (err: any) {
      const message = err?.message || '取消任务失败'
      toast.error(message)
      return { ok: false as const, error: message }
    }
  }

  async function retryTaskWithToast(taskOrId: CreationTask | number) {
    try {
      const task = await retryTask(taskOrId)
      toast.success('任务已重新加入队列')
      return task
    } catch (err: any) {
      toast.error(err?.message || '重试任务失败')
      return null
    }
  }

  onBeforeUnmount(stopUpdates)

  return {
    tasks,
    loading,
    error,
    lastLoadedAt,
    grouped,
    activeTasks,
    failedTasks,
    hasVisibleTasks,
    activeCount,
    failedCount,
    workerHealth,
    workerHealthError,
    telemetryByTaskId,
    isWorkerHealthy,
    streaming,
    streamFailed,
    loadTasks,
    loadWorkerHealth,
    startPolling,
    stopPolling,
    startStreaming,
    stopStreaming,
    startUpdates,
    stopUpdates,
    latestTask,
    isTaskRunning,
    taskError,
    taskProgress,
    cancelTask,
    retryTask,
    cancelTaskWithToast,
    retryTaskWithToast,
  }
}
