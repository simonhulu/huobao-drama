import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const origin = process.env.NBA_WORKBENCH_URL || 'http://localhost:3013'
const artifacts = fileURLToPath(new URL('../../outputs/nba-continuous-20261105/browser/', import.meta.url))
await fs.mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors = [], mutations = [], checks = []
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
await context.route('**/api/v1/nba-video**', async route => {
  if (route.request().method() === 'GET' || route.request().method() === 'HEAD') return route.continue()
  mutations.push({ method: route.request().method(), url: route.request().url() })
  await route.abort('blockedbyclient')
})
try {
  const page = await context.newPage()
  await page.goto(`${origin}/nba-video`, { waitUntil: 'domcontentloaded' })
  const response = await page.request.get(`${origin}/api/v1/nba-video`)
  assert.equal(response.status(), 200)
  const live = (await response.json()).data
  await page.getByLabel('定时采集状态', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('定时采集状态', { exact: true }).innerText(), live.settings.scheduleEnabled
    ? `每 ${live.settings.intervalMinutes} 分钟采集` : '定时采集已关闭')
  await page.screenshot({ path: path.join(artifacts, 'desktop.png') })

  await page.getByRole('button', { name: '采集与制作设置', exact: true }).click()
  const scan = page.getByLabel('每频道扫描视频数', { exact: true })
  await scan.waitFor()
  assert.equal(await scan.getAttribute('max'), '1000')
  await scan.fill('1001')
  assert.equal(await scan.evaluate(element => element.validity.rangeOverflow), true)
  await scan.fill('1000')
  assert.equal(await scan.evaluate(element => element.validity.valid), true)
  await page.screenshot({ path: path.join(artifacts, 'settings-desktop.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  checks.push({ check: 'Live settings allow 1000 scans and reject 1001 without saving', passed: true })

  const collect = page.getByRole('button', { name: '批量采集', exact: true }).first()
  if (await collect.isEnabled()) {
    await collect.click()
    const collectScan = page.getByLabel('每频道扫描视频数', { exact: true })
    assert.equal(await collectScan.getAttribute('max'), '1000')
    await collectScan.fill('1000')
    assert.equal(await collectScan.evaluate(element => element.validity.valid), true)
    await collectScan.fill('1001')
    assert.equal(await collectScan.evaluate(element => element.validity.rangeOverflow), true)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    checks.push({ check: 'Live collection form uses the same 1000-video boundary', passed: true })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '采集与制作设置', exact: true }).click()
  await page.getByLabel('每频道扫描视频数', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: path.join(artifacts, 'settings-mobile.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  checks.push({ check: 'Mobile settings fit a 390-pixel viewport', passed: true })

  const scheduled = await context.newPage()
  const nextCollectionAt = '2026-11-06T01:30:00.000Z'
  const fixture = { ...live, settings: { ...live.settings, scheduleEnabled: true, intervalMinutes: 10 },
    activeCollection: null, activeProcessing: null, activeRun: null, queuedProcessing: [], nextCollectionAt }
  await scheduled.route('**/api/v1/nba-video', route => route.fulfill({ json: { code: 200, data: fixture, message: 'success' } }))
  await scheduled.goto(`${origin}/nba-video`, { waitUntil: 'domcontentloaded' })
  await scheduled.getByText('每 10 分钟采集', { exact: true }).waitFor()
  const collectionQueue = scheduled.getByRole('region', { name: '采集与制作队列' }).getByLabel('采集队列', { exact: true })
  assert.ok((await collectionQueue.innerText()).includes('下次采集：'))
  await scheduled.screenshot({ path: path.join(artifacts, 'scheduled-desktop.png') })
  checks.push({ check: 'Scheduled idle collection displays interval and next collection time', passed: true })

  assert.deepEqual(mutations, [])
  assert.deepEqual(errors, [])
  const result = { checkedAt: new Date().toISOString(), mutations: mutations.length, errors, checks }
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
