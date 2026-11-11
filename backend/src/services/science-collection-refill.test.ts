import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {ScienceCollectionService, type ScienceCollectionOptions} from './science-collection.js'
import {ScienceWorkflowError, type ScienceJob} from './science-workflow.js'

const channel = 'https://www.youtube.com/@ScienceRefill/videos'
const timestamp = new Date(Date.now() - 60_000).toISOString()
const later = (milliseconds: number) => new Date(Date.parse(timestamp) + milliseconds).toISOString()
function fixture(t: test.TestContext, config: {empty?: boolean; enabled?: boolean; available?: number} = {}) {
  const previous = process.env.SCIENCE_COLLECTION_REFILL_ENABLED
  if (config.enabled !== false) process.env.SCIENCE_COLLECTION_REFILL_ENABLED = '1'
  else delete process.env.SCIENCE_COLLECTION_REFILL_ENABLED
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-refill-'))
  const jobs = new Map<string, ScienceJob>(), calls: string[] = [], visits: string[] = []
  let now = Date.parse(timestamp), validationError: string | undefined
  const workflow: NonNullable<ScienceCollectionOptions['workflow']> = {
    validateBatchAccounts(_mode, hs, bj) {
      if (validationError) throw new ScienceWorkflowError(validationError)
      return {huashengAccountName: hs ?? 'hs-current', baijiahaoAccountName: bj ?? 'bj-current'}
    },
    knownYoutubeIds: () => new Set([...jobs.values()].map(job => new URL(job.sourceUrl).searchParams.get('v')!)),
    jobsForCollection: id => structuredClone([...jobs.values()].filter(job => job.collectionId === id)),
    create(input, options = {}) {
      assert.equal(options.defer, true); assert.equal(options.collectionOnly, true)
      const job = makeJob(options.collectionId!, {title: input.title, sourceUrl: input.sourceUrl,
        huashengAccountName: input.huashengAccountName ?? null, baijiahaoAccountName: input.baijiahaoAccountName ?? null})
      jobs.set(job.id, job); return structuredClone(job)
    },
    cancel(id) { const job = jobs.get(id)!; job.status = 'paused'; return structuredClone(job) },
    async runBatchJob(id, _mode, signal) {
      calls.push(id)
      const job = jobs.get(id)!
      job.status = 'running'; job.executionActive = true
      try {
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), {once: true})
        })
      } finally { job.executionActive = false; job.status = 'paused' }
      return structuredClone(job)
    },
  }
  const options: ScienceCollectionOptions = {stateRoot: root, workflow, now: () => now, collect: async input => {
    visits.push(input.url)
    if (!config.empty) for (let index = 0; index < (config.available ?? 30); index++) {
      if (input.isTargetReached()) return
      const videoId = `refill${String(index).padStart(5, '0')}`
      if (input.isKnownVideo(videoId)) continue
      await input.onCandidate({videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: `Source ${index}`,
        authorName: 'Source', observedAt: timestamp, collectionUrl: input.url})
    }
    input.report({stage: 'exhausted', message: 'Channel exhausted', scanned: 30})
  }}
  const service = new ScienceCollectionService(options), services = [service]
  service.saveSettings({youtubeChannels: [channel], targetCount: 999, mode: 'videos',
    huashengAccountName: 'hs-current', baijiahaoAccountName: 'bj-current'})
  t.after(async () => {
    for (const current of services) await current.stop()
    fs.rmSync(root, {recursive: true, force: true})
    if (previous === undefined) delete process.env.SCIENCE_COLLECTION_REFILL_ENABLED
    else process.env.SCIENCE_COLLECTION_REFILL_ENABLED = previous
  })
  function makeJob(collectionId: string, fields: Partial<ScienceJob> = {}): ScienceJob {
    return {id: `science-${randomUUID()}`, title: 'Seed', sourceUrl: `https://www.youtube.com/watch?v=seed${randomUUID().replaceAll('-', '').slice(0, 7)}`,
      createdAt: timestamp, updatedAt: timestamp, status: 'draft', stage: 'download', message: 'Queued', transcript: '', script: '',
      factChecks: [], sources: [], projectUrl: null, checkpoint: null, sourceVideoUrl: null, videoUrl: null,
      landscapeCoverUrl: null, portraitCoverUrl: null, huashengAccountName: 'hs-current', baijiahaoAccountName: 'bj-current',
      logs: [], upload: null, hasUploadAttempt: false, collectionId, ...fields}
  }
  function seed(count: number, fields: Record<string, any> = {}, jobFields: Partial<ScienceJob> = {}) {
    const id = `science-batch-${randomUUID()}`
    const run: any = {version: 1, id, requestId: `seed-${randomUUID()}`, inputHash: 'seed', youtubeChannels: [channel],
      targetCount: count, mode: 'videos', huashengAccountName: 'hs-current', baijiahaoAccountName: 'bj-current',
      status: 'running', message: 'Queued', currentChannel: null, currentJobId: null,
      collection: {status: 'completed', message: 'Sources stored'}, processing: {status: 'queued', message: 'Queued'},
      counts: {scanned: count, selected: count, skipped: 0, completed: 0, failed: 0}, items: [], channelErrors: [], logs: [],
      createdAt: timestamp, updatedAt: timestamp, ...fields}
    for (let index = 0; index < count; index++) {
      const job = makeJob(id, {huashengAccountName: run.huashengAccountName, baijiahaoAccountName: run.baijiahaoAccountName, ...jobFields})
      jobs.set(job.id, job)
      run.items.push({jobId: job.id, videoId: new URL(job.sourceUrl).searchParams.get('v'), sourceUrl: job.sourceUrl,
        title: job.title, status: 'queued', message: 'Queued'})
    }
    fs.mkdirSync(path.join(root, 'runs'), {recursive: true})
    const filename = path.join(root, 'runs', `${id}.json`)
    fs.writeFileSync(filename, JSON.stringify(run))
    return {id, run, filename, jobs: [...jobs.values()].filter(job => job.collectionId === id)}
  }
  return {root, service, jobs, calls, visits, seed, options,
    authorize(fields: Record<string, any> = {}) {
      return seed(0, {status: 'completed', processing: {status: 'completed', message: 'Finished'},
        createdAt: later(1000), updatedAt: later(1000), ...fields})
    },
    advance(ms: number) { now += ms }, block(message?: string) { validationError = message },
    restart() { const current = new ScienceCollectionService(options); services.push(current); return current },
    intents() { const directory = path.join(root, 'refill'); return fs.existsSync(directory)
      ? fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [] },
    async collected() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!service.overview().activeCollection) return
        await new Promise(resolve => setImmediate(resolve))
      }
      assert.fail('Collector did not finish')
    },
  }
}

