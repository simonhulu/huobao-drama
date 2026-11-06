import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {and,asc,desc,eq,gt,isNull} from 'drizzle-orm'
import {db,schema} from '../db/index.js'
import {createHistoryMotionProduction,hashText,inside,sourceRevision,textContent,isTransientMotionError,type HistoryMotionProduction,type MotionJob} from './history-motion-production.js'
import {createMotionRunner,type MotionPipelineDependencies} from './history-motion-pipeline.js'
import {associateMotionDelivery,type MotionDeliveryOptions} from './history-motion-delivery.js'
import {getHistorySource,requireCurrentHistoryScript,type HistorySource} from './history-script-library.js'
import {listProjectRenderArtifacts} from './render-artifacts.js'
import {condenseHistoryScript} from './history-script-recreation.js'
import {historyScriptCondensationRecord,needsHistoryScriptCondensation,prepareHistorySourceScript} from './history-script-preparation.js'

const exec=promisify(execFile)
const repoRoot=fileURLToPath(new URL('../../../',import.meta.url))
const now=()=>new Date().toISOString()
function record(value:string|null|undefined):Record<string,any>{try{return JSON.parse(value || '{}')}catch{return {}}}
const sourceUrl=(id:number)=>`/history-scripts?script=${id}&view=library`
export interface HistoryFactoryOptions {
  production?:HistoryMotionProduction
  pipeline?:Partial<MotionPipelineDependencies>
  runnerFactory?:typeof createMotionRunner
  delivery?:MotionDeliveryOptions
  storageRoot?:string
  probeAudio?:(filename:string)=>Promise<number>
  condenseScript?:typeof condenseHistoryScript
  sourceStorageRoot?:string
}
type EpisodeStartInput={profile?:MotionJob['profile'];retry?:boolean;rebuild?:boolean;voiceId?:string}

