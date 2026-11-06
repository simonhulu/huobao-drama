import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const voices = ['reference-one', 'reference-two'].map((id, index) => ({ voice_id: id, voice_name: `参考音色${index + 1}`,
  description: ['历史说书男声'], language: '中文', voice_type: 'voice_cloning', provider: 'minimax' }))
const sample = Buffer.alloc(44 + 16000)
sample.write('RIFF', 0); sample.writeUInt32LE(sample.length - 8, 4); sample.write('WAVEfmt ', 8)
sample.writeUInt32LE(16, 16); sample.writeUInt16LE(1, 20); sample.writeUInt16LE(1, 22)
sample.writeUInt32LE(8000, 24); sample.writeUInt32LE(16000, 28); sample.writeUInt16LE(2, 32); sample.writeUInt16LE(16, 34)
sample.write('data', 36); sample.writeUInt32LE(16000, 40)

async function harness(t, {
  holdPreview = false, pendingPlay = false, previewError = '', viewport = { width: 1280, height: 900 },
  configs = [{ id: 4, name: 'MiniMax 试听', provider: 'minimax', is_active: true, settings: {}, model: '["speech-2.8-hd"]' }],
  voicesByConfig = { 4: voices }, initialVoiceName = '参考音色1',
} = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport })
  page.setDefaultTimeout(5000)
  await page.addInitScript(pending => {
    sessionStorage.clear()
    HTMLMediaElement.prototype.play = pending ? () => new Promise(() => {}) : () => Promise.resolve()
    HTMLMediaElement.prototype.pause = () => {}
  }, pendingPlay)
  const state = { writes: [], defaults: [], available: [], held: [] }
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const send = data => route.fulfill({ json: { code: 200, data } })
    if (path === '/api/v1/ai-configs') return send(configs)
    if (path === '/api/v1/ai-voices/available') {
      const configId = Number(new URL(request.url()).searchParams.get('config_id'))
      state.available.push(configId)
      return send({ voices: voicesByConfig[configId] || [], counts: { voice_cloning: (voicesByConfig[configId] || []).length }, config_id: configId })
    }
    if (path === '/api/v1/ai-voices/default') {
      state.defaults.push(request.postDataJSON())
      return send({ voice_id: request.postDataJSON().voice_id, config_id: request.postDataJSON().config_id })
    }
    if (path === '/api/v1/ai-voices/preview') {
      state.writes.push(request.postDataJSON())
      if (holdPreview) { state.held.push(route); return }
      if (previewError) return route.fulfill({ status: 400, json: { code: 400, message: previewError } })
      return send({ audio_url: 'static/audio/voice-test.m4a' })
    }
    if (path === '/api/v1/tasks') return send([])
    if (path === '/api/v1/health/workers') return send({ workers: [], healthy_count: 1, total_count: 1 })
    return send({ items: [] })
  })
  await page.route('**/static/audio/**', route => route.fulfill({ contentType: 'audio/wav', body: sample }))
  await page.goto(`${base}/library?tab=voices`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: `试听 ${initialVoiceName}`, exact: true }).waitFor()
  return { page, state }
}

const qwenVoice = { voice_id: 'qwen-cloned-narrator', voice_name: '百炼复刻说书声', description: ['成熟、有情绪起伏的叙事男声'],
  language: '中文', voice_type: 'voice_cloning', provider: 'qwen-tts' }
const multiProviderConfigs = [
  { id: 4, name: 'MiniMax 试听', provider: 'minimax', is_active: true, settings: {}, model: ['speech-2.8-hd'] },
  { id: 8, name: '百炼云端配音', provider: 'qwen-tts', is_active: true, settings: { useForNarration: true }, model: ['qwen-audio-3.1-tts-flash'] },
  { id: 9, name: '本地 Qwen3', provider: 'qwen3-tts', is_active: true, settings: {}, model: ['VoiceDesign-1.7B-8bit'] },
  { id: 10, name: '未启用百炼', provider: 'qwen-tts', is_active: false, settings: {}, model: ['qwen-audio-3.1-tts-flash'] },
]

test('cloud Qwen appears as its own active provider and never shows MiniMax voices', async t => {
  const { page, state } = await harness(t, {
    configs: multiProviderConfigs, voicesByConfig: { 4: voices, 8: [qwenVoice, ...voices] }, initialVoiceName: qwenVoice.voice_name,
  })
  await page.getByRole('heading', { name: '阿里云百炼 音色', exact: true }).waitFor()
  assert.equal(await page.locator('#voice-config').inputValue(), '8')
  assert.equal(await page.locator('#voice-config option').count(), 2)
  assert.equal(await page.getByRole('button', { name: '试听 参考音色1', exact: true }).count(), 0)
  assert.deepEqual(state.available, [8])
  await page.getByRole('button', { name: `试听 ${qwenVoice.voice_name}`, exact: true }).click()
  await page.getByRole('region', { name: '音色试听播放器' }).waitFor()
  assert.deepEqual(state.writes.map(({ config_id, voice_id }) => ({ config_id, voice_id })), [{ config_id: 8, voice_id: qwenVoice.voice_id }])
  await page.getByRole('button', { name: '设为解说默认', exact: true }).click()
  await page.getByRole('button', { name: '当前默认', exact: true }).waitFor()
  assert.deepEqual(state.defaults, [{ config_id: 8, voice_id: qwenVoice.voice_id }])
})

