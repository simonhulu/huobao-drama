import test from 'node:test'
import assert from 'node:assert/strict'
import { driveHuashengPage, huashengProjectUrl, HuashengBrowserError,
  type HuashengPageState, type HuashengCheckpoint, type HuashengBrowserInput } from './history-huasheng-browser.js'

const project = 'https://www.huasheng.cn/video/123456789'
const script = '公元前二百多年，秦国统一六国。这里是一篇已经保存的二创历史稿。'
const state = (overrides: Partial<HuashengPageState> = {}): HuashengPageState => ({
  url: project, loggedIn: true, loginRequired: false, buttons: [], requirementsReady: false,
  planReady: false, productionStarted: false, productionFinished: false, cost: null,
  error: null, scriptPresent: true, ...overrides,
})
function scenario(states: HuashengPageState[], patch: Partial<HuashengBrowserInput> = {}) {
  const checkpoints: HuashengCheckpoint[] = []
  const clicks: string[] = []
  let filled = ''
  let index = 0
  let time = 0
  const controller = new AbortController()
  const input: HuashengBrowserInput = { jobId: 10, script, projectUrl: null, checkpoint: null,
    signal: controller.signal, onCheckpoint: async checkpoint => { checkpoints.push(checkpoint) }, ...patch }
  const port = { read: async () => states[Math.min(index++, states.length - 1)]!,
    fillScript: async (text: string) => { filled = text },
    click: async (label: string) => {
      assert.ok(checkpoints.length, 'every remote mutation is preceded by a durable checkpoint')
      clicks.push(label)
    } }
  const run = () => driveHuashengPage(port, input, { timeoutMs: 100, pollMs: 10,
    now: () => time, sleep: async ms => { time += ms } })
  return { run, checkpoints, clicks, input, controller, filled: () => filled }
}

test('creates once, selects A, confirms requirements and planning, then requires observed production', async () => {
  const s = scenario([
    state({ url: 'https://www.huasheng.cn/', buttons: ['创建'], scriptPresent: false }),
    state({ url: 'https://www.huasheng.cn/', buttons: ['创建'] }), // slow create response must not replay
    state({ buttons: ['A - 素材剪辑成片', 'B - 素材混合MG动画'] }),
    state({ buttons: ['确认', '需要修改'], requirementsReady: true }),
    state({ buttons: ['确认，开始制作'], planReady: true }),
    state({ buttons: ['确认，开始制作'], planReady: true }), // delayed dialog
    state({ buttons: ['确认并继续'], planReady: true, cost: 0 }),
    state({ buttons: ['确认并继续'], planReady: true, cost: 0 }), // delayed acknowledgement
    state({ productionStarted: true }),
  ])
  assert.deepEqual(await s.run(), { projectUrl: project })
  assert.equal(s.filled(), script)
  assert.deepEqual(s.clicks, ['创建', 'A - 素材剪辑成片', '确认', '确认，开始制作', '确认并继续'])
  assert.equal(s.checkpoints.at(-1)?.checkpoint, 'submitted')
  assert.equal(s.checkpoints.find(c => c.checkpoint === 'created')?.projectUrl, project)
})

test('restart resumes the original project and never resubmits the source script', async () => {
  const s = scenario([
    state({ requirementsReady: true, buttons: ['确认'] }),
    state({ planReady: true, buttons: ['确认并继续'], cost: 0 }),
    state({ productionStarted: true }),
  ], { projectUrl: project, checkpoint: 'scheme_pending' })
  await s.run()
  assert.equal(s.filled(), '')
  assert.deepEqual(s.clicks, ['确认', '确认并继续'])
})

test('a confirmation with unknown response cannot be replayed, including after restart', async () => {
  const s = scenario([state({ planReady: true, buttons: ['确认并继续'], cost: 0 })],
    { projectUrl: project, checkpoint: 'confirm_pending' })
  await assert.rejects(s.run, (error: unknown) => error instanceof HuashengBrowserError && error.code === 'timeout')
  assert.deepEqual(s.clicks, [])
  assert.ok(!s.checkpoints.some(c => c.checkpoint === 'submitted'))
})

test('refreshing a stale conversation preserves an uncertain final confirmation without replaying it', async () => {
  const s = scenario([
    state({ conversationStale: true, buttons: ['刷新对话', '确认并继续'], planReady: true, cost: 0 }),
    state({ buttons: ['确认并继续'], planReady: true, cost: 0 }),
    state({ productionStarted: true }),
  ], { projectUrl: project, checkpoint: 'confirm_pending' })
  await s.run()
  assert.deepEqual(s.clicks, ['刷新对话'])
  assert.deepEqual(s.checkpoints.map(update => update.checkpoint), ['confirm_pending', 'submitted'])
})

test('only the platform queue after final confirmation satisfies the start criterion', async () => {
  const queued = state({ queueVisible: true })
  const planning = scenario([queued], { projectUrl: project, checkpoint: 'requirements_pending' })
  await assert.rejects(planning.run, /超时/)
  assert.equal(planning.checkpoints.some(update => update.checkpoint === 'submitted'), false)
  const production = scenario([queued], { projectUrl: project, checkpoint: 'confirm_pending' })
  assert.deepEqual(await production.run(), { projectUrl: project })
  assert.equal(production.checkpoints.at(-1)?.productionStatus, 'queued')
  assert.deepEqual(production.clicks, [])
})

