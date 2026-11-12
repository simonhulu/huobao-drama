import test from 'node:test'
import assert from 'node:assert/strict'
import { recreateScienceScript, scienceNarrationLength, stripScienceNarrationIntroduction, type ScienceModelRetry, type SciencePlan, type SciencePlanning, type ScienceWritingCheckpoint, SCIENCE_PLAN_TOOL_NAME, SCIENCE_SCRIPT_TOOL_NAME, SCIENCE_WRITING_VERSION, SCIENCE_RECREATION_MODEL, SCIENCE_NARRATOR } from './science-script.js'
import { createHash } from 'node:crypto'
import { transcribeHistoryAudio } from './history-script-processing.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ScienceWriterUnavailableError } from './science-writing-model.js'

const storyFields = {
  sourceTheme: '认识一件熟悉事物身上容易忽略的本领',
  sourceTelling: { knowledge: '解释眼前的现象', form: '沿着观察逐步揭晓', openingDevice: '先摆出意外现象', whyEngaging: '先想知道结果，再看到过程', voiceAndHumor: '生活化的观察与反差', endingPayoff: '解开开头疑问' },
  narrativeBeats: [{ id: 'n1', evidenceIds: ['e1'], content: '先看见具体的反常现象，再展开动作与原因', tellingMethod: '先呈现反差，再逐步解释', questionBefore: '为什么会这样', reveal: '结构发生变化', questionAfter: '这个变化如何产生结果', humorOrImage: '眼前熟悉的东西表现得不合常理' }],
  emotionalArc: [{ id: 'em1', from: '熟悉', to: '好奇', trigger: '观察到与直觉不同的现象', evidenceIds: ['e1'] }],
  tellingMaterials: [{ id: 'mat1', evidenceIds: ['e1'], detail: '眼前具体的观察', role: '引出问题并解释机制', disposition: 'retain' as const, reason: '承载主题' }],
}
const tellingFixture = { sourceBeatIds: ['n1'], materialIds: ['mat1'], emotionIds: ['em1'], sceneOrAction: '让观众看见眼前的现象', explanation: '用具体因果解释', nextQuestion: '回到眼前的发现' }
const isPlanning = (options: any) => options?.toolChoice?.function?.name === SCIENCE_PLAN_TOOL_NAME

function planningFixture(source = 'Ice floats.'): SciencePlanning {
  return {
    ...storyFields,
    sourceSummary: 'water freezes', coreClaim: 'density changes', angle: 'density', authorStance: 'explain the mechanism',
    background: [], mechanisms: [{ id: 'm1', claim: 'water expands', explanation: 'structure changes', conditions: 'freezing water', evidenceIds: ['e1'] }],
    evidence: [{ id: 'e1', material: source, supports: 'density', limitation: 'source observation' }],
    sourceOutline: [{ id: 'o1', summary: 'question' }, { id: 'o2', summary: 'answer' }],
    curiosityArc: [{ id: 'c1', stage: 'question', question: 'why', trigger: 'ice' }, { id: 'c2', stage: 'answer', question: 'how', trigger: 'density' }],
    factsToPreserve: ['water expands'], facts: ['water expands'], factChecks: [{ claim: '9%', note: 'temperature conditions' }],
    angles: ['mechanism', 'counterintuitive', 'boundary'].map(id => ({ id: id as SciencePlanning['selectedAngleId'], title: id, stance: 'explain', contrast: 'ice and water', evidence: ['e1'], outline: ['question', 'answer'] })),
    selectedAngleId: 'mechanism', selectionReason: 'source supports the mechanism',
    writingOutline: { thesis: 'density', stance: 'explain', endingPayoff: 'ice floats', sections: [
      { id: 's1', telling: tellingFixture, purpose: 'question', newInformation: 'ice floats', backgroundIds: [], mechanismIds: [], evidenceIds: ['e1'], curiosityIds: ['c1'] },
      { id: 's2', telling: tellingFixture, purpose: 'answer', newInformation: 'structure changes', backgroundIds: [], mechanismIds: ['m1'], evidenceIds: ['e1'], curiosityIds: ['c2'] },
    ] },
  }
}

test('paraphrasing uses the complete original rather than turning analysis additions into requirements', async () => {
  const transcript = '鹅在一些超市里很少见。鹅会吃草，也能提供鹅绒。养鹅和养鸡的生产方式不同。'
  const plan = structuredClone(planningFixture(transcript))
  plan.factsToPreserve = ['ANALYSIS_ADDED_REQUIREMENT']
  plan.mechanisms[0]!.conditions = 'ANALYSIS_ADDED_CONDITION'
  plan.evidence.push({ id: 'e2', material: '鹅会吃草，也能提供鹅绒。', supports: 'secondary detail', limitation: 'none' })
  plan.tellingMaterials.push({ id: 'omit2', evidenceIds: ['e2'], detail: 'secondary detail', role: 'detail', disposition: 'omit', reason: 'optional detail' })
  let writes = 0, reviews = 0
  const draft = { title: '为什么很少见到鹅肉', script: '有些超市不常卖鹅肉。鹅能吃草、产鹅绒，不过它的养殖方式和鸡并不一样。' }
  const result = await recreateScienceScript({ transcript, title: '鹅肉', sourceUrl: 'source' }, {
    signal: new AbortController().signal,
    call: async () => JSON.stringify(plan),
    write: async messages => {
      writes++
      assert.equal(JSON.parse(messages[1]!.content).readingMaterial, transcript)
      assert.doesNotMatch(JSON.stringify(messages), /ANALYSIS_ADDED_/)
      assert.match(messages[0]!.content, /换.*表达/)
      return JSON.stringify(draft)
    },
    review: async messages => {
      reviews++
      assert.deepEqual(JSON.parse(messages[1]!.content), { source: transcript, draft })
      assert.match(messages[0]!.content, /原稿是唯一依据/)
      assert.match(messages[0]!.content, /不.*补充.*限定/)
      return JSON.stringify({ issues: [] })
    },
  })
  assert.deepEqual({ title: result.title, script: result.script }, draft)
  assert.equal(writes, 1); assert.equal(reviews, 1)
})

test('both full and local repairs retain the complete original without analysis instructions', async () => {
  for (const local of [false, true]) {
    const transcript = 'Ice floats. The rest of the original is also available for repairs.'
    const plan = { ...structuredClone(planningFixture('Ice floats.')), sourceHash: createHash('sha256').update(transcript).digest('hex'), model: SCIENCE_RECREATION_MODEL, writingVersion: SCIENCE_WRITING_VERSION }
    plan.factsToPreserve = ['ANALYSIS_ADDED_REQUIREMENT']
    let writes = 0, reviews = 0
    await recreateScienceScript({ transcript, title: 'Ice', sourceUrl: 'source', plan }, {
      signal: new AbortController().signal, call: async () => assert.fail('reuse the saved source analysis'),
      write: async messages => {
        writes++
        assert.ok(JSON.parse(messages[1]!.content).readingMaterial.includes(transcript))
        assert.doesNotMatch(JSON.stringify(messages), /ANALYSIS_ADDED_REQUIREMENT/)
        return JSON.stringify({ title: '冰', script: writes === 1 ? '冰会下沉。' : '冰会浮起来。' })
      },
      review: async () => JSON.stringify({ issues: ++reviews === 1 ? [{ quote: local ? '冰会下沉。' : '', instruction: '原稿是冰会浮起，请修正相反的含义。' }] : [] }),
    })
    assert.equal(writes, 2); assert.equal(reviews, 2)
  }
})

test('science recreation plans first, preserves concerns and requires a complete Chinese rewrite', async () => {
  const requests: any[] = []
  const plan = planningFixture()
  const result = await recreateScienceScript({ transcript: 'Ice floats.', title: 'Ice', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }, {
    signal: new AbortController().signal, call: async (messages, options) => {
      requests.push({ messages, options }); assert.equal(options?.requireComplete, true)
      assert.equal(options?.extraBody?.model, 'gpt-6.1-terra')
      return JSON.stringify(requests.length === 1 ? plan : { title: '冰为什么能浮在水上', script: '结冰时水的结构改变，密度降低。' })
    },
  })
  assert.equal(requests.length, 2); assert.match(requests[0].messages[0].content, /不得宣称事实已经核查/)
  assert.deepEqual(result.plan.factChecks, plan.factChecks)
  assert.equal(result.plan.model, 'gpt-6.1-terra')
  const second = JSON.parse(requests[1].messages[1].content); assert.equal(second.readingMaterial, 'Ice floats.')
  await assert.rejects(recreateScienceScript({ transcript: 'same', title: 'title', sourceUrl: 'source' }, {
    signal: new AbortController().signal, call: async (_m, opts) => JSON.stringify(isPlanning(opts) ? planningFixture('same') : { title: '相同稿', script: 'same' }),
  }), /与原稿相同/)
})

