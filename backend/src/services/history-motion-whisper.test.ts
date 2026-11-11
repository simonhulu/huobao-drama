import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {hashText,type MotionShot} from './history-motion-production.js'

test('Whisper timeout and cache retry behavior',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-whisper-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const audioPath=path.join(root,'narration.m4a'),audio='retained-narration'
  const prefix=path.join(root,`whisper-${hashText(audio).slice(0,16)}`)
  const cli=path.join(root,'whisper-cli'),model=path.join(root,'model.bin')
  for(const [filename,content] of [[audioPath,audio],[prefix+'.wav','prepared-wav'],[cli,'fixture-cli'],[model,'fixture-model']])fs.writeFileSync(filename,content)
  const names=['WHISPER_CLI','WHISPER_MODEL','HISTORY_MOTION_WHISPER_TIMEOUT_MS']
  const previous=names.map(name=>[name,process.env[name]] as const)
  t.after(()=>{for(const [name,value] of previous){if(value===undefined)delete process.env[name];else process.env[name]=value}})
  process.env.WHISPER_CLI=cli
  process.env.WHISPER_MODEL=model
  delete process.env.HISTORY_MOTION_WHISPER_TIMEOUT_MS
  const calls:{file:string;args:string[];options:{timeout:number;maxBuffer:number}}[]=[]
  let fail=true
  const replacement=((file:string,args:string[],options:{timeout:number;maxBuffer:number},callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
    calls.push({file,args,options})
    if(!fail)fs.writeFileSync(prefix+'.json',JSON.stringify({transcription:[
      {text:'First.',offsets:{from:0,to:1000}},
      {text:'Second.',offsets:{from:1000,to:2000}},
    ]}))
    queueMicrotask(()=>callback(fail?Error('fixture ASR failed'):null,'',''))
  }) as unknown as typeof childProcess.execFile
  const originalExecFile=childProcess.execFile
  childProcess.execFile=replacement
  syncBuiltinESMExports()
  t.after(()=>{childProcess.execFile=originalExecFile;syncBuiltinESMExports()})
  const {resolveMotionWhisperTimeoutMs,measureMotionShotEnds}=await import('./history-motion-pipeline.js')
  await t.test('covers the measured slow CPU duration and remains bounded',()=>{
    assert.equal(resolveMotionWhisperTimeoutMs(120,{}),20*60_000)
    assert.equal(resolveMotionWhisperTimeoutMs(468.7,{}),3_749_600)
    assert.equal(resolveMotionWhisperTimeoutMs(3600,{}),2*60*60_000)
    for(const duration of [0,-1,NaN,Infinity])assert.equal(resolveMotionWhisperTimeoutMs(duration,{}),20*60_000)
  })
  await t.test('accepts finite positive overrides within one minute to six hours',()=>{
    const resolve=(value:string)=>resolveMotionWhisperTimeoutMs(468.7,{HISTORY_MOTION_WHISPER_TIMEOUT_MS:value})
    assert.equal(resolve('7200000'),7_200_000)
    assert.equal(resolve('1'),60_000)
    assert.equal(resolve('999999999'),6*60*60_000)
    assert.equal(resolve('60000.1'),60_001)
    for(const value of ['', 'invalid','NaN','Infinity','-Infinity','0','-1'])assert.equal(resolve(value),3_749_600)
  })
  const shots:MotionShot[]=[
    {shotId:'s1',narration:'First.',duration:1,search:{query:'first',shotSize:'any',limit:3},titles:[]},
    {shotId:'s2',narration:'Second.',duration:1,search:{query:'second',shotSize:'any',limit:3},titles:[]},
  ]
  await t.test('execution uses the resolved timeout and retains caches for retry',async()=>{
    await assert.rejects(measureMotionShotEnds(audioPath,shots,root,468.7),/fixture ASR failed.*已有配音母带和识别缓存均保留/)
    assert.equal(calls[0].options.timeout,3_749_600)
    assert.equal(calls[0].file,cli)
    assert.deepEqual(calls[0].args,['-m',model,'-l','zh','-ojf','-f',prefix+'.wav','-of',prefix,'-np'])
    assert.equal(fs.readFileSync(audioPath,'utf8'),audio)
    assert.equal(fs.readFileSync(prefix+'.wav','utf8'),'prepared-wav')
    assert.equal(fs.existsSync(prefix+'.json'),false)
    fail=false
    process.env.HISTORY_MOTION_WHISPER_TIMEOUT_MS='7200000'
    const measured=await measureMotionShotEnds(audioPath,shots,root,2)
    assert.equal(calls[1].options.timeout,7_200_000)
    assert.equal(measured?.shotEndTimes[0].endMs,1000)
    assert.equal(measured?.captions.map(caption=>caption.text).join(''),'First.Second.')
    fs.unlinkSync(cli)
    fs.unlinkSync(model)
    await measureMotionShotEnds(audioPath,shots,root,2)
    assert.equal(calls.length,2,'complete recognition must be reused without another CLI invocation')
  })
})
