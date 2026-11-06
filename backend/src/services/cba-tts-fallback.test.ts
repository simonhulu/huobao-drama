import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { prepareCbaTtsFallback, type CbaTtsFallbackDependencies } from './cba-tts-fallback.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const quota = 'Narration n2 failed: MiniMax 2056: 已达到 Token Plan 用量上限'
const model = 'qwen-audio-3.1-tts-flash'
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-tts-fallback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'job.json'), audio = path.join(directory, 'old-audio.wav')
  fs.writeFileSync(audio, 'old audio retained')
  const tts = { configId: 21, model: 'speech-2.8-hd', voice: 'Chinese (Mandarin)_Radio_Host', speed: 1.08, emotion: 'fluent' }
  const job: any = { version: 1, profile: { editions: ['news'] }, tts, status: 'approved',
    news: { segments: ['n1', 'n2'].map(id => ({ id, mode: 'narration', text: `${id}测试口播`, audioPath: audio,
      audioDigest: { request: digest({ text: `${id}测试口播`, tts }), sha256: digest('old-audio') } })) },
    review: { digest: 'old-editorial', complete: true }, approval: { digest: 'old-editorial' }, outputs: { news: { path: 'old.mp4' } },
    automation: { producerRunId: 'old-producer', requireAudit: true, audit: { reviewer: { runId: 'old-reviewer' }, editorialDigest: 'old-editorial' } } }
  const config = { id: 73, provider: 'qwen-tts', model, baseUrl: 'https://qwen.example.test', apiKey: 'private-fixture-key',
    settings: { useForNarration: true, narrationVoiceId: `${model}-sports-clone`, instruction: '其他业务的说明' } }
  let voiceCalls = 0
  const deps: CbaTtsFallbackDependencies = {
    getSourceConfig: () => ({ provider: 'minimax', model: tts.model, baseUrl: 'https://minimax.example.test', apiKey: 'fixture' }),
    getNarrationConfig: () => config,
    queryVoice: async (_config, voice) => { voiceCalls++; assert.equal(voice, config.settings.narrationVoiceId); return { status: 'OK', target_model: model } },
  }
  const write = () => fs.writeFileSync(file, JSON.stringify(job))
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  function failure() {
    fs.writeFileSync(path.join(directory, 'narration-error.json'), JSON.stringify({ segmentId: 'n2', configId: 21, failedAt: '2026-11-02T00:00:01.000Z',
      requestDigest: digest({ text: job.news.segments[1].text, tts: job.tts }), message: quota }))
    fs.writeFileSync(path.join(directory, 'production.json'), JSON.stringify({ status: 'attention', runId: 'old-run',
      attempts: [{ step: 'tts', status: 'failed', runId: 'old-run', message: quota,
        startedAt: '2026-11-02T00:00:00.000Z', finishedAt: '2026-11-02T00:00:02.000Z' }] }))
  }
  write()
  return { directory, file, audio, job, config, deps, write, read, failure, voiceCalls: () => voiceCalls }
}

test('Qwen fallback changes the actual job config, invalidates approval and every narration cache, preserving files and history', async t => {
  const f = fixture(t), originalConfig = structuredClone(f.config), old = structuredClone(f.job)
  const result = await prepareCbaTtsFallback(f.directory, { runId: 'recovery', reason: quota }, f.deps)
  assert.equal(result.switched, true)
  const job = f.read()
  assert.equal(job.tts.configId, 73); assert.equal(job.tts.model, model)
  assert.equal(job.tts.voice, f.config.settings.narrationVoiceId); assert.equal(job.tts.speed, 1.08)
  assert.equal(job.tts.emotion, undefined); assert.match(job.tts.instruction, /体育新闻.*只朗读正文/)
  assert.equal(job.approval, null); assert.equal(job.review, null); assert.equal(job.outputs, null)
  assert.equal(job.automation.audit, undefined); assert.equal(job.automation.requireAudit, true)
  assert.equal(job.automation.producerRunId, 'old-producer')
  assert.deepEqual(job.automation.ttsFallback.from.tts, old.tts)
  assert.deepEqual(job.automation.ttsFallback.previousAudit, old.automation.audit)
  assert.deepEqual(job.automation.ttsFallback.previousApproval, old.approval)
  assert.deepEqual(job.automation.ttsFallback.previousOutputs, old.outputs)
  assert.match(job.automation.ttsFallback.reason, /2056/)
  assert.equal(job.automation.ttsFallback.runId, 'recovery')
  for (const segment of job.news.segments) {
    assert.notEqual(segment.audioDigest.request, digest({ text: segment.text, tts: job.tts }))
    assert.equal(segment.audioPath, f.audio)
  }
  assert.equal(fs.readFileSync(f.audio, 'utf8'), 'old audio retained')
  assert.deepEqual(f.config, originalConfig, 'global settings and other businesses must not change')
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /private-fixture-key/)
  const { generateNarrations } = await import(new URL('../../../scripts/cba-video/narration.mjs', import.meta.url).href)
  let paidCalls = 0
  await assert.rejects(generateNarrations({ jobDir: f.directory, storageRoot: f.directory, generate: async () => { paidCalls++ } }), /audit/i)
  assert.equal(paidCalls, 0, 'new config must pass an independent review before paid generation')
  assert.equal((await prepareCbaTtsFallback(f.directory, { runId: 'again', reason: quota }, f.deps)).switched, false)
  assert.equal(f.voiceCalls(), 1)
})

