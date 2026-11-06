import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const timestamp = '2026-10-22T01:00:00.000Z'
const workspaceNames = ['视频制作', '稿件库', '百家号发表', '采集任务']
const detailNames = ['文稿', '花生制作', '精细化制作', '成片与封面', '百家号发表', '来源与审阅']
const draft = '  尚未保存的人工稿件\n\n第二段保留空格与标点。  \n末段\t待审。\n'

function source(id, title) {
  return {
    id, title, authorName: `作者 ${id}`, category: 'historical_anecdote', status: 'needs_review',
    sourceUrl: `https://www.douyin.com/video/${id}`, rawTranscript: `原始转写 ${id}。`,
    correctedTranscript: `校对后的史料 ${id}。`, rewrittenScript: `数据库中的稿件 ${id}。`,
    revision: `revision-${id}`, updatedAt: timestamp, metricsJson: '{"comments":37,"likes":12000}',
    mediaJson: '{"probe":{"duration":612}}', selectionJson: '{}',
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', factualConcerns: [{ claim: `史料疑点 ${id}`, reason: '需要核查原始史料' }] }),
    videoAvailable: true, artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
  }
}

async function harness(options = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 960 } })
  page.setDefaultTimeout(6000)
  if (options.clock) await page.clock.install()
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseUrl).origin ? route.continue() : route.abort('blockedbyclient'))
  const sources = [source(101, '宋朝租房与百姓生活'), source(102, '明朝工钱与官房月租的史料对照')]
  const productionJobs = Array.isArray(options.productionJobs) ? options.productionJobs : options.productionJobs ? sources.map(item => ({
    id: `production-${item.id}`, sourceId: item.id, title: item.title,
    status: 'submitted', stage: 'submitted', message: '已提交制作',
    projectUrl: null, videoUrl: null, error: null, createdAt: timestamp, updatedAt: timestamp,
    scriptSha256: createHash('sha256').update(item.rewrittenScript).digest('hex'),
    productionStatus: 'completed', productionCheckedAt: timestamp,
    productionMessage: '创作完成', productionCheckError: null,
  })) : []
  const deliveries = new Map(sources.map(item => [item.id, {
    title: `已保存的封面 ${item.id}`, baijiahaoTitle: `已保存的百家号标题 ${item.id}`, description: `简介 ${item.id}`,
    covers: {}, coverStatus: 'idle', coverPlanStatus: 'missing', coverPlan: null,
    designStatus: options.busyOutputs ? 'generating' : 'idle', designRunId: options.busyOutputs ? `design-${item.id}` : null,
    coverDesign: { main_title: `已保存的封面 ${item.id}`, sub_title: '', kicker: '', ai_prompt: `历史场景 ${item.id}` },
  }]))
  const articles = new Map(sources.map(item => [item.id, {
    status: options.busyOutputs ? 'generating' : 'completed', error: null, stale: false, staleReasons: [],
    canGenerate: !options.busyOutputs, unavailableReason: null,
    article: { title: `公众号文章 ${item.id}`, sourceLength: 3200, articleLength: 1600,
      markdown: `# 公众号文章 ${item.id}\n\n史料因果关系 ${item.id}。`,
      html: `<p>史料因果关系 ${item.id}。</p>`, screenshots: [], notices: [] },
  }]))
  const job = {
    id: '40001', status: 'running', stage: 'browsing', targetCount: null,
    counts: { scanned: 4, selected: 1, completed: 0, failed: 0 }, sourceIds: [101], events: [],
    currentSourceId: 101, currentTitle: sources[0].title,
    startedAt: timestamp, updatedAt: timestamp, progressMessage: '正在浏览历史素材',
    ...options.job,
  }
  const reads = new Map()
  const writes = []
  const unexpected = []
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), path, body: request.postData() })
      return route.fulfill({ status: 405, json: { code: 405, message: '此场景只允许读取模拟接口' } })
    }
    reads.set(path, (reads.get(path) || 0) + 1)
    let data
    if (path === '/api/v1/history-scripts') {
      const q = url.searchParams.get('q') || ''
      const filtered = sources.filter(item => item.title.includes(q))
      data = { items: filtered, total: filtered.length }
    } else if (path === '/api/v1/history-scripts/jobs') data = { job, recent: [job], total: 1, hasMore: false }
    else if (path === `/api/v1/history-scripts/jobs/${job.id}`) data = { job }
    else if (path === `/api/v1/history-scripts/jobs/${job.id}/events`) data = { items: [], total: 0, hasMore: false }
    else if (path === '/api/v1/history-scripts/browser-session') data = { session: { status: 'ready', canCollect: true, checkedAt: timestamp, checks: [] } }
    else if (path === '/api/v1/history-scripts/huasheng') data = { enabled: false, browser: { status: 'ready', message: '测试连接已就绪' }, productionChecking: false, jobs: productionJobs }
    else if (path === '/api/v1/history-scripts/huasheng/exports') data = options.exports || { enabled: false, jobs: [] }
    else if (/^\/api\/v1\/history-scripts\/motion\/(?:jobs|\d+)$/.test(path)) data = { jobs: [] }
    else if (path === '/api/v1/history-scripts/uploads/runtime') data = { installed: true, version: 'mock', message: '测试环境', platforms: { baijiahao: { ready: true, message: '已就绪' }, tencent: { ready: true, message: '已就绪' } } }
    else if (path === '/api/v1/history-scripts/uploads/jobs') data = { jobs: [] }
    else if (path === '/api/v1/history-scripts/uploads/candidates') data = { items: sources.map(item => ({ scriptId: item.id, title: item.title })) }
    else {
      const match = /^\/api\/v1\/history-scripts\/(\d+)(?:\/(video|delivery|article|huasheng|continuation))?$/.exec(path)
      const item = match && sources.find(item => item.id === Number(match[1]))
      if (item) {
        if (match[2] === 'video') return route.fulfill({ contentType: 'video/mp4', body: '' })
        data = match[2] === 'delivery' ? deliveries.get(item.id)
          : match[2] === 'article' ? articles.get(item.id)
            : match[2] === 'continuation' ? { task: null, complete: false }
            : match[2] === 'huasheng' ? { jobs: productionJobs.filter(job => job.sourceId === item.id), productionChecking: false } : item
      }
    }
    if (data === undefined) {
      unexpected.push(path)
      return route.fulfill({ status: 404, json: { code: 404, message: `Unexpected mocked API: ${path}` } })
    }
    return route.fulfill({ json: { code: 200, data, message: 'success' } })
  })
  try {
    await page.goto(`${baseUrl}${options.path || '/history-scripts?view=library'}`, { waitUntil: 'domcontentloaded' })
    await page.locator('#rewritten-script').waitFor({ state: 'attached' })
  } catch (error) { await browser.close(); throw error }
  return { browser, page, sources, job, deliveries, articles, reads, writes, unexpected }
}

