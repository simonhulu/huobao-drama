/**
 * 单图剧集任务处理器：
 * grid.episode_generate —— 整集单帧设计 + 16:9图片生成 + 回写 storyboards
 * grid.episode_render   —— GridStoryPreview 合成整集 mp4
 */
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { registerTaskHandler } from '../registry.js'
import { runEpisodeGridPipeline } from '../../grid-narrative-pipeline.js'
import { areStoryboardNumbersContiguous, buildGridStoryProps } from '../../grid-story-props.js'
import { reviewEpisodeGridCells } from '../../grid-review.js'
import { generateEpisodeVideos } from '../../grok-video.js'
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import type { TaskContext, TaskHandler } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../../../..')
const REMOTION_DIR = path.join(repoRoot, 'remotion')
const CHROME_EXECUTABLE = '../.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell'

interface GridEpisodeGeneratePayload {
  episode_id?: number
  episodeId?: number
  force?: boolean
  review?: boolean
  only_storyboard_ids?: number[]
  use_reference_images?: boolean
}

interface GridEpisodeRenderPayload {
  episode_id?: number
  episodeId?: number
  only_storyboard_ids?: number[]
  max_duration_sec?: number
}

function resolveEpisodeId(payload: GridEpisodeGeneratePayload | GridEpisodeRenderPayload): number {
  const id = Number((payload as any).episode_id ?? (payload as any).episodeId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('episode_id is required')
  return id
}

export function createGridEpisodeGenerateHandler(): TaskHandler<GridEpisodeGeneratePayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<GridEpisodeGeneratePayload>) {
      const episodeId = resolveEpisodeId(ctx.payload)
      const result = await runEpisodeGridPipeline(
        episodeId,
        {
          force: Boolean(ctx.payload.force),
          onlyStoryboardIds: Array.isArray(ctx.payload.only_storyboard_ids)
            ? ctx.payload.only_storyboard_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : undefined,
          useReferenceImages: ctx.payload.use_reference_images !== false,
        },
        (current, total, message) => ctx.progress(message, current, total),
      )
      if (result.generated === 0 && result.failed.length > 0) {
        throw new Error(`grid pipeline all failed: ${result.failed[0].error}`)
      }
      let review: Awaited<ReturnType<typeof reviewEpisodeGridCells>> | null = null
      if (ctx.payload.review !== false) {
        review = await reviewEpisodeGridCells(
          episodeId,
          {
            onlyStoryboardIds: Array.isArray(ctx.payload.only_storyboard_ids)
              ? ctx.payload.only_storyboard_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
              : undefined,
            useReferenceImages: ctx.payload.use_reference_images !== false,
          },
          (current, total, message) => ctx.progress(message, current, total),
        )
      }
      const response = { ...result, review }
      ctx.event('grid.episode.generated', response)
      return response
    },
  }
}

const REMOTION_CLI = path.join(REMOTION_DIR, 'node_modules/.bin/remotion')
const REMOTION_HARDWARE_ACCELERATION = process.platform === 'darwin' ? 'required' : 'if-possible'

async function runRemotionRender(propsPath: string, outputPath: string, ctx: TaskContext<any>): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const args = [
    'render',
    `--browser-executable=${CHROME_EXECUTABLE}`,
    'src/index.tsx',
    'GridStoryPreview',
    outputPath,
    '--codec=h264',
    `--hardware-acceleration=${REMOTION_HARDWARE_ACCELERATION}`,
    '--video-bitrate=4M',
    '--log=verbose',
    `--props=${propsPath}`,
  ]
  ctx.progress('启动 Remotion 渲染', 0, 1)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(REMOTION_CLI, args, { cwd: REMOTION_DIR, env: process.env })
    let tail = ''
    let diagnostics = ''
    const capture = (data: unknown) => {
      const chunk = String(data)
      tail = (tail + chunk).slice(-2000)
      diagnostics = (diagnostics + chunk).slice(-20000)
    }
    child.stdout.on('data', (d) => {
      capture(d)
    })
    child.stderr.on('data', (d) => {
      capture(d)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        const encoderLine = diagnostics.match(/Encoder:[^\r\n]+/g)?.at(-1) || 'Encoder details unavailable'
        ctx.event('grid.episode.render.encoder', {
          requested: REMOTION_HARDWARE_ACCELERATION,
          evidence: encoderLine.trim(),
        })
        resolve()
      }
      else reject(new Error(`remotion render exit ${code}: ${tail.slice(-500)}`))
    })
  })
}