test('fallback preflight requires a matching current narration failure and the latest failed production step', async t => {
  for (const kind of ['current', 'changed-text', 'changed-config', 'later-render', 'no-journal', 'completed']) await t.test(kind, async sub => {
    const f = fixture(sub); f.failure()
    if (kind === 'changed-text') { f.job.news.segments[1].text += '新内容'; f.write() }
    if (kind === 'changed-config') { f.job.tts.configId = 22; f.write() }
    if (kind === 'no-journal') fs.unlinkSync(path.join(f.directory, 'production.json'))
    if (kind === 'later-render' || kind === 'completed') fs.writeFileSync(path.join(f.directory, 'production.json'), JSON.stringify({
      status: kind === 'completed' ? 'ready' : 'attention', attempts: [{ step: 'render', status: kind === 'completed' ? 'completed' : 'failed' }],
    }))
    const before = fs.readFileSync(f.file, 'utf8')
    assert.equal((await prepareCbaTtsFallback(f.directory, { runId: 'preflight' }, f.deps)).switched, kind === 'current')
    if (kind !== 'current') { assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.voiceCalls(), 0) }
  })
})

test('persisted MiniMax evidence must belong to the latest failed TTS attempt, including its time and account error', async t => {
  for (const kind of ['matching-generic-exit', 'old-failure-time', 'after-attempt-time', 'missing-failure-time', 'missing-attempt-time', 'latest-timeout', 'latest-ffprobe', 'latest-approval']) await t.test(kind, async sub => {
    const f = fixture(sub); f.failure()
    const errorFile = path.join(f.directory, 'narration-error.json'), journalFile = path.join(f.directory, 'production.json')
    const failure = JSON.parse(fs.readFileSync(errorFile, 'utf8')), journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
    if (kind === 'matching-generic-exit') journal.attempts[0].message = '当前生产步骤退出（1），已保留结果和尝试记录'
    if (kind === 'old-failure-time') failure.failedAt = '2026-11-01T23:59:00.000Z'
    if (kind === 'after-attempt-time') failure.failedAt = '2026-11-02T00:00:03.000Z'
    if (kind === 'missing-failure-time') delete failure.failedAt
    if (kind === 'missing-attempt-time') delete journal.attempts[0].startedAt
    if (kind === 'latest-timeout') journal.attempts[0].message = 'MiniMax request timeout'
    if (kind === 'latest-ffprobe') journal.attempts[0].message = 'ffprobe is unavailable; install FFmpeg before generating narration'
    if (kind === 'latest-approval') journal.attempts[0].message = 'User approval of the current script is required before TTS/render'
    fs.writeFileSync(errorFile, JSON.stringify(failure)); fs.writeFileSync(journalFile, JSON.stringify(journal))
    const before = fs.readFileSync(f.file, 'utf8')
    assert.equal((await prepareCbaTtsFallback(f.directory, { runId: 'check-current-attempt' }, f.deps)).switched, kind === 'matching-generic-exit')
    if (kind !== 'matching-generic-exit') { assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.voiceCalls(), 0) }
  })
})

