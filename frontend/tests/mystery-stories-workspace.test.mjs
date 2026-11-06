import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.MYSTERY_UI_TEST_URL || 'http://127.0.0.1:3013'
const BASE = '/api/v1/mystery-stories'
const source = '大家好，我是阿强。那天晚上，门口出现了一串脚印。警方认为，那个人可能还在镇上。第二天，这条线索才得到解释。'
const intro = '大家好，我是阿强。'
const narrator = '面向40岁以上观众，用通俗中文完整讲述原作故事。'
const analysis = {
  sourceHash: 'source-hash', theme: '一串脚印如何改变调查方向', purpose: '让观众跟随调查逐步解开疑问', stance: '保留未确定线索的可能性', audienceNeeds: ['好奇线索的来历', '体验推理和解谜'], endingPayoff: '解释脚印来源，兑现开场疑问',
  evidence: [{ id: 'e1', start: intro.length, end: source.length, quote: source.slice(intro.length), note: '先给线索，再提出可能，最后说明原因。' }],
  beats: [{ id: 'b1', start: intro.length, end: source.indexOf('第二天'), purpose: '引出脚印与嫌疑', emotion: '好奇转为紧张', method: '按发现顺序延后揭示', reveal: '保留那个人可能仍在镇上的猜测' }],
  identitySpans: [{ start: 0, end: intro.length, text: intro, kind: 'identity', reason: '原作者自我介绍' }],
  dossier: { people: [{ name: '警方', aliases: [], role: '调查者', evidenceIds: ['e1'] }], timeline: [{ when: '当晚', event: '发现脚印', evidenceIds: ['e1'] }], claims: [{ claim: '那个人可能还在镇上', basis: '警方判断', certainty: 'uncertain', evidenceIds: ['e1'] }], uncertainties: ['身份尚未确定'] },
}
const patch = { id: 'identity-1', start: 0, end: intro.length, original: intro, replacement: '', reason: '仅清理作者自我介绍', kind: 'identity' }
const revision = id => ({ id, source, sourceHash: 'source-hash', narrator, analysis, patches: [{ ...patch }], text: source.slice(intro.length), textHash: `hash-${id}`, createdAt: '2026-11-01T01:00:00.000Z', review: { passed: true, issues: [], sourceHash: 'source-hash', textHash: `hash-${id}`, checkedAt: '2026-11-01T01:00:00.000Z' } })
const makeStory = (id, title) => ({ id, title, category: id === 1 ? 'case' : 'person', sourceUrl: `https://www.youtube.com/watch?v=${id === 1 ? 'abcdefghijk' : 'lmnopqrstuv'}`, videoId: id === 1 ? 'abcdefghijk' : 'lmnopqrstuv', sourceChannel: '故事频道', sourceTitle: title, downloadMode: 'video', transcript: source, correctedTranscript: source, chunks: [{ start: 0, duration: 45, text: source }], transcriptVersion: 1, narrator, analysis, revisions: [revision(1), revision(2)], currentRevisionId: 2, editions: [], runs: [], status: 'ready', stage: 'completed', message: '完整文稿已通过对照检查', version: 3, notes: '', relatedStoryIds: [], createdAt: '2026-11-01T01:00:00.000Z', updatedAt: '2026-11-01T01:00:00.000Z', logs: [{ at: '2026-11-01T01:00:00.000Z', stage: 'review', message: '逐处与全文检查通过' }] })
const edition = { id: 'edition-one', revisionId: 1, scriptHash: 'hash-1', accountName: 'mystery_hs', createdAt: '2026-11-01T01:00:00.000Z', status: 'package_ready', projectUrl: 'https://www.huasheng.cn/video/123', checkpoint: 'downloaded', exportTask: { taskId: 'export-one', projectHash: 'a'.repeat(64) }, requestedSettings: { aspect: '16:9', voice: '纪实叙述', subtitle: '中文字幕', visual: '资料与示意区分' }, confirmedSettings: { scheme: 'A - 素材剪辑成片' }, message: '本地成片与封面已检查', videoUrl: '/test-mystery.mp4', duration: 620, width: 1920, height: 1080, bytes: 31457280, coverRevision: 1, coverInstruction: '', title: '门口的脚印究竟来自哪里', titleCandidates: ['一串脚印带来的疑问', '门口的脚印究竟来自哪里'], description: '跟随调查解开脚印的来历。', tags: ['案件', '调查'] }

