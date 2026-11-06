import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SocialUploadAccountError } from '../services/social-upload-accounts.js'
import type { HuashengProjectBinding } from '../services/huasheng-project-open.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huasheng-open-routes-'))
process.env.DB_PATH = path.join(root, 'bootstrap.db')
process.env.TASK_WORKER_DISABLED = '1'
const { createScienceWorkflowRoute } = await import('./science-workflow.js')
const { createHistoryHuashengRoute } = await import('./history-huasheng.js')
const { createMysteryStoriesRoute } = await import('./mystery-stories.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const projectUrl = 'https://www.huasheng.cn/video/123'
const post = (body: unknown = {}, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

function fixture(scope: 'science' | 'history' | 'mystery') {
  const bindings: HuashengProjectBinding[] = []
  const job = { huashengAccountName: `${scope}_original_account`, projectUrl, videoUrl: null as string | null }
  const edition = { id: 'edition-original', accountName: 'mystery_original_account', projectUrl }
  let error: Error | undefined
  const openProject = async (binding: HuashengProjectBinding) => {
    bindings.push(binding)
    if (error) throw error
    return { accountName: binding.accountName!, projectUrl: binding.home ? 'https://www.huasheng.cn/' : binding.projectUrl!, reused: true, message: '已打开原账号项目' }
  }
  const app = scope === 'science'
    ? createScienceWorkflowRoute({ service: { detail: () => job } as any, accounts: new Hono(), openProject })
    : scope === 'history'
      ? createHistoryHuashengRoute({ service: { getJob: () => job } as any, openProject })
      : createMysteryStoriesRoute({ service: { store: { get: () => ({ editions: [edition] }) } } as any, accounts: new Hono(), openProject })
  const url = scope === 'science' ? '/jobs/science-original/open-project' : scope === 'history' ? '/huasheng/jobs/17/open-project' : '/stories/17/editions/edition-original/open-project'
  return { app, url, bindings, job, edition, fail: (value: Error) => { error = value } }
}

for (const scope of ['science', 'history', 'mystery'] as const) {
  test(`${scope}: opens only the saved binding and returns the browser result`, async () => {
    const f = fixture(scope)
    const response = await f.app.request(f.url, post())
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(f.bindings, [{ accountName: `${scope}_original_account`, projectUrl }])
    assert.deepEqual((await response.json()).data, { accountName: `${scope}_original_account`, projectUrl, reused: true, message: '已打开原账号项目' })
  })

  test(`${scope}: rejects account, URL, profile and origin overrides before opening`, async () => {
    const f = fixture(scope)
    for (const input of [{ accountName: 'another-account' }, { projectUrl: 'https://www.huasheng.cn/video/999' }, { profile: '/other-profile' }]) {
      assert.equal((await f.app.request(f.url, post(input))).status, 400)
    }
    assert.equal((await f.app.request(`${f.url}?accountName=other`, post())).status, 400)
    assert.equal((await f.app.request(f.url, post({}, { Origin: 'https://example.com' }))).status, 403)
    assert.equal((await f.app.request(f.url, post({}, { 'Content-Type': 'text/plain' }))).status, 400)
    assert.equal((await f.app.request(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400)
    assert.equal(f.bindings.length, 0)
  })

  test(`${scope}: surfaces managed-account identity errors as actionable conflicts`, async () => {
    const f = fixture(scope); f.fail(new SocialUploadAccountError('当前登录用户与任务绑定的花生账号不一致，请登录原账号', 409))
    const response = await f.app.request(f.url, post())
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /请登录原账号/)
  })
}

test('history: falls back to a saved videoUrl project or the original account homepage for recovery', async () => {
  const f = fixture('history')
  f.job.projectUrl = ''; f.job.videoUrl = projectUrl
  assert.equal((await f.app.request(f.url, post())).status, 200)
  assert.deepEqual(f.bindings.pop(), { accountName: 'history_original_account', projectUrl })
  f.job.videoUrl = 'https://cdn.example.com/movie.mp4'
  assert.equal((await f.app.request(f.url, post())).status, 200)
  assert.deepEqual(f.bindings.pop(), { accountName: 'history_original_account', projectUrl: null, home: true })
})

test('mystery: a missing edition never opens the current/default account', async () => {
  const f = fixture('mystery')
  const response = await f.app.request('/stories/17/editions/not-present/open-project', post())
  assert.equal(response.status, 404)
  assert.equal(f.bindings.length, 0)
})
