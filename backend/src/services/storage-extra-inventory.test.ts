import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { discoverAdditionalArtifacts } from './storage-extra-inventory.js'

const root = '/workspace/huobao-drama'
const exported = path.join(root,'data/huasheng-exports/123/video_'+ 'a'.repeat(64)+'.mp4')
const composed = 'static/composed/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4'
function fixture(t: TestContext) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE history_huasheng_export_jobs(id INTEGER,source_id INTEGER,status TEXT,file_path TEXT);
    CREATE TABLE creation_tasks(id INTEGER,type TEXT,episode_id INTEGER,status TEXT,result_json TEXT,scope_type TEXT,scope_id INTEGER,payload_json TEXT);`)
  t.after(() => db.close())
  const task = (type: string, result: unknown, episodeId = 17, scopeType: string | null = null, scopeId: number | null = null) => {
    db.prepare('INSERT INTO creation_tasks VALUES(23,?,?,?, ?,?,?,NULL)').run(type,episodeId,'succeeded',JSON.stringify(result),scopeType,scopeId)
  }
  return {db,task,read:() => discoverAdditionalArtifacts(db,root)}
}

test('all saved Huasheng export outputs retain both source and export task ownership regardless of status', t => {
  const f = fixture(t)
  for (const status of ['completed','failed','needs_attention','downloading','processing']) {
    f.db.exec('DELETE FROM history_huasheng_export_jobs')
    f.db.prepare('INSERT INTO history_huasheng_export_jobs VALUES(5,17,?,?)').run(status,exported)
    assert.deepEqual(f.read(),[
      {path:exported,role:'final',ownerType:'history-source',ownerId:'17',state:status},
      {path:exported,role:'final',ownerType:'history-huasheng-export',ownerId:'5',state:status},
    ])
  }
})

test('export registration rejects outside, traversing, redirected spellings and missing ownership identities', t => {
  const f = fixture(t)
  for (const filename of [exported.replace(root,'/outside'),exported.replace('/123/','/123/../123/'),
    exported.replace('huasheng-exports/','huasheng-exports-other/'),exported+'.part','https://example.test/video.mp4']) {
    f.db.prepare('INSERT INTO history_huasheng_export_jobs VALUES(5,17,?,?)').run('completed',filename)
  }
  f.db.prepare('INSERT INTO history_huasheng_export_jobs VALUES(5,NULL,?,?)').run('completed',exported)
  assert.deepEqual(f.read(),[])
})

test('exact storyboard and merge task results recover historical outputs with episode and task owners', t => {
  const f = fixture(t)
  f.task('compose.storyboard',{storyboard_id:31,composed_video_url:composed},17,'storyboard',31)
  f.task('merge.episode',{merge_id:4,merged_url:'static/merged/movie.mp4'},17,'episode',17)
  const rows = f.read()
  assert.equal(rows.length,4)
  assert.deepEqual(rows.filter(row => row.path.endsWith('movie.mp4')).map(row => [row.ownerType,row.ownerId,row.role]),
    [['episode','17','final'],['creation-task','23','final']])
  assert.ok(rows.filter(row => row.path.endsWith(path.basename(composed))).every(row => row.role === 'intermediate'))
})

test('intro and recap compose results are input artifacts and null outputs create no invented file', t => {
  const f = fixture(t)
  f.task('intro.compose',{episode_id:17,intro_video_url:'static/intros/17.mp4'})
  f.task('recap.compose',{episode_id:17,recap_video_url:'static/recaps/17.mp4'})
  f.task('recap.compose',{episode_id:17,recap_video_url:null})
  assert.equal(f.read().length,4)
  assert.ok(f.read().every(row => row.role === 'intermediate'))
})

test('discovery selects known artifact fields and never mistakes nested inputs, child task ids or unrelated task results for outputs', t => {
  const f = fixture(t)
  f.task('image.generate',{storyboard_id:31,composed_video_url:composed})
  f.task('compose.episode',{episode_id:17,child_task_ids:[23],composed_video_url:composed})
  f.task('compose.storyboard',{storyboard_id:31,input:{composed_video_url:composed}})
  f.task('merge.episode',{merge_id:4,input:{merged_url:'static/merged/input.mp4'}})
  assert.deepEqual(f.read(),[])
})

test('conflicting task scope and result identities cannot assign an output to an unrelated episode or storyboard', t => {
  const f = fixture(t)
  f.task('compose.storyboard',{storyboard_id:31,composed_video_url:composed},17,'storyboard',32)
  f.task('compose.storyboard',{storyboard_id:31,composed_video_url:composed},17,'episode',18)
  f.task('merge.episode',{merge_id:4,episode_id:18,merged_url:'static/merged/movie.mp4'})
  f.task('merge.episode',{merged_url:'static/merged/movie.mp4'})
  assert.deepEqual(f.read(),[])
})

test('producer paths accept canonical local spellings but stay inside that producer output directory', t => {
  const f = fixture(t)
  for (const filename of [composed,'/'+composed,'data/'+composed,path.join(root,'data',composed)]) {
    f.db.exec('DELETE FROM creation_tasks')
    f.task('compose.storyboard',{storyboard_id:31,composed_video_url:filename})
    assert.equal(f.read().length,2)
    assert.equal(f.read()[0]!.path,path.join(root,'data',composed))
  }
  f.db.exec('DELETE FROM creation_tasks')
  for (const filename of [composed.replace('composed/','composed/../composed/'),composed.replace('composed/','remotion/'),
    composed+'?v=1',composed+'.part',composed.replace('static/','https://example.test/static/')]) {
    f.task('compose.storyboard',{storyboard_id:31,composed_video_url:filename})
  }
  assert.deepEqual(f.read(),[])
})

test('old schemas and malformed results are tolerated and discovery performs no database writes', t => {
  const f = fixture(t)
  f.db.prepare('INSERT INTO history_huasheng_export_jobs VALUES(5,17,?,?)').run('failed',exported)
  f.db.exec("INSERT INTO creation_tasks VALUES(23,'compose.storyboard',17,'failed','{',NULL,NULL,NULL)")
  const before = f.db.prepare('SELECT total_changes() AS count').get()
  f.db.pragma('query_only = ON')
  assert.equal(f.read().length,2)
  assert.deepEqual(f.db.prepare('SELECT total_changes() AS count').get(),before)
  f.db.pragma('query_only = OFF')
  f.db.exec('DROP TABLE creation_tasks;CREATE TABLE creation_tasks(id INTEGER);DROP TABLE history_huasheng_export_jobs')
  assert.deepEqual(f.read(),[])
})
