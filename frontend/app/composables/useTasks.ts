import { computed, onBeforeUnmount, ref, unref, type MaybeRef } from 'vue'
import { toast } from 'vue-sonner'
import { healthAPI, taskAPI } from './useApi'
import {
  groupTasks,
  isActiveTask,
  isTaskRunningInList,
  latestTaskInScope,
  taskErrorInList,
  taskProgressInfo,
  toRetryPayload,
  type CreationTask,
  type TaskScopeMatcher,
} from './taskState'

interface UseTasksOptions {
  dramaId?: MaybeRef<number | null | undefined>
  episodeId?: MaybeRef<number | null | undefined>
  pollMs?: number
  enableStreaming?: boolean
}

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
  const eventSource = ref<EventSource | null>(null)
  const streaming = ref(false)
  const streamFailed = ref(false)
  const workerHealth = ref<{ healthy_count: number; total_count: number; timeout_ms: number; workers: any[] } | null>(null)
  const workerHealthError = ref('')

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

  async function loadTasks() {
    const dramaId = optionValue(options.dramaId)
    const episodeId = optionValue(options.episodeId)

    loading.value = true
    error.value = ''
    try {
      const rows = await taskAPI.list({
        drama_id: dramaId || undefined,
        episode_id: episodeId || undefined,
      })
      tasks.value = Array.isArray(rows) ? (rows as CreationTask[]) : []
      lastLoadedAt.value = new Date()
      return tasks.value
    } catch (err: any) {
      error.value = err?.message || '任务列表加载失败'
      tasks.value = []
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

  function stopStreaming() {
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
    })

    es.addEventListener('task', () => {
      void (async () => {
        const before = activeTaskIds(tasks.value)
        await loadTasks()
        const after = activeTaskIds(tasks.value)
        const settled = [...before].some(id => !after.has(id))
        if (settled) await onTaskSettled?.()
      })()
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

  async function cancelTask(id: number) {
    await taskAPI.cancel(id)
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

  async function cancelTaskWithToast(id: number) {
    try {
      await cancelTask(id)
      toast.success('已请求取消任务')
    } catch (err: any) {
      toast.error(err?.message || '取消任务失败')
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
