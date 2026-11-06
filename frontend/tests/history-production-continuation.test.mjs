import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const base = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const root = '/api/v1/history-scripts'
const revision = 'a'.repeat(64)
const sourceFixture = (overrides = {}) => ({
  id: 368, title: '秦朝亡了没人救，汉朝为何还能延续？', sourceUrl: 'https://www.youtube.com/watch?v=VprFAzjTTuM',
  category: 'historical_commentary', status: 'downloaded', rewrittenScript: '', revision,
  rawTranscript: '', correctedTranscript: '', metricsJson: '{}', mediaJson: '{}', reviewJson: '{}', selectionJson: '{}',
  artifactState: { transcript: 'missing', corrected: 'missing', rewritten: 'missing' },
  ...overrides,
})
const huashengFixture = () => ({ id: 94, sourceId: 365, title: '最后的晚餐', status: 'needs_attention', stage: 'needs_attention',
  checkpoint: 'create_pending', projectUrl: null, scriptSha256: 'unused', productionStatus: 'not_started',
  message: '创建结果待核对', error: '创建请求尚未返回项目链接', createdAt: '2026-10-30T08:00:00Z', updatedAt: '2026-10-30T08:00:00Z' })

async function harness(t, options = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 1000 } })
  page.setDefaultTimeout(8000)
  if (options.clock) await page.clock.install()
  const source = sourceFixture(options.source)
  const state = { task: options.task || null, writes: [], errors: [], continuationReads: 0, complete: Boolean(options.complete), fail: false }
  page.on('pageerror', error => state.errors.push(error.message))
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    const send = data => route.fulfill({ json: { code: 200, data } })
    if (request.method() !== 'GET') {
      state.writes.push({ pathname, body: request.postDataJSON() })
      if (pathname === `${root}/${source.id}` && request.method() === 'PATCH') {
        source.rewrittenScript = request.postDataJSON().rewrittenScript
        source.revision = 'b'.repeat(64)
        state.complete = false
        return send(source)
      }
      if (pathname === `${root}/${source.id}/continue`) {
        if (state.fail) return route.fulfill({ status: 409, json: { code: 409, message: '稿件版本已更新，请重新读取。' } })
        if (state.complete) return send({ task: null, complete: true, created: false, message: '全部作品已完成。' })
        state.task = { id: 810, status: 'queued', progressMessage: '已进入生产队列，继续转录与二创。' }
        return send({ task: state.task, complete: false, created: true })
      }
      if (pathname.endsWith('/check-production')) return send({ checking: true })
      return route.fulfill({ status: 405, json: { code: 405, message: `Unexpected write ${pathname}` } })
    }
    if (pathname === root) return send({ items: [source], total: 1 })
    if (pathname === `${root}/${source.id}`) return send(source)
    if (pathname === `${root}/${source.id}/continuation`) { state.continuationReads++; return send({ task: state.task, complete: state.complete }) }
    if (pathname.endsWith('/browser-session')) return send({ session: { status: 'ready', canCollect: true, checks: [] } })
    if (pathname.endsWith('/huasheng/exports')) return send({ jobs: options.exports || [], enabled: false })
    if (pathname.endsWith('/huasheng')) return send({ jobs: options.jobs || [], enabled: false, browser: { status: 'ready', message: '' }, productionChecking: false })
    if (pathname === `${root}/jobs`) return send({ job: null, recent: [], total: 0, hasMore: false })
    if (pathname.endsWith('/delivery')) return send({ title: '', description: '', covers: {}, videos: [], coverStatus: 'idle', designStatus: 'idle' })
    return send({ items: [], jobs: [], ready: true })
  })
  await page.goto(`${base}/history-scripts?view=library&script=${source.id}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('region', { name: '生产进度', exact: true }).waitFor()
  await page.waitForFunction(() => ['继续生产', '查看生产进度', '全部已提交'].some(label => document.querySelector('[aria-label="生产进度"] button')?.textContent.includes(label)))
  return { page, source, state, progress: page.getByRole('region', { name: '生产进度', exact: true }) }
}

test('downloaded source can continue without a draft and duplicate clicks submit once', async t => {
  const { page, state, progress } = await harness(t)
  await progress.getByText('源视频已下载，下一步转录、校对并生成二创稿。', { exact: true }).waitFor()
  const button = progress.getByRole('button', { name: '继续生产', exact: true })
  assert.equal(await button.isEnabled(), true)
  await button.evaluate(element => { element.click(); element.click() })
  await progress.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
  assert.deepEqual(state.writes, [{ pathname: `${root}/368/continue`, body: { expectedRevision: revision } }])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await progress.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
  await progress.getByRole('button', { name: '查看生产进度', exact: true }).click()
  assert.equal(state.writes.length, 1)
  assert.deepEqual(state.errors, [])
})

test('an old transcribing status without a live task does not permanently block continuation', async t => {
  const { state, progress } = await harness(t, { source: { status: 'transcribing' } })
  await progress.getByRole('button', { name: '继续生产', exact: true }).click()
  await progress.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
  assert.equal(state.writes[0].pathname, `${root}/368/continue`)
})

test('saved source with an uncertain Huasheng job can continue and independently synchronize', async t => {
  const { page, state, progress } = await harness(t, { source: { id: 365, status: 'needs_review', rewrittenScript: '耶稣和门徒共进晚餐。',
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' } }, jobs: [huashengFixture()] })
  await page.locator('.summary-kicker').getByText('二创稿已就绪', { exact: true }).waitFor()
  await page.getByRole('tablist', { name: '稿件内容', exact: true }).getByRole('tab', { name: '花生制作', exact: true }).click()
  const panel = page.getByRole('region', { name: '当前稿花生制作', exact: true })
  await panel.getByRole('button', { name: '同步花生状态', exact: true }).click()
  assert.equal(state.writes[0].pathname, `${root}/365/huasheng/check-production`)
  await panel.getByRole('button', { name: '继续生产', exact: true }).click()
  await progress.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
  await panel.getByRole('button', { name: '查看生产进度', exact: true }).click()
  assert.equal(state.writes[1].pathname, `${root}/365/continue`)
  assert.equal(state.writes.length, 2)
  assert.equal(state.writes.some(item => item.pathname.endsWith('/resume') || item.pathname.endsWith('/huasheng')), false)
  assert.deepEqual(state.errors, [])
})

test('unsaved edits prevent production and preserve the draft', async t => {
  const { page, state, progress } = await harness(t)
  await page.getByRole('textbox', { name: '编辑待审稿', exact: true }).fill('尚未保存的修改')
  assert.equal(await progress.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), false)
  await progress.getByText('文稿有未保存修改，请先保存。', { exact: true }).waitFor()
  assert.deepEqual(state.writes, [])
})

test('legacy workflow counters cannot close a current production that still needs recovery', async t => {
  const { state, progress } = await harness(t, { source: {
    status: 'needs_review', rewrittenScript: '当前已保存且需要恢复发布材料的二创稿。',
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
    workflowState: { videoCompleted: true, motionGenerated: true, publicationCounts: { expected: 2, submitted: 2, published: 2 } },
  }, complete: false })
  assert.equal(await progress.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), true)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.errors, [])
})

test('saving a new manuscript immediately clears the previous revision submission completion', async t => {
  const { page, state, progress } = await harness(t, { complete: true, clock: true, source: {
    status: 'needs_review', rewrittenScript: '已经提交过的旧正文。',
    artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
  } })
  await progress.getByRole('button', { name: '全部已提交', exact: true }).waitFor()
  await page.getByRole('textbox', { name: '编辑待审稿', exact: true }).fill('修改后需要重新制作的新正文。')
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.getByText('二创稿已保存，可继续生产', { exact: true }).waitFor()
  assert.equal(await progress.getByRole('button', { name: '全部已提交', exact: true }).count(), 0)
  assert.equal(await progress.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), true)
  assert.equal(state.writes.length, 1)
})

test('completed Huasheng production stays distinct from a failed local publishing preparation', async t => {
  const error = "Cannot read properties of undefined (reading 'status')"
  const videoUrl = '/static/history-deliveries/373/84d8b579-d3f8-4965-849d-bc54b7225813.mp4'
  const rewrittenScript = '长城的作用是什么？'
  const scriptSha256 = createHash('sha256').update(rewrittenScript).digest('hex')
  const { page, state } = await harness(t, {
    source: { id: 373, status: 'needs_review', rewrittenScript,
      artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' } },
    jobs: [{ ...huashengFixture(), id: 97, sourceId: 373, status: 'submitted', productionStatus: 'completed',
      scriptSha256,
      projectUrl: 'https://www.huasheng.cn/video/266112038240419', error: null, message: '花生已完成' }],
    exports: [{ id: 109, huashengJobId: 97, sourceId: 373, scriptSha256, status: 'failed', stage: 'processing',
      message: error, error, videoUrl, downloadedBytes: 302955458,
      designStatus: 'completed', coverStatus: null, updatedAt: '2026-10-30T11:13:58.611Z' }],
  })
  await page.getByRole('tablist', { name: '稿件内容', exact: true }).getByRole('tab', { name: '花生制作', exact: true }).click()
  const panel = page.getByRole('region', { name: '当前稿花生制作', exact: true })
  await panel.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  const output = panel.getByRole('region', { name: '稿件 #373 自动生成产物状态', exact: true })
  await output.getByText('发布准备失败', { exact: true }).waitFor()
  assert.equal(await output.locator('time').getAttribute('datetime'), '2026-10-30T11:13:58.611Z')
  assert.equal(await output.getByRole('link', { name: '查看已下载视频' }).getAttribute('href'), videoUrl)
  await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).waitFor()
  assert.deepEqual(state.errors, [])
  assert.deepEqual(state.writes, [])
})

test('version conflicts remain visible and a complete response needs no new task', async t => {
  const { page, state, progress } = await harness(t)
  state.fail = true
  await progress.getByRole('button', { name: '继续生产', exact: true }).click()
  await progress.locator('..').getByRole('alert').filter({ hasText: '稿件版本已更新' }).waitFor()
  assert.equal(await progress.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), true)
  state.fail = false
  state.complete = true
  await progress.getByRole('button', { name: '继续生产', exact: true }).click()
  assert.equal(await progress.getByRole('button', { name: '全部已提交', exact: true }).isEnabled(), false)
  await progress.getByText('所需视频版本均已提交百家号，可查看审核与发表结果。', { exact: true }).waitFor()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await progress.getByRole('button', { name: '全部已提交', exact: true }).waitFor()
  assert.equal(await progress.getByRole('button', { name: '全部已提交', exact: true }).isEnabled(), false)
  await progress.getByText('所需视频版本均已提交百家号，可查看审核与发表结果。', { exact: true }).waitFor()
  await page.getByRole('tablist', { name: '稿件内容', exact: true }).getByRole('tab', { name: '花生制作', exact: true }).click()
  const panel = page.getByRole('region', { name: '当前稿花生制作', exact: true })
  assert.equal(await panel.getByRole('button', { name: '全部已提交', exact: true }).isEnabled(), false)
  assert.equal(state.writes.length, 2)
})
