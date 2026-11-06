import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const execFileAsync = promisify(execFile)
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const readJson = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8'))

export function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, filename)
}

export async function fingerprint(filename) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export function localOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) throw new Error('Use a local HTTP application origin')
  return url.origin
}

export function parseScriptReference(value, origin = 'http://localhost:3013') {
  const raw = String(value ?? '')
  if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) {
    return { id: Number(raw), origin: localOrigin(origin), url: `${localOrigin(origin)}/history-scripts?script=${raw}` }
  }
  let url
  try { url = new URL(raw, localOrigin(origin)) } catch { throw new Error('Provide a history-scripts?script=<id> URL or a positive script ID') }
  const id = url.searchParams.get('script')
  if (url.pathname !== '/history-scripts' || url.searchParams.getAll('script').length !== 1
    || !/^[1-9]\d*$/.test(id ?? '') || !Number.isSafeInteger(Number(id))) {
    throw new Error('Provide a history-scripts?script=<id> URL or a positive script ID, not an episode reference')
  }
  return { id: Number(id), origin: localOrigin(url.origin), url: `${url.origin}/history-scripts?script=${id}` }
}

export async function api(origin, route, options = {}) {
  const response = await fetch(`${localOrigin(origin)}/api/v1${route}`, {
    ...options, signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', ...options.headers },
  })
  const result = await response.json()
  if (!response.ok || (result.code != null && ![0, 200, 201].includes(result.code))) {
    throw new Error(`API ${route}: ${result.message || response.status}`)
  }
  return result.data
}

export function validatePackaging(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Packaging must be a JSON object')
  for (const key of ['title', 'opening_hook']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`Packaging requires ${key}`)
  }
  const design = input.cover_design
  const mainLength = Array.from(design?.main_title || '').length
  if (mainLength < 6 || mainLength > 8) throw new Error('Cover main_title must contain 6-8 characters')
  if (Array.from(design.sub_title || '').length > 4) throw new Error('Cover sub_title must not exceed 4 characters')
  const platforms = input.platforms
  if (!platforms || !Object.keys(platforms).length) throw new Error('Packaging requires platform copy')
  for (const name of Object.keys(platforms)) {
    if (!['baijiahao', 'wechat'].includes(name)) throw new Error(`Unsupported platform: ${name}`)
    if (typeof platforms[name].description !== 'string' || !platforms[name].description.trim()) {
      throw new Error(`${name} requires a nonempty description`)
    }
  }
  if (platforms.baijiahao && Array.from(platforms.baijiahao.description).length > 50) {
    throw new Error('Baijiahao description exceeds the conservative 50-character preflight limit; supply a short version')
  }
  if (platforms.wechat) {
    if (!platforms.wechat.title?.trim() || Array.from(platforms.wechat.title).length > 16) throw new Error('WeChat title requires 1-16 characters')
  }
  return input
}

export async function probeVideo(filename) {
  if (!path.isAbsolute(filename)) throw new Error('External video must be an absolute local path')
  const realPath = await fs.promises.realpath(filename)
  if (!(await fs.promises.stat(realPath)).isFile()) throw new Error('External video is not a file')
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate',
    '-of', 'json', realPath,
  ], { maxBuffer: 1024 * 1024 })
  const probe = JSON.parse(stdout)
  const duration = Number(probe.format?.duration)
  if (!probe.streams?.some((stream) => stream.codec_type === 'video') || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('External video has no readable video stream or duration')
  }
  return { path: realPath, sha256: await fingerprint(realPath), duration_seconds: duration, ...probe }
}

export function packageIdentity(sourceId, scriptHash, videoHash, packagingHash) {
  return `history-${sourceId}-${sha256(JSON.stringify([sourceId, scriptHash, videoHash, packagingHash])).slice(0, 20)}`
}

export function loadPackage(directory) {
  const dir = path.resolve(directory)
  const state = readJson(path.join(dir, 'state.json'))
  const packaging = validatePackaging(readJson(path.join(dir, 'publishing-package.json')))
  if (sha256(JSON.stringify(packaging)) !== state.packaging_sha256) throw new Error('Frozen packaging changed; prepare a new package')
  const script = fs.readFileSync(path.join(dir, 'production-script.txt'), 'utf8')
  if (sha256(script) !== state.script_sha256) throw new Error('Frozen production script changed')
  const video = readJson(path.join(dir, 'video-reference.json'))
  if (video.sha256 !== state.video_sha256 || packageIdentity(state.history_source_id, state.script_sha256, video.sha256, state.packaging_sha256) !== state.package_id) {
    throw new Error('Video reference does not match the frozen package identity')
  }
  return { dir, state, packaging, video }
}

export async function verifyVideo(video) {
  if (await fingerprint(video.path) !== video.sha256) throw new Error('Video fingerprint changed; do not reuse this package or upload session')
}

export async function withPackageLock(directory, action) {
  const filename = path.join(path.resolve(directory), '.operation-lock')
  let handle
  try { handle = fs.openSync(filename, 'wx') } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Package is locked: ${filename}. Check its PID before recovering an interrupted run.`)
    throw error
  }
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }))
  try { return await action() } finally { fs.closeSync(handle); fs.unlinkSync(filename) }
}

export function isMain(meta) { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(meta) }
export function fail(error) { process.stderr.write(`[history-video-publish] ${error.message}\n`); process.exitCode = 1 }
