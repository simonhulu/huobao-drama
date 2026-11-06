import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import puppeteer from 'puppeteer-core'
import { ScienceHuashengAccountsService, type ScienceHuashengAccountDriver } from './science-accounts.js'
import { SocialUploadAccountsService } from './social-upload-accounts.js'
import { connectHuashengBrowser, resolveHuashengBrowserConfig } from './history-huasheng-browser.js'

function fixture(t: any, driver: ScienceHuashengAccountDriver = async () => ({ status: 'ready', message: 'ready', identity: { uid: '2002', displayName: '科普用户' } })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-accounts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, service: new ScienceHuashengAccountsService({ stateRoot: root, driver }) }
}

test('science Huasheng accounts retain separate profiles, ports and defaults across restart', async t => {
  const calls: Array<{ endpoint: string; profile: string }> = []
  const { root, service } = fixture(t, async (_action, config) => { calls.push(config); return { status: 'ready', message: 'ready', identity: { uid: new URL(config.endpoint).port, displayName: '科普用户' } } })
  const first = service.create({ label: '冷知识主号' }), second = service.create({ label: '冷知识副号' })
  const firstConfig = service.browserConfig(first.accountName), secondConfig = service.browserConfig(second.accountName)
  assert.notEqual(firstConfig.endpoint, secondConfig.endpoint)
  assert.notEqual(firstConfig.profile, secondConfig.profile)
  assert.equal(firstConfig.endpoint, 'http://127.0.0.1:9250')
  service.setDefault(second.accountName)
  await service.openLogin(first.accountName)
  await service.check(second.accountName)
  assert.deepEqual(calls, [firstConfig, secondConfig])
  const restored = new ScienceHuashengAccountsService({ stateRoot: root })
  assert.deepEqual(restored.browserConfig(first.accountName), firstConfig)
  assert.equal(restored.list().defaultAccountName, second.accountName)
  assert.equal(restored.get(first.accountName).status, 'ready')
  assert.doesNotMatch(JSON.stringify(restored.list()), /profile|endpoint|port|cookies|token|\/Users\//)
  assert.equal(fs.statSync(path.join(root, 'accounts.json')).mode & 0o777, 0o600)
})

test('account failure stays scoped and never returns driver secrets; login requests deduplicate', async t => {
  let reject!: (error: Error) => void, calls = 0
  const { service } = fixture(t, async () => { calls++; return new Promise((_resolve, rejectWork) => { reject = rejectWork }) })
  const first = service.create({ label: '主号' }), second = service.create({ label: '副号' })
  const login = service.openLogin(first.accountName), concurrent = service.openLogin(first.accountName)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  reject(new Error('cookie=SECRET /private/profile'))
  assert.equal((await login).status, 'error')
  assert.equal((await concurrent).status, 'error')
  assert.equal(service.get(second.accountName).status, 'login_required')
  assert.doesNotMatch(JSON.stringify(service.list()), /SECRET|private/)
  assert.throws(() => service.get('../profiles'), /编号无效/)
  assert.throws(() => service.create({ label: '主号' }), /同名/)
})

test('science Baijiahao namespace cannot select CBA accounts or change their defaults', t => {
  const { root } = fixture(t)
  const cba = new SocialUploadAccountsService({ stateRoot: path.join(root, 'cba') })
  const science = new SocialUploadAccountsService({ stateRoot: path.join(root, 'science'), accountPrefix: 'science' })
  const sport = cba.create({ label: '体育' }), knowledge = science.create({ label: '科普' })
  assert.match(knowledge.accountName, /^science_[a-f0-9]{32}$/)
  assert.throws(() => science.get(sport.accountName), /编号无效/)
  assert.throws(() => cba.setDefault(knowledge.accountName), /编号无效/)
  assert.equal(cba.list().defaultAccountName, sport.accountName)
  const restored = new SocialUploadAccountsService({ stateRoot: path.join(root, 'science'), accountPrefix: 'science' })
  assert.equal(restored.get(knowledge.accountName).label, '科普')
})

test('explicit browser account configuration does not change the history defaults', () => {
  const before = resolveHuashengBrowserConfig()
  const explicit = resolveHuashengBrowserConfig({ endpoint: 'http://127.0.0.1:9251', profile: '/tmp/science-profile' })
  assert.equal(explicit.endpoint, 'http://127.0.0.1:9251')
  assert.equal(explicit.profile, '/tmp/science-profile')
  assert.deepEqual(resolveHuashengBrowserConfig(), before)
  assert.throws(() => resolveHuashengBrowserConfig({ endpoint: 'https://external.example:9250', profile: '/tmp/science-profile' }), /本机/)
})

test('browser connection validates the selected account profile before using its session', async t => {
  const endpoints: string[] = [], disconnects: string[] = []
  t.mock.method(puppeteer, 'connect', async (input: { browserURL: string }) => {
    endpoints.push(input.browserURL)
    return {
      target: () => ({ createCDPSession: async () => ({ send: async () => ({ arguments: ['--user-data-dir=/tmp/science-profile'] }), detach: async () => {} }) }),
      disconnect: async () => { disconnects.push(input.browserURL) },
    }
  })
  const selected = { endpoint: 'http://127.0.0.1:9251', profile: '/tmp/science-profile' }
  const browser = await connectHuashengBrowser(selected)
  await browser.disconnect()
  await assert.rejects(connectHuashengBrowser({ ...selected, profile: '/tmp/another-account' }), /专用浏览器/)
  assert.deepEqual(endpoints, [selected.endpoint, selected.endpoint])
  assert.deepEqual(disconnects, [selected.endpoint, selected.endpoint])
})
