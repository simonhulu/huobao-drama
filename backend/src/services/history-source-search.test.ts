import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { applyHistorySearchFilters, HISTORY_SEARCH_DOM_JS, historySearchCardSchema, historySearchStateSchema } from './history-source-search.js'

const card = { href: '/video/7639596515044249691', title: '帝王的谥号有何由来？', authorName: '历史作者', durationText: '07:58', likesText: '2.8万', leafTexts: [] }
function snapshot(options: { query?: string; menu?: boolean; duration?: boolean; video?: boolean; cards?: typeof card[] } = {}) {
  return {
    url: `https://www.douyin.com/jingxuan/search/${encodeURIComponent(options.query || '历史')}?type=general`,
    search: { inputVisible: true, inputValue: options.query || '历史', videoTabVisible: true, videoTabSelected: false, endReached: false,
      filters: { menuVisible: options.menu ?? false, triggerSelector: '#filter > span', durationSelected: options.duration ?? false,
        videoSelected: options.video ?? false, durationOptionVisible: options.menu ?? false, videoOptionVisible: options.menu ?? false } },
    cards: options.cards || [{ ...card }],
  }
}

test('accepts stable general-search cards without opening filters or choosing the video tab', async () => {
  const state = snapshot()
  const commands: string[][] = []
  let clock = 0
  let reads = 0
  const result = await applyHistorySearchFilters({
    observe: async () => { reads++; return state },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
    command: async args => { commands.push(args); return '{}' },
  })
  assert.deepEqual(commands, [])
  assert.equal(reads, 2)
  assert.equal(result.search.videoTabSelected, false)
  assert.equal(result.search.filters.videoSelected, false)
  assert.equal(result.search.filters.durationSelected, false)
})

test('legacy filter state never causes a date, duration or content-type click', async () => {
  const commands: string[][] = []
  const observe = async () => {
    const state = snapshot({ menu: true })
    return { ...state, search: { ...state.search, filters: { ...state.search.filters,
      publishTimeUnrestricted: false, publishTimeSelector: '#date-any' } } }
  }
  const result = await applyHistorySearchFilters({
    observe, now: Date.now, pause: async () => {}, signal: new AbortController().signal,
    command: async args => { commands.push(args); return '{}' },
  })
  assert.deepEqual(commands, [])
  assert.equal(result.search.filters.durationSelected, false)
  assert.equal(result.search.filters.videoSelected, false)
  assert.equal(result.search.filters.publishTimeUnrestricted, false)
})

test('image-text cards satisfy readiness without a video tab or a duration', async () => {
  const state = snapshot({ cards: [{ ...card, href: '/note/7639596515044249691', durationText: '' }] })
  const result = await applyHistorySearchFilters({
    observe: async () => ({ ...state, search: { ...state.search, videoTabVisible: false } }),
    command: async () => { assert.fail('Image-text search must not click any filters or tabs'); return '' },
    now: Date.now, pause: async () => {}, signal: new AbortController().signal,
  })
  assert.equal(result.cards[0]?.href, '/note/7639596515044249691')
})

test('search state keeps old fixture fields optional and accepts old populated filters', () => {
  const normal = historySearchStateSchema.parse({ inputVisible: true, inputValue: '历史' })
  assert.equal(normal.videoTabSelected, false)
  assert.equal(normal.filters.menuVisible, false)
  const legacy = snapshot({ menu: true, duration: true, video: true }).search
  assert.deepEqual(historySearchStateSchema.parse(legacy), legacy)
})

