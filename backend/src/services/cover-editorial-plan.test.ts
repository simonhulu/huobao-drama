import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { coverEditorialPlanSchema, createCoverEditorialPlan, hasCompleteCoverPlan, type CoverEditorialPlan } from './cover-editorial-plan.js'
import type { CoverJsonRequest, CoverPromptEnhanceInput } from './cover-prompt-enhance.js'
import type { HistoryTitleResearch } from './history-title-research.js'
import { HISTORY_TITLE_REWRITE_PROMPT } from './history-title-rewrite.js'

const script = '明朝皇帝为何改传弟弟。原因藏在继承制度里。'
const originalTitle = '朱由检为何接下皇位？'
const input: CoverPromptEnhanceInput = {
  roughPrompt: '保留正文冲突', sourceTitle: '第十二集：朱由检为何继位｜助眠睡前歷史故事',
  episodeTitle: '朱由检为何继位', episodeContent: script, publishingCopy: true,
}

test.beforeEach(t => {
  assert.ok('mock' in t)
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unit tests must not call a live model') })
  t.mock.method(childProcess, 'execFile', () => { throw new Error('Unit tests must not perform a real title search') })
})

function research(references = false, failed = false): HistoryTitleResearch {
  return {
    searched_at: '2026-10-25T08:00:00.000Z', keywords: [['明朝', '皇帝'], ['弟弟']],
    queries: ['toutiao', 'baijiahao', 'toutiao', 'baijiahao'].map(platform => ({
      platform: platform as 'toutiao' | 'baijiahao', query: '皇位 继承', status: failed ? 'error' : 'empty',
    })),
    references: references ? [{ id: 'R1', title: '皇帝有子为何传位给弟弟', url: 'https://www.toutiao.com/article/1234567890',
      platform: 'toutiao', snippet: '检索摘要不是正文事实', query: '皇位 继承' }] : [],
  }
}

function fallbackPlan(fallback: NonNullable<CoverEditorialPlan['title_fallback']>, snapshot?: HistoryTitleResearch): CoverEditorialPlan {
  const { evidence_ids: _evidenceIds, ...candidate } = packageCandidate()
  return {
    version: 'history-cover-plan-v1', publishing_version: 'platform-v1', selection_mode: 'curiosity',
    selected_id: 'candidate-1', selection_reason: '采用正文中的具体问题', reviews: [], title_fallback: fallback,
    ...(snapshot ? { title_research: snapshot } : {}),
    candidates: [{ ...candidate, method: '正文原创', main_title: originalTitle, video_title: originalTitle, evidence: ['明朝皇帝为何改传弟弟。'] }],
  }
}

function packageCandidate() {
  return {
    id: 'candidate-1',
    baijiahao_title: '朱由检为何继位，天启皇帝的继承难题',
    video_description: '天启皇帝明明有儿子，皇位为何最后交给弟弟？这场继承安排背后有一条关键线索。',
    sub_title: '皇位传承藏着关键线索',
    kicker: '历史转折',
    image_prompt: 'cinematic historical palace interior, emperor and young prince facing an empty throne, clear foreground subjects, dramatic directional light, highly detailed, no text, no watermark',
    accent_color: '#D7A649',
    enhanced_prompt: '围绕继承难题设计清楚的宫廷对照画面。',
    rationale: '把有子却传弟的反常安排放在画面中心。',
    why_click: '观众会追问为什么有子仍然传弟。',
    viewer_question: '为什么皇位没有传给亲生儿子？',
    payoff: '正文解释了继承安排背后的现实原因。',
    visual_concept: '前景为皇帝与空着的皇位，后景保留宫廷留白。',
    evidence_ids: ['P1'],
  }
}

const noModel: CoverJsonRequest = async () => assert.fail('original-title cleanup and screenshot planning must not call a model')

test('publishing cleans the original and uses the same complete title for its screenshot cover without model calls', async () => {
  const result = await createCoverEditorialPlan(input, noModel)
  const plan = coverEditorialPlanSchema.parse(JSON.parse(JSON.stringify(result.editorial_plan)))
  assert.equal(result.baijiahao_title, '朱由检为何继位')
  assert.equal(result.video_title, result.baijiahao_title)
  assert.equal(result.main_title, result.baijiahao_title)
  assert.equal(result.sub_title, '')
  assert.equal(result.kicker, '')
  assert.equal(result.image_prompt, '')
  assert.equal(result.video_description, '')
  assert.equal(plan.selection_mode, 'source-title')
  assert.equal(plan.publishing_version, 'source-screenshot-v3')
  assert.deepEqual(plan.source_title_cleanup, { source_title: input.sourceTitle, cleaned_title: '朱由检为何继位' })
  assert.deepEqual(plan.candidates[0]!.evidence, [script])
  assert.deepEqual(plan.reviews, [])
  assert.equal(hasCompleteCoverPlan(plan), true)
})

