import fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { recoverCbaUpload, validateCbaUploadReceipt, type CbaUploadRecoveryOptions, type CbaUploadRecoveryPatch } from './cba-upload-recovery.js'
import type { SocialUploadPayload } from './social-auto-upload.js'
import type { NbaJob, NbaUpload } from './nba-types.js'
import { NBA_BAIJIAHAO_TOPIC, NBA_COPY_POLICY, legacyNbaDescription, nbaPublishingDescription } from './nba-publishing-copy.js'
import { cleanNbaArticleBody } from './nba-article-body.js'

const VERSION = 2
export { NBA_BAIJIAHAO_TOPIC } from './nba-publishing-copy.js'
const CREATION_DECLARATION = '含AI生成内容'
const target = 'baijiahao-video' as const
const sourceAttribution = /ESPN|美联社|路透社|NBA官网|直播吧|虎扑|央视网|腾讯体育|Associated Press|Reuters|新闻原文|原文节选|转载自/iu
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

interface UploadIdentity {
  version: number
  jobId: string
  accountName: string
  title: string
  description: string
  publicationMode: 'draft' | 'publish'
  tags: string[]
  creationDeclaration?: string
  publicationCopy?: NbaUpload['publicationCopy']
  video: { sha256: string; bytes: number }
  covers: { sourceSha256: string; landscapeSha256: string; portraitSha256: string; portraitSourceSha256?: string }
}
interface AssetManifest { identity: UploadIdentity; fingerprint: string; payload: SocialUploadPayload }
export type NbaUploadRuntime = CbaUploadRecoveryOptions['runtime']
export interface PrepareNbaUploadInput { job: NbaJob; jobDir: string; accountName: string; accountLabel: string; publicationMode?: 'draft' | 'publish' }
export interface UploadNbaDraftInput {
  upload: NbaUpload
  inputDigest: string
  signal: AbortSignal
  /** Must durably persist before resolving. Identity fields are never changed. */
  persist: (patch: Partial<NbaUpload>) => void | Promise<void>
  onProgress?: CbaUploadRecoveryOptions['onProgress']
}

export class NbaUploadAttention extends Error {
  readonly code = 'NBA_UPLOAD_ATTENTION'
  constructor(message: string) { super(message); this.name = 'NbaUploadAttention' }
}

async function fileHash(filename: string) {
  const hash = createHash('sha256')
  for await (const block of createReadStream(filename)) hash.update(block)
  return hash.digest('hex')
}

async function measured(filename: string) {
  const stat = await fs.stat(filename)
  if (!stat.isFile() || !stat.size) throw new NbaUploadAttention('上传素材不是可读取的非空文件，请恢复原成片和封面后续做')
  return { sha256: await fileHash(filename), bytes: stat.size }
}

function titleFor(job: NbaJob) {
  const title = job.script?.title.trim()
  if (!title || !/\p{Script=Han}/u.test(title) || /[\r\n\x00-\x1f]/.test(title)) throw new NbaUploadAttention('上传需要现有中文稿的单行中文标题，请先完善稿件标题')
  if ([...title].length > 50) throw new NbaUploadAttention('中文标题超过百家号简介50字限制，请在稿件中缩短标题后续做')
  if (sourceAttribution.test(title)) throw new NbaUploadAttention('标题含媒体来源，请先修正中文稿标题后续做')
  return title
}

function trustedSaved(upload: NbaUpload) {
  if (upload.status !== 'saved' || !upload.payload) return false
  if (upload.payload.publicationMode === 'publish' && upload.result?.submitted !== true) return false
  try { validateCbaUploadReceipt(assertUploadIdentity(upload), upload.result, true); return true } catch { return false }
}

