import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { HistorySourceCategory, StoreHistorySourceInput } from './history-script-library.js'
import { HISTORY_SEARCH_DOM_JS, HISTORY_SEARCH_INPUT_SELECTOR, HISTORY_SEARCH_QUERY,
  applyHistorySearchFilters, historySearchCardSchema, historySearchStateSchema } from './history-source-search.js'
import { historySourceKeywordsSchema } from './history-source-settings.js'

const SEARCH_WAIT_MS = 90_000
const STALLED_SCROLLS = 3
const IDLE_REFRESH_MS = 60_000
const SEARCH_MIN_LIKES = 10_000
const MIN_COMMENTS = 20
const SEARCH_INPUT_SELECTOR = HISTORY_SEARCH_INPUT_SELECTOR

export interface HistoryBrowserEvent {
  stage: string
  message: string
  scanned?: number
  selected?: number
  browserUrl?: string
  candidate?: {
    outcome: 'inspecting' | 'selected' | 'skipped'
    videoId: string
    title?: string
    reason?: string
    durationSeconds?: number
    screeningStage?: 'search' | 'detail'
    likeCount?: number
    commentCount?: number
    titleEvidence?: string
    curiosityAngle?: string
    comments?: Array<{ text: string; likes?: number }>
  }
}

export interface BrowseHistoryCandidatesOptions {
  keywords?: string[]
  categories: HistorySourceCategory[]
  targetCount: number | null
  signal: AbortSignal
  excludeVideoIds?: string[]
  isKnownVideo?: (id: string) => boolean
  /** Streaming consumers can count completed drafts instead of selected candidates. */
  isTargetReached?: () => boolean
  report: (event: HistoryBrowserEvent) => void
  onCandidate?: (candidate: StoreHistorySourceInput) => Promise<void>
}

export interface HistorySourceBrowserDependencies {
  runCommand?: (args: string[], signal?: AbortSignal) => Promise<string>
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  now?: () => number
  waitForBrowserLogin?: (options: { afterRevision: string | null; signal: AbortSignal; reason?: string }) => Promise<{ revision: string }>
  markBrowserSessionReady?: (revision: string) => Promise<void>
}

const snapshotSchema = z.object({
  url: z.string(),
  documentEpoch: z.number().default(0),
  documentTitle: z.string().default(''),
  sourceVideoId: z.string(),
  bodyText: z.string(),
  title: z.string(),
  caption: z.string().default(''),
  authorName: z.string(),
  playerText: z.string(),
  playerPlaying: z.boolean(),
  pauseControlVisible: z.boolean(),
  search: historySearchStateSchema,
  scrollState: z.object({ top: z.number(), height: z.number(), viewport: z.number() }).nullable().default(null),
  metrics: z.object({ likes: z.string(), comments: z.string(), collects: z.string(), shares: z.string() }),
  cards: z.array(historySearchCardSchema),
  comments: z.array(z.object({ text: z.string(), likesText: z.string() })),
})
type BrowserSnapshot = z.infer<typeof snapshotSchema>

export interface HistoryBrowserObservation {
  sourceVideoId: string
  sourceType: 'video' | 'note'
  title: string
  caption: string
  authorName: string
  durationSeconds?: number
  metrics: NonNullable<StoreHistorySourceInput['metrics']>
  comments: Array<{ text: string; likes?: number }>
  observedAt: string
}

