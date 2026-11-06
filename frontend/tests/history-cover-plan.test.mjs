import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const output = '/tmp/history-delivery-ui-v2'
mkdirSync(output, { recursive: true })
const original = '朱棣1399年起兵 為何三年就打進南京？｜助眠睡前歷史故事'
const title = '朱棣1399年起兵 為何三年就打進南京？'
const video = (id, producer) => ({ id, scriptId: 101, scriptSha256: 'current', producer,
  videoUrl: `/test-media/${producer}-${id}.mp4`, videoName: `${producer}-${id}.mp4`, duration: 92, createdAt: '2026-10-28T08:00:00.000Z' })
function fixture() {
  const candidate = { id: 'one', method: '采集原标题改写', main_title: '三年打進南京', sub_title: '朱棣的靖難之役', kicker: '明朝',
    image_prompt: '明朝军队行进与南京城门，标题区域留白', accent_color: '#c99b52', enhanced_prompt: '明朝军队与城门', rationale: '围绕原题事件设计封面',
    why_click: '三年起兵与抵达南京的进程', viewer_question: '朱棣如何打进南京？', payoff: '理解靖难之役的过程',
    evidence: ['朱棣1399年起兵，三年后打进南京。'], visual_concept: '明朝军队与南京城门', baijiahao_title: title, video_title: title }
  const huasheng = video(10, 'huasheng'), motion = video(11, 'motion')
  const delivery = { title, baijiahaoTitle: title, description: '旧简介保留在数据中', videoUrl: huasheng.videoUrl, videoName: huasheng.videoName,
    videos: [huasheng, motion], videoHistory: [motion, huasheng, { ...video(8, 'motion'), scriptSha256: 'old' }],
    covers: { '4:3': '/test-media/old-cover.png' }, coverStatus: 'idle', coverPlanStatus: 'selected', designStatus: 'idle',
    coverDesign: { main_title: candidate.main_title, sub_title: candidate.sub_title, kicker: candidate.kicker, ai_prompt: candidate.image_prompt, accent_color: candidate.accent_color },
    coverPlan: { version: 'history-cover-plan-v1', publishing_version: 'source-title-v2', selection_mode: 'source-title', selected_id: 'one',
      selection_reason: '原标题改写，独立封面', candidates: [candidate], reviews: [], script_sha256: 'current', design_sha256: 'design',
      source_title_rewrite: { source_title: original, title, keywords: [{ text: '朱棣', kind: 'person' }, { text: '1399年', kind: 'time' }, { text: '三年', kind: 'number' }], removed_promotions: ['助眠睡前歷史故事'] } },
  }
  return { ...delivery, videoId: null, videoPackagings: [
    { ...delivery, videoId: huasheng.id, producer: huasheng.producer },
    { ...delivery, videoId: motion.id, producer: motion.producer, title: '朱棣三年攻入南京 关键决定发生在哪一夜？',
      baijiahaoTitle: '朱棣三年攻入南京 关键决定发生在哪一夜？', coverPlan: null, coverPlanStatus: 'missing',
      coverDesign: { main_title: '南京城下的决定', sub_title: '靖难之役', kicker: '明朝', ai_prompt: '南京城外的明朝军队，右侧人物，左侧标题留白' },
      covers: { '16:9': '/test-media/motion-cover.png' }, coverStatus: 'completed' },
  ] }
}

