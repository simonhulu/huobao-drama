#!/usr/bin/env node
/**
 * 原型（评估用，非生产路径）：动态镜头流样片渲染器 dynamic-flow-v3
 *
 * 调研结论的工程化：高留存叙事视频的共性是 world motion——画面里的世界自己在动。
 * v3 = v0 视觉基线（匀速推镜/灯火闪烁/主体强调/水墨过场/颗粒，用户评价「不错」的版本）
 *   + Tier B：关键 beat 用 MiniMax 图生视频（Hailuo-2.3, 768P）替代静态图——
 *     真实人物动作与火焰动态，推镜放缓（zoom 0.004 io），跳过闪烁/强调遮罩；
 *   + v2 声音设计（旁白为主、episode BGM sidechain 闪避铺底、风声氛围床、
 *     扫场/水墨过场 whoosh 音效、alimiter 防爆音）。
 * v2 的节奏化运镜/拉镜/vignette/双八度水墨已被回退（用户评价「不好」）。
 *
 * 时序契约：转场以「B 段头部扩展」方式吸收重叠，beat 边界帧与字幕/音频严格对齐，
 * 总帧数 = Σ beat 窗口 = props.durationInFrames。视频 beat 长度不足时末帧克隆补齐。
 *
 * 用法:
 *   node dynamic_flow_sample_renderer.mjs --props <props.json> --output <video.mp4>
 *     [--audio-from <video.mp4>] [--bgm <audio>] [--ambience <audio>] [--work-dir <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  FPS, WIDTH, HEIGHT, MOTION_WIDTH, MOTION_MARGIN_Y, subtitleTextPlan,
} from './dharma_comic_native_core.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')

const FONT_SANS = join(repoRoot, 'data/fonts/NotoSansCJKsc-Regular.otf')
const MASK_W = 320
const MASK_H = 180
const SFX_DIR = 'data/sfx/library/100-cc0-sfx-v2'

// ---------------------------------------------------------------------------
// 创意配置（按 ep767 素材人工导演；生产化时由 plan/导演代理产出）
// 坐标为 1280x720 屏幕空间。
// zoom = 每秒推近倍率；ease ∈ io(缓入缓出) | out(快起缓收) | pullback(拉镜揭示) | linear(v0 匀速)；
// drift = 每秒横向漂移像素（正=向右=深入，负=向左=回望）。
// video 可选：该 beat 用 MiniMax 图生视频替代静态图（真实火焰/人物自带动态，
// 跳过灯火闪烁与主体强调遮罩，推镜放缓）。
// ---------------------------------------------------------------------------
const BEATS = [
  { push: [700, 390], glow: [762, 300, 150], emphasis: [700, 400, 380], zoom: 0.004, ease: 'io', drift: 0.6, video: 'data/temp/ep767-mm-b1.mp4' },
  { push: [600, 230], glow: [58, 250, 160], emphasis: [620, 230, 340], zoom: 0.008, ease: 'linear', drift: 1.5 },
  { push: [500, 320], glow: [38, 200, 140], emphasis: [520, 330, 330], zoom: 0.008, ease: 'linear', drift: 1.5 },
  { push: [240, 250], glow: [64, 275, 150], emphasis: [220, 240, 320], zoom: 0.008, ease: 'linear', drift: 1.5 },
  { push: [420, 310], glow: [385, 300, 150], emphasis: [420, 320, 360], zoom: 0.004, ease: 'io', drift: 0.5, video: 'data/temp/ep767-mm-b5.mp4' },
  { push: [620, 270], glow: [455, 215, 130], emphasis: [620, 270, 350], zoom: 0.008, ease: 'linear', drift: 1.5 },
  { push: [660, 340], glow: [1222, 80, 140], emphasis: [660, 350, 340], zoom: 0.008, ease: 'linear', drift: 1.5 },
]
// 边界转场：type ∈ wipe-l | wipe-r | fade | ink；frames = 重叠帧数；
// sfx 可选：file/volume/lead(提前秒)/pitch(降调)/maxDur(截断秒)。
const TRANSITIONS = [
  { type: 'wipe-l', frames: 12, sfx: { file: 'sfx100v2_air_02.mp3', volume: 0.45, lead: 0.20 } }, // b1 门缝脚步声：威胁从左侧扫入
  { type: 'fade', frames: 18 },   // b2 同屋书写：软承接
  { type: 'fade', frames: 8 },    // b3 手心汗：快速微切
  { type: 'ink', frames: 33, sfx: { file: 'sfx100v2_air_01.mp3', volume: 0.5, lead: 0.35, pitch: 0.65, maxDur: 2.6 } }, // b4 后半夜：水墨晕染签名过场
  { type: 'wipe-r', frames: 11, sfx: { file: 'sfx100v2_air_03.mp3', volume: 0.5, lead: 0.05 } }, // b5 缠足：反方向扫场=换空间
  { type: 'fade', frames: 24 },   // b6 就为活命：缓慢亲密叠化
]

function fail(message) {
  console.error(`dynamic_flow_sample_renderer: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`)
    options[key.slice(2).replaceAll('-', '_')] = argv[index + 1]
    index += 1
  }
  return options
}

/** 滤镜图内表达式：转义逗号防止被当作滤镜分隔符。 */
function esc(expression) {
  return expression.replaceAll(',', '\\,')
}

