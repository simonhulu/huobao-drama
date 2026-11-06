import test from 'node:test'
import assert from 'node:assert/strict'
import { generateMysteryPublishingCopy, MYSTERY_COPY_TOOL, MYSTERY_COPY_REVIEW_TOOL } from './mystery-publishing-copy.js'
import { hashMysteryText, mysterySourceUnits, type MysteryAnalysis } from './mystery-script.js'

const source = '门为什么会自己打开？那天他先看了门锁，然后又绕到窗边。直到今天，答案仍然未知。'
const analysis: MysteryAnalysis = {
  sourceHash: hashMysteryText(source), theme: '面对没有答案的疑问', purpose: '随调查感受悬念', audienceNeeds: ['解谜期待'], endingPayoff: '仍保留未知', stance: '不妄下结论',
  evidence: [{ id: 'e1', start: 0, end: source.length, quote: source, note: '有疑问和未知结尾' }],
  beats: [{ id: 'b1', start: 0, end: source.length, purpose: '逐步调查', emotion: '细节积累疑惑', method: '设问、动作与等待', reveal: '结尾未解' }], identitySpans: [],
  dossier: { people: [], timeline: [], claims: [], uncertainties: ['门打开的原因未知'] },
}
function copy() {
  return {
    titleCandidates: [{ text: '那扇门为什么会自己打开', evidenceIds: ['e1'] }, { text: '一扇自己打开的门，留下什么疑问', evidenceIds: ['e1'] }], selectedTitleIndex: 0,
    description: { text: '从门锁到窗边，跟着当时的查看过程，看看这扇门留下的疑问。', evidenceIds: ['e1', 'e2'] },
    tags: [{ text: '未解之谜', evidenceIds: ['e3'] }], evidence: [
      { id: 'e1', unitId: 's1', quote: '门为什么会自己打开？', note: '原稿开场提出此疑问' },
      { id: 'e2', unitId: 's2', quote: '他先看了门锁，然后又绕到窗边', note: '调查过程对应简介' },
      { id: 'e3', unitId: 's3', quote: '答案仍然未知', note: '未知结局支持未解标签' },
    ],
  }
}
const pass = () => ({ supported: true, preservesPurpose: true, preservesSuspense: true, issues: [] })
const signal = () => new AbortController().signal

test('publishing copy is based on the full immutable script and returns verified source locations', async () => {
  const calls: string[] = [], immutable = source
  const result = await generateMysteryPublishingCopy({ sourceTitle: '门的故事', script: source, analysis }, { signal: signal(), callModel: async (messages, options) => {
    const name = typeof options?.toolChoice === 'object' ? options.toolChoice.function.name : ''
    calls.push(name)
    const payload = JSON.parse(messages[1]!.content)
    assert.equal(payload.fullScriptUnits.map((unit: any) => unit.text).join(''), source)
    assert.deepEqual(payload.analysis, analysis)
    assert.equal(options?.requireComplete, true)
    return JSON.stringify(name === MYSTERY_COPY_TOOL ? copy() : pass())
  } })
  assert.deepEqual(calls, [MYSTERY_COPY_TOOL, MYSTERY_COPY_REVIEW_TOOL])
  assert.equal(result.title, result.titleCandidates[0]); assert.ok(result.title.length <= 50)
  assert.equal(result.scriptHash, hashMysteryText(source)); assert.equal(source, immutable)
  assert.deepEqual(result.tags, ['未解之谜'])
  for (const item of result.evidence) assert.equal(source.slice(item.start, item.end), item.quote)
})

