import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoverJsonRequest, CoverPromptEnhanceResult } from './cover-prompt-enhance.js'
import type { CoverCandidate, CoverEditorialPlan } from './cover-editorial-plan.js'
import type { HistoryTitleResearch } from './history-title-research.js'

const root = mkdtempSync(join(tmpdir(), 'cover-prompt-test-'))
process.env.DB_PATH = join(root, 'test.db')
process.env.TASK_WORKER_DISABLED = '1'
const { enhanceCoverPrompt, reviewCoverPrompt } = await import('./cover-prompt-enhance.js')
const { coverEditorialPlanSchema, hasCompleteCoverPlan, hasCompleteCoverReview } = await import('./cover-editorial-plan.js')
const { db } = await import('../db/index.js')
after(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })

const methods = ['具体疑问', '对比', '生活代入', '反常识', '人物处境', '原因追问']
const fixtures = [
  {
    name: '宫廷冬季采购',
    script: '明代万历年间，北京宫廷冬季采购的反季节韭菜，一斤价格相当于普通工人五天工钱。这不是普通菜市的日常菜价。采购对象、季节和用途都会影响这组价格比较的含义。',
    titles: ['明朝宫廷冬天的韭菜有多贵？', '宫廷韭菜与工人工钱怎么比？', '你干几天活，够买一斤宫廷韭菜？', '一斤宫廷韭菜，竟抵五天工钱？', '工人的日薪能买多少宫廷韭菜？', '为何不能用宫廷韭菜代表菜价？', '宫廷买菜，季节有多重要？', '宫廷采购和普通菜市差在哪？', '拿着普通日薪，如何读懂宫廷菜价？', '这份韭菜价格，不能直接照搬？', '采购者是谁，为什么影响价格解读？', '同样是韭菜，为什么要看采购用途？'],
    sub_title: '万历北京宫廷冬季采购，一斤约抵五天工钱', kicker: '万历北京',
    image_prompt: 'Ming palace winter kitchen with a small bundle of chives beside a measured copper coin pile, cinematic, highly detailed, no text, no watermark',
    why_click: '日常蔬菜与多天劳动收入的差距，使观众想理解宫廷冬季采购这个特例。',
    viewer_question: '宫廷冬季一斤韭菜为何要用工人五天的收入来比较？',
    payoff: '说明一斤韭菜约抵五天工钱的采购条件，并解释不能把它当普通菜市价格。',
    visual_concept: '宫廷冬季厨房，一束韭菜与铜钱并置，表现限定条件下的价格比较，上方留白。',
  },
  {
    name: '赤壁战前处境',
    script: '曹操取得荆州后继续南下。孙权与刘备结盟抵抗曹军。曹军中不少士兵不习水战，又受到疾病困扰。赤壁之战中，黄盖诈降，随后实施火攻。兵力优势并没有消除曹军在水战和疾病上的困难。',
    titles: ['曹操兵多，为什么没赢赤壁？', '兵力优势，能抵消水战短板吗？', '带北方士兵打水战，有多难？', '兵多，也可能过不了长江？', '曹操南下时，面对哪些难题？', '孙刘为什么选择结盟抗曹？', '赤壁之前，曹军出了什么问题？', '水战与陆战，优势能照搬吗？', '如果部下不习水战，如何南下？', '疾病怎样影响一支优势军队？', '黄盖怎样让火攻接近曹军？', '为何说赤壁不能只看兵力？'],
    sub_title: '孙刘结盟，曹军不习水战且受疾病困扰', kicker: '赤壁之战',
    image_prompt: 'Han dynasty naval boats on the Yangtze river, a commander studies the fleet under an overcast sky, cinematic, highly detailed, no text, no watermark',
    why_click: '兵多通常被认为容易获胜，曹军的水战和疾病困难让观众追问兵力优势为何失效。',
    viewer_question: '曹军拥有兵力优势，为何仍在赤壁面对难以克服的困难？',
    payoff: '解释孙刘结盟、水战短板、疾病与黄盖火攻共同构成的战场处境。',
    visual_concept: '汉代战船停在江面，指挥者望向舰队，阴天衬托南下处境，上方留白。',
  },
]

