import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { releaseSourceMediaFiles } from './storage-source-manifest.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture(t: any) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'source-release-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'source.mp4')
  await fs.writeFile(filename, 'source bytes')
  const input = { directory, ownerType: 'history-source' as const, ownerId: '123', sourceSha256: hash('source bytes'),
    transcriptSha256: hash('complete transcript'), matchesFile: (name: string) => name === 'source.mp4',
    fileHashes: { 'source.mp4': hash('source bytes') } }
  return { input, filename, manifest: path.join(directory, 'storage-release.json') }
}

test('the owner, transcript and exact file identity are committed before the first unlink', async t => {
  const f = await fixture(t)
  let unlinks = 0
  const result = await releaseSourceMediaFiles(f.input, async filename => {
    const record = JSON.parse(await fs.readFile(f.manifest, 'utf8'))
    assert.equal(record.status, 'planned')
    assert.equal(record.ownerType, 'history-source')
    assert.equal(record.ownerId, '123')
    assert.equal(record.reason, 'complete-transcript')
    assert.equal(record.sourceSha256, f.input.sourceSha256)
    assert.equal(record.transcriptSha256, f.input.transcriptSha256)
    assert.deepEqual(record.files, [{ path: f.filename, bytes: 12, sha256: f.input.sourceSha256, status: 'pending' }])
    unlinks++
    await fs.unlink(filename)
  })
  assert.equal(unlinks, 1)
  assert.equal(result.releasedBytes, 12)
  const released = JSON.parse(await fs.readFile(f.manifest, 'utf8'))
  assert.equal(released.status, 'completed')
  assert.ok(released.releasedAt)
  assert.equal(released.files[0].status, 'released')
  assert.equal(released.files[0].releasedAt, released.releasedAt)
  await assert.rejects(fs.access(f.filename))
})

test('a manifest write failure leaves source bytes untouched, and deletion failure remains linked for retry', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.manifest)
  await assert.rejects(releaseSourceMediaFiles(f.input))
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'source bytes')
  await fs.rmdir(f.manifest)
  const failed = await releaseSourceMediaFiles(f.input, async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })
  assert.match(failed.error || '', /EBUSY/)
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'source bytes')
  const record = JSON.parse(await fs.readFile(f.manifest, 'utf8'))
  assert.equal(record.status, 'partial')
  assert.equal(record.files[0].status, 'failed')
  assert.equal(record.ownerId, '123')
  const completed = await releaseSourceMediaFiles(f.input)
  assert.equal(completed.releasedBytes, 12)
  assert.ok(completed.releasedAt)
  assert.equal(JSON.parse(await fs.readFile(f.manifest, 'utf8')).status, 'completed')
})

test('a replaced file is retained against the planned identity and stays associated with the task', async t => {
  const f = await fixture(t)
  await releaseSourceMediaFiles(f.input, async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) })
  await fs.writeFile(f.filename, 'replacement bytes')
  await assert.rejects(releaseSourceMediaFiles({ ...f.input, ownerId: 'another-task' }), /owner/)
  const result = await releaseSourceMediaFiles(f.input)
  assert.match(result.error || '', /SOURCE_MEDIA_CHANGED/)
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'replacement bytes')
})

test('a preserved source retains its entire group with a durable retained audit', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.input.directory, 'storage-preserve.json'), JSON.stringify({ version: 1, files: ['source.mp4'] }))
  const result = await releaseSourceMediaFiles(f.input, async () => assert.fail('a pinned file must never be unlinked'))
  assert.match(result.error || '', /SOURCE_MEDIA_PINNED/)
  assert.equal(result.releasedBytes, 0)
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'source bytes')
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'))
  assert.equal(manifest.status, 'retained')
  assert.equal(manifest.files[0].status, 'retained')
  assert.equal(manifest.ownerId, f.input.ownerId)
})

