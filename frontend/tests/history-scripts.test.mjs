import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'

function fixture(id) {
  return {
    id, title: `历史测试稿 ${id}`, authorName: '测试作者', category: 'historical_anecdote',
    status: 'needs_review', sourceUrl: 'https://www.douyin.com/video/123',
    rawTranscript: '原始转写内容', correctedTranscript: '校对后的内容', rewrittenScript: '数据库里的改写稿',
    revision: String(id).padStart(64, '0'), updatedAt: '2026-10-14T07:00:00.000Z',
    metricsJson: '{"comments":37}', mediaJson: '{}', selectionJson: '{}',
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', factualConcerns: [{ claim: '待核查史实', reason: '需要史料' }], manualRewriteReview: { concerns: [{ before: '增加气味', after: '去除气味', reason: '语义反转' }] } }),
    videoAvailable: false, videoUrl: null,
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
    workflowState: { videoCompleted: false, titlePlanGenerated: false, coverGenerated: false, motionGenerated: false },
  }
}

function perspectivePlan() {
  return {
    sourceSha256: 'a'.repeat(64), skillRevision: 'history-perspective-recreation-v1', model: 'gpt-6.1-sol',
    analysis: {
      coreViewpoint: '原文把一次转移归因于一个人的情报。',
      storyStructure: [{ stage: '开头', content: '用身份反差提出问题。' }, { stage: '转折', content: '情报改变决策时限。' }],
      emotionArc: [{ stage: '悬念', emotion: '疑惑', trigger: '乞丐身份与重要情报形成反差。' }, { stage: '释放', emotion: '理解', trigger: '解释情报如何进入决策。' }],
      factsToPreserve: ['情报由专人送达。'],
    },
    angles: [
      { id: 'opposing', title: '决定行动的不是一个人', stance: '把集体决策放回故事中心。', contrast: '从个人传奇转向协作条件。', evidence: ['原文提到军委商议。'], outline: ['从决策现场的时间压力开场。', '回溯情报如何送达。'] },
      { id: 'counterintuitive', title: '消息比兵力更先改变局面', stance: '重要的是多获得了多少行动时间。', contrast: '从力量大小转向时间差。', evidence: ['原文提到提前转移。'], outline: ['先讲迟一步的代价。', '再讲情报的作用。'] },
      { id: 'conflict', title: '保密与及时送达的冲突', stance: '隐蔽身份与送达速度彼此拉扯。', contrast: '把传奇身份拆成实际困难。', evidence: ['原文记载了伪装送信。'], outline: ['先写必须到达的压力。', '再写身份带来的阻力。'] },
    ],
    selectedAngleId: 'counterintuitive', selectionReason: '时间差有原文依据，也能形成新的叙事起点。',
  }
}

function preparedPerspectivePlan() {
  const plan = perspectivePlan()
  return {
    ...plan,
    model: 'gpt-6.1-terra',
    analysis: {
      ...plan.analysis,
      authorStance: '强调送信者承担的风险，但不能省略共同决策的条件。',
      background: [{ id: 'background-1', content: '转移必须在敌军封锁之前开始。', whyNeeded: '先交代时间压力，才听得懂送信为何关键。' }],
      sourceOutline: [{ id: 'source-1', summary: '身份反差引出送信者。' }, { id: 'source-2', summary: '情报送达后决定转移。' }],
      evidence: [{ id: 'evidence-1', material: '情报提前送达，军委商议后安排转移。', supports: '情报争取了决策时间。', limitation: '不能据此将决策全部归功于个人。' }],
      emotionArc: plan.analysis.emotionArc.map((beat, index) => ({ ...beat, id: `emotion-${index + 1}` })),
    },
    writingOutline: {
      thesis: '情报的价值是给决策多留出行动时间。',
      stance: '保留送信者的贡献，把他的风险与集体行动联系起来。',
      sections: [
        { id: 'section-1', purpose: '建立问题与压力', newInformation: '先交代封锁时限，再解释必须把消息送进决策现场。', backgroundIds: ['background-1'], evidenceIds: [], emotionIds: ['emotion-1'] },
        { id: 'section-2', purpose: '用结果兑现判断', newInformation: '说明提前获知情报怎样使商议和转移成为可能。', backgroundIds: [], evidenceIds: ['evidence-1'], emotionIds: ['emotion-2'] },
      ],
      endingPayoff: '回到开头的时间压力，说明个人冒险如何换来集体行动窗口。',
    },
  }
}