function setup(fixture = fixtures[0]!) {
  const candidates: CoverCandidate[] = fixture.titles.map((main_title, index) => ({
    id: `candidate-${index + 1}`, method: methods[index % methods.length]!, main_title,
    sub_title: fixture.sub_title, kicker: fixture.kicker, image_prompt: fixture.image_prompt,
    enhanced_prompt: fixture.visual_concept, accent_color: '#D7A649', rationale: fixture.why_click,
    why_click: fixture.why_click, viewer_question: fixture.viewer_question, payoff: fixture.payoff,
    evidence: [fixture.script], visual_concept: fixture.visual_concept,
  }))
  const reviews: CoverEditorialPlan['reviews'] = candidates.map(candidate => ({
    candidate_id: candidate.id, natural: true, understandable: true, curiosity: true,
    faithful: true, visual_faithful: true, coherent: true,
    reason: '表达完整，问题具体，正文提供了对应解释，画面保留时代与条件。',
  }))
  return {
    input: { roughPrompt: '根据正文设计封面', episodeContent: fixture.script, editorialReview: true },
    batch: { candidates },
    audit: { selected_id: candidates[0]!.id as string | null, selection_reason: '第一个问题最易于陌生观众理解，正文能够兑现。', reviews },
  }
}

function responses(...values: unknown[]) {
  const calls: Parameters<CoverJsonRequest>[0][] = []
  const request: CoverJsonRequest = async messages => {
    calls.push(structuredClone(messages))
    assert.ok(calls.length <= values.length, 'unexpected extra model request')
    return structuredClone(values[calls.length - 1])
  }
  return { calls, request }
}

for (const fixture of fixtures) {
  test(`${fixture.name}: returns the full selected plan, every candidate and concrete rejection reasons`, async () => {
    const { input, batch, audit } = setup(fixture)
    audit.reviews[1] = { ...audit.reviews[1]!, curiosity: false, reason: '比较对象明确，但这个候选没有提出足够具体的知识缺口。' }
    const stub = responses(batch, audit)
    const result = await enhanceCoverPrompt(input, stub.request)
    assert.equal(stub.calls.length, 2)
    assert.deepEqual(result.editorial_plan, { version: 'history-cover-plan-v1', ...batch, ...audit })
    assert.equal(result.main_title, batch.candidates[0]!.main_title)
    const selected = result.editorial_plan!.candidates.find(candidate => candidate.id === result.editorial_plan!.selected_id)!
    for (const field of ['why_click', 'viewer_question', 'payoff', 'evidence', 'visual_concept'] as const) {
      assert.deepEqual(selected[field], batch.candidates[0]![field])
    }
    assert.equal(JSON.parse(stub.calls[0]![1]!.content).script, fixture.script)
    assert.deepEqual(JSON.parse(stub.calls[1]![1]!.content), { script: fixture.script, candidates: batch.candidates })
    assert.match(stub.calls[1]![0]!.content, /独立审稿人/)
  })
}

test('ambiguous five-day chives title is rejected and the whole next batch uses review feedback', async () => {
  const { input, batch, audit } = setup()
  const bad = structuredClone(batch)
  bad.candidates[0]!.main_title = '五天才买韭菜'
  const reason = '五天是等待时间还是工钱不明，缺少一斤的计量单位。'
  const rejected = { ...audit, reviews: audit.reviews.map(review => ({ ...review, understandable: false, reason })) }
  const stub = responses(bad, rejected, batch, audit)
  const result = await enhanceCoverPrompt(input, stub.request)
  assert.equal(result.main_title, batch.candidates[0]!.main_title)
  assert.equal(stub.calls.length, 4)
  assert.ok(stub.calls[2]!.at(-1)!.content.includes(reason))
  assert.ok(stub.calls[2]!.at(-1)!.content.includes('五天才买韭菜'))
})