function workspaceTab(page, name) {
  return page.getByRole('tablist', { name: '历史脚本工作区', exact: true }).getByRole('tab', { name: new RegExp(`^${name}`) })
}

async function openWorkspace(page, name) {
  await workspaceTab(page, name).click()
  const view = { 视频制作: 'production', 稿件库: 'library', 百家号发表: 'uploads', 采集任务: 'collection' }[name]
  await page.waitForURL(url => url.searchParams.get('view') === view, { waitUntil: 'domcontentloaded' })
}

async function openDetail(page, name) {
  const tab = page.getByRole('tablist', { name: '稿件内容', exact: true }).getByRole('tab', { name: new RegExp(`^${name}`) })
  await tab.click()
  await page.locator(`#${await tab.getAttribute('aria-controls')}`).waitFor()
}

async function selectSecond(page) {
  await page.locator('.source-item').filter({ hasText: '明朝工钱' }).click()
  await page.getByRole('heading', { name: '明朝工钱与官房月租的史料对照', exact: true }).waitFor()
}

async function assertDraft(h, editor, video) {
  assert.equal(await h.page.getByRole('textbox', { name: '编辑待审稿', exact: true }).inputValue(), draft)
  assert.equal(await editor.evaluate(element => element === document.querySelector('#rewritten-script')), true)
  assert.equal(await video.evaluate(element => element === document.querySelector('video.source-video')), true)
  assert.equal(await video.getAttribute('src'), '/api/v1/history-scripts/102/video')
  assert.equal(await h.page.locator('.summary-copy .script-id').textContent(), '脚本 #102')
  assert.equal(new URL(h.page.url()).searchParams.get('script'), '102')
  assert.equal(h.sources[1].rewrittenScript, '数据库中的稿件 102。')
  assert.deepEqual(h.writes, [])
  assert.deepEqual(h.unexpected, [])
}

test('the default production dashboard survives reload while legacy script links and explicit library links open manuscripts', async () => {
  const h = await harness({ path: '/history-scripts' })
  try {
    const { page } = h
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      await page.getByRole('region', { name: '花生自动制作', exact: true }).waitFor()
      assert.equal(await workspaceTab(page, '视频制作').getAttribute('aria-selected'), 'true')
      assert.equal(await page.locator('#rewritten-script').isVisible(), false)
    }
    await page.goto(`${baseUrl}/history-scripts?script=102`)
    await page.getByRole('textbox', { name: '编辑待审稿', exact: true }).waitFor()
    assert.equal(await workspaceTab(page, '稿件库').getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('.summary-copy .script-id').textContent(), '脚本 #102')
    await openWorkspace(page, '视频制作')
    assert.equal(new URL(page.url()).searchParams.get('script'), '102')
    await openWorkspace(page, '稿件库')
    assert.equal(new URL(page.url()).searchParams.get('view'), 'library')
    assert.equal(await page.locator('#rewritten-script').inputValue(), '数据库中的稿件 102。')
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.unexpected, [])
  } finally { await h.browser.close() }
})