test('fallback rejects transient failures, non-MiniMax providers and unavailable or incompatible Qwen settings without changing the job', async t => {
  for (const kind of ['timeout', 'rate-limit', 'voice-permission', 'other-provider', 'missing-source-config', 'missing-config', 'inactive-selection', 'wrong-model', 'missing-voice', 'deploying', 'wrong-voice-model', 'voice-query-failed']) await t.test(kind, async sub => {
    const f = fixture(sub)
    let reason = quota
    if (kind === 'timeout') reason = 'MiniMax request timeout'
    if (kind === 'rate-limit') reason = 'HTTP 429: 请求频率受限'
    if (kind === 'voice-permission') reason = 'MiniMax 2042: 无权访问当前音色'
    if (kind === 'other-provider') f.deps.getSourceConfig = () => ({ ...f.config, provider: 'other' })
    if (kind === 'missing-source-config') f.deps.getSourceConfig = () => null
    if (kind === 'missing-config') f.deps.getNarrationConfig = () => null
    if (kind === 'inactive-selection') f.config.settings.useForNarration = false
    if (kind === 'wrong-model') f.config.model = 'unsupported-model'
    if (kind === 'missing-voice') f.config.settings.narrationVoiceId = ''
    if (kind === 'deploying') f.deps.queryVoice = async () => ({ status: 'DEPLOYING', target_model: model })
    if (kind === 'wrong-voice-model') f.deps.queryVoice = async () => ({ status: 'OK', target_model: 'other-model' })
    if (kind === 'voice-query-failed') f.deps.queryVoice = async () => { throw Error('voice lookup failed') }
    const before = fs.readFileSync(f.file, 'utf8')
    assert.equal((await prepareCbaTtsFallback(f.directory, { runId: 'unsupported', reason }, f.deps)).switched, false)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  })
})

test('an explicitly selected built-in Qwen voice skips the clone-only lookup', async t => {
  const f = fixture(t)
  f.config.settings.narrationVoiceId = 'longanhuan_v3.1'
  assert.equal((await prepareCbaTtsFallback(f.directory, { runId: 'system-voice', reason: quota }, f.deps)).switched, true)
  assert.equal(f.voiceCalls(), 0)
  assert.equal(f.read().tts.voice, 'longanhuan_v3.1')
})

test('fallback respects an active production lock, cancellation and edits made while checking the voice', async t => {
  for (const kind of ['locked', 'stopped', 'stopped-during-check', 'edited-during-check']) await t.test(kind, async sub => {
    const f = fixture(sub); let stopped = kind === 'stopped'
    f.deps.stopped = () => stopped
    if (kind === 'locked') fs.writeFileSync(path.join(f.directory, '.production.lock'), String(process.pid))
    f.deps.queryVoice = async () => {
      if (kind === 'stopped-during-check') stopped = true
      if (kind === 'edited-during-check') { f.job.news.segments[0].text = '外部保存的新稿'; f.write() }
      return { status: 'OK', target_model: model }
    }
    const result = await prepareCbaTtsFallback(f.directory, { runId: 'cancelled', reason: quota }, f.deps)
    assert.equal(result.switched, false); assert.equal(f.read().tts.configId, 21)
    assert.equal(fs.existsSync(path.join(f.directory, '.production.lock')), kind === 'locked')
    if (kind === 'edited-during-check') assert.equal(f.read().news.segments[0].text, '外部保存的新稿')
  })
})

test('only explicitly authorized recovery can switch a task with a missing historic error without inventing its cause', async t => {
  const f = fixture(t), reason = '用户授权使用已核验备用恢复；本条原始失败原因未知'
  assert.equal((await prepareCbaTtsFallback(f.directory, { runId: 'normal', reason }, f.deps)).switched, false)
  const result = await prepareCbaTtsFallback(f.directory, { runId: 'authorized', reason, authorizedRecovery: true }, f.deps)
  assert.equal(result.switched, true)
  assert.equal(f.read().automation.ttsFallback.trigger, 'authorized-recovery')
  assert.equal(f.read().automation.ttsFallback.reason, reason)
  assert.doesNotMatch(f.read().automation.ttsFallback.reason, /2056/)
})