for (const [label, mutate] of [
  ['fewer than 12 candidates', (c: CoverCandidate[]) => c.pop()],
  ['fewer than six methods', (c: CoverCandidate[]) => c.forEach(item => { item.method = '具体疑问' })],
  ['duplicate candidate IDs', (c: CoverCandidate[]) => { c[1]!.id = c[0]!.id }],
  ['duplicate titles disguised by punctuation', (c: CoverCandidate[]) => { c[1]!.main_title = c[0]!.main_title.replace('？', '！') }],
  ['fabricated evidence', (c: CoverCandidate[]) => { c[0]!.evidence = ['明朝的每一个老百姓每天都买不起普通韭菜。'] }],
  ['spliced evidence', (c: CoverCandidate[]) => { c[0]!.evidence = ['明代万历年间……一斤价格相当于普通工人五天工钱。'] }],
  ['empty evidence', (c: CoverCandidate[]) => { c[0]!.evidence = [] }],
  ['missing why-click explanation', (c: CoverCandidate[]) => { c[0]!.why_click = '' }],
  ['missing viewer question', (c: CoverCandidate[]) => { c[0]!.viewer_question = '' }],
  ['missing payoff', (c: CoverCandidate[]) => { c[0]!.payoff = '' }],
  ['missing visual concept', (c: CoverCandidate[]) => { c[0]!.visual_concept = '' }],
] satisfies [string, (candidates: CoverCandidate[]) => unknown][]) {
  test(`${label}: rejects the batch before audit and fails after one regeneration`, async () => {
    const { input, batch } = setup()
    mutate(batch.candidates)
    const stub = responses(batch, batch)
    await assert.rejects(enhanceCoverPrompt(input, stub.request), /未通过质量审核/)
    assert.equal(stub.calls.length, 2)
    assert.match(stub.calls[1]!.at(-1)!.content, /未通过/)
  })
}

for (const field of ['natural', 'understandable', 'curiosity', 'faithful', 'visual_faithful', 'coherent'] as const) {
  test(`${field}: selected candidate must pass this dimension even when every other dimension passes`, async () => {
    const { input, batch, audit } = setup(fixtures[1])
    const reason = `候选未满足 ${field}，不得因其他维度通过而入选。`
    audit.reviews[0] = { ...audit.reviews[0]!, [field]: false, reason }
    const stub = responses(batch, audit, batch, audit)
    await assert.rejects(enhanceCoverPrompt(input, stub.request), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /未通过质量审核/)
      assert.ok(error.message.includes(reason))
      return true
    })
    assert.equal(stub.calls.length, 4)
  })
}

for (const [label, mutate] of [
  ['missing candidate review', (audit: ReturnType<typeof setup>['audit']) => audit.reviews.pop()],
  ['duplicate candidate review', (audit: ReturnType<typeof setup>['audit']) => { audit.reviews[1] = { ...audit.reviews[0]! } }],
  ['review for an unknown candidate', (audit: ReturnType<typeof setup>['audit']) => { audit.reviews[1]!.candidate_id = 'invented' }],
  ['selected ID outside the candidate batch', (audit: ReturnType<typeof setup>['audit']) => { audit.selected_id = 'invented' }],
  ['empty audit reason', (audit: ReturnType<typeof setup>['audit']) => { audit.reviews[0]!.reason = '' }],
] satisfies [string, (audit: ReturnType<typeof setup>['audit']) => unknown][]) {
  test(`${label}: cannot be treated as a complete independent review`, async () => {
    const { input, batch, audit } = setup()
    mutate(audit)
    const stub = responses(batch, audit, batch, audit)
    await assert.rejects(enhanceCoverPrompt(input, stub.request), /未通过质量审核/)
    assert.equal(stub.calls.length, 4)
  })
}

test('no passing candidates triggers one fresh batch, then fails without selecting a fallback', async () => {
  const { input, batch, audit } = setup(fixtures[1])
  audit.selected_id = null
  audit.selection_reason = '所有候选均未兑现正文，不能选择。'
  audit.reviews.forEach(review => { review.faithful = false; review.reason = '正文没有支持这个承诺。' })
  const stub = responses(batch, audit, batch, audit)
  await assert.rejects(enhanceCoverPrompt(input, stub.request), /所有候选均未兑现正文/)
  assert.equal(stub.calls.length, 4)
  assert.ok(stub.calls[2]!.at(-1)!.content.includes('正文没有支持这个承诺'))
})

test('string booleans and missing audit dimensions fail closed', async () => {
  for (const malformed of [{ natural: true }, { natural: 'true', understandable: true, curiosity: true, faithful: true, visual_faithful: true, coherent: true }]) {
    const { input, batch, audit } = setup()
    const invalid = { ...audit, reviews: [{ candidate_id: batch.candidates[0]!.id, reason: '通过', ...malformed }, ...audit.reviews.slice(1)] }
    const stub = responses(batch, invalid, batch, invalid)
    await assert.rejects(enhanceCoverPrompt(input, stub.request), /未通过质量审核/)
    assert.equal(stub.calls.length, 4)
  }
})

