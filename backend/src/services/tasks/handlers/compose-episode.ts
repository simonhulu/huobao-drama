import { getTask, listTaskDependencies } from '../store.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface ComposeEpisodePayload {
  episode_id?: number
  episodeId?: number
}

export function createComposeEpisodeHandler(): TaskHandler<ComposeEpisodePayload> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<ComposeEpisodePayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      const childTaskIds = listTaskDependencies(ctx.taskId).map(dep => dep.dependsOnTaskId)
      const childTasks = childTaskIds.map(id => getTask(id)).filter(Boolean)
      const completed = childTasks.filter(task => task?.status === 'succeeded').length
      const total = childTaskIds.length

      ctx.progress('Compose child tasks scheduled', completed, total)
      ctx.event('compose.episode.children', {
        episode_id: episodeId,
        child_task_ids: childTaskIds,
        completed,
        total,
      })

      return {
        episode_id: episodeId,
        child_task_ids: childTaskIds,
        completed,
        total,
      }
    },
  }
}

export function registerComposeEpisodeHandler() {
  registerTaskHandler('compose.episode', createComposeEpisodeHandler())
}