async function harness(t, { empty = false } = {}) {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000)
  const stories = empty ? [] : [makeStory(1, '门口那串脚印来自哪里'), makeStory(2, '一位普通人的非凡经历')]
  if (stories[0]) stories[0].editions.push(structuredClone(edition))
  const channels = [{ id: 'channel-one', name: '故事频道', url: 'https://www.youtube.com/@stories/videos', category: 'case', enabled: true }]
  const collections = [{ id: 'batch-one', status: 'paused', stopped: true, taskId: 30, scanned: 5, skipped: 1, storyIds: [1, 2], errors: [], targetCount: 5, target: 'video', message: '已暂停新增处理', counts: { selected: 2, transcribed: 2, drafts: 2, videos: 1, failed: 1, published: 0 }, createdAt: '2026-11-01T01:00:00.000Z' }]
  const accounts = { huasheng: { accounts: [{ accountName: 'mystery_hs', label: '故事华生', status: 'ready', isDefault: true }], defaultAccountName: 'mystery_hs' }, baijiahao: { accounts: [{ accountName: 'mystery_bj', label: '故事百家号', status: 'ready', isDefault: true }], defaultAccountName: 'mystery_bj' } }
  const writes = [], reads = [], errors = [], failure = { save: false }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/test-mystery.mp4', route => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname, method = request.method()
    const body = method === 'GET' ? undefined : request.postDataJSON()
    if (method === 'GET') reads.push(pathname + url.search); else writes.push({ path: pathname, method, body })
    let data
    if (pathname === `${BASE}/stories` && method === 'GET') {
      let filtered = stories.filter(item => !item.archivedAt)
      if (url.searchParams.get('category')) filtered = filtered.filter(item => item.category === url.searchParams.get('category'))
      if (url.searchParams.get('status')) filtered = filtered.filter(item => item.status === url.searchParams.get('status'))
      if (url.searchParams.get('hasEdition')) filtered = filtered.filter(item => item.editions.length)
      if (url.searchParams.get('search')) filtered = filtered.filter(item => item.title.includes(url.searchParams.get('search')))
      data = { items: filtered, total: filtered.length, page: 1, pageSize: 20, counts: { total: stories.length, ready: stories.length, running: 0, needs_attention: 0, paused: 0, completed: 0 } }
    } else if (pathname === `${BASE}/stories` && method === 'POST') {
      data = { ...makeStory(stories.length + 1, body.title || '待获取视频标题'), ...body, transcript: '', correctedTranscript: '', revisions: [], currentRevisionId: null, analysis: null, status: 'draft', stage: 'download', message: '已导入，选择目标后开始处理' }; stories.push(data)
    } else if (pathname === `${BASE}/channels`) {
      if (method === 'POST') { data = { ...body, id: `channel-${channels.length + 1}` }; channels.push(data) } else data = channels
    } else if (pathname.startsWith(`${BASE}/accounts/`)) data = accounts[pathname.split('/').at(-1)]
    else if (pathname === `${BASE}/collection-runs`) {
      if (method === 'POST') { data = { ...collections[0], ...body, id: `batch-${collections.length + 1}`, status: 'queued' }; collections.push(data) } else data = collections
    } else if (pathname.startsWith(`${BASE}/collection-runs/`)) {
      data = collections.find(item => item.id === pathname.split('/').at(-2)); data.status = pathname.endsWith('/stop') ? 'paused' : 'queued'; data.message = '已安排原批次任务'
    } else {
      const match = pathname.match(/\/stories\/(\d+)(.*)$/)
      data = match && stories.find(item => item.id === Number(match[1])); const action = match?.[2]
      if (data && method === 'PATCH' && !action) {
        if (failure.save) return route.fulfill({ status: 409, json: { code: 409, message: '故事已更新；本机草稿仍保留' } })
        Object.assign(data, body); data.version++
      } else if (data && action === '/revisions') {
        const next = { ...revision(data.revisions.length + 1), patches: body.patches, review: null }
        let text = source
        for (const item of [...next.patches].sort((a, b) => b.start - a.start)) text = text.slice(0, item.start) + item.replacement + text.slice(item.end)
        next.text = text; data.revisions.push(next); data.currentRevisionId = next.id; data.version++
      } else if (data && action === '/runs') {
        data.runs.push({ id: 'run-one', taskId: 21, status: 'queued', stage: 'review', target: body.target, revisionId: body.revisionId ?? data.currentRevisionId, editionId: body.editionId || null, accountName: body.huashengAccountName, baijiahaoAccountName: body.baijiahaoAccountName, action: body.action, message: '已排队', createdAt: '2026-11-01T01:00:00.000Z' }); data.status = 'queued'
      } else if (data && action?.startsWith('/runs/')) { const run = data.runs.find(item => item.id === action.split('/')[2]); run.status = action.endsWith('/stop') ? 'paused' : 'queued'; data.status = run.status }
      else if (data && action === '/archive') data.archivedAt = '2026-11-01T01:00:00.000Z'
      else if (data && action?.endsWith('/copy')) { const item = data.editions.find(item => item.id === action.split('/')[2]); if (item.title !== body.title) { item.status = 'video_ready'; item.coverRevision++ } Object.assign(item, body) }
    }
    if (data === undefined || data === null) return route.fulfill({ status: 404, json: { code: 404, message: `Unexpected ${pathname}` } })
    return route.fulfill({ json: { code: 200, data } })
  })
  await page.goto(`${baseUrl}/mystery-stories`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '奇闻故事', exact: true }).waitFor()
  if (!empty) await page.getByRole('heading', { name: stories[0].title, exact: true }).waitFor({ state: 'attached' })
  return { page, stories, channels, collections, writes, reads, errors, failure }
}

