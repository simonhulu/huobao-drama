import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {parseHistoryContinuousOptions, readHistoryContinuousPointer, startHistoryContinuousMaintenance} from './history-continuous-production.js'

const flags = ['TASK_WORKER_DISABLED', 'HISTORY_HUASHENG_WORKER_DISABLED', 'HISTORY_SOCIAL_UPLOAD_WORKER_DISABLED',
  'HISTORY_HUASHENG_EXPORT_WORKER_DISABLED', 'HISTORY_ARTICLE_WORKER_DISABLED']
const args = ['--db', '/data/original.db', '--guard', '/state/new-only-production.mjs']

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-continuous-cli-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const prior = Object.fromEntries(flags.map(flag => [flag, process.env[flag]]))
  for (const flag of flags) process.env[flag] = '1'
  t.after(() => { for (const flag of flags) {
    if (prior[flag] === undefined) delete process.env[flag]
    else process.env[flag] = prior[flag]
  } })
  return {root, baseline: {database: path.join(root, 'original.db'), project: root, maxTaskId: 40400},
    statePath: path.join(root, 'supply.json')}
}

test('CLI requires one explicit command and preserves stable request identity and inventory bounds', () => {
  const options = parseHistoryContinuousOptions(['start', ...args, '--request-id', 'history-overnight-20261112'])
  assert.equal(options.command, 'start')
  assert.equal(options.requestId, 'history-overnight-20261112')
  assert.equal(options.maxPendingMotion, 2)
  assert.equal(options.statePath, '/data/original.db.history-continuous-production.json')
  for (const invalid of [[], ['start', ...args], ['start', ...args, '--request-id', 'unstable request'],
    ['tick', 'stop', ...args], ['unknown', ...args], ['tick', ...args, '--max-pending-motion', '9'],
    ['tick', ...args, '--interval-ms', '0'], ['tick', ...args, '--interval-ms', 'Infinity']]) {
    assert.throws(() => parseHistoryContinuousOptions(invalid))
  }
  assert.equal(parseHistoryContinuousOptions(['resume', ...args]).command, 'resume')
})

test('missing historical supply pointer leaves the existing worker untouched without importing its application DB', async t => {
  const f = fixture(t), previous = process.env.DB_PATH
  const maintenance = await startHistoryContinuousMaintenance(f)
  assert.equal(maintenance.enabled, false)
  await maintenance.stop()
  assert.equal(process.env.DB_PATH, previous)
  assert.equal(fs.existsSync(f.baseline.database), false)
  assert.equal(fs.existsSync(f.statePath), false)
})

test('a supply pointer cannot enable global workers or cross the original task baseline', async t => {
  const f = fixture(t)
  fs.writeFileSync(f.statePath, JSON.stringify({version: 1, id: 'history-continuous-original', requestId: 'original',
    taskBaseline: 40399, sourceBaseline: 500, createdAt: new Date().toISOString()}))
  await assert.rejects(startHistoryContinuousMaintenance(f), /baseline differs/)
  process.env.HISTORY_SOCIAL_UPLOAD_WORKER_DISABLED = '0'
  await assert.rejects(startHistoryContinuousMaintenance(f), /worker-disable flags/)
  assert.equal(fs.existsSync(f.baseline.database), false)
})

test('malformed or linked supply pointers fail without silently minting another run', t => {
  const f = fixture(t)
  assert.equal(readHistoryContinuousPointer(f.statePath), undefined)
  fs.writeFileSync(f.statePath, '{')
  assert.throws(() => readHistoryContinuousPointer(f.statePath), SyntaxError)
  fs.writeFileSync(f.statePath, JSON.stringify({version: 1, id: 'original', requestId: 'same',
    taskBaseline: 40400, sourceBaseline: -1, createdAt: new Date().toISOString()}))
  assert.throws(() => readHistoryContinuousPointer(f.statePath), /Invalid/)
  const original = path.join(f.root, 'original.json')
  fs.writeFileSync(original, JSON.stringify({version: 1, id: 'original', requestId: 'same',
    taskBaseline: 40400, sourceBaseline: 500, createdAt: new Date().toISOString()}))
  fs.unlinkSync(f.statePath)
  fs.symlinkSync(original, f.statePath)
  assert.throws(() => readHistoryContinuousPointer(f.statePath), /ordinary file/)
  assert.equal(readHistoryContinuousPointer(original)!.id, 'original')
})

test('stopping closes independent service controllers before waiting for a blocked pass', async t => {
  const f = fixture(t)
  fs.writeFileSync(f.statePath, JSON.stringify({version: 1, id: 'history-continuous-original', requestId: 'original',
    taskBaseline: 40400, sourceBaseline: 500, createdAt: new Date().toISOString()}))
  let complete!: () => void, closes = 0, aborted = false
  const pending = new Promise<void>(resolve => { complete = resolve })
  const maintenance = await startHistoryContinuousMaintenance({...f, createRuntime: ({signal}) => ({
    controller: {tick: async id => { assert.equal(id, 'history-continuous-original'); await pending }},
    close: async () => { closes++; aborted = signal.aborted; complete() },
  })})
  await Promise.race([Promise.all([maintenance.stop(), maintenance.stop()]), new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(Error('Stop waited on a pass before canceling its service')), 500)
    timeout.unref()
  })])
  assert.equal(closes, 1)
  assert.equal(aborted, true)
  assert.equal(fs.existsSync(f.baseline.database), false)
})

test('maintenance propagates a service close failure after the current pass settles', async t => {
  const f = fixture(t)
  fs.writeFileSync(f.statePath, JSON.stringify({version: 1, id: 'original', requestId: 'original',
    taskBaseline: 40400, sourceBaseline: 500, createdAt: new Date().toISOString()}))
  let observed = false
  const maintenance = await startHistoryContinuousMaintenance({...f, createRuntime: () => ({
    controller: {tick: async () => { observed = true }}, close: async () => { throw Error('close failed') },
  })})
  await assert.rejects(maintenance.stop(), /did not stop cleanly/)
  assert.equal(observed, true)
})