async function harness(options = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  // External font latency must not hold these mocked interaction tests at the load event.
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  const sources = options.sources || Array.from({ length: options.count ?? 2 }, (_, index) => fixture(101 + index))
  const listRequests = []
  if (options.cleanedMedia) sources[0].mediaJson = JSON.stringify({ cleanup: options.cleanedMedia })
  if (options.imageNote) Object.assign(sources[0], {
    sourceUrl: 'https://www.douyin.com/note/123',
    mediaJson: JSON.stringify({ kind: 'note', images: [{ sha256: 'a'.repeat(64) }] }),
    reviewJson: JSON.stringify({ draftOrigin: 'light_edit', recreation: { model: 'gpt-6-luna' } }),
  })
  if (options.correctedDraft) Object.assign(sources[0], {
    rewrittenScript: sources[0].correctedTranscript,
    reviewJson: JSON.stringify({ draftOrigin: 'corrected_transcript', factCheckStatus: 'needs_sources', factualConcerns: [] }),
  })
  if (options.recreatedDraft) Object.assign(sources[0], {
    rewrittenScript: options.rewrittenScript ?? '二创后的口播正文。',
    reviewJson: JSON.stringify({
      draftOrigin: 'water_koubo', factCheckStatus: 'needs_sources', factualConcerns: [],
      recreation: { title: '苏轼为何五天才吃上韭菜？', coverText: '吃口韭菜等五天', skillName: 'water-koubo', skillRevision: 'pinned-revision', skillSha256: 'pinned-sha256', model: 'test-text-model', lengthCheck: options.lengthCheck, ...options.recreationMetadata },
    }),
  })
  if (options.perspectiveDraft || options.perspectivePending) Object.assign(sources[0], {
    rewrittenScript: options.perspectivePending ? null : '从时间差重新讲述的完整二创正文。',
    status: options.perspectivePending ? 'failed' : 'needs_review',
    artifactState: { transcript: 'current', corrected: 'current', rewritten: options.perspectivePending ? 'missing' : 'current' },
    reviewJson: JSON.stringify(options.perspectivePending
      ? { recreationPlan: options.recreationPlan || perspectivePlan(), factCheckStatus: 'needs_sources' }
      : { draftOrigin: 'perspective_recreation', recreation: { ...(options.recreationPlan || perspectivePlan()), skillName: 'history-perspective-recreation' }, factCheckStatus: 'needs_sources' }),
  })
  if (options.processing) Object.assign(sources[0], {
    status: 'rewriting', rewrittenScript: null,
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'missing' },
  })
  if (options.clock) await page.clock.install()
  let conflict = false
  let failSave = false
  let saveCount = 0
  let deleteFailure = 0
  const deletions = []
  await page.route('**/api/v1/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (/\/history-scripts\/\d+\/images\/\d+$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQkAAAAASUVORK5CYII=', 'base64') })
    }
    if (url.pathname === '/api/v1/history-scripts/jobs') {
      if (request.method() === 'GET') {
        return route.fulfill({ json: { code: 200, data: { job: null, recent: [] }, message: 'success' } })
      }
      if (request.method() === 'POST') {
        return route.fulfill({ json: { code: 200, data: { job: null, created: false }, message: 'success' } })
      }
    }
    if (/^\/api\/v1\/history-scripts\/jobs\/[^/]+(?:\/stop)?$/.test(url.pathname)) {
      return route.fulfill({ json: { code: 200, data: { job: null }, message: 'success' } })
    }
    const match = /^\/api\/v1\/history-scripts(?:\/(\d+))?$/.exec(url.pathname)
    let data = { items: [] }
    if (match && request.method() === 'GET') {
      const matches = sources.filter(item => {
        if (url.searchParams.get('q') && ![item.title, item.authorName, item.rawTranscript, item.correctedTranscript, item.rewrittenScript].some(value => value?.includes(url.searchParams.get('q')))) return false
        if (url.searchParams.get('category') && item.category !== url.searchParams.get('category')) return false
        if (url.searchParams.get('status') && item.status !== url.searchParams.get('status')) return false
        if (url.searchParams.get('upload') && item.workflowState?.uploadState !== url.searchParams.get('upload')) return false
        return [
          ['video', 'videoCompleted', 'completed'], ['titlePlan', 'titlePlanGenerated', 'generated'],
          ['cover', 'coverGenerated', 'generated'], ['motion', 'motionGenerated', 'generated'],
        ].every(([key, state, yes]) => !url.searchParams.get(key) || item.workflowState?.[state] === (url.searchParams.get(key) === yes))
      })
      if (!match[1]) listRequests.push(url.searchParams)
      data = match[1] ? sources.find(item => item.id === Number(match[1])) : {
        items: matches.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit') || 20)),
        total: matches.length,
      }
      if (match[1] && !data) {
        if (options.deletedSource?.id === Number(match[1])) {
          return route.fulfill({ status: 404, json: { code: 404, message: '稿件已删除', data: { reason: 'deleted', ...options.deletedSource } } })
        }
        return route.fulfill({ status: 404, json: { code: 404, message: 'History script not found' } })
      }
    } else if (match?.[1] && request.method() === 'DELETE') {
      const body = request.postDataJSON()
      const id = Number(match[1])
      deletions.push({ id, ...body })
      const source = sources.find(item => item.id === id)
      if (deleteFailure || body.expectedRevision !== source.revision) {
        const status = deleteFailure || 409
        return route.fulfill({ status, json: { code: status, message: status === 409 ? '脚本已更新，请重新读取后再删除' : '删除暂不可用，请重试' } })
      }
      sources.splice(sources.indexOf(source), 1)
      data = { id }
    } else if (match && request.method() === 'PATCH') {
      const body = request.postDataJSON()
      const source = sources.find(item => item.id === Number(match[1]))
      if (conflict || body.expectedRevision !== source.revision) {
        return route.fulfill({ status: 409, json: { code: 409, message: '版本冲突' } })
      }
      if (failSave) return route.fulfill({ status: 503, json: { code: 503, message: '网络暂不可用' } })
      saveCount += 1
      source.rewrittenScript = body.rewrittenScript
      source.revision = String(200 + saveCount).padStart(64, '0')
      data = source
    }
    await route.fulfill({ json: { code: 200, data, message: 'success' } })
  })
  try {
    await page.goto(`${baseUrl}${options.path || '/history-scripts?view=library'}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (options.expectDetail !== false) await page.locator('#rewritten-script').waitFor({ state: 'attached' })
  } catch (error) {
    await browser.close()
    throw error
  }
  return { browser, page, sources, deletions, listRequests, setDeleteFailure: value => { deleteFailure = value }, setConflict: value => { conflict = value }, setFailure: value => { failSave = value }, saves: () => saveCount }
}

test('comparison, review findings, save failure and database reload keep draft semantics', async () => {
  const h = await harness()
  try {
    const { page } = h
    assert.equal(await page.getByRole('tab', { name: '文稿', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByText('视频尚未下载', { exact: true }).isVisible(), false)
    await page.getByRole('tab', { name: /^来源与审阅/ }).click()
    await page.getByText('视频尚未下载', { exact: true }).waitFor()
    await page.getByRole('button', { name: /审稿提示/ }).click()
    await page.getByText('语义反转', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '文稿', exact: true }).click()
    await page.getByRole('button', { name: '原始转写', exact: true }).click()
    await page.getByText('原始转写内容', { exact: true }).waitFor()
    await page.getByRole('button', { name: '校对稿', exact: true }).click()
    await page.getByText('校对后的内容', { exact: true }).waitFor()
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    const text = '手动编辑的新稿\n\n第二段。\n'
    await editor.fill(text)
    h.setFailure(true)
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.locator('.save-error').waitFor()
    assert.equal(await editor.inputValue(), text)
    h.setFailure(false)
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    assert.equal(h.saves(), 1)
    await page.reload()
    await editor.waitFor()
    assert.equal(await editor.inputValue(), text)
    assert.equal(h.sources[0].rawTranscript, '原始转写内容')
    assert.equal(h.sources[0].status, 'needs_review')
  } finally { await h.browser.close() }
})

test('a cleaned source keeps its original video link and editable transcript available', async () => {
  const h = await harness({ cleanedMedia: { localReleasedAt: '2026-10-24T10:00:00.000Z', error: '下载器缓存清理待重试' } })
  try {
    const { page } = h
    assert.equal(await page.getByRole('textbox', { name: '编辑待审稿' }).isEnabled(), true)
    await page.getByRole('tab', { name: /^来源与审阅/ }).click()
    await page.getByText('转录已保存，来源视频已清理', { exact: true }).waitFor()
    assert.equal(await page.getByText('视频尚未下载', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('link', { name: '查看原视频', exact: true }).getAttribute('href'), h.sources[0].sourceUrl)
    assert.equal(await page.locator('.video-panel video').count(), 0)
    await page.getByText('下载器缓存清理待重试', { exact: true }).waitFor()
  } finally { await h.browser.close() }
})

test('an image note displays downloaded source images and the light edit provenance without a missing video warning', async () => {
  const h = await harness({ imageNote: true, viewport: { width: 390, height: 844 } })
  try {
    const { page } = h
    await page.getByRole('button', { name: /历史测试稿 101/ }).click()
    await page.getByRole('button', { name: '原文对照', exact: true }).click()
    await page.getByRole('button', { name: '图文原文', exact: true }).waitFor()
    assert.match(await page.locator('#draft-origin').textContent(), /gpt-6-luna.*轻度修改首尾/)
    await page.getByRole('tab', { name: /^来源与审阅/ }).click()
    const image = page.getByRole('img', { name: '来源图片 1', exact: true })
    await image.waitFor()
    await page.waitForFunction(() => document.querySelector('.note-image-grid img')?.naturalWidth > 0)
    assert.equal(await page.getByRole('link', { name: '查看原图文', exact: true }).getAttribute('href'), h.sources[0].sourceUrl)
    assert.equal(await page.getByText('视频尚未下载', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  } finally { await h.browser.close() }
})

test('perspective recreation exposes source analysis and three angles separately from the editable draft', async () => {
  const h = await harness({ perspectiveDraft: true })
  try {
    const { page } = h
    const plan = page.getByLabel('原文拆解与三个创作角度', { exact: true })
    assert.equal(await plan.getAttribute('open'), null)
    assert.match(await page.locator('#draft-origin').textContent(), /gpt-6.1-sol.*按新立场重新组织全文/)
    await plan.locator('summary').click()
    await plan.getByText('原文把一次转移归因于一个人的情报。', { exact: true }).waitFor()
    await plan.getByText('用身份反差提出问题。', { exact: false }).waitFor()
    await plan.getByText('乞丐身份与重要情报形成反差。', { exact: false }).waitFor()
    assert.equal(await plan.locator('.recreation-angles > li').count(), 3)
    assert.equal(await plan.getByText('已采用', { exact: true }).count(), 1)
    assert.match(await plan.locator('.recreation-angles > li.selected').textContent(), /反常识角度.*消息比兵力更先改变局面/)
    assert.match(await plan.textContent(), /时间差有原文依据，也能形成新的叙事起点/)
    const editor = page.getByRole('textbox', { name: '编辑待审稿', exact: true })
    assert.equal(await editor.inputValue(), '从时间差重新讲述的完整二创正文。')
    assert.ok((await editor.boundingBox()).height >= 100, 'Expanded analysis keeps room for the manuscript')
    assert.equal(await plan.evaluate(element => element.scrollHeight > element.clientHeight), true, 'Long analysis can scroll inside the editor layout')
    const metadata = h.sources[0].reviewJson
    await editor.fill('人工修改后的正文。')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    assert.equal(h.sources[0].reviewJson, metadata)
    assert.match(await plan.textContent(), /后续人工修改不会自动更新/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  } finally { await h.browser.close() }
})

test('a saved analysis checkpoint remains readable on mobile without claiming a completed draft', async () => {
  const h = await harness({ perspectivePending: true, viewport: { width: 390, height: 844 } })
  try {
    const { page } = h
    await page.getByRole('button', { name: /历史测试稿 101/ }).click()
    const plan = page.getByLabel('原文拆解与三个创作角度', { exact: true })
    await plan.locator('summary').click()
    assert.match(await plan.textContent(), /分析已完成，正文尚未完成/)
    assert.equal(await plan.locator('.recreation-angles > li').count(), 3)
    assert.equal(await plan.getByText('拟采用', { exact: true }).count(), 1)
    assert.equal(await plan.getByText('已采用', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('textbox', { name: '编辑待审稿', exact: true }).inputValue(), '')
    assert.ok((await page.locator('#rewritten-script').boundingBox()).height >= 60, 'Mobile analysis does not consume the whole editor')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  } finally { await h.browser.close() }
})

for (const mobile of [false, true]) test(`prepared recreation shows background, evidence and the new outline on ${mobile ? 'mobile' : 'desktop'}`, async () => {
  const h = await harness({ perspectiveDraft: !mobile, perspectivePending: mobile, recreationPlan: preparedPerspectivePlan(),
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } })
  try {
    const { page } = h
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    if (mobile) await page.getByRole('button', { name: /历史测试稿 101/ }).click()
    const analysis = page.getByLabel('原文拆解与三个创作角度', { exact: true })
    await analysis.locator('summary').click()
    assert.match(await analysis.textContent(), /原作者立场.*强调送信者承担的风险/)
    assert.match(await analysis.textContent(), /必要背景.*转移必须在敌军封锁之前开始/)
    assert.match(await analysis.textContent(), /原文大纲.*身份反差引出送信者/)
    assert.match(await analysis.textContent(), /材料与论证.*情报提前送达.*支持：情报争取了决策时间.*限定：不能据此/)
    const outline = analysis.getByLabel('新稿写作大纲', { exact: true })
    assert.match(await outline.textContent(), /新稿主张.*情报的价值是给决策多留出行动时间/)
    assert.match(await outline.textContent(), /新稿立场.*保留送信者的贡献/)
    assert.match(await outline.textContent(), /背景：转移必须在敌军封锁之前开始/)
    assert.match(await outline.textContent(), /材料：情报提前送达/)
    assert.match(await outline.textContent(), /情绪：疑惑/)
    assert.match(await outline.textContent(), /结尾兑现.*个人冒险如何换来集体行动窗口/)
    assert.doesNotMatch(await outline.textContent(), /background-1|evidence-1|emotion-1|section-1/)
    assert.equal(await page.getByRole('textbox', { name: '编辑待审稿', exact: true }).inputValue(), mobile ? '' : '从时间差重新讲述的完整二创正文。')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: `/tmp/history-recreation-outline-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true })
    await analysis.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: `/tmp/history-recreation-outline-${mobile ? 'mobile' : 'desktop'}-sections.png`, fullPage: true })
  } finally { await h.browser.close() }
})

