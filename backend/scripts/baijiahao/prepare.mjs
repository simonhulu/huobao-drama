#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { loadEpisodeFromDb } from '../publish-episode-reference.mjs'
import { VIDEO_TITLE_SYMBOL_RULE, normalizeVideoTitle, hasSupportedVideoTitleSymbols } from '../../src/services/video-title-format.js'

const execFileAsync = promisify(execFile)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LANDSCAPE_COVER = { width: 1280, height: 720, ratio: '16:9' }
const PORTRAIT_COVER = { width: 900, height: 1200, ratio: '3:4' }

function parseArgs(argv) {
  const options = {}
  const valueFlags = new Set(['--video', '--title', '--description', '--work-description', '--cover', '--portrait-cover', '--db', '--output'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (valueFlags.has(arg)) {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      const key = arg === '--portrait-cover' ? 'portraitCover' : arg === '--work-description' ? 'workDescription' : arg.slice(2)
      options[key] = argv[++index]
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`)
    } else if (!options.reference) {
      options.reference = arg
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }
  return options
}

function insideDirectory(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function readableFile(filename, label) {
  if (!filename) throw new Error(`${label} path is required`)
  try {
    await fs.promises.access(filename, fs.constants.R_OK)
    const stat = await fs.promises.stat(filename)
    if (!stat.isFile() || stat.size === 0) throw new Error('not a nonempty regular file')
    return await fs.promises.realpath(filename)
  } catch (error) {
    throw new Error(`${label} file is missing or unreadable: ${filename}`, { cause: error })
  }
}

async function resolveVideoSource(value, projectRoot, fromDb) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('Video path is required; render the episode before publishing')
  let local = raw
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw) || raw.startsWith('//')) {
    if (!fromDb) throw new Error('--video must be a local file, not a URL')
    let url
    try { url = new URL(raw) } catch { throw new Error(`Unsupported video URL: ${raw}`) }
    if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.port !== '3013'
      || url.username || url.password
      || !/^\/(?:static\/|data\/static\/)/u.test(url.pathname)) {
      throw new Error(`Only known local frontend static URLs can resolve to files: ${raw}`)
    }
    try { local = decodeURIComponent(url.pathname) } catch { throw new Error(`Invalid video URL path: ${raw}`) }
  }

  const relative = local.replace(/^\/+/, '')
  if (fromDb && /^(?:static\/|data\/)/u.test(relative)) {
    const dataRoot = path.join(projectRoot, 'data')
    const candidate = path.resolve(projectRoot, relative.startsWith('data/') ? relative : `data/${relative}`)
    if (!insideDirectory(dataRoot, candidate)) throw new Error(`Video path escapes the data directory: ${raw}`)
    const filename = await readableFile(candidate, 'Video')
    const realDataRoot = await fs.promises.realpath(dataRoot)
    if (!insideDirectory(realDataRoot, filename)) throw new Error(`Video file escapes the data directory: ${raw}`)
    return filename
  }
  if (fromDb && !path.isAbsolute(local)) throw new Error(`Unsupported relative database video path: ${raw}`)
  return readableFile(path.resolve(local), 'Video')
}

async function fingerprint(filename) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function probeVideo(filename) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filename,
  ], { maxBuffer: 1024 * 1024 })
  const result = JSON.parse(stdout)
  const duration = Number(result.format?.duration)
  if (!result.streams?.some((stream) => stream.codec_type === 'video')
    || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Video has no readable video stream or duration: ${filename}`)
  }
  return duration
}

async function validateCover(filename, target = LANDSCAPE_COVER) {
  const local = await readableFile(filename, 'Cover')
  const metadata = await sharp(local).metadata()
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation)
  const width = swapsAxes ? metadata.height : metadata.width
  const height = swapsAxes ? metadata.width : metadata.height
  const ratio = target.width / target.height
  if (!width || !height || Math.abs(width / height - ratio) / ratio > 0.01) {
    throw new Error(`Cover must have a ${target.ratio} aspect ratio: ${filename}`)
  }
  // Metadata alone can succeed on truncated images; decode before accepting.
  await sharp(local).rotate().raw().toBuffer()
  return local
}

function escapeXml(value) {
  return value.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
}

