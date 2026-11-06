import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const root = '/api/v1/history-scripts'
const bulkSelectionLabel = '全选当前筛选中的已加载任务（含未绑定花生项目的任务）'
const batchDownloadLabel = /^批量下载并准备发布（\d+）$/
const selectionSummary = (selected, production, check, generate) => `已选 ${selected} 项 · 可制作 ${production} 项 · 可检查 ${check} 项 · 可生成 ${generate} 项`
const sha = text => createHash('sha256').update(text).digest('hex')
const monitoringFixture = () => ({ enabled: false, intervalMs: 60000, lastCheckedAt: null, nextCheckAt: null })
const sourceFixture = () => ({
  id: 101, title: '明朝北京的租房生活', category: 'historical_anecdote', status: 'needs_review',
  rewrittenScript: '万历年间，北京普通人的租房生活。', revision: 'saved-revision-101',
  correctedTranscript: '原始史料。', rawTranscript: '原始转写。',
  metricsJson: '{}', mediaJson: '{}', reviewJson: '{}', selectionJson: '{}',
  artifactState: { transcript: 'current', corrected: 'current', rewritten: 'current' },
})
const jobFixture = (overrides = {}) => ({
  id: 1, sourceId: 101, title: '明朝北京的租房生活', status: 'queued', stage: 'queued',
  message: '等待制作', projectUrl: null, videoUrl: null, error: null,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
  productionStatus: 'not_started', productionCheckedAt: null, productionMessage: '', productionCheckError: null,
  scriptSha256: sha(sourceFixture().rewrittenScript), ...overrides,
})
const exportFixture = (overrides = {}) => ({
  id: 1, huashengJobId: 1, sourceId: 101, scriptSha256: sha(sourceFixture().rewrittenScript),
  projectUrl: 'https://www.huasheng.cn/video/123', status: 'queued', stage: 'queued', message: '等待导出并生成产物', error: null,
  exportProgress: null, downloadedBytes: 0, totalBytes: null, videoUrl: null, designStatus: null, coverStatus: null, articleStatus: null,
  createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
  ...(overrides.status === 'completed' ? { designStatus: 'completed', coverStatus: 'completed', articleStatus: 'completed' } : {}), ...overrides,
})
const completedJob = (overrides = {}) => jobFixture({ status: 'submitted', productionStatus: 'completed', projectUrl: 'https://www.huasheng.cn/video/123', ...overrides })
const workflowFixture = (job, overrides = {}) => ({
  scriptId: Number(job.sourceId), scriptSha256: job.scriptSha256, producer: 'huasheng', producerJobId: String(job.id),
  videoId: Number(job.id), exportJobId: null, state: 'packaging', stage: 'packaging', message: '正在准备标题和封面',
  error: null, automatic: true, materialsReady: false, ...overrides,
})

test('production rows show the full workflow through export, packaging and publication with stage filters', async t => {
  const jobs = Array.from({ length: 7 }, (_, index) => completedJob({ id: index + 1, sourceId: 101 + index, title: `全流程稿件 ${index + 1}` }))
  const versions = [
    workflowFixture(jobs[0], { state: 'exporting', stage: 'export', videoId: null, message: '花生正在导出成片' }),
    workflowFixture(jobs[1]),
    workflowFixture(jobs[2], { state: 'queued', stage: 'publication', message: '等待提交百家号' }),
    workflowFixture(jobs[3], { state: 'uploading', stage: 'publication', message: '视频上传中' }),
    workflowFixture(jobs[4], { state: 'submitted', stage: 'publication', message: '已提交百家号，等待审核' }),
    workflowFixture(jobs[5], { state: 'published', stage: 'publication', message: '已发表到百家号' }),
    workflowFixture(jobs[6], { state: 'ready', stage: 'publication', message: '本版材料已齐备，等待自动提交百家号' }),
  ]
  const h = await harness(t, { state: { jobs }, workflowVersions: versions, exports: { jobs: [exportFixture({ status: 'exporting', stage: 'export_wait', message: '花生正在导出成片' })] } })
  await h.openProduction()
  for (const [index, label] of ['导出中', '准备标题封面', '等待提交百家号', '正在提交百家号', '已提交审核', '已发表', '等待自动提交'].entries()) {
    const row = h.taskList.locator('.task-item').filter({ has: h.page.getByRole('button', { name: `查看任务 #${index + 1} 详情`, exact: true }) })
    await row.locator('.workflow-status').getByText(label, { exact: true }).waitFor()
    await h.openJob(index + 1)
    await h.jobDetail.getByLabel(`流程状态：${label}`, { exact: true }).waitFor()
    await h.jobDetail.getByText('创作状态：素材就绪', { exact: true }).waitFor()
    const progress = h.jobDetail.getByLabel(`任务 #${index + 1} 全流程进度`, { exact: true })
    assert.equal(await progress.locator('li').count(), 4)
    if (index === 5) assert.equal(await progress.locator('li.success').count(), 4)
  }
  const filter = h.panel.getByRole('combobox', { name: '流程状态筛选', exact: true })
  for (const [value, count] of [['export', 1], ['packaging', 1], ['publication', 3], ['submitted', 1], ['published', 1]]) {
    await filter.selectOption(value)
    assert.equal(await h.taskList.locator('.task-item').count(), count)
  }
  await filter.selectOption('all')
  await h.openJob(6)
  await h.jobDetail.getByRole('button', { name: '查看发表进度', exact: true }).click()
  await h.page.getByRole('tab', { name: '百家号发表', exact: true }).last().waitFor()
  assert.deepEqual(h.writes, [])
})

test('downstream failures and uncertain results appear in task previews and attention filters', async t => {
  const jobs = Array.from({ length: 4 }, (_, index) => completedJob({ id: index + 1, sourceId: 101 + index }))
  const h = await harness(t, { state: { jobs }, workflowVersions: [
    workflowFixture(jobs[0], { state: 'attention', stage: 'packaging', error: '封面图片生成失败', message: '封面图片生成失败' }),
    workflowFixture(jobs[1], { state: 'attention', stage: 'publication', error: '百家号 videoV2 作品描述使用标题，当前上传扩展最多支持 50 字' }),
    workflowFixture(jobs[2], { state: 'uncertain', stage: 'publication', message: '发表结果待核对，不会重复上传' }),
    workflowFixture(jobs[3], { state: 'published', stage: 'publication', message: '已发表到百家号' }),
  ] })
  await h.openProduction()
  for (const [index, label] of ['标题封面失败', '标题待精简', '发表待核对', '已发表'].entries()) {
    await h.openJob(index + 1)
    await h.jobDetail.getByLabel(`流程状态：${label}`, { exact: true }).waitFor()
  }
  await h.openJob(1)
  assert.equal(await h.jobDetail.getByLabel('任务 #1 全流程进度', { exact: true }).getByText('封面图片生成失败', { exact: true }).count(), 1)
  await h.panel.getByRole('button', { name: /^需要处理\s*3$/ }).click()
  assert.equal(await h.taskList.locator('.task-item').count(), 3)
  await h.panel.getByRole('button', { name: /^需要处理\s*3$/ }).click()
  await h.panel.getByRole('combobox', { name: '流程状态筛选', exact: true }).selectOption('attention')
  assert.equal(await h.taskList.locator('.task-item').count(), 3)
  await h.openJob(2)
  await h.jobDetail.getByRole('button', { name: '编辑发布标题', exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('editing a failed Huasheng title opens its exact video and retains the other version draft', async t => {
  const job = completedJob()
  const h = await harness(t, { state: { jobs: [job] }, workflowVersions: [workflowFixture(job, {
    videoId: 10, state: 'attention', stage: 'publication', message: '发布标题超限，最多支持 50 字',
  })], products: { delivery: {
    videoId: 20, producer: 'motion', title: '精细化版标题', baijiahaoTitle: '精细化版标题', covers: {}, coverStatus: 'completed', designStatus: 'completed',
    videos: [
      { id: 20, producer: 'motion', videoUrl: '/static/motion.mp4', videoName: 'motion.mp4' },
      { id: 10, producer: 'huasheng', videoUrl: '/static/huasheng.mp4', videoName: 'huasheng.mp4' },
    ],
    videoPackagings: [
      { videoId: 20, producer: 'motion', title: '精细化版标题', baijiahaoTitle: '精细化版标题', covers: {}, coverStatus: 'completed', designStatus: 'completed' },
      { videoId: 10, producer: 'huasheng', title: '花生版原长标题', baijiahaoTitle: '花生版原长标题', covers: {}, coverStatus: 'completed', designStatus: 'completed' },
    ],
  } } })
  await h.openManuscript()
  await h.page.getByRole('tab', { name: '成片与封面', exact: true }).last().click()
  const title = h.page.getByRole('textbox', { name: '百家号视频标题' })
  await title.fill('精细化版尚未保存的修改')
  const openTitle = async () => {
    await h.page.getByRole('tab', { name: '花生制作', exact: true }).last().click()
    await h.detail.getByRole('button', { name: '编辑发布标题', exact: true }).click()
    await h.page.waitForFunction(() => document.querySelector('.cover-editor textarea')?.value === '花生版原长标题')
    assert.equal(await h.page.getByRole('group', { name: '成片版本' }).getByRole('button', { name: /花生版/ }).getAttribute('aria-pressed'), 'true')
  }
  await openTitle()
  await h.page.getByRole('group', { name: '成片版本' }).getByRole('button', { name: /精细化版/ }).click()
  assert.equal(await title.inputValue(), '精细化版尚未保存的修改')
  await title.fill('精细化版标题')
  await openTitle()
  await h.page.getByRole('group', { name: '成片版本' }).getByRole('button', { name: /精细化版/ }).click()
  assert.equal(await title.inputValue(), '精细化版标题')
  assert.deepEqual(h.writes, [])
})

test('workflow state remains scoped to the exact project, manuscript revision and producer', async t => {
  const jobs = [completedJob({ id: 1 }), completedJob({ id: 2 }), completedJob({ id: 3, sourceId: 103 }), completedJob({ id: 4, sourceId: 104 })]
  const h = await harness(t, { state: { jobs }, workflowVersions: [
    workflowFixture(jobs[1], { state: 'published', stage: 'publication', message: '本版已发表' }),
    workflowFixture(jobs[2], { state: 'published', stage: 'publication', scriptSha256: sha('旧稿'), message: '旧稿已发表' }),
    workflowFixture(jobs[3], { state: 'published', stage: 'publication', producer: 'motion', message: '精细化版已发表' }),
  ] })
  await h.openProduction()
  for (const id of [1, 3, 4]) {
    await h.openJob(id)
    await h.jobDetail.getByLabel('流程状态：等待导出', { exact: true }).waitFor()
  }
  await h.openJob(2)
  await h.jobDetail.getByLabel('流程状态：已发表', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('workflow read failures preserve the last result with a warning and refresh recovers current status', async t => {
  const job = completedJob()
  const h = await harness(t, { state: { jobs: [job] }, workflowVersions: [workflowFixture(job, { state: 'submitted', stage: 'publication', message: '已提交，等待审核' })] })
  await h.openProduction()
  await h.openJob(1)
  await h.jobDetail.getByLabel('流程状态：已提交审核', { exact: true }).waitFor()
  h.controls.failWorkflow = true
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '显示上次流程状态' }).waitFor()
  await h.jobDetail.getByLabel('流程状态：已提交审核', { exact: true }).waitFor()
  h.controls.failWorkflow = false
  Object.assign(h.workflowVersions[0], { state: 'published', message: '已发表到百家号' })
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.jobDetail.getByLabel('流程状态：已发表', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('alert').filter({ hasText: '显示上次流程状态' }).count(), 0)
  assert.deepEqual(h.writes, [])
})

test('workflow fallback never treats incomplete legacy products as ready and retains shared export progress', async t => {
  const jobs = [completedJob(), completedJob({ id: 2, sourceId: 102 })]
  const h = await harness(t, { state: { jobs }, workflowVersions: [workflowFixture(jobs[1], { state: 'exporting', stage: 'export', exportJobId: 99, videoId: null, message: '正在下载原导出成片' })],
    exports: { jobs: [exportFixture({ status: 'completed', designStatus: 'completed', coverStatus: 'failed' })] } })
  await h.openProduction()
  await h.openJob(1)
  await h.jobDetail.getByLabel('流程状态：产物待补齐', { exact: true }).waitFor()
  const packaging = h.jobDetail.getByLabel('任务 #1 全流程进度', { exact: true }).locator('li').nth(2)
  assert.equal(await packaging.getAttribute('class'), 'error')
  await h.openJob(2)
  await h.jobDetail.getByLabel('流程状态：导出下载中', { exact: true }).waitFor()
  await h.jobDetail.getByLabel('任务 #2 全流程进度', { exact: true }).getByText('正在下载原导出成片', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('an initial workflow read failure never claims publication and can recover by refreshing', async t => {
  const job = completedJob()
  const h = await harness(t, { failWorkflow: true, state: { jobs: [job] }, workflowVersions: [workflowFixture(job, { state: 'published', stage: 'publication', message: '已发表到百家号' })] })
  await h.openProduction()
  await h.openJob(1)
  await h.jobDetail.getByLabel('流程状态：流程状态未确认', { exact: true }).waitFor()
  assert.equal(await h.jobDetail.getByLabel('流程状态：已发表', { exact: true }).count(), 0)
  await h.panel.getByRole('alert').filter({ hasText: '发表结果暂未确认' }).waitFor()
  h.controls.failWorkflow = false
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.jobDetail.getByLabel('流程状态：已发表', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('saving a new manuscript cannot inherit its previous version publication badge', async t => {
  const job = completedJob()
  const h = await harness(t, { state: { jobs: [job] }, workflowVersions: [workflowFixture(job, { state: 'published', stage: 'publication', message: '原版已发表' })] })
  await h.openManuscript()
  await h.page.locator('.source-production-link').getByText('花生 · 已发表', { exact: true }).waitFor()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('这是保存后的新版本正文，尚未制作或发表。')
  await h.page.getByRole('button', { name: '保存修改', exact: true }).click()
  await h.page.waitForFunction(() => !document.querySelector('.source-production-link'))
  assert.equal(await h.page.locator('.source-production-link').count(), 0)
  assert.equal(h.source.rewrittenScript, '这是保存后的新版本正文，尚未制作或发表。')
})

test('project and recovery-home actions open the task-bound Huasheng profile and report failures', async t => {
  const h = await harness(t, { state: { jobs: [completedJob(), jobFixture({ id: 2, sourceId: 102, title: '原项目待恢复', status: 'needs_attention', stage: 'create_pending', checkpoint: 'create_pending' })] } })
  await h.openProduction()
  const current = await h.openJob(1)
  assert.equal(await h.panel.locator('a[href*="huasheng.cn"]').count(), 0)
  let release, failure = false
  const pending = new Promise(resolve => { release = resolve })
  await h.page.route(`**${root}/huasheng/jobs/*/open-project`, async route => {
    const path = new URL(route.request().url()).pathname
    h.writes.push({ path, method: route.request().method(), body: route.request().postDataJSON() })
    if (failure) return route.fulfill({ status: 503, json: { code: 503, message: '原任务账号浏览器连接失败' } })
    await pending
    return route.fulfill({ json: { code: 200, data: { accountName: 'original-history-profile', projectUrl: path.includes('/2/') ? 'https://www.huasheng.cn/' : 'https://www.huasheng.cn/video/123', reused: true, message: '已在原任务账号打开花生页面' } } })
  })
  const open = current.getByRole('button', { name: '下载视频，打开花生项目', exact: true })
  await open.click()
  await current.getByText('正在打开…', { exact: true }).waitFor()
  assert.equal(await open.isDisabled(), true)
  release()
  await h.panel.getByText('已在原任务账号打开花生页面', { exact: true }).waitFor()
  failure = true
  await open.click()
  await h.panel.getByRole('alert').filter({ hasText: '原任务账号浏览器连接失败' }).waitFor()
  failure = false
  const recovery = await h.openJob(2)
  await recovery.getByText('绑定已有花生项目', { exact: true }).click()
  await recovery.getByRole('button', { name: '花生我的项目', exact: true }).click()
  await h.panel.getByText('已在原任务账号打开花生页面', { exact: true }).waitFor()
  assert.deepEqual(h.writes.map(item => [item.path, item.method, item.body]), [
    [`${root}/huasheng/jobs/1/open-project`, 'POST', {}],
    [`${root}/huasheng/jobs/1/open-project`, 'POST', {}],
    [`${root}/huasheng/jobs/2/open-project`, 'POST', {}],
  ])
  assert.equal(h.page.context().pages().length, 1)
})

async function harness(t, options = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: options.viewport || { width: 1440, height: 1000 } })
  page.setDefaultTimeout(6000)
  if (options.clock) await page.clock.install()
  if (options.storageUnavailable) await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage unavailable', 'SecurityError') } })
  })
  const source = { ...sourceFixture(), ...options.source }
  const state = { enabled: true, browser: { status: 'ready', message: '花生页面检测通过' }, jobs: [], productionChecking: false, monitoring: monitoringFixture(), continuationTask: null, ...options.state }
  const account = { accountName: 'history_huasheng_legacy', label: '历史专用账号', scope: 'history', status: 'ready', message: '账号身份已核验', isDefault: true, identity: { uid: 'history-test', displayName: '历史创作者' }, observedIdentity: { uid: 'history-test', displayName: '历史创作者' }, identityStatus: 'verified', checkedAt: '2026-11-01T04:00:00.000Z', ...options.account }
  const writes = []
  const reads = []
  const exportReads = []
  const workflowVersions = options.workflowVersions || []
  const productReads = []
  const exports = { enabled: false, jobs: [], ...options.exports }
  const products = {
    delivery: { title: '', description: '', covers: {}, coverStatus: 'idle', designStatus: 'idle' },
    article: { status: 'idle', canGenerate: false, unavailableReason: '请先关联成片' },
    ...options.products,
  }
  const controls = { failGet: false, failCheck: false, failSettings: false, loseSubmit: false, delayGet: false, delayOverview: false, pending: [], accountResponse: null, failProduction: false, loseProduction: false, productionCheckingResult: true, failMonitoring: false, loseMonitoring: false,
    failExportGet: false, failExportSettings: false, loseExportSettings: false, loseExportSubmit: false, dropExportSubmit: false, loseExportResume: false, dropExportResume: false, delayExportGet: false, exportPending: [], delayExportWrite: false, exportWritePending: [], exportWriteHeld: null, failExportResumes: [],
    produceResults: null, rejectProduce: false, loseProduce: false, dropProduce: false, delayProduce: false, producePending: [], failWorkflow: !!options.failWorkflow,
  }
  const fulfill = (route, data) => route.fulfill({ json: { code: 200, data } })
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseUrl).origin ? route.continue() : route.abort('blockedbyclient'))
  await page.route('**/api/v1/**', async route => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const method = req.method()
    if (path === `${root}/uploads/candidates` || /^\/api\/v1\/history-scripts\/uploads\/sources\/\d+\/state$/.test(path)) {
      assert.equal(method, 'GET')
      if (controls.failWorkflow) return route.fulfill({ status: 503, json: { code: 503, message: '全流程状态暂不可用' } })
      const sourceId = path.match(/\/sources\/(\d+)\/state$/)?.[1]
      return fulfill(route, sourceId ? { production: { versions: workflowVersions.filter(version => String(version.scriptId) === sourceId) } }
        : { items: [{ scriptId: source.id, title: source.title, versions: workflowVersions }] })
    }
    if (path === `${root}/101/continuation`) return fulfill(route, { task: state.continuationTask, complete: false })
    if (path === `${root}/101/continue`) {
      const body = req.postDataJSON()
      writes.push({ path, method, body })
      assert.equal(method, 'POST')
      if (body.expectedRevision !== source.revision) return route.fulfill({ status: 409, json: { code: 409, message: '稿件已更新，请刷新后继续生产' } })
      if (!state.continuationTask) {
        state.continuationTask = { id: 810, status: 'queued', progressMessage: '正在继续原生产任务' }
        if (source.artifactState?.rewritten === 'current' && source.rewrittenScript) {
          state.jobs.unshift(jobFixture({ id: state.jobs.length + 1, scriptSha256: sha(source.rewrittenScript) }))
        }
      }
      if (controls.loseSubmit) return route.abort('failed')
      return fulfill(route, { task: state.continuationTask, complete: false, created: true })
    }
    if (path.startsWith(`${root}/huasheng/exports`)) {
      if (method === 'GET') {
        exportReads.push(new URL(req.url()).pathname + new URL(req.url()).search)
        if (controls.failExportGet) return route.fulfill({ status: 503, json: { code: 503, message: '自动导出状态暂不可用' } })
        const sourceId = new URL(req.url()).searchParams.get('sourceId')
        const data = structuredClone({ enabled: exports.enabled, jobs: exports.jobs.filter(job => !sourceId || String(job.sourceId) === sourceId), ...(exports.worker ? { worker: exports.worker } : {}), ...(exports.production ? { production: exports.production } : {}) })
        if (controls.delayExportGet) {
          await new Promise(resolve => controls.exportPending.push(async () => { await fulfill(route, data); resolve() }))
          return
        }
        return fulfill(route, data)
      }
      writes.push({ path, method, body: req.postDataJSON() })
      if (path.endsWith('/settings')) {
        assert.equal(method, 'PUT')
        if (controls.failExportSettings) return route.fulfill({ status: 503, json: { code: 503, message: '自动导出设置未保存' } })
        exports.enabled = req.postDataJSON().enabled
        if (controls.loseExportSettings) return route.abort('failed')
        return fulfill(route, { enabled: exports.enabled })
      }
      assert.equal(method, 'POST')
      if (path === `${root}/huasheng/exports`) {
        assert.deepEqual(Object.keys(req.postDataJSON()), ['sourceIds'])
        if (controls.dropExportSubmit) return route.abort('failed')
        for (const sourceId of req.postDataJSON().sourceIds) {
          assert.equal(Number.isSafeInteger(sourceId), true)
          const parent = state.jobs.filter(job => Number(job.sourceId) === sourceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.id) - Number(a.id))[0]
          if (!exports.jobs.some(job => String(job.huashengJobId) === String(parent.id) && job.scriptSha256 === parent.scriptSha256)) {
            exports.jobs.push(exportFixture({ id: exports.jobs.length + 1, huashengJobId: parent.id, sourceId, scriptSha256: parent.scriptSha256, projectUrl: parent.projectUrl }))
          }
        }
        if (exports.worker) exports.worker = { status: 'running', message: '所选任务正在处理' }
        if (controls.delayExportWrite) await new Promise(resolve => { controls.exportWritePending.push(resolve); controls.exportWriteHeld?.() })
        if (controls.loseExportSubmit) return route.abort('failed')
        return fulfill(route, { jobs: exports.jobs })
      }
      const match = path.match(/\/exports\/([^/]+)\/resume$/)
      if (match) {
        assert.deepEqual(req.postDataJSON(), {})
        assert.match(match[1], /^[1-9]\d*$/)
        const job = exports.jobs.find(job => String(job.id) === match[1])
        assert.ok(job)
        assert.ok(['failed', 'needs_attention'].includes(job.status) || job.status === 'completed' && job.coverStatus !== 'completed')
        assert.notEqual(job.stage, 'export_uncertain')
        if (controls.failExportResumes.includes(Number(job.id))) return route.fulfill({ status: 503, json: { code: 503, message: '原任务暂时无法恢复' } })
        if (controls.dropExportResume) return route.abort('failed')
        job.status = job.videoUrl ? 'processing' : 'queued'
        job.message = '继续未完成步骤'
        job.error = null
        job.updatedAt = '2026-10-23T00:01:00.000Z'
        for (const key of ['designStatus', 'coverStatus', 'articleStatus']) if (!job[key] || ['failed', 'needs_attention'].includes(job[key])) job[key] = 'queued'
        if (controls.delayExportWrite) await new Promise(resolve => { controls.exportWritePending.push(resolve); controls.exportWriteHeld?.() })
        if (controls.loseExportResume) return route.abort('failed')
        return fulfill(route, { job })
      }
      throw new Error(`Unexpected export write: ${method} ${path}`)
    }
    if (path.startsWith(`${root}/huasheng/accounts`)) {
      if (method === 'GET') return fulfill(route, { accounts: [account], defaultAccountName: account.accountName, scope: 'history' })
      writes.push({ path, method, body: req.postDataJSON() })
      assert.equal(method, 'POST')
      assert.ok(['login', 'check'].some(action => path === `${root}/huasheng/accounts/${account.accountName}/${action}`))
      assert.deepEqual(req.postDataJSON(), {})
      if (controls.failCheck) return route.fulfill({ status: 503, json: { code: 503, message: '浏览器未连接' } })
      if (controls.accountResponse) Object.assign(account, controls.accountResponse)
      return fulfill(route, account)
    }
    if (path.includes('/huasheng')) {
      if (method === 'GET') {
        reads.push(path)
        if (controls.failGet) return route.fulfill({ status: 503, json: { code: 503, message: '花生服务连接失败' } })
        const data = structuredClone(path === `${root}/huasheng` ? state : {
          jobs: state.jobs.filter(job => job.sourceId === source.id),
          ...(options.sourceCheckingFlag === false ? {} : { productionChecking: state.productionChecking }),
        })
        if (options.paginated && path === `${root}/huasheng`) {
          const beforeId = Number(new URL(req.url()).searchParams.get('beforeId')) || Infinity
          data.jobs = state.jobs.filter(job => Number(job.id) < beforeId).slice(0, 50)
          data.nextBeforeId = data.jobs.length === 50 ? data.jobs.at(-1).id : null
          data.total = state.jobs.length
          data.productionCounts = Object.fromEntries(['not_started', 'queued', 'creating', 'completed'].map(status => [status, state.jobs.filter(job => job.productionStatus === status).length]))
        }
        if (controls.delayGet || controls.delayOverview && path === `${root}/huasheng`) {
          await new Promise(resolve => controls.pending.push(async () => { await fulfill(route, data); resolve() }))
          return
        }
        return fulfill(route, data)
      }
      writes.push({ path, method, body: req.postDataJSON() })
      if (path === `${root}/huasheng/produce`) {
        assert.equal(method, 'POST')
        const body = req.postDataJSON()
        assert.deepEqual(Object.keys(body), ['jobIds'])
        assert.ok(body.jobIds.length > 0 && body.jobIds.length <= 100)
        assert.ok(body.jobIds.every(id => Number.isSafeInteger(id) && id > 0))
        assert.equal(new Set(body.jobIds).size, body.jobIds.length)
        if (controls.rejectProduce) return route.fulfill({ status: 409, json: { code: 409, message: '任务正在被其他操作处理，请刷新后重试' } })
        if (controls.dropProduce) return route.abort('failed')
        const results = controls.produceResults || body.jobIds.map(jobId => {
          const job = state.jobs.find(item => Number(item.id) === jobId)
          assert.ok(job, 'Only selected existing jobs may be produced')
          return { jobId, sourceId: Number(job.sourceId), status: 'queued', message: '已加入本次执行，等待提交花生' }
        })
        for (const result of results) {
          assert.ok(body.jobIds.includes(result.jobId), 'The response must not accept unselected tasks')
          const job = state.jobs.find(item => Number(item.id) === result.jobId)
          if (result.status === 'queued') Object.assign(job, { status: 'queued', stage: 'queued', message: result.message, error: null, cancelRequested: false, updatedAt: '2026-10-24T14:30:00.000Z' })
        }
        if (controls.delayProduce) await new Promise(resolve => controls.producePending.push(resolve))
        if (controls.loseProduce) return route.abort('failed')
        return route.fulfill({ status: 202, json: { code: 200, data: { results } } })
      }
      if (path.endsWith('/check-production')) {
        assert.equal(method, 'POST')
        assert.ok([`${root}/huasheng/check-production`, `${root}/101/huasheng/check-production`].includes(path))
        const body = req.postDataJSON()
        if ('jobIds' in body) {
          assert.equal(path, `${root}/huasheng/check-production`)
          assert.deepEqual(Object.keys(body), ['jobIds'])
          assert.ok(Array.isArray(body.jobIds))
          if (!body.jobIds.length) return route.fulfill({ status: 400, json: { code: 400, message: '请选择需要检查的项目' } })
          assert.ok(body.jobIds.length <= 100)
          assert.ok(body.jobIds.every(id => Number.isSafeInteger(id) && id > 0))
        } else assert.deepEqual(body, {})
        if (controls.failProduction) return route.fulfill({ status: 503, json: { code: 503, message: '创作状态检查暂不可用' } })
        state.productionChecking = controls.productionCheckingResult
        if (controls.loseProduction) return route.abort('failed')
        return route.fulfill({ status: 202, json: { code: 200, data: { checking: state.productionChecking } } })
      }
      if (path.endsWith('/settings')) {
        if (controls.failSettings) return route.fulfill({ status: 503, json: { code: 503, message: '自动制作设置未保存' } })
        state.enabled = req.postDataJSON().enabled
        return fulfill(route, { enabled: state.enabled })
      }
      if (path === `${root}/huasheng/monitoring`) {
        assert.equal(method, 'PUT')
        assert.equal(typeof req.postDataJSON().enabled, 'boolean')
        if (controls.failMonitoring) return route.fulfill({ status: 503, json: { code: 503, message: '循环监测设置未保存' } })
        state.monitoring.enabled = req.postDataJSON().enabled
        if (controls.loseMonitoring) return route.abort('failed')
        return fulfill(route, state.monitoring)
      }
      if (path === `${root}/101/huasheng`) {
        const job = jobFixture({ id: state.jobs.length + 1, scriptSha256: sha(source.rewrittenScript) })
        state.jobs = [job, ...state.jobs]
        if (controls.loseSubmit) return route.abort('failed')
        return fulfill(route, { job })
      }
      const match = path.match(/\/jobs\/([^/]+)\/(resume|cancel)$/)
      if (match) {
        const job = state.jobs.find(job => String(job.id) === match[1])
        job.status = match[2] === 'resume' ? 'queued' : 'canceled'
        return fulfill(route, { job })
      }
      throw new Error(`Unexpected Huasheng write: ${method} ${path}`)
    }
    if (path === root) return fulfill(route, { items: [source], total: 1 })
    if (path === `${root}/101`) {
      if (method === 'PATCH') {
        source.rewrittenScript = req.postDataJSON().rewrittenScript
        source.revision = 'saved-revision-102'
      }
      return fulfill(route, source)
    }
    if (path.endsWith('/delivery') || path.endsWith('/article')) {
      assert.equal(method, 'GET')
      productReads.push(path)
      return fulfill(route, products[path.endsWith('/delivery') ? 'delivery' : 'article'])
    }
    if (path.endsWith('/jobs')) return fulfill(route, { job: null, recent: [] })
    return fulfill(route, {})
  })
  await page.goto(`${baseUrl}/history-scripts?script=101`, { waitUntil: 'domcontentloaded' })
  const panel = page.getByRole('region', { name: '花生自动制作', exact: true, includeHidden: true })
  const detail = page.getByRole('region', { name: '当前稿花生制作', exact: true, includeHidden: true })
  const taskList = panel.getByRole('list', { name: '花生制作队列', exact: true })
  const jobDetail = panel.locator('.queue .job-row')
  const openBatch = async () => {
    if (!await panel.locator('.export-batch').isVisible()) {
      await panel.getByRole('button', { name: /^批量操作（\d+）$/ }).click()
    }
  }
  const openJob = async id => {
    if (!await panel.locator('.task-rail').isVisible()) {
      await panel.getByRole('button', { name: '返回任务列表', exact: true }).click()
    }
    await taskList.getByRole('button', { name: `查看任务 #${id} 详情`, exact: true }).click()
    await jobDetail.locator('.job-reference').filter({ hasText: new RegExp(`任务 #${id}$`) }).waitFor()
    return jobDetail
  }
  const openProduction = async ({ settings = false } = {}) => {
    await page.getByRole('tab', { name: /^视频制作(?:\s|$)/ }).click()
    await panel.waitFor()
    if (settings && await panel.getByRole('button', { name: '制作设置', exact: true }).getAttribute('aria-expanded') !== 'true') {
      await panel.getByRole('button', { name: '制作设置', exact: true }).click()
    }
  }
  const openManuscript = async () => {
    await page.getByRole('tab', { name: /^稿件库(?:\s|$)/ }).click()
    await page.getByRole('tab', { name: '文稿', exact: true }).click()
    await page.getByRole('textbox', { name: '编辑待审稿' }).waitFor()
  }
  const openDetail = async () => {
    await page.getByRole('tab', { name: /^稿件库(?:\s|$)/ }).click()
    await page.getByRole('tab', { name: '花生制作', exact: true }).click()
    await detail.waitFor()
  }
  await openDetail()
  await detail.locator('button[data-submit]').waitFor()
  return { browser, page, panel, detail, taskList, jobDetail, source, state, account, controls, writes, reads, exports, exportReads, products, productReads, workflowVersions, openProduction, openBatch, openJob, openDetail, openManuscript }
}

test('saved current scripts continue through the shared coordinator; loading never backfills old scripts', async t => {
  const h = await harness(t)
  await h.openProduction({ settings: true })
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('checkbox', { name: '二创成功后自动制作' }).isChecked(), true)
  await h.openDetail()
  const submit = h.detail.getByRole('button', { name: '继续生产', exact: true })
  await h.page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '继续生产' && !button.disabled))
  assert.equal(h.writes.length, 0)
  await h.openManuscript()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('尚未保存的新稿。')
  await h.openDetail()
  assert.equal(await submit.isEnabled(), false)
  await h.detail.getByText('请先保存当前修改，再继续生产。', { exact: true }).waitFor()
  await h.openManuscript()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill(h.source.rewrittenScript)
  await h.openDetail()
  await submit.click()
  const progress = h.detail.getByRole('button', { name: '查看生产进度', exact: true })
  await progress.waitFor()
  await progress.click()
  assert.deepEqual(h.writes, [{ path: `${root}/101/continue`, method: 'POST', body: { expectedRevision: h.source.revision } }])
})