test('science narration starts with the topic even when the writer repeats the fixed introduction', async () => {
  const body = '我先给你们看块冰，它浮在水面上，可不是因为它特别轻。'
  const result = await recreateScienceScript(retrySource, {
    signal: new AbortController().signal,
    call: async (_messages, options) => JSON.stringify(isPlanning(options) ? planningFixture()
      : { title: retryDraft.title, script: `大家好，我是小鹭，你们的冷知识讲解员。\n\n${body}` }),
  })
  assert.equal(result.script, body)
})

test('narration cleanup handles punctuation and spacing but preserves first-person body sentences', () => {
  const body = '我先给你们看块冰，它为什么能浮在水面上？'
  for (const introduction of [
    '大家好，我是小鹭，你们的冷知识讲解员。',
    ' \t大家好!\r\n我是 小鹭, 你们的 冷知识讲解员!\n\n',
    '大家好。我是小鹭，你们的冷知识讲解员\n',
    '大家好；我是小鹭；你们的冷知识讲解员；',
  ]) assert.equal(stripScienceNarrationIntroduction(introduction + body), body)
  assert.equal(stripScienceNarrationIntroduction(`  ${body}\n`), body)
  assert.equal(stripScienceNarrationIntroduction('我是小鹭，我想先说说冰。'), '我是小鹭，我想先说说冰。')
  const quotedIntroduction = '我先给你们看句台词：“大家好，我是小鹭，你们的冷知识讲解员。”'
  assert.equal(stripScienceNarrationIntroduction(quotedIntroduction), quotedIntroduction)
  assert.equal(stripScienceNarrationIntroduction('大家好，我是小鹭，你们的冷知识讲解员。'), '')
  assert.equal(stripScienceNarrationIntroduction('大家好，我是小鹭。冰为什么浮在水上？'), '冰为什么浮在水上？')
  assert.equal(stripScienceNarrationIntroduction('大家好，我是老肉。冰为什么浮在水上？'), '冰为什么浮在水上？')
  assert.equal(stripScienceNarrationIntroduction('大家好! 我是 老肉, 欢迎来到老肉杂谈。\n冰为什么浮在水上？'), '冰为什么浮在水上？')
})

test('a fixed introduction alone cannot be accepted as narration', async () => {
  let writings = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal,
    call: async messages => {
      writings++
      if (writings === 1) return JSON.stringify({ title: retryDraft.title, script: SCIENCE_NARRATOR.introduction })
      const request = JSON.parse(messages[1]!.content)
      assert.equal(request.previousDraft.script, '')
      assert.match(request.revisionInstruction, /只有 0 个非空白字符/)
      return JSON.stringify(retryDraft)
    },
  })
  assert.equal(writings, 2)
  assert.equal(result.script, retryDraft.script)
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal,
    call: async () => JSON.stringify({ title: retryDraft.title, script: SCIENCE_NARRATOR.introduction }),
  }), { code: 'science_script_revision_pending', retryable: true })
})

test('new analysis rejects object-shaped fields and cannot fall back to a legacy plan', async () => {
  const objectPlan = { ...planningFixture(), angle: { title: 'density' }, facts: [{ claim: 'water expands' }] }
  const legacyPlan = { sourceSummary: 'water freezes', angle: 'density', outline: ['problem', 'mechanism'], facts: ['water expands'], factChecks: [] }
  for (const plan of [objectPlan, legacyPlan]) {
    let calls = 0, saved = 0
    await assert.rejects(recreateScienceScript({ transcript: 'Ice floats.', title: 'Ice', sourceUrl: 'source' }, {
      signal: new AbortController().signal, onPlan: () => { saved++ },
      call: async () => { calls++; return JSON.stringify(plan) },
    }), /科普分析工具参数不符合约定/)
    assert.equal(calls, 1); assert.equal(saved, 0)
  }
})

