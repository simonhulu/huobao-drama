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
import sharp from 'sharp'
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
  thumbnail_layout?: 'text-left' | 'text-right'
  highlight_text?: string
  /** Explicit science-poster line breaks; legacy thumbnails keep automatic two-line fitting. */
  headline_lines?: 2 | 3
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

export interface CoverVariant {
  key: string
  baseImagePath: string
  width: number
  height: number
}

export interface CoverVariantsInput {
  design: CoverDesign
  variants: CoverVariant[]
  outputDir: string
}

export interface ComposedCoverVariant {
  key: string
  path: string
  width: number
  height: number
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
  if (design.thumbnail_layout === 'text-left' || design.thumbnail_layout === 'text-right') {
    return buildThumbnailCoverHtml(design, bgDataUrl, width, height)
  }
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

function buildThumbnailCoverHtml(design:CoverDesign,bgDataUrl:string,width:number,height:number) {
  const explicitLines=design.headline_lines===2 || design.headline_lines===3
  const title=(explicitLines?String(design.main_title || '').trim():cleanText(design.main_title)) || '本集真相',highlight=cleanText(design.highlight_text)
  const at=highlight?title.indexOf(highlight):-1
  const escapeTitle=explicitLines?escapeHtmlWithBreaks:escapeHtml
  const headline=at<0?escapeTitle(title):`${escapeTitle(title.slice(0,at))}<span class="highlight">${escapeHtml(highlight)}</span>${escapeTitle(title.slice(at+highlight.length))}`
  const landscape=width>=height,scale=landscape?height:width,left=design.thumbnail_layout==='text-left'
  const titleSize=explicitLines?Math.min(Math.round(scale*.21),Math.floor(height*(landscape?.70:.44)/(design.headline_lines!*1.08))):Math.round(scale*.21)
  const accent=safeAccentColor(design.accent_color || '#FFE044'),subtitle=cleanText(design.sub_title)
  const label=[cleanText(design.kicker),cleanText(design.episode_label)].filter(Boolean).join(' / ')
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#171717}
.stage{position:relative;width:100%;height:100%;background-image:url('${bgDataUrl}');background-size:cover;background-position:center}
.shade{position:absolute;inset:0;background:linear-gradient(${left?'90':'270'}deg,rgba(16,24,32,.28),rgba(16,24,32,.06) 48%,transparent 65%)}
.copy{position:absolute;${left?'left':'right'}:5%;top:${landscape?'15%':'6%'};width:${landscape?'55%':'90%'};height:${landscape?'72%':'46%'};display:flex;flex-direction:column;justify-content:center;gap:${Math.round(scale*.035)}px;font-family:"PingFang SC","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei",sans-serif;letter-spacing:0}
.label{color:white;font-size:${Math.round(scale*.045)}px;line-height:1.15;font-weight:800;text-shadow:0 2px 4px #000}
.main-title{color:#fff;font-size:${titleSize}px;line-height:1.08;font-weight:900;overflow-wrap:anywhere;text-wrap:balance;-webkit-text-stroke:${Math.max(2,Math.round(scale*.009))}px #151515;paint-order:stroke fill;text-shadow:0 ${Math.round(scale*.006)}px ${Math.round(scale*.012)}px #000}
.highlight{color:${accent};display:inline-block;white-space:nowrap}
.sub-title{align-self:flex-start;max-width:100%;padding:${Math.round(scale*.012)}px ${Math.round(scale*.024)}px;background:${accent};color:#101010;font-size:${Math.round(scale*.063)}px;line-height:1.2;font-weight:900;overflow-wrap:anywhere;text-wrap:balance;box-shadow:0 2px 4px #0005}
</style></head><body><div class="stage"><div class="shade"></div><div class="copy" data-thumbnail-copy${explicitLines?' data-explicit-headline':''}>
${label?`<div class="label">${escapeHtml(label)}</div>`:''}
<div class="main-title" data-fit-lines="${explicitLines?design.headline_lines:2}">${headline}</div>
${subtitle?`<div class="sub-title" data-fit-lines="2">${escapeHtml(subtitle)}</div>`:''}
</div></div></body></html>`
}

async function renderOne(
  page: Page,
  design: CoverDesign,
  bgDataUrl: string,
  width: number,
  height: number,
  outDir: string,
  filename = `${uuid()}.png`,
): Promise<string> {
  const html = buildCoverHtml(design, bgDataUrl, width, height)
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-fit-lines]')) {
      const style=getComputedStyle(el),ratio=parseFloat(style.lineHeight)/parseFloat(style.fontSize)
      let size=parseFloat(style.fontSize)
      const lines=Number(el.dataset.fitLines)
      while(size>18 && (el.scrollWidth>el.clientWidth+1 || el.getBoundingClientRect().height>size*ratio*lines+2)) {
        size-=2;el.style.fontSize=size+'px'
      }
    }
    const copy=document.querySelector<HTMLElement>('[data-thumbnail-copy]')
    // The combined headline, label and subtitle must fit the same safe area.
    const title=copy?.querySelector<HTMLElement>('.main-title')
    if(copy && title) {
      let size=parseFloat(getComputedStyle(title).fontSize)
      while(size>18 && (copy.scrollHeight>copy.clientHeight+1 || copy.scrollWidth>copy.clientWidth+1)) {
        size-=2;title.style.fontSize=size+'px'
      }
    }
    if(copy && (copy.scrollHeight>copy.clientHeight+1 || copy.scrollWidth>copy.clientWidth+1))throw Error('封面文字超出安全区，请缩短封面文案')
  })

  const buffer = await page.screenshot({
    clip: { x: 0, y: 0, width, height },
    type: 'png',
  })

  const filePath = path.join(outDir, filename)
  fs.writeFileSync(filePath, buffer)

  return `static/covers/${filename}`
}

/** Render each format from its unlettered local image, never from a finished cover. */
export async function composeCoverVariants(input: CoverVariantsInput): Promise<ComposedCoverVariant[]> {
  if (!input.variants.length) throw new Error('At least one cover variant is required')
  const keys = new Set<string>()
  for (const variant of input.variants) {
    if (!/^[a-z0-9_-]+$/i.test(variant.key)) {
      throw new Error(`Invalid cover variant key: ${variant.key}`)
    }
    const key = variant.key.toLowerCase()
    if (keys.has(key)) throw new Error(`Duplicate cover variant key: ${variant.key}`)
    keys.add(key)
    if (!Number.isSafeInteger(variant.width) || variant.width <= 0
      || !Number.isSafeInteger(variant.height) || variant.height <= 0) {
      throw new Error(`Invalid cover dimensions for ${variant.key}`)
    }
  }

  const backgrounds = new Map<string, string>()
  for (const variant of input.variants) {
    const imagePath = path.resolve(variant.baseImagePath)
    if (!backgrounds.has(imagePath)) {
      const buffer = await sharp(imagePath).rotate().png().toBuffer()
      backgrounds.set(imagePath, `data:image/png;base64,${buffer.toString('base64')}`)
    }
  }
  const executablePath = getChromeExecutablePath()
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chrome executable not found: ${executablePath}`)
  }
  const outDir = path.resolve(input.outputDir)
  fs.mkdirSync(outDir, { recursive: true })
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
    const results: ComposedCoverVariant[] = []
    for (const variant of input.variants) {
      const filename = `${variant.key}.png`
      await renderOne(page, input.design, backgrounds.get(path.resolve(variant.baseImagePath))!,
        variant.width, variant.height, outDir, filename)
      results.push({
        key: variant.key,
        path: path.join(outDir, filename),
        width: variant.width,
        height: variant.height,
      })
    }
    return results
  } finally {
    await browser.close()
  }
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