test('a collected corrected transcript is an editable review draft and retains its origin after manual changes', async () => {
  const h = await harness({ correctedDraft: true })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    const origin = page.getByText('起稿方式：由校对稿直接保存，未进行自动改写；可继续人工编辑。', { exact: true })
    await origin.waitFor()
    assert.equal(await editor.inputValue(), '校对后的内容')
    assert.equal(await editor.isEnabled(), true)
    assert.equal(await editor.getAttribute('aria-describedby'), 'draft-origin')
    await editor.fill('人工调整后的待审稿')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    assert.equal(h.saves(), 1)
    assert.equal(h.sources[0].correctedTranscript, '校对后的内容')
    assert.equal(h.sources[0].status, 'needs_review')
    await page.reload()
    await origin.waitFor()
    assert.equal(await editor.inputValue(), '人工调整后的待审稿')
    await page.getByRole('button', { name: /历史测试稿 102/ }).click()
    await page.getByRole('heading', { name: '历史测试稿 102', exact: true }).waitFor()
    assert.equal(await origin.count(), 0)
    assert.equal(await editor.inputValue(), '数据库里的改写稿')
  } finally { await h.browser.close() }
})

test('source paraphrase drafts display meaning-preserving provenance and hide stale perspective plans', async () => {
  const source = fixture(101)
  const model = 'Qwen3.5-9B-Writing-DPO-i1-Q4_K_M'
  source.rewrittenScript = '依照原稿顺序重新表达的完整正文。'
  source.reviewJson = JSON.stringify({
    draftOrigin: 'source_paraphrase', factCheckStatus: 'needs_sources',
    recreation: { skillName: 'history-source-paraphrase', model },
    recreationPlan: preparedPerspectivePlan(),
  })
  const h = await harness({ sources: [source] })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿', exact: true })
    const origin = page.locator('#draft-origin')
    await origin.waitFor()
    assert.match(await origin.textContent(), /Qwen3\.5-9B-Writing-DPO-i1-Q4_K_M.*保持原意，调整表达与句间衔接/)
    assert.doesNotMatch(await origin.textContent(), /新立场|三个角度|相反立场/)
    assert.equal(await editor.inputValue(), source.rewrittenScript)
    assert.equal(await editor.isEnabled(), true)
    assert.equal(await editor.getAttribute('aria-describedby'), 'draft-origin')
    assert.equal(await page.getByLabel('原文拆解与三个创作角度', { exact: true }).count(), 0)
    assert.equal(await page.getByLabel('三个创作角度', { exact: true }).count(), 0)
    const metadata = source.reviewJson
    await editor.fill('人工调整后的完整口播正文。')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    assert.equal(source.reviewJson, metadata)
    await page.reload()
    await origin.waitFor()
    assert.equal(await editor.inputValue(), '人工调整后的完整口播正文。')
    assert.match(await origin.textContent(), /保持原意，调整表达与句间衔接/)
    assert.equal(await page.getByLabel('原文拆解与三个创作角度', { exact: true }).count(), 0)
  } finally { await h.browser.close() }
})

