import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {recordHistoryVideoDelivery,currentHistoryVideoDeliveries,listHistoryVideoDeliveries,
  ensureHistoryDualProductionSchema,recordHistoryDualProduction,recordHistoryRefinedBackfill,allowsHistoryVideoPublication} from './history-video-deliveries.js'
import { recordHistoryVideoPublication } from './history-video-deliveries.js'

test('two producers retain separate outputs, revisions and retry identities for the same manuscript',()=>{
  const sql=new Database(':memory:')
  try {
    const base={scriptId:1,scriptSha256:'a'.repeat(64),producerJobId:'one',videoName:'作品.mp4',duration:60}
    const flower=recordHistoryVideoDelivery(sql,{...base,producer:'huasheng',sha256:'b'.repeat(64),videoUrl:'/static/history-deliveries/1/b.mp4'})
    const motion=recordHistoryVideoDelivery(sql,{...base,producer:'motion',sha256:'c'.repeat(64),videoUrl:'/static/history-deliveries/1/c.mp4'})
    assert.deepEqual(new Set(currentHistoryVideoDeliveries(sql,1,base.scriptSha256).map(v=>v.id)),new Set([flower.id,motion.id]))
    assert.equal(recordHistoryVideoDelivery(sql,{...base,producer:'motion',sha256:motion.sha256,videoUrl:motion.videoUrl}).id,motion.id)
    recordHistoryVideoDelivery(sql,{...base,producer:'motion',sha256:'d'.repeat(64),videoUrl:'/static/history-deliveries/1/d.mp4'})
    assert.equal(currentHistoryVideoDeliveries(sql,1,base.scriptSha256).length,2)
    assert.equal(listHistoryVideoDeliveries(sql,1).length,3)
    assert.equal(currentHistoryVideoDeliveries(sql,1,'e'.repeat(64)).length,0)
  }finally{sql.close()}
})

test('existing production tables migrate to dual without changing their completed work',()=>{
  const sql=new Database(':memory:')
  try {
    sql.exec(`CREATE TABLE history_dual_production (
      source_id INTEGER NOT NULL,script_sha256 TEXT NOT NULL,huasheng_job_id INTEGER NOT NULL,
      motion_job_id TEXT,episode_id INTEGER,huasheng_state TEXT NOT NULL DEFAULT 'pending',
      motion_state TEXT NOT NULL DEFAULT 'pending',huasheng_error TEXT,motion_error TEXT,
      export_requested INTEGER NOT NULL DEFAULT 0,next_check_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(source_id,script_sha256));
      INSERT INTO history_dual_production(source_id,script_sha256,huasheng_job_id,motion_state,created_at,updated_at)
      VALUES(1,'script',9,'completed','before','before')`)
    ensureHistoryDualProductionSchema(sql)
    ensureHistoryDualProductionSchema(sql)
    assert.deepEqual(sql.prepare('SELECT production_mode,motion_state,huasheng_job_id,created_at FROM history_dual_production').get(),
      {production_mode:'dual',motion_state:'completed',huasheng_job_id:9,created_at:'before'})
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','huasheng'),true)
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','motion'),true)
  }finally{sql.close()}
})

test('explicit refined backfill permits only its new motion output and never downgrades an existing dual admission',()=>{
  const sql=new Database(':memory:')
  try {
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','motion'),false)
    recordHistoryRefinedBackfill(sql,1,'script',9)
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','motion'),true)
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','huasheng'),false)
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','manual'),false)
    assert.equal(allowsHistoryVideoPublication(sql,1,'other-script','motion'),false)
    const before=sql.prepare('SELECT * FROM history_dual_production WHERE source_id=1').get()
    recordHistoryRefinedBackfill(sql,1,'script',10)
    assert.deepEqual(sql.prepare('SELECT * FROM history_dual_production WHERE source_id=1').get(),before)
    recordHistoryDualProduction(sql,2,'script',11)
    recordHistoryRefinedBackfill(sql,2,'script',11)
    assert.equal(allowsHistoryVideoPublication(sql,2,'script','huasheng'),true)
    assert.equal(allowsHistoryVideoPublication(sql,2,'script','motion'),true)
  }finally{sql.close()}
})

test('explicit dual production upgrades a refined backfill while preserving all original work',()=>{
  const sql=new Database(':memory:')
  try {
    recordHistoryRefinedBackfill(sql,1,'script',9)
    sql.prepare(`UPDATE history_dual_production SET motion_job_id='kept-motion',episode_id=42,
      motion_state='started',motion_error='kept-warning' WHERE source_id=1`).run()
    const before=sql.prepare('SELECT * FROM history_dual_production WHERE source_id=1').get() as Record<string,unknown>
    recordHistoryDualProduction(sql,1,'script',10)
    const after=sql.prepare('SELECT * FROM history_dual_production WHERE source_id=1').get() as Record<string,unknown>
    assert.equal(after.production_mode,'dual')
    assert.equal(allowsHistoryVideoPublication(sql,1,'script','huasheng'),true)
    assert.deepEqual({...after,production_mode:before.production_mode,updated_at:before.updated_at},before)
    recordHistoryDualProduction(sql,1,'script',11)
    recordHistoryRefinedBackfill(sql,1,'script',12)
    assert.deepEqual(sql.prepare('SELECT * FROM history_dual_production WHERE source_id=1').get(),after)
    assert.equal((sql.prepare('SELECT count(*) AS n FROM history_dual_production').get() as {n:number}).n,1)
  }finally{sql.close()}
})

