import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { recoverCbaUpload, checkCbaUploadResult, type CbaUploadRecoveryCurrent, type CbaUploadRecoveryOptions, type CbaUploadRecoveryPatch } from './cba-upload-recovery.js'
import type { SocialUploadCheckpoint, SocialUploadPayload, SocialUploadResult } from './social-auto-upload.js'

function fixture(overrides: Partial<CbaUploadRecoveryCurrent> = {}) {
  const payload: SocialUploadPayload = { jobId: randomUUID(), scriptId: 1, target: 'baijiahao-video', accountName: 'sports', title: '比赛新闻', description: '比赛新闻', fingerprint: 'original-fingerprint', videoPath: '/original/news.mp4' }
  const receipt: SocialUploadResult = { accountName: 'sports', staged: true, saved: true, published: false, editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123456', targetId: 'ABC123', engine: 'fixture' }
  const current: CbaUploadRecoveryCurrent = { id: payload.jobId, target: payload.target, accountName: payload.accountName, fingerprint: payload.fingerprint, inputDigest: 'render-one', status: 'queued', dispatched: false, payload, ...overrides }
  const calls: string[] = []; const patches: CbaUploadRecoveryPatch[] = []
  let checkpoint: SocialUploadCheckpoint = { action: 'complete', phase: 'saved', message: 'saved', result: receipt }
  const options: CbaUploadRecoveryOptions = {
    currentInputDigest: 'render-one', readOnlyDelayMs: 0, maxReadOnlyAttempts: 3,
    persist: async patch => { patches.push(structuredClone(patch)); Object.assign(current, patch) },
    runtime: {
      inspectSocialUploadCheckpoint: async () => { calls.push('checkpoint'); return checkpoint },
      inspectSocialUploadAccountRuntime: async () => { calls.push('account'); return { ready: true, message: 'ready' } },
      inspectSocialUploadRuntime: async () => { throw Error('named account must not use the global browser') },
      runSocialUpload: async (_payload, operation) => { calls.push('upload'); assert.equal(operation.saveDraft, false); checkpoint = { action: 'save', phase: 'staged', message: 'staged', result: { ...receipt, saved: false, draftUrl: undefined } }; return checkpoint.result! },
      resumeSocialUpload: async () => { calls.push('resume'); checkpoint = { action: 'save', phase: 'staged', message: 'staged', result: { ...receipt, saved: false, draftUrl: undefined } }; return checkpoint.result! },
      confirmSocialUpload: async () => { calls.push('save'); return receipt },
      reconcileSocialUpload: async (_payload, _result, operation) => { calls.push('reconcile'); assert.notEqual(operation?.repairRejectedSave, true); return receipt },
    },
  }
  return { payload, current, receipt, options, calls, patches, setCheckpoint: (value: SocialUploadCheckpoint) => { checkpoint = value } }
}

test('complete receipts are validated without requiring a live browser', async () => {
  const f = fixture(); const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.decision, 'saved'); assert.equal(result.matchesCurrentVersion, true)
  assert.deepEqual(f.calls, ['checkpoint'])
})

test('duplicate-accepting callers can restart ambiguous work but never bypass receipt account or editor binding', async () => {
  const ambiguous = fixture({ status: 'uncertain', dispatched: true })
  ambiguous.setCheckpoint({ action: 'upload', phase: 'new', message: 'missing checkpoint' })
  assert.equal((await recoverCbaUpload(ambiguous.payload, ambiguous.current, ambiguous.options)).restartable, true)
  for (const receipt of [{ accountName: 'another' }, { editorUrl: 'https://other.invalid/builder/rc/edit?type=videoV2' }]) {
    const f = fixture()
    f.setCheckpoint({ action: 'complete', phase: 'saved', message: 'saved', result: { ...f.receipt, ...receipt } })
    const result = await recoverCbaUpload(f.payload, f.current, f.options)
    assert.equal(result.restartable, false); assert.notEqual(result.decision, 'saved')
    assert.deepEqual(f.calls, ['checkpoint'])
  }
})