test('switching between Qwen and MiniMax clears the previous player and uses the selected provider', async t => {
  const { page, state } = await harness(t, {
    configs: multiProviderConfigs, voicesByConfig: { 4: voices, 8: [qwenVoice] }, initialVoiceName: qwenVoice.voice_name,
  })
  await page.getByRole('button', { name: `试听 ${qwenVoice.voice_name}`, exact: true }).click()
  await page.getByRole('region', { name: '音色试听播放器' }).waitFor()
  await page.locator('#voice-config').selectOption('4')
  await page.getByRole('heading', { name: 'MiniMax 音色', exact: true }).waitFor()
  await page.getByRole('button', { name: '试听 参考音色1', exact: true }).waitFor()
  assert.equal(await page.getByRole('region', { name: '音色试听播放器' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: `试听 ${qwenVoice.voice_name}`, exact: true }).count(), 0)
  await page.getByRole('button', { name: '试听 参考音色1', exact: true }).click()
  await page.getByRole('region', { name: '音色试听播放器' }).waitFor()
  assert.deepEqual(state.writes.map(({ config_id, voice_id }) => ({ config_id, voice_id })), [
    { config_id: 8, voice_id: qwenVoice.voice_id }, { config_id: 4, voice_id: 'reference-one' },
  ])
})

test('Qwen list errors name the selected supplier', async t => {
  const { page } = await harness(t, {
    configs: multiProviderConfigs, voicesByConfig: { 8: [qwenVoice] }, initialVoiceName: qwenVoice.voice_name,
  })
  await page.route('**/api/v1/ai-voices/available?**', route => route.fulfill({ status: 400, json: { code: 400, message: '音色查询失败' } }))
  await page.getByRole('button', { name: '刷新音色', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '读取阿里云百炼音色失败' }).waitFor()
  assert.equal(await page.getByRole('alert').filter({ hasText: '读取 MiniMax 音色失败' }).count(), 0)
})

test('audio settings offer separate cloud Qwen and local Qwen3 presets', async t => {
  const { page } = await harness(t)
  await page.goto(`${base}/settings`, { waitUntil: 'domcontentloaded' })
  await page.locator('.sections > section').filter({ has: page.locator('.section-title', { hasText: '音频' }) })
    .getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('heading', { name: '添加音频服务', exact: true }).waitFor()
  await page.getByRole('button', { name: '阿里云百炼 Qwen（云端）', exact: true }).click()
  assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'https://dashscope.aliyuncs.com/api/v1')
  assert.equal(await page.getByLabel('模型（逗号分隔）', { exact: true }).inputValue(), 'qwen-audio-3.1-tts-flash')
  assert.equal(await page.locator('.endpoint-hint .mono').textContent(), 'https://dashscope.aliyuncs.com/api/v1')
  await page.getByRole('button', { name: 'Qwen3-TTS 本地（免费）', exact: true }).click()
  assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'http://127.0.0.1:5987')
  assert.equal(await page.getByLabel('模型（逗号分隔）', { exact: true }).inputValue(), 'VoiceDesign-1.7B-8bit')
})

test('finished generation releases all preview controls even when browser play never resolves', async t => {
  const { page, state } = await harness(t, { pendingPlay: true })
  await page.getByRole('button', { name: '试听 参考音色1', exact: true }).click()
  await page.getByRole('region', { name: '音色试听播放器' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '试听 参考音色2', exact: true }).isEnabled(), true)
  assert.equal(await page.getByText('生成中…', { exact: true }).count(), 0)
  assert.equal(state.writes.length, 1)
})

test('a pending preview can stop waiting and another voice can be previewed', async t => {
  const { page, state } = await harness(t, { holdPreview: true })
  await page.getByRole('button', { name: '试听 参考音色1', exact: true }).click()
  const cancel = page.getByRole('button', { name: '取消等待 参考音色1', exact: true })
  await cancel.waitFor()
  assert.equal(await cancel.isEnabled(), true)
  await cancel.click()
  assert.equal(await page.getByRole('button', { name: '试听 参考音色1', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '试听 参考音色2', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: '试听 参考音色2', exact: true }).click()
  await page.getByRole('button', { name: '取消等待 参考音色2', exact: true }).waitFor()
  assert.deepEqual(state.writes.map(body => body.voice_id), ['reference-one', 'reference-two'])
})

test('provider failure shows a retryable error and clears the generation spinner', async t => {
  const { page, state } = await harness(t, { previewError: 'MiniMax 1008：音色不可用' })
  const preview = page.getByRole('button', { name: '试听 参考音色1', exact: true })
  await preview.click()
  await page.getByRole('alert').filter({ hasText: 'MiniMax 1008' }).waitFor()
  assert.equal(await preview.isEnabled(), true)
  await preview.click()
  assert.equal(state.writes.length, 2)
})

for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
  test(`the player can be closed without the task button intercepting at ${viewport.width}px`, async t => {
    const { page } = await harness(t, { viewport, pendingPlay: true })
    await page.getByRole('button', { name: '试听 参考音色1', exact: true }).click()
    const player = page.getByRole('region', { name: '音色试听播放器' })
    await player.waitFor()
    await player.scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await player.getByRole('button', { name: '关闭试听', exact: true }).click()
    assert.equal(await player.count(), 0)
  })
}