test('failed account checks never retain a successful verification message from a previous read', async t => {
  const h = await harness(t, { state: { browser: { status: 'ready', message: '花生已登录，可以制作' } } })
  await h.openProduction({ settings: true })
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  h.controls.failCheck = true
  await h.panel.getByRole('button', { name: '花生账号', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: '历史花生账号', exact: true })
  await dialog.getByRole('button', { name: '检查账号', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: '浏览器未连接' }).waitFor()
  await dialog.getByText('检查未完成', { exact: true }).waitFor()
  assert.equal(await dialog.getByText('已核验，可制作', { exact: true }).count(), 0)
  assert.equal(await dialog.getByText('账号身份已核验', { exact: true }).count(), 0)
  h.controls.failCheck = false
  h.state.browser = { status: 'login_required', message: '请在专用窗口登录花生' }
  h.controls.accountResponse = { status: 'login_required', identityStatus: 'unverified', observedIdentity: null, message: '请完成登录后检查账号' }
  await dialog.getByRole('button', { name: '登录窗口', exact: true }).click()
  await dialog.getByText('待登录', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('alert').count(), 0)
  h.state.browser = { status: 'ready', message: '花生页面检测通过' }
  h.controls.accountResponse = { status: 'ready', identityStatus: 'verified', observedIdentity: { uid: 'history-test', displayName: '历史创作者' }, message: '账号身份已核验' }
  await dialog.getByRole('button', { name: '检查账号', exact: true }).click()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭历史花生账号管理', exact: true }).click()
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  assert.deepEqual(h.writes.map(write => write.body), [{}, {}, {}])
})

test('automation settings are persisted without backfilling; a failed save retains the previous value', async t => {
  const h = await harness(t)
  await h.openProduction({ settings: true })
  const toggle = h.panel.getByRole('checkbox', { name: '二创成功后自动制作' })
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  await toggle.click()
  await h.page.waitForFunction(() => document.querySelector('[aria-label="花生自动制作"] .settings-automation input')?.checked === false)
  assert.equal(h.state.enabled, false)
  assert.equal(await toggle.isChecked(), false)
  h.controls.failSettings = true
  await toggle.click()
  await h.panel.getByRole('alert').filter({ hasText: '自动制作设置未保存' }).waitFor()
  assert.equal(await toggle.isChecked(), false)
  h.controls.failSettings = false
  await toggle.click()
  await h.page.waitForFunction(() => document.querySelector('[aria-label="花生自动制作"] .settings-automation input')?.checked)
  assert.equal(h.writes.filter(write => write.path === `${root}/101/huasheng`).length, 0)
  assert.deepEqual(h.writes.map(write => write.body), [{ enabled: false }, { enabled: true }, { enabled: true }])
})

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`production settings remain reachable after scrolling without shrinking the list at ${viewport.width}px`, async t => {
    const h = await harness(t, { viewport, state: { jobs: Array.from({ length: 20 }, (_, index) => jobFixture({ id: index + 1, sourceId: index + 101, title: `历史制作任务 ${index + 1}` })) } })
    await h.openProduction()
    const selectAll = h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true })
    await h.openBatch()
    await selectAll.check()
    if (viewport.width <= 760) await h.panel.getByRole('button', { name: '返回任务列表', exact: true }).click()
    const queue = h.panel.locator('.queue')
    const before = await h.taskList.boundingBox()
    await h.taskList.locator('.task-item').last().scrollIntoViewIfNeeded()
    const listScroll = await h.taskList.evaluate(element => element.scrollTop)
    await h.openJob(20)
    const settingsButton = h.panel.getByRole('button', { name: '制作设置', exact: true })
    await settingsButton.click()
    const settings = h.panel.getByRole('region', { name: '制作设置', exact: true })
    await settings.waitFor()
    const bounds = await settings.boundingBox()
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `Settings are not reachable: ${JSON.stringify(bounds)}`)
    if (viewport.width > 760) {
      const after = await h.taskList.boundingBox()
      assert.ok(Math.abs(after.height - before.height) <= 1, 'Settings must not shrink the task-list viewport')
      assert.equal(await queue.evaluate(element => element.scrollTop), 0)
      assert.equal(await h.taskList.evaluate(element => element.scrollTop), listScroll, 'Opening settings must not scroll the left task list')
    }
    assert.equal(await selectAll.isChecked(), true)
    await settingsButton.click()
    assert.equal(await settings.isVisible(), false)
    assert.equal(await selectAll.isChecked(), true)
    assert.deepEqual(h.writes, [], 'Opening settings must not start any production or monitoring')
  })
}

test('short desktop keeps the last task and footer reachable when quota and inspection notices use extra space', async t => {
  const h = await harness(t, { viewport: { width: 820, height: 601 }, state: { productionChecking: true, jobs: Array.from({ length: 12 }, (_, index) => jobFixture({
    id: index + 1, sourceId: index + 101, status: 'needs_attention', checkpoint: 'quota_waiting',
    title: `标准额度不足的历史任务 ${index + 1}`, error: '花生今日标准模式额度已用完',
  })) }, exports: { worker: { status: 'stopped', message: '后台自动处理未运行' } } })
  await h.openProduction()
  const queue = h.panel.locator('.queue')
  assert.ok((await queue.boundingBox()).height >= 240)
  const lastTask = h.taskList.locator('.task-item').last()
  await lastTask.scrollIntoViewIfNeeded()
  const lastBounds = await lastTask.boundingBox()
  assert.ok(lastBounds.y >= 0 && lastBounds.y + lastBounds.height <= 602, `Last task is clipped: ${JSON.stringify(lastBounds)}`)
  await h.openJob(12)
  for (const target of [h.jobDetail.getByRole('button', { name: '恢复', exact: true }), h.panel.locator('.queue-footer')]) {
    await target.scrollIntoViewIfNeeded()
    const bounds = await target.boundingBox()
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 602, `Controls are clipped: ${JSON.stringify(bounds)}`)
  }
  assert.deepEqual(h.writes, [])
})

