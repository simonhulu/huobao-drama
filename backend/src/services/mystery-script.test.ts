import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MYSTERY_ANALYSIS_TOOL, MYSTERY_PATCH_TOOL, MYSTERY_REVIEW_TOOL, MYSTERY_NARRATOR, MYSTERY_TRANSLATION_TOOL, MYSTERY_TRANSLATION_REVIEW_TOOL,
  analyzeMysterySource, applyMysteryPatches, createMysteryRevision, hashMysteryText, mysterySourceUnits,
  reviewMysteryRevision, validateMysteryAnalysis, needsMysteryTranslation, translateMysterySource, type MysteryAnalysis, type MysteryPatch,
} from './mystery-script.js'

const signal = () => new AbortController().signal
const pass = () => ({ checks: { meaning: true, completeness: true, flow: true, experience: true, identity: true }, issues: [] })

function analysis(source: string, identitySpans: MysteryAnalysis['identitySpans'] = []): MysteryAnalysis {
  return {
    sourceHash: hashMysteryText(source), theme: '人们如何面对一个没有答案的问题', purpose: '沿调查过程让观众体会疑惑和等待',
    audienceNeeds: ['想解开疑问', '对当事人等待的共情'], endingPayoff: '仍不知道答案，保留悬念的余味', stance: '保留未知，不妄下结论',
    evidence: [{ id: 'e1', start: 0, end: source.length, quote: source, note: '原稿由疑问走向仍然未知；目的为依据原文的推断' }],
    beats: [{ id: 'b1', start: 0, end: source.length, purpose: '从发现到调查再到未解', emotion: '细节触发好奇，等待形成悬念', method: '先设问再给出调查动作', reveal: '结尾仍未知' }],
    identitySpans, dossier: { people: [], timeline: [], claims: [], uncertainties: ['原稿并未给出答案'] },
  }
}

function patch(source: string, original: string, replacement: string, extra: Partial<MysteryPatch> = {}): MysteryPatch {
  const start = source.indexOf(original)
  assert.notEqual(start, -1)
  return { id: 'p1', start, end: start + original.length, original, replacement, reason: '必要的等义调整', kind: 'wording', ...extra }
}

function modelAnalysis(source: string) {
  const units = mysterySourceUnits(source)
  const fixture = analysis(source)
  return {
    theme: fixture.theme, purpose: fixture.purpose, audienceNeeds: fixture.audienceNeeds, endingPayoff: fixture.endingPayoff, stance: fixture.stance,
    evidence: [{ id: 'e1', unitId: units[0]!.id, quote: units[0]!.text, note: '主题依据开头的疑问及结尾的未知，目的为推断' }],
    beats: units.filter(unit => unit.text.trim()).map((unit, index) => ({ id: `b${index + 1}`, fromUnitId: unit.id, toUnitId: unit.id,
      purpose: '保持当前位置的推进', emotion: '原文细节引发好奇', method: '场景与设问', reveal: '只透露当前位置的信息' })),
    identitySpans: [], dossier: fixture.dossier,
  }
}

test('patches preserve every unedited character, source whitespace, repetition and order', () => {
  const source = '  门为什么开着？\r\n他先看了门锁。又看了一遍。🕯️一直没有熄灭。\n\n直到今天，我们也不知道答案。  '
  const p = patch(source, '又看了一遍', '又仔细看了一遍')
  const result = applyMysteryPatches(source, [p], analysis(source))
  assert.equal(result, source.slice(0, p.start) + p.replacement + source.slice(p.end))
  assert.equal(applyMysteryPatches(source, [], analysis(source)), source)
  assert.ok(result.includes('先看了门锁。又仔细看了一遍'))
  assert.equal(mysterySourceUnits(source).map(unit => unit.text).join(''), source)
})

test('wrong source versions, mismatching literals, overlaps and whole-article replacements are rejected', () => {
  const source = '那天门开着。可是门锁没有坏。最后仍然没有答案。'
  const base = analysis(source), p = patch(source, '门开着', '门敞开着')
  assert.throws(() => applyMysteryPatches(source + '后续', [p], base), /原稿已更新/)
  assert.throws(() => applyMysteryPatches(source, [{ ...p, original: '门关着' }], base), /不匹配/)
  assert.throws(() => applyMysteryPatches(source, [p, { ...p, id: 'p2' }], base), /重叠/)
  assert.throws(() => applyMysteryPatches(source, [patch(source, source, '门开着，案件未解。')], base), /整篇替换/)
  assert.throws(() => applyMysteryPatches(source, [patch(source, '门开着。可是门锁', '门与门锁')], base), /跨句/)
  assert.throws(() => applyMysteryPatches(source, [patch(source, '门开着', '')], base), /不能删除正文/)
})

