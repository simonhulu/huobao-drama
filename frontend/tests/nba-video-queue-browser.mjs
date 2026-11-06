import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const origin = process.env.NBA_WORKBENCH_URL || 'http://localhost:3013'
const output = fileURLToPath(new URL('../../outputs/nba-queue-deletion-20261105/browser/', import.meta.url))
await fs.mkdir(output, { recursive: true })
const now = new Date().toISOString()
const makeJob = (id, title, status) => ({ id, title, status, stage: 'media', message: 'Local browser fixture',
  createdAt: now, updatedAt: now, attempts: status === 'running' ? 1 : 0, canResume: status === 'queued',
  canDelete: status === 'queued', deleteBlockedReason: status === 'running' ? '该任务正在制作，请先停止当前批次再删除' : undefined,
  canUpload: false, uploaded: false, uploads: [], assets: {}, logs: [],
  article: { id: `article-${id}`, title, url: `https://example.test/${id}`, publisher: 'Local sports fixture',
    language: 'en', wordCount: 120, characterCount: 0, body: 'Basketball report. '.repeat(120) } })
const running = makeJob('nba-fixture-running', '正在制作的新闻', 'running')
const unwanted = makeJob('nba-fixture-unwanted', '待删除的排队新闻', 'queued')
const last = makeJob('nba-fixture-last', '继续保留的新闻', 'queued')
const run = { id: 'run-fixture', kind: 'resume', status: 'running', jobIds: [running.id, unwanted.id, last.id], message: '1/3 · 制作中', createdAt: now, updatedAt: now }
const state = {
  settings: { youtubeChannels: ['https://www.youtube.com/@NBA/videos'], videosPerChannel: 20, languages: ['en', 'zh'],
    limit: 6, autoProduce: true, autoUpload: false, scheduleEnabled: false, intervalMinutes: 60,
    voice: 'longanhuan_v3.1', speed: 1.05, originalGain: 0.32, arenaGain: 0.85 },
  uploadAccount: null, jobs: [running, unwanted, last], matches: [], runs: [run], activeRun: run,
  activeCollection: null, activeProcessing: run, queuedProcessing: [],
  stats: { total: 3, completed: 0, resumable: 2, running: 1, waitingUpload: 0, uploaded: 0 },
}
const mutations = [], errors = []
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => errors.push(error.message))
  // All NBA requests are intercepted so this test cannot modify a real queue.
  await page.route('**/api/v1/nba-video**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname
    let data, status = 200
    if (request.method() === 'DELETE') {
      mutations.push({ method: 'DELETE', pathname, body: request.postDataJSON() })
      assert.equal(pathname, `/api/v1/nba-video/jobs/${unwanted.id}`)
      assert.equal(request.postDataJSON().expectedTitle, unwanted.title)
      state.jobs = state.jobs.filter(job => job.id !== unwanted.id)
      run.jobIds = run.jobIds.filter(id => id !== unwanted.id)
      state.stats.total--
      data = { deleted: true, id: unwanted.id }
    } else if (request.method() !== 'GET') {
      throw new Error(`Unexpected mutation: ${request.method()} ${pathname}`)
    } else if (pathname === '/api/v1/nba-video') data = state
    else {
      data = state.jobs.find(job => job.id === pathname.split('/').at(-1))
      if (!data) status = 404
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: status, data, message: status === 200 ? 'success' : '任务不存在' }) })
  })
  await page.goto(`${origin}/nba-video?job=${running.id}`, { waitUntil: 'domcontentloaded' })
  const deleteButton = page.getByRole('button', { name: '删除任务', exact: true })
  await deleteButton.waitFor()
  assert.equal(await deleteButton.isDisabled(), true)
  assert.match(await deleteButton.getAttribute('title'), /正在制作.*停止/)
  await page.locator('.queue-item').filter({ hasText: unwanted.title }).click()
  await page.getByRole('heading', { name: unwanted.title, exact: true }).waitFor()
  assert.equal(await deleteButton.isEnabled(), true)
  await page.screenshot({ path: `${output}desktop.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await deleteButton.isEnabled(), true)
  await deleteButton.click()
  const dialog = page.locator('dialog[open]')
  await dialog.waitFor()
  assert.match(await dialog.innerText(), /从制作队列移除/)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: `${output}mobile-confirm.png` })
  await dialog.locator('.delete-confirm').click()
  await page.waitForFunction(title => !Array.from(document.querySelectorAll('.queue-title')).some(node => node.textContent === title), unwanted.title)
  assert.equal(await page.locator('.queue-item').filter({ hasText: last.title }).count(), 1)
  assert.equal(mutations.length, 1)
  assert.deepEqual(errors, [])
  const report = { passed: true, checks: ['running deletion blocked with reason', 'queued deletion enabled in active batch',
    'desktop and mobile', 'queue removal confirmed', 'later task retained'], mutations, errors, realTaskMutations: 0 }
  await fs.writeFile(`${output}result.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
