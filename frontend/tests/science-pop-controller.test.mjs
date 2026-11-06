import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
const file = new URL('../app/pages/science-pop/index.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file.pathname })
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: file.pathname, id: 'science' }).errors, [])
const code = ts.transpileModule(compileScript(descriptor, { id: 'science' }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const BASE = '/science-pop/workflow', plain = value => JSON.parse(JSON.stringify(value))
const account = name => ({ accountName: name, label: name, status: 'ready', isDefault: true })
const job = (id, extra = {}) => ({ id, title: `科普 ${id}`, sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', status: 'paused', stage: 'produce', transcript: `原稿 ${id}`, script: `二创 ${id}`, huashengAccountName: 'science-hs', baijiahaoAccountName: 'science-bj', checkpoint: null, projectUrl: null, videoUrl: null, upload: null, ...extra })
const overview = () => ({ jobs: [job('first'), job('second')], accounts: { huasheng: { accounts: [account('science-hs')], defaultAccountName: 'science-hs' }, baijiahao: { accounts: [account('science-bj')], defaultAccountName: 'science-bj' } } })
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function flush() { for (let n = 0; n < 14; n++) await Promise.resolve(); await vue.nextTick() }
async function harness(t) {
  const state = { overview: overview(), requests: [], get: null, post: null, patch: null, del: null, confirm: true, confirmations: [] }, timers = new Map(), listeners = new Map()
  let timerId = 0
  const window = { confirm(message) { state.confirmations.push(message); return state.confirm }, setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id }, clearInterval(id) { timers.delete(id) }, addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name) { listeners.delete(name) } }
  const api = {
    async get(path) {
      state.requests.push({ method: 'GET', path }); const value = await state.get?.(path)
      if (value !== undefined) return value
      if (path === BASE) return structuredClone(state.overview)
      const item = state.overview.jobs.find(job => job.id === path.split('/').at(-1))
      if (item) return structuredClone(item)
      throw new Error(`Unexpected GET ${path}`)
    },
    async patch(path, body) {
      state.requests.push({ method: 'PATCH', path, body: plain(body) }); if (state.patch) return state.patch(path, body)
      const item = state.overview.jobs.find(job => path.endsWith(`/${job.id}`)); Object.assign(item, body); return structuredClone(item)
    },
    async post(path, body) {
      state.requests.push({ method: 'POST', path, body: plain(body) }); if (state.post) return state.post(path, body)
      const item = state.overview.jobs.find(job => path.includes(`/jobs/${job.id}/`)); Object.assign(item, { status: 'running' }); return structuredClone(item)
    },
    async del(path) {
      state.requests.push({ method: 'DELETE', path }); if (state.del) return state.del(path)
      const id = path.split('/').at(-1)
      state.overview.jobs = state.overview.jobs.filter(item => item.id !== id)
      return { deleted: true, id }
    },
  }
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, window, definePageMeta() {}, require(id) {
    if (id === 'vue') return vue
    if (id === 'lucide-vue-next' || id.endsWith('.vue')) return {}
    if (id === '~/composables/useApi') return { api }
    throw new Error(`Unexpected import ${id}`)
  } })
  const component = module.exports.default; component.render = () => null
  const renderer = vue.createRenderer({ createComment: () => ({}), createElement: () => ({}), createText: () => ({}), insert() {}, remove() {}, patchProp() {}, setElementText() {}, setText() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp(component); app.mount({})
  t.after(() => { app.unmount(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0) })
  await flush(); return { s: app._instance.setupState, state, timers, listeners }
}
test('unsaved edits survive polling and switching tasks', async t => {
  const h = await harness(t); h.s.editor.script = '保留我的人工改稿'; await h.s.refresh()
  assert.equal(h.s.editor.script, '保留我的人工改稿')
  await h.s.selectJob('second'); assert.equal(h.s.editor.script, '二创 second')
  await h.s.selectJob('first'); assert.equal(h.s.editor.script, '保留我的人工改稿'); assert.equal(h.s.dirty, true)
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})
test('save failure keeps edits and blocks production dispatch', async t => {
  const h = await harness(t); h.s.editor.script = '待保存的新稿'; h.state.patch = async () => { throw new Error('服务暂时不可用') }
  await h.s.runAction('produce', { upload: true }); assert.equal(h.s.actionError, '服务暂时不可用'); assert.equal(h.s.dirty, true)
  assert.equal(h.s.editor.script, '待保存的新稿'); assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 0)
})
test('production saves edited text and account selection before dispatching upload choice', async t => {
  const h = await harness(t); h.s.editor.script = '已经校对的稿件'; h.s.editor.baijiahaoAccountName = 'science-bj-other'
  await h.s.runAction('produce', { upload: true }); const writes = h.state.requests.filter(item => item.method !== 'GET')
  assert.deepEqual(writes.map(item => item.method), ['PATCH', 'POST'])
  assert.deepEqual(writes[0].body, { script: '已经校对的稿件', baijiahaoAccountName: 'science-bj-other' })
  assert.equal(writes[1].path, `${BASE}/jobs/first/produce`); assert.deepEqual(writes[1].body, { upload: true }); assert.equal(h.s.dirty, false)
})
test('generating missing covers only dispatches the cover job and preserves unsaved task edits', async t => {
  const h = await harness(t)
  h.s.editor.baijiahaoAccountName = 'unsaved-account'
  await h.s.runAction('covers')
  const writes = h.state.requests.filter(item => item.method !== 'GET')
  assert.deepEqual(writes.map(item => [item.method, item.path, item.body]), [['POST', `${BASE}/jobs/first/covers`, {}]])
  assert.equal(h.s.editor.baijiahaoAccountName, 'unsaved-account'); assert.equal(h.s.dirty, true)
})
test('late detail response cannot replace newly selected job', async t => {
  const h = await harness(t), old = deferred(); h.state.get = path => path.endsWith('/jobs/first') ? old.promise : undefined
  const oldRequest = h.s.loadDetail('first'); await h.s.selectJob('second'); old.resolve(job('first', { script: '过期结果' })); await oldRequest
  assert.equal(h.s.selectedJob.id, 'second'); assert.equal(h.s.editor.script, '二创 second')
})
test('deletion preserves the neighboring editor and removes only the confirmed task and its drafts', async t => {
  const h = await harness(t)
  await h.s.selectJob('second'); h.s.editor.script = '保留第二条的修改'
  await h.s.selectJob('first'); h.s.editor.script = '删除第一条的修改'; h.s.coverInstruction = '删除第一条的封面指令'
  h.s.recovery.projectUrl = 'https://www.huasheng.cn/video/old'
  await h.s.deleteTask()
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [{ method: 'DELETE', path: `${BASE}/jobs/first` }])
  assert.match(h.state.confirmations[0], /科普 first.*[\s\S]*本地素材、成片和平台发布记录保留.*[\s\S]*后续采集会跳过.*[\s\S]*未保存/)
  assert.deepEqual(plain(h.s.jobs.map(item => item.id)), ['second'])
  assert.equal(h.s.selectedId, 'second'); assert.equal(h.s.editor.script, '保留第二条的修改')
  assert.equal(h.s.drafts.first, undefined); assert.equal(h.s.coverDrafts.first, undefined); assert.equal(h.s.recoveryDrafts.first, undefined)
})
test('deletion requires confirmation and a stopped task, and a failed request retains local work', async t => {
  const h = await harness(t)
  h.state.confirm = false; await h.s.deleteTask()
  assert.equal(h.state.requests.filter(item => item.method === 'DELETE').length, 0)
  h.state.confirm = true
  for (const status of ['queued', 'running', 'waiting_remote', 'awaiting_export']) {
    h.s.acceptJob(job('first', { status })); await h.s.deleteTask()
    assert.equal(h.s.canDeleteTask, false)
  }
  assert.equal(h.state.confirmations.length, 1)
  h.s.acceptJob(job('first', { status: 'paused' })); h.s.editor.script = '失败后保留的修改'
  h.state.del = async () => { throw new Error('任务正在同步，请稍后重试') }
  await h.s.deleteTask()
  assert.equal(h.s.actionError, '任务正在同步，请稍后重试'); assert.equal(h.s.actionBusy, '')
  assert.equal(h.s.selectedId, 'first'); assert.equal(h.s.editor.script, '失败后保留的修改')
  assert.deepEqual(plain(h.s.jobs.map(item => item.id)), ['first', 'second'])
})
test('late polling and detail responses cannot restore a deleted task', async t => {
  const h = await harness(t), staleOverview = deferred(), staleDetail = deferred()
  h.state.get = path => path === BASE ? staleOverview.promise : path.endsWith('/jobs/first') ? staleDetail.promise : undefined
  const refresh = h.s.refresh(), detail = h.s.loadDetail('first')
  await h.s.deleteTask()
  staleDetail.resolve(job('first')); staleOverview.resolve(overview())
  await Promise.all([refresh, detail])
  assert.deepEqual(plain(h.s.jobs.map(item => item.id)), ['second'])
  assert.equal(h.s.selectedId, 'second'); assert.equal(h.s.drafts.first, undefined)
})
test('deleting a task while another is selected keeps that selection, and deleting the last task clears detail', async t => {
  const h = await harness(t), pending = deferred()
  h.state.del = () => pending.promise
  const deletion = h.s.deleteTask()
  await h.s.selectJob('second'); h.s.editor.script = '保留当前任务的修改'
  h.state.overview.jobs = h.state.overview.jobs.filter(item => item.id !== 'first')
  pending.resolve({ deleted: true, id: 'first' }); await deletion
  assert.equal(h.s.selectedId, 'second'); assert.equal(h.s.editor.script, '保留当前任务的修改')
  h.state.del = null; await h.s.deleteTask()
  assert.equal(h.s.selectedId, ''); assert.equal(h.s.selectedJob, null); assert.equal(h.s.jobs.length, 0)
  assert.equal(h.s.mobileDetail, false); assert.equal(Object.keys(h.s.drafts).length, 0)
})
test('new defaults do not change existing task account bindings', async t => {
  const h = await harness(t); h.s.updateAccounts('huasheng', { accounts: [account('new-default')], defaultAccountName: 'new-default' }); await h.s.openImport()
  assert.equal(h.s.newJob.huashengAccountName, 'new-default'); assert.equal(h.s.editor.huashengAccountName, 'science-hs'); assert.equal(h.s.dirty, false)
  h.s.acceptJob(job('first', { checkpoint: 'script_submitted', projectUrl: 'https://www.huasheng.cn/video/123' })); assert.equal(h.s.scriptLocked, true)
})
test('single-video import requires Huasheng and starts automatic video production in one request', async t => {
  const h = await harness(t)
  await h.s.openImport()
  h.s.newJob.sourceUrl = ' https://youtu.be/video000001 '
  h.s.newJob.huashengAccountName = ''
  await h.s.createJob()
  assert.equal(h.s.importError, '请选择花生制作账号')
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 0)
  h.s.newJob.huashengAccountName = 'science-hs'
  h.s.newJob.baijiahaoAccountName = ''
  h.state.post = async (path, payload) => {
    assert.equal(path, `${BASE}/jobs`)
    const created = job('automatic', { ...payload, status: 'queued', script: '', transcript: '' })
    h.state.overview.jobs.unshift(created)
    return created
  }
  await h.s.createJob()
  assert.deepEqual(h.state.requests.filter(item => item.method === 'POST'), [{ method: 'POST', path: `${BASE}/jobs`, body: {
    sourceUrl: 'https://youtu.be/video000001', mode: 'videos', huashengAccountName: 'science-hs', baijiahaoAccountName: null,
  } }])
  assert.equal(h.s.selectedId, 'automatic'); assert.equal(h.s.statusLabel(h.s.selectedJob), '排队制作')
  assert.equal(h.s.canResumeProduction, false); assert.equal(h.s.isRunning, true)
})
test('single-video import with a Baijiahao account explicitly continues through publication', async t => {
  const h = await harness(t)
  await h.s.openImport()
  h.s.newJob.sourceUrl = 'https://youtu.be/video000002'
  h.state.post = async (path, payload) => {
    const created = job('automatic-upload', { ...payload, status: 'queued' })
    h.state.overview.jobs.unshift(created)
    return created
  }
  await h.s.createJob()
  assert.deepEqual(h.state.requests.filter(item => item.method === 'POST'), [{ method: 'POST', path: `${BASE}/jobs`, body: {
    sourceUrl: 'https://youtu.be/video000002', mode: 'upload', huashengAccountName: 'science-hs', baijiahaoAccountName: 'science-bj',
  } }])
})
test('queued automation locks edits and duplicate starts while paused source preparation can resume', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'queued' }))
  h.s.editor.script = '本地待保存修改'
  await h.s.saveDraft(); await h.s.runAction('produce')
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
  assert.equal(h.s.canDeleteTask, false); assert.equal(h.s.canProduce, false)
  h.state.post = async () => job('first', { status: 'paused', script: '', transcript: '', stage: 'transcribe' })
  await h.s.runAction('cancel')
  h.s.editor.script = ''
  assert.equal(h.s.canResumeProduction, true); assert.equal(h.s.canProduce, true)
  assert.equal(h.state.requests.filter(item => item.method === 'POST')[0].path, `${BASE}/jobs/first/cancel`)
})
test('clean editor accepts background completion and unsaved drafts guard navigation', async t => {
  const h = await harness(t); h.state.overview.jobs[0].script = '后台完成的新稿'; await [...h.timers.values()][0].fn(); assert.equal(h.s.editor.script, '后台完成的新稿')
  let prevented = 0; const event = { preventDefault() { prevented++ } }; h.listeners.get('beforeunload')(event); assert.equal(prevented, 0)
  h.s.editor.script = '本地修改'; h.listeners.get('beforeunload')(event); assert.equal(prevented, 1); assert.equal(event.returnValue, '')
})

