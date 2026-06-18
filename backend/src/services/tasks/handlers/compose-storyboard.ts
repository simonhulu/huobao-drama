import { composeStoryboard as defaultComposeStoryboard } from '../../ffmpeg-compose.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface ComposeStoryboardPayload {
  storyboard_id?: number
  storyboardId?: number
  force?: boolean
}

interface ComposeStoryboardDeps {
  composeStoryboard?: typeof defaultComposeStoryboard
}

export function createComposeStoryboardHandler(deps: ComposeStoryboardDeps = {}): TaskHandler<ComposeStoryboardPayload> {
  const composeStoryboard = deps.composeStoryboard ?? defaultComposeStoryboard
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<ComposeStoryboardPayload>) {
      const storyboardId = Number(ctx.payload.storyboard_id ?? ctx.payload.storyboardId)
      if (!storyboardId) throw new Error('storyboard_id is required')
      const force = Boolean(ctx.payload.force)

      ctx.progress('Starting storyboard compose', 0, 1)
      ctx.event('compose.storyboard.started', { storyboard_id: storyboardId, force })
      const composedVideoUrl = await composeStoryboard(storyboardId, { force })
      const result = { storyboard_id: storyboardId, composed_video_url: composedVideoUrl }
      ctx.progress('Storyboard compose completed', 1, 1)
      ctx.event('compose.storyboard.completed', result)
      return result
    },
  }
}

export function registerComposeStoryboardHandler() {
  registerTaskHandler('compose.storyboard', createComposeStoryboardHandler())
}
