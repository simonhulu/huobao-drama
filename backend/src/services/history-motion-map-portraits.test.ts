import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {prepareMapPortraits} from './history-motion-map-portraits.js'
import {motionFileHash} from './history-motion-assets.js'

test('commander portraits are reused across cities and retries with verified local hashes',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-map-portraits-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  let calls=0
  const input={context:'靖难之役',directory,generateImage:async({directory:out}:{directory:string})=>{
    calls++;const filename=path.join(out,'face.png');fs.writeFileSync(filename,'portrait');return {path:filename,sha256:await motionFileHash(filename)}
  }}
  const forces=()=>[{commander:'朱棣',faction:'燕军'},{commander:'朱棣',faction:'燕军'},{faction:'朝廷军'}]
  const first={forces:forces()}
  assert.deepEqual(await prepareMapPortraits(first,input),{failures:[]})
  assert.equal(calls,1)
  assert.equal((first.forces[0] as any).portraitSrc,(first.forces[1] as any).portraitSrc)
  assert.equal((first.forces[2] as any).portraitSrc,undefined)
  await prepareMapPortraits({forces:forces()},input)
  assert.equal(calls,1)
})

test('portrait failures keep symbolic armies usable and do not repeat failed requests',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-map-portrait-fallback-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  let calls=0
  const input={context:'靖难之役',directory,generateImage:async()=>{calls++;throw Error('timeout')}}
  const force={commander:'盛庸',faction:'朝廷军'}
  const result=await prepareMapPortraits({forces:[{...force},{...force}]},input)
  assert.equal(result.failures.length,1)
  assert.match(result.failures[0],/保留军队与姓名/)
  await prepareMapPortraits({forces:[{...force}]},input)
  assert.equal(calls,1)
})
