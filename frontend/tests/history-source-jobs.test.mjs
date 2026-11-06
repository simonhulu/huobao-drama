import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'

const categoryValues = [
  'regional_history',
  'unofficial_history',
  'historical_anecdote',
  'historical_commentary',
  'history_trivia',
]

function fixture(id, overrides = {}) {
  return {
    id,
    title: `历史素材 ${id}`,
    authorName: '史料号',
    category: 'regional_history',
    status: 'needs_review',
    sourceUrl: `https://www.douyin.com/video/${id}`,
    rawTranscript: '原始转写',
    correctedTranscript: '校对稿',
    rewrittenScript: `改写稿 ${id}`,
    revision: String(id).padStart(64, '0'),
    updatedAt: '2026-10-14T07:00:00.000Z',
    metricsJson: '{"comments":98,"likes":1200}',
    mediaJson: '{"probe":{"duration":612}}',
    selectionJson: '{}',
    reviewJson: '{}',
    videoAvailable: true,
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
    ...overrides,
  }
}

function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    status: 'running',
    stage: 'browsing',
    progressMessage: '正在浏览抖音历史内容',
    targetCount: 1,
    counts: { scanned: 4, selected: 1, completed: 0, failed: 0 },
    currentSourceId: 101,
    currentTitle: '武当山桃木剑',
    sourceIds: [101],
    startedAt: '2026-10-14T07:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-10-14T07:00:05.000Z',
    errorMessage: null,
    config: { targetCount: 1, categories: categoryValues },
    events: [{ id: 1, createdAt: '2026-10-14T07:00:05.000Z', message: '正在浏览抖音历史内容', stage: 'browsing', level: 'info' }],
    browserUrl: 'https://www.douyin.com/',
    workerHealth: 'alive',
    heartbeatAt: '2026-10-15T01:00:00.000Z',
    leaseExpiresAt: '2026-10-15T01:01:00.000Z',
    progressAt: '2026-10-14T07:00:05.000Z',
    ...overrides,
  }
}

function makeBrowserSession(overrides = {}) {
  return {
    status: 'ready',
    message: 'Chromium 搜索检测通过',
    updatedAt: '2026-10-15T01:00:00.000Z',
    checkedAt: '2026-10-15T01:00:00.000Z',
    canCollect: true,
    checks: [{ at: '2026-10-15T01:00:00.000Z', stage: 'search', message: '搜索结果和视频卡片检测通过' }],
    ...overrides,
  }
}

