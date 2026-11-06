import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const componentUrl = new URL('../app/pages/cba-video.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(componentUrl, 'utf8'), { filename: componentUrl.pathname })
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: componentUrl.pathname, id: 'cba-video-controller-test' }).errors, [])
const script = compileScript(descriptor, { id: 'cba-video-controller-test' }).content
const code = ts.transpileModule(script, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const targets = ['tencent-video', 'baijiahao-video']
const accountState = { accounts: [{ accountName: 'account-a', label: '篮球资讯', status: 'ready', isDefault: true }], defaultAccountName: 'account-a' }
const overview = (extra = {}) => ({ jobs: [], runs: [], activeRun: null, settings: { autoUpload: true, targets }, ...extra })
const job = (id, extra = {}) => ({
  id, title: `新闻 ${id}`, sourceUrl: `https://bbs.hupu.com/${id}.html`,
  status: 'ready', stage: 'uploading', message: '两版成片已就绪', targets,
  news: { url: `/fixture/${id}/news.mp4` }, highlights: { url: `/fixture/${id}/highlights.mp4` },
  canResume: false, canUpload: true, uploads: [], ...extra,
})
const plain = value => JSON.parse(JSON.stringify(value))

test('new production submits the chosen product and defaults to both editions', async t => {
  const h = await harness(t)
  h.s.autoUpload = false
  h.state.post = async () => ({ run: { id: 'mode-run' } })
  assert.equal(h.s.productionMode, 'both')
  await h.s.startRun()
  h.s.productionMode = 'highlights'
  await h.s.startRun()
  h.s.productionMode = 'news'
  await h.s.startRun()
  const submissions = h.state.requests.filter(request => request.method === 'POST')
  assert.deepEqual(submissions.map(request => request.body.productionMode), ['both', 'highlights', 'news'])
  assert.equal(new Set(submissions.map(request => request.body.requestId)).size, 3)
})

test('match identity and source-file availability stay separate from playable outputs', async t => {
  const missing = job('missing-source', { matchLink: { status: 'confirmed', matchId: 'match-a', date: '2026-10-24', home: '上海', away: '福建', score: '109–87', reason: '已核对双方及比赛日期' }, footage: { status: 'missing', label: '原素材已不在本地 · 需重新下载', files: [{ id: 'migu-123', available: false, verified: true, fileName: 'migu-123.mp4', duration: 240 }], candidateCount: 1 }, quality: { warnings: ['新闻版仅 18 秒，未达到新版 30 秒门槛'] } })
  const h = await harness(t, overview({ jobs: [missing] }))
  assert.equal(h.s.matchStatusLabel(missing.matchLink), '比赛已确认')
  assert.match(h.s.matchLine(missing), /2026-10-24 · 上海 109–87 福建/)
  assert.match(h.s.footageLabel(missing.footage), /原素材已不在本地/)
  assert.equal(h.s.hasAllVideos, true, 'Missing source must not hide retained rendered videos')
  assert.equal(h.s.playableFootage(missing.footage).length, 0)
  assert.deepEqual(plain(h.s.qualityWarnings), missing.quality.warnings)
  assert.equal(h.s.footageLabel(undefined), '素材状态待检查')
  assert.equal(h.s.matchStatusLabel(undefined), '比赛关系待检查')
})

test('match library counts only present source files and opens the associated task material tab', async t => {
  const matches = [
    { id: 'match-a', date: '2026-10-24', home: '上海', away: '福建', jobIds: ['match-news'], footage: { status: 'ready', files: [{ id: 'm1', available: true, verified: true, previewUrl: '/source/m1' }] } },
    { id: 'match-b', date: '2026-10-25', home: '上海', away: '福建', jobIds: [], footage: { status: 'missing', files: [{ id: 'm2', available: false, verified: true }] } },
    { id: 'match-c', jobIds: [], footage: { status: 'downloaded_unverified', files: [{ id: 'm3', available: true, verified: false, previewUrl: '/source/m3' }] } },
  ]
  const h = await harness(t, overview({ jobs: [job('match-news')], matches }))
  assert.deepEqual(plain(h.s.materialInventory), { matches: 3, ready: 1, downloaded: 2, missing: 1 })
  h.s.workspaceView = 'matches'
  await h.s.openMatchTask(matches[0])
  assert.equal(h.s.workspaceView, 'news')
  assert.equal(h.s.selectedId, 'match-news')
  assert.equal(h.s.detailTab, 'materials')
  assert.equal(h.s.mobileDetail, true)
  assert.equal(h.s.playableFootage(matches[2].footage).length, 1, 'Unverified downloads can be watched for identity verification')
})

test('source collection failures remain visible independently and highlight-only jobs have one edition', async t => {
  const reports = [{ provider: 'hupu', status: 'ok', count: 24 }, { provider: 'sina', status: 'failed', count: 0, message: '访问超时' }]
  const h = await harness(t, overview({ jobs: [job('highlight-only', { editions: ['highlights'], news: undefined })], sourceReports: reports }))
  assert.equal(h.s.sourceReportLabel(reports[0]), '已采集 24 条')
  assert.equal(h.s.sourceReportLabel(reports[1]), '采集未完成')
  assert.equal(h.s.sourceReportLabel({ status: 'not_collected' }), '尚未采集')
  assert.deepEqual(plain(h.s.versions).map(version => version.id), ['highlights'])
  assert.equal(h.s.videoKind, 'highlights')
  assert.equal(h.s.sourceLabel('https://sports.sina.com.cn/basketball/cba/article.html'), '新浪原文')
  assert.equal(h.s.sourceLabel('https://bbs.hupu.com/123.html'), '虎扑原文')
})

test('task search locates full IDs and unique ID fragments independently of titles', async t => {
  const first = job('2026-11-01-beijing-news-643539526', { title: '北京赛后新闻' })
  const second = job('intake-abcdef123456', { title: first.title })
  const h = await harness(t, overview({ jobs: [first, second] }))
  h.s.search = '643539526'
  assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), [first.id])
  h.s.search = '  INTAKE-ABCDEF123456  '
  assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), [second.id])
})