test('stable same-ID results do not require the site to refresh or return new IDs', async () => {
  const state = snapshot()
  let clock = 0
  let clicks = 0
  const result = await applyHistorySearchFilters({
    observe: async () => state, command: async () => { clicks++; return '{}' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  })
  assert.equal(result.cards[0]?.href, card.href)
  assert.equal(clicks, 0)
  assert.equal(clock, 500)
})

test('unchanged cards are not accepted while the search results are still loading', async () => {
  const state = snapshot()
  let clock = 0
  let loadingReads = 0
  const result = await applyHistorySearchFilters({
    observe: async () => ({ ...state, search: { ...state.search, resultsLoading: loadingReads++ < 5 } }),
    command: async () => { assert.fail('Waiting for results cannot click filters'); return '' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  })
  assert.equal(result.search.resultsLoading, false)
  assert.ok(loadingReads >= 7)
})

test('unready input times out with an actionable input error and no filter clicks', async () => {
  let clock = 0
  const state = snapshot()
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => ({ ...state, search: { ...state.search, inputReady: false } }),
    command: async () => { assert.fail('Input readiness cannot click filters'); return '' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  }), error => error instanceof Error && /搜索框尚未就绪/.test(error.message) && /重试采集/.test(error.message)
    && !/筛选|5分钟以上|未选中/.test(error.message))
  assert.equal(clock, 90_000)
})

test('empty results without an end marker time out instead of reporting missing filter selections', async () => {
  let clock = 0
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => snapshot({ cards: [] }),
    command: async () => { assert.fail('Empty results cannot click filters'); return '' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  }), /未返回可读取的视频或图文结果/)
})

test('a persistent loading indicator cannot be mistaken for stable results', async () => {
  let clock = 0
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => { const state = snapshot(); return { ...state, search: { ...state.search, resultsLoading: true } } },
    command: async () => '{}',
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  }), /仍在加载搜索结果/)
})

test('rejects a stale query without performing any filter or layout click', async () => {
  let commands = 0
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => snapshot({ query: '南京旅游', duration: false }), command: async () => { commands++; return '{}' },
    now: Date.now, pause: async () => {}, signal: new AbortController().signal,
  }), /历史/)
  assert.equal(commands, 0)
})

test('custom keywords verify their own URL and input rather than accepting historical results', async () => {
  let commands = 0
  const options = { query: '明朝', command: async () => { commands++; return '{}' },
    now: Date.now, pause: async () => {}, signal: new AbortController().signal }
  const result = await applyHistorySearchFilters({ ...options, observe: async () => snapshot({ query: '明朝' }) })
  assert.equal(result.search.inputValue, '明朝')
  await assert.rejects(applyHistorySearchFilters({ ...options, observe: async () => snapshot({ query: '历史' }) }), /明朝/)
  assert.equal(commands, 0)
})

test('waits for the submitted keyword route and matching input before counting stable cards', async () => {
  const state = snapshot()
  const observations = [
    { ...state, url: 'https://www.douyin.com/' },
    { ...state, search: { ...state.search, inputValue: '' } },
    state, state,
  ]
  let reads = 0
  await applyHistorySearchFilters({
    observe: async () => observations[Math.min(reads++, observations.length - 1)]!,
    command: async () => { assert.fail('Waiting for the submitted query cannot click'); return '' },
    now: Date.now, pause: async () => {}, signal: new AbortController().signal,
  })
  assert.equal(reads, 4)
})

test('a correct search route with stale input reports a keyword mismatch', async () => {
  const state = snapshot()
  let clock = 0
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => ({ ...state, search: { ...state.search, inputValue: '南京旅游' } }),
    command: async () => { assert.fail('A stale query cannot click'); return '' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  }), /搜索框中的关键词.*历史.*不一致/)
})

test('switches a single-column keyword result to grid and waits for stable cards without selecting filters', async () => {
  let singleColumn = true
  let loadingReads = 0
  let clock = 0
  const commands: string[][] = []
  const observe = async () => {
    const loading = singleColumn || loadingReads-- > 0
    const state = snapshot({ query: '明朝', cards: loading ? [] : [card] })
    return { ...state, search: { ...state.search, layout: { singleColumnSelected: singleColumn, multiColumnSelector: '#multi' } } }
  }
  const result = await applyHistorySearchFilters({
    query: '明朝', observe, now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
    command: async args => {
      commands.push(args)
      assert.deepEqual(args, ['click', '#multi'], 'Only a multi-column layout click is allowed')
      singleColumn = false
      loadingReads = 2
      return '{}'
    },
  })
  assert.deepEqual(commands, [['click', '#multi']])
  assert.equal(result.cards.length, 1)
})