test('water-koubo drafts separate generated suggestions from source title and editable body, including after save', async () => {
  const h = await harness({ recreatedDraft: true })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    const origin = page.locator('#draft-origin')
    const suggestions = page.locator('details.recreation-summary')
    await suggestions.waitFor()
    assert.equal(await suggestions.getAttribute('open'), null)
    assert.equal(await suggestions.getByText('苏轼为何五天才吃上韭菜？', { exact: true }).isVisible(), false)
    await suggestions.locator('summary').getByText('标题与封面建议', { exact: true }).click()
    assert.match(await origin.textContent(), /water-koubo.*test-text-model.*仍需审阅/)
    assert.equal(await editor.getAttribute('aria-describedby'), 'draft-origin')
    assert.equal(await editor.inputValue(), '二创后的口播正文。')
    assert.match(await suggestions.textContent(), /苏轼为何五天才吃上韭菜？/)
    assert.match(await suggestions.textContent(), /吃口韭菜等五天/)
    await suggestions.getByText('二创标题', { exact: true }).waitFor()
    await suggestions.getByText('封面文字建议', { exact: true }).waitFor()
    await page.getByRole('heading', { name: '历史测试稿 101', exact: true }).waitFor()
    const metadata = h.sources[0].reviewJson
    await editor.fill('人工审阅调整后的二创正文。')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    assert.equal(h.sources[0].title, '历史测试稿 101')
    assert.equal(h.sources[0].correctedTranscript, '校对后的内容')
    assert.equal(h.sources[0].reviewJson, metadata)
    assert.equal(h.sources[0].status, 'needs_review')
    await page.reload()
    await suggestions.waitFor()
    assert.equal(await suggestions.getAttribute('open'), null)
    await suggestions.locator('summary').click()
    await suggestions.getByText('苏轼为何五天才吃上韭菜？', { exact: true }).waitFor()
    await suggestions.getByText('吃口韭菜等五天', { exact: true }).waitFor()
    assert.equal(await editor.inputValue(), '人工审阅调整后的二创正文。')
    assert.match(await origin.textContent(), /water-koubo.*test-text-model/)
    await page.getByRole('button', { name: /历史测试稿 102/ }).click()
    await page.getByRole('heading', { name: '历史测试稿 102', exact: true }).waitFor()
    assert.equal(await suggestions.count(), 0)
    assert.equal(await origin.count(), 0)
    assert.equal(await editor.inputValue(), '数据库里的改写稿')
  } finally { await h.browser.close() }
})

for (const [status, scriptLength, ratio, draft, editedDraft, countLabel, durationLabel] of [
  ['too_short', 1200, 0.3, '短稿。', '短。', '2 字', '预计口播 0:01'],
  ['too_long', 12000, 3, '史'.repeat(51000), '稿'.repeat(51001), '51001 字', '预计口播 170:01'],
]) {
  test(`${status} recreation ignores legacy length metadata and saves short or long bodies without warnings`, async () => {
    const lengthCheck = { referenceLength: 4000, scriptLength, ratio, status }
    const h = await harness({ recreatedDraft: true, lengthCheck, rewrittenScript: draft })
    try {
      const { page } = h
      const suggestions = page.locator('details.recreation-summary')
      await suggestions.waitFor()
      assert.equal(await page.getByText(/二创生成时长度提示|正文过短|正文过长|占校对稿/).count(), 0)
      const editor = page.getByRole('textbox', { name: '编辑待审稿' })
      assert.equal(await editor.isEnabled(), true)
      assert.equal(await editor.inputValue(), draft)
      assert.equal(await editor.getAttribute('aria-describedby'), 'draft-origin')
      assert.equal(await editor.getAttribute('maxlength'), null)
      await editor.fill(editedDraft)
      assert.equal(await editor.inputValue(), editedDraft)
      assert.equal((await page.locator('label[for="rewritten-script"] small').textContent()).trim(), countLabel)
      await page.getByText(durationLabel, { exact: true }).waitFor()
      assert.equal(await page.getByText(/偏短|超过目标时长|接近 10 分钟/).count(), 0)
      await page.getByRole('button', { name: '保存修改', exact: true }).click()
      await page.getByText('已保存', { exact: true }).waitFor()
      assert.equal(h.saves(), 1)
      await page.reload()
      await suggestions.waitFor()
      assert.equal(await editor.inputValue(), editedDraft)
      assert.equal(await page.getByText(/二创生成时长度提示|正文过短|正文过长|占校对稿/).count(), 0)
      assert.equal(await editor.getAttribute('aria-describedby'), 'draft-origin')
      assert.equal((await page.locator('label[for="rewritten-script"] small').textContent()).trim(), countLabel)
    } finally { await h.browser.close() }
  })
}

