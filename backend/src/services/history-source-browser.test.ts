import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Browser, Page } from 'puppeteer-core'
import { createChromiumCommandRunner } from './history-source-chromium.js'
import type { HistoryBrowserEvent, HistorySourceBrowserDependencies } from './history-source-browser.js'

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'huobao-history-browser-test-')), 'test.db')
const { browseHistoryCandidates, extractHistoryBrowserObservation, getHistoryVideoId, HISTORY_BROWSER_SNAPSHOT_JS,
  parseHistoryMetricCount, parseHistoryVideoSeconds, selectHistoryBrowserObservation } = await import('./history-source-browser.js')

const VIDEO_ID = '7634568073802853961'
const SECOND_ID = '7674832876206050600'
const THIRD_ID = '7667041566489442405'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    url: `https://www.douyin.com/video/${VIDEO_ID}`,
    sourceVideoId: VIDEO_ID,
    bodyText: '全部评论', title: '国号为何改变？#历史', authorName: '历史作者',
    playerText: '00:01 / 10:40\n倍速\n章节要点',
    playerPlaying: false, pauseControlVisible: true,
    search: { inputVisible: true, inputValue: '', videoTabVisible: false, videoTabSelected: false },
    metrics: { likes: '4.3万', comments: '823', collects: '1.7万', shares: '7149' },
    cards: [],
    comments: [
      { text: '国号与创始人的封爵有什么关系？', likesText: '59' },
      { text: '清改国号时有没有相关诏书？', likesText: '0' },
      { text: '国号与创始人的封爵有什么关系？', likesText: '59' },
    ],
    ...overrides,
  }
}

function searchCard(id: string, durationText = '10:40', title = '国号为何改变？#历史', likesText = '2.8万') {
  return { href: `/video/${id}`, title, authorName: '历史作者', durationText, likesText, leafTexts: [durationText, likesText, title] }
}

test('parses visible counts without inventing zero for unknown values', () => {
  assert.equal(parseHistoryMetricCount('4.3万'), 43_000)
  assert.equal(parseHistoryMetricCount('1.2亿'), 120_000_000)
  assert.equal(parseHistoryMetricCount('7,149'), 7149)
  assert.equal(parseHistoryMetricCount('0'), 0)
  for (const value of ['', '--', '登录后可见', '823评论', '-2', 'NaN', 'Infinity', '999999999999999999999']) {
    assert.equal(parseHistoryMetricCount(value), undefined, value)
  }
})

test('accepts exact video and note URLs only from the trusted origin, preserving long string IDs', () => {
  for (const kind of ['video', 'note']) {
    assert.equal(getHistoryVideoId(`//www.douyin.com/${kind}/${VIDEO_ID}?enter_from=search`), VIDEO_ID)
    assert.equal(getHistoryVideoId(`/${kind}/${VIDEO_ID}`), VIDEO_ID)
    assert.equal(getHistoryVideoId(`https://www.douyin.com/${kind}/${VIDEO_ID}/`), VIDEO_ID)
  }
  for (const href of [`https://evil.com/video/${VIDEO_ID}`, `https://www.douyin.com.evil.com/note/${VIDEO_ID}`,
    `javascript://www.douyin.com/video/${VIDEO_ID}`, `http://www.douyin.com/note/${VIDEO_ID}`,
    `https://user@www.douyin.com/video/${VIDEO_ID}`, `https://www.douyin.com:444/note/${VIDEO_ID}`,
    'https://www.douyin.com/video/not-digits', `https://www.douyin.com/?modal_id=${VIDEO_ID}`]) {
    assert.equal(getHistoryVideoId(href), null, href)
  }
})

test('duration remains optional metadata with no collection limits', () => {
  assert.equal(parseHistoryVideoSeconds('10:40'), 640)
  assert.equal(parseHistoryVideoSeconds('01:02:03'), 3723)
  for (const value of ['00:00', '10:61', '1:99:02', 'Infinity', '4', '-1:20', '24:00:00']) {
    assert.equal(parseHistoryVideoSeconds(value), undefined, value)
  }
  for (const playerText of ['', '00:00 / 00:00', '00:00 / 00:15', '00:00 / 50:00']) {
    const observed = extractHistoryBrowserObservation(snapshot({ playerText, comments: [] }), VIDEO_ID, '2026-10-14T08:00:00.000Z')!
    assert.ok(observed)
    assert.ok(selectHistoryBrowserObservation(observed, '历史'))
  }
})

test('observations require matching identity, title, and visible likes and comments, but no comment bodies', () => {
  const at = '2026-10-14T08:00:00.000Z'
  const observed = extractHistoryBrowserObservation(snapshot(), VIDEO_ID, at)!
  assert.equal(observed.sourceVideoId, VIDEO_ID)
  assert.equal(observed.sourceType, 'video')
  assert.equal(observed.caption, '')
  assert.equal(observed.durationSeconds, 640)
  assert.deepEqual(observed.metrics, { likes: 43_000, comments: 823, collects: 17_000, shares: 7149 })
  assert.equal(observed.comments.length, 2)
  assert.equal(observed.comments[1]!.likes, 0)
  assert.equal(extractHistoryBrowserObservation(snapshot(), SECOND_ID, at), null)
  for (const overrides of [{ sourceVideoId: SECOND_ID }, { sourceVideoId: '' }, { title: ' ' },
    { metrics: { likes: '', comments: '30', collects: '', shares: '' } },
    { metrics: { likes: '2万', comments: '--', collects: '', shares: '' } }]) {
    assert.equal(extractHistoryBrowserObservation(snapshot(overrides), VIDEO_ID, at), null)
  }
  const withoutSamples = extractHistoryBrowserObservation(snapshot({ comments: [], playerText: '',
    metrics: { likes: '1万', comments: '20', collects: '', shares: '' } }), VIDEO_ID, at)!
  assert.deepEqual(withoutSamples.metrics, { likes: 10_000, comments: 20 })
  assert.deepEqual(withoutSamples.comments, [])
  assert.equal(withoutSamples.durationSeconds, undefined)
})

test('note identity can fall back to its URL, without overriding a conflicting observed ID', () => {
  const at = '2026-10-14T08:00:00.000Z'
  const caption = '说明标题\n' + '完整的图文说明。'.repeat(300)
  const note = snapshot({ url: `https://www.douyin.com/note/${VIDEO_ID}`, sourceVideoId: '', caption,
    playerText: '', comments: [] })
  const observed = extractHistoryBrowserObservation(note, VIDEO_ID, at)!
  assert.equal(observed.sourceType, 'note')
  assert.equal(observed.sourceVideoId, VIDEO_ID)
  assert.equal(observed.caption, caption)
  const input = selectHistoryBrowserObservation(observed, '历史')!
  assert.equal(input.sourceType, 'note')
  assert.equal(input.sourceText, caption)
  assert.equal(input.selection!.sourceKind, 'note')
  assert.equal(extractHistoryBrowserObservation({ ...note, sourceVideoId: SECOND_ID }, VIDEO_ID, at), null)
  assert.equal(extractHistoryBrowserObservation({ ...note, url: `https://evil.com/note/${VIDEO_ID}` }, VIDEO_ID, at), null)
})

