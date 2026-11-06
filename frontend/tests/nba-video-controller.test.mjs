import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'

const componentUrl = new URL('../app/pages/nba-video.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(componentUrl, 'utf8'), { filename: componentUrl.pathname })
assert.deepEqual(errors, [])
const script = compileScript(descriptor, { id: 'nba-video-controller' })
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: componentUrl.pathname, id: 'nba-video-controller', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
assert.deepEqual(compileStyle({ source: descriptor.styles[0].content, filename: componentUrl.pathname, id: 'nba-video-controller', scoped: true }).errors, [])
const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const officialChannel = 'https://www.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ/videos'
const settings = { youtubeChannels: [officialChannel], videosPerChannel: 20, languages: ['en', 'zh'], limit: 6, autoProduce: true, autoUpload: false, scheduleEnabled: false, intervalMinutes: 60, voice: 'longanhuan_v3.1', speed: 1.05, originalGain: 0.32, arenaGain: 0.85 }
const uploadAccount = { accountName: 'cba_fixture', label: '体育', status: 'ready', message: '账号已登录' }
const game = { id: 'game-a', localDate: '2026-11-03', tipoffUtc: '2026-11-04T00:00:00Z', localTimezone: 'America/New_York', home: { name: '骑士', score: 115 }, away: { name: '雷霆', score: 118 }, verified: true, evidenceUrls: ['https://example.test/game'] }
const job = (id, extra = {}) => ({ id, title: `新闻 ${id}`, article: { id: `article-${id}`, title: `原文 ${id}`, url: `https://example.test/${id}`, publisher: 'Fixture News', language: 'en', wordCount: 240, characterCount: 0 }, game, status: 'attention', stage: 'media', message: '需要比赛视频', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T01:00:00Z', attempts: 1, canResume: true, canUpload: false, uploaded: false, uploads: [], ...extra })
const overview = (extra = {}) => ({ settings, uploadAccount, jobs: [], matches: [], runs: [], activeRun: null, stats: { total: 0, completed: 0, resumable: 0, running: 0 }, ...extra })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush() { for (let index = 0; index < 16; index++) await Promise.resolve(); await vue.nextTick() }

async function harness(t, initial = overview(), options = {}) {
  const state = { overview: structuredClone(initial), requests: [], get: null, post: null, put: null, patch: null, del: null, toasts: [], copied: [], navigations: [], details: options.details || {}, route: vue.reactive({ query: { ...options.query }, hash: options.hash || '' }) }
  const timers = new Map()
  let timerId = 0, requestId = 0
  const window = {
    location: { href: `http://localhost:3013/nba-video?${new URLSearchParams(state.route.query)}${state.route.hash}` },
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
    async get(path, signal) {
      state.requests.push({ method: 'GET', path, signal })
      const override = await state.get?.(path, signal)
      if (override !== undefined) return override
      if (path === '/nba-video') return structuredClone(state.overview)
      const match = path.match(/^\/nba-video\/jobs\/([^/]+)$/)
      const id = match && decodeURIComponent(match[1])
      if (state.details[id]) return structuredClone(state.details[id])
      const item = state.overview.jobs.find(job => job.id === id)
      if (item) return structuredClone({ ...item, article: { ...item.article, body: 'A complete original article.\n\nA second source paragraph.' }, script: { title: '中文解说', text: '比赛最后时刻，两队继续争夺每一次球权。', facts: [] }, logs: [] })
      throw Object.assign(new Error(`未找到任务 ${id}`), { status: 404 })
    },
    async post(path, body) { state.requests.push({ method: 'POST', path, body: plain(body) }); return state.post ? state.post(path, body) : {} },
    async put(path, body) { state.requests.push({ method: 'PUT', path, body: plain(body) }); if (state.put) return state.put(path, body); state.overview.settings = path === '/nba-video/channels' ? { ...state.overview.settings, ...plain(body) } : plain(body); return { settings: plain(state.overview.settings) } },
    async patch(path, body) { state.requests.push({ method: 'PATCH', path, body: plain(body) }); return state.patch ? state.patch(path, body) : {} },
    async del(path, body) { state.requests.push({ method: 'DELETE', path, body: plain(body) }); if (state.del) return state.del(path, body); const id = decodeURIComponent(path.split('/').at(-1)); state.overview.jobs = state.overview.jobs.filter(item => item.id !== id); return { deleted: true } },
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, window, URL, AbortController,
    useHead() {}, useRoute: () => state.route, useRouter: () => router,
    navigator: { clipboard: { async writeText(value) { state.copied.push(value) } } },
    crypto: { randomUUID: () => `fixture-request-${++requestId}` },
    require(id) {
      if (id === 'vue') return vue
      if (id === 'lucide-vue-next') return {}
      if (id === 'vue-sonner') return { toast: { success(message) { state.toasts.push({ type: 'success', message }) }, error(message) { state.toasts.push({ type: 'error', message }) } } }
      if (id === '~/composables/useApi') return { api }
      throw new Error(`Unexpected import ${id}`)
    },
  })
  const component = module.exports.default
  component.render = () => null
  const renderer = vue.createRenderer({ createComment: () => ({}), createElement: () => ({}), createText: () => ({}), insert() {}, remove() {}, patchProp() {}, setElementText() {}, setText() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp(component)
  app.mount({})
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(() => { unmount(); assert.equal(timers.size, 0, 'Unmount stops owned polling') })
  await flush()
  await app._instance.setupState.refresh()
  return { s: app._instance.setupState, state, timers, unmount }
}

test('collection submits separate article URLs, both languages and optional game identity', async t => {
  const h = await harness(t)
  await h.s.openDialog('collect')
  assert.deepEqual(plain(h.s.collectDraft.languages), ['en', 'zh'])
  Object.assign(h.s.collectDraft, { collectionMode: 'manual', articleUrls: ' https://example.test/one\nhttps://example.test/two\nhttps://example.test/one\n', youtubeUrl: ' https://www.youtube.com/watch?v=vDdPLHaKK4k ', gameDate: '2024-11-08', espnEventId: '401704752', limit: 3, autoProduce: false })
  await h.s.startRun()
  const request = h.state.requests.find(item => item.method === 'POST')
  assert.equal(request.path, '/nba-video/runs')
  assert.deepEqual(request.body, { collectionMode: 'manual', languages: ['en', 'zh'], limit: 3, articleUrls: ['https://example.test/one', 'https://example.test/two'], youtubeUrl: 'https://www.youtube.com/watch?v=vDdPLHaKK4k', gameDate: '2024-11-08', espnEventId: '401704752', autoProduce: false, autoUpload: false, requestId: 'nba-web-fixture-request-1' })
  assert.equal(h.s.dialogMode, null)
})

test('invalid intake parameters cannot start collection', async t => {
  const h = await harness(t)
  h.s.collectDraft.collectionMode = 'manual'
  for (const patch of [{ languages: [] }, { languages: ['en'], limit: 0 }, { limit: 101 }, { limit: 2.5 }, { limit: 6, articleUrls: 'javascript:alert(1)' }, { articleUrls: '', youtubeUrl: 'https://example.test/watch' }, { youtubeUrl: '', espnEventId: 'not-an-id' }]) {
    Object.assign(h.s.collectDraft, patch)
    await h.s.startRun()
    assert.ok(h.s.actionError)
  }
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 0)
})

test('both collection modes accept 21 and 100 articles', async t => {
  for (const collectionMode of ['channels', 'manual']) for (const limit of [21, 100]) {
    const h = await harness(t)
    await h.s.openDialog('collect')
    Object.assign(h.s.collectDraft, { collectionMode, limit })
    await h.s.startRun()
    const request = h.state.requests.find(item => item.method === 'POST')
    assert.equal(request?.path, '/nba-video/runs')
    assert.equal(request.body.limit, limit)
    assert.equal(request.body.collectionMode, collectionMode)
  }
})

test('manual intake accepts 100 distinct links and rejects 101 after deduplication', async t => {
  const h = await harness(t)
  await h.s.openDialog('collect')
  const urls = Array.from({ length: 101 }, (_, index) => `https://example.test/news/${index}`)
  Object.assign(h.s.collectDraft, { collectionMode: 'manual', limit: 100, articleUrls: urls.join('\n') })
  await h.s.startRun()
  assert.match(h.s.actionError, /100/)
  assert.equal(h.state.requests.some(item => item.method === 'POST'), false)
  h.s.collectDraft.articleUrls = [...urls.slice(0, 100), urls[0]].join('\n')
  await h.s.startRun()
  const request = h.state.requests.find(item => item.method === 'POST')
  assert.equal(request.body.articleUrls.length, 100)
})

test('settings accept 21 and 100 articles while rejecting invalid batch sizes', async t => {
  const h = await harness(t)
  await h.s.openDialog('settings')
  for (const limit of [0, 2.5, 101]) {
    h.s.settingsDraft.limit = limit
    await h.s.saveSettings()
    assert.ok(h.s.actionError)
  }
  assert.equal(h.state.requests.some(item => item.method === 'PUT'), false)
  for (const limit of [21, 100]) {
    h.s.settingsDraft.limit = limit
    await h.s.saveSettings()
    assert.equal(h.state.requests.filter(item => item.method === 'PUT').at(-1)?.body.limit, limit)
  }
})

test('batch intake defaults to saved channels and omits manual-only fields', async t => {
  const h = await harness(t, overview({ settings: { ...settings, videosPerChannel: 12, autoUpload: true } }))
  await h.s.openDialog('collect')
  assert.equal(h.s.collectDraft.collectionMode, 'channels')
  h.s.collectDraft.articleUrls = 'https://example.test/unused'
  await h.s.startRun()
  const request = h.state.requests.find(item => item.method === 'POST')
  assert.equal(request.path, '/nba-video/runs')
  assert.deepEqual(request.body, { collectionMode: 'channels', languages: ['en', 'zh'], limit: 6, videosPerChannel: 12, autoProduce: true, autoUpload: true, requestId: 'nba-web-fixture-request-1' })
})

test('active production allows a separate collection and account expiry does not block intake', async t => {
  const production = { id: 'produce-one', kind: 'produce', status: 'running', jobIds: ['first'], message: '正在剪辑' }
  const h = await harness(t, overview({ activeRun: production, activeCollection: null, activeProcessing: production, queuedProcessing: [],
    uploadAccount: { ...uploadAccount, status: 'expired' } }))
  assert.equal(h.s.collectionBlocked, false)
  await h.s.openDialog('collect'); h.s.collectDraft.autoUpload = true
  await h.s.startRun()
  assert.equal(h.state.requests.filter(item => item.method === 'POST')[0]?.path, '/nba-video/runs')
  assert.equal(h.s.overview.activeProcessing.id, production.id)
})

test('independent queue controls stop only their selected run and queue unrelated production', async t => {
  const collection = { id: 'collect-one', kind: 'collect', status: 'running', jobIds: [], message: '正在采集' }
  const production = { id: 'produce-one', kind: 'produce', status: 'running', jobIds: ['first'], message: '正在制作' }
  const queued = { id: 'produce-two', kind: 'produce', status: 'queued', jobIds: ['second'], message: '排队中' }
  const h = await harness(t, overview({ jobs: [job('first'), job('second'), job('third'), job('finished', { status: 'completed', canResume: false, canUpload: true })],
    activeRun: collection, activeCollection: collection, activeProcessing: production, queuedProcessing: [queued] }))
  assert.equal(h.s.collectionBlocked, true)
  assert.equal(h.s.canQueueProduction, true)
  h.s.selectedIds = ['first', 'second', 'third']
  assert.deepEqual(plain(h.s.selectedResumeIds), ['third'])
  await h.s.resumeJobs()
  await h.s.uploadJobs(['finished'])
  await h.s.stopRun(h.s.activeCollection)
  await h.s.stopRun(h.s.activeProcessing)
  await h.s.stopRun(h.s.queuedProcessing[0])
  assert.deepEqual(h.state.requests.filter(item => item.method === 'POST').map(({ path, body }) => ({ path, body: { ...body, requestId: undefined } })), [
    { path: '/nba-video/resume', body: { jobIds: ['third'], requestId: undefined } },
    { path: '/nba-video/uploads', body: { jobIds: ['finished'], requestId: undefined } },
    { path: '/nba-video/runs/collect-one/stop', body: { requestId: undefined } },
    { path: '/nba-video/runs/produce-one/stop', body: { requestId: undefined } },
    { path: '/nba-video/runs/produce-two/stop', body: { requestId: undefined } },
  ])
  assert.equal(h.s.runKindLabel('produce'), '制作新闻视频')
})

test('older stored settings receive the official channel and 20-video scan default', async t => {
  const { youtubeChannels, videosPerChannel, autoUpload, ...olderSettings } = settings
  const h = await harness(t, overview({ settings: olderSettings }))
  await h.s.openDialog('collect')
  assert.deepEqual(plain(h.s.overview.settings.youtubeChannels), [officialChannel])
  assert.equal(h.s.collectDraft.videosPerChannel, 20)
  assert.equal(h.s.collectDraft.limit, 6)
  assert.equal(h.s.collectDraft.autoUpload, false)
})

test('empty channels and invalid scan counts block intake while upload account expiry does not', async t => {
  const h = await harness(t, overview({ settings: { ...settings, youtubeChannels: [] } }))
  await h.s.startRun()
  assert.match(h.s.actionError, /至少一个/)
  h.state.overview.settings.youtubeChannels = [officialChannel]
  await h.s.refresh()
  for (const videosPerChannel of [0, 1001, 2.5]) {
    h.s.collectDraft.videosPerChannel = videosPerChannel
    await h.s.startRun()
    assert.match(h.s.actionError, /扫描视频数/)
  }
  h.s.collectDraft.videosPerChannel = 20
  assert.equal(h.state.requests.some(item => item.method === 'POST'), false)
  h.s.collectDraft.autoUpload = true
  h.state.overview.uploadAccount = { ...uploadAccount, status: 'expired', message: '请重新登录体育账号' }
  await h.s.refresh(); await h.s.startRun()
  assert.equal(h.s.actionError, '')
  assert.equal(h.state.requests.find(item => item.method === 'POST').path, '/nba-video/runs')
})

test('channel collection accepts scans of 51 and 1000 videos', async t => {
  for (const videosPerChannel of [51, 1000]) {
    const h = await harness(t)
    await h.s.openDialog('collect')
    h.s.collectDraft.videosPerChannel = videosPerChannel
    await h.s.startRun()
    assert.equal(h.s.actionError, '')
    const request = h.state.requests.find(item => item.method === 'POST')
    assert.equal(request.path, '/nba-video/runs')
    assert.equal(request.body.videosPerChannel, videosPerChannel)
  }
})

test('channel URLs canonicalize home and videos pages and reject videos, duplicates and overflow', async t => {
  const h = await harness(t)
  assert.equal(h.s.channelUrl(' https://youtube.com/@NBA/?view=0#latest '), 'https://www.youtube.com/@NBA/videos')
  assert.equal(h.s.channelUrl('https://m.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ'), officialChannel)
  assert.equal(h.s.channelUrl('https://www.youtube.com/c/NBA/videos'), 'https://www.youtube.com/c/NBA/videos')
  assert.equal(h.s.channelUrl('https://www.youtube.com/user/NBA'), 'https://www.youtube.com/user/NBA/videos')
  for (const value of ['https://www.youtube.com/watch?v=vDdPLHaKK4k', 'https://youtu.be/vDdPLHaKK4k', 'https://www.youtube.com/shorts/vDdPLHaKK4k', 'https://youtube.com.evil.test/@NBA', 'https://person@youtube.com/@NBA', 'http://youtube.com/@NBA', 'https://youtube.com/@NBA\n/videos']) assert.equal(h.s.channelUrl(value), '', value)
  assert.match(h.s.validateChannels(['https://youtube.com/@NBA', 'https://www.youtube.com/@nba/videos']), /重复/)
  assert.match(h.s.validateChannels(Array.from({ length: 31 }, (_, index) => `https://youtube.com/@channel${index}`)), /30/)
  assert.equal(h.s.validateChannels(Array.from({ length: 30 }, (_, index) => `https://youtube.com/@channel${index}`)), '')
})

test('channel drafts retain edits across polling and can save reordered channels during an active batch', async t => {
  const activeRun = { id: 'batch-one', kind: 'collect', status: 'running', jobIds: [], youtubeChannels: [officialChannel], message: '正在扫描' }
  const h = await harness(t, overview({ activeRun }))
  await h.s.openDialog('channels')
  h.s.channelDraft.push('https://youtube.com/@NBA')
  h.s.moveChannel(1, -1)
  h.s.moveChannel(0, -1)
  await h.s.refresh()
  assert.deepEqual(plain(h.s.channelDraft), ['https://youtube.com/@NBA', officialChannel])
  assert.equal(h.s.channelsDirty, true)
  await h.s.saveChannels()
  const request = h.state.requests.find(item => item.method === 'PUT')
  assert.equal(request.path, '/nba-video/channels')
  assert.deepEqual(request.body, { youtubeChannels: ['https://www.youtube.com/@NBA/videos', officialChannel] })
  assert.equal(h.s.dialogMode, null)
  assert.equal(h.s.channelsDirty, false)
  assert.deepEqual(plain(h.s.overview.activeRun.youtubeChannels), [officialChannel])
  assert.equal(h.s.overview.settings.videosPerChannel, 20)
  await h.s.openDialog('channels')
  h.s.channelDraft = []
  await h.s.saveChannels()
  assert.deepEqual(plain(h.s.overview.settings.youtubeChannels), [])
})

test('invalid or unchanged channel drafts never mutate server settings', async t => {
  const h = await harness(t)
  await h.s.openDialog('channels'); await h.s.saveChannels()
  h.s.channelDraft.push('https://youtube.com/watch?v=vDdPLHaKK4k')
  await h.s.saveChannels()
  assert.match(h.s.actionError, /频道/)
  assert.equal(h.state.requests.some(item => item.method === 'PUT'), false)
})

test('publication distinguishes submitted, published and legacy drafts without changing completed production', async t => {
  const pending = job('pending', { status: 'completed', canResume: false, canUpload: true })
  const saved = job('saved', { status: 'completed', canResume: false, canUpload: true, uploads: [{ id: 'saved-one', status: 'saved', result: { saved: true, draftUrl: 'https://example.test/draft' } }] })
  const submitted = job('submitted', { status: 'completed', canResume: false, uploaded: true, uploads: [{ id: 'submitted-one', status: 'submitted', result: { submitted: true, saved: false, published: false, publicationStatus: 'submitted', editorUrl: 'https://example.test/submitted' } }] })
  const published = job('published', { status: 'completed', canResume: false, uploaded: true, uploads: [{ id: 'published-one', status: 'published', result: { submitted: true, saved: false, published: true, publicationStatus: 'published', publishedUrl: 'https://example.test/published' } }] })
  const h = await harness(t, overview({ jobs: [pending, saved, submitted, published, job('unfinished')] }))
  assert.deepEqual(plain(h.s.pendingUploadIds), ['pending', 'saved'])
  assert.equal(h.s.uploadedCount, 2)
  h.s.statusFilter = 'waiting_upload'; assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), ['pending', 'saved'])
  h.s.statusFilter = 'uploaded'; assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), ['submitted', 'published'])
  assert.equal(h.s.canUploadSelected, true)
  assert.equal(h.s.selectedUploadStatus, 'pending')
  await h.s.selectJob('saved')
  assert.equal(h.s.canUploadSelected, true)
  assert.equal(h.s.selectedUploadStatus, 'saved')
  assert.equal(h.s.uploadLabel(h.s.selectedUploadStatus), '历史草稿')
  assert.equal(h.s.selectedJob.status, 'completed')
  assert.equal(h.s.uploadReceipt(h.s.uploadRecords[0]), 'https://example.test/draft')
  assert.equal(h.s.uploadReceiptLabel(h.s.uploadRecords[0]), '打开旧草稿')
  await h.s.selectJob('submitted')
  assert.equal(h.s.canUploadSelected, false)
  assert.equal(h.s.selectedUploadStatus, 'submitted')
  assert.equal(h.s.uploadLabel(h.s.selectedUploadStatus), '已提交审核')
  assert.equal(h.s.uploadReceipt(h.s.uploadRecords[0]), 'https://example.test/submitted')
  assert.equal(h.s.uploadReceiptLabel(h.s.uploadRecords[0]), '查看提交')
  await h.s.selectJob('published')
  assert.equal(h.s.canUploadSelected, false)
  assert.equal(h.s.selectedUploadStatus, 'published')
  assert.equal(h.s.uploadLabel(h.s.selectedUploadStatus), '已发表')
  assert.equal(h.s.uploadReceipt(h.s.uploadRecords[0]), 'https://example.test/published')
  assert.equal(h.s.uploadReceiptLabel(h.s.uploadRecords[0]), '查看作品')
  for (const record of [{ status: 'uncertain', result: { saved: true, draftUrl: 'https://example.test/uncertain' } }, { status: 'saved', result: { saved: false, draftUrl: 'https://example.test/unconfirmed' } }, { status: 'saved', result: { saved: true, draftUrl: 'javascript:alert(1)' } }]) assert.equal(h.s.uploadReceipt(record), '')
  assert.equal(h.s.uploadReceipt({ status: 'saved', result: { saved: true, editorUrl: 'https://example.test/editor' } }), 'https://example.test/editor')
  for (const record of [{ status: 'running', result: { submitted: true, saved: false, editorUrl: 'https://example.test/pending' } }, { status: 'submitted', result: { submitted: false, saved: false, editorUrl: 'https://example.test/unconfirmed' } }, { status: 'published', result: { submitted: true, saved: false, publishedUrl: 'javascript:alert(1)' } }]) assert.equal(h.s.uploadReceipt(record), '')
})

