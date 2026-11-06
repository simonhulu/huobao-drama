import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { db } from '../db/index.js'
import { parseHistoryYoutubeUrl, collectHistoryYoutubeVideos, type HistoryYoutubeCandidate } from './history-source-youtube.js'
import { createTask, getTask, requestCancel } from './tasks/store.js'
import { NonRetryableTaskError, type TaskContext } from './tasks/types.js'
import { MysteryStore, MysteryError, mysteryCreateSchema, mysteryPatchSchema, mysteryRunSchema, mysteryChannelSchema, mysteryCollectionSchema } from './mystery-store.js'
import { MYSTERY_NARRATOR, type MysteryStory, type MysteryRun, type MysteryStage, type MysteryEdition, type MysteryRevision, type MysteryCollection } from './mystery-types.js'
import { analyzeMysterySource, createMysteryRevision, reviewMysteryRevision, hashMysteryText, applyMysteryPatches, mysteryPatchSchema as editSchema, needsMysteryTranslation, translateMysterySource } from './mystery-script.js'
import { getMysteryHuashengAccountsService, getMysteryBaijiahaoAccountsService } from './mystery-accounts.js'
import { downloadMysterySource, transcribeMysterySource } from './mystery-media.js'
import { createStorageRegistry } from './storage-artifacts.js'
import { produceMysteryEdition, prepareMysteryCovers, publishMysteryEdition, type MysteryDeliveryOptions, type MysteryDeliveryContext } from './mystery-delivery.js'
import { huashengProjectUrl } from './history-huasheng-browser.js'

