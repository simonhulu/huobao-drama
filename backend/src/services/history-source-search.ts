import { z } from 'zod'

export const HISTORY_SEARCH_QUERY = '历史'
export const HISTORY_SEARCH_INPUT_SELECTOR = 'input[data-e2e="searchbar-input"]'
const emptyFilters = { menuVisible: false, triggerSelector: null, durationSelected: false, videoSelected: false,
  durationOptionVisible: false, videoOptionVisible: false }

export const historySearchStateSchema = z.object({
  inputVisible: z.boolean(), inputReady: z.boolean().optional(), inputValue: z.string(),
  videoTabVisible: z.boolean().default(false), videoTabSelected: z.boolean().default(false),
  endReached: z.boolean().default(false),
  resultsLoading: z.boolean().optional(),
  layout: z.object({ singleColumnSelected: z.boolean(), multiColumnSelector: z.string().nullable() }).optional(),
  filters: z.object({ menuVisible: z.boolean(), triggerSelector: z.string().nullable(), durationSelected: z.boolean(),
    videoSelected: z.boolean(), durationOptionVisible: z.boolean(), videoOptionVisible: z.boolean(),
    durationSelector: z.string().nullable().optional(), videoSelector: z.string().nullable().optional(),
    publishTimeUnrestricted: z.boolean().optional(), publishTimeSelector: z.string().nullable().optional(),
  }).default(emptyFilters),
})

export const historySearchCardSchema = z.object({
  href: z.string(), title: z.string().default(''), authorName: z.string().default(''), durationText: z.string().default(''),
  likesText: z.string().default(''), leafTexts: z.array(z.string()).default([]),
})

