/**
 * 佛学/哲学口播渲染任务处理器：
 * dharma.episode_render —— DharmaEpisode 合成整集 mp4（BGM 在 Remotion 内单轨混音，
 * 不做 ffmpeg 后混；输出即交付文件）。
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { registerTaskHandler } from '../registry.js'
import {
  buildDharmaEpisodeInputFingerprint,
  buildDharmaProps,
  compileDharmaProductionPlan,
  DHARMA_REVIEW_PILOT_DURATION_SEC,
  DHARMA_MEDIA_DURATION_PROBE_MAX_RUNTIME_MS,
  isDharmaReviewPilotDuration,
  isDharmaReviewPilotOutputDuration,
  runDharmaMediaProbeProcess,
} from '../../dharma-props.js'
import { db, schema } from '../../../db/index.js'
import { and, eq, isNull } from 'drizzle-orm'
import type { TaskContext, TaskHandler } from '../types.js'
import { claimTaskCommitPoint, mutateClaimedTaskCommit } from '../store.js'
import {
  parseDharmaRenderPayload,
  resolveDharmaRenderArtifact as resolveSharedDharmaRenderArtifact,
} from '../../dharma-render-payload.js'
import {
  getDharmaProductionGate,
  recordDharmaCanaryRendered,
  setDharmaProductionGateMetadata,
} from '../../dharma-production-gate.js'
import {
  getDharmaCanaryRenderAdmission,
  getDharmaFormalRenderAdmission,
} from '../../dharma-production-admission.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../../..')
const REMOTION_DIR = path.join(repoRoot, 'remotion')
const REMOTION_CLI = path.join(REMOTION_DIR, 'node_modules/.bin/remotion')
const DEFAULT_DHARMA_CHROME_EXECUTABLE = '../.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const REMOTION_HARDWARE_ACCELERATION = process.platform === 'darwin' ? 'required' : 'if-possible'
const REMOTION_STAGING_DIR = path.join(repoRoot, 'data/static/remotion/.staging')
const FFPROBE_BIN = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe'
const DEFAULT_REMOTION_DHARMA_CONCURRENCY = 4
const MAX_REMOTION_DHARMA_CONCURRENCY = 8
const DEFAULT_DHARMA_DELIVERY_PROXY_CONCURRENCY = 2
const MAX_DHARMA_DELIVERY_PROXY_CONCURRENCY = 4
const REMOTION_ABORT_GRACE_MS = 10_000
const DEFAULT_REMOTION_DHARMA_MAX_RUNTIME_MS = 40 * 60 * 1000
const DEFAULT_REMOTION_DHARMA_PROGRESS_STALL_MS = 3 * 60 * 1000
const DEFAULT_DHARMA_PROPS_BUILD_MAX_RUNTIME_MS = 15 * 60 * 1000
const MIN_REMOTION_DHARMA_WATCHDOG_MS = 60 * 1000
const MAX_REMOTION_DHARMA_WATCHDOG_MS = 90 * 60 * 1000
const MIN_REMOTION_DHARMA_OUTPUT_STALL_MS = 5 * 60 * 1000

interface DharmaEpisodeRenderPayload {
  episode_id?: number
  episodeId?: number
  only_storyboard_ids?: number[]
  onlyStoryboardIds?: number[]
  max_duration_sec?: number
  maxDurationSec?: number
  review_kind?: 'canary'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  const error = new Error('DharmaEpisode 渲染已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

/**
 * Prefer an operator-provided browser and retain the local Apple Silicon
 * convenience path when it is actually present. On other hosts Remotion's own
 * browser resolver is more portable than a hard-coded macOS binary path.
 */
export function resolveDharmaBrowserExecutable(
  rawValue = process.env.REMOTION_BROWSER_EXECUTABLE,
  platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync,
): string | null {
  const configured = rawValue?.trim()
  if (configured) {
    const executable = path.resolve(configured)
    if (!exists(executable)) throw new Error(`REMOTION_BROWSER_EXECUTABLE 不存在或不可执行：${executable}`)
    return executable
  }
  const localAppleSiliconBrowser = path.resolve(REMOTION_DIR, DEFAULT_DHARMA_CHROME_EXECUTABLE)
  return platform === 'darwin' && exists(localAppleSiliconBrowser) ? localAppleSiliconBrowser : null
}

/** Reject publishing a render made against inputs that have since changed. */
export function assertDharmaRenderInputFingerprintStable(expected: string, current: string): void {
  if (!expected || expected !== current) {
    throw new Error('素材、旁白、BGM 或标题在渲染期间发生变化；已拒绝发布，请重新试渲/渲染')
  }
}

function availableCpuCount(): number {
  const count = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

/**
 * Keep the render pool deliberately below the available CPU count. Remotion
 * already rejects values above its own maximum, but failing here gives the
 * task a clear configuration error before a multi-minute render starts.
 */
export function resolveDharmaRenderConcurrency(
  rawValue = process.env.REMOTION_DHARMA_CONCURRENCY,
  cpuCount = availableCpuCount(),
): number {
  const usableCpuCount = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1
  const maximum = Math.max(1, Math.min(MAX_REMOTION_DHARMA_CONCURRENCY, usableCpuCount))
  if (rawValue === undefined) return Math.min(DEFAULT_REMOTION_DHARMA_CONCURRENCY, maximum)

  const value = rawValue.trim()
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`REMOTION_DHARMA_CONCURRENCY 必须是 1-${maximum} 的整数，当前值为 ${JSON.stringify(rawValue)}`)
  }
  const concurrency = Number(value)
  if (concurrency > maximum) {
    throw new Error(`REMOTION_DHARMA_CONCURRENCY=${concurrency} 超出安全上限 ${maximum}（本机可用 CPU：${usableCpuCount}）`)
  }
  return concurrency
}

