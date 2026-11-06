import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-history-routes-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource } = await import('../services/history-script-library.js')
const { createHistoryScriptsRoute } = await import('./history-scripts.js')
const storageRoot = join(dbDir, 'videos')
const route = createHistoryScriptsRoute({ storageRoot })

beforeEach(() => {
  db.$client.prepare('DELETE FROM history_script_deliveries').run()
  db.$client.exec('DROP TABLE IF EXISTS history_social_upload_jobs; DROP TABLE IF EXISTS history_social_upload_confirmations;')
  db.delete(schema.historyScriptSources).run()
})

const execFileAsync = promisify(execFile)
const cliPath = fileURLToPath(new URL('../../scripts/history-sources/run.ts', import.meta.url))
const backendRoot = fileURLToPath(new URL('../../', import.meta.url))
function seed(sourceVideoId = '7395681234567890123', title = 'Local history') {
  return storeHistorySource({
    sourceVideoId,
    title,
    category: 'regional_history',
    metrics: { comments: 37 },
    selection: {
      reason: 'Viewers ask about the origin of a local landmark',
      observedAt: '2026-10-14T08:00:00Z',
      comments: [{ text: 'Where is the historical source?', likes: 12 }],
    },
  })
}

function currentDraft(id: number, rewrittenScript = 'A rewritten draft') {
  const rawTranscript = 'Raw narration'
  const correctedTranscript = 'Corrected narration'
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return updateHistorySource(id, {
    status: 'needs_review', rawTranscript, correctedTranscript, rewrittenScript,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text: rawTranscript, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ correctedTranscript, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(rawTranscript), correctedTranscriptSha256: hash(correctedTranscript), rewriteInputSha256: hash(correctedTranscript) }),
  })!
}

test('list API exposes pagination and combined filters using the normal response envelope', async () => {
  const source = seed()
  seed('2', 'An imperial anecdote')
  updateHistorySource(source.id, { status: 'needs_review' })
  const response = await route.request('/?category=regional_history&status=needs_review&q=local&limit=1&offset=0')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.code, 200)
  assert.equal(body.data.total, 1)
  assert.equal(body.data.items.length, 1)
  assert.equal(body.data.items[0].id, source.id)
  assert.equal(body.data.items[0].sourceVideoId, '7395681234567890123')
})

test('list API combines workflow filters and keeps script revisions independent of production state', async () => {
  const source = seed()
  seed('2', 'Not produced yet')
  const original = (await (await route.request(`/${source.id}`)).json()).data
  db.$client.prepare(`INSERT INTO history_script_deliveries(script_id,title,design_status,video_path,updated_at)
    VALUES(?,'已有标题方案','completed','static/movie.mp4','2026-10-25')`).run(source.id)
  const response = await route.request('/?video=completed&titlePlan=generated&cover=not_generated&motion=not_generated&limit=1')
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.total, 1)
  assert.equal(data.items[0].id, source.id)
  assert.deepEqual(data.items[0].workflowState, {
    videoCompleted: true, videoLinked: true, titlePlanGenerated: true, coverGenerated: false, motionGenerated: false,
    uploadState: 'not_uploaded', uploads: { 'baijiahao-video': 'not_uploaded' }, publicationCounts: { expected: 1, submitted: 0, published: 0 },
  })
  const detail = (await (await route.request(`/${source.id}`)).json()).data
  assert.deepEqual(detail.workflowState, data.items[0].workflowState)
  assert.equal(detail.revision, original.revision)
  assert.equal(data.items[0].revision, original.revision)
  assert.equal((await (await route.request('/?video=completed&cover=generated')).json()).data.total, 0)
  for (const key of ['video', 'titlePlan', 'cover', 'motion', 'upload']) {
    assert.equal((await route.request(`/?${key}=invalid`)).status, 400)
  }
})

