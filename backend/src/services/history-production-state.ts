import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHistorySourceArtifactState, type HistoryArtifactSource, type HistoryArtifactState } from './history-script-artifacts.js'

export type HistoryProductionProducer = 'huasheng' | 'motion' | 'manual' | 'legacy'
export type HistoryProductionVersionState = 'pending' | 'producing' | 'exporting' | 'packaging' | 'ready'
  | 'queued' | 'uploading' | 'submitted' | 'published' | 'attention' | 'uncertain' | 'stale'
export type HistoryProductionAction = 'none' | 'continue_production' | 'retry_export' | 'retry_packaging'
  | 'retry_upload' | 'reconcile' | 'publish' | 'review_legacy'
export interface HistoryProductionVersion {
  key: string
  scriptId: number
  scriptSha256: string | null
  producer: HistoryProductionProducer
  producerJobId: string | null
  videoId: number | null
  state: HistoryProductionVersionState
  stage: 'production' | 'export' | 'packaging' | 'publication'
  message: string
  error: string | null
  action: HistoryProductionAction
  jobId: string | null
  exportJobId: number | null
  automatic: boolean
  canPublish: boolean
  videoAvailable: boolean
  materialsReady: boolean
  confirmedAt: string | null
  revisionOfVideoId: number | null
  previousJobId: string | null
}
export interface HistoryProductionSource {
  id: number
  title: string
  rewrittenScript: string | null
  artifactState?: HistoryArtifactState
  deletedAt?: string | null
  provenance?: HistoryArtifactSource
}
export interface HistoryProductionState {
  scriptId: number
  scriptSha256: string | null
  productionMode: 'dual' | 'motion_backfill' | null
  versions: HistoryProductionVersion[]
  complete: boolean
  /** Production can remain complete after a submitted edition's local bytes are released. */
  productionComplete: boolean
}
interface Options { root?: string }
export interface HistoryPublicationRevision { videoId: number; jobId: string; blocked: boolean }
type Row = Record<string, any>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function object(value: unknown): Row {
  if (typeof value !== 'string') return {}
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}

/** Same receipt identity requirements as the upload executor, without starting it. */
export function isHistorySubmissionReceipt(value: unknown): value is Row {
  if (!value || typeof value !== 'object') return false
  const result = value as Row
  if (result.staged !== true || typeof result.targetId !== 'string' || !result.targetId.trim()
    || result.submitted !== true || result.saved !== false || typeof result.articleId !== 'string'
    || !/^\d+$/.test(result.articleId) || !['submitted', 'published'].includes(result.publicationStatus)
    || result.published !== (result.publicationStatus === 'published')) return false
  try {
    const editor = new URL(result.editorUrl)
    if (editor.protocol !== 'https:' || editor.hostname !== 'baijiahao.baidu.com' || editor.username || editor.password) return false
    const url = new URL(result.publishedUrl)
    return url.protocol === 'https:' && url.hostname === 'baijiahao.baidu.com' && !url.username && !url.password
      && !url.port && !url.hash && ['/s', '/builder/preview/s'].includes(url.pathname)
      && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === result.articleId
  } catch { return false }
}

function inventory(database: Database.Database, ids: number[]) {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row => row.name))
  const read = (table: string, owner: string) => {
    if (!tables.has(table) || !(database.pragma(`table_info(${table})`) as Array<{name:string}>).some(column => column.name === owner)) return []
    const rows: Row[] = []
    // Stay below SQLite builds with the conservative 999 bound-parameter limit.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500)
      rows.push(...database.prepare(`SELECT * FROM ${table} WHERE ${owner} IN (${batch.map(() => '?').join(',')})`).all(...batch) as Row[])
    }
    return rows.sort((a, b) => typeof a.id === 'number' && typeof b.id === 'number' ? b.id - a.id
      : String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  }
  return {
    productions: read('history_dual_production', 'source_id'),
    videos: read('history_video_deliveries', 'script_id'),
    huasheng: read('history_huasheng_jobs', 'source_id'),
    exports: read('history_huasheng_export_jobs', 'source_id'),
    motion: read('history_motion_productions', 'script_id'),
    packaging: read('history_video_packaging', 'script_id'),
    publications: read('history_social_upload_jobs', 'source_id'),
    intents: read('history_video_publication_intents', 'source_id'),
    designs: read('history_video_design_intents', 'script_id'),
    legacy: read('history_script_deliveries', 'script_id'),
  }
}

