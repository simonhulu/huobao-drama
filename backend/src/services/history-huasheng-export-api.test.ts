import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHuashengExportClient, downloadHuashengExport, HuashengExportApiError } from './history-huasheng-export-api.js'

const projectUrl = 'https://www.huasheng.cn/video/260077516955689'
const projectHash = 'a'.repeat(64)
const taskId = `p${projectHash}`
const signal = () => new AbortController().signal
const auth = { ra: 'fresh-session-token', bs: 'wbh', fv: 'current-version', csrf: 'cookie-csrf', cookie: 'SESSDATA=private', userAgent: 'actual-browser-agent' }
const managedConfig = { endpoint: 'http://127.0.0.1:9250', profile: '/tmp/science-managed', expectedUid: '71' }
const json = (data: unknown, code = 0) => new Response(JSON.stringify({ code, message: code ? '登录已过期' : 'OK', data }), { status: 200 })

const productionScript = '这是当前任务完整的原始文稿。\n\n最后一句也必须核对。'
function productionFixture() {
  // Observed endpoints: legacy metadata is unwrapped and retains the original
  // script; sandbox metadata uses an envelope and may contain a rewritten script.
  const legacy = { project: { pid: '260077516955689', script: productionScript, stage: '2047', progress: '100', state: '0', state_message: '项目处理完成',
    voice_id: '6036721', voice_type: '0',
    loading_status: '1', tts_running: false, voice_running: false, composite_running: false, motion_running: '0',
    wait_time: '0', is_agent_sandbox: true }, clips: [] }
  const sandbox = { project: { pid: 260077516955689, script: '平台分镜整理后的文稿', project_stage: 3, progress: 100,
    state: 0, composite_running: false }, clips: [{ state: 1 }, { state: 1 }] as Array<{ state: number }> | null }
  const calls: string[] = []
  const client = createHuashengExportClient({ productionSession: async () => auth, fetch: async (url, init) => {
    const u = new URL(String(url)); calls.push(u.pathname)
    assert.equal(init?.method, 'GET', 'production inspection must never dispatch an export or mutate a project')
    assert.equal(u.searchParams.get('pid'), '260077516955689')
    assert.deepEqual([...u.searchParams.keys()], ['pid'], 'production GETs require no attestation or CSRF initialization')
    assert.equal(new Headers(init?.headers).get('Cookie'), auth.cookie)
    return u.pathname === '/api/innovideo/project/info' ? new Response(JSON.stringify(legacy)) : json(sandbox)
  } })
  return { legacy, sandbox, calls, inspect: (expectedVoice?: { id: number; type: number }) => client.production({ projectUrl, script: productionScript, signal: signal(), expectedVoice }) }
}

test('an expected cloned voice is checked against the original project before any generation or export can be accepted', async () => {
  const f = productionFixture(), expected = { id: 1595661, type: 1 }
  await assert.rejects(f.inspect(expected), /原项目音色与指定音色 1595661 不一致/)
  assert.deepEqual(f.calls, ['/api/innovideo/project/info'])
  f.legacy.project.voice_id = '1595661'; f.legacy.project.voice_type = '2'
  await assert.rejects(f.inspect(expected), /音色.*不一致/)
  f.legacy.project.voice_type = '1'
  assert.equal((await f.inspect(expected)).status, 'completed')
})

test('production readiness uses project APIs without an export dialog and verifies the original script', async () => {
  const f = productionFixture()
  assert.equal((await f.inspect()).status, 'completed')
  assert.deepEqual(f.calls, ['/api/innovideo/project/info', '/api/v2/innovideo/project/info'])
  f.legacy.project.script = productionScript.replace(/\n/g, '\r\n')
  assert.equal((await f.inspect()).status, 'completed')
  f.legacy.project.script = productionScript.replace('最后一句也必须核对', '相同开头但末尾属于另一篇稿件')
  await assert.rejects(f.inspect(), /文稿/)
})

test('legacy progress 100 and completed message cannot mark an unanswered sandbox plan complete', async () => {
  const f = productionFixture()
  f.legacy.project.stage = '0'; f.sandbox.project.project_stage = 0; f.sandbox.clips = null
  assert.equal((await f.inspect()).status, 'not_started')
})

