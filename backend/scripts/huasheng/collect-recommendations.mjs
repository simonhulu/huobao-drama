import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { connectHuashengBrowser } from '../../src/services/history-huasheng-browser.ts'
import { DEFAULT_MATERIAL_DATABASE_PATH, HuashengMaterialLibrary } from '../../src/services/huasheng-material-library.mjs'

const require = createRequire(import.meta.url)
const { cleanName, getRows, mediaInfo, unwrapProject } = require('../../../tools/tampermonkey/huasheng-clips.user.js')
const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ORIGIN = 'https://www.huasheng.cn'
const TOP = 3

export function parseOptions(args) {
  const options = { output: '', database: process.env.DB_PATH || DEFAULT_MATERIAL_DATABASE_PATH, limit: Infinity, metadataOnly: false, projectConcurrency: 1 }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--metadata-only') options.metadataOnly = true
    else if (arg === '--refresh-metadata') options.refreshMetadata = true
    else if (arg === '--all-projects') options.allProjects = true
    else if (arg === '--import-existing') options.importExisting = true
    else if (arg === '--stats') options.stats = true
    else if (arg === '--help') options.help = true
    else if (['--project', '--output', '--database', '--search', '--limit', '--project-concurrency'].includes(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--project') options.project = value
      if (arg === '--output') options.output = path.resolve(value)
      if (arg === '--database') options.database = path.resolve(value)
      if (arg === '--search') options.search = value
      if (arg === '--project-concurrency') {
        options.projectConcurrency = Number(value)
        if (!Number.isSafeInteger(options.projectConcurrency) || options.projectConcurrency < 1 || options.projectConcurrency > 16) throw new Error('--project-concurrency must be an integer from 1 to 16')
      }
      if (arg === '--limit') {
        options.limit = Number(value)
        if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('--limit must be a positive integer')
      }
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (options.help) return options
  if ([options.importExisting, options.stats, options.search !== undefined].filter(Boolean).length > 1) throw new Error('Choose only one of --import-existing, --stats or --search')
  if (options.allProjects) {
    if (options.project || options.importExisting || options.stats || options.search !== undefined) throw new Error('--all-projects cannot be combined with --project, --import-existing, --stats or --search')
    options.output ||= path.join(ROOT, 'data/huasheng-recommendations')
    return options
  }
  if (options.projectConcurrency !== 1) throw new Error('--project-concurrency requires --all-projects')
  const value = options.project || ''
  if (!value && (options.stats || options.search !== undefined)) return options
  if (!value) throw new Error('--project is required')
  const url = /^\d+$/.test(value) ? new URL(`/video/${value}`, ORIGIN) : new URL(value)
  if (url.protocol !== 'https:' || !['huasheng.cn', 'www.huasheng.cn'].includes(url.hostname)
    || url.username || url.password || url.port || url.search || url.hash || !/^\/video\/\d+\/?$/.test(url.pathname)) {
    throw new Error('--project must be a Huasheng project URL or numeric pid')
  }
  options.pid = url.pathname.split('/')[2]
  options.projectUrl = `${ORIGIN}/video/${options.pid}`
  options.output ||= path.join(ROOT, 'data/huasheng-recommendations', options.pid)
  return options
}

export async function readSession() {
  const browser = await connectHuashengBrowser()
  try {
    const cookies = (await browser.defaultBrowserContext().cookies())
      .filter(cookie => ['huasheng.cn', '.huasheng.cn', 'www.huasheng.cn'].includes(cookie.domain))
    if (!cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value)) throw new Error('花生专用浏览器需要重新登录')
    return { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), userAgent: await browser.userAgent() }
  } finally { await browser.disconnect() }
}

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('花生接口未返回 JSON 对象')
  if (payload.code !== undefined && ![0, '0'].includes(payload.code)) throw new Error(`花生接口错误 ${payload.code}`)
  return payload.data ?? payload
}

