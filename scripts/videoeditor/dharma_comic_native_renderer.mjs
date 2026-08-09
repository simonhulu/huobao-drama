#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FPS,
  HEIGHT,
  INK,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  NATIVE_AUDIO_MIX_VERSION,
  NATIVE_RENDERER_VERSION,
  PAGE_DIP_FRAMES,
  PROGRESSIVE_LAYOUTS,
  QUOTE_HANDWRITE_POSE_FRAMES,
  SUBTITLE_AXIS_MAX_GAP_FRAMES,
  SUBTITLE_AXIS_NEW_TIERS,
  SUBTITLE_AXIS_OLD_MAX_ALPHA,
  SUBTITLE_AXIS_OLD_TIERS,
  SUBTITLE_AXIS_SETTLE_MARGIN_SEC,
  SUBTITLE_AXIS_STEP_FRAMES,
  SUBTITLE_AXIS_TRANSITION_FRAMES,
  SUBTITLE_BLUR_OUT_MIN_EXIT_FRAMES,
  SUBTITLE_ENTRY_FRAMES,
  SUBTITLE_ENTRY_RISE_PX,
  SUBTITLE_EXIT_FRAMES,
  SUBTITLE_INLINE_HIGHLIGHT_FRAMES,
  SUBTITLE_LINE_STAGGER_FRAMES,
  SUBTITLE_UNDERLINE_GROW_FRAMES,
  TEXT_PRESENTATION_VERSION,
  TRANSITION_FRAMES,
  WIDTH,
  activeRectForIndex,
  assertContinuousIntervals,
  bubbleAnchor,
  buildIntervals,
  computeSubtitleDisplayWindows,
  coverCrop,
  emphasisTextPlan,
  handwritePosePlan,
  layoutAtTransitionFrame,
  motionFilter,
  rectToPixels,
  subtitleTextPlan,
} from './dharma_comic_native_core.mjs'
import {
  DHARMA_VIDEO_ENCODER,
  appendFilterThreadOptions,
  appendLoopedImageInput,
  appendVideoToolboxEncoderOptions,
} from './dharma_ffmpeg_config.mjs'
import {
  acquireDharmaRenderLock,
  releaseDharmaRenderLock,
} from './dharma_render_lock.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')
const requireFromBackend = createRequire(join(repoRoot, 'backend/package.json'))
const sharp = requireFromBackend('sharp')

const FONT_SANS = join(repoRoot, 'data/fonts/NotoSansCJKsc-Regular.otf')
const FONT_SERIF = join(repoRoot, 'remotion/public/fonts/NotoSerifSC-Bold.ttf')
// dharma-text-v4：theme 金句 Handwrite 毛笔体（demo3 验收的 textRaster fontfile+family 路径）。
const FONT_HAND = join(repoRoot, 'data/fonts/MaShanZheng-Regular.ttf')
const FONT_SANS_FAMILY = 'Noto Sans CJK SC'
const FONT_SERIF_FAMILY = 'Noto Serif SC'
const FONT_HAND_FAMILY = 'Ma Shan Zheng'
// bubbleSvg 的 font-family 写死在 SVG 里，必须进 intervalFingerprint 的字体指纹，
// 否则换字体后旧缓存帧不会失效。
const BUBBLE_FONT_FAMILY = 'Noto Serif SC, Songti SC, serif'
const assetHashCache = new Map()
const bottomShadeSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <defs><linearGradient id="subtitle-shade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#030709" stop-opacity="0"/>
    <stop offset="0.32" stop-color="#030709" stop-opacity="0.12"/>
    <stop offset="0.62" stop-color="#030709" stop-opacity="0.42"/>
    <stop offset="1" stop-color="#030709" stop-opacity="0.78"/>
  </linearGradient></defs>
  <rect x="0" y="400" width="${WIDTH}" height="320" fill="url(#subtitle-shade)"/>
