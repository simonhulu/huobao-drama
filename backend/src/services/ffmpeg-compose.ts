/**
 * FFmpeg 单镜头合成 — 支持两种内容形式：
 *   1. 图文叙事模式 (image_story): 静态图 + Ken Burns 运动 + 旁白铺底 + 对白切入
 *   2. AI 视频模式 (ai_video): AI 生成视频 + 对白音频 + 烧录字幕
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { generateTTS } from './tts-generation.js'
import { getAudioConfigById, getNarrationAudioConfig } from './ai.js'
import { getEpisodeVisualStyle } from './episode-mode.js'
import { resolveStoryboardNarrationTextForTTS } from './narration-generation.js'
import { generateSubtitleFileForStoryboard, readEpisodeSubtitleConfig } from './subtitle.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { ensureStoryboardBGM } from './music-generation.js'
import { findSfxFiles, findAmbientFile, getSfxUrl } from './sfx-library.js'
import { applyAudioProfileToStoryboard } from './audio-profile.js'
import {
  buildStoryboardComposition,
  renderStoryboardComposition,
  buildDeterministicMotionPlan,
  parseMovement,
  type AudioLayer,
  type SubtitleOverlay,
  type GrainVignetteOverlay,
} from './composition/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')
let subtitleFilterSupport: boolean | null = null
const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

const SFX_VOLUME = 1.0

export function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) {
    return path.join(STORAGE_ROOT, relativePath.slice('static/'.length))
  }
  return path.join(STORAGE_ROOT, relativePath)
}

function supportsSubtitleFilter(): boolean {
  if (subtitleFilterSupport != null) return subtitleFilterSupport
  try {
    const output = execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
    subtitleFilterSupport = /\bsubtitles\b/.test(output)
  } catch {
    subtitleFilterSupport = false
  }
  return subtitleFilterSupport
}

export function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  const speakerMatch = raw.match(/^(.+?)[:：]/)
  const speaker = speakerMatch ? speakerMatch[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  const pureText = raw.replace(/^.+?[:：]\s*/, '').replace(/[（(].+?[)）]/g, '').trim()
  const ignorable = (!!speaker && IGNORE_TTS_SPEAKERS.test(speaker)) || !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker, pureText, ignorable }
}

const IGNORE_NARRATION_TEXT = /^(无|无旁白|无需配音|无需旁白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i
// 纯标点、空白、特殊符号的文本无法合成有效语音，应跳过
const NON_SPEECH_ONLY = /^[^a-zA-Z0-9\u4e00-\u9fa5]+$/

export function isIgnorableTTS(text?: string | null): boolean {
  const raw = text?.trim() || ''
  return !raw || IGNORE_TTS_TEXT.test(raw) || IGNORE_NARRATION_TEXT.test(raw) || NON_SPEECH_ONLY.test(raw)
}

const IGNORE_SOUND_TEXT = /^(无|无音效|无需音效|none|null|n\/a|na|环境音|环境声|背景音|bgm|背景音乐|无声音|silent)$/i

export function isIgnorableSound(text?: string | null): boolean {
  const raw = text?.trim() || ''
  return !raw || IGNORE_SOUND_TEXT.test(raw)
}

export function resolveVoiceForDialogue(speaker: string, episodeId: number): { voiceId: string; audioConfigId: number | undefined } {
  let voiceId = 'alloy'
  let audioConfigId: number | undefined
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (ep) {
    audioConfigId = ep.audioConfigId ?? undefined
    if (speaker) {
      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, ep.dramaId)).all()
      const found = chars.find(c => c.name === speaker)
      if (found?.voiceStyle) voiceId = found.voiceStyle
    }
  }
  return { voiceId, audioConfigId }
}

