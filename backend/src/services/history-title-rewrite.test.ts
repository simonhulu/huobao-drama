import test from 'node:test'
import assert from 'node:assert/strict'
import type { CoverJsonRequest } from './cover-prompt-enhance.js'
import type { HistoryTitleResearch } from './history-title-research.js'
import { HISTORY_TITLE_REWRITE_MODEL, HISTORY_TITLE_REWRITE_PROMPT, rewriteHistoryTitles as rewriteWithConfiguredWriter, titleRewritePlanSchema } from './history-title-rewrite.js'

const rewriteHistoryTitles = async (input: Parameters<typeof rewriteWithConfiguredWriter>[0], request: CoverJsonRequest,
  writer: CoverJsonRequest = request) => {
  const plan = await rewriteWithConfiguredWriter(input, request, writer)
  assert.ok(plan)
  return plan
}

const exactPrompt = '请将下面这个标题改写为更自然、更有人类写作风格的表达，要求字数不超过16个字。更有情绪和冲突，能激起人的好奇心和求知欲'

function fixture(count = 3) {
  const script = '司马家建立西晋，结束了三国分裂。统一之后皇族内斗，八王之乱削弱了西晋。北方此后出现多个政权。'
  const sourceTitle = '魏晋南北朝：从西晋到南北分裂'
  const titleResearch: HistoryTitleResearch = {
    searched_at: '2026-10-21T01:02:03.000Z', keywords: [['西晋', '司马家'], ['八王之乱', '皇族']],
    queries: ['toutiao', 'baijiahao', 'toutiao', 'baijiahao'].map((platform, index) => ({
      platform: platform as 'toutiao' | 'baijiahao', query: `西晋 皇族 ${index}`, status: 'ok',
    })),
    references: Array.from({ length: 6 }, (_, index) => ({
      id: `R${index + 1}`, title: `西晋皇族内斗的原始检索标题${index + 1}，真有这种事？ | 今日头条`,
      url: `https://www.toutiao.com/article/${123450 + index}`, platform: 'toutiao',
      snippet: '司马家八王之乱，统一后的皇族内斗。', query: '西晋 皇族',
    })),
  }
  const order = [6, 2, 4, 1, 5].slice(0, count)
  const selected = order.map(id => ({ reference_id: `R${id}`, reason: '原题有具体对象和内斗反差，正文能兑现这个冲突。' }))
  const titles = ['司马家刚统一怎么先打起来了', '西晋皇族为何把天下打散了', '天下统一了皇族却先翻脸了', '刚结束三国怎么又打起来了', '八王之乱把西晋折腾成什么样']
  const rewrites = selected.map((item, index) => ({ reference_id: item.reference_id, title: titles[index]!,
    adaptation: '保留原题统一与皇族内斗的对撞，换成口语追问，范围只落在正文。' }))
  return { input: { sourceTitle, script, titleResearch }, shortlist: { selected }, batch: { rewrites } }
}

function responses(...values: unknown[]) {
  const calls: Parameters<CoverJsonRequest>[0][] = []
  const request: CoverJsonRequest = async messages => {
    calls.push(structuredClone(messages))
    assert.ok(calls.length <= values.length, 'unexpected extra request')
    return structuredClone(values[calls.length - 1])
  }
  return { calls, request }
}

