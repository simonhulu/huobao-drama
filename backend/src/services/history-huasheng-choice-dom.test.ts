import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createHuashengPagePort, driveHuashengPage, type HuashengCheckpoint } from './history-huasheng-browser.js'

const executablePath = process.env.HUASHENG_TEST_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
const projectUrl = 'https://www.huasheng.cn/video/123456789'
const script = '韩信率军进攻赵国，双方在井陉交战。这是当前项目已经保存的完整二创稿。'
const scheme = 'A - 素材剪辑成片'
const stableReplyMessage = '花生页面显示 A 方案回复，继续等待成片需求确认'
const confirmUrl = 'https://www.huasheng.cn/api/huasheng/project_plan/confirm'
const projectPid = new URL(projectUrl).pathname.split('/').at(-1)!
const quotaResponse = { code: 10008, message: '今天创建项目超量啦，可以使用fast模式继续创建' }
const editor = '<button>撤销</button><button>重做</button><button>导出</button><button>上一分镜</button><button>下一分镜</button><p>分镜01</p>'
const testOptions = { skip: !existsSync(executablePath), timeout: 20_000 }
type Click = { label: string; time: number; url: string }

async function fixture(t: TestContext, mode: 'pending' | 'retry' | 'acknowledged' | 'rollback' | 'requirements-retry' | 'requirements-acknowledged' | 'requirements-reload') {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ] })
  t.after(() => browser.close())
  const page = await browser.newPage()
  let time = 0
  const navigations: string[] = []
  const navigationTimes: number[] = []
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const navigation = request.isNavigationRequest() && request.frame() === page.mainFrame()
    if (navigation) {
      navigations.push(request.url())
      navigationTimes.push(time)
    }
    if (!navigation && request.url() === confirmUrl && request.method() === 'POST') {
      void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, message: 'OK' }) }).catch(() => {})
      return
    }
    // Even an accidental navigation or subresource request cannot reach Huasheng.
    if (!navigation || request.url() !== projectUrl) {
      void request.abort('blockedbyclient').catch(() => {})
      return
    }
    void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html>
      <html><head><meta charset="utf-8"></head><body>
      <header>我的会员</header><p>${script}</p>
      <aside><div class="self-end">A - 素材剪辑成片</div><div class="self-end">确认</div><p>文稿引用：A - 素材剪辑成片，确认</p></aside>
      <div id="question" class="flex flex-col gap-3 mb-3">
        <div>请选择制作方案：</div>
        <div class="self-stretch flex flex-col items-start gap-2">
          <button id="scheme-a">A - 素材剪辑成片</button>
          <button id="scheme-b">B - 素材混合MG动画</button>
        </div>
      </div>
      <main id="stage"><p>正在生成成片需求</p></main>
      <script>
        window.testClock = ${time};
        window.actions = JSON.parse(sessionStorage.getItem('choice-actions') || '[]');
        window.schemeClicks = 0;
        window.requirementsClicks = Number(sessionStorage.getItem('requirements-clicks') || 0);
        window.optimisticAt = null;
        window.rolledBack = false;
        const mode = ${JSON.stringify(mode)};
        const question = document.querySelector('#question');
        const stage = document.querySelector('#stage');
        document.addEventListener('click', event => {
          const button = event.target.closest('button');
          if (button) {
            window.actions.push({ label: button.textContent.trim(), time: window.testClock, url: location.href });
            sessionStorage.setItem('choice-actions', JSON.stringify(window.actions));
          }
        }, true);
        window.acknowledgeScheme = () => {
          question.querySelectorAll('button').forEach(button => button.disabled = true);
          if (!question.querySelector('.self-end')) {
            const reply = document.createElement('div');
            reply.className = 'self-end';
            reply.innerHTML = '<span>A - 素材剪辑成片</span>';
            question.append(reply);
          }
        };
        window.advanceClock = elapsed => {
          window.testClock = elapsed;
          if (mode === 'rollback' && window.optimisticAt !== null && !window.rolledBack && elapsed - window.optimisticAt >= 2000) {
            question.querySelector('.self-end').remove();
            question.querySelectorAll('button').forEach(button => button.disabled = false);
            window.rolledBack = true;
          }
        };
        window.acknowledgeRequirements = () => {
          const card = document.querySelector('#requirements-card');
          card.querySelectorAll('button').forEach(button => button.disabled = true);
          if (!card.querySelector('.self-end')) {
            const reply = document.createElement('div');
            reply.className = 'self-end';
            reply.innerHTML = '<span>确认</span>';
            card.append(reply);
          }
        };
        window.showPlan = () => {
          const planStage = document.querySelector('#plan-stage');
          planStage.innerHTML = '<p>创作规划书 生成完成</p><p>分镜方案已生成</p><button id="plan">确认，开始制作</button>';
          document.querySelector('#plan').onclick = () => {
            planStage.innerHTML += '<section role="dialog"><div><span>总预估消耗</span><span>0</span></div><button id="confirm">确认并继续</button></section>';
            document.querySelector('#confirm').onclick = async () => {
              await fetch(${JSON.stringify(confirmUrl)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: ${JSON.stringify(projectPid)} }) });
              stage.innerHTML = ${JSON.stringify(editor)};
            };
          };
        };
        window.showRequirements = () => {
          stage.innerHTML = '<div id="requirements-card" class="flex flex-col gap-3 mb-3"><p>视频成片需求</p><p>成片需求已完成！确认是否满足你的创作需求</p><div class="self-stretch flex flex-col items-start gap-2"><button id="requirements">确认</button><button id="requirements-edit">需要修改</button></div></div><div id="plan-stage"><p>正在生成创作规划书</p></div>';
          document.querySelector('#requirements').onclick = () => {
            window.requirementsClicks++;
            sessionStorage.setItem('requirements-clicks', String(window.requirementsClicks));
            if (mode === 'requirements-retry' && window.requirementsClicks < 2) return;
            window.acknowledgeRequirements();
            // This reply exists only in this document. The locally served
            // reload starts with the unanswered card again, like the server.
            if (mode === 'requirements-reload' && window.requirementsClicks === 1) return;
            window.showPlan();
          };
        };
        document.querySelector('#scheme-a').onclick = () => {
          window.schemeClicks++;
          if (mode === 'rollback' && window.schemeClicks === 1) {
            window.acknowledgeScheme();
            window.optimisticAt = window.testClock;
            return;
          }
          if (!['retry', 'rollback'].includes(mode) || window.schemeClicks < 2) return;
          window.acknowledgeScheme();
          window.showRequirements();
        };
        if (mode === 'acknowledged') window.acknowledgeScheme();
        if (mode.startsWith('requirements-')) {
          window.acknowledgeScheme();
          window.showRequirements();
          if (mode === 'requirements-acknowledged') window.acknowledgeRequirements();
        }
      </script></body></html>` }).catch(() => {})
  })
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' })
  const observations: Array<{ time: number; navigationCount: number; pending: boolean; reply: boolean; requirements: boolean; requirementsPending: boolean; requirementsReply: boolean; planReady: boolean }> = []
  const domPort = createHuashengPagePort(page, script)
  const port = {
    ...domPort,
    read: async () => {
      const state = await domPort.read()
      observations.push({ time, navigationCount: navigations.length, pending: state.schemeChoicePending === true, reply: state.schemeReplyPresent === true,
        requirements: state.requirementsReady, requirementsPending: state.requirementsChoicePending === true,
        requirementsReply: state.requirementsReplyPresent === true, planReady: state.planReady })
      return state
    },
  }
  let requirementsReleased = false
  let planReleased = false
  const updates: Array<HuashengCheckpoint & { time: number; replyPresent: boolean; requirementsReady: boolean }> = []
  const run = () => driveHuashengPage(port, {
    jobId: 'local-choice-dom', script, projectUrl, checkpoint: mode.startsWith('requirements-') ? 'requirements_pending' : 'scheme_pending',
    signal: AbortSignal.timeout(15_000),
    onCheckpoint: async update => {
      const observed = await port.read()
      updates.push({ ...update, time, replyPresent: observed.schemeReplyPresent === true, requirementsReady: observed.requirementsReady })
      if (update.checkpoint === 'submitted') assert.equal(observed.editorReady, true, 'submission requires the editor, not a local click')
    },
  }, {
    now: () => time, pollMs: 1000, timeoutMs: 90_000,
    sleep: async (ms, signal) => {
      signal.throwIfAborted()
      time += ms
      await page.evaluate(elapsed => { Reflect.get(window, 'advanceClock')(elapsed) }, time)
      if (mode === 'acknowledged' && time >= 40_000 && !requirementsReleased) {
        requirementsReleased = true
        await page.evaluate('window.showRequirements()')
      }
      if (mode === 'requirements-acknowledged' && time >= 40_000 && !planReleased) {
        planReleased = true
        await page.evaluate('window.showPlan()')
      }
    },
  })
  const clicks = () => page.evaluate('window.actions') as Promise<Click[]>
  const assertOriginalProject = (expectedNavigations = 1) => {
    assert.equal(page.url(), projectUrl)
    assert.deepEqual(navigations, Array.from({ length: expectedNavigations }, () => projectUrl),
      'only the original project is opened, with exactly the expected reloads and no recreation or switching')
    assert.deepEqual(pageErrors, [])
    assert.ok(updates.every(update => update.projectUrl === projectUrl))
  }
  return { page, port, run, clicks, updates, observations, navigationTimes, assertOriginalProject }
}

test('real choice-card DOM distinguishes unanswered A/B buttons from its own exact user reply', testOptions, async t => {
  const h = await fixture(t, 'pending')
  const pending = await h.port.read()
  assert.equal(pending.scriptPresent, true)
  assert.equal(pending.schemeChoicePending, true)
  assert.equal(pending.schemeReplyPresent, false, 'an exact reply elsewhere and a quote in prose are not this card acknowledgement')
  assert.ok(pending.buttons.includes(scheme))
  assert.ok(pending.buttons.includes('B - 素材混合MG动画'))

  await h.page.evaluate('window.acknowledgeScheme()')
  const replied = await h.port.read()
  assert.equal(replied.schemeChoicePending, false)
  assert.equal(replied.schemeReplyPresent, true)
  assert.equal(replied.requirementsReady, false)
  assert.equal(replied.buttons.includes(scheme), false)
  assert.equal(replied.buttons.includes('B - 素材混合MG动画'), false)
  assert.deepEqual(await h.clicks(), [])
  h.assertOriginalProject()
})

test('real DOM recovery retries an ineffective A click after 15 seconds and completes only the original project', testOptions, async t => {
  const h = await fixture(t, 'retry')
  assert.deepEqual(await h.run(), { projectUrl })
  const clicks = await h.clicks()
  assert.deepEqual(clicks.filter(click => click.label === scheme).map(click => click.time), [15_000, 30_000])
  assert.deepEqual(clicks.map(click => click.label), [scheme, scheme, '确认', '确认，开始制作', '确认并继续'])
  assert.ok(clicks.every(click => click.url === projectUrl))
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  assert.ok(h.updates.filter(update => !update.replyPresent).every(update =>
    update.message !== stableReplyMessage && !/已选择|对话已确认|已接受/.test(update.message)), 'unacknowledged clicks must remain pending')
  h.assertOriginalProject()
})

test('an acknowledged choice is not sent again while the real requirements DOM takes 40 seconds to appear', testOptions, async t => {
  const h = await fixture(t, 'acknowledged')
  const initial = await h.port.read()
  assert.equal(initial.schemeReplyPresent, true)
  assert.equal(initial.requirementsReady, false)
  assert.deepEqual(await h.run(), { projectUrl })
  const clicks = await h.clicks()
  assert.deepEqual(clicks.map(click => click.label), ['确认', '确认，开始制作', '确认并继续'])
  assert.ok(clicks.every(click => click.time >= 40_000), 'requirements generation is awaited without replaying A')
  const replyReports = h.updates.filter(update => update.message === stableReplyMessage)
  assert.equal(replyReports.length, 1, 'a stable reply is reported once while awaiting requirements')
  assert.ok(replyReports.every(update => update.replyPresent && !update.requirementsReady && update.time >= 5_000),
    'the reply must remain visible for at least five seconds before reporting it')
  assert.ok(h.updates.every(update => !/对话已确认|已接受/.test(update.message)),
    'a visible reply is not confirmation that the platform accepted production')
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  h.assertOriginalProject()
})

test('optimistic scheme reply rolling back to pending does not permanently suppress retries or count as acceptance', testOptions, async t => {
  const h = await fixture(t, 'rollback')
  let result
  let failure
  try { result = await h.run() } catch (error) { failure = error }
  const clicks = await h.clicks()
  const schemeClicks = clicks.filter(click => click.label === scheme)
  const transientReply = h.observations.find(state => state.reply && !state.requirements)
  assert.ok(transientReply, 'the real DOM adapter must observe the optimistic reply before it disappears')
  assert.ok(h.observations.some(state => state.time > transientReply.time && state.pending && !state.reply && !state.requirements), 'the same question returns to unanswered A/B controls')
  assert.equal(schemeClicks.length, 2, `the rolled-back choice must be retried rather than remaining acknowledged: ${failure || ''}`)
  assert.equal(failure, undefined)
  assert.deepEqual(result, { projectUrl })
  assert.ok(schemeClicks[1]!.time - schemeClicks[0]!.time >= 15_000, 'rollback recovery still respects the retry interval')
  assert.deepEqual(clicks.map(click => click.label), [scheme, scheme, '确认', '确认，开始制作', '确认并继续'])
  const beforeRetry = h.updates.filter(update => update.time >= schemeClicks[0]!.time && update.time < schemeClicks[1]!.time)
  assert.ok(beforeRetry.some(update => update.message === '花生页面未保留方案回复，正在重新核验选择状态'),
    'the vanished reply is explicitly recognized before retrying')
  assert.ok(beforeRetry.every(update => update.message !== stableReplyMessage && !/已选择|对话已确认|已接受/.test(update.message)),
    'a transient optimistic reply alone cannot be reported as stable or accepted')
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  h.assertOriginalProject()
})

test('real requirements-card DOM retries an ineffective confirmation after 15 seconds only in the original project', testOptions, async t => {
  const h = await fixture(t, 'requirements-retry')
  const initial = await h.port.read()
  assert.equal(initial.requirementsReady, true)
  assert.equal(initial.requirementsChoicePending, true)
  assert.equal(initial.requirementsReplyPresent, false, 'an exact confirmation outside the requirements card is not its reply')
  assert.ok(initial.buttons.includes('确认'))
  assert.ok(initial.buttons.includes('需要修改'))
  assert.equal(initial.planReady, false)

  let result
  let failure
  try { result = await h.run() } catch (error) { failure = error }
  const clicks = await h.clicks()
  const confirmations = clicks.filter(click => click.label === '确认')
  assert.equal(confirmations.length, 2, `the unanswered requirements card must be retried: ${failure || ''}`)
  assert.equal(failure, undefined)
  assert.deepEqual(result, { projectUrl })
  assert.deepEqual(confirmations.map(click => click.time), [15_000, 30_000])
  assert.ok(h.observations.some(state => state.time > 15_000 && state.time < 30_000
    && state.requirementsPending && !state.requirementsReply && !state.planReady),
    'the ineffective click leaves the actual card unanswered while the driver waits to retry')
  assert.ok(h.observations.some(state => state.requirementsReply && !state.requirementsPending && state.planReady))
  assert.deepEqual(clicks.map(click => click.label), ['确认', '确认', '确认，开始制作', '确认并继续'])
  assert.ok(clicks.every(click => click.url === projectUrl))
  assert.ok(h.updates.filter(update => update.time < 30_000).every(update => update.checkpoint === 'requirements_pending'))
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  h.assertOriginalProject()
})

test('an answered requirements card is not confirmed again while the real plan DOM takes 40 seconds to appear', testOptions, async t => {
  const h = await fixture(t, 'requirements-acknowledged')
  const initial = await h.port.read()
  assert.equal(initial.requirementsReady, true)
  assert.equal(initial.requirementsChoicePending, false)
  assert.equal(initial.requirementsReplyPresent, true)
  assert.equal(initial.planReady, false)
  assert.equal(initial.buttons.includes('确认'), false)
  assert.equal(initial.buttons.includes('需要修改'), false)

  assert.deepEqual(await h.run(), { projectUrl })
  const clicks = await h.clicks()
  assert.deepEqual(clicks.map(click => click.label), ['确认，开始制作', '确认并继续'])
  assert.ok(clicks.every(click => click.time >= 40_000 && click.url === projectUrl),
    'planning is awaited without replaying requirements confirmation or scheme selection')
  const awaitingPlan = h.observations.filter(state => state.time < 40_000)
  assert.ok(awaitingPlan.some(state => state.time >= 30_000), 'waiting spans multiple retry intervals')
  assert.ok(awaitingPlan.every(state => state.requirementsReply && !state.requirementsPending && !state.planReady))
  assert.ok(h.updates.filter(update => update.time < 40_000).every(update => update.checkpoint === 'requirements_pending'))
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  h.assertOriginalProject()
})

test('a persistent optimistic requirements reply is cleared by reloading the original project before retrying, with one final confirmation', testOptions, async t => {
  const h = await fixture(t, 'requirements-reload')
  const initial = await h.port.read()
  assert.equal(initial.requirementsChoicePending, true)
  assert.equal(initial.requirementsReplyPresent, false)

  let result
  let failure
  try { result = await h.run() } catch (error) { failure = error }
  assert.equal(h.navigationTimes.length, 2, `the stale optimistic reply requires one actual project reload: ${failure || ''}`)
  assert.equal(await h.page.evaluate("performance.getEntriesByType('navigation')[0].type"), 'reload',
    'the browser actually reloaded the document; a synthetic state change is insufficient')
  assert.equal(failure, undefined)
  assert.deepEqual(result, { projectUrl })

  const clicks = await h.clicks()
  const confirmations = clicks.filter(click => click.label === '确认')
  assert.equal(confirmations.length, 2, 'one optimistic confirmation and one retry after reload')
  const reloadedAt = h.navigationTimes[1]!
  assert.ok(reloadedAt - confirmations[0]!.time >= 45_000, 'the driver waits for the next stage before reloading')
  const staleReply = h.observations.filter(state => state.navigationCount === 1 && state.time > confirmations[0]!.time)
  assert.ok(staleReply.some(state => state.time - confirmations[0]!.time >= 40_000),
    'the optimistic reply persists in the original document beyond a short rollback window')
  assert.ok(staleReply.every(state => state.requirementsReply && !state.requirementsPending && !state.planReady))
  assert.ok(h.observations.some(state => state.navigationCount === 2 && state.requirementsPending
    && !state.requirementsReply && !state.planReady), 'the reloaded document exposes the unanswered requirements card')
  assert.ok(confirmations[1]!.time >= reloadedAt && confirmations[1]!.time - confirmations[0]!.time >= 15_000)
  assert.deepEqual(clicks.map(click => click.label), ['确认', '确认', '确认，开始制作', '确认并继续'])
  assert.equal(clicks.filter(click => click.label === '确认并继续').length, 1, 'final production confirmation is never replayed')
  assert.ok(clicks.every(click => click.url === projectUrl))
  assert.ok(h.updates.filter(update => update.time < confirmations[1]!.time).every(update => update.checkpoint === 'requirements_pending'))
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  h.assertOriginalProject(2)
})

test('quota detection requires a visible exhaustion notice and fast-mode button, not quoted script text', testOptions, async t => {
  const h = await fixture(t, 'pending')
  assert.equal((await h.port.read()).standardQuotaExhausted, false)
  await h.page.evaluate(() => {
    document.querySelector('#stage')!.innerHTML = '<blockquote><p>今日标准模式额度已用完</p><p>快速模式继续 预估花生米 219</p></blockquote>'
  })
  assert.equal((await h.port.read()).standardQuotaExhausted, false, 'quoting both phrases without an actionable button is not a quota notice')
  await h.page.evaluate(() => {
    document.querySelector('#stage')!.innerHTML = '<div id="quota-card" hidden><span>今日标准模式额度已用完</span><button id="fast-mode"><span>快速模式继续</span> <span>预估花生米 219</span></button></div>'
  })
  assert.equal((await h.port.read()).standardQuotaExhausted, false, 'an unrendered quota card is not current page evidence')
  await h.page.evaluate("document.querySelector('#quota-card').hidden = false")
  assert.equal((await h.port.read()).standardQuotaExhausted, true)
  await h.page.evaluate("document.querySelector('#fast-mode').hidden = true")
  assert.equal((await h.port.read()).standardQuotaExhausted, false, 'the fast-mode button must also be visible')
  assert.deepEqual(await h.clicks(), [], 'quota inspection never clicks the paid continuation')
  h.assertOriginalProject()
})

async function confirmationFixture(t: TestContext, mode: 'quota' | 'accepted' | 'other-pid') {
  const browser = await puppeteer.launch({ executablePath, headless: true, args: [
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ] })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const navigations: string[] = []
  const requests: Array<{ pid: string; method: string; url: string }> = []
  const responses: Array<{ pid: string; status: number }> = []
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(String(error)))
  page.on('response', response => {
    if (response.url() === confirmUrl) {
      responses.push({ pid: JSON.parse(response.request().postData() || '{}').pid, status: response.status() })
    }
  })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const navigation = request.isNavigationRequest() && request.frame() === page.mainFrame()
    if (navigation) navigations.push(request.url())
    if (!navigation && request.url() === confirmUrl && request.method() === 'POST') {
      requests.push({ pid: JSON.parse(request.postData() || '{}').pid, method: request.method(), url: request.url() })
      void request.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify(mode === 'accepted' ? { code: 0, message: 'OK' } : quotaResponse) }).catch(() => {})
      return
    }
    if (!navigation || request.url() !== projectUrl) {
      void request.abort('blockedbyclient').catch(() => {})
      return
    }
    void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html>
      <html><head><meta charset="utf-8"></head><body><header>我的会员</header><p>${script}</p>
      <main id="stage"><p>创作规划书 生成完成</p><p>分镜方案已生成</p>
        <section role="dialog"><div><span>总预估消耗</span><span>0</span></div><button id="confirm">确认并继续</button></section>
        <button id="fast">快速模式继续 预估花生米 219</button>
      </main>
      <script>
        window.actions = [];
        window.testClock = 0;
        document.addEventListener('click', event => {
          const button = event.target.closest('button');
          if (button) window.actions.push({ label: button.textContent.trim(), time: window.testClock, url: location.href });
        }, true);
        document.querySelector('#confirm').onclick = async () => {
          const response = await fetch(${JSON.stringify(confirmUrl)}, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pid: ${JSON.stringify(mode === 'other-pid' ? '987654321' : projectPid)} })
          });
          window.receivedBody = await response.json();
        };
        window.showQueue = () => {
          document.querySelector('#stage').innerHTML = '<div class="mx-auto mt-3 rounded-xl flex flex-col items-center"><span>算力引擎调度中，请稍等...</span></div>';
        };
      </script></body></html>` }).catch(() => {})
  })
  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' })
  let time = 0
  const receipts: Array<{ label: string; result: unknown; time: number }> = []
  const updates: Array<HuashengCheckpoint & { time: number }> = []
  const domPort = createHuashengPagePort(page, script)
  const port = {
    ...domPort,
    click: async (label: string) => {
      const result = await domPort.click(label)
      receipts.push({ label, result, time })
      return result
    },
  }
  let queueShown = false
  const run = () => driveHuashengPage(port, {
    jobId: 'local-confirm-response', script, projectUrl, checkpoint: 'plan_opened',
    signal: AbortSignal.timeout(15_000),
    onCheckpoint: async update => {
      updates.push({ ...update, time })
      if (update.checkpoint === 'submitted') {
        assert.equal((await port.read()).queueVisible, true, 'only the rendered platform queue permits submission')
      }
    },
  }, {
    now: () => time, pollMs: 1000, timeoutMs: 10_000,
    sleep: async (ms, signal) => {
      signal.throwIfAborted()
      time += ms
      await page.evaluate(elapsed => { Reflect.set(window, 'testClock', elapsed) }, time)
      if (mode === 'accepted' && time >= 3000 && !queueShown) {
        assert.deepEqual(receipts.map(receipt => receipt.result), [{ code: 0, message: 'OK' }])
        assert.ok(updates.every(update => update.checkpoint !== 'submitted'), 'HTTP 200/code 0 alone cannot report submission')
        assert.equal((await port.read()).queueVisible, false)
        queueShown = true
        await page.evaluate('window.showQueue()')
      }
    },
  })
  const assertSingleStandardConfirmation = async () => {
    assert.deepEqual(await page.evaluate('window.actions'), [{ label: '确认并继续', time: 0, url: projectUrl }],
      'only one standard confirmation is clicked; fast mode is never selected')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.method, 'POST')
    assert.equal(requests[0]!.url, confirmUrl)
    assert.deepEqual(responses, [{ pid: requests[0]!.pid, status: 200 }])
    assert.deepEqual(navigations, [projectUrl])
    assert.equal(page.url(), projectUrl)
    assert.deepEqual(pageErrors, [])
    assert.ok(updates.every(update => update.projectUrl === projectUrl))
  }
  return { page, port, run, receipts, updates, requests, assertSingleStandardConfirmation }
}

