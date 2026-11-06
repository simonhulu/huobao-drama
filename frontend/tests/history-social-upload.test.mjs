import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript, compileStyle, compileTemplate } from '@vue/compiler-sfc'
import { chromium } from 'playwright'

const componentUrl = new URL('../app/components/HistorySocialUpload.vue', import.meta.url)
const source = readFileSync(componentUrl, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentUrl.pathname })
assert.deepEqual(errors, [])
const compiled = compileScript(descriptor, { id: 'social-upload-test' })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const template = compileTemplate({ source: descriptor.template.content, filename: componentUrl.pathname, id: 'social-upload-test', compilerOptions: { bindingMetadata: compiled.bindings } })
assert.deepEqual(template.errors, [])
const templateModule = { exports: {} }
runInNewContext(ts.transpileModule(template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module: templateModule, exports: templateModule.exports, require: () => vue,
})
const base = '/api/v1/history-scripts/uploads'
const storageKey = 'huobao.history-social-upload.v1'
const targets = ['baijiahao-video']
const cdpTimeout = 'BrowserType.connect_over_cdp: Timeout 10000ms exceeded.\nCall log:\n  - <ws preparing> retrieving websocket url from http://127.0.0.1:9225\n  - <ws connecting> ws://127.0.0.1:9225/devtools/browser/test\n  - <ws connected> ws://127.0.0.1:9225/devtools/browser/test'
const plain = value => JSON.parse(JSON.stringify(value))
const uiBaseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const runtime = () => ({ installed: true, message: 'ready', version: 'test', platforms: {
  baijiahao: { ready: true, message: '已登录' }, tencent: { ready: true, message: '已登录' },
} })
const backgroundRuntime = () => ({ ...runtime(), execution: 'background', platforms: {
  baijiahao: { ready: false, issue: 'login_required', message: '后台账号尚未登录', sessionMode: 'background', accountName: 'history_baijiahao' },
  tencent: { ready: false, issue: 'login_required', message: '后台账号尚未登录', sessionMode: 'background', accountName: 'history_tencent' },
} })
const job = (status = 'queued', extra = {}) => ({
  id: 'job-1', sourceId: 57, sourceTitle: '明朝冬季的蔬菜供应', target: 'baijiahao-video',
  mode: 'stage', status, ...extra,
})
const result = { staged: true, saved: false, published: false, targetId: 'bound-57', editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2' }
const draftJob = (status, extra = {}) => job(status, { mode: 'draft', ...extra })
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => ({ code: status, data }) })
const uploaded = (confirmation = 'platform') => ({ status: confirmation === 'manual' ? 'saved' : 'published', confirmedAt: '2026-10-25T04:00:00.000Z', confirmation })
const allUploads = (confirmation = 'platform') => Object.fromEntries(targets.map(target => [target, uploaded(confirmation)]))
const versionKey = scriptId => `${scriptId}:current:motion`
const fixtureVersion = (scriptId, extra = {}) => ({
  key: versionKey(scriptId), scriptId, scriptSha256: 'a'.repeat(64), producer: 'motion',
  videoId: 1000 + scriptId, state: 'ready', stage: 'publication', message: '', error: null,
  action: 'publish', jobId: null, exportJobId: null, automatic: true, canPublish: true, ...extra,
})
const withVersions = candidate => ({ versions: [fixtureVersion(candidate.scriptId)], ...candidate })
const productionVersion = (producer, state = 'ready', extra = {}) => fixtureVersion(57, {
  key: `57:current:${producer}`, producer, videoId: producer === 'huasheng' ? 101 : 102,
  state, action: state === 'ready' ? 'publish' : 'none', canPublish: state === 'ready', ...extra,
})
function candidateChecks(candidates, ids, selected = targets) {
  return ids.flatMap(id => {
    const candidate = candidates.find(candidate => candidate.scriptId === id)
    return (candidate?.versions ?? [fixtureVersion(id)]).flatMap(version => selected.map(target => ({
      ...checks([id], [target])[0], videoId: version.videoId, videoProducer: version.producer,
      ...(['submitted', 'published'].includes(version.state) ? { ready: false, uploaded: { ...uploaded(), status: version.state } } : {}),
    })))
  })
}
function checks(ids, selected = targets) {
  return ids.flatMap(sourceId => selected.map(target => ({
    sourceId, sourceTitle: `项目 ${sourceId}`, videoId: 1000 + sourceId, videoProducer: 'motion', target, ready: true, blockers: [],
    engine: target === 'baijiahao-article' ? 'project-extension' : 'social-auto-upload',
  })))
}
function browser(storage = new Map()) {
  const window = new EventTarget()
  window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  return window
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
  await vue.nextTick()
}

function renderedFeedback(h) {
  const root = templateModule.exports.render({}, [], h.app._instance.props, h.s, {}, {})
  const result = { visible: '', technical: '', advanced: '', details: [], moreOperations: [], buttons: [], links: [], rows: [], submitFeedback: null }
  function visit(node, channel = 'visible') {
    if (typeof node === 'string' || typeof node === 'number') { result[channel] += node; return }
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child, channel); return }
    if (node.type === 'button') result.buttons.push(node)
    if (node.type === 'a') result.links.push(node)
    if (node.type === 'li' && node.props?.class === 'queue-row') result.rows.push(node)
    if (node.props?.class === 'submit-feedback') result.submitFeedback = node
    if (node.type === 'details') {
      if (node.props?.class === 'technical-details') { result.details.push(node); channel = 'technical' }
      else { if (node.props?.class === 'more-actions') result.moreOperations.push(node); channel = 'advanced' }
    }
    visit(node.children, channel)
  }
  visit(root)
  return result
}

function buttonText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(buttonText).join('')
  return node && typeof node === 'object' ? buttonText(node.children) : ''
}

async function expireRequest(h, expectedTimeoutMs = 60_000) {
  const deadlines = [...h.timers].filter(([, timer]) => timer.delay !== 3000)
  assert.equal(deadlines.length, 1, 'An in-flight request has one finite deadline, separate from queue polling')
  const [id, timer] = deadlines[0]
  assert.equal(timer.delay, expectedTimeoutMs, 'The request uses the deadline appropriate to its server work')
  h.timers.delete(id)
  await timer.fn()
  await flush()
}

async function harness(t, options = {}) {
  const storage = options.storage || new Map()
  const window = options.window || browser(storage)
  const state = {
    runtime: runtime(), jobs: [], candidates: [{ scriptId: 57, title: '明朝冬季的蔬菜供应' }, { scriptId: 58, title: '另一个很长的历史项目标题'.repeat(12) }],
    queue: { paused: false, reason: null, jobId: null }, requests: [], route: null, preflight: null, beforeEnqueue: null, receipts: new Map(), ...options.state,
  }
  state.candidates = state.candidates.map(withVersions)
  const timers = new Map()
  let clockMs = 0
  let sequence = 0
  let requestSequence = 0
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, window, CustomEvent, AbortController, URL, URLSearchParams,
    crypto: { randomUUID: () => `request-${++requestSequence}` },
    require(id) {
      if (id === 'vue') return vue
      if (id === 'lucide-vue-next') return Object.fromEntries(['ArrowDown', 'CircleAlert', 'CircleCheck', 'ClipboardCheck', 'ExternalLink', 'LoaderCircle', 'LogIn', 'RefreshCw', 'Save', 'Upload', 'X'].map(name => [name, {}]))
      throw new Error(`Unexpected import: ${id}`)
    },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay, at: clockMs + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    async fetch(url, init) {
      const parsed = new URL(url, 'http://fixture')
      const entry = { url, path: parsed.pathname.slice(base.length), query: parsed.searchParams, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal }
      state.requests.push(entry)
      const overridden = await state.route?.(entry)
      if (overridden !== undefined) return overridden
      if (entry.method === 'GET' && entry.path === '/runtime') return reply(structuredClone(state.runtime))
      if (entry.method === 'POST' && entry.path === '/runtime/login') return reply({ opened: true })
      if (entry.method === 'POST' && entry.path === '/runtime/sync') return reply({ synced: true, platform: entry.body.platform, message: '登录已同步到后台' })
      if (entry.method === 'GET' && entry.path === '/candidates') return reply({ items: structuredClone(state.candidates) })
      if (entry.method === 'GET' && entry.path === '/jobs') {
        let jobs = state.jobs
        if (entry.query.has('sourceId')) jobs = jobs.filter(item => Number(item.sourceId) === Number(entry.query.get('sourceId')))
        if (entry.query.has('requestId')) jobs = jobs.filter(item => item.requestId === entry.query.get('requestId') || state.receipts.get(entry.query.get('requestId'))?.includes(item.id))
        return reply({ jobs: structuredClone(jobs), queue: structuredClone(state.queue), ...(jobs.length && entry.query.has('requestId') ? { requestId: entry.query.get('requestId') } : {}) })
      }
      if (entry.method === 'GET' && /^\/jobs\/[^/]+$/.test(entry.path)) {
        const item = state.jobs.find(item => String(item.id) === entry.path.split('/')[2])
        return reply({ job: structuredClone(item), queue: structuredClone(state.queue) })
      }
      if (entry.method === 'GET' && entry.path === '/preflight') return reply({ mode: entry.query.get('mode'), items: state.preflight ?? candidateChecks(state.candidates, entry.query.get('sourceIds').split(',').map(Number), entry.query.get('targets').split(',')).filter(item => entry.query.get('videoIds').split(',').map(Number).includes(item.videoId)) })
      if (entry.method === 'POST' && entry.path === '/jobs') {
        state.beforeEnqueue?.(entry)
        const items = (state.preflight ?? candidateChecks(state.candidates, entry.body.sourceIds, entry.body.targets)).filter(item => entry.body.sourceIds.includes(item.sourceId) && entry.body.videoIds.includes(item.videoId) && entry.body.targets.includes(item.target))
        const jobs = items.filter(item => !item.uploaded).map((item, index) => job(item.ready ? 'queued' : 'blocked', { id: `job-${state.jobs.length + index + 1}`, sourceId: item.sourceId, sourceTitle: item.sourceTitle, target: item.target, mode: entry.body.mode, videoId:item.videoId, videoProducer:item.videoProducer, blockers: item.blockers, message: item.blockers.map(issue => issue.message).join('；') }))
        state.jobs.push(...jobs)
        state.receipts.set(entry.body.requestId, jobs.map(item => item.id))
        return reply({ requestId: entry.body.requestId, jobs, items }, 202)
      }
      if (entry.method === 'POST' && entry.path === '/jobs/reupload') {
        const jobs = [], skipped = []
        for (const id of entry.body.jobIds) {
          const item = state.jobs.find(item => String(item.id) === id)
          if (!item || !['blocked', 'failed', 'uncertain'].includes(item.status)) { skipped.push({ id, message: '任务已在处理或已完成' }); continue }
          item.status = 'queued'
          jobs.push(structuredClone(item))
        }
        return reply({ jobs, queue: state.queue, skipped })
      }
      const retry = entry.path.match(/^\/jobs\/([^/]+)\/reupload$/)
      if (entry.method === 'POST' && retry) {
        const item = state.jobs.find(item => String(item.id) === decodeURIComponent(retry[1]))
        if (!item || !['blocked', 'failed', 'uncertain'].includes(item.status)) return { ok: false, status: 409, json: async () => ({ code: 409, message: '任务已在处理或已完成' }) }
        item.status = 'queued'
        return reply({ job: structuredClone(item), queue: state.queue })
      }
      const match = entry.path.match(/^\/jobs\/([^/]+)\/(confirm|cancel|open)$/)
      if (entry.method === 'POST' && match) {
        const item = state.jobs.find(item => item.id === decodeURIComponent(match[1]))
        if (match[2] === 'open') return reply({ opened: true })
        item.status = match[2] === 'confirm' ? 'completed' : 'canceled'
        return reply({ job: structuredClone(item) })
      }
      throw new Error(`Unexpected request ${entry.method} ${url}`)
    },
  })
  const component = module.exports.default
  component.render = () => null
  const renderer = vue.createRenderer({
    createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setElementText() {}, setText() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(component, options.props ?? { scriptId: 57 })
  app.mount({})
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    app.unmount()
    assert.equal(timers.size, 0, 'Unmount clears owned background polling')
  }
  t.after(close)
  await flush()
  return {
    s: app._instance.setupState, state, app, timers, storage, window, close,
    mutations: () => state.requests.filter(entry => entry.method === 'POST'),
    async advance(ms) {
      const until = clockMs + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        clockMs = timer.at
        timers.delete(id)
        timer.fn()
        await flush()
      }
      clockMs = until
      await flush()
    },
    async tick() {
      assert.equal(timers.size, 1, 'Only one queue poll is scheduled')
      const [id, timer] = [...timers][0]
      timers.delete(id)
      await timer.fn()
      await flush()
    },
  }
}