test('manual Huasheng sync preserves unsaved edits and only queries the bound project', async t => {
  const h = await harness(t)
  Object.assign(h.state.overview.jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.s.refresh()
  h.s.editor.baijiahaoAccountName = 'unsaved-account'
  await h.s.runAction('sync')
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [{ method: 'POST', path: `${BASE}/jobs/first/sync`, body: {} }])
  assert.equal(h.s.editor.baijiahaoAccountName, 'unsaved-account'); assert.equal(h.s.dirty, true)
  await h.s.runAction('sync')
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
  await h.s.selectJob('second'); await h.s.runAction('sync')
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
})

test('an in-flight refresh cannot overwrite the manual sync result after switching tasks', async t => {
  const h = await harness(t), pending = deferred(), stale = deferred()
  Object.assign(h.state.overview.jobs[0], { projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.s.refresh()
  h.state.post = () => pending.promise
  const sync = h.s.runAction('sync')
  await flush()
  h.state.get = path => path === BASE ? stale.promise : undefined
  const refresh = h.s.refresh()
  await h.s.selectJob('second')
  pending.resolve(job('first', { status: 'running', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/123', message: '正在同步花生制作状态' }))
  await sync
  stale.resolve(overview()); await refresh
  assert.equal(h.s.selectedJob.id, 'second')
  assert.equal(h.s.jobs.find(item => item.id === 'first').status, 'running')
})

test('batch sync preserves edits, rejects duplicate dispatch, and reports actual start and skip counts', async t => {
  const h = await harness(t), pending = deferred()
  Object.assign(h.state.overview.jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.s.refresh(); h.s.editor.baijiahaoAccountName = 'unsaved-account'
  h.state.post = () => pending.promise
  const request = h.s.syncPendingJobs()
  await h.s.syncPendingJobs()
  pending.resolve({ started: ['first'], skipped: ['second'] }); await request
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [{ method: 'POST', path: `${BASE}/sync`, body: {} }])
  assert.match(h.s.batchSyncMessage, /1 条.*1 条/)
  assert.equal(h.s.editor.baijiahaoAccountName, 'unsaved-account'); assert.equal(h.s.dirty, true)
  assert.equal(h.s.batchSyncBusy, false)
})

test('sync failure stays visible and remote states distinguish production, export, and local completion', async t => {
  const h = await harness(t)
  Object.assign(h.state.overview.jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.s.refresh()
  h.state.post = async () => { throw new Error('账号需要重新登录') }
  await h.s.syncPendingJobs()
  assert.equal(h.s.batchSyncError, '账号需要重新登录'); assert.equal(h.s.batchSyncBusy, false)
  assert.equal(h.s.statusLabel(job('waiting', { status: 'waiting_remote', stage: 'produce' })), '花生制作中')
  for (const status of ['not_started', 'queued']) {
    assert.equal(h.s.statusLabel(job('waiting', { status: 'waiting_remote', stage: 'produce', huashengSync: { status } })), '等待花生制作')
  }
  assert.equal(h.s.statusLabel(job('creating', { status: 'waiting_remote', stage: 'produce', huashengSync: { status: 'creating' } })), '花生制作中')
  assert.equal(h.s.statusLabel(job('exporting', { status: 'waiting_remote', stage: 'export' })), '花生导出中')
  assert.equal(h.s.statusLabel(job('export', { status: 'awaiting_export', stage: 'export' })), '排队导出')
})

test('sync completion follows backend export and publication progress without another client action', async t => {
  const h = await harness(t)
  Object.assign(h.state.overview.jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/123' })
  await h.s.refresh(); h.s.editor.baijiahaoAccountName = 'unsaved-account'
  await h.s.runAction('sync')
  Object.assign(h.state.overview.jobs[0], { status: 'running', stage: 'export', message: '花生制作完成，正在自动导出下载成片' })
  await [...h.timers.values()][0].fn()
  assert.equal(h.s.statusLabel(h.s.selectedJob), '导出成片')
  Object.assign(h.state.overview.jobs[0], { status: 'completed', stage: 'completed', message: '已按原生产设置发表', upload: { submitted: true, saved: false }, videoUrl: '/video.mp4' })
  await [...h.timers.values()][0].fn()
  assert.equal(h.s.statusLabel(h.s.selectedJob), '已上传·待审核')
  assert.equal(h.s.editor.baijiahaoAccountName, 'unsaved-account'); assert.equal(h.s.dirty, true)
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [{ method: 'POST', path: `${BASE}/jobs/first/sync`, body: {} }])
})

test('stopping remote production or queued export pauses continuation without saving edits', async t => {
  const h = await harness(t)
  h.state.post = path => {
    assert.equal(path, `${BASE}/jobs/first/cancel`)
    Object.assign(h.state.overview.jobs[0], { status: 'paused', message: '已停止自动接续' })
    return structuredClone(h.state.overview.jobs[0])
  }
  for (const status of ['waiting_remote', 'awaiting_export']) {
    Object.assign(h.state.overview.jobs[0], { status, stage: 'export', projectUrl: 'https://www.huasheng.cn/video/123' })
    await h.s.refresh(); h.s.editor.baijiahaoAccountName = 'unsaved-account'
    await h.s.runAction('cancel')
    assert.equal(h.s.selectedJob.status, 'paused')
    assert.equal(h.s.editor.baijiahaoAccountName, 'unsaved-account'); assert.equal(h.s.dirty, true)
  }
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), Array.from({ length: 2 }, () => ({ method: 'POST', path: `${BASE}/jobs/first/cancel`, body: {} })))
})

test('poster instructions survive polling and task switches, then regenerate without saving script edits', async t => {
  const h = await harness(t)
  Object.assign(h.state.overview.jobs[0], { status: 'ready', videoUrl: '/video.mp4', coverInstruction: '原有指令' })
  await h.s.refresh()
  h.s.coverInstruction = '主体放大，黄色突出为什么'; h.s.editor.script = '保留未保存文稿'
  await h.s.refresh(); assert.equal(h.s.coverInstruction, '主体放大，黄色突出为什么')
  await h.s.selectJob('second'); h.s.coverInstruction = '第二条的独立指令'
  await h.s.selectJob('first'); assert.equal(h.s.coverInstruction, '主体放大，黄色突出为什么')
  h.state.post = (path, body) => {
    assert.equal(path, `${BASE}/jobs/first/covers`)
    Object.assign(h.state.overview.jobs[0], { status: 'running', stage: 'covers', coverInstruction: body.instruction })
    return structuredClone(h.state.overview.jobs[0])
  }
  await h.s.regenerateCovers()
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [{ method: 'POST', path: `${BASE}/jobs/first/covers`, body: { regenerate: true, instruction: '主体放大，黄色突出为什么' } }])
  assert.equal(h.s.coverInstructionDirty, false); assert.equal(h.s.editor.script, '保留未保存文稿'); assert.equal(h.s.dirty, true)
  await h.s.selectJob('second'); assert.equal(h.s.coverInstruction, '第二条的独立指令')
})

test('poster regeneration preserves instructions on failure and refuses missing videos or submitted publications', async t => {
  const h = await harness(t)
  h.s.coverInstruction = '指定封面指令'
  await h.s.regenerateCovers(); assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 0)
  Object.assign(h.state.overview.jobs[0], { status: 'ready', videoUrl: '/video.mp4' }); await h.s.refresh()
  h.state.post = async () => { throw new Error('海报生成暂不可用') }
  await h.s.regenerateCovers()
  assert.equal(h.s.coverInstruction, '指定封面指令'); assert.equal(h.s.coverInstructionDirty, true)
  assert.equal(h.s.actionError, '海报生成暂不可用')
  for (const upload of [{ submitted: true }, { published: true }]) {
    h.s.acceptJob(job('first', { status: 'completed', videoUrl: '/video.mp4', upload }))
    await h.s.regenerateCovers(); assert.equal(h.s.canRegenerateCovers, false)
  }
  h.s.acceptJob(job('first', { status: 'completed', videoUrl: '/video.mp4', upload: { saved: true } }))
  assert.equal(h.s.canRegenerateCovers, true)
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
})

test('poster revisions refresh previews and only full poster assets enable publication', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { videoUrl: '/video.mp4', landscapeCoverUrl: '/landscape.jpg', portraitCoverUrl: '/portrait.jpg', coverRevision: 2 }))
  assert.equal(h.s.posterReady, false)
  assert.deepEqual(plain(h.s.covers.map(cover => cover.url)), ['/landscape.jpg?revision=2', '/portrait.jpg?revision=2'])
  h.s.acceptJob(job('first', { videoUrl: '/video.mp4', coverStyle: 'science-title-poster-v1', landscapeCoverUrl: '/landscape.jpg', portraitCoverUrl: '/portrait.jpg', coverRevision: 3 }))
  assert.equal(h.s.posterReady, true)
  assert.deepEqual(plain(h.s.covers.map(cover => cover.url)), ['/landscape.jpg?revision=3', '/portrait.jpg?revision=3'])
  h.s.acceptJob({ ...plain(h.s.selectedJob), coverGenerationPending: true })
  assert.equal(h.s.posterReady, false)
  assert.deepEqual(plain(h.s.covers.map(cover => cover.url)), ['/landscape.jpg?revision=3', '/portrait.jpg?revision=3'])
  h.s.coverInstruction = '尚未提交的封面指令'
  let prevented = 0; h.listeners.get('beforeunload')({ preventDefault() { prevented++ } })
  assert.equal(prevented, 1)
})

