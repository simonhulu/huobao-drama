import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runCbaProductionPipeline, type PipelineDependencies } from './cba-production-pipeline.js'

function fixture(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-coordinator-')), filename = path.join(directory, 'job.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const mediaPath = path.join(directory, 'source.mp4'); fs.writeFileSync(mediaPath, 'fixture')
  const read = () => JSON.parse(fs.readFileSync(filename, 'utf8'))
  const write = (job: any) => fs.writeFileSync(filename, JSON.stringify(job))
  write({ digest: 'edit-1', media: [{ path: mediaPath }], completeEdit: true })
  const events: string[] = []
  let ready = false, reviewCalls = 0, editCalls = 0, stopped = false
  const decisions: string[] = ['pass']
  const deps: PipelineDependencies = {
    command: async args => {
      events.push(args[0]!)
      if (args[0] === 'review') { const job = read(); job.review = { digest: job.digest, complete: true }; write(job) }
      if (args[0] === 'render') ready = true
    },
    edit: async () => { events.push('editing'); editCalls++; const job = read(); job.completeEdit = true; job.digest = `edit-${editCalls + 1}`; write(job) },
    review: async packet => { events.push('independent-review'); reviewCalls++; return { editorialDigest: packet.digest, packetSha256: packet.packetSha256, decision: decisions.shift() || 'pass', issues: [{ code: 'news', message: '需补充原报道核心事件' }] } },
    verifyDelivery: async () => ready ? null : { stage: 'rendering', message: 'pending' },
    stopped: () => stopped,
    progress: () => {},
    gates: {
      editorialDigest: job => job.digest,
      validateJob: job => ({ errors: job.completeEdit ? [] : ['incomplete edit'] }),
      prepareEditorialAudit: async job => ({ digest: job.digest, packetPath: path.join(directory, 'packet.json'), packetSha256: 'actual-packet', imagePaths: [] }),
      validateEditorialAudit: job => ({ valid: job.automation?.audit?.decision === 'pass' && job.automation.audit.editorialDigest === job.digest, errors: ['独立审核未通过'] }),
    },
  }
  return { directory, read, write, events, deps, decisions, setReady: (value: boolean) => { ready = value }, stop: () => { stopped = true }, counts: () => ({ reviewCalls, editCalls }) }
}

test('old failure journals cannot substitute for a fresh acquisition; paid work follows an independent pass', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.directory, 'production.json'), JSON.stringify({ version: 1, attempts: [{ step: 'acquire-media', status: 'failed', message: 'old network error' }] }))
  const result = await runCbaProductionPipeline(f.directory, 'producer-1', f.deps)
  assert.equal(result.ready, true)
  assert.deepEqual(f.events, ['acquire-media', 'independent-review', 'review', 'approve', 'tts', 'render'])
  assert.notEqual(f.read().automation.audit.reviewer.runId, 'producer-1')
  const journal = JSON.parse(fs.readFileSync(path.join(f.directory, 'production.json'), 'utf8'))
  assert.equal(journal.attempts.filter((a: any) => a.step === 'acquire-media').length, 2)
  assert.ok(journal.attempts.at(-1).finishedAt)
})

test('a malformed project journal releases ownership and preserves evidence before the queue advances', async t => {
  const f = fixture(t), journalFile = path.join(f.directory, 'production.json')
  fs.writeFileSync(journalFile, '{incomplete journal')
  await assert.rejects(runCbaProductionPipeline(f.directory, 'malformed-journal', f.deps), SyntaxError)
  assert.equal(fs.existsSync(path.join(f.directory, '.production.lock')), false)
  assert.equal(fs.readFileSync(journalFile, 'utf8'), '{incomplete journal')
  assert.deepEqual(f.events, [])
})

test('pipeline failures identify the actual failed command so only TTS is eligible for provider fallback', async t => {
  for (const failedStep of ['acquire-media', 'tts', 'render']) await t.test(failedStep, async sub => {
    const f = fixture(sub), command = f.deps.command
    f.deps.command = async args => {
      if (args[0] === failedStep) throw Error('MiniMax 2056: 已达到 Token Plan 用量上限')
      await command(args)
    }
    const result = await runCbaProductionPipeline(f.directory, 'identify-step', f.deps)
    assert.equal(result.ready, false); assert.equal(result.failedStep, failedStep)
    assert.equal(fs.existsSync(path.join(f.directory, '.production.lock')), false)
  })
})