test('science planning is reused only when the source and writing model match', async () => {
  const transcript = 'Ice floats.', sourceHash = createHash('sha256').update(transcript).digest('hex')
  const planning = planningFixture()
  for (const model of [undefined, 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra']) {
    let calls = 0
    const result = await recreateScienceScript({ transcript, title: 'Ice', sourceUrl: 'source', plan: { ...planning, sourceHash, model, writingVersion: SCIENCE_WRITING_VERSION } }, {
      signal: new AbortController().signal,
      call: async (_messages, options) => {
        calls++; assert.equal(options?.extraBody?.model, 'gpt-6.1-terra')
        return JSON.stringify(isPlanning(options) ? planning : { title: '冰为什么浮在水上', script: '水结冰时体积膨胀，密度下降。' })
      },
    })
    assert.equal(calls, model === 'gpt-6.1-terra' ? 1 : 2)
    assert.equal(result.plan.model, 'gpt-6.1-terra')
  }
})

test('matching source and model cannot reuse a malformed or unsupported saved analysis', async () => {
  const sourceHash = createHash('sha256').update('Ice floats.').digest('hex')
  for (const plan of [
    { ...planningFixture(), angle: { unexpected: 'object' } },
    { ...planningFixture(), evidence: [{ id: 'e1', material: 'invented quote', supports: 'density', limitation: 'none' }] },
  ]) {
    let calls = 0
    const result = await recreateScienceScript({ transcript: 'Ice floats.', title: 'Ice', sourceUrl: 'source',
      plan: { ...plan, sourceHash, model: 'gpt-6.1-terra', writingVersion: SCIENCE_WRITING_VERSION } as SciencePlan }, {
      signal: new AbortController().signal, call: async (_messages, options) => {
        calls++; return JSON.stringify(isPlanning(options) ? planningFixture() : { title: '冰为什么浮起来', script: '水结冰后密度降低。' })
      },
    })
    assert.equal(calls, 2); assert.equal(result.plan.angle, 'density')
  }
})

test('candidate angles cannot reference nonexistent evidence even with valid tool field types', async () => {
  const plan = planningFixture()
  plan.angles[0]!.evidence = ['missing-evidence']
  let calls = 0
  await assert.rejects(recreateScienceScript({ transcript: 'Ice floats.', title: 'Ice', sourceUrl: 'source' }, {
    signal: new AbortController().signal, call: async () => { calls++; return JSON.stringify(plan) },
  }), /候选角度.*不存在的证据/)
  assert.equal(calls, 1)
})

test('a clear source theme needs one telling route and no invented scientific caveats', async () => {
  const plan = structuredClone(planningFixture())
  plan.angles = [plan.angles[0]!]
  plan.mechanisms[0]!.conditions = ''
  let saved: SciencePlan | undefined
  const result = await recreateScienceScript(retrySource, {
    signal: new AbortController().signal, onPlan: value => { saved = value },
    call: async (_messages, options) => JSON.stringify(isPlanning(options) ? plan : retryDraft),
  })
  assert.equal(saved?.angles?.length, 1)
  assert.equal(result.plan.mechanisms?.[0]?.conditions, '')
})

test('editorial selection comments and planned conditions remain only in the saved analysis', async () => {
  const plan = structuredClone(planningFixture())
  plan.tellingMaterials[0]!.reason = 'EDITORIAL_SELECTION_NOTE'
  plan.evidence[0]!.limitation = 'EDITORIAL_SOURCE_NOTE'
  plan.factChecks[0]!.note = 'EDITORIAL_CHECK_NOTE'
  let brief: any
  const result = await recreateScienceScript(retrySource, {
    signal: new AbortController().signal,
    call: async (messages, options) => {
      if (isPlanning(options)) return JSON.stringify(plan)
      brief = JSON.parse(messages[1]!.content).readingMaterial
      return JSON.stringify(retryDraft)
    },
  })
  assert.doesNotMatch(JSON.stringify(brief), /EDITORIAL_/)
  assert.equal(brief, retrySource.transcript)
  assert.equal(result.plan.tellingMaterials?.[0]?.reason, 'EDITORIAL_SELECTION_NOTE')
})

test('writing receives the whole source even when display analysis marks a passage as optional', async () => {
  const transcript = 'Ice floats. OPTIONAL_SOURCE_DETAIL'
  const plan = structuredClone(planningFixture('Ice floats.'))
  plan.evidence.push({ id: 'e2', material: 'OPTIONAL_SOURCE_DETAIL', supports: 'detail', limitation: 'optional' })
  plan.tellingMaterials.push({ id: 'omit2', evidenceIds: ['e2'], detail: 'OPTIONAL_SOURCE_DETAIL', role: 'detail', disposition: 'omit', reason: 'optional' })
  await recreateScienceScript({ ...retrySource, transcript }, {
    signal: new AbortController().signal,
    call: async (messages, options) => {
      if (isPlanning(options)) {
        assert.match(messages[1]!.content, /OPTIONAL_SOURCE_DETAIL/)
        return JSON.stringify(plan)
      }
      const request = JSON.parse(messages[1]!.content)
      assert.deepEqual(request.narrator, { name: SCIENCE_NARRATOR.name, perspective: SCIENCE_NARRATOR.perspective })
      assert.equal(request.narrator.perspective, '第一人称')
      assert.match(messages[0]!.content, /正文直接切入话题/)
      assert.match(messages[0]!.content, /不加自我介绍/)
      assert.match(messages[0]!.content, /固定开场已有独立视频/)
      assert.equal(request.readingMaterial, transcript)
      assert.doesNotMatch(JSON.stringify(messages), /先看见具体的反常现象/)
      assert.doesNotMatch(request.readingMaterial, /evidenceIds|sourceBeatIds|materialIds/)
      return JSON.stringify(retryDraft)
    },
  })
})

test('the new outline covers source storytelling beats in their original reveal order', async () => {
  const fixture = () => {
    const plan = structuredClone(planningFixture())
    plan.narrativeBeats.push({ ...plan.narrativeBeats[0]!, id: 'n2', content: '最后才揭晓的实验结果' })
    plan.writingOutline.sections[1]!.telling = { ...tellingFixture, sourceBeatIds: ['n2'] }
    return plan
  }
  for (const change of [
    (plan: SciencePlanning) => { plan.writingOutline.sections[1]!.telling.sourceBeatIds = ['missing'] },
    (plan: SciencePlanning) => { plan.writingOutline.sections[1]!.telling.sourceBeatIds = ['n1'] },
    (plan: SciencePlanning) => { plan.writingOutline.sections.reverse() },
    (plan: SciencePlanning) => { plan.narrativeBeats[0]!.evidenceIds = ['missing'] },
  ]) {
    const plan = fixture(); change(plan)
    let writes = 0
    await assert.rejects(recreateScienceScript(retrySource, {
      signal: new AbortController().signal,
      call: async (_messages, options) => {
        if (isPlanning(options)) return JSON.stringify(plan)
        writes++; return JSON.stringify(retryDraft)
      },
    }), /讲述节点/)
    assert.equal(writes, 0)
  }
  const plan = fixture()
  const result = await recreateScienceScript(retrySource, {
    signal: new AbortController().signal,
    call: async (_messages, options) => JSON.stringify(isPlanning(options) ? plan : retryDraft),
  })
  assert.deepEqual(result.plan.narrativeBeats, plan.narrativeBeats)
})

test('story transitions reach the writer even when they are not standalone knowledge materials', async () => {
  const transcript = 'Ice floats. We will reveal why later.'
  const plan = structuredClone(planningFixture('Ice floats.'))
  plan.evidence.push({ id: 'transition', material: 'We will reveal why later.', supports: 'delay the reveal', limitation: 'delivery only' })
  plan.narrativeBeats[0]!.evidenceIds.push('transition')
  await recreateScienceScript({ ...retrySource, transcript }, {
    signal: new AbortController().signal,
    call: async (messages, options) => {
      if (isPlanning(options)) return JSON.stringify(plan)
      assert.ok(JSON.parse(messages[1]!.content).readingMaterial.includes('We will reveal why later.'))
      return JSON.stringify(retryDraft)
    },
  })
  plan.tellingMaterials.push({ id: 'omit-transition', evidenceIds: ['transition'], detail: 'We will reveal why later.', role: 'omitted', disposition: 'omit', reason: 'fixture exclusion' })
  await assert.rejects(recreateScienceScript({ ...retrySource, transcript }, {
    signal: new AbortController().signal, call: async () => JSON.stringify(plan),
  }), /讲述节点.*已省略/)
})

test('long sources request an advisory 1000-1500 character condensation without a source-proportional floor', () => {
  const guide = scienceNarrationLength('知识'.repeat(2500))
  assert.equal(guide.minimum, 1)
  assert.match(guide.suggested, /1000.*1500/)
  assert.match(guide.suggested, /可以明显超过1500字/)
  assert.match(guide.suggested, /前半部分.*开场.*铺垫/)
  assert.equal(guide.maximumCharacters, 10000)
  assert.equal(scienceNarrationLength('知识'.repeat(20000)).minimum, 1)
  assert.match(scienceNarrationLength('冰会浮在水面上。').suggested, /不.*凑/)
})

test('science routes the actual narration to the dedicated writing model and preserves both arcs', async () => {
  const transcript = '骆驼脚掌宽大，走在松软的沙地上不容易陷下去。'.repeat(240)
  const sourcePlan = planningFixture(transcript)
  let analyses = 0, writings = 0
  const condensed = '脚一踩下去，沙子就向两边滑。骆驼宽宽的脚掌分散了身体的重量，所以不容易陷进沙里。'.repeat(25)
  const result = await recreateScienceScript({ transcript, title: '骆驼的脚掌', sourceUrl: 'source' }, {
    signal: new AbortController().signal, writingModel: 'remote-writing-fixture',
    call: async (_messages, options) => {
      assert.equal(isPlanning(options), true, 'the general provider must only analyze the source')
      analyses++; return JSON.stringify(sourcePlan)
    },
    write: async (messages, options) => {
      writings++
      assert.equal(options?.extraBody?.model, 'remote-writing-fixture')
      assert.equal(options?.maxTokens, 4000)
      assert.match(messages[0]!.content, /情绪弧线/)
      assert.match(messages[0]!.content, /故事推进/)
      assert.match(messages[0]!.content, /质量优先于字数/)
      assert.match(messages[0]!.content, /前半部分的开场和铺垫自然保留/)
      assert.match(messages[0]!.content, /句子间的逻辑更合理，更通俗，可读性更强，句子更通顺/)
      const brief = JSON.parse(messages[1]!.content).readingMaterial
      assert.equal(brief, transcript)
      assert.doesNotMatch(brief, /sourceBeatIds|emotionalArc/)
      return JSON.stringify({ title: '骆驼为什么不容易陷进沙里', script: condensed })
    },
  })
  assert.equal(analyses, 1); assert.equal(writings, 1)
  assert.equal(result.script, condensed)
  assert.equal(result.plan.writingModel, 'remote-writing-fixture')
})

test('substantive repetition reported by review receives one revision without repeating analysis', async () => {
  const transcript = '骆驼的脚掌很宽，走在沙地上时，能把体重分散开，不容易深陷在沙里。'.repeat(70)
  let analyses = 0, writings = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, transcript }, {
    signal: new AbortController().signal,
    call: async () => { analyses++; return JSON.stringify(planningFixture(transcript)) },
    write: async messages => {
      if (++writings === 1) return JSON.stringify({ title: '骆驼的脚掌', script: `${transcript}所以它能走得更稳。` })
      assert.match(JSON.parse(messages[1]!.content).revisionInstruction, /重复解释/)
      return JSON.stringify({ title: '骆驼的脚掌', script: '沙子一踩就散，骆驼却能稳稳地走过去。它宽大的脚掌把体重分散开，不容易深陷在松软的沙里。' })
    },
    review: async () => JSON.stringify({ issues: ++reviews === 1
      ? [{ quote: '', instruction: '同一原因反复重复解释，请合并重复内容，保留开场的具体观察和关键因果。' }] : [] }),
  })
  assert.equal(analyses, 1); assert.equal(writings, 2); assert.equal(reviews, 2)
  assert.ok(result.script.length < transcript.length)
})