function coverOverlay(title, target) {
  const { width, height } = target
  const chars = Array.from(title.replace(/\s+/gu, ' ').trim())
  const padding = width >= height ? 64 : 72
  const maxWidth = width - padding * 2
  let fontSize = width >= height ? 64 : 78
  let lines
  let lineHeight
  do {
    const lineLength = Math.max(1, Math.floor(maxWidth / fontSize))
    lines = []
    for (let index = 0; index < chars.length; index += lineLength) {
      lines.push(chars.slice(index, index + lineLength).join(''))
    }
    lineHeight = Math.ceil(fontSize * 1.18)
    if (lineHeight * lines.length <= height * 0.52) break
    fontSize *= 0.9
  } while (fontSize > 1)
  const firstBaseline = height - padding - lineHeight * (lines.length - 1)
  const text = lines.map((line, index) => `<text x="${padding}" y="${firstBaseline + index * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`).join('')
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.55" stop-color="#000" stop-opacity="0.15"/><stop offset="1" stop-color="#000" stop-opacity="0.86"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#shade)"/>
    <g fill="#fff" stroke="#000" stroke-opacity="0.48" stroke-width="2" paint-order="stroke" font-family="PingFang SC,Hiragino Sans GB,Noto Sans CJK SC,Microsoft YaHei,sans-serif" font-weight="800" letter-spacing="0">${text}</g>
  </svg>`)
}

async function createCover(videoPath, videoFingerprint, title, duration, projectRoot, target = LANDSCAPE_COVER) {
  const signature = { version: 1, video_fingerprint: videoFingerprint, title, width: target.width, height: target.height, frame_time: duration <= 1 ? 0 : 1 }
  const key = createHash('sha256').update(JSON.stringify(signature)).digest('hex')
  const cacheDir = path.join(projectRoot, 'data/temp/baijiahao-covers/keyframe', key)
  const coverPath = path.join(cacheDir, `cover-${target.ratio.replace(':', 'x')}.png`)
  try { return await validateCover(coverPath, target) } catch { /* Rebuild a missing or damaged cached cover. */ }
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const staging = await fs.promises.mkdtemp(path.join(cacheDir, 'prepare-'))
  try {
    const framePath = path.join(staging, 'keyframe.jpg')
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error', '-ss', String(signature.frame_time), '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', framePath,
    ])
    const renderedPath = path.join(staging, 'cover.png')
    await sharp(framePath)
      .rotate()
      .resize(target.width, target.height, { fit: 'cover', position: 'attention' })
      .composite([{ input: coverOverlay(title, target) }])
      .png({ compressionLevel: 9 })
      .toFile(renderedPath)
    await validateCover(renderedPath, target)
    await fs.promises.rename(renderedPath, coverPath)
    return await validateCover(coverPath, target)
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true })
  }
}

export async function ensurePortraitCover(manifest, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT)
  let coverPath
  if (manifest.cover_portrait_path) {
    coverPath = await validateCover(manifest.cover_portrait_path, PORTRAIT_COVER)
  } else {
    const title = String(manifest.title || '').trim()
    if (!title) throw new Error('A nonempty title is required for the portrait cover')
    const videoPath = await resolveVideoSource(manifest.video_path, projectRoot, false)
    const videoFingerprint = await fingerprint(videoPath)
    if (videoFingerprint !== manifest.video_fingerprint) {
      throw new Error('Video fingerprint changed; cannot add a cover to the existing upload session')
    }
    const duration = await probeVideo(videoPath)
    coverPath = await createCover(videoPath, videoFingerprint, title, duration, projectRoot, PORTRAIT_COVER)
  }
  const coverFingerprint = await fingerprint(coverPath)
  if (manifest.cover_portrait_fingerprint && coverFingerprint !== manifest.cover_portrait_fingerprint) {
    throw new Error('Portrait cover fingerprint changed')
  }
  return { cover_portrait_path: coverPath, cover_portrait_fingerprint: coverFingerprint }
}

export async function prepareManifest(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT)
  if (options.video && options.reference) throw new Error('Use an episode reference or --video, not both')
  if (!options.video && !options.reference) throw new Error('Provide an episode id/URL or --video with --title')
  const episode = options.video ? null : loadEpisodeFromDb(options.reference, {
    projectRoot,
    dbPath: options.db ? path.resolve(options.db) : undefined,
    title: options.title,
  })
  const historyDelivery = episode?.source_type === 'history_script'
  const sourceTitle = String(options.title ?? (historyDelivery ? episode.baijiahao_title : episode?.title) ?? '').trim()
  const title = historyDelivery ? normalizeVideoTitle(sourceTitle) : sourceTitle
  if (!title) throw new Error('A nonempty title is required; use --title')
  const description = historyDelivery ? '' : String(options.description ?? episode?.description ?? '').trim()
  const sourceWorkDescription = String(options.workDescription
    ?? (historyDelivery ? title : options.description?.trim() || episode?.opening_hook || title)).trim()
  const workDescription = historyDelivery ? normalizeVideoTitle(sourceWorkDescription) : sourceWorkDescription
  if (!workDescription) throw new Error('A nonempty work description is required')
  if (historyDelivery) {
    for (const value of [title, workDescription]) {
      if (value.length > 40) throw new Error('百家号标题须为 1 至 40 字，请在脚本页面修改；不会自动截断')
      if (!hasSupportedVideoTitleSymbols(value)) throw new Error(VIDEO_TITLE_SYMBOL_RULE)
    }
  }
  const videoPath = await resolveVideoSource(options.video || episode?.video_path, projectRoot, !options.video)
  const duration = await probeVideo(videoPath)
  const videoFingerprint = await fingerprint(videoPath)
  for (const [flag, value] of [['--cover', options.cover], ['--portrait-cover', options.portraitCover]]) {
    if (value && (/^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith('//'))) {
      throw new Error(`${flag} must be a local file, not a URL`)
    }
  }
  const coverPath = options.cover
    ? await validateCover(path.resolve(options.cover))
    : episode?.source_type === 'history_script'
    ? await validateCover(await resolveVideoSource(episode.cover_16x9_src, projectRoot, true))
    : await createCover(videoPath, videoFingerprint, title, duration, projectRoot)
  const coverPortraitPath = options.portraitCover
    ? await validateCover(path.resolve(options.portraitCover), PORTRAIT_COVER)
    : episode?.source_type === 'history_script'
    ? await validateCover(await resolveVideoSource(episode.cover_3x4_src, projectRoot, true), PORTRAIT_COVER)
    : await createCover(videoPath, videoFingerprint, title, duration, projectRoot, PORTRAIT_COVER)
  const manifest = {
    platform: 'baijiahao',
    version: 1,
    title,
    description,
    work_description: workDescription,
    video_path: videoPath,
    video_fingerprint: videoFingerprint,
    cover_path: coverPath,
    cover_fingerprint: await fingerprint(coverPath),
    cover_portrait_path: coverPortraitPath,
    cover_portrait_fingerprint: await fingerprint(coverPortraitPath),
    ...(episode?.source_type === 'history_script'
      ? { source_type: 'history_script', history_source_id: episode.history_source_id }
      : episode ? { episode_id: episode.episode_id } : {}),
    session: randomUUID(),
    prepared_at: new Date().toISOString(),
  }
  const output = options.output
    ? path.resolve(options.output)
    : path.join(projectRoot, 'data/publish-manifests', `baijiahao-${episode?.history_source_id ? `history-${episode.history_source_id}` : episode?.episode_id || videoFingerprint}.json`)
  let canonicalOutput = output
  try { canonicalOutput = await fs.promises.realpath(output) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const dbPath = options.db ? path.resolve(options.db) : path.join(projectRoot, 'data/huobao_drama.db')
  let canonicalDb = dbPath
  try { canonicalDb = await fs.promises.realpath(dbPath) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if ([videoPath, coverPath, coverPortraitPath, canonicalDb].includes(canonicalOutput)) {
    throw new Error('Manifest output must not overwrite the video, cover, or database')
  }
  await fs.promises.mkdir(path.dirname(output), { recursive: true })
  const temporaryOutput = `${output}.${manifest.session}.tmp`
  try {
    await fs.promises.writeFile(temporaryOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await fs.promises.rename(temporaryOutput, output)
  } finally {
    await fs.promises.rm(temporaryOutput, { force: true })
  }
  return { ...manifest, manifest_path: output }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await prepareManifest(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(manifest)}\n`)
  } catch (error) {
    process.stderr.write(`[baijiahao] ${error.message}\n`)
    process.exitCode = error.exitCode || 1
  }
}
