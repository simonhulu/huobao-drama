import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCbaAccountsRoute } from './cba-accounts.js'
import { SocialUploadAccountsService } from '../services/social-upload-accounts.js'

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-accounts-route-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = new SocialUploadAccountsService({ stateRoot: root, driver: async (_action, _account, onQr) => { onQr?.('data:image/png;base64,iVBORw0KGgo='); return { ready: true } } })
  return { service, route: createCbaAccountsRoute({ service }) }
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('account routes add, list, check, select default and expose a bounded login session', async t => {
  const { route } = fixture(t)
  const added = await route.request('/', post({ label: '篮球号' }))
  assert.equal(added.status, 200); const account = (await added.json()).data
  assert.equal(account.status, 'login_required')
  assert.equal((await (await route.request('/')).json()).data.accounts.length, 1)
  const checked = await route.request(`/${account.accountName}/check`, post({}))
  assert.equal((await checked.json()).data.status, 'ready')
  const selected = await route.request(`/${account.accountName}/default`, post({}))
  assert.equal((await selected.json()).data.defaultAccountName, account.accountName)
  const started = await route.request(`/${account.accountName}/login`, post({}))
  assert.equal(started.status, 202); const session = (await started.json()).data
  const polled = await route.request(`/logins/${session.id}`)
  assert.equal(polled.headers.get('cache-control'), 'no-store')
  assert.equal((await polled.json()).data.status, 'ready')
})

test('account routes reject cross-origin reads/writes, unexpected properties and unsafe account names', async t => {
  const { route } = fixture(t)
  assert.equal((await route.request('/', { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await route.request('/', { ...post({ label: '主号' }), headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await route.request('/', post({ label: '主号', cookies: 'no' }))).status, 400)
  assert.equal((await route.request('/bad/check', post({}))).status, 400)
  assert.equal((await route.request('/logins/missing')).status, 404)
  assert.equal((await route.request('/', { method: 'POST', body: JSON.stringify({ label: '主号' }) })).status, 400)
})
