import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const historyBase = '/api/v1/history-scripts/huasheng/accounts'
const scienceBase = '/api/v1/science-pop/workflow/accounts/huasheng'
const checkedAt = '2026-11-01T04:00:00.000Z'
const accountFixture = (scope, overrides = {}) => ({
  accountName: scope === 'history' ? 'history_huasheng_legacy' : 'science_huasheng_test',
  label: scope === 'history' ? '历史专用账号' : '科普专用账号', scope,
  status: 'ready', message: '账号身份已核验', isDefault: true,
  identity: { uid: `${scope}-uid`, displayName: `${scope === 'history' ? '历史' : '科普'}创作者` },
  observedIdentity: { uid: `${scope}-uid`, displayName: `${scope === 'history' ? '历史' : '科普'}创作者` },
  identityStatus: 'verified', checkedAt, updatedAt: checkedAt, ...overrides,
})

async function harness(t, scope = 'history', options = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: options.viewport || { width: 1280, height: 960 } })
  page.setDefaultTimeout(6000)
  const accounts = [accountFixture(scope, options.account)]
  const state = { failRead: false, failAction: false, holdAction: false, pending: [], accounts }
  const writes = [], reads = [], errors = [], unexpected = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseUrl).origin ? route.continue() : route.abort('blockedbyclient'))
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
    const activeBase = scope === 'history' ? historyBase : scienceBase
    const result = data => route.fulfill({ json: { code: 200, data } })
    if (method === 'GET') reads.push(path)
    else writes.push({ method, path, body: request.postDataJSON() })
    if (path === activeBase || path.startsWith(`${activeBase}/`)) {
      if (method === 'GET' && path === activeBase) {
        if (state.failRead) return route.fulfill({ status: 503, json: { code: 503, message: '账号列表暂不可用' } })
        return result({ accounts, scope, defaultAccountName: accounts.find(account => account.isDefault)?.accountName || null })
      }
      if (state.holdAction) await new Promise(resolve => state.pending.push(resolve))
      if (state.failAction) return route.fulfill({ status: 503, json: { code: 503, message: '账号检查暂不可用' } })
      if (method === 'POST' && path === scienceBase) {
        const added = accountFixture('science', { accountName: 'science_huasheng_second', label: request.postDataJSON().label, isDefault: false, status: 'login_required', identity: null, observedIdentity: null, identityStatus: 'unverified', checkedAt: null })
        accounts.push(added)
        return result(added)
      }
      const [, name, action] = path.slice(activeBase.length).split('/')
      const account = accounts.find(account => account.accountName === name)
      if (account && ['login', 'check', 'default'].includes(action) && method === 'POST') {
        if (action === 'default') {
          accounts.forEach(item => { item.isDefault = item === account })
          return result({ accounts, scope, defaultAccountName: account.accountName })
        }
        return result(account)
      }
    }
    if (method !== 'GET') {
      unexpected.push(`${method} ${path}`)
      return route.fulfill({ status: 405, json: { code: 405, message: '此操作未在测试中授权' } })
    }
    if (path === '/api/v1/science-pop/workflow') return result({ jobs: [], accounts: { huasheng: { accounts, defaultAccountName: accounts[0].accountName }, baijiahao: { accounts: [], defaultAccountName: null } } })
    if (path === '/api/v1/science-pop/workflow/collection') return result({ settings: { youtubeChannels: [], targetCount: 5, mode: 'videos' }, runs: [], activeRun: null })
    if (path === '/api/v1/history-scripts') return result({ items: [], total: 0 })
    if (path === '/api/v1/history-scripts/jobs') return result({ job: null, recent: [], total: 0, hasMore: false })
    if (path === '/api/v1/history-scripts/browser-session') return result({ session: { status: 'ready', canCollect: true, checkedAt, checks: [] } })
    if (path === '/api/v1/history-scripts/huasheng') return result({ enabled: false, browser: { status: 'ready', message: '账号身份已核验' }, productionChecking: false, jobs: [] })
    if (path === '/api/v1/history-scripts/huasheng/exports') return result({ enabled: false, jobs: [] })
    if (path === '/api/v1/history-scripts/uploads/runtime') return result({ installed: true, platforms: { baijiahao: { ready: true }, tencent: { ready: true } } })
    if (path === '/api/v1/history-scripts/uploads/candidates') return result({ items: [] })
    if (path === '/api/v1/history-scripts/uploads/jobs' || path === '/api/v1/history-scripts/motion/jobs') return result({ jobs: [] })
    return result({})
  })
  await page.goto(`${baseUrl}/${scope === 'history' ? 'history-scripts' : 'science-pop'}`, { waitUntil: 'domcontentloaded' })
  const open = async () => {
    await page.locator('.page-head').getByRole('button', { name: '花生账号', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `${scope === 'history' ? '历史' : '科普'}花生账号`, exact: true })
    await dialog.waitFor()
    return dialog
  }
  return { page, state, writes, reads, errors, unexpected, open }
}

