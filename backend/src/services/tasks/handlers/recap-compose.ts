import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { composeRecapForEpisode } from '../../recap-composer.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskStart, logTaskSuccess } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface RecapComposePayload {
  episode_id?: number
  episodeId?: number
}

export function createRecapComposeHandler(): TaskHandler<RecapComposePayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<RecapComposePayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      logTaskStart('RecapComposeTask', 'recap-compose', { episodeId })
      ctx.progress('Composing recap video', 0, 1)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      const recapVideoUrl = await composeRecapForEpisode({
        episodeId,
        episodeNumber: ep.episodeNumber,
        recapScript: ep.recapScript || '',
        openingHook: ep.openingHook,
        dramaId: ep.dramaId,
      })

      db.update(schema.episodes)
        .set({ recapVideoUrl, updatedAt: new Date().toISOString() })
        .where(eq(schema.episodes.id, episodeId))
        .run()

      ctx.progress('Recap compose completed', 1, 1)
      logTaskSuccess('RecapComposeTask', 'recap-compose', { episodeId, recapVideoUrl })
      return { episode_id: episodeId, recap_video_url: recapVideoUrl }
    },
  }
}

export function registerRecapComposeHandler() {
  registerTaskHandler('recap.compose', createRecapComposeHandler())
}