test('source review decides quality without a 1500 character ceiling or source length ratio gate', async () => {
  const transcript = '骆驼的脚掌很宽，走在沙地上时，能把体重分散开，不容易深陷在沙里。'.repeat(60)
  const script = '沙子一踩就散，骆驼却能稳稳地走过去。它宽大的脚掌把体重分散开，不容易深陷在松软的沙里。'.repeat(60)
  assert.ok(script.length > 1500 && script.length > transcript.length)
  let writes = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, transcript }, {
    signal: new AbortController().signal,
    call: async (messages, options) => {
      assert.ok(isPlanning(options))
      assert.match(messages[0]!.content, /不策划新文章/)
      return JSON.stringify(planningFixture(transcript))
    },
    write: async () => {
      assert.equal(++writes, 1, 'length alone must not trigger another writing request')
      return JSON.stringify({ title: '骆驼的脚掌', script })
    },
    review: async (messages) => {
      reviews++
      assert.match(messages[0]!.content, /核心意思和主要叙述顺序接近/)
      assert.match(messages[0]!.content, /不能仅凭字数、与原文的长度比例/)
      assert.equal(JSON.parse(messages[1]!.content).draft.script, script)
      return JSON.stringify({ issues: [] })
    },
  })
  assert.equal(writes, 1); assert.equal(reviews, 1)
  assert.equal(result.script, script)
})

test('a short draft with all core beats still reaches content review instead of automatic length repair', async () => {
  const transcript = '冰浮在水面，水下的鱼仍能活动。结冰时体积增大，密度降低。'.repeat(100)
  const plan = planningFixture(transcript)
  plan.narrativeBeats = Array.from({ length: 4 }, (_, index) => ({ ...plan.narrativeBeats[0]!, id: `n${index + 1}` }))
  plan.writingOutline.sections[0]!.telling = { ...plan.writingOutline.sections[0]!.telling, sourceBeatIds: ['n1', 'n2'] }
  plan.writingOutline.sections[1]!.telling = { ...plan.writingOutline.sections[1]!.telling, sourceBeatIds: ['n3', 'n4'] }
  let writes = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, transcript }, {
    signal: new AbortController().signal,
    call: async () => JSON.stringify(plan),
    write: async () => { writes++; return JSON.stringify(retryDraft) },
    review: async () => { reviews++; return JSON.stringify({ issues: [] }) },
  })
  assert.equal(writes, 1); assert.equal(reviews, 1)
  assert.equal(result.script, retryDraft.script)
})

test('a failed dedicated writer preserves analysis and never falls back to the general provider', async () => {
  let analyses = 0, saved: SciencePlan | undefined
  await assert.rejects(recreateScienceScript(retrySource, {
    signal: new AbortController().signal, onPlan: plan => { saved = plan },
    call: async () => { analyses++; return JSON.stringify(planningFixture()) },
    write: async () => { throw Object.assign(new Error('writer context rejected'), { status: 400 }) },
  }), /writer context rejected/)
  assert.equal(analyses, 1)
  assert.equal(saved?.writingVersion, SCIENCE_WRITING_VERSION)
})

test('a reused valid plan is checkpointed before a failed remote write', async () => {
  let saved: SciencePlan | undefined
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: { ...retryPlan, writingModel: 'old-writer' } }, {
    signal: new AbortController().signal, onPlan: plan => { saved = plan },
    call: async () => assert.fail('a valid source analysis must be reused'),
    write: async () => { throw Object.assign(new Error('writer unavailable'), { status: 401 }) },
  }), /writer unavailable/)
  assert.equal(saved?.sourceHash, retryPlan.sourceHash)
  assert.equal(saved?.writingVersion, SCIENCE_WRITING_VERSION)
  assert.equal(saved?.writingModel, undefined, 'the new manuscript has not been written yet')
})

test('source comparison sends concrete factual corrections back to the same writer without repeating analysis', async () => {
  let writes = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal,
    call: async () => assert.fail('the valid analysis is already saved'),
    write: async messages => {
      writes++
      if (writes === 1) return JSON.stringify({ ...retryDraft, script: '冰在水中会沉下去。' })
      const input = JSON.parse(messages[1]!.content)
      assert.match(input.revisionInstruction, /会沉下去.*会浮起来/)
      assert.equal(input.previousDraft.script, '冰在水中会沉下去。')
      assert.match(input.readingMaterial, /Ice floats\./, 'revision keeps the original alongside the prior draft and correction')
      return JSON.stringify(retryDraft)
    },
    review: async (messages, options) => {
      assert.equal(options?.extraBody?.model, SCIENCE_RECREATION_MODEL)
      assert.equal(options?.toolChoice && typeof options.toolChoice === 'object' && options.toolChoice.function.name, 'review_science_script')
      assert.equal(JSON.parse(messages[1]!.content).source, retrySource.transcript)
      return JSON.stringify({ issues: ++reviews === 1 ? [{ quote: '冰在水中会沉下去。', instruction: '会沉下去与原文Ice floats相反，改为会浮起来。' }] : [] })
    },
  })
  assert.equal(writes, 2); assert.equal(reviews, 2)
  assert.equal(result.script, retryDraft.script)
})

test('a draft still failing source comparison retains its correction checkpoint for automatic continuation', async () => {
  let writes = 0, checkpoint: ScienceWritingCheckpoint | undefined
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, call: async () => assert.fail('no fallback'),
    write: async () => { writes++; return JSON.stringify({ ...retryDraft, script: `${retryDraft.script}这是第${writes}次讲述。` }) },
    review: async () => JSON.stringify({ issues: [{ quote: '', instruction: '缺失关键转折，请按原文补齐。' }] }),
    onCheckpoint: value => { checkpoint = structuredClone(value) },
  }), { code: 'science_script_revision_pending', retryable: true })
  assert.equal(writes, 8)
  assert.equal(checkpoint?.round, 8)
  assert.equal(checkpoint?.reviewed, true)
  assert.equal(checkpoint?.draft.script, `${retryDraft.script}这是第8次讲述。`)
  assert.deepEqual(checkpoint?.issues, [{ quote: '', instruction: '缺失关键转折，请按原文补齐。' }])
  assert.match(checkpoint?.feedback || '', /缺失关键转折/)
})

function writingCheckpoint(changes: Partial<ScienceWritingCheckpoint> = {}): ScienceWritingCheckpoint {
  return { version: 1, sourceHash: retryPlan.sourceHash, writingVersion: SCIENCE_WRITING_VERSION,
    writingModel: 'fixture-qwen', draft: { title: '冰的故事', script: '开头的发现。冰会下沉。故事的回收。' },
    issues: [{ quote: '冰会下沉。', instruction: '与原文Ice floats相反，应为冰会浮起来。' }],
    feedback: '与原文Ice floats相反，应为冰会浮起来。', round: 2, reviewed: true, ...changes }
}

test('a reviewed rejected checkpoint resumes its exact correction without repeating analysis or generating a fresh first draft', async () => {
  const checkpoint = writingCheckpoint()
  let writes = 0, reviews = 0
  const saved: ScienceWritingCheckpoint[] = []
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, checkpoint, writingModel: 'fixture-qwen',
    call: async () => assert.fail('source analysis already exists'),
    write: async messages => {
      writes++
      const input = JSON.parse(messages[1]!.content)
      assert.equal(input.previousDraft.script, '冰会下沉。')
      assert.match(input.revisionInstruction, /冰会浮起来/)
      assert.match(input.readingMaterial, /开头的发现。冰会下沉。故事的回收。/)
      assert.match(input.readingMaterial, /Ice floats\./)
      return JSON.stringify({ title: '忽略局部标题', script: '冰会浮起来。' })
    },
    review: async messages => {
      reviews++
      assert.equal(JSON.parse(messages[1]!.content).draft.script, '开头的发现。冰会浮起来。故事的回收。')
      return JSON.stringify({ issues: [] })
    },
    onCheckpoint: value => saved.push(structuredClone(value)),
  })
  assert.equal(writes, 1); assert.equal(reviews, 1)
  assert.equal(result.title, checkpoint.draft.title)
  assert.equal(result.script, '开头的发现。冰会浮起来。故事的回收。')
  assert.ok(saved.some(value => value.reviewed === false && value.draft.script === result.script), 'new prose is durable before review')
  assert.equal(checkpoint.draft.script, '开头的发现。冰会下沉。故事的回收。', 'input checkpoint is not mutated')
})

test('an unreviewed checkpoint is checked before a resumed writer can replace it', async () => {
  let reviews = 0
  const checkpoint = writingCheckpoint({ reviewed: false, issues: [], feedback: '', draft: retryDraft })
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, checkpoint, writingModel: 'fixture-qwen',
    call: async () => assert.fail('reuse source analysis'),
    write: async () => assert.fail('a passing durable draft needs no new writing'),
    review: async messages => {
      reviews++; assert.deepEqual(JSON.parse(messages[1]!.content).draft, retryDraft)
      return JSON.stringify({ issues: [] })
    },
  })
  assert.equal(reviews, 1)
  assert.equal(result.script, retryDraft.script)
})

