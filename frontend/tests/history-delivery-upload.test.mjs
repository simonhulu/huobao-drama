import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'

const componentUrl = new URL('../app/components/HistoryScriptDelivery.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(componentUrl, 'utf8'), { filename: componentUrl.pathname })
assert.deepEqual(errors, [])
const script = compileScript(descriptor, { id: 'delivery-upload-test' }).content
const code = ts.transpileModule(script, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const deliveryUrl = '/api/v1/history-scripts/101/delivery'
const networkError = '视频上传连接中断，未收到上传结果'
const notice = '成片已关联到当前脚本'

function fixture(videoUrl = '/old.mp4', articleGeneration) {
  return {
    title: '服务器标题', baijiahaoTitle: '服务器长标题', description: '服务器简介',
    videoUrl, videoName: '成片.mp4', covers: {}, coverStatus: 'idle', designStatus: 'idle',
    coverDesign: { main_title: '服务器标题', sub_title: '服务器副标题', kicker: '服务器角标', ai_prompt: '服务器画面' },
    ...(articleGeneration ? { articleGeneration } : {}),
  }
}

async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
  await vue.nextTick()
}

async function harness(t, initial = fixture()) {
  const state = { data: structuredClone(initial), reads: [], writes: [], xhrs: [], events: 0, fail: false, deferred: null }
  const timers = new Map()
  let sequence = 0
  class XHR {
    upload = {}
    headers = {}
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(key, value) { this.headers[key] = value }
    send(file) {
      this.file = file
      state.xhrs.push(this)
      state.writes.push({ method: this.method, url: this.url })
    }
    abort() { this.aborted = true }
    async complete(data, status = 200, raw = false) {
      this.status = status
      this.responseText = raw ? data : JSON.stringify({ code: status, data })
      await this.onload()
      await flush()
    }
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports,
    require(id) {
      if (id === 'vue') return vue
      if (id === 'lucide-vue-next') return { Upload: {} }
      if (id === '../../../backend/src/services/video-title-format.js') return { getVideoTitleWarnings: () => [] }
      throw new Error(`Unexpected component import: ${id}`)
    },
    AbortController, XMLHttpRequest: XHR,
    setTimeout(fn, delay) {
      const id = ++sequence
      timers.set(id, { fn, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    async fetch(url, options) {
      state.reads.push({ url, method: options.method, signal: options.signal })
      if (options.method !== 'GET') state.writes.push({ method: options.method, url, body: options.body === undefined ? undefined : JSON.parse(options.body) })
      if (state.deferred) {
        const pending = state.deferred
        state.deferred = null
        return pending
      }
      if (state.fail) throw new Error('fixture GET failure')
      const videoId = Number(new URL(url, 'http://fixture').searchParams.get('video_id'))
      const packaging = state.data.videoPackagings?.find(item => item.videoId === videoId)
      const data = packaging ? { ...state.data, ...packaging } : state.data
      return { ok: true, json: async () => ({ code: 200, data: structuredClone(data) }) }
    },
  })
  // Mount the real setup/lifecycle without rendering DOM or opening a browser.
  const component = module.exports.default
  component.render = () => null
  const renderer = vue.createRenderer({
    createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setElementText() {}, setText() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(component, { scriptId: 101, onVideoChange: () => state.events++ })
  app.mount({})
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    app.unmount()
    assert.equal(timers.size, 0, 'Unmount must clear every owned poll timer')
  }
  t.after(close)
  await flush()
  const s = app._instance.setupState
  return {
    s, state, timers, app, close,
    start() {
      s.uploadVideo({ target: { value: 'fixture.mp4', files: [{ name: '新成片.mp4' }] } })
      return state.xhrs.at(-1)
    },
    async tick() {
      assert.equal(timers.size, 1, 'Only one background poll may be scheduled')
      const [id, timer] = [...timers][0]
      timers.delete(id)
      await timer.fn()
      await flush()
    },
  }
}

function assertReadOnlyReconciliation(h) {
  assert.deepEqual(h.state.reads.slice(1).map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: deliveryUrl },
  ], 'An uncertain receipt must trigger exactly one delivery GET')
  assert.deepEqual(h.state.writes, [
    { method: 'PUT', url: `${deliveryUrl}/video` },
  ], 'Reconciliation must not repeat the PUT')
}

function formSnapshot(h) {
  return JSON.parse(JSON.stringify(h.s.form))
}

test('saving uses the publishing title for the screenshot cover and removes legacy generated copy', async t => {
  const h = await harness(t)
  assert.equal(h.s.publishingTitle, '服务器长标题')
  assert.equal(h.s.form.coverDesign.main_title, '服务器标题')
  h.s.publishingTitle = '发布标题保留人物与三年时间'
  assert.equal(h.s.form.coverDesign.main_title, '服务器标题')
  h.s.form.coverDesign.main_title = '独立封面文字'
  await h.s.run('save')
  const saved = h.state.writes.at(-1).body
  assert.equal(saved.title, '发布标题保留人物与三年时间')
  assert.equal(saved.baijiahaoTitle, saved.title)
  assert.equal(saved.coverDesign.main_title, saved.title)
  assert.equal(saved.coverDesign.sub_title, '')
  assert.equal(saved.coverDesign.kicker, '')
  assert.equal(saved.coverDesign.ai_prompt, '')
  assert.equal(saved.coverDesign.thumbnail_layout, 'text-left')
  assert.equal(saved.coverDesign.highlight_text, undefined)
  assert.equal('description' in saved, false)
})

test('screenshot covers can be submitted with a title and no image prompt', async t => {
  const initial = fixture()
  initial.coverDesign = { main_title: '', sub_title: '', kicker: '', ai_prompt: '' }
  const h = await harness(t, initial)
  assert.equal(h.s.hasDesign, true)
  await h.s.run('covers')
  assert.equal(h.state.writes.at(-1).url, `${deliveryUrl}/covers`)
  assert.equal(h.state.writes.at(-1).body.coverDesign.main_title, '服务器长标题')
  assert.equal(h.state.writes.at(-1).body.coverDesign.ai_prompt, '')
})

test('the cover editor exposes one title and screenshot commands without image creation controls', () => {
  const template = descriptor.template.content
  assert.match(template, /整理原标题/)
  assert.match(template, /生成截图封面/)
  assert.doesNotMatch(template, /v-model="form\.coverDesign\./)
  assert.doesNotMatch(template, /画面提示词|封面文字独立提炼|审核当前方案|再次计费/)
})

function video(id, producer, suffix = '') {
  return { id, producer, videoUrl: `/video-${id}.mp4`, videoName: `${producer}${suffix}.mp4`, duration: 64, scriptSha256: 'current' }
}

function scopedFixture() {
  const huasheng = video(10, 'huasheng'), motion = video(11, 'motion')
  const packaging = (item, title) => ({ ...fixture(item.videoUrl), videoId: item.id, producer: item.producer,
    title, baijiahaoTitle: title, coverDesign: { main_title: `${title}封面`, ai_prompt: `${title}画面` },
    covers: { '16:9': `/covers/${item.producer}.png` } })
  return { ...fixture(), videos: [huasheng, motion], videoHistory: [motion, huasheng],
    videoPackagings: [packaging(huasheng, '花生独立标题'), packaging(motion, '精细化独立标题')] }
}

test('each selected video uses its own title, covers and scoped save endpoint without borrowing shared metadata', async t => {
  const h = await harness(t, scopedFixture())
  assert.equal(h.s.publishingTitle, '花生独立标题')
  assert.equal(h.s.delivery.covers['16:9'], '/covers/huasheng.png')
  await h.s.selectVideo(11)
  assert.equal(h.s.publishingTitle, '精细化独立标题')
  assert.equal(h.s.form.coverDesign.main_title, '精细化独立标题封面')
  assert.equal(h.s.delivery.covers['16:9'], '/covers/motion.png')
  h.s.publishingTitle = '精细化手工修改'
  await h.s.run('save')
  assert.equal(h.state.writes.at(-1).url, `${deliveryUrl}?video_id=11`)
  assert.equal(h.state.writes.at(-1).body.baijiahaoTitle, '精细化手工修改')
})

test('unsaved copy stays with its video across switching and cannot be sent with another video', async t => {
  const h = await harness(t, scopedFixture())
  h.s.publishingTitle = '花生尚未保存'
  h.s.form.coverDesign.ai_prompt = '花生草稿画面'
  await h.s.selectVideo(11)
  assert.equal(h.s.publishingTitle, '精细化独立标题')
  await h.s.selectVideo(10)
  assert.equal(h.s.publishingTitle, '花生尚未保存')
  assert.equal(h.s.form.coverDesign.ai_prompt, '花生草稿画面')
  assert.equal(h.state.writes.length, 0)
  await h.s.run('covers')
  assert.equal(h.state.writes.at(-1).url, `${deliveryUrl}/covers?video_id=10`)
  assert.equal(h.state.writes.at(-1).body.coverDesign.ai_prompt, '')
  assert.equal(h.state.writes.at(-1).body.coverDesign.main_title, '花生尚未保存')
})

test('a missing video package starts empty instead of displaying legacy shared title or covers', async t => {
  const initial = scopedFixture()
  initial.videoPackagings[0] = { videoId: 10, producer: 'huasheng', title: '', baijiahaoTitle: '',
    coverDesign: { main_title: '', ai_prompt: '' }, covers: {}, coverStatus: 'idle', designStatus: 'idle' }
  const h = await harness(t, initial)
  assert.equal(h.s.publishingTitle, '')
  assert.equal(h.s.form.coverDesign.ai_prompt, '')
  assert.equal(Object.keys(h.s.delivery.covers).length, 0)
  assert.equal(h.s.delivery.videoId, 10)
})

test('a late package response cannot overwrite a newly selected video or its unsaved copy', async t => {
  const h = await harness(t, scopedFixture())
  let release
  h.state.deferred = new Promise(resolve => { release = resolve })
  const pending = h.s.selectVideo(11)
  await flush()
  await h.s.selectVideo(10)
  h.s.publishingTitle = '花生当前草稿'
  release({ ok: true, json: async () => ({ code: 200, data: { ...h.state.data, ...h.state.data.videoPackagings[1] } }) })
  await pending
  await flush()
  assert.equal(h.s.selectedVideo.id, 10)
  assert.equal(h.s.publishingTitle, '花生当前草稿')
  assert.equal(h.s.delivery.videoId, 10)
})

test('an explicitly regenerated design replaces a previously restored draft only after completion for that video', async t => {
  const h = await harness(t, scopedFixture())
  h.s.publishingTitle = '花生旧草稿'
  await h.s.selectVideo(11)
  await h.s.selectVideo(10)
  h.state.data.videoPackagings[0].designStatus = 'generating'
  await h.s.run('design')
  assert.equal(h.s.publishingTitle, '花生旧草稿')
  h.state.data.videoPackagings[0] = { ...h.state.data.videoPackagings[0], designStatus: 'completed',
    baijiahaoTitle: '花生明确重新生成', coverDesign: { main_title: '花生新封面', ai_prompt: '花生新方案' } }
  await h.tick()
  assert.equal(h.s.publishingTitle, '花生明确重新生成')
  assert.equal(h.state.writes.at(-1).url, `${deliveryUrl}/design?video_id=10`)
})

test('two current producers remain separately selectable and history cannot replace either one', async t => {
  const huasheng = video(10, 'huasheng'), motion = video(11, 'motion'), old = video(9, 'motion', '-old')
  const h = await harness(t, { ...fixture(huasheng.videoUrl), videos: [huasheng, motion], videoHistory: [motion, huasheng, old] })
  assert.deepEqual(Array.from(h.s.videoItems, item => item.producer), ['huasheng', 'motion'])
  assert.equal(h.s.selectedVideo.id, 10)
  h.s.selectedVideoId = 11
  assert.equal(h.s.selectedVideo.videoUrl, motion.videoUrl)
  assert.deepEqual(Array.from(h.s.archivedVideos, item => item.id), [9])
  h.state.data = { ...h.state.data, videos: [motion, huasheng] }
  await h.s.load(false)
  assert.equal(h.s.selectedVideo.id, 11, 'An update must retain the chosen producer')
  assert.equal(h.state.writes.length, 0)
})

test('legacy media remains available after two-version records arrive', async t => {
  const h = await harness(t)
  assert.equal(h.s.selectedVideo.producer, 'legacy')
  h.state.data = { ...fixture(), videos: [video(10, 'huasheng')], videoHistory: [video(10, 'huasheng')] }
  await h.s.load(false)
  assert.equal(h.s.selectedVideo.producer, 'huasheng')
  assert.deepEqual(Array.from(h.s.archivedVideos, item => item.videoUrl), ['/old.mp4'])
})

test('a source-title plan is selected without requiring a legacy review', async t => {
  const h = await harness(t, { ...fixture(), coverPlanStatus: 'selected', coverPlan: {
    selection_mode: 'source-title', selected_id: 'one', candidates: [{ id: 'one' }], reviews: [],
  } })
  assert.equal(h.s.selectionOnly, true)
  assert.equal(h.s.hasCurrentPlan, true)
  assert.equal(h.s.hasCurrentReview, false)
})

test('refresh shows automatically generated products after an idle delivery, including a legacy title without a cover plan', async t => {
  const initial = fixture()
  delete initial.coverDesign
  const h = await harness(t, initial)
  h.state.data = { ...fixture('/auto.mp4', { status: 'completed' }), title: '自动生成标题', baijiahaoTitle: '自动生成发布标题',
    description: '自动生成简介', designStatus: 'completed', coverDesign: { main_title: '自动生成标题', ai_prompt: '自动封面方案' } }
  await h.s.load(false)
  assert.equal(h.s.form.baijiahaoTitle, '自动生成发布标题')
  assert.equal(h.s.form.coverDesign.ai_prompt, '自动封面方案')
  assert.equal(h.s.delivery.videoUrl, '/auto.mp4')
  assert.equal(h.state.writes.length, 0)
})

test('background generation completion refreshes status and video without replacing unsaved publishing copy', async t => {
  const h = await harness(t)
  h.s.publishingTitle = '人工未保存标题'
  h.s.form.coverDesign.ai_prompt = '人工未保存画面'
  const edited = formSnapshot(h)
  h.state.data = { ...fixture('/auto.mp4'), designStatus: 'generating' }
  await h.s.load(false)
  h.state.data = { ...fixture('/auto.mp4', { status: 'completed' }), designStatus: 'completed',
    coverDesign: { main_title: '后台新标题', ai_prompt: '后台新方案' } }
  await h.tick()
  assert.deepEqual(formSnapshot(h), edited)
  assert.equal(h.s.delivery.designStatus, 'completed')
  assert.equal(h.s.delivery.videoUrl, '/auto.mp4')
  assert.equal(h.s.delivery.articleGeneration.status, 'completed')
  assert.equal(h.state.writes.length, 0)
})

test('explicit design generation accepts the new result when its background work completes', async t => {
  const h = await harness(t)
  h.s.publishingTitle = '待替换的草稿'
  h.state.data = { ...fixture(), designStatus: 'generating' }
  await h.s.run('design')
  assert.equal(h.s.form.baijiahaoTitle, '待替换的草稿', 'Accepting a job preserves the draft until its replacement succeeds')
  h.state.data = { ...fixture(), baijiahaoTitle: '重新生成发布标题', designStatus: 'completed', coverDesign: { main_title: '重新生成标题', ai_prompt: '重新生成方案' } }
  await h.tick()
  assert.equal(h.s.form.baijiahaoTitle, '重新生成发布标题')
  assert.equal(h.s.form.coverDesign.ai_prompt, '重新生成方案')
  assert.deepEqual(h.state.writes, [{ method: 'POST', url: `${deliveryUrl}/design`, body: {} }])
})

for (const status of ['queued', 'generating', 'completed', 'failed', 'idle', undefined]) {
  test(`lost network response reconciles committed video while ignoring ${status || 'missing'} legacy article status and preserves cover drafts`, async t => {
    const h = await harness(t)
    Object.assign(h.s.form, {
      baijiahaoTitle: '未保存长标题',
      coverDesign: { main_title: '未保存标题', sub_title: '未保存副标题', kicker: '未保存角标', ai_prompt: '未保存画面' },
    })
    const draft = formSnapshot(h)
    const xhr = h.start()
    h.state.data = fixture('/new.mp4', status ? { status, ...(status === 'failed' ? { message: '真实生成错误' } : {}) } : undefined)
    await xhr.onerror()
    await flush()
    assertReadOnlyReconciliation(h)
    assert.equal(h.s.delivery.videoUrl, '/new.mp4')
    assert.equal(h.s.videoNotice, notice)
    assert.equal(h.s.videoError, '')
    assert.equal(h.state.events, 1)
    assert.deepEqual(formSnapshot(h), draft)
    assert.equal(h.timers.size, 0, 'Historical article state no longer starts polling')
    if (status === 'failed') assert.equal(h.s.delivery.articleGeneration.message, '真实生成错误')
  })
}

test('unchanged video URL preserves the original network error through cover refresh', async t => {
  const h = await harness(t, fixture('/old.mp4'))
  await h.start().onerror()
  await flush()
  assertReadOnlyReconciliation(h)
  assert.equal(h.s.videoError, networkError)
  assert.equal(h.s.videoNotice, '')
  assert.equal(h.state.events, 0)
  h.state.data = { ...fixture('/old.mp4'), coverStatus: 'generating' }
  await h.s.load(false)
  assert.equal(h.s.videoError, networkError)
  assert.equal(h.state.writes.length, 1)
})

test('a missing video URL is not treated as a recovered submission', async t => {
  const initial = fixture()
  delete initial.videoUrl
  const h = await harness(t, initial)
  await h.start().onerror()
  await flush()
  assertReadOnlyReconciliation(h)
  assert.equal(h.s.videoError, networkError)
  assert.equal(h.s.videoNotice, '')
  assert.equal(h.state.events, 0)
})

test('failed reconciliation retains an unconfirmed-result warning through a later background refresh', async t => {
  const h = await harness(t, fixture('/old.mp4'))
  const xhr = h.start()
  h.state.fail = true
  await xhr.onerror()
  await flush()
  assertReadOnlyReconciliation(h)
  const message = h.s.videoError
  assert.match(message, /结果未确认，请刷新成片/)
  assert.match(message, /勿重复提交/)
  assert.equal(h.s.videoNotice, '')
  h.state.fail = false
  await h.s.load(false)
  assert.equal(h.s.videoError, message)
  assert.equal(h.state.writes.length, 1)
})

test('invalid JSON in a 2xx receipt recovers a committed upload using only GET', async t => {
  const h = await harness(t)
  const xhr = h.start()
  h.state.data = fixture('/new.mp4', { status: 'queued' })
  await xhr.complete('{', 200, true)
  assertReadOnlyReconciliation(h)
  assert.equal(h.s.delivery.videoUrl, '/new.mp4')
  assert.equal(h.s.videoNotice, notice)
  assert.equal(h.s.videoError, '')
  assert.equal(h.state.events, 1)
})

test('invalid JSON in a 2xx receipt with an unchanged URL preserves its parse error', async t => {
  const h = await harness(t)
  await h.start().complete('{', 200, true)
  assertReadOnlyReconciliation(h)
  assert.match(h.s.videoError, /JSON|position|property|Expected/i)
  assert.equal(h.s.videoNotice, '')
  assert.equal(h.state.events, 0)
})

for (const raw of ['{', JSON.stringify({ code: 422, message: '服务器拒绝此视频' })]) {
  test(`HTTP 422 with ${raw === '{' ? 'invalid JSON' : 'a backend message'} retains its error after reconciliation`, async t => {
    const h = await harness(t)
    await h.start().complete(raw, 422, true)
    assertReadOnlyReconciliation(h)
    assert.ok(h.s.videoError)
    assert.equal(h.state.events, 0)
    if (raw !== '{') assert.equal(h.s.videoError, '服务器拒绝此视频')
  })
}

test('pending reconciliation locks duplicate submissions and rejects a previous script response', async t => {
  const h = await harness(t)
  let release
  h.state.deferred = new Promise(resolve => { release = resolve })
  const xhr = h.start()
  const pending = xhr.onerror()
  await flush()
  assert.equal(h.s.busy, true)
  assert.equal(h.s.action, 'reconcile-upload')
  h.start()
  await xhr.onerror()
  assertReadOnlyReconciliation(h)
  assert.equal(h.state.xhrs.length, 1)
  h.app._instance.props.scriptId = 102
  h.state.data = fixture('/other-script.mp4', { status: 'completed' })
  await flush()
  assert.equal(h.state.reads[1].signal.aborted, true)
  release({ ok: true, json: async () => ({ data: fixture('/stale.mp4', { status: 'queued' }) }) })
  await pending
  await flush()
  assert.equal(h.s.delivery.videoUrl, '/other-script.mp4')
  assert.equal(h.s.videoNotice, '')
  assert.equal(h.s.videoError, '')
  assert.equal(h.state.events, 0)
})

test('the source guard skips reconciliation before the script watcher advances generation', async t => {
  const h = await harness(t)
  const xhr = h.start()
  h.app._instance.props.scriptId = 102
  const pending = xhr.onerror()
  h.state.data = fixture('/other-script.mp4')
  await pending
  await flush()
  assert.deepEqual(h.state.reads.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: deliveryUrl },
    { method: 'GET', url: '/api/v1/history-scripts/102/delivery' },
  ])
  assert.equal(h.state.events, 0)
  assert.equal(h.state.writes.length, 1)
})

test('unmount cancels the owned reconciliation and ignores its late response', async t => {
  const h = await harness(t)
  let release
  h.state.deferred = new Promise(resolve => { release = resolve })
  const pending = h.start().onerror()
  await flush()
  assertReadOnlyReconciliation(h)
  h.close()
  assert.equal(h.state.reads[1].signal.aborted, true)
  release({ ok: true, json: async () => ({ data: fixture('/stale.mp4', { status: 'queued' }) }) })
  await pending
  await flush()
  assert.equal(h.state.events, 0)
  assert.equal(h.timers.size, 0)
})

for (const [label, data] of [
  ['missing data', undefined], ['missing URL', {}], ['null URL', fixture(null)],
  ['empty URL', fixture('')], ['whitespace URL', fixture('  ')], ['nonstring URL', fixture(17)],
]) {
  test(`valid JSON 2xx receipt with ${label} requires GET confirmation before acknowledging success`, async t => {
    const h = await harness(t)
    const xhr = h.start()
    h.state.data = fixture('/accepted.mp4', { status: 'queued' })
    await xhr.complete(JSON.stringify({ code: 200, ...(data === undefined ? {} : { data }) }), 200, true)
    assertReadOnlyReconciliation(h)
    assert.equal(h.s.delivery.videoUrl, '/accepted.mp4')
    assert.equal(h.s.videoNotice, notice)
    assert.equal(h.s.videoError, '')
    assert.equal(h.state.events, 1)
  })
}

test('a missing-URL 2xx receipt with an unchanged GET result keeps its validation error', async t => {
  const h = await harness(t)
  await h.start().complete(fixture(''))
  assertReadOnlyReconciliation(h)
  assert.equal(h.s.videoError, '上传响应未包含有效的成片链接')
  assert.equal(h.s.videoNotice, '')
  assert.equal(h.state.events, 0)
})

for (const status of [500, 400, 413]) {
  test(`HTTP ${status} after commit recovers the actual video with one GET`, async t => {
    const h = await harness(t)
    const xhr = h.start()
    h.state.data = fixture('/committed-before-response.mp4', { status: 'queued' })
    await xhr.complete(JSON.stringify({ code: status, message: '响应构建失败' }), status, true)
    assertReadOnlyReconciliation(h)
    assert.equal(h.s.delivery.videoUrl, '/committed-before-response.mp4')
    assert.equal(h.s.videoNotice, notice)
    assert.equal(h.s.videoError, '')
    assert.equal(h.state.events, 1)
  })
}

test('HTTP 500 with no committed video change keeps the original backend error', async t => {
  const h = await harness(t)
  await h.start().complete(JSON.stringify({ code: 500, message: '原始服务端错误' }), 500, true)
  assertReadOnlyReconciliation(h)
  assert.equal(h.s.videoError, '原始服务端错误')
  assert.equal(h.s.videoNotice, '')
  assert.equal(h.state.events, 0)
})

for (const raw of [false, true]) {
  test(`a valid ${raw ? 'raw' : 'wrapped'} upload receipt succeeds without an extra GET`, async t => {
    const h = await harness(t)
    const accepted = fixture('/new.mp4', { status: 'queued' })
    await h.start().complete(raw ? JSON.stringify(accepted) : accepted, 200, raw)
    assert.equal(h.s.videoNotice, notice)
    assert.equal(h.s.videoError, '')
    assert.equal(h.state.events, 1)
    assert.equal(h.state.reads.length, 1)
    assert.deepEqual(h.state.writes, [{ method: 'PUT', url: `${deliveryUrl}/video` }])
  })
}