const defaultRoot=fileURLToPath(new URL('../../../data/mystery-stories/',import.meta.url))
const now=()=>new Date().toISOString()
export const mysteryRevisionSchema=z.object({expectedRevision:z.number().int().positive().nullable(),patches:z.array(editSchema).max(5000)}).strict()
export interface MysteryWorkflowOptions extends MysteryDeliveryOptions {
  store?:MysteryStore; root?:string
  enqueue?:typeof createTask; task?:typeof getTask; cancel?:typeof requestCancel
  download?:typeof downloadMysterySource; transcribe?:typeof transcribeMysterySource
  analyze?:typeof analyzeMysterySource; edit?:typeof createMysteryRevision; review?:typeof reviewMysteryRevision
  translate?:typeof translateMysterySource
  publishingCopy?:typeof import('./mystery-publishing-copy.js').generateMysteryPublishingCopy
  collect?:typeof collectHistoryYoutubeVideos
  huashengAccounts?:Pick<ReturnType<typeof getMysteryHuashengAccountsService>,'get'|'list'|'readyBrowserConfig'>
  baijiahaoAccounts?:Pick<ReturnType<typeof getMysteryBaijiahaoAccountsService>,'get'>
}
export class MysteryWorkflowService {
  readonly store:MysteryStore; readonly root:string
  private enqueue:typeof createTask; private task:typeof getTask; private cancel:typeof requestCancel
  constructor(readonly options:MysteryWorkflowOptions={}) {
    this.store=options.store||new MysteryStore(db.$client);this.root=options.root||defaultRoot
    this.enqueue=options.enqueue||createTask;this.task=options.task||getTask;this.cancel=options.cancel||requestCancel
  }
  private get hs(){return this.options.huashengAccounts||getMysteryHuashengAccountsService()}
  private get bjh(){return this.options.baijiahaoAccounts||getMysteryBaijiahaoAccountsService()}
  directory(id:number){return path.join(this.root,'stories',String(id))}
  detail(id:number) {
    const story=this.store.get(id),base=`/api/v1/mystery-stories/stories/${id}/download`
    for(const run of story.runs) {
      if(!['queued','running'].includes(run.status)||!run.taskId)continue
      const task=this.task(run.taskId)
      if(task&&['failed','stale','canceled'].includes(task.status)) {
        run.status=task.status==='canceled'?'paused':'needs_attention'
        run.message=task.errorMessage||'后台任务已停止，已保留原任务与产物，可继续处理'
        if(run.revisionId===story.currentRevisionId){story.status=run.status;story.message=run.message}
      }
    }
    if(story.media.videoPath&&fs.existsSync(story.media.videoPath))story.sourceVideoUrl=`${base}?kind=source`
    for(const edition of story.editions) {
      const suffix=`&editionId=${encodeURIComponent(edition.id)}`
      if(edition.videoPath&&fs.existsSync(edition.videoPath))edition.videoUrl=`${base}?kind=video${suffix}`
      if(edition.landscapePath&&fs.existsSync(edition.landscapePath))edition.landscapeCoverUrl=`${base}?kind=landscape${suffix}`
      if(edition.portraitPath&&fs.existsSync(edition.portraitPath))edition.portraitCoverUrl=`${base}?kind=portrait${suffix}`
    }
    return story
  }
  list(input:Parameters<MysteryStore['list']>[0]={}){const result=this.store.list(input);return {...result,items:result.items.map(s=>this.detail(s.id))}}
  create(input:z.input<typeof mysteryCreateSchema>,candidate?:HistoryYoutubeCandidate) {
    const value=mysteryCreateSchema.parse(input),url=parseHistoryYoutubeUrl(value.sourceUrl)
    if(url.kind!=='video'||!url.videoId)throw new MysteryError('请导入单条视频；频道链接请使用批量采集',400)
    const ts=now(),sourceChannel=candidate?.authorName||''
    return this.detail(this.store.create({title:value.title||candidate?.title||'待获取视频标题',category:value.category,sourceUrl:url.url,videoId:url.videoId,
      sourceChannel,sourceTitle:candidate?.title||'',downloadMode:value.downloadMode,media:{},transcript:'',correctedTranscript:'',chunks:[],transcriptVersion:0,narrator:MYSTERY_NARRATOR,
      analysis:null,revisions:[],currentRevisionId:null,editions:[],runs:[],status:'draft',stage:'download',message:'已导入，选择目标后开始处理',version:1,notes:'',relatedStoryIds:[],createdAt:ts,updatedAt:ts,archivedAt:null,logs:[]}).id)
  }
  patch(id:number,input:z.input<typeof mysteryPatchSchema>) {
    const value=mysteryPatchSchema.parse(input)
    this.store.update(id,story=>{
      if(value.correctedTranscript!==undefined||value.narrator!==undefined) {
        if(story.runs.some(r=>['queued','running'].includes(r.status)&&['download','transcribe','analyze','edit','review'].includes(r.stage)))throw new MysteryError('原稿处理仍在进行，请先停止该处理；你的输入会保留')
        story.analysis=null
        if(value.correctedTranscript!==undefined)story.translation=null
        if(value.correctedTranscript!==undefined)story.transcriptVersion++
        story.currentRevisionId=null;story.status='draft';story.stage='analyze';story.message='原稿或人设已更新，需要重新理解与轻改；旧文稿和成片已保留'
      }
      for(const related of value.relatedStoryIds||[]) {if(related===id)throw new MysteryError('不能关联故事自身',400);this.store.get(related)}
      const {expectedVersion,...patch}=value;Object.assign(story,patch)
    },value.expectedVersion)
    return this.detail(id)
  }
  saveRevision(id:number,input:z.infer<typeof mysteryRevisionSchema>) {
    const value=mysteryRevisionSchema.parse(input)
    this.store.transaction(()=>{
      const story=this.store.get(id)
      if(story.currentRevisionId!==value.expectedRevision)throw new MysteryError('文稿版本已更新；你的修改保留在编辑器，请载入新版本后保存')
      if(story.runs.some(r=>['queued','running'].includes(r.status)&&['download','transcribe','analyze','edit'].includes(r.stage)))throw new MysteryError('原稿理解或轻改尚在进行，请先停止该运行再保存；编辑器会保留你的输入')
      const source=this.scriptSource(story)
      if(!story.analysis||story.analysis.sourceHash!==hashMysteryText(source))throw new MysteryError('请先完成当前原稿的理解分析')
      const text=applyMysteryPatches(source,value.patches,story.analysis)
      const revision:MysteryRevision={id:(story.revisions.at(-1)?.id||0)+1,createdAt:now(),source,sourceHash:hashMysteryText(source),narrator:story.narrator,analysis:story.analysis,patches:value.patches,text,textHash:hashMysteryText(text),review:null}
      this.store.update(id,s=>{s.revisions.push(revision);s.currentRevisionId=revision.id;s.message='已保存新版本，正在安排句义及全文对照'})
      this.start(id,{requestId:`review-${id}-${revision.id}`,target:'draft',action:'review',revisionId:revision.id})
    })
    return this.detail(id)
  }
  start(id:number,input:z.input<typeof mysteryRunSchema>,intent:{useGeneratedPublicationCopy?:boolean}={}) {
    const value=mysteryRunSchema.parse(input)
    this.store.transaction(()=>{
      const story=this.store.get(id)
      if(story.archivedAt)throw new MysteryError('故事已归档')
      if(story.runs.some(r=>r.requestId===value.requestId))return
      const revisionId=value.revisionId??story.currentRevisionId
      if(revisionId&&!story.revisions.some(r=>r.id===revisionId))throw new MysteryError('文稿版本不存在',404)
      let edition=value.editionId?story.editions.find(e=>e.id===value.editionId):undefined
      if(value.editionId&&!edition)throw new MysteryError('成片版本不存在',404)
      if(edition&&value.revisionId&&edition.revisionId!==value.revisionId)throw new MysteryError('成片和文稿版本不对应')
      let accountName=edition?.accountName||value.huashengAccountName||null
      if(value.action==='workflow'&&value.target!=='draft') {
        if(!accountName){const accounts=this.hs.list();accountName=accounts.defaultAccountName||null}
        if(!accountName)throw new MysteryError('请选择奇闻故事工作区的华生账号',400)
        this.hs.get(accountName)
        edition ||= story.editions.find(e=>e.revisionId===revisionId&&e.accountName===accountName)
        if(!edition&&story.editions.some(e=>e.revisionId===revisionId&&!e.videoPath))throw new MysteryError('这个文稿版本已有未完成的华生任务，请继续原任务和原绑定账号')
      }
      if(value.action==='covers'&&!edition)throw new MysteryError('请指定需要制作封面的成片版本',400)
      const baijiahaoAccountName=edition?.publication?.accountName||value.baijiahaoAccountName||null
      if(value.target==='publish') {
        if(!baijiahaoAccountName)throw new MysteryError('发表模式必须选择百家号账号',400)
        this.bjh.get(baijiahaoAccountName)
        if(!edition?.publication&&!value.publication)throw new MysteryError('请填写此次发表的标题、说明、标签、平台声明和水印选择',400)
      }
      const active=story.runs.find(r=>['queued','running'].includes(r.status)&&
        (value.action==='covers'&&edition?r.editionId===edition.id:r.action===value.action&&r.revisionId===(edition?.revisionId??revisionId)&&r.accountName===accountName))
      if(active)return
      if(edition&&value.action==='covers') {
        if(edition.publication?.attempt?.dispatched)throw new MysteryError('此成片已有发表请求，不能替换已发送的封面')
        this.store.update(id,s=>Object.assign(s.editions.find(e=>e.id===edition!.id)!,{coverInstruction:value.coverInstruction??edition!.coverInstruction,coverRevision:edition!.coverRevision+1,coverPending:true}))
      }
      const run:MysteryRun={id:randomUUID(),requestId:value.requestId,target:value.target,taskId:null,revisionId:edition?.revisionId??revisionId,editionId:edition?.id||null,
        accountName,baijiahaoAccountName,status:'queued',stage:value.action==='review'?'review':value.action==='covers'?'covers':revisionId?'review':'download',stopped:false,action:value.action,message:'任务已排队',createdAt:now(),updatedAt:now()}
      this.store.update(id,s=>{s.runs.push(run);if(run.revisionId===s.currentRevisionId){s.status='queued';s.stage=run.stage;s.message=run.message}
        if(edition&&value.target==='publish'&&!s.editions.find(e=>e.id===edition!.id)!.publication){s.editions.find(e=>e.id===edition!.id)!.publication={...value.publication!,accountName:baijiahaoAccountName!,status:'pending',attempt:null,result:null,message:'等待发表'}}})
      const task=this.enqueue({type:'mystery.workflow',scopeType:'mystery_story',scopeId:id,idempotencyKey:run.id,payload:{storyId:id,runId:run.id,publication:value.publication,...intent},maxAttempts:3})
      this.store.update(id,s=>{s.runs.find(r=>r.id===run.id)!.taskId=task.id})
    })
    return this.detail(id)
  }
  stop(id:number,runId:string) {
    const run=this.findRun(id,runId)
    if(!['queued','running'].includes(run.status))return this.detail(id)
    this.store.update(id,s=>{Object.assign(s.runs.find(r=>r.id===runId)!,{stopped:true,status:'paused',message:'已停止本机执行；远端项目与检查点保留',updatedAt:now()});if(run.revisionId===s.currentRevisionId){s.status='paused';s.message='已停止本机执行；远端任务不会自动撤销'}})
    if(run.taskId)this.cancel(run.taskId,{reason:'用户停止奇闻故事任务',actor:'mystery-workspace'})
    return this.detail(id)
  }
  resume(id:number,runId:string) {
    this.store.transaction(()=>{
      const run=this.findRun(id,runId),task=run.taskId?this.task(run.taskId):null
      if(task&&['queued','running'].includes(task.status)) {if(task.cancelRequested)throw new MysteryError('停止请求正在收尾，请稍后继续');return}
      if(['ready','completed'].includes(run.status))return
      const queued=this.enqueue({type:'mystery.workflow',scopeType:'mystery_story',scopeId:id,idempotencyKey:run.id,payload:{storyId:id,runId,publication:task?.payload?.publication,useGeneratedPublicationCopy:task?.payload?.useGeneratedPublicationCopy},maxAttempts:3})
      this.store.update(id,s=>{const r=s.runs.find(r=>r.id===runId)!;Object.assign(r,{taskId:queued.id,stopped:false,status:'queued',message:'继续原任务及其检查点',updatedAt:now()});if(r.revisionId===s.currentRevisionId){s.status='queued';s.message=r.message}})
    });return this.detail(id)
  }
  archive(id:number) {this.store.update(id,s=>{if(s.runs.some(r=>['queued','running'].includes(r.status)||r.taskId&&this.task(r.taskId)?.status==='running'))throw new MysteryError('请先停止执行中的任务，等待停止完成后归档');s.archivedAt=now()});return this.detail(id)}
  saveCopy(id:number,editionId:string,input:{title:string;description:string;tags:string[]}) {
    this.store.update(id,s=>{
      const edition=s.editions.find(e=>e.id===editionId);if(!edition)throw new MysteryError('成片版本不存在',404)
      if(edition.publication?.attempt?.dispatched)throw new MysteryError('此发布版本已经发送，不能改变原发布文案')
      if(s.runs.some(r=>r.editionId===editionId&&['queued','running'].includes(r.status)))throw new MysteryError('此成片仍在执行，请先停止运行再修改发布文案')
      if(edition.title!==input.title)Object.assign(edition,{landscapePath:undefined,portraitPath:undefined,coverPending:true,coverRevision:edition.coverRevision+1,status:'video_ready',message:'标题已修改，请重新生成与标题对应的封面'})
      Object.assign(edition,input)
      if(edition.publication&&!edition.publication.attempt?.dispatched)edition.publication=undefined
    });return this.detail(id)
  }
  recoverEdition(id:number,editionId:string,input:{projectUrl?:string;exportTask?:{taskId:string;projectHash:string}}) {
    this.store.update(id,s=>{
      const edition=s.editions.find(e=>e.id===editionId);if(!edition)throw new MysteryError('成片任务不存在',404)
      if(s.runs.some(r=>r.editionId===editionId&&['running','queued'].includes(r.status)))throw new MysteryError('请先停止本机执行再补录原项目')
      if(input.projectUrl) {const url=huashengProjectUrl(input.projectUrl);if(!url)throw new MysteryError('原华生项目链接无效',400);if(edition.projectUrl&&edition.projectUrl!==url)throw new MysteryError('不能替换已绑定的原华生项目');edition.projectUrl=url}
      if(input.exportTask) {if(!edition.projectUrl)throw new MysteryError('请先提供原项目链接');if(edition.exportTask&&JSON.stringify(edition.exportTask)!==JSON.stringify(input.exportTask))throw new MysteryError('不能覆盖已有导出编号');edition.exportTask=input.exportTask;edition.exportDispatched=true}
    });return this.detail(id)
  }
  private findRun(id:number,runId:string){const run=this.store.get(id).runs.find(r=>r.id===runId);if(!run)throw new MysteryError('运行记录不存在',404);return run}
  private scriptSource(story:MysteryStory) {
    const original=story.correctedTranscript||story.transcript
    if(needsMysteryTranslation(original)) {
      if(!story.translation?.review.passed||story.translation.sourceHash!==hashMysteryText(original))throw new MysteryError('外文原稿需要先完成逐句保义译文及核对')
      return story.translation.text
    }
    return original
  }
  private track(id:number,file:string,role:'source'|'final'|'project') {
    if(!fs.existsSync(file))return
    const registry=createStorageRegistry(this.store.db)
    registry.track([{path:file,role,bytes:fs.statSync(file).size,owners:[{ownerType:'mystery_story',ownerId:String(id),state:'active',purpose:role}]}])
    const item=registry.byPath(file);if(item)registry.pin(item.id,true)
  }
  private trackDirectory(id:number,directory:string,role:'source'|'final'|'project') {
    if(!fs.existsSync(directory))return
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {const file=path.join(directory,entry.name);if(entry.isDirectory())this.trackDirectory(id,file,role);else if(entry.isFile())this.track(id,file,role)}
  }
  private async locked<T>(resource:string,ctx:TaskContext,work:()=>Promise<T>):Promise<T> {
    const token=ctx.leaseToken||`test-${ctx.taskId}`
    for(;;) {
      ctx.signal.throwIfAborted()
      const acquired=this.store.transaction(()=>{
        const prior=this.store.db.prepare('SELECT task_id,lease_token FROM mystery_resource_locks WHERE resource=?').get(resource) as {task_id:number;lease_token:string}|undefined
        if(prior) {const task=this.task(prior.task_id);if(task?.status==='running'&&task.leaseToken===prior.lease_token&&(!task.leaseExpiresAt||Date.parse(task.leaseExpiresAt)>Date.now()))return false}
        this.store.db.prepare('INSERT OR REPLACE INTO mystery_resource_locks(resource,task_id,lease_token) VALUES(?,?,?)').run(resource,ctx.taskId,token);return true
      })
      if(acquired)break
      ctx.progress('等待当前故事或绑定账号的上一项任务完成');await delay(1000,undefined,{signal:ctx.signal})
    }
    try{return await work()}finally{this.store.db.prepare('DELETE FROM mystery_resource_locks WHERE resource=? AND task_id=? AND lease_token=?').run(resource,ctx.taskId,token)}
  }
  async execute(id:number,runId:string,ctx:TaskContext) {
    return this.locked(`story:${id}`,ctx,async()=>{
      const run=this.findRun(id,runId)
      if(run.stopped||run.taskId!==ctx.taskId)return {stopped:true}
      const assertLease=()=>{if(ctx.leaseToken){const task=this.task(ctx.taskId);if(task?.status!=='running'||task.leaseToken!==ctx.leaseToken||task.leaseExpiresAt&&Date.parse(task.leaseExpiresAt)<=Date.now())throw new Error('任务租约已转交，旧执行已停止')}}
      const check=()=>{assertLease();ctx.signal.throwIfAborted();const current=this.findRun(id,runId);if(current.stopped||current.taskId!==ctx.taskId||ctx.isCancelRequested())throw new Error('任务已停止')}
      const report=(message:string,stage?:MysteryStage)=>{
        check();this.store.update(id,s=>{const r=s.runs.find(r=>r.id===runId)!;r.message=message;r.updatedAt=now();if(stage)r.stage=stage
          if(r.revisionId===s.currentRevisionId){s.message=message;s.stage=r.stage}s.logs.push({at:now(),message,stage:r.stage});if(s.logs.length>1500)s.logs.splice(0,s.logs.length-1500)})
        ctx.progress(message);ctx.event('mystery.progress',{storyId:id,runId,stage,message})
      }
      this.store.update(id,s=>{const r=s.runs.find(r=>r.id===runId)!;r.status='running';if(r.revisionId===s.currentRevisionId)s.status='running'})
      try {
        check();let story=this.store.get(id),revision=run.revisionId?story.revisions.find(r=>r.id===run.revisionId):undefined
        const hadRevision=Boolean(revision)
        if(!revision) {
          if(!story.transcript) {
            report('正在下载来源媒体；核对前保留原文件','download')
            const downloaded=await(this.options.download||downloadMysterySource)({sourceUrl:story.sourceUrl,directory:path.join(this.directory(id),'source'),media:story.media,mode:story.downloadMode},
              {signal:ctx.signal,report:message=>report(message,'download'),onMedia:media=>{this.store.update(id,s=>{s.media={...s.media,...media}})}})
            story=this.store.update(id,s=>{s.media=downloaded.media;s.sourceTitle=downloaded.title;s.sourceChannel=downloaded.author;if(s.title==='待获取视频标题')s.title=downloaded.title})
            if(!story.media.videoPath||!story.media.videoSha256)throw new MysteryError('下载缺少完整媒体检查点')
            this.track(id,story.media.videoPath,'source');check();report('正在分块转写全部原稿，完成块可恢复','transcribe')
            const transcript=await(this.options.transcribe||transcribeMysterySource)({videoPath:story.media.videoPath,videoSha256:story.media.videoSha256,directory:path.join(this.directory(id),'source')},{signal:ctx.signal,report:message=>report(message,'transcribe')})
            story=this.store.update(id,s=>{s.transcript=transcript.text;s.correctedTranscript=transcript.text;s.chunks=transcript.chunks;s.transcriptVersion++})
            this.trackDirectory(id,path.join(this.directory(id),'source'),'source')
          }
          const original=story.correctedTranscript||story.transcript,narrator=story.narrator
          if(needsMysteryTranslation(original)&&(!story.translation?.review.passed||story.translation.sourceHash!==hashMysteryText(original))) {
            report('正在逐句保义翻译外文原稿，保留原文位置与全部过程','analyze')
            const translation=await(this.options.translate||translateMysterySource)({source:original},{signal:ctx.signal,onProgress:message=>report(message,'analyze')})
            check();story=this.store.update(id,s=>{s.translation=translation})
            if(!translation.review.passed)throw new MysteryError(`中文底稿核对未通过：${translation.review.issues.map(i=>i.message).join('；')}`)
          }
          const source=this.scriptSource(story)
          if(!source.trim())throw new MysteryError('完整原稿为空，请检查来源转写')
          if(!story.analysis||story.analysis.sourceHash!==hashMysteryText(source)) {
            report('理解全篇主题、目的、心理满足与故事推进','analyze')
            const analysis=await(this.options.analyze||analyzeMysterySource)({source,narrator},{signal:ctx.signal,onProgress:message=>report(message,'analyze')})
            check();story=this.store.update(id,s=>{s.analysis=analysis})
          }
          report('以完整原文为底稿，仅作必要等义词句调整','edit')
          const result=await(this.options.edit||createMysteryRevision)({source,analysis:story.analysis!,narrator},{signal:ctx.signal,onProgress:message=>report(message,'edit')})
          check();revision={id:(story.revisions.at(-1)?.id||0)+1,createdAt:now(),source,sourceHash:hashMysteryText(source),narrator,analysis:story.analysis!,patches:result.patches,text:result.text,textHash:hashMysteryText(result.text),review:result.review}
          this.store.update(id,s=>{s.revisions.push(revision!);s.currentRevisionId=revision!.id;s.runs.find(r=>r.id===runId)!.revisionId=revision!.id})
        }
        check()
        if(!revision.review||run.action==='review'||hadRevision&&!revision.review.passed) {
          report('核对每处句义及全文完整性、衔接和原作体验','review')
          const review=await(this.options.review||reviewMysteryRevision)({source:revision.source,analysis:revision.analysis,narrator:revision.narrator,patches:revision.patches},{signal:ctx.signal,onProgress:message=>report(message,'review')})
          this.store.update(id,s=>{s.revisions.find(r=>r.id===revision!.id)!.review=review});revision={...revision,review}
        }
        const review=revision.review
        if(!review?.passed||review.sourceHash!==revision.sourceHash||review.textHash!==revision.textHash
          ||review.analysisHash!==hashMysteryText(JSON.stringify(revision.analysis))||review.narratorHash!==hashMysteryText(JSON.stringify(revision.narrator)))throw new MysteryError(`当前文稿尚未通过对照检查：${review?.issues.map(i=>i.message).join('；')||'检查指纹不匹配'}。完整原稿与修改已保存`)
        if(run.target==='draft'||run.action==='review') {report('文稿已保存并通过句义及全文对照','completed');this.finish(id,runId,'ready');return {revisionId:revision.id}}
        let edition=this.findRun(id,runId).editionId?this.store.get(id).editions.find(e=>e.id===this.findRun(id,runId).editionId):undefined
        if(!edition) {
          if(!run.accountName)throw new MysteryError('请选择华生账号')
          edition={id:`mystery-${id}-${randomUUID()}`,revisionId:revision.id,scriptHash:revision.textHash,accountName:run.accountName,createdAt:now(),status:'queued',projectUrl:null,checkpoint:null,exportDispatched:false,exportTask:null,
            requestedSettings:{aspect:'16:9',voice:'清楚自然、适合40岁以上观众',subtitle:'清晰中文字幕',visual:'纪实叙事；资料与示意画面区分'},confirmedSettings:{},message:'等待华生制作',coverRevision:0,coverInstruction:'',title:this.store.get(id).title,description:revision.analysis.purpose,tags:[]}
          if(run.target==='publish') {const publication=mysteryRunSchema.shape.publication.parse(ctx.payload.publication);if(!publication)throw new MysteryError('原发表信息缺失，请补充发布包');edition.publication={...publication,accountName:run.baijiahaoAccountName!,status:'pending',attempt:null,result:null,message:'等待成片'}}
          this.store.update(id,s=>{s.editions.push(edition!);s.runs.find(r=>r.id===runId)!.editionId=edition!.id})
        }
        const editionId=edition.id
        const base={read:()=>this.store.get(id),update:(change:(s:MysteryStory)=>void)=>{assertLease();return this.store.update(id,change)},editionId,directory:path.join(this.directory(id),'editions',editionId),signal:ctx.signal,report,track:(file:string,role:'source'|'final'|'project')=>this.track(id,file,role)}
        await this.locked(`huasheng:${edition.accountName}`,ctx,async()=>{
          check()
          const browserConfig=edition!.videoPath?{endpoint:'',profile:''}:await this.hs.readyBrowserConfig(edition!.accountName,{open:true,signal:ctx.signal})
          const delivery: MysteryDeliveryContext={...base,browserConfig}
          if(run.action!=='covers')await produceMysteryEdition(delivery,revision!,this.options)
          const savedCopy=this.store.get(id).editions.find(e=>e.id===editionId)!.publishingCopy
          if(savedCopy&&savedCopy.scriptHash!==revision!.textHash)throw new MysteryError('发布文案与当前成片文稿版本不匹配')
          if(!savedCopy) {
            report('正在依据完整故事准备标题候选、简介和标签','covers')
            const generate=this.options.publishingCopy||(await import('./mystery-publishing-copy.js')).generateMysteryPublishingCopy
            const copy=await generate({sourceTitle:this.store.get(id).sourceTitle,script:revision!.text,analysis:revision!.analysis},{signal:ctx.signal,onProgress:message=>report(message,'covers')})
            check();this.store.update(id,s=>{Object.assign(s.editions.find(e=>e.id===editionId)!,{publishingCopy:copy,titleCandidates:copy.titleCandidates,title:copy.title,description:copy.description,tags:copy.tags})})
          }
          check();await prepareMysteryCovers(delivery,revision!,this.options)
          this.trackDirectory(id,base.directory,'final')
        })
        if(run.target==='publish') {
          if(ctx.payload.useGeneratedPublicationCopy)this.store.update(id,s=>{const e=s.editions.find(e=>e.id===editionId)!;if(e.publication&&!e.publication.attempt)Object.assign(e.publication,{title:e.title,description:e.description,tags:e.tags})})
          await this.locked(`baijiahao:${run.baijiahaoAccountName}`,ctx,async()=>{check();await publishMysteryEdition({...base,browserConfig:{endpoint:'',profile:''}},this.options)})
        }
        report(run.target==='publish'?'已保存百家号提交回执':'成片与横竖封面已完成，可预览和下载','completed');this.finish(id,runId,run.target==='publish'?'completed':'ready')
        return {revisionId:revision.id,editionId}
      }catch(error) {
        const message=error instanceof Error?error.message:String(error)
        const current=this.findRun(id,runId)
        const lease=ctx.leaseToken?this.task(ctx.taskId):null
        if(current.taskId===ctx.taskId&&(!ctx.leaseToken||lease?.leaseToken===ctx.leaseToken)) this.store.update(id,s=>{const r=s.runs.find(r=>r.id===runId)!;r.status=r.stopped?'paused':'needs_attention';r.message=message;r.updatedAt=now();if(r.revisionId===s.currentRevisionId){s.status=r.status;s.message=message}s.logs.push({at:now(),message,stage:r.stage})})
        if(ctx.signal.aborted)throw error
        throw new NonRetryableTaskError(message,'mystery_needs_attention')
      }
    })
  }
  private finish(id:number,runId:string,status:'ready'|'completed'){this.store.update(id,s=>{const r=s.runs.find(r=>r.id===runId)!;r.status=status;r.stage='completed';r.updatedAt=now();if(r.revisionId===s.currentRevisionId)s.status=s.runs.some(other=>other.id!==runId&&other.revisionId===s.currentRevisionId&&['queued','running'].includes(other.status))?'queued':status})}
  channels(){return this.store.channels()}
  saveChannel(input:z.input<typeof mysteryChannelSchema>,id?:string){const value=mysteryChannelSchema.parse(input),source=parseHistoryYoutubeUrl(value.url);if(source.kind!=='channel')throw new MysteryError('请填写YouTube频道链接',400);return this.store.saveChannel({...value,url:source.url},id)}
  collections(){return this.store.collections().map(collection=>({...collection,counts:this.collectionCounts(collection)}))}
  private collectionCounts(collection:MysteryCollection){const stories=collection.storyIds.map(id=>this.store.get(id));return {selected:stories.length,transcribed:stories.filter(s=>s.transcript).length,drafts:stories.filter(s=>s.revisions.some(r=>r.review?.passed)).length,videos:stories.filter(s=>s.editions.some(e=>e.videoPath&&fs.existsSync(e.videoPath))).length,failed:stories.filter(s=>s.status==='needs_attention').length,published:stories.filter(s=>s.editions.some(e=>e.publication?.status==='published')).length}}
  startCollection(input:z.input<typeof mysteryCollectionSchema>) {
    const value=mysteryCollectionSchema.parse(input)
    return this.store.transaction(()=>{
      const found=this.store.collections().find(c=>c.requestId===value.requestId);if(found)return found
      const channels=value.channelIds.map(id=>{const c=this.store.channels().find(c=>c.id===id&&c.enabled);if(!c)throw new MysteryError('频道不存在或未启用',400);return c})
      const urls=[...new Set([...channels.map(c=>c.url),...value.urls.map(url=>parseHistoryYoutubeUrl(url).url)])]
      if(!urls.length)throw new MysteryError('请配置至少一个频道或视频链接',400)
      if(value.maxSeconds&&value.maxSeconds<value.minSeconds)throw new MysteryError('最长时长不能小于最短时长',400)
      if(value.target!=='draft') {if(!value.huashengAccountName)throw new MysteryError('批量制作请先选择华生账号',400);this.hs.get(value.huashengAccountName)}
      if(value.target==='publish') {if(!value.baijiahaoAccountName||!value.publication&&!value.publicationSettings)throw new MysteryError('发表模式请提供百家号账号和发表设置',400);this.bjh.get(value.baijiahaoAccountName)}
      const collection:MysteryCollection={id:randomUUID(),requestId:value.requestId,channelIds:value.channelIds,urls,category:value.category,targetCount:value.targetCount,target:value.target,downloadMode:value.downloadMode,
        accountName:value.huashengAccountName||null,baijiahaoAccountName:value.baijiahaoAccountName||null,keywords:value.keywords,minSeconds:value.minSeconds,maxSeconds:value.maxSeconds,afterDate:value.afterDate.replaceAll('-',''),status:'queued',stopped:false,taskId:null,scanned:0,skipped:0,storyIds:[],errors:[],message:'等待采集',createdAt:now(),updatedAt:now()}
      this.store.saveCollection(collection)
      const task=this.enqueue({type:'mystery.collection',scopeType:'mystery_collection',idempotencyKey:collection.id,payload:{collectionId:collection.id,publication:value.publication,publicationSettings:value.publicationSettings},maxAttempts:3})
      return this.store.updateCollection(collection.id,c=>{c.taskId=task.id})
    })
  }
  stopCollection(id:string){const c=this.store.updateCollection(id,c=>{c.stopped=true;c.status='paused';c.message='已暂停新增处理，已接受的故事任务继续执行'});if(c.taskId)this.cancel(c.taskId,{actor:'mystery-workspace',reason:'暂停采集'});return c}
  resumeCollection(id:string,failedOnly=false) {
    const c=this.store.collection(id),task=c.taskId?this.task(c.taskId):null
    for(const storyId of c.storyIds) {const story=this.store.get(storyId);for(const run of story.runs)if(run.status==='needs_attention'&&!run.stopped)this.resume(storyId,run.id)}
    if(failedOnly)return this.store.collection(id)
    if(task&&['queued','running'].includes(task.status)){if(task.cancelRequested)throw new MysteryError('采集暂停正在收尾，请稍后继续');return c}
    if(c.storyIds.length>=c.targetCount)return c
    return this.store.transaction(()=>{
      const queued=this.enqueue({type:'mystery.collection',scopeType:'mystery_collection',idempotencyKey:c.id,payload:{collectionId:id,publication:task?.payload?.publication,publicationSettings:task?.payload?.publicationSettings},maxAttempts:3})
      return this.store.updateCollection(id,c=>{c.taskId=queued.id;c.stopped=false;c.status='queued';c.message='继续原批次'})
    })
  }
  async executeCollection(id:string,ctx:TaskContext) {
    let collection=this.store.collection(id)
    if(collection.stopped||collection.taskId!==ctx.taskId)return
    const check=()=>{ctx.signal.throwIfAborted();collection=this.store.collection(id);if(collection.stopped||ctx.isCancelRequested())throw new Error('采集已暂停')}
    const report=(message:string)=>{check();this.store.updateCollection(id,c=>{c.message=message});ctx.progress(message)}
    this.store.updateCollection(id,c=>{c.status='running'})
    try {
      for(const url of collection.urls) {
        check();if(collection.storyIds.length>=collection.targetCount)break
        const scanBase=collection.scanned
        try {
          await(this.options.collect||collectHistoryYoutubeVideos)({url,signal:ctx.signal,targetCount:collection.targetCount,
            isKnownVideo:videoId=>Boolean(this.store.findVideo(videoId)),isTargetReached:()=>this.store.collection(id).storyIds.length>=collection.targetCount,
            report:event=>{report(event.message);this.store.updateCollection(id,c=>{if(event.scanned!==undefined)c.scanned=Math.max(c.scanned,scanBase+event.scanned);else if(event.candidate)c.scanned++;if(event.candidate?.outcome==='skipped')c.skipped++})},
            onCandidate:async candidate=>{
              check()
              if(collection.afterDate&&!candidate.publishedAt) {
                let complete:HistoryYoutubeCandidate|undefined
                try {
                  await(this.options.collect||collectHistoryYoutubeVideos)({url:candidate.sourceUrl,signal:ctx.signal,targetCount:1,isKnownVideo:()=>false,isTargetReached:()=>Boolean(complete),
                    report:event=>report(event.message),onCandidate:async value=>{if(value.videoId!==candidate.videoId)throw new MysteryError('筛选元数据与原视频不匹配');complete=value}})
                }catch(error){check();this.store.updateCollection(id,c=>{c.skipped++;c.errors.push(`${candidate.title}：${error instanceof Error?error.message:String(error)}`)});return}
                if(complete)candidate={...candidate,...complete}
              }
              const reject=collection.keywords.length&&!collection.keywords.some(word=>candidate.title.includes(word))
                ||collection.minSeconds>0&&(candidate.durationSeconds===undefined||candidate.durationSeconds<collection.minSeconds)
                ||collection.maxSeconds>0&&(candidate.durationSeconds===undefined||candidate.durationSeconds>collection.maxSeconds)
                ||collection.afterDate&&(!candidate.publishedAt||candidate.publishedAt<collection.afterDate)
              if(reject){this.store.updateCollection(id,c=>{c.skipped++});return}
              const category=this.store.channels().find(c=>c.url===url)?.category||collection.category
              try{this.store.transaction(()=>{
                const story=this.create({sourceUrl:candidate.sourceUrl,title:candidate.title,category,downloadMode:collection.downloadMode},candidate)
                this.store.updateCollection(id,c=>{if(!c.storyIds.includes(story.id))c.storyIds.push(story.id)})
                const settings=ctx.payload.publicationSettings
                const publication=settings?{title:candidate.title.slice(0,50),description:candidate.title,tags:[],...settings}:ctx.payload.publication
                this.start(story.id,{requestId:`batch-${id}-${story.id}`,target:collection.target,huashengAccountName:collection.accountName,baijiahaoAccountName:collection.baijiahaoAccountName,publication},{useGeneratedPublicationCopy:Boolean(settings)})
              })}catch(error){check();this.store.updateCollection(id,c=>{c.skipped++;c.errors.push(`${candidate.title}：${error instanceof Error?error.message:String(error)}`)})}
            }})
        }catch(error){check();this.store.updateCollection(id,c=>{c.errors.push(`${url}：${error instanceof Error?error.message:String(error)}`)})}
        this.store.updateCollection(id,c=>{c.skipped=Math.max(c.skipped,c.scanned-c.storyIds.length)})
      }
      this.store.updateCollection(id,c=>{c.status=c.errors.length?'needs_attention':'completed';c.message=`采集结束，已接受${c.storyIds.length}条；各故事继续按所选目标执行`})
    }catch(error){this.store.updateCollection(id,c=>{c.status=c.stopped?'paused':'needs_attention';c.message=error instanceof Error?error.message:String(error)});throw error}
  }
}
let instance:MysteryWorkflowService|undefined
export const getMysteryWorkflowService=()=>instance||=(new MysteryWorkflowService())