// Only rendered DOM is read: no site stores, private network responses or browser credentials.
export const HISTORY_SEARCH_DOM_JS = `(() => {
  const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const text = element => visible(element) ? (element.innerText || '').trim() : '';
  const find = (selector, scope = document) => Array.from(scope.querySelectorAll(selector)).find(visible);
  const input = find('${HISTORY_SEARCH_INPUT_SELECTOR}');
  const videoTab = find('span[data-key="video"]');
  const otherTabs = ['general', 'user', 'live'].map(key => find('span[data-key="' + key + '"]')).filter(Boolean);
  const videoTabSelected = !!videoTab && (videoTab.getAttribute('aria-selected') === 'true'
    || (videoTab.getAttribute('aria-selected') !== 'false' && otherTabs.length > 0
      && otherTabs.every(tab => Number(getComputedStyle(videoTab).fontWeight) > Number(getComputedStyle(tab).fontWeight))));
  const selectorPath = element => {
    if (!element) return null;
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const tag = node.tagName.toLowerCase();
      const peers = node.parentElement ? Array.from(node.parentElement.children).filter(peer => peer.tagName === node.tagName) : [node];
      parts.unshift(tag + (peers.length > 1 ? ':nth-of-type(' + (peers.indexOf(node) + 1) + ')' : ''));
    }
    return parts.join(' > ');
  };
  const candidates = Array.from(document.querySelectorAll('[id^="waterfall_item_"], [data-e2e="scroll-list"] li')).filter(visible);
  const seen = new Set();
  const cards = candidates.map(item => {
    const id = item.id.match(/^waterfall_item_(\\d+)$/)?.[1];
    const link = find('a[href*="/video/"], a[href*="/note/"]', item);
    const href = link?.getAttribute('href') || (id ? '/video/' + id : '');
    if (!href || seen.has(href)) return null;
    seen.add(href);
    const leafTexts = Array.from(item.querySelectorAll('*')).filter(element => !element.children.length && visible(element))
      .map(text).filter(Boolean).slice(0, 40);
    const durationText = text(find('.ZYKiUg6O', item)) || leafTexts.find(value => /^\\d{1,3}:\\d{2}(?::\\d{2})?$/.test(value)) || '';
    const likesText = text(find('.g5BarT4O > span, [data-e2e="video-player-digg"], [data-e2e="video-like"]', item));
    const title = text(find('.hu36PKCP, [data-e2e="video-desc"], [data-e2e="search-video-desc"]', item));
    const authorName = text(find('.vgw3V2Fj, [data-e2e="video-author"], [data-e2e="search-video-author"]', item));
    return { href, title, authorName, durationText, likesText, leafTexts };
  }).filter(Boolean).slice(-120);
  let scrollContainer = candidates[0] || document.querySelector('#waterFallScrollContainer, [data-e2e="scroll-list"]');
  while (scrollContainer && !(scrollContainer.scrollHeight > scrollContainer.clientHeight + 1
    && /auto|scroll/.test(getComputedStyle(scrollContainer).overflowY))) scrollContainer = scrollContainer.parentElement;
  const scrollState = scrollContainer
    ? { top: scrollContainer.scrollTop, height: scrollContainer.scrollHeight, viewport: scrollContainer.clientHeight }
    : { top: window.scrollY, height: document.scrollingElement?.scrollHeight || 0, viewport: window.innerHeight };
  const resultRoot = document.querySelector('#waterFallScrollContainer, [data-e2e="scroll-list"]');
  const resultsLoading = !!resultRoot && (resultRoot.getAttribute('aria-busy') === 'true'
    || Array.from(resultRoot.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-e2e="loading"]')).some(visible)
    || Array.from(resultRoot.querySelectorAll('*')).some(element => visible(element) && !element.children.length
      && !element.closest('[id^="waterfall_item_"], li') && /^(?:正在加载|加载中|搜索中)(?:[.。…]*)$/.test(text(element))));
  const clip = scrollContainer?.getBoundingClientRect();
  const endReached = !!resultRoot && Array.from(resultRoot.querySelectorAll('*')).some(element => {
    if (!visible(element) || text(element) !== '暂时没有更多了'
      || element.closest('[id^="waterfall_item_"], [data-e2e="scroll-list"] li, [role="dialog"]')) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, clip?.top || 0)
      && rect.top < Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight)
      && rect.right > Math.max(0, clip?.left || 0) && rect.left < Math.min(window.innerWidth, clip?.right ?? window.innerWidth);
  });
  const layoutControl = label => {
    const root = (find('span[data-key="general"]') || videoTab)?.parentElement || document;
    const leaf = Array.from(root.querySelectorAll('button, [role="button"], div, span'))
      .find(element => visible(element) && text(element) === label && !element.querySelector('div, span'));
    return leaf?.closest('button, [role="button"]') || leaf?.parentElement || null;
  };
  const multiColumn = layoutControl('多列');
  const singleColumn = layoutControl('单列');
  const singleColumnSelected = !!singleColumn && (singleColumn.getAttribute('aria-pressed') === 'true'
    || singleColumn.getAttribute('aria-selected') === 'true' || singleColumn.classList.contains('o7gl3GAk'));
  return {
    search: { inputVisible: !!input, inputReady: !!input && document.readyState === 'complete' && !input.disabled && !input.readOnly,
      inputValue: input?.value || '', videoTabVisible: !!videoTab, videoTabSelected, endReached, resultsLoading,
      layout: { singleColumnSelected, multiColumnSelector: selectorPath(multiColumn) } },
    cards, scrollState,
  };
})()`

type SearchSnapshot = { url: string; search: z.infer<typeof historySearchStateSchema>; cards: unknown[] }

export class HistorySearchFilterError extends Error {
  constructor(message: string) { super(message); this.name = 'HistorySearchFilterError' }
}

function correctSearch(url: string, query: string): boolean {
  try {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/^\/(?:jingxuan\/)?search\/([^/]+)\/?$/)
    return parsed.origin === 'https://www.douyin.com' && !parsed.username && !parsed.password
      && !!match && decodeURIComponent(match[1]!) === query
  } catch { return false }
}

