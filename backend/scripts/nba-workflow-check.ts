import '../src/load-env.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NBA_DEFAULT_SETTINGS, type NbaJob } from '../src/services/nba-types.js'
import { produceNbaVideo } from '../src/services/nba-production.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceFile = process.argv[2]
const outputDirectory = process.argv[3]
if (!sourceFile || !outputDirectory) throw new Error('用法：node run-tsx.mjs scripts/nba-workflow-check.ts <已采集job.json> <独立验证目录>')
const target = path.resolve(outputDirectory)
if (path.dirname(path.resolve(sourceFile)) === target) throw new Error('验证目录必须与原任务分开')
fs.mkdirSync(target, { recursive: true })
const checkpointFile = path.join(target, 'job.json')
const source: NbaJob = JSON.parse(fs.readFileSync(path.resolve(sourceFile), 'utf8'))
let job: NbaJob = fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : {
  id: `nba-workflow-check-${Date.now()}`, title: source.article.title, article: source.article, game: source.game,
  status: 'queued', stage: 'match', message: '重新生成验证', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0, canResume: true, logs: [],
}
if (job.article.bodyHash !== source.article.bodyHash) throw new Error('验证目录中已有其他报道，请指定新的目录')
const save = () => fs.writeFileSync(checkpointFile, JSON.stringify(job, null, 2) + '\n')
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
job.status = 'running'; job.attempts++; save()
try {
  const result = await produceNbaVideo({ job, jobDir: target, sharedDir: path.join(project, 'data/nba-video/shared'), settings: NBA_DEFAULT_SETTINGS,
    signal: controller.signal, checkpoint: patch => { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); save() },
    onProgress: (stage, message) => { job.stage = stage; job.message = message; job.logs.push({ at: new Date().toISOString(), stage, message }); save(); console.log(`${new Date().toISOString()} ${stage}: ${message}`) } })
  job = { ...job, ...result, updatedAt: new Date().toISOString() }; save()
  console.log(JSON.stringify({ status: job.status, title: job.script?.title, duration: job.delivery?.duration, video: job.delivery?.videoPath, verification: job.delivery?.verification }, null, 2))
} catch (error: any) {
  job.status = controller.signal.aborted ? 'stopped' : error?.code === 'NBA_ATTENTION' ? 'attention' : 'failed'
  job.message = error instanceof Error ? error.message : String(error); job.updatedAt = new Date().toISOString(); save()
  console.error(job.message); process.exitCode = 1
}