for (const count of [1, 2, 3, 4, 5]) {
  test(`shortlists ${count} actual references and rewrites only their exact titles with host-owned provenance`, async () => {
    const { input, shortlist, batch } = fixture(count)
    if (count < 3) input.titleResearch.references = input.titleResearch.references.filter(reference =>
      shortlist.selected.some(item => item.reference_id === reference.id))
    const stub = responses(shortlist, { rewrites: [...batch.rewrites].reverse() })
    const plan = await rewriteHistoryTitles(input, stub.request)
    assert.equal(HISTORY_TITLE_REWRITE_PROMPT, exactPrompt)
    assert.equal(plan.prompt, exactPrompt)
    assert.equal(plan.model, HISTORY_TITLE_REWRITE_MODEL)
    assert.deepEqual(plan.shortlist, shortlist.selected)
    assert.deepEqual(plan.rewrites.map(item => item.id), Array.from({ length: count }, (_, index) => `candidate-${index + 1}`))
    assert.deepEqual(plan.rewrites.map(item => item.reference_id), shortlist.selected.map(item => item.reference_id))
    assert.deepEqual(plan.rewrites.map(item => item.title), batch.rewrites.map(item => item.title))
    assert.equal(stub.calls.length, 2)
    for (const [index, messages] of stub.calls.entries()) {
      const payload = JSON.parse(messages[1]!.content)
      assert.equal(payload.purpose, index === 0 ? 'history-title-shortlist' : 'history-title-rewrite')
      assert.equal(payload.script, input.script)
      assert.equal(payload.sourceTitle, input.sourceTitle)
      assert.equal(payload.titleResearch, undefined)
      assert.ok(!JSON.stringify(payload).includes('snippet'))
      if (index === 0) {
        assert.deepEqual(payload.references, input.titleResearch.references.map(reference => ({
          reference_id: reference.id, original_title: reference.title,
        })))
        assert.match(messages[0]!.content, /数据|材料/)
      } else {
        assert.equal(payload.references, undefined)
        assert.equal(messages[0]!.content, exactPrompt)
      }
    }
    assert.equal(stub.calls[1]![0]!.content, exactPrompt)
    assert.deepEqual(JSON.parse(stub.calls[1]![1]!.content).titles, shortlist.selected.map(item => ({
      reference_id: item.reference_id, original_title: input.titleResearch.references.find(reference => reference.id === item.reference_id)!.title,
    })))
    assert.ok(plan.rewrites.every(item => item.original_title === input.titleResearch.references.find(reference => reference.id === item.reference_id)!.title))
    assert.ok(plan.rewrites.every(item => !Object.hasOwn(item, 'image_prompt') && !Object.hasOwn(item, 'video_description')))
    assert.deepEqual(titleRewritePlanSchema.parse(plan), plan)
  })
}

test('no references skips shortlisting and rewriting so the caller can create an original title', async () => {
  const { input } = fixture()
  input.titleResearch.references = []
  const stub = responses()
  assert.equal(await rewriteWithConfiguredWriter(input, stub.request, stub.request), undefined)
  assert.equal(stub.calls.length, 0)
})

test('unrelated references can all be declined without invoking the local writer', async () => {
  const { input } = fixture()
  const chooser = responses({ selected: [] })
  const writer = responses()
  assert.equal(await rewriteWithConfiguredWriter(input, chooser.request, writer.request), undefined)
  assert.equal(chooser.calls.length, 1)
  assert.equal(writer.calls.length, 0)
  assert.match(chooser.calls[0]![0]!.content, /不相关|相隔太远/)
})

test('malformed research or empty script still fails before any model request', async () => {
  for (const mutate of [
    (input: ReturnType<typeof fixture>['input']) => { input.script = '' },
    (input: ReturnType<typeof fixture>['input']) => { input.titleResearch.references[0]!.url = 'https://untrusted.example/article/1' },
  ]) {
    const { input } = fixture()
    mutate(input)
    const stub = responses()
    await assert.rejects(rewriteHistoryTitles(input, stub.request), /标题改写未通过.*未覆盖原方案/)
    assert.equal(stub.calls.length, 0)
  }
})