test('unfinished stages, running generation, queued work and incomplete clips stay pending', async () => {
  for (const mutate of [
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.project_stage = 2 },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.progress = 90 },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.progress = '90' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.tts_running = true },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.voice_running = true },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.motion_running = '1' },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.composite_running = true },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.clips![1]!.state = 0 },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.clips = [] },
  ]) {
    const f = productionFixture(); mutate(f)
    assert.equal((await f.inspect()).status, 'creating')
  }
  const queued = productionFixture(); queued.legacy.project.wait_time = '30'
  assert.equal((await queued.inspect()).status, 'queued')
})

test('pending production explains actual missing readiness instead of reporting a misleading 100 percent', async () => {
  const cases: Array<[(f: ReturnType<typeof productionFixture>) => void, RegExp]> = [
    [f => { f.sandbox.clips![1]!.state = 0 }, /分镜素材.*1\/2/],
    [f => { f.sandbox.clips = [] }, /分镜素材尚未返回/],
    [f => { f.sandbox.project.project_stage = 2 }, /制作阶段尚未完成/],
    [f => { f.legacy.project.loading_status = '0' }, /素材仍在加载/],
    [f => { f.legacy.project.tts_running = true }, /配音/],
    [f => { f.legacy.project.motion_running = '1' }, /动态画面/],
    [f => { f.sandbox.project.composite_running = true }, /合成视频/],
    [f => { f.legacy.project.progress = '90' }, /90%/],
    [f => { f.legacy.project.state = '-1'; f.legacy.project.state_message = '视频制作中，' }, /平台尚未确认制作完成/],
  ]
  for (const [mutate, expected] of cases) {
    const f = productionFixture(); mutate(f)
    const observation = await f.inspect()
    assert.equal(observation.status, 'creating')
    assert.match(observation.message, expected)
    assert.doesNotMatch(observation.message, /进度\s*100%/)
  }
})

test('an active sandbox compositor is creating even while stage is still zero', async () => {
  const f = productionFixture()
  f.legacy.project.stage = '0'
  f.sandbox.project.project_stage = 0
  f.sandbox.project.composite_running = true
  f.sandbox.clips = [{ state: 1 }, { state: 0 }, { state: 1 }]
  assert.equal((await f.inspect()).status, 'creating')
})

test('stage zero with no queue or active compositor remains not started', async () => {
  const f = productionFixture()
  f.legacy.project.stage = '0'
  f.sandbox.project.project_stage = 0
  f.sandbox.project.composite_running = false
  f.sandbox.clips = null
  assert.equal((await f.inspect()).status, 'not_started')
})

test('observed legacy sandbox state -1 with a production message still queries the actual sandbox stage', async () => {
  const f = productionFixture()
  f.legacy.project.state = '-1'
  f.legacy.project.state_message = '视频制作中，'
  f.legacy.project.stage = '0'
  f.legacy.project.progress = '0'
  f.sandbox.project.project_stage = 0
  f.sandbox.clips = null
  assert.equal((await f.inspect()).status, 'not_started')
  assert.deepEqual(f.calls, ['/api/innovideo/project/info', '/api/v2/innovideo/project/info'])
  f.sandbox.project.composite_running = true
  assert.equal((await f.inspect()).status, 'creating')
})

test('legacy pending state never proves completion even if the other fields appear ready', async () => {
  const f = productionFixture()
  f.legacy.project.state = '-1'
  f.legacy.project.state_message = '视频制作中，'
  assert.equal((await f.inspect()).status, 'creating')
  f.legacy.project.script = '另一篇文稿'
  await assert.rejects(f.inspect(), /文稿/)
})

test('the observed same-account queue stays queued even with zero wait time or apparently ready metadata', async () => {
  const f = productionFixture()
  f.legacy.project.state = '-1'
  f.legacy.project.state_message = '你有任务正在生成中，完成后将自动开始'
  f.legacy.project.stage = '0'
  f.legacy.project.progress = '0'
  f.sandbox.project.project_stage = 0
  f.sandbox.clips = null
  assert.equal((await f.inspect()).status, 'queued')
  assert.deepEqual(f.calls, ['/api/innovideo/project/info', '/api/v2/innovideo/project/info'])
  f.legacy.project.progress = '100'
  f.sandbox.project.project_stage = 3
  f.sandbox.clips = [{ state: 1 }]
  assert.equal((await f.inspect()).status, 'queued')
  f.legacy.project.state = '0'
  f.legacy.project.state_message = '项目处理完成'
  assert.equal((await f.inspect()).status, 'completed')
})