test('production and collection tabs preserve the exact unsaved manuscript, media identity and title search without changing the selected record', async () => {
  const h = await harness()
  try {
    const { page } = h
    await selectSecond(page)
    const search = page.getByRole('searchbox', { name: '搜索历史脚本', exact: true })
    const filtered = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/v1/history-scripts' && url.searchParams.get('q') === '宋朝'
    })
    await search.fill('宋朝')
    await filtered
    await page.locator('.source-item').filter({ hasText: '明朝工钱' }).waitFor({ state: 'detached' })
    const editor = await page.locator('#rewritten-script').elementHandle()
    await editor.fill(draft)
    await openDetail(page, '来源与审阅')
    const video = await page.locator('video.source-video').elementHandle()
    await openDetail(page, '文稿')
    for (const view of ['视频制作', '百家号发表', '采集任务']) {
      await openWorkspace(page, view)
      assert.equal(await editor.isVisible(), false)
      assert.equal(await editor.evaluate(element => element.isConnected), true)
      await openWorkspace(page, '稿件库')
      await assertDraft(h, editor, video)
      assert.equal(await search.inputValue(), '宋朝')
      assert.equal(await page.locator('.source-item').count(), 1)
      assert.equal(await page.locator('.source-item[aria-pressed="true"]').count(), 0, 'the filtered list must not select a replacement record')
    }
    page.once('dialog', dialog => dialog.dismiss())
    await page.locator('.source-item').filter({ hasText: '宋朝租房' }).click()
    await assertDraft(h, editor, video)
  } finally { await h.browser.close() }
})

test('detail tabs retain the manuscript, source review and unsaved Baijiahao title without retired article controls', async () => {
  const h = await harness()
  try {
    const { page } = h
    await selectSecond(page)
    await page.getByRole('button', { name: '校对稿', exact: true }).click()
    const editor = await page.locator('#rewritten-script').elementHandle()
    await editor.fill(draft)
    await openDetail(page, '来源与审阅')
    const video = await page.locator('video.source-video').elementHandle()
    await page.getByRole('button', { name: /审稿提示/ }).click()
    await page.getByText('史料疑点 102', { exact: true }).waitFor()
    await openDetail(page, '成片与封面')
    const title = page.getByRole('textbox', { name: '百家号视频标题', exact: true })
    await title.fill('尚未保存的封面标题')
    const titleNode = await title.elementHandle()
    assert.equal(await page.locator('#detail-tab-article').count(), 0)
    assert.equal(await page.getByRole('textbox', { name: '视频号短标题', exact: true }).count(), 0)
    for (const name of ['花生制作', '精细化制作', '百家号发表', '来源与审阅', '成片与封面']) {
      await openDetail(page, name)
      if (name === '来源与审阅') await page.getByText('史料疑点 102', { exact: true }).waitFor()
      if (name === '成片与封面') {
        assert.equal(await title.inputValue(), '尚未保存的封面标题')
        assert.equal(await titleNode.evaluate(element => element === document.querySelector('#history-delivery-102 textarea')), true)
      }
      await openDetail(page, '文稿')
      await assertDraft(h, editor, video)
      assert.equal(await page.getByRole('button', { name: '校对稿', exact: true }).getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('.script-column.original pre').innerText(), '校对后的史料 102。')
    }
    assert.equal(h.deliveries.get(102).baijiahaoTitle, '已保存的百家号标题 102')
    assert.equal([...h.reads.keys()].some(path => path.endsWith('/article')), false)
  } finally { await h.browser.close() }
})