test('identity cleanup cannot delete the intertwined opening mystery or factual attribution', () => {
  const source = '我是小陈，为什么这扇门突然打开？我去年去过现场，门锁还在。请订阅本频道。可直到今天，答案仍未知。'
  const self = patch(source, '我是小陈，', '', { kind: 'identity' })
  const promo = patch(source, '请订阅本频道。', '', { id: 'p2', kind: 'promotion' })
  const attribution = patch(source, '我去年去过现场', '原叙述者去年去过现场', { id: 'p3', kind: 'attribution' })
  const base = analysis(source, [self, promo, attribution].map(p => ({ start: p.start, end: p.end, text: p.original,
    kind: p.kind as 'identity' | 'promotion' | 'attribution', reason: '只处理作者信息，保留故事' })))
  assert.equal(applyMysteryPatches(source, [self, promo, attribution], base), '为什么这扇门突然打开？原叙述者去年去过现场，门锁还在。可直到今天，答案仍未知。')
  assert.throws(() => applyMysteryPatches(source, [patch(source, '我是小陈，为什么这扇门突然打开？', '', { kind: 'identity' })], base), /超出已标记/)
  assert.throws(() => applyMysteryPatches(source, [{ ...attribution, replacement: '' }], base), /亲历归属不能删除/)
  assert.throws(() => applyMysteryPatches(source, [{ ...self, replacement: '大家好，', kind: 'wording' }], base), /对应的身份处理/)
})

test('analysis must cover every narrative passage and cite actual source evidence', () => {
  const source = '门开了。调查员先去查看门锁。然后他找到了目击者。案件至今未解。'
  const base = analysis(source)
  assert.throws(() => validateMysteryAnalysis(source, { ...base, beats: [{ ...base.beats[0]!, end: 5 }] }), /遗漏了结尾/)
  assert.throws(() => validateMysteryAnalysis(source, { ...base, beats: [{ ...base.beats[0]!, start: 5 }] }), /遗漏正文/)
  assert.throws(() => validateMysteryAnalysis(source, { ...base, evidence: [{ ...base.evidence[0]!, quote: '编造的摘录' }] }), /不匹配/)
  assert.throws(() => validateMysteryAnalysis(source, { ...base, dossier: { ...base.dossier, people: [{ name: '调查员', aliases: [], role: '调查', evidenceIds: ['missing'] }] } }), /不存在的原文依据/)
})

test('all three kinds of story are analyzed from complete text without narrative templates', async () => {
  for (const source of [
    '是谁打开了那扇门？调查员先看门锁，又绕到窗边。可是到今天仍不知道答案。',
    '灯为什么会自己亮起来？邻居守了一夜，什么也没看见。至今依然有人等待解答。',
    '她为什么每天寄出一封信？二十年后，邮递员终于说出了缘由。原来她一直在等一个人。',
  ]) {
    const result = await analyzeMysterySource({ source, narrator: '平实讲给 40 岁以上的人听' }, { signal: signal(), callModel: async (messages, options) => {
      assert.equal(options?.toolChoice && typeof options.toolChoice === 'object' && options.toolChoice.function.name, MYSTERY_ANALYSIS_TOOL)
      const payload = JSON.parse(messages[1]!.content)
      assert.equal(payload.sourceUnits.map((unit: any) => unit.text).join(''), source)
      assert.equal(options?.requireComplete, true)
      return JSON.stringify(modelAnalysis(source))
    } })
    assert.equal(result.sourceHash, hashMysteryText(source))
    assert.equal(result.beats[0]!.start, 0)
    assert.equal(result.beats.at(-1)!.end, source.length)
    assert.ok(result.purpose && result.audienceNeeds.length && result.endingPayoff)
  }
})

test('invented or ambiguous model quotes are never silently matched elsewhere', async () => {
  const source = '他说门开了，又说门开了。她仍然不知道答案。'
  const response = modelAnalysis(source)
  response.evidence[0]!.quote = '门开了'
  await assert.rejects(analyzeMysterySource({ source }, { signal: signal(), callModel: async () => JSON.stringify(response) }), /定位不唯一/)
  response.evidence[0]!.quote = '门从来没有开过'
  await assert.rejects(analyzeMysterySource({ source }, { signal: signal(), callModel: async () => JSON.stringify(response) }), /摘录不在原句/)
})