export function resolveNarratorVoice(episodeId: number): { voiceId: string; audioConfigId: number | undefined } {
  let voiceId = 'alloy'
  let audioConfigId: number | undefined
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (ep) {
    audioConfigId = ep.audioConfigId ?? undefined

    // 优先使用旁白专用音频配置（如 SiliconFlow 复刻音色）
    const narrationConfig = getNarrationAudioConfig()
    if (narrationConfig) {
      const voiceUri = narrationConfig.settings?.narrationVoiceUri
      if (typeof voiceUri === 'string' && voiceUri) {
        audioConfigId = narrationConfig.id
        voiceId = voiceUri
        return { voiceId, audioConfigId }
      }
      logTaskWarn('ComposeTask', 'narration-config-missing-voice-uri', { episodeId, configId: narrationConfig.id })
    }

    const config = audioConfigId ? getAudioConfigById(audioConfigId) : null
    const provider = config?.provider || ''
    const voices = provider
      ? db.select().from(schema.aiVoices).where(eq(schema.aiVoices.provider, provider)).all()
      : db.select().from(schema.aiVoices).all()

    // 1. 优先使用集设置里指定的解说音色
    const configured = ep.narrationVoiceId
      ? voices.find(v => v.voiceId === ep.narrationVoiceId)
      : undefined
    if (configured) {
      voiceId = configured.voiceId
    } else {
      // 2. 回退到默认解说音色“大女主”
      const preferred = voices.find(v => v.voiceId === 'DaniangzhuVoice01')
      if (preferred) {
        voiceId = preferred.voiceId
      } else if (voices.length > 0) {
        voiceId = voices[0].voiceId
      }
    }
  }
  return { voiceId, audioConfigId }
}

