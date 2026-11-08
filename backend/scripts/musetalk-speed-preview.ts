import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { prepareScienceVideoWithIntro } from '../src/services/science-video-intro.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const jobId = argument('--job-id')
const presenter = argument('--presenter')
const label = argument('--label')
const seconds = Number(argument('--seconds') ?? 60)
if (!jobId || !/^science-[a-f0-9-]+$/.test(jobId) || !presenter || !label || !/^[a-zA-Z0-9_-]+$/.test(label)
  || !Number.isFinite(seconds) || seconds <= 0 || seconds > 1800) {
  throw new Error('Required: --job-id science-ID --presenter FILE --label NAME [--seconds 60]')
}
const reportRoot = path.join(root, 'data/reports/science-musetalk-speed-20261107', label)
const publicRoot = path.join(root, 'data/static/science-validation/musetalk-speed-20261107')
await fs.mkdir(reportRoot, { recursive: true })
await fs.mkdir(publicRoot, { recursive: true })
const output = path.join(publicRoot, `${label}.mp4`)
try { await fs.access(output); throw new Error(`Preview already exists: ${output}`) }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const job = JSON.parse(await fs.readFile(path.join(root, 'data/science-pop/jobs', jobId, 'job.json'), 'utf8'))
if (!job.mainVideoPath) throw new Error('The source job has no original main video')
const signal = AbortSignal.timeout(20 * 60_000)
async function probe(filename: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { signal })
  return JSON.parse(stdout)
}
const original = await probe(job.mainVideoPath)
const originalDuration = Number(original.format.duration)
const started = performance.now()
let main = job.mainVideoPath
if (seconds < originalDuration - .1) {
  main = path.join(reportRoot, 'main.mp4')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-i', job.mainVideoPath, '-t', String(seconds),
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'h264_videotoolbox', '-b:v', '2500k', '-c:a', 'aac', '-b:a', '192k', main],
  { signal, maxBuffer: 1024 * 1024 })
}
const mainInfo = await probe(main)
const mainVideo = mainInfo.streams.find((item: any) => item.codec_type === 'video')
const mainDuration = Number(mainInfo.format.duration)
const rawInfo = await probe(path.resolve(presenter))
const rawVideo = rawInfo.streams.find((item: any) => item.codec_type === 'video')
const rawDuration = Number(rawVideo?.duration ?? rawInfo.format.duration)
if (!rawVideo || Math.abs(rawDuration - Number(mainVideo.duration)) > .15) {
  throw new Error('Presenter must cover the same narration; only a sub-frame tail may be padded')
}
const sourcePrepareSeconds = (performance.now() - started) / 1000
const normalizeStarted = performance.now()
const normalized = path.join(reportRoot, 'presenter.mp4')
await exec('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-i', path.resolve(presenter), '-an',
  '-vf', `tpad=stop_mode=clone:stop_duration=0.15,fps=${mainVideo.avg_frame_rate},trim=duration=${mainDuration},setsar=1`,
  '-c:v', 'h264_videotoolbox', '-b:v', '1800k', '-movflags', '+faststart', normalized],
{ signal, maxBuffer: 1024 * 1024 })
const normalizeSeconds = (performance.now() - normalizeStarted) / 1000
const composeStarted = performance.now()
const result = await prepareScienceVideoWithIntro({ videoPath: main, directory: path.join(reportRoot, 'intro') },
  { signal, presenterPath: normalized, presenterFraming: 'closeup', report: message => console.log(message) })
const composeSeconds = (performance.now() - composeStarted) / 1000
await fs.copyFile(result.videoPath, output)
const record = { jobId, label, main, presenter: path.resolve(presenter), result, sourcePrepareSeconds, normalizeSeconds,
  composeSeconds, localTotalSeconds: (performance.now() - started) / 1000,
  url: `http://localhost:3013/static/science-validation/musetalk-speed-20261107/${label}.mp4` }
await fs.writeFile(path.join(reportRoot, 'preview.json'), JSON.stringify(record, null, 2))
console.log(JSON.stringify(record, null, 2))