test('a linked task opens directly and task selection preserves other URL parameters and browser navigation', async t => {
  const first = job('first'), second = job('second')
  const h = await harness(t, overview({ jobs: [first, second] }), {}, { query: { job: second.id, view: 'retained' }, hash: '#output' })
  assert.equal(h.s.selectedId, second.id)
  assert.equal(h.s.selectedJob.id, second.id)
  assert.equal(h.s.mobileDetail, true)
  assert.deepEqual(h.state.requests.map(item => item.path), ['/cba-video', '/cba-video/jobs/second'])

  await h.s.selectJob(first.id)
  await flush()
  assert.deepEqual(plain(h.state.route.query), { job: first.id, view: 'retained' })
  assert.equal(h.state.navigations.at(-1).method, 'push')
  assert.equal(h.state.route.hash, '#output')
  h.state.route.query = { ...h.state.route.query, job: second.id }
  await flush()
  assert.equal(h.s.selectedJob.id, second.id, 'Browser history selects the linked task')
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('an unknown linked ID stays visible as a failed lookup instead of opening another task', async t => {
  const h = await harness(t, overview({ jobs: [job('first')] }), {}, { query: { job: 'missing-task' } })
  assert.equal(h.s.selectedId, 'missing-task')
  assert.equal(h.s.selectedJob, null)
  assert.match(h.s.detailError, /missing-task/)
  await h.s.refresh()
  assert.equal(h.s.selectedId, 'missing-task')
  assert.equal(h.s.selectedJob, null)
  await h.s.selectJob('first')
  assert.equal(h.s.selectedJob.id, 'first')
  assert.equal(h.s.detailError, '')
})

test('an original intake link resolves to the canonical production ID without adding browser history', async t => {
  const actual = job('actual-match')
  const h = await harness(t, overview({ jobs: [job('unrelated'), actual] }), { 'intake-original': actual.id }, { query: { job: 'intake-original' } })
  assert.equal(h.s.selectedId, actual.id)
  assert.equal(h.s.selectedJob.id, actual.id)
  assert.equal(h.state.route.query.job, actual.id)
  assert.equal(h.state.navigations.at(-1).method, 'replace')
  assert.equal(h.state.requests.some(item => item.path === '/cba-video/jobs/unrelated'), false)
})

test('task identity controls copy the actual ID and a direct link and report clipboard failures', async t => {
  const h = await harness(t, overview({ jobs: [job('first'), job('second')] }), {}, { query: { view: 'retained' } })
  await h.s.selectJob('second')
  await h.s.copyTaskReference('id')
  await h.s.copyTaskReference('link')
  assert.equal(h.state.copied[0], 'second')
  const link = new URL(h.state.copied[1])
  assert.equal(link.pathname, '/cba-video')
  assert.equal(link.searchParams.get('job'), 'second')
  assert.equal(link.searchParams.get('view'), 'retained')
  h.state.copyError = new Error('Clipboard permission denied')
  await h.s.copyTaskReference('id')
  assert.equal(h.state.toasts.at(-1).type, 'error')
  assert.equal(h.state.copied.length, 2)
})

test('stopping and requeueing uploads keeps existing videos in the waiting-upload list', async t => {
  const produced = Array.from({ length: 25 }, (_, index) => job(`produced-${index}`, {
    editions: index < 7 ? ['news', 'highlights'] : ['news'],
    highlights: index < 7 ? { url: `/fixture/produced-${index}/highlights.mp4` } : undefined,
  }))
  const unfinished = job('unfinished', { status: 'attention', news: undefined, highlights: undefined, canResume: true, canUpload: false })
  const saved = job('saved', { status: 'completed' })
  const h = await harness(t, overview({ jobs: [...produced, unfinished, saved] }))
  h.s.filter = 'ready'
  assert.equal(h.s.filteredJobs.length, 25)
  const queue = { id: 'requeued', status: 'running', total: 26, processed: 0, pending: 25, items: [] }
  h.state.overview = overview({ resumeCandidatesCount: 0, resumeQueue: queue, jobs: [
    ...produced.map(item => ({ ...item, status: 'queued', canUpload: false, message: '已加入续做队列，等待前面的任务结束' })),
    { ...unfinished, status: 'running', stage: 'writing', canResume: false }, saved,
  ] })
  await h.s.refresh()
  assert.equal(h.s.filteredJobs.length, 25, 'Enqueueing must not hide existing videos from the selected waiting-upload list')
  assert.equal(h.s.countStatus('ready'), 25)
  assert.equal(h.s.countStatus('attention'), 1)
  assert.equal(h.s.countStatus('completed'), 1)
  assert.deepEqual(plain(h.s.outputInventory), { jobs: 26, videos: 34 })
  assert.equal(h.s.resumeButtonLabel, '队列运行中')
  assert.match(h.s.resumeQueueSummary, /^本轮已处理 0/)
  assert.equal(h.s.taskStatusLabel(h.s.filteredJobs[0]), '排队上传')
  assert.equal(h.state.requests.filter(request => request.method === 'POST').length, 0, 'Displaying retained results must not restart work')

  h.state.overview.resumeQueue.status = 'stopped'
  h.state.overview.resumeCandidatesCount = 26
  h.state.overview.jobs = h.state.overview.jobs.map(item => ['queued', 'running'].includes(item.status)
    ? { ...item, status: 'attention', canResume: !item.news, canUpload: !!item.news } : item)
  await h.s.refresh()
  assert.equal(h.s.filteredJobs.length, 25, 'Stopping again must retain the same waiting-upload list')
  assert.equal(h.s.resumeButtonLabel, '继续未完成（26）')
})

test('upload failures remain waiting for upload while incomplete or invalidated videos need production', async t => {
  const stories = [
    job('upload-error', { status: 'attention', uploads: [{ target: 'baijiahao-video', kind: 'news', status: 'uncertain' }] }),
    job('news-only', { status: 'queued', editions: ['news'], highlights: undefined, canUpload: false }),
    job('partial', { status: 'queued', highlights: undefined, canUpload: false }),
    job('invalidated', { status: 'queued', validationFailure: '稿件修改后需要重新校验', canUpload: false }),
    job('auditing', { status: 'running', stage: 'auditing', canUpload: false }),
    job('skipped', { status: 'skipped', news: undefined, highlights: undefined, canUpload: false }),
  ]
  const h = await harness(t, overview({ jobs: stories }))
  h.s.filter = 'ready'
  assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), ['upload-error', 'news-only'])
  assert.equal(h.s.countStatus('ready'), 2)
  h.s.filter = 'attention'
  assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), ['partial', 'invalidated', 'auditing'])
})

