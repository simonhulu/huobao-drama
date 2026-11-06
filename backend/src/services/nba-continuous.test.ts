import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { NbaVideoService, nbaSettingsSchema, nbaStartSchema } from './nba-video.js'
import { NBA_DEFAULT_SETTINGS, type NbaArticle, type NbaProductionInput } from './nba-types.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const article = (id: string): NbaArticle => ({ id, url: `https://example.test/${id}`, title: id, language: 'en', publisher: 'Example',
  body: `Complete original ${id}. `.repeat(110), bodyHash: hash(id), wordCount: 330, characterCount: 0, collectedAt: '2026-11-05T00:00:00Z' })
const account = () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: 'Sports', status: 'ready', message: 'Ready' })
const manual = (requestId: string) => nbaStartSchema.parse({ requestId, collectionMode: 'manual', autoProduce: true })
const continuous = { ...NBA_DEFAULT_SETTINGS, scheduleEnabled: true, intervalMinutes: 10, autoUpload: true, videosPerChannel: 1000 }
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-continuous-'))), services: NbaVideoService[] = []
  t.after(async () => { for (const service of services) await service.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const open = (options: NonNullable<ConstructorParameters<typeof NbaVideoService>[0]> = {}) => {
    const service = new NbaVideoService({ root, scheduling: false, uploadAccount: account, ...options }); services.push(service); return service
  }
  return { root, open }
}
async function delivery(input: NbaProductionInput) {
  const videoPath = path.join(input.jobDir, 'video.mp4'), bytes = Buffer.from(input.job.id)
  fs.writeFileSync(videoPath, bytes)
  return { delivery: { videoPath, bytes: bytes.length, duration: 1, sha256: hash(bytes), verification: {} } }
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Continuous workflow did not reach the expected checkpoint')
}

test('API scan bounds accept 1000 entries per round and reject 1001', () => {
  assert.equal(nbaStartSchema.parse({ requestId: 'continuous-schema', videosPerChannel: 1000 }).videosPerChannel, 1000)
  assert.equal(nbaSettingsSchema.parse(continuous).videosPerChannel, 1000)
  assert.throws(() => nbaStartSchema.parse({ requestId: 'continuous-schema', videosPerChannel: 1001 }))
})

test('continuous collection reserves footage already assigned to jobs before searching more news', async t => {
  const f = fixture(t)
  let reserved: string[] | undefined
  const service = f.open({ collect: async () => ({ articles: [
    { ...article('existing-video'), youtubeUrl: 'https://www.youtube.com/watch?v=vDdPLHaKK4k' },
    { ...article('existing-topic'), sourceVideoId: 'abcdefghijk' },
  ], sources: [], excluded: [] }), collectChannels: async input => {
    reserved = input.reservedVideoIds
    return { articles: [], videos: [], sources: [], excluded: [] }
  } })
  service.start(nbaStartSchema.parse({ requestId: 'continuous-reserve-existing', collectionMode: 'manual', autoProduce: false }))
  await service.waitForIdle()
  service.start(nbaStartSchema.parse({ requestId: 'continuous-reserve-scan', autoProduce: false }))
  await service.waitForIdle()
  assert.deepEqual(reserved?.sort(), ['abcdefghijk', 'vDdPLHaKK4k'].sort())
})

test('a scheduled batch publishes its first completed job before a later source finishes', async t => {
  const f = fixture(t), events: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const service = f.open({ collect: async () => ({ articles: [article('first'), article('slow')], sources: [], excluded: [] }),
    produce: async input => {
      events.push(`produce-${input.job.article.id}`)
      if (input.job.article.id === 'slow') await Promise.race([gate, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))])
      input.signal.throwIfAborted(); return delivery(input)
    }, upload: async input => { events.push(`upload-${input.job.article.id}`); return { saved: true, message: 'Fixture uploaded' } } })
  service.settings(continuous)
  service.start(manual('continuous-eager-upload'))
  await until(() => events.includes('produce-slow'))
  assert.ok(events.indexOf('upload-first') >= 0 && events.indexOf('upload-first') < events.indexOf('produce-slow'), JSON.stringify(events))
  release(); await service.waitForIdle()
})