test('an interruption between local corrections preserves the completed repair and resumes only the remaining passage', async () => {
  const original = writingCheckpoint({ draft: { title: '冰的故事', script: '第一处有误。中间正确。第二处有误。' },
    issues: [{ quote: '第一处有误。', instruction: '修正第一处' }, { quote: '第二处有误。', instruction: '修正第二处' }],
    feedback: '修正第一处\n修正第二处' })
  let checkpoint: ScienceWritingCheckpoint | undefined, writes = 0
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, checkpoint: original, writingModel: 'fixture-qwen',
    call: async () => assert.fail('reuse source analysis'),
    write: async () => {
      if (++writes === 1) return JSON.stringify({ title: '局部标题', script: '第一处已修正。' })
      throw Object.assign(new Error('writer login unavailable'), { status: 401 })
    },
    review: async () => assert.fail('both local repairs must complete before review'),
    onCheckpoint: value => { checkpoint = structuredClone(value) },
  }), /writer login unavailable/)
  assert.equal(checkpoint?.draft.script, '第一处已修正。中间正确。第二处有误。')
  assert.deepEqual(checkpoint?.issues, [{ quote: '第二处有误。', instruction: '修正第二处' }])
  assert.equal(checkpoint?.reviewed, true)
  let resumedWrites = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, checkpoint, writingModel: 'fixture-qwen',
    call: async () => assert.fail('reuse source analysis again'),
    write: async messages => {
      resumedWrites++
      assert.equal(JSON.parse(messages[1]!.content).previousDraft.script, '第二处有误。')
      return JSON.stringify({ title: '局部标题', script: '第二处已修正。' })
    },
    review: async () => JSON.stringify({ issues: [] }),
  })
  assert.equal(resumedWrites, 1)
  assert.equal(result.script, '第一处已修正。中间正确。第二处已修正。')
})

test('a draft checkpoint from a different source, writing version or writing model is never reused', async () => {
  for (const changes of [{ sourceHash: 'a'.repeat(64) }, { writingVersion: 'source-condensation-v7' }, { writingModel: 'different-writer' }]) {
    let writes = 0, reviews = 0
    const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
      signal: new AbortController().signal, checkpoint: writingCheckpoint(changes), writingModel: 'fixture-qwen',
      call: async () => assert.fail('valid source analysis remains reusable'),
      write: async messages => {
        writes++; assert.equal(JSON.parse(messages[1]!.content).previousDraft, undefined)
        return JSON.stringify(retryDraft)
      },
      review: async () => { reviews++; return JSON.stringify({ issues: [] }) },
    })
    assert.equal(writes, 1); assert.equal(reviews, 1); assert.equal(result.script, retryDraft.script)
  }
})

test('local corrections use the verified original positions when an earlier replacement repeats a later quote', async () => {
  let writes = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, writingModel: 'fixture-qwen',
    call: async () => assert.fail('reuse source analysis'),
    write: async messages => {
      if (++writes === 1) return JSON.stringify({ title: '位置核验', script: '第一处有误。第二处有误。' })
      const quote = JSON.parse(messages[1]!.content).previousDraft.script
      return JSON.stringify({ title: '位置核验', script: quote === '第一处有误。' ? '第二处有误。作为引子。' : '第二处已修正。' })
    },
    review: async () => JSON.stringify({ issues: ++reviews === 1 ? [
      { quote: '第一处有误。', instruction: '修正第一处' }, { quote: '第二处有误。', instruction: '修正第二处' },
    ] : [] }),
  })
  assert.equal(result.script, '第二处有误。作为引子。第二处已修正。')
  assert.equal(writes, 3); assert.equal(reviews, 2)
})

test('multiple anchored corrections preserve the draft instead of generating the full article again', async () => {
  const rejected = { title: '冰的故事', script: '第一处有误。第二处有误。第三处有误。' }
  let writes = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, writingModel: 'fixture-qwen',
    call: async () => assert.fail('reuse source analysis'),
    write: async messages => {
      if (++writes === 1) return JSON.stringify(rejected)
      const input = JSON.parse(messages[1]!.content)
      assert.match(input.previousDraft.script, /^第[一二三]处有误。$/)
      assert.equal(input.revisionInstruction, input.previousDraft.script.replace('有误。', '').replace('第', '修正第'))
      return JSON.stringify({ title: '局部标题不覆盖原题', script: input.previousDraft.script.replace('有误', '已修正') })
    },
    review: async () => JSON.stringify({ issues: ++reviews === 1 ? [
      { quote: '第一处有误。', instruction: '修正第一处' },
      { quote: '第二处有误。', instruction: '修正第二处' },
      { quote: '第三处有误。', instruction: '修正第三处' },
    ] : [] }),
  })
  assert.equal(writes, 4); assert.equal(reviews, 2)
  assert.equal(result.title, rejected.title)
  assert.equal(result.script, '第一处已修正。第二处已修正。第三处已修正。')
})

test('a factual correction replaces only the verified unique passage and preserves the rest of the story', async () => {
  let writes = 0, reviews = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, call: async () => assert.fail('reuse the source analysis'),
    write: async messages => {
      if (++writes === 1) return JSON.stringify({ title: '冰的故事', script: '开头的发现。冰会下沉。故事的回收。' })
      assert.equal(JSON.parse(messages[1]!.content).previousDraft.script, '冰会下沉。')
      assert.match(messages[2]!.content, /只返回这一个句段/)
      return JSON.stringify({ title: '忽略修订返回的标题', script: '冰会浮起来。' })
    },
    review: async () => JSON.stringify({ issues: ++reviews === 1 ? [{ quote: '冰会下沉。', instruction: '与原文相反，改为浮起来。' }] : [] }),
  })
  assert.equal(result.title, '冰的故事')
  assert.equal(result.script, '开头的发现。冰会浮起来。故事的回收。')
  assert.equal(writes, 2)
})

test('removing a whole promotional passage preserves the surrounding narration', async () => {
  let writes = 0, reviews = 0
  const body = '冰浮在水面上。'
  const promotion = '欢迎加入会员，别忘了点赞订阅。'
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, call: async () => assert.fail('reuse the saved source analysis'),
    write: async (_messages, options) => {
      if (++writes === 1) return JSON.stringify({ title: '冰', script: body + promotion })
      assert.equal((options?.tools?.[0]?.function.parameters as any).properties.script.minLength, 0)
      return JSON.stringify({ title: '局部标题', script: '' })
    },
    review: async () => JSON.stringify({ issues: ++reviews === 1 ? [{ quote: promotion, instruction: '删除原频道广告。' }] : [] }),
  })
  assert.equal(writes, 2); assert.equal(reviews, 2)
  assert.equal(result.script, body)
})

test('an isolated saved draft is reviewed before any resumed writing and cannot bypass source comparison', async () => {
  let reviews = 0, checkpoints = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, draft: retryDraft,
    call: async () => assert.fail('reuse the saved source analysis'),
    write: async () => assert.fail('a passing saved draft needs no new writing'),
    review: async () => { reviews++; return JSON.stringify({ issues: [] }) },
    onDraft: draft => { assert.deepEqual(draft, retryDraft); checkpoints++ },
  })
  assert.equal(result.script, retryDraft.script)
  assert.equal(reviews, 1); assert.equal(checkpoints, 1)
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, draft: retryDraft, call: async () => assert.fail('do not generate'),
  }), /恢复缩写稿必须先配置原文对照核验/)
})

test('a narrator retelling does not deliver editorial references to the original manuscript', async () => {
  let writings = 0
  const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal,
    call: async (messages) => {
      writings++
      if (writings === 1) return JSON.stringify({ title: retryDraft.title,
        script: `${SCIENCE_NARRATOR.introduction}\n原稿提到，水结冰后密度降低。` })
      const request = JSON.parse(messages[1]!.content)
      assert.match(request.revisionInstruction, /小鹭第一人称/)
      assert.equal(request.previousDraft.script, '原稿提到，水结冰后密度降低。')
      return JSON.stringify({ ...retryDraft, script: `大家好! 我是小鹭, 你们的冷知识讲解员!\n${retryDraft.script}` })
    },
  })
  assert.equal(writings, 2)
  assert.equal(result.script, retryDraft.script)
})

