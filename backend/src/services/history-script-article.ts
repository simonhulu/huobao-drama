import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import sharp from 'sharp'
import { db } from '../db/index.js'
import { getHistorySource, getHistorySourceArtifactState } from './history-script-library.js'
import { renderHistoryArticle, type ArticleScreenshot, type ArticleSection } from './history-script-article-renderer.js'
import { prepareHistoryArticleImages } from './history-article-images.js'
import { getHistoryArticleGeneration, markHistoryArticleQueueGenerating, sameHistoryArticleProvenance, type HistoryArticleGeneration } from './history-script-article-queue.js'
import { getHistoryProductionGate } from './history-production-gate.js'

const exec = promisify(execFile)
const defaultRoot = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))
const rewritePrompt = fs.readFileSync(fileURLToPath(new URL('../../prompts/history-article-rewrite.txt', import.meta.url)), 'utf8')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const LEASE_MS = 12 * 60_000
const characterCount = (text: string) => Array.from(text.replace(/\s/gu, '')).length

export function cleanHistoryArticleTitle(title: string) {
  const cleaned = title.replace(/\s*#[^#\n]*(?:#[^#\n]*)*$/, '')
    .replace(/^\s*第[\d一二三四五六七八九十百零]+[集期章回]\s*[|｜:：、.．—-]?\s*/, '').trim()
  return cleaned || title.trim()
}

// Older clients may still send a length preference. It no longer affects writing.
export const historyArticleInputSchema = z.object({ targetLength: z.number().optional() }).strict()
const highlightsSchema = z.unknown().optional().transform(value => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.length >= 4 && item.length <= 15).slice(0, 3) : [])
// Model output may carry extra presentation metadata. Keep all actual prose;
// unknown keys (e.g. section-level highlights) are not a reason to lose it.
const selectionSchema = z.object({ title: z.unknown().optional(), sections: z.array(z.object({
  heading: z.string().trim().min(1),
  paragraphs: z.array(z.union([z.object({
    text: z.string().trim().min(1),
    highlights: highlightsSchema,
  }), z.object({
    quotes: z.array(z.string().min(1)).min(1),
    highlights: highlightsSchema,
  }), z.object({
    sentenceIds: z.array(z.number().int().nonnegative()).min(1),
    highlights: highlightsSchema,
  })])).min(1),
})).min(1) })

export interface HistoryArticleProvenance {
  correctedSha256: string
  sourceMetadataSha256: string
  rewrittenSha256: string
  videoUrl: string
  videoFingerprint: string
}
export interface HistoryArticle {
  title: string
  markdown: string
  html: string
  sections: ArticleSection[]
  screenshots: ArticleScreenshot[]
  sourceLength: number
  articleLength: number
  targetLength?: number // Legacy saved articles only.
  generatedAt: string
  provenance: HistoryArticleProvenance
  notices: string[]
  selectionMethod: 'model-adapted' | 'model-extractive' | 'manual-source-exact'

}
interface ArticleState {
  version: 1
  status: 'idle' | 'generating' | 'completed' | 'failed'
  error: string | null
  runId: string | null
  leaseUntil: number | null
  article: HistoryArticle | null
  activeProvenance?: HistoryArticleProvenance | null
  diagnostics?: ArticleDiagnostics | null
}
export interface HistoryArticleResult {
  status: ArticleState['status']
  error: string | null
  article: HistoryArticle | null
  stale: boolean
  staleReasons: string[]
  canGenerate: boolean
  unavailableReason: string | null
  diagnostics: ArticleDiagnostics | null
  articleGeneration?: HistoryArticleGeneration | null
  activeProvenance?: HistoryArticleProvenance | null
}
interface ArticleDiagnostics {
  stage: string
  kind: string
  issues: Array<{ path: string; code: string }>
  occurredAt: string
  artifactId?: string
}
export class HistoryArticleError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 | 500 = 400) { super(message) }
}
class ArticleStageError extends HistoryArticleError {
  constructor(message: string, public diagnostics: ArticleDiagnostics, status: 400 | 403 | 404 | 409 | 500 = 409) { super(message, status) }
}
function modelTransportCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const cause = error.cause as { code?: unknown } | undefined
  const code = cause?.code ?? (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}