// Exercise the real Nuxt route without starting/restarting services. All API calls,
// including unknown mutations and links opened in new tabs, stay inside this mock.
async function uiHarness(t, options = {}) {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 960 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  await page.clock.install()
  const state = { runtime: backgroundRuntime(), jobs: [], candidates: [{ scriptId: 57, title: '明朝冬季的蔬菜供应' }, { scriptId: 58, title: '宋代粮食供应' }], requests: [], route: null, ...options.state }
  state.candidates = state.candidates.map(withVersions)
  const unexpected = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) {
      if (url.origin === new URL(uiBaseUrl).origin) return route.continue()
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>模拟平台草稿箱</p>' })
    }
    const entry = { path: url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname,
      method: request.method(), query: url.searchParams, body: request.postData() ? request.postDataJSON() : undefined }
    state.requests.push(entry)
    const overridden = await state.route?.(entry, route)
    if (overridden === true) return
    if (overridden !== undefined) return route.fulfill(overridden)
    let data
    if (entry.method === 'GET' && entry.path === '/runtime') data = state.runtime
    else if (entry.method === 'GET' && entry.path === '/jobs') data = { jobs: state.jobs.filter(item => (!entry.query.has('sourceId') || Number(item.sourceId ?? item.scriptId) === Number(entry.query.get('sourceId'))) && (!entry.query.has('requestId') || item.requestId === entry.query.get('requestId'))), queue: { paused: false, reason: null, jobId: null } }
    else if (entry.method === 'GET' && /^\/jobs\/[^/]+$/.test(entry.path)) data = { job: state.jobs.find(item => String(item.id) === entry.path.split('/')[2]) }
    else if (entry.method === 'GET' && entry.path === '/candidates') data = { items: state.candidates }
    else if (entry.method === 'GET' && entry.path === '/preflight') data = { items: candidateChecks(state.candidates, entry.query.get('sourceIds').split(',').map(Number), entry.query.get('targets').split(',')).filter(item => entry.query.get('videoIds').split(',').map(Number).includes(item.videoId)) }
    else if (entry.method === 'POST' && entry.path === '/runtime/login') data = { opened: true }
    else if (entry.method === 'POST' && entry.path === '/runtime/sync') {
      state.runtime.platforms[entry.body.platform] = { ...state.runtime.platforms[entry.body.platform], ready: true, message: '后台账号已就绪' }
      data = { synced: true, platform: entry.body.platform, message: '登录已同步到后台' }
    } else if (entry.method === 'POST' && entry.path === '/jobs') {
      const items = candidateChecks(state.candidates, entry.body.sourceIds, entry.body.targets).filter(item => entry.body.videoIds.includes(item.videoId))
      const jobs = items.filter(item => !item.uploaded).map((item, index) => job('queued', { id: `new-${state.jobs.length + index}`, sourceId: item.sourceId, sourceTitle: item.sourceTitle, videoId: item.videoId, videoProducer: item.videoProducer, target: item.target, requestId: entry.body.requestId, mode: entry.body.mode }))
      state.jobs.push(...jobs)
      for (const candidate of state.candidates) for (const version of candidate.versions ?? []) {
        if (entry.body.videoIds.includes(version.videoId)) { version.state = 'queued'; version.canPublish = false }
      }
      data = { jobs, items, requestId: entry.body.requestId }
    } else if (entry.method === 'POST' && (entry.path === '/jobs/reupload' || /^\/jobs\/[^/]+\/reupload$/.test(entry.path))) {
      const batch = entry.path === '/jobs/reupload'
      const ids = batch ? entry.body.jobIds : [entry.path.split('/')[2]]
      const jobs = state.jobs.filter(item => ids.includes(item.id))
      jobs.forEach(item => { item.status = 'queued' })
      data = batch ? { jobs, skipped: [] } : { job: jobs[0] }
    } else if (entry.method === 'POST' && /^\/jobs\/[^/]+\/open$/.test(entry.path)) data = { opened: true }
    else if (entry.method === 'GET' && entry.path === '/api/v1/history-scripts') data = { items: options.libraryItems ?? [], total: options.libraryItems?.length ?? 0 }
    else if (entry.method === 'GET' && entry.path === '/api/v1/history-scripts/jobs') data = { job: null, recent: [], total: 0, hasMore: false }
    else if (entry.method === 'GET' && entry.path === '/api/v1/history-scripts/browser-session') data = { session: { status: 'ready', canCollect: true, checks: [] } }
    else if (entry.method === 'GET' && entry.path === '/api/v1/history-scripts/huasheng') data = { enabled: false, browser: { status: 'ready', message: 'mock' }, jobs: [] }
    else if (entry.method === 'GET' && ['/api/v1/history-scripts/huasheng/exports', '/api/v1/history-scripts/motion/jobs'].includes(entry.path)) data = { enabled: false, jobs: [] }
    else if (entry.method === 'GET' && /^\/api\/v1\/history-scripts\/\d+\/continuation$/.test(entry.path)) data = { task: null, complete: false }
    else if (entry.method === 'GET' && /^\/api\/v1\/history-scripts\/\d+\/huasheng$/.test(entry.path)) data = { jobs: [], productionChecking: false }
    else if (entry.method === 'GET' && /^\/api\/v1\/history-scripts\/\d+\/delivery$/.test(entry.path)) data = {
      title: '已保存的封面', baijiahaoTitle: '已保存的百家号标题', description: '', covers: {},
      coverStatus: 'idle', coverPlanStatus: 'missing', coverPlan: null, designStatus: 'idle', designRunId: null,
      coverDesign: { main_title: '已保存的封面', sub_title: '', kicker: '', ai_prompt: '历史场景' },
    }
    else if (entry.method === 'GET' && /^\/api\/v1\/history-scripts\/\d+$/.test(entry.path)) {
      const scriptId = Number(entry.path.split('/').at(-1)), candidate = state.candidates.find(item => item.scriptId === scriptId)
      data = { id: scriptId, title: candidate?.title || `稿件 ${scriptId}`, rewrittenScript: '已经保存的当前正文。', revision: 'current-revision', metricsJson: '{}', mediaJson: '{}', selectionJson: '{}' }
    }
    else {
      unexpected.push(`${entry.method} ${entry.path}`)
      return route.fulfill({ status: 404, json: { code: 404, message: '未定义的模拟接口' } })
    }
    return route.fulfill({ json: { code: 200, data: structuredClone(data) } })
  })
  const candidatesLoaded = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/candidates`, { timeout: 30_000 })
  await page.goto(`${uiBaseUrl}${options.path || '/history-scripts?view=uploads'}`, { waitUntil: 'domcontentloaded' })
  const panel = page.locator('.social-upload')
  await panel.getByText('运行环境就绪', { exact: false }).waitFor()
  await candidatesLoaded
  await panel.getByText('正在读取视频版本…', { exact: true }).waitFor({ state: 'hidden' })
  await panel.getByRole('button', { name: '刷新上传状态', exact: true }).waitFor()
  t.after(() => { assert.deepEqual(unexpected, [], 'Every real-page API request must be mocked'); assert.deepEqual(errors, [], 'Nuxt must render without uncaught errors') })
  return { page, context, panel, state, mutations: () => state.requests.filter(entry => entry.method !== 'GET') }
}

test('Nuxt UI: #127 row login recovery is visible on mobile and retains the original task', async t => {
  const h = await uiHarness(t, { viewport: { width: 390, height: 844 }, state: {
    runtime: { ...runtime(), execution: 'background' }, jobs: [job('blocked', {
      id: '127', mode: 'draft', message: '百家号需要完成登录或安全验证',
      blockers: [{ code: 'platform_not_ready', field: 'runtime', message: '百家号需要完成登录或安全验证' }],
    })],
  } })
  const row = h.panel.locator('.queue-row')
  const open = row.getByRole('button', { name: '打开百家号登录窗口', exact: true })
  const sync = row.getByRole('button', { name: '同步登录', exact: true })
  assert.equal(await open.isVisible(), true)
  assert.equal(await sync.isVisible(), true)
  assert.doesNotMatch(await row.innerText(), /缺少素材|补齐.*材/)
  assert.equal(h.mutations().length, 0)
  await Promise.all([
    h.page.waitForResponse(response => new URL(response.url()).pathname === `${base}/runtime`),
    open.click(),
  ])
  await sync.click()
  await h.panel.getByText('登录已同步到后台', { exact: true }).waitFor()
  await h.page.clock.runFor(60_000)
  assert.equal(await row.getAttribute('data-status'), 'blocked')
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [
    ['/runtime/login', { platform: 'baijiahao' }], ['/runtime/sync', { platform: 'baijiahao' }],
  ])
  await row.getByRole('button', { name: '重新上传', exact: true }).click()
  await h.panel.locator('.queue-row[data-status="queued"]').waitFor()
  assert.equal(await row.count(), 1)
  assert.equal(h.state.jobs[0].id, '127')
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login', '/runtime/sync', '/jobs/127/reupload'])
  assert.equal(h.context.pages().length, 1)
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
})

test('select-all and individual selection enforce the 100-project request limit without hiding older candidates', async t => {
  const candidates = Array.from({ length: 103 }, (_, index) => ({ scriptId: index + 1, title: `项目 ${index + 1}` }))
  const h = await harness(t, { props: {}, state: { candidates } })
  h.s.candidateFilter = 'ready'
  assert.equal(h.s.filteredCandidates.length, 103)
  h.s.toggleAllCandidates()
  assert.equal(h.s.projectIds.length, 100)
  assert.equal(h.s.allCandidatesSelected, true)
  h.s.toggleVersion(versionKey(101))
  assert.equal(h.s.projectIds.length, 100)
  await h.s.submit('draft')
  assert.equal(h.mutations()[0].body.sourceIds.length, 100)
  h.s.toggleAllCandidates()
  h.s.candidateSearch = '#103'
  await flush()
  h.s.toggleAllCandidates()
  assert.deepEqual(plain(h.s.projectIds), [103])
  assert.equal(h.s.selectedVersions.length, 1)
})

test('restored completed selections are removed from the pending view without submitting', async t => {
  const storage = new Map([[storageKey, JSON.stringify({ targets, selectedVersionKeys: [versionKey(57), versionKey(58)], jobs: [], requests: [], actions: {} })]])
  const h = await harness(t, { props: {}, storage, state: { candidates: [{ scriptId: 57, title: '已完成', versions: [fixtureVersion(57, { state: 'submitted', canPublish: false })] }, { scriptId: 58, title: '可发表' }] } })
  assert.deepEqual(plain(h.s.projectIds), [58])
  assert.deepEqual(JSON.parse(storage.get(storageKey)).selectedVersionKeys, [versionKey(58)])
  assert.equal(h.mutations().length, 0)
})

for (const reusedSavedJob of [false, true]) {
  test(`enqueue discovering all uploaded accepts ${reusedSavedJob ? 'a reused saved job' : 'an empty job list'} without retransmission`, async t => {
    const h = await harness(t)
    h.state.route = entry => {
      if (entry.method !== 'POST' || entry.path !== '/jobs') return
      const items = checks([57]).map(item => ({ ...item, ready: false, uploaded: uploaded() }))
      h.state.candidates[0].versions = [fixtureVersion(57, { state: 'published', canPublish: false })]
      return reply({ items, jobs: reusedSavedJob ? [job('published', { requestId: entry.body.requestId })] : [] })
    }
    await h.s.submit('draft')
    assert.equal(h.s.pendingRequests.length, 0)
    assert.equal(h.s.actionError, '')
    if (!reusedSavedJob) assert.match(renderedFeedback(h).submitFeedback.children, /无需重复提交/)
    await h.s.submit('draft')
    assert.equal(h.mutations().length, 1)
  })
}

test('lost empty enqueue receipt is reconciled using uploaded items and GET only', async t => {
  const h = await harness(t)
  h.state.route = entry => {
    if (entry.path !== '/jobs') return
    if (entry.method === 'POST') throw new Error('回执丢失')
    if (entry.query.has('requestId')) return reply({ requestId: entry.query.get('requestId'), jobs: [], items: checks([57]).map(item => ({ ...item, ready: false, uploaded: uploaded() })) })
  }
  await h.s.submit('draft')
  await flush()
  assert.equal(h.s.pendingRequests.length, 0)
  assert.equal(h.s.actionError, '')
  assert.match(h.s.submitMessage, /无需重复提交/)
  assert.equal(h.mutations().length, 1)
  assert.equal(h.timers.size, 0)
})

test('publication transition refreshes the authoritative inventory and survives remount', async t => {
  const h = await harness(t, { props: {}, state: { jobs: [job('running')], candidates: [{ scriptId: 57, title: '完成后自动标记' }] } })
  h.s.toggleTarget('baijiahao-article')
  h.s.toggleTarget('tencent-video')
  h.s.toggleVersion(versionKey(57))
  h.state.jobs[0].status = 'published'
  h.state.candidates[0].versions = [fixtureVersion(57, { state: 'published', canPublish: false })]
  await h.tick()
  await flush()
  assert.equal(h.state.requests.filter(entry => entry.path === '/candidates').length, 2)
  assert.deepEqual(plain(h.s.filteredCandidates), [])
  assert.deepEqual(plain(h.s.projectIds), [])
  h.s.candidateFilter = 'published'
  await flush()
  assert.equal(h.s.filteredCandidates.length, 1)
  const state = { candidates: h.state.candidates, jobs: h.state.jobs }
  h.close()
  const restored = await harness(t, { props: {}, state, storage: h.storage })
  assert.equal(restored.s.filteredCandidates.length, 0)
  restored.s.candidateFilter = 'published'
  await flush()
  assert.equal(restored.s.filteredCandidates.length, 1)
  assert.equal(restored.mutations().length, 0)
})

test('manual uploaded marking is removed and cannot turn a historical draft into a submitted edition', async t => {
  const h = await harness(t, { state: { candidates: [{ scriptId: 57, title: '旧草稿', uploads: allUploads('manual'), versions: [fixtureVersion(57, { state: 'attention', canPublish: false, action: 'retry_packaging' })] }] } })
  assert.equal(h.s.markUploaded, undefined)
  assert.equal(h.s.canSubmit, false)
  assert.equal(h.s.candidateCounts.attention, 1)
  assert.doesNotMatch(renderedFeedback(h).visible, /标记已上传/)
  assert.equal(h.mutations().length, 0)
})

test('SFC template/styles compile with accessible controls and bounded mobile reflow', () => {
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: componentUrl.pathname, id: 'social-upload-test', compilerOptions: { bindingMetadata: compiled.bindings } }).errors, [])
  assert.deepEqual(compileStyle({ source: descriptor.styles[0].content, filename: componentUrl.pathname, id: 'social-upload-test', scoped: true }).errors, [])
  assert.match(source, /已选 \{\{ selectedVersions.length \}\} 个版本/)
  assert.match(source, /scope="col"/)
  assert.match(source, /:focus-visible/)
  assert.match(source, /min-height: 42px/)
  assert.match(source, /prefers-reduced-motion/)
  assert.doesNotMatch(source, /:href=".*editor/)
})

test('background runtime exposes explicit account synchronization only for the new execution mode', async t => {
  for (const health of [runtime(), { ...runtime(), platforms: backgroundRuntime().platforms }]) {
    const legacy = await harness(t, { state: { runtime: health } })
    assert.doesNotMatch(renderedFeedback(legacy).visible, /后台上传|同步百家号登录|同步视频号登录/)
    await legacy.s.syncLogin('baijiahao')
    assert.equal(legacy.mutations().length, 0)
  }
  const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job()] } })
  const view = renderedFeedback(h)
  assert.match(view.visible, /后台上传/)
  assert.match(view.visible, /视频版本/)
  assert.equal(view.buttons.some(node => buttonText(node) === '仅上传预览'), false)
  const openLogin = view.buttons.find(node => buttonText(node) === '打开百家号登录窗口')
  assert.match(openLogin.props.title, /原专用 Chrome/)
  assert.match(view.visible, /复用原百家号登录/)
  assert.doesNotMatch(view.visible, /history_baijiahao|history_tencent/)
  assert.equal(view.buttons.filter(node => /^同步(百家号|视频号)登录$/.test(buttonText(node))).length, 1)
  await h.tick()
  await h.s.refresh()
  await h.s.syncLogin('unknown')
  assert.equal(h.mutations().length, 0, 'Neither polling, refresh nor an invalid platform synchronizes or opens a window')
  h.state.runtime = { ...runtime(), execution: 'background' }
  await h.s.loadRuntime()
  assert.equal(renderedFeedback(h).buttons.filter(node => /^同步(百家号|视频号)登录$/.test(buttonText(node))).length, 1, 'Per-platform session metadata is optional, including for ready accounts')
})

test('background login window remains accessible while uploads block runtime checks and synchronization', async t => {
  const health = backgroundRuntime()
  for (const platform of ['baijiahao']) {
    health.platforms[platform] = { ready: false, issue: 'check_failed', message: '上传或登录同步正在运行，请完成后重新检查或同步；本次未改变账号' }
  }
  const h = await harness(t, { state: { runtime: health,
    queue: { paused: false, runningJobId: 'other' }, jobs: [],
  } })
  for (const [platform, name] of [['baijiahao', '百家号']]) {
    const view = renderedFeedback(h)
    const open = view.buttons.find(node => buttonText(node) === `打开${name}登录窗口`)
    assert.ok(open, `Opening ${name}'s original Chrome must not disappear behind retry connection`)
    assert.equal(open.props.disabled, false)
    assert.equal(view.buttons.find(node => buttonText(node) === `同步${name}登录`).props.disabled, true)
    await open.props.onClick()
    assert.deepEqual(h.mutations().at(-1).body, { platform })
  }
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login'])
  h.state.runtime = { ...runtime(), execution: 'background' }
  await h.s.loadRuntime()
  assert.equal(renderedFeedback(h).buttons.filter(node => /^打开(百家号|视频号)登录窗口$/.test(buttonText(node))).length, 1)
  await h.s.openLogin('baijiahao')
  assert.equal(h.mutations().length, 2, 'A healthy background session also retains an explicit way to open its original visible Chrome')
})

test('temporary background connection failure can enqueue all draft targets after a queue-ready preflight', async t => {
  const health = backgroundRuntime()
  for (const platform of ['baijiahao']) Object.assign(health.platforms[platform], {
    issue: 'connection_failed', message: '后台浏览器连接超时，已保留原登录，请重试连接',
  })
  const prepared = checks([57]).map(item => ({ ...item, warnings: ['后台检查暂未完成，排队后将重新检查，通过后才上传'] }))
  const h = await harness(t, { state: { runtime: health, preflight: prepared } })
  await h.s.submit('draft')
  assert.equal(h.s.visibleJobs.length, 1)
  assert.ok(h.s.visibleJobs.every(item => item.status === 'queued'))
  assert.equal(h.s.runtime.platforms.baijiahao.ready, false, 'Queue readiness cannot fabricate a successful login check')
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs'])
  assert.match(renderedFeedback(h).visible, /排队后将重新检查/)
})

test('exhausted background connection retries explain retrying the original task without asking for login', async t => {
  const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job('failed', {
    message: '后台浏览器连接超时，已保留原登录，请重试连接',
    blockers: [{ code: 'runtime_check_pending', field: 'runtime', message: '后台浏览器连接超时' }],
    recovery: { attempts: 2, maxAttempts: 2, action: null, nextAttemptAt: null },
  })] } })
  const row = buttonText(renderedFeedback(h).rows[0])
  assert.match(row, /连接正常后点击“重新上传”/)
  assert.doesNotMatch(row, /打开百家号登录窗口|完成登录或安全验证/)
  assert.match(row, /重新上传/)
})

test('a prefixed publish connection failure can continue its original job while another upload blocks login sync', async t => {
  const reason = '后台浏览器连接失败或响应超时，尚未检查登录状态；已保留原登录，请重试连接'
  const health = backgroundRuntime()
  health.platforms.baijiahao = { ready: false, issue: 'check_failed',
    message: '该账号的上传或登录同步正在运行，请完成后重新检查或同步；本次未改变账号' }
  const h = await harness(t, { props: { scriptId: 35 }, state: { runtime: health, queue: { paused: false, runningJobId: '228' },
    jobs: [job('failed', { id: '245', sourceId: 35, mode: 'publish', error: reason,
      message: `上传失败，请点击“重新上传”从头上传：${reason}`,
      blockers: [{ code: 'runtime_check_pending', field: 'runtime', message: reason }],
    })],
  } })
  const view = renderedFeedback(h), row = buttonText(view.rows[0])
  assert.doesNotMatch(row, /打开百家号登录窗口|完成登录或安全验证|同步登录后/)
  assert.match(row, /后台浏览器连接.*继续原任务.*不代表登录过期/)
  const retry = view.buttons.find(node => buttonText(node) === '继续原任务')
  assert.ok(retry)
  assert.equal(retry.props.disabled, false)
  await retry.props.onClick()
  await flush()
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/245/reupload'])
  assert.equal(h.s.visibleJobs[0].id, '245')
  assert.equal(h.s.visibleJobs[0].status, 'queued')
})

test('explicit sync deduplicates clicks, refreshes runtime and keeps login opening separate', async t => {
  for (const platform of ['baijiahao']) {
    const h = await harness(t, { state: { runtime: backgroundRuntime() } })
    await h.s.openLogin(platform)
    assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login'])
    let release
    h.state.route = entry => entry.path === '/runtime/sync' ? new Promise(resolve => { release = resolve }) : undefined
    const pending = h.s.syncLogin(platform)
    await flush()
    assert.equal(h.s.syncPlatform, platform)
    assert.equal(h.s.canSubmit, false)
    assert.match(renderedFeedback(h).visible, /正在同步后台账号登录状态/)
    assert.ok(renderedFeedback(h).buttons.filter(node => /^同步(百家号|视频号)登录$/.test(buttonText(node))).every(node => node.props.disabled))
    await h.s.syncLogin(platform)
    await h.s.syncLogin(platform === 'tencent' ? 'baijiahao' : 'tencent')
    await h.s.openLogin(platform)
    assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/runtime/login', { platform }], ['/runtime/sync', { platform }]])
    h.state.runtime.platforms[platform] = { ...h.state.runtime.platforms[platform], ready: true, message: '后台账号已就绪' }
    const count = h.state.requests.length
    release(reply({ synced: true, platform, message: '专用窗口登录已同步' }))
    await pending
    assert.deepEqual(h.state.requests.slice(count).map(entry => [entry.method, entry.path]), [['GET', '/runtime']])
    assert.equal(h.s.runtime.platforms[platform].ready, true)
    assert.equal(h.s.syncMessage, '专用窗口登录已同步')
    assert.equal(h.s.syncError, '')
    assert.equal(h.s.syncPlatform, '')
    assert.equal(h.s.canSubmit, true)
  }
})

test('sync failures and malformed acknowledgements show the cause and allow an explicit retry', async t => {
  const cases = [
    [{ ok: false, status: 409, json: async () => ({ code: 409, message: '视频号专用窗口尚未完成扫码，请先完成登录' }) }, '视频号专用窗口尚未完成扫码，请先完成登录'],
    [reply({ synced: false, platform: 'tencent' }), '登录同步结果未确认'],
    [reply({ synced: true, platform: 'baijiahao' }), '登录同步结果未确认'],
  ]
  for (const [response, reason] of cases) {
    const h = await harness(t, { state: { runtime: backgroundRuntime() } })
    h.state.route = entry => entry.path === '/runtime/sync' ? response : undefined
    await h.s.syncLogin('tencent')
    assert.ok(renderedFeedback(h).visible.includes(reason))
    assert.equal(h.s.syncPlatform, '')
    assert.equal(h.s.busy, false)
    assert.equal(h.s.syncMessage, '')
    await h.s.refresh()
    assert.equal(h.mutations().length, 1)
    h.state.route = null
    await h.s.syncLogin('tencent')
    assert.equal(h.s.syncError, '')
    assert.equal(h.mutations().length, 2)
  }
})

test('sync timeout releases the lock even while runtime refresh stalls and never repeats POST', async t => {
  const h = await harness(t, { state: { runtime: backgroundRuntime() } })
  h.state.route = entry => ['/runtime', '/runtime/sync'].includes(entry.path) ? new Promise(() => {}) : undefined
  const pending = h.s.syncLogin('baijiahao')
  await flush()
  await expireRequest(h, 90_000)
  assert.equal(h.s.syncPlatform, '')
  assert.equal(h.s.busy, false)
  assert.match(renderedFeedback(h).visible, /同步登录超时/)
  await expireRequest(h, 90_000)
  await pending
  assert.equal(h.s.refreshing, false)
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/sync'])
  h.state.route = null
  await h.s.refresh()
  await h.s.syncLogin('baijiahao')
  assert.equal(h.mutations().length, 2)
})

test('unmount aborts synchronization without late messages or refreshing runtime', async t => {
  const h = await harness(t, { state: { runtime: backgroundRuntime() } })
  let release
  h.state.route = entry => entry.path === '/runtime/sync' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = h.s.syncLogin('tencent')
  await flush()
  const entry = h.state.requests.at(-1)
  h.close()
  release(reply({ synced: true, platform: 'tencent', message: 'late' }))
  await pending
  assert.equal(entry.signal.aborted, true)
  assert.equal(h.state.requests.at(-1), entry)
  assert.equal(h.s.syncMessage, '')
})

test('background uncertain job retries the original job without creating another submission', async t => {
  const h = await harness(t, { state: { jobs: [job('uncertain', { result: { ...result, accountName: 'history_baijiahao' } })] } })
  assert.match(renderedFeedback(h).visible, /处理上述原因后.*重新上传/)
  await h.s.retryJob(h.s.visibleJobs[0])
  await h.s.retryJob(h.s.visibleJobs[0])
  await h.tick()
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/job-1/reupload'])
  assert.equal(h.s.visibleJobs.length, 1)
  assert.match(renderedFeedback(h).visible, /排队中/)
})

test('single project mounts read-only with three targets selected and reads uploaded markers', async t => {
  const h = await harness(t)
  assert.deepEqual(plain(h.s.projectIds), [57])
  assert.deepEqual(plain(h.s.selectedTargets), targets)
  assert.equal(h.s.canSubmit, true)
  assert.deepEqual(h.state.requests.map(entry => [entry.method, entry.url]), [['GET', `${base}/runtime?refresh=true`], ['GET', `${base}/jobs?sourceId=57`], ['GET', `${base}/candidates`]])
  assert.equal(h.mutations().length, 0)
})

test('global picker defaults to no projects and keeps the complete queue visible after selection', async t => {
  const h = await harness(t, { props: {}, state: { jobs: [job('completed'), job('failed', { id: 'other', sourceId: 99 })] } })
  assert.equal(h.s.globalMode, true)
  assert.deepEqual(plain(h.s.projectIds), [])
  assert.equal(h.s.canSubmit, false)
  assert.equal(h.s.visibleJobs.length, 2)
  assert.ok(h.state.requests.some(entry => entry.path === '/candidates'))
  h.s.toggleVersion(versionKey(58))
  assert.deepEqual(plain(h.s.projectIds), [58])
  assert.equal(h.s.projects[0].title, h.state.candidates[1].title)
  assert.equal(h.s.visibleJobs.length, 2)
  assert.equal(h.s.canSubmit, true)
  await h.s.refresh()
  assert.equal(h.state.requests.filter(entry => entry.path === '/jobs').every(entry => !entry.query.has('sourceId')), true)
  assert.equal(h.mutations().length, 0)
})

