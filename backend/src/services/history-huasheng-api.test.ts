import test from 'node:test'
import assert from 'node:assert/strict'
import { createHuashengProjectApiClient, driveHuashengApiJob, huashengCreateBody, HuashengApiError, runHuashengJob,
  type HuashengProjectApiClient } from './history-huasheng-api.js'
import type { HuashengBrowserInput, HuashengCheckpoint } from './history-huasheng-browser.js'

const script = '完整的历史文稿。第二句话说明人物与事件。'
const projectUrl = 'https://www.huasheng.cn/video/268238449803425'
const pid = '268238449803425'
const runId = 'f3c82b4d500244098fb638109e705e6d'
const question = (labels: string[]) => ({ events: [
  { event: 'AskQuestion', questions: [{ options: labels.map(label => ({ label })) }] },
  { event: 'RunPaused' },
] })
const firstRun = { run_id: '113faa86062740179eb8a0c5de9616b6', first_run: true,
  input: { extra: { script } }, ...question(['A - 素材剪辑成片', 'B - 素材混合MG动画']) }
const schemeRun = { run_id: '7364f7d319614488ae6aaac8f8085d98',
  input: { content: [{ type: 'text', text: { content: 'A - 素材剪辑成片' } }] },
  ...question(['确认', '需要修改']) }
const requirementsRun = { run_id: runId,
  input: { content: [{ type: 'text', text: { content: '确认' } }] },
  ...question(['确认，开始制作', '需要调整']) }

function fixture(options: { stage?: number; point?: number; quota?: boolean; production?: 'not_started' | 'queued';
  prepareError?: HuashengApiError; runError?: HuashengApiError; confirmError?: HuashengApiError; createdUid?: string } = {}) {
  const calls: string[] = []
  const updates: HuashengCheckpoint[] = []
  let stage = options.stage ?? 0
  let production = options.production ?? 'not_started'
  let now = 0
  const client: HuashengProjectApiClient = {
    prepareCreate: async () => { calls.push('prepare'); if (options.prepareError) throw options.prepareError },
    create: async value => { calls.push('create'); assert.equal(value, script); return { pid, uid: options.createdUid ?? '123' } },
    projectScript: async value => { calls.push('project'); assert.equal(value, pid); return script },
    history: async value => { calls.push('history'); assert.equal(value, pid); return {
      runs: [firstRun, ...(stage >= 1 ? [schemeRun] : []), ...(stage >= 2 ? [requirementsRun] : [])].reverse(),
      current_state: { is_working: false },
    } },
    run: async (value, text) => { assert.equal(value, pid); calls.push(`run:${text}`)
      if (options.runError) throw options.runError
      stage = text === '确认' ? 2 : 1; return runId },
    planCost: async (value, run) => { calls.push('cost'); assert.equal(value, pid); assert.equal(run, runId)
      return { ready: true, point: options.point ?? 0, hash: 'a'.repeat(64) } },
    confirm: async (value, run, hash) => { calls.push('confirm'); assert.equal(value, pid); assert.equal(run, runId)
      assert.equal(hash, 'a'.repeat(64)); if (options.confirmError) throw options.confirmError
      if (options.quota) throw new HuashengApiError('manual_review', '每日额度已用完', false, 10008, true)
      production = 'queued' },
    production: async value => { calls.push('production'); assert.equal(value, projectUrl)
      return { status: production, message: production === 'queued' ? '平台已排队' : '尚未开始' } },
  }
  const input = (checkpoint: string | null = null, url: string | null = null): HuashengBrowserInput => ({
    jobId: 1, script, checkpoint, projectUrl: url, signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  })
  const drive = (checkpoint: string | null = null, url: string | null = null) =>
    driveHuashengApiJob(input(checkpoint, url), client, {
      now: () => now, sleep: async ms => { now += ms }, pollMs: 1000, timeoutMs: 200_000,
    })
  return { calls, updates, input, drive, client }
}

test('create request matches the intercepted standard-mode shape and signing bytes', () => {
  const body = huashengCreateBody(script, 6036732, 1793608934000)
  assert.deepEqual(body, { name: '', is_denoise: 0, script, voice_id: 6036732, voice_type: 0,
    audio_url: '', speech_rate: 1, speech_rate_change: 1, is_agree: 0, is_multi: 0,
    is_fast: false, aspect_ratio: '16:9', llm_model: 25, audio_duration: 0,
    s: 'AgZYAgdWXg8=', t: 1793608934000 })
})