test('zero edits are a valid complete narration and still receive a full review', async () => {
  const source = '门为什么开着？他看了门锁，又绕到窗边。直到今天，答案仍然未知。'
  const calls: string[] = []
  const result = await createMysteryRevision({ source, analysis: analysis(source) }, { signal: signal(), callModel: async (messages, options) => {
    const name = typeof options?.toolChoice === 'object' ? options.toolChoice.function.name : ''
    calls.push(name)
    if (name === MYSTERY_PATCH_TOOL) return JSON.stringify({ patches: [] })
    const input = JSON.parse(messages[1]!.content)
    assert.equal(input.source, source); assert.equal(input.text, source)
    return JSON.stringify(pass())
  } })
  assert.deepEqual(calls, [MYSTERY_PATCH_TOOL, MYSTERY_REVIEW_TOOL])
  assert.equal(result.text, source); assert.deepEqual(result.patches, []); assert.equal(result.review.passed, true)
  assert.equal(result.review.narratorHash, hashMysteryText(JSON.stringify(MYSTERY_NARRATOR)))
  assert.equal(result.review.textHash, hashMysteryText(source))
})

test('a possible-to-certain change is restored even if the model review mistakenly passes it', async () => {
  const source = '那人可能在门后。他们等了很久，门仍然没有打开。'
  const reviewed: string[] = []
  const result = await createMysteryRevision({ source, analysis: analysis(source) }, { signal: signal(), callModel: async (messages, options) => {
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_PATCH_TOOL)
      return JSON.stringify({ patches: [{ unitId: 's1', original: '可能', replacement: '肯定', reason: '说得更有力', kind: 'wording' }] })
    reviewed.push(JSON.parse(messages[1]!.content).text)
    return JSON.stringify(pass())
  } })
  assert.equal(reviewed.length, 2)
  assert.match(reviewed[0]!, /肯定/)
  assert.equal(reviewed[1], source)
  assert.equal(result.text, source); assert.deepEqual(result.patches, []); assert.equal(result.review.passed, true)
})

test('semantic compression flagged by review restores the original process, retaining independent safe edits', async () => {
  const source = '他先走到门边，摸了摸锁孔，然后蹲下来查看地上的泥。夜已经很深了。答案还是未知。'
  let reviews = 0
  const result = await createMysteryRevision({ source, analysis: analysis(source) }, { signal: signal(), callModel: async (_messages, options) => {
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_PATCH_TOOL)
      return JSON.stringify({ patches: [
        { unitId: 's1', original: '先走到门边，摸了摸锁孔，然后蹲下来查看地上的泥', replacement: '检查了现场', reason: '精炼', kind: 'wording' },
        { unitId: 's2', original: '夜已经很深了', replacement: '已经是深夜了', reason: '等义语序', kind: 'wording' },
      ] })
    reviews++
    return JSON.stringify(reviews === 1 ? { checks: { ...pass().checks, completeness: false }, issues: [{ patchId: 'p1', kind: 'completeness', message: '走到门边、摸锁孔、蹲下看泥的动作过程消失，恢复原句' }] } : pass())
  } })
  assert.equal(reviews, 2)
  assert.equal(result.text, source.replace('夜已经很深了', '已经是深夜了'))
  assert.equal(result.patches.length, 1); assert.equal(result.patches[0]!.id, 'p2'); assert.equal(result.review.passed, true)
})

test('a global change in purpose or stiff joins restores all optional changes and rechecks the full text', async () => {
  const source = '门开着，他却不敢走进去。他就在外面等到了天亮。'
  let reviews = 0
  const result = await createMysteryRevision({ source, analysis: analysis(source) }, { signal: signal(), callModel: async (_messages, options) => {
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_PATCH_TOOL)
      return JSON.stringify({ patches: [{ unitId: 's1', original: '却不敢', replacement: '决定不', reason: '调整口语', kind: 'wording' }] })
    reviews++
    return JSON.stringify(reviews === 1 ? { checks: { ...pass().checks, experience: false }, issues: [{ patchId: null, kind: 'experience', message: '恐惧被改成主动选择，后文的等待不再积累危险感' }] } : pass())
  } })
  assert.equal(result.text, source); assert.equal(reviews, 2); assert.equal(result.review.passed, true)
})

