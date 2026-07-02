import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(__dirname, '../../../data')
const INTRO_DIR = path.join(DATA_ROOT, 'static', 'intros')

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

async function renderClassicTitleFadeIntro(input: IntroComposeInput): Promise<string> {
  const { width, height } = parseAspectRatio(input.aspectRatio)
  const duration = 3
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
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
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

export async function composeIntroForEpisode(input: IntroComposeInput): Promise<string | null> {
  let template = input.templateId
    ? db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, input.templateId)).all()[0]
    : undefined

  if (!template) {
    const defaults = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.isDefault, true)).all()
    template = defaults[0]
  }

  if (!template) {
    return renderClassicTitleFadeIntro(input)
  }

  const config = template.config as IntroTemplateConfig

  if (template.id === 'classic-title-fade') {
    return renderClassicTitleFadeIntro(input)
  }

  console.warn(`Intro template ${template.id} renderer not implemented yet, falling back to classic title fade`)
  return renderClassicTitleFadeIntro(input)
}