test('loop monitoring checks only after read confirmation, persists on reload and stays independent of automatic production', async t => {
  const h = await harness(t, { clock: true, state: { enabled: false } })
  await h.openProduction()
  const monitor = h.panel.getByRole('checkbox', { name: /^循环监测/ })
  await monitor.waitFor()
  assert.equal(await monitor.isChecked(), false)
  assert.equal(await monitor.isEnabled(), true)
  assert.equal(await h.panel.getByRole('button', { name: '制作设置', exact: true }).getAttribute('aria-expanded'), 'false')
  assert.equal(await h.detail.getByRole('checkbox', { name: /^循环监测/ }).count(), 0)
  h.controls.delayGet = true
  const reconcile = h.page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === `${root}/huasheng`)
  await monitor.click()
  await reconcile
  assert.equal(await monitor.isChecked(), false, 'the checkbox must not optimistically accept the PUT response')
  assert.equal(await monitor.isEnabled(), false)
  assert.equal(h.state.monitoring.enabled, true)
  assert.equal(h.state.enabled, false)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/monitoring`, method: 'PUT', body: { enabled: true } }])
  assert.equal(h.controls.pending.length, 1)
  h.controls.delayGet = false
  await Promise.all(h.controls.pending.splice(0).map(release => release()))
  await h.panel.locator('.monitor-interval').getByText('60 秒', { exact: true }).waitFor()
  assert.equal(await monitor.isChecked(), true)
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] .monitor-toggle input')?.disabled)
  await h.openProduction({ settings: true })
  const automatic = h.panel.getByRole('checkbox', { name: '二创成功后自动制作', exact: true })
  assert.equal(await automatic.isChecked(), false)
  await automatic.click()
  await h.page.waitForFunction(() => document.querySelector('[aria-label="花生自动制作"] .settings-automation input')?.checked)
  assert.equal(await monitor.isChecked(), true)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openProduction({ settings: true })
  await h.panel.locator('.monitor-interval').getByText('60 秒', { exact: true }).waitFor()
  assert.equal(await monitor.isChecked(), true)
  assert.equal(await automatic.isChecked(), true)
  assert.deepEqual(h.state.monitoring, { ...monitoringFixture(), enabled: true })
  assert.deepEqual(h.writes, [
    { path: `${root}/huasheng/monitoring`, method: 'PUT', body: { enabled: true } },
    { path: `${root}/huasheng/settings`, method: 'PUT', body: { enabled: true } },
  ])
})

for (const scenario of ['rejected', 'lostResponse']) {
  test(`loop monitoring ${scenario} reconciles with GET without repeating a write`, async t => {
    const h = await harness(t, { clock: true })
    await h.openProduction()
    const monitor = h.panel.getByRole('checkbox', { name: /^循环监测/ })
    await monitor.waitFor()
    assert.equal(await monitor.isChecked(), false)
    h.controls.failMonitoring = scenario === 'rejected'
    h.controls.loseMonitoring = scenario === 'lostResponse'
    h.controls.delayGet = true
    const reconcile = h.page.waitForRequest(request => request.method() === 'GET' && new URL(request.url()).pathname === `${root}/huasheng`)
    await monitor.click()
    await reconcile
    await h.panel.getByRole('alert').waitFor()
    if (scenario === 'rejected') assert.match(await h.panel.getByRole('alert').innerText(), /循环监测设置未保存/)
    assert.equal(await monitor.isChecked(), false)
    assert.equal(await monitor.isEnabled(), false)
    assert.equal(h.controls.pending.length, 1)
    h.controls.delayGet = false
    await Promise.all(h.controls.pending.splice(0).map(release => release()))
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] .monitor-toggle input')?.disabled)
    assert.equal(await monitor.isChecked(), scenario === 'lostResponse')
    assert.equal(h.state.enabled, true)
    const before = h.reads.length
    await h.page.clock.fastForward(60000)
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
    assert.ok(h.reads.length > before, 'read-only polling must continue after a failed or lost write response')
    await h.page.reload({ waitUntil: 'domcontentloaded' })
    await h.openProduction()
    await monitor.waitFor()
    assert.equal(await monitor.isChecked(), scenario === 'lostResponse')
    assert.deepEqual(h.writes, [{ path: `${root}/huasheng/monitoring`, method: 'PUT', body: { enabled: true } }])
  })
}

test('loop monitoring polls backend results across multiple intervals without posting production checks or replacing a dirty manuscript', async t => {
  const h = await harness(t, { clock: true, state: {
    enabled: false, monitoring: { ...monitoringFixture(), enabled: true },
    jobs: [jobFixture({ status: 'submitted', productionStatus: 'creating', projectUrl: 'https://www.huasheng.cn/video/123' })],
  } })
  await h.openProduction()
  await h.panel.locator('.monitor-interval').getByText('60 秒', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('checkbox', { name: /^循环监测/ }).isChecked(), true)
  await h.openManuscript()
  const editor = await h.page.locator('#rewritten-script').elementHandle()
  const draft = '  循环监测期间的未保存稿\n\n保留换行与空格。  \n'
  await editor.fill(draft)
  for (let interval = 0; interval < 3; interval++) {
    const before = h.reads.length
    if (interval === 1) {
      Object.assign(h.state.jobs[0], { productionStatus: 'completed', productionCheckedAt: '2026-10-22T03:04:05.000Z' })
      Object.assign(h.state.monitoring, { lastCheckedAt: '2026-10-22T03:04:05.000Z', nextCheckAt: '2026-10-22T03:05:05.000Z' })
    }
    await h.page.clock.fastForward(60000)
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
    assert.ok(h.reads.length > before, 'backend monitoring results must remain readable while the dashboard is hidden')
  }
  await h.openProduction()
  await h.openJob(1)
  await h.jobDetail.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  assert.equal(await h.jobDetail.locator('time').getAttribute('datetime'), '2026-10-22T03:04:05.000Z')
  await h.openManuscript()
  assert.equal(await h.page.locator('#rewritten-script').inputValue(), draft)
  assert.equal(await editor.evaluate(element => element === document.querySelector('#rewritten-script')), true)
  assert.equal(h.source.rewrittenScript, sourceFixture().rewrittenScript)
  assert.deepEqual(h.writes, [], 'the backend owns monitoring; elapsed browser timers must never POST a production check')
})

for (const [name, source] of [
  ['stale', { artifactState: { rewritten: 'stale' } }],
  ['missing', { rewrittenScript: '' }],
  ['still processing', { status: 'rewriting' }],
]) {
  test(`${name} drafts recover through continuation without submitting incomplete Huasheng projects`, async t => {
    const h = await harness(t, { source })
    await h.detail.getByText(/二创稿尚未就绪|当前稿已过期|稿件正在读取或处理/).waitFor()
    await h.detail.getByRole('button', { name: '继续生产', exact: true }).click()
    await h.detail.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
    assert.deepEqual(h.writes, [{ path: `${root}/101/continue`, method: 'POST', body: { expectedRevision: h.source.revision } }])
  })
}

test('a script changed in another window is rejected before creating a project', async t => {
  const h = await harness(t)
  h.source.revision = 'newer-on-server'
  h.source.rewrittenScript = '另一个窗口保存的文稿。'
  await h.detail.getByRole('button', { name: '继续生产', exact: true }).click()
  await h.page.getByRole('alert').filter({ hasText: '稿件已更新，请刷新后继续生产' }).waitFor()
  assert.equal(h.state.continuationTask, null)
  assert.equal(h.state.jobs.length, 0)
  assert.deepEqual(h.writes, [{ path: `${root}/101/continue`, method: 'POST', body: { expectedRevision: 'saved-revision-101' } }])
})

test('task actions respect status and script version; confirmed production is not labeled a finished video', async t => {
  const h = await harness(t, { state: { jobs: [
    jobFixture({ status: 'submitted', projectUrl: 'https://www.huasheng.cn/video/123', videoUrl: 'https://www.huasheng.cn/video/123' }),
    jobFixture({ id: 2, sourceId: 102, status: 'waiting_login', title: '等待登录的稿件' }),
    jobFixture({ id: 3, sourceId: 103, status: 'needs_attention', title: '需要确认的稿件', message: '总消耗非零，请到原项目确认后恢复检测', projectUrl: 'https://www.huasheng.cn/video/456' }),
    jobFixture({ id: 4, sourceId: 104, status: 'canceled', title: '已取消的稿件' }),
    jobFixture({ id: 5, sourceId: 105, status: 'running', title: '正在执行的稿件' }),
    jobFixture({ id: 6, status: 'failed', scriptSha256: sha('旧稿'), title: '旧版本稿件', projectUrl: 'javascript:alert(1)' }),
  ] } })
  await h.openProduction()
  const submitted = await h.openJob(1)
  await submitted.locator('.job-status').getByText('已进入创作', { exact: true }).waitFor()
  assert.equal(await submitted.getByRole('button', { name: '恢复', exact: true }).count(), 0)
  assert.equal(await submitted.getByRole('button', { name: '取消任务', exact: true }).count(), 0)
  assert.equal(await submitted.getByRole('button', { name: '查看制作结果' }).getAttribute('type'), 'button')
  await h.openDetail()
  assert.equal(await h.detail.getByText(/已成片|成片完成/).count(), 0)
  assert.equal(await h.detail.getByRole('button', { name: '恢复', exact: true }).count(), 0)
  await h.openProduction()
  const running = await h.openJob(5)
  assert.equal(await running.getByRole('button', { name: '恢复', exact: true }).count(), 0)
  const previous = await h.openJob(6)
  assert.equal(await previous.getByRole('button', { name: '打开花生项目' }).count(), 0)
  const attention = await h.openJob(3)
  await attention.getByRole('button', { name: '恢复', exact: true }).click()
  await attention.locator('.job-status').getByText('等待提交花生', { exact: true }).waitFor()
  assert.equal(h.writes.at(-1).path, `${root}/huasheng/jobs/3/resume`)
  await attention.getByRole('button', { name: '任务 #3 的更多操作', exact: true }).click()
  await attention.getByRole('button', { name: '取消任务', exact: true }).click()
  await attention.locator('.job-status').getByText('已取消', { exact: true }).waitFor()
  assert.equal(h.writes.at(-1).path, `${root}/huasheng/jobs/3/cancel`)
})

test('a lost submission response reconciles the queue without posting twice', async t => {
  const h = await harness(t, { clock: true })
  h.controls.loseSubmit = true
  await h.detail.getByRole('button', { name: '继续生产', exact: true }).click()
  await h.page.getByRole('alert').waitFor()
  await h.page.clock.fastForward(6000)
  await h.detail.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
  await h.detail.getByRole('button', { name: '查看生产进度', exact: true }).click()
  assert.equal(h.writes.filter(write => write.path === `${root}/101/continue`).length, 1)
})

test('polls wait five seconds, never overlap slow requests, and stop on unmount without canceling backend work', async t => {
  const h = await harness(t, { clock: true })
  await h.openProduction()
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  await h.openDetail()
  await h.detail.getByText('当前已保存稿：尚未提交', { exact: true }).waitFor()
  const initial = h.reads.length
  await h.page.clock.fastForward(4000)
  assert.equal(h.reads.length, initial)
  h.controls.delayGet = true
  await h.page.clock.fastForward(1100)
  await h.page.waitForFunction(() => document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  assert.equal(h.reads.length, initial + 2)
  await h.page.clock.fastForward(10000)
  assert.equal(h.reads.length, initial + 2)
  await h.page.getByRole('link', { name: '项目', exact: true }).click()
  await h.panel.waitFor({ state: 'detached' })
  h.controls.delayGet = false
  await Promise.all(h.controls.pending.splice(0).map(release => release()))
  await h.page.clock.fastForward(20000)
  assert.equal(h.reads.length, initial + 2)
  assert.equal(h.writes.length, 0)
})

test('an unavailable account result is not overwritten by a cached ready production overview', async t => {
  const h = await harness(t)
  await h.openProduction({ settings: true })
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  h.controls.accountResponse = { status: 'error', identityStatus: 'unavailable', message: '花生专用浏览器启动失败' }
  await h.panel.getByRole('button', { name: '花生账号', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: '历史花生账号', exact: true })
  await dialog.getByRole('button', { name: '登录窗口', exact: true }).click()
  await dialog.getByText('身份核验失败', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '刷新账号', exact: true }).click()
  await dialog.locator('.account-info p').getByText('花生专用浏览器启动失败', { exact: true }).waitFor()
  assert.equal(await dialog.getByText('已核验，可制作', { exact: true }).count(), 0)
})

test('an uncertain create is recovered only by binding a valid existing Huasheng project', async t => {
  const h = await harness(t, { state: { jobs: [jobFixture({ status: 'needs_attention', stage: 'create_pending', checkpoint: 'create_pending', message: '创建结果不明，请核对我的项目' })] } })
  await h.detail.getByText('当前已保存稿：花生结果待核对', { exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '恢复', exact: true }).count(), 0)
  await h.detail.getByText('绑定已有花生项目', { exact: true }).click()
  const input = h.detail.getByRole('textbox', { name: '已有花生项目链接', exact: true })
  const recover = h.detail.getByRole('button', { name: '绑定并恢复', exact: true })
  await input.fill('https://example.com/video/123')
  assert.equal(await recover.isEnabled(), false)
  await input.fill('https://www.huasheng.cn/video/987654')
  await recover.click()
  await h.detail.getByText('当前已保存稿：花生结果待核对', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/jobs/1/resume`, method: 'POST', body: { projectUrl: 'https://www.huasheng.cn/video/987654' } }])
})

test('saving an edited script permits the new version while keeping the previous version distinguishable', async t => {
  const h = await harness(t, { state: { jobs: [jobFixture({ status: 'submitted' })] } })
  await h.detail.getByText('当前已保存稿：已进入创作', { exact: true }).waitFor()
  await h.openManuscript()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('已经重新编辑的新二创稿。')
  await h.openDetail()
  assert.equal(await h.detail.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), false)
  await h.openManuscript()
  await h.page.getByRole('button', { name: '保存修改', exact: true }).click()
  await h.openDetail()
  await h.detail.getByText('当前已保存稿：尚未提交', { exact: true }).waitFor()
  await h.detail.getByText('其他已保存版本', { exact: true }).waitFor()
  await h.detail.getByRole('button', { name: '继续生产', exact: true }).click()
  await h.detail.getByRole('button', { name: '查看生产进度', exact: true }).waitFor()
  assert.equal(h.state.jobs[0].scriptSha256, sha('已经重新编辑的新二创稿。'))
  assert.equal(h.writes.length, 1)
})

test('Huasheng read failures remain visible without blocking the independent production coordinator', async t => {
  const h = await harness(t)
  await h.openProduction()
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  h.controls.failGet = true
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '花生服务连接失败' }).waitFor()
  assert.equal(await h.panel.getByText('连接已就绪', { exact: true }).count(), 0)
  await h.openDetail()
  await h.detail.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.detail.getByRole('alert').waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), true)
  h.controls.failGet = false
  await h.openProduction()
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.panel.getByText('连接已就绪', { exact: true }).waitFor()
  await h.openDetail()
  await h.detail.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.detail.getByRole('alert').waitFor({ state: 'hidden' })
  assert.equal(h.writes.length, 0)
})

test('the compact panel and recovery controls fit a narrow screen', async t => {
  const h = await harness(t, { viewport: { width: 390, height: 844 }, state: { jobs: [jobFixture({ status: 'needs_attention', checkpoint: 'create_pending' })] } })
  await h.openProduction()
  await h.openJob(1)
  await h.panel.getByText('绑定已有花生项目', { exact: true }).click()
  const width = await h.panel.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  assert.ok(width.scroll <= width.client + 1, `Panel overflows: ${JSON.stringify(width)}`)
  await h.panel.getByRole('textbox', { name: '已有花生项目链接', exact: true }).fill('https://www.huasheng.cn/video/123456')
  assert.equal(await h.panel.getByRole('button', { name: '绑定并恢复', exact: true }).isEnabled(), true)
  await h.openDetail()
  await h.detail.getByText('绑定已有花生项目', { exact: true }).click()
  const detailWidth = await h.detail.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  assert.ok(detailWidth.scroll <= detailWidth.client + 1, `Source panel overflows: ${JSON.stringify(detailWidth)}`)
  const pageWidth = await h.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  assert.ok(pageWidth.scroll <= pageWidth.client + 1, `Page overflows: ${JSON.stringify(pageWidth)}`)
  await h.openProduction()
  for (const width of [768, 1152, 1440]) {
    await h.page.setViewportSize({ width, height: 900 })
    const dimensions = await h.panel.locator('.queue').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    assert.ok(dimensions.scroll <= dimensions.client + 1, `Queue overflows at ${width}px: ${JSON.stringify(dimensions)}`)
  }
})

