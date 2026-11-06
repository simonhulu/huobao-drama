import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'
import { chromium } from 'playwright'

const componentUrl = new URL('../app/pages/drama/[id]/episode/[episodeNumber].vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(componentUrl, 'utf8'), { filename: componentUrl.pathname })
assert.deepEqual(errors, [])
const script = compileScript(descriptor, { id: 'episode-publication-entry' }).content
const code = ts.transpileModule(script, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const helperModule = { exports: {} }
runInNewContext(ts.transpileModule(readFileSync(new URL('../../backend/src/services/episode-publication-entry.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: helperModule, exports: helperModule.exports })
const base = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'

function controller(t, episodeMetadata, dramaMetadata) {
  const calls = [], navigations = [], messages = []
  const api = new Proxy({}, { get: (_target, name) => async (...args) => {
    calls.push({ name, args })
    return name === 'publishRecords' ? [] : {}
  } })
  const module = { exports: {} }
  runInNewContext(code, {
    ...vue, module, exports: module.exports,
    definePageMeta() {}, useRoute: () => ({ params: { id: '8', episodeNumber: '1' } }),
    onMounted() {}, onBeforeUnmount() {},
    navigateTo: async url => { navigations.push(url) },
    process: { dev: false }, setInterval: () => 1, clearInterval() {},
    require(id) {
      if (id === 'vue') return vue
      if (id === 'vue-sonner') return { toast: new Proxy({}, { get: () => message => messages.push(message) }) }
      if (id === 'lucide-vue-next') return {}
      if (id.endsWith('/episode-publication-entry.js')) return helperModule.exports
      if (id === '~/composables/useApi') return new Proxy({}, { get: () => api })
      if (id === '~/composables/useAgent') return { useAgent: () => ({ running: vue.ref(false), runningType: vue.ref(''), run() {}, loadTasks() {} }) }
      if (id === '~/composables/useTasks') return { useTasks: () => ({ tasks: vue.ref([]), loading: vue.ref(false), error: vue.ref(''), lastLoadedAt: vue.ref(null), loadTasks() {}, startUpdates() {} }) }
      if (id === '~/components/BaseSelect.vue') return {}
      throw Error(`Unexpected component import: ${id}`)
    },
  })
  const scope = vue.effectScope()
  const setup = scope.run(() => module.exports.default.setup({}, { expose() {} }))
  t.after(() => scope.stop())
  setup.episode.value = { id: 42, metadata: episodeMetadata }
  setup.drama.value = { id: 8, metadata: dramaMetadata }
  return { setup, calls, navigations, messages }
}

test('linked history episodes resolve their saved source without inferring it from titles or style', t => {
  const h = controller(t, JSON.stringify({ historyFactory: { jobId: 'motion-42', sourceId: 71 } }))
  assert.equal(h.setup.historyPublicationUrl.value, '/history-scripts?view=uploads&script=71')
  h.setup.episode.value.metadata = { historyFactory: { jobId: 'motion-42', sourceId: '72' } }
  assert.equal(h.setup.historyPublicationUrl.value, '/history-scripts?view=uploads&script=72')
  h.setup.episode.value.metadata = '{}'
  h.setup.drama.value.metadata = JSON.stringify({ historySourceId: 73 })
  assert.equal(h.setup.historyPublicationUrl.value, '/history-scripts?view=uploads&script=73')
})

test('history markers without a valid source remain in the shared workspace without constructing unsafe links', t => {
  const h = controller(t, JSON.stringify({ historyFactory: 'remotion-history-factory' }))
  assert.equal(h.setup.historyPublicationUrl.value, '/history-scripts?view=uploads')
  for (const sourceId of [-1, 0, 1.5, '71&view=production', Number.MAX_SAFE_INTEGER + 1]) {
    h.setup.episode.value.metadata = { historyFactory: { jobId: 'motion-42', sourceId } }
    assert.equal(h.setup.historyPublicationUrl.value, '/history-scripts?view=uploads')
  }
  h.setup.episode.value.metadata = { history_factory: 'remotion-history-factory' }
  assert.equal(h.setup.historyPublicationUrl.value, '/history-scripts?view=uploads')
})

test('every legacy publish and confirmation action redirects history episodes before any old platform request', async t => {
  const h = controller(t, { historyFactory: { jobId: 'motion-42', sourceId: 71 } })
  for (const name of ['doPublishWeChatChannels', 'doConfirmPublishWeChatChannels', 'doPublishDouyin', 'doConfirmPublishDouyin']) {
    await h.setup[name]()
  }
  assert.deepEqual(h.navigations, Array(4).fill('/history-scripts?view=uploads&script=71'))
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.messages, [], 'history publication does not request merge or old confirmation prerequisites')
})

test('ordinary episodes retain their platform publication and confirmation behavior', async t => {
  const h = controller(t, '{malformed metadata', JSON.stringify({ style: 'historical_documentary' }))
  assert.equal(h.setup.historyPublicationUrl.value, '')
  h.setup.mergeData.value = { merged_url: 'static/merged-42.mp4' }
  h.setup.publishRecords.value = [
    { platform: 'wechat_channels', status: 'awaiting_confirm', task_id: 901 },
    { platform: 'douyin', status: 'awaiting_confirm', task_id: 902 },
  ]
  await h.setup.doPublishWeChatChannels()
  h.setup.publishRecords.value = [{ platform: 'wechat_channels', status: 'awaiting_confirm', task_id: 901 }]
  await h.setup.doConfirmPublishWeChatChannels()
  await h.setup.doPublishDouyin()
  h.setup.publishRecords.value = [{ platform: 'douyin', status: 'awaiting_confirm', task_id: 902 }]
  await h.setup.doConfirmPublishDouyin()
  assert.deepEqual(h.calls.filter(call => call.name !== 'publishRecords'), [
    { name: 'publishWeChatChannels', args: [42] },
    { name: 'confirmPublishWeChatChannels', args: [42, 901] },
    { name: 'publishDouyin', args: [42] },
    { name: 'confirmPublishDouyin', args: [42, 902] },
  ])
  assert.deepEqual(h.navigations, [])
})

test('ordinary publication errors use the matching media task and do not fail when no record exists', t => {
  const h = controller(t, '{}')
  assert.equal(h.setup.publishErrorWeChat.value, '')
  assert.equal(h.setup.publishErrorDouyin.value, '')
  h.setup.mediaTasks.value = [
    { id: 1, type: 'publish.wechat_channels', status: 'failed', error_message: '视频号原任务失败' },
    { id: 2, type: 'publish.douyin', status: 'queued' },
  ]
  assert.equal(h.setup.publishErrorWeChat.value, '视频号原任务失败')
  assert.equal(h.setup.publishErrorDouyin.value, '')
  h.setup.publishRecords.value = [{ platform: 'wechat_channels', error_message: '原发布记录错误' }]
  assert.equal(h.setup.publishErrorWeChat.value, '原发布记录错误')
})

async function browserHarness(metadata, legacyRecords = [
  { platform: 'wechat_channels', status: 'awaiting_confirm', draft_url: 'https://channels.weixin.qq.com/platform/post/create', task_id: 901 },
  { platform: 'douyin', status: 'awaiting_confirm', draft_url: 'https://creator.douyin.com/creator-micro/content/publish', task_id: 902 },
]) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(8000)
  const writes = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() !== 'GET') {
      writes.push(path)
      return route.fulfill({ status: 405, json: { code: 405, message: 'Mutations disabled in publication entry verification' } })
    }
    let data = []
    if (path === '/api/v1/dramas/8') data = {
      id: 8, title: '历史制作来源', metadata: '{}', episodes: [{ id: 42, episode_number: 1, title: '本集成片',
        content: '已经确认的正文。', script_content: '已经确认的正文。', metadata, render_mode: 'image_story', auto_mode: false }],
    }
    else if (path.includes('/storyboards')) data = [{ id: 501, episode_id: 42, storyboard_number: 1, title: '开场', narration: '已经确认的正文。', composed_video_url: '/static/shot.mp4', duration: 5 }]
    else if (path === '/api/v1/merge/episodes/42/merge') data = { merged_url: 'static/merged-42.mp4', status: 'completed' }
    else if (path.endsWith('/publish-records')) data = legacyRecords
    else if (path.endsWith('/cells')) data = { storyboards: [] }
    else if (path.includes('/covers')) data = {}
    else if (path.endsWith('/health/workers')) data = { workers: [], healthy_count: 1 }
    await route.fulfill({ json: { code: 200, data } })
  })
  await page.route('**/static/**', route => route.fulfill({ status: 204, body: '' }))
  try {
    await page.goto(`${base}/drama/8/episode/1`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '查看成片', exact: true }).click()
  } catch (error) { await browser.close(); throw error }
  return { browser, page, writes, errors }
}

