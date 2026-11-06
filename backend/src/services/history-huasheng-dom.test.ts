import test from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHuashengPagePort, driveHuashengPage, inspectHuashengPage, runHuashengBrowserJob, openHuashengBrowser, getHuashengBrowserStatus } from './history-huasheng-browser.js'

const executablePath = process.env.HUASHENG_TEST_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
const script = '秦朝统一六国。\n\n历史稿保留完整正文，数字、标点和换行均不得丢失。'
const editor = '<button>撤销</button><button>重做</button><button>导出</button><button>上一分镜</button><button>播放</button><button>下一分镜</button><p>分镜01</p>'

test('browser connection waits for saved login hydration and reuses the blank dedicated tab',
  { skip: !fs.existsSync(executablePath), timeout: 20_000 }, async () => {
    const profile = fs.mkdtempSync(path.join(tmpdir(), 'huasheng-login-hydration-'))
    const oldEndpoint = process.env.HUASHENG_CDP_URL
    const oldProfile = process.env.HUASHENG_PROFILE_DIR
    const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] })
    try {
      process.env.HUASHENG_CDP_URL = `http://127.0.0.1:${new URL(browser.wsEndpoint()).port}`
      process.env.HUASHENG_PROFILE_DIR = profile
      const page = (await browser.pages())[0]!
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body:
        '<button>创建</button><header></header><script>setTimeout(() => document.querySelector("header").textContent="我的会员", 500)</script>' }) })
      await page.goto('https://www.huasheng.cn/')
      assert.equal((await getHuashengBrowserStatus()).status, 'ready', 'Create can render before the saved account')
      await page.setContent('<button>登录</button><script>setTimeout(() => document.body.innerHTML="<header>我的会员</header><button>创建</button>", 500)</script>')
      assert.equal((await getHuashengBrowserStatus()).status, 'ready', 'a transient login button is not an expired session')
      await page.setContent('<button>登录</button>')
      assert.equal((await getHuashengBrowserStatus()).status, 'login_required', 'a stable login prompt stays actionable')
      await page.goto('about:blank')
      assert.equal((await openHuashengBrowser()).status, 'ready')
      assert.equal((await browser.pages()).length, 1, 'reuse the startup tab instead of opening a second homepage')
    } finally {
      if (oldEndpoint === undefined) delete process.env.HUASHENG_CDP_URL; else process.env.HUASHENG_CDP_URL = oldEndpoint
      if (oldProfile === undefined) delete process.env.HUASHENG_PROFILE_DIR; else process.env.HUASHENG_PROFILE_DIR = oldProfile
      await browser.close()
      fs.rmSync(profile, { recursive: true, force: true })
    }
  })

