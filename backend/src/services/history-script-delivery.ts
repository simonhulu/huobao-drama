import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import sharp from 'sharp'
import { db } from '../db/index.js'
import { getHistorySource, getHistorySourceArtifactState, requireCurrentHistoryScript } from './history-script-library.js'
import { coverEditorialPlanSchema, coverThumbnailFields, hasCompleteCoverPlan, historyPublishingCopySchema } from './cover-editorial-plan.js'
import type { CoverPromptEnhanceResult } from './cover-prompt-enhance.js'
import { normalizeVideoTitle, getVideoTitleWarnings } from './video-title-format.js'
import { historyArticleVideoFingerprint } from './history-script-article-queue.js'
import { cleanHistoryOriginalTitle, createHistorySourceCoverPlan } from './history-source-cover-plan.js'
import type { HistoryArticleProvenance } from './history-script-article.js'
import { getHistoryProductionGate } from './history-production-gate.js'
import { currentHistoryVideoDeliveries, listHistoryVideoDeliveries, recordHistoryVideoDelivery, type HistoryVideoProducer } from './history-video-deliveries.js'
import { ensureHistoryVideoPackagingSchema, historyDeliveryStore } from './history-video-packaging.js'

const exec = promisify(execFile)
const staticRoot = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))
const sql = db.$client
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const url = (value: string | null) => value ? `/${value.replace(/^\/+/, '')}` : null
const publishingTitleSchema = z.string().transform(normalizeVideoTitle)
export const deliveryPatchSchema = z.object({
  title: publishingTitleSchema.optional(),
  baijiahaoTitle: publishingTitleSchema.optional(),
  description: z.string().trim().optional(),
  coverDesign: z.object({
    main_title: publishingTitleSchema.default(''),
    sub_title: z.string().trim().max(80).default(''),
    kicker: z.string().trim().max(40).default(''),
    ai_prompt: z.string().trim().max(6000).default(''),
    accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    ...coverThumbnailFields,
  }).strict().optional(),
}).strict()

const storedPlanSchema = coverEditorialPlanSchema.extend({ script_sha256: z.string(), design_sha256: z.string() })
function readDesign(saved: DeliveryRow) {
  const { editorial_plan, ...design } = JSON.parse(saved.cover_design_json)
  const plan = storedPlanSchema.safeParse(editorial_plan)
  return { design, plan: plan.success && hasCompleteCoverPlan(plan.data) ? plan.data : null }
}
function designHash(design: Record<string, unknown>) {
  const keys = ['main_title', 'sub_title', 'kicker', 'ai_prompt', 'accent_color']
  if (design.thumbnail_layout || design.highlight_text) keys.push('thumbnail_layout', 'highlight_text')
  return hash(JSON.stringify(keys.map(key => design[key] || '')))
}
function resultDesign(result: CoverPromptEnhanceResult) {
  return { main_title: result.main_title, sub_title: result.sub_title, kicker: result.kicker,
    ai_prompt: result.image_prompt, accent_color: result.accent_color,
    ...(result.thumbnail_layout ? { thumbnail_layout: result.thumbnail_layout } : {}),
    ...(result.highlight_text ? { highlight_text: result.highlight_text } : {}) }
}

