import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const baseUrl = process.env.SCIENCE_UI_TEST_URL || 'http://127.0.0.1:3013'
const BASE = '/api/v1/science-pop/workflow'
const account = (name, label) => ({ accountName: name, label, status: 'ready', message: '已登录', isDefault: true })
const makeJob = (id, title) => ({ id, title, sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', createdAt: '2026-10-28T02:00:00.000Z', updatedAt: '2026-10-28T02:01:00.000Z', status: 'paused', stage: 'produce', message: '已暂停自动制作', transcript: '原视频介绍了海洋动物发光的现象。', script: `${title}，先从一个现象说起。`, factChecks: [{ claim: '某种生物能够发光', note: '核查具体物种和生理机制' }], huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj', checkpoint: null, projectUrl: null, sourceVideoUrl: null, videoUrl: null, logs: [{ at: '2026-10-28T02:01:00.000Z', message: '已生成二创文稿' }], upload: null })
async function harness(t, viewport = { width: 1440, height: 1000 }) {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close())
  const page = await browser.newPage({ viewport }); page.setDefaultTimeout(10000)
  await page.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//, route => route.abort())
  const jobs = [makeJob('first', '深海动物为什么会发光'), makeJob('second', '雨后为什么能闻到泥土味')]
  const accounts = { huasheng: { accounts: [account('science_hs', '科普花生')], defaultAccountName: 'science_hs' }, baijiahao: { accounts: [account('science_bj', '科普百家号')], defaultAccountName: 'science_bj' } }
  const collection = { settings: { youtubeChannels: ['https://www.youtube.com/@ScienceOne/videos'], targetCount: 5, mode: 'videos', huashengAccountName: null, baijiahaoAccountName: null }, runs: [], activeRun: null }
  let starts = 0
  const fail = { start: false, settings: false, retry: false, covers: false, remove: false }
  const writes = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname
    if (request.method() !== 'GET') writes.push({ method: request.method(), path: pathname, body: request.postDataJSON() })
    let data
    if (pathname === BASE) data = { jobs, accounts }
    else if (pathname === `${BASE}/sync`) {
      const pending = jobs.filter(job => job.projectUrl && !job.videoUrl && ['needs_attention', 'paused', 'waiting_remote', 'awaiting_export'].includes(job.status))
      data = { started: pending.map(job => job.id), skipped: jobs.filter(job => !pending.includes(job)).map(job => job.id) }
      pending.forEach(job => Object.assign(job, { status: 'running', message: '正在同步花生制作状态' }))
    }
    else if (pathname === `${BASE}/collection`) data = collection
    else if (pathname === `${BASE}/collection/settings`) {
      if (fail.settings) return route.fulfill({ status: 503, json: { code: 503, message: '频道保存暂不可用' } })
      Object.assign(collection.settings, request.postDataJSON()); data = collection.settings
    } else if (pathname === `${BASE}/collection/runs`) {
      starts++
      if (fail.start) return route.fulfill({ status: 503, json: { code: 503, message: '启动结果尚未确认，请重试' } })
      const payload = request.postDataJSON()
      data = { ...payload, id: `batch-${starts}`, status: 'running', message: '正在按频道列表采集新视频', youtubeChannels: [...collection.settings.youtubeChannels], currentChannel: collection.settings.youtubeChannels[0], currentJobId: 'first', counts: { scanned: 3, selected: 1, skipped: 2, completed: 0, failed: 0 }, items: [{ jobId: 'first', title: jobs[0].title, sourceUrl: jobs[0].sourceUrl, videoId: 'abcdefghijk', status: 'running', message: '正在制作' }], channelErrors: [], logs: [], createdAt: '2026-10-28T03:00:00.000Z', updatedAt: '2026-10-28T03:00:00.000Z' }
      collection.runs.unshift(data); collection.activeRun = data
    } else if (pathname.startsWith(`${BASE}/collection/runs/`)) {
      const [id, phaseOrAction, phaseAction] = pathname.slice(`${BASE}/collection/runs/`.length).split('/')
      const phase = phaseAction ? phaseOrAction : null, action = phaseAction || phaseOrAction
      data = collection.runs.find(run => run.id === id)
      if (phase) {
        Object.assign(data[phase], { status: action === 'stop' ? 'stopping' : 'running', message: action === 'stop' ? '正在停止当前阶段' : '已恢复当前阶段' })
        data.status = 'running'; collection.activeRun = data
        collection.activeCollection = ['running', 'stopping'].includes(data.collection.status) ? data : null
        return route.fulfill({ json: { code: 200, data } })
      }
      if (action === 'retry') {
        if (fail.retry) return route.fulfill({ status: 503, json: { code: 503, message: '重试暂不可用，所选任务已保留' } })
        data.retry = { jobIds: request.postDataJSON().jobIds || data.items.filter(item => item.status !== 'completed').map(item => item.jobId), startedAt: '2026-10-28T04:00:00.000Z', finishedAt: null, completed: 0, failed: 0 }
      }
      Object.assign(data, { status: action === 'stop' ? 'stopping' : 'running', message: action === 'stop' ? '等待当前任务安全停止' : '继续原批次，跳过已完成作品' }); collection.activeRun = data
    }
    else if (pathname === `${BASE}/jobs` && request.method() === 'POST') { data = { ...makeJob('third', request.postDataJSON().title || '新视频'), status: 'queued', stage: 'produce', message: '已加入自动制作队列', script: '', transcript: '' }; jobs.unshift(data) }
    else if (pathname.startsWith(`${BASE}/accounts/`)) {
      const [platform, name, action] = pathname.slice(`${BASE}/accounts/`.length).split('/')
      if (action === 'login' && platform === 'baijiahao') data = { id: 'session', accountName: name, status: 'ready', message: '已登录' }
      else if (action) data = accounts[platform].accounts.find(account => account.accountName === name)
      else if (request.method() === 'POST') { data = account(`${platform}_new`, request.postDataJSON().label); accounts[platform].accounts.push(data) }
      else data = accounts[platform]
    } else if (/\/upload-review(?:\/input)?$/.test(pathname)) {
      const id = pathname.split('/jobs/')[1].split('/')[0]
      data = { jobId: id, targetId: 'ABC123', url: 'https://baijiahao.baidu.com/builder/rc/content', width: 1440, height: 1000, originalEditor: false,
        message: '原编辑页已关闭，已打开同一账号的内容管理', imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmwoAAAAASUVORK5CYII=' }
    } else {
      const match = pathname.match(/\/jobs\/([^/]+)(?:\/(produce|prepare|upload|cancel|recover|covers|sync|check-upload|check-huasheng|open-project))?$/)
      data = match && jobs.find(job => job.id === match[1])
      if (data && match[2] === 'open-project') return route.fulfill({ json: { code: 200, data: { accountName: data.huashengAccountName, projectUrl: data.projectUrl, reused: true, message: '已在任务绑定账号打开花生项目' } } })
      if (data && request.method() === 'DELETE') {
        if (fail.remove) return route.fulfill({ status: 409, json: { code: 409, message: '任务正在同步，请稍后重试' } })
        jobs.splice(jobs.indexOf(data), 1); data = { deleted: true, id: match[1] }
      }
      if (data && match[2] === 'covers' && fail.covers) return route.fulfill({ status: 503, json: { code: 503, message: '封面生成暂不可用' } })
      if (data && match[2] === 'covers' && request.postDataJSON()?.instruction !== undefined) data.coverInstruction = request.postDataJSON().instruction
      if (data && request.method() === 'PATCH') Object.assign(data, request.postDataJSON())
      if (data && match[2] === 'recover') Object.assign(data, request.postDataJSON(), { message: '恢复信息已保存，可继续原任务' })
      else if (data && match[2] === 'cancel') Object.assign(data, { status: 'paused', message: '已停止自动接续' })
      else if (data && match[2] === 'sync') Object.assign(data, { status: 'running', message: '正在同步花生制作状态' })
      else if (data && match[2] === 'upload') Object.assign(data, { status: 'running', stage: 'upload', uploadStatus: 'uploading', executionActive: true, uploadRetry: undefined })
      else if (data && match[2] === 'check-upload') data.uploadCheck = { checkedAt: '2026-11-02T00:00:00Z', status: 'needs_attention', message: '原发表记录尚未确认，请核对内容管理' }
      else if (data && match[2] === 'check-huasheng') data.huashengCheck = { checkedAt: '2026-11-02T00:00:00Z', status: 'completed', message: '花生接口已确认制作完成，分镜素材已就绪' }
      else if (data && match[2]) Object.assign(data, { status: 'running', stage: match[2] })
    }
    if (!data) return route.fulfill({ status: 404, json: { code: 404, message: `Unexpected API ${pathname}` } })
    return route.fulfill({ json: { code: 200, data } })
  })
  await page.goto(`${baseUrl}/science-pop`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '深海动物为什么会发光', exact: true, includeHidden: true }).waitFor({ state: 'attached' })
  return { page, jobs, accounts, writes, errors, collection, fail }
}
test('project actions open the saved Huasheng profile with visible pending and failure feedback', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'produce', checkpoint: 'submitted', projectUrl: 'https://www.huasheng.cn/video/12345', message: '暂时无法核验花生账号身份，请稍后检查' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  assert.equal(await page.locator('a[href*="huasheng.cn"]').count(), 0)
  let release, failure = false
  const pending = new Promise(resolve => { release = resolve })
  await page.route(`**${BASE}/jobs/first/open-project`, async route => {
    writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    if (failure) return route.fulfill({ status: 503, json: { code: 503, message: '任务原账号浏览器暂时无法连接' } })
    await pending
    return route.fulfill({ json: { code: 200, data: { accountName: 'science_hs', projectUrl: jobs[0].projectUrl, reused: true, message: '已在任务绑定账号打开花生项目' } } })
  })
  const open = page.getByRole('button', { name: '花生项目', exact: true })
  await open.click()
  await open.getByText('正在打开…', { exact: true }).waitFor()
  assert.equal(await open.isDisabled(), true)
  release()
  await page.locator('.action-notice').getByText('已在任务绑定账号打开花生项目', { exact: true }).waitFor()
  failure = true
  await page.locator('.task-recovery').getByRole('button', { name: '查看花生项目', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '任务原账号浏览器暂时无法连接' }).waitFor()
  assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ method: 'POST', path: `${BASE}/jobs/first/open-project`, body: {} })))
  assert.equal(jobs[0].status, 'needs_attention')
  assert.equal(page.context().pages().length, 1)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.queue-item').first().click()
  assert.equal(await open.isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/science-pop-project-action-mobile.png', fullPage: true })
  assert.deepEqual(errors, [])
})