test('publication description shows planned copy before upload and verified current copy after publication', async t => {
  const planned = '2026-11-02 NBA｜东契奇42分13助攻，湖人138-117热火 #NBA#'
  const h = await harness(t, overview({ jobs: [job('copy', { status: 'completed', canUpload: true, publishingDescription: planned })] }))
  assert.equal(h.s.publicationDescription, planned)
  h.state.overview.jobs[0].uploads = [
    { id: 'old', currentVersion: false, status: 'published', description: '旧版本描述 #NBA#' },
    { id: 'current', currentVersion: true, status: 'published', description: '已发表作品的真实描述 #NBA#' },
  ]
  h.state.overview.jobs[0].uploaded = true
  await h.s.refresh()
  assert.equal(h.s.publicationDescription, '已发表作品的真实描述 #NBA#')
  assert.equal(h.state.requests.some(request => request.method !== 'GET'), false)
})

test('publication display normalizes legacy internal saved status and keeps draft conversion eligible', async t => {
  const h = await harness(t, overview({ jobs: [job('legacy', { status: 'completed', canUpload: true, uploads: [{ id: 'legacy-one', status: 'saved', result: { saved: true } }] }), job('internal', { status: 'completed', uploaded: true, uploads: [{ id: 'internal-one', status: 'saved', result: { submitted: true, saved: false, published: true, publicationStatus: 'published', publishedUrl: 'https://example.test/published' } }] })] }))
  assert.equal(h.s.jobUploadStatus(h.s.overview.jobs[0]), 'saved')
  assert.equal(h.s.jobUploadStatus(h.s.overview.jobs[1]), 'published')
  assert.deepEqual(plain(h.s.pendingUploadIds), ['legacy'])
  await h.s.uploadJobs(['internal', 'legacy'])
  assert.deepEqual(h.state.requests.find(item => item.method === 'POST').body.jobIds, ['legacy'])
  assert.match(h.state.toasts.at(-1).message, /发表/)
  assert.match(descriptor.template.content, /#NBA#/)
  assert.doesNotMatch(descriptor.template.content, /百家号草稿|草稿箱|已存草稿|制作后上传百家号/)
})

test('uploads submit only eligible finished jobs in queue order and bind account on the server', async t => {
  const h = await harness(t, overview({ jobs: [job('first', { status: 'completed', canUpload: true }), job('second', { status: 'completed', canUpload: true }), job('already', { status: 'completed', canUpload: true, uploaded: true }), job('unfinished')] }))
  await h.s.uploadJobs(['second', 'already', 'unfinished', 'first'])
  const request = h.state.requests.find(item => item.method === 'POST')
  assert.equal(request.path, '/nba-video/uploads')
  assert.deepEqual(request.body, { jobIds: ['first', 'second'], requestId: 'nba-web-fixture-request-1' })
  assert.equal('baijiahaoAccountName' in request.body, false)
})

test('uncertain uploads reject double submits and retain request identity for retry', async t => {
  const h = await harness(t, overview({ jobs: [job('first', { status: 'completed', canUpload: true })] }))
  const submit = deferred()
  h.state.post = () => submit.promise
  const first = h.s.uploadJobs()
  await flush(); await h.s.uploadJobs()
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
  submit.reject(new Error('Upload response timeout')); await first
  h.state.post = async () => ({})
  await h.s.uploadJobs()
  const requests = h.state.requests.filter(item => item.method === 'POST')
  assert.equal(requests[0].body.requestId, requests[1].body.requestId)
})

test('uploads require the shared account to be ready and stop when a run is active', async t => {
  const h = await harness(t, overview({ uploadAccount: null, jobs: [job('first', { status: 'completed', canUpload: true })] }))
  await h.s.uploadJobs()
  assert.match(h.s.actionError, /CBA/)
  h.state.overview.uploadAccount = uploadAccount
  h.state.overview.activeRun = { id: 'active-upload', kind: 'upload', status: 'running', jobIds: ['first'] }
  await h.s.refresh(); await h.s.uploadJobs()
  assert.equal(h.state.requests.some(item => item.method === 'POST'), false)
})

test('active upload records keep fast polling even without an active run', async t => {
  const h = await harness(t, overview({ jobs: [job('first', { status: 'completed', uploads: [{ id: 'pending-one', status: 'running' }] })] }))
  assert.deepEqual([...h.timers.values()].map(item => item.delay), [4000])
  assert.equal(h.s.selectedUploadStatus, 'running')
  h.state.overview.jobs[0].uploads[0].status = 'uncertain'
  await h.s.refresh(); await flush()
  assert.deepEqual([...h.timers.values()].map(item => item.delay), [15000])
  assert.equal(h.s.hasUploadIssue, true)
  assert.equal(h.s.selectedUploadStatus, 'uncertain')
  assert.equal(h.s.runKindLabel('upload'), '发表百家号视频')
  assert.equal(h.s.channelVideoLabel('failed'), '采集失败')
})

test('language, status and ID or team searches combine without merging same-game reports', async t => {
  const first = job('english-a'), second = job('chinese-b', { article: { language: 'zh', publisher: '中文体育', characterCount: 180, url: 'https://example.test/zh' } }), third = job('finished', { status: 'completed', canResume: false })
  const h = await harness(t, overview({ jobs: [first, second, third] }))
  assert.equal(h.s.filteredJobs.length, 3)
  h.s.languageFilter = 'zh'; assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), ['chinese-b'])
  h.s.clearFilters(); h.s.statusFilter = 'resumable'; assert.equal(h.s.filteredJobs.length, 2)
  h.s.search = ' ENGLISH-A '; assert.deepEqual(plain(h.s.filteredJobs).map(item => item.id), ['english-a'])
  h.s.search = '骑士'; assert.equal(h.s.filteredJobs.length, 2)
  assert.equal(h.s.articleLength(first.article), '240 词')
  assert.equal(h.s.articleLength(second.article), '180 字')
})

