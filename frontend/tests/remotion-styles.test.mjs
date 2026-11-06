import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseUrl = process.env.REMOTION_UI_TEST_URL || 'http://127.0.0.1:3013'
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64')
const style = (id, extra = {}) => ({ id, name: `数据库风格 ${id}`, desc: '持久化风格', mood: '水墨', lens: '全景',
  profile: '测试风格档案', url: `/static/images/persisted-${id}.png`, mediaType: 'image', aspectRatio: '16:9', prompt: '', ...extra })

async function harness() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(5000)
  const state = { items: [style('alpha'), style('beta')], failCatalog: false, failImage: false, imageRequests: [], errors: [] }
  page.on('pageerror', error => state.errors.push(error.message))
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url())
    let data = { items: [], total: 0 }
    if (url.pathname === '/api/v1/remotion/style-pilots') {
      if (state.failCatalog) return route.fulfill({ status: 503, json: { code: 503, message: '风格库暂不可用' } })
      data = { items: state.items }
    }
    await route.fulfill({ json: { code: 200, data } })
  })
  await page.route('**/static/**', async route => {
    state.imageRequests.push(new URL(route.request().url()).pathname)
    if (state.failImage) return route.fulfill({ status: 404, body: 'Not found' })
    await route.fulfill({ contentType: 'image/png', body: pixel })
  })
  return { browser, page, state, open: async () => { await page.goto(`${baseUrl}/remotion`, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: '画面风格', exact: true }).click() } }
}

test('renders persisted catalog URLs, supports comparison and reloads changed addresses without hardcoded fallback', async () => {
  const h = await harness()
  try {
    await h.open()
    await h.page.getByRole('button', { name: /数据库风格 alpha/ }).waitFor()
    await h.page.waitForFunction(() => document.querySelector('.style-image')?.naturalWidth > 0)
    assert.equal(await h.page.locator('.style-image').getAttribute('src'), '/static/images/persisted-alpha.png')
    assert.equal(await h.page.locator('.rail-style').count(), 2)
    await h.page.getByRole('tab', { name: '对比', exact: true }).click()
    assert.equal(await h.page.locator('.compare-media img').count(), 2)
    h.state.items = [style('alpha', { url: '/static/images/alpha-regenerated.png' })]
    await h.page.reload({ waitUntil: 'domcontentloaded' })
    await h.page.getByRole('button', { name: '画面风格', exact: true }).click()
    await h.page.waitForFunction(() => document.querySelector('.style-image')?.getAttribute('src') === '/static/images/alpha-regenerated.png')
    assert.ok(h.state.imageRequests.every(url => /persisted-(alpha|beta)|alpha-regenerated/.test(url)))
    assert.deepEqual(h.state.errors, [])
  } finally { await h.browser.close() }
})

test('catalog failure and an empty catalog show explicit states without requesting obsolete files', async () => {
  const h = await harness()
  try {
    h.state.failCatalog = true
    await h.open()
    await h.page.getByText('风格库暂不可用', { exact: true }).waitFor()
    assert.deepEqual(h.state.imageRequests, [])
    h.state.failCatalog = false
    h.state.items = []
    await h.page.getByRole('button', { name: '重试加载风格', exact: true }).click()
    await h.page.getByText('暂无画面风格', { exact: true }).waitFor()
    assert.equal(await h.page.locator('.style-image').count(), 0)
    assert.deepEqual(h.state.errors, [])
  } finally { await h.browser.close() }
})

test('missing preview explains the failure, can retry, and prompt-only styles do not load a video', async () => {
  const h = await harness()
  try {
    h.state.failImage = true
    await h.open()
    await h.page.getByText('预览文件暂不可用', { exact: true }).waitFor()
    h.state.failImage = false
    await h.page.getByRole('button', { name: '重试预览', exact: true }).click()
    await h.page.waitForFunction(() => document.querySelector('.style-image')?.naturalWidth > 0)
    h.state.items = [style('prompt', { url: '', mediaType: 'prompt', prompt: '保留风格提示词' })]
    await h.page.reload({ waitUntil: 'domcontentloaded' })
    await h.page.getByRole('button', { name: '画面风格', exact: true }).click()
    await h.page.locator('.style-prompt-preview').getByText('保留风格提示词', { exact: true }).waitFor()
    assert.equal(await h.page.locator('.video-shell video').count(), 0)
    assert.deepEqual(h.state.errors, [])
  } finally { await h.browser.close() }
})
