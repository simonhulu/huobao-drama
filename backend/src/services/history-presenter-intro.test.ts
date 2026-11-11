import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {historyPresenterPolicyFromEnv,selectHistoryPresenterIntro,prepareHistoryPresenterIntro,type HistoryPresenterRuntime} from './history-presenter-intro.js'

const exec=promisify(execFile),signal=()=>new AbortController().signal
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const fileSha=async(filename:string)=>sha(await fs.readFile(filename))
async function fixture(t:TestContext) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-presenter-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const libraryPath=path.join(root,'library.json'),directory=path.join(root,'task'),videoPath=path.join(root,'body.mp4'),presenterPath=path.join(root,'presenter.mp4')
  await fs.writeFile(videoPath,'body');await fs.writeFile(presenterPath,'presenter')
  const clips:any[]=[]
  for(const id of ['one','two']) {
    const intro=path.join(root,`${id}.mp4`);await fs.writeFile(intro,id)
    clips.push({status:'ready',character:'history',presenter:'xiaoba',fingerprint:sha(id),videoPath:intro,videoSha256:sha(id),avatarId:`xiaoba-history-${id}`,referenceSha256:sha(`${id}-reference`)})
  }
  const saveLibrary=()=>fs.writeFile(libraryPath,JSON.stringify({version:1,character:'history',presenter:'xiaoba',clips}))
  await saveLibrary()
  return {root,libraryPath,directory,videoPath,presenterPath,clips,saveLibrary}
}

test('historical presenter enablement is explicit and requires an absolute ready-library path',t=>{
  const previous=[process.env.HISTORY_PRESENTER_ENABLED,process.env.HISTORY_PRESENTER_LIBRARY_PATH]
  t.after(()=>{for(const [index,name] of ['HISTORY_PRESENTER_ENABLED','HISTORY_PRESENTER_LIBRARY_PATH'].entries()) {
    if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index]
  }})
  delete process.env.HISTORY_PRESENTER_ENABLED
  assert.equal(historyPresenterPolicyFromEnv(),undefined)
  process.env.HISTORY_PRESENTER_ENABLED='1';delete process.env.HISTORY_PRESENTER_LIBRARY_PATH
  assert.throws(historyPresenterPolicyFromEnv,/HISTORY_PRESENTER_LIBRARY_PATH/)
  process.env.HISTORY_PRESENTER_LIBRARY_PATH='/tmp/history-ready.json'
  assert.deepEqual(historyPresenterPolicyFromEnv(),{version:1,character:'history',presenter:'xiaoba',libraryPath:'/tmp/history-ready.json'})
  process.env.HISTORY_PRESENTER_ENABLED='invalid';assert.throws(historyPresenterPolicyFromEnv,/必须/)
})

test('selection uses only reviewed Xiaoba history clips, persists per task and avoids consecutive repeats',async t=>{
  const f=await fixture(t)
  f.clips.push({...f.clips[0],fingerprint:sha('generated'),status:'generated'},
    {...f.clips[0],fingerprint:sha('science'),character:'science',presenter:'xiaolu'})
  await f.saveLibrary()
  const first=await selectHistoryPresenterIntro(f,{signal:signal()})
  assert.deepEqual(await selectHistoryPresenterIntro(f,{signal:signal()}),first)
  const second=await selectHistoryPresenterIntro({...f,directory:path.join(f.root,'second')},{signal:signal()})
  assert.notEqual(first.fingerprint,second.fingerprint)
  assert.equal(first.character,'history');assert.match(first.avatarId,/^xiaoba-/)
  const [third,fourth]=await Promise.all(['third','fourth'].map(name=>selectHistoryPresenterIntro({...f,directory:path.join(f.root,name)},{signal:signal()})))
  assert.notEqual(third.fingerprint,fourth.fingerprint,'concurrent tasks serialize their last-used state')
})

test('changed or withdrawn selections fail instead of choosing another intro or a science fallback',async t=>{
  const f=await fixture(t),selected=await selectHistoryPresenterIntro(f,{signal:signal()})
  const entry=f.clips.find(clip=>clip.fingerprint===selected.fingerprint)
  entry.avatarId='xiaolu-default';await f.saveLibrary()
  await assert.rejects(selectHistoryPresenterIntro(f,{signal:signal()}),/小疤头像/)
  entry.avatarId=selected.avatarId;entry.status='generated';await f.saveLibrary()
  await assert.rejects(selectHistoryPresenterIntro(f,{signal:signal()}),/撤回/)
  entry.status='ready';await f.saveLibrary();await fs.writeFile(selected.videoPath,'changed')
  await assert.rejects(selectHistoryPresenterIntro(f,{signal:signal()}),/已变化/)
})

