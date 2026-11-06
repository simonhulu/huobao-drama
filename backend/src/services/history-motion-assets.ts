import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFile, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {getImageGenerationState,resetImageGenerationForRetry} from './image-generation.js'

const exec = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const soundRoot = process.env.HISTORY_MOTION_SFX_ROOT || path.join(os.homedir(), 'Downloads', '2174款剪映音效库')
export const assetHash = (value:string) => createHash('sha256').update(value).digest('hex')
export const isPendingImageGenerationError = (error:unknown) => (error as {code?:string})?.code === 'image_generation_pending'
export async function motionFileHash(filename:string) {
  const hash=createHash('sha256')
  for await(const chunk of fs.createReadStream(filename))hash.update(chunk)
  return hash.digest('hex')
}
export async function probeMotionVideo(filename:string) {
  const {stdout}=await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',filename],{timeout:15000,maxBuffer:1024*1024})
  const info=JSON.parse(stdout),video=info.streams?.find((stream:any)=>stream.codec_type==='video')
  const duration=Number(video?.duration || info.format?.duration)
  if(!video || !(duration>0) || !(video.width>0 && video.height>0))throw Error('素材没有可读取的视频画面')
  return {duration,width:Number(video.width),height:Number(video.height)}
}

export async function prepareMotionImage(input:{prompt:string;directory:string;shotId:string;profile:'16:9'|'9:16'}) {
  const key=assetHash(JSON.stringify([input.prompt,input.profile]))
  const directory=path.join(input.directory,'images',key)
  fs.mkdirSync(directory,{recursive:true})
  const request=path.join(directory,'request.json'),resultFile=path.join(directory,'result.json')
  if(fs.existsSync(resultFile)) {
    const saved=JSON.parse(fs.readFileSync(resultFile,'utf8'))
    if(saved.path && fs.existsSync(saved.path) && await motionFileHash(saved.path)===saved.sha256)return saved
  }
  fs.writeFileSync(request,JSON.stringify({prompt:input.prompt,profile:input.profile,directory}))
  // Only this worker's failure may authorize a different image request.
  const errorFile=path.join(directory,'error.json')
  fs.rmSync(errorFile,{force:true})
  const timeout=Math.max(10000,Math.min(1800000,Number(process.env.HISTORY_MOTION_IMAGE_TIMEOUT_MS)||600000))
  // A bounded child owns the provider call, so a timeout cannot leave background image work running.
  await new Promise<void>((resolve,reject)=>{
    const log=fs.openSync(path.join(directory,'image.log'),'a')
    const child=spawn(process.execPath,['--import','tsx','scripts/history-motion-image.ts',request],{
      cwd:path.join(projectRoot,'backend'),env:{...process.env,TASK_WORKER_DISABLED:'1'},stdio:['ignore',log,log],
    })
    fs.closeSync(log)
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',(code,signal)=>{
      clearTimeout(timer)
      if(code===0)resolve()
      else {
        // A provider task id identifies the request that the killed poller can
        // no longer own. It is cleared below so the next retry can resubmit.
        let generationId: number | undefined
        let generationState: ReturnType<typeof getImageGenerationState> | null = null
        try {
          const checkpoint = JSON.parse(fs.readFileSync(path.join(directory,'generation.json'),'utf8'))
          generationId = Number(checkpoint.id)
          generationState = Number.isSafeInteger(generationId) ? getImageGenerationState(generationId) : null
        } catch { /* The child may have been killed before its checkpoint was written. */ }
        if (signal === 'SIGKILL' && generationId && generationState?.status === 'processing' && generationState.taskId) {
          // The killed local poller cannot resume this remote task. Clear the
          // stale id so the next production retry submits a fresh request.
          resetImageGenerationForRetry(generationId, `Local image wait exceeded ${Math.round(timeout/1000)} seconds; retrying with a new request`)
          reject(Object.assign(
            Error(`图片生成超过 ${Math.round(timeout/1000)} 秒，已结束旧请求；下次继续制作时会重新提交`),
            {code: 'image_generation_pending', generationId, taskId: generationState.taskId, resubmit: true},
          ))
          return
        }
        let detail='图片生成失败',errorCode:string|undefined
        try {
          const failure=JSON.parse(fs.readFileSync(errorFile,'utf8'))
          detail=failure.message || detail
          if(typeof failure.code==='string')errorCode=failure.code
        } catch { /* A killed worker may not have written a diagnostic. */ }
        const error=Error(signal==='SIGKILL'?`图片生成超过 ${Math.round(timeout/1000)} 秒，已结束等待`:String(detail).slice(0,300))
        reject(errorCode && !signal ? Object.assign(error,{code:errorCode}) : error)
      }
    })
  })
  const result=JSON.parse(fs.readFileSync(resultFile,'utf8'))
  if(!result.path || !fs.existsSync(result.path) || await motionFileHash(result.path)!==result.sha256)throw Error('生成图片文件缺失或已变化')
  return result as {path:string;sha256:string}
}