test('a malformed preservation marker fails closed before unlinking any source', async t => {
  const f = await fixture(t), preserve = path.join(f.input.directory, 'storage-preserve.json')
  for (const marker of ['{', JSON.stringify({ version: 1, files: '../source.mp4' }), JSON.stringify({ version: 1, files: ['../source.mp4'] })]) {
    await fs.writeFile(preserve, marker)
    await assert.rejects(releaseSourceMediaFiles(f.input, async () => assert.fail('a malformed preserve marker must prevent deletion')), { code: 'SOURCE_PRESERVATION_INVALID' })
    assert.equal(await fs.readFile(f.filename, 'utf8'), 'source bytes')
  }
})

test('a fresh foreign reference on a chunk preserves the entire source group with an auditable owner', async t => {
  const f = await fixture(t), db = new Database(':memory:')
  t.after(() => db.close())
  const chunk = path.join(f.input.directory,'audio-000.wav')
  await fs.writeFile(chunk,'audio bytes')
  db.exec('CREATE TABLE remotion_shots(project_id INTEGER,visual_plan_json TEXT)')
  db.prepare('INSERT INTO remotion_shots VALUES(7,?)').run(JSON.stringify({layers:[{src:chunk}]}))
  const result = await releaseSourceMediaFiles({...f.input,matchesFile:name => ['source.mp4','audio-000.wav'].includes(name),
    referenceOptions:{database:db,projectRoot:f.input.directory}},async () => assert.fail('a shared group must remain intact'))
  assert.equal(result.releasedBytes,0)
  assert.equal(result.error,'SOURCE_MEDIA_SHARED')
  const manifest = JSON.parse(await fs.readFile(f.manifest,'utf8'))
  assert.equal(manifest.status,'retained')
  assert.ok(manifest.files.every((file: any) => file.status === 'retained'))
  assert.deepEqual(manifest.retention.references,[{path:chunk,ownerType:'remotion',ownerId:'7',reason:'shared-reference'}])
  assert.equal(await fs.readFile(f.filename,'utf8'),'source bytes')
  assert.equal(await fs.readFile(chunk,'utf8'),'audio bytes')
})

test('reference guard failure retains every source and saves the failure before returning', async t => {
  const f = await fixture(t), db = new Database(':memory:')
  t.after(() => db.close())
  db.exec("CREATE TABLE remotion_renders(project_id INTEGER,props_json TEXT);INSERT INTO remotion_renders VALUES(7,'{')")
  const result = await releaseSourceMediaFiles({...f.input,referenceOptions:{database:db,projectRoot:f.input.directory}},
    async () => assert.fail('a failed guard must prevent deletion'))
  assert.equal(result.error,'SOURCE_MEDIA_GUARD_FAILED')
  const manifest = JSON.parse(await fs.readFile(f.manifest,'utf8'))
  assert.equal(manifest.status,'retained')
  assert.equal(manifest.retention.code,'SOURCE_MEDIA_GUARD_FAILED')
  assert.ok(manifest.retention.message)
  assert.equal(await fs.readFile(f.filename,'utf8'),'source bytes')
})

test('registered pins are rechecked before each unlink and preserve all remaining bytes', async t => {
  const f = await fixture(t), db = new Database(':memory:')
  t.after(() => db.close())
  const part = f.filename+'.part'
  await fs.writeFile(part,'partial bytes')
  db.exec('CREATE TABLE storage_artifacts(id INTEGER,path TEXT,pinned INTEGER);CREATE TABLE storage_artifact_refs(artifact_id INTEGER,owner_type TEXT,owner_id TEXT)')
  let calls = 0
  const result = await releaseSourceMediaFiles({...f.input,matchesFile:name => name.startsWith('source.mp4'),
    referenceOptions:{database:db,projectRoot:f.input.directory}},async filename => {
    calls++
    assert.equal(filename,f.filename)
    db.prepare('INSERT INTO storage_artifacts VALUES(1,?,1)').run(part)
    await fs.unlink(filename)
  })
  assert.equal(calls,1)
  assert.equal(result.error,'SOURCE_MEDIA_PINNED')
  assert.equal(await fs.readFile(part,'utf8'),'partial bytes')
  const manifest = JSON.parse(await fs.readFile(f.manifest,'utf8'))
  assert.equal(manifest.status,'retained')
  assert.equal(manifest.files.find((file: any) => file.path === part).status,'retained')
})
