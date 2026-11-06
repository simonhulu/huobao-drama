import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const base = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const root = '/api/v1/huasheng-materials'
const stats = { projects: 24, clips: 1234, files: 2200, downloadedAssets: 2100 }
function task(overrides = {}) {
  return {
    id: 31, status: 'running', cancelRequested: false,
    createdAt: '2026-10-26T08:00:00.000Z', startedAt: '2026-10-26T08:00:01.000Z', completedAt: null,
    progressCurrent: 2, progressTotal: 24, progressMessage: '正在读取长征项目：分镜 03', errorMessage: null, result: null,
    ...overrides,
  }
}
const panel = page => page.getByRole('region', { name: '花生镜头素材', exact: true })
const status = page => panel(page).getByRole('status', { name: '素材库更新状态', exact: true })

async function harness(t, options = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 960 } })
  page.setDefaultTimeout(7000)
  if (options.clock) await page.clock.install()
  const state = {
    overview: { stats: { ...stats }, task: options.task ?? null },
    reads: 0, writes: [], unexpected: [], errors: [], failReads: options.failReads || false,
    loseStart: false, loseStop: false, failReconcile: false, holdNextRead: false, held: [], holdStart: false, pendingStart: null,
  }
  page.on('pageerror', error => state.errors.push(error.message))
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const send = data => route.fulfill({ json: { code: 200, data } })
    if (path === root && request.method() === 'GET') {
      state.reads++
      if (state.holdNextRead) {
        state.holdNextRead = false
        state.held.push({ route, overview: structuredClone(state.overview) })
        return
      }
      if (state.failReads) return route.fulfill({ status: 503, json: { code: 503, message: '素材库暂时不可用' } })
      return send(state.overview)
    }
    if (path === `${root}/updates` && request.method() === 'POST') {
      state.writes.push({ path, body: request.postDataJSON() })
      state.overview.task = task({ status: 'queued', startedAt: null, progressCurrent: 0, progressTotal: 0, progressMessage: '等待开始更新素材库' })
      if (state.loseStart) {
        if (state.failReconcile) state.failReads = true
        return route.abort('connectionreset')
      }
      if (state.holdStart) { state.pendingStart = route; return }
      return send({ ...state.overview, created: true })
    }
    if (path === `${root}/updates/31/stop` && request.method() === 'POST') {
      state.writes.push({ path, body: request.postDataJSON() })
      state.overview.task.cancelRequested = true
      if (state.loseStop) {
        if (state.failReconcile) state.failReads = true
        return route.abort('connectionreset')
      }
      return send(state.overview)
    }
    if (path === '/api/v1/history-scripts/huasheng/browser/open' && request.method() === 'POST') {
      state.writes.push({ path, body: request.postDataJSON() })
      return send({ opened: true })
    }
    if (request.method() !== 'GET') {
      state.unexpected.push(path)
      return route.fulfill({ status: 405, json: { code: 405, message: 'Unexpected write' } })
    }
    if (path === '/api/v1/tasks') return send([])
    if (path === '/api/v1/health/workers') return send({ healthy_count: 1, total_count: 1, workers: [] })
    return send({ items: [] })
  })
  await page.goto(`${base}/library`, { waitUntil: 'domcontentloaded' })
  await panel(page).getByRole('heading', { name: '花生镜头素材', exact: true }).waitFor()
  await status(page).getByText(options.failReads ? '状态待刷新' : options.task ? { running: '更新中', queued: '待开始', succeeded: '已完成', failed: '更新失败', canceled: '已中断', stale: '已中断' }[options.task.status] : '尚未更新', { exact: true }).waitFor()
  return { page, state }
}
async function poll(page, state) {
  const before = state.reads
  const response = page.waitForResponse(response => new URL(response.url()).pathname === root && response.request().method() === 'GET')
  await page.clock.runFor(2600)
  await response
  assert.ok(state.reads > before, 'the visible library must poll its durable task')
}
function assertClean(state) {
  assert.deepEqual(state.unexpected, [])
  assert.deepEqual(state.errors, [])
}