test('multi-selection resumes only eligible existing tasks in queue order', async t => {
  const h = await harness(t, overview({ jobs: [job('first'), job('second'), job('finished', { status: 'completed', canResume: false })] }))
  h.s.toggleJobSelection('second'); h.s.toggleJobSelection('finished'); h.s.toggleJobSelection('first')
  assert.deepEqual(plain(h.s.selectedResumeIds), ['first', 'second'])
  await h.s.resumeJobs()
  const request = h.state.requests.find(item => item.method === 'POST')
  assert.equal(request.path, '/nba-video/resume')
  assert.deepEqual(request.body.jobIds, ['first', 'second'])
  assert.equal('languages' in request.body, false)
  assert.deepEqual(plain(h.s.selectedIds), [])
})

test('the translation pipeline has eight stages and legacy review tasks remain resumable', async t => {
  const legacy = job('legacy-review', { stage: 'review', review: { passed: false, issues: ['Legacy review result'] } })
  const h = await harness(t, overview({ jobs: [legacy] }))
  assert.deepEqual(plain(h.s.stages).map(stage => stage.id), ['intake', 'match', 'script', 'media', 'voice', 'captions', 'render', 'verify'])
  assert.equal(h.s.stageLabel('script'), '翻译')
  assert.equal(h.s.stageLabel('review'), '翻译')
  assert.equal(h.s.stepState('match'), 'done')
  assert.equal(h.s.stepState('script'), 'held')
  assert.equal(h.s.stepState('media'), 'todo')
  assert.equal(h.s.canResumeSelected, true)
  await h.s.resumeJobs([legacy.id])
  const request = h.state.requests.find(item => item.method === 'POST')
  assert.equal(request.path, '/nba-video/resume')
  assert.deepEqual(request.body.jobIds, [legacy.id])
})