test('refill is explicitly disabled by default', async t => {
  const h = fixture(t, {enabled: false})
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 0); assert.equal(h.intents().length, 0)
})

for (const pending of [0, 1, 2, 3, 8]) test(`refill keeps the low/high watermarks with ${pending} consumable jobs`, async t => {
  const h = fixture(t)
  if (pending) h.seed(pending)
  h.service.runAutomaticRecovery(); await h.collected()
  const refill = h.service.overview().runs.find(run => run.items.some(item => item.sourceUrl.includes('refill')))
  if (pending >= 3) assert.equal(refill, undefined)
  else {
    assert.equal(refill?.targetCount, 8 - pending)
    assert.equal(h.jobs.size, 8)
    assert.equal(h.intents().length, 1)
    if (pending) assert.equal(h.calls[0], [...h.jobs.values()].find(job => !job.sourceUrl.includes('refill'))?.id)
  }
})

test('completed drafts and unrelated accounts do not count as consumable current video stock', async t => {
  const h = fixture(t)
  h.seed(12, {mode: 'drafts', status: 'completed', processing: {status: 'completed', message: 'Drafts ready'}},
    {status: 'draft', stage: 'produce', transcript: 'Original', script: 'Draft'})
  h.seed(5, {huashengAccountName: 'hs-old', status: 'completed', processing: {status: 'completed', message: 'Done'}})
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.service.overview().runs.find(run => run.items.some(item => item.sourceUrl.includes('refill')))?.targetCount, 8)
})

test('crash before start reuses the durable intent and its full settings snapshot', async t => {
  const h = fixture(t)
  h.service.start = () => { throw new Error('Simulated crash before start') }
  assert.throws(() => h.service.runAutomaticRecovery(), /Simulated crash/)
  const original = h.intents()[0]
  assert.ok(original?.request.requestId)
  fs.writeFileSync(path.join(h.root, 'collector.lock'), JSON.stringify({pid: 99999999, id: 'crashed', token: 'stale'}))
  const restarted = h.restart()
  restarted.saveSettings({targetCount: 1})
  restarted.runAutomaticRecovery(); await h.collected()
  const runs: any[] = fs.readdirSync(path.join(h.root, 'runs')).map(name => JSON.parse(fs.readFileSync(path.join(h.root, 'runs', name), 'utf8')))
  assert.equal(runs.length, 1); assert.equal(runs[0].requestId, original.request.requestId)
  assert.deepEqual(runs[0].youtubeChannels, original.settings.youtubeChannels)
  assert.equal(runs[0].targetCount, 8)
})

test('crash after start cannot create a second batch for the same intent', async t => {
  const h = fixture(t)
  const start = h.service.start.bind(h.service)
  h.service.start = (...args) => { start(...args); throw new Error('Simulated crash after start') }
  assert.throws(() => h.service.runAutomaticRecovery(), /Simulated crash/)
  await h.collected()
  const restarted = h.restart()
  restarted.runAutomaticRecovery(); await h.collected()
  assert.equal(fs.readdirSync(path.join(h.root, 'runs')).length, 1)
  assert.equal(h.jobs.size, 8)
})