</svg>`)

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`Missing value for ${token}`)
    options[token.slice(2).replaceAll('-', '_')] = value
    index += 1
  }
  return options
}

function run(command, args, options = {}) {
  const started = performance.now()
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 2 * 60 * 60_000,
  })
  if (result.error) fail(`${command} failed: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${command} failed (${result.status})\n${result.stderr || ''}`)
  }
  return {
    elapsedSec: (performance.now() - started) / 1000,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, content)
  renamePortable(temporary, path)
}

function renamePortable(from, to) {
  if (existsSync(to)) rmSync(to)
  const result = spawnSync('mv', [from, to], { timeout: 30_000 })
  if (result.status !== 0) fail(`Unable to publish ${to}`)
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function textRaster(text, { fontFile, fontFamily, fontSize, color, maxWidth, markup }) {
  return sharp({
    text: {
      text: markup || `<span foreground="${color}">${escapeXml(text)}</span>`,
      font: `${fontFamily} ${fontSize}`,
      fontfile: fontFile,
      width: maxWidth,
      align: 'center',
      rgba: true,
      dpi: 72,
    },
  }).png().toBuffer({ resolveWithObject: true })
}

async function fullFrameTextLayer({
  text,
  markup,
  fontFile,
  fontFamily,
  fontSize,
  color,
  centerX = WIDTH / 2,
  centerY = HEIGHT / 2,
  maxWidth = 1080,
  outlinePx = 2,
  outlineColor = '#030709',
}) {
  const [foreground, outline] = await Promise.all([
    textRaster(text, { fontFile, fontFamily, fontSize, color, maxWidth, markup }),
    textRaster(text, { fontFile, fontFamily, fontSize, color: outlineColor, maxWidth }),
  ])
  const left = Math.round(centerX - foreground.info.width / 2)
  const top = Math.round(centerY - foreground.info.height / 2)
  const offsets = outlinePx > 0
    ? [
        [-outlinePx, 0], [outlinePx, 0], [0, -outlinePx], [0, outlinePx],
        [-outlinePx, -outlinePx], [outlinePx, -outlinePx],
        [-outlinePx, outlinePx], [outlinePx, outlinePx],
      ]
    : []
  const composites = offsets.map(([x, y]) => ({ input: outline.data, left: left + x, top: top + y }))
  composites.push({ input: foreground.data, left, top })
  const data = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png({ compressionLevel: 4 })
    .toBuffer()
  return { data, width: foreground.info.width, height: foreground.info.height, left, top }
}

function emphasisBackdropSvg(kind, lineTopY) {
  if (kind === 'theme') {
    // ink-read-v2：theme 金线不再画死在底板上，改由 drawbox 随首字落定生长 4 帧。
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      <defs><radialGradient id="ink"><stop offset="0" stop-color="#010609" stop-opacity="0.78"/><stop offset="0.5" stop-color="#010609" stop-opacity="0.48"/><stop offset="1" stop-color="#010609" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="640" cy="360" rx="520" ry="270" fill="url(#ink)"/>
    </svg>`
  }
  if (kind === 'scripture') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
      <defs><radialGradient id="ink"><stop offset="0" stop-color="#010609" stop-opacity="0.74"/><stop offset="0.56" stop-color="#010609" stop-opacity="0.42"/><stop offset="1" stop-color="#010609" stop-opacity="0"/></radialGradient></defs>
      <ellipse cx="640" cy="360" rx="540" ry="285" fill="url(#ink)"/>
      <line x1="514" y1="${Math.round(lineTopY - 34)}" x2="766" y2="${Math.round(lineTopY - 34)}" stroke="#c7a45a" stroke-width="1.5" stroke-opacity="0.84"/>
    </svg>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><radialGradient id="wash"><stop offset="0" stop-color="#010609" stop-opacity="0.62"/><stop offset="0.62" stop-color="#010609" stop-opacity="0.38"/><stop offset="1" stop-color="#010609" stop-opacity="0"/></radialGradient></defs>
    <ellipse cx="640" cy="360" rx="510" ry="122" fill="url(#wash)"/>
  </svg>`
}

function wrapChinese(text, charsPerLine) {
  const chars = [...String(text)]
  const lines = []
  while (chars.length) lines.push(chars.splice(0, charsPerLine).join(''))
  return lines
}

function assetPath(src) {
  const path = isAbsolute(src) ? src : join(repoRoot, 'remotion/public', src)
  if (!existsSync(path)) fail(`Missing comic asset: ${path}`)
  return path
}

function assetFingerprint(src) {
  const path = assetPath(src)
  if (!assetHashCache.has(path)) {
    assetHashCache.set(path, fileSha256(path))
  }
  return assetHashCache.get(path)
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function intervalFingerprint(props, interval, motionMode) {
  const startSec = interval.startFrame / FPS
  const endSec = interval.endFrame / FPS
  const plateMode = props.textLayers === 'overlay'
  if (plateMode) {
    // dharma-text-v5：plate 底片不含 subtitle/emphasis 文字层，指纹只绑定真正参与
    // 底片渲染的输入——文字层变更走 overlayFingerprint 触发 Remotion 重渲，
    // 不应使底片 interval 缓存失效。bubble 是底片内容，字体指纹保留。
    const payload = {
      renderer: NATIVE_RENDERER_VERSION,
      videoEncoder: DHARMA_VIDEO_ENCODER,
      textLayers: 'overlay',
      motionMode,
      interval: {
        index: interval.index,
        pageIndex: interval.pageIndex,
        activeIndex: interval.activeIndex,
        startFrame: interval.startFrame,
        endFrame: interval.endFrame,
        pageDipIn: interval.pageDipIn,
        pageDipOut: interval.pageDipOut,
      },
      panels: interval.pagePanels.map((panel) => ({
        ...panel,
        assetSha256: assetFingerprint(panel.src),
      })),
      fonts: {
        bubble: `${BUBBLE_FONT_FAMILY}:${fileSha256(FONT_SERIF)}`,
      },
    }
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  }
  const payload = {
    renderer: NATIVE_RENDERER_VERSION,
    videoEncoder: DHARMA_VIDEO_ENCODER,
    textLayers: 'burned',
    textPresentationVersion: props.textPresentationVersion,
    subtitlePreset: props.subtitlePreset,
    subtitleFx: {
      inlineHighlight: {
        color: SUBTITLE_KEYWORD_COLOR,
        frames: SUBTITLE_INLINE_HIGHLIGHT_FRAMES,
      },
      sharedAxisZ: {
        transitionFrames: SUBTITLE_AXIS_TRANSITION_FRAMES,
        stepFrames: SUBTITLE_AXIS_STEP_FRAMES,
        maxGapFrames: SUBTITLE_AXIS_MAX_GAP_FRAMES,
        oldMaxAlpha: SUBTITLE_AXIS_OLD_MAX_ALPHA,
        oldTiers: SUBTITLE_AXIS_OLD_TIERS,
        newTiers: SUBTITLE_AXIS_NEW_TIERS,
      },
      blurOut: {
        sigmaMid: SUBTITLE_BLUR_MID_SIGMA,
        sigmaBig: SUBTITLE_BLUR_BIG_SIGMA,
        minExitWindowFrames: SUBTITLE_BLUR_OUT_MIN_EXIT_FRAMES,
      },
      handwrite: {
        font: FONT_HAND_FAMILY,
        poseFrames: QUOTE_HANDWRITE_POSE_FRAMES,
      },
    },
    fonts: {
      sans: fileSha256(FONT_SANS),
      serif: fileSha256(FONT_SERIF),
      hand: `${FONT_HAND_FAMILY}:${fileSha256(FONT_HAND)}`,
      bubble: `${BUBBLE_FONT_FAMILY}:${fileSha256(FONT_SERIF)}`,
    },
    motionMode,
    interval: {
      index: interval.index,
      pageIndex: interval.pageIndex,
      activeIndex: interval.activeIndex,
      startFrame: interval.startFrame,
      endFrame: interval.endFrame,
      pageDipIn: interval.pageDipIn,
      pageDipOut: interval.pageDipOut,
    },
    panels: interval.pagePanels.map((panel) => ({
      ...panel,
      assetSha256: assetFingerprint(panel.src),
    })),
    subtitles: (props.subtitles || []).filter((subtitle) => subtitle.endSec > startSec && subtitle.startSec < endSec),
    quotes: (props.quotes || []).filter((quote) => (
      quote.startFrame < interval.endFrame
      && quote.startFrame + quote.durationInFrames > interval.startFrame
    )),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function renderPanelImage(panel, rect, active) {
  const { width, height } = rectToPixels(rect)
  const image = sharp(assetPath(panel.src))
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) fail(`Unable to read image dimensions: ${panel.src}`)
  const crop = coverCrop(
    metadata.width,
    metadata.height,
    width,
    height,
    Number(panel.focusX ?? 50),
    Number(panel.focusY ?? 50),
  )
  return image
    .resize(crop.width, crop.height, { fit: 'fill' })
    .extract({ left: crop.left, top: crop.top, width, height })
    .modulate({ saturation: active ? 1.02 : 0.94, brightness: active ? 1 : 0.9 })
    .linear(1.04, -5)
    .png()
    .toBuffer()
}

async function renderPageFrame(pagePanels, activeIndex, layout, output) {
  const images = await Promise.all(pagePanels.slice(0, activeIndex + 1).map(async (panel, index) => {
    const rect = rectToPixels(layout[index])
    return {
      input: await renderPanelImage(panel, layout[index], index === activeIndex),
      left: rect.x,
      top: rect.y,
    }
  }))
  const composed = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: INK } })
    .composite([...images, { input: bottomShadeSvg, left: 0, top: 0 }])
    .png()
    .toBuffer()
  await sharp(composed)
    .resize(MOTION_WIDTH, MOTION_HEIGHT, { fit: 'fill' })
    .png({ compressionLevel: 4 })
    .toFile(output)
}

function bubbleSvg(bubble, rect) {
  const speech = bubble.kind === 'speech'
  const fontSize = speech ? 28 : 24
  const lines = wrapChinese(bubble.text, speech ? 8 : 7)
  const width = Math.min(speech ? 270 : 210, Math.max(speech ? 120 : 96, Math.max(...lines.map((line) => [...line].length)) * fontSize + 36))
  const height = Math.max(speech ? 62 : 48, lines.length * Math.round(fontSize * 1.35) + (speech ? 24 : 18))
  const { x, y } = bubbleAnchor(rect, bubble)
  const rx = speech ? Math.round(height * 0.46) : 0
  const textStartY = y + Math.round((height - lines.length * fontSize * 1.35) / 2 + fontSize)
  const tspans = lines.map((line, index) => (
    `<tspan x="${x + width / 2}" y="${textStartY + index * fontSize * 1.35}">${escapeXml(line)}</tspan>`
  )).join('')
  const tailSide = bubble.tail ?? 'left'
  const tailX = tailSide === 'left' ? x + 38 : x + width - 60
  const tail = speech
    ? `<path d="M ${tailX} ${y + height - 2} L ${tailX + 28} ${y + height - 2} L ${tailSide === 'left' ? tailX + 7 : tailX + 21} ${y + height + 20} Z" fill="#faf6e8" stroke="#080d12" stroke-width="2"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    ${tail}
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="#faf6e8" fill-opacity="0.97" stroke="#080d12" stroke-width="2"/>
    <text font-family="${BUBBLE_FONT_FAMILY}" font-size="${fontSize}" font-weight="700" fill="#17191a" text-anchor="middle">${tspans}</text>
  </svg>`
}

async function renderSvgPng(svg, path) {
  await sharp(Buffer.from(svg)).png({ compressionLevel: 4 }).toFile(path)
}

async function renderEmphasisLayers(quote, quoteIndex, intervalDir) {
  const plan = emphasisTextPlan(quote)
  const lineHeight = plan.fontSize * plan.lineHeight
  const blockCenterY = quote.kind === 'explanation' ? 400 : 350
  const firstLineY = blockCenterY - ((plan.lines.length - 1) * lineHeight) / 2
  const handwrite = quote.kind === 'theme'
    ? handwritePosePlan([...plan.lines.join('')].length)
    : null
  // ink-read-v2：theme 金线几何交给 drawbox（v4 随首 pose 落定后生长 4 帧），不画进底板。
  const themeUnderline = quote.kind === 'theme'
    ? { x: 544, y: Math.round(firstLineY - plan.fontSize / 2 - 38), width: 192, height: 2, growDelayFrames: handwrite.poseFrames }
    : null
  const backdropPath = join(intervalDir, `emphasis-${quoteIndex}-backdrop.png`)
  if (!existsSync(backdropPath)) {
    await renderSvgPng(emphasisBackdropSvg(quote.kind, firstLineY - plan.fontSize / 2), backdropPath)
  }
  const layers = [{
    path: backdropPath,
    role: 'backdrop',
    delayFrames: 0,
    entryFrames: 2,
    exitFrames: plan.exitFrames,
    risePx: 0,
  }]
  const fontFile = plan.fontFamily === 'hand' ? FONT_HAND : plan.fontFamily === 'serif' ? FONT_SERIF : FONT_SANS
  const fontFamily = plan.fontFamily === 'hand' ? FONT_HAND_FAMILY : plan.fontFamily === 'serif' ? FONT_SERIF_FAMILY : FONT_SANS_FAMILY

  // dharma-text-v4：theme 金句 = Handwrite 毛笔体逐字定格 pose（demo3 配方）。
  // 逐字栅格按行居中排版（行内底对齐），pose 画布硬切累积 [2,3,...,N] 字；
  // 仅末 pose 带退场淡出，其余 pose 纯硬切到下一 pose。
  if (quote.kind === 'theme') {
    const gap = Math.max(4, Math.round(plan.fontSize * 0.095))
    const glyphPlacements = []
    for (const [lineIndex, line] of plan.lines.entries()) {
      const centerY = firstLineY + lineIndex * lineHeight
      const glyphRasters = await Promise.all([...line].map((glyph) => textRaster(glyph, {
        fontFile,
        fontFamily,
        fontSize: plan.fontSize,
        color: '#f4ead6',
        maxWidth: plan.fontSize * 2,
      })))
      const rowHeight = Math.max(...glyphRasters.map((raster) => raster.info.height))
      const totalWidth = glyphRasters.reduce((sum, raster) => sum + raster.info.width, 0) + gap * Math.max(0, glyphRasters.length - 1)
      let cursorX = (WIDTH - totalWidth) / 2
      for (const raster of glyphRasters) {
        glyphPlacements.push({
          raster,
          left: Math.round(cursorX),
          top: Math.round(centerY - rowHeight / 2 + (rowHeight - raster.info.height)),
        })
        cursorX += raster.info.width + gap
      }
    }
    for (const [poseIndex, glyphCount] of handwrite.counts.entries()) {
      const path = join(intervalDir, `emphasis-${quoteIndex}-pose-${poseIndex}.png`)
      if (!existsSync(path)) {
        const data = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite(glyphPlacements.slice(0, glyphCount).map((placement) => ({
            input: placement.raster.data,
            left: placement.left,
            top: placement.top,
          })))
          .png({ compressionLevel: 4 })
          .toBuffer()
        await sharp(data).toFile(path)
      }
      const isLastPose = poseIndex === handwrite.counts.length - 1
      layers.push({
        path,
        role: 'theme-handwrite',
        delayFrames: poseIndex * handwrite.poseFrames,
        entryFrames: 0,
        exitFrames: isLastPose ? plan.exitFrames : 0,
        risePx: 0,
        holdUntilFrame: isLastPose ? null : quote.startFrame + (poseIndex + 1) * handwrite.poseFrames,
      })
    }
    return { quote, layers, themeUnderline }
  }

  for (const [lineIndex, line] of plan.lines.entries()) {
    const centerY = firstLineY + lineIndex * lineHeight
    {
      const path = join(intervalDir, `emphasis-${quoteIndex}-line-${lineIndex}.png`)
      if (!existsSync(path)) {
        const layer = await fullFrameTextLayer({
          text: line,
          fontFile,
          fontFamily,
          fontSize: plan.fontSize,
          color: quote.kind === 'scripture' ? '#f4ead6' : '#f5eee1',
          centerY,
          maxWidth: quote.kind === 'scripture' ? 1000 : 960,
          outlinePx: 2,
        })
        await sharp(layer.data).toFile(path)
      }
      layers.push({
        path,
        role: `${quote.kind}-line`,
        delayFrames: lineIndex * plan.staggerFrames,
        entryFrames: plan.entryFrames,
        exitFrames: plan.exitFrames,
        risePx: plan.risePx,
      })
    }
  }

  if (quote.kind === 'scripture' && quote.source) {
    const sourcePath = join(intervalDir, `emphasis-${quoteIndex}-source.png`)
    if (!existsSync(sourcePath)) {
      const sourceCenterY = firstLineY + (plan.lines.length - 1) * lineHeight + plan.fontSize * 1.18
      const sourceLayer = await fullFrameTextLayer({
        text: quote.source,
        fontFile: FONT_SANS,
        fontFamily: FONT_SANS_FAMILY,
        fontSize: plan.sourceFontSize,
        color: '#d9cfbc',
        centerY: sourceCenterY,
        maxWidth: 720,
        outlinePx: 1,
      })
      // ink-read-v2：出处文字下垫 12% 墨色方印底。
      const sealWidth = sourceLayer.width + 36
      const sealHeight = sourceLayer.height + 18
      const sealSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
        <rect x="${Math.round(WIDTH / 2 - sealWidth / 2)}" y="${Math.round(sourceCenterY - sealHeight / 2)}" width="${sealWidth}" height="${sealHeight}" rx="3" fill="#010609" fill-opacity="0.12"/>
      </svg>`
      const sealed = await sharp(Buffer.from(sealSvg))
        .composite([{ input: sourceLayer.data, left: 0, top: 0 }])
        .png({ compressionLevel: 4 })
        .toBuffer()
      await sharp(sealed).toFile(sourcePath)
    }
    layers.push({
      path: sourcePath,
      role: 'scripture-source',
      delayFrames: plan.lines.length * plan.staggerFrames + 2,
      entryFrames: 6,
      exitFrames: plan.exitFrames,
      risePx: 5,
    })
  }
  return { quote, layers, themeUnderline }
}