test('translation details omit fact review and mapping while retaining material and delivery checks', () => {
  assert.match(descriptor.template.content, /<h3>中文译稿<\/h3>/)
  assert.doesNotMatch(descriptor.template.content, /selectedJob\.review|script\?\.facts|fact-mapping|事实审核|事实依据/)
  assert.doesNotMatch(descriptor.styles[0].content, /\.review-section|\.review-issues|\.fact-mapping/)
  assert.match(descriptor.template.content, /selectedJob\.game\.verified/)
  assert.match(descriptor.template.content, /selectedJob\.media\.verified/)
  assert.match(descriptor.template.content, /selectedJob\.media\.verificationNotes/)
  assert.match(descriptor.template.content, /<h3>交付检查<\/h3>/)
})

test('sports topic tasks show video context and remain searchable without a game', async t => {
  const topic = { id: 'youtube-rhZ6oVlNZHs', videoId: 'rhZ6oVlNZHs', title: 'Media Day interview', description: 'New season plans' }
  const h = await harness(t, overview({ jobs: [job('interview', { game: undefined, article: { language: 'en', topic } })] }))
  h.s.search = 'Media Day'
  assert.equal(h.s.filteredJobs.length, 1)
  assert.equal(h.s.stageLabel('match'), '主题')
  assert.match(descriptor.template.content, /selectedJob\.article\?\.topic/)
  assert.doesNotMatch(descriptor.template.content, /比赛身份尚未确认/)
})