test('an incomplete preview preserves its current validation error and never attempts approval or paid work', async t => {
  const f = fixture(t), command = f.deps.command
  const reason = '新闻段落 n1 含素材转述口吻“新浪”；来源保留在后台'
  f.deps.command = async args => {
    await command(args)
    if (args[0] === 'review') {
      const job = f.read(); job.review.complete = false; f.write(job)
      fs.mkdirSync(path.join(f.directory, 'review'), { recursive: true })
      fs.writeFileSync(path.join(f.directory, 'review/validation.json'), JSON.stringify({ errors: [reason] }))
    }
  }
  const result = await runCbaProductionPipeline(f.directory, 'incomplete-preview', f.deps)
  assert.equal(result.ready, false)
  assert.equal(result.failedStep, 'review')
  assert.match(result.message, /素材转述口吻/)
  assert.deepEqual(f.events, ['acquire-media', 'independent-review', 'review'])
})

test('a preview must describe the current edit before approval', async t => {
  const f = fixture(t), command = f.deps.command
  f.deps.command = async args => {
    await command(args)
    if (args[0] === 'review') { const job = f.read(); job.review.digest = 'previous-edit'; f.write(job) }
  }
  const result = await runCbaProductionPipeline(f.directory, 'stale-preview', f.deps)
  assert.equal(result.ready, false)
  assert.equal(result.failedStep, 'review')
  assert.equal(f.events.includes('approve'), false)
})

test('review rejection gets one content repair then leaves actionable attention', async t => {
  const f = fixture(t); f.decisions.splice(0, 1, 'revise', 'revise', 'revise')
  const result = await runCbaProductionPipeline(f.directory, 'producer-2', f.deps)
  assert.equal(result.ready, false); assert.equal(result.stage, 'auditing')
  assert.deepEqual(f.counts(), { reviewCalls: 2, editCalls: 1 })
  assert.equal(f.events.includes('tts'), false); assert.equal(f.events.includes('approve'), false)
  assert.match(result.message, /一轮.*仍未通过/)
  assert.equal(fs.existsSync(path.join(f.directory, '.production.lock')), false)
})

test('a corrected second audit can pass, and blocked evidence never triggers paid work', async t => {
  const f = fixture(t); f.decisions.splice(0, 1, 'revise', 'pass')
  assert.equal((await runCbaProductionPipeline(f.directory, 'producer-3', f.deps)).ready, true)
  assert.ok(f.events.indexOf('editing') < f.events.indexOf('tts'))
  const other = fixture(t); other.decisions.splice(0, 1, 'blocked')
  assert.equal((await runCbaProductionPipeline(other.directory, 'producer-4', other.deps)).ready, false)
  assert.deepEqual(other.events, ['acquire-media', 'independent-review'])
})

test('resume reuses a current independent audit but changes invalidate it; delivered files bypass all production', async t => {
  const f = fixture(t)
  await runCbaProductionPipeline(f.directory, 'producer-5', f.deps)
  f.events.length = 0
  assert.equal((await runCbaProductionPipeline(f.directory, 'resume-1', f.deps)).ready, true)
  assert.equal(f.events.length, 0)
  f.setReady(false)
  await runCbaProductionPipeline(f.directory, 'resume-2', f.deps)
  assert.equal(f.events.includes('independent-review'), false)
  f.events.length = 0; f.setReady(false)
  const job = f.read(); job.digest = 'changed-script'; f.write(job)
  await runCbaProductionPipeline(f.directory, 'resume-3', f.deps)
  assert.equal(f.events.includes('independent-review'), true)
})

test('concurrent ownership and cancellation prevent a new paid step', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.directory, '.production.lock'), String(process.pid))
  assert.equal((await runCbaProductionPipeline(f.directory, 'concurrent', f.deps)).ready, false)
  assert.equal(f.events.length, 0)
  fs.unlinkSync(path.join(f.directory, '.production.lock'))
  const review = f.deps.review; f.deps.review = async (...args) => { const result = await review(...args); f.stop(); return result }
  assert.equal((await runCbaProductionPipeline(f.directory, 'cancelled', f.deps)).ready, false)
  assert.equal(f.events.includes('tts'), false)
})