test('history editor exposes the shared publication link and hides all old draft controls at desktop and mobile sizes', async () => {
  const h = await browserHarness(JSON.stringify({ historyFactory: { jobId: 'motion-42', sourceId: 71 } }))
  try {
    const link = h.page.getByRole('link', { name: '查看发表任务', exact: true })
    await link.waitFor()
    assert.equal(await link.getAttribute('href'), '/history-scripts?view=uploads&script=71')
    assert.equal(await h.page.locator('.export-bar').getByRole('button', { name: /视频号|抖音|确认保存/ }).count(), 0)
    assert.equal(await h.page.locator('.publish-status-bar').count(), 0)
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await h.page.setViewportSize(viewport)
      await link.scrollIntoViewIfNeeded()
      const box = await link.boundingBox()
      assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= viewport.width, 'the shared publication action fits the viewport')
      const actions = await h.page.locator('.studio-actions').boundingBox()
      for (const selector of ['.studio-title', '.topbar-back']) {
        const identity = await h.page.locator(selector).boundingBox()
        assert.ok(identity && actions && (identity.y + identity.height <= actions.y || identity.x + identity.width <= actions.x
          || actions.y + actions.height <= identity.y || actions.x + actions.width <= identity.x), 'the editor identity and back button do not overlap its actions')
      }
      mkdirSync('.impeccable/review', { recursive: true })
      await h.page.screenshot({ path: `.impeccable/review/episode-history-publication-${viewport.width}.png`, fullPage: true })
    }
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.errors, [])
  } finally { await h.browser.close() }
})

test('ordinary editor still exposes its existing platform controls', async () => {
  const h = await browserHarness('{}', [])
  try {
    await h.page.getByRole('button', { name: '发视频号', exact: true }).waitFor()
    await h.page.getByRole('button', { name: '存抖音草稿', exact: true }).waitFor()
    assert.equal(await h.page.getByRole('link', { name: '查看发表任务', exact: true }).count(), 0)
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.errors, [])
  } finally { await h.browser.close() }
})
