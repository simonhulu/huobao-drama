export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'stale'] as const
export const ACTIVE_TASK_STATUSES = new Set(['queued', 'running'])
export const FAILED_TASK_STATUSES = new Set(['failed', 'stale'])
export const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'stale'])

export type TaskStatus = typeof TASK_STATUSES[number]

export interface CreationTask {
  id: number
  type: string
  status: TaskStatus | string
  drama_id?: number | null
  episode_id?: number | null
  scope_type?: string | null
  scope_id?: number | string | null
  parent_task_id?: number | null
  payload?: Record<string, unknown>
  progress_current?: number | null
  progress_total?: number | null
  progress_message?: string | null
  error_message?: string | null
  error_message_zh?: string | null
  cancel_requested?: boolean | number | null
  idempotency_key?: string | null
  max_attempts?: number | null
  priority?: number | null
  scheduled_at?: string | number | Date | null
  provider?: string | null
  retry_reason?: string | null
  attempts?: number | null
  queue_position?: number | null
  created_at?: string | number | Date | null
  updated_at?: string | number | Date | null
  [key: string]: unknown
}

export interface TaskScopeMatcher {
  scopeType?: string
  scopeId?: number | string | null
  payload?: Record<string, unknown>
}

export interface TaskProgressInfo {
  message: string
  current: number
  total: number
  percent: number
  text: string
}

export interface GroupedTasks<T = CreationTask> {
  byStatus: Record<TaskStatus, T[]>
  byType: Record<string, T[]>
  roots: T[]
  childrenByParent: Record<string, T[]>
  activeCount: number
  failedCount: number
}

function camelize(value: string) {
  return value.replace(/_([a-z])/g, (_, c) => String(c).toUpperCase())
}

function snakeize(value: string) {
  return value.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
}

function keyVariants(key: string) {
  return [...new Set([key, camelize(key), snakeize(key)])]
}

export function taskValue(task: CreationTask | undefined | null, snakeKey: string, camelKey = camelize(snakeKey)) {
  return task?.[snakeKey] ?? task?.[camelKey]
}

export function taskStatus(task: CreationTask | undefined | null) {
  return String(taskValue(task, 'status') || '')
}

export function taskId(task: CreationTask | undefined | null) {
  return Number(taskValue(task, 'id') || 0)
}

export function taskScopeType(task: CreationTask | undefined | null) {
  return String(taskValue(task, 'scope_type') || '')
}

export function taskScopeId(task: CreationTask | undefined | null) {
  return Number(taskValue(task, 'scope_id') || 0)
}

export function taskParentId(task: CreationTask | undefined | null) {
  const value = taskValue(task, 'parent_task_id')
  return value == null ? null : Number(value)
}

export function taskPayloadValue(task: CreationTask | undefined | null, snakeKey: string, camelKey = camelize(snakeKey)) {
  const payload = (task?.payload || {}) as Record<string, unknown>
  for (const key of keyVariants(snakeKey)) {
    if (payload[key] !== undefined) return payload[key]
  }
  for (const key of keyVariants(camelKey)) {
    if (payload[key] !== undefined) return payload[key]
  }
  return undefined
}

