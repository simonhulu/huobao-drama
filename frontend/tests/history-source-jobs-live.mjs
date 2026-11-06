import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const mode = process.argv.includes('--start-and-stop') ? 'stop' : process.argv.includes('--start') ? 'start' : 'inspect'
const artifacts = await mkdtemp(join(tmpdir(), 'history-source-job-live-'))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
page.setDefaultTimeout(20_000)

try {
  await page.goto(`${baseUrl}/history-scripts`, { waitUntil: 'domcontentloaded' })
  const control = page.getByRole('region', { name: '历史素材采集任务' })
  await control.waitFor()
  let result = (await (await page.request.get(`${baseUrl}/api/v1/history-scripts/jobs`)).json()).data
  if (mode !== 'inspect') {
    assert.ok(!result.job || !['queued', 'running', 'stopping'].includes(result.job.status), 'Do not stop or replace an existing user task')
    await page.getByRole('button', { name: '启动采集', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '启动历史素材采集' })
    await dialog.waitFor()
    await dialog.getByRole('spinbutton', { name: '产出数量' }).fill('1')
    await dialog.getByRole('button', { name: '开始采集', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => /排队中|运行中/.test(document.querySelector('.job-control')?.textContent || ''), { timeout: 20_000 })
    assert.equal(await page.getByRole('button', { name: '启动采集', exact: true }).isEnabled(), false)
    result = (await (await page.request.get(`${baseUrl}/api/v1/history-scripts/jobs`)).json()).data
    assert.ok(result.job?.id)
    const id = result.job.id
    if (mode === 'stop') {
      const deadline = Date.now() + 120_000
      let browsing = false
      while (Date.now() < deadline) {
        const response = await page.request.get(`${baseUrl}/api/v1/history-scripts/jobs/${id}`)
        const job = (await response.json()).data?.job
        assert.ok(job && !['stopped', 'completed', 'failed', 'interrupted'].includes(job.status),
          `Task ended before browser-stop verification: ${job?.progressMessage}`)
        browsing = job.status === 'running' && job.stage === 'browsing'
          && job.events?.some(event => event.stage === 'browsing' && event.message.includes('搜索已就绪'))
        if (browsing) break
        await delay(500)
      }
      assert.ok(browsing, 'Task must reach a verified search before testing browser cancellation')
      await page.getByRole('button', { name: '停止', exact: true }).click()
      await page.waitForFunction(() => /已停止/.test(document.querySelector('.job-control')?.textContent || ''), { timeout: 45_000 })
      result = (await (await page.request.get(`${baseUrl}/api/v1/history-scripts/jobs/${id}`)).json()).data
      assert.equal(result.job.status, 'stopped')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => /已停止/.test(document.querySelector('.job-control')?.textContent || ''))
      assert.equal(await page.getByRole('button', { name: '启动采集', exact: true }).isEnabled(), true)
    }
  }
  const screenshots = []
  for (const [width, height] of [[1440, 1000], [375, 812]]) {
    await page.setViewportSize({ width, height })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const screenshot = join(artifacts, `${width}x${height}.png`)
    await page.screenshot({ path: screenshot })
    screenshots.push(screenshot)
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ mode, job: result.job, screenshots, pageErrors: errors }, null, 2))
} finally { await browser.close() }
