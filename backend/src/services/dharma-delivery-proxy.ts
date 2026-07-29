/**
 * Deterministic delivery proxies for Dharma stock footage.
 *
 * Remotion only needs delivery-sized pixels. This service converts oversized
 * local source videos once, preserves the original, and lets later renders
 * reuse a validated 1280x720 H.264 proxy from a task-safe cache.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

export const DHARMA_DELIVERY_PROXY_WIDTH = 1280
export const DHARMA_DELIVERY_PROXY_HEIGHT = 720
export const DHARMA_DELIVERY_PROXY_CACHE_DIR = path.join(
  repoRoot,
  'data/static/remotion/stock/proxy/dharma-cache',
)

const DEFAULT_FFPROBE_BIN = fs.existsSync('/opt/homebrew/bin/ffprobe')
  ? '/opt/homebrew/bin/ffprobe'
  : 'ffprobe'
const DEFAULT_FFMPEG_BIN = fs.existsSync('/opt/homebrew/bin/ffmpeg')
  ? '/opt/homebrew/bin/ffmpeg'
  : 'ffmpeg'
const DELIVERY_PROXY_FILTER = [
  `scale=${DHARMA_DELIVERY_PROXY_WIDTH}:${DHARMA_DELIVERY_PROXY_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`,
  `pad=${DHARMA_DELIVERY_PROXY_WIDTH}:${DHARMA_DELIVERY_PROXY_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
  'setsar=1',
  'format=yuv420p',
].join(',')

export type DharmaDeliveryProxyEncoder = 'h264_videotoolbox' | 'libx264'
export type DharmaDeliveryProxyCacheStatus = 'source' | 'hit' | 'miss'

export interface DharmaVideoStreamProbe {
  codecType?: string
  codecName?: string
  width?: number
  height?: number
  pixelFormat?: string
}

export interface DharmaVideoProbe {
  streams: DharmaVideoStreamProbe[]
  durationSec?: number
}

export interface DharmaVideoDimensions {
  width: number
  height: number
}

export interface DharmaDeliveryProxyOptions {
  /** Override only for tests or a deliberately isolated deployment cache. */
  cacheDirectory?: string
  ffprobeBin?: string
  ffmpegBin?: string
  platform?: NodeJS.Platform
  /** Avoids capability probing when a caller already knows the encoder state. */
  hardwareEncoderAvailable?: boolean
  signal?: AbortSignal
}

export interface DharmaDeliveryProxyResult {
  /** Canonical real path of the local source file. */
  sourcePath: string
  /** Path that a delivery renderer should use. */
  deliveryPath: string
  /** Null when the original source is already at delivery resolution. */
  proxyPath: string | null
  cacheStatus: DharmaDeliveryProxyCacheStatus
  sourceDimensions: DharmaVideoDimensions
  /** Duration measured from the original media container. */
  sourceDurationSec: number
  /** Duration measured from the actual file Remotion will decode. */
  deliveryDurationSec: number
  cacheKey?: string
  /** Populated only when this invocation created the proxy. */
  encoder?: DharmaDeliveryProxyEncoder
}

interface CommandResult {
  stdout: string
  stderr: string
}

let defaultVideoToolboxAvailability: boolean | undefined

function commandFailure(command: string, args: string[], error: string): Error {
  return new Error(`${command} ${args[0] ?? ''} 失败：${error.slice(-1_000).trim() || '未知错误'}`)
}

function abortError(): Error {
  const error = new Error('Dharma delivery proxy 已取消')
  error.name = 'AbortError'
  return error
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborted = false
    let abortKillTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (abortKillTimer) clearTimeout(abortKillTimer)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const abort = () => {
      if (aborted) return
      aborted = true
      child.kill('SIGTERM')
      // A wedged ffmpeg must not keep a long-task lease alive forever.
      abortKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 10_000)
    }
    const append = (current: string, value: unknown) => (current + String(value)).slice(-64 * 1024)

    child.stdout?.on('data', (value) => { stdout = append(stdout, value) })
    child.stderr?.on('data', (value) => { stderr = append(stderr, value) })
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, childSignal) => {
      if (aborted || signal?.aborted) {
        finish(() => reject(abortError()))
      } else if (code === 0) {
        finish(() => resolve({ stdout, stderr }))
      } else {
        finish(() => reject(commandFailure(command, args, stderr || `exit ${code ?? childSignal ?? 'unknown'}`)))
      }
    })
  })
}