test('selecting visible results preserves selections hidden by a language filter', async t => {
  const h = await harness(t, overview({ jobs: [job('english'), job('chinese', { article: { language: 'zh', characterCount: 150 } })] }))
  h.s.toggleJobSelection('english'); h.s.languageFilter = 'zh'; h.s.toggleVisibleSelection()
  assert.deepEqual(plain(h.s.selectedResumeIds), ['english', 'chinese'])
  assert.equal(h.s.allVisibleSelected, true)
  h.s.toggleVisibleSelection(); assert.deepEqual(plain(h.s.selectedResumeIds), ['english'])
})

test('uncertain submissions reject double clicks and reuse request identity and form after reopening', async t => {
  const h = await harness(t)
  await h.s.openDialog('collect')
  h.s.collectDraft.collectionMode = 'manual'
  h.s.collectDraft.articleUrls = 'https://example.test/one'
  const submit = deferred()
  h.state.post = () => submit.promise
  const first = h.s.startRun()
  await flush(); await h.s.startRun()
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
  submit.reject(new Error('Network timeout')); await first
  h.s.closeDialog(); await h.s.openDialog('collect')
  assert.equal(h.s.collectDraft.articleUrls, 'https://example.test/one')
  h.state.post = async () => ({})
  await h.s.startRun()
  const requests = h.state.requests.filter(item => item.method === 'POST')
  assert.equal(requests[0].body.requestId, requests[1].body.requestId)
})