test('ignored single-column layout switches stop after three clicks without touching filters', async () => {
  let clock = 0
  const commands: string[][] = []
  const state = snapshot({ query: '明朝', duration: false, cards: [] })
  await assert.rejects(applyHistorySearchFilters({
    query: '明朝', observe: async () => ({ ...state, search: { ...state.search,
      layout: { singleColumnSelected: true, multiColumnSelector: '#multi' } } }),
    command: async args => { commands.push(args); return '{}' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  }), /多列/)
  assert.deepEqual(commands, [['click', '#multi'], ['click', '#multi'], ['click', '#multi']])
})

test('a stale query cannot trigger a layout switch', async () => {
  const state = snapshot({ query: '历史', cards: [] })
  let commands = 0
  await assert.rejects(applyHistorySearchFilters({
    query: '明朝', observe: async () => ({ ...state, search: { ...state.search,
      layout: { singleColumnSelected: true, multiColumnSelector: '#multi' } } }),
    command: async () => { commands++; return '{}' }, now: Date.now, pause: async () => {}, signal: new AbortController().signal,
  }), /明朝/)
  assert.equal(commands, 0)
})

test('stopping during a layout click never returns success or continues observing', async () => {
  const controller = new AbortController()
  let commands = 0
  const state = snapshot()
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => ({ ...state, search: { ...state.search,
      layout: { singleColumnSelected: true, multiColumnSelector: '#multi' } } }),
    command: async () => { commands++; controller.abort(new Error('operator stopped')); return '{}' },
    now: Date.now, pause: async () => {}, signal: controller.signal,
  }), /operator stopped/)
  assert.equal(commands, 1)
})

test('waits past empty and changing result lists for two stable observations', async () => {
  const observations = [snapshot({ cards: [] }), snapshot(), snapshot({ cards: [{ ...card, href: '/video/7639596515044249692' }] }), snapshot({ cards: [{ ...card, href: '/video/7639596515044249692' }] })]
  let reads = 0
  const result = await applyHistorySearchFilters({ observe: async () => observations[Math.min(reads++, observations.length - 1)]!,
    command: async () => { assert.fail('Results must stabilize without filter clicks'); return '' }, now: Date.now, pause: async () => {}, signal: new AbortController().signal })
  assert.equal(reads, 4)
  assert.equal(result.cards[0]!.href, '/video/7639596515044249692')
})

test('a loading observation resets stability even with matching cards and an end marker', async () => {
  const state = snapshot()
  state.search.endReached = true
  const observations = [state, { ...state, search: { ...state.search, resultsLoading: true } }, state, state]
  let reads = 0
  await applyHistorySearchFilters({
    observe: async () => observations[Math.min(reads++, observations.length - 1)]!,
    command: async () => { assert.fail('Loading results cannot click'); return '' },
    now: Date.now, pause: async () => {}, signal: new AbortController().signal,
  })
  assert.equal(reads, 4)
})

test('continuously changing cards fail with a stability reason within the bounded budget', async () => {
  let clock = 0
  let reads = 0
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => snapshot({ cards: [{ ...card, href: `/note/${++reads}` }] }),
    command: async () => { assert.fail('Changing results cannot click'); return '' },
    now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
  }), /搜索结果持续变化，尚未稳定/)
  assert.equal(reads, 180)
  assert.equal(clock, 90_000)
})

test('stopping while waiting for results returns cancellation instead of readiness', async () => {
  const controller = new AbortController()
  let reads = 0
  await assert.rejects(applyHistorySearchFilters({
    observe: async () => { reads++; return snapshot() },
    command: async () => { assert.fail('Waiting for stable results cannot click'); return '' },
    now: Date.now, pause: async () => { controller.abort(new Error('operator stopped')) }, signal: controller.signal,
  }), /operator stopped/)
  assert.equal(reads, 1)
})

test('unknown, credentialed and foreign-domain card URLs cannot satisfy search readiness', async () => {
  for (const href of ['/user/someone', 'https://example.com/video/7639596515044249691',
    'https://example.com/note/7639596515044249691', 'https://user:password@www.douyin.com/note/7639596515044249691']) {
    let clock = 0
    await assert.rejects(applyHistorySearchFilters({
      observe: async () => snapshot({ cards: [{ ...card, href }] }),
      command: async () => { assert.fail('Invalid cards cannot click filters'); return '' },
      now: () => clock, pause: async ms => { clock += ms }, signal: new AbortController().signal,
    }), /未返回可读取的视频或图文结果/)
  }
})