async function harness(options = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 960 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  if (process.env.HISTORY_UI_DEBUG) {
    page.on('console', message => console.log(`[browser ${message.type()}] ${message.text()}`))
    page.on('pageerror', error => console.log(`[browser error] ${error.message}`))
  }
  page.setDefaultTimeout(6000)
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  if (options.clock) await page.clock.install()

  const sources = [fixture(101, options.sourceOverrides)]
  let job = options.initialJob ?? null
  let failJobs = Boolean(options.failJobs)
  let failBatchOutcomes = Boolean(options.failBatchOutcomes)
  let startBody = null
  let startCount = 0
  const resumeIds = []
  const youtubeSessionIds = []
  let failYoutubeSession = Boolean(options.failYoutubeSession)
  let stopCount = 0
  let listCount = 0
  let getJobCount = 0
  let browserSession = options.initialBrowserSession ?? makeBrowserSession()
  let failBrowserSession = Boolean(options.failBrowserSession)
  let failBrowserOpen = false
  let failBrowserCheck = false
  let browserOpenCount = 0
  let browserCheckCount = 0
  let browserOpenBody = null
  let browserCheckBody = null
  let browserSessionReadCount = 0
  let delayNextBrowserSession = false
  const delayedBrowserCheckRoutes = []
  let delayedBrowserSessionUsed = false
  const delayedBrowserSessionRoutes = []
  const delayedStopRoutes = []
  let delayedGetJobUsed = false
  const delayedGetJobRoutes = []
  let releaseKeywords
  const keywordsReady = new Promise(resolve => { releaseKeywords = resolve })
  let keywords = ['历史']
  let youtubeChannels = [...(options.youtubeChannels || ['https://www.youtube.com/@助眠睡前歷史故事/videos'])]
  let failSettingsRead = Boolean(options.failSettingsRead)
  let failSettingsSave = Boolean(options.failSettingsSave)
  const settingsWrites = []
  let czgtsConfigured = Boolean(options.czgtsConfigured)
  let cookieSaveCount = 0

  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const pathname = url.pathname

    if (pathname === '/api/v1/history-scripts/czgts/settings') {
      if (method === 'PUT') {
        assert.equal(request.postDataJSON().cookie, 'sessionid=test-only-cookie')
        cookieSaveCount++
        czgtsConfigured = true
      }
      return route.fulfill({ json: { code: 200, data: { configured: czgtsConfigured, updatedAt: null } } })
    }
    if (pathname === '/api/v1/history-scripts/czgts/check') {
      return route.fulfill({ json: { code: 200, data: { configured: true, total: 287, message: '接口检测成功，找到 287 篇文章。' } } })
    }

    if (pathname === '/api/v1/history-scripts/collection-settings') {
      if (method === 'GET' && failSettingsRead) return route.fulfill({ status: 503, json: { code: 503, message: '频道配置暂不可用' } })
      if (method === 'PUT') {
        const body = request.postDataJSON()
        settingsWrites.push(body)
        if (failSettingsSave) return route.fulfill({ status: 503, json: { code: 503, message: '保存频道失败，请重试' } })
        if (body.keywords) keywords = body.keywords
        if (body.youtubeChannels) youtubeChannels = body.youtubeChannels
      }
      if (method === 'GET' && options.delayKeywords) await keywordsReady
      return route.fulfill({ json: { code: 200, data: { keywords, youtubeChannels } } })
    }
    if (pathname === '/api/v1/history-scripts/huasheng') return route.fulfill({ json: { code: 200, data: { enabled: false, browser: { status: 'ready', message: '测试连接已就绪' }, productionChecking: false, jobs: [] } } })
    if (pathname === '/api/v1/history-scripts/huasheng/exports') return route.fulfill({ json: { code: 200, data: { enabled: false, jobs: [] } } })
    if (/^\/api\/v1\/history-scripts\/\d+\/article$/.test(pathname)) return route.fulfill({ json: { code: 200, data: { status: 'idle', article: null, canGenerate: false, unavailableReason: '请先关联成片', stale: false, staleReasons: [] } } })

    if (pathname === '/api/v1/history-scripts/browser-session' && method === 'GET') {
      browserSessionReadCount += 1
      if (failBrowserSession) return route.fulfill({ status: 404, json: { code: 404, message: '登录服务未连接' } })
      if ((options.delayFirstBrowserSession && !delayedBrowserSessionUsed) || delayNextBrowserSession) {
        delayedBrowserSessionUsed = true
        delayNextBrowserSession = false
        const session = structuredClone(browserSession)
        await new Promise(resolve => delayedBrowserSessionRoutes.push(() => {
          route.fulfill({ json: { code: 200, data: { session } } }).then(resolve)
        }))
        return
      }
      return route.fulfill({ json: { code: 200, data: { session: browserSession } } })
    }
    if (pathname === '/api/v1/history-scripts/browser-session/open' && method === 'POST') {
      browserOpenCount += 1
      browserOpenBody = request.postDataJSON()
      if (failBrowserOpen) return route.fulfill({ status: 503, json: { code: 503, message: '登录窗口暂时无法打开' } })
      browserSession = makeBrowserSession({ status: 'waiting_login', canCollect: false, checkedAt: null, checks: [], message: '等待你在专用窗口登录抖音' })
      return route.fulfill({ json: { code: 200, data: { session: browserSession } } })
    }
    if (pathname === '/api/v1/history-scripts/browser-session/check' && method === 'POST') {
      browserCheckCount += 1
      browserCheckBody = request.postDataJSON()
      if (failBrowserCheck) return route.fulfill({ status: 503, json: { code: 503, message: '登录检测服务暂时不可用' } })
      const finishCheck = () => {
        browserSession = options.browserCheckResponse || makeBrowserSession({ checkedAt: '2026-10-15T01:01:00.000Z' })
        if (browserSession.canCollect && job?.status === 'running' && job.stage === 'waiting_login') {
          job = makeJob({ ...job, stage: 'browsing', progressMessage: '抖音搜索检测通过，继续采集' })
        }
        return route.fulfill({ json: { code: 200, data: { session: browserSession } } })
      }
      if (options.delayBrowserCheck) {
        browserSession = makeBrowserSession({ status: 'checking', canCollect: false, checkedAt: null, checks: [], message: '正在检测抖音搜索' })
        await new Promise(resolve => delayedBrowserCheckRoutes.push(() => finishCheck().then(resolve)))
        return
      }
      return finishCheck()
    }

    if (/^\/api\/v1\/history-scripts\/jobs\/[^/]+\/outcomes$/.test(pathname)) {
      if (failBatchOutcomes) return route.fulfill({ status:503,json:{code:503,message:'批次结果暂不可用'} })
      return route.fulfill({json:{code:200,data:options.batchOutcomes || {total:0,offset:0,limit:50,hasMore:false,items:[],
        summary:{draftsReady:0,producedVideos:0,expectedVideos:0,publishedVideos:0,recoveredSources:0,releasedVideos:0}}}})
    }
    if (pathname === '/api/v1/history-scripts/jobs') {
      if (failJobs) return route.fulfill({ status: 503, json: { code: 503, message: '任务服务暂不可用' } })
      if (method === 'GET') return route.fulfill({ json: { code: 200, data: { job, recent: [...(job ? [job] : []), ...(options.recentJobs || [])] } } })
      if (method === 'POST') {
        startCount += 1
        startBody = request.postDataJSON()
        if (startCount <= (options.startFailures || 0)) return route.fulfill({ status: 503, json: { code: 503, message: '采集执行器未运行，请恢复服务后重试' } })
        job = makeJob({ targetCount: startBody.targetCount, config: startBody })
        return route.fulfill({ json: { code: 200, data: { job, created: true } } })
      }
    }

    const recoveryMatch = /^\/api\/v1\/history-scripts\/jobs\/([^/]+)\/(resume|youtube-session)$/.exec(pathname)
    if (recoveryMatch && method === 'POST') {
      assert.deepEqual(request.postDataJSON(), {})
      if (recoveryMatch[2] === 'youtube-session') {
        youtubeSessionIds.push(recoveryMatch[1])
        return failYoutubeSession
          ? route.fulfill({ status: 503, json: { code: 503, message: 'YouTube 仍要求登录验证，请在 Chrome 中完成验证后再次刷新。' } })
          : route.fulfill({ json: { code: 200, data: { message: 'YouTube 登录刷新并验证通过，可继续采集。' } } })
      }
      resumeIds.push(recoveryMatch[1])
      if (resumeIds.length <= (options.resumeFailures || 0)) return route.fulfill({ status: 409, json: { code: 409, message: '当前采集任务仍在停止，请稍后继续。' } })
      const previous = String(job?.id) === recoveryMatch[1] ? job : options.recentJobs?.find(item => String(item.id) === recoveryMatch[1])
      job = makeJob({ ...previous, id: recoveryMatch[1], status: 'queued', stage: 'queued', errorCode: null, errorMessage: null, progressMessage: '已恢复原采集任务，继续未完成来源' })
      return route.fulfill({ json: { code: 200, data: { job } } })
    }
    const jobMatch = /^\/api\/v1\/history-scripts\/jobs\/([^/]+)(?:\/stop)?$/.exec(pathname)
    if (/^\/api\/v1\/history-scripts\/jobs\/[^/]+\/events$/.test(pathname)) {
      if (failJobs) return route.fulfill({ status: 503, json: { code: 503, message: '任务服务暂不可用' } })
      const events = job?.events || []
      const before = Number(url.searchParams.get('beforeId')) || Infinity
      const filtered = events.filter(event => event.id < before)
      const items = filtered.slice(-100)
      return route.fulfill({ json: { code: 200, data: { items, total: events.length, hasMore: filtered.length > 100, nextCursor: filtered.length > 100 ? items[0].id : null } } })
    }
    if (jobMatch) {
      if (failJobs) return route.fulfill({ status: 503, json: { code: 503, message: '任务服务暂不可用' } })
      if (pathname.endsWith('/stop') && method === 'POST') {
        stopCount += 1
        const failed = stopCount <= (options.stopFailures || 0)
        if (!failed) job = makeJob({ ...job, id: jobMatch[1], status: options.stopStatus || 'stopping', stage: 'stopped', progressMessage: '正在停止采集任务' })
        const finishStop = () => failed
          ? route.fulfill({ status: 503, json: { code: 503, message: '停止服务暂时不可用，请重试' } })
          : route.fulfill({ json: { code: 200, data: { job } } })
        if (options.delayStop) {
          await new Promise(resolve => delayedStopRoutes.push(() => finishStop().then(resolve)))
          return
        }
        return finishStop()
      }
      if (method === 'GET') {
        getJobCount += 1
        if (options.delayFirstGetJob && !delayedGetJobUsed) {
          delayedGetJobUsed = true
          await new Promise(resolve => delayedGetJobRoutes.push(() => {
            route.fulfill({ json: { code: 200, data: { job } } }).then(resolve)
          }))
          return
        }
        const requestedJob = jobMatch[1] === job?.id ? job : options.recentJobs?.find(item => String(item.id) === jobMatch[1])
        return route.fulfill({ json: { code: 200, data: { job: requestedJob || job } } })
      }
    }

    if (/^\/api\/v1\/history-scripts\/\d+\/video$/.test(pathname)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'video/mp4' }, body: '' })
    }

    const sourceMatch = /^\/api\/v1\/history-scripts(?:\/(\d+))?$/.exec(pathname)
    if (sourceMatch && method === 'GET') {
      if (sourceMatch[1]) {
        return route.fulfill({ json: { code: 200, data: sources.find(item => item.id === Number(sourceMatch[1])) } })
      }
      listCount += 1
      return route.fulfill({ json: { code: 200, data: { items: sources, total: sources.length } } })
    }

    if (sourceMatch && method === 'PATCH') {
      const body = request.postDataJSON()
      const source = sources.find(item => item.id === Number(sourceMatch[1]))
      source.rewrittenScript = body.rewrittenScript
      source.revision = `${Number(source.revision) + 1}`.padStart(64, '0')
      return route.fulfill({ json: { code: 200, data: source } })
    }

    return route.fulfill({ status: 404, json: { code: 404, message: `unmatched ${method} ${pathname}` } })
  })

  try {
    await page.goto(`${baseUrl}${options.path || '/history-scripts?view=library'}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator('#rewritten-script').waitFor({ state: 'attached' })
  } catch (error) {
    await browser.close()
    throw error
  }

  return {
    browser,
    page,
    pageErrors,
    sources,
    getJob: () => job,
    setJob: nextJob => { job = nextJob },
    setJobsFailure: value => { failJobs = value },
    setBatchOutcomesFailure: value => { failBatchOutcomes = value },
    startBody: () => startBody,
    startCount: () => startCount,
    resumeIds,
    youtubeSessionIds,
    setYoutubeSessionFailure: value => { failYoutubeSession = value },
    releaseDelayedKeywords: () => releaseKeywords(),
    settingsWrites,
    collectionSettings: () => ({ keywords, youtubeChannels }),
    setSettingsReadFailure: value => { failSettingsRead = value },
    setSettingsSaveFailure: value => { failSettingsSave = value },
    cookieSaveCount: () => cookieSaveCount,
    stopCount: () => stopCount,
    listCount: () => listCount,
    getJobCount: () => getJobCount,
    getBrowserSession: () => browserSession,
    setBrowserSession: value => { browserSession = value },
    setBrowserSessionFailure: value => { failBrowserSession = value },
    setBrowserOpenFailure: value => { failBrowserOpen = value },
    setBrowserCheckFailure: value => { failBrowserCheck = value },
    browserOpenCount: () => browserOpenCount,
    browserCheckCount: () => browserCheckCount,
    browserSessionReadCount: () => browserSessionReadCount,
    browserOpenBody: () => browserOpenBody,
    browserCheckBody: () => browserCheckBody,
    releaseDelayedBrowserCheck: () => delayedBrowserCheckRoutes.shift()?.(),
    releaseDelayedBrowserSession: () => delayedBrowserSessionRoutes.shift()?.(),
    delayNextBrowserSession: () => { delayNextBrowserSession = true },
    delayedBrowserSessionCount: () => delayedBrowserSessionRoutes.length,
    releaseDelayedStop: () => delayedStopRoutes.shift()?.(),
    delayedGetJobCount: () => delayedGetJobRoutes.length,
    releaseDelayedGetJob: () => delayedGetJobRoutes.shift()?.(),
  }
}

async function openMonitor(page, tab = '连接检测') {
  const drawer = page.getByRole('dialog', { name: '采集监控', exact: true })
  if (!await drawer.isVisible()) await page.getByRole('button', { name: '采集监控', exact: true }).click()
  await drawer.getByRole('tab', { name: tab, exact: true }).click()
  return drawer
}

async function closeMonitor(page) {
  await page.getByRole('dialog', { name: '采集监控', exact: true }).getByRole('button', { name: '关闭采集监控', exact: true }).click()
}

async function sourceVideoFromManuscript(page) {
  await page.getByRole('tab', { name: /^来源与审阅/ }).click()
  await page.locator('video.source-video').waitFor()
  const video = await page.locator('video.source-video').elementHandle()
  await page.getByRole('tab', { name: '文稿', exact: true }).click()
  return video
}

async function assertControlReachable(page, control) {
  await control.click({ trial: true })
  const box = await control.boundingBox()
  const viewport = page.viewportSize()
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
    `control must fit the viewport: ${JSON.stringify(box)}`)
  assert.equal(await control.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1), true)
}

for (const status of ['running', 'queued']) {
  test(`production view exposes a visible stop collection action for a ${status} job`, async () => {
    const h = await harness({ path: '/history-scripts', initialJob: makeJob({ status }) })
    try {
      const { page } = h
      await page.getByRole('tab', { name: '视频制作', exact: true }).waitFor()
      assert.equal(await page.getByRole('region', { name: '历史素材采集任务' }).isVisible(), false)
      const stop = page.locator('.page-head').getByRole('button', { name: '停止采集', exact: true })
      await stop.click({ trial: true })
      assert.equal(await page.getByRole('button', { name: '启动采集', exact: true }).isVisible(), false)
      await stop.click()
      await page.locator('.page-head').getByRole('button', { name: '正在停止采集', exact: true }).waitFor()
      assert.equal(h.stopCount(), 1)
      assert.equal(h.startCount(), 0)
    } finally { await h.browser.close() }
  })

  test(`monitoring drawer can stop the current ${status} job while the production header is inert`, async () => {
    const h = await harness({ path: '/history-scripts', initialJob: makeJob({ status }), delayStop: true })
    try {
      const { page } = h
      const monitor = await openMonitor(page)
      assert.equal(await page.locator('.page-head').evaluate(element => element.inert), true)
      const stop = monitor.getByRole('button', { name: '停止当前采集', exact: true })
      await stop.click()
      await monitor.getByRole('button', { name: '正在停止当前采集', exact: true }).waitFor()
      assert.equal(h.stopCount(), 1)
      assert.equal(await monitor.getByRole('button', { name: '正在停止当前采集', exact: true }).isDisabled(), true)
      assert.equal(await monitor.isVisible(), true)
      assert.equal(h.startCount(), 0)
      h.releaseDelayedStop()
    } finally { h.releaseDelayedStop(); await h.browser.close() }
  })
}

for (const status of ['running', 'queued']) {
  test(`collection list can stop only its current ${status} job`, async () => {
    const h = await harness({ path: '/history-scripts?view=collection', initialJob: makeJob({ id: '55', status }), delayStop: true,
      recentJobs: [makeJob({ id: '54', status: 'running' }), makeJob({ id: '53', status: 'stopped', stage: 'stopped' })],
    })
    try {
      const table = h.page.getByRole('table', { name: '采集任务列表', exact: true })
      const row = table.getByRole('row').filter({ hasText: '任务 #55' })
      const stop = row.getByRole('button', { name: '停止采集任务 55', exact: true })
      await stop.click({ trial: true })
      await Promise.all([
        h.page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/history-scripts/jobs/55/stop'),
        stop.click(),
      ])
      assert.equal(await stop.isDisabled(), true)
      assert.equal(h.stopCount(), 1)
      assert.equal(h.getJob().id, '55')
      assert.equal(await table.getByRole('button', { name: /^停止采集任务 / }).count(), 1)
      assert.equal(await h.page.getByRole('button', { name: '停止中', exact: true }).isDisabled(), true)
      h.releaseDelayedStop()
    } finally { h.releaseDelayedStop(); await h.browser.close() }
  })
}

for (const status of ['running', 'queued']) {
  test(`a failed stop request restores the ${status} job and allows a direct retry from monitoring`, async () => {
    const h = await harness({ clock: true, path: '/history-scripts', initialJob: makeJob({ status }), stopFailures: 1 })
    try {
      const { page } = h
      const monitor = await openMonitor(page, '任务日志')
      await monitor.getByRole('button', { name: '停止当前采集', exact: true }).click()
      await monitor.getByRole('alert').filter({ hasText: '停止服务暂时不可用，请重试' }).waitFor()
      const stop = monitor.getByRole('button', { name: '停止当前采集', exact: true })
      assert.equal(await stop.isVisible(), true, 'a failed request must immediately restore the stop action without waiting for polling')
      assert.equal(await stop.isEnabled(), true)
      await stop.click({ trial: true })
      assert.equal(h.getJob().status, status)
      assert.equal(h.stopCount(), 1)
      await monitor.getByRole('tab', { name: '连接检测', exact: true }).click()
      await stop.click()
      await monitor.getByRole('button', { name: '正在停止当前采集', exact: true }).waitFor()
      assert.equal(h.stopCount(), 2)
      assert.equal(h.getJob().status, 'stopping')
      assert.equal(h.startCount(), 0)
    } finally { await h.browser.close() }
  })
}

test('a late stop failure and failed polling cannot roll back a confirmed stopped job or retain the request lock', async () => {
  const h = await harness({ clock: true, initialJob: makeJob(), stopFailures: 1, delayStop: true })
  try {
    const { page } = h
    await page.getByRole('button', { name: '停止', exact: true }).click()
    const monitor = await openMonitor(page)
    h.setJob(makeJob({ status: 'stopped', stage: 'stopped' }))
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await monitor.getByText('当前任务 #job-1 · 已停止', { exact: true }).waitFor()
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/stop'))
    h.releaseDelayedStop()
    await response
    await page.waitForFunction(() => !document.querySelector('.page-head button.btn-primary[disabled]'))
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    h.setJobsFailure(true)
    await page.clock.fastForward(4_500)
    await monitor.getByRole('tab', { name: '任务日志', exact: true }).click()
    await monitor.getByRole('alert').filter({ hasText: '任务服务暂不可用' }).waitFor()
    await monitor.getByText('当前任务 #job-1 · 已停止', { exact: true }).waitFor()
    assert.equal(await monitor.getByRole('button', { name: /停止当前采集/ }).count(), 0)
    assert.equal(h.stopCount(), 1)
    h.setJobsFailure(false)
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await closeMonitor(page)
    await page.getByRole('button', { name: '启动采集', exact: true }).click({ trial: true })
  } finally { h.releaseDelayedStop(); await h.browser.close() }
})

test('a failed status refresh during an unsuccessful stop still restores a directly retryable job', async () => {
  const h = await harness({ clock: true, initialJob: makeJob(), stopFailures: 1, delayStop: true })
  try {
    const { page } = h
    await page.getByRole('button', { name: '停止', exact: true }).click()
    const monitor = await openMonitor(page)
    h.setJobsFailure(true)
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await monitor.getByRole('alert').filter({ hasText: '任务服务暂不可用' }).waitFor()
    const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/stop'))
    h.releaseDelayedStop()
    await response
    await monitor.getByRole('alert').filter({ hasText: '停止服务暂时不可用，请重试' }).waitFor()
    const stop = monitor.getByRole('button', { name: '停止当前采集', exact: true })
    await stop.click({ trial: true })
    h.setJobsFailure(false)
    await stop.click()
    await monitor.getByRole('button', { name: '正在停止当前采集', exact: true }).waitFor()
    assert.equal(h.stopCount(), 2)
    assert.equal(h.getJob().status, 'stopping')
    h.releaseDelayedStop()
  } finally { h.releaseDelayedStop(); await h.browser.close() }
})

test('a queued job immediately stopped by the server restores the start action', async () => {
  const h = await harness({ path: '/history-scripts', initialJob: makeJob({ status: 'queued' }), stopStatus: 'stopped' })
  try {
    await h.page.locator('.page-head').getByRole('button', { name: '停止采集', exact: true }).click()
    await h.page.getByRole('button', { name: '启动采集', exact: true }).click({ trial: true })
    assert.equal(h.stopCount(), 1)
    assert.equal(h.getJob().status, 'stopped')
    assert.equal(await h.page.getByRole('button', { name: /正在停止采集|停止采集$/, exact: true }).count(), 0)
    const monitor = await openMonitor(h.page)
    assert.equal(await monitor.getByRole('button', { name: /停止当前采集/ }).count(), 0)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('stopping from historical logs still targets the current collection job and shares one pending request', async () => {
  const h = await harness({ path: '/history-scripts', initialJob: makeJob({ id: '55' }), delayStop: true,
    recentJobs: [makeJob({ id: '54', status: 'failed', stage: 'failed', errorMessage: '历史采集失败' })],
  })
  try {
    const { page } = h
    const monitor = await openMonitor(page, '任务日志')
    await monitor.getByRole('combobox', { name: '查看采集任务' }).selectOption('54')
    await monitor.locator('.monitor-job-summary').getByText('#54 · 失败', { exact: true }).waitFor()
    const stop = monitor.getByRole('button', { name: '停止当前采集', exact: true })
    await stop.evaluate(button => { button.click(); button.click() })
    await monitor.getByRole('button', { name: '正在停止当前采集', exact: true }).waitFor()
    assert.equal(h.stopCount(), 1)
    assert.equal(h.getJob().id, '55')
    assert.equal(await monitor.getByRole('combobox', { name: '查看采集任务' }).inputValue(), '54')
    await closeMonitor(page)
    assert.equal(await page.locator('.page-head').getByRole('button', { name: '正在停止采集', exact: true }).isDisabled(), true)
    h.releaseDelayedStop()
  } finally { h.releaseDelayedStop(); await h.browser.close() }
})

test('stop collection controls stay visible and unobstructed on desktop and 390px mobile', async () => {
  const h = await harness({ path: '/history-scripts', initialJob: makeJob({ id: '55001' }) })
  try {
    const { page } = h
    for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.getByRole('tab', { name: '视频制作', exact: true }).click()
      const stop = page.locator('.page-head').getByRole('button', { name: '停止采集', exact: true })
      await assertControlReachable(page, stop)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/stop-production-${viewport.width}.png` })
      const monitor = await openMonitor(page)
      const monitorStop = monitor.getByRole('button', { name: '停止当前采集', exact: true })
      await assertControlReachable(page, monitorStop)
      const heading = await monitor.locator('.monitor-head > div').first().boundingBox()
      const actions = await monitor.locator('.monitor-head-actions').boundingBox()
      assert.ok(heading.x + heading.width <= actions.x, 'monitor heading and stop controls must not overlap')
      assert.equal(await monitor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
      if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/stop-monitor-${viewport.width}.png` })
      await monitor.getByRole('tab', { name: '任务日志', exact: true }).click()
      await assertControlReachable(page, monitorStop)
      await closeMonitor(page)
      await page.getByRole('tab', { name: /^采集任务/ }).click()
      const rowStop = page.getByRole('table', { name: '采集任务列表', exact: true }).getByRole('button', { name: '停止采集任务 55001', exact: true })
      await assertControlReachable(page, rowStop)
      assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/stop-list-${viewport.width}.png` })
    }
    assert.equal(h.stopCount(), 0)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('Douyin is the default source and CZGTS can be selected to start articles independently without exposing credentials', async () => {
  const h = await harness({ initialBrowserSession: makeBrowserSession({ status: 'blocked', canCollect: false }) })
  const consoleMessages = []
  h.page.on('console', message => consoleMessages.push(message.text()))
  try {
    const { page } = h
    await page.getByRole('button', { name: '采集设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '启动历史素材采集' })
    const sourceSelect = dialog.getByRole('combobox', { name: '采集来源' })
    assert.equal(await sourceSelect.inputValue(), 'douyin')
    await sourceSelect.selectOption('czgts')
    await dialog.getByText('尚未配置登录 Cookie', { exact: true }).waitFor()
    const start = dialog.getByRole('button', { name: '开始采集', exact: true })
    assert.equal(await start.isEnabled(), false)
    const cookie = dialog.locator('#czgts-cookie')
    assert.equal(await cookie.getAttribute('type'), 'password')
    await cookie.fill('sessionid=test-only-cookie')
    await dialog.getByRole('button', { name: '保存 Cookie', exact: true }).click()
    await dialog.getByText('登录 Cookie 已保存。', { exact: true }).waitFor()
    assert.equal(await cookie.inputValue(), '')
    assert.equal(h.cookieSaveCount(), 1)
    assert.equal(await dialog.getByRole('region', { name: '采集关键词设置' }).count(), 0)
    const inputs = dialog.locator('input[type="datetime-local"]')
    const startTime = await inputs.nth(0).inputValue()
    const endTime = await inputs.nth(1).inputValue()
    assert.equal(Date.parse(`${endTime}+08:00`) - Date.parse(`${startTime}+08:00`), 86_400_000)
    await inputs.nth(0).fill(endTime)
    await dialog.getByText('结束时间必须晚于开始时间。').waitFor()
    assert.equal(await start.isEnabled(), false)
    await inputs.nth(0).fill(startTime)
    await dialog.getByRole('button', { name: '检测文章接口' }).click()
    await dialog.getByText('接口检测成功，找到 287 篇文章。').waitFor()
    await page.setViewportSize({ width: 375, height: 812 })
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'mobile settings must not overflow horizontally')
    if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/czgts-settings-mobile.png` })
    await start.click()
    assert.deepEqual(h.startBody(), { source: 'czgts', targetCount: 1, czgts: { startTime: startTime.replace('T', ' '), endTime: endTime.replace('T', ' ') } })
    assert.equal(h.browserCheckCount(), 0)
    assert.equal(consoleMessages.some(value => value.includes('test-only-cookie')), false)
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes('test-only-cookie')), false)
  } finally { await h.browser.close() }
})

test('saved Baijiahao article displays original text and metrics without video or rewrite claims', async () => {
  const h = await harness({ sourceOverrides: {
    platform: 'baijiahao', category: 'unclassified', status: 'article_saved',
    sourceUrl: 'https://baijiahao.baidu.com/s?id=1879511407398993709',
    mediaJson: '{"kind":"article"}', metricsJson: '{"reads":3793,"fans":8}',
    rawTranscript: '这是保存的完整文章原文。', correctedTranscript: null, rewrittenScript: null,
    videoAvailable: false, artifactState: { transcript: 'current', corrected: 'missing', rewritten: 'missing' },
  } })
  try {
    const { page } = h
    await page.getByRole('button', { name: '文章原文', exact: true }).waitFor()
    assert.equal(await page.locator('.script-column.original pre').innerText(), '这是保存的完整文章原文。')
    assert.equal(await page.locator('#rewritten-script').inputValue(), '')
    assert.equal(await page.getByText('视频尚未下载', { exact: true }).count(), 0)
    await page.getByRole('tab', { name: /^来源与审阅/ }).click()
    assert.equal(await page.getByText('原文已保存，待审稿未编写', { exact: true }).isVisible(), true)
    assert.equal(await page.getByText('3,793 / 8', { exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('link', { name: '来源', exact: true }).getAttribute('href'), 'https://baijiahao.baidu.com/s?id=1879511407398993709')
    await page.getByRole('button', { name: '采集设置', exact: true }).click()
    assert.equal(await page.getByRole('dialog').getByLabel('待分类', { exact: true }).count(), 0)
  } finally { await h.browser.close() }
})

test('collection keywords add, edit, delete and persist as separate sequential searches', async () => {
  const h = await harness()
  try {
    const { page } = h
    await page.getByRole('button', { name: '启动采集', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '启动历史素材采集' })
    await dialog.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    const start = dialog.getByRole('button', { name: '开始采集', exact: true })
    await dialog.getByRole('textbox', { name: '采集关键词 1', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '添加关键词', exact: true }).click()
    await dialog.getByRole('textbox', { name: '采集关键词 2', exact: true }).fill('明朝')
    assert.equal(await start.isEnabled(), false, 'unsaved edits must not silently collect old keywords')
    await dialog.getByRole('button', { name: '保存关键词', exact: true }).click()
    await dialog.getByText('关键词已保存，将用于下次采集。', { exact: true }).waitFor()
    await dialog.getByRole('textbox', { name: '采集关键词 1', exact: true }).fill('历史人物')
    await dialog.getByRole('button', { name: '添加关键词', exact: true }).click()
    await dialog.getByRole('textbox', { name: '采集关键词 3', exact: true }).fill('清朝')
    await dialog.getByRole('button', { name: '删除关键词 3', exact: true }).click()
    await dialog.getByRole('button', { name: '保存关键词', exact: true }).click()
    await dialog.getByText('关键词已保存，将用于下次采集。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: '启动采集', exact: true }).click()
    await dialog.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    await dialog.getByRole('textbox', { name: '采集关键词 2', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('textbox', { name: '采集关键词 1', exact: true }).inputValue(), '历史人物')
    assert.equal(await dialog.getByRole('textbox', { name: '采集关键词 2', exact: true }).inputValue(), '明朝')
    await start.click()
    assert.deepEqual(h.startBody().keywords, ['历史人物', '明朝'])
  } finally { await h.browser.close() }
})

test('empty and duplicate collection keywords cannot be saved or submitted', async () => {
  const h = await harness()
  try {
    await h.page.getByRole('button', { name: '启动采集', exact: true }).click()
    const dialog = h.page.getByRole('dialog', { name: '启动历史素材采集' })
    await dialog.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    await dialog.getByRole('textbox', { name: '采集关键词 1', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '添加关键词', exact: true }).click()
    assert.equal(await dialog.getByRole('button', { name: '保存关键词', exact: true }).isEnabled(), false)
    await dialog.getByRole('textbox', { name: '采集关键词 2', exact: true }).fill('历史')
    await dialog.getByText('关键词不能重复。', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '保存关键词', exact: true }).isEnabled(), false)
    assert.equal(await dialog.getByRole('button', { name: '开始采集', exact: true }).isEnabled(), false)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

async function youtubeDialog(h) {
  await h.page.getByRole('button', { name: '采集设置', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: '启动历史素材采集' })
  await dialog.getByRole('combobox', { name: '采集来源' }).selectOption('youtube')
  return dialog
}

test('YouTube channels can be added, edited, deleted, saved and reloaded before submitting the saved list', async () => {
  const h = await harness({ initialBrowserSession: makeBrowserSession({ status: 'login_required', canCollect: false }) })
  try {
    let dialog = await youtubeDialog(h)
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('radio', { name: '频道列表', exact: true }).isChecked(), true)
    assert.match(await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).inputValue(), /助眠睡前歷史故事/)
    const start = () => dialog.getByRole('button', { name: '开始采集', exact: true })
    await dialog.getByRole('button', { name: '添加频道', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'YouTube 频道 2', exact: true }).fill('https://youtube.com/@second-channel?feature=shared')
    assert.equal(await start().isEnabled(), false)
    await dialog.getByRole('button', { name: '保存频道', exact: true }).click()
    await dialog.getByText('频道列表已保存，将用于下次采集。', { exact: true }).waitFor()
    assert.deepEqual(Object.keys(h.settingsWrites[0]), ['youtubeChannels'], 'saving channels must not overwrite keywords')
    assert.equal(h.settingsWrites[0].youtubeChannels[1], 'https://www.youtube.com/@second-channel/videos')
    await dialog.getByRole('button', { name: '删除频道 1', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).fill('https://www.youtube.com/@updated-channel/videos')
    await dialog.getByRole('button', { name: '添加频道', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'YouTube 频道 2', exact: true }).fill('https://www.youtube.com/@third-channel')
    await dialog.getByRole('button', { name: '保存频道', exact: true }).click()
    await dialog.getByText('频道列表已保存，将用于下次采集。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await h.page.reload({ waitUntil: 'domcontentloaded' })
    dialog = await youtubeDialog(h)
    await dialog.getByRole('textbox', { name: 'YouTube 频道 2', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).inputValue(), 'https://www.youtube.com/@updated-channel/videos')
    assert.deepEqual(h.collectionSettings().keywords, ['历史'])
    await start().click()
    await h.page.getByRole('button', { name: '停止采集', exact: true }).waitFor()
    assert.deepEqual(h.startBody(), { source: 'youtube', youtube: { urls: ['https://www.youtube.com/@updated-channel/videos', 'https://www.youtube.com/@third-channel/videos'] }, targetCount: 1 })
    assert.equal(h.browserCheckCount(), 0, 'YouTube must not require Douyin readiness')
  } finally { await h.browser.close() }
})

test('YouTube channel aliases, non-channel URLs and an empty list cannot be saved or collected', async () => {
  const h = await harness({ youtubeChannels: ['https://www.youtube.com/@History/videos'] })
  try {
    const dialog = await youtubeDialog(h)
    const save = dialog.getByRole('button', { name: '保存频道', exact: true })
    const start = dialog.getByRole('button', { name: '开始采集', exact: true })
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '添加频道', exact: true }).click()
    const second = dialog.getByRole('textbox', { name: 'YouTube 频道 2', exact: true })
    await second.fill('https://m.youtube.com/@history?feature=shared')
    await dialog.getByText('频道不能重复，频道主页与 videos 页视为同一个频道。', { exact: true }).waitFor()
    assert.equal(await save.isEnabled(), false)
    assert.equal(await start.isEnabled(), false)
    for (const invalid of ['https://example.com/@history', 'https://youtu.be/VprFAzjTTuM', 'https://www.youtube.com/watch?v=VprFAzjTTuM']) {
      await second.fill(invalid)
      assert.equal(await save.isEnabled(), false)
      assert.equal(await start.isEnabled(), false)
    }
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).fill('https://www.youtube.com/@历史')
    await second.fill('https://youtube.com/@%E5%8E%86%E5%8F%B2/videos')
    await dialog.getByText('频道不能重复，频道主页与 videos 页视为同一个频道。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '删除频道 2', exact: true }).click()
    await dialog.getByRole('button', { name: '删除频道 1', exact: true }).click()
    await dialog.getByText('请保留至少一个频道。', { exact: true }).waitFor()
    assert.equal(await save.isEnabled(), false)
    assert.equal(h.settingsWrites.length, 0)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('YouTube channel read and save failures remain recoverable without starting stale channels', async () => {
  const h = await harness({ failSettingsRead: true })
  try {
    const dialog = await youtubeDialog(h)
    const start = dialog.getByRole('button', { name: '开始采集', exact: true })
    await dialog.getByText('频道配置暂不可用', { exact: false }).waitFor()
    assert.equal(await start.isEnabled(), false)
    h.setSettingsReadFailure(false)
    await dialog.getByRole('button', { name: '重新读取', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).waitFor()
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).fill('https://www.youtube.com/@changed')
    h.setSettingsSaveFailure(true)
    await dialog.getByRole('button', { name: '保存频道', exact: true }).click()
    await dialog.getByText('保存频道失败，请重试', { exact: false }).waitFor()
    assert.equal(await start.isEnabled(), false)
    assert.match(await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).inputValue(), /changed/)
    h.setSettingsSaveFailure(false)
    await dialog.getByRole('button', { name: '保存频道', exact: true }).click()
    await dialog.getByText('频道列表已保存，将用于下次采集。', { exact: true }).waitFor()
    assert.equal(await start.isEnabled(), true)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('YouTube single-video collection keeps the saved channel list and submits only that video', async () => {
  const h = await harness({ initialBrowserSession: makeBrowserSession({ status: 'login_required', canCollect: false }) })
  try {
    const dialog = await youtubeDialog(h)
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).waitFor()
    await dialog.getByRole('radio', { name: '单条视频', exact: true }).check()
    const input = dialog.getByRole('textbox', { name: 'YouTube 视频链接', exact: true })
    await input.fill('https://www.youtube.com/@history/videos')
    assert.equal(await dialog.getByRole('button', { name: '开始采集', exact: true }).isEnabled(), false)
    await input.fill('https://www.youtube.com/watch?v=VprFAzjTTuM')
    await dialog.getByRole('button', { name: '开始采集', exact: true }).click()
    await h.page.getByRole('button', { name: '停止采集', exact: true }).waitFor()
    assert.deepEqual(h.startBody().youtube, { urls: ['https://www.youtube.com/watch?v=VprFAzjTTuM'] })
    assert.equal(h.settingsWrites.length, 0)
    assert.equal(h.browserCheckCount(), 0)
  } finally { await h.browser.close() }
})

test('YouTube channel editing fits a narrow viewport and preserves unsaved entries when switching video mode', async () => {
  const h = await harness({ viewport: { width: 375, height: 667 } })
  try {
    const dialog = await youtubeDialog(h)
    await dialog.getByRole('textbox', { name: 'YouTube 频道 1', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '添加频道', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'YouTube 频道 2', exact: true }).fill('https://www.youtube.com/@another-channel/videos')
    await dialog.getByRole('radio', { name: '单条视频', exact: true }).check()
    await dialog.getByRole('radio', { name: '频道列表', exact: true }).check()
    assert.equal(await dialog.getByRole('textbox', { name: 'YouTube 频道 2', exact: true }).inputValue(), 'https://www.youtube.com/@another-channel/videos')
    assert.equal(await dialog.getByRole('button', { name: '开始采集', exact: true }).isEnabled(), false)
    const overflow = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight, viewport: window.innerHeight }))
    assert.ok(overflow.scroll <= overflow.width + 1, 'channel rows cannot cause horizontal scrolling')
    assert.ok(overflow.height <= overflow.viewport - 30)
    await dialog.getByRole('button', { name: '保存频道', exact: true }).click()
    await dialog.getByText('频道列表已保存，将用于下次采集。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '开始采集', exact: true }).scrollIntoViewIfNeeded()
    await h.page.screenshot({ path: '/tmp/history-youtube-channels-375.png' })
  } finally { await h.browser.close() }
})

test('compact common collection toolbar reserves the first viewport for manuscript comparison and opens source media separately', async () => {
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: '抖音验证尚未通过' }), viewport: { width: 1440, height: 900 } })
  try {
    const { page } = h
    assert.equal(await page.getByRole('dialog', { name: '采集监控', exact: true }).count(), 0)
    assert.equal(await page.getByRole('list', { name: '任务日志记录' }).isVisible(), false)
    const toolbar = await page.getByRole('region', { name: '历史素材采集任务' }).boundingBox()
    assert.ok(toolbar.height <= 60, `toolbar is too tall: ${toolbar.height}`)
    assert.equal(await page.getByText('失败 · 失败', { exact: true }).count(), 0)
    assert.equal(await page.locator('.video-panel').isVisible(), false, 'source media belongs to 来源与审阅')
    assert.equal(await page.getByRole('region', { name: '花生自动制作', exact: true }).isVisible(), false)
    const compare = await page.getByRole('textbox', { name: '编辑待审稿' }).boundingBox()
    assert.ok(compare.y < 760, 'script editor begins in the first viewport')
    const original = await page.locator('.script-column.original').boundingBox()
    assert.ok(original.x + original.width <= compare.x + 1, 'desktop keeps the original beside the rewrite')
    await page.getByRole('tab', { name: /^来源与审阅/ }).click()
    const video = await page.locator('.video-panel').boundingBox()
    assert.ok(video.y + video.height < 900, 'source media is visible in its own tab')
    await page.getByRole('tab', { name: '文稿', exact: true }).click()
    if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/compact-workspace-desktop.png` })
    await page.setViewportSize({ width: 375, height: 812 })
    const mobileToolbar = await page.getByRole('region', { name: '历史素材采集任务' }).boundingBox()
    assert.ok(mobileToolbar.height <= 60, `mobile toolbar is too tall: ${mobileToolbar.height}`)
    assert.equal(await page.getByRole('searchbox', { name: '搜索历史脚本', exact: true }).isVisible(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/compact-workspace-mobile.png` })
  } finally { await h.browser.close() }
})

test('a previous failed job does not mark a ready browser connection as failing and retains its historical logs', async () => {
  const historicalError = 'Lightpanda 旧任务验证码拦截'
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: historicalError,
    events: [{ id: 1, createdAt: '2026-10-14T07:00:05.000Z', stage: 'failed', level: 'error', message: historicalError }] }),
    initialBrowserSession: makeBrowserSession(),
  })
  try {
    const { page } = h
    const toolbar = page.getByRole('region', { name: '历史素材采集任务' })
    await toolbar.getByText('上次任务 · 失败', { exact: true }).waitFor()
    await toolbar.getByRole('button', { name: '查看任务失败详情', exact: true }).getByText(`失败原因：${historicalError}`, { exact: true }).waitFor()
    assert.equal(await toolbar.getByText('抖音连接 · 采集已就绪', { exact: true }).count(), 0)
    assert.equal(await toolbar.getByRole('button', { name: '采集监控', exact: true }).locator('.attention-dot').count(), 1)
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true }).isEnabled(), true)
    assert.equal(await toolbar.getByRole('button', { name: '停止', exact: true }).count(), 0)
    const monitor = await openMonitor(page)
    await monitor.getByText('可以采集', { exact: true }).waitFor()
    await monitor.getByRole('heading', { name: '可以采集', exact: true }).waitFor()
    assert.equal(await monitor.getByRole('list', { name: '登录检测步骤' }).isVisible(), false)
    assert.equal(await monitor.getByRole('tab', { name: '连接检测', exact: true }).locator('.attention-dot').count(), 0)
    await monitor.getByRole('tab', { name: '任务日志', exact: true }).click()
    await monitor.getByRole('alert').getByText(`失败原因：${historicalError}`, { exact: true }).waitFor()
    await monitor.getByRole('list', { name: '任务日志记录' }).getByText(historicalError, { exact: true }).waitFor()
    assert.equal(h.getJob().errorMessage, historicalError)
    assert.equal(h.browserCheckCount(), 0)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('filter failures explain recovery and retry with the failed task configuration', async () => {
  const config = { source: 'douyin', targetCount: null, categories: ['history_trivia'], keywords: ['明朝', '朱元璋'] }
  const rawError = '搜索筛选未完成：未能确认“5分钟以上”和“视频”已选中、发布时间不限并加载结果，未开始扫描'
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: rawError, config, targetCount: null }) })
  try {
    const { page } = h
    const toolbar = page.getByRole('region', { name: '历史素材采集任务' })
    await toolbar.getByRole('button', { name: '查看任务失败详情', exact: true }).click()
    const monitor = page.getByRole('dialog', { name: '采集监控', exact: true })
    await monitor.getByText(/点击“重试采集”自动重新检测/).waitFor()
    await monitor.getByRole('button', { name: '重试采集', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 1, 'retry rechecks the actual search even when previous readiness was usable')
    assert.equal(h.startCount(), 1)
    assert.deepEqual(h.startBody(), config)
    assert.equal(await monitor.isVisible(), false)
  } finally { await h.browser.close() }
})

test('retry exposes login recovery without starting work when the new search check fails', async () => {
  const h = await harness({
    initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: '搜索筛选未完成：未能确认筛选项' }),
    browserCheckResponse: makeBrowserSession({ status: 'login_required', canCollect: false, message: '抖音要求登录，请在专用窗口登录' }),
  })
  try {
    await h.page.getByRole('region', { name: '历史素材采集任务' }).getByRole('button', { name: '重试采集', exact: true }).click()
    const monitor = h.page.getByRole('dialog', { name: '采集监控', exact: true })
    await monitor.getByRole('heading', { name: '暂时不能采集', exact: true }).waitFor()
    await monitor.getByRole('button', { name: '打开登录窗口', exact: true }).waitFor()
    assert.equal(h.startCount(), 0)
    await closeMonitor(h.page)
    assert.equal(await h.page.getByRole('region', { name: '历史素材采集任务' }).getByRole('button', { name: '重试采集', exact: true }).isEnabled(), true)
  } finally { await h.browser.close() }
})

test('repeated retry clicks cannot start multiple checks or collection jobs', async () => {
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: '搜索筛选未完成：未能确认筛选项' }), delayBrowserCheck: true })
  try {
    const retry = h.page.getByRole('region', { name: '历史素材采集任务' }).getByRole('button', { name: '重试采集', exact: true })
    await retry.evaluate(button => { button.click(); button.click() })
    await h.page.waitForFunction(() => document.querySelector('.job-actions button[aria-label="重试采集"]:disabled'))
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 0)
    h.releaseDelayedBrowserCheck()
    await h.page.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.equal(h.startCount(), 1)
  } finally { h.releaseDelayedBrowserCheck(); await h.browser.close() }
})

test('article collection retry preserves its range and does not require Douyin readiness', async () => {
  const config = { source: 'czgts', targetCount: 2, czgts: { startTime: '2026-10-23 00:00:00', endTime: '2026-10-24 23:59:59' }, categories: categoryValues, keywords: ['历史'] }
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: '文章接口暂时不可用', config }),
    initialBrowserSession: makeBrowserSession({ status: 'blocked', canCollect: false }) })
  try {
    await h.page.getByRole('region', { name: '历史素材采集任务' }).getByRole('button', { name: '重试采集', exact: true }).click()
    await h.page.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 0)
    assert.equal(h.startCount(), 1)
    assert.deepEqual(h.startBody(), config)
  } finally { await h.browser.close() }
})

for (const status of ['failed', 'interrupted', 'stopped']) {
  test(`YouTube ${status} collection continues the original task without creating another job`, async () => {
    const h = await harness({ initialJob: makeJob({ id: '40328', status, stage: status,
      config: { source: 'youtube', targetCount: null, youtube: { urls: ['https://www.youtube.com/@history/videos'] } },
      counts: { scanned: 452, selected: 23, completed: 0, failed: 22 },
    }) })
    try {
      const toolbar = h.page.getByRole('region', { name: '历史素材采集任务' })
      await toolbar.getByRole('button', { name: '继续采集', exact: true }).click()
      await toolbar.getByRole('button', { name: '停止', exact: true }).waitFor()
      assert.deepEqual(h.resumeIds, ['40328'])
      assert.equal(h.startCount(), 0)
      assert.equal(h.browserCheckCount(), 0)
      assert.equal(h.getJob().id, '40328')
      assert.equal(h.getJob().counts.selected, 23)
    } finally { await h.browser.close() }
  })
}

test('YouTube login recovery refreshes the current task and waits for explicit continue', async () => {
  const h = await harness({ initialJob: makeJob({ id: '40328', status: 'failed', stage: 'waiting_login',
    errorCode: 'youtube_login_required', errorMessage: 'YouTube 要求登录验证，采集已暂停',
    config: { source: 'youtube', targetCount: null, youtube: { urls: ['https://www.youtube.com/@history/videos'] } },
  }), viewport: { width: 375, height: 812 } })
  try {
    const toolbar = h.page.getByRole('region', { name: '历史素材采集任务' })
    await toolbar.getByText('已暂停采集 · 等待 YouTube 验证', { exact: true }).waitFor()
    const monitor = await openMonitor(h.page)
    await monitor.getByRole('link', { name: '打开 YouTube', exact: true }).waitFor()
    assert.equal(await monitor.getByRole('link', { name: '打开 YouTube', exact: true }).getAttribute('href'), 'https://www.youtube.com/')
    await monitor.getByRole('button', { name: '刷新 YouTube 登录', exact: true }).click()
    await monitor.getByRole('status').getByText('YouTube 登录刷新并验证通过，可继续采集。', { exact: true }).waitFor()
    assert.deepEqual(h.youtubeSessionIds, ['40328'])
    assert.equal(h.resumeIds.length, 0, 'refreshing login must not start collection')
    assert.equal(h.startCount(), 0)
    assert.equal(h.getJob().status, 'failed')
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    if (process.env.HISTORY_UI_SCREENSHOT_DIR) await h.page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/youtube-login-recovery-mobile.png` })
    await monitor.getByRole('button', { name: '继续采集', exact: true }).click()
    await toolbar.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.deepEqual(h.resumeIds, ['40328'])
  } finally { await h.browser.close() }
})