test('merged and restored queue keeps latest submissions first and displays recorded times', async t => {
  const storage = new Map()
  const oldest = job('saved', { id: '7', createdAt: '2026-10-22T11:00:00.000Z', updatedAt: '2026-10-22T11:05:00.000Z' })
  const first = await harness(t, { props: {}, storage, state: { jobs: [oldest] } })
  const latest = job('queued', { id: '10', createdAt: '2026-10-23T11:15:12.929Z', updatedAt: '2026-10-23T11:15:12.929Z' })
  const sameBatch = job('queued', { id: '9', sourceId: 99, createdAt: latest.createdAt, updatedAt: latest.updatedAt })
  first.state.jobs = [latest, sameBatch, oldest]
  await first.s.refresh()
  assert.deepEqual(plain(first.s.visibleJobs.map(item => item.id)), ['10', '9', '7'], 'New tasks must precede older cached records, with numeric IDs ordering one batch')
  first.state.jobs[2] = { ...oldest, updatedAt: '2026-10-23T12:00:00.000Z' }
  await first.s.refresh()
  assert.deepEqual(plain(first.s.visibleJobs.map(item => item.id)), ['10', '9', '7'], 'Progress updates do not change submission order')
  const visible = renderedFeedback(first).visible
  assert.match(visible, /提交时间/)
  assert.match(visible, /草稿保存确认/)
  assert.match(visible, /2026/)
  assert.ok(visible.includes(first.s.formatJobTime(latest.createdAt)))
  assert.ok(visible.includes(first.s.formatJobTime(first.state.jobs[2].updatedAt)))
  first.close()
  const restored = await harness(t, { storage, state: { jobs: first.state.jobs } })
  assert.deepEqual(plain(restored.s.visibleJobs.map(item => item.id)), ['10', '7'], 'Project filtering and cached restoration preserve newest-first order')
  assert.equal(restored.mutations().length, 0)
})

test('options and global selection survive remount without submitting', async t => {
  const storage = new Map()
  const first = await harness(t, { props: {}, storage })
  first.s.toggleVersion(versionKey(57))
  for (const target of targets) first.s.toggleTarget(target)
  assert.equal(first.s.canSubmit, false)
  first.close()
  const second = await harness(t, { props: {}, storage })
  assert.deepEqual(plain(second.s.projectIds), [57])
  assert.deepEqual(plain(second.s.selectedTargets), targets)
  assert.equal(second.s.canSubmit, true)
  assert.equal(second.mutations().length, 0)
})

test('explicit batch prop deduplicates valid project IDs and reads candidate markers', async t => {
  const h = await harness(t, { props: { scriptIds: [57, 58, 57, -1, 1.5] } })
  assert.deepEqual(plain(h.s.projectIds), [57, 58])
  await h.s.checkPreflight()
  const entry = h.state.requests.find(entry => entry.path === '/preflight')
  assert.equal(entry.method, 'GET')
  assert.equal(entry.body, undefined)
  assert.equal(entry.query.get('sourceIds'), '57,58')
  assert.equal(entry.query.get('targets'), targets.join(','))
  assert.equal(entry.query.get('mode'), 'publish')
  assert.equal(entry.query.get('refreshRuntime'), 'true', 'Explicit preflight must bypass cached platform readiness')
  assert.equal(h.s.projects.length, 2)
  assert.equal(h.s.readyCount, 2)
  assert.equal(h.mutations().length, 0)
})

for (const mode of ['stage', 'draft']) {
  test(`${mode} preflights then persists an idempotency receipt before the only enqueue POST`, async t => {
    const h = await harness(t)
    h.state.beforeEnqueue = entry => {
      const stored = JSON.parse(h.storage.get(storageKey))
      assert.equal(stored.requests[0].requestId, entry.body.requestId)
      assert.equal(entry.body.mode, mode)
      assert.deepEqual(entry.body.sourceIds, [57])
      assert.equal(entry.body.scriptIds, undefined)
    }
    await h.s.submit(mode)
    assert.deepEqual(h.state.requests.filter(entry => ['/preflight', '/jobs'].includes(entry.path)).slice(-2).map(entry => [entry.method, entry.path]), [['GET', '/preflight'], ['POST', '/jobs']])
    assert.equal(h.state.requests.find(entry => entry.path === '/preflight').query.get('mode'), mode)
    assert.equal(h.s.visibleJobs.length, 1)
    assert.equal(h.s.pendingRequests.length, 0)
    assert.equal(h.mutations().some(entry => /publish|confirm/.test(entry.path)), false)
  })
}

for (const scenario of ['blocked', 'missing item', 'contradictory']) {
  test(`${scenario} preflight cannot enqueue`, async t => {
    const items = checks([57])
    if (scenario === 'blocked') for (const item of items) { item.ready = false; item.blockers = [{ message: '缺少成片', field: 'video' }] }
    if (scenario === 'missing item') items.pop()
    if (scenario === 'contradictory') items[0].blockers = [{ message: '缺少封面', field: 'cover' }]
    const h = await harness(t, { state: { preflight: items } })
    await h.s.submit('draft')
    assert.equal(h.mutations().length, 0)
    assert.equal(h.s.submittingMode, '')
    if (scenario === 'blocked') assert.equal(h.s.blockedCount, 1)
    else assert.match(h.s.preflightError, /不完整|缺少/)
  })
}

test('missing installation disables submission but cached login readiness does not, and runtime failures remain visible', async t => {
  const h = await harness(t)
  h.state.runtime.installed = false
  await h.s.refresh()
  await h.s.submit('draft')
  assert.equal(h.s.canSubmit, false)
  h.state.runtime = runtime()
  h.state.runtime.platforms.baijiahao.ready = false
  h.state.runtime.platforms.tencent.ready = false
  await h.s.refresh()
  assert.equal(h.s.canSubmit, true, 'An installed environment permits an explicit fresh preflight')
  h.state.runtime = runtime()
  await h.s.refresh()
  assert.equal(h.s.canSubmit, true)
  h.state.route = entry => { if (entry.path === '/runtime') throw new Error('登录状态读取失败') }
  await h.s.refresh()
  assert.equal(h.s.runtime, null)
  assert.equal(h.s.canSubmit, false)
  assert.match(h.s.runtimeError, /登录状态读取失败/)
  assert.equal(h.mutations().length, 0)
})

for (const ready of [true, false]) {
  test(`${ready ? 'ready' : 'blocked'} preflight displays cover warnings without treating them as missing assets`, async t => {
    const warning = '封面方案已修改，本次沿用已有封面图片'
    const missing = ready ? [] : ['百家号登录已过期，请重新登录']
    const items = checks([61], ['baijiahao-video']).map(item => ({
      ...item, ready, warnings: [warning], blockers: missing.map(message => ({ message })),
    }))
    const h = await harness(t, { props: { scriptId: 61 }, state: { preflight: items, candidates: [{ scriptId: 61, title: '封面复用' }] } })
    await h.s.submit('draft')
    const check = h.s.projects[0].checks['baijiahao-video']
    assert.deepEqual(plain(check.warnings), [warning])
    assert.deepEqual(plain(check.missing), missing)
    assert.equal(h.s.readyCount, ready ? 1 : 0)
    assert.equal(h.s.blockedCount, ready ? 0 : 1)
    assert.equal(h.s.preflightError, '')
    const view = renderedFeedback(h)
    assert.ok(view.visible.includes(warning), 'Non-blocking cover advice remains visible for both ready and blocked checks')
    assert.ok(!view.submitFeedback.children.includes(warning), 'Advice is not listed as a reason this attempt could not upload')
    assert.equal(h.mutations().length, ready ? 1 : 0, 'Only readiness controls the write; warnings do not prevent ready work')
  })
}

test('disabled upload controls explain missing projects, targets and installed environment beside the buttons', async t => {
  const h = await harness(t, { props: {} })
  assert.equal(h.s.canSubmit, false)
  assert.match(renderedFeedback(h).submitFeedback?.children || '', /选择.*版本/)
  h.s.toggleVersion(versionKey(57))
  for (const target of targets) h.s.toggleTarget(target)
  assert.equal(h.s.canSubmit, false)
  assert.match(renderedFeedback(h).submitFeedback?.children || '', /选择.*平台/)
  h.s.toggleTarget('baijiahao-video')
  h.state.runtime.installed = false
  h.state.runtime.message = '上传运行环境尚未安装'
  await h.s.refresh()
  assert.equal(h.s.canSubmit, false)
  assert.match(renderedFeedback(h).submitFeedback?.children || '', /上传运行环境尚未安装/)
  await h.s.submit('draft')
  assert.equal(h.mutations().length, 0)
})

for (const stalled of ['fetch', 'body']) {
  test(`stalled preflight ${stalled} times out, prevents double-clicks and ignores late results before an explicit retry`, async t => {
    const h = await harness(t)
    let release
    h.state.route = entry => {
      if (entry.path !== '/preflight') return
      const pending = new Promise(resolve => { release = resolve })
      return stalled === 'fetch' ? pending : { ok: true, status: 200, json: () => pending }
    }
    let settled = false
    const pending = h.s.submit('draft').then(() => { settled = true })
    await flush()
    const entry = h.state.requests.at(-1)
    assert.equal(h.s.busy, true)
    assert.equal(h.s.canSubmit, false)
    await h.s.submit('stage')
    assert.equal(h.state.requests.filter(entry => entry.path === '/preflight').length, 1)
    await expireRequest(h, 90_000)
    assert.equal(settled, true, 'Timeout settles even when the fake network ignores abort')
    await pending
    assert.equal(entry.signal.aborted, true)
    assert.equal(h.s.busy, false)
    assert.equal(h.s.canSubmit, true)
    assert.equal(h.s.report, null)
    assert.match(h.s.preflightError, /超时/)
    assert.match(renderedFeedback(h).submitFeedback?.children || '', /此次未上传.*超时/)
    assert.equal(h.s.pendingRequests.length, 0)
    assert.equal(h.mutations().length, 0)
    assert.equal(h.timers.size, 0)
    const data = { items: checks([57]) }
    release(stalled === 'fetch' ? reply(data) : { code: 200, data })
    await flush()
    assert.equal(h.s.report, null, 'Late ready results cannot authorize an upload')
    assert.equal(h.mutations().length, 0)
    h.state.route = null
    await h.s.submit('draft')
    assert.equal(h.mutations().length, 1)
  })
}

test('enqueue timeout releases the busy lock even if receipt lookup stalls and preserves GET-only recovery', async t => {
  const h = await harness(t)
  let release
  h.state.route = entry => {
    if (entry.path !== '/jobs') return
    return new Promise(resolve => { if (entry.method === 'POST') release = resolve })
  }
  let settled = false
  const pending = h.s.submit('draft').then(() => { settled = true })
  await flush()
  const entry = h.mutations()[0]
  assert.ok(entry)
  await h.s.submit('draft')
  assert.equal(h.mutations().length, 1)
  await expireRequest(h, 90_000)
  assert.equal(h.s.busy, false, 'A stalled recovery GET does not hold the submission spinner')
  assert.equal(entry.signal.aborted, true)
  assert.equal(h.s.canSubmit, false, 'The durable unknown receipt still blocks a duplicate upload')
  assert.match(h.s.actionError, /超时.*正在读取服务端结果/)
  assert.match(renderedFeedback(h).submitFeedback?.children || '', /正在读取上次提交结果/)
  assert.equal(JSON.parse(h.storage.get(storageKey)).requests[0].requestId, entry.body.requestId)
  await h.s.submit('draft')
  await expireRequest(h)
  assert.equal(settled, true)
  await pending
  assert.equal(h.s.queueLoading, false)
  assert.match(h.s.queueError, /超时/)
  release(reply({ requestId: entry.body.requestId, jobs: [job('saved', { requestId: entry.body.requestId })] }))
  await flush()
  assert.equal(h.s.pendingRequests.length, 1, 'Late mutation replies do not overwrite recovery state')
  h.state.route = null
  h.state.jobs = [job('saved', { requestId: entry.body.requestId })]
  await h.tick()
  assert.equal(h.s.pendingRequests.length, 0)
  assert.equal(h.s.canSubmit, true)
  assert.equal(h.s.visibleJobs[0].status, 'saved')
  assert.equal(h.mutations().length, 1)
})

for (const path of ['/runtime', '/candidates', '/jobs']) {
  test(`stalled ${path} mount request has a visible deadline and never starts a platform action`, async t => {
    const h = await harness(t, { props: {}, state: { route: entry => entry.path === path ? new Promise(() => {}) : undefined } })
    const entry = h.state.requests.find(entry => entry.path === path)
    assert.equal(h.s.refreshing, true)
    await expireRequest(h, path === '/runtime' ? 90_000 : 60_000)
    assert.equal(entry.signal.aborted, true)
    assert.equal(h.s.refreshing, false)
    assert.match(renderedFeedback(h).visible, /超时/)
    assert.equal(h.timers.size, 0, 'Timed out status reads do not auto-refresh platforms')
    assert.equal(h.mutations().length, 0)
    h.state.route = null
    await h.s.refresh()
    h.s.toggleVersion(versionKey(57))
    assert.equal(h.s.canSubmit, true)
    assert.equal(h.mutations().length, 0)
  })
}

test('stalled explicit login releases its lock after timeout without reopening the platform', async t => {
  const health = runtime()
  health.platforms.tencent.ready = false
  const h = await harness(t, { state: { runtime: health } })
  h.state.route = entry => entry.path === '/runtime/login' ? new Promise(() => {}) : undefined
  const pending = h.s.openLogin('tencent')
  await flush()
  await expireRequest(h, 90_000)
  await pending
  assert.equal(h.s.loginPlatform, '')
  assert.equal(h.s.busy, false)
  assert.equal(h.s.canSubmit, true)
  assert.match(h.s.loginError, /超时/)
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login'])
  assert.equal(h.timers.size, 0)
})

const browserRequests = [
  ['GET', '/runtime'],
  ['GET', '/runtime?refresh=true'],
  ['POST', '/runtime/login'],
  ['POST', '/runtime/sync'],
  ['GET', '/preflight?sourceIds=57&targets=tencent-video&mode=draft&refreshRuntime=true'],
  ['POST', '/preflight'],
  ['POST', '/jobs'],
  ['POST', '/jobs/57/open'],
  ['POST', '/jobs/57/confirm'],
]

for (const [method, path] of browserRequests) {
  test(`${method} ${path}: browser-dependent request accepts a 70s response and aborts a stalled retry at 90s`, async t => {
    const h = await harness(t)
    let release
    h.state.route = () => new Promise(resolve => { release = resolve })
    const count = h.state.requests.length
    let outcome
    const pending = h.s.request(path, method, method === 'POST' ? {} : undefined).then(
      value => { outcome = { value } }, error => { outcome = { error } },
    )
    await flush()
    const entry = h.state.requests.at(-1)
    await h.advance(60_000)
    assert.equal(outcome, undefined, 'The ordinary 60s deadline must not terminate browser work')
    assert.equal(entry.signal.aborted, false)
    await h.advance(10_000)
    release(reply({ finished: true }))
    await pending
    assert.deepEqual(plain(outcome), { value: { finished: true } })
    assert.equal(h.timers.size, 0, 'Successful response clears its remaining deadline')
    assert.equal(h.state.requests.length, count + 1, 'Waiting never starts another request')

    outcome = undefined
    const stalled = h.s.request(path, method, method === 'POST' ? {} : undefined).then(
      value => { outcome = { value } }, error => { outcome = { error } },
    )
    await flush()
    const stalledEntry = h.state.requests.at(-1)
    await h.advance(89_999)
    assert.equal(outcome, undefined)
    assert.equal(stalledEntry.signal.aborted, false)
    await h.advance(1)
    await stalled
    assert.equal(stalledEntry.signal.aborted, true)
    assert.match(outcome.error.message, /超时/)
    assert.equal(h.timers.size, 0)
    release(reply({ finished: true }))
    await flush()
    assert.match(outcome.error.message, /超时/, 'Late responses cannot replace the timeout result')
    assert.equal(h.state.requests.length, count + 2, 'Timeout does not replay the request')
  })
}

for (const [method, path] of [
  ['GET', '/jobs'],
  ['GET', '/jobs?sourceId=57'],
  ['GET', '/jobs?requestId=request-1'],
  ['GET', '/jobs/57'],
  ['GET', '/candidates'],
  ['POST', '/jobs/57/cancel'],
  ['POST', '/jobs/57/reupload'],
  ['POST', '/jobs/reupload'],
]) {
  test(`${method} ${path}: ordinary request still aborts at 60s without retrying`, async t => {
    const h = await harness(t)
    const count = h.state.requests.length
    h.state.route = () => new Promise(() => {})
    let outcome
    const pending = h.s.request(path, method, method === 'POST' ? {} : undefined).then(
      value => { outcome = { value } }, error => { outcome = { error } },
    )
    await flush()
    const entry = h.state.requests.at(-1)
    await h.advance(59_999)
    assert.equal(outcome, undefined)
    assert.equal(entry.signal.aborted, false)
    await h.advance(1)
    await pending
    assert.equal(entry.signal.aborted, true)
    assert.match(outcome.error.message, /超时/)
    assert.equal(h.timers.size, 0)
    assert.equal(h.state.requests.length, count + 1)
  })
}

test('runtime accepts readiness at 70s while a stalled queue read reports its own 60s deadline', async t => {
  const h = await harness(t)
  let release
  h.state.route = entry => entry.path === '/runtime' ? new Promise(resolve => { release = resolve })
    : entry.path === '/jobs' ? new Promise(() => {}) : undefined
  const pending = h.s.refresh()
  await flush()
  await h.advance(60_000)
  assert.equal(h.s.queueLoading, false)
  assert.match(h.s.queueError, /超时/)
  assert.equal(h.s.runtimeLoading, true)
  assert.equal(h.s.runtimeError, '')
  await h.advance(10_000)
  release(reply(runtime()))
  await pending
  assert.equal(h.s.runtimeLoading, false)
  assert.equal(h.s.runtime.platforms.baijiahao.ready, true)
  assert.equal(h.s.runtime.platforms.tencent.ready, true)
  assert.equal(h.timers.size, 0)
  assert.equal(h.mutations().length, 0)
})

test('browser response body shares the 90s deadline with headers instead of starting a fresh wait', async t => {
  const h = await harness(t)
  let headers, body
  h.state.route = () => new Promise(resolve => { headers = resolve })
  const pending = h.s.loadRuntime()
  await flush()
  const entry = h.state.requests.at(-1)
  await h.advance(70_000)
  assert.equal(entry.signal.aborted, false)
  headers({ ok: true, status: 200, json: () => new Promise(resolve => { body = resolve }) })
  await flush()
  assert.equal(typeof body, 'function')
  await h.advance(19_999)
  assert.equal(h.s.runtimeLoading, true)
  await h.advance(1)
  await pending
  assert.equal(h.s.runtimeLoading, false)
  assert.equal(entry.signal.aborted, true)
  assert.match(h.s.runtimeError, /超时/)
  body({ code: 200, data: runtime() })
  await flush()
  assert.equal(h.s.runtime, null)
  assert.equal(h.timers.size, 0)
})

