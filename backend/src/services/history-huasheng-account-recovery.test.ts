import test from 'node:test'
import assert from 'node:assert/strict'
import { driveHuashengPage, HuashengBrowserError, type HuashengPageState } from './history-huasheng-browser.js'

const projectUrl = 'https://www.huasheng.cn/video/123456789'
const script = 'Original saved narration.'
const confirmation = (): HuashengPageState => ({
  url: projectUrl, loggedIn: true, loginRequired: false, scriptPresent: true,
  buttons: ['确认并继续'], requirementsReady: false, planReady: true,
  productionStarted: false, productionFinished: false, cost: 0, error: null,
})

function fixture() {
  let checkpoint = 'plan_opened'
  let time = 0
  const input = () => ({
    jobId: 'account-recovery', script, projectUrl, checkpoint,
    signal: new AbortController().signal,
    onCheckpoint: async (update: { checkpoint: string }) => { checkpoint = update.checkpoint },
  })
  const options = { timeoutMs: 100, pollMs: 10, now: () => time, sleep: async (ms: number) => { time += ms } }
  const fillScript = async () => { assert.fail('the original project must be reused') }
  return { input, options, fillScript, checkpoint: () => checkpoint }
}

test('a known account mismatch before confirmation preserves a retryable checkpoint and confirms once after recovery', async () => {
  const f = fixture()
  let dispatched = 0
  await assert.rejects(driveHuashengPage({
    read: async () => confirmation(), fillScript: f.fillScript,
    click: async () => {
      throw new HuashengBrowserError('manual_review', 'Account identity mismatch before click', true)
    },
  }, f.input(), f.options), /identity mismatch/)
  assert.equal(f.checkpoint(), 'plan_opened', 'the identity check proves no confirmation was dispatched')

  const result = await driveHuashengPage({
    read: async () => ({ ...confirmation(), productionStarted: dispatched > 0 }), fillScript: f.fillScript,
    click: async label => { assert.equal(label, '确认并继续'); dispatched++ },
  }, f.input(), f.options)
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(dispatched, 1)
  assert.equal(f.checkpoint(), 'submitted')
})

test('an unknown confirmation result retains its dispatch checkpoint and cannot replay after account recovery', async () => {
  const f = fixture()
  let attempts = 0
  await assert.rejects(driveHuashengPage({
    read: async () => confirmation(), fillScript: f.fillScript,
    click: async () => { attempts++; throw new Error('Connection lost during confirmation') },
  }, f.input(), f.options), /Connection lost/)
  assert.equal(f.checkpoint(), 'confirm_pending')

  await assert.rejects(driveHuashengPage({
    read: async () => confirmation(), fillScript: f.fillScript,
    click: async () => { attempts++; assert.fail('an uncertain confirmation cannot be replayed') },
  }, f.input(), f.options), (error: unknown) => error instanceof HuashengBrowserError && error.code === 'timeout')
  assert.equal(attempts, 1)
  assert.equal(f.checkpoint(), 'confirm_pending')
})

test('canceling the identity preparation keeps the original step and can later confirm once', async () => {
  const f = fixture()
  const controller = new AbortController()
  let dispatched = 0
  const port = {
    read: async () => confirmation(), fillScript: f.fillScript,
    prepareAction: async () => {
      controller.abort(new Error('Canceled while checking account identity'))
      controller.signal.throwIfAborted()
    },
    click: async () => { dispatched++ },
  }
  await assert.rejects(driveHuashengPage(port, { ...f.input(), signal: controller.signal }, f.options))
  assert.equal(f.checkpoint(), 'plan_opened')
  assert.equal(dispatched, 0, 'canceling preparation cannot dispatch a confirmation')

  const result = await driveHuashengPage({
    read: async () => ({ ...confirmation(), productionStarted: dispatched > 0 }), fillScript: f.fillScript,
    click: async label => { assert.equal(label, '确认并继续'); dispatched++ },
  }, f.input(), f.options)
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(dispatched, 1)
  assert.equal(f.checkpoint(), 'submitted')
})
