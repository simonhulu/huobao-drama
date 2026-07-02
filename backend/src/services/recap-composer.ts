import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { db, schema } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { fileURLToPath } from 'url'
import { generateTTS as defaultGenerateTTS } from './tts-generation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(__dirname, '../../../../data')
const RECAP_DIR = path.join(DATA_ROOT, 'static', 'recaps')

export interface RecapComposeInput {
  episodeId: number
  episodeNumber: number
  recapScript: string
  openingHook?: string | null
  dramaId?: number | null
}

export interface RecapComposerDeps {
  generateTTS?: (text: string, voice?: string) => Promise<string>
  runFfmpeg?: (args: string[]) => Promise<void>
}

function defaultRunFfmpeg(args: string[]): Promise<void> {
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

function findPreviousEpisodeFrames(currentEpisodeNumber: number, dramaId: number): string[] {
  const prevEp = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), eq(schema.episodes.episodeNumber, currentEpisodeNumber - 1)))
    .all()[0]
  if (!prevEp) return []

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, prevEp.id))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const frames: (string | null)[] = []
  if (storyboards.length > 0) frames.push(storyboards[0].firstFrameImage)
  if (storyboards.length > 2) frames.push(storyboards[Math.floor(storyboards.length / 2)].firstFrameImage)
  if (storyboards.length > 1) frames.push(storyboards[storyboards.length - 1].firstFrameImage)

  return frames.filter((f): f is string => Boolean(f)).map(f => {
    if (path.isAbsolute(f)) return f
    if (f.startsWith('static/')) return path.join(DATA_ROOT, f)
    return path.join(DATA_ROOT, 'static', f)
  })
}

function buildKenBurnsFilter(frames: string[], width: number, height: number, durationPerFrame: number): string {
  const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
  const frameFilters = frames.map((frame, index) => {
    const start = index * durationPerFrame
    const zoomStart = index % 2 === 0 ? 1.0 : 1.15
    const zoomEnd = index % 2 === 0 ? 1.15 : 1.0
    const framesCount = Math.round(durationPerFrame * 30)
    return [
      `[${index}:v]${scalePad},zoompan=z='${zoomStart}+(${zoomEnd - zoomStart})*on/${framesCount || 1}':`,
      `x='iw/2-iw/(2*zoom)':y='ih/2-ih/(2*zoom)':d=${framesCount}:s=${width}x${height}:fps=30,`,
      `trim=duration=${durationPerFrame},fade=t=in:st=0:d=0.3,fade=t=out:st=${durationPerFrame - 0.3}:d=0.3[f${index}]`,
    ].join('')
  })

  const concat = `${frames.map((_, i) => `[f${i}]`).join('')}concat=n=${frames.length}:v=1:a=0[outv]`
  return [...frameFilters, concat].join(';')
}

async function renderRecapVideo(
  input: {
    frames: string[]
    audioPath: string
    outputPath: string
    recapScript: string
    openingHook?: string | null
  },
  runFfmpeg: (args: string[]) => Promise<void>,
): Promise<void> {
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })

  const width = 1920
  const height = 1080
  const durationPerFrame = 3
  const totalDuration = input.frames.length * durationPerFrame

  const filterComplex = buildKenBurnsFilter(input.frames, width, height, durationPerFrame)

  const args = [
    ...input.frames.flatMap(f => ['-loop', '1', '-i', f]),
    '-i', input.audioPath,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', `${input.frames.length}:a`,
    '-t', String(totalDuration),
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
    input.outputPath,
  ]

  await runFfmpeg(args)
}

export async function composeRecapForEpisode(
  input: RecapComposeInput,
  deps: RecapComposerDeps = {},
): Promise<string | null> {
  if (input.episodeNumber <= 1) return null
  if (!input.recapScript.trim()) return null
  if (!input.dramaId) {
    console.warn('Recap compose requires dramaId')
    return null
  }

  const frames = findPreviousEpisodeFrames(input.episodeNumber, input.dramaId)
  if (frames.length === 0) {
    console.warn(`No previous episode frames found for episode ${input.episodeNumber}`)
    return null
  }

  const generateTTS = deps.generateTTS ?? ((text: string) => defaultGenerateTTS({ text, voice: 'alloy', subtitleEnable: false }))
  const runFfmpeg = deps.runFfmpeg ?? defaultRunFfmpeg

  const audioPath = await generateTTS(input.recapScript)
  const outputFilename = `${input.episodeId}-recap.mp4`
  const outputPath = path.join(RECAP_DIR, outputFilename)

  await renderRecapVideo({
    frames,
    audioPath,
    outputPath,
    recapScript: input.recapScript,
    openingHook: input.openingHook,
  }, runFfmpeg)

  return path.join('static', 'recaps', outputFilename)
}