test('two instances share collector exclusion and a live foreign lock leaves no intent', async t => {
  const h = fixture(t), second = h.restart()
  const lock = path.join(h.root, 'collector.lock')
  fs.writeFileSync(lock, JSON.stringify({pid: process.ppid, id: 'foreign', token: 'owned'}))
  h.service.runAutomaticRecovery(); second.runAutomaticRecovery()
  assert.equal(h.intents().length, 0); assert.equal(h.jobs.size, 0)
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'owned')
  fs.rmSync(lock)
  h.service.runAutomaticRecovery(); second.runAutomaticRecovery(); await h.collected()
  assert.equal(h.intents().length, 1); assert.equal(h.jobs.size, 8)
  assert.equal(fs.readdirSync(path.join(h.root, 'runs')).length, 1)
})

test('independent processes admit only one refill intent and collector', {timeout: 15_000}, async t => {
  const h = fixture(t), processes: ReturnType<typeof spawn>[] = []
  const dispatches = path.join(h.root, 'dispatches')
  const script = `
import fs from 'node:fs';
import {ScienceCollectionService} from ${JSON.stringify(new URL('./science-collection.ts', import.meta.url).href)};
const service = new ScienceCollectionService({stateRoot:${JSON.stringify(h.root)},workflow:{
  validateBatchAccounts:(_mode,hs,bj)=>({huashengAccountName:hs,baijiahaoAccountName:bj}),
  knownYoutubeIds:()=>new Set(),jobsForCollection:()=>[],
},collect:async ({signal})=>{
  fs.appendFileSync(${JSON.stringify(dispatches)},process.pid+'\\n');
  await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});
}});
process.on('message',async()=>{await service.stop();process.disconnect()});
service.runAutomaticRecovery();
await new Promise(resolve=>setImmediate(resolve));
process.send('ready');
`
  t.after(() => { for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL') })
  const ready = [0, 1].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    processes.push(child)
    let stderr = ''
    child.stderr!.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('message', () => resolve())
    child.once('exit', code => { if (code) reject(Error(stderr || `Child exited ${code}`)) })
    child.stdin!.end(script)
  }))
  await Promise.all(ready)
  assert.equal(fs.readFileSync(dispatches, 'utf8').trim().split('\n').length, 1)
  assert.equal(h.intents().length, 1)
  assert.equal(fs.readdirSync(path.join(h.root, 'runs')).length, 1)
  await Promise.all(processes.map(child => new Promise<void>((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`Child exited ${code}`)))
    child.send('stop')
  })))
})

for (const lockName of ['collector.lock', 'worker.lock']) test(`independent stale ${lockName} reclaimers preserve the winner's live token`, {timeout: 15_000}, async t => {
  const h = fixture(t), legacyLock = path.join(h.service.stateRoot, lockName), gate = path.join(h.root, 'release-reclaimer')
  if (lockName === 'worker.lock') h.seed(1)
  fs.writeFileSync(legacyLock, JSON.stringify({pid: 99999999, id: 'dead-owner', token: 'dead-token'}))
  const dispatches = path.join(h.root, 'stale-dispatches')
  const children: ReturnType<typeof spawn>[] = []
  function child(pause: boolean) {
    const source = `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const jobs=${JSON.stringify([...h.jobs.values()])};
const wait=signal=>new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});
if(${pause}){
 const remove=fs.rmSync;let paused=false;
 fs.rmSync=function(filename,...args){
  if(String(filename)===${JSON.stringify(legacyLock)}&&!paused){
   paused=true;process.send('paused');const deadline=Date.now()+10000;
   while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>deadline)throw Error('Reclaim gate timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}
  }
  return remove.call(fs,filename,...args);
 };
 syncBuiltinESMExports();
}
const {ScienceCollectionService}=await import(${JSON.stringify(new URL('./science-collection.ts', import.meta.url).href)});
const service=new ScienceCollectionService({stateRoot:${JSON.stringify(h.root)},workflow:{
 validateBatchAccounts:(_mode,hs,bj)=>({huashengAccountName:hs,baijiahaoAccountName:bj}),
 knownYoutubeIds:()=>new Set(),jobsForCollection:id=>jobs.filter(job=>job.collectionId===id),
 runBatchJob:async(id,mode,signal)=>{fs.appendFileSync(${JSON.stringify(dispatches)},'process '+process.pid+'\\n');await wait(signal)},
},collect:async({signal})=>{fs.appendFileSync(${JSON.stringify(dispatches)},'collect '+process.pid+'\\n');await wait(signal)}});
process.on('message',async()=>{await service.stop();process.disconnect()});
const result=service.runAutomaticRecovery();await new Promise(resolve=>setImmediate(resolve));process.send({ready:true,result});
`
    const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {...process.env, SCIENCE_COLLECTION_REFILL_ENABLED: lockName === 'collector.lock' ? '1' : '0'},
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    children.push(processChild)
    let paused!: () => void, ready!: (value: any) => void, fail!: (error: Error) => void
    const pausedPromise = new Promise<void>(resolve => { paused = resolve })
    const readyPromise = new Promise<any>((resolve, reject) => { ready = resolve; fail = reject })
    let stderr = ''
    processChild.stderr!.on('data', value => { stderr += value })
    processChild.on('message', value => { if (value === 'paused') paused(); else ready(value) })
    processChild.once('error', fail)
    processChild.once('exit', code => { if (code) fail(Error(stderr || `Child exited ${code}`)) })
    processChild.stdin!.end(source)
    return {process: processChild, paused: pause ? Promise.race([pausedPromise, readyPromise.then(value => {
      throw Error(`Reclaimer did not pause: ${JSON.stringify(value)}`)
    })]) : Promise.resolve(), ready: readyPromise}
  }
  t.after(() => {
    if (fs.existsSync(h.root)) fs.writeFileSync(gate, 'release')
    for (const current of children) if (current.exitCode === null) current.kill('SIGKILL')
  })
  const first = child(true)
  await first.paused
  const second = child(false)
  assert.deepEqual((await second.ready).result, [])
  assert.equal(fs.existsSync(dispatches), false, 'another process cannot dispatch while stale reclamation is owned')
  fs.writeFileSync(gate, 'release')
  assert.equal((await first.ready).result.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(legacyLock, 'utf8')).pid, first.process.pid)
  assert.equal(fs.readFileSync(dispatches, 'utf8').trim().split('\n').length, 1)
  await Promise.all(children.map(current => new Promise<void>((resolve, reject) => {
    current.once('exit', code => code === 0 ? resolve() : reject(Error(`Child exited ${code}`)))
    current.send('stop')
  })))
})