test('opening a source from collection tasks respects draft cancellation and enters the library only after confirmed selection', async () => {
  const h = await harness()
  try {
    const { page } = h
    await selectSecond(page)
    const editor = await page.locator('#rewritten-script').elementHandle()
    const video = await page.locator('video.source-video').elementHandle()
    await editor.fill(draft)
    const monitor = page.getByRole('dialog', { name: '采集监控', exact: true })
    await openWorkspace(page, '采集任务')
    await page.getByRole('button', { name: '查看任务 40001 日志', exact: true }).click()
    page.once('dialog', dialog => dialog.dismiss())
    await monitor.getByRole('button', { name: /^当前稿件 #101/ }).click()
    assert.equal(await monitor.isVisible(), true)
    assert.equal(new URL(page.url()).searchParams.get('view'), 'collection')
    await monitor.getByRole('button', { name: '关闭采集监控', exact: true }).click()
    await openWorkspace(page, '稿件库')
    await assertDraft(h, editor, video)
    await openWorkspace(page, '采集任务')
    await page.getByRole('button', { name: '查看任务 40001 日志', exact: true }).click()
    page.once('dialog', dialog => dialog.accept())
    await monitor.getByRole('button', { name: /^当前稿件 #101/ }).click()
    await monitor.waitFor({ state: 'detached' })
    await page.getByRole('textbox', { name: '编辑待审稿', exact: true }).waitFor()
    assert.equal(await workspaceTab(page, '稿件库').getAttribute('aria-selected'), 'true')
    assert.equal(new URL(page.url()).searchParams.get('view'), 'library')
    assert.equal(new URL(page.url()).searchParams.get('script'), '101')
    assert.equal(await page.locator('#rewritten-script').inputValue(), '数据库中的稿件 101。')
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.unexpected, [])
  } finally { await h.browser.close() }
})

test('production output entries preserve same-script drafts and respect cancel or confirm before switching scripts', async () => {
  const h = await harness({ productionJobs: true })
  try {
    const { page } = h
    await selectSecond(page)
    const editor = await page.locator('#rewritten-script').elementHandle()
    const video = await page.locator('video.source-video').elementHandle()
    await editor.fill(draft)
    const dialogs = []
    let confirmSwitch = false
    page.on('dialog', async dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() })
      await (confirmSwitch ? dialog.accept() : dialog.dismiss())
    })
    const panel = page.getByRole('region', { name: '花生自动制作', exact: true })
    const queue = panel.getByRole('list', { name: '花生制作队列', exact: true })
    const openOutput = async item => {
      await queue.getByRole('button', { name: `查看任务 #production-${item.id} 详情`, exact: true }).click()
      const detail = panel.locator('.queue .job-row')
      await detail.getByRole('link', { name: item.title, exact: true }).waitFor()
      await detail.getByRole('button', { name: '查看稿件与产物', exact: true }).click()
    }

    await openWorkspace(page, '视频制作')
    await openOutput(h.sources[1])
    await page.waitForURL(url => url.searchParams.get('view') === 'library' && url.searchParams.get('script') === '102')
    await page.getByRole('tabpanel', { name: '成片与封面', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: '成片与封面', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('textbox', { name: '百家号视频标题', exact: true }).inputValue(), '已保存的百家号标题 102')
    assert.deepEqual(dialogs, [], 'opening the current script outputs must not discard or reload its unsaved manuscript')
    await openDetail(page, '文稿')
    await assertDraft(h, editor, video)

    await openWorkspace(page, '视频制作')
    await openOutput(h.sources[0])
    assert.equal(dialogs.length, 1, 'switching scripts through the output entry must ask before discarding a draft')
    assert.equal(dialogs[0].type, 'confirm')
    assert.match(dialogs[0].message, /未保存修改/)
    assert.equal(await workspaceTab(page, '视频制作').getAttribute('aria-selected'), 'true')
    assert.equal(new URL(page.url()).searchParams.get('view'), 'production')
    assert.equal(new URL(page.url()).searchParams.get('script'), '102')
    await openWorkspace(page, '稿件库')
    await assertDraft(h, editor, video)

    await openWorkspace(page, '视频制作')
    confirmSwitch = true
    await openOutput(h.sources[0])
    await page.waitForURL(url => url.searchParams.get('view') === 'library' && url.searchParams.get('script') === '101')
    await page.locator('#history-delivery-101 .cover-editor').waitFor()
    assert.deepEqual(dialogs, [dialogs[0], dialogs[0]], 'confirmed selection must use the same unsaved-draft guard')
    assert.equal(await workspaceTab(page, '稿件库').getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('tab', { name: '成片与封面', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('.summary-copy .script-id').textContent(), '脚本 #101')
    assert.equal(await page.getByRole('textbox', { name: '百家号视频标题', exact: true }).inputValue(), '已保存的百家号标题 101')
    await openDetail(page, '文稿')
    assert.equal(await page.locator('#rewritten-script').inputValue(), '数据库中的稿件 101。')
    assert.equal(await page.locator('video.source-video').getAttribute('src'), '/api/v1/history-scripts/101/video')
    assert.equal(h.sources[1].rewrittenScript, '数据库中的稿件 102。')
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.unexpected, [])
  } finally { await h.browser.close() }
})

test('collection and cover polling continue while their panels are hidden and cannot replace an unsaved manuscript', async () => {
  const h = await harness({ clock: true, busyOutputs: true })
  try {
    const { page } = h
    await selectSecond(page)
    const editor = await page.locator('#rewritten-script').elementHandle()
    await editor.fill(draft)
    const video = await page.locator('video.source-video').elementHandle()
    await page.locator('#history-delivery-102 .cover-editor').waitFor({ state: 'attached' })
    const paths = ['/api/v1/history-scripts/jobs/40001', '/api/v1/history-scripts/102/delivery']
    const before = paths.map(path => h.reads.get(path) || 0)
    h.sources.push(source(103, '新采集的历史素材'))
    h.job.sourceIds.push(103)
    h.job.counts.completed = 1
    Object.assign(h.deliveries.get(102), { designStatus: 'completed', designRunId: null })
    await openWorkspace(page, '视频制作')
    await page.clock.fastForward(4500)
    await page.locator('.source-item').filter({ hasText: '新采集的历史素材' }).waitFor({ state: 'attached' })
    await openWorkspace(page, '稿件库')
    await openDetail(page, '成片与封面')
    await page.getByText('发布标题与封面方案已生成并保存。', { exact: true }).waitFor()
    assert.equal([...h.reads.keys()].some(path => path.endsWith('/article')), false)
    paths.forEach((path, index) => assert.ok(h.reads.get(path) > before[index], `${path} must keep polling in a hidden panel`))
    await openDetail(page, '文稿')
    await assertDraft(h, editor, video)
    assert.equal(await page.locator('.source-item[aria-pressed="true"] .script-id').textContent(), '脚本 #102')
  } finally { await h.browser.close() }
})

async function assertActiveTab(page, tablist, name) {
  const tabs = tablist.getByRole('tab')
  const selected = tablist.getByRole('tab', { selected: true })
  assert.equal(await selected.count(), 1)
  assert.match(await selected.innerText(), new RegExp(`^${name}`))
  assert.equal(await selected.evaluate(element => element === document.activeElement), true)
  for (const tab of await tabs.all()) {
    const active = await tab.getAttribute('aria-selected') === 'true'
    assert.equal(await tab.getAttribute('tabindex'), active ? '0' : '-1')
    const panel = page.locator(`#${await tab.getAttribute('aria-controls')}`)
    assert.equal(await panel.getAttribute('role'), 'tabpanel')
    assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'))
    assert.equal(await panel.isVisible(), active)
  }
}

test('workspace and detail tabs support roving keyboard focus, wrapping, Home and End while keeping every panel mounted', async () => {
  const h = await harness()
  try {
    const { page } = h
    const workspace = page.getByRole('tablist', { name: '历史脚本工作区', exact: true })
    const detail = page.getByRole('tablist', { name: '稿件内容', exact: true })
    assert.deepEqual(await workspace.getByRole('tab').allTextContents().then(names => names.map(name => name.replace(/\d.*$/, '').trim())), workspaceNames)
    const panels = await page.locator('.workspace-tabs [role="tab"], .detail-tabs [role="tab"]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-controls')))
    const handles = await Promise.all(panels.map(id => page.locator(`#${id}`).elementHandle()))
    await workspaceTab(page, '稿件库').focus()
    for (const [key, name] of [['Home', '视频制作'], ['ArrowLeft', '采集任务'], ['ArrowRight', '视频制作'], ['ArrowRight', '稿件库'], ['End', '采集任务'], ['ArrowLeft', '百家号发表'], ['ArrowLeft', '稿件库']]) {
      await page.keyboard.press(key)
      await assertActiveTab(page, workspace, name)
    }
    assert.equal(await detail.getByRole('tab').count(), detailNames.length)
    await detail.getByRole('tab', { name: '文稿', exact: true }).focus()
    for (const [key, name] of [['ArrowLeft', '来源与审阅'], ['ArrowLeft', '百家号发表'], ['ArrowRight', '来源与审阅'], ['ArrowRight', '文稿'], ['ArrowRight', '花生制作'], ['End', '来源与审阅'], ['Home', '文稿']]) {
      await page.keyboard.press(key)
      await assertActiveTab(page, detail, name)
    }
    for (const [index, handle] of handles.entries()) assert.equal(await handle.evaluate((element, id) => element === document.getElementById(id), panels[index]), true)
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.unexpected, [])
  } finally { await h.browser.close() }
})

