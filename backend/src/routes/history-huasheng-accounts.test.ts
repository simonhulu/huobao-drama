import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHistoryHuashengRoute } from './history-huasheng.js'
import { HuashengAccountsService, HISTORY_HUASHENG_ACCOUNT } from '../services/huasheng-accounts.js'

test('history exposes its own account and validates commands without accessing the production queue', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-accounts-route-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let calls = 0
  const accounts = new HuashengAccountsService({ scope: 'history', stateRoot: root,
    legacyConfig: { endpoint: 'http://127.0.0.1:9243', profile: path.join(root, 'original') },
    driver: async () => { calls++; return { status: 'ready', message: 'ready', identity: { uid: '1001', displayName: '历史用户' } } } })
  const route = createHistoryHuashengRoute({ accounts })
  const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const read = await route.request('/huasheng/accounts')
  assert.equal(read.headers.get('Cache-Control'), 'no-store')
  assert.equal((await read.json()).data.accounts[0].scope, 'history')
  assert.equal(calls, 0)
  const base = `/huasheng/accounts/${HISTORY_HUASHENG_ACCOUNT}`
  for (const action of ['check', 'login']) {
    const response = await route.request(`${base}/${action}`, post({}))
    const result = (await response.json()).data
    assert.equal(response.status, 200); assert.equal(result.identityStatus, 'verified'); assert.equal(result.identity.uid, '1001')
  }
  assert.equal((await route.request(`${base}/check`, post({ profile: '/other', cookies: 'private' }))).status, 400)
  assert.equal((await route.request('/huasheng/accounts/science_huasheng_0123456789abcdef0123456789abcdef/check', post({}))).status, 400)
  assert.equal((await route.request(`${base}/check`, { ...post({}), headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' } })).status, 403)
  assert.equal(calls, 2)
})
