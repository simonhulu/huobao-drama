import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.REMOTION_UI_TEST_URL || 'http://127.0.0.1:3013'
const artifacts = await mkdtemp(join(tmpdir(), 'remotion-style-previews-'))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const failures = []
  const errors = []
  page.on('response', response => {
    if (response.url().includes('/static/') && response.status() >= 400) failures.push({ url: response.url(), status: response.status() })
  })
  page.on('pageerror', error => errors.push(error.message))
  // Preview verification must never change a real project's style or start work.
  await page.route('**/api/v1/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort())
  const response = await page.request.get(`${baseUrl}/api/v1/remotion/style-pilots`)
  assert.equal(response.status(), 200)
  const { items } = (await response.json()).data
  assert.ok(items.length > 0, 'The saved catalog must contain styles')
  for (const style of items.filter(style => style.url && style.mediaType !== 'prompt')) {
    assert.equal((await page.request.head(`${baseUrl}${style.url}`)).status(), 200, style.id)
  }
  await page.goto(`${baseUrl}/remotion`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.style-image')?.naturalWidth > 100)
  assert.equal(await page.locator('.rail-style').count(), items.length)
  const preview = await page.locator('.style-image').getAttribute('src')
  assert.ok(items.some(item => item.url === preview))
  await page.locator('.style-console').screenshot({ path: join(artifacts, 'desktop-preview.png') })
  await page.getByRole('tab', { name: '对比', exact: true }).click()
  const images = page.locator('.compare-media img')
  const comparisonCount = await images.count()
  assert.equal(comparisonCount, items.filter(style => style.mediaType === 'image').length)
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded()
    await image.evaluate(element => element.decode())
    assert.ok(await image.evaluate(element => element.naturalWidth > 100))
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: '预览', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.style-image')?.naturalWidth > 100)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow')
  await page.locator('.style-console').screenshot({ path: join(artifacts, 'mobile-preview.png') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('.style-image')?.naturalWidth > 100)
  assert.equal(await page.locator('.rail-style').count(), items.length)
  assert.deepEqual(failures, [])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ styles: items.length, decodedComparisonImages: comparisonCount, preview, failedMediaRequests: failures.length,
    pageErrors: errors.length, reloadPassed: true, artifacts }))
} finally { await browser.close() }
