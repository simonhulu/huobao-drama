import { computed, onBeforeUnmount, ref, unref, type MaybeRef } from 'vue'
import { toast } from 'vue-sonner'
import { taskAPI } from './useApi'
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

  const grouped = computed(() => groupTasks(tasks.value))
  const activeTasks = computed(() => tasks.value.filter(isActiveTask))
  const failedTasks = computed(() => grouped.value.byStatus.failed.concat(grouped.value.byStatus.stale))
  const hasVisibleTasks = computed(() => tasks.value.length > 0)
  const activeCount = computed(() => grouped.value.activeCount)
  const failedCount = computed(() => grouped.value.failedCount)

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

  function stopPolling() {
    if (!pollTimer.value) return
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }

  function startPolling(onTaskSettled?: () => void | Promise<void>) {
    if (pollTimer.value) return
    pollTimer.value = setInterval(() => {
      void (async () => {
        const before = activeTaskIds(tasks.value)
        await loadTasks()
        const after = activeTaskIds(tasks.value)
        const settled = [...before].some(id => !after.has(id))
        if (settled) await onTaskSettled?.()
      })()
    }, options.pollMs || 3000)
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

  onBeforeUnmount(stopPolling)

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
    loadTasks,
    startPolling,
    stopPolling,
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