function subtractRanges(range, cuts) {
  let ranges = [range]
  for (const cut of cuts) {
    ranges = ranges.flatMap(([start, end]) => {
      if (cut[1] <= start || cut[0] >= end) return [[start, end]]
      const result = []
      if (cut[0] > start) result.push([start, cut[0]])
      if (cut[1] < end) result.push([cut[1], end])
      return result
    })
  }
  return ranges.filter(([start, end]) => end - start >= 0.04)
}

// ---------------------------------------------------------------------------
// ink-read-v2 底部字幕（dharma-text-v4）：暖白/金双版本 PNG 图层 +
// InlineHighlight 关键词变色 + SharedAxisZ 句间纵深转场 + blur-out 末句退场
// ---------------------------------------------------------------------------

const SUBTITLE_BASE_COLOR = '#F2EAD8'
const SUBTITLE_KEYWORD_COLOR = '#C7A45A'
const SUBTITLE_OUTLINE_COLOR = '#120D08'
const SUBTITLE_BOTTOM_Y = 570
const SUBTITLE_MAX_WIDTH = 1056
// blur-out：原图 2 帧淡出，blur 4 / blur 8 两级交叉淡化，exitWindow 内末帧收净。
const SUBTITLE_BLUR_MID_SIGMA = 4
const SUBTITLE_BLUR_BIG_SIGMA = 8

function subtitleSpans(line, keywords) {
  const spans = []
  let cursor = 0
  for (const keyword of keywords) {
    const index = line.indexOf(keyword, cursor)
    if (index < 0) continue
    if (index > cursor) spans.push({ text: line.slice(cursor, index), gold: false })
    spans.push({ text: keyword, gold: true })
    cursor = index + keyword.length
  }
  if (cursor < line.length) spans.push({ text: line.slice(cursor), gold: false })
  return spans
}

// 每行一组 1280x720 字幕图层：A 版整行暖白 + 3px 八向墨描边；B 版（gold）关键词
// 前景 #C7A45A 金、描边与 A 版一致（demo3 InlineHighlight 配方），其余字与 A 一致。
// 排版由调用方按真实行高堆叠（末行底部固定在 570）。
async function measureSubtitleLine({ line, keywords, fontSize }) {
  const lineKeywords = (keywords || []).filter((keyword) => line.includes(keyword))
    .sort((left, right) => line.indexOf(left) - line.indexOf(right))
  const spans = subtitleSpans(line, lineKeywords)
  const goldMarkup = spans.length
    ? spans.map((span) => `<span foreground="${span.gold ? SUBTITLE_KEYWORD_COLOR : SUBTITLE_BASE_COLOR}">${escapeXml(span.text)}</span>`).join('')
    : undefined
  const rasterOptions = { fontFile: FONT_SANS, fontFamily: FONT_SANS_FAMILY, fontSize, maxWidth: SUBTITLE_MAX_WIDTH }
  const [foreground, outline, goldForeground] = await Promise.all([
    textRaster(line, { ...rasterOptions, color: SUBTITLE_BASE_COLOR }),
    textRaster(line, { ...rasterOptions, color: SUBTITLE_OUTLINE_COLOR }),
    goldMarkup
      ? textRaster(line, { ...rasterOptions, color: SUBTITLE_BASE_COLOR, markup: goldMarkup })
      : Promise.resolve(null),
  ])
  return { foreground, outline, goldForeground }
}

async function composeSubtitleLineLayer(measured, centerY, variant = 'base') {
  const foreground = variant === 'gold' && measured.goldForeground ? measured.goldForeground : measured.foreground
  const left = Math.round(WIDTH / 2 - foreground.info.width / 2)
  const top = Math.round(centerY - foreground.info.height / 2)
  const o = 3
  const offsets = [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o]]
  const composites = offsets.map(([x, y]) => ({ input: measured.outline.data, left: left + x, top: top + y }))
  composites.push({ input: foreground.data, left, top })
  const data = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png({ compressionLevel: 4 })
    .toBuffer()
  return { data }
}

// SharedAxisZ 缩放/模糊档位变体（demo3 配方）：全帧字幕画布绕行中心
// (WIDTH/2, centerY) 缩放——s>1 放大后裁回，s<1 缩小后居中贴回，再叠 blur。
async function axisTierVariant(fullCanvasData, scale, blurSigma, centerY) {
  const scaledWidth = Math.round(WIDTH * scale)
  const scaledHeight = Math.round(HEIGHT * scale)
  let image
  if (scale >= 1) {
    image = sharp(fullCanvasData)
      .resize(scaledWidth, scaledHeight, { kernel: 'lanczos3' })
      .extract({
        left: Math.round((WIDTH / 2) * (scale - 1)),
        top: Math.round(centerY * (scale - 1)),
        width: WIDTH,
        height: HEIGHT,
      })
  } else {
    const resized = await sharp(fullCanvasData).resize(scaledWidth, scaledHeight, { kernel: 'lanczos3' }).png().toBuffer()
    image = sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: resized, left: Math.round((WIDTH / 2) * (1 - scale)), top: Math.round(centerY * (1 - scale)) }])
  }
  if (blurSigma > 0) image = image.blur(blurSigma)
  return image.png().toBuffer()
}

// 把 props.subtitles 展开成本 interval 的可见字幕段：display 窗口优先
// （ink-read-v2 props 自带），缺失时按驻留规则现算；金句窗口压掉同句字幕。
// 段边界与 v1 相同：interval 裁切 + quote 裁切后每段独立做入退场。
function buildSubtitleSegments(props, interval) {
  const startSec = interval.startFrame / FPS
  const endSec = interval.endFrame / FPS
  const quoteCuts = (props.quotes || []).map((quote) => [
    quote.startFrame / FPS,
    (quote.startFrame + quote.durationInFrames) / FPS,
  ])
  const subtitles = props.subtitles || []
  const hasDisplayWindows = subtitles.every((subtitle) => (
    Number.isFinite(Number(subtitle.displayStartSec)) && Number.isFinite(Number(subtitle.displayEndSec))
  ))
  const displayWindows = hasDisplayWindows ? null : computeSubtitleDisplayWindows(subtitles, FPS)
  const segments = []
  for (const [subtitleIndex, subtitle] of subtitles.entries()) {
    const displayStartSec = hasDisplayWindows ? Number(subtitle.displayStartSec) : displayWindows[subtitleIndex].displayStartSec
    const displayEndSec = hasDisplayWindows ? Number(subtitle.displayEndSec) : displayWindows[subtitleIndex].displayEndSec
    const clipped = [Math.max(startSec, displayStartSec), Math.min(endSec, displayEndSec)]
    if (clipped[1] <= clipped[0]) continue
    for (const [visibleStart, visibleEnd] of subtractRanges(clipped, quoteCuts)) {
      segments.push({
        text: String(subtitle.text || ''),
        keywords: Array.isArray(subtitle.subtitleKeywords) ? subtitle.subtitleKeywords : [],
        startSec: visibleStart - startSec,
        endSec: visibleEnd - startSec,
      })
    }
  }
  return segments.sort((left, right) => left.startSec - right.startSec)
}