test('an explicit empty end result does not wait for nonexistent cards or filters', async () => {
  let reads = 0
  const state = snapshot({ cards: [] })
  state.search.endReached = true
  const result = await applyHistorySearchFilters({
    observe: async () => { reads++; return state }, command: async () => { assert.fail('Empty end result cannot click filters'); return '' },
    now: Date.now, pause: async () => {}, signal: new AbortController().signal,
  })
  assert.equal(reads, 2)
  assert.equal(result.cards.length, 0)
})

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')

test('only a visible results footer marks the end, never a title, hidden text or offscreen footer', { skip: !existsSync(executablePath) }, async () => {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<div>暂时没有更多了</div>
      <div id="scroll" style="overflow-y:auto;height:100px"><div id="waterFallScrollContainer">
        <div id="waterfall_item_123" style="height:300px"><div class="hu36PKCP">暂时没有更多了</div></div>
        <div id="footer" class="OEHDkWcM" style="height:60px">暂时没有更多了</div>
      </div></div>`)
    const readEnd = async () => (await page.evaluate(HISTORY_SEARCH_DOM_JS) as { search: { endReached: boolean } }).search.endReached
    assert.equal(await readEnd(), false)
    await page.$eval('#scroll', e => { e.scrollTop = e.scrollHeight })
    assert.equal(await readEnd(), true)
    await page.$eval('#footer', e => { (e as HTMLElement).style.visibility = 'hidden' })
    assert.equal(await readEnd(), false)
    await page.$eval('#footer', e => { (e as HTMLElement).style.visibility = 'visible'; e.textContent = '还在加载中' })
    assert.equal(await readEnd(), false)
  } finally { await browser.close() }
})

test('rendered DOM extracts waterfall cards and the actual scroll ancestor without reading filters or inventing comments', { skip: !existsSync(executablePath) }, async () => {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>.selected {font-weight:500} span[data-index1] {font-weight:400} span.selected[data-index1] {font-weight:500}</style>
      <input data-e2e="searchbar-input" value="历史"><nav><span data-key="general" style="font-weight:600">综合</span><span data-key="video">视频</span>
      <div id="multi" class="f7REMuOU"><svg></svg><div>多列</div></div><div id="single" class="o7gl3GAk"><svg></svg><div>单列</div></div></nav>
      <div id="filter" tabindex="0"><span>筛选</span><div>
      <div><span data-index1="2" data-index2="0">不限</span><span data-index1="2" data-index2="3" class="selected">5分钟以上</span></div>
      <div><span data-index1="4" data-index2="0">不限</span><span data-index1="4" data-index2="1" class="selected">视频</span></div></div></div>
      <div class="route-scroll-container" style="overflow-y:auto;height:80px"><div id="waterFallScrollContainer">
      <div id="waterfall_item_7639596515044249691" style="height:500px"><div class="search-result-card"><div class="ZYKiUg6O">07:58</div><div class="g5BarT4O"><svg></svg><span>2.8万</span></div><div class="hu36PKCP">帝王的谥号有何由来？</div><span class="vgw3V2Fj">历史作者</span></div></div>
      <div id="waterfall_item_7639596515044249692" style="display:none"><div class="hu36PKCP">hidden</div></div>
      </div></div>`)
    const dom = await page.evaluate(HISTORY_SEARCH_DOM_JS) as { search: unknown; cards: unknown[]; scrollState: { top: number; height: number; viewport: number } }
    const state = historySearchStateSchema.parse(dom.search)
    assert.equal(state.filters.durationSelected, false)
    assert.equal(state.filters.videoSelected, false)
    assert.equal(state.filters.triggerSelector, null)
    assert.equal(state.videoTabSelected, false)
    assert.equal(state.layout?.singleColumnSelected, true)
    assert.equal(state.layout?.multiColumnSelector, '#multi')
    await page.$eval('#single', e => { e.classList.remove('o7gl3GAk') })
    assert.equal(historySearchStateSchema.parse((await page.evaluate(HISTORY_SEARCH_DOM_JS) as { search: unknown }).search).layout?.singleColumnSelected, false)
    assert.equal(dom.cards.length, 1)
    assert.equal(state.resultsLoading, false)
    await page.$eval('#waterFallScrollContainer', e => e.setAttribute('aria-busy', 'true'))
    assert.equal(historySearchStateSchema.parse((await page.evaluate(HISTORY_SEARCH_DOM_JS) as { search: unknown }).search).resultsLoading, true)
    await page.$eval('#waterFallScrollContainer', e => e.removeAttribute('aria-busy'))
    const found = historySearchCardSchema.parse(dom.cards[0])
    assert.equal(found.href, '/video/7639596515044249691')
    assert.equal(found.durationText, '07:58')
    assert.equal(found.likesText, '2.8万')
    assert.equal(found.title, '帝王的谥号有何由来？')
    assert.equal(found.authorName, '历史作者')
    assert.ok(!('comments' in found) && !('collects' in found))
    assert.equal(dom.scrollState.viewport, 80)
    assert.equal(dom.scrollState.height, 500)
  } finally { await browser.close() }
})

