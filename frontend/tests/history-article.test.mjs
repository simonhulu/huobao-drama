import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const idle = { status: 'idle', article: null, error: null, stale: false, staleReasons: [], canGenerate: true, unavailableReason: null, articleGeneration: null }
const article = { title: '明朝兴衰', sourceLength: 3200, articleLength: 1980, targetLength: 2000,
  selectionMethod: 'manual-source-exact',
  markdown: '# 明朝兴衰\n\n## 起因\n\n原文中的因果关系。',
  html: '<section style="padding:20px;color:#374151"><p><span leaf="">原文中的因果关系。</span></p></section>',
  screenshots: [{ url: '/static/history-articles/101/frame-1.jpg', timestamp: 95, sectionIndex: 0 }], notices: ['配图来自成片，发布时需在公众号编辑器确认图片已上传'] }

async function harness(initial = idle, options = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(6000)
  if (options.clock) await page.clock.install()
  let state = structuredClone(initial)
  let delivery = { title: '', description: '', coverStatus: 'idle', covers: {}, coverDesign: {}, articleGeneration: null }
  let badGet = options.badGet
  const writes = []
  const reads = []
  const mutations = []
  const uploads = []
  let releasePost
  const postReady = options.holdPost ? new Promise(resolve => { releasePost = resolve }) : Promise.resolve()
  const source = { id: 101, title: '明朝兴衰', category: 'historical_anecdote', status: 'needs_review',
    correctedTranscript: '原文中的因果关系。', rewrittenScript: '成片口播稿。', revision: 'revision-101',
    metricsJson: '{}', mediaJson: '{}', reviewJson: '{}', selectionJson: '{}',
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' } }
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() !== 'GET') mutations.push({ path: pathname, method: request.method() })
    let data = {}
    if (pathname === '/api/v1/history-scripts/101/article') {
      if (request.method() === 'GET') reads.push(pathname)
      if (request.method() === 'POST') {
        writes.push(request.postDataJSON())
        state = { ...state, status: 'generating', canGenerate: false }
        if (options.holdPost) await postReady
        if (options.emptyPostResponse) {
          state = { ...idle, status: 'failed', error: '文章生成服务暂不可用，请重试' }
          return route.fulfill({ status: 502, contentType: 'application/json', body: '' })
        }
        if (options.postConflict) return route.fulfill({ status: 409, json: { code: 409, message: '文章正在生成，请稍候' } })
        if (options.lostResponse) return route.abort('failed')
      }
      if (request.method() === 'GET' && badGet) {
        return route.fulfill({ status: 502, contentType: 'application/json', body: badGet === 'empty' ? '' : '{"code":200,' })
      }
      data = state
    } else if (pathname === '/api/v1/history-scripts/101/article/export') {
      return route.fulfill({ contentType: 'text/html', body: article.html })
    } else if (pathname === '/api/v1/history-scripts/101/delivery/video') {
      if (request.method() === 'PUT') {
        uploads.push({ headers: request.headers(), body: request.postDataBuffer() })
        const status = options.uploadStatus || 'queued'
        const articleGeneration = { status, message: status === 'queued' ? '成片已关联，文章等待生成。' : '正在生成公众号文章。' }
        delivery = { ...delivery, videoUrl: pathname, videoName: decodeURIComponent(request.headers()['x-file-name']), articleGeneration }
        state = { ...idle, status: status === 'queued' ? 'idle' : 'generating', canGenerate: status === 'queued', articleGeneration }
        data = delivery
      } else return route.fulfill({ contentType: 'video/mp4', body: '' })
    } else if (pathname === '/api/v1/history-scripts/101/delivery') data = delivery
    else if (pathname === '/api/v1/history-scripts/101') data = source
    else if (pathname === '/api/v1/history-scripts') data = { items: [source], total: 1 }
    else if (pathname === '/api/v1/history-scripts/jobs') data = { job: null, recent: [] }
    await route.fulfill({ json: { code: 200, data } })
  })
  await page.goto(`${baseUrl}/history-scripts?script=101`, { waitUntil: 'domcontentloaded' })
  await page.locator('#rewritten-script').waitFor({ state: 'attached' })
  await page.getByRole('tab', { name: '公众号', exact: true }).click()
  const panel = page.getByRole('region', { name: '微信公众号文章', exact: true })
  await panel.getByRole('button', { name: '刷新文章', exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.article-panel button')].some(button => button.textContent.trim() === '刷新文章' && !button.disabled))
  return { browser, page, panel, source, writes, reads, mutations, uploads, releasePost,
    recoverGet: () => { badGet = undefined },
    setState: value => { state = structuredClone(value) },
    setDelivery: value => { delivery = { ...delivery, ...structuredClone(value) } },
  }
}

test('independent article adaptation has no length selector, submits an empty command once and preserves editor image timing', async () => {
  const h = await harness()
  try {
    await h.panel.getByRole('heading', { name: '微信公众号文章', exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('combobox').count(), 0)
    assert.equal(await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).isEnabled(), true)
    await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).click()
    await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).waitFor()
    assert.deepEqual(h.writes, [{}])
    assert.equal(await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).isEnabled(), false)
    h.setState({ ...idle, status: 'completed', article })
    await h.panel.getByText('正文 1980 字 · 1 张配图', { exact: true }).waitFor()
    assert.equal(await h.panel.getByText(/压缩|原文摘录|短原文不扩写|目标篇幅|2000/).count(), 0)
    assert.equal(await h.panel.getByRole('link', { name: '下载图文 HTML', exact: true }).getAttribute('href'), '/api/v1/history-scripts/101/article/export?format=html')
    assert.equal(await h.panel.locator('iframe').getAttribute('sandbox'), '')
    await h.page.frameLocator('iframe[title="公众号文章排版预览"]').getByText('原文中的因果关系。', { exact: true }).waitFor()
    await h.panel.getByRole('button', { name: '查看文字', exact: true }).click()
    assert.match(await h.panel.locator('pre').innerText(), /原文中的因果关系/)
    const records = h.panel.locator('details.generation-notes')
    assert.equal(await records.getAttribute('open'), null)
    assert.equal(await records.getByText(article.notices[0], { exact: true }).isVisible(), false)
    await records.locator('summary').getByText('生成记录', { exact: true }).click()
    await records.getByText(article.notices[0], { exact: true }).waitFor()
    await h.panel.locator('details.article-images > summary').click()
    await h.panel.getByText('配图与截取时间（仅供编辑核对，1 张）', { exact: true }).waitFor()
    await h.panel.getByText('1：35', { exact: true }).waitFor()
    if (process.env.HISTORY_UI_SCREENSHOT_DIR) await h.page.screenshot({ path: `${process.env.HISTORY_UI_SCREENSHOT_DIR}/history-article.png` })
  } finally { await h.browser.close() }
})