test('successful recovery updates the banner only for this run’s current account-bound receipts', async t => {
  const run = { id: 'upload-recovery', kind: 'upload', status: 'attention', jobIds: ['recovered'], targets: ['baijiahao-video'], baijiahaoAccountName: 'account-a' }
  const recovered = job('recovered', { status: 'completed', targets: run.targets, uploads: ['news', 'highlights'].map(kind => ({ kind, target: 'baijiahao-video', ownerRunId: run.id, accountName: 'account-a', status: 'saved', result: { saved: true, published: false } })) })
  const h = await harness(t, overview({ jobs: [recovered], runs: [run] }))
  assert.equal(h.s.runRecovered(run), true)
  assert.equal(h.s.runRecovered({ ...run, kind: 'production' }), false)
  assert.equal(h.s.runRecovered({ ...run, status: 'stopped' }), false)
  assert.equal(h.s.runRecovered({ ...run, baijiahaoAccountName: 'account-b' }), false)
  assert.equal(h.s.runRecovered({ ...run, id: 'another-run' }), false)
  h.state.overview.jobs[0].uploads.pop()
  await h.s.refresh()
  assert.equal(h.s.runRecovered(run), false)
})
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('non-match news displays no corresponding video with both new and already-running backend responses', async t => {
  const social = job('intake-latest-social', { title: '[流言板]赵柏清社媒分享日常', status: 'attention', stage: 'collecting',
    message: '该条是社媒日常，没有可核实的CBA单场比赛日期、双方或比分，无法关联具体比赛。', news: undefined, highlights: undefined, canResume: true, canUpload: false })
  const queue = { id: 'queue-social', status: 'attention', total: 1, processed: 1, failed: 1,
    items: [{ jobId: 'intake-original-social', runId: 'run-social', title: '赵柏清社媒分享日常', status: 'attention', message: '本轮已结束，部分任务需要处理；已完成结果已保留' }] }
  const h = await harness(t, overview({ jobs: [social], resumeQueue: queue }), { 'intake-original-social': social.id })
  assert.equal(h.s.overview.jobs[0].message, '没有对应视频')
  assert.equal(h.s.selectedJob.message, '没有对应视频')
  assert.equal(h.s.resumeQueue.items[0].message, '没有对应视频')
  assert.equal(h.s.resumeQueue.failed, 0)
  assert.equal(h.s.resumeQueue.noVideo, 1)
  for (const message of ['咪咕赛事页访问受阻，暂时无法核实比赛身份', '模型服务请求频率受限', '本轮尚未取得素材']) {
    h.state.overview.jobs[0].message = message; await h.s.refresh()
    assert.equal(h.s.selectedJob.message, message)
    assert.notEqual(h.s.resumeQueue.items[0].message, '没有对应视频')
  }
  h.state.overview.jobs[0].noCorrespondingVideo = true; await h.s.refresh()
  assert.equal(h.s.selectedJob.message, '没有对应视频')
  h.state.overview.jobs[0].status = 'running'; h.state.overview.jobs[0].message = '正在重新读取新闻'; await h.s.refresh()
  assert.equal(h.s.selectedJob.message, '正在重新读取新闻', 'active progress is not replaced by old no-video evidence')
})
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve()
  await vue.nextTick()
}

async function harness(t, initial = overview(), aliases = {}, options = {}) {
  const state = { overview: structuredClone(initial), requests: [], get: null, post: null, navigations: [], copied: [], toasts: [], copyError: null,
    route: vue.reactive({ query: { ...options.query }, hash: options.hash || '' }) }
  const timers = new Map()
  let timerId = 0, requestId = 0
  const window = {
    location: { href: `http://localhost:3013/cba-video?${new URLSearchParams(state.route.query)}${state.route.hash}` },
    setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearInterval(id) { timers.delete(id) },
  }
  const router = Object.fromEntries(['push', 'replace'].map(method => [method, async location => {
    state.navigations.push({ method, ...plain(location) })
    state.route.query = { ...location.query }; state.route.hash = location.hash || ''
    const url = new URL(window.location.href)
    url.search = new URLSearchParams(location.query).toString(); url.hash = state.route.hash
    window.location.href = url.href
  }]))
  const api = {
    async get(path) {
      state.requests.push({ method: 'GET', path })
      const overridden = await state.get?.(path)
      if (overridden !== undefined) return overridden
      if (path === '/cba-video') return structuredClone(state.overview)
      if (path === '/cba-video/accounts') return structuredClone(accountState)
      const match = path.match(/^\/cba-video\/jobs\/([^/]+)$/)
      const id = match && decodeURIComponent(match[1])
      const detail = match && state.overview.jobs.find(item => item.id === (aliases[id] || id))
      if (detail) return structuredClone(detail)
      throw new Error(`Unexpected GET ${path}`)
    },
    async post(path, body) {
      state.requests.push({ method: 'POST', path, body: plain(body) })
      if (state.post) return state.post(path, body)
      throw new Error(`Unexpected POST ${path}`)
    },
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, window, URL,
    useHead() {},
    useRoute: () => state.route,
    useRouter: () => router,
    navigator: { clipboard: { async writeText(value) { if (state.copyError) throw state.copyError; state.copied.push(value) } } },
    crypto: { randomUUID: () => `fixture-request-${++requestId}` },
    require(id) {
      if (id === 'vue') return vue
      if (id === 'lucide-vue-next') return {}
      if (id === 'vue-sonner') return { toast: { success(message) { state.toasts.push({ type: 'success', message }) }, error(message) { state.toasts.push({ type: 'error', message }) } } }
      if (id === '~/composables/useApi') return { api }
      throw new Error(`Unexpected component import: ${id}`)
    },
  })
  // Exercise the compiled setup and its real Vue lifecycle without a DOM or browser.
  const component = module.exports.default
  component.render = () => null
  const renderer = vue.createRenderer({
    createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setElementText() {}, setText() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(component)
  app.mount({})
  t.after(() => {
    app.unmount()
    assert.equal(timers.size, 0, 'Unmount must stop every owned poll')
  })
  await flush()
  await app._instance.setupState.resolveLegacyQueueJobs()
  app._instance.setupState.updateAccounts(structuredClone(accountState))
  return { s: app._instance.setupState, state, timers }
}

for (const lateResult of ['success', 'failure']) {
  test(`a late ${lateResult} for the previous selection cannot replace the current job`, async t => {
    const first = job('first'), second = job('second')
    const h = await harness(t, overview({ jobs: [first, second] }))
    const oldDetail = deferred(), newDetail = deferred()
    h.state.get = path => {
      if (path === '/cba-video/jobs/first') return oldDetail.promise
      if (path === '/cba-video/jobs/second') return newDetail.promise
    }
    const oldRequest = h.s.loadDetail('first')
    const selection = h.s.selectJob('second')
    assert.equal(h.s.selectedId, 'second')
    assert.equal(h.s.detailLoading, true)
    newDetail.resolve(second)
    await selection
    if (lateResult === 'success') oldDetail.resolve({ ...first, title: '过期详情' })
    else oldDetail.reject(new Error('旧任务的加载失败'))
    await oldRequest
    assert.equal(h.s.selectedId, 'second')
    assert.equal(h.s.selectedJob.id, 'second')
    assert.equal(h.s.detailError, '')
    assert.equal(h.s.detailLoading, false)
  })
}

test('starting production waits for an older overview, then reads the new run and starts polling', async t => {
  const h = await harness(t)
  const olderOverview = deferred()
  const oldSnapshot = overview()
  const run = { id: 'new-run', kind: 'production', status: 'running', message: '正在读取新闻' }
  let reads = 0
  h.state.requests.length = 0
  h.state.get = path => {
    if (path === '/cba-video' && ++reads === 1) return olderOverview.promise
  }
  h.state.post = async path => {
    assert.equal(path, '/cba-video/runs')
    h.state.overview = overview({ activeRun: run, runs: [run] })
    return { run }
  }
  const pendingRefresh = h.s.refresh()
  const submission = h.s.startRun()
  await flush()
  assert.equal(reads, 1, 'The pre-submission GET is still outstanding')
  olderOverview.resolve(oldSnapshot)
  await Promise.all([pendingRefresh, submission])
  await flush()
  assert.deepEqual(h.state.requests.map(({ method }) => method), ['GET', 'POST', 'GET'])
  assert.equal(h.s.overview.activeRun.id, run.id)
  assert.equal(h.s.isActive, true)
  assert.equal(h.timers.size, 1, 'The accepted run must enable automatic progress updates')
  assert.equal(h.s.actionBusy, '')

  h.state.overview = overview({ runs: [{ ...run, status: 'completed' }] })
  await [...h.timers.values()][0].fn()
  await flush()
  assert.equal(h.s.isActive, false)
  assert.equal(h.timers.size, 0, 'A completed run must stop polling')
})

test('refresh follows the selected news URL when its intake row becomes a production job', async t => {
  const intake = job('intake-news', { status: 'pending', stage: 'collecting', canResume: true, canUpload: false })
  const h = await harness(t, overview({ jobs: [intake] }))
  assert.equal(h.s.selectedId, intake.id)
  const actual = job('actual-match', { sourceUrl: intake.sourceUrl })
  h.state.overview = overview({ jobs: [job('unrelated-first-row'), actual] })
  h.state.requests.length = 0
  await h.s.refresh()
  assert.equal(h.s.selectedId, actual.id, 'Selection follows the source, not the first queue row')
  assert.equal(h.s.selectedJob.id, actual.id)
  assert.equal(h.s.detailError, '')
  assert.deepEqual(h.state.requests.map(({ path }) => path), ['/cba-video', '/cba-video/jobs/actual-match'])
})

test('server capabilities allow repairing stale outputs and block their upload', async t => {
  const stale = job('stale', {
    status: 'attention', stage: 'rendering', validationFailure: '成片版本失效',
    canResume: true, canUpload: false,
  })
  const h = await harness(t, overview({ jobs: [stale] }))
  h.state.post = async () => ({ run: { id: 'accepted' } })
  assert.equal(h.s.hasAllVideos, true, 'Old previews remain available during repair')
  assert.equal(h.s.canResume, true)
  assert.equal(h.s.canUpload, false)
  assert.equal(h.s.stepState('rendering'), 'attention')
  await h.s.uploadJob()
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 0)
  await h.s.resumeJob()
  assert.equal(h.state.requests.filter(item => item.method === 'POST')[0].path, '/cba-video/jobs/stale/resume')

  h.state.overview = overview({ jobs: [job('stale')] })
  await h.s.refresh()
  assert.equal(h.s.canResume, false)
  assert.equal(h.s.canUpload, true)
  await h.s.resumeJob()
  await h.s.uploadJob()
  assert.deepEqual(h.state.requests.filter(item => item.method === 'POST').map(({ path }) => path), [
    '/cba-video/jobs/stale/resume', '/cba-video/jobs/stale/upload',
  ])
})