/** Proxying competes for decode/encode resources, so it intentionally runs below render concurrency. */
export function resolveDharmaDeliveryProxyConcurrency(
  rawValue = process.env.DHARMA_DELIVERY_PROXY_CONCURRENCY,
  cpuCount = availableCpuCount(),
): number {
  const usableCpuCount = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1
  const maximum = Math.max(1, Math.min(MAX_DHARMA_DELIVERY_PROXY_CONCURRENCY, Math.floor(usableCpuCount / 2) || 1))
  if (rawValue === undefined) return Math.min(DEFAULT_DHARMA_DELIVERY_PROXY_CONCURRENCY, maximum)
  const value = rawValue.trim()
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`DHARMA_DELIVERY_PROXY_CONCURRENCY 必须是 1-${maximum} 的整数，当前值为 ${JSON.stringify(rawValue)}`)
  }
  const concurrency = Number(value)
  if (concurrency > maximum) {
    throw new Error(`DHARMA_DELIVERY_PROXY_CONCURRENCY=${concurrency} 超出安全上限 ${maximum}（本机可用 CPU：${usableCpuCount}）`)
  }
  return concurrency
}

export interface DharmaRenderWatchdogConfig {
  maxRuntimeMs: number
  progressStallMs: number
}

function resolveDharmaWatchdogDuration(
  rawValue: string | undefined,
  name: string,
  fallback: number,
): number {
  if (rawValue === undefined) return fallback
  if (!/^\d+$/.test(rawValue.trim())) {
    throw new Error(`${name} 必须是 ${MIN_REMOTION_DHARMA_WATCHDOG_MS}-${MAX_REMOTION_DHARMA_WATCHDOG_MS} 毫秒的整数，当前值为 ${JSON.stringify(rawValue)}`)
  }
  const value = Number(rawValue)
  if (value < MIN_REMOTION_DHARMA_WATCHDOG_MS || value > MAX_REMOTION_DHARMA_WATCHDOG_MS) {
    throw new Error(`${name}=${value} 超出安全范围 ${MIN_REMOTION_DHARMA_WATCHDOG_MS}-${MAX_REMOTION_DHARMA_WATCHDOG_MS}ms`)
  }
  return value
}

/** A render that stops emitting usable frames must fail instead of renewing its lease forever. */
export function resolveDharmaRenderWatchdogConfig(
  maxRuntimeRaw = process.env.REMOTION_DHARMA_MAX_RUNTIME_MS,
  progressStallRaw = process.env.REMOTION_DHARMA_PROGRESS_STALL_MS,
): DharmaRenderWatchdogConfig {
  const maxRuntimeMs = resolveDharmaWatchdogDuration(
    maxRuntimeRaw,
    'REMOTION_DHARMA_MAX_RUNTIME_MS',
    DEFAULT_REMOTION_DHARMA_MAX_RUNTIME_MS,
  )
  const progressStallMs = resolveDharmaWatchdogDuration(
    progressStallRaw,
    'REMOTION_DHARMA_PROGRESS_STALL_MS',
    DEFAULT_REMOTION_DHARMA_PROGRESS_STALL_MS,
  )
  if (progressStallMs >= maxRuntimeMs) {
    throw new Error('REMOTION_DHARMA_PROGRESS_STALL_MS 必须小于 REMOTION_DHARMA_MAX_RUNTIME_MS')
  }
  return { maxRuntimeMs, progressStallMs }
}

/** Props building can transcode source footage, so it needs its own deadline. */
export function resolveDharmaPropsBuildMaxRuntime(
  rawValue = process.env.DHARMA_PROPS_BUILD_MAX_RUNTIME_MS,
): number {
  return resolveDharmaWatchdogDuration(
    rawValue,
    'DHARMA_PROPS_BUILD_MAX_RUNTIME_MS',
    DEFAULT_DHARMA_PROPS_BUILD_MAX_RUNTIME_MS,
  )
}

/** Encoding starts after the last frame report, so it needs an output-aware grace period. */
export function resolveDharmaRemotionOutputStallMs(progressStallMs: number): number {
  return Math.max(MIN_REMOTION_DHARMA_OUTPUT_STALL_MS, progressStallMs * 2)
}

export interface RemotionRenderProgress {
  current: number
  total: number
}

/** Parse Remotion CLI's stable `Rendered N/T` progress line. */
export function parseRemotionRenderProgress(line: string): RemotionRenderProgress | null {
  const plain = line.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  const match = plain.match(/\bRendered\s+(\d+)\s*\/\s*(\d+)\b/i)
  if (!match) return null
  const current = Number(match[1])
  const total = Number(match[2])
  if (!Number.isInteger(current) || !Number.isInteger(total) || current < 0 || total <= 0 || current > total) return null
  return { current, total }
}

export interface DharmaRenderArtifact {
  fileStem: string
  isPreview: boolean
  isReviewPilot: boolean
}

/** Every render has an immutable task-specific artifact; previews also never update episode.videoUrl. */
export function resolveDharmaRenderArtifact(
  episodeId: number,
  taskId: number,
  maxDurationSec: number | undefined,
  onlyStoryboardIds?: number[],
): DharmaRenderArtifact {
  const plan = parseDharmaRenderPayload({
    episode_id: episodeId,
    ...(onlyStoryboardIds?.length ? { only_storyboard_ids: onlyStoryboardIds } : {}),
    ...(Number.isFinite(maxDurationSec) && Number(maxDurationSec) > 0 ? { max_duration_sec: maxDurationSec } : {}),
  }, { mode: 'canonical', expectedEpisodeId: episodeId })
  if (!plan) throw new Error('Invalid canonical Dharma render artifact payload')
  return resolveSharedDharmaRenderArtifact(episodeId, taskId, plan)
}