test('an explicit cloned voice is verified against the account list and submitted with its actual type', async t => {
  const input = { ...fixture().input(), voiceId: 1595661, voiceType: 1 }
  const session = { cookie: 'fixture-cookie', userAgent: 'fixture-agent', csrf: 'fixture-csrf', ra: 'fixture-ra', bs: 'wbh', fv: '317253' }
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (value: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(value))
    requests.push(url.pathname)
    if (url.pathname === '/api/innovideo/voice/clone/list') {
      assert.equal(init?.method, 'GET')
      return Response.json({ voices: [{ id: '1595661', name: '音色小鹭', voice_type: '2', state: '0' }], last_used_voice_id: '6036721' })
    }
    assert.equal(url.pathname, '/api/huasheng/project/create')
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.script, script)
    assert.equal(body.voice_id, 1595661)
    assert.equal(body.voice_type, 1)
    return Response.json({ code: 0, data: { pid, uid: '123' } })
  })
  const client = await createHuashengProjectApiClient(input, {
    session: async () => session, productionSession: async () => session,
  })
  await client.prepareCreate(script)
  assert.deepEqual(await client.create(script), { pid, uid: '123' })
  assert.deepEqual(requests, ['/api/innovideo/voice/clone/list', '/api/huasheng/project/create'])
})

test('an unavailable, wrong-type or malformed clone list cannot silently select a different voice', async t => {
  const input = { ...fixture().input(), voiceId: 1595661, voiceType: 1 }
  const session = { cookie: 'fixture-cookie', userAgent: 'fixture-agent', csrf: 'fixture-csrf', ra: 'fixture-ra', bs: 'wbh', fv: '317253' }
  for (const voices of [[], [{ id: '1595661', voice_type: '0', state: '0' }],
    [{ id: '1595661', voice_type: '2', state: '1' }], { id: '1595661' }]) {
    const fetch = t.mock.method(globalThis, 'fetch', async (_value: unknown, init?: RequestInit) => {
      assert.equal(init?.method, 'GET')
      return Response.json({ voices, last_used_voice_id: '6036721' })
    })
    const client = await createHuashengProjectApiClient(input, {
      session: async () => session, productionSession: async () => session,
    })
    await assert.rejects(client.prepareCreate(script), /未找到可用的指定克隆音色 1595661/)
    await assert.rejects(client.create(script), /参数尚未准备完成/)
    assert.equal(fetch.mock.callCount(), 1)
    fetch.mock.restore()
  }
  await assert.rejects(createHuashengProjectApiClient({ ...input, voiceId: 0 }, {
    session: async () => assert.fail('invalid preferences fail before session access'),
  }), /音色编号或类型无效/)
})

test('resuming a project verifies its exact voice id and clone type before production', async () => {
  for (const voice of [{ id: 6036721, type: 0 }, { id: 1595661, type: 0 }, { id: 1595661, type: 2 }, null]) {
    const run = fixture({ stage: 2, production: 'queued' })
    run.client.projectVoice = async () => voice
    await assert.rejects(driveHuashengApiJob({ ...run.input('submitted', projectUrl), voiceId: 1595661, voiceType: 1 }, run.client), /音色与指定音色 1595661 不一致/)
    assert.deepEqual(run.calls, ['project'])
  }
  const run = fixture({ stage: 2, production: 'queued' })
  run.client.projectVoice = async () => ({ id: 1595661, type: 1 })
  assert.deepEqual(await driveHuashengApiJob({ ...run.input('submitted', projectUrl), voiceId: 1595661, voiceType: 1 }, run.client), { projectUrl })
  assert.deepEqual(run.calls, ['project', 'production'])
})

test('an explicit cloned voice uses the API even under a browser override and cannot fall back to a default voice', async t => {
  const previous = process.env.HUASHENG_CREATION_DRIVER
  t.after(() => { if (previous === undefined) delete process.env.HUASHENG_CREATION_DRIVER; else process.env.HUASHENG_CREATION_DRIVER = previous })
  process.env.HUASHENG_CREATION_DRIVER = 'browser'
  const input = { ...fixture().input(), voiceId: 1595661, voiceType: 1 }
  let calls = 0
  assert.deepEqual(await runHuashengJob(input, {
    api: async value => { calls++; assert.equal(value.voiceId, 1595661); assert.equal(value.voiceType, 1); return { projectUrl } },
    browser: async () => assert.fail('the UI must not select a default voice'),
  }), { projectUrl })
  assert.equal(calls, 1)
  await assert.rejects(runHuashengJob(input, {
    api: async () => { throw new HuashengApiError('browser_unavailable', 'session unavailable', true) },
    browser: async () => assert.fail('an explicit voice must not silently fall back'),
  }), /session unavailable/)
})

test('a temporary API session failure stays retryable when an explicit voice prevents browser fallback', async () => {
  await assert.rejects(createHuashengProjectApiClient({ ...fixture().input(), voiceId: 1595661, voiceType: 1 }, {
    session: async () => { throw Object.assign(new Error('temporary attestation failure'), { code: 'retryable' }) },
  }), { code: 'browser_unavailable', retryable: true })
})

