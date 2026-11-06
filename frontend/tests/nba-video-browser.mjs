import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const origin = process.env.NBA_WORKBENCH_URL || 'http://localhost:3013'
const queuesOnly = process.argv.includes('--queues-only')
const artifacts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), queuesOnly ? '../../outputs/nba-independent-queues-20261105/browser' : '../../outputs/nba-video-workflow-validation-20261104/browser')
await fs.mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })

async function verifyIndependentQueues() {
  const fixturePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const fixtureErrors = [], requests = []
  const stamp = '2026-11-05T10:00:00Z'
  const makeRun = (id, kind, jobIds, status = 'running') => ({ id, kind, jobIds, status, message: kind === 'collect' ? '正在采集新闻正文' : '正在混合旁白与球场声音', createdAt: stamp, updatedAt: stamp, excluded: [], sources: [] })
  const jobs = ['first', 'second', 'third'].map(id => ({ id, title: `新闻 ${id}`, article: { id: `article-${id}`, title: `新闻 ${id}`, language: 'en', publisher: 'Fixture News', wordCount: 200, body: 'Original news. '.repeat(100), url: `https://example.test/${id}` }, status: id === 'first' ? 'running' : 'queued', stage: 'media', canResume: id !== 'first', canUpload: false, message: '等待制作', createdAt: stamp, updatedAt: stamp, assets: {}, uploads: [], logs: [] }))
  const production = makeRun('produce-one', 'produce', ['first'])
  const queued = makeRun('produce-two', 'produce', ['second'], 'queued')
  const state = { settings: { youtubeChannels: ['https://www.youtube.com/@NBA/videos'], videosPerChannel: 20, languages: ['en', 'zh'], limit: 6, autoProduce: true, autoUpload: false, scheduleEnabled: false, intervalMinutes: 60, voice: 'longanhuan_v3.1', speed: 1.05, originalGain: 0.32, arenaGain: 0.85 }, jobs, matches: [], runs: [queued, production], activeRun: production, activeCollection: null, activeProcessing: production, queuedProcessing: [queued], uploadAccount: null, stats: { total: 3, completed: 0, resumable: 2, running: 1 } }
  fixturePage.on('pageerror', error => fixtureErrors.push(error.message))
  await fixturePage.route('**/api/v1/nba-video**', async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname.replace('/api/v1/nba-video', '')
    let data = state
    if (request.method() === 'GET' && endpoint.startsWith('/jobs/')) data = jobs.find(job => job.id === endpoint.split('/')[2])
    else if (request.method() === 'POST') {
      requests.push({ endpoint, body: request.postDataJSON() })
      if (endpoint === '/runs') {
        data = makeRun('collect-one', 'collect', [])
        state.activeCollection = data; state.activeRun = data; state.runs.unshift(data)
      } else if (endpoint === '/resume') {
        data = makeRun('resume-one', 'resume', request.postDataJSON().jobIds, 'queued')
        state.queuedProcessing.push(data); state.runs.unshift(data)
      } else if (endpoint.endsWith('/stop')) {
        const id = endpoint.split('/')[2]
        data = state.runs.find(run => run.id === id)
        data.status = 'stopped'
        if (state.activeCollection?.id === id) state.activeCollection = null
        if (state.activeProcessing?.id === id) state.activeProcessing = null
        state.queuedProcessing = state.queuedProcessing.filter(run => run.id !== id)
        state.activeRun = state.activeCollection || state.activeProcessing
      } else throw Error(`Unexpected mocked NBA mutation ${endpoint}`)
    }
    await route.fulfill({ json: { code: 200, message: 'success', data } })
  })
  try {
    await fixturePage.goto(`${origin}/nba-video`, { waitUntil: 'domcontentloaded' })
    await fixturePage.locator('.queue-run[aria-label="制作队列"]').waitFor()
    assert.equal(await fixturePage.getByRole('button', { name: '批量采集', exact: true }).first().isEnabled(), true)
    assert.equal(await fixturePage.getByRole('button', { name: '停止制作', exact: true }).isEnabled(), true)
    assert.equal(await fixturePage.locator('.queued-count').innerText(), '等待 1 批')
    await fixturePage.getByRole('button', { name: '批量采集', exact: true }).first().click()
    await fixturePage.getByRole('button', { name: '开始采集', exact: true }).click()
    await fixturePage.getByRole('button', { name: '停止采集', exact: true }).waitFor()
    assert.equal(await fixturePage.getByRole('button', { name: '批量采集', exact: true }).first().isDisabled(), true)
    assert.equal(state.activeProcessing.id, production.id)
    await fixturePage.getByRole('checkbox', { name: '选择任务：新闻 third', exact: true }).check()
    await fixturePage.getByRole('button', { name: /续做所选/ }).click()
    await fixturePage.waitForFunction(() => document.querySelector('.queued-count')?.textContent === '等待 2 批')
    await fixturePage.screenshot({ path: path.join(artifacts, 'independent-desktop.png'), fullPage: true })
    await fixturePage.setViewportSize({ width: 390, height: 844 })
    assert.equal(await fixturePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await fixturePage.screenshot({ path: path.join(artifacts, 'independent-mobile.png'), fullPage: true })
    await fixturePage.getByRole('button', { name: '停止采集', exact: true }).click()
    assert.equal(state.activeCollection, null)
    assert.equal(state.activeProcessing.id, production.id)
    await fixturePage.locator('.pending-runs li').filter({ hasText: '续做已有任务' }).getByRole('button', { name: '停止排队任务', exact: true }).click()
    assert.equal(state.queuedProcessing.length, 1)
    await fixturePage.getByRole('button', { name: '停止制作', exact: true }).click()
    assert.equal(state.activeProcessing, null)
    assert.deepEqual(requests.map(request => request.endpoint), ['/runs', '/resume', '/runs/collect-one/stop', '/runs/resume-one/stop', '/runs/produce-one/stop'])
    assert.deepEqual(fixtureErrors, [])
    await fs.writeFile(path.join(artifacts, 'independent-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), mockedMutations: requests, errors: fixtureErrors, mobileOverflow: false }, null, 2) + '\n')
    console.log(JSON.stringify({ independentQueues: 'passed', mockedMutations: requests.length, artifacts, errors: fixtureErrors }))
  } finally { await fixturePage.close() }
}

if (queuesOnly) {
  try { await verifyIndependentQueues() } finally { await browser.close() }
  process.exit(0)
}
const errors = [], checks = [], mutations = []
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => { if (request.url().includes('/api/v1/nba-video') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push({ method: request.method(), url: request.url() }) })
const json = async url => {
  const response = await page.request.get(`${origin}${url}`)
  assert.equal(response.status(), 200)
  return (await response.json()).data
}
try {
  await page.goto(`${origin}/nba-video`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'NBA 视频工厂', exact: true }).waitFor()
  await page.locator('.queue-list li').first().waitFor()
  const overview = await json('/api/v1/nba-video')
  assert.ok(overview.stats.completed >= 3)
  const finished = overview.jobs.find(job => job.delivery?.verification?.importedExistingDelivery)
  assert.ok(finished)
  await page.locator('.queue-item').filter({ hasText: finished.title }).click()
  await page.waitForFunction(() => { const v = document.querySelector('#nba-panel-output video'); return v && v.readyState >= 2 && v.videoWidth > 0 })
  await page.locator('#nba-panel-output video').evaluate(async video => { video.muted = true; video.currentTime = 2; await video.play() })
  await page.waitForFunction(() => document.querySelector('#nba-panel-output video')?.currentTime > 2.3)
  const video = await page.locator('#nba-panel-output video').evaluate(element => {
    element.pause()
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 54
    const ctx = canvas.getContext('2d'); ctx.drawImage(element, 0, 0, 96, 54)
    const pixels = ctx.getImageData(0, 0, 96, 54).data
    let mean = 0, square = 0
    for (let i = 0; i < pixels.length; i += 4) { const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3; mean += value; square += value * value }
    mean /= pixels.length / 4
    return { width: element.videoWidth, height: element.videoHeight, duration: element.duration, mean, variance: square / (pixels.length / 4) - mean * mean }
  })
  assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.ok(video.mean > 10 && video.variance > 100)
  checks.push({ check: '真实1080p成片加载、播放与像素检查', ...video })
  await page.screenshot({ path: path.join(artifacts, 'desktop.png') })
  await page.locator('#nba-panel-output .upload-section').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(artifacts, 'desktop-upload.png') })
  await page.getByRole('tab', { name: '原文与中文稿', exact: true }).click()
  assert.ok((await page.locator('.article-section .article-body').innerText()).split(/\s+/).length >= 100)
  assert.ok((await page.locator('.script-section .article-body').innerText()).match(/\p{Script=Han}/gu).length >= 100)
  checks.push({ check: '英文全文与独立中文稿', passed: true })
  await page.getByRole('tab', { name: '比赛素材', exact: true }).click()
  assert.ok((await page.locator('.game-facts').innerText()).includes('America/New_York'))
  assert.ok((await page.locator('.scoreboard').innerText()).includes('117'))
  assert.ok(overview.uploadAccount)
  assert.ok((await page.locator('.collection-strip .account-state').innerText()).includes(overview.uploadAccount.label))
  assert.ok((await page.locator('#nba-panel-output .upload-account-line').innerText()).includes('与 CBA 共用'))
  for (const receipt of await page.locator('#nba-panel-output .upload-records li').all()) {
    if (!await receipt.locator('a').count()) continue
    assert.ok((await receipt.innerText()).includes('草稿已保存'))
    assert.ok(['http:', 'https:'].includes(new URL(await receipt.locator('a').getAttribute('href')).protocol))
  }
  checks.push({ check: '共用 CBA 百家号账号与独立草稿状态展示', account: overview.uploadAccount.label, uploaded: finished.uploaded })
  await page.getByRole('button', { name: '采集与制作设置', exact: true }).click()
  await page.locator('dialog[open]').waitFor()
  assert.equal(await page.getByLabel('开启定时采集', { exact: true }).isChecked(), overview.settings.scheduleEnabled)
  assert.equal(await page.getByLabel('每频道扫描视频数', { exact: true }).inputValue(), String(overview.settings.videosPerChannel))
  assert.equal(await page.getByLabel('制作后上传百家号', { exact: true }).isChecked(), overview.settings.autoUpload)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('dialog[open]'))
  checks.push({ check: '默认频道扫描、自动上传与定时设置读取', passed: true })
  await page.getByRole('button', { name: /^频道管理/ }).click()
  await page.locator('dialog[open]').waitFor()
  assert.equal(await page.locator('.channel-row').count(), overview.settings.youtubeChannels.length)
  for (const [index, channel] of overview.settings.youtubeChannels.entries()) assert.equal(await page.getByLabel(`NBA YouTube 频道 ${index + 1}`, { exact: true }).inputValue(), channel)
  assert.equal(await page.getByRole('button', { name: '保存频道列表', exact: true }).isDisabled(), true)
  if (overview.settings.youtubeChannels.length < 30) {
    await page.getByRole('button', { name: '添加频道', exact: true }).click()
    await page.getByLabel(`NBA YouTube 频道 ${overview.settings.youtubeChannels.length + 1}`, { exact: true }).fill('https://www.youtube.com/watch?v=vDdPLHaKK4k')
    await page.getByRole('status').filter({ hasText: '不能使用单条视频链接' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '保存频道列表', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: `删除频道 ${overview.settings.youtubeChannels.length + 1}`, exact: true }).click()
  }
  await page.screenshot({ path: path.join(artifacts, 'channels-desktop.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  checks.push({ check: '频道管理读取、单视频拒绝与取消保留配置', channels: overview.settings.youtubeChannels.length })
  const asset = await page.request.get(`${origin}${finished.assets.video}`, { headers: { Range: 'bytes=0-31' } })
  assert.equal(asset.status(), 206); assert.equal((await asset.body()).length, 32)
  const subtitles = await page.request.get(`${origin}${finished.assets.subtitles}`)
  assert.equal(subtitles.status(), 200); assert.ok((await subtitles.text()).includes('-->'))
  checks.push({ check: '真实范围播放与字幕下载', passed: true })
  const batchButton = page.getByRole('button', { name: '批量采集', exact: true }).first()
  if (await batchButton.isEnabled()) {
    await batchButton.click()
    assert.equal(await page.getByRole('button', { name: '频道批量采集', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByLabel('每频道扫描视频数', { exact: true }).inputValue(), String(overview.settings.videosPerChannel))
    assert.equal(await page.getByLabel('新闻链接', { exact: false }).count(), 0)
    await page.screenshot({ path: path.join(artifacts, 'batch-collection.png') })
    await page.getByRole('button', { name: '手动采集', exact: true }).click()
    await page.getByLabel('新闻链接', { exact: false }).fill('https://www.espn.com/nba/recap?gameId=401909907')
    await page.getByLabel('采集数量', { exact: true }).fill('1')
    await page.getByLabel('比赛日期', { exact: false }).fill('2026-11-02')
    await page.getByLabel('ESPN 比赛编号', { exact: false }).fill('401909907')
    await page.getByLabel('中文', { exact: true }).uncheck()
    await page.getByLabel('采集后自动制作', { exact: true }).uncheck()
    await page.getByLabel('制作后上传百家号', { exact: true }).uncheck()
    assert.equal(await page.getByRole('button', { name: '开始采集', exact: true }).isEnabled(), true)
    await page.screenshot({ path: path.join(artifacts, 'collection.png') })
    await page.getByRole('button', { name: '取消', exact: true }).click()
    checks.push({ check: '默认频道采集与完整手动采集表单切换，只读检查未提交', passed: true })
  } else {
    checks.push({ check: '正在运行时禁止启动新批次', activeRunId: overview.activeRun?.id, passed: true })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${origin}/nba-video`, { waitUntil: 'domcontentloaded' })
  await page.locator('.queue-list li').first().waitFor()
  await page.screenshot({ path: path.join(artifacts, 'mobile-queue.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('.queue-item').filter({ hasText: finished.title }).click()
  await page.locator('.back-button').waitFor({ state: 'visible' })
  await page.waitForFunction(() => { const v = document.querySelector('#nba-panel-output video'); return v && v.readyState >= 2 })
  await page.locator('#nba-panel-output video').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(artifacts, 'mobile-detail.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('tab', { name: '比赛素材', exact: true }).click()
  await page.screenshot({ path: path.join(artifacts, 'mobile-materials.png') })
  await page.getByRole('button', { name: '新闻任务', exact: true }).click()
  await page.locator('.queue-pane').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: /^频道管理/ }).click()
  await page.locator('dialog[open]').waitFor()
  assert.equal(await page.evaluate(() => document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth), true)
  await page.screenshot({ path: path.join(artifacts, 'mobile-channels.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '运行记录', exact: true }).click()
  await page.locator('dialog[open]').waitFor()
  assert.equal(await page.evaluate(() => document.querySelector('dialog[open]').getBoundingClientRect().width <= innerWidth), true)
  await page.screenshot({ path: path.join(artifacts, 'mobile-runs.png') })
  checks.push({ check: '390px手机队列、详情、素材、频道管理与运行记录，无页面横向溢出', passed: true })
  assert.deepEqual(errors, [])
  assert.deepEqual(mutations, [])
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), origin, checks, errors, mutations }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: checks.length, artifacts, errors }))
} finally { await browser.close() }