function parseMetadataRecord(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function buildDharmaEpisodePublishPatch(
  currentMetadata: string | null | undefined,
  input: {
    kind: 'canary'
    taskId: number
    output: string
    fullPlanFingerprint: string
    canaryFingerprint: string
    renderedAt: string
  },
): { metadata: string } {
  const gate = getDharmaProductionGate(currentMetadata)
  if (!gate) throw new Error('canary 发布缺少当前生产门禁')
  const rendered = recordDharmaCanaryRendered(gate, {
    taskId: input.taskId,
    fingerprint: input.canaryFingerprint,
    output: input.output,
    renderedAt: input.renderedAt,
  })
  return { metadata: setDharmaProductionGateMetadata(currentMetadata, rendered) }
}

type StageData = Record<string, unknown>

const DHARMA_RENDER_STAGE_PROGRESS_MESSAGES: Record<string, string> = {
  preflight: 'DharmaEpisode 渲染：前置检查',
  configuration: 'DharmaEpisode 渲染：读取运行配置',
  props_build: 'DharmaEpisode 渲染：准备素材与合成参数',
  input_fingerprint_pre_render: 'DharmaEpisode 渲染：核对输入版本',
  staging_prepare: 'DharmaEpisode 渲染：准备交付暂存区',
  remotion_render: 'DharmaEpisode 渲染：启动帧渲染',
  output_validation: 'DharmaEpisode 渲染：校验交付文件',
  publish: 'DharmaEpisode 渲染：发布成片',
}

export function dharmaRenderStageProgressMessage(stage: string): string | null {
  return DHARMA_RENDER_STAGE_PROGRESS_MESSAGES[stage] ?? null
}

async function runTimedStage<T>(
  ctx: TaskContext<any>,
  stage: string,
  action: () => T | Promise<T>,
  startedData: StageData = {},
  completedData?: (result: T) => StageData,
): Promise<T> {
  const startedAt = Date.now()
  const progressMessage = dharmaRenderStageProgressMessage(stage)
  if (progressMessage) ctx.progress(progressMessage)
  ctx.event('dharma.episode.render.stage', {
    stage,
    status: 'started',
    at: new Date(startedAt).toISOString(),
    ...startedData,
  })
  try {
    const result = await action()
    ctx.event('dharma.episode.render.stage', {
      stage,
      status: 'completed',
      elapsed_ms: Date.now() - startedAt,
      ...(completedData?.(result) ?? {}),
    })
    return result
  } catch (error) {
    ctx.event('dharma.episode.render.stage', {
      stage,
      status: ctx.signal.aborted ? 'canceled' : 'failed',
      elapsed_ms: Date.now() - startedAt,
      error: errorMessage(error),
    })
    throw error
  }
}

/**
 * Props construction includes ffmpeg proxy work. Propagate a deadline through
 * its AbortSignal so a stuck transcode is killed instead of renewing a worker
 * lease indefinitely.
 */
export async function runDharmaPropsBuildWithDeadline<T>(
  ctx: Pick<TaskContext<any>, 'signal' | 'event'>,
  maxRuntimeMs: number,
  action: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timeoutError = () => new Error(`Dharma props 构建超过 ${maxRuntimeMs}ms 时限；请检查 proxy 转码或素材文件`)
  const abortFromParent = () => controller.abort(ctx.signal.reason)
  if (ctx.signal.aborted) abortFromParent()
  else ctx.signal.addEventListener('abort', abortFromParent, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    ctx.event('dharma.episode.render.watchdog', {
      scope: 'props_build',
      reason: 'runtime_limit',
      max_runtime_ms: maxRuntimeMs,
      signal: 'SIGTERM',
    })
    controller.abort(timeoutError())
  }, maxRuntimeMs)
  try {
    const result = await action(controller.signal)
    if (timedOut) throw timeoutError()
    return result
  } catch (error) {
    if (timedOut) throw timeoutError()
    throw error
  } finally {
    clearTimeout(timeout)
    ctx.signal.removeEventListener('abort', abortFromParent)
  }
}

function createTaskStagingDirectory(episodeId: number, taskId: number): string {
  fs.mkdirSync(REMOTION_STAGING_DIR, { recursive: true })
  return fs.mkdtempSync(path.join(REMOTION_STAGING_DIR, `dharma-ep${episodeId}-task${taskId}-`))
}

function cleanupTaskStagingDirectory(stagingDir: string): void {
  // Only delete the uniquely-created direct child, never the shared staging root.
  if (path.dirname(path.resolve(stagingDir)) !== path.resolve(REMOTION_STAGING_DIR)) {
    throw new Error(`拒绝清理任务暂存目录外的路径：${stagingDir}`)
  }
  fs.rmSync(stagingDir, { recursive: true, force: true })
}

function cleanupUnpublishedDharmaOutput(outputPath: string, deliveryRoot: string): void {
  if (path.dirname(path.resolve(outputPath)) !== deliveryRoot) {
    throw new Error(`拒绝清理 Dharma 交付目录外的路径：${outputPath}`)
  }
  fs.rmSync(outputPath, { force: true })
}

/**
 * Keep the render private until the fenced pointer transaction has admitted
 * it. A failed CAS leaves the file in staging; a DB failure after rename
 * removes the otherwise orphaned task-specific output.
 */
export function publishDharmaOutputWithPointerCommit(
  stagedOutputPath: string,
  finalPath: string,
  commitPointer: (moveOutput: () => void) => boolean,
  deliveryRoot = path.resolve(repoRoot, 'data/static/remotion'),
): boolean {
  let outputMoved = false
  try {
    const committed = commitPointer(() => {
      if (fs.existsSync(finalPath)) {
        throw new Error(`Dharma task-specific output already exists: ${finalPath}`)
      }
      fs.renameSync(stagedOutputPath, finalPath)
      outputMoved = true
    })
    if (!committed && outputMoved) cleanupUnpublishedDharmaOutput(finalPath, deliveryRoot)
    return committed
  } catch (error) {
    if (outputMoved) cleanupUnpublishedDharmaOutput(finalPath, deliveryRoot)
    throw error
  }
}

interface RenderOutputProbe {
  durationSec: number
  sizeBytes: number
  videoCodec: string
  audioCodec: string
  width: number
  height: number
  frameRate: number
  frameCount: number
  audioStreamCount: number
}

interface DharmaRenderedOutputStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  nb_frames?: string
}

interface DharmaRenderedOutputMediaProbe {
  format?: { duration?: string }
  streams?: DharmaRenderedOutputStream[]
}

function parseDharmaFrameRate(raw: string | undefined): number | null {
  const match = raw?.match(/^(\d+)\/(\d+)$/)
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  const frameRate = numerator / denominator
  return Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null
}

function parseDharmaFrameCount(raw: string | undefined): number | null {
  const frameCount = Number(raw)
  return Number.isSafeInteger(frameCount) && frameCount > 0 ? frameCount : null
}