test('list API preserves old manual markers without treating them as direct publication or changing the script revision', async () => {
  const source = seed()
  const original = (await (await route.request(`/${source.id}`)).json()).data
  db.$client.prepare(`INSERT INTO history_script_deliveries(script_id,video_path,updated_at)
    VALUES(?,'static/movie.mp4','2026-10-25')`).run(source.id)
  db.$client.exec('CREATE TABLE history_social_upload_confirmations(source_id INTEGER,target TEXT,confirmed_at TEXT)')
  const mark = db.$client.prepare('INSERT INTO history_social_upload_confirmations VALUES(?,?,?)')
  const read = async (upload: string) => (await (await route.request(`/?video=completed&upload=${upload}`)).json()).data
  assert.equal((await read('not_uploaded')).total, 1)
  mark.run(source.id, 'baijiahao-video', '2026-10-27')
  assert.equal((await read('not_uploaded')).total, 1)
  assert.equal((await read('partially_uploaded')).total, 0)
  for (const target of ['baijiahao-article', 'tencent-video']) mark.run(source.id, target, '2026-10-27')
  assert.equal((await read('uploaded')).total, 0)
  const pending = await read('not_uploaded')
  assert.equal(pending.total, 1)
  assert.deepEqual(pending.items[0].workflowState.uploads, { 'baijiahao-video': 'not_uploaded' })
  assert.equal(pending.items[0].revision, original.revision)
  assert.equal((await (await route.request(`/${source.id}`)).json()).data.revision, original.revision)
})

test('detail API returns stored script stages and evidence', async () => {
  const source = seed()
  updateHistorySource(source.id, { rawTranscript: 'Raw narration', rewrittenScript: 'A rewritten draft' })
  const response = await route.request(`/${source.id}`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.rawTranscript, 'Raw narration')
  assert.equal(body.data.rewrittenScript, 'A rewritten draft')
  assert.deepEqual(body.data.artifactState, { transcript: 'stale', corrected: 'missing', rewritten: 'stale' })
  assert.equal(JSON.parse(body.data.metricsJson).comments, 37)
  assert.equal(JSON.parse(body.data.selectionJson).comments[0].text, 'Where is the historical source?')
})

test('deleted script links explain the deletion while keeping content unavailable', async () => {
  const source = seed()
  const deletedAt = '2026-10-27T07:13:13.382Z'
  db.update(schema.historyScriptSources).set({ deletedAt, rewrittenScript: 'Retained private draft' })
    .where(eq(schema.historyScriptSources.id, source.id)).run()
  const response = await route.request(`/${source.id}`)
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.match(body.message, /已删除/)
  assert.deepEqual(body.data, { reason: 'deleted', id: source.id, title: source.title, deletedAt })
  assert.equal(JSON.stringify(body).includes('Retained private draft'), false)
  const missing = await (await route.request('/999999')).json()
  assert.match(missing.message, /不存在/)
})

