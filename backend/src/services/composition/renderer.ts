/**
 * 把 StoryboardComposition 渲染成 MP4
 *
 * 核心思路：
 * - 视频轨道：底图/视频 -> scale/pad -> zoompan/运动 -> 叠加层 -> output
 * - 音频轨道：每条音频层 -> atrim -> volume -> adelay -> apad -> amix -> loudnorm -> output
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AudioLayer, MotionPlan, RenderResult, StoryboardComposition, VideoLayer } from './types.js'
import { getVideoEncoderOptions } from './video-encoder.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FPS = 30

export function motionPlanToZoompan(
  motion: MotionPlan | undefined,
  width: number,
  height: number,
  duration: number,
): string | null {
  if (!motion || motion.kind === 'static') return null

  const totalFrames = Math.max(1, Math.round(duration * FPS))
  const kfs = motion.keyframes
  if (!kfs || kfs.length < 2) return null

  // 单段 Ken Burns / 平移：用线性插值
  if (kfs.length === 2) {
    const start = kfs[0]
    const end = kfs[1]
    const zExpr = `${start.zoom}+(${end.zoom - start.zoom})*on/${totalFrames - 1 || 1}`
    const xExpr = `iw*(${start.focusX}+(${end.focusX - start.focusX})*on/${totalFrames - 1 || 1})-iw/(2*zoom)`
    const yExpr = `ih*(${start.focusY}+(${end.focusY - start.focusY})*on/${totalFrames - 1 || 1})-ih/(2*zoom)`
    return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${width}x${height}:fps=${FPS}`
  }

  // 多段关键帧：用 sendcmd + zoompan 表达式分段
  // 为了简化，先退化成第一段到最后一端的线性运动；后续可按 t 分段插值
  const start = kfs[0]
  const end = kfs[kfs.length - 1]
  const zExpr = `${start.zoom}+(${end.zoom - start.zoom})*on/${totalFrames - 1 || 1}`
  const xExpr = `iw*(${start.focusX}+(${end.focusX - start.focusX})*on/${totalFrames - 1 || 1})-iw/(2*zoom)`
  const yExpr = `ih*(${start.focusY}+(${end.focusY - start.focusY})*on/${totalFrames - 1 || 1})-ih/(2*zoom)`
  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${width}x${height}:fps=${FPS}`
}

function buildBaseVideoFilter(layer: VideoLayer): string {
  const { width, height, type, duration, motion } = layer
  const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
  const zoompan = motionPlanToZoompan(motion, width, height, duration)
  const filters = [scalePad]
  if (zoompan) {
    filters.push(zoompan)
  }
  filters.push(`trim=duration=${duration}`)
  return filters.join(',')
}

function escapeDrawtextFontPath(fontPath: string): string {
  return fontPath.replace(/'/g, "'\\''")
}

function buildVideoFilter(layer: VideoLayer): string {
  const base = buildBaseVideoFilter(layer)
  const styleFilters: string[] = [base]
  const textFilters: string[] = []

  for (const overlay of layer.overlays || []) {
    switch (overlay.kind) {
      case 'subtitle': {
        const subtitlePath = (overlay.params as { subtitlePath: string }).subtitlePath
        const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:')
        textFilters.push(`subtitles=${escapedPath}`)
        break
      }
      case 'grain-vignette': {
        const { grainIntensity, vignetteIntensity } = overlay.params as { grainIntensity: number; vignetteIntensity: number }
        const noiseAmount = Math.max(1, Math.round(grainIntensity * 255))
        const vignetteAngle = Math.max(0.1, vignetteIntensity * Math.PI / 2)
        styleFilters.push(`noise=alls=${noiseAmount}:allf=t+u`)
        styleFilters.push(`vignette=angle=${vignetteAngle.toFixed(3)}`)
        break
      }
      case 'title': {
        const { text, fontPath } = overlay.params as { text: string; fontPath?: string }
        const safeText = text.replace(/'/g, "'\\''")
        const safeFont = fontPath ? escapeDrawtextFontPath(fontPath) : undefined
        const fontFileOption = safeFont ? `fontfile='${safeFont}':` : ''
        textFilters.push(
          `drawtext=${fontFileOption}text='${safeText}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.5:boxborderw=16:x=(w-text_w)/2:y=(h-text_h)/3:enable='between(t\\,${overlay.start.toFixed(3)}\\,${(overlay.start + overlay.duration).toFixed(3)})'`
        )
        break
      }
      case 'title-reveal': {
        const {
          text,
          fontPath,
          fontSize = 72,
          fontColor = 'white',
          borderColor,
          borderWidth = 0,
          fadeIn = 1.0,
          fadeOut = 0.5,
          riseOffset = 80,
        } = overlay.params as {
          text: string
          fontPath?: string
          fontSize?: number
          fontColor?: string
          borderColor?: string
          borderWidth?: number
          fadeIn?: number
          fadeOut?: number
          riseOffset?: number
        }
        const safeText = text.replace(/'/g, "'\\''")
        const safeFont = fontPath ? escapeDrawtextFontPath(fontPath) : undefined
        const fontFileOption = safeFont ? `fontfile='${safeFont}':` : ''
        const borderOption = borderWidth > 0 && borderColor ? `:borderw=${borderWidth}:bordercolor=${borderColor}` : ''
        const start = overlay.start
        const end = overlay.start + overlay.duration
        const fadeInExpr = fadeIn > 0 ? `(t-${start.toFixed(3)})/${fadeIn.toFixed(3)}` : '1'
        const fadeOutExpr = fadeOut > 0 ? `(${end.toFixed(3)}-t)/${fadeOut.toFixed(3)}` : '1'
        const alphaExpr = `if(lt(t\,${start.toFixed(3)})\,0\,if(lt(t\,${(start + fadeIn).toFixed(3)})\,${fadeInExpr}\,if(lt(t\,${(end - fadeOut).toFixed(3)})\,1\,if(lt(t\,${end.toFixed(3)})\,${fadeOutExpr}\,0))))`
        const yExpr = `h/2-text_h/2+${riseOffset}*(1-${alphaExpr})`
        textFilters.push(
          `drawtext=${fontFileOption}text='${safeText}':fontcolor=${fontColor}:fontsize=${fontSize}${borderOption}:alpha='${alphaExpr}':x=(w-text_w)/2:y='${yExpr}':enable='between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})'`
        )
        break
      }
      case 'title-flash': {
        const {
          text,
          fontPath,
          fontSize = 96,
          fontColor = 'white',
          borderColor,
          borderWidth = 0,
          fadeIn = 0.15,
          fadeOut = 0.15,
        } = overlay.params as {
          text: string
          fontPath?: string
          fontSize?: number
          fontColor?: string
          borderColor?: string
          borderWidth?: number
          fadeIn?: number
          fadeOut?: number
        }
        const safeText = text.replace(/'/g, "'\\''")
        const safeFont = fontPath ? escapeDrawtextFontPath(fontPath) : undefined
        const fontFileOption = safeFont ? `fontfile='${safeFont}':` : ''
        const borderOption = borderWidth > 0 && borderColor ? `:borderw=${borderWidth}:bordercolor=${borderColor}` : ''
        const start = overlay.start
        const end = overlay.start + overlay.duration
        const fadeInExpr = fadeIn > 0 ? `(t-${start.toFixed(3)})/${fadeIn.toFixed(3)}` : '1'
        const fadeOutExpr = fadeOut > 0 ? `(${end.toFixed(3)}-t)/${fadeOut.toFixed(3)}` : '1'
        const alphaExpr = `if(lt(t\,${start.toFixed(3)})\,0\,if(lt(t\,${(start + fadeIn).toFixed(3)})\,${fadeInExpr}\,if(lt(t\,${(end - fadeOut).toFixed(3)})\,1\,if(lt(t\,${end.toFixed(3)})\,${fadeOutExpr}\,0))))`
        textFilters.push(
          `drawtext=${fontFileOption}text='${safeText}':fontcolor=${fontColor}:fontsize=${fontSize}${borderOption}:alpha='${alphaExpr}':x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})'`
        )
        break
      }
      case 'sepia': {
        const { intensity = 0.8 } = overlay.params as { intensity?: number }
        const sat = 1 - intensity * 0.85
        const mix = intensity
        styleFilters.push(
          `eq=saturation=${sat.toFixed(2)}:contrast=1.05:brightness=0.02,colorchannelmixer=${mix * 0.393}:${mix * 0.769}:${mix * 0.189}:0:${mix * 0.349}:${mix * 0.686}:${mix * 0.168}:0:${mix * 0.272}:${mix * 0.534}:${mix * 0.131}`
        )
        break
      }
      case 'vintage-look': {
        const { intensity = 0.7 } = overlay.params as { intensity?: number }
        const blur = Math.max(0.5, intensity * 1.2)
        const sat = 1 - intensity * 0.7
        const contrast = 1 + intensity * 0.1
        styleFilters.push(
          `eq=saturation=${sat.toFixed(2)}:contrast=${contrast.toFixed(2)}:brightness=0.0,boxblur=lr=${blur.toFixed(1)}:lp=2` +
          `,colorchannelmixer=${intensity * 0.393}:${intensity * 0.769}:${intensity * 0.189}:0:${intensity * 0.349}:${intensity * 0.686}:${intensity * 0.168}:0:${intensity * 0.272}:${intensity * 0.534}:${intensity * 0.131}`
        )
        break
      }
      case 'fade-from-black': {
        const { fadeDuration = 1.5 } = overlay.params as { fadeDuration?: number }
        const fd = Math.max(0.1, fadeDuration)
        // 在滤镜链末尾追加 fade=t=in，让画面从黑场淡入
        styleFilters.push(`fade=t=in:st=0:d=${fd.toFixed(3)}`)
        break
      }
    }
  }

  // 组合顺序：风格滤镜 -> 文字叠加
  const styleChain = styleFilters.join(',')
  const textChain = textFilters.join(',')
  return textChain ? `${styleChain},${textChain}` : styleChain
}

function buildAudioFilters(layers: AudioLayer[], totalDuration: number, inputOffset: number): ffmpeg.FilterSpecification[] {
  const filters: ffmpeg.FilterSpecification[] = []

  layers.forEach((layer, i) => {
    const inputIndex = inputOffset + i
    const trimEnd = Math.min(layer.duration, totalDuration - layer.start)
    const delayMs = Math.round(layer.start * 1000)
    filters.push(
      {
        filter: 'atrim',
        options: `start=0:end=${trimEnd}`,
        inputs: `${inputIndex}:a`,
        outputs: `t${i}`,
      },
      {
        filter: 'volume',
        options: layer.volumeExpr || layer.volume.toFixed(3),
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

  if (layers.length > 0) {
    const mixInputs = layers.map((_, i) => `a${i}`)
    filters.push({
      filter: 'amix',
      options: `inputs=${layers.length}:duration=first:dropout_transition=0:normalize=0`,
      inputs: mixInputs,
      outputs: 'mixed_raw',
    })
    filters.push({
      filter: 'loudnorm',
      options: 'I=-16:TP=-1.5:LRA=11',
      inputs: 'mixed_raw',
      outputs: 'mixed',
    })
  }

  return filters
}

export async function renderStoryboardComposition(
  comp: StoryboardComposition,
): Promise<RenderResult> {
  fs.mkdirSync(path.dirname(comp.outputPath), { recursive: true })

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(comp.video.filePath)

    if (comp.video.type === 'image') {
      cmd = cmd.inputOptions(['-loop', '1'])
    }

    const outputOptions = [
      '-t', String(comp.duration),
      ...getVideoEncoderOptions(),
      '-pix_fmt', 'yuv420p',
      '-r', String(FPS),
    ]

    const videoFilter = buildVideoFilter(comp.video)

    if (comp.audio.length > 0) {
      for (const layer of comp.audio) {
        if (layer.loop) {
          cmd = cmd.input(layer.filePath).inputOptions(['-stream_loop', '-1'])
        } else {
          cmd = cmd.input(layer.filePath)
        }
      }

      const audioFilters = buildAudioFilters(comp.audio, comp.duration, 1)
      cmd = cmd.complexFilter(audioFilters)
      outputOptions.push('-map', '0:v')
      outputOptions.push('-map', '[mixed]')
      outputOptions.push('-c:a', 'aac')
      outputOptions.push('-ar', '48000')
      outputOptions.push('-ac', '2')
      outputOptions.push('-b:a', '192k')
    } else {
      // 无音频时输出静音轨道，避免后续 concat 出问题
      const silentPath = path.resolve(__dirname, '../../../../data/static/audio/silent-10min.m4a')
      cmd = cmd.input(silentPath)
      outputOptions.push('-map', '0:v')
      outputOptions.push('-map', '1:a')
      outputOptions.push('-c:a', 'aac')
      outputOptions.push('-ar', '48000')
      outputOptions.push('-ac', '2')
      outputOptions.push('-b:a', '192k')
      outputOptions.push('-shortest')
    }

    cmd
      .videoFilter(videoFilter)
      .outputOptions(outputOptions)
      .output(comp.outputPath)
      .on('end', () => {
        resolve({
          outputPath: comp.outputPath,
          duration: comp.duration,
          hasVideo: true,
          hasAudio: comp.audio.length > 0,
        })
      })
      .on('error', (err) => reject(err))
      .run()
  })
}