test('new producer registration preserves an existing legacy publish receipt or attempt for the same file',()=>{
  const sql=new Database(':memory:')
  const previousRoot=process.env.STORAGE_PATH
  process.env.STORAGE_PATH='/tmp/legacy-video-publication-fixture'
  try {
    sql.exec(`CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,target TEXT,
      publication_mode TEXT,video_id INTEGER,status TEXT,error TEXT,message TEXT,payload_json TEXT,result_json TEXT)`)
    const cases=[
      {status:'completed',result:{staged:true,targetId:'baijiahao-account',submitted:true,saved:false,published:false,
        publicationStatus:'submitted',articleId:'1880000000000000001',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit',
        publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880000000000000001'},expected:'completed'},
      {status:'completed',result:{submitted:true,saved:false},expected:'failed'},
      {status:'uncertain',result:{submitted:false,saved:false},expected:'failed'},
      {status:'failed',result:null,expected:'failed'},
      {status:'running',result:null,expected:'failed'},
      {status:'completed',result:{saved:true},expected:'failed'},
    ]
    for(const [index,item] of cases.entries()) {
      const id=index+1,scriptSha256='a'.repeat(64)
      const video=recordHistoryVideoDelivery(sql,{scriptId:id,scriptSha256,producer:'huasheng',producerJobId:String(id),
        videoUrl:`/static/history-deliveries/${id}/kept.mp4`,videoName:'kept.mp4',duration:30,sha256:String(id).repeat(64)})
      sql.prepare('INSERT INTO history_social_upload_jobs VALUES(?,?,?, ?,NULL,?,?,?,?,?)').run(id,id,'baijiahao-video','publish',item.status,
        item.status==='uncertain'?'原提交结果待核对':null,'保留原任务',JSON.stringify({videoPath:`${process.env.STORAGE_PATH}/history-deliveries/${id}/kept.mp4`}),JSON.stringify(item.result))
      const intent=recordHistoryVideoPublication(sql,id,scriptSha256,video.id,'huasheng') as {status:string;error:string|null}
      assert.equal(intent.status,item.expected)
      if(item.expected==='failed')assert.match(intent.error!,new RegExp(`原百家号发表任务 #${id}`))
      assert.equal((sql.prepare('SELECT video_id FROM history_social_upload_jobs WHERE id=?').get(id) as any).video_id,null,'original upload identity remains unchanged')
    }
  }finally{
    if(previousRoot===undefined)delete process.env.STORAGE_PATH
    else process.env.STORAGE_PATH=previousRoot
    sql.close()
  }
})

test('legacy canceled publication evidence keeps its original attempt while untouched cancellations allow new work',()=>{
  const sql=new Database(':memory:'),previousRoot=process.env.STORAGE_PATH
  process.env.STORAGE_PATH='/tmp/canceled-video-publication-fixture'
  try {
    sql.exec(`CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,target TEXT,
      publication_mode TEXT,video_id INTEGER,status TEXT,error TEXT,message TEXT,payload_json TEXT,result_json TEXT,
      upload_dispatched INTEGER,operation TEXT)`)
    for(const [index,evidence] of ['dispatched','result','recover','none'].entries()) {
      const id=index+1,scriptSha256='b'.repeat(64)
      const video=recordHistoryVideoDelivery(sql,{scriptId:id,scriptSha256,producer:'motion',producerJobId:String(id),
        videoUrl:`/static/history-deliveries/${id}/kept.mp4`,videoName:'kept.mp4',duration:20,sha256:String(id).repeat(64)})
      sql.prepare('INSERT INTO history_social_upload_jobs VALUES(?,?,?, ?,NULL,?,?,?,?,?,?,?)')
        .run(id,id,'baijiahao-video','publish','canceled',null,'原任务已取消',
          JSON.stringify({videoPath:`${process.env.STORAGE_PATH}/history-deliveries/${id}/kept.mp4`}),
          evidence==='result'?JSON.stringify({saved:false}):null,evidence==='dispatched'?1:0,evidence==='recover'?'recover':null)
      const intent=recordHistoryVideoPublication(sql,id,scriptSha256,video.id,'motion') as {status:string;error:string|null}
      assert.equal(intent.status,evidence==='none'?'pending':'failed')
      if(evidence!=='none')assert.match(intent.error!,new RegExp(`原百家号发表任务 #${id}`))
    }
  }finally {
    if(previousRoot===undefined)delete process.env.STORAGE_PATH
    else process.env.STORAGE_PATH=previousRoot
    sql.close()
  }
})