test('empty or exhausted collection cools down thirty minutes across service restart', async t => {
  const h = fixture(t, {empty: true})
  h.service.runAutomaticRecovery(); await h.collected()
  const restarted = h.restart()
  restarted.runAutomaticRecovery()
  assert.equal(h.visits.length, 1)
  h.advance(30 * 60_000 - 1); restarted.runAutomaticRecovery()
  assert.equal(h.visits.length, 1)
  h.advance(1); restarted.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 2)
})

test('an underfilled exhausted round cools down and preserves known source deduplication', async t => {
  const h = fixture(t, {available: 2})
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.jobs.size, 2)
  h.service.runAutomaticRecovery(); assert.equal(h.visits.length, 1)
  h.advance(30 * 60_000); h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 2); assert.equal(h.jobs.size, 2)
})

test('account-edited queued jobs cannot hide the consumable stock deficit', async t => {
  const h = fixture(t)
  const old = h.seed(8, {}, {huashengAccountName: 'hs-edited'})
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.jobs.size, 16)
  for (const job of old.jobs) assert.equal(h.calls.includes(job.id), false)
})

test('current account quota blocker pauses refill while an unrelated old account does not', async t => {
  const h = fixture(t)
  const blocked = h.seed(1, {status: 'needs_attention', processing: {status: 'needs_attention', message: '花生账号额度不足'}},
    {status: 'needs_attention', failureKind: 'action_required', message: '花生账号额度不足'})
  h.service.runAutomaticRecovery(); assert.equal(h.visits.length, 0)
  h.service.saveSettings({huashengAccountName: 'hs-new'})
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1); assert.equal(h.calls.includes(blocked.jobs[0]!.id), false)
})

test('account validation failure creates neither refill intent nor batch', t => {
  const h = fixture(t)
  h.block('原花生账号已删除')
  h.service.runAutomaticRecovery()
  assert.equal(h.jobs.size, 0); assert.equal(h.intents().length, 0); assert.equal(h.visits.length, 0)
})

test('explicit batch stop and manually paused items pause refill after restart', async t => {
  const h = fixture(t)
  const stopped = h.seed(1, {status: 'stopped', stopRequested: true, processing: {status: 'stopped', message: 'User stopped'}})
  const restarted = h.restart()
  restarted.runAutomaticRecovery(); assert.equal(h.visits.length, 0); assert.equal(h.calls.length, 0)
  fs.rmSync(stopped.filename)
  h.seed(1, {}, {status: 'paused', message: '已手动暂停此任务'})
  restarted.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 0); assert.equal(h.calls.length, 0)
})

test('a later manual start permits new refill without changing or executing an older stopped batch', async t => {
  const h = fixture(t)
  const old = h.seed(1, {status: 'stopped', stopRequested: true, collectionStopRequested: true,
    processing: {status: 'stopped', message: 'User stopped'}})
  const before = fs.readFileSync(old.filename, 'utf8'), oldJob = structuredClone(old.jobs[0])
  h.authorize()
  h.restart().runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1); assert.equal(h.jobs.size, 9)
  assert.equal(h.calls.includes(old.jobs[0]!.id), false)
  assert.equal(fs.readFileSync(old.filename, 'utf8'), before)
  assert.deepEqual(old.jobs[0], oldJob)
  assert.equal(h.intents()[0].request.targetCount, 8)
})

