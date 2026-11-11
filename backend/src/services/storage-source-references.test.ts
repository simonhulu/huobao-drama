import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { checkSourceMediaReferences, createSourceMediaReferenceInspector, inspectSourceMediaReferences, type SourceReferenceInput } from './storage-source-references.js'

const root = '/workspace/huobao-drama'
const filename = path.join(root,'data/storage/history-scripts/17/source.mp4')
const input: SourceReferenceInput = {directory:path.dirname(filename),files:[filename],ownerType:'history-source',ownerId:'17'}
function fixture(t: TestContext) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  return {db,read:(value = input) => inspectSourceMediaReferences(db,value,root)}
}
function registry(db: Database.Database) {
  db.exec(`CREATE TABLE storage_artifacts(id INTEGER,path TEXT,pinned INTEGER);
    CREATE TABLE storage_artifact_refs(artifact_id INTEGER,owner_type TEXT,owner_id TEXT);
    CREATE TABLE creation_tasks(id INTEGER,payload_json TEXT);`)
  db.prepare('INSERT INTO storage_artifacts VALUES(1,?,0)').run(filename)
}

test('registered ownership permits only the exact source and its own source-scoped creation task', t => {
  const f = fixture(t);registry(f.db)
  f.db.exec(`INSERT INTO storage_artifact_refs VALUES(1,'history-source','17'),(1,'creation-task','23');`)
  f.db.prepare('INSERT INTO creation_tasks VALUES(23,?)').run(JSON.stringify({sourceId:17}))
  assert.deepEqual(f.read(),[])
  for (const payload of [{sourceId:18},{sourceId:17,source_id:18},{episodeId:17},null]) {
    f.db.prepare('UPDATE creation_tasks SET payload_json=?').run(JSON.stringify(payload))
    assert.deepEqual(f.read().map(row => [row.ownerType,row.ownerId]),[['creation-task','23']])
  }
  f.db.prepare('UPDATE creation_tasks SET payload_json=?').run(JSON.stringify({source_id:'17'}))
  assert.deepEqual(f.read(),[])
  f.db.exec("INSERT INTO storage_artifact_refs VALUES(1,'history-source','18')")
  assert.equal(f.read()[0]!.ownerId,'18')
})

test('registry pins and science ownership aliases are evaluated without a prior maintenance scan', t => {
  const f = fixture(t);registry(f.db)
  f.db.exec("INSERT INTO storage_artifact_refs VALUES(1,'science','science-test'),(1,'science-job','science-test')")
  const science = {...input,ownerType:'science-job' as const,ownerId:'science-test'}
  assert.deepEqual(f.read(science),[])
  f.db.exec('UPDATE storage_artifacts SET pinned=1')
  assert.equal(f.read(science)[0]!.reason,'pinned')
  f.db.exec("UPDATE storage_artifacts SET pinned=0;UPDATE storage_artifact_refs SET owner_id='other-science' WHERE owner_type='science'")
  assert.equal(f.read(science)[0]!.ownerId,'other-science')
})

test('fresh Remotion assets and render props protect project-relative and decoded loopback media paths', t => {
  const f = fixture(t)
  const media = path.join(root,'data/static/shared/source.mp4')
  f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT);CREATE TABLE remotion_renders(project_id INTEGER,props_json TEXT)')
  f.db.prepare('INSERT INTO remotion_assets VALUES(4,?)').run('data/static/shared/source.mp4')
  f.db.prepare('INSERT INTO remotion_renders VALUES(5,?)')
    .run(JSON.stringify({shots:[{layers:[{src:'http://127.0.0.1:5679/static/shared/source%2Emp4?cache=1'}]}]}))
  const refs = f.read({...input,files:[media]})
  assert.deepEqual(refs.map(row => row.ownerId).sort(),['4','5'])
  assert.ok(refs.every(row => row.path === media))
  f.db.exec('DELETE FROM remotion_renders')
  f.db.prepare('INSERT INTO remotion_renders VALUES(5,?)').run(JSON.stringify({src:'https://elsewhere.test/static/shared/source.mp4'}))
  assert.deepEqual(f.read({...input,files:[media]}).map(row => row.ownerId),['4'])
})

test('episode inputs and storyboard nested cells retain source media independently of registry ownership', t => {
  const f = fixture(t)
  f.db.exec('CREATE TABLE episodes(id INTEGER,source_video_url TEXT);CREATE TABLE storyboards(episode_id INTEGER,grid_cells TEXT)')
  f.db.prepare('INSERT INTO episodes VALUES(31,?)').run(filename)
  f.db.prepare('INSERT INTO storyboards VALUES(32,?)').run(JSON.stringify({frames:[{audio:{src:filename}}]}))
  assert.deepEqual(f.read().map(row => [row.ownerType,row.ownerId]),[['episode','31'],['episode','32']])
})

