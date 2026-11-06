import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverHuashengProject } from './history-huasheng-discovery.js'

const script = '完整历史二创正文。\n第二段保持原样。'
const input = () => ({ jobId: 94, title: '历史故事', script, createdAt: '2026-10-26T07:00:00.000Z',
  updatedAt: '2026-10-26T07:02:00.000Z', signal: new AbortController().signal })
const session = async () => ({ cookie: 'test-session', userAgent: 'test' })
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }))

test('discovery links only the unique project retaining the complete original script', async () => {
  const calls: string[] = []
  const result = await discoverHuashengProject(input(), { session, fetch: async (url, options) => {
    const request = new URL(String(url)); calls.push(request.pathname)
    assert.equal(options?.method, 'GET')
    if (request.pathname.endsWith('/list')) return json({ total: 2, projects: [{ pid: '100', name: '历史故事' }, { pid: '101', name: '花生自动标题' }] })
    return json({ project: { pid: request.searchParams.get('pid'), script: request.searchParams.get('pid') === '101' ? script : '同名的其他稿件' } })
  } })
  assert.equal(result.projectUrl, 'https://www.huasheng.cn/video/101')
  assert.equal(calls.length, 3)
})

test('discovery keeps repeated full scripts ambiguous instead of choosing a title match', async () => {
  const result = await discoverHuashengProject(input(), { session, fetch: async url => {
    const request = new URL(String(url))
    if (request.pathname.endsWith('/list')) return json({ total: 2, projects: [{ pid: '100', name: '历史故事' }, { pid: '101', name: '其他标题' }] })
    return json({ project: { pid: request.searchParams.get('pid'), script } })
  } })
  assert.equal(result.projectUrl, null)
  assert.match(result.message, /多个/)
})

test('discovery refuses incomplete listing or failed detail reads and does not declare a unique match', async () => {
  await assert.rejects(discoverHuashengProject(input(), { session, fetch: async url => {
    const request = new URL(String(url))
    if (request.pathname.endsWith('/list')) return json({ total: 2, projects: [] })
    assert.fail('Incomplete listing cannot inspect or link projects')
  } }), /项目列表/)
  await assert.rejects(discoverHuashengProject(input(), { session, fetch: async url => {
    const request = new URL(String(url))
    if (request.pathname.endsWith('/list')) return json({ total: 2, projects: [{ pid: '100' }, { pid: '101' }] })
    if (request.searchParams.get('pid') === '100') return json({ project: { pid: '100', script } })
    return new Response('', { status: 503 })
  } }), /503/)
})

test('discovery returns a useful unresolved result when no original script matches', async () => {
  const result = await discoverHuashengProject(input(), { session, fetch: async url => {
    const request = new URL(String(url))
    return request.pathname.endsWith('/list') ? json({ total: 1, projects: [{ pid: '100', name: '历史故事' }] })
      : json({ project: { pid: '100', script: '不同正文' } })
  } })
  assert.equal(result.projectUrl, null)
  assert.match(result.message, /未找到/)
})

test('listing and detail budgets remain unresolved rather than linking from a partial search', async () => {
  let calls = 0
  const excessive = await discoverHuashengProject(input(), { session, fetch: async () => {
    calls++
    return json({ total: 201, projects: [{ pid: '100', script }] })
  } })
  assert.equal(calls, 1)
  assert.equal(excessive.projectUrl, null)
  assert.match(excessive.message, /预算.*尚未确认/)
  const unknown = await discoverHuashengProject(input(), { session, fetch: async () => {
    calls++
    return json({ total: 11, projects: Array.from({ length: 11 }, (_, index) => ({ pid: String(100 + index) })) })
  } })
  assert.equal(calls, 2, 'does not make an unbounded set of project info requests')
  assert.equal(unknown.projectUrl, null)
  assert.match(unknown.message, /预算.*尚未确认/)
})

test('a same-script historical project outside the create window cannot be rebound', async () => {
  const result = await discoverHuashengProject(input(), { session, fetch: async url => {
    assert.ok(new URL(String(url)).pathname.endsWith('/list'), 'old project needs no detail lookup')
    return json({ total: 1, projects: [{ pid: '100', script, created_at: 1700000000 }] })
  } })
  assert.equal(result.projectUrl, null)
})

test('discovery retries transient GET failures while keeping authentication failures terminal', async () => {
  let calls = 0
  const result = await discoverHuashengProject(input(), { session, fetch: async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    if (calls === 2) return new Response('', { status: 502 })
    return json({ total: 0, projects: [] })
  } })
  assert.equal(calls, 3)
  assert.equal(result.projectUrl, null)
  calls = 0
  await assert.rejects(discoverHuashengProject(input(), { session, fetch: async () => {
    calls++
    return new Response('', { status: 401 })
  } }), /会话已过期/)
  assert.equal(calls, 1)
})