for (const stop of ['processing', 'collection', 'status'] as const) {
  for (const updatedAt of [later(1000), later(2000), 'invalid']) {
    test(`${stop} stop at ${updatedAt} still blocks refill after a later manual start and restart`, t => {
      const h = fixture(t)
      const fields = stop === 'processing' ? {stopRequested: true}
        : stop === 'collection' ? {collectionStopRequested: true}
          : {processing: {status: 'stopped', message: 'Stopped'}}
      const old = h.seed(1, {status: 'stopped', processing: {status: 'needs_attention', message: 'Awaiting explicit action'}, ...fields, updatedAt})
      const before = fs.readFileSync(old.filename, 'utf8')
      h.authorize()
      h.restart().runAutomaticRecovery()
      assert.equal(h.visits.length, 0); assert.equal(h.calls.length, 0)
      assert.equal(fs.readFileSync(old.filename, 'utf8'), before)
    })
  }
}

for (const fields of [
  {requestId: `refill-${randomUUID()}`},
  {createdAt: 'invalid'},
  {requestId: ''},
  {huashengAccountName: 'hs-other'},
  {baijiahaoAccountName: 'bj-other'},
  {mode: 'drafts'},
]) test(`automatic, invalid, or unrelated start ${JSON.stringify(fields)} cannot override a stop`, t => {
  const h = fixture(t)
  h.seed(1, {status: 'stopped', stopRequested: true, processing: {status: 'stopped', message: 'Stopped'}, updatedAt: later(500)})
  h.authorize(fields)
  h.restart().runAutomaticRecovery()
  assert.equal(h.visits.length, 0); assert.equal(h.calls.length, 0)
  assert.equal(h.intents().length, 0)
})

test('old manual pauses stop suppressing refill but never become executable after a newer manual start', async t => {
  const h = fixture(t)
  const old = h.seed(1, {}, {status: 'paused', automaticRecoveryAllowed: false,
    message: '服务执行已中断，用户已暂停'})
  const before = fs.readFileSync(old.filename, 'utf8'), oldJob = structuredClone(old.jobs[0])
  h.authorize()
  h.restart().runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1); assert.equal(h.jobs.size, 9)
  assert.equal(h.calls.includes(old.jobs[0]!.id), false)
  assert.equal(fs.readFileSync(old.filename, 'utf8'), before)
  assert.deepEqual(old.jobs[0], oldJob)
})

for (const updatedAt of [later(1000), later(2000), 'invalid']) test(`manual pause at ${updatedAt} still suppresses refill after restart`, t => {
  const h = fixture(t)
  h.seed(1, {}, {status: 'paused', automaticRecoveryAllowed: false, message: '已手动暂停', updatedAt})
  h.authorize()
  h.restart().runAutomaticRecovery()
  assert.equal(h.visits.length, 0); assert.equal(h.calls.length, 0)
  assert.equal(h.intents().length, 0)
})

for (const stage of ['collection', 'processing'] as const) test(`older ${stage} blockers do not suppress new refill authorized later`, async t => {
  const h = fixture(t)
  const old = h.seed(1, {status: 'needs_attention', [stage]: {status: 'needs_attention', message: '花生账号额度不足'},
    ...(stage === 'collection' ? {processing: {status: 'needs_attention', message: 'Blocked'}} : {})},
    {status: 'needs_attention', message: '花生账号额度不足'})
  const before = fs.readFileSync(old.filename, 'utf8'), oldJob = structuredClone(old.jobs[0])
  h.authorize()
  h.restart().runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1); assert.equal(h.calls.includes(old.jobs[0]!.id), false)
  assert.equal(fs.readFileSync(old.filename, 'utf8'), before)
  assert.deepEqual(old.jobs[0], oldJob)
})

for (const stage of ['collection', 'processing'] as const) {
  for (const updatedAt of [later(1000), later(2000), 'invalid']) {
    test(`${stage} blocker at ${updatedAt} stays authoritative after an earlier manual start`, t => {
      const h = fixture(t)
      h.seed(1, {status: 'needs_attention', [stage]: {status: 'needs_attention', message: '花生账号额度不足'},
        ...(stage === 'collection' ? {processing: {status: 'needs_attention', message: 'Blocked'}} : {}), updatedAt},
        {status: 'needs_attention', message: '花生账号额度不足'})
      h.authorize()
      h.restart().runAutomaticRecovery()
      assert.equal(h.visits.length, 0); assert.equal(h.calls.length, 0)
    })
  }
}