test('slow focus/open times out at 90s, releases the action lock, and does not repeat the action', async t => {
  const h = await harness(t, { state: { jobs: [job('saved', { result })] } })
  let release
  h.state.route = entry => entry.path.endsWith('/open') ? new Promise(resolve => { release = resolve }) : undefined
  const pending = h.s.openJob(h.s.visibleJobs[0])
  await flush()
  await h.advance(60_000)
  assert.equal(h.s.jobAction, 'open:job-1')
  assert.equal(h.s.actionError, '')
  await h.s.openJob(h.s.visibleJobs[0])
  assert.equal(h.mutations().length, 1)
  await h.advance(30_000)
  await pending
  assert.equal(h.s.jobAction, '')
  assert.match(h.s.actionError, /超时/)
  release(reply({ opened: true }))
  await flush()
  assert.match(h.s.actionError, /超时/)
  assert.equal(h.mutations().length, 1)
  assert.equal(h.timers.size, 0)
})

for (const platform of ['baijiahao']) {
  for (const issue of ['connection_failed', 'check_failed']) {
    test(`${platform} ${issue} offers a single connection recheck without opening login or uploading`, async t => {
      const health = runtime()
      health.platforms[platform] = { ready: false, issue, message: issue === 'connection_failed' ? cdpTimeout : 'RuntimeError: failed to inspect browser session' }
      const h = await harness(t, { state: { runtime: health } })
      const view = renderedFeedback(h)
      const button = view.buttons.find(node => buttonText(node) === '重试连接')
      assert.ok(button, 'Connection failures need a retry action instead of a login action')
      assert.equal(view.buttons.some(node => /登录|验证/.test(buttonText(node))), false)
      assert.doesNotMatch(view.visible, /BrowserType|RuntimeError|ws:\/\//)
      assert.ok(view.technical.includes(health.platforms[platform].message))
      assert.ok(view.details.every(node => !node.props?.open))
      const count = h.state.requests.length
      await h.s.openLogin(platform)
      assert.equal(h.mutations().length, 0, 'A connection issue must never be treated as a login requirement')
      let release
      h.state.route = entry => entry.path === '/runtime' ? new Promise(resolve => { release = resolve }) : undefined
      const pending = button.props.onClick()
      await flush()
      assert.equal(h.s.runtimeLoading, true)
      assert.match(renderedFeedback(h).visible, /正在检查运行环境/)
      assert.equal(renderedFeedback(h).buttons.some(node => buttonText(node) === '重试连接'), false)
      release(reply(health))
      await pending
      await flush()
      assert.deepEqual(h.state.requests.slice(count).map(entry => [entry.method, entry.path, entry.query.get('refresh')]), [['GET', '/runtime', 'true']])
      assert.equal(h.mutations().length, 0)
      assert.equal(h.timers.size, 0, 'A failed check never schedules browser polling or another check')
      assert.ok(renderedFeedback(h).buttons.some(node => buttonText(node) === '重试连接'), 'Failure leaves an explicit retry available')
      h.state.route = null
      h.state.runtime.platforms[platform] = { ready: true, message: '已登录' }
      await renderedFeedback(h).buttons.find(node => buttonText(node) === '重试连接').props.onClick()
      await flush()
      assert.equal(h.s.runtime.platforms[platform].ready, true)
      assert.equal(renderedFeedback(h).buttons.some(node => buttonText(node) === '重试连接'), false)
      assert.equal(h.mutations().length, 0)
    })
  }
}

for (const [issue, label] of [
  ['login_required', '登录百家号'],
  ['verification_required', '验证百家号'],
  ['browser_unavailable', '打开百家号浏览器'],
  [undefined, '登录百家号'],
]) {
  test(`runtime ${issue || 'legacy without issue'} keeps the explicit browser/login entry`, async t => {
    const health = runtime()
    health.platforms.baijiahao = { ready: false, message: '', ...(issue ? { issue } : {}) }
    const h = await harness(t, { state: { runtime: health } })
    const button = renderedFeedback(h).buttons.find(node => buttonText(node) === label)
    assert.ok(button, `Expected ${label}`)
    assert.equal(h.mutations().length, 0)
    await button.props.onClick()
    await flush()
    assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/runtime/login', { platform: 'baijiahao' }]])
    assert.equal(h.timers.size, 0)
  })
}

test('legacy CDP timeout keeps a read-only retry path without requiring the new issue field', async t => {
  const health = runtime()
  health.platforms.baijiahao = { ready: false, message: cdpTimeout }
  const h = await harness(t, { state: { runtime: health } })
  const button = renderedFeedback(h).buttons.find(node => buttonText(node) === '重试连接')
  assert.ok(button)
  await button.props.onClick()
  await flush()
  assert.equal(h.mutations().length, 0)
  assert.equal(h.state.requests.filter(entry => entry.path === '/runtime').length, 2)
  assert.equal(h.timers.size, 0)
})

for (const failure of ['request', 'installation', 'platform', 'login']) {
  test(`runtime ${failure} errors translate CDP timeouts and keep raw details collapsed`, async t => {
    const health = runtime()
    if (failure === 'installation') { health.installed = false; health.message = cdpTimeout }
    if (failure === 'platform') health.platforms.baijiahao = { ready: false, issue: 'connection_failed', message: cdpTimeout }
    if (failure === 'login') health.platforms.baijiahao = { ready: false, issue: 'browser_unavailable', message: '本机浏览器未启动' }
    const h = await harness(t, { state: { runtime: health, route: entry => {
      if (entry.path === (failure === 'request' ? '/runtime' : failure === 'login' ? '/runtime/login' : 'unused')) throw new Error(cdpTimeout)
    } } })
    if (failure === 'login') await h.s.openLogin('baijiahao')
    const view = renderedFeedback(h)
    assert.match(view.visible, /本机浏览器连接超时.*不代表登录过期/)
    assert.doesNotMatch(view.visible, /BrowserType|10000ms|127\.0\.0\.1|ws:\/\//)
    assert.ok(view.technical.includes(cdpTimeout))
    assert.ok(view.details.length > 0)
    assert.ok(view.details.every(node => !node.props?.open))
    assert.equal(h.timers.size, 0)
  })
}

test('runtime non-timeout English errors stay in technical details', async t => {
  const raw = 'RuntimeError: failed to inspect browser session\n  at inspect_platform.py:42'
  const h = await harness(t, { state: { route: entry => { if (entry.path === '/runtime') throw new Error(raw) } } })
  const view = renderedFeedback(h)
  assert.doesNotMatch(view.visible, /RuntimeError|inspect_platform/)
  assert.ok(view.technical.includes(raw))
  assert.ok(view.details.every(node => !node.props?.open))
  assert.equal(h.mutations().length, 0)
})

test('login only opens an explicitly requested unready platform, then refreshes with GET only', async t => {
  const health = runtime()
  health.platforms.baijiahao.ready = false
  const h = await harness(t, { state: { runtime: health } })
  await h.s.refresh()
  assert.equal(h.mutations().length, 0, 'Loading and refreshing never open login automatically')
  await h.s.openLogin('tencent')
  await h.s.openLogin('unknown')
  assert.equal(h.mutations().length, 0, 'Ready and unknown platforms have no login command')
  let release
  h.state.route = entry => entry.path === '/runtime/login' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = h.s.openLogin('baijiahao')
  await flush()
  assert.equal(h.s.loginPlatform, 'baijiahao')
  assert.equal(h.s.busy, true)
  assert.equal(h.s.canSubmit, false)
  await h.s.openLogin('baijiahao')
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/runtime/login', { platform: 'baijiahao' }]])
  const beforeRefresh = h.state.requests.length
  h.state.runtime.platforms.baijiahao.ready = true
  release(reply({ opened: true }))
  await pending
  assert.equal(h.s.loginPlatform, '')
  assert.equal(h.s.loginError, '')
  assert.equal(h.s.runtime.platforms.baijiahao.ready, true)
  assert.ok(h.state.requests.length > beforeRefresh)
  assert.ok(h.state.requests.slice(beforeRefresh).every(entry => entry.method === 'GET'))
  assert.match(source, /v-if="!platform.ready &&/)
  assert.match(source, /<LogIn v-else/)
  assert.match(source, /登录\{\{ platform.name \}\}/)
  assert.match(source, /:aria-busy="loginPlatform === platform.id"/)
})

test('login failure is visible and never retries POST during read-only refresh', async t => {
  const health = runtime()
  health.platforms.tencent.ready = false
  const h = await harness(t, { state: { runtime: health } })
  h.state.route = entry => { if (entry.path === '/runtime/login') throw new Error('无法打开视频号登录窗口') }
  await h.s.openLogin('tencent')
  assert.equal(h.s.loginPlatform, '')
  assert.match(h.s.loginError, /无法打开视频号登录窗口/)
  assert.equal(h.mutations().length, 1)
  assert.deepEqual(h.mutations()[0].body, { platform: 'tencent' })
  assert.ok(h.state.requests.slice(h.state.requests.indexOf(h.mutations()[0]) + 1).every(entry => entry.method === 'GET'))
  await h.s.refresh()
  assert.equal(h.mutations().length, 1)
  assert.match(h.s.loginError, /无法打开视频号登录窗口/)
})

test('missing runtime cannot open login and late login completion after unmount does not refresh', async t => {
  const health = runtime()
  health.installed = false
  health.platforms.baijiahao.ready = false
  const h = await harness(t, { state: { runtime: health } })
  await h.s.openLogin('baijiahao')
  assert.equal(h.mutations().length, 0)
  h.state.runtime.installed = true
  await h.s.refresh()
  let release
  h.state.route = entry => entry.path === '/runtime/login' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = h.s.openLogin('baijiahao')
  await flush()
  h.close()
  const requestCount = h.state.requests.length
  release(reply({ opened: true }))
  await pending
  assert.equal(h.state.requests.length, requestCount)
  assert.equal(h.timers.size, 0)
})

test('single-project list shows a global pause even when the blocking job is outside its filter', async t => {
  const h = await harness(t, { state: { jobs: [job('awaiting_confirmation', { id: '1', sourceId: 99, result })], queue: { paused: true, reason: 'awaiting_confirmation', jobId: '1' } } })
  assert.equal(h.s.visibleJobs.length, 0)
  assert.equal(h.s.queuePauseMessage, '队列暂停：任务 #1 等待保存草稿')
  assert.equal(h.s.globalMode, false)
  assert.match(source, /v-if="!globalMode"[^>]*href="\/history-scripts\?view=uploads"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
  assert.match(source, /class="queue-pause warning" role="status"/)
  h.state.queue = { paused: true, reason: 'uncertain', jobId: '2' }
  await h.tick()
  assert.equal(h.s.queuePauseMessage, '队列暂停：任务 #2 发表结果待核对，请继续原任务')
  h.state.queue = { paused: false, reason: null, jobId: null }
  await h.tick()
  assert.equal(h.s.queuePauseMessage, '')
  assert.equal(h.timers.size, 0)
  assert.equal(h.mutations().length, 0)
})

test('pause cause remains global regardless of selected projects and retains its last valid state on GET failure', async t => {
  const h = await harness(t, { props: {}, state: { queue: { paused: true, reason: 'uncertain', jobId: '1' } } })
  h.s.toggleVersion(versionKey(58))
  assert.equal(h.s.queuePauseMessage, '队列暂停：任务 #1 发表结果待核对，请继续原任务')
  h.state.route = entry => { if (entry.path === '/jobs') throw new Error('queue unavailable') }
  await h.tick()
  assert.equal(h.s.queuePauseMessage, '队列暂停：任务 #1 发表结果待核对，请继续原任务')
  assert.match(h.s.queueError, /queue unavailable/)
  h.state.route = null
  h.state.queue = { paused: false, reason: null, jobId: null }
  await h.tick()
  assert.equal(h.s.queuePauseMessage, '')
  assert.equal(h.mutations().length, 0)
})

test('lost enqueue reply reconciles a committed request using only GET and never repeats the enqueue', async t => {
  const h = await harness(t)
  h.state.route = entry => {
    if (entry.method === 'POST' && entry.path === '/jobs') {
      h.state.jobs = [job('running', { requestId: entry.body.requestId })]
      throw new Error('connection lost')
    }
  }
  await h.s.submit('draft')
  assert.equal(h.s.pendingRequests.length, 0)
  assert.equal(h.s.visibleJobs[0].status, 'running')
  await h.tick()
  assert.equal(h.mutations().length, 1)
  assert.equal(h.state.requests.at(-1).method, 'GET')
})

test('simple draft policy: batch reupload sends only failed targets in the current scope', async t => {
  const h = await harness(t, { props: { scriptIds: [71, 70] }, state: { jobs: [
    draftJob('failed', { id: '1', sourceId: 71 }), draftJob('uncertain', { id: '2', sourceId: 70 }),
    draftJob('blocked', { id: '3', sourceId: 99 }), draftJob('saved', { id: '4', sourceId: 71 }),
    draftJob('queued', { id: '5', sourceId: 70 }), draftJob('running', { id: '6', sourceId: 71 }),
  ] } })
  await renderedFeedback(h).buttons.find(node => /^发表失败（/.test(buttonText(node))).props.onClick()
  const batch = renderedFeedback(h).buttons.find(node => buttonText(node) === '批量重新上传（2）')
  assert.ok(batch)
  await batch.props.onClick()
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/jobs/reupload', { jobIds: ['2', '1'] }]])
  assert.match(renderedFeedback(h).visible, /已接受 2 项重新上传/)
})

test('simple draft policy: material and login failures show their specific next action', async t => {
  const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [draftJob('blocked', {
    message: '自动恢复失败，需要处理原编辑页',
    blockers: [{ code: 'asset_missing', field: 'covers.3:4', message: '缺少 3:4 封面' },
      { code: 'platform_not_ready', field: 'runtime', message: '百家号需要完成安全验证' }],
  })] } })
  const view = renderedFeedback(h)
  assert.match(view.visible, /缺少 3:4 封面/)
  assert.match(view.visible, /百家号需要完成安全验证/)
  assert.ok(view.links.some(node => buttonText(node) === '查看并补齐材料'))
  assert.ok(view.buttons.some(node => buttonText(node) === '打开百家号登录窗口'))
  assert.ok(view.buttons.some(node => buttonText(node) === '同步登录'))
  assert.match(view.visible, /同步登录后点击“重新上传”/)
  assert.doesNotMatch(view.visible, /无需重新提交|恢复失败/)
})

test('default submission uses publication mode and retains an explicit preflight', async t => {
  const h = await harness(t)
  const view = renderedFeedback(h)
  assert.equal(view.buttons.some(node => buttonText(node) === '仅上传预览'), false)
  await view.buttons.find(node => buttonText(node) === '预检素材').props.onClick()
  assert.equal(h.state.requests.at(-1).query.get('mode'), 'publish')
  await view.buttons.find(node => buttonText(node) === '发表所选版本（1）').props.onClick()
  assert.deepEqual(h.mutations().map(entry => entry.body.mode), ['publish'])
})

test('simple draft policy: pending retry transport locks duplicate uploads until a fresh job read', async t => {
  const storage = new Map()
  const h = await harness(t, { storage, state: { jobs: [draftJob('failed')] } })
  h.state.route = () => new Promise(() => {})
  const pending = h.s.retryJob(h.s.visibleJobs[0])
  await flush()
  await h.advance(60_000)
  assert.equal(h.s.jobAction, '')
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '重新上传').props.disabled, true)
  await h.s.retryJob(h.s.visibleJobs[0])
  await h.s.retryFailedJobs()
  assert.equal(h.mutations().length, 1)
  await h.advance(60_000)
  await pending
  h.close()
  const next = await harness(t, { storage, state: { jobs: [draftJob('failed')], route: entry => {
    if (entry.path === '/jobs') throw new Error('offline')
  } } })
  assert.equal(renderedFeedback(next).buttons.find(node => buttonText(node) === '重新上传').props.disabled, true)
  await next.s.retryJob(next.s.visibleJobs[0])
  assert.equal(next.mutations().length, 0)
  next.state.route = null
  await next.s.loadJobs()
  assert.equal(renderedFeedback(next).buttons.find(node => buttonText(node) === '重新上传').props.disabled, false)
})

test('simple draft policy: a polling read during reupload cannot clear its pending transport lock', async t => {
  const h = await harness(t, { state: { jobs: [draftJob('failed')] } })
  let release
  h.state.route = entry => {
    if (entry.path === '/jobs/job-1/reupload') return new Promise(resolve => { release = resolve })
  }
  const pending = h.s.retryJob(h.s.visibleJobs[0])
  await flush()
  await h.s.loadJobs()
  assert.equal(h.s.pendingActions['job-1'], 'retry')
  await h.s.retryFailedJobs()
  await h.s.submit('draft')
  assert.equal(h.mutations().length, 1)
  release(reply({ job: draftJob('queued'), queue: h.state.queue }))
  await pending
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.equal(h.s.visibleJobs[0].status, 'queued')
})

test('an unresolved receipt survives remount, selection changes, and GET polling with no retransmission', async t => {
  const storage = new Map()
  const first = await harness(t, { storage })
  first.state.route = entry => { if (entry.path === '/jobs' && entry.method === 'POST') throw new Error('uncertain') }
  await first.s.submit('stage')
  assert.equal(first.s.pendingRequests.length, 1)
  assert.equal(first.s.canSubmit, false)
  await first.s.submit('draft')
  assert.equal(first.mutations().length, 1)
  assert.ok(first.state.requests.some(entry => entry.method === 'GET' && entry.query.has('requestId')))
  first.close()
  const second = await harness(t, { props: {}, storage })
  second.s.toggleVersion(versionKey(58))
  assert.equal(second.s.visibleRequests.length, 1)
  assert.equal(second.s.canSubmit, false)
  await second.tick()
  assert.equal(second.mutations().length, 0)
  second.state.jobs = [job('saved', { requestId: second.s.pendingRequests[0].requestId })]
  await second.tick()
  assert.equal(second.s.pendingRequests.length, 0)
  assert.equal(second.s.visibleJobs[0].status, 'saved')
  assert.equal(second.s.canSubmit, true)
})

test('malformed successful enqueue reply keeps a durable pending receipt and only GET reconciliation', async t => {
  const h = await harness(t)
  h.state.route = entry => entry.path === '/jobs' && entry.method === 'POST' ? { ok: true, status: 200, json: async () => { throw new Error('bad json') } } : undefined
  await h.s.submit('draft')
  assert.equal(h.s.pendingRequests.length, 1)
  assert.equal(h.s.canSubmit, false)
  await h.tick()
  assert.equal(h.mutations().length, 1)
  assert.match(h.s.actionError, /响应不完整/)
})

test('queue polling is GET-only, retains the last valid result on failure, and stops at terminal states', async t => {
  const h = await harness(t, { state: { jobs: [job('running')] } })
  h.state.route = entry => { if (entry.path === '/jobs') throw new Error('offline') }
  await h.tick()
  assert.equal(h.s.visibleJobs[0].status, 'running')
  assert.match(h.s.queueError, /offline/)
  h.state.route = null
  h.state.jobs[0].status = 'saved'
  await h.tick()
  assert.equal(h.s.visibleJobs[0].status, 'saved')
  assert.equal(h.timers.size, 0)
  assert.equal(h.mutations().length, 0)
})

test('stage confirmation saves the bound job once and opens it only through the focus endpoint', async t => {
  const item = job('awaiting_confirmation', { result })
  const h = await harness(t, { state: { jobs: [item] } })
  assert.equal(h.mutations().length, 0)
  await h.s.openJob(h.s.visibleJobs[0])
  await renderedFeedback(h).buttons.find(node => buttonText(node) === '保存草稿').props.onClick()
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/jobs/job-1/open', {}], ['/jobs/job-1/confirm', {}]])
  assert.equal(h.s.visibleJobs[0].status, 'saved')
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.equal(h.mutations().some(entry => entry.path === '/jobs'), false)
})

test('jobs without a bound result cannot open or confirm an empty editor', async t => {
  const h = await harness(t, { state: { jobs: [job('awaiting_confirmation')] } })
  await h.s.openJob(h.s.visibleJobs[0])
  await h.s.confirmJob(h.s.visibleJobs[0])
  assert.equal(h.mutations().length, 0)
  assert.equal(h.s.platformHome('baijiahao-article'), 'https://baijiahao.baidu.com/builder/rc/home')
  assert.equal(h.s.platformHome('tencent-video'), 'https://channels.weixin.qq.com/platform')
})