test('project snapshots, shot plans and stage inputs and outputs each retain an unscanned reference', t => {
  const f = fixture(t)
  const schemas = [
    ['remotion_projects','id','source_snapshot_json'],['remotion_projects','id','metadata_json'],
    ['remotion_shots','project_id','visual_plan_json'],['remotion_shots','project_id','source_evidence_json'],
    ['remotion_stage_runs','project_id','input_json'],['remotion_stage_runs','project_id','output_json'],
  ]
  for (const [table,owner,field] of schemas) {
    f.db.exec(`CREATE TABLE ${table}(${owner} INTEGER,${field} TEXT)`)
    f.db.prepare(`INSERT INTO ${table} VALUES(42,?)`).run(JSON.stringify({evidence:{references:[filename]}}))
    assert.deepEqual(f.read().map(row => [row.ownerType,row.ownerId]),[['remotion','42']],field)
    f.db.exec(`DROP TABLE ${table}`)
  }
})

test('motion snapshots and other sources and tasks protect bytes even when the source identity is shared', t => {
  const f = fixture(t)
  f.db.exec(`CREATE TABLE history_motion_productions(id TEXT,snapshot TEXT);
    CREATE TABLE history_script_sources(id INTEGER,media_json TEXT,asr_json TEXT);
    CREATE TABLE creation_tasks(id INTEGER,payload_json TEXT);`)
  f.db.prepare('INSERT INTO history_motion_productions VALUES(?,?)').run('motion-a',JSON.stringify({scriptId:17,plan:{shots:[{sourcePath:filename}]}}))
  f.db.prepare('INSERT INTO history_script_sources VALUES(?,?,NULL)').run(17,JSON.stringify({videoPath:filename}))
  f.db.prepare('INSERT INTO history_script_sources VALUES(?,?,NULL)').run(18,JSON.stringify({chunks:[{path:filename}]}))
  f.db.prepare('INSERT INTO creation_tasks VALUES(23,?)').run(JSON.stringify({sourceId:18,input:{path:filename}}))
  assert.deepEqual(f.read().map(row => [row.ownerType,row.ownerId]),[['creation-task','23'],['history-source','18'],['history-motion','motion-a']])
})

test('malformed workflow JSON and incomplete ownership schemas fail closed', t => {
  const f = fixture(t)
  f.db.exec("CREATE TABLE remotion_renders(project_id INTEGER,props_json TEXT);INSERT INTO remotion_renders VALUES(4,'{')")
  assert.throws(() => f.read(),SyntaxError)
  f.db.exec('DROP TABLE remotion_renders;CREATE TABLE storage_artifacts(id INTEGER,path TEXT)')
  assert.throws(() => f.read(),/schema is incomplete/)
})

test('cached reference scans compare exact JSON bytes and observe additions, same-length changes and removals',t=>{
  const f=fixture(t)
  f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,metadata_json TEXT)')
  const raw=JSON.stringify({nested:{src:filename.replace('source.mp4','unused.mp4')}})
  const matching=JSON.stringify({nested:{src:filename}})
  assert.equal(raw.length,matching.length)
  f.db.prepare('INSERT INTO remotion_assets VALUES(7,?)').run(raw)
  const inspect=createSourceMediaReferenceInspector(f.db,input,root)
  assert.deepEqual(inspect(),[])
  assert.deepEqual(inspect(),[])
  f.db.prepare('UPDATE remotion_assets SET metadata_json=?').run(matching)
  assert.deepEqual(inspect().map(ref=>ref.ownerId),['7'])
  f.db.exec('DELETE FROM remotion_assets')
  assert.deepEqual(inspect(),[])
  f.db.prepare('INSERT INTO remotion_assets VALUES(8,?)').run(matching)
  assert.deepEqual(inspect().map(ref=>ref.ownerId),['8'])
  f.db.prepare('UPDATE remotion_assets SET metadata_json=?').run('{')
  assert.throws(()=>inspect(),SyntaxError)
})

