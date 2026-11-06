import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getScienceHuashengAccountsService } from '../src/services/science-accounts.js'
import { SCIENCE_HUASHENG_VOICE } from '../src/services/science-workflow.js'
import { createHuashengExport, inspectHuashengProduction, readHuashengExportSession, readHuashengProductionSession } from '../src/services/history-huasheng-export-api.js'

const [id, action = '--inspect'] = process.argv.slice(2)
if (!id || !/^science-[a-f0-9-]{36}$/.test(id) || !['--inspect', '--submit', '--resume'].includes(action))
  throw new Error('Usage: science-repair-voice.ts science-UUID [--inspect|--submit|--resume]')
const directory = fileURLToPath(new URL(`../../data/science-pop/jobs/${id}/`, import.meta.url))
const filename = path.join(directory, 'job.json')
const readJob = () => JSON.parse(fs.readFileSync(filename, 'utf8'))
const job = readJob(), target = SCIENCE_HUASHENG_VOICE
if (job.status !== 'paused' || job.ownerPid || job.automaticDelivery || job.automaticProduction || job.upload || job.uploadAttempt)
  throw new Error('Only an explicitly paused, unpublished task can be repaired')
const pid = new URL(job.projectUrl).pathname.split('/').at(-1)!
if (new URL(job.projectUrl).origin !== 'https://www.huasheng.cn' || !/^\d+$/.test(pid)) throw new Error('Invalid original project')
const signal = AbortSignal.timeout(90_000)
const browserConfig = await getScienceHuashengAccountsService().readyBrowserConfig(job.huashengAccountName, { signal })
const auth = action === '--submit'
  ? await readHuashengExportSession({ projectUrl: job.projectUrl, browserConfig, signal })
  : await readHuashengProductionSession({ projectUrl: job.projectUrl, browserConfig, signal })
const headers = { Cookie: auth.cookie, 'User-Agent': auth.userAgent, Referer: job.projectUrl, Origin: 'https://www.huasheng.cn' }
const get = async (endpoint: string) => {
  const response = await fetch(`https://www.huasheng.cn${endpoint}`, { headers, signal, redirect: 'error' })
  if (!response.ok) throw new Error(`Read failed: HTTP ${response.status}`)
  const result = await response.json() as any
  if (result.code !== undefined && result.code !== 0) throw new Error(`Read rejected: ${result.code}`)
  return result
}
const legacy = await get(`/api/innovideo/project/info?pid=${pid}`)
if (String(legacy.project?.pid) !== pid || String(legacy.project.uid) !== browserConfig.expectedUid || legacy.project.script !== job.script)
  throw new Error('Original project account or narration does not match the local task')
const catalog = await get('/api/innovideo/voice/clone/list?_bs=wbh&_fv=317253')
if (!catalog.voices?.some((v: any) => Number(v.id) === target.id && Number(v.voice_type) === 2 && String(v.state) === '0'))
  throw new Error('The bound account does not own the requested cloned voice')
const history = await get(`/api/agent/project/chat/history?pid=${pid}&limit=20`)
const repairDirectory = path.join(directory, 'revisions', `voice-${target.id}`)
const checkpointFile = path.join(repairDirectory, 'repair.json')
let checkpoint = fs.existsSync(checkpointFile) ? JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) : undefined
function write(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}
const voiceMatches = Number(legacy.project.voice_id) === target.id && Number(legacy.project.voice_type) === target.type
console.log(JSON.stringify({ id, pid, targetVoice: target.id, currentVoice: legacy.project.voice_id,
  currentVoiceType: legacy.project.voice_type, working: history.data?.current_state?.is_working,
  voiceRunning: legacy.project.voice_running, ttsRunning: legacy.project.tts_running, compositeRunning: legacy.project.composite_running,
  projectHash: legacy.project.project_hash, previousProjectHash: checkpoint?.previousProjectHash,
  runId: checkpoint?.runId, runs: history.data?.runs?.slice(0, 1).map((r: any) => ({ id: r.run_id,
    text: r.input?.content?.find((c: any) => c.type === 'text')?.text?.content,
    selected: r.input?.selected, events: r.events?.map((e: any) => ({ event: e.event, tool: e.name || e.tool_name, content: e.content })) })) }))
