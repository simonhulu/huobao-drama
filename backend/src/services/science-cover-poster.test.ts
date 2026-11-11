import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { generateScienceCoverPosters, SCIENCE_COVER_TOOL, type SciencePosterInput, type SciencePosterOptions,
  type SciencePosterImageRuntime } from './science-cover-poster.js'

const plan = {
  headlineLines: ['骆驼', '为什么', '这么耐渴？'], highlight: '骆驼', subject: '一只健康的单峰骆驼',
  evidenceQuote: '骆驼能减少水分流失，体温也会随环境变化。', payoff: '正文解释了骆驼减少水分流失的多种生理机制。',
  landscapeTextSide: 'text-left',
  landscapePrompt: '横版独立摄影构图，右侧是一只真实单峰骆驼的头颈大特写，细致毛发与眼睛，左侧是纯黑背景供标题排字，柔和侧光，画面不含任何文字。',
  portraitPrompt: '竖版独立摄影构图，真实单峰骆驼的头颈集中在下半部分，上方留出深色干净空间，清晰毛发与眼睛，柔和侧光，画面不含文字。',
}
const signal = () => new AbortController().signal
async function fixture(t: any) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'science-poster-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const input: SciencePosterInput = { title: '骆驼为什么耐渴？', script: `沙漠昼夜温差大。${plan.evidenceQuote}`, sourceTitle: 'Why camels thrive',
    instruction: '黑底，突出眼睛，黄色写骆驼', directory, revision: 1 }
  const requests: Array<Parameters<SciencePosterImageRuntime['create']>[0]> = [], executes: number[] = [], composed: string[] = []
  const states = new Map<number, NonNullable<Awaited<ReturnType<SciencePosterImageRuntime['state']>>>>()
  let calls = 0
  const images: SciencePosterImageRuntime = {
    config: async () => ({ id: 7, identity: 'same-config' }),
    create: async request => { requests.push(request); const id = requests.length; states.set(id, { status: 'processing', taskId: null, localPath: null, errorMsg: null, lastErrorCode: null }); return id },
    state: async id => states.get(id) || null,
    execute: async (id, configId, executionSignal) => {
      assert.equal(configId, 7); executionSignal.throwIfAborted(); executes.push(id)
      const file = path.join(directory, `base-${id}.png`)
      await sharp({ create: { width: 1200, height: 1200, channels: 3, background: id === 1 ? '#1d3a59' : '#7f391e' } }).png().toFile(file)
      states.set(id, { status: 'completed', taskId: `provider-${id}`, localPath: file, errorMsg: null, lastErrorCode: null })
      return file
    },
  }
  const options: SciencePosterOptions = { signal: signal(), dependencies: {
    call: async (messages, options) => {
      calls++
      assert.deepEqual(options?.toolChoice, { type: 'function', function: { name: SCIENCE_COVER_TOOL } })
      assert.equal(options?.tools?.[0]?.function.strict, true)
      assert.equal((options?.tools?.[0]?.function.parameters as any).additionalProperties, false)
      assert.equal(JSON.parse(messages[1]!.content).userInstruction, input.instruction)
      return JSON.stringify(plan)
    },
    images,
    compose: async request => {
      assert.equal(request.signal, options.signal)
      assert.equal(request.design.headline_lines, 3)
      assert.equal(request.design.main_title, '骆驼\n为什么\n这么耐渴？')
      assert.equal(request.design.highlight_text, '骆驼')
      return Promise.all(request.variants.map(async variant => {
        composed.push(variant.key)
        const file = path.join(request.outputDir, `${variant.key}.png`)
        await sharp(variant.baseImagePath).resize(variant.width, variant.height).png().toFile(file)
        return { ...variant, path: file }
      }))
    },
  } }
  options.profile = { style: 'science-title-poster-v1', toolName: SCIENCE_COVER_TOOL, systemPrompt: '封面设计测试', imageBrief: '真实摄影', imageType: 'science_cover_base' }
  return { input, options, images, states, requests, executes, composed, calls: () => calls }
}

