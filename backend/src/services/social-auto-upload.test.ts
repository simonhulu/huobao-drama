import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectSocialUploadRuntime, inspectHistorySocialUploadRuntime, syncHistorySocialUploadLogin, inspectSocialUploadAccountRuntime, runSocialUploadBridge, runSocialUpload, confirmSocialUpload, inspectSocialPublication, reconcileSocialUpload, refreshSocialPublication, closeFailedSocialUpload, resetSocialUploadAttempt, updateSocialUploadVideoCovers, type SocialUploadPayload, type SocialUploadResult } from './social-auto-upload.js'

function processFixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'social-upload-process-'))
  const executable = path.join(directory, 'fake-python')
  fs.mkdirSync(path.join(directory, 'uploader'))
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.stdin.resume();
const action = process.argv[3];
console.log('SAU_PROGRESS ' + JSON.stringify({step:'landscape_cover',message:'正在处理横版封面'}));
if (action === 'timeout') {
  process.on('SIGTERM', () => setTimeout(() => { console.log('SAU_PROGRESS ' + JSON.stringify({step:'stopped',message:'已停止'})); process.exit(9); }, 120));
  setInterval(() => {}, 1000);
} else {
  console.log('SAU_RESULT ' + JSON.stringify({saved:true}));
}
`, { mode: 0o700 })
  const previous = { root: process.env.SOCIAL_AUTO_UPLOAD_ROOT, python: process.env.SOCIAL_AUTO_UPLOAD_PYTHON }
  process.env.SOCIAL_AUTO_UPLOAD_ROOT = directory
  process.env.SOCIAL_AUTO_UPLOAD_PYTHON = executable
  t.after(() => {
    for (const [key, value] of Object.entries({ SOCIAL_AUTO_UPLOAD_ROOT: previous.root, SOCIAL_AUTO_UPLOAD_PYTHON: previous.python })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, executable }
}

test('bridge preserves structured step progress independently of the final result', async t => {
  processFixture(t)
  const progress: unknown[] = []
  const result = await runSocialUploadBridge('fixture', {}, { onProgress: (message, detail) => progress.push({ message, detail }) })
  assert.deepEqual(result, { saved: true })
  assert.deepEqual(progress, [{ message: '正在处理横版封面', detail: { step: 'landscape_cover', message: '正在处理横版封面' } }])
})

test('moderation refresh uses a distinct read-only action and rejects another article receipt', async t => {
  const {directory, executable} = processFixture(t)
  const requestFile = path.join(directory, 'request.json'), receiptFile = path.join(directory, 'receipt.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); let input='';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({action:process.argv[3],request:JSON.parse(input)}));
  console.log('SAU_RESULT ' + fs.readFileSync(${JSON.stringify(receiptFile)}, 'utf8'));
});
`, {mode:0o700})
  const payload: SocialUploadPayload = {jobId:'280',scriptId:896,target:'baijiahao-video',accountName:'history_baijiahao',
    publicationMode:'publish',title:'原作品',description:'原作品',fingerprint:'original',videoPath:'/released/movie.mp4'}
  const previous: SocialUploadResult = {staged:true,saved:false,published:false,submitted:true,publicationStatus:'submitted',
    articleId:'1880702585364057145',publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880702585364057145',
    targetId:'ABC123',accountName:payload.accountName,editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',engine:'fixture'}
  const result = {...previous,published:true,publicationStatus:'published'}
  fs.writeFileSync(receiptFile, JSON.stringify(result))
  assert.equal((await refreshSocialPublication(payload, previous)).published,true)
  const called=JSON.parse(fs.readFileSync(requestFile,'utf8'))
  assert.equal(called.action,'refresh-publication')
  assert.deepEqual(called.request.payload,payload)
  assert.deepEqual(called.request.result,previous)
  for (const change of [{articleId:'1880702585364057146',publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880702585364057146'},
    {targetId:'DEF456'},{accountName:'other_account'},{submitted:false}]) {
    fs.writeFileSync(receiptFile, JSON.stringify({...result,...change}))
    await assert.rejects(refreshSocialPublication(payload,previous),/身份|可信/)
  }
})