// SharedAxisZ 相邻句判定：下一句开始不晚于本句 displayEnd +3 帧（驻留规则保证
// 相邻句最多重叠 3 帧），且新句窗口容得下 10 帧转场 + 0.2s 落定余量、旧句自身
// 不短于 10 帧；任一条件不足整组回退 v3（旧句 blur-out、新句普通入场）。
function planSubtitleAxisTransitions(segments) {
  const entryTe = new Array(segments.length).fill(null)
  const exitTe = new Array(segments.length).fill(null)
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const current = segments[index]
    const next = segments[index + 1]
    if ((next.startSec - current.endSec) * FPS > SUBTITLE_AXIS_MAX_GAP_FRAMES) continue
    if (current.endSec - current.startSec < SUBTITLE_AXIS_TRANSITION_FRAMES / FPS) continue
    if (next.endSec - next.startSec < SUBTITLE_AXIS_TRANSITION_FRAMES / FPS + SUBTITLE_AXIS_SETTLE_MARGIN_SEC) continue
    exitTe[index] = next.startSec
    entryTe[index + 1] = next.startSec
  }
  return { entryTe, exitTe }
}

async function prepareSubtitleLayers(props, interval, intervalDir) {
  const segments = buildSubtitleSegments(props, interval)
  const planned = []
  for (const [segmentIndex, segment] of segments.entries()) {
    if (!segment.text.trim()) continue
    const plan = subtitleTextPlan(segment.text)
    if (!plan.lines.length) continue
    planned.push({ segment, segmentIndex, plan })
  }
  const { entryTe, exitTe } = planSubtitleAxisTransitions(planned.map((item) => item.segment))
  const layers = []
  for (const [plannedIndex, { segment, segmentIndex, plan }] of planned.entries()) {
    const axisEntry = entryTe[plannedIndex]
    const axisExit = exitTe[plannedIndex]
    const lineHeightPx = Math.round(plan.fontSize * 1.34)
    // 先测全部行，再用底行真实高度把末行底部钉在 570，从下往上堆叠。
    const measuredLines = await Promise.all(plan.lines.map((line) => measureSubtitleLine({
      line,
      keywords: segment.keywords,
      fontSize: plan.fontSize,
    })))
    const bottomHeight = measuredLines.at(-1).foreground.info.height
    const bottomCenterY = SUBTITLE_BOTTOM_Y - Math.round(bottomHeight / 2)
    for (const [lineIndex, measured] of measuredLines.entries()) {
      const centerY = bottomCenterY - (measuredLines.length - 1 - lineIndex) * lineHeightPx
      const delayFrames = lineIndex * SUBTITLE_LINE_STAGGER_FRAMES
      const localStart = segment.startSec + delayFrames / FPS
      const localEnd = segment.endSec
      const fadeIn = Math.min(SUBTITLE_ENTRY_FRAMES / FPS, Math.max(0.04, localEnd - localStart))
      const exitWindow = Math.min(SUBTITLE_EXIT_FRAMES / FPS, Math.max(0.04, localEnd - localStart))
      const teLine = axisEntry != null ? axisEntry + delayFrames / FPS : null
      const settle = teLine != null
        ? teLine + SUBTITLE_AXIS_TRANSITION_FRAMES / FPS
        : localStart + fadeIn
      const exitStart = axisExit != null ? axisExit : Math.max(localStart, localEnd - exitWindow)
      const basePath = join(intervalDir, `subtitle-${segmentIndex}-line-${lineIndex}.png`)
      const composed = await composeSubtitleLineLayer(measured, centerY, 'base')
      if (!existsSync(basePath)) writeFileSync(basePath, composed.data)
      // InlineHighlight 窗口纪律：落定后 6 帧暖白→金交叉淡化必须在退场收线前
      // 完成，否则该行整体保持暖白（不生成 gold 资产）。
      const highlightActive = measured.goldForeground !== null && localEnd > localStart
        && settle + SUBTITLE_INLINE_HIGHLIGHT_FRAMES / FPS <= exitStart - 2 / FPS
      let goldPath = null
      let settledData = composed.data
      if (highlightActive) {
        goldPath = join(intervalDir, `subtitle-${segmentIndex}-line-${lineIndex}-gold.png`)
        const goldComposed = await composeSubtitleLineLayer(measured, centerY, 'gold')
        if (!existsSync(goldPath)) writeFileSync(goldPath, goldComposed.data)
        settledData = goldComposed.data
      }
      let blurMPath = null
      let blurBPath = null
      const axisOldPaths = []
      const axisNewPaths = []
      if (axisExit != null) {
        // 旧句远去 3 档：落定态（gold 或暖白）绕行中心放大变糊。
        for (const [tierIndex, [scale, blurSigma]] of SUBTITLE_AXIS_OLD_TIERS.entries()) {
          const tierPath = join(intervalDir, `axis-old-${segmentIndex}-line-${lineIndex}-${tierIndex}.png`)
          if (!existsSync(tierPath)) writeFileSync(tierPath, await axisTierVariant(settledData, scale, blurSigma, centerY))
          axisOldPaths.push(tierPath)
        }
      } else {
        // blur-out 用落定合成态（gold 或暖白 A 版本体的模糊）。
        blurMPath = join(intervalDir, `subtitle-${segmentIndex}-line-${lineIndex}-blur-m.png`)
        blurBPath = join(intervalDir, `subtitle-${segmentIndex}-line-${lineIndex}-blur-b.png`)
        if (!existsSync(blurMPath)) writeFileSync(blurMPath, await sharp(settledData).blur(SUBTITLE_BLUR_MID_SIGMA).png().toBuffer())
        if (!existsSync(blurBPath)) writeFileSync(blurBPath, await sharp(settledData).blur(SUBTITLE_BLUR_BIG_SIGMA).png().toBuffer())
      }
      if (axisEntry != null) {
        // 新句逼近 3 档：暖白入场态绕行中心缩小变糊（变色落定后另行交叉淡化）。
        for (const [tierIndex, [scale, blurSigma]] of SUBTITLE_AXIS_NEW_TIERS.entries()) {
          const tierPath = join(intervalDir, `axis-new-${segmentIndex}-line-${lineIndex}-${tierIndex}.png`)
          if (!existsSync(tierPath)) writeFileSync(tierPath, await axisTierVariant(composed.data, scale, blurSigma, centerY))
          axisNewPaths.push(tierPath)
        }
      }
      layers.push({
        path: basePath,
        goldPath,
        blurMPath,
        blurBPath,
        axisOldPaths,
        axisNewPaths,
        axisEntryTe: axisEntry,
        axisExitTe: axisExit,
        segment,
        lineIndex,
        delayFrames,
      })
    }
  }
  return layers
}

async function prepareIntervalAssets(props, interval, intervalDir) {
  mkdirSync(intervalDir, { recursive: true })
  const statePath = join(intervalDir, 'state.png')
  if (!existsSync(statePath)) {
    await renderPageFrame(interval.pagePanels, interval.activeIndex, PROGRESSIVE_LAYOUTS[interval.activeIndex], statePath)
  }
  if (interval.hasLayoutTransition) {
    const transitionDir = join(intervalDir, 'transition')
    mkdirSync(transitionDir, { recursive: true })
    for (let batchStart = 0; batchStart < TRANSITION_FRAMES; batchStart += 4) {
      const frames = Array.from(
        { length: Math.min(4, TRANSITION_FRAMES - batchStart) },
        (_, offset) => batchStart + offset,
      )
      await Promise.all(frames.map(async (frame) => {
        const framePath = join(transitionDir, `${String(frame).padStart(2, '0')}.png`)
        if (!existsSync(framePath)) {
          await renderPageFrame(interval.pagePanels, interval.activeIndex, layoutAtTransitionFrame(interval.activeIndex, frame), framePath)
        }
      }))
    }
  }
  let bubblePath = null
  if (interval.panel.bubble) {
    bubblePath = join(intervalDir, 'bubble.png')
    await renderSvgPng(bubbleSvg(interval.panel.bubble, activeRectForIndex(interval.activeIndex)), bubblePath)
  }
  const plateMode = props.textLayers === 'overlay'
  const emphasisAssets = []
  if (!plateMode) {
    for (const [index, quote] of (props.quotes || []).entries()) {
      if (quote.startFrame >= interval.endFrame || quote.startFrame + quote.durationInFrames <= interval.startFrame) continue
      emphasisAssets.push(await renderEmphasisLayers(quote, index, intervalDir))
    }
  }
  // plate 模式（dharma-text-v5）：subtitle/emphasis 文字层由 Remotion overlay 叠加，
  // 底片不再准备这两类层文件；renderInterval 对空层数组自然无操作。
  const subtitleLayers = plateMode ? [] : await prepareSubtitleLayers(props, interval, intervalDir)
  return { statePath, bubblePath, emphasisAssets, subtitleLayers }
}