function comparable(value: unknown) {
  if (value == null) return ''
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function isActiveTask(task: CreationTask | undefined | null) {
  return ACTIVE_TASK_STATUSES.has(taskStatus(task))
}

export function isFailedTask(task: CreationTask | undefined | null) {
  return FAILED_TASK_STATUSES.has(taskStatus(task))
}

export function isTerminalTask(task: CreationTask | undefined | null) {
  return TERMINAL_TASK_STATUSES.has(taskStatus(task))
}

export function taskMatchesScope(task: CreationTask | undefined | null, scope: TaskScopeMatcher = {}) {
  if (scope.scopeType && taskScopeType(task) !== scope.scopeType) return false
  if (scope.scopeId != null && taskScopeId(task) !== Number(scope.scopeId)) return false

  if (scope.payload) {
    for (const [key, expected] of Object.entries(scope.payload)) {
      const actual = taskPayloadValue(task, key)
      if (comparable(actual) !== comparable(expected)) return false
    }
  }

  return true
}

export function latestTask<T extends CreationTask>(tasks: T[], type: string, matcher: (task: T) => boolean = () => true) {
  return [...tasks]
    .filter(task => task?.type === type && matcher(task))
    .sort((a, b) => taskId(b) - taskId(a))[0] || null
}

export function latestTaskInScope<T extends CreationTask>(tasks: T[], type: string, scope: TaskScopeMatcher = {}) {
  return latestTask(tasks, type, task => taskMatchesScope(task, scope))
}

export function isTaskRunningInList(tasks: CreationTask[], type: string, scope: TaskScopeMatcher = {}) {
  return isActiveTask(latestTaskInScope(tasks, type, scope))
}

export function taskFailureMessage(task: CreationTask | undefined | null) {
  if (!task) return ''
  const message = taskValue(task, 'error_message')
  if (message) return String(message)
  const zhMessage = taskValue(task, 'error_message_zh')
  if (zhMessage) return String(zhMessage)
  if (taskStatus(task) === 'stale') return '任务已中断，请重试'
  return '任务失败，请重试'
}

export function taskQueuePosition(task: CreationTask | undefined | null) {
  const value = taskValue(task, 'queue_position')
  return value == null ? null : Number(value)
}

export function taskAttempts(task: CreationTask | undefined | null) {
  return Number(taskValue(task, 'attempts') || 0)
}

export function taskProvider(task: CreationTask | undefined | null) {
  return String(taskValue(task, 'provider') || '')
}

export function taskPriority(task: CreationTask | undefined | null) {
  return Number(taskValue(task, 'priority') || 0)
}

export function formatProvider(provider: string) {
  const labels: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Gemini',
    minimax: 'MiniMax',
    doubao: '火山引擎',
    aliyun: '阿里',
    chatfire: 'Chatfire',
  }
  return labels[provider] || provider
}

export function taskStatusDetail(task: CreationTask | undefined | null) {
  const status = taskStatus(task)
  const queuePosition = taskQueuePosition(task)
  const attempts = taskAttempts(task)
  const provider = taskProvider(task)

  if (status === 'queued' && queuePosition != null) {
    return `队列第 ${queuePosition} 位`
  }
  if (status === 'running' && provider) {
    return `正在由 ${formatProvider(provider)} 生成`
  }
  if ((status === 'failed' || status === 'stale') && attempts > 0) {
    return `已尝试 ${attempts} 次`
  }
  return ''
}

export function taskErrorInList(tasks: CreationTask[], type: string, scope: TaskScopeMatcher = {}) {
  const task = latestTaskInScope(tasks, type, scope)
  return isFailedTask(task) ? taskFailureMessage(task) : ''
}

export function taskProgressInfo(task: CreationTask | undefined | null): TaskProgressInfo {
  const current = Number(taskValue(task, 'progress_current') || 0)
  const total = Number(taskValue(task, 'progress_total') || 0)
  const message = String(taskValue(task, 'progress_message') || '')
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0
  const countText = total > 0 ? `${current}/${total}` : ''
  const text = [message, countText].filter(Boolean).join(' · ')

  return {
    message,
    current,
    total,
    percent,
    text,
  }
}

export function taskTitle(task: CreationTask | undefined | null) {
  const type = String(task?.type || '')
  const payload = (task?.payload || {}) as Record<string, unknown>
  const typeLabels: Record<string, string> = {
    'agent.run': payload.agent_type || payload.agentType ? `AI ${payload.agent_type || payload.agentType}` : 'AI 任务',
    'image.generate': '图片生成',
    'video.generate': '视频生成',
    'tts.storyboard': '镜头配音',
    'tts.character_sample': '角色试听',
    'grid.generate': '宫格生成',
    'grid.split': '宫格切分',
    'compose.storyboard': '镜头合成',
    'compose.episode': '批量合成',
    'merge.episode': '全集拼接',
  }
  return typeLabels[type] || type || '任务'
}