test('shortlisting and title rewriting use separate explicitly injected model callers', async () => {
  const { input, shortlist, batch } = fixture()
  const chooser = responses(shortlist)
  const writer = responses(batch)
  const plan = await rewriteWithConfiguredWriter(input, chooser.request, writer.request)
  assert.ok(plan)
  assert.equal(chooser.calls.length, 1)
  assert.equal(writer.calls.length, 1)
  assert.equal(JSON.parse(chooser.calls[0]![1]!.content).purpose, 'history-title-shortlist')
  assert.equal(JSON.parse(writer.calls[0]![1]!.content).purpose, 'history-title-rewrite')
  assert.equal(plan.model, 'qwen3.5-9b-writing-dpo@q4_k_s')
  assert.ok(titleRewritePlanSchema.safeParse({ ...plan, model: 'qwen3.5-9b-writing-dpo@q2_k' }).success)
  const oldPlan = structuredClone(plan)
  delete oldPlan.model
  assert.ok(titleRewritePlanSchema.safeParse(oldPlan).success)
  assert.equal(titleRewritePlanSchema.safeParse({ ...plan, model: 'different-model' }).success, false)
})

test('per-title factual guidance reaches the writer and stored shortlist but not strict rewrite objects', async () => {
  const { input, shortlist, batch } = fixture()
  const guidance = '正文只有八王之乱削弱西晋，不包含三百年或单一根源结论，删去无据数字与唯一因果。'
  const selected = shortlist.selected.map((item, index) => index === 0 ? { ...item, rewrite_guidance: guidance } : item)
  const feedback = '上一轮把外网的三百年分裂归因写进标题，正文没有这个数字。'
  const chooser = responses({ selected })
  const writer = responses(batch)
  const plan = await rewriteWithConfiguredWriter({ ...input, feedback }, chooser.request, writer.request)
  assert.ok(plan)
  const payload = JSON.parse(writer.calls[0]![1]!.content)
  assert.deepEqual(payload.titles, selected.map(item => ({
    reference_id: item.reference_id,
    original_title: input.titleResearch.references.find(reference => reference.id === item.reference_id)!.title,
    ...('rewrite_guidance' in item ? { rewrite_guidance: item.rewrite_guidance } : {}),
  })))
  assert.equal(writer.calls[0]![0]!.content, exactPrompt)
  assert.equal(JSON.parse(chooser.calls[0]![1]!.content).feedback, feedback)
  assert.ok(!JSON.stringify(chooser.calls[0]).includes('snippet'))
  assert.deepEqual(plan.shortlist, selected)
  assert.ok(plan.rewrites.every(item => !Object.hasOwn(item, 'rewrite_guidance')))
  assert.deepEqual(titleRewritePlanSchema.parse(plan), plan)
  assert.equal(titleRewritePlanSchema.safeParse({ ...plan, shortlist: selected.map((item, index) =>
    index === 0 ? { ...item, rewrite_guidance: '晋'.repeat(301) } : item) }).success, false)
})

for (const invalid of [
  { selected: 'R1' },
  { selected: Array.from({ length: 6 }, (_, index) => ({ reference_id: `R${index + 1}`, reason: '过多' })) },
  { selected: ['R1', 'R1', 'R2'].map(reference_id => ({ reference_id, reason: '重复' })) },
  { selected: ['R1', 'R2', 'R999'].map(reference_id => ({ reference_id, reason: '伪造来源' })) },
  { selected: ['R1', 'R2', 'R3'].map(reference_id => ({ reference_id, reason: '' })) },
  { selected: ['R1', 'R2', 'R3'].map(reference_id => ({ reference_id, reason: '理由', title: '不许代写' })) },
]) {
  test(`invalid shortlist ${JSON.stringify(invalid).slice(0, 75)} is retried once then rejected without selecting defaults`, async () => {
    const { input } = fixture()
    const stub = responses(invalid, invalid)
    await assert.rejects(rewriteHistoryTitles(input, stub.request), /标题改写未通过.*未覆盖原方案/)
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(stub.calls[1]!.slice(0, 2), stub.calls[0])
    assert.ok(stub.calls[1]!.at(-1)!.content.includes('未通过'))
  })
}