test('schedule settings can be turned off during production without changing accepted batch settings', async t => {
  const f = fixture(t); let entered = false
  const service = f.open({ collect: async () => ({ articles: [article('one')], sources: [], excluded: [] }), produce: async input => {
    entered = true
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    input.signal.throwIfAborted(); return delivery(input)
  } })
  service.settings({ ...continuous, autoUpload: false })
  const collection = service.start(manual('continuous-live-settings'))
  await until(() => entered)
  service.settings({ ...continuous, autoUpload: false, scheduleEnabled: false, speed: 1.2 })
  const overview = service.overview(), run = overview.runs.find(row => row.id === collection.id)!
  assert.equal(overview.settings.scheduleEnabled, false)
  assert.equal(overview.runs.find(row => row.id === run.productionRunId)!.productionSettings!.speed, continuous.speed)
  service.stop(run.productionRunId!); await service.waitForIdle()
})

test('continuous mode recovers a crashed production but preserves an explicit user stop', async t => {
  const f = fixture(t), first = f.open({ collect: async () => ({ articles: [article('one')], sources: [], excluded: [] }),
    produce: async () => { throw Error('fixture prepare interrupted run') } })
  first.settings({ ...continuous, autoUpload: false })
  first.start(manual('continuous-crash-prepare')); await first.waitForIdle(); await first.close()
  const filename = path.join(f.root, '.console.json'), state = JSON.parse(fs.readFileSync(filename, 'utf8'))
  const run = state.runs.find((row: any) => row.kind === 'produce')
  run.status = 'running'
  fs.writeFileSync(filename, JSON.stringify(state))
  let productions = 0
  const recovered = f.open({ produce: async input => { productions++; return delivery(input) } })
  await recovered.waitForIdle()
  assert.equal(productions, 1)
  assert.equal(recovered.overview().runs.find(row => row.id === run.id)!.status, 'completed')
  await recovered.close()
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'))
  saved.runs.find((row: any) => row.id === run.id).status = 'stopped'
  fs.writeFileSync(filename, JSON.stringify(saved))
  const stopped = f.open({ produce: async () => { throw Error('Manual stop must not restart') } })
  await stopped.tick(); await stopped.waitForIdle()
  assert.equal(stopped.overview().runs.find(row => row.id === run.id)!.status, 'stopped')
})

test('transient production failures retry on a bounded delayed schedule and reuse the same run', async t => {
  const f = fixture(t); let now = new Date('2026-11-05T00:00:00Z'), calls = 0
  const service = f.open({ now: () => now, collect: async () => ({ articles: [article('network')], sources: [], excluded: [] }),
    collectChannels: async () => ({ articles: [], videos: [], sources: [], excluded: [] }),
    produce: async () => { calls++; throw Error('fetch failed: ECONNRESET') } })
  service.settings({ ...continuous, autoUpload: false })
  const collection = service.start(manual('continuous-network-retry')); await service.waitForIdle()
  const producerId = service.overview().runs.find(row => row.id === collection.id)!.productionRunId!
  await service.tick(); await service.waitForIdle(); assert.equal(calls, 1)
  for (const expectedCalls of [2, 3, 4]) {
    const run = service.overview().runs.find(row => row.id === producerId)!
    assert.ok(run.automaticRecovery?.nextAttemptAt)
    now = new Date(run.automaticRecovery.nextAttemptAt)
    await service.tick(); await service.waitForIdle()
    assert.equal(calls, expectedCalls)
  }
  const exhausted = service.overview().runs.find(row => row.id === producerId)!
  assert.equal(exhausted.automaticRecovery!.attempts, 3)
  assert.equal(exhausted.automaticRecovery!.nextAttemptAt, undefined)
  assert.equal(service.overview().runs.filter(row => row.kind === 'produce').length, 1)
})