test('independent audit appears between writing and rendering and exposes its current stage', async t => {
  const auditing = job('audit', {
    status: 'running', stage: 'auditing', canUpload: false,
    editorialAudit: { decision: 'revise', reviewedAt: '2026-10-24T10:00:00Z', issues: [{ code: 'claim', message: '比分与报道不一致', suggestion: '按官方技术统计更正比分' }] },
  })
  const h = await harness(t, overview({ jobs: [auditing] }))
  const steps = plain(h.s.pipelineSteps).map(step => step.id)
  assert.equal(steps.indexOf('auditing'), steps.indexOf('writing') + 1)
  assert.equal(steps.indexOf('rendering'), steps.indexOf('auditing') + 1)
  assert.equal(h.s.stepState('writing'), 'done')
  assert.equal(h.s.stepState('auditing'), 'active')
  assert.equal(h.s.stepState('rendering'), 'todo')
  assert.deepEqual(plain(h.s.auditIssues), auditing.editorialAudit.issues)

  h.state.overview = overview({ jobs: [{ ...auditing, status: 'attention' }] })
  await h.s.refresh()
  assert.equal(h.s.stepState('auditing'), 'attention')
  h.state.overview = overview({ jobs: [job('audit', { stage: 'rendering', editorialAudit: { decision: 'pass', issues: [] } })] })
  await h.s.refresh()
  assert.equal(h.s.stepState('auditing'), 'done')
  assert.equal(h.s.stepState('rendering'), 'done', 'All production steps are complete when the server permits upload')
  assert.equal(h.s.stepState('uploading'), 'todo')
  assert.deepEqual(plain(h.s.auditIssues), [], 'A passing audit must clear previous repair reasons')
})

test('an uncertain production submission reuses its request ID until it is acknowledged', async t => {
  const h = await harness(t)
  let attempts = 0
  h.state.post = async () => {
    if (++attempts === 1) throw new Error('提交响应丢失')
    return { run: { id: 'acknowledged' } }
  }
  await h.s.startRun()
  assert.equal(h.s.actionError, '提交响应丢失')
  await h.s.startRun()
  assert.equal(h.s.actionError, '')
  await h.s.startRun()
  const submissions = h.state.requests.filter(item => item.method === 'POST')
  assert.equal(submissions.length, 3)
  assert.equal(submissions[0].body.requestId, submissions[1].body.requestId, 'An uncertain retry must address the same server operation')
  assert.notEqual(submissions[1].body.requestId, submissions[2].body.requestId, 'An acknowledged operation must not capture a later intentional run')
})

test('new runs use the default account while uploads retain the job account', async t => {
  const h = await harness(t, overview({ jobs: [job('pinned', { baijiahaoAccountName: 'account-b' })] }))
  const accounts = { accounts: [...accountState.accounts, { accountName: 'account-b', label: '赛事复盘', status: 'ready' }], defaultAccountName: 'account-a' }
  h.state.get = path => path === '/cba-video/accounts' ? accounts : undefined
  h.state.post = async () => ({ run: { id: 'accepted' } })
  await h.s.openDialog('start'); await flush()
  assert.equal(h.s.baijiahaoAccountName, 'account-a')
  await h.s.startRun()
  await h.s.openDialog('upload'); await flush()
  assert.equal(h.s.baijiahaoAccountName, 'account-b')
  await h.s.uploadJob()
  const submissions = h.state.requests.filter(item => item.method === 'POST')
  assert.equal(submissions[0].body.baijiahaoAccountName, 'account-a')
  assert.equal(submissions[1].body.baijiahaoAccountName, 'account-b')
})

