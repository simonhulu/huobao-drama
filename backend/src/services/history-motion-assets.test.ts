import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import Database from 'better-sqlite3'
import {createServer} from 'node:http'
import {assetHash,isPendingImageGenerationError,motionFileHash,motionSoundCatalog,selectMotionSound,prepareMotionSound,prepareMotionImage,probeMotionVideo} from './history-motion-assets.js'

test('sound selection uses the requested role and creates a cached playable normalized clip',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-sound-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const library=path.join(root,'library');fs.mkdirSync(library)
  const source=path.join(library,'低沉冲击.wav')
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=180:duration=2','-c:a','pcm_s16le',source])
  fs.writeFileSync(path.join(library,'低沉的笑声.mp3'),'not a candidate')
  fs.writeFileSync(path.join(library,'激光冲击波.mp3'),'not a candidate')
  assert.equal(motionSoundCatalog(library).length,3)
  assert.equal(selectMotionSound('强调 转折',library),source)
  assert.equal(selectMotionSound('低沉冲击',library),source)
  assert.equal(selectMotionSound('不存在的音效',library),null)
  const first=await prepareMotionSound({query:'低沉冲击',duration:1,directory:root,root:library})
  const second=await prepareMotionSound({query:'低沉冲击',duration:1,directory:root,root:library})
  assert.equal(first.sourcePath,second.sourcePath);assert.equal(first.sha256,second.sha256)
  assert.equal(first.sourceName,'低沉冲击.wav');assert.ok(Math.abs(first.duration-1)<.05)
  assert.equal(first.sha256,await motionFileHash(first.sourcePath))
  assert.notEqual(first.sourcePath,source)
})

test('only an async provider task is eligible for automatic image-wait recovery',()=>{
  assert.equal(isPendingImageGenerationError(Object.assign(Error('pending'),{code:'image_generation_pending'})),true)
  assert.equal(isPendingImageGenerationError(Error('图片服务超时')),false)
})

test('missing sound library and corrupt video produce explicit errors without a long wait',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-media-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  await assert.rejects(prepareMotionSound({query:'战鼓',duration:1,directory:root,root:path.join(root,'missing')}),/没有匹配/)
  const filename=path.join(root,'broken.mp4');fs.writeFileSync(filename,'broken')
  await assert.rejects(probeMotionVideo(filename))
})

test('a completed generated image is reused without submitting another provider request',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-image-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const prompt='红军从山间行进的场景插画',profile='16:9' as const
  const directory=path.join(root,'images',assetHash(JSON.stringify([prompt,profile])))
  fs.mkdirSync(directory,{recursive:true})
  const filename=path.join(directory,'image.png');fs.writeFileSync(filename,'cached-image')
  const expected={path:filename,sha256:await motionFileHash(filename)}
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(expected))
  assert.deepEqual(await prepareMotionImage({prompt,profile,directory:root,shotId:'s1'}),expected)
  assert.equal(fs.existsSync(path.join(directory,'request.json')),false)
})

test('image rejection codes survive the real worker boundary without another provider submission',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-image-errors-'))
  const previousDb=process.env.DB_PATH
  process.env.DB_PATH=path.join(root,'test.sqlite')
  let db:Database.Database|undefined
  t.after(()=>{
    db?.close()
    if(previousDb===undefined)delete process.env.DB_PATH;else process.env.DB_PATH=previousDb
    fs.rmSync(root,{recursive:true,force:true})
  })
  execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"const {db}=await import('./src/db/index.ts');db.$client.close()"],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...process.env,TASK_WORKER_DISABLED:'1'},timeout:20000,
  })
  db=new Database(process.env.DB_PATH)
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,is_active,created_at,updated_at) VALUES (95,'image','gpt-image2','local rejection test','http://127.0.0.1:1','test-key','[\"gpt-image-2\"]',1,'2026-10-29','2026-10-29')").run()
  db.prepare("INSERT INTO image_generations (id,status,created_at,updated_at) VALUES (1,'failed','2026-10-27','2026-10-27')").run()
  const prompt='历史人物在营帐内追思旧友',profile='16:9' as const
  const directory=path.join(root,'images',assetHash(JSON.stringify([prompt,profile])))
  fs.mkdirSync(directory,{recursive:true})
  const checkpoint={id:1,configId:95,submitted:true}
  fs.writeFileSync(path.join(directory,'generation.json'),JSON.stringify(checkpoint))
  for(const [message,code] of [
    ['API error 400: moderation_blocked','content_policy_violation'],
    ['API error 401: unauthorized','auth_failed'],
  ] as const) {
    db.prepare('UPDATE image_generations SET error_msg=?,last_error_code=? WHERE id=1').run(message,code || null)
    await assert.rejects(prepareMotionImage({prompt,profile,directory:root,shotId:'s1'}),error=>{
      assert.equal((error as Error & {code?:string}).code,code)
      assert.match((error as Error).message,/拒绝/)
      return true
    })
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'error.json'),'utf8')).code,code)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory,'generation.json'),'utf8')),checkpoint)
    assert.equal((db.prepare('SELECT count(*) AS count FROM image_generations').get() as {count:number}).count,1)
    assert.deepEqual(db.prepare('SELECT status,task_id,error_msg FROM image_generations WHERE id=1').get(),{status:'failed',task_id:null,error_msg:message})
  }
})

