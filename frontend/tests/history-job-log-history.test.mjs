import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const timestamp = '2026-10-15T03:04:05.000Z'
const event = id => ({ id, createdAt: timestamp, stage: 'selecting', level: 'info', message: `审核候选视频 ${id}` })
const job = (id, overrides = {}) => ({ id: String(id), status: 'failed', stage: 'failed', startedAt: timestamp,
  updatedAt: timestamp, completedAt: timestamp, progressAt: timestamp, targetCount: null,
  counts: { scanned: 17, selected: 0, completed: 0, failed: 1 }, events: [], sourceIds: [],
  errorMessage: '浏览抖音失败：Unknown owned task page', ...overrides })

async function setup({ mobile = false, eventCount = 205 } = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 } })
  page.setDefaultTimeout(8000)
  await page.clock.install()
  let current = job(39600, { status: 'running', stage: 'selecting', errorMessage: null, completedAt: null })
  let events = Array.from({ length: eventCount }, (_, index) => event(index + 1))
  const history = Array.from({ length: 23 }, (_, index) => job(39599 - index))
  history[0] = job(39599, { status: 'completed', stage: 'completed', errorMessage: null, counts: { scanned: 42, selected: 1, completed: 1, failed: 0 } })
  const historyEvents = [{ ...event(1), candidate: { outcome: 'skipped', videoId: '456', title: '周末出游攻略', screeningStage: 'search', likeCount: 0, reason: '标题为旅游攻略' } },
    { ...event(2), message: '候选未入选：只有地名清单，没有可讲述的历史问题', browserUrl: 'https://www.douyin.com/video/123',
    counts: { scanned: 17, selected: 0, completed: 0, failed: 0 },
    candidate: { outcome: 'skipped', videoId: '123', title: '紫江县、双流、白马洞', screeningStage: 'detail', likeCount: 28000, reason: '只有地名与参考书目', titleEvidence: '地名清单', curiosityAngle: '未见具体问题', durationSeconds: 603, commentCount: 19, comments: [{ text: '能讲一段具体的故事吗？', likes: 8 }] } },
    { ...event(3), level: 'error', message: '浏览抖音失败：Unknown owned task page', browserUrl: 'javascript:alert(1)' }]
  let failEvents = false
  let failHistory = false
  let stoppedId = null
  const calls = []
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    calls.push(path + url.search)
    if (path === '/api/v1/history-scripts/jobs') {
      const all = [current, ...history]
      const before = Number(url.searchParams.get('beforeId')) || Infinity
      const filtered = all.filter(item => Number(item.id) < before)
      const recent = filtered.slice(0, 20).map(item => ({ ...item, events: [] }))
      return route.fulfill({ json: { code: 200, data: { job: { ...current, events: events.slice(-100) }, recent, total: all.length, hasMore: filtered.length > 20, nextCursor: filtered.length > 20 ? recent.at(-1).id : null } } })
    }
    const match = /^\/api\/v1\/history-scripts\/jobs\/(\d+)(?:\/(events|stop))?$/.exec(path)
    if (match) {
      const id = match[1]
      if (match[2] === 'stop') {
        stoppedId = id
        current = { ...current, status: 'stopping' }
        return route.fulfill({ json: { code: 200, data: { job: current } } })
      }
      if (match[2] === 'events') {
        if (failEvents) return route.fulfill({ status: 503, json: { code: 503, message: '日志读取暂时失败' } })
        const all = id === current.id ? events : historyEvents
        const before = Number(url.searchParams.get('beforeId')) || Infinity
        const filtered = all.filter(item => item.id < before)
        const items = filtered.slice(-100)
        return route.fulfill({ json: { code: 200, data: { items, total: all.length, hasMore: filtered.length > 100, nextCursor: filtered.length > 100 ? items[0].id : null } } })
      }
      if (id !== current.id && failHistory) return route.fulfill({ status: 503, json: { code: 503, message: '历史任务读取暂时失败' } })
      const found = id === current.id ? { ...current, events: events.slice(-100) } : { ...history.find(item => item.id === id), events: historyEvents }
      return route.fulfill({ json: { code: 200, data: { job: found } } })
    }
    if (path === '/api/v1/history-scripts/browser-session') return route.fulfill({ json: { code: 200, data: { session: { status: 'ready', canCollect: true, checkedAt: timestamp, checks: [] } } } })
    if (path === '/api/v1/history-scripts') return route.fulfill({ json: { code: 200, data: { items: [], total: 0 } } })
    return route.fulfill({ status: 404, json: { code: 404, message: 'unexpected API request' } })
  })
  await page.goto(`${baseUrl}/history-scripts`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '采集监控', exact: true }).click()
  const monitor = page.getByRole('dialog', { name: '采集监控', exact: true })
  await monitor.getByRole('tab', { name: '任务日志', exact: true }).click()
  return { browser, page, monitor, calls, append: (count = 1) => { events = [...events, ...Array.from({ length: count }, (_, index) => event(events.length + index + 1))] }, stoppedId: () => stoppedId,
    appendJobs: count => {
      for (let index = 0; index < count; index += 1) {
        history.unshift({ ...current, status: 'completed', stage: 'completed' })
        current = job(Number(current.id) + 1, { status: 'running', stage: 'selecting', errorMessage: null })
      }
    },
    failEvents: value => { failEvents = value }, failHistory: value => { failHistory = value } }
}