export function createClient({ session, fetch: requestFetch = globalThis.fetch, signal } = {}) {
  async function request(endpoint, params, emptyOnNotFound = false) {
    signal?.throwIfAborted()
    const url = new URL(endpoint, ORIGIN)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const response = await requestFetch(url, {
      headers: { Cookie: session.cookie, 'User-Agent': session.userAgent, Referer: ORIGIN + '/' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`花生接口 HTTP ${response.status}`)
    const payload = await response.json()
    if (emptyOnNotFound && [404, '404'].includes(payload?.code)) return { projects: [], total: 0 }
    return unwrap(payload)
  }
  return {
    async projects() {
      const projects = []
      const ids = new Set()
      let total
      for (let pn = 1; pn <= 1000; pn++) {
        const data = await request('/api/innovideo/project/list', { pn, ps: 20 }, true)
        const pageTotal = Number(data.total)
        if (!Array.isArray(data.projects) || data.projects.some(project => !/^\d+$/.test(String(project?.pid || '')))) throw new Error('项目列表缺少有效的 projects 数据')
        if (data.total === null || data.total === undefined || !Number.isSafeInteger(pageTotal) || pageTotal < 0 || pageTotal > 20000) throw new Error('项目列表总数无效')
        if (total !== undefined && total !== pageTotal) throw new Error('采集时项目列表已变化，请重试')
        total = pageTotal
        if (!data.projects.length && projects.length < total) throw new Error('项目列表提前结束')
        for (const project of data.projects) {
          const id = String(project.pid)
          if (ids.has(id)) throw new Error('项目列表存在重复项目，请重试')
          ids.add(id)
          projects.push(project)
        }
        if (projects.length >= total) {
          if (projects.length !== total) throw new Error('项目列表数量不匹配')
          return projects
        }
      }
      throw new Error('项目列表超过可处理页数')
    },
    async project(pid) {
      let data = unwrapProject(await request('/api/innovideo/project/info', { pid }))
      const sandbox = Boolean(data.project.is_agent_sandbox)
      if (sandbox) data = unwrapProject(await request('/api/v2/innovideo/project/info', { pid }))
      if (String(data.project.pid) !== pid) throw new Error('接口返回的项目编号不匹配')
      if (data.clips === null && data.project.project_stage === 0 && data.project.version === 0) data.clips = []
      getRows(data, pid)
      return { data, prefix: sandbox ? '/api/v2/innovideo' : '/api/huasheng' }
    },
    async recommendations(pid, clip, prefix) {
      const candidates = []
      let total
      let query
      for (let pn = 1; pn <= 100; pn++) {
        const data = await request(`${prefix}/clip/candidates/list`, { pid, clip_id: clip.id, ps: 60, pn })
        if (!Array.isArray(data.candidates) || data.candidates.some(candidate => !candidate || typeof candidate !== 'object' || !candidate.id)) {
          throw new Error('推荐接口缺少有效的 candidates 列表')
        }
        const pageTotal = Number(data.page?.total)
        if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || pageTotal > 1200) throw new Error('推荐列表总数无效')
        if (total !== undefined && total !== pageTotal) throw new Error('采集时推荐列表已变化，请重试此分镜')
        total = pageTotal
        if (typeof data.query === 'string' && data.query) {
          if (query !== undefined && query !== data.query) throw new Error('采集时分镜描述已变化，请重试此分镜')
          query = data.query
        }
        if (data.page?.pn !== undefined && Number(data.page.pn) !== pn) throw new Error('推荐列表页码不匹配')
        candidates.push(...data.candidates)
        if (candidates.length > total || new Set(candidates.map(candidate => String(candidate.id))).size !== candidates.length) {
          throw new Error('推荐列表有重复或数量不匹配，请重试此分镜')
        }
        const pageSize = Number(data.page?.ps)
        if (candidates.length === total || !data.candidates.length || Number.isSafeInteger(pageSize) && pageSize > 0 && pn * pageSize >= total) {
          return {
            query: query || String(clip.video?.query || ''), querySource: query ? 'recommendations.query' : 'clip.video.query', total, candidates,
            ...(candidates.length < total ? { metadataWarning: { reportedTotal: total, capturedTotal: candidates.length, message: '接口报告总数与实际可见素材数不一致' } } : {}),
          }
        }
      }
      throw new Error('推荐列表超过可处理页数')
    },
  }
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await fs.rename(temporary, filename)
}

async function sha256(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export async function probeVideo(filename) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename], { timeout: 30000, maxBuffer: 1024 * 1024 })
  const info = JSON.parse(stdout)
  const video = info.streams?.find(stream => stream.codec_type === 'video')
  const duration = Number(info.format?.duration)
  if (!video || !(duration > 0) || !video.width || !video.height) throw new Error('下载文件不是有效视频')
  return { duration, width: video.width, height: video.height, codec: video.codec_name }
}

async function requireDiskSpace(directory, bytes = 0) {
  const space = await fs.statfs(directory)
  const configured = Number(process.env.MEDIA_DISK_RESERVE_GIB)
  const reserve = (Number.isFinite(configured) && configured >= 1 ? configured : 10) * 1024 ** 3
  if (space.bavail * space.bsize < reserve + Math.max(0, bytes)) {
    const error = new Error(`素材目录空间不足，需保留 ${Math.ceil(reserve / 1024 ** 3)} GiB，已停止新下载；请先回收空间或更换素材目录后继续`)
    error.code = 'MATERIAL_DISK_FULL'
    throw error
  }
}