test('a complete long cover title remains intact when its explicitly requested review approves it', async () => {
  const { input, batch, audit } = setup()
  const invalid = structuredClone(batch)
  const longTitle = '明朝宫廷冬季采购一斤反季节韭菜为什么能抵普通工人整整五天的工钱？'
  invalid.candidates[0]!.main_title = longTitle
  const stub = responses(invalid, audit)
  const result = await enhanceCoverPrompt(input, stub.request)
  assert.equal(result.main_title, longTitle)
  assert.equal(stub.calls.length, 2)
  assert.equal(result.editorial_plan!.candidates[0]!.main_title, longTitle)
})

test('reviewing the current user design returns a single preserved candidate with independent approval', async () => {
  const { input, batch, audit } = setup(fixtures[1])
  const candidate = { ...batch.candidates[0]!, method: '用户方案' }
  const fixed = { candidates: [candidate] }
  const singleAudit = { ...audit, reviews: [audit.reviews[0]!] }
  const stub = responses(fixed, singleAudit)
  const result = await reviewCoverPrompt(input, candidate, stub.request)
  for (const field of ['main_title', 'sub_title', 'kicker', 'image_prompt', 'accent_color'] as const) {
    assert.equal(result[field], candidate[field])
  }
  assert.equal(result.editorial_plan!.candidates.length, 1)
  assert.equal(stub.calls.length, 2)
  assert.deepEqual(JSON.parse(stub.calls[0]![1]!.content).fixedDesign, candidate)
})

for (const field of ['main_title', 'sub_title', 'kicker', 'image_prompt', 'accent_color'] as const) {
  test(`reviewCoverPrompt refuses a model's silent edit to the user's ${field}`, async () => {
    const { input, batch } = setup()
    const design: CoverPromptEnhanceResult = { ...batch.candidates[0]! }
    const changed = { ...batch.candidates[0]!, method: '用户方案', [field]: field === 'accent_color' ? '#112233' : '擅自替换用户已经选择的设计' }
    const stub = responses({ candidates: [changed] }, { candidates: [changed] })
    await assert.rejects(reviewCoverPrompt(input, design, stub.request), /必须保留用户文案与画面提示词/)
    assert.equal(stub.calls.length, 2)
  })
}

test('legacy enhancement remains a single request and accepts camel-case provider fields', async () => {
  const stub = responses({ mainTitle: ' 普通封面 ', imagePrompt: ' cinematic image ', accentColor: '#D7A649', label: '历史' })
  const result = await enhanceCoverPrompt({ roughPrompt: '优化这个封面' }, stub.request)
  assert.equal(result.main_title, '普通封面')
  assert.equal(result.image_prompt, 'cinematic image')
  assert.equal(result.kicker, '历史')
  assert.equal(result.editorial_plan, undefined)
  assert.equal(stub.calls.length, 1)
})

test('editorial planning requires a script and gives the full script to both generator and reviewer', async () => {
  const unused = responses()
  await assert.rejects(enhanceCoverPrompt({ roughPrompt: '', editorialReview: true }, unused.request), /缺少脚本正文/)
  assert.equal(unused.calls.length, 0)
  const { input, batch, audit } = setup()
  const fullScript = '历史背景。'.repeat(3000) + input.episodeContent
  const stub = responses(batch, audit)
  await enhanceCoverPrompt({ ...input, episodeContent: fullScript }, stub.request)
  assert.equal(JSON.parse(stub.calls[0]![1]!.content).script, fullScript)
  assert.equal(JSON.parse(stub.calls[1]![1]!.content).script, fullScript)
})

test('stored genuine historical publishing reviews remain valid without inventing new audit dimensions', () => {
  const { batch, audit } = setup()
  const plan = coverEditorialPlanSchema.parse({ version: 'history-cover-plan-v1',
    candidates: [batch.candidates[0]], selected_id: 'candidate-1', selection_reason: audit.selection_reason,
    reviews: [audit.reviews[0]] })
  assert.equal(hasCompleteCoverReview(plan), true)
  assert.equal(hasCompleteCoverPlan(plan), true)
  assert.equal(plan.reviews[0]!.title_emotion, undefined)
})

test('stored historical review records retain distinct titles and their original punctuation', () => {
  const { batch, audit } = setup()
  const candidate = { ...batch.candidates[0]!, main_title: '明朝宫廷，冬天的一斤韭菜到底有多贵！', video_title: '旧视频，标题！' }
  const plan = coverEditorialPlanSchema.parse({ version: 'history-cover-plan-v1', ...audit, candidates: [candidate], reviews: [audit.reviews[0]!] })
  assert.equal(plan.candidates[0]!.main_title, candidate.main_title)
  assert.equal(plan.candidates[0]!.video_title, candidate.video_title)
})