test('a missing cleanup lock does not replace the actual production failure', async t => {
  const f = fixture(t)
  f.deps.review = async () => {
    fs.unlinkSync(path.join(f.directory, '.production.lock'))
    throw Error('模型服务并发额度已满，请稍后继续')
  }
  const result = await runCbaProductionPipeline(f.directory, 'lost-lock', f.deps)
  assert.equal(result.ready, false)
  assert.equal(result.stage, 'auditing')
  assert.match(result.message, /模型服务并发额度已满/)
  assert.equal(f.events.includes('tts'), false)
})

test('the backend binds opaque metadata while content changes during an audit invalidate it', async t => {
  const f = fixture(t)
  f.deps.review = async () => ({ decision: 'pass', editorialDigest: 'model copied a label', packetSha256: 'wrong' })
  assert.equal((await runCbaProductionPipeline(f.directory, 'bound-packet', f.deps)).ready, true)
  assert.equal(f.read().automation.audit.packetSha256, 'actual-packet')
  f.setReady(false); f.events.length = 0
  const job = f.read(); delete job.automation.audit; f.write(job)
  f.deps.review = async () => { const changed = f.read(); changed.digest = 'concurrent-edit'; f.write(changed); return { decision: 'pass' } }
  assert.equal((await runCbaProductionPipeline(f.directory, 'concurrent-edit', f.deps)).ready, false)
  assert.equal(f.events.includes('tts'), false)
})

test('resuming a blocked audit repairs its persisted findings before another review', async t => {
  const f = fixture(t)
  const job = f.read(); job.automation = { producerRunId: 'old-producer', audit: { decision: 'blocked', editorialDigest: job.digest, issues: [{ code: 'missing_text', message: '缺少原文正文' }] } }; f.write(job)
  let instructions = ''
  const edit = f.deps.edit; f.deps.edit = async value => { instructions = value; await edit(value) }
  assert.equal((await runCbaProductionPipeline(f.directory, 'resume-blocked', f.deps)).ready, true)
  assert.ok(f.events.indexOf('editing') < f.events.indexOf('independent-review'))
  assert.match(instructions, /缺少原文正文/)
})

test('resuming a corrected edit with an old audit reviews it before requesting more editing', async t => {
  const f = fixture(t), job = f.read()
  job.automation = { producerRunId: 'old-producer', audit: { decision: 'revise', editorialDigest: 'old-edit', issues: [{ code: 'fixed', message: '已在新版解决的问题' }] } }
  f.write(job)
  assert.equal((await runCbaProductionPipeline(f.directory, 'resume-corrected', f.deps)).ready, true)
  assert.deepEqual(f.counts(), { reviewCalls: 1, editCalls: 0 })
})

test('workbench recovery fills a missing authorized source scope before acquisition, preserving explicit choices and profile fields', async t => {
  for (const scope of [undefined, 'full_replay', 'highlights']) {
    const f = fixture(t), job = f.read(); job.profile = { width: 1920, height: 1080, fps: 30, ...(scope ? { sourceScope: scope } : {}) }; f.write(job)
    f.deps.defaultSourceScope = 'highlights'
    const command = f.deps.command
    f.deps.command = async args => {
      if (args[0] === 'acquire-media') assert.deepEqual(f.read().profile, { width: 1920, height: 1080, fps: 30, sourceScope: scope || 'highlights', titlePolicy: 'source-date-cba-v1', narrationPolicy: 'xiaolu-commentator-v1', newsSeconds: [90, 180] })
      await command(args)
    }
    assert.equal((await runCbaProductionPipeline(f.directory, 'scope-migration', f.deps)).ready, true)
    assert.equal(Boolean(f.read().automation.sourceScopeMigration), scope === undefined)
  }
  const completed = fixture(t); completed.setReady(true); completed.deps.defaultSourceScope = 'highlights'
  await runCbaProductionPipeline(completed.directory, 'already-delivered', completed.deps)
  assert.equal(completed.read().profile, undefined)
})

