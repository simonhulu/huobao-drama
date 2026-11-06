import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HistorySource } from './history-script-library.js'
import type { HistoryRecreationResult } from './history-script-recreation.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-script-preparation-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.TASK_WORKER_DISABLED = '1'
const storageRoot = path.join(root, 'source-locks')
const { db } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource, getHistorySource, getHistorySourceArtifactState } = await import('./history-script-library.js')
const { prepareHistorySourceScript, needsHistoryScriptCondensation, historyScriptCondensationRecord } = await import('./history-script-preparation.js')
const { recordHistoryDualProduction, recordHistoryVideoDelivery } = await import('./history-video-deliveries.js')
const hash = (script: string) => createHash('sha256').update(script).digest('hex')
type PrepareOptions = NonNullable<Parameters<typeof prepareHistorySourceScript>[1]>
const prepare = (source: HistorySource, options: PrepareOptions = {}) => prepareHistorySourceScript(source, { ...options, storageRoot })
const lockExists = (source: HistorySource) => fs.existsSync(path.join(storageRoot, String(source.id), 'process.lock'))
let serial = 0

after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function result(script = '缩'.repeat(4300)): HistoryRecreationResult {
  return { script, title: '测试历史稿', coverText: '', skillName: 'history-source-paraphrase',
    skillRevision: 'test-condensation-v1', skillSha256: 'c'.repeat(64), provider: 'remote-writer', model: 'test-writing-model' }
}