const catalogCache=new Map<string,string[]>()
export function motionSoundCatalog(root=soundRoot) {
  if(catalogCache.has(root))return catalogCache.get(root)!
  const result:string[]=[]
  const walk=(directory:string)=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if(entry.isSymbolicLink())continue
      const filename=path.join(directory,entry.name)
      if(entry.isDirectory())walk(filename)
      else if(entry.isFile() && /\.(mp3|wav|m4a|aac|ogg)$/i.test(entry.name))result.push(filename)
    }
  }
  if(fs.existsSync(root))walk(root)
  result.sort((a,b)=>a.localeCompare(b,'zh-CN'));catalogCache.set(root,result)
  return result
}
const soundAliases:[RegExp,string[]][]=[
  [/地图|路线|移动|转场|揭示|出现/,['轻呼','嗖','咻','刷子']],
  [/战鼓|鼓声|战场|进攻/,['战鼓','鼓','号角']],
  [/冲击|转折|强调|结论/,['低沉','冲击','厚重','电影']],
  [/悬疑|秘密|疑问|真相/,['悬疑','紧张','惊悚']],
  [/纸|文献|书|档案/,['翻书','翻页','纸张']],
  [/环境|风|山|野外/,['风声','微风','山风']],
]
export function selectMotionSound(query:string,root=soundRoot) {
  const terms=[...new Set([...query.split(/[\s，,、]+/).filter(Boolean),...soundAliases.filter(([match])=>match.test(query)).flatMap(([,values])=>values)])]
  const unrelatedVocals=/笑声|哭声|呻吟|喘息|人声|对白|说话|语音|台词/
  const unrelatedFantasy=/科幻|激光|魔法/
  const ranked=motionSoundCatalog(root).map(filename=>{
    const relative=path.relative(root,filename)
    if(unrelatedVocals.test(relative) && !unrelatedVocals.test(query) || unrelatedFantasy.test(relative) && !unrelatedFantasy.test(query))return {filename,score:0}
    const name=path.basename(filename,path.extname(filename))
    const score=terms.reduce((score,term)=>score+(name.includes(term)?term.length:0),0)
    const transition=score>0 && /转场|揭示|冲击|转折|强调/.test(query) && /转场/.test(relative)
    return {filename,score:score+(transition?3:0)}
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score || a.filename.localeCompare(b.filename,'zh-CN'))
  return ranked[0]?.filename || null
}
export async function prepareMotionSound(input:{query:string;directory:string;duration:number;root?:string}) {
  const source=selectMotionSound(input.query,input.root)
  if(!source)throw Error(`音效库没有匹配“${input.query}”的声音`)
  const stat=fs.statSync(source),duration=Math.max(.1,Math.min(8,input.duration))
  const key=assetHash(JSON.stringify([source,stat.size,stat.mtimeMs,duration]))
  const directory=path.join(input.directory,'sounds'),filename=path.join(directory,`${key}.wav`)
  fs.mkdirSync(directory,{recursive:true})
  if(!fs.existsSync(filename)) {
    const partial=path.join(directory,`${key}.partial.wav`)
    try {
      await exec('ffmpeg',['-v','error','-y','-i',source,'-t',String(duration),'-vn','-af','loudnorm=I=-24:TP=-5:LRA=7','-ar','48000','-ac','2',partial],{timeout:20000})
      fs.renameSync(partial,filename)
    } finally {fs.rmSync(partial,{force:true})}
  }
  const {stdout}=await exec('ffprobe',['-v','error','-show_format','-of','json',filename],{timeout:10000})
  const actual=Number(JSON.parse(stdout).format?.duration)
  if(!(actual>0))throw Error('音效无法读取')
  return {sourcePath:filename,duration:actual,sha256:await motionFileHash(filename),sourceName:path.basename(source)}
}
