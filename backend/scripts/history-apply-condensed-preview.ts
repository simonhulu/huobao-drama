import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {db} from '../src/db/index.js'
import {createHistoryFactory} from '../src/services/history-factory.js'
import {getHistorySource,requireCurrentHistoryScript} from '../src/services/history-script-library.js'
import {historyScriptCharacters,type HistoryRecreationResult} from '../src/services/history-script-recreation.js'

// Apply an inspected preview without spending a second generation or restarting active workers.
const episodeId=Number(process.argv[2]),directory=path.resolve(process.argv[3] || '.')
if(!Number.isSafeInteger(episodeId)||episodeId<1||!process.argv[3])throw Error('Usage: history-apply-condensed-preview.ts <episodeId> <previewDirectory> [--corrections FILE] [--apply]')
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const report=JSON.parse(fs.readFileSync(path.join(directory,'report.json'),'utf8'))
const result=JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8')) as HistoryRecreationResult
const reference=fs.readFileSync(path.join(directory,'source.txt'),'utf8')
if(report.operation!=='condense_saved_draft'||report.originalSha256!==hash(reference)
  ||report.skillRevision!=='history-source-condensed-v1'||result.skillRevision!==report.skillRevision
  ||result.provider!=='remote-writer'||!report.requests?.length||report.requests.at(-1).finishReason!=='stop'
  ||historyScriptCharacters(result.script)!==report.newCharacters
  ||report.newCharacters>=report.originalCharacters||report.newCharacters>5400
  ||fs.readFileSync(path.join(directory,'new-script.txt'),'utf8')!==result.script)throw Error('Preview validation failed')
const correctionIndex=process.argv.indexOf('--corrections')
const editorialCorrections=correctionIndex<0?[]:JSON.parse(fs.readFileSync(process.argv[correctionIndex+1],'utf8'))
if(!Array.isArray(editorialCorrections))throw Error('Invalid editorial corrections')
for(const correction of editorialCorrections){
  if(!correction?.before||typeof correction.before!=='string'||typeof correction.after!=='string'||!correction.reason
    ||result.script.split(correction.before).length!==2)throw Error('Editorial correction does not match exactly once')
  result.script=result.script.replace(correction.before,correction.after)
}
if(editorialCorrections.length)Object.assign(result,{editorialCorrections})
const newCharacters=historyScriptCharacters(result.script)
if(newCharacters>5400)throw Error('Edited preview is still too long')
const episode=db.$client.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL').get(episodeId) as any
if(!episode)throw Error('Episode not found')
const metadata=JSON.parse(episode.metadata || '{}'),sourceId=metadata.historyFactory?.sourceId
const source=sourceId?getHistorySource(sourceId):null
if(!source||source.id!==report.sourceId||requireCurrentHistoryScript(source)!==reference
  ||(episode.script_content||episode.content)!==reference)throw Error('Saved source or episode changed after preview')
if(episode.video_url)throw Error('An episode with an existing video must be reviewed separately')
const factory=createHistoryFactory({
  condenseScript:async text=>{if(text!==reference)throw Error('Unexpected condensation input');return result},
  runnerFactory:()=>({schedule:()=>{},isRunning:()=>false,idle:async()=>{},stop:async()=>{}}),
})
try {
  const previous=factory.production.find(metadata.historyFactory.jobId)
  if(!previous||previous.status!=='failed'||previous.outputPath)throw Error('Only an unsuccessful idle production can use this recovery')
  if(!process.argv.includes('--apply')) {
    console.log(JSON.stringify({episodeId,sourceId,originalCharacters:report.originalCharacters,newCharacters,editorialCorrections,applied:false}))
  } else {
    fs.writeFileSync(path.join(directory,`episode-${episodeId}-before.json`),JSON.stringify({episode,source,job:previous},null,2),{flag:'wx'})
    const prepared=await factory.startEpisode(episodeId,{retry:true})
    const current=getHistorySource(sourceId)!
    if(prepared.episode.script!==result.script||requireCurrentHistoryScript(current)!==result.script
      ||prepared.job?.factory?.scriptHash!==hash(result.script))throw Error('Applied manuscript verification failed')
    const recovery={episodeId,sourceId,previousJobId:previous.id,newJobId:prepared.job.id,
      originalCharacters:report.originalCharacters,newCharacters,editorialCorrections,
      scriptSha256:hash(result.script),qualityReview:'read_against_source_with_editorial_corrections',applied:true,appliedAt:new Date().toISOString()}
    fs.writeFileSync(path.join(directory,'applied-script.txt'),result.script)
    fs.writeFileSync(path.join(directory,'applied-result.json'),JSON.stringify(result,null,2))
    fs.writeFileSync(path.join(directory,'recovery.json'),JSON.stringify(recovery,null,2))
    console.log(JSON.stringify(recovery,null,2))
  }
} finally {await factory.runner.stop();factory.production.close();db.$client.close()}