async function uncertainPortrait(t: any) {
  const f = await fixture(t), execute = f.images.execute
  f.images.execute = async (id, configId, signal) => {
    if (id === 2) {
      f.states.set(id, { status: 'failed', taskId: null, localPath: null, errorMsg: 'fetch failed', lastErrorCode: 'provider_timeout' })
      throw new Error('fetch failed')
    }
    return execute(id, configId, signal)
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /封面底图 2.*提交结果未确认/)
  f.images.config = async id => id === 8 ? { id: 8, identity: 'relay-config', durableRelay: true } : { id: 7, identity: 'same-config' }
  f.images.execute = (id, configId, signal) => {
    assert.equal(configId, 8)
    return execute(id, 7, signal)
  }
  const checkpointFile = path.join(f.input.directory, 'poster-checkpoint.json')
  const checkpoint = () => fs.readFile(checkpointFile, 'utf8').then(JSON.parse)
  const recovery = { format: 'portrait' as const, expectedGenerationId: 2, configId: 8, recoveryId: 'missing-portrait-v1' }
  return { ...f, checkpointFile, checkpoint, recovery }
}

test('strict-tool design generates independently composed posters, preserves instruction and reuses both completed formats', async t => {
  const f = await fixture(t)
  const result = await generateScienceCoverPosters(f.input, f.options)
  for (const [file, dimensions] of [[result.landscapePath, [1280, 720]], [result.portraitPath, [810, 1080]]] as const) {
    const meta = await sharp(file).metadata()
    assert.deepEqual([meta.width, meta.height], dimensions); assert.equal(meta.format, 'jpeg')
  }
  assert.equal(f.calls(), 1); assert.deepEqual(f.executes, [1, 2])
  assert.deepEqual(f.requests.map(request => request.frameType), ['16:9', '3:4'])
  assert.notEqual(f.requests[0]!.prompt, f.requests[1]!.prompt)
  assert.match(f.requests[0]!.prompt, /左侧50%/)
  assert.match(f.requests[1]!.prompt, /上方45%/)
  assert.deepEqual(await generateScienceCoverPosters(f.input, f.options), result)
  assert.equal(f.calls(), 1); assert.equal(f.executes.length, 2); assert.equal(f.composed.length, 2)
  await fs.writeFile(result.portraitPath, 'corrupt output')
  await generateScienceCoverPosters(f.input, f.options)
  assert.equal(f.executes.length, 2, 'damaged output recomposes the saved independent base, with no paid image request')
  assert.deepEqual(f.composed, ['landscape', 'portrait', 'portrait'])
})

test('the real presenter is composited on both posters and changing its identity only recomposes the saved bases', async t => {
  const f = await fixture(t), presenterPath = path.join(f.input.directory, 'presenter.png')
  const photograph = async (background: string) => sharp({ create: { width: 330, height: 730, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp({ create: { width: 300, height: 700, channels: 4, background } }).png().toBuffer(), left: 15, top: 15 }]).png().toFile(presenterPath)
  await photograph('#00ff00')
  Object.assign(f.input, { presenterPath })
  const result = await generateScienceCoverPosters(f.input, f.options)
  const sample = async (file: string, x: number, y: number) => [...await sharp(file).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()]
  assert.ok((await sample(result.landscapePath, 1130, 500))[1]! > 220, 'landscape must contain the actual presenter photograph')
  assert.ok((await sample(result.portraitPath, 690, 800))[1]! > 220, 'portrait must contain the actual presenter photograph')
  const checkpoint = () => fs.readFile(path.join(f.input.directory, 'poster-checkpoint.json'), 'utf8').then(JSON.parse)
  assert.match((await checkpoint()).outputs.landscape.presenterSha256, /^[a-f0-9]{64}$/)
  await photograph('#ff0000')
  await generateScienceCoverPosters(f.input, f.options)
  assert.ok((await sample(result.landscapePath, 1130, 500))[0]! > 220, 'a different presenter must invalidate composed output')
  assert.equal(f.calls(), 1)
  assert.equal(f.executes.length, 2, 'presenter changes must not regenerate paid background images')
  assert.equal(f.composed.length, 4)
})

test('an explicit missing presenter cannot silently generate a cover without the host', async t => {
  const f = await fixture(t)
  Object.assign(f.input, { presenterPath: path.join(f.input.directory, 'missing-presenter.png') })
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /主播/)
  assert.equal(f.requests.length, 0)
})