test('outbox queued articles disable duplicate generation while idle and poll through generating to completed without a POST', async () => {
  const h = await harness({ ...idle, articleGeneration: { status: 'queued', message: '文章已排队' } }, { clock: true })
  try {
    await h.panel.getByText('成片已关联，文章等待生成。', { exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '等待生成…', exact: true }).isEnabled(), false)
    const initialReads = h.reads.length
    h.setState({ ...idle, articleGeneration: { status: 'generating', message: '后台任务已领取' } })
    await h.page.clock.fastForward(2600)
    await h.panel.getByText('正在生成公众号文章。', { exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).isEnabled(), false)
    h.setState({ ...idle, status: 'generating', canGenerate: false, articleGeneration: { status: 'generating', message: '正在整理正文与配图' } })
    await h.page.clock.fastForward(2600)
    assert.equal(await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).isEnabled(), false)
    h.setState({ ...idle, status: 'completed', article, articleGeneration: { status: 'completed', message: '文章已生成' } })
    await h.page.clock.fastForward(2600)
    await h.panel.getByRole('heading', { name: article.title, exact: true }).waitFor()
    await h.panel.getByRole('link', { name: '下载图文 HTML', exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '重新生成公众号文章', exact: true }).isEnabled(), true)
    assert.ok(h.reads.length >= initialReads + 3)
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.mutations, [])
  } finally { await h.browser.close() }
})