test('missing or expired accounts block Baijiahao submission and cannot borrow another account receipt', async t => {
  const h = await harness(t, overview({ jobs: [job('pinned', { baijiahaoAccountName: 'account-b', uploads: [
    { target: 'baijiahao-video', kind: 'news', accountName: 'account-a', status: 'saved', result: { saved: true, draftUrl: 'https://baijiahao.baidu.com/a' } },
  ] })] }))
  h.s.updateAccounts({ accounts: [{ accountName: 'account-a', label: '篮球资讯', status: 'expired' }], defaultAccountName: 'account-a' })
  await h.s.startRun()
  await h.s.uploadJob()
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 0)
  assert.match(h.s.actionError, /已登录/)
  assert.equal(h.s.uploadReceipt('baijiahao-video', 'news'), null)
  h.s.autoUpload = false
  h.state.post = async () => ({ run: { id: 'accepted' } })
  await h.s.startRun()
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1, 'Production without auto-upload needs no account')
})

test('background receipt recovery keeps polling until the saved result reaches the workbench', async t => {
  const h = await harness(t, overview({ jobs: [job('recovery')], recoveryPending: true, recoveryActive: true }))
  assert.equal(h.s.isActive, false)
  assert.equal(h.timers.size, 1)
  h.state.overview = overview({ jobs: [job('recovery', { status: 'completed' })], recoveryPending: false, recoveryActive: false })
  await [...h.timers.values()][0].fn(); await flush()
  assert.equal(h.s.selectedJob.status, 'completed')
  assert.equal(h.timers.size, 0)
})

test('a news-only job needs one video and one receipt per platform, ignoring old highlight uploads', async t => {
  const single = job('single-news', {
    editions: ['news'], highlights: null, baijiahaoAccountName: 'account-a',
    uploads: [
      ...targets.map(target => ({ target, kind: 'news', accountName: target === 'baijiahao-video' ? 'account-a' : undefined, status: 'saved', result: { saved: true } })),
      { target: 'tencent-video', kind: 'highlights', status: 'failed' },
      { target: 'baijiahao-video', kind: 'highlights', accountName: 'account-a', status: 'saved', result: { saved: true } },
    ],
  })
  const h = await harness(t, overview({ jobs: [single] }))
  assert.deepEqual(plain(h.s.versions).map(version => version.id), ['news'])
  assert.equal(h.s.selectedVersionLabel, '新闻版')
  assert.equal(h.s.hasAllVideos, true)
  assert.equal(h.s.currentVideo.url, single.news.url)
  assert.equal(h.s.expectedUploadCount, 2)
  assert.equal(h.s.savedUploadCount, 2)
  assert.equal(h.s.hasUploadIssue, false)
  assert.equal(h.s.uploadLabel(), '未上传', 'A missing highlight must not make a news-only task wait for output')
  assert.equal(h.s.canUpload, true)

  h.state.overview.jobs[0] = { ...single, news: null, canUpload: false }
  await h.s.refresh()
  assert.equal(h.s.hasAllVideos, false)
  assert.equal(h.s.uploadLabel(), '等待成片')
})

test('unmarked legacy jobs retain both versions and an edition change cannot leave a hidden preview selected', async t => {
  const legacy = job('legacy-editions')
  const h = await harness(t, overview({ jobs: [legacy] }))
  assert.deepEqual(plain(h.s.versions).map(version => version.id), ['news', 'highlights'])
  assert.equal(h.s.selectedVersionLabel, '新闻版和集锦版')
  assert.equal(h.s.expectedUploadCount, 4)
  assert.equal(h.s.hasAllVideos, true)
  h.s.videoKind = 'highlights'
  assert.equal(h.s.currentVideo.url, legacy.highlights.url)

  h.state.overview.jobs[0] = { ...legacy, editions: ['news'], highlights: null, targets: ['baijiahao-video'], status: 'attention', canResume: true, canUpload: false }
  await h.s.refresh()
  assert.equal(h.s.videoKind, 'news')
  assert.equal(h.s.currentVideo.url, legacy.news.url)
  assert.equal(h.s.expectedUploadCount, 1)
  assert.equal(h.s.hasAllVideos, true, 'The retained news video remains available while repairing a news-only task')
  assert.equal(h.s.canResume, true)
})

test('recovery checks each job’s editions and keeps account and run binding for mixed runs', async t => {
  const run = { id: 'mixed-recovery', kind: 'resume', status: 'attention', jobIds: ['single', 'both'], targets: ['baijiahao-video'], baijiahaoAccountName: 'account-a' }
  const receipt = kind => ({ kind, target: 'baijiahao-video', ownerRunId: run.id, accountName: 'account-a', status: 'saved', result: { saved: true, published: false } })
  const single = job('single', { editions: ['news'], highlights: null, status: 'completed', uploads: [receipt('news')] })
  const both = job('both', { status: 'completed', uploads: [receipt('news'), receipt('highlights')] })
  const h = await harness(t, overview({ jobs: [single, both], runs: [run] }))
  assert.equal(h.s.runRecovered(run), true)
  assert.equal(h.s.runRecoveryMessage(run), '新闻版和集锦版已核验保存到原账号草稿箱。')
  const onlyNewsRun = { ...run, jobIds: ['single'] }
  assert.equal(h.s.runRecovered(onlyNewsRun), true)
  assert.equal(h.s.runRecoveryMessage(onlyNewsRun), '新闻版已核验保存到原账号草稿箱。')
  await h.s.selectJob('both')
  assert.equal(h.s.runRecovered(onlyNewsRun), true, 'Recovery must not use the selected job’s version tabs')
  assert.equal(h.s.runRecovered({ ...onlyNewsRun, baijiahaoAccountName: 'account-b' }), false)
  assert.equal(h.s.runRecovered({ ...onlyNewsRun, id: 'other-run' }), false)
  assert.equal(h.s.runRecovered({ ...onlyNewsRun, status: 'stopped' }), false)

  h.state.overview.jobs[1].uploads.pop()
  await h.s.refresh()
  assert.equal(h.s.runRecovered(run), false, 'The dual-version task still requires its highlight receipt')
  assert.equal(h.s.runRecovered(onlyNewsRun), true)
  h.state.overview.jobs[0].uploads[0].result.published = true
  await h.s.refresh()
  assert.equal(h.s.runRecovered(onlyNewsRun), false)
})