test('the full queue has counted status and blocker filters, title/id search, and library source links', async t => {
  const statuses = ['not_started', 'queued', 'creating', 'completed']
  const jobs = Array.from({ length: 16 }, (_, index) => jobFixture({
    id: index + 1, sourceId: 101 + index, title: `生产稿件 ${index + 1}`,
    status: index % 4 === 0 ? 'queued' : 'submitted', productionStatus: statuses[index % 4],
  }))
  Object.assign(jobs[0], {
    status: 'needs_attention', checkpoint: 'quota_waiting', projectUrl: 'https://www.huasheng.cn/video/123',
    error: '操作失败：标准模式每日额度已用完；保留标准模式，待额度恢复后从原项目继续，不使用快速模式。',
    productionMessage: '花生今日标准模式额度已用完，项目尚未进入制作。\n保留当前项目和方案，待额度恢复后继续。',
    message: '花生返回 10008：标准模式每日额度已用完，尚未进入制作',
  })
  Object.assign(jobs[4], { status: 'needs_attention', message: '请确认非零消耗', error: '总消耗非零，请到原项目确认后恢复检测' })
  Object.assign(jobs[8], { status: 'failed', productionMessage: '花生今日标准模式额度已用完，项目尚未进入制作' })
  for (const index of [1, 2, 3]) Object.assign(jobs[index], { checkpoint: 'quota_waiting', message: '过去的标准模式额度已用完', error: '花生返回 10008：标准模式每日额度已用完' })
  jobs[3].productionMessage = '当前可下载成片'
  const h = await harness(t, { state: { jobs } })
  await h.detail.getByText('标准额度不足', { exact: true }).waitFor()
  await h.detail.getByText('尚未进入平台队列，待额度恢复后继续标准模式。', { exact: true }).waitFor()
  assert.equal(await h.detail.getByText(jobs[0].error, { exact: true }).isVisible(), false)
  await h.detail.getByText('查看状态记录', { exact: true }).click()
  await h.detail.getByText(jobs[0].error, { exact: true }).waitFor()
  await h.detail.getByText('查看状态记录', { exact: true }).click()
  await h.openProduction()
  const rows = h.taskList.locator('.task-item')
  await rows.last().waitFor()
  assert.equal(await rows.count(), 16)
  for (const job of jobs) {
    const row = await h.openJob(job.id)
    assert.equal(await row.getByRole('button', { name: '查看稿件与产物', exact: true }).count(), 1)
  }
  const quotaRow = await h.openJob(1)
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await h.page.setViewportSize(viewport)
    const dimensions = await h.page.evaluate(() => ({ document: document.documentElement.scrollHeight, body: document.body.scrollHeight, viewport: window.innerHeight }))
    if (viewport.width > 760) assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1, `Production document overflows at ${viewport.width}px: ${JSON.stringify(dimensions)}`)
    else {
      await h.openJob(1)
      assert.equal(await h.panel.locator('.task-rail').isVisible(), false, 'Phone details replace the task list')
      assert.equal(await h.panel.locator('.queue').evaluate(element => getComputedStyle(element).overflowY), 'visible', 'Phone details should scroll with the page')
    }
    assert.equal(await quotaRow.locator('.job-messages > p').count(), 1)
    assert.equal(await quotaRow.getByText(jobs[0].error, { exact: true }).isVisible(), false)
    if (viewport.width === 390) {
      await h.panel.getByRole('button', { name: '返回任务列表', exact: true }).click()
      const height = await rows.filter({ has: h.page.getByRole('button', { name: '查看任务 #1 详情', exact: true }) }).evaluate(element => element.getBoundingClientRect().height)
      assert.ok(height < 300, `Collapsed quota task preview is too tall: ${height}px`)
      await h.openJob(1)
    }
  }
  await quotaRow.getByText('查看状态记录', { exact: true }).click()
  for (const message of [jobs[0].error, jobs[0].productionMessage, jobs[0].message]) {
    await quotaRow.getByText(message, { exact: true }).waitFor()
  }
  await quotaRow.scrollIntoViewIfNeeded()
  assert.equal(await quotaRow.getByText(jobs[0].error, { exact: true }).isVisible(), true)
  await quotaRow.getByText('查看状态记录', { exact: true }).click()
  const attentionRow = await h.openJob(5)
  await attentionRow.getByText(jobs[4].error, { exact: true }).waitFor()
  await h.page.setViewportSize({ width: 1440, height: 1000 })
  const filters = h.panel.getByRole('group', { name: '创作状态筛选', exact: true })
  for (const [label, count] of [['全部', 16], ['未开始', 4], ['排队中', 4], ['创作中', 4], ['素材就绪', 4]]) {
    const filter = filters.getByRole('button', { name: new RegExp(`^${label}\\s*${count}$`) })
    await filter.click()
    assert.equal(await filter.getAttribute('aria-pressed'), 'true')
    assert.equal(await rows.count(), count)
    if (['排队中', '创作中', '素材就绪'].includes(label)) {
      for (const job of jobs.filter(job => job.productionStatus === ({ 排队中: 'queued', 创作中: 'creating', 素材就绪: 'completed' })[label])) {
        const row = await h.openJob(job.id)
        assert.equal(await row.getByText('标准额度不足', { exact: true }).count(), 0)
      }
    }
  }
  await filters.getByRole('button', { name: /^全部\s*16$/ }).click()
  const blockers = h.panel.getByRole('group', { name: '阻塞原因筛选', exact: true })
  const quota = blockers.getByRole('button', { name: /^标准额度不足\s*2$/ })
  await quota.click()
  assert.equal(await rows.count(), 2)
  assert.equal(await rows.locator('.production-status').getByText('排队中', { exact: true }).count(), 0)
  await rows.first().getByText('标准额度不足，等待恢复', { exact: true }).waitFor()
  await h.openJob(1)
  await h.jobDetail.getByText('标准额度不足', { exact: true }).waitFor()
  await h.jobDetail.getByText('尚未进入平台队列，待额度恢复后继续标准模式。', { exact: true }).waitFor()
  await quota.click()
  const attention = blockers.getByRole('button', { name: /^需要处理\s*3$/ })
  await attention.click()
  assert.equal(await rows.count(), 3)
  await attention.click()
  const search = h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true })
  await search.fill('生产稿件 16')
  assert.equal(await rows.count(), 1)
  await h.openJob(16)
  const sourceLink = h.jobDetail.getByRole('link', { name: '生产稿件 16', exact: true })
  const url = new URL(await sourceLink.getAttribute('href'), baseUrl)
  assert.equal(url.searchParams.get('script'), '116')
  assert.equal(url.searchParams.get('view'), null)
  await search.fill('#109')
  assert.equal(await rows.count(), 1)
  await rows.getByText('生产稿件 9', { exact: true }).waitFor()
  await search.fill('does-not-exist')
  await h.panel.getByText('没有匹配的制作任务', { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '清除筛选', exact: true }).click()
  assert.equal(await rows.count(), 16)
  assert.equal(await search.inputValue(), '')
  await h.openJob(1)
  await h.jobDetail.getByRole('link', { name: '生产稿件 1', exact: true }).click()
  await h.page.waitForURL(url => url.searchParams.get('view') !== 'production' && url.searchParams.get('script') === '101')
  assert.equal(await h.page.getByRole('tab', { name: /^稿件库(?:\s|$)/ }).getAttribute('aria-selected'), 'true')
  assert.equal(await h.page.getByRole('tab', { name: '文稿', exact: true }).getAttribute('aria-selected'), 'true')
  await h.openProduction()
  const sourceRow = await h.openJob(1)
  await sourceRow.getByRole('button', { name: '查看稿件与产物', exact: true }).click()
  await h.page.getByRole('tabpanel', { name: '成片与封面', exact: true }).waitFor()
  assert.equal(await h.page.getByRole('tab', { name: '成片与封面', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(h.writes.length, 0)
})

test('Huasheng project search normalizes full links and matches exact project IDs and manuscript links', async t => {
  const projectId = '270814616445042'
  const videoProjectId = '270802150977842'
  const h = await harness(t, { state: { jobs: [
    completedJob({ title: '链接对应稿件', projectUrl: `https://www.huasheng.cn/video/${projectId}` }),
    completedJob({ id: 2, sourceId: 102, title: '视频入口稿件', projectUrl: null, videoUrl: `https://www.huasheng.cn/video/${videoProjectId}/?from=library` }),
    completedJob({ id: 3, sourceId: 103, title: '相邻项目', projectUrl: `https://www.huasheng.cn/video/${projectId}0` }),
    completedJob({ id: 4, sourceId: 104, title: '外部视频', projectUrl: null, videoUrl: `https://cdn.example.com/video/${projectId}` }),
  ] } })
  await h.openProduction()
  const search = h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true })
  const rows = h.taskList.locator('.task-item')
  for (const query of [projectId, `#${projectId}`, ` https://www.huasheng.cn/video/${projectId} `, `https://huasheng.cn/video/${projectId}/?from=share#preview`]) {
    await search.fill(query)
    await h.taskList.getByRole('button', { name: '查看任务 #1 详情', exact: true }).waitFor()
    assert.equal(await rows.count(), 1)
    const link = h.jobDetail.getByRole('link', { name: '链接对应稿件', exact: true })
    assert.equal(new URL(await link.getAttribute('href'), baseUrl).searchParams.get('script'), '101')
  }
  await search.fill(videoProjectId)
  await h.taskList.getByRole('button', { name: '查看任务 #2 详情', exact: true }).waitFor()
  assert.equal(await rows.count(), 1)
  await search.fill('https://www.huasheng.cn/video/999999999999999')
  await h.panel.getByText('没有匹配的制作任务', { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '清除搜索', exact: true }).click()
  assert.equal(await rows.count(), 4)
  assert.deepEqual(h.writes, [])
})

for (const query of ['https://www.huasheng.cn/video/270814616445042?from=share', '270814616445042']) {
  test(`Huasheng project search finds older manuscripts across unloaded pages: ${query}`, async t => {
    const jobs = Array.from({ length: 103 }, (_, index) => jobFixture({ id: 200 - index, sourceId: 400 - index, title: `分页稿件 ${index}` }))
    Object.assign(jobs.at(-1), { title: '较早的目标稿件', projectUrl: 'https://www.huasheng.cn/video/270814616445042' })
    const h = await harness(t, { paginated: true, state: { jobs } })
    await h.openProduction()
    await h.panel.getByText('已加载 50 / 103 项任务', { exact: true }).waitFor()
    const search = h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true })
    await search.fill(query)
    await h.taskList.getByRole('button', { name: '查看任务 #98 详情', exact: true }).waitFor()
    await h.panel.getByText('已加载 103 / 103 项任务', { exact: true }).waitFor()
    assert.equal(await h.taskList.locator('.task-item').count(), 1)
    const link = h.jobDetail.getByRole('link', { name: '较早的目标稿件', exact: true })
    assert.equal(new URL(await link.getAttribute('href'), baseUrl).searchParams.get('script'), '298')
    await search.fill('999999999999999')
    await h.panel.getByText('没有匹配的制作任务', { exact: true }).waitFor()
    await h.panel.getByRole('button', { name: '清除搜索', exact: true }).click()
    assert.equal(await h.taskList.locator('.task-item').count(), 103)
    assert.deepEqual(h.writes, [])
  })
}

test('Huasheng project search stops after a page error and resumes after refresh', async t => {
  const jobs = Array.from({ length: 53 }, (_, index) => jobFixture({ id: 200 - index, sourceId: 400 - index }))
  Object.assign(jobs.at(-1), { projectUrl: 'https://www.huasheng.cn/video/270814616445042' })
  const h = await harness(t, { clock: true, paginated: true, state: { jobs } })
  await h.openProduction()
  await h.panel.getByText('已加载 50 / 53 项任务', { exact: true }).waitFor()
  h.controls.failGet = true
  await h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true }).fill('270814616445042')
  await h.page.clock.runFor(300)
  await h.panel.getByRole('alert').filter({ hasText: '花生服务连接失败' }).waitFor()
  const readsAfterError = h.reads.length
  await h.page.clock.runFor(1000)
  assert.equal(h.reads.length, readsAfterError)
  h.controls.failGet = false
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.panel.getByText('已加载 50 / 53 项任务', { exact: true }).waitFor()
  await h.page.clock.runFor(300)
  await h.taskList.getByRole('button', { name: '查看任务 #148 详情', exact: true }).waitFor()
  assert.deepEqual(h.writes, [])
})

test('task focus stays independent of bulk selection across detail clicks, polling and filtered fallback', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [
    jobFixture({ id: 1, title: '其他等待项目' }),
    completedJob({ id: 2, sourceId: 102, title: '目标已完成项目' }),
    jobFixture({ id: 3, sourceId: 103, title: '目标创作项目', status: 'submitted', productionStatus: 'creating', projectUrl: 'https://www.huasheng.cn/video/303' }),
  ] } })
  await h.openProduction()
  const focus = id => h.taskList.getByRole('button', { name: `查看任务 #${id} 详情`, exact: true })
  const selected = h.taskList.getByRole('checkbox', { name: '选择任务 #2 项目', exact: true })
  await h.jobDetail.getByRole('link', { name: '其他等待项目', exact: true }).waitFor()
  assert.equal(await focus(1).getAttribute('aria-current'), 'true', 'The first visible task is focused by default')
  await selected.check()
  assert.equal(await focus(1).getAttribute('aria-current'), 'true', 'Bulk selection must not change task focus')
  await h.openJob(3)
  assert.equal(await h.jobDetail.count(), 1)
  assert.equal(await focus(3).getAttribute('aria-current'), 'true')
  assert.equal(await selected.isChecked(), true)
  assert.equal(await h.taskList.getByRole('checkbox', { name: '选择任务 #3 项目', exact: true }).isChecked(), false)
  assert.equal(await h.taskList.locator('input:checked').count(), 1, 'Opening details must preserve the exact bulk selection')

  h.state.jobs[2].productionMessage = '轮询已更新当前项目进展'
  h.state.jobs.unshift(jobFixture({ id: 4, sourceId: 104, title: '最新进入队列的项目', createdAt: '2026-10-24T00:00:00.000Z' }))
  await h.page.clock.fastForward(6000)
  await h.jobDetail.getByText('轮询已更新当前项目进展', { exact: true }).waitFor()
  assert.equal(await h.taskList.locator('.task-item').count(), 4)
  assert.equal(await focus(3).getAttribute('aria-current'), 'true', 'Polling must retain focus even when a new task becomes the first item')
  assert.equal(await selected.isChecked(), true)
  assert.equal(await h.taskList.locator('input:checked').count(), 1)

  const search = h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true })
  await search.fill('目标')
  assert.equal(await h.taskList.locator('.task-item').count(), 2)
  assert.equal(await focus(3).getAttribute('aria-current'), 'true', 'A filter retaining the focused task must keep its details')
  await h.panel.getByRole('button', { name: /^素材就绪\s*1$/ }).click()
  await h.jobDetail.getByRole('link', { name: '目标已完成项目', exact: true }).waitFor()
  assert.equal(await focus(2).getAttribute('aria-current'), 'true', 'Filtering out the focused task must focus the first remaining item')
  assert.equal(await selected.isChecked(), true)
  await h.panel.getByRole('button', { name: /^全部\s*4$/ }).click()
  await search.fill('')
  assert.equal(await focus(2).getAttribute('aria-current'), 'true', 'Clearing filters must preserve a still-visible focus')
  await search.fill('没有匹配的任务')
  assert.equal(await h.taskList.count(), 0)
  assert.equal(await h.jobDetail.count(), 0, 'An empty filter must not leave stale task details')
  await h.panel.getByRole('button', { name: '清除筛选', exact: true }).click()
  await h.jobDetail.getByRole('link', { name: '最新进入队列的项目', exact: true }).waitFor()
  assert.equal(await focus(4).getAttribute('aria-current'), 'true')
  assert.equal(await h.taskList.locator('input:checked').count(), 0, 'Selections hidden by the empty filter remain cleared')
  assert.deepEqual(h.writes, [])
})

test('checking the current project posts only its job ID regardless of empty or unrelated bulk selections', async t => {
  const h = await harness(t, { state: { jobs: [1, 2, 3].map(id => completedJob({
    id, sourceId: 100 + id, title: `项目检查 ${id}`, projectUrl: `https://www.huasheng.cn/video/${100 + id}`,
  })) } })
  h.controls.productionCheckingResult = false
  await h.openProduction()
  await h.openJob(2)
  const inspect = h.jobDetail.getByRole('button', { name: '检查当前项目状态', exact: true })
  const checkCurrent = async () => {
    await inspect.click()
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  }
  assert.equal(await h.taskList.locator('input:checked').count(), 0)
  await checkCurrent()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [2] } }])
  for (const id of [1, 3]) await h.taskList.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).check()
  await checkCurrent()
  await h.openJob(3)
  await checkCurrent()
  assert.deepEqual(h.writes, [2, 2, 3].map(id => ({ path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [id] } })))
  assert.equal(await h.taskList.locator('input:checked').count(), 2)
  for (const id of [1, 3]) assert.equal(await h.taskList.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).isChecked(), true)
  assert.equal(await h.taskList.getByRole('checkbox', { name: '选择任务 #2 项目', exact: true }).isChecked(), false)
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('view changes preserve recovery drafts, queue filters, unsaved scripts and hidden polling', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture({ status: 'needs_attention', checkpoint: 'create_pending' })] } })
  await h.detail.getByText('绑定已有花生项目', { exact: true }).click()
  const sourceRecovery = h.detail.getByRole('textbox', { name: '已有花生项目链接', exact: true })
  await sourceRecovery.fill('https://www.huasheng.cn/video/987654')
  await h.openProduction({ settings: true })
  await h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true }).fill('101')
  await h.openJob(1)
  await h.openProduction({ settings: true })
  await h.panel.getByText('绑定已有花生项目', { exact: true }).click()
  const globalRecovery = h.panel.getByRole('textbox', { name: '已有花生项目链接', exact: true })
  await globalRecovery.fill('https://www.huasheng.cn/video/123456')
  await h.openManuscript()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('切换制作视图后必须保留的未保存稿。')
  const initial = h.reads.length
  await h.page.clock.fastForward(6000)
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  assert.equal(h.reads.length, initial + 2)
  await h.openProduction()
  assert.equal(await globalRecovery.inputValue(), 'https://www.huasheng.cn/video/123456')
  assert.equal(await h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true }).inputValue(), '101')
  assert.equal(await h.panel.getByRole('button', { name: '制作设置', exact: true }).getAttribute('aria-expanded'), 'true')
  assert.equal(await h.panel.getByRole('button', { name: '绑定并恢复', exact: true }).isEnabled(), false)
  await h.openDetail()
  assert.equal(await sourceRecovery.inputValue(), 'https://www.huasheng.cn/video/987654')
  assert.equal(await h.detail.getByRole('button', { name: '绑定并恢复', exact: true }).isEnabled(), false)
  await h.openManuscript()
  assert.equal(await h.page.getByRole('textbox', { name: '编辑待审稿' }).inputValue(), '切换制作视图后必须保留的未保存稿。')
  assert.equal(h.writes.length, 0)
})

test('production status distinguishes local submission from platform queue and shows checked evidence', async t => {
  const h = await harness(t, { state: { jobs: [
    jobFixture({ title: '尚未提交的稿件' }),
    jobFixture({ id: 2, title: '平台排队的稿件', status: 'submitted', projectUrl: 'https://www.huasheng.cn/video/123', productionStatus: 'queued', productionCheckedAt: '2026-10-22T01:00:00.000Z', productionMessage: '花生制作队列等待中' }),
    jobFixture({ id: 3, title: '编辑中的稿件', status: 'submitted', productionStatus: 'creating', videoUrl: 'https://www.huasheng.cn/video/123', productionMessage: '下载成片暂不可用' }),
    jobFixture({ id: 4, title: '可导出的稿件', status: 'submitted', projectUrl: 'https://www.huasheng.cn/video/456', productionStatus: 'completed', productionCheckedAt: '2026-10-22T02:00:00.000Z', productionMessage: '下载成片按钮已启用', message: '下载成片按钮已启用' }),
  ] } })
  await h.openProduction()
  const local = await h.openJob(1)
  await local.getByText('创作状态：未开始', { exact: true }).waitFor()
  await local.locator('.job-status').getByText('等待提交花生', { exact: true }).waitFor()
  await local.getByText('尚未检查', { exact: true }).waitFor()
  const queued = await h.openJob(2)
  await queued.getByText('创作状态：排队中', { exact: true }).waitFor()
  assert.equal(await queued.locator('time').getAttribute('datetime'), '2026-10-22T01:00:00.000Z')
  assert.equal(await queued.getByRole('button', { name: '打开花生项目', exact: true }).innerText(), '项目')
  const creating = await h.openJob(3)
  await creating.getByText('创作状态：创作中', { exact: true }).waitFor()
  assert.equal(await creating.getByText('创作状态：素材就绪', { exact: true }).count(), 0)
  const completed = await h.openJob(4)
  await completed.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  await completed.getByText('下载成片按钮已启用', { exact: true }).waitFor()
  assert.equal(await completed.getByText('下载成片按钮已启用', { exact: true }).count(), 1)
  const download = completed.getByRole('button', { name: '下载视频，打开花生项目', exact: true })
  assert.equal(await download.innerText(), '下载')
  assert.equal(await download.getAttribute('type'), 'button')
  assert.equal(await download.getAttribute('href'), null, 'the backend opens the project in its original managed account')
  await completed.getByRole('button', { name: '查看稿件与产物', exact: true }).click()
  await h.page.getByRole('tabpanel', { name: '成片与封面', exact: true }).waitFor()
  assert.equal(await h.page.getByRole('tab', { name: '成片与封面', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(h.writes.length, 0)
})

test('canonical successful inspections show one message and omit only the redundant completed submission label', async t => {
  const jobs = ['completed', 'creating', 'queued'].map((productionStatus, index) => jobFixture({
    id: index + 9, sourceId: 101 + index, title: `已核验项目 ${index + 9}`,
    status: 'submitted', stage: 'submitted', checkpoint: 'submitted', productionStatus,
    projectUrl: `https://www.huasheng.cn/video/${123 + index}`,
    productionCheckedAt: '2026-10-23T01:00:00.000Z', updatedAt: '2026-10-23T01:00:00.000Z',
    productionMessage: `最新检查：${productionStatus}`, message: `最新检查：${productionStatus}`,
  }))
  const h = await harness(t, { state: { jobs } })
  await h.detail.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  assert.equal(await h.detail.locator('.job-status').count(), 0)
  await h.detail.getByText('当前已保存稿：等待导出', { exact: true }).waitFor()
  await h.openProduction()
  for (const job of jobs) {
    const row = await h.openJob(job.id)
    assert.equal(await row.getByText(job.productionMessage, { exact: true }).count(), 1)
    assert.equal(await row.locator('.job-status').count(), job.productionStatus === 'completed' ? 0 : 1)
    assert.equal(await row.getByRole('button', { name: '恢复', exact: true }).count(), 0)
    assert.equal(await row.locator('.quota-badge, .error').count(), 0)
  }
  await h.panel.getByRole('button', { name: /^需要处理\s*0$/ }).waitFor()
  await h.panel.getByRole('button', { name: /^标准额度不足\s*0$/ }).waitFor()
  await h.panel.getByRole('checkbox', { name: '选择任务 #10 项目', exact: true }).check()
  await h.panel.getByRole('button', { name: '检查选中项目状态（1）', exact: true }).click()
  await h.panel.getByRole('button', { name: '同步花生状态中…', exact: true }).waitFor()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [10] } }])
  assert.equal(h.state.monitoring.enabled, false)
})