test('selection uses only both engagement thresholds and retains the observed evidence', () => {
  const observed = extractHistoryBrowserObservation(snapshot({ comments: [] }), VIDEO_ID, '2026-10-14T08:00:00.000Z')!
  const input = selectHistoryBrowserObservation({ ...observed, metrics: { likes: 10_000, comments: 20 } }, '明朝')!
  assert.equal(input.sourceVideoId, VIDEO_ID)
  assert.equal(typeof input.sourceVideoId, 'string')
  assert.equal(input.title, observed.title)
  assert.equal(input.authorName, observed.authorName)
  assert.equal(input.sourceType, 'video')
  assert.equal(input.category, 'unclassified')
  assert.deepEqual(input.metrics, { likes: 10_000, comments: 20 })
  assert.deepEqual(input.selection!.metrics, input.metrics)
  assert.deepEqual(input.selection!.comments, [])
  assert.equal(input.selection!.policyVersion, 'history-engagement-v1')
  assert.equal(input.selection!.sourceKind, 'video')
  assert.equal(input.selection!.searchQuery, '明朝')
  assert.equal(input.selection!.evidenceMethod, 'browser_visible_dom')
  assert.equal(input.selection!.factCheckStatus, 'not_verified')
  for (const metrics of [{ likes: 9999, comments: 1000 }, { likes: 100_000, comments: 19 },
    { likes: 10_000 }, { comments: 20 }, {}, { likes: NaN, comments: 20 }, { likes: 10_000, comments: Infinity }]) {
    assert.equal(selectHistoryBrowserObservation({ ...observed, metrics }, '历史'), null)
  }
})

test('titles, tourism wording, bibliographies and comment content no longer impose editorial vetoes', () => {
  for (const title of ['南京旅游攻略 #旅行推荐官', '一座洛阳城半部中华史，北京大哥终于知道了',
    '紫江县、白马洞、光渡河，参考资料：《开阳县志》', '#历史', '短剧故事']) {
    const observed = extractHistoryBrowserObservation(snapshot({ title, playerText: '',
      comments: [{ text: '卖东西还讲历史', likesText: '' }] }), VIDEO_ID, '2026-10-14T08:00:00.000Z')!
    assert.ok(selectHistoryBrowserObservation(observed, '历史'), title)
  }
})

class DomElement {
  children: DomElement[] = []
  parentElement: DomElement | null = null
  nodes = new Map<string, DomElement[]>()
  attributes = new Map<string, string>()
  classList = { contains: () => false }
  hidden = false
  constructor(public innerText = '') {}
  getClientRects() { return this.hidden ? [] : [{}] }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  querySelectorAll(selector: string): DomElement[] {
    return [...new Set(selector.split(',').flatMap(part => this.nodes.get(part.trim()) || []))]
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null }
  contains(element: DomElement) { return element === this || this.children.includes(element) }
  closest(_selector?: string): DomElement | null { return null }
}

