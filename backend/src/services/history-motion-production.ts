import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {fork} from 'node:child_process'
import { z } from 'zod'
import { HuashengMaterialLibrary } from './huasheng-material-library.mjs'
import { ensureHistoryStatusSchema, historyStatusReadsEnabled, HISTORY_STATUS_SCHEMA_VERSION, projectHistoryMotionStatus } from './history-status-storage.js'

export const MOTION_ROOT = fileURLToPath(new URL('../../../data/storage/history-motion', import.meta.url))
const DEFAULT_DB = fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url))
const DEFAULT_MATERIAL_ROOT = fileURLToPath(new URL('../../../data/huasheng-recommendations', import.meta.url))
export const motionProfileSchema = z.enum(['16:9', '9:16'])
export const materialSearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  projectId: z.string().trim().min(1).max(100).optional(),
  clipId: z.string().trim().min(1).max(100).optional(),
  shotSize: z.enum(['wide', 'medium', 'close', 'any']).default('any'),
  durationMax: z.number().finite().positive().max(3600).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict()
export const motionSelectionSchema = z.object({
  assetId: z.string().trim().min(1), inPoint: z.number().finite().min(0).default(0),
  outPoint: z.number().finite().positive(), crop: z.enum(['center', 'cover', 'contain', 'left', 'right']).default('center'),
  confidence: z.number().finite().min(0).max(1).default(0), reason: z.string().trim().max(1000).default('按检索顺序选择素材'),
  shortfallPolicy: z.enum(['reject', 'freeze']).default('reject'),
}).strict()
const cameraSchema = z.object({kind: z.enum(['static', 'kenburns', 'pan', 'keyframes']), durationScale: z.number().positive().max(1).default(1),
  keyframes: z.array(z.object({t: z.number().min(0).max(1), focusX: z.number().min(0).max(1), focusY: z.number().min(0).max(1), zoom: z.number().min(1).max(1.15)})).min(2).max(6),
}).refine(v => v.keyframes[0].t === 0 && v.keyframes.at(-1)!.t === 1 && v.keyframes.every((k, i) => !i || k.t > v.keyframes[i - 1].t), 'Motion keyframes must span 0..1 in order')
export const motionGraphicSchema = z.object({
  kind: z.enum(['timeline', 'comparison', 'relationship', 'quote']),
  title: z.string().trim().min(1).max(40),
  items: z.array(z.object({label: z.string().trim().min(1).max(40), detail: z.string().max(120).optional(), value: z.string().max(30).optional()})).min(1).max(6),
})
const motionMapForceSchema = z.object({
  id: z.string().trim().min(1).max(100), commander: z.string().trim().min(1).max(24).optional(),
  faction: z.string().trim().min(1).max(32), flagText: z.string().trim().min(1).max(3),
  color: z.string().regex(/^#[a-f0-9]{6}$/i), city: z.string().trim().min(1).max(60),
  routeIndex: z.number().int().min(0).max(5).optional(),
  action: z.enum(['hold', 'march', 'attack', 'occupy', 'retreat']),
  troopKind: z.enum(['infantry', 'cavalry']).optional(),
  start: z.number().finite().min(0), end: z.number().finite().positive().max(3600),
}).strict().refine(force => force.end > force.start, {path: ['end'], message: '军队动作结束必须晚于开始'})
export const motionMapPlanSchema = z.object({
  title: z.string().max(40).optional(), places: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
  routes: z.array(z.object({from: z.string().trim().min(1).max(60), to: z.string().trim().min(1).max(60), label: z.string().max(40).optional()}).strict()).max(6).optional(),
  presentation: z.object({
    kind: z.enum(['locate', 'route', 'encirclement']),
    target: z.string().trim().min(1).max(60).optional(),
    label: z.string().trim().min(1).max(40).optional(),
    compress: z.boolean().optional(),
  }).strict().optional(),
  forces: z.array(motionMapForceSchema).max(8).optional(),
}).strict().superRefine((plan, ctx) => {
  if (plan.presentation?.target && !plan.places.includes(plan.presentation.target))
    ctx.addIssue({code: 'custom', path: ['presentation', 'target'], message: '动画目标必须来自已列出的地点'})
  if (plan.presentation?.kind === 'route' && !plan.routes?.length)
    ctx.addIssue({code: 'custom', path: ['routes'], message: '路线动画需要明确起终点'})
  const ids = new Set<string>()
  const routeTimes = new Map<number, {start: number; end: number}>()
  for (const [index, force] of (plan.forces ?? []).entries()) {
    const issue = (field: string, message: string) => ctx.addIssue({code: 'custom', path: ['forces', index, field], message})
    if (ids.has(force.id)) issue('id', '军队标识不能重复')
    ids.add(force.id)
    if (!plan.places.includes(force.city)) issue('city', '军队锚点必须来自已列出的地点')
    if (force.routeIndex !== undefined) {
      const route = plan.routes?.[force.routeIndex]
      if (!route) issue('routeIndex', '军队路线必须引用已有路线')
      else if (route.to !== force.city) issue('city', '军队锚点必须与路线终点一致')
      if (force.action === 'hold') issue('routeIndex', '驻守动作不能附带行军路线')
      const timing = routeTimes.get(force.routeIndex)
      if (timing && (timing.start !== force.start || timing.end !== force.end)) issue('routeIndex', '同一路线的军队动作时间必须一致')
      routeTimes.set(force.routeIndex, force)
    } else if (force.action === 'march' || force.action === 'retreat' || (force.action === 'attack' && plan.presentation?.kind !== 'encirclement')) {
      issue('routeIndex', '行军、撤退和进攻必须指定路线；包围态势可使用城市锚点')
    }
  }
})
export const motionShotSchema = z.object({
  shotId: z.string().trim().min(1).max(100), narration: z.string().max(4000), duration: z.number().finite().positive().max(3600),
  search: materialSearchSchema, selection: motionSelectionSchema.optional(), motion: cameraSchema.optional(),
  mapPackId: z.string().max(100).optional(), mapReason: z.string().max(1000).optional(),
  visualType: z.enum(['auto', 'video', 'map', 'image', 'graphic']).optional(),
  purpose: z.string().max(300).optional(), imagePrompt: z.string().max(4000).optional(),
  mapPlan: motionMapPlanSchema.optional(), graphic: motionGraphicSchema.optional(),
  soundEffect: z.object({query: z.string().trim().min(1).max(100), start: z.number().min(0).default(0), duration: z.number().positive().max(8).optional(), volume: z.number().min(.05).max(.35).optional()}).optional(),
  sourceNote: z.string().trim().min(1).max(100).optional(),
  titles: z.array(z.object({text: z.string().min(1).max(16), start: z.number().min(0), duration: z.number().positive()})).max(3).default([]),
}).strict().superRefine((shot, ctx) => {
  for (const [index, force] of (shot.mapPlan?.forces ?? []).entries()) {
    if (force.end > shot.duration) ctx.addIssue({code: 'custom', path: ['mapPlan', 'forces', index, 'end'], message: '军队动作时间不能超出镜头时长'})
  }
})
export const motionPlanSchema = z.object({scriptRevision: z.string().regex(/^[a-f0-9]{64}$/), profile: motionProfileSchema.default('16:9'),
  shots: z.array(motionShotSchema).min(1).max(500),
}).strict().refine(v => new Set(v.shots.map(s => s.shotId)).size === v.shots.length, 'Duplicate shot IDs')
export type MaterialSearchInput = z.infer<typeof materialSearchSchema>
export type MotionSelection = z.infer<typeof motionSelectionSchema>
export type MotionShot = z.infer<typeof motionShotSchema>
export type MotionPlanInput = z.infer<typeof motionPlanSchema>
export type MotionCandidate = {
  assetId: string; rank: number; description: string; shotText: string; query: string;
  duration: number; width: number; height: number; fps: number | null;
  localPath: string; sha256: string; projectId: string; clipId: string;
  shotSize: 'wide' | 'medium' | 'close' | 'unknown';
  searchFallback?: 'shot-size-unknown';
}
export type MotionJob = {
  id: string; scriptId: number; title: string; scriptRevision: string; script: string;
  profile: '16:9' | '9:16';
  status: 'queued' | 'planning' | 'selecting' | 'needs_review' | 'rendering' | 'validating' | 'completed' | 'failed';
  stage: string; message: string; requested: MotionPlanInput; candidates: Record<string, MotionCandidate[]>;
  plan: Record<string, any> | null; outputPath: string | null; error: string | null; createdAt: string; updatedAt: string;
  retry?: {attempts:number;nextAttemptAt:string;lastError:string};
  factory?: {
    episodeId: number; projectId: number; sourceId?: number; scriptHash: string;
    seedShots?: {shotId:string;narration:string;duration:number;storyboardId:number}[];
    fallbackImages?: Record<string,{imagePath:string;imageSha256:string}>;
  };
}
export type MotionJobSummary = Pick<MotionJob, 'id' | 'status' | 'stage' | 'message' | 'updatedAt'> & {
  videoUrl: string | null; shotCount: number; readyShotCount: number;
  statusFresh?: boolean;
}
type SearchLibrary = { search: (input: any) => any[]; close?: () => void;
  findFiles?: (assetId: string) => {filePath: string; sha256: string; media?: Record<string,unknown>}[] }
type MaterialSearchRows = {rows:any[];filesByAsset:Record<string,ReturnType<NonNullable<SearchLibrary['findFiles']>>>}
export interface HistoryMotionProductionOptions {
  databasePath?: string; materialRoot?: string; root?: string; library?: SearchLibrary;
  database?: Database.Database; now?: () => string; reviewConfidence?: number;
  searchWorkerPath?:URL;
}
export function resolveMotionSearchTimeoutMs(env:NodeJS.ProcessEnv=process.env) {
  const value=Number(env.HISTORY_MOTION_SEARCH_TIMEOUT_MS)
  return Number.isFinite(value)&&value>0?Math.min(30000,Math.max(100,value)):5000
}
export function runMotionMaterialSearchWorker(input:{databasePath:string;queries:Record<string,unknown>[]},
  options:{timeoutMs:number;workerPath?:URL;signal?:AbortSignal}):Promise<MaterialSearchRows> {
  if(options.signal?.aborted)return Promise.reject(Error('Material search was cancelled'))
  return new Promise((resolve,reject)=>{
    // A subprocess can stop native synchronous SQLite, which a JS timer cannot interrupt.
    const child=fork(options.workerPath||new URL('./history-motion-search-worker.mjs',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
    let result:any,failure:Error|undefined,workerStarted=false,settled=false
    const kill=()=>{child.kill('SIGKILL')}
    const stop=(code:string,message:string)=>{
      failure ||= Object.assign(Error(message),{code,workerPid:child.pid,workerStarted});kill()
    }
    const abort=()=>stop('MATERIAL_SEARCH_CANCELLED','Material search was cancelled')
    const timer=setTimeout(()=>stop('MATERIAL_SEARCH_TIMEOUT',`Material search exceeded its ${options.timeoutMs} ms read budget`),options.timeoutMs)
    process.once('exit',kill);options.signal?.addEventListener('abort',abort,{once:true})
    const finish=(error?:Error)=>{
      if(settled)return
      settled=true;clearTimeout(timer);process.removeListener('exit',kill);options.signal?.removeEventListener('abort',abort)
      if(error)reject(error)
      else resolve({rows:result.rows,filesByAsset:result.filesByAsset})
    }
    child.on('message',(message:any)=>{if(message?.type==='started')workerStarted=true;else result=message})
    child.on('error',error=>{failure ||= error;if(child.pid)kill();else finish(error)})
    child.once('close',(code,signal)=>{
      if(failure)return finish(failure)
      if(code!==0||signal||result?.ok!==true||!Array.isArray(result.rows)||!result.filesByAsset)return finish(Error(result?.error||`Material search worker exited (${code ?? signal})`))
      finish()
    })
    try {child.send(input,error=>{if(error){failure ||= error;kill()}})}
    catch(error){failure ||= error as Error;kill()}
  })
}
export const hashText = (value: string) => createHash('sha256').update(value).digest('hex')
export const sourceRevision = (value: unknown) => hashText(JSON.stringify(value))
export const textContent = (value: string) => value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
export function isTransientMotionError(error:unknown) {
  const message=error instanceof Error?error.message:String(error || '')
  return /服务重启中断制作|API error (?:408|429|5\d\d)\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout|timed out|fetch failed|socket hang up|rate.?limit|temporarily unavailable|upstream.*failed|No available compatible accounts)\b|超时|超过\s*\d+\s*秒|暂时|限流|兼容账号|请求已提交但结果不明|图片服务连续失败/i.test(message)
}
export function inside(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function shotSize(text: string): MotionCandidate['shotSize'] {
  if (/远景|全景|wide|establishing/i.test(text)) return 'wide'
  if (/特写|近景|close.?up/i.test(text)) return 'close'
  if (/中景|medium/i.test(text)) return 'medium'
  return 'unknown'
}

export function createHistoryMotionProduction(options: HistoryMotionProductionOptions = {}) {
  const filename = options.databasePath || process.env.DB_PATH || DEFAULT_DB
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), {recursive: true})
  const database = options.database || new Database(filename, {timeout: 30000})
  const library: SearchLibrary = options.library || new HuashengMaterialLibrary({databasePath: filename})
  const root = path.resolve(options.root || MOTION_ROOT)
  const materialRoot = path.resolve(options.materialRoot || process.env.HUASHENG_MATERIAL_ROOT || DEFAULT_MATERIAL_ROOT)
  const searchController=new AbortController()
  // macOS may expose the same directory as /var and /private/var. Compare
  // canonical paths after resolving symlinks; the final real path must still
  // remain inside the configured root.
  const materialRealRoot = (() => { try { return fs.realpathSync(materialRoot) } catch { return materialRoot } })()
  const clock = options.now || (() => new Date().toISOString())
  // JSON snapshots keep model inputs, candidate provenance and output plan in one atomic record.
  database.exec(`CREATE TABLE IF NOT EXISTS history_motion_productions (
    id TEXT PRIMARY KEY, script_id INTEGER NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_motion_productions_source ON history_motion_productions(script_id,updated_at);`)
  ensureHistoryStatusSchema(database)
  function write(job: MotionJob) {
    return database.transaction(() => {
      job.updatedAt = clock()
      database.prepare(`INSERT INTO history_motion_productions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,updated_at=excluded.updated_at,snapshot=excluded.snapshot`)
        .run(job.id, job.scriptId, job.status, job.updatedAt, JSON.stringify(job))
      projectHistoryMotionStatus(database,job.id,job)
      return job
    })()
  }
  function find(id: string): MotionJob | null {
    const row = database.prepare('SELECT snapshot FROM history_motion_productions WHERE id=?').get(id) as {snapshot: string} | undefined
    return row ? JSON.parse(row.snapshot) : null
  }
  const summaryQuery = database.prepare(`SELECT
    json_extract(snapshot,'$.id','$.status','$.stage','$.message','$.updatedAt','$.plan.deliveryAssociation.videoUrl') AS fields,
    json_array_length(snapshot,'$.requested.shots') AS shotCount,
    (SELECT COUNT(*) FROM json_each(snapshot,'$.plan.visuals') WHERE key IS NOT NULL) AS readyShotCount
    FROM history_motion_productions WHERE id=?`)
  const summaryVersionQuery = database.prepare('SELECT data_version AS dataVersion,total_changes() AS totalChanges FROM pragma_data_version')
  const summaryCache = new Map<string, MotionJobSummary | null>()
  let summaryVersion: {dataVersion:number; totalChanges:number} | undefined
  function readSummary(id: string): MotionJobSummary | null {
    const row = summaryQuery.get(id) as {fields: string; shotCount: number; readyShotCount: number} | undefined
    if (!row) return null
    // Keep large candidates, visuals and plans inside SQLite when polling the list.
    const [jobId,status,stage,message,updatedAt,videoUrl] = JSON.parse(row.fields)
    return {id:jobId,status,stage,message,updatedAt,videoUrl,shotCount:row.shotCount,readyShotCount:row.readyShotCount}
  }
  function findSummary(id: string): MotionJobSummary | null {
    if (historyStatusReadsEnabled()) {
      const row=database.prepare(`SELECT p.id,p.status,p.updated_at,s.status AS observed_status,s.updated_at AS observed_updated_at,
        s.stage,s.message,s.video_url,s.shot_count,s.ready_shot_count,
        s.input_revision,s.projected_revision,s.schema_version,s.deleted FROM history_motion_productions p
        LEFT JOIN history_motion_status s ON s.job_id=p.id WHERE p.id=?`).get(id) as Record<string,any> | undefined
      if (!row) return null
      const fresh=row.input_revision===row.projected_revision && row.schema_version===HISTORY_STATUS_SCHEMA_VERSION && !row.deleted
      return {id:row.id,status:row.observed_status ?? row.status,updatedAt:row.observed_updated_at ?? row.updated_at,stage:fresh?row.stage:'status_sync',
        message:fresh?row.message:'任务状态正在同步',videoUrl:fresh?row.video_url:null,
        shotCount:row.shot_count ?? 0,readyShotCount:row.ready_shot_count ?? 0,statusFresh:fresh}
    }
    // data_version tracks other connections; total_changes tracks this one.
    // Transaction-local results cannot be cached because a rollback keeps total_changes.
    if (database.inTransaction) {
      summaryCache.clear();summaryVersion=undefined
      return readSummary(id)
    }
    const version=summaryVersionQuery.get() as {dataVersion:number; totalChanges:number}
    if (!summaryVersion || version.dataVersion!==summaryVersion.dataVersion || version.totalChanges!==summaryVersion.totalChanges) {
      summaryCache.clear();summaryVersion=version
    }
    if (!summaryCache.has(id)) summaryCache.set(id,readSummary(id))
    const summary=summaryCache.get(id)!
    return summary?{...summary}:null
  }
  function list(scriptId?: number) {
    const rows = scriptId === undefined
      ? database.prepare('SELECT snapshot FROM history_motion_productions ORDER BY updated_at DESC LIMIT 100').all()
      : database.prepare('SELECT snapshot FROM history_motion_productions WHERE script_id=? ORDER BY updated_at DESC LIMIT 100').all(scriptId)
    return (rows as {snapshot: string}[]).map(row => JSON.parse(row.snapshot) as MotionJob)
  }
  function listRecoverable(sourceIds?:readonly number[]) {
    const ids=sourceIds===undefined ? undefined : [...new Set(z.array(z.number().int().positive()).max(1000).parse(sourceIds))]
    if(ids?.length===0)return []
    const scope=ids ? ` AND script_id IN (${ids.map(()=>'?').join(',')})` : ''
    return (database.prepare(`SELECT snapshot FROM history_motion_productions WHERE status NOT IN ('completed','needs_review')${scope} ORDER BY updated_at`).all(...(ids || [])) as {snapshot:string}[])
      .map(row=>JSON.parse(row.snapshot) as MotionJob)
  }
  function safeMaterial(filename: string) {
    const real = fs.realpathSync(filename)
    if (!inside(materialRealRoot, real) || !fs.statSync(real).isFile()) throw Error('素材不在已配置的素材目录中')
    return real
  }
  function searchRequest(input:MaterialSearchInput,options:{usedAssets?:ReadonlySet<string>}) {
    const parsed = materialSearchSchema.parse(input)
    const usedAssets = options.usedAssets || new Set<string>()
    const excludeAssetIds = [...usedAssets].filter(key => key.startsWith('video-id:')).map(key => key.slice('video-id:'.length))
    const excludeSha256 = [...usedAssets].filter(key => key.startsWith('media:')).map(key => key.slice('media:'.length))
    // Limit unique assets after ranking, so repeated recommendation rows cannot consume the search budget.
    const terms = [...new Set(parsed.query.split(/[\s，,；;]+/).filter(Boolean))].slice(0, 5)
    const queries=terms.map(query=>({projectId: parsed.projectId, clipId: parsed.clipId, query,
      downloadedOnly: true, topOnly: true, distinctAssets: true, excludeAssetIds, excludeSha256, limit: 80}))
    return {parsed,usedAssets,terms,queries}
  }
  function rankCandidates({parsed,usedAssets,terms}:ReturnType<typeof searchRequest>,rows:any[],findFiles?:SearchLibrary['findFiles']):MotionCandidate[] {
    const unique = new Map<string, MotionCandidate & {score: number}>()
    const registeredFiles = new Map<string, ReturnType<NonNullable<SearchLibrary['findFiles']>>>()
    const readableFile = (candidate: {localPath?: string; sha256?: string; media?: Record<string,unknown>; duration?: unknown; width?: unknown; height?: unknown}) => {
      if (!candidate.localPath || candidate.sha256 && usedAssets.has(`media:${candidate.sha256}`)) return null
      let localPath: string
      try {localPath = safeMaterial(candidate.localPath); if (fs.statSync(localPath).size <= 0) return null} catch {return null}
      const duration = Number(candidate.media?.duration ?? candidate.duration)
      const width = Number(candidate.media?.width ?? candidate.width), height = Number(candidate.media?.height ?? candidate.height)
      if (!(duration > 0 && width > 0 && height > 0) || (parsed.durationMax && duration > parsed.durationMax)) return null
      return {localPath,sha256:String(candidate.sha256 || ''),duration,width,height}
    }
    for (const row of rows) {
      if (row.status !== 'done' || row.rank > 3 || usedAssets.has(`video-id:${row.assetId}`)) continue
      let file = readableFile(row)
      if (!file && findFiles) {
        if (!registeredFiles.has(String(row.assetId))) registeredFiles.set(String(row.assetId), findFiles(String(row.assetId)))
        for (const alternative of registeredFiles.get(String(row.assetId))!) {
          file = readableFile({localPath:alternative.filePath,sha256:alternative.sha256,media:alternative.media})
          if (file) break
        }
      }
      if (!file) continue
      // Source-project narration and search prompts are context, not observations of the clip.
      const description = String(row.sourceCaption || '')
      const captionSize = shotSize(description)
      const annotatedSize = captionSize === 'unknown' ? shotSize(String(row.query || '')) : captionSize
      if (parsed.shotSize !== 'any' && annotatedSize !== parsed.shotSize && annotatedSize !== 'unknown') continue
      const score = terms.reduce((score, term) => {
        const keyword = term.toLowerCase()
        return score + (description.toLowerCase().includes(keyword) ? 30 : 0)
          + (String(row.query || '').toLowerCase().includes(keyword) ? 10 : 0)
          + (String(row.text || '').toLowerCase().includes(keyword) ? 5 : 0)
      }, 0) - Number(row.rank)
      const existing = unique.get(String(row.assetId))
      if (existing && existing.score >= score) continue
      unique.set(String(row.assetId), {assetId: String(row.assetId), rank: Number(row.rank), description,
        shotText: String(row.text || ''), query: String(row.query || ''), ...file,
        fps: Number(row.fps) > 0 ? Number(row.fps) : null,
        projectId: String(row.projectId), clipId: String(row.clipId), shotSize: annotatedSize, score})
    }
    let ranked = [...unique.values()].sort((a,b) => b.score-a.score)
    if (parsed.shotSize !== 'any') {
      const exact = ranked.filter(candidate => candidate.shotSize === parsed.shotSize)
      ranked = exact.length ? exact : ranked.map(candidate => ({...candidate, searchFallback: 'shot-size-unknown' as const}))
    }
    const seenHashes = new Set<string>()
    return ranked.filter(candidate => {
      if (candidate.sha256 && seenHashes.has(candidate.sha256)) return false
      if (candidate.sha256) seenHashes.add(candidate.sha256)
      return true
    }).slice(0,parsed.limit).map(({score, ...candidate}) => candidate)
  }
  function search(input:MaterialSearchInput,searchOptions:{usedAssets?:ReadonlySet<string>}={}):MotionCandidate[] {
    const request=searchRequest(input,searchOptions)
    return rankCandidates(request,request.queries.flatMap(query=>library.search(query)),library.findFiles?.bind(library))
  }
  async function searchAsync(input:MaterialSearchInput,searchOptions:{usedAssets?:ReadonlySet<string>}={}):Promise<MotionCandidate[]> {
    if(options.library&&!options.searchWorkerPath)return search(input,searchOptions)
    const request=searchRequest(input,searchOptions)
    const result=await runMotionMaterialSearchWorker({databasePath:database.name,queries:request.queries},
      {timeoutMs:resolveMotionSearchTimeoutMs(),workerPath:options.searchWorkerPath,signal:searchController.signal})
    return rankCandidates(request,result.rows,assetId=>result.filesByAsset[assetId]||[])
  }
  function validateSelection(shot: MotionShot, candidates: MotionCandidate[], selection: MotionSelection, _human = false) {
    const selected = motionSelectionSchema.parse(selection)
    const candidate = candidates.find(c => c.assetId === selected.assetId)
    if (!candidate) throw Error('所选素材不在当前镜头候选中')
    safeMaterial(candidate.localPath)
    if (selected.inPoint >= selected.outPoint || selected.outPoint > candidate.duration + .001) throw Error('素材入点或出点超出可用时长')
    if (Math.floor((selected.outPoint-selected.inPoint)*30+.00001) < Math.round(shot.duration*30) && selected.shortfallPolicy !== 'freeze') throw Error('素材时长不足，请换片或明确选择尾帧停留')
    return {candidate, selected}
  }
  function create(scriptId: number, script: string, title: string, revision: string, profile: MotionJob['profile']) {
    const existing = list(scriptId).find(j => j.scriptRevision === revision && j.profile === profile && j.status !== 'failed')
    if (existing) return existing
    return write({id: randomUUID(), scriptId, title, scriptRevision: revision, script, profile, status: 'queued', stage: 'planning', message: '等待分镜设计',
      requested: {scriptRevision: revision,profile,shots:[]}, candidates: {}, plan: null, outputPath: null, error: null, createdAt: clock(), updatedAt: clock()})
  }
  function parsePlan(input:MotionPlanInput,script:string) {
    const parsed = motionPlanSchema.parse(input)
    if (textContent(parsed.shots.map(s => s.narration).join('')) !== textContent(script)) throw Error('分镜必须按顺序完整覆盖保存的旁白')
    return parsed
  }
  function savePlan(scriptId:number,parsed:MotionPlanInput,script:string,title:string,candidates:Record<string,MotionCandidate[]>) {
    for (const shot of parsed.shots) {
      if (shot.selection) validateSelection(shot, candidates[shot.shotId], shot.selection)
    }
    const job = create(scriptId, script, title, parsed.scriptRevision, parsed.profile)
    if (job.requested.shots.length) throw Error('已有该版本制作任务，请使用原任务继续')
    job.requested = parsed; job.status = 'needs_review'; job.message = '检查分镜素材'
    job.candidates = candidates
    return write(job)
  }
  function createPlan(scriptId:number,input:MotionPlanInput,script:string,title:string) {
    const parsed=parsePlan(input,script)
    const candidates=Object.fromEntries(parsed.shots.map(shot=>[shot.shotId,search(shot.search)]))
    return savePlan(scriptId,parsed,script,title,candidates)
  }
  async function createPlanAsync(scriptId:number,input:MotionPlanInput,script:string,title:string) {
    const parsed=parsePlan(input,script),candidates:Record<string,MotionCandidate[]>={}
    for(const shot of parsed.shots)candidates[shot.shotId]=await searchAsync(shot.search)
    return savePlan(scriptId,parsed,script,title,candidates)
  }
  return {root, materialRoot, find, findSummary, list, listRecoverable, write, search, searchAsync, safeMaterial, validateSelection, create, createPlan, createPlanAsync,
    close() {searchController.abort();if (!options.database && database.open) database.close(); if (!options.library) library.close?.()},
  }
}
export type HistoryMotionProduction = ReturnType<typeof createHistoryMotionProduction>