test('a successful later job can still clear a blocker newer than manual authorization', async t => {
  const h = fixture(t)
  const old = h.seed(1, {status: 'needs_attention', processing: {status: 'needs_attention', message: '花生账号额度不足'},
    updatedAt: later(2000)}, {status: 'needs_attention', message: '花生账号额度不足'})
  h.authorize()
  h.seed(1, {status: 'completed', processing: {status: 'completed', message: 'Done'}},
    {status: 'ready', videoUrl: '/assets/new-success.mp4', updatedAt: later(3000)})
  h.restart().runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1); assert.equal(h.calls.includes(old.jobs[0]!.id), false)
})

test('a later success resumes safe original stock without replacing its persisted retry scope', async t => {
  const h = fixture(t)
  h.service.saveSettings({mode: 'upload'})
  const old = h.seed(7, {mode: 'upload', status: 'needs_attention', updatedAt: later(2000),
    processing: {status: 'needs_attention', message: '花生账号登录态无法核验'}})
  Object.assign(old.jobs[0]!, {status: 'needs_attention', message: '原请求结果不明'})
  old.run.items[0].status = 'failed'
  Object.assign(old.jobs[1]!, {status: 'completed', videoUrl: '/assets/success.mp4', updatedAt: later(3000),
    upload: {staged: true, saved: false, submitted: true, published: true, publicationStatus: 'published', accountName: 'bj-current',
      articleId: 'original-article', publishedUrl: 'https://baijiahao.baidu.com/', editorUrl: 'https://baijiahao.baidu.com/', targetId: 'original', engine: 'test'}})
  Object.assign(old.jobs[2]!, {status: 'ready', automaticRecoveryAllowed: false, videoUrl: '/assets/preview.mp4'})
  Object.assign(old.jobs[3]!, {status: 'ready', videoUrl: '/assets/unknown.mp4', uploadStatus: 'uncertain'})
  const jobIds = old.jobs.map(job => job.id)
  old.run.retry = {jobIds, startedAt: timestamp, finishedAt: later(2000), completed: 0, failed: 1}
  old.run.pendingRetryJobIds = [...jobIds]
  fs.writeFileSync(old.filename, JSON.stringify(old.run))
  const restarted = h.restart()
  assert.deepEqual(restarted.runAutomaticRecovery(), [old.id])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls, [old.jobs[4]!.id])
  const saved = JSON.parse(fs.readFileSync(old.filename, 'utf8'))
  assert.deepEqual(saved.retry.jobIds, jobIds)
  assert.equal(saved.targetCount, 7); assert.equal(saved.items.length, 7)
  assert.equal(h.visits.length, 0); assert.equal(h.intents().length, 0)
})

test('recovery prefers the batch with the latest successful output and keeps its original full scope', async t => {
  const h = fixture(t)
  const old = h.seed(4, {status: 'needs_attention', updatedAt: later(2000),
    processing: {status: 'needs_attention', message: '花生账号登录态无法核验'}})
  Object.assign(old.jobs[0]!, {status: 'ready', videoUrl: '/assets/success.mp4', updatedAt: later(3000)})
  const newer = h.seed(3, {createdAt: later(1000), updatedAt: later(2000), status: 'needs_attention',
    processing: {status: 'needs_attention', message: '花生专用浏览器未连接'}})
  const untouched = fs.readFileSync(newer.filename, 'utf8')
  assert.deepEqual(h.restart().runAutomaticRecovery(), [old.id])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls, [old.jobs[1]!.id])
  const saved = JSON.parse(fs.readFileSync(old.filename, 'utf8'))
  assert.equal(saved.retry, undefined); assert.equal(saved.targetCount, 4)
  assert.deepEqual(saved.items.map((item: {jobId: string}) => item.jobId), old.jobs.map(job => job.id))
  assert.equal(fs.readFileSync(newer.filename, 'utf8'), untouched)
  assert.equal(h.visits.length, 0)
})

test('an unsuccessful recovery needs a newer successful result before another attempt', async t => {
  const h = fixture(t)
  h.service.saveSettings({youtubeChannels: []})
  const old = h.seed(2, {status: 'needs_attention', updatedAt: later(2000),
    processing: {status: 'needs_attention', message: '花生账号额度不足'}})
  Object.assign(old.jobs[0]!, {status: 'ready', videoUrl: '/assets/success.mp4', updatedAt: later(3000)})
  h.options.workflow!.runBatchJob = async id => { h.calls.push(id); throw new ScienceWorkflowError('花生账号额度不足') }
  const restarted = h.restart()
  assert.deepEqual(restarted.runAutomaticRecovery(), [old.id])
  await restarted.waitForIdle()
  assert.equal(restarted.overview().runs.find(run => run.id === old.id)?.processing?.status, 'needs_attention')
  restarted.runAutomaticRecovery()
  assert.deepEqual(h.calls, [old.jobs[1]!.id])
})