test('missing ready clips and damaged approved media stop before presenter submission',async t=>{
  const f=await fixture(t)
  for(const entry of f.clips)entry.status='generated'
  await f.saveLibrary()
  await assert.rejects(selectHistoryPresenterIntro(f,{signal:signal()}),/尚无已审核/)
  f.clips[0].status='ready';await f.saveLibrary();await fs.writeFile(f.clips[0].videoPath,'corrupt')
  await assert.rejects(selectHistoryPresenterIntro(f,{signal:signal()}),/已变化/)
})

test('composition recovery retains the exact avatar, source and completed presenter without a second GPU submission',async t=>{
  const f=await fixture(t),report={sha256:sha('body'),duration:2,qa:{technical:'passed'}},calls:any[]=[]
  let composeCalls=0
  const runtime:Partial<HistoryPresenterRuntime>={
    presenter:async(input,options)=>{calls.push({input,options});return {presenterPath:f.presenterPath,sourceSha256:sha('body')}},
    compose:async(input,options)=>{
      assert.equal(input.videoPath,f.videoPath);assert.equal(options.presenterFraming,'half-body');assert.equal(options.presenterPath,f.presenterPath)
      if(++composeCalls===1)throw Error('local encoder interrupted')
      await fs.mkdir(input.directory,{recursive:true});const output=path.join(input.directory,'final.mp4');await fs.writeFile(output,'final')
      return {videoPath:output,sourceSha256:sha('body'),introSha256:await fileSha(options.introPath!)}
    },
    probe:async filename=>({duration:filename===f.videoPath?2:filename.endsWith('final.mp4')?12:10,width:320,height:180,fps:30,frames:filename===f.videoPath?60:filename.endsWith('final.mp4')?360:300}),
  }
  const input={...f,report}
  await assert.rejects(prepareHistoryPresenterIntro(input,{signal:signal(),runtime}),/encoder interrupted/)
  const selection=JSON.parse(await fs.readFile(path.join(f.directory,'history-presenter-selection.json'),'utf8'))
  const result=await prepareHistoryPresenterIntro(input,{signal:signal(),runtime})
  assert.equal(calls.length,1)
  assert.equal(calls[0].options.avatarId,selection.avatarId);assert.equal(calls[0].options.referenceSha256,selection.referenceSha256)
  assert.equal(result.report.sha256,sha('final'));assert.equal(result.report.duration,12)
  assert.equal(result.report.sourceRender.sha256,sha('body'));assert.equal(result.report.presenterIntro.mainStartSeconds,10)
  assert.equal(result.report.presenterIntro.subtitles,'original-body-preserved')
  assert.equal(result.report.preview,undefined,'the original body preview cannot be advertised as the new final composition')
  assert.deepEqual(await prepareHistoryPresenterIntro(input,{signal:signal(),runtime}),result)
  assert.equal(composeCalls,2);assert.equal(calls.length,1)
  await fs.rm(result.outputPath)
  assert.deepEqual(await prepareHistoryPresenterIntro(input,{signal:signal(),runtime}),result)
  assert.equal(composeCalls,3);assert.equal(calls.length,1,'a lost final file reuses the saved full presenter')
  await fs.writeFile(f.videoPath,'changed-body')
  await assert.rejects(prepareHistoryPresenterIntro(input,{signal:signal(),runtime}),/母片与技术报告不一致/)
  assert.equal(calls.length,1)
})

test('a ready nonpositive, nonfinite or wrong-aspect intro is rejected before any GPU or composition call',async t=>{
  const f=await fixture(t);let presenterCalls=0,composeCalls=0
  for(const intro of [0,-1,NaN,Infinity].map(duration=>({duration,width:320,height:180})).concat({duration:8.33,width:180,height:320})) {
    await assert.rejects(prepareHistoryPresenterIntro({...f,report:{sha256:sha('body'),qa:{technical:'passed'}}},{signal:signal(),runtime:{
      presenter:async()=>{presenterCalls++;throw Error('unexpected presenter call')},
      compose:async()=>{composeCalls++;throw Error('unexpected composition call')},
      probe:async filename=>({...intro,duration:filename===f.videoPath?2:intro.duration,fps:30,frames:60}),
    }}),/有效时长.*16:9/)
  }
  assert.equal(presenterCalls,0);assert.equal(composeCalls,0)
})

