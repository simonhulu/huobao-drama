import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { designHooksForEpisodes } from '../../hook-designer.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskStart, logTaskSuccess, logTaskError } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface HookDesignPayload {
  episode_id?: number
  episodeId?: number
}

interface EpisodeMetadata {
  coveredBeatIds?: string[]
  plotProgressionChain?: Array<{
    beatId: string
    summary: string
    mustKeepContext: string
  }>
}

function parseMetadata(raw: string | null | undefined): EpisodeMetadata {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as EpisodeMetadata
  } catch {
    return {}
  }
}

export function createHookDesignHandler(): TaskHandler<HookDesignPayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<HookDesignPayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      logTaskStart('HookDesignTask', 'hook-design', { episodeId })
      ctx.progress('Designing hooks and recap scripts', 0, 1)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()

      const allEpisodes = db.select().from(schema.episodes)
        .where(eq(schema.episodes.dramaId, ep.dramaId))
        .orderBy(schema.episodes.episodeNumber)
        .all()

      // Collect shared plot chain from all episodes' metadata (legacy fallback: any episode may hold it).
      let sharedPlotChain: EpisodeMetadata['plotProgressionChain'] = []
      for (const e of allEpisodes) {
        const meta = parseMetadata(e.metadata)
        if (meta.plotProgressionChain && meta.plotProgressionChain.length > 0) {
          sharedPlotChain = meta.plotProgressionChain
          break
        }
      }

      const splitResults = allEpisodes.map(e => {
        const meta = parseMetadata(e.metadata)
        return {
          episodeNumber: e.episodeNumber,
          content: e.content || '',
          summary: e.description || '',
          coveredBeatIds: meta.coveredBeatIds ?? [],
        }
      })

      const result = await designHooksForEpisodes({
        dramaTitle: drama?.title ?? ep.title,
        episodes: splitResults,
        plotChain: sharedPlotChain ?? [],
      })

      const now = new Date().toISOString()
      for (const hook of result.episodeHooks) {
        const target = allEpisodes.find(e => e.episodeNumber === hook.episodeNumber)
        if (!target) continue
        db.update(schema.episodes)
          .set({
            openingHook: hook.openingHook,
            cliffhanger: hook.cliffhangerHook,
            recapScript: hook.recapScript,
            seriesHook: result.seriesHook,
            updatedAt: now,
          })
          .where(eq(schema.episodes.id, target.id))
          .run()
      }

      ctx.progress('Hook design completed', 1, 1)
      logTaskSuccess('HookDesignTask', 'hook-design', { episodeId, seriesHook: result.seriesHook })
      return { episode_id: episodeId, series_hook: result.seriesHook }
    },
  }
}

export function registerHookDesignHandler() {
  registerTaskHandler('hook.design', createHookDesignHandler())
}