const FFMPEG_BIN = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'

function resolveBgmPath(episodeId: number): string | null {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return null
  let rel = ep.bgmAudioUrl ? String(ep.bgmAudioUrl) : ''
  if (!rel && ep.bgmPlanJson) {
    try {
      const plan = JSON.parse(ep.bgmPlanJson)
      const primary = (plan.tracks || []).find((t: any) => t?.role === 'primary') || plan.tracks?.[0]
      rel = primary?.path ? String(primary.path) : ''
    } catch {
      /* ignore bad plan json */
    }
  }
  if (!rel) return null
  const abs = rel.startsWith('/') ? rel : path.join(repoRoot, 'data', rel)
  return fs.existsSync(abs) ? abs : null
}

/** BGM 混音：音量压到 0.15 + 人声侧链闪避 + 限幅，BGM 短于正片时循环 */
async function mixBgmIfAvailable(episodeId: number, cleanPath: string, finalPath: string, ctx: TaskContext<any>): Promise<string | null> {
  const bgmPath = resolveBgmPath(episodeId)
  if (!bgmPath) {
    fs.renameSync(cleanPath, finalPath)
    return null
  }
  ctx.progress('BGM 混音', 0, 1)
  const filter =
    '[1:a]volume=0.15[bgm];' +
    '[bgm][0:a]sidechaincompress=threshold=0.02:ratio=9:attack=18:release=300[duck];' +
    '[0:a][duck]amix=inputs=2:duration=first:normalize=0[mix];' +
    '[mix]alimiter=limit=0.95[a]'
  const args = [
    '-y',
    '-i', cleanPath,
    '-stream_loop', '-1',
    '-i', bgmPath,
    '-filter_complex', filter,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    finalPath,
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { env: process.env })
    let tail = ''
    child.stderr.on('data', (d) => {
      tail = (tail + String(d)).slice(-2000)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg mix exit ${code}: ${tail.slice(-500)}`))
    })
  })
  fs.rmSync(cleanPath, { force: true })
  return bgmPath
}

export function createGridEpisodeRenderHandler(): TaskHandler<GridEpisodeRenderPayload> {
  return {
    resumable: false,
    maxAttempts: 1,
    async run(ctx: TaskContext<GridEpisodeRenderPayload>) {
      const episodeId = resolveEpisodeId(ctx.payload)
      const onlyStoryboardIds = Array.isArray(ctx.payload.only_storyboard_ids)
        ? ctx.payload.only_storyboard_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : undefined
      const maxDurationSec = Number(ctx.payload.max_duration_sec)
      const isPilot = Number.isFinite(maxDurationSec) && maxDurationSec > 0
      if (onlyStoryboardIds?.length) {
        const selectedNumbers = db.select().from(schema.storyboards)
          .where(eq(schema.storyboards.episodeId, episodeId)).all()
          .filter((sb) => onlyStoryboardIds.includes(sb.id))
          .map((sb) => sb.storyboardNumber)
        if (selectedNumbers.length !== new Set(onlyStoryboardIds).size) throw new Error('unknown storyboardId')
        if (!areStoryboardNumbersContiguous(selectedNumbers)) {
          throw new Error('non-contiguous storyboard render would skip narration')
        }
      }
      const built = buildGridStoryProps(episodeId, {
        onlyStoryboardIds,
        maxDurationSec: isPilot ? maxDurationSec : undefined,
      })
      if (built.shotCount === 0) throw new Error('no grid cells built; run grid.episode_generate first')

      const fileStem = isPilot
        ? `grid-story-ep${episodeId}-pilot-${Math.round(maxDurationSec)}s`
        : `grid-story-ep${episodeId}`
      const finalPath = path.join(repoRoot, 'data/static/remotion', `${fileStem}.mp4`)
      const cleanPath = path.join(repoRoot, 'data/static/remotion', `${fileStem}.clean.mp4`)
      await runRemotionRender(built.propsPath, cleanPath, ctx)
      const bgm = await mixBgmIfAvailable(episodeId, cleanPath, finalPath, ctx)

      const response = {
        episode_id: episodeId,
        shot_count: built.shotCount,
        duration_frames: built.durationInFrames,
        skipped_storyboards: built.skippedStoryboards,
        output: `static/remotion/${fileStem}.mp4`,
        bgm: bgm ? path.relative(repoRoot, bgm) : null,
      }
      ctx.event('grid.episode.rendered', response)
      return response
    },
  }
}

interface GridEpisodeReviewPayload {
  episode_id?: number
  episodeId?: number
  only_storyboard_ids?: number[]
  max_retries?: number
}

export function createGridEpisodeReviewHandler(): TaskHandler<GridEpisodeReviewPayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<GridEpisodeReviewPayload>) {
      const episodeId = resolveEpisodeId(ctx.payload)
      const result = await reviewEpisodeGridCells(
        episodeId,
        {
          onlyStoryboardIds: Array.isArray(ctx.payload.only_storyboard_ids)
            ? ctx.payload.only_storyboard_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : undefined,
          maxRetries: Number.isFinite(Number(ctx.payload.max_retries))
            ? Math.max(0, Math.floor(Number(ctx.payload.max_retries)))
            : undefined,
        },
        (current, total, message) => ctx.progress(message, current, total),
      )
      ctx.event('grid.episode.reviewed', result)
      return result
    },
  }
}

interface GridEpisodeVideosPayload {
  episode_id?: number
  episodeId?: number
  storyboard_ids?: number[]
  tags?: { era?: string; scene?: string; event?: string; mood?: string }
  duration_sec?: number
  resolution?: string
  mode?: 't2v' | 'i2v'
  force?: boolean
}

export function createGridEpisodeVideosHandler(): TaskHandler<GridEpisodeVideosPayload> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<GridEpisodeVideosPayload>) {
      const episodeId = resolveEpisodeId(ctx.payload)
      const storyboardIds = Array.isArray(ctx.payload.storyboard_ids)
        ? ctx.payload.storyboard_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : []
      if (!storyboardIds.length) throw new Error('storyboard_ids is required')
      const result = await generateEpisodeVideos(
        episodeId,
        {
          storyboardIds,
          tags: ctx.payload.tags,
          durationSec: ctx.payload.duration_sec,
          resolution: ctx.payload.resolution,
          mode: ctx.payload.mode,
          force: Boolean(ctx.payload.force),
        },
        (current, total, message) => ctx.progress(message, current, total),
      )
      if (result.generated === 0 && result.reused === 0 && result.failed.length > 0) {
        throw new Error(`grid video generation failed: ${result.failed[0].error}`)
      }
      ctx.event('grid.episode.videos', result)
      return result
    },
  }
}

export function registerGridEpisodeHandlers() {
  registerTaskHandler('grid.episode_generate', createGridEpisodeGenerateHandler())
  registerTaskHandler('grid.episode_render', createGridEpisodeRenderHandler())
  registerTaskHandler('grid.episode_review', createGridEpisodeReviewHandler())
  registerTaskHandler('grid.episode_videos', createGridEpisodeVideosHandler())
}