async function clip(filename:string,color:string,duration:number,frequency:number,bottomBand=false) {
  await exec('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`color=${color}:s=320x180:r=30:d=${duration}`,
    '-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
    ...(bottomBand?['-vf','drawbox=x=0:y=155:w=320:h=25:color=green:t=fill']:[]),
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',filename],{timeout:30_000})
}

test('actual encoded history output accepts an 8.33-second dialogue-length intro and preserves presenter, subtitle band and original audio',async t=>{
  const f=await fixture(t)
  await clip(f.videoPath,'blue',1.5,880,true)
  await clip(f.clips[0].videoPath,'red',8.33,440)
  await exec('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=s=160x160:r=30:d=1.6',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',f.presenterPath])
  f.clips.splice(1);f.clips[0].videoSha256=await fileSha(f.clips[0].videoPath);await f.saveLibrary()
  let presenterCalls=0
  const result=await prepareHistoryPresenterIntro({...f,report:{sha256:await fileSha(f.videoPath),duration:1.5,qa:{technical:'passed'}}},{signal:signal(),runtime:{
    presenter:async(input,options)=>{presenterCalls++;assert.equal(options.avatarId,f.clips[0].avatarId);return {presenterPath:f.presenterPath,sourceSha256:await fileSha(input.videoPath)}},
  }})
  assert.equal(presenterCalls,1);assert.ok(Math.abs(result.report.duration-9.833333)<.05)
  const frame=async(timestamp:number)=>{const {stdout}=await exec('ffmpeg',['-nostdin','-v','error','-ss',String(timestamp),'-i',result.outputPath,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer'});return stdout}
  const intro=await frame(.1),main=await frame(8.8),later=await frame(9.3)
  const pixel=(buffer:Buffer,x:number,y:number)=>[...buffer.subarray((y*320+x)*3,(y*320+x)*3+3)]
  assert.ok(pixel(intro,80,60)[0]!>200,'selected red intro is visible first')
  assert.ok(pixel(main,80,60)[2]!>200,'original blue body follows')
  for(let y=158;y<178;y++)for(let x=0;x<320;x++) {
    const [r,g,b]=pixel(main,x,y);assert.ok(g!>80&&r!<30&&b!<30,'the encoded presenter never covers the subtitle band')
  }
  let changed=0,presenterPixels=0
  for(let y=100;y<154;y++)for(let x=240;x<300;x++) {
    const a=pixel(main,x,y),b=pixel(later,x,y)
    if(a[0]!>40||a[1]!>40)presenterPixels++
    if(a.some((value,index)=>Math.abs(value-b[index]!)>20))changed++
  }
  assert.ok(presenterPixels>300,'actual pixels contain the presenter window');assert.ok(changed>100,'the presenter advances through the narration')
  const frequency=async(timestamp:number)=>{
    const {stdout}=await exec('ffmpeg',['-nostdin','-v','error','-ss',String(timestamp),'-i',result.outputPath,'-t','0.2','-vn','-ar','8000','-ac','1','-f','f32le','pipe:1'],{encoding:'buffer'})
    let crossings=0;for(let i=1;i<stdout.length/4;i++)if(stdout.readFloatLE((i-1)*4)<0&&stdout.readFloatLE(i*4)>=0)crossings++
    return crossings*8000/(stdout.length/4)
  }
  assert.ok(Math.abs(await frequency(.1)-440)<20);assert.ok(Math.abs(await frequency(8.8)-880)<20)
  if(process.env.HISTORY_PRESENTER_TEST_ARTIFACT_DIR) {
    const evidence=path.resolve(process.env.HISTORY_PRESENTER_TEST_ARTIFACT_DIR)
    await fs.mkdir(evidence,{recursive:true});await fs.copyFile(result.outputPath,path.join(evidence,'synthetic-history-intro-presenter.mp4'))
    await fs.writeFile(path.join(evidence,'synthetic-history-intro-presenter.json'),JSON.stringify({syntheticFixture:true,description:'Offline integration evidence; no human likeness or lip-sync quality approval.',report:result.report},null,2))
    await exec('ffmpeg',['-nostdin','-v','error','-y','-ss','8.8','-i',result.outputPath,'-frames:v','1',path.join(evidence,'synthetic-history-intro-presenter.png')])
  }
})