export async function downloadVideo(url, filename, { previous, reusableFiles = [], repairExisting = false, signal, fetch: requestFetch = globalThis.fetch, probe = probeVideo } = {}) {
  signal?.throwIfAborted()
  let files
  const getFiles = async () => files ||= typeof reusableFiles === 'function' ? await reusableFiles() : reusableFiles
  let damaged
  try {
    const stat = await fs.lstat(filename)
    if (stat.isFile() && previous?.status === 'done' && stat.size === previous.bytes && await sha256(filename) === previous.sha256) {
      return { ...previous, reused: true, repaired: false }
    }
    const registered = (await getFiles()).find(file => path.resolve(file.filePath) === path.resolve(filename))
    if (!stat.isFile() || !repairExisting || !registered) throw new Error('目标文件已存在但校验不匹配，已保留原文件')
    if (stat.size === registered.bytes && await sha256(filename) === registered.sha256) {
      return { status: 'done', bytes: registered.bytes, sha256: registered.sha256, media: registered.media, reused: true, repaired: false }
    }
    damaged = stat
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const registeredFiles = await getFiles()
  const repaired = repairExisting && (!!damaged || previous?.status === 'done'
    || registeredFiles.some(file => path.resolve(file.filePath) === path.resolve(filename)))
  const temporary = `${filename}.part`
  const publish = async () => {
    if (damaged) {
      const current = await fs.lstat(filename)
      if (!current.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => current[key] !== damaged[key])) {
        throw new Error('待修复文件已被其他进程修改，已保留原文件')
      }
      await fs.rename(temporary, filename)
    } else {
      // Publish without overwriting an unregistered or concurrently created path.
      await fs.link(temporary, filename)
      await fs.unlink(temporary)
    }
  }
  for (const file of registeredFiles) {
    let valid = false
    try {
      const stat = await fs.lstat(file.filePath)
      valid = stat.isFile() && stat.size > 0 && stat.size === file.bytes && await sha256(file.filePath) === file.sha256
    } catch {}
    if (!valid) continue
    signal?.throwIfAborted()
    let created = false
    try {
      await fs.link(file.filePath, damaged ? temporary : filename)
      if (damaged) { created = true; await publish(); created = false }
    }
    catch (error) {
      if (error.code === 'EXDEV') continue
      if (error.code === 'EEXIST') throw new Error('目标文件已存在，已保留原文件')
      throw error
    } finally { if (created) await fs.unlink(temporary).catch(() => {}) }
    return { status: 'done', bytes: file.bytes, sha256: file.sha256, media: file.media, reused: true, repaired }
  }
  await requireDiskSpace(path.dirname(filename))
  let created = false
  let response
  try {
    const handle = await fs.open(temporary, 'wx')
    created = true
    await handle.close()
    response = await requestFetch(url, {
      headers: { Referer: ORIGIN + '/' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
    })
    if (!response.ok) throw Object.assign(new Error(`视频下载 HTTP ${response.status}`), { status: response.status })
    if (/text\/|json|mpegurl|dash\+xml/i.test(response.headers.get('content-type') || '')) throw new Error('视频地址返回网页或播放清单')
    const expected = Number(response.headers.get('content-length')) || null
    await requireDiskSpace(path.dirname(filename), expected || 0)
    const hash = createHash('sha256')
    let bytes = 0
    let checkedBytes = 0
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length
        hash.update(chunk)
        if (bytes > 5 * 1024 ** 3) return callback(new Error('单个素材超过 5 GB'))
        if (bytes - checkedBytes >= 32 * 1024 ** 2) {
          checkedBytes = bytes
          requireDiskSpace(path.dirname(filename)).then(() => callback(null, chunk), callback)
        } else callback(null, chunk)
      },
    })
    if (!response.body) throw new Error('视频响应为空')
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary), { signal })
    if (!bytes || expected && bytes !== expected) throw new Error('视频下载字节数不完整')
    const media = await probe(temporary)
    signal?.throwIfAborted()
    await publish()
    created = false
    return { status: 'done', bytes, sha256: hash.digest('hex'), media, reused: false, repaired }
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
    if (error.code === 'EEXIST') throw new Error('目标文件或 .part 已存在，已保留，请核对后重试')
    throw error
  } finally { if (created) await fs.unlink(temporary).catch(() => {}) }
}

function relative(root, filename) { return path.relative(root, filename).split(path.sep).join('/') }

