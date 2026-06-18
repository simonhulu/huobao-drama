import { computed, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { api, taskAPI } from './useApi'

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'stale', 'canceled'])

function getAgentType(task: any) {
  return task?.payload?.agent_type || task?.payload?.agentType || null
}

function isActiveAgentTask(task: any) {
  return task?.type === 'agent.run' && ACTIVE_STATUSES.has(task?.status)
}

export function useAgent() {
  const tasks = ref<any[]>([])
  const currentDramaId = ref<number | null>(null)
  const currentEpisodeId = ref<number | null>(null)
  const watchedTaskId = ref<number | null>(null)
  const completionCallback = ref<null | (() => void | Promise<void>)>(null)
  const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)

  const activeTasks = computed(() => tasks.value.filter(isActiveAgentTask))
  const running = computed(() => activeTasks.value.length > 0)
  const runningType = computed<string | null>(() => getAgentType(activeTasks.value[0]))

  function stopPolling() {
    if (!pollTimer.value) return
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }

  async function loadTasks(dramaId?: number, episodeId?: number, onDone?: () => void | Promise<void>) {
    if (dramaId) currentDramaId.value = dramaId
    if (episodeId) currentEpisodeId.value = episodeId
    if (!currentDramaId.value || !currentEpisodeId.value) return tasks.value

    tasks.value = await taskAPI.list({
      drama_id: currentDramaId.value,
      episode_id: currentEpisodeId.value,
      type: 'agent.run',
    }) as any[]

    if (running.value) {
      if (!watchedTaskId.value) watchedTaskId.value = activeTasks.value[0]?.id || null
      startPolling(onDone)
    }
    return tasks.value
  }

  function taskErrorMessage(task: any) {
    return task?.error_message || task?.errorMessage || 'Agent 任务执行失败'
  }

  async function handleWatchedTaskCompletion(taskId: number | null) {
    if (!taskId) return
    const task = tasks.value.find(t => t.id === taskId)
    if (!task || !TERMINAL_STATUSES.has(task.status)) return

    watchedTaskId.value = null
    const onDone = completionCallback.value
    completionCallback.value = null

    if (task.status === 'succeeded') {
      toast.success('完成')
      await onDone?.()
    } else if (task.status === 'canceled') {
      toast.warning('任务已取消')
    } else {
      toast.error(taskErrorMessage(task))
    }
  }

  function startPolling(onDone?: () => void | Promise<void>) {
    if (onDone) completionCallback.value = onDone
    if (pollTimer.value) return

    pollTimer.value = setInterval(() => {
      void (async () => {
        const taskId = watchedTaskId.value
        try {
          await loadTasks()
          if (!running.value) {
            stopPolling()
            await handleWatchedTaskCompletion(taskId)
          }
        } catch (err: any) {
          toast.error(err.message)
        }
      })()
    }, 2000)
  }

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void | Promise<void>) {
    await loadTasks(dramaId, episodeId)
    if (running.value) { toast.warning('操作执行中'); return }
    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
      })
      watchedTaskId.value = data.task_id
      toast.success('任务已加入后台队列')
      await loadTasks(dramaId, episodeId)
      startPolling(onDone)
      return data
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  onUnmounted(stopPolling)

  return { running, runningType, tasks, loadTasks, run }
}
