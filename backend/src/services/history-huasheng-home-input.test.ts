import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createHuashengPagePort } from './history-huasheng-browser.js'

const executablePath = process.env.HUASHENG_TEST_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
const testOptions = { skip: !existsSync(executablePath), timeout: 10_000 }
const script = '椰枣成熟后为什么特别甜？\n\n这段科普必须完整写入，数字 832、标点与换行都应保留。'

async function fixture(t: TestContext, body: string) {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ] })
  t.after(() => browser.close())
  const page = await browser.newPage(); page.setDefaultTimeout(2000)
  await page.setRequestInterception(true)
  page.on('request', request => { void request.abort('blockedbyclient').catch(() => {}) })
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    textarea,[contenteditable] { box-sizing: border-box; display: block; width: 500px; height: 140px; }
    button { display: block; padding: 8px; }
  </style></head><body><header>我的会员</header>${body}<script>
    window.inputEvents = []; window.clicks = 0;
    document.addEventListener('input', event => window.inputEvents.push(event.target.id));
    document.addEventListener('click', () => window.clicks++);
  </script></body></html>`)
  return { page, port: createHuashengPagePort(page) }
}

test('homepage input waits for delayed hydration and excludes the zero-height measurement textarea', testOptions, async t => {
  const { page, port } = await fixture(t, `<textarea id="measure" style="height:0;padding:0;border:0;min-height:0;overflow:hidden"></textarea>
    <button id="create" disabled>创建</button><script>
      setTimeout(() => {
        const editor = document.createElement('textarea'); editor.id = 'script'; editor.className = 'ant-input';
        editor.oninput = () => setTimeout(() => document.querySelector('#create').disabled = false, 150);
        document.body.prepend(editor);
      }, 150);
    </script>`)
  await port.fillScript(script)
  assert.equal(await page.$eval('#script', el => (el as HTMLTextAreaElement).value), script)
  assert.equal(await page.$eval('#measure', el => (el as HTMLTextAreaElement).value), '')
  assert.deepEqual(await page.evaluate('[...new Set(window.inputEvents)]'), ['script'])
  assert.equal(await page.evaluate('window.clicks'), 0)
})

test('hidden, readonly, disabled and aria-disabled fields never compete with the actual editor', testOptions, async t => {
  const { page, port } = await fixture(t, `<textarea id="readonly" readonly></textarea><textarea id="disabled" disabled></textarea>
    <textarea id="aria-readonly" aria-readonly="true"></textarea><textarea id="aria-disabled" aria-disabled="true"></textarea>
    <div aria-hidden="true"><textarea id="aria-hidden"></textarea></div>
    <div aria-disabled="true"><textarea id="disabled-parent"></textarea></div>
    <div inert><textarea id="inert"></textarea></div><textarea id="invisible" style="opacity:0"></textarea>
    <textarea id="script"></textarea><button>创建</button>`)
  await port.fillScript(script)
  assert.deepEqual(await page.evaluate('[...new Set(window.inputEvents)]'), ['script'])
  const values = await page.$$eval('textarea', fields => fields.map(field => ({ id: field.id, value: field.value })))
  assert.deepEqual(values.filter(field => field.value).map(field => field.id), ['script'])
})

test('an editor that starts readonly becomes usable only after hydration enables it', testOptions, async t => {
  const { page, port } = await fixture(t, `<textarea id="script" readonly>old</textarea><button id="create" disabled>创建</button>
    <script>
      const editor = document.querySelector('#script');
      editor.oninput = () => document.querySelector('#create').disabled = false;
      setTimeout(() => editor.readOnly = false, 150);
    </script>`)
  await port.fillScript(script)
  assert.equal(await page.$eval('#script', el => (el as HTMLTextAreaElement).value), script)
  assert.deepEqual(await page.evaluate('[...new Set(window.inputEvents)]'), ['script'])
})

test('two real editors remain ambiguous and neither receives text', testOptions, async t => {
  const { page, port } = await fixture(t, '<textarea id="one"></textarea><textarea id="two"></textarea><button>创建</button>')
  page.setDefaultTimeout(650)
  await assert.rejects(port.fillScript(script), /输入框不唯一或尚未加载/)
  assert.deepEqual(await page.evaluate('window.inputEvents'), [])
  assert.deepEqual(await page.$$eval('textarea', fields => fields.map(field => field.value)), ['', ''])
})

test('a delayed controlled-editor reset cannot be mistaken for a stable complete script', testOptions, async t => {
  const { page, port } = await fixture(t, `<textarea id="script"></textarea><button>创建</button><script>
    document.querySelector('#script').oninput = () => setTimeout(() => document.querySelector('#script').value = 'truncated', 120);
  </script>`)
  await assert.rejects(port.fillScript(script), /文稿.*不一致/)
  assert.equal(await page.evaluate('window.clicks'), 0)
})

test('contenteditable text is verified and creation must actually become enabled', testOptions, async t => {
  const { page, port } = await fixture(t, `<div id="script" contenteditable="true" role="textbox"></div>
    <button id="create" aria-disabled="true">创建</button><script>
      document.querySelector('#script').oninput = () => setTimeout(() => {
        document.querySelector('#create').removeAttribute('aria-disabled'); window.readyAt = performance.now();
      }, 450);
    </script>`)
  await port.fillScript(script)
  assert.equal(await page.$eval('#script', el => (el as HTMLElement).innerText), script)
  assert.ok(await page.evaluate('performance.now() >= window.readyAt'))
  assert.equal(await page.evaluate('window.clicks'), 0)
})

test('homepage waits for its associated character counter even when Create has no disabled attribute', testOptions, async t => {
  const { page, port } = await fixture(t, `<span class="ant-input-textarea-show-count">
    <textarea id="script" class="ant-input"></textarea>
    <span class="ant-input-suffix"><span class="ant-input-data-count">0 / 10000</span></span>
    </span><button>创建</button><script>
      const editor = document.querySelector('#script');
      editor.oninput = () => setTimeout(() => {
        document.querySelector('.ant-input-data-count').textContent = editor.value.length + ' / 10000';
        window.readyAt = performance.now();
      }, 450);
    </script>`)
  const text = script + '🔬'
  await port.fillScript(text)
  assert.equal(await page.$eval('.ant-input-data-count', el => el.textContent), `${text.length} / 10000`)
  assert.ok(await page.evaluate('performance.now() >= window.readyAt'))
  assert.equal(await page.evaluate('window.clicks'), 0)
})

test('a stale associated counter blocks creation despite unrelated matching counts elsewhere', testOptions, async t => {
  const { page, port } = await fixture(t, `<span class="ant-input-textarea-show-count">
    <textarea id="script" class="ant-input"></textarea>
    <span class="ant-input-suffix"><span class="ant-input-data-count">0 / 10000</span></span>
    </span><aside class="ant-input-data-count">${script.length} / 10000</aside><button>创建</button>`)
  page.setDefaultTimeout(650)
  await assert.rejects(port.fillScript(script), /创建按钮仍不可用/)
  assert.equal(await page.$eval('#script', el => (el as HTMLTextAreaElement).value), script)
  assert.equal(await page.evaluate('window.clicks'), 0)
})
