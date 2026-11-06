import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { publishingPackageFingerprint } from '../../remotion-dharma-factory/scripts/dharma_publishing_package.mjs'

import {
  assertSpokenBodyContract,
  extractConfirmedTitleAndBody,
  findSpokenBodyViolation,
  parseArgs,
  requireExplicitStyle,
  resolveDramaForIntake,
  resolvePublishingPackagePath,
  retryFailedPreTts,
} from './history_intake.mjs'

function jsonResponse(code, data, status = code === 201 ? 201 : 200) {
  return new Response(JSON.stringify({ code, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('script-only intake creates drama and carries the confirmed title into the series', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/dramas?page=1&page_size=1000')) return jsonResponse(200, { items: [] })
    if (String(url).endsWith('/dramas') && (init.method || 'GET') === 'POST') {
      return jsonResponse(201, { id: 42, title: '确认标题', style: 'cold_eastern_epic' })
    }
    if (String(url).endsWith('/dramas/42')) {
      return jsonResponse(200, { id: 42, title: '确认标题', style: 'cold_eastern_epic', episodes: [] })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  try {
    const result = await resolveDramaForIntake({
      options: { create_drama: true, style: 'cold_eastern_epic' },
      title: '确认标题',
      scriptSha: 'body-hash',
    })
    assert.equal(result.dramaId, 42)
    assert.equal(result.drama.title, '确认标题')
    assert.equal(result.dramaCreated, true)
    const createCall = calls.find((call) => call.method === 'POST')
    assert.deepEqual(createCall.body, {
      title: '确认标题',
      genre: 'history',
      style: 'cold_eastern_epic',
      total_episodes: 0,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('script-only intake reuses the drama containing the same normalized manuscript body', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' })
    if (String(url).endsWith('/dramas?page=1&page_size=1000')) {
      return jsonResponse(200, {
        items: [{
          id: 9,
          title: '旧系列',
          style: 'historical_systems',
          episodes: [{ id: 12, script_content: '正文' }],
        }],
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  try {
    const result = await resolveDramaForIntake({
      options: { create_drama: true },
      title: '新确认标题',
      scriptSha: sha256('正文'),
    })
    assert.equal(result.dramaId, 9)
    assert.equal(result.existingEpisode.id, 12)
    assert.equal(result.dramaCreated, false)
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('new drama intake requires a user-selected style instead of a default', () => {
  assert.equal(requireExplicitStyle({ style: 'period_crime_35mm' }), 'period_crime_35mm')
  assert.throws(() => requireExplicitStyle({}), /new drama style is required/u)
  assert.throws(() => requireExplicitStyle({ style: '  ' }), /new drama style is required/u)
})

test('history intake resolves the default publishing package beside the final script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-intake-package-'))
  try {
    const scriptPath = join(dir, '05-final-script.md')
    const packagePath = join(dir, '07-publishing-package.json')
    writeFileSync(scriptPath, '---\ntitle: "标题"\n---\n正文')
    writeFileSync(packagePath, '{}')
    assert.equal(resolvePublishingPackagePath(scriptPath), packagePath)
    assert.equal(resolvePublishingPackagePath(scriptPath, './custom-package.json'), join(process.cwd(), 'custom-package.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('confirmed title frontmatter stays out of the spoken body', () => {
  const manuscript = extractConfirmedTitleAndBody('---\ntitle: "确认标题"\n---\n\n玉壁城下，东魏大军已经围了很久。')
  assert.equal(manuscript.title, '确认标题')
  assert.equal(assertSpokenBodyContract(manuscript.body).trim(), '玉壁城下，东魏大军已经围了很久。')
  assert.doesNotMatch(manuscript.body, /最终稿/u)
})

test('spoken body rejects Markdown headings and production metadata before TTS', () => {
  const cases = [
    ['\n# 最终稿\n\n正文', /Markdown heading/u],
    ['\n口播正文：\n正文', /production metadata label/u],
    ['\ncreative_brief: {}\n正文', /production metadata label/u],
  ]
  for (const [body, message] of cases) {
    assert.match(String(findSpokenBodyViolation(body)?.kind), message)
    assert.throws(() => assertSpokenBodyContract(body), message)
  }
})

test('explicit pre-TTS recovery creates one task through the production endpoint and preserves failed history', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null })
    if (init.method === 'GET') return jsonResponse(200, [{ id: 9, status: 'failed' }])
    return jsonResponse(200, { task_id: 10, status: 'queued' })
  })
  assert.deepEqual(await retryFailedPreTts(42), { requested: true, task_id: 10, status: 'queued' })
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.endsWith('/tasks?episode_id=42&type=tts.pre_generate'))
  assert.ok(calls[1].url.endsWith('/episodes/42/regenerate-production'))
  assert.deepEqual(calls[1].body, { force: false })
})

test('pre-TTS recovery does not duplicate a newer running or completed task', async (t) => {
  for (const status of ['queued', 'running', 'succeeded']) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      calls++
      assert.equal(init.method, 'GET')
      return jsonResponse(200, [{ id: 10, status }, { id: 9, status: 'failed' }])
    })
    assert.deepEqual(await retryFailedPreTts(42), { requested: false, task_id: 10, status })
    assert.equal(calls, 1)
    t.mock.restoreAll()
  }
})

test('pre-TTS recovery reports a rejected recovery request without pretending it was queued', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'GET') return jsonResponse(200, [{ id: 9, status: 'failed' }])
    return new Response(JSON.stringify({ code: 409, message: 'Production tasks are still running' }), { status: 409 })
  })
  await assert.rejects(retryFailedPreTts(42), /Production tasks are still running/)
})

test('source-only is an explicit boolean option and does not change the legacy default', () => {
  assert.equal(parseArgs(['--script', 'script.md', '--source-only']).source_only, true)
  assert.equal(parseArgs(['--script', 'script.md']).source_only, undefined)
})

// Exercise the actual CLI against an isolated HTTP backend. No production API, DB, TTS, or
// renderer is touched; unexpected routes fail the test instead of being silently accepted.
async function runSourceOnlyFixture(t, { corruptReadback, existingMismatch = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'history-source-only-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const scriptPath = join(dir, '05-final-script.md')
  const manuscript = '皇帝收回权力。和珅被困宫中。'
  writeFileSync(scriptPath, `---\ntitle: "确认标题"\n---\n${manuscript}\n`)
  const publishingPackage = {
    schema_version: 'dharma-publishing-package/v1',
    title: '确认标题',
    opening_hook: '他为何突然失去权力？',
    cliffhanger: '皇帝下一步将如何行动？',
    creative_brief: { subject: '和珅' },
    cover_design: { main_title: '权力易手', ai_prompt: '宫门外的历史人物' },
  }
  writeFileSync(join(dir, '07-publishing-package.json'), JSON.stringify(publishingPackage))
  const calls = []
  const unexpected = []
  const episode = {
    id: 73, drama_id: 42, title: '确认标题', workflow_type: 'direct_script',
    script_content: existingMismatch ? '另一篇完全不同的稿件。' : manuscript,
    pre_tts_audio_url: 'static/audio/master.mp3',
    pre_tts_titles_json: JSON.stringify([
      { text: '皇帝收回权力。', text_begin: 0, time_begin: 0, time_end: 2200 },
      { text: '和珅被困宫中。', text_begin: 7, time_begin: 2200, time_end: 4500 },
    ]),
    metadata: {},
  }
  const storyboards = [
    { id: 91, storyboard_number: 1, narration: '皇帝收回权力。', duration: 3 },
    { id: 92, storyboard_number: 2, narration: '和珅被困宫中。', duration: 3 },
  ]
  const drama = {
    id: 42, title: '历史系列', style: 'cold_eastern_epic',
    // A donor would trigger legacy BGM inheritance, but must not be used by source-only.
    episodes: [{ id: 10, episode_number: 1, script_content: '旧稿', bgm_audio_url: 'static/music/donor.mp3' }],
  }
  let splitComplete = false
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    calls.push({ method: req.method, path: req.url, body })
    const reply = (data, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code, data }))
    }
    if (req.url === '/api/v1/health') return reply({ healthy: true })
    if (req.method === 'GET' && req.url === '/api/v1/dramas/42') return reply(drama)
    if (req.method === 'POST' && req.url === '/api/v1/dramas/42/import-script') return reply({ episodes: [{ id: 73 }] }, 201)
    if (req.method === 'GET' && req.url === '/api/v1/episodes/73') {
      const readback = structuredClone(episode)
      if (splitComplete) corruptReadback?.(readback, storyboards)
      return reply(readback)
    }
    if (req.method === 'PUT' && req.url === '/api/v1/episodes/73' && body?.publishing_package) {
      episode.metadata.dharmaPublishing = {
        package: body.publishing_package,
        package_sha256: publishingPackageFingerprint(body.publishing_package),
      }
      return reply(episode)
    }
    if (req.method === 'GET' && req.url === '/api/v1/tasks?episode_id=73&active_only=true') return reply([])
    if (req.method === 'POST' && req.url === '/api/v1/episodes/73/storyboards:break-deterministic') {
      splitComplete = true
      return reply({ storyboard_count: 2, total_chars: 12, script_chars: 12, coverage_verified: true, max_duration_sec: 3 })
    }
    if (req.method === 'GET' && req.url === '/api/v1/episodes/73/storyboards') return reply(storyboards)
    unexpected.push(`${req.method} ${req.url}`)
    return reply({ error: 'unexpected route' }, 500)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const args = [fileURLToPath(new URL('./history_intake.mjs', import.meta.url)), '--script', scriptPath,
    '--source-only', ...(existingMismatch ? ['--episode', '73'] : ['--drama', '42']),
    '--bgm', 'static/music/must-not-be-written.mp3']
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, DB_PATH: join(dir, 'absent.db') },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  assert.deepEqual(unexpected, [], result.stderr)
  return { ...result, output: JSON.parse(result.stdout.trim()), calls }
}