test('a rejected 4xx submission releases its request identity', async t => {
  const h = await harness(t)
  h.state.post = async () => { throw Object.assign(new Error('请求无效'), { status: 400 }) }
  await h.s.startRun()
  h.state.post = async () => ({})
  await h.s.startRun()
  const requests = h.state.requests.filter(item => item.method === 'POST')
  assert.notEqual(requests[0].body.requestId, requests[1].body.requestId)
})

for (const outcome of ['success', 'failure']) {
  test(`a late detail ${outcome} cannot replace a newly selected article`, async t => {
    const h = await harness(t, overview({ jobs: [job('first'), job('second')] }))
    const late = deferred()
    h.state.get = path => path.endsWith('/first') ? late.promise : undefined
    const old = h.s.loadDetail('first', true)
    await h.s.selectJob('second')
    if (outcome === 'success') late.resolve(job('first'))
    else late.reject(new Error('Old detail failed'))
    await old
    assert.equal(h.s.selectedId, 'second'); assert.equal(h.s.selectedJob.id, 'second'); assert.equal(h.s.detailError, '')
  })
}

test('unknown deep links stay failed, while selection keeps URL parameters and browser navigation', async t => {
  const h = await harness(t, overview({ jobs: [job('first'), job('second')] }), { query: { job: 'missing', view: 'keep' }, hash: '#retained' })
  assert.equal(h.s.selectedId, 'missing'); assert.equal(h.s.selectedJob, null); assert.match(h.s.detailError, /missing/)
  await h.s.selectJob('second'); await flush()
  assert.deepEqual(plain(h.state.route.query), { job: 'second', view: 'keep' }); assert.equal(h.state.route.hash, '#retained')
  await h.s.copyTaskLink()
  assert.equal(new URL(h.state.copied[0]).searchParams.get('job'), 'second')
  h.state.route.query = { job: 'first', view: 'keep' }; await flush()
  assert.equal(h.s.selectedJob.id, 'first')
})

test('an action waits for an older overview and then starts active polling from fresh state', async t => {
  const h = await harness(t, overview({ jobs: [job('first')] }))
  assert.deepEqual([...h.timers.values()].map(item => item.delay), [15000])
  const old = deferred()
  let oldReturned = false
  h.state.get = path => path === '/nba-video' && !oldReturned ? (oldReturned = true, old.promise) : undefined
  const refresh = h.s.refresh()
  h.state.post = async () => { h.state.overview.activeRun = { id: 'run-new', kind: 'collect', status: 'running', jobIds: [], message: '正在采集' }; return {} }
  const start = h.s.startRun()
  await flush()
  old.resolve(overview({ jobs: [job('first')] }))
  await refresh; await start; await flush()
  assert.equal(h.s.overview.activeRun.id, 'run-new')
  assert.deepEqual([...h.timers.values()].map(item => item.delay), [4000])
})