function renderInterval(props, interval, assets, chunkPath, motionMode) {
  const durationSec = interval.durationInFrames / FPS
  const args = ['-hide_banner', '-y']
  appendFilterThreadOptions(args)
  const labels = []
  let inputIndex = 0
  if (interval.hasLayoutTransition) {
    args.push('-framerate', String(FPS), '-start_number', '0', '-i', join(dirname(assets.statePath), 'transition/%02d.png'))
    inputIndex += 1
  }
  const stateInput = inputIndex
  appendLoopedImageInput(args, assets.statePath, durationSec, FPS)
  inputIndex += 1
  let bubbleInput = null
  if (assets.bubblePath) {
    bubbleInput = inputIndex
    appendLoopedImageInput(args, assets.bubblePath, durationSec, FPS)
    inputIndex += 1
  }
  const emphasisInputs = assets.emphasisAssets.flatMap((asset) => asset.layers.map((layer) => {
    const index = inputIndex
    appendLoopedImageInput(args, layer.path, durationSec, FPS)
    inputIndex += 1
    return { quote: asset.quote, layer, index }
  }))
  const subtitleInputs = (assets.subtitleLayers || []).map((layer) => {
    const addInput = (path) => {
      const index = inputIndex
      appendLoopedImageInput(args, path, durationSec, FPS)
      inputIndex += 1
      return index
    }
    return {
      layer,
      baseIndex: addInput(layer.path),
      goldIndex: layer.goldPath ? addInput(layer.goldPath) : null,
      blurMIndex: layer.blurMPath ? addInput(layer.blurMPath) : null,
      blurBIndex: layer.blurBPath ? addInput(layer.blurBPath) : null,
      axisOldInputs: (layer.axisOldPaths || []).map((path) => addInput(path)),
      axisNewInputs: (layer.axisNewPaths || []).map((path) => addInput(path)),
    }
  })

  if (interval.hasLayoutTransition) {
    const holdFrames = interval.durationInFrames - TRANSITION_FRAMES
    labels.push(`[0:v]trim=end_frame=${TRANSITION_FRAMES},setpts=PTS-STARTPTS[transition]`)
    labels.push(`[${stateInput}:v]trim=end_frame=${holdFrames},setpts=PTS-STARTPTS[hold]`)
    labels.push('[transition][hold]concat=n=2:v=1:a=0[base]')
  } else {
    labels.push(`[${stateInput}:v]trim=end_frame=${interval.durationInFrames},setpts=PTS-STARTPTS[base]`)
  }
  const motionCenter = (() => {
    const rect = rectToPixels(activeRectForIndex(interval.activeIndex))
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
  })()
  labels.push(motionFilter(motionMode, interval.index, interval.durationInFrames, 'base', 'moved', {
    center: motionCenter,
    frameOffset: Number(interval.motionFrameOffset || 0),
    frameDuration: Number(interval.motionTotalFrames || interval.durationInFrames),
  }))
  let current = 'moved'
  if (interval.pageDipIn || interval.pageDipOut) {
    const filters = []
    if (interval.pageDipIn) filters.push(`fade=t=in:st=0:d=${(PAGE_DIP_FRAMES / FPS).toFixed(6)}:color=0x080d12`)
    if (interval.pageDipOut) filters.push(`fade=t=out:st=${Math.max(0, durationSec - PAGE_DIP_FRAMES / FPS).toFixed(6)}:d=${(PAGE_DIP_FRAMES / FPS).toFixed(6)}:color=0x080d12`)
    labels.push(`[${current}]${filters.join(',')}[dipped]`)
    current = 'dipped'
  }
  if (bubbleInput !== null) {
    const fadeOutStart = Math.max(14 / FPS, durationSec - 10 / FPS)
    labels.push(`[${bubbleInput}:v]format=rgba,trim=duration=${durationSec.toFixed(6)},setpts=PTS-STARTPTS,fade=t=in:st=${(8 / FPS).toFixed(6)}:d=${(6 / FPS).toFixed(6)}:alpha=1,fade=t=out:st=${fadeOutStart.toFixed(6)}:d=${(6 / FPS).toFixed(6)}:alpha=1[bubble]`)
    labels.push(`[${current}][bubble]overlay=0:0:format=auto[withbubble]`)
    current = 'withbubble'
  }
  emphasisInputs.forEach(({ quote, layer, index }, layerIndex) => {
    const layerStartFrame = quote.startFrame + Number(layer.delayFrames || 0)
    const localStart = Math.max(0, (layerStartFrame - interval.startFrame) / FPS)
    // Handwrite pose 等非末段硬切层用 holdUntilFrame 截断 enable 窗口。
    const layerEndFrame = Number.isFinite(layer.holdUntilFrame)
      ? Math.min(layer.holdUntilFrame, quote.startFrame + quote.durationInFrames)
      : quote.startFrame + quote.durationInFrames
    const localEnd = Math.min(durationSec, (layerEndFrame - interval.startFrame) / FPS)
    if (localEnd <= localStart) return
    const entering = layerStartFrame >= interval.startFrame && layerStartFrame < interval.endFrame
    const exiting = Number(layer.exitFrames || 0) > 0
      && quote.startFrame + quote.durationInFrames > interval.startFrame
      && quote.startFrame + quote.durationInFrames <= interval.endFrame
    const fadeIn = Math.min(Number(layer.entryFrames || 10) / FPS, Math.max(0.04, localEnd - localStart))
    const exitWindow = Math.min(Number(layer.exitFrames || 10) / FPS, Math.max(0.04, localEnd - localStart))
    // End one sampled frame before the layer boundary so the last visible frame is fully clear.
    const fadeOut = Math.max(1 / FPS, exitWindow - 1 / FPS)
    const layerFilters = [
      'format=rgba',
      `trim=duration=${durationSec.toFixed(6)}`,
      'setpts=PTS-STARTPTS',
    ]
    // entryFrames=0 的层（Handwrite pose）硬切入场，不加淡入。
    if (entering && Number(layer.entryFrames || 0) > 0) {
      layerFilters.push(`fade=t=in:st=${localStart.toFixed(6)}:d=${fadeIn.toFixed(6)}:alpha=1`)
    }
    if (exiting) {
      layerFilters.push(`fade=t=out:st=${Math.max(localStart, localEnd - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(6)}:alpha=1`)
      layerFilters.push("lut=a='val*val*val*val*val/(255*255*255*255)'")
    }
    labels.push(`[${index}:v]${layerFilters.join(',')}[emphasis${layerIndex}]`)
    let entryY = '0'
    if (entering && Number(layer.risePx || 0) > 0) {
      const settle = localStart + fadeIn
      entryY = `if(lt(t,${localStart.toFixed(6)}),${Number(layer.risePx)},if(lt(t,${settle.toFixed(6)}),${Number(layer.risePx)}*pow(1-(t-${localStart.toFixed(6)})/${fadeIn.toFixed(6)},3),0))`
    }
    let y = entryY
    if (exiting && layer.role !== 'backdrop') {
      const exitStart = Math.max(localStart, localEnd - exitWindow)
      const exitRisePx = 10
      y = `if(gte(t,${exitStart.toFixed(6)}),-${exitRisePx}*(t-${exitStart.toFixed(6)})/${exitWindow.toFixed(6)},${entryY})`
    }
    y = `'${y}'`
    labels.push(`[${current}][emphasis${layerIndex}]overlay=x=0:y=${y}:enable='between(t,${localStart.toFixed(6)},${localEnd.toFixed(6)})':format=auto[wthemphasis${layerIndex}]`)
    current = `wthemphasis${layerIndex}`
  })
  // ink-read-v2：theme 金线由 drawbox 生长（v4 随 Handwrite 首 pose 落定后 4 帧
  // easeOut），enable 窗口在 quote 退场开始前 2 帧结束，避免退场瞬间露出裸金线。
  for (const [assetIndex, asset] of assets.emphasisAssets.entries()) {
    if (!asset.themeUnderline) continue
    const quote = asset.quote
    const plan = emphasisTextPlan(quote)
    const quoteLocalStart = Math.max(0, (quote.startFrame - interval.startFrame) / FPS)
    const quoteLocalEnd = Math.min(durationSec, (quote.startFrame + quote.durationInFrames - interval.startFrame) / FPS)
    const growStart = quoteLocalStart + Number(asset.themeUnderline.growDelayFrames ?? plan.entryFrames) / FPS
    const growDuration = SUBTITLE_UNDERLINE_GROW_FRAMES / FPS
    const underlineEnd = quoteLocalEnd - Number(plan.exitFrames) / FPS - 2 / FPS
    if (quoteLocalEnd <= quoteLocalStart || underlineEnd <= growStart) continue
    const underline = asset.themeUnderline
    const widthExpr = `if(lt(t,${growStart.toFixed(6)}),0,min(${underline.width},${underline.width}*(1-pow(1-(t-${growStart.toFixed(6)})/${growDuration.toFixed(6)},3))))`
    labels.push(`[${current}]drawbox=x=${underline.x}:y=${underline.y}:w='${widthExpr}':h=${underline.height}:color=0xC7A45A@0.9:t=fill:enable='between(t,${growStart.toFixed(6)},${underlineEnd.toFixed(6)})'[themeul${assetIndex}]`)
    current = `themeul${assetIndex}`
  }
  // ink-read-v2 底部字幕（dharma-text-v4）：普通入场 = 8 帧 easeOutCubic 上移 18px
  // 淡入；InlineHighlight = 落定后 6 帧暖白→金交叉淡化（gold 图层淡入盖在 A 版上）；
  // 句间 SharedAxisZ = 旧句本体 2 帧淡出 + 3 档放大变糊远去（alpha 上限 0.65）×
  // 新句 3 档缩小变糊逼近 + 本体 te+8f 起 2 帧淡入落定，共 10 帧；末句/孤立句退场
  // = blur-out 失焦消散（窗口不足 5 帧回退 v2 线性淡出）。第二行晚 2 帧入场（轴
  // 转场内新句各行同距错拍）。窗口纪律不达标的行在 prepare 阶段已定（无 gold /
  // 无轴变体资产）。
  subtitleInputs.forEach(({ layer, baseIndex, goldIndex, blurMIndex, blurBIndex, axisOldInputs, axisNewInputs }, layerIndex) => {
    const { segment } = layer
    const delayFrames = Number(layer.delayFrames || 0)
    const localStart = segment.startSec + delayFrames / FPS
    const localEnd = segment.endSec
    if (localEnd <= localStart) return
    const fadeIn = Math.min(SUBTITLE_ENTRY_FRAMES / FPS, Math.max(0.04, localEnd - localStart))
    const exitWindow = Math.min(SUBTITLE_EXIT_FRAMES / FPS, Math.max(0.04, localEnd - localStart))
    const step = SUBTITLE_AXIS_STEP_FRAMES / FPS
    const axisEntryTe = layer.axisEntryTe != null ? layer.axisEntryTe + delayFrames / FPS : null
    const axisExitTe = layer.axisExitTe
    const entryFadeStart = axisEntryTe != null
      ? axisEntryTe + (SUBTITLE_AXIS_TRANSITION_FRAMES - SUBTITLE_AXIS_STEP_FRAMES) / FPS
      : localStart
    const entryFadeDuration = axisEntryTe != null ? step : fadeIn
    const settle = axisEntryTe != null
      ? axisEntryTe + SUBTITLE_AXIS_TRANSITION_FRAMES / FPS
      : localStart + fadeIn
    const exitStart = axisExitTe != null ? axisExitTe : Math.max(localStart, localEnd - exitWindow)
    const useBlurOut = axisExitTe == null && exitWindow >= SUBTITLE_BLUR_OUT_MIN_EXIT_FRAMES / FPS
    const highlightActive = goldIndex !== null
    const yEntry = axisEntryTe != null
      ? '0'
      : `if(lt(t,${localStart.toFixed(6)}),${SUBTITLE_ENTRY_RISE_PX},if(lt(t,${settle.toFixed(6)}),${SUBTITLE_ENTRY_RISE_PX}*pow(1-(t-${localStart.toFixed(6)})/${fadeIn.toFixed(6)},3),0))`
    const exitFade = (filters) => {
      if (axisExitTe != null) {
        // 轴转场旧句本体：te 起 2 帧淡出，远去残影交给 old 档位层。
        filters.push(`fade=t=out:st=${axisExitTe.toFixed(6)}:d=${step.toFixed(6)}:alpha=1`)
      } else if (useBlurOut) {
        filters.push(`fade=t=out:st=${exitStart.toFixed(6)}:d=${(2 / FPS).toFixed(6)}:alpha=1`)
      } else {
        // 短段回退：v2 线性淡出（延后 1 帧起步、exitWindow-2 帧收尾，末帧归零）。
        filters.push(`fade=t=out:st=${Math.max(localStart, exitStart + 1 / FPS).toFixed(6)}:d=${Math.max(1 / FPS, exitWindow - 2 / FPS).toFixed(6)}:alpha=1`)
      }
      return filters
    }
    // 旧句远去 3 档（te 起每档 2 帧交错，alpha 上限 0.65）。
    axisOldInputs.forEach((index, tierIndex) => {
      const inStart = axisExitTe + tierIndex * step
      const tierFilters = [
        'format=rgba',
        `trim=duration=${durationSec.toFixed(6)}`,
        'setpts=PTS-STARTPTS',
        `fade=t=in:st=${inStart.toFixed(6)}:d=${step.toFixed(6)}:alpha=1`,
        `fade=t=out:st=${(inStart + step).toFixed(6)}:d=${step.toFixed(6)}:alpha=1`,
        `colorchannelmixer=aa=${SUBTITLE_AXIS_OLD_MAX_ALPHA}`,
      ]
      labels.push(`[${index}:v]${tierFilters.join(',')}[axisold${layerIndex}x${tierIndex}]`)
      labels.push(`[${current}][axisold${layerIndex}x${tierIndex}]overlay=x=0:y=0:enable='between(t,${inStart.toFixed(6)},${(inStart + 2 * step).toFixed(6)})':format=auto[withaxisold${layerIndex}x${tierIndex}]`)
      current = `withaxisold${layerIndex}x${tierIndex}`
    })
    // 新句逼近 3 档（错一拍起步）。
    if (axisEntryTe != null) {
      axisNewInputs.forEach((index, tierIndex) => {
        const inStart = axisEntryTe + (tierIndex + 1) * step
        const tierFilters = [
          'format=rgba',
          `trim=duration=${durationSec.toFixed(6)}`,
          'setpts=PTS-STARTPTS',
          `fade=t=in:st=${inStart.toFixed(6)}:d=${step.toFixed(6)}:alpha=1`,
          `fade=t=out:st=${(inStart + step).toFixed(6)}:d=${step.toFixed(6)}:alpha=1`,
        ]
        labels.push(`[${index}:v]${tierFilters.join(',')}[axisnew${layerIndex}x${tierIndex}]`)
        labels.push(`[${current}][axisnew${layerIndex}x${tierIndex}]overlay=x=0:y=0:enable='between(t,${inStart.toFixed(6)},${(inStart + 2 * step).toFixed(6)})':format=auto[withaxisnew${layerIndex}x${tierIndex}]`)
        current = `withaxisnew${layerIndex}x${tierIndex}`
      })
    }
    const baseFilters = [
      'format=rgba',
      `trim=duration=${durationSec.toFixed(6)}`,
      'setpts=PTS-STARTPTS',
      `fade=t=in:st=${entryFadeStart.toFixed(6)}:d=${entryFadeDuration.toFixed(6)}:alpha=1`,
    ]
    labels.push(`[${baseIndex}:v]${exitFade(baseFilters).join(',')}[subtitle${layerIndex}]`)
    labels.push(`[${current}][subtitle${layerIndex}]overlay=x=0:y='${yEntry}':enable='between(t,${localStart.toFixed(6)},${localEnd.toFixed(6)})':format=auto[withsubtitle${layerIndex}]`)
    current = `withsubtitle${layerIndex}`
    if (highlightActive) {
      const goldFilters = [
        'format=rgba',
        `trim=duration=${durationSec.toFixed(6)}`,
        'setpts=PTS-STARTPTS',
        `fade=t=in:st=${settle.toFixed(6)}:d=${(SUBTITLE_INLINE_HIGHLIGHT_FRAMES / FPS).toFixed(6)}:alpha=1`,
      ]
      labels.push(`[${goldIndex}:v]${exitFade(goldFilters).join(',')}[gold${layerIndex}]`)
      labels.push(`[${current}][gold${layerIndex}]overlay=x=0:y=0:enable='between(t,${settle.toFixed(6)},${localEnd.toFixed(6)})':format=auto[withgold${layerIndex}]`)
      current = `withgold${layerIndex}`
    }
    if (useBlurOut) {
      // blurM：exitStart 起 2 帧淡入，末 4 帧窗口内 3 帧淡出；blurB：+2 帧淡入、
      // 末 3 帧窗口内 2 帧淡出——两层最后一帧（localEnd-1f）都精确归零。
      const blurLayers = [
        { index: blurMIndex, inStart: exitStart, outStart: exitStart + exitWindow - 4 / FPS, outDuration: 3 / FPS },
        { index: blurBIndex, inStart: exitStart + 2 / FPS, outStart: exitStart + exitWindow - 3 / FPS, outDuration: 2 / FPS },
      ]
      for (const [blurIndex, blur] of blurLayers.entries()) {
        const blurFilters = [
          'format=rgba',
          `trim=duration=${durationSec.toFixed(6)}`,
          'setpts=PTS-STARTPTS',
          `fade=t=in:st=${blur.inStart.toFixed(6)}:d=${(2 / FPS).toFixed(6)}:alpha=1`,
          `fade=t=out:st=${blur.outStart.toFixed(6)}:d=${blur.outDuration.toFixed(6)}:alpha=1`,
        ]
        labels.push(`[${blur.index}:v]${blurFilters.join(',')}[blur${layerIndex}x${blurIndex}]`)
        labels.push(`[${current}][blur${layerIndex}x${blurIndex}]overlay=x=0:y=0:enable='between(t,${exitStart.toFixed(6)},${localEnd.toFixed(6)})':format=auto[withblur${layerIndex}x${blurIndex}]`)
        current = `withblur${layerIndex}x${blurIndex}`
      }
    }
  })
  labels.push(`[${current}]format=yuv420p[vout]`)
  args.push(
    '-filter_complex', labels.join(';'),
    '-map', '[vout]', '-an', '-r', String(FPS), '-fps_mode', 'cfr',
    '-frames:v', String(interval.durationInFrames),
  )
  appendVideoToolboxEncoderOptions(args)
  args.push('-f', 'h264', chunkPath)
  return run('ffmpeg', args).elapsedSec
}