test('an outbox failure before the model starts shows its message and only a manual retry generates an article', async () => {
  const message = '成片自动生成文章失败：视频读取暂不可用，请重试'
  const h = await harness({ ...idle, articleGeneration: { status: 'failed', message } }, { clock: true })
  try {
    await h.panel.getByRole('alert').waitFor()
    assert.equal(await h.panel.getByRole('alert').innerText(), message)
    const generate = h.panel.getByRole('button', { name: '生成公众号文章', exact: true })
    assert.equal(await generate.isEnabled(), true)
    assert.equal(await h.panel.getByText('正在生成公众号文章。', { exact: true }).count(), 0)
    const initialReads = h.reads.length
    await h.page.clock.fastForward(5200)
    assert.equal(h.reads.length, initialReads)
    assert.deepEqual(h.mutations, [], 'a failed outbox task must not retry a paid generation automatically')
    await generate.click()
    await h.panel.getByText('正在生成公众号文章。', { exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).isEnabled(), false)
    assert.equal(await h.panel.getByRole('alert').count(), 0)
    assert.deepEqual(h.writes, [{}])
    h.setState({ ...idle, status: 'completed', article, articleGeneration: { status: 'completed', message: '文章已生成' } })
    await h.page.clock.fastForward(2600)
    await h.panel.getByRole('link', { name: '下载图文 HTML', exact: true }).waitFor()
    assert.deepEqual(h.mutations, [{ path: '/api/v1/history-scripts/101/article', method: 'POST' }])
  } finally { await h.browser.close() }
})