test('a speaking outline must ground emotions in source evidence and use every retained material', async () => {
  const changes = [
    (plan: SciencePlanning) => { plan.emotionalArc[0]!.evidenceIds = ['invented-evidence'] },
    (plan: SciencePlanning) => { plan.writingOutline.sections[0]!.telling.emotionIds = ['invented-emotion'] },
    (plan: SciencePlanning) => { plan.tellingMaterials[0]!.disposition = 'omit' },
    (plan: SciencePlanning) => { plan.tellingMaterials.push({ ...plan.tellingMaterials[0]!, id: 'discarded-best-scene' }) },
  ]
  for (const change of changes) {
    const plan = structuredClone(planningFixture()); change(plan)
    let calls = 0, saved = 0
    await assert.rejects(recreateScienceScript(retrySource, {
      signal: new AbortController().signal, onPlan: () => { saved++ },
      call: async () => { calls++; return JSON.stringify(plan) },
    }), /不存在|省略|遗漏|没有保留/)
    assert.equal(calls, 1); assert.equal(saved, 0)
  }
})

test('science preparation records mechanism, evidence, curiosity arc and a covered writing outline', async () => {
  const source = '夜里看到的光并不一定来自火焰。某些生物会利用化学反应产生冷光，这个反应发生在细胞内。'
  const prepared = {
    ...storyFields,
    sourceSummary: '解释生物冷光的来源', coreClaim: '部分生物通过细胞内的化学反应发光', angle: '从反应机制解释冷光误解', authorStance: '原稿强调现象背后的机制，而不是把发光当作火焰',
    background: [{ id: 'b1', content: '冷光是可见光但热量很少', whyNeeded: '帮助区分冷光和火焰' }],
    mechanisms: [{ id: 'm1', claim: '细胞内化学反应产生冷光', explanation: '反应把化学能转为可见光', conditions: '仅适用于原稿提到的生物发光机制', evidenceIds: ['e1'] }],
    evidence: [{ id: 'e1', material: '某些生物会利用化学反应产生冷光', supports: '支持冷光来自化学反应', limitation: '未说明所有发光生物都使用同一反应' }],
    sourceOutline: [{ id: 'o1', summary: '先澄清夜光不等于火焰' }, { id: 'o2', summary: '再解释细胞内反应' }],
    curiosityArc: [{ id: 'c1', stage: '疑问', question: '夜里的光从哪里来', trigger: '夜里看到的光并不一定来自火焰' }, { id: 'c2', stage: '理解', question: '为什么没有火也能发光', trigger: '化学反应发生在细胞内' }],
    factsToPreserve: ['部分生物会发冷光'], facts: ['细胞内发生化学反应'], factChecks: [],
    angles: [
      { id: 'mechanism', title: '光从细胞里来', stance: '先解释机制', contrast: '没有火焰也能发光', evidence: ['e1'], outline: ['提出误解', '解释反应'] },
      { id: 'counterintuitive', title: '越亮不一定越热', stance: '从反直觉结果切入', contrast: '可见光和热量分离', evidence: ['e1'], outline: ['提出反差', '回到机制'] },
      { id: 'boundary', title: '冷光有它的边界', stance: '从适用条件切入', contrast: '不是所有夜光都相同', evidence: ['e1'], outline: ['限定范围', '解释材料'] },
    ],
    selectedAngleId: 'mechanism', selectionReason: '机制材料最完整',
    writingOutline: { thesis: '冷光来自特定的细胞内化学反应', stance: '用机制解释夜光而不夸大范围', sections: [
      { id: 's1', telling: tellingFixture, purpose: '建立夜光疑问', newInformation: '夜光不等于火焰', backgroundIds: ['b1'], mechanismIds: [], evidenceIds: ['e1'], curiosityIds: ['c1'] },
      { id: 's2', telling: tellingFixture, purpose: '解释发光机制', newInformation: '细胞内反应把化学能转成可见光', backgroundIds: [], mechanismIds: ['m1'], evidenceIds: ['e1'], curiosityIds: ['c2'] },
    ], endingPayoff: '回到夜光问题，说明冷光的来源' },
  }
  const result = await recreateScienceScript({ transcript: source, title: '夜里的光', sourceUrl: 'source' }, {
    signal: new AbortController().signal,
    call: async (_messages, options) => JSON.stringify(isPlanning(options) ? prepared : { title: '夜光为什么不一定是火', script: '没有火焰，某些生物也能发光。关键在细胞内的化学反应。' }),
  })
  assert.equal(result.plan.coreClaim, prepared.coreClaim)
  assert.equal(result.plan.writingOutline!.sections.length, 2)
})

test('science preparation rejects evidence that is not quoted from the source transcript', async () => {
  const invalid = { ...storyFields, sourceSummary: 'summary', coreClaim: 'claim', angle: 'mechanism', authorStance: 'stance', background: [], mechanisms: [{ id: 'm1', claim: 'claim', explanation: 'explain', conditions: 'condition', evidenceIds: ['e1'] }], evidence: [{ id: 'e1', material: '来源没有这句话', supports: 'support', limitation: 'limit' }], sourceOutline: [{ id: 'o1', summary: 'one' }, { id: 'o2', summary: 'two' }], curiosityArc: [{ id: 'c1', stage: '疑问', question: 'q', trigger: 't' }, { id: 'c2', stage: '答案', question: 'q2', trigger: 't2' }], factsToPreserve: ['fact'], facts: ['fact'], factChecks: [], angles: [{ id: 'mechanism', title: 'a', stance: 'a', contrast: 'a', evidence: ['e1'], outline: ['a', 'b'] }, { id: 'counterintuitive', title: 'b', stance: 'b', contrast: 'b', evidence: ['e1'], outline: ['a', 'b'] }, { id: 'boundary', title: 'c', stance: 'c', contrast: 'c', evidence: ['e1'], outline: ['a', 'b'] }], selectedAngleId: 'mechanism', selectionReason: 'reason', writingOutline: { thesis: 't', stance: 's', sections: [{ id: 's1', telling: tellingFixture, purpose: 'p', newInformation: 'n', backgroundIds: [], mechanismIds: ['m1'], evidenceIds: ['e1'], curiosityIds: ['c1'] }, { id: 's2', telling: tellingFixture, purpose: 'p2', newInformation: 'n2', backgroundIds: [], mechanismIds: [], evidenceIds: ['e1'], curiosityIds: ['c2'] }], endingPayoff: 'end' } }
  await assert.rejects(recreateScienceScript({ transcript: '真实来源', title: '标题', sourceUrl: 'source' }, { signal: new AbortController().signal, call: async () => JSON.stringify(invalid) }), /证据摘录不在原稿/)
})

test('a paraphrased source quote gets one explicit correction before any plan is saved or prose written', async () => {
  const invalid = structuredClone(planningFixture())
  invalid.evidence[0]!.material = 'Ice stays on top of water.'
  let analyses = 0, writings = 0, saved = 0
  await recreateScienceScript(retrySource, {
    signal: new AbortController().signal, onPlan: () => { saved++ },
    call: async (messages, options) => {
      if (isPlanning(options)) {
        analyses++
        assert.equal(saved, 0); assert.equal(writings, 0)
        if (analyses === 1) return JSON.stringify(invalid)
        const feedback = JSON.parse(messages[1]!.content)
        assert.equal(feedback.referenceScript, retrySource.transcript)
        assert.deepEqual(feedback.invalidEvidence, [{ id: 'e1', material: 'Ice stays on top of water.' }])
        return JSON.stringify(planningFixture())
      }
      writings++; assert.equal(saved, 1)
      return JSON.stringify(retryDraft)
    },
  })
  assert.equal(analyses, 2); assert.equal(writings, 1); assert.equal(saved, 1)
  let attempts = 0
  await assert.rejects(recreateScienceScript(retrySource, {
    signal: new AbortController().signal,
    onPlan: () => assert.fail('invalid source quotes must not be saved'),
    call: async (_messages, options) => {
      assert.ok(isPlanning(options)); attempts++; return JSON.stringify(invalid)
    },
  }), /证据摘录不在原稿/)
  assert.equal(attempts, 2)
})

test('science ASR opts into documented mixed-language recognition without changing historical Chinese default', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'science-asr-')), file = path.join(dir, 'audio.wav')
  fs.writeFileSync(file, 'audio'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const language of ['', undefined]) await transcribeHistoryAudio(file, 10, { language, config: { baseUrl: 'https://asr.example', apiKey: 'fixture' },
    fetchFn: async (_url, options) => { assert.equal(new Headers(options?.headers).get('language'), language === '' ? null : 'zh'); return Response.json({ text: 'Ice floats.', duration: 10 }) },
  })
})