test('the DOM snapshot reads full visible note caption, author, URL ID and real counts without fabricating unknown metrics', () => {
  const document = new DomElement() as DomElement & { body: DomElement; title: string; readyState: string }
  document.body = new DomElement('图文详情')
  document.title = '图文详情'
  document.readyState = 'complete'
  const detail = new DomElement()
  const info = new DomElement()
  const heading = new DomElement('图文标题')
  const caption = new DomElement('说明正文。'.repeat(400))
  const author = new DomElement('真实作者')
  document.nodes.set('[data-e2e="note-detail"]', [detail])
  detail.nodes.set('[data-e2e="note-info"]', [info])
  detail.nodes.set('h1', [heading])
  info.nodes.set('h1', [heading])
  info.nodes.set('[data-e2e="note-desc"]', [caption])
  detail.nodes.set('[data-e2e="note-author"]', [author])
  const hiddenLikes = new DomElement('99万')
  hiddenLikes.hidden = true
  const likes = new DomElement('点赞\n1.2万')
  likes.nodes.set('*', [new DomElement('1.2万')])
  detail.nodes.set('[data-e2e="note-like"]', [hiddenLikes, likes])
  detail.nodes.set('[data-e2e="note-comment"]', [new DomElement('20')])
  detail.nodes.set('[data-e2e="note-collect"]', [new DomElement('收藏')])
  detail.nodes.set('[data-e2e="note-share"]', [new DomElement('--')])
  const state = JSON.parse(JSON.stringify(runInNewContext(HISTORY_BROWSER_SNAPSHOT_JS, {
    document, HTMLElement: DomElement, location: new URL(`https://www.douyin.com/note/${VIDEO_ID}`),
    performance: { timeOrigin: 1 }, window: { scrollY: 0, innerHeight: 900 },
    getComputedStyle: (element: DomElement) => ({ visibility: element.hidden ? 'hidden' : 'visible', display: 'block' }),
  })))
  assert.equal(state.sourceVideoId, VIDEO_ID)
  assert.equal(state.authorName, '真实作者')
  assert.equal(state.title, '图文标题')
  assert.equal(state.caption, `图文标题\n${caption.innerText}`)
  assert.deepEqual(state.metrics, { likes: '1.2万', comments: '20', collects: '', shares: '' })
  const input = selectHistoryBrowserObservation(extractHistoryBrowserObservation(state, VIDEO_ID, '2026-10-14T08:00:00.000Z')!, '历史')!
  assert.equal(input.sourceText, state.caption)
  assert.deepEqual(input.metrics, { likes: 12_000, comments: 20 })
  info.attributes.set('data-e2e-aweme-id', SECOND_ID)
  const conflicting = runInNewContext(HISTORY_BROWSER_SNAPSHOT_JS, {
    document, HTMLElement: DomElement, location: new URL(`https://www.douyin.com/note/${VIDEO_ID}`),
    performance: { timeOrigin: 1 }, window: { scrollY: 0, innerHeight: 900 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  })
  assert.equal(extractHistoryBrowserObservation(conflicting, VIDEO_ID, '2026-10-14T08:00:00.000Z'), null)
})

test('the current note layout exposes its caption without h1 or semantic description attributes', () => {
  const document = new DomElement() as DomElement & { body: DomElement; title: string; readyState: string }
  document.body = new DomElement('图文详情')
  document.title = '图文详情'
  document.readyState = 'complete'
  const detail = new DomElement()
  const author = new DomElement('无畏契约电竞')
  author.closest = () => detail
  const comment = new DomElement('评论文字，不能当作正文')
  comment.closest = () => detail
  const caption = new DomElement('2026 VCT CN 第二赛段 常规赛 | 话题海报时隔160天，WOL再度收获胜利！#WOL战胜TEC')
  const recommendation = new DomElement('这是侧栏推荐，不能混入本条图文说明')
  recommendation.closest = () => detail
  document.nodes.set('[data-e2e="note-detail"]', [detail])
  detail.nodes.set('.m53pwJvW', [comment, author, caption, recommendation])
  detail.nodes.set('[data-e2e="video-player-digg"]', [new DomElement('2790')])
  detail.nodes.set('[data-e2e="feed-comment-icon"]', [new DomElement('108')])
  const state = JSON.parse(JSON.stringify(runInNewContext(HISTORY_BROWSER_SNAPSHOT_JS, {
    document, HTMLElement: DomElement, location: new URL(`https://www.douyin.com/note/${VIDEO_ID}`),
    performance: { timeOrigin: 1 }, window: { scrollY: 0, innerHeight: 900 },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  })))
  assert.equal(state.caption, caption.innerText)
  assert.equal(state.title, caption.innerText)
  assert.equal(state.sourceVideoId, VIDEO_ID)
  const observation = extractHistoryBrowserObservation(state, VIDEO_ID, '2026-10-14T08:00:00.000Z')!
  assert.equal(observation.sourceType, 'note')
  assert.deepEqual(observation.metrics, { likes: 2790, comments: 108 })
  assert.equal(selectHistoryBrowserObservation(observation, '历史'), null)
})

function browserFixture(options: { login?: boolean; legacySearch?: boolean; scrollBatches?: number } = {}) {
  const commands: string[][] = []
  const events: HistoryBrowserEvent[] = []
  const submittedQueries: string[] = []
  const controller = new AbortController()
  let currentUrl = ''
  let inputValue = ''
  let tabSelected = false
  let scrollBatch = 0
  let activePage = 'task-owned-page'
  let sessionGeneration = 0
  const pages = new Map<string, { url: string; input: string; batch: number }>()
  const savePage = () => pages.set(activePage, { url: currentUrl, input: inputValue, batch: scrollBatch })
  const restorePage = () => {
    const saved = pages.get(activePage)
    if (saved) { currentUrl = saved.url; inputValue = saved.input; scrollBatch = saved.batch }
  }
  let clock = Date.parse('2026-10-14T08:00:00.000Z')
  let authRevision: string | null = null
  const dependencies: HistorySourceBrowserDependencies = {
    runCommand: async (args, signal) => {
      signal?.throwIfAborted()
      commands.push(args)
      if (args[2] === 'auth') {
        if (args[3] === 'refresh') authRevision = 'confirmed-session'
        return JSON.stringify({ revision: authRevision })
      }
      if (args[2] === 'close') {
        pages.clear()
        activePage = `task-owned-page-${++sessionGeneration}`
        return '{}'
      }
      if (args[2] === 'open') {
        currentUrl = args[3] === 'https://www.douyin.com/' ? 'https://www.douyin.com/jingxuan' : args[3]!
        const searchMatch = currentUrl.match(/\/search\/([^/?]+)/)
        inputValue = searchMatch ? decodeURIComponent(searchMatch[1]!) : ''
        tabSelected = false
        scrollBatch = 0
        savePage()
        return JSON.stringify({ url: currentUrl, page: activePage })
      }
      if (args[2] === 'tab' && args[3] === 'new') {
        savePage()
        currentUrl = args[4]!
        activePage = `detail-${sessionGeneration}-${getHistoryVideoId(currentUrl)}`
        tabSelected = true
        savePage()
        return JSON.stringify({ page: activePage })
      }
      if (args[2] === 'tab' && args[3] === 'select') {
        assert.ok(pages.has(args[4]!), `cannot select stale or unknown task page: ${args[4]}`)
        savePage()
        activePage = args[4]!
        restorePage()
        tabSelected = true
        return '{}'
      }
      if (args[2] === 'tab' && args[3] === 'close') {
        assert.ok(pages.delete(args[4]!), `cannot close stale or unknown task page: ${args[4]}`)
        activePage = pages.keys().next().value || ''
        restorePage()
        return '{}'
      }
      if (args[2] === 'scroll') { scrollBatch++; return '{}' }
      if (args[2] === 'type' && tabSelected) { inputValue = args[4]!; return '{}' }
      if (args[2] === 'keys' && args[3] === 'Enter' && tabSelected) {
        submittedQueries.push(inputValue)
        currentUrl = `https://www.douyin.com/${options.legacySearch ? '' : 'jingxuan/'}search/${encodeURIComponent(inputValue)}?type=general`
        return '{}'
      }
      if (args[2] === 'click') {
        assert.equal(args[3], '[data-e2e="player-container"] .xgplayer-play', 'collection must not select search duration, type or date filters')
        return '{}'
      }
      if (args[2] === 'eval') {
        const search = { inputVisible: !options.login, inputValue, videoTabVisible: currentUrl.includes('/search/'), videoTabSelected: false }
        if (options.login) return JSON.stringify(snapshot({ url: currentUrl, title: '', playerText: '', cards: [], comments: [], search,
          bodyText: '登录后即可搜索更多精彩视频\n扫码登录' }))
        if (currentUrl.includes('/search/')) return JSON.stringify(snapshot({ url: currentUrl, title: '',
          cards: options.scrollBatches !== undefined
            ? [searchCard(String(7100000000000000000n + BigInt(Math.min(scrollBatch, options.scrollBatches))))]
            : [searchCard(SECOND_ID, '10:00', '已有来源'), searchCard(VIDEO_ID),
              searchCard(VIDEO_ID, '10:40', '同一来源重复卡片'), searchCard(THIRD_ID, '03:52', '互动不足', '9999')], search }))
        return JSON.stringify(snapshot({ url: currentUrl, sourceVideoId: getHistoryVideoId(currentUrl) || '', search }))
      }
      return '{}'
    },
    now: () => clock,
    pause: async (milliseconds, signal) => { clock += milliseconds; signal.throwIfAborted() },
    waitForBrowserLogin: async () => ({ revision: 'confirmed-session' }),
    markBrowserSessionReady: async () => {},
  }
  Object.assign(dependencies, {
    callTextModel: async () => assert.fail('detail selection must never call a model'),
    callTitleModel: async () => assert.fail('title screening must never call a model'),
  })
  return { commands, events, controller, dependencies, submittedQueries, advanceTime: (ms: number) => { clock += ms },
    get detailOpens() { return commands.filter(args => args[2] === 'tab' && args[3] === 'new').length },
    get scrollBatch() { return scrollBatch }, options: {
      categories: ['history_trivia'] as const, targetCount: 1, signal: controller.signal,
      excludeVideoIds: [SECOND_ID], report: (event: HistoryBrowserEvent) => { events.push(event) },
    },
  }
}

test('browser flow uses task-owned tabs and keyword input, excludes existing IDs and never clicks filters', async () => {
  const fixture = browserFixture()
  const result = await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)
  assert.equal(result.length, 1)
  assert.equal(result[0]!.sourceVideoId, VIDEO_ID)
  assert.equal(result[0]!.category, 'unclassified')
  assert.equal(fixture.detailOpens, 1)
  assert.ok(!fixture.commands.some(args => args[2] === 'click' || args[2] === 'bind'))
  assert.ok(!fixture.commands.some(args => args[2] === 'open' && args[3]?.includes('/search/')))
  const session = fixture.commands[0]![1]!
  assert.match(session, /^history-source-[a-f0-9-]+$/)
  assert.ok(fixture.commands.every(args => args[0] === 'browser' && args[1] === session))
  const typeIndex = fixture.commands.findIndex(args => args[2] === 'type')
  const enterIndex = fixture.commands.findIndex(args => args[2] === 'keys' && args[3] === 'Enter')
  assert.ok(typeIndex > 0 && enterIndex > typeIndex)
  assert.ok(fixture.commands.some(args => args[2] === 'tab' && args[3] === 'select' && args[4] === 'task-owned-page'))
  assert.equal(new URL(fixture.events.find(event => event.message.includes('搜索已就绪'))!.browserUrl!).searchParams.get('type'), 'general')
  assert.deepEqual(fixture.submittedQueries, ['历史'])
  assert.deepEqual(fixture.commands.at(-1), ['browser', session, 'close'])
  assert.equal(fixture.events.at(-1)!.selected, 1)
})