test('real image worker retries explicit 502/503 rejections with bounded attempts and protects unknown submissions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-image-502-'))
  const previousDb=process.env.DB_PATH,previousStorage=process.env.STORAGE_PATH
  process.env.DB_PATH=path.join(root,'test.sqlite')
  process.env.STORAGE_PATH=path.join(root,'static')
  const counts=new Map<string,number>()
  const server=createServer(async(req,res)=>{
    let body=''
    for await(const chunk of req)body+=chunk
    const prompt=JSON.parse(body).prompt as string
    const count=(counts.get(prompt)||0)+1
    counts.set(prompt,count)
    res.setHeader('Content-Type','application/json')
    if((prompt==='recovers' || prompt==='capacity-recovers' || prompt==='upstream-failed') && count===2) {
      res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}]}))
    } else {
      res.statusCode=prompt.startsWith('capacity') || prompt==='unknown-503'?503:502
      res.end(prompt==='ambiguous'?'Bad Gateway':prompt==='unknown-503'?'Service Unavailable':JSON.stringify({error:prompt.startsWith('capacity')?{type:'api_error',message:'No available compatible accounts'}:{type:'upstream_error',message:prompt==='upstream-failed'?'Upstream request failed':'Upstream service temporarily unavailable'}}))
    }
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  let db:Database.Database|undefined
  t.after(async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    db?.close()
    if(previousDb===undefined)delete process.env.DB_PATH;else process.env.DB_PATH=previousDb
    if(previousStorage===undefined)delete process.env.STORAGE_PATH;else process.env.STORAGE_PATH=previousStorage
    fs.rmSync(root,{recursive:true,force:true})
  })
  execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"const {db}=await import('./src/db/index.ts');db.$client.close()"],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...process.env,TASK_WORKER_DISABLED:'1'},timeout:20000,
  })
  db=new Database(process.env.DB_PATH)
  const port=(server.address() as {port:number}).port
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,name,base_url,api_key,model,is_active,created_at,updated_at) VALUES (95,'image','gpt-image2','local retry test',?,'test-key','[\"gpt-image-2\"]',1,'2026-10-29','2026-10-29')").run(`http://127.0.0.1:${port}`)
  const profile='16:9' as const
  // Match episode 1103's old checkpoint: submitted=true, failed 502, no task id.
  db.prepare("INSERT INTO image_generations (id,provider,model,prompt,status,error_msg,created_at,updated_at) VALUES (1,'gpt-image2','gpt-image-2','recovers','failed',?,'2026-10-29','2026-10-29')").run('API error 502: {"error":{"message":"Upstream service temporarily unavailable","type":"upstream_error"}}')
  const recoveryDirectory=path.join(root,'images',assetHash(JSON.stringify(['recovers',profile])))
  fs.mkdirSync(recoveryDirectory,{recursive:true})
  fs.writeFileSync(path.join(recoveryDirectory,'generation.json'),JSON.stringify({id:1,configId:95,submitted:true}))
  const recovered=await prepareMotionImage({prompt:'recovers',profile,directory:root,shotId:'shot-54'})
  assert.ok(fs.existsSync(recovered.path))
  assert.equal(JSON.parse(fs.readFileSync(path.join(recoveryDirectory,'generation.json'),'utf8')).id,1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(recoveryDirectory,'generation.json'),'utf8')).submissionAttempts,3)
  assert.equal(counts.get('recovers'),2)
  assert.deepEqual(await prepareMotionImage({prompt:'recovers',profile,directory:root,shotId:'shot-54'}),recovered)
  assert.equal(counts.get('recovers'),2)
  await assert.rejects(prepareMotionImage({prompt:'unavailable',profile,directory:root,shotId:'shot-54'}),/API error 502/)
  assert.equal(counts.get('unavailable'),3)
  await assert.rejects(prepareMotionImage({prompt:'ambiguous',profile,directory:root,shotId:'shot-54'}),/API error 502/)
  assert.equal(counts.get('ambiguous'),1)
  const capacityRecovered=await prepareMotionImage({prompt:'capacity-recovers',profile,directory:root,shotId:'shot-54'})
  assert.ok(fs.existsSync(capacityRecovered.path))
  assert.equal(counts.get('capacity-recovers'),2)
  const upstreamRecovered=await prepareMotionImage({prompt:'upstream-failed',profile,directory:root,shotId:'shot-54'})
  assert.ok(fs.existsSync(upstreamRecovered.path))
  assert.equal(counts.get('upstream-failed'),2)
  await assert.rejects(prepareMotionImage({prompt:'capacity-unavailable',profile,directory:root,shotId:'shot-54'}),error=>{
    assert.equal((error as Error & {code:string}).code,'image_provider_capacity')
    assert.match((error as Error).message,/暂时没有可用的兼容账号/)
    assert.doesNotMatch((error as Error).message,/api_error|\{/)
    return true
  })
  assert.equal(counts.get('capacity-unavailable'),3)
  await assert.rejects(prepareMotionImage({prompt:'unknown-503',profile,directory:root,shotId:'shot-54'}),/API error 503/)
  await assert.rejects(prepareMotionImage({prompt:'unknown-503',profile,directory:root,shotId:'shot-54'}),/API error 503/)
  assert.equal(counts.get('unknown-503'),2)
  await assert.rejects(prepareMotionImage({prompt:'ambiguous',profile,directory:root,shotId:'shot-54'}),/API error 502/)
  assert.equal(counts.get('ambiguous'),2)
  const directory=path.join(root,'images',assetHash(JSON.stringify(['unavailable',profile])))
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'generation.json'),'utf8')).submissionAttempts,3)
  assert.equal((db.prepare('SELECT count(*) AS count FROM image_generations').get() as {count:number}).count,7)
})