test('rendered search ignores legacy filter controls and preserves note links instead of inventing video links', { skip: !existsSync(executablePath) }, async () => {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<input data-e2e="searchbar-input" value="历史">
      <div><span data-index1="2" data-index2="0" aria-selected="false">不限</span><span data-index1="2" data-index2="3" aria-selected="true">半年内</span></div>
      <div><span data-index1="3" data-index2="0" aria-selected="true">不限</span><span data-index1="3" data-index2="4" aria-selected="false">5分钟以上</span></div>
      <div><span data-index1="5" data-index2="0" aria-selected="false">不限</span><span data-index1="5" data-index2="2" aria-selected="true">视频</span></div>
      <div id="waterFallScrollContainer"><div id="waterfall_item_7639596515044249691">
        <a href="/note/7639596515044249691"><div data-e2e="search-video-desc">明朝历史图文</div></a>
      </div></div>`)
    const dom = await page.evaluate(HISTORY_SEARCH_DOM_JS) as { search: unknown; cards: unknown[] }
    const state = historySearchStateSchema.parse(dom.search)
    assert.equal(state.videoTabVisible, false)
    assert.equal(state.filters.menuVisible, false)
    assert.equal(state.filters.durationSelected, false)
    assert.equal(state.filters.videoSelected, false)
    assert.equal(state.filters.publishTimeSelector, undefined)
    assert.equal(dom.cards.length, 1)
    assert.equal(historySearchCardSchema.parse(dom.cards[0]).href, '/note/7639596515044249691')
  } finally { await browser.close() }
})

test('legacy list cards keep rendered evidence and duration while hidden or unrelated elements are omitted', { skip: !existsSync(executablePath) }, async () => {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setContent(`<input data-e2e="searchbar-input" value="历史"><ul data-e2e="scroll-list">
      <li><a href="/video/7639596515044249691"><span>07:58</span><div><svg></svg><span>2.8万</span></div><div data-e2e="video-desc">帝王的谥号有何由来？</div><span data-e2e="video-author">历史作者</span></a></li>
      <li style="display:none"><a href="/video/7639596515044249692">hidden</a></li>
      <li><a href="/note/7639596515044249693"><div data-e2e="video-desc">历史图文</div></a></li>
      <li><a href="/user/someone">相关用户</a></li></ul>`)
    const dom = await page.evaluate(HISTORY_SEARCH_DOM_JS) as { cards: unknown[] }
    assert.equal(dom.cards.length, 2)
    const found = historySearchCardSchema.parse(dom.cards[0])
    assert.equal(found.href, '/video/7639596515044249691')
    assert.equal(found.durationText, '07:58')
    assert.ok(found.leafTexts.includes('帝王的谥号有何由来？'))
    assert.equal(historySearchCardSchema.parse(dom.cards[1]).href, '/note/7639596515044249693')
  } finally { await browser.close() }
})