test('active jobs cannot be resumed or have their source replaced and stop targets the current run', async t => {
  const run = { id: 'active-run', kind: 'resume', status: 'running', jobIds: ['first'], message: '配音中' }
  const h = await harness(t, overview({ jobs: [job('first', { status: 'running' })], activeRun: run }))
  assert.equal(h.s.canDelete, false)
  h.s.sourceUrlDraft = 'https://youtu.be/vDdPLHaKK4k'
  await h.s.saveSource(); await h.s.resumeJobs(['first'])
  assert.equal(h.state.requests.some(item => ['POST', 'PATCH'].includes(item.method)), false)
  h.state.post = async () => { h.state.overview.activeRun = null; return {} }
  await h.s.stopRun(); await flush()
  assert.equal(h.state.requests.find(item => item.method === 'POST').path, '/nba-video/runs/active-run/stop')
  assert.deepEqual([...h.timers.values()].map(item => item.delay), [15000])
})

test('source repair patches only the selected task and preserves an unsaved URL across polling', async t => {
  const h = await harness(t, overview({ jobs: [job('first')] }))
  h.s.sourceUrlDraft = 'https://youtu.be/vDdPLHaKK4k'
  await h.s.refresh()
  assert.equal(h.s.sourceUrlDraft, 'https://youtu.be/vDdPLHaKK4k')
  await h.s.saveSource()
  const request = h.state.requests.find(item => item.method === 'PATCH')
  assert.equal(request.path, '/nba-video/jobs/first')
  assert.deepEqual(request.body, { youtubeUrl: 'https://youtu.be/vDdPLHaKK4k' })
  assert.equal(h.state.requests.some(item => item.method === 'POST'), false)
  assert.equal(h.s.selectedJob.article.body.includes('complete original'), true)
})

test('settings draft survives overview polling and saves explicit schedule, voice and mix values', async t => {
  const h = await harness(t)
  await h.s.openDialog('settings')
  Object.assign(h.s.settingsDraft, { scheduleEnabled: true, intervalMinutes: 30, speed: 1.1, originalGain: 0.1, arenaGain: 0.75, voice: ' custom-voice ', videosPerChannel: 1000, autoUpload: true })
  h.state.overview.settings.youtubeChannels = ['https://www.youtube.com/@NBA/videos']
  await h.s.refresh()
  assert.equal(h.s.settingsDraft.intervalMinutes, 30)
  await h.s.saveSettings()
  const request = h.state.requests.find(item => item.method === 'PUT')
  assert.equal(request.path, '/nba-video/settings')
  assert.equal(request.body.voice, 'custom-voice'); assert.equal(request.body.scheduleEnabled, true)
  assert.equal(request.body.originalGain, 0.1); assert.equal(request.body.arenaGain, 0.75)
  assert.equal(request.body.videosPerChannel, 1000); assert.equal(request.body.autoUpload, true)
  assert.deepEqual(request.body.youtubeChannels, ['https://www.youtube.com/@NBA/videos'])
})

test('settings reject a scan larger than 1000 before saving', async t => {
  const h = await harness(t)
  await h.s.openDialog('settings')
  h.s.settingsDraft.videosPerChannel = 1001
  await h.s.saveSettings()
  assert.match(h.s.actionError, /采集数量/)
  assert.equal(h.state.requests.some(item => item.method === 'PUT'), false)
})

test('deletion supplies the captured title and moves selection to the surviving task', async t => {
  const h = await harness(t, overview({ jobs: [job('first'), job('second')] }), { query: { job: 'first', view: 'keep' } })
  await h.s.openDialog('delete'); await h.s.deleteJob(); await flush()
  const request = h.state.requests.find(item => item.method === 'DELETE')
  assert.deepEqual(request.body, { expectedTitle: '新闻 first' }); assert.equal(request.path, '/nba-video/jobs/first')
  assert.equal(h.s.selectedJob.id, 'second'); assert.deepEqual(plain(h.state.route.query), { view: 'keep' })
})

test('a queued task can be deleted while another task in its collection batch is producing', async t => {
  const run = { id: 'active-collection', kind: 'collect', status: 'running', jobIds: ['first', 'second'], message: '制作中' }
  const h = await harness(t, overview({ jobs: [job('first', { status: 'running' }), job('second', { status: 'queued' })], activeRun: run }), { query: { job: 'second' } })
  assert.equal(h.s.canDelete, true)
  await h.s.openDialog('delete'); await h.s.deleteJob(); await flush()
  const request = h.state.requests.find(item => item.method === 'DELETE')
  assert.equal(request.path, '/nba-video/jobs/second')
  assert.deepEqual(request.body, { expectedTitle: '新闻 second' })
  assert.equal(h.s.overview.activeRun.id, 'active-collection')
  assert.equal(h.s.overview.jobs[0].id, 'first')
  assert.equal(h.state.requests.some(item => item.method === 'POST'), false)
})

test('active production and pending uploads explain why deletion is blocked', async t => {
  const cases = [
    { status: 'running' },
    { status: 'stopping' },
    { status: 'completed', uploads: [{ status: 'queued' }] },
    { status: 'completed', uploads: [{ status: 'running' }] },
  ]
  for (const extra of cases) {
    const h = await harness(t, overview({ jobs: [job('first', extra)] }))
    assert.equal(h.s.canDelete, false)
    assert.match(h.s.deleteDisabledReason, /先停止/)
    await h.s.openDialog('delete'); await h.s.deleteJob()
    assert.equal(h.state.requests.some(item => item.method === 'DELETE'), false)
  }
})