test('read-only result checks never execute available upload, resume or save actions', async () => {
  for (const action of ['upload', 'resume', 'save', 'manual', 'busy'] as const) {
    const f = fixture({ status: 'uncertain', dispatched: true })
    f.setCheckpoint({ action, phase: 'staged', message: '待人工检查', ...(action === 'save' ? { result: { ...f.receipt, saved: false } } : {}) })
    const result = await checkCbaUploadResult(f.payload, f.current, f.options.runtime)
    assert.notEqual(result.status, 'complete')
    assert.equal(result.result, undefined)
    assert.deepEqual(f.calls, ['checkpoint'])
    assert.deepEqual(f.patches, [])
  }
})

test('read-only checks adopt trusted receipts and reconcile requested saves without saving again', async () => {
  const f = fixture({ status: 'uncertain', dispatched: true })
  let result = await checkCbaUploadResult(f.payload, f.current, f.options.runtime)
  assert.equal(result.status, 'complete'); assert.deepEqual(result.result, f.receipt)
  assert.deepEqual(f.calls, ['checkpoint'])
  f.calls.length = 0
  f.current.result = { ...f.receipt, saved: false, draftUrl: undefined }
  f.setCheckpoint({ action: 'reconcile', phase: 'save_requested', message: '只读核对', result: f.current.result })
  result = await checkCbaUploadResult(f.payload, f.current, f.options.runtime)
  assert.equal(result.status, 'complete'); assert.deepEqual(f.calls, ['checkpoint', 'reconcile'])
  assert.deepEqual(f.patches, [])
})

test('read-only checks reject mismatched bindings and cross-account receipts', async () => {
  const f = fixture()
  await assert.rejects(checkCbaUploadResult({ ...f.payload, accountName: 'other' }, f.current, f.options.runtime), /原上传任务/)
  assert.deepEqual(f.calls, [])
  f.setCheckpoint({ action: 'complete', phase: 'saved', message: 'wrong', result: { ...f.receipt, accountName: 'other' } })
  await assert.rejects(checkCbaUploadResult(f.payload, f.current, f.options.runtime), /可信草稿回执/)
  assert.deepEqual(f.calls, ['checkpoint'])
})

test('read-only publication checks never mistake an unsaved editor for a completed submission', async () => {
  const f = fixture()
  f.payload.publicationMode = 'publish'
  f.setCheckpoint({ action: 'complete', phase: 'submitted', message: 'unproven', result: { ...f.receipt, saved: false, draftUrl: undefined } })
  await assert.rejects(checkCbaUploadResult(f.payload, f.current, f.options.runtime), /提交回执/)
  assert.deepEqual(f.calls, ['checkpoint']); assert.deepEqual(f.patches, [])
})