function numberOrUndefined(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** Parses only the ffprobe fields this service relies on, making it easy to test without invoking ffprobe. */
export function parseDharmaVideoProbe(raw: string): DharmaVideoProbe | null {
  try {
    const parsed = JSON.parse(raw) as { streams?: unknown; format?: { duration?: unknown } }
    if (!Array.isArray(parsed.streams)) return null
    const duration = Number(parsed.format?.duration)
    return {
      streams: parsed.streams
        .filter((stream): stream is Record<string, unknown> => Boolean(stream) && typeof stream === 'object')
        .map((stream) => ({
          codecType: typeof stream.codec_type === 'string' ? stream.codec_type : undefined,
          codecName: typeof stream.codec_name === 'string' ? stream.codec_name : undefined,
          width: numberOrUndefined(stream.width),
          height: numberOrUndefined(stream.height),
          pixelFormat: typeof stream.pix_fmt === 'string' ? stream.pix_fmt : undefined,
        })),
      ...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
    }
  } catch {
    return null
  }
}

export function getDharmaVideoDimensions(probe: DharmaVideoProbe): DharmaVideoDimensions | null {
  const video = probe.streams.find((stream) => stream.codecType === 'video')
  if (!video || !(video.width && video.width > 0) || !(video.height && video.height > 0)) return null
  return { width: video.width, height: video.height }
}

/** A delivery proxy is needed if either axis exceeds the actual delivery canvas. */
export function isDharmaDeliveryProxyRequired(dimensions: DharmaVideoDimensions): boolean {
  return dimensions.width > DHARMA_DELIVERY_PROXY_WIDTH || dimensions.height > DHARMA_DELIVERY_PROXY_HEIGHT
}

/** Chrome delivery is deliberately constrained even when a source is small enough. */
export function isDharmaDeliverySourceChromeSafe(probe: DharmaVideoProbe): boolean {
  const dimensions = getDharmaVideoDimensions(probe)
  const video = probe.streams.find((stream) => stream.codecType === 'video')
  return Boolean(
    dimensions
    && !isDharmaDeliveryProxyRequired(dimensions)
    && video?.codecName?.toLowerCase() === 'h264'
    && video.pixelFormat?.toLowerCase() === 'yuv420p',
  )
}

/** Container timestamps differ slightly after encoding, but not by whole frames. */
export function isDharmaDeliveryDurationCompatible(sourceDurationSec: number, deliveryDurationSec: number): boolean {
  return Number.isFinite(sourceDurationSec)
    && sourceDurationSec > 0
    && Number.isFinite(deliveryDurationSec)
    && deliveryDurationSec > 0
    && Math.abs(sourceDurationSec - deliveryDurationSec) <= 0.25
}

/**
 * The cache is trusted only if it is exactly the format this service writes.
 * Re-probing is cheap and prevents an interrupted or manually edited file from
 * silently entering a render.
 */
export function isValidDharmaDeliveryProxy(probe: DharmaVideoProbe): boolean {
  if (probe.streams.length !== 1) return false
  const [video] = probe.streams
  return video.codecType === 'video'
    && video.codecName?.toLowerCase() === 'h264'
    && video.width === DHARMA_DELIVERY_PROXY_WIDTH
    && video.height === DHARMA_DELIVERY_PROXY_HEIGHT
    && video.pixelFormat?.toLowerCase() === 'yuv420p'
}

/** Cache identity deliberately follows the source path, file size, and mtime rather than source filename. */
export function buildDharmaDeliveryProxyCacheKey(realPath: string, size: number, mtimeMs: number): string {
  if (!realPath) throw new Error('Dharma delivery proxy 缺少源文件 realpath')
  if (!Number.isFinite(size) || size < 0) throw new Error(`Dharma delivery proxy 源文件大小无效：${size}`)
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw new Error(`Dharma delivery proxy 源文件 mtime 无效：${mtimeMs}`)
  return createHash('sha256')
    .update(`${realPath}\0${size}\0${mtimeMs}`)
    .digest('hex')
}

export function getDharmaDeliveryProxyPath(cacheDirectory: string, cacheKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new Error('Dharma delivery proxy cache key 无效')
  return path.join(path.resolve(cacheDirectory), `${cacheKey}.mp4`)
}

/** A cleanup guard: temporary files may only ever be direct children of the proxy cache. */
export function isDharmaDeliveryProxyCacheChild(cacheDirectory: string, candidatePath: string): boolean {
  return path.dirname(path.resolve(candidatePath)) === path.resolve(cacheDirectory)
}

function assertCacheChild(cacheDirectory: string, candidatePath: string): void {
  if (!isDharmaDeliveryProxyCacheChild(cacheDirectory, candidatePath)) {
    throw new Error(`拒绝操作 Dharma delivery proxy 缓存目录外的路径：${candidatePath}`)
  }
}

function removeTemporaryCacheFile(cacheDirectory: string, temporaryPath: string): void {
  assertCacheChild(cacheDirectory, temporaryPath)
  if (!path.basename(temporaryPath).startsWith('.')) {
    throw new Error(`拒绝清理非临时 Dharma delivery proxy 文件：${temporaryPath}`)
  }
  fs.rmSync(temporaryPath, { force: true })
}

function createTemporaryProxyPath(cacheDirectory: string, cacheKey: string, encoder: DharmaDeliveryProxyEncoder): string {
  const temporaryPath = path.join(cacheDirectory, `.${cacheKey}.${encoder}.${process.pid}.${randomUUID()}.tmp.mp4`)
  assertCacheChild(cacheDirectory, temporaryPath)
  return temporaryPath
}

/** The decoder preserves aspect ratio and pads to an exact delivery frame. */
export function buildDharmaDeliveryProxyFfmpegArgs(
  sourcePath: string,
  outputPath: string,
  encoder: DharmaDeliveryProxyEncoder,
): string[] {
  const encoderArgs = encoder === 'h264_videotoolbox'
    ? ['-c:v', encoder, '-b:v', '4M', '-maxrate', '5M', '-bufsize', '8M']
    : ['-c:v', encoder, '-preset', 'veryfast', '-crf', '21']
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-i', sourcePath,
    '-map', '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-vf', DELIVERY_PROXY_FILTER,
    ...encoderArgs,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ]
}