test('unresolved required identity or attribution handling blocks production rather than silently retaining a good score', async () => {
  const source = '我是小陈。门为什么开着？案件仍未解。'
  const base = analysis(source, [{ start: 0, end: 5, text: '我是小陈。', kind: 'identity', reason: '频道自我介绍' }])
  const result = await createMysteryRevision({ source, analysis: base }, { signal: signal(), callModel: async (_messages, options) => {
    return JSON.stringify(typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_PATCH_TOOL ? { patches: [] } : pass())
  } })
  assert.equal(result.text, source); assert.equal(result.review.passed, false)
  assert.equal(result.review.checks.identity, false); assert.match(result.review.issues[0]!.message, /尚未完整处理/)
})

test('failed attribution changes stay visible and blocked; the engine cannot quietly convert them into narrator experience', async () => {
  const source = '我去年去过现场，门锁还在。门为什么会开仍然未知。'
  const span = { start: 0, end: 7, text: '我去年去过现场', kind: 'attribution' as const, reason: '原作者亲历' }
  const result = await createMysteryRevision({ source, analysis: analysis(source, [span]) }, { signal: signal(), callModel: async (_messages, options) => {
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_PATCH_TOOL)
      return JSON.stringify({ patches: [{ unitId: 's1', original: '我', replacement: '我们', reason: '改称呼', kind: 'attribution' }] })
    return JSON.stringify({ checks: { ...pass().checks, identity: false }, issues: [{ patchId: 'p1', kind: 'identity', message: '仍然冒认原作者亲历，须归给来源讲述者' }] })
  } })
  assert.equal(result.review.passed, false); assert.equal(result.patches[0]!.kind, 'attribution')
  assert.equal(result.review.issues[0]!.patchId, 'p1')
})

test('long narration chunks keep full paragraphs, adjacent context, original order and complete final review', async () => {
  const source = '门口发生了什么？\n' + Array.from({ length: 420 }, (_, i) => `第${i + 1}次查看时，他先摸门锁，然后站在窗边等了一会儿。`).join('') + '\n直到最后，所有人仍然不知道那个人去了哪里。'
  const base = analysis(source), editedIds: string[] = [], contexts: string[] = []
  let reviewCount = 0
  const result = await createMysteryRevision({ source, analysis: base }, { signal: signal(), callModel: async (messages, options) => {
    const payload = JSON.parse(messages[1]!.content)
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_PATCH_TOOL) {
      editedIds.push(...payload.editableUnitIds)
      contexts.push(payload.sourceUnits.map((unit: any) => unit.text).join(''))
      return JSON.stringify({ patches: [] })
    }
    reviewCount++
    assert.equal(payload.source, source); assert.equal(payload.text, source)
    assert.ok(payload.text.includes('第420次'))
    assert.ok(payload.text.endsWith('直到最后，所有人仍然不知道那个人去了哪里。'))
    return JSON.stringify(pass())
  } })
  assert.ok(contexts.length > 1)
  assert.deepEqual(editedIds, mysterySourceUnits(source).map(unit => unit.id))
  assert.equal(new Set(editedIds).size, editedIds.length)
  assert.ok(contexts.every(context => context.includes('第1次') && context.includes('第420次')), '完整长段落作为上下文，不以分块为由截去前后句')
  assert.equal(result.text, source); assert.equal(reviewCount, 1)
})

test('review binds to exact original, edited text, analysis and narrator; numeric changes cannot bypass checks', async () => {
  const source = '他等了三天。门上有12道划痕，但还不能证明什么。'
  const base = analysis(source), p = patch(source, '12', '21')
  const result = await reviewMysteryRevision({ source, analysis: base, patches: [p], narrator: { name: '讲述者', audience: '40+' } }, {
    signal: signal(), callModel: async () => JSON.stringify(pass()),
  })
  assert.equal(result.passed, false)
  assert.match(result.issues[0]!.message, /数字/)
  assert.equal(result.sourceHash, hashMysteryText(source))
  assert.equal(result.textHash, hashMysteryText(source.replace('12', '21')))
  assert.equal(result.analysisHash, hashMysteryText(JSON.stringify(base)))
  assert.equal(result.narratorHash, hashMysteryText(JSON.stringify({ name: '讲述者', audience: '40+' })))
})