test('automatic production queue is distinct from Baijiahao publication review', async t => {
  const h = await harness(t)
  assert.equal(h.s.statusLabel(job('queued', { status: 'queued' })), '排队制作')
  assert.equal(h.s.statusLabel(job('camel', { status: 'completed', upload: { submitted: true, published: false, saved: false } })), '已上传·待审核')
  assert.equal(h.s.statusLabel(job('published', { status: 'completed', upload: { submitted: true, published: true, saved: false } })), '已发表')
  assert.equal(h.s.statusLabel(job('draft', { status: 'completed', upload: { saved: true } })), '已上传（草稿）')
})

test('existing videos retain accurate upload states without masking cover work', async t => {
  const h = await harness(t)
  const states = [
    ['pending', 'ready', 'covers', '待上传'],
    ['queued', 'queued', 'upload', '上传排队'],
    ['uploading', 'running', 'upload', '上传中'],
    ['uploaded', 'completed', 'completed', '已上传（草稿）'],
    ['submitted', 'completed', 'completed', '已上传·待审核'],
    ['published', 'completed', 'completed', '已发表'],
    ['blocked', 'needs_attention', 'upload', '上传异常'],
    ['uncertain', 'needs_attention', 'upload', '等待自动重传'],
    ['paused', 'paused', 'upload', '上传已暂停'],
  ]
  for (const [uploadStatus, status, stage, label] of states) {
    const item = job(uploadStatus, { uploadStatus, status, stage, videoUrl: '/video.mp4' })
    assert.equal(h.s.statusLabel(item), label)
    assert.equal(h.s.uploadStatusLabel(item), label)
  }
  assert.equal(h.s.statusLabel(job('cover-running', { status: 'running', stage: 'covers', uploadStatus: 'not_ready', videoUrl: '/video.mp4' })), '生成封面')
  assert.equal(h.s.statusLabel(job('cover-blocked', { status: 'needs_attention', stage: 'covers', uploadStatus: 'not_ready', videoUrl: '/video.mp4' })), '封面异常')
  assert.equal(h.s.statusLabel(job('cover-paused', { status: 'paused', stage: 'covers', uploadStatus: 'paused', videoUrl: '/video.mp4' })), '封面已暂停')
  assert.equal(h.s.statusLabel(job('legacy-upload', { status: 'running', stage: 'upload', videoUrl: '/video.mp4' })), '上传中')
  assert.equal(h.s.statusLabel(job('legacy-uncertain', { status: 'needs_attention', stage: 'upload', message: '上传结果尚未确认：原编辑页文案已变化', videoUrl: '/video.mp4' })), '等待自动重传')
})