for (const [name, change] of [
  ['false saved', { saved: false }], ['wrong account', { accountName: 'other' }],
  ['wrong platform', { editorUrl: 'https://channels.weixin.qq.com/platform/post/create' }],
  ['missing draft identity', { draftUrl: undefined }],
  ['duplicate draft identity', { draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123&article_id=456' }],
  ['published receipt', { published: true }],
] as Array<[string, Record<string, unknown>]>) {
  test(`rejects ${name} instead of reporting success`, async () => {
    const f = fixture(); f.setCheckpoint({ action: 'complete', phase: 'saved', message: 'saved', result: { ...f.receipt, ...change } as SocialUploadResult })
    const result = await recoverCbaUpload(f.payload, f.current, f.options)
    assert.equal(result.decision, 'uncertain'); assert.equal(result.status, 'uncertain')
    assert.deepEqual(f.calls, ['checkpoint'])
  })
}

test('rejects changes to the original fingerprint and payload before any operation', async () => {
  const f = fixture()
  const result = await recoverCbaUpload({ ...f.payload, fingerprint: 'new-fingerprint' }, f.current, f.options)
  assert.equal(result.decision, 'blocked'); assert.deepEqual(f.calls, [])
})

test('save requested is reconciled read-only, even if a contradictory checkpoint asks to save', async () => {
  const f = fixture({ status: 'uncertain', dispatched: true }); f.current.result = { ...f.receipt, saved: false, draftUrl: undefined }
  f.setCheckpoint({ action: 'save', phase: 'save_requested', message: 'ambiguous', result: f.current.result })
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'saved'); assert.ok(f.calls.includes('reconcile')); assert.ok(!f.calls.includes('save')); assert.ok(!f.calls.includes('upload'))
})

test('ambiguous dispatched work never uploads again when its checkpoint is missing', async () => {
  const f = fixture({ status: 'uncertain', dispatched: true })
  f.setCheckpoint({ action: 'upload', phase: 'new', message: 'missing' })
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'uncertain'); assert.deepEqual(f.calls, ['checkpoint'])
})

test('new upload awaits the durable dispatch record and requires a separate save checkpoint', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  const persist = f.options.persist
  f.options.persist = async patch => { await Promise.resolve(); await persist(patch); if (patch.dispatched) f.calls.push('persist-dispatched') }
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'saved')
  assert.ok(f.calls.indexOf('persist-dispatched') < f.calls.indexOf('upload'))
  assert.ok(f.calls.indexOf('checkpoint', f.calls.indexOf('upload') + 1) < f.calls.indexOf('save'))
  assert.equal(f.calls.filter(action => action === 'upload').length, 1)
})

test('resumes only the original snapshot after restart, then reads permission to save', async () => {
  const f = fixture({ dispatched: true, status: 'uncertain' }); f.setCheckpoint({ action: 'resume', phase: 'uploading', message: 'resume' })
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'saved'); assert.ok(f.calls.includes('resume')); assert.ok(f.calls.includes('save')); assert.ok(!f.calls.includes('upload'))
})

test('an ambiguous write gets bounded read-only recovery and is never repeated', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  f.options.runtime.runSocialUpload = async () => { f.calls.push('upload'); f.setCheckpoint({ action: 'reconcile', phase: 'save_requested', message: 'unknown', result: { ...f.receipt, saved: false } }); throw Error('ECONNRESET') }
  let checks = 0
  f.options.runtime.reconcileSocialUpload = async () => { f.calls.push('reconcile'); if (++checks < 3) throw Error('network timeout'); return f.receipt }
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'saved'); assert.equal(checks, 3); assert.equal(f.calls.filter(x => x === 'upload').length, 1)
  assert.ok(result.attempts.some(x => x.action === 'upload' && x.outcome === 'failed'))
})

test('a checkpoint proving initialization failed before selection retains the actual error without another write', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  f.options.runtime.runSocialUpload = async () => {
    f.calls.push('upload')
    f.setCheckpoint({ action: 'resume', phase: 'initializing', message: '尚未传入素材，继续初始化' })
    throw Error('百家号视频上传控件未就绪，尚未传入素材')
  }
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.decision, 'failed'); assert.equal(result.status, 'failed')
  assert.match(result.message, /尚未传入素材.*百家号视频上传控件未就绪/)
  assert.doesNotMatch(result.message, /结果尚未确认/)
  assert.equal(result.dispatched, true, 'retain the durable dispatch record even when selection never began')
  assert.deepEqual(f.calls, ['checkpoint', 'account', 'upload', 'checkpoint'])
})

test('an uncertain media upload keeps the original failure reason and never retries the write', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  f.options.runtime.runSocialUpload = async () => {
    f.calls.push('upload')
    f.setCheckpoint({ action: 'resume', phase: 'uploading', message: '继续已上传视频封面' })
    throw Error('网络上传中断 ECONNRESET')
  }
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'uncertain')
  assert.match(result.message, /网络上传中断 ECONNRESET/)
  assert.deepEqual(f.calls, ['checkpoint', 'account', 'upload', 'checkpoint'])
})

