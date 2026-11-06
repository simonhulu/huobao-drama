import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { prepareSciencePresenterVideo, type SciencePresenterInferenceSettings } from '../src/services/science-presenter-video.js'
import { prepareScienceVideoWithIntro } from '../src/services/science-video-intro.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const reportRoot = path.join(root, 'data/reports/science-latentsync-quality-20261104')
const publicRoot = path.join(root, 'data/static/science-validation/quality-20261104')
const jobId = 'science-a30b1bd7-0cfc-485e-9c17-63df16ff619e'
const job = JSON.parse(await fs.readFile(path.join(root, 'data/science-pop/jobs', jobId, 'job.json'), 'utf8'))
const referencePath = process.env.SCIENCE_PRESENTER_REFERENCE_PATH
if (!referencePath) throw new Error('SCIENCE_PRESENTER_REFERENCE_PATH must point to the new close-up reference')
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
const { signal } = controller
await fs.mkdir(reportRoot, { recursive: true })
await fs.mkdir(publicRoot, { recursive: true })
const videoPath = path.join(reportRoot, 'main-sample.mp4')
try { await fs.access(videoPath) } catch {
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', job.mainVideoPath, '-t', '10',
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', videoPath], { signal })
}
const cases: Array<{ name: string; settings: SciencePresenterInferenceSettings }> = [
  { name: 'A-20steps-cache', settings: { inference_steps: 20, guidance_scale: 1.5, enable_deepcache: true, seed: 1247 } },
  { name: 'B-20steps-exact', settings: { inference_steps: 20, guidance_scale: 1.5, enable_deepcache: false, seed: 1247 } },
  { name: 'C-40steps-exact', settings: { inference_steps: 40, guidance_scale: 1.5, enable_deepcache: false, seed: 1247 } },
  { name: 'D-40steps-guidance2', settings: { inference_steps: 40, guidance_scale: 2, enable_deepcache: false, seed: 1247 } },
]
const results: unknown[] = []
for (const item of cases) {
  const report = (message: string) => console.log(new Date().toISOString(), item.name, message)
  const directory = path.join(reportRoot, item.name)
  const startedAt = new Date().toISOString()
  const started = Date.now()
  report('start')
  const presenter = await prepareSciencePresenterVideo({ videoPath, referencePath, directory: path.join(directory, 'presenter'), inferenceSettings: item.settings }, { signal, report })
  const final = await prepareScienceVideoWithIntro({ videoPath, directory: path.join(directory, 'intro') },
    { signal, report, presenterPath: presenter.presenterPath, presenterFraming: 'closeup' })
  const filename = `${item.name}.mp4`
  await fs.copyFile(final.videoPath, path.join(publicRoot, filename))
  results.push({ name: item.name, settings: item.settings, referencePath, presenter, final, startedAt,
    elapsedSeconds: (Date.now() - started) / 1000, url: `http://localhost:3013/static/science-validation/quality-20261104/${filename}` })
  await fs.writeFile(path.join(reportRoot, 'validation.json'), JSON.stringify(results, null, 2))
  report('complete')
}
