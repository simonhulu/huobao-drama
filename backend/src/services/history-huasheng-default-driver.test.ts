import test from 'node:test'
import assert from 'node:assert/strict'
import puppeteer, { type Browser } from 'puppeteer-core'
import { createHistoryHuashengDriver, type HuashengBrowserDriver } from './history-huasheng.js'
import { resolveHuashengBrowserConfig } from './history-huasheng-browser.js'
import { HuashengAccountsService } from './huasheng-accounts.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

type ProductionInput = Parameters<HuashengBrowserDriver['runHuashengBrowserJob']>[0]
const transientPreparation = () => Object.assign(new Error('dedicated browser temporarily unavailable'), { code:'browser_unavailable', retryable:true })
const browserConfig = { endpoint:'http://127.0.0.1:9250', profile:'/test/history-profile', expectedUid:'1001' }
function productionInput(overrides: Partial<ProductionInput> = {}): ProductionInput {
  return {jobId:176,script:'已冻结的原任务文稿',projectUrl:null,checkpoint:null,huashengAccountName:'history_huasheng_legacy',
    signal:new AbortController().signal,onCheckpoint:async()=>{},...overrides}
}

test('one transient pre-creation account preparation retries before invoking the same production task once',async()=>{
  const requests: Array<{name:string;signal?:AbortSignal}> = []
  const input=productionInput()
  const accounts={readyBrowserConfig:async(name:string,options?:{signal?:AbortSignal})=>{
    requests.push({name,signal:options?.signal})
    if(requests.length===1)throw transientPreparation()
    return browserConfig
  }} as unknown as HuashengAccountsService
  let pageCalls=0
  const driver=createHistoryHuashengDriver(accounts,{runBrowserJob:async actual=>{
    pageCalls++;assert.equal(requests.length,2);assert.equal(actual.jobId,input.jobId)
    assert.equal(actual.script,input.script)
    assert.equal(actual.browserConfig,browserConfig)
    return {projectUrl:'https://www.huasheng.cn/video/123'}
  }})
  assert.deepEqual(await driver.runHuashengBrowserJob(input),{projectUrl:'https://www.huasheng.cn/video/123'})
  assert.equal(pageCalls,1)
  assert.ok(requests.every(request=>request.name===input.huashengAccountName && request.signal===input.signal))
})

test('a second preparation failure exhausts the only retry without invoking production',async()=>{
  let requests=0
  const failure=transientPreparation()
  const accounts={readyBrowserConfig:async()=>{requests++;throw failure}} as unknown as HuashengAccountsService
  const driver=createHistoryHuashengDriver(accounts,{runBrowserJob:async()=>assert.fail('preparation never succeeded')})
  await assert.rejects(driver.runHuashengBrowserJob(productionInput()),error=>error===failure)
  assert.equal(requests,2)
})

test('identity errors, expired login and ambiguous timeouts cannot authorize a preparation retry',async()=>{
  for(const failure of [Object.assign(new Error('identity mismatch'),{code:'manual_review',retryable:true}),
    Object.assign(new Error('login expired'),{code:'login_required',retryable:true}),
    Object.assign(new Error('unknown timeout'),{code:'browser_unavailable'}),
    Object.assign(new Error('unknown timeout'),{code:'timeout',retryable:true}),new Error('connection timed out')]) {
    let requests=0
    const accounts={readyBrowserConfig:async()=>{requests++;throw failure}} as unknown as HuashengAccountsService
    const driver=createHistoryHuashengDriver(accounts,{runBrowserJob:async()=>assert.fail('unsafe account')})
    await assert.rejects(driver.runHuashengBrowserJob(productionInput()),error=>error===failure)
    assert.equal(requests,1)
  }
})

test('existing project and dispatched checkpoints never enter the pre-creation retry',async()=>{
  for(const patch of [{checkpoint:'create_pending'}, {checkpoint:'confirm_pending'}, {checkpoint:'submitted'},
    {checkpoint:'scheme_pending'}, {projectUrl:'https://www.huasheng.cn/video/123'}]) {
    let requests=0
    const failure=transientPreparation()
    const accounts={readyBrowserConfig:async()=>{requests++;throw failure}} as unknown as HuashengAccountsService
    const driver=createHistoryHuashengDriver(accounts,{runBrowserJob:async()=>assert.fail('original operation remains untouched')})
    await assert.rejects(driver.runHuashengBrowserJob(productionInput(patch)),error=>error===failure)
    assert.equal(requests,1)
  }
})