async function harness(t, options = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 1000 } })
  page.setDefaultTimeout(10000)
  const delivery = { ...fixture(), ...options.delivery }, writes = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  const source = { id: 101, title: original, authorName: '测试频道', category: 'historical_anecdote', status: 'needs_review',
    rawTranscript: '原始稿', correctedTranscript: '校对稿', rewrittenScript: '朱棣1399年起兵，三年后打进南京。', revision: 'revision-101',
    updatedAt: '2026-10-28T00:00:00Z', metricsJson: '{}', mediaJson: '{}', selectionJson: '{}', reviewJson: '{}',
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' } }
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), requestUrl = new URL(request.url()), pathname = requestUrl.pathname
    let data = { items: [] }
    if (pathname.startsWith('/api/v1/history-scripts/101/delivery')) {
      const videoId = Number(requestUrl.searchParams.get('video_id'))
      const selected = delivery.videoPackagings?.find(item => item.videoId === videoId) || delivery
      if (request.method() !== 'GET') {
        const body = request.postDataJSON()
        writes.push({ path: pathname, videoId: videoId || null, method: request.method(), body })
        if (pathname.endsWith('/design/review') && options.reviewFailure) return route.fulfill({ status: 422, json: { code: 422, message: '审核服务暂时不可用' } })
        if (pathname.endsWith('/design')) {
          if (options.designFailure) return route.fulfill({ status: 422, json: { code: 422, message: '生成服务暂时不可用，原方案保持不变。' } })
          const generated = fixture().videoPackagings.find(item => item.videoId === videoId) || fixture()
          Object.assign(selected, generated, { designStatus: 'completed' })
        } else {
          Object.assign(selected, body)
          if (pathname.endsWith('/covers')) selected.coverStatus = 'generating'
        }
      }
      data = { ...delivery, ...selected }
    } else if (pathname === '/api/v1/history-scripts/101') data = source
    else if (pathname === '/api/v1/history-scripts') data = { items: [source], total: 1 }
    else if (pathname === '/api/v1/history-scripts/jobs') data = { job: null, recent: [] }
    await route.fulfill({ json: { code: 200, data } })
  })
  await page.route('**/test-media/**', route => route.fulfill({ status: 200, body: '', contentType: 'video/mp4' }))
  await page.goto(`${baseUrl}/history-scripts?script=101`, { waitUntil: 'domcontentloaded' })
  await page.locator('#rewritten-script').waitFor({ state: 'attached' })
  await page.getByRole('tab', { name: '成片与封面', exact: true }).click()
  const panel = page.locator('#history-delivery-101')
  await panel.getByRole('textbox', { name: '百家号视频标题', exact: true }).waitFor()
  return { browser, page, panel, delivery, writes, errors }
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
  test(`two video versions and the shared publishing-cover title work at ${viewport.width}px`, async t => {
    const h = await harness(t, { viewport })
    assert.equal(await h.panel.locator('video').count(), 1)
    assert.equal(await h.panel.locator('video').getAttribute('src'), '/test-media/huasheng-10.mp4')
    await h.panel.getByRole('button', { name: /精细化版/ }).click()
    assert.equal(await h.panel.locator('video').count(), 1)
    assert.equal(await h.panel.locator('video').getAttribute('src'), '/test-media/motion-11.mp4')
    assert.equal(await h.panel.getByRole('link', { name: '下载此版本' }).getAttribute('href'), '/test-media/motion-11.mp4')
    assert.equal(await h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true }).inputValue(), '朱棣三年攻入南京 关键决定发生在哪一夜？')
    assert.equal(await h.panel.getByRole('textbox').count(), 1)
    assert.equal(await h.panel.getByRole('textbox', { name: '封面主标题', exact: true }).count(), 0)
    assert.equal(await h.panel.getByRole('textbox', { name: '画面提示词', exact: true }).count(), 0)
    assert.equal(await h.panel.getByRole('img', { name: '横版 16:9封面', exact: true }).getAttribute('src'), '/test-media/motion-cover.png')
    assert.match(await h.panel.locator('.cover-editor legend').innerText(), /精细化版/)
    assert.equal(await h.panel.getByRole('textbox', { name: /视频号/ }).count(), 0)
    assert.equal(await h.panel.getByRole('button', { name: /公众号/ }).count(), 0)
    assert.equal(await h.panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
    await h.panel.locator('.cover-editor').scrollIntoViewIfNeeded()
    await h.page.screenshot({ path: `${output}/delivery-${viewport.width}.png`, fullPage: false })
    await h.panel.locator('.video-history summary').click()
    assert.equal(await h.panel.locator('.video-history a').getAttribute('href'), '/test-media/motion-8.mp4')
    assert.deepEqual(h.errors, [])
  })
}

test('saving uses the publishing title for the screenshot cover without resending a legacy description', async t => {
  const h = await harness(t)
  const publishing = h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true })
  await publishing.fill('朱棣1399年起兵 三年如何攻到南京？')
  const saved = h.page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).pathname.endsWith('/delivery') && new URL(response.url()).searchParams.get('video_id') === '10')
  await h.panel.getByRole('button', { name: '保存标题', exact: true }).click()
  await saved
  const body = h.writes.at(-1).body
  assert.equal(h.writes.at(-1).videoId, 10)
  assert.equal(body.title, '朱棣1399年起兵 三年如何攻到南京？')
  assert.equal(body.baijiahaoTitle, body.title)
  assert.equal(body.coverDesign.main_title, body.title)
  assert.equal(body.coverDesign.sub_title, '')
  assert.equal(body.coverDesign.kicker, '')
  assert.equal(body.coverDesign.ai_prompt, '')
  assert.equal(body.coverDesign.thumbnail_layout, 'text-left')
  assert.equal('description' in body, false)
  assert.equal(h.delivery.description, '旧简介保留在数据中')
})

test('switching versions keeps each unsaved draft and writes only the currently selected package', async t => {
  const h = await harness(t)
  const publishing = h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true })
  await publishing.fill('朱棣花生版尚未保存的标题')
  await h.panel.getByRole('button', { name: /精细化版/ }).click()
  assert.equal(await publishing.inputValue(), '朱棣三年攻入南京 关键决定发生在哪一夜？')
  await publishing.fill('朱棣精细化版单独保存')
  const saved = h.page.waitForResponse(response => response.request().method() === 'PUT'
    && new URL(response.url()).searchParams.get('video_id') === '11')
  await h.panel.getByRole('button', { name: '保存标题', exact: true }).click()
  await saved
  await h.panel.getByRole('button', { name: /花生版/ }).click()
  assert.equal(await publishing.inputValue(), '朱棣花生版尚未保存的标题')
  assert.deepEqual(h.writes.map(item => item.videoId), [11])
  assert.equal(h.delivery.videoPackagings.find(item => item.videoId === 10).baijiahaoTitle, title)
})