test('visible search inputs wait for hydration before receiving input events', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  let pendingLoads = 3
  let inputReady = false
  fixture.dependencies.runCommand = async (args, signal) => {
    if (args[2] === 'type') assert.equal(inputReady, true)
    const result = await original(args, signal)
    if (args[2] !== 'eval') return result
    const state = JSON.parse(result)
    if (!state.url.includes('/search/') && !getHistoryVideoId(state.url)) inputReady = pendingLoads-- <= 0
    return JSON.stringify({ ...state, search: { ...state.search, inputReady } })
  }
  assert.equal((await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)).length, 1)
  assert.deepEqual(fixture.submittedQueries, ['历史'])
})

test('only known low search likes are prefiltered; unknown likes, absent duration and tourism go to details', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  const cards = [searchCard('1', '10:00', '唐朝为何迁都？', '9999'), searchCard('2', '10:00', '明朝为何迁都？', ''),
    searchCard('3', '', '', '10万'), searchCard('4', '00:10', '南京旅游攻略#历史', '20万')]
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return state.url.includes('/search/') ? JSON.stringify({ ...state, cards, search: { ...state.search, endReached: true } }) : output
  }
  const result = await browseHistoryCandidates({ ...fixture.options, categories: ['regional_history'], targetCount: 10 }, fixture.dependencies)
  assert.deepEqual(result.map(item => item.sourceVideoId), ['2', '3', '4'])
  assert.equal(fixture.detailOpens, 3)
  const skipped = fixture.events.filter(event => event.candidate?.screeningStage === 'search' && event.candidate.outcome === 'skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0]!.candidate!.likeCount, 9999)
})

for (const kind of ['video', 'note'] as const) {
  test(`${kind} details, not optimistic search cards, determine the engagement thresholds`, async () => {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    const counts: Record<string, [string, string]> = { '1': ['9999', '200'], '2': ['10万', '19'],
      '3': ['', '20'], '4': ['2万', '--'], '5': ['1万', '20'] }
    fixture.dependencies.runCommand = async (args, signal) => {
      const output = await original(args, signal)
      if (args[2] !== 'eval') return output
      const state = JSON.parse(output)
      if (state.url.includes('/search/')) return JSON.stringify({ ...state,
        cards: Object.keys(counts).map(id => ({ ...searchCard(id, ''), href: `/${kind}/${id}` })),
        search: { ...state.search, endReached: true } })
      const id = getHistoryVideoId(state.url)
      if (!id) return output
      const [likes, comments] = counts[id]!
      return JSON.stringify({ ...state, playerText: '', comments: [], metrics: { likes, comments, collects: '', shares: '' } })
    }
    const result = await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 10 }, fixture.dependencies)
    assert.deepEqual(result.map(item => item.sourceVideoId), ['5'])
    assert.equal(result[0]!.sourceType, kind)
    assert.equal(fixture.detailOpens, 5)
    assert.equal(fixture.events.filter(event => event.candidate?.screeningStage === 'detail' && event.candidate.outcome === 'skipped').length, 4)
  })
}

for (const redirect of [false, true]) {
  test(`notes keep the original card URL and full caption, including video-to-note redirects: ${redirect}`, async () => {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    const href = `https://www.douyin.com/${redirect ? 'video' : 'note'}/${VIDEO_ID}?enter_from=search`
    const caption = '完整图文正文。'.repeat(400)
    fixture.dependencies.runCommand = async (args, signal) => {
      const output = await original(args, signal)
      if (args[2] !== 'eval') return output
      const state = JSON.parse(output)
      if (state.url.includes('/search/')) return JSON.stringify({ ...state, cards: [{ ...searchCard(VIDEO_ID, '', '', ''), href }] })
      return getHistoryVideoId(state.url) ? JSON.stringify({ ...state, url: `https://www.douyin.com/note/${VIDEO_ID}`,
        sourceVideoId: '', caption, playerText: '', comments: [] }) : output
    }
    const result = await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)
    assert.equal(result[0]!.sourceType, 'note')
    assert.equal(result[0]!.sourceText, caption)
    assert.equal(result[0]!.selection!.sourceKind, 'note')
    assert.equal(fixture.commands.find(args => args[2] === 'tab' && args[3] === 'new')![4], href)
    assert.equal(fixture.events.find(event => event.candidate?.outcome === 'selected')!.browserUrl, `https://www.douyin.com/note/${VIDEO_ID}`)
  })
}

test('missing detail metrics wait for hydration without requiring duration or comments text', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  let reads = 0
  const started = fixture.dependencies.now!()
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return getHistoryVideoId(state.url) ? JSON.stringify({ ...state, playerText: '', comments: [],
      metrics: { likes: ++reads < 3 ? '' : '1万', comments: '20', collects: '', shares: '' } }) : output
  }
  const result = await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)
  assert.equal(result.length, 1)
  assert.equal(fixture.detailOpens, 1)
  assert.ok(fixture.dependencies.now!() - started >= 3000)
  assert.equal(result[0]!.selection!.durationSeconds, undefined)
})

test('selected events include exact observed engagement evidence and full title', async () => {
  const fixture = browserFixture()
  const result = await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)
  const logged = fixture.events.find(event => event.candidate?.outcome === 'selected')!
  assert.equal(logged.candidate!.title, result[0]!.title)
  assert.equal(logged.candidate!.reason, result[0]!.selection!.reason)
  assert.equal(logged.candidate!.likeCount, 43_000)
  assert.equal(logged.candidate!.commentCount, 823)
  assert.deepEqual(logged.candidate!.comments, result[0]!.selection!.comments)
  assert.ok(fixture.events.some(event => event.candidate?.outcome === 'inspecting'))
})

test('playback is paused before observation and identity is checked again after pausing', async () => {
  for (const changed of [false, true]) {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    let paused = false
    fixture.dependencies.runCommand = async (args, signal) => {
      const output = await original(args, signal)
      if (args[2] === 'click') paused = true
      if (args[2] !== 'eval') return output
      const state = JSON.parse(output)
      return getHistoryVideoId(state.url) ? JSON.stringify({ ...state, playerPlaying: !paused,
        sourceVideoId: changed && paused ? THIRD_ID : state.sourceVideoId }) : output
    }
    const result = await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)
    assert.equal(paused, true)
    assert.equal(result.length, changed ? 0 : 1)
    if (changed) assert.ok(fixture.events.some(event => event.message.includes('未保存错配来源')))
  }
})

test('unpausable playback and mismatching identities or origins never reach the consumer', async () => {
  for (const overrides of [{ playerPlaying: true, pauseControlVisible: false }, { sourceVideoId: SECOND_ID },
    { url: `https://evil.com/video/${VIDEO_ID}` }, { url: `https://www.douyin.com/note/${SECOND_ID}`, sourceVideoId: '' }]) {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    fixture.dependencies.runCommand = async (args, signal) => {
      const output = await original(args, signal)
      if (args[2] !== 'eval') return output
      const state = JSON.parse(output)
      return getHistoryVideoId(state.url) ? JSON.stringify({ ...state, ...overrides }) : output
    }
    assert.deepEqual(await browseHistoryCandidates({ ...fixture.options, categories: [],
      onCandidate: async () => assert.fail('invalid source cannot be processed'),
    }, fixture.dependencies), [])
    assert.ok(fixture.events.some(event => event.candidate?.outcome === 'skipped'))
  }
})