for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1100, height: 800 }]) {
  test(`task and detail navigation fit ${viewport.width}x${viewport.height} and preserve the focused manuscript`, async () => {
    const h = await harness({ viewport })
    try {
      const { page } = h
      const listHeight = await page.locator('.source-list').evaluate(element => element.clientHeight)
      assert.ok(listHeight >= 44, `the script list needs a clickable row at ${viewport.width}x${viewport.height}; available height: ${listHeight}px`)
      await selectSecond(page)
      assert.equal(await page.getByRole('button', { name: '专注改稿', exact: true }).getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('.script-column.original').isVisible(), false)
      const editor = await page.locator('#rewritten-script').elementHandle()
      await editor.fill(draft)
      const video = await page.locator('video.source-video').elementHandle()
      for (const name of detailNames) {
        await openDetail(page, name)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} must not overflow`)
        const toolbar = await page.locator('.job-control').boundingBox()
        assert.ok(toolbar.height <= 60, `common collection toolbar is too tall at ${viewport.width}x${viewport.height} in ${name}: ${toolbar.height}px`)
      }
      for (const name of ['视频制作', '百家号发表', '采集任务', '稿件库']) {
        await openWorkspace(page, name)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} must not overflow`)
        if (name === '视频制作') {
          assert.equal(await page.locator('.job-control').isVisible(), false)
          assert.equal(await page.locator('.page-head').getByRole('button', { name: '采集监控', exact: true }).isVisible(), true)
        } else {
          const toolbar = await page.locator('.job-control').boundingBox()
          assert.ok(toolbar.height <= 60, `common collection toolbar is too tall at ${viewport.width}x${viewport.height} in ${name}: ${toolbar.height}px`)
        }
      }
      await openDetail(page, '文稿')
      await assertDraft(h, editor, video)
      if (viewport.width <= 760) {
        await page.getByRole('button', { name: '返回脚本列表', exact: true }).click()
        assert.equal(await page.locator('.source-item[aria-pressed="true"] .script-id').textContent(), '脚本 #102')
        await selectSecond(page)
        await assertDraft(h, editor, video)
      }
    } finally { await h.browser.close() }
  })
}