if (action === '--submit') {
  if (voiceMatches) throw new Error('The requested voice is already selected; inspect completion before resuming')
  if (checkpoint?.dispatched) throw new Error('A change was already dispatched; inspect the original run instead of resubmitting')
  if (history.data?.current_state?.is_working !== false) throw new Error('The original project is still working')
  fs.mkdirSync(repairDirectory, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(path.join(repairDirectory, 'job-before.json'))) write(path.join(repairDirectory, 'job-before.json'), job)
  checkpoint = { id, projectUrl: job.projectUrl, accountName: job.huashengAccountName, voiceId: target.id, voiceType: target.type,
    scriptSha256: createHash('sha256').update(job.script).digest('hex'), previousVoiceId: legacy.project.voice_id,
    previousProjectHash: legacy.project.project_hash, previousExportHash: job.exportTask?.projectHash,
    dispatched: true, dispatchedAt: new Date().toISOString() }
  write(checkpointFile, checkpoint)
  if (!('csrf' in auth) || typeof auth.csrf !== 'string' || !auth.csrf) throw new Error('An attested session is required to submit')
  const csrf = auth.csrf
  const response = await fetch(`https://www.huasheng.cn/api/agent/project/chat/run?pid=${pid}&csrf=${encodeURIComponent(csrf)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal, redirect: 'error',
    body: JSON.stringify({ pid: Number(pid), content: [{ type: 'text', text: { content: `配音音色换成「${target.name}」` } }],
      selected: [{ type: 'voice', voice_id: target.id, voice_type: target.type, voice_name: target.name }] }),
  })
  const result = await response.json() as any
  if (!response.ok || result.code !== 0 || !/^[a-f0-9]{32}$/i.test(result.data?.run_id || ''))
    throw new Error(`Voice change response requires inspection: HTTP ${response.status}, code ${result.code}`)
  checkpoint.runId = result.data.run_id; write(checkpointFile, checkpoint)
  console.log(JSON.stringify({ dispatched: true, runId: checkpoint.runId, checkpointFile }))
}
if (action === '--resume') {
  if (!checkpoint?.runId || checkpoint.voiceId !== target.id || !voiceMatches)
    throw new Error('The original repair must finish with the selected voice before local delivery resumes')
  const state = await inspectHuashengProduction({ projectUrl: job.projectUrl, script: job.script,
    browserConfig, signal, expectedVoice: target })
  if (state.status !== 'completed' || history.data?.current_state?.is_working !== false) throw new Error('Voice production has not completed')
  // Sandbox metadata leaves project_hash empty; the export response carries the actual version.
  if (!checkpoint.exportTask) {
    if (checkpoint.exportDispatched) throw new Error('Export response is uncertain; reconcile the original export before retrying')
    const exportTask = await createHuashengExport({ projectUrl: job.projectUrl, browserConfig, signal,
      onDispatched: () => { checkpoint.exportDispatched = true; write(checkpointFile, checkpoint) } })
    checkpoint.exportTask = exportTask; write(checkpointFile, checkpoint)
  }
  if (checkpoint.exportTask.projectHash === (checkpoint.previousExportHash || job.exportTask?.projectHash))
    throw new Error('The repaired export still matches the old voice version')
  const current = readJob()
  if (JSON.stringify(current) !== JSON.stringify(job)) throw new Error('The task changed during inspection')
  for (const key of ['productionCompleted', 'exportDispatched', 'exportTask', 'videoPath', 'mainVideoPath', 'presenterPath',
    'videoCompositionPending', 'coverAssets', 'coverSourceDigest', 'coverRequest', 'coverUploadRevision', 'huashengSync', 'automaticRetry', 'failureKind']) delete current[key]
  current.updatedAt = new Date().toISOString(); current.stage = 'produce'; current.checkpoint = 'submitted'
  current.productionCompleted = true; current.exportDispatched = true; current.exportTask = checkpoint.exportTask
  current.message = `花生已换成${target.name} ${target.id}，继续原项目导出与本地视频合成`
  current.logs.push({ at: current.updatedAt, message: current.message })
  write(filename, current)
  checkpoint.localResetAt = current.updatedAt; write(checkpointFile, checkpoint)
  const response = await fetch(`http://127.0.0.1:${process.env.SCIENCE_PORT || 5683}/api/v1/science-pop/workflow/jobs/${id}/produce`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upload: job.autoUpload === true }), signal,
  })
  if (!response.ok) throw new Error(`Local resume failed: HTTP ${response.status}; the original task remains available`)
  console.log(JSON.stringify({ resumed: true, id, upload: job.autoUpload === true }))
}
