import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-tts-generation-'))
process.env.DB_PATH = path.join(directory, 'test.db')
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.TTS_GENERATION_INTERVAL_CAP = '1000'
const { db, schema } = await import('../db/index.js')
const { generateTTSWithMetadata } = await import('./tts-generation.js')
const { generateEpisodePreTTS } = await import('./episode-tts.js')
const { splitQwenTTSText, synthesizeQwenTTS } = await import('./qwen-tts-generation.js')
const { resolveDefaultNarrationVoiceId } = await import('./qwen3-voice.js')
const { eq } = await import('drizzle-orm')
const originalFetch = globalThis.fetch
const model = 'qwen-audio-3.1-tts-flash'
const voice = `${model}-testclone`
const timestamp = new Date().toISOString()
const configId = Number(db.insert(schema.aiServiceConfigs).values({ serviceType: 'audio', provider: 'qwen-tts', name: 'Qwen fixture',
  baseUrl: 'https://dashscope.example/api/v1', apiKey: 'test-key', model: JSON.stringify([model]), isActive: true, priority: 10,
  settings: JSON.stringify({ useForNarration: true, narrationVoiceId: voice, instruction: '请用中文讲述，紧张、克制、带有悬念。' }),
  createdAt: timestamp, updatedAt: timestamp }).run().lastInsertRowid)
const config = { provider: 'qwen-tts', baseUrl: 'https://dashscope.example/api/v1', apiKey: 'test-key', model,
  settings: { narrationVoiceId: voice, instruction: '请用中文讲述，紧张、克制、带有悬念。' } }
const wav = path.join(directory, 'sample.wav')
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-ar', '24000', '-ac', '1', wav])
const audio = fs.readFileSync(wav)
test.after(() => { globalThis.fetch = originalFetch; db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })

function mockProvider(onText: (text: string, body: any) => void) {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/customization')) return Response.json({ output: { status: 'OK', target_model: model } })
    if (String(url).endsWith('/SpeechSynthesizer')) {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.input.voice, voice)
      assert.equal(body.input.instruction, '请用中文讲述，紧张、克制、带有悬念。')
      onText(body.input.text, body)
      return Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://result.example/audio.wav' } } })
    }
    assert.equal(String(url), 'https://result.example/audio.wav')
    assert.equal(new Headers(init?.headers).get('Authorization'), null)
    return new Response(audio)
  }
}

test('Qwen resolves provider-specific defaults and maps a legacy MiniMax episode voice to its configured clone', async () => {
  assert.equal(resolveDefaultNarrationVoiceId('qwen-tts'), voice)
  const sent: string[] = []
  mockProvider(text => { sent.push(text) })
  const result = await generateTTSWithMetadata({ configId, text: '一段历史正文。', voice: 'ttv-voice-old-minimax', speed: 1.1 })
  assert.deepEqual(sent, ['一段历史正文。'])
  const saved = path.join(process.env.STORAGE_PATH!, result.audioUrl.replace(/^static\//, ''))
  assert.ok(fs.statSync(saved).size > 0)
  assert.ok(Number(result.extra?.audio_length) > 0)
})

test('long Qwen narration preserves all text and paid chunks survive a later failure and retry', async () => {
  const text = Array.from({ length: 130 }, (_, index) => `第${index + 1}段，这是需要完整保留的历史正文。`).join('')
  const sent: string[] = []
  let fail = true
  mockProvider(part => {
    sent.push(part)
    if (sent.length === 2 && fail) { fail = false; throw new Error('temporary synthesis failure') }
  })
  const params = { configId, text, voice }
  await assert.rejects(generateTTSWithMetadata(params), /temporary synthesis failure/)
  const paidFirst = sent[0]!
  const result = await generateTTSWithMetadata(params)
  assert.equal(sent.filter(part => part === paidFirst).length, 1)
  const successful = [paidFirst, ...sent.slice(2)]
  assert.equal(successful.join(''), text)
  assert.ok(successful.every(part => Array.from(part).length <= 1000))
  assert.ok(Number(result.extra?.audio_length) > 0)
  const submissions = sent.length
  await generateTTSWithMetadata(params)
  assert.equal(sent.length, submissions, 'A completed narration reuses all provider chunks')
})

test('Qwen text splitting preserves Unicode code points and all source characters', () => {
  const rareHan = String.fromCodePoint(0x20bb7), symbol = String.fromCodePoint(0x1d11e)
  const text = `${'史'.repeat(999)}${rareHan}${'文'.repeat(999)}${symbol}${'正文。'.repeat(401)}`
  const chunks = splitQwenTTSText(text)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 1000))
  assert.ok(chunks.every(chunk => Array.from(chunk).every(character => !/^[\uD800-\uDFFF]$/.test(character))))
})