test('server capabilities allow a waiting upload task to be removed from its active batch', async t => {
  const run = { id: 'active-upload', kind: 'upload', status: 'running', jobIds: ['first'], message: '等待上传' }
  const h = await harness(t, overview({ jobs: [job('first', { status: 'completed', uploads: [], canDelete: true })], activeRun: run }))
  assert.equal(h.s.canDelete, true)
  await h.s.openDialog('delete'); await h.s.deleteJob()
  assert.equal(h.state.requests.find(item => item.method === 'DELETE').path, '/nba-video/jobs/first')
  assert.equal(h.s.overview.activeRun.id, 'active-upload')
})

test('server deletion protection and its reason override stale selected detail', async t => {
  const first = job('first', { status: 'completed', uploads: [], canDelete: true })
  const h = await harness(t, overview({ jobs: [first] }))
  h.state.overview.jobs[0] = { ...first, canDelete: false, deleteBlockedReason: '任务正在上传，请先停止当前批次后删除' }
  await h.s.refresh()
  assert.equal(h.s.canDelete, false)
  assert.equal(h.s.deleteDisabledReason, '任务正在上传，请先停止当前批次后删除')
  await h.s.openDialog('delete'); await h.s.deleteJob()
  assert.equal(h.state.requests.some(item => item.method === 'DELETE'), false)
})

test('full original, distinct Chinese script and registered assets remain available in detail', async t => {
  const first = job('first', { status: 'completed', canResume: false })
  const detail = { ...first, article: { ...first.article, body: 'Full English body, with a quoted interview.' }, script: { title: '独立中文稿', text: '这篇报道对应的中文解说。', facts: [{ paragraph: 1, claim: '事实' }] }, assets: { video: '/api/v1/nba-video/jobs/first/assets/video', source: '/api/v1/nba-video/jobs/first/assets/source' }, delivery: { duration: 124, verification: { imported: true, decoded: true, naturalEnding: true } }, logs: [] }
  const h = await harness(t, overview({ jobs: [first] }), { details: { first: detail } })
  assert.equal(h.s.selectedJob.article.body, detail.article.body); assert.equal(h.s.selectedJob.script.text, detail.script.text)
  assert.equal(h.s.assetUrl('video'), detail.assets.video); assert.equal(h.s.isImported, true)
  assert.equal(h.s.verificationEntries.some(item => item.label === '自然收尾'), true)
  assert.equal(h.s.webUrl('javascript:alert(1)'), '')
})

test('a quality hold displays stopped publication while preserving historical submission receipts', async t => {
  const item = job('held', { status: 'attention', canResume: false, canUpload: false, uploaded: false,
    qualityHold: { source: 'user-report', reason: '网页杂项与片尾静音', rejectedDeliverySha256: 'old-version' },
    uploads: [{ id: 'old-upload', status: 'submitted', currentVersion: true, result: { submitted: true, saved: false, published: false, publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=123' } }] })
  const h = await harness(t, overview({ jobs: [item] }))
  assert.equal(h.s.selectedUploadStatus, 'quality_hold')
  assert.equal(h.s.uploadLabel(h.s.selectedUploadStatus), '质量问题已停发')
  assert.equal(h.s.canUploadSelected, false)
  assert.equal(h.s.canResumeSelected, false)
  assert.equal(h.s.uploadRecords[0].status, 'submitted', 'historical receipt is not a new platform observation')
  assert.match(descriptor.template.content, /以下为历史提交回执/)
})

test('delivery checks normalize producer and imported fields into rounded Chinese results', async t => {
  const item = job('first', { status: 'completed', canResume: false })
  const imported = { id: 'internal-id', title: 'Internal title', frames: 4000, fullDecode: 'passed', durationSeconds: 69.385983, maximumPauseSeconds: 0.391313, crossfadeSeconds: 0.5005000000001, closingSourceSeconds: [254.337416, 258.341416], finalFrameMeanGray: 0.0001929, final10msRmsDbFS: -112.2926025, loudnessLUFS: -15.43, truePeakDbTP: -1.8, limitations: 'Internal detail only.', importedExistingDelivery: true }
  const h = await harness(t, overview({ jobs: [item] }), { details: { first: { ...item, delivery: { duration: 69.385983, verification: imported } } } })
  const values = Object.fromEntries(h.s.verificationEntries.map(entry => [entry.label, entry.value]))
  assert.equal(h.s.isImported, true)
  assert.equal(values['完整解码'], '已通过'); assert.equal(values['旁白最长停顿'], '0.39 秒')
  assert.equal(values['片尾保留'], '4.00 秒'); assert.equal(values['片尾叠化'], '0.50 秒')
  assert.equal(values['末帧淡出'], '已通过（亮度 0.00）'); assert.equal(values['尾音淡出'], '已通过（-112.3 dBFS）')
  assert.equal(values['综合响度'], '-15.4 LUFS'); assert.equal(values['真峰值'], '-1.8 dBTP')
  assert.equal(h.s.verificationEntries.some(entry => ['frames', 'limitations', 'title', 'id'].includes(entry.label)), false)
  assert.equal(JSON.parse(h.s.verificationJson).limitations, imported.limitations)
  const current = h.s.summarizeVerification({ maxPauseSeconds: 0.123456, timing: { closingDuration: 4.001, overlapDuration: 0.499 } }, 72)
  assert.equal(current.find(entry => entry.key === 'pause').value, '0.12 秒')
  assert.equal(current.find(entry => entry.key === 'closing').value, '4.00 秒')
})

test('unmount aborts outstanding detail reads and ignores their late result', async t => {
  const h = await harness(t, overview({ jobs: [job('first')] }))
  const late = deferred()
  let capturedSignal
  h.state.get = (path, signal) => path.endsWith('/first') ? (capturedSignal = signal, late.promise) : undefined
  const request = h.s.loadDetail('first', true)
  await flush(); h.unmount()
  assert.equal(capturedSignal.aborted, true)
  late.resolve(job('first', { title: 'Late replacement' })); await request
  assert.notEqual(h.s.selectedJob.title, 'Late replacement'); assert.equal(h.timers.size, 0)
})