const layoutProductionJobs = () => Array.from({ length: 16 }, (_, index) => ({
  id: index + 1, sourceId: index + 101, title: `历史制作项目 ${index + 1}：从人物经历与时代变化看历史的转折`,
  status: 'queued', stage: 'queued', message: '等待提交花生', productionStatus: 'not_started',
  projectUrl: null, videoUrl: null, error: null, createdAt: timestamp, updatedAt: timestamp,
  scriptSha256: createHash('sha256').update(`稿件 ${index + 101}`).digest('hex'),
  productionCheckedAt: null, productionMessage: '', productionCheckError: null,
}))

for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 650 }, { width: 390, height: 844 }, { width: 812, height: 375 }]) {
  test(`production master-detail layout keeps tasks and collection reachable at ${viewport.width}x${viewport.height}`, async t => {
    const h = await harness({ viewport, path: '/history-scripts?view=production', productionJobs: layoutProductionJobs(), exports: { enabled: false, jobs: [], worker: { status: 'stopped', message: '自动处理未运行' }, production: { limit: 2, activeProjects: 0, waitingProjects: 0 } } })
    try {
      const { page } = h
      const panel = page.getByRole('region', { name: '花生自动制作', exact: true })
      const taskList = panel.getByRole('list', { name: '花生制作队列', exact: true })
      const taskRail = panel.locator('.task-rail')
      const queue = panel.locator('.queue')
      await taskList.locator('.task-item').last().waitFor({ state: 'attached' })
      assert.equal(await taskList.locator('.task-item').count(), 16)
      const panelNode = await panel.elementHandle()
      const shell = page.locator('.history-page')
      assert.equal(await page.locator('.job-control').isVisible(), false)
      const monitor = page.locator('.page-head').getByRole('button', { name: '采集监控', exact: true })
      assert.equal(await monitor.isVisible(), true)
      await monitor.getByText('运行中', { exact: true }).waitFor()
      const stopCollection = page.locator('.page-head').getByRole('button', { name: '停止采集', exact: true })
      assert.equal(await stopCollection.isVisible(), true)
      assert.equal(await stopCollection.isEnabled(), true)
      assert.equal(await page.locator('.page-head').getByRole('button', { name: '启动采集', exact: true }).isVisible(), false)
      const channels = panel.locator('.toolbar').getByRole('group', { name: '视频创作渠道', exact: true })
      assert.equal(await channels.isVisible(), true, 'Channel switching must share the production toolbar')
      assert.equal(await page.getByRole('group', { name: '视频创作渠道', exact: true }).count(), 1)
      const dimensions = await page.evaluate(() => {
        const page = document.querySelector('.history-page')
        const workspace = document.querySelector('.production-workspace')
        const panel = workspace.querySelector('.huasheng')
        const queue = panel.querySelector('.queue')
        const rail = panel.querySelector('.task-rail')
        const list = panel.querySelector('.task-list')
        const head = document.querySelector('.page-head').getBoundingClientRect()
        const tabs = document.querySelector('.workspace-tabs').getBoundingClientRect()
        return { queueHeight: queue.clientHeight, queueScrollHeight: queue.scrollHeight, queueOverflow: getComputedStyle(queue).overflowY,
          rail: rail.getBoundingClientRect().toJSON(), detail: panel.querySelector('.detail-workspace').getBoundingClientRect().toJSON(),
          listHeight: list.clientHeight, listScrollHeight: list.scrollHeight, listOverflow: getComputedStyle(list).overflowY,
          shellHeight: page.clientHeight, shellScrollHeight: page.scrollHeight, shellOverflow: getComputedStyle(page).overflowY,
          workspaceHeight: workspace.clientHeight, workspaceOverflow: getComputedStyle(workspace).overflowY,
          pageWidth: document.documentElement.scrollWidth, width: innerWidth, shellScrollWidth: page.scrollWidth, shellWidth: page.clientWidth,
          headTop: head.top, headHeight: head.height, tabsTop: tabs.top, tabsHeight: tabs.height }
      })
      await page.screenshot({ path: join(tmpdir(), `history-workspace-production-${viewport.width}x${viewport.height}-initial.png`), fullPage: false, animations: 'disabled' })
      assert.ok(dimensions.pageWidth <= dimensions.width + 1 && dimensions.shellScrollWidth <= dimensions.shellWidth + 1, JSON.stringify(dimensions))
      const mobile = viewport.width <= 760
      t.diagnostic(`${viewport.width}x${viewport.height}: list ${dimensions.listHeight}px, rail ${dimensions.rail.width}px, detail ${dimensions.detail.width}px`)
      if (mobile) {
        assert.equal(await taskRail.isVisible(), true)
        assert.equal(await queue.isVisible(), false, 'Phone starts with only the task list')
        assert.equal(dimensions.shellOverflow, 'auto')
        assert.equal(dimensions.workspaceOverflow, 'visible')
        assert.equal(dimensions.listOverflow, 'visible')
        assert.ok(dimensions.workspaceHeight > 520 && dimensions.shellScrollHeight > dimensions.shellHeight, JSON.stringify(dimensions))
        assert.ok(dimensions.listHeight >= dimensions.listScrollHeight - 1, 'The phone list should grow instead of becoming a nested scroll area')
        await taskList.locator('.task-item').last().scrollIntoViewIfNeeded()
        assert.ok(await shell.evaluate(element => element.scrollTop) > 0, 'The production page must scroll to the last project')
        await taskList.getByRole('button', { name: '查看任务 #16 详情', exact: true }).click()
        await queue.locator('.job-row').getByRole('link', { name: layoutProductionJobs()[15].title, exact: true }).waitFor()
        assert.equal(await queue.isVisible(), true)
        assert.equal(await taskRail.isVisible(), false, 'Phone task details replace the list')
        assert.equal(await queue.evaluate(element => getComputedStyle(element).overflowY), 'visible')
        assert.equal(await panel.getByRole('group', { name: '对选中任务执行操作', exact: true }).isVisible(), true)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
        await panel.getByRole('button', { name: '返回任务列表', exact: true }).click()
        assert.equal(await taskRail.isVisible(), true)
        assert.equal(await queue.isVisible(), false)
        assert.equal(await taskList.getByRole('button', { name: '查看任务 #16 详情', exact: true }).evaluate(element => element === document.activeElement), true, 'Returning must restore keyboard focus to the original task preview')
      } else {
        assert.ok(Math.abs(dimensions.rail.width - (viewport.width > 1100 ? 360 : 320)) <= 1, `The left rail should use its desktop width: ${JSON.stringify(dimensions)}`)
        assert.ok(dimensions.detail.width >= 400, `Task details need at least 400px: ${JSON.stringify(dimensions)}`)
        assert.ok(dimensions.rail.right <= dimensions.detail.left + 1 && Math.abs(dimensions.rail.top - dimensions.detail.top) <= 1, 'Tasks and details must sit side by side')
        assert.ok(dimensions.listHeight >= 240 && dimensions.queueHeight >= 240, `Both panes need usable scrolling space: ${JSON.stringify(dimensions)}`)
        assert.equal(dimensions.listOverflow, 'auto')
        assert.equal(dimensions.queueOverflow, 'auto')
        assert.ok(dimensions.listScrollHeight > dimensions.listHeight, 'Long desktop task lists scroll independently')
        if (viewport.height > 600) assert.ok(dimensions.shellScrollHeight <= dimensions.shellHeight + 1, JSON.stringify(dimensions))
        else {
          assert.equal(dimensions.shellOverflow, 'auto')
          assert.equal(dimensions.workspaceOverflow, 'visible')
          assert.ok(dimensions.workspaceHeight >= 520 && dimensions.shellScrollHeight > dimensions.shellHeight, JSON.stringify(dimensions))
        }
        const detailScroll = await queue.evaluate(element => element.scrollTop)
        const shellScroll = await shell.evaluate(element => element.scrollTop)
        await taskList.evaluate(element => { element.scrollTop = element.scrollHeight })
        assert.ok(await taskList.evaluate(element => element.scrollTop) > 0)
        assert.equal(await queue.evaluate(element => element.scrollTop), detailScroll, 'Scrolling tasks must not move the detail pane')
        assert.equal(await shell.evaluate(element => element.scrollTop), shellScroll, 'Scrolling tasks must not move the page')
        await taskList.getByRole('button', { name: '查看任务 #16 详情', exact: true }).click()
        await queue.locator('.job-row').getByRole('link', { name: layoutProductionJobs()[15].title, exact: true }).waitFor()
        assert.equal(await queue.locator('.job-row').count(), 1)
      }
      if (viewport.width >= 1100) {
        assert.ok(Math.abs(dimensions.headTop - dimensions.tabsTop) <= 1, 'Header and workspace tabs must share one band')
        assert.ok(dimensions.headHeight <= 64 && dimensions.tabsHeight <= 64, JSON.stringify(dimensions))
      }
      const firstTask = taskList.getByRole('button', { name: '查看任务 #1 详情', exact: true })
      await firstTask.click()
      await queue.locator('.job-row').getByRole('link', { name: layoutProductionJobs()[0].title, exact: true }).waitFor()
      if (mobile) await panel.getByRole('button', { name: '返回任务列表', exact: true }).click()
      assert.equal(await firstTask.getAttribute('aria-current'), 'true')
      await shell.evaluate(element => { element.scrollTop = 0 })
      await taskList.evaluate(element => { element.scrollTop = 0 })
      await page.screenshot({ path: join(tmpdir(), `history-workspace-production-${viewport.width}x${viewport.height}.png`), fullPage: false, animations: 'disabled' })
      await monitor.click()
      const dialog = page.getByRole('dialog', { name: '采集监控', exact: true })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: '关闭采集监控', exact: true }).click()
      assert.equal(await monitor.evaluate(element => element === document.activeElement), true)
      await channels.getByRole('button', { name: '精细化制作', exact: true }).click()
      const motionChannels = page.getByRole('group', { name: '视频创作渠道', exact: true })
      await motionChannels.getByRole('button', { name: '花生制作', exact: true }).click()
      assert.equal(await panelNode.evaluate(element => element.isConnected && element === document.querySelector('#workspace-production > .huasheng')), true)
      await openWorkspace(page, '采集任务')
      assert.equal(await page.getByRole('region', { name: '历史素材采集任务', exact: true }).isVisible(), true)
      assert.equal(await page.getByRole('region', { name: '历史素材采集任务', exact: true }).getByRole('button', { name: '停止', exact: true }).isVisible(), true)
      assert.deepEqual(h.writes, [])
      assert.deepEqual(h.unexpected, [])
    } finally { await h.browser.close() }
  })
}

