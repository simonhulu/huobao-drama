import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveEpisodeTaskGroups,
  groupTasks,
  isTaskRunningInList,
  taskErrorInList,
  taskProgressInfo,
  toRetryPayload,
  type CreationTask,
} from './taskState'

const baseTask: CreationTask = {
  id: 1,
  type: 'image.generate',
  status: 'queued',
  drama_id: 7,
  episode_id: 9,
  scope_type: 'storyboard',
  scope_id: 42,
  payload: { frame_type: 'first_frame', image_generation_id: 100 },
  progress_current: 0,
  progress_total: 0,
}

test('matches active tasks by type, scope, and payload after refresh', () => {
  const tasks = [
    { ...baseTask, id: 1, status: 'succeeded' },
    { ...baseTask, id: 2, status: 'running' },
    { ...baseTask, id: 3, status: 'queued', payload: { frame_type: 'last_frame' } },
  ]

  assert.equal(isTaskRunningInList(tasks, 'image.generate', {
    scopeType: 'storyboard',
    scopeId: 42,
    payload: { frame_type: 'first_frame' },
  }), true)
  assert.equal(isTaskRunningInList(tasks, 'image.generate', {
    scopeType: 'storyboard',
    scopeId: 42,
    payload: { frame_type: 'reference' },
  }), false)
})

test('returns latest failed task message for a scoped operation', () => {
  const tasks = [
    { ...baseTask, id: 4, status: 'failed', error_message: 'old failure' },
    { ...baseTask, id: 8, status: 'stale', error_message: '' },
  ]

  assert.equal(taskErrorInList(tasks, 'image.generate', {
    scopeType: 'storyboard',
    scopeId: 42,
    payload: { frame_type: 'first_frame' },
  }), '任务已中断，请重试')
})

test('formats progress with message and counts', () => {
  assert.deepEqual(taskProgressInfo({
    ...baseTask,
    status: 'running',
    progress_message: 'Splitting grid image',
    progress_current: 2,
    progress_total: 5,
  }), {
    message: 'Splitting grid image',
    current: 2,
    total: 5,
    percent: 40,
    text: 'Splitting grid image · 2/5',
  })
})

test('groups parent tasks with children and status buckets', () => {
  const parent = { ...baseTask, id: 20, type: 'compose.episode', status: 'running', scope_type: 'episode', scope_id: 9 }
  const child = { ...baseTask, id: 21, type: 'compose.storyboard', status: 'queued', parent_task_id: 20, scope_id: 42 }
  const failed = { ...baseTask, id: 22, type: 'video.generate', status: 'failed', scope_id: 43 }
  const grouped = groupTasks([child, failed, parent])

  assert.equal(grouped.byStatus.running[0].id, 20)
  assert.equal(grouped.byStatus.failed[0].id, 22)
  assert.deepEqual(grouped.roots.map(task => task.id), [22, 20])
  assert.deepEqual(grouped.childrenByParent[20].map(task => task.id), [21])
})

test('builds retry payload from an existing failed task', () => {
  assert.deepEqual(toRetryPayload({
    ...baseTask,
    id: 30,
    status: 'failed',
    idempotency_key: 'image:storyboard:42:first',
    parent_task_id: 12,
    max_attempts: 3,
  }), {
    type: 'image.generate',
    drama_id: 7,
    episode_id: 9,
    scope_type: 'storyboard',
    scope_id: 42,
    idempotency_key: 'image:storyboard:42:first',
    parent_task_id: 12,
    payload: { frame_type: 'first_frame', image_generation_id: 100 },
    max_attempts: 3,
  })
})

test('deriveEpisodeTaskGroups groups tasks with same episode_id into one group', () => {
  const t1 = { ...baseTask, id: 1, episode_id: 3, type: 'agent.run' }
  const t2 = { ...baseTask, id: 2, episode_id: 3, type: 'image.generate' }
  const groups = deriveEpisodeTaskGroups([t1, t2])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'drama_7:episode_3')
  assert.equal(groups[0].title, '项目 7 · 第 3 集制作')
  assert.equal(groups[0].tasks.length, 2)
})

test('deriveEpisodeTaskGroups creates separate groups for different episode_ids', () => {
  const t1 = { ...baseTask, id: 1, episode_id: 3, type: 'agent.run' }
  const t2 = { ...baseTask, id: 2, episode_id: 5, type: 'image.generate' }
  const t3 = { ...baseTask, id: 3, episode_id: 5, type: 'video.generate' }
  const groups = deriveEpisodeTaskGroups([t1, t2, t3])

  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, 'drama_7:episode_5')
  assert.equal(groups[1].key, 'drama_7:episode_3')
  assert.equal(groups[0].tasks.length, 2)
  assert.equal(groups[1].tasks.length, 1)
})