async function readJson(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function verifyRecordFiles(record, output) {
  const verified = structuredClone(record)
  for (const candidate of verified.candidates || []) {
    const download = candidate.download
    if (download?.status !== 'done') continue
    try {
      if (typeof download.localPath !== 'string' || path.isAbsolute(download.localPath)) throw new Error('文件路径无效')
      const filename = path.resolve(output, download.localPath)
      if (path.relative(path.resolve(output), filename).startsWith('..' + path.sep)) throw new Error('文件不在采集目录内')
      const stat = await fs.lstat(filename)
      if (!stat.isFile() || !stat.size || stat.size !== download.bytes || await sha256(filename) !== download.sha256) throw new Error('文件大小或 SHA-256 不匹配')
    } catch (error) {
      candidate.download = { ...download, status: 'failed', error: `导入文件核验失败：${error.message}` }
      verified.status = 'incomplete'
    }
  }
  return verified
}

export async function importExisting(options, { library, log = console.log } = {}) {
  const owned = !library
  library ||= new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    const manifest = await readJson(path.join(options.output, 'manifest.json'))
    if (!manifest || manifest.projectId !== options.pid || !Array.isArray(manifest.clips)) throw new Error('本地清单不存在或项目编号不匹配')
    if (!library.stats(options.pid).projects) library.saveProject(manifest)
    let imported = 0
    for (const clip of manifest.clips) {
      if (library.getClip(options.pid, clip.clipId, options.output)) continue
      const checkpoint = await readJson(path.join(options.output, 'clips', String(clip.order).padStart(3, '0'), 'annotation.json')) || clip
      if (checkpoint.projectId !== options.pid || checkpoint.clipId !== clip.clipId) throw new Error('分镜检查点与清单编号不匹配')
      const verified = await verifyRecordFiles(checkpoint, options.output)
      library.saveClip(options.pid, verified, options.output)
      imported++
    }
    const stats = library.stats(options.pid)
    log(`本次导入 ${imported} 个分镜；数据库现有 ${stats.clips} 个分镜、${stats.recommendations} 条推荐关系、${stats.files} 个本地文件记录。`)
    return stats
  } finally { if (owned) library.close() }
}

function clipSummary(clip) {
  const candidates = clip.candidates.slice(0, TOP)
  const failedDownloads = candidates.filter(candidate => candidate.download?.status === 'failed').length
  return {
    downloaded: candidates.filter(candidate => candidate.download?.status === 'done').length,
    reused: candidates.filter(candidate => candidate.download?.status === 'done' && candidate.download.reused).length,
    failedDownloads,
    failedClips: Number(clip.status === 'failed' || failedDownloads > 0),
    unavailableClips: Number(clip.status !== 'failed' && (candidates.length < TOP || candidates.some(candidate => candidate.download?.status === 'unavailable'))),
    metadataWarnings: Number(Boolean(clip.metadata?._recommendationCollection)),
    metadataReadClips: clip.metadataReadClips || 0,
    metadataSkippedClips: clip.metadataSkippedClips || 0,
    repairedDownloads: clip.repairedDownloads || 0,
  }
}

function checkpointHash(value) {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
}

function selectedSourceAssetId(row) {
  const id = row.metadata.video?.id
  return typeof id === 'string' || typeof id === 'number' ? String(id).trim() : ''
}

function clipFingerprint(row, legacyTimelineId = false) {
  const clip = row.metadata, video = clip.video || {}
  // Remote content and IDs establish identity; ordinal positions and signed URLs do not.
  return checkpointHash({ clipId: row.clipId, text: row.text, selectedAssetId: legacyTimelineId ? row.assetId : selectedSourceAssetId(row),
    source: { id: video.id, query: video.query, caption: video.caption, materialType: video.material_type,
      duration: video.duration, width: video.width, height: video.height, fps: video.fps },
    revision: { version: clip.version, updatedAt: clip.updated_at, updateTime: clip.update_time } })
}

function recommendationFingerprint(record) {
  return checkpointHash({ query: record.query, querySource: record.querySource, total: record.total, capturedAt: record.capturedAt,
    candidates: record.candidates.map(({ download, ...metadata }) => metadata) })
}

function reusableRecommendations(record, row) {
  const checkpoint = record?.metadata?._recommendationCheckpoint
  // Old checkpoints used a composite ID, but still hashed the complete source metadata.
  return checkpoint?.version === 1 && (checkpoint.sourceSha256 === clipFingerprint(row)
    || checkpoint.sourceSha256 === clipFingerprint(row, true))
    && record.status !== 'failed' && !record.metadata._recommendationCollection
    && typeof record.query === 'string' && typeof record.capturedAt === 'string'
    && Number.isSafeInteger(record.total) && record.total >= TOP && record.candidates?.length === record.total
    && checkpoint.snapshotSha256 === recommendationFingerprint(record)
}