test('legacy, null and within-range recreation metadata show no length warning', async () => {
  for (const lengthCheck of [undefined, null, { referenceLength: 4000, scriptLength: 3000, ratio: 0.75, status: 'within_range' }]) {
    const h = await harness({ recreatedDraft: true, lengthCheck })
    try {
      await h.page.locator('details.recreation-summary').waitFor()
      assert.equal(await h.page.getByText(/二创生成时长度提示|正文过短|正文过长|占校对稿/).count(), 0)
      assert.equal(await h.page.getByRole('textbox', { name: '编辑待审稿' }).getAttribute('aria-describedby'), 'draft-origin')
      assert.equal(await h.page.getByRole('textbox', { name: '编辑待审稿' }).isEnabled(), true)
    } finally { await h.browser.close() }
  }
})

test('body-only recreation remains editable without empty title or cover suggestions and without a timing verdict', async () => {
  const h = await harness({ recreatedDraft: true, rewrittenScript: '史'.repeat(2500), recreationMetadata: { title: undefined, coverText: undefined } })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await page.locator('#draft-origin').waitFor()
    assert.equal(await editor.inputValue(), '史'.repeat(2500))
    assert.equal(await editor.isEnabled(), true)
    assert.equal(await page.locator('details.recreation-summary').count(), 0)
    await page.getByText('预计口播 8:20', { exact: true }).waitFor()
    assert.equal(await page.getByText(/偏短|超过目标时长|接近 10 分钟/).count(), 0)
    assert.equal((await page.locator('label[for="rewritten-script"] small').textContent()).trim(), '2500 字')
    await editor.fill('人工编辑正文。')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await page.reload()
    await editor.waitFor()
    assert.equal(await editor.inputValue(), '人工编辑正文。')
    assert.equal(await page.locator('details.recreation-summary').count(), 0)
  } finally { await h.browser.close() }
})

test('filters and rejected switching preserve unsaved edits; conflict does not overwrite input', async () => {
  const h = await harness()
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('未保存文字')
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: /历史测试稿 102/ }).click()
    assert.equal(await editor.inputValue(), '未保存文字')
    await page.getByRole('searchbox', { name: '搜索历史脚本' }).fill('无匹配')
    await page.getByText('没有匹配的脚本', { exact: true }).waitFor()
    assert.equal(await editor.inputValue(), '未保存文字')
    h.setConflict(true)
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByRole('button', { name: '读取最新稿', exact: true }).waitFor()
    assert.equal(await editor.inputValue(), '未保存文字')
    assert.equal(h.saves(), 0)
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: '读取最新稿', exact: true }).click()
    assert.equal(await editor.inputValue(), '未保存文字')
  } finally { await h.browser.close() }
})

test('completed scripts can be separated into not uploaded, partially uploaded and uploaded without hiding undownloaded videos', async () => {
  const states = ['not_uploaded', 'partially_uploaded', 'uploaded']
  const sources = states.map((uploadState, index) => ({ ...fixture(140 + index), workflowState: {
    videoCompleted: true, videoLinked: index !== 0, uploadState,
    uploads: { 'baijiahao-video': index ? 'saved' : 'not_uploaded',
      'baijiahao-article': index === 2 ? 'manual' : 'not_uploaded', 'tencent-video': index === 2 ? 'saved' : 'not_uploaded' },
  } }))
  const h = await harness({ sources, path: '/history-scripts?view=library&video=completed&upload=not_uploaded' })
  try {
    const { page } = h
    const upload = page.getByRole('combobox', { name: '上传', exact: true })
    assert.equal(await upload.inputValue(), 'not_uploaded')
    await page.locator('.source-item').filter({ hasText: '脚本 #140' }).waitFor()
    assert.equal(await page.locator('.source-item').count(), 1)
    assert.match(await page.locator('.source-item').innerText(), /未上传/)
    assert.match(await page.locator('.source-item').innerText(), /成片待关联/)
    for (const [value, id, text] of [['partially_uploaded', 141, '部分上传'], ['uploaded', 142, '已上传']]) {
      await upload.selectOption(value)
      await page.locator('.source-item').filter({ hasText: `脚本 #${id}` }).waitFor()
      assert.equal(await page.locator('.source-item').count(), 1)
      assert.match(await page.locator('.source-item').innerText(), new RegExp(text))
      await page.waitForURL(url => url.searchParams.get('upload') === value)
      assert.equal(h.listRequests.at(-1).get('video'), 'completed')
    }
    assert.match(await page.locator('.source-item').innerText(), /人工标记/)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.source-item').filter({ hasText: '脚本 #142' }).waitFor()
    assert.equal(await upload.inputValue(), 'uploaded')
    await page.getByRole('button', { name: '清除筛选', exact: true }).click()
    await page.locator('.rail-heading').getByText('3 条', { exact: true }).waitFor()
    assert.equal(h.listRequests.at(-1).has('upload'), false)
  } finally { await h.browser.close() }
})