// Only rendered source evidence and login prompts are read.
export const HISTORY_BROWSER_SNAPSHOT_JS = `(() => {
  const visible = element => element instanceof HTMLElement && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
  const text = element => visible(element) ? (element.innerText || '').trim() : '';
  const find = (selector, scope = document) => Array.from(scope.querySelectorAll(selector)).find(visible);
  const detail = find('[data-e2e="video-detail"], [data-e2e="note-detail"], [data-e2e="image-detail"]') || document;
  const info = find('[data-e2e="detail-video-info"], [data-e2e="detail-image-info"], [data-e2e="note-info"]', detail);
  const title = find('h1, [data-e2e="note-title"]', detail);
  const captionParts = Array.from((info || detail).querySelectorAll('h1, [data-e2e="note-title"], [data-e2e="note-desc"], [data-e2e="note-content"], [data-e2e="image-desc"], [data-e2e="video-desc"], [data-e2e="detail-desc"]'))
    .map(text).filter(Boolean);
  // Current note pages render the primary caption before sidebar recommendations.
  if (!captionParts.length && /^\\/note\\/\\d+\\/?$/.test(location.pathname)) {
    const noteCaption = text(Array.from(detail.querySelectorAll('.m53pwJvW')).find(element => visible(element)
      && !element.closest('[data-e2e="user-info"], [data-e2e="comment-item"], .noteSideBarContainer')));
    if (noteCaption) captionParts.push(noteCaption);
  }
  const uniqueCaptionParts = Array.from(new Set(captionParts));
  const caption = uniqueCaptionParts.filter(part => !uniqueCaptionParts.some(other => other !== part && other.includes(part))).join('\\n');
  const countElements = info ? Array.from(info.querySelectorAll('*')).filter(element => {
    if (element.children.length || !visible(element) || title?.contains(element)) return false;
    return /^\\d+(?:\\.\\d+)?[万亿]?$/.test(text(element)) && element.parentElement?.querySelector('svg');
  }) : [];
  const desktopCounts = countElements.length === 4
    && countElements[3].closest('[data-e2e="video-share-icon-container"]') ? countElements.map(text) : [];
  const metric = (ids, index) => {
    for (const id of ids) {
      const element = find('[data-e2e="' + id + '"]', detail);
      const values = element ? [text(element), ...Array.from(element.querySelectorAll('*')).filter(child => !child.children.length).map(text)] : [];
      const count = values.find(value => /^\\d[\\d,]*(?:\\.\\d+)?[万亿]?$/.test(value.replace(/\\s/g, '')));
      if (count !== undefined) return count;
    }
    return desktopCounts[index] || '';
  };
  const player = find('[data-e2e="player-container"]', detail);
  const video = player?.querySelector('video');
  const searchPage = ${HISTORY_SEARCH_DOM_JS};
  const comments = Array.from(detail.querySelectorAll('[data-e2e="comment-item"]')).filter(visible)
    .slice(0, 15).map(item => {
      const header = item.querySelector('.comment-item-info-wrap');
      const content = header?.nextElementSibling;
      return {
        text: text(content?.querySelector('span') || content).slice(0, 1200),
        likesText: text(find('.comment-item-stats-container p', item)),
      };
    }).filter(comment => comment.text);
  return {
    url: location.href,
    documentEpoch: performance.timeOrigin,
    documentTitle: document.title,
    sourceVideoId: info?.getAttribute('data-e2e-aweme-id') || detail.getAttribute?.('data-e2e-aweme-id')
      || (/^\\/note\\/(\\d+)\\/?$/.exec(location.pathname)?.[1] || ''),
    bodyText: ((document.body?.innerText || '').match(/登录后.{0,12}(?:搜索|查看|浏览)|请先登录|扫码登录|验证码|拖动滑块|完成安全验证|请完成验证|安全校验|verify_check/g) || []).join(' '),
    title: (text(title) || caption).slice(0, 1000),
    caption,
    authorName: text(find('[data-e2e="user-info"] [data-click-from="title"], [data-e2e="note-author"], [data-e2e="video-author"]', detail)).slice(0, 100),
    playerText: text(player).slice(0, 250),
    playerPlaying: !!video && !video.paused,
    pauseControlVisible: !!find('.xgplayer-play', player || detail),
    search: searchPage.search,
    scrollState: searchPage.scrollState,
    metrics: { likes: metric(['video-player-digg', 'note-like', 'image-player-digg'], 0),
      comments: metric(['feed-comment-icon', 'note-comment', 'image-comment-icon'], 1),
      collects: metric(['video-player-collect', 'note-collect'], 2), shares: metric(['video-player-share', 'note-share'], 3) },
    cards: searchPage.cards,
    comments,
  };
})()`

