#!/usr/bin/env node
/**
 * 原型（评估用，非生产路径）：长卷横移样片渲染器 handscroll-v0
 *
 * 把 progressive_five props（panels/subtitles/audio 时序）渲染成连续横向长卷：
 *   - 所有场景按各自旁白窗口中点对齐到一条横向轨道，两侧 180px 墨色羽化，
 *     场景间距 < 图宽时相邻场景互相溶入，间距 > 图宽时形成黑暗山谷（镜头穿行）；
 *   - 镜头全程匀速右移（亚像素 perspective 平移），从不停歇、不换向；
 *   - 字幕沿用 subtitleTextPlan（readable-rise 的静态近似：居中底部 + 淡入淡出）。
 *
 * 用法:
 *   node handscroll_sample_renderer.mjs --props <props.json> --output <video.mp4>
 *     [--audio-from <video.mp4>] [--work-dir <dir>] [--speed <px/s>]
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { FPS, HEIGHT, WIDTH, subtitleTextPlan } from './dharma_comic_native_core.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')
const requireFromBackend = createRequire(join(repoRoot, 'backend/package.json'))
const sharp = requireFromBackend('sharp')

const FONT_SANS = join(repoRoot, 'data/fonts/NotoSansCJKsc-Regular.otf')
const BASE_INK = '#080d12'
const FEATHER_PX = 180
const SCROLL_SPEED = 200 // px/s，全程匀速
const SCENE_SHIFT = -400 // 首屏不让自己全黑：场景排整体左移，开场即见 70% 画面

function fail(message) {
  console.error(`handscroll_sample_renderer: ${message}`)
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

function drawtextEscape(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '%%')
}

async function buildStrip(scenes, stripWidth, stripPath) {
  const feather = Buffer.from(
    `<svg width="${WIDTH}" height="${HEIGHT}"><defs>`
      + '<linearGradient id="f" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>'
      + `<stop offset="${(FEATHER_PX / WIDTH).toFixed(4)}" stop-color="#ffffff" stop-opacity="1"/>`
      + `<stop offset="${(1 - FEATHER_PX / WIDTH).toFixed(4)}" stop-color="#ffffff" stop-opacity="1"/>`
      + '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>'
      + '</linearGradient></defs>'
      + `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#f)"/></svg>`,
  )
  const overlays = []
  for (const scene of scenes) {
    if (!existsSync(scene.src)) fail(`Panel image missing: ${scene.src}`)
    const input = await sharp(scene.src)
      .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
      .composite([{ input: feather, blend: 'dest-in' }])
      .png()
      .toBuffer()
    overlays.push({ input, left: Math.round(scene.centerX - WIDTH / 2), top: 0 })
  }
  await sharp({ create: { width: stripWidth, height: HEIGHT, channels: 4, background: BASE_INK } })
    .composite(overlays)
    .png()
    .toFile(stripPath)
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
    fail('Usage: handscroll_sample_renderer.mjs --props <props.json> --output <video.mp4> [--audio-from <video.mp4>] [--work-dir <dir>] [--speed <px/s>]')
  }
  const props = JSON.parse(readFileSync(resolve(repoRoot, options.props), 'utf8'))
  if (props.variant !== 'progressive_five') fail('Prototype only accepts progressive_five props')
  const speed = options.speed ? Number(options.speed) : SCROLL_SPEED
  if (!Number.isFinite(speed) || speed <= 0) fail('--speed must be a positive number')

  const durationFrames = Number(props.durationInFrames)
  const durationSec = durationFrames / FPS
  const narrationEndFrame = Number(props.narrationEndFrame || durationFrames)
  const panels = props.panels
  const windowOf = (index) => {
    const start = Number(panels[index].emphasisStartFrame)
    const end = index + 1 < panels.length ? Number(panels[index + 1].emphasisStartFrame) : narrationEndFrame
    return { start, end }
  }
  const scenes = panels.map((panel, index) => {
    const { start, end } = windowOf(index)
    const midSec = (start + end) / 2 / FPS
    return { src: panel.src, key: panel.key, centerX: WIDTH / 2 + SCENE_SHIFT + speed * midSec, midSec }
  })
  const stripWidth = Math.ceil(WIDTH + speed * durationSec)

  const workDir = resolve(repoRoot, options.work_dir || `data/temp/handscroll-${Date.now()}`)
  mkdirSync(workDir, { recursive: true })
  const stripPath = join(workDir, 'strip.png')
  await buildStrip(scenes, stripWidth, stripPath)

  const audioFrom = options.audio_from ? resolve(repoRoot, options.audio_from) : null
  const dx = (speed / FPS).toFixed(6)
  const subtitleChain = subtitleFilters(props.subtitles || [])
  const moved = subtitleChain.length ? 'scrollsub' : 'scrolled'
  const graph = [
    `[0:v]trim=end_frame=${durationFrames},setpts=PTS-STARTPTS[scroll0]`,
    `[scroll0]perspective=x0='-${dx}*in':y0=0:x1='W-${dx}*in':y1=0:x2='-${dx}*in':y2=H:x3='W-${dx}*in':y3=H:sense=destination:interpolation=linear:eval=frame,crop=${WIDTH}:${HEIGHT}:x=0:y=0[scrolled]`,
    ...(subtitleChain.length ? [`[scrolled]${subtitleChain.join(',')}[${moved}]`] : []),
  ].join(';')

  const args = ['-hide_banner', '-y', '-loop', '1', '-framerate', String(FPS), '-i', stripPath]
  if (audioFrom) args.push('-i', audioFrom)
  args.push('-filter_complex', graph, '-map', `[${moved}]`)
  if (audioFrom) args.push('-map', '1:a', '-c:a', 'copy')
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-t', durationSec.toFixed(6), '-movflags', '+faststart',
    resolve(repoRoot, options.output),
  )
  const started = performance.now()
  const proc = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  if (proc.status !== 0) fail(`ffmpeg exited ${proc.status}: ${String(proc.stderr || '').slice(-2000)}`)
  console.log(JSON.stringify({
    output: resolve(repoRoot, options.output),
    stripPath,
    stripWidth,
    durationFrames,
    speedPxPerSec: speed,
    scenes: scenes.map((scene) => ({ key: scene.key, centerX: Math.round(scene.centerX), midSec: Number(scene.midSec.toFixed(2)) })),
    wallSec: Number(((performance.now() - started) / 1000).toFixed(1)),
  }, null, 2))
}

await main()