test('cover revision preserves the old upload payload and validates a new unsubmitted editor receipt', async t => {
  const { directory, executable } = processFixture(t)
  const requestFile = path.join(directory, 'request.json'), receiptFile = path.join(directory, 'receipt.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); let input='';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({action:process.argv[3], request:JSON.parse(input)}));
  console.log('SAU_RESULT ' + fs.readFileSync(${JSON.stringify(receiptFile)}, 'utf8'));
});
`, { mode: 0o700 })
  const previous: SocialUploadPayload = { jobId: 'original', scriptId: 0, target: 'baijiahao-video', accountName: 'science_example',
    publicationMode: 'publish', title: '原视频', description: '原视频 #热爆趣创赛#', fingerprint: 'old',
    videoPath: '/tmp/original.mp4', landscapePath: '/tmp/old-wide.jpg', portraitPath: '/tmp/old-tall.jpg' }
  const revised = { ...previous, fingerprint: 'new', landscapePath: '/tmp/v2-wide.jpg', portraitPath: '/tmp/v2-tall.jpg' }
  const receipt = { verification: 'original_video_and_revised_covers', revisionId: 'a'.repeat(64), payloadDigest: 'a'.repeat(64),
    previousPayloadDigest: 'b'.repeat(64), videoSha256: 'c'.repeat(64), landscapeSha256: 'd'.repeat(64), portraitSha256: 'e'.repeat(64), targetId: 'ABC123',
    result: { staged: true, saved: false, published: false, targetId: 'ABC123', accountName: previous.accountName,
      editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', engine: 'fixture' } }
  fs.writeFileSync(receiptFile, JSON.stringify(receipt))
  assert.deepEqual(await updateSocialUploadVideoCovers(revised, previous), receipt)
  const called = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  assert.equal(called.action, 'update-video-covers'); assert.equal(called.request.updateVideoCovers, true)
  assert.deepEqual(called.request.payload, previous); assert.deepEqual(called.request.revisedPayload, revised)
  for (const patch of [{ accountName: 'science_other' }, { description: 'changed' }, { videoPath: '/tmp/replaced.mp4' }, { landscapePath: previous.landscapePath }])
    await assert.rejects(updateSocialUploadVideoCovers({ ...revised, ...patch }, previous), /原|独立/)
  for (const patch of [{ targetId: 'OTHER' }, { result: { ...receipt.result, saved: true } }, { result: { ...receipt.result, accountName: 'science_other' } },
    { revisionId: 'f'.repeat(64) }, { videoSha256: 'invalid' }]) {
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, ...patch }))
    await assert.rejects(updateSocialUploadVideoCovers(revised, previous), /可信/)
  }
})

test('bridge timeout waits for the previous writer to exit before releasing the queue for recovery', async t => {
  processFixture(t)
  const steps: string[] = []
  await assert.rejects(runSocialUploadBridge('timeout', {}, {
    timeoutMs: 2000, onProgress: (_message, detail) => { if (detail) steps.push(detail.step) },
  }), /超时/)
  assert.deepEqual(steps, ['landscape_cover', 'stopped'], 'recovery only begins after the writer stopped')
})

test('an explicit runtime refresh bypasses a cached failed platform check', async t => {
  const { directory, executable } = processFixture(t)
  const stateFile = path.join(directory, 'runtime.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
console.log('SAU_RESULT ' + fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
`, { mode: 0o700 })
  const state = { installed: true, version: 'test', message: 'ready', platforms: {
    baijiahao: { ready: true, message: 'ready' }, tencent: { ready: false, message: 'browser unavailable' },
  } }
  fs.writeFileSync(stateFile, JSON.stringify(state))
  assert.equal((await inspectSocialUploadRuntime(true)).platforms.tencent.ready, false)
  state.platforms.tencent = { ready: true, message: 'recovered' }
  fs.writeFileSync(stateFile, JSON.stringify(state))
  assert.equal((await inspectSocialUploadRuntime()).platforms.tencent.ready, false, 'ordinary checks can reuse the recent result')
  assert.equal((await inspectSocialUploadRuntime(true)).platforms.tencent.ready, true, 'an explicit retry must observe the recovered browser immediately')
})