test('one global update reports project progress, completion and durable state after reload', async t => {
  const { page, state } = await harness(t, { clock: true })
  const ui = panel(page)
  assert.equal(await ui.locator('dd').allTextContents().then(values => values.join('|')), '24|1,234|2,100')
  assert.equal(await ui.getByRole('combobox').count(), 0)
  state.holdStart = true
  await ui.getByRole('button', { name: '更新素材库', exact: true }).click()
  await status(page).getByText('开始中', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '开始中', exact: true }).isDisabled(), true)
  await ui.getByRole('button', { name: '开始中', exact: true }).evaluate(button => button.click())
  assert.equal(state.writes.length, 1)
  await state.pendingStart.fulfill({ json: { code: 200, data: { ...state.overview, created: true } } })
  await status(page).getByText('待开始', { exact: true }).waitFor()
  state.overview.task = task()
  await poll(page, state)
  await status(page).getByText('2 / 24 个项目', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('progressbar', { name: '项目更新进度' }).getAttribute('aria-valuenow'), '2')
  await ui.getByText('正在读取长征项目：分镜 03', { exact: true }).waitFor()
  state.overview.task = task({ status: 'succeeded', progressCurrent: 24, completedAt: '2026-10-26T08:30:00.000Z', progressMessage: '素材库更新完成', result: { downloaded: 6, reused: 9, unavailableClips: 2, metadataWarnings: 1 } })
  await poll(page, state)
  await status(page).getByText('已完成', { exact: true }).waitFor()
  await ui.getByText('新增视频 6 · 复用视频 9 · 候选不足分镜 2 · 标注提醒 1', { exact: true }).waitFor()
  assert.equal(await ui.locator('time').count(), 2)
  assert.equal(await ui.getByRole('button', { name: '更新素材库', exact: true }).isEnabled(), true)
  assert.deepEqual(state.writes, [{ path: `${root}/updates`, body: {} }])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await status(page).getByText('已完成', { exact: true }).waitFor()
  assert.equal(await panel(page).locator('time').count(), 2)
  assertClean(state)
})

test('an existing global update cannot be started twice and can be interrupted', async t => {
  const { page, state } = await harness(t, { task: task(), clock: true })
  const ui = panel(page)
  assert.equal(await ui.getByRole('button', { name: '更新中', exact: true }).isDisabled(), true)
  await ui.getByRole('button', { name: '中断更新', exact: true }).click()
  await status(page).getByText('正在中断', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '正在中断', exact: true }).isDisabled(), true)
  state.overview.task = task({ status: 'canceled', cancelRequested: true, completedAt: '2026-10-26T08:05:00.000Z', progressMessage: '更新已中断' })
  await poll(page, state)
  await status(page).getByText('已中断', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '中断更新', exact: true }).count(), 0)
  assert.equal(await ui.getByRole('button', { name: '更新素材库', exact: true }).isEnabled(), true)
  assert.deepEqual(state.writes, [{ path: `${root}/updates/31/stop`, body: {} }])
  assertClean(state)
})

test('failed reads keep previous state visibly stale and prevent starting until refreshed', async t => {
  const { page, state } = await harness(t, { failReads: true, clock: true })
  const ui = panel(page)
  await ui.getByRole('alert').getByText('无法读取素材库状态：素材库暂时不可用', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '更新素材库', exact: true }).isDisabled(), true)
  state.failReads = false
  state.overview.task = task({ status: 'succeeded', completedAt: '2026-10-26T08:30:00.000Z' })
  await ui.getByRole('button', { name: '刷新镜头素材状态', exact: true }).click()
  await status(page).getByText('已完成', { exact: true }).waitFor()
  state.failReads = true
  await poll(page, state)
  await status(page).getByText('状态待刷新', { exact: true }).waitFor()
  await status(page).getByText('上次状态：已完成', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '更新素材库', exact: true }).isDisabled(), true)
  assert.deepEqual(state.writes, [])
  assertClean(state)
})

