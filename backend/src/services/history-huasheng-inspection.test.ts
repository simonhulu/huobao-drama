import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectHuashengPage, type HuashengPageState } from './history-huasheng-browser.js'

const projectUrl = 'https://www.huasheng.cn/video/123456789'
const state = (patch: Partial<HuashengPageState> = {}): HuashengPageState => ({
  url: projectUrl, loggedIn: true, loginRequired: false, buttons: [], requirementsReady: false,
  planReady: false, productionStarted: false, productionFinished: false, cost: null,
  error: null, scriptPresent: false, ...patch,
})
function inspect(states: HuashengPageState[], checkpoint?: string, signal = new AbortController().signal) {
  let time = 0, index = 0
  const clicks: string[] = []
  const run = () => inspectHuashengPage({
    read: async () => states[Math.min(index++, states.length - 1)]!,
    fillScript: async () => { assert.fail('inspection must never fill a script') },
    click: async label => { clicks.push(label) },
  }, { projectUrl, checkpoint, signal }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 500, timeoutMs: 15_000 })
  return { run, clicks }
}

test('requirements and planning queues are not reported as video production', async () => {
  const s = inspect([state({ requirementsReady: true, queueVisible: true, buttons: ['确认'] })], 'requirements_pending')
  assert.equal((await s.run()).status, 'not_started')
  assert.deepEqual(s.clicks, [])
})

test('science recovery requires the saved script before accepting a ready project', async () => {
  for (const matches of [false, true]) {
    let time = 0
    const result = inspectHuashengPage({ read: async () => state({ editorReady: true, exportDialogOpen: true, exportReady: true, scriptPresent: matches }),
      fillScript: async () => assert.fail('read-only inspection'), click: async () => assert.fail('already open export') },
    { projectUrl, script: 'this exact saved narration', signal: new AbortController().signal },
    { now: () => time, sleep: async ms => { time += ms }, timeoutMs: 1000 })
    if (matches) assert.equal((await result).status, 'completed')
    else await assert.rejects(result, /状态尚未加载完成/)
  }
})

test('explicit quota rejection means not started even after a local final-confirmation checkpoint', async () => {
  const s = inspect([state({ planReady: true, standardQuotaExhausted: true,
    buttons: ['快速模式继续 预估花生米 219'] })], 'confirm_pending')
  const result = await s.run()
  assert.equal(result.status, 'not_started')
  assert.match(result.message, /额度已用完/)
  assert.deepEqual(s.clicks, [])
})

test('a saved final-confirmation checkpoint cannot override a persistently unanswered remote plan', async () => {
  const s = inspect([state({ planReady: true, conversationReady: true,
    buttons: ['确认，开始制作', '需要调整'] })], 'confirm_pending')
  assert.equal((await s.run()).status, 'not_started')
  assert.deepEqual(s.clicks, [])
})

test('a briefly visible old plan is allowed to hydrate into the actual production queue', async () => {
  const s = inspect([
    state({ planReady: true, conversationReady: true, buttons: ['确认，开始制作', '需要调整'] }),
    state({ queueVisible: true }),
  ], 'confirm_pending')
  assert.equal((await s.run()).status, 'queued')
  assert.deepEqual(s.clicks, [])
})

test('platform queue after final confirmation is queued, including when an editor exists', async () => {
  for (const editorReady of [false, true]) {
    const s = inspect([state({ editorReady, queueVisible: true, exportDialogOpen: true, exportReady: true })], 'confirm_pending')
    assert.equal((await s.run()).status, 'queued')
    assert.deepEqual(s.clicks, [])
  }
})

test('editor with disabled export or disabled download is creating', async () => {
  for (const patch of [{ buttons: [] }, { buttons: ['导出'], exportDialogOpen: true, exportReady: false }]) {
    const s = inspect([state({ editorReady: true, ...patch })], 'submitted')
    assert.equal((await s.run()).status, 'creating')
    assert.deepEqual(s.clicks, [])
  }
})

test('completed requires an available download in the export dialog; inspection never downloads or publishes', async () => {
  const s = inspect([
    state({ editorReady: true, buttons: ['导出'], productionFinished: true }),
    state({ editorReady: true, exportDialogOpen: true, exportReady: true, buttons: ['导出', '下载成片', '发布B站'] }),
  ], 'submitted')
  assert.equal((await s.run()).status, 'completed')
  assert.deepEqual(s.clicks, ['导出'])
})

test('an export launcher that is not ready yet keeps the accepted production running', async () => {
  const s = inspect([state({ editorReady: true, buttons: ['导出'], productionFinished: true })], 'submitted')
  const result = await s.run()
  assert.equal(result.status, 'creating', 'an unavailable export dialog must not fail the accepted production or claim it is complete')
  assert.match(result.message, /等待.*导出/)
  assert.deepEqual(s.clicks, ['导出', '导出'])
})

test('an ignored export click is retried after hydration without creating or confirming production again', async () => {
  let time = 0, opens = 0
  const result = await inspectHuashengPage({
    read: async () => state({ editorReady: true, buttons: ['导出'], exportDialogOpen: opens === 2, exportReady: opens === 2 }),
    fillScript: async () => assert.fail('already submitted'),
    click: async label => { assert.equal(label, '导出'); opens++ },
  }, { projectUrl, checkpoint: 'submitted', signal: new AbortController().signal },
  { now: () => time, sleep: async ms => { time += ms }, timeoutMs: 15_000, pollMs: 500 })
  assert.equal(result.status, 'completed')
  assert.equal(opens, 2)
  assert.ok(time >= 5000)
})

test('stale inspection refreshes only the existing conversation and does not replay confirmations', async () => {
  const s = inspect([
    state({ conversationStale: true, buttons: ['刷新对话', '确认'] }),
    state({ editorReady: true, buttons: [] }),
  ], 'submitted')
  assert.equal((await s.run()).status, 'creating')
  assert.deepEqual(s.clicks, ['刷新对话'])
})

test('login, unknown loading, wrong project, and page errors fail inspection instead of replacing a known status', async () => {
  for (const patch of [{ loginRequired: true }, {}, { url: 'https://www.huasheng.cn/video/987' }, { error: '请求失败' }]) {
    const s = inspect([state(patch)], 'submitted')
    await assert.rejects(s.run)
    assert.deepEqual(s.clicks, [])
  }
})

test('canceled inspection cannot open export or submit any command', async () => {
  const controller = new AbortController()
  controller.abort(new Error('inspection canceled'))
  const s = inspect([state({ editorReady: true, buttons: ['导出'] })], 'submitted', controller.signal)
  await assert.rejects(s.run, /inspection canceled/)
  assert.deepEqual(s.clicks, [])
})