/** Delivery contract kept separate from ffprobe I/O so unsupported streams cannot be published. */
export function validateDharmaRenderedOutputContract(
  probe: DharmaRenderedOutputMediaProbe,
  expectedDurationFrames: number,
): Omit<RenderOutputProbe, 'sizeBytes'> {
  const durationSec = Number(probe.format?.duration)
  const videoStreams = probe.streams?.filter((stream) => stream.codec_type === 'video') ?? []
  const audioStreams = probe.streams?.filter((stream) => stream.codec_type === 'audio') ?? []
  const video = videoStreams[0]
  const audio = audioStreams[0]
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !video?.codec_name || !audio?.codec_name) {
    throw new Error('ffprobe 验证失败：输出必须包含有效时长、视频流和音频流')
  }
  if (videoStreams.length !== 1) throw new Error(`ffprobe 验证失败：交付必须只有一个视频流，当前 ${videoStreams.length} 个`)
  if (audioStreams.length !== 1) throw new Error(`ffprobe 验证失败：交付必须只有一个音频流，当前 ${audioStreams.length} 个`)
  if (video.codec_name !== 'h264') throw new Error(`ffprobe 验证失败：视频必须为 H.264，当前 ${video.codec_name}`)
  if (audio.codec_name !== 'aac') throw new Error(`ffprobe 验证失败：音频必须为 AAC，当前 ${audio.codec_name}`)
  if (video.width !== 1280 || video.height !== 720) {
    throw new Error(`ffprobe 验证失败：交付必须为 1280x720，当前 ${video.width ?? '?'}x${video.height ?? '?'}`)
  }
  const frameRate = parseDharmaFrameRate(video.r_frame_rate)
  if (frameRate === null || Math.abs(frameRate - 30) > 0.001) {
    throw new Error(`ffprobe 验证失败：交付必须为 30fps，当前 ${video.r_frame_rate ?? 'unknown'}`)
  }
  const frameCount = parseDharmaFrameCount(video.nb_frames)
  if (frameCount === null) throw new Error('ffprobe 验证失败：交付视频缺少可验证的帧数')
  if (frameCount !== expectedDurationFrames) {
    throw new Error(`ffprobe 验证失败：交付视频帧数 ${frameCount} 与合成帧数 ${expectedDurationFrames} 不一致`)
  }

  const expectedDurationSec = expectedDurationFrames / 30
  if (Math.abs(durationSec - expectedDurationSec) > 1.5) {
    throw new Error(`ffprobe 验证失败：输出时长 ${durationSec.toFixed(2)}s 与合成时长 ${expectedDurationSec.toFixed(2)}s 不一致`)
  }

  return {
    durationSec,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
    frameRate,
    frameCount,
    audioStreamCount: audioStreams.length,
  }
}

/**
 * Output validation happens after the expensive render, so it must still yield
 * to cancellation. This deliberately reuses the cancellable ffprobe runner
 * used by preflight and props construction instead of blocking Node with
 * execFileSync.
 */
export async function probeDharmaRenderedOutput(
  outputPath: string,
  signal?: AbortSignal,
  runner: typeof runDharmaMediaProbeProcess = runDharmaMediaProbeProcess,
): Promise<DharmaRenderedOutputMediaProbe> {
  const result = await runner(FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames',
    '-of', 'json',
    outputPath,
  ], {
    signal,
    timeoutMs: DHARMA_MEDIA_DURATION_PROBE_MAX_RUNTIME_MS,
  })
  if (signal?.aborted) throw abortError()
  if (!result || result.status !== 0) {
    const detail = result?.stderr.trim()
    throw new Error(`ffprobe 无法验证 Remotion 输出${detail ? `：${detail.slice(-500)}` : ''}`)
  }
  try {
    return JSON.parse(result.stdout) as DharmaRenderedOutputMediaProbe
  } catch (error) {
    throw new Error(`ffprobe 输出无法解析：${errorMessage(error)}`)
  }
}