test('queue metadata still requires the original project, script, voice and valid sandbox state', async () => {
  for (const mutate of [
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.pid = '999' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.script = '另一篇文稿' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.voice_id = '999' },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.pid = 999 },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.state = -1 },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '-2' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.is_agent_sandbox = false },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state_message += '，但遇到错误' },
  ]) {
    const f = productionFixture()
    f.legacy.project.state = '-1'
    f.legacy.project.state_message = '你有任务正在生成中，完成后将自动开始'
    mutate(f)
    await assert.rejects(f.inspect({ id: 6036721, type: 0 }),
      (e: unknown) => e instanceof HuashengExportApiError && e.code === 'invalid_response')
  }
})

test('only the observed sandbox pending state is allowed; failures and unknown states remain errors', async () => {
  for (const mutate of [
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '-2'; f.legacy.project.state_message = '视频制作中，' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '-1'; f.legacy.project.state_message = '制作失败' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '-1'; f.legacy.project.state_message = '' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '-1'; f.legacy.project.state_message = '视频制作中，但遇到错误' },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '-1'; f.legacy.project.state_message = '视频制作中，'; f.legacy.project.is_agent_sandbox = false },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.state = -1 },
  ]) {
    const f = productionFixture(); mutate(f)
    await assert.rejects(f.inspect(), (e: unknown) => e instanceof HuashengExportApiError && e.code === 'invalid_response')
  }
})

test('wrong project IDs, unknown progress and platform error states never permit production export', async () => {
  for (const mutate of [
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.pid = '999' },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.pid = 999 },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.progress = '' },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.progress = 101 },
    (f: ReturnType<typeof productionFixture>) => { f.legacy.project.state = '2' },
    (f: ReturnType<typeof productionFixture>) => { f.sandbox.project.state = 2 },
    (f: ReturnType<typeof productionFixture>) => { delete (f.legacy.project as Partial<typeof f.legacy.project>).voice_running },
  ]) {
    const f = productionFixture(); mutate(f)
    await assert.rejects(f.inspect(), (e: unknown) => e instanceof HuashengExportApiError && e.code === 'invalid_response')
  }
})

test('production login failures and malformed legacy responses cannot fall back to page inspection', async () => {
  for (const response of [json(null, -101), new Response(JSON.stringify({ project: { pid: '260077516955689' }, code: -101 })),
    new Response(JSON.stringify({ data: { project: {} } }))]) {
    const client = createHuashengExportClient({ productionSession: async () => auth, fetch: async () => response })
    await assert.rejects(client.production({ projectUrl, script: productionScript, signal: signal() }), HuashengExportApiError)
  }
})

test('production cookies cache per account and expired status reads never initialize export attestation', async () => {
  const f = productionFixture()
  const first = { endpoint: 'http://127.0.0.1:9250', profile: '/tmp/science-one' }
  const second = { endpoint: 'http://127.0.0.1:9251', profile: '/tmp/science-two' }
  const sessions: string[] = []
  let expireFirst = false
  const client = createHuashengExportClient({
    session: async () => assert.fail('production checks must not open a page for export attestation'),
    productionSession: async input => {
      const account = input.browserConfig?.profile || 'history'
      sessions.push(account)
      return { cookie: account, userAgent: auth.userAgent }
    },
    fetch: async (url, init) => {
      const request = new URL(String(url))
      assert.equal(init?.method, 'GET')
      assert.deepEqual([...request.searchParams.keys()], ['pid'])
      if (expireFirst && new Headers(init?.headers).get('Cookie') === first.profile) return json(null, -101)
      return request.pathname === '/api/innovideo/project/info' ? new Response(JSON.stringify(f.legacy)) : json(f.sandbox)
    },
  })
  const inspect = (browserConfig?: typeof first) => client.production({ projectUrl, signal: signal(), browserConfig })
  await inspect(first); await inspect(second); await inspect(); await inspect(first)
  expireFirst = true
  await assert.rejects(inspect(first), error => error instanceof HuashengExportApiError && error.code === 'login_required')
  expireFirst = false
  await inspect(second); await inspect(first)
  assert.deepEqual(sessions, [first.profile, second.profile, 'history', first.profile])
})