function drawtextEscape(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '%%')
}

// ---------------------------------------------------------------------------
// L3r 节奏化推镜：与 core narrativePushMotionFilter 同构（perspective 目的地映射 +
// 左上裁剪），但 zoom/drift 按 beat 配置，zoom 支持缓动曲线与拉镜。
// ---------------------------------------------------------------------------
function rhythmicPushFilter(beat, extFrames, input, output) {
  const cx = Number.isFinite(beat.push?.[0]) ? beat.push[0] : WIDTH / 2
  const cy = (Number.isFinite(beat.push?.[1]) ? beat.push[1] : HEIGHT / 2) + MOTION_MARGIN_Y
  const N = extFrames
  const Z = (beat.zoom * N) / FPS
  const t = `in/${N}`
  let zoom
  if (beat.ease === 'pullback') {
    zoom = `(1+${Z.toFixed(6)}*pow(1-${t}\\,3))` // 从 Z 缓出到 0：拉镜揭示
  } else if (beat.ease === 'out') {
    zoom = `(1+${Z.toFixed(6)}*(1-pow(1-${t}\\,3)))` // 快起缓收
  } else if (beat.ease === 'linear') {
    zoom = `(1+${((beat.zoom || 0) / FPS).toFixed(9)}*in)` // v0 匀速
  } else {
    zoom = `(1+${Z.toFixed(6)}*(3*pow(${t}\\,2)-2*pow(${t}\\,3)))` // 缓入缓出
  }
  const drift = `${((beat.drift || 0) / FPS).toFixed(6)}*in`
  const x0 = `${cx}-${cx}*${zoom}-${drift}`
  const y0 = `${cy}-${cy}*${zoom}`
  const x1 = `${cx}+${MOTION_WIDTH - cx}*${zoom}-${drift}`
  const y2 = `${cy}+${732 - cy}*${zoom}`
  return `[${input}]perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':sense=destination:interpolation=linear:eval=frame,crop=${WIDTH}:${HEIGHT}:x=0:y=${MOTION_MARGIN_Y}[${output}]`
}

// ---------------------------------------------------------------------------
// L2 生命层 mask 表达式（320x180 低分辨率生成，双线性放大——软遮罩无需全分辨率）
// ---------------------------------------------------------------------------
function glowMaskChain(beat, durationSec, label) {
  const [gx, gy, gr] = beat.glow
  const X = (gx / 4).toFixed(1)
  const Y = (gy / 4).toFixed(1)
  const R = (gr / 4).toFixed(1)
  const lum = `max(0\\,1-hypot(X-${X}\\,Y-${Y})/${R})*(110+70*sin(2*PI*T*5.5)+45*sin(2*PI*T*11))`
  return `nullsrc=size=${MASK_W}x${MASK_H}:rate=${FPS}:d=${durationSec.toFixed(3)},`
    + `geq=lum='${lum}':cb=128:cr=128,format=gray,scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=yuv420p[${label}]`
}

function emphasisMaskChain(beat, durationSec, label) {
  const [ex, ey, er] = beat.emphasis
  const X = (ex / 4).toFixed(1)
  const Y = (ey / 4).toFixed(1)
  const R = (er / 4).toFixed(1)
  const lum = `max(0\\,1-hypot(X-${X}\\,Y-${Y})/${R})*min(1\\,T/1.2)*50`
  return `nullsrc=size=${MASK_W}x${MASK_H}:rate=${FPS}:d=${durationSec.toFixed(3)},`
    + `geq=lum='${lum}':cb=128:cr=128,format=gray,scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=yuv420p[${label}]`
}

