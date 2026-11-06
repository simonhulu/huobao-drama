import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { discoverImmutableCopies } from './storage-immutable-copies.js'

const root = '/workspace/huobao-drama'
const jobId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const videoId = '11111111-2222-4333-8444-555555555555'
const sha = 'a'.repeat(64), scriptSha = 'b'.repeat(64), projectHash = 'c'.repeat(64)
const movie = path.join(root,'data/storage/history-motion',jobId,'render-1793491200000/movie.mp4')
const render = path.join(root,'data/static/remotion',`history-${jobId}-${sha.slice(0,12)}.mp4`)
const download = path.join(root,'data/huasheng-exports/123',`video_${projectHash}.mp4`)
const delivery = `/static/history-deliveries/17/${videoId}.mp4`
function fixture(t: TestContext) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE history_video_deliveries(script_id INTEGER,script_sha256 TEXT,producer TEXT,producer_job_id TEXT,video_path TEXT,video_sha256 TEXT);
    CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT);
    CREATE TABLE remotion_renders(project_id INTEGER,render_kind TEXT,status TEXT,input_hash TEXT,output_path TEXT);
    CREATE TABLE history_huasheng_export_jobs(id INTEGER,huasheng_job_id INTEGER,source_id INTEGER,script_sha256 TEXT,status TEXT,project_url TEXT,project_hash TEXT,file_path TEXT);`)
  const job = {id:jobId,scriptId:17,status:'completed',stage:'rendered',outputPath:movie,
    plan:{delivery:{sha256:sha,qa:{technical:'passed'}}},factory:{sourceId:17,episodeId:23,projectId:29}}
  const saveJob = () => {
    db.exec('DELETE FROM history_motion_productions')
    db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?)').run(jobId,17,'completed',JSON.stringify(job))
  }
  db.prepare('INSERT INTO history_video_deliveries VALUES(17,?,?,?,?,?)').run(scriptSha,'huasheng','11',delivery,sha)
  saveJob()
  db.prepare('INSERT INTO remotion_renders VALUES(29,?,?,?,?)').run('episode','succeeded',sha,render)
  db.prepare('INSERT INTO history_huasheng_export_jobs VALUES(5,11,17,?,?,?,?,?)')
    .run(scriptSha,'completed','https://www.huasheng.cn/video/123',projectHash,download)
  t.after(() => db.close())
  return {db,job,saveJob,read:() => discoverImmutableCopies(db,root),at:(filename: string) => discoverImmutableCopies(db,root).filter(row => row.path === filename)}
}

test('discovers the four proven writer paths and keeps source, production, episode and project ownership', t => {
  const f = fixture(t), rows = f.read()
  assert.deepEqual([...new Set(rows.map(row => row.path))].sort(),[path.join(root,'data',delivery.slice(1)),movie,render,download].sort())
  for (const filename of [movie,render]) {
    assert.deepEqual(f.at(filename).map(row => `${row.ownerType}:${row.ownerId}`).sort(),
      ['episode:23','history-motion:'+jobId,'history-source:17','remotion:29'].sort())
  }
  assert.deepEqual(f.at(download).map(row => `${row.ownerType}:${row.ownerId}`).sort(),['history-huasheng-export:5','history-source:17'])
  assert.ok(rows.every(row => row.sha256 === sha && row.role === 'final'))
})

test('delivery files require exact source-scoped UUID paths and valid content identities', t => {
  const f = fixture(t)
  for (const filename of [delivery.replace('/17/','/18/'),delivery.replace(videoId,'source'),delivery+'?download=1',
    delivery.replace('/17/','/17/../17/'),delivery.replace('static/','static//'),path.join(root,'data',delivery)]) {
    f.db.prepare('UPDATE history_video_deliveries SET video_path=?').run(filename)
    assert.equal(f.at(path.join(root,'data',delivery.slice(1))).length,0)
    assert.equal(f.at(download).length,0)
  }
  f.db.prepare('UPDATE history_video_deliveries SET video_path=?,video_sha256=?').run(delivery,'invalid')
  assert.equal(f.at(path.join(root,'data',delivery.slice(1))).length,0)
})

test('motion output requires a matching completed snapshot and passed technical report', t => {
  const f = fixture(t)
  for (const patch of [{id:videoId},{scriptId:18},{status:'rendering'},{stage:'validating'},
    {plan:{delivery:{sha256:sha,qa:{technical:'failed'}}}},{plan:{delivery:{sha256:'bad',qa:{technical:'passed'}}}}]) {
    f.db.prepare('UPDATE history_motion_productions SET snapshot=?').run(JSON.stringify({...f.job,...patch}))
    assert.equal(f.at(movie).length,0)
  }
  f.saveJob()
  f.db.exec("UPDATE history_motion_productions SET status='rendering'")
  assert.equal(f.at(movie).length,0)
})

test('motion allowlist excludes mutable and escaped output names and supports episode-only jobs', t => {
  const f = fixture(t)
  for (const filename of [path.join(root,'data/storage/history-motion',videoId,'render-1793491200000/movie.mp4'),
    path.join(root,'data/storage/history-motion',jobId,'movie.mp4'),movie.replace('/movie.mp4','/source.mp4'),
    movie.replace('/render-','/../render-'),movie.replace(root,'/outside')]) {
    f.job.outputPath = filename;f.saveJob()
    assert.equal(f.at(filename).length,0)
  }
  f.job.outputPath = movie;f.job.scriptId = -23;delete (f.job.factory as any).sourceId
  f.saveJob();f.db.exec('UPDATE history_motion_productions SET script_id=-23')
  assert.deepEqual(f.at(movie).map(row => row.ownerType).sort(),['episode','history-motion','remotion'])
})

test('factory render copies require the exact UUID and SHA prefix and never treat preview hashes as movie hashes', t => {
  const f = fixture(t)
  for (const filename of [render.replace(sha.slice(0,12),'d'.repeat(12)),render.replace('.mp4','-preview.mp4'),
    render.replace(root,'/outside'),render.replace('/remotion/','/remotion/../remotion/'),
    path.join(root,'data/static/remotion','grid-story-ep23.mp4'),path.join(root,'data/cba-video/render.mp4')]) {
    f.db.prepare('UPDATE remotion_renders SET output_path=?').run(filename)
    assert.equal(f.at(filename).length,0)
  }
  f.db.prepare("UPDATE remotion_renders SET output_path=?,render_kind='preview'").run(render)
  assert.equal(f.at(render).length,0)
  f.db.prepare("UPDATE remotion_renders SET render_kind='episode',status='running'").run()
  assert.equal(f.at(render).length,0)
})

test('Huasheng download identity requires the same producer job, source, script and completed export', t => {
  const f = fixture(t)
  for (const update of ["producer='motion'","producer_job_id='12'","script_id=18","script_sha256='"+'d'.repeat(64)+"'"]) {
    const original = f.db.prepare('SELECT * FROM history_video_deliveries').get() as any
    f.db.exec('UPDATE history_video_deliveries SET '+update)
    assert.equal(f.at(download).length,0)
    f.db.prepare('UPDATE history_video_deliveries SET producer=?,producer_job_id=?,script_id=?,script_sha256=?')
      .run(original.producer,original.producer_job_id,original.script_id,original.script_sha256)
  }
  f.db.exec("UPDATE history_huasheng_export_jobs SET status='downloading'")
  assert.equal(f.at(download).length,0)
})

test('Huasheng paths must match the recorded project and version and conflicting deliveries stay excluded', t => {
  const f = fixture(t)
  for (const filename of [download.replace('/123/','/124/'),download.replace(projectHash,'d'.repeat(64)),
    download+'.part',download.replace('/123/','/123/../123/'),path.join(root,'data/cba-video/output.mp4')]) {
    f.db.prepare('UPDATE history_huasheng_export_jobs SET file_path=?').run(filename)
    assert.equal(f.at(filename).length,0)
  }
  f.db.prepare('UPDATE history_huasheng_export_jobs SET file_path=?').run(download)
  f.db.prepare('INSERT INTO history_video_deliveries VALUES(17,?,?,?,?,?)')
    .run(scriptSha,'huasheng','11',delivery,'d'.repeat(64))
  assert.equal(f.at(download).length,0)
})

test('discovery is read-only, tolerates old schemas and malformed snapshots, and preserves independent evidence', t => {
  const f = fixture(t)
  const totalChanges = () => (f.db.prepare('SELECT total_changes() AS count').get() as {count:number}).count
  const changes = totalChanges()
  f.db.pragma('query_only = ON')
  assert.ok(f.read().length > 0)
  assert.equal(totalChanges(),changes)
  f.db.pragma('query_only = OFF')
  f.db.exec("UPDATE history_motion_productions SET snapshot='not-json';DROP TABLE remotion_renders;CREATE TABLE remotion_renders(project_id INTEGER)")
  assert.equal(f.at(movie).length,0)
  assert.equal(f.at(download).length,2)
  f.db.exec('DROP TABLE history_video_deliveries')
  assert.deepEqual(f.read(),[])
})