test('export session caches stay bound to the selected account, including after login expiry', async () => {
  const first = { endpoint: 'http://127.0.0.1:9250', profile: '/tmp/science-one' }
  const second = { endpoint: 'http://127.0.0.1:9251', profile: '/tmp/science-two' }
  const sessions: string[] = [], cookies: string[] = []
  let expireFirst = false
  const client = createHuashengExportClient({
    session: async input => {
      const account = input.browserConfig?.profile || 'history'
      sessions.push(account)
      return { ...auth, cookie: account }
    },
    fetch: async (_url, init) => {
      const account = new Headers(init?.headers).get('Cookie')!
      cookies.push(account)
      return expireFirst && account === first.profile ? json(null, -101) : json({ progress: 1, url: '' })
    },
  })
  const inspect = (browserConfig?: typeof first) => client.inspect({ projectUrl, taskId, projectHash, signal: signal(), browserConfig })
  await inspect(first); await inspect(second); await inspect(); await inspect(first)
  expireFirst = true
  await assert.rejects(inspect(first), /登录/)
  expireFirst = false
  await inspect(second); await inspect(first)
  assert.deepEqual(sessions, [first.profile, second.profile, 'history', first.profile])
  assert.deepEqual(cookies, [first.profile, second.profile, 'history', first.profile, first.profile, second.profile, first.profile])
})

test('managed cached exports recheck the browser and refresh attestation when its session changes', async () => {
  let currentCookie = auth.cookie, checks = 0, attestations = 0
  const requests: Array<{ cookie: string | null; ra: string | null }> = []
  const client = createHuashengExportClient({
    productionSession: async input => {
      assert.equal(input.browserConfig?.expectedUid, managedConfig.expectedUid)
      checks++
      return { cookie: currentCookie, userAgent: auth.userAgent }
    },
    session: async () => ({ ...auth, cookie: currentCookie, ra: `attestation-${++attestations}` }),
    fetch: async (url, init) => {
      requests.push({ cookie: new Headers(init?.headers).get('Cookie'), ra: new URL(String(url)).searchParams.get('_ra') })
      return json({ progress: 1, url: '' })
    },
  })
  const inspect = () => client.inspect({ projectUrl, taskId, projectHash, browserConfig: managedConfig, signal: signal() })
  await inspect()
  const firstChecks = checks
  await inspect()
  assert.ok(checks > firstChecks, 'a cache hit must still verify the current browser login')
  assert.equal(attestations, 1, 'an unchanged verified session may reuse its attestation')
  currentCookie = 'SESSDATA=renewed-session'
  await inspect()
  assert.equal(attestations, 2)
  assert.deepEqual(requests, [
    { cookie: auth.cookie, ra: 'attestation-1' }, { cookie: auth.cookie, ra: 'attestation-1' },
    { cookie: currentCookie, ra: 'attestation-2' },
  ])
})

test('managed export cache hits fail closed on an identity mismatch and discard the old session', async () => {
  let correctIdentity = true, attestations = 0, requests = 0
  const client = createHuashengExportClient({
    productionSession: async () => {
      if (!correctIdentity) throw new HuashengExportApiError('login_required', '当前登录账号与绑定账号不一致')
      return auth
    },
    session: async () => { attestations++; return auth },
    fetch: async () => { requests++; return json({ progress: 1, url: '' }) },
  })
  const inspect = () => client.inspect({ projectUrl, taskId, projectHash, browserConfig: managedConfig, signal: signal() })
  await inspect()
  correctIdentity = false
  await assert.rejects(inspect(), error => error instanceof HuashengExportApiError && error.code === 'login_required')
  assert.equal(requests, 1, 'a mismatched browser must not use cached credentials for another API request')
  correctIdentity = true
  await inspect()
  assert.equal(attestations, 2, 'recovery must obtain a fresh attestation after the mismatch')
})