test('draft reconciliation stays read-only unless queue retry explicitly allows repair of a rejected save', async t => {
  const { directory, executable } = processFixture(t)
  const requestFile = path.join(directory, 'request.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let text = ''; process.stdin.on('data', part => text += part);
process.stdin.on('end', () => {
  const request = JSON.parse(text); fs.writeFileSync(${JSON.stringify(requestFile)}, text);
  console.log('SAU_RESULT ' + JSON.stringify({...request.result, saved:true}));
});
`, { mode: 0o700 })
  const payload: SocialUploadPayload = { jobId: '32', scriptId: 71, target: 'tencent-video', title: '朱由校为何传位弟弟。', description: '原文案', fingerprint: 'original' }
  const result: SocialUploadResult = { staged: true, saved: false, published: false, targetId: 'ABC123', editorUrl: 'https://channels.weixin.qq.com/platform/post/create', engine: 'test' }
  await reconcileSocialUpload(payload, result)
  assert.equal(JSON.parse(fs.readFileSync(requestFile, 'utf8')).repairRejectedSave, undefined)
  await reconcileSocialUpload(payload, result, { repairRejectedSave: true })
  const retried = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  assert.equal(retried.repairRejectedSave, true)
  assert.deepEqual(retried.payload, payload, 'retry must retain the original payload identity')
  const namedPayload: SocialUploadPayload = { ...payload, target: 'baijiahao-video', accountName: 'first' }
  const namedResult: SocialUploadResult = { ...result, editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit', accountName: 'second' }
  await assert.rejects(reconcileSocialUpload(namedPayload, namedResult), /未获得与任务账号绑定的可信上传结果/, 'a receipt from a different account cannot complete this task')
  assert.equal((await reconcileSocialUpload(namedPayload, { ...namedResult, accountName: 'first' })).accountName, 'first')
})

test('named account runtime checks use their own account and reject unsafe identifiers', async t => {
  const { directory, executable } = processFixture(t)
  const requestFile = path.join(directory, 'request.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let input = ''; process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({action:process.argv[3], request:JSON.parse(input)}));
  console.log('SAU_RESULT ' + JSON.stringify({ready:true,message:'fixture account ready'}));
});
`, { mode: 0o700 })
  assert.deepEqual(await inspectSocialUploadAccountRuntime('cba_first'), { ready: true, message: 'fixture account ready' })
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  assert.equal(request.action, 'inspect-account')
  assert.equal(request.request.accountName, 'cba_first')
  assert.equal(request.request.keepBrowser, true, 'the ready browser must be reused by the following upload')
  await assert.rejects(inspectSocialUploadAccountRuntime('../other'), /账号编号无效/)
})

test('history inspection uses isolated background sessions, caches checks and invalidates after explicit login sync', async t => {
  const { directory, executable } = processFixture(t)
  const stateFile = path.join(directory, 'history-runtime.json')
  const requestFile = path.join(directory, 'history-request.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  const request = JSON.parse(input); const action = process.argv[3];
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({action,request}));
  const result = action === 'sync-history' ? {synced:true,platform:request.platform,message:'后台已同步'} : JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  console.log('SAU_RESULT ' + JSON.stringify(result));
});
`, { mode: 0o700 })
  const value = { installed: true, execution: 'background', version: 'test', message: '后台上传', platforms: {
    baijiahao: { ready: true, message: 'ready', sessionMode: 'background', accountName: 'history_baijiahao' },
    tencent: { ready: true, message: 'ready', sessionMode: 'background', accountName: 'history_tencent' },
  } }
  fs.writeFileSync(stateFile, JSON.stringify(value))
  assert.equal((await inspectHistorySocialUploadRuntime(true)).platforms.tencent.ready, true)
  assert.equal(JSON.parse(fs.readFileSync(requestFile, 'utf8')).action, 'inspect-history')
  value.platforms.tencent.ready = false
  fs.writeFileSync(stateFile, JSON.stringify(value))
  assert.equal((await inspectHistorySocialUploadRuntime()).platforms.tencent.ready, true)
  assert.equal((await syncHistorySocialUploadLogin('tencent')).synced, true)
  const sync = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  assert.equal(sync.action, 'sync-history')
  assert.equal(sync.request.platform, 'tencent')
  assert.equal((await inspectHistorySocialUploadRuntime()).platforms.tencent.ready, false)
  value.platforms.baijiahao.accountName = 'cba_unrelated'
  fs.writeFileSync(stateFile, JSON.stringify(value))
  const rejected = await inspectHistorySocialUploadRuntime(true)
  assert.equal(rejected.installed, false)
  assert.match(rejected.message, /账号绑定/)
})

test('fresh retry resets its old attempt and keeps already-confirmed account receipts', async t => {
  const { directory, executable } = processFixture(t)
  const requestFile = path.join(directory, 'attempt-request.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  const request = JSON.parse(input), payload = request.payload;
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({action:process.argv[3],payload,
    ...(request.allowDuplicateSubmission === undefined ? {} : {allowDuplicateSubmission:request.allowDuplicateSubmission})}));
  const result = payload.title === 'saved' ? {result:{staged:true,saved:true,published:false,targetId:'ABC123',
    editorUrl:'https://channels.weixin.qq.com/platform/post/create',engine:'fixture',accountName:payload.accountName}} : {closed:true,archived:true};
  console.log('SAU_RESULT ' + JSON.stringify(result));
});
`, { mode: 0o700 })
  const payload: SocialUploadPayload = {jobId:'71',scriptId:115,target:'tencent-video',accountName:'history_tencent',title:'failed',description:'原文案',fingerprint:'original'}
  assert.deepEqual(await closeFailedSocialUpload(payload), {})
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), {action:'close-failed',payload})
  assert.deepEqual(await resetSocialUploadAttempt(payload), {})
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), {action:'reset-attempt',payload})
  assert.deepEqual(await resetSocialUploadAttempt(payload, {allowDuplicateSubmission:true}), {})
  assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), {action:'reset-attempt',payload,allowDuplicateSubmission:true})
  for (const allowDuplicateSubmission of [false, 'true', 1]) {
    await resetSocialUploadAttempt(payload, {allowDuplicateSubmission:allowDuplicateSubmission as boolean})
    assert.deepEqual(JSON.parse(fs.readFileSync(requestFile, 'utf8')), {action:'reset-attempt',payload})
  }
  const complete = await resetSocialUploadAttempt({...payload,title:'saved'})
  assert.equal(complete.result?.saved,true)
  assert.equal(complete.result?.accountName,'history_tencent')
})