test('completed production preserves newer errors, messages and running or canceled intent without duplicate messages', async t => {
  const latestError = '最新操作失败，请核对原项目'
  const jobs = [
    completedJob({ id: 1, message: '最新任务说明：请检查已下载文件' }),
    completedJob({ id: 2, status: 'needs_attention', error: latestError, message: latestError }),
    completedJob({ id: 3, status: 'running', cancelRequested: true, message: '正在停止自动操作' }),
    completedJob({ id: 4, status: 'canceled', message: '用户已取消任务' }),
  ].map(job => ({ ...job, title: `任务状态 ${job.id}`, productionMessage: '上次检查可下载成片',
    productionCheckedAt: '2026-10-23T01:00:00.000Z', updatedAt: '2026-10-23T02:00:00.000Z' }))
  const h = await harness(t, { state: { jobs } })
  await h.openProduction()
  for (const job of jobs) {
    const row = await h.openJob(job.id)
    assert.equal(await row.getByText(job.message, { exact: true }).count(), 1)
    await row.getByText(job.productionMessage, { exact: true }).waitFor()
  }
  const attention = await h.openJob(2)
  await attention.getByText('需要处理', { exact: true }).waitFor()
  assert.equal(await attention.getByRole('button', { name: '恢复', exact: true }).isEnabled(), true)
  const running = await h.openJob(3)
  await running.locator('.job-status').getByText('自动操作中', { exact: true }).waitFor()
  assert.equal(await running.getByRole('button', { name: '恢复', exact: true }).count(), 0)
  await running.getByRole('button', { name: '任务 #3 的更多操作', exact: true }).click()
  assert.equal(await running.getByRole('button', { name: '正在停止…', exact: true }).isEnabled(), false)
  const canceled = await h.openJob(4)
  await canceled.locator('.job-status').getByText('已取消', { exact: true }).waitFor()
  assert.equal(await canceled.getByRole('button', { name: '恢复', exact: true }).isEnabled(), true)
  assert.equal(h.writes.length, 0)
})

test('quota records deduplicate messages and keep inspection failures visible for selected retry', async t => {
  const quotaError = '花生返回 10008：标准模式每日额度已用完'
  const h = await harness(t, { state: { jobs: [jobFixture({
    status: 'needs_attention', checkpoint: 'quota_waiting', projectUrl: 'https://www.huasheng.cn/video/123',
    message: quotaError, error: quotaError, productionMessage: quotaError,
    productionCheckError: '花生登录已失效，请重新登录',
  })] } })
  await h.openProduction()
  const row = await h.openJob(1)
  assert.equal(await row.getByRole('alert').isVisible(), true)
  assert.equal(await row.getByText(quotaError, { exact: true }).count(), 1)
  assert.equal(await row.getByText(quotaError, { exact: true }).isVisible(), false)
  await row.getByText('查看状态记录', { exact: true }).click()
  await row.getByText(quotaError, { exact: true }).waitFor()
  await h.panel.getByRole('checkbox', { name: '选择任务 #1 项目', exact: true }).check()
  await h.panel.getByRole('button', { name: '检查选中项目状态（1）', exact: true }).click()
  await h.panel.getByRole('button', { name: '同步花生状态中…', exact: true }).waitFor()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [1] } }])
  assert.equal(h.state.monitoring.enabled, false)
})

test('batch production checks run asynchronously, prevent repeat checks and poll results without submitting jobs', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture({ status: 'submitted', projectUrl: 'https://www.huasheng.cn/video/123', productionStatus: 'creating' })] } })
  await h.openProduction()
  await h.panel.getByRole('button', { name: '同步花生状态', exact: true }).click()
  const checking = h.panel.getByRole('button', { name: '同步花生状态中…', exact: true })
  await checking.waitFor()
  assert.equal(await checking.isEnabled(), false)
  await h.openJob(1)
  await h.jobDetail.getByText('创作状态：创作中', { exact: true }).waitFor()
  await h.page.clock.fastForward(6000)
  await h.openDetail()
  assert.equal(await h.detail.getByRole('button', { name: '同步花生状态中…', exact: true }).isEnabled(), false)
  h.state.productionChecking = false
  Object.assign(h.state.jobs[0], { productionStatus: 'completed', productionCheckedAt: '2026-10-22T03:04:05.000Z', productionMessage: '下载成片按钮已启用' })
  await h.page.clock.fastForward(6000)
  await h.openProduction()
  await h.openJob(1)
  await h.jobDetail.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('button', { name: '同步花生状态', exact: true }).isEnabled(), true)
  assert.equal(await h.jobDetail.locator('time').getAttribute('datetime'), '2026-10-22T03:04:05.000Z')
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: {} }])
})

test('selected production checks accept unfinished and exported projects and send exact numeric job IDs without unselected versions', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [
    jobFixture({ id: '41', title: '旧版排队项目', productionStatus: 'queued', projectUrl: 'https://huasheng.cn/video/410/' }),
    completedJob({ id: 42, title: '未选中的同稿新版', createdAt: '2026-10-22T02:00:00.000Z', projectUrl: 'https://www.huasheng.cn/video/420' }),
    jobFixture({ id: 43, sourceId: 102, title: '正在创作的项目', productionStatus: 'creating', projectUrl: 'https://www.huasheng.cn/video/430' }),
    completedJob({ id: 44, sourceId: 103, title: '已导出的项目', projectUrl: 'https://www.huasheng.cn/video/440' }),
    ...[null, 'javascript:alert(1)', 'https://example.com/video/123', 'https://www.huasheng.cn/', 'https://www.huasheng.cn/video/no-id', 'http://www.huasheng.cn/video/123', 'https://user@www.huasheng.cn/video/123', 'https://www.huasheng.cn:444/video/123'].map((projectUrl, index) => jobFixture({ id: 50 + index, sourceId: 150 + index, projectUrl })),
  ] }, exports: { jobs: [exportFixture({ huashengJobId: 44, sourceId: 103, status: 'completed' })] } })
  await h.openProduction()
  const selected = h.panel.getByRole('button', { name: /^检查选中项目状态/ })
  await selected.waitFor()
  assert.equal(await selected.isEnabled(), false)
  assert.equal(await h.taskList.locator('.task-item input[type="checkbox"]').count(), 12, 'Every valid task is selectable, including tasks without a valid Huasheng project link')
  for (const id of [41, 43, 44]) await h.panel.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).check()
  await h.panel.getByRole('button', { name: '检查选中项目状态（3）', exact: true }).click()
  await h.panel.getByText('正在检查创作状态，显示上次检查结果。', { exact: true }).waitFor()
  assert.equal(await selected.isEnabled(), false)
  assert.equal(await h.panel.getByRole('button', { name: '同步花生状态中…', exact: true }).isEnabled(), false)
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #42 项目', exact: true }).isChecked(), false)
  h.state.productionChecking = false
  Object.assign(h.state.jobs[0], { productionStatus: 'completed', productionMessage: '选中旧版项目检查完成', productionCheckedAt: '2026-10-23T03:00:00.000Z' })
  await h.page.clock.fastForward(6000)
  await h.openJob(41)
  await h.jobDetail.getByText('选中旧版项目检查完成', { exact: true }).waitFor()
  assert.equal(await selected.isEnabled(), true)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [41, 43, 44] } }])
  assert.deepEqual(h.state.monitoring, monitoringFixture())
  assert.equal(await h.panel.getByRole('checkbox', { name: '循环监测', exact: true }).isChecked(), false)
})

test('shared bulk selection follows search and status filters, clears hidden selections and never checks an empty selection', async t => {
  const h = await harness(t, { state: { jobs: [
    jobFixture({ id: 61, title: '目标排队项目', productionStatus: 'queued', projectUrl: 'https://www.huasheng.cn/video/610' }),
    jobFixture({ id: 62, sourceId: 102, title: '目标创作项目', productionStatus: 'creating', projectUrl: 'https://www.huasheng.cn/video/620' }),
    completedJob({ id: 63, sourceId: 103, title: '其它已完成项目' }),
    jobFixture({ id: 64, sourceId: 104, title: '目标未绑定项目' }),
  ] } })
  await h.openProduction()
  const bulk = h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true })
  const selected = h.panel.getByRole('button', { name: /^检查选中项目状态/ })
  const search = h.panel.getByRole('searchbox', { name: '搜索制作任务' })
  await bulk.check()
  await h.panel.getByText(selectionSummary(4, 1, 3, 1), { exact: true }).waitFor()
  await bulk.uncheck()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  await bulk.check()
  await h.panel.getByRole('button', { name: /^创作中\s*1$/ }).click()
  await h.panel.getByText(selectionSummary(1, 0, 1, 0), { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: /^全部\s*4$/ }).click()
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #61 项目', exact: true }).isChecked(), false)
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #63 项目', exact: true }).isChecked(), false)
  assert.equal(await bulk.evaluate(input => input.indeterminate), true)
  await search.fill('排队')
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  assert.equal(await selected.isEnabled(), false)
  await selected.evaluate(button => button.click())
  assert.deepEqual(h.writes, [], 'An empty selection must not fall back to a global check')
  await search.fill('没有匹配的任务')
  assert.equal(await bulk.isEnabled(), false)
  assert.equal(await selected.isEnabled(), false)
  await search.fill('目标')
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #62 项目', exact: true }).isChecked(), false)
  await bulk.check()
  await h.panel.getByText(selectionSummary(3, 1, 2, 0), { exact: true }).waitFor()
  assert.equal(await bulk.isChecked(), true)
  assert.equal(await bulk.evaluate(input => input.indeterminate), false)
  assert.match(await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).getAttribute('class'), /primary/)
  assert.doesNotMatch(await h.panel.getByRole('button', { name: '同步花生状态', exact: true }).getAttribute('class'), /primary/)
  h.controls.productionCheckingResult = false
  await selected.click()
  await h.page.waitForFunction(() => [...document.querySelectorAll('.export-batch button')].some(button => button.textContent.includes('检查选中项目状态') && !button.disabled))
  assert.equal(await h.panel.getByText('正在检查创作状态，显示上次检查结果。', { exact: true }).count(), 0)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [61, 62] } }])
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('selected checks remain independent of export reads and retain exact IDs for a manual retry after failure', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [
    jobFixture({ id: 71, productionStatus: 'creating', projectUrl: 'https://www.huasheng.cn/video/710', productionCheckedAt: '2026-10-23T01:00:00.000Z' }),
    completedJob({ id: 72, sourceId: 102 }),
  ] } })
  await h.openProduction()
  h.controls.failExportGet = true
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '自动导出状态暂不可用' }).waitFor()
  const checkbox = h.panel.getByRole('checkbox', { name: '选择任务 #71 项目', exact: true })
  await checkbox.check()
  const selected = h.panel.getByRole('button', { name: '检查选中项目状态（1）', exact: true })
  assert.equal(await h.panel.getByRole('button', { name: batchDownloadLabel, exact: true }).isEnabled(), false)
  h.controls.failProduction = true
  await selected.click()
  await h.panel.getByRole('alert').filter({ hasText: '创作状态检查暂不可用' }).waitFor()
  await h.page.clock.fastForward(6000)
  await h.openJob(71)
  await h.jobDetail.getByText('创作状态：创作中', { exact: true }).waitFor()
  assert.equal(await h.jobDetail.locator('time').getAttribute('datetime'), '2026-10-23T01:00:00.000Z')
  assert.equal(await checkbox.isChecked(), true)
  const expected = { path: `${root}/huasheng/check-production`, method: 'POST', body: { jobIds: [71] } }
  assert.deepEqual(h.writes, [expected], 'Polling must not retry a rejected check')
  h.controls.failProduction = false
  await selected.click()
  await h.panel.getByText('正在检查创作状态，显示上次检查结果。', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('alert').filter({ hasText: '创作状态检查暂不可用' }).count(), 0)
  assert.deepEqual(h.writes, [expected, expected])
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('all fifty loaded no-link queued tasks can be selected and produced without checking empty projects or backfilling scripts', async t => {
  const jobs = Array.from({ length: 50 }, (_, index) => jobFixture({ id: String(index + 1), sourceId: 201 + index, title: `等待提交的稿件 ${index + 1}` }))
  const h = await harness(t, { clock: true, state: { jobs } })
  await h.openProduction()
  const bulk = h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true })
  await bulk.check()
  await h.panel.getByText(selectionSummary(50, 50, 0, 0), { exact: true }).waitFor()
  assert.equal(await h.taskList.locator('.task-item input[type="checkbox"]:checked').count(), 50)
  const check = h.panel.getByRole('button', { name: '检查选中项目状态（0）', exact: true })
  assert.equal(await check.isEnabled(), false)
  await check.evaluate(button => button.click())
  assert.equal(await h.panel.getByRole('button', { name: batchDownloadLabel, exact: true }).isEnabled(), false)
  assert.deepEqual(h.writes, [], 'Selection must not submit scripts, check empty links or enable monitoring')
  const response = h.page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname === `${root}/huasheng/produce`)
  await h.panel.getByRole('button', { name: '批量制作两版（50）', exact: true }).click()
  assert.equal((await response).status(), 202)
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  const results = h.panel.getByRole('region', { name: '批量自动生产结果', exact: true })
  assert.equal(await results.getByRole('listitem').count(), 50)
  assert.equal(await results.getByText('已加入本次执行', { exact: true }).count(), 50)
  assert.ok(h.state.jobs.every(job => job.productionStatus === 'not_started' && job.projectUrl === null), 'A local acceptance must not pretend the remote Huasheng project is queued')
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: jobs.map(job => Number(job.id)) } }])
  assert.equal(h.state.jobs.length, 50)
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('filtered batch production excludes hidden, submitted, running and canceling tasks but can restore a canceled task', async t => {
  const h = await harness(t, { state: { jobs: [
    jobFixture({ id: 81, sourceId: 301, title: '目标等待任务' }),
    jobFixture({ id: 82, sourceId: 302, title: '目标失败任务', status: 'failed' }),
    jobFixture({ id: 83, sourceId: 303, title: '不匹配的任务' }),
    jobFixture({ id: 84, sourceId: 304, title: '目标运行任务', status: 'running' }),
    jobFixture({ id: 85, sourceId: 305, title: '目标已提交任务', status: 'submitted' }),
    jobFixture({ id: 86, sourceId: 306, title: '目标取消中任务', cancelRequested: true }),
    jobFixture({ id: 87, sourceId: 307, title: '目标已取消任务', status: 'canceled', cancelRequested: true }),
  ] } })
  await h.openProduction()
  const bulk = h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true })
  const search = h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true })
  await bulk.check()
  await h.panel.getByText(selectionSummary(7, 4, 0, 0), { exact: true }).waitFor()
  await search.fill('目标')
  await h.panel.getByText(selectionSummary(6, 3, 0, 0), { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: /^需要处理\s*1$/ }).click()
  await h.panel.getByText(selectionSummary(1, 1, 0, 0), { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  assert.deepEqual(h.writes.map(write => write.body), [{ jobIds: [82] }])
  await h.panel.getByRole('button', { name: /^需要处理\s*0$/ }).click()
  await search.fill('#307')
  await bulk.check()
  await h.panel.getByText(selectionSummary(1, 1, 0, 0), { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  assert.deepEqual(h.writes.map(write => write.body), [{ jobIds: [82] }, { jobIds: [87] }])
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('partial production results deselect accepted and skipped tasks and retry only selected failures', async t => {
  const h = await harness(t, { state: { jobs: [
    jobFixture({ id: 91, sourceId: 401, title: '可以继续的任务' }),
    jobFixture({ id: 92, sourceId: 402, title: '无需重复处理的任务' }),
    jobFixture({ id: 93, sourceId: 403, title: '暂时阻塞的任务' }),
    completedJob({ id: 94, sourceId: 404, title: '仅供检查的成片' }),
  ] } })
  await h.openProduction()
  h.controls.produceResults = [
    { jobId: 91, sourceId: 401, status: 'queued', message: '等待提交花生' },
    { jobId: 92, sourceId: 402, status: 'skipped', message: '已有执行记录，未重复安排' },
    { jobId: 93, sourceId: 403, status: 'blocked', message: '来源正在被其他任务处理，请稍后重试' },
  ]
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  await h.panel.getByRole('button', { name: '批量制作两版（3）', exact: true }).click()
  const result = h.panel.getByRole('region', { name: '批量自动生产结果', exact: true })
  await result.getByText('已接纳 1 · 已跳过 1 · 未提交 1 · 待核对 0', { exact: true }).waitFor()
  for (const [id, label] of [[91, '已加入本次执行'], [92, '已跳过'], [93, '未提交，需要处理']]) {
    await result.getByRole('listitem', { name: `任务 #${id} 自动生产结果`, exact: true }).getByText(label, { exact: true }).waitFor()
  }
  await h.panel.getByText(selectionSummary(2, 1, 1, 1), { exact: true }).waitFor()
  for (const id of [91, 92]) assert.equal(await h.panel.getByRole('checkbox', { name: `选择任务 #${id}，尚未绑定花生项目`, exact: true }).isChecked(), false)
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #93，尚未绑定花生项目', exact: true }).isChecked(), true)
  await h.panel.getByRole('button', { name: '只选失败任务（1）', exact: true }).click()
  await h.panel.getByText(selectionSummary(1, 1, 0, 0), { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #94 项目', exact: true }).isChecked(), false)
  h.controls.produceResults = null
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  assert.deepEqual(h.writes, [
    { path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: [91, 92, 93] } },
    { path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: [93] } },
  ])
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('accepted batch tasks that later fail or need attention can be selected for retry without selecting unrelated failures', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [
    jobFixture({ id: 1011, sourceId: 501, title: '稍后执行失败' }),
    jobFixture({ id: 1012, sourceId: 502, title: '稍后需要处理' }),
    jobFixture({ id: 1013, sourceId: 503, title: '本次未选择的失败任务', status: 'failed' }),
  ] } })
  await h.openProduction()
  for (const id of [1011, 1012]) await h.panel.getByRole('checkbox', { name: `选择任务 #${id}，尚未绑定花生项目`, exact: true }).check()
  await h.panel.getByRole('button', { name: '批量制作两版（2）', exact: true }).click()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  Object.assign(h.state.jobs[0], { status: 'failed', error: '花生页面加载失败', message: '本次执行失败' })
  Object.assign(h.state.jobs[1], { status: 'needs_attention', error: '登录会话需要处理', message: '本次执行需要处理' })
  await h.page.clock.fastForward(6000)
  await h.panel.getByRole('button', { name: '只选失败任务（2）', exact: true }).click()
  await h.panel.getByText(selectionSummary(2, 2, 0, 0), { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #1013，尚未绑定花生项目', exact: true }).isChecked(), false)
  await h.panel.getByRole('button', { name: '批量制作两版（2）', exact: true }).click()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  assert.deepEqual(h.writes.map(write => write.body), [{ jobIds: [1011, 1012] }, { jobIds: [1011, 1012] }])
})

test('batch production locks synchronous double clicks until the response and read-only reconciliation finish', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture()] } })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  h.controls.delayProduce = true
  const request = h.page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === `${root}/huasheng/produce`)
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).evaluate(button => { button.click(); button.click() })
  await request
  const submitting = h.panel.getByRole('button', { name: '正在提交视频制作…', exact: true })
  assert.equal(await submitting.isEnabled(), false)
  assert.equal(await h.panel.getByRole('button', { name: '刷新状态', exact: true }).isEnabled(), false)
  assert.equal(h.controls.producePending.length, 1)
  assert.equal(h.writes.length, 1)
  h.controls.delayGet = true
  const reconcile = h.page.waitForRequest(req => req.method() === 'GET' && new URL(req.url()).pathname === `${root}/huasheng`)
  h.controls.delayProduce = false
  h.controls.producePending.splice(0).forEach(release => release())
  await reconcile
  assert.equal(await submitting.isEnabled(), false)
  h.controls.delayGet = false
  await Promise.all(h.controls.pending.splice(0).map(release => release()))
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  await h.page.clock.fastForward(6000)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: [1] } }])
})