function files(root: string) {
  const cache = new Map<string, boolean>()
  let realRoot: string | undefined
  try { realRoot = fs.realpathSync(root) } catch { /* Missing storage is an unavailable artifact. */ }
  const resolve = (url: unknown, id: number) => {
    if (typeof url !== 'string' || !/^\/?static\//.test(url) || /[\\%?#\0]/.test(url)) return null
    const relative = url.replace(/^\/?static\//, '')
    if (!relative.startsWith(`history-deliveries/${id}/`) || relative.split('/').some(part => !part || part === '.' || part === '..')) return null
    return path.resolve(root, relative)
  }
  return {
    resolve,
    available(url: unknown, id: number) {
      const filename = resolve(url, id)
      if (!filename || !realRoot) return false
      if (cache.has(filename)) return cache.get(filename)!
      let available = false
      try {
        const real = fs.realpathSync(filename)
        const relative = path.relative(root, filename)
        const stat = fs.statSync(real)
        fs.accessSync(real, fs.constants.R_OK)
        available = real === path.join(realRoot, relative) && stat.isFile() && stat.size > 0
      } catch { /* Inaccessible artifacts cannot establish readiness. */ }
      cache.set(filename, available)
      return available
    },
  }
}

function publicationRevision(rows: { videos: Row[]; publications: Row[] }, video: Row, resolve: ReturnType<typeof files>['resolve']): HistoryPublicationRevision | null {
  const previous = rows.videos.filter(item => item.script_id === video.script_id && item.script_sha256 === video.script_sha256
    && item.producer === video.producer && item.id !== video.id)
  let submitted: HistoryPublicationRevision | null = null
  for (const job of rows.publications) {
    if (job.source_id !== video.script_id || job.target !== 'baijiahao-video' || job.publication_mode !== 'publish') continue
    const original = previous.find(item => job.video_id === item.id || (job.video_id == null
      && typeof object(job.payload_json).videoPath === 'string'
      && path.resolve(object(job.payload_json).videoPath) === resolve(item.video_path, video.script_id)))
    if (!original) continue
    if (job.status === 'completed' && isHistorySubmissionReceipt(object(job.result_json))) {
      submitted ??= { videoId: original.id, jobId: String(job.id), blocked: false }
    } else if (['queued', 'running', 'awaiting_confirmation', 'uncertain', 'completed'].includes(job.status)
      || job.upload_dispatched || job.result_json || job.operation === 'recover') {
      return { videoId: original.id, jobId: String(job.id), blocked: true }
    }
  }
  return submitted
}

export function getHistoryPublicationRevision(database: Database.Database, sourceId: number, videoId: number, options: Options = {}) {
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name))
  if (!tables.has('history_video_deliveries') || !tables.has('history_social_upload_jobs')) return null
  const video = database.prepare('SELECT * FROM history_video_deliveries WHERE id=? AND script_id=?').get(videoId, sourceId) as Row | undefined
  if (!video) return null
  const rows = {
    videos: database.prepare('SELECT * FROM history_video_deliveries WHERE script_id=? AND script_sha256=? AND producer=?')
      .all(sourceId, video.script_sha256, video.producer) as Row[],
    publications: database.prepare('SELECT * FROM history_social_upload_jobs WHERE source_id=? ORDER BY id DESC').all(sourceId) as Row[],
  }
  const root = path.resolve(options.root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url)))
  return publicationRevision(rows, video, files(root).resolve)
}