test('managed production reads verify the browser on each request without initializing attestation', async () => {
  const fixture = productionFixture()
  let checks = 0, requests = 0, loggedIn = true
  const client = createHuashengExportClient({
    productionSession: async () => {
      checks++
      if (!loggedIn) throw new HuashengExportApiError('login_required', '登录已失效')
      return auth
    },
    session: async () => assert.fail('production reads must not initialize export attestation'),
    fetch: async url => {
      requests++
      return new URL(String(url)).pathname === '/api/innovideo/project/info'
        ? new Response(JSON.stringify(fixture.legacy)) : json(fixture.sandbox)
    },
  })
  const inspect = () => client.production({ projectUrl, script: productionScript, browserConfig: managedConfig, signal: signal() })
  assert.equal((await inspect()).status, 'completed')
  assert.equal(checks, 2)
  loggedIn = false
  await assert.rejects(inspect(), error => error instanceof HuashengExportApiError && error.code === 'login_required')
  assert.equal(requests, 2)
})

test('managed export cache keys distinguish expected identities even on the same browser configuration', async () => {
  const attestations: string[] = [], requests: Array<string | null> = []
  const client = createHuashengExportClient({
    productionSession: async () => auth,
    session: async input => {
      attestations.push(input.browserConfig!.expectedUid!)
      return { ...auth, ra: input.browserConfig!.expectedUid! }
    },
    fetch: async url => { requests.push(new URL(String(url)).searchParams.get('_ra')); return json({ progress: 1, url: '' }) },
  })
  const inspect = (expectedUid: string) => client.inspect({ projectUrl, taskId, projectHash,
    browserConfig: { ...managedConfig, expectedUid }, signal: signal() })
  await inspect('71'); await inspect('72'); await inspect('71')
  assert.deepEqual(attestations, ['71', '72'])
  assert.deepEqual(requests, ['71', '72', '71'])
})

test('managed exports stop before dispatch if identity changes after the metadata read', async () => {
  let correctIdentity = true, dispatched = 0, posts = 0
  const client = createHuashengExportClient({
    productionSession: async () => {
      if (!correctIdentity) throw new HuashengExportApiError('login_required', '当前登录账号与绑定账号不一致')
      return auth
    },
    session: async () => auth,
    fetch: async (_url, init) => {
      if (init?.method === 'POST') { posts++; return json({ task_id: taskId, project_hash: projectHash }) }
      correctIdentity = false
      return json({ project: { pid: 260077516955689, aspect_ratio: '16:9' } })
    },
  })
  await assert.rejects(client.create({ projectUrl, browserConfig: managedConfig, signal: signal(), onDispatched: () => { dispatched++ } }),
    error => error instanceof HuashengExportApiError && error.code === 'login_required')
  assert.equal(dispatched, 0)
  assert.equal(posts, 0)
})

test('managed exports report a definite non-dispatch when the session changes during checkpoint persistence', async () => {
  let currentCookie = auth.cookie, dispatched = 0, posts = 0
  const client = createHuashengExportClient({
    productionSession: async () => ({ cookie: currentCookie, userAgent: auth.userAgent }),
    session: async () => ({ ...auth, cookie: currentCookie }),
    fetch: async (_url, init) => {
      if (init?.method === 'POST') { posts++; return json({ task_id: taskId, project_hash: projectHash }) }
      return json({ project: { pid: 260077516955689, aspect_ratio: '16:9' } })
    },
  })
  await assert.rejects(client.create({ projectUrl, browserConfig: managedConfig, signal: signal(), onDispatched: () => {
    dispatched++
    currentCookie = 'SESSDATA=changed-during-checkpoint'
  } }), error => error instanceof HuashengExportApiError && error.requestRejected && error.code === 'retryable')
  assert.equal(dispatched, 1)
  assert.equal(posts, 0)
})

test('managed exports do not send attestation read from a browser session that changed mid-read', async () => {
  let currentCookie = auth.cookie, requests = 0
  const client = createHuashengExportClient({
    productionSession: async () => ({ cookie: currentCookie, userAgent: auth.userAgent }),
    session: async () => {
      currentCookie = 'SESSDATA=changed-during-attestation'
      return auth
    },
    fetch: async () => { requests++; return json({ progress: 1, url: '' }) },
  })
  await assert.rejects(client.inspect({ projectUrl, taskId, projectHash, browserConfig: managedConfig, signal: signal() }),
    error => error instanceof HuashengExportApiError && error.code === 'retryable')
  assert.equal(requests, 0)
})