function durableClipFingerprint(record) {
  const { metadataReadClips, metadataSkippedClips, repairedDownloads, ...snapshot } = record
  return checkpointHash({ ...snapshot, candidates: record.candidates.map(candidate => {
    if (!candidate.download) return candidate
    const { repaired, ...download } = candidate.download
    return { ...candidate, download }
  }) })
}

export async function collect(options, { client, library, download = downloadVideo, assetDownloads = new Map(), signal, log = console.log, onProgress = () => {} } = {}) {
  signal?.throwIfAborted()
  onProgress({ stage: 'project_start', projectId: options.pid, title: '', clipIndex: 0, totalClips: 0 })
  const { data, prefix } = await client.project(options.pid)
  const rows = getRows(data, options.pid).slice(0, options.limit)
  await fs.mkdir(options.output, { recursive: true })
  const lock = path.join(options.output, '.collect.lock')
  const handle = await fs.open(lock, 'wx').catch(() => { throw new Error('此目录已有采集锁，请确认没有其他采集进程后处理 .collect.lock') })
  const owned = !library
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    await handle.close()
    library ||= new HuashengMaterialLibrary({ databasePath: options.database })
    const manifestPath = path.join(options.output, 'manifest.json')
    const previousManifest = await readJson(manifestPath).catch(error => {
      if (!library.stats(options.pid).projects) throw error
      log('本地 JSON 备份无法读取，使用数据库中的采集记录继续。')
      return null
    })
    if (previousManifest && previousManifest.projectId !== options.pid) throw new Error('输出目录属于另一个项目')
    const previous = new Map((previousManifest?.clips || []).map(clip => [clip.clipId, clip]))
    const manifest = {
      schemaVersion: 1, projectId: options.pid, title: data.project.name || data.project.title || '', projectUrl: options.projectUrl,
      updatedAt: new Date().toISOString(), top: TOP, totalClips: data.clips.length, requestedClips: rows.length,
      annotationType: 'huasheng_recommendation_query', clips: [],
    }
    library.saveProject(manifest)
    const progress = { projectId: options.pid, title: manifest.title, totalClips: rows.length }
    onProgress({ ...progress, stage: 'project_loaded', clipIndex: 0 })
    for (const [index, row] of rows.entries()) {
      signal?.throwIfAborted()
      const clipDirectory = path.join(options.output, 'clips', String(row.order).padStart(3, '0'))
      await fs.mkdir(clipDirectory, { recursive: true })
      const stored = library.getClip(options.pid, row.clipId, options.output)
      let checkpoint = stored ? null : await readJson(path.join(clipDirectory, 'annotation.json'))
      if (checkpoint && (checkpoint.projectId !== options.pid || checkpoint.clipId !== row.clipId)) {
        if (checkpoint.projectId !== options.pid || !library.getClip(options.pid, checkpoint.clipId, options.output)) {
          throw new Error('分镜目录与当前项目不匹配，已保留原文件')
        }
        // A newly inserted clip can reuse an ordinal directory whose old clip is registered.
        checkpoint = null
      }
      const legacy = checkpoint || previous.get(row.clipId)
      const old = stored || (legacy ? await verifyRecordFiles(legacy, options.output) : null)
      const cached = !options.refreshMetadata && reusableRecommendations(old, row)
      const selectedAssetId = selectedSourceAssetId(row)
      const record = { ...old, projectId: options.pid, order: row.order, clipId: row.clipId, text: row.text, selectedAssetId, selectedCaption: selectedAssetId ? row.metadata.video?.caption || '' : '', metadata: { ...row.metadata,
        ...(cached ? { _recommendationCheckpoint: { ...old.metadata._recommendationCheckpoint, sourceSha256: clipFingerprint(row) } } : {}) }, candidates: old?.candidates || [],
        metadataReadClips: 0, metadataSkippedClips: Number(cached), repairedDownloads: 0 }
      let savingCheckpoint = Promise.resolve()
      let lastSavedFingerprint = stored ? durableClipFingerprint(stored) : null
      const saveCheckpoint = () => {
        const snapshot = structuredClone(record)
        savingCheckpoint = savingCheckpoint.then(async () => {
          const fingerprint = durableClipFingerprint(snapshot)
          if (fingerprint !== lastSavedFingerprint) {
            library.saveClip(options.pid, snapshot, options.output)
            lastSavedFingerprint = fingerprint
          }
          await atomicJson(path.join(clipDirectory, 'annotation.json'), snapshot)
        })
        return savingCheckpoint
      }
      log(`[${row.order}/${rows.length}] 分镜 ${row.clipId}：${cached ? '复用完整推荐检查点，核验本地素材' : '读取新增或变化的推荐信息'}`)
      onProgress({ ...progress, stage: 'clip_start', clipIndex: index + 1 })
      const readRecommendations = async () => {
        record.metadataReadClips = 1; record.metadataSkippedClips = 0
        const { metadataWarning, ...recommendations } = await client.recommendations(options.pid, row.metadata, prefix)
        const previousCandidates = record.candidates
        Object.assign(record, recommendations)
        record.metadata = { ...row.metadata }
        if (metadataWarning) {
          record.metadata = { ...record.metadata, _recommendationCollection: metadataWarning }
          log(`  推荐信息提示：接口报告 ${metadataWarning.reportedTotal} 条，实际取得 ${metadataWarning.capturedTotal} 条`)
        }
        record.candidates = recommendations.candidates.map((candidate, index) => {
          const prior = previousCandidates.find(item => String(item.id) === String(candidate.id))
          return { ...candidate, rank: index + 1, ...(prior?.download ? { download: prior.download } : {}) }
        })
        record.capturedAt = new Date().toISOString()
        record.metadata._recommendationCheckpoint = { version: 1, sourceSha256: clipFingerprint(row), snapshotSha256: recommendationFingerprint(record) }
        record.status = 'collecting'
        delete record.error
        // Keep the label even if the following media download is interrupted.
        await saveCheckpoint()
      }
      try {
        if (!cached) await readRecommendations()
        await fs.writeFile(path.join(clipDirectory, '标注.txt'), `${record.query}\n\n${record.text}\n`)
        let refreshUrls = false
        const transferCandidates = async () => {
          const downloads = await Promise.allSettled(record.candidates.slice(0, TOP).map(async candidate => {
            signal?.throwIfAborted()
            const media = mediaInfo(candidate.url, Number(candidate.material_type) === 2 ? 'image' : 'video')
            if (media.reason || media.kind !== 'video') {
              candidate.download = { status: 'unavailable', error: media.reason || '此推荐素材为图片，保留原信息' }
              return
            }
            const filename = path.join(clipDirectory, `${String(candidate.rank).padStart(2, '0')}_${cleanName(candidate.id, 90)}.${media.extension}`)
            const localPath = relative(options.output, filename)
            const saved = old?.candidates?.find(item => String(item.id) === String(candidate.id) && item.download?.localPath === localPath)?.download
            let changedFile = false
            if (options.metadataOnly) candidate.download = saved || { status: 'pending', localPath }
            else {
              try {
                const assetId = String(candidate.id)
                const previousTransfer = assetDownloads.get(assetId)
                const transfer = (async () => {
                  const shared = await previousTransfer?.catch(() => null)
                  signal?.throwIfAborted()
                  const result = await download(media.url, filename, { previous: saved, repairExisting: true,
                    reusableFiles: () => [...(shared ? [shared] : []), ...library.findFiles(assetId)], signal })
                  return { ...result, filePath: filename }
                })()
                assetDownloads.set(assetId, transfer)
                try {
                  const result = await transfer
                  const { filePath, repaired, ...downloadResult } = result
                  candidate.download = { ...downloadResult, localPath }
                  record.repairedDownloads += Number(Boolean(repaired))
                  changedFile = !result.reused || Boolean(repaired)
                } finally { if (assetDownloads.get(assetId) === transfer) assetDownloads.delete(assetId) }
                log(`  推荐 ${candidate.rank}：${candidate.download.reused ? '复用' : '已保存'} ${(candidate.download.bytes / 1024 ** 2).toFixed(1)} MB`)
              } catch (error) {
                signal?.throwIfAborted()
                if (error.code === 'MATERIAL_DISK_FULL') throw error
                if (cached && !record.metadataReadClips && [401, 403, 404, 410].includes(error.status)) refreshUrls = true
                candidate.download = { status: 'failed', localPath, error: error.message }
                log(`  推荐 ${candidate.rank}：${error.message}`)
              }
            }
            if (changedFile) await saveCheckpoint()
          }))
          const failed = downloads.find(result => result.status === 'rejected')
          if (failed) throw failed.reason
        }
        await transferCandidates()
        if (refreshUrls) {
          await readRecommendations()
          await fs.writeFile(path.join(clipDirectory, '标注.txt'), `${record.query}\n\n${record.text}\n`)
          await transferCandidates()
        }
        record.status = record.candidates.slice(0, TOP).every(candidate => candidate.download?.status === 'done') && record.candidates.length >= TOP ? 'done' : options.metadataOnly ? 'metadata_only' : 'incomplete'
      } catch (error) {
        signal?.throwIfAborted()
        record.status = 'failed'
        record.error = error.message
        if (error.code === 'MATERIAL_DISK_FULL') { await saveCheckpoint(); throw error }
        log(`  ${error.message}`)
      }
      await saveCheckpoint()
      manifest.clips.push(record)
      manifest.updatedAt = new Date().toISOString()
      await atomicJson(manifestPath, manifest)
      onProgress({ ...progress, stage: 'clip_complete', clipIndex: index + 1, clipStatus: record.status, ...clipSummary(record) })
    }
    if (!rows.length) await atomicJson(manifestPath, manifest)
    onProgress({ ...progress, stage: 'project_complete', clipIndex: rows.length })
    return manifest
  } finally {
    await handle.close().catch(() => {})
    if (owned) library?.close()
    await fs.unlink(lock).catch(() => {})
  }
}