for (const command of ['start', 'stop']) {
  test(`lost ${command} response reconciles with GET and never automatically repeats POST`, async t => {
    const { page, state } = await harness(t, { task: command === 'stop' ? task() : null, clock: true })
    const ui = panel(page)
    state[command === 'start' ? 'loseStart' : 'loseStop'] = true
    state.failReconcile = true
    await ui.getByRole('button', { name: command === 'start' ? '更新素材库' : '中断更新', exact: true }).click()
    await ui.getByRole('alert').filter({ hasText: '请求结果待确认' }).waitFor()
    await status(page).getByText('状态待刷新', { exact: true }).waitFor()
    await poll(page, state)
    assert.equal(state.writes.length, 1)
    assert.equal(await ui.getByRole('alert').filter({ hasText: '请求结果待确认' }).count(), 1)
    state.failReads = false
    await ui.getByRole('button', { name: '刷新镜头素材状态', exact: true }).click()
    await status(page).getByText(command === 'start' ? '待开始' : '正在中断', { exact: true }).waitFor()
    assert.equal(await ui.getByRole('alert').count(), 0)
    assert.equal(state.writes.length, 1)
    assertClean(state)
  })
}

test('a stale GET cannot replace the newer start response', async t => {
  const { page, state } = await harness(t, { clock: true })
  const ui = panel(page)
  state.holdNextRead = true
  await ui.getByRole('button', { name: '刷新镜头素材状态', exact: true }).click()
  await ui.getByRole('button', { name: '更新素材库', exact: true }).click()
  await status(page).getByText('待开始', { exact: true }).waitFor()
  assert.equal(state.held.length, 1)
  const held = state.held[0]
  await held.route.fulfill({ json: { code: 200, data: held.overview } })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await status(page).getByText('待开始', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '更新中', exact: true }).isDisabled(), true)
  assert.equal(state.writes.length, 1)
  assertClean(state)
})

test('failed and recovered interrupted tasks remain actionable with explicit times and errors', async t => {
  const { page, state } = await harness(t, { task: task({ status: 'failed', completedAt: '2026-10-26T08:05:00.000Z', errorMessage: '花生登录已失效，请重新登录。' }), clock: true })
  const ui = panel(page)
  await ui.getByText('花生登录已失效，请重新登录。', { exact: true }).waitFor()
  assert.equal(state.writes.length, 0, 'login recovery must never open automatically')
  await ui.getByRole('button', { name: '打开花生浏览器', exact: true }).click()
  await ui.getByRole('button', { name: '打开花生浏览器', exact: true }).waitFor()
  assert.deepEqual(state.writes, [{ path: '/api/v1/history-scripts/huasheng/browser/open', body: {} }])
  state.overview.task = task({ status: 'stale', completedAt: '2026-10-26T08:05:00.000Z', errorMessage: '服务重启，任务已中断。' })
  await poll(page, state)
  await status(page).getByText('已中断', { exact: true }).waitFor()
  assert.equal(await ui.getByRole('button', { name: '更新素材库', exact: true }).isEnabled(), true)
  assert.equal(await ui.locator('time').count(), 2)
  assertClean(state)
})

test('desktop and mobile update controls and long messages stay within the material section', async t => {
  const { page, state } = await harness(t, { task: task({ progressMessage: `正在读取项目 ${'1934年红军在瑞金街头行进'.repeat(12)}` }) })
  const directory = join(tmpdir(), 'huasheng-material-update-ui')
  await mkdir(directory, { recursive: true })
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport)
    await panel(page).screenshot({ path: join(directory, `material-update-${viewport.width}.png`) })
    const bounds = await panel(page).evaluate(section => {
      const rect = section.getBoundingClientRect()
      return { left: rect.left, right: rect.right, overflow: section.scrollWidth > section.clientWidth + 1, controlsFit: Array.from(section.querySelectorAll('button')).every(button => { const box = button.getBoundingClientRect(); return box.left >= rect.left - 1 && box.right <= rect.right + 1 && button.scrollWidth <= button.clientWidth + 1 }) }
    })
    assert.ok(bounds.left >= 0 && bounds.right <= viewport.width, `section exceeds viewport at ${viewport.width}px`)
    assert.equal(bounds.overflow, false, `section overflows at ${viewport.width}px`)
    assert.equal(bounds.controlsFit, true, `a control overflows at ${viewport.width}px`)
  }
  assertClean(state)
})