test('story planning resolves evidence and material references while marking older plans incomplete', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { plan: {
    sourceTheme: '看似微小的发光现象背后有生存作用',
    evidence: [{ id: 'e1', material: '深海动物发光吸引猎物' }],
    emotionalArc: [{ id: 'emotion1', from: '疑惑', to: '惊讶', trigger: '发光用来捕食', evidenceIds: ['e1'] }],
    tellingMaterials: [{ id: 'material1', detail: '黑暗水中亮起的诱饵', evidenceIds: ['e1'], role: '开头的具体画面', disposition: 'retain', reason: '让生存作用可感知' }],
    writingOutline: { sections: [{ telling: { materialIds: ['material1'], emotionIds: ['emotion1'], sceneOrAction: '先看黑暗中的诱饵', explanation: '解释发光如何捕食', nextQuestion: '怎样避免暴露自己？' } }] },
  } }))
  assert.equal(h.s.planNeedsStoryDetails, false)
  assert.equal(h.s.sourceEvidence(['e1', 'unknown']), '深海动物发光吸引猎物')
  assert.equal(h.s.tellingMaterialDetails(['material1']), '黑暗水中亮起的诱饵')
  assert.equal(h.s.emotionChanges(['emotion1']), '疑惑 → 惊讶')
  h.s.acceptJob(job('first', { plan: { sourceSummary: '旧分析', coreClaim: '旧主张', writingOutline: { sections: [{ purpose: '旧大纲' }] } } }))
  assert.equal(h.s.planNeedsStoryDetails, true)
  assert.equal(h.s.tellingMaterialDetails(['material1']), '')
  assert.equal(h.s.emotionChanges(['emotion1']), '')
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('idle queued jobs can start while actual queue owners remain protected', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'queued', executionActive: false }))
  assert.equal(h.s.isRunning, false); assert.equal(h.s.canResumeProduction, true)
  assert.equal(h.s.statusLabel(h.s.selectedJob), '待开始制作')
  assert.equal(h.s.selectedRecovery.actions[0].id, 'produce')
  h.s.acceptJob(job('first', { status: 'queued', executionActive: true }))
  assert.equal(h.s.isRunning, true); assert.equal(h.s.selectedRecovery, null)
  await h.s.runRecoveryAction('produce')
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('queued batch jobs follow their coordinator without dispatching a standalone production', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'queued', executionActive: false, collectionId: 'batch-original' }))
  const run = { id: 'batch-original', status: 'running', mode: 'upload', message: '正在制作本批其他任务', currentJobId: 'second',
    huashengAccountName: 'science-hs', baijiahaoAccountName: 'science-bj' }
  h.s.updateCollectionContext({ loaded: true, runs: [run] })
  assert.equal(h.s.statusLabel(h.s.selectedJob), '等待批次调度')
  assert.equal(h.s.matchesQueueFilter(h.s.selectedJob, 'active'), true)
  assert.equal(h.s.matchesQueueFilter(h.s.selectedJob, 'attention'), false)
  assert.equal(h.s.canResumeProduction, false)
  assert.match(h.s.selectedRecovery.description, /制作并直接发表/)
  assert.deepEqual(plain(h.s.selectedRecovery.actions), [{ id: 'collection', label: '查看所属批次' }])
  const opened = []
  h.s.collection = { revealRun: async id => { opened.push(id); return true } }
  h.s.editor.script = '保留未保存的校对'
  await h.s.runRecoveryAction('collection')
  await h.s.runRecoveryAction('produce')
  await h.s.runAction('produce', { upload: false })
  assert.deepEqual(opened, ['batch-original'])
  assert.equal(h.s.editor.script, '保留未保存的校对')
  assert.equal(h.s.dirty, true)
  assert.equal(run.mode, 'upload')
  assert.equal(run.huashengAccountName, 'science-hs')
  assert.equal(run.baijiahaoAccountName, 'science-bj')
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('batch queue recovery distinguishes blocked, stopped and unavailable collection records', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'queued', executionActive: false, collectionId: 'batch-original' }))
  for (const [status, title, message] of [
    ['needs_attention', '所属批次异常暂停', '花生浏览器连接中断，保留原步骤'],
    ['stopped', '所属批次已停止', '已按要求停止本批'],
    ['interrupted', '所属批次执行中断', '服务执行中断'],
    ['stopping', '所属批次正在停止', '正在停止当前任务'],
    ['completed', '所属批次已结束', '原批次已达到目标'],
  ]) {
    h.s.updateCollectionContext({ loaded: true, runs: [{ id: 'batch-original', mode: 'upload', status, message }] })
    assert.equal(h.s.selectedRecovery.title, title)
    assert.match(h.s.selectedRecovery.description, new RegExp(message))
    assert.equal(h.s.canResumeProduction, false)
    assert.equal(h.s.selectedRecovery.actions[0].id, status === 'stopping' ? 'collection' : 'retry-task')
    assert.equal(h.s.selectedRecovery.actions.some(action => action.id === 'collection'), true)
  }
  h.s.updateCollectionContext({ loaded: true, runs: [] })
  assert.equal(h.s.selectedRecovery.title, '未找到所属批次记录')
  assert.match(h.s.selectedRecovery.description, /尚未提交花生/)
  h.s.updateCollectionContext({ loaded: true, runs: [], error: '批次接口暂不可用' })
  assert.equal(h.s.selectedRecovery.title, '所属批次暂时无法读取')
  assert.match(h.s.selectedRecovery.description, /批次接口暂不可用/)
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('batch queue context keeps current blockers separate from historical collection messages', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'queued', executionActive: false, collectionId: 'batch-original' }))
  h.s.acceptJob(job('quota-other', { status: 'needs_attention', checkpoint: 'quota_waiting', huashengAccountName: 'another-account' }))
  const run = { id: 'batch-original', mode: 'upload', status: 'needs_attention', message: '历史批次记录：浏览器连接中断', retry: { jobIds: ['first'] } }
  h.s.updateCollectionContext({ loaded: true, runs: [run] })
  assert.equal(h.s.selectedRecovery.quotaBlocker, undefined)
  const quota = job('quota-same', { status: 'needs_attention', checkpoint: 'quota_waiting', projectUrl: 'https://www.huasheng.cn/video/12345' })
  h.state.overview.jobs.push(quota)
  h.s.acceptJob(quota)
  assert.equal(h.s.selectedRecovery.quotaBlocker.id, 'quota-same')
  assert.match(h.s.selectedRecovery.description, /历史批次记录：浏览器连接中断/)
  assert.equal(h.s.selectedRecovery.actions.at(-1).id, 'quota-task')
  h.s.editor.script = '轮询期间保留人工改稿'
  h.s.updateCollectionContext({ loaded: true, runs: [{ ...run, message: '已检查窗口，等待继续原批次', retry: { jobIds: ['first', 'second'] } }] })
  assert.match(h.s.selectedRecovery.description, /已检查窗口，等待继续原批次/)
  assert.equal(h.s.editor.script, '轮询期间保留人工改稿')
  await h.s.runRecoveryAction('quota-task')
  assert.equal(h.s.selectedJob.id, 'quota-same')
  assert.equal(h.s.detailError, '')
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('quota waiting identifies the daily standard-mode limit and preserves collection recovery', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'needs_attention', checkpoint: 'quota_waiting', collectionId: 'batch-original',
    projectUrl: 'https://www.huasheng.cn/video/12345', message: '花生返回 10008：标准模式每日额度已用完' }))
  assert.equal(h.s.selectedRecovery.title, '花生标准模式每日额度已用完')
  assert.match(h.s.selectedRecovery.description, /尚未进入制作/)
  assert.match(h.s.selectedRecovery.description, /原项目/)
  assert.equal(h.s.selectedRecovery.actions.some(action => action.id === 'produce'), false)
  assert.equal(h.s.selectedRecovery.actions.some(action => action.id === 'collection'), true)
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('recovery actions distinguish uncertain generation, closed editors, verification and missing project identity', async t => {
  const h = await harness(t)
  const covers = { status: 'needs_attention', stage: 'covers', videoUrl: '/video.mp4' }
  for (const [extra, primary] of [
    [{ ...covers, message: 'API error 502' }, 'cover-retry'],
    [{ ...covers, message: '封面底图已提交但未取得任务编号' }, 'cover-new'],
    [{ ...covers, status: 'paused' }, 'cover-retry'],
    [{ status: 'needs_attention', stage: 'produce', checkpoint: 'create_pending', message: '创建请求未返回' }, 'account'],
    [{ status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/12345', checkpoint: 'submitted', message: '暂时无法核验花生账号身份，请稍后检查' }, 'account'],
    [{ status: 'needs_attention', stage: 'upload', uploadStatus: 'uncertain', hasUploadAttempt: true, videoUrl: '/video.mp4', message: '找不到本次上传的原编辑页' }, 'upload'],
    [{ status: 'needs_attention', stage: 'upload', uploadStatus: 'blocked', hasUploadAttempt: true, videoUrl: '/video.mp4', message: '平台要求人工安全验证' }, 'open-original'],
  ]) {
    const recovery = h.s.recoveryFor(job('case', extra))
    assert.equal(recovery.actions[0].id, primary)
  }
  const missing = h.s.recoveryFor(job('missing', { status: 'needs_attention', stage: 'upload', hasUploadAttempt: true, message: '找不到本次上传的原编辑页' }))
  assert.equal(missing.actions[1].id, 'open-original')
  assert.equal(h.s.recoveryFor(job('done', { status: 'completed', upload: { submitted: true } })), null)
})

test('an unfinished intro composition resumes video production before generating covers', async t => {
  const h = await harness(t)
  const pending = job('first', { status: 'needs_attention', stage: 'export', videoUrl: '/preview.mp4',
    videoCompositionPending: true, message: '片头已拼接；视频合成尚未完成' })
  h.s.acceptJob(pending)
  assert.equal(h.s.selectedRecovery.title, '视频合成尚未完成')
  assert.equal(h.s.selectedRecovery.actions[0].id, 'produce')
  assert.equal(h.s.statusLabel(pending), '视频待合成')
  assert.equal(h.s.canRegenerateCovers, false)
  assert.equal(h.s.posterReady, false)
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('read-only result checks never persist unsaved edits or dispatch a publication', async t => {
  const h = await harness(t)
  h.s.editor.script = '尚未保存的人工改稿'
  h.s.acceptJob(job('first', { status: 'needs_attention', projectUrl: 'https://www.huasheng.cn/video/12345' }))
  h.state.post = async path => ({ ...h.state.overview.jobs[0], uploadCheck: { status: 'pending', message: '原任务待核对' } })
  await h.s.runRecoveryAction('check-upload')
  await h.s.runRecoveryAction('check-huasheng')
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [
    { method: 'POST', path: `${BASE}/jobs/first/check-upload`, body: {} },
    { method: 'POST', path: `${BASE}/jobs/first/check-huasheng`, body: {} },
  ])
  assert.equal(h.s.editor.script, '尚未保存的人工改稿'); assert.equal(h.s.dirty, true)
})

test('cover retry preserves its request while an explicitly confirmed new version uses a separate flag', async t => {
  const h = await harness(t)
  const item = job('first', { status: 'needs_attention', stage: 'covers', videoUrl: '/video.mp4', coverGenerationPending: true })
  h.s.acceptJob(item)
  h.state.post = async () => structuredClone(item)
  await h.s.retryCovers()
  assert.deepEqual(h.state.requests.at(-1), { method: 'POST', path: `${BASE}/jobs/first/covers`, body: {} })
  h.state.confirm = false; await h.s.generateNewCovers()
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
  h.state.confirm = true; await h.s.generateNewCovers()
  assert.deepEqual(h.state.requests.at(-1), { method: 'POST', path: `${BASE}/jobs/first/covers`, body: { newVersion: true, instruction: '' } })
  assert.match(h.state.confirmations.at(-1), /新的生图请求.*视频和封面会保留/)
})

test('queue filters separate issues from active work and delivered results without writes', async t => {
  const h = await harness(t)
  h.s.jobs = [job('attention', { status: 'needs_attention' }), job('idle', { status: 'queued', executionActive: false }),
    job('active', { status: 'running' }), job('delivered', { status: 'completed', upload: { submitted: true } })]
  assert.deepEqual(plain(h.s.queueFilters.map(filter => [filter.id, filter.count])), [['all', 4], ['attention', 2], ['active', 1], ['done', 1]])
  h.s.queueFilter = 'attention'; assert.deepEqual(plain(h.s.filteredJobs.map(job => job.id)), ['attention', 'idle'])
  h.s.search = 'idle'; assert.deepEqual(plain(h.s.filteredJobs.map(job => job.id)), ['idle'])
  assert.equal(h.state.requests.filter(item => item.method !== 'GET').length, 0)
})

test('fresh progress checks replace stale identity and production hints, and remain available during production', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'needs_attention', projectUrl: 'https://www.huasheng.cn/video/12345', checkpoint: 'submitted',
    message: '暂时无法核验花生账号身份', logs: [{ at: '2026-11-02T00:00:00Z', message: '暂时无法核验花生账号身份' }],
    huashengSync: { checkedAt: '2026-11-01T00:00:00Z', status: 'not_started', message: '尚未开始' },
    huashengCheck: { checkedAt: '2026-11-02T00:00:01Z', status: 'completed', message: '已完成' } }))
  assert.equal(h.s.selectedRecovery.title, '花生制作已完成'); assert.equal(h.s.visibleHuashengSync, null)
  h.s.acceptJob({ ...h.s.selectedJob, huashengCheck: { checkedAt: '2026-11-02T00:00:02Z', status: 'creating', message: '正在生成分镜' } })
  assert.equal(h.s.selectedRecovery.title, '花生正在制作')
  h.s.acceptJob({ ...h.s.selectedJob, status: 'running' })
  await h.s.runAction('check-huasheng')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/check-huasheng`)
})

test('continuation acknowledges acceptance, protects active remote waits, and allows read-only checks and stop', async t => {
  const h = await harness(t), pending = deferred()
  const item = job('first', { status: 'needs_attention', projectUrl: 'https://www.huasheng.cn/video/12345' })
  h.s.acceptJob(item)
  h.state.post = () => pending.promise
  const request = h.s.runAction('sync')
  await flush()
  assert.equal(h.s.actionBusy, 'sync')
  await h.s.runAction('sync')
  pending.resolve({ ...item, status: 'waiting_remote', executionActive: true, message: '花生正在制作，完成后自动导出下载' })
  await request
  assert.match(h.s.actionNotice, /已受理.*自动.*继续/)
  assert.equal(h.s.isRunning, true)
  assert.equal(h.s.syncableJobs.length, 0)
  await h.s.runAction('sync')
  assert.equal(h.state.requests.filter(item => item.method === 'POST').length, 1)
  h.state.post = async () => ({ ...item, status: 'waiting_remote', executionActive: true })
  await h.s.runAction('check-huasheng')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/check-huasheng`)
  h.s.acceptJob({ ...item, status: 'awaiting_export', executionActive: true })
  assert.equal(h.s.isRunning, true)
  h.state.post = async () => ({ ...item, status: 'paused', executionActive: false })
  await h.s.runAction('cancel')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/cancel`)
  assert.equal(h.s.isRunning, false)
})

test('the newest Huasheng failure replaces an older completion hint and preserves its historical cause', async t => {
  const h = await harness(t)
  const item = job('first', { status: 'needs_attention', projectUrl: 'https://www.huasheng.cn/video/12345', checkpoint: 'submitted',
    message: '暂时无法核验花生账号身份', logs: [{ at: '2026-11-02T00:00:00Z', message: '暂时无法核验花生账号身份' }],
    huashengCheck: { checkedAt: '2026-11-02T00:01:00Z', status: 'completed', message: '分镜素材已就绪' } })
  h.s.acceptJob(item)
  assert.equal(h.s.recoveryErrorSummary, '历史错误记录')
  h.s.acceptJob({ ...item, huashengSync: { checkedAt: '2026-11-02T00:02:00Z', status: 'error', message: '花生状态同步失败：接口暂不可用' } })
  assert.equal(h.s.selectedRecovery.title, '花生状态暂时无法查询')
  assert.equal(h.s.selectedRecovery.actions[0].id, 'check-huasheng')
  assert.equal(h.s.selectedRecovery.actions.some(action => action.label === '继续导出下载'), false)
  h.s.acceptJob({ ...h.s.selectedJob, huashengCheck: { checkedAt: '2026-11-02T00:03:00Z', status: 'error', message: '身份核验接口暂不可用' } })
  assert.equal(h.s.selectedRecovery.title, '花生状态暂时无法查询')
  assert.equal(h.s.visibleHuashengSync, null)
})

test('automatic recovery shows the retry schedule without blocking an immediate retry', async t => {
  const h = await harness(t)
  h.s.acceptJob(job('first', { status: 'waiting_remote', executionActive: false, projectUrl: 'https://www.huasheng.cn/video/12345',
    automaticRetry: { attempt: 2, maxAttempts: 4, nextRetryAt: '2026-11-02T00:04:00Z' } }))
  assert.equal(h.s.isRunning, false)
  assert.equal(h.s.statusLabel(h.s.selectedJob), '等待自动重试')
  assert.equal(h.s.syncableJobs.length, 1)
  await h.s.runAction('sync')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/sync`)
})