test('stale conversation refreshes are spaced, bounded and retain the original checkpoint', async () => {
  let time = 0
  const clicks: number[] = []
  const checkpoints: string[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ conversationStale: true, buttons: ['刷新对话'] }),
    fillScript: async () => { assert.fail('must not recreate') },
    click: async label => { assert.equal(label, '刷新对话'); clicks.push(time) },
  }, { jobId: 'stale', script, projectUrl: project, checkpoint: 'requirements_pending',
    signal: new AbortController().signal, onCheckpoint: async update => { checkpoints.push(update.checkpoint) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 60_000 }), /连续刷新后仍未同步/)
  assert.deepEqual(clicks, [0, 15_000, 30_000])
  assert.deepEqual(checkpoints, ['requirements_pending', 'requirements_pending', 'requirements_pending'])
})

test('refreshing a stale conversation does not extend final-confirmation acknowledgement time', async () => {
  let time = 0
  const clicks: string[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ conversationStale: time >= 119_000 && time < 120_000, buttons: ['刷新对话'] }),
    fillScript: async () => { assert.fail('must not recreate') },
    click: async label => { clicks.push(label) },
  }, { jobId: 'late-refresh', script, projectUrl: project, checkpoint: 'confirm_pending',
    signal: new AbortController().signal, onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 240_000 }), /确认请求已发送，尚未观察到制作进度/)
  assert.deepEqual(clicks, ['刷新对话'])
  assert.equal(time, 121_000)
})

test('canceling during stale-conversation checkpoint prevents refreshing', async () => {
  const s = scenario([state({ conversationStale: true, buttons: ['刷新对话'] })],
    { projectUrl: project, checkpoint: 'requirements_pending' })
  s.input.onCheckpoint = async () => { s.controller.abort() }
  await assert.rejects(s.run, /abort/i)
  assert.deepEqual(s.clicks, [])
})

test('pending creation waits for its existing request and never creates a second project', async () => {
  const s = scenario([state({ url: 'https://www.huasheng.cn/', buttons: ['创建'] })], { checkpoint: 'create_pending' })
  await assert.rejects(s.run, HuashengBrowserError)
  assert.deepEqual(s.clicks, [])
})

test('login expiration, page errors and script mismatch cannot advance a project', async () => {
  for (const override of [{ loginRequired: true }, { error: '生成失败' }, { scriptPresent: false }]) {
    const s = scenario([state({ buttons: ['确认并继续'], cost: 0, planReady: true, ...override })],
      { projectUrl: project, checkpoint: 'plan_opened' })
    await assert.rejects(s.run, HuashengBrowserError)
    assert.deepEqual(s.clicks, [])
  }
})

test('only a zero cost complete planning document can be automatically confirmed', async () => {
  for (const override of [{ cost: null }, { cost: 5 }, { cost: 5, buttons: ['5 确认并继续'] }, { planReady: false }]) {
    const s = scenario([state({ buttons: ['确认并继续'], cost: 0, planReady: true, ...override })],
      { projectUrl: project, checkpoint: 'plan_opened' })
    await assert.rejects(s.run, (error: unknown) => error instanceof HuashengBrowserError && error.code === 'manual_review')
    assert.deepEqual(s.clicks, [])
  }
})

test('generic confirmations and B recommendation are not accepted as A workflow controls', async () => {
  const s = scenario([state({ buttons: ['确认', 'B - 素材混合MG动画'] })], { projectUrl: project, checkpoint: 'created' })
  await assert.rejects(s.run)
  assert.deepEqual(s.clicks, [])
})

test('disabled historical controls are irrelevant and manual completion is reconciled', async () => {
  const s = scenario([state({ productionFinished: true })], { projectUrl: project, checkpoint: 'confirm_pending' })
  assert.deepEqual(await s.run(), { projectUrl: project, videoUrl: project })
  assert.deepEqual(s.clicks, [])
})

test('switching to another project halts automation', async () => {
  const s = scenario([state({ url: 'https://www.huasheng.cn/video/987654321', productionStarted: true })],
    { projectUrl: project, checkpoint: 'confirm_pending' })
  await assert.rejects(s.run, /其他项目/)
  assert.deepEqual(s.clicks, [])
})

test('cancellation while a checkpoint is being saved prevents the next remote click', async () => {
  const s = scenario([state({ planReady: true, buttons: ['确认并继续'], cost: 0 })],
    { projectUrl: project, checkpoint: 'plan_opened' })
  s.input.onCheckpoint = async () => { s.controller.abort() }
  await assert.rejects(s.run, /abort/i)
  assert.deepEqual(s.clicks, [])
})

test('blank or oversized script is rejected without browser mutation', async () => {
  for (const invalid of [' ', '字'.repeat(10_001)]) {
    const s = scenario([state({ url: 'https://www.huasheng.cn/', buttons: ['创建'] })], { script: invalid })
    await assert.rejects(s.run, /10000/)
    assert.deepEqual(s.clicks, [])
  }
})

test('saved project URLs only allow Huasheng numeric video pages', () => {
  assert.equal(huashengProjectUrl(project + '?foo=1#bar'), project)
  assert.equal(huashengProjectUrl('https://huasheng.cn/video/123/'), 'https://huasheng.cn/video/123')
  for (const value of ['http://www.huasheng.cn/video/123', 'https://evil.cn/video/123',
    'https://www.huasheng.cn@evil.cn/video/123', 'https://www.huasheng.cn/video/x',
    'https://www.huasheng.cn:999/video/123', 'https://www.huasheng.cn/project', 'file:///tmp/script']) {
    assert.equal(huashengProjectUrl(value), null)
  }
})