test('a failed portrait query resumes its saved provider job and never regenerates the finished landscape', async t => {
  const f = await fixture(t), execute = f.images.execute
  let interrupted = false
  f.images.execute = async (id, configId, signal) => {
    if (id === 2 && !interrupted) {
      interrupted = true
      f.states.set(id, { status: 'failed', taskId: 'original-portrait-task', localPath: null, errorMsg: 'network timeout', lastErrorCode: 'network_error' })
      throw new Error('network timeout')
    }
    if (id === 2) assert.equal(f.states.get(id)?.taskId, 'original-portrait-task')
    return execute(id, configId, signal)
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /network timeout/)
  assert.deepEqual(f.composed, ['landscape'])
  await generateScienceCoverPosters(f.input, f.options)
  assert.equal(f.requests.length, 2); assert.equal(f.calls(), 1)
  assert.deepEqual(f.composed, ['landscape', 'portrait'])
})

test('a lost submission acknowledgement is preserved and not replayed on automatic retry', async t => {
  const f = await fixture(t)
  let submissions = 0
  f.images.execute = async () => { submissions++; throw new Error('connection lost after dispatch') }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /封面底图 1.*提交结果未确认/)
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /已提交但未取得任务编号/)
  assert.equal(submissions, 1); assert.equal(f.requests.length, 1)
})

test('an uncertain portrait submission names its base and preserves the plan and finished landscape without redispatch', async t => {
  const f = await fixture(t), execute = f.images.execute, submissions: number[] = []
  const failure = new TypeError('fetch failed at https://provider.invalid/image?token=SECRET', {
    cause: Object.assign(new Error('download DNS failure'), { code: 'ENOTFOUND' }),
  })
  f.images.execute = async (id, configId, executionSignal) => {
    submissions.push(id)
    if (id === 2) throw failure
    return execute(id, configId, executionSignal)
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /封面底图 2.*提交结果未确认/)
    assert.match(error.message, /检查点.*横图.*保留/)
    assert.match(error.message, /核对.*请求.*仅重做缺失底图/)
    assert.doesNotMatch(error.message, /https?:|provider\.invalid|token|SECRET/)
    assert.equal(error.cause, failure)
    return true
  })
  const checkpointPath = path.join(f.input.directory, 'poster-checkpoint.json')
  const saved = JSON.parse(await fs.readFile(checkpointPath, 'utf8'))
  const landscapePath = path.join(f.input.directory, 'cover-landscape.jpg'), landscape = await fs.readFile(landscapePath)
  assert.deepEqual(saved.plan, plan)
  assert.equal(saved.images.portrait.generationId, 2)
  assert.equal(saved.images.portrait.dispatched, true)
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /封面底图 2.*已提交但未取得任务编号/)
  assert.deepEqual(JSON.parse(await fs.readFile(checkpointPath, 'utf8')), saved)
  assert.deepEqual(await fs.readFile(landscapePath), landscape)
  assert.deepEqual(submissions, [1, 2])
  assert.deepEqual(f.composed, ['landscape'])
  assert.equal(f.requests.length, 2)
  assert.equal(f.calls(), 1)
})

test('an explicit missing-only replacement archives the uncertain attempt and preserves the original landscape and plan', async t => {
  const f = await uncertainPortrait(t), before = await f.checkpoint(), oldState = structuredClone(f.states.get(2))
  const landscapeFile = path.join(f.input.directory, 'cover-landscape.jpg'), landscape = await fs.readFile(landscapeFile)
  const options = { ...f.options, replacement: f.recovery }
  const result = await generateScienceCoverPosters(f.input, options)
  const after = await f.checkpoint()
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[2]!.configId, 8)
  assert.equal(f.requests[2]!.prompt, f.requests[1]!.prompt)
  assert.equal(f.requests[2]!.frameType, '3:4')
  assert.deepEqual(f.states.get(2), oldState, 'the original uncertain provider record is retained')
  assert.deepEqual(after.images.landscape, before.images.landscape)
  assert.deepEqual(after.outputs.landscape, before.outputs.landscape)
  assert.deepEqual(await fs.readFile(landscapeFile), landscape)
  assert.deepEqual(after.plan, before.plan)
  assert.equal(after.revision, before.revision)
  assert.equal(after.inputHash, before.inputHash)
  assert.equal(after.images.portrait.generationId, 3)
  assert.equal(after.replacements.length, 1)
  assert.equal(after.replacements[0].recoveryId, f.recovery.recoveryId)
  assert.deepEqual(after.replacements[0].previous, before.images.portrait)
  assert.equal(after.replacements[0].replacement.generationId, 3)
  assert.equal(after.replacements[0].replacement.config.id, 8)
  assert.equal(after.replacements[0].replacement.dispatched, false, 'replacement intent precedes dispatch')
  assert.ok(Number.isFinite(Date.parse(after.replacements[0].replacedAt)))
  assert.deepEqual(await generateScienceCoverPosters(f.input, options), result)
  assert.equal(f.requests.length, 3, 'replaying the same recovery cannot create another attempt')
  assert.equal(f.calls(), 1)
  assert.deepEqual(f.composed, ['landscape', 'portrait'])
})