test('library workflow filters combine across the whole library, reset pagination and preserve the open draft', async () => {
  const sources = Array.from({ length: 25 }, (_, index) => ({
    ...fixture(101 + index),
    workflowState: { videoCompleted: index !== 0, titlePlanGenerated: index !== 1, coverGenerated: index === 2, motionGenerated: index !== 3 },
  }))
  const h = await harness({ sources, path: '/history-scripts?view=library&script=101&origin=test&tag=a&tag=b' })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('筛选时保留未保存的稿件')
    assert.equal(await page.locator('.more-filters').getAttribute('open'), null)
    for (const label of ['视频', '标题方案', '封面', '精细化制作']) {
      const select = page.getByRole('combobox', { name: label, exact: true })
      assert.equal(await select.isVisible(), true)
      assert.equal(await select.inputValue(), '')
      assert.equal(await select.locator('option').count(), 3)
    }
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.locator('.source-item').filter({ hasText: '脚本 #125' }).waitFor()
    assert.equal(h.listRequests.at(-1).get('offset'), '20')
    for (const [label, key, value] of [
      ['视频', 'video', 'completed'], ['标题方案', 'titlePlan', 'generated'],
      ['封面', 'cover', 'not_generated'], ['精细化制作', 'motion', 'generated'],
    ]) {
      const response = page.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === '/api/v1/history-scripts' && url.searchParams.get(key) === value && url.searchParams.get('offset') === '0'
      })
      await page.getByRole('combobox', { name: label, exact: true }).selectOption(value)
      await response
      await page.waitForURL(url => url.searchParams.get(key) === value && !url.searchParams.has('page'))
    }
    await page.locator('.rail-heading').getByText('21 条', { exact: true }).waitFor()
    assert.equal(await page.locator('.source-item').count(), 20)
    assert.deepEqual(Object.fromEntries(h.listRequests.at(-1)), {
      video: 'completed', titlePlan: 'generated', cover: 'not_generated', motion: 'generated', limit: '20', offset: '0',
    })
    const firstStates = await page.locator('.source-item').first().locator('.item-workflow > span').allTextContents()
    assert.deepEqual(firstStates.map(text => text.trim()), ['视频已完成', '标题方案已生成', '封面未生成', '精细化制作已生成'])
    assert.equal(await page.locator('.source-item .item-production').count(), 0)
    assert.equal(await editor.inputValue(), '筛选时保留未保存的稿件')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.locator('.source-item').filter({ hasText: '脚本 #125' }).waitFor()
    assert.equal(await page.locator('.source-item').count(), 1)
    assert.equal(h.listRequests.at(-1).get('offset'), '20')
    assert.equal(new URL(page.url()).searchParams.get('page'), '2')
    await page.getByRole('button', { name: '清除筛选', exact: true }).click()
    await page.locator('.rail-heading').getByText('25 条', { exact: true }).waitFor()
    assert.deepEqual(Object.fromEntries(h.listRequests.at(-1)), { limit: '20', offset: '0' })
    assert.deepEqual([...new URL(page.url()).searchParams], [['view', 'library'], ['script', '101'], ['origin', 'test'], ['tag', 'a'], ['tag', 'b']])
    assert.equal(await editor.inputValue(), '筛选时保留未保存的稿件')
    assert.equal(await page.getByRole('button', { name: '清除筛选', exact: true }).isDisabled(), true)
  } finally { await h.browser.close() }
})

test('library filter links restore all conditions on refresh and browser history without dropping unrelated query', async () => {
  const sources = Array.from({ length: 16 }, (_, index) => ({
    ...fixture(101 + index),
    workflowState: { videoCompleted: Boolean(index & 1), titlePlanGenerated: Boolean(index & 2), coverGenerated: Boolean(index & 4), motionGenerated: Boolean(index & 8) },
  }))
  const query = new URLSearchParams({
    view: 'library', script: '101', origin: 'shared', q: '历史测试稿', category: 'historical_anecdote', status: 'needs_review',
    video: 'completed', titlePlan: 'not_generated', cover: 'generated', motion: 'not_generated',
  })
  const h = await harness({ sources, path: `/history-scripts?${query}` })
  try {
    const { page } = h
    const values = { 视频: 'completed', 标题方案: 'not_generated', 封面: 'generated', 精细化制作: 'not_generated' }
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await page.reload()
      await page.locator('.source-item').filter({ hasText: '脚本 #106' }).waitFor()
      assert.equal(await page.locator('.source-item').count(), 1)
      for (const [label, value] of Object.entries(values)) assert.equal(await page.getByRole('combobox', { name: label, exact: true }).inputValue(), value)
      assert.equal(await page.getByRole('searchbox', { name: '搜索历史脚本' }).inputValue(), '历史测试稿')
      assert.equal(await page.getByRole('combobox', { name: '分类', exact: true }).inputValue(), 'historical_anecdote')
      assert.equal(await page.getByRole('combobox', { name: '采集状态', exact: true }).inputValue(), 'needs_review')
      assert.equal(new URL(page.url()).searchParams.get('script'), '101')
      assert.equal(new URL(page.url()).searchParams.get('origin'), 'shared')
      for (const key of ['q', 'category', 'status', 'video', 'titlePlan', 'cover', 'motion']) assert.equal(h.listRequests.at(-1).get(key), query.get(key))
    }
    await page.locator('#workspace-tab-production').click()
    await page.locator('#workspace-tab-library').click()
    assert.equal(new URL(page.url()).searchParams.get('cover'), 'generated')
    await page.getByRole('combobox', { name: '精细化制作', exact: true }).selectOption('generated')
    await page.locator('.source-item').filter({ hasText: '脚本 #114' }).click()
    await page.getByRole('heading', { name: '历史测试稿 114', exact: true }).waitFor()
    await page.getByRole('button', { name: '清除筛选', exact: true }).click()
    await page.locator('.rail-heading').getByText('16 条', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).searchParams.get('script'), '114')
    await page.goBack()
    await page.getByRole('heading', { name: '历史测试稿 101', exact: true }).waitFor()
    await page.locator('.rail-heading').getByText('1 条', { exact: true }).waitFor()
    assert.equal(await page.getByRole('combobox', { name: '精细化制作', exact: true }).inputValue(), 'generated')
    assert.equal(await page.getByRole('combobox', { name: '封面', exact: true }).inputValue(), 'generated')
    assert.equal(h.listRequests.at(-1).get('motion'), 'generated')
    await page.goForward()
    await page.getByRole('heading', { name: '历史测试稿 114', exact: true }).waitFor()
    await page.locator('.rail-heading').getByText('16 条', { exact: true }).waitFor()
    assert.equal(await page.getByRole('combobox', { name: '封面', exact: true }).inputValue(), '')
    assert.equal(new URL(page.url()).searchParams.get('origin'), 'shared')
  } finally { await h.browser.close() }
})

test('library filters clear empty results and pending searches and keep compact controls on small screens', async () => {
  const h = await harness({ viewport: { width: 390, height: 844 } })
  try {
    const { page } = h
    await page.getByRole('combobox', { name: '视频', exact: true }).selectOption('completed')
    await page.getByText('没有匹配的脚本', { exact: true }).waitFor()
    await page.getByRole('searchbox', { name: '搜索历史脚本' }).fill('无匹配')
    await page.getByRole('button', { name: '清除筛选', exact: true }).click()
    await page.locator('.rail-heading').getByText('2 条', { exact: true }).waitFor()
    assert.equal(await page.getByRole('searchbox', { name: '搜索历史脚本' }).inputValue(), '')
    assert.deepEqual(Object.fromEntries(h.listRequests.at(-1)), { limit: '20', offset: '0' })
    for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }, { width: 800, height: 650 }]) {
      await page.setViewportSize(viewport)
      const list = await page.locator('.source-list').boundingBox()
      assert.ok(list.height >= 120, `list should remain usable at ${viewport.width}×${viewport.height}, got ${list.height}`)
      for (const label of ['视频', '标题方案', '封面', '精细化制作', '上传']) assert.equal(await page.getByRole('combobox', { name: label, exact: true }).isVisible(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
    await page.getByRole('combobox', { name: '视频', exact: true }).selectOption('not_completed')
    await page.waitForURL(url => url.searchParams.get('video') === 'not_completed')
    assert.equal(await page.locator('.source-item .item-workflow .complete').count(), 0)
  } finally { await h.browser.close() }
})