function probeFrameCount(path) {
  if (!existsSync(path)) return 0
  const inputArgs = extname(path) === '.h264' ? ['-f', 'h264'] : []
  const result = run('ffprobe', [
    '-v', 'error', ...inputArgs, '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path,
  ])
  return Number(result.stdout.trim())
}

function probeVideoStream(path) {
  const result = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=has_b_frames,avg_frame_rate', '-of', 'json', path,
  ])
  return JSON.parse(result.stdout).streams?.[0] || {}
}

function fractionValue(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number)
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : Number.NaN
}

function concatenateChunks(chunks, workDir, videoPath) {
  const concatInput = `concat:${chunks.join('|')}`
  return run('ffmpeg', [
    '-hide_banner', '-y', '-fflags', '+genpts', '-f', 'h264', '-r', String(FPS), '-i', concatInput,
    '-map', '0:v:0', '-r', String(FPS), '-fps_mode', 'cfr', '-c', 'copy', '-an', '-avoid_negative_ts', 'make_zero',
    '-video_track_timescale', '90000',
    '-movflags', '+faststart', videoPath,
  ]).elapsedSec
}

function concatenateRawChunks(chunks, outputPath) {
  if (!chunks.length) fail('Cannot concatenate an empty native interval')
  const staging = `${outputPath}.${process.pid}.tmp`
  rmSync(staging, { force: true })
  writeFileSync(staging, Buffer.alloc(0))
  for (const chunk of chunks) appendFileSync(staging, readFileSync(chunk))
  renamePortable(staging, outputPath)
}