test('legacy YouTube login failures retain a retryable refresh action and the same task', async () => {
  const h = await harness({ failYoutubeSession: true, initialJob: makeJob({ id: '40328', status: 'stopped', stage: 'stopped',
    errorMessage: null, progressMessage: 'YouTube 要求登录验证，请配置有效 Cookie 后重试',
    config: { source: 'youtube', targetCount: null, youtube: { urls: ['https://www.youtube.com/@history/videos'] } },
  }) })
  try {
    const monitor = await openMonitor(h.page)
    const refresh = monitor.getByRole('button', { name: '刷新 YouTube 登录', exact: true })
    await refresh.click()
    await monitor.getByRole('alert').getByText('YouTube 仍要求登录验证，请在 Chrome 中完成验证后再次刷新。', { exact: true }).waitFor()
    assert.equal(await refresh.isEnabled(), true)
    assert.equal(h.resumeIds.length, 0)
    h.setYoutubeSessionFailure(false)
    await refresh.click()
    await monitor.getByRole('status').getByText('YouTube 登录刷新并验证通过，可继续采集。', { exact: true }).waitFor()
    assert.deepEqual(h.youtubeSessionIds, ['40328', '40328'])
    assert.equal(h.getJob().id, '40328')
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('YouTube login recovery in historical logs targets that task instead of the latest one', async () => {
  const historical = makeJob({ id: '40328', status: 'failed', stage: 'waiting_login', errorCode: 'youtube_login_required',
    config: { source: 'youtube', targetCount: null, youtube: { urls: ['https://www.youtube.com/@history/videos'] } },
  })
  const h = await harness({ initialJob: makeJob({ id: '40329', status: 'completed', stage: 'completed' }), recentJobs: [historical] })
  try {
    const monitor = await openMonitor(h.page, '任务日志')
    await monitor.getByRole('combobox', { name: '查看采集任务', exact: true }).selectOption('40328')
    await monitor.getByText('YouTube 采集已暂停：需要登录或完成验证', { exact: true }).waitFor()
    await monitor.getByRole('button', { name: '刷新 YouTube 登录', exact: true }).click()
    await monitor.getByRole('status').getByText('YouTube 登录刷新并验证通过，可继续采集。', { exact: true }).waitFor()
    assert.deepEqual(h.youtubeSessionIds, ['40328'])
    assert.equal(h.getJob().id, '40329')
    await monitor.getByRole('button', { name: '继续采集', exact: true }).click()
    await h.page.getByRole('region', { name: '历史素材采集任务' }).getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.deepEqual(h.resumeIds, ['40328'])
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('YouTube resume conflicts release the continue action for another attempt', async () => {
  const h = await harness({ resumeFailures: 1, initialJob: makeJob({ id: '40328', status: 'stopped', stage: 'stopped',
    config: { source: 'youtube', targetCount: null, youtube: { urls: ['https://www.youtube.com/@history/videos'] } },
  }) })
  try {
    const toolbar = h.page.getByRole('region', { name: '历史素材采集任务' })
    const resume = toolbar.getByRole('button', { name: '继续采集', exact: true })
    await resume.click()
    await toolbar.getByRole('button', { name: '重试状态', exact: true }).waitFor()
    assert.equal(await resume.isEnabled(), true)
    await resume.click()
    await toolbar.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.deepEqual(h.resumeIds, ['40328', '40328'])
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('a failed retry request releases its button and can be retried directly', async () => {
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: '搜索筛选未完成：未能确认筛选项' }), startFailures: 1 })
  try {
    const retry = h.page.getByRole('region', { name: '历史素材采集任务' }).getByRole('button', { name: '重试采集', exact: true })
    await retry.click()
    await h.page.getByRole('button', { name: '重试状态', exact: true }).waitFor()
    assert.equal(await retry.isEnabled(), true)
    await retry.click()
    await h.page.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.equal(h.startCount(), 2)
  } finally { await h.browser.close() }
})

test('model concurrency failures explain waiting and retain a direct retry action', async () => {
  const h = await harness({ initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: 'Text model request failed: 429 {"error":{"code":"gateway_concurrency_limit","message":"Concurrency limit exceeded for user"}}' }) })
  try {
    const toolbar = h.page.getByRole('region', { name: '历史素材采集任务' })
    await toolbar.getByText('浏览抖音失败：模型并发已满（HTTP 429）', { exact: true }).waitFor()
    await toolbar.getByRole('button', { name: '查看任务失败详情', exact: true }).click()
    await h.page.getByRole('alert').getByText('请等其他模型任务结束或稍后点击“重试采集”。已入库稿件保留并自动跳过。', { exact: true }).waitFor()
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('a failed selection shows the model outage reason immediately and opens its full task error', async () => {
  const rawError = 'Text model request failed: 502 {"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}'
  const h = await harness({
    initialJob: makeJob({ status: 'failed', stage: 'failed', errorMessage: rawError, progressMessage: rawError,
      counts: { scanned: 77, selected: 1, completed: 1, failed: 0 }, targetCount: null,
      events: [
        { id: 1, createdAt: '2026-10-15T05:57:46.010Z', stage: 'selecting', level: 'info', message: '正在判断历史选题与评论讨论点' },
        { id: 2, createdAt: '2026-10-15T05:57:57.552Z', stage: 'failed', level: 'error', message: rawError },
      ],
    }),
    initialBrowserSession: makeBrowserSession({ canCollect: false }),
  })
  try {
    const { page } = h
    const reason = '筛选素材失败：模型服务暂时不可用（HTTP 502）'
    const toolbar = page.getByRole('region', { name: '历史素材采集任务' })
    const failure = toolbar.getByRole('button', { name: '查看任务失败详情', exact: true })
    await failure.getByText(reason, { exact: true }).waitFor()
    assert.equal(await toolbar.getByText('抖音连接 · 启动时自动检测', { exact: true }).count(), 0)
    await toolbar.getByText('已入库 1 · 持续采集', { exact: true }).waitFor()
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('失败详情不影响尚未保存的改写稿')
    await failure.click()
    const monitor = page.getByRole('dialog', { name: '采集监控', exact: true })
    assert.equal(await monitor.getByRole('tab', { name: '任务日志' }).getAttribute('aria-selected'), 'true')
    await monitor.getByRole('alert').getByText(reason, { exact: true }).waitFor()
    await monitor.getByRole('alert').getByText(rawError, { exact: true }).waitFor()
    await closeMonitor(page)
    assert.equal(await failure.evaluate(element => element === document.activeElement), true)
    assert.equal(await editor.inputValue(), '失败详情不影响尚未保存的改写稿')
    await page.setViewportSize({ width: 375, height: 812 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.ok((await toolbar.boundingBox()).height <= 60)
    assert.equal(h.startCount(), 0)
    assert.equal(h.browserCheckCount(), 0)
  } finally { await h.browser.close() }
})

test('monitoring drawer traps keyboard focus and restores the unchanged draft and video on close', async () => {
  const h = await harness({ initialJob: makeJob() })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('抽屉开关期间保留的未保存改写稿')
    const editorHandle = await editor.elementHandle()
    const video = await sourceVideoFromManuscript(page)
    const monitorButton = page.getByRole('button', { name: '采集监控', exact: true })
    const monitor = await openMonitor(page)
    await monitor.getByRole('heading', { name: '可以采集', exact: true }).waitFor()
    await editorHandle.evaluate(element => element.focus())
    assert.equal(await editorHandle.evaluate(element => document.activeElement === element), false, 'background workspace cannot receive focus while modal is open')
    await monitor.getByRole('tab', { name: '连接检测', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await monitor.getByRole('tab', { name: '任务日志', exact: true }).getAttribute('aria-selected'), 'true')
    const first = monitor.getByRole('button', { name: '刷新采集状态', exact: true })
    const last = monitor.getByRole('combobox', { name: '日志级别', exact: true })
    await monitor.locator('button[aria-label="刷新采集状态"]:not(:disabled)').waitFor()
    await first.focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await last.evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Tab')
    assert.equal(await first.evaluate(element => document.activeElement === element), true)
    await page.keyboard.press('Escape')
    await monitor.waitFor({ state: 'detached' })
    assert.equal(await monitorButton.evaluate(element => document.activeElement === element), true)
    assert.equal(await editor.inputValue(), '抽屉开关期间保留的未保存改写稿')
    assert.equal(await editorHandle.evaluate(element => element === document.querySelector('#rewritten-script')), true)
    assert.equal(await video.evaluate(element => element === document.querySelector('video.source-video')), true)
    await openMonitor(page)
    await page.locator('.monitor-backdrop').click({ position: { x: 10, y: 10 } })
    await monitor.waitFor({ state: 'detached' })
    assert.equal(await monitorButton.evaluate(element => document.activeElement === element), true)
    assert.equal(h.browserCheckCount(), 0)
    assert.equal(h.browserOpenCount(), 0)
  } finally { await h.browser.close() }
})

test('waiting login is paused and worker heartbeat is distinct from progress with scrolling logs in monitoring', async () => {
  const events = Array.from({ length: 105 }, (_, index) => ({
    id: index + 1,
    createdAt: '2026-10-15T00:45:00.000Z',
    stage: 'waiting_login',
    level: 'info',
    message: `业务日志 ${index + 1}：等待用户完成登录后由程序检测`,
  }))
  const h = await harness({ initialJob: makeJob({ stage: 'waiting_login', events, progressAt: '2026-10-15T00:45:00.000Z', updatedAt: '2026-10-15T01:10:00.000Z' }) })
  try {
    const { page } = h
    await page.getByText('已暂停采集 · 等待登录', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), true)
    const monitor = await openMonitor(page, '任务日志')
    const health = page.getByRole('region', { name: '任务活动状态' })
    await health.getByText('工作进程 · 心跳正常', { exact: true }).waitFor()
    await health.getByText(/心跳 2026.*09:00:00/).waitFor()
    await health.getByText(/租约至 2026.*09:01:00/).waitFor()
    await health.getByText(/最近业务进展 2026.*08:45:00/).waitFor()
    const logs = page.getByRole('list', { name: '任务日志记录' })
    assert.equal(await logs.locator('li').count(), 100)
    await logs.getByText('业务日志 105：等待用户完成登录后由程序检测', { exact: true }).waitFor()
    assert.equal(await logs.getByText('业务日志 5：等待用户完成登录后由程序检测', { exact: true }).count(), 0)
    assert.equal(await monitor.locator('.monitor-body').evaluate(element => element.scrollHeight > element.clientHeight), true)

    h.setJob(makeJob({ stage: 'waiting_login', workerHealth: 'stale', heartbeatAt: '2026-10-15T00:00:00.000Z', events }))
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await health.getByText('工作进程 · 心跳超时', { exact: true }).waitFor()
    await health.getByText(/心跳 2026.*08:00:00/).waitFor()
    h.setJob(makeJob({ stage: 'waiting_login', workerHealth: 'inactive', heartbeatAt: null, leaseExpiresAt: null, progressAt: null, events: [] }))
    await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
    await health.getByText('工作进程 · 未运行', { exact: true }).waitFor()
    await health.getByText('暂无心跳', { exact: true }).waitFor()
    await health.getByText('暂无业务进展', { exact: true }).waitFor()
  } finally { await h.browser.close() }
})

test('programmatic login detection resumes the same paused job and preserves the draft and video', async () => {
  const h = await harness({ clock: true, initialJob: makeJob({ stage: 'waiting_login', targetCount: null }), initialBrowserSession: makeBrowserSession({ status: 'login_required', canCollect: false }) })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('登录过程中尚未保存的稿件')
    const video = await sourceVideoFromManuscript(page)
    await openMonitor(page)
    const login = page.getByRole('region', { name: '抖音采集登录' })
    await login.waitFor()
    await page.locator('.job-copy').getByText('已暂停采集 · 等待登录', { exact: true }).waitFor({ state: 'attached' })
    await login.getByText('暂时不能采集', { exact: true }).waitFor()
    assert.equal(await page.locator('.job-actions button').filter({ hasText: '停止' }).isEnabled(), true)
    assert.equal(await login.locator('a').count(), 0)

    const originalJobId = h.getJob().id

    await login.getByRole('button', { name: '打开登录窗口', exact: true }).click()
    await login.getByText('暂时不能采集', { exact: true }).waitFor()
    await login.getByRole('button', { name: '打开登录窗口', exact: true }).click()
    assert.equal(h.browserOpenCount(), 2, 'a closed login window can be reopened')
    assert.deepEqual(h.browserOpenBody(), {})
    await login.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await login.getByText('可以采集', { exact: true }).waitFor()
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    assert.deepEqual(h.browserCheckBody(), {})
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 0, 'checking login must not create another job')
    assert.equal(h.getJob().id, originalJobId)
    await login.getByText('最近检测 09:01:00', { exact: true }).waitFor()
    await login.locator('summary').click()
    await login.getByRole('list', { name: '登录检测步骤' }).getByText('搜索结果和视频卡片检测通过', { exact: true }).waitFor()
    await page.clock.fastForward(4_500)
    await login.getByText('可以采集', { exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 1, 'read-only polling must not trigger another probe')
    await closeMonitor(page)
    assert.equal(await editor.inputValue(), '登录过程中尚未保存的稿件')
    assert.equal(await video.evaluate(element => element.isConnected), true)
  } finally { await h.browser.close() }
})

test('unverified sessions allow start settings and manual detection remains repeatable without polling probes', async () => {
  const h = await harness({ clock: true, delayBrowserCheck: true, initialBrowserSession: makeBrowserSession({ status: 'login_required', canCollect: false, checkedAt: null }) })
  try {
    const { page } = h
    const monitor = await openMonitor(page)
    const login = page.getByRole('region', { name: '抖音采集登录' })
    const start = page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true })
    const check = login.getByRole('button', { name: '检测登录状态', exact: true })
    for (const [status, label, canCollect, checkedAt] of [
      ['login_required', '暂时不能采集', false, null],
      ['waiting_login', '暂时不能采集', false, null],
      ['session_saved', '启动时自动检测', false, null],
      ['blocked', '暂时不能采集', false, '2026-10-15T01:00:00.000Z'],
      ['error', '暂时不能采集', false, '2026-10-15T01:00:00.000Z'],
      ['ready', '启动时自动检测', false, '2026-10-15T01:00:00.000Z'],
      ['ready', '启动时自动检测', true, null],
    ]) {
      h.setBrowserSession(makeBrowserSession({ status, canCollect, checkedAt, message: `${status}的具体原因` }))
      await monitor.getByRole('button', { name: '刷新采集状态', exact: true }).click()
      await login.getByRole('heading', { name: label, exact: true }).waitFor()
      if (label === '暂时不能采集') await login.getByText(`${status}的具体原因`, { exact: true }).waitFor()
      await page.waitForFunction(() => Boolean(document.querySelector('.page-head .btn-primary:not(:disabled)')))
      assert.equal(await start.isEnabled(), true, `${status} can open start settings for automatic detection`)
      assert.equal(await check.isEnabled(), true, `${status} can be rechecked`)
    }
    await page.clock.fastForward(12_000)
    assert.equal(h.browserCheckCount(), 0)
    await check.click()
    await login.getByText('正在检测', { exact: true }).waitFor()
    assert.equal(await check.isDisabled(), true)
    assert.equal(await start.isDisabled(), true, 'Douyin collection waits for the in-flight detection to finish')
    h.releaseDelayedBrowserCheck()
    await login.getByText('可以采集', { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.browser-session button[aria-busy="true"]'))
    await page.waitForFunction(() => Boolean(document.querySelector('.page-head .btn-primary:not(:disabled)')))
    assert.equal(await start.isEnabled(), true)
    assert.equal(await check.isEnabled(), true)
    assert.deepEqual(h.browserCheckBody(), {})
    assert.equal(h.browserCheckCount(), 1)
    await check.click()
    await login.getByText('正在检测', { exact: true }).waitFor()
    h.releaseDelayedBrowserCheck()
    await login.getByText('可以采集', { exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 2)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('login detection failure preserves start settings and editing and remains retryable', async () => {
  const h = await harness({ failBrowserSession: true })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('登录服务断开时仍可编辑')
    assert.equal(await page.getByRole('button', { name: '保存修改', exact: true }).isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    assert.equal(await editor.inputValue(), '登录服务断开时仍可编辑')
    await openMonitor(page)
    const login = page.getByRole('region', { name: '抖音采集登录' })
    await login.getByText('暂时不能采集', { exact: true }).waitFor()
    await login.getByRole('alert').filter({ hasText: '登录服务未连接' }).waitFor()

    h.setBrowserSessionFailure(false)
    await login.getByRole('button', { name: '重试登录状态', exact: true }).click()
    await login.getByText('可以采集', { exact: true }).waitFor()
    h.setBrowserOpenFailure(true)
    await login.getByRole('button', { name: '打开登录窗口', exact: true }).click()
    await login.getByRole('alert').filter({ hasText: '登录窗口暂时无法打开' }).waitFor()
    h.setBrowserOpenFailure(false)
    await login.getByRole('button', { name: '打开登录窗口', exact: true }).click()
    await login.getByText('暂时不能采集', { exact: true }).waitFor()
    h.setBrowserCheckFailure(true)
    await login.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await login.getByRole('alert').filter({ hasText: '登录检测服务暂时不可用' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    h.setBrowserCheckFailure(false)
    await login.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await login.getByText('可以采集', { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.browser-session button[aria-busy="true"]'))
    assert.equal(await login.getByRole('button', { name: '检测登录状态', exact: true }).isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    assert.equal(h.startCount(), 0)
    await closeMonitor(page)
    assert.equal(await editor.inputValue(), '登录服务断开时仍可编辑')
  } finally { await h.browser.close() }
})

test('stale session reads cannot replace the programmatic login result', async () => {
  const h = await harness({ delayFirstBrowserSession: true })
  try {
    const { page } = h
    await openMonitor(page)
    const login = page.getByRole('region', { name: '抖音采集登录' })
    await login.getByRole('button', { name: '打开登录窗口', exact: true }).click()
    await login.getByText('暂时不能采集', { exact: true }).waitFor()
    await login.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await login.getByText('可以采集', { exact: true }).waitFor()
    h.releaseDelayedBrowserSession()
    await page.waitForTimeout(100)
    await login.getByText('可以采集', { exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('in-flight login detection polls read-only steps and ignores a stale progress response after completion', async () => {
  const h = await harness({ clock: true, delayBrowserCheck: true, initialBrowserSession: makeBrowserSession({ status: 'login_required', canCollect: false }) })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('检测期间保留的未保存稿件')
    const video = await sourceVideoFromManuscript(page)
    await openMonitor(page)
    const login = page.getByRole('region', { name: '抖音采集登录' })
    await login.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await login.getByText('正在检测', { exact: true }).waitFor()
    const readsBeforeProgress = h.browserSessionReadCount()
    h.setBrowserSession(makeBrowserSession({
      status: 'checking', canCollect: false, checkedAt: null,
      checks: [{ at: '2026-10-15T01:00:30.000Z', stage: 'search_input', message: '已定位搜索输入框，准备提交' }],
    }))
    await page.clock.fastForward(4_500)
    await login.locator('summary').click()
    await login.getByText('已定位搜索输入框，准备提交', { exact: true }).waitFor()
    assert.ok(h.browserSessionReadCount() > readsBeforeProgress)
    assert.equal(h.browserCheckCount(), 1, 'progress polling must not start another detection')
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isDisabled(), true, 'Douyin collection waits for the in-flight detection to finish')

    h.setBrowserSessionFailure(true)
    await page.clock.fastForward(4_500)
    await login.getByRole('alert').filter({ hasText: '登录服务未连接' }).waitFor()
    h.setBrowserSessionFailure(false)

    h.delayNextBrowserSession()
    const nextProgressRead = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/history-scripts/browser-session' && request.method() === 'GET')
    await page.clock.fastForward(4_500)
    await nextProgressRead
    await page.waitForTimeout(50)
    assert.equal(h.delayedBrowserSessionCount(), 1)
    h.releaseDelayedBrowserCheck()
    await login.getByText('可以采集', { exact: true }).waitFor()
    h.releaseDelayedBrowserSession()
    await page.waitForTimeout(100)
    await login.getByText('可以采集', { exact: true }).waitFor()
    assert.equal(await login.getByRole('alert').count(), 0, 'a successful detection clears transient polling errors')
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 0)
    await closeMonitor(page)
    assert.equal(await editor.inputValue(), '检测期间保留的未保存稿件')
    assert.equal(await video.evaluate(element => element.isConnected), true)
  } finally { await h.browser.close() }
})

test('monitoring drawer scrolls independently without resizing the workspace on desktop and mobile', async () => {
  const h = await harness({
    initialJob: makeJob({ stage: 'waiting_login', events: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, createdAt: '2026-10-15T01:00:00.000Z', stage: 'waiting_login', level: 'info',
      message: `采集日志 ${index + 1}，等待登录检测后继续`,
    })) }),
    initialBrowserSession: makeBrowserSession({ status: 'blocked', canCollect: false, checks: Array.from({ length: 20 }, (_, index) => ({
      at: '2026-10-15T01:00:00.000Z', stage: 'video_results', message: `检测步骤 ${index + 1}，等待视频结果加载`,
    })) }),
  })
  try {
    const { page } = h
    for (const viewport of [{ width: 1440, height: 960 }, { width: 812, height: 768 }, { width: 375, height: 812 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(300)
      const workspaceBefore = await page.locator('.workspace').boundingBox()
      const monitor = await openMonitor(page)
      const drawerBox = await monitor.boundingBox()
      assert.equal(drawerBox.height, viewport.height)
      assert.equal(drawerBox.width, viewport.width <= 760 ? viewport.width : 520)
      await monitor.locator('summary').click()
      assert.equal(await monitor.locator('.monitor-body').evaluate(element => element.scrollHeight > element.clientHeight), true)
      await monitor.getByRole('tab', { name: '任务日志', exact: true }).click()
      assert.equal(await monitor.getByRole('list', { name: '任务日志记录' }).locator('li').count(), 100)
      assert.equal(await monitor.locator('.monitor-body').evaluate(element => element.scrollHeight > element.clientHeight), true)
      assert.deepEqual(await page.locator('.workspace').boundingBox(), workspaceBefore)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/monitor-${viewport.width}.png` })
      await closeMonitor(page)
      assert.equal(await page.getByRole('searchbox', { name: '搜索历史脚本', exact: true }).isVisible(), true)
      if (process.env.HISTORY_UI_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/workspace-${viewport.width}.png` })
    }
  } finally { await h.browser.close() }
})

test('a paused login job can be stopped and a successful login check cannot restart it', async () => {
  const h = await harness({
    initialJob: makeJob({ stage: 'waiting_login', targetCount: null }),
    initialBrowserSession: makeBrowserSession({ status: 'waiting_login', message: '等待登录抖音', canCollect: false }),
  })
  try {
    const { page } = h
    await page.getByText('已暂停采集 · 等待登录', { exact: true }).waitFor()
    const originalJobId = h.getJob().id
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.getByText('停止中 · 已停止', { exact: true }).waitFor()
    await openMonitor(page)
    await page.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await page.getByText('可以采集', { exact: true }).waitFor()
    assert.equal(h.getJob().id, originalJobId)
    assert.equal(h.getJob().status, 'stopping')
    assert.equal(h.stopCount(), 1)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('login detection cannot invalidate an in-flight stop request', async () => {
  const h = await harness({
    delayStop: true,
    initialJob: makeJob({ stage: 'waiting_login', targetCount: null }),
    initialBrowserSession: makeBrowserSession({ status: 'waiting_login', message: '等待登录抖音', canCollect: false }),
  })
  try {
    const { page } = h
    await page.getByText('已暂停采集 · 等待登录', { exact: true }).waitFor()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await openMonitor(page)
    await page.getByRole('button', { name: '检测登录状态', exact: true }).click()
    await page.getByText('可以采集', { exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.browser-session button[aria-busy="true"]'))
    h.setJob(makeJob({ ...h.getJob(), status: 'stopped', stage: 'stopped' }))
    h.releaseDelayedStop()
    await page.getByText('上次任务 · 已停止', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('starting with expired readiness automatically checks once before creating a job', async () => {
  const h = await harness({ initialBrowserSession: makeBrowserSession({ status: 'session_saved', canCollect: false }) })
  try {
    const { page } = h
    await page.getByRole('button', { name: '启动采集', exact: true }).click()
    await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    await page.getByRole('button', { name: '开始采集', exact: true }).click()
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 1)
    assert.equal(h.browserOpenCount(), 0)
    assert.deepEqual(h.startBody(), { targetCount: 1, categories: categoryValues, keywords: ['历史'] })
  } finally { await h.browser.close() }
})

test('failed automatic start checks create no jobs and reveal connection monitoring with settings retained', async () => {
  for (const failure of ['login_required', 'service']) {
    const message = failure === 'service' ? '登录检测服务暂时不可用' : '请先在专用浏览器登录抖音'
    const h = await harness({
      initialBrowserSession: makeBrowserSession({ status: 'session_saved', canCollect: false }),
      browserCheckResponse: makeBrowserSession({ status: 'login_required', canCollect: false, message }),
    })
    try {
      const { page } = h
      if (failure === 'service') h.setBrowserCheckFailure(true)
      await page.getByRole('button', { name: '启动采集', exact: true }).click()
      await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
      await page.locator('.job-dialog input[type="number"]').fill('25')
      assert.equal(await page.locator('.job-dialog input[type="checkbox"]').count(), 0)
      await page.getByRole('button', { name: '开始采集', exact: true }).click()
      await page.getByRole('dialog', { name: '启动历史素材采集' }).waitFor({ state: 'detached' })
      const monitor = page.getByRole('dialog', { name: '采集监控', exact: true })
      await monitor.waitFor()
      await monitor.getByText(message, { exact: true }).waitFor()
      assert.equal(await monitor.getByRole('tab', { name: '连接检测', exact: true }).getAttribute('aria-selected'), 'true')
      assert.equal(h.browserCheckCount(), 1)
      assert.equal(h.startCount(), 0)
      assert.equal(h.browserOpenCount(), 0)
      await closeMonitor(page)
      const start = page.getByRole('button', { name: '启动采集', exact: true })
      assert.equal(await start.evaluate(button => document.activeElement === button), true)
      await start.click()
      assert.equal(await page.locator('.job-dialog input[type="number"]').inputValue(), '25')
      assert.equal(await page.getByRole('combobox', { name: '采集来源' }).inputValue(), 'douyin')
    } finally { await h.browser.close() }
  }
})

test('starting with fresh readiness creates a job without another browser check', async () => {
  const h = await harness()
  try {
    const { page } = h
    await page.getByRole('button', { name: '启动采集', exact: true }).click()
    await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    await page.getByRole('button', { name: '开始采集', exact: true }).click()
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 0)
    assert.equal(h.startCount(), 1)
    assert.equal(h.browserOpenCount(), 0)
  } finally { await h.browser.close() }
})

test('duplicate begin clicks share one automatic check and create only one job', async () => {
  const h = await harness({ delayKeywords: true, delayBrowserCheck: true, initialBrowserSession: makeBrowserSession({ canCollect: false }) })
  try {
    const { page } = h
    await page.getByRole('button', { name: '启动采集', exact: true }).click()
    await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    const begin = page.getByRole('button', { name: '开始采集', exact: true })
    await page.getByText('正在读取关键词…', { exact: true }).waitFor()
    assert.equal(await begin.isDisabled(), true)
    assert.equal(h.browserCheckCount(), 0)
    assert.equal(h.startCount(), 0)
    h.releaseDelayedKeywords()
    await begin.click({ trial: true })
    await begin.evaluate(button => {
      button.click()
      button.click()
    })
    const checking = page.getByRole('button', { name: '正在检测连接', exact: true })
    await checking.waitFor()
    assert.equal(await checking.isDisabled(), true)
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 0)
    h.releaseDelayedBrowserCheck()
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    assert.equal(h.browserCheckCount(), 1)
    assert.equal(h.startCount(), 1)
  } finally { await h.browser.close() }
})

test('collection job dialog starts with bounded defaults and can be stopped', async () => {
  const h = await harness()
  try {
    const { page } = h
    await page.getByText('浏览采集未启动', { exact: true }).waitFor()
    await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).click()
    await page.getByRole('dialog', { name: '启动历史素材采集' }).waitFor()
    await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    await page.getByText('按关键词搜索 · 点赞至少1万 · 评论至少20', { exact: true }).waitFor()
    await page.getByText('视频与图文 · 时长不限', { exact: true }).waitFor()
    assert.equal(await page.locator('.job-dialog input[type="number"]').inputValue(), '1')
    assert.equal(await page.locator('.job-dialog input[type="checkbox"]').count(), 0)

    await page.getByRole('button', { name: '开始采集', exact: true }).click()
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    assert.equal(h.startCount(), 1)
    assert.deepEqual(h.startBody(), { targetCount: 1, categories: categoryValues, keywords: ['历史'] })
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isDisabled(), true)

    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.getByText('停止中 · 已停止', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '停止中', exact: true }).isDisabled(), true)
    assert.equal(h.stopCount(), 1)
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isDisabled(), true)
  } finally { await h.browser.close() }
})

test('quantity collection accepts and submits two-digit targets unchanged', async () => {
  for (const targetCount of [10, 25]) {
    const h = await harness()
    try {
      const { page } = h
      await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).click()
      await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
      await page.locator('.job-dialog input[type="number"]').fill(String(targetCount))
      await page.getByRole('button', { name: '开始采集', exact: true }).click()
      await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
      assert.deepEqual(h.startBody(), { targetCount, categories: categoryValues, keywords: ['历史'] })
      await page.getByText(`稿 0/${targetCount}`, { exact: true }).waitFor()
    } finally { await h.browser.close() }
  }
})

test('continuous collection submits null and remains monitorable after stopping and reloading', async () => {
  const h = await harness()
  try {
    const { page } = h
    await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).click()
    await page.getByRole('combobox', { name: '采集来源' }).selectOption('douyin')
    await page.getByRole('radio', { name: '持续采集', exact: true }).check()
    assert.equal(await page.locator('.job-dialog input[type="number"]').count(), 0)
    await page.getByText('持续采集到结果末尾；可手动停止，单篇失败后继续采集，环境或浏览故障会停止。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '开始采集', exact: true }).click()
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    assert.deepEqual(h.startBody(), { targetCount: null, categories: categoryValues, keywords: ['历史'] })
    await page.getByText('已入库 0 · 持续采集', { exact: true }).waitFor()

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('已入库 0 · 持续采集', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isDisabled(), true)
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.getByText('停止中 · 已停止', { exact: true }).waitFor()
    assert.equal(h.stopCount(), 1)

    h.setJob(makeJob({ ...h.getJob(), status: 'stopped', counts: { scanned: 130, selected: 10, completed: 10, failed: 0 } }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('上次任务 · 已停止', { exact: true }).waitFor()
    await page.getByText('已入库 10 · 持续采集', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '停止', exact: true }).count(), 0)
  } finally { await h.browser.close() }
})

test('collection dialog remains within narrow and short viewports in both modes', async () => {
  const h = await harness()
  try {
    const { page } = h
    await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).click()
    const dialog = page.getByRole('dialog', { name: '启动历史素材采集' })
    for (const [width, height] of [[320, 568], [812, 375]]) {
      await page.setViewportSize({ width, height })
      for (const mode of ['按数量', '持续采集']) {
        await page.getByRole('radio', { name: mode, exact: true }).check()
        const box = await dialog.boundingBox()
        assert.ok(box.x >= 16 && box.y >= 16)
        assert.ok(box.x + box.width <= width - 16)
        assert.ok(box.y + box.height <= height - 16, `${mode} dialog must fit ${width}x${height}`)
        await dialog.getByRole('button', { name: '开始采集', exact: true }).scrollIntoViewIfNeeded()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      }
    }
  } finally { await h.browser.close() }
})

test('job records show browser handoff, source links, errors and terminal logs', async () => {
  const h = await harness({
    initialJob: makeJob({
      status: 'interrupted',
      stage: 'waiting_browser',
      progressMessage: '需要完成抖音验证',
      errorMessage: '浏览器需要人工验证后继续',
      currentTitle: '武当山桃木剑当年是如何挂上去的',
      sourceIds: [101, 102],
      events: [
        { id: 1, createdAt: '2026-10-14T07:00:05.000Z', message: '开始检查浏览器', stage: 'checking', level: 'info' },
        { id: 2, createdAt: '2026-10-14T07:01:05.000Z', message: '等待抖音验证', stage: 'waiting_browser', level: 'warning' },
      ],
    }),
  })
  try {
    const { page } = h
    await page.getByText('上次任务 · 已中断', { exact: true }).waitFor()
    await openMonitor(page, '任务日志')
    await page.getByRole('alert').filter({ hasText: '浏览器需要人工验证后继续' }).waitFor()
    await page.getByRole('link', { name: /查看来源页面/ }).waitFor()
    await page.getByText('等待抖音验证', { exact: true }).waitFor()
    await page.getByRole('button', { name: /当前稿件 #101/ }).click()
    assert.equal(await page.getByRole('button', { name: /历史素材 101/ }).getAttribute('aria-pressed'), 'true')
  } finally { await h.browser.close() }
})

test('start dialog requires integer quantity and restores focus after escape', async () => {
  const h = await harness({ czgtsConfigured: true })
  try {
    const { page } = h
    const startButton = page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true })
    await startButton.click()
    const dialog = page.getByRole('dialog', { name: '启动历史素材采集' })
    await dialog.waitFor()
    assert.equal(await page.locator('.job-dialog input[type="number"]').evaluate(input => document.activeElement === input), true)
    const countInput = page.locator('.job-dialog input[type="number"]')
    const beginButton = page.getByRole('button', { name: '开始采集', exact: true })
    for (const invalidCount of ['', '0', '-1', '1.5', '10000']) {
      await countInput.fill(invalidCount)
      assert.equal(await beginButton.isDisabled(), true, `must reject ${JSON.stringify(invalidCount)}`)
    }
    await countInput.fill('9999')
    assert.equal(await beginButton.isEnabled(), true)
    await countInput.fill('1.5')
    await page.getByRole('radio', { name: '持续采集', exact: true }).check()
    assert.equal(await beginButton.isEnabled(), true)
    await page.getByRole('radio', { name: '按数量', exact: true }).check()
    assert.equal(await beginButton.isDisabled(), true)
    await countInput.fill('1')
    const closeButton = dialog.getByRole('button', { name: '关闭', exact: true })
    await closeButton.focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await beginButton.evaluate(button => document.activeElement === button), true)
    await page.keyboard.press('Tab')
    assert.equal(await closeButton.evaluate(button => document.activeElement === button), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await startButton.evaluate(button => document.activeElement === button), true)
    assert.equal(h.startCount(), 0)
  } finally { await h.browser.close() }
})

test('single-source failures remain running with a clear continuation label and warning log', async () => {
  const message = '来源 #101 二创稿件失败：模型请求超时；校对稿已保留，继续采集下一条'
  const h = await harness({ initialJob: makeJob({
    stage: 'source_failed', progressMessage: message, targetCount: null,
    counts: { scanned: 4, selected: 1, completed: 0, failed: 1 },
    events: [{ id: 1, createdAt: '2026-10-14T07:00:05.000Z', stage: 'source_failed', level: 'warning', message }],
  }) })
  try {
    const { page } = h
    const toolbar = page.getByRole('region', { name: '历史素材采集任务' })
    await toolbar.getByText('运行中 · 单篇失败，继续采集', { exact: true }).waitFor()
    assert.equal(await toolbar.getByRole('button', { name: '停止', exact: true }).isEnabled(), true)
    assert.equal(await toolbar.getByRole('button', { name: '查看任务失败详情', exact: true }).count(), 0)
    const monitor = await openMonitor(page)
    await monitor.getByRole('tab', { name: '任务日志', exact: true }).click()
    const logs = monitor.getByRole('list', { name: '任务日志记录' })
    await logs.getByText(message, { exact: true }).waitFor()
    await logs.getByText('单篇失败，继续采集', { exact: true }).waitFor()
    assert.equal(await monitor.getByRole('alert').count(), 0)
    assert.equal(h.getJob().status, 'running')
  } finally { await h.browser.close() }
})

test('job monitor labels incremental browsing stages and tolerates unknown stages', async () => {
  const h = await harness({ initialJob: makeJob({ stage: 'scrolling', targetCount: null }) })
  try {
    const { page } = h
    await page.getByText('运行中 · 滚动加载', { exact: true }).waitFor()
    for (const [stage, label] of [
      ['waiting_results', '等待新视频'],
      ['exhausted', '结果已耗尽'],
      ['future_stage', '准备中'],
    ]) {
      h.setJob(makeJob({ stage, targetCount: null }))
      await page.getByRole('button', { name: '刷新脚本库', exact: true }).click()
      await page.getByText(`运行中 · ${label}`, { exact: true }).waitFor()
      await page.getByText('已入库 0 · 持续采集', { exact: true }).waitFor()
    }
  } finally { await h.browser.close() }
})

test('stale polling responses cannot reverse a requested stop', async () => {
  const h = await harness({ clock: true, initialJob: makeJob(), delayFirstGetJob: true })
  try {
    const { page } = h
    await page.getByText('运行中 · 浏览抖音', { exact: true }).waitFor()
    await page.clock.fastForward(4_500)
    await page.waitForFunction(() => document.body.textContent.includes('运行中 · 浏览抖音'))
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.getByText('停止中 · 已停止', { exact: true }).waitFor()
    h.setJob(makeJob({ status: 'running', stage: 'browsing', progressMessage: '旧轮询结果' }))
    h.releaseDelayedGetJob()
    await page.waitForTimeout(100)
    await page.getByText('停止中 · 已停止', { exact: true }).waitFor()
  } finally { await h.browser.close() }
})

test('job polling completion refreshes the list without replacing the open draft or video', async () => {
  const h = await harness({ clock: true, initialJob: makeJob() })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('正在人工修改的版本')
    const video = await sourceVideoFromManuscript(page)
    const videoSrc = await video.getAttribute('src')
    assert.ok(videoSrc.endsWith('/api/v1/history-scripts/101/video'))

    h.sources.push(fixture(102, { title: '新入库素材 102' }))
    h.setJob(makeJob({
      status: 'completed',
      stage: 'completed',
      progressMessage: '已保存 1 条历史脚本',
      counts: { scanned: 12, selected: 2, completed: 1, failed: 0 },
      completedAt: '2026-10-14T07:04:00.000Z',
    }))
    await page.clock.fastForward(4_500)
    await page.getByText('新入库素材 102', { exact: true }).waitFor()

    assert.equal(await editor.inputValue(), '正在人工修改的版本')
    assert.equal(await video.evaluate(element => element === document.querySelector('video.source-video')), true)
    assert.equal(await page.locator('video.source-video').getAttribute('src'), videoSrc)
    assert.equal(await page.getByRole('button', { name: /历史素材 101/ }).getAttribute('aria-pressed'), 'true')
    assert.ok(h.getJobCount() >= 1)
  } finally { await h.browser.close() }
})

test('running continuous jobs reveal new scripts without replacing an open draft or video', async () => {
  const initialJob = makeJob({ targetCount: null, sourceIds: [101, 102] })
  const h = await harness({ clock: true, initialJob })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('持续采集中正在人工修改的版本')
    const video = await sourceVideoFromManuscript(page)
    const videoSrc = await video.getAttribute('src')

    h.sources.push(fixture(102, { title: '持续入库素材 102' }))
    h.setJob(makeJob({
      ...initialJob,
      counts: { scanned: 12, selected: 2, completed: 1, failed: 0 },
    }))
    await page.clock.fastForward(4_500)
    await page.getByText('持续入库素材 102', { exact: true }).waitFor()
    await page.getByText('已入库 1 · 持续采集', { exact: true }).waitFor()

    h.sources.push(fixture(103, { title: '新增来源素材 103' }))
    h.setJob(makeJob({
      ...h.getJob(),
      sourceIds: [101, 102, 103],
      counts: { scanned: 20, selected: 3, completed: 1, failed: 0 },
    }))
    await page.clock.fastForward(4_500)
    await page.getByText('新增来源素材 103', { exact: true }).waitFor()

    assert.equal(await editor.inputValue(), '持续采集中正在人工修改的版本')
    assert.equal(await video.evaluate(element => element.isConnected), true)
    assert.equal(await page.locator('video.source-video').getAttribute('src'), videoSrc)
    assert.equal(await page.getByRole('button', { name: /历史素材 101/ }).getAttribute('aria-pressed'), 'true')

    const listCount = h.listCount()
    h.setJob(makeJob({
      ...h.getJob(),
      counts: { scanned: 30, selected: 3, completed: 1, failed: 0 },
    }))
    await page.clock.fastForward(4_500)
    await page.waitForTimeout(100)
    assert.equal(h.listCount(), listCount, 'scanning alone must not reload the source list')
  } finally { await h.browser.close() }
})

test('job status failure disables new starts and retry restores controls', async () => {
  const h = await harness({ failJobs: true })
  try {
    const { page } = h
    await page.getByText('任务状态连接异常', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isDisabled(), true)
    await openMonitor(page, '任务日志')
    await page.getByRole('alert').filter({ hasText: '任务服务暂不可用' }).waitFor()
    await closeMonitor(page)
    h.setJobsFailure(false)
    await page.getByRole('button', { name: '重试状态', exact: true }).click()
    await page.getByText('浏览采集未启动', { exact: true }).waitFor()
    await page.getByRole('button', { name: '启动采集', exact: true }).click({ trial: true })
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true, includeHidden: true }).isEnabled(), true)
  } finally { await h.browser.close() }
})

function batchOutcomeFixture() {
  return {taskId:40332,total:4,offset:0,limit:50,hasMore:false,
    summary:{draftsReady:4,producedVideos:8,expectedVideos:8,publishedVideos:8,recoveredSources:2,releasedVideos:8},
    items:[898,899,900,901].map(id=>({sourceId:id,title:`历史稿件 ${id}`,deleted:false,collectedInBatch:id>=900,
      recovered:id<900,reviewStatus:'needs_review',draftState:'current',sourceMediaReleased:true,publicationComplete:true,
      historicalFailure:id<900?{message:id===898?'二创引文校验未通过':'服务商 HTTP 429 限流'}:null,health:[],
      versions:['huasheng','motion'].map((producer,index)=>({key:`${id}:${producer}`,producer,state:'published',
        videoId:id*2+index,jobId:`${id*3+index}`,localMedia:'released',publicationUrl:`https://baijiahao.baidu.com/builder/preview/s?id=${1880000+id*2+index}`}))}))}
}

for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
  test(`batch results show recovered drafts and both published editions at ${viewport.width}px without starting production`, async()=>{
    const h=await harness({viewport,initialJob:makeJob({id:'40332',status:'completed',stage:'completed',targetCount:2,
      sourceIds:[898,899,900,901],counts:{scanned:533,selected:4,completed:2,failed:2}}),batchOutcomes:batchOutcomeFixture()})
    try {
      const drawer=await openMonitor(h.page,'任务日志')
      const results=drawer.getByRole('region',{name:'批次生产结果',exact:true})
      await results.getByText('4 份稿件',{exact:true}).waitFor()
      assert.equal(await results.locator('.outcome-source').count(),4)
      assert.equal(await results.getByText('已发表',{exact:true}).count(),8)
      assert.equal(await results.getByText('本地已回收',{exact:true}).count(),8)
      assert.equal(await results.getByText('审稿待审',{exact:true}).count(),4)
      await results.getByRole('combobox',{name:'筛选批次稿件'}).selectOption('collected')
      assert.deepEqual(await results.locator('.outcome-source').evaluateAll(nodes=>nodes.map(node=>node.dataset.sourceId)),['900','901'])
      await results.getByRole('combobox',{name:'筛选批次稿件'}).selectOption('recovered')
      await results.getByText('已恢复的采集错误',{exact:true}).first().click()
      await results.getByText('二创引文校验未通过',{exact:true}).waitFor()
      assert.deepEqual(await results.locator('.outcome-source').evaluateAll(nodes=>nodes.map(node=>node.dataset.sourceId)),['898','899'])
      assert.equal(h.startCount(),0);assert.deepEqual(h.resumeIds,[])
      const overflow=await results.evaluate(element=>element.scrollWidth>element.clientWidth+1)
      assert.equal(overflow,false,'batch results must fit inside the monitor on mobile and desktop')
      const overlapping=await results.locator('.outcome-version').evaluateAll(rows=>rows.some(row=>{
        const rects=[...row.children].map(child=>child.getBoundingClientRect()).filter(rect=>rect.width&&rect.height)
        return rects.some((rect,index)=>rects.slice(index+1).some(other=>Math.min(rect.right,other.right)-Math.max(rect.left,other.left)>1
          &&Math.min(rect.bottom,other.bottom)-Math.max(rect.top,other.top)>1))
      }))
      assert.equal(overlapping,false,'edition labels, state, media status and links must not overlap')
      assert.deepEqual(h.pageErrors,[])
      if(process.env.HISTORY_UI_SCREENSHOT_DIR) {
        await results.locator('.outcome-heading').scrollIntoViewIfNeeded()
        await h.page.screenshot({path:`${process.env.HISTORY_UI_SCREENSHOT_DIR}/batch-results-${viewport.width}.png`})
      }
    } finally { await h.browser.close() }
  })
}

test('batch results retry a read failure without resuming or starting any source',async()=>{
  const h=await harness({initialJob:makeJob({id:'40332',status:'completed'}),batchOutcomes:batchOutcomeFixture(),failBatchOutcomes:true})
  try {
    const drawer=await openMonitor(h.page,'任务日志'), results=drawer.getByRole('region',{name:'批次生产结果',exact:true})
    await results.getByRole('alert').filter({hasText:'批次结果暂不可用'}).waitFor()
    h.setBatchOutcomesFailure(false)
    await results.getByRole('button',{name:'刷新批次结果',exact:true}).click()
    await results.getByText('4 份稿件',{exact:true}).waitFor()
    assert.equal(h.startCount(),0);assert.deepEqual(h.resumeIds,[])
  } finally { await h.browser.close() }
})