// ---------------------------------------------------------------------------
// L1 转场 mask（0→255 生长，maskedmerge(first=B, second=A)）
// ---------------------------------------------------------------------------
function transitionMaskChain(transition, label) {
  const tau = (transition.frames / FPS).toFixed(6)
  const dur = (transition.frames / FPS).toFixed(3)
  const src = `nullsrc=size=${MASK_W}x${MASK_H}:rate=${FPS}:d=${dur}`
  if (transition.type === 'fade') {
    return `${src},geq=lum='255*min(1\\,T/${tau})':cb=128:cr=128,format=gray,`
      + `scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=yuv420p[${label}]`
  }
  if (transition.type === 'wipe-l') {
    const edge = `(${MASK_W + 30})*T/${tau}`
    return `${src},geq=lum='255*clip((${esc(edge)}-X)/30\\,0\\,1)':cb=128:cr=128,format=gray,`
      + `scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=yuv420p[${label}]`
  }
  if (transition.type === 'wipe-r') {
    const edge = `(${MASK_W + 30})*T/${tau}`
    return `${src},geq=lum='255*clip((X-(${MASK_W}-${esc(edge)}))/30\\,0\\,1)':cb=128:cr=128,format=gray,`
      + `scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=yuv420p[${label}]`
  }
  if (transition.type === 'ink') {
    // 双八度噪声 + 对角流向偏置：墨从左上种子点向右下漫开，边缘带笔触碎裂感
    const field = `(sin(X*12.9898+Y*78.233)*43758.5453)-floor(sin(X*12.9898+Y*78.233)*43758.5453)`
    const threshold = `255*clip((lum(X\\,Y)/255-(1-T/${tau})*0.9-0.05)/0.22\\,0\\,1)`
    return `${src},geq=lum='255*${field}':cb=128:cr=128,gblur=sigma=10,`
      + `geq=lum='${threshold}':cb=128:cr=128,format=gray,`
      + `scale=${WIDTH}:${HEIGHT}:flags=bilinear,format=yuv420p[${label}]`
  }
  throw new Error(`Unknown transition type: ${transition.type}`)
}