test('fixed user review retains distinct original titles even with the publishing flag', async () => {
  const { input, batch, audit } = setup()
  const candidate = { ...batch.candidates[0]!, method: '用户方案', main_title: '明朝宫廷，冬天的一斤韭菜到底有多贵！', video_title: '旧视频，标题！' }
  const stub = responses({ candidates: [candidate] }, { ...audit, reviews: [audit.reviews[0]!] })
  const result = await reviewCoverPrompt({ ...input, publishingCopy: true }, candidate, stub.request)
  assert.equal(result.main_title, candidate.main_title)
  assert.equal(result.video_title, candidate.video_title)
  assert.equal(result.editorial_plan!.candidates[0]!.main_title, candidate.main_title)
})

test('publishing entry cleans the original for screenshot covers without invoking a configured model', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected live model or search request') })
  const { input } = setup()
  const title = '明朝宫廷买菜 一斤韭菜抵五天工钱？'
  const stub = responses()
  const result = await enhanceCoverPrompt({ ...input,
    sourceTitle: '第十八集：明朝宫廷买菜 一斤韭菜抵五天工钱？｜助眠睡前歷史故事', publishingCopy: true,
  }, stub.request)
  assert.equal(stub.calls.length, 0)
  assert.equal(result.baijiahao_title, title)
  assert.equal(result.video_title, title)
  assert.equal(result.main_title, title)
  assert.equal(result.image_prompt, '')
  assert.equal(result.sub_title, '')
  assert.equal(result.kicker, '')
  assert.equal(result.video_description, '')
  assert.equal(result.editorial_plan!.publishing_version, 'source-screenshot-v3')
  assert.equal(hasCompleteCoverPlan(coverEditorialPlanSchema.parse(result.editorial_plan)), true)
})

test('historical 25-character multi-package plans retain their original prompt and completeness semantics', () => {
  const { batch } = setup()
  const references: HistoryTitleResearch['references'] = [1, 2, 3].map(index => ({
    id: `R${index}`, title: `宫廷一斤韭菜竟抵五天工钱${index}`, url: `https://www.toutiao.com/article/123456789${index}`,
    platform: 'toutiao', snippet: '宫廷冬季采购的特殊菜价', query: '宫廷 韭菜',
  }))
  const rewrites = references.map((reference, index) => ({
    id: `candidate-${index + 1}`, reference_id: reference.id, original_title: reference.title,
    title: index === 0 ? '宫廷' + '贵'.repeat(22) + '？' : batch.candidates[index]!.main_title.replace(/，/g, ' '),
    adaptation: '保留菜价与工钱的关系',
  }))
  const legacy = {
    version: 'history-cover-plan-v1', selection_mode: 'curiosity', selected_id: 'candidate-1', selection_reason: '旧方案选择记录', reviews: [],
    title_research: { searched_at: '2026-10-21T08:00:00.000Z', keywords: [['宫廷', '韭菜'], ['普通工人', '工钱']],
      queries: ['toutiao', 'baijiahao', 'toutiao', 'baijiahao'].map(platform => ({ platform, query: '宫廷 韭菜', status: 'ok' })), references },
    title_rewrites: {
      prompt: '请将下面这个标题改写为更自然、更有人类写作风格的表达，要求字数不超过25个字。更有情绪和冲突，能激起人的好奇心和求知欲',
      shortlist: references.map(reference => ({ reference_id: reference.id, reason: '同题的历史参考标题' })), rewrites,
    },
    candidates: rewrites.map(rewrite => ({ ...batch.candidates[0]!, id: rewrite.id,
      main_title: rewrite.title, video_title: rewrite.title, video_description: '旧版简介保留。',
      reference_ids: [rewrite.reference_id], reference_adaptation: rewrite.adaptation })),
  }
  const parsed = coverEditorialPlanSchema.parse(legacy)
  assert.equal(parsed.candidates[0]!.main_title.length, 25)
  assert.equal(parsed.candidates.length, 3)
  assert.equal(hasCompleteCoverPlan(parsed), true)
  assert.equal(hasCompleteCoverReview(parsed), false)
  assert.equal(hasCompleteCoverPlan({ ...parsed, publishing_version: 'platform-v1' }), false)
})