test('a scheduled recovery stays active and offers immediate continuation or an explicit stop', async t => {
  const h = await harness(t)
  const item = job('first', { status: 'retry_wait', executionActive: false, projectUrl: 'https://www.huasheng.cn/video/12345',
    automaticRetry: { attempt: 2, maxAttempts: 4, nextRetryAt: '2026-11-02T00:04:00Z' } })
  h.s.acceptJob(item)
  assert.equal(h.s.isRunning, false)
  assert.equal(h.s.statusLabel(h.s.selectedJob), '等待自动恢复')
  assert.equal(h.s.matchesQueueFilter(h.s.selectedJob, 'active'), true)
  assert.equal(h.s.matchesQueueFilter(h.s.selectedJob, 'attention'), false)
  assert.equal(h.s.canDeleteTask, false)
  assert.equal(h.s.syncableJobs.length, 1)
  assert.deepEqual(plain(h.s.selectedRecovery.actions.map(action => action.id)), ['sync', 'cancel', 'check-huasheng'])
  h.state.post = async path => ({ ...item, automaticRetry: undefined,
    status: path.endsWith('/cancel') ? 'paused' : 'running', executionActive: !path.endsWith('/cancel') })
  await h.s.runRecoveryAction('sync')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/sync`)
  h.s.acceptJob(item)
  await h.s.runRecoveryAction('cancel')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/cancel`)
  assert.equal(h.s.selectedJob.status, 'paused')
})

