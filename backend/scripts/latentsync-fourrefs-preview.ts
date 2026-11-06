import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareScienceVideoWithIntro } from '../src/services/science-video-intro.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const reportRoot = path.join(root, 'data/reports/science-latentsync-fourrefs-20261105')
const publicRoot = path.join(root, 'data/static/science-validation/fourrefs-20261105')
const referenceRoot = path.join(root, 'data/science-pop/assets/xiaolu-speaking-20261105')
const narrationPath = path.join(reportRoot, 'narration-4p8s.wav')
const mainPath = path.join(reportRoot, 'main-4p8s-25fps.mp4')
const introPath = path.join(root, 'data/science-pop/assets/xiaolu-intro.mp4')
const baseUrl = 'http://localhost:3013/static/science-validation/fourrefs-20261105'
const controller = new AbortController()
const { signal } = controller
const duration = 4.8, frames = 120, fps = 25
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

interface Stream {
  codec_type: string; codec_name: string; width?: number; height?: number
  avg_frame_rate?: string; r_frame_rate?: string; nb_read_frames?: string; nb_frames?: string
  duration?: string; start_time?: string
}
interface Media { streams: Stream[]; format: { duration: string } }
interface Artifact {
  outputPath: string; outputSha256: string; inputs: Record<string, string>
  verification: Record<string, unknown>; reused?: boolean
}
interface ReferenceRecord { id: number; stored: string; sha256: string; use: string }

function argumentsToCases() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node run-tsx.mjs scripts/latentsync-fourrefs-preview.ts --case 3 | --case 2 | --all')
    process.exit(0)
  }
  if (args.length === 1 && args[0] === '--all') return [1, 2, 3, 4]
  if (args.length === 2 && args[0] === '--case' && /^[1-4]$/.test(args[1]!)) return [Number(args[1])]
  throw new Error('Pass --case 1|2|3|4 or --all; --all requires all four completed raw results')
}