test('a failed detail read retains its original error even when tab cleanup would fail', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  let failed = false
  fixture.dependencies.runCommand = async (args, signal) => {
    if (failed && args[2] === 'tab') throw new Error('Unknown owned task page')
    const output = await original(args, signal)
    if (args[2] === 'eval' && getHistoryVideoId(JSON.parse(output).url)) {
      failed = true
      throw new Error('读取页面失败：页面跳转导致读取环境失效')
    }
    return output
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), /读取页面失败/)
  assert.equal(fixture.commands.at(-1)![2], 'close')
})

test('driver navigation recovery continues without processing the preceding source twice', async () => {
  const fixture = browserFixture({ scrollBatches: 3 })
  const original = fixture.dependencies.runCommand!
  const processed: string[] = []
  const simulate = (...args: string[]) => original(['browser', 'simulated', ...args], fixture.controller.signal)
  let failed = false
  let retries = 0
  const run = createChromiumCommandRunner({
    loadSession: async () => ({ revision: null }), onRetry: () => { retries++ },
    connect: async () => ({
      userAgent: async () => 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36',
      defaultBrowserContext: () => ({ newPage: async () => {
        let id: string
        return {
          setUserAgent: async () => {},
          goto: async (url: string) => { id = JSON.parse(await simulate('tab', 'new', url)).page },
          bringToFront: async () => { await simulate('tab', 'select', id) },
          close: async () => { await simulate('tab', 'close', id) },
          focus: async (selector: string) => { await simulate('focus', selector) },
          click: async (selector: string) => { await simulate('click', selector) },
          keyboard: { down: async () => {}, up: async () => {},
            sendCharacter: async (value: string) => { await simulate('type', 'input', value) },
            press: async (key: string) => { await simulate('keys', key) } },
          evaluate: async (source: unknown, amount: number) => {
            if (typeof source === 'function') return JSON.parse(await simulate('scroll', 'down', '--amount', String(amount)))
            const state = JSON.parse(await simulate('eval'))
            if (!failed && processed.length === 1 && getHistoryVideoId(state.url)) {
              failed = true
              throw new Error('Execution context was destroyed, most likely because of a navigation.')
            }
            return state
          },
        } as unknown as Page
      } }), disconnect: async () => {},
    }) as unknown as Browser,
  })
  await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 2,
    onCandidate: async candidate => { processed.push(candidate.sourceVideoId) },
  }, { ...fixture.dependencies, runCommand: run })
  assert.equal(failed, true)
  assert.equal(retries, 1)
  assert.deepEqual(processed, ['7100000000000000000', '7100000000000000001'])
  assert.ok(fixture.events.some(event => event.message.includes('筛选结束')))
})

for (const stage of ['home', 'input', 'submit', 'search-ready', 'detail', 'detail-reread', 'between-cards']) {
  test(`login recovery at ${stage} releases the collector and rebuilds pages without replaying completed sources`, async () => {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    const processed: string[] = []
    let triggered = false
    let recovered = false
    let collectorLeased = false
    let confirmations = 0
    let detailReads = 0
    let searchReady = false
    const trigger = (at: string) => { if (at === stage && !recovered) triggered = true }
    fixture.options.report = event => {
      fixture.events.push(event)
      if (event.message.includes('搜索已就绪')) { searchReady = true; trigger('search-ready') }
    }
    fixture.dependencies.runCommand = async (args, signal) => {
      const result = await original(args, signal)
      if (args[2] === 'open' || (args[2] === 'tab' && args[3] === 'new')) collectorLeased = true
      if (args[2] === 'close') collectorLeased = false
      if (args[2] === 'auth' && args[3] === 'refresh') recovered = true
      if (args[2] === 'type') trigger('input')
      if (args[2] === 'keys' && args[3] === 'Enter') trigger('submit')
      if (args[2] === 'tab' && args[3] === 'new') trigger('detail')
      if (args[2] !== 'eval') return result
      const state = JSON.parse(result)
      trigger('home')
      if (getHistoryVideoId(state.url) && ++detailReads === 2) trigger('detail-reread')
      if (triggered && !recovered) return JSON.stringify({ ...state, bodyText: '请先登录', cards: [] })
      return state.url.includes('/search/') && state.cards.length
        ? JSON.stringify({ ...state, cards: [searchCard(VIDEO_ID), searchCard(THIRD_ID)] }) : result
    }
    fixture.dependencies.waitForBrowserLogin = async () => {
      confirmations++
      assert.equal(collectorLeased, false)
      assert.equal(fixture.commands.at(-1)![2], 'close')
      assert.equal(confirmations, 1)
      return { revision: 'confirmed-session' }
    }
    await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 2,
      onCandidate: async candidate => { processed.push(candidate.sourceVideoId); trigger('between-cards') },
    }, fixture.dependencies)
    assert.equal(confirmations, 1)
    assert.equal(triggered, true, 'the recovery trigger must actually execute')
    assert.equal(searchReady, true)
    assert.deepEqual(processed, [VIDEO_ID, THIRD_ID])
    assert.equal(fixture.events.at(-1)!.scanned, 2)
    assert.equal(fixture.events.at(-1)!.selected, 2)
    assert.equal(collectorLeased, false)
    assert.equal(fixture.commands.filter(args => args[2] === 'close').length, 2)
    assert.ok(fixture.commands.some(args => args[2] === 'tab' && args[3] === 'select' && args[4] === 'task-owned-page-1'))
  })
}

test('a search document reload requeues only the unprocessed details without inflating scan counts', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  const processed: string[] = []
  let reloaded = false
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    if (!state.url.includes('/search/')) return output
    if (processed.length === 1) reloaded = true
    return JSON.stringify({ ...state, documentEpoch: reloaded ? 2 : 1, cards: [searchCard(VIDEO_ID), searchCard(THIRD_ID)] })
  }
  await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 2,
    onCandidate: async candidate => { processed.push(candidate.sourceVideoId) },
  }, fixture.dependencies)
  assert.equal(reloaded, true)
  assert.deepEqual(processed, [VIDEO_ID, THIRD_ID])
  assert.equal(fixture.events.at(-1)!.scanned, 2)
  assert.equal(fixture.detailOpens, 2)
  assert.ok(fixture.events.some(event => event.stage === 'restoring_browser'))
})

test('successive login recoveries release each session while retaining completed candidates', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  const processed: string[] = []
  let recovered = 0
  let confirmations = 0
  fixture.dependencies.runCommand = async (args, signal) => {
    const result = await original(args, signal)
    if (args[2] === 'auth' && args[3] === 'refresh') recovered++
    if (args[2] !== 'eval') return result
    const state = JSON.parse(result)
    if (processed.length > recovered && recovered < 2) return JSON.stringify({ ...state, bodyText: '请先登录', cards: [] })
    return state.url.includes('/search/') && state.cards.length
      ? JSON.stringify({ ...state, cards: [searchCard(VIDEO_ID), searchCard(THIRD_ID), searchCard(SECOND_ID)] }) : result
  }
  fixture.dependencies.waitForBrowserLogin = async () => {
    confirmations++
    assert.equal(fixture.commands.at(-1)![2], 'close')
    assert.equal(fixture.commands.filter(args => args[2] === 'close').length, confirmations)
    return { revision: 'confirmed-session' }
  }
  await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 3, excludeVideoIds: [],
    onCandidate: async candidate => { processed.push(candidate.sourceVideoId) },
  }, fixture.dependencies)
  assert.equal(confirmations, 2)
  assert.deepEqual(processed, [VIDEO_ID, THIRD_ID, SECOND_ID])
  assert.equal(fixture.events.at(-1)!.scanned, 3)
  assert.equal(fixture.detailOpens, 3)
  assert.equal(fixture.commands.filter(args => args[2] === 'close').length, 3)
})