export function selectDharmaDeliveryProxyEncoders(
  platform: NodeJS.Platform | string,
  videoToolboxAvailable: boolean,
): DharmaDeliveryProxyEncoder[] {
  return platform === 'darwin' && videoToolboxAvailable
    ? ['h264_videotoolbox', 'libx264']
    : ['libx264']
}

async function probeDharmaVideoFile(filePath: string, ffprobeBin: string, signal?: AbortSignal): Promise<DharmaVideoProbe> {
  const result = await runCommand(ffprobeBin, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,pix_fmt',
    '-of', 'json',
    filePath,
  ], signal)
  const probe = parseDharmaVideoProbe(result.stdout)
  if (!probe) throw new Error(`ffprobe 返回了无效的视频元数据：${filePath}`)
  return probe
}

async function existingValidProxy(
  proxyPath: string,
  sourceDurationSec: number,
  ffprobeBin: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (!fs.existsSync(proxyPath)) return null
  try {
    const probe = await probeDharmaVideoFile(proxyPath, ffprobeBin, signal)
    const durationSec = probe.durationSec
    return isValidDharmaDeliveryProxy(probe)
      && durationSec !== undefined
      && isDharmaDeliveryDurationCompatible(sourceDurationSec, durationSec)
      ? durationSec
      : null
  } catch {
    return null
  }
}

async function detectVideoToolboxEncoder(ffmpegBin: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await runCommand(ffmpegBin, ['-hide_banner', '-encoders'], signal)
    return /(?:^|\s)h264_videotoolbox(?:\s|$)/m.test(`${result.stdout}\n${result.stderr}`)
  } catch {
    return false
  }
}

async function resolveVideoToolboxAvailability(
  options: DharmaDeliveryProxyOptions,
  platform: NodeJS.Platform,
  ffmpegBin: string,
): Promise<boolean> {
  if (platform !== 'darwin') return false
  if (options.hardwareEncoderAvailable !== undefined) return options.hardwareEncoderAvailable
  // The default encoder capability cannot vary within a process, so avoid
  // repeatedly spawning `ffmpeg -encoders` when an episode uses many clips.
  if (!options.ffmpegBin && defaultVideoToolboxAvailability !== undefined) return defaultVideoToolboxAvailability
  const available = await detectVideoToolboxEncoder(ffmpegBin, options.signal)
  if (!options.ffmpegBin) defaultVideoToolboxAvailability = available
  return available
}