test('uncertain confirm is never replayed, including after refresh, until GET reports saved', async t => {
  const h = await harness(t, { state: { jobs: [job('awaiting_confirmation', { result })] } })
  h.state.route = entry => { if (entry.path.endsWith('/confirm')) throw new Error('save receipt lost') }
  await h.s.confirmJob(h.s.visibleJobs[0])
  assert.equal(h.s.pendingActions['job-1'], 'confirm')
  await h.s.confirmJob(h.s.visibleJobs[0])
  await h.tick()
  assert.equal(h.mutations().length, 1)
  h.state.jobs[0].status = 'saved'
  await h.tick()
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.equal(h.s.visibleJobs[0].status, 'saved')
})

test('draft reupload persists its request and displays success only after the server saves it', async t => {
  const h = await harness(t, { state: { jobs: [draftJob('failed', { result: null })] } })
  let release
  h.state.route = entry => {
    if (entry.path === '/jobs/job-1/reupload') {
      assert.equal(JSON.parse(h.storage.get(storageKey)).actions['job-1'], 'retry')
      return new Promise(resolve => { release = resolve })
    }
  }
  const pending = h.s.retryJob(h.s.visibleJobs[0])
  await flush()
  assert.equal(h.s.jobAction, 'retry:job-1')
  assert.equal(h.s.canSubmit, false)
  await h.s.retryJob(h.s.visibleJobs[0])
  await h.s.submit('draft')
  assert.equal(h.mutations().length, 1)
  h.state.jobs[0] = draftJob('queued', { result: null })
  release(reply({ job: h.state.jobs[0], queue: h.state.queue }))
  await pending
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.match(renderedFeedback(h).visible, /排队中/)
  assert.doesNotMatch(renderedFeedback(h).visible, /草稿已保存/)
  h.state.jobs[0] = draftJob('completed', { result: { ...result, saved: true } })
  await h.tick()
  assert.equal(h.s.visibleJobs[0].status, 'saved')
  assert.match(renderedFeedback(h).visible, /查看百家号草稿/)
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/job-1/reupload'])
})

test('only queued jobs can be cancelled', async t => {
  const h = await harness(t, { state: { jobs: [job()] } })
  for (const status of ['running', 'awaiting_confirmation', 'saved', 'blocked', 'failed', 'uncertain', 'cancelled']) await h.s.cancelJob(job(status, { result }))
  assert.equal(h.mutations().length, 0)
  await h.s.cancelJob(h.s.visibleJobs[0])
  assert.equal(h.mutations().length, 1)
  assert.equal(h.mutations()[0].path, '/jobs/job-1/cancel')
  assert.equal(h.s.visibleJobs[0].status, 'cancelled')
})

for (const status of ['blocked', 'failed', 'uncertain']) {
  test(`${status} has an explicit retry action, persists intent, and only requeues the original job`, async t => {
    const h = await harness(t, { props: { scriptId: 71 }, state: { jobs: [job(status, { id: '71', sourceId: 71, mode: 'draft', result: status === 'uncertain' ? result : null })] } })
    const label = '重新上传'
    const button = renderedFeedback(h).buttons.find(node => buttonText(node) === label)
    assert.ok(button)
    assert.equal(button.props.disabled, false)
    let release
    h.state.route = entry => {
      if (entry.path !== '/jobs/71/reupload') return
      assert.deepEqual(entry.body, {})
      assert.equal(JSON.parse(h.storage.get(storageKey)).actions['71'], 'retry')
      return new Promise(resolve => { release = resolve })
    }
    const pending = button.props.onClick()
    await flush()
    assert.equal(h.s.jobAction, 'retry:71')
    assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === label).props.disabled, true)
    await h.s.retryJob(h.s.visibleJobs[0])
    await h.s.retryFailedJobs()
    assert.equal(h.mutations().length, 1)
    release(reply({ job: job('queued', { id: '71', sourceId: 71, mode: 'draft', result }), queue: h.state.queue }))
    await pending
    assert.equal(h.s.visibleJobs[0].status, 'queued')
    assert.equal(h.s.jobAction, '')
    assert.equal(h.s.pendingActions['71'], undefined)
    assert.match(renderedFeedback(h).visible, /已接受 1 项重新上传/)
    assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/71/reupload'])
    assert.equal(h.state.requests.some(entry => entry.path === '/preflight'), false, 'Backend rechecks materials/checkpoints after accepting the retry')
  })
}

test('retry ignores stale buttons for saved, queued, running, cancelled and confirmation jobs', async t => {
  for (const status of ['saved', 'queued', 'running', 'cancelled', 'awaiting_confirmation']) {
    const h = await harness(t, { state: { jobs: [job(status, { result })] } })
    assert.equal(h.s.canRetry(h.s.visibleJobs[0]), false)
    await h.s.retryJob(job('failed'))
    await h.s.retryFailedJobs()
    assert.equal(h.mutations().length, 0)
    assert.equal(renderedFeedback(h).buttons.some(node => ['重新上传', '重新上传'].includes(buttonText(node))), false)
  }
})

test('draft failures never expose legacy actions even inside More operations', async t => {
  const h = await harness(t, { state: { jobs: [
    draftJob('uncertain', { result, recovery: { action: 'save', attempts: 3, maxAttempts: 3 } }),
    draftJob('uncertain', { id: 'reconcile', result }),
  ] } })
  const view = renderedFeedback(h)
  assert.equal(view.buttons.filter(node => buttonText(node) === '重新上传').length, 2)
  assert.doesNotMatch(view.visible + view.advanced, /继续上传并保存草稿|核对草稿状态|核对原页|自动重试/)
  assert.equal(view.moreOperations.length, 0)
  for (const item of h.s.visibleJobs) {
    await h.s.runJobAction(item, 'resume')
    await h.s.runJobAction(item, 'reconcile')
  }
  assert.equal(h.mutations().length, 0)
})

test('blocked materials point to the corresponding project and exhausted recovery points to retry', async t => {
  const h = await harness(t, { props: { scriptId: 67 }, state: { jobs: [job('blocked', { sourceId: 67, message: '缺少 3:4 封面', blockers: [{ code: 'asset_missing', field: 'covers.3:4', message: '缺少 3:4 封面' }] }), job('uncertain', { id: 'other', sourceId: 67, recovery: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, action: 'reconcile' } })] } })
  const view = renderedFeedback(h)
  assert.ok(view.links.some(node => node.props.href === '/history-scripts?script=67&view=library' && /材料/.test(buttonText(node))))
  assert.match(view.visible, /补齐后.*重新上传/)
  assert.match(view.visible, /处理上述原因后.*重新上传/)
  assert.equal(h.mutations().length, 0)
})

test('row login recovery: #127 offers visible login and sync, then retries only the original task', async t => {
  for (const target of targets) {
    const platform = target === 'tencent-video' ? 'tencent' : 'baijiahao'
    const name = platform === 'tencent' ? '视频号' : '百家号'
    // Runtime readiness can be stale even when the task has a concrete login blocker.
    const h = await harness(t, { state: { runtime: { ...runtime(), execution: 'background' }, jobs: [job('blocked', {
      id: '127', target, mode: 'draft', message: `${name}需要登录或完成安全验证`,
      blockers: [{ code: 'platform_not_ready', field: 'runtime', message: `${name}需要登录或完成安全验证` }],
    })] } })
    const view = renderedFeedback(h)
    assert.doesNotMatch(buttonText(view.rows[0]), /缺少素材|补齐.*材/)
    assert.ok(view.visible.includes(`打开${name}登录窗口`), 'Recovery must be visible outside More operations')
    assert.ok(view.visible.includes('同步登录'))
    assert.match(buttonText(view.rows[0]), /重新上传/)
    assert.equal(h.mutations().length, 0)
    await view.buttons.find(node => buttonText(node) === `打开${name}登录窗口`).props.onClick()
    await flush()
    await renderedFeedback(h).buttons.find(node => buttonText(node) === '同步登录').props.onClick()
    await flush()
    assert.equal(h.s.visibleJobs[0].status, 'blocked', 'Login and sync do not enqueue or save anything')
    assert.equal(h.timers.size, 0, 'Login recovery does not start a check loop')
    await renderedFeedback(h).buttons.find(node => buttonText(node) === '重新上传').props.onClick()
    await flush()
    assert.equal(h.s.visibleJobs[0].id, '127')
    assert.equal(h.s.visibleJobs[0].status, 'queued')
    assert.equal(h.state.jobs.length, 1)
    assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [
      ['/runtime/login', { platform }], ['/runtime/sync', { platform }], ['/jobs/127/reupload', {}],
    ])
  }
})

test('row login recovery: hints and material links follow actual blockers, including mixed failures', async t => {
  const cases = [
    { status: 'blocked', message: '需要完成安全验证', blockers: [{ code: 'platform_not_ready', field: 'runtime', message: '需要完成安全验证' }], login: true, hint: /登录或安全验证/ },
    { status: 'failed', error: '视频号登录已过期，请重新登录后继续', login: true, hint: /登录或安全验证/ },
    { status: 'failed', error: 'Login required', login: true, hint: /登录或安全验证/ },
    { status: 'uncertain', error: 'Timeout waiting for editor', message: '请先完成扫码登录', recovery: { action: 'manual' }, login: true, hint: /登录或安全验证/ },
    { status: 'blocked', blockers: [{ code: 'platform_not_ready', field: 'runtime', message: '平台未就绪' }], login: true, hint: /登录或安全验证/ },
    { status: 'failed', error: 'Network request failed', hint: /请检查网络.*重新上传/ },
    { status: 'uncertain', error: "WeChat upload failed: 网络出错，请重新上传", hint: /请检查网络.*重新上传/ },
    { status: 'blocked', blockers: [{ code: 'platform_not_ready', field: 'runtime', message: cdpTimeout }], hint: /刷新上传状态.*后台浏览器连接.*不代表登录过期/ },
    { status: 'blocked', blockers: [{ code: 'platform_not_ready', field: 'runtime', message: '网络连接失败' }], hint: /请检查网络/ },
    { status: 'uncertain', error: '登录已过期', message: '原编辑页内容已变化，请核对草稿', recovery: { action: 'reconcile' }, login: true, hint: /登录或安全验证/ },
    { status: 'blocked', blockers: [{ code: 'snapshot_changed', field: 'snapshot', message: '稿件或素材已变化' }], hint: /处理上述原因后.*重新上传/ },
    { status: 'blocked', blockers: [{ code: 'runtime_missing', field: 'runtime', message: '上传运行环境未安装' }], hint: /处理上述原因后/ },
    { status: 'blocked', message: '缺少 3:4 封面', hint: /处理上述原因后/ },
    { status: 'blocked', blockers: [{ code: 'asset_missing', field: 'covers.3:4', message: '缺少 3:4 封面' }], material: true, hint: /素材缺失或尚未就绪.*补齐后重新上传/ },
    { status: 'blocked', blockers: [{ code: 'article_images_not_prepared', field: 'article.screenshots', message: '文章配图未准备完成' }], material: true, hint: /补齐后重新上传/ },
    { status: 'blocked', blockers: [{ code: 'asset_unreadable', field: 'video', message: '成片无法读取' }, { code: 'platform_not_ready', field: 'runtime', message: '请完成登录' }], material: true, login: true, hint: /登录或安全验证/ },
  ]
  for (const { status, login = false, material = false, hint, ...extra } of cases) {
    const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job(status, extra)] } })
    const row = buttonText(renderedFeedback(h).rows[0])
    assert.equal(row.includes('打开百家号登录窗口'), login, JSON.stringify(extra))
    assert.equal(row.includes('同步登录'), login, JSON.stringify(extra))
    assert.equal(row.includes('查看并补齐材料'), material, JSON.stringify(extra))
    assert.equal(row.includes('素材缺失或尚未就绪'), material, JSON.stringify(extra))
    assert.match(row, hint)
    assert.equal(h.mutations().length, 0)
    assert.equal(h.timers.size, 0)
  }
})

for (const [cause, error, login, hint] of [
  ['verification', 'Verification required: 请完成安全验证后继续', true, /登录或安全验证.*重新上传/],
  ['network', 'net::ERR_CONNECTION_RESET', false, /请检查网络.*重新上传/],
]) {
  test(`row login recovery: uncertain generic message preserves the ${cause} error as a recovery reason`, async t => {
    const message = '自动恢复已尝试2次，请人工处理后继续'
    const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job('uncertain', {
      message, error, blockers: [], recovery: { attempts: 2, maxAttempts: 2, nextAttemptAt: null, action: 'manual' },
    })] } })
    const view = renderedFeedback(h)
    assert.ok(!view.visible.includes(message))
    assert.match(view.visible, login ? /需要完成平台安全验证/ : /上传网络连接失败/)
    assert.ok(!view.visible.includes(error), 'Raw error stays in technical details')
    assert.ok(view.technical.includes(error))
    assert.equal(buttonText(view.rows[0]).includes('打开百家号登录窗口'), login)
    assert.equal(view.buttons.some(node => buttonText(node) === '同步登录'), login)
    assert.match(buttonText(view.rows[0]), hint)
    assert.doesNotMatch(buttonText(view.rows[0]), /查看并补齐材料|素材缺失或尚未就绪/)
    assert.ok(view.buttons.some(node => buttonText(node) === '重新上传'))
    assert.equal(h.timers.size, 0)
    assert.equal(h.mutations().length, 0)
  })
}

test('row login recovery: active and completed tasks suppress obsolete recovery controls', async t => {
  for (const status of ['queued', 'running', 'awaiting_confirmation', 'saved', 'cancelled']) {
    const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job(status, {
      message: '请重新登录', blockers: [{ code: 'asset_missing', field: 'video', message: '缺少成片' }],
    })] } })
    assert.doesNotMatch(buttonText(renderedFeedback(h).rows[0]), /打开百家号登录窗口|同步登录|查看并补齐材料|素材缺失或尚未就绪/)
    await h.s.openLogin('baijiahao', h.s.visibleJobs[0])
    assert.equal(h.mutations().length, 0, 'A stale row action must not open login after the task advances')
  }
})

test('row login recovery: a global running task blocks sync but leaves login available outside its scope', async t => {
  for (const running of ['queue', 'jobs']) {
    const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job('blocked', { message: '请完成安全验证' }),
      ...(running === 'jobs' ? [job('running', { id: 'other', sourceId: 58 })] : [])],
      queue: { paused: false, reason: null, jobId: null, runningJobId: running === 'queue' ? 'other' : null },
    } })
    if (running === 'jobs') {
      // An unfiltered response / stored receipt may also reveal the global task.
      h.s.jobs.push({ ...job('running', { id: 'other' }), scriptId: 58 })
    }
    const view = renderedFeedback(h)
    assert.equal(view.rows.length, 1)
    assert.match(buttonText(view.rows[0]), /等待当前上传任务结束后再同步登录/)
    const open = view.buttons.find(node => buttonText(node) === '打开百家号登录窗口')
    assert.equal(open.props.disabled, false)
    assert.ok(view.buttons.filter(node => /同步.*登录/.test(buttonText(node))).every(node => node.props.disabled))
    await h.s.syncLogin('baijiahao')
    assert.equal(h.mutations().length, 0)
    await open.props.onClick()
    await flush()
    assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login'])
    assert.equal(h.s.visibleJobs[0].status, 'blocked')
    h.state.queue.runningJobId = null
    h.s.jobs = h.s.jobs.filter(item => item.id !== 'other')
    await h.s.loadJobs()
    assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '同步登录').props.disabled, false)
    await renderedFeedback(h).buttons.find(node => buttonText(node) === '同步登录').props.onClick()
    await flush()
    assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login', '/runtime/sync'])
  }
})

test('row login recovery: sync rejection and duplicate clicks do not replay or create tasks', async t => {
  const h = await harness(t, { state: { runtime: backgroundRuntime(), jobs: [job('blocked', { message: '请完成安全验证' })] } })
  let release
  h.state.route = entry => entry.path === '/runtime/login' ? new Promise(resolve => { release = resolve }) : undefined
  const open = renderedFeedback(h).buttons.find(node => buttonText(node) === '打开百家号登录窗口')
  const opening = open.props.onClick()
  await flush()
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '打开百家号登录窗口').props['aria-busy'], true)
  await open.props.onClick()
  assert.equal(h.mutations().length, 1)
  release(reply({ opened: true }))
  await opening
  h.state.route = entry => entry.path === '/runtime/sync' ? new Promise(resolve => { release = resolve }) : undefined
  const sync = renderedFeedback(h).buttons.find(node => buttonText(node) === '同步登录')
  const syncing = sync.props.onClick()
  await flush()
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '同步登录').props['aria-busy'], true)
  await sync.props.onClick()
  release({ ok: false, status: 409, json: async () => ({ code: 409, message: '上传正在执行，完成后再同步登录；当前上传会继续' }) })
  await syncing
  assert.match(renderedFeedback(h).visible, /上传正在执行，完成后再同步登录/)
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '打开百家号登录窗口').props.disabled, false)
  await h.advance(120_000)
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/runtime/login', '/runtime/sync'])
  assert.equal(h.state.jobs.length, 1)
  assert.equal(h.s.visibleJobs[0].status, 'blocked')
})

test('row login recovery: legacy runtime offers login and retry without background synchronization', async t => {
  const h = await harness(t, { state: { jobs: [job('blocked', { target: 'baijiahao-video', message: '百家号登录已过期' })] } })
  const view = renderedFeedback(h)
  assert.match(view.visible, /打开百家号登录窗口/)
  assert.doesNotMatch(buttonText(view.rows[0]), /同步登录|补齐.*材/)
  await view.buttons.find(node => buttonText(node) === '打开百家号登录窗口').props.onClick()
  await flush()
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/runtime/login', { platform: 'baijiahao' }]])
  assert.equal(h.timers.size, 0)
})

test('attention filter and batch retry use only the displayed project scope and exclude active/completed work', async t => {
  const selected = [71, 70, 69, 67, 66, 62]
  const h = await harness(t, { props: { scriptIds: selected }, state: { jobs: [
    ...selected.map((sourceId, index) => job(['blocked', 'failed', 'uncertain'][index % 3], { id: String(sourceId), sourceId })),
    job('failed', { id: 'outside', sourceId: 99 }),
    ...['saved', 'queued', 'running', 'cancelled', 'awaiting_confirmation'].map(status => job(status, { id: status, sourceId: 71, result })),
  ] } })
  assert.equal(h.s.retryableJobs.length, 6)
  let view = renderedFeedback(h)
  assert.match(buttonText(view.buttons.find(node => /批量重新上传/.test(buttonText(node)))), /6/)
  const attention = view.buttons.find(node => /^发表失败/.test(buttonText(node)))
  assert.ok(attention)
  await attention.props.onClick()
  await flush()
  view = renderedFeedback(h)
  assert.equal(view.buttons.find(node => /^发表失败/.test(buttonText(node))).props['aria-pressed'], true)
  assert.equal(view.rows.length, 6)
  assert.ok(view.rows.every(node => ['blocked', 'failed', 'uncertain'].includes(node.props['data-status'])))
  const before = h.state.requests.length
  await view.buttons.find(node => /批量重新上传/.test(buttonText(node))).props.onClick()
  await flush()
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [['/jobs/reupload', { jobIds: selected.map(String) }]])
  assert.equal(h.state.requests.slice(before).some(entry => ['/runtime', '/runtime/login', '/preflight'].includes(entry.path)), false)
  assert.match(renderedFeedback(h).visible, /已接受 6 项重新上传.*跳过 0 项/)
  assert.equal(h.s.retryableJobs.length, 0)
  assert.equal(h.s.filteredJobs.length, 0, 'Queued retries disappear from the failure filter')
  await renderedFeedback(h).buttons.find(node => buttonText(node) === '全部（11）').props.onClick()
  assert.equal(h.s.filteredJobs.length, 11)
  assert.equal(h.s.visibleJobs.some(item => item.id === 'outside'), false)
})