test('malformed review and unknown patch references fail closed, and cancellation avoids model work', async () => {
  const source = '门为什么开着？直到今天仍然没有答案。', base = analysis(source)
  await assert.rejects(reviewMysteryRevision({ source, analysis: base, patches: [] }, { signal: signal(), callModel: async () => '{' }), /完整的结构化结果/)
  await assert.rejects(reviewMysteryRevision({ source, analysis: base, patches: [] }, { signal: signal(), callModel: async () => JSON.stringify({ ...pass(), issues: [{ patchId: 'missing', kind: 'meaning', message: '不确定' }] }) }), /不存在的修改/)
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(createMysteryRevision({ source, analysis: base }, { signal: controller.signal, callModel: async () => { calls++; return '{}' } }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('foreign narration requires a separate Chinese translation; embedded foreign names do not replace Chinese originals', async () => {
  for (const source of ['The door was open. Nobody knew why.', 'その夜、彼は扉の前でずっと待っていた。', '그는 문이 열릴 때까지 기다렸다.']) {
    assert.equal(needsMysteryTranslation(source), true)
    let calls = 0
    await assert.rejects(analyzeMysterySource({ source }, { signal: signal(), callModel: async () => { calls++; return '{}' } }), /逐句保义中文翻译/)
    assert.equal(calls, 0)
  }
  const source = 'John 站在门口。他后来跟警员说，直到天亮也没见门打开。'
  assert.equal(needsMysteryTranslation(source), false)
  let calls = 0
  const translation = await translateMysterySource({ source }, { signal: signal(), callModel: async () => { calls++; return '{}' } })
  assert.equal(translation.text, source); assert.equal(calls, 0)
})

test('translation preserves original transcript, sentence mappings and paragraph breaks before any identity cleanup', async () => {
  const source = 'My name is Alex. Why was the door open?\n\nI visited the house last year. Nobody has found the answer yet.\n'
  const units = mysterySourceUnits(source)
  const dictionary: Record<string,string> = {
    'My name is Alex.': '我叫亚历克斯。', 'Why was the door open?': '门为什么开着？',
    'I visited the house last year.': '我去年去过那栋房子。', 'Nobody has found the answer yet.': '至今还没有人找到答案。',
  }
  const calls: string[] = []
  const translated = await translateMysterySource({ source }, { signal: signal(), callModel: async (messages, options) => {
    const name = typeof options?.toolChoice === 'object' ? options.toolChoice.function.name : ''
    calls.push(name)
    const payload = JSON.parse(messages[1]!.content)
    if (name === MYSTERY_TRANSLATION_TOOL) return JSON.stringify({ segments: payload.editableUnitIds.map((id:string) => {
      const unit = units.find(unit => unit.id === id)!
      return { unitId: id, text: dictionary[unit.text.trim()] }
    }) })
    assert.equal(payload.source, source)
    assert.ok(payload.text.includes('我叫亚历克斯。'))
    assert.ok(payload.text.includes('我去年去过那栋房子。'))
    return JSON.stringify({ checks: { meaning: true, completeness: true, order: true, attribution: true }, issues: [] })
  } })
  assert.deepEqual(calls, [MYSTERY_TRANSLATION_TOOL, MYSTERY_TRANSLATION_REVIEW_TOOL])
  assert.equal(translated.sourceHash, hashMysteryText(source))
  assert.equal(translated.textHash, hashMysteryText(translated.text))
  assert.equal(translated.segments.map(segment => segment.sourceText).join(''), source)
  assert.equal(translated.segments.map(segment => segment.text).join(''), translated.text)
  for (const segment of translated.segments) {
    assert.equal(source.slice(segment.sourceStart, segment.sourceEnd), segment.sourceText)
    assert.equal(translated.text.slice(segment.textStart, segment.textEnd), segment.text)
  }
  assert.ok(translated.text.includes('门为什么开着？\n\n我去年'))
  assert.equal(translated.review.passed, true)
})

test('translation cannot omit a sentence or use a summary, and failed meaning checks remain blocked', async () => {
  const source = 'He touched the lock. Then he knelt down and inspected the mud.'
  const units = mysterySourceUnits(source)
  await assert.rejects(translateMysterySource({ source }, { signal: signal(), callModel: async () => JSON.stringify({ segments: [{ unitId: units[0]!.id, text: '他检查了现场。' }] }) }), /缺失或重复/)
  const translated = await translateMysterySource({ source }, { signal: signal(), callModel: async (_messages, options) => {
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_TRANSLATION_TOOL)
      return JSON.stringify({ segments: [{ unitId: units[0]!.id, text: '他检查了锁。' }, { unitId: units[1]!.id, text: '后来发现了泥。' }] })
    return JSON.stringify({ checks: { meaning: false, completeness: false, order: true, attribution: true }, issues: [{ unitId: units[1]!.id, message: '蹲下并检查泥土的动作被浓缩成发现泥土，不能作中文底稿' }] })
  } })
  assert.equal(translated.review.passed, false)
  assert.match(translated.review.issues[0]!.message, /浓缩/)
  assert.equal(translated.segments.map(segment => segment.sourceText).join(''), source)
})
