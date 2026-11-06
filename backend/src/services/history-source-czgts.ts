import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { fetchBaijiahaoArticle, normalizeBaijiahaoArticleUrl } from './history-source-baijiahao.js'

const endpoint = 'https://www.czgts.cn/muse/content/api/v1/hots/search?appVersion='
const credentialsFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/secrets/czgts/credentials.json')
const messages = {
  login_required: '请在采集设置中更新 czgts.cn 登录 Cookie 后重试',
  storage: 'czgts.cn 登录配置不可用，请检查本机配置文件权限',
  invalid_cookie: '请粘贴有效的 Cookie 请求头内容，不能包含换行',
  network: 'czgts.cn 请求失败或超时，请稍后重试',
  upstream: 'czgts.cn 拒绝了本次查询，请检查登录状态、账户权限或稍后重试',
  invalid_response: 'czgts.cn 返回了无法识别的文章列表，采集已停止',
  pagination: 'czgts.cn 分页未继续返回新结果，已停止以避免重复请求',
} as const

export class CzgtsSourceError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = 'CzgtsSourceError' }
}

export function normalizeCzgtsCookie(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32_768 || /[^\x20-\x7e]/.test(value)) throw new CzgtsSourceError('invalid_cookie')
  const cookie = value.trim().replace(/^cookie:\s*/i, '')
  const pairs = cookie.split(';').map(pair => pair.trim()).filter(Boolean)
  if (!pairs.length || pairs.some(pair => !/^[!#$%&'*+.^_`|~0-9a-z-]+=[^;]*$/i.test(pair))) throw new CzgtsSourceError('invalid_cookie')
  return pairs.join('; ')
}

async function ensureDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory)
  if (parent !== directory) await ensureDirectory(parent)
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CzgtsSourceError('storage')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CzgtsSourceError('storage')
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CzgtsSourceError('storage')
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new CzgtsSourceError('storage')
    }
  }
}