function resolveSourceIdentity(sourcePath: string): { sourcePath: string; size: number; mtimeMs: number } {
  const absolutePath = path.resolve(sourcePath)
  let realPath: string
  let stat: fs.Stats
  try {
    realPath = fs.realpathSync.native(absolutePath)
    stat = fs.statSync(realPath)
  } catch (error) {
    throw new Error(`Dharma delivery proxy 找不到源视频：${absolutePath}（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (!stat.isFile()) throw new Error(`Dharma delivery proxy 源路径不是文件：${realPath}`)
  return { sourcePath: realPath, size: stat.size, mtimeMs: stat.mtimeMs }
}

/**
 * Returns an original local video when it already fits the delivery canvas;
 * otherwise returns a cached or newly created 1280x720 proxy. Original files
 * are never modified. Only fresh temporary files inside the cache are removed.
 */
export async function ensureDharmaDeliveryProxy(
  sourcePath: string,
  options: DharmaDeliveryProxyOptions = {},
): Promise<DharmaDeliveryProxyResult> {
  const cacheDirectory = path.resolve(options.cacheDirectory ?? DHARMA_DELIVERY_PROXY_CACHE_DIR)
  const ffprobeBin = options.ffprobeBin ?? process.env.DHARMA_FFPROBE_BIN ?? DEFAULT_FFPROBE_BIN
  const ffmpegBin = options.ffmpegBin ?? process.env.DHARMA_FFMPEG_BIN ?? DEFAULT_FFMPEG_BIN
  const platform = options.platform ?? process.platform
  const source = resolveSourceIdentity(sourcePath)
  const sourceProbe = await probeDharmaVideoFile(source.sourcePath, ffprobeBin, options.signal)
  const sourceDimensions = getDharmaVideoDimensions(sourceProbe)
  if (!sourceDimensions) throw new Error(`ffprobe 无法读取源视频尺寸：${source.sourcePath}`)
  const sourceDurationSec = sourceProbe.durationSec
  if (sourceDurationSec === undefined) throw new Error(`ffprobe 无法读取源视频时长：${source.sourcePath}`)

  if (isDharmaDeliverySourceChromeSafe(sourceProbe)) {
    return {
      sourcePath: source.sourcePath,
      deliveryPath: source.sourcePath,
      proxyPath: null,
      cacheStatus: 'source',
      sourceDimensions,
      sourceDurationSec,
      deliveryDurationSec: sourceDurationSec,
    }
  }

  const cacheKey = buildDharmaDeliveryProxyCacheKey(source.sourcePath, source.size, source.mtimeMs)
  fs.mkdirSync(cacheDirectory, { recursive: true })
  const proxyPath = getDharmaDeliveryProxyPath(cacheDirectory, cacheKey)
  assertCacheChild(cacheDirectory, proxyPath)
  const cachedDurationSec = await existingValidProxy(proxyPath, sourceDurationSec, ffprobeBin, options.signal)
  if (cachedDurationSec !== null) {
    return {
      sourcePath: source.sourcePath,
      deliveryPath: proxyPath,
      proxyPath,
      cacheStatus: 'hit',
      sourceDimensions,
      sourceDurationSec,
      deliveryDurationSec: cachedDurationSec,
      cacheKey,
    }
  }

  const videoToolboxAvailable = await resolveVideoToolboxAvailability(options, platform, ffmpegBin)
  const encoders = selectDharmaDeliveryProxyEncoders(platform, videoToolboxAvailable)
  const failures: string[] = []

  for (const encoder of encoders) {
    const temporaryPath = createTemporaryProxyPath(cacheDirectory, cacheKey, encoder)
    try {
      await runCommand(
        ffmpegBin,
        buildDharmaDeliveryProxyFfmpegArgs(source.sourcePath, temporaryPath, encoder),
        options.signal,
      )
      const temporaryProbe = await probeDharmaVideoFile(temporaryPath, ffprobeBin, options.signal)
      if (!isValidDharmaDeliveryProxy(temporaryProbe)
        || temporaryProbe.durationSec === undefined
        || !isDharmaDeliveryDurationCompatible(sourceDurationSec, temporaryProbe.durationSec)) {
        throw new Error(`编码器 ${encoder} 未生成有效的 1280x720 H.264 yuv420p video-only 文件`)
      }

      // Another task may have won the race while this task encoded. Preserve its
      // validated result and only discard this task's private temp file.
      const racedDurationSec = await existingValidProxy(proxyPath, sourceDurationSec, ffprobeBin, options.signal)
      if (racedDurationSec !== null) {
        removeTemporaryCacheFile(cacheDirectory, temporaryPath)
        return {
          sourcePath: source.sourcePath,
          deliveryPath: proxyPath,
          proxyPath,
          cacheStatus: 'hit',
          sourceDimensions,
          sourceDurationSec,
          deliveryDurationSec: racedDurationSec,
          cacheKey,
        }
      }

      assertCacheChild(cacheDirectory, temporaryPath)
      assertCacheChild(cacheDirectory, proxyPath)
      fs.renameSync(temporaryPath, proxyPath)
      return {
        sourcePath: source.sourcePath,
        deliveryPath: proxyPath,
        proxyPath,
        cacheStatus: 'miss',
        sourceDimensions,
        sourceDurationSec,
        deliveryDurationSec: temporaryProbe.durationSec,
        cacheKey,
        encoder,
      }
    } catch (error) {
      try {
        if (fs.existsSync(temporaryPath)) removeTemporaryCacheFile(cacheDirectory, temporaryPath)
      } catch (cleanupError) {
        failures.push(`清理 ${encoder} 临时文件失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
      if (error instanceof Error && error.name === 'AbortError') throw error
      failures.push(`${encoder}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(
    `无法创建 Dharma delivery proxy：${source.sourcePath}。${failures.join('；') || '没有可用的 H.264 编码器'}`,
  )
}
