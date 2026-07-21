import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { db, schema } from '../db/index.js'
import { eq, asc } from 'drizzle-orm'
import { fileURLToPath } from 'url'
import { loadMusicLibrary } from './music-library.js'
import { getVideoEncoderOptions } from './composition/video-encoder.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(__dirname, '../../../data')
const INTRO_DIR = path.join(DATA_ROOT, 'static', 'intros')
const REMOTION_DIR = path.resolve(__dirname, '../../../remotion')
const REMOTION_CLI = path.join(REMOTION_DIR, 'node_modules/.bin/remotion')
const CHROME_EXECUTABLE = path.join(
  REMOTION_DIR,
  '../.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell'
)

export interface IntroComposeInput {
  episodeId: number
  episodeNumber: number
  dramaTitle?: string | null
  templateId?: string | null
  aspectRatio?: string | null
}

export interface IntroTemplateConfig {
  duration: number
  background: { type: 'color' | 'image'; value: string }
  variables?: Record<string, { source: string; fallback?: string }>
  layers: Array<{
    type: 'text' | 'image'
    content: string
    fontSize?: number
    color?: string
    position?: string
    animation?: { type: string; duration: number; delay?: number }
  }>
  audio?: any
  component?: string
  cards?: Array<{ text: string; sub?: string }>
  bgmAssetId?: string
}

const REMOTION_TEMPLATE_IDS = [
  'black-title-fade',
  'dynasty-year-flash',
  'vintage-ken-burns',
] as const
type RemotionTemplateId = typeof REMOTION_TEMPLATE_IDS[number]

function isRemotionTemplate(id: string): id is RemotionTemplateId {
  return REMOTION_TEMPLATE_IDS.includes(id as RemotionTemplateId)
}

function parseAspectRatio(aspectRatio?: string | null): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 1080, height: 1920 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:3':
      return { width: 1440, height: 1080 }
    case '16:9':
    default:
      return { width: 1920, height: 1080 }
  }
}

function resolveVariables(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

function findSystemFont(): string | undefined {
  const candidates = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (data) => { stderr += String(data) })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

function validateVideo(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (data) => { stderr += String(data) })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Rendered video is corrupt or unreadable: ${stderr.trim() || `ffprobe exited ${code}`}`))
        return
      }
      resolve()
    })
  })
}

function runCommand(cmd: string, args: string[], options: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: options.cwd, stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}`))
    })
  })
}

function getServerBaseUrl(): string {
  const port = process.env.PORT || '5679'
  return `http://localhost:${port}`
}