test('new title policy repairs a complete legacy draft before review or paid work, even with a cached pass', async t => {
  const { validateTitlePolicy, TITLE_POLICY } = await import(new URL('../../../scripts/cba-video/title-policy.mjs', import.meta.url).href)
  const f = fixture(t), job = f.read()
  job.match = { id: '2026-10-24-tianjin-guangzhou', date: '2026-10-23', verified: true, seedUrls: ['https://example.com/primary'] }
  job.sources = [{ url: 'https://example.com/primary', title: '[流言板]天津主帅：尼克斯梳理球队，我们会越来越好', text: '天津主帅表示尼克斯梳理球队，我们会越来越好。' }]
  job.news = { title: '天津战胜广州' }; job.highlights = { title: '关键回合' }
  job.automation = { audit: { decision: 'pass', editorialDigest: job.digest } }; f.write(job)
  f.deps.gates!.validateJob = value => ({ errors: validateTitlePolicy(value) })
  const edit = f.deps.edit
  f.deps.edit = async instructions => {
    assert.match(instructions, /天津主帅：尼克斯梳理球队/)
    await edit(instructions)
    const changed = f.read()
    changed.news = { title: '2026-10-23 CBA｜天津主帅：尼克斯梳理球队', shortTitle: 'CBA天津主帅谈尼克斯' }
    changed.highlights = { title: '2026-10-23 CBA｜天津对广州关键回合集锦', shortTitle: 'CBA天津广州关键回合' }
    delete changed.profile.titlePolicy // An editor cannot remove the coordinator's policy.
    f.write(changed)
  }
  const review = f.deps.review
  f.deps.review = async (...args) => {
    assert.equal(f.read().profile.titlePolicy, TITLE_POLICY)
    assert.deepEqual(validateTitlePolicy(f.read()), [])
    return review(...args)
  }
  assert.equal((await runCbaProductionPipeline(f.directory, 'title-policy', f.deps)).ready, true)
  assert.deepEqual(f.events.slice(0, 3), ['acquire-media', 'editing', 'independent-review'])
  assert.ok(f.events.indexOf('independent-review') < f.events.indexOf('tts'))
})

test('delivered legacy job stays byte-identical and is not opted into the new title policy', async t => {
  const f = fixture(t); f.setReady(true)
  const file = path.join(f.directory, 'job.json'), before = fs.readFileSync(file)
  assert.equal((await runCbaProductionPipeline(f.directory, 'preserve-delivery', f.deps)).ready, true)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(f.events, [])
})

test('acquisition propagates this attempt’s concrete cause but never recycles an old error after command failure', async t => {
  for (const fresh of [true, false]) {
    const f = fixture(t), file = path.join(f.directory, 'media-acquisition.json')
    fs.writeFileSync(file, JSON.stringify({ runId: 'old', status: 'scope_mismatch', failure: { message: '旧范围错误' } }))
    f.deps.command = async () => {
      if (fresh) fs.writeFileSync(file, JSON.stringify({ runId: 'new', status: 'scope_mismatch', failure: { message: '已核实官方集锦，当前任务只允许完整回放' } }))
      throw Error('执行器启动失败')
    }
    const result = await runCbaProductionPipeline(f.directory, 'media-retry', f.deps)
    assert.equal(result.ready, false)
    assert.equal(result.message, fresh ? '已核实官方集锦，当前任务只允许完整回放' : '执行器启动失败')
    assert.equal(f.events.includes('tts'), false)
  }
})

test('a report contract error repairs only the report using the same evidence, without editing or extracting again', async t => {
  const f = fixture(t)
  let evidenceCalls = 0, reviews = 0
  const prepare = f.deps.gates!.prepareEditorialAudit
  f.deps.gates!.prepareEditorialAudit = async (...args) => { evidenceCalls++; return prepare(...args) }
  f.deps.gates!.validateEditorialAudit = job => ({ valid: !!job.automation?.audit?.fixed, errors: ['Missing observation reference'], repairTarget: 'report' })
  f.deps.review = async (_packet, _id, context) => {
    reviews++
    if (reviews === 2) {
      assert.equal(context?.mode, 'report-repair')
      assert.deepEqual(context?.errors, ['Missing observation reference'])
      assert.equal(context?.previousAudit?.decision, 'pass')
    }
    return { decision: 'pass', fixed: reviews === 2, issues: [] }
  }
  const result = await runCbaProductionPipeline(f.directory, 'report-repair', f.deps)
  assert.equal(result.ready, true)
  assert.equal(f.counts().editCalls, 0)
  assert.equal(reviews, 2)
  assert.equal(evidenceCalls, 1)
  assert.equal(f.read().digest, 'edit-1')
  assert.equal(f.events.filter(event => event === 'render').length, 1)
})

