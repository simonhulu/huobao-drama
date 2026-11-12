import test, {after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import type {ScienceJob} from './science-workflow.js'
import type {ScienceCollectionRun} from './science-collection.js'

const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'science-overview-import-'))
const environment = {
  DB_PATH: path.join(importRoot, 'test.db'), TASK_WORKER_DISABLED: '1',
  HISTORY_HUASHENG_WORKER_DISABLED: '1', HISTORY_HUASHENG_EXPORT_WORKER_DISABLED: '1',
  HISTORY_SOCIAL_UPLOAD_WORKER_DISABLED: '1', HISTORY_ARTICLE_WORKER_DISABLED: '1',
}
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
Object.assign(process.env, environment)
const {ScienceWorkflowService} = await import('./science-workflow.js')
const {ScienceCollectionService} = await import('./science-collection.js')
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(importRoot, {recursive: true, force: true})
})

const timestamp = '2026-11-11T00:00:00.000Z'
function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'science-overview-')))
  const workflow = new ScienceWorkflowService({root: path.join(root, 'jobs')})
  const collection = new ScienceCollectionService({stateRoot: path.join(root, 'collection'), workflow})
  t.after(async () => {
    await collection.stop(); await workflow.stop()
    fs.rmSync(root, {recursive: true, force: true})
  })
  function save(file: string, value: unknown) {
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, JSON.stringify(value))
  }
  function run(fields: Partial<ScienceCollectionRun> & {ownerPid?: number; collectionOwnerPid?: number} = {}) {
    const id = `science-batch-${randomUUID()}`
    const value = {version: 1, id, requestId: randomUUID(), inputHash: 'seed', youtubeChannels: [],
      targetCount: 1, mode: 'drafts', huashengAccountName: 'hs-one', baijiahaoAccountName: 'bj-one',
      status: 'completed', message: 'Stored batch', currentChannel: null, currentJobId: null,
      collection: {status: 'completed', message: 'Collected'}, processing: {status: 'completed', message: 'Finished'},
      counts: {scanned: 0, selected: 0, skipped: 0, completed: 0, failed: 0},
      items: [], channelErrors: [], logs: [], createdAt: timestamp, updatedAt: timestamp, ...fields}
    const file = path.join(collection.stateRoot, 'runs', `${id}.json`)
    save(file, value)
    return {id, file, value}
  }
  function job(batch?: ReturnType<typeof run>, fields: Partial<ScienceJob> & {ownerPid?: number; automaticDelivery?: boolean} = {}) {
    const id = `science-${randomUUID()}`
    const value = {version: 1, id, sourceUrl: `https://youtu.be/${id.replaceAll('-', '').slice(-11)}`,
      title: 'Stored source', createdAt: timestamp, updatedAt: timestamp, status: 'draft', stage: 'produce',
      message: 'Draft ready', transcript: 'Source transcript', script: 'Ready draft', media: {}, sourceTitle: '', sourceAuthor: '',
      factChecks: [], sources: [], projectUrl: null, checkpoint: null, logs: [], upload: null,
      huashengAccountName: 'hs-one', baijiahaoAccountName: 'bj-one', collectionId: batch?.id, ...fields}
    const file = path.join(workflow.root, id, 'job.json')
    save(file, value)
    return {id, file, value}
  }
  function item(source: ReturnType<typeof job>, status: 'completed' | 'running' | 'queued' = 'completed') {
    return {jobId: source.id, sourceUrl: source.value.sourceUrl, videoId: source.value.sourceUrl.slice(-11),
      title: 'Stored source', status, message: 'Stored item'}
  }
  return {collection, workflow, save, run, job, item}
}