test('real Chromium DOM adapter follows the complete flow with disabled controls, delayed dialog and multiline script',
  { skip: !fs.existsSync(executablePath), timeout: 30_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      // All requests are fulfilled locally. No login or live production is used.
      await page.setRequestInterception(true)
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/huasheng/project_plan/confirm') {
          void request.respond({ status: 200, contentType: 'application/json', body: '{"code":0,"message":"OK"}' })
          return
        }
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html>
        <html><head><meta charset="utf-8"></head><body><header>我的会员</header><main><textarea aria-label="二创文稿"></textarea>
        <textarea style="visibility:hidden" aria-hidden="true"></textarea><button id="create" disabled>创建</button></main>
        <aside id="messages"></aside><script>
        const content = document.querySelector('main');
        const messages = document.querySelector('#messages');
        window.actions = []; window.sent = '';
        document.querySelector('textarea').addEventListener('input', () => setTimeout(() => document.querySelector('#create').disabled = false, 500));
        document.querySelector('#create').onclick = () => {
          window.actions.push('create'); window.sent = document.querySelector('textarea').value;
          history.pushState({}, '', '/video/123456789');
          messages.textContent = window.sent;
          content.innerHTML = '<button disabled>A - 素材剪辑成片</button><button id="scheme">A - 素材剪辑成片</button><button>B - 素材混合MG动画</button>';
          document.querySelector('#scheme').onclick = () => {
            window.actions.push('A');
            content.innerHTML = '<p>视频成片需求</p><p>成片需求已完成！确认是否满足你的创作需求</p><button id="requirements">确认</button>';
            document.querySelector('#requirements').onclick = () => {
              window.actions.push('requirements');
              content.innerHTML = '<p>创作规划书 生成完成</p><p>分镜方案已生成</p><button id="plan">确认，开始制作</button>';
              document.querySelector('#plan').onclick = () => {
                window.actions.push('plan');
                content.innerHTML += '<section role="dialog"><div><span>总预估消耗</span><span>0</span></div><button id="confirm">确认并继续</button></section>';
                document.querySelector('#confirm').onclick = async () => {
                  window.actions.push('confirm');
                  await fetch('/api/huasheng/project_plan/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: 123456789 }) });
                  content.innerHTML = '${editor}<p>✓ 准备阶段（已完成）</p><p>✂️ 创建分镜（1/8 已完成）</p>';
                };
              };
            };
          };
        };
        </script></body></html>` }) })
      await page.goto('https://www.huasheng.cn/')
      const port = createHuashengPagePort(page, script)
      const initial = await port.read()
      assert.equal(initial.hasCreateButton, true)
      assert.equal(initial.buttons.includes('创建'), false, 'empty homepage disables Create')
      const checkpoints: string[] = []
      const result = await driveHuashengPage(port, { jobId: 1, script, projectUrl: null, checkpoint: null,
        signal: new AbortController().signal, onCheckpoint: async checkpoint => { checkpoints.push(checkpoint.checkpoint) } },
      { pollMs: 10, timeoutMs: 15_000 })
      assert.deepEqual(result, { projectUrl: 'https://www.huasheng.cn/video/123456789' })
      assert.equal(await page.evaluate('window.sent'), script)
      assert.deepEqual(await page.evaluate('window.actions'), ['create', 'A', 'requirements', 'plan', 'confirm'])
      assert.equal(checkpoints.at(-1), 'submitted')

      await page.setContent('<p>我的会员</p><div>普通稿件提到了创建分镜（8/8）和视频已经制作完成</div><button disabled>确认并继续</button>')
      const narrated = await port.read()
      assert.equal(narrated.productionStarted, false, 'words inside narration are not proof of production')
      assert.equal(narrated.productionFinished, false)
      assert.deepEqual(narrated.buttons, [])
      await page.setContent('<p>我的会员</p><p>✓ 准备阶段（已完成）</p><p>✂️ 创建分镜（1/8 已完成）</p>')
      assert.equal((await port.read()).productionStarted, false, 'chat progress alone does not prove entry to the video editor or production queue')
      await page.setContent('<p>我的会员</p>' + editor)
      assert.equal((await port.read()).productionStarted, true, 'the video editor itself is an authoritative start signal')
      await page.setContent('<p>我的会员</p><div role="dialog">请扫码登录</div><div role="alert">登录已失效</div>')
      const expired = await port.read()
      assert.equal(expired.loginRequired, true)
      assert.equal(expired.loggedIn, false)
      assert.equal(expired.error, '登录已失效')
    } finally { await browser.close() }
  })

test('a marked homepage tab resumes its persisted project URL after login without creating again',
  { skip: !fs.existsSync(executablePath), timeout: 20_000 }, async () => {
    const profile = fs.mkdtempSync(path.join(tmpdir(), 'huasheng-resume-browser-'))
    const oldEndpoint = process.env.HUASHENG_CDP_URL
    const oldProfile = process.env.HUASHENG_PROFILE_DIR
    const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] })
    try {
      process.env.HUASHENG_CDP_URL = `http://127.0.0.1:${new URL(browser.wsEndpoint()).port}`
      process.env.HUASHENG_PROFILE_DIR = profile
      const page = (await browser.pages())[0]!
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body:
        '<p>我的会员</p><p>' + script + '</p>' + editor + '<p>✓ 准备阶段（已完成）</p><p>✂️ 创建分镜（1/8 已完成）</p>' }) })
      await page.goto('https://www.huasheng.cn/')
      await page.evaluate('window.name = "huobao-huasheng:resume-login"')
      const checkpoints: string[] = []
      const result = await runHuashengBrowserJob({ jobId: 'resume-login', script,
        projectUrl: 'https://www.huasheng.cn/video/123456789', checkpoint: 'confirm_pending', signal: AbortSignal.timeout(10_000),
        onCheckpoint: async update => { checkpoints.push(update.checkpoint) } })
      assert.equal(page.url(), 'https://www.huasheng.cn/video/123456789')
      assert.equal(result.projectUrl, page.url())
      assert.deepEqual(checkpoints, ['submitted'])
    } finally {
      if (oldEndpoint === undefined) delete process.env.HUASHENG_CDP_URL; else process.env.HUASHENG_CDP_URL = oldEndpoint
      if (oldProfile === undefined) delete process.env.HUASHENG_PROFILE_DIR; else process.env.HUASHENG_PROFILE_DIR = oldProfile
      await browser.close()
      fs.rmSync(profile, { recursive: true, force: true })
    }
  })