const MODEL_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'])
const MODEL_RETRY_CODES = new Set([...MODEL_TIMEOUT_CODES, 'ECONNRESET', 'UND_ERR_SOCKET'])
function stageFailure(stage: string, error: unknown): ArticleStageError {
  if (error instanceof ArticleStageError) return error
  if (stage.endsWith('_model') && error instanceof Error && (error.name === 'TimeoutError' || MODEL_TIMEOUT_CODES.has(modelTransportCode(error) || ''))) {
    return new ArticleStageError(`模型响应超时（${stage}），本次文章未生成，请稍后重试或检查文本模型服务。`,
      { stage, kind: 'timeout', issues: [], occurredAt: new Date().toISOString() })
  }
  const issues = error instanceof z.ZodError ? error.issues.slice(0, 8).map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code })) : []
  const message = error instanceof HistoryArticleError ? error.message : issues.length
    ? `文章模型返回结构无效（${stage}：${issues.map(issue => issue.path || '根节点').join('、')}），请重试`
    : error instanceof SyntaxError ? `文章模型返回的 JSON 无效（${stage}），请重试` : `文章生成失败（${stage}），请检查模型配置及成片后重试`
  return new ArticleStageError(message, { stage, kind: error instanceof z.ZodError ? 'schema' : error instanceof SyntaxError ? 'json' : error instanceof HistoryArticleError ? 'validation' : 'operation', issues, occurredAt: new Date().toISOString() })
}
interface ArticleSnapshot {
  text: string; title: string
  videoPath: string; provenance: HistoryArticleProvenance
}
type ModelCaller = typeof import('./ai.js').callTextModel
export interface HistoryArticleOptions {
  root?: string
  caller?: ModelCaller
  extract?: typeof extractHistoryArticleFrames
  prepareImages?: typeof prepareHistoryArticleImages
  diagnosticsRoot?: string
  onlyIfMissing?: boolean
  expectedProvenance?: HistoryArticleProvenance
  /** Internal authorization from an unattempted upload outbox; requires expectedProvenance. */
  allowFailedForNewUpload?: boolean
  /** Internal fixture/import provenance; POST clients cannot set this field. */
  selectionMethod?: HistoryArticle['selectionMethod']
}

function requireSource(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new HistoryArticleError('脚本编号无效')
  const source = getHistorySource(id)
  if (!source) throw new HistoryArticleError('脚本不存在', 404)
  return source
}

function articleDirectory(id: number, root: string, create = false) {
  requireSource(id)
  const base = path.resolve(root)
  const directory = path.join(base, 'history-articles', String(id))
  if (create) fs.mkdirSync(base, { recursive: true })
  if (!fs.existsSync(base)) return directory
  const realBase = fs.realpathSync(base)
  for (const candidate of [path.join(base, 'history-articles'), directory]) {
    if (create && !fs.existsSync(candidate)) fs.mkdirSync(candidate)
    if (fs.existsSync(candidate) && fs.realpathSync(candidate) !== path.join(realBase, path.relative(base, candidate))) {
      throw new HistoryArticleError('文章保存目录无效', 409)
    }
  }
  return directory
}

function snapshot(id: number, root: string): ArticleSnapshot {
  const source = requireSource(id)
  const artifacts = getHistorySourceArtifactState(source)
  if (artifacts.corrected !== 'current') throw new HistoryArticleError('请先完成当前原文的转录与纠错，再生成公众号文章', 409)
  const delivery = db.$client.prepare('SELECT video_path,script_sha256 FROM history_script_deliveries WHERE script_id=?').get(id) as { video_path: string | null; script_sha256: string | null } | undefined
  if (!delivery?.video_path) throw new HistoryArticleError('请先在成片交付中关联已产出的视频，文章配图将从该成片截取', 409)
  if (artifacts.rewritten !== 'current' || !delivery.script_sha256 || delivery.script_sha256 !== hash(source.rewrittenScript || '')) {
    throw new HistoryArticleError('关联成片对应的脚本已变化，请确认当前成片并重新关联', 409)
  }
  if (!new RegExp(`^static/history-deliveries/${id}/[a-f0-9-]+\\.(mp4|mov|m4v|webm)$`, 'i').test(delivery.video_path)) {
    throw new HistoryArticleError('关联成片路径无效，请重新关联成片', 409)
  }
  try {
    const realRoot = fs.realpathSync(root)
    const expected = path.join(realRoot, delivery.video_path.slice('static/'.length))
    const videoPath = fs.realpathSync(path.join(root, delivery.video_path.slice('static/'.length)))
    if (videoPath !== expected) throw new Error('unsafe path')
    const info = fs.statSync(videoPath)
    if (!info.isFile() || info.size <= 0) throw new Error('empty video')
    return {
      text: source.correctedTranscript!, title: cleanHistoryArticleTitle(source.title),
      videoPath,
      provenance: {
        correctedSha256: hash(source.correctedTranscript!),
        sourceMetadataSha256: hash(JSON.stringify([source.title, source.authorName, source.sourceUrl])),
        rewrittenSha256: hash(source.rewrittenScript!), videoUrl: `/${delivery.video_path}`,
        videoFingerprint: hash(JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])),
      },
    }
  } catch { throw new HistoryArticleError('关联的成片文件不存在或不可读取，请重新关联成片', 409) }
}

