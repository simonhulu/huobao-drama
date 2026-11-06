import test from 'node:test'
import assert from 'node:assert/strict'
import { driveHuashengPage, type HuashengPageState, type HuashengCheckpoint } from './history-huasheng-browser.js'

const projectUrl = 'https://www.huasheng.cn/video/260077919617177'
const script = '韩信率军进攻赵国，双方在井陉交战。'
const scheme = 'A - 素材剪辑成片'
const state = (patch: Partial<HuashengPageState> = {}): HuashengPageState => ({
  url: projectUrl, loggedIn: true, loginRequired: false, scriptPresent: true,
  buttons: [], requirementsReady: false, planReady: false, productionStarted: false,
  productionFinished: false, cost: null, error: null, ...patch,
})

test('a failed scheme click never records the choice as already accepted', async () => {
  const updates: HuashengCheckpoint[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ buttons: [scheme] }),
    fillScript: async () => { assert.fail('existing project must be reused') },
    click: async () => { throw new Error('target detached before the click') },
  }, { jobId: 8, script, projectUrl, checkpoint: 'created', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }), /target detached/)
  assert.ok(updates.length > 0, 'persist pending intent before a remote action')
  assert.ok(updates.every(update => !update.message.includes('已选择')), 'pending intent must not be presented as a successful reply')
})

test('an unacknowledged scheme choice can recover in the same project instead of waiting indefinitely', async () => {
  let time = 0
  let accepted = false
  const clicks: string[] = []
  const updates: HuashengCheckpoint[] = []
  const result = await driveHuashengPage({
    read: async () => accepted ? state({ productionStarted: true }) : state({ buttons: [scheme], schemeChoicePending: true }),
    fillScript: async () => { assert.fail('must not create another project') },
    click: async label => { clicks.push(label); accepted = true },
  }, { jobId: 8, script, projectUrl, checkpoint: 'scheme_pending', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.deepEqual(clicks, [scheme])
  assert.equal(updates.at(-1)?.checkpoint, 'submitted')
})

test('scheme retries are bounded and report missing acknowledgement without claiming success', async () => {
  let time = 0
  const clicks: number[] = []
  const updates: HuashengCheckpoint[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ buttons: [scheme], schemeChoicePending: true }),
    fillScript: async () => { assert.fail('must not create another project') },
    click: async () => { clicks.push(time) },
  }, { jobId: 8, script, projectUrl, checkpoint: 'created', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 }), /未确认收到.*方案|方案.*未.*确认/)
  assert.deepEqual(clicks, [0, 15_000, 30_000])
  assert.ok(time < 90_000)
  assert.ok(updates.every(update => !update.message.includes('已选择')))
})

test('visible scheme reply prevents retries while the requirements are still generating', async () => {
  let time = 0
  const updates: HuashengCheckpoint[] = []
  const result = await driveHuashengPage({
    read: async () => time < 40_000 ? state({ buttons: [scheme], schemeReplyPresent: true }) : state({ productionStarted: true }),
    fillScript: async () => { assert.fail('must not create another project') },
    click: async () => { assert.fail('an accepted reply must not be sent again') },
  }, { jobId: 8, script, projectUrl, checkpoint: 'scheme_pending', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.ok(updates.some(update => update.message.includes('页面显示 A 方案回复')))
})

test('restored unacknowledged requirements confirmation resumes in the original project', async () => {
  let time = 0
  let accepted = false
  const clicks: string[] = []
  const result = await driveHuashengPage({
    read: async () => accepted ? state({ productionStarted: true }) : state({
      requirementsReady: true, buttons: ['确认', '需要修改'], requirementsChoicePending: true,
    }),
    fillScript: async () => { assert.fail('must reuse the existing project') },
    click: async label => { clicks.push(label); accepted = true },
  }, { jobId: 9, script, projectUrl, checkpoint: 'requirements_pending', signal: new AbortController().signal,
    onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.deepEqual(clicks, ['确认'])
})

test('requirements confirmation retries are bounded without recording acceptance', async () => {
  let time = 0
  const clicks: number[] = []
  const updates: HuashengCheckpoint[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ requirementsReady: true, buttons: ['确认', '需要修改'], requirementsChoicePending: true }),
    fillScript: async () => { assert.fail('must reuse the existing project') },
    click: async () => { clicks.push(time) },
  }, { jobId: 9, script, projectUrl, checkpoint: 'scheme_pending', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 }), /尚未确认收到成片需求回复/)
  assert.deepEqual(clicks, [0, 15_000, 30_000])
  assert.ok(updates.every(update => !update.message.includes('已确认')))
})