export function parseHistoryMetricCount(text: string): number | undefined {
  const match = text.replace(/[,\s]/g, '').match(/^(\d+(?:\.\d+)?)([万亿])?$/)
  if (!match) return undefined
  const value = Number(match[1]) * (match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1)
  return Number.isSafeInteger(Math.round(value)) ? Math.round(value) : undefined
}

export function parseHistoryVideoSeconds(text: string): number | undefined {
  const pieces = text.trim().split(':')
  if (pieces.length < 2 || pieces.length > 3 || pieces.some(piece => !/^\d{1,3}$/.test(piece))) return undefined
  const numbers = pieces.map(Number)
  if (numbers.at(-1)! >= 60 || (pieces.length === 3 && numbers[1]! >= 60)) return undefined
  const seconds = numbers.reduce((total, value) => total * 60 + value, 0)
  return seconds > 0 && seconds < 24 * 3600 ? seconds : undefined
}

export function getHistoryVideoId(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.douyin.com')
    if (url.origin !== 'https://www.douyin.com' || url.username || url.password) return null
    return url.pathname.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1] ?? null
  } catch { return null }
}

function isHistoryImageNote(href: string): boolean {
  try {
    const url = new URL(href)
    return url.origin === 'https://www.douyin.com' && /^\/note\/\d+\/?$/.test(url.pathname)
  } catch { return false }
}

export function extractHistoryBrowserObservation(value: unknown, expectedVideoId: string, observedAt: string): HistoryBrowserObservation | null {
  const snapshot = snapshotSchema.parse(value)
  const sourceType = isHistoryImageNote(snapshot.url) ? 'note' : 'video'
  if (getHistoryVideoId(snapshot.url) !== expectedVideoId || !snapshot.title.trim()
    || (snapshot.sourceVideoId !== expectedVideoId && (sourceType !== 'note' || snapshot.sourceVideoId !== ''))) return null
  const duration = snapshot.playerText.match(/\d{1,3}:\d{2}(?::\d{2})?\s*\/\s*(\d{1,3}:\d{2}(?::\d{2})?)/)?.[1]
  const durationSeconds = duration ? parseHistoryVideoSeconds(duration) : undefined
  const metrics: HistoryBrowserObservation['metrics'] = {}
  for (const name of ['likes', 'comments', 'collects', 'shares'] as const) {
    const count = parseHistoryMetricCount(snapshot.metrics[name])
    if (count !== undefined) metrics[name] = count
  }
  if (metrics.likes === undefined || metrics.comments === undefined) return null
  const seenComments = new Set<string>()
  const comments = snapshot.comments.flatMap(comment => {
    const text = comment.text.trim()
    if (!text || seenComments.has(text)) return []
    seenComments.add(text)
    const likes = parseHistoryMetricCount(comment.likesText)
    return [{ text, ...(likes !== undefined ? { likes } : {}) }]
  })
  return { sourceVideoId: expectedVideoId, sourceType, title: snapshot.title, caption: snapshot.caption,
    authorName: snapshot.authorName, ...(durationSeconds !== undefined ? { durationSeconds } : {}), metrics, comments, observedAt }
}

export function selectHistoryBrowserObservation(
  observation: HistoryBrowserObservation,
  searchQuery: string,
): StoreHistorySourceInput | null {
  const { likes, comments } = observation.metrics
  if (likes === undefined || !Number.isFinite(likes) || likes < SEARCH_MIN_LIKES
    || comments === undefined || !Number.isFinite(comments) || comments < MIN_COMMENTS) return null
  return {
    sourceVideoId: observation.sourceVideoId,
    sourceType: observation.sourceType,
    ...(observation.sourceType === 'note' ? { sourceText: observation.caption || observation.title } : {}),
    title: observation.title,
    authorName: observation.authorName || null,
    category: 'unclassified',
    metrics: observation.metrics,
    selection: { reason: `详情页点赞${likes}（至少1万）、评论${comments}（至少20），互动数达标`, observedAt: observation.observedAt,
      comments: observation.comments,
      ...(observation.durationSeconds !== undefined ? { durationSeconds: observation.durationSeconds } : {}),
      searchQuery,
      sourceKind: observation.sourceType,
      metrics: observation.metrics,
      policyVersion: 'history-engagement-v1',
      evidenceMethod: 'browser_visible_dom',
      factCheckStatus: 'not_verified',
    },
  }
}