export function groupTasks<T extends CreationTask>(tasks: T[]): GroupedTasks<T> {
  const sorted = [...tasks].sort((a, b) => taskId(b) - taskId(a))
  const byStatus = TASK_STATUSES.reduce((acc, status) => {
    acc[status] = []
    return acc
  }, {} as Record<TaskStatus, T[]>)
  const byType: Record<string, T[]> = {}
  const childrenByParent: Record<string, T[]> = {}
  const knownIds = new Set(sorted.map(task => taskId(task)))

  for (const task of sorted) {
    const status = TASK_STATUSES.includes(taskStatus(task) as TaskStatus) ? taskStatus(task) as TaskStatus : 'queued'
    byStatus[status].push(task)
    const type = String(task?.type || 'unknown')
    byType[type] ||= []
    byType[type].push(task)

    const parentId = taskParentId(task)
    if (parentId) {
      childrenByParent[parentId] ||= []
      childrenByParent[parentId].push(task)
    }
  }

  for (const children of Object.values(childrenByParent)) {
    children.sort((a, b) => taskId(a) - taskId(b))
  }

  return {
    byStatus,
    byType,
    roots: sorted.filter(task => {
      const parentId = taskParentId(task)
      return !parentId || !knownIds.has(parentId)
    }),
    childrenByParent,
    activeCount: sorted.filter(isActiveTask).length,
    failedCount: sorted.filter(isFailedTask).length,
  }
}

export interface EpisodeTaskGroup {
  key: string
  dramaId: string
  episodeId?: string
  title: string
  tasks: CreationTask[]
  grouped: GroupedTasks
  status: TaskStatus
  progress: {
    terminal: number
    total: number
  }
}

export interface TypeTaskGroup {
  type: string
  label: string
  tasks: CreationTask[]
  status: TaskStatus
  counts: {
    total: number
    completed: number
    queued: number
    running: number
    failed: number
  }
  progress: {
    terminal: number
    total: number
  }
}

export interface EpisodeQueueGroup {
  episodeKey: string
  dramaId: string
  episodeId?: string
  title: string
  types: TypeTaskGroup[]
  roots: CreationTask[]
  childrenByParent: Record<string, CreationTask[]>
  tasks: CreationTask[]
  status: TaskStatus
  counts: {
    total: number
    completed: number
    queued: number
    running: number
    failed: number
  }
  progress: {
    terminal: number
    total: number
  }
}

export interface DramaTaskGroup {
  dramaId: string
  title: string
  episodes: EpisodeQueueGroup[]
  tasks: CreationTask[]
  status: TaskStatus
  counts: {
    total: number
    completed: number
    queued: number
    running: number
    failed: number
  }
  progress: {
    terminal: number
    total: number
  }
}

const GROUP_STATUS_PRIORITY: TaskStatus[] = ['running', 'queued', 'failed', 'stale', 'canceled', 'succeeded']

function deriveGroupStatus(tasks: CreationTask[]): TaskStatus {
  const present = new Set(tasks.map(t => taskStatus(t)))
  for (const status of GROUP_STATUS_PRIORITY) {
    if (present.has(status)) return status
  }
  return 'succeeded'
}

export function deriveEpisodeTaskGroups(tasks: CreationTask[]): EpisodeTaskGroup[] {
  const sorted = [...tasks].sort((a, b) => taskId(b) - taskId(a))

  const groupMap = new Map<string, CreationTask[]>()

  for (const task of sorted) {
    const episodeId = taskValue(task, 'episode_id')
    const dramaId = taskValue(task, 'drama_id')
    const hasEpisode = episodeId != null && String(episodeId) !== ''
    const hasDrama = dramaId != null && String(dramaId) !== ''

    let key: string
    if (hasEpisode && hasDrama) {
      key = `drama_${dramaId}:episode_${episodeId}`
    } else if (hasDrama) {
      key = `drama_${dramaId}`
    } else {
      key = 'global'
    }

    if (!groupMap.has(key)) {
      groupMap.set(key, [])
    }
    groupMap.get(key)!.push(task)
  }

  const result: EpisodeTaskGroup[] = []

  for (const [key, groupTasks_] of groupMap) {
    const grouped = groupTasks(groupTasks_)
    const status = deriveGroupStatus(groupTasks_)
    const total = groupTasks_.length
    const terminal = groupTasks_.filter(isTerminalTask).length

    let title: string
    let dramaId = ''
    let episodeId: string | undefined
    if (key.includes(':episode_')) {
      dramaId = key.slice('drama_'.length, key.indexOf(':episode_'))
      episodeId = key.slice(key.indexOf(':episode_') + ':episode_'.length)
      title = `项目 ${dramaId} · 第 ${episodeId} 集制作`
    } else if (key.startsWith('drama_')) {
      dramaId = key.slice('drama_'.length)
      title = `项目 ${dramaId} 后台任务`
    } else {
      title = '后台任务'
    }

    result.push({
      key,
      dramaId,
      episodeId,
      title,
      tasks: groupTasks_,
      grouped,
      status,
      progress: { terminal, total },
    })
  }

  return result
}