const MAX_INTERVAL_RENDER_FRAMES = 900

function splitIntervalForRender(interval) {
  if (interval.durationInFrames <= MAX_INTERVAL_RENDER_FRAMES) return [interval]
  const parts = []
  for (let startFrame = interval.startFrame; startFrame < interval.endFrame; startFrame += MAX_INTERVAL_RENDER_FRAMES) {
    const endFrame = Math.min(interval.endFrame, startFrame + MAX_INTERVAL_RENDER_FRAMES)
    const first = startFrame === interval.startFrame
    const last = endFrame === interval.endFrame
    parts.push({
      ...interval,
      startFrame,
      endFrame,
      durationInFrames: endFrame - startFrame,
      hasLayoutTransition: first && interval.hasLayoutTransition,
      pageDipIn: first && interval.pageDipIn,
      pageDipOut: last && interval.pageDipOut,
      motionFrameOffset: startFrame - interval.startFrame,
      motionTotalFrames: interval.durationInFrames,
    })
  }
  return parts
}

const sfxTones = Object.freeze({
  'low-temple-bell-v1': [196, 294, 392],
  'clear-chime-v1': [659, 988, 1318],
})

function measureIntegratedLufs(path) {
  const scan = run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path,
    '-filter_complex', 'ebur128=framelog=verbose', '-f', 'null', '-',
  ])
  const matches = [...scan.stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/gu)]
  if (!matches.length) fail(`Unable to measure SFX loudness: ${path}`)
  return Number(matches.at(-1)[1])
}

function synthesizeSfxPreset(preset, output, targetLufs) {
  const frequencies = sfxTones[preset]
  if (!frequencies) fail(`Unknown emphasis SFX preset: ${preset}`)
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const frequency of frequencies) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=0.38`)
  }
  const filters = frequencies.map((_, index) => `[${index}:a]volume=${index === 0 ? '0.72' : index === 1 ? '0.28' : '0.14'}[tone${index}]`)
  filters.push(
    `${frequencies.map((_, index) => `[tone${index}]`).join('')}amix=inputs=${frequencies.length}:duration=shortest:normalize=0,highpass=f=120,lowpass=f=2200,afade=t=in:st=0:d=0.012,afade=t=out:st=0.045:d=0.335:curve=exp,loudnorm=I=${targetLufs.toFixed(1)}:LRA=1:TP=-9,aformat=sample_rates=48000:channel_layouts=stereo[sfx]`,
  )
  args.push('-filter_complex', filters.join(';'), '-map', '[sfx]', '-c:a', 'pcm_s16le', output)
  run('ffmpeg', args)
  const duration = Number(run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output,
  ]).stdout.trim())
  if (!Number.isFinite(duration) || duration >= 0.4) fail(`Emphasis SFX exceeds 400ms: ${preset}`)
  return { durationSec: duration, integratedLufs: measureIntegratedLufs(output) }
}

function prepareSfxEvents(props, durationFrames, workDir) {
  const events = (props.quotes || [])
    .filter((quote) => quote.sfxPreset && Number(quote.startFrame) < durationFrames)
    .map((quote) => ({
      preset: quote.sfxPreset,
      startFrame: Math.max(0, Number(quote.startFrame)),
    }))
  if (!events.length) return { events: [], targetLufs: null, measuredLufs: null, maxDurationSec: 0 }
  const narrationLufs = Number.isFinite(Number(props.bgm?.narrationLufs)) ? Number(props.bgm.narrationLufs) : -16
  const targetLufs = Math.max(-55, Math.min(-32, narrationLufs - 26))
  const measurements = new Map()
  for (const preset of new Set(events.map((event) => event.preset))) {
    const output = join(workDir, `${preset}-${String(targetLufs).replace('.', '_')}.wav`)
    const measurement = existsSync(output)
      ? {
          durationSec: Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output]).stdout.trim()),
          integratedLufs: measureIntegratedLufs(output),
        }
      : synthesizeSfxPreset(preset, output, targetLufs)
    if (narrationLufs - measurement.integratedLufs < 24) {
      fail(`Emphasis SFX ${preset} is not at least 24 LU below narration`)
    }
    measurements.set(preset, { ...measurement, path: output })
  }
  return {
    events: events.map((event) => ({ ...event, ...measurements.get(event.preset) })),
    targetLufs,
    measuredLufs: Math.max(...[...measurements.values()].map((item) => item.integratedLufs)),
    maxDurationSec: Math.max(...[...measurements.values()].map((item) => item.durationSec)),
  }
}

function renderAudio(props, durationFrames, workDir, audioPath) {
  const durationSec = durationFrames / FPS
  const narrationPath = assetPath(props.audio)
  const args = ['-hide_banner', '-y', '-i', narrationPath]
  appendFilterThreadOptions(args)
  const filters = []
  let nextInputIndex = 1
  const audioStartSec = Number(props.audioStartFrame || 0) / FPS
  const narrationEndSec = Number(props.narrationEndFrame || durationFrames) / FPS
  const narrationDurationSec = Math.max(0, Math.min(durationSec, narrationEndSec - audioStartSec))
  const narrationGainValue = Number(props.bgm?.narrationGain)
  const narrationGain = Number.isFinite(narrationGainValue) && narrationGainValue > 0 ? narrationGainValue : 1
  filters.push(`[0:a]atrim=start=${audioStartSec.toFixed(6)}:duration=${narrationDurationSec.toFixed(6)},asetpts=PTS-STARTPTS,volume=${narrationGain.toFixed(6)},apad=pad_dur=${durationSec.toFixed(6)}[narration]`)
  let baseLabel = 'narration'
  let bgmGain = null
  if (props.bgm?.src) {
    const bgmPath = assetPath(props.bgm.src)
    const sourceDurationSec = Number(props.bgm.sourceDurationSec)
    if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
      fail('BGM sourceDurationSec must be a positive number')
    }
    const crossfadeSec = Number(props.bgm.loopCrossfadeSec || 4)
    const step = Math.max(1, sourceDurationSec - crossfadeSec)
    const loopCount = Math.max(1, Math.ceil((durationSec - sourceDurationSec) / step) + 1)
    const bgmInputs = []
    for (let index = 0; index < loopCount; index += 1) {
      args.push('-i', bgmPath)
      bgmInputs.push(nextInputIndex)
      nextInputIndex += 1
    }
    let bgmLabel = `${bgmInputs[0]}:a`
    for (let index = 1; index < loopCount; index += 1) {
      const output = `bgmloop${index}`
      filters.push(`[${bgmLabel}][${bgmInputs[index]}:a]acrossfade=d=${crossfadeSec.toFixed(3)}:c1=tri:c2=tri[${output}]`)
      bgmLabel = output
    }
    // `volume` is the measured no-speech bed target. `narrationVolume` is
    // consumed by the interactive Remotion mixer for speech ducking; using it
    // as a second global scalar here made the native delivery effectively lose
    // the BGM. The native path uses one stable bed gain and records the mix
    // version in result.json for stale-candidate invalidation.
    const gain = Number(props.bgm.volume || 0.025)
    if (!Number.isFinite(gain) || gain <= 0) fail('BGM volume must be a positive number')
    bgmGain = gain
    const fadeIn = Number(props.bgm.fadeInSec || 3)
    const fadeOut = Number(props.bgm.fadeOutSec || 5)
    filters.push(`[${bgmLabel}]atrim=duration=${durationSec.toFixed(6)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(6)},afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${Math.max(0, durationSec - fadeOut).toFixed(6)}:d=${fadeOut.toFixed(3)}[bed]`)
    filters.push(`[narration][bed]amix=inputs=2:duration=longest:normalize=0,atrim=duration=${durationSec.toFixed(6)}[base]`)
    baseLabel = 'base'
  }

  const sfx = prepareSfxEvents(props, durationFrames, workDir)
  const sfxLabels = []
  for (const [index, event] of sfx.events.entries()) {
    args.push('-i', event.path)
    const inputIndex = nextInputIndex
    nextInputIndex += 1
    const delayMs = Math.round(event.startFrame * 1000 / FPS)
    const label = `sfx${index}`
    filters.push(`[${inputIndex}:a]atrim=duration=${event.durationSec.toFixed(6)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}:all=1[${label}]`)
    sfxLabels.push(`[${label}]`)
  }
  let mixedLabel = baseLabel
  if (sfxLabels.length) {
    filters.push(`[${baseLabel}]${sfxLabels.join('')}amix=inputs=${sfxLabels.length + 1}:duration=longest:normalize=0,atrim=duration=${durationSec.toFixed(6)}[mixed]`)
    mixedLabel = 'mixed'
  }
  filters.push(`[${mixedLabel}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '96k', audioPath)
  return {
    elapsedSec: run('ffmpeg', args).elapsedSec,
    sfxEventCount: sfx.events.length,
    sfxTargetLufs: sfx.targetLufs,
    sfxMeasuredLufs: sfx.measuredLufs,
    sfxMaxDurationSec: sfx.maxDurationSec,
    bgmGain,
  }
}