test('changing a cached own motion row to a foreign owner restores its full reference protection',t=>{
  const f=fixture(t)
  f.db.exec('CREATE TABLE history_motion_productions(id TEXT,snapshot TEXT)')
  f.db.prepare('INSERT INTO history_motion_productions VALUES(?,?)').run('own-motion',JSON.stringify({plan:{delivery:{output:filename}}}))
  const inspect=createSourceMediaReferenceInspector(f.db,{...input,ownerType:'history-motion',ownerId:'own-motion'},root)
  assert.deepEqual(inspect(),[])
  f.db.exec("UPDATE history_motion_productions SET id='other-motion'")
  assert.deepEqual(inspect().map(ref=>ref.ownerId),['other-motion'])
})

test('cached scans preserve schema checks and do not accept blob-typed JSON',t=>{
  const f=fixture(t)
  f.db.exec('CREATE TABLE remotion_assets(project_id INTEGER,metadata_json TEXT)')
  f.db.prepare('INSERT INTO remotion_assets VALUES(7,?)').run(Buffer.from(JSON.stringify({src:filename})))
  const inspect=createSourceMediaReferenceInspector(f.db,input,root)
  assert.throws(()=>inspect(),/Stored reference JSON is invalid/)
})

test('production lookup opens only an existing ordinary database belonging to the task and does not create a missing file', async t => {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'source-refs-')))
  t.after(() => fs.rm(projectRoot,{recursive:true,force:true}))
  const databasePath = path.join(projectRoot,'data/huobao_drama.db')
  const local = {...input,directory:path.join(projectRoot,'data/storage/history-scripts/17'),files:[path.join(projectRoot,'data/storage/history-scripts/17/source.mp4')]}
  assert.deepEqual(await checkSourceMediaReferences(local),[])
  await assert.rejects(fs.lstat(databasePath),{code:'ENOENT'})
  await fs.mkdir(path.dirname(databasePath),{recursive:true})
  const db = new Database(databasePath)
  db.exec('CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT)')
  db.prepare('INSERT INTO remotion_assets VALUES(4,?)').run(local.files[0])
  db.close()
  const before = await fs.readFile(databasePath)
  assert.equal((await checkSourceMediaReferences(local))[0]!.ownerId,'4')
  assert.deepEqual(await fs.readFile(databasePath),before)
  const redirected = path.join(projectRoot,'redirected.db')
  await fs.symlink(databasePath,redirected)
  await assert.rejects(checkSourceMediaReferences(local,{projectRoot,databasePath:redirected}),/ordinary file/)
  const isolated = {...local,directory:projectRoot}
  assert.deepEqual(await checkSourceMediaReferences(isolated),[])
  await assert.rejects(checkSourceMediaReferences(isolated,{databasePath}),/project root/)
})

test('isolated read-only scans preserve complete reference semantics and reject unknown JSON and schemas', async t => {
  const projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-refs-isolated-')))
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(projectRoot, 'data'))
  const databasePath = path.join(projectRoot, 'data/huobao_drama.db')
  const db = new Database(databasePath)
  t.after(() => db.close())
  const video = path.join(projectRoot, 'data/science-pop/jobs/science-test/source.mp4')
  const local: SourceReferenceInput = { directory: path.dirname(video), files: [video], ownerType: 'science-job', ownerId: 'science-test' }
  db.exec(`CREATE TABLE storage_artifacts(id INTEGER,path TEXT,pinned INTEGER);
    CREATE TABLE storage_artifact_refs(artifact_id INTEGER,owner_type TEXT,owner_id TEXT);
    CREATE TABLE remotion_renders(project_id INTEGER,props_json TEXT);
    CREATE TABLE episodes(id INTEGER,source_video_url TEXT);`)
  db.prepare('INSERT INTO storage_artifacts VALUES(1,?,0)').run(video)
  db.exec("INSERT INTO storage_artifact_refs VALUES(1,'science','science-test')")
  const read = () => checkSourceMediaReferences(local, { isolated: true })
  assert.deepEqual(await read(), [])
  db.prepare('INSERT INTO remotion_renders VALUES(7,?)').run(JSON.stringify({ frames: [{ src: video }] }))
  db.prepare('INSERT INTO episodes VALUES(8,?)').run(video)
  db.exec('UPDATE storage_artifacts SET pinned=1')
  const before = await fs.readFile(databasePath)
  assert.deepEqual(await read(), inspectSourceMediaReferences(db, local, projectRoot))
  assert.deepEqual(await fs.readFile(databasePath), before)
  db.exec("UPDATE storage_artifacts SET pinned=0;DELETE FROM episodes;UPDATE remotion_renders SET props_json='{' ")
  await assert.rejects(read(), /JSON|Unexpected|Expected/)
  db.exec('DROP TABLE remotion_renders;ALTER TABLE storage_artifacts DROP COLUMN pinned')
  await assert.rejects(read(), /schema is incomplete/)
})
