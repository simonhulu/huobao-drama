import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import puppeteer, { type Browser } from 'puppeteer-core'
import { connectHuashengBrowser, createHuashengTemporaryPage, quietHuashengHomepageMedia } from './history-huasheng-browser.js'

const home = 'https://www.huasheng.cn/'

function fixture(urls: string[]) {
  const evaluated: string[] = []
  const detached: string[] = []
  const targets = urls.map(url => ({
    type: () => 'page', url: () => url,
    page: async () => { assert.fail('media handling must not initialize a page') },
    createCDPSession: async () => ({
      send: async (method: string) => { assert.equal(method, 'Runtime.evaluate'); evaluated.push(url) },
      detach: async () => { detached.push(url) },
    }),
  }))
  const browser = { targets: () => targets } as unknown as Browser
  return { browser, targets, evaluated, detached }
}

test('homepage media handling selects only exact home URLs without initializing retained pages', async () => {
  const f = fixture([home, home + 'video/123', home + '?draft=1', home + '#draft', 'https://huasheng.cn/', 'https://www.huasheng.cn.evil/'])
  await quietHuashengHomepageMedia(f.browser)
  assert.deepEqual(f.evaluated, [home])
  assert.deepEqual(f.detached, [home])
})

test('optional media handling continues after an unavailable homepage', async () => {
  const f = fixture([home, home])
  f.targets[0]!.createCDPSession = async () => { throw new Error('closed target') }
  await quietHuashengHomepageMedia(f.browser)
  assert.deepEqual(f.evaluated, [home])
})

test('the whole homepage pass is bounded to two seconds with at most 500ms per target', async () => {
  const f = fixture(Array.from({ length: 12 }, () => home))
  let started = 0
  for (const target of f.targets) target.createCDPSession = async () => {
    started++
    return { send: async () => new Promise(() => {}), detach: async () => {} }
  }
  const before = Date.now()
  await quietHuashengHomepageMedia(f.browser)
  assert.ok(Date.now() - before < 2600)
  assert.ok(started >= 1 && started <= 4)
})

test('cancellation stops media handling and detaches the target session', async () => {
  const f = fixture([home, home]), controller = new AbortController()
  f.targets[0]!.createCDPSession = async () => {
    controller.abort()
    return { send: async () => { assert.fail('canceled evaluation must not be sent') }, detach: async () => { f.detached.push(home) } }
  }
  await assert.rejects(quietHuashengHomepageMedia(f.browser, controller.signal), error => (error as Error).name === 'AbortError')
  assert.deepEqual(f.evaluated, [])
  assert.deepEqual(f.detached, [home])
})