function mux(videoPath, audioPath, outputPath, durationFrames) {
  mkdirSync(dirname(outputPath), { recursive: true })
  const staging = `${outputPath}.${process.pid}.tmp.mp4`
  const elapsedSec = run('ffmpeg', [
    '-hide_banner', '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy',
    '-t', (durationFrames / FPS).toFixed(6), '-movflags', '+faststart', staging,
  ]).elapsedSec
  renamePortable(staging, outputPath)
  return elapsedSec
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.props || !options.output) {
    fail('Usage: dharma_comic_native_renderer.mjs --props <props.json> --output <video.mp4> [--max-duration-sec 60] [--work-dir <dir>]')
  }
  const propsPath = resolve(repoRoot, options.props)
  const outputPath = resolve(repoRoot, options.output)
  const props = JSON.parse(readFileSync(propsPath, 'utf8'))
  if (props.variant !== 'progressive_five') fail('Native renderer only accepts progressive_five props')
  if (props.textPresentationVersion !== TEXT_PRESENTATION_VERSION || props.subtitlePreset !== 'ink-read-v2') {
    fail(`Native renderer requires ${TEXT_PRESENTATION_VERSION} with ink-read-v2 subtitles`)
  }
  // dharma-text-v5：生产链路只有 plate + Remotion overlay。缺少声明时不能
  // 默默恢复到 burned 全层滤镜图，否则一段长视频会把数百个 PNG 层同时送入 FFmpeg。
  if (props.textLayers !== 'overlay') {
    fail("Native renderer requires textLayers='overlay' for production plate rendering")
  }
  const plateMode = true
  for (const fontPath of [FONT_SANS, FONT_SERIF, FONT_HAND]) {
    if (!existsSync(fontPath)) fail(`Bundled production font is missing: ${fontPath}`)
  }
  if (Number(props.width || WIDTH) !== WIDTH || Number(props.height || HEIGHT) !== HEIGHT || Number(props.fps || FPS) !== FPS) {
    fail('Native renderer is locked to 1280x720 at 30fps')
  }
  const maxDurationSec = options.max_duration_sec ? Number(options.max_duration_sec) : undefined
  const motionMode = options.motion_mode || 'perspective-linear'
  motionFilter(motionMode, 0, 30)
  const durationFrames = Math.min(props.durationInFrames, Number.isFinite(maxDurationSec) ? Math.round(maxDurationSec * FPS) : props.durationInFrames)
  const intervals = buildIntervals(props, maxDurationSec)
  assertContinuousIntervals(intervals, durationFrames)
  const propsSha256 = fileSha256(propsPath)
  const workDir = resolve(repoRoot, options.work_dir || `data/temp/dharma-native-${propsSha256.slice(0, 12)}-${durationFrames}f`)
  mkdirSync(workDir, { recursive: true })

  const stageTimes = {
    assetPrepSec: 0,
    intervalEncodeSec: 0,
    concatSec: 0,
    frameValidationSec: 0,
    audioSec: 0,
    muxSec: 0,
    outputValidationSec: 0,
  }
  const pipelineStarted = performance.now()
  const chunks = []
  for (const interval of intervals) {
    const intervalDir = join(workDir, `interval-${String(interval.index).padStart(3, '0')}`)
    const chunkPath = join(intervalDir, 'video.h264')
    const fingerprintPath = join(intervalDir, 'fingerprint.txt')
    const expectedFingerprint = intervalFingerprint(props, interval, motionMode)
    const cachedFingerprint = existsSync(fingerprintPath) ? readFileSync(fingerprintPath, 'utf8').trim() : ''
    if (cachedFingerprint !== expectedFingerprint) {
      rmSync(intervalDir, { recursive: true, force: true })
    }
    if (probeFrameCount(chunkPath) !== interval.durationInFrames) {
      if (existsSync(chunkPath)) rmSync(chunkPath)
      const renderParts = splitIntervalForRender(interval)
      const partChunks = []
      for (const [partIndex, part] of renderParts.entries()) {
        const partDir = renderParts.length === 1
          ? intervalDir
          : join(intervalDir, `part-${String(partIndex).padStart(3, '0')}`)
        const partChunkPath = renderParts.length === 1
          ? chunkPath
          : join(partDir, 'video.h264')
        const prepStarted = performance.now()
        const assets = await prepareIntervalAssets(props, part, partDir)
        stageTimes.assetPrepSec += (performance.now() - prepStarted) / 1000
        if (probeFrameCount(partChunkPath) !== part.durationInFrames) {
          if (existsSync(partChunkPath)) rmSync(partChunkPath)
          stageTimes.intervalEncodeSec += renderInterval(props, part, assets, partChunkPath, motionMode)
        }
        if (probeFrameCount(partChunkPath) !== part.durationInFrames) {
          fail(`Interval ${interval.index} part ${partIndex} did not encode ${part.durationInFrames} frames`)
        }
        partChunks.push(partChunkPath)
      }
      if (renderParts.length > 1) concatenateRawChunks(partChunks, chunkPath)
      if (probeFrameCount(chunkPath) !== interval.durationInFrames) {
        fail(`Interval ${interval.index} did not encode ${interval.durationInFrames} frames`)
      }
      atomicWrite(fingerprintPath, `${expectedFingerprint}\n`)
    }
    chunks.push(chunkPath)
    const completedFrames = interval.endFrame
    const elapsedSec = (performance.now() - pipelineStarted) / 1000
    const fps = completedFrames / Math.max(0.001, elapsedSec)
    console.log(JSON.stringify({ stage: 'native_visual', interval: interval.index + 1, intervals: intervals.length, completedFrames, totalFrames: durationFrames, fps: Number(fps.toFixed(1)) }))
  }

  const videoPath = join(workDir, 'video.mp4')
  const audioPath = join(workDir, 'audio.m4a')
  stageTimes.concatSec = concatenateChunks(chunks, workDir, videoPath)
  const frameValidationStarted = performance.now()
  const concatenatedFrames = probeFrameCount(videoPath)
  stageTimes.frameValidationSec = (performance.now() - frameValidationStarted) / 1000
  if (concatenatedFrames !== durationFrames) {
    fail(`Concatenated video has ${concatenatedFrames} frames, expected ${durationFrames}`)
  }
  const audioResult = renderAudio(props, durationFrames, workDir, audioPath)
  stageTimes.audioSec = audioResult.elapsedSec
  stageTimes.muxSec = mux(videoPath, audioPath, outputPath, durationFrames)
  const outputValidationStarted = performance.now()
  const outputFrames = probeFrameCount(outputPath)
  stageTimes.outputValidationSec = (performance.now() - outputValidationStarted) / 1000
  if (outputFrames !== durationFrames) {
    fail(`Delivery has ${outputFrames} video packets, expected ${durationFrames}`)
  }
  const outputStream = probeVideoStream(outputPath)
  if (Number(outputStream.has_b_frames) !== 0) {
    fail('Delivery must not contain B-frames because raw interval concatenation requires PTS=DTS')
  }
  if (Math.abs(fractionValue(outputStream.avg_frame_rate) - FPS) > 0.001) {
    fail(`Delivery must be 30fps, got ${outputStream.avg_frame_rate}`)
  }
  const wallSec = (performance.now() - pipelineStarted) / 1000
  const outputBytes = statSync(outputPath).size
  const result = {
    renderer: NATIVE_RENDERER_VERSION,
    videoEncoder: DHARMA_VIDEO_ENCODER,
    textLayers: plateMode ? 'overlay' : 'burned',
    output: outputPath,
    propsSha256,
    outputSha256: fileSha256(outputPath),
    outputBytes,
    bytes: outputBytes,
    durationFrames,
    verifiedVideoFrames: concatenatedFrames,
    verifiedDeliveryFrames: outputFrames,
    verifiedHasBFrames: Number(outputStream.has_b_frames),
    verifiedAverageFrameRate: outputStream.avg_frame_rate,
    intervalCount: intervals.length,
    motionMode,
    textPresentationVersion: TEXT_PRESENTATION_VERSION,
    subtitlePreset: props.subtitlePreset,
    sfxEventCount: audioResult.sfxEventCount,
    sfxTargetLufs: audioResult.sfxTargetLufs,
    sfxMeasuredLufs: audioResult.sfxMeasuredLufs,
    sfxMaxDurationSec: audioResult.sfxMaxDurationSec,
    bgmMounted: Boolean(props.bgm?.src),
    bgmGain: audioResult.bgmGain,
    audioMixVersion: NATIVE_AUDIO_MIX_VERSION,
    wallSec: Number(wallSec.toFixed(3)),
    stages: Object.fromEntries(Object.entries(stageTimes).map(([key, value]) => [key, Number(value.toFixed(3))])),
  }
  atomicWrite(join(workDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
}

const renderLock = process.env.DHARMA_RENDER_LOCK_HELD === '1'
  ? null
  : acquireDharmaRenderLock({
      metadata: { renderer: NATIVE_RENDERER_VERSION, pid: process.pid },
    })
try {
  await main()
} finally {
  if (renderLock) releaseDharmaRenderLock(renderLock)
}