test('historical jobs are selectable with full evidence and stay selected during current-job polling', async () => {
  const h = await setup()
  try {
    const { page, monitor } = h
    const select = monitor.getByRole('combobox', { name: '查看采集任务' })
    await select.selectOption('39598')
    await monitor.getByText('浏览抖音失败：Unknown owned task page', { exact: true }).first().waitFor()
    await monitor.getByText('扫描 17', { exact: true }).waitFor()
    await monitor.getByText('详情核验 · 未入选 · 紫江县、双流、白马洞', { exact: true }).click()
    await monitor.getByText('只有地名与参考书目', { exact: true }).waitFor()
    await monitor.locator('dt', { hasText: '点赞数' }).locator('+ dd').getByText('28000', { exact: true }).waitFor()
    await monitor.locator('dt', { hasText: '评论总数' }).locator('+ dd').getByText('19', { exact: true }).waitFor()
    await monitor.getByText('能讲一段具体的故事吗？', { exact: true }).waitFor()
    await monitor.getByText('搜索页初筛 · 未入选 · 周末出游攻略', { exact: true }).click()
    const searchEvidence = monitor.locator('.event-candidate').filter({ hasText: '周末出游攻略' })
    await searchEvidence.getByText('搜索页初筛尚未读取评论', { exact: true }).waitFor()
    assert.equal(await searchEvidence.getByText('评论总数', { exact: true }).count(), 0)
    assert.equal(await searchEvidence.locator('dt', { hasText: '点赞数' }).locator('+ dd').innerText(), '0')
    assert.equal(await monitor.locator('a[href="javascript:alert(1)"]').count(), 0)
    assert.equal(await monitor.getByRole('link', { name: '打开来源页面' }).getAttribute('href'), 'https://www.douyin.com/video/123')
    assert.match(await monitor.locator('.job-events time').first().innerText(), /2026.*10.*15/)
    await page.clock.fastForward(8500)
    assert.equal(await select.inputValue(), '39598')
    await monitor.getByRole('button', { name: '加载更早任务' }).click()
    await select.selectOption('39577')
    assert.equal(await select.inputValue(), '39577')
    await monitor.getByRole('button', { name: '关闭采集监控', exact: true }).click()
    await page.locator('.page-head').getByRole('button', { name: '停止采集', exact: true }).click()
    assert.equal(h.stoppedId(), '39600', 'viewing old jobs must never change the current stop target')
  } finally { await h.browser.close() }
})

test('older logs survive polling, deduplicate and allow explicit filtering of loaded history', async () => {
  const h = await setup()
  try {
    const { page, monitor } = h
    await monitor.getByText('已加载 100 / 205 条', { exact: false }).waitFor()
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByText('已加载 200 / 205 条', { exact: false }).waitFor()
    h.failEvents(true)
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByRole('alert').getByText('日志读取暂时失败', { exact: true }).waitFor()
    h.failEvents(false)
    await monitor.getByRole('button', { name: '重试日志' }).click()
    await monitor.getByText('已加载 205 / 205 条', { exact: false }).waitFor()
    h.append()
    await page.clock.fastForward(4500)
    await monitor.getByText('审核候选视频 206', { exact: true }).waitFor()
    assert.equal(await monitor.locator('.job-events > li').count(), 206)
    assert.equal(await monitor.getByText('审核候选视频 1', { exact: true }).count(), 1)
    await monitor.getByRole('searchbox', { name: '搜索已加载日志' }).fill('视频 206')
    assert.equal(await monitor.locator('.job-events > li').count(), 1)
    await monitor.getByText('仅筛选已加载日志', { exact: false }).waitFor()
  } finally { await h.browser.close() }
})

