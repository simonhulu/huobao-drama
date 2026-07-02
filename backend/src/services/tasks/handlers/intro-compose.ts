import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { composeIntroForEpisode } from '../../intro-composer.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskStart, logTaskSuccess } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface IntroComposePayload {
  episode_id?: number
  episodeId?: number
}

export function createIntroComposeHandler(): TaskHandler<IntroComposePayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<IntroComposePayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      logTaskStart('IntroComposeTask', 'intro-compose', { episodeId })
      ctx.progress('Composing intro animation', 0, 1)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()

      const introVideoUrl = await composeIntroForEpisode({
        episodeId,
        episodeNumber: ep.episodeNumber,
        dramaTitle: drama?.title,
        templateId: drama?.introTemplateId,
        aspectRatio: ep.aspectRatio,
      })

      db.update(schema.episodes)
        .set({ introVideoUrl, updatedAt: new Date().toISOString() })
        .where(eq(schema.episodes.id, episodeId))
        .run()

      ctx.progress('Intro compose completed', 1, 1)
      logTaskSuccess('IntroComposeTask', 'intro-compose', { episodeId, introVideoUrl })
      return { episode_id: episodeId, intro_video_url: introVideoUrl }
    },
  }
}

export function registerIntroComposeHandler() {
  registerTaskHandler('intro.compose', createIntroComposeHandler())
}