test('library state badges use API workflowState and do not invent a state for missing metadata', async () => {
  const sources = [
    { ...fixture(77), workflowState: { videoCompleted: true, titlePlanGenerated: true, coverGenerated: true, motionGenerated: false } },
    { ...fixture(78), workflowState: undefined },
  ]
  const h = await harness({ sources, path: '/history-scripts?view=library&script=77' })
  try {
    const { page } = h
    const states = await page.locator('.source-item').first().locator('.item-workflow > span').allTextContents()
    assert.deepEqual(states.map(text => text.trim()), ['视频已完成', '标题方案已生成', '封面已生成', '精细化制作未生成'])
    assert.equal(await page.locator('.source-item').first().locator('.item-workflow .complete').count(), 3)
    const unknown = await page.locator('.source-item').nth(1).locator('.item-workflow').textContent()
    assert.equal((unknown.match(/状态未知/g) || []).length, 4)
    assert.doesNotMatch(unknown, /未生成|未完成/)
    for (const select of ['video', 'titlePlan', 'cover', 'motion']) assert.equal(h.listRequests.at(-1).has(select), false)
  } finally { await h.browser.close() }
})

test('phone list-detail navigation fits small viewports and retains accessible controls', async () => {
  const h = await harness({ viewport: { width: 375, height: 812 } })
  try {
    const { page } = h
    await page.getByRole('button', { name: /历史测试稿 101/ }).click()
    await page.getByRole('button', { name: '返回脚本列表', exact: true }).waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false)
    await page.getByRole('button', { name: '返回脚本列表', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: /历史测试稿 101/ }).isVisible(), true)
    await page.setViewportSize({ width: 812, height: 375 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  } finally { await h.browser.close() }
})

test('processing stages are filterable, lock editing and refresh without losing a later draft', async () => {
  const h = await harness({ processing: true, clock: true })
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    assert.equal(await editor.isDisabled(), true)
    assert.equal(await editor.getAttribute('placeholder'), '正在生成二创待审稿')
    assert.equal(await page.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '删除脚本', exact: true }).isDisabled(), true)
    await page.locator('.more-filters summary').click()
    const statuses = await page.getByRole('combobox', { name: '采集状态', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value))
    for (const stage of ['downloading', 'transcribing', 'correcting', 'rewriting']) assert.ok(statuses.includes(stage))
    await page.getByRole('button', { name: '校对稿', exact: true }).click()
    Object.assign(h.sources[0], {
      status: 'needs_review', rewrittenScript: '新生成的待审改写稿',
      artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
    })
    await page.clock.fastForward(15_000)
    await page.waitForFunction(() => document.querySelector('#rewritten-script')?.value === '新生成的待审改写稿')
    assert.equal(await editor.isDisabled(), false)
    assert.equal(await page.getByRole('button', { name: '校对稿', exact: true }).getAttribute('aria-pressed'), 'true')
    await editor.fill('未保存的人工修改')
    h.sources[1].status = 'rewriting'
    h.sources[0].rewrittenScript = '其他进程的版本'
    await page.clock.fastForward(15_000)
    assert.equal(await editor.inputValue(), '未保存的人工修改')
    assert.equal(h.saves(), 0)
  } finally { await h.browser.close() }
})

test('deletion requires confirmation, retains drafts on failure and removes only the confirmed source', async () => {
  const h = await harness()
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    const remove = page.getByRole('button', { name: '删除脚本', exact: true })
    await editor.fill('删除前的未保存修改')
    let confirmation = ''
    page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss() })
    await remove.click()
    assert.match(confirmation, /历史测试稿 101/)
    assert.match(confirmation, /未保存的修改将丢弃/)
    assert.equal(h.deletions.length, 0)
    assert.equal(await editor.inputValue(), '删除前的未保存修改')
    h.setDeleteFailure(503)
    page.once('dialog', dialog => dialog.accept())
    await remove.click()
    await page.locator('.delete-error').waitFor()
    assert.equal(await editor.inputValue(), '删除前的未保存修改')
    assert.equal(await page.locator('.source-item').count(), 2)
    h.setDeleteFailure(0)
    page.once('dialog', dialog => dialog.accept())
    await remove.click()
    await page.getByRole('heading', { name: '历史测试稿 102', exact: true }).waitFor()
    assert.deepEqual(h.deletions[1], { id: 101, expectedRevision: '101'.padStart(64, '0') })
    assert.equal(new URL(page.url()).searchParams.get('script'), '102')
    assert.equal(await page.locator('.source-item').count(), 1)
    assert.equal(await editor.inputValue(), '数据库里的改写稿')
    assert.equal(h.saves(), 0)
    await page.reload()
    await page.getByRole('heading', { name: '历史测试稿 102', exact: true }).waitFor()
    assert.equal(await page.locator('.source-item').count(), 1)
    page.once('dialog', dialog => dialog.accept())
    await remove.click()
    await page.getByText('暂无历史脚本', { exact: true }).waitFor()
    await page.getByRole('heading', { name: '选择一条历史脚本', exact: true }).waitFor()
    await page.waitForURL(url => !url.searchParams.has('script'))
    assert.equal(await page.locator('.source-video').count(), 0)
    assert.equal(await page.locator('.page-identity .library-count').textContent(), '0 条稿件')
    await page.reload()
    await page.getByRole('heading', { name: '选择一条历史脚本', exact: true }).waitFor()
  } finally { await h.browser.close() }
})

test('refreshing the library does not disable deletion of an already loaded idle manuscript', async () => {
  const h = await harness()
  let heldRoute
  try {
    const { page } = h
    const remove = page.getByRole('button', { name: '删除脚本', exact: true })
    assert.equal(await remove.isEnabled(), true)
    await page.route('**/api/v1/history-scripts?**', route => { heldRoute = route })
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/history-scripts')
    await page.getByRole('button', { name: '刷新脚本库', exact: true }).click()
    await requested
    await page.waitForFunction(() => document.querySelector('button[aria-label="刷新脚本库"]')?.disabled)
    assert.equal(await remove.isEnabled(), true, 'A slow background list request must not lock the current manuscript')
  } finally {
    if (heldRoute) await heldRoute.fulfill({ json: { code: 200, data: { items: h.sources, total: h.sources.length } } })
    await h.browser.close()
  }
})

