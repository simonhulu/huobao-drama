import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {db} from '../src/db/index.js'
import {condenseHistoryScript,historyScriptCharacters,recreateHistoryScript} from '../src/services/history-script-recreation.js'
import type {HistoryTranscriptReview} from '../src/services/history-script-processing.js'

const id=Number(process.argv[2])
if(!Number.isSafeInteger(id) || id<=0)throw Error('Usage: history-recreation-preview.ts <sourceId> [--condense]')
const condense=process.argv.includes('--condense')
const resumeIndex=process.argv.indexOf('--resume')
if(resumeIndex>=0&&!process.argv[resumeIndex+1])throw Error('--resume requires a preview directory')
const resumedDirectory=resumeIndex>=0?path.resolve(process.argv[resumeIndex+1]):undefined
const startedAt=Date.now()
const source=db.$client.prepare('SELECT id,title,author_name,corrected_transcript,rewritten_script,review_json FROM history_script_sources WHERE id=? AND deleted_at IS NULL').get(id) as {
  id:number;title:string;author_name:string|null;corrected_transcript:string;rewritten_script:string|null;review_json:string|null
}|undefined
if(!source?.corrected_transcript)throw Error('A saved corrected source is required')
const reference=condense?source.rewritten_script:source.corrected_transcript
if(!reference)throw Error('Condensation requires a saved manuscript')
let cachedRequests:Array<Record<string,any>>=[]
if(resumedDirectory){
  if(fs.readFileSync(path.join(resumedDirectory,'source.txt'),'utf8')!==reference)throw Error('Cached preview has a different source manuscript')
  const cachedReport=path.join(resumedDirectory,fs.existsSync(path.join(resumedDirectory,'report.json'))?'report.json':'failure.json')
  cachedRequests=JSON.parse(fs.readFileSync(cachedReport,'utf8')).requests || []
}
const root=fileURLToPath(new URL('../../',import.meta.url))
const directory=path.join(root,'data/static/history-recreation-study',`${id}-${Date.now()}`)
fs.mkdirSync(directory,{recursive:true})
fs.writeFileSync(path.join(directory,'source.txt'),reference)
fs.writeFileSync(path.join(directory,'previous.txt'),source.rewritten_script || '')
const previous=JSON.parse(source.review_json || '{}')
const review:HistoryTranscriptReview={correctedTranscript:source.corrected_transcript,corrections:previous.corrections || [],
  factualConcerns:previous.factualConcerns || [],factCheckStatus:previous.factCheckStatus || 'needs_sources'}
const originalFetch=globalThis.fetch
const requests:Array<Record<string,unknown>>=[]
globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/v1/chat/completions')){
    const request=JSON.parse(String(init?.body))
    const inputSha256=createHash('sha256').update(JSON.stringify(request.messages)).digest('hex')
    const cached=cachedRequests[requests.length]
    const cachedFilename=resumedDirectory&&path.join(resumedDirectory,`writer-response-${requests.length+1}.txt`)
    const reusable=cached?.status===200&&cached.finishReason==='stop'&&cachedFilename&&fs.existsSync(cachedFilename)
    if(reusable&&cached.inputSha256&&cached.inputSha256!==inputSha256)throw Error('Cached writing request changed')
    const response=reusable?Response.json({choices:[{finish_reason:'stop',message:{content:fs.readFileSync(cachedFilename,'utf8')}}],usage:cached.usage}):await originalFetch(input,init)
    const data=await response.clone().json() as any
    const content=data.choices?.[0]?.message?.content
    if(typeof content==='string')fs.writeFileSync(path.join(directory,`writer-response-${requests.length+1}.txt`),content)
    requests.push({status:response.status,maxTokens:request.max_tokens,thinkingBudgetTokens:request.reasoning_budget_tokens,
      inputSha256,cachedFrom:reusable?resumedDirectory:undefined,
      finishReason:data.choices?.[0]?.finish_reason,usage:data.usage})
    return response
  }
  return originalFetch(input,init)
}
try {
  const options={
    sourceTitle:source.title,sourceAuthor:source.author_name || undefined,
  }
  const result=condense?await condenseHistoryScript(reference,options):await recreateHistoryScript(reference,review,options)
  fs.writeFileSync(path.join(directory,'new-script.txt'),result.script)
  const report={sourceId:id,title:source.title,provider:result.provider,model:result.model,
    durationMs:Date.now()-startedAt,skillRevision:result.skillRevision,
    operation:condense?'condense_saved_draft':'recreate_source',
    originalCharacters:historyScriptCharacters(reference),previousCharacters:source.rewritten_script?.length || 0,
    newCharacters:historyScriptCharacters(result.script),
    originalSha256:createHash('sha256').update(reference).digest('hex'),
    savedSourceUnchanged:db.$client.prepare('SELECT corrected_transcript,rewritten_script FROM history_script_sources WHERE id=?').get(id),
    productionTriggered:false,requests,qualityReview:'requires_full_script_reading'}
  const unchanged=report.savedSourceUnchanged as {corrected_transcript:string;rewritten_script:string|null}
  if(unchanged.corrected_transcript!==source.corrected_transcript || unchanged.rewritten_script!==source.rewritten_script)
    throw Error('Source changed during preview; preview is isolated and must not overwrite it')
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({...report,savedSourceUnchanged:true},null,2))
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({directory,model:result.model,characters:result.script.length},null,2))
} catch(error) {
  fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({message:(error as Error).message,requests,productionTriggered:false},null,2))
  console.error(JSON.stringify({directory,error:(error as Error).message}))
  process.exitCode=1
} finally {globalThis.fetch=originalFetch;db.$client.close()}
