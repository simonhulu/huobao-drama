import { composeStoryboard as defaultComposeStoryboard } from '../../ffmpeg-compose.js'
import { registerTaskHandler } from '../registry.js'
import { scheduleMergeForEpisode } from '../auto-pipeline.js'
import { getEpisodeScriptSource, getEpisodeVisualStyle } from '../../episode-mode.js'
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { listTasks } from '../store.js'
import { logTaskWarn } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface ComposeStoryboardPayload {
  storyboard_id?: number
  storyboardId?: number
  force?: boolean
}

interface ComposeStoryboardDeps {
  composeStoryboard?: typeof defaultComposeStoryboard
}

const EXPLICITLY_NO_NARRATION = /^(无|无旁白|无需配音|无需旁白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function isIgnorableNarration(text?: string | null): boolean {
  return EXPLICITLY_NO_NARRATION.test(text?.trim() || '')
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

      // 兜底：图文叙事模式下，如果旁白字段为空且不是明确标注“无旁白”，拒绝合成，避免产出静音镜头。
      // 精稿直出模式允许无旁白，ffmpeg-compose 会补静音轨道并继续合成。
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
      if (sb) {
        const visualStyle = getEpisodeVisualStyle(sb.episodeId)
        if (visualStyle !== 'ai_video' && !sb.narration?.trim() && !isIgnorableNarration(sb.narration)) {
          if (getEpisodeScriptSource(sb.episodeId) === 'direct_script') {
            logTaskWarn('ComposeTask', 'direct-script-no-narration', { storyboardId, episodeId: sb.episodeId })
          } else {
            throw new Error(`Storyboard ${storyboardId} 缺少旁白，无法合成图文叙事镜头`)
          }
        }
      }

      const composedVideoUrl = await composeStoryboard(storyboardId, { force })
      const result = { storyboard_id: storyboardId, composed_video_url: composedVideoUrl }
      ctx.progress('Storyboard compose completed', 1, 1)
      ctx.event('compose.storyboard.completed', result)

      scheduleMergeIfEpisodeReady(storyboardId)

      return result
    },
  }
}

function scheduleMergeIfEpisodeReady(storyboardId: number) {
  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.episodeId) return

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep || !ep.autoMode) return

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, ep.id))
    .orderBy(schema.storyboards.storyboardNumber).all()

  const total = storyboards.length
  if (total === 0) return

  const composed = storyboards.filter(s => !!s.composedVideoUrl).length
  if (composed < total) return

  // 确认没有“仍未合成成功”的 failed compose.storyboard 任务。
  // 历史失败任务可能已经被重试成功并留下 composedVideoUrl，这种情况下不应阻塞合并。
  const composeTasks = listTasks({ episodeId: ep.id }).filter(t => t.type === 'compose.storyboard')
  const failedCount = composeTasks.filter(t => {
    if (t.status !== 'failed') return false
    const failedStoryboardId = Number(t.scopeId ?? 0)
    const failedStoryboard = storyboards.find(s => s.id === failedStoryboardId)
    return !failedStoryboard?.composedVideoUrl
  }).length
  if (failedCount > 0) return

  scheduleMergeForEpisode(ep.dramaId, ep.id)
}

export function registerComposeStoryboardHandler() {
  registerTaskHandler('compose.storyboard', createComposeStoryboardHandler())
}