for (const uploadStatus of ['queued', 'generating']) {
  test(`a manually uploaded video with ${uploadStatus} article generation reaches completion and opens the article without losing manuscript or cover drafts`, async () => {
    const h = await harness({ ...idle, canGenerate: false, unavailableReason: '请先关联成片' }, { clock: true, uploadStatus })
    try {
      const { page } = h
      await page.getByRole('tab', { name: '文稿', exact: true }).click()
      const editor = await page.locator('#rewritten-script').elementHandle()
      const draft = '  手动上传成片时尚未保存的文稿\n\n第二段保留空格。  \n'
      await editor.fill(draft)
      await page.getByRole('tab', { name: '成片与封面', exact: true }).click()
      const outputs = page.getByRole('region', { name: '成片与封面', exact: true })
      const fields = [
        ['视频号短标题', '未保存的封面标题'], ['百家号标题', '未保存的百家号标题'],
        ['视频号描述', '未保存的简介\n第二段。'], ['画面提示词', '尚未保存的明朝街巷场景'],
      ]
      for (const [name, value] of fields) await outputs.getByRole('textbox', { name, exact: true }).fill(value)
      const title = await outputs.getByRole('textbox', { name: '视频号短标题', exact: true }).elementHandle()
      const file = { name: '明朝成片.mp4', mimeType: 'video/mp4', buffer: Buffer.from('finished-video-upload-fixture') }
      await outputs.getByLabel('提交成片', { exact: true }).setInputFiles(file)
      await outputs.getByText(uploadStatus === 'queued' ? '成片已关联，公众号文章已进入生成队列' : '成片已关联，公众号文章正在生成', { exact: true }).waitFor()
      await outputs.getByText(uploadStatus === 'queued' ? '公众号文章排队中' : '公众号文章生成中…', { exact: true }).waitFor()
      await outputs.getByText(file.name, { exact: true }).waitFor()
      assert.equal(await outputs.locator('video').getAttribute('src'), '/api/v1/history-scripts/101/delivery/video')
      assert.equal(await outputs.getByLabel('更换成片', { exact: true }).isEnabled(), true)
      assert.equal(h.uploads.length, 1)
      assert.deepEqual(h.uploads[0].body, file.buffer)
      assert.equal(h.uploads[0].headers['x-file-name'], encodeURIComponent(file.name))
      assert.equal(h.uploads[0].headers['content-type'], 'application/octet-stream')

      const openArticle = async () => {
        const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/history-scripts/101/article')
        await outputs.getByRole('button', { name: '查看公众号', exact: true }).click()
        await refreshed
        const tab = page.getByRole('tab', { name: '公众号', exact: true })
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
        assert.equal(await tab.evaluate(element => element === document.activeElement), true)
      }
      await openArticle()
      await h.panel.getByText(uploadStatus === 'queued' ? '成片已关联，文章等待生成。' : '正在生成公众号文章。', { exact: true }).waitFor()
      assert.equal(await h.panel.getByRole('button', { name: uploadStatus === 'queued' ? '等待生成…' : '正在改写与排版…', exact: true }).isEnabled(), false)
      await page.getByRole('tab', { name: '成片与封面', exact: true }).click()
      h.setDelivery({ articleGeneration: { status: 'generating', message: '正在整理正文与配图' } })
      h.setState({ ...idle, status: 'generating', canGenerate: false, articleGeneration: { status: 'generating', message: '正在整理正文与配图' } })
      await page.clock.fastForward(3100)
      await outputs.getByText('公众号文章生成中…', { exact: true }).waitFor()
      for (const [name, value] of fields) assert.equal(await outputs.getByRole('textbox', { name, exact: true }).inputValue(), value)
      h.setDelivery({ articleGeneration: { status: 'completed', message: '文章已生成，可查看排版' } })
      h.setState({ ...idle, status: 'completed', article, articleGeneration: { status: 'completed', message: '文章已生成，可查看排版' } })
      await page.clock.fastForward(3100)
      await outputs.getByText('公众号文章已生成', { exact: true }).waitFor()
      await outputs.getByText('成片已关联，公众号文章已生成', { exact: true }).waitFor()
      await openArticle()
      await h.panel.getByRole('heading', { name: article.title, exact: true }).waitFor()
      await h.panel.getByRole('link', { name: '下载图文 HTML', exact: true }).waitFor()
      await page.getByRole('tab', { name: '成片与封面', exact: true }).click()
      for (const [name, value] of fields) assert.equal(await outputs.getByRole('textbox', { name, exact: true }).inputValue(), value)
      assert.equal(await outputs.getByRole('textbox', { name: '封面主标题', exact: true }).inputValue(), fields[0][1])
      assert.equal(await title.evaluate(element => element === document.querySelector('#history-delivery-101 textarea')), true)
      await page.getByRole('tab', { name: '文稿', exact: true }).click()
      assert.equal(await page.locator('#rewritten-script').inputValue(), draft)
      assert.equal(await editor.evaluate(element => element === document.querySelector('#rewritten-script')), true)
      assert.equal(await page.locator('.summary-copy .script-id').textContent(), '脚本 #101')
      assert.equal(h.source.rewrittenScript, '成片口播稿。')
      assert.equal(h.uploads.length, 1)
      assert.deepEqual(h.writes, [])
      assert.deepEqual(h.mutations, [{ path: '/api/v1/history-scripts/101/delivery/video', method: 'PUT' }])
    } finally { await h.browser.close() }
  })
}

test('missing finished video blocks article generation and explains the requirement', async () => {
  const h = await harness({ ...idle, canGenerate: false, unavailableReason: '请先在成片与封面中关联最终成片' })
  try {
    await h.panel.getByText('请先在成片与封面中关联最终成片', { exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).isEnabled(), false)
    assert.equal(h.writes.length, 0)
  } finally { await h.browser.close() }
})

test('regenerating a legacy article ignores its stored target length and sends no length constraint', async () => {
  const h = await harness({ ...idle, status: 'completed', article })
  try {
    await h.panel.getByText('正文 1980 字 · 1 张配图', { exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('combobox').count(), 0)
    assert.equal(await h.panel.getByText(/目标篇幅|约 2000 字|原文摘录样稿|短原文不扩写/).count(), 0)
    await h.panel.getByRole('button', { name: '重新生成公众号文章', exact: true }).click()
    await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).waitFor()
    assert.deepEqual(h.writes, [{}])
  } finally { await h.browser.close() }
})