function toStaticUrl(localPath: string | null | undefined, baseUrl: string): string | null {
  if (!localPath) return null
  if (/^https?:\/\//.test(localPath)) return localPath
  const rel = localPath.replace(/^\/+/, '').replace(/^static\//, '')
  return `${baseUrl}/static/${rel}`
}

const DEFAULT_BGM_ASSET_ID = '2342ac04-1107-4b15-96a3-00a9e64246e6'

function resolveBgmUrl(bgmAssetId: string | undefined, baseUrl: string): string | null {
  const assetId = bgmAssetId?.trim() || DEFAULT_BGM_ASSET_ID
  const lib = loadMusicLibrary()
  const entry = lib.entries.find((e) => e.filename.startsWith(`${assetId}.`) || e.relativePath.includes(assetId))
  if (!entry) {
    console.warn(`[IntroComposer] BGM asset ${assetId} not found in music library`)
    return null
  }
  return toStaticUrl(entry.relativePath, baseUrl)
}

function firstSentence(text?: string | null): string {
  if (!text) return ''
  const match = text.match(/^[^，。！？,.!?]+/)
  return match ? match[0].trim() : text.trim()
}

async function renderClassicTitleFadeIntro(input: IntroComposeInput): Promise<string> {
  const { width, height } = parseAspectRatio(input.aspectRatio)
  const duration = 4
  const title = input.dramaTitle?.trim() || '精彩短剧'
  const outputFilename = `${input.episodeId}-intro.mp4`
  const outputPath = path.join(INTRO_DIR, outputFilename)
  fs.mkdirSync(INTRO_DIR, { recursive: true })

  const fontPath = findSystemFont()
  const safeTitle = title.replace(/'/g, "'\\''")
  const fontSize = Math.min(72, Math.round(width / 12))
  const fadeInDuration = 1.5
  const delay = 0.5

  const fontFileOption = fontPath ? `fontfile='${fontPath.replace(/'/g, "'\\'")}':` : ''
  const drawtextFilter = `drawtext=${fontFileOption}text='${safeTitle}':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t\\,${delay})\\,0\\,if(lt(t\\,${delay + fadeInDuration})\\,(t-${delay})/${fadeInDuration}\\,if(lt(t\\,${duration - 0.5})\\,1\\,if(lt(t\\,${duration})\\,(${duration}-t)/0.5\\,0))))'`

  await runFfmpeg([
    '-f', 'lavfi',
    '-i', `color=c=black:s=${width}x${height}:d=${duration}`,
    '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', drawtextFilter,
    '-t', String(duration),
    ...getVideoEncoderOptions(),
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '128k',
    '-shortest',
    '-y',
    outputPath,
  ])

  return path.join('static', 'intros', outputFilename)
}

function compositionIdForTemplate(templateId: RemotionTemplateId): string {
  switch (templateId) {
    case 'black-title-fade':
      return 'BlackTitleIntro'
    case 'dynasty-year-flash':
      return 'DynastyYearFlash'
    case 'vintage-ken-burns':
      return 'VintageKenBurns'
  }
}

function defaultDynastyCards(dramaTitle: string): Array<{ text: string; sub?: string }> {
  return [
    { text: '大明', sub: 'Ming Dynasty' },
    { text: '万历十年', sub: 'Year of Wanli 10' },
    { text: '1582', sub: 'June' },
    { text: dramaTitle || '历史转折', sub: 'A turning point' },
  ]
}

async function renderRemotionIntro(
  input: IntroComposeInput,
  templateId: RemotionTemplateId
): Promise<string> {
  const baseUrl = getServerBaseUrl()
  const outputFilename = `${input.episodeId}-${templateId}.mp4`
  const outputPath = path.join(INTRO_DIR, outputFilename)
  fs.mkdirSync(INTRO_DIR, { recursive: true })

  const [episode] = db
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.id, input.episodeId))
    .all()
  const [drama] = episode
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
    : [undefined]

  const storyboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, input.episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
    .filter((sb) => sb.firstFrameImage || sb.composedImage)

  const imageUrls = storyboards
    .slice(0, 4)
    .map((sb) => toStaticUrl(sb.firstFrameImage || sb.composedImage, baseUrl))
    .filter((url): url is string => Boolean(url))

  const template = input.templateId
    ? db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, input.templateId)).all()[0]
    : undefined
  const config = (template?.config as IntroTemplateConfig | undefined) ?? { duration: 4, background: { type: 'color', value: '#000000' }, layers: [] }

  const dramaTitle = drama?.title?.trim() || input.dramaTitle?.trim() || '精彩短剧'
  const episodeTitle = episode?.title?.trim() || `第${input.episodeNumber}集`
  const openingHook = episode?.openingHook?.trim() || drama?.hook?.trim() || ''
  const mainText = firstSentence(openingHook) || dramaTitle
  const subText = episodeTitle

  const aspectRatio = input.aspectRatio || episode?.aspectRatio || '16:9'
  const compositionId = compositionIdForTemplate(templateId)

  let props: Record<string, unknown> = {
    aspectRatio,
    durationInFrames: Math.round(config.duration * 30),
  }

  if (templateId === 'black-title-fade') {
    const bgmUrl = resolveBgmUrl(config.bgmAssetId, baseUrl)
    props = {
      ...props,
      mainText,
      subText,
      images: imageUrls.length ? imageUrls : undefined,
      bgmUrl,
    }
  } else if (templateId === 'dynasty-year-flash') {
    const cards = config.cards?.length ? config.cards : defaultDynastyCards(dramaTitle)
    props = {
      ...props,
      cards,
      bellUrl: `${baseUrl}/static/intros/bell_sfx.m4a`,
    }
  } else if (templateId === 'vintage-ken-burns') {
    const bgmUrl = resolveBgmUrl(config.bgmAssetId, baseUrl)
    props = {
      ...props,
      image: imageUrls[0] || `${baseUrl}/static/intros/placeholder.jpg`,
      title: mainText,
      subtitle: subText,
      audioUrl: bgmUrl,
    }
  }

  const propsPath = path.join(INTRO_DIR, `${input.episodeId}-${templateId}-props.json`)
  fs.writeFileSync(propsPath, JSON.stringify(props, null, 2))

  await runCommand(
    REMOTION_CLI,
    [
      'render',
      `--browser-executable=${CHROME_EXECUTABLE}`,
      `--props=${propsPath}`,
      '--concurrency=1',
      'src/index.tsx',
      compositionId,
      outputPath,
      '--codec=h264',
    ],
    { cwd: REMOTION_DIR }
  )

  await validateVideo(outputPath)

  return path.join('static', 'intros', outputFilename)
}

export async function composeIntroForEpisode(input: IntroComposeInput): Promise<string | null> {
  let template = input.templateId
    ? db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, input.templateId)).all()[0]
    : undefined

  if (!template) {
    const defaults = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.isDefault, true)).all()
    template = defaults[0]
  }

  if (template && isRemotionTemplate(template.id)) {
    return renderRemotionIntro(input, template.id)
  }

  if (!template) {
    return renderRemotionIntro({ ...input, templateId: 'black-title-fade' }, 'black-title-fade')
  }

  const config = template.config as IntroTemplateConfig

  if (template.id === 'classic-title-fade') {
    return renderRemotionIntro({ ...input, templateId: 'black-title-fade' }, 'black-title-fade')
  }

  console.warn(`Intro template ${template.id} renderer not implemented yet, falling back to black-title-fade`)
  return renderRemotionIntro({ ...input, templateId: 'black-title-fade' }, 'black-title-fade')
}