test('deletion conflict shows the reason and does not discard edits during reload without confirmation', async () => {
  const h = await harness()
  try {
    const { page } = h
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('保留这段人工修改')
    h.setDeleteFailure(409)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '删除脚本', exact: true }).click()
    await page.locator('.delete-error').waitFor()
    assert.match(await page.locator('.delete-error').textContent(), /脚本已更新/)
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: '重新读取脚本', exact: true }).click()
    assert.equal(await editor.inputValue(), '保留这段人工修改')
    assert.equal(h.sources.length, 2)
  } finally { await h.browser.close() }
})

test('deleting the final entry on a later page returns to a populated page on mobile', async () => {
  const h = await harness({ count: 21, viewport: { width: 390, height: 844 } })
  try {
    const { page } = h
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.getByRole('button', { name: /历史测试稿 121/ }).click()
    await page.getByRole('heading', { name: '历史测试稿 121', exact: true }).waitFor()
    const remove = page.getByRole('button', { name: '删除脚本', exact: true })
    assert.equal(await remove.isVisible(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    page.once('dialog', dialog => dialog.accept())
    await remove.click()
    await page.getByRole('heading', { name: '历史测试稿 101', exact: true }).waitFor()
    await page.getByRole('button', { name: '返回脚本列表', exact: true }).click()
    assert.equal(await page.locator('.source-item').count(), 20)
    assert.equal((await page.locator('.pager').textContent()).replace(/\s/g, ''), '上一页1/1下一页')
    assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true)
  } finally { await h.browser.close() }
})

test('visible script IDs and copied links reopen the same script outside the current list page', async () => {
  const h = await harness({ count: 21, path: '/history-scripts?script=121&view=detail' })
  try {
    const { page } = h
    await page.getByRole('heading', { name: '历史测试稿 121', exact: true }).waitFor()
    assert.equal(await page.locator('.summary-copy .script-id').textContent(), '脚本 #121')
    assert.equal(await page.locator('.source-item').first().locator('.script-id').textContent(), '脚本 #101')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.getByRole('button', { name: '复制脚本链接', exact: true }).click()
    const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    assert.equal(copied.pathname, '/history-scripts')
    assert.equal(copied.searchParams.get('script'), '121')
    assert.equal(copied.searchParams.get('view'), 'detail')
    await page.reload()
    await page.getByRole('heading', { name: '历史测试稿 121', exact: true }).waitFor()
    await page.getByRole('button', { name: /历史测试稿 101/ }).click()
    await page.waitForURL(url => url.searchParams.get('script') === '101')
    assert.equal(new URL(page.url()).searchParams.get('view'), 'detail')
    await page.goBack()
    await page.getByRole('heading', { name: '历史测试稿 121', exact: true }).waitFor()
  } finally { await h.browser.close() }
})

test('browser history preserves an unsaved draft when switching is rejected', async () => {
  const h = await harness()
  try {
    const { page } = h
    await page.waitForURL(url => url.searchParams.get('script') === '101')
    await page.getByRole('button', { name: /历史测试稿 102/ }).click()
    await page.getByRole('heading', { name: '历史测试稿 102', exact: true }).waitFor()
    const editor = page.getByRole('textbox', { name: '编辑待审稿' })
    await editor.fill('保留浏览器后退前的未保存稿件')
    page.once('dialog', dialog => dialog.dismiss())
    await page.goBack()
    await page.waitForURL(url => url.searchParams.get('script') === '102')
    assert.equal(await editor.inputValue(), '保留浏览器后退前的未保存稿件')
    page.once('dialog', dialog => dialog.accept())
    await page.goBack()
    await page.getByRole('heading', { name: '历史测试稿 101', exact: true }).waitFor()
    await page.goForward()
    await page.getByRole('heading', { name: '历史测试稿 102', exact: true }).waitFor()
  } finally { await h.browser.close() }
})

test('invalid and missing script links show an error instead of selecting an unrelated script', async () => {
  const h = await harness({ path: '/history-scripts?script=invalid', expectDetail: false })
  try {
    const { page } = h
    await page.locator('.detail-empty.error').waitFor()
    assert.equal(await page.locator('#rewritten-script').count(), 0)
    for (const query of ['script=999', 'script=101&script=102']) {
      await page.goto(`${baseUrl}/history-scripts?${query}`)
      await page.locator('.detail-empty.error').waitFor()
      assert.equal(await page.locator('#rewritten-script').count(), 0)
    }
    await page.getByRole('button', { name: /历史测试稿 101/ }).click()
    await page.getByRole('heading', { name: '历史测试稿 101', exact: true }).waitFor()
    assert.equal(new URL(page.url()).searchParams.get('script'), '101')
  } finally { await h.browser.close() }
})

test('deleted script links explain the deletion and offer a working return to the library', async () => {
  const h = await harness({
    path: '/history-scripts?view=library&script=366&channel=huasheng', expectDetail: false,
    deletedSource: { id: 366, title: '耶稣“荆棘皇冠”之谜 2/3', deletedAt: '2026-10-27T07:13:13.382Z' },
    viewport: { width: 390, height: 844 },
  })
  try {
    const { page } = h
    await page.getByRole('heading', { name: '稿件已删除', exact: true }).waitFor()
    assert.match(await page.locator('.detail-empty.error').textContent(), /#366.*荆棘皇冠.*已于.*删除/)
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0)
    assert.equal(await page.locator('#rewritten-script').count(), 0)
    await page.getByRole('button', { name: '返回稿件列表', exact: true }).click()
    await page.getByRole('button', { name: /历史测试稿 101/ }).waitFor()
    await page.waitForURL(url => url.searchParams.get('script') === '101')
    assert.equal(new URL(page.url()).searchParams.get('script'), '101')
    assert.equal(new URL(page.url()).searchParams.get('channel'), 'huasheng')
  } finally { await h.browser.close() }
})

test('legacy missing script responses show an actionable Chinese message without a futile retry', async () => {
  const h = await harness({ path: '/history-scripts?view=library&script=999', expectDetail: false })
  try {
    await h.page.getByRole('heading', { name: '稿件不可用', exact: true }).waitFor()
    assert.match(await h.page.locator('.detail-empty.error').textContent(), /#999.*不存在或已被删除/)
    assert.equal(await h.page.getByRole('button', { name: '重试', exact: true }).count(), 0)
    assert.equal(await h.page.getByRole('button', { name: '返回稿件列表', exact: true }).isEnabled(), true)
  } finally { await h.browser.close() }
})
