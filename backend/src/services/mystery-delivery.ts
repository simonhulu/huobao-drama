import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import * as browser from './history-huasheng-browser.js'
import { runHuashengJob } from './history-huasheng-api.js'
import * as exporter from './history-huasheng-export-api.js'
import { sha256File } from './history-source-pipeline.js'
import { hashMysteryText } from './mystery-script.js'
import { MysteryError } from './mystery-store.js'
import { prepareScienceUploadAssets, inspectScienceUploadAssets } from './science-workflow-media.js'
import { recoverCbaUpload, type CbaUploadRecoveryOptions } from './cba-upload-recovery.js'
import type { MysteryStory, MysteryEdition, MysteryStage, MysteryRevision } from './mystery-types.js'

export interface MysteryDeliveryOptions {
  browser?: Pick<typeof browser,'runHuashengBrowserJob'>
  exportApi?: Pick<typeof exporter,'inspectHuashengProduction'|'createHuashengExport'|'inspectHuashengExport'|'downloadHuashengExport'>
  prepareAssets?: typeof prepareScienceUploadAssets
  inspectAssets?: typeof inspectScienceUploadAssets
  inspectVideo?: typeof inspectMysteryVideo
  uploadRuntime?: CbaUploadRecoveryOptions['runtime']
  pollMs?: number
}
export interface MysteryDeliveryContext {
  read: () => MysteryStory
  update: (change: (story:MysteryStory)=>void) => MysteryStory
  editionId: string; directory: string; signal: AbortSignal
  report: (message: string, stage?:MysteryStage)=>void
  browserConfig: browser.HuashengBrowserConfig
  track: (file: string, role:'source'|'final'|'project')=>void
}
const editionOf = (ctx:MysteryDeliveryContext) => ctx.read().editions.find(e=>e.id===ctx.editionId)!
function updateEdition(ctx:MysteryDeliveryContext, values:Partial<MysteryEdition>) {
  ctx.update(s=>Object.assign(s.editions.find(e=>e.id===ctx.editionId)!,values))
  return editionOf(ctx)
}
async function retryRead<T>(signal:AbortSignal, read:()=>Promise<T>): Promise<T> {
  for(let attempt=0;;attempt++) {
    signal.throwIfAborted()
    try{return await read()}catch(error){signal.throwIfAborted(); if(attempt>=2)throw error; await delay(1000*(attempt+1),undefined,{signal})}
  }
}
export async function inspectMysteryVideo(file:string, signal:AbortSignal) {
  const {stdout}=await promisify(execFile)('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{signal,timeout:60_000,maxBuffer:1024*1024})
  const info=JSON.parse(stdout), video=info.streams?.find((s:any)=>s.codec_type==='video'&&s.width>0&&s.height>0), audio=info.streams?.find((s:any)=>s.codec_type==='audio'&&s.channels>0)
  const duration=Number(info.format?.duration??video?.duration)
  if(!video||!audio||!Number.isFinite(duration)||duration<=0)throw new MysteryError('下载文件缺少有效画面、声音或时长，尚不能认定为成片')
  return {videoSha256:await sha256File(file,signal),duration,width:video.width as number,height:video.height as number,bytes:fs.statSync(file).size}
}
export async function produceMysteryEdition(ctx:MysteryDeliveryContext, revision:MysteryRevision, options:MysteryDeliveryOptions={}) {
  const api=options.exportApi||exporter, driver=options.browser||{runHuashengBrowserJob:runHuashengJob}, signal=ctx.signal
  let edition=editionOf(ctx)
  if(edition.revisionId!==revision.id||edition.scriptHash!==revision.textHash||hashMysteryText(revision.text)!==edition.scriptHash)throw new MysteryError('华生项目与文稿版本不匹配')
  if(edition.videoPath) {
    const inspected=await (options.inspectVideo||inspectMysteryVideo)(edition.videoPath,signal)
    if(edition.videoSha256&&edition.videoSha256!==inspected.videoSha256)throw new MysteryError('成片指纹发生变化，已保留原项目，请核对原导出任务')
    updateEdition(ctx,inspected);return
  }
  if(revision.text.length>10_000)throw new MysteryError(`当前华生接口最多接受10000字符，此稿为${revision.text.length}字符。完整文稿已保存；请在原平台处理长稿，系统不会压缩或截断。`)
  ctx.report('正在核对原华生项目与完整文稿','produce')
  const inspect=()=>retryRead(signal,()=>api.inspectHuashengProduction({projectUrl:editionOf(ctx).projectUrl!,checkpoint:editionOf(ctx).checkpoint,script:revision.text,browserConfig:ctx.browserConfig,signal}))
  let observation=edition.projectUrl?await inspect():null
  if(!observation||(observation.status==='not_started'&&edition.checkpoint!=='submitted')) {
    const result=await driver.runHuashengBrowserJob({jobId:edition.id,script:revision.text,projectUrl:edition.projectUrl,checkpoint:edition.checkpoint,browserConfig:ctx.browserConfig,signal,
      onCheckpoint:async patch=> {updateEdition(ctx,{checkpoint:patch.checkpoint,...(patch.projectUrl?{projectUrl:patch.projectUrl}:{}),...(patch.checkpoint==='submitted'?{confirmedSettings:{scheme:'A - 素材剪辑成片'}}:{}),status:'producing',message:patch.message});ctx.report(patch.message,'produce')},
    })
    edition=updateEdition(ctx,{projectUrl:result.projectUrl});observation=null
  }
  const productionDeadline=Date.now()+3*60*60_000
  for(;;) {
    signal.throwIfAborted();const state=observation??await inspect()
    if(state.status==='completed'){edition=updateEdition(ctx,{status:'assets_ready',confirmedSettings:{scheme:'A - 素材剪辑成片'},message:'平台素材就绪，等待导出'});break}
    if(state.status==='not_started'&&editionOf(ctx).checkpoint!=='submitted')throw new MysteryError('原华生项目尚未开始制作，请检查原项目后继续')
    ctx.report(state.message||'正在等待原华生项目制作','produce')
    if(Date.now()>productionDeadline)throw new MysteryError('华生仍在制作，原项目已保存，可稍后继续')
    await delay(options.pollMs??15_000,undefined,{signal});observation=null
  }
  ctx.report('平台素材就绪，正在导出原项目','export')
  if(!edition.exportTask) {
    if(edition.exportDispatched)throw new MysteryError('原导出请求已发送但返回未知，请补录原导出任务编号后继续；不会重复发起导出')
    try {
      const exportTask=await api.createHuashengExport({projectUrl:edition.projectUrl!,browserConfig:ctx.browserConfig,signal,
        onDispatched:()=>{updateEdition(ctx,{exportDispatched:true,status:'exporting'})}})
      edition=updateEdition(ctx,{exportTask})
    } catch(error) {if(error instanceof exporter.HuashengExportApiError&&error.requestRejected)updateEdition(ctx,{exportDispatched:false});throw error}
  }
  const exportDeadline=Date.now()+90*60_000
  for(;;) {
    signal.throwIfAborted()
    const info=await retryRead(signal,()=>api.inspectHuashengExport({projectUrl:edition.projectUrl!,...edition.exportTask!,browserConfig:ctx.browserConfig,signal}))
    if(info.progress===100&&info.url) {
      ctx.report('正在下载并检查实际成片画面和音轨','export')
      const result=await api.downloadHuashengExport({projectUrl:edition.projectUrl!,projectHash:edition.exportTask!.projectHash,url:info.url,filename:info.filename,browserConfig:ctx.browserConfig,signal},{root:path.join(ctx.directory,'exports')})
      const checked=await(options.inspectVideo||inspectMysteryVideo)(result.filePath,signal)
      updateEdition(ctx,{videoPath:result.filePath,...checked,status:'video_ready',message:'成片可用；封面单独准备'})
      ctx.track(result.filePath,'final');return
    }
    ctx.report(`正在导出：${Math.round(info.progress)}%`,'export')
    if(Date.now()>exportDeadline)throw new MysteryError('原导出任务仍在运行，编号已保存，可稍后继续')
    await delay(options.pollMs??15_000,undefined,{signal})
  }
}
export async function prepareMysteryCovers(ctx:MysteryDeliveryContext, revision:MysteryRevision, options:MysteryDeliveryOptions={}) {
  let edition=editionOf(ctx)
  if(!edition.videoPath)throw new MysteryError('请先取得并检查实际成片')
  if(edition.landscapePath&&edition.portraitPath&&!edition.coverPending) {
    await(options.inspectAssets||inspectScienceUploadAssets)({videoPath:edition.videoPath,landscapePath:edition.landscapePath,portraitPath:edition.portraitPath},{signal:ctx.signal});return
  }
  if(edition.publication?.attempt?.dispatched)throw new MysteryError('发表已发送，不能替换该发布版本的封面')
  if(!edition.coverPending)edition=updateEdition(ctx,{coverRevision:edition.coverRevision+1,coverPending:true})
  ctx.report(`正在生成第${edition.coverRevision}版横竖故事封面`,'covers')
  const {generateMysteryCoverPosters,prepareMysteryUploadAssets}=await import('./mystery-cover.js')
  const assets=await(options.prepareAssets||prepareMysteryUploadAssets)({videoPath:edition.videoPath!,directory:path.join(ctx.directory,`covers-${edition.coverRevision}`),
    title:edition.title,script:revision.text,sourceTitle:ctx.read().sourceTitle,instruction:edition.coverInstruction,revision:edition.coverRevision},
    {signal:ctx.signal,report:message=>ctx.report(message,'covers'),generatePosters:generateMysteryCoverPosters})
  updateEdition(ctx,{landscapePath:assets.landscapePath,portraitPath:assets.portraitPath,coverPending:false,status:'package_ready',message:'视频与横竖封面已准备好'})
  ctx.track(assets.landscapePath,'final');ctx.track(assets.portraitPath,'final')
}
export async function publishMysteryEdition(ctx:MysteryDeliveryContext, options:MysteryDeliveryOptions={}) {
  let edition=editionOf(ctx), publication=edition.publication
  if(!publication)throw new MysteryError('尚未选择百家号发表账号及发布信息')
  if(publication.result?.submitted&&!publication.result.saved)return
  const update=(patch:Partial<NonNullable<MysteryEdition['publication']>>)=> {ctx.update(s=>Object.assign(s.editions.find(e=>e.id===ctx.editionId)!.publication!,patch));publication=editionOf(ctx).publication!}
  let assets:Awaited<ReturnType<typeof inspectScienceUploadAssets>>|undefined
  try {assets=await(options.inspectAssets||inspectScienceUploadAssets)({videoPath:edition.videoPath!,landscapePath:edition.landscapePath!,portraitPath:edition.portraitPath!},{signal:ctx.signal})}
  catch(error){ctx.signal.throwIfAborted();if(!publication.attempt?.dispatched)throw error}
  const fingerprint=assets?hashMysteryText(JSON.stringify([edition.scriptHash,publication.accountName,publication.title,publication.description,publication.tags,publication.creationDeclaration,publication.watermark,assets.videoSha256,assets.landscapeSha256,assets.portraitSha256])):'assets-unavailable'
  if(!publication.attempt) {
    if(!assets)throw new MysteryError('发布包素材缺失')
    const payload={jobId:`${edition.id}-baijiahao`,scriptId:0,target:'baijiahao-video' as const,publicationMode:'publish' as const,accountName:publication.accountName,
      title:publication.title,description:publication.description,tags:publication.tags,creationDeclaration:publication.creationDeclaration,watermark:publication.watermark,
      videoPath:edition.videoPath,landscapePath:assets.landscapePath,portraitPath:assets.portraitPath,fingerprint}
    update({attempt:{id:payload.jobId,target:payload.target,accountName:payload.accountName,fingerprint,inputDigest:fingerprint,status:'queued',dispatched:false,payload}})
  }
  ctx.report('正在核对原百家号任务与发布包','publish');update({status:'uploading'})
  const current=editionOf(ctx).publication!.attempt!
  const result=await recoverCbaUpload(current.payload!,current,{runtime:options.uploadRuntime||await import('./social-auto-upload.js'),
    currentInputDigest:fingerprint,isCancelled:()=>ctx.signal.aborted,onProgress:message=>ctx.report(message,'publish'),
    persist:patch=>{const saved=editionOf(ctx).publication!;update({attempt:{...saved.attempt!,...patch},...(patch.result?{result:patch.result}:{})})}})
  const receipt=result.result??editionOf(ctx).publication!.result
  const submitted=Boolean(receipt?.submitted)&&receipt?.saved===false
  update({...(receipt?{result:receipt}:{}),status:submitted?(receipt?.published?'published':'submitted'):result.decision==='cancelled'?'paused':result.decision==='failed'?'failed':'uncertain',message:result.message})
  if(!submitted)throw new MysteryError(result.message||'发表结果待核对，请继续原上传任务')
  ctx.report(receipt?.published?'已核验百家号发表回执':'已提交百家号，等待平台审核','completed')
}