test('an unprepared video never displays the legacy shared title and cover', async t => {
  const initial = fixture()
  initial.videoPackagings[0] = { videoId: 10, producer: 'huasheng', title: '', baijiahaoTitle: '',
    coverDesign: { main_title: '', sub_title: '', kicker: '', ai_prompt: '' }, covers: {}, coverStatus: 'idle', designStatus: 'idle' }
  const h = await harness(t, { delivery: initial })
  assert.equal(await h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true }).inputValue(), '')
  assert.equal(await h.panel.getByRole('textbox', { name: '封面主标题', exact: true }).count(), 0)
  assert.equal(await h.panel.locator('.covers img').count(), 0)
  assert.equal(await h.panel.getByRole('button', { name: '生成截图封面', exact: true }).isDisabled(), true)
  assert.match(await h.panel.locator('.version-tab').first().innerText(), /待生成/)
})

test('source-title records expose the actual source, removed promotion and preserved keywords without a missing-review warning', async t => {
  const h = await harness(t)
  await h.panel.locator('.plan-details > summary').click()
  const record = h.panel.locator('.source-title-record')
  assert.match(await record.innerText(), /朱棣1399年起兵/)
  assert.match(await record.innerText(), /助眠睡前歷史故事/)
  assert.match(await record.innerText(), /保留关键词/)
  assert.equal(await h.panel.getByText('缺少审核记录。', { exact: true }).count(), 0)
  assert.equal(await h.panel.getByRole('button', { name: '生成截图封面', exact: true }).isEnabled(), true)
})

test('screenshot-v3 records show the original and cleaned title without legacy creative planning', async t => {
  const initial = fixture()
  const selected = initial.videoPackagings[0]
  selected.coverPlan = { ...selected.coverPlan, publishing_version: 'source-screenshot-v3',
    source_title_cleanup: { source_title: `第12集 ${original}`, cleaned_title: title } }
  delete selected.coverPlan.source_title_rewrite
  const h = await harness(t, { delivery: initial })
  await h.panel.locator('.plan-details > summary').click()
  const record = h.panel.locator('.source-title-record')
  assert.equal(await record.getByText(`第12集 ${original}`, { exact: true }).count(), 1)
  assert.equal(await record.getByText(title, { exact: true }).count(), 1)
  assert.doesNotMatch(await h.panel.locator('.plan-details').innerText(), /为什么想点|观众会追问|看完得到什么|画面构思|保留关键词/)
  assert.deepEqual(h.errors, [])
})

test('a complete overlong publishing title is preserved for editing with only the Baijiahao warning', async t => {
  const h = await harness(t)
  const publishing = h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true })
  const longTitle = '朱棣' + '明'.repeat(40)
  await publishing.fill(longTitle)
  await h.panel.getByRole('status', { name: '发布格式提醒' }).waitFor()
  assert.equal(await publishing.inputValue(), longTitle)
  assert.match(await h.panel.locator('.publishing-warnings').innerText(), /40字上限/)
  assert.doesNotMatch(await h.panel.locator('.publishing-warnings').innerText(), /16字/)
})

test('screenshot production uses the visible title and needs no image prompt or optional review', async t => {
  const initial = fixture()
  initial.videoPackagings[0].coverDesign = { main_title: '', sub_title: '', kicker: '', ai_prompt: '' }
  const h = await harness(t, { delivery: initial })
  await h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true }).fill('朱棣1399年起兵 三年如何攻到南京？')
  assert.equal(await h.panel.getByRole('button', { name: '审核当前方案', exact: true }).count(), 0)
  await h.panel.getByRole('button', { name: '生成截图封面', exact: true }).click()
  await h.panel.getByRole('button', { name: '截图封面生成中…', exact: true }).waitFor()
  assert.equal(h.writes.at(-1).body.coverDesign.main_title, '朱棣1399年起兵 三年如何攻到南京？')
  assert.equal(h.writes.at(-1).body.coverDesign.ai_prompt, '')
  assert.equal(await h.panel.getByRole('button', { name: '截图封面生成中…', exact: true }).isDisabled(), true)
})

test('failed title cleanup retains the current unsaved title', async t => {
  const h = await harness(t, { designFailure: true })
  await h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true }).fill('尚未保存的原标题')
  await h.panel.getByRole('button', { name: '整理原标题', exact: true }).click()
  await h.panel.getByText('生成服务暂时不可用，原方案保持不变。', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('textbox', { name: '百家号视频标题', exact: true }).inputValue(), '尚未保存的原标题')
  assert.deepEqual(h.writes.map(item => item.path), ['/api/v1/history-scripts/101/delivery/design'])
})