test('API creates once, waits for each question, verifies zero cost, and confirms once', async () => {
  const run = fixture()
  assert.deepEqual(await run.drive(), { projectUrl })
  assert.deepEqual(run.calls.filter(call => !['project', 'history', 'cost', 'production'].includes(call)),
    ['prepare', 'create', 'run:A - 素材剪辑成片', 'run:确认', 'confirm'])
  assert.deepEqual(run.updates.map(update => update.checkpoint),
    ['create_pending', 'created', 'scheme_pending', 'requirements_pending', 'plan_opened', 'confirm_pending', 'submitted'])
  assert.equal(run.updates.at(-1)?.productionStatus, 'queued')
})

test('an uncertain scheme request never replays the choice after restart', async () => {
  const run = fixture()
  await assert.rejects(run.drive('scheme_pending', projectUrl), /对话尚未推进/)
  assert.equal(run.calls.some(call => call.startsWith('run:')), false)
  assert.equal(run.calls.includes('confirm'), false)
})

test('read-only preparation failure saves no create intent, and definite non-dispatch restores the prior step', async () => {
  const prepare = fixture({ prepareError: new HuashengApiError('browser_unavailable', 'preflight', true) })
  await assert.rejects(prepare.drive(), /preflight/)
  assert.deepEqual(prepare.updates, [])
  const unsent = new HuashengApiError('login_required', 'session changed', false, undefined, false, true)
  const choice = fixture({ runError: unsent })
  await assert.rejects(choice.drive('created', projectUrl), /session changed/)
  assert.deepEqual(choice.updates.map(update => update.checkpoint), ['scheme_pending', 'created'])
  const final = fixture({ stage: 2, confirmError: unsent })
  await assert.rejects(final.drive('requirements_pending', projectUrl), /session changed/)
  assert.deepEqual(final.updates.map(update => update.checkpoint), ['plan_opened', 'confirm_pending', 'requirements_pending'])
})

test('a valid create pid is saved before rejecting a changed account identity', async () => {
  const run = fixture({ createdUid: 'foreign' })
  const input = run.input()
  input.browserConfig = { endpoint: 'http://127.0.0.1:9243', profile: '/tmp/huasheng-test', expectedUid: '123' }
  await assert.rejects(driveHuashengApiJob(input, {
    prepareCreate: async () => {}, create: async () => ({ pid, uid: 'foreign' }),
    projectScript: async () => script, history: async () => ({ runs: [], current_state: { is_working: false } }),
    run: async () => runId, planCost: async () => ({ ready: false }), confirm: async () => {},
    production: async () => ({ status: 'not_started', message: '' }),
  }), /账号与绑定账号不一致/)
  assert.equal(run.updates.at(-1)?.projectUrl, projectUrl)
  assert.equal(run.updates.at(-1)?.checkpoint, 'created')
})

test('a saved final confirmation only checks production and never confirms again', async () => {
  const run = fixture({ stage: 2, production: 'queued' })
  assert.deepEqual(await run.drive('confirm_pending', projectUrl), { projectUrl })
  assert.deepEqual(run.calls, ['project', 'production'])
  assert.equal(run.updates.at(-1)?.checkpoint, 'submitted')
})

test('nonzero cost blocks final confirmation and quota rejection preserves standard mode', async () => {
  const paid = fixture({ stage: 2, point: 3 })
  await assert.rejects(paid.drive('requirements_pending', projectUrl), /预计消耗 3 点/)
  assert.equal(paid.calls.includes('confirm'), false)
  const quota = fixture({ stage: 2, quota: true })
  await assert.rejects(quota.drive('requirements_pending', projectUrl), /每日额度已用完/)
  assert.equal(quota.calls.filter(call => call === 'confirm').length, 1)
  assert.equal(quota.updates.at(-1)?.checkpoint, 'quota_waiting')
})

test('a later checkpoint cannot resend an earlier answer when history is incomplete', async () => {
  const run = fixture({ stage: 1 })
  await assert.rejects(run.drive('plan_opened', projectUrl), /对话尚未推进/)
  assert.equal(run.calls.some(call => call.startsWith('run:')), false)
})

test('browser fallback is limited to a failure before API mutation', async () => {
  const input = fixture().input()
  const calls: string[] = []
  const browser = async () => { calls.push('browser'); return { projectUrl } }
  const api = async () => { calls.push('api'); throw new HuashengApiError('browser_unavailable', 'session', true) }
  assert.deepEqual(await runHuashengJob(input, { api, browser }), { projectUrl })
  assert.deepEqual(calls, ['api', 'browser'])
  calls.length = 0
  await assert.rejects(runHuashengJob(input, { api: async () => { calls.push('api'); throw new HuashengApiError('manual_review', 'uncertain') }, browser }), /uncertain/)
  assert.deepEqual(calls, ['api'])
})