test('edition project opens its original Huasheng account without changing publication or draft data', async t => {
  const { page, stories, writes, errors } = await harness(t)
  await page.getByRole('tab', { name: '华生制作', exact: true }).click()
  assert.equal(await page.locator('a[href*="huasheng.cn"]').count(), 0)
  let release, failure = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route(`**${BASE}/stories/1/editions/edition-one/open-project`, async route => {
    writes.push({ path: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postDataJSON() })
    if (failure) return route.fulfill({ status: 503, json: { code: 503, message: '原账号的项目暂时无法打开' } })
    await pending
    return route.fulfill({ json: { code: 200, data: { accountName: 'mystery_hs', projectUrl: stories[0].editions[0].projectUrl, reused: false, message: '已在原版本账号打开花生项目' } } })
  })
  const open = page.getByRole('button', { name: '打开原项目', exact: true })
  await open.click()
  await page.getByText('正在打开…', { exact: true }).waitFor()
  assert.equal(await open.isDisabled(), true)
  release()
  await page.getByText('已在原版本账号打开花生项目', { exact: true }).waitFor()
  failure = true
  await open.click()
  await page.getByRole('alert').filter({ hasText: '原账号的项目暂时无法打开' }).waitFor()
  assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ path: `${BASE}/stories/1/editions/edition-one/open-project`, method: 'POST', body: {} })))
  assert.equal(stories[0].runs.length, 0)
  assert.equal(page.context().pages().length, 1)
  assert.deepEqual(errors, [])
})

