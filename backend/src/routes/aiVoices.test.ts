import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-ai-voices-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: aiVoicesRoute } = await import('./aiVoices.js')

const originalFetch = global.fetch
const configId = Number(db.insert(schema.aiServiceConfigs).values({
  serviceType: 'audio',
  provider: 'minimax',
  name: 'MiniMax test',
  baseUrl: 'https://api.minimaxi.com',
  apiKey: 'test-key',
  model: JSON.stringify(['speech-2.8-turbo']),
  isActive: true,
  createdAt: now(),
  updatedAt: now(),
}).run().lastInsertRowid)

test.after(() => {
  global.fetch = originalFetch
})

test('POST /design calls MiniMax Voice Design and persists generated voice', async () => {
  let requestUrl = ''
  let requestBody: any
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      voice_id: 'ttv-voice-test-001',
      trial_audio: '4949',
      base_resp: { status_code: 0, status_msg: 'success' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  const response = await aiVoicesRoute.request('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_id: configId,
      voice_name: '历史纪实男声',
      prompt: '成熟男性，低沉稳厚，标准普通话。',
      preview_text: '这是一段历史旁白。',
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(requestUrl, 'https://api.minimaxi.com/v1/voice_design')
  assert.deepEqual(requestBody, {
    prompt: '成熟男性，低沉稳厚，标准普通话。',
    preview_text: '这是一段历史旁白。',
    aigc_watermark: false,
  })

  const json = await response.json() as any
  assert.equal(json.data.voice_id, 'ttv-voice-test-001')
  assert.equal(json.data.voice_type, 'voice_generation')
  assert.equal(json.data.trial_audio_url, 'data:audio/mpeg;base64,SUk=')

  const [row] = db.select().from(schema.aiVoices).all().filter(v => v.voiceId === 'ttv-voice-test-001')
  assert.equal(row.voiceName, '历史纪实男声')
  assert.equal(row.voiceType, 'voice_generation')
})

test('POST /sync imports all returned voice types without deleting generated voices', async () => {
  const ts = now()
  db.insert(schema.aiVoices).values([
    {
      voiceId: 'old-system',
      voiceName: '旧系统音色',
      description: '[]',
      language: '中文',
      provider: 'minimax',
      voiceType: 'system',
      createdAt: ts,
    },
    {
      voiceId: 'local-generated',
      voiceName: '本地生成音色',
      description: '["保留"]',
      language: '中文',
      provider: 'minimax',
      voiceType: 'voice_generation',
      createdAt: ts,
    },
  ]).run()

  global.fetch = (async () => new Response(JSON.stringify({
    system_voice: [
      { voice_id: 'Chinese (Mandarin)_Reliable_Executive', voice_name: '沉稳高管', description: ['沉稳男性'] },
      { voice_id: 'English_Radio_Host', voice_name: 'English host', description: ['English'] },
    ],
    voice_generation: [
      { voice_id: 'remote-generated', description: ['远端生成音色'], created_time: '2026-07-12' },
    ],
    voice_cloning: [
      { voice_id: 'remote-cloned', description: ['远端复刻音色'], created_time: '2026-07-12' },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200 })) as typeof fetch

  const response = await aiVoicesRoute.request('/sync', { method: 'POST' })
  assert.equal(response.status, 200)
  const json = await response.json() as any
  assert.deepEqual(json.data.counts, { system: 1, voice_generation: 1, voice_cloning: 1 })

  const rows = db.select().from(schema.aiVoices).all()
  assert.equal(rows.some(v => v.voiceId === 'old-system'), false)
  assert.equal(rows.some(v => v.voiceId === 'local-generated'), true)
  assert.equal(rows.find(v => v.voiceId === 'remote-generated')?.voiceType, 'voice_generation')
  assert.equal(rows.find(v => v.voiceId === 'remote-cloned')?.voiceType, 'voice_cloning')
})

test('POST /design returns MiniMax API errors without writing a voice', async () => {
  global.fetch = (async () => new Response(JSON.stringify({
    base_resp: { status_code: 1004, status_msg: 'invalid prompt' },
  }), { status: 200 })) as typeof fetch

  const response = await aiVoicesRoute.request('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_id: configId,
      prompt: 'bad',
      preview_text: '试听',
    }),
  })

  assert.equal(response.status, 400)
  const json = await response.json() as any
  assert.equal(json.message, 'invalid prompt')
  assert.equal(db.select().from(schema.aiVoices).all().some(v => v.voiceId === 'invalid-prompt'), false)
})