test('a rejected batch request retains failed selection and restores its action for an explicit retry', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture()] } })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  h.controls.rejectProduce = true
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '任务正在被其他操作处理' }).waitFor()
  await h.page.waitForFunction(() => [...document.querySelectorAll('.export-batch button')].some(button => button.textContent.includes('批量制作两版（1）') && !button.disabled))
  await h.panel.getByText(selectionSummary(1, 1, 0, 0), { exact: true }).waitFor()
  await h.page.clock.fastForward(6000)
  assert.equal(h.writes.length, 1)
  h.controls.rejectProduce = false
  await h.panel.getByRole('button', { name: '只选失败任务（1）', exact: true }).click()
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  assert.equal(h.writes.length, 2)
})

test('a hanging batch request releases controls after its deadline and ignores late acceptance without resending', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture()] } })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  h.controls.delayProduce = true
  const request = h.page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === `${root}/huasheng/produce`)
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await request
  assert.equal(h.controls.producePending.length, 1)
  Object.assign(h.state.jobs[0], { status: 'running', stage: 'created', projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.page.clock.fastForward(30001)
  await h.panel.getByRole('alert').filter({ hasText: '自动生产请求超时，提交结果待核对' }).waitFor()
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  await h.openJob(1)
  await h.jobDetail.locator('.job-status').getByText('自动操作中', { exact: true }).waitFor()
  const results = h.panel.getByRole('region', { name: '批量自动生产结果', exact: true })
  await results.getByText('结果待核对', { exact: true }).waitFor()
  const lateResponse = h.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${root}/huasheng/produce`)
  h.controls.delayProduce = false
  h.controls.producePending.splice(0).forEach(release => release())
  await lateResponse
  await h.page.clock.runFor(50)
  assert.equal(await results.getByText('结果待核对', { exact: true }).count(), 1)
  assert.equal(await results.getByText('已加入本次执行', { exact: true }).count(), 0)
  await h.page.clock.fastForward(6000)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: [1] } }])
})

test('hanging queue and export reads abort their fetches, release the batch lock and cannot overwrite a successful refresh', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture()] } })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  const failedReads = []
  h.page.on('requestfailed', request => failedReads.push(request))
  h.controls.delayGet = true
  h.controls.delayExportGet = true
  const queueRead = h.page.waitForRequest(req => req.method() === 'GET' && new URL(req.url()).pathname === `${root}/huasheng`)
  const exportRead = h.page.waitForRequest(req => req.method() === 'GET' && new URL(req.url()).pathname === `${root}/huasheng/exports` && !new URL(req.url()).search)
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  const [queueRequest, exportRequest] = await Promise.all([queueRead, exportRead])
  await h.page.clock.fastForward(15001)
  await h.panel.getByRole('alert').filter({ hasText: '花生状态读取超时' }).waitFor()
  await h.panel.getByRole('alert').filter({ hasText: '自动导出状态读取超时' }).waitFor()
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  assert.ok(failedReads.includes(queueRequest), 'The timed-out queue fetch must be canceled before the next refresh')
  assert.ok(failedReads.includes(exportRequest), 'The timed-out export fetch must be canceled before the next refresh')
  assert.match(queueRequest.failure().errorText, /ERR_ABORTED/)
  assert.match(exportRequest.failure().errorText, /ERR_ABORTED/)
  h.controls.delayGet = false
  h.controls.delayExportGet = false
  Object.assign(h.state.jobs[0], { status: 'running', stage: 'created', projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.openJob(1)
  await h.jobDetail.locator('.job-status').getByText('自动操作中', { exact: true }).waitFor()
  await Promise.all([...h.controls.pending.splice(0), ...h.controls.exportPending.splice(0)].map(release => release()))
  await h.page.clock.runFor(50)
  assert.equal(await h.jobDetail.locator('.job-status').getByText('自动操作中', { exact: true }).count(), 1)
  assert.equal(await h.panel.getByRole('button', { name: '刷新状态', exact: true }).isEnabled(), true)
  assert.equal(await h.panel.getByRole('alert').filter({ hasText: '读取超时' }).count(), 0)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: [1] } }])
})

test('a lost batch acceptance only refreshes local state and never resends on polling, view changes or reload', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture()] } })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  h.controls.loseProduce = true
  const readsBefore = h.reads.length
  await h.panel.getByRole('button', { name: '批量制作两版（1）', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '请求结果未确认' }).waitFor()
  const result = h.panel.getByRole('region', { name: '批量自动生产结果', exact: true })
  await result.getByText('结果待核对', { exact: true }).waitFor()
  await result.getByRole('button', { name: '刷新核对任务', exact: true }).click()
  assert.ok(h.reads.length > readsBefore)
  assert.equal(h.state.jobs[0].productionStatus, 'not_started')
  assert.equal(h.state.jobs[0].projectUrl, null)
  await h.page.clock.fastForward(16000)
  await h.openDetail()
  await h.openProduction()
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).waitFor()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/produce`, method: 'POST', body: { jobIds: [1] } }])
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('missing per-item acknowledgements remain unconfirmed while confirmed items are deselected', async t => {
  const h = await harness(t, { state: { jobs: [jobFixture(), jobFixture({ id: 2, sourceId: 102 })] } })
  await h.openProduction()
  h.controls.produceResults = [{ jobId: 1, sourceId: 101, status: 'queued', message: '等待提交' }]
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  await h.panel.getByRole('button', { name: '批量制作两版（2）', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '部分自动生产结果未确认' }).waitFor()
  await h.panel.getByText(selectionSummary(1, 1, 0, 0), { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #1，尚未绑定花生项目', exact: true }).isChecked(), false)
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #2，尚未绑定花生项目', exact: true }).isChecked(), true)
  const results = h.panel.getByRole('region', { name: '批量自动生产结果', exact: true })
  await results.getByRole('listitem', { name: '任务 #2 自动生产结果', exact: true }).getByText('结果待核对', { exact: true }).waitFor()
  assert.equal(h.writes.length, 1)
})

test('batch production never silently truncates selections beyond the one-hundred-task API limit', async t => {
  const h = await harness(t, { state: { jobs: Array.from({ length: 101 }, (_, index) => jobFixture({ id: index + 1, sourceId: 601 + index })) } })
  await h.openProduction()
  await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
  const produce = h.panel.getByRole('button', { name: '批量制作两版（101）', exact: true })
  assert.equal(await produce.isEnabled(), false)
  await produce.evaluate(button => button.click())
  await h.panel.getByRole('alert').filter({ hasText: '单次最多自动生产 100 项' }).waitFor()
  assert.deepEqual(h.writes, [])
})

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`batch production selection and partial results fit ${viewport.width}px and save a screenshot`, async t => {
    const h = await harness(t, { viewport, state: { jobs: [
      jobFixture({ id: 1, title: '刘裕为什么建立了一个皇帝更替频繁的王朝' }),
      jobFixture({ id: 2, sourceId: 102, title: '明朝皇帝继位背后的家族选择与制度变化', status: 'needs_attention' }),
      completedJob({ id: 3, sourceId: 103, title: '已经完成的历史讲解' }),
    ] } })
    await h.openProduction()
    await h.openBatch()
    await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
    h.controls.produceResults = [
      { jobId: 1, sourceId: 101, status: 'queued', message: '已加入本次执行，等待提交花生' },
      { jobId: 2, sourceId: 102, status: 'blocked', message: '花生登录会话暂不可用，请在连接页完成登录后重试当前任务' },
    ]
    await h.panel.getByRole('button', { name: '批量制作两版（2）', exact: true }).click()
    await h.panel.getByRole('button', { name: '只选失败任务（1）', exact: true }).waitFor()
    const dimensions = await h.panel.evaluate(element => {
      const workArea = element.querySelector(innerWidth <= 760 ? '.queue' : '.task-list')
      const batch = element.querySelector('.export-batch')
      return { scroll: element.scrollWidth, client: element.clientWidth, listHeight: workArea.clientHeight, batchScroll: batch.scrollWidth, batchClient: batch.clientWidth,
        pageScroll: document.documentElement.scrollWidth, pageClient: document.documentElement.clientWidth,
        pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight }
    })
    assert.ok(dimensions.scroll <= dimensions.client + 1 && dimensions.batchScroll <= dimensions.batchClient + 1 && dimensions.pageScroll <= dimensions.pageClient + 1, `Batch UI overflows horizontally: ${JSON.stringify(dimensions)}`)
    assert.ok((viewport.width <= 760 || dimensions.pageHeight <= dimensions.viewportHeight + 1) && dimensions.listHeight >= 240, `Batch UI obscures the task list: ${JSON.stringify(dimensions)}`)
    await h.page.screenshot({ path: join(tmpdir(), `history-huasheng-batch-${viewport.width}.png`), fullPage: false, animations: 'disabled' })
    assert.deepEqual(h.state.monitoring, monitoringFixture())
  })
}

test('source checks cover existing projects even with unsaved edits and use the overview checking flag when needed', async t => {
  const h = await harness(t, { clock: true, sourceCheckingFlag: false, state: { enabled: false, jobs: [
    jobFixture({ status: 'submitted', projectUrl: 'https://www.huasheng.cn/video/123', productionStatus: 'creating' }),
    jobFixture({ id: 2, status: 'submitted', scriptSha256: sha('旧稿'), projectUrl: 'https://www.huasheng.cn/video/456', productionStatus: 'queued' }),
  ] } })
  await h.openManuscript()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('当前未保存的修改，不应提交。')
  await h.openDetail()
  assert.equal(await h.detail.getByRole('button', { name: '继续生产', exact: true }).isEnabled(), false)
  await h.detail.getByRole('button', { name: '同步花生状态', exact: true }).click()
  const checking = h.detail.getByRole('button', { name: '同步花生状态中…', exact: true })
  await checking.waitFor()
  assert.equal(await checking.isEnabled(), false)
  h.state.productionChecking = false
  Object.assign(h.state.jobs[0], { productionStatus: 'completed', productionCheckedAt: '2026-10-22T03:00:00.000Z' })
  Object.assign(h.state.jobs[1], { productionStatus: 'creating', productionCheckedAt: '2026-10-22T03:00:00.000Z' })
  await h.page.clock.fastForward(6000)
  await h.detail.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  await h.detail.getByText('创作状态：创作中', { exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '同步花生状态', exact: true }).isEnabled(), true)
  assert.equal(h.source.rewrittenScript, sourceFixture().rewrittenScript)
  assert.deepEqual(h.writes, [{ path: `${root}/101/huasheng/check-production`, method: 'POST', body: {} }])
})

test('a failed project check preserves its previous status and checked time while reporting the failure', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture({ status: 'submitted', productionStatus: 'completed', productionCheckedAt: '2026-10-22T01:00:00.000Z', productionMessage: '上次检查可下载成片' })] } })
  await h.detail.getByRole('button', { name: '同步花生状态', exact: true }).click()
  await h.detail.getByRole('button', { name: '同步花生状态中…', exact: true }).waitFor()
  h.state.productionChecking = false
  h.state.jobs[0].productionCheckError = '花生登录已失效，请重新登录'
  await h.page.clock.fastForward(6000)
  await h.detail.getByRole('alert').filter({ hasText: '检查失败：花生登录已失效，请重新登录' }).waitFor()
  await h.detail.getByText('创作状态：素材就绪', { exact: true }).waitFor()
  await h.detail.getByText('上次检查可下载成片', { exact: true }).waitFor()
  assert.equal(await h.detail.locator('time').getAttribute('datetime'), '2026-10-22T01:00:00.000Z')
  assert.equal(await h.detail.getByRole('button', { name: '同步花生状态', exact: true }).isEnabled(), true)
})

test('source inspection has a visible label and connection failures can recover from the same detail panel', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture({
    projectUrl: 'https://www.huasheng.cn/video/123',
    productionCheckError: '花生专用浏览器未连接，请打开登录窗口',
  })] } })
  const check = h.detail.getByRole('button', { name: '同步花生状态', exact: true })
  assert.match(await check.innerText(), /同步花生状态/)
  await h.detail.getByRole('button', { name: '花生账号', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: '历史花生账号', exact: true })
  await dialog.getByRole('button', { name: '登录窗口', exact: true }).click()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭历史花生账号管理', exact: true }).click()
  h.controls.productionCheckingResult = false
  Object.assign(h.state.jobs[0], { status: 'submitted', productionStatus: 'completed',
    productionCheckError: null, productionCheckedAt: '2026-10-24T09:30:00.000Z', productionMessage: '花生成片可下载' })
  await check.click()
  await h.detail.getByText('花生成片可下载', { exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '花生账号', exact: true }).count(), 0)
  assert.deepEqual(h.writes, [
    { path: `${root}/huasheng/accounts/history_huasheng_legacy/login`, method: 'POST', body: {} },
    { path: `${root}/101/huasheng/check-production`, method: 'POST', body: {} },
  ])
  assert.equal(h.state.monitoring.enabled, false)
})

test('a rejected production check stays visible and keeps existing results available for manual retry', async t => {
  const h = await harness(t, { state: { jobs: [jobFixture({ status: 'submitted', productionStatus: 'creating' })] } })
  h.controls.failProduction = true
  await h.detail.getByRole('button', { name: '同步花生状态', exact: true }).click()
  await h.detail.getByRole('alert').filter({ hasText: '创作状态检查暂不可用' }).waitFor()
  await h.detail.getByText('创作状态：创作中', { exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '同步花生状态', exact: true }).isEnabled(), true)
  assert.deepEqual(h.writes, [{ path: `${root}/101/huasheng/check-production`, method: 'POST', body: {} }])
})

test('a lost production check response and a page reload reconcile a running check without resubmitting', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture({ status: 'submitted', productionStatus: 'creating' })] } })
  h.controls.loseProduction = true
  await h.openProduction()
  await h.panel.getByRole('button', { name: '同步花生状态', exact: true }).click()
  await h.panel.getByRole('alert').waitFor()
  await h.panel.getByRole('button', { name: '同步花生状态中…', exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('button', { name: '同步花生状态中…', exact: true }).isEnabled(), false)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openProduction()
  await h.panel.getByRole('button', { name: '同步花生状态中…', exact: true }).waitFor()
  await h.openDetail()
  await h.detail.getByRole('button', { name: '同步花生状态中…', exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '同步花生状态中…', exact: true }).isEnabled(), false)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/check-production`, method: 'POST', body: {} }])
})

test('ten completed projects with queued exports can continue only the selected original tasks while automatic processing is stopped', async t => {
  const jobs = Array.from({ length: 10 }, (_, index) => completedJob({ id: index + 1, sourceId: index + 101 }))
  const originalExports = jobs.map((job, index) => exportFixture({ id: index + 16, huashengJobId: job.id, sourceId: job.sourceId }))
  const h = await harness(t, { state: { jobs }, exports: { enabled: false, jobs: originalExports, worker: { status: 'stopped', message: '后台自动处理已停止' } } })
  await h.openProduction()
  await h.panel.getByRole('button', { name: '选择待下载项目（10）', exact: true }).click()
  await h.panel.getByText(selectionSummary(10, 0, 10, 10), { exact: true }).waitFor()
  const production = h.panel.getByRole('button', { name: '批量制作两版（0）', exact: true })
  assert.equal(await production.isEnabled(), false)
  assert.match(await production.getAttribute('title'), /素材就绪/)
  const worker = h.panel.getByRole('status', { name: '视频交付处理状态', exact: true })
  await worker.getByText('自动处理未运行', { exact: true }).waitFor()
  const download = h.panel.getByRole('button', { name: batchDownloadLabel, exact: true })
  assert.equal(await download.isEnabled(), true, 'Existing queued export jobs must remain actionable when the automatic worker is stopped')
  assert.equal(await h.taskList.locator('.task-item').count(), 10)
  for (const job of jobs) {
    const row = await h.openJob(job.id)
    assert.equal(await row.getByRole('button', { name: '下载并准备发布', exact: true }).count(), 1)
  }
  await download.click()
  await worker.getByText('自动处理运行中', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports`, method: 'POST', body: { sourceIds: jobs.map(job => job.sourceId) } }])
  assert.deepEqual(h.exports.jobs.map(job => job.id), originalExports.map(job => job.id))
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('pending download selection follows current filters and continues active tasks idempotently without enqueueing failed, uncertain or old versions', async t => {
  const statuses = ['queued', 'exporting', 'downloading', 'processing', 'waiting_login', 'failed', 'needs_attention', 'completed', 'needs_attention']
  const jobs = statuses.map((_, index) => completedJob({ id: index + 1, sourceId: index + 101, title: `目标项目${index + 1}` }))
  jobs.push(completedJob({ id: 10, sourceId: 110, title: '目标尚未下载' }),
    jobFixture({ id: 11, sourceId: 111, title: '目标仍在制作', productionStatus: 'creating' }),
    completedJob({ id: 12, sourceId: 112, title: '目标旧版', scriptSha256: 'old-version' }),
    jobFixture({ id: 13, sourceId: 112, title: '目标新版制作中', productionStatus: 'creating', createdAt: '2026-10-23T00:00:00.000Z' }),
    completedJob({ id: 14, sourceId: 114, title: '其他未选中项目' }))
  const originalExports = statuses.map((status, index) => exportFixture({ id: index + 16, huashengJobId: index + 1, sourceId: index + 101, status, stage: index === 8 ? 'export_uncertain' : 'exporting' }))
  const originalIds = originalExports.map(job => job.id)
  const h = await harness(t, { clock: true, state: { jobs }, exports: { jobs: originalExports, worker: { status: 'running', message: '后台自动处理正在运行' } } })
  await h.openProduction()
  await h.panel.getByRole('searchbox', { name: '搜索制作任务', exact: true }).fill('目标')
  await h.panel.getByRole('button', { name: /^素材就绪\s*12$/ }).click()
  await h.panel.getByRole('button', { name: '选择待下载项目（8）', exact: true }).click()
  await h.panel.getByText(selectionSummary(8, 0, 8, 6), { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('button', { name: '重试下载与发布准备（2）', exact: true }).isEnabled(), true)
  for (const id of [8, 9, 12]) assert.equal(await h.panel.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).isChecked(), false)
  const download = h.panel.getByRole('button', { name: '批量下载并准备发布（6）', exact: true })
  await download.click()
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  await download.click()
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  await h.page.clock.fastForward(6000)
  assert.deepEqual(h.writes, Array.from({ length: 2 }, () => ({ path: `${root}/huasheng/exports`, method: 'POST', body: { sourceIds: [101, 102, 103, 104, 105, 110] } })))
  assert.equal(h.exports.jobs.length, originalIds.length + 1)
  assert.deepEqual(h.exports.jobs.slice(0, originalIds.length).map(job => job.id), originalIds)
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('selected failed video delivery tasks retry their original IDs and partial failures stay available without retrying successful or unselected tasks', async t => {
  const videoUrl = '/static/history-deliveries/101/abc-123.mp4'
  const h = await harness(t, { clock: true, state: { jobs: [completedJob(), completedJob({ id: 2, sourceId: 102 }), completedJob({ id: 3, sourceId: 103 })] }, exports: { jobs: [
    exportFixture({ id: 16, status: 'failed', videoUrl, designStatus: 'completed', articleStatus: 'failed' }),
    exportFixture({ id: 17, huashengJobId: 2, sourceId: 102, status: 'needs_attention' }),
    exportFixture({ id: 18, huashengJobId: 3, sourceId: 103, status: 'failed' }),
  ] } })
  await h.openProduction()
  for (const id of [1, 2]) await h.panel.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).check()
  assert.equal(await h.panel.getByRole('button', { name: '批量下载并准备发布（0）', exact: true }).isEnabled(), false)
  assert.match(await h.panel.getByRole('button', { name: '批量下载并准备发布（0）', exact: true }).getAttribute('title'), /重试/)
  h.controls.failExportResumes = [17]
  await h.panel.getByRole('button', { name: '重试下载与发布准备（2）', exact: true }).click()
  await h.panel.getByRole('alert').filter({ hasText: '任务 #17：原任务暂时无法恢复' }).waitFor()
  const retry = h.panel.getByRole('button', { name: '重试下载与发布准备（1）', exact: true })
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  assert.equal(await retry.isEnabled(), true)
  assert.equal(h.exports.jobs[0].videoUrl, videoUrl)
  assert.equal(h.exports.jobs[0].designStatus, 'completed')
  assert.equal(h.exports.jobs[2].status, 'failed')
  await h.page.clock.fastForward(6000)
  assert.equal(h.writes.length, 2)
  h.controls.failExportResumes = []
  await retry.click()
  await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
  assert.deepEqual(h.writes.map(write => write.path), [`${root}/huasheng/exports/16/resume`, `${root}/huasheng/exports/17/resume`, `${root}/huasheng/exports/17/resume`])
  assert.ok(h.writes.every(write => write.method === 'POST' && Object.keys(write.body).length === 0))
})

for (const exportStatus of ['queued', 'failed']) {
  test(`${exportStatus} export continuation respects dirty scripts in both the source panel and production board`, async t => {
    const h = await harness(t, { state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: exportStatus })] } })
    await h.openManuscript()
    await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('尚未保存的新版本')
    await h.openDetail()
    assert.equal(await h.detail.getByRole('button', { name: /^(?:下载并准备发布|重试下载与发布准备)$/ }).count(), 0)
    await h.openProduction()
    await h.panel.getByRole('checkbox', { name: bulkSelectionLabel, exact: true }).check()
    assert.equal(await h.panel.getByRole('button', { name: '选择待下载项目（0）', exact: true }).isEnabled(), false)
    assert.equal(await h.panel.getByRole('button', { name: '批量下载并准备发布（0）', exact: true }).isEnabled(), false)
    assert.equal(await h.panel.getByRole('button', { name: /^重试下载与发布准备/ }).count(), 0)
    assert.deepEqual(h.writes, [])
  })
}