const retrySource = { transcript: 'Ice floats.', title: 'Ice', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }
const retryPlan: SciencePlan = { ...planningFixture(),
  sourceHash: createHash('sha256').update(retrySource.transcript).digest('hex'), model: 'gpt-6.1-terra', writingVersion: SCIENCE_WRITING_VERSION }
const retryDraft = { title: '冰为什么能浮在水上', script: '结冰时水的结构改变，密度降低。' }

test('an old fact-only outline cannot skip understanding the source under the new writing contract', async () => {
  const input = { ...retrySource, plan: { ...retryPlan } }
  delete (input.plan as any).writingVersion
  let analyses = 0
  await recreateScienceScript(input, {
    signal: new AbortController().signal,
    call: async (_messages, options) => {
      if (options?.toolChoice && typeof options.toolChoice === 'object' && options.toolChoice.function.name === SCIENCE_PLAN_TOOL_NAME) {
        analyses++; return JSON.stringify(planningFixture())
      }
      return JSON.stringify(retryDraft)
    },
  })
  assert.equal(analyses, 1, 'same source and model must not revive the old editorial approach')
})

test('a condensed long source below 1000 characters is accepted without padding to an arbitrary floor', async () => {
  const transcript = '骆驼脚掌宽大，走在松软的沙地上不容易陷下去。'.repeat(240)
  let analyses = 0, writings = 0
  const result = await recreateScienceScript({ transcript, title: '骆驼到底有多厉害', sourceUrl: 'source' }, {
    signal: new AbortController().signal,
    call: async (_messages, options) => {
      if (options?.toolChoice && typeof options.toolChoice === 'object' && options.toolChoice.function.name === SCIENCE_PLAN_TOOL_NAME) {
        analyses++; return JSON.stringify(planningFixture(transcript))
      }
      writings++
      return JSON.stringify({ title: '骆驼到底有多厉害', script: '脚一踩下去，沙子就朝两边滑。骆驼宽宽的脚掌能把体重分散开，不容易深陷在沙里。'.repeat(20) })
    },
  })
  assert.equal(analyses, 1); assert.equal(writings, 1)
  assert.ok(result.script.length < 1000)
})
const httpFailure = (status: number, retryAfterMs?: number) => Object.assign(new Error(`Text model request failed: ${status} upstream unavailable`), { status, retryAfterMs })

test('local writer availability waits propagate immediately without spending model attempts', async () => {
  const outage = new ScienceWriterUnavailableError()
  let writes = 0
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal,
    call: async () => assert.fail('The saved source plan must be reused'),
    write: async () => { writes++; throw outage },
    onRetry: () => assert.fail('Availability waiting must not spend a model attempt'),
    sleep: async () => assert.fail('Availability waiting belongs to the durable workflow'),
  }), error => error === outage)
  assert.equal(writes, 1)
})

test('cloud analysis and review network outages still exhaust their finite model retries', async () => {
  for (const phase of ['analysis', 'review'] as const) {
    let requests = 0
    const unavailable = async () => { requests++; throw Object.assign(new Error('connection reset'), {code: 'ECONNRESET'}) }
    await assert.rejects(recreateScienceScript({ ...retrySource, ...(phase === 'review' ? {plan: retryPlan} : {}) }, {
      signal: new AbortController().signal, call: unavailable,
      write: async () => JSON.stringify(retryDraft), review: unavailable, sleep: async () => {},
    }), {code: 'science_model_retry_exhausted', phase, attempts: 4})
    assert.equal(requests, 4)
  }
})

test('temporary analysis and writing failures retry their own phase with bounded backoff and the same model', async () => {
  let analyses = 0, writings = 0, saved = 0
  const retries: ScienceModelRetry[] = [], waits: number[] = []
  const result = await recreateScienceScript(retrySource, {
    signal: new AbortController().signal, onPlan: () => { saved++ }, onRetry: retry => { retries.push(retry) },
    sleep: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms) },
    call: async (messages, options) => {
      assert.equal(options?.extraBody?.model, 'gpt-6.1-terra'); assert.equal(options?.requireComplete, true)
      if (isPlanning(options)) {
        if (++analyses <= 2) throw httpFailure(502)
        return JSON.stringify(planningFixture())
      }
      assert.equal(saved, 1); assert.equal(JSON.parse(messages[1]!.content).readingMaterial, retrySource.transcript); assert.doesNotMatch(messages[1]!.content, /factChecks/)
      if (++writings === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) })
      if (writings === 2) throw httpFailure(503)
      return JSON.stringify(retryDraft)
    },
  })
  assert.deepEqual(result, { ...retryDraft, plan: { ...retryPlan, writingModel: SCIENCE_RECREATION_MODEL } })
  assert.equal(analyses, 3); assert.equal(writings, 3); assert.equal(saved, 1)
  assert.deepEqual(waits, [2000, 4000, 2000, 4000])
  assert.deepEqual(retries.map(({ phase, attempt, nextAttempt, maxAttempts, status }) => ({ phase, attempt, nextAttempt, maxAttempts, status })), [
    { phase: 'analysis', attempt: 1, nextAttempt: 2, maxAttempts: 4, status: 502 },
    { phase: 'analysis', attempt: 2, nextAttempt: 3, maxAttempts: 4, status: 502 },
    { phase: 'writing', attempt: 1, nextAttempt: 2, maxAttempts: 4, status: undefined },
    { phase: 'writing', attempt: 2, nextAttempt: 3, maxAttempts: 4, status: 503 },
  ])
  assert.match(retries[2]!.reason, /ECONNRESET|网络/)
})

test('408, 429 and 5xx retry while Retry-After remains bounded', async () => {
  for (const status of [408, 429, 500, 502, 503, 599]) {
    let calls = 0
    const waits: number[] = [], retries: ScienceModelRetry[] = []
    const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
      signal: new AbortController().signal, onRetry: retry => { retries.push(retry) }, sleep: async ms => { waits.push(ms) },
      call: async () => { if (++calls === 1) throw httpFailure(status, status === 429 ? 120_000 : undefined); return JSON.stringify(retryDraft) },
    })
    assert.equal(result.script, retryDraft.script); assert.equal(calls, 2)
    assert.deepEqual(waits, [status === 429 ? 60_000 : 2000]); assert.equal(retries[0]!.status, status)
  }
})

test('transient network failures retry without confusing programming errors with connectivity', async () => {
  for (const failure of [new TypeError('fetch failed'), Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }),
    new Error('request failed', { cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }) })]) {
    let calls = 0
    await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
      signal: new AbortController().signal, sleep: async () => {},
      call: async () => { if (++calls === 1) throw failure; return JSON.stringify(retryDraft) },
    })
    assert.equal(calls, 2)
  }
  let calls = 0
  const error = new TypeError('Invalid request argument')
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, sleep: async () => assert.fail('A programming error is not retried'),
    call: async () => { calls++; throw error },
  }), candidate => candidate === error)
  assert.equal(calls, 1)
})

test('authentication, configuration and incomplete responses fail immediately instead of retrying', async () => {
  for (const failure of [httpFailure(401), httpFailure(403), httpFailure(400),
    new Error('No active text AI config'), new Error('Text model response did not complete normally; refusing a truncated or incomplete draft')]) {
    let calls = 0
    await assert.rejects(recreateScienceScript(retrySource, {
      signal: new AbortController().signal, onRetry: () => assert.fail('This error must not be retried'), sleep: async () => assert.fail('No retry wait'),
      call: async () => { calls++; throw failure },
    }), error => error === failure)
    assert.equal(calls, 1)
  }
})

test('correctable draft validation failures are saved and revised before source review', async () => {
  for (const [script, feedback] of [
    [retrySource.transcript, /与原稿相同/],
    ['<think>不能提交分析过程</think>', /包含分析标记/],
    ['```text\n冰为什么浮起来？\n```', /Markdown 围栏/],
  ] as const) {
    const rejected = { title: '待修订', script }
    let writes = 0, reviews = 0
    const checkpoints: ScienceWritingCheckpoint[] = []
    const result = await recreateScienceScript({ ...retrySource, plan: retryPlan }, {
      signal: new AbortController().signal, writingModel: 'fixture-qwen',
      call: async () => assert.fail('reuse valid source analysis'),
      onRetry: () => assert.fail('draft repair is not a network retry'),
      onCheckpoint: checkpoint => checkpoints.push(structuredClone(checkpoint)),
      write: async messages => {
        if (++writes === 1) return JSON.stringify(rejected)
        const input = JSON.parse(messages[1]!.content)
        assert.deepEqual(input.previousDraft, rejected)
        assert.match(input.revisionInstruction, feedback)
        return JSON.stringify(retryDraft)
      },
      review: async messages => {
        reviews++
        assert.equal(JSON.parse(messages[1]!.content).draft.script, retryDraft.script)
        return JSON.stringify({ issues: [] })
      },
    })
    assert.equal(writes, 2); assert.equal(reviews, 1)
    assert.equal(result.script, retryDraft.script)
    const saved = checkpoints.find(checkpoint => checkpoint.reviewed && checkpoint.round === 1)
    assert.ok(saved)
    assert.deepEqual(saved.draft, rejected)
    assert.match(saved.feedback, feedback)
  }
})

