import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {selectSciencePresenterIntro, sciencePresenterPolicyFromEnv} from './science-presenter-intro.js'

const exec=promisify(execFile)
const signal=()=>AbortSignal.timeout(30_000)
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
async function fixture(t:any,duration='10.1') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'science-presenter-library-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const clips=[]
  for(const [index,color] of ['red','blue'].entries()) {
    const videoPath=path.join(root,`${index}.mp4`)
    await exec('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`color=${color}:s=160x90:r=12`,
      '-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t',duration,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-c:a','aac',videoPath])
    clips.push({status:'ready',character:'science',presenter:'xiaolu',fingerprint:hash(`clip-${index}`),videoPath,
      videoSha256:hash(await fs.readFile(videoPath)),avatarId:`xiaolu-variant-${index}`,referenceSha256:hash(`reference-${index}`)})
  }
  const libraryPath=path.join(root,'ready.json'),library={version:1,character:'science',presenter:'xiaolu',clips}
  await fs.writeFile(libraryPath,JSON.stringify(library))
  const input=(id:string)=>({jobId:`science-${id}`,libraryPath,directory:path.join(root,id,'intro'),sourceSha256:hash(`main-${id}`)})
  return {root,libraryPath,library,clips,input}
}

test('ready Xiaolu choices are fixed per job and adjacent jobs avoid the prior clip across process-style restarts',async t=>{
  const f=await fixture(t),first=await selectSciencePresenterIntro(f.input('one'),{signal:signal()})
  const second=await selectSciencePresenterIntro(f.input('two'),{signal:signal()})
  assert.notEqual(first.fingerprint,second.fingerprint)
  assert.deepEqual(await selectSciencePresenterIntro(f.input('one'),{signal:signal()}),first)
  const third=await selectSciencePresenterIntro(f.input('three'),{signal:signal()})
  assert.equal(third.fingerprint,first.fingerprint,'resuming an older job cannot move the adjacent-selection cursor')
  assert.equal(first.initialSourceSha256,f.input('one').sourceSha256)
  assert.deepEqual(await selectSciencePresenterIntro({...f.input('one'),sourceSha256:hash('changed main')},{signal:signal()}),first,
    'a new source edition in the same job keeps its original intro choice')
  await fs.rm(path.join(f.input('one').directory,'science-presenter-selection.json'))
  assert.deepEqual(await selectSciencePresenterIntro(f.input('one'),{signal:signal()}),first,'the durable library reservation restores a missing per-job mirror')
})

test('unreviewed, withdrawn or changed Xiaolu clips cannot silently replace a job selection',async t=>{
  const f=await fixture(t)
  await fs.writeFile(f.libraryPath,JSON.stringify({...f.library,clips:f.clips.map(clip=>({...clip,status:'generated'}))}))
  await assert.rejects(selectSciencePresenterIntro(f.input('one'),{signal:signal()}),/ready|审核/i)
  await fs.writeFile(f.libraryPath,JSON.stringify(f.library))
  const selected=await selectSciencePresenterIntro(f.input('one'),{signal:signal()})
  await fs.writeFile(f.libraryPath,JSON.stringify({...f.library,clips:f.clips.filter(clip=>clip.fingerprint!==selected.fingerprint)}))
  await assert.rejects(selectSciencePresenterIntro(f.input('one'),{signal:signal()}),/withdrawn|撤回|原任务/i)
  await fs.writeFile(f.libraryPath,JSON.stringify(f.library))
  await fs.appendFile(selected.videoPath,'changed bytes')
  await assert.rejects(selectSciencePresenterIntro(f.input('one'),{signal:signal()}),/hash|指纹|变化/i)
})

test('an opt-in policy is explicit and needs an absolute ready library path',()=>{
  assert.equal(sciencePresenterPolicyFromEnv({}),undefined)
  assert.equal(sciencePresenterPolicyFromEnv({SCIENCE_PRESENTER_LIBRARY_ENABLED:'0'}),undefined)
  assert.throws(()=>sciencePresenterPolicyFromEnv({SCIENCE_PRESENTER_LIBRARY_ENABLED:'1',SCIENCE_PRESENTER_LIBRARY_PATH:'relative.json'}),/absolute|绝对/i)
  assert.deepEqual(sciencePresenterPolicyFromEnv({SCIENCE_PRESENTER_LIBRARY_ENABLED:'1',SCIENCE_PRESENTER_LIBRARY_PATH:'/tmp/ready.json'}),
    {version:1,character:'science',presenter:'xiaolu',libraryPath:'/tmp/ready.json'})
})

test('a reviewed 8.33-second dialogue-length Xiaolu intro retains its matching avatar binding',async t=>{
  const f=await fixture(t,'8.33')
  const selected=await selectSciencePresenterIntro(f.input('dialogue-length'),{signal:signal()})
  const clip=f.clips.find(clip=>clip.fingerprint===selected.fingerprint)!
  assert.equal(selected.videoPath,clip.videoPath)
  assert.equal(selected.avatarId,clip.avatarId)
  assert.equal(selected.referenceSha256,clip.referenceSha256)
  assert.deepEqual(await selectSciencePresenterIntro(f.input('dialogue-length'),{signal:signal()}),selected)
})

test('ready labels cannot admit an empty, portrait or silent intro or reserve it for a job',async t=>{
  const f=await fixture(t)
  for(const [name,size,duration,audio] of [['empty','160x90','0',true],['portrait','90x160','8.33',true],['silent','160x90','8.33',false]] as const) {
    const videoPath=path.join(f.root,`${name}.mp4`)
    await exec('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',`color=yellow:s=${size}:r=12`,
      ...(audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=16000']:[]),'-t',duration,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',...(audio?['-c:a','aac']:[]),videoPath])
    await fs.writeFile(f.libraryPath,JSON.stringify({...f.library,clips:[{...f.clips[0],videoPath,videoSha256:hash(await fs.readFile(videoPath))}]}))
    await assert.rejects(selectSciencePresenterIntro(f.input(name),{signal:signal()}),/positive duration|16:9|audio/i)
    await assert.rejects(fs.stat(`${f.libraryPath}.selection-state.json`),/ENOENT/)
  }
})

test('parallel new science jobs serialize their choices and retain distinct adjacent reservations',async t=>{
  const f=await fixture(t)
  const [one,two]=await Promise.all(['one','two'].map(id=>selectSciencePresenterIntro(f.input(id),{signal:signal()})))
  assert.notEqual(one.fingerprint,two.fingerprint)
  assert.deepEqual(await selectSciencePresenterIntro(f.input('one'),{signal:signal()}),one)
  assert.deepEqual(await selectSciencePresenterIntro(f.input('two'),{signal:signal()}),two)
})
