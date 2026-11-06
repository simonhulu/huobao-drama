import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createScienceAccountsRoute } from './science-accounts.js'
import { ScienceHuashengAccountsService } from '../services/science-accounts.js'
import { SocialUploadAccountsService } from '../services/social-upload-accounts.js'

const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-accounts-route-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return createScienceAccountsRoute({
    huasheng: new ScienceHuashengAccountsService({ stateRoot: path.join(root, 'huasheng'), driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: '2002', displayName: '科普用户' } }) }),
    baijiahao: new SocialUploadAccountsService({ stateRoot: path.join(root, 'baijiahao'), accountPrefix: 'science', driver: async () => ({ ready: true }) }),
  })
}

test('science account routes manage both services with independent defaults and Huasheng login', async t => {
  const route = fixture(t)
  const hua = await (await route.request('/huasheng', post({ label: '科普制作' }))).json()
  const bai = await (await route.request('/baijiahao', post({ label: '科普发布' }))).json()
  assert.match(hua.data.accountName, /^science_huasheng_/)
  assert.match(bai.data.accountName, /^science_[a-f0-9]/)
  for (const [platform, name] of [['huasheng', hua.data.accountName], ['baijiahao', bai.data.accountName]]) {
    const list = await route.request(`/${platform}`)
    assert.equal(list.headers.get('cache-control'), 'no-store')
    assert.equal((await list.json()).data.defaultAccountName, name)
    const checked = await route.request(`/${platform}/${name}/check`, post({}))
    assert.equal((await checked.json()).data.status, 'ready')
    assert.equal((await route.request(`/${platform}/${name}/default`, post({}))).status, 200)
  }
  assert.equal((await (await route.request(`/huasheng/${hua.data.accountName}/login`, post({}))).json()).data.status, 'ready')
  assert.equal((await route.request(`/baijiahao/${bai.data.accountName}/login`, post({}))).status, 202)
})

test('science account routes block cross-origin access and reject credentials, arbitrary profiles and account names', async t => {
  const route = fixture(t)
  assert.equal((await route.request('/huasheng', { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await route.request('/baijiahao', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  assert.equal((await route.request('/huasheng', post({ label: '主号', profile: '/private' }))).status, 400)
  assert.equal((await route.request('/baijiahao', post({ label: '主号', cookies: 'secret' }))).status, 400)
  assert.equal((await route.request('/huasheng/invalid/login', post({}))).status, 400)
  assert.equal((await route.request('/huasheng', { method: 'POST', body: '{}' })).status, 400)
})