async function versionFile(filename: string, expectedHash: string, produce: (temporary: string) => Promise<void>) {
  try {
    const stat = await fs.stat(filename)
    if (!stat.isFile() || await fileHash(filename) !== expectedHash) throw new NbaUploadAttention('既有上传版本素材已改变，请保留原上传记录并核对文件，不能覆盖原版本')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}-${randomUUID()}.pending`)
  try {
    await produce(temporary)
    if (await fileHash(temporary) !== expectedHash) throw new NbaUploadAttention('准备期间原素材发生变化，未创建上传版本，请重新核验成片')
    // Replacing the directory entry preserves any source file linked to it.
    await fs.rename(temporary, filename)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

/** Prepare immutable local artifacts only. This function never operates a platform. */
export async function prepareNbaUpload(input: PrepareNbaUploadInput): Promise<NbaUpload> {
  const { job, accountName } = input
  if (job.qualityHold) throw new NbaUploadAttention(job.qualityHold.reason)
  for (const text of [job.article.body, job.script?.text || '']) {
    const cleaned = cleanNbaArticleBody(text)
    if (!cleaned.safe || cleaned.removedSections.length) throw new NbaUploadAttention('正文仍包含网页声明、推荐或版权杂项，已停止发表，请先清理并重新制作')
  }
  const publicationMode = input.publicationMode || 'publish'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(accountName) || !input.accountLabel.trim()) throw new NbaUploadAttention('请先选择已保存的百家号账号，再准备上传')
  const delivery = job.delivery, title = titleFor(job)
  if (!delivery?.videoPath || !delivery.coverPath || !/^[a-f0-9]{64}$/.test(delivery.sha256)) throw new NbaUploadAttention('当前任务缺少已核验成片或封面，请先完成制作')
  const video = await measured(delivery.videoPath)
  if (video.sha256 !== delivery.sha256 || video.bytes !== delivery.bytes) throw new NbaUploadAttention('成片实际摘要或大小与交付记录不一致，请重新核验，未准备上传')
  const bound = publicationMode === 'publish' ? job.uploads?.find(upload => upload.accountName === accountName && upload.target === target
    && upload.inputDigest === video.sha256 && upload.payload?.publicationMode === 'publish' && upload.dispatched
    && (trustedSaved(upload) || (!upload.publicationCopy && upload.payload.title === title))) : undefined
  if (bound) { assertUploadIdentity(bound); return structuredClone(bound) }
  const cover = await measured(delivery.coverPath), sourceImage = await fs.readFile(delivery.coverPath)
  if (digest(sourceImage) !== cover.sha256) throw new NbaUploadAttention('封面在准备期间发生变化，请重新核验后续做')
  let landscape: Buffer, portrait: Buffer, portraitSourceSha256: string | undefined
  try {
    const image = sharp(sourceImage, { failOn: 'error', limitInputPixels: 40_000_000 }), metadata = await image.metadata()
    if (!metadata.width || !metadata.height) throw new Error('Missing image dimensions')
    landscape = await image.rotate().png({ compressionLevel: 9 }).toBuffer()
    if (delivery.portraitCoverPath) {
      const source = await measured(delivery.portraitCoverPath), portraitImage = await fs.readFile(delivery.portraitCoverPath)
      if (digest(portraitImage) !== source.sha256) throw new NbaUploadAttention('竖版封面在准备期间发生变化，请重新核验后续做')
      const independent = sharp(portraitImage, { failOn: 'error', limitInputPixels: 40_000_000 }), metadata = await independent.metadata()
      if (metadata.format !== 'png') throw new NbaUploadAttention('独立竖版封面必须为有效的3:4 PNG图片，请重新生成后续做')
      portrait = await independent.rotate().png({ compressionLevel: 9 }).toBuffer()
      const native = await sharp(portrait).metadata()
      if (!native.width || !native.height || native.width * 4 !== native.height * 3) {
        throw new NbaUploadAttention('独立竖版封面必须为有效的3:4 PNG图片，请重新生成后续做')
      }
      portraitSourceSha256 = source.sha256
    } else {
      const native = await sharp(landscape).metadata()
      const height = Math.min(native.height!, Math.floor(native.width! * 4 / 3)), width = Math.floor(height * 3 / 4)
      portrait = await sharp(landscape).resize(width, height, { fit: 'cover', position: sharp.strategy.attention, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()
    }
  } catch (error) {
    if (error instanceof NbaUploadAttention) throw error
    throw new NbaUploadAttention('成片封面不能解码为有效图片，请重新生成封面后续做')
  }
  const tags = publicationMode === 'publish' ? [NBA_BAIJIAHAO_TOPIC] : []
  const publicationCopy: NbaUpload['publicationCopy'] = publicationMode === 'publish' ? { policy: NBA_COPY_POLICY, description: nbaPublishingDescription(job) } : undefined
  const description = publicationCopy?.description || legacyNbaDescription(title, publicationMode)
  const publicationFields = publicationMode === 'publish' ? { creationDeclaration: CREATION_DECLARATION } : {}
  const copyFields = publicationCopy ? { publicationCopy } : {}
  const identity: UploadIdentity = { version: VERSION, jobId: job.id, accountName, title, description, publicationMode, tags, ...publicationFields, ...copyFields, video,
    covers: { sourceSha256: cover.sha256, landscapeSha256: digest(landscape), portraitSha256: digest(portrait),
      ...(portraitSourceSha256 ? { portraitSourceSha256 } : {}) } }
  const fingerprint = digest(JSON.stringify(identity))
  const existing = job.uploads?.find(upload => upload.fingerprint === fingerprint && upload.accountName === accountName && upload.target === target)
  const unresolved = job.uploads?.find(upload => upload.target === target && upload.accountName === accountName && upload.dispatched && upload.fingerprint !== fingerprint && !trustedSaved(upload))
  if (unresolved) throw new NbaUploadAttention(`该账号的原上传 ${unresolved.id} 结果尚未核实，请先恢复原检查点；不能用新版本跳过原结果`)
  if (existing) {
    if (!existing.payload || existing.payload.jobId !== existing.id || existing.payload.accountName !== accountName || existing.payload.fingerprint !== fingerprint
      || existing.payload.target !== target || existing.payload.publicationMode !== publicationMode) throw new NbaUploadAttention('原上传记录的账号或素材身份不一致，请核对原记录，不能创建替代上传')
    return structuredClone(existing)
  }
  const legacy = publicationMode === 'publish' ? job.uploads?.find(upload => upload.accountName === accountName && upload.inputDigest === video.sha256
    && upload.payload?.publicationMode === 'draft' && upload.payload.title === title && trustedSaved(upload)) : undefined
  const directory = path.join(path.resolve(input.jobDir), 'uploads/assets', fingerprint)
  await fs.mkdir(directory, { recursive: true })
  const videoPath = legacy?.payload?.videoPath || path.join(directory, 'video.mp4'), landscapePath = path.join(directory, 'landscape.png'), portraitPath = path.join(directory, 'portrait.png')
  if (legacy) {
    const original = await measured(videoPath)
    if (original.sha256 !== video.sha256 || original.bytes !== video.bytes) throw new NbaUploadAttention('原草稿视频文件与当前成片不一致，不能在原草稿发表')
  } else await versionFile(videoPath, video.sha256, temporary => fs.copyFile(delivery.videoPath, temporary, constants.COPYFILE_FICLONE))
  await versionFile(landscapePath, identity.covers.landscapeSha256, temporary => fs.writeFile(temporary, landscape))
  await versionFile(portraitPath, identity.covers.portraitSha256, temporary => fs.writeFile(temporary, portrait))
  const id = legacy?.id || `nba-upload-${digest(JSON.stringify([job.id, accountName, fingerprint])).slice(0, 48)}`
  const payload: SocialUploadPayload = { jobId: id, scriptId: legacy?.payload?.scriptId || parseInt(digest(job.id).slice(0, 12), 16), target, publicationMode, accountName,
    title, description, ...publicationFields, ...(tags.length ? { tags, topicPolicy: 'required-exact' as const } : {}), videoPath, landscapePath, portraitPath, fingerprint }
  const manifest: AssetManifest = { identity, fingerprint, payload }, content = JSON.stringify(manifest, null, 2) + '\n'
  await versionFile(path.join(directory, 'manifest.json'), digest(content), temporary => fs.writeFile(temporary, content))
  const now = new Date().toISOString()
  return { id, target, accountName, accountLabel: input.accountLabel.trim(), fingerprint, inputDigest: video.sha256, payload, ...copyFields,
    ...(legacy ? { previousDraft: { payload: structuredClone(legacy.payload!), result: structuredClone(legacy.result!), fingerprint: legacy.fingerprint } } : {}),
    status: 'queued', message: publicationMode === 'publish' ? '已准备清晰封面与 #NBA# 话题，等待直接发表百家号' : '已准备视频与横竖封面，等待保存百家号草稿',
    dispatched: false, createdAt: legacy?.createdAt || now, updatedAt: now, attempts: [] }
}

function assertUploadIdentity(upload: NbaUpload) {
  const payload = upload.payload
  const publishing = payload?.publicationMode === 'publish'
  const copy = upload.publicationCopy
  const expectedDescription = publishing && copy?.policy === NBA_COPY_POLICY ? copy.description : legacyNbaDescription(payload?.title || '', publishing ? 'publish' : 'draft')
  if (!payload || upload.target !== target || payload.target !== target || !['draft', 'publish'].includes(payload.publicationMode || '')
    || payload.jobId !== upload.id || payload.accountName !== upload.accountName || payload.fingerprint !== upload.fingerprint
    || !/^[a-f0-9]{64}$/.test(upload.fingerprint) || !/^[a-f0-9]{64}$/.test(upload.inputDigest)
    || !payload.videoPath || !payload.landscapePath || !payload.portraitPath || payload.description !== expectedDescription
    || (copy && (!publishing || copy.policy !== NBA_COPY_POLICY))
    || payload.description.length > 50 || /[\r\n\x00-\x1f]/.test(payload.description) || sourceAttribution.test(payload.description)
    || (publishing && (payload.topicPolicy !== 'required-exact' || JSON.stringify(payload.tags) !== JSON.stringify([NBA_BAIJIAHAO_TOPIC])
      || payload.creationDeclaration !== CREATION_DECLARATION))
    || !/\p{Script=Han}/u.test(payload.title) || [...payload.title].length > 50 || sourceAttribution.test(payload.title)) {
    throw new NbaUploadAttention('原上传任务、账号、文案或发表模式绑定不一致，已停止自动操作；请核对原记录')
  }
  return payload
}

async function verifyUploadFiles(upload: NbaUpload) {
  const payload = assertUploadIdentity(upload), directory = path.dirname(payload.landscapePath!)
  if (path.dirname(payload.portraitPath!) !== directory || (!upload.previousDraft && path.dirname(payload.videoPath!) !== directory)
    || (upload.previousDraft && payload.videoPath !== upload.previousDraft.payload.videoPath)) throw new NbaUploadAttention('原上传版本素材路径不一致，不能继续操作')
  let manifest: AssetManifest
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) } catch { throw new NbaUploadAttention('原上传版本清单缺失或不可读，请恢复原素材清单后继续，不能重建上传身份') }
  if (manifest.fingerprint !== upload.fingerprint || digest(JSON.stringify(manifest.identity)) !== upload.fingerprint
    || JSON.stringify(manifest.payload) !== JSON.stringify(payload) || manifest.identity.accountName !== upload.accountName
    || JSON.stringify(manifest.identity.publicationCopy) !== JSON.stringify(upload.publicationCopy)
    || manifest.identity.video.sha256 !== upload.inputDigest) throw new NbaUploadAttention('原上传清单与任务身份不一致，请核对原版本')
  const actual = await measured(payload.videoPath!)
  if (actual.sha256 !== manifest.identity.video.sha256 || actual.bytes !== manifest.identity.video.bytes
    || await fileHash(payload.landscapePath!) !== manifest.identity.covers.landscapeSha256
    || await fileHash(payload.portraitPath!) !== manifest.identity.covers.portraitSha256) throw new NbaUploadAttention('原上传视频或封面文件已变化，已保留原任务并停止写入，请恢复原版本素材')
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, '[已隐藏]')
    .replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]').slice(0, 1200)
}

/** Continue the original upload or publish an existing draft in place. */
export async function uploadNbaVideo(input: UploadNbaDraftInput, runtimeOverride?: NbaUploadRuntime): Promise<{ saved: boolean; submitted: boolean; message: string }> {
  const current = structuredClone(input.upload)
  const persist = async (patch: CbaUploadRecoveryPatch) => {
    const update = { ...patch, updatedAt: new Date().toISOString() }
    await input.persist(update); Object.assign(current, update)
  }
  try {
    if (input.signal.aborted) return { saved: false, submitted: false, message: '任务已停止，保留原上传检查点' }
    const payload = assertUploadIdentity(current)
    if (!current.dispatched && input.inputDigest === current.inputDigest) await verifyUploadFiles(current)
    input.signal.throwIfAborted()
    const runtime: NbaUploadRuntime = runtimeOverride || await import('./social-auto-upload.js')
    const guardWrite = async <T>(execute: () => Promise<T>) => {
      input.signal.throwIfAborted(); await verifyUploadFiles(current); input.signal.throwIfAborted(); return execute()
    }
    const guarded: NbaUploadRuntime = { ...runtime,
      runSocialUpload: (snapshot, options) => guardWrite(() => runtime.runSocialUpload(snapshot, options)),
      resumeSocialUpload: (snapshot, options) => guardWrite(() => runtime.resumeSocialUpload(snapshot, options)),
      confirmSocialUpload: (snapshot, result, options) => guardWrite(() => runtime.confirmSocialUpload(snapshot, result, options)),
    }
    if (current.previousDraft) {
      if (input.inputDigest !== current.inputDigest) throw new NbaUploadAttention('当前视频已变化，不能发表原草稿')
      const previous = current.previousDraft
      validateCbaUploadReceipt(previous.payload, previous.result, true)
      if (previous.payload.publicationMode !== 'draft' || previous.payload.jobId !== current.id
        || previous.payload.accountName !== current.accountName || previous.payload.fingerprint !== previous.fingerprint
        || previous.payload.videoPath !== payload.videoPath || previous.payload.title !== payload.title
        || previous.payload.scriptId !== payload.scriptId) throw new NbaUploadAttention('原草稿与当前发表任务不一致，不能继续发表')
      const originalId = new URL(previous.result.draftUrl!).searchParams.get('article_id')
      const accept = async (result: NonNullable<NbaUpload['result']>) => {
        validateCbaUploadReceipt(payload, result, true)
        if (result.submitted !== true || result.saved !== false || result.articleId !== originalId) throw new NbaUploadAttention('未取得原草稿的可信发表提交回执，已保留原任务')
        const message = result.published ? '已发表百家号作品' : '已提交百家号，等待平台审核'
        await persist({ result, status: 'saved', message })
        return { saved: false, submitted: true, message }
      }
      if (current.dispatched) {
        const checkpoint = await runtime.inspectSocialUploadCheckpoint(payload)
        if (checkpoint.action === 'complete' && checkpoint.result) return await accept(checkpoint.result)
        if (checkpoint.action === 'reconcile' || checkpoint.phase === 'publish_requested') {
          const staged = checkpoint.result || current.result
          validateCbaUploadReceipt(payload, staged, false)
          return await accept(await runtime.reconcileSocialUpload(payload, staged!, { onProgress: input.onProgress }))
        }
      }
      if (!runtime.publishSavedSocialUpload) throw new NbaUploadAttention('当前上传运行时不支持原草稿转发表，请更新服务后继续')
      await persist({ dispatched: true, status: 'running', message: '正在原草稿更新封面与 #NBA# 话题并直接发表' })
      return await accept(await guardWrite(() => runtime.publishSavedSocialUpload!(payload, previous.payload, previous.result, { onProgress: input.onProgress })))
    }
    const outcome = await recoverCbaUpload(payload, current, { runtime: guarded, currentInputDigest: input.inputDigest, persist,
      isCancelled: () => input.signal.aborted, onProgress: (message, progress) => { if (!input.signal.aborted) input.onProgress?.(message, progress) }, maxReadOnlyAttempts: 2 })
    const complete = outcome.decision === 'saved' && outcome.matchesCurrentVersion
    const submitted = complete && payload.publicationMode === 'publish' && outcome.result?.submitted === true && outcome.result.saved === false
    if (complete && payload.publicationMode === 'publish' && !submitted) {
      const message = '尚未取得百家号发表提交回执，已保留原任务继续核对'
      await persist({ status: 'uncertain', message })
      return { saved: false, submitted: false, message }
    }
    return { saved: complete && payload.publicationMode === 'draft' && outcome.result?.saved === true, submitted, message: outcome.message }
  } catch (error) {
    if (input.signal.aborted) {
      const message = '任务已停止，保留原上传身份与检查点'
      await persist({ status: current.dispatched ? 'uncertain' : current.status, message })
      return { saved: false, submitted: false, message }
    }
    const message = errorMessage(error)
    await persist({ status: current.dispatched ? 'uncertain' : error instanceof NbaUploadAttention ? 'blocked' : 'failed', message })
    return { saved: false, submitted: false, message }
  }
}

export const uploadNbaDraft = uploadNbaVideo