test('identical Qwen synthesis still shares work for a shared signal or two uncancellable callers', async () => {
  for (const signal of [undefined, new AbortController().signal]) {
    let submissions = 0
    mockProvider(() => { submissions++ })
    const params = { text: `共用取消范围${signal ? '相同信号' : '没有信号'}的并发合成。`, voice }
    const results = await Promise.all([synthesizeQwenTTS(config, params, { signal }), synthesizeQwenTTS(config, params, { signal })])
    assert.equal(submissions, 1)
    assert.equal(results[0]!.audioHex, results[1]!.audioHex)
  }
})

for (const cancelledIndex of [0, 1]) {
  test(`concurrent identical Qwen synthesis with distinct signals isolates cancellation of caller ${cancelledIndex + 1}`, async () => {
    const controllers = [new AbortController(), new AbortController()]
    const requests: Array<{ signal: AbortSignal; complete: () => void }> = []
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/customization')) return Response.json({ output: { status: 'OK', target_model: model } })
      if (String(url).endsWith('/SpeechSynthesizer')) {
        const signal = init?.signal
        assert.ok(signal)
        signal.throwIfAborted()
        return new Promise<Response>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          requests.push({ signal, complete: () => {
            signal.removeEventListener('abort', abort)
            resolve(Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://result.example/audio.wav' } } }))
          } })
        })
      }
      assert.equal(String(url), 'https://result.example/audio.wav')
      return new Response(audio)
    }
    const params = { text: `并发取消隔离测试，第${cancelledIndex + 1}组。`, voice }
    const runs = controllers.map(controller => synthesizeQwenTTS(config, params, { signal: controller.signal }))
    for (const run of runs) void run.catch(() => {})
    try {
      for (let attempt = 0; requests.length < 2 && attempt < 100; attempt++) await delay(10)
      assert.equal(requests.length, 2, 'Independent cancellation scopes must have independent provider requests')
      controllers[cancelledIndex]!.abort(new Error('Cancelled only this narration'))
      await assert.rejects(runs[cancelledIndex]!, /Cancelled only this narration/)
      const survivor = requests.filter(request => !request.signal.aborted)
      assert.equal(survivor.length, 1)
      survivor[0]!.complete()
      const result = await runs[1 - cancelledIndex]!
      assert.ok(result.audioLength > 0)
      mockProvider(() => assert.fail('The surviving synthesis must retain its stable content cache'))
      await synthesizeQwenTTS(config, params)
    } finally {
      for (const controller of controllers) controller.abort(new Error('Test cleanup'))
      for (const request of requests) request.complete()
      await Promise.allSettled(runs)
    }
  })
}

test('episode pre-TTS uses cloud Qwen with its own voice and a truthful WAV extension', async () => {
  const dramaId = Number(db.insert(schema.dramas).values({ title: 'Fixture', createdAt: timestamp, updatedAt: timestamp }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Fixture',
    workflowType: 'direct_script', content: '整集配音不能再误用 MiniMax 接口。', narrationVoiceId: 'ttv-voice-legacy',
    createdAt: timestamp, updatedAt: timestamp }).run().lastInsertRowid)
  mockProvider(() => {})
  const result = await generateEpisodePreTTS(episodeId)
  assert.match(result.audioUrl, /\.wav$/)
  const stored = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()!
  assert.equal(stored.preTtsAudioUrl, result.audioUrl)
  assert.ok(result.extra.audio_length > 0)
})
