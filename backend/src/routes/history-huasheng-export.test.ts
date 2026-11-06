import test from 'node:test'
import assert from 'node:assert/strict'
import { createHistoryHuashengExportRoute } from './history-huasheng-export.js'
import { HuashengExportError, type HistoryHuashengExportService } from '../services/history-huasheng-export.js'

function fixture() {
  const calls: unknown[] = []
  const service = {
    overview: (sourceId?: number) => { calls.push(['get', sourceId]); return { enabled: false, jobs: [], worker: { status: 'stopped', message: '导出执行进程未运行' } } },
    setEnabled: (enabled: boolean) => { calls.push(['settings', enabled]); return { enabled } },
    enqueue: (sourceIds: number[]) => { calls.push(['enqueue', sourceIds]); return { jobs: [] } },
    resume: (id: number) => { calls.push(['resume', id]); if (id === 99) throw new HuashengExportError('仅可重试已失败任务'); return { job: { id } } },
  } as unknown as HistoryHuashengExportService
  const route = createHistoryHuashengExportRoute({ service })
  const command = (url: string, body: unknown, method = 'POST', headers: Record<string, string> = {}) => route.request(url, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { route, calls, command }
}
test('export routes expose fixed contract without doing work on read', async () => {
  const f = fixture()
  const overview = await f.route.request('/huasheng/exports?sourceId=60')
  assert.equal(overview.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual((await overview.json()).data, { enabled: false, jobs: [], worker: { status: 'stopped', message: '导出执行进程未运行' } })
  assert.equal((await f.command('/huasheng/exports/settings', { enabled: true }, 'PUT')).status, 200)
  assert.equal((await f.command('/huasheng/exports', { sourceIds: [60, 61] })).status, 202)
  assert.equal((await f.command('/huasheng/exports/1/resume', {})).status, 202)
  assert.deepEqual(f.calls, [['get', 60], ['settings', true], ['enqueue', [60, 61]], ['resume', 1]])
  assert.equal((await f.command('/huasheng/exports/99/resume', {})).status, 409)
})
test('guards reject foreign origins and malformed input before touching service', async () => {
  const f = fixture()
  const invalidHeaders: Array<Record<string, string>> = [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'http://localhost:3013.attacker.example' }]
  for (const headers of invalidHeaders) {
    assert.equal((await f.command('/huasheng/exports', { sourceIds: [60] }, 'POST', headers)).status, 403)
  }
  for (const body of [null, [], {}, { sourceIds: [] }, { sourceIds: [0] }, { sourceIds: [1.5] }, { sourceIds: [60], fast: true }]) {
    assert.equal((await f.command('/huasheng/exports', body)).status, 400)
  }
  assert.equal((await f.command('/huasheng/exports?fast=1', { sourceIds: [60] })).status, 400)
  assert.equal((await f.command('/huasheng/exports/settings', { enabled: true, oldProjects: true }, 'PUT')).status, 400)
  assert.equal((await f.command('/huasheng/exports/1/resume', { retryPost: true })).status, 400)
  assert.equal((await f.command('/huasheng/exports/no/resume', {})).status, 400)
  assert.equal((await f.route.request('/huasheng/exports?sourceId=0')).status, 400)
  assert.equal((await f.route.request('/huasheng/exports?other=1')).status, 400)
  assert.equal((await f.route.request('/huasheng/exports', { method: 'POST' })).status, 400)
  assert.deepEqual(f.calls, [])
})
test('local JSON requests remain accepted and internal failures do not leak URLs', async () => {
  const f = fixture()
  assert.equal((await f.command('/huasheng/exports', { sourceIds: [60] }, 'POST', { Origin: 'http://localhost:3013', 'Sec-Fetch-Site': 'same-origin' })).status, 202)
  const route = createHistoryHuashengExportRoute({ service: { overview() { throw new Error('https://cdn.example/private?secret=token') } } as unknown as HistoryHuashengExportService })
  const response = await route.request('/huasheng/exports')
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret|cdn\.example/)
})