test('HTTP 200/code 10008 final confirmation preserves the project without submission, repeat confirmation, or fast mode', testOptions, async t => {
  const h = await confirmationFixture(t, 'quota')
  assert.equal((await h.port.read()).standardQuotaExhausted, false, 'this case must be detected from the response, without a quota DOM notice')
  await assert.rejects(h.run(), { name: 'HuashengBrowserError', code: 'manual_review', message: /超量|额度|10008/ })
  assert.deepEqual(h.receipts.map(receipt => receipt.result), [quotaResponse])
  assert.equal(h.updates.at(-1)?.checkpoint, 'quota_waiting')
  assert.ok(h.updates.every(update => update.checkpoint !== 'submitted'))
  assert.equal(h.requests[0]!.pid, projectPid)
  await h.assertSingleStandardConfirmation()
})

test('HTTP 200/code 0 final confirmation waits for the actual queue card before marking submitted', testOptions, async t => {
  const h = await confirmationFixture(t, 'accepted')
  assert.deepEqual(await h.run(), { projectUrl })
  assert.deepEqual(h.receipts, [{ label: '确认并继续', result: { code: 0, message: 'OK' }, time: 0 }])
  assert.ok(h.updates.filter(update => update.time < 3000).every(update => update.checkpoint !== 'submitted'))
  assert.equal(h.updates.at(-1)?.checkpoint, 'submitted')
  assert.equal(h.updates.at(-1)?.productionStatus, 'queued')
  assert.ok(h.updates.at(-1)!.time >= 3000)
  assert.equal(h.requests[0]!.pid, projectPid)
  await h.assertSingleStandardConfirmation()
})

