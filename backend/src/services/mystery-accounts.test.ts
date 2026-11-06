import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HuashengAccountsService, HISTORY_HUASHENG_ACCOUNT, type HuashengAccountScope } from './huasheng-accounts.js'
import { MysteryHuashengAccountsService } from './mystery-accounts.js'
import { SocialUploadAccountsService } from './social-upload-accounts.js'
import { createMysteryAccountsRoute } from '../routes/mystery-accounts.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-accounts-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))
function workspaceFixture(t: any) {
  const directory = fs.mkdtempSync(path.join(root, 'three-'))
  const roots = { history: path.join(directory, 'history'), science: path.join(directory, 'science'), mystery: path.join(directory, 'mystery') }
  const uids = { history: '1001', science: '2002', mystery: '3003' }
  const services = Object.fromEntries(Object.entries(roots).map(([scope, stateRoot]) => [scope, new HuashengAccountsService({
    scope: scope as HuashengAccountScope, stateRoot,
    peerStateRoots: Object.values(roots).filter(value => value !== stateRoot),
    legacyConfig: { endpoint: 'http://127.0.0.1:9240', profile: path.join(directory, 'history-browser') },
    driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: uids[scope as HuashengAccountScope], displayName: scope } }),
  })])) as Record<HuashengAccountScope, HuashengAccountsService>
  const names = { history: HISTORY_HUASHENG_ACCOUNT, science: services.science.create({ label: '科普' }).accountName,
    mystery: services.mystery.create({ label: '故事' }).accountName }
  return { roots, uids, services, names }
}

test('all three workspaces have isolated identity, profiles, ports and persisted defaults', async t => {
  const f = workspaceFixture(t), configs = Object.entries(f.names).map(([scope, name]) => f.services[scope as HuashengAccountScope].browserConfig(name))
  assert.equal(new Set(configs.map(config => config.endpoint)).size, 3)
  assert.equal(new Set(configs.map(config => config.profile)).size, 3)
  assert.match(f.names.mystery, /^mystery_huasheng_[a-f0-9]{32}$/)
  for (const scope of Object.keys(f.names) as HuashengAccountScope[]) assert.equal((await f.services[scope].check(f.names[scope])).identityStatus, 'verified')
  const restored = new MysteryHuashengAccountsService({ stateRoot: f.roots.mystery, peerStateRoots: [f.roots.history, f.roots.science] })
  assert.equal(restored.get(f.names.mystery).identity?.uid, '3003')
  assert.equal(restored.list().defaultAccountName, f.names.mystery)
  assert.throws(() => restored.get(f.names.science), /编号无效/)
  assert.doesNotMatch(JSON.stringify(restored.list()), /profile|endpoint|port|cookies/)
})

test('each pair of workspaces rejects an official user already pinned to the other', async t => {
  for (const [first, second] of [['history', 'science'], ['history', 'mystery'], ['science', 'mystery']] as const) {
    const f = workspaceFixture(t)
    assert.equal((await f.services[first].check(f.names[first])).identityStatus, 'verified')
    f.uids[second] = f.uids[first]
    assert.equal((await f.services[second].check(f.names[second])).identityStatus, 'conflict')
    await assert.rejects(f.services[second].readyBrowserConfig(f.names[second]), /其他专用账号/)
  }
})

test('profile and port collisions with either peer block browser access', t => {
  for (const peer of ['history', 'science'] as const) for (const field of ['profile', 'port'] as const) {
    const f = workspaceFixture(t), config = f.services.mystery.browserConfig(f.names.mystery)
    const file = path.join(f.roots[peer], 'accounts.json'), state = JSON.parse(fs.readFileSync(file, 'utf8'))
    state.accounts[0][field] = field === 'port' ? Number(new URL(config.endpoint).port) : config.profile
    fs.writeFileSync(file, JSON.stringify(state))
    assert.throws(() => f.services.mystery.browserConfig(f.names.mystery), /配置冲突/)
  }
})

test('mystery account route isolates Baijiahao namespace and rejects arbitrary connection settings', async t => {
  const stateRoot = fs.mkdtempSync(path.join(root, 'route-'))
  const route = createMysteryAccountsRoute({
    huasheng: new MysteryHuashengAccountsService({ stateRoot: path.join(stateRoot, 'huasheng'), driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: '3003', displayName: '故事' } }) }),
    baijiahao: new SocialUploadAccountsService({ stateRoot: path.join(stateRoot, 'baijiahao'), accountPrefix: 'mystery' }),
  })
  const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const hua = await (await route.request('/huasheng', post({ label: '故事制作' }))).json()
  const bai = await (await route.request('/baijiahao', post({ label: '故事发表' }))).json()
  assert.match(hua.data.accountName, /^mystery_huasheng_/)
  assert.match(bai.data.accountName, /^mystery_[a-f0-9]/)
  assert.equal((await route.request('/huasheng', { headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await route.request('/huasheng', post({ label: '任意路径', profile: '/tmp/x' }))).status, 400)
  assert.equal((await (await route.request('/huasheng')).json()).data.defaultAccountName, hua.data.accountName)
  assert.equal((await (await route.request('/huasheng/' + hua.data.accountName + '/check', post({}))).json()).data.identityStatus, 'verified')
})