export function createCzgtsCredentialStore(file = credentialsFile) {
  async function read(): Promise<{ cookie: string; updatedAt: string } | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      // Refuse symlinked parents without creating missing directories on a read.
      for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
        const info = await lstat(dir)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new CzgtsSourceError('storage')
        if (dir === path.dirname(dir)) break
      }
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || info.size > 40_000 || (info.mode & 0o077)) throw new CzgtsSourceError('storage')
      const parsed = z.object({ cookie: z.string(), updatedAt: z.iso.datetime() }).parse(JSON.parse(await handle.readFile('utf8')))
      return { cookie: normalizeCzgtsCookie(parsed.cookie), updatedAt: parsed.updatedAt }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new CzgtsSourceError('storage')
    } finally { await handle?.close() }
  }
  async function status() {
    const value = await read()
    return { configured: Boolean(value), updatedAt: value?.updatedAt ?? null }
  }
  async function save(value: unknown) {
    const cookie = normalizeCzgtsCookie(value)
    const temporary = `${file}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let created = false
    try {
      await ensureDirectory(path.dirname(path.resolve(file)))
      await chmod(path.dirname(file), 0o700)
      try {
        const info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink()) throw new CzgtsSourceError('storage')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const updatedAt = new Date().toISOString()
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      await handle.writeFile(JSON.stringify({ cookie, updatedAt }))
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temporary, file)
      return { configured: true, updatedAt }
    } catch { throw new CzgtsSourceError('storage') }
    finally { await handle?.close(); if (created) await unlink(temporary).catch(() => {}) }
  }
  return { status, save, read }
}

export const czgtsCredentials = createCzgtsCredentialStore()

export function shanghaiDateTime(date: Date): string {
  return new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
}

export const czgtsTimeRangeSchema = z.object({
  startTime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
}).strict().refine(value => {
  const start = new Date(`${value.startTime.replace(' ', 'T')}+08:00`)
  const end = new Date(`${value.endTime.replace(' ', 'T')}+08:00`)
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start < end
    && shanghaiDateTime(start) === value.startTime && shanghaiDateTime(end) === value.endTime
}, '请设置有效的北京时间范围，结束时间必须晚于开始时间')

export interface CzgtsCollectedArticle {
  articleId: string
  sourceUrl: string
  title: string
  authorName: string
  text: string
  fetchedAt: string
  metadata: {
    gid: string; platform: string; category: string; publishTime: string; keywords: string[]
    reads?: number; likes?: number; comments?: number; fans?: number
  }
}

const rowSchema = z.object({
  gid: z.string().regex(/^\d{1,30}$/), url: z.string().max(4096), title: z.string().trim().min(1).max(2000),
  authorName: z.string().max(500).default(''), platform: z.literal('百家号'), category: z.literal('历史'),
  publishTime: z.string().max(100), keywords: z.array(z.string().max(200)).max(100).default([]),
  readCnt: z.unknown().optional(), diggCnt: z.unknown().optional(), commentCnt: z.unknown().optional(), fans: z.unknown().optional(),
})
const envelopeSchema = z.object({
  code: z.literal(0), total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  list: z.array(z.unknown()).max(50), searchId: z.string().min(1).max(200),
})
const count = (value: unknown): number | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (!/^\d+$/.test(String(value))) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

export async function searchCzgtsArticles(input: {
  startTime: string; endTime: string; offset?: number; searchId?: string
}, options: { cookie?: string; fetchFn?: typeof fetch; signal?: AbortSignal } = {}) {
  const range = czgtsTimeRangeSchema.parse({ startTime: input.startTime, endTime: input.endTime })
  const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.offset ?? 0)
  const searchId = z.string().max(200).parse(input.searchId ?? '')
  options.signal?.throwIfAborted()
  const storedCookie = options.cookie ?? (await czgtsCredentials.read())?.cookie
  if (!storedCookie) throw new CzgtsSourceError('login_required')
  const cookie = normalizeCzgtsCookie(storedCookie)
  try {
    const response = await (options.fetchFn ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json, text/plain, */*', 'content-type': 'application/json', cookie,
        origin: 'https://www.czgts.cn', referer: 'https://www.czgts.cn/v1/hots/article',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ ...range, limit: 50, offset, searchId, postType: 1, platforms: ['百家号'], categories: ['历史'],
        articleGenres: ['文章'], sortBy: 2, fansLimits: '', readLimits: '', videoDurationLimits: '' }),
    })
    if ([401, 403].includes(response.status)) throw new CzgtsSourceError('login_required')
    if (!response.ok) throw new CzgtsSourceError('upstream')
    if (!response.body) throw new CzgtsSourceError('invalid_response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 2 * 1024 * 1024) throw new CzgtsSourceError('invalid_response')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let data: unknown
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new CzgtsSourceError('invalid_response') }
    if (data && typeof data === 'object' && 'code' in data && data.code !== 0) {
      // Use remote wording only to classify; never echo arbitrary response contents or credentials.
      const message = 'message' in data && typeof data.message === 'string' ? data.message : ''
      throw new CzgtsSourceError(/登录|login|unauthor|session|token|认证/i.test(message) ? 'login_required' : 'upstream')
    }
    const parsed = envelopeSchema.safeParse(data)
    if (!parsed.success) throw new CzgtsSourceError('invalid_response')
    return parsed.data
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof CzgtsSourceError) throw error
    throw new CzgtsSourceError('network')
  }
}

export async function checkCzgtsConnection(signal?: AbortSignal) {
  const end = new Date()
  const data = await searchCzgtsArticles({ startTime: shanghaiDateTime(new Date(end.getTime() - 86_400_000)), endTime: shanghaiDateTime(end) }, { signal })
  return { configured: true, total: data.total, message: `连接成功，最近 24 小时找到 ${data.total} 篇历史文章` }
}

export interface CollectCzgtsOptions {
  startTime: string; endTime: string; signal: AbortSignal; targetCount: number | null
  isKnownArticle: (id: string) => boolean
  // false means the caller retained the source but did not finish its requested processing.
  // void remains successful for existing callers that only store original articles.
  onArticle: (article: CzgtsCollectedArticle) => Promise<void | boolean>
  report: (event: { stage: string; message: string; scanned?: number }) => void
}

export async function collectCzgtsArticles(options: CollectCzgtsOptions, dependencies: {
  search?: typeof searchCzgtsArticles; fetchArticle?: typeof fetchBaijiahaoArticle; pauseMs?: number
} = {}): Promise<void> {
  const range = czgtsTimeRangeSchema.parse({ startTime: options.startTime, endTime: options.endTime })
  z.number().int().min(1).max(9999).nullable().parse(options.targetCount)
  const search = dependencies.search ?? searchCzgtsArticles
  const fetchArticle = dependencies.fetchArticle ?? fetchBaijiahaoArticle
  const seen = new Set<string>()
  const pages = new Set<string>()
  let offset = 0, searchId = '', scanned = 0, completed = 0
  for (let page = 0; page < 1000; page++) {
    options.signal.throwIfAborted()
    options.report({ stage: 'searching_articles', message: `正在读取第 ${page + 1} 页百家号历史文章`, scanned })
    const result = await search({ ...range, offset, searchId }, { signal: options.signal })
    if (result.list.length === 0) {
      if (offset < result.total) throw new CzgtsSourceError('pagination')
      options.report({ stage: 'exhausted', message: `此时间范围已采完，共扫描 ${scanned} 篇，完成 ${completed} 篇文章处理`, scanned })
      return
    }
    const fingerprint = JSON.stringify(result.list)
    if (pages.has(fingerprint)) throw new CzgtsSourceError('pagination')
    pages.add(fingerprint)
    searchId = result.searchId
    for (const value of result.list) {
      options.signal.throwIfAborted()
      const parsed = rowSchema.safeParse(value)
      if (!parsed.success) {
        options.report({ stage: 'article_skipped', message: '已跳过字段不完整或非百家号历史文章的记录', scanned: ++scanned })
        continue
      }
      const row = parsed.data
      let identity: ReturnType<typeof normalizeBaijiahaoArticleUrl>
      try { identity = normalizeBaijiahaoArticleUrl(row.url) } catch {
        options.report({ stage: 'article_skipped', message: '已跳过原文链接无效的记录', scanned: ++scanned }); continue
      }
      if (seen.has(identity.articleId)) continue
      seen.add(identity.articleId); scanned++
      if (options.isKnownArticle(identity.articleId)) {
        options.report({ stage: 'article_skipped', message: `已跳过入库过的文章：${row.title}`, scanned }); continue
      }
      options.report({ stage: 'fetching_article', message: `正在读取完整原文：${row.title}`, scanned })
      let original: Awaited<ReturnType<typeof fetchBaijiahaoArticle>>
      try { original = await fetchArticle(identity.url, { signal: options.signal }) }
      catch {
        options.signal.throwIfAborted()
        options.report({ stage: 'article_failed', message: `未取得完整原文，跳过：${row.title}`, scanned })
        continue
      }
      options.signal.throwIfAborted()
      const processed = await options.onArticle({
        articleId: identity.articleId, sourceUrl: identity.url, title: original.title?.trim() || row.title,
        authorName: row.authorName, text: original.text, fetchedAt: new Date().toISOString(),
        metadata: { gid: row.gid, platform: row.platform, category: row.category, publishTime: row.publishTime,
          keywords: row.keywords, reads: count(row.readCnt), likes: count(row.diggCnt), comments: count(row.commentCnt), fans: count(row.fans) },
      })
      options.signal.throwIfAborted()
      if (processed !== false) completed++
      if (options.targetCount !== null && completed >= options.targetCount) return
      await delay(dependencies.pauseMs ?? 300, undefined, { signal: options.signal })
    }
    offset += result.list.length
    if (offset >= result.total) {
      options.report({ stage: 'exhausted', message: `此时间范围已采完，共扫描 ${scanned} 篇，完成 ${completed} 篇文章处理`, scanned })
      return
    }
    await delay(dependencies.pauseMs ?? 300, undefined, { signal: options.signal })
  }
  throw new CzgtsSourceError('pagination')
}