test('history account entry stays visible in every workspace and only reads its fixed account', async t => {
  const h = await harness(t)
  for (const name of ['视频制作', '稿件库', '百家号发表', '采集任务']) {
    await h.page.getByRole('tab', { name: new RegExp(`^${name}(?:\\s|$)`) }).click()
    assert.equal(await h.page.locator('.page-head').getByRole('button', { name: '花生账号', exact: true }).isVisible(), true)
  }
  const dialog = await h.open()
  await dialog.getByText('历史专用账号', { exact: true }).waitFor()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  assert.match(await dialog.innerText(), /历史创作者[\s\S]*history-uid/)
  assert.equal(await dialog.getByText('绑定身份', { exact: true }).isVisible(), true)
  assert.equal(await dialog.getByText('当前登录', { exact: true }).isVisible(), true)
  assert.equal(await dialog.locator('time').getAttribute('datetime'), checkedAt)
  assert.equal(await dialog.getByLabel('添加花生账号', { exact: true }).count(), 0)
  assert.equal(await dialog.getByRole('button', { name: '设为默认', exact: true }).count(), 0)
  await h.page.screenshot({ path: '/tmp/huasheng-accounts-desktop.png', fullPage: true })
  assert.deepEqual(h.writes, [])
  await h.page.getByRole('button', { name: '关闭历史花生账号管理', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(h.reads.includes(historyBase), true)
  assert.equal(h.reads.includes(scienceBase), false)
  assert.deepEqual(h.errors, [])
})

test('identity states distinguish unverified, wrong, duplicate and unavailable accounts', async t => {
  const h = await harness(t)
  const dialog = await h.open()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  for (const [identityStatus, label] of [['unverified', '待核验'], ['mismatch', '登录账号不匹配'], ['conflict', '账号重复'], ['unavailable', '身份核验失败']]) {
    Object.assign(h.state.accounts[0], { identityStatus, observedIdentity: { uid: 'another-uid', displayName: '另一个创作者' } })
    await dialog.getByRole('button', { name: '刷新账号', exact: true }).click()
    await dialog.getByText(label, { exact: true }).waitFor()
    assert.equal(await dialog.getByText('已核验，可制作', { exact: true }).count(), 0)
    if (identityStatus === 'unverified') assert.equal(await dialog.getByText('账号身份已核验', { exact: true }).count(), 0)
    assert.equal(await dialog.getByText('history-uid', { exact: true }).count(), 1)
    assert.equal(await dialog.getByText('another-uid', { exact: true }).count(), 1)
  }
  Object.assign(h.state.accounts[0], { identityStatus: 'verified', observedIdentity: null })
  await dialog.getByRole('button', { name: '刷新账号', exact: true }).click()
  await dialog.getByText('待核验', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('account actions use one scoped request, disable duplicate clicks and recover after errors', async t => {
  const h = await harness(t)
  const dialog = await h.open()
  const check = dialog.getByRole('button', { name: '检查账号', exact: true })
  h.state.holdAction = true
  await check.evaluate(button => { button.click(); button.click() })
  await h.page.waitForFunction(() => document.querySelector('.account-actions button[aria-busy="true"]'))
  assert.equal(h.writes.length, 1)
  assert.deepEqual(h.writes[0], { method: 'POST', path: `${historyBase}/history_huasheng_legacy/check`, body: {} })
  h.state.failAction = true
  h.state.holdAction = false
  h.state.pending.splice(0).forEach(resolve => resolve())
  await dialog.getByRole('alert').filter({ hasText: '账号检查暂不可用' }).waitFor()
  await dialog.getByText('检查未完成', { exact: true }).waitFor()
  assert.equal(await dialog.getByText('已核验，可制作', { exact: true }).count(), 0)
  h.state.failAction = false
  await check.click()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '登录窗口', exact: true }).click()
  await h.page.waitForFunction(() => !document.querySelector('.account-actions button:disabled'))
  assert.deepEqual(h.writes.map(write => write.path), [`${historyBase}/history_huasheng_legacy/check`, `${historyBase}/history_huasheng_legacy/check`, `${historyBase}/history_huasheng_legacy/login`])
  assert.deepEqual(h.unexpected, [])
})

test('legacy production account entry opens the shared manager without browser writes', async t => {
  const h = await harness(t)
  const panel = h.page.getByRole('region', { name: '花生自动制作', exact: true })
  await panel.getByRole('button', { name: '制作设置', exact: true }).click()
  await panel.getByRole('button', { name: '花生账号', exact: true }).click()
  await h.page.getByRole('dialog', { name: '历史花生账号', exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('a completed identity check remains authoritative if the following account list refresh fails', async t => {
  const h = await harness(t)
  const dialog = await h.open()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  Object.assign(h.state.accounts[0], { status: 'error', identityStatus: 'mismatch', observedIdentity: { uid: 'another-uid', displayName: '另一个创作者' }, message: '当前登录身份与绑定账号不匹配' })
  h.state.failRead = true
  await dialog.getByRole('button', { name: '检查账号', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '账号列表暂不可用' }).waitFor()
  await dialog.getByText('登录账号不匹配', { exact: true }).waitFor()
  assert.equal(await dialog.getByText('已核验，可制作', { exact: true }).count(), 0)
  assert.equal(await dialog.getByText('history-uid', { exact: true }).count(), 1)
  assert.equal(await dialog.getByText('another-uid', { exact: true }).count(), 1)
  assert.equal(h.writes.length, 1)
})

test('science compatibility entry supports add and default actions in the science namespace', async t => {
  const h = await harness(t, 'science')
  const dialog = await h.open()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  await dialog.getByLabel('添加花生账号', { exact: true }).fill('第二个科普账号')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  const second = dialog.locator('.account-list li').filter({ hasText: '第二个科普账号' })
  await second.waitFor()
  await second.getByRole('button', { name: '设为默认', exact: true }).click()
  await second.locator('.default-badge').waitFor()
  await second.getByRole('button', { name: '登录窗口', exact: true }).click()
  await h.page.waitForFunction(() => !document.querySelector('.account-actions button:disabled'))
  await second.getByRole('button', { name: '检查账号', exact: true }).click()
  await h.page.waitForFunction(() => !document.querySelector('.account-actions button:disabled'))
  assert.deepEqual(h.writes, [
    { method: 'POST', path: scienceBase, body: { label: '第二个科普账号' } },
    ...['default', 'login', 'check'].map(action => ({ method: 'POST', path: `${scienceBase}/science_huasheng_second/${action}`, body: {} })),
  ])
  assert.equal(h.reads.includes(historyBase), false)
  await h.page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false)
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await h.page.screenshot({ path: '/tmp/huasheng-accounts-science-mobile.png', fullPage: true })
  assert.deepEqual(h.errors, [])
  assert.deepEqual(h.unexpected, [])
})

test('account loading can be retried and the dialog fits mobile with long identities', async t => {
  const h = await harness(t, 'history', { viewport: { width: 320, height: 740 }, account: { identity: { uid: 'history-uid'.repeat(9), displayName: '历史创作者'.repeat(9) } } })
  h.state.failRead = true
  const dialog = await h.open()
  await dialog.getByRole('alert').filter({ hasText: '账号列表暂不可用' }).waitFor()
  h.state.failRead = false
  await dialog.getByRole('button', { name: '刷新账号', exact: true }).click()
  await dialog.getByText('历史专用账号', { exact: true }).waitFor()
  const overflow = await dialog.evaluate(element => ({ dialog: element.scrollWidth > element.clientWidth, page: document.documentElement.scrollWidth > innerWidth, bounds: element.getBoundingClientRect().toJSON() }))
  assert.equal(overflow.dialog, false)
  assert.equal(overflow.page, false)
  assert.ok(overflow.bounds.x >= 0 && overflow.bounds.right <= 320)
  assert.equal(await dialog.getByRole('button', { name: '登录窗口', exact: true }).isVisible(), true)
  await h.page.screenshot({ path: '/tmp/huasheng-accounts-mobile.png', fullPage: true })
  await h.page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.errors, [])
})