test('recovery before project creation retries production with the saved publication choice', async t => {
  const h = await harness(t)
  const item = job('first', { status: 'retry_wait', executionActive: false, checkpoint: 'opening', projectUrl: null, autoUpload: true,
    automaticRetry: { attempt: 1, maxAttempts: 3, nextRetryAt: '2026-11-02T00:04:00Z' } })
  h.s.acceptJob(item)
  assert.deepEqual(plain(h.s.selectedRecovery.actions.map(action => action.id)), ['produce', 'cancel'])
  assert.equal(h.s.syncableJobs.length, 0)
  h.state.post = async () => ({ ...item, status: 'running', executionActive: true, automaticRetry: undefined })
  await h.s.runRecoveryAction(h.s.selectedRecovery.actions[0].id)
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [
    { method: 'POST', path: `${BASE}/jobs/first/produce`, body: { upload: true } },
  ])
})

test('opening a Huasheng project delegates to the task-bound profile without saving draft account changes', async t => {
  const h = await harness(t), pending = deferred()
  h.s.acceptJob(job('first', { projectUrl: 'https://www.huasheng.cn/video/12345' }))
  h.s.editor.huashengAccountName = 'unsaved-other-account'
  h.state.post = () => pending.promise
  const opening = h.s.openHuashengProject()
  await h.s.openHuashengProject()
  assert.equal(h.s.actionBusy, 'open-project')
  pending.resolve({ accountName: 'science-hs', projectUrl: 'https://www.huasheng.cn/video/12345', reused: true, message: '已在任务绑定账号打开花生项目' })
  await opening
  assert.deepEqual(h.state.requests.filter(item => item.method !== 'GET'), [{ method: 'POST', path: `${BASE}/jobs/first/open-project`, body: {} }])
  assert.equal(h.s.selectedJob.id, 'first')
  assert.equal(h.s.editor.huashengAccountName, 'unsaved-other-account')
  assert.match(h.s.actionNotice, /绑定账号打开/)
  h.state.post = async () => { throw new Error('原账号浏览器连接失败') }
  await h.s.openHuashengProject()
  assert.equal(h.s.actionError, '原账号浏览器连接失败')
  assert.equal(h.s.actionBusy, '')
})

