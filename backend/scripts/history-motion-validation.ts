import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHistoryMotionProduction,hashText,motionPlanSchema} from '../src/services/history-motion-production.js'
import {createMotionRunner} from '../src/services/history-motion-pipeline.js'
import {HuashengMaterialLibrary} from '../src/services/huasheng-material-library.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
const directory=path.resolve(process.argv[2] || path.join(root,'data/static',`history-motion-production-validation-${Date.now()}`))
fs.mkdirSync(directory,{recursive:true})
const exec=promisify(execFile)
const sourceNarration=path.resolve(process.argv[3] || path.join(root,'data/storage/history-motion/b27d2273-3a60-4167-945d-e3db09edce55/narration.json'))
const original=JSON.parse(fs.readFileSync(sourceNarration,'utf8'))
const paragraph=original.titles.find((item:any)=>item.text.startsWith('需要说明的是，开封洪水'))
if(!paragraph || !fs.existsSync(original.audioPath))throw Error('需要与开封洪水段落匹配的既有配音和时间码')
const narration=[
  '需要说明的是，',
  '开封洪水究竟由谁造成，尚有不同说法：',
  '有说是李自成所为，有说是两军共同造成，',
  '也有说是自然灾害。',
]
const script=narration.join(''),revision=hashText(script)
if(script!==paragraph.text)throw Error('样片文字与原配音段落不一致')
const library=new HuashengMaterialLibrary({databasePath:process.env.DB_PATH || path.join(root,'data/huobao_drama.db')})
const service=createHistoryMotionProduction({databasePath:path.join(directory,'validation.sqlite'),root:directory,library})
const job=service.list(1).find(item=>item.scriptRevision===revision) || service.createPlan(1,motionPlanSchema.parse({scriptRevision:revision,profile:'16:9',shots:narration.map((text,index)=>({
  shotId:`shot-${index+1}`,narration:text,duration:4,search:{query:'明末 李自成 战争',shotSize:'any',limit:20},titles:[],
  ...[
    {visualType:'video',sourceNote:'战争题材示意画面',soundEffect:{query:'低沉冲击',start:.2,duration:1.2,volume:.14}},
    {visualType:'map',mapPlan:{title:'开封洪水 · 现代地理参照',places:['开封']}},
    {visualType:'image',imagePrompt:'横版历史纪录片场景插画，明朝末年开封城外的洪水，浑浊的河水漫过古代城郊田地，远处砖石城墙和城门，几名明末衣着的军士站在高地观察水势，城郭、河流与人物的空间关系清楚，写实叙事插画，清晰自然日光，无文字，无现代器物，不表现洪水制造者，不冒充真实历史照片。'},
    {visualType:'graphic',graphic:{kind:'comparison',title:'开封洪水：成因仍有争议',items:[{label:'李自成所为',detail:'一种说法'},{label:'两军共同造成',detail:'另一种说法'},{label:'自然灾害',detail:'也有这种说法'}]},soundEffect:{query:'翻书',start:.1,duration:.8,volume:.1}},
  ][index],
}))}),script,'开封洪水：精细化制作验收样片')
// Explicit reruns reuse prepared assets but render a fresh isolated sample.
job.outputPath=null;job.stage='selecting';job.status='queued';service.write(job)
const jobDirectory=path.join(directory,job.id)
fs.mkdirSync(jobDirectory,{recursive:true})
const audioPath=path.join(jobDirectory,'narration.m4a')
await exec('ffmpeg',['-v','error','-y','-ss',String(paragraph.time_begin/1000),'-i',original.audioPath,'-t',String((paragraph.time_end-paragraph.time_begin)/1000),'-vn','-c:a','aac','-b:a','128k',audioPath],{timeout:30000})
const {stdout}=await exec('ffprobe',['-v','error','-show_format','-of','json',audioPath],{timeout:10000})
const duration=Number(JSON.parse(stdout).format.duration)
fs.writeFileSync(path.join(jobDirectory,'narration.json'),JSON.stringify({script,audioPath,duration,titles:[{text:script,time_begin:0,time_end:duration*1000}]}))
const runner=createMotionRunner(service,{
  // The sample has its own job database and never attaches a short test clip to a business manuscript.
  deliver:async(_job,output)=>({status:'validation_sample',message:'独立验收样片已生成，未修改业务稿件',outputSha256:output.sha256}),
})
let last=''
const timer=setInterval(()=>{
  const current=service.find(job.id)!
  if(current.message!==last){last=current.message;process.stdout.write(`${current.status}: ${last}\n`)}
},3000)
try {
  runner.schedule(job.id);await runner.idle()
  const result=service.find(job.id)!
  if(result.status!=='completed')throw Error(result.error || result.message)
  const report={jobId:result.id,status:result.status,outputPath:result.outputPath,
    videoUrl:`/static/${path.relative(path.join(root,'data/static'),result.outputPath!).split(path.sep).join('/')}`,
    visuals:result.plan!.shots.map((shot:any)=>({shotId:shot.shotId,visualType:shot.visualType,assetId:shot.assetId})),
    images:result.plan!.delivery.images,maps:result.plan!.delivery.maps,soundEffects:result.plan!.delivery.soundEffects,
    fallbacks:result.plan!.fallbacks,technical:result.plan!.delivery.qa.technical,
    businessManuscriptsChanged:false,sourceNarration,ttsRequests:0,visualAndListeningReview:'not_performed'}
  fs.writeFileSync(path.join(directory,'validation-result.json'),JSON.stringify(report,null,2))
  process.stdout.write(`${JSON.stringify({status:report.status,videoUrl:report.videoUrl,visuals:report.visuals,soundEffects:report.soundEffects.length,fallbacks:report.fallbacks},null,2)}\n`)
} finally {clearInterval(timer);service.close();library.close()}