test('production header exposes collection failure attention and opens its recovery without discarding a manuscript', async () => {
  const h = await harness({ job: { status: 'failed', stage: 'failed', config: { source: 'douyin', categories: ['historical_anecdote'] }, error: '采集网络中断，请重试', progressMessage: '采集网络中断，请重试' } })
  try {
    const { page } = h
    await selectSecond(page)
    const editor = await page.locator('#rewritten-script').elementHandle()
    const video = await page.locator('video.source-video').elementHandle()
    await editor.fill(draft)
    await openWorkspace(page, '视频制作')
    const monitor = page.locator('.page-head').getByRole('button', { name: '采集监控', exact: true })
    await monitor.getByText('需处理', { exact: true }).waitFor()
    assert.equal(await monitor.locator('.attention-dot').isVisible(), true)
    assert.equal(await page.locator('.page-head').getByRole('button', { name: '启动采集', exact: true }).isEnabled(), true)
    await monitor.click()
    const dialog = page.getByRole('dialog', { name: '采集监控', exact: true })
    assert.equal(await dialog.getByRole('tab', { name: '任务日志', exact: true }).getAttribute('aria-selected'), 'true')
    await dialog.getByRole('alert').filter({ hasText: '采集网络中断' }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '重试采集', exact: true }).isVisible(), true)
    await page.keyboard.press('Escape')
    await openWorkspace(page, '稿件库')
    await assertDraft(h, editor, video)
  } finally { await h.browser.close() }
})