test('report repair exhaustion and changed evidence never escalate into content edits or paid production', async t => {
  for (const target of ['report', 'evidence'] as const) {
    const f = fixture(t)
    f.deps.gates!.validateEditorialAudit = () => ({ valid: false, errors: ['invalid audit evidence or report'], repairTarget: target })
    const result = await runCbaProductionPipeline(f.directory, `reject-${target}`, f.deps)
    assert.equal(result.ready, false)
    assert.equal(f.counts().editCalls, 0)
    assert.equal(f.counts().reviewCalls, target === 'report' ? 2 : 1)
    assert.equal(f.events.includes('tts'), false)
  }
})

test('persisted malformed pass is sent to the reviewer, never the editor', async t => {
  const f = fixture(t), job = f.read()
  job.automation = { producerRunId: 'old-producer', audit: { decision: 'pass', editorialDigest: job.digest, issues: [] } }; f.write(job)
  f.deps.gates!.validateEditorialAudit = value => ({ valid: !!value.automation?.audit?.fixed, errors: ['Duplicate clip observations'], repairTarget: 'report' })
  f.deps.review = async (_packet, _id, context) => {
    assert.equal(context?.mode, 'report-repair')
    return { decision: 'pass', fixed: true, issues: [] }
  }
  assert.equal((await runCbaProductionPipeline(f.directory, 'persisted-report', f.deps)).ready, true)
  assert.equal(f.counts().editCalls, 0)
})

test('resuming a rejected draft uses its one content repair without starting a second edit', async t => {
  const f = fixture(t), job = f.read()
  job.automation = { producerRunId: 'old-producer', audit: { decision: 'revise', editorialDigest: job.digest,
    issues: [{ code: 'wrong_score', severity: 'error', message: '比分与原文不符' }] } }
  f.write(job)
  f.decisions.splice(0, 1, 'revise', 'pass')
  const result = await runCbaProductionPipeline(f.directory, 'resume-one-repair', f.deps)
  assert.equal(result.ready, false)
  assert.deepEqual(f.counts(), { reviewCalls: 1, editCalls: 1 })
  assert.equal(f.events.includes('tts'), false)
  const brief = JSON.parse(fs.readFileSync(path.join(f.directory, 'editing-brief.json'), 'utf8'))
  assert.equal(brief.mode, 'targeted-repair')
  assert.match(result.message, /一轮.*仍未通过/)
})

test('an unchanged persisted report reuses its packet for one report repair', async t => {
  const f = fixture(t), job = f.read(), packetPath = path.join(f.directory, 'existing-packet.json')
  fs.writeFileSync(packetPath, JSON.stringify({ evidence: [{ path: 'existing-contact-sheet.jpg' }] }))
  job.automation = { producerRunId: 'old-producer', audit: { decision: 'pass', editorialDigest: job.digest,
    packetPath, packetSha256: 'existing-packet-hash', issues: [] } }
  f.write(job)
  f.deps.gates!.validateEditorialAudit = value => ({ valid: !!value.automation?.audit?.fixed,
    errors: ['Missing observation reference'], repairTarget: 'report' })
  f.deps.gates!.prepareEditorialAudit = async () => { throw Error('unchanged evidence must be reused') }
  let reviews = 0
  f.deps.review = async (packet, _id, context) => {
    reviews++
    assert.equal(context?.mode, 'report-repair')
    assert.equal(packet.packetPath, packetPath)
    assert.deepEqual(packet.imagePaths, ['existing-contact-sheet.jpg'])
    return { decision: 'pass', fixed: true, issues: [] }
  }
  assert.equal((await runCbaProductionPipeline(f.directory, 'reuse-existing-packet', f.deps)).ready, true)
  assert.equal(reviews, 1)
  assert.equal(f.counts().editCalls, 0)
})

test('preparation changes invalidate a persisted report packet before reviewing the new draft', async t => {
  const f = fixture(t), job = f.read(), packetPath = path.join(f.directory, 'old-packet.json')
  fs.writeFileSync(packetPath, JSON.stringify({ evidence: [] }))
  job.completeEdit = false
  job.automation = { producerRunId: 'old-producer', audit: { decision: 'pass', editorialDigest: job.digest,
    packetPath, packetSha256: 'old-packet-hash', issues: [] } }
  f.write(job)
  f.deps.gates!.validateEditorialAudit = value => ({ valid: !!value.automation?.audit?.fixed,
    errors: ['Missing observation reference'], repairTarget: 'report' })
  let evidenceCalls = 0
  const prepare = f.deps.gates!.prepareEditorialAudit
  f.deps.gates!.prepareEditorialAudit = async (...args) => { evidenceCalls++; return prepare(...args) }
  f.deps.review = async (packet, _id, context) => {
    assert.equal(context?.mode, 'initial')
    assert.equal(packet.digest, f.read().digest)
    assert.notEqual(packet.packetPath, packetPath)
    return { decision: 'pass', fixed: true, issues: [] }
  }
  assert.equal((await runCbaProductionPipeline(f.directory, 'changed-preparation', f.deps)).ready, true)
  assert.equal(evidenceCalls, 1)
  assert.equal(f.counts().editCalls, 1)
})