test('export configuration never implies a running worker and older responses without worker status remain usable', async t => {
  const h = await harness(t, { state: { jobs: [completedJob()] }, exports: { enabled: true, jobs: [exportFixture()] } })
  await h.openProduction()
  assert.equal(await h.panel.getByRole('status', { name: '视频交付处理状态', exact: true }).count(), 0)
  await h.panel.getByRole('button', { name: '选择待下载项目（1）', exact: true }).click()
  assert.equal(await h.panel.getByRole('button', { name: '批量下载并准备发布（1）', exact: true }).isEnabled(), true)
  h.exports.worker = { status: 'stopped', message: '仅手动处理所选项目' }
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  const worker = h.panel.getByRole('status', { name: '视频交付处理状态', exact: true })
  await worker.getByText('自动处理未运行', { exact: true }).waitFor()
  assert.equal(await worker.getAttribute('title'), '仅手动处理所选项目')
  assert.equal(await h.panel.getByText('自动处理运行中', { exact: true }).count(), 0)
  assert.deepEqual(h.writes, [])
})

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`project production capacity shows active and waiting counts without disabling queue entry or enabling monitoring at ${viewport.width}px`, async t => {
    const message = '等待生产名额（最多同时生产 2 个项目）'
    const h = await harness(t, { viewport, clock: true, state: { jobs: [completedJob()] }, exports: {
      worker: { status: 'running', message: '所选项目正在处理' },
      production: { limit: 2, activeProjects: 2, waitingProjects: 8 },
      jobs: [exportFixture({ stage: 'waiting_capacity', message })],
    } })
    await h.detail.getByRole('status', { name: '项目生产并发', exact: true }).getByText('生产并发：正在生产 2/2 · 等待 8', { exact: true }).waitFor()
    assert.equal(await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).isEnabled(), true)
    await h.openProduction()
    const capacity = h.panel.getByRole('status', { name: '项目生产并发', exact: true })
    await capacity.getByText('生产并发：正在生产 2/2 · 等待 8', { exact: true }).waitFor()
    await h.panel.getByRole('status', { name: '视频交付处理状态', exact: true }).getByText('自动处理运行中', { exact: true }).waitFor()
    await h.openJob(1)
    await h.panel.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true }).getByText(message, { exact: true }).waitFor()
    await h.panel.getByRole('button', { name: '选择待下载项目（1）', exact: true }).click()
    const enqueue = h.panel.getByRole('button', { name: '批量下载并准备发布（1）', exact: true })
    assert.equal(await enqueue.isEnabled(), true, 'A full project capacity must still allow the user to join the queue')
    await enqueue.click()
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
    assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports`, method: 'POST', body: { sourceIds: [101] } }])
    assert.equal(h.exports.jobs.length, 1)
    assert.equal(await h.panel.getByRole('checkbox', { name: '循环监测', exact: true }).isChecked(), false)
    assert.deepEqual(h.state.monitoring, monitoringFixture())
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false)
    assert.equal(await capacity.evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
    h.exports.production = { limit: 2, activeProjects: 1, waitingProjects: 3 }
    await h.page.clock.fastForward(6000)
    await capacity.getByText('生产并发：正在生产 1/2 · 等待 3', { exact: true }).waitFor()
    assert.equal(h.writes.length, 1, 'Refreshing capacity only reads local state')
  })
}

test('optional production capacity supports old responses and clears previous counts when the field is absent', async t => {
  const h = await harness(t, { state: { jobs: [completedJob()] } })
  await h.openProduction()
  const capacity = h.panel.getByRole('status', { name: '项目生产并发', exact: true })
  assert.equal(await capacity.count(), 0)
  await h.panel.getByRole('button', { name: '选择待下载项目（1）', exact: true }).click()
  const enqueue = h.panel.getByRole('button', { name: '批量下载并准备发布（1）', exact: true })
  assert.equal(await enqueue.isEnabled(), true)
  h.exports.production = { limit: 2, activeProjects: 0, waitingProjects: 0 }
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await capacity.getByText('生产并发：正在生产 0/2 · 等待 0', { exact: true }).waitFor()
  assert.equal(await h.panel.getByRole('status', { name: '视频交付处理状态', exact: true }).count(), 0, 'Capacity is usable without the optional worker field')
  delete h.exports.production
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await capacity.waitFor({ state: 'detached' })
  assert.equal(await enqueue.isEnabled(), true)
  assert.equal(await h.panel.getByRole('alert').count(), 0)
  assert.deepEqual(h.writes, [])
})

for (const scenario of ['enqueue', 'resume']) {
  test(`a hanging export ${scenario} releases its lock and reconciles without automatic replay or a duplicate double click`, async t => {
    const h = await harness(t, { clock: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: scenario === 'resume' ? 'failed' : 'queued' })] } })
    const action = scenario === 'resume' ? h.detail.getByRole('button', { name: '重试下载与发布准备', exact: true }) : h.detail.getByRole('button', { name: '下载并准备发布', exact: true })
    h.controls.delayExportWrite = true
    const held = new Promise(resolve => { h.controls.exportWriteHeld = resolve })
    const path = scenario === 'resume' ? `${root}/huasheng/exports/1/resume` : `${root}/huasheng/exports`
    const request = h.page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === path)
    await action.evaluate(button => { button.click(); button.click() })
    await Promise.all([request, held])
    assert.equal(h.controls.exportWritePending.length, 1)
    assert.equal(await h.detail.getByRole('button', { name: '刷新状态', exact: true }).isEnabled(), false)
    await h.page.clock.fastForward(30001)
    await h.detail.getByRole('alert').filter({ hasText: /请求超时.*待核对/ }).waitFor()
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="当前稿花生制作"] button[aria-label="刷新状态"]')?.disabled)
    assert.equal(await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).isEnabled(), true)
    const response = h.page.waitForResponse(reply => reply.request().method() === 'POST' && new URL(reply.url()).pathname === path)
    h.controls.delayExportWrite = false
    h.controls.exportWritePending.splice(0).forEach(release => release())
    await response
    await h.page.clock.fastForward(6000)
    assert.deepEqual(h.writes, [{ path, method: 'POST', body: scenario === 'resume' ? {} : { sourceIds: [101] } }])
    assert.equal(h.exports.jobs.length, 1)
  })
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`completed projects with stopped downloads fit ${viewport.width}px and save a screenshot`, async t => {
    const jobs = Array.from({ length: 50 }, (_, index) => index < 10 ? completedJob({ id: index + 1, sourceId: index + 101, title: `历史项目${index + 1}：从人物经历看朝代变化` }) : jobFixture({ id: index + 1, sourceId: index + 101 }))
    const h = await harness(t, { viewport, state: { jobs }, exports: { enabled: true, jobs: jobs.slice(0, 10).map((job, index) => exportFixture({ id: index + 16, huashengJobId: job.id, sourceId: job.sourceId, stage: 'waiting_production' })), worker: { status: 'stopped', message: '后台自动处理已停止，可手动继续所选项目' } } })
    await h.openProduction()
    await h.panel.getByRole('button', { name: /^素材就绪\s*10$/ }).click()
    await h.openBatch()
    await h.panel.getByRole('button', { name: '选择待下载项目（10）', exact: true }).click()
    await h.panel.getByText(selectionSummary(10, 0, 10, 10), { exact: true }).waitFor()
    assert.equal(await h.panel.getByRole('button', { name: '批量下载并准备发布（10）', exact: true }).isEnabled(), true)
    const dimensions = await h.panel.evaluate(element => ({ panelScroll: element.scrollWidth, panelClient: element.clientWidth, pageScroll: document.documentElement.scrollWidth, pageClient: document.documentElement.clientWidth,
      pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight, listHeight: element.querySelector(innerWidth <= 760 ? '.queue' : '.task-list').clientHeight }))
    assert.ok(dimensions.panelScroll <= dimensions.panelClient + 1 && dimensions.pageScroll <= dimensions.pageClient + 1, JSON.stringify(dimensions))
    assert.ok((viewport.width <= 760 || dimensions.pageHeight <= dimensions.viewportHeight + 1) && dimensions.listHeight >= 240, JSON.stringify(dimensions))
    await h.page.screenshot({ path: join(tmpdir(), `history-huasheng-download-${viewport.width}.png`), fullPage: false, animations: 'disabled' })
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.state.monitoring, monitoringFixture())
  })
}

test('dual-production delivery is automatic and does not require a retired article toggle or backfill existing projects', async t => {
  const h = await harness(t, { state: { jobs: [completedJob()] } })
  await h.openProduction({ settings: true })
  await h.panel.getByText('新建的两版制作任务会自动下载成片、准备标题与封面，并分别发表到百家号。已有项目可选择后补齐发布材料。', { exact: true }).waitFor()
  assert.equal(await h.panel.locator('.export-settings input').count(), 0)
  assert.equal(h.state.monitoring.enabled, false)
  assert.equal(h.exports.jobs.length, 0)
  assert.deepEqual(h.writes, [])
})

test('current completed project queues export once and preserves the four production states and manual download link', async t => {
  const h = await harness(t, { state: { jobs: [completedJob()] } })
  await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).click()
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByText('等待自动导出', { exact: true }).waitFor()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports`, method: 'POST', body: { sourceIds: [101] } }])
  assert.ok(h.exportReads.includes(`${root}/huasheng/exports?sourceId=101`))
  assert.match(await h.detail.locator('.production-status').innerText(), /素材就绪/)
  assert.equal(await h.detail.getByRole('button', { name: '下载视频，打开花生项目' }).getAttribute('type'), 'button')
  await output.getByText('也可打开花生项目下载视频，再到「成片交付」手动上传。', { exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).count(), 1)
  await h.openProduction()
  for (const label of ['未开始', '排队中', '创作中', '素材就绪']) assert.equal(await h.panel.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) }).count(), 1)
})

test('shared selection preserves visible choices across polling and exports only eligible selected latest project versions', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [
    completedJob({ id: 1, title: '旧版项目', scriptSha256: 'old-version' }),
    completedJob({ id: 2, title: '当前项目', createdAt: '2026-10-22T02:00:00.000Z' }),
    completedJob({ id: 3, sourceId: 102, title: '另一个历史项目', scriptSha256: 'second-project', projectUrl: 'https://www.huasheng.cn/video/456' }),
    jobFixture({ id: 4, sourceId: 103, title: '仍在制作', productionStatus: 'creating', projectUrl: 'https://www.huasheng.cn/video/789' }),
    completedJob({ id: 5, sourceId: 104, title: '已经导出' }),
    completedJob({ id: 6, sourceId: 105, title: '未选中已完成项目' }),
  ] }, exports: { jobs: [exportFixture({ huashengJobId: 5, sourceId: 104, status: 'completed' })] } })
  await h.openProduction()
  const batchExport = h.panel.getByRole('button', { name: batchDownloadLabel, exact: true })
  for (const id of [1, 4, 5]) await h.panel.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).check()
  await h.panel.getByText(selectionSummary(3, 0, 3, 0), { exact: true }).waitFor()
  assert.equal(await batchExport.isEnabled(), false, 'Old, unfinished and already exported projects cannot enqueue exports')
  await h.panel.getByRole('checkbox', { name: '选择任务 #2 项目', exact: true }).check()
  await h.panel.getByRole('searchbox', { name: '搜索制作任务' }).fill('另一个')
  await h.panel.getByText(selectionSummary(0, 0, 0, 0), { exact: true }).waitFor()
  await h.panel.getByRole('checkbox', { name: '选择任务 #3 项目', exact: true }).check()
  await h.page.clock.fastForward(6000)
  assert.equal(await h.panel.getByRole('searchbox', { name: '搜索制作任务' }).inputValue(), '另一个')
  await h.panel.getByText(selectionSummary(1, 0, 1, 1), { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '清除搜索', exact: true }).click()
  assert.equal(await h.panel.getByRole('checkbox', { name: '选择任务 #2 项目', exact: true }).isChecked(), false)
  for (const id of [1, 2, 4, 5]) await h.panel.getByRole('checkbox', { name: `选择任务 #${id} 项目`, exact: true }).check()
  await h.panel.getByText(selectionSummary(5, 0, 5, 2), { exact: true }).waitFor()
  await batchExport.click()
  await h.openJob(3)
  await h.panel.getByRole('region', { name: '稿件 #102 自动生成产物状态', exact: true }).waitFor()
  const writes = h.writes.filter(item => item.path === `${root}/huasheng/exports`)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].body, { sourceIds: [101, 102] })
  assert.deepEqual(h.exports.jobs.map(job => job.huashengJobId), [5, 2, 3])
  await h.panel.getByText(selectionSummary(5, 0, 5, 2), { exact: true }).waitFor()
  assert.equal(await batchExport.isEnabled(), true, 'Accepted active tasks can be explicitly continued without creating duplicate export records')
  assert.equal(await h.panel.getByRole('button', { name: '检查选中项目状态（5）', exact: true }).isEnabled(), true)
  assert.deepEqual(h.state.monitoring, monitoringFixture())
})

test('export polling keeps cover images separate from design before completion without changing user inputs', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'exporting', exportProgress: 42, message: '花生正在导出视频' })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByRole('progressbar', { name: '花生导出进度' }).waitFor()
  assert.equal(await output.getByRole('progressbar', { name: '花生导出进度' }).getAttribute('value'), '42')
  await h.openManuscript()
  await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('我尚未保存的修改')
  Object.assign(h.exports.jobs[0], { status: 'downloading', message: '正在下载并关联成片', downloadedBytes: 3 * 1024 ** 2, totalBytes: 12 * 1024 ** 2 })
  await h.page.clock.fastForward(6000)
  await h.openDetail()
  await output.getByText('已下载 3.0 MB / 12.0 MB', { exact: true }).waitFor()
  Object.assign(h.exports.jobs[0], { status: 'processing', message: '视频已关联，正在生成封面图片', downloadedBytes: 12 * 1024 ** 2,
    videoUrl: '/static/history-deliveries/101/abc-123.mp4', designStatus: 'completed', coverStatus: 'generating', articleStatus: 'generating' })
  await h.page.clock.fastForward(6000)
  await output.getByText('方案完成', { exact: true }).waitFor()
  assert.equal(await output.getByRole('link', { name: '查看已下载视频' }).getAttribute('href'), '/static/history-deliveries/101/abc-123.mp4')
  await output.getByText('正在生成图片', { exact: true }).waitFor()
  assert.doesNotMatch(await output.innerText(), /图片完成|可在产物中继续生成/)
  Object.assign(h.exports.jobs[0], { status: 'completed', message: '产物已生成', articleStatus: 'completed' })
  await h.page.clock.fastForward(6000)
  await output.getByText('产物待补齐', { exact: true }).waitFor()
  assert.equal(await output.getByText('发布准备完成', { exact: true }).count(), 0)
  Object.assign(h.exports.jobs[0], { coverStatus: 'completed' })
  await h.page.clock.fastForward(6000)
  await output.getByText('发布准备完成', { exact: true }).waitFor()
  await output.getByText('图片完成', { exact: true }).waitFor()
  assert.equal(await output.getByText('文章完成', { exact: true }).count(), 0)
  await h.openManuscript()
  assert.equal(await h.page.getByRole('textbox', { name: '编辑待审稿' }).inputValue(), '我尚未保存的修改')
  assert.equal(h.writes.length, 0)
})

test('legacy completed exports without cover images offer explicit repair on the original job and never claim completion', async t => {
  const videoUrl = '/static/history-deliveries/101/abc-123.mp4'
  const h = await harness(t, { clock: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({
    id: 27, status: 'completed', stage: 'completed', coverStatus: null, videoUrl, message: '产物已完成',
  })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByText('产物待补齐', { exact: true }).waitFor()
  await output.getByText('尚未生成图片', { exact: true }).waitFor()
  assert.equal(await output.getByText('发布准备完成', { exact: true }).count(), 0)
  assert.equal(await output.getByRole('button', { name: '查看封面图片', exact: true }).count(), 0)
  assert.doesNotMatch(await output.innerText(), /可在产物中继续生成|可手动继续生成/)
  await h.page.clock.fastForward(6000)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openDetail()
  assert.deepEqual(h.writes, [], 'Reading or polling a legacy result never repairs it automatically')
  await output.getByRole('button', { name: '补齐产物', exact: true }).click()
  await output.getByText('正在准备发布', { exact: true }).waitFor()
  await output.getByText('等待生成图片', { exact: true }).waitFor()
  assert.equal(h.exports.jobs.length, 1)
  assert.equal(h.exports.jobs[0].id, 27)
  assert.equal(h.exports.jobs[0].videoUrl, videoUrl)
  assert.equal(h.exports.jobs[0].designStatus, 'completed')
  assert.equal(h.exports.jobs[0].articleStatus, 'completed')
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports/27/resume`, method: 'POST', body: {} }])
  Object.assign(h.exports.jobs[0], { status: 'completed', coverStatus: 'completed', message: '全部产物已完成' })
  await h.page.clock.fastForward(6000)
  await output.getByText('发布准备完成', { exact: true }).waitFor()
  await output.getByRole('button', { name: '查看封面图片', exact: true }).waitFor()
  assert.equal(await output.getByRole('button', { name: '补齐产物', exact: true }).count(), 0)
})

test('failed cover images stay retryable while completed design and video are retained', async t => {
  const h = await harness(t, { state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'failed',
    videoUrl: '/static/history-deliveries/101/abc-123.mp4', designStatus: 'completed', articleStatus: 'completed', coverStatus: 'failed',
    message: '三种尺寸封面图片生成失败', error: '图片生成连接失败',
  })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByRole('alert').getByText('图片生成连接失败', { exact: true }).waitFor()
  await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).click()
  await output.getByText('等待生成图片', { exact: true }).waitFor()
  await output.getByText('方案完成', { exact: true }).waitFor()
  assert.equal(await output.getByText('文章完成', { exact: true }).count(), 0)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports/1/resume`, method: 'POST', body: {} }])
  assert.equal(h.exports.jobs.length, 1)
})