function source(script = '史'.repeat(6000), review: Record<string, unknown> = {}): HistorySource {
  const raw = '完整原始转写。', corrected = '完整校对稿。'
  const stored = storeHistorySource({ sourceVideoId: String(++serial), title: '测试历史稿', authorName: '来源作者',
    category: 'regional_history', selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
  return updateHistorySource(stored.id, { status: 'failed', lastError: '先前制作失败',
    rawTranscript: raw, correctedTranscript: corrected, rewrittenScript: script,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 2, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text: raw, sourceVideoSha256: '1'.repeat(64),
      chunks: [{ index: 0, start: 0, duration: 2, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(raw),
      correctedTranscriptSha256: hash(corrected), rewriteInputSha256: hash(corrected),
      factualConcerns: [{ claim: '待查证史实', reason: '仍需史料' }],
      recreation: { model: 'previous-writer', skillRevision: 'previous-version' },
      huashengQueue: { jobId: 22, scriptSha256: hash(script) }, ...review }) })!
}

test('the 4500-character threshold counts non-whitespace code points and markers match the exact manuscript', () => {
  assert.equal(needsHistoryScriptCondensation('史'.repeat(4500)), false)
  assert.equal(needsHistoryScriptCondensation('𠀀'.repeat(4500)), false)
  assert.equal(needsHistoryScriptCondensation(` ${'史'.repeat(4500)} \n\t`), false)
  const script = '史'.repeat(4501)
  assert.equal(needsHistoryScriptCondensation(script), true)
  assert.equal(needsHistoryScriptCondensation(script, { scriptCondensation: { scriptSha256: hash(script) } }), false)
  assert.equal(needsHistoryScriptCondensation(`${script}。`, { scriptCondensation: { scriptSha256: hash(script) } }), true)
})

test('a condensation record preserves the complete old draft and the 15-minute soft target', () => {
  const previous = `旧稿\n${'𠀀 '.repeat(4501)}`, condensed = result('缩'.repeat(4600))
  const record = historyScriptCondensationRecord(previous, condensed)
  assert.equal(record.previousScript, previous)
  assert.equal(record.previousScriptSha256, hash(previous))
  assert.equal(record.scriptSha256, hash(condensed.script))
  assert.equal(record.originalCharacters, 4503)
  assert.equal(record.characters, 4600)
  assert.equal(record.targetCharacters, 4500)
  assert.equal(record.targetSeconds, 900)
  assert.equal(record.charactersPerMinute, 300)
  assert.equal(record.model, condensed.model)
  assert.equal(record.provider, condensed.provider)
  assert.equal(record.skillRevision, condensed.skillRevision)
  assert.equal(record.skillSha256, condensed.skillSha256)
  assert.ok(Number.isFinite(Date.parse(record.preparedAt)))
})

test('preparation saves one shared new manuscript while preserving raw evidence and old production versions', async () => {
  const original = source(), condensed = result('缩'.repeat(4600))
  db.$client.exec(`CREATE TABLE IF NOT EXISTS history_motion_productions (
    id TEXT PRIMARY KEY, script_id INTEGER NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL)`)
  const oldMotion = JSON.stringify({ id: 'old-motion', scriptId: original.id, script: original.rewrittenScript,
    status: 'failed', factory: { episodeId: 1229, scriptHash: hash(original.rewrittenScript!) } })
  db.$client.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)')
    .run('old-motion', original.id, 'failed', 'before', oldMotion)
  recordHistoryDualProduction(db.$client, original.id, hash(original.rewrittenScript!), 22)
  recordHistoryVideoDelivery(db.$client, { scriptId: original.id, scriptSha256: hash(original.rewrittenScript!),
    producer: 'motion', producerJobId: 'old-motion', videoUrl: '/static/old-preserved.mp4',
    videoName: 'old-preserved.mp4', duration: 100, sha256: 'd'.repeat(64) })
  const production = db.$client.prepare('SELECT * FROM history_dual_production WHERE source_id=?').all(original.id)
  const delivery = db.$client.prepare('SELECT * FROM history_video_deliveries WHERE script_id=?').all(original.id)
  let calls = 0
  const controller = new AbortController()
  const prepared = await prepare(original, { signal: controller.signal, condense: async (script, options) => {
    calls++
    assert.equal(script, original.rewrittenScript)
    assert.ok(options)
    assert.equal(options.signal, controller.signal)
    assert.equal(options.sourceTitle, original.title)
    assert.equal(options.sourceAuthor, original.authorName)
    assert.equal(lockExists(original), true)
    assert.equal(getHistorySource(original.id)!.rewrittenScript, script, 'No intermediate draft is saved')
    return condensed
  } })
  const review = JSON.parse(prepared.reviewJson!)
  assert.equal(calls, 1)
  assert.equal(prepared.rewrittenScript, condensed.script)
  assert.equal(prepared.status, 'needs_review')
  assert.equal(prepared.lastError, null)
  assert.equal(prepared.rawTranscript, original.rawTranscript)
  assert.equal(prepared.correctedTranscript, original.correctedTranscript)
  assert.equal(prepared.mediaJson, original.mediaJson)
  assert.equal(prepared.asrJson, original.asrJson)
  assert.equal(review.draftOrigin, 'source_paraphrase')
  assert.equal(review.recreation.model, condensed.model)
  assert.equal(review.recreation.skillRevision, condensed.skillRevision)
  assert.equal('script' in review.recreation, false)
  assert.equal('huashengQueue' in review, false)
  assert.deepEqual(review.factualConcerns, JSON.parse(original.reviewJson!).factualConcerns)
  assert.equal(review.scriptCondensation.previousScript, original.rewrittenScript)
  assert.equal(review.scriptCondensation.scriptSha256, hash(condensed.script))
  assert.notEqual(review.scriptCondensation.scriptSha256, hash(original.rewrittenScript!))
  assert.equal(review.scriptTiming.spokenUnits, 4600)
  assert.equal(getHistorySourceArtifactState(prepared).rewritten, 'current')
  assert.deepEqual(db.$client.prepare('SELECT * FROM history_dual_production WHERE source_id=?').all(original.id), production)
  assert.deepEqual(db.$client.prepare('SELECT * FROM history_video_deliveries WHERE script_id=?').all(original.id), delivery)
  assert.equal((db.$client.prepare('SELECT snapshot FROM history_motion_productions WHERE id=?').get('old-motion') as { snapshot: string }).snapshot, oldMotion)
  assert.equal(lockExists(original), false)
  assert.equal((await prepare(prepared, { condense: async () => assert.fail('A slightly over-target prepared draft must be reused') })).rewrittenScript, condensed.script)
})

test('short drafts and slightly over-target drafts with matching records bypass generation and locking', async () => {
  for (const script of ['短稿。', '史'.repeat(4500), '史'.repeat(4600)]) {
    const original = source(script, script.length > 4500 ? { scriptCondensation: { scriptSha256: hash(script) } } : {})
    const prepared = await prepare(original, { condense: async () => assert.fail('Prepared or short drafts must not call the model') })
    assert.equal(prepared, original)
    assert.deepEqual(getHistorySource(original.id), original)
    assert.equal(fs.existsSync(path.join(storageRoot, String(original.id))), false)
  }
})

test('manual edits invalidate an earlier condensation marker and preserve the edited draft as the next backup', async () => {
  const previous = '史'.repeat(4600), original = source(previous, { scriptCondensation: { scriptSha256: hash(previous) } })
  const edited = updateHistorySource(original.id, { rewrittenScript: `${previous}人工追加的材料。` })!
  let calls = 0
  const prepared = await prepare(edited, { condense: async script => {
    calls++
    assert.equal(script, edited.rewrittenScript)
    return result()
  } })
  assert.equal(calls, 1)
  const record = JSON.parse(prepared.reviewJson!).scriptCondensation
  assert.equal(record.previousScript, edited.rewrittenScript)
  assert.equal(record.previousScriptSha256, hash(edited.rewrittenScript!))
  assert.equal(record.scriptSha256, hash(prepared.rewrittenScript!))
})

test('provider failure leaves the old draft and queue intact and releases the source for retry', async () => {
  const original = source()
  await assert.rejects(prepare(original, { condense: async () => { throw Error('Writer unavailable') } }), /Writer unavailable/)
  assert.deepEqual(getHistorySource(original.id), original)
  assert.equal(lockExists(original), false)
  assert.equal((await prepare(original, { condense: async () => result() })).rewrittenScript, result().script)
})

test('a failed database save rolls back all source fields and releases its lock', async () => {
  const original = source()
  db.$client.exec(`CREATE TRIGGER reject_test_condensation BEFORE UPDATE ON history_script_sources
    WHEN NEW.id=${original.id} BEGIN SELECT RAISE(ABORT, 'test write rejected'); END`)
  try {
    await assert.rejects(prepare(original, { condense: async () => result() }), /test write rejected/)
    assert.deepEqual(getHistorySource(original.id), original)
    assert.equal(lockExists(original), false)
  } finally { db.$client.exec('DROP TRIGGER reject_test_condensation') }
  assert.equal((await prepare(original, { condense: async () => result() })).rewrittenScript, result().script)
})

test('pre-aborted preparation and cancellation during generation cannot save a replacement', async () => {
  for (const duringGeneration of [false, true]) {
    const original = source(), controller = new AbortController()
    if (!duringGeneration) controller.abort(new Error('Preparation canceled'))
    let calls = 0
    await assert.rejects(prepare(original, { signal: controller.signal, condense: async () => {
      calls++
      assert.equal(duringGeneration, true)
      controller.abort(new Error('Preparation canceled'))
      return result()
    } }), /Preparation canceled/)
    assert.equal(calls, duringGeneration ? 1 : 0)
    assert.deepEqual(getHistorySource(original.id), original)
    assert.equal(lockExists(original), false)
  }
})

test('a stale caller cannot condense or overwrite a newly edited manuscript', async () => {
  const original = source()
  const current = updateHistorySource(original.id, { rewrittenScript: '新的人工稿。' })!
  await assert.rejects(prepare(original, { condense: async () => assert.fail('Do not generate from an obsolete snapshot') }), /稿件已更新/)
  assert.deepEqual(getHistorySource(original.id), current)
  assert.equal(lockExists(original), false)
})

test('edits during generation win over the returned draft and release the lock', async () => {
  const original = source()
  let edited: HistorySource | undefined
  await assert.rejects(prepare(original, { condense: async () => {
    edited = updateHistorySource(original.id, { rewrittenScript: '生成期间保存的人工稿。' })!
    return result()
  } }), /缩写期间稿件已更新/)
  assert.deepEqual(getHistorySource(original.id), edited)
  assert.equal(JSON.parse(edited!.reviewJson!).scriptCondensation, undefined)
  assert.equal(lockExists(original), false)
})

test('concurrent preparation cannot generate a second draft while the first owns the source lock', async () => {
  const original = source()
  let signalEntered!: () => void
  let finish!: (value: HistoryRecreationResult) => void
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const generated = new Promise<HistoryRecreationResult>(resolve => { finish = resolve })
  const pending = prepare(original, { condense: async () => { signalEntered(); return generated } })
  await entered
  try {
    await assert.rejects(prepare(original, { condense: async () => assert.fail('A locked source must not generate twice') }), /is locked/)
    assert.equal(getHistorySource(original.id)!.rewrittenScript, original.rewrittenScript)
  } finally { finish(result()) }
  assert.equal((await pending).rewrittenScript, result().script)
  assert.equal(lockExists(original), false)
})