test('initial editing receives one source-and-media brief; unresolved preparation never reaches the reviewer', async t => {
  const f = fixture(t), job = f.read()
  job.completeEdit = false
  job.match = { date: '2026-10-23', seedUrls: ['https://example.test/primary'] }
  job.sources = [{ id: 'primary', url: job.match.seedUrls[0], title: '原始新闻', text: '球队球员得到17分。' }]
  job.facts = [{ id: 'points', text: '球员得到17分', sourceIds: ['primary'], verified: true }]
  f.write(job)
  let brief: any, receivedInstructions = ''
  f.deps.edit = async instructions => {
    receivedInstructions = instructions
    brief = JSON.parse(fs.readFileSync(path.join(f.directory, 'editing-brief.json'), 'utf8'))
  }
  const result = await runCbaProductionPipeline(f.directory, 'incomplete-first-edit', f.deps)
  assert.match(receivedInstructions, /editing-brief.json/)
  assert.equal(brief.primaryNews.text, job.sources[0].text)
  assert.equal(brief.facts[0].id, 'points')
  assert.equal(brief.media[0].path, job.media[0].path)
  assert.equal(result.ready, false)
  assert.equal(f.counts().reviewCalls, 0)
  assert.match(result.message, /incomplete edit/)
  assert.equal(f.events.includes('tts'), false)
})

test('a content revision carries only blocking findings and keeps the previous review available', async t => {
  const f = fixture(t)
  let count = 0
  f.deps.review = async (_packet, _id, context) => {
    count++
    if (count === 2) {
      assert.equal(context?.mode, 'revision')
      assert.equal(context?.previousAudit?.decision, 'revise')
      assert.equal(context?.issues?.[0]?.code, 'wrong_score')
    }
    return count === 1 ? { decision: 'revise', issues: [
      { code: 'wrong_score', severity: 'error', message: '比分与原文不符' },
      { code: 'style', severity: 'warning', message: '可以让语气更激烈' },
    ] } : { decision: 'pass', issues: [] }
  }
  const edit = f.deps.edit
  f.deps.edit = async instructions => {
    assert.match(instructions, /比分与原文不符/)
    assert.doesNotMatch(instructions, /可以让语气更激烈/)
    await edit(instructions)
  }
  assert.equal((await runCbaProductionPipeline(f.directory, 'scoped-repair', f.deps)).ready, true)
  assert.equal(f.counts().editCalls, 1)
  assert.equal(count, 2)
})

test('highlights-only runs keep independent review and skip the paid narration step', async t => {
  const f = fixture(t)
  f.write({ ...f.read(), profile: { editions: ['highlights'] } })
  const result = await runCbaProductionPipeline(f.directory, 'highlights-only', f.deps)
  assert.equal(result.ready, true)
  assert.deepEqual(f.events, ['acquire-media', 'independent-review', 'review', 'approve', 'render'])
})

test('workbench policy upgrades unfinished jobs but preserves already valid legacy deliveries', async t => {
  const f = fixture(t)
  f.deps.defaultProductionPolicy = 'cba-value-v2'
  await runCbaProductionPipeline(f.directory, 'policy-new', f.deps)
  assert.equal(f.read().profile.productionPolicy, 'cba-value-v2')
  assert.equal(f.read().profile.narrationPolicy, 'xiaolu-commentator-v1')
  assert.deepEqual(f.read().profile.newsSeconds, [90, 180])
  const other = fixture(t)
  other.setReady(true); other.deps.defaultProductionPolicy = 'cba-value-v2'
  await runCbaProductionPipeline(other.directory, 'policy-legacy', other.deps)
  assert.equal(other.read().profile, undefined)
  assert.deepEqual(other.events, [])
})