test('reconnecting after more than one page of new events keeps the missing middle reachable', async () => {
  const h = await setup()
  try {
    const { page, monitor } = h
    await monitor.getByText('已加载 100 / 205 条', { exact: false }).waitFor()
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByText('已加载 200 / 205 条', { exact: false }).waitFor()
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByText('已加载 205 / 205 条', { exact: false }).waitFor()
    h.append(250)
    await page.clock.fastForward(4500)
    await monitor.getByText('审核候选视频 455', { exact: true }).waitFor()
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByText('审核候选视频 256', { exact: true }).waitFor()
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByText('已加载 455 / 455 条', { exact: false }).waitFor()
    assert.equal(await monitor.locator('.job-events > li').count(), 455)
    assert.equal(await monitor.getByText('审核候选视频 206', { exact: true }).count(), 1)
    assert.equal(await monitor.getByRole('button', { name: '加载更早日志' }).count(), 0)
  } finally { await h.browser.close() }
})

test('an initially empty log can page through the first large batch of events', async () => {
  const h = await setup({ eventCount: 0 })
  try {
    const { page, monitor } = h
    await monitor.getByText('已加载 0 / 0 条', { exact: false }).waitFor()
    h.append(150)
    await page.clock.fastForward(4500)
    await monitor.getByText('已加载 100 / 150 条', { exact: false }).waitFor()
    await monitor.getByRole('button', { name: '加载更早日志' }).click()
    await monitor.getByText('已加载 150 / 150 条', { exact: false }).waitFor()
    assert.equal(await monitor.getByText('审核候选视频 1', { exact: true }).count(), 1)
  } finally { await h.browser.close() }
})

test('a later latest-task page preserves old choices and makes intervening tasks reachable', async () => {
  const h = await setup()
  try {
    const { monitor } = h
    const select = monitor.getByRole('combobox', { name: '查看采集任务' })
    await monitor.getByRole('button', { name: '加载更早任务' }).click()
    await monitor.getByText('已加载 24 / 24 个任务', { exact: true }).waitFor()
    await select.selectOption('39598')
    h.appendJobs(25)
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await monitor.getByText('已加载 44 / 49 个任务', { exact: true }).waitFor()
    assert.equal(await select.inputValue(), '39598')
    await monitor.getByRole('button', { name: '加载更早任务' }).click()
    await monitor.getByText('已加载 49 / 49 个任务', { exact: true }).waitFor()
    await select.selectOption('39601')
    assert.equal(await select.inputValue(), '39601')
    assert.equal(await select.locator('option').count(), 50)
  } finally { await h.browser.close() }
})

test('history and log failures are retryable without invalidating current task controls', async () => {
  const h = await setup()
  try {
    const { page, monitor } = h
    h.failHistory(true)
    await monitor.getByRole('combobox', { name: '查看采集任务' }).selectOption('39598')
    await monitor.getByRole('alert').getByText('历史任务读取暂时失败', { exact: true }).waitFor()
    h.failHistory(false)
    await monitor.getByRole('button', { name: '重试日志' }).click()
    await monitor.getByText('详情核验 · 未入选 · 紫江县、双流、白马洞', { exact: true }).waitFor()
    h.failEvents(true)
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await monitor.getByRole('alert').getByText('日志读取暂时失败', { exact: true }).waitFor()
    assert.equal(await monitor.getByText('详情核验 · 未入选 · 紫江县、双流、白马洞', { exact: true }).count(), 1)
    h.failEvents(false)
    await monitor.getByRole('button', { name: '重试日志' }).click()
    await monitor.getByRole('button', { name: '关闭采集监控', exact: true }).click()
    assert.equal(await page.locator('.page-head').getByRole('button', { name: '停止采集', exact: true }).isEnabled(), true)
    assert.equal(await page.getByText('采集状态无法更新', { exact: true }).count(), 0)
  } finally { await h.browser.close() }
})

test('mobile history controls stay within the drawer and keyboard focus includes selects', async () => {
  const h = await setup({ mobile: true })
  try {
    const { page, monitor } = h
    const taskSelect = monitor.getByRole('combobox', { name: '查看采集任务' })
    await taskSelect.selectOption('39598')
    await monitor.getByText('详情核验 · 未入选 · 紫江县、双流、白马洞', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const level = monitor.getByRole('combobox', { name: '日志级别' })
    await level.selectOption('warning')
    await level.focus()
    await page.keyboard.press('Tab')
    assert.equal(await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await level.evaluate(el => el === document.activeElement), true)
  } finally { await h.browser.close() }
})