export function historyProductionAssetAvailable(scriptId: number, url: unknown, root?: string) {
  return files(path.resolve(root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))))
    .available(url, scriptId)
}

export function getHistoryProductionStates(database: Database.Database, sources: HistoryProductionSource[], options: Options = {}): HistoryProductionState[] {
  if (!sources.length) return []
  const rows = inventory(database, [...new Set(sources.map(source => source.id))])
  const root = path.resolve(options.root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url)))
  const assets = files(root)
  return sources.map(source => {
    const scriptSha256 = source.rewrittenScript?.trim() ? hash(source.rewrittenScript) : null
    const current = !source.deletedAt && !!scriptSha256 && (source.artifactState
      || (source.provenance ? getHistorySourceArtifactState(source.provenance).rewritten : 'current')) === 'current'
    const production = rows.productions.find(row => row.source_id === source.id && row.script_sha256 === scriptSha256)
    const productionMode = production ? production.production_mode === 'motion_backfill' ? 'motion_backfill' : 'dual' : null
    const videos = rows.videos.filter(row => row.script_id === source.id && row.script_sha256 === scriptSha256)
      .filter((video, index, all) => all.findIndex(other => other.producer === video.producer) === index)
    const legacy = rows.legacy.find(row => row.script_id === source.id)
    const huasheng = rows.huasheng.find(row => row.source_id === source.id && row.script_sha256 === scriptSha256 && row.status !== 'canceled')
    const motion = rows.motion.filter(row => row.script_id === source.id).map((row): Row => ({...row, data: object(row.snapshot)}))
      .find(row => row.data.factory?.scriptHash === scriptSha256 || row.data.script === source.rewrittenScript)
    const producers: HistoryProductionProducer[] = productionMode === 'dual' ? ['huasheng', 'motion']
      : productionMode === 'motion_backfill' ? ['motion']
        : [...new Set<HistoryProductionProducer>([...videos.map(video => video.producer as HistoryProductionProducer),
          ...(huasheng ? ['huasheng' as const] : []), ...(motion ? ['motion' as const] : [])])]
    if (!producers.length && (legacy?.video_path || rows.videos.some(row => row.script_id === source.id))) producers.push('legacy')
    const versions = producers.map(producer => {
      const video = videos.find(row => row.producer === producer)
      const exported = rows.exports.find(row => row.source_id === source.id && row.script_sha256 === scriptSha256
        && (video?.producer_job_id ? String(row.huasheng_job_id) === video.producer_job_id
          : huasheng ? row.huasheng_job_id == null || row.huasheng_job_id === huasheng.id : true))
      const revision = video ? publicationRevision(rows, video, assets.resolve) : null
      const automatic = !revision && (productionMode === 'dual' || (productionMode === 'motion_backfill' && producer === 'motion'))
      const version: HistoryProductionVersion = {
        key: `${source.id}:${scriptSha256 || 'missing'}:${producer}`, scriptId: source.id, scriptSha256, producer,
        producerJobId: video?.producer_job_id == null ? null : String(video.producer_job_id),
        videoId: video?.id ?? null, state: 'pending', stage: 'production', message: '等待制作', error: null,
        action: 'none', jobId: null, exportJobId: producer === 'huasheng' ? exported?.id ?? null : null,
        automatic, canPublish: false, videoAvailable: !!video && assets.available(video.video_path, source.id),
        materialsReady: false, confirmedAt: null, revisionOfVideoId: revision?.videoId ?? null, previousJobId: revision?.jobId ?? null,
      }
      const set = (state: HistoryProductionVersionState, stage: HistoryProductionVersion['stage'], message: string,
        action: HistoryProductionAction = 'none', error: string | null = null) => Object.assign(version, {state, stage, message, action, error})
      if (producer === 'legacy') return set('stale', 'production', '历史交付尚未登记为当前稿件的独立视频版本，请核对原成片', 'review_legacy')
      const jobs = video ? rows.publications.filter(job => job.source_id === source.id && job.target === 'baijiahao-video'
        && job.publication_mode === 'publish' && (job.video_id === video.id || (job.video_id == null
          && typeof object(job.payload_json).videoPath === 'string'
          && path.resolve(object(job.payload_json).videoPath) === assets.resolve(video.video_path, source.id)))) : []
      const receipt = jobs.find(job => job.status === 'completed' && isHistorySubmissionReceipt(object(job.result_json)))
      if (receipt) {
        version.jobId = String(receipt.id)
        version.confirmedAt = receipt.updated_at || null
        const published = object(receipt.result_json).published === true
        return set(published ? 'published' : 'submitted', 'publication', published ? '已发表到百家号' : '已提交百家号，等待审核')
      }
      if (!current) return set('stale', 'production', '稿件版本已变化或来源检查点不完整，请核对当前稿件', 'continue_production')
      const job = jobs.find(row => row.status !== 'canceled' || row.upload_dispatched || row.result_json || row.operation==='recover')
      if (job) {
        version.jobId = String(job.id)
        if (job.status === 'uncertain' || job.status === 'canceled') return set('uncertain', 'publication', job.message || '发表结果待核对', 'reconcile', job.error || null)
        if (job.status === 'queued') return set('queued', 'publication', job.message || '等待提交百家号')
        if (job.status === 'running') return set('uploading', 'publication', job.message || '正在提交百家号')
        return set('attention', 'publication', job.error || job.message || '原发表任务需要处理',
          job.status === 'completed' ? 'reconcile' : 'retry_upload', job.error || '原任务没有有效的发表提交回执')
      }
      if (revision?.blocked) return set('attention', 'publication', `原成片发表任务 #${revision.jobId} 尚未结束或结果待核对，请先处理原任务；本次修订成片尚未提交`)
      if (!video) {
        if (producer === 'huasheng') {
          if (exported) {
            if (exported.status === 'waiting_login') return set('attention', 'export', exported.error || exported.message || '等待花生登录，完成登录后原任务继续', 'continue_production', exported.error || null)
            if (['failed', 'needs_attention'].includes(exported.status)) return set('attention', 'export', exported.error || exported.message || '成片导出需要处理', 'retry_export', exported.error || null)
            if (exported.status === 'completed') return set('attention', 'export', '导出记录已完成，但缺少当前视频版本的独立交付，请核对原导出产物', 'continue_production')
            return set('exporting', 'export', exported.message || '正在导出并下载花生成片')
          }
          if (huasheng?.production_status === 'completed') return set('exporting', 'export', '花生平台素材已就绪，等待导出本地成片', 'continue_production')
          if (huasheng && ['failed', 'needs_attention', 'waiting_login'].includes(huasheng.status)) return set('attention', 'production', huasheng.error || huasheng.message || '花生制作需要处理', 'continue_production', huasheng.error || null)
          if (huasheng) return set('producing', 'production', huasheng.production_message || huasheng.message || '花生平台制作中')
        }
        if (producer === 'motion' && motion) {
          if (['failed', 'needs_review', 'completed'].includes(motion.status)) return set('attention', 'production', motion.data.error || motion.data.message || '精细化制作尚未交付当前成片', 'continue_production', motion.data.error || null)
          return set('producing', 'production', motion.data.message || '精细化制作中')
        }
        const error = production?.[`${producer}_error`]
        if (production?.[`${producer}_state`] === 'failed') return set('attention', 'production', error || '制作需要处理', 'continue_production', error || null)
        return set('pending', 'production', automatic ? '已接纳，等待制作任务推进' : '尚未开始制作', automatic ? 'none' : 'continue_production')
      }
      if (!version.videoAvailable) return set('attention', producer === 'huasheng' ? 'export' : 'production', '当前成片文件不存在或不可读取，请恢复原成片',
        producer === 'huasheng' && exported && ['failed', 'needs_attention'].includes(exported.status) ? 'retry_export' : 'continue_production')
      const packaging = rows.packaging.find(row => row.script_id === source.id && row.video_id === video.id)
      const design = rows.designs.find(row => row.script_id === source.id && row.video_id === video.id)
      const intent = rows.intents.find(row => row.source_id === source.id && row.video_id === video.id && row.script_sha256 === scriptSha256)
      if (packaging && packaging.script_sha256 !== scriptSha256) return set('stale', 'packaging', '本版标题和封面不属于当前稿件版本', 'retry_packaging')
      if (packaging && (['failed', 'needs_attention'].includes(packaging.design_status) || ['failed', 'needs_attention'].includes(packaging.cover_status))
        || design && ['failed', 'needs_attention'].includes(design.phase)) return set('attention', 'packaging',
        packaging?.design_error || packaging?.error || design?.message || '本版标题或封面生成失败', 'retry_packaging', packaging?.design_error || packaging?.error || design?.message || null)
      if (!packaging && producer === 'huasheng' && exported && ['failed', 'needs_attention'].includes(exported.status)
        && [exported.design_status, exported.cover_status].some(status => ['failed', 'needs_attention'].includes(status))) {
        return set('attention', 'packaging', exported.error || exported.message || '原花生标题或封面生成失败，请继续原任务',
          'retry_packaging', exported.error || null)
      }
      const covers = object(packaging?.covers_json)
      const titleLength = typeof packaging?.baijiahao_title === 'string' ? Array.from(packaging.baijiahao_title.trim()).length : 0
      const materialStatusComplete = packaging?.design_status === 'completed' && packaging.cover_status === 'completed'
      const materialsReady = materialStatusComplete && packaging.cover_script_sha256 === scriptSha256 && titleLength >= 2 && titleLength <= 50
        && ['16:9', '3:4'].every(ratio => assets.available(covers[ratio], source.id))
      version.materialsReady = materialsReady
      if (!materialsReady) {
        if (materialStatusComplete) return set('attention', 'packaging', '本版标题、封面文件或稿件版本不完整，请修复发布材料', 'retry_packaging')
        if (intent && ['failed', 'needs_attention'].includes(intent.status)) return set('attention', 'packaging', intent.error || '本版发布准备需要继续原任务', 'retry_packaging', intent.error || null)
        const scheduled = intent && ['pending', 'queued'].includes(intent.status)
          || design && ['queued', 'admitted', 'dispatched'].includes(design.phase)
          || packaging && [packaging.design_status, packaging.cover_status].includes('generating')
          || producer === 'huasheng' && exported && ['queued', 'exporting', 'downloading', 'processing'].includes(exported.status)
        if (!scheduled) return set('attention', 'packaging', '本版发布材料尚未齐备，请继续准备标题和视频封面', 'retry_packaging')
        return set('packaging', 'packaging', '正在准备本版标题和视频封面', automatic ? 'none' : 'retry_packaging')
      }
      if (!revision && intent && ['failed', 'needs_attention'].includes(intent.status)) return set('attention', 'publication', intent.error || '自动发表需要继续原任务', 'retry_packaging', intent.error || null)
      version.canPublish = true
      return set('ready', 'publication', revision ? '修订成片材料已齐备，原成片已提交；需明确选择再次发表'
        : automatic ? '本版材料已齐备，等待自动提交百家号' : '本版材料已齐备，可提交百家号', 'publish')
    })
    return {scriptId: source.id, scriptSha256, productionMode, versions,
      complete: current && versions.length > 0 && versions.every(version => ['submitted', 'published'].includes(version.state)),
      productionComplete: current && versions.length > 0 && versions.every(version => version.videoAvailable
        || ['submitted', 'published'].includes(version.state))}
  })
}

export function getHistoryProductionState(database: Database.Database, source: HistoryProductionSource, options: Options = {}) {
  return getHistoryProductionStates(database, [source], options)[0]!
}