test('a persisted replacement resumes the same image after a lost admission acknowledgement only with its durable binding', async t => {
  const f = await uncertainPortrait(t), execute = f.images.execute
  let restored = false
  f.images.execute = async (id, configId, signal) => {
    assert.equal(id, 3)
    const saved = await f.checkpoint()
    assert.equal(saved.images.portrait.generationId, 3)
    assert.equal(saved.replacements[0].previous.generationId, 2)
    if (!restored) {
      f.states.set(id, { status: 'failed', taskId: null, localPath: null, errorMsg: 'fetch failed', lastErrorCode: 'provider_timeout' })
      throw new Error('fetch failed')
    }
    return execute(id, configId, signal)
  }
  const options = { ...f.options, replacement: f.recovery }
  await assert.rejects(generateScienceCoverPosters(f.input, options), /封面底图 3.*提交结果未确认/)
  const pending = await fs.readFile(f.checkpointFile, 'utf8')
  await assert.rejects(generateScienceCoverPosters(f.input, options), /封面底图 3.*已提交但未取得任务编号/)
  assert.equal(await fs.readFile(f.checkpointFile, 'utf8'), pending)
  assert.equal(f.requests.length, 3)
  f.images.canRecoverAdmission = async (id, configId) => {
    assert.equal(id, 3); assert.equal(configId, 8)
    return true
  }
  restored = true
  await generateScienceCoverPosters(f.input, options)
  assert.equal(f.requests.length, 3)
  assert.equal((await f.checkpoint()).replacements.length, 1)
  assert.deepEqual(f.composed, ['landscape', 'portrait'])
})

test('concurrent attempts to recover one poster cannot create two replacements', async t => {
  const f = await uncertainPortrait(t), create = f.images.create
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const creating = new Promise<void>(resolve => { entered = resolve })
  f.images.create = async input => { entered(); await gate; return create(input) }
  const options = { ...f.options, replacement: f.recovery }
  const first = generateScienceCoverPosters(f.input, options)
  await creating
  try { await assert.rejects(generateScienceCoverPosters(f.input, options), /正在生成/) }
  finally { release() }
  await first
  assert.equal(f.requests.length, 3)
  assert.equal((await f.checkpoint()).replacements.length, 1)
})

test('replaying a replacement after a rejected model fallback keeps the same paid lineage', async t => {
  const f = await uncertainPortrait(t), execute = f.images.execute
  f.images.config = async id => id === 8
    ? { id: 8, identity: 'relay-config', durableRelay: true, models: ['unsupported', 'supported'] }
    : { id: 7, identity: 'same-config' }
  f.images.execute = async (id, configId, signal) => {
    if (id === 3) {
      f.states.set(id, { ...f.states.get(id)!, status: 'failed', lastErrorCode: 'unsupported_model', errorMsg: 'Unsupported model' })
      throw new Error('Unsupported model')
    }
    return execute(id, configId, signal)
  }
  const options = { ...f.options, replacement: f.recovery }
  await generateScienceCoverPosters(f.input, options)
  const saved = await f.checkpoint()
  assert.equal(saved.replacements[0].replacement.generationId, 3)
  assert.equal(saved.images.portrait.generationId, 4)
  assert.deepEqual(saved.images.portrait.rejectedModels, [{ generationId: 3, model: 'unsupported' }])
  await generateScienceCoverPosters(f.input, options)
  assert.equal(f.requests.length, 4)
})