test('partial batch retry reports each skipped item and leaves it independently retryable', async t => {
  const h = await harness(t, { props: { scriptIds: [70, 69] }, state: { jobs: [job('failed', { id: '70', sourceId: 70 }), job('blocked', { id: '69', sourceId: 69 })] } })
  h.state.route = entry => {
    if (entry.path !== '/jobs/reupload') return
    h.state.jobs[0].status = 'queued'
    return reply({ jobs: [structuredClone(h.state.jobs[0])], queue: h.state.queue, skipped: [{ id: '69', message: '素材正在更新，请补齐后重新上传' }] })
  }
  await h.s.retryFailedJobs()
  const view = renderedFeedback(h)
  assert.match(view.visible, /已接受 1 项重新上传.*跳过 1 项/)
  assert.match(view.visible, /#69.*素材正在更新，请补齐后重新上传/)
  assert.deepEqual(plain(h.s.retryableJobs.map(item => item.id)), ['69'])
  assert.equal(h.s.jobAction, '')
  assert.deepEqual(plain(h.s.pendingActions), {})
  assert.equal(view.buttons.find(node => buttonText(node) === '重新上传').props.disabled, false)
  assert.equal(h.mutations().length, 1)
})

test('batch skips refresh concurrent saved/queued states and report each reason without replay', async t => {
  const h = await harness(t, { state: { jobs: [job('failed', { id: '1' }), job('uncertain', { id: '2', result })] } })
  h.state.route = entry => {
    if (entry.path !== '/jobs/reupload') return
    h.state.jobs[0].status = 'saved'
    h.state.jobs[1].status = 'queued'
    return reply({ jobs: [], queue: h.state.queue, skipped: [{ id: '1', message: '草稿已保存，无需重传' }, { id: '2', message: '任务已经排队' }] })
  }
  await h.s.retryFailedJobs()
  assert.deepEqual(plain(h.s.visibleJobs.map(item => item.status)), ['queued', 'saved'])
  assert.equal(h.s.retryableJobs.length, 0)
  const view = renderedFeedback(h)
  assert.match(view.visible, /已接受 0 项重新上传.*跳过 2 项/)
  assert.match(view.visible, /草稿已保存，无需重传/)
  assert.match(view.visible, /任务已经排队/)
  assert.deepEqual(h.state.requests.slice(-2).map(entry => entry.path), ['/jobs', '/candidates'])
  assert.equal(h.state.requests.at(-1).method, 'GET')
  await h.s.retryFailedJobs()
  assert.equal(h.mutations().length, 1)
})

for (const batch of [false, true]) {
  for (const failure of ['timeout', 'rejected', 'malformed']) {
    test(`${batch ? 'batch' : 'single'} retry ${failure} refreshes with GET and unlocks without replay`, async t => {
      const h = await harness(t, { state: { jobs: [job('failed')] } })
      const path = batch ? '/jobs/reupload' : '/jobs/job-1/reupload'
      h.state.route = entry => {
        if (entry.path !== path) return
        if (failure === 'timeout') return new Promise(() => {})
        if (failure === 'malformed') return reply(batch ? { jobs: [], skipped: [] } : { job: job('queued', { id: 'wrong' }) })
        return { ok: false, status: 409, json: async () => ({ code: 409, message: '任务暂不能重试，请稍后再试' }) }
      }
      const pending = batch ? h.s.retryFailedJobs() : h.s.retryJob(h.s.visibleJobs[0])
      await flush()
      if (failure === 'timeout') await h.advance(60_000)
      await pending
      assert.equal(h.s.jobAction, '')
      assert.equal(h.s.pendingActions['job-1'], undefined)
      assert.equal(h.s.visibleJobs[0].status, 'failed')
      const view = renderedFeedback(h)
      assert.equal(view.buttons.find(node => buttonText(node) === '重新上传').props.disabled, false)
      assert.match(view.visible, /重新上传请求未成功|暂不能重试/)
      assert.equal(h.state.requests.at(-1).method, 'GET')
      assert.equal(h.state.requests.at(-1).path, '/jobs')
      assert.deepEqual(h.mutations().map(entry => entry.path), [path])
      h.state.route = null
      await h.s.retryJob(h.s.visibleJobs[0])
      assert.equal(h.s.visibleJobs[0].status, 'queued')
      assert.equal(h.mutations().length, 2, 'Only an explicit second click retries')
    })
  }
}

test('lost retry response that already queued is recovered by GET without reuploading', async t => {
  const h = await harness(t, { state: { jobs: [job('uncertain', { result })] } })
  h.state.route = entry => {
    if (entry.path === '/jobs/job-1/reupload') { h.state.jobs[0].status = 'queued'; throw new Error('network disconnected') }
  }
  await h.s.retryJob(h.s.visibleJobs[0])
  assert.equal(h.s.visibleJobs[0].status, 'queued')
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.equal(h.s.actionError, '')
  assert.match(renderedFeedback(h).visible, /已更新发表队列/)
  await h.s.retryFailedJobs()
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/job-1/reupload'])
})

test('retry waits for a fresh state when its response and subsequent GET both stall', async t => {
  const h = await harness(t, { state: { jobs: [job('failed')] } })
  h.state.route = () => new Promise(() => {})
  const pending = h.s.retryJob(h.s.visibleJobs[0])
  await flush()
  await h.advance(60_000)
  assert.equal(h.s.jobAction, '', 'A failed retry must release its write lock before waiting for a recovery read')
  assert.equal(h.s.queueLoading, true)
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '重新上传').props.disabled, true)
  await h.advance(60_000)
  await pending
  assert.equal(h.s.jobAction, '')
  assert.equal(h.mutations().length, 1)
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '重新上传').props.disabled, true)
})

test('a persisted retry stays locked on remount until a fresh state is read', async t => {
  const storage = new Map([[storageKey, JSON.stringify({ targets, requests: [], actions: { 'job-1': 'retry' }, jobs: [job('failed')] })]])
  const h = await harness(t, { storage, state: { jobs: [job('failed')], route: entry => { if (entry.path === '/jobs') throw new Error('offline') } } })
  assert.equal(h.s.pendingActions['job-1'], 'retry')
  assert.equal(h.mutations().length, 0)
  assert.equal(renderedFeedback(h).buttons.find(node => buttonText(node) === '重新上传').props.disabled, true)
  h.state.route = null
  await h.s.loadJobs()
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.equal(h.mutations().length, 0)
})

test('retry does not get stranded by old action receipts or unavailable local storage', async t => {
  const h = await harness(t, { state: { jobs: [job('uncertain', { result })] } })
  h.s.pendingActions['job-1'] = 'reconcile'
  h.window.localStorage.setItem = () => { throw new Error('storage unavailable') }
  await h.s.retryJob(h.s.visibleJobs[0])
  assert.equal(h.s.visibleJobs[0].status, 'queued')
  assert.equal(h.s.jobAction, '')
  assert.equal(h.s.pendingActions['job-1'], undefined)
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/job-1/reupload'])
})

test('queued recovery hides cancellation and rejects cancel calls even when the deadline is absent', async t => {
  const h = await harness(t, { state: { jobs: [job('queued', {
    result, recovery: { attempts: 1, maxAttempts: 3, nextAttemptAt: '2026-10-23T04:05:06.000Z', action: 'save' },
  })] } })
  assert.equal(renderedFeedback(h).buttons.some(node => node.props?.['aria-label']?.startsWith('取消排队：')), false)
  for (const action of ['save', 'resume', 'upload', 'recover', 'busy', 'reconcile']) for (const nextAttemptAt of ['2026-10-23T04:05:06.000Z', null]) {
    const item = job('queued', { recovery: { attempts: 1, maxAttempts: 3, nextAttemptAt, action } })
    await h.s.cancelJob(item)
  }
  assert.equal(h.mutations().length, 0)
  assert.equal(h.s.visibleJobs[0].status, 'queued')
})

test('storage failures prevent writes and corrupt receipts are not overwritten by background GET', async t => {
  const storage = new Map([[storageKey, '{']])
  const h = await harness(t, { storage })
  assert.match(h.s.storageError, /不可读取/)
  assert.equal(storage.get(storageKey), '{')
  await h.s.submit('draft')
  assert.equal(h.mutations().length, 0)
  storage.delete(storageKey)
  h.s.restore()
  h.window.localStorage.setItem = () => { throw new Error('storage full') }
  await h.s.submit('draft')
  assert.equal(h.mutations().length, 0)
  assert.equal(h.s.pendingRequests.length, 0, 'Unsent receipt is not treated as an unknown upload')
  assert.match(h.s.storageError, /无法保留/)
})

test('single and global mounted instances synchronize options and unknown receipts', async t => {
  const storage = new Map()
  const window = browser(storage)
  const detail = await harness(t, { storage, window })
  const global = await harness(t, { storage, window, props: {} })
  detail.s.toggleTarget('tencent-video')
  assert.deepEqual(plain(global.s.selectedTargets), ['baijiahao-video'])
  detail.state.route = entry => { if (entry.path === '/jobs' && entry.method === 'POST') throw new Error('unknown') }
  await detail.s.submit('draft')
  assert.equal(global.s.visibleRequests.length, 1)
  global.s.toggleVersion(versionKey(57))
  assert.equal(global.s.canSubmit, false)
  assert.equal(detail.s.pendingRequests.length, 1)
  assert.equal(global.mutations().length, 0)
})

test('script/revision changes abort stale preflight and retain options without sending an upload', async t => {
  const h = await harness(t)
  h.s.toggleTarget('tencent-video')
  let release
  h.state.route = entry => entry.path === '/preflight' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = h.s.checkPreflight()
  await flush()
  const entry = h.state.requests.at(-1)
  h.app._instance.props.scriptId = 58
  h.app._instance.props.scriptRevision = 'new revision'
  await flush()
  assert.equal(entry.signal.aborted, true)
  release(reply({ items: checks([57], ['baijiahao-video']) }))
  await pending
  assert.equal(h.s.report, null)
  assert.deepEqual(plain(h.s.projectIds), [58])
  assert.deepEqual(plain(h.s.selectedTargets), ['baijiahao-video'])
  assert.equal(h.mutations().length, 0)
})

test('all queue states have exact distinct labels', async t => {
  const h = await harness(t)
  const labels = { queued: '排队中', running: '上传中', awaiting_confirmation: '待保存草稿', saved: '旧草稿已保存', submitted:'已提交审核', published:'已发表', blocked: '发表失败', failed: '发表失败', uncertain: '发表结果待核对', cancelled: '已取消' }
  for (const [status, label] of Object.entries(labels)) assert.equal(h.s.statusLabel(status), label)
  assert.equal(h.s.normalizeJobs([job('completed')])[0].status, 'saved')
  assert.equal(h.s.normalizeJobs([job('canceled')])[0].status, 'cancelled')
  assert.equal(h.s.normalizeJobs([job()])[0].scriptId, 57)
  assert.equal(h.s.normalizeJobs([job()])[0].title, '明朝冬季的蔬菜供应')
})

test('active upload displays concrete progress and operation instead of a stale failure', async t => {
  const h = await harness(t, { state: { jobs: [job('running', {
    operation: 'confirm', message: '正在继续处理', error: '旧错误：上传进程超时',
    progress: { step: 'save_draft', message: '已点击存草稿，正在确认保存结果' },
  })] } })
  const view = renderedFeedback(h)
  assert.match(view.visible, /上传中/)
  assert.match(view.visible, /已点击存草稿，正在确认保存结果/)
  assert.doesNotMatch(view.visible, /旧错误|上传进程超时/)
  assert.equal(h.s.visibleJobs[0].error, '旧错误：上传进程超时', 'Displaying current progress must not rewrite the stored failure evidence')
  assert.equal(h.mutations().length, 0)
})

test('legacy queued draft shows progress without exposing reconciliation instructions', async t => {
  const message = '保存已提交，将自动核对草稿箱'
  const h = await harness(t, { state: { jobs: [job('queued', { mode: 'draft', result,
    message, error: 'Timeout waiting for cover confirmation',
    progress: { step: 'cover_confirmation', message: '正在确认三图封面' },
    recovery: { attempts: 1, maxAttempts: 3, nextAttemptAt: '2026-10-23T04:05:06.000Z', action: 'reconcile' },
  })] } })
  const view = renderedFeedback(h)
  assert.match(view.visible, /排队中/)
  assert.doesNotMatch(view.visible, /正在确认三图封面|Timeout waiting|平台响应超时/)
  h.state.jobs[0] = { ...h.state.jobs[0], status: 'running', operation: 'reconcile',
    progress: { step: 'inspect_drafts', message: '正在草稿箱核对保存结果' },
  }
  await h.tick()
  const running = renderedFeedback(h)
  assert.match(running.visible, /正在确认草稿保存结果/)
  assert.ok(!running.visible.includes(message), 'Running tasks still prioritize current structured progress')
  assert.equal(h.mutations().length, 0)
})

test('legacy scheduled work displays ordinary progress and only reads until the server advances', async t => {
  const deadline = '2026-10-23T04:05:06.000Z'
  const h = await harness(t, { state: { jobs: [job('queued', {
    operation: null, message: '等待浏览器恢复后继续', error: '旧错误：编辑器关闭',
    progress: { step: 'retry_wait', message: '已安排自动恢复原编辑页' },
    recovery: { attempts: 1, maxAttempts: 3, nextAttemptAt: deadline, action: 'resume' },
  })], queue: { paused: false, reason: null, jobId: null, attentionCount: 0, recoveringCount: 1, runningJobId: null } } })
  const view = renderedFeedback(h)
  assert.match(view.visible, /排队中/)
  assert.doesNotMatch(view.visible, /等待浏览器恢复后继续/)
  assert.doesNotMatch(view.visible, /自动重试|预计/)
  assert.ok(!view.visible.includes(h.s.formatTime(deadline)))
  assert.doesNotMatch(view.visible, /旧错误|队列暂停|核对原页并继续|核对草稿状态/)
  assert.equal(h.s.resumeJob, undefined)
  assert.equal(h.s.reconcileJob, undefined)
  await h.tick()
  assert.equal(h.s.visibleJobs[0].status, 'queued', 'Even a past deadline must not start a browser action from the client')
  h.state.jobs[0] = job('running', {
    operation: 'recover', progress: { step: 'inspect_editor', message: '正在恢复原编辑页' },
    recovery: { attempts: 2, maxAttempts: 3, nextAttemptAt: null, action: 'resume' },
  })
  await h.tick()
  assert.match(renderedFeedback(h).visible, /上传中/)
  assert.doesNotMatch(renderedFeedback(h).visible, /恢复|自动重试/)
  assert.equal(h.mutations().length, 0)
})

test('draft retry after an old save failure starts upload again without resume or reconcile', async t => {
  const h = await harness(t, { state: { jobs: [draftJob('uncertain', { result,
    recovery: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, action: 'save' },
  })] } })
  await h.s.runJobAction(h.s.visibleJobs[0], 'resume')
  await h.s.runJobAction(h.s.visibleJobs[0], 'reconcile')
  assert.equal(h.mutations().length, 0)
  await h.s.retryJob(h.s.visibleJobs[0])
  assert.equal(h.s.visibleJobs[0].status, 'queued')
  assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/job-1/reupload'])
  assert.doesNotMatch(renderedFeedback(h).visible, /查看百家号草稿|核对原页/)
})

test('isolated attention does not pause the queue and global recovery keeps a filtered view polling', async t => {
  const h = await harness(t, { state: {
    jobs: [job('uncertain', { result, error: '需要登录后继续' })],
    queue: { paused: false, reason: null, jobId: null, attentionCount: 2, recoveringCount: 1, runningJobId: 'job-other' },
  } })
  const view = renderedFeedback(h)
  assert.equal(h.s.queuePauseMessage, '')
  assert.match(view.visible, /2 项发表失败/)
  assert.doesNotMatch(view.visible, /项自动恢复中/)
  assert.match(view.visible, /正在处理任务 #job-other/)
  assert.doesNotMatch(view.visible, /队列暂停/)
  assert.equal(h.s.reconcileJob, undefined)
  await h.tick()
  h.state.queue = { paused: false, reason: null, jobId: null, attentionCount: 1, recoveringCount: 0, runningJobId: null }
  await h.tick()
  assert.equal(h.timers.size, 0, 'Manual attention alone does not need a busy polling loop')
  assert.match(renderedFeedback(h).visible, /1 项发表失败/)
  assert.equal(h.mutations().length, 0)
})

test('legacy action receipts clear after a terminal read in either mode without new requests', async t => {
  for (const mode of ['stage', 'draft']) for (const action of ['resume', 'reconcile', 'confirm']) {
    const storage = new Map([[storageKey, JSON.stringify({ targets, requests: [], actions: { 'job-1': action }, jobs: [job('uncertain', { mode })] })]])
    const h = await harness(t, { storage, state: { jobs: [job('failed', { mode, error: '封面保存失败' })] } })
    assert.equal(h.s.pendingActions['job-1'], undefined)
    assert.equal(h.timers.size, 0)
    const view = renderedFeedback(h)
    assert.match(view.visible, /封面保存失败/)
    assert.equal(view.buttons.find(node => buttonText(node) === '重新上传').props.disabled, false)
    assert.equal(h.mutations().length, 0)
  }
})

test('saved drafts show the useful platform action and suppress old progress and errors', async t => {
  for (const target of targets) {
    const h = await harness(t, { state: { jobs: [job('saved', { target, mode: 'draft', result: { ...result, saved: true },
      error: '旧错误：上传超时', progress: { step: 'upload', message: '旧进度：正在上传视频' },
    })] } })
    const view = renderedFeedback(h)
    assert.ok(view.visible.includes(target === 'tencent-video' ? '查看视频号草稿' : '查看百家号草稿'))
    assert.doesNotMatch(view.visible, /旧错误|旧进度|待保存草稿/)
    await h.s.openJob(h.s.visibleJobs[0])
    assert.deepEqual(h.mutations().map(entry => entry.path), ['/jobs/job-1/open'])
  }
})

test('saved preview jobs have a truthful mode caption without changing draft defaults or uncertain results', async t => {
  const h = await harness(t, { state: { jobs: [job('saved', { result: { ...result, saved: true } })] } })
  assert.equal(h.s.jobModeLabel(h.s.visibleJobs[0]), '预览后已保存草稿')
  for (const status of ['queued', 'running', 'awaiting_confirmation', 'blocked', 'failed', 'uncertain', 'cancelled']) {
    assert.equal(h.s.jobModeLabel(job(status, { result: { ...result, saved: true } })), '仅上传预览')
  }
  assert.equal(h.s.jobModeLabel(job('saved', { mode: 'draft' })), '上传到草稿箱')
  const view = renderedFeedback(h)
  assert.match(view.visible, /预览后已保存草稿/)
  assert.doesNotMatch(view.visible, /仅上传预览 · 原生视频/)
  assert.match(source, /@click="submit\('publish'\)"/)
  assert.equal(h.mutations().length, 0)
})

for (const prefix of ['', '百家号连接检查失败：\n']) {
  test(`CDP queue errors ${prefix ? 'with Chinese context' : 'in English'} identify local connection timeouts without implying expired login`, async t => {
    const raw = prefix + cdpTimeout
    const h = await harness(t, { state: { jobs: [job('uncertain', { error: raw })] } })
    h.s.actionError = raw
    const formatted = h.s.feedback(raw)
    assert.match(formatted.text, /本机浏览器连接超时.*不代表登录过期.*重试连接/)
    assert.equal(formatted.detail, raw)
    const view = renderedFeedback(h)
    assert.doesNotMatch(view.visible, /BrowserType|10000ms|127\.0\.0\.1|ws:\/\//)
    assert.ok(view.technical.includes(raw))
    assert.equal(view.details.length, 2)
    assert.ok(view.details.every(node => !node.props?.open))
    assert.equal(h.s.visibleJobs[0].error, raw)
    assert.equal(h.mutations().length, 0)
  })
}

test('legacy recovery instructions give way to concrete causes while technical errors stay available', async t => {
  for (const [action, message, raw, cause, hasTechnical] of [
    ['manual', '视频号登录已过期，请重新登录后继续', 'Timeout 30000ms exceeded while waiting for editor', '视频号登录已过期', true],
    ['save', '自动恢复次数已用尽，请在原页继续处理', '上传进程超时，结果待人工核对', '上传进程超时', false],
    ['reconcile', '原编辑页内容已变化，请先核对原页', 'Target page, context or browser has been closed', '原编辑页内容已变化', true],
    [null, '百家号登录已过期，请重新登录后继续', 'Timeout waiting for upload', '百家号登录已过期', true],
  ]) {
    const h = await harness(t, { state: { jobs: [job('uncertain', { message, error: raw,
      recovery: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, action },
    })] } })
    const view = renderedFeedback(h)
    assert.ok(view.visible.includes(cause))
    assert.doesNotMatch(view.visible, /自动重试/)
    assert.ok(!view.visible.includes(raw))
    assert.equal(view.technical.includes(raw), hasTechnical)
    assert.equal(view.details.length, Number(hasTechnical))
    assert.ok(view.details.every(node => !node.props?.open))
    assert.equal(h.s.visibleJobs[0].error, raw, 'Rendering preserves the stored failure evidence')
    assert.equal(h.mutations().length, 0)
  }
})

test('uncertain error fallback preserves legacy evidence and avoids duplicate technical details', async t => {
  const h = await harness(t)
  const recovery = { attempts: 3, maxAttempts: 3, nextAttemptAt: null, action: 'manual' }
  const raw = 'Timeout waiting for editor'
  const expected = plain(h.s.feedback(raw))
  for (const metadata of [{}, { recovery: null }]) {
    assert.deepEqual(plain(h.s.jobFeedback(job('uncertain', { ...metadata, message: '原页核对结果待确认', error: raw }))), expected)
  }
  for (const message of [undefined, '', '   ']) {
    assert.deepEqual(plain(h.s.jobFeedback(job('uncertain', { recovery, message, error: raw }))), expected)
  }
  const message = '视频号登录已过期，请重新登录后继续'
  assert.deepEqual(plain(h.s.jobFeedback(job('uncertain', { recovery, message, error: message }))), { text: message, detail: '' })
  assert.deepEqual(plain(h.s.jobFeedback(job('uncertain', { recovery, message, error: null }))), { text: message, detail: '' })
  assert.equal(h.mutations().length, 0)
})

test('completed recovery replaces the actionable blocker and removes old exception details on refresh', async t => {
  const h = await harness(t, { state: { jobs: [job('uncertain', { mode: 'draft',
    message: '视频号登录已过期，请重新登录后继续', error: 'Timeout waiting for editor',
    recovery: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, action: 'manual' },
  })] } })
  assert.equal(renderedFeedback(h).details.length, 1)
  h.state.jobs[0] = job('completed', { mode: 'draft', result: { ...result, saved: true },
    message: '已保存到草稿箱，未发布', error: null, blockers: [],
    recovery: { attempts: 3, maxAttempts: 3, nextAttemptAt: null, action: null },
  })
  await h.s.loadJobs()
  const view = renderedFeedback(h)
  assert.match(view.visible, /已保存到草稿箱，未发布/)
  assert.doesNotMatch(view.visible, /登录已过期|请重新登录|平台响应超时|[1-9]\d* 项发表失败|自动重试已用尽/)
  assert.equal(h.s.attentionJobs.length, 0)
  assert.equal(view.details.length, 0)
  assert.equal(h.s.visibleJobs[0].error, null)
  assert.equal(h.mutations().length, 0)
})