test('login readiness uses the same Chromium session and confirms a refreshed revision only after recovery', async () => {
  const browserOptions = { login: true }
  const fixture = browserFixture(browserOptions)
  const original = fixture.dependencies.runCommand!
  let restored = false
  let readyRevision = ''
  fixture.dependencies.waitForBrowserLogin = async ({ afterRevision, signal }) => {
    assert.equal(afterRevision, null)
    assert.equal(signal, fixture.controller.signal)
    assert.equal(fixture.detailOpens, 0)
    assert.equal(restored, false)
    fixture.advanceTime(10 * 60_000)
    return { revision: 'confirmed-session' }
  }
  fixture.dependencies.runCommand = async (args, signal) => {
    const result = await original(args, signal)
    if (args[2] === 'auth' && args[3] === 'refresh') { restored = true; browserOptions.login = false }
    return result
  }
  fixture.dependencies.markBrowserSessionReady = async revision => { readyRevision = revision }
  assert.equal((await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)).length, 1)
  assert.equal(fixture.events.filter(event => event.stage === 'waiting_login').length, 1)
  assert.match(fixture.events.find(event => event.stage === 'waiting_login')!.message, /采集监控.*检测登录状态/)
  assert.match(fixture.events.find(event => event.stage === 'restoring_browser')!.message, /同一.*Chromium/)
  assert.equal(readyRevision, 'confirmed-session')
  assert.equal(new Set(fixture.commands.map(args => args[1])).size, 1)
  assert.equal(fixture.commands.at(-1)![2], 'close')
})

test('login recovery waits for search input hydration before resuming discovery', async () => {
  const fixture = browserFixture({ scrollBatches: 2 })
  const original = fixture.dependencies.runCommand!
  let recovered = false
  let pendingInput = 2
  const processed: string[] = []
  fixture.dependencies.runCommand = async (args, signal) => {
    const result = await original(args, signal)
    if (args[2] === 'auth' && args[3] === 'refresh') recovered = true
    if (args[2] !== 'eval') return result
    const state = JSON.parse(result)
    if (!state.url.includes('/search/')) return result
    if (fixture.scrollBatch > 0 && !recovered) return JSON.stringify({ ...state, bodyText: '请先登录', cards: [], documentEpoch: 1 })
    return JSON.stringify({ ...state, documentEpoch: recovered ? 2 : 1,
      search: recovered && pendingInput-- > 0 ? { ...state.search, inputVisible: false, inputValue: '' } : state.search })
  }
  await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 2,
    onCandidate: async candidate => { processed.push(candidate.sourceVideoId) },
  }, fixture.dependencies)
  assert.equal(new Set(processed).size, 2)
  assert.ok(pendingInput <= 0)
  assert.deepEqual(fixture.submittedQueries, ['历史', '历史'])
})

test('a confirmed session still blocked on the task page fails explicitly without repeated confirmation', async () => {
  const fixture = browserFixture({ login: true })
  let confirmations = 0
  fixture.dependencies.waitForBrowserLogin = async () => { confirmations++; return { revision: 'confirmed-session' } }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), /同一采集浏览器.*仍.*拦截/)
  assert.equal(confirmations, 1)
  assert.equal(fixture.detailOpens, 0)
  assert.equal(fixture.events.filter(event => event.stage === 'waiting_login').length, 1)
})

for (const stage of ['waiting-login', 'login-confirmation', 'search-wait', 'before-detail', 'detail-wait', 'selected']) {
  test(`stopping at ${stage} remains cancellable and releases only the task session`, async () => {
    const fixture = browserFixture({ login: stage === 'waiting-login' || stage === 'login-confirmation' })
    const original = fixture.dependencies.runCommand!
    let triggered = false
    fixture.options.report = event => {
      fixture.events.push(event)
      if ((stage === 'waiting-login' && event.stage === 'waiting_login')
        || (stage === 'before-detail' && event.candidate?.outcome === 'inspecting')
        || (stage === 'selected' && event.candidate?.outcome === 'selected')) {
        triggered = true
        fixture.controller.abort()
      }
    }
    fixture.dependencies.waitForBrowserLogin = async ({ signal }) => {
      assert.equal(fixture.commands.at(-1)![2], 'close')
      triggered = true
      fixture.controller.abort()
      signal.throwIfAborted()
      return { revision: 'unreachable' }
    }
    fixture.dependencies.runCommand = async (args, signal) => {
      const output = await original(args, signal)
      if (args[2] !== 'eval') return output
      const state = JSON.parse(output)
      if (stage === 'search-wait' && state.url.includes('/search/')) return JSON.stringify({ ...state, cards: [], search: { ...state.search, resultsLoading: true } })
      if (stage === 'detail-wait' && getHistoryVideoId(state.url)) return JSON.stringify({ ...state, metrics: { ...state.metrics, likes: '' } })
      return output
    }
    fixture.dependencies.pause = async (milliseconds, signal) => {
      fixture.advanceTime(milliseconds)
      if ((stage === 'search-wait' && fixture.submittedQueries.length > 0) || (stage === 'detail-wait' && fixture.detailOpens > 0)) {
        triggered = true
        fixture.controller.abort()
      }
      signal.throwIfAborted()
    }
    await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [],
      onCandidate: async () => assert.fail('stopped candidate must not be consumed'),
    }, fixture.dependencies), { name: 'AbortError' })
    assert.equal(triggered, true)
    assert.equal(fixture.commands.filter(args => args[2] === 'close').length, 1)
    assert.ok(!fixture.commands.some(args => args[2] === 'auth' && args[3] === 'refresh'))
  })
}

test('invalid targets and pre-stopped runs do not start a browser, while categories remain legacy metadata', async () => {
  const fixture = browserFixture()
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 0 }, fixture.dependencies))
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: null }, fixture.dependencies), /onCandidate/)
  fixture.controller.abort()
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), { name: 'AbortError' })
  assert.equal(fixture.commands.length, 0)
  const compatible = browserFixture()
  assert.equal((await browseHistoryCandidates({ ...compatible.options, categories: ['history_trivia', 'history_trivia'] }, compatible.dependencies)).length, 1)
})

test('short, long and missing-duration cards all reach details with no category or comment-sample gate', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    if (state.url.includes('/search/')) return JSON.stringify({ ...state,
      cards: ['00:15', '50:00', ''].map((duration, index) => searchCard(String(index + 1), duration, '旅游攻略')),
      search: { ...state.search, endReached: true } })
    return JSON.stringify({ ...state, playerText: '', comments: [] })
  }
  const result = await browseHistoryCandidates({ ...fixture.options, categories: ['regional_history'], targetCount: 10 }, fixture.dependencies)
  assert.equal(result.length, 3)
  assert.equal(fixture.detailOpens, 3)
  assert.ok(result.every(item => item.category === 'unclassified' && item.selection!.comments.length === 0))
})