test('deriveEpisodeTaskGroups separates tasks with same episode_id but different drama_id', () => {
  const t1 = { ...baseTask, id: 1, drama_id: 7, episode_id: 3, type: 'agent.run' }
  const t2 = { ...baseTask, id: 2, drama_id: 9, episode_id: 3, type: 'image.generate' }
  const groups = deriveEpisodeTaskGroups([t1, t2])

  assert.equal(groups.length, 2)
  const keys = groups.map(g => g.key).sort()
  assert.deepEqual(keys, ['drama_7:episode_3', 'drama_9:episode_3'])
  const titles = groups.map(g => g.title).sort()
  assert.deepEqual(titles, ['项目 7 · 第 3 集制作', '项目 9 · 第 3 集制作'])
})

test('deriveEpisodeTaskGroups falls back to drama_id when episode_id missing', () => {
  const t1 = { ...baseTask, id: 1, episode_id: undefined, drama_id: 7, type: 'agent.run' }
  const t2 = { ...baseTask, id: 2, episode_id: undefined, drama_id: 7, type: 'image.generate' }
  const groups = deriveEpisodeTaskGroups([t1, t2])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'drama_7')
  assert.equal(groups[0].title, '项目 7 后台任务')
})

test('deriveEpisodeTaskGroups uses global group when both episode_id and drama_id missing', () => {
  const t1 = { ...baseTask, id: 1, episode_id: undefined, drama_id: undefined, type: 'agent.run' }
  const groups = deriveEpisodeTaskGroups([t1])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'global')
  assert.equal(groups[0].title, '后台任务')
})

test('deriveEpisodeTaskGroups preserves parent/child hierarchy via groupTasks', () => {
  const parent = { ...baseTask, id: 20, episode_id: 3, type: 'compose.episode', status: 'running' }
  const child = { ...baseTask, id: 21, episode_id: 3, type: 'compose.storyboard', status: 'queued', parent_task_id: 20 }
  const groups = deriveEpisodeTaskGroups([child, parent])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'drama_7:episode_3')

  const { grouped } = groups[0]
  assert.deepEqual(grouped.roots.map((t: CreationTask) => t.id), [20])
  assert.deepEqual(grouped.childrenByParent[20].map((t: CreationTask) => t.id), [21])
})

test('deriveEpisodeTaskGroups derives group status as running when any child is running', () => {
  const tasks = [
    { ...baseTask, id: 1, episode_id: 3, status: 'succeeded', type: 'agent.run' },
    { ...baseTask, id: 2, episode_id: 3, status: 'running', type: 'image.generate' },
    { ...baseTask, id: 3, episode_id: 3, status: 'queued', type: 'video.generate' },
  ]
  const groups = deriveEpisodeTaskGroups(tasks)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].status, 'running')
})

test('deriveEpisodeTaskGroups derives group status as failed when any failed and none running/queued', () => {
  const tasks = [
    { ...baseTask, id: 1, episode_id: 3, status: 'succeeded', type: 'agent.run' },
    { ...baseTask, id: 2, episode_id: 3, status: 'failed', type: 'image.generate' },
    { ...baseTask, id: 3, episode_id: 3, status: 'succeeded', type: 'video.generate' },
  ]
  const groups = deriveEpisodeTaskGroups(tasks)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].status, 'failed')
})

test('deriveEpisodeTaskGroups counts terminal and total progress correctly', () => {
  const tasks = [
    { ...baseTask, id: 1, episode_id: 3, status: 'succeeded' },
    { ...baseTask, id: 2, episode_id: 3, status: 'failed' },
    { ...baseTask, id: 3, episode_id: 3, status: 'canceled' },
    { ...baseTask, id: 4, episode_id: 3, status: 'running' },
    { ...baseTask, id: 5, episode_id: 3, status: 'queued' },
  ]
  const groups = deriveEpisodeTaskGroups(tasks)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].progress.total, 5)
  assert.equal(groups[0].progress.terminal, 3)
})

test('deriveEpisodeTaskGroups returns no groups for empty input', () => {
  const groups = deriveEpisodeTaskGroups([])
  assert.equal(groups.length, 0)
})

test('deriveEpisodeTaskGroups does not mutate input array', () => {
  const tasks = [
    { ...baseTask, id: 2, episode_id: 3, type: 'agent.run' },
    { ...baseTask, id: 1, episode_id: 3, type: 'image.generate' },
  ]
  const copy = [...tasks]
  deriveEpisodeTaskGroups(tasks)

  assert.deepEqual(tasks, copy)
})

test('deriveEpisodeTaskGroups creates one episode for script_rewriter and extractor agent.run tasks', () => {
  const tasks: CreationTask[] = [
    {
      ...baseTask,
      id: 1,
      drama_id: 7,
      episode_id: 5,
      type: 'agent.run',
      status: 'succeeded',
      payload: { agent_type: 'script_rewriter' },
    },
    {
      ...baseTask,
      id: 2,
      drama_id: 7,
      episode_id: 5,
      type: 'agent.run',
      status: 'running',
      payload: { agent_type: 'extractor' },
    },
  ]

  const groups = deriveEpisodeTaskGroups(tasks)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'drama_7:episode_5')
  assert.equal(groups[0].title, '项目 7 · 第 5 集制作')
  assert.equal(groups[0].tasks.length, 2)
})
