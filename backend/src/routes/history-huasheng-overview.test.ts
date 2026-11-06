import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHistoryHuashengDriver, HistoryHuashengService } from '../services/history-huasheng.js'
import { HISTORY_HUASHENG_ACCOUNT, HuashengAccountsService } from '../services/huasheng-accounts.js'
import { createHistoryHuashengRoute } from './history-huasheng.js'

test('overview returns the durable account snapshot while a live identity check is blocked', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-overview-account-'))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const checking = new Promise<void>(resolve => { started = resolve })
  let checks = 0
  const accounts = new HuashengAccountsService({ scope: 'history', stateRoot: root, peerStateRoots: [],
    driver: async () => {
      if (++checks > 1) {
        started()
        await blocked
        return { status: 'login_required', message: 'expired' }
      }
      return { status: 'ready', message: 'ready', identity: { uid: '1001', displayName: 'history user' } }
    } })
  const verified = await accounts.check(HISTORY_HUASHENG_ACCOUNT)
  const service = new HistoryHuashengService({ databasePath: ':memory:',
    loadSource: id => ({ id, title: `source ${id}`, script: `script ${id}` }),
    driver: createHistoryHuashengDriver(accounts) })
  const route = createHistoryHuashengRoute({ service, accounts })
  const job = (await service.enqueue(901))!
  const liveCheck = route.request('/huasheng/browser/check', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await checking
  const read = route.request('/huasheng')
  t.after(async () => {
    release()
    await Promise.all([liveCheck, read])
    await service.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const response = await Promise.race([read, new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)))])
  assert.ok(response, 'The list must return without waiting for the remote identity check')
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.browser.status, 'ready')
  assert.equal(data.browser.checkedAt, verified.checkedAt)
  assert.deepEqual(data.jobs.map((item: { id: number }) => item.id), [job.id])
  assert.equal(data.total, 1)
  assert.equal(checks, 2, 'Reading the list must not start another identity check')
  assert.equal(service.getJob(job.id).attempts, 0)
  release()
  assert.equal((await liveCheck).status, 200)
  const { data: latest } = await (await route.request('/huasheng')).json()
  assert.equal(latest.browser.status, 'login_required', 'Reads must observe newly persisted account status')
  assert.equal(checks, 2)
  fs.writeFileSync(path.join(root, 'accounts.json'), 'invalid')
  const { data: degraded } = await (await route.request('/huasheng')).json()
  assert.equal(degraded.browser.status, 'unavailable')
  assert.equal(degraded.total, 1, 'An unreadable account snapshot must not hide local jobs')
})

test('Huasheng global production totals include jobs outside the current page and exclude deleted manuscripts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-overview-'))
  const filename = path.join(root, 'test.db')
  const service = new HistoryHuashengService({ databasePath: filename,
    loadSource: id => ({ id, title: `稿件 ${id}`, script: `已保存正文 ${id}` }),
    driver: {
      getHuashengBrowserStatus: async () => ({ status: 'ready', message: 'ready' }),
      openHuashengBrowser: async () => assert.fail('Read-only inventory must not open a browser'),
      runHuashengBrowserJob: async () => assert.fail('Read-only inventory must not start production'),
    } })
  const sql = new Database(filename)
  t.after(async () => { await service.close(); sql.close(); fs.rmSync(root, { recursive: true, force: true }) })
  for (let id = 1; id <= 75; id++) await service.enqueue(id)
  sql.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,deleted_at TEXT);
    INSERT INTO history_script_sources VALUES(1,'deleted');
    UPDATE history_huasheng_jobs SET production_status='completed' WHERE source_id<=20;`)
  const route = createHistoryHuashengRoute({ service })
  const { data: first } = await (await route.request('/huasheng')).json()
  assert.equal(first.jobs.length, 50)
  assert.equal(first.jobs.filter((job: { productionStatus: string }) => job.productionStatus === 'completed').length, 0)
  assert.equal(first.total, 74)
  assert.deepEqual(first.productionCounts, { not_started: 55, queued: 0, creating: 0, completed: 19 })
  const { data: next } = await (await route.request(`/huasheng?beforeId=${first.nextBeforeId}`)).json()
  assert.equal(next.jobs.length, 24)
  assert.equal(next.nextBeforeId, null)
  assert.equal(next.total, 74)
  assert.deepEqual(next.productionCounts, first.productionCounts)
  assert.equal(new Set([...first.jobs, ...next.jobs].map((job: { id: number }) => job.id)).size, 74)
})

test('cleanup tombstones retain their identifiers but leave Huasheng lists and totals', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-overview-cleanup-'))
  const filename=path.join(root,'test.db')
  const service=new HistoryHuashengService({databasePath:filename,
    loadSource:id=>({id,title:`source ${id}`,script:`script ${id}`}),
    driver:{getHuashengBrowserStatus:async()=>({status:'ready',message:'ready'}),
      openHuashengBrowser:async()=>assert.fail('Read-only inventory must not open a browser'),
      runHuashengBrowserJob:async()=>assert.fail('Read-only inventory must not start production')}})
  const sql=new Database(filename)
  t.after(async()=>{await service.close();sql.close();fs.rmSync(root,{recursive:true,force:true})})
  const archived=await service.enqueue(1)
  const kept=await service.enqueue(2)
  sql.prepare("UPDATE history_huasheng_jobs SET status='canceled',stage='record_cleanup',cancel_requested=1 WHERE id=?").run(archived!.id)
  const overview=await service.overview()
  assert.equal(overview.total,1)
  assert.equal(overview.productionCounts.not_started,1)
  assert.deepEqual(overview.jobs.map(job=>job.id),[kept!.id])
  assert.deepEqual(service.listJobs(1),[])
  assert.equal(service.getJob(archived!.id).status,'canceled')
  sql.prepare("UPDATE history_huasheng_jobs SET status='queued',stage='queued',cancel_requested=0 WHERE id=?").run(archived!.id)
  assert.deepEqual(service.listJobs(1).map(job=>job.id),[archived!.id])
})
