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
import { runEpisodeGridPipeline, designEpisodeSequenceBeats } from '../../grid-narrative-pipeline.js'
import { areStoryboardNumbersContiguous, buildGridStoryProps } from '../../grid-story-props.js'
import { buildGridAudioPlan, mixGridEpisodeAudio } from '../../composition/grid-audio-mix.js'
import { ensureSa3AudioAssetsForEpisode } from '../../composition/sa3-audio-preflight.js'
import { reviewEpisodeGridCells } from '../../grid-review.js'
import { generateEpisodeVideos } from '../../grok-video.js'
import { generateOpeningVideo } from '../../opening-storyboard.js'
import { getNarrativePlanStatus } from '../../narrative-hierarchy.js'
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
      if (ctx.payload.review === true) {
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

/** 旧版单轨 BGM 混音（音量 0.15 + 侧链闪避 + 限幅），作为升级混音失败时的兜底 */
async function legacyMixBgm(bgmPath: string, cleanPath: string, finalPath: string): Promise<void> {
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
    '-b:a', '128k',
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
}

interface GridAudioMixSummary {
  bgmCues: number
  sfxCues: number
  ambienceCues: number
  tracks: Array<{ path: string; emotionBucket: string; role: string }>
}

/**
 * 集级音频混音（v2）：多幕 BGM cue + 场景 SFX cue + 侧链闪避 + 终混 loudnorm。
 * 失败降级链：v2 混音 → 旧单轨混音 → 无混音（rename），音频问题绝不阻塞渲染出片。
 */
async function mixBgmIfAvailable(
  episodeId: number,
  cleanPath: string,
  finalPath: string,
  ctx: TaskContext<any>,
  opts: { maxDurationSec?: number } = {},
): Promise<GridAudioMixSummary | null> {
  try {
    // SA3 优先：先确保本集所需 BGM / ambience 都有 SA3 生成素材缓存
    try {
      await ensureSa3AudioAssetsForEpisode(episodeId)
    } catch (sa3Err) {
      ctx.event('grid.episode.sa3_preflight_failed', {
        episode_id: episodeId,
        error: sa3Err instanceof Error ? sa3Err.message : String(sa3Err),
      })
      // 预生成失败不阻塞渲染，回退到本地库兜底
    }

    const plan = buildGridAudioPlan(episodeId, { maxDurationSec: opts.maxDurationSec })
    if (plan) {
      ctx.progress(`音频混音（BGM ${plan.bgmCues.length} 幕 / 环境音 ${plan.ambienceCues.length} 段 / SFX ${plan.sfxCues.length} 处）`, 0, 1)
      await mixGridEpisodeAudio(cleanPath, finalPath, plan)
      fs.rmSync(cleanPath, { force: true })
      return {
        bgmCues: plan.bgmCues.length,
        sfxCues: plan.sfxCues.length,
        ambienceCues: plan.ambienceCues.length,
        tracks: plan.tracks.map((t) => ({ path: t.path, emotionBucket: t.emotionBucket, role: t.role })),
      }
    }
  } catch (err) {
    ctx.event('grid.episode.audio_mix_v2_failed', {
      episode_id: episodeId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const bgmPath = resolveBgmPath(episodeId)
  if (!bgmPath) {
    fs.renameSync(cleanPath, finalPath)
    return null
  }
  ctx.progress('BGM 混音（单轨兜底）', 0, 1)
  await legacyMixBgm(bgmPath, cleanPath, finalPath)
  fs.rmSync(cleanPath, { force: true })
  return { bgmCues: 1, sfxCues: 0, ambienceCues: 0, tracks: [{ path: path.relative(repoRoot, bgmPath), emotionBucket: 'neutral', role: 'primary' }] }
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

      // ── v8 阶段门禁：叙事设计必须先于渲染完成（与 generate 同一道闸）──
      const planStatus = getNarrativePlanStatus(episodeId, 'full')
      if (!planStatus.isReal) {
        throw new Error(
          `[v8 阶段门禁] Episode ${episodeId} 没有真实叙事层级计划（${
            planStatus.exists ? `当前只有「${planStatus.timingSource ?? '未知'}」分镜平铺骨架` : '尚未导入'
          }），禁止渲染。先完成叙事设计并通过 narrative-hierarchy/import 写库。`,
        )
      }

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

      // ── 资产预检：范围内分镜的指定视频必须在盘上；第一镜必须配置了视频 ──
      // buildGridStoryProps 对缺文件/缺配置是静默降级的（视频退化为静态图），
      // 这里把降级提前变成明确的失败。
      const scoped = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(schema.storyboards.storyboardNumber).all()
        .filter((sb) => !onlyStoryboardIds || onlyStoryboardIds.includes(sb.id))
      const missingVideos: string[] = []
      for (const sb of scoped) {
        let gc: any = null
        try { gc = sb.gridCells ? JSON.parse(sb.gridCells) : null } catch { /* ignore */ }
        const videoSrc = gc?.video?.src ? String(gc.video.src).replace(/^\//, '') : null
        if (videoSrc && !fs.existsSync(path.join(repoRoot, 'data', videoSrc))) {
          missingVideos.push(`#${sb.storyboardNumber}: ${videoSrc}`)
        }
      }
      if (missingVideos.length) {
        throw new Error(`分镜视频文件缺失：${missingVideos.join('；')}。请重新运行 grid.episode_videos（force）再渲染`)
      }
      const firstShot = scoped[0]
      if (firstShot?.storyboardNumber === 1) {
        let gc: any = null
        try { gc = firstShot.gridCells ? JSON.parse(firstShot.gridCells) : null } catch { /* ignore */ }
        if (!gc?.video?.src) {
          throw new Error('第一镜必须是视频（2 秒 / 5 秒留存门）：请先运行 grid.episode_videos 为第一镜解析视频资产')
        }
      }

      const built = buildGridStoryProps(episodeId, {
        onlyStoryboardIds,
        maxDurationSec: isPilot ? maxDurationSec : undefined,
      })
      if (built.shotCount === 0) throw new Error('no grid cells built; run grid.episode_generate first')
      if (built.skippedStoryboards.length) {
        throw new Error(
          `有 ${built.skippedStoryboards.length} 个分镜缺生产图（#${built.skippedStoryboards.join(', #')}），` +
          `直接渲染会丢失旁白。请先用 grid.episode_generate（onlyStoryboardIds）补齐`,
        )
      }

      const fileStem = isPilot
        ? `grid-story-ep${episodeId}-pilot-${Math.round(maxDurationSec)}s`
        : `grid-story-ep${episodeId}`
      const finalPath = path.join(repoRoot, 'data/static/remotion', `${fileStem}.mp4`)
      const cleanPath = path.join(repoRoot, 'data/static/remotion', `${fileStem}.clean.mp4`)
      await runRemotionRender(built.propsPath, cleanPath, ctx)
      const audio = await mixBgmIfAvailable(episodeId, cleanPath, finalPath, ctx, {
        maxDurationSec: isPilot ? maxDurationSec : undefined,
      })

      const response = {
        episode_id: episodeId,
        shot_count: built.shotCount,
        duration_frames: built.durationInFrames,
        skipped_storyboards: built.skippedStoryboards,
        output: `static/remotion/${fileStem}.mp4`,
        audio,
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

interface GridEpisodeDesignPayload {
  episode_id?: number
  episodeId?: number
  only_sequence_ids?: number[]
  only_storyboard_ids?: number[]
}

export function createGridEpisodeDesignHandler(): TaskHandler<GridEpisodeDesignPayload> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<GridEpisodeDesignPayload>) {
      const episodeId = resolveEpisodeId(ctx.payload)
      // 仅设计连续性（相机轨道 + 锚点），持久化到 narrative_sequences.design_json；
      // 不生成任何图片，可在批量生图前审查。
      const results = await designEpisodeSequenceBeats(
        episodeId,
        {
          onlySequenceIds: Array.isArray(ctx.payload.only_sequence_ids)
            ? ctx.payload.only_sequence_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : undefined,
          onlyStoryboardIds: Array.isArray(ctx.payload.only_storyboard_ids)
            ? ctx.payload.only_storyboard_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : undefined,
        },
        (current, total, message) => ctx.progress(message, current, total),
      )
      ctx.event('grid.episode.design', { episodeId, sequences: results.length })
      return { episodeId, designed_sequences: results.length, seqKeys: results.map((r) => r.seqKey) }
    },
  }
}

interface GridEpisodeOpeningPayload {
  episode_id?: number
  episodeId?: number
  force?: boolean
  duration_sec?: number
  resolution?: string
}

export function createGridEpisodeOpeningHandler(): TaskHandler<GridEpisodeOpeningPayload> {
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<GridEpisodeOpeningPayload>) {
      const episodeId = resolveEpisodeId(ctx.payload)
      // 开场视频：先设计独立 storyboard，再 t2v 生成 ~8s 写回 introVideoUrl（片头前置）。
      const result = await generateOpeningVideo(
        episodeId,
        {
          force: Boolean(ctx.payload.force),
          durationSec: Number(ctx.payload.duration_sec) || undefined,
          resolution: ctx.payload.resolution,
        },
        (current, total, message) => ctx.progress(message, current, total),
      )
      ctx.event('grid.episode.opening', { episodeId, ...result })
      return result
    },
  }
}

export function registerGridEpisodeHandlers() {
  registerTaskHandler('grid.episode_generate', createGridEpisodeGenerateHandler())
  registerTaskHandler('grid.episode_design', createGridEpisodeDesignHandler())
  registerTaskHandler('grid.episode_opening', createGridEpisodeOpeningHandler())
  registerTaskHandler('grid.episode_render', createGridEpisodeRenderHandler())
  registerTaskHandler('grid.episode_review', createGridEpisodeReviewHandler())
  registerTaskHandler('grid.episode_videos', createGridEpisodeVideosHandler())
}
