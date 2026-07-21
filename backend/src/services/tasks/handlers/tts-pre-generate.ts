import fs from 'fs'
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { generateEpisodePreTTS } from '../../episode-tts.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskProgress, logTaskSuccess, logTaskError } from '../../../utils/task-logger.js'
import { getAbsolutePath } from '../../../utils/storage.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface TTSPreGeneratePayload {
  episode_id?: number
  episodeId?: number
}

export function createTTSPreGenerateHandler(): TaskHandler<TTSPreGeneratePayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<TTSPreGeneratePayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!Number.isFinite(episodeId)) {
        throw new Error('tts.pre_generate payload missing episode_id')
      }

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      // 只有数据库记录和本地文件都存在时才复用，避免旧 URL 把缺失音频误判为已完成。
      const existingAudioPath = ep.preTtsAudioUrl ? getAbsolutePath(ep.preTtsAudioUrl) : ''
      if (ep.preTtsAudioUrl && ep.preTtsTitlesJson && fs.existsSync(existingAudioPath)) {
        logTaskProgress('TTSPreGenerate', 'reuse-existing', { episodeId })
        ctx.event('tts.pre_generate.reused', { episode_id: episodeId })
        return {
          type: 'done',
          text: `已复用预生成 TTS：${ep.preTtsAudioUrl}`,
          toolCalls: [],
          toolResults: [],
        }
      }

      ctx.progress('Pre-generating episode TTS for timing', 0, 1)
      const result = await generateEpisodePreTTS(episodeId)
      ctx.progress('Pre-generating episode TTS for timing', 1, 1)

      logTaskSuccess('TTSPreGenerate', 'done', {
        episodeId,
        audioUrl: result.audioUrl,
        titleCount: result.titles.length,
      })
      ctx.event('tts.pre_generate.done', {
        episode_id: episodeId,
        audio_url: result.audioUrl,
        title_count: result.titles.length,
      })

      return {
        type: 'done',
        text: `预生成 TTS 完成：${result.audioUrl}，共 ${result.titles.length} 句字幕`,
        toolCalls: [],
        toolResults: [],
      }
    },
  }
}

export function registerTTSPreGenerateHandler() {
  registerTaskHandler('tts.pre_generate', createTTSPreGenerateHandler())
}
