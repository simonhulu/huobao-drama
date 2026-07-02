import { getTask, listTaskDependencies } from '../store.js'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { getEpisodeVisualStyle } from '../../episode-mode.js'
import { now } from '../../../utils/response.js'
import { regenerateStoryboardAudio as defaultRegenerateStoryboardAudio, resolveNarratorVoice, resolveVoiceForDialogue, parseDialogueForTTS } from '../../ffmpeg-compose.js'
import { generateVoiceSample } from '../../tts-generation.js'
import { generateEpisodeUnifiedTTS } from '../../episode-tts.js'
import { registerTaskHandler } from '../registry.js'
import { scheduleComposeForEpisode } from '../auto-pipeline.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface TTSPayload {
  storyboard_id?: number
  storyboardId?: number
  character_id?: number
  characterId?: number
  episode_id?: number
  episodeId?: number
}

interface StoryboardAudioResult {
  ttsAudioUrl: string | null
  narrationAudioUrl: string | null
}

interface CharacterSampleResult {
  characterId: number
  episodeId: number
  voiceSampleUrl: string
}

interface TTSGenerateDeps {
  regenerateStoryboardAudio?: (storyboardId: number) => Promise<StoryboardAudioResult>
  generateCharacterVoiceSample?: (characterId: number, episodeId: number) => Promise<CharacterSampleResult>
}

async function defaultGenerateCharacterVoiceSample(characterId: number, episodeId: number): Promise<CharacterSampleResult> {
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).all()
  if (!char) throw new Error('Character not found')
  if (!char.voiceStyle) throw new Error('请先分配音色')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error('Episode not found')

  const voiceSampleUrl = await generateVoiceSample(char.name, char.voiceStyle, ep.audioConfigId ?? undefined)
  db.update(schema.characters)
    .set({ voiceSampleUrl, updatedAt: now() })
    .where(eq(schema.characters.id, characterId))
    .run()

  return { characterId, episodeId, voiceSampleUrl }
}

export function createTTSGenerateHandler(deps: TTSGenerateDeps = {}): TaskHandler<TTSPayload> {
  const regenerateStoryboardAudio = deps.regenerateStoryboardAudio ?? defaultRegenerateStoryboardAudio
  const generateCharacterVoiceSample = deps.generateCharacterVoiceSample ?? defaultGenerateCharacterVoiceSample

  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<TTSPayload>) {
      if (ctx.payload.storyboard_id || ctx.payload.storyboardId) {
        const storyboardId = Number(ctx.payload.storyboard_id ?? ctx.payload.storyboardId)
        ctx.progress('Generating storyboard audio', 0, 1)

        const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
        if (sb?.episodeId) {
          const narrator = resolveNarratorVoice(sb.episodeId)
          const dialogue = parseDialogueForTTS(sb.dialogue)
          const dialogueVoice = dialogue.speaker ? resolveVoiceForDialogue(dialogue.speaker, sb.episodeId) : null
          ctx.event('tts.voice_selected', {
            storyboard_id: storyboardId,
            episode_id: sb.episodeId,
            narration_voice_id: narrator.voiceId,
            narration_audio_config_id: narrator.audioConfigId,
            dialogue_voice_id: dialogueVoice?.voiceId ?? null,
            dialogue_audio_config_id: dialogueVoice?.audioConfigId ?? null,
          })
        }

        const result = await regenerateStoryboardAudio(storyboardId)
        const response = {
          storyboard_id: storyboardId,
          tts_audio_url: result.ttsAudioUrl,
          narration_audio_url: result.narrationAudioUrl,
        }
        ctx.progress('Storyboard audio generated', 1, 1)
        ctx.event('tts.completed', response)

        scheduleComposeIfStoryboardReady(storyboardId)

        return response
      }

      const characterId = Number(ctx.payload.character_id ?? ctx.payload.characterId)
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!characterId) throw new Error('character_id is required')
      if (!episodeId) throw new Error('episode_id is required')

      ctx.progress('Generating character voice sample', 0, 1)
      const result = await generateCharacterVoiceSample(characterId, episodeId)
      const response = {
        character_id: result.characterId,
        episode_id: result.episodeId,
        voice_sample_url: result.voiceSampleUrl,
      }
      ctx.progress('Character voice sample generated', 1, 1)
      ctx.event('tts.completed', response)
      return response
    },
  }
}

export function createTTSEpisodeHandler(): TaskHandler<{ episode_id?: number; episodeId?: number; force?: boolean }> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      const childTaskIds = listTaskDependencies(ctx.taskId).map(dep => dep.dependsOnTaskId)
      const childTasks = childTaskIds.map(id => getTask(id)).filter(Boolean)
      const completed = childTasks.filter(task => task?.status === 'succeeded').length
      const total = childTaskIds.length

      ctx.progress('TTS child tasks scheduled', completed, total)
      ctx.event('tts.episode.children', {
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

function scheduleComposeIfStoryboardReady(storyboardId: number) {
  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.episodeId) return

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep || !ep.autoMode) return

  const visualStyle = getEpisodeVisualStyle(sb.episodeId)
  const hasMedia = visualStyle === 'ai_video' ? !!sb.videoUrl : !!sb.firstFrameImage
  if (!hasMedia) return

  scheduleComposeForEpisode(ep.dramaId, ep.id, [storyboardId])
}

export function createTTSEpisodeUnifiedHandler(): TaskHandler<{ episode_id?: number; episodeId?: number }> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      ctx.progress('Generating unified episode narration TTS', 0, 1)
      const result = await generateEpisodeUnifiedTTS(episodeId)
      ctx.progress('Unified episode narration TTS generated', 1, 1)
      ctx.event('tts.episode_unified.completed', { episode_id: episodeId, ...result })
      return { episode_id: episodeId, ...result }
    },
  }
}

export function registerTTSGenerateHandlers() {
  const handler = createTTSGenerateHandler()
  registerTaskHandler('tts.storyboard', handler)
  registerTaskHandler('tts.character_sample', handler)
  registerTaskHandler('tts.episode', createTTSEpisodeHandler())
  registerTaskHandler('tts.episode_unified', createTTSEpisodeUnifiedHandler())
}