test('opening the article during a pending generation receipt keeps the single submission locked', async () => {
  const h = await harness(idle, { holdPost: true })
  try {
    await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).click()
    await h.page.getByRole('tab', { name: '文稿', exact: true }).click()
    await h.page.getByRole('tab', { name: '公众号', exact: true }).click()
    const pending = h.panel.getByRole('button', { name: '正在改写与排版…', exact: true })
    assert.equal(await pending.isDisabled(), true)
    h.releasePost()
    await h.page.waitForResponse(response => response.url().endsWith('/article') && response.request().method() === 'POST')
    assert.equal(await pending.isDisabled(), true)
    assert.deepEqual(h.writes, [{}])
  } finally { h.releasePost(); await h.browser.close() }
})

for (const badGet of ['empty', 'truncated']) {
  test(`article ${badGet} response gives an actionable error and refresh recovers`, async () => {
    const h = await harness(idle, { badGet })
    try {
      await h.panel.getByRole('alert').waitFor()
      assert.match(await h.panel.getByRole('alert').innerText(), /文章服务响应不完整.*502.*刷新文章/)
      h.recoverGet()
      await h.panel.getByRole('button', { name: '刷新文章', exact: true }).click()
      await h.panel.getByRole('alert').waitFor({ state: 'hidden' })
      assert.equal(await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).isEnabled(), true)
      assert.equal(h.writes.length, 0)
    } finally { await h.browser.close() }
  })
}

test('empty generation response recovers the actual task error without masking it or posting twice', async () => {
  const h = await harness(idle, { emptyPostResponse: true })
  try {
    await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).click()
    await h.panel.getByRole('alert').filter({ hasText: '文章生成服务暂不可用，请重试' }).waitFor()
    assert.deepEqual(h.writes, [{}])
    assert.doesNotMatch(await h.panel.getByRole('alert').innerText(), /JSON|响应不完整/)
  } finally { await h.browser.close() }
})

for (const scenario of ['postConflict', 'lostResponse']) {
  test(`article status recovers after ${scenario} without repeating generation`, async () => {
    const h = await harness(idle, { [scenario]: true })
    try {
      await h.panel.getByRole('button', { name: '生成公众号文章', exact: true }).click()
      await h.panel.getByRole('button', { name: '正在改写与排版…', exact: true }).waitFor()
      h.setState({ ...idle, status: 'completed', article })
      await h.panel.getByRole('link', { name: '下载图文 HTML', exact: true }).waitFor()
      assert.equal(h.writes.length, 1)
      assert.equal(await h.panel.getByRole('alert').count(), 0)
    } finally { await h.browser.close() }
  })
}

test('stale articles retain preview while blocking copy and export until regenerated', async () => {
  const h = await harness({ ...idle, status: 'completed', article, stale: true, staleReasons: ['关联成片已更换'] })
  try {
    await h.panel.getByText(/文章需要重新生成后才能复制或导出/).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '复制到公众号', exact: true }).isEnabled(), false)
    assert.equal(await h.panel.getByRole('link', { name: '下载图文 HTML', exact: true }).count(), 0)
    assert.equal(await h.panel.locator('iframe').isVisible(), true)
    assert.equal(await h.panel.getByRole('button', { name: '重新生成公众号文章', exact: true }).isEnabled(), true)
  } finally { await h.browser.close() }
})

test('generation failure retains the previous article and offers a retry', async () => {
  const h = await harness({ ...idle, status: 'failed', article, error: '文章生成未完成，请重新生成' })
  try {
    await h.panel.getByRole('alert').filter({ hasText: '文章生成未完成，请重新生成' }).waitFor()
    assert.equal(await h.panel.locator('iframe').isVisible(), true)
    assert.equal(await h.panel.getByRole('button', { name: '重新生成公众号文章', exact: true }).isEnabled(), true)
    await h.page.setViewportSize({ width: 375, height: 812 })
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  } finally { await h.browser.close() }
})