test('cancellation during backoff or successful preparation stops before another attempt or page operation',async()=>{
  for(const duringBackoff of [true,false]) {
    let requests=0
    const controller=new AbortController()
    const accounts={readyBrowserConfig:async()=>{
      requests++
      if(duringBackoff){setTimeout(()=>controller.abort(),10);throw transientPreparation()}
      controller.abort();return browserConfig
    }} as unknown as HuashengAccountsService
    const driver=createHistoryHuashengDriver(accounts,{runBrowserJob:async()=>assert.fail('canceled production must not start')})
    await assert.rejects(driver.runHuashengBrowserJob(productionInput({signal:controller.signal})),{name:'AbortError'})
    assert.equal(requests,1)
  }
})

test('a failure after a create intention is saved never repeats the production function',async()=>{
  let requests=0,pageCalls=0,checkpoint:string|null=null
  const failure=transientPreparation()
  const accounts={readyBrowserConfig:async()=>{requests++;return browserConfig}} as unknown as HuashengAccountsService
  const driver=createHistoryHuashengDriver(accounts,{runBrowserJob:async input=>{
    pageCalls++;await input.onCheckpoint({checkpoint:'create_pending',message:'已保存创建意图'});throw failure
  }})
  await assert.rejects(driver.runHuashengBrowserJob(productionInput({onCheckpoint:async update=>{checkpoint=update.checkpoint}})),error=>error===failure)
  assert.equal(requests,1);assert.equal(pageCalls,1);assert.equal(checkpoint,'create_pending')
})

test('default production inspector reads HTTP APIs and cookies without opening or inspecting project pages', async t => {
  const config = resolveHuashengBrowserConfig()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-driver-account-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const accounts = new HuashengAccountsService({ scope: 'history', stateRoot: root, legacyConfig: config,
    driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: '1001', displayName: '历史用户' } }) })
  const calls: string[] = []
  let connections = 0
  const browser = {
    target: () => ({ createCDPSession: async () => ({
      send: async () => ({ arguments: [`--user-data-dir=${config.profile}`] }),
      detach: async () => {},
    }) }),
    defaultBrowserContext: () => ({ cookies: async () => [
      { name: 'SESSDATA', value: 'test-login', domain: '.huasheng.cn' },
      { name: 'unrelated', value: 'private', domain: '.example.com' },
    ] }),
    userAgent: async () => 'test-browser',
    disconnect: async () => {},
    newPage: async () => assert.fail('status checks cannot create a browser page'),
    pages: async () => assert.fail('status checks cannot inspect existing pages'),
    targets: () => assert.fail('status checks cannot inspect project targets'),
  } as unknown as Browser
  t.mock.method(puppeteer, 'connect', async () => { connections++; return browser })
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const request = new URL(String(url))
    calls.push(request.pathname)
    assert.equal(init?.method, 'GET')
    if (request.pathname === '/x/web-interface/nav') return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1001, uname: '历史用户' } }))
    assert.deepEqual([...request.searchParams], [['pid', '123']])
    assert.equal(new Headers(init?.headers).get('Cookie'), 'SESSDATA=test-login')
    const data = { project: { pid: 123, state: 0, progress: 100, stage: 2047, project_stage: 3,
      loading_status: 1, wait_time: 0, is_agent_sandbox: true,
      tts_running: false, voice_running: false, motion_running: false, composite_running: false }, clips: [{ state: 1 }] }
    return new Response(JSON.stringify(request.pathname === '/api/innovideo/project/info' ? data : { code: 0, data }))
  })
  const driver = createHistoryHuashengDriver(accounts)
  for (let i = 0; i < 2; i++) {
    const observation = await driver.inspectHuashengProject!({ projectUrl: 'https://www.huasheng.cn/video/123', signal: new AbortController().signal })
    assert.equal(observation.status, 'completed')
  }
  assert.ok(connections >= 2, 'managed operations revalidate the original browser identity even when credentials were cached')
  assert.deepEqual(calls.filter(call => call !== '/x/web-interface/nav'), ['/api/innovideo/project/info', '/api/v2/innovideo/project/info', '/api/innovideo/project/info', '/api/v2/innovideo/project/info'])
})