test('managed query retries stop if the browser identity changes during connection backoff', async () => {
  let correctIdentity = true, requests = 0
  const client = createHuashengExportClient({
    productionSession: async () => {
      if (!correctIdentity) throw new HuashengExportApiError('login_required', '当前登录账号与绑定账号不一致')
      return auth
    },
    session: async () => auth,
    fetch: async () => {
      requests++
      if (requests === 1) { correctIdentity = false; throw new TypeError('connection closed') }
      return json({ progress: 1, url: '' })
    },
  })
  await assert.rejects(client.inspect({ projectUrl, taskId, projectHash, browserConfig: managedConfig, signal: signal() }),
    error => error instanceof HuashengExportApiError && error.code === 'login_required')
  assert.equal(requests, 1)
})

test('export uses current project pid and aspect ratio, fresh session fields, and persists dispatch before POST', async () => {
  const calls: string[] = []
  const client = createHuashengExportClient({ session: async () => auth, fetch: async (url, init) => {
    const u = new URL(String(url))
    assert.equal(u.searchParams.get('_ra'), auth.ra)
    assert.equal(u.searchParams.get('_bs'), auth.bs)
    assert.equal(u.searchParams.get('_fv'), auth.fv)
    assert.equal(new Headers(init?.headers).get('Cookie'), auth.cookie)
    if (u.pathname.endsWith('/project/info')) {
      calls.push('metadata')
      return json({ project: { id: 999, pid: 260077516955689, aspect_ratio: '9:16' } })
    }
    calls.push('post')
    assert.equal(u.searchParams.get('csrf'), auth.csrf)
    assert.deepEqual(JSON.parse(String(init?.body)), { pid: 260077516955689, watermark: 0, ai_watermark: 0, aspect_ratio: '9:16' })
    return json({ task_id: taskId, project_hash: projectHash })
  } })
  assert.deepEqual(await client.create({ projectUrl, signal: signal(), onDispatched: async () => { calls.push('persisted') } }), { taskId, projectHash })
  assert.deepEqual(calls, ['metadata', 'persisted', 'post'])
})

test('wrong project metadata prevents any export mutation', async () => {
  let dispatched = false
  const client = createHuashengExportClient({ session: async () => auth, fetch: async () => json({ project: { pid: 123, aspect_ratio: '16:9' } }) })
  await assert.rejects(client.create({ projectUrl, signal: signal(), onDispatched: async () => { dispatched = true } }), /项目/)
  assert.equal(dispatched, false)
})

test('HTTP 200 with a business rejection is never a successful export', async () => {
  const client = createHuashengExportClient({ session: async () => auth, fetch: async () => json(null, -101) })
  await assert.rejects(client.inspect({ projectUrl, taskId, projectHash, signal: signal() }), (e: unknown) => e instanceof HuashengExportApiError && e.code === 'login_required')
})

test('a lost creation response is uncertain and is not automatically posted again', async () => {
  let posts = 0
  const client = createHuashengExportClient({ session: async () => auth, fetch: async (url) => {
    if (String(url).includes('/project/info?')) return json({ project: { pid: 260077516955689, aspect_ratio: '16:9' } })
    posts++
    throw new Error('socket reset with private-session-token')
  } })
  await assert.rejects(client.create({ projectUrl, signal: signal() }), (e: unknown) => {
    assert.ok(e instanceof HuashengExportApiError)
    assert.equal(e.code, 'result_uncertain')
    assert.ok(!e.message.includes('private-session-token'))
    return true
  })
  assert.equal(posts, 1)
})

test('successful HTTP without the creation receipt stays uncertain', async () => {
  const client = createHuashengExportClient({ session: async () => auth, fetch: async url => String(url).includes('/project/info?')
    ? json({ project: { pid: 260077516955689, aspect_ratio: '16:9' } }) : json(null) })
  await assert.rejects(client.create({ projectUrl, signal: signal() }), (e: unknown) => e instanceof HuashengExportApiError && e.code === 'result_uncertain')
})