test('homepage coverage updates independently of the queue and same-match stories remain separate', async t => {
  const h = await harness(t)
  assert.equal(h.s.intakeCoverageLabel, '', 'Older overview responses need no coverage field')
  const stories = Array.from({ length: 24 }, (_, index) => job(`story-${index}`, { home: '天津', away: '广州', matchDate: '2026-10-23', editions: ['news'], highlights: null }))
  h.state.overview = overview({ jobs: stories, intakeCoverage: { total: 24, processed: 5, pending: 19, retrievedAt: '2026-10-24T12:00:00Z' } })
  await h.s.refresh()
  assert.match(h.s.intakeCoverageLabel, /最新首页 24 条 · 已处理 5 条 · 待处理 19 条 · 读取于 /)
  assert.equal(h.s.filteredJobs.length, 24)
  h.s.search = '天津'
  assert.equal(h.s.filteredJobs.length, 24, 'Multiple stories from the same match must not collapse into one row')
  await h.s.selectJob('story-23')
  assert.equal(h.s.selectedJob.sourceUrl, stories[23].sourceUrl)
  h.state.overview.intakeCoverage.processed = 24
  h.state.overview.intakeCoverage.pending = 0
  await h.s.refresh()
  assert.match(h.s.intakeCoverageLabel, /已处理 24 条 · 待处理 0 条/)
  delete h.state.overview.intakeCoverage
  await h.s.refresh()
  assert.equal(h.s.intakeCoverageLabel, '')
})

test('resume queue loads existing candidates and submits selected IDs in list order without new collection', async t => {
  const activeRun = { id: 'already-running', kind: 'resume', status: 'running', message: '正在编辑' }
  const h = await harness(t, overview({ activeRun, resumeCandidatesCount: 3 }))
  const items = [
    { id: 'old-first', title: '旧新闻一', action: 'resume', stage: 'writing', autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'account-b', baijiahaoAccountLabel: '原账号' },
    { id: 'old-second', title: '旧新闻二', action: 'resume', stage: 'finding_media', autoUpload: false, targets: [] },
    { id: 'old-upload', title: '旧成片', action: 'upload', stage: 'uploading', autoUpload: true, targets: ['baijiahao-video'] },
  ]
  h.state.get = path => path === '/cba-video/resume-queue' ? { items, total: items.length } : undefined
  await h.s.openDialog('resume')
  assert.deepEqual(plain(h.s.resumeSelectedIds), items.map(item => item.id))
  assert.equal(h.s.resumeCandidatesCount, 3)
  assert.equal(h.s.canStartResumeQueue, true, 'An unrelated active project can have a queue scheduled behind it')
  assert.match(h.s.resumePolicyLabel(items[0]), /原账号/)
  h.s.resumeSelectedIds = ['old-upload', 'old-first']
  h.state.post = async (path, body) => {
    assert.equal(path, '/cba-video/resume-queue')
    assert.deepEqual(plain(body.jobIds), ['old-first', 'old-upload'])
    assert.deepEqual(Object.keys(body).sort(), ['jobIds', 'requestId'])
    const queue = { id: 'queue-one', status: 'queued', total: 2, processed: 0, pending: 2, completed: 0, failed: 0, stopped: 0, items: [] }
    h.state.overview = overview({ activeRun, resumeQueue: queue, resumeCandidatesCount: 1 })
    return { queue }
  }
  await h.s.startResumeQueue()
  assert.equal(h.s.resumeQueue.id, 'queue-one')
  assert.equal(h.s.queueActive, true)
  assert.equal(h.state.requests.some(request => request.path === '/cba-video/runs'), false)
  assert.equal(h.state.requests.some(request => request.path === '/cba-video/accounts'), false, 'Per-task accounts must remain pinned without selecting a new default')
})

test('empty selection and failed candidate loads cannot start a resume queue', async t => {
  const h = await harness(t, overview({ resumeCandidatesCount: 1 }))
  h.state.get = path => path === '/cba-video/resume-queue' ? { items: [{ id: 'only', title: '唯一新闻', action: 'resume' }], total: 1 } : undefined
  await h.s.openDialog('resume')
  h.s.toggleResumeSelection()
  assert.equal(h.s.resumeSelectedIds.length, 0)
  assert.equal(h.s.canStartResumeQueue, false)
  await h.s.startResumeQueue()
  assert.equal(h.state.requests.some(request => request.method === 'POST'), false)
  h.s.toggleResumeSelection()
  assert.deepEqual(plain(h.s.resumeSelectedIds), ['only'])
  h.state.get = path => { if (path === '/cba-video/resume-queue') throw Error('读取待续做任务失败') }
  await h.s.loadResumeCandidates()
  assert.match(h.s.resumeCandidatesError, /读取待续做任务失败/)
  assert.equal(h.s.canStartResumeQueue, false)
  await h.s.startResumeQueue()
  assert.equal(h.state.requests.some(request => request.method === 'POST'), false)
})

test('resume queue submission rejects double clicks and reuses an uncertain request identity', async t => {
  const h = await harness(t, overview({ resumeCandidatesCount: 1 }))
  h.state.get = path => path === '/cba-video/resume-queue' ? { items: [{ id: 'old-news', title: '旧新闻', action: 'resume' }], total: 1 } : undefined
  await h.s.openDialog('resume')
  const pending = deferred()
  h.state.post = () => pending.promise
  const first = h.s.startResumeQueue()
  await h.s.startResumeQueue()
  assert.equal(h.state.requests.filter(request => request.method === 'POST').length, 1)
  pending.reject(Error('响应未确认'))
  await first
  assert.equal(h.s.actionError, '响应未确认')
  h.state.post = async () => ({ queue: { id: 'same-queue', status: 'queued', items: [], total: 1, pending: 1, processed: 0 } })
  await h.s.startResumeQueue()
  const posts = h.state.requests.filter(request => request.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].body.requestId, posts[1].body.requestId)
})

test('a queued resume batch keeps polling and stops its own queue rather than the preceding task', async t => {
  const queue = { id: 'waiting-queue', status: 'queued', items: [{ runId: 'queued-run', jobId: 'old', title: '旧新闻', status: 'queued' }], total: 1, processed: 0, pending: 1, completed: 0, failed: 0, stopped: 0 }
  const preceding = { id: 'preceding-task', kind: 'resume', status: 'running' }
  const h = await harness(t, overview({ resumeQueue: queue, activeRun: preceding }))
  assert.equal(h.s.queueActive, true)
  assert.equal(h.timers.size, 1)
  assert.equal(h.s.statusLabel('queued'), '待续做')
  h.state.post = async path => {
    assert.equal(path, '/cba-video/resume-queue/waiting-queue/stop')
    h.state.overview = overview({ resumeQueue: { ...queue, status: 'stopped', pending: 0, stopped: 1 }, activeRun: preceding })
    return {}
  }
  await h.s.stopResumeQueue()
  assert.equal(h.s.overview.activeRun.id, preceding.id)
  assert.equal(h.s.queueActive, false)
  assert.equal(h.timers.size, 1, 'The preceding task still needs updates')
  h.state.overview = overview({ resumeQueue: queue })
  await h.s.refresh(); await flush()
  assert.equal(h.s.isActive, false)
  assert.equal(h.timers.size, 1, 'A queued batch needs updates even between individual runs')
  h.state.overview = overview({ resumeQueue: { ...queue, status: 'completed', processed: 1, pending: 0, completed: 1 } })
  await [...h.timers.values()][0].fn(); await flush()
  assert.equal(h.timers.size, 0)
})