test('a late target attachment is detached without sending a delayed media mutation', async () => {
  const f = fixture([home])
  let finish!: (value: any) => void
  f.targets[0]!.createCDPSession = () => new Promise(resolve => { finish = resolve })
  await quietHuashengHomepageMedia(f.browser)
  finish({ send: async () => { assert.fail('late attachment must not evaluate') }, detach: async () => { f.detached.push(home) } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.detached, [home])
})

test('connection verifies the owned profile before applying homepage media handling', async t => {
  const f = fixture([home])
  const events: string[] = []
  const config = { endpoint: 'http://127.0.0.1:9250', profile: '/tmp/huasheng-media-account' }
  const browser = Object.assign(f.browser, {
    target: () => ({ createCDPSession: async () => ({
      send: async (method: string) => { events.push(method); return { arguments: [`--user-data-dir=${config.profile}`] } },
      detach: async () => {},
    }) }),
    disconnect: async () => {},
  })
  const create = f.targets[0]!.createCDPSession
  f.targets[0]!.createCDPSession = async () => { events.push('homepage-media'); return create() }
  t.mock.method(puppeteer, 'connect', async () => browser)
  assert.equal(await connectHuashengBrowser(config), browser)
  assert.deepEqual(events, ['Browser.getBrowserCommandLine', 'homepage-media'])
  events.length = 0
  await assert.rejects(connectHuashengBrowser({ ...config, profile: '/tmp/another-account' }), /专用浏览器/)
  assert.deepEqual(events, ['Browser.getBrowserCommandLine'])
})

const executablePath = process.env.HUASHENG_TEST_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')

test('real Chromium pauses only idle homepage media and ignores drafts, busy work and project previews',
  { skip: !fs.existsSync(executablePath), timeout: 20_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><body></body>' }) })
      const cases = [
        { url: home, body: '<textarea></textarea><input type="hidden" value="session"><video autoplay></video>', pauses: 1 },
        { url: home, body: '<textarea>未完成的稿件</textarea><video autoplay></video>', pauses: 0 },
        { url: home, body: '<input value="正在编辑"><video autoplay></video>', pauses: 0 },
        { url: home, body: '<div contenteditable="true">未完成的稿件</div><video autoplay></video>', pauses: 0 },
        { url: home, body: '<div contenteditable>未完成的稿件</div><video autoplay></video>', pauses: 0 },
        { url: home, body: '<div contenteditable="plaintext-only">未完成的稿件</div><video autoplay></video>', pauses: 0 },
        { url: home, body: '<div role="progressbar"></div><video autoplay></video>', pauses: 0 },
        { url: home, body: '<div aria-busy="true"></div><video autoplay></video>', pauses: 0 },
        { url: home, body: '<div>正在导出</div><video autoplay></video>', pauses: 0 },
        { url: home + 'video/123', body: '<video autoplay></video>', pauses: 0 },
        { url: home + '?draft=1', body: '<video autoplay></video>', pauses: 0 },
      ]
      for (const item of cases) {
        await page.goto(item.url)
        await page.setContent(item.body)
        await page.evaluate(() => {
          const video = document.querySelector('video')!
          video.dataset.pauses = '0'
          video.pause = () => { video.dataset.pauses = String(Number(video.dataset.pauses) + 1) }
        })
        await quietHuashengHomepageMedia(browser)
        const observed = await page.evaluate(() => {
          const video = document.querySelector('video')!
          return { pauses: Number(video.dataset.pauses), autoplay: video.autoplay, attribute: video.hasAttribute('autoplay') }
        })
        assert.deepEqual(observed, { pauses: item.pauses, autoplay: !item.pauses, attribute: !item.pauses }, item.body + item.url)
      }
      await page.goto(home)
      await quietHuashengHomepageMedia(browser)
      await page.evaluate(() => {
        const video = document.createElement('video')
        video.id = 'late'; video.autoplay = true; video.dataset.pauses = '0'
        video.pause = () => { video.dataset.pauses = String(Number(video.dataset.pauses) + 1) }
        document.body.append(video)
        video.dispatchEvent(new Event('play'))
      })
      assert.deepEqual(await page.$eval('#late', video => ({ autoplay: (video as HTMLVideoElement).autoplay, pauses: video.getAttribute('data-pauses') })),
        { autoplay: false, pauses: '1' })
      await page.evaluate(() => {
        const input = document.createElement('textarea'); input.value = '新的草稿'; document.body.append(input)
        const video = document.querySelector('video')!
        video.autoplay = true; video.dataset.pauses = '0'; video.dispatchEvent(new Event('play'))
      })
      assert.deepEqual(await page.$eval('#late', video => ({ autoplay: (video as HTMLVideoElement).autoplay, pauses: video.getAttribute('data-pauses') })),
        { autoplay: true, pauses: '0' })
      await page.evaluate(() => {
        history.pushState({}, '', '/video/123')
        const video = document.querySelector('video')!
        video.autoplay = true; video.dataset.pauses = '0'; video.dispatchEvent(new Event('play'))
      })
      assert.deepEqual(await page.$eval('#late', video => ({ autoplay: (video as HTMLVideoElement).autoplay, pauses: video.getAttribute('data-pauses') })),
        { autoplay: true, pauses: '0' })
    } finally { await browser.close() }
  })

test('new owned pages register the homepage guard before navigation without affecting project video',
  { skip: !fs.existsSync(executablePath), timeout: 15_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await createHuashengTemporaryPage(browser)
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<video autoplay></video>' }) })
      await page.goto(home)
      assert.equal(await page.$eval('video', video => (video as HTMLVideoElement).autoplay), false)
      await page.goto(home + 'video/123')
      assert.equal(await page.$eval('video', video => (video as HTMLVideoElement).autoplay), true)
    } finally { await browser.close() }
  })