test('search waits for current query and non-loading stable results before opening details', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  let pendingQuery = 2
  let pendingResults = 3
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    if (!state.url.includes('/search/')) return output
    if (pendingQuery-- > 0) return JSON.stringify({ ...state, url: 'https://www.douyin.com/jingxuan/search/旧关键词?type=general' })
    if (pendingResults-- > 0) {
      assert.equal(fixture.detailOpens, 0)
      return JSON.stringify({ ...state, search: { ...state.search, resultsLoading: true } })
    }
    return output
  }
  assert.equal((await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)).length, 1)
  assert.ok(pendingQuery < 0 && pendingResults < 0)
  assert.equal(fixture.events.filter(event => event.message.includes('搜索已就绪')).length, 1)
})

test('legacy visible filters do not impose duration, type or date restrictions during scrolling', async () => {
  const fixture = browserFixture({ scrollBatches: 2 })
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return JSON.stringify({ ...state, search: { ...state.search, filters: { menuVisible: true, triggerSelector: '.old-filter',
      durationSelected: false, videoSelected: false, durationOptionVisible: true, videoOptionVisible: true,
      publishTimeUnrestricted: false } } })
  }
  assert.equal((await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 2 }, fixture.dependencies)).length, 2)
  assert.ok(!fixture.commands.some(args => args[2] === 'click'))
})

test('search result hydration timeout is bounded and never opens details', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  const started = fixture.dependencies.now!()
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return state.url.includes('/search/') ? JSON.stringify({ ...state, cards: [], search: { ...state.search, resultsLoading: true } }) : output
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), /搜索结果未就绪/)
  assert.ok(fixture.dependencies.now!() - started >= 90_000)
  assert.equal(fixture.detailOpens, 0)
  assert.equal(fixture.commands.filter(args => args[2] === 'close').length, 1)
})

test('search submission rejects visible home, unrelated keywords, and foreign-origin results', async () => {
  for (const url of ['https://www.douyin.com/jingxuan', 'https://www.douyin.com/search/错误关键词?type=general',
    'https://evil.com/jingxuan/search/历史?type=general']) {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    fixture.dependencies.runCommand = async (args, signal) => {
      const output = await original(args, signal)
      if (args[2] !== 'eval') return output
      return JSON.stringify({ ...JSON.parse(output), url, cards: [searchCard(VIDEO_ID)] })
    }
    await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), /搜索.*关键词/)
    assert.equal(fixture.detailOpens, 0)
    assert.ok(!fixture.events.some(event => event.message.includes('搜索已就绪')))
    assert.equal(fixture.commands.at(-1)![2], 'close')
  }
})

test('search input mismatch fails explicitly before detail inspection', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return JSON.stringify({ ...state, search: { ...state.search, inputValue: '' } })
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), /搜索.*输入/)
  assert.equal(fixture.detailOpens, 0)
})

test('a search query drift between details stops before inspecting stale remaining cards', async () => {
  const fixture = browserFixture({ scrollBatches: 3 })
  const original = fixture.dependencies.runCommand!
  let consumed = 0
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return consumed && state.url.includes('/search/') ? JSON.stringify({ ...state,
      url: 'https://www.douyin.com/jingxuan/search/旧关键词', search: { ...state.search, inputValue: '旧关键词' } }) : output
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 3,
    onCandidate: async () => { consumed++ },
  }, fixture.dependencies), /搜索页已变化/)
  assert.equal(consumed, 1)
  assert.equal(fixture.detailOpens, 1)
})

test('legacy search routes remain supported without manual navigation to a search URL', async () => {
  const fixture = browserFixture({ legacySearch: true })
  assert.equal((await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)).length, 1)
  assert.match(fixture.events.find(event => event.message.includes('搜索已就绪'))!.browserUrl!, /^https:\/\/www\.douyin\.com\/search\//)
  assert.ok(!fixture.commands.some(args => args[2] === 'open' && args[3]?.includes('/search/')))
})

test('keeps the same search position while scrolling and inspecting details', async () => {
  const fixture = browserFixture({ scrollBatches: 6 })
  const result = await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 4 }, fixture.dependencies)
  assert.equal(result.length, 4)
  assert.equal(new Set(result.map(item => item.sourceVideoId)).size, 4)
  assert.equal(fixture.submittedQueries.length, 1)
  assert.equal(fixture.commands.filter(args => args[2] === 'scroll').length, 3)
  assert.equal(fixture.commands.filter(args => args[2] === 'tab' && args[3] === 'close').length, 4)
})

test('a completed-draft target continues discovery past failed processing and stops exactly on completion', async () => {
  const fixture = browserFixture({ scrollBatches: 5 })
  let consumed = 0, completed = 0
  await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 2,
    isTargetReached: () => completed >= 2,
    onCandidate: async () => { if (++consumed > 1) completed++ },
  }, fixture.dependencies)
  assert.equal(consumed, 3)
  assert.equal(completed, 2)
  assert.equal(fixture.events.at(-1)!.selected, 3)
  assert.equal(fixture.commands.filter(args => args[2] === 'scroll').length, 2)
})

test('streams more than thirty candidates with backpressure without retaining drafts in memory', async () => {
  const fixture = browserFixture({ scrollBatches: 40 })
  const consumed: string[] = []
  let processing = false
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    assert.equal(processing, false, 'browser commands must wait for downstream processing')
    return original(args, signal)
  }
  const result = await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 35,
    onCandidate: async candidate => {
      processing = true
      assert.equal(fixture.detailOpens, consumed.length + 1)
      await Promise.resolve()
      consumed.push(candidate.sourceVideoId)
      fixture.advanceTime(21 * 60_000)
      processing = false
    },
  }, fixture.dependencies)
  assert.equal(consumed.length, 35)
  assert.equal(new Set(consumed).size, 35)
  assert.deepEqual(result, [])
  assert.equal(fixture.events.at(-1)!.selected, 35)
  assert.equal(fixture.submittedQueries.length, 1)
})

test('IDs stored while an earlier candidate is processed are skipped before opening their details', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  const known = new Set<string>()
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return state.url.includes('/search/') ? JSON.stringify({ ...state, cards: [searchCard(VIDEO_ID), searchCard(THIRD_ID)],
      search: { ...state.search, endReached: true } }) : output
  }
  await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: 10,
    isKnownVideo: id => known.has(id), onCandidate: async () => { known.add(THIRD_ID) },
  }, fixture.dependencies)
  assert.equal(fixture.detailOpens, 1)
  assert.equal(fixture.events.at(-1)!.selected, 1)
})

test('an explicit end marker processes the last candidates without scrolling or waiting in either mode', async () => {
  for (const targetCount of [null, 3]) {
    const fixture = browserFixture()
    const original = fixture.dependencies.runCommand!
    fixture.dependencies.runCommand = async (args, signal) => {
      if (args[2] === 'scroll') assert.fail('must not scroll after an explicit end marker')
      const output = await original(args, signal)
      if (args[2] !== 'eval') return output
      const state = JSON.parse(output)
      return JSON.stringify({ ...state, search: { ...state.search, endReached: state.url.includes('/search/') } })
    }
    let consumed = 0
    await browseHistoryCandidates({ ...fixture.options, categories: [], targetCount, onCandidate: async () => { consumed++ } }, fixture.dependencies)
    assert.equal(consumed, 1)
    assert.equal(fixture.events.filter(event => event.stage === 'exhausted').length, 1)
    assert.ok(!fixture.events.some(event => event.stage === 'waiting_results'))
    assert.equal(fixture.commands.at(-1)![2], 'close')
  }
})

