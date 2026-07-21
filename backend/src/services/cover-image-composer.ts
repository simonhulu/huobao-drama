/**
 * 封面图合成器。
 *
 * 生图模型只负责无字底图，标题由浏览器渲染，保证中文字体、层级和安全区
 * 在所有 episode 上保持一致。底图仍按横/竖两个方向分别生成，避免简单裁切
 * 把人物或关键物件切掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Page } from 'puppeteer-core'
import { v4 as uuid } from 'uuid'
import { readImageAsDataUrl } from '../utils/storage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface CoverDesign {
  type?: string
  recommended_aspect_ratio?: string
  description?: string
  main_title?: string
  sub_title?: string
  kicker?: string
  episode_label?: string
  brand_label?: string
  accent_color?: string
  color_and_font?: string
  ai_prompt?: string
  rationale?: string
}

export interface CoverComposerInput {
  design: CoverDesign
  baseImage4x3Path: string
  baseImage3x4Path: string
  outputDir?: string
}

export interface CoverComposerResult {
  cover4x3Url: string
  cover3x4Url: string
}

export interface SingleCoverComposerInput {
  design: CoverDesign
  baseImagePath: string
  frameType: '4:3' | '3:4'
  outputDir?: string
}

const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

function getChromeExecutablePath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  const remotionChrome = path.resolve(
    __dirname,
    '../../../.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  )
  if (fs.existsSync(remotionChrome)) return remotionChrome
  const linuxRemotion = path.resolve(
    __dirname,
    '../../../.remotion-chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell',
  )
  if (fs.existsSync(linuxRemotion)) return linuxRemotion
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function escapeHtmlWithBreaks(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

function cleanText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function safeAccentColor(value: unknown): string {
  const color = cleanText(value)
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#d7a649'
}

function compactTitle(title: string): { mainTitle: string; subTitle: string } {
  const clean = cleanText(title)
  if (!clean) return { mainTitle: '本集真相', subTitle: '' }

  const parts = clean.split(/[?？:：!！；;]/).map(part => part.trim()).filter(Boolean)
  if (parts.length >= 2 && (parts[0]?.length || 0) >= 3 && (parts[1]?.length || 0) >= 3) {
    return { mainTitle: parts[0]!, subTitle: parts.slice(1).join(' · ') }
  }
  if (clean.length <= 10) return { mainTitle: clean, subTitle: '' }
  return { mainTitle: clean.slice(0, 10), subTitle: clean.slice(10) }
}

export function buildFallbackCoverDesign(
  episodeTitle: string,
  episodeNumber?: number,
  prompt?: string,
): CoverDesign {
  const titles = compactTitle(episodeTitle)
  return {
    type: '主题拆解',
    main_title: titles.mainTitle,
    sub_title: titles.subTitle,
    kicker: '一眼看懂关键冲突',
    episode_label: Number.isFinite(episodeNumber) ? `第${episodeNumber}集` : '',
    brand_label: '',
    accent_color: '#d7a649',
    ai_prompt: cleanText(prompt),
    rationale: '使用本集标题提炼主钩子，并保留原始画面设想作为无字底图提示。',
  }
}

export function normalizeCoverDesign(
  design: CoverDesign,
  episodeTitle: string,
  episodeNumber?: number,
  fallbackPrompt?: string,
): CoverDesign {
  const fallback = buildFallbackCoverDesign(episodeTitle, episodeNumber, fallbackPrompt)
  return {
    ...fallback,
    ...design,
    main_title: cleanText(design.main_title) || fallback.main_title,
    sub_title: cleanText(design.sub_title),
    kicker: cleanText(design.kicker) || cleanText(design.type) || fallback.kicker,
    episode_label: cleanText(design.episode_label) || fallback.episode_label,
    brand_label: '',
    accent_color: safeAccentColor(design.accent_color),
    ai_prompt: cleanText(design.ai_prompt) || fallback.ai_prompt,
  }
}

export function buildCoverHtml(design: CoverDesign, bgDataUrl: string, width: number, height: number): string {
  const mainTitleText = cleanText(design.main_title) || '本集真相'
  const subTitleText = cleanText(design.sub_title)
  const kickerText = cleanText(design.kicker) || cleanText(design.type) || '主题拆解'
  const episodeLabelText = cleanText(design.episode_label)
  const mainTitle = escapeHtmlWithBreaks(mainTitleText)
  const subTitle = escapeHtmlWithBreaks(subTitleText)
  const kicker = escapeHtml(kickerText)
  const episodeLabel = escapeHtml(episodeLabelText)
  const accent = safeAccentColor(design.accent_color)
  const isLandscape = width >= height
  const scale = isLandscape ? height : width
  const titleLength = Array.from(mainTitleText).length
  const titleSizeFactor = titleLength > 12 ? 0.78 : titleLength > 9 ? 0.9 : 1
  const mainSize = Math.round(scale * (isLandscape ? 0.125 : 0.112) * titleSizeFactor)
  const subSize = Math.round(scale * (isLandscape ? 0.038 : 0.036))
  const kickerSize = Math.round(scale * (isLandscape ? 0.021 : 0.022))
  const copyTop = isLandscape ? '8.5%' : '7.5%'
  const copyLeft = isLandscape ? '7.5%' : '8%'
  const copyWidth = isLandscape ? '62%' : '84%'
  const frameInset = isLandscape ? '2.8%' : '2.2%'

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #090b0f; }
.stage {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-image: url('${bgDataUrl}');
  background-size: cover;
  background-position: center;
  isolation: isolate;
}
.stage::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    linear-gradient(90deg, rgba(5, 8, 12, .88) 0%, rgba(5, 8, 12, .58) 34%, rgba(5, 8, 12, .08) 76%, rgba(5, 8, 12, .28) 100%),
    linear-gradient(180deg, rgba(4, 6, 9, .68) 0%, rgba(4, 6, 9, .04) 36%, rgba(4, 6, 9, .48) 100%);
}
.stage::after {
  content: '';
  position: absolute;
  inset: ${frameInset};
  border: 1px solid rgba(255, 247, 226, .2);
  pointer-events: none;
}
.copy {
  position: absolute;
  top: ${copyTop};
  left: ${copyLeft};
  width: ${copyWidth};
  color: #fff8e9;
  text-align: left;
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: ${Math.round(scale * 0.014)}px;
  min-height: ${Math.round(scale * 0.034)}px;
  color: ${accent};
  font-family: "PingFang SC", "Hiragino Sans GB", "STHeiti", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
  font-size: ${kickerSize}px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0;
  text-shadow: 0 2px 8px rgba(0,0,0,.55);
}
.eyebrow-rule {
  display: block;
  width: ${Math.round(scale * 0.058)}px;
  height: ${Math.max(4, Math.round(scale * 0.004))}px;
  background: ${accent};
  box-shadow: 0 0 16px ${accent};
}
.episode-label {
  padding-left: ${Math.round(scale * 0.014)}px;
  border-left: 1px solid rgba(255,255,255,.4);
  color: rgba(255,255,255,.78);
  font-weight: 600;
}
.main-title {
  margin-top: ${Math.round(scale * 0.028)}px;
  max-width: 100%;
  color: #fff8e9;
  font-family: "PingFang SC", "Hiragino Sans GB", "STHeiti", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "Heiti SC", sans-serif;
  font-size: ${mainSize}px;
  font-weight: 900;
  line-height: 1.02;
  letter-spacing: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: balance;
  text-shadow: 0 3px 0 rgba(0,0,0,.34), 0 8px 22px rgba(0,0,0,.64);
  -webkit-text-stroke: .7px rgba(37, 23, 8, .28);
}
.title-rule {
  width: ${Math.round(scale * 0.11)}px;
  height: ${Math.max(4, Math.round(scale * 0.005))}px;
  margin-top: ${Math.round(scale * 0.024)}px;
  background: ${accent};
  box-shadow: 0 0 20px rgba(215,166,73,.34);
}
.sub-title {
  max-width: 96%;
  margin-top: ${Math.round(scale * 0.024)}px;
  padding-left: ${Math.round(scale * 0.018)}px;
  border-left: ${Math.max(4, Math.round(scale * 0.005))}px solid ${accent};
  color: rgba(255, 248, 233, .9);
  font-family: "PingFang SC", "Hiragino Sans GB", "STHeiti", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
  font-size: ${subSize}px;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  text-shadow: 0 3px 12px rgba(0,0,0,.68);
}
</style>
</head>
<body>
  <div class="stage">
    <div class="copy">
      <div class="eyebrow">
        <span class="eyebrow-rule"></span>
        <span>${kicker}</span>
        ${episodeLabel ? `<span class="episode-label">${episodeLabel}</span>` : ''}
      </div>
      <div class="main-title">${mainTitle}</div>
      <div class="title-rule"></div>
      ${subTitle ? `<div class="sub-title">${subTitle}</div>` : ''}
    </div>
  </div>
</body>
</html>`
}

async function renderOne(
  page: Page,
  design: CoverDesign,
  bgDataUrl: string,
  width: number,
  height: number,
  outDir: string,
): Promise<string> {
  const html = buildCoverHtml(design, bgDataUrl, width, height)
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)

  const buffer = await page.screenshot({
    clip: { x: 0, y: 0, width, height },
    type: 'png',
  })

  const filename = `${uuid()}.png`
  const filePath = path.join(outDir, filename)
  fs.writeFileSync(filePath, buffer)

  return `static/covers/${filename}`
}

export async function composeCoverImages(input: CoverComposerInput): Promise<CoverComposerResult> {
  const { design, baseImage4x3Path, baseImage3x4Path } = input
  const outDir = input.outputDir ? path.resolve(input.outputDir) : path.join(STORAGE_ROOT, 'covers')
  fs.mkdirSync(outDir, { recursive: true })

  const bg4x3 = readImageAsDataUrl(baseImage4x3Path)
  const bg3x4 = readImageAsDataUrl(baseImage3x4Path)

  const executablePath = getChromeExecutablePath()
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chrome executable not found: ${executablePath}`)
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--allow-file-access-from-files',
    ],
  })

  try {
    const page4x3 = await browser.newPage()
    const page3x4 = await browser.newPage()
    const [cover4x3Url, cover3x4Url] = await Promise.all([
      renderOne(page4x3, design, bg4x3, 1440, 1080, outDir),
      renderOne(page3x4, design, bg3x4, 1080, 1440, outDir),
    ])
    return { cover4x3Url, cover3x4Url }
  } finally {
    await browser.close()
  }
}

export async function composeCoverImage(input: SingleCoverComposerInput): Promise<string> {
  const outDir = input.outputDir ? path.resolve(input.outputDir) : path.join(STORAGE_ROOT, 'covers')
  fs.mkdirSync(outDir, { recursive: true })

  const bg = readImageAsDataUrl(input.baseImagePath)
  const executablePath = getChromeExecutablePath()
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chrome executable not found: ${executablePath}`)
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--allow-file-access-from-files',
    ],
  })

  try {
    const page = await browser.newPage()
    const [width, height] = input.frameType === '4:3' ? [1440, 1080] : [1080, 1440]
    return await renderOne(page, input.design, bg, width, height, outDir)
  } finally {
    await browser.close()
  }
}