test('provided Chinese causes remain unchanged and do not gain unnecessary technical disclosures', async t => {
  const message = '缺少 16:9 横版封面，请补齐当前稿件素材'
  const h = await harness(t, { state: { jobs: [job('blocked', { message })] } })
  h.s.actionError = message
  assert.deepEqual(plain(h.s.feedback(message)), { text: message, detail: '' })
  const view = renderedFeedback(h)
  assert.ok(view.visible.includes(message))
  assert.equal(view.details.length, 0)
  assert.equal(h.s.visibleJobs[0].message, message)
  assert.equal(h.mutations().length, 0)
})

test('other English SDK errors have Chinese recovery text without losing the original technical evidence', async t => {
  const h = await harness(t)
  for (const raw of ['Timeout 30000ms exceeded while waiting for cover confirmation', 'Target page, context or browser has been closed']) {
    h.s.actionError = raw
    const value = h.s.feedback(raw)
    assert.match(value.text, /请重新上传/)
    assert.equal(value.detail, raw)
    const view = renderedFeedback(h)
    assert.ok(view.visible.includes(value.text))
    assert.ok(!view.visible.includes(raw))
    assert.ok(view.technical.includes(raw))
    assert.equal(view.details.length, 1)
  }
  assert.equal(h.mutations().length, 0)
})

test('clicking the active ready filter refreshes externally confirmed editions without inspecting platform browsers', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [
    { scriptId: 67, title: '崖山海战' }, { scriptId: 74, title: '尚未上传的新稿' },
  ] } })
  h.s.candidateFilter = 'ready'
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.scriptId)), [67, 74])
  h.state.candidates[0].versions = [fixtureVersion(67, { state: 'published', canPublish: false })]
  const before = h.state.requests.length
  const pendingButton = renderedFeedback(h).buttons.find(button => buttonText(button) === '可发表（2）')
  await pendingButton.props.onClick()
  await flush()
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.scriptId)), [74], '#67 must disappear from the existing page after server-side backfill')
  assert.equal(h.s.versions.find(version => version.scriptId === 67).state, 'published')
  assert.ok(h.state.requests.slice(before).some(entry => entry.path === '/candidates' && entry.method === 'GET'))
  assert.ok(h.state.requests.slice(before).every(entry => entry.method === 'GET' && entry.path !== '/runtime'))
})

test('clearing all target checkboxes cannot turn already uploaded older projects into pending ones', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [
    { scriptId: 67, title: '崖山海战', versions: [fixtureVersion(67, { state: 'published', canPublish: false })] },
    { scriptId: 73, title: '边界前的旧稿', versions: [fixtureVersion(73, { state: 'published', canPublish: false })] },
    { scriptId: 74, title: '边界后的新稿' },
  ] } })
  h.s.candidateFilter = 'ready'
  for (const target of targets) h.s.toggleTarget(target)
  await flush()
  assert.deepEqual(plain(h.s.selectedTargets), [])
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.scriptId)), [74])
  h.s.candidateFilter = 'published'
  await flush()
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.scriptId)), [67, 73])
  assert.match(h.s.submitDisabledReason, /选择/)
})

const publicationResult = (id, published = false) => ({...result,saved:false,submitted:true,published,
  publicationStatus:published?'published':'submitted',articleId:String(id),accountName:'history_baijiahao',
  publishedUrl:`https://baijiahao.baidu.com/builder/preview/s?id=${id}`})
const publicationChecks = (sourceId=57) => ['huasheng','motion'].map((videoProducer,index)=>({
  ...checks([sourceId])[0],videoId:101+index,videoProducer,
}))

test('edition inventory distinguishes submitted work from its failed sibling despite an old manuscript marker', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [{ scriptId: 57, title: '两版稿件', uploads: allUploads(), versions: [
    productionVersion('huasheng', 'submitted'), productionVersion('motion', 'attention', { action: 'retry_packaging', message: '封面生成失败' }),
  ] }] } })
  assert.equal(h.s.versions.length, 2)
  assert.equal(h.s.candidateCounts.attention, 1)
  assert.equal(h.s.candidateCounts.submitted, 1)
  assert.equal(h.s.candidateCounts.ready, 0)
  h.s.candidateFilter = 'attention'
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.producer)), ['motion'])
  assert.match(renderedFeedback(h).visible, /封面生成失败/)
  assert.equal(renderedFeedback(h).buttons.some(node => buttonText(node) === '标记已上传'), false)
})

test('selecting one edition sends its exact video identity through preflight and submission', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [{ scriptId: 57, title: '两版稿件', versions: [
    productionVersion('huasheng'), productionVersion('motion'),
  ] }], preflight: [publicationChecks()[1]] } })
  h.s.toggleVersion('57:current:motion')
  await h.s.submit('publish')
  const preflight = h.state.requests.find(entry => entry.path === '/preflight')
  assert.equal(preflight.query.get('videoIds'), '102')
  assert.deepEqual(plain(h.mutations().filter(entry => entry.path === '/jobs')[0].body.videoIds), [102])
  assert.deepEqual(plain(h.s.projectIds), [57])
})

test('a manuscript-only publication link focuses both editions and its own tasks without selecting them', async t => {
  const storage = new Map([[storageKey, JSON.stringify({ targets, selectedVersionKeys: ['57:current:huasheng', '57:current:motion', versionKey(58)], requests: [], actions: {}, jobs: [] })]])
  const h = await harness(t, { props: { focusScriptId: '57' }, storage, state: { candidates: [
    { scriptId: 57, title: '指定稿件', versions: [productionVersion('huasheng'), productionVersion('motion', 'submitted')] },
    { scriptId: 58, title: '其他稿件' },
  ], jobs: [job('submitted', { id: 'first', videoId: 102 }), job('failed', { id: 'second', videoId: 101 }), job('queued', { id: 'foreign', sourceId: 58 })] } })
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.videoId)), [101, 102])
  assert.equal(h.s.candidateFilter, 'all')
  assert.deepEqual(plain(h.s.visibleJobs.map(item => item.id)), ['first', 'second'])
  assert.deepEqual(plain(h.s.selectedVersions), [])
  assert.equal(h.mutations().length, 0)
  assert.equal(h.state.requests.some(item => item.path === '/preflight'), false)
  h.s.clearFocus()
  await flush()
  assert.equal(h.s.versions.length, 3)
  assert.equal(h.s.visibleJobs.length, 3)
  assert.deepEqual(plain(h.s.selectedVersions), [])
})

test('invalid or unknown manuscript-only focus cannot broaden to the global inventory', async t => {
  for (const focusScriptId of [999, 0, null, '57,58', ['57', '58']]) {
    const h = await harness(t, { props: { focusScriptId }, state: { jobs: [job('failed')] } })
    assert.deepEqual(plain(h.s.versions), [])
    assert.deepEqual(plain(h.s.visibleJobs), [])
    assert.equal(h.s.canSubmit, false)
    assert.equal(h.mutations().length, 0)
    h.close()
  }
})

test('a focused publication link isolates its video without restoring or creating a selection', async t => {
  const storage = new Map([[storageKey, JSON.stringify({ targets, selectedVersionKeys: ['57:current:huasheng', '57:current:motion', versionKey(58)], requests: [], actions: {}, jobs: [] })]])
  const h = await harness(t, { props: { focusScriptId: 57, focusVideoId: 102 }, storage, state: { candidates: [
    { scriptId: 57, title: '指定作品', versions: [productionVersion('huasheng'), productionVersion('motion')] },
    { scriptId: 58, title: '其他作品' },
  ] } })
  assert.deepEqual(plain(h.s.filteredCandidates.map(item => item.videoId)), [102])
  assert.deepEqual(plain(h.s.selectedVersions), [])
  h.s.toggleVersion('57:current:huasheng')
  assert.deepEqual(plain(h.s.selectedVersions), [])
  assert.equal(h.mutations().length, 0)
  h.s.toggleAllCandidates()
  assert.deepEqual(plain(h.s.selectedVideoIds), [102])
  await h.s.submit('publish')
  assert.deepEqual(plain(h.mutations().find(item => item.path === '/jobs').body.videoIds), [102])
})

test('clearing publication focus restores all editions without automatically selecting them', async t => {
  const h = await harness(t, { props: { focusScriptId: 57, focusVideoId: 102 }, state: { candidates: [
    { scriptId: 57, title: '指定作品', versions: [productionVersion('huasheng'), productionVersion('motion')] },
    { scriptId: 58, title: '其他作品' },
  ] } })
  h.s.clearFocus()
  await flush()
  assert.equal(h.s.filteredCandidates.length, 3)
  assert.deepEqual(plain(h.s.selectedVersions), [])
  assert.equal(h.mutations().length, 0)
})

test('a selection cannot transfer to a rerendered video or restore a revision without its video identity', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [{ scriptId: 57, title: '待修订的成片', versions: [productionVersion('motion')] }] } })
  h.s.toggleVersion('57:current:motion')
  assert.deepEqual(plain(h.s.selectedVideoIds), [102])
  h.state.candidates[0].versions = [productionVersion('motion', 'ready', { videoId: 103, revisionOfVideoId: 102, automatic: false })]
  await h.s.loadCandidates()
  assert.deepEqual(plain(h.s.selectedVideoIds), [])
  assert.equal(h.s.canSubmit, false)
  assert.equal(h.mutations().length, 0)
  h.s.toggleVersion('57:current:motion')
  await h.s.loadCandidates()
  assert.deepEqual(plain(h.s.selectedVideoIds), [103], 'An explicit choice remains valid while the exact revised video stays current')

  for (const props of [{}, { scriptId: 57 }]) {
    const storage = new Map([[storageKey, JSON.stringify({ targets, selectedVersionKeys: ['57:current:huasheng', '57:current:motion'], requests: [], actions: {}, jobs: [] })]])
    const restored = await harness(t, { props, storage, state: { candidates: [{ scriptId: 57, title: '新旧成片', versions: [
      productionVersion('huasheng'), productionVersion('motion', 'ready', { videoId: 103, revisionOfVideoId: 102, automatic: false }),
    ] }] } })
    assert.deepEqual(plain(restored.s.selectedVideoIds), [101], 'A first edition can restore its selection, while its revised sibling needs an explicit choice')
    assert.equal(restored.mutations().length, 0)
    restored.close()
  }

  const scoped = await harness(t, { props: { scriptId: 57 }, state: { candidates: [{ scriptId: 57, title: '修订成片', versions: [
    productionVersion('motion', 'ready', { videoId: 103, revisionOfVideoId: 102, automatic: false }),
  ] }] } })
  assert.deepEqual(plain(scoped.s.selectedVideoIds), [], 'Opening manuscript details must not automatically select its revision')
  assert.equal(scoped.mutations().length, 0)
})

test('a focused revision keeps only its own and its original publication tasks visible', async t => {
  const original = job('uncertain', { id: '221', mode: 'publish', videoId: 88, videoProducer: 'motion', result })
  const h = await harness(t, { props: { focusScriptId: 57, focusVideoId: 102 }, state: {
    candidates: [{ scriptId: 57, title: '修订版', versions: [productionVersion('huasheng', 'submitted'), productionVersion('motion', 'attention', { automatic: false, previousJobId: '221', revisionOfVideoId: 88, message: '原提交尚待核对' })] }],
    jobs: [original, job('published', { id: '222', mode: 'publish', videoId: 101, videoProducer: 'huasheng', result: publicationResult(123, true) }), job('queued', { id: '223', sourceId: 58, videoId: 102 })],
  } })
  assert.deepEqual(plain(h.s.visibleJobs.map(item => item.id)), ['221'])
  assert.equal(h.s.filteredCandidates[0].state, 'attention')
  assert.equal(h.s.filteredCandidates[0].canPublish, false)
  assert.match(renderedFeedback(h).visible, /原提交尚待核对/)
  h.s.queueFilter = 'attention'
  await h.s.locateJob('221')
  assert.equal(h.s.focusedJobId, '221')
  assert.equal(h.s.queueFilter, 'all')
  assert.equal(h.mutations().length, 0)
})

test('publication focus reads an older original task by identity if it is outside the recent queue page', async t => {
  const original = job('uncertain', { id: '221', mode: 'publish', videoId: 88, videoProducer: 'motion', result })
  const h = await harness(t, { props: { focusScriptId: 57, focusVideoId: 102 }, state: {
    candidates: [{ scriptId: 57, title: '修订版', versions: [productionVersion('motion', 'attention', { automatic: false, previousJobId: '221', revisionOfVideoId: 88 })] }],
    jobs: [original], route: entry => entry.path === '/jobs' && !entry.query.has('requestId') ? reply({ jobs: [], queue: { paused: false, reason: null, jobId: null } }) : undefined,
  } })
  assert.deepEqual(plain(h.s.visibleJobs.map(item => item.id)), ['221'])
  assert.ok(h.state.requests.some(item => item.path === '/jobs/221' && item.method === 'GET'))
  assert.equal(h.mutations().length, 0)
})

test('a foreign or stale focused video stays empty rather than falling back to another edition', async t => {
  for (const focusVideoId of [999, -1, '102,101', ['102', '101']]) {
    const h = await harness(t, { props: { focusScriptId: 57, focusVideoId }, state: { candidates: [
      { scriptId: 57, title: '两版作品', versions: [productionVersion('huasheng'), productionVersion('motion')] },
      { scriptId: 58, title: '其他作品', versions: [fixtureVersion(58, { videoId: 999 })] },
    ], jobs: [job('failed', { videoId: null })] } })
    assert.equal(h.s.versions.length, 0)
    assert.deepEqual(plain(h.s.filteredCandidates), [])
    assert.deepEqual(plain(h.s.selectedVersions), [])
    assert.deepEqual(plain(h.s.visibleJobs), [])
    assert.equal(h.s.canSubmit, false)
    assert.equal(h.mutations().length, 0)
    h.close()
  }
})

test('active production inventory advances through GET polling before any upload job exists', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [{ scriptId: 57, title: '正在准备材料', versions: [productionVersion('motion', 'packaging')] }] } })
  assert.equal(h.s.candidateCounts.processing, 1)
  assert.equal(h.s.visibleJobs.length, 0)
  h.state.candidates[0].versions = [productionVersion('motion')]
  await h.tick()
  assert.equal(h.s.candidateCounts.ready, 1)
  assert.equal(h.timers.size, 0)
  assert.equal(h.mutations().length, 0)
})

test('a sibling submission receipt cannot resolve a lost request for another edition', async t => {
  const h = await harness(t)
  h.state.route = entry => {
    if (entry.path !== '/jobs') return
    if (entry.method === 'POST') throw new Error('回执丢失')
    if (entry.query.has('requestId')) return reply({ requestId: entry.query.get('requestId'), jobs: [], items: checks([57]).map(item => ({ ...item, videoId: 999, ready: false, uploaded: uploaded() })) })
  }
  await h.s.submit('publish')
  assert.equal(h.s.pendingRequests.length, 1)
  assert.equal(h.s.canSubmit, false)
  await h.s.submit('publish')
  assert.equal(h.mutations().length, 1)
})

test('a new authoritative inventory removes stale submitted cache and never promotes old candidates to ready', async t => {
  const h = await harness(t, { props: {}, state: { candidates: [{ scriptId: 57, title: '稿件', uploads: allUploads(), versions: [productionVersion('motion', 'submitted')] }] } })
  h.state.candidates = [{ scriptId: 57, title: '稿件', uploads: {}, versions: [productionVersion('motion', 'packaging')] }]
  await h.s.loadCandidates()
  assert.equal(h.s.candidates[0].uploads['baijiahao-video'], undefined)
  assert.equal(h.s.candidateCounts.submitted, 0)
  assert.equal(h.s.candidateCounts.processing, 1)
  h.state.candidates = [{ scriptId: 57, title: '旧接口稿件', uploads: allUploads() }]
  await h.s.loadCandidates()
  assert.equal(h.s.versions[0].state, 'stale')
  assert.equal(h.s.versions[0].canPublish, false)
})