/** One runner and one durable job. Episode and Remotion rows are projections of it. */
export function createHistoryFactory(options:HistoryFactoryOptions={}) {
  const storageRoot=path.resolve(options.storageRoot || process.env.STORAGE_PATH || path.join(repoRoot,'data/static'))
  const base=options.production || createHistoryMotionProduction()
  const projected=new Map<string,string>()
  const activeStarts=new Map<number,Promise<any>>()
  function episode(id:number,includeDeletedProduction=false) {
    const value=db.select().from(schema.episodes).where(and(eq(schema.episodes.id,id),isNull(schema.episodes.deletedAt))).get()
    if(!value || !includeDeletedProduction && record(value.metadata).historyFactory?.deletedAt)throw Error('工作不存在或已删除')
    return value
  }
  function remove(id:number) {
    const ep=episode(id,true),metadata=record(ep.metadata),meta=metadata.historyFactory || {}
    if(meta.deletedAt)return {episodeId:id,deleted:true}
    const jobs=base.list().filter(job=>job.factory?.episodeId===id)
    const current=meta.jobId?base.find(meta.jobId):null
    if(current && !jobs.some(job=>job.id===current.id))jobs.push(current)
    if(activeStarts.has(id) || jobs.some(job=>runner.isRunning(job.id) || ['queued','planning','selecting','rendering','validating'].includes(job.status))) {
      throw Object.assign(Error('任务正在排队或制作中，完成后才可删除'),{status:409})
    }
    const ts=now()
    db.update(schema.episodes).set({metadata:JSON.stringify({...metadata,historyFactory:{...meta,deletedAt:ts}}),updatedAt:ts}).where(eq(schema.episodes.id,id)).run()
    return {episodeId:id,deleted:true}
  }
  function boards(id:number){return db.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId,id),isNull(schema.storyboards.deletedAt))).orderBy(asc(schema.storyboards.storyboardNumber)).all()}
  function legacyArtifacts() {
    const dir=path.join(storageRoot,'remotion'),byEpisode=new Map<number,{id:string;url:string;createdAt:string;kind:string;filename:string}[]>()
    if(!fs.existsSync(dir))return byEpisode
    for(const filename of fs.readdirSync(dir)) {
      const match=/^grid-story-ep(\d+)(?:-[^/]*)?\.mp4$/.exec(filename)
      if(!match)continue
      const id=Number(match[1]),items=byEpisode.get(id) || []
      items.push({id:`legacy-${filename}`,url:`/static/remotion/${filename}`,createdAt:fs.statSync(path.join(dir,filename)).mtime.toISOString(),kind:'legacy',filename});byEpisode.set(id,items)
    }
    for(const items of byEpisode.values())items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
    return byEpisode
  }
  function localStatic(url:string) {
    const relative=url.replace(/^\/?static\//,'')
    if(relative===url || !relative || relative.includes('\0'))throw Error('已有媒体必须使用本地 static 文件')
    const filename=fs.realpathSync(path.resolve(storageRoot,relative))
    if(!inside(fs.realpathSync(storageRoot),filename)||!fs.statSync(filename).isFile())throw Error('已有媒体路径无效')
    return filename
  }
  function projectFor(ep:ReturnType<typeof episode>,job:MotionJob) {
    const existing=job.factory?.projectId && db.select().from(schema.remotionProjects).where(eq(schema.remotionProjects.id,job.factory.projectId)).get()
    if(existing)return existing.id
    const drama=db.select().from(schema.dramas).where(eq(schema.dramas.id,ep.dramaId)).get()!
    const ts=now()
    // This entry has already locked the manuscript. It does not invoke the old
    // smart splitter, account-positioning planner or image-only factory.
    return db.insert(schema.remotionProjects).values({slug:`history-factory-${job.id}`,sourceType:'episode',sourceEpisodeId:ep.id,
      sourceDramaId:ep.dramaId,mediaAccountId:drama.mediaAccountId,title:ep.title,sourceHash:job.scriptRevision,
      sourceSnapshotJson:JSON.stringify({schemaVersion:1,sourceType:'episode',sourceEpisodeId:ep.id,sourceDramaId:ep.dramaId,drama,episode:ep,storyboards:boards(ep.id)}),
      metadataJson:JSON.stringify({factory:'remotion-history-factory',jobId:job.id,scriptHash:hashText(job.script)}),
      status:'planning',currentStage:'source_snapshot',createdAt:ts,updatedAt:ts}).returning({id:schema.remotionProjects.id}).get().id
  }
  function sync(job:MotionJob) {
    const link=job.factory
    if(!link)return
    const ep=db.select().from(schema.episodes).where(and(eq(schema.episodes.id,link.episodeId),isNull(schema.episodes.deletedAt))).get()
    if(!ep)return
    const ts=now(),shots=job.plan?.shots || [],ready=Object.keys(job.plan?.visuals || {}).length
    db.update(schema.remotionProjects).set({status:job.status==='completed'?'completed':job.status==='failed'?'failed':job.status==='rendering'?'rendering':job.status==='validating'?'qa':job.status==='selecting'?'assets':'planning',
      currentStage:job.stage,progressCurrent:ready,progressTotal:job.requested.shots.length,progressMessage:job.message,
      errorMessage:job.error,updatedAt:ts,completedAt:job.status==='completed'?ts:null}).where(eq(schema.remotionProjects.id,link.projectId)).run()
    const narrationFile=path.join(base.root,job.id,'narration.json')
    if(fs.existsSync(narrationFile)) {
      const voice=record(fs.readFileSync(narrationFile,'utf8'))
      const requestedVoice=job.plan?.narrationRequest?.voiceId
      if((!ep.preTtsAudioUrl || requestedVoice && voice.audioSettings?.voiceId===requestedVoice) && voice.script===job.script && voice.audioPath && fs.existsSync(voice.audioPath)) {
        const sha=createHash('sha256').update(fs.readFileSync(voice.audioPath)).digest('hex')
        const name=`history-${job.id}-${sha.slice(0,12)}${path.extname(voice.audioPath) || '.m4a'}`,target=path.join(storageRoot,'audio',name)
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(voice.audioPath,target)
        db.update(schema.episodes).set({preTtsAudioUrl:`/static/audio/${name}`,preTtsTitlesJson:voice.titles?.length?JSON.stringify(voice.titles):null,
          ...(voice.audioSettings?.voiceId?{narrationVoiceId:voice.audioSettings.voiceId}:{}),duration:Math.round(voice.duration),updatedAt:ts}).where(eq(schema.episodes.id,ep.id)).run()
      }
    }
    if(!shots.length)return
    const digest=hashText(JSON.stringify(shots))
    if(projected.get(job.id)===digest)return
    db.transaction(tx=>{
      tx.update(schema.remotionShots).set({deletedAt:ts,updatedAt:ts})
        .where(and(eq(schema.remotionShots.projectId,link.projectId),gt(schema.remotionShots.shotNumber,shots.length),isNull(schema.remotionShots.deletedAt))).run()
      shots.forEach((shot:any,index:number)=>{
        const values={projectId:link.projectId,shotNumber:index+1,sourceStoryboardId:link.seedShots?.find(s=>s.shotId===shot.shotId)?.storyboardId || null,
          narration:shot.narration,durationMs:Math.round(shot.duration*1000),shotType:shot.visualType==='video'?'stock':shot.visualType==='image'?'ai_plate':shot.visualType || 'hybrid',
          title:shot.purpose || null,visualPlanJson:JSON.stringify(shot),sourceEvidenceJson:JSON.stringify({...shot.sourceEvidence,candidate:job.candidates[shot.shotId]?.find(c=>c.assetId===shot.assetId),map:shot.map?.provenance,sourceNote:shot.sourceNote,visualReview:shot.sourceEvidence?.visualEvidence?.status || 'not_performed'}),status:'ready',createdAt:ts,updatedAt:ts,deletedAt:null}
        tx.insert(schema.remotionShots).values(values).onConflictDoUpdate({target:[schema.remotionShots.projectId,schema.remotionShots.shotNumber],set:{...values,createdAt:undefined}}).run()
      })
    })
    projected.set(job.id,digest)
  }
  const production:HistoryMotionProduction={...base,write(job){const saved=base.write(job);sync(saved);return saved}}
  function assertCurrent(job:MotionJob) {
    if(job.factory) {
      const ep=episode(job.factory.episodeId)
      if(record(ep.metadata).historyFactory?.jobId!==job.id)throw Error('当前制作版本已变化，旧任务已保留，不再自动执行')
      if(hashText(ep.scriptContent || ep.content || '')!==job.factory.scriptHash)throw Error('正文已更新，请为当前正文开始新制作')
    }
    if(job.scriptId>0) {
      const source=getHistorySource(job.scriptId)
      if(!source)throw Error('来源稿件已删除')
      if(requireCurrentHistoryScript(source)!==job.script)throw Error('来源稿件已更新；已保留成片，请为新正文开始制作')
    }
  }
  async function deliver(job:MotionJob,output:{filename:string;sha256:string}) {
    assertCurrent(job)
    if(!job.factory)return associateMotionDelivery(job,output,options.delivery,()=>assertCurrent(job))
    const link=job.factory,ts=now(),filename=`history-${job.id}-${output.sha256.slice(0,12)}.mp4`,target=path.join(storageRoot,'remotion',filename),url=`/static/remotion/${filename}`
    fs.mkdirSync(path.dirname(target),{recursive:true})
    if(!fs.existsSync(target))fs.copyFileSync(output.filename,target)
    // Register the new render without deleting or overwriting earlier editions.
    const existing=db.select().from(schema.remotionRenders).where(and(eq(schema.remotionRenders.projectId,link.projectId),eq(schema.remotionRenders.inputHash,output.sha256))).get()
    if(!existing)db.insert(schema.remotionRenders).values({projectId:link.projectId,renderKind:'episode',status:'succeeded',inputHash:output.sha256,
      outputPath:target,outputUrl:url,width:job.plan?.width,height:job.plan?.height,fps:job.plan?.fps,durationMs:Math.round((job.plan?.durationInFrames || 0)/30*1000),
      qaJson:JSON.stringify(job.plan?.delivery || {}),propsJson:JSON.stringify({jobId:job.id}),createdAt:ts,updatedAt:ts,completedAt:ts}).run()
    let previewUrl:string|null=null
    const preview=job.plan?.delivery?.preview
    if(typeof preview==='string' && fs.existsSync(preview)) {
      const real=fs.realpathSync(preview),directory=fs.realpathSync(path.join(base.root,job.id))
      if(!inside(directory,real))throw Error('精选片段不在当前任务目录中')
      const previewName=filename.replace(/\.mp4$/,'-preview.mp4'),previewTarget=path.join(storageRoot,'remotion',previewName)
      previewUrl=`/static/remotion/${previewName}`
      if(!fs.existsSync(previewTarget))fs.copyFileSync(real,previewTarget)
      const registered=db.select().from(schema.remotionRenders).where(and(eq(schema.remotionRenders.projectId,link.projectId),eq(schema.remotionRenders.outputUrl,previewUrl))).get()
      if(!registered)db.insert(schema.remotionRenders).values({projectId:link.projectId,renderKind:'preview',status:'succeeded',inputHash:output.sha256,outputPath:previewTarget,outputUrl:previewUrl,
        width:job.plan?.width,height:job.plan?.height,fps:30,qaJson:JSON.stringify({sound:'preserved',range:job.plan?.delivery?.previewRange}),createdAt:ts,updatedAt:ts,completedAt:ts}).run()
    }
    const reportUrl=`/static/remotion/${filename}.json`
    fs.writeFileSync(`${target}.json`,JSON.stringify({jobId:job.id,scriptHash:link.scriptHash,report:job.plan?.delivery,shots:job.plan?.shots,candidates:job.candidates,fallbacks:job.plan?.fallbacks},
      (key,value)=>['sourcePath','localPath','imagePath','audioPath','backgroundSrc','manifestPath'].includes(key)?undefined:typeof value==='string' && path.isAbsolute(value) && !value.startsWith('/static/')?path.basename(value):value,2))
    db.update(schema.remotionProjects).set({finalVideoUrl:url,updatedAt:ts}).where(eq(schema.remotionProjects.id,link.projectId)).run()
    const ep=episode(link.episodeId)
    if(!ep.videoUrl)db.update(schema.episodes).set({videoUrl:url,status:'completed',updatedAt:ts}).where(eq(schema.episodes.id,ep.id)).run()
    const history=link.sourceId?await associateMotionDelivery(job,output,options.delivery,()=>assertCurrent(job)):null
    return {status:history?.status || (ep.videoUrl && ep.videoUrl!==url?'existing_preserved':'attached'),videoUrl:url,previewUrl,evidenceUrl:reportUrl,sourceDelivery:history,outputSha256:output.sha256,checkedAt:ts,
      message:history?.message || (ep.videoUrl && ep.videoUrl!==url?'新成片已登记，已保留本集原成片':'成片已登记到本集与 Remotion')}
  }
  const runner=(options.runnerFactory || createMotionRunner)(production,{...options.pipeline,assertCurrent,deliver:options.pipeline?.deliver || deliver})
  function recoverPending() {
    for(const job of base.listRecoverable()) {
      if(runner.isRunning(job.id) || job.status==='failed' && !isTransientMotionError(job.error))continue
      if(job.retry && Date.parse(job.retry.nextAttemptAt)>Date.now())continue
      try {
        if(job.factory) {
          const ep=episode(job.factory.episodeId,true),meta=record(ep.metadata).historyFactory || {}
          if(meta.deletedAt || meta.jobId!==job.id || activeStarts.has(ep.id))continue
        }
        assertCurrent(job)
        job.status='queued';job.error=null;job.message='已自动恢复制作，继续使用已保存配音和画面'
        production.write(job)
        runner.schedule(job.id,job.outputPath && job.stage==='rendered'?'deliver':'full')
      }catch(error) {
        job.status='failed';job.error=(error as Error).message;job.message='此任务需处理，其他任务继续制作'
        production.write(job)
      }
    }
  }
  async function seedAudio(job:MotionJob,ep:ReturnType<typeof episode>) {
    if(!ep.preTtsAudioUrl)return
    const directory=path.join(base.root,job.id),cache=path.join(directory,'narration.json')
    if(fs.existsSync(cache))return
    const audioPath=localStatic(ep.preTtsAudioUrl)
    const titles=ep.preTtsTitlesJson?JSON.parse(ep.preTtsTitlesJson):undefined
    if(titles?.length && textContent(titles.map((t:any)=>t.text).join(''))!==textContent(job.script))throw Error('已有配音时间码与正文不一致，请在原稿页面确认母带')
    const duration=options.probeAudio?await options.probeAudio(audioPath):Number(JSON.parse((await exec('ffprobe',['-v','error','-show_format','-of','json',audioPath],{timeout:15000})).stdout).format?.duration)
    if(!(duration>0))throw Error('无法读取已有配音母带')
    fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(cache,JSON.stringify({script:job.script,audioPath,duration,titles,reusedFromEpisode:ep.id},null,2))
  }
  async function attach(job:MotionJob,ep:ReturnType<typeof episode>,sourceId?:number) {
    job.factory ||= {episodeId:ep.id,projectId:projectFor(ep,job),sourceId,scriptHash:hashText(job.script)}
    const storyboards=boards(ep.id)
    if(storyboards.length && textContent(storyboards.map(s=>s.narration || '').join(''))===textContent(job.script)) {
      job.factory.seedShots=storyboards.map(s=>({shotId:`storyboard-${s.id}`,storyboardId:s.id,narration:s.narration || '',duration:s.duration || 1}))
      job.factory.fallbackImages={}
      for(const board of storyboards) {
        const image=board.composedImage || board.firstFrameImage
        if(image)try {const filename=localStatic(image);job.factory.fallbackImages[`storyboard-${board.id}`]={imagePath:filename,imageSha256:createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}}catch{ /* Unreadable old artwork is replaced only when needed. */ }
      }
    }
    const metadata={...record(ep.metadata),historyFactory:{jobId:job.id,projectId:job.factory.projectId,sourceId:sourceId || null,scriptHash:hashText(job.script)}}
    db.update(schema.episodes).set({metadata:JSON.stringify(metadata),updatedAt:now()}).where(eq(schema.episodes.id,ep.id)).run()
    production.write(job)
    try {await seedAudio(job,ep)}catch(error){job.status='failed';job.error=(error as Error).message;job.message='已有配音尚未匹配，未启动制作';production.write(job);throw error}
    return job
  }
  async function prepareEpisode(ep:ReturnType<typeof episode>) {
    const script=ep.scriptContent || ep.content || '',metadata=record(ep.metadata),sourceId=metadata.historyFactory?.sourceId
    if(!needsHistoryScriptCondensation(script,metadata))return ep
    let result
    if(sourceId) {
      const source=getHistorySource(Number(sourceId))
      if(!source)throw Error('来源稿件已删除')
      if(requireCurrentHistoryScript(source)!==script && record(source.reviewJson).scriptCondensation?.previousScriptSha256!==hashText(script)) {
        throw Error('本集正文与来源稿件不一致，请从来源稿件创建当前版本')
      }
      const prepared=await prepareHistorySourceScript(source,{condense:options.condenseScript,storageRoot:options.sourceStorageRoot})
      result={...record(prepared.reviewJson).recreation,script:requireCurrentHistoryScript(prepared)}
    } else result=await (options.condenseScript || condenseHistoryScript)(script,{sourceTitle:ep.title})
    const current=episode(ep.id)
    if((current.scriptContent || current.content || '')!==script)throw Error('缩写期间正文已更新，未覆盖新稿')
    if(sourceId && requireCurrentHistoryScript(getHistorySource(Number(sourceId))!)!==result.script)throw Error('来源稿件已更新，请刷新后继续')
    if(result.script===script) {
      return db.update(schema.episodes).set({metadata:JSON.stringify({...record(current.metadata),
        scriptCondensation:historyScriptCondensationRecord(script,result)}),updatedAt:now()})
        .where(eq(schema.episodes.id,ep.id)).returning().get()!
    }
    return db.update(schema.episodes).set({scriptContent:result.script,content:result.script,
      preTtsAudioUrl:null,preTtsTitlesJson:null,duration:0,
      metadata:JSON.stringify({...record(current.metadata),scriptCondensation:{...historyScriptCondensationRecord(script,result),
        previousAudioUrl:current.preTtsAudioUrl,previousTitlesJson:current.preTtsTitlesJson}}),updatedAt:now()})
      .where(eq(schema.episodes.id,ep.id)).returning().get()!
  }
  async function startEpisodeInner(id:number,input:EpisodeStartInput={}):Promise<ReturnType<typeof detail>> {
    let ep=episode(id),script=ep.scriptContent || ep.content || ''
    if(!script.trim())throw Error('请先保存已确认正文')
    const meta=record(ep.metadata).historyFactory || {}
    let job=meta.jobId?base.find(meta.jobId):null
    if(!job?.outputPath) {
      if(job && runner.isRunning(job.id) && needsHistoryScriptCondensation(script,record(ep.metadata)))throw Error('当前制作正在运行，请完成后再缩写正文')
      ep=await prepareEpisode(ep)
      script=ep.scriptContent || ep.content || ''
    }
    if(input.rebuild) {
      if(!job)throw Error('当前没有可重做的已完成成片')
      if(runner.isRunning(job.id))throw Error('当前制作正在运行，请稍后再试')
      if(job.status!=='completed' || !job.outputPath || !job.plan?.delivery)throw Error('只有已完成作品可以重做现稿；失败任务请使用重试')
      assertCurrent(job)
    }
    const profile=(input.retry || input.rebuild) && job?job.profile:input.profile || (ep.aspectRatio==='9:16'?'9:16':'16:9')
    if(job && job.script===script && job.profile===profile) {
      if(runner.isRunning(job.id))return detail(id)
      if(job.status==='completed' && !input.rebuild){if(input.voiceId)throw Error('更换已完成作品的音色请使用重做');return detail(id)}
      if(job.status==='failed' && !input.retry && !input.rebuild)return detail(id)
      if(input.rebuild && job.status!=='completed')throw Error('只有已完成作品可以重做现稿；失败任务请使用重试')
    } else {
      if(job && runner.isRunning(job.id))throw Error('当前制作正在运行，请完成后再修改制作版本')
      if(meta.sourceId) {
        const source=getHistorySource(Number(meta.sourceId))
        if(!source || requireCurrentHistoryScript(source)!==script)throw Error('本集正文与来源稿件不一致，请从来源稿件创建当前版本')
        job=base.create(source.id,script,ep.title,sourceRevision(source),profile)
        if(job.factory && job.factory.episodeId!==ep.id)return startEpisode(job.factory.episodeId,{profile,retry:input.retry})
        await attach(job,ep,source.id)
      } else {
        job=base.create(-id,script,ep.title,hashText(JSON.stringify({episodeId:id,script,profile})),profile)
        await attach(job,ep)
      }
    }
    assertCurrent(job)
    await seedAudio(job,ep)
    if(input.rebuild) {
      if(job.status!=='completed' || !job.outputPath || !job.plan?.delivery)throw Error('当前没有可重做的已完成成片')
      if(!job.plan.audioPath || !fs.existsSync(job.plan.audioPath))throw Error('原配音母带不可读取，已保留旧成片；请先恢复母带')
      const narration=record(fs.readFileSync(path.join(base.root,job.id,'narration.json'),'utf8'))
      if(narration.script!==job.script)throw Error('配音缓存与已确认正文不一致，已保留旧成片')
      const prior={version:(job.plan.revisions?.length || 0)+1,savedAt:now(),outputPath:job.outputPath,
        delivery:job.plan.delivery,deliveryAssociation:job.plan.deliveryAssociation,automaticDelivery:job.plan.automaticDelivery,
        audioPath:job.plan.audioPath,audioSettings:job.plan.audioSettings,
        scriptRevision:job.scriptRevision,profile:job.profile}
      const {delivery: _delivery,deliveryAssociation: _association,automaticDelivery: _automatic,...restPlan}=job.plan
      job.plan={...restPlan,revisions:[...(job.plan.revisions || []),prior]}
      job.outputPath=null;job.status='queued';job.stage='planning';job.error=null;job.message='等待按当前正文重做；旧成片已保留'
      production.write(job)
    }
    if(input.voiceId) {
      job.plan ||= {}
      if(job.outputPath && job.plan.audioSettings?.voiceId!==input.voiceId) {
        const prior={version:(job.plan.revisions?.length || 0)+1,savedAt:now(),outputPath:job.outputPath,
          delivery:job.plan.delivery,deliveryAssociation:job.plan.deliveryAssociation,audioPath:job.plan.audioPath,audioSettings:job.plan.audioSettings,
          scriptRevision:job.scriptRevision,profile:job.profile}
        const {delivery:_delivery,deliveryAssociation:_association,automaticDelivery:_automatic,...rest}=job.plan
        job.plan={...rest,revisions:[...(job.plan.revisions || []),prior]}
        job.outputPath=null;job.stage='planning'
      }
      job.plan.narrationRequest={voiceId:input.voiceId}
    }
    job.status='queued';job.error=null;delete job.retry;job.message=input.rebuild?'等待按当前正文重做；旧成片已保留':job.outputPath?'等待登记已有成片':'等待继续制作';production.write(job)
    runner.schedule(job.id,job.outputPath && job.stage==='rendered'?'deliver':'full')
    return detail(id)
  }
  function startEpisode(id:number,input:EpisodeStartInput={}):Promise<ReturnType<typeof detail>> {
    const pending=activeStarts.get(id)
    if(pending)return input.rebuild?Promise.reject(Error('当前制作正在准备，请稍后再试')):pending
    const promise=startEpisodeInner(id,input).finally(()=>activeStarts.delete(id));activeStarts.set(id,promise);return promise
  }
  async function startFromSource(source:HistorySource,input:{profile:MotionJob['profile'];revision?:string;restoreDeleted?:boolean}) {
    if(input.revision && input.revision!==sourceRevision(source))throw Error('稿件版本已变化，请刷新')
    let script=requireCurrentHistoryScript(source),revision=sourceRevision(source)
    const sourceJobs=base.list(source.id)
    let job=sourceJobs.find(j=>j.scriptRevision===revision && j.profile===input.profile)
    // Packaging or source metadata may change without changing the locked narration.
    // A completed standalone output can still be attached; delivery verifies its bytes.
    job ||= sourceJobs.find(j=>!j.factory && j.status==='completed' && j.stage==='rendered' && j.outputPath
      && j.script===script && j.profile===input.profile && j.plan?.delivery?.qa?.technical==='passed')
    if(!job?.outputPath) {
      source=await prepareHistorySourceScript(source,{condense:options.condenseScript,storageRoot:options.sourceStorageRoot})
      script=requireCurrentHistoryScript(source);revision=sourceRevision(source)
      job=base.list(source.id).find(j=>j.scriptRevision===revision && j.profile===input.profile)
    }
    if(job?.factory) {
      const ep=episode(job.factory.episodeId,true),metadata=record(ep.metadata),meta=metadata.historyFactory || {}
      if(meta.deletedAt) {
        if(!input.restoreDeleted)throw Error('制作任务已删除；请从原稿主动开始制作以恢复原任务')
        const {deletedAt:_deletedAt,...rest}=meta
        db.update(schema.episodes).set({metadata:JSON.stringify({...metadata,historyFactory:rest}),updatedAt:now()}).where(eq(schema.episodes.id,ep.id)).run()
      }
      return startEpisode(job.factory.episodeId,{profile:input.profile,retry:job.status==='failed'})
    }
    job ||= base.create(source.id,script,source.title,revision,input.profile)
    const ts=now(),delivery=db.$client.prepare('SELECT title, description FROM history_script_deliveries WHERE script_id=?').get(source.id) as {title:string;description:string}|undefined
    const title=delivery?.title || source.title
    const ep=db.transaction(tx=>{
      const drama=tx.insert(schema.dramas).values({title,videoTitle:title,description:delivery?.description || null,workflowType:'direct_script',style:'historical_documentary',metadata:JSON.stringify({historySourceId:source.id}),createdAt:ts,updatedAt:ts}).returning().get()
      return tx.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title,videoTitle:title,description:delivery?.description || null,content:script,scriptContent:script,workflowType:'direct_script',narrationMode:'original',enableAiRewrite:false,aspectRatio:input.profile,createdAt:ts,updatedAt:ts}).returning().get()
    })
    await attach(job,ep,source.id)
    if(job.status==='completed' && job.outputPath) {
      // Existing standalone output is registered, never re-rendered.
      job.status='queued';production.write(job);runner.schedule(job.id,'deliver')
      return detail(ep.id)
    }
    return startEpisode(ep.id,{profile:input.profile,retry:true})
  }
  function visible(job:MotionJob) {
    const cleanShot=(shot:any)=>({...shot,imagePath:undefined,sourcePath:undefined,hasImage:!!shot.imagePath,hasVideo:!!shot.sourcePath,
      map:shot.map?{...shot.map,backgroundSrc:undefined,provenance:{...shot.map.provenance,manifestPath:undefined}}:undefined})
    return {...job,outputPath:undefined,factory:job.factory?{episodeId:job.factory.episodeId,projectId:job.factory.projectId,sourceId:job.factory.sourceId,scriptHash:job.factory.scriptHash}:undefined,
      episodeId:job.factory?.episodeId,projectId:job.factory?.projectId,
      candidates:Object.fromEntries(Object.entries(job.candidates).map(([key,values])=>[key,values.map(c=>({...c,localPath:undefined}))])),
      plan:job.plan?{...job.plan,audioPath:undefined,visuals:undefined,revisions:job.plan.revisions?.map((revision:any)=>({...revision,outputPath:undefined})),shots:job.plan.shots?.map(cleanShot),soundEffects:job.plan.soundEffects?.map((s:any)=>({...s,sourcePath:undefined}))} as Record<string,any>:null}
  }
  function detail(id:number) {
    const ep=episode(id),meta=record(ep.metadata).historyFactory || {},job=meta.jobId?base.find(meta.jobId):null
    const projects=db.select().from(schema.remotionProjects).where(and(eq(schema.remotionProjects.sourceEpisodeId,id),isNull(schema.remotionProjects.deletedAt))).all()
    const outputs:{id:string;url:string;createdAt:string;kind:string;filename:string}[]=[]
    const add=(value:typeof outputs[number])=>{if(value.url && !outputs.some(o=>o.url===value.url))outputs.push(value)}
    for(const artifact of legacyArtifacts().get(ep.id) || [])add(artifact)
    for(const project of projects) {
      const renders=db.select().from(schema.remotionRenders).where(eq(schema.remotionRenders.projectId,project.id)).orderBy(desc(schema.remotionRenders.id)).all()
      for(const render of renders)if(render.status==='succeeded' && render.outputUrl)add({id:`render-${render.id}`,url:render.outputUrl,createdAt:render.completedAt || render.updatedAt,kind:render.renderKind,filename:render.outputUrl.split('/').pop()!})
      for(const artifact of listProjectRenderArtifacts(project.id,{episodeVideoUrl:ep.videoUrl}))add({id:`artifact-${project.id}-${artifact.name}`,url:artifact.url,createdAt:artifact.mtime,kind:artifact.kind,filename:artifact.name})
      if(project.finalVideoUrl)add({id:`project-${project.id}`,url:project.finalVideoUrl,createdAt:project.updatedAt,kind:'episode',filename:project.finalVideoUrl.split('/').pop()!})
    }
    if(ep.videoUrl)add({id:'episode',url:ep.videoUrl.startsWith('static/')?`/${ep.videoUrl}`:ep.videoUrl,createdAt:ep.updatedAt,kind:'episode',filename:ep.videoUrl.split('/').pop()!})
    const renderShots=job?.plan?.shots?.length?job.plan.shots:job?.requested.shots || []
    const shots=renderShots.length?renderShots.map((shot:any,index:number)=>({shotId:shot.shotId,number:index+1,narration:shot.narration,duration:shot.duration,purpose:shot.purpose,visualType:shot.visualType || 'auto',
      status:job?.plan?.visuals?.[shot.shotId] || shot.status==='ready'?'ready':'pending',sourceNote:shot.sourceNote,selection:shot.selection || (shot.assetId?{assetId:shot.assetId,inPoint:shot.inPoint,outPoint:shot.outPoint,crop:shot.crop,reason:shot.reason}:null),
      fallbackReason:shot.fallbackReason,candidatesCount:job?.candidates[shot.shotId]?.length || 0,titles:shot.titles || [],mapEvidence:shot.map?.provenance})):
      job?[]:boards(id).map(s=>({shotId:`storyboard-${s.id}`,number:s.storyboardNumber,narration:s.narration,duration:s.duration,purpose:s.description,visualType:s.videoUrl?'video':s.composedImage || s.firstFrameImage?'image':'auto',status:s.videoUrl || s.composedImage || s.firstFrameImage?'ready':'pending',candidatesCount:0}))
    return {deletionSupported:true,episode:{id:ep.id,title:ep.title,script:ep.scriptContent || ep.content || '',profile:job?.profile || (ep.aspectRatio==='9:16'?'9:16':'16:9'),dramaId:ep.dramaId,episodeNumber:ep.episodeNumber,videoUrl:ep.videoUrl,audioUrl:ep.preTtsAudioUrl,updatedAt:ep.updatedAt},
      job:job?visible(job):null,shots,outputs,sourceId:meta.sourceId || null,links:{episode:`/drama/${ep.dramaId}/episode/${ep.episodeNumber}`,source:meta.sourceId?sourceUrl(meta.sourceId):null},url:`/remotion/episode/${id}`}
  }
  function list() {
    const dramas=new Map(db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt)).all().map(d=>[d.id,d]))
    const accounts=new Map(db.select().from(schema.mediaAccounts).all().map(a=>[a.id,a.name]))
    const episodes=db.select().from(schema.episodes).where(isNull(schema.episodes.deletedAt)).orderBy(desc(schema.episodes.updatedAt)).all()
    const counts=db.$client.prepare('SELECT episode_id, COUNT(*) AS count FROM storyboards WHERE deleted_at IS NULL GROUP BY episode_id').all() as {episode_id:number;count:number}[]
    const countMap=new Map(counts.map(r=>[r.episode_id,r.count]))
    const projects=db.select().from(schema.remotionProjects).where(isNull(schema.remotionProjects.deletedAt)).orderBy(desc(schema.remotionProjects.id)).all()
    const videos=new Map<number,string>()
    for(const project of projects)if(project.sourceEpisodeId && !videos.has(project.sourceEpisodeId)) {
      const url=project.finalVideoUrl || listProjectRenderArtifacts(project.id).find(a=>a.kind!=='test')?.url
      if(url)videos.set(project.sourceEpisodeId,url)
    }
    for(const [id,artifacts] of legacyArtifacts())if(!videos.has(id))videos.set(id,artifacts[0].url)
    return {deletionSupported:true,items:episodes.filter(ep=>dramas.has(ep.dramaId) && !record(ep.metadata).historyFactory?.deletedAt).map(ep=>{
      const meta=record(ep.metadata).historyFactory || {},job=meta.jobId?base.find(meta.jobId):null,drama=dramas.get(ep.dramaId)!
      const videoUrl=job?.plan?.deliveryAssociation?.videoUrl || ep.videoUrl || videos.get(ep.id) || null
      return {episodeId:ep.id,dramaId:ep.dramaId,episodeNumber:ep.episodeNumber,title:ep.title,dramaTitle:drama.title,accountName:drama.mediaAccountId?accounts.get(drama.mediaAccountId) || null:null,
        status:job?.status || (videoUrl?'completed':'draft'),stage:job?.stage || (videoUrl?'rendered':'source'),message:job?.message || (videoUrl?'已有成片':'等待开始制作'),
        updatedAt:job?.updatedAt || ep.updatedAt,jobId:job?.id || null,sourceId:meta.sourceId || null,videoUrl,
        shotCount:job?.requested.shots.length || countMap.get(ep.id) || 0,readyShotCount:Object.keys(job?.plan?.visuals || {}).length}
    })}
  }
  return {production,runner,startFromSource,startEpisode,detail,list,remove,assertCurrent,visible,recoverPending}
}
let singleton:ReturnType<typeof createHistoryFactory>|undefined
export function getHistoryFactory(){return singleton ||= createHistoryFactory()}
export function startHistoryFactoryWorker() {
  if(process.env.TASK_WORKER_DISABLED==='1')return {stop:async(_timeoutMs?:number)=>{}}
  const factory=getHistoryFactory()
  const tick=()=>{try {factory.recoverPending()}catch(error){console.error('[history-factory-recovery]',error)}}
  const timer=setInterval(tick,5000);timer.unref();tick()
  return {stop:async(timeoutMs?:number)=>{clearInterval(timer);await factory.runner.stop(timeoutMs)}}
}