test('fabricated quotes, broken references, repeated candidates and unsupported selected titles fail before review', async () => {
  for (const [mutate, expected] of [
    [(value: ReturnType<typeof copy>) => { value.evidence[0]!.quote = '凶手已被抓获' }, /引用不在/],
    [(value: ReturnType<typeof copy>) => { value.titleCandidates[0]!.evidenceIds = ['missing'] }, /不存在的原句依据/],
    [(value: ReturnType<typeof copy>) => { value.titleCandidates[1]!.text = value.titleCandidates[0]!.text }, /候选标题重复/],
    [(value: ReturnType<typeof copy>) => { value.selectedTitleIndex = 9 }, /推荐标题不在/],
  ] as const) {
    const value = copy(); mutate(value); let calls = 0
    await assert.rejects(generateMysteryPublishingCopy({ sourceTitle: '', script: source, analysis }, { signal: signal(), callModel: async () => { calls++; return JSON.stringify(value) } }), expected)
    assert.equal(calls, 1)
  }
})

test('real quotes do not excuse invented conclusions; a semantic reviewer triggers one targeted metadata correction', async () => {
  let writes = 0, reviews = 0
  const result = await generateMysteryPublishingCopy({ sourceTitle: '原故事', script: source, analysis }, { signal: signal(), callModel: async (messages, options) => {
    if (typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_COPY_TOOL) {
      writes++
      const value = copy()
      if (writes === 1) value.titleCandidates[0]!.text = '开门凶手终于被查明'
      else {
        const payload = JSON.parse(messages[1]!.content)
        assert.match(payload.feedback.issues[0].message, /未解/)
        assert.equal(payload.fullScriptUnits.map((unit: any) => unit.text).join(''), source)
      }
      return JSON.stringify(value)
    }
    reviews++
    return JSON.stringify(reviews === 1 ? { ...pass(), supported: false, issues: [{ field: 'titleCandidates', index: 0, message: '原稿未解，真实引文没有支持凶手已查明这一结论' }] } : pass())
  } })
  assert.equal(writes, 2); assert.equal(reviews, 2)
  assert.equal(result.title, '那扇门为什么会自己打开')
  assert.equal(result.scriptHash, hashMysteryText(source))
})

test('persistent changes to purpose or premature revelations block publication metadata after the bounded correction', async () => {
  let calls = 0
  await assert.rejects(generateMysteryPublishingCopy({ sourceTitle: '', script: source, analysis }, { signal: signal(), callModel: async (_messages, options) => {
    calls++
    return JSON.stringify(typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_COPY_TOOL ? copy()
      : { ...pass(), preservesPurpose: false, preservesSuspense: false, issues: [{ field: 'description', index: null, message: '简介把原稿的调查过程改成确定结论，且提前揭晓后文信息' }] })
  } }), /发布文案尚未通过.*成片与完整口播已保留/)
  assert.equal(calls, 4)
})

test('the complete ending remains visible when generating metadata for long narration', async () => {
  const long = source + '\n' + '他又等了一个晚上，门始终没开。'.repeat(1200) + '最终也未查明原因。'
  await generateMysteryPublishingCopy({ sourceTitle: '', script: long, analysis }, { signal: signal(), callModel: async (messages, options) => {
    const payload = JSON.parse(messages[1]!.content)
    assert.equal(payload.fullScriptUnits.map((unit: any) => unit.text).join(''), long)
    assert.equal(payload.fullScriptUnits.at(-1).text, mysterySourceUnits(long).at(-1)!.text)
    return JSON.stringify(typeof options?.toolChoice === 'object' && options.toolChoice.function.name === MYSTERY_COPY_TOOL ? copy() : pass())
  } })
})

test('foreign-language or cancelled script preparation cannot call publishing models', async () => {
  let calls = 0
  const callModel = async () => { calls++; return '{}' }
  await assert.rejects(generateMysteryPublishingCopy({ sourceTitle: '', script: 'Nobody knows why the door opened.', analysis }, { signal: signal(), callModel }), /中文完整文稿/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(generateMysteryPublishingCopy({ sourceTitle: '', script: source, analysis }, { signal: controller.signal, callModel }), { name: 'AbortError' })
  assert.equal(calls, 0)
})
