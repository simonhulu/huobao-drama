import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { lstat, realpath, readdir, readFile, mkdir, open, unlink, rename, link, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHistorySourceArtifactState } from './history-script-artifacts.js'
import { createStorageRegistry, type ArtifactRole, type ArtifactOwner, type TrackedArtifact } from './storage-artifacts.js'
import { createPublishedMediaInputCache, createPublishedMediaInputInspector, discoverPublishedMedia, ensurePublishedMediaInputIndexes } from './storage-published-media.js'
import { discoverImmutableCopies } from './storage-immutable-copies.js'
import { discoverAdditionalArtifacts } from './storage-extra-inventory.js'

export const STORAGE_KINDS = ['transcribed-source','render-cache','duplicate-material','published-video'] as const
export type StorageKind = typeof STORAGE_KINDS[number]
interface Policy { autoCleanup: boolean; retentionDays: number }
interface Item {
  id: string; kind: StorageKind; path: string; bytes: number; reason: string
  ownerType: string; ownerId: string; role: ArtifactRole; state: string
  sourceId?: number; canonical?: string; sha256?: string; output?: string; scienceId?: string
}
interface Run {
  id: string; startedAt: string; finishedAt?: string; freedBytes: number; removedCount: number; errors: string[]; actions: unknown[]
  trigger?:'manual'|'scheduled'
  reclaimedFileBytes?: number; diskBeforeFreeBytes?: number; diskAfterFreeBytes?: number
}
interface ManagerOptions {
  db: Database.Database; projectRoot: string
  releaseSource?: (id: number) => Promise<unknown>
  cleanupRender?: (output: string) => Promise<any>
  published?: typeof discoverPublishedMedia
  prepareInputIndexes?:boolean
}
type Row = Record<string, any>
const day = 86_400_000
const activeStates = new Set(['queued','running','pending','planning','selecting','validating','stopping','uploading','processing','generating','rendering','creating','downloading','transcribing','correcting','rewriting','waiting_remote','awaiting_export','awaiting_confirmation','uncertain','blocked'])
const labels: Record<StorageKind,string> = {
  'transcribed-source':'已完整转录的原件', 'render-cache':'可重建的渲染缓存',
  'duplicate-material':'相同素材合并存储', 'published-video':'已发表且过保留期的成片',
}
const json = (value: string | null | undefined, fallback: any = null): any => { try { return JSON.parse(value || '') } catch { return fallback } }
const within = (root: string, file: string) => file.startsWith(root + path.sep)
const sourceName = /^(?:source\.(?:mp4|m4a)|audio-\d+\.wav|asr-[a-f0-9]{16}-\d+\.wav)(?:\.part)?$|^source\.youtube\.[A-Za-z0-9_-]{11}(?:\.f\d+)?\.(?:mp4|m4a|webm|opus)(?:\.part(?:-Frag\d+)?)?$/
const mediaRole = (filename: string): ArtifactRole => /\.(json|txt|md|html|srt|vtt)$/i.test(filename) ? 'project' : 'intermediate'
const mediaTypes:Record<string,string>={'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/mp4',
  '.mp3':'audio/mpeg','.m4a':'audio/mp4','.wav':'audio/wav','.aac':'audio/aac','.ogg':'audio/ogg','.opus':'audio/ogg','.flac':'audio/flac',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}

