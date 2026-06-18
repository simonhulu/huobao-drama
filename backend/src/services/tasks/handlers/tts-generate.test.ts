import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-tts-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { appendTaskEvent, createTask, listTaskEvents, updateTaskProgress } = await import('../store.js')
const { createTTSGenerateHandler } = await import('./tts-generate.js')

function makeContext(task: any) {
  return {
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    progress(message: string, current?: number, total?: number) {
      updateTaskProgress(task.id, { progressMessage: message, progressCurrent: current, progressTotal: total })
    },
    event(type: string, data?: unknown) {
      appendTaskEvent(task.id, type, data)
    },
    isCancelRequested() {
      return false
    },
  }
}

test('tts.storyboard handler delegates storyboard audio generation', async () => {
  const handler = createTTSGenerateHandler({
    regenerateStoryboardAudio: async (storyboardId: number) => ({
      storyboardId,
      ttsAudioUrl: 'static/audio/dialogue.mp3',
      narrationAudioUrl: 'static/audio/narration.mp3',
    }),
    generateCharacterVoiceSample: async () => {
      throw new Error('should not be called')
    },
  })
  const task = createTask({
    type: 'tts.storyboard',
    payload: { storyboard_id: 5 },
  })

  const result = await handler.run(makeContext(task))

  assert.equal(result.storyboard_id, 5)
  assert.equal(result.tts_audio_url, 'static/audio/dialogue.mp3')
  assert.equal(result.narration_audio_url, 'static/audio/narration.mp3')
  assert.ok(listTaskEvents(task.id).some(event => event.eventType === 'tts.completed'))
})

test('tts.character_sample handler delegates character voice sample generation', async () => {
  const handler = createTTSGenerateHandler({
    regenerateStoryboardAudio: async () => {
      throw new Error('should not be called')
    },
    generateCharacterVoiceSample: async (characterId: number, episodeId: number) => ({
      characterId,
      episodeId,
      voiceSampleUrl: 'static/audio/sample.mp3',
    }),
  })
  const task = createTask({
    type: 'tts.character_sample',
    payload: { character_id: 6, episode_id: 8 },
  })

  const result = await handler.run(makeContext(task))

  assert.equal(result.character_id, 6)
  assert.equal(result.episode_id, 8)
  assert.equal(result.voice_sample_url, 'static/audio/sample.mp3')
  assert.ok(listTaskEvents(task.id).some(event => event.eventType === 'tts.completed'))
})
