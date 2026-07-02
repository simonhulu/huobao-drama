import { getTask, listTaskDependencies } from '../store.js'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'
import { scheduleComposeForEpisode, scheduleMergeForEpisode } from '../auto-pipeline.js'

interface MediaEpisodePayload {
  episode_id?: number
  episodeId?: number
}

function readEpisodeId(payload: MediaEpisodePayload) {
  return Number(payload.episode_id ?? payload.episodeId)
}

function countChildrenState(taskId: number) {
  const childTaskIds = listTaskDependencies(taskId).map(dep => dep.dependsOnTaskId)
  const childTasks = childTaskIds.map(id => getTask(id)).filter(Boolean)
  const succeeded = childTasks.filter(task => task?.status === 'succeeded').length
  const failed = childTasks.filter(task => task?.status === 'failed').length
  return { childTaskIds, childTasks, succeeded, failed, total: childTaskIds.length }
}

export function createImageEpisodeHandler(): TaskHandler<MediaEpisodePayload> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<MediaEpisodePayload>) {
      const episodeId = readEpisodeId(ctx.payload)
      if (!episodeId) throw new Error('episode_id is required')

      const { succeeded, failed, total } = countChildrenState(ctx.taskId)

      ctx.progress('Image child tasks completed', succeeded, total)
      ctx.event('image.episode.children', { episode_id: episodeId, succeeded, failed, total })

      // 必须全部成功（无失败、无遗漏）且开启自动模式，才推进到合成
      const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (episode?.autoMode && succeeded === total && failed === 0 && total > 0) {
        const composeResult = scheduleComposeForEpisode(episode.dramaId, episodeId)
        if (composeResult.parentTask) {
          ctx.event('image.episode.compose_scheduled', {
            episode_id: episodeId,
            compose_episode_task_id: composeResult.parentTask.id,
          })
        }
      } else if (failed > 0) {
        ctx.event('image.episode.blocked', {
          episode_id: episodeId,
          reason: `${failed}/${total} 张图片生成失败，流水线暂停，请手动重试失败任务后再推进`,
          failed,
          total,
        })
      }

      return { episode_id: episodeId, succeeded, failed, total }
    },
  }
}

export function createVideoEpisodeHandler(): TaskHandler<MediaEpisodePayload> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<MediaEpisodePayload>) {
      const episodeId = readEpisodeId(ctx.payload)
      if (!episodeId) throw new Error('episode_id is required')

      const { succeeded, failed, total } = countChildrenState(ctx.taskId)

      ctx.progress('Video child tasks completed', succeeded, total)
      ctx.event('video.episode.children', { episode_id: episodeId, succeeded, failed, total })

      return { episode_id: episodeId, succeeded, failed, total }
    },
  }
}

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

      const { succeeded, failed, total } = countChildrenState(ctx.taskId)

      ctx.progress('Compose child tasks completed', succeeded, total)
      ctx.event('compose.episode.children', {
        episode_id: episodeId,
        succeeded,
        failed,
        total,
      })

      // 必须全部成功（无失败）且开启自动模式，才推进到合并
      const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (episode?.autoMode && succeeded === total && failed === 0 && total > 0) {
        const mergeTask = scheduleMergeForEpisode(episode.dramaId, episodeId)
        if (mergeTask) {
          ctx.event('compose.episode.merge_scheduled', {
            episode_id: episodeId,
            merge_task_id: mergeTask.id,
          })
        }
      } else if (failed > 0) {
        ctx.event('compose.episode.blocked', {
          episode_id: episodeId,
          reason: `${failed}/${total} 个镜头合成失败，流水线暂停，请手动重试失败任务后再推进`,
          failed,
          total,
        })
      }

      return { episode_id: episodeId, child_task_ids: countChildrenState(ctx.taskId).childTaskIds, completed: succeeded, total }
    },
  }
}

export function registerMediaEpisodeHandlers() {
  registerTaskHandler('image.episode', createImageEpisodeHandler())
  registerTaskHandler('video.episode', createVideoEpisodeHandler())
  registerTaskHandler('compose.episode', createComposeEpisodeHandler())
}
