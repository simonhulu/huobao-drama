import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import Database from 'better-sqlite3'
import {alignMotionShots,measureMotionShotEnds,retimeMotionMap} from '../src/services/history-motion-pipeline.js'
import {MOTION_ROOT,type MotionJob} from '../src/services/history-motion-production.js'

const args=process.argv.slice(2),episodeId=Number(args[0]),apply=args.includes('--apply')
if(!Number.isSafeInteger(episodeId) || episodeId<=0 || args.slice(1).some(arg=>arg!=='--apply'))
  throw Error('Usage: history-motion-recover-audio.ts <episodeId> [--apply]')
const projectRoot=fileURLToPath(new URL('../../',import.meta.url))
const database=new Database(process.env.DB_PATH || path.join(projectRoot,'data/huobao_drama.db'))
try {
  const row=database.prepare(`SELECT id,snapshot FROM history_motion_productions
    WHERE json_extract(snapshot,'$.factory.episodeId')=? ORDER BY updated_at DESC LIMIT 1`).get(episodeId) as {id:string;snapshot:string}|undefined
  if(!row)throw Error('Episode has no history production')
  const job=JSON.parse(row.snapshot) as MotionJob,directory=path.join(MOTION_ROOT,job.id)
  if(!['queued','failed'].includes(job.status) || job.outputPath)throw Error('Only an inactive unfinished job can be recovered')
  const voice=JSON.parse(fs.readFileSync(path.join(directory,'narration.json'),'utf8'))
  assert.equal(voice.script,job.script,'Cached master belongs to a different script')
  const captionLength=job.profile==='9:16'?16:28
  const measured=await measureMotionShotEnds(voice.audioPath,job.requested.shots,directory,voice.duration,captionLength)
  assert.ok(measured)
  const aligned=alignMotionShots(measured.shots || job.requested.shots,{...voice,shotEndTimes:measured.shotEndTimes},captionLength)
  assert.equal(measured.captions.map(caption=>caption.text).join(''),job.requested.shots.map(shot=>shot.narration).join(''))
  assert.equal(aligned.shots.reduce((sum,shot)=>sum+shot.frames,0),Math.round(voice.duration*30))
  aligned.shots.slice(0,-1).forEach((shot,index)=>assert.ok((shot.startFrame+shot.frames)*1000/30>=measured.shotEndTimes[index].endMs))
  for(const shot of aligned.shots) {
    const map=job.plan?.visuals?.[shot.shotId]?.map
    if(map)retimeMotionMap(map,job.requested.shots.find(original=>original.shotId===shot.shotId)!.duration,shot.duration)
  }
  const reportDirectory=path.join(projectRoot,'data/reports',`history-audio-recovery-${episodeId}`)
  fs.mkdirSync(reportDirectory,{recursive:true})
  const report={episodeId,jobId:job.id,applied:apply,master:voice.audioPath,duration:voice.duration,
    shotCount:aligned.shots.length,measuredEnds:measured.shotEndTimes.length,captions:measured.captions.length,
    durationInFrames:aligned.durationInFrames,evidence:measured.shotEndTimes,boundaryRepairs:measured.boundaryRepairs,listeningReview:'not_performed'}
  if(apply) {
    fs.writeFileSync(path.join(reportDirectory,`before-${Date.now()}.json`),row.snapshot)
    job.requested.shots=aligned.shots
    job.plan={...job.plan,...aligned,captions:measured.captions,audioTimingVersion:2,audioPath:voice.audioPath,
      audioSettings:voice.audioSettings,shotEndTimes:measured.shotEndTimes,audioBoundaryRepairs:measured.boundaryRepairs,width:job.profile==='9:16'?1080:1920,
      height:job.profile==='9:16'?1920:1080,fps:30,shots:[],soundEffects:[],fallbacks:job.plan?.fallbacks || []}
    job.updatedAt=new Date().toISOString()
    job.message='声画对齐已恢复，等待继续制作';job.error=null
    // Do not overwrite progress written by the live production queue.
    const saved=database.prepare('UPDATE history_motion_productions SET snapshot=?,updated_at=? WHERE id=? AND snapshot=?')
      .run(JSON.stringify(job),job.updatedAt,row.id,row.snapshot)
    assert.equal(saved.changes,1,'Job changed during recovery; no live progress was overwritten')
  }
  fs.writeFileSync(path.join(reportDirectory,apply?'applied.json':'verification.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({...report,evidence:undefined},null,2))
} finally {database.close()}