test('polling preserves an unfinished export and requires a matching media URL', async () => {
  let completed = false
  const client = createHuashengExportClient({ session: async () => auth, fetch: async () => json(completed
    ? { progress: 100, url: 'https://upos-sz-mirrorcos.bilivideo.com/ttvuserboss/ttv_composite/project/sandbox/999/video_' + projectHash + '.mp4' }
    : { progress: 45, url: '', filename: '' }) })
  assert.deepEqual(await client.inspect({ projectUrl, taskId, projectHash, signal: signal() }), { progress: 45, url: null, filename: null })
  completed = true
  await assert.rejects(client.inspect({ projectUrl, taskId, projectHash, signal: signal() }), /项目/)
})

test('a transient export-query connection failure retries only the same GET and preserves its task identity', async () => {
  let requests = 0
  const client = createHuashengExportClient({ session: async () => auth, fetch: async (url, init) => {
    const parsed = new URL(String(url))
    assert.equal(init?.method, 'GET')
    assert.equal(parsed.searchParams.get('task_id'), taskId)
    assert.equal(parsed.searchParams.get('project_hash'), projectHash)
    if (++requests === 1) throw new TypeError('fetch failed')
    return json({ progress: 70, url: '' })
  } })
  assert.equal((await client.inspect({ projectUrl, taskId, projectHash, signal: signal() })).progress, 70)
  assert.equal(requests, 2)
})

test('safe connection retries are bounded and cancellation stops the next query', async () => {
  let requests = 0
  const client = createHuashengExportClient({ session: async () => auth, fetch: async () => { requests++; throw new TypeError('fetch failed') } })
  await assert.rejects(client.inspect({ projectUrl, taskId, projectHash, signal: signal() }),
    (error: unknown) => error instanceof HuashengExportApiError && error.code === 'retryable')
  assert.equal(requests, 3)
  const controller = new AbortController()
  const canceled = createHuashengExportClient({ session: async () => auth, fetch: async () => { controller.abort(new Error('stopped')); throw new TypeError('fetch failed') } })
  await assert.rejects(canceled.inspect({ projectUrl, taskId, projectHash, signal: controller.signal }), /stopped/)
})

const videoUrl = `https://upos-sz-mirrorcos.bilivideo.com/ttvuserboss/ttv_composite/project/sandbox/260077516955689/video_${projectHash}.mp4?attname=test.mp4`
async function directory() { return fs.mkdtemp(path.join(tmpdir(), 'huasheng-export-api-')) }

test('downloads resume the same file with Range and never forward account cookies to CDN', async () => {
  const root = await directory()
  const dir = path.join(root, '260077516955689')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, `video_${projectHash}.mp4.part`), 'abc')
  const result = await downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: signal() }, {
    root, probe: async file => { assert.equal(await fs.readFile(file, 'utf8'), 'abcdef'); return 10 },
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('Range'), 'bytes=3-')
      assert.equal(headers.get('Cookie'), null)
      return new Response('def', { status: 206, headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' } })
    },
  })
  assert.equal(result.bytes, 6)
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'abcdef')
})

test('server ignoring Range replaces the incomplete file instead of appending', async () => {
  const root = await directory()
  const dir = path.join(root, '260077516955689')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, `video_${projectHash}.mp4.part`), 'old')
  const result = await downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: signal() }, {
    root, probe: async () => 10, fetch: async () => new Response('complete', { headers: { 'content-length': '8' } }),
  })
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'complete')
})

test('truncated response and wrong Content-Range cannot become a completed video', async () => {
  const root = await directory()
  const input = { projectUrl, projectHash, url: videoUrl, signal: signal() }
  await assert.rejects(downloadHuashengExport(input, { root, probe: async () => 10,
    fetch: async () => new Response('abc', { headers: { 'content-length': '6' } }) }), /完整/)
  await assert.rejects(downloadHuashengExport(input, { root, probe: async () => 10,
    fetch: async () => new Response('def', { status: 206, headers: { 'content-range': 'bytes 0-2/6', 'content-length': '3' } }) }), /续传/)
  await assert.rejects(fs.stat(path.join(root, '260077516955689', `video_${projectHash}.mp4`)))
})

