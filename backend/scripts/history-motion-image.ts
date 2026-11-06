import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {createImageGenerationRecord,executeImageGeneration} from '../src/services/image-generation.js'
import {db} from '../src/db/index.js'
import {motionFileHash} from '../src/services/history-motion-assets.js'
import {isRetryableMotionImageRejection,motionImageRecoveryAction,motionImageRejectionError,resolveMotionImageConfigId,type MotionImageCheckpoint,type MotionImageRecord,type MotionImageConfig} from '../src/services/history-motion-image-checkpoint.js'

const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
const directory=path.resolve(request.directory),checkpoint=path.join(directory,'generation.json')
async function main() {
  let saved: MotionImageCheckpoint | undefined
  if(fs.existsSync(checkpoint))saved=JSON.parse(fs.readFileSync(checkpoint,'utf8'))
  const readRecord=(id:number)=>db.$client.prepare('SELECT status,task_id,local_path,provider,model,error_msg,last_error_code FROM image_generations WHERE id=?').get(id) as MotionImageRecord | undefined
  let record=saved?readRecord(saved.id):undefined
  if(saved && !record)throw Error('原图片生成记录不存在')
  const action=saved?motionImageRecoveryAction(saved,record!):'submit'
  let configId:number | undefined
  if(action!=='completed') {
    const configs=db.$client.prepare("SELECT id,provider,model,priority FROM ai_service_configs WHERE service_type='image' AND is_active=1 ORDER BY id").all() as MotionImageConfig[]
    configId=resolveMotionImageConfigId(configs,saved,record)
  }
  if(!saved) {
    saved={id:createImageGenerationRecord({prompt:request.prompt,imageType:'history_motion',size:request.profile==='9:16'?'1024x1536':'1536x1024',frameType:request.profile,configId}),configId,submitted:false}
    fs.writeFileSync(checkpoint,JSON.stringify(saved))
    record=readRecord(saved.id)
  }
  if(!record)throw Error('原图片生成记录不存在')
  let result:{local_path?:string|null}={local_path:record.local_path}
  if(action!=='completed') {
    for(let attempt=0;attempt<3;attempt++) {
      saved.configId=configId
      if(action==='submit' && record.task_id) {
        // A terminally failed/expired provider task must not be polled again.
        db.$client.prepare("UPDATE image_generations SET task_id=NULL WHERE id=?").run(saved.id)
        record={...record,task_id:null}
      }
      if(!record.task_id)saved.submissionAttempts=(saved.submissionAttempts ?? (saved.submitted?1:0))+1
      saved.submitted=true
      fs.writeFileSync(checkpoint,JSON.stringify(saved))
      // Clear rejection evidence before each call: interruption must never make
      // an unknown new submission look like the previous rejected request.
      db.$client.prepare("UPDATE image_generations SET status='processing',error_msg=NULL,last_error_code=NULL,last_error_detail=NULL WHERE id=?").run(saved.id)
      try {
        result=await executeImageGeneration(saved.id,{configId,allowSynchronousImage:true,singleSubmission:true})
        break
      } catch(error) {
        const failed=readRecord(saved.id)
        if(failed && isRetryableMotionImageRejection(failed) && attempt<2) {
          await delay(2000 * 2**attempt)
          record=failed
          continue
        }
        throw (failed && motionImageRejectionError(failed)) || error
      }
    }
  }
  const storage=process.env.STORAGE_PATH || fileURLToPath(new URL('../../data/static',import.meta.url))
  const relative=String(result.local_path || '')
  const source=path.isAbsolute(relative)&&!relative.startsWith('/static/')?relative:path.join(storage,relative.replace(/^\/?static\//,''))
  if(!relative || !fs.statSync(source).isFile())throw Error('图片生成完成但本地文件不存在')
  const filename=path.join(directory,`image${path.extname(source) || '.png'}`)
  fs.copyFileSync(source,filename)
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({path:filename,sha256:await motionFileHash(filename),generationId:saved.id}))
  fs.rmSync(path.join(directory,'error.json'),{force:true})
}
try {await main();db.$client.close();process.exit(0)}
catch(error) {fs.writeFileSync(path.join(directory,'error.json'),JSON.stringify({message:(error as Error).message,code:(error as Error & {code?:string}).code}));db.$client.close();process.exit(1)}