test('source-only CLI imports and verifies sources without projects, narrative hierarchy or BGM writes', async (t) => {
  const result = await runSourceOnlyFixture(t)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.output.status, 'source-ready')
  assert.equal(result.output.production_complete, false)
  assert.equal(result.output.next_skill, 'videoeditor')
  assert.equal(result.output.layout, 'full-frame')
  assert.equal(result.output.episode_id, 73)
  assert.equal(result.output.drama_id, 42)
  assert.equal(result.output.storyboard_count, 2)
  assert.deepEqual(result.output.pre_tts, { ok: true, audio_url: 'static/audio/master.mp3', title_count: 2, duration_ms: 4500 })
  assert.ok(Object.values(result.output.contract).every((check) => check.ok))
  assert.ok(result.calls.some((call) => call.method === 'POST' && call.path.endsWith('/import-script')))
  assert.ok(result.calls.some((call) => call.method === 'POST' && call.path.endsWith('/storyboards:break-deterministic')))
  assert.equal(result.calls.filter((call) => call.path.includes('/remotion/')).length, 0)
  assert.equal(result.calls.filter((call) => call.body && Object.hasOwn(call.body, 'bgm_audio_url')).length, 0)
})

test('source-only CLI rejects stale readback even when deterministic split reports success', async (t) => {
  const cases = [
    ['publishing_package', (episode) => { episode.metadata.dharmaPublishing.package.cover_design.main_title = '被替换' }],
    ['pre_tts', (episode) => { episode.pre_tts_titles_json = JSON.stringify([{ text: '旧稿', time_begin: 0, time_end: 2000 }]) }],
    ['pre_tts', (episode) => { episode.pre_tts_titles_json = JSON.stringify([{ text: '皇帝收回权力。和珅被困宫中。', time_begin: 2000, time_end: 1000 }]) }],
    ['storyboards', (_episode, storyboards) => { storyboards[1].narration = '来自另一版稿件。' }],
  ]
  for (const [field, corruptReadback] of cases) {
    await t.test(field, async (subtest) => {
      const result = await runSourceOnlyFixture(subtest, { corruptReadback })
      assert.equal(result.code, 1, result.stderr)
      assert.equal(result.output.status, 'source-not-ready')
      assert.equal(result.output.contract[field].ok, false)
      assert.equal(result.output.next_skill, null)
      assert.equal(result.output.production_complete, false)
      assert.equal(result.calls.filter((call) => call.path.includes('/remotion/')).length, 0)
    })
  }
})

test('source-only refuses a different explicit episode manuscript before any mutation', async (t) => {
  const result = await runSourceOnlyFixture(t, { existingMismatch: true })
  assert.equal(result.code, 1, result.stderr)
  assert.match(result.output.error, /manuscript does not match/)
  assert.equal(result.calls.filter((call) => call.method !== 'GET').length, 0)
})