for (const change of ['processing-stop', 'collection-stop', 'scope-edited'] as const)
  test(`automatic recovery preserves a concurrent ${change} after selection`, t => {
    const h = fixture(t)
    h.service.saveSettings({youtubeChannels: []})
    const old = h.seed(2, {status: 'needs_attention', updatedAt: later(2000),
      processing: {status: 'needs_attention', message: '花生账号登录态无法核验'}})
    Object.assign(old.jobs[0]!, {status: 'ready', videoUrl: '/assets/success.mp4', updatedAt: later(3000)})
    const validate = h.options.workflow!.validateBatchAccounts
    let changed: string | undefined
    h.options.workflow!.validateBatchAccounts = (...args) => {
      const current = JSON.parse(fs.readFileSync(old.filename, 'utf8'))
      current.updatedAt = later(4000)
      if (change === 'processing-stop') { current.stopRequested = true; current.processing.status = 'stopped' }
      if (change === 'collection-stop') current.collectionStopRequested = true
      if (change === 'scope-edited') current.targetCount = 100
      changed = JSON.stringify(current)
      fs.writeFileSync(old.filename, changed)
      return validate(...args)
    }
    assert.deepEqual(h.restart().runAutomaticRecovery(), [])
    assert.ok(changed)
    assert.equal(fs.readFileSync(old.filename, 'utf8'), changed)
    assert.deepEqual(h.calls, [])
    assert.equal(fs.existsSync(path.join(h.root, 'worker.lock')), false)
  })

for (const scenario of ['disabled', 'older', 'equal', 'invalid-success', 'invalid-blocker', 'other-mode',
  'other-huasheng', 'other-baijiahao', 'deleted', 'unfinished', 'composition-pending', 'stopped', 'live-owner',
  'non-platform-failure'] as const) test(`a later success does not resume unsafe stock: ${scenario}`, t => {
  const h = fixture(t, {enabled: scenario !== 'disabled'})
  const old = h.seed(1, {status: 'needs_attention', updatedAt: scenario === 'invalid-blocker' ? 'invalid' : later(2000),
    processing: {status: 'needs_attention', message: scenario === 'non-platform-failure' ? '原封面请求结果不明' : '花生账号额度不足'},
    ...(scenario === 'stopped' ? {stopRequested: true} : {}),
    ...(scenario === 'live-owner' ? {ownerPid: process.ppid} : {})})
  h.seed(1, {status: 'completed', processing: {status: 'completed', message: 'Done'},
    ...(scenario === 'other-mode' ? {mode: 'drafts'} : {}),
    ...(scenario === 'other-huasheng' ? {huashengAccountName: 'hs-other'} : {}),
    ...(scenario === 'other-baijiahao' ? {baijiahaoAccountName: 'bj-other'} : {})},
  {status: scenario === 'unfinished' ? 'running' : 'ready', videoUrl: '/assets/success.mp4',
    updatedAt: scenario === 'older' ? later(1000) : scenario === 'equal' ? later(2000)
      : scenario === 'invalid-success' ? 'invalid' : later(3000),
    ...(scenario === 'deleted' ? {deletedAt: later(3000)} : {}),
    ...(scenario === 'composition-pending' ? {videoCompositionPending: true} : {})})
  const before = fs.readFileSync(old.filename, 'utf8')
  h.restart().runAutomaticRecovery()
  assert.equal(h.calls.includes(old.jobs[0]!.id), false)
  assert.equal(fs.readFileSync(old.filename, 'utf8'), before)
})

for (const status of ['draft', 'queued', 'ready', 'waiting_remote', 'awaiting_export'] as const)
  test(`automatic recovery honors revoked delivery permission for ${status} jobs`, t => {
    const h = fixture(t)
    const old = h.seed(1, {status: 'interrupted', processing: {status: 'interrupted', message: 'Interrupted'}},
      {status, automaticRecoveryAllowed: false, message: '原任务已停止自动交付'})
    const before = fs.readFileSync(old.filename, 'utf8')
    h.restart().runAutomaticRecovery()
    assert.equal(h.calls.includes(old.jobs[0]!.id), false)
    assert.equal(fs.readFileSync(old.filename, 'utf8'), before)
  })

for (const outcome of ['completed', 'deleted'] as const) test(`explicit processing resume clears stop after every item became ${outcome} in the background`, async t => {
  const h = fixture(t), original = h.seed(1)
  h.service.stopProcessing(original.id)
  h.service.runAutomaticRecovery(); assert.equal(h.visits.length, 0)
  if (outcome === 'completed') Object.assign(original.jobs[0]!, {status: 'ready', videoUrl: '/assets/completed.mp4'})
  else original.jobs[0]!.deletedAt = timestamp
  const resumed = h.service.resumeProcessing(original.id)
  assert.equal(resumed.processing?.status, 'completed')
  assert.equal(resumed.status, 'completed')
  assert.equal(JSON.parse(fs.readFileSync(original.filename, 'utf8')).stopRequested, false)
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1)
  assert.equal(h.calls.includes(original.jobs[0]!.id), false)
})