test('source-preserving patch editing, restoration and unsaved changes survive refresh and story switches', async t => {
  const { page, stories, writes, errors } = await harness(t)
  await page.getByRole('tab', { name: '轻改稿', exact: true }).click()
  assert.equal(await page.getByLabel('轻改原稿底稿', { exact: true }).inputValue(), source)
  assert.match(await page.getByLabel('轻改全文', { exact: true }).innerText(), /警方认为，那个人可能还在镇上。第二天，这条线索才得到解释。/)
  await page.getByRole('button', { name: '恢复第 1 处原句', exact: true }).click()
  assert.equal(await page.getByLabel('轻改全文', { exact: true }).innerText(), source)
  const original = page.getByLabel('轻改原稿底稿', { exact: true })
  await original.evaluate(element => { const start = element.value.indexOf('那天晚上'); element.focus(); element.setSelectionRange(start, start + 4); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
  await page.getByLabel('局部修改内容', { exact: true }).fill('当天夜里')
  await page.getByLabel('局部修改理由', { exact: true }).fill('使用等义的日常说法')
  await page.getByRole('button', { name: '加入修改清单', exact: true }).click()
  assert.match(await page.getByLabel('轻改全文', { exact: true }).innerText(), /当天夜里，门口出现了一串脚印/)
  await page.locator('.queue-item').filter({ hasText: stories[1].title }).click()
  await page.getByRole('heading', { name: stories[1].title, exact: true }).waitFor()
  await page.locator('.queue-item').filter({ hasText: stories[0].title }).click()
  await page.getByRole('button', { name: '刷新故事列表', exact: true }).click()
  await page.getByText('未保存修改已保留在本机草稿', { exact: true }).waitFor()
  assert.match(await page.getByLabel('轻改全文', { exact: true }).innerText(), /当天夜里/)
  await page.getByRole('button', { name: '另存版本并检查', exact: true }).click()
  await page.getByText('等待对照检查', { exact: true }).waitFor()
  const saved = writes.find(item => item.path.endsWith('/revisions'))
  assert.equal(saved.body.expectedRevision, 2)
  assert.equal(saved.body.patches.length, 1)
  assert.equal(saved.body.patches[0].original, '那天晚上')
  assert.equal(stories[0].revisions.at(-1).text, source.replace('那天晚上', '当天夜里'))
  assert.equal(stories[0].editions[0].revisionId, 1)
  assert.deepEqual(errors, [])
})

test('desktop and mobile expose all detail tabs without overflow and preserve video revision attribution', async t => {
  const { page, reads, writes, errors } = await harness(t)
  await page.getByRole('tab', { name: '华生制作', exact: true }).click()
  await page.getByText('当前文稿 v2 尚未制作。', { exact: true }).waitFor()
  await page.getByRole('tab', { name: '成片与封面', exact: true }).click()
  assert.match(await page.locator('.revision-bar').filter({ has: page.getByLabel('成片版本', { exact: true }) }).innerText(), /绑定文稿 v1 · 非当前文稿版本/)
  assert.equal(await page.getByLabel('奇闻故事成片预览', { exact: true }).count(), 1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/mystery-stories-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.queue-item').first().click()
  for (const name of ['原视频与口播', '原稿理解', '轻改稿', '华生制作', '成片与封面', '运行记录']) {
    await page.getByRole('tab', { name, exact: true }).click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflows`)
  }
  await page.getByRole('tab', { name: '轻改稿', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '恢复第 1 处原句', exact: true }).isVisible(), true)
  await page.screenshot({ path: '/tmp/mystery-stories-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '成片与发表', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 1)
  assert.ok(reads.some(item => item.includes('hasEdition=true')))
  assert.equal(writes.length, 0)
  assert.deepEqual(errors, [])
})

test('import only records source; production, publishing and batch recovery require their explicit actions', async t => {
  const { page, writes, errors } = await harness(t, { empty: true })
  await page.getByRole('button', { name: '导入视频', exact: true }).first().click()
  await page.getByRole('textbox', { name: '视频链接', exact: true }).fill('https://www.youtube.com/watch?v=abcdefghijk')
  await page.getByRole('textbox', { name: '故事标题（可留空）', exact: true }).fill('新故事')
  await page.getByRole('button', { name: '导入故事', exact: true }).click()
  await page.getByRole('heading', { name: '新故事', exact: true }).waitFor()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.downloadMode, 'video')
  await page.getByLabel('处理目标', { exact: true }).selectOption('draft')
  await page.getByRole('button', { name: '生成并检查文稿', exact: true }).click()
  const start = writes.at(-1)
  assert.equal(start.body.target, 'draft')
  assert.equal(start.body.publication, undefined)
  assert.ok(start.body.requestId)
  await page.getByRole('button', { name: '停止本机执行', exact: true }).first().click()
  assert.ok(writes.at(-1).path.endsWith('/runs/run-one/stop'))
  await page.getByRole('button', { name: '频道采集', exact: true }).click()
  await page.getByRole('button', { name: '只重试失败项', exact: true }).click()
  assert.ok(writes.at(-1).path.endsWith('/collection-runs/batch-one/retry'))
  assert.deepEqual(errors, [])
})

test('editing metadata preserves the draft after conflict and does not invalidate unchanged source', async t => {
  const { page, stories, writes, failure, errors } = await harness(t)
  await page.getByRole('textbox', { name: '故事标题', exact: true }).fill('修改后的故事标题')
  failure.save = true
  await page.getByRole('button', { name: '保存校对与资料', exact: true }).click()
  await page.getByText('故事已更新；本机草稿仍保留', { exact: true }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: '故事标题', exact: true }).inputValue(), '修改后的故事标题')
  assert.equal(writes[0].body.correctedTranscript, undefined)
  assert.equal(writes[0].body.narrator, undefined)
  stories[0].version++
  await page.getByRole('button', { name: '刷新故事列表', exact: true }).click()
  await page.getByText('记录已更新，本机修改仍保留', { exact: true }).click()
  failure.save = false
  await page.getByRole('button', { name: '保留我的修改并保存', exact: true }).click()
  await page.getByRole('heading', { name: '修改后的故事标题', exact: true }).waitFor()
  assert.equal(stories[0].currentRevisionId, 2)
  assert.deepEqual(errors, [])
})

test('publishing binds the selected old edition and explicit account, declaration and copy', async t => {
  const { page, stories, writes, errors } = await harness(t)
  await page.getByRole('tab', { name: '成片与封面', exact: true }).click()
  await page.getByLabel('标题候选', { exact: true }).selectOption('一串脚印带来的疑问')
  await page.getByRole('button', { name: '保存标题与发布文案', exact: true }).click()
  assert.ok(writes.at(-1).path.endsWith('/editions/edition-one/copy'))
  assert.equal(writes.at(-1).body.title, '一串脚印带来的疑问')
  assert.equal(await page.getByRole('button', { name: '选择账号与发布文案', exact: true }).isDisabled(), true)
  stories[0].editions[0].status = 'package_ready'
  await page.getByRole('button', { name: '刷新故事列表', exact: true }).click()
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === '选择账号与发布文案')?.disabled)
  await page.getByRole('button', { name: '选择账号与发布文案', exact: true }).click()
  await page.getByLabel('创作声明', { exact: true }).fill('资料来自公开报道')
  await page.getByLabel('水印', { exact: true }).selectOption('添加水印')
  await page.getByRole('button', { name: '提交到百家号', exact: true }).click()
  const publish = writes.at(-1).body
  assert.equal(publish.target, 'publish')
  assert.equal(publish.editionId, 'edition-one')
  assert.equal(publish.revisionId, 1)
  assert.equal(publish.baijiahaoAccountName, 'mystery_bj')
  assert.equal(publish.publication.creationDeclaration, '资料来自公开报道')
  assert.equal(publish.publication.title, '一串脚印带来的疑问')
  assert.deepEqual(errors, [])
})

test('batch publishing sends explicit settings while each story keeps its own generated copy', async t => {
  const { page, writes, errors } = await harness(t)
  await page.getByRole('button', { name: '批量采集', exact: true }).click()
  await page.getByLabel('批量处理目标', { exact: true }).selectOption('publish')
  await page.getByLabel('批量百家号账号', { exact: true }).selectOption('mystery_bj')
  await page.getByLabel('批量创作声明', { exact: true }).fill('资料来自公开报道')
  await page.getByLabel('批量水印', { exact: true }).selectOption('添加水印')
  await page.getByRole('button', { name: '开始采集', exact: true }).click()
  await page.getByRole('heading', { name: '来源频道', exact: true }).waitFor()
  const payload = writes.at(-1).body
  assert.equal(payload.target, 'publish')
  assert.equal(payload.huashengAccountName, 'mystery_hs')
  assert.equal(payload.baijiahaoAccountName, 'mystery_bj')
  assert.deepEqual(payload.publicationSettings, { creationDeclaration: '资料来自公开报道', watermark: '添加水印' })
  assert.equal(payload.publication, undefined)
  assert.equal(payload.title, undefined)
  assert.deepEqual(errors, [])
})

test('a saved new script remains editable while an older edition is producing', async t => {
  const { page, stories, writes, errors } = await harness(t)
  stories[0].runs.push({ id: 'old-production', taskId: 41, status: 'running', stage: 'produce', target: 'video', revisionId: 1, editionId: 'edition-one', accountName: 'mystery_hs', action: 'workflow', message: '正在制作文稿 v1', createdAt: '2026-11-01T01:00:00.000Z' })
  stories[0].editions[0].status = 'producing'
  await page.getByRole('button', { name: '刷新故事列表', exact: true }).click()
  await page.getByRole('button', { name: '停止本机执行', exact: true }).first().waitFor()
  await page.getByRole('tab', { name: '轻改稿', exact: true }).click()
  await page.getByRole('button', { name: '恢复第 1 处原句', exact: true }).click()
  await page.getByRole('button', { name: '另存版本并检查', exact: true }).click()
  await page.getByText('等待对照检查', { exact: true }).waitFor()
  assert.equal(stories[0].currentRevisionId, 3)
  assert.equal(stories[0].editions[0].revisionId, 1)
  assert.equal(stories[0].runs[0].revisionId, 1)
  assert.equal(writes.at(-1).path, `${BASE}/stories/1/revisions`)
  assert.deepEqual(errors, [])
})