test('a recovery id cannot be rebound or replaced by a second recovery for the same format', async t => {
  const f = await uncertainPortrait(t)
  await generateScienceCoverPosters(f.input, { ...f.options, replacement: f.recovery })
  const before = await fs.readFile(f.checkpointFile, 'utf8')
  for (const replacement of [
    { ...f.recovery, expectedGenerationId: 3 },
    { ...f.recovery, configId: 9 },
    { ...f.recovery, format: 'landscape' as const },
    { ...f.recovery, recoveryId: 'second-paid-replacement' },
  ]) await assert.rejects(generateScienceCoverPosters(f.input, { ...f.options, replacement }), /已绑定其他请求|已有替代请求/)
  assert.equal(await fs.readFile(f.checkpointFile, 'utf8'), before)
  assert.equal(f.requests.length, 3)
})

test('missing-only recovery rejects known tasks, completed bases and non-relay configurations before creating another record', async t => {
  for (const changed of ['wrong-id', 'known-task', 'completed', 'saved-base', 'ordinary-config', 'unsubmitted', 'completed-output'] as const) {
    const f = await uncertainPortrait(t)
    if (changed === 'known-task') f.states.set(2, { ...f.states.get(2)!, taskId: 'original-provider-task' })
    if (changed === 'completed') f.states.set(2, { ...f.states.get(2)!, status: 'completed' })
    if (changed === 'saved-base') f.states.set(2, { ...f.states.get(2)!, localPath: 'original-base.png' })
    if (changed === 'ordinary-config') f.images.config = async () => ({ id: 8, identity: 'ordinary-config' })
    if (changed === 'unsubmitted' || changed === 'completed-output') {
      const saved = await f.checkpoint()
      if (changed === 'unsubmitted') saved.images.portrait.dispatched = false
      else saved.outputs.portrait = { sha256: 'original-completed-output' }
      await fs.writeFile(f.checkpointFile, JSON.stringify(saved))
    }
    const before = await fs.readFile(f.checkpointFile, 'utf8')
    await assert.rejects(generateScienceCoverPosters(f.input, { ...f.options,
      replacement: { ...f.recovery, ...(changed === 'wrong-id' ? { expectedGenerationId: 999 } : {}) } }),
    /编号已变化|已有结果或任务编号|持久恢复|已有底图或成品/)
    assert.equal(await fs.readFile(f.checkpointFile, 'utf8'), before)
    assert.equal(f.requests.length, 2)
  }
})

test('missing-only recovery refuses changed content or an invalid other-format output and never redesigns the original', async t => {
  const f = await uncertainPortrait(t)
  const options = { ...f.options, replacement: f.recovery }
  const before = await fs.readFile(f.checkpointFile, 'utf8')
  await assert.rejects(generateScienceCoverPosters({ ...f.input, script: f.input.script + '新结论。' }, options), /已绑定其他文稿/)
  await assert.rejects(generateScienceCoverPosters({ ...f.input, revision: 2 }, options), /已绑定其他文稿/)
  await fs.writeFile(path.join(f.input.directory, 'cover-landscape.jpg'), 'damaged landscape')
  await assert.rejects(generateScienceCoverPosters(f.input, options), /另一画幅的原成品完整且匹配/)
  assert.equal(await fs.readFile(f.checkpointFile, 'utf8'), before)
  assert.equal(f.requests.length, 2)
  assert.equal(f.calls(), 1)
})

test('a recovery requires an existing plan and validates its operator binding before any design or image request', async t => {
  const f = await fixture(t)
  const replacement = { format: 'portrait' as const, expectedGenerationId: 2, configId: 8, recoveryId: 'missing-portrait-v1' }
  await assert.rejects(generateScienceCoverPosters(f.input, { ...f.options, replacement }), /原版本的完整封面检查点/)
  for (const invalid of [{ recoveryId: '' }, { recoveryId: undefined }, { expectedGenerationId: 0 }, { configId: NaN }, { format: 'square' }])
    await assert.rejects(generateScienceCoverPosters(f.input, { ...f.options, replacement: { ...replacement, ...invalid } as any }), /恢复参数无效/)
  assert.equal(f.calls(), 0)
  assert.equal(f.requests.length, 0)
})