test('unconfirmed uploads wait for automatic retransmission and offer upload instead of manual reconciliation', async t => {
  const h = await harness(t)
  const item = job('first', { status: 'needs_attention', stage: 'upload', uploadStatus: 'uncertain', hasUploadAttempt: true,
    projectUrl: 'https://www.huasheng.cn/video/12345', videoUrl: '/video.mp4', message: '找不到本次上传的原编辑页，上传结果尚未确认' })
  h.s.acceptJob(item)
  assert.equal(h.s.statusLabel(item), '等待自动重传')
  assert.equal(h.s.matchesQueueFilter(item, 'attention'), false)
  assert.equal(h.s.matchesQueueFilter(item, 'active'), true)
  assert.equal(h.s.selectedRecovery.actions[0].id, 'upload')
  assert.equal(h.s.selectedRecovery.actions.some(action => action.id === 'check-upload'), false)
  h.s.acceptJob({ ...item, status: 'retry_wait', uploadStatus: 'queued', uploadRetry: { attempt: 7, nextRetryAt: '2026-11-02T00:04:00Z' } })
  assert.equal(h.s.selectedRecovery.account, 'baijiahao')
  assert.equal(h.s.selectedRecovery.actions[0].id, 'upload')
  await h.s.runRecoveryAction('upload')
  assert.equal(h.state.requests.at(-1).path, `${BASE}/jobs/first/upload`)
  h.s.acceptJob({ ...item, status: 'paused', uploadStatus: 'uncertain' })
  assert.equal(h.s.uploadStatusLabel(h.s.selectedJob), '上传已暂停')
})
