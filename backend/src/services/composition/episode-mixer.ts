/**
 * 集级别 Timeline Mixer
 *
 * 把单镜合成的视频（已含非旁白音频）按顺序拼接，并把旁白音频轨在时间轴上
 * 做 J-Cut / L-Cut 重叠淡入淡出，最终 mux 成完整成片。
 *
 * 当前实现：
 * - 每个旁白片段与前后相邻旁白做 0.6s 交叉淡入淡出。
 * - 上一段旁白的尾部延续到下一段视频（L-Cut）。
 * - 下一段旁白的头部提前进入上一段视频（J-Cut）。
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskProgress } from '../../utils/task-logger.js'
import { getVideoEncoderOptions } from './video-encoder.js'
import { planBgmCues, type BgmCue } from './bgm-cue-planner.js'
import { ensureEpisodeBgmPlan, type EpisodeBgmPlan } from '../music-generation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../../data')
const BGM_CUE_FADE_SECONDS = 2
const BGM_CUE_CROSSFADE_SECONDS = 2
const BGM_TARGET_LUFS = readNumberEnv('EPISODE_BGM_TARGET_LUFS', -18)
const BGM_MIX_VOLUME = readNumberEnv('EPISODE_BGM_MIX_VOLUME', 0.5)

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

interface Shot {
  storyboardId: number
  videoPath: string
  narrationPath: string | null
  narrationDuration: number
  videoDuration: number
  bgmPath: string | null
}

function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }
      resolve(metadata.format.duration || 0)
    })
  })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err)
        return
      }
      const stream = metadata.streams.find(s => s.codec_type === 'video')
      resolve(stream?.duration ? Number(stream.duration) : (metadata.format.duration || 0))
    })
  })
}

function normalizeVideo(inputPath: string, outputPath: string, targetWidth: number, targetHeight: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    ffmpeg(inputPath)
      .videoFilter(`scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`)
      .audioCodec('aac')
      .audioBitrate('192k')
      .outputOptions([
        '-color_range', 'mpeg',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function buildConcatVideo(shots: Shot[], outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  // 优先尝试 concat demuxer + -c copy，避免整集视频被再次重编码。
  // 如果镜头编码参数不一致导致失败，再回退到 filter_complex 重编码。
  try {
    await buildConcatVideoCopy(shots, outputPath)
    return
  } catch (copyErr: any) {
    logTaskProgress('EpisodeMixer', 'concat-copy-fallback', {
      reason: copyErr.message || 'concat copy failed',
      shots: shots.length,
    })
  }

  // 使用 filter_complex concat，避免 concat demuxer 在音频参数变化时产生 DTS 错乱、
  // 时长翻倍等问题。每个镜头的音视频先统一格式后再拼接。
  console.log('[EpisodeMixer] filter_complex concat fallback, shots:', shots.length)
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg()
    for (const s of shots) {
      cmd = cmd.input(toAbsPath(s.videoPath))
    }

    const filters: ffmpeg.FilterSpecification[] = []
    shots.forEach((_, i) => {
      filters.push(
        {
          filter: 'format',
          options: 'yuv420p',
          inputs: `${i}:v`,
          outputs: `v${i}`,
        },
        {
          filter: 'aformat',
          options: 'sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
          inputs: `${i}:a`,
          outputs: `a${i}`,
        },
      )
    })

    const concatInputs = shots.flatMap((_, i) => [`v${i}`, `a${i}`])
    filters.push({
      filter: 'concat',
      options: `n=${shots.length}:v=1:a=1`,
      inputs: concatInputs,
      outputs: ['outv', 'outa'],
    })

    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map', '[outv]',
        ...getVideoEncoderOptions(),
        '-an',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function buildConcatVideoCopy(shots: Shot[], outputPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outputPath), `${uuid()}_concat_list.txt`)
  const lines = shots.map(s => `file '${toAbsPath(s.videoPath).replace(/'/g, "'\\''")}'`)
  fs.writeFileSync(listPath, lines.join('\n') + '\n')

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c:v', 'copy',
          '-an',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    try { fs.unlinkSync(listPath) } catch {}
  }
}

async function buildNarrationMix(shots: Shot[], totalDuration: number, outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const validShots = shots
    .map((s, index) => ({ ...s, index }))
    .filter((s) => s.narrationPath && s.narrationDuration > 0)

  if (validShots.length === 0) {
    // 生成一个静音文件
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input('anullsrc=r=48000:cl=stereo')
        .inputOptions(['-f', 'lavfi'])
        .outputOptions(['-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  }

  // 计算每段旁白在时间轴上的起始位置：每段从对应镜头起点开始，
  // 使用完整旁白时长，不再做 J-Cut/L-Cut 裁剪或重叠淡入淡出，
  // 避免吃掉每段开头/结尾的解说文字。
  let currentTime = 0
  const boundaries: Array<{
    start: number
    end: number
    shotIndex: number
    inputIndex: number
  }> = []
  let inputIndex = 0
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]
    if (s.narrationPath && s.narrationDuration > 0) {
      boundaries.push({
        start: currentTime,
        end: currentTime + s.narrationDuration,
        shotIndex: i,
        inputIndex: inputIndex++,
      })
    }
    currentTime += s.videoDuration
  }

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg()
    for (const b of boundaries) {
      cmd = cmd.input(toAbsPath(shots[b.shotIndex].narrationPath!))
    }

    const mixInputs: string[] = []
    const filters: ffmpeg.FilterSpecification[] = []
    boundaries.forEach((b, i) => {
      const delayMs = Math.round(b.start * 1000)

      const chain: ffmpeg.FilterSpecification[] = [
        {
          filter: 'atrim',
          options: `start=0:end=${b.end - b.start}`,
          inputs: `${b.inputIndex}:a`,
          outputs: `nt${i}`,
        },
        {
          filter: 'asetpts',
          options: 'PTS-STARTPTS',
          inputs: `nt${i}`,
          outputs: `np${i}`,
        },
        {
          filter: 'volume',
          options: '1.0',
          inputs: `np${i}`,
          outputs: `nv${i}`,
        },
        {
          filter: 'adelay',
          options: `delays=${delayMs}|${delayMs}:all=1`,
          inputs: `nv${i}`,
          outputs: `nd${i}`,
        },
      ]

      filters.push(...chain)
      mixInputs.push(`nd${i}`)
    })

    filters.push({
      filter: 'amix',
      options: `inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0`,
      inputs: mixInputs,
      outputs: 'narration_mix',
    })

    filters.push({
      filter: 'aformat',
      options: 'sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      inputs: 'narration_mix',
      outputs: 'narration_fmt',
    })

    filters.push({
      filter: 'apad',
      options: `whole_dur=${totalDuration}`,
      inputs: 'narration_fmt',
      outputs: 'narration_padded',
    })

    filters.push({
      filter: 'loudnorm',
      options: 'I=-16:TP=-1.5:LRA=11',
      inputs: 'narration_padded',
      outputs: 'final_narration',
    })

    cmd
      .complexFilter(filters)
      .outputOptions(['-map', '[final_narration]', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function prepareBgmCue(
  inputPath: string,
  duration: number,
  outputPath: string,
  options: { fadeIn?: number; fadeOut?: number } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const safeDuration = Math.max(0.1, duration)
  const maxFade = Math.max(0, safeDuration / 2)
  const fadeIn = Math.min(options.fadeIn ?? BGM_CUE_FADE_SECONDS, maxFade)
  const fadeOut = Math.min(options.fadeOut ?? BGM_CUE_FADE_SECONDS, maxFade)
  const fadeOutStart = Math.max(0, safeDuration - fadeOut)
  const audioFilters: string[] = []
  if (fadeIn > 0.05) audioFilters.push(`afade=t=in:ss=0:d=${fadeIn}`)
  if (fadeOut > 0.05) audioFilters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOut}`)

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .inputOptions(['-stream_loop', '-1'])
      .outputOptions([
        '-t', String(safeDuration),
        ...(audioFilters.length > 0 ? ['-af', audioFilters.join(',')] : []),
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function buildBgmMix(
  cues: BgmCue[],
  totalDuration: number,
  outputPath: string,
  tempDir: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  interface BgmInput {
    segmentPath: string
    start: number
  }
  const bgmInputs: BgmInput[] = []

  logTaskProgress('EpisodeMixer', 'bgm-cue-plan', {
    cues: cues.length,
    cueDurations: cues.map(cue => cue.duration),
  })

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    const overlap = i === 0
      ? 0
      : Math.min(BGM_CUE_CROSSFADE_SECONDS, cue.start, cue.duration / 3)
    const segmentPath = path.join(tempDir, `${uuid()}_bgm_cue.m4a`)
    const segmentStart = Math.max(0, cue.start - overlap)
    const segmentDuration = cue.duration + overlap
    const fadeIn = i === 0 ? BGM_CUE_FADE_SECONDS : overlap
    const fadeOut = i === cues.length - 1
      ? BGM_CUE_FADE_SECONDS
      : Math.min(BGM_CUE_CROSSFADE_SECONDS, cue.duration / 3)

    await prepareBgmCue(toAbsPath(cue.bgmPath), segmentDuration, segmentPath, { fadeIn, fadeOut })
    bgmInputs.push({ segmentPath, start: segmentStart })
  }

  if (bgmInputs.length === 0) {
    // 没有 BGM 时生成静音文件占位
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input('anullsrc=r=48000:cl=stereo')
        .inputOptions(['-f', 'lavfi'])
        .outputOptions(['-t', String(totalDuration), '-c:a', 'aac', '-b:a', '192k'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  }

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg()
    for (const input of bgmInputs) {
      cmd = cmd.input(input.segmentPath)
    }

    const mixInputs: string[] = []
    const filters: ffmpeg.FilterSpecification[] = []

    bgmInputs.forEach((input, i) => {
      const delayMs = Math.round(input.start * 1000)
      filters.push(
        {
          filter: 'asetpts',
          options: 'PTS-STARTPTS',
          inputs: `${i}:a`,
          outputs: `bp${i}`,
        },
        {
          filter: 'adelay',
          options: `delays=${delayMs}|${delayMs}:all=1`,
          inputs: `bp${i}`,
          outputs: `bd${i}`,
        },
      )
      mixInputs.push(`bd${i}`)
    })

    filters.push({
      filter: 'amix',
      options: `inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0`,
      inputs: mixInputs,
      outputs: 'bgm_mix',
    })

    filters.push({
      filter: 'aformat',
      options: 'sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      inputs: 'bgm_mix',
      outputs: 'bgm_fmt',
    })

    filters.push({
      filter: 'apad',
      options: `whole_dur=${totalDuration}`,
      inputs: 'bgm_fmt',
      outputs: 'bgm_padded',
    })

    filters.push({
      filter: 'atrim',
      options: `duration=${totalDuration}`,
      inputs: 'bgm_padded',
      outputs: 'bgm_trimmed',
    })

    // 素材库/免费包的 BGM 响度差异很大；先统一响度，再作为背景音乐降到混入音量。
    filters.push({
      filter: 'loudnorm',
      options: `I=${BGM_TARGET_LUFS}:TP=-2:LRA=11`,
      inputs: 'bgm_trimmed',
      outputs: 'bgm_normalized',
    })

    filters.push({
      filter: 'volume',
      options: String(BGM_MIX_VOLUME),
      inputs: 'bgm_normalized',
      outputs: 'bgm_final',
    })

    cmd
      .complexFilter(filters)
      .outputOptions(['-map', '[bgm_final]', '-c:a', 'aac', '-ar', '48000', '-b:a', '192k'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function buildSilentAudio(duration: number, outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('anullsrc=r=48000:cl=stereo')
      .inputOptions(['-f', 'lavfi'])
      .outputOptions([
        '-t', String(Math.max(0.1, duration)),
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

async function concatVideosCopy(
  segments: Array<{ videoPath: string; hasAudio: boolean }>,
  outputPath: string,
  tempDir: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const listPath = path.join(tempDir, `${uuid()}_lead_in_list.txt`)
  const lines = segments.map(s => `file '${toAbsPath(s.videoPath).replace(/'/g, "'\\''")}'`)
  fs.writeFileSync(listPath, lines.join('\n') + '\n')

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    try { fs.unlinkSync(listPath) } catch {}
  }
}

export async function mixEpisode(
  episodeId: number,
  outputPath: string,
): Promise<{ outputPath: string; duration: number }> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  if (storyboards.length === 0) {
    throw new Error(`Episode ${episodeId} has no storyboards`)
  }

  logTaskStart('EpisodeMixer', 'mix-episode', { episodeId, shots: storyboards.length })

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()

  const tempDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(tempDir, { recursive: true })

  // 以正文镜头的参数作为整集输出标准。
  let targetWidth = 1920
  let targetHeight = 1080
  const firstStoryboardVideo = storyboards.find(sb => sb.composedVideoUrl)?.composedVideoUrl
  if (firstStoryboardVideo) {
    const firstAbs = toAbsPath(firstStoryboardVideo)
    if (fs.existsSync(firstAbs)) {
      const meta = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(firstAbs, (err, data) => {
          if (err) reject(err)
          else resolve(data)
        })
      })
      const videoStream = meta.streams.find(s => s.codec_type === 'video')
      if (videoStream?.width && videoStream?.height) {
        targetWidth = videoStream.width
        targetHeight = videoStream.height
      }
    }
  }

  // 1. 先处理片头/前情提要，但暂时不加入正文时间轴。
  const normalizedTempFiles: string[] = []
  const leadIns: Array<{ path: string; duration: number }> = []

  async function normalizeLeadIn(url: string | null | undefined) {
    if (!url) return
    const abs = toAbsPath(url)
    if (!fs.existsSync(abs)) return
    const normalizedPath = path.join(tempDir, `${uuid()}_normalized.mp4`)
    try {
      await normalizeVideo(abs, normalizedPath, targetWidth, targetHeight)
    } catch (err: any) {
      logTaskError('EpisodeMixer', 'normalize-lead-in-skipped', {
        episodeId,
        source: url,
        error: err.message,
      })
      return
    }
    normalizedTempFiles.push(normalizedPath)
    const duration = await getVideoDuration(normalizedPath)
    leadIns.push({ path: normalizedPath, duration })
  }

  if (episode) {
    await normalizeLeadIn(episode.introVideoUrl)
    await normalizeLeadIn(episode.recapVideoUrl)
  }

  // 2. 正文镜头（解说、BGM 都基于这些镜头计算）。
  const mainShots: Shot[] = []
  let mainDuration = 0
  for (const sb of storyboards) {
    if (!sb.composedVideoUrl) {
      throw new Error(`Storyboard ${sb.id} has no composed video`)
    }
    const videoDuration = sb.duration || 8
    let narrationDuration = 0
    let narrationPath: string | null = null
    if (sb.narrationAudioUrl) {
      const abs = toAbsPath(sb.narrationAudioUrl)
      if (fs.existsSync(abs)) {
        narrationPath = sb.narrationAudioUrl
        narrationDuration = await getAudioDuration(abs)
      }
    }
    let bgmPath: string | null = null
    if (sb.bgmAudioUrl) {
      const abs = toAbsPath(sb.bgmAudioUrl)
      if (fs.existsSync(abs)) bgmPath = sb.bgmAudioUrl
    }
    mainShots.push({
      storyboardId: sb.id,
      videoPath: sb.composedVideoUrl,
      narrationPath,
      narrationDuration,
      videoDuration,
      bgmPath,
    })
    mainDuration += videoDuration
  }

  const mainConcatPath = path.join(tempDir, `${uuid()}_main_concat.mp4`)
  const narrationMixPath = path.join(tempDir, `${uuid()}_narration.m4a`)
  const bgmMixPath = path.join(tempDir, `${uuid()}_bgm.m4a`)
  const mainBodyPath = path.join(tempDir, `${uuid()}_main_body.mp4`)
  const silentAudioPath = path.join(tempDir, `${uuid()}_silent.m4a`)

  try {
    // 3. 拼接正文视频。
    await buildConcatVideo(mainShots, mainConcatPath)

    // 4. 正文 BGM：基于正文镜头做情绪幕布规划，不受片头/前情提要干扰。
    let bgmCues: BgmCue[] = []
    if (episode?.bgmPlanJson) {
      try {
        const plan = JSON.parse(episode.bgmPlanJson) as EpisodeBgmPlan
        bgmCues = plan.cues
      } catch {
        bgmCues = []
      }
    }
    if (bgmCues.length === 0) {
      const episodePlan = await ensureEpisodeBgmPlan(episodeId)
      if (episodePlan) {
        bgmCues = episodePlan.cues
      }
    }
    if (bgmCues.length === 0) {
      bgmCues = planBgmCues(mainShots.map(s => ({ videoDuration: s.videoDuration, bgmPath: s.bgmPath })))
    }
    const hasBgm = bgmCues.length > 0
    if (hasBgm) {
      await buildBgmMix(bgmCues, mainDuration, bgmMixPath, tempDir)
    }

    // 5. 正文旁白。
    const narrationShots = mainShots.filter(s => s.narrationPath && s.narrationDuration > 0)
    if (narrationShots.length > 0) {
      await buildNarrationMix(mainShots, mainDuration, narrationMixPath)
    }

    // 6. 混出“正文成片”（视频 + 音频）。即使没有旁白/BGM 也保留音频轨，便于后面统一拼接。
    const audioInputs: string[] = []
    if (narrationShots.length > 0) audioInputs.push(narrationMixPath)
    if (hasBgm) audioInputs.push(bgmMixPath)
    if (audioInputs.length === 0) {
      await buildSilentAudio(mainDuration, silentAudioPath)
      audioInputs.push(silentAudioPath)
    }

    const audioInputIndices = audioInputs.map((_, i) => i + 1)
    const filterComplex = audioInputIndices.length === 1
      ? `[${audioInputIndices[0]}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`
      : `${audioInputIndices.map(i => `[${i}:a]`).join('')}amix=inputs=${audioInputIndices.length}:duration=first:dropout_transition=0:normalize=0[aout]`

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(mainConcatPath)
      for (const audioInput of audioInputs) {
        cmd = cmd.input(audioInput)
      }

      cmd
        .outputOptions([
          '-c:v', 'copy',
          '-map', '0:v',
          '-c:a', 'aac',
          '-ar', '48000',
          '-b:a', '192k',
          '-movflags', '+faststart',
          '-filter_complex', filterComplex,
          '-map', '[aout]',
        ])
        .output(mainBodyPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })

    // 7. 最后把片头/前情提要拼到正文前面。
    if (leadIns.length === 0) {
      fs.renameSync(mainBodyPath, outputPath)
    } else {
      const segments = leadIns
        .map(li => ({ videoPath: li.path, hasAudio: true }))
        .concat({ videoPath: mainBodyPath, hasAudio: true })
      await concatVideosCopy(segments, outputPath, tempDir)
    }

    // 8. 清理临时文件。
    const tempsToClean = [
      mainConcatPath,
      narrationMixPath,
      bgmMixPath,
      mainBodyPath,
      silentAudioPath,
      ...normalizedTempFiles,
    ]
    for (const f of tempsToClean) {
      try { fs.unlinkSync(f) } catch {}
    }
    for (const f of fs.readdirSync(tempDir)) {
      if (f.endsWith('_bgm_cue.m4a')) {
        try { fs.unlinkSync(path.join(tempDir, f)) } catch {}
      }
    }

    const finalDuration = await getAudioDuration(outputPath)
    const finalVideoDuration = await getVideoDuration(outputPath)
    console.log(`[EpisodeMixer] final output audio=${finalDuration}s video=${finalVideoDuration}s`)
    logTaskSuccess('EpisodeMixer', 'mix-episode', { episodeId, outputPath, duration: finalDuration, videoDuration: finalVideoDuration })
    return { outputPath, duration: finalDuration }
  } catch (err: any) {
    const tempsToClean = [
      mainConcatPath,
      narrationMixPath,
      bgmMixPath,
      mainBodyPath,
      silentAudioPath,
      ...normalizedTempFiles,
    ]
    for (const f of tempsToClean) {
      try { fs.unlinkSync(f) } catch {}
    }
    for (const f of fs.readdirSync(tempDir)) {
      if (f.endsWith('_bgm_cue.m4a')) {
        try { fs.unlinkSync(path.join(tempDir, f)) } catch {}
      }
    }
    logTaskError('EpisodeMixer', 'mix-episode', { episodeId, error: err.message })
    throw err
  }
}