test('a stale conversation is refreshed and the existing project reaches production without replaying requirements',
  { skip: !fs.existsSync(executablePath), timeout: 15_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.setRequestInterception(true)
      page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/huasheng/project_plan/confirm') {
          void request.respond({ status: 200, contentType: 'application/json', body: '{"code":0,"message":"OK"}' })
          return
        }
        void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html>
        <html><head><meta charset="utf-8"></head><body><header>我的会员</header><p>${script}</p>
        <p>视频成片需求</p><p>成片需求已完成！确认是否满足你的创作需求</p><button disabled>确认</button>
        <main><p>当前对话有正在进行的任务，本地内容可能不是最新的</p><button id="refresh">刷新对话</button></main>
        <script>
        window.actions = [];
        const content = document.querySelector('main');
        document.querySelector('#refresh').onclick = () => {
          window.actions.push('refresh');
          content.innerHTML = '<p>创作规划书 生成完成</p><p>分镜方案已生成</p><button id="plan">确认，开始制作</button>';
          document.querySelector('#plan').onclick = () => {
            window.actions.push('plan');
            content.innerHTML += '<section role="dialog"><div><span>总预估消耗</span><span>0</span></div><button id="confirm">确认并继续</button></section>';
            document.querySelector('#confirm').onclick = async () => {
              window.actions.push('confirm');
              await fetch('/api/huasheng/project_plan/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: 123456789 }) });
              content.innerHTML = '${editor}<p>✓ 准备阶段（已完成）</p><p>✂️ 创建分镜（1/8 已完成）</p>';
            };
          };
        };
        </script></body></html>` }) })
      await page.goto('https://www.huasheng.cn/video/123456789')
      const checkpoints: string[] = []
      const result = await driveHuashengPage(createHuashengPagePort(page, script), {
        jobId: 'stale-conversation', script, projectUrl: page.url(), checkpoint: 'requirements_pending',
        signal: new AbortController().signal, onCheckpoint: async update => { checkpoints.push(update.checkpoint) },
      }, { pollMs: 10, timeoutMs: 5000 })
      assert.equal(result.projectUrl, page.url())
      assert.deepEqual(await page.evaluate('window.actions'), ['refresh', 'plan', 'confirm'])
      assert.equal(checkpoints[0], 'requirements_pending', 'refresh retains the durable remote-action checkpoint')
      assert.equal(checkpoints.at(-1), 'submitted')
    } finally { await browser.close() }
  })

test('production inspection reads real export-dialog availability and never clicks download or publish',
  { skip: !fs.existsSync(executablePath), timeout: 15_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html>
        <html><head><meta charset="utf-8"></head><body><p>我的会员</p>${editor}<script>
        window.exported = 0; window.opened = 0;
        [...document.querySelectorAll('button')].find(el => el.textContent === '导出').onclick = () => {
          window.opened++;
          const dialog = document.createElement('section'); dialog.setAttribute('role', 'dialog');
          dialog.innerHTML = '<h2>导出发布</h2><button id="download">下载成片</button><button id="publish">发布B站</button>';
          document.body.append(dialog);
          document.querySelector('#download').onclick = document.querySelector('#publish').onclick = () => window.exported++;
        };
        </script></body></html>` }) })
      await page.goto('https://www.huasheng.cn/video/123456789')
      const port = createHuashengPagePort(page)
      const inspect = () => inspectHuashengPage(port, { projectUrl: page.url(), checkpoint: 'submitted', signal: AbortSignal.timeout(5000) }, { pollMs: 10 })
      assert.equal((await inspect()).status, 'completed')
      assert.equal(await page.evaluate('window.opened'), 1)
      assert.equal(await page.evaluate('window.exported'), 0)
      await page.$eval('#download', el => { (el as HTMLButtonElement).disabled = true })
      assert.equal((await inspect()).status, 'creating')
      assert.equal(await page.evaluate('window.exported'), 0)
      await page.$eval('#download', el => { (el as HTMLButtonElement).disabled = false; el.setAttribute('aria-disabled', 'true') })
      assert.equal((await inspect()).status, 'creating')
      await page.setContent('<p>我的会员</p><p>视频成片需求</p><p>成片需求已完成</p><p>算力引擎调度中，请稍等...</p>')
      assert.equal((await port.read()).queueVisible, false, 'a quoted scheduling message is not platform queue UI')
      await page.setContent('<p>我的会员</p><p>视频成片需求</p><p>成片需求已完成</p><div class="mx-auto mt-3 rounded-xl flex flex-col items-center"><span>算力引擎调度中，请稍等...</span></div>')
      assert.equal((await port.read()).queueVisible, true)
      assert.equal((await port.read()).productionQueued, false, 'planning queue alone is not video production')
    } finally { await browser.close() }
  })

