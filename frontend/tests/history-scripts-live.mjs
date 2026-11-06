import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const sourceId = Number(process.env.HISTORY_UI_TEST_SOURCE_ID || 1)
assert.ok(Number.isSafeInteger(sourceId) && sourceId > 0, 'A positive source ID is required')
const artifacts = await mkdtemp(join(tmpdir(), 'history-script-ui-'))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
page.setDefaultTimeout(15_000)

try {
  await page.goto(`${baseUrl}/history-scripts`, { waitUntil: 'domcontentloaded' })
  const source = (await (await page.request.get(`${baseUrl}/api/v1/history-scripts/${sourceId}`)).json()).data
  assert.ok(source?.rewrittenScript?.length > 100, 'The selected source must have a rewritten draft')
  await page.locator('.source-item').filter({ has: page.locator('.item-title', { hasText: source.title }) }).click()
  const editor = page.getByRole('textbox', { name: '编辑待审稿' })
  await editor.waitFor()
  await page.waitForFunction(text => document.querySelector('#rewritten-script')?.value === text, source.rewrittenScript)
  const baseline = await editor.inputValue()
  assert.ok(baseline.length > 100)
  assert.equal(await page.getByRole('link', { name: '历史脚本' }).count(), 1)
  assert.equal(source.videoAvailable, true)
  assert.ok(!source.mediaJson.includes('/Users/'))
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  const media = await page.locator('video').evaluate(async video => {
    video.muted = true
    video.currentTime = Math.min(60, video.duration / 2)
    await video.play()
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
  })
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 60.1)
  const pixels = await page.locator('video').evaluate(video => {
    const canvas = document.createElement('canvas')
    canvas.width = 120
    canvas.height = 68
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, 120, 68)
    const data = ctx.getImageData(0, 0, 120, 68).data
    const colors = new Set()
    let lit = 0
    for (let index = 0; index < data.length; index += 4) {
      colors.add(`${data[index]}:${data[index + 1]}:${data[index + 2]}`)
      if (data[index] + data[index + 1] + data[index + 2] > 60) lit += 1
    }
    video.pause()
    return { colors: colors.size, lit, currentTime: video.currentTime }
  })
  assert.ok(pixels.colors > 20 && pixels.lit > 200, 'Source video must decode a visible nonblank frame')
  const range = await page.request.get(`${baseUrl}/api/v1/history-scripts/${sourceId}/video`, { headers: { Range: 'bytes=100-199' } })
  assert.equal(range.status(), 206)
  assert.equal((await range.body()).length, 100)

  if (process.argv.includes('--verify-save')) {
    const marker = `${baseline}\n\n[UI SAVE VERIFICATION ${Date.now()}]`
    await editor.fill(marker)
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.source-item').filter({ has: page.locator('.item-title', { hasText: source.title }) }).click()
    await editor.waitFor()
    await page.waitForFunction(text => document.querySelector('#rewritten-script')?.value === text, marker)
    assert.equal(await editor.inputValue(), marker)
    await editor.fill(baseline)
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    const restored = (await (await page.request.get(`${baseUrl}/api/v1/history-scripts/${sourceId}`)).json()).data
    assert.equal(restored.rewrittenScript, baseline)
    assert.equal(restored.rawTranscript, source.rawTranscript)
    assert.equal(restored.status, 'needs_review')
    assert.deepEqual(JSON.parse(restored.reviewJson).manualRewriteReview, JSON.parse(source.reviewJson).manualRewriteReview)
  }

  const screenshots = []
  for (const [width, height] of [[1440, 1000], [1024, 768], [768, 1024], [375, 812], [812, 375]]) {
    await page.setViewportSize({ width, height })
    if (width < 761) await page.getByRole('button', { name: '详情', exact: true }).click()
    await page.locator('.detail-pane').evaluate(element => { element.scrollTop = 0 })
    await page.locator('#rewritten-script').evaluate(element => { element.blur(); element.scrollTop = 0 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const videoBounds = await page.locator('video').evaluate(video => {
      const frame = video.parentElement.getBoundingClientRect()
      const media = video.getBoundingClientRect()
      return { frame: frame.toJSON(), media: media.toJSON(), fit: getComputedStyle(video).objectFit }
    })
    assert.equal(videoBounds.fit, 'contain')
    assert.ok(videoBounds.media.width <= videoBounds.frame.width + 1 && videoBounds.media.height <= videoBounds.frame.height + 1, 'Portrait and landscape video must fit completely inside the player')
    const screenshot = join(artifacts, `${width}x${height}.png`)
    await page.screenshot({ path: screenshot })
    screenshots.push(screenshot)
  }
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ status: 'passed', sourceId, media, pixels, savedAndRestored: process.argv.includes('--verify-save'), screenshots }, null, 2))
} finally { await browser.close() }
