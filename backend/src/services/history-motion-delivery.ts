import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {attachHistoryVideoFile,probeFinishedVideo,type HistoryVideoAttachmentOptions} from './history-script-delivery.js'
import {hashText,inside,type MotionJob} from './history-motion-production.js'
import {requestHistoryVideoPublication} from './history-video-publication.js'

export type MotionDeliveryOptions = Pick<HistoryVideoAttachmentOptions,'root'|'probe'|'maxBytes'>
const staticRoot=process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static',import.meta.url))
export function motionOutputFile(job:MotionJob,root:string) {
  if(!job.outputPath)throw Error('成片尚不可用')
  const base=fs.realpathSync(root),directory=fs.realpathSync(path.join(root,job.id)),filename=fs.realpathSync(job.outputPath)
  if(directory!==path.join(base,job.id)||directory===base||!inside(base,directory)||!inside(directory,filename))throw Error('成片路径无效')
  const info=fs.statSync(filename)
  if(!info.isFile()||!info.size)throw Error('成片文件不存在或为空')
  return filename
}
async function fileHash(filename:string) {
  const hash=createHash('sha256')
  for await(const chunk of fs.createReadStream(filename))hash.update(chunk)
  return hash.digest('hex')
}
export async function verifiedMotionOutput(job:MotionJob,root:string) {
  if(job.stage!=='rendered'||job.plan?.delivery?.qa?.technical!=='passed')throw Error('尚无通过技术检查的成片')
  const filename=motionOutputFile(job,root),expected=job.plan.delivery.sha256
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||await fileHash(filename)!==expected)
    throw Error('成片已变化或缺少检查指纹，请重新核验成片')
  return {filename,sha256:expected}
}
export async function associateMotionDelivery(job:MotionJob,output:{filename:string;sha256:string},options:MotionDeliveryOptions={},assertCurrent:()=>void=()=>{}) {
  assertCurrent()
  const delivery=await attachHistoryVideoFile(job.scriptId,output.filename,`${job.title || '历史视频'}-精细化版.mp4`,
    {...options,expectedScriptSha256:hashText(job.script),producer:'motion',producerJobId:job.id,outputSha256:output.sha256,
    probe:async filename=>{
      assertCurrent()
      const duration=await (options.probe || probeFinishedVideo)(filename)
      if(await fileHash(filename)!==output.sha256)throw Error('关联期间成片文件已变化，请重新核验成片')
      assertCurrent()
      return duration
    }})
  const video=delivery.videos.find(item=>item.producer==='motion' && item.sha256===output.sha256)
  // Verify this producer’s bytes; the legacy pointer can belong to Huasheng.
  let sameOutput=false
  if(video?.videoUrl&&!delivery.scriptChanged) {
    const prefix=`/static/history-deliveries/${job.scriptId}/`
    if(video?.videoUrl.startsWith(prefix)&&/^[a-f0-9-]+\.(mp4|mov|m4v|webm)$/i.test(video?.videoUrl.slice(prefix.length))) {
      try {
        const root=fs.realpathSync(options.root || staticRoot)
        const expected=path.join(root,video?.videoUrl.slice('/static/'.length)),actual=fs.realpathSync(expected)
        sameOutput=actual===expected&&fs.statSync(actual).isFile()&&await fileHash(actual)===output.sha256
      } catch { /* Existing missing/stale media is preserved for explicit repair. */ }
    }
  }
  assertCurrent()
  if(!sameOutput)throw Error('精细化成片关联未通过核验，请重试交付')
  requestHistoryVideoPublication(job.scriptId,hashText(job.script),video!.id,'motion')
  return {status:'attached' as const,videoUrl:video!.videoUrl,videoId:video!.id,
    outputSha256:output.sha256,checkedAt:new Date().toISOString(),
    message:'精细化版已独立关联到稿件，可继续发布'}
}