function deriveGroupCounts(tasks: CreationTask[]) {
  return {
    total: tasks.length,
    completed: tasks.filter(t => taskStatus(t) === 'succeeded').length,
    queued: tasks.filter(t => taskStatus(t) === 'queued').length,
    running: tasks.filter(t => taskStatus(t) === 'running').length,
    failed: tasks.filter(t => ['failed', 'stale'].includes(taskStatus(t))).length,
  }
}

export function deriveTypeTaskGroups(tasks: CreationTask[]): TypeTaskGroup[] {
  const sorted = [...tasks].sort((a, b) => taskId(b) - taskId(a))
  const byType: Record<string, CreationTask[]> = {}

  for (const task of sorted) {
    const type = String(task?.type || 'unknown')
    byType[type] ||= []
    byType[type].push(task)
  }

  return Object.entries(byType)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, typeTasks]) => {
      const status = deriveGroupStatus(typeTasks)
      const total = typeTasks.length
      const terminal = typeTasks.filter(isTerminalTask).length
      return {
        type,
        label: taskTitle({ type } as CreationTask),
        tasks: typeTasks,
        status,
        counts: deriveGroupCounts(typeTasks),
        progress: { terminal, total },
      }
    })
}

function deriveEpisodeQueueGroup(episode: EpisodeTaskGroup): EpisodeQueueGroup {
  const grouped = groupTasks(episode.tasks)
  const typeGroups = deriveTypeTaskGroups(episode.tasks)
  return {
    episodeKey: episode.key,
    dramaId: episode.dramaId,
    episodeId: episode.episodeId,
    title: episode.title,
    types: typeGroups,
    roots: grouped.roots,
    childrenByParent: grouped.childrenByParent,
    tasks: episode.tasks,
    status: episode.status,
    counts: deriveGroupCounts(episode.tasks),
    progress: episode.progress,
  }
}

export function deriveDramaTaskGroups(tasks: CreationTask[]): DramaTaskGroup[] {
  const episodes = deriveEpisodeTaskGroups(tasks)
  const byDrama = new Map<string, EpisodeTaskGroup[]>()

  for (const ep of episodes) {
    const dramaId = ep.dramaId || 'global'
    if (!byDrama.has(dramaId)) {
      byDrama.set(dramaId, [])
    }
    byDrama.get(dramaId)!.push(ep)
  }

  const result: DramaTaskGroup[] = []

  for (const [dramaId, dramaEpisodes] of byDrama) {
    const queueEpisodes = dramaEpisodes.map(deriveEpisodeQueueGroup)
    const allTasks = dramaEpisodes.flatMap(ep => ep.tasks)
    const status = deriveGroupStatus(allTasks)
    const terminal = allTasks.filter(isTerminalTask).length
    const isGlobal = dramaId === 'global'

    result.push({
      dramaId,
      title: isGlobal ? '全局后台任务' : `项目 ${dramaId}`,
      episodes: queueEpisodes,
      tasks: allTasks,
      status,
      counts: deriveGroupCounts(allTasks),
      progress: { terminal, total: allTasks.length },
    })
  }

  return result.sort((a, b) => {
    if (a.dramaId === 'global') return 1
    if (b.dramaId === 'global') return -1
    return Number(a.dramaId) - Number(b.dramaId)
  })
}

