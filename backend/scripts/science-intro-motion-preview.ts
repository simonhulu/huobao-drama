import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareScienceVideoWithIntro } from '../src/services/science-video-intro.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const report = path.join(root, 'data/reports/science-intro-motion-20261105')
const directory = path.join(root, 'data/static/science-validation/intro-motion-20261105')
const videoPath = path.join(root, 'data/reports/science-latentsync-fourrefs-20261105/main-4p8s-25fps.mp4')
const presenterPath = path.join(root, 'data/static/science-validation/fourrefs-20261105/R3-25fps.mp4')
const introPath = path.join(root, 'data/science-pop/assets/xiaolu-intro.mp4')
const outputPath = path.join(directory, 'R3-intro-motion.mp4')
const controller = new AbortController()
const { signal } = controller
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

async function media(filename: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', filename],
    { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}

async function digest(filename: string) {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex')
}

async function pcm(filename: string, start: number, duration: number) {
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', filename, '-ss', String(start), '-t', String(duration),
    '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
  { signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' })
  return new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length / 2)
}

function correlation(source: Int16Array, output: Int16Array, lag: number) {
  let xy = 0, xx = 0, yy = 0
  for (let index = 2400; index < Math.min(source.length, output.length) - 2400; index += 8) {
    const x = source[index]!, y = output[index + lag]!
    xy += x * y; xx += x * x; yy += y * y
  }
  return xy / Math.sqrt(xx * yy)
}

await fs.mkdir(directory, { recursive: true })
await fs.mkdir(report, { recursive: true })
const prepared = await prepareScienceVideoWithIntro({ videoPath, directory: path.join(report, 'render-v4') },
  { signal, introPath, presenterPath, presenterFraming: 'closeup', report: console.log })
await fs.copyFile(prepared.videoPath, outputPath)
const [intro, main, output] = await Promise.all([media(introPath), media(videoPath), media(outputPath)])
const introDuration = Number(intro.format.duration), mainDuration = Number(main.format.duration)
const video = output.streams.find((stream: any) => stream.codec_type === 'video')
const audio = output.streams.find((stream: any) => stream.codec_type === 'audio')
if (video?.width !== 1920 || video?.height !== 1080 || video?.avg_frame_rate !== '25/1'
  || Math.abs(Number(video.duration) - introDuration - mainDuration) > .08
  || Math.abs(Number(audio?.duration) - introDuration - mainDuration) > .03) throw new Error('Incomplete preview media')
const [sourceAudio, bodyAudio] = await Promise.all([pcm(videoPath, 0, mainDuration), pcm(outputPath, introDuration, mainDuration)])
let bestLag = 0, bestCorrelation = -1
for (let lag = -1920; lag <= 1920; lag += 48) {
  const value = correlation(sourceAudio, bodyAudio, lag)
  if (value > bestCorrelation) { bestLag = lag; bestCorrelation = value }
}
const expectedStartCorrelation = correlation(sourceAudio, bodyAudio, 0)
if (expectedStartCorrelation < .99 || bestLag !== 0) throw new Error('Main narration moved relative to the original audio boundary')
const times = [4.2, 4.4, 4.6, 4.8, 5.0, 5.12, 5.4, 6.2]
for (const time of times) {
  const filename = path.join(report, `frame-${time.toFixed(2)}.png`)
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(time), '-i', outputPath, '-frames:v', '1', filename],
    { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
}
const contactPath = path.join(report, 'transition-contact.jpg')
await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...times.flatMap(time => ['-i', path.join(report, `frame-${time.toFixed(2)}.png`)]),
  '-filter_complex', times.map((_, index) => `[${index}:v]scale=480:270[v${index}]`).join(';')
    + ';' + times.map((_, index) => `[v${index}]`).join('') + 'xstack=inputs=8:layout=0_0|480_0|960_0|1440_0|0_270|480_270|960_270|1440_270[v]',
  '-map', '[v]', '-frames:v', '1', contactPath], { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
await fs.writeFile(path.join(report, 'validation.json'), JSON.stringify({
  createdAt: new Date().toISOString(), outputPath, outputSha256: await digest(outputPath), output,
  introPath, introSha256: prepared.introSha256, mainPath: videoPath, mainSha256: prepared.sourceSha256,
  presenterPath, presenterSha256: await digest(presenterPath),
  audioPlacement: { introDuration, mainDuration, expectedStartCorrelation, bestLagMs: bestLag / 48,
    sourceSamples: sourceAudio.length, bodySamples: bodyAudio.length, note: 'Audio placement only; not a lip synchronization score' },
  motion: { seconds: .8, startsAt: introDuration - .8, easing: 'smoothstep', handoffSeconds: .12, times, contactPath },
}, null, 2) + '\n')
console.log('http://localhost:3013/static/science-validation/intro-motion-20261105/R3-intro-motion.mp4')
console.log(contactPath)