async function validateRenderedOutput(
  outputPath: string,
  expectedDurationFrames: number,
  signal?: AbortSignal,
): Promise<RenderOutputProbe> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(outputPath)
  } catch {
    throw new Error(`Remotion 未写入输出文件：${outputPath}`)
  }
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Remotion 输出为空：${outputPath}`)

  const probe = await probeDharmaRenderedOutput(outputPath, signal)
  if (signal?.aborted) throw abortError()

  const contract = validateDharmaRenderedOutputContract(probe, expectedDurationFrames)
  return {
    sizeBytes: stat.size,
    ...contract,
  }
}

function terminateRemotionProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
    return true
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}

interface RemotionRenderResult {
  encoderEvidence: string
  elapsedMs: number
  progress: RemotionRenderProgress | null
}

async function runRemotionRender(
  propsPath: string,
  outputPath: string,
  concurrency: number,
  watchdog: DharmaRenderWatchdogConfig,
  ctx: TaskContext<any>,
): Promise<RemotionRenderResult> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  throwIfAborted(ctx.signal)
  const browserExecutable = resolveDharmaBrowserExecutable()
  const args = [
    'render',
    ...(browserExecutable ? [`--browser-executable=${browserExecutable}`] : []),
    'src/index.tsx',
    'DharmaEpisode',
    outputPath,
    '--codec=h264',
    `--hardware-acceleration=${REMOTION_HARDWARE_ACCELERATION}`,
    '--video-bitrate=1M',
    '--audio-bitrate=128K',
    '--log=verbose',
    `--concurrency=${concurrency}`,
    `--props=${propsPath}`,
  ]
  ctx.event('dharma.episode.render.browser', {
    executable: browserExecutable ?? 'remotion-managed',
  })
  ctx.progress(`启动 Remotion 渲染（DharmaEpisode，并发 ${concurrency}）`, 0, 1)

  return new Promise<RemotionRenderResult>((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(REMOTION_CLI, args, {
      cwd: REMOTION_DIR,
      env: process.env,
      // On POSIX this gives the render and its Chrome descendants their own
      // process group, so a task cancellation cannot leave a renderer behind.
      detached: process.platform !== 'win32',
    })
    let tail = ''
    let diagnostics = ''
    let lineRemainder = ''
    let currentPhase: string | null = null
    let latestProgress: RemotionRenderProgress | null = null
    let lastProgressUpdateAt = 0
    let lastProgressPercent = -1
    let lastProgressEventPercent = -1
    let abortTimer: ReturnType<typeof setTimeout> | null = null
    let watchdogTimer: ReturnType<typeof setInterval> | null = null
    let watchdogKillTimer: ReturnType<typeof setTimeout> | null = null
    let watchdogError: Error | null = null
    let lastActivityAt = startedAt
    let lastFrameProgressAt: number | null = null
    let settled = false
    let abortFromSignal: () => void = () => {}

    const cleanup = () => {
      if (abortTimer) clearTimeout(abortTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      if (watchdogKillTimer) clearTimeout(watchdogKillTimer)
      ctx.signal.removeEventListener('abort', abortFromSignal)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const setPhase = (phase: string, output: string) => {
      if (phase === currentPhase) return
      currentPhase = phase
      ctx.event('dharma.episode.render.remotion_stage', {
        stage: phase,
        elapsed_ms: Date.now() - startedAt,
        output: output.slice(0, 240),
      })
    }
    const reportProgress = (progress: RemotionRenderProgress) => {
      if (!latestProgress || progress.current > latestProgress.current) lastFrameProgressAt = Date.now()
      latestProgress = progress
      const now = Date.now()
      const percent = Math.floor((progress.current / progress.total) * 100)
      if (
        progress.current === progress.total
        || percent >= lastProgressPercent + 2
        || now - lastProgressUpdateAt >= 5_000
      ) {
        ctx.progress(`DharmaEpisode 渲染 ${progress.current}/${progress.total} 帧`, progress.current, progress.total)
        lastProgressUpdateAt = now
        lastProgressPercent = percent
      }
      if (progress.current === progress.total || percent >= lastProgressEventPercent + 10) {
        ctx.event('dharma.episode.render.progress', { ...progress, percent })
        lastProgressEventPercent = percent
      }
    }
    const handleLine = (line: string) => {
      const plain = line.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim()
      if (!plain) return
      if (/^Bundling\b/i.test(plain)) setPhase('bundle', plain)
      else if (/^Getting composition\b/i.test(plain)) setPhase('composition', plain)
      else if (/^Encoding\b/i.test(plain)) setPhase('encode', plain)
      const progress = parseRemotionRenderProgress(plain)
      if (progress) {
        setPhase('frames', plain)
        reportProgress(progress)
      }
    }
    const capture = (data: unknown) => {
      lastActivityAt = Date.now()
      const chunk = String(data)
      tail = (tail + chunk).slice(-2000)
      diagnostics = (diagnostics + chunk).slice(-20000)
      const lines = (lineRemainder + chunk).split(/[\r\n]+/)
      lineRemainder = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
      // Remotion redraws progress on a terminal line; parse an unfinished line
      // as well so progress remains visible between carriage returns.
      handleLine(lineRemainder)
    }
    abortFromSignal = () => {
      if (settled || abortTimer) return
      const terminated = terminateRemotionProcessGroup(child, 'SIGTERM')
      ctx.event('dharma.episode.render.canceling', {
        signal: 'SIGTERM',
        process_group: process.platform !== 'win32',
        terminated,
      })
      abortTimer = setTimeout(() => {
        if (settled) return
        const killed = terminateRemotionProcessGroup(child, 'SIGKILL')
        ctx.event('dharma.episode.render.canceling', {
          signal: 'SIGKILL',
          process_group: process.platform !== 'win32',
          terminated: killed,
        })
      }, REMOTION_ABORT_GRACE_MS)
      abortTimer.unref?.()
    }

    const outputStallMs = resolveDharmaRemotionOutputStallMs(watchdog.progressStallMs)
    const stopForWatchdog = (reason: 'runtime_limit' | 'progress_stall' | 'startup_stall' | 'output_stall', elapsedMs: number) => {
      if (settled || watchdogError) return
      watchdogError = new Error(
        reason === 'runtime_limit'
          ? `Remotion 渲染超过总时长上限 ${watchdog.maxRuntimeMs}ms`
          : reason === 'output_stall'
            ? `Remotion 渲染输出阶段停滞超过 ${outputStallMs}ms`
            : `Remotion 渲染 ${reason === 'startup_stall' ? '启动' : '帧进度'}停滞超过 ${watchdog.progressStallMs}ms`,
      )
      const terminated = terminateRemotionProcessGroup(child, 'SIGTERM')
      ctx.event('dharma.episode.render.watchdog', {
        reason,
        elapsed_ms: elapsedMs,
        max_runtime_ms: watchdog.maxRuntimeMs,
        progress_stall_ms: watchdog.progressStallMs,
        output_stall_ms: outputStallMs,
        last_frame: latestProgress?.current ?? null,
        total_frames: latestProgress?.total ?? null,
        terminated,
      })
      watchdogKillTimer = setTimeout(() => {
        if (settled) return
        const killed = terminateRemotionProcessGroup(child, 'SIGKILL')
        ctx.event('dharma.episode.render.watchdog', { reason, signal: 'SIGKILL', terminated: killed })
      }, REMOTION_ABORT_GRACE_MS)
      watchdogKillTimer.unref?.()
    }

    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    watchdogTimer = setInterval(() => {
      const now = Date.now()
      const elapsedMs = now - startedAt
      if (elapsedMs >= watchdog.maxRuntimeMs) {
        stopForWatchdog('runtime_limit', elapsedMs)
      } else if (latestProgress && latestProgress.current === latestProgress.total) {
        // Frame progress legitimately stops before ffmpeg's final encode/mux.
        // At this point watch output activity, with a longer grace period, not
        // the frame-progress timer that guarded the Chrome render phase.
        if (now - lastActivityAt >= outputStallMs) stopForWatchdog('output_stall', elapsedMs)
      } else if (lastFrameProgressAt !== null && now - lastFrameProgressAt >= watchdog.progressStallMs) {
        stopForWatchdog('progress_stall', elapsedMs)
      } else if (lastFrameProgressAt === null && now - lastActivityAt >= watchdog.progressStallMs) {
        stopForWatchdog('startup_stall', elapsedMs)
      }
    }, 5_000)
    watchdogTimer.unref?.()
    if (ctx.signal.aborted) abortFromSignal()
    else ctx.signal.addEventListener('abort', abortFromSignal, { once: true })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, signal) => {
      if (ctx.signal.aborted) {
        finish(() => reject(abortError()))
      } else if (watchdogError) {
        finish(() => reject(watchdogError!))
      } else if (code === 0) {
        const encoderLine = diagnostics.match(/Encoder:[^\r\n]+/g)?.at(-1) || 'Encoder details unavailable'
        ctx.event('dharma.episode.render.encoder', {
          requested: REMOTION_HARDWARE_ACCELERATION,
          evidence: encoderLine.trim(),
        })
        if (latestProgress) ctx.progress(`DharmaEpisode 渲染完成（${latestProgress.current}/${latestProgress.total} 帧）`, latestProgress.current, latestProgress.total)
        else ctx.progress('DharmaEpisode 渲染完成', 1, 1)
        finish(() => resolve({
          encoderEvidence: encoderLine.trim(),
          elapsedMs: Date.now() - startedAt,
          progress: latestProgress,
        }))
      }
      else {
        finish(() => reject(new Error(`remotion render exit ${code ?? signal ?? 'unknown'}: ${tail.slice(-500)}`)))
      }
    })
  })
}

export function createDharmaEpisodeRenderHandler(): TaskHandler<DharmaEpisodeRenderPayload> {
  return {
    resumable: false,
    maxAttempts: 1,
    async run(ctx: TaskContext<DharmaEpisodeRenderPayload>) {
      const taskStartedAt = Date.now()
      const taskEpisodeId = ctx.episodeId
      if (typeof taskEpisodeId !== 'number' || !Number.isSafeInteger(taskEpisodeId) || taskEpisodeId <= 0) {
        throw new Error('Dharma render task is missing its durable episode_id')
      }
      const plan = parseDharmaRenderPayload(ctx.payload, { mode: 'canonical' })
      if (!plan) {
        throw new Error('Dharma render task payload must use canonical snake_case fields')
      }
      if (taskEpisodeId !== plan.payload.episode_id) {
        throw new Error(`Dharma render task episode_id mismatch: task=${taskEpisodeId}, payload=${plan.payload.episode_id}`)
      }
      const episodeId = plan.payload.episode_id
      const onlyStoryboardIds = plan.payload.only_storyboard_ids
      const maxDurationSec = plan.payload.max_duration_sec
      const artifact = resolveSharedDharmaRenderArtifact(episodeId, ctx.taskId, plan)
      const validationMode = artifact.isPreview
        && !artifact.isReviewCanary
        && Boolean(onlyStoryboardIds?.length)
        && isDharmaReviewPilotDuration(maxDurationSec)
        ? 'semantic_preview' as const
        : 'production' as const
      ctx.event('dharma.episode.render.started', {
        episode_id: episodeId,
        task_id: ctx.taskId,
        pilot: artifact.isReviewPilot,
        canary: artifact.isReviewCanary,
        preview: artifact.isPreview,
        max_duration_sec: maxDurationSec ?? null,
      })

      let stagingDir: string | null = null
      try {
        const preflight = await runTimedStage(ctx, 'preflight', async () => {
          throwIfAborted(ctx.signal)
          const compiledPlan = await compileDharmaProductionPlan(episodeId, {
            signal: ctx.signal,
            validationMode,
          })
          const ep = compiledPlan.episode
          const inputFingerprint = compiledPlan.fullPlanFingerprint
          let canaryFingerprint: string | undefined
          if (!artifact.isPreview) {
            const admission = getDharmaFormalRenderAdmission(episodeId)
            if (!admission.admission.allowed) {
              throw new Error(`整集渲染未通过生产门禁：${admission.admission.reason}`)
            }
          }
          if (artifact.isReviewCanary) {
            const canaryAdmission = getDharmaCanaryRenderAdmission(episodeId, {
              taskId: ctx.taskId,
              storyboardIds: onlyStoryboardIds ?? [],
              durationSec: maxDurationSec ?? 0,
            })
            if (!canaryAdmission.allowed || !canaryAdmission.currentCanaryFingerprint) {
              throw new Error(`canary 渲染未通过生产门禁：${canaryAdmission.reason}`)
            }
            canaryFingerprint = canaryAdmission.currentCanaryFingerprint
          }

          return {
            ep,
            compiledPlan,
            masterDuration: compiledPlan.narrationDurationSec,
            bgmDuration: compiledPlan.bgmDurationSec,
            inputFingerprint,
            ...(canaryFingerprint ? { canaryFingerprint } : {}),
            dharmaInputRevision: ep.dharmaInputRevision,
          }
        }, { episode_id: episodeId, pilot: artifact.isReviewPilot, canary: artifact.isReviewCanary, preview: artifact.isPreview }, ({ masterDuration, bgmDuration }) => ({
          master_duration_sec: masterDuration,
          bgm_duration_sec: bgmDuration,
        }))

        const configuration = await runTimedStage(ctx, 'configuration', () => {
          throwIfAborted(ctx.signal)
          return {
            renderConcurrency: resolveDharmaRenderConcurrency(),
            deliveryProxyConcurrency: resolveDharmaDeliveryProxyConcurrency(),
            watchdog: resolveDharmaRenderWatchdogConfig(),
            propsBuildMaxRuntimeMs: resolveDharmaPropsBuildMaxRuntime(),
          }
        }, { environment: 'REMOTION_DHARMA_CONCURRENCY,DHARMA_DELIVERY_PROXY_CONCURRENCY,DHARMA_PROPS_BUILD_MAX_RUNTIME_MS' }, (value) => ({
          render_concurrency: value.renderConcurrency,
          delivery_proxy_concurrency: value.deliveryProxyConcurrency,
          remotion_max_runtime_ms: value.watchdog.maxRuntimeMs,
          remotion_progress_stall_ms: value.watchdog.progressStallMs,
          props_build_max_runtime_ms: value.propsBuildMaxRuntimeMs,
        }))
        const concurrency = configuration.renderConcurrency

        const built = await runTimedStage(ctx, 'props_build', () => (
          runDharmaPropsBuildWithDeadline(ctx, configuration.propsBuildMaxRuntimeMs, (signal) => {
            throwIfAborted(signal)
            return buildDharmaProps(episodeId, {
              onlyStoryboardIds,
              maxDurationSec,
              validationMode,
              compiledPlan: preflight.compiledPlan,
              signal,
              deliveryProxyConcurrency: configuration.deliveryProxyConcurrency,
              onDeliveryProxy: (result, elapsedMs) => {
                ctx.event('dharma.episode.render.delivery_proxy', {
                  source: path.relative(repoRoot, result.sourcePath),
                  delivery: path.relative(repoRoot, result.deliveryPath),
                  cache_status: result.cacheStatus,
                  source_width: result.sourceDimensions.width,
                  source_height: result.sourceDimensions.height,
                  encoder: result.encoder ?? null,
                  elapsed_ms: elapsedMs,
                })
              },
            })
          })
        ), { episode_id: episodeId, pilot: artifact.isReviewPilot, preview: artifact.isPreview }, (result) => ({
          duration_frames: result.durationInFrames,
          segment_count: result.segmentCount,
          quote_count: result.quoteCount,
          subtitle_fallbacks: result.subtitleFallbacks,
          bgm_volume: result.bgm.volume,
          bgm_narration_volume: result.bgm.narrationVolume,
          bgm_target_lufs: result.bgm.targetLufs,
          bgm_source_duration_sec: result.bgm.sourceDurationSec,
          delivery_proxy_source: result.deliveryProxy.source,
          delivery_proxy_cache_hits: result.deliveryProxy.cacheHits,
          delivery_proxy_created: result.deliveryProxy.created,
          delivery_proxy_elapsed_ms: result.deliveryProxy.elapsedMs,
        }))

        await runTimedStage(ctx, 'input_fingerprint_pre_render', () => {
          if (artifact.isReviewCanary) {
            const currentCanary = getDharmaCanaryRenderAdmission(episodeId, {
              taskId: ctx.taskId,
              storyboardIds: onlyStoryboardIds ?? [],
              durationSec: maxDurationSec ?? 0,
            })
            if (!currentCanary.allowed || currentCanary.currentCanaryFingerprint !== preflight.canaryFingerprint) {
              throw new Error(`canary 输入在渲染前发生变化：${currentCanary.reason ?? '指纹不一致'}`)
            }
            return
          }
          assertDharmaRenderInputFingerprintStable(preflight.inputFingerprint, buildDharmaEpisodeInputFingerprint(episodeId))
        }, { episode_id: episodeId, canary: artifact.isReviewCanary })

        const fileStem = artifact.fileStem
        const finalPath = path.join(repoRoot, 'data/static/remotion', `${fileStem}.mp4`)
        stagingDir = await runTimedStage(ctx, 'staging_prepare', () => {
          throwIfAborted(ctx.signal)
          return createTaskStagingDirectory(episodeId, ctx.taskId)
        }, { output: `static/remotion/${fileStem}.mp4` }, (result) => ({ staging_directory: path.basename(result) }))
        const stagedOutputPath = path.join(stagingDir, 'render.mp4')

        const renderResult = await runTimedStage(ctx, 'remotion_render', () => (
          runRemotionRender(built.propsPath, stagedOutputPath, concurrency, configuration.watchdog, ctx)
        ), {
          concurrency,
          hardware_acceleration: REMOTION_HARDWARE_ACCELERATION,
          max_runtime_ms: configuration.watchdog.maxRuntimeMs,
          progress_stall_ms: configuration.watchdog.progressStallMs,
        }, (result) => ({
          elapsed_ms_remotion: result.elapsedMs,
          encoder: result.encoderEvidence,
          rendered_frames: result.progress?.current ?? null,
          total_frames: result.progress?.total ?? null,
        }))

        const outputProbe = await runTimedStage(ctx, 'output_validation', () => (
          validateRenderedOutput(stagedOutputPath, built.durationInFrames, ctx.signal)
        ), {}, (result) => ({
          duration_sec: result.durationSec,
          size_bytes: result.sizeBytes,
          video_codec: result.videoCodec,
          audio_codec: result.audioCodec,
          width: result.width,
          height: result.height,
          frame_rate: result.frameRate,
          frame_count: result.frameCount,
          audio_stream_count: result.audioStreamCount,
        }))
        if (artifact.isReviewPilot && !isDharmaReviewPilotOutputDuration(outputProbe.durationSec)) {
          throw new Error(
            `60 秒 pilot 输出时长不精确：${outputProbe.durationSec.toFixed(3)}s；拒绝发布并要求重新渲染`,
          )
        }

        const outputRel = `static/remotion/${fileStem}.mp4`
        await runTimedStage(ctx, 'publish', () => {
          // First take the durable commit claim. The transaction also confirms
          // the exact input revision/fingerprint that rendered; DB triggers
          // freeze those fields until the task reaches a terminal state.
          throwIfAborted(ctx.signal)
          const workerId = ctx.workerId
          const leaseToken = ctx.leaseToken
          if (!workerId || !leaseToken) throw new Error('Dharma 发布缺少 worker lease identity')
          const claim = claimTaskCommitPoint(ctx.taskId, {
            workerId,
            leaseToken,
            validate: (tx) => {
              const [currentEpisode] = tx.select().from(schema.episodes)
                .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
                .all()
              if (!currentEpisode) throw new Error(`Episode ${episodeId} 不存在或已删除`)
              if (artifact.isReviewCanary) {
                const canaryAdmission = getDharmaCanaryRenderAdmission(episodeId, {
                  taskId: ctx.taskId,
                  storyboardIds: onlyStoryboardIds ?? [],
                  durationSec: maxDurationSec ?? 0,
                }, tx)
                if (!canaryAdmission.allowed || canaryAdmission.currentCanaryFingerprint !== preflight.canaryFingerprint) {
                  throw new Error(`canary 输入在发布期间发生变化：${canaryAdmission.reason ?? '指纹不一致'}`)
                }
              } else {
                if (currentEpisode.dharmaInputRevision !== preflight.dharmaInputRevision) {
                  throw new Error('素材、旁白、BGM 或标题在渲染期间发生变化；已拒绝发布，请重新试渲/渲染')
                }
                assertDharmaRenderInputFingerprintStable(
                  preflight.inputFingerprint,
                  buildDharmaEpisodeInputFingerprint(episodeId, tx),
                )
                if (!artifact.isPreview) {
                  const formalAdmission = getDharmaFormalRenderAdmission(episodeId, tx)
                  if (!formalAdmission.admission.allowed) {
                    throw new Error(`正式交付门禁在发布前失效：${formalAdmission.admission.reason}`)
                  }
                }
              }
            },
          })
          if (claim.outcome === 'cancel_requested') throw abortError()
          if (claim.outcome !== 'claimed') {
            throw new Error(`Dharma 发布未取得提交权：${claim.outcome}`)
          }
          fs.mkdirSync(path.dirname(finalPath), { recursive: true })
          const pointerUpdated = publishDharmaOutputWithPointerCommit(
            stagedOutputPath,
            finalPath,
            (moveOutput) => Boolean(mutateClaimedTaskCommit(ctx.taskId, workerId, leaseToken, (tx) => {
              // Move only after the fenced transaction has retained this exact
              // lease. The pointer update below commits in that same DB tx.
              moveOutput()
              const [currentEpisode] = tx.select().from(schema.episodes)
                .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
                .all()
              if (!currentEpisode) throw new Error(`Episode ${episodeId} 不存在或已删除`)

              const renderedAt = new Date().toISOString()
              if (artifact.isReviewCanary) {
                if (!preflight.canaryFingerprint) throw new Error('canary 发布缺少预检指纹')
                const patch = buildDharmaEpisodePublishPatch(currentEpisode.metadata, {
                  kind: 'canary',
                  taskId: ctx.taskId,
                  output: outputRel,
                  fullPlanFingerprint: preflight.inputFingerprint,
                  canaryFingerprint: preflight.canaryFingerprint,
                  renderedAt,
                })
                const update = tx.update(schema.episodes)
                  .set({ ...patch, updatedAt: renderedAt })
                  .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
                  .run()
                if (update.changes !== 1) throw new Error(`Episode ${episodeId} 的 canary 审查指针写入失败`)
                return
              }

              const metadata = parseMetadataRecord(currentEpisode.metadata)
              if (artifact.isReviewPilot) {
                metadata.dharmaPilot = {
                  status: 'rendered',
                  output: outputRel,
                  inputFingerprint: preflight.inputFingerprint,
                  taskId: ctx.taskId,
                  requestedDurationSec: DHARMA_REVIEW_PILOT_DURATION_SEC,
                  durationSec: outputProbe.durationSec,
                  renderedAt,
                }
                const update = tx.update(schema.episodes)
                  .set({ metadata: JSON.stringify(metadata), updatedAt: renderedAt })
                  .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
                  .run()
                if (update.changes !== 1) throw new Error(`Episode ${episodeId} 的 pilot 交付指针写入失败`)
                return
              }

              if (!artifact.isPreview) {
                metadata.dharmaRender = {
                  output: outputRel,
                  inputFingerprint: preflight.inputFingerprint,
                  taskId: ctx.taskId,
                  durationFrames: built.durationInFrames,
                  segmentCount: built.segmentCount,
                  quoteCount: built.quoteCount,
                  concurrency,
                  renderElapsedMs: renderResult.elapsedMs,
                  outputDurationSec: outputProbe.durationSec,
                  renderedAt,
                }
                const update = tx.update(schema.episodes)
                  .set({ videoUrl: outputRel, metadata: JSON.stringify(metadata), updatedAt: renderedAt })
                  .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
                  .run()
                if (update.changes !== 1) throw new Error(`Episode ${episodeId} 的正式交付指针写入失败`)
              }
            })),
          )
          if (!pointerUpdated) {
            throw new Error('Dharma 发布前失去 worker lease；任务私有交付文件已拒绝关联')
          }
          ctx.markCommitPoint?.()
          ctx.event('dharma.episode.render.publish_committed', {
            output: outputRel,
          })
        }, { output: outputRel })

        const response = {
          episode_id: episodeId,
          segment_count: built.segmentCount,
          quote_count: built.quoteCount,
          duration_frames: built.durationInFrames,
          subtitle_fallbacks: built.subtitleFallbacks,
          render_concurrency: concurrency,
          delivery_proxy_concurrency: configuration.deliveryProxyConcurrency,
          preview: artifact.isPreview,
          review_kind: artifact.isReviewCanary ? 'canary' : artifact.isReviewPilot ? 'legacy_pilot' : null,
          full_plan_fingerprint: preflight.inputFingerprint,
          canary_fingerprint: preflight.canaryFingerprint ?? null,
          output_duration_sec: outputProbe.durationSec,
          output: outputRel,
        }
        ctx.event('dharma.episode.rendered', {
          ...response,
          elapsed_ms: Date.now() - taskStartedAt,
        })
        return response
      } catch (error) {
        ctx.event('dharma.episode.render.failed', {
          episode_id: episodeId,
          elapsed_ms: Date.now() - taskStartedAt,
          canceled: ctx.signal.aborted,
          error: errorMessage(error),
        })
        throw error
      } finally {
        if (stagingDir) {
          const cleanupStartedAt = Date.now()
          try {
            cleanupTaskStagingDirectory(stagingDir)
            ctx.event('dharma.episode.render.stage', {
              stage: 'staging_cleanup',
              status: 'completed',
              elapsed_ms: Date.now() - cleanupStartedAt,
            })
          } catch (error) {
            // A failed cleanup must not overwrite a successful atomic publish.
            ctx.event('dharma.episode.render.stage', {
              stage: 'staging_cleanup',
              status: 'failed',
              elapsed_ms: Date.now() - cleanupStartedAt,
              error: errorMessage(error),
            })
          }
        }
      }
    },
  }
}

export function registerDharmaEpisodeHandlers() {
  registerTaskHandler('dharma.episode_render', createDharmaEpisodeRenderHandler())
}