test('note images are readable by source and index while metadata cannot expose unrelated files', async () => {
  const source = seed()
  const directory = join(storageRoot, String(source.id))
  mkdirSync(directory, { recursive: true })
  const filename = join(directory, 'note-000.png')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQkAAAAASUVORK5CYII=', 'base64')
  writeFileSync(filename, png)
  updateHistorySource(source.id, { mediaJson: JSON.stringify({ kind: 'note', images: [{ path: filename, sha256: 'a'.repeat(64), bytes: png.length }] }) })
  const detail = await (await route.request(`/${source.id}`)).json()
  const image = JSON.parse(detail.data.mediaJson).images[0]
  assert.equal(image.path, undefined)
  assert.equal(image.url, `/api/v1/history-scripts/${source.id}/images/0`)
  const response = await route.request(`/${source.id}/images/0`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  assert.equal((await route.request(`/${source.id}/images/9`)).status, 404)
  assert.equal((await route.request(`/${source.id}/images/-1`)).status, 400)
  const other = seed('123')
  updateHistorySource(other.id, { mediaJson: JSON.stringify({ kind: 'note', images: [{ path: filename }] }) })
  assert.equal((await route.request(`/${other.id}/images/0`)).status, 404)
  const outside = join(dbDir, 'note-001.png')
  writeFileSync(outside, png)
  symlinkSync(outside, join(directory, 'note-001.png'))
  updateHistorySource(source.id, { mediaJson: JSON.stringify({ kind: 'note', images: [{ path: join(directory, 'note-001.png') }] }) })
  assert.equal((await route.request(`/${source.id}/images/0`)).status, 404)
})

test('missing details and exports return 404, absent rewrites return 409, and malformed IDs return 400', async () => {
  const source = seed()
  assert.equal((await route.request('/999999')).status, 404)
  assert.equal((await route.request('/999999/export')).status, 404)
  const missingScript = await route.request(`/${source.id}/export`)
  assert.equal(missingScript.status, 409)
  assert.equal((await missingScript.json()).code, 409)
  for (const id of ['abc', '-1', '0', '1e2', '1.5', '99999999999999999']) {
    assert.equal((await route.request(`/${id}`)).status, 400)
    assert.equal((await route.request(`/${id}/export`)).status, 400)
  }
})

test('export is markdown with escaped source metadata and explicit needs_review status', async () => {
  const title = 'History: "a source"\nstatus: approved'
  const source = seed('7395681234567890123', title)
  currentDraft(source.id, 'A draft about the historical landmark.\nA second paragraph.')
  const response = await route.request(`/${source.id}/export`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type')!, /^text\/markdown; charset=utf-8$/)
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="history-script-${source.id}.md"`)
  const markdown = await response.text()
  assert.ok(markdown.includes(`title: ${JSON.stringify(title)}\n`))
  assert.ok(markdown.includes(`source_url: ${JSON.stringify(source.sourceUrl)}\n`))
  assert.ok(markdown.includes('\nstatus: needs_review\n---\n'))
  assert.ok(markdown.endsWith('A draft about the historical landmark.\nA second paragraph.\n'))
})

test('API exports reject stale raw, corrected, rewrite-input and media provenance while retaining prior texts', async () => {
  const source = seed()
  for (const change of [
    { rawTranscript: 'New ASR narration' },
    { correctedTranscript: 'New corrected narration' },
    { reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', rewriteInputSha256: 'wrong' }) },
    { mediaJson: JSON.stringify({ videoSha256: '3'.repeat(64) }) },
    { asrJson: JSON.stringify({ complete: false, text: 'Raw narration' }) },
  ]) {
    currentDraft(source.id)
    updateHistorySource(source.id, change)
    const response = await route.request(`/${source.id}/export`)
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /stale/)
    const details = await (await route.request(`/${source.id}`)).json()
    assert.equal(details.data.rewrittenScript, 'A rewritten draft')
    assert.equal(details.data.artifactState.rewritten, 'stale')
  }
})

test('rewrite update saves editor changes without clearing review state and rejects stale edits', async () => {
  const source = seed()
  const draft = currentDraft(source.id)
  const response = await route.request(`/${source.id}/rewrite`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rewrittenScript: 'Editor refined draft', expectedUpdatedAt: draft.updatedAt }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.rewrittenScript, 'Editor refined draft')
  assert.equal(body.data.status, 'needs_review')
  assert.equal(JSON.parse(body.data.reviewJson).factCheckStatus, 'needs_sources')

  const stale = await route.request(`/${source.id}/rewrite`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rewrittenScript: 'Stale editor copy', expectedUpdatedAt: draft.updatedAt }),
  })
  assert.equal(stale.status, 409)
  assert.equal((await (await route.request(`/${source.id}`)).json()).data.rewrittenScript, 'Editor refined draft')
})

test('CLI export validates the same current provenance and does not write stale output', async () => {
  const source = seed()
  currentDraft(source.id)
  const output = join(dbDir, 'valid-script.md')
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', cliPath, 'export', String(source.id), output], {
    cwd: backendRoot, env: { ...process.env, DB_PATH: process.env.DB_PATH }, timeout: 20_000,
  })
  assert.equal(JSON.parse(result.stdout).status, 'needs_review')
  assert.ok((await readFile(output, 'utf8')).includes('A rewritten draft'))
  updateHistorySource(source.id, { rawTranscript: 'New ASR narration' })
  const staleOutput = join(dbDir, 'stale-script.md')
  await assert.rejects(execFileAsync(process.execPath, ['--import', 'tsx', cliPath, 'export', String(source.id), staleOutput], {
    cwd: backendRoot, env: { ...process.env, DB_PATH: process.env.DB_PATH }, timeout: 20_000,
  }), error => /stale/.test((error as Error & { stderr: string }).stderr))
  await assert.rejects(access(staleOutput))
})

test('invalid filter and pagination queries return 400 and unsupported mutation routes stay closed', async () => {
  for (const query of ['category=unknown', 'limit=0', 'limit=NaN', 'offset=-1', 'offset=0.5', 'status=']) {
    assert.equal((await route.request(`/?${query}`)).status, 400)
  }
  assert.equal((await route.request('/', { method: 'POST' })).status, 404)
  assert.equal((await route.request('/1/process', { method: 'POST' })).status, 404)
})

async function details(id: number) {
  return (await (await route.request(`/${id}`)).json()).data
}

function saveDraft(id: number, body: unknown) {
  return route.request(`/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

function deleteDraft(id: number | string, body: unknown) {
  return route.request(`/${id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

test('deleting hides a script from reads and writes while retaining files and unrelated sources', async () => {
  const source = videoSource()
  const other = seed('222', 'Another source')
  const before = await details(source.id)
  const response = await deleteDraft(source.id, { expectedRevision: before.revision })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { code: 200, data: { id: source.id }, message: 'success' })
  const page = await (await route.request('/')).json()
  assert.equal(page.data.total, 1)
  assert.deepEqual(page.data.items.map((item: { id: number }) => item.id), [other.id])
  for (const suffix of ['', '/export', '/video']) {
    assert.equal((await route.request(`/${source.id}${suffix}`)).status, 404)
  }
  assert.equal((await route.request(`/${source.id}/video`, { method: 'HEAD' })).status, 404)
  assert.equal((await saveDraft(source.id, { rewrittenScript: 'Should not restore', expectedRevision: before.revision })).status, 404)
  assert.equal((await route.request(`/${source.id}/rewrite`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rewrittenScript: 'Should not restore', expectedUpdatedAt: before.updatedAt }),
  })).status, 404)
  assert.equal((await deleteDraft(source.id, { expectedRevision: before.revision })).status, 404)
  const retained = db.select().from(schema.historyScriptSources).where(eq(schema.historyScriptSources.id, source.id)).get()!
  assert.ok(retained.deletedAt)
  assert.equal(retained.sourceVideoId, source.sourceVideoId)
  assert.equal(retained.title, source.title)
  assert.equal(await readFile(join(storageRoot, String(source.id), 'source.mp4'), 'utf8'), '0123456789')
  assert.equal((await details(other.id)).title, other.title)
  assert.equal(updateHistorySource(source.id, { status: 'selected' }), null)
  seed(source.sourceVideoId, 'Observed again')
  assert.equal((await route.request(`/${source.id}`)).status, 404, 're-observation must not resurrect a deleted source')
})

test('delete validates identity and revision without changing records', async () => {
  const source = seed()
  const before = await details(source.id)
  for (const body of [{}, null, [], { expectedRevision: 'bad' }, { expectedRevision: before.revision, force: true }]) {
    assert.equal((await deleteDraft(source.id, body)).status, 400)
  }
  for (const id of ['abc', '-1', '0', '1e2', '1.5', '99999999999999999']) {
    assert.equal((await deleteDraft(id, { expectedRevision: before.revision })).status, 400)
  }
  assert.equal((await route.request(`/${source.id}`, { method: 'DELETE' })).status, 400)
  assert.equal((await route.request(`/${source.id}`, { method: 'DELETE', body: '{bad' })).status, 400)
  assert.equal((await deleteDraft(999999, { expectedRevision: before.revision })).status, 404)
  assert.equal((await deleteDraft(source.id, { expectedRevision: '0'.repeat(64) })).status, 409)
  assert.equal((await details(source.id)).revision, before.revision)
  updateHistorySource(source.id, { rewrittenScript: 'A newer edit' })
  assert.equal((await deleteDraft(source.id, { expectedRevision: before.revision })).status, 409)
  assert.equal((await details(source.id)).rewrittenScript, 'A newer edit')
})

test('delete rejects every active processing stage and preserves another process lock', async () => {
  const source = seed()
  for (const status of ['downloading', 'transcribing', 'correcting', 'rewriting']) {
    updateHistorySource(source.id, { status })
    const before = await details(source.id)
    const response = await deleteDraft(source.id, { expectedRevision: before.revision })
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /处理/)
    assert.equal((await details(source.id)).status, status)
  }
  updateHistorySource(source.id, { status: 'needs_review' })
  const directory = join(storageRoot, String(source.id))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'process.lock'), 'existing pipeline lock')
  assert.equal((await deleteDraft(source.id, { expectedRevision: (await details(source.id)).revision })).status, 409)
  assert.equal(await readFile(join(directory, 'process.lock'), 'utf8'), 'existing pipeline lock')
  assert.equal((await details(source.id)).status, 'needs_review')
})

test('saving a rewrite persists exact text without changing original, provenance or review findings', async () => {
  const source = currentDraft(seed().id)
  const review = { ...JSON.parse(source.reviewJson!), factualConcerns: [{ claim: 'A historical claim', reason: 'Needs evidence' }], manualRewriteReview: { status: 'changes_detected', concerns: [{ reason: 'Meaning changed' }] } }
  updateHistorySource(source.id, { reviewJson: JSON.stringify(review) })
  const before = await details(source.id)
  const text = 'An edited draft.\n\nA second paragraph.\n'
  const response = await saveDraft(source.id, { rewrittenScript: text, expectedRevision: before.revision })
  assert.equal(response.status, 200)
  const after = (await response.json()).data
  assert.equal(after.rewrittenScript, text)
  assert.equal((await details(source.id)).rewrittenScript, text)
  assert.equal(after.rawTranscript, before.rawTranscript)
  assert.equal(after.correctedTranscript, before.correctedTranscript)
  assert.equal(after.status, 'needs_review')
  assert.notEqual(after.revision, before.revision)
  const savedReview = JSON.parse(after.reviewJson)
  assert.deepEqual(savedReview.factualConcerns, review.factualConcerns)
  assert.deepEqual(savedReview.manualRewriteReview, review.manualRewriteReview)
  assert.equal(savedReview.factCheckStatus, 'needs_sources')
  assert.equal(savedReview.rewriteInputSha256, review.rewriteInputSha256)
  assert.ok(savedReview.scriptTiming.estimatedSeconds > 0)
  assert.equal(savedReview.manualEdit.rewrittenScriptSha256, createHash('sha256').update(text).digest('hex'))
  assert.equal(after.artifactState.rewritten, 'current')
})

test('stale revisions cannot overwrite an intervening edit or input change', async () => {
  const source = currentDraft(seed().id)
  const before = await details(source.id)
  assert.equal((await saveDraft(source.id, { rewrittenScript: 'First edit', expectedRevision: before.revision })).status, 200)
  assert.equal((await saveDraft(source.id, { rewrittenScript: 'Overwriting edit', expectedRevision: before.revision })).status, 409)
  assert.equal((await details(source.id)).rewrittenScript, 'First edit')
  const revision = (await details(source.id)).revision
  updateHistorySource(source.id, { correctedTranscript: 'New input' })
  assert.equal((await saveDraft(source.id, { rewrittenScript: 'Old input edit', expectedRevision: revision })).status, 409)
})

test('editing a stale draft retains stale provenance and does not make it exportable', async () => {
  const source = currentDraft(seed().id)
  updateHistorySource(source.id, { rawTranscript: 'Different audio transcription' })
  const before = await details(source.id)
  const response = await saveDraft(source.id, { rewrittenScript: 'Edited stale draft', expectedRevision: before.revision })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.artifactState.rewritten, 'stale')
  assert.equal((await route.request(`/${source.id}/export`)).status, 409)
})

test('rewrite mutation validates its body, rejects processing sources and keeps a pipeline lock', async () => {
  const source = currentDraft(seed().id)
  const before = await details(source.id)
  for (const body of [
    {}, { rewrittenScript: '', expectedRevision: before.revision },
    { rewrittenScript: '  \n ', expectedRevision: before.revision },
    { rewrittenScript: 'Edit', expectedRevision: 'bad' },
    { rewrittenScript: 'Edit', expectedRevision: before.revision, rawTranscript: 'Overwrite' },
  ]) assert.equal((await saveDraft(source.id, body)).status, 400)
  assert.equal((await route.request(`/${source.id}`, { method: 'PATCH', body: '{bad' })).status, 400)
  assert.equal((await saveDraft(999999, { rewrittenScript: 'Edit', expectedRevision: before.revision })).status, 404)
  assert.equal((await saveDraft(0, {})).status, 400)
  updateHistorySource(source.id, { status: 'rewriting' })
  assert.equal((await saveDraft(source.id, { rewrittenScript: 'Edit', expectedRevision: (await details(source.id)).revision })).status, 409)
  updateHistorySource(source.id, { status: 'needs_review' })
  const directory = join(storageRoot, String(source.id))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'process.lock'), 'existing pipeline lock')
  assert.equal((await saveDraft(source.id, { rewrittenScript: 'Edit', expectedRevision: (await details(source.id)).revision })).status, 409)
  assert.equal(await readFile(join(directory, 'process.lock'), 'utf8'), 'existing pipeline lock')
})

test('human edits retain complete long drafts without a character-count gate', async () => {
  const source = currentDraft(seed().id)
  const body = '完整正文。'.repeat(10_001)
  const response = await saveDraft(source.id, { rewrittenScript: body, expectedRevision: (await details(source.id)).revision })
  assert.equal(response.status, 200)
  assert.equal((await details(source.id)).rewrittenScript, body)
})

function videoSource() {
  const source = seed()
  const directory = join(storageRoot, String(source.id))
  mkdirSync(directory, { recursive: true })
  const videoPath = join(directory, 'source.mp4')
  writeFileSync(videoPath, '0123456789')
  updateHistorySource(source.id, { mediaJson: JSON.stringify({ videoPath, videoBytes: 10, chunks: [{ path: join(directory, 'audio.wav'), start: 0 }] }) })
  return source
}

test('downloaded videos stream full, bounded, open-ended and suffix ranges with seek headers', async () => {
  const source = videoSource()
  for (const [range, expected, status, contentRange] of [
    [undefined, '0123456789', 200, null],
    ['bytes=2-5', '2345', 206, 'bytes 2-5/10'],
    ['bytes=7-', '789', 206, 'bytes 7-9/10'],
    ['bytes=-3', '789', 206, 'bytes 7-9/10'],
    ['bytes=8-999', '89', 206, 'bytes 8-9/10'],
  ] as const) {
    const response = await route.request(`/${source.id}/video`, { headers: range ? { Range: range } : {} })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('content-range'), contentRange)
    assert.equal(response.headers.get('content-length'), String(expected.length))
    assert.equal(await response.text(), expected)
  }
  const head = await route.request(`/${source.id}/video`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), '10')
  assert.equal(await head.text(), '')
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=x-y', 'items=1-2', 'bytes=0-1,4-5']) {
    const response = await route.request(`/${source.id}/video`, { headers: { Range: range } })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), 'bytes */10')
  }
  const metadata = await details(source.id)
  assert.equal(metadata.videoAvailable, true)
  assert.equal(metadata.videoUrl, `/api/v1/history-scripts/${source.id}/video`)
  assert.ok(!JSON.stringify(metadata).includes(storageRoot))
})

test('video requests cannot read arbitrary paths or symlinks outside storage', async () => {
  const source = seed()
  assert.equal((await route.request(`/${source.id}/video`)).status, 404)
  assert.equal((await route.request('/999999/video')).status, 404)
  assert.equal((await route.request('/abc/video')).status, 400)
  const privatePath = join(dbDir, 'private.txt')
  writeFileSync(privatePath, 'private data')
  updateHistorySource(source.id, { mediaJson: JSON.stringify({ videoPath: privatePath, videoBytes: 12 }) })
  assert.equal((await route.request(`/${source.id}/video?path=${encodeURIComponent(privatePath)}`)).status, 404)
  const directory = join(storageRoot, String(source.id))
  mkdirSync(directory, { recursive: true })
  const videoPath = join(directory, 'source.mp4')
  symlinkSync(privatePath, videoPath)
  updateHistorySource(source.id, { mediaJson: JSON.stringify({ videoPath, videoBytes: 12 }) })
  assert.equal((await route.request(`/${source.id}/video`)).status, 404)
  assert.equal((await details(source.id)).videoAvailable, false)
})

test('one source cannot serve another source video or an unrelated in-storage file', async () => {
  const first = videoSource()
  const second = seed('456')
  const otherPath = join(storageRoot, String(first.id), 'source.mp4')
  updateHistorySource(second.id, { mediaJson: JSON.stringify({ videoPath: otherPath }) })
  assert.equal((await route.request(`/${second.id}/video`)).status, 404)
})

test('legacy save route requires concurrency metadata and cannot bypass the processing lock', async () => {
  const source = currentDraft(seed().id)
  const put = (body: unknown) => route.request(`/${source.id}/rewrite`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await put({ rewrittenScript: 'Missing version' })).status, 400)
  updateHistorySource(source.id, { status: 'rewriting' })
  assert.equal((await put({ rewrittenScript: 'Overwrite in-flight job', expectedUpdatedAt: (await details(source.id)).updatedAt })).status, 409)
  assert.equal((await details(source.id)).rewrittenScript, source.rewrittenScript)
})