function readState(directory: string): ArticleState {
  const filename = path.join(directory, 'article.json')
  if (!fs.existsSync(filename)) return { version: 1, status: 'idle', error: null, runId: null, leaseUntil: null, article: null }
  if (fs.lstatSync(filename).isSymbolicLink()) throw new HistoryArticleError('文章存储文件无效', 409)
  const state = JSON.parse(fs.readFileSync(filename, 'utf8')) as ArticleState
  if (state.version !== 1 || !['idle', 'generating', 'completed', 'failed'].includes(state.status)) throw new HistoryArticleError('文章记录无法读取', 500)
  return state
}

function saveState(directory: string, state: ArticleState) {
  const temporary = path.join(directory, `${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, path.join(directory, 'article.json'))
  } finally { fs.rmSync(temporary, { force: true }) }
}

export function getHistoryArticle(id: number, options: Pick<HistoryArticleOptions, 'root'> = {}): HistoryArticleResult {
  requireSource(id)
  const root = options.root || defaultRoot
  const state = readState(articleDirectory(id, root))
  const staleReasons: string[] = []
  let current: ArticleSnapshot | null = null
  let unavailableReason: string | null = null
  try { current = snapshot(id, root) } catch (error) { unavailableReason = (error as Error).message }
  if (state.article) {
    if (!current) staleReasons.push(unavailableReason!)
    else {
      if (current.provenance.correctedSha256 !== state.article.provenance.correctedSha256) staleReasons.push('纠错原文已变化')
      if (current.provenance.sourceMetadataSha256 !== state.article.provenance.sourceMetadataSha256) staleReasons.push('原文标题或来源署名已变化')
      if (current.provenance.rewrittenSha256 !== state.article.provenance.rewrittenSha256) staleReasons.push('成片对应脚本已变化')
      if (current.provenance.videoUrl !== state.article.provenance.videoUrl || current.provenance.videoFingerprint !== state.article.provenance.videoFingerprint) staleReasons.push('关联成片已变化')
    }
  }
  const expired = state.status === 'generating' && (!state.leaseUntil || state.leaseUntil <= Date.now())
  // Re-render stored sections so legacy cached footers disappear without a model call.
  const article = state.article ? {
    ...state.article,
    ...renderHistoryArticle(state.article),
    notices: state.article.notices.filter(notice => notice !== '红白色系排版；来源信息与作者署名单列，不添加互动口号。'
      && notice !== '作者署名尚未配置，请替换文末的作者名与简介占位。'),
  } : null
  return {
    status: expired ? 'failed' : state.status,
    error: expired ? '文章生成任务中断或超时，请重新生成' : state.error,
    article, stale: staleReasons.length > 0, staleReasons,
    canGenerate: current !== null && (state.status !== 'generating' || expired),
    unavailableReason: unavailableReason || (state.status === 'generating' && !expired ? '文章正在生成' : null),
    diagnostics: state.diagnostics || null,
    articleGeneration: getHistoryArticleGeneration(db.$client, id, current?.provenance.videoUrl ?? null),
    activeProvenance: state.status === 'generating' && !expired ? state.activeProvenance ?? null : null,
  }
}

/** Source sentence indexing remains available for legacy excerpt imports. */
export function historyArticleSentences(text: string) {
  const boundaries = [0, ...Array.from(text.matchAll(/[。！？!?；;\n]+[”’」』）)]*/g), match => match.index! + match[0].length), text.length]
  return boundaries.slice(1).map((end, index) => {
    const raw = text.slice(boundaries[index], end)
    const sentence = raw.trim()
    return { text: sentence, start: boundaries[index] + raw.indexOf(sentence) }
  }).filter(sentence => sentence.text).map((sentence, id) => ({ id, ...sentence, length: characterCount(sentence.text) }))
}

// Only remove recognizable presentation boilerplate. Mentions of video as a
// subject (e.g. historical video evidence) and factual clauses must survive.
function cleanArticleProse(text: string): string {
  return (text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g) || []).map(sentence => {
    let prose = sentence.trim()
    prose = prose.replace(/^(?:而)?(?:在)?(?:上|前)(?:一)?期(?:的)?(?:视频|节目)?(?:中|里)?(?:我们|咱们)?(?:已经|曾经|曾)?(?:讲过|说过|提到过|提过|讲到|说到|提到)[，,:：]\s*/, '')
    const presentation = /(^|[，,])(?:而)?(?:我们|咱们)?(?:在)?(?:今天)?(?:这|本)(?:一)?期(?:的)?(?:视频|节目)(?:里|中)?(?:我们|咱们)?(?:就)?(?:主要)?(?:要|来)?(?:讲一讲|聊一聊|讲讲|聊聊|介绍一下|看看)/.exec(prose)
    if (presentation) {
      const before = prose.slice(0, presentation.index)
      const after = prose.slice(presentation.index + presentation[0].length).replace(/^[，,:：]\s*/, '')
      // A topic-only announcement has no narrative to retain. Otherwise remove
      // just the host's prefix, including when a fact follows without a comma.
      const topicOnly = /^(?:这|那)[^，,:：。！？!?的]+的(?:全过程|来龙去脉)[。！？!?]?\s*$/.test(after)
      prose = topicOnly ? (before ? before + (after.match(/[。！？!?]$/)?.[0] || '。') : '') : before + presentation[1] + after
    }
    if (/^(?:(?:好了|好|那么)[，,]?\s*)?(?:今天|这期|本期)(?:的)?(?:视频|节目)?(?:就)?(?:先)?(?:讲|聊|说|介绍|分享到)到这里[。！!]?\s*$/.test(prose)) return ''
    if (/^(?:喜欢(?:这|本)期(?:视频|节目)的(?:朋友|观众)[，,]\s*)?(?:请|记得|欢迎|别忘了|不要忘了)?(?:大家|朋友们)?(?:点赞|点个赞|关注|订阅|收藏|转发)(?:[，、,\s]*(?:点赞|关注|订阅|收藏|转发|支持一下))*[。！!]?\s*$/.test(prose)) return ''
    return prose
  }).filter(Boolean).join('')
}

export function validateHistoryArticleSelection(text: string, result: unknown, _targetLength?: number): ArticleSection[] {
  const parsed = selectionSchema.parse(result)
  const sentences = historyArticleSentences(text)
  let lastSentenceId = -1
  let cursor = 0
  let emittedEnd = 0
  const boundaries = [0, ...Array.from(text.matchAll(/[。！？!?；;\n]+[”’」』）)]*/g), match => match.index! + match[0].length), text.length]
  const sections = parsed.sections.map(section => {
    const paragraphs = section.paragraphs.map(paragraph => {
      if ('text' in paragraph) {
        const prose = cleanArticleProse(paragraph.text)
        return { text: prose, highlights: paragraph.highlights.filter(highlight => prose.includes(highlight)), sourceEvidence: [] }
      }
      const quotes = 'sentenceIds' in paragraph ? paragraph.sentenceIds.map(id => {
        if (id <= lastSentenceId || !sentences[id]) throw new HistoryArticleError('模型选择的原句编号无效、重复或顺序错误，未保存文章', 409)
        lastSentenceId = id
        return sentences[id].text
      }) : paragraph.quotes
      const sourceEvidence = quotes.flatMap((quote, quoteIndex) => {
        const selectedStart = 'sentenceIds' in paragraph ? sentences[paragraph.sentenceIds[quoteIndex]].start : text.indexOf(quote, cursor)
        if (selectedStart < cursor) throw new HistoryArticleError('模型摘录与原文不一致或打乱了论证顺序，未保存文章', 409)
        cursor = selectedStart + quote.length
        // Models sometimes select a source-exact clause. Restore the entire
        // original sentence, including causal premises/negations, never the
        // truncated clause alone. Deduplicate expansions of the same sentence.
        let start = boundaries.reduce((previous, boundary) => boundary <= selectedStart ? boundary : previous, 0)
        let end = boundaries.find(boundary => boundary >= cursor) ?? text.length
        if (end <= emittedEnd) return []
        start = Math.max(start, emittedEnd)
        while (start < end && /\s/u.test(text[start])) start++
        while (end > start && /\s/u.test(text[end - 1])) end--
        emittedEnd = end
        return [{ quote: text.slice(start, end), start, end }]
      })
      const original = sourceEvidence.map(evidence => evidence.quote).join('')
      const prose = cleanArticleProse(original)
      const highlights = paragraph.highlights.filter(highlight => prose.includes(highlight) && text.includes(highlight))
      // Cleaned text is no longer the verbatim span. Never reconstruct it from
      // the old evidence, which would bring presentation boilerplate back.
      return { text: prose, highlights, sourceEvidence: prose === original ? sourceEvidence : [] }
    }).filter(paragraph => paragraph.text.length > 0)
    if (!paragraphs.length) return null
    return { heading: section.heading, paragraphs }
  }).filter((section): section is ArticleSection => section !== null)
  if (!sections.length) throw new HistoryArticleError('模型未返回可用的文章正文，请重试', 409)
  return sections
}

/** Split at sentence boundaries for reading; preserve all prose without a length gate. */
export function splitHistoryArticleParagraphs(sections: ArticleSection[], maximumLength = 220): ArticleSection[] {
  return sections.map(section => ({ ...section, paragraphs: section.paragraphs.flatMap(paragraph => {
    const sourceExact = paragraph.sourceEvidence.length > 0 && paragraph.sourceEvidence.map(evidence => evidence.quote).join('') === paragraph.text
    const evidence = sourceExact ? paragraph.sourceEvidence : [{ quote: paragraph.text, start: 0, end: paragraph.text.length }]
    const pieces = evidence.flatMap(evidence => {
      const matches = [...evidence.quote.matchAll(/[^。！？!?]+(?:[。！？!?]+[”’」』）)]*|$)/g)]
      if (!matches.length || matches.map(match => match[0]).join('') !== evidence.quote) return [evidence]
      return matches.map(match => ({ quote: match[0], start: evidence.start + match.index!, end: evidence.start + match.index! + match[0].length }))
    })
    const groups: typeof pieces[] = []
    let group: typeof pieces = []
    let length = 0
    for (const piece of pieces) {
      if (group.length && length + piece.quote.length > maximumLength) { groups.push(group); group = []; length = 0 }
      group.push(piece)
      length += piece.quote.length
    }
    if (group.length) groups.push(group)
    return groups.map(sourceEvidence => {
      const text = sourceEvidence.map(evidence => evidence.quote).join('')
      // Reuse only original highlights present in the new paragraph. If the model
      // supplied too few for a long block, the source-exact chapter phrase helps.
      const highlights = paragraph.highlights.filter(highlight => text.includes(highlight)).slice(0, 3)
      if (!highlights.length && section.heading.length >= 4 && section.heading.length <= 15 && text.includes(section.heading)) highlights.push(section.heading)
      return { text, highlights, sourceEvidence: sourceExact ? sourceEvidence : [] }
    })
  }) }))
}

/** Preserve the sections-only API used by existing callers. */
export async function rewriteHistoryArticle(text: string, caller?: ModelCaller, signal?: AbortSignal): Promise<ArticleSection[]> {
  return (await rewriteHistoryArticleContent(text, caller, signal)).sections
}

async function awaitArticleModel(call: () => Promise<string>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  // Enforce the deadline locally even if a provider ignores its AbortSignal.
  // The original promise still has rejection handlers; a late response is ignored.
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return call() }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })
}

async function rewriteHistoryArticleContent(text: string, caller?: ModelCaller, signal?: AbortSignal) {
  if (!text.trim()) throw new HistoryArticleError('原文为空，请先检查纠错原文', 409)
  const call = caller || (await import('./ai.js')).callTextModel
  const stage = 'selection'
  const modelSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(6 * 60_000)]) : AbortSignal.timeout(6 * 60_000)
  for (let attempt = 0; ; attempt++) {
    let response: string
    try {
      modelSignal.throwIfAborted()
      response = await awaitArticleModel(() => call([
        { role: 'system', content: rewritePrompt },
        { role: 'user', content: JSON.stringify({ correctedTranscript: text }) },
      ], { temperature: 0.3, responseFormat: { type: 'json_object' }, requireComplete: true, signal: modelSignal }), modelSignal)
      modelSignal.throwIfAborted()
    } catch (error) {
      if (attempt === 0 && !modelSignal.aborted && MODEL_RETRY_CODES.has(modelTransportCode(error) || '')) continue
      throw stageFailure(`${stage}_model`, error)
    }
    try {
      const result = JSON.parse(response)
      const sections = splitHistoryArticleParagraphs(validateHistoryArticleSelection(text, result))
      // A missing or malformed title must never discard a usable body.
      const title = typeof result.title === 'string' ? result.title.replace(/[\s\u0085]+/gu, ' ').trim() || undefined : undefined
      return { title, sections }
    }
    catch (error) {
      throw stageFailure(`${stage}_validation`, error)
    }
  }
}

export async function extractHistoryArticleFrames(videoPath: string, directory: string, baseUrl: string, sections: ArticleSection[], signal?: AbortSignal): Promise<ArticleScreenshot[]> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type:chapter=start_time,end_time', '-of', 'json', videoPath], { timeout: 30_000, maxBuffer: 1024 * 1024, signal })
  const probe = JSON.parse(stdout)
  const duration = Number(probe.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0 || !probe.streams?.some((stream: { codec_type: string }) => stream.codec_type === 'video')) throw new HistoryArticleError('成片没有可截取的视频画面', 409)
  const count = Math.min(5, Math.max(3, sections.length))
  const chapterCenters: number[] = Array.isArray(probe.chapters) ? probe.chapters.map((chapter: { start_time: string; end_time: string }) => (Number(chapter.start_time) + Number(chapter.end_time)) / 2)
    .filter((time: number) => Number.isFinite(time) && time >= duration * 0.05 && time <= duration * 0.95) : []
  const timestamps = chapterCenters.length >= count
    ? Array.from({ length: count }, (_, index) => chapterCenters[Math.floor(index * chapterCenters.length / count)])
    : Array.from({ length: count }, (_, index) => duration * (index + 1) / (count + 1))
  fs.mkdirSync(directory, { recursive: false })
  const screenshots: ArticleScreenshot[] = []
  for (const [index, timestamp] of timestamps.entries()) {
    signal?.throwIfAborted()
    const filename = path.join(directory, `frame-${index + 1}.jpg`)
    // Keep candidates local and within neighbouring sampling points, including short videos.
    const radius = Math.min(1.5, (timestamp - (timestamps[index - 1] ?? 0)) * 0.4,
      ((timestamps[index + 1] ?? duration) - timestamp) * 0.4)
    let best: { jpeg: Buffer; timestamp: number; sharpness: number } | undefined
    for (const offset of [0, -0.5, 0.5, -1, 1]) {
      signal?.throwIfAborted()
      const candidateTime = timestamp + offset * radius
      // No scaling or sharpening: retain native pixels, with high-quality 4:4:4 JPEG.
      // execFile uses an argument array: neither media names nor captions enter a shell.
      const { stdout: jpeg } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(candidateTime), '-i', videoPath,
        '-map', '0:v:0', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '1', '-pix_fmt', 'yuvj444p', '-f', 'image2pipe', 'pipe:1'],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', signal })
      if (!jpeg.length) continue
      const { width, height } = await sharp(jpeg).metadata()
      if (!width || !height) continue
      // Score the scene, excluding typical bottom subtitles and outer borders.
      // This crop is only for analysis; the saved JPEG keeps the entire frame.
      const region = await sharp(jpeg).extract({ left: Math.floor(width * 0.05), top: Math.floor(height * 0.1),
        width: Math.max(1, Math.floor(width * 0.9)), height: Math.max(1, Math.floor(height * 0.65)) })
        .greyscale().raw().toBuffer({ resolveWithObject: true })
      const { sharpness } = await sharp(region.data, { raw: region.info }).stats()
      if (!best || sharpness > best.sharpness) best = { jpeg, timestamp: candidateTime, sharpness }
    }
    signal?.throwIfAborted()
    if (!best) throw new HistoryArticleError('成片截图为空，请检查视频', 409)
    fs.writeFileSync(filename, best.jpeg, { flag: 'wx' })
    screenshots.push({ url: `${baseUrl}/frame-${index + 1}.jpg`, timestamp: best.timestamp, sectionIndex: Math.min(sections.length - 1, Math.floor(index * sections.length / count)) })
  }
  return screenshots
}

function acquireRun(directory: string, runId: string) {
  const filename = path.join(directory, 'generation.lock')
  try {
    const stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink()) throw new HistoryArticleError('文章任务锁无效', 409)
    if (Date.now() - stat.mtimeMs <= LEASE_MS) throw new HistoryArticleError('文章正在生成，请稍候', 409)
    fs.rmSync(filename)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  try { fs.writeFileSync(filename, runId, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HistoryArticleError('文章正在生成，请稍候', 409)
    throw error
  }
  return () => {
    try { if (fs.readFileSync(filename, 'utf8') === runId) fs.rmSync(filename) } catch { /* A stale run never removes a newer lock. */ }
  }
}

export function startHistoryArticle(id: number, input: unknown, options: HistoryArticleOptions = {}): HistoryArticleResult {
  historyArticleInputSchema.parse(input)
  const root = options.root || defaultRoot
  const original = snapshot(id, root)
  if (options.expectedProvenance && !sameHistoryArticleProvenance(original.provenance, options.expectedProvenance)) {
    throw new HistoryArticleError('上传时的原文、脚本或成片已变化，请核对后重新提交', 409)
  }
  const allowFailed = options.allowFailedForNewUpload === true && options.expectedProvenance !== undefined
  const directory = articleDirectory(id, root, true)
  const runId = randomUUID()
  if (options.onlyIfMissing) {
    const state = getHistoryArticle(id, { root })
    if (state.status === 'generating' || (state.status === 'failed' && !allowFailed)) return state
  }
  let release: () => void
  try { release = acquireRun(directory, runId) }
  catch (error) {
    if (options.onlyIfMissing && error instanceof HistoryArticleError && error.status === 409) {
      const state = getHistoryArticle(id, { root })
      if (state.status === 'generating') return state
    }
    throw error
  }
  let previous: ArticleState
  try {
    previous = readState(directory)
    if (options.onlyIfMissing) {
      const state = getHistoryArticle(id, { root })
      if (state.status === 'generating' || (state.status === 'failed' && !allowFailed) || (state.status === 'completed' && !state.stale)) {
        release()
        return state
      }
    }
    if (!sameHistoryArticleProvenance(snapshot(id, root).provenance, original.provenance)) {
      throw new HistoryArticleError('原文或成片已变化，请重新生成', 409)
    }
    saveState(directory, { version: 1, status: 'generating', error: null, runId, leaseUntil: Date.now() + LEASE_MS, article: previous.article, activeProvenance: original.provenance })
    markHistoryArticleQueueGenerating(db.$client, id, original.provenance)
  } catch (error) { release(); throw error }
  const isCurrentRun = () => readState(directory).runId === runId
  const controller = new AbortController()
  const renewLease = () => {
    const state = readState(directory)
    const lock = path.join(directory, 'generation.lock')
    if (state.runId !== runId || state.status !== 'generating' || fs.readFileSync(lock, 'utf8') !== runId) {
      throw new HistoryArticleError('文章生成任务已变化，已停止原任务', 409)
    }
    const now = new Date()
    fs.utimesSync(lock, now, now)
    saveState(directory, { ...state, leaseUntil: now.getTime() + LEASE_MS })
  }
  const heartbeat = setInterval(() => {
    try { renewLease() } catch (error) { controller.abort(error) }
  }, 30_000)
  heartbeat.unref()
  const modelResponses: Array<{ stage: string; response: string }> = []
  const diagnosticCaller: ModelCaller = async (messages, settings) => {
    const call = options.caller || (await import('./ai.js')).callTextModel
    const response = await call(messages, settings)
    if (modelResponses.length < 4) modelResponses.push({ stage: 'selection', response: response.slice(0, 128_000) })
    return response
  }
  void (async () => {
    let stage = 'production_wait'
    try {
      await getHistoryProductionGate(db.$client).run(id, `article:${runId}`, async () => {
        renewLease()
        stage = 'provenance'
        if (!sameHistoryArticleProvenance(snapshot(id, root).provenance, original.provenance)) {
          throw new HistoryArticleError('原文或成片已变化，请重新生成', 409)
        }
        // Queueing for a project slot does not spend the actual generation deadline.
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)])
        stage = 'selection'
        const { title: modelTitle, sections } = await rewriteHistoryArticleContent(original.text, diagnosticCaller, signal)
        const title = modelTitle ?? original.title
        stage = 'screenshots'
        const screenshots = await (options.extract || extractHistoryArticleFrames)(original.videoPath, path.join(directory, runId), `/static/history-articles/${id}/${runId}`, sections, signal)
        if (screenshots.length < 3 || screenshots.length > 5) throw new HistoryArticleError('文章需要三至五张成片截图', 409)
        stage = 'screenshot_preparation'
        try { await (options.prepareImages || prepareHistoryArticleImages)(path.join(directory, runId), screenshots, signal) }
        catch (error) {
          throw new HistoryArticleError(`文章配图准备失败：${error instanceof Error ? error.message : '无法准备正文配图'}；原有文章仍保留`, 409)
        }
        signal.throwIfAborted()
        stage = 'render'
        const rendered = renderHistoryArticle({ title, sections, screenshots })
        const article: HistoryArticle = {
          title, ...rendered, sections, screenshots,
          sourceLength: characterCount(original.text), articleLength: characterCount(sections.flatMap(section => section.paragraphs.map(paragraph => paragraph.text)).join('')),
          generatedAt: new Date().toISOString(), provenance: original.provenance,
          selectionMethod: options.selectionMethod || 'model-adapted',
          notices: [
            '基于完整原文重新创作独立文章，不设目标篇幅；内容质量由你判断。',
            '配图来自成片，发布时需在公众号编辑器确认图片已上传。',
          ],
        }
        signal.throwIfAborted()
        stage = 'provenance'
        if (JSON.stringify(snapshot(id, root).provenance) !== JSON.stringify(original.provenance)) throw new HistoryArticleError('生成期间原文或成片已变化，请重新生成；原有文章仍保留', 409)
        if (isCurrentRun()) saveState(directory, { version: 1, status: 'completed', error: null, runId: null, leaseUntil: null, article })
      }, controller.signal)
    } catch (error) {
      const failure = stageFailure(stage, error)
      if (modelResponses.length) {
        try {
          // Never place raw model responses under /static. Only failed runs are
          // captured, at most four bounded responses; provider errors/keys are omitted.
          const diagnosticsDirectory = path.join(options.diagnosticsRoot || path.join(path.dirname(path.resolve(root)), 'history-article-diagnostics'), String(id))
          fs.mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(diagnosticsDirectory, `${runId}.json`), JSON.stringify({ diagnostics: failure.diagnostics, modelResponses }), { flag: 'wx', mode: 0o600 })
          failure.diagnostics.artifactId = runId
        } catch { /* Diagnostics never replace the actionable generation error. */ }
      }
      try {
        if (isCurrentRun()) saveState(directory, { version: 1, status: 'failed', error: failure.message, diagnostics: failure.diagnostics, runId: null, leaseUntil: null, article: previous.article })
      } catch { /* Preserve earlier files if the source was removed or storage became unavailable. */ }
    } finally { clearInterval(heartbeat); release() }
  })()
  return getHistoryArticle(id, { root })
}

export function exportHistoryArticle(id: number, format: 'html' | 'markdown', options: Pick<HistoryArticleOptions, 'root'> = {}) {
  const root = options.root || defaultRoot
  const state = getHistoryArticle(id, { root })
  if (!state.article) throw new HistoryArticleError('请先生成公众号文章', 409)
  if (state.stale) throw new HistoryArticleError('原文或成片已变化，请重新生成公众号文章后导出', 409)
  let body = state.article[format]
  if (format === 'html') {
    const realRoot = fs.realpathSync(root)
    for (const image of state.article.screenshots) {
      if (!new RegExp(`^/static/history-articles/${id}/[a-f0-9-]+/frame-\\d+\\.jpg$`).test(image.url)) throw new HistoryArticleError('文章截图路径无效', 409)
      const filename = path.join(root, image.url.slice('/static/'.length))
      if (fs.realpathSync(filename) !== path.join(realRoot, image.url.slice('/static/'.length))) throw new HistoryArticleError('文章截图路径无效', 409)
      const info = fs.statSync(filename)
      if (!info.isFile() || !info.size || info.size > 10 * 1024 * 1024) throw new HistoryArticleError('文章截图不可读取', 409)
      const encoded = `data:image/jpeg;base64,${fs.readFileSync(filename).toString('base64')}`
      body = body.replaceAll(`src="${image.url}"`, `src="${encoded}"`)
    }
  }
  return body
}