test('overview reads one job snapshot across batches and refreshes external pause, deletion and account edits', t => {
  const h = fixture(t)
  const one = h.run(), two = h.run({createdAt: '2026-11-11T01:00:00.000Z'}), empty = h.run({createdAt: '2026-11-11T02:00:00.000Z'})
  const paused = h.job(one), deleted = h.job(one), account = h.job(two)
  h.job()
  const storedOne = {...one.value, items: [h.item(paused)]}
  const storedTwo = {...two.value, items: [h.item(account)]}
  h.save(one.file, storedOne); h.save(two.file, storedTwo)
  const reads = t.mock.method(fs, 'readFileSync')
  const first = h.collection.overview()
  assert.equal(reads.mock.calls.filter(call => String(call.arguments[0]).endsWith('/job.json')).length, 4)
  reads.mock.resetCalls()
  assert.deepEqual(first.runs.map(run => run.id), [empty.id, two.id, one.id])
  assert.deepEqual(first.runs[0]!.items, [])
  assert.equal(first.runs[2]!.counts.completed, 2)
  assert.ok(first.runs[2]!.items.some(item => item.jobId === deleted.id && item.status === 'completed'))
  assert.deepEqual(JSON.parse(fs.readFileSync(one.file, 'utf8')), storedOne)
  first.runs[2]!.items[0]!.title = 'Caller edit'
  first.runs[2]!.logs.push({at: timestamp, message: 'Caller edit'})
  first.runs[2]!.counts.completed = 99

  h.save(paused.file, {...paused.value, status: 'paused', script: '', automaticDelivery: false, message: 'External pause'})
  h.save(deleted.file, {...deleted.value, deletedAt: timestamp})
  h.save(account.file, {...account.value, huashengAccountName: 'hs-other'})
  reads.mock.resetCalls()
  const second = h.collection.overview()
  assert.equal(reads.mock.calls.filter(call => String(call.arguments[0]).endsWith('/job.json')).length, 4)
  const current = second.runs.find(run => run.id === one.id)!
  assert.deepEqual(current.items.map(item => item.status), ['paused', 'deleted'])
  assert.equal(current.items[0]!.message, 'External pause')
  assert.equal(current.items[0]!.title, 'Stored source')
  assert.equal(current.items[1]!.completedBeforeDeletion, true)
  assert.equal(current.counts.completed, 1)
  assert.deepEqual(current.logs, [])
  const rebound = second.runs.find(run => run.id === two.id)!
  assert.equal(rebound.items[0]!.status, 'queued')
  assert.equal(rebound.counts.completed, 0)
  assert.equal(rebound.huashengAccountName, 'hs-one')
  assert.equal(rebound.baijiahaoAccountName, 'bj-one')
  assert.equal(second.activeRun, null)
  assert.equal(second.activeCollection, null)
  assert.deepEqual(JSON.parse(fs.readFileSync(one.file, 'utf8')), storedOne)
  assert.deepEqual(JSON.parse(fs.readFileSync(two.file, 'utf8')), storedTwo)
})

test('overview preserves read-time owner and legacy repairs while synchronizing a cloned batch', t => {
  const h = fixture(t), batch = h.run()
  const interrupted = h.job(batch, {status: 'running', ownerPid: process.pid, script: ''})
  const legacy = h.job(batch)
  h.save(legacy.file, {...legacy.value, status: 'review', stage: 'review'})
  h.save(batch.file, {...batch.value, status: 'running', ownerPid: process.pid, collectionOwnerPid: process.pid,
    collection: {status: 'running', message: 'Collecting'}, processing: {status: 'running', message: 'Producing'},
    currentChannel: 'https://www.youtube.com/@ScienceOverview', currentJobId: interrupted.id,
    items: [h.item(interrupted, 'running'), h.item(legacy, 'queued')]})
  const reads = t.mock.method(fs, 'readFileSync')
  const result = h.collection.overview().runs[0]!
  assert.equal(reads.mock.calls.filter(call => String(call.arguments[0]).endsWith('/job.json')).length, 2)
  assert.equal(result.status, 'interrupted')
  assert.equal(result.processing!.status, 'interrupted')
  assert.equal(result.collection!.status, 'interrupted')
  assert.equal(result.currentJobId, null)
  assert.equal(result.currentChannel, null)
  assert.deepEqual(result.items.map(item => item.status), ['paused', 'completed'])
  assert.equal(result.counts.completed, 1)
  assert.equal('ownerPid' in result, false)
  assert.equal('collectionOwnerPid' in result, false)
  const storedRun = JSON.parse(fs.readFileSync(batch.file, 'utf8'))
  assert.equal(storedRun.status, 'interrupted')
  assert.equal(storedRun.ownerPid, undefined)
  assert.equal(storedRun.collectionOwnerPid, undefined)
  assert.deepEqual(storedRun.items.map((item: {status: string}) => item.status), ['queued', 'queued'])
  assert.equal(storedRun.counts.completed, 0)
  const storedJob = JSON.parse(fs.readFileSync(interrupted.file, 'utf8'))
  assert.equal(storedJob.status, 'paused')
  assert.equal(storedJob.ownerPid, undefined)
  const storedLegacy = JSON.parse(fs.readFileSync(legacy.file, 'utf8'))
  assert.equal(storedLegacy.status, 'queued')
  assert.equal(storedLegacy.stage, 'produce')
})

test('overview without batches does not read unrelated job records', t => {
  const h = fixture(t)
  h.job()
  const reads = t.mock.method(fs, 'readFileSync')
  assert.deepEqual(h.collection.overview().runs, [])
  assert.equal(reads.mock.calls.filter(call => String(call.arguments[0]).endsWith('/job.json')).length, 0)
})