test('a rolled-back requirements reply does not permanently suppress recovery', async () => {
  let time = 0
  const clicks: number[] = []
  const result = await driveHuashengPage({
    read: async () => clicks.length >= 2 ? state({ productionStarted: true }) : state({
      requirementsReady: true, buttons: ['确认', '需要修改'],
      requirementsChoicePending: clicks.length === 0 || time >= 8000,
      requirementsReplyPresent: clicks.length === 1 && time < 8000,
    }),
    fillScript: async () => { assert.fail('must reuse the existing project') },
    click: async () => { clicks.push(time) },
  }, { jobId: 9, script, projectUrl, checkpoint: 'scheme_pending', signal: new AbortController().signal,
    onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(clicks.length, 2)
  assert.ok(clicks[1]! >= 15_000)
})

test('a stalled optimistic reply is reconciled by reloading the original conversation before recovery', async () => {
  let time = 0
  let optimistic = true
  let accepted = false
  let reloads = 0
  const clicks: string[] = []
  const result = await driveHuashengPage({
    read: async () => accepted ? state({ productionStarted: true }) : state({
      requirementsReady: true, buttons: optimistic ? [] : ['确认', '需要修改'],
      requirementsChoicePending: !optimistic, requirementsReplyPresent: optimistic,
    }),
    reload: async () => { reloads++; optimistic = false },
    fillScript: async () => { assert.fail('must reuse the existing project') },
    click: async label => { clicks.push(label); accepted = true },
  }, { jobId: 9, script, projectUrl, checkpoint: 'requirements_pending', signal: new AbortController().signal,
    onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(reloads, 1)
  assert.deepEqual(clicks, ['确认'])
})

test('a persisted reply survives reconciliation without being sent twice', async () => {
  let time = 0
  let reloads = 0
  const result = await driveHuashengPage({
    read: async () => time >= 75_000 ? state({ productionStarted: true }) : state({
      requirementsReady: true, requirementsReplyPresent: true,
    }),
    reload: async () => { reloads++ },
    fillScript: async () => { assert.fail('must reuse the existing project') },
    click: async () => { assert.fail('a persisted reply must not be sent twice') },
  }, { jobId: 9, script, projectUrl, checkpoint: 'requirements_pending', signal: new AbortController().signal,
    onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(reloads, 1)
})

test('standard quota exhaustion still allows free planning confirmation into the platform queue', async () => {
  let time = 0
  let confirmed = false
  const clicks: string[] = []
  const updates: HuashengCheckpoint[] = []
  const result = await driveHuashengPage({
    read: async () => confirmed ? state({ queueVisible: true }) : state({ planReady: true, cost: 0,
      standardQuotaExhausted: true, buttons: ['确认并继续', '快速模式继续 预估花生米 219'] }),
    fillScript: async () => { assert.fail('must reuse existing project') },
    reload: async () => { assert.fail('quota is not a reload condition') },
    click: async label => { clicks.push(label); confirmed = true },
  }, { jobId: 10, script, projectUrl, checkpoint: 'plan_opened', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 5000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.deepEqual(clicks, ['确认并继续'])
  assert.equal(updates.at(-1)?.checkpoint, 'submitted')
  assert.equal(updates.at(-1)?.productionStatus, 'queued')
})

test('quota exhaustion without the free planning confirmation remains actionable and never pays', async () => {
  let time = 0
  await assert.rejects(driveHuashengPage({
    read: async () => state({ planReady: true, cost: 0, standardQuotaExhausted: true,
      buttons: ['快速模式继续 预估花生米 219'] }),
    fillScript: async () => { assert.fail('must reuse existing project') },
    reload: async () => { assert.fail('quota is an explicit platform limit') },
    click: async () => { assert.fail('must not confirm paid production') },
  }, { jobId: 10, script, projectUrl, checkpoint: 'confirm_pending', signal: new AbortController().signal,
    onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 5000 }), /标准模式额度已用完.*待额度恢复/)
})

test('a confirm-pending project with its plan action still visible reopens the plan and enters the queue', async () => {
  let time = 0
  let phase: 'plan' | 'dialog' | 'queued' = 'plan'
  const clicks: string[] = []
  const updates: HuashengCheckpoint[] = []
  const result = await driveHuashengPage({
    read: async () => phase === 'plan'
      ? state({ planReady: true, buttons: ['确认，开始制作', '需要调整'] })
      : phase === 'dialog'
        ? state({ planReady: true, cost: 0, standardQuotaExhausted: true,
          buttons: ['确认并继续', '快速模式继续 预估花生米 106'] })
        : state({ queueVisible: true }),
    fillScript: async () => { assert.fail('must reuse existing project') },
    click: async label => { clicks.push(label); phase = label === '确认，开始制作' ? 'dialog' : 'queued' },
  }, { jobId: 11, script, projectUrl, checkpoint: 'confirm_pending', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 5000 })
  assert.equal(result.projectUrl, projectUrl)
  assert.deepEqual(clicks, ['确认，开始制作', '确认并继续'])
  assert.equal(updates.at(-1)?.checkpoint, 'submitted')
  assert.equal(updates.at(-1)?.productionStatus, 'queued')
})

test('HTTP success with business quota rejection stops without replaying or buying fast mode', async () => {
  let time = 0
  const clicks: string[] = []
  const updates: HuashengCheckpoint[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ planReady: true, cost: 0,
      buttons: ['确认并继续', '快速模式继续 预估花生米 97'],
    }),
    fillScript: async () => { assert.fail('must reuse existing project') },
    click: async label => { clicks.push(label); return { code: 10008, message: '今天创建项目超量啦，可以使用fast模式继续创建' } },
  }, { jobId: 11, script, projectUrl, checkpoint: 'plan_opened', signal: new AbortController().signal,
    onCheckpoint: async update => { updates.push(update) },
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 }), /10008.*标准模式.*额度/)
  assert.deepEqual(clicks, ['确认并继续'])
  assert.equal(updates.at(-1)?.checkpoint, 'quota_waiting')
  assert.ok(updates.every(update => update.checkpoint !== 'submitted'))
})

test('an unknown final response and a quota notice cannot authorize another final confirmation', async () => {
  let time = 0
  const clicks: string[] = []
  await assert.rejects(driveHuashengPage({
    read: async () => state({ planReady: true, cost: 0, standardQuotaExhausted: true,
      buttons: ['确认并继续', '快速模式继续 预估花生米 97'] }),
    fillScript: async () => { assert.fail('must reuse existing project') },
    click: async label => { clicks.push(label) },
  }, { jobId: 11, script, projectUrl, checkpoint: 'confirm_pending', signal: new AbortController().signal,
    onCheckpoint: async () => {},
  }, { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 90_000 }), /标准模式.*额度/)
  assert.deepEqual(clicks, [])
})