export function deriveActiveBatchTasks(tasks: CreationTask[]): CreationTask[] {
  const sorted = [...tasks].sort((a, b) => taskId(b) - taskId(a))
  const seen = new Set<string>()
  const result: CreationTask[] = []

  for (const task of sorted) {
    const status = taskStatus(task)
    const total = Number(taskValue(task, 'progress_total') || 0)
    const key = `${task.type}:${taskValue(task, 'episode_id') || ''}:${taskValue(task, 'drama_id') || ''}`

    if (!['queued', 'running'].includes(status)) continue
    if (total <= 0) continue
    if (seen.has(key)) continue

    seen.add(key)
    result.push(task)
  }

  return result
}

export interface BatchTaskGroup {
  dramaId: string
  episodeId?: string
  type: string
  label: string
  task: CreationTask
  progress: TaskProgressInfo
}

export interface BatchEpisodeGroup {
  dramaId: string
  episodeId?: string
  title: string
  tasks: BatchTaskGroup[]
}

export interface BatchDramaGroup {
  dramaId: string
  title: string
  episodes: BatchEpisodeGroup[]
}

function batchTaskKey(task: CreationTask) {
  const dramaId = String(taskValue(task, 'drama_id') || 'global')
  const episodeId = String(taskValue(task, 'episode_id') || '')
  return `${dramaId}:${episodeId}:${task.type}`
}

export function deriveBatchTaskGroups(tasks: CreationTask[]): BatchDramaGroup[] {
  const sorted = [...tasks].sort((a, b) => taskId(b) - taskId(a))
  const seen = new Set<string>()
  const groups: BatchTaskGroup[] = []

  for (const task of sorted) {
    const status = taskStatus(task)
    const total = Number(taskValue(task, 'progress_total') || 0)

    if (!['queued', 'running'].includes(status)) continue
    if (total <= 0) continue

    const key = batchTaskKey(task)
    if (seen.has(key)) continue
    seen.add(key)

    const dramaId = String(taskValue(task, 'drama_id') || 'global')
    const episodeIdRaw = taskValue(task, 'episode_id')
    const episodeId = episodeIdRaw != null && String(episodeIdRaw) !== '' ? String(episodeIdRaw) : undefined

    groups.push({
      dramaId,
      episodeId,
      type: task.type,
      label: taskTitle(task),
      task,
      progress: taskProgressInfo(task),
    })
  }

  const byDrama = new Map<string, Map<string | undefined, BatchTaskGroup[]>>()

  for (const group of groups) {
    if (!byDrama.has(group.dramaId)) {
      byDrama.set(group.dramaId, new Map())
    }
    const dramaEpisodes = byDrama.get(group.dramaId)!
    if (!dramaEpisodes.has(group.episodeId)) {
      dramaEpisodes.set(group.episodeId, [])
    }
    dramaEpisodes.get(group.episodeId)!.push(group)
  }

  const result: BatchDramaGroup[] = []

  for (const [dramaId, episodesMap] of byDrama) {
    const episodes: BatchEpisodeGroup[] = []
    for (const [episodeId, typeGroups] of episodesMap) {
      const isGlobal = dramaId === 'global'
      const title = episodeId
        ? `第 ${episodeId} 集`
        : isGlobal
          ? '全局任务'
          : '项目级任务'
      episodes.push({
        dramaId,
        episodeId,
        title,
        tasks: typeGroups,
      })
    }

    episodes.sort((a, b) => {
      if (!a.episodeId && b.episodeId) return -1
      if (a.episodeId && !b.episodeId) return 1
      return Number(a.episodeId || 0) - Number(b.episodeId || 0)
    })

    result.push({
      dramaId,
      title: dramaId === 'global' ? '全局任务' : `项目 ${dramaId}`,
      episodes,
    })
  }

  return result.sort((a, b) => {
    if (a.dramaId === 'global') return 1
    if (b.dramaId === 'global') return -1
    return Number(a.dramaId) - Number(b.dramaId)
  })
}

export function toRetryPayload(task: CreationTask | undefined | null) {
  return {
    type: task?.type,
    drama_id: taskValue(task, 'drama_id'),
    episode_id: taskValue(task, 'episode_id'),
    scope_type: taskValue(task, 'scope_type'),
    scope_id: taskValue(task, 'scope_id'),
    idempotency_key: taskValue(task, 'idempotency_key'),
    parent_task_id: taskValue(task, 'parent_task_id'),
    payload: task?.payload,
    max_attempts: taskValue(task, 'max_attempts'),
  }
}