test('generic resume and empty retry clear finished processing stops without replaying jobs', async t => {
  const h = fixture(t)
  for (const action of ['resume', 'retry'] as const) {
    const old = h.seed(1, {status: 'completed', stopRequested: true, processing: {status: 'completed', message: 'Finished after stop'}},
      {status: 'ready', videoUrl: '/assets/finished.mp4'})
    if (action === 'resume') h.service.resume(old.id)
    else h.service.retry(old.id, {})
    assert.equal(JSON.parse(fs.readFileSync(old.filename, 'utf8')).stopRequested, false)
  }
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1)
})

test('completed collection stop needs explicit collection resume and does not clear the processing stop', async t => {
  const h = fixture(t)
  const old = h.seed(0, {status: 'stopped', stopRequested: true, collectionStopRequested: true,
    processing: {status: 'stopped', message: 'Stopped'}, collection: {status: 'completed', message: 'Finished after stop'}})
  h.service.resumeCollection(old.id)
  let stored = JSON.parse(fs.readFileSync(old.filename, 'utf8'))
  assert.equal(stored.collectionStopRequested, false); assert.equal(stored.stopRequested, true)
  h.service.runAutomaticRecovery(); assert.equal(h.visits.length, 0)
  h.service.resumeProcessing(old.id)
  stored = JSON.parse(fs.readFileSync(old.filename, 'utf8'))
  assert.equal(stored.stopRequested, false); assert.equal(stored.status, 'completed')
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1)
})

test('generic resume clears both completed-stage stop flags explicitly', async t => {
  const h = fixture(t)
  const old = h.seed(0, {status: 'completed', stopRequested: true, collectionStopRequested: true,
    processing: {status: 'completed', message: 'Done'}})
  h.service.resume(old.id)
  const stored = JSON.parse(fs.readFileSync(old.filename, 'utf8'))
  assert.equal(stored.stopRequested, false); assert.equal(stored.collectionStopRequested, false)
  h.service.runAutomaticRecovery(); await h.collected()
  assert.equal(h.visits.length, 1)
})

test('real workflow cancellation permission overrides stale service-interruption text', t => {
  const h = fixture(t)
  const old = h.seed(1, {status: 'interrupted', message: '服务已中断，已保留原批次，启动后自动继续',
    processing: {status: 'interrupted', message: 'Interrupted'}},
    {status: 'paused', message: '自动制作已暂停，素材、原项目和导出检查点保留', automaticRecoveryAllowed: false})
  h.service.runAutomaticRecovery()
  assert.equal(h.calls.includes(old.jobs[0]!.id), false)
  assert.equal(h.visits.length, 0)
  assert.equal(h.jobs.size, 1)
})

test('automatic recovery and refill never revive failed unknown or deleted uncertain tasks', async t => {
  const h = fixture(t)
  const old = h.seed(3, {status: 'interrupted', processing: {status: 'interrupted', message: 'Interrupted'}})
  old.jobs[0]!.status = 'needs_attention'; old.jobs[0]!.message = 'Manual review required'
  old.run.items[0].status = 'failed'
  old.jobs[1]!.status = 'unknown' as ScienceJob['status']
  Object.assign(old.jobs[2]!, {deletedAt: timestamp, uploadStatus: 'uncertain', hasUploadAttempt: true})
  fs.writeFileSync(old.filename, JSON.stringify(old.run))
  h.service.runAutomaticRecovery(); await h.collected()
  for (const job of old.jobs) assert.equal(h.calls.includes(job.id), false)
  assert.equal(h.jobs.size, 11)
  assert.equal(old.jobs[2]!.uploadStatus, 'uncertain')
})

test('a malformed durable refill record fails closed', t => {
  const h = fixture(t)
  fs.mkdirSync(path.join(h.root, 'refill'))
  h.service.start = () => { throw new Error('Stop after intent') }
  assert.throws(() => h.service.runAutomaticRecovery(), /Stop after intent/)
  const filename = path.join(h.root, 'refill', fs.readdirSync(path.join(h.root, 'refill'))[0]!)
  fs.writeFileSync(filename, '{"version":99}')
  assert.throws(() => h.restart().runAutomaticRecovery(), /refill|补队/i)
  assert.equal(h.jobs.size, 0)
})

test('a missing acknowledged refill batch cannot silently become a new batch', async t => {
  const h = fixture(t, {empty: true})
  h.service.runAutomaticRecovery(); await h.collected()
  const run = h.service.overview().runs[0]!
  fs.rmSync(path.join(h.root, 'runs', `${run.id}.json`))
  assert.throws(() => h.restart().runAutomaticRecovery(), /原批次丢失/)
  assert.equal(h.visits.length, 1)
})
