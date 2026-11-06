import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createHuashengPagePort, driveHuashengPage, HuashengBrowserError, type HuashengPageState, type HuashengCheckpoint, type HuashengPagePort } from './history-huasheng-browser.js'

const script = '完整的科普文稿。第二句话解释其中的科学机制。'
const projectUrl = 'https://www.huasheng.cn/video/123456789'
const home = (): HuashengPageState => ({ url: 'https://www.huasheng.cn/', loggedIn: true, loginRequired: false,
  buttons: ['创建'], hasCreateButton: true, requirementsReady: false, planReady: false,
  productionStarted: false, productionFinished: false, cost: null, error: null, scriptPresent: false })

async function run(port: HuashengPagePort, updates: HuashengCheckpoint[], checkpoint: string | null = null) {
  let now = 0
  return driveHuashengPage(port, { jobId: 'create-recovery', script, projectUrl: null, checkpoint,
    signal: new AbortController().signal, onCheckpoint: async value => { updates.push(value) } },
  { now: () => now, sleep: async ms => { now += ms }, pollMs: 1000, timeoutMs: 100_000 })
}

test('a create control rejected before clicking keeps the task retryable', async () => {
  const updates: HuashengCheckpoint[] = []
  const notStarted = new HuashengBrowserError('manual_review', '创建按钮尚未就绪', true)
  await assert.rejects(run({ read: async () => home(), fillScript: async () => {}, click: async () => { throw notStarted } }, updates), /尚未就绪/)
  assert.deepEqual(updates.map(value => value.checkpoint), ['create_pending', 'opening'])
})

test('an explicit rejected create can be retried, but an unknown click outcome cannot', async () => {
  const rejected: HuashengCheckpoint[] = []
  await assert.rejects(run({ read: async () => home(), fillScript: async () => {},
    click: async () => ({ code: 10001, message: '参数验证失败', requestRejected: true }) }, rejected), /参数验证失败/)
  assert.equal(rejected.at(-1)?.checkpoint, 'opening')

  const unknown: HuashengCheckpoint[] = []
  let clicks = 0
  await assert.rejects(run({ read: async () => home(), fillScript: async () => {}, click: async () => { clicks++; throw new Error('connection lost') } }, unknown), /connection lost/)
  assert.equal(unknown.at(-1)?.checkpoint, 'create_pending')
  await assert.rejects(run({ read: async () => home(), fillScript: async () => assert.fail('must not refill uncertain create'),
    click: async () => { clicks++; } }, unknown, 'create_pending'), /创建请求/)
  assert.equal(clicks, 1)
})

test('a matching create receipt persists its project before another page read', async () => {
  const updates: HuashengCheckpoint[] = []
  let reads = 0
  await assert.rejects(run({ read: async () => { if (reads++) throw new Error('navigation interrupted'); return home() },
    fillScript: async () => {}, click: async () => ({ code: 0, message: 'OK', projectUrl }) }, updates), /navigation interrupted/)
  assert.equal(updates.at(-1)?.checkpoint, 'created')
  assert.equal(updates.at(-1)?.projectUrl, projectUrl)
})

test('an observed project is not bound before its saved script has loaded and matched', async () => {
  const updates: HuashengCheckpoint[] = []
  await assert.rejects(run({ read: async () => ({ ...home(), url: projectUrl, scriptPresent: false }),
    fillScript: async () => assert.fail('must not type in another project'), click: async () => assert.fail('must not click') }, updates, 'create_pending'))
  assert.equal(updates.some(update => update.projectUrl), false)
})

const executablePath = process.env.HUASHENG_TEST_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
test('real DOM create receipt matches the submitted script and distinguishes rejection from missing controls',
  { skip: !fs.existsSync(executablePath), timeout: 20_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.setRequestInterception(true)
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/huasheng/project/create') {
          const body = JSON.parse(request.postData() || '{}')
          void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body.reject
            ? { code: 10001, message: '参数验证失败' }
            : { code: 0, message: 'OK', data: { pid: body.script === script ? 123456789 : 987654321 } }) })
        } else void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `
          <button>创建</button><script>
          window.rejectCreate = false;
          document.querySelector('button').onclick = async () => {
            const create = script => fetch('/api/huasheng/project/create', {
              method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({script,reject:window.rejectCreate})
            });
            await create('unrelated script');
            await create(${JSON.stringify(script)});
          };</script>` })
      })
      await page.goto('https://www.huasheng.cn/')
      const port = createHuashengPagePort(page, script)
      assert.deepEqual(await port.click('创建'), { code: 0, message: 'OK', projectUrl })
      await page.evaluate('window.rejectCreate = true')
      assert.deepEqual(await port.click('创建'), { code: 10001, message: '参数验证失败', requestRejected: true })
      await page.setContent('<button disabled>创建</button>')
      await assert.rejects(port.click('创建'), (error: unknown) => error instanceof HuashengBrowserError && error.actionNotStarted)
      const longScript = '两条任务可能拥有相同的开场。'.repeat(8) + '这是本条文稿独有的完整结尾。'
      const bindingPort = createHuashengPagePort(page, longScript)
      await page.setContent(`<p>${longScript.slice(0, 100)}另一篇稿件的结尾。</p>`)
      assert.equal((await bindingPort.read()).scriptPresent, false, 'matching only the first 80 characters must not bind another project')
      await page.setContent(`<p>${longScript}</p>`)
      assert.equal((await bindingPort.read()).scriptPresent, true)
    } finally { await browser.close() }
  })