async function fingerprint(filename: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
async function readJson(filename: string) { try { return json(await readFile(filename,'utf8')) } catch { return null } }
function readJsonSync(filename: string) { try { return json(readFileSync(filename,'utf8')) } catch { return null } }
function fileExists(filename: string) { try { lstatSync(filename); return true } catch (error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return false; throw error } }

interface MaintenanceScheduleOptions {
  run:(mode:'scan'|'cleanup')=>Promise<unknown>; autoCleanup:()=>boolean; lastCleanupAt?:string
  intervalMs?:number; checkEveryMs?:number; retryMs?:number; now?:()=>number
  schedule?:(callback:()=>void,delayMs:number)=>()=>void
}
/** One due run after startup/sleep; failures retry without overlapping work. */
export function createStorageMaintenanceScheduler(options:MaintenanceScheduleOptions) {
  const now=options.now || Date.now,interval=options.intervalMs ?? 3_600_000
  const checkEvery=options.checkEveryMs ?? 30_000,retry=options.retryMs ?? 60_000
  if (![interval,checkEvery,retry].every(value=>Number.isFinite(value) && value>0)) throw Error('Maintenance intervals must be positive')
  const schedule=options.schedule || ((callback,delay)=>{const timer=setTimeout(callback,delay);timer.unref();return()=>clearTimeout(timer)})
  const last=Date.parse(options.lastCleanupAt || '')
  let nextCleanup=Number.isFinite(last) && last<=now() ? last+interval : now(),nextScan=now(),retryAt=0
  let startup=true,stopped=false,inFlight:Promise<void>|undefined,cancel:(()=>void)|undefined
  const state:{state:'starting'|'waiting'|'running'|'retrying'|'stopping'|'stopped';mode?:'scan'|'cleanup';autoCleanup?:boolean;
    nextRunAt?:string;lastStartedAt?:string;lastFinishedAt?:string;lastSuccessAt?:string;lastError?:string;runCount:number;missedIntervals:number}=
    {state:'starting',runCount:0,missedIntervals:0}
  const queue=(delay:number)=>{
    cancel?.()
    if(stopped)return
    state.nextRunAt=new Date(now()+Math.max(0,delay)).toISOString()
    cancel=schedule(()=>{void tick()},Math.max(0,delay))
  }
  const nextDelay=()=>retryAt>now() ? retryAt-now()
    : Math.min(checkEvery,Math.max(0,(state.autoCleanup ? Math.min(nextCleanup,nextScan) : nextScan)-now()))
  async function tick():Promise<void> {
    if(stopped)return
    if(inFlight)return inFlight
    cancel?.();cancel=undefined
    if(retryAt>now()){queue(nextDelay());return}
    try {state.autoCleanup=options.autoCleanup()} catch(error) {
      state.state='retrying';state.lastError=(error as Error).message;retryAt=now()+retry;queue(nextDelay());return
    }
    const mode=state.autoCleanup && now()>=nextCleanup ? 'cleanup' : startup || now()>=nextScan ? 'scan' : undefined
    if(!mode){state.state='waiting';queue(nextDelay());return}
    state.state='running';state.mode=mode;state.lastStartedAt=new Date(now()).toISOString();state.runCount++
    if(mode==='cleanup')state.missedIntervals=Math.max(0,Math.floor((now()-nextCleanup)/interval))
    inFlight=Promise.resolve().then(()=>options.run(mode)).then(()=>{
      startup=false;retryAt=0;state.lastError=undefined;state.lastSuccessAt=new Date(now()).toISOString()
      nextScan=now()+interval
      if(mode==='cleanup')nextCleanup=now()+interval
      state.state='waiting'
    }).catch(error=>{
      state.state='retrying';state.lastError=(error as Error).message;retryAt=now()+retry
    }).finally(()=>{
      state.lastFinishedAt=new Date(now()).toISOString();state.mode=undefined;inFlight=undefined
      if(stopped)state.state='stopped'
      else queue(nextDelay())
    })
    return inFlight
  }
  queue(0)
  return {
    tick,
    status:()=>({...state,nextCleanupAt:new Date(nextCleanup).toISOString()}),
    async stop(){stopped=true;cancel?.();state.nextRunAt=undefined;state.state=inFlight ? 'stopping' : 'stopped';await inFlight;state.state='stopped'},
  }
}

export function createStorageManager(options: ManagerOptions) {
  const { db } = options, projectRoot = realpathSync(options.projectRoot), dataRoot = path.join(projectRoot,'data')
  const registry = createStorageRegistry(db)
  let items: Item[] = [], lastRun: Run | undefined, running = false, scannedAt: string | undefined
  let worker:ReturnType<typeof createStorageMaintenanceScheduler>|undefined
  let activity:({operation:string;phase:string;startedAt:string;updatedAt:string;finishedAt?:string;path?:string;runId?:string;processed?:number;total?:number;error?:string})|undefined
  let slowStages:Array<{phase:string;elapsedMs:number;path?:string;runId?:string}>=[]
  let indexBuilds:Array<{name:string;elapsedMs:number}>=[]
  const markActivity=(phase:string,details:Partial<NonNullable<typeof activity>>={})=>{
    if(activity)activity={...activity,...details,phase,updatedAt:new Date().toISOString()}
  }
  const runtime=()=>({running,activity:activity && {...activity},scheduler:worker?.status(),slowStages:[...slowStages],indexBuilds:[...indexBuilds]})
  const table = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  const rows = (name: string, requested?:readonly string[]): Row[] => {
    if (!table(name)) return []
    const selected=requested || (name==='creation_tasks' ? ['id','status','payload_json','episode_id'] : undefined)
    const fields=selected ? (db.pragma(`table_info(${name})`) as Array<{name:string}>)
      .filter(column=>selected.includes(column.name)).map(column=>column.name).join(',') : '*'
    if (!fields) return []
    return db.prepare(`SELECT ${fields} FROM ${name}`).all() as Row[]
  }

  const policy = (): Policy => ({autoCleanup:true,retentionDays:0,...json((db.prepare('SELECT value_json FROM storage_policy WHERE id=1').get() as Row | undefined)?.value_json,{})})
  const storedRun = db.prepare('SELECT report_json FROM storage_cleanup_runs ORDER BY started_at DESC LIMIT 1').get() as Row | undefined
  lastRun = json(storedRun?.report_json) || undefined
  if(lastRun)slowStages=lastRun.actions.flatMap(action=>Object.entries((action as Row).timingsMs || {})
    .filter(([,duration])=>Number(duration)>=1000).map(([phase,duration])=>({phase,elapsedMs:Number(duration),path:(action as Row).path,runId:lastRun!.id})))
    .sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,20)

  async function safeFile(filename: string) {
    const resolved = path.resolve(filename)
    if (!within(dataRoot,resolved) || await realpath(resolved) !== resolved) throw Object.assign(Error('文件路径不在受管目录，或包含符号链接'),{code:'STORAGE_UNSAFE_PATH'})
    const info = await lstat(resolved)
    if (!info.isFile()) throw Object.assign(Error('仅处理受管的普通文件'),{code:'STORAGE_NOT_FILE'})
    return info
  }
  async function walk(directory: string): Promise<string[]> {
    if (!within(dataRoot,path.resolve(directory))) return []
    try {
      if (await realpath(directory) !== path.resolve(directory) || !(await lstat(directory)).isDirectory()) return []
      const result: string[] = []
      for (const entry of await readdir(directory,{withFileTypes:true})) {
        if (entry.isSymbolicLink() || entry.name.endsWith('.lock')) continue
        const filename = path.join(directory,entry.name)
        if (entry.isDirectory()) result.push(...await walk(filename))
        else if (entry.isFile()) result.push(filename)
      }
      return result
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  const sourceDir = (id: number) => path.join(dataRoot,'storage/history-scripts',String(id))
  const sourceState = (row: Row) => row.deleted_at ? 'deleted' : String(row.status || 'unknown')
  async function inventory() {
    if(options.prepareInputIndexes) {
      markActivity('prepare-reference-indexes')
      indexBuilds.push(...ensurePublishedMediaInputIndexes(db))
    }
    markActivity('inventory')
    const tracked = new Map<string,TrackedArtifact>(), candidate: Item[] = []
    const add = async (filename: string, role: ArtifactRole, owner: ArtifactOwner, sha256?: string) => {
      try {
        const info = await safeFile(filename)
        const existing = tracked.get(filename)
        if (existing) {
          if (role==='final') existing.role='final'
          const ref=existing.owners.find(ref => ref.ownerType===owner.ownerType && ref.ownerId===owner.ownerId)
          if (!ref) existing.owners.push({...owner,purpose:role})
          else if (role==='source' || role==='shared') ref.purpose=role
          return
        }
        tracked.set(filename,{path:filename,role,bytes:info.size,sha256,owners:[{...owner,purpose:role}]})
      } catch (error) { if (!['ENOENT','ENOTDIR','STORAGE_NOT_FILE','STORAGE_UNSAFE_PATH'].includes((error as NodeJS.ErrnoException).code || '')) throw error }
    }
    const references = async (value: unknown, owner: ArtifactOwner, role:ArtifactRole='source'): Promise<void> => {
      if (typeof value==='string') { const filename=localPath(value);if (filename) await add(filename,role,owner) }
      else if (Array.isArray(value)) for (const item of value) await references(item,owner,role)
      else if (value && typeof value==='object') for (const item of Object.values(value)) await references(item,owner,role)
    }
    const releases: Array<{file:Row;manifest:Row}> = []
    const ingestRelease = async (directory:string,owner:ArtifactOwner) => {
      const manifest=await readJson(path.join(directory,'storage-release.json'))
      if (!manifest || manifest.version!==1 || String(manifest.ownerId)!==owner.ownerId || !Array.isArray(manifest.files)) return
      for (const file of manifest.files) if (file.status==='released' && path.dirname(file.path)===directory && sourceName.test(path.basename(file.path))) {
        if (!await lstat(file.path).then(()=>true,()=>false)) {
          releases.push({file:{path:file.path,role:'source',bytes:file.bytes,sha256:file.sha256,owners:[{...owner,purpose:'source'}]},manifest})
        }
      }
    }
    const addItem = (kind: StorageKind, filename: string, reason: string, extras: Partial<Item> = {}) => {
      const file = tracked.get(filename)
      if (!file || registry.byPath(filename)?.pinned) return
      const owner = file.owners[0]
      candidate.push({id:`${kind}:${filename}`,kind,path:filename,bytes:file.bytes,reason,...owner,role:file.role,state:'eligible',...extras})
    }
    const sources = rows('history_script_sources')
    const sourceTasks = new Map<string,Row[]>()
    for (const task of rows('creation_tasks')) {
      const payload = json(task.payload_json)
      const id = payload?.sourceId ?? payload?.source_id
      if (id !== undefined) sourceTasks.set(String(id),[...(sourceTasks.get(String(id)) || []),task])
    }
    for (const source of sources) {
      const owner = {ownerType:'history-source',ownerId:String(source.id),state:sourceState(source)}
      const files = await walk(sourceDir(source.id))
      const busy = sourceTasks.get(String(source.id))?.some(task => activeStates.has(task.status))
      const locked = await lstat(path.join(sourceDir(source.id),'process.lock')).then(()=>true,()=>false)
      const media = json(source.media_json,{})
      const current = getHistorySourceArtifactState({platform:source.platform,sourceVideoId:source.source_video_id,sourceUrl:source.source_url,
        mediaJson:source.media_json,asrJson:source.asr_json,reviewJson:source.review_json,rawTranscript:source.raw_transcript,
        correctedTranscript:source.corrected_transcript,rewrittenScript:source.rewritten_script}).transcript === 'current'
      for (const file of files) {
        await add(file,sourceName.test(path.basename(file)) ? 'source' : mediaRole(file),owner)
        for (const task of sourceTasks.get(String(source.id)) || []) await add(file,'source',{ownerType:'creation-task',ownerId:String(task.id),state:task.status})
        if (current && !source.deleted_at && media.kind !== 'note' && !busy && !locked && sourceName.test(path.basename(file))) {
          addItem('transcribed-source',file,'完整转录及来源指纹已保存，后续制作使用文稿',{sourceId:source.id})
        }
      }
      await ingestRelease(sourceDir(source.id),owner)
    }
    const motionJobs = [...rows('history_motion_productions'),...rows('history_motion_jobs')]
    for (const job of motionJobs) {
      const snapshot=json(job.snapshot || job.plan_json)
      // Delivery reports describe outputs; only the retained production inputs are consumers.
      const inputs=snapshot?.plan ? {...snapshot,outputPath:undefined,plan:{...snapshot.plan,delivery:undefined,deliveryAssociation:undefined}}
        : snapshot
      await references(inputs,{ownerType:'history-motion',ownerId:String(job.id),state:job.status})
    }
    for (const directory of await readdir(path.join(dataRoot,'storage/history-motion'),{withFileTypes:true}).catch(()=>[])) {
      if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/i.test(directory.name)) continue
      const job = motionJobs.find(row=>row.id===directory.name)
      for (const filename of await walk(path.join(dataRoot,'storage/history-motion',directory.name))) {
        await add(filename,mediaRole(filename),{ownerType:'history-motion',ownerId:directory.name,state:job?.status || 'unknown'})
        if (job?.script_id) await add(filename,mediaRole(filename),{ownerType:'history-source',ownerId:String(job.script_id),state:sourceState(sources.find(row=>row.id===job.script_id) || {})})
        if (filename.endsWith('/delivery.json') && filename.includes('.render/')) {
          const output = filename.slice(0,-'.render/delivery.json'.length)
          const report = await readJson(output+'.json')
          if (report?.status==='completed' && report.qa?.technical==='passed' && job?.status==='completed') {
            for (const cached of [...await walk(path.join(output+'.render','bundle')),...await walk(path.join(output+'.render','public/assets'))]) {
              await add(cached,'intermediate',{ownerType:'history-motion',ownerId:directory.name,state:job?.status || 'completed'})
              addItem('render-cache',cached,'成片技术检查已通过，回收前逐一验证原始素材仍可用',{output})
            }
          }
        }
      }
    }
    const consoleState = await readJson(path.join(dataRoot,'cba-video/.console.json')) || {}
    for (const directory of await readdir(path.join(dataRoot,'cba-video'),{withFileTypes:true}).catch(()=>[])) {
      if (!directory.isDirectory() || directory.name.startsWith('.') || directory.name==='batches') continue
      const jobRoot = path.join(dataRoot,'cba-video',directory.name), job = await readJson(path.join(jobRoot,'job.json'))
      const active = consoleState.runs?.some((run: Row)=>activeStates.has(run.status) && (run.jobId===directory.name || run.jobIds?.includes(directory.name)))
      const uploads = (consoleState.uploads || []).filter((upload: Row)=>upload.jobId===directory.name)
      const state = active ? 'running' : uploads.some((upload: Row)=>activeStates.has(upload.status) || upload.status==='failed') ? 'upload_pending' : consoleState.deletedTasks?.[directory.name] ? 'deleted' : job?.status || 'unknown'
      const finals = new Set(Object.values(job?.outputs || {}).flatMap((output: any)=>typeof output?.path==='string' ? [path.resolve(output.path)] : []))
      for (const file of await walk(jobRoot)) await add(file,finals.has(file) ? 'final' : /\.(mp4|mov|m4a|wav)$/i.test(file) ? 'source' : mediaRole(file),{ownerType:'cba',ownerId:directory.name,state})
      await references(job?.media,{ownerType:'cba',ownerId:directory.name,state})
      await references(job?.news?.audio,{ownerType:'cba',ownerId:directory.name,state})
    }
    for (const directory of await readdir(path.join(dataRoot,'science-pop/jobs'),{withFileTypes:true}).catch(()=>[])) {
      if (!directory.isDirectory() || !/^science-[a-f0-9-]{36}$/.test(directory.name)) continue
      const jobRoot=path.join(dataRoot,'science-pop/jobs',directory.name), job=await readJson(path.join(jobRoot,'job.json'))
      if (!job) continue
      const state = job.deletedAt ? 'deleted' : job.status || 'unknown'
      const owner={ownerType:'science',ownerId:directory.name,state}
      for (const [filename,role] of [[job.videoPath,'final'],[job.media?.videoPath,'source'],[job.coverAssets?.landscapePath,'source'],[job.coverAssets?.portraitPath,'source']] as const) {
        const local=localPath(filename);if (local) await add(local,role,owner)
      }
      for (const file of await walk(jobRoot)) {
        const role = path.resolve(job.videoPath || dataRoot)===file ? 'final' : sourceName.test(path.basename(file)) ? 'source' : mediaRole(file)
        await add(file,role,{ownerType:'science',ownerId:directory.name,state})
        if (!job.deletedAt && !activeStates.has(state) && job.transcript?.trim() && role==='source') {
          // The workflow service validates/migrates the durable checkpoint again.
          addItem('transcribed-source',file,'完整科普转录已保存，回收前核验来源和文字指纹',{scienceId:directory.name})
        }
      }
      await ingestRelease(jobRoot,{ownerType:'science',ownerId:directory.name,state})
    }
    for (const episode of rows('episodes')) {
      const owner={ownerType:'episode',ownerId:String(episode.id),state:episode.deleted_at ? 'deleted' : episode.status || 'unknown'}
      for (const [field,role] of Object.entries({video_url:'final',source_video_url:'source',pre_tts_audio_url:'source',bgm_audio_url:'source',secondary_bgm_audio_url:'source',recap_video_url:'source',intro_video_url:'source',cover_image_4x3_url:'source',cover_image_3x4_url:'source'})) {
        const filename=localPath(episode[field]);if (filename) await add(filename,role as ArtifactRole,owner)
      }
    }
    for (const storyboard of rows('storyboards')) {
      const owner={ownerType:'episode',ownerId:String(storyboard.episode_id),state:storyboard.deleted_at ? 'deleted' : storyboard.status || 'unknown'}
      for (const field of ['video_url','tts_audio_url','narration_audio_url','bgm_audio_url','sfx_audio_url','ambient_audio_url','composed_video_url','composed_image','first_frame_image','last_frame_image','grid_sheet_image']) {
        const filename=localPath(storyboard[field]);if (filename) await add(filename,'source',owner)
      }
      await references(json(storyboard.grid_cells),owner)
    }
    for (const asset of rows('remotion_assets')) if (asset.local_path) {
      const filename = localPath(asset.local_path)
      if (filename) await add(filename,'source',{ownerType:'remotion',ownerId:String(asset.project_id),state:asset.status})
    }
    for (const project of rows('remotion_projects')) await references(json(project.source_snapshot_json),{ownerType:'remotion',ownerId:String(project.id),state:project.status || 'unknown'})
    for (const shot of rows('remotion_shots')) {
      const owner={ownerType:'remotion',ownerId:String(shot.project_id),state:shot.status || 'unknown'}
      await references(json(shot.visual_plan_json),owner)
      await references(json(shot.source_evidence_json),owner)
    }
    for (const stage of rows('remotion_stage_runs')) {
      const owner={ownerType:'remotion',ownerId:String(stage.project_id),state:stage.status || 'unknown'}
      await references(json(stage.input_json),owner)
      await references(json(stage.output_json),owner,'intermediate')
    }
    for (const render of rows('remotion_renders')) if (render.output_path || render.output_url) {
      const filename = localPath(render.output_path || render.output_url)
      if (filename) {
        await add(filename,render.render_kind==='episode' ? 'final' : 'intermediate',{ownerType:'remotion',ownerId:String(render.project_id),state:render.status})
        if (render.task_id) await add(filename,'final',{ownerType:'creation-task',ownerId:String(render.task_id),state:render.status})
      }
      await references(json(render.props_json),{ownerType:'remotion',ownerId:String(render.project_id),state:render.status})
    }
    for (const delivery of rows('history_video_deliveries')) {
      const filename = localPath(delivery.video_path)
      if (filename) await add(filename,'final',{ownerType:'history-source',ownerId:String(delivery.script_id),state:sourceState(sources.find(row=>row.id===delivery.script_id) || {})},delivery.video_sha256)
    }
    for (const artifact of discoverAdditionalArtifacts(db,projectRoot)) await add(artifact.path,artifact.role,artifact)
    const materials = rows('huasheng_material_files'), byHash = new Map<string,Row[]>()
    for (const material of materials) {
      await add(material.file_path,'shared',{ownerType:'huasheng-project',ownerId:String(material.project_id),state:'saved'},material.sha256)
      if (!/^[a-f0-9]{64}$/.test(material.sha256) || !within(path.join(dataRoot,'huasheng-recommendations'),material.file_path)) continue
      const key = `${material.sha256}:${material.bytes}`
      byHash.set(key,[...(byHash.get(key) || []),material])
    }
    for (const ref of rows('huasheng_material_recommendations')) if (ref.file_path && tracked.has(ref.file_path)) {
      await add(ref.file_path,'shared',{ownerType:'huasheng-project',ownerId:String(ref.project_id),state:'saved'})
    }
    for (const copy of discoverImmutableCopies(db,projectRoot)) {
      await add(copy.path,copy.role,{ownerType:copy.ownerType,ownerId:copy.ownerId,state:'completed'},copy.sha256)
      const file=tracked.get(copy.path)
      if (!file) continue
      const key=`${copy.sha256}:${file.bytes}`,group=byHash.get(key) || []
      if (!group.some(item=>item.file_path===copy.path)) group.push({file_path:copy.path,bytes:file.bytes,sha256:copy.sha256})
      byHash.set(key,group)
    }
    for (const copies of byHash.values()) {
      const valid: Array<Row & {ino:number;dev:number;mtimeMs:number}> = []
      for (const copy of copies) {
        try { const info=await safeFile(copy.file_path); if (info.size===copy.bytes && Date.now()-info.mtimeMs>day) valid.push({...copy,ino:info.ino,dev:info.dev,mtimeMs:info.mtimeMs}) } catch { /* Unsafe/missing copies stay untouched. */ }
      }
      const canonical = valid[0]
      if (!canonical) continue
      const seen = new Set([`${canonical.dev}:${canonical.ino}`])
      for (const copy of valid.slice(1)) {
        const identity = `${copy.dev}:${copy.ino}`
        if (seen.has(identity) || copy.dev!==canonical.dev) continue
        seen.add(identity)
        addItem('duplicate-material',copy.file_path,'相同不可变文件指纹；保留所有任务路径，共用一份内容',{canonical:canonical.file_path,sha256:copy.sha256})
      }
    }
    const published = (options.published || discoverPublishedMedia)(db,projectRoot,Date.now(),policy().retentionDays)
    for (const output of published) {
      await add(output.path,'final',{ownerType:'history-source',ownerId:String(output.sourceId),state:'published'},output.sha256)
      if (!tracked.has(output.path)) continue
      // Producer metadata identifies a possible original; only its actual bytes
      // can establish that it is the movie covered by the delivery receipt.
      if (output.evidence?.deliveryPath && output.path!==output.evidence.deliveryPath
        && await fingerprint(output.path)!==output.sha256) continue
      addItem('published-video',output.path,output.reason,{sha256:output.sha256})
    }
    for (const directory of ['static','huasheng-exports','storage/history-scripts']) for (const filename of await walk(path.join(dataRoot,directory))) {
      if (tracked.has(filename) || !mediaTypes[path.extname(filename).toLowerCase()]) continue
      const role:ArtifactRole=/\.(mp4|mov|webm|m4v)$/i.test(filename) && directory!=='storage/history-scripts' ? 'final' : 'intermediate'
      await add(filename,role,{ownerType:'unassigned',ownerId:path.relative(dataRoot,path.dirname(filename)),state:'needs_review'})
    }
    // Each artifact and its refs stay atomic inside track; the inventory does
    // not need one write lock spanning tens of thousands of unrelated files.
    const inventoryFiles=[...tracked.values()]
    markActivity('register-artifacts',{processed:0,total:inventoryFiles.length})
    for (let offset=0;offset<inventoryFiles.length;offset+=250) {
      registry.track(inventoryFiles.slice(offset,offset+250))
      markActivity('register-artifacts',{processed:Math.min(offset+250,inventoryFiles.length)})
      // Give other processes' SQLite busy handlers a real unlocked interval.
      await new Promise<void>(resolve=>setTimeout(resolve,1))
    }
    for (const release of releases) {
      registry.track([release.file as TrackedArtifact])
      registry.release(release.file.path,release.manifest)
    }
    const groupProtection=new Map<string,boolean>()
    items = candidate.filter(item=>{
      const artifact=registry.byPath(item.path)
      if (artifact?.pinned) return false
      if (item.kind==='transcribed-source' || item.kind==='render-cache') {
        const key=item.kind+':'+(item.output || path.dirname(item.path))
        if (!groupProtection.has(key)) groupProtection.set(key,groupBlocked(item))
        return !groupProtection.get(key)
      }
      if (item.kind==='published-video') return !hasInputConsumer(artifact!)
      return true
    })
    // A published file is reclaimed once, not also relinked as a duplicate.
    // Do not use a pending deletion as the canonical copy of another item.
    const publishedPaths=new Set(items.filter(item=>item.kind==='published-video').map(item=>item.path))
    items=items.filter(item=>item.kind!=='duplicate-material' || !publishedPaths.has(item.path) && !publishedPaths.has(item.canonical!))
    scannedAt = new Date().toISOString()
  }
  function localPath(value: unknown): string | null {
    if (typeof value!=='string') return null
    if (/^https?:\/\//i.test(value)) {
      try {
        const url=new URL(value)
        if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return null
        value=decodeURIComponent(url.pathname)
      } catch {return null}
    }
    if (typeof value!=='string') return null
    if (/^\/?static\//.test(value)) return path.resolve(dataRoot,value.replace(/^\//,''))
    if (value.startsWith('data/')) {const filename=path.resolve(projectRoot,value);return within(dataRoot,filename) ? filename : null}
    return path.isAbsolute(value) && within(dataRoot,path.resolve(value)) ? path.resolve(value) : null
  }
  function reviewList(filters: {ownerId?:string;ownerType?:string;role?:string;offset?:number;limit?:number} = {}) {
    const offset=filters.offset ?? 0,limit=filters.limit ?? 150
    if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>150) throw Error('核验列表分页无效')
    const parameters={role:filters.role || '',ownerType:filters.ownerType || '',ownerId:filters.ownerId || '',
      ownerPattern:`%${(filters.ownerId || '').replace(/[\\%_]/g,'\\$&')}%`}
    const where=`a.state IN ('present','archived') AND (@role='' OR a.role=@role)
      AND ((@ownerType='' AND @ownerId='') OR EXISTS(SELECT 1 FROM storage_artifact_refs r WHERE r.artifact_id=a.id
        AND (@ownerType='' OR r.owner_type=@ownerType) AND (@ownerId='' OR r.owner_id LIKE @ownerPattern ESCAPE '\\')))
      AND (@ownerType<>'unassigned' OR NOT EXISTS(SELECT 1 FROM storage_artifact_refs known WHERE known.artifact_id=a.id AND known.owner_type<>'unassigned'))`
    const total=Number((db.prepare(`SELECT count(*) AS total FROM storage_artifacts a WHERE ${where}`).get(parameters) as Row).total)
    const files=db.prepare(`SELECT a.* FROM storage_artifacts a WHERE ${where} ORDER BY a.bytes DESC,a.id ASC LIMIT @limit OFFSET @offset`)
      .all({...parameters,offset,limit}) as Row[]
    return {total,offset,limit,items:files.map(file=>{
      const owners=registry.owners(file.id),owner=owners[0] || {ownerType:'unknown',ownerId:'unknown',state:'unknown'}
      return {...file,...owner,id:Number(file.id),state:file.state==='archived' ? 'archived' : owner.state,owners,reason:file.pinned ? '已设置保留' : file.role==='final' ? '需要核验所有平台的上传结果及工程引用' : '工程依赖或回收凭证需人工核验'}
    })}
  }
  function blockersFor(file: Row) {
    const owners = registry.owners(file.id), blockers: string[] = []
    if (owners.length && owners.every(owner=>owner.ownerType==='unassigned')) blockers.push('归属待确认，请先关联任务')
    for (const owner of owners) {
      if (activeStates.has(owner.state) || owner.state==='upload_pending') blockers.push(`${owner.ownerType}:${owner.ownerId} 仍在生产或等待上传`)
      if (owner.ownerType==='history-source') {
        const id=Number(owner.ownerId),source=rows('history_script_sources',['id','status']).find(row=>row.id===id)
        if (source && activeStates.has(source.status)) blockers.push('来源任务尚未停止')
        if (rows('history_social_upload_jobs',['source_id','status']).some(job=>job.source_id===id && (activeStates.has(job.status) || job.status==='failed'))) blockers.push('关联平台上传尚未完成或等待恢复')
        if (fileExists(path.join(sourceDir(id),'process.lock'))) blockers.push('来源文件仍被执行进程锁定')
      }
      if (owner.ownerType==='history-motion') {
        const job=[...rows('history_motion_productions',['id','status']),...rows('history_motion_jobs',['id','status'])].find(row=>row.id===owner.ownerId)
        if (job && activeStates.has(job.status)) blockers.push('动画制作仍在执行')
      }
      if (owner.ownerType==='cba') {
        const state=readJsonSync(path.join(dataRoot,'cba-video/.console.json')) || {}
        if (state.runs?.some((run:Row)=>activeStates.has(run.status) && (run.jobId===owner.ownerId || run.jobIds?.includes(owner.ownerId)))) blockers.push('CBA 任务仍在运行')
        if (state.uploads?.some((upload:Row)=>upload.jobId===owner.ownerId && (activeStates.has(upload.status) || upload.status==='failed'))) blockers.push('CBA 上传尚未确认或等待恢复')
        if (fileExists(path.join(dataRoot,'cba-video',owner.ownerId,'.production.lock'))) blockers.push('CBA 生产目录仍被锁定')
      }
      if (owner.ownerType==='science') {
        const job=readJsonSync(path.join(dataRoot,'science-pop/jobs',owner.ownerId,'job.json'))
        if (job && activeStates.has(job.status)) blockers.push('科普任务仍在处理')
        if (job && ['queued','uploading','blocked','uncertain','paused'].includes(job.uploadStatus)) blockers.push('科普上传尚未完成')
      }
      if (owner.ownerType==='remotion') {
        if (rows('remotion_renders',['project_id','status']).some(render=>String(render.project_id)===owner.ownerId && activeStates.has(render.status))) blockers.push('Remotion 工程仍在渲染')
      }
      if (owner.ownerType==='episode') {
        if (rows('creation_tasks',['episode_id','status']).some(task=>String(task.episode_id)===owner.ownerId && activeStates.has(task.status))) blockers.push('剧集任务仍在执行')
        if (rows('episode_publish_records',['episode_id','status']).some(record=>String(record.episode_id)===owner.ownerId && !['success','canceled'].includes(record.status))) blockers.push('剧集仍有待处理的上传')
      }
    }
    return [...new Set(blockers)]
  }
  function hasInputConsumer(file: Row) { return registry.owners(file.id).some(owner=>owner.purpose==='source' || owner.purpose==='shared') }
  function archiveBlocker(file: Row) {
    if (file.role==='project') return '工程记录和文稿需留在原位，不能归档移除'
    const supported=new Set(['history-source','history-motion','cba','science','remotion','episode'])
    const owners=registry.owners(file.id)
    if (!owners.some(owner=>supported.has(owner.ownerType)) || owners.some(owner=>(owner.purpose==='source' || owner.purpose==='shared') && !supported.has(owner.ownerType) && owner.ownerType!=='creation-task')) return '此文件的使用流程尚不支持归档恢复，需继续保留'
    return undefined
  }
  function groupFiles(item: Item) {
    const prefix=(item.kind==='render-cache' ? item.output!+'.render' : path.dirname(item.path))+path.sep
    const files=db.prepare("SELECT * FROM storage_artifacts WHERE state='present' AND substr(path,1,?)=?").all(prefix.length,prefix) as Row[]
    return files.filter(file=>item.kind==='render-cache'
      ? within(item.output!+'.render/bundle',file.path) || within(item.output!+'.render/public/assets',file.path)
      : path.dirname(file.path)===path.dirname(item.path) && sourceName.test(path.basename(file.path)))
  }
  function groupBlocked(item: Item) {
    const allowedTasks=new Set(rows('creation_tasks').filter(task=>{
      const payload=json(task.payload_json)
      return item.sourceId!==undefined && String(payload?.sourceId ?? payload?.source_id)===String(item.sourceId)
    }).map(task=>String(task.id)))
    return groupFiles(item).some(file=>file.pinned || registry.owners(file.id).some(owner=>{
      if (activeStates.has(owner.state) || owner.state==='upload_pending') return true
      if (item.kind==='render-cache') return owner.purpose==='source' || owner.purpose==='shared'
      return item.scienceId ? owner.ownerType!=='science' || owner.ownerId!==item.scienceId
        : !((owner.ownerType==='history-source' && owner.ownerId===String(item.sourceId)) || (owner.ownerType==='creation-task' && allowedTasks.has(owner.ownerId)))
    }))
  }
  async function inspect(id: number) {
    const file = registry.get(id)
    if (!file) throw Error('文件未登记，请重新扫描')
    if (file.state==='archived') return {...file,role:file.role as ArtifactRole,owners:registry.owners(id),...registry.owners(id)[0],state:'archived',sha256:json(file.review_json)?.archive?.sha256 || file.sha256,blockers:['文件已归档，可先恢复到工程目录'],review:json(file.review_json),archiveAllowed:false,archiveBlocker:'文件已归档',ownershipUnconfirmed:false}
    if (file.state!=='present') throw Error('文件已回收，请重新扫描')
    const info=await safeFile(file.path), owners=registry.owners(id), blockers=await blockersFor(file)
    const mimeType=mediaTypes[path.extname(file.path).toLowerCase()],archiveReason=archiveBlocker(file)
    return {...file,role:file.role as ArtifactRole,bytes:info.size,owners,...owners[0],sha256:await fingerprint(file.path),blockers,
      mimeType,previewUrl:mimeType ? `/api/v1/storage/artifacts/${id}/content` : undefined,archiveAllowed:!archiveReason,archiveBlocker:archiveReason,
      ownershipUnconfirmed:owners.every(owner=>owner.ownerType==='unassigned')}
  }
  async function associate(id:number,input:{sha256:string;ownerType:string;ownerId:string}) {
    return exclusive(async()=>{
      const file=registry.get(id)
      if (!file || file.state!=='present') throw Error('文件不可关联，请先刷新列表')
      const info=await safeFile(file.path)
      if (await fingerprint(file.path)!==input.sha256) throw Error('文件已经变化，请重新核验')
      const tables:Record<string,string[]>={'history-source':['history_script_sources'],'history-motion':['history_motion_productions','history_motion_jobs'],remotion:['remotion_projects'],episode:['episodes']}
      let task:Row | undefined
      for (const name of tables[input.ownerType] || []) if (table(name)) task ||= db.prepare(`SELECT * FROM ${name} WHERE id=?`).get(input.ownerId) as Row | undefined
      if (input.ownerType==='cba' && input.ownerId!=='.' && input.ownerId!=='..' && path.basename(input.ownerId)===input.ownerId) task=await readJson(path.join(dataRoot,'cba-video',input.ownerId,'job.json')) || undefined
      if (input.ownerType==='science' && /^science-[a-f0-9-]{36}$/.test(input.ownerId)) task=await readJson(path.join(dataRoot,'science-pop/jobs',input.ownerId,'job.json')) || undefined
      if (!task) throw Error('关联任务不存在，请核对任务类型和编号')
      const owner={ownerType:input.ownerType,ownerId:input.ownerId,state:task.deleted_at || task.deletedAt ? 'deleted' : task.status || 'unknown',purpose:file.role as ArtifactRole}
      registry.track([{path:file.path,role:file.role,bytes:info.size,sha256:input.sha256,owners:[...registry.owners(id),owner]}])
      const previous=json(file.review_json,{})
      db.prepare('UPDATE storage_artifacts SET review_json=? WHERE id=?').run(JSON.stringify({...previous,associations:[...(previous.associations || []),{...owner,sha256:input.sha256,verifiedAt:new Date().toISOString(),method:'manual'}]}),id)
      return {status:'associated',message:'已记录任务关联，请继续核验产物及上传结果'}
    })
  }
  async function summary() {
    const completed=db.prepare("SELECT report_json FROM storage_cleanup_runs WHERE status='completed' ORDER BY started_at DESC LIMIT 1").get() as Row | undefined
    if (completed) lastRun=json(completed.report_json) || lastRun
    const disk = await statfs(projectRoot), totalBytes=disk.blocks*disk.bsize,freeBytes=disk.bavail*disk.bsize
    const groups=STORAGE_KINDS.map(kind=>({kind,label:labels[kind],count:items.filter(item=>item.kind===kind).length,bytes:items.filter(item=>item.kind===kind).reduce((sum,item)=>sum+item.bytes,0)}))
    const totals=db.prepare("SELECT count(*) AS files,COALESCE(sum(bytes),0) AS bytes FROM storage_artifacts WHERE state='present'").get() as Row
    return {disk:{totalBytes,freeBytes,usedPercent:Math.round((totalBytes-freeBytes)/totalBytes*1000)/10},policy:policy(),groups,items,
      protected:{files:Number(totals.files)-new Set(items.map(item=>item.path)).size,bytes:Math.max(0,Number(totals.bytes)-items.reduce((sum,item)=>sum+item.bytes,0)),
        pendingUploads:rows('history_social_upload_jobs').filter(job=>activeStates.has(job.status) || job.status==='failed').length},lastRun,running:running || await maintenanceActive(),scannedAt,
      activity:runtime().activity,scheduler:runtime().scheduler,slowStages:runtime().slowStages}
  }
  const saveRun = (run: Run, status: string) => db.prepare(`INSERT INTO storage_cleanup_runs(id,started_at,finished_at,status,report_json) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,report_json=excluded.report_json`)
    .run(run.id,run.startedAt,run.finishedAt || null,status,JSON.stringify(run))
  const lockPath=path.join(dataRoot,'storage/maintenance.lock')
  function processActive(pid:unknown) {
    if (!Number.isSafeInteger(pid) || Number(pid)<=0) return true
    try {process.kill(Number(pid),0);return true} catch(error) {return (error as NodeJS.ErrnoException).code!=='ESRCH'}
  }
  async function maintenanceActive() {
    const lock=await readJson(lockPath)
    return !!lock && processActive(lock.pid)
  }
  async function exclusive<T>(operation:()=>Promise<T>,name='maintenance') {
    if (running) throw Error('磁盘检查或回收正在执行')
    running=true
    activity={operation:name,phase:'acquire-maintenance-lock',startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
    let handle
    try {
      await mkdir(path.dirname(lockPath),{recursive:true})
      try {handle=await open(lockPath,'wx',0o600)} catch(error) {
        if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error
        const previous=await lstat(lockPath),lock=await readJson(lockPath)
        if (!previous.isFile() || !lock || processActive(lock.pid)) throw Error('其他进程正在检查或回收磁盘')
        const current=await lstat(lockPath)
        if (current.ino!==previous.ino || current.mtimeMs!==previous.mtimeMs) throw Error('磁盘维护锁已更新，请稍后重试')
        await unlink(lockPath);handle=await open(lockPath,'wx',0o600)
      }
      await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}))
      const result=await operation();markActivity('completed');return result
    } catch(error){markActivity('failed',{error:(error as Error).message});throw error
    } finally { if (handle) { await handle.close(); await unlink(lockPath) }; running=false;if(activity)activity={...activity,finishedAt:new Date().toISOString()} }
  }
  async function cleanup(kinds: StorageKind[] = [...STORAGE_KINDS], owner?:{ownerType:string;ownerId:string},trigger:Run['trigger']='manual') {
    return exclusive(async()=>{
      await inventory()
      const run: Run={id:randomUUID(),startedAt:new Date().toISOString(),freedBytes:0,removedCount:0,errors:[],actions:[],trigger}
      slowStages=[];markActivity('cleanup',{runId:run.id,processed:0,total:items.length})
      const diskBefore=await statfs(projectRoot)
      run.diskBeforeFreeBytes=diskBefore.bavail*diskBefore.bsize
      saveRun(run,'running')
      const renders=new Set<string>(),sources=new Set<string>(),publishedInputCache=createPublishedMediaInputCache()
      try {
        for (const item of items.filter(item=>kinds.includes(item.kind) && (!owner || registry.owners(registry.byPath(item.path)!.id).some(ref=>ref.ownerType===owner.ownerType && ref.ownerId===owner.ownerId)))) {
          markActivity('check-file',{path:item.path,processed:(activity?.processed || 0)+1})
          const sourceKey=(item.scienceId ? 'science:' : 'history:')+(item.scienceId || String(item.sourceId))
          if (item.kind==='transcribed-source' && sources.has(sourceKey) || item.kind==='render-cache' && renders.has(item.output!)) continue
          try {
            const record=registry.byPath(item.path)
            if (!record || record.pinned) continue
            const before=await safeFile(item.path)
            const action: Row={kind:item.kind,path:item.path,ownerType:item.ownerType,ownerId:item.ownerId,status:'checking'}
            run.actions.push(action);saveRun(run,'running')
            if (item.kind==='duplicate-material') {
              const canonical=await safeFile(item.canonical!)
              if (canonical.dev!==before.dev || canonical.ino===before.ino || registry.byPath(item.canonical!)?.pinned) {action.status='retained';action.reason='副本已合并、已保留或位于其他磁盘';continue}
              const blockers=[...await blockersFor(record),...await blockersFor(registry.byPath(item.canonical!)!)]
              if (blockers.length) {action.status='retained';action.blockers=blockers;continue}
              if (await fingerprint(item.path)!==item.sha256 || await fingerprint(item.canonical!)!==item.sha256) throw Error('素材指纹已改变，保留原文件')
              const temporary=item.path+'.storage-link-'+randomUUID()
              try {
                await link(item.canonical!,temporary)
                const linked=await safeFile(temporary),origin=await safeFile(item.canonical!)
                if (linked.dev!==canonical.dev || linked.ino!==canonical.ino || origin.ino!==linked.ino
                  || origin.mtimeMs!==canonical.mtimeMs || origin.size!==canonical.size || await fingerprint(temporary)!==item.sha256) throw Error('核验期间原始副本发生变化')
                const current=await safeFile(item.path)
                if (current.dev!==before.dev || current.ino!==before.ino || current.mtimeMs!==before.mtimeMs || current.size!==before.size) throw Error('核验期间素材发生变化')
                await rename(temporary,item.path)
              } finally { await unlink(temporary).catch(()=>{}) }
              action.status='deduplicated';action.sha256=item.sha256
              if (before.nlink===1) run.freedBytes+=before.blocks*512
              run.removedCount++
            } else if (item.kind==='transcribed-source') {
              sources.add(sourceKey)
              const related=groupFiles(item)
              if (groupBlocked(item)) {action.status='retained';action.reason='同组文件仍有引用或保留标记';continue}
              let result:any
              if (item.scienceId) {
                const {getScienceWorkflowService}=await import('./science-workflow.js')
                result=await getScienceWorkflowService().cleanupSourceMedia(item.scienceId)
              } else if (options.releaseSource) result=await options.releaseSource(item.sourceId!)
              else result=await (await import('./history-source-pipeline.js')).cleanupHistorySourceMedia(item.sourceId!)
              action.status='released';action.evidence=item.scienceId ? result : json(result?.mediaJson)?.cleanup
              let retained=false
              for (const candidate of related) {
                if (!await lstat(candidate.path).then(()=>true,()=>false)) {registry.release(candidate.path,action);run.freedBytes+=candidate.bytes;run.removedCount++}
                else retained=true
              }
              if (retained) {action.status='retained';action.reason=action.evidence?.error || '删除入口保留了仍需保护的文件'}
            } else if (item.kind==='render-cache') {
              renders.add(item.output!)
              const related=groupFiles(item)
              if (groupBlocked(item)) {action.status='retained';action.reason='同组缓存仍有引用或保留标记';continue}
              const renderCleanup=options.cleanupRender || (await import(new URL('../../../scripts/history-motion/render.mjs',import.meta.url).href)).cleanupHistoryMotionRenderCache
              const result=await renderCleanup(item.output!)
              if (result.status!=='completed') throw Error(result.reason || '原始素材或成片证据不完整，保留缓存')
              action.status='released';action.evidence=result
              for (const candidate of related) if (!await lstat(candidate.path).then(()=>true,()=>false)) {registry.release(candidate.path,action);run.freedBytes+=candidate.bytes;run.removedCount++}
            } else {
              const timingsMs:Record<string,number>={}
              action.timingsMs=timingsMs
              const timed=<T>(phase:string,operation:()=>T):T=>{
                markActivity(phase,{path:item.path})
                const started=performance.now()
                try{return operation()}finally{
                  timingsMs[phase]=performance.now()-started
                  if(timingsMs[phase]>=1000)slowStages=[{phase,elapsedMs:timingsMs[phase],path:item.path,runId:run.id},...slowStages].slice(0,20)
                }
              }
              const current=(options.published || discoverPublishedMedia)(db,projectRoot,Date.now(),policy().retentionDays).find(output=>output.path===item.path)
              if (!current) {action.status='retained';action.reason='发表凭证已变化';continue}
              markActivity('hash',{path:item.path})
              if (await fingerprint(item.path)!==current.sha256) throw Error('成片内容已经变化，保留成片')
              // Parse large inputs before taking the write lock. Final checks
              // compare exact current JSON bytes and current small fields;
              // unrelated progress/heartbeat updates do not revoke authorization.
              const preparedSchema=db.pragma('schema_version',{simple:true})
              const prepared=(options.published || discoverPublishedMedia)(db,projectRoot,Date.now(),policy().retentionDays).find(output=>output.path===item.path)
              const preparedFile=registry.byPath(item.path)
              if (!prepared || prepared.sha256!==current.sha256 || !preparedFile || preparedFile.state!=='present') {
                action.status='retained';action.reason='发表凭证或文件登记已变化';continue
              }
              const inspectInputs=createPublishedMediaInputInspector(db,projectRoot,prepared,publishedInputCache)
              const inputBlockers=timed('prepareInputs',()=>inspectInputs()).map(owner=>`${owner} 当前引用成片`)
              if (inputBlockers.length) {action.status='retained';action.blockers=inputBlockers;continue}
              // Warm the byte-comparison scan outside the write lock as well;
              // cold table pages and garbage from the first JSON parse can be
              // much slower than subsequent scans on the production database.
              const changedInputs=timed('warmInputs',()=>inspectInputs(false))
              if (changedInputs.length) {action.status='retained';action.blockers=changedInputs;continue}
              const transactionStarted=performance.now()
              let released=false,bodyStarted=0,bodyFinished=0
              try {released=db.transaction(()=>{
                bodyStarted=performance.now();timingsMs.lockWait=bodyStarted-transactionStarted
                try {
                if (db.pragma('schema_version',{simple:true})!==preparedSchema) {action.status='retained';action.reason='工作流结构已更新，稍后重新核验';return false}
                // Publication evidence is small and remains live inside the lock.
                const latest=timed('livePublication',()=>(options.published || discoverPublishedMedia)(db,projectRoot,Date.now(),policy().retentionDays).find(output=>output.path===item.path))
                const fresh=registry.byPath(item.path)
                if (!latest || latest.sha256!==current.sha256 || !fresh || fresh.state!=='present') {
                  action.status='retained';action.reason='发表凭证或文件登记已变化';return false
                }
                const blockers=[...timed('workflowBlockers',()=>blockersFor(fresh)),...timed('liveInputs',()=>inspectInputs(false)).map(owner=>`${owner} 当前引用成片`)]
                if (fresh.pinned) blockers.push('文件已设置保留')
                const pinPath=path.join(path.dirname(item.path),'storage-preserve.json')
                if (fileExists(pinPath)) {
                  const pins=JSON.parse(readFileSync(pinPath,'utf8'))
                  if (!Array.isArray(pins.files)) throw Error('保留设置无法读取')
                  if (pins.files.includes(path.basename(item.path))) blockers.push('文件已设置保留')
                }
                if (blockers.length) {action.status='retained';action.blockers=blockers;return false}
                timed('fileIdentity',()=>{
                  const final=lstatSync(item.path)
                  if (!final.isFile() || realpathSync(item.path)!==item.path || final.dev!==before.dev || final.ino!==before.ino
                    || final.size!==before.size || final.mtimeMs!==before.mtimeMs || final.ctimeMs!==before.ctimeMs) throw Error('核验期间成片发生变化，保留成片')
                })
                timed('authorize',()=>{action.status='authorized';action.evidence=latest.evidence;saveRun(run,'running')})
                timed('unlink',()=>unlinkSync(item.path));action.status='released'
                timed('release',()=>registry.release(item.path,action))
                return true
                } finally {bodyFinished=performance.now();timingsMs.transactionBody=bodyFinished-bodyStarted}
              }).immediate()} finally {
                const finished=performance.now();timingsMs.transactionTotal=finished-transactionStarted
                if(bodyFinished)timingsMs.transactionFinish=finished-bodyFinished
                if(timingsMs.transactionBody>=1000)slowStages=[{phase:'transactionBody',elapsedMs:timingsMs.transactionBody,path:item.path,runId:run.id},...slowStages].slice(0,20)
              }
              if (released) {run.freedBytes+=before.nlink===1 ? before.blocks*512 : 0;run.removedCount++}
            }
            saveRun(run,'running')
          } catch (error) { run.errors.push(`${item.ownerType}:${item.ownerId} ${path.basename(item.path)}: ${(error as Error).message}`);saveRun(run,'running') }
        }
      } finally {
        publishedInputCache.clear()
        const diskAfter=await statfs(projectRoot)
        run.reclaimedFileBytes=run.freedBytes;run.diskAfterFreeBytes=diskAfter.bavail*diskAfter.bsize
        run.freedBytes=Math.max(0,run.diskAfterFreeBytes-run.diskBeforeFreeBytes!)
        run.finishedAt=new Date().toISOString();lastRun=run;saveRun(run,'completed');items=[]
      }
      return summary()
    },'cleanup').then(result=>({...result,running:false,activity:runtime().activity}))
  }
  async function review(id: number, input: {action:'keep'|'delete'|'archive';sha256:string;productionVerified?:boolean;uploadVerified?:boolean;receiptUrls?:string[];backupPath?:string}) {
    return exclusive(async()=>{
      await inventory()
      const file=registry.get(id)
      if (!file) throw Error('文件未登记')
      const inspection=await inspect(id)
      if (inspection.sha256!==input.sha256) throw Error('文件已经变化，请重新核验')
      if (input.action==='keep') {
        const pinPath=path.join(path.dirname(file.path),'storage-preserve.json'),pins=await readJson(pinPath) || {version:1,files:[]}
        if (!Array.isArray(pins.files)) throw Error('保留设置无法读取')
        const temporary=pinPath+'.'+randomUUID()+'.tmp'
        await writeFile(temporary,JSON.stringify({version:1,files:[...new Set([...pins.files,path.basename(file.path)])]}),{mode:0o600});await rename(temporary,pinPath)
        registry.pin(id,true);return {status:'kept',message:'已保留，自动回收不会处理此文件'}
      }
      if (inspection.blockers.length) throw Error(inspection.blockers.join('；'))
      if (input.action==='delete' && (input.productionVerified!==true || input.uploadVerified!==true || !input.receiptUrls?.length
        || input.receiptUrls.some(url=>{try{return !['http:','https:'].includes(new URL(url).protocol)}catch{return true}}))) throw Error('请先核验产物完整、所有目标平台上传成功，并登记回执链接')
      const run: Run={id:randomUUID(),startedAt:new Date().toISOString(),freedBytes:0,removedCount:0,errors:[],actions:[{artifactId:id,path:file.path,sha256:input.sha256,owners:inspection.owners,review:input,status:'authorized'}]}
      if (input.action==='delete' && (file.role!=='final' || hasInputConsumer(file))) throw Error('工程输入需要可用归档，不能直接删除')
      if (input.action==='archive') {
        const reason=archiveBlocker(file)
        if (reason) throw Error(reason)
        if (!input.backupPath || !path.isAbsolute(input.backupPath)) throw Error('请提供已经存在的完整归档文件路径')
        const original=await safeFile(file.path)
        saveRun(run,'running')
        const {archiveVerifiedFile}=await import('./storage-archive.js')
        await archiveVerifiedFile(db,id,input.sha256,input.backupPath,{dataRoot,review:input,assertCanRelease:async()=>{
          const blockers=await blockersFor(file)
          if (blockers.length) throw Error(blockers.join('；'))
        }})
        run.freedBytes=original.nlink===1 ? original.blocks*512 : 0
      } else {
        saveRun(run,'running')
        const original=await safeFile(file.path)
        if (await fingerprint(file.path)!==input.sha256 || (await blockersFor(file)).length) throw Error('文件或任务状态已改变，请重新核验')
        await unlink(file.path);registry.release(file.path,input);run.freedBytes=original.nlink===1 ? original.blocks*512 : 0
      }
      run.removedCount=1;run.finishedAt=new Date().toISOString();lastRun=run;saveRun(run,'completed')
      return {status:input.action==='archive' ? 'archived' : 'released',message:input.action==='archive' ? '归档校验通过，制作时将从归档恢复素材' : '核验及回执已登记，成片已回收'}
    })
  }
  return {
    registry,summary,reviewList,inspect,cleanup,review,associate,runtime,
    softDeleteCbaTask:(id:string,input:{confirm:true;expectedTitle:string})=>exclusive(async()=>{
      const {CbaVideoService}=await import('./cba-video.js')
      const service=new CbaVideoService({root:path.join(dataRoot,'cba-video'),projectRoot,autoRecover:false})
      return service.deleteTask(id,input)
    }),
    async media(id:number) {
      const file=registry.get(id),mimeType=file && mediaTypes[path.extname(file.path).toLowerCase()]
      if (!file || file.state!=='present' || !mimeType) throw Error('文件不可预览，请先恢复归档或刷新列表')
      const info=await safeFile(file.path)
      return {path:file.path as string,bytes:info.size,mimeType}
    },
    restore: (id: number)=>exclusive(async()=>{
      const file=registry.get(id),owners=registry.owners(id)
      if (!file || file.state!=='archived' || !owners.length) throw Error('文件未归档或缺少任务关联')
      const {restoreArchivedArtifacts}=await import('./storage-archive.js')
      const result=await restoreArchivedArtifacts(db,owners[0].ownerType,owners[0].ownerId,{dataRoot})
      if (result.errors.length) throw Error(result.errors.map(item=>item.message).join('；'))
      return {status:'restored',message:'任务归档素材已恢复'}
    }),
    scan:()=>exclusive(async()=>{await inventory();return summary()},'scan').then(result=>({...result,running:false,activity:runtime().activity})),
    updatePolicy(input: Partial<Policy>) {
      if (input.retentionDays!==undefined && (!Number.isInteger(input.retentionDays) || input.retentionDays<0 || input.retentionDays>90)) throw Error('成片保留期须为 0 至 90 天')
      if (input.autoCleanup!==undefined && typeof input.autoCleanup!=='boolean') throw Error('自动回收设置无效')
      const value={...policy(),...input};db.prepare('INSERT INTO storage_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(JSON.stringify(value));return value
    },
    start() {
      if(worker && worker.status().state!=='stopped')return worker
      const successful=db.prepare(`SELECT finished_at FROM storage_cleanup_runs WHERE status='completed' AND json_valid(report_json)
        AND json_extract(report_json,'$.trigger')='scheduled' AND json_array_length(report_json,'$.errors')=0 ORDER BY finished_at DESC LIMIT 1`).get() as Row|undefined
      worker=createStorageMaintenanceScheduler({autoCleanup:()=>policy().autoCleanup,lastCleanupAt:successful?.finished_at,
        run:async mode=>{
          if(mode==='scan')return exclusive(async()=>{await inventory();return summary()},'scan')
          const result=await cleanup(undefined,undefined,'scheduled')
          if(result.lastRun?.errors.length)throw Error(result.lastRun.errors.join('；'))
          return result
        }})
      return worker
    },
  }
}

export type StorageManager = ReturnType<typeof createStorageManager>
let manager: StorageManager | undefined
export async function getStorageManager() {
  if (!manager) {
    const {db}=await import('../db/index.js')
    manager=createStorageManager({db:db.$client,projectRoot:fileURLToPath(new URL('../../../',import.meta.url))})
  }
  return manager
}