function multipleKeywordFixture() {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    if (!state.url.includes('/search/')) return output
    const cards = state.search.inputValue === '明朝' ? [searchCard(VIDEO_ID), searchCard(THIRD_ID)] : [searchCard(VIDEO_ID)]
    return JSON.stringify({ ...state, cards, search: { ...state.search, endReached: true } })
  }
  return fixture
}

for (const targetCount of [null, 10]) {
  test(`keywords are searched separately in order with global deduplication for target ${targetCount}`, async () => {
    const fixture = multipleKeywordFixture()
    const consumed: Array<{ id: string; query: unknown }> = []
    await browseHistoryCandidates({ ...fixture.options, categories: [], keywords: ['历史', '明朝'], targetCount,
      onCandidate: async candidate => { consumed.push({ id: candidate.sourceVideoId, query: candidate.selection!.searchQuery }) },
    }, fixture.dependencies)
    assert.deepEqual(fixture.submittedQueries, ['历史', '明朝'])
    assert.deepEqual(consumed, [{ id: VIDEO_ID, query: '历史' }, { id: THIRD_ID, query: '明朝' }])
    assert.equal(fixture.detailOpens, 2)
    assert.equal(fixture.events.filter(event => event.stage === 'keyword_exhausted').length, 2)
    assert.equal(fixture.events.filter(event => event.stage === 'exhausted').length, 1)
    assert.equal(fixture.events.at(-1)!.scanned, 2)
  })
}

test('a global completed-draft target skips later keywords or continues after a failed first draft', async () => {
  for (const firstCompleted of [true, false]) {
    const fixture = multipleKeywordFixture()
    let completed = 0
    const consumed: string[] = []
    await browseHistoryCandidates({ ...fixture.options, categories: [], keywords: ['历史', '明朝', '清朝'],
      isTargetReached: () => completed >= 1,
      onCandidate: async candidate => { consumed.push(candidate.sourceVideoId); if (firstCompleted || candidate.sourceVideoId !== VIDEO_ID) completed++ },
    }, fixture.dependencies)
    assert.deepEqual(fixture.submittedQueries, firstCompleted ? ['历史'] : ['历史', '明朝'])
    assert.equal(consumed.length, firstCompleted ? 1 : 2)
    assert.equal(completed, 1)
  }
})

test('stopping between keywords prevents the next navigation and releases the session', async () => {
  const fixture = multipleKeywordFixture()
  fixture.options.report = event => {
    fixture.events.push(event)
    if (event.stage === 'keyword_exhausted') fixture.controller.abort(new Error('stopped after first keyword'))
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], keywords: ['历史', '明朝'], targetCount: 10 }, fixture.dependencies), /stopped after first keyword/)
  assert.deepEqual(fixture.submittedQueries, ['历史'])
  assert.equal(fixture.commands.filter(args => args[2] === 'close').length, 1)
})

test('a stalled first keyword advances without falsely reporting complete exhaustion', async () => {
  const fixture = multipleKeywordFixture()
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return state.url.includes('/search/') && state.search.inputValue === '历史'
      ? JSON.stringify({ ...state, search: { ...state.search, endReached: false } }) : output
  }
  const consumed: string[] = []
  await browseHistoryCandidates({ ...fixture.options, categories: [], keywords: ['历史', '明朝'], targetCount: null,
    onCandidate: async candidate => { consumed.push(candidate.sourceVideoId) },
  }, fixture.dependencies)
  assert.deepEqual(fixture.submittedQueries, ['历史', '明朝'])
  assert.equal(consumed.length, 2)
  assert.ok(fixture.events.some(event => event.stage === 'keyword_stalled'))
  assert.ok(!fixture.events.some(event => event.stage === 'waiting_results' || event.stage === 'exhausted'))
})

test('continuous mode keeps waiting until stopped when there is no explicit end marker', async () => {
  const fixture = browserFixture({ scrollBatches: 2 })
  let consumed = 0
  fixture.options.report = event => {
    fixture.events.push(event)
    if (/等待新视频/.test(event.message)) fixture.controller.abort()
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: null,
    onCandidate: async () => { consumed++ },
  }, fixture.dependencies), { name: 'AbortError' })
  assert.equal(consumed, 3)
  assert.ok(fixture.commands.filter(args => args[2] === 'scroll').length > 2)
  assert.equal(fixture.commands.filter(args => args[2] === 'close').length, 1)
})

test('a processing error stops further discovery immediately and cleans up the owned session', async () => {
  const fixture = browserFixture({ scrollBatches: 4 })
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: null,
    onCandidate: async () => { throw new Error('ASR failed; no automatic paid retry') },
  }, fixture.dependencies), /ASR failed/)
  assert.equal(fixture.detailOpens, 1)
  assert.equal(fixture.commands.filter(args => args[2] === 'scroll').length, 0)
  assert.equal(fixture.commands.at(-1)![2], 'close')
})

test('the next continuous pass resumes the retained search page at its previous depth', async () => {
  const fixture = browserFixture({ scrollBatches: 6 })
  const original = fixture.dependencies.runCommand!
  let idlePasses = 0
  let consumed = 0
  fixture.options.report = event => {
    fixture.events.push(event)
    if (/等待新视频/.test(event.message) && ++idlePasses > 1) fixture.controller.abort()
  }
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    return idlePasses > 0 && state.url.includes('/search/') && fixture.scrollBatch >= 6
      ? JSON.stringify({ ...state, cards: [searchCard('7200000000000000000')] }) : output
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [], targetCount: null,
    onCandidate: async () => { if (++consumed === 8) fixture.controller.abort() },
  }, fixture.dependencies), { name: 'AbortError' })
  assert.equal(consumed, 8)
  assert.equal(idlePasses, 1)
  assert.deepEqual(fixture.submittedQueries, ['历史'])
})

test('already loaded offscreen low-engagement cards do not imply exhaustion before the list bottom', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    const state = JSON.parse(output)
    if (!state.url.includes('/search/')) return output
    return JSON.stringify({ ...state,
      scrollState: { top: Math.min(fixture.scrollBatch * 700, 3500), height: 4200, viewport: 700 },
      cards: [searchCard(fixture.scrollBatch >= 4 ? VIDEO_ID : THIRD_ID, '', '候选', fixture.scrollBatch >= 4 ? '1万' : '9999')],
    })
  }
  assert.equal((await browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies)).length, 1)
  assert.equal(fixture.submittedQueries.length, 1)
  assert.equal(fixture.commands.filter(args => args[2] === 'scroll').length, 4)
})

test('a blank captcha intermediary is detected from its title before any detailed inspection', async () => {
  const fixture = browserFixture()
  const original = fixture.dependencies.runCommand!
  fixture.dependencies.runCommand = async (args, signal) => {
    const output = await original(args, signal)
    if (args[2] !== 'eval') return output
    return JSON.stringify({ ...JSON.parse(output), documentTitle: '验证码中间页', bodyText: '',
      search: { inputVisible: false, inputValue: '', videoTabVisible: false, videoTabSelected: false } })
  }
  await assert.rejects(browseHistoryCandidates({ ...fixture.options, categories: [] }, fixture.dependencies), /同一采集浏览器.*仍.*拦截/)
  assert.equal(fixture.detailOpens, 0)
  assert.ok(fixture.events.some(event => event.stage === 'waiting_login' && /验证码/.test(event.message)))
})
