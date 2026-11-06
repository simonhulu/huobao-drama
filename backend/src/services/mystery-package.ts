import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { MysteryError } from './mystery-store.js'
import type { MysteryWorkflowService } from './mystery-workflow.js'
import { inspectMysteryVideo } from './mystery-delivery.js'
import { createStorageRegistry } from './storage-artifacts.js'
import { hashMysteryText } from './mystery-script.js'

export function mysteryAsset(service:MysteryWorkflowService,id:number,kind:'source'|'video'|'landscape'|'portrait',editionId?:string) {
  const story=service.store.get(id),edition=story.editions.find(e=>e.id===editionId)
  const file=kind==='source'?story.media.videoPath:kind==='video'?edition?.videoPath:kind==='landscape'?edition?.landscapePath:edition?.portraitPath
  if(!file||!fs.existsSync(file))throw new MysteryError('该文件尚未生成或已不可用',404)
  const root=fs.realpathSync(service.directory(id)),resolved=fs.realpathSync(file)
  if(!resolved.startsWith(root+path.sep)||!fs.statSync(resolved).isFile())throw new MysteryError('文件不属于当前故事',403)
  return resolved
}
export async function buildMysteryPackage(service:MysteryWorkflowService,id:number,editionId:string,signal:AbortSignal) {
  const story=service.store.get(id),edition=story.editions.find(e=>e.id===editionId)
  if(!edition)throw new MysteryError('请指定成片版本',404)
  const revision=story.revisions.find(r=>r.id===edition.revisionId)
  if(!revision||revision.textHash!==edition.scriptHash)throw new MysteryError('发布包文稿与成片版本不符')
  const video=mysteryAsset(service,id,'video',editionId),landscape=mysteryAsset(service,id,'landscape',editionId),portrait=mysteryAsset(service,id,'portrait',editionId)
  const inspected=await inspectMysteryVideo(video,signal)
  if(inspected.videoSha256!==edition.videoSha256)throw new MysteryError('发布包成片指纹不符，请检查原导出文件')
  const key=hashMysteryText(JSON.stringify([edition.id,edition.scriptHash,edition.videoSha256,edition.coverRevision,edition.title,edition.description,edition.tags,story.notes,story.relatedStoryIds]))
  const directory=path.join(service.directory(id),'packages',key)
  fs.mkdirSync(directory,{recursive:true})
  const file=path.join(directory,`mystery-${id}-v${revision.id}.zip`)
  const manifest={storyId:id,editionId:edition.id,revisionId:revision.id,sourceUrl:story.sourceUrl,scriptHash:revision.textHash,videoSha256:edition.videoSha256,
    coverRevision:edition.coverRevision,title:edition.title,description:edition.description,tags:edition.tags,projectUrl:edition.projectUrl,
    requestedSettings:edition.requestedSettings,confirmedSettings:edition.confirmedSettings,subtitle:'暂无成片字幕文件；原视频时间码不能用作新成片字幕'}
  fs.writeFileSync(path.join(directory,'script.txt'),revision.text)
  fs.writeFileSync(path.join(directory,'original.txt'),revision.source)
  fs.writeFileSync(path.join(directory,'analysis-and-comparison.json'),JSON.stringify({analysis:revision.analysis,patches:revision.patches,review:revision.review},null,2))
  fs.writeFileSync(path.join(directory,'source-and-dossier.json'),JSON.stringify({sourceUrl:story.sourceUrl,sourceTitle:story.sourceTitle,sourceChannel:story.sourceChannel,dossier:revision.analysis.dossier,notes:story.notes,relatedStoryIds:story.relatedStoryIds,originalChunks:story.chunks},null,2))
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2))
  if(!fs.existsSync(file)) {
    const temporary=path.join(directory,`${randomUUID()}.zip`)
    try {
      await promisify(execFile)('zip',['-q','-j',temporary,...['script.txt','original.txt','analysis-and-comparison.json','source-and-dossier.json','manifest.json'].map(name=>path.join(directory,name)),video,landscape,portrait],{signal,timeout:30*60_000,maxBuffer:1024*1024})
      fs.renameSync(temporary,file)
    } finally {fs.rmSync(temporary,{force:true})}
  }
  const registry=createStorageRegistry(service.store.db)
  registry.track([{path:file,role:'final',bytes:fs.statSync(file).size,owners:[{ownerType:'mystery_story',ownerId:String(id),state:'active',purpose:'final'}]}])
  const artifact=registry.byPath(file);if(artifact)registry.pin(artifact.id,true)
  return file
}