test('a confirmation response for an unrelated pid is ignored and times out without becoming this project receipt', testOptions, async t => {
  const h = await confirmationFixture(t, 'other-pid')
  await assert.rejects(h.run(), { name: 'HuashengBrowserError', code: 'timeout' })
  assert.deepEqual(h.receipts, [{ label: '确认并继续', result: undefined, time: 0 }])
  assert.equal(h.requests[0]!.pid, '987654321')
  assert.ok(h.updates.every(update => !['submitted', 'quota_waiting'].includes(update.checkpoint)),
    'another project quota rejection is not evidence about the current project')
  await h.assertSingleStandardConfirmation()
})

test('the editor with playback and storyboard totals is recognized without navigation buttons, but prose and export alone are not', testOptions, async t => {
  const h = await fixture(t, 'pending')
  const totals = '<div><span>分镜总数</span><span>40</span></div><div><span>总时长</span><span>00:04:58</span></div><p>分镜01</p>'
  for (const controls of ['<p>撤销 重做 导出 播放</p>', '<p>撤销 重做 播放</p><button>导出</button>']) {
    await h.page.evaluate(markup => { document.querySelector('#stage')!.innerHTML = markup }, controls + totals)
    const state = await h.port.read()
    assert.equal(state.editorReady, false, 'editor prose and an export button do not provide the complete control surface')
    assert.equal(state.productionStarted, false)
  }
  await h.page.evaluate(markup => { document.querySelector('#stage')!.innerHTML = markup },
    '<button>撤销</button><button>重做</button><button>导出</button><button>播放</button>' + totals)
  const editorState = await h.port.read()
  assert.equal(editorState.buttons.includes('上一分镜'), false)
  assert.equal(editorState.buttons.includes('下一分镜'), false)
  assert.equal(editorState.editorReady, true)
  assert.equal(editorState.productionStarted, true)
  assert.deepEqual(await h.clicks(), [])
  h.assertOriginalProject()
})