interface SearchCandidate {
  id: string
  href: string
  title: string
  authorName: string
  durationSeconds?: number
  likeCount?: number
}

function browserGate(snapshot: BrowserSnapshot): string | null {
  if (/验证码|拖动滑块|完成安全验证|请完成验证|安全校验|verify_check/.test(`${snapshot.documentTitle} ${snapshot.bodyText}`)) return '抖音返回验证码或安全验证页'
  if (/登录后.{0,12}(搜索|查看|浏览)|请先登录|扫码登录/.test(snapshot.bodyText)) return '抖音要求登录后浏览'
  return null
}

function searchRouteMatches(url: string, query: string): boolean {
  try {
    const actual = new URL(url)
    const match = actual.pathname.match(/^\/(?:jingxuan\/)?search\/([^/]+)\/?$/)
    return actual.origin === 'https://www.douyin.com' && !actual.username && !actual.password
      && !!match && decodeURIComponent(match[1]!) === query
  } catch { return false }
}

export async function browseHistoryCandidates(
  options: BrowseHistoryCandidatesOptions,
  dependencies: HistorySourceBrowserDependencies = {},
): Promise<StoreHistorySourceInput[]> {
  const keywords = historySourceKeywordsSchema.parse(options.keywords ?? [HISTORY_SEARCH_QUERY])
  z.number().int().min(1).max(9999).nullable().parse(options.targetCount)
  if (options.targetCount === null && !options.onCandidate) throw new Error('Continuous sourcing requires an onCandidate consumer')
  options.signal.throwIfAborted()
  const signal = options.signal
  const run = dependencies.runCommand || (await import('./history-source-chromium.js')).createChromiumCommandRunner({
    onRetry: event => report('restoring_browser', `${event.operation}被页面跳转中断，保留当前搜索位置，在原标签页重试（${event.attempt}/${event.maxAttempts}）`),
  })
  const pause = dependencies.pause || (async (milliseconds, abortSignal) => { await delay(milliseconds, undefined, { signal: abortSignal }) })
  const now = dependencies.now || Date.now
  const waitForLogin = dependencies.waitForBrowserLogin || (async loginOptions =>
    (await import('./history-source-auth.js')).waitForHistoryBrowserLogin(loginOptions))
  const markSessionReady = dependencies.markBrowserSessionReady || (async revision =>
    (await import('./history-source-auth.js')).markHistoryBrowserSessionReady(revision))
  const session = `history-source-${randomUUID()}`
  const selected: StoreHistorySourceInput[] = []
  const excluded = new Set(options.excludeVideoIds || [])
  const seen = new Set<string>()
  // Only unprocessed cards are retried when recovery replaces every task page.
  const pendingDetailIds = new Set<string>()
  // A pending decision may be discarded after login/reload without counting its card twice.
  const scannedVideoIds = new Set<string>()
  const isSeen = (id: string) => excluded.has(id) || seen.has(id) || options.isKnownVideo?.(id) === true
  const remember = (id: string) => {
    seen.add(id)
    if (seen.size > 50_000) seen.delete(seen.values().next().value!)
  }
  let selectedCount = 0
  let scanned = 0
  let examined = 0
  let sessionStarted = false
  class BrowserRestart extends Error {}
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => {
    if (!sessionStarted) return Promise.resolve()
    cleanupPromise ??= run(['browser', session, 'close'], AbortSignal.timeout(30_000)).then(() => { sessionStarted = false })
    return cleanupPromise
  }
  const onAbort = () => { void cleanup().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  const report = (stage: string, message: string, browserUrl?: string, candidate?: HistoryBrowserEvent['candidate']) => options.report({
    stage, message, scanned, selected: selectedCount,
    ...(browserUrl ? { browserUrl } : {}), ...(candidate ? { candidate } : {}),
  })
  const command = async (args: string[]) => {
    signal.throwIfAborted()
    if (!sessionStarted) {
      cleanupPromise = undefined
      sessionStarted = true
    }
    return run(['browser', session, ...args], signal)
  }
  let pendingAuthRevision: string | null = null
  let authStatusRead = false
  const readSnapshot = async () => snapshotSchema.parse(JSON.parse(await command(['eval', HISTORY_BROWSER_SNAPSHOT_JS, '--read-only'])))
  const navigate = async (url: string, newTab = false) => {
    report('browsing', '正在浏览抖音页面', url)
    // Navigation retries belong to the driver so it can retain the original page IDs.
    const result = await command(newTab ? ['tab', 'new', url] : ['open', url])
    const page = z.object({ page: z.string().min(1) }).parse(JSON.parse(result)).page
    if (!authStatusRead) {
      pendingAuthRevision = z.object({ revision: z.string().nullable() }).parse(JSON.parse(await command(['auth', 'status']))).revision
      authStatusRead = true
    }
    return page
  }
  const checkGate = async (snapshot: BrowserSnapshot) => {
    const gate = browserGate(snapshot)
    if (!gate) return snapshot
    const auth = z.object({ revision: z.string().nullable() }).parse(JSON.parse(await command(['auth', 'status'])))
    // Releasing the collector lease lets the explicit login action restart the
    // same profile visibly. Every page ID becomes invalid at this boundary.
    await cleanup()
    authStatusRead = false
    report('waiting_login', `${gate}。采集已暂停；请在“采集监控”点击“打开登录窗口”，在同一专用采集浏览器完成登录或安全验证，再点击“检测登录状态”`, snapshot.url)
    signal.throwIfAborted()
    await waitForLogin({ afterRevision: auth.revision, signal, reason: gate })
    signal.throwIfAborted()
    report('restoring_browser', '检测已通过，正在使用同一配置的无头 Chromium 中重建任务页面并复检', snapshot.url)
    const refreshed = z.object({ revision: z.string().min(1) }).parse(JSON.parse(await command(['auth', 'refresh'])))
    pendingAuthRevision = refreshed.revision
    let resumeUrl = 'https://www.douyin.com/'
    try {
      const observed = new URL(snapshot.url)
      if (observed.origin === 'https://www.douyin.com' && !observed.username && !observed.password) resumeUrl = observed.href
    } catch { /* Only resume a trusted Douyin URL. */ }
    const page = await navigate(resumeUrl)
    await command(['tab', 'select', page])
    const started = now()
    let restored = await readSnapshot()
    while (browserGate(restored) && now() - started < 10_000) {
      await pause(1500, signal)
      restored = await readSnapshot()
    }
    if (browserGate(restored)) throw new Error('同一采集浏览器的任务页面仍被抖音登录或安全验证拦截；本次任务停止，已完成稿件保留，请在采集监控中打开专用窗口检查')
    // Unwind any detail finally block before rebuilding the current search.
    throw new BrowserRestart()
  }
  const confirmReady = async () => {
    if (!pendingAuthRevision) return
    await markSessionReady(pendingAuthRevision)
    pendingAuthRevision = null
  }
  const awaitSearchState = async (ready: (snapshot: BrowserSnapshot) => boolean, failure: string) => {
    const started = now()
    while (true) {
      signal.throwIfAborted()
      const snapshot = await checkGate(await readSnapshot())
      if (ready(snapshot)) return snapshot
      if (now() - started >= SEARCH_WAIT_MS) throw new Error(failure)
      await pause(1500, signal)
    }
  }
  const search = async (query: string) => {
    const page = await navigate('https://www.douyin.com/')
    await command(['tab', 'select', page])
    await awaitSearchState(snapshot => snapshot.search.inputVisible && snapshot.search.inputReady !== false, '抖音搜索框未就绪，请检查采集浏览器')
    await command(['focus', SEARCH_INPUT_SELECTOR])
    await command(['keys', process.platform === 'darwin' ? 'Meta+a' : 'Control+a'])
    await command(['keys', 'Backspace'])
    await command(['type', SEARCH_INPUT_SELECTOR, query])
    await awaitSearchState(snapshot => snapshot.search.inputValue === query, `抖音搜索输入未生效：${query}`)
    await command(['tab', 'select', page])
    await command(['keys', 'Enter'])
    await awaitSearchState(snapshot => searchRouteMatches(snapshot.url, query) && snapshot.search.inputValue === query,
      `抖音搜索未提交到本次关键词：${query}`)
    const snapshot = await applyHistorySearchFilters({
      query, observe: async () => checkGate(await readSnapshot()),
      command, pause: milliseconds => pause(milliseconds, signal), now, signal,
      report: message => report('browsing', message),
    })
    report('browsing', `搜索已就绪：“${query}”，${snapshot.cards.length}条卡片，后续只在此页向下浏览`, snapshot.url)
    await confirmReady()
    return { snapshot, page }
  }
  const awaitSnapshot = async (expectedId: string) => {
    const started = now()
    while (true) {
      signal.throwIfAborted()
      const snapshot = await checkGate(await readSnapshot())
      const ready = extractHistoryBrowserObservation(snapshot, expectedId, new Date(now()).toISOString()) !== null
      if (ready || now() - started >= 15_000) return snapshot
      await pause(1500, signal)
    }
  }
  try {
    report('browsing', '连接专用持久化 Chromium（与人工登录共用配置，仅操作任务标签页）')
    report('selecting', `按顺序分别搜索${keywords.map(query => `“${query}”`).join('、')}；以详情页实际点赞至少1万且评论至少20为入选条件，视频和图文均可采集。`)
    const reachedTarget = () => options.isTargetReached?.() ?? (options.targetCount !== null && selectedCount >= options.targetCount)
    const inspectCard = async (card: SearchCandidate, searchPage: string, query: string) => {
      examined++
      const videoUrl = new URL(card.href, 'https://www.douyin.com').href
      const detailPage = await navigate(videoUrl, true)
      let inspectionFailed = false
      let evidence: Omit<NonNullable<HistoryBrowserEvent['candidate']>, 'outcome'> = {
        videoId: card.id, title: card.title, likeCount: card.likeCount, screeningStage: 'detail',
      }
      const skip = (reason: string) => report('browsing', `跳过${evidence.title ? `“${evidence.title.slice(0, 60)}”` : ` ${card.id}`}：${reason}`, videoUrl, { ...evidence, outcome: 'skipped', reason })
      try {
        let detail = await awaitSnapshot(card.id)
        evidence.title = detail.title
        if (detail.playerPlaying && detail.pauseControlVisible) {
          await command(['click', '[data-e2e="player-container"] .xgplayer-play'])
          await pause(500, signal)
          detail = await checkGate(await readSnapshot())
        }
        if (detail.playerPlaying) {
          skip('无法暂停播放，避免自动连播混淆来源')
          return
        }
        await confirmReady()
        const currentPage = await checkGate(await readSnapshot())
        if (getHistoryVideoId(currentPage.url) !== card.id || currentPage.playerPlaying
          || (currentPage.sourceVideoId !== card.id && (!isHistoryImageNote(currentPage.url) || currentPage.sourceVideoId !== ''))) {
          skip('浏览器当前来源已变化，未保存错配来源')
          return
        }
        const observation = extractHistoryBrowserObservation(currentPage, card.id, new Date(now()).toISOString())
        if (observation) evidence = {
          ...evidence, title: observation.title, durationSeconds: observation.durationSeconds,
          likeCount: observation.metrics.likes,
          ...(observation.metrics.comments !== undefined ? { commentCount: observation.metrics.comments } : {}),
          comments: observation.comments,
        }
        if (!observation) {
          skip('来源身份、标题或详情页点赞数、评论总数未能确认，未把未知值当作达标')
          return
        }
        signal.throwIfAborted()
        const candidate = selectHistoryBrowserObservation(observation, query)
        if (candidate) {
          selectedCount++
          report('browsing', `已选中“${candidate.title.slice(0, 60)}”：${candidate.selection!.reason}`, currentPage.url, {
            ...evidence, outcome: 'selected', reason: candidate.selection!.reason,
          })
          signal.throwIfAborted()
          if (options.onCandidate) await options.onCandidate(candidate)
          else selected.push(candidate)
          signal.throwIfAborted()
        } else skip(`详情页点赞${observation.metrics.likes}、评论${observation.metrics.comments}，需点赞至少1万且评论至少20`)
      } catch (error) {
        inspectionFailed = true
        throw error
      } finally {
        // Keep the search page and its lazy-loaded position intact while inspecting details.
        // A failed command may already release all owned pages. Preserve its error;
        // outer session cleanup will release any remaining tabs.
        if (!signal.aborted && !inspectionFailed) {
          await command(['tab', 'close', detailPage])
          await command(['tab', 'select', searchPage])
        }
      }
    }
    const scanKeyword = async (query: string, lastKeyword: boolean) => {
      const { page, snapshot: firstSnapshot } = await search(query)
      let snapshot = firstSnapshot
      let verifiedDocument = firstSnapshot.documentEpoch
      const verifySearch = async (state: BrowserSnapshot) => {
        if (!searchRouteMatches(state.url, query)) {
          throw new Error('滚动时搜索页已变化，停止以免筛选错误来源')
        }
        if (state.documentEpoch !== verifiedDocument) {
          state = await applyHistorySearchFilters({ query, observe: async () => checkGate(await readSnapshot()), command,
            pause: milliseconds => pause(milliseconds, signal), now, signal,
            report: message => report('browsing', message) })
          verifiedDocument = state.documentEpoch
        }
        if (state.search.inputValue !== query) {
          throw new Error('滚动时搜索页已变化，停止以免筛选错误来源')
        }
        return state
      }
      const searchEvidence = (card: SearchCandidate, reason: string, outcome: 'inspecting' | 'skipped' = 'skipped') => {
        report('selecting', `搜索页${outcome === 'skipped' ? '跳过' : '查看详情'}“${card.title.slice(0, 60) || card.id}”：${reason}`,
          new URL(card.href, 'https://www.douyin.com').href, { videoId: card.id, title: card.title,
            screeningStage: 'search', likeCount: card.likeCount, durationSeconds: card.durationSeconds, reason, outcome })
      }
      let exhausted = false
      do {
        let stalled = 0
        let previousTop: number | undefined
        scanResults: while (!reachedTarget() && stalled < STALLED_SCROLLS) {
          signal.throwIfAborted()
          const checked = await checkGate(snapshot)
          snapshot = await verifySearch(checked)
          await confirmReady()
          const batchIds = new Set<string>()
          const cards: SearchCandidate[] = snapshot.cards.flatMap(card => {
            const id = getHistoryVideoId(card.href)
            if (!id || isSeen(id) || batchIds.has(id)) return []
            batchIds.add(id)
            return [{ id, href: card.href, title: card.title.trim(), authorName: card.authorName,
              durationSeconds: parseHistoryVideoSeconds(card.durationText), likeCount: parseHistoryMetricCount(card.likesText) }]
          })
          let discovered = 0
          const detailCandidates: SearchCandidate[] = []
          for (const card of cards) {
            signal.throwIfAborted()
            remember(card.id)
            if (!scannedVideoIds.has(card.id)) {
              scannedVideoIds.add(card.id)
              scanned++
              if (scannedVideoIds.size > 50_000) scannedVideoIds.delete(scannedVideoIds.values().next().value!)
            }
            discovered++
            if (card.likeCount !== undefined && card.likeCount < SEARCH_MIN_LIKES) searchEvidence(card, `卡片点赞${card.likeCount}，不足1万`)
            else detailCandidates.push(card)
          }
          const batchDocument = snapshot.documentEpoch
          pendingDetailIds.clear()
          for (const card of detailCandidates) pendingDetailIds.add(card.id)
          const refreshBatch = async () => {
            const current = await checkGate(await readSnapshot())
            snapshot = await verifySearch(current)
            if (snapshot.documentEpoch === batchDocument) return false
            for (const id of pendingDetailIds) seen.delete(id)
            report('restoring_browser', '搜索页已恢复或重新加载，按当前结果重新读取未处理来源', snapshot.url)
            return true
          }
          for (const card of detailCandidates) {
            if (reachedTarget()) break
            signal.throwIfAborted()
            if (await refreshBatch()) continue scanResults
            if (options.isKnownVideo?.(card.id)) { pendingDetailIds.delete(card.id); continue }
            searchEvidence(card, card.likeCount === undefined ? '搜索页点赞数未知，进入详情读取实际互动数' : '进入详情核对实际点赞数与评论总数', 'inspecting')
            await inspectCard(card, page, query)
            pendingDetailIds.delete(card.id)
          }
          if (reachedTarget()) break
          if (snapshot.search.endReached) {
            // A refreshed snapshot may contain the last new cards; finish them first.
            if (snapshot.cards.some(card => { const id = getHistoryVideoId(card.href); return id && !isSeen(id) })) continue scanResults
            exhausted = true
            report('keyword_exhausted', `“${query}”搜索结果底部显示“暂时没有更多了”，该关键词最后一批视频已处理完`, snapshot.url)
            break
          }
          const scroll = snapshot.scrollState
          const hasMoreBelow = scroll !== null && scroll.height > scroll.viewport
            && scroll.top < scroll.height - scroll.viewport - 2
          const moved = previousTop === undefined || (scroll !== null && scroll.top > previousTop + 1)
          stalled = discovered || (hasMoreBelow && moved) ? 0 : stalled + 1
          previousTop = scroll?.top
          if (stalled >= STALLED_SCROLLS) break
          report('scrolling', `继续向下滚动“${query}”，本批发现${discovered}条新视频，累计浏览${scanned}条`, snapshot.url)
          await command(['scroll', 'down', '--amount', '700'])
          // Keep waiting abortable outside the page, including while background tabs are throttled.
          for (let attempt = 0; attempt < 3; attempt++) {
            await pause(1500, signal)
            snapshot = await readSnapshot()
            if (browserGate(snapshot) || snapshot.search.endReached) break
            if (snapshot.cards.some(card => { const id = getHistoryVideoId(card.href); return id && !isSeen(id) })) break
          }
        }
        if (options.targetCount === null && lastKeyword && !reachedTarget() && !exhausted) {
          report('waiting_results', `“${query}”当前滚动位置暂无新结果，等待新视频；60秒后从原位置继续，不返回第一页`)
          await pause(IDLE_REFRESH_MS, signal)
          await command(['tab', 'select', page])
          await command(['scroll', 'down', '--amount', '700'])
          await pause(1500, signal)
          snapshot = await readSnapshot()
        }
      } while (options.targetCount === null && lastKeyword && !reachedTarget() && !exhausted)
      if (!exhausted && !reachedTarget() && !lastKeyword) {
        report('keyword_stalled', `“${query}”连续滚动暂无新结果，继续下一个关键词；该搜索尚未确认到底`, snapshot.url)
      }
      return exhausted
    }
    let allExhausted = true
    for (const [index, query] of keywords.entries()) {
      signal.throwIfAborted()
      if (reachedTarget()) break
      report('keyword_search', `开始搜索关键词 ${index + 1}/${keywords.length}：“${query}”`)
      while (true) {
        try {
          const exhausted = await scanKeyword(query, index === keywords.length - 1)
          allExhausted &&= exhausted
          break
        } catch (error) {
          if (!(error instanceof BrowserRestart)) throw error
          signal.throwIfAborted()
          for (const id of pendingDetailIds) seen.delete(id)
          pendingDetailIds.clear()
          report('restoring_browser', `登录已恢复，重新完成“${query}”的搜索；已处理来源保留，未处理来源重新核验`)
        }
      }
    }
    if (allExhausted && !reachedTarget()) {
      report('exhausted', '全部关键词的搜索结果均显示“暂时没有更多了”，最后一批视频已处理完，本轮采集结束')
    }
    report('browsing', `筛选结束，浏览${scanned}条候选，核验${examined}条详情，选中${selectedCount}条符合条件的新来源`)
  } finally {
    signal.removeEventListener('abort', onAbort)
    try { await cleanup() }
    catch { report('browsing', 'Chromium 任务标签页释放失败，请检查采集浏览器；不会关闭专用窗口') }
  }
  signal.throwIfAborted()
  return selected
}