interface DeliveryRow {
  script_id: number; title: string; baijiahao_title: string; description: string; video_path: string | null; video_name: string | null
  duration: number | null; script_sha256: string | null; cover_script_sha256: string | null
  cover_design_json: string; covers_json: string; cover_status: string; cover_run_id: string | null
  design_status: string; design_run_id: string | null; design_lease_until: string | null; design_error: string | null
  cover_lease_until: string | null; error: string | null; updated_at: string
}
export class DeliveryError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 413 = 400) { super(message) }
}
function sharedPublishingDesign(saved: DeliveryRow, patch: z.infer<typeof deliveryPatchSchema>) {
  const { design: storedDesign, plan } = readDesign(saved)
  const title = publishingTitleSchema.parse(patch.baijiahaoTitle ?? patch.title ?? (saved.baijiahao_title || saved.title))
  return { title, design: patch.coverDesign ?? storedDesign, plan }
}
function source(id: number) {
  const result = getHistorySource(id)
  if (!result) throw new DeliveryError('脚本不存在', 404)
  return result
}
function currentScript(id: number) {
  try { return requireCurrentHistoryScript(source(id)) } catch (error) {
    if (error instanceof DeliveryError) throw error
    throw new DeliveryError('请先完成并保存当前脚本，再关联成片或生成封面', 409)
  }
}
function row(id: number, videoId?: number): DeliveryRow {
  source(id)
  const store = historyDeliveryStore(id, videoId)
  if (videoId === undefined) {
    sql.prepare(`INSERT OR IGNORE INTO history_script_deliveries (script_id, updated_at) VALUES (?, ?)`).run(id, new Date().toISOString())
  } else {
    if (!Number.isSafeInteger(videoId) || videoId <= 0) throw new DeliveryError('成片 ID 无效')
    const video = listHistoryVideoDeliveries(sql, id).find(item => item.id === videoId)
    if (!video) throw new DeliveryError('成片不存在或不属于当前稿件', 404)
    if (!currentHistoryVideoDeliveries(sql, id, hash(source(id).rewrittenScript || '')).some(item => item.id === videoId)) {
      throw new DeliveryError('成片不再属于当前稿件版本，请刷新后操作', 409)
    }
    ensureHistoryVideoPackagingSchema(sql)
    sql.prepare(`INSERT OR IGNORE INTO history_video_packaging
      (video_id,script_id,video_path,video_name,duration,script_sha256,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(videoId, id, video.videoUrl, video.videoName, video.duration, video.scriptSha256, new Date().toISOString())
  }
  sql.prepare(`UPDATE ${store.table} SET cover_status='failed', error='封面任务中断，请重新生成', cover_run_id=NULL
    WHERE ${store.column}=? AND cover_status='generating' AND cover_lease_until < ?`).run(store.key, new Date().toISOString())
  sql.prepare(`UPDATE ${store.table} SET design_status='failed', design_error='标题、简介与封面方案任务中断，请重新生成',
    design_run_id=NULL, design_lease_until=NULL, updated_at=?
    WHERE ${store.column}=? AND design_status='generating' AND (design_lease_until IS NULL OR design_lease_until < ?)`)
    .run(new Date().toISOString(), store.key, new Date().toISOString())
  return sql.prepare(`SELECT * FROM ${store.table} WHERE ${store.column}=?`).get(store.key) as DeliveryRow
}
function presentPackaging(saved: DeliveryRow, scriptSource: ReturnType<typeof source>) {
  const script = scriptSource.rewrittenScript || ''
  const stale = getHistorySourceArtifactState(scriptSource).rewritten !== 'current'
  const { design, plan } = readDesign(saved)
  const coverPlanStatus = !plan ? 'missing' : stale || plan.script_sha256 !== hash(script) || plan.design_sha256 !== designHash(design) ? 'outdated'
    : ['curiosity', 'source-title'].includes(plan.selection_mode || '') ? 'selected' : 'approved'
  return {
    title: saved.title, baijiahaoTitle: saved.baijiahao_title, description: saved.description, videoUrl: url(saved.video_path), videoName: saved.video_name,
    publishingWarnings: getVideoTitleWarnings(saved.baijiahao_title, 40, '百家号标题'),
    duration: saved.duration, coverDesign: design, coverPlan: plan, coverPlanStatus,
    articleGeneration: null as { status: string; message: string } | null,
    covers: Object.fromEntries(Object.entries(JSON.parse(saved.covers_json)).map(([ratio, value]) => [ratio, url(value as string)])),
    designStatus: saved.design_status, designRunId: saved.design_run_id, designError: saved.design_error,
    coverStatus: saved.cover_status, error: saved.error,
    scriptChanged: Boolean(saved.script_sha256 && (stale || saved.script_sha256 !== hash(script))),
    coversChanged: Boolean(saved.cover_script_sha256 && (stale || saved.cover_script_sha256 !== hash(script) || saved.cover_status === 'idle')),
  }
}
export function getHistoryDelivery(id: number, videoId?: number) {
  const scriptSource = source(id)
  const videos = currentHistoryVideoDeliveries(sql, id, hash(scriptSource.rewrittenScript || ''))
  const saved = row(id, videoId)
  return {
    ...presentPackaging(saved, scriptSource), videoId: videoId ?? null,
    producer: videos.find(video => video.id === videoId)?.producer ?? null,
    videos, videoHistory: listHistoryVideoDeliveries(sql, id),
    videoPackagings: videos.map(video => ({ ...presentPackaging(row(id, video.id), scriptSource), videoId: video.id, producer: video.producer })),
  }
}

function otherPublishingPackages(id: number, videoId?: number) {
  if (videoId === undefined) return []
  const videos = currentHistoryVideoDeliveries(sql, id, hash(source(id).rewrittenScript || ''))
  const packages = videos.filter(video => video.id !== videoId).map(video => {
    const saved = row(id, video.id), design = readDesign(saved).design
    return { producer: video.producer, title: saved.baijiahao_title || saved.title,
      mainTitle: String(design.main_title || ''), imagePrompt: String(design.ai_prompt || '') }
  })
  const legacy = row(id)
  const legacyVideo = videos.find(video => url(legacy.video_path) === url(video.videoUrl))
  if (legacyVideo && legacyVideo.id !== videoId && (legacy.baijiahao_title || legacy.title)) {
    const design = readDesign(legacy).design
    packages.push({ producer: legacyVideo.producer, title: legacy.baijiahao_title || legacy.title,
      mainTitle: String(design.main_title || ''), imagePrompt: String(design.ai_prompt || '') })
  }
  return packages.filter(value => value.title || value.mainTitle || value.imagePrompt)
}

export function hasOtherHistoryDesignInProgress(id: number, videoId?: number) {
  if (videoId === undefined) return false
  return currentHistoryVideoDeliveries(sql, id, hash(source(id).rewrittenScript || ''))
    .some(video => video.id !== videoId && row(id, video.id).design_status === 'generating')
}

export function saveHistoryDelivery(id: number, input: unknown, videoId?: number) {
  const patch = deliveryPatchSchema.parse(input)
  const saved = row(id, videoId), store = historyDeliveryStore(id, videoId)
  if (saved.cover_status === 'generating') throw new DeliveryError('封面正在生成，请完成后再修改', 409)
  const { title, design, plan } = sharedPublishingDesign(saved, patch)
  const designJson = JSON.stringify({ ...design, ...(plan ? { editorial_plan: plan } : {}) })
  sql.transaction(() => {
    sql.prepare(`UPDATE ${store.table} SET title=?, baijiahao_title=?, description=?, cover_design_json=?, cover_status=?, updated_at=? WHERE ${store.column}=?`)
      .run(title, patch.baijiahaoTitle ?? patch.title ?? saved.baijiahao_title, patch.description ?? saved.description,
        designJson, designJson === saved.cover_design_json ? saved.cover_status : 'idle', new Date().toISOString(), store.key)
  }).immediate()
  return getHistoryDelivery(id, videoId)
}

export async function probeFinishedVideo(filename: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filename],
    { timeout: 30000, maxBuffer: 1024 * 1024 })
  const result = JSON.parse(stdout)
  const duration = Number(result.format?.duration)
  if (!result.streams?.some((s: { codec_type: string }) => s.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0) {
    throw new DeliveryError('文件不是可播放的视频')
  }
  return duration
}
export interface HistoryVideoAttachmentOptions {
  root?: string
  maxBytes?: number
  probe?: typeof probeFinishedVideo
  expectedScriptSha256?: string
  onlyIfMissing?: boolean
  producer?: HistoryVideoProducer
  producerJobId?: string
  outputSha256?: string
}
function attachmentScriptHash(id: number, expected?: string) {
  const scriptHash = hash(currentScript(id))
  if (expected !== undefined && expected !== scriptHash) throw new DeliveryError('导出时的脚本已修改，不能关联旧版本成片', 409)
  return scriptHash
}
function videoProvenance(id: number, saved: DeliveryRow, scriptHash: string, root: string): HistoryArticleProvenance | null {
  if (!saved.video_path || saved.script_sha256 !== scriptHash) return null
  if (!new RegExp(`^static/history-deliveries/${id}/[a-f0-9-]+\\.(mp4|mov|m4v|webm)$`, 'i').test(saved.video_path)) {
    throw new DeliveryError('关联成片路径无效，请人工核对', 409)
  }
  const filename = path.join(root, saved.video_path.slice('static/'.length))
  if (!fs.existsSync(filename)) return null
  if (fs.realpathSync(filename) !== path.join(fs.realpathSync(root), saved.video_path.slice('static/'.length))) {
    throw new DeliveryError('关联成片路径无效，请人工核对', 409)
  }
  const current = source(id)
  return {
    correctedSha256: hash(current.correctedTranscript!),
    sourceMetadataSha256: hash(JSON.stringify([current.title, current.authorName, current.sourceUrl])),
    rewrittenSha256: scriptHash, videoUrl: `/${saved.video_path}`, videoFingerprint: historyArticleVideoFingerprint(filename),
  }
}
/** Current local media proof shared with the explicit automation/backfill entry point. */
export function getHistoryDeliveryVideoProvenance(id: number, expectedScriptSha256: string, root = staticRoot) {
  const scriptHash = attachmentScriptHash(id, expectedScriptSha256)
  return videoProvenance(id, row(id), scriptHash, root)
}
function reuseHistoryVideo(id: number, options: HistoryVideoAttachmentOptions) {
  if (!options.onlyIfMissing && !(options.producer && options.outputSha256)) return false
  return sql.transaction(() => {
    const scriptHash = attachmentScriptHash(id, options.expectedScriptSha256)
    if (options.producer) {
      const existing = listHistoryVideoDeliveries(sql,id,scriptHash).find(video => video.producer===options.producer
        && (!options.producerJobId || video.producerJobId===options.producerJobId)
        && (!options.outputSha256 || video.sha256===options.outputSha256))
      return Boolean(existing && fs.existsSync(path.join(options.root || staticRoot,existing.videoUrl.replace(/^\/static\//,''))))
    }
    const saved = row(id)
    if (!saved.video_path) return false
    const provenance = videoProvenance(id, saved, scriptHash, options.root || staticRoot)
    if (!provenance) throw new DeliveryError('已有成片关联已过期或文件缺失，请人工核对；自动关联不会覆盖', 409)
    return true
  }).immediate()
}

export async function attachHistoryVideoFile(id: number, filePath: string, name: string,
  options: HistoryVideoAttachmentOptions & { expectedScriptSha256: string }) {
  attachmentScriptHash(id, options.expectedScriptSha256)
  if (reuseHistoryVideo(id, options)) return getHistoryDelivery(id)
  const file = await fs.promises.open(filePath, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || !info.size) throw new DeliveryError('下载的成片文件不存在或为空')
    const stream = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>
    return await attachHistoryVideo(id, stream, name, options)
  } finally { await file.close() }
}

export async function attachHistoryVideo(id: number, body: ReadableStream<Uint8Array> | null, name: string,
  options: HistoryVideoAttachmentOptions = {}) {
  const scriptHash = attachmentScriptHash(id, options.expectedScriptSha256)
  if (reuseHistoryVideo(id, options)) {
    await body?.cancel().catch(() => {})
    return getHistoryDelivery(id)
  }
  const previous = row(id)
  if (!body || !name || !/\.(mp4|mov|m4v|webm)$/i.test(name)) throw new DeliveryError('请选择 MP4、MOV、M4V 或 WebM 视频')
  const root = options.root || staticRoot
  const directory = path.join(root, 'history-deliveries', String(id))
  await fs.promises.mkdir(directory, { recursive: true })
  const basename = `${randomUUID()}${path.extname(name).toLowerCase()}`
  const final = path.join(directory, basename)
  const temporary = `${final}.upload`
  let bytes = 0
  const contentHash = createHash('sha256')
  const limit = options.maxBytes ?? 4 * 1024 ** 3
  let committed = false
  try {
    await pipeline(Readable.fromWeb(body as any), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length
      contentHash.update(chunk)
      callback(bytes > limit ? new DeliveryError('视频不能超过 4 GB', 413) : null, chunk)
    } }), fs.createWriteStream(temporary, { flags: 'wx' }))
    if (!bytes) throw new DeliveryError('视频文件为空')
    const duration = await (options.probe || probeFinishedVideo)(temporary)
    const videoSha256 = contentHash.digest('hex')
    if(options.outputSha256 && options.outputSha256!==videoSha256) throw new DeliveryError('成片指纹与制作任务不一致',409)
    await fs.promises.rename(temporary, final)
    committed = sql.transaction(() => {
      if (hash(currentScript(id)) !== scriptHash) throw new DeliveryError('上传期间脚本已修改，请核对后重新关联', 409)
      if (reuseHistoryVideo(id, options)) return false
      const videoPath = `static/history-deliveries/${id}/${basename}`
      const current = row(id)
      // Each producer owns a separate output; the legacy pointer remains usable
      // without making the two concurrent renderers overwrite each other.
      if(!options.producer || !current.video_path || current.script_sha256!==scriptHash) {
      const changed = sql.prepare(`UPDATE history_script_deliveries SET video_path=?,video_name=?,duration=?,script_sha256=?,updated_at=?
        WHERE script_id=? AND video_path IS ? AND script_sha256 IS ?`)
        .run(videoPath, path.basename(name), duration, scriptHash, new Date().toISOString(), id,
          options.producer ? current.video_path : previous.video_path,options.producer ? current.script_sha256 : previous.script_sha256)
      if (!changed.changes) throw new DeliveryError('上传期间关联成片已变化，请刷新后重新提交', 409)
      }
      recordHistoryVideoDelivery(sql,{scriptId:id,scriptSha256:scriptHash,producer:options.producer || 'manual',
        producerJobId:options.producerJobId || null,videoUrl:`/${videoPath}`,videoName:path.basename(name),duration,sha256:videoSha256})
      return true
    }).immediate()
    if (!committed) await fs.promises.rm(final, { force: true })
    // Previous media is retained so replacing a file does not destroy earlier work.
    return getHistoryDelivery(id)
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    if (!committed) await fs.promises.rm(final, { force: true })
    throw error
  }
}

export type CoverDesignGenerator = typeof import('./cover-prompt-enhance.js').enhanceCoverPrompt
export interface HistoryCoverDesignLifecycle {
  admitted?(runId: string): void
  beforeDispatch?(runId: string): void
  completed?(runId: string): void
  failed?(runId: string, error: unknown): void
}

function designInput(id: number, videoId?: number) {
  const script = currentScript(id)
  const saved = row(id, videoId)
  if (saved.cover_status === 'generating') throw new DeliveryError('封面正在生成', 409)
  if (saved.design_status === 'generating') throw new DeliveryError('标题、简介与封面方案正在生成，请勿重复提交', 409)
  return { script, saved, sourceTitle: source(id).title }
}

export async function suggestHistoryCover(id: number, generate?: CoverDesignGenerator, videoId?: number) {
  return generateCoverDesign(id, designInput(id, videoId), generate, undefined, undefined, videoId)
}

async function generateCoverDesign(id: number, input: ReturnType<typeof designInput>, generate?: CoverDesignGenerator, runId?: string,
  beforeDispatch?: () => void, videoId?: number) {
  return getHistoryProductionGate(sql).run(id, `design:${runId || randomUUID()}`, async () => {
    const { script, saved, sourceTitle } = input
    const generator = generate || (await import('./cover-prompt-enhance.js')).enhanceCoverPrompt
    // Waiting for a project slot must not dispatch stale work or mark it as sent.
    requireCurrentCoverPlanInput(id, script, saved, runId, videoId)
    if (source(id).title !== sourceTitle) throw new DeliveryError('原素材标题已修改，请重新生成方案', 409)
    beforeDispatch?.()
    const result = await generator({
      roughPrompt: '仅清理原标题中的集数和无关信息，封面沿用同一标题并使用真实视频素材截图。',
      episodeContent: script, episodeTitle: sourceTitle,
      sourceTitle, publishingCopy: true,
      ...(videoId === undefined ? {} : { publishingVariant: { videoId,
        producer: listHistoryVideoDeliveries(sql, id).find(video => video.id === videoId)!.producer,
        otherPackages: otherPublishingPackages(id, videoId) } }),
    })
    const copy = (result.editorial_plan?.selection_mode === 'source-title' ? historyPublishingCopySchema.extend({video_description:z.string().trim()}) : historyPublishingCopySchema).safeParse(result)
    if (!copy.success) throw new DeliveryError('缺少完整的百家号标题与封面方案，未覆盖原方案')
    const selected = result.editorial_plan?.candidates.find(candidate => candidate.id === result.editorial_plan?.selected_id)
    if (selected?.video_title !== copy.data.video_title || selected?.baijiahao_title !== copy.data.baijiahao_title || selected?.video_description !== copy.data.video_description) {
      throw new DeliveryError('发布文案与选中的方案不一致，未覆盖原方案')
    }
    return saveCoverPlan(id, script, saved, result, { title: copy.data.video_title, baijiahaoTitle: copy.data.baijiahao_title,
      description: copy.data.video_description }, runId, videoId)
  })
}

export function startHistoryCoverDesign(id: number, generate?: CoverDesignGenerator, lifecycle: HistoryCoverDesignLifecycle = {}, videoId?: number) {
  const input = designInput(id, videoId), store = historyDeliveryStore(id, videoId)
  const token = randomUUID()
  sql.transaction(() => {
    if (hasOtherHistoryDesignInProgress(id, videoId)) throw new DeliveryError('另一版标题方案正在生成，请稍后继续', 409)
    const claimed = sql.prepare(`UPDATE ${store.table} SET design_status='generating', design_run_id=?,
      design_lease_until=?, design_error=NULL, updated_at=?
      WHERE ${store.column}=? AND design_status<>'generating' AND cover_status<>'generating'`)
      .run(token, new Date(Date.now()+120000).toISOString(), new Date().toISOString(), store.key)
    if (!claimed.changes) throw new DeliveryError('标题、简介或封面正在生成，请勿重复提交', 409)
    lifecycle.admitted?.(token)
  }).immediate()
  const heartbeat = setInterval(() => {
    try { sql.prepare(`UPDATE ${store.table} SET design_lease_until=?
      WHERE ${store.column}=? AND design_run_id=? AND design_status='generating' AND design_lease_until>=?`)
      .run(new Date(Date.now()+120000).toISOString(), store.key, token, new Date().toISOString()) }
    catch { /* expiry exposes interrupted jobs if the heartbeat cannot be persisted */ }
  }, 30000)
  heartbeat.unref()
  void Promise.resolve().then(() => generateCoverDesign(id, input, generate, token, () => lifecycle.beforeDispatch?.(token), videoId))
    .then(() => lifecycle.completed?.(token)).catch(error => {
    try { const failed = sql.prepare(`UPDATE ${store.table} SET design_status='failed', design_error=?,
      design_run_id=NULL, design_lease_until=NULL, updated_at=? WHERE ${store.column}=? AND design_run_id=? AND design_status='generating'`)
      .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), store.key, token)
      if (failed.changes) lifecycle.failed?.(token, error)
    }
    catch (persistError) { console.error('Failed to persist history design error', persistError) }
  }).finally(() => clearInterval(heartbeat))
  return getHistoryDelivery(id, videoId)
}

function requireCurrentCoverPlanInput(id: number, script: string, previous: DeliveryRow, runId?: string, videoId?: number) {
  if (hash(currentScript(id)) !== hash(script)) throw new DeliveryError('脚本已修改，请重新生成方案', 409)
  const saved = row(id, videoId)
  if (runId ? saved.design_run_id !== runId || saved.design_status !== 'generating' : saved.design_status === 'generating') {
    throw new DeliveryError('方案任务已失效或正在生成，请重新提交', 409)
  }
  if (saved.cover_status === 'generating' || saved.cover_design_json !== previous.cover_design_json || saved.title !== previous.title ||
    saved.baijiahao_title !== previous.baijiahao_title || saved.description !== previous.description) throw new DeliveryError('方案或发布文案已修改，或封面正在生成，请重新提交', 409)
  return saved
}

function saveCoverPlan(id: number, script: string, previous: DeliveryRow, result: CoverPromptEnhanceResult,
  metadata: Pick<z.infer<typeof deliveryPatchSchema>, 'title' | 'baijiahaoTitle' | 'description'> = {}, runId?: string, videoId?: number) {
  const saved = requireCurrentCoverPlanInput(id, script, previous, runId, videoId), store = historyDeliveryStore(id, videoId)
  const checked = coverEditorialPlanSchema.safeParse(result.editorial_plan)
  if (!checked.success || !hasCompleteCoverPlan(checked.data)) throw new DeliveryError('缺少完整的封面策划记录，未覆盖原方案')
  const plan = checked.data
  const selected = plan.candidates.find(candidate => candidate.id === plan.selected_id)!
  const design = resultDesign(result)
  if (designHash(design) !== designHash(resultDesign(selected)) || plan.candidates.some(candidate => candidate.evidence.some(quote => !script.includes(quote)))) {
    throw new DeliveryError('封面方案与选中结果或原文证据不一致，未覆盖原方案')
  }
  const stored = { ...design, editorial_plan: { ...plan, script_sha256: hash(script), design_sha256: designHash(design) } }
  const updated = sql.transaction(() => {
    return sql.prepare(`UPDATE ${store.table} SET cover_design_json=?, title=?, baijiahao_title=?, description=?, cover_status='idle',
    ${runId ? "design_status='completed', design_run_id=NULL, design_lease_until=NULL, design_error=NULL," : ''} updated_at=?
    WHERE ${store.column}=? AND cover_status<>'generating' AND cover_design_json=? AND title=? AND baijiahao_title=? AND description=?
      AND ${runId ? "design_status='generating' AND design_run_id=?" : "design_status<>'generating'"}`)
    .run(JSON.stringify(stored), metadata.baijiahaoTitle ?? metadata.title ?? (saved.baijiahao_title || saved.title), metadata.baijiahaoTitle ?? metadata.title ?? saved.baijiahao_title,
      metadata.description ?? saved.description, new Date().toISOString(), store.key,
      previous.cover_design_json, previous.title, previous.baijiahao_title, previous.description, ...(runId ? [runId] : []))
  }).immediate()
  if (!updated.changes) throw new DeliveryError('方案或发布文案已修改，或任务已失效，请重新提交', 409)
  return getHistoryDelivery(id, videoId)
}

export async function reviewHistoryCover(id: number, input: unknown, review?: typeof import('./cover-prompt-enhance.js').reviewCoverPrompt, videoId?: number) {
  const { reviewCoverPrompt } = await import('./cover-prompt-enhance.js')
  const patch = deliveryPatchSchema.parse(input)
  const script = currentScript(id)
  const saved = row(id, videoId)
  if (saved.cover_status === 'generating') throw new DeliveryError('封面正在生成', 409)
  if (saved.design_status === 'generating') throw new DeliveryError('标题、简介与封面方案正在生成，请完成后再审核', 409)
  const { title, design } = sharedPublishingDesign(saved, patch)
  if (!design.main_title?.trim() || !design.ai_prompt?.trim()) throw new DeliveryError('请填写封面标题和画面提示词')
  const result = await (review || reviewCoverPrompt)({ roughPrompt: '审核当前封面方案，保持用户文字和画面提示词，补齐依据后独立审核。',
    episodeContent: script, episodeTitle: title || source(id).title, editorialReview: true },
  { main_title: design.main_title, sub_title: design.sub_title || '', kicker: design.kicker || '',
    image_prompt: design.ai_prompt, accent_color: design.accent_color || '#D7A649', enhanced_prompt: '', rationale: '',
    ...(design.thumbnail_layout ? { thumbnail_layout: design.thumbnail_layout } : {}),
    ...(design.highlight_text ? { highlight_text: design.highlight_text } : {}) })
  const expectedDesign = { ...design, accent_color: design.accent_color || '#D7A649' }
  if (designHash(resultDesign(result)) !== designHash(expectedDesign)) throw new DeliveryError('审核不得擅自修改当前方案，未覆盖原方案')
  return saveCoverPlan(id, script, saved, result, { ...patch, title }, undefined, videoId)
}

const coverFormats = [
  { key: '4x3', width: 1200, height: 900, base: '4:3' },
  { key: '3x4', width: 900, height: 1200, base: '3:4' },
  { key: '16x9', width: 1280, height: 720, base: '4:3' },
] as const

function requireCurrentCoverRun(id: number, scriptHash: string, design: any, runId: string, videoId?: number) {
  if (hash(currentScript(id)) !== scriptHash) throw new DeliveryError('生成期间脚本已修改，请重新生成封面', 409)
  const saved = row(id, videoId)
  if (saved.cover_status !== 'generating' || saved.cover_run_id !== runId) throw new DeliveryError('封面任务已失效，请重新提交', 409)
  if (designHash(readDesign(saved).design) !== designHash(design)) throw new DeliveryError('封面方案已修改，请重新生成封面', 409)
}

function requireCoverRatios(covers: Record<string, string>) {
  if (!covers || coverFormats.some(format => typeof covers[format.key.replace('x', ':')] !== 'string'
    || !covers[format.key.replace('x', ':')]!.trim())) throw new DeliveryError('缺少封面文件，必须包含 16:9、4:3、3:4 三种尺寸', 409)
}

async function readableCoverImage(filename: string, dimensions?: { width: number; height: number }) {
  try {
    if (!(await fs.promises.stat(filename)).isFile()) return false
    const metadata = await sharp(filename).metadata()
    return !!metadata.width && !!metadata.height
      && (!dimensions || metadata.width === dimensions.width && metadata.height === dimensions.height)
  } catch { return false }
}

export async function generateHistoryCoverFiles(id: number, design: any, runId: string, videoId?: number) {
  const scriptHash = hash(currentScript(id))
  const current = () => requireCurrentCoverRun(id, scriptHash, design, runId, videoId)
  current()
  const saved = row(id, videoId)
  const media = JSON.parse(source(id).mediaJson || '{}')
  const attached = saved.video_path && path.join(staticRoot, saved.video_path.replace(/^\/?static\//, ''))
  const failures: string[] = []
  const { selectVideoCoverFrame } = await import('./video-frame-cover.js')
  const { composeCoverVariants } = await import('./cover-image-composer.js')
  for (const videoPath of new Set([media.videoPath, attached])) {
    if (typeof videoPath !== 'string' || !fs.existsSync(videoPath)) continue
    const fingerprint = historyArticleVideoFingerprint(videoPath)
    const version = `${videoId === undefined ? '' : `video-${videoId}/`}covers-${hash(JSON.stringify(['screenshot-v1', scriptHash, designHash(design), fingerprint]))}`
    const outputDir = path.join(staticRoot, 'history-deliveries', String(id), version)
    const needed: Array<typeof coverFormats[number]> = []
    for (const format of coverFormats) {
      if (!await readableCoverImage(path.join(outputDir, `${format.key}.png`), format)) needed.push(format)
    }
    current()
    if (needed.length) {
      let frame: string
      // Original downloads may be audio-only, low-resolution or blank. Only a
      // clear frame qualifies; otherwise try this same delivery's finished video.
      try { frame = await selectVideoCoverFrame(videoPath, outputDir) } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
        continue
      }
      current()
      if (historyArticleVideoFingerprint(videoPath) !== fingerprint) throw new DeliveryError('截图期间素材已修改，请重新生成封面', 409)
      await composeCoverVariants({ design: { ...design, headline_lines: Array.from(design.main_title).length > 24 ? 3 : 2 },
        outputDir, variants: needed.map(format => ({ ...format, baseImagePath: frame })) })
    }
    current()
    for (const format of coverFormats) {
      if (!await readableCoverImage(path.join(outputDir, `${format.key}.png`), format)) throw new DeliveryError(`缺少有效的 ${format.key.replace('x', ':')} 封面文件`, 409)
    }
    return Object.fromEntries(coverFormats.map(format => [format.key.replace('x', ':'), `static/history-deliveries/${id}/${version}/${format.key}.png`]))
  }
  throw new DeliveryError(failures.length ? `没有可用的清晰视频画面：${failures.join('；')}`
    : '缺少可用的真实视频素材，请先下载原素材或关联成片后生成截图封面', 409)
}
export function startHistoryCovers(id: number, input: unknown,
  generate = generateHistoryCoverFiles, videoId?: number) {
  const scriptHash = hash(currentScript(id))
  const patch = deliveryPatchSchema.parse(input)
  const saved = row(id, videoId), store = historyDeliveryStore(id, videoId)
  if (saved.cover_status === 'generating') throw new DeliveryError('封面正在生成，请勿重复提交', 409)
  if (saved.design_status === 'generating') throw new DeliveryError('标题、简介与封面方案正在生成，请完成后再生成封面', 409)
  let { title, design: previousDesign, plan } = sharedPublishingDesign(saved, patch)
  const sourceTitle = source(id).title
  const editedTitle = (patch.title !== undefined || patch.baijiahaoTitle !== undefined)
    && title !== normalizeVideoTitle(saved.baijiahao_title || saved.title)
  const refreshOriginal = plan && !editedTitle && (plan.publishing_version !== 'source-screenshot-v3'
    || plan.source_title_cleanup?.source_title !== sourceTitle)
  if (refreshOriginal) {
    const result = createHistorySourceCoverPlan(sourceTitle, currentScript(id))
    title = result.baijiahao_title!
    previousDesign = resultDesign(result)
    plan = { ...result.editorial_plan!, script_sha256: scriptHash, design_sha256: '' }
  }
  title ||= cleanHistoryOriginalTitle(sourceTitle)
  const design = { ...previousDesign, main_title: title, sub_title: '', kicker: '', ai_prompt: '',
    thumbnail_layout: previousDesign.thumbnail_layout || 'text-left', highlight_text: '' }
  if (refreshOriginal && plan) plan = { ...plan, design_sha256: designHash(design) }
  const token = randomUUID()
  const claimed = sql.transaction(() => {
    return sql.prepare(`UPDATE ${store.table} SET cover_status='generating',cover_run_id=?,cover_lease_until=?,error=NULL,
      title=?,baijiahao_title=?,description=?,cover_design_json=?,updated_at=? WHERE ${store.column}=? AND cover_status<>'generating' AND design_status<>'generating'`)
      .run(token, new Date(Date.now()+120000).toISOString(), title, title, patch.description ?? saved.description,
        JSON.stringify({ ...design, ...(plan ? { editorial_plan: plan } : {}) }), new Date().toISOString(), store.key)
  }).immediate()
  if (!claimed.changes) throw new DeliveryError('封面正在生成', 409)
  const heartbeat = setInterval(() => {
    try { sql.prepare(`UPDATE ${store.table} SET cover_lease_until=? WHERE ${store.column}=? AND cover_run_id=?
      AND cover_status='generating' AND cover_lease_until>=?`)
      .run(new Date(Date.now()+120000).toISOString(), store.key, token, new Date().toISOString()) } catch { /* next heartbeat or expiry exposes interrupted jobs */ }
  }, 30000)
  heartbeat.unref()
  void Promise.resolve().then(() => getHistoryProductionGate(sql).run(id, `covers:${token}`, async () => {
    requireCurrentCoverRun(id, scriptHash, design, token, videoId)
    const covers = await generate(id, design, token, videoId)
    requireCurrentCoverRun(id, scriptHash, design, token, videoId)
    requireCoverRatios(covers)
    sql.prepare(`UPDATE ${store.table} SET covers_json=?,cover_script_sha256=?,cover_status='completed',error=NULL,
      cover_run_id=NULL,cover_lease_until=NULL,updated_at=? WHERE ${store.column}=? AND cover_run_id=?`)
      .run(JSON.stringify(covers), scriptHash, new Date().toISOString(), store.key, token)
  })).catch(error => {
    try { sql.prepare(`UPDATE ${store.table} SET cover_status='failed',error=?,cover_run_id=NULL,cover_lease_until=NULL,updated_at=?
      WHERE ${store.column}=? AND cover_run_id=?`).run(error instanceof Error ? error.message : String(error), new Date().toISOString(), store.key, token) }
    catch (persistError) { console.error('Failed to persist history cover error', persistError) }
  }).finally(() => clearInterval(heartbeat))
  return getHistoryDelivery(id, videoId)
}
