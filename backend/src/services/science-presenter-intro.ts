import {execFile} from 'node:child_process'
import {createHash, randomInt, randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {z} from 'zod'
import {acquireNbaJobLock, NbaJobLockBusyError} from './nba-job-lock.js'

const exec=promisify(execFile)
const hash=z.string().regex(/^[a-f0-9]{64}$/)
const absolute=z.string().refine(value=>path.isAbsolute(value),'An absolute media path is required')
const clipSchema=z.object({character:z.literal('science'),presenter:z.literal('xiaolu'),fingerprint:hash,
  videoPath:absolute,videoSha256:hash,avatarId:z.string().regex(/^xiaolu[-_][A-Za-z0-9_-]{1,120}$/),referenceSha256:hash})
const selectionSchema=clipSchema.extend({version:z.literal(1),jobId:z.string().min(1),initialSourceSha256:hash,selectedAt:z.string().datetime()})
export interface SciencePresenterPolicy {version:1;character:'science';presenter:'xiaolu';libraryPath:string}
export type SciencePresenterIntroSelection=z.infer<typeof selectionSchema>
export interface SciencePresenterIntroInput {jobId:string;sourceSha256:string;libraryPath:string;directory:string}

/** Snapshot for new jobs or untouched legacy drafts; started jobs retain their policy. */
export function sciencePresenterPolicyFromEnv(env:NodeJS.ProcessEnv=process.env):SciencePresenterPolicy|undefined {
  const enabled=env.SCIENCE_PRESENTER_LIBRARY_ENABLED?.trim()
  if(!enabled||['0','false'].includes(enabled))return undefined
  if(!['1','true'].includes(enabled))throw Error('SCIENCE_PRESENTER_LIBRARY_ENABLED must be 1 or 0')
  const libraryPath=env.SCIENCE_PRESENTER_LIBRARY_PATH?.trim()
  if(!libraryPath||!path.isAbsolute(libraryPath))throw Error('SCIENCE_PRESENTER_LIBRARY_PATH must be an absolute ready library path')
  return {version:1,character:'science',presenter:'xiaolu',libraryPath:path.resolve(libraryPath)}
}
async function readOptional(filename:string) {
  try{return JSON.parse(await fs.readFile(filename,'utf8'))}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
async function save(filename:string,value:unknown) {
  const temporary=`${filename}.${randomUUID()}.tmp`,handle=await fs.open(temporary,'wx',0o600)
  try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync()}finally{await handle.close()}
  try{await fs.rename(temporary,filename)}finally{await fs.rm(temporary,{force:true})}
}
async function fileHash(filename:string,signal:AbortSignal) {
  const info=await fs.stat(filename)
  if(!info.isFile()||!info.size)throw Error('Reviewed Xiaolu clip is missing or empty')
  const digest=createHash('sha256')
  for await(const chunk of createReadStream(filename,{signal}))digest.update(chunk)
  return digest.digest('hex')
}
async function verifyMedia(clip:z.infer<typeof clipSchema>,signal:AbortSignal) {
  if(await fileHash(clip.videoPath,signal)!==clip.videoSha256)throw Error('Reviewed Xiaolu video hash changed; restore the original clip')
  const {stdout}=await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',clip.videoPath],{signal,timeout:60_000})
  const media=JSON.parse(stdout),video=media.streams?.find((stream:any)=>stream.codec_type==='video')
  const duration=Number(video?.duration??media.format?.duration)
  const rotation=Number(video?.side_data_list?.find((item:any)=>item.rotation!==undefined)?.rotation||0)
  if(!video||!Number.isFinite(duration)||duration<=0||video.width*9!==video.height*16||rotation%360!==0
    ||!media.streams.some((stream:any)=>stream.codec_type==='audio'))throw Error('Ready Xiaolu clips must have a positive duration, landscape 16:9 and contain audio')
}
async function lock(filename:string,signal:AbortSignal) {
  for(let attempt=0;;attempt++) {
    signal.throwIfAborted()
    try{return acquireNbaJobLock(filename)}
    catch(error){if(!(error instanceof NbaJobLockBusyError)||attempt>=100)throw error;await delay(100,undefined,{signal})}
  }
}
function same(left:SciencePresenterIntroSelection,right:SciencePresenterIntroSelection) {
  return JSON.stringify(selectionSchema.parse(left))===JSON.stringify(selectionSchema.parse(right))
}

export async function selectSciencePresenterIntro(input:SciencePresenterIntroInput,options:{signal:AbortSignal}):Promise<SciencePresenterIntroSelection> {
  const {signal}=options;signal.throwIfAborted()
  hash.parse(input.sourceSha256)
  if(!/^science-[A-Za-z0-9-]{1,100}$/.test(input.jobId))throw Error('Invalid science job binding')
  const libraryPath=absolute.parse(input.libraryPath),directory=path.resolve(input.directory)
  await fs.mkdir(directory,{recursive:true})
  const release=await lock(`${libraryPath}.selection.lock`,signal)
  try {
    const library=await readOptional(libraryPath)
    if(library?.version!==1||library.character!=='science'||library.presenter!=='xiaolu'||!Array.isArray(library.clips))throw Error('An approved science/Xiaolu ready library is required')
    const choices=library.clips.filter((clip:any)=>clip?.status==='ready').map((clip:unknown)=>clipSchema.parse(clip)) as Array<z.infer<typeof clipSchema>>
    if(new Set(choices.map(clip=>clip.fingerprint)).size!==choices.length)throw Error('Duplicate reviewed Xiaolu clip fingerprints')
    const stateFile=`${libraryPath}.selection-state.json`,selectionFile=path.join(directory,'science-presenter-selection.json')
    const priorState=await readOptional(stateFile)
    if(priorState&&(priorState.version!==1||!priorState.selections||typeof priorState.selections!=='object'||Array.isArray(priorState.selections)))throw Error('Xiaolu selection state is invalid; restore the original state')
    const state:{version:1;lastFingerprint?:string;selections:Record<string,SciencePresenterIntroSelection>}=priorState||{version:1,selections:{}}
    const mirror=await readOptional(selectionFile),reservation=state.selections[input.jobId]
    const previous=mirror||reservation
    if(previous) {
      const selected=selectionSchema.parse(previous),reviewed=choices.find(clip=>clip.fingerprint===selected.fingerprint)
      if(selected.jobId!==input.jobId)throw Error('Original science job binding changed')
      if(!reviewed||Object.entries(reviewed).some(([key,value])=>(selected as any)[key]!==value))throw Error('Original job clip was withdrawn or its Xiaolu identity binding changed')
      if(mirror&&reservation&&!same(selected,reservation))throw Error('Original job selection and durable reservation disagree')
      await verifyMedia(reviewed,signal)
      if(!reservation){state.selections[input.jobId]=selected;await save(stateFile,state)}
      if(!mirror)await save(selectionFile,selected)
      return selected
    }
    if(!choices.length)throw Error('No reviewed ready Xiaolu intro exists; continue the original job after approval')
    for(const clip of choices)await verifyMedia(clip,signal)
    const alternatives=choices.filter(clip=>clip.fingerprint!==state.lastFingerprint),eligible=alternatives.length?alternatives:choices
    const selected:SciencePresenterIntroSelection={...eligible[randomInt(eligible.length)]!,version:1,jobId:input.jobId,initialSourceSha256:input.sourceSha256,selectedAt:new Date().toISOString()}
    signal.throwIfAborted()
    // One atomic reservation advances the cursor and fixes the job before its mirror is written.
    state.selections[input.jobId]=selected;state.lastFingerprint=selected.fingerprint
    await save(stateFile,state);await save(selectionFile,selected)
    return selected
  } finally{release()}
}