test('task deletion confirms preserved files, reports failures, and works on desktop and mobile', async t => {
  const { page, jobs, writes, fail, errors } = await harness(t)
  const remove = page.getByRole('button', { name: '删除任务', exact: true })
  assert.equal(await remove.getAttribute('title'), '删除任务')
  page.once('dialog', dialog => dialog.dismiss())
  await remove.click(); assert.equal(writes.length, 0)
  fail.remove = true
  page.once('dialog', async dialog => { assert.match(dialog.message(), /本地素材、成片和平台发布记录保留/); await dialog.accept() })
  await remove.click()
  await page.getByText('任务正在同步，请稍后重试', { exact: true }).waitFor()
  assert.equal(jobs.length, 2)
  fail.remove = false
  page.once('dialog', dialog => dialog.accept()); await remove.click()
  await page.getByRole('heading', { name: '雨后为什么能闻到泥土味', exact: true }).waitFor()
  assert.equal(await page.locator('.queue-item').count(), 1)
  assert.deepEqual(writes, [{ method: 'DELETE', path: `${BASE}/jobs/first`, body: null }, { method: 'DELETE', path: `${BASE}/jobs/first`, body: null }])
  await page.screenshot({ path: '/tmp/science-pop-delete-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await remove.isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/science-pop-delete-mobile.png', fullPage: true })
  page.once('dialog', dialog => dialog.accept()); await remove.click()
  await page.getByText('还没有科普任务', { exact: true }).waitFor()
  assert.equal(await page.locator('.queue-item').count(), 0)
  assert.deepEqual(errors, [])
})
test('active production must be stopped before task deletion', async t => {
  const { page, jobs, writes } = await harness(t)
  const remove = page.getByRole('button', { name: '删除任务', exact: true })
  for (const status of ['queued', 'running', 'waiting_remote', 'awaiting_export']) {
    Object.assign(jobs[0], { status })
    await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.delete-task-button')?.disabled === true)
    assert.equal(await remove.getAttribute('title'), '请先停止任务再删除')
    assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isVisible(), true)
  }
  assert.deepEqual(writes, [])
})
test('queued automation shows production progress without a script approval or duplicate start', async t => {
  const { page, jobs, writes } = await harness(t)
  Object.assign(jobs[0], { status: 'queued', stage: 'produce', message: '已加入自动制作队列' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.detail-meta .status-label')?.textContent === '排队制作')
  assert.equal(await page.locator('#science-script').isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '继续自动制作', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '继续制作并发表', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '重新生成二创稿', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '删除任务', exact: true }).isDisabled(), true)
  assert.deepEqual(writes, [])
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.getByRole('button', { name: '继续自动制作', exact: true }).waitFor()
  assert.equal(writes.at(-1).path, `${BASE}/jobs/first/cancel`)
})
test('queued batch recovery locates the exact original upload batch and its current quota blocker', async t => {
  const { page, jobs, collection, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'queued', executionActive: false, collectionId: 'batch-original', message: '等待自动制作' })
  Object.assign(jobs[1], { status: 'needs_attention', checkpoint: 'quota_waiting', projectUrl: 'https://www.huasheng.cn/video/12345', message: '花生返回 10008：标准模式每日额度已用完' })
  const run = { id: 'batch-original', status: 'needs_attention', mode: 'upload', targetCount: 2, message: '花生浏览器连接中断，已停止后续制作',
    youtubeChannels: [...collection.settings.youtubeChannels], huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj',
    currentChannel: null, currentJobId: null, counts: { scanned: 2, selected: 2, skipped: 0, completed: 0, failed: 1 },
    items: [{ jobId: 'first', title: jobs[0].title, status: 'queued' }], retry: { jobIds: ['first'], completed: 0, failed: 0 },
    channelErrors: [], logs: [], createdAt: '2026-10-28T03:00:00.000Z', updatedAt: '2026-10-28T03:00:00.000Z' }
  collection.runs.push({ ...run, id: 'batch-newer', status: 'completed', mode: 'videos', retry: null }, run)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '所属批次异常暂停', exact: true }).waitFor()
  assert.match(await page.locator('.task-recovery').innerText(), /制作并直接发表.*花生浏览器连接中断/s)
  assert.match(await page.locator('.quota-blocker').innerText(), /当前账号额度.*标准模式每日额度已用完/s)
  assert.equal(await page.getByRole('button', { name: '开始制作', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '继续自动制作', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '继续制作并发表', exact: true }).count(), 0)
  await page.getByRole('button', { name: '查看额度受限任务', exact: true }).click()
  await page.getByRole('heading', { name: '花生标准模式每日额度已用完', exact: true }).waitFor()
  await page.locator('.queue-item').filter({ hasText: jobs[0].title }).click()
  await page.locator('.task-recovery').getByRole('button', { name: '查看所属批次', exact: true }).click()
  assert.equal(await page.getByLabel('查看采集批次', { exact: true }).inputValue(), 'batch-original')
  await page.screenshot({ path: '/tmp/science-pop-batch-context-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.task-recovery').getByRole('button', { name: '查看所属批次', exact: true }).click()
  assert.equal(await page.getByLabel('查看采集批次', { exact: true }).inputValue(), 'batch-original')
  assert.equal(await page.locator('.batch-panel').evaluate(element => document.activeElement === element), true)
  assert.equal(await page.getByRole('button', { name: '继续本次重试', exact: true }).isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.screenshot({ path: '/tmp/science-pop-batch-context-mobile.png', fullPage: true })
  assert.deepEqual(writes, [])
  await page.getByRole('button', { name: '继续本次重试', exact: true }).click()
  await page.getByRole('heading', { name: '等待批次调度', exact: true }).waitFor()
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/collection/runs/batch-original/resume`, body: {} }])
  assert.equal(run.mode, 'upload')
  assert.equal(run.huashengAccountName, 'science_hs')
  assert.equal(run.baijiahaoAccountName, 'science_bj')
  assert.deepEqual(errors, [])
})
test('a paused collection task can restart only itself with its original batch settings', async t => {
  const { page, jobs, collection, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'queued', stage: 'produce', executionActive: false, collectionId: 'batch-original', message: '等待自动制作' })
  collection.runs.push({ id: 'batch-original', status: 'needs_attention', mode: 'upload', targetCount: 15,
    message: '花生浏览器连接中断，已停止后续制作', youtubeChannels: [...collection.settings.youtubeChannels],
    huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj', currentChannel: null, currentJobId: null,
    counts: { scanned: 2, selected: 2, skipped: 0, completed: 0, failed: 1 },
    retry: { jobIds: ['first', 'second'], completed: 0, failed: 1 },
    items: [{ jobId: 'first', title: jobs[0].title, status: 'queued' }, { jobId: 'second', title: jobs[1].title, status: 'failed' }],
    channelErrors: [], logs: [], createdAt: '2026-10-28T03:00:00.000Z', updatedAt: '2026-10-28T03:00:00.000Z' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '所属批次异常暂停', exact: true }).waitFor()
  await page.locator('.task-recovery').getByRole('button', { name: '重启本任务', exact: true }).click()
  await page.getByText('已重启本任务，沿用原批次账号和产出方式。', { exact: true }).waitFor()
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/collection/runs/batch-original/retry`, body: { jobIds: ['first'] } }])
  assert.equal(collection.runs[0].mode, 'upload')
  assert.equal(collection.runs[0].huashengAccountName, 'science_hs')
  assert.equal(collection.runs[0].baijiahaoAccountName, 'science_bj')
  assert.deepEqual(errors, [])
})
test('collection polling refreshes queued task explanations, retry scope, stops and missing records', async t => {
  const { page, jobs, collection, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'queued', executionActive: false, collectionId: 'batch-original', message: '等待自动制作' })
  const run = { id: 'batch-original', status: 'needs_attention', mode: 'upload', targetCount: 2, message: '浏览器连接中断，等待检查',
    youtubeChannels: [...collection.settings.youtubeChannels], huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj',
    currentChannel: null, currentJobId: null, counts: { scanned: 2, selected: 2, skipped: 0, completed: 0, failed: 0 },
    items: [{ jobId: 'first', title: jobs[0].title, status: 'queued' }], retry: { jobIds: ['first'], completed: 0, failed: 0 },
    channelErrors: [], logs: [], createdAt: '2026-10-28T03:00:00.000Z', updatedAt: '2026-10-28T03:00:00.000Z' }
  collection.runs.push(run)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '所属批次异常暂停', exact: true }).waitFor()
  await page.locator('#science-script').fill('轮询期间保留的人工校对')
  run.message = '已检查原账号窗口，等待继续本次重试'
  run.retry.jobIds.push('second')
  await page.locator('.task-recovery').getByText(/已检查原账号窗口，等待继续本次重试/).waitFor()
  await page.locator('.batch-progress').getByText('已恢复 0/2', { exact: true }).waitFor()
  assert.equal(await page.locator('#science-script').inputValue(), '轮询期间保留的人工校对')
  Object.assign(run, { status: 'stopped', message: '已按要求停止，原范围保留' })
  await page.getByRole('heading', { name: '所属批次已停止', exact: true }).waitFor()
  assert.match(await page.locator('.task-recovery').innerText(), /已按要求停止，原范围保留/)
  collection.runs.length = 0
  await page.getByRole('heading', { name: '未找到所属批次记录', exact: true }).waitFor()
  assert.match(await page.locator('.task-recovery').innerText(), /尚未提交花生/)
  assert.equal(await page.getByRole('button', { name: '开始制作', exact: true }).count(), 0)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})