test('a rejected model advances only through the configured list and retains the selected provider job across restart', async t => {
  const f = await fixture(t), create = f.images.create, execute = f.images.execute
  f.images.config = async () => ({ id: 7, identity: 'same-config', models: ['unavailable-model', 'supported-model'] })
  f.images.create = async input => {
    const id = await create(input)
    f.states.set(id, { ...f.states.get(id)!, model: input.model })
    return id
  }
  let interrupted = false
  const attemptedModels: string[] = []
  f.images.execute = async (id, configId, signal) => {
    const model = f.requests[id - 1]!.model!
    attemptedModels.push(model)
    if (model === 'unavailable-model') {
      f.states.set(id, { ...f.states.get(id)!, status: 'failed', lastErrorCode: 'bad_request',
        errorMsg: 'API error 404: {"error":{"type":"model_not_found","message":"Model is not supported by any configured account"}}' })
      throw new Error('model_not_found')
    }
    if (!interrupted) {
      interrupted = true
      f.states.set(id, { ...f.states.get(id)!, status: 'failed', taskId: 'accepted-fallback-job',
        lastErrorCode: 'network_error', errorMsg: 'network timeout' })
      throw new Error('network timeout')
    }
    if (id === 2) assert.equal(f.states.get(id)?.taskId, 'accepted-fallback-job')
    return execute(id, configId, signal)
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /network timeout/)
  const checkpoint = JSON.parse(await fs.readFile(path.join(f.input.directory, 'poster-checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.images.landscape.generationId, 2)
  assert.equal(checkpoint.images.landscape.model, 'supported-model')
  assert.deepEqual(checkpoint.images.landscape.rejectedModels, [{ generationId: 1, model: 'unavailable-model' }])
  await generateScienceCoverPosters(f.input, f.options)
  assert.deepEqual(f.requests.map(request => request.model), ['unavailable-model', 'supported-model', 'unavailable-model', 'supported-model'])
  assert.deepEqual(attemptedModels, ['unavailable-model', 'supported-model', 'supported-model', 'unavailable-model', 'supported-model'])
  assert.equal(f.calls(), 1)
})

test('an existing rejected-model checkpoint recovers its actual model from the saved generation', async t => {
  const f = await fixture(t), execute = f.images.execute
  f.images.execute = async id => {
    f.states.set(id, { ...f.states.get(id)!, status: 'failed', model: 'unavailable-model',
      lastErrorCode: 'unsupported_model', errorMsg: 'Unsupported model' })
    throw new Error('Unsupported model')
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /Unsupported model/)
  f.images.config = async () => ({ id: 7, identity: 'same-config', models: ['unavailable-model', 'supported-model'] })
  f.images.execute = execute
  await generateScienceCoverPosters(f.input, f.options)
  assert.equal(f.requests[1]!.model, 'supported-model')
  assert.deepEqual(f.executes, [2, 3])
})

test('unknown failures and already accepted jobs never switch models', async t => {
  for (const failure of [
    { taskId: null, lastErrorCode: 'network_error', errorMsg: 'network timeout' },
    { taskId: null, lastErrorCode: 'bad_request', errorMsg: 'invalid size' },
    { taskId: 'accepted-provider-job', lastErrorCode: 'unsupported_model', errorMsg: 'model_not_found' },
  ]) {
    const f = await fixture(t)
    f.images.config = async () => ({ id: 7, identity: 'same-config', models: ['unavailable-model', 'supported-model'] })
    f.images.execute = async id => {
      f.states.set(id, { ...f.states.get(id)!, status: 'failed', model: 'unavailable-model', ...failure })
      throw new Error(failure.errorMsg)
    }
    await assert.rejects(generateScienceCoverPosters(f.input, f.options), error => error instanceof Error &&
      (failure.taskId || failure.lastErrorCode === 'bad_request' ? error.message === failure.errorMsg
        : /封面底图 1.*提交结果未确认/.test(error.message)))
    assert.equal(f.requests.length, 1)
  }
})

test('model rejection exhausts the configured candidates once without repeating duplicate names', async t => {
  const f = await fixture(t)
  const attempts: number[] = []
  f.images.config = async () => ({ id: 7, identity: 'same-config', models: ['unavailable-model', 'unavailable-model', 'also-unavailable'] })
  f.images.execute = async id => {
    attempts.push(id)
    f.states.set(id, { ...f.states.get(id)!, status: 'failed', model: f.requests[id - 1]!.model,
      lastErrorCode: 'unsupported_model', errorMsg: 'Unsupported model' })
    throw new Error('Unsupported model')
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /Unsupported model/)
  assert.deepEqual(f.requests.map(request => request.model), ['unavailable-model', 'also-unavailable'])
  assert.deepEqual(attempts, [1, 2])
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /Unsupported model/)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(attempts, [1, 2, 2], 'a new invocation retries only the restored final candidate once')
})

test('a restored rejected final model can recover without redesigning or regenerating the finished format', async t => {
  const f = await fixture(t), execute = f.images.execute
  f.images.config = async () => ({ id: 7, identity: 'same-config', models: ['temporarily-unavailable'] })
  f.images.execute = async (id, configId, signal) => {
    if (id === 2) {
      f.states.set(id, { ...f.states.get(id)!, status: 'failed', model: 'temporarily-unavailable',
        lastErrorCode: 'unsupported_model', errorMsg: 'Unsupported model' })
      throw new Error('Unsupported model')
    }
    return execute(id, configId, signal)
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /Unsupported model/)
  assert.deepEqual(f.composed, ['landscape'])
  f.images.execute = async (id, configId, signal) => {
    assert.equal(id, 2)
    const checkpoint = JSON.parse(await fs.readFile(path.join(f.input.directory, 'poster-checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.images.portrait.dispatched, true, 'the recovery dispatch is saved before execution')
    return execute(id, configId, signal)
  }
  await generateScienceCoverPosters(f.input, f.options)
  assert.equal(f.requests.length, 2)
  assert.equal(f.calls(), 1)
  assert.deepEqual(f.executes, [1, 2])
  assert.deepEqual(f.composed, ['landscape', 'portrait'])
})

test('a lost acknowledgement while retrying a restored rejection cannot be replayed again', async t => {
  const f = await fixture(t)
  f.images.config = async () => ({ id: 7, identity: 'same-config', models: ['temporarily-unavailable'] })
  f.images.execute = async id => {
    f.states.set(id, { ...f.states.get(id)!, status: 'failed', model: 'temporarily-unavailable',
      lastErrorCode: 'unsupported_model', errorMsg: 'Unsupported model' })
    throw new Error('Unsupported model')
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /Unsupported model/)
  let submissions = 0
  f.images.execute = async id => {
    submissions++
    f.states.set(id, { ...f.states.get(id)!, status: 'processing', lastErrorCode: null, errorMsg: null })
    throw new Error('connection lost after dispatch')
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /封面底图 1.*提交结果未确认/)
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /已提交但未取得任务编号/)
  assert.equal(submissions, 1)
  assert.equal(f.requests.length, 1)
})

test('tool schema violations and ungrounded promises stop before any image submission', async t => {
  for (const invalid of [{ ...plan, headlineLines: 'wrong type' }, { ...plan, evidenceQuote: '骆驼能够连续一年完全不喝水。' },
    { ...plan, highlight: '沙漠' }, { ...plan, portraitPrompt: plan.landscapePrompt }]) {
    const f = await fixture(t)
    f.options.dependencies!.call = async () => JSON.stringify(invalid)
    await assert.rejects(generateScienceCoverPosters(f.input, f.options), /工具参数|依据不在|关键词|分别设计/)
    assert.equal(f.requests.length, 0)
  }
})

test('invalid headline lengths, line counts and JSON receive bounded correction before image dispatch', async t => {
  const invalidResponses = [
    JSON.stringify({ ...plan, headlineLines: ['一二三四五六七', '一二三四五六七', '一二三四五六七'] }),
    JSON.stringify({ ...plan, headlineLines: ['骆驼为什么这么耐渴？'] }),
    JSON.stringify({ ...plan, headlineLines: ['骆驼', '为什么', '这么', '耐渴？'] }),
    JSON.stringify({ ...plan, headlineLines: ['骆驼为什么', '能一口气喝这么多水？'] }),
    '{"headlineLines":',
  ]
  for (const invalid of invalidResponses) {
    const f = await fixture(t), call = f.options.dependencies!.call!
    let attempts = 0
    f.options.dependencies!.call = async (messages, options) => {
      attempts++
      assert.equal(f.requests.length, 0, 'design correction must complete before any image record or request')
      if (attempts === 1) return invalid
      assert.equal(messages.at(-2)?.role, 'assistant')
      assert.equal(messages.at(-2)?.content, invalid)
      assert.match(messages.at(-1)?.content || '', /未通过校验/)
      assert.match(messages.at(-1)?.content || '', /18/)
      assert.equal(options?.tools?.[0]?.function.strict, true)
      return call(messages, options)
    }
    await generateScienceCoverPosters(f.input, f.options)
    assert.equal(attempts, 2)
    assert.equal(f.requests.length, 2)
    assert.equal(f.executes.length, 2)
    const checkpoint = JSON.parse(await fs.readFile(path.join(f.input.directory, 'poster-checkpoint.json'), 'utf8'))
    assert.deepEqual(checkpoint.plan, plan)
    assert.equal(checkpoint.revision, f.input.revision)
  }
})

test('design validation and temporary service failures share one finite budget without image submission', async t => {
  const f = await fixture(t)
  let attempts = 0
  const waits: number[] = []
  f.options.dependencies!.call = async () => {
    attempts++
    if (attempts === 2) throw Object.assign(new Error('upstream unavailable'), { status: 503 })
    return JSON.stringify({ ...plan, headlineLines: ['一二三四五六七', '一二三四五六七', '一二三四五六七'] })
  }
  f.options.dependencies!.sleep = async ms => { waits.push(ms) }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /封面标题/)
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [4000])
  assert.equal(f.requests.length, 0)
  assert.equal(f.executes.length, 0)
})

test('design correction observes cancellation before making a second text or image request', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error('stop cover design')
  let attempts = 0
  f.options.signal = controller.signal
  f.options.dependencies!.call = async () => { attempts++; return 'not JSON' }
  f.options.report = message => { if (/修正/.test(message)) controller.abort(reason) }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), error => error === reason)
  assert.equal(attempts, 1)
  assert.equal(f.requests.length, 0)
})