test('persistent network errors stop at the read-only retry bound', async () => {
  const f = fixture({ status: 'uncertain', dispatched: true })
  let checks = 0; f.options.runtime.inspectSocialUploadCheckpoint = async () => { checks++; throw Error('ETIMEDOUT') }
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'uncertain'); assert.equal(checks, 3)
})

test('an account lock acquired before save defers recovery without marking login invalid or uploading again', async () => {
  const f = fixture({ status: 'uncertain', dispatched: true })
  const staged = { ...f.receipt, saved: false, draftUrl: undefined }
  f.current.result = staged
  f.setCheckpoint({ action: 'save', phase: 'staged', message: 'prepared', result: staged })
  const save = f.options.runtime.confirmSocialUpload
  f.options.runtime.confirmSocialUpload = async () => {
    f.calls.push('save')
    const message = '该账号的另一项上传或账号同步正在运行，稍后继续；本次未操作平台'
    f.setCheckpoint({ action: 'busy', phase: 'busy', message })
    throw Error(message)
  }
  const waiting = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(waiting.decision, 'busy'); assert.equal(waiting.status, 'uncertain')
  assert.deepEqual(f.calls, ['checkpoint', 'account', 'save', 'checkpoint'])
  f.options.runtime.confirmSocialUpload = save
  f.setCheckpoint({ action: 'save', phase: 'staged', message: 'prepared', result: staged })
  const resumed = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(resumed.decision, 'saved')
  assert.equal(f.calls.includes('upload'), false)
})

test('login and captcha failures block without retrying a write', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  f.options.runtime.inspectSocialUploadAccountRuntime = async () => ({ ready: false, message: '需要重新登录并完成验证码' })
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'blocked'); assert.ok(!f.calls.includes('upload'))
})

test('cancellation after durable dispatch prevents the actual side effect', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  let cancelled = false; f.options.isCancelled = () => cancelled
  const persist = f.options.persist; f.options.persist = async patch => { await persist(patch); if (patch.dispatched) cancelled = true }
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.decision, 'cancelled'); assert.ok(!f.calls.includes('upload')); assert.equal(result.dispatched, true)
})

test('old render completion is preserved without claiming the current render was uploaded', async () => {
  const f = fixture(); f.options.currentInputDigest = 'render-two'
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'saved'); assert.equal(result.matchesCurrentVersion, false)
  assert.equal(f.current.inputDigest, 'render-one'); assert.ok(f.patches.every(patch => !('inputDigest' in patch)))
})

test('a changed render cannot trigger new writes using the old upload snapshot', async () => {
  const f = fixture(); f.options.currentInputDigest = 'render-two'; f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  const result = await recoverCbaUpload(f.payload, f.current, f.options)
  assert.equal(result.status, 'blocked'); assert.ok(!f.calls.includes('upload'))
})

test('concurrent and sequential duplicate calls cannot dispatch the same upload again', async () => {
  const f = fixture(); f.setCheckpoint({ action: 'upload', phase: 'new', message: 'new' })
  const stale = structuredClone(f.current)
  let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve })
  f.options.runtime.runSocialUpload = async () => { f.calls.push('upload'); await paused; throw Error('network timeout') }
  const first = recoverCbaUpload(f.payload, f.current, f.options)
  while (!f.calls.includes('upload')) await new Promise(resolve => setImmediate(resolve))
  const duplicate = await recoverCbaUpload(f.payload, stale, f.options)
  assert.equal(duplicate.decision, 'busy')
  release(); await first
  const later = await recoverCbaUpload(f.payload, stale, f.options)
  assert.equal(later.status, 'uncertain'); assert.equal(f.calls.filter(x => x === 'upload').length, 1)
})
