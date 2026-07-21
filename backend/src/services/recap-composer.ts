import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { db, schema } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { fileURLToPath } from 'url'
import { generateTTS as defaultGenerateTTS } from './tts-generation.js'
import { DEFAULT_NARRATION_VOICE_ID } from './narration-defaults.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(__dirname, '../../../data')
const RECAP_DIR = path.join(DATA_ROOT, 'static', 'recaps')
const REMOTION_DIR = path.resolve(__dirname, '../../../remotion')
const REMOTION_CLI = path.join(REMOTION_DIR, 'node_modules/.bin/remotion')
const CHROME_EXECUTABLE = path.join(
  REMOTION_DIR,
  '../.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell'
)

export interface RecapComposeInput {
  episodeId: number
  episodeNumber: number
  dramaId?: number | null
  narrationVoiceId?: string | null
  narrationSpeed?: number | null
  aspectRatio?: string | null
}

export interface RecapComposerDeps {
  generateTTS?: (text: string, voice?: string, speed?: number) => Promise<string>
  runCommand?: (cmd: string, args: string[], options: { cwd: string }) => Promise<void>
}

function defaultRunCommand(cmd: string, args: string[], options: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: options.cwd, stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}`))
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

function getServerBaseUrl(): string {
  const port = process.env.PORT || '5679'
  return `http://localhost:${port}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function probeAudioDuration(filePath: string, retries = 3): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (data) => { stdout += data.toString() })
      proc.stderr.on('data', (data) => { stderr += data.toString() })
      proc.on('error', (err) => {
        if (left > 0) return attempt(left - 1)
        reject(err)
      })
      proc.on('close', (code) => {
        if (code !== 0) {
          if (left > 0) return attempt(left - 1)
          reject(new Error(`ffprobe exited with ${code}: ${stderr || stdout}`))
          return
        }
        const duration = parseFloat(stdout.trim())
        if (Number.isFinite(duration) && duration > 0) {
          resolve(duration)
        } else if (left > 0) {
          attempt(left - 1)
        } else {
          reject(new Error(`ffprobe returned invalid duration: ${stdout}`))
        }
      })
    }
    attempt(retries)
  })
}