test('a corrected shortlist uses only its actual selected parents and retains the complete original input', async () => {
  const { input, shortlist, batch } = fixture()
  const invalid = { selected: [{ reference_id: 'R999', reason: '编造' }] }
  const stub = responses(invalid, shortlist, batch)
  const plan = await rewriteHistoryTitles(input, stub.request)
  assert.equal(stub.calls.length, 3)
  assert.deepEqual(stub.calls[1]!.slice(0, 2), stub.calls[0])
  assert.ok(stub.calls[1]!.at(-1)!.content.includes('R999'))
  assert.deepEqual(plan.shortlist, shortlist.selected)
  assert.ok(plan.rewrites.every(item => item.reference_id !== 'R999'))
})

test('independent review feedback is data passed to both stages', async () => {
  const { input, shortlist, batch } = fixture()
  const feedback = '上一轮全部被淘汰：不要只写“乱了”，要保留具体皇族动作。'
  const stub = responses(shortlist, batch)
  await rewriteHistoryTitles({ ...input, feedback }, stub.request)
  assert.ok(stub.calls.every(messages => JSON.parse(messages[1]!.content).feedback === feedback))
})

test('empty title rewrites get one complete correction without changing the selected source list', async () => {
  const { input, shortlist, batch } = fixture()
  const invalid = structuredClone(batch)
  invalid.rewrites[0]!.title = ''
  const stub = responses(shortlist, invalid, batch)
  const plan = await rewriteHistoryTitles(input, stub.request)
  assert.equal(stub.calls.length, 3)
  assert.deepEqual(stub.calls[2]!.slice(0, 2), stub.calls[1])
  assert.ok(stub.calls[2]!.at(-1)!.content.includes(invalid.rewrites[0]!.title))
  assert.deepEqual(plan.rewrites.map(item => item.title), batch.rewrites.map(item => item.title))
})

for (const [label, mutate] of [
  ['missing rewrite', (items: ReturnType<typeof fixture>['batch']['rewrites']) => items.pop()],
  ['unknown reference', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { items[0]!.reference_id = 'R999' }],
  ['unselected reference', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { items[0]!.reference_id = 'R3' }],
  ['duplicate reference', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { items[1]!.reference_id = items[0]!.reference_id }],
  ['duplicate title ignoring punctuation', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { items[1]!.title = `${items[0]!.title}？` }],
  ['empty adaptation', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { items[0]!.adaptation = '' }],
  ['injected original title', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { Object.assign(items[0]!, { original_title: '伪造原题' }) }],
  ['injected host candidate ID', (items: ReturnType<typeof fixture>['batch']['rewrites']) => { Object.assign(items[0]!, { id: 'candidate-99' }) }],
] satisfies [string, (items: ReturnType<typeof fixture>['batch']['rewrites']) => unknown][]) {
  test(`${label} cannot be silently repaired or replaced with a default parent`, async () => {
    const { input, shortlist, batch } = fixture()
    mutate(batch.rewrites)
    const stub = responses(shortlist, batch, batch)
    await assert.rejects(rewriteHistoryTitles(input, stub.request), /标题改写未通过.*未覆盖原方案/)
    assert.equal(stub.calls.length, 3)
  })
}

test('complete rewritten titles remain selectable beyond the platform limit without another rewrite or truncation', async () => {
  for (const length of [16, 17, 26, 120]) {
    const { input, shortlist, batch } = fixture()
    const title = `${'晋'.repeat(length - 1)}？`
    batch.rewrites[0]!.title = title
    const stub = responses(shortlist, batch)
    const plan = await rewriteHistoryTitles(input, stub.request)
    assert.equal(plan.rewrites[0]!.title, title)
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(titleRewritePlanSchema.parse(plan), plan)
  }
})

test('stored rewrite provenance accepts both real prompts without treating their target lengths as a draft rejection', async () => {
  const { input, shortlist, batch } = fixture()
  const current = await rewriteHistoryTitles(input, responses(shortlist, batch).request)
  const oldPrompt = exactPrompt.replace('16个字', '25个字')
  const old = { ...current, prompt: oldPrompt, rewrites: current.rewrites.map((rewrite, index) =>
    index === 0 ? { ...rewrite, title: '晋'.repeat(24) + '？' } : rewrite) }
  assert.deepEqual(titleRewritePlanSchema.parse(old), old)
  assert.equal(titleRewritePlanSchema.safeParse({ ...old, prompt: exactPrompt }).success, true)
  assert.equal(titleRewritePlanSchema.safeParse({ ...old, prompt: oldPrompt.replace('25', '30') }).success, false)
})

