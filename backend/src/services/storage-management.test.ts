import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, utimes, realpath } from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStorageManager } from './storage-management.js'
import { discoverPublishedMedia } from './storage-published-media.js'

async function fixture(t: any, fileDatabase=false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'storage-management-')))
  const db = new Database(fileDatabase ? path.join(root,'fixture.db') : ':memory:')
  t.after(async () => { db.close(); await rm(root,{recursive:true,force:true}) })
  db.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,platform TEXT,source_video_id TEXT,source_url TEXT,
    status TEXT,media_json TEXT,raw_transcript TEXT,corrected_transcript TEXT,rewritten_script TEXT,asr_json TEXT,
    review_json TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE huasheng_material_files(file_path TEXT,asset_id TEXT,project_id TEXT,clip_id TEXT,bytes INTEGER,sha256 TEXT,updated_at TEXT);
    CREATE TABLE huasheng_material_recommendations(project_id TEXT,clip_id TEXT,file_path TEXT);
    CREATE TABLE creation_tasks(id TEXT,status TEXT,payload_json TEXT);`)
  const put = async (relative: string, text = 'media bytes') => {
    const filename = path.join(root,relative); await mkdir(path.dirname(filename),{recursive:true}); await writeFile(filename,text)
    const old = new Date(Date.now()-3*86400000); await utimes(filename,old,old)
    return filename
  }
  const manager = createStorageManager({db,projectRoot:root,releaseSource:async () => {},cleanupRender:async () => ({status:'retained'}),published:()=>[]})
  return {root,db,put,manager}
}

test('inventory persists task ownership and retains failed ASR and deleted tasks', async t => {
  const f = await fixture(t)
  const filename = await f.put('data/storage/history-scripts/1/source.mp4')
  f.db.prepare('INSERT INTO history_script_sources(id,platform,source_video_id,source_url,status,media_json,updated_at,deleted_at) VALUES(1,?,?,?,?,?,?,?)')
    .run('youtube','abc','https://www.youtube.com/watch?v=abc','failed','{}',new Date().toISOString(),new Date().toISOString())
  const result = await f.manager.scan()
  assert.equal(result.items.length,0)
  const review = f.manager.reviewList().items
  assert.equal(review[0].ownerType,'history-source'); assert.equal(review[0].ownerId,'1')
  assert.equal(review[0].state,'deleted')
  await f.manager.cleanup()
  assert.equal(await readFile(filename,'utf8'),'media bytes')
})

test('the review queue reaches every file with stable pages and filters unresolved ownership',async t=>{
  const f=await fixture(t)
  const files=Array.from({length:160},(_,index)=>({path:path.join(f.root,`data/static/${index}.mp4`),bytes:10,
    role:index%2 ? 'final' as const : 'source' as const,
    owners:index<155 ? [{ownerType:'cba',ownerId:'task',state:'completed'}]
      : index===155 ? [{ownerType:'science',ownerId:'task',state:'completed'}]
      : [{ownerType:'unassigned',ownerId:'static',state:'needs_review'},...(index===159 ? [{ownerType:'cba',ownerId:'associated',state:'completed'}] : [])]}))
  f.manager.registry.track(files)
  const first=f.manager.reviewList(),second=f.manager.reviewList({offset:150})
  assert.equal(first.total,160);assert.equal(first.limit,150);assert.equal(first.offset,0)
  assert.equal(first.items.length,150);assert.equal(second.items.length,10)
  assert.equal(new Set([...first.items,...second.items].map(file=>file.id)).size,160)
  assert.deepEqual(f.manager.reviewList({offset:150}).items.map(file=>file.id),second.items.map(file=>file.id))
  assert.equal(f.manager.reviewList({ownerType:'unassigned'}).total,3)
  assert.equal(f.manager.reviewList({ownerType:'cba',role:'final'}).total,78)
  assert.equal(f.manager.reviewList({ownerType:'science',ownerId:'task'}).total,1)
  assert.equal(f.manager.reviewList({ownerType:'cba',ownerId:'static'}).total,0)
  f.manager.registry.release(files[0].path,{})
  assert.equal(f.manager.reviewList().total,159)
})

test('immutable identical material files share bytes while every task path remains', async t => {
  const f = await fixture(t), bytes = 'same immutable material'
  const a = await f.put('data/huasheng-recommendations/first/a.mp4',bytes), b = await f.put('data/huasheng-recommendations/second/b.mp4',bytes)
  const sha = createHash('sha256').update(bytes).digest('hex')
  for (const [file,owner] of [[a,'first'],[b,'second']]) f.db.prepare('INSERT INTO huasheng_material_files VALUES(?,?,?,?,?,?,?)').run(file,'asset',owner,'clip',bytes.length,sha,'2026-01-01')
  const result = await f.manager.scan()
  assert.equal(result.items.filter(item => item.kind==='duplicate-material').length,1)
  await f.manager.cleanup(['duplicate-material'])
  assert.equal((await stat(a)).ino,(await stat(b)).ino)
  assert.equal(await readFile(a,'utf8'),bytes); assert.equal(await readFile(b,'utf8'),bytes)
  assert.equal(f.manager.registry.owners(f.manager.registry.byPath(a)!.id)[0].ownerId,'first')
})

test('proven immutable delivery copies share storage without removing either movie or ownership',async t=>{
  const f=await fixture(t),bytes='identical completed delivery',sha=createHash('sha256').update(bytes).digest('hex')
  const first=await f.put('data/static/history-deliveries/1/11111111-1111-1111-1111-111111111111.mp4',bytes)
  const second=await f.put('data/static/history-deliveries/2/22222222-2222-2222-2222-222222222222.mp4',bytes)
  f.db.exec('CREATE TABLE history_video_deliveries(script_id INTEGER,script_sha256 TEXT,video_path TEXT,video_sha256 TEXT)')
  for (const [id,file] of [[1,first],[2,second]]) f.db.prepare('INSERT INTO history_video_deliveries VALUES(?,?,?,?)').run(id,'a'.repeat(64),String(file).replace(path.join(f.root,'data'),''),sha)
  const scan=await f.manager.scan()
  assert.equal(scan.running,false)
  assert.equal(scan.items.filter(item=>item.kind==='duplicate-material').length,1)
  const result=await f.manager.cleanup(['duplicate-material'])
  assert.equal(result.running,false);assert.equal(result.lastRun!.errors.length,0)
  assert.equal(await readFile(first,'utf8'),bytes);assert.equal(await readFile(second,'utf8'),bytes)
  assert.equal((await stat(first)).ino,(await stat(second)).ino)
  assert.equal(f.manager.registry.byPath(second)!.role,'final')
  assert.equal(f.manager.registry.owners(f.manager.registry.byPath(second)!.id)[0].ownerId,'2')
})

async function publishedMotionFixture(t:any,fileDatabase=false) {
  const f=await fixture(t,fileDatabase),jobId='11111111-1111-1111-1111-111111111111',bytes='published motion movie'
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),sha=hash(bytes)
  const delivery=await f.put('data/static/history-deliveries/1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',bytes)
  const original=await f.put(`data/storage/history-motion/${jobId}/render-123/movie.mp4`,bytes)
  const input=await f.put(`data/storage/history-motion/${jobId}/narration.wav`,'retained production input')
  f.db.prepare("INSERT INTO history_script_sources(id,platform,status,media_json,rewritten_script) VALUES(1,'youtube','recreated','{}','current script')").run()
  f.db.exec(`CREATE TABLE history_video_deliveries(id INTEGER,script_id INTEGER,script_sha256 TEXT,producer TEXT,producer_job_id TEXT,video_path TEXT,video_sha256 TEXT);
    CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER,source_id INTEGER,video_id INTEGER,target TEXT,publication_mode TEXT,status TEXT,payload_json TEXT,result_json TEXT,fingerprint TEXT,updated_at TEXT,video_producer TEXT);`)
  f.db.prepare('INSERT INTO history_video_deliveries VALUES(7,1,?,?,?,?,?)')
    .run(hash('current script'),'motion',jobId,delivery.replace(path.join(f.root,'data'),''),sha)
  f.db.prepare('INSERT INTO history_motion_productions VALUES(?,1,?,?)').run(jobId,'completed',JSON.stringify({
    id:jobId,scriptId:1,status:'completed',stage:'rendered',outputPath:original,plan:{narrationPath:input,delivery:{sha256:sha,qa:{technical:'passed'}}}}))
  const payload={jobId:'1',scriptId:1,target:'baijiahao-video',publicationMode:'publish',videoPath:delivery,fingerprint:hash('upload'),accountName:'history_baijiahao'}
  const receipt={staged:true,targetId:'editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',submitted:true,
    saved:false,published:true,publicationStatus:'published',articleId:'1880027026933416669',
    publishedUrl:'https://baijiahao.baidu.com/s?id=1880027026933416669',accountName:'history_baijiahao'}
  f.db.prepare("INSERT INTO history_social_upload_jobs VALUES(1,1,7,'baijiahao-video','publish','completed',?,?,?,?, 'motion')")
    .run(JSON.stringify(payload),JSON.stringify(receipt),hash('upload'),new Date(Date.now()-1000).toISOString())
  return {...f,jobId,delivery,original,input,sha,bytes,receipt,manager:createStorageManager({db:f.db,projectRoot:f.root})}
}

async function publishedFactoryFixture(t:any) {
  const f=await publishedMotionFixture(t),scriptHash=createHash('sha256').update('current script').digest('hex')
  const rendered=await f.put(`data/static/remotion/history-${f.jobId}-${f.sha.slice(0,12)}.mp4`,f.bytes)
  const preview=await f.put(`data/static/remotion/history-${f.jobId}-${f.sha.slice(0,12)}-preview.mp4`,'preview retained')
  const factory={sourceId:1,projectId:29,episodeId:23,scriptHash}
  const snapshot=JSON.parse((f.db.prepare('SELECT snapshot FROM history_motion_productions').get() as any).snapshot)
  f.db.prepare('UPDATE history_motion_productions SET snapshot=?').run(JSON.stringify({...snapshot,script:'current script',factory,
    plan:{...snapshot.plan,deliveryAssociation:{videoUrl:rendered}}}))
  f.db.exec(`CREATE TABLE remotion_renders(project_id INTEGER,render_kind TEXT,status TEXT,input_hash TEXT,output_path TEXT,props_json TEXT);
    CREATE TABLE remotion_projects(id INTEGER,source_type TEXT,source_episode_id INTEGER,metadata_json TEXT,source_snapshot_json TEXT);
    CREATE TABLE episodes(id INTEGER,status TEXT,metadata TEXT,video_url TEXT);`)
  f.db.prepare("INSERT INTO remotion_projects VALUES(29,'episode',23,?,'{}')")
    .run(JSON.stringify({factory:'remotion-history-factory',jobId:f.jobId,scriptHash}))
  f.db.prepare("INSERT INTO episodes VALUES(23,'completed',?,?)")
    .run(JSON.stringify({historyFactory:{...factory,jobId:f.jobId}}),rendered)
  for (const [kind,filename] of [['episode',rendered],['preview',preview]]) f.db.prepare("INSERT INTO remotion_renders VALUES(29,?,'succeeded',?,?,?)")
    .run(kind,f.sha,filename,JSON.stringify({jobId:f.jobId}))
  return {...f,rendered,preview}
}

test('all three published factory copies release while narration, previews and records remain',async t=>{
  const f=await publishedFactoryFixture(t),scan=await f.manager.scan()
  assert.deepEqual(scan.items.filter(item=>item.kind==='published-video').map(item=>item.path).sort(),[f.delivery,f.original,f.rendered].sort())
  assert.equal(scan.items.some(item=>item.kind==='duplicate-material'),false)
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,3);assert.deepEqual(run.lastRun!.errors,[])
  for (const filename of [f.delivery,f.original,f.rendered]) await assert.rejects(readFile(filename),{code:'ENOENT'})
  assert.equal(await readFile(f.input,'utf8'),'retained production input')
  assert.equal(await readFile(f.preview,'utf8'),'preview retained')
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM remotion_renders').get() as any).count,2)
})

test('one cleanup parses each unchanged large input JSON once across all three factory copies',async t=>{
  const f=await publishedFactoryFixture(t),large=JSON.stringify({notes:'x'.repeat(8*1024*1024),plan:{inputs:[]}})
  f.db.prepare("INSERT INTO history_motion_productions VALUES('unrelated-large',99,'completed',?)").run(large)
  const parse=JSON.parse
  let checking=false,calls=0,largeParses=0
  t.mock.method(JSON,'parse',(value:string,...args:any[])=>{
    if(checking && value===large)largeParses++
    return Reflect.apply(parse,JSON,[value,...args])
  })
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:(...args)=>{
    if(++calls>1)checking=true
    return discoverPublishedMedia(...args)
  }})
  const run=await manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,3);assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(largeParses,1)
})

test('startup maintenance scans with cleanup disabled and reuses the last successful scheduled checkpoint',async t=>{
  const f=await fixture(t)
  await f.put('data/static/startup.mp4')
  f.manager.updatePolicy({autoCleanup:false})
  const disabled=f.manager.start()
  try {
    assert.equal(f.manager.start(),disabled)
    await disabled.tick()
    assert.equal(f.manager.reviewList().total,1)
    assert.equal(f.manager.runtime().activity?.operation,'scan')
    assert.equal(f.manager.runtime().scheduler?.state,'waiting')
    assert.equal((await f.manager.summary()).lastRun,undefined)
  }finally{await disabled.stop()}
  f.manager.updatePolicy({autoCleanup:true})
  const enabled=f.manager.start()
  try {await enabled.tick()}finally{await enabled.stop()}
  const first=(await f.manager.summary()).lastRun!
  assert.equal(first.trigger,'scheduled')
  const restarted=createStorageManager({db:f.db,projectRoot:f.root,published:()=>[]}),worker=restarted.start()
  try {
    await worker.tick()
    assert.equal(restarted.runtime().activity?.operation,'scan')
    assert.equal((await restarted.summary()).lastRun!.id,first.id)
  }finally{await worker.stop()}
})

test('runtime status exposes persisted slow cleanup stages for the independent service',async t=>{
  const f=await fixture(t),at=new Date().toISOString()
  f.db.prepare('INSERT INTO storage_cleanup_runs VALUES(?,?,?,?,?)').run('slow-run',at,at,'completed',JSON.stringify({
    id:'slow-run',startedAt:at,finishedAt:at,freedBytes:0,removedCount:0,errors:[],
    actions:[{path:'/recorded/movie.mp4',timingsMs:{liveInputs:1500,unlink:12,transactionBody:1600}}],
  }))
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:()=>[]})
  assert.deepEqual(manager.runtime().slowStages.map(row=>[row.phase,row.elapsedMs]),[['transactionBody',1600],['liveInputs',1500]])
  assert.equal((await manager.summary()).slowStages[0]!.runId,'slow-run')
})

for (const protection of ['pin','input','changed-bytes'] as const) test(`${protection} preserves the third factory copy`,async t=>{
  const f=await publishedFactoryFixture(t)
  if (protection==='pin') {
    await f.manager.scan();f.manager.registry.pin(f.manager.registry.byPath(f.rendered)!.id,true)
  } else if (protection==='input') {
    f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT,status TEXT)')
    f.db.prepare("INSERT INTO remotion_assets VALUES(30,?,'completed')").run(f.rendered)
  } else await writeFile(f.rendered,'replacement third copy')
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,2);assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(await readFile(f.rendered,'utf8'),protection==='changed-bytes' ? 'replacement third copy' : f.bytes)
  assert.equal(await readFile(f.preview,'utf8'),'preview retained')
})

test('published delivery and its exact producer original release once without duplicate candidates or deleting inputs',async t=>{
  const f=await publishedMotionFixture(t),scan=await f.manager.scan()
  assert.deepEqual(scan.items.map(item=>[item.kind,item.path]).sort(),[
    ['published-video',f.delivery],['published-video',f.original],
  ].sort())
  assert.equal(scan.groups.find(group=>group.kind==='published-video')!.bytes,2*Buffer.byteLength(f.bytes))
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,2);assert.deepEqual(run.lastRun!.errors,[])
  await assert.rejects(readFile(f.delivery),{code:'ENOENT'});await assert.rejects(readFile(f.original),{code:'ENOENT'})
  assert.equal(await readFile(f.input,'utf8'),'retained production input')
})

test('published deletion rechecks current workflow references added after inventory',async t=>{
  const f=await fixture(t),bytes='published video',sha=createHash('sha256').update(bytes).digest('hex'),delivery=await f.put('data/static/history-deliveries/1/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',bytes)
  f.db.exec(`CREATE TABLE history_video_deliveries(id INTEGER,script_id INTEGER,script_sha256 TEXT,producer TEXT,producer_job_id TEXT,video_path TEXT,video_sha256 TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER,source_id INTEGER,video_id INTEGER,target TEXT,publication_mode TEXT,status TEXT,payload_json TEXT,result_json TEXT,fingerprint TEXT,updated_at TEXT,video_producer TEXT);
    CREATE TABLE episodes(id INTEGER,status TEXT,source_video_url TEXT);`)
  const scriptSha=createHash('sha256').update('current script').digest('hex')
  f.db.prepare("INSERT INTO history_script_sources(id,platform,status,rewritten_script,media_json) VALUES(1,'youtube','recreated','current script','{}')").run()
  f.db.prepare('INSERT INTO history_video_deliveries VALUES(1,1,?,?,?,?,?)').run(scriptSha,'manual',null,delivery.replace(path.join(f.root,'data'),''),sha)
  const payload={jobId:'1',scriptId:1,target:'baijiahao-video',publicationMode:'publish',videoPath:delivery,fingerprint:'f'.repeat(64),accountName:'history_baijiahao'}
  const receipt={staged:true,targetId:'target',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',submitted:true,saved:false,published:true,publicationStatus:'published',articleId:'123',publishedUrl:'https://baijiahao.baidu.com/s?id=123',accountName:'history_baijiahao'}
  f.db.prepare("INSERT INTO history_social_upload_jobs VALUES(1,1,1,'baijiahao-video','publish','completed',?,?,?,?,NULL)").run(JSON.stringify(payload),JSON.stringify(receipt),payload.fingerprint,new Date(Date.now()-1000).toISOString())
  let calls=0
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:(...args:Parameters<typeof discoverPublishedMedia>)=>{const candidates=discoverPublishedMedia(...args);if(++calls===2)f.db.prepare('INSERT INTO episodes VALUES(2,?,?)').run('running',delivery);return candidates}})
  const run=await manager.cleanup(['published-video'])
  assert.ok(calls>=2);assert.equal(run.lastRun!.removedCount,0);assert.deepEqual(run.lastRun!.errors,[]);assert.equal(await readFile(delivery,'utf8'),bytes)
  assert.match(JSON.stringify(run.lastRun!.actions),/episode:2/)
})

test('published deletion protects nested Remotion inputs created after inventory',async t=>{
  const f=await publishedMotionFixture(t)
  f.db.exec('CREATE TABLE remotion_renders(project_id INTEGER,status TEXT,props_json TEXT)')
  let calls=0
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:(...args)=>{
    const candidates=discoverPublishedMedia(...args)
    if(++calls===2) f.db.prepare('INSERT INTO remotion_renders VALUES(2,?,?)')
      .run('queued',JSON.stringify({scenes:[{assets:{movie:f.delivery}}]}))
    return candidates
  }})
  const run=await manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,1);assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(await readFile(f.delivery,'utf8'),f.bytes)
  await assert.rejects(readFile(f.original),{code:'ENOENT'})
  assert.match(JSON.stringify(run.lastRun!.actions),/remotion:2/)
})

for (const change of ['pin','input','receipt'] as const) test(`published deletion rechecks ${change} changes while hashing`,async t=>{
  const f=await publishedMotionFixture(t)
  let calls=0,changed=false
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:(...args)=>{
    const candidates=discoverPublishedMedia(...args)
    if (++calls===2) queueMicrotask(()=>{
      if (change==='pin') manager.registry.pin(manager.registry.byPath(f.delivery)!.id,true)
      if (change==='input') f.db.prepare('INSERT INTO creation_tasks VALUES(?,?,?)')
        .run('new-consumer','queued',JSON.stringify({assets:[{video:f.delivery}]}))
      if (change==='receipt') f.db.prepare('UPDATE history_social_upload_jobs SET result_json=?')
        .run(JSON.stringify({...f.receipt,published:false,publicationStatus:'submitted'}))
      changed=true
    })
    return candidates
  }})
  const run=await manager.cleanup(['published-video'])
  assert.equal(changed,true);assert.equal(run.lastRun!.removedCount,change==='receipt' ? 0 : 1)
  assert.deepEqual(run.lastRun!.errors,[]);assert.equal(await readFile(f.delivery,'utf8'),f.bytes)
  const action=run.lastRun!.actions.find((action:any)=>action.path===f.delivery) as any
  assert.equal(action.status,'retained')
})

test('publication authorization holds a database write lock until synchronous removal',async t=>{
  const f=await publishedMotionFixture(t,true),other=new Database(path.join(f.root,'fixture.db'),{timeout:0})
  t.after(()=>other.close())
  let attempts=0
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:(...args)=>{
    const candidates=discoverPublishedMedia(...args)
    if (f.db.inTransaction) {
      attempts++
      assert.throws(()=>other.prepare('INSERT INTO creation_tasks VALUES(?,?,?)')
        .run('racing-consumer','queued',JSON.stringify({video:f.delivery})),{code:'SQLITE_BUSY'})
    }
    return candidates
  }})
  const run=await manager.cleanup(['published-video'])
  assert.equal(attempts,2);assert.equal(run.lastRun!.removedCount,2);assert.deepEqual(run.lastRun!.errors,[])
  await assert.rejects(readFile(f.delivery),{code:'ENOENT'})
})

test('a same-byte file replacement after hashing is retained by the final identity check',async t=>{
  const f=await publishedMotionFixture(t)
  let replaced=false
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:(...args)=>{
    const candidates=discoverPublishedMedia(...args)
    if (f.db.inTransaction && !replaced) {
      writeFileSync(f.delivery+'.replacement',f.bytes)
      renameSync(f.delivery+'.replacement',f.delivery)
      replaced=true
    }
    return candidates
  }})
  const run=await manager.cleanup(['published-video'])
  assert.equal(replaced,true);assert.equal(run.lastRun!.removedCount,1)
  assert.equal(run.lastRun!.errors.length,1);assert.match(run.lastRun!.errors[0]!,/核验期间成片发生变化/)
  assert.equal(await readFile(f.delivery,'utf8'),f.bytes)
})

test('large input snapshots are inspected before the final write lock, and the lock stays short',async t=>{
  const f=await publishedMotionFixture(t),queriesInLock:string[]=[]
  f.db.prepare("INSERT INTO history_motion_productions VALUES('large-unrelated',99,'completed',?)")
    .run(JSON.stringify({notes:'x'.repeat(32*1024*1024),plan:{inputs:[]}}))
  const prepare=f.db.prepare.bind(f.db),transaction=f.db.transaction.bind(f.db)
  const parse=JSON.parse
  let longestLockMs=0,largeParsesInLock=0,boundBytesInLock=0
  t.mock.method(JSON,'parse',(value:string,...args:any[])=>{
    if(f.db.inTransaction && value.length>1024*1024)largeParsesInLock++
    return Reflect.apply(parse,JSON,[value,...args])
  })
  f.db.prepare=((sql:string)=>{
    if(f.db.inTransaction)queriesInLock.push(sql)
    const statement=prepare(sql)
    if(sql.startsWith('WITH expected')) {
      const get=statement.get
      statement.get=((...values:unknown[])=>{
        if(f.db.inTransaction)boundBytesInLock+=values.reduce<number>((sum,value)=>sum+(Buffer.isBuffer(value) ? value.length : 0),0)
        return Reflect.apply(get,statement,values)
      }) as typeof statement.get
    }
    return statement
  }) as typeof f.db.prepare
  f.db.transaction=((operation: (...args:any[])=>any)=>transaction((...args:any[])=>{
    const started=performance.now()
    try{return operation(...args)}finally{longestLockMs=Math.max(longestLockMs,performance.now()-started)}
  })) as typeof f.db.transaction
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,2);assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(queriesInLock.some(sql=>/SELECT\s+\*\s+FROM\s+(?:history_motion_productions|creation_tasks|remotion_renders)/i.test(sql)),false)
  assert.equal(queriesInLock.some(sql=>/WITH expected\(/.test(sql)),false,'comparison SQL must be compiled before acquiring the write lock')
  assert.equal(largeParsesInLock,0)
  assert.equal(boundBytesInLock,0,'large expected values must be bound before acquiring the write lock')
  assert.ok(longestLockMs<250,`final write lock took ${longestLockMs.toFixed(1)} ms`)
  t.diagnostic(`32 MiB snapshot: longest final write lock ${longestLockMs.toFixed(2)} ms`)
})

test('the first publication transaction records every stage and can stop at unlink without removing media',async t=>{
  const f=await publishedMotionFixture(t)
  const originalUnlink=fs.unlinkSync
  t.mock.method(fs,'unlinkSync',(filename:fs.PathLike)=>{
    if (String(filename)===f.delivery) throw Error('isolated probe stopped before unlink')
    return originalUnlink(filename)
  })
  syncBuiltinESMExports()
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(await readFile(f.delivery,'utf8'),f.bytes)
  assert.equal(run.lastRun!.removedCount,1)
  const first=run.lastRun!.actions.find((action:any)=>action.path===f.delivery) as any
  assert.match(run.lastRun!.errors[0]!,/isolated probe stopped before unlink/)
  for (const phase of ['prepareInputs','warmInputs','livePublication','liveInputs','fileIdentity','authorize','unlink','transactionBody','transactionTotal']) {
    assert.equal(typeof first.timingsMs?.[phase],'number',phase)
    assert.ok(first.timingsMs[phase]>=0,phase)
  }
  assert.equal(first.timingsMs.release,undefined)
})

for (const writer of ['other-connection','same-connection','schema-change','receipt','pin','retention'] as const) test(`${writer} changes after input preparation invalidate deletion before the write lock`,async t=>{
  const f=await publishedMotionFixture(t,true),other=new Database(path.join(f.root,'fixture.db'),{timeout:0})
  t.after(()=>other.close())
  const transaction=f.db.transaction.bind(f.db)
  let changed=false
  f.db.transaction=((operation:(...args:any[])=>any)=>{
    const tx=transaction(operation)
    return Object.assign((...args:any[])=>Reflect.apply(tx,f.db,args),{
      immediate:(...args:any[])=>{
        if (!changed) {
          if (writer==='schema-change') f.db.exec('CREATE TABLE newly_created_workflow(id INTEGER)')
          else if (writer==='receipt') other.prepare('UPDATE history_social_upload_jobs SET result_json=?').run(JSON.stringify({...f.receipt,published:false,publicationStatus:'submitted'}))
          else if (writer==='pin') other.prepare('UPDATE storage_artifacts SET pinned=1 WHERE path=?').run(f.delivery)
          else if (writer==='retention') other.prepare('INSERT OR REPLACE INTO storage_policy VALUES(1,?)').run(JSON.stringify({autoCleanup:false,retentionDays:90}))
          else (writer==='other-connection' ? other : f.db).prepare('INSERT INTO creation_tasks VALUES(?,?,?)')
            .run('new-consumer','queued',JSON.stringify({assets:[{video:f.delivery}]}))
          changed=true
        }
        return Reflect.apply(tx.immediate,tx,args)
      },
    })
  }) as typeof f.db.transaction
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(changed,true);assert.equal(run.lastRun!.removedCount,writer==='receipt' || writer==='retention' ? 0 : 1);assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(await readFile(f.delivery,'utf8'),f.bytes)
  assert.equal((run.lastRun!.actions.find((action:any)=>action.path===f.delivery) as any).status,'retained')
})

test('unrelated progress heartbeats after input preparation do not prevent published cleanup',async t=>{
  const f=await publishedMotionFixture(t,true),other=new Database(path.join(f.root,'fixture.db'),{timeout:0})
  t.after(()=>other.close())
  f.db.exec("ALTER TABLE creation_tasks ADD COLUMN heartbeat INTEGER DEFAULT 0; INSERT INTO creation_tasks VALUES('unrelated','running','{}',0)")
  const transaction=f.db.transaction.bind(f.db)
  let heartbeats=0
  f.db.transaction=((operation:(...args:any[])=>any)=>{
    const tx=transaction(operation)
    return Object.assign((...args:any[])=>Reflect.apply(tx,f.db,args),{immediate:(...args:any[])=>{
      other.prepare("UPDATE creation_tasks SET heartbeat=heartbeat+1 WHERE id='unrelated'").run();heartbeats++
      return Reflect.apply(tx.immediate,tx,args)
    }})
  }) as typeof f.db.transaction
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(heartbeats,2);assert.equal(run.lastRun!.removedCount,2);assert.deepEqual(run.lastRun!.errors,[])
  await assert.rejects(readFile(f.delivery),{code:'ENOENT'})
})

test('inventory registers bounded atomic batches and yields to another database writer',async t=>{
  const f=await fixture(t,true),other=new Database(path.join(f.root,'fixture.db'),{timeout:0})
  t.after(()=>other.close())
  await Promise.all(Array.from({length:601},(_,index)=>f.put(`data/static/inventory-${index}.mp4`)))
  const track=f.manager.registry.track
  const batches:number[]=[],writerErrors:unknown[]=[]
  let wroteBetweenBatches=false,heartbeat=false,longestBatchMs=0
  f.manager.registry.track=(files)=>{
    if (batches.length && heartbeat) wroteBetweenBatches=true
    const start=performance.now();track(files);longestBatchMs=Math.max(longestBatchMs,performance.now()-start)
    batches.push(files.length)
    queueMicrotask(()=>{try{other.prepare("INSERT OR REPLACE INTO storage_policy VALUES(1,'{}')").run();heartbeat=true}catch(error){writerErrors.push(error)}})
  }
  await f.manager.scan()
  assert.equal(f.manager.reviewList().total,601)
  assert.ok(batches.length>=3);assert.ok(Math.max(...batches)<=250)
  assert.equal(wroteBetweenBatches,true);assert.deepEqual(writerErrors,[])
  for (const file of f.manager.reviewList({limit:150}).items) assert.equal(file.owners.length,1)
  t.diagnostic(`601 inventory files: ${batches.length} transactions, longest ${longestBatchMs.toFixed(2)} ms`)
})

test('producer metadata cannot authorize release when the actual original bytes differ',async t=>{
  const f=await publishedMotionFixture(t)
  await writeFile(f.original,'replacement movie needing its own receipt')
  const scan=await f.manager.scan()
  assert.deepEqual(scan.items.filter(item=>item.kind==='published-video').map(item=>item.path),[f.delivery])
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,1);assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(await readFile(f.original,'utf8'),'replacement movie needing its own receipt')
})

for(const protection of ['pinned','shared-input','active-input','submitted'] as const) test(`${protection} preserves a producer original despite a matching delivery`,async t=>{
  const f=await publishedMotionFixture(t)
  if(protection==='pinned') {
    await f.manager.scan();f.manager.registry.pin(f.manager.registry.byPath(f.original)!.id,true)
  } else if(protection==='submitted') {
    f.db.prepare('UPDATE history_social_upload_jobs SET result_json=?').run(JSON.stringify({...f.receipt,published:false,publicationStatus:'submitted'}))
  } else {
    f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT,status TEXT)')
    f.db.prepare('INSERT INTO remotion_assets VALUES(2,?,?)').run(f.original,protection==='active-input' ? 'rendering' : 'completed')
  }
  const scan=await f.manager.scan()
  assert.equal(scan.items.some(item=>item.kind==='published-video' && item.path===f.original),false)
  const run=await f.manager.cleanup(['published-video'])
  assert.deepEqual(run.lastRun!.errors,[])
  assert.equal(await readFile(f.original,'utf8'),f.bytes)
  assert.equal(run.lastRun!.removedCount,protection==='submitted' ? 0 : 1)
  assert.equal(await readFile(f.input,'utf8'),'retained production input')
})

test('Huasheng release hashes its exact export and preserves another producer movie from the same source',async t=>{
  const f=await publishedMotionFixture(t),projectHash='b'.repeat(64)
  const exported=await f.put(`data/huasheng-exports/900/video_${projectHash}.mp4`,f.bytes)
  f.db.exec(`UPDATE history_video_deliveries SET producer='huasheng',producer_job_id='71';
    UPDATE history_social_upload_jobs SET video_producer='huasheng';
    CREATE TABLE history_huasheng_export_jobs(id INTEGER,huasheng_job_id INTEGER,source_id INTEGER,script_sha256 TEXT,status TEXT,project_url TEXT,project_hash TEXT,file_path TEXT);`)
  f.db.prepare('INSERT INTO history_huasheng_export_jobs VALUES(1,71,1,?,?,?,?,?)')
    .run(createHash('sha256').update('current script').digest('hex'),'completed','https://www.huasheng.cn/video/900',projectHash,exported)
  await writeFile(exported,'different exported movie')
  assert.deepEqual((await f.manager.scan()).items.filter(item=>item.kind==='published-video').map(item=>item.path),[f.delivery])
  await writeFile(exported,f.bytes)
  const scan=await f.manager.scan()
  assert.deepEqual(scan.items.filter(item=>item.kind==='published-video').map(item=>item.path).sort(),[f.delivery,exported].sort())
  const run=await f.manager.cleanup(['published-video'])
  assert.equal(run.lastRun!.removedCount,2);assert.deepEqual(run.lastRun!.errors,[])
  await assert.rejects(readFile(exported),{code:'ENOENT'})
  assert.equal(await readFile(f.original,'utf8'),f.bytes)
})

test('immutable copies are retained while a consumer is validating or an upload is uncertain',async t=>{
  const f=await fixture(t),bytes='immutable saved bytes',sha=createHash('sha256').update(bytes).digest('hex')
  const first=await f.put('data/huasheng-recommendations/a/a.mp4',bytes),second=await f.put('data/huasheng-recommendations/b/b.mp4',bytes)
  for (const [file,owner] of [[first,'first'],[second,'second']]) f.db.prepare('INSERT INTO huasheng_material_files VALUES(?,?,?,?,?,?,?)').run(file,'asset',owner,'clip',bytes.length,sha,'2026-01-01')
  f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT,status TEXT)')
  f.db.prepare('INSERT INTO remotion_assets VALUES(2,?,?)').run(second,'validating')
  await f.manager.cleanup(['duplicate-material'])
  assert.notEqual((await stat(first)).ino,(await stat(second)).ino)
  assert.equal(await readFile(second,'utf8'),bytes)
})

test('corrupt or symlinked material copies are never replaced', async t => {
  const f = await fixture(t), bytes = 'original'
  const a = await f.put('data/huasheng-recommendations/a/a.mp4',bytes), b = await f.put('data/huasheng-recommendations/b/b.mp4','changed!')
  const sha = createHash('sha256').update(bytes).digest('hex')
  for (const file of [a,b]) f.db.prepare('INSERT INTO huasheng_material_files VALUES(?,?,?,?,?,?,?)').run(file,'asset','owner','clip',bytes.length,sha,'2026-01-01')
  const result = await f.manager.cleanup(['duplicate-material'])
  assert.ok(result.lastRun!.errors.length)
  assert.equal(await readFile(b,'utf8'),'changed!')
  const outside = await f.put('outside.mp4',bytes)
  await rm(b); await symlink(outside,b)
  await f.manager.cleanup(['duplicate-material'])
  assert.equal(await readFile(outside,'utf8'),bytes)
})

test('manual review needs unchanged bytes, no live consumer, and explicit upload evidence', async t => {
  const f = await fixture(t)
  const file = await f.put('data/cba-video/job/final.mp4')
  await f.manager.scan()
  const id = f.manager.registry.byPath(file)!.id
  const inspection = await f.manager.inspect(id)
  await assert.rejects(f.manager.review(id,{action:'delete',sha256:inspection.sha256,productionVerified:true,uploadVerified:false,receiptUrls:[]}))
  assert.equal(await readFile(file,'utf8'),'media bytes')
  await writeFile(file,'new bytes')
  await assert.rejects(f.manager.review(id,{action:'delete',sha256:inspection.sha256,productionVerified:true,uploadVerified:true,receiptUrls:['https://baijiahao.baidu.com/test']}))
})

test('verified archive preserves project paths and a pin prevents automatic deletion', async t => {
  const f = await fixture(t)
  const file = await f.put('data/cba-video/job/source.mp4'), backup = await f.put('external/source.mp4')
  await f.manager.scan()
  const id = f.manager.registry.byPath(file)!.id, inspection = await f.manager.inspect(id)
  await f.manager.review(id,{action:'keep',sha256:inspection.sha256})
  assert.equal(f.manager.registry.get(id)!.pinned,1)
  await f.manager.review(id,{action:'archive',sha256:inspection.sha256,backupPath:backup,productionVerified:true,uploadVerified:true,receiptUrls:['https://example.com/receipt']})
  assert.equal(f.manager.registry.get(id)!.state,'archived')
  await assert.rejects(readFile(file,'utf8'))
  await f.manager.restore(id)
  assert.equal(await readFile(file,'utf8'),'media bytes')
})

function seedCompleteSource(f:any) {
  const hash='a'.repeat(64),audio='b'.repeat(64),text='complete transcript'
  f.db.prepare(`INSERT INTO history_script_sources(id,platform,source_video_id,source_url,status,media_json,raw_transcript,asr_json,updated_at)
    VALUES(1,'youtube','abcdefghijk','https://www.youtube.com/watch?v=abcdefghijk','needs_review',?,?,?,?)`).run(
      JSON.stringify({videoSha256:hash,chunks:[{start:0,duration:10,sha256:audio}]}),text,
      JSON.stringify({complete:true,text,sourceVideoSha256:hash,chunks:[{index:0,start:0,duration:10,audioSha256:audio}]}),new Date().toISOString())
}

test('a completed transcript cannot release a file used as another project input',async t=>{
  const f=await fixture(t);seedCompleteSource(f)
  const file=await f.put('data/storage/history-scripts/1/source.mp4')
  await f.put('data/storage/history-scripts/1/audio-000.wav')
  f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT,status TEXT)')
  f.db.prepare('INSERT INTO remotion_assets VALUES(2,?,?)').run(file,'completed')
  assert.equal((await f.manager.scan()).items.some(item=>item.kind==='transcribed-source'),false)
  assert.equal(f.manager.registry.owners(f.manager.registry.byPath(file)!.id).length,2)
  await f.manager.cleanup()
  assert.equal(await readFile(file,'utf8'),'media bytes')
})

test('frozen project and shot references protect sources even after the current asset was replaced',async t=>{
  const f=await fixture(t);seedCompleteSource(f)
  const file=await f.put('data/storage/history-scripts/1/source.mp4')
  await f.put('data/storage/history-scripts/1/audio-000.wav')
  f.db.exec('CREATE TABLE remotion_projects(id INTEGER,status TEXT,source_snapshot_json TEXT); CREATE TABLE remotion_shots(project_id INTEGER,status TEXT,visual_plan_json TEXT,source_evidence_json TEXT)')
  const relative=path.relative(f.root,file)
  f.db.prepare('INSERT INTO remotion_projects VALUES(2,?,?)').run('draft',JSON.stringify({storyboards:[{videoPath:relative}]}))
  f.db.prepare('INSERT INTO remotion_shots VALUES(3,?,?,?)').run('completed','{}',JSON.stringify({originalVideo:relative}))
  assert.equal((await f.manager.scan()).items.some(item=>item.kind==='transcribed-source'),false)
  assert.equal(f.manager.registry.owners(f.manager.registry.byPath(file)!.id).length,3)
})

test('project metadata cannot be archived out of the task directory',async t=>{
  const f=await fixture(t),file=await f.put('data/cba-video/job/job.json','{}'),backup=await f.put('external/job.json','{}')
  await f.manager.scan()
  const id=f.manager.registry.byPath(file)!.id,inspection=await f.manager.inspect(id)
  assert.equal(inspection.archiveAllowed,false)
  await assert.rejects(f.manager.review(id,{action:'archive',sha256:inspection.sha256,backupPath:backup}),/工程记录/)
  assert.equal(await readFile(file,'utf8'),'{}')
})

test('unknown historical output requires a verified task association before human deletion',async t=>{
  const f=await fixture(t);seedCompleteSource(f)
  const file=await f.put('data/static/remotion/legacy-movie.mp4')
  await f.manager.scan()
  const id=f.manager.registry.byPath(file)!.id,inspection=await f.manager.inspect(id)
  assert.equal(inspection.ownershipUnconfirmed,true)
  const proof={action:'delete' as const,sha256:inspection.sha256,productionVerified:true,uploadVerified:true,receiptUrls:['https://example.com/published']}
  await assert.rejects(f.manager.review(id,proof),/归属待确认/)
  await assert.rejects(f.manager.associate(id,{sha256:inspection.sha256,ownerType:'history-source',ownerId:'999'}),/任务不存在/)
  await f.manager.associate(id,{sha256:inspection.sha256,ownerType:'history-source',ownerId:'1'})
  assert.equal((await f.manager.inspect(id)).ownershipUnconfirmed,false)
  const review=JSON.parse(f.manager.registry.get(id)!.review_json)
  assert.equal(review.associations[0].method,'manual')
  assert.equal(review.associations[0].sha256,inspection.sha256)
  assert.equal((await f.manager.review(id,proof)).status,'released')
  await assert.rejects(readFile(file),{code:'ENOENT'})
})

test('producer output reports establish ownership without treating their own movie as an input',async t=>{
  const f=await fixture(t),job='11111111-1111-1111-1111-111111111111'
  const file=await f.put(`data/storage/history-motion/${job}/render-1/movie.mp4`)
  f.db.exec('CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT)')
  f.db.prepare('INSERT INTO history_motion_productions VALUES(?,1,?,?)').run(job,'completed',JSON.stringify({outputPath:file,plan:{delivery:{output:file,preview:file+'-preview.mp4'},shots:[]}}))
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:()=>[{path:file,sourceId:1,sha256:'a'.repeat(64),reason:'verified',evidence:{}}] as any})
  const scan=await manager.scan()
  assert.equal(scan.items.filter(item=>item.kind==='published-video').length,1)
  assert.equal(manager.registry.owners(manager.registry.byPath(file)!.id).some(owner=>owner.purpose==='source'),false)
})

test('a foreign consumer of a cached copy protects its entire render cache',async t=>{
  const f=await fixture(t),job='11111111-1111-1111-1111-111111111111'
  const base=`data/storage/history-motion/${job}/render-1/movie.mp4`
  const file=await f.put(base+'.render/public/assets/picture.png')
  await f.put(base+'.render/delivery.json','{}')
  await f.put(base+'.json',JSON.stringify({status:'completed',qa:{technical:'passed'}}))
  f.db.exec('CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT); CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT,status TEXT)')
  f.db.prepare('INSERT INTO history_motion_productions VALUES(?,1,?,?)').run(job,'completed','{}')
  f.db.prepare('INSERT INTO remotion_assets VALUES(2,?,?)').run(file,'completed')
  assert.equal((await f.manager.scan()).items.some(item=>item.kind==='render-cache'),false)
  await f.manager.cleanup(['render-cache'])
  assert.equal(await readFile(file,'utf8'),'media bytes')
})

test('pinning one source preserves the whole directory even when other chunks are eligible',async t=>{
  const f=await fixture(t);seedCompleteSource(f)
  const file=await f.put('data/storage/history-scripts/1/source.mp4')
  await f.put('data/storage/history-scripts/1/audio-000.wav')
  await f.manager.scan();const id=f.manager.registry.byPath(file)!.id
  f.manager.registry.pin(id,true)
  let released=0
  const manager=createStorageManager({db:f.db,projectRoot:f.root,releaseSource:async()=>{released++},published:()=>[]})
  await manager.cleanup(['transcribed-source'])
  assert.equal(released,0);assert.equal(await readFile(file,'utf8'),'media bytes')
})

test('a source group is released once without treating its removed siblings as failures',async t=>{
  const f=await fixture(t);seedCompleteSource(f)
  const files=[await f.put('data/storage/history-scripts/1/source.mp4'),await f.put('data/storage/history-scripts/1/audio-000.wav')]
  let releases=0
  const manager=createStorageManager({db:f.db,projectRoot:f.root,published:()=>[],releaseSource:async()=>{
    releases++;for (const file of files) await rm(file)
  }})
  const result=await manager.cleanup(['transcribed-source'])
  assert.equal(releases,1);assert.equal(result.lastRun!.errors.length,0)
  assert.equal(result.lastRun!.removedCount,2);assert.equal(result.lastRun!.actions.length,1)
  assert.equal(result.lastRun!.reclaimedFileBytes,22)
  for (const file of files) assert.equal(manager.registry.byPath(file)!.state,'released')
})

test('maintenance reports live work in another process and recovers only a dead process lock',async t=>{
  const f=await fixture(t),lock=await f.put('data/storage/maintenance.lock',JSON.stringify({pid:process.pid}))
  assert.equal((await f.manager.summary()).running,true)
  await assert.rejects(f.manager.scan(),/其他进程/)
  await writeFile(lock,JSON.stringify({pid:2147483647}))
  assert.equal((await f.manager.scan()).running,false)
  await assert.rejects(readFile(lock),{code:'ENOENT'})
})

test('human-verified final deletion is audited, but shared inputs and unfinished uploads stay',async t=>{
  const f=await fixture(t),file=await f.put('data/cba-video/job/final.mp4')
  await f.put('data/cba-video/job/job.json',JSON.stringify({status:'rendered',outputs:{news:{path:file}}}))
  await f.manager.scan();const id=f.manager.registry.byPath(file)!.id,inspection=await f.manager.inspect(id)
  assert.equal(inspection.role,'final')
  const proof={action:'delete' as const,sha256:inspection.sha256,productionVerified:true,uploadVerified:true,receiptUrls:['https://example.com/published']}
  await f.put('data/cba-video/.console.json',JSON.stringify({uploads:[{jobId:'job',status:'uncertain'}]}))
  await assert.rejects(f.manager.review(id,proof),/上传|生产/)
  await f.put('data/cba-video/.console.json','{}')
  f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT,status TEXT)')
  f.db.prepare('INSERT INTO remotion_assets VALUES(3,?,?)').run(file,'completed')
  await assert.rejects(f.manager.review(id,proof),/工程输入/)
  assert.equal(await readFile(file,'utf8'),'media bytes')
  const other=await f.put('data/cba-video/other/final.mp4')
  await f.put('data/cba-video/other/job.json',JSON.stringify({status:'rendered',outputs:{news:{path:other}}}))
  await f.manager.scan();const otherId=f.manager.registry.byPath(other)!.id
  const result=await f.manager.review(otherId,{...proof,sha256:(await f.manager.inspect(otherId)).sha256})
  assert.equal(result.status,'released');await assert.rejects(readFile(other))
  assert.equal(f.manager.registry.get(otherId)!.state,'released')
})