function toStaticUrl(localPath: string | null | undefined, baseUrl: string): string | null {
  if (!localPath) return null
  if (/^https?:\/\//.test(localPath)) return localPath
  const staticRoot = path.join(DATA_ROOT, 'static')
  if (path.isAbsolute(localPath) && localPath.startsWith(staticRoot)) {
    const rel = path.relative(staticRoot, localPath).replace(/\\/g, '/')
    return `${baseUrl}/static/${rel}`
  }
  const rel = localPath.replace(/^\/+/, '').replace(/^static\//, '')
  return `${baseUrl}/static/${rel}`
}

function resolveFramePath(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (path.isAbsolute(raw)) {
    if (fs.existsSync(raw)) return raw
    const relativeMatch = raw.match(/(static\/.*)$/)
    if (relativeMatch) {
      const recovered = path.join(DATA_ROOT, relativeMatch[1])
      if (fs.existsSync(recovered)) return recovered
    }
    return raw
  }
  if (raw.startsWith('static/')) return path.join(DATA_ROOT, raw)
  return path.join(DATA_ROOT, 'static', raw)
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

  return frames.map(resolveFramePath).filter((f): f is string => Boolean(f))
}

function buildRecapScript(prevEp: typeof schema.episodes.$inferSelect): string | null {
  if (prevEp.recapScript?.trim()) return prevEp.recapScript.trim()

  const parts = [prevEp.openingHook, prevEp.cliffhanger].filter(Boolean)
  if (parts.length === 0) return null

  let script = `上一集，${parts.join('，')}。`
  if (script.length > 55) {
    script = script.slice(0, 55).replace(/[^，。！？,.!?]*$/, '')
    if (!script.endsWith('。')) script += '。'
  }
  return script
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
      return { width: 1280, height: 720 }
  }
}

async function renderRecapVideo(
  input: {
    episodeId: number
    dramaTitle?: string | null
    recapScript: string
    imageUrls: string[]
    audioUrl: string
    aspectRatio?: string | null
    durationInFrames: number
  },
  runCommand: (cmd: string, args: string[], options: { cwd: string }) => Promise<void>,
): Promise<string> {
  const outputFilename = `${input.episodeId}-recap.mp4`
  const outputPath = path.join(RECAP_DIR, outputFilename)
  fs.mkdirSync(RECAP_DIR, { recursive: true })

  const propsPath = path.join(RECAP_DIR, `${input.episodeId}-recap-props.json`)
  const props = {
    aspectRatio: input.aspectRatio || '16:9',
    durationInFrames: input.durationInFrames,
    dramaTitle: input.dramaTitle?.trim() || undefined,
    recapScript: input.recapScript,
    imageUrls: input.imageUrls,
    audioUrl: input.audioUrl,
  }
  fs.writeFileSync(propsPath, JSON.stringify(props, null, 2))

  await runCommand(
    REMOTION_CLI,
    [
      'render',
      `--browser-executable=${CHROME_EXECUTABLE}`,
      `--props=${propsPath}`,
      '--concurrency=1',
      'src/index.tsx',
      'RecapCarousel',
      outputPath,
      '--codec=h264',
      '--pixel-format=yuv420p',
      `--duration-in-frames=${input.durationInFrames}`,
    ],
    { cwd: REMOTION_DIR }
  )

  // Remotion may emit yuvj420p/full-range even with --pixel-format=yuv420p,
  // which breaks playback in some browsers. Patch the H.264 bitstream flag
  // to signal limited (TV) range without re-encoding.
  const tmpPath = `${outputPath}.range-fix.mp4`
  await runCommand('ffmpeg', [
    '-y',
    '-i', outputPath,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-bsf:v', 'h264_metadata=video_full_range_flag=0',
    '-movflags', '+faststart',
    tmpPath,
  ], { cwd: REMOTION_DIR })
  fs.renameSync(tmpPath, outputPath)

  await validateVideo(outputPath)

  return path.join('static', 'recaps', outputFilename)
}

export async function composeRecapForEpisode(
  input: RecapComposeInput,
  deps: RecapComposerDeps = {},
): Promise<string | null> {
  if (input.episodeNumber <= 1) return null
  if (!input.dramaId) {
    console.warn('Recap compose requires dramaId')
    return null
  }

  const prevEp = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, input.dramaId), eq(schema.episodes.episodeNumber, input.episodeNumber - 1)))
    .all()[0]
  if (!prevEp) {
    console.warn(`Previous episode not found for episode ${input.episodeNumber}`)
    return null
  }

  const recapScript = buildRecapScript(prevEp)
  if (!recapScript?.trim()) {
    console.warn(`Previous episode has no recap script for episode ${input.episodeNumber}`)
    return null
  }

  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, input.dramaId)).all()

  const frames = findPreviousEpisodeFrames(input.episodeNumber, input.dramaId)
  if (frames.length === 0) {
    console.warn(`No previous episode frames found for episode ${input.episodeNumber}`)
    return null
  }

  const generateTTS = deps.generateTTS ?? ((text: string, voice?: string, speed?: number) => defaultGenerateTTS({
    text,
    voice: voice || DEFAULT_NARRATION_VOICE_ID,
    subtitleEnable: false,
    speed: speed ?? 1.15,
  }))
  const runCommand = deps.runCommand ?? defaultRunCommand

  const audioPath = await generateTTS(recapScript, input.narrationVoiceId || undefined, input.narrationSpeed || undefined)
  const absoluteAudioPath = path.isAbsolute(audioPath) ? audioPath : path.join(DATA_ROOT, audioPath)
  // Give the filesystem a moment to flush the normalized audio before probing.
  await sleep(1000)
  const audioDuration = await probeAudioDuration(absoluteAudioPath)
  console.log(`[RecapComposer] audio=${absoluteAudioPath} duration=${audioDuration}s textLength=${recapScript.length}`)

  const baseUrl = getServerBaseUrl()
  const imageUrls = frames.map(f => toStaticUrl(f, baseUrl)).filter((url): url is string => Boolean(url))
  const audioUrl = toStaticUrl(absoluteAudioPath, baseUrl)!

  const aspectRatio = input.aspectRatio ?? '16:9'
  const { width, height } = parseAspectRatio(aspectRatio)
  const titleCardFrames = Math.ceil(1.5 * 30)
  const tailFrames = Math.ceil(0.3 * 30)
  const durationInFrames = Math.max(titleCardFrames + tailFrames + 30, Math.ceil(audioDuration * 30) + tailFrames)

  await renderRecapVideo({
    episodeId: input.episodeId,
    dramaTitle: drama?.title,
    recapScript,
    imageUrls,
    audioUrl,
    aspectRatio,
    durationInFrames,
  }, runCommand)

  return path.join('static', 'recaps', `${input.episodeId}-recap.mp4`)
}