function subtitleFilters(subtitles) {
  const filters = []
  for (const subtitle of subtitles) {
    const plan = subtitleTextPlan(subtitle.text)
    if (!plan.lines.length) continue
    const lineHeight = plan.fontSize * 1.34
    const blockHeight = lineHeight * plan.lines.length
    plan.lines.forEach((line, lineIndex) => {
      const y = HEIGHT - 64 - blockHeight + lineIndex * lineHeight
      const start = Number(subtitle.startSec)
      const end = Number(subtitle.endSec)
      const alpha = `if(lt(t\\,${start})\\,0\\,if(lt(t\\,${start + 0.25})\\,(t-${start})/0.25\\,if(gt(t\\,${end - 0.15})\\,max(0\\,(${end}-t)/0.15)\\,1)))`
      filters.push(
        `drawtext=fontfile='${FONT_SANS}':text='${drawtextEscape(line)}':fontcolor=white:fontsize=${plan.fontSize}`
        + `:borderw=2:bordercolor=0x000000CC:x=(w-text_w)/2:y=${y.toFixed(1)}`
        + `:alpha='${alpha}':enable='between(t\\,${start}\\,${end})'`,
      )
    })
  }
  return filters
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.props || !options.output) {
    fail('Usage: dynamic_flow_sample_renderer.mjs --props <props.json> --output <video.mp4> [--audio-from <video.mp4>] [--bgm <audio>] [--ambience <audio>] [--work-dir <dir>]')
  }
  const props = JSON.parse(readFileSync(resolve(repoRoot, options.props), 'utf8'))
  if (props.variant !== 'progressive_five') fail('Prototype only accepts progressive_five props')
  const panels = props.panels
  if (panels.length !== BEATS.length || TRANSITIONS.length !== panels.length - 1) {
    fail(`Curated config mismatch: ${panels.length} panels vs ${BEATS.length} beat configs`)
  }

  const durationFrames = Number(props.durationInFrames)
  const narrationEndFrame = Number(props.narrationEndFrame || durationFrames)
  const starts = panels.map((panel) => Number(panel.emphasisStartFrame))
  const ends = starts.slice(1).concat([narrationEndFrame])
  const windows = starts.map((start, index) => ({ start, end: ends[index] }))
  windows[windows.length - 1].end = durationFrames // 末 beat 含尾奏

  for (const panel of panels) {
    if (!existsSync(panel.src)) fail(`Panel image missing: ${panel.src}`)
  }

  const audioFrom = options.audio_from ? resolve(repoRoot, options.audio_from) : null
  const bgmPath = options.bgm ? resolve(repoRoot, options.bgm) : null
  const ambiencePath = options.ambience ? resolve(repoRoot, options.ambience) : null
  if (audioFrom && !existsSync(audioFrom)) fail(`Audio source missing: ${audioFrom}`)
  if (bgmPath && !existsSync(bgmPath)) fail(`BGM missing: ${bgmPath}`)
  if (ambiencePath && !existsSync(ambiencePath)) fail(`Ambience missing: ${ambiencePath}`)
  // 转场音效：转场在输出流中的起始帧 = 该 beat 窗口末 - 重叠帧数
  const sfxCues = TRANSITIONS.map((transition, i) => {
    if (!transition.sfx || !audioFrom) return null
    const file = resolve(repoRoot, SFX_DIR, transition.sfx.file)
    if (!existsSync(file)) fail(`SFX missing: ${file}`)
    const startFrame = windows[i].end - transition.frames
    const delayMs = Math.max(0, Math.round((startFrame / FPS - (transition.sfx.lead || 0)) * 1000))
    return { ...transition.sfx, file, delayMs }
  }).filter(Boolean)

  const workDir = resolve(repoRoot, options.work_dir || `data/temp/dynamic-flow-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })

  const args = ['-hide_banner', '-y']
  panels.forEach((panel, i) => {
    const beat = BEATS[i]
    if (beat.video) {
      const videoPath = resolve(repoRoot, beat.video)
      if (!existsSync(videoPath)) fail(`Beat video missing: ${videoPath}（先跑 minimax_img2video_pilot.mjs 生成）`)
      args.push('-i', videoPath)
    } else {
      args.push('-loop', '1', '-framerate', String(FPS), '-i', panel.src)
    }
  })
  let audioIndex = panels.length
  const idx = {}
  if (audioFrom) { idx.narration = audioIndex; args.push('-i', audioFrom); audioIndex += 1 }
  if (bgmPath) { idx.bgm = audioIndex; args.push('-i', bgmPath); audioIndex += 1 }
  if (ambiencePath) { idx.ambience = audioIndex; args.push('-i', ambiencePath); audioIndex += 1 }
  idx.sfx = sfxCues.map((cue) => { const i = audioIndex; args.push('-i', cue.file); audioIndex += 1; return i })

  const graph = []
  // ---- 每 beat：scale → 扩展时长 → 节奏化推镜 → 生命层（灯火闪烁+主体强调） ----
  const segParts = [] // 每个 beat 供 concat 的 {main, head, tail} 标签
  panels.forEach((panel, i) => {
    const tauPrev = i > 0 ? TRANSITIONS[i - 1].frames : 0
    const tauNext = i < TRANSITIONS.length ? TRANSITIONS[i].frames : 0
    const extFrames = windows[i].end - windows[i].start + tauPrev
    const extSec = extFrames / FPS
    const beat = BEATS[i]
    if (beat.video) {
      // 真视频 beat：归一化到 1300x732@30，长度不足用末帧克隆补齐，跳过灯火/强调遮罩
      graph.push(
        `[${i}:v]fps=${FPS},scale=1300:732:flags=bilinear,format=yuv420p,tpad=stop_mode=clone:stop=${extSec.toFixed(3)},trim=end_frame=${extFrames},setpts=PTS-STARTPTS[raw${i}]`,
        rhythmicPushFilter(beat, extFrames, `raw${i}`, `life${i}`),
      )
    } else {
      graph.push(
        `[${i}:v]scale=1300:732,format=yuv420p,trim=end_frame=${extFrames},setpts=PTS-STARTPTS[raw${i}]`,
        rhythmicPushFilter(beat, extFrames, `raw${i}`, `push${i}`),
        `[push${i}]split=3[pa${i}][pbw${i}][pbe${i}]`,
        `[pbw${i}]eq=brightness=0.07:saturation=1.18,colortemperature=4500[lit${i}g]`,
        `[pbe${i}]eq=brightness=0.05:saturation=1.05[lit${i}e]`,
        glowMaskChain(beat, extSec, `gm${i}`),
        emphasisMaskChain(beat, extSec, `em${i}`),
        `[pa${i}][lit${i}g][gm${i}]maskedmerge[glowed${i}]`,
        `[glowed${i}][lit${i}e][em${i}]maskedmerge[life${i}]`,
      )
    }
    const parts = {}
    const mainEnd = extFrames - tauNext
    if (tauPrev > 0) parts.head = `hd${i}`
    parts.main = `mn${i}`
    if (tauNext > 0) parts.tail = `tl${i}`
    const splitOutputs = [parts.main, parts.head, parts.tail].filter(Boolean)
    graph.push(`[life${i}]split=${splitOutputs.length}${splitOutputs.map((name) => `[${name}sp]`).join('')}`)
    if (parts.head) graph.push(`[${parts.head}sp]trim=end_frame=${tauPrev},setpts=PTS-STARTPTS[${parts.head}]`)
    graph.push(`[${parts.main}sp]trim=start_frame=${tauPrev}:end_frame=${mainEnd},setpts=PTS-STARTPTS[${parts.main}]`)
    if (parts.tail) graph.push(`[${parts.tail}sp]trim=start_frame=${mainEnd},setpts=PTS-STARTPTS[${parts.tail}]`)
    segParts.push(parts)
  })

  // ---- 每边界：maskedmerge(B_head, A_tail, mask) ----
  TRANSITIONS.forEach((transition, i) => {
    graph.push(
      transitionMaskChain(transition, `tm${i}`),
      `[${segParts[i].tail}][${segParts[i + 1].head}][tm${i}]maskedmerge[bl${i}]`,
    )
  })

  // ---- concat：main0, bl0, main1, bl1, ... ----
  const concatInputs = []
  segParts.forEach((parts, i) => {
    concatInputs.push(`[${parts.main}]`)
    if (i < TRANSITIONS.length) concatInputs.push(`[bl${i}]`)
  })
  graph.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[assembled]`)

  // ---- 氛围层：胶片颗粒（v0 配方，无 vignette） ----
  graph.push('[assembled]noise=alls=5:allf=t+u[grained]')

  const subtitles = subtitleFilters(props.subtitles || [])
  if (subtitles.length) graph.push(`[grained]${subtitles.join(',')}[final]`)
  const finalLabel = subtitles.length ? 'final' : 'grained'

  // ---- 声音设计：旁白为主，BGM sidechain 闪避铺底，氛围床 + 转场音效 ----
  const audioGraph = []
  if (audioFrom) {
    const totalSec = (durationFrames / FPS).toFixed(3)
    const mixInputs = ['[nar]']
    audioGraph.push(`[${idx.narration}:a]asplit=2[nar][narsc]`)
    if (idx.bgm !== undefined) {
      audioGraph.push(
        `[${idx.bgm}:a]atrim=0:${totalSec},asetpts=PTS-STARTPTS,`
        + `afade=t=in:st=0:d=1.5,afade=t=out:st=${(totalSec - 4).toFixed(3)}:d=4,volume=0.35[bgmr]`,
        `[bgmr][narsc]sidechaincompress=threshold=0.01:ratio=1.5:attack=400:release=1500[bgm]`,
      )
      mixInputs.push('[bgm]')
    }
    if (idx.ambience !== undefined) {
      audioGraph.push(`[${idx.ambience}:a]aloop=loop=-1:size=2147483647,atrim=0:${totalSec},volume=0.045[amb]`)
      mixInputs.push('[amb]')
    }
    sfxCues.forEach((cue, i) => {
      let chain = `[${idx.sfx[i]}:a]`
      if (cue.pitch) chain += `aresample=48000,asetrate=${Math.round(48000 * cue.pitch)},aresample=48000,`
      if (cue.maxDur) chain += `atrim=0:${cue.maxDur},afade=t=out:st=${(cue.maxDur - 0.6).toFixed(1)}:d=0.6,`
      chain += `volume=${cue.volume},adelay=${cue.delayMs}:all=1[sfx${i}]`
      audioGraph.push(chain)
      mixInputs.push(`[sfx${i}]`)
    })
    audioGraph.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0,`
      + `alimiter=limit=0.92[mix]`,
    )
  }

  const filterScript = [...graph, ...audioGraph].join(';')
  const scriptPath = join(workDir, 'filtergraph.txt')
  writeFileSync(scriptPath, filterScript)

  const outputPath = resolve(repoRoot, options.output)
  const ffArgs = [...args, '-/filter_complex', scriptPath, '-map', `[${finalLabel}]`]
  if (audioFrom) ffArgs.push('-map', '[mix]', '-c:a', 'aac', '-b:a', '192k')
  ffArgs.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-t', (durationFrames / FPS).toFixed(6), '-movflags', '+faststart', outputPath,
  )
  const started = performance.now()
  const proc = spawnSync('ffmpeg', ffArgs, { encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  if (proc.status !== 0) fail(`ffmpeg exited ${proc.status}: ${String(proc.stderr || '').slice(-2500)}`)
  console.log(JSON.stringify({
    output: outputPath,
    durationFrames,
    beats: windows,
    sfxCues: sfxCues.map((cue) => ({ file: cue.file, delayMs: cue.delayMs })),
    wallSec: Number(((performance.now() - started) / 1000).toFixed(1)),
  }, null, 2))
}

await main()