test('completed validated files are reused without download', async () => {
  const root = await directory()
  const dir = path.join(root, '260077516955689')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, `video_${projectHash}.mp4`), 'complete')
  const result = await downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: signal() }, {
    root, probe: async () => 10, fetch: async () => { throw new Error('must not download twice') },
    checkDiskSpace: async () => { throw new Error('an existing validated file needs no new disk allocation') },
  })
  assert.equal(result.bytes, 8)
})

test('shutdown during cached video inspection cannot report completion', async () => {
  const root = await directory()
  const dir = path.join(root, '260077516955689')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, `video_${projectHash}.mp4`), 'complete')
  const controller = new AbortController()
  let reported = false
  await assert.rejects(downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: controller.signal,
    onProgress: () => { reported = true } }, {
    root, probe: async () => { controller.abort(new Error('shutdown')); return 10 },
  }), /shutdown/)
  assert.equal(reported, false)
})

test('restart after the last byte finalizes the partial file without a second download', async () => {
  const root = await directory()
  const dir = path.join(root, '260077516955689')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, `video_${projectHash}.mp4.part`), 'complete')
  const result = await downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: signal() }, {
    root, probe: async () => 10,
    fetch: async () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */8' } }),
  })
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'complete')
})

test('invalid media and redirects to other hosts never attach a file or leak signed URLs', async () => {
  const root = await directory()
  const input = { projectUrl, projectHash, url: videoUrl, signal: signal() }
  await assert.rejects(downloadHuashengExport(input, { root, probe: async () => { throw new Error('not playable') },
    fetch: async () => new Response('error page', { headers: { 'content-length': '10' } }) }), /视频/)
  await assert.rejects(downloadHuashengExport(input, { root, probe: async () => 10,
    fetch: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private?token=secret' } }) }), /地址/)
})

test('download preflight reserves only remaining bytes and retains an existing partial on low space', async t => {
  const root = await directory(), dir = path.join(root, '260077516955689')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(dir)
  const partial = path.join(dir, `video_${projectHash}.mp4.part`)
  await fs.writeFile(partial, 'abc')
  const checked: number[] = [], lowSpace = Object.assign(new Error('reserve reached'), { code: 'MEDIA_DISK_FULL' })
  await assert.rejects(downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: signal() }, {
    root, probe: async () => assert.fail('an incomplete file must not be validated'),
    fetch: async () => new Response('def', { status: 206, headers: { 'content-range': 'bytes 3-5/6', 'content-length': '3' } }),
    checkDiskSpace: async (_directory, extraBytes = 0) => { checked.push(extraBytes); if (extraBytes) throw lowSpace },
  }), (error: unknown) => error instanceof HuashengExportApiError && error.code === 'retryable' && /断点/.test(error.message))
  assert.deepEqual(checked, [0, 3])
  assert.equal(await fs.readFile(partial, 'utf8'), 'abc')
  await assert.rejects(fs.stat(partial.slice(0, -5)))
})

test('stream disk checks stop a long download while preserving its resume bytes and stop the watcher', async t => {
  const root = await directory(), dir = path.join(root, '260077516955689')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(dir)
  const partial = path.join(dir, `video_${projectHash}.mp4.part`), chunk = Buffer.alloc(32 * 1024 ** 2, 1)
  await fs.writeFile(partial, 'abc')
  t.mock.timers.enable({ apis: ['setInterval'] })
  let checks = 0
  await assert.rejects(downloadHuashengExport({ projectUrl, projectHash, url: videoUrl, signal: signal() }, {
    root, probe: async () => assert.fail('a stopped download must not be validated'),
    fetch: async () => new Response(chunk, { status: 206,
      headers: { 'content-range': `bytes 3-${chunk.length + 2}/${chunk.length + 3}`, 'content-length': String(chunk.length) } }),
    checkDiskSpace: async () => { if (++checks >= 3) throw Object.assign(new Error('reserve reached'), { code: 'MEDIA_DISK_FULL' }) },
  }), (error: unknown) => error instanceof HuashengExportApiError && error.code === 'retryable' && /断点/.test(error.message))
  assert.equal(await fs.readFile(partial, 'utf8'), 'abc')
  assert.equal(checks, 3)
  t.mock.timers.tick(5000)
  await Promise.resolve()
  assert.equal(checks, 3)
})
