import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SocialUploadAccountsService, type AccountDriver } from './social-upload-accounts.js'

function fixture(t: any, driver: AccountDriver = async () => ({ ready: true })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sau-accounts-'))
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  return { root, service: new SocialUploadAccountsService({ stateRoot: root, driver }) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('accounts retain independent identity and a persistent default without exposing credentials', t => {
  const { service, root } = fixture(t)
  const first = service.create({ label: '篮球主号' }), second = service.create({ label: '篮球副号' })
  assert.notEqual(first.accountName, second.accountName)
  assert.equal(first.isDefault, true); assert.equal(second.isDefault, false)
  assert.match(first.accountName, /^cba_[a-f0-9]{32}$/)
  service.setDefault(second.accountName)
  const restored = new SocialUploadAccountsService({ stateRoot: root })
  assert.equal(restored.list().defaultAccountName, second.accountName)
  assert.equal(restored.get(first.accountName).label, '篮球主号')
  assert.equal(fs.statSync(path.join(root, 'accounts.json')).mode & 0o777, 0o600)
  assert.doesNotMatch(JSON.stringify(restored.list()), /cookies|\/Users\/|token|account_file/)
  assert.throws(() => service.create({ label: '篮球主号' }), /已有同名/)
  assert.throws(() => service.create({ label: '\n' }), /账号备注/)
  assert.throws(() => service.get('../cookies'), /账号编号无效/)
})

test('QR login starts once, updates readiness, removes QR after completion and leaves other account unchanged', async t => {
  let done!: (value: { ready: boolean }) => void, calls = 0
  const driver: AccountDriver = async (_action, _name, onQr) => {
    calls++; onQr?.('data:image/png;base64,iVBORw0KGgo=')
    return new Promise(resolve => { done = resolve })
  }
  const { service } = fixture(t, driver)
  const first = service.create({ label: '主号' }), second = service.create({ label: '副号' })
  const login = service.startLogin(first.accountName)
  assert.equal(login.status, 'waiting_scan'); assert.match(login.qrDataUrl!, /^data:image\/png/)
  assert.equal(service.startLogin(first.accountName).id, login.id); assert.equal(calls, 1)
  assert.equal((await service.check(first.accountName)).status, 'logging_in'); assert.equal(calls, 1)
  done({ ready: true }); await tick()
  assert.equal(service.login(login.id).status, 'ready'); assert.equal(service.login(login.id).qrDataUrl, undefined)
  assert.equal(service.get(first.accountName).status, 'ready')
  assert.equal(service.get(second.accountName).status, 'login_required')
})

test('failures expose a retryable message without leaking driver exceptions; new login retries', async t => {
  const { service } = fixture(t, async () => { throw Error('Bearer SECRET /private/cookies.json') })
  const account = service.create({ label: '主号' }), login = service.startLogin(account.accountName)
  await tick()
  assert.equal(service.login(login.id).status, 'failed')
  assert.doesNotMatch(JSON.stringify(service.list()), /SECRET|private/)
  const retry = service.startLogin(account.accountName)
  assert.notEqual(retry.id, login.id)
  await tick()
  assert.equal((await service.check(account.accountName)).status, 'error')
})

test('interrupted login resets after backend restart and stale sessions cannot be resumed', t => {
  const { service, root } = fixture(t, () => new Promise(() => {}))
  const account = service.create({ label: '主号' }), session = service.startLogin(account.accountName)
  const restored = new SocialUploadAccountsService({ stateRoot: root })
  assert.equal(restored.get(account.accountName).status, 'login_required')
  assert.throws(() => restored.login(session.id), /登录会话已结束/)
})

test('readiness checks are deduplicated and expired accounts require login', async t => {
  let done!: (value: { ready: boolean }) => void, calls = 0
  const { service } = fixture(t, async () => { calls++; return new Promise(resolve => { done = resolve }) })
  const account = service.create({ label: '主号' })
  const first = service.check(account.accountName), second = service.check(account.accountName)
  assert.equal(calls, 1); assert.throws(() => service.startLogin(account.accountName), /正在检查/)
  done({ ready: false })
  assert.equal((await first).status, 'expired'); assert.equal((await second).status, 'expired')
})