test('invalid JSON and invalid plans never trigger network retries', async () => {
  for (const [plan, response] of [
    [undefined, '502 gateway response'], [undefined, JSON.stringify({ sourceSummary: 'missing required plan fields' })],
    [retryPlan, '{"title":'], [retryPlan, JSON.stringify({ title: '没有正文' })],
  ] as const) {
    let calls = 0
    await assert.rejects(recreateScienceScript({ ...retrySource, plan }, {
      signal: new AbortController().signal, onRetry: () => assert.fail('Validation failures are not transient network failures'),
      call: async () => { calls++; return response },
    }))
    assert.equal(calls, 1)
  }
})

test('exhausted writing retries expose a temporary error and preserve the validated plan for recovery', async () => {
  let analyses = 0, writings = 0, saved: SciencePlan | undefined
  const retries: ScienceModelRetry[] = [], waits: number[] = []
  await assert.rejects(recreateScienceScript(retrySource, {
    signal: new AbortController().signal, onPlan: plan => { saved = plan }, onRetry: retry => { retries.push(retry) }, sleep: async ms => { waits.push(ms) },
    call: async (_messages, options) => {
      if (isPlanning(options)) { analyses++; return JSON.stringify(planningFixture()) }
      writings++; throw httpFailure(502)
    },
  }), { name: 'ScienceModelRetryExhaustedError', code: 'science_model_retry_exhausted', retryable: true, phase: 'writing', attempts: 4, status: 502 })
  assert.equal(analyses, 1); assert.equal(writings, 4); assert.deepEqual(waits, [2000, 4000, 8000]); assert.equal(retries.length, 3)
  assert.deepEqual(saved, retryPlan)
  const result = await recreateScienceScript({ ...retrySource, plan: saved }, {
    signal: new AbortController().signal,
    call: async (_messages, options) => { assert.equal(isPlanning(options), false); writings++; return JSON.stringify(retryDraft) },
  })
  assert.equal(result.script, retryDraft.script); assert.equal(analyses, 1); assert.equal(writings, 5)
})

test('retry notifications and exhausted errors omit upstream bodies even for legacy HTTP errors', async () => {
  const reasons: string[] = []
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: new AbortController().signal, sleep: async () => {}, onRetry: retry => { reasons.push(retry.reason) },
    call: async () => { throw new Error('Text model request failed: 502 https://upstream.invalid/?token=fixture-secret private response body') },
  }), error => {
    const failure = error as Error & { status: number; retryable: boolean }
    assert.equal(failure.status, 502); assert.equal(failure.retryable, true)
    assert.match(failure.message, /502/); assert.doesNotMatch(failure.message, /https|token|fixture-secret|private response/)
    return true
  })
  assert.equal(reasons.length, 3)
  for (const reason of reasons) { assert.match(reason, /502/); assert.doesNotMatch(reason, /https|token|fixture-secret|private response/) }
})

test('cancelled recreation never begins a model request', async () => {
  const controller = new AbortController(), reason = new Error('user stopped recreation')
  controller.abort(reason)
  let calls = 0
  await assert.rejects(recreateScienceScript(retrySource, {
    signal: controller.signal, call: async () => { calls++; return JSON.stringify(planningFixture()) },
  }), error => error === reason)
  assert.equal(calls, 0)
})

test('cancelling a real retry wait stops immediately without another model request or exhaustion error', { timeout: 1000 }, async () => {
  const controller = new AbortController(), reason = new Error('user stopped retry')
  let calls = 0, retries = 0
  await assert.rejects(recreateScienceScript({ ...retrySource, plan: retryPlan }, {
    signal: controller.signal, onRetry: () => { retries++; setTimeout(() => controller.abort(reason), 10) },
    call: async () => { calls++; throw httpFailure(502) },
  }), error => error === reason)
  assert.equal(calls, 1); assert.equal(retries, 1)
})

test('science uses the general analysis transport and remote structured writer while preserving the original title', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-tool-http-'))
  const priorDb = process.env.DB_PATH
  const priorWriterUrl = process.env.SCIENCE_WRITER_API_URL, priorWriterModel = process.env.SCIENCE_WRITER_MODEL
  process.env.DB_PATH = path.join(root, 'test.db')
  process.env.SCIENCE_WRITER_API_URL = 'http://127.0.0.1:8788/v1'
  process.env.SCIENCE_WRITER_MODEL = 'remote-writer-fixture'
  const { db, schema } = await import('../db/index.js')
  t.after(() => {
    db.$client.close(); fs.rmSync(root, { recursive: true, force: true })
    if (priorDb === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = priorDb
    if (priorWriterUrl === undefined) delete process.env.SCIENCE_WRITER_API_URL; else process.env.SCIENCE_WRITER_API_URL = priorWriterUrl
    if (priorWriterModel === undefined) delete process.env.SCIENCE_WRITER_MODEL; else process.env.SCIENCE_WRITER_MODEL = priorWriterModel
  })
  db.insert(schema.aiServiceConfigs).values({ name: 'science tool fixture', serviceType: 'text', provider: 'openai',
    baseUrl: 'https://science.fixture.invalid', apiKey: 'fixture-only', model: JSON.stringify(['fixture-model']),
    isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
  const bodies: any[] = []
  const assertStrictSchema = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false)
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort())
    }
    for (const value of Object.values(node)) assertStrictSchema(value)
  }
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (String(url) === 'http://127.0.0.1:8788/health') return Response.json({status: 'ok'})
    const body = JSON.parse(String(init.body)); bodies.push(body)
    const name = bodies.length === 1 ? SCIENCE_PLAN_TOOL_NAME : 'review_science_script'
    if (bodies.length === 1) {
      assert.equal(body.model, 'gpt-6.1-terra')
      assert.deepEqual(body.tool_choice, { type: 'function', function: { name } })
      assert.equal(body.tools.length, 1); assert.equal(body.tools[0].function.name, name)
      assert.equal(body.tools[0].function.strict, true); assertStrictSchema(body.tools[0].function.parameters)
      assert.equal(body.parallel_tool_calls, false); assert.equal(body.response_format, undefined)
      assert.equal(body.tools[0].function.parameters.properties.angle.type, 'string')
      assert.equal(body.tools[0].function.parameters.properties.facts.items.type, 'string')
      assert.ok(body.tools[0].function.parameters.required.includes('writingOutline'))
      assert.equal(body.tools[0].function.parameters.properties.outline, undefined)
    } else if (bodies.length === 2) {
      assert.equal(String(url), 'http://127.0.0.1:8788/v1/chat/completions')
      assert.equal(body.model, 'remote-writer-fixture')
      assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined)
      assert.equal(body.response_format.type, 'json_schema')
      assertStrictSchema(body.response_format.json_schema.schema)
      assert.ok(body.messages[1].content.includes(`原标题：${retrySource.title}`))
      assert.ok(body.messages[1].content.includes('Ice floats.'))
      assert.equal(body.messages.length, 2, 'the remote model receives one readable user request')
      assert.equal(body.messages.filter((item: any) => item.role === 'system').length, 1)
      assert.match(body.messages[0].content, /原标题只作通俗转述/)
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(retryDraft) } }] })
    } else {
      assert.equal(body.model, SCIENCE_RECREATION_MODEL)
      assert.equal(body.tools[0].function.name, 'review_science_script')
      assert.equal(body.tools[0].function.strict, true)
      assertStrictSchema(body.tools[0].function.parameters)
    }
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
      tool_calls: [{ id: `call_${bodies.length}`, type: 'function', function: { name,
        arguments: JSON.stringify(bodies.length === 1 ? planningFixture() : { issues: [] }) } }] } }] })
  })
  const result = await recreateScienceScript(retrySource, { signal: new AbortController().signal })
  assert.equal(bodies.length, 3); assert.deepEqual(result, { ...retryDraft, plan: { ...retryPlan, writingModel: 'remote-writer-fixture' } })
})
