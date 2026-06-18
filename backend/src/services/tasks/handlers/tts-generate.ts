import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { now } from '../../../utils/response.js'
import { regenerateStoryboardAudio as defaultRegenerateStoryboardAudio } from '../../ffmpeg-compose.js'
import { generateVoiceSample } from '../../tts-generation.js'
import { registerTaskHandler } from '../registry.js'
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
        const result = await regenerateStoryboardAudio(storyboardId)
        const response = {
          storyboard_id: storyboardId,
          tts_audio_url: result.ttsAudioUrl,
          narration_audio_url: result.narrationAudioUrl,
        }
        ctx.progress('Storyboard audio generated', 1, 1)
        ctx.event('tts.completed', response)
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

export function registerTTSGenerateHandlers() {
  const handler = createTTSGenerateHandler()
  registerTaskHandler('tts.storyboard', handler)
  registerTaskHandler('tts.character_sample', handler)
}