test('a visible export button without a disabled attribute can remain unavailable while generation continues',
  { skip: !fs.existsSync(executablePath), timeout: 15_000 }, async () => {
    const browser = await puppeteer.launch({ executablePath, headless: true })
    try {
      const page = await browser.newPage()
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `
        <html><body><p>我的会员</p>${editor}<script>
        window.readyToExport = false; window.opened = 0; window.downloaded = 0;
        [...document.querySelectorAll('button')].find(el => el.textContent === '导出').onclick = () => {
          window.opened++;
          if (!window.readyToExport) return;
          const dialog = document.createElement('section'); dialog.setAttribute('role', 'dialog');
          dialog.innerHTML = '<h2>导出发布</h2><button id="download">下载成片</button>';
          document.body.append(dialog);
          document.querySelector('#download').onclick = () => window.downloaded++;
        };
        </script></body></html>` }) })
      await page.goto('https://www.huasheng.cn/video/123456789')
      const port = createHuashengPagePort(page)
      let time = 0
      const inspect = () => inspectHuashengPage(port,
        { projectUrl: page.url(), checkpoint: 'submitted', signal: AbortSignal.timeout(10_000) },
        { now: () => time, sleep: async ms => { time += ms }, pollMs: 1000, timeoutMs: 15_000 })
      assert.equal((await inspect()).status, 'creating')
      assert.equal(await page.evaluate('window.opened'), 2)
      await page.evaluate('window.readyToExport = true')
      assert.equal((await inspect()).status, 'completed')
      assert.equal(await page.evaluate('window.opened'), 3)
      assert.equal(await page.evaluate('window.downloaded'), 0)
    } finally { await browser.close() }
  })