test('duplicate opt-in still returns confirmed publication receipts and rejects a receipt from another account', async t => {
  const { directory, executable } = processFixture(t)
  const receiptFile = path.join(directory, 'publication-receipt.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); process.stdin.resume();
console.log('SAU_RESULT ' + fs.readFileSync(${JSON.stringify(receiptFile)}, 'utf8'));
`, { mode: 0o700 })
  const payload: SocialUploadPayload = { jobId:'science-attempt-1',scriptId:0,target:'baijiahao-video',accountName:'science_example',
    publicationMode:'publish',title:'原作品',description:'原作品',fingerprint:'original' }
  const receipt: SocialUploadResult = { staged:true,saved:false,published:false,submitted:true,publicationStatus:'submitted',
    articleId:'1880027026933416669',publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669',
    targetId:'ABC123',accountName:payload.accountName,editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',engine:'fixture' }
  for (const published of [false, true]) {
    const confirmed = { ...receipt, published, publicationStatus:published ? 'published' : 'submitted' }
    fs.writeFileSync(receiptFile, JSON.stringify({result:confirmed}))
    assert.deepEqual(await resetSocialUploadAttempt(payload, {allowDuplicateSubmission:true}), {result:confirmed})
  }
  fs.writeFileSync(receiptFile, JSON.stringify({result:{...receipt,accountName:'science_other'}}))
  await assert.rejects(resetSocialUploadAttempt(payload, {allowDuplicateSubmission:true}), /^Error: 未获得与任务账号绑定的可信上传结果$/)
})

test('publish mode stages without saving and confirms via explicit publish with a platform receipt', async t => {
  const { directory, executable } = processFixture(t)
  const requestFile = path.join(directory, 'publish-request.json')
  const receiptFile = path.join(directory, 'receipt.json')
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify({action:process.argv[3],request:JSON.parse(input)}));
  console.log('SAU_RESULT ' + fs.readFileSync(${JSON.stringify(receiptFile)}, 'utf8'));
});
`, { mode: 0o700 })
  const payload: SocialUploadPayload = {jobId:'99',scriptId:71,target:'baijiahao-video',accountName:'history_baijiahao',
    title:'原片',description:'原片',fingerprint:'version-one',publicationMode:'publish'}
  const staged: SocialUploadResult = {staged:true,saved:false,published:false,targetId:'ABC123',
    editorUrl:'https://baijiahao.baidu.com/builder/rc/edit',engine:'fixture',accountName:payload.accountName}
  fs.writeFileSync(receiptFile,JSON.stringify(staged))
  assert.deepEqual(await runSocialUpload(payload,{saveDraft:false}),staged)
  assert.equal(JSON.parse(fs.readFileSync(requestFile,'utf8')).request.saveDraft,false)
  await assert.rejects(runSocialUpload(payload,{saveDraft:true}),/不能同时保存草稿/)
  fs.writeFileSync(receiptFile,JSON.stringify({ready:true,writes:false,targetId:'ABC123'}))
  await inspectSocialPublication(payload)
  assert.equal(JSON.parse(fs.readFileSync(requestFile,'utf8')).action,'publish-preflight')
  const submitted: SocialUploadResult = {...staged,submitted:true,publicationStatus:'submitted',articleId:'1880027026933416669',
    publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669'}
  fs.writeFileSync(receiptFile,JSON.stringify(submitted))
  assert.deepEqual(await confirmSocialUpload(payload,staged),submitted)
  const publish=JSON.parse(fs.readFileSync(requestFile,'utf8'))
  assert.equal(publish.action,'publish')
  assert.equal(publish.request.confirmPublish,true)
  assert.equal(publish.request.confirmSave,undefined)
  for(const invalid of [{...staged,saved:true},{...submitted,articleId:'999'},{...submitted,published:true},
    {...submitted,accountName:'different'}, {...submitted,publicationStatus:'draft'}]) {
    fs.writeFileSync(receiptFile,JSON.stringify(invalid))
    await assert.rejects(confirmSocialUpload(payload,staged),/可信上传结果/)
  }
  await assert.rejects(confirmSocialUpload({...payload,target:'tencent-video'},staged),/仅支持百家号视频/)
})