function cardIdentity(card: unknown): string | null {
  if (typeof card !== 'object' || card === null || !('href' in card) || typeof card.href !== 'string') return null
  try {
    const url = new URL(card.href, 'https://www.douyin.com')
    const match = url.pathname.match(/^\/(video|note)\/(\d+)\/?$/)
    return url.origin === 'https://www.douyin.com' && !url.username && !url.password && match ? `/${match[1]}/${match[2]}` : null
  } catch { return null }
}

// Retain the exported name for existing collectors; this only waits for results.
export async function applyHistorySearchFilters<T extends SearchSnapshot>(options: {
  query?: string
  observe: () => Promise<T>
  command: (args: string[]) => Promise<string>
  pause: (milliseconds: number) => Promise<void>
  now: () => number
  signal: AbortSignal
  report?: (message: string) => void
}): Promise<T> {
  const query = options.query ?? HISTORY_SEARCH_QUERY
  const deadline = options.now() + 90_000
  let previousCards: string | null = null
  let layoutSwitches = 0
  let lastSnapshot: T | undefined
  const identities = (snapshot: T) => snapshot.cards.map(cardIdentity).filter((identity): identity is string => identity !== null).join(',')
  const pause = async (milliseconds: number) => { options.signal.throwIfAborted(); await options.pause(milliseconds); options.signal.throwIfAborted() }
  for (let attempt = 0; attempt < 180 && options.now() < deadline; attempt++) {
    options.signal.throwIfAborted()
    const snapshot = await options.observe()
    lastSnapshot = snapshot
    options.signal.throwIfAborted()
    if (!correctSearch(snapshot.url, query) || !snapshot.search.inputVisible
      || snapshot.search.inputReady === false || snapshot.search.inputValue.trim() !== query) {
      previousCards = null
      await pause(500)
      continue
    }
    const currentCards = identities(snapshot)
    if (snapshot.search.layout?.singleColumnSelected) {
      const selector = snapshot.search.layout.multiColumnSelector
      if (!selector || layoutSwitches >= 3) throw new HistorySearchFilterError('搜索布局未就绪：未能切换为多列搜索结果，未开始扫描。请点击“重试采集”重新搜索。')
      options.report?.('搜索布局：切换为“多列”')
      await options.command(['click', selector])
      options.signal.throwIfAborted()
      layoutSwitches++
      previousCards = null
      await pause(1000)
      continue
    }
    if (snapshot.search.resultsLoading || (!currentCards && !snapshot.search.endReached)) {
      previousCards = null
      await pause(500)
      continue
    }
    // The same IDs can be valid for a new query; require consecutive non-loading
    // observations rather than new IDs or a transient empty result list.
    if (currentCards === previousCards) {
      options.report?.(currentCards ? `搜索结果已就绪：“${query}” · 视频或图文` : `搜索结果已结束：“${query}” · 暂无视频或图文`)
      return snapshot
    }
    previousCards = currentCards
    await pause(500)
  }
  const state = lastSnapshot?.search
  const reason = !state?.inputVisible || state.inputReady === false ? '抖音搜索框尚未就绪'
    : !lastSnapshot || !correctSearch(lastSnapshot.url, query) ? `当前页面不是“${query}”的搜索结果，请重新提交该关键词`
      : state.inputValue.trim() !== query ? `搜索框中的关键词与“${query}”不一致，请重新输入并提交`
        : state.resultsLoading ? '抖音仍在加载搜索结果'
          : !identities(lastSnapshot) && !state.endReached ? '抖音未返回可读取的视频或图文结果，也未显示结果已结束'
            : '搜索结果持续变化，尚未稳定'
  throw new HistorySearchFilterError(`搜索结果未就绪：${reason}；未开始扫描。请点击“重试采集”重新检测并搜索；若仍失败，在“采集监控 → 连接检测”打开登录窗口查看抖音提示。已保存稿件保留。`)
}