test('history scanning is idle-only and cursor commits follow durable job saves', async t => {
  const f = fixture(t), requests: Array<{ includeHistory?: boolean; scanStatePath?: string }> = []
  let entered = false, round = 0
  const service = f.open({ collectChannels: async input => {
    requests.push(input); round++
    return { articles: round === 1 ? [article('cursor')] : [], videos: [], sources: [], excluded: [],
      scanState: { version: 1, channels: { [NBA_DEFAULT_SETTINGS.youtubeChannels[0]!]: { nextIndex: 70 + round, updatedAt: new Date().toISOString() } } } }
  }, produce: async input => {
    entered = true
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    input.signal.throwIfAborted(); return delivery(input)
  } })
  const first = service.start(nbaStartSchema.parse({ requestId: 'continuous-cursor-idle', autoProduce: true }))
  await until(() => entered)
  assert.equal(requests[0]!.includeHistory, true)
  assert.equal(requests[0]!.scanStatePath, path.join(f.root, '.channel-scan.json'))
  const stateFile = path.join(f.root, '.channel-scan.json')
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).channels[NBA_DEFAULT_SETTINGS.youtubeChannels[0]!].nextIndex, 71)
  const second = service.start(nbaStartSchema.parse({ requestId: 'continuous-cursor-busy', autoProduce: false }))
  await until(() => service.overview().runs.find(row => row.id === second.id)!.status === 'completed')
  assert.equal(requests[1]!.includeHistory, false)
  service.stop(service.overview().runs.find(row => row.id === first.id)!.productionRunId!); await service.waitForIdle()
})

test('a failed scheduled collection is retried by the next interval without jamming the collection queue', async t => {
  const f = fixture(t); let now = new Date('2026-11-05T00:00:00Z'), collections = 0
  const service = f.open({ now: () => now, collectChannels: async () => {
    collections++; if (collections === 1) throw Error('fetch failed')
    return { articles: [], videos: [], sources: [], excluded: [] }
  } })
  service.settings({ ...continuous, autoUpload: false })
  for (const expected of [1, 2]) {
    now = new Date(service.overview().nextCollectionAt!)
    await service.tick(); await service.waitForIdle(); assert.equal(collections, expected)
  }
  assert.equal(service.overview().activeCollection, null)
  assert.equal(service.overview().runs.filter(run => run.kind === 'collect' && run.status === 'queued').length, 0)
})

test('continuous resume flushes completed unpublished checkpoints before another slow production', async t => {
  const f = fixture(t), events: string[] = []
  let recovering = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); t.after(() => release())
  const service = f.open({ collect: async () => ({ articles: [article('finished'), article('slow')], sources: [], excluded: [] }),
    produce: async input => {
      if (input.job.article.id === 'slow') {
        if (!recovering) throw Error('fixture interrupted source')
        events.push('slow-recovery')
        await Promise.race([gate, new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))])
        input.signal.throwIfAborted()
      }
      return delivery(input)
    }, upload: async input => { events.push(`upload-${input.job.article.id}`); return { saved: true, message: 'Fixture uploaded' } } })
  service.start(manual('continuous-completed-prepare')); await service.waitForIdle()
  recovering = true; service.settings(continuous)
  const ids = service.overview().jobs.sort((a, b) => a.title.localeCompare(b.title)).map(job => job.id)
  service.resume({ requestId: 'continuous-completed-resume', jobIds: ids, autoUpload: true })
  await until(() => events.includes('slow-recovery'))
  assert.ok(events.indexOf('upload-finished') >= 0 && events.indexOf('upload-finished') < events.indexOf('slow-recovery'))
  release(); await service.waitForIdle()
})