export function getAudioDuration(filePath: string): Promise<number> {
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

function ratioToDimensions(ratio: string | null | undefined): { width: number; height: number } {
  if (ratio === '9:16') return { width: 1080, height: 1920 }
  if (ratio === '1:1') return { width: 1080, height: 1080 }
  return { width: 1920, height: 1080 }
}

function getEpisodeAspectRatio(episodeId: number): string {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return ep?.aspectRatio || '16:9'
}

export interface StoryboardAudioResult {
  ttsAudioUrl: string | null
  narrationAudioUrl: string | null
}

/**
 * 确保分镜拥有所需音频。image_story 模式下会同时生成对白和旁白；
 * ai_video 模式下只生成对白。
 */
export async function ensureStoryboardAudio(
  storyboardId: number,
  options?: { force?: boolean; visualStyle?: 'image_story' | 'ai_video' },
): Promise<StoryboardAudioResult> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  const visualStyle = options?.visualStyle ?? getEpisodeVisualStyle(sb.episodeId)
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  const dialogueMode = ep?.dialogueMode || 'narration_only'
  const narrationText = resolveStoryboardNarrationTextForTTS(sb, ep)

  let ttsAudioUrl: string | null = dialogueMode === 'narration_only' ? null : sb.ttsAudioUrl
  let narrationAudioUrl: string | null = sb.narrationAudioUrl

  // 对白音频（仅在对白模式下）
  if (dialogueMode !== 'narration_only' && !parsedDialogue.ignorable) {
    const existingPath = ttsAudioUrl ? toAbsPath(ttsAudioUrl) : null
    if (!options?.force && existingPath && fs.existsSync(existingPath)) {
      logTaskProgress('ComposeTask', 'reuse-dialogue-tts', { storyboardId })
    } else {
      const { voiceId, audioConfigId } = resolveVoiceForDialogue(parsedDialogue.speaker, sb.episodeId)
      const pureDialogue = parsedDialogue.pureText
      if (pureDialogue) {
        logTaskProgress('ComposeTask', 'generate-dialogue-tts', { storyboardId, voiceId, textPreview: pureDialogue.slice(0, 40) })
        ttsAudioUrl = await generateTTS({
          text: pureDialogue,
          voice: voiceId,
          configId: audioConfigId,
          subtitleEnable: true,
          subtitleType: 'word',
        })
      }
    }
  }

  // 旁白音频（仅在图文叙事模式下需要）
  if (visualStyle === 'image_story' && !isIgnorableTTS(narrationText)) {
    const existingPath = narrationAudioUrl ? toAbsPath(narrationAudioUrl) : null
    if (!options?.force && existingPath && fs.existsSync(existingPath)) {
      logTaskProgress('ComposeTask', 'reuse-narration-tts', { storyboardId })
    } else {
      const { voiceId, audioConfigId } = resolveNarratorVoice(sb.episodeId)
      const speed = ep?.narrationSpeed ?? 1.0
      logTaskProgress('ComposeTask', 'generate-narration-tts', { storyboardId, voiceId, speed, textPreview: narrationText.slice(0, 40) })
      narrationAudioUrl = await generateTTS({
        text: narrationText,
        voice: voiceId,
        configId: audioConfigId,
        speed,
        subtitleEnable: true,
        subtitleType: 'word',
      })
    }
  }

  // 持久化更新
  db.update(schema.storyboards)
    .set({ ttsAudioUrl, narrationAudioUrl, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  return { ttsAudioUrl, narrationAudioUrl }
}

/**
 * 重新生成分镜的对白和旁白音频（保留旧 API 名称，内部调用 ensureStoryboardAudio）
 */
export async function regenerateStoryboardAudio(storyboardId: number): Promise<StoryboardAudioResult> {
  logTaskStart('ComposeTask', 'regenerate-storyboard-audio', { storyboardId })
  const result = await ensureStoryboardAudio(storyboardId, { force: true })
  logTaskSuccess('ComposeTask', 'regenerate-storyboard-audio', { storyboardId, ...result })
  return result
}

interface AudioTrack {
  inputIndex: number
  start: number
  duration: number
  volume: number
  volumeExpr?: string
}

/**
 * 使用 complexFilter 混合音频轨道。
 * 每条轨道先裁剪到自身有效时长、调整音量（支持音量表达式）、延迟到指定开始时间、补齐到总长度，再 amix。
 * 图文叙事模式下旁白和对白按顺序播放，不再叠加。
 */
function mixAudioTracks(cmd: ffmpeg.FfmpegCommand, tracks: AudioTrack[], totalDuration: number): ffmpeg.FfmpegCommand {
  if (tracks.length === 0) return cmd

  const filters: ffmpeg.FilterSpecification[] = []

  tracks.forEach((track, i) => {
    const trimEnd = Math.min(track.duration, totalDuration - track.start)
    const delayMs = Math.round(track.start * 1000)
    filters.push(
      {
        filter: 'atrim',
        options: `start=0:end=${trimEnd}`,
        inputs: `${track.inputIndex}:a`,
        outputs: `t${i}`,
      },
      {
        filter: 'volume',
        options: track.volumeExpr || track.volume.toFixed(3),
        inputs: `t${i}`,
        outputs: `v${i}`,
      },
      {
        filter: 'adelay',
        options: `delays=${delayMs}|${delayMs}:all=1`,
        inputs: `v${i}`,
        outputs: `d${i}`,
      },
      {
        filter: 'apad',
        options: `whole_dur=${totalDuration}`,
        inputs: `d${i}`,
        outputs: `a${i}`,
      },
    )
  })

  const mixInputs = tracks.map((_, i) => `a${i}`)
  filters.push({
    filter: 'amix',
    options: `inputs=${tracks.length}:duration=first:dropout_transition=0:normalize=0`,
    inputs: mixInputs,
    outputs: 'mixed_raw',
  })

  filters.push({
    filter: 'loudnorm',
    options: 'I=-16:TP=-1.5:LRA=11',
    inputs: 'mixed_raw',
    outputs: 'mixed',
  })

  return cmd.complexFilter(filters)
}

/**
 * 合成单个镜头
 */
export async function composeStoryboard(storyboardId: number, options?: { force?: boolean }): Promise<string> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  const dialogueMode = ep?.dialogueMode || 'narration_only'

  const visualStyle = getEpisodeVisualStyle(sb.episodeId)

  if (visualStyle === 'image_story' && !sb.firstFrameImage) {
    throw new Error(`Storyboard ${storyboardId} 没有首帧图片，无法进入图文叙事合成`)
  }
  if (visualStyle === 'ai_video' && !sb.videoUrl) {
    throw new Error(`Storyboard ${storyboardId} 没有 AI 生成视频，无法进入 AI 视频合成`)
  }

  if (!options?.force && sb.composedVideoUrl) {
    return sb.composedVideoUrl
  }

  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  logTaskStart('ComposeTask', 'storyboard-compose', {
    storyboardId,
    storyboardNumber: sb.storyboardNumber,
    episodeId: sb.episodeId,
    visualStyle,
  })

  try {
    // 1. 准备音频（对白、旁白）
    const { ttsAudioUrl, narrationAudioUrl } = await ensureStoryboardAudio(storyboardId, { visualStyle, force: options?.force })

    // 2. 计算语音轨道与实际所需时长
    let narrationEnd = 0

    if (visualStyle === 'image_story' && narrationAudioUrl) {
      const narrationDuration = await getAudioDuration(toAbsPath(narrationAudioUrl))
      if (narrationDuration > 0) {
        narrationEnd = narrationDuration
      }
    }

    let dialogueDuration = 0
    if (ttsAudioUrl) {
      dialogueDuration = await getAudioDuration(toAbsPath(ttsAudioUrl))
    }

    const baseDuration = sb.duration || 8
    const audioDuration = narrationEnd + dialogueDuration
    // 图文叙事模式下，镜头时长由旁白+对白实际长度决定，不再用画面硬撑到 baseDuration
    const requiredDuration = visualStyle === 'image_story'
      ? (audioDuration > 0 ? audioDuration : baseDuration)
      : baseDuration
    const duration = Math.max(1, requiredDuration)

    // 3. 准备 BGM 与 SFX
    // 先根据旁白/描述推断音频画像，自动补全空缺的 bgm_prompt 和 sound_effect。
    const audioProfile = applyAudioProfileToStoryboard(storyboardId)

    // 每个分镜按自己的 bgm_prompt 生成/复用 BGM，集 mixer 会把各段拼接成情绪时间线。
    let bgmAudioUrl: string | null = null
    if (sb.bgmPrompt?.trim() || audioProfile.bgmPrompt) {
      try {
        bgmAudioUrl = await ensureStoryboardBGM(storyboardId, options)
      } catch (err: any) {
        logTaskWarn('ComposeTask', 'bgm-skip', { storyboardId, error: err.message })
      }
    }

    // 多样化 SFX：同一描述返回多个候选，按分镜序号轮询，避免相邻镜头反复用同一个文件。
    let sfxFilePath: string | null = null
    const effectiveSoundEffect = sb.soundEffect?.trim() || audioProfile.sfxDescriptions.join('; ')
    if (!isIgnorableSound(effectiveSoundEffect)) {
      const candidates = findSfxFiles(effectiveSoundEffect, 5)
      if (candidates.length > 0) {
        const rotationIndex = (sb.storyboardNumber - 1) % candidates.length
        sfxFilePath = candidates[rotationIndex]
      }
    }
    const sfxDuration = sfxFilePath && fs.existsSync(sfxFilePath) ? await getAudioDuration(sfxFilePath) : 0

    // 4. 生成字幕文件（ASS），根据 episode 字幕配置
    const subtitleConfig = readEpisodeSubtitleConfig(ep)
    const subtitleResult = await generateSubtitleFileForStoryboard(storyboardId, duration, subtitleConfig)
    const subtitlePath = subtitleResult?.absolutePath || null
    const burnSubtitle = subtitleConfig.enabled && subtitlePath && fs.existsSync(subtitlePath)

    // 5. 组装 Composition 并渲染
    // 注意：旁白和 BGM 被拆出到集级别 mix，单镜合成只保留
    // 对白、SFX 与环境底噪等非旁白音频。
    const audioLayers: AudioLayer[] = []

    if (ttsAudioUrl) {
      audioLayers.push({
        name: 'dialogue',
        filePath: toAbsPath(ttsAudioUrl),
        start: narrationEnd,
        duration: dialogueDuration,
        volume: 1.4,
      })
    }

    if (sfxFilePath && fs.existsSync(sfxFilePath)) {
      audioLayers.push({
        name: 'sfx',
        filePath: sfxFilePath,
        start: 0,
        duration: Math.min(sfxDuration || 3, duration),
        volume: SFX_VOLUME,
      })
    }

    const ambientDescription = [sb.soundEffect, sb.atmosphere, sb.location, sb.title, audioProfile.ambientDescription]
      .filter(Boolean)
      .join(' ')
    const ambientFilePath = ambientDescription ? findAmbientFile(ambientDescription) : null

    // 持久化本次实际选用的 SFX / Ambient，便于前端展示素材索引
    db.update(schema.storyboards)
      .set({
        sfxAudioUrl: sfxFilePath ? getSfxUrl(sfxFilePath) : null,
        ambientAudioUrl: ambientFilePath ? getSfxUrl(ambientFilePath) : null,
        updatedAt: now(),
      })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()

    if (ambientFilePath && fs.existsSync(ambientFilePath)) {
      const ambientDuration = await getAudioDuration(ambientFilePath)
      // 环境底噪必须是足够长的音频；把短音效循环播放会导致“同一段音效反复出现”
      const MIN_AMBIENT_LOOP_DURATION = 5.0
      if (ambientDuration >= MIN_AMBIENT_LOOP_DURATION) {
        audioLayers.push({
          name: 'ambience',
          filePath: ambientFilePath,
          start: 0,
          duration: Math.min(ambientDuration, duration),
          volume: 0.12,
          loop: true,
        })
      } else {
        logTaskWarn('ComposeTask', 'ambient-too-short', { storyboardId, ambientFilePath, ambientDuration })
      }
    }

    const ratio = getEpisodeAspectRatio(sb.episodeId)
    const { width, height } = ratioToDimensions(ratio)
    const outputDir = path.join(STORAGE_ROOT, 'composed')
    fs.mkdirSync(outputDir, { recursive: true })

    const overlays: (SubtitleOverlay | GrainVignetteOverlay)[] = []
    if (burnSubtitle) {
      overlays.push({
        kind: 'subtitle',
        start: 0,
        duration,
        params: { subtitlePath },
      })
    }

    // 胶片颗粒 + 暗角：默认 lightly applied
    overlays.push({
      kind: 'grain-vignette',
      start: 0,
      duration,
      params: { grainIntensity: 0.05, vignetteIntensity: 0.12 },
    })

    const composition = buildStoryboardComposition({
      outputDir,
      width,
      height,
      duration,
      baseImagePath: visualStyle === 'image_story' ? sb.firstFrameImage! : undefined,
      baseVideoPath: visualStyle === 'ai_video' ? sb.videoUrl! : undefined,
      motion: visualStyle === 'image_story' ? (parseMovement(sb.movement) ?? buildDeterministicMotionPlan(sb.id)) : undefined,
      audioLayers,
    })
    composition.video.overlays = overlays

    const renderResult = await renderStoryboardComposition(composition)
    const outputPath = renderResult.outputPath
    const outputFilename = path.basename(outputPath)
    const composedRelative = `static/composed/${outputFilename}`
    db.update(schema.storyboards).set({
      composedVideoUrl: composedRelative,
      status: 'compose_completed',
      duration,
      subtitleUrl: subtitlePath ? `static/subtitles/${path.basename(subtitlePath)}` : null,
      updatedAt: now(),
    }).where(eq(schema.storyboards.id, storyboardId)).run()

    logTaskSuccess('ComposeTask', 'storyboard-compose', {
      storyboardId,
      storyboardNumber: sb.storyboardNumber,
      visualStyle,
      output: composedRelative,
      bgm: !!bgmAudioUrl,
      sfx: !!sfxFilePath,
    })
    return composedRelative
  } catch (err) {
    db.update(schema.storyboards)
      .set({ status: 'compose_failed', composedVideoUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    throw err
  }
}