const queuedUploadJob = (id, extra = {}) => job(id, {
  editions: ['news'], highlights: undefined, autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'account-a',
  uploads: [{ jobId: id, ownerRunId: `run-${id}`, kind: 'news', target: 'baijiahao-video', accountName: 'account-a',
    status: 'queued', inputDigest: `current-${id}`, fingerprint: `fingerprint-${id}` }], ...extra,
})
const queueItem = (id, extra = {}) => ({ jobId: id, runId: `run-${id}`, title: `原文 ${id}`, status: 'attention', message: '部分任务需要处理', ...extra })

test('old queues separate waiting uploads and no-video from failures using cached stable ID resolution', async t => {
  const waiting = Array.from({ length: 5 }, (_, index) => queuedUploadJob(`rendered-${index}`))
  const noVideo = ['social', 'training'].map(id => job(id, { status: 'attention', news: undefined, highlights: undefined, canUpload: false, message: '无法关联具体比赛' }))
  const failed = ['material-one', 'material-two', 'tokens'].map(id => job(id, { status: 'attention', news: undefined, highlights: undefined, canUpload: false, message: '需要修复' }))
  const jobs = [...waiting, ...noVideo, ...failed]
  const aliases = Object.fromEntries(jobs.map(job => [`intake-${job.id}`, job.id]))
  const items = [queueItem('completed-one', { status: 'completed' }), queueItem('completed-two', { status: 'completed' }),
    ...jobs.map(job => queueItem(job.id, { jobId: `intake-${job.id}` })), queueItem('current', { status: 'running' }),
    ...Array.from({ length: 44 }, (_, index) => queueItem(`pending-${index}`, { status: 'queued' }))]
  const queue = { id: 'legacy-queue', status: 'running', total: 57, processed: 12, completed: 2, failed: 10, pending: 44, stopped: 0, items }
  const h = await harness(t, overview({ jobs, resumeQueue: queue }), aliases)
  await h.s.refresh()
  assert.equal(h.s.resumeQueueSummary, '本轮已处理 12 / 57 条 · 完成 2 · 等待上传 5 · 没有对应视频 2 · 失败 3 · 待执行 44')
  assert.equal(h.s.resumeQueueHeading, '续做队列 · 第 13 / 57 条')
  assert.equal(h.s.resumeQueue.items[2].status, 'attention', 'Historical run status remains unchanged')
  assert.equal(h.s.resumeQueue.items[2].outcome, 'waiting_upload')
  assert.equal(h.s.resumeQueue.items[7].outcome, 'no_video')
  assert.equal(h.s.queueItemStatusLabel('waiting_upload'), '等待上传')
  assert.equal(h.s.queueItemStatusLabel('no_video'), '没有对应视频')
  assert.equal(h.state.requests.filter(request => request.path.includes('/jobs/intake-')).length, 10)
  h.state.requests.length = 0
  const current = h.state.overview.jobs[0]
  current.title = '标题已经重新生成'
  current.status = 'completed'
  current.uploads[0].status = 'saved'
  current.uploads[0].result = { saved: true, published: false }
  await h.s.refresh()
  assert.equal(h.s.resumeQueue.completed, 3)
  assert.equal(h.s.resumeQueue.waitingUpload, 4)
  assert.equal(h.s.resumeQueue.failed, 3)
  assert.equal(h.s.resumeQueue.items[2].outcome, 'completed', 'Cached IDs follow current receipts instead of caching old states')
  assert.equal(h.state.requests.filter(request => request.path.includes('/jobs/intake-')).length, 0, 'Polling reuses resolved IDs')
  assert.equal(h.state.requests.filter(request => request.method !== 'GET').length, 0)
})

test('new queue outcomes and totals are authoritative while run history remains unchanged', async t => {
  const items = [queueItem('waiting', { outcome: 'waiting_upload', resolvedJobIds: ['actual'] }),
    queueItem('social', { outcome: 'no_video' }), queueItem('recovered', { outcome: 'completed' }), queueItem('failed', { outcome: 'failed' })]
  const queue = { id: 'new-queue', status: 'attention', total: 4, processed: 4, completed: 1, waitingUpload: 1, noVideo: 1, failed: 1, pending: 0, items }
  const h = await harness(t, overview({ resumeQueue: queue }))
  assert.equal(h.s.resumeQueueSummary, '本轮已处理 4 / 4 条 · 完成 1 · 等待上传 1 · 没有对应视频 1 · 失败 1 · 待执行 0')
  assert.deepEqual(plain(h.s.resumeQueue.items), items)
  assert.equal(h.state.requests.filter(request => request.path.includes('/jobs/')).length, 0)
})