test('obsolete reference research and an injected title writer cannot influence a new screenshot package', async () => {
  const result = await createCoverEditorialPlan({ ...input, titleResearch: research(true) }, noModel, undefined, noModel)
  assert.equal(result.baijiahao_title, '朱由检为何继位')
  assert.equal(result.editorial_plan!.title_research, undefined)
  assert.equal(result.editorial_plan!.title_rewrites, undefined)
  assert.equal(result.editorial_plan!.source_title_rewrite, undefined)
})

test('missing original fails without inventing a title from the episode or script', async () => {
  for (const sourceTitle of [undefined, '', '第12集｜欢迎订阅']) {
    await assert.rejects(createCoverEditorialPlan({ ...input, sourceTitle }, noModel), /原标题/)
  }
})

test('different video producers share the cleaned original rather than requiring newly invented titles', async () => {
  for (const producer of ['huasheng', 'motion', 'manual'] as const) {
    const result = await createCoverEditorialPlan({ ...input, publishingVariant: { videoId: 21, producer, otherPackages: [
      { producer: 'huasheng', title: '朱由检为何继位', mainTitle: '朱由检为何继位', imagePrompt: '' },
    ] } }, noModel)
    assert.equal(result.baijiahao_title, '朱由检为何继位')
    assert.equal(result.main_title, result.baijiahao_title)
    assert.equal(result.image_prompt, '')
  }
})

test('stored screenshot provenance rejects changed wording, generated image prompts and mixed legacy records', async () => {
  const result = await createCoverEditorialPlan(input, noModel)
  for (const mutate of [
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.main_title = '另一个标题' },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.baijiahao_title = '另一个标题' },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.video_title = '另一个标题' },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.image_prompt = 'Invented historical scene' },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.sub_title = '创作的副标题' },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.kicker = '历史真相' },
    (plan: CoverEditorialPlan) => { plan.source_title_cleanup!.cleaned_title = '另一个原标题' },
    (plan: CoverEditorialPlan) => { plan.source_title_cleanup!.source_title = '换了原标题' },
    (plan: CoverEditorialPlan) => { delete plan.source_title_cleanup },
    (plan: CoverEditorialPlan) => { plan.title_research = research(true) },
    (plan: CoverEditorialPlan) => { plan.selected_id = 'missing' },
    (plan: CoverEditorialPlan) => { plan.candidates.push(structuredClone(plan.candidates[0]!)) },
  ]) {
    const plan = structuredClone(result.editorial_plan!); mutate(plan)
    assert.equal(hasCompleteCoverPlan(plan), false)
  }
})

test('unavailable providers do not prevent deterministic original-title cleanup', async () => {
  let calls = 0
  const unavailable: CoverJsonRequest = async () => { calls++; throw new Error('model unavailable') }
  const result = await createCoverEditorialPlan(input, unavailable, undefined, unavailable)
  assert.equal(calls, 0)
  assert.equal(result.main_title, '朱由检为何继位')
})

test('fallback completeness requires the research snapshot appropriate to its actual failure stage', () => {
  const valid = [
    fallbackPlan('no_references', research()),
    fallbackPlan('unrelated_references', research(true)),
    fallbackPlan('research_unavailable'),
    fallbackPlan('research_unavailable', research(false, true)),
    fallbackPlan('rewrite_unavailable', research(true)),
  ]
  for (const plan of valid) assert.equal(hasCompleteCoverPlan(coverEditorialPlanSchema.parse(plan)), true, plan.title_fallback)
  const invalid = [
    fallbackPlan('no_references'),
    fallbackPlan('no_references', research(true)),
    fallbackPlan('no_references', research(false, true)),
    fallbackPlan('unrelated_references'),
    fallbackPlan('unrelated_references', research()),
    fallbackPlan('research_unavailable', research()),
    fallbackPlan('research_unavailable', research(true, true)),
    fallbackPlan('rewrite_unavailable'),
    fallbackPlan('rewrite_unavailable', research()),
  ]
  for (const plan of invalid) assert.equal(hasCompleteCoverPlan(plan), false, `${plan.title_fallback}: ${JSON.stringify(plan.title_research)}`)
  for (const mutate of [
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.reference_ids = ['R1'] },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.reference_adaptation = '声称改写了参考题' },
    (plan: CoverEditorialPlan) => { plan.candidates[0]!.video_title = '擅自换了标题' },
    (plan: CoverEditorialPlan) => { plan.title_rewrites = { prompt: HISTORY_TITLE_REWRITE_PROMPT,
      shortlist: [{ reference_id: 'R1', reason: '参考题' }], rewrites: [{ id: 'candidate-1', reference_id: 'R1',
        original_title: research(true).references[0]!.title, title: originalTitle, adaptation: '不可冒称改写' }] } },
  ]) {
    const plan = fallbackPlan('rewrite_unavailable', research(true))
    mutate(plan)
    assert.equal(hasCompleteCoverPlan(plan), false)
  }
})