test('publication preflight displays two independent versions and ignores an old manual draft marker', async t => {
  const h=await harness(t,{state:{preflight:publicationChecks(),candidates:[{scriptId:57,title:'历史稿件',uploads:allUploads('manual'), versions: [productionVersion('huasheng'), productionVersion('motion')]}]}})
  await h.s.checkPreflight()
  assert.equal(h.s.projects.length,2)
  assert.deepEqual(plain(h.s.projects.map(item=>item.version)),['花生版','精细化版'])
  assert.equal(h.s.readyCount,2)
  assert.equal(h.s.uploadedCount,0,'Old draft markers cannot describe new production versions')
  const view=renderedFeedback(h)
  assert.match(view.visible,/花生版/);assert.match(view.visible,/精细化版/)
  assert.equal(view.buttons.some(node=>buttonText(node)==='发表所选版本（2）'),true)
  await h.s.submit('publish')
  assert.equal(h.mutations().length,1)
  assert.equal(h.mutations()[0].body.mode,'publish')
  assert.deepEqual(h.mutations()[0].body.targets,['baijiahao-video'])
  assert.deepEqual(plain(h.s.visibleJobs.map(item=>item.videoId)),[101,102])
})

test('one completed version never hides retry for the other version or relabels a draft as publication',async t=>{
  const h=await harness(t,{state:{candidates:[{scriptId:57,title:'两版',uploads:allUploads()}],jobs:[
    job('submitted',{id:'huasheng',mode:'publish',videoId:101,videoProducer:'huasheng',result:publicationResult(111)}),
    job('failed',{id:'motion',mode:'publish',videoId:102,videoProducer:'motion',message:'图片服务暂不可用'}),
    draftJob('completed',{id:'old',result:{...result,saved:true}}),
  ]}})
  assert.equal(h.s.visibleJobs.find(item=>item.id==='old').status,'saved')
  const failed=h.s.visibleJobs.find(item=>item.id==='motion')
  assert.equal(h.s.canRetry(failed),true)
  await h.s.retryJob(failed)
  assert.deepEqual(h.mutations().map(item=>[item.path,item.body]),[['/jobs/motion/reupload',{}]])
  assert.equal(h.s.visibleJobs.find(item=>item.id==='huasheng').status,'submitted')
})

test('submitted and published receipts remain distinct and refresh candidates through GET only',async t=>{
  const h=await harness(t,{state:{jobs:[
    job('running',{id:'first',mode:'publish',videoId:101,videoProducer:'huasheng'}),
    job('running',{id:'second',mode:'publish',videoId:102,videoProducer:'motion'}),
  ]}})
  const before=h.state.requests.filter(item=>item.path==='/candidates').length
  h.state.jobs[0]={...h.state.jobs[0],status:'completed',result:publicationResult(111)}
  h.state.jobs[1]={...h.state.jobs[1],status:'completed',result:publicationResult(222,true)}
  await h.s.loadJobs();await flush()
  const first=h.s.visibleJobs.find(item=>item.id==='first'),second=h.s.visibleJobs.find(item=>item.id==='second')
  assert.equal(first.status,'submitted');assert.equal(second.status,'published')
  assert.equal(h.s.jobStatusLabel(first),'已提交审核');assert.equal(h.s.jobStatusLabel(second),'已发表')
  assert.match(h.s.jobFeedback(first).text,/正在审核/)
  assert.doesNotMatch(h.s.jobFeedback(first).text,/已发表/)
  assert.equal(h.s.canRetry(first),false);assert.equal(h.s.canRetry(second),false)
  assert.ok(h.state.requests.filter(item=>item.path==='/candidates').length>before)
  assert.equal(h.mutations().length,0)
  assert.equal(h.s.backgroundJobUrl(first),'https://baijiahao.baidu.com/builder/rc/content')
})

for(const scenario of ['duplicate version','missing project','contradictory readiness','foreign project']){
  test(`publication rejects ${scenario} preflight without an enqueue`,async t=>{
    let items=publicationChecks()
    if(scenario==='duplicate version')items[1]={...items[0]}
    if(scenario==='missing project')items=[]
    if(scenario==='contradictory readiness')items[0].blockers=[{field:'video',message:'视频缺失'}]
    if(scenario==='foreign project')items[0].sourceId=999
    const h=await harness(t,{state:{preflight:items, candidates: [{ scriptId: 57, title: '两版稿件', versions: [productionVersion('huasheng'), productionVersion('motion')] }]}})
    await h.s.submit('publish')
    assert.equal(h.mutations().length,0)
    assert.ok(h.s.preflightError)
    assert.equal(h.s.pendingRequests.length,0)
  })
}

test('legacy channels in a queue response cannot break the current Baijiahao view or create channel choices',async t=>{
  const h=await harness(t,{state:{jobs:[draftJob('saved',{id:'legacy-wechat',target:'tencent-video'}),
    draftJob('saved',{id:'legacy-article',target:'baijiahao-article'}),job('queued',{mode:'publish'})]}})
  assert.equal(h.s.queueError,'')
  assert.deepEqual(plain(h.s.selectedTargets),['baijiahao-video'])
  assert.deepEqual(plain(h.s.visibleJobs.map(item=>item.id)),['job-1'])
  assert.doesNotMatch(renderedFeedback(h).visible,/百家号图文|视频号视频/)
  assert.equal(h.mutations().length,0)
})

test('publication enqueue locks duplicate clicks and recovers a lost receipt with GET only',async t=>{
  const h=await harness(t,{state:{preflight:publicationChecks(), candidates: [{ scriptId: 57, title: '两版稿件', versions: [productionVersion('huasheng'), productionVersion('motion')] }]}})
  let release
  h.state.route=entry=>{
    if(entry.path==='/jobs'&&entry.method==='POST'){
      h.state.jobs=publicationChecks().map((check,index)=>job('queued',{id:`version-${index}`,sourceId:57,mode:'publish',
        videoId:check.videoId,videoProducer:check.videoProducer,requestId:entry.body.requestId}))
      return new Promise((_resolve,reject)=>{release=()=>reject(new Error('lost reply'))})
    }
  }
  const pending=h.s.submit('publish');await flush()
  await h.s.submit('publish')
  assert.equal(h.mutations().length,1)
  assert.equal(JSON.parse(h.storage.get(storageKey)).requests[0].mode,'publish')
  release();await pending;await flush()
  assert.equal(h.s.visibleJobs.length,2)
  assert.equal(h.s.pendingRequests.length,0)
  await h.tick()
  assert.equal(h.mutations().length,1)
})

test('uncertain publication preserves its evidence and offers continuation without reupload instructions',async t=>{
  const error='发表结果待核对；不会重传或再次发表：平台作品列表暂不可用'
  const h=await harness(t,{state:{jobs:[job('uncertain',{mode:'publish',result,error,message:error})]}})
  const view=renderedFeedback(h)
  const row=buttonText(view.rows[0])
  assert.match(row,/发表结果待核对/)
  assert.match(row,/继续原任务/)
  assert.doesNotMatch(row,/重新上传|未能保存到草稿箱/)
  assert.match(view.technical,/平台作品列表暂不可用/)
  assert.ok(view.buttons.some(node=>buttonText(node)==='批量继续任务（1）'))
  await view.buttons.find(node=>buttonText(node)==='继续原任务').props.onClick()
  assert.equal(h.mutations().length,1)
  assert.equal(h.mutations()[0].path,'/jobs/job-1/reupload')
  assert.match(renderedFeedback(h).visible,/已接受 1 项原任务重试/)
})

test('queued publication recovery cannot be canceled to create another publication attempt',async t=>{
  const h=await harness(t,{state:{jobs:[job('queued',{mode:'publish',operation:'recover'})]}})
  const recovering=h.s.visibleJobs[0]
  assert.equal(h.s.canCancel(recovering),false)
  assert.equal(renderedFeedback(h).buttons.some(node=>String(node.props?.['aria-label']).startsWith('取消排队')),false)
  await h.s.cancelJob(recovering)
  assert.equal(h.mutations().length,0)
})

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 960 }]) {
test(`Nuxt UI: selecting a ready edition leaves its submitted sibling unchanged at ${viewport.width}px`,async t=>{
  const h=await uiHarness(t,{viewport,state:{runtime:{...runtime(),execution:'background'},candidates: [
    { scriptId: 57, title: '明朝冬季的蔬菜供应', versions: [productionVersion('huasheng', 'submitted'), productionVersion('motion')] },
  ],jobs:[
    job('submitted',{id:'huasheng-ready',mode:'publish',videoId:101,videoProducer:'huasheng',result:publicationResult(111)}),
    job('published',{id:'motion-old',mode:'publish',videoId:88,videoProducer:'motion',result:publicationResult(222,true)}),
  ]}})
  assert.equal(await h.panel.locator('.target-choice').count(),1)
  assert.doesNotMatch(await h.panel.innerText(),/百家号图文|视频号视频|同步视频号登录/)
  const first=h.panel.locator('.queue-row').filter({hasText:'花生版'}),second=h.panel.locator('.queue-row').filter({hasText:'精细化版'})
  assert.equal(await first.getByText('已提交审核',{exact:true}).count(),1)
  assert.equal(await second.getByText('已发表',{exact:true}).count(),1)
  assert.equal(await first.getByRole('button',{name:'重新上传',exact:true}).count(),0)
  const inventory = h.panel.locator('.candidate-section')
  await inventory.getByRole('button', { name: '全部（2）', exact: true }).click()
  const submittedVersion = inventory.getByRole('checkbox', { name: '选择花生版：明朝冬季的蔬菜供应 稿件 #57', exact: true })
  assert.equal(await submittedVersion.isDisabled(), true)
  await inventory.getByRole('checkbox',{name:'选择精细化版：明朝冬季的蔬菜供应 稿件 #57',exact:true}).check()
  await h.page.screenshot({ path: join(tmpdir(), `history-editions-${viewport.width}.png`), fullPage: true })
  await h.panel.getByRole('button',{name:'发表所选版本（1）',exact:true}).click()
  await h.panel.locator('.queue-row[data-status="queued"]').waitFor()
  const submitted=h.mutations().filter(item=>item.path==='/jobs')
  assert.equal(submitted.length,1)
  assert.equal(submitted[0].body.mode,'publish')
  assert.deepEqual(submitted[0].body.targets,['baijiahao-video'])
  assert.deepEqual(submitted[0].body.videoIds, [102])
  assert.equal(h.state.requests.find(item => item.path === '/preflight').query.get('videoIds'), '102')
  assert.equal(h.state.jobs.find(item => item.id === 'huasheng-ready').status, 'submitted')
  assert.equal(await h.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  assert.equal(h.context.pages().length,1)
})
}

test('Nuxt UI: recovery sends the edition and manuscript hash while preserving its submitted sibling', async t => {
  const candidates = [{ scriptId: 57, title: '两个版本的恢复', versions: [
    productionVersion('huasheng', 'submitted'), productionVersion('motion', 'attention', { action: 'retry_packaging', message: '封面生成失败' }),
  ] }]
  const h = await uiHarness(t, { viewport: { width: 390, height: 844 }, state: { candidates, route: entry => {
    if (entry.method !== 'POST' || entry.path !== '/versions/102/continue') return
    assert.deepEqual(entry.body, { sourceId: 57, expectedScriptSha256: 'a'.repeat(64) })
    candidates[0].versions[1] = productionVersion('motion', 'packaging')
    return { json: { code: 202, data: { reused: true, message: '继续原任务' } } }
  } } })
  const inventory = h.panel.locator('.candidate-section')
  assert.equal(await inventory.locator('.version-row').count(), 1)
  await inventory.getByRole('button', { name: '继续发布准备', exact: true }).click()
  await h.panel.getByText('已继续原任务', { exact: true }).waitFor()
  await inventory.getByRole('button', { name: '进行中（1）', exact: true }).click()
  await inventory.locator('.version-row[data-state="packaging"]').waitFor()
  assert.deepEqual(h.mutations().map(entry => [entry.path, entry.body]), [
    ['/versions/102/continue', { sourceId: 57, expectedScriptSha256: 'a'.repeat(64) }],
  ])
  assert.equal(candidates[0].versions[0].state, 'submitted')
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await h.page.screenshot({ path: join(tmpdir(), 'history-edition-recovery-390.png'), fullPage: true })
})

for (const width of [390, 1440]) test(`Nuxt UI: a direct video link focuses one edition without selecting or publishing at ${width}px`, async t => {
  const h = await uiHarness(t, { viewport: { width, height: 960 }, path: '/history-scripts?view=uploads&script=57&videoId=102', state: { runtime: { ...runtime(), execution: 'background' }, candidates: [
    { scriptId: 57, title: '链接定位的作品', versions: [productionVersion('huasheng', 'submitted'), productionVersion('motion', 'ready', { automatic: false, revisionOfVideoId: 88, previousJobId: '221', message: '原成片已提交，本次修订需明确选择再次发表' })] },
    { scriptId: 58, title: '其他作品' },
  ], jobs: [job('submitted', { id: '221', mode: 'publish', videoId: 88, videoProducer: 'motion', result: publicationResult(188) })] } })
  const inventory = h.panel.locator('.candidate-section')
  assert.equal(await inventory.locator('.version-row').count(), 1)
  const target = inventory.getByRole('checkbox', { name: '选择精细化版：链接定位的作品 稿件 #57', exact: true })
  assert.equal(await target.isChecked(), false)
  assert.equal(await h.panel.getByRole('button', { name: '发表所选版本（0）', exact: true }).isDisabled(), true)
  await inventory.getByText('原成片已提交，本次修订需明确选择再次发表', { exact: true }).waitFor()
  assert.equal(h.mutations().length, 0)
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await h.page.screenshot({ path: join(tmpdir(), `history-focused-edition-${width}.png`), fullPage: true })
  if (width === 390) {
    await target.check()
    await h.panel.getByRole('button', { name: '发表所选版本（1）', exact: true }).click()
    await h.panel.locator('.queue-row[data-status="queued"]').waitFor()
    const writes = h.mutations().filter(item => item.path === '/jobs')
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].body.videoIds, [102])
    assert.equal(h.state.candidates[0].versions[0].state, 'submitted')
  } else {
    await h.panel.getByRole('button', { name: '清除定位', exact: true }).click()
    await inventory.locator('.version-row').nth(2).waitFor()
    await h.page.waitForURL(url => !url.searchParams.has('videoId'))
    assert.equal(new URL(h.page.url()).searchParams.has('videoId'), false)
    assert.equal(new URL(h.page.url()).searchParams.has('script'), false)
    assert.equal(await h.panel.getByRole('button', { name: '发表所选版本（0）', exact: true }).isDisabled(), true)
    assert.equal(h.mutations().length, 0)
  }
})

for (const width of [390, 1440]) test(`Nuxt UI: a manuscript-only link shows both editions and clears both route ids at ${width}px`, async t => {
  const h = await uiHarness(t, { viewport: { width, height: 960 }, libraryItems: [{ id: 58, title: '稿件库首条作品', status: 'needs_review' }], path: '/history-scripts?view=uploads&script=57', state: { candidates: [
    { scriptId: 57, title: '稿件定位的两版作品', versions: [productionVersion('huasheng', 'submitted'), productionVersion('motion')] },
    { scriptId: 58, title: '其他作品' },
  ], jobs: [job('submitted', { id: '221', mode: 'publish', videoId: 101 }), job('failed', { id: 'foreign', sourceId: 58 })] } })
  const inventory = h.panel.locator('.candidate-section')
  assert.equal(await inventory.locator('.version-row').count(), 2)
  assert.equal(await h.panel.locator('.queue-row').count(), 1)
  assert.equal(await inventory.locator('input[type="checkbox"]:checked').count(), 0)
  assert.equal(h.mutations().length, 0)
  assert.equal(h.state.requests.some(entry => entry.path === '/preflight'), false)
  await h.page.locator('.source-item').waitFor({ state: 'attached' })
  if (width === 1440) {
    await h.page.getByRole('tablist', { name: '历史脚本工作区', exact: true }).getByRole('tab', { name: /^稿件库/ }).click()
    await h.page.locator('#rewritten-script').fill('清除发表定位时仍须保留的人工修改。')
    await h.page.getByRole('tablist', { name: '历史脚本工作区', exact: true }).getByRole('tab', { name: '百家号发表', exact: true }).click()
  }
  await h.panel.getByRole('button', { name: '清除定位', exact: true }).click()
  await h.page.waitForURL(url => !url.searchParams.has('script') && !url.searchParams.has('videoId'))
  await inventory.locator('.version-row').nth(2).waitFor()
  assert.equal(await inventory.locator('input[type="checkbox"]:checked').count(), 0)
  assert.equal(h.mutations().length, 0)
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  if (width === 1440) {
    await h.page.getByRole('tablist', { name: '历史脚本工作区', exact: true }).getByRole('tab', { name: /^稿件库/ }).click()
    assert.equal(await h.page.locator('#rewritten-script').inputValue(), '清除发表定位时仍须保留的人工修改。')
  }
})

test('Nuxt UI: automatic hidden-library selection cannot add a focus to the global publication route', async t => {
  const h = await uiHarness(t, { libraryItems: [{ id: 58, title: '稿件库首条作品', status: 'needs_review' }] })
  await h.page.locator('#rewritten-script').waitFor({ state: 'attached' })
  assert.equal(new URL(h.page.url()).searchParams.has('script'), false)
  assert.equal(await h.panel.locator('.publication-focus').count(), 0)
  assert.equal(h.mutations().length, 0)
})

test('Nuxt UI: selecting a different manuscript clears the former video identity before returning to publication', async t => {
  const h = await uiHarness(t, { path: '/history-scripts?view=uploads&script=57&videoId=102', libraryItems: [{ id: 58, title: '其他稿件', status: 'needs_review' }], state: { candidates: [
    { scriptId: 57, title: '原稿件', versions: [productionVersion('huasheng'), productionVersion('motion')] },
    { scriptId: 58, title: '其他稿件' },
  ] } })
  await h.page.getByRole('tablist', { name: '历史脚本工作区', exact: true }).getByRole('tab', { name: /^稿件库/ }).click()
  await h.page.locator('.source-item').filter({ hasText: '脚本 #58' }).click()
  await h.page.waitForURL(url => url.searchParams.get('script') === '58')
  assert.equal(new URL(h.page.url()).searchParams.has('videoId'), false)
  await h.page.getByRole('tablist', { name: '历史脚本工作区', exact: true }).getByRole('tab', { name: '百家号发表', exact: true }).click()
  await h.panel.locator('.version-row').waitFor()
  assert.equal(await h.panel.locator('.version-row').count(), 1)
  assert.equal(await h.panel.locator('.candidate-section input[type="checkbox"]:checked').count(), 0)
  assert.equal(h.mutations().length, 0)
})

test('Nuxt UI: a focused revision can locate the original unresolved task without a recovery POST', async t => {
  const h = await uiHarness(t, { viewport: { width: 390, height: 844 }, path: '/history-scripts?view=uploads&script=57&videoId=102', state: { candidates: [
    { scriptId: 57, title: '等待核对原提交的修订', versions: [productionVersion('huasheng', 'submitted'), productionVersion('motion', 'attention', { automatic: false, previousJobId: '221', revisionOfVideoId: 88, message: '原发表结果尚未确认，请先核对原任务' })] },
  ], jobs: [job('uncertain', { id: '221', mode: 'publish', videoId: 88, videoProducer: 'motion', message: '原发表结果待核对', result }), job('published', { id: '222', mode: 'publish', videoId: 101, videoProducer: 'huasheng', result: publicationResult(188, true) })] } })
  const inventory = h.panel.locator('.candidate-section')
  assert.equal(await inventory.locator('.version-row').count(), 1)
  assert.equal(await h.panel.locator('.queue-row').count(), 1)
  await inventory.getByRole('button', { name: '查看原发表任务', exact: true }).click()
  const original = h.panel.locator('.queue-row[data-job-id="221"]')
  await original.waitFor()
  assert.equal(await original.getAttribute('data-focused'), 'true')
  assert.equal(await h.page.evaluate(() => document.activeElement?.dataset.jobId), '221')
  assert.equal(await inventory.locator('.version-row[data-state="attention"]').count(), 1)
  assert.equal(await h.panel.getByRole('button', { name: '发表所选版本（0）', exact: true }).isDisabled(), true)
  assert.equal(h.mutations().length, 0)
  assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
})