test('manual Huasheng sync follows automatic export without saving edits or separate production requests', async t => {
  const { page, jobs, accounts, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/123', checkpoint: 'submitted' })
  Object.assign(jobs[1], { status: 'waiting_remote', stage: 'export', projectUrl: 'https://www.huasheng.cn/video/456', checkpoint: 'submitted' })
  accounts.baijiahao.accounts.push(account('science_other', '另一个百家号'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '同步花生状态', exact: true }).waitFor()
  assert.equal(await page.locator('.project-sync .sync-note').innerText(), '完成后自动导出下载，并按原生产设置继续。')
  assert.equal(await page.locator('.queue-item').filter({ hasText: jobs[1].title }).locator('.status-label').innerText(), '花生导出中')
  await page.getByLabel('百家号上传账号', { exact: true }).selectOption('science_other')
  await page.getByRole('button', { name: '同步花生状态', exact: true }).click()
  await page.getByRole('button', { name: '停止', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正在自动接续', exact: true }).isDisabled(), true)
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/jobs/first/sync`, body: {} }])
  Object.assign(jobs[0], { status: 'awaiting_export', stage: 'export', message: '花生制作已完成，正在排队自动导出下载', huashengSync: { checkedAt: '2026-10-30T02:00:00.000Z', status: 'completed', message: '花生制作已完成', exportProgress: 100 } })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.locator('.detail-head .status-label').getByText('排队导出', { exact: true }).waitFor()
  assert.match(await page.locator('.sync-result').innerText(), /上次查询.*10[/-]30.*花生制作已完成.*导出 100%/s)
  assert.equal(await page.getByLabel('百家号上传账号', { exact: true }).inputValue(), 'science_other')
  await page.getByRole('button', { name: '同步待处理任务', exact: true }).click()
  await page.locator('.queue-sync').getByText('已开始同步 2 条，跳过 0 条。结果会自动更新。', { exact: true }).waitFor()
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/jobs/first/sync`, body: {} }, { method: 'POST', path: `${BASE}/sync`, body: {} }])
  Object.assign(jobs[0], { status: 'running', stage: 'export', message: '花生制作完成，正在自动导出下载成片' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.locator('.detail-head .status-label').getByText('导出成片', { exact: true }).waitFor()
  assert.equal(await page.locator('.job-message').innerText(), '花生制作完成，正在自动导出下载成片')
  assert.deepEqual(writes.map(item => item.path), [`${BASE}/jobs/first/sync`, `${BASE}/sync`])
  assert.equal(await page.getByLabel('百家号上传账号', { exact: true }).inputValue(), 'science_other')
  assert.deepEqual(errors, [])
})
test('remote production and queued export expose Stop to pause automatic continuation', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  for (const status of ['waiting_remote', 'awaiting_export']) {
    Object.assign(jobs[0], { status, stage: 'export', projectUrl: 'https://www.huasheng.cn/video/123', checkpoint: 'submitted' })
    await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.locator('.detail-head .status-label').getByText('已暂停', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '停止', exact: true }).count(), 0)
  }
  assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ method: 'POST', path: `${BASE}/jobs/first/cancel`, body: {} })))
  assert.deepEqual(errors, [])
})
test('story planning shows source emotions, material choices and telling outline while identifying legacy gaps', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  jobs[0].plan = {
    sourceSummary: '原稿解释深海动物为何发光', sourceTheme: '微弱的光也是深海生存办法', coreClaim: '发光具有具体生存作用', authorStance: '以行为证据解释发光，而不神秘化',
    evidence: [{ id: 'e-light', material: '鮟鱇鱼用发光诱饵吸引猎物', supports: '发光有助捕食', limitation: '不能推广到所有发光动物' }],
    emotionalArc: [{ id: 'emotion-curious', from: '觉得美丽', to: '惊讶于生存竞争', trigger: '看见光点是捕食诱饵', evidenceIds: ['e-light'] }],
    tellingMaterials: [
      { id: 'material-bait', evidenceIds: ['e-light'], detail: '漆黑海水里晃动的一点亮光', role: '开头先让人看到具体动作', disposition: 'retain', reason: '用捕食画面引出光的用途' },
      { id: 'material-ad', evidenceIds: [], detail: '原作者的关注口号', role: '账号宣传', disposition: 'omit', reason: '与解释发光无关' },
    ],
    writingOutline: { thesis: '从发光诱饵讲清生存作用', stance: '避免把一例说成全部', sections: [{ id: 'section-open', purpose: '从亮光引出问题', newInformation: '亮光也可能是陷阱', telling: { materialIds: ['material-bait'], emotionIds: ['emotion-curious'], sceneOrAction: '一条小鱼靠近晃动的光点', explanation: '解释诱饵怎样把猎物带到嘴边', nextQuestion: '其他动物发光也为了捕食吗？' } }], endingPayoff: '发光的用途取决于动物的生活方式' },
  }
  jobs[1].plan = { sourceSummary: '旧记录保留的分析', coreClaim: '旧稿主张', writingOutline: { thesis: '旧的大纲主题', stance: '保留事实', sections: [{ id: 'old-section', purpose: '旧大纲段落', newInformation: '原有段落说明' }], endingPayoff: '旧结尾' } }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.planning-details summary').click()
  assert.match(await page.locator('.planning-details summary').innerText(), /主题、立场、情绪、材料与大纲/)
  assert.match(await page.locator('.planning-summary').innerText(), /原文主题.*微弱的光也是深海生存办法/s)
  assert.match(await page.locator('.emotional-arc').innerText(), /觉得美丽 → 惊讶于生存竞争.*看见光点是捕食诱饵.*鮟鱇鱼用发光诱饵吸引猎物/s)
  const materials = await page.locator('.telling-materials').innerText()
  assert.match(materials, /保留 · 漆黑海水里晃动的一点亮光.*用捕食画面引出光的用途/s)
  assert.match(materials, /不采用 · 原作者的关注口号.*与解释发光无关/s)
  const outline = await page.locator('.section-telling').innerText()
  assert.match(outline, /先让人看到.*一条小鱼靠近晃动的光点.*再讲清道理.*解释诱饵怎样把猎物带到嘴边/s)
  assert.match(outline, /用到的材料.*漆黑海水里晃动的一点亮光.*情绪怎么走.*觉得美丽 → 惊讶于生存竞争.*接着追问.*其他动物发光也为了捕食吗/s)
  assert.doesNotMatch(outline, /material-bait|emotion-curious/)
  assert.equal(await page.locator('.planning-legacy-note').count(), 0)
  await page.getByRole('button', { name: /雨后为什么能闻到泥土味/ }).click()
  if (!await page.locator('.planning-details').evaluate(element => element.open)) await page.locator('.planning-details summary').click()
  await page.locator('.planning-legacy-note').waitFor()
  assert.match(await page.locator('.planning-legacy-note').innerText(), /缺少完整的情绪与讲述材料拆解.*不能据此确认已完成全部二创准备/)
  assert.match(await page.locator('.writing-outline').innerText(), /旧大纲段落.*原有段落说明/s)
  assert.equal(await page.locator('.section-telling').count(), 0)
  assert.deepEqual(writes, []); assert.deepEqual(errors, [])
})
test('workspace keeps task edits, uses explicit production account, and renders without runtime errors', async t => {
  const { page, writes, errors } = await harness(t)
  assert.equal(await page.locator('.detail-meta .status-label').innerText(), '已暂停')
  await page.locator('#science-script').fill('这是保留的人工作品。')
  await page.getByRole('button', { name: /雨后为什么能闻到泥土味/ }).click()
  assert.match(await page.locator('#science-script').inputValue(), /雨后/)
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  assert.equal(await page.locator('#science-script').inputValue(), '这是保留的人工作品。')
  await page.getByRole('button', { name: '继续制作并发表', exact: true }).click()
  await page.getByRole('button', { name: '停止', exact: true }).waitFor()
  assert.deepEqual(writes.map(item => item.method), ['PATCH', 'POST'])
  assert.deepEqual(writes.at(-1).body, { upload: true })
  assert.equal(writes.at(-1).path, `${BASE}/jobs/first/produce`)
  assert.equal(await page.locator('#science-script').isDisabled(), true)
  assert.deepEqual(errors, [])
  await page.locator('.detail-pane').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: '/tmp/science-pop-workspace.png', fullPage: true })
})
test('canonical task IDs connect queue, detail, and batch failures and support search and clipboard feedback', async t => {
  const { page, jobs, collection, writes, errors } = await harness(t)
  const ids = ['c55747c0-16fa-48bc-879a-3876bebf3654', 'ad698f38-09d4-4b5b-ab4f-f5ce92b8d2a6']
  jobs.forEach((job, index) => { job.id = ids[index] })
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'export', message: '导出窗口未响应' })
  collection.runs.push({
    id: 'batch-fixture', status: 'needs_attention', mode: 'videos', targetCount: 2,
    message: '本批有任务需要处理', youtubeChannels: [...collection.settings.youtubeChannels],
    huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj', currentChannel: null, currentJobId: null,
    counts: { scanned: 2, selected: 1, skipped: 1, completed: 0, failed: 1 },
    items: [{ jobId: ids[0], title: jobs[0].title, sourceUrl: jobs[0].sourceUrl, videoId: 'abcdefghijk', status: 'failed', message: '导出窗口未响应' }],
    channelErrors: [], logs: [], createdAt: '2026-10-28T03:00:00.000Z', updatedAt: '2026-10-28T03:00:00.000Z',
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.detail-head code').getByText(ids[0], { exact: true }).waitFor()
  assert.deepEqual(await page.locator('.queue-item code').allTextContents(), ids)
  assert.equal(await page.locator('.detail-head .status-label').innerText(), '需要处理')
  await page.locator('.batch-details summary').click()
  assert.equal(await page.locator('.batch-items code').innerText(), ids[0])
  assert.equal(await page.locator('.batch-items p').innerText(), '导出窗口未响应')
  const search = page.getByLabel('搜索科普任务', { exact: true })
  await search.fill(ids[1].slice(0, 8).toUpperCase())
  await page.locator('.queue-item').filter({ hasText: jobs[0].title }).waitFor({ state: 'hidden' })
  assert.deepEqual(await page.locator('.queue-item code').allTextContents(), [ids[1]])
  await page.locator('.queue-item').click()
  assert.equal(await page.locator('.detail-head code').innerText(), ids[1])
  await page.locator('.batch-items .item-title').click()
  assert.equal(await page.locator('.detail-head code').innerText(), ids[0])
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async id => { window.copiedJobId = id } } }))
  await page.getByRole('button', { name: '复制 ID', exact: true }).click()
  await page.getByText('任务 ID 已复制', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.copiedJobId), ids[0])
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('clipboard denied') } })
  await page.getByRole('button', { name: '复制 ID', exact: true }).click()
  await page.getByText('复制失败，请手动选择任务 ID 复制', { exact: true }).waitFor()
  assert.equal(await page.locator('.queue-item button').count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.locator('.detail-head code').innerText(), ids[0])
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await page.locator('.batch-items').evaluate(element => element.scrollWidth > element.clientWidth), false)
  await page.getByRole('button', { name: '创作任务', exact: true }).click()
  await search.fill('')
  assert.deepEqual(await page.locator('.queue-item code').allTextContents(), ids)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(writes, [])
  assert.deepEqual(errors, [])
})
test('clipboard completion from a previous selection does not report success on another task', async t => {
  const { page } = await harness(t)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => { window.finishCopy = resolve }) } }))
  await page.getByRole('button', { name: '复制 ID', exact: true }).click()
  await page.getByRole('button', { name: /雨后为什么能闻到泥土味/ }).click()
  await page.evaluate(async () => { window.finishCopy(); await Promise.resolve() })
  assert.equal(await page.getByText('任务 ID 已复制', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '复制 ID', exact: true }).isEnabled(), true)
})
test('account dialogs use science namespaces and defaults appear on import', async t => {
  const { page, writes, errors } = await harness(t)
  await page.getByRole('button', { name: '花生账号', exact: true }).click()
  await page.getByRole('dialog', { name: '科普花生账号', exact: true }).waitFor()
  await page.getByLabel('添加花生账号', { exact: true }).fill('第二个科普账号')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  await page.getByRole('dialog', { name: '科普花生账号', exact: true }).locator('.account-info strong').filter({ hasText: '第二个科普账号' }).waitFor()
  assert.equal(writes[0].path, `${BASE}/accounts/huasheng`)
  await page.getByRole('button', { name: '关闭科普花生账号管理', exact: true }).click()
  await page.getByRole('button', { name: '百家号账号', exact: true }).click()
  await page.getByRole('dialog', { name: '百家号账号', exact: true }).getByText('科普百家号', { exact: false }).waitFor()
  await page.getByRole('button', { name: '关闭账号管理', exact: true }).click()
  await page.getByRole('button', { name: '补充单条视频', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导入 YouTube 视频', exact: true })
  assert.equal(await dialog.getByLabel('花生账号', { exact: true }).inputValue(), 'science_hs')
  assert.equal(await dialog.getByLabel('百家号账号', { exact: true }).inputValue(), 'science_bj')
  assert.deepEqual(errors, [])
})

test('single-video import requires Huasheng and directly queues automatic production', async t => {
  const { page, writes, errors } = await harness(t)
  await page.getByRole('button', { name: '补充单条视频', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导入 YouTube 视频', exact: true })
  await dialog.getByLabel('YouTube 视频链接', { exact: true }).fill('https://youtu.be/video000001')
  await dialog.getByLabel('花生账号', { exact: true }).selectOption('')
  assert.equal(await dialog.getByRole('button', { name: '开始制作并发表', exact: true }).isDisabled(), true)
  await dialog.getByLabel('花生账号', { exact: true }).selectOption('science_hs')
  await dialog.getByLabel('百家号账号', { exact: true }).selectOption('')
  await dialog.getByRole('button', { name: '开始自动制作', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: '新视频', exact: true }).waitFor()
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/jobs`, body: {
    sourceUrl: 'https://youtu.be/video000001', mode: 'videos', huashengAccountName: 'science_hs', baijiahaoAccountName: null,
  } }])
  assert.equal(await page.locator('.detail-meta .status-label').innerText(), '排队制作')
  assert.equal(await page.locator('#science-script').isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '继续自动制作', exact: true }).count(), 0)
  assert.deepEqual(errors, [])
})
test('single-video import clearly starts automatic publication for the selected Baijiahao account', async t => {
  const { page, writes, errors } = await harness(t)
  await page.getByRole('button', { name: '补充单条视频', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导入 YouTube 视频', exact: true })
  await dialog.getByLabel('YouTube 视频链接', { exact: true }).fill('https://youtu.be/video000002')
  await dialog.getByRole('button', { name: '开始制作并发表', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/jobs`, body: {
    sourceUrl: 'https://youtu.be/video000002', mode: 'upload', huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj',
  } }])
  assert.deepEqual(errors, [])
})
test('queue, production summary and upload panel show actual upload progress and failures on desktop and mobile', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  await page.route('**/fixture-video.mp4', route => route.fulfill({ status: 204, body: '' }))
  const states = [
    ['pending', 'ready', 'covers', '待上传', null],
    ['queued', 'queued', 'upload', '上传排队', null],
    ['uploading', 'running', 'upload', '上传中', null],
    ['uploaded', 'completed', 'completed', '已上传（草稿）', { saved: true }],
    ['submitted', 'completed', 'completed', '已上传·待审核', { submitted: true }],
    ['published', 'completed', 'completed', '已发表', { published: true, submitted: true }],
    ['blocked', 'needs_attention', 'upload', '上传异常', null],
    ['paused', 'paused', 'upload', '上传已暂停', null],
    ['uncertain', 'needs_attention', 'upload', '等待自动重传', null],
  ]
  for (const [uploadStatus, status, stage, label, upload] of states) {
    Object.assign(jobs[0], { uploadStatus, status, stage, upload, autoUpload: true, videoUrl: '/fixture-video.mp4', message: '原编辑页文案已变化，已保留原上传记录' })
    await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
    await page.waitForFunction(expected => document.querySelector('.detail-meta .status-label')?.textContent === expected, label)
    assert.equal(await page.locator('.queue-item').first().locator('.status-label').textContent(), label)
    assert.equal(await page.locator('.production-actions strong').textContent(), label)
    await page.getByRole('tab', { name: '成片与上传', exact: true }).click()
    assert.equal(await page.locator('.upload-status strong').innerText(), label)
    assert.equal(await page.locator('.upload-mode').innerText(), '自动发表')
    if (uploadStatus === 'blocked') assert.equal(await page.locator('.upload-error').innerText(), jobs[0].message)
    else assert.equal(await page.locator('.upload-error').count(), 0)
  }
  await page.screenshot({ path: '/tmp/science-pop-upload-states-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.queue-item').first().click()
  assert.equal(await page.locator('.upload-status strong').isVisible(), true)
  assert.equal(await page.locator('.upload-status strong').innerText(), '等待自动重传')
  assert.equal(await page.locator('.upload-error').count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.locator('.upload-card').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/science-pop-upload-states-mobile.png', fullPage: true })
  assert.deepEqual(writes, []); assert.deepEqual(errors, [])
})
test('Baijiahao failed QR session rechecks the same account and recovers without starting another login', async t => {
  const { page, accounts, writes, errors } = await harness(t)
  const current = accounts.baijiahao.accounts[0]
  Object.assign(current, { status: 'error', message: '登录检查失败，请重新检查' })
  let ready = false
  await page.route(`${baseUrl}/api/v1/science-pop/workflow/accounts/baijiahao/science_bj/*`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    writes.push({ method: request.method(), path, body: request.postDataJSON() })
    if (path.endsWith('/login')) return route.fulfill({ json: { code: 202, data: { id: 'failed-session', accountName: current.accountName, status: 'failed', message: '登录失败或超时，请重新获取二维码', qrDataUrl: 'data:image/png;base64,old' } } })
    assert.ok(path.endsWith('/check'))
    Object.assign(current, { status: ready ? 'ready' : 'expired', message: ready ? '账号已登录' : '科普百家号仍需在手机确认登录' })
    return route.fulfill({ json: { code: 200, data: current } })
  })
  await page.getByRole('button', { name: '百家号账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '百家号账号', exact: true })
  await dialog.getByRole('button', { name: '扫码登录', exact: true }).click()
  const recheck = dialog.getByRole('button', { name: '重新检查登录', exact: true })
  await recheck.waitFor()
  await recheck.click()
  await dialog.getByText('科普百家号仍需在手机确认登录', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '重新获取二维码', exact: true }).isVisible(), true)
  ready = true
  await recheck.click()
  await dialog.getByText('账号已登录', { exact: true }).waitFor()
  assert.equal(await dialog.locator('.login-panel img').count(), 0)
  assert.equal(await dialog.getByRole('button', { name: '重新获取二维码', exact: true }).count(), 0)
  assert.deepEqual(writes.map(write => write.path), [`${BASE}/accounts/baijiahao/science_bj/login`, `${BASE}/accounts/baijiahao/science_bj/check`, `${BASE}/accounts/baijiahao/science_bj/check`])
  await dialog.getByRole('button', { name: '返回账号列表', exact: true }).click()
  assert.equal(await dialog.locator('.account-info > span').innerText(), '已登录')
  assert.deepEqual(errors, [])
})

test('Baijiahao accounts awaiting or requiring login expose checks while an active login stays unchanged', async t => {
  const { page, accounts } = await harness(t)
  accounts.baijiahao.accounts = ['login_required', 'expired', 'error', 'logging_in'].map((status, index) => ({ ...account(`science_bj_${index}`, `账号 ${index}`), status, message: '待检查' }))
  await page.getByRole('button', { name: '百家号账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '百家号账号', exact: true })
  await dialog.getByText('账号 3', { exact: false }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '检查登录', exact: true }).count(), 3)
  const pending = dialog.locator('.account-list li').filter({ hasText: '账号 3' })
  assert.equal(await pending.getByRole('button', { name: '检查登录', exact: true }).count(), 0)
  assert.equal(await pending.getByRole('button', { name: '查看二维码', exact: true }).isVisible(), true)
})

test('channel manager persists a normalized multi-channel list and blocks video URLs and duplicates', async t => {
  const { page, collection, writes, errors } = await harness(t)
  await page.getByRole('button', { name: '频道管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'YouTube 频道管理', exact: true })
  await dialog.getByRole('button', { name: '添加频道', exact: true }).click()
  await dialog.getByLabel('科普 YouTube 频道 2', { exact: true }).fill('https://www.youtube.com/watch?v=abcdefghijk')
  const save = dialog.getByRole('button', { name: '保存频道列表', exact: true })
  assert.equal(await save.isDisabled(), true)
  await dialog.getByLabel('科普 YouTube 频道 2', { exact: true }).fill('https://youtube.com/@scienceone')
  assert.equal(await save.isDisabled(), true)
  await dialog.getByLabel('科普 YouTube 频道 2', { exact: true }).fill('https://youtube.com/@ScienceTwo')
  await save.click(); await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(collection.settings.youtubeChannels, ['https://www.youtube.com/@ScienceOne/videos', 'https://www.youtube.com/@ScienceTwo/videos'])
  assert.deepEqual(writes.at(-1), { method: 'PUT', path: `${BASE}/collection/settings`, body: { youtubeChannels: collection.settings.youtubeChannels } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '频道管理', exact: true }).click()
  assert.equal(await dialog.getByLabel('科普 YouTube 频道 2', { exact: true }).inputValue(), collection.settings.youtubeChannels[1])
  assert.deepEqual(errors, [])
})

test('batch production carries quantity and account snapshots, displays progress, and resumes the original batch', async t => {
  const { page, collection, writes, errors } = await harness(t)
  await page.getByRole('button', { name: '批量采集 / 生产', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量采集 / 生产', exact: true })
  await dialog.getByLabel('本批产出', { exact: true }).selectOption('upload')
  await dialog.getByLabel('目标采集数量', { exact: true }).fill('2')
  assert.equal(await dialog.getByLabel('本批花生账号', { exact: true }).inputValue(), 'science_hs')
  assert.equal(await dialog.getByLabel('本批百家号账号', { exact: true }).inputValue(), 'science_bj')
  await dialog.getByRole('button', { name: '开始本批', exact: true }).click()
  await page.getByRole('button', { name: '停止本批', exact: true }).waitFor()
  assert.deepEqual(writes.slice(-2).map(write => write.method), ['PUT','POST'])
  assert.deepEqual(writes.at(-1).body, { requestId: writes.at(-1).body.requestId, mode: 'upload', targetCount: 2, huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj' })
  assert.match(writes.at(-1).body.requestId, /^[a-f0-9-]{36}$/)
  assert.equal(await page.getByText('已跳过 2', { exact: true }).isVisible(), true)
  await page.getByRole('button', { name: '停止本批', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '正在停止…', exact: true }).isDisabled(), true)
  Object.assign(collection.runs[0], { status: 'stopped', message: '已停止，原任务已保留' }); collection.activeRun = null
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '继续本批', exact: true }).click()
  await page.getByText('继续原批次，跳过已完成作品', { exact: true }).waitFor()
  assert.equal(writes.at(-1).path, `${BASE}/collection/runs/batch-1/resume`)
  assert.deepEqual(writes.at(-1).body, {})
  assert.deepEqual(errors, [])
  await page.screenshot({ path: '/tmp/science-pop-batch.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/science-pop-batch-mobile.png', fullPage: true })
})

test('collection completion stays independent from blocked production and permits a new collection', async t => {
  const { page, collection, errors } = await harness(t)
  const run = {
    id: 'batch-independent', status: 'needs_attention', mode: 'videos', targetCount: 5, message: '花生账号需要重新登录',
    youtubeChannels: [...collection.settings.youtubeChannels], huashengAccountName: 'science_hs', baijiahaoAccountName: null,
    collection: { status: 'completed', message: '已达到采集目标，5 条新视频已入库' },
    processing: { status: 'needs_attention', message: '花生账号需要重新登录' },
    currentChannel: null, currentJobId: 'first', counts: { scanned: 62, selected: 5, skipped: 57, completed: 1, failed: 1 },
    items: [{ jobId: 'done', title: '已完成视频', status: 'completed' }, { jobId: 'first', title: '待续做视频', status: 'failed' }, ...Array.from({ length: 3 }, (_, index) => ({ jobId: `queued-${index}`, title: `待制作视频 ${index}`, status: 'queued' }))],
    channelErrors: [], logs: [], createdAt: '2026-11-05T03:00:00Z', updatedAt: '2026-11-05T03:10:00Z',
  }
  collection.runs.push(run); collection.activeRun = run; collection.activeCollection = null
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('采集已完成', { exact: true }).waitFor()
  assert.equal(await page.getByText('已入库 5 / 5', { exact: true }).isVisible(), true)
  assert.equal(await page.getByText('生产需要处理', { exact: true }).isVisible(), true)
  assert.equal(await page.getByText('已完成 1', { exact: true }).isVisible(), true)
  assert.equal(await page.getByText('失败 1', { exact: true }).isVisible(), true)
  assert.equal(await page.getByText('待处理 3', { exact: true }).isVisible(), true)
  assert.equal(await page.getByRole('button', { name: '查看当前生产任务', exact: true }).isVisible(), true)
  const start = page.getByRole('button', { name: '批量采集 / 生产', exact: true })
  assert.equal(await start.isEnabled(), true)
  await start.click()
  const dialog = page.getByRole('dialog', { name: '批量采集 / 生产', exact: true })
  assert.equal(await dialog.getByLabel('指定采集数量', { exact: true }).isVisible(), true)
  assert.equal(await dialog.getByLabel('目标采集数量', { exact: true }).isVisible(), true)
  await page.getByRole('button', { name: '关闭批量采集', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/science-pop-independent-collection-mobile.png', fullPage: true })
  assert.deepEqual(errors, [])
})

test('collecting and production have independent stop and resume controls', async t => {
  const { page, collection, writes, errors } = await harness(t)
  const run = {
    id: 'batch-separate-controls', status: 'running', mode: 'videos', targetCount: 5, message: '正在采集',
    youtubeChannels: [...collection.settings.youtubeChannels], huashengAccountName: 'science_hs', baijiahaoAccountName: null,
    collection: { status: 'running', message: '正在读取下一个视频' }, processing: { status: 'needs_attention', message: '花生账号需要重新登录' },
    currentChannel: collection.settings.youtubeChannels[0], currentJobId: 'first', counts: { scanned: 4, selected: 2, skipped: 2, completed: 0, failed: 1 },
    items: [{ jobId: 'first', title: '失败视频', status: 'failed' }, { jobId: 'second', title: '等待视频', status: 'queued' }],
    channelErrors: [], logs: [], createdAt: '2026-11-05T03:00:00Z', updatedAt: '2026-11-05T03:10:00Z',
  }
  collection.runs.push(run); collection.activeRun = run; collection.activeCollection = run
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '停止采集', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '批量采集 / 生产', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '继续生产', exact: true }).click()
  await page.getByRole('button', { name: '停止生产', exact: true }).waitFor()
  assert.equal(writes.at(-1).path, `${BASE}/collection/runs/${run.id}/processing/resume`)
  assert.equal(run.collection.status, 'running')
  await page.getByRole('button', { name: '停止生产', exact: true }).click()
  await page.getByRole('button', { name: '正在停止生产…', exact: true }).waitFor()
  assert.equal(writes.at(-1).path, `${BASE}/collection/runs/${run.id}/processing/stop`)
  assert.equal(run.collection.status, 'running')
  await page.getByRole('button', { name: '停止采集', exact: true }).click()
  await page.getByRole('button', { name: '正在停止采集…', exact: true }).waitFor()
  assert.equal(writes.at(-1).path, `${BASE}/collection/runs/${run.id}/collection/stop`)
  assert.equal(run.processing.status, 'stopping')
  run.collection.status = 'stopped'; collection.activeCollection = null
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '继续采集', exact: true }).click()
  assert.equal(writes.at(-1).path, `${BASE}/collection/runs/${run.id}/collection/resume`)
  assert.equal(run.processing.status, 'stopping')
  assert.deepEqual(errors, [])
})

test('collection can start without production accounts', async t => {
  const { page, accounts, writes, errors } = await harness(t)
  for (const platform of ['huasheng', 'baijiahao']) {
    accounts[platform].accounts = []; accounts[platform].defaultAccountName = null
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '批量采集 / 生产', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量采集 / 生产', exact: true })
  await dialog.getByLabel('本批产出', { exact: true }).selectOption('upload')
  const start = dialog.getByRole('button', { name: '开始本批', exact: true })
  assert.equal(await start.isEnabled(), true)
  await start.click()
  await dialog.waitFor({ state: 'hidden' })
  const request = writes.find(write => write.path === `${BASE}/collection/runs`)
  assert.equal(request.body.huashengAccountName, null)
  assert.equal(request.body.baijiahaoAccountName, null)
  assert.deepEqual(errors, [])
})

test('uncertain start retries with the same request identity and continuous mode sends null', async t => {
  const { page, writes, fail } = await harness(t)
  await page.getByRole('button', { name: '批量采集 / 生产', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量采集 / 生产', exact: true })
  await dialog.getByLabel('本批产出', { exact: true }).selectOption('videos')
  await dialog.getByLabel('采到频道末尾', { exact: true }).check()
  fail.start = true
  await dialog.getByRole('button', { name: '开始本批', exact: true }).click()
  await dialog.getByText('启动结果尚未确认，请重试', { exact: true }).waitFor()
  const first = writes.find(write => write.path === `${BASE}/collection/runs`)
  fail.start = false
  await dialog.getByRole('button', { name: '开始本批', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const attempts = writes.filter(write => write.path === `${BASE}/collection/runs`)
  assert.equal(attempts.length, 2); assert.equal(attempts[1].body.requestId, first.body.requestId)
  assert.equal(attempts[1].body.mode, 'videos'); assert.equal(attempts[1].body.targetCount, null)
})
test('batch creation offers automatic production and maps legacy script-only preferences to videos', async t => {
  const { page, collection, writes } = await harness(t)
  delete collection.settings.mode
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '批量采集 / 生产', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量采集 / 生产', exact: true })
  assert.equal(await dialog.getByLabel('本批产出', { exact: true }).inputValue(), 'upload')
  assert.deepEqual(await dialog.getByLabel('本批产出', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value)), ['videos', 'upload'])
  assert.equal(await dialog.getByLabel('本批百家号账号', { exact: true }).isVisible(), true)
  await page.getByRole('button', { name: '关闭批量采集', exact: true }).click()
  collection.settings.mode = 'drafts'
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '批量采集 / 生产', exact: true }).click()
  assert.equal(await dialog.getByLabel('本批产出', { exact: true }).inputValue(), 'videos')
  assert.equal(await dialog.getByLabel('本批花生账号', { exact: true }).isVisible(), true)
  assert.deepEqual(writes, [])
})
test('poster regeneration accepts instructions and protects saved drafts and publications', async t => {
  const { page, jobs, writes, fail, errors } = await harness(t)
  const image = (width, height) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#d8eadf"/></svg>`)}`
  const landscape = image(1280, 720), portrait = image(720, 960)
  const draftUrl = 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=saved-draft'
  Object.assign(jobs[0], { status: 'ready', stage: 'covers', videoUrl: '/fixture-video.mp4', landscapeCoverUrl: landscape, portraitCoverUrl: null })
  await page.route('**/fixture-video.mp4', route => route.fulfill({ status: 204, body: '' }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  await page.getByRole('tab', { name: '成片与上传', exact: true }).click()
  const generate = page.getByRole('button', { name: '重新生成封面', exact: true })
  await generate.waitFor()
  assert.match(await page.locator('.cover-panel header').innerText(), /独立标题海报.*主体特写.*白字配黄关键词.*横竖版分别构图/)
  assert.equal(await page.getByText('当前为旧版封面，可重新生成独立标题海报。', { exact: true }).isVisible(), true)
  const instruction = page.getByLabel(/封面设计指令/)
  await instruction.fill('主体特写，深蓝背景，黄色突出为什么')
  assert.equal(await page.getByRole('button', { name: '直接发表', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('img', { name: '横版封面', exact: true }).getAttribute('src'), landscape)
  assert.equal(await page.getByRole('img', { name: '竖版封面', exact: true }).count(), 0)
  fail.covers = true
  await generate.click()
  await page.getByText('封面生成暂不可用', { exact: true }).waitFor()
  assert.equal(await generate.isEnabled(), true)
  assert.equal(await instruction.inputValue(), '主体特写，深蓝背景，黄色突出为什么')
  fail.covers = false
  await generate.click()
  await page.locator('.detail-head .status-label').filter({ hasText: '生成封面' }).waitFor()
  assert.equal(await generate.isDisabled(), true)
  assert.equal(await page.getByRole('link', { name: '打开百家号编辑页', exact: true }).count(), 0)
  Object.assign(jobs[0], { status: 'ready', stage: 'covers', portraitCoverUrl: portrait, coverStyle: 'science-title-poster-v1', coverRevision: 1 })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.getByRole('img', { name: '竖版封面', exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.cover-preview img')].every(image => image.complete && image.naturalWidth > 0))
  for (const [label, url] of [['横版', landscape], ['竖版', portrait]]) {
    const download = page.getByRole('link', { name: `下载${label}封面`, exact: true })
    assert.equal(await download.getAttribute('href'), url)
    assert.equal(await download.getAttribute('title'), `下载${label}封面`)
    assert.notEqual(await download.getAttribute('download'), null)
  }
  assert.equal(await generate.isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '直接发表', exact: true }).isEnabled(), true)
  assert.equal(await page.getByText('当前为旧版封面，可重新生成独立标题海报。', { exact: true }).count(), 0)
  assert.deepEqual(await page.locator('.cover-card figcaption small').allTextContents(), ['已生成', '已生成'])
  assert.equal(jobs[0].upload, null)
  await instruction.fill('保持主体特写，黄色只强调标题最后两个字')
  await generate.click()
  await page.locator('.detail-head .status-label').filter({ hasText: '生成封面' }).waitFor()
  Object.assign(jobs[0], { status: 'needs_attention', coverGenerationPending: true, message: '新海报生成暂不可用' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.locator('.detail-head .status-label').getByText('封面异常', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '直接发表', exact: true }).isDisabled(), true)
  assert.deepEqual(await page.locator('.cover-card figcaption small').allTextContents(), ['上次生成', '上次生成'])
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.getByRole('img', { name: '竖版封面', exact: true }).isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(writes.map(write => [write.method, write.path, write.body]), [
    ['POST', `${BASE}/jobs/first/covers`, { regenerate: true, instruction: '主体特写，深蓝背景，黄色突出为什么' }],
    ['POST', `${BASE}/jobs/first/covers`, { regenerate: true, instruction: '主体特写，深蓝背景，黄色突出为什么' }],
    ['POST', `${BASE}/jobs/first/covers`, { regenerate: true, instruction: '保持主体特写，黄色只强调标题最后两个字' }],
  ])
  Object.assign(jobs[0], { status: 'completed', stage: 'completed', coverGenerationPending: false, upload: { saved: true, draftUrl } })
  await page.getByText('可设计新封面；已保存草稿的旧封面不会自动替换。', { exact: true }).waitFor()
  assert.equal(await generate.isEnabled(), true); assert.equal(await instruction.isEnabled(), true)
  assert.equal(await page.getByRole('link', { name: '打开百家号编辑页', exact: true }).getAttribute('href'), draftUrl)
  Object.assign(jobs[0], { status: 'completed', stage: 'completed', upload: { submitted: true, saved: false } })
  await page.waitForFunction(() => document.querySelector('.detail-head .status-label')?.textContent.includes('待审核'))
  assert.equal(await generate.isDisabled(), true); assert.equal(await instruction.isDisabled(), true)
  assert.equal(await page.getByText('作品已提交或发表，封面不能再修改。', { exact: true }).isVisible(), true)
  assert.deepEqual(errors, [])
})

test('ready videos expose the upload entry from the default task tab', async t => {
  const { page, jobs, errors } = await harness(t)
  Object.assign(jobs[0], {
    status: 'ready', stage: 'covers', videoUrl: '/fixture-video.mp4', baijiahaoAccountName: null,
    landscapeCoverUrl: '/landscape.jpg', portraitCoverUrl: '/portrait.jpg', coverStyle: 'science-title-poster-v1',
    coverGenerationPending: false,
  })
  await page.route('**/fixture-video.mp4', route => route.fulfill({ status: 204, body: '' }))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  const openUpload = page.getByRole('button', { name: '查看成片与上传', exact: true })
  assert.equal(await openUpload.isVisible(), true)
  await openUpload.click()
  await page.getByRole('heading', { name: '百家号发表', exact: true }).waitFor()
  const chooseAccount = page.getByRole('button', { name: '选择百家号账号', exact: true })
  assert.equal(await chooseAccount.isVisible(), true)
  await chooseAccount.click()
  await page.getByRole('tab', { name: '文稿与账号', exact: true }).waitFor()
  assert.equal(await page.locator('select[aria-label="百家号上传账号"]').evaluate(element => document.activeElement === element), true)
  assert.deepEqual(errors, [])
})

test('completed collection can retry selected unfinished jobs with separate progress and resume its saved scope', async t => {
  const { page, jobs, collection, writes, fail, errors } = await harness(t)
  const run = {
    id: 'batch-completed', status: 'completed', mode: 'videos', targetCount: 5, message: '已达到本批次目标：完成 5/5 条成片',
    youtubeChannels: [...collection.settings.youtubeChannels], huashengAccountName: 'science_hs', baijiahaoAccountName: 'science_bj', currentChannel: null, currentJobId: null,
    counts: { scanned: 7, selected: 7, skipped: 0, completed: 5, failed: 0 },
    items: [...Array.from({ length: 5 }, (_, index) => ({ jobId: `finished-${index}`, title: `已完成作品 ${index}`, status: 'completed' })), { jobId: 'deleted', title: '已经删除的任务', status: 'deleted' }, ...jobs.map((job, index) => ({ jobId: job.id, title: job.title, status: index ? 'paused' : 'queued', message: '等待继续' }))],
    channelErrors: [], logs: [], createdAt: '2026-10-28T03:00:00.000Z', updatedAt: '2026-10-28T03:00:00.000Z',
  }
  collection.runs.push(run)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.batch-details summary').click()
  assert.equal(await page.getByRole('button', { name: '已经删除的任务', exact: true }).isDisabled(), true)
  assert.equal(await page.getByText('已删除', { exact: true }).isVisible(), true)
  await page.getByRole('button', { name: '重试未完成任务', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '重试未完成任务', exact: true })
  assert.equal(await dialog.getByRole('checkbox').count(), 2)
  assert.equal(await dialog.getByText('已暂停', { exact: true }).isVisible(), true)
  assert.equal(await dialog.getByText('等待处理', { exact: true }).isVisible(), true)
  await dialog.getByRole('checkbox', { name: new RegExp(jobs[0].title) }).uncheck()
  fail.retry = true
  await dialog.getByRole('button', { name: '重试所选 1 条任务', exact: true }).click()
  await dialog.getByText('重试暂不可用，所选任务已保留', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('checkbox', { name: new RegExp(jobs[1].title) }).isChecked(), true)
  fail.retry = false
  await dialog.getByRole('button', { name: '重试所选 1 条任务', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(writes.map(write => [write.method, write.path, write.body]), [
    ['POST', `${BASE}/collection/runs/batch-completed/retry`, { jobIds: ['second'] }],
    ['POST', `${BASE}/collection/runs/batch-completed/retry`, { jobIds: ['second'] }],
  ])
  await page.getByText('已恢复 0/1', { exact: true }).waitFor()
  assert.equal(await page.getByText(/原采集目标 5 条/).isVisible(), true)
  await page.getByRole('button', { name: '停止本次重试', exact: true }).click()
  run.status = 'stopped'; collection.activeRun = null
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '继续本次重试', exact: true }).click()
  assert.equal(writes.at(-1).path, `${BASE}/collection/runs/batch-completed/resume`)
  assert.deepEqual(run.retry.jobIds, ['second']); assert.equal(run.targetCount, 5)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(errors, [])
})
test('mobile navigation exposes selected task without horizontal overflow', async t => {
  const { page, errors } = await harness(t, { width: 390, height: 844 })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  await page.locator('#science-script').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.getByRole('button', { name: '创作任务', exact: true }).click()
  await page.getByRole('button', { name: /雨后为什么能闻到泥土味/ }).waitFor({ state: 'visible' })
  assert.deepEqual(errors, [])
})

test('uncertain creation recovers the original project without automatically starting a new production', async t => {
  const { page, jobs, writes } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'produce', checkpoint: 'create_pending', message: '原项目链接尚未记录，请核对' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('恢复原项目', { exact: true }).click()
  const save = page.getByRole('button', { name: '保存恢复信息', exact: true })
  assert.equal(await save.isDisabled(), true)
  await page.getByLabel('原花生项目链接', { exact: true }).fill('https://www.huasheng.cn/video/12345')
  await save.click()
  await page.getByText('恢复信息已保存，可继续原任务', { exact: true }).waitFor()
  assert.deepEqual(writes.map(item => item.path), [`${BASE}/jobs/first/recover`])
  assert.deepEqual(writes[0].body, { projectUrl: 'https://www.huasheng.cn/video/12345' })
  assert.equal(await page.getByRole('button', { name: '继续自动制作', exact: true }).isEnabled(), true)
})

test('recovery panel makes cover retry and a fresh version explicit on desktop and mobile', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'covers', videoUrl: '/video.mp4', message: 'API error 502', coverGenerationPending: true })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.getByRole('heading', { name: '横竖封面尚未完成', exact: true }).waitFor()
  assert.equal(await page.locator('.recovery-error').evaluate(element => element.open), false)
  await page.getByRole('button', { name: '重试封面生成', exact: true }).click()
  assert.deepEqual(writes.at(-1), { method: 'POST', path: `${BASE}/jobs/first/covers`, body: {} })
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'covers', message: '封面底图已提交但未取得任务编号' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.getByRole('heading', { name: '封面请求结果待确认', exact: true }).waitFor()
  const fresh = page.getByRole('button', { name: '生成新一版封面', exact: true })
  page.once('dialog', dialog => dialog.dismiss()); await fresh.click()
  assert.equal(writes.length, 1)
  page.once('dialog', dialog => dialog.accept()); await fresh.click()
  assert.deepEqual(writes.at(-1).body, { newVersion: true, instruction: '' })
  Object.assign(jobs[0], { status: 'paused', stage: 'covers', message: '已暂停' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.getByRole('heading', { name: '封面生成已暂停', exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  assert.equal(await page.locator('.task-recovery').getByRole('button', { name: '继续生成封面', exact: true }).isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/science-pop-recovery-mobile.png', fullPage: true })
  assert.deepEqual(errors, [])
})

test('unconfirmed upload offers retransmission and an optional Baijiahao security window', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'upload', videoUrl: '/video.mp4', hasUploadAttempt: true, uploadStatus: 'uncertain',
    coverStyle: 'science-title-poster-v1', landscapeCoverUrl: '/landscape.jpg', portraitCoverUrl: '/portrait.jpg', message: '原编辑页文案已变化，不能继续' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  assert.equal(await page.locator('.task-recovery').getByRole('button', { name: '只核对上传结果', exact: true }).count(), 0)
  assert.equal(await page.locator('.task-recovery').getByRole('button', { name: '重新上传视频', exact: true }).isEnabled(), true)
  await page.locator('.task-recovery').getByRole('button', { name: '打开百家号窗口', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '百家号核对窗口', exact: true })
  await modal.getByText('原编辑页已关闭，已打开同一账号的内容管理', { exact: true }).waitFor()
  await modal.getByRole('button', { name: '全选当前输入框', exact: true }).click()
  await modal.getByLabel('输入到百家号页面的文字', { exact: true }).fill('查找原视频标题')
  await modal.getByRole('button', { name: '输入文字', exact: true }).click()
  await modal.getByRole('tab', { name: '内容管理', exact: true }).click()
  assert.deepEqual(writes.at(-1).body, { view: 'content' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await modal.getByRole('button', { name: '只核对上传结果', exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  assert.equal(writes.at(-1).path, `${BASE}/jobs/first/check-upload`)
  await page.locator('.queue-item').first().click()
  await page.locator('.task-recovery').getByRole('button', { name: '重新上传视频', exact: true }).click()
  await page.locator('.detail-meta .status-label').getByText('上传中', { exact: true }).waitFor()
  assert.equal(writes.at(-1).path, `${BASE}/jobs/first/upload`)
  assert.deepEqual(writes.at(-1).body, {})
  assert.equal(writes.filter(item => item.path.endsWith('/upload')).length, 1)
  assert.equal(writes.some(item => item.path.endsWith('/produce')), false)
  assert.deepEqual(errors, [])
})

test('automatic upload retransmission shows its schedule and can retry immediately without producing again', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'retry_wait', stage: 'upload', executionActive: false, uploadStatus: 'queued', videoUrl: '/video.mp4',
    hasUploadAttempt: true, coverStyle: 'science-title-poster-v1', landscapeCoverUrl: '/landscape.jpg', portraitCoverUrl: '/portrait.jpg',
    uploadRetry: { attempt: 8, nextRetryAt: '2026-11-02T00:04:00Z' }, message: '上传未取得提交回执，已安排自动重新上传' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.locator('.detail-meta .status-label').getByText('等待自动重传', { exact: true }).waitFor()
  await page.getByText(/已安排第 8 次自动重传/).waitFor()
  assert.equal(await page.locator('.task-recovery').getByRole('button', { name: '停止自动重传', exact: true }).isEnabled(), true)
  await page.getByRole('tab', { name: '进行中', exact: false }).click()
  assert.equal(await page.locator('.queue-item').count(), 1)
  await page.screenshot({ path: '/tmp/science-pop-upload-retry-desktop.png', fullPage: true })
  await page.locator('.task-recovery').getByRole('button', { name: '立即重新上传', exact: true }).click()
  await page.locator('.detail-meta .status-label').getByText('上传中', { exact: true }).waitFor()
  assert.deepEqual(writes, [{ method: 'POST', path: `${BASE}/jobs/first/upload`, body: {} }])
  assert.deepEqual(errors, [])
})

test('read-only Huasheng progress is actionable even while another task is making covers', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/12345', checkpoint: 'submitted', message: '暂时无法核验花生账号身份，请稍后检查' })
  Object.assign(jobs[1], { status: 'running', stage: 'covers' })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.locator('.task-recovery').getByRole('button', { name: '只查询制作进度', exact: true }).click()
  await page.getByRole('heading', { name: '花生制作已完成', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '继续导出下载', exact: true }).isEnabled(), true)
  assert.deepEqual(writes.map(item => item.path), [`${BASE}/jobs/first/check-huasheng`])
  assert.deepEqual(errors, [])
})

test('continuation exposes pending, accepted, remote progress and retry states on desktop and mobile', async t => {
  const { page, jobs, writes, errors } = await harness(t)
  Object.assign(jobs[0], { status: 'needs_attention', stage: 'produce', projectUrl: 'https://www.huasheng.cn/video/12345', checkpoint: 'submitted',
    message: '暂时无法核验花生账号身份，请稍后检查', huashengCheck: { checkedAt: '2026-11-02T00:00:00Z', status: 'completed', message: '分镜素材已就绪' } })
  await page.getByRole('button', { name: '刷新本地列表', exact: true }).click()
  await page.getByRole('heading', { name: '花生制作已完成', exact: true }).waitFor()
  assert.equal(await page.getByText('历史错误记录', { exact: true }).isVisible(), true)
  let release
  const pending = new Promise(resolve => { release = resolve })
  await page.route(`**${BASE}/jobs/first/sync`, async route => {
    writes.push({ method: 'POST', path: `${BASE}/jobs/first/sync`, body: route.request().postDataJSON() })
    await pending
    Object.assign(jobs[0], { status: 'waiting_remote', stage: 'export', executionActive: true, message: '花生正在导出：24%',
      huashengSync: { checkedAt: '2026-11-02T00:01:00Z', status: 'completed', message: '花生正在导出：24%', exportProgress: 24 } })
    await route.fulfill({ json: { code: 200, data: jobs[0] } })
  })
  await page.getByRole('button', { name: '继续导出下载', exact: true }).click()
  await page.locator('.project-sync').getByRole('button', { name: '正在接续…', exact: true }).waitFor()
  assert.equal(await page.locator('.project-sync').getByRole('button', { name: '正在接续…', exact: true }).isDisabled(), true)
  assert.equal(writes.length, 1)
  release()
  await page.locator('.action-notice').getByText('接续请求已受理，后台将自动按原设置继续，进度会自动更新。', { exact: true }).waitFor()
  await page.locator('.detail-head .status-label').getByText('花生导出中', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '正在自动接续', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '只查询制作进度', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), true)
  assert.match(await page.locator('.sync-result').innerText(), /导出 24%/)
  assert.equal(await page.locator('#science-script').isDisabled(), true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  assert.equal(await page.getByRole('button', { name: '正在自动接续', exact: true }).isVisible(), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '/tmp/science-pop-continuation-mobile.png', fullPage: true })
  Object.assign(jobs[0], { status: 'retry_wait', executionActive: false, message: '花生连接暂时中断，原任务已保留',
    automaticRetry: { attempt: 2, maxAttempts: 4, nextRetryAt: '2026-11-02T00:04:00Z' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  await page.locator('.detail-head .status-label').getByText('等待自动恢复', { exact: true }).waitFor()
  assert.match(await page.locator('.automatic-retry').innerText(), /第 2 \/ 4 次自动重试.*下次/)
  assert.equal(await page.getByRole('button', { name: '同步花生状态', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '立即恢复原任务', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '停止自动恢复', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), true)
  assert.equal(await page.getByRole('button', { name: '删除任务', exact: true }).isDisabled(), true)
  Object.assign(jobs[0], { status: 'needs_attention', automaticRetry: undefined,
    huashengSync: { checkedAt: '2026-11-02T00:05:00Z', status: 'error', message: '花生状态同步失败：接口暂不可用' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /深海动物为什么会发光/ }).click()
  await page.getByRole('heading', { name: '花生状态暂时无法查询', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '继续导出下载', exact: true }).count(), 0)
  assert.equal(writes.length, 1)
  assert.deepEqual(errors, [])
})