async function exists(filename: string) {
  try { await fs.lstat(filename); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function hashFile(filename: string) {
  signal.throwIfAborted()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function mediaInfo(filename: string): Promise<Media> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filename],
    { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}

async function pcmHash(filename: string, channels = 2) {
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', filename, '-map', '0:a:0', '-vn',
    '-ar', '48000', '-ac', String(channels), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
  { signal, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' })
  return { sha256: createHash('sha256').update(stdout).digest('hex'), bytes: stdout.length, rate: 48000, channels, format: 's16le' }
}

function streamRate(rate?: string) {
  const [numerator, denominator = 1] = String(rate || '0').split('/').map(Number)
  return numerator! / denominator!
}

function checkDuration(actual: unknown, expected = duration, tolerance = .001) {
  if (!Number.isFinite(Number(actual)) || Math.abs(Number(actual) - expected) > tolerance) {
    throw new Error(`Unexpected media duration ${String(actual)}; expected ${expected}`)
  }
}

async function verifyClip(filename: string, size: number, audioHash: string) {
  const media = await mediaInfo(filename)
  const video = media.streams.find(stream => stream.codec_type === 'video')
  const audio = media.streams.filter(stream => stream.codec_type === 'audio')
  if (!video || video.codec_name !== 'h264' || video.width !== size || video.height !== size
    || streamRate(video.avg_frame_rate) !== fps || streamRate(video.r_frame_rate) !== fps
    || Number(video.nb_read_frames) !== frames || audio.length !== 1 || audio[0]!.codec_name !== 'aac') {
    throw new Error(`Preview must have ${size}x${size} H.264, 120 frames at 25fps and exactly one AAC track: ${filename}`)
  }
  checkDuration(video.duration)
  checkDuration(audio[0]!.duration)
  checkDuration(media.format.duration)
  const pcm = await pcmHash(filename)
  if (pcm.sha256 !== audioHash) throw new Error(`Narration PCM differs from the shared AAC narration: ${filename}`)
  return { media, decodedPcm: pcm }
}

async function artifact(
  outputPath: string, inputs: Record<string, string>,
  create: (temporary: string) => Promise<unknown>, verify: (filename: string) => Promise<Record<string, unknown>>,
): Promise<Artifact> {
  const sidecar = `${outputPath}.json`
  const hasOutput = await exists(outputPath), hasSidecar = await exists(sidecar)
  if (hasOutput || hasSidecar) {
    if (!hasOutput || !hasSidecar) throw new Error(`Incomplete existing export; refusing to overwrite: ${outputPath}`)
    const saved: Artifact = JSON.parse(await fs.readFile(sidecar, 'utf8'))
    if (JSON.stringify(saved.inputs) !== JSON.stringify(inputs) || await hashFile(outputPath) !== saved.outputSha256) {
      throw new Error(`Existing export provenance or output hash changed: ${outputPath}`)
    }
    return { ...saved, verification: await verify(outputPath), reused: true }
  }
  const temporary = path.join(path.dirname(outputPath), `.fourrefs-${randomUUID()}${path.extname(outputPath)}`)
  try {
    await create(temporary)
    const verification = await verify(temporary)
    const record: Artifact = { outputPath, outputSha256: await hashFile(temporary), inputs, verification }
    signal.throwIfAborted()
    await fs.link(temporary, outputPath)
    await fs.writeFile(sidecar, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', signal })
    return record
  } finally { await fs.rm(temporary, { force: true }) }
}

async function ffmpeg(args: string[], output: string) {
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-n', ...args, output],
    { signal, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 })
}

const caseIds = argumentsToCases()
for (const id of caseIds) {
  for (const suffix of ['.mp4', '.mp4.json']) {
    const filename = path.join(reportRoot, `R${id}-40-g1p5-fp32${suffix}`)
    if (!await exists(filename)) throw new Error(`Completed raw result is not available yet: ${filename}`)
  }
}
await fs.mkdir(publicRoot, { recursive: true })
const manifestPath = path.join(referenceRoot, 'manifest.json')
const manifest: { records: ReferenceRecord[] } = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
const [manifestSha256, narrationSha256, previewRunnerSha256, inferenceRunnerSha256, mainSha256] = await Promise.all([
  hashFile(manifestPath), hashFile(narrationPath), hashFile(fileURLToPath(import.meta.url)),
  hashFile(path.join(root, 'backend/scripts/latentsync/reference_experiment.py')), hashFile(mainPath),
])
const [mainMedia, mainPcm, narrationPcm] = await Promise.all([mediaInfo(mainPath), pcmHash(mainPath, 1), pcmHash(narrationPath, 1)])
const mainVideo = mainMedia.streams.find(stream => stream.codec_type === 'video')
if (!mainVideo || Number(mainVideo.nb_read_frames) !== frames || streamRate(mainVideo.avg_frame_rate) !== fps
  || mainPcm.sha256 !== narrationPcm.sha256) throw new Error('The 25fps main sample must contain 120 frames and the exact WAV narration')
checkDuration(mainVideo.duration)
checkDuration(mainMedia.format.duration)

const sharedAudio = await artifact(path.join(reportRoot, 'narration-4p8s-aac.m4a'),
  { narrationSha256, previewRunnerSha256 },
  temporary => ffmpeg(['-i', narrationPath, '-map', '0:a:0', '-vn', '-t', String(duration),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart'], temporary),
  async filename => {
    const media = await mediaInfo(filename)
    const audio = media.streams.find(stream => stream.codec_type === 'audio')
    if (media.streams.length !== 1 || audio?.codec_name !== 'aac') throw new Error('Shared narration must contain only AAC audio')
    checkDuration(audio.duration)
    checkDuration(media.format.duration)
    return { media, decodedPcm: await pcmHash(filename) }
  })
const sharedAudioPcm = (sharedAudio.verification.decodedPcm as { sha256: string }).sha256
const exports: Array<Record<string, unknown>> = []
const squareArtifacts = new Map<number, Artifact>()

for (const id of caseIds) {
  const source = manifest.records.find(record => record.id === id)
  const sourcePath = path.join(referenceRoot, `reference-${id}.mp4`)
  if (!source || path.resolve(source.stored) !== sourcePath || await hashFile(sourcePath) !== source.sha256) {
    throw new Error(`Reference ${id} does not match the asset manifest`)
  }
  const rawPath = path.join(reportRoot, `R${id}-40-g1p5-fp32.mp4`)
  const metadata = JSON.parse(await fs.readFile(`${rawPath}.json`, 'utf8'))
  const rawSha256 = await hashFile(rawPath)
  const settings = metadata.inference_settings
  if (metadata.status !== 'completed' || metadata.sha256?.output !== rawSha256
    || metadata.sha256?.video !== source.sha256 || metadata.sha256?.audio !== narrationSha256
    || metadata.sha256?.runner !== inferenceRunnerSha256 || metadata.geometry_dtype !== 'float32'
    || metadata.reference?.effective_offset_frames !== 0 || settings?.inference_steps !== 40
    || settings?.guidance_scale !== 1.5 || settings?.seed !== 1247 || settings?.enable_deepcache !== false) {
    throw new Error(`R${id} raw/source/audio/runner hashes or inference settings do not match the experiment`)
  }
  const [rawMedia, sourceMedia] = await Promise.all([mediaInfo(rawPath), mediaInfo(sourcePath)])
  const rawVideo = rawMedia.streams.find(stream => stream.codec_type === 'video')
  const sourceVideo = sourceMedia.streams.find(stream => stream.codec_type === 'video')
  if (!rawVideo || !sourceVideo || rawVideo.width !== sourceVideo.width || rawVideo.height !== sourceVideo.height
    || Number(rawVideo.nb_read_frames) < frames || streamRate(rawVideo.avg_frame_rate) !== fps
    || !rawMedia.streams.some(stream => stream.codec_type === 'audio')) {
    throw new Error(`R${id} is not a complete restored full-frame video; intermediate frames are not deliverables`)
  }
  const filename = `R${id}-25fps.mp4`
  const square = await artifact(path.join(publicRoot, filename),
    { rawSha256, sourceSha256: source.sha256, narrationSha256, inferenceRunnerSha256,
      previewRunnerSha256, manifestSha256, sharedAudioSha256: sharedAudio.outputSha256 },
    temporary => ffmpeg(['-i', rawPath, '-i', sharedAudio.outputPath, '-map', '0:v:0', '-map', '1:a:0',
      '-vf', "crop=w='min(iw,ih)':h=ow:x=(iw-ow)/2:y=(ih-oh)/2,scale=720:720:flags=lanczos,trim=end_frame=120,setpts=N/(25*TB),setsar=1",
      '-frames:v', String(frames), '-t', String(duration), '-r', String(fps), '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'], temporary),
    filename => verifyClip(filename, 720, sharedAudioPcm))
  squareArtifacts.set(id, square)
  const entry: Record<string, unknown> = { id, use: source.use, productionAccepted: false,
    rawPath, rawSha256, rawMedia, inferenceMetadata: metadata, square, url: `${baseUrl}/${filename}` }

  if (id === 2 || id === 3) {
    const [introSha256, introMedia, introServiceSha256] = await Promise.all([
      hashFile(introPath), mediaInfo(introPath), hashFile(path.join(root, 'backend/src/services/science-video-intro.ts')),
    ])
    const introDuration = Number(introMedia.format.duration)
    const introFilename = `R${id}-intro-circle.mp4`
    entry.intro = await artifact(path.join(publicRoot, introFilename),
      { mainSha256, introSha256, presenterSha256: square.outputSha256, introServiceSha256, previewRunnerSha256 },
      async temporary => {
        const result = await prepareScienceVideoWithIntro({ videoPath: mainPath, directory: path.join(reportRoot, `R${id}-intro-preview`) },
          { signal, introPath, presenterPath: square.outputPath, presenterFraming: 'closeup',
            report: message => console.log(new Date().toISOString(), `R${id}`, message) })
        if (result.sourceSha256 !== mainSha256 || result.introSha256 !== introSha256) throw new Error('Intro renderer used unexpected inputs')
        await fs.copyFile(result.videoPath, temporary)
      },
      async filename => {
        const media = await mediaInfo(filename)
        const video = media.streams.find(stream => stream.codec_type === 'video')
        if (!video || video.width !== mainVideo.width || video.height !== mainVideo.height
          || streamRate(video.avg_frame_rate) !== fps || media.streams.filter(stream => stream.codec_type === 'audio').length !== 1) {
          throw new Error('Intro-circle preview has incorrect dimensions, cadence or audio tracks')
        }
        checkDuration(media.format.duration, introDuration + duration, .12)
        return { media, mainNarrationPcmSha256: mainPcm.sha256, introPath, presenterFraming: 'closeup' }
      })
    entry.introUrl = `${baseUrl}/${introFilename}`
  }
  exports.push(entry)
  console.log(`R${id}: ${entry.url}${entry.introUrl ? `\nR${id} intro: ${entry.introUrl}` : ''}`)
}

let comparison: Record<string, unknown> | undefined
if (caseIds.length === 4) {
  const filename = 'R1-R4-2x2-25fps.mp4'
  const inputs = Object.fromEntries([...squareArtifacts].map(([id, item]) => [`R${id}Sha256`, item.outputSha256]))
  const result = await artifact(path.join(publicRoot, filename),
    { ...inputs, previewRunnerSha256, sharedAudioSha256: sharedAudio.outputSha256 },
    temporary => ffmpeg([...caseIds.flatMap(id => ['-i', squareArtifacts.get(id)!.outputPath]), '-i', sharedAudio.outputPath,
      '-filter_complex', '[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|720_0|0_720|720_720:fill=black[v]',
      '-map', '[v]', '-map', '4:a:0', '-frames:v', String(frames), '-t', String(duration), '-r', String(fps), '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart'], temporary),
    filename => verifyClip(filename, 1440, sharedAudioPcm))
  comparison = { ...result, url: `${baseUrl}/${filename}`, layout: [['R1', 'R2'], ['R3', 'R4']] }
  console.log(`Comparison: ${comparison.url}`)
}

const validationPath = path.join(reportRoot, 'preview-validation.json')
let previous: { cases?: Array<Record<string, unknown>>; comparison?: Record<string, unknown> } = {}
if (await exists(validationPath)) previous = JSON.parse(await fs.readFile(validationPath, 'utf8'))
const selected = new Set(caseIds)
const cases = [...(previous.cases || []).filter(item => !selected.has(Number(item.id))), ...exports].sort((a, b) => Number(a.id) - Number(b.id))
const validation = { updatedAt: new Date().toISOString(), status: 'preview-only-production-paused', productionAccepted: false,
  duration, frames, fps, audioPolicy: 'One AAC 192kbps track encoded once from narration-4p8s.wav and copied into every square/comparison export',
  decodedPcmPolicy: '48kHz stereo signed 16-bit PCM, including decoder tail padding; all square/comparison exports must match shared AAC',
  manifestSha256, narrationSha256, previewRunnerSha256, inferenceRunnerSha256, mainSha256,
  mainNarrationPcmSha256: mainPcm.sha256, sharedAudio, cases, comparison: comparison || previous.comparison }
const temporaryValidation = path.join(reportRoot, `.preview-validation-${randomUUID()}.json`)
await fs.writeFile(temporaryValidation, JSON.stringify(validation, null, 2) + '\n', { flag: 'wx', signal })
await fs.rename(temporaryValidation, validationPath)
const sections: string[] = []
if (validation.comparison && await exists(path.join(publicRoot, 'R1-R4-2x2-25fps.mp4'))) {
  sections.push('<section class="comparison"><h2>R1–R4 对照</h2><video controls playsinline preload="metadata" src="R1-R4-2x2-25fps.mp4"></video><a href="R1-R4-2x2-25fps.mp4">R1-R4-2x2-25fps.mp4</a></section>')
}
const squareSections: string[] = [], introSections: string[] = []
for (const item of cases) {
  const id = Number(item.id)
  if (![1, 2, 3, 4].includes(id)) continue
  const filename = `R${id}-25fps.mp4`
  if (await exists(path.join(publicRoot, filename))) {
    const title = id === 1 ? 'R1 外观对照' : id === 4 ? 'R4 运动镜头' : `R${id} 正文`
    squareSections.push(`<article><h2>${title}</h2><video controls playsinline preload="metadata" src="${filename}"></video><a href="${filename}">${filename}</a></article>`)
  }
  const introFilename = `R${id}-intro-circle.mp4`
  if ((id === 2 || id === 3) && await exists(path.join(publicRoot, introFilename))) {
    introSections.push(`<article><h2>R${id} 片头与圆窗</h2><video controls playsinline preload="metadata" src="${introFilename}"></video><a href="${introFilename}">${introFilename}</a></article>`)
  }
}
if (squareSections.length) sections.push(`<section class="grid">${squareSections.join('')}</section>`)
if (introSections.length) sections.push(`<section class="grid intros">${introSections.join('')}</section>`)
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>口型参考对照</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f6f7f7;color:#171b19;font:16px/1.5 system-ui,sans-serif;letter-spacing:0}main{max-width:1200px;margin:auto;padding:24px}h1{font-size:24px;margin:0 0 24px}h2{font-size:18px;margin:0 0 10px}section{margin-bottom:32px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}article{min-width:0}video{display:block;width:100%;aspect-ratio:1;background:#111}a{display:inline-block;margin-top:8px;color:#17583a;overflow-wrap:anywhere}.comparison{max-width:900px}.intros video{aspect-ratio:16/9}@media(max-width:680px){main{padding:16px}.grid{grid-template-columns:1fr;gap:24px}}</style></head>
<body><main><h1>口型参考对照</h1>${sections.join('\n')}</main><script>for(const video of document.querySelectorAll('video'))video.addEventListener('play',()=>{for(const other of document.querySelectorAll('video'))if(other!==video)other.pause()})</script></body></html>\n`
const temporaryIndex = path.join(publicRoot, `.index-${randomUUID()}.html`)
await fs.writeFile(temporaryIndex, html, { flag: 'wx', signal })
await fs.rename(temporaryIndex, path.join(publicRoot, 'index.html'))
console.log(`Validation: ${validationPath}`)
console.log(`Review: ${baseUrl}/index.html`)