test('legacy upload classification requires the current valid output, requested editions, run and account', async t => {
  const initial = queuedUploadJob('guarded')
  const run = { id: 'run-guarded', kind: 'resume', status: 'attention', autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'account-a' }
  const queue = { id: 'guards', status: 'attention', total: 1, processed: 1, completed: 0, failed: 1, pending: 0, items: [queueItem('guarded')] }
  const h = await harness(t, overview({ jobs: [initial], runs: [run], resumeQueue: queue }))
  assert.equal(h.s.resumeQueue.items[0].outcome, 'waiting_upload')
  const invalid = [
    ['other run', job => { job.uploads[0].ownerRunId = 'other-run' }],
    ['other account', job => { job.uploads[0].accountName = 'account-b' }],
    ['other platform', job => { job.uploads[0].target = 'tencent-video' }],
    ['other job', job => { job.uploads[0].jobId = 'unrelated' }],
    ['other edition', job => { job.uploads[0].kind = 'highlights' }],
    ['missing requested edition', job => { job.editions.push('highlights') }],
    ['old version filtered out by server', job => { job.uploads = [] }],
    ['missing version', job => { delete job.uploads[0].inputDigest }],
    ['missing fingerprint', job => { delete job.uploads[0].fingerprint }],
    ['missing output', job => { job.news = undefined }],
    ['stale output', job => { job.canUpload = false; job.status = 'attention'; job.validationFailure = '版本过期' }],
    ['blocked upload', job => { job.uploads[0].status = 'blocked' }],
    ['failed upload', job => { job.uploads[0].status = 'failed' }],
    ['uncertain upload', job => { job.uploads[0].status = 'uncertain' }],
    ['unconfirmed receipt', job => { job.uploads[0].status = 'saved'; job.uploads[0].result = { saved: false, published: false } }],
    ['public receipt', job => { job.uploads[0].status = 'saved'; job.uploads[0].result = { saved: true, published: true } }],
  ]
  for (const [reason, change] of invalid) {
    const changed = structuredClone(initial); change(changed)
    h.state.overview.jobs = [changed]
    await h.s.refresh()
    assert.equal(h.s.resumeQueue.items[0].outcome, 'failed', reason)
    assert.equal(h.s.resumeQueue.failed, 1, reason)
  }
  h.state.overview.jobs = [structuredClone(initial)]
  h.state.overview.jobs[0].status = 'running'; h.state.overview.jobs[0].stage = 'uploading'; h.state.overview.jobs[0].canUpload = false
  h.state.overview.jobs[0].uploads[0].status = 'running'
  await h.s.refresh()
  assert.equal(h.s.resumeQueue.items[0].outcome, 'waiting_upload', 'Recovery in progress remains a pending upload')
  h.state.overview.resumeQueue.items[0].status = 'stopped'
  await h.s.refresh()
  assert.equal(h.s.resumeQueue.items[0].outcome, 'stopped', 'Stopped tasks must not be rewritten by receipt inference')
})

test('an unresolved historical ID does not bind to an unrelated job with the same headline', async t => {
  const unrelated = queuedUploadJob('unrelated', { title: '同名新闻' })
  const queue = { id: 'identity', status: 'attention', total: 1, processed: 1, completed: 0, failed: 1, pending: 0,
    items: [queueItem('unrelated', { jobId: 'intake-missing', title: '同名新闻' })] }
  const h = await harness(t, overview({ jobs: [unrelated], resumeQueue: queue }))
  await h.s.refresh()
  assert.equal(h.s.resumeQueue.failed, 1)
  assert.equal(h.s.resumeQueue.waitingUpload, 0)
  assert.equal(h.state.requests.filter(request => request.path.includes('/jobs/intake-missing')).length, 1, 'Missing mappings are not retried every poll')
})

test('a finished production queue with pending uploads keeps receipt polling without showing a running production', async t => {
  const queue = { id: 'waiting-uploads', status: 'waiting_upload', total: 1, processed: 1, completed: 0, failed: 0, waitingUpload: 1, pending: 0,
    items: [queueItem('pending-draft', { outcome: 'waiting_upload' })] }
  const h = await harness(t, overview({ resumeQueue: queue }))
  assert.equal(h.s.queueActive, false)
  assert.equal(h.s.resumeQueueHeading, '续做队列 · 等待上传')
  assert.equal(h.timers.size, 1)
  h.state.overview.resumeQueue = { ...queue, status: 'completed', completed: 1, waitingUpload: 0,
    items: [queueItem('pending-draft', { outcome: 'completed' })] }
  await [...h.timers.values()][0].fn(); await flush()
  assert.equal(h.timers.size, 0)
  assert.equal(h.s.resumeQueueHeading, '续做队列 · 已完成')
})

test('a queue waiting on the uploader can still be stopped and stops polling after acknowledgement', async t => {
  const queue = { id: 'stop-waiting', status: 'waiting_upload', total: 1, processed: 1, completed: 0, failed: 0, waitingUpload: 1, pending: 0,
    items: [queueItem('pending-draft', { outcome: 'waiting_upload' })] }
  const h = await harness(t, overview({ resumeQueue: queue }))
  assert.equal(h.s.queueActive, false)
  assert.equal(h.s.canStopQueue, true)
  h.state.post = async path => {
    assert.equal(path, '/cba-video/resume-queue/stop-waiting/stop')
    h.state.overview.resumeQueue.status = 'stopped'
    return {}
  }
  await h.s.stopResumeQueue(); await flush()
  assert.equal(h.s.canStopQueue, false)
  assert.equal(h.s.resumeQueueHeading, '续做队列 · 已停止')
  assert.equal(h.timers.size, 0)
  assert.equal(h.s.resumeQueue.waitingUpload, 1, 'Stopping keeps the existing rendered result visible')
})

test('a stopped queue with pending items shows stopped and allows explicitly resuming unfinished work', async t => {
  const queue = { id: 'stopped-interrupted', status: 'stopped', total: 25, processed: 14, completed: 12, failed: 2, pending: 11, stopped: 0,
    items: [queueItem('interrupted', { status: 'attention', outcome: 'pending' })] }
  const h = await harness(t, overview({ resumeQueue: queue, resumeCandidatesCount: 13 }))
  assert.equal(h.s.queueActive, false)
  assert.equal(h.s.resumeQueueHeading, '续做队列 · 已停止')
  assert.equal(h.s.resumeButtonLabel, '继续未完成（13）')
  assert.equal(h.s.resumeQueue.pending, 11)
  assert.equal(h.s.canStopQueue, false)
  assert.equal(h.timers.size, 0)
  assert.equal(h.state.requests.some(request => request.method === 'POST'), false)
})

test('legacy ID lookups are serial and a slow lookup cannot block overview polling or duplicate requests', async t => {
  const first = queuedUploadJob('first-resolved'), second = queuedUploadJob('second-resolved')
  const h = await harness(t, overview({ jobs: [first, second] }))
  const slow = deferred()
  h.state.get = path => path === '/cba-video/jobs/intake-first' ? slow.promise
    : path === '/cba-video/jobs/intake-second' ? second : undefined
  h.state.overview.resumeQueue = { id: 'slow-mapping', status: 'running', total: 3, processed: 2, completed: 0, failed: 2, pending: 0,
    items: [queueItem(first.id, { jobId: 'intake-first' }), queueItem(second.id, { jobId: 'intake-second' }), queueItem('active', { status: 'running' })] }
  await h.s.refresh()
  await h.s.refresh()
  assert.equal(h.state.requests.filter(request => request.path === '/cba-video/jobs/intake-first').length, 1)
  assert.equal(h.state.requests.filter(request => request.path === '/cba-video/jobs/intake-second').length, 0, 'Second lookup waits for the first')
  assert.equal(h.s.loading, false, 'Overview refresh can finish while the identity lookup remains pending')
  slow.resolve(first)
  await h.s.resolveLegacyQueueJobs()
  assert.equal(h.state.requests.filter(request => request.path === '/cba-video/jobs/intake-second').length, 1)
  assert.equal(h.s.resumeQueue.waitingUpload, 2)
  assert.equal(h.s.resumeQueue.failed, 0)
})