test('retry targets the same failed export job and preserves its successful video and design steps', async t => {
  const videoUrl = '/static/history-deliveries/101/abc-123.mp4'
  const h = await harness(t, { state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'failed', videoUrl,
    designStatus: 'completed', coverStatus: 'failed', error: '封面图片生成超时', message: '请重试封面生成' })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByRole('alert').filter({ hasText: '封面图片生成超时' }).waitFor()
  await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).click()
  await output.getByText('正在准备发布', { exact: true }).waitFor()
  await output.getByText('方案完成', { exact: true }).waitFor()
  await output.getByText('等待生成图片', { exact: true }).waitFor()
  assert.equal(h.exports.jobs[0].videoUrl, videoUrl)
  assert.equal(h.exports.jobs[0].designStatus, 'completed')
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports/1/resume`, method: 'POST', body: {} }])
})

test('lost export submission is reconciled by GET with no duplicate POST after polling or reload', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [completedJob()] } })
  h.controls.loseExportSubmit = true
  await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).click()
  await h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true }).waitFor()
  await h.page.clock.fastForward(6000)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openDetail()
  await h.detail.getByText('等待自动导出', { exact: true }).waitFor()
  assert.equal(await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).count(), 1)
  assert.equal(h.writes.filter(item => item.path === `${root}/huasheng/exports`).length, 1)
  assert.equal(h.exports.jobs.length, 1)
  assert.equal(h.exports.jobs[0].id, 1)
})

test('an export dropped before acceptance can be manually retried after GET finds no job, even without browser storage', async t => {
  const h = await harness(t, { clock: true, storageUnavailable: true, state: { jobs: [completedJob()] } })
  await h.openDetail()
  h.controls.dropExportSubmit = true
  const submit = h.detail.getByRole('button', { name: '下载并准备发布', exact: true })
  const readsBefore = h.exportReads.length
  await submit.click()
  await h.detail.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor()
  await h.page.waitForFunction(() => [...document.querySelectorAll('[aria-label="当前稿花生制作"] button')].some(button => button.textContent.trim() === '下载并准备发布' && !button.disabled))
  assert.ok(h.exportReads.length > readsBefore, 'A failed POST is reconciled by GET')
  assert.equal(h.exports.jobs.length, 0)
  await h.page.clock.fastForward(6000)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openDetail()
  await submit.waitFor()
  assert.equal(await submit.isEnabled(), true)
  assert.equal(h.writes.filter(item => item.path === `${root}/huasheng/exports`).length, 1, 'Polling and reload never replay the POST')
  h.controls.dropExportSubmit = false
  await submit.click()
  await h.detail.getByText('等待自动导出', { exact: true }).waitFor()
  assert.equal(h.exports.jobs.length, 1)
  assert.equal(h.writes.filter(item => item.path === `${root}/huasheng/exports`).length, 2, 'Only the explicit second click retries')
})

test('lost export resume keeps successful products and only GET observes continuation', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'needs_attention',
    videoUrl: '/static/history-deliveries/101/abc-123.mp4', designStatus: 'completed', coverStatus: 'needs_attention', message: '封面需要继续处理' })] } })
  h.controls.loseExportResume = true
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).click()
  await output.getByText('正在准备发布', { exact: true }).waitFor()
  await h.page.clock.fastForward(6000)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openDetail()
  await output.getByText('方案完成', { exact: true }).waitFor()
  assert.equal(h.writes.filter(item => item.path.endsWith('/exports/1/resume')).length, 1)
})

test('export state failure stays separate from production and manual download and clears on read-only refresh', async t => {
  const h = await harness(t, { state: { jobs: [completedJob()] } })
  h.controls.failExportGet = true
  await h.detail.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.detail.getByRole('alert').filter({ hasText: '自动导出状态暂不可用' }).waitFor()
  assert.match(await h.detail.locator('.production-status').innerText(), /素材就绪/)
  assert.equal(await h.detail.getByRole('button', { name: '下载视频，打开花生项目' }).getAttribute('type'), 'button')
  assert.equal(await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).isEnabled(), false)
  h.controls.failExportGet = false
  await h.detail.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.page.waitForFunction(() => [...document.querySelectorAll('[aria-label="当前稿花生制作"] button')].some(button => button.textContent.includes('下载并准备发布') && !button.disabled))
  assert.equal(await h.detail.getByRole('alert').count(), 0)
  assert.equal(h.writes.length, 0)
})

test('export progress and recovery controls fit a narrow screen with the task-bound project action', async t => {
  const h = await harness(t, { viewport: { width: 390, height: 844 }, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'waiting_login', message: '请登录花生后继续导出', error: '花生登录已过期', designStatus: 'queued', articleStatus: 'queued' })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByRole('button', { name: '花生账号', exact: true }).waitFor()
  await output.getByText('请先完成花生登录，再点击“下载并准备发布”继续。', { exact: true }).waitFor()
  assert.equal(await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).count(), 0)
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false)
  assert.equal(await output.evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
  assert.equal(await h.detail.getByRole('button', { name: '下载视频，打开花生项目' }).count(), 1)
  assert.equal(h.writes.length, 0)
})

test('waiting login uses shared account management and automatic recovery needs no resume request', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'waiting_login',
    message: '请登录花生后继续导出', error: '花生登录已过期' })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await output.getByRole('button', { name: '花生账号', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: '历史花生账号', exact: true })
  await dialog.getByRole('button', { name: '登录窗口', exact: true }).click()
  await dialog.getByText('已核验，可制作', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '关闭历史花生账号管理', exact: true }).click()
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/accounts/history_huasheng_legacy/login`, method: 'POST', body: {} }])
  assert.equal(await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).count(), 0)
  Object.assign(h.exports.jobs[0], { status: 'exporting', stage: 'exporting', message: '登录恢复，原任务继续导出', error: null, exportProgress: 35 })
  await h.page.clock.fastForward(61000)
  await output.getByText('登录恢复，原任务继续导出', { exact: true }).waitFor()
  assert.equal(await output.getByRole('progressbar', { name: '花生导出进度' }).getAttribute('value'), '35')
  assert.equal(await output.getByRole('alert').count(), 0)
  assert.equal(h.writes.length, 1)
})

test('uncertain export submission exposes the original project without a generic resume or another export', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'needs_attention',
    stage: 'export_uncertain', message: '导出请求结果未确认', error: '未收到导出任务凭据' })] } })
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  const original = output.getByRole('button', { name: '核对原花生项目', exact: true })
  await original.waitFor()
  assert.equal(await original.getAttribute('type'), 'button')
  await output.getByText('导出提交结果未确认，请核对原花生项目；不会重复提交导出。', { exact: true }).waitFor()
  assert.equal(await output.getByRole('button', { name: '重试下载与发布准备', exact: true }).count(), 0)
  assert.equal(await h.detail.getByRole('button', { name: '下载并准备发布', exact: true }).count(), 0)
  await h.page.clock.fastForward(61000)
  await h.openProduction()
  await h.openJob(1)
  const globalOutput = h.panel.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  await globalOutput.getByRole('button', { name: '核对原花生项目', exact: true }).waitFor()
  assert.equal(await globalOutput.getByRole('button', { name: '重试下载与发布准备', exact: true }).count(), 0)
  assert.equal(h.writes.length, 0)
})

test('a dropped recovery request reconciles without replay and permits a manual retry without browser storage', async t => {
  const h = await harness(t, { clock: true, storageUnavailable: true, state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'needs_attention',
    stage: 'products', designStatus: 'completed', coverStatus: 'needs_attention', message: '请手动处理封面后继续' })] } })
  h.controls.dropExportResume = true
  const output = h.detail.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
  const resume = output.getByRole('button', { name: '重试下载与发布准备', exact: true })
  const readsBefore = h.exportReads.length
  await resume.click()
  await h.detail.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor()
  await h.page.waitForFunction(() => [...document.querySelectorAll('[aria-label="当前稿花生制作"] button')].some(button => button.textContent.trim() === '重试下载与发布准备' && !button.disabled))
  assert.ok(h.exportReads.length > readsBefore)
  await h.page.clock.fastForward(6000)
  await h.page.reload({ waitUntil: 'domcontentloaded' })
  await h.openDetail()
  await resume.waitFor()
  assert.equal(await resume.isEnabled(), true)
  assert.deepEqual(h.writes, [{ path: `${root}/huasheng/exports/1/resume`, method: 'POST', body: {} }])
  h.controls.dropExportResume = false
  await resume.click()
  await output.getByText('等待自动导出', { exact: true }).waitFor()
  assert.equal(await resume.count(), 0)
  assert.equal(h.exports.jobs[0].designStatus, 'completed')
  assert.equal(h.writes.length, 2)
  assert.deepEqual(h.writes[1], h.writes[0])
})

for (const mode of ['current project', 'production board']) {
  test(`${mode} product actions open the existing tabs with fresh results and preserve unsaved manuscript`, async t => {
    const h = await harness(t, { state: { jobs: [completedJob()] }, exports: { jobs: [exportFixture({ status: 'completed',
      designStatus: 'completed', articleStatus: 'completed', message: '标题与封面已生成' })] } })
    await h.openManuscript()
    await h.page.getByRole('textbox', { name: '编辑待审稿' }).fill('我尚未保存的口播修改')
    const showOrigin = mode === 'current project' ? h.openDetail : async () => { await h.openProduction(); await h.openJob(1) }
    const origin = mode === 'current project' ? h.detail : h.panel
    await showOrigin()
    Object.assign(h.products.delivery, { title: '京城租房账', baijiahaoTitle: '京城租房账', designStatus: 'completed', coverDesign: { main_title: '京城租房账', ai_prompt: '明朝普通官房与工钱的画面' } })
    const readsBefore = h.productReads.filter(path => path.endsWith('/delivery')).length
    const output = origin.getByRole('region', { name: '稿件 #101 自动生成产物状态', exact: true })
    await output.getByRole('button', { name: '查看文案与封面方案', exact: true }).click()
    await h.page.locator('#detail-tab-delivery[aria-selected="true"]').waitFor()
    await h.page.waitForFunction(() => document.querySelector('.cover-editor textarea')?.value === '京城租房账')
    assert.equal(await h.page.getByRole('textbox', { name: '百家号视频标题', exact: true }).inputValue(), '京城租房账')
    assert.ok(h.productReads.filter(path => path.endsWith('/delivery')).length > readsBefore)
    assert.equal(await h.page.getByRole('button', { name: '生成截图封面', exact: true }).isEnabled(), true)
    await showOrigin()
    assert.equal(await output.getByRole('button', { name: '查看公众号', exact: true }).count(), 0)
    assert.equal(await h.page.locator('#detail-tab-article').count(), 0)
    assert.equal(h.productReads.some(path => path.endsWith('/article')), false)
    await h.openManuscript()
    assert.equal(await h.page.getByRole('textbox', { name: '编辑待审稿' }).inputValue(), '我尚未保存的口播修改')
    assert.equal(h.writes.length, 0)
  })
}

test('global production totals cover every page and older tasks remain reachable after refresh', async t => {
  const jobs = Array.from({ length: 53 }, (_, index) => jobFixture({ id: 200 - index, sourceId: 300 - index, productionStatus: index === 0 || index >= 50 ? 'completed' : 'not_started', createdAt: new Date(Date.UTC(2026, 9, 22, 0, 53 - index)).toISOString() }))
  const h = await harness(t, { paginated: true, state: { jobs } })
  await h.openProduction()
  const filters = h.panel.getByRole('group', { name: '创作状态筛选' })
  await filters.getByRole('button', { name: /^素材就绪\s*4$/ }).waitFor()
  await h.panel.getByText('已加载 50 / 53 项任务', { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '加载更多任务', exact: true }).click()
  await h.panel.getByText('已加载 53 / 53 项任务', { exact: true }).waitFor()
  await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  await h.panel.getByText('已加载 53 / 53 项任务', { exact: true }).waitFor()
  await filters.getByRole('button', { name: /^素材就绪\s*4$/ }).click()
  assert.equal(await h.panel.locator('.task-list .task-item').count(), 4)
  assert.equal(h.writes.length, 0)
})

test('record cleanup initial inventory automatically removes all 33 stale not-started counts from 63 raw jobs', async t => {
  const jobs = Array.from({ length: 63 }, (_, index) => {
    const id = 63 - index
    return jobFixture({
      id, sourceId: 1000 + id,
      status: index < 33 ? 'canceled' : 'submitted', stage: index < 33 ? 'record_cleanup' : 'submitted',
      productionStatus: index < 33 ? 'not_started' : 'completed',
    })
  })
  const h = await harness(t, { clock: true, paginated: true, state: { jobs, counts: { canceled: 33 } } })
  await h.openProduction()
  await h.panel.getByText('已加载 30 / 30 项任务', { exact: true }).waitFor()
  const filters = h.panel.getByRole('group', { name: '创作状态筛选' })
  await filters.getByRole('button', { name: /^未开始\s*0$/ }).waitFor()
  await filters.getByRole('button', { name: /^全部\s*30$/ }).waitFor()
  assert.equal(await h.taskList.locator('.task-item').count(), 30)
  assert.equal(await h.panel.getByRole('button', { name: '加载更多任务', exact: true }).count(), 0)
  assert.deepEqual(h.writes, [])
})

test('record cleanup canceled summary drains more than 100 rows even when tombstones occur only on later pages', async t => {
  const jobs = Array.from({ length: 163 }, (_, index) => {
    const id = 163 - index
    return jobFixture({
      id, sourceId: 1000 + id,
      status: id <= 33 ? 'canceled' : 'submitted', stage: id <= 33 ? 'record_cleanup' : 'submitted',
      productionStatus: id <= 33 ? 'not_started' : 'completed',
    })
  })
  const h = await harness(t, { clock: true, paginated: true, state: { jobs, counts: { canceled: 33 } } })
  await h.openProduction()
  await h.panel.getByText('已加载 130 / 130 项任务', { exact: true }).waitFor()
  const filters = h.panel.getByRole('group', { name: '创作状态筛选' })
  await filters.getByRole('button', { name: /^未开始\s*0$/ }).waitFor()
  await filters.getByRole('button', { name: /^全部\s*130$/ }).waitFor()
  assert.equal(await h.taskList.locator('.task-item').count(), 130)
  assert.equal(await h.panel.getByRole('button', { name: '加载更多任务', exact: true }).count(), 0)
  assert.deepEqual(h.writes, [])
})

test('record cleanup tombstones stay hidden across pagination, refresh and server filtering', async t => {
  const statuses = ['not_started', 'queued', 'creating', 'completed']
  const jobs = Array.from({ length: 105 }, (_, index) => {
    const id = 105 - index
    return jobFixture({
      id, sourceId: id === 105 ? 101 : 100 + id, title: `分页任务 ${id}`,
      status: id > 45 ? 'canceled' : id === 45 ? 'canceled' : 'queued',
      stage: id > 45 || id === 44 ? 'record_cleanup' : 'queued',
      productionStatus: statuses[id % statuses.length],
      createdAt: new Date(Date.UTC(2026, 9, 22, 0, id)).toISOString(),
    })
  })
  const h = await harness(t, { clock: true, paginated: true, state: { jobs } })
  await h.detail.locator('.job-reference').filter({ hasText: /任务 #1$/ }).waitFor()
  assert.equal(await h.detail.locator('.job-row').count(), 1, 'Source panels must exclude record cleanup tombstones too')
  await h.openProduction()
  await h.panel.getByText('已加载 45 / 45 项任务', { exact: true }).waitFor()
  const visibleJobs = jobs.filter(job => !(job.status === 'canceled' && job.stage === 'record_cleanup'))
  const assertCompleteInventory = async () => {
    assert.equal(await h.taskList.locator('.task-item').count(), visibleJobs.length)
    assert.equal(await h.panel.getByRole('button', { name: '加载更多任务', exact: true }).count(), 0)
    for (const [status, label] of Object.entries({ not_started: '未开始', queued: '排队中', creating: '创作中', completed: '素材就绪' })) {
      const count = visibleJobs.filter(job => job.productionStatus === status).length
      await h.panel.getByRole('group', { name: '创作状态筛选' }).getByRole('button', { name: new RegExp(`^${label}\\s*${count}$`) }).waitFor()
    }
    for (const id of [1, 44, 45]) assert.equal(await h.taskList.getByRole('button', { name: `查看任务 #${id} 详情`, exact: true }).count(), 1)
    assert.equal(await h.taskList.getByRole('button', { name: '查看任务 #105 详情', exact: true }).count(), 0)
  }
  await assertCompleteInventory()
  const refresh = async () => {
    await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
    await h.panel.getByText('已加载 45 / 45 项任务', { exact: true }).waitFor()
  }
  await refresh()
  await assertCompleteInventory()
  await h.openManuscript()
  await h.page.locator('.source-production-link').getByText('花生 · 排队中', { exact: true }).waitFor()
  h.state.jobs = visibleJobs
  await h.openProduction()
  await refresh()
  await assertCompleteInventory()
  assert.deepEqual(h.writes, [])
})

test('record cleanup complete inventories ignore stale server totals and omit tombstones from manuscript summaries', async t => {
  const h = await harness(t, { clock: true, state: {
    total: 100, productionCounts: { not_started: 99, queued: 0, creating: 0, completed: 1 },
    jobs: [
      jobFixture({ id: 1, status: 'canceled', stage: 'record_cleanup', cancelRequested: true }),
      completedJob({ id: 2, sourceId: 102 }),
      jobFixture({ id: 3, sourceId: 103, status: 'canceled', stage: 'canceled' }),
      jobFixture({ id: 4, sourceId: 104, status: 'queued', stage: 'record_cleanup' }),
    ],
  } })
  await h.detail.getByText('当前稿件暂无制作任务', { exact: true }).waitFor()
  assert.equal(await h.page.locator('.source-production-link').count(), 0, 'The emitted overview must not revive a cleaned task in the library')
  await h.openProduction()
  await h.panel.getByText('已加载 3 / 3 项任务', { exact: true }).waitFor()
  await h.panel.getByRole('group', { name: '创作状态筛选' }).getByRole('button', { name: /^未开始\s*2$/ }).waitFor()
  await h.panel.getByRole('group', { name: '创作状态筛选' }).getByRole('button', { name: /^素材就绪\s*1$/ }).waitFor()
  assert.equal(await h.taskList.locator('.task-item').count(), 3)
  assert.deepEqual(h.writes, [])
})

test('manuscript production labels identify Huasheng and pending creation results', async t => {
  const h = await harness(t, { clock: true, state: { jobs: [jobFixture()] } })
  for (const [productionStatus, label, pendingField] of [
    ['not_started', '花生 · 等待提交花生'], ['queued', '花生 · 排队中'], ['creating', '花生 · 创作中'], ['completed', '花生 · 等待导出'],
    ['not_started', '花生结果待核对', 'stage'], ['not_started', '花生结果待核对', 'checkpoint'],
  ]) {
    Object.assign(h.state.jobs[0], { productionStatus, stage: 'queued', checkpoint: null, ...(pendingField ? { [pendingField]: 'create_pending' } : {}) })
    await h.openProduction()
    await h.panel.getByRole('button', { name: '刷新状态', exact: true }).click()
    await h.page.waitForFunction(() => !document.querySelector('[aria-label="花生自动制作"] button[aria-label="刷新状态"]')?.disabled)
    if (pendingField) await h.taskList.locator('.production-status').getByText('花生结果待核对', { exact: true }).waitFor()
    await h.openManuscript()
    await h.page.locator('.source-production-link').getByText(label, { exact: true }).waitFor()
  }
  assert.deepEqual(h.writes, [])
})
