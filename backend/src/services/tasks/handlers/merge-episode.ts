import { executeEpisodeMerge as defaultExecuteEpisodeMerge } from '../../ffmpeg-merge.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface MergeEpisodePayload {
  merge_id?: number
  mergeId?: number
  episode_id?: number
  episodeId?: number
  drama_id?: number
  dramaId?: number
}

interface MergeEpisodeDeps {
  executeEpisodeMerge?: typeof defaultExecuteEpisodeMerge
}

export function createMergeEpisodeHandler(deps: MergeEpisodeDeps = {}): TaskHandler<MergeEpisodePayload> {
  const executeEpisodeMerge = deps.executeEpisodeMerge ?? defaultExecuteEpisodeMerge
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<MergeEpisodePayload>) {
      const mergeId = Number(ctx.payload.merge_id ?? ctx.payload.mergeId)
      if (!mergeId) throw new Error('merge_id is required')

      ctx.progress('Starting episode merge', 0, 1)
      ctx.event('merge.episode.started', {
        merge_id: mergeId,
        episode_id: ctx.payload.episode_id ?? ctx.payload.episodeId,
        drama_id: ctx.payload.drama_id ?? ctx.payload.dramaId,
      })
      const result = await executeEpisodeMerge(mergeId)
      ctx.progress('Episode merge completed', 1, 1)
      ctx.event('merge.episode.completed', result)
      return result
    },
  }
}

export function registerMergeEpisodeHandler() {
  registerTaskHandler('merge.episode', createMergeEpisodeHandler())
}