test('commas become spaces and permitted title symbols remain intact', async () => {
  const { input, shortlist, batch } = fixture()
  batch.rewrites[0]!.title = '司马家，刚统一,怎么先打起来了？'
  batch.rewrites[1]!.title = '《西晋》：皇族“赢了”吗？'
  batch.rewrites[2]!.title = '统一+内斗：何来百分之百？'
  const stub = responses(shortlist, batch)
  const plan = await rewriteHistoryTitles(input, stub.request)
  assert.equal(plan.rewrites[0]!.title, '司马家 刚统一 怎么先打起来了？')
  assert.equal(plan.rewrites[1]!.title, batch.rewrites[1]!.title)
  assert.equal(plan.rewrites[2]!.title, batch.rewrites[2]!.title)
})

for (const title of ['西晋皇族！为何内斗', '西晋皇族。为何内斗', '西晋皇族/为何内斗', '西晋皇族—为何内斗', '西晋皇族\n为何内斗', '西晋皇族\u200b为何内斗', '西晋皇族🔥为何内斗']) {
  test(`retains a complete draft with unsupported symbol or control ${JSON.stringify(title)} for manual editing`, async () => {
    const { input, shortlist, batch } = fixture()
    batch.rewrites[0]!.title = title
    const stub = responses(shortlist, batch)
    const plan = await rewriteHistoryTitles(input, stub.request)
    assert.equal(plan.rewrites[0]!.title, title)
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(titleRewritePlanSchema.parse(plan), plan)
  })
}

for (const title of ['', '   ', '？', '🔥', '\u200b']) {
  test(`a rewrite without actual title text ${JSON.stringify(title)} remains incomplete`, async () => {
    const { input, shortlist, batch } = fixture()
    batch.rewrites[0]!.title = title
    await assert.rejects(rewriteHistoryTitles(input, responses(shortlist, batch, batch).request), /标题改写未通过/)
  })
}

test('transport errors are sanitized and not retried at either stage', async () => {
  for (const failAt of [1, 2]) {
    const { input, shortlist } = fixture()
    let calls = 0
    const request: CoverJsonRequest = async () => {
      calls++
      if (calls === failAt) throw new Error('Authorization: secret-provider-token')
      return shortlist
    }
    await assert.rejects(rewriteHistoryTitles(input, request), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /标题改写未通过.*未覆盖原方案/)
      assert.doesNotMatch(error.message, /Authorization|secret-provider-token/)
      return true
    })
    assert.equal(calls, failAt)
  }
})

test('stored rewrite schema rejects a forged prompt, parent mapping, candidate order and title duplicates', async () => {
  const { input, shortlist, batch } = fixture()
  const plan = await rewriteHistoryTitles(input, responses(shortlist, batch).request)
  for (const mutate of [
    (value: typeof plan) => { Object.assign(value, { prompt: '换掉指定提示词' }) },
    (value: typeof plan) => { value.rewrites[0]!.reference_id = 'R999' },
    (value: typeof plan) => { value.rewrites[0]!.id = 'candidate-99' },
    (value: typeof plan) => { value.rewrites.reverse() },
    (value: typeof plan) => { value.rewrites[1]!.title = `${value.rewrites[0]!.title}？` },
    (value: typeof plan) => { value.shortlist[1]!.reference_id = value.shortlist[0]!.reference_id },
    (value: typeof plan) => { value.rewrites.pop() },
  ]) {
    const invalid = structuredClone(plan)
    mutate(invalid)
    assert.equal(titleRewritePlanSchema.safeParse(invalid).success, false)
  }
})