export async function collectAll(options, { client, library, download = downloadVideo, signal, log = console.log, onProgress = () => {} } = {}) {
  const controller = new AbortController()
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  signal?.throwIfAborted()
  onProgress({ stage: 'project_list', completedProjects: 0, totalProjects: 0 })
  const projects = await client.projects()
  if (!Array.isArray(projects) || projects.some(project => !/^\d+$/.test(String(project?.pid || '')))
    || new Set(projects.map(project => String(project.pid))).size !== projects.length) throw new Error('项目清单包含无效或重复编号')
  await fs.mkdir(options.output, { recursive: true })
  const lock = path.join(options.output, '.all-projects.lock')
  const handle = await fs.open(lock, 'wx').catch(() => { throw new Error('此目录已有全量采集锁，请确认没有其他采集进程后处理 .all-projects.lock') })
  const owned = !library
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    await handle.close()
    library ||= new HuashengMaterialLibrary({ databasePath: options.database })
    const report = {
      schemaVersion: 1, projectListUrl: `${ORIGIN}/project`, startedAt: new Date().toISOString(),
      metadataOnly: options.metadataOnly, projectConcurrency: options.projectConcurrency || 1,
      projects: projects.map(project => ({ projectId: String(project.pid), title: project.name || '', status: 'pending', totalClips: 0, downloaded: 0, reused: 0, incompleteClips: 0, failedClips: 0, failedDownloads: 0, unavailableClips: 0, metadataWarnings: 0, metadataReadClips: 0, metadataSkippedClips: 0, repairedDownloads: 0, metadataComplete: null })),
    }
    let saving = Promise.resolve()
    const saveReport = () => {
      report.updatedAt = new Date().toISOString()
      const snapshot = structuredClone(report)
      saving = saving.then(() => atomicJson(path.join(options.output, 'batch-report.json'), snapshot))
      return saving
    }
    await saveReport()
    let completedProjects = 0
    const progress = value => onProgress({ ...value, completedProjects, totalProjects: projects.length })
    progress({ stage: 'project_list' })
    log(`项目列表共 ${projects.length} 个项目，开始采集全部分镜。`)
    let nextProject = 0
    const assetDownloads = new Map()
    const worker = async () => {
      while (nextProject < report.projects.length) {
        signal?.throwIfAborted()
        const index = nextProject++
        const entry = report.projects[index]
        entry.status = 'collecting'
        await saveReport()
        log(`\n项目 [${index + 1}/${projects.length}] ${entry.projectId} ${entry.title}`)
        progress({ stage: 'project_start', projectId: entry.projectId, title: entry.title, clipIndex: 0, totalClips: 0 })
        try {
          const projectOptions = {
            ...options, pid: entry.projectId, projectUrl: `${ORIGIN}/video/${entry.projectId}`,
            output: path.join(options.output, entry.projectId),
          }
          const manifest = await collect(projectOptions, { client, library, download, assetDownloads, signal, log, onProgress: value => {
            if (['project_start', 'project_complete'].includes(value.stage)) return
            progress({ ...value, title: value.title || entry.title })
          } })
          entry.title = manifest.title || entry.title
          entry.totalClips = manifest.totalClips
          for (const key of ['downloaded', 'reused', 'failedClips', 'failedDownloads', 'unavailableClips', 'metadataWarnings', 'metadataReadClips', 'metadataSkippedClips', 'repairedDownloads']) {
            entry[key] = manifest.clips.reduce((sum, clip) => sum + clipSummary(clip)[key], 0)
          }
          const failedClip = manifest.clips.find(clip => clip.error || clip.candidates.slice(0, TOP).some(candidate => candidate.download?.status === 'failed'))
          if (failedClip) entry.error = failedClip.error || failedClip.candidates.find(candidate => candidate.download?.status === 'failed')?.download.error
          entry.incompleteClips = manifest.clips.filter(clip => clip.status !== 'done' && !(options.metadataOnly && clip.status === 'metadata_only')).length
          entry.metadataComplete = !entry.metadataWarnings && !manifest.clips.some(clip => clip.status === 'failed')
          entry.status = !manifest.totalClips ? 'empty' : entry.incompleteClips ? 'incomplete' : options.metadataOnly ? 'metadata_only' : 'done'
          log(`项目完成：${manifest.clips.length} 个分镜、${entry.downloaded} 个视频，状态 ${entry.status}`)
        } catch (error) {
          if (error.code === 'MATERIAL_DISK_FULL') controller.abort(error)
          entry.status = signal?.aborted ? 'interrupted' : 'failed'
          entry.error = error.message
          await saveReport()
          signal?.throwIfAborted()
          log(`项目失败，继续下一项目：${error.message}`)
        }
        await saveReport()
        completedProjects++
        progress({ stage: 'project_complete', projectId: entry.projectId, title: entry.title, totalClips: entry.totalClips, clipIndex: entry.totalClips, status: entry.status,
          downloaded: entry.downloaded, reused: entry.reused, failedClips: entry.failedClips, failedDownloads: entry.failedDownloads, unavailableClips: entry.unavailableClips, metadataWarnings: entry.metadataWarnings,
          metadataReadClips: entry.metadataReadClips, metadataSkippedClips: entry.metadataSkippedClips, repairedDownloads: entry.repairedDownloads })
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: Math.min(options.projectConcurrency || 1, projects.length) }, worker))
    const failedWorker = workers.find(worker => worker.status === 'rejected')
    if (failedWorker) throw failedWorker.reason
    report.completedAt = new Date().toISOString()
    await saveReport()
    progress({ stage: 'completed' })
    return report
  } finally {
    await handle.close().catch(() => {})
    if (owned) library?.close()
    await fs.unlink(lock).catch(() => {})
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node --import tsx scripts/huasheng/collect-recommendations.mjs (--all-projects [--project-concurrency <1-16>] | --project <url|pid>) [--output <directory>] [--database <file>] [--limit <clips>] [--metadata-only | --import-existing] [--refresh-metadata]\nQuery: add --stats or --search <text>; --project is optional for database queries.\nUpdates reuse complete unchanged recommendation checkpoints; --refresh-metadata explicitly rereads them.')
    return
  }
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    if (options.stats) { console.log(JSON.stringify(library.stats(options.pid), null, 2)); return }
    if (options.search !== undefined) {
      console.log(JSON.stringify(library.search({ projectId: options.pid, query: options.search, limit: Number.isFinite(options.limit) ? options.limit : 100 }), null, 2))
      return
    }
    if (options.importExisting) { await importExisting(options, { library }); return }
    const controller = new AbortController()
    process.once('SIGINT', () => controller.abort(new Error('采集已停止')))
    process.once('SIGTERM', () => controller.abort(new Error('采集已停止')))
    const session = await readSession()
    const dependencies = { library, client: createClient({ session, signal: controller.signal }), signal: controller.signal }
    if (options.allProjects) {
      const report = await collectAll(options, dependencies)
      const incomplete = report.projects.filter(project => ['incomplete', 'failed'].includes(project.status))
      console.log(`已遍历 ${report.projects.length} 个项目、${report.projects.reduce((sum, project) => sum + project.totalClips, 0)} 个分镜、${report.projects.reduce((sum, project) => sum + project.downloaded, 0)} 个视频；${incomplete.length} 个项目未完整完成。`)
      const warnings = report.projects.reduce((sum, project) => sum + project.metadataWarnings, 0)
      if (warnings) console.log(`${warnings} 个分镜的接口总数与可见素材数不一致，详情已保存到分镜元数据和批次报告。`)
      console.log(`素材数据库：${library.databasePath}`)
      if (incomplete.length) process.exitCode = 1
      return
    }
    const manifest = await collect(options, dependencies)
    const downloads = manifest.clips.flatMap(clip => clip.candidates.slice(0, TOP)).filter(candidate => candidate.download?.status === 'done')
    const incomplete = manifest.clips.filter(clip => clip.status !== 'done')
    console.log(`已保存 ${manifest.clips.length} 个分镜的信息、${downloads.length} 个视频。目录：${options.output}`)
    if (!options.metadataOnly && incomplete.length) {
      console.error(`${incomplete.length} 个分镜未完整完成，请按原命令重试。`)
      process.exitCode = 1
    }
    console.log(`素材数据库：${library.databasePath}`)
  } finally { library.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