test('authentication failures are not retried as design corrections', async t => {
  for (const status of [401, 403]) {
    const f = await fixture(t)
    let attempts = 0
    f.options.dependencies!.call = async () => { attempts++; throw Object.assign(new Error('access denied'), { status }) }
    await assert.rejects(generateScienceCoverPosters(f.input, f.options), /access denied/)
    assert.equal(attempts, 1)
    assert.equal(f.requests.length, 0)
  }
})

test('changed content or manual instructions require a new revision directory, retaining the prior poster', async t => {
  const f = await fixture(t)
  const result = await generateScienceCoverPosters(f.input, f.options)
  const original = await fs.readFile(result.landscapePath)
  for (const patch of [{ instruction: '改成自然沙漠背景' }, { script: `${f.input.script}添加新的结论。` }, { revision: 2 }])
    await assert.rejects(generateScienceCoverPosters({ ...f.input, ...patch }, f.options), /已绑定其他文稿或指令/)
  assert.deepEqual(await fs.readFile(result.landscapePath), original)
  assert.equal(f.requests.length, 2)
})

test('cancellation after a paid result retains that base and retries without buying another image', async t => {
  const f = await fixture(t), execute = f.images.execute, controller = new AbortController()
  f.options.signal = controller.signal
  f.images.execute = async (...args) => { const file = await execute(...args); controller.abort(); return file }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /abort/i)
  assert.equal(f.requests.length, 1); assert.equal(f.composed.length, 0)
  f.images.execute = execute; f.options.signal = signal()
  await generateScienceCoverPosters(f.input, f.options)
  assert.deepEqual(f.executes, [1, 2]); assert.equal(f.requests.length, 2)
})

test('configuration changes and modified generated bases cannot silently replace checkpointed input', async t => {
  const f = await fixture(t)
  f.images.execute = async id => {
    f.states.set(id, { status: 'failed', taskId: 'original-task', localPath: null, errorMsg: 'timeout', lastErrorCode: 'network_error' })
    throw new Error('timeout')
  }
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /timeout/)
  f.images.config = async () => ({ id: 7, identity: 'changed-config' })
  await assert.rejects(generateScienceCoverPosters(f.input, f.options), /配置已变化/)
  assert.equal(f.requests.length, 1)
})

test('temporary tool HTTP errors retry within a finite limit without relaxing the schema', async t => {
  const f = await fixture(t), call = f.options.dependencies!.call!
  let attempts = 0
  const waits: number[] = []
  f.options.dependencies!.call = async (...args) => {
    if (++attempts < 3) throw Object.assign(new Error('upstream unavailable'), { status: 502 })
    return call(...args)
  }
  f.options.dependencies!.sleep = async ms => { waits.push(ms) }
  await generateScienceCoverPosters(f.input, f.options)
  assert.equal(attempts, 3); assert.deepEqual(waits, [2000, 4000])
})
