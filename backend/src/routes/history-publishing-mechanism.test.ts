import test, { after, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

const root = mkdtempSync(join(tmpdir(), 'history-publishing-mechanism-'))
process.env.DB_PATH = join(root, 'test.db')
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { updateHistorySource } = await import('../services/history-script-library.js')
const { saveHistoryDelivery, getHistoryDelivery } = await import('../services/history-script-delivery.js')
const { createHistoryDeliveryRoute } = await import('./history-script-delivery.js')
const { hasSupportedVideoTitleSymbols } = await import('../services/video-title-format.js')
const app = new Hono().route('/history-scripts/:id/delivery', createHistoryDeliveryRoute())
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
async function waitForDesign(id: number, target = app) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const response = await target.request(`/history-scripts/${id}/delivery`)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    if (body.data.designStatus !== 'generating') return body
    await flush()
  }
  assert.fail('The background title job did not reach a terminal state')
}
async function generateDesign(id: number) {
  const response = await app.request(`/history-scripts/${id}/delivery/design`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const body = await response.json()
  assert.equal(response.status, 202, JSON.stringify(body))
  assert.equal(body.data.designStatus, 'generating')
  assert.ok(body.data.designRunId)
  assert.equal(body.data.designError, null)
  return waitForDesign(id)
}
function assertPreservedPackage(actual: ReturnType<typeof getHistoryDelivery>, previous: ReturnType<typeof getHistoryDelivery>) {
  const { designStatus: _actualStatus, designRunId: _actualRun, designError: _actualError, ...actualPackage } = actual
  const { designStatus: _previousStatus, designRunId: _previousRun, designError: _previousError, ...previousPackage } = previous
  assert.deepEqual(actualPackage, previousPackage)
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fixtures = [
  { id: 51, sourceTitle: '第18集 | 明朝兴衰史 #历史', hook: '修仙没亡国 勤政却亡了', subject: '修仙', anomaly: '勤政却亡了',
    feeling: '不甘', emotionSpan: '勤政却亡了', tension: '勤于政务仍未能挽回亡国，努力与结果形成落差。',
    keywordGroups: [['明朝', '嘉靖'], ['崇祯', '明亡']],
    script: '嘉靖长期修道炼丹，崇祯勤于政务却未能挽回明亡。明朝十六帝的选择逐渐影响朝局，危机也在多代之间累积。',
    description: '修道炼丹时没有亡国，勤于政务时却撑不住了？从嘉靖到崇祯，大明十六帝究竟经历了什么？' },
  { id: 52, sourceTitle: '第17集 | 五胡十六国 & 魏晋南北朝 #历史', hook: '司马家到手的天下自己砸了', subject: '司马家', anomaly: '天下自己砸了',
    feeling: '荒唐与惋惜', emotionSpan: '到手的天下自己砸了', tension: '已经统一却发生皇族内斗，所得与自毁形成反差。',
    keywordGroups: [['西晋', '八王之乱'], ['五胡十六国', '魏晋南北朝']],
    script: '司马家取代曹魏，西晋重新统一天下。八王之乱之后北方政权交错更替，东晋退居南方，隋朝后来重新统一南北。',
    description: '司马家刚把天下拼在一起，皇族自己先乱了。北方不断换政权，晋室退到南方，这段乱世怎么才能看明白？' },
  { id: 73, sourceTitle: '兵多为何也会输？赤壁战前 #三国', hook: '曹操兵多 怎么偏偏输了', subject: '曹操', anomaly: '偏偏输了',
    feeling: '意外与惋惜', emotionSpan: '兵多 怎么偏偏输了', tension: '兵力优势未能换成胜利，已有优势落空。',
    keywordGroups: [['曹操', '赤壁'], ['黄盖', '火攻']],
    script: '曹操取得荆州后继续南下，孙权与刘备结盟。曹军不习水战并受疾病困扰，黄盖诈降后实施火攻，兵力优势未能换来胜利。',
    description: '兵力占优，怎么还是没打赢？曹军一路南下，却碰上了水战和疾病的难题，赤壁这一仗到底变在了哪里？' },
]
type Fixture = (typeof fixtures)[number]
type LockedTitle = { id: string; main_title: string; video_title: string; reference_ids?: string[]; reference_adaptation?: string }
const selectedReferenceIds = ['R3', 'R1', 'R4', 'R2']
const pipelinePurposes = ['history-title-shortlist', ...selectedReferenceIds.map(() => 'lm-title-rewrite'), 'history-title-select', 'history-title-packages']
const rewritePrompt = '请将下面这个标题改写为更自然、更有人类写作风格的表达，要求字数不超过16个字。更有情绪和冲突，能激起人的好奇心和求知欲'
const rewriteModel = 'qwen3.5-9b-writing-dpo@q4_k_s'
const referenceTitle = (fixture: Fixture, group = 0, toutiao = true) =>
  `${fixture.keywordGroups[group]!.join(' ')} 到底经历了什么 ${toutiao ? '头条参考' : '百家参考'}`
const selectedReferenceTitle = (fixture: Fixture, id: string) => {
  const index = Number(id.slice(1)) - 1
  return referenceTitle(fixture, Math.floor(index / 2), index % 2 === 0)
}
const defaultTitles = (fixture: Fixture) => selectedReferenceIds.map((_id, index) => `${fixture.hook}${index ? index + 1 : ''}？`)

function mockTitleSearch(t: TestContext, shouldFail: () => boolean = () => false, referenceCount = 4) {
  const queries: string[] = []
  t.mock.method(childProcess, 'execFile', ((file: unknown, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, 'mcporter')
    assert.deepEqual(args.slice(0, 3), ['call', 'MiniMax.web_search', '--args'])
    assert.deepEqual(args.slice(4), ['--output', 'json', '--timeout', '25000', '--no-oauth'])
    assert.equal(options.shell, false)
    const { query } = JSON.parse(args[3]!) as { query: string }
    queries.push(query)
    if (shouldFail()) callback(new Error('private-search-token'), '', 'private-search-token')
    else {
      const fallback = !query.startsWith('site:')
      const fixture = fixtures.find(item => fallback ? query.endsWith(item.keywordGroups.flat().join(' '))
        : item.keywordGroups.some(group => query.endsWith(group.join(' '))))
      assert.ok(fixture, 'Only current-script keyword groups may be searched')
      const group = fallback ? 0 : fixture.keywordGroups.findIndex(words => query.endsWith(words.join(' ')))
      const toutiao = query.startsWith('site:toutiao.com ') || query.startsWith('今日头条 ')
      assert.equal(query, fallback ? `${toutiao ? '今日头条' : '百家号'} ${fixture.keywordGroups.flat().join(' ')}`
        : `site:${toutiao ? 'toutiao.com' : 'baijiahao.baidu.com'} ${fixture.keywordGroups[group]!.join(' ')}`)
      const articleId = `${fixture.id}${group}${toutiao ? 1 : 2}`
      const references = group * 2 + (toutiao ? 0 : 1) < referenceCount ? [{
        title: referenceTitle(fixture, group, toutiao),
        link: toutiao ? `https://www.toutiao.com/article/${articleId}/` : `https://baijia.baidu.com/s?id=${articleId}&wfr=pc`,
        snippet: fixture.script, date: '2026-10-01',
      }] : []
      callback(null, JSON.stringify({ organic: references, base_resp: { status_code: 0 } }), '')
    }
    return {} as ReturnType<typeof childProcess.execFile>
  }) as unknown as typeof childProcess.execFile)
  return queries
}

function successfulCandidates(fixture: Fixture, lockedTitles: LockedTitle[]) {
  return lockedTitles.map(locked => ({ ...locked, method: locked.reference_ids ? '真实母题改写' : '正文原创标题', video_description: fixture.description,
    baijiahao_title: `${locked.main_title}：这段历史为何出人意料？`,
    sub_title: '同一个结果背后，究竟出了什么变化？', kicker: '',
    image_prompt: 'Historical Chinese rulers facing a changing situation, cinematic, highly detailed, no text, no watermark',
    why_click: '放大本次原题与正文之间的真实反差，让观众追问异常结果。', viewer_question: '为什么常识预期没有兑现？',
    payoff: '理解当前正文中解释这一反常结果的历史处境。', evidence_ids: ['P1', 'P2'], visual_concept: '用本次正文人物与处境表现反差。',
  }))
}

function successfulReview(fixture: Fixture, candidates: { id: string }[]) {
  return { selected_id: 'candidate-1', selection_reason: '反常结果具体，正文能够解释，标题与简介共同保留追问。',
    reviews: candidates.map(candidate => ({ candidate_id: candidate.id,
      natural: true, understandable: true, curiosity: true, faithful: true, visual_faithful: true, coherent: true,
      reason: '具体反差有原文依据，没有把介绍写成答案。', title_hook: {
        subject_span: fixture.subject, anomaly_span: fixture.anomaly, specific: true, curiosity_gap: true, beats_summary: true,
        expectation: '常识预期与正文结果不同。', viewer_question: '为什么这个具体对象出现了相反结果？',
        neutral_summary: '当前主题的事件经过', reason: '主标题已经露出具体对象与反常结果，而不是只说局势有变。', script_answer: fixture.script,
      }, title_emotion: { feeling: fixture.feeling, trigger_span: fixture.emotionSpan, tension: fixture.tension,
        felt: true, grounded: true, reason: '情绪来自正文中努力或优势与最终结果的落差，没有添加新事实。' } })),
  }
}

const providerReply = (content: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] })
const localTitleReply = (title: unknown, finishReason = 'stop') => Response.json({ model: rewriteModel,
  choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: title } }],
})
type Selection = { selected_id: string; selection_reason: string }
function mockPublishingProvider(t: TestContext, options: {
  fixture?: Fixture;
  titles?: string[];
  selection?: (selection: Selection) => unknown;
  candidates?: (candidates: ReturnType<typeof successfulCandidates>) => unknown[];
  reply?: (input: Record<string, any>) => unknown;
  localReply?: () => Response | Promise<Response>;
  onInput?: (input: Record<string, any>, body: Record<string, any>) => void;
  referenceCount?: number | (() => number);
  selectedIds?: string[];
  fallback?: 'research_unavailable' | 'rewrite_unavailable';
} = {}) {
  const calls: { id: number; purpose: string }[] = []
  let activeLocalCalls = 0
  let localCallIndex = 0
  let selectedCandidateId = 'candidate-1'
  const referenceCount = () => typeof options.referenceCount === 'function' ? options.referenceCount() : options.referenceCount ?? 4
  const selectedIds = () => options.selectedIds ?? selectedReferenceIds.filter(id => Number(id.slice(1)) <= referenceCount())
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (String(url) === 'http://127.0.0.1:1234/v1/chat/completions') {
      assert.equal(init.method, 'POST')
      assert.equal(body.model, rewriteModel)
      assert.equal(body.messages.length, 3)
      assert.deepEqual(body.messages[0], { role: 'system', content: rewritePrompt })
      assert.equal(body.messages[1].role, 'user')
      assert.deepEqual(body.messages[2], { role: 'assistant', content: '</think>\n\n' })
      assert.equal(body.temperature, 0.3)
      assert.equal(body.repeat_penalty, 1)
      assert.equal(body.response_format, undefined)
      assert.equal(body.seed, 42)
      const correctionIndex = body.messages[1].content.indexOf('\n\n上次输出：')
      const originalTitle = correctionIndex < 0 ? body.messages[1].content : body.messages[1].content.slice(0, correctionIndex)
      const fixture = fixtures.find(item => selectedIds().some(id => selectedReferenceTitle(item, id) === originalTitle))
      assert.ok(fixture, 'Each local rewrite must use an actual parent selected for the current script')
      if (options.fixture) assert.equal(fixture.id, options.fixture.id)
      assert.ok(!originalTitle.includes(fixture.script))
      assert.ok(!originalTitle.includes(fixture.sourceTitle))
      const parentIndex = selectedIds().findIndex(id => selectedReferenceTitle(fixture, id) === originalTitle)
      assert.ok(parentIndex >= 0, 'Only the selected actual parent title may reach the local writer')
      if (correctionIndex < 0) assert.equal(parentIndex, localCallIndex++ % selectedIds().length, 'Local rewrites follow shortlist order')
      else assert.equal(parentIndex, (localCallIndex - 1) % selectedIds().length, 'Format correction keeps the same selected parent')
      assert.equal(activeLocalCalls, 0, 'Local mother-title rewrites must run sequentially')
      activeLocalCalls++
      calls.push({ id: fixture.id, purpose: 'lm-title-rewrite' })
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        if (options.localReply) return await options.localReply()
        return localTitleReply((options.titles || defaultTitles(fixture))[parentIndex]!)
      } finally { activeLocalCalls-- }
    }
    assert.equal(String(url), 'https://publishing.example/v1/chat/completions')
    const input = JSON.parse(body.messages[1].content)
    assert.notEqual(input.purpose, 'history-title-rewrite', 'The project provider cannot replace the requested local writer')
    const fixture = fixtures.find(item => item.sourceTitle === input.sourceTitle)
    assert.ok(fixture, 'Every stage must receive the current script source title')
    if (options.fixture) assert.equal(fixture.id, options.fixture.id)
    assert.equal(input.script, fixture.script)
    calls.push({ id: fixture.id, purpose: input.purpose })
    options.onInput?.(input, body)
    if (input.purpose === 'history-title-keywords') return providerReply({ keyword_groups: fixture.keywordGroups })
    const titles = options.titles || defaultTitles(fixture)
    if (input.purpose === 'history-title-original') {
      assert.equal(input.titleResearch, undefined)
      assert.equal(input.titleParents, undefined)
      return providerReply(options.reply?.(input) ?? { video_title: titles[0] })
    }
    if (input.purpose === 'history-title-select') {
      assert.equal(input.titleResearch, undefined)
      assert.equal(input.titleParents, undefined)
      assert.ok(input.candidates.length > 1, 'A single candidate does not need a selection request')
      for (const candidate of input.candidates) {
        assert.deepEqual(Object.keys(candidate).sort(), ['id', 'main_title'])
      }
      const selection = { selected_id: 'candidate-1', selection_reason: '具体反差最能激起好奇心和求知欲。' }
      const selected = options.selection ? options.selection(selection) : selection
      selectedCandidateId = (selected as Selection).selected_id
      return providerReply(selected)
    }
    if (input.purpose === 'history-title-shortlist') {
      assert.equal(input.titleResearch, undefined, 'Reference snippets must not influence parent-title shortlisting')
      assert.deepEqual(input.references, Array.from({ length: referenceCount() }, (_, index) => `R${index + 1}`)
        .map(reference_id => ({ reference_id, original_title: selectedReferenceTitle(fixture, reference_id) })))
    } else if (input.titleFallback) {
      assert.equal(input.titleFallback, options.fallback ?? (referenceCount() ? 'unrelated_references' : 'no_references'))
      assert.equal(input.titleResearch, undefined, 'Original packaging must not inherit irrelevant references')
      assert.equal(input.titleParents, undefined)
    } else {
      assert.deepEqual(input.titleResearch.keywords, fixture.keywordGroups)
      assert.equal(input.titleResearch.references.length, referenceCount())
      assert.ok(input.titleResearch.references.every((reference: { id: string; title: string; snippet?: string }) =>
        reference.title === selectedReferenceTitle(fixture, reference.id) && reference.snippet === undefined))
    }
    const customReply = options.reply?.(input)
    if (customReply !== undefined) return providerReply(customReply)
    if (input.purpose === 'history-title-shortlist') return providerReply({ selected: selectedIds().map(reference_id => ({
      reference_id, reason: '与本篇的对象和反差一致，直接借鉴具体追问的写法。',
    })) })
    if (input.purpose === 'history-title-packages') {
      assert.equal(input.lockedTitles.length, 1, 'Only the selected short title gets platform copy and a cover package')
      if (input.titleFallback) {
        assert.deepEqual(input.lockedTitles, [{ id: 'candidate-1', main_title: titles[0], video_title: titles[0] }])
      } else {
        assert.deepEqual(input.lockedTitles.map((locked: LockedTitle) => ({
          id: locked.id, main_title: locked.main_title, video_title: locked.video_title, reference_ids: locked.reference_ids,
        })), selectedIds().map((reference_id, index) => ({ id: `candidate-${index + 1}`,
          main_title: titles[index], video_title: titles[index], reference_ids: [reference_id],
        })).filter(locked => locked.id === selectedCandidateId))
        for (const locked of input.lockedTitles as LockedTitle[]) {
          assert.ok(locked.reference_adaptation?.includes(selectedReferenceTitle(fixture, locked.reference_ids![0]!)))
        }
      }
      const candidates = successfulCandidates(fixture, input.lockedTitles)
      return providerReply({ candidates: options.candidates ? options.candidates(candidates) : candidates })
    }
    assert.fail(`Unexpected model purpose: ${input.purpose}`)
  })
  return calls
}

beforeEach(() => {
  db.$client.prepare('DELETE FROM history_script_deliveries').run()
  db.delete(schema.historyScriptSources).run()
  db.delete(schema.aiServiceConfigs).run()
  const now = new Date().toISOString()
  db.insert(schema.aiServiceConfigs).values({ name: 'Publishing test provider', serviceType: 'text', provider: 'openai',
    baseUrl: 'https://publishing.example', apiKey: 'test-only', model: JSON.stringify(['publishing-test']),
    isActive: true, createdAt: now, updatedAt: now }).run()
  for (const fixture of fixtures) {
    db.insert(schema.historyScriptSources).values({ id: fixture.id, sourceVideoId: String(fixture.id),
      sourceUrl: `https://www.douyin.com/video/${fixture.id}`, title: fixture.sourceTitle,
      category: 'historical_commentary', createdAt: now, updatedAt: now }).run()
    const rawTranscript = fixture.script
    updateHistorySource(fixture.id, { status: 'needs_review', rawTranscript, correctedTranscript: rawTranscript, rewrittenScript: fixture.script,
      mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
      asrJson: JSON.stringify({ complete: true, text: rawTranscript, sourceVideoSha256: '1'.repeat(64),
        chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
      reviewJson: JSON.stringify({ correctedTranscript: rawTranscript, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources',
        rawTranscriptSha256: hash(rawTranscript), correctedTranscriptSha256: hash(rawTranscript), rewriteInputSha256: hash(rawTranscript) }),
    })
  }
})
after(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })

test('POST starts an independent title job immediately and GET restores progress and failure after the caller leaves', async () => {
  const previous = saveHistoryDelivery(52, { title: '保留原标题', description: '保留原简介' })
  let fail!: (error: Error) => void
  const pending = new Promise<never>((_resolve, reject) => { fail = reject })
  let calls = 0
  const target = new Hono().route('/history-scripts/:id/delivery', createHistoryDeliveryRoute({
    generateDesign: () => { calls++; return pending },
  }))
  const controller = new AbortController()
  try {
    const response = await target.request('/history-scripts/52/delivery/design', { method: 'POST', signal: controller.signal })
    const body = await response.json()
    assert.equal(response.status, 202, JSON.stringify(body))
    assert.equal(body.data.designStatus, 'generating')
    assert.ok(body.data.designRunId)
    assert.equal(body.data.designError, null)
    const refreshed = await (await target.request('/history-scripts/52/delivery')).json()
    assert.deepEqual(refreshed.data, body.data)
    const duplicate = await target.request('/history-scripts/52/delivery/design', { method: 'POST' })
    assert.equal(duplicate.status, 409)
    controller.abort()
    fail(new Error('标题改写服务暂时不可用'))
    const failed = (await waitForDesign(52, target)).data
    assert.equal(calls, 1)
    assert.equal(failed.designStatus, 'failed')
    assert.equal(failed.designRunId, null)
    assert.match(failed.designError, /标题改写服务暂时不可用/)
    assertPreservedPackage(failed, previous)
    assert.deepEqual((await (await target.request('/history-scripts/52/delivery')).json()).data, failed)
  } finally {
    fail(new Error('Test cleanup'))
    await flush()
  }
})

test('invalid and stale script submissions return synchronous errors instead of creating background jobs', async () => {
  let called = false
  const target = new Hono().route('/history-scripts/:id/delivery', createHistoryDeliveryRoute({
    generateDesign: async () => { called = true; assert.fail('Rejected submissions must not reach the generator') },
  }))
  for (const [id, status] of [['bad', 400], ['0', 400], ['99999', 404]] as const) {
    const response = await target.request(`/history-scripts/${id}/delivery/design`, { method: 'POST' })
    assert.equal(response.status, status)
  }
  updateHistorySource(52, { rawTranscript: 'A newer source transcript invalidates the rewritten script' })
  const response = await target.request('/history-scripts/52/delivery/design', { method: 'POST' })
  assert.equal(response.status, 409)
  assert.equal(called, false)
  assert.equal(getHistoryDelivery(52).designStatus, 'idle')
})

test('every script ID uses its own source in the same production publishing pipeline', async t => {
  const searches = mockTitleSearch(t)
  const calls = mockPublishingProvider(t)
  for (const fixture of fixtures) {
    const body = await generateDesign(fixture.id)
    const saved = body.data
    assert.equal(saved.designStatus, 'completed')
    assert.equal(saved.title, `${fixture.hook}？`)
    assert.equal(saved.coverDesign.main_title, saved.title)
    assert.equal(saved.description, fixture.description)
    assert.equal(saved.coverPlanStatus, 'selected')
    assert.equal(saved.coverPlan.candidates.length, 1)
    assert.equal(saved.coverPlan.publishing_version, 'platform-v1')
    assert.equal(saved.baijiahaoTitle, `${saved.title}：这段历史为何出人意料？`)
    assert.equal(saved.coverPlan.selection_mode, 'curiosity')
    assert.deepEqual(saved.coverPlan.reviews, [])
    const research = saved.coverPlan.title_research
    assert.deepEqual(research.keywords, fixture.keywordGroups)
    assert.equal(Number.isFinite(Date.parse(research.searched_at)), true)
    assert.equal(research.queries.length, 4)
    assert.ok(research.queries.every((query: { status: string }) => query.status === 'ok'))
    assert.deepEqual(research.references.map((reference: { platform: string }) => reference.platform), ['toutiao', 'baijiahao', 'toutiao', 'baijiahao'])
    assert.ok(research.references.every((reference: { url: string; snippet: string; query: string }) =>
      reference.url.includes(String(fixture.id)) && reference.snippet === fixture.script && research.queries.some((query: { query: string }) => query.query === reference.query)))
    const rewritePlan = saved.coverPlan.title_rewrites
    assert.equal(rewritePlan.prompt, rewritePrompt)
    assert.equal(rewritePlan.model, rewriteModel)
    assert.deepEqual(rewritePlan.shortlist.map((selected: { reference_id: string }) => selected.reference_id), selectedReferenceIds)
    assert.deepEqual(rewritePlan.rewrites.map((rewrite: { id: string; reference_id: string; original_title: string; title: string; adaptation: string }) => ({
      id: rewrite.id, reference_id: rewrite.reference_id, original_title: rewrite.original_title, title: rewrite.title,
    })), selectedReferenceIds.map((reference_id, index) => ({ id: `candidate-${index + 1}`, reference_id,
      original_title: selectedReferenceTitle(fixture, reference_id), title: defaultTitles(fixture)[index],
    })))
    for (const [index, candidate] of saved.coverPlan.candidates.entries()) {
      assert.equal(candidate.main_title, candidate.video_title)
      assert.ok(candidate.video_title.length <= 16)
      assert.equal(candidate.baijiahao_title, saved.baijiahaoTitle)
      assert.ok(candidate.baijiahao_title.length <= 40)
      assert.equal(hasSupportedVideoTitleSymbols(candidate.video_title), true)
      assert.ok(candidate.evidence.every((quote: string) => fixture.script.includes(quote)))
      assert.deepEqual(candidate.reference_ids, [selectedReferenceIds[index]])
      assert.ok(candidate.reference_adaptation.includes(selectedReferenceTitle(fixture, selectedReferenceIds[index]!)))
      assert.ok(candidate.reference_ids.every((id: string) => research.references.some((reference: { id: string }) => reference.id === id)))
    }
    const loaded = await (await app.request(`/history-scripts/${fixture.id}/delivery`)).json()
    assert.deepEqual(loaded.data, saved)
  }
  assert.deepEqual(calls, fixtures.flatMap(({ id }) => ['history-title-keywords', ...pipelinePurposes].map(purpose => ({ id, purpose }))))
  assert.deepEqual(searches, fixtures.flatMap(fixture => fixture.keywordGroups.flatMap(group => [
    `site:toutiao.com ${group.join(' ')}`, `site:baijiahao.baidu.com ${group.join(' ')}`,
  ])))
  for (const fixture of fixtures) assert.equal(getHistoryDelivery(fixture.id).title, `${fixture.hook}？`)
})

test('automatic generation ignores negative audit-shaped selector output and never requests quality review', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  saveHistoryDelivery(52, { title: '已经保存的标题', description: '已经保存的简介' })
  const calls = mockPublishingProvider(t, { fixture,
    selection: selection => ({ ...selection, reviews: successfulReview(fixture, [{ id: 'candidate-1' }]).reviews.map(review => ({
      ...review, natural: false, understandable: false, curiosity: false, faithful: false, visual_faithful: false, coherent: false,
      title_hook: { ...review.title_hook, specific: false, curiosity_gap: false, beats_summary: false },
      title_emotion: { ...review.title_emotion, felt: false, grounded: false },
    })) }),
  })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.title, defaultTitles(fixture)[0])
  assert.equal(body.data.coverPlanStatus, 'selected')
  assert.deepEqual(body.data.coverPlan.reviews, [])
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
  assert.equal(calls.some(call => call.purpose === 'history-title-review'), false)
})

test('curiosity selection can choose a later candidate without rewriting the title or imposing quality verdicts', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  const calls = mockPublishingProvider(t, { fixture,
    selection: selection => ({ ...selection, selected_id: 'candidate-3' }),
  })
  const body = await generateDesign(fixture.id)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.title, defaultTitles(fixture)[2])
  assert.equal(body.data.coverDesign.main_title, body.data.title)
  assert.equal(body.data.coverPlanStatus, 'selected')
  assert.equal(body.data.coverPlan.selected_id, 'candidate-3')
  assert.deepEqual(body.data.coverPlan.reviews, [])
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
})

for (const selected_id of ['invented', null]) {
  test(`an invalid curiosity selection ${selected_id} preserves saved copy instead of silently accepting candidate one`, async t => {
    mockTitleSearch(t)
    const fixture = fixtures[1]!
    const previous = saveHistoryDelivery(fixture.id, { title: '已经保存的标题', description: '已经保存的简介' })
    const calls = mockPublishingProvider(t, { fixture, selection: selection => ({ ...selection, selected_id }) })
    const body = await generateDesign(fixture.id)
    assert.equal(body.data.designStatus, 'failed')
    assert.match(body.data.designError, /封面方案生成失败/)
    assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes.slice(0, -1)])
    assert.equal(calls.some(call => call.purpose === 'history-title-review'), false)
    assertPreservedPackage(getHistoryDelivery(fixture.id), previous)
  })
}

test('an invalid generated package for another script cannot fall back to old copy or overwrite saved fields', async t => {
  const searches = mockTitleSearch(t)
  const previous = saveHistoryDelivery(52, { title: '已经保存的标题', description: '已经保存的简介' })
  const calls = mockPublishingProvider(t, { fixture: fixtures[1]!, candidates: () => [] })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'failed')
  assert.match(body.data.designError, /封面方案生成失败/)
  assert.equal(searches.length, 4)
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes, 'history-title-packages'])
  assert.equal(calls.some(call => call.purpose === 'history-title-review'), false)
  assertPreservedPackage(getHistoryDelivery(52), previous)
})

test('failed title searches save a selected original package without leaking search errors or using the local writer', async t => {
  let searchFails = false
  const searches = mockTitleSearch(t, () => searchFails)
  const fixture = fixtures[1]!
  const calls = mockPublishingProvider(t, { fixture, referenceCount: () => searchFails ? 0 : 4, fallback: 'research_unavailable' })
  const previous = (await generateDesign(52)).data
  assert.equal(previous.designStatus, 'completed')
  assert.equal(previous.coverPlanStatus, 'selected')
  assert.equal(previous.coverPlan.title_research.references.length, 4)

  searchFails = true
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  const saved = body.data
  assert.equal(saved.title, defaultTitles(fixture)[0])
  assert.equal(saved.coverDesign.main_title, saved.title)
  assert.equal(saved.description, fixture.description)
  assert.equal(saved.coverPlanStatus, 'selected')
  assert.equal(saved.coverPlan.selection_mode, 'curiosity')
  assert.deepEqual(saved.coverPlan.reviews, [])
  assert.equal(saved.coverPlan.title_fallback, 'research_unavailable')
  assert.deepEqual(saved.coverPlan.title_research.references, [])
  assert.ok(saved.coverPlan.title_research.queries.every((query: { status: string; message?: string }) => query.status === 'error' && query.message))
  assert.equal(saved.coverPlan.title_rewrites, undefined)
  assert.doesNotMatch(JSON.stringify(body), /private-search-token/)
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes,
    'history-title-keywords', 'history-title-original', 'history-title-packages'])
  assert.equal(searches.length, 10)
  const loaded = await (await app.request('/history-scripts/52/delivery')).json()
  assert.deepEqual(loaded.data, saved)
  assert.deepEqual(getHistoryDelivery(52), saved)
})

for (const referenceCount of [1, 2]) {
  test(`${referenceCount} real reference titles are rewritten and saved without requiring three parents`, async t => {
    const fixture = fixtures[1]!
    const searches = mockTitleSearch(t, () => false, referenceCount)
    const calls = mockPublishingProvider(t, { fixture, referenceCount })
    const body = await generateDesign(52)
    assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
    const saved = body.data
    assert.equal(saved.title, defaultTitles(fixture)[0])
    assert.equal(saved.coverDesign.main_title, saved.title)
    assert.equal(saved.description, fixture.description)
    assert.equal(saved.coverPlanStatus, 'selected')
    assert.deepEqual(saved.coverPlan.reviews, [])
    assert.equal(saved.coverPlan.title_fallback, undefined)
    assert.equal(saved.coverPlan.title_research.references.length, referenceCount)
    assert.equal(saved.coverPlan.candidates.length, 1)
    const selected = selectedReferenceIds.filter(id => Number(id.slice(1)) <= referenceCount)
    assert.deepEqual(saved.coverPlan.title_rewrites.shortlist.map((parent: { reference_id: string }) => parent.reference_id), selected)
    for (const [index, candidate] of saved.coverPlan.candidates.entries()) {
      assert.equal(candidate.main_title, candidate.video_title)
      assert.deepEqual(candidate.reference_ids, [selected[index]])
    }
    assert.equal(searches.length, 6)
    assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', 'history-title-shortlist',
      ...Array.from({ length: referenceCount }, () => 'lm-title-rewrite'), ...(referenceCount > 1 ? ['history-title-select'] : []), 'history-title-packages'])
    const loaded = await (await app.request('/history-scripts/52/delivery')).json()
    assert.deepEqual(loaded.data, saved)
    assert.deepEqual(getHistoryDelivery(52), saved)
  })
}

for (const scenario of [
  { name: 'zero search results', referenceCount: 0, selectedIds: undefined, fallback: 'no_references' },
  { name: 'all short-listed sources unrelated to the article', referenceCount: 4, selectedIds: [], fallback: 'unrelated_references' },
]) {
  test(`${scenario.name} use one original title and save it without selection or quality-review calls`, async t => {
    const fixture = fixtures[1]!
    const searches = mockTitleSearch(t, () => false, scenario.referenceCount)
    const calls = mockPublishingProvider(t, { fixture, referenceCount: scenario.referenceCount, selectedIds: scenario.selectedIds })
    const body = await generateDesign(52)
    assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
    const saved = body.data
    assert.equal(saved.title, defaultTitles(fixture)[0])
    assert.equal(saved.coverDesign.main_title, saved.title)
    assert.equal(saved.description, fixture.description)
    assert.equal(saved.coverPlanStatus, 'selected')
    assert.deepEqual(saved.coverPlan.reviews, [])
    assert.equal(saved.coverPlan.title_fallback, scenario.fallback)
    assert.equal(saved.coverPlan.title_research.references.length, scenario.referenceCount)
    assert.equal(saved.coverPlan.title_rewrites, undefined)
    assert.equal(saved.coverPlan.selected_id, 'candidate-1')
    assert.equal(saved.coverPlan.candidates.length, 1)
    const candidate = saved.coverPlan.candidates[0]
    assert.equal(candidate.id, 'candidate-1')
    assert.equal(candidate.main_title, saved.title)
    assert.equal(candidate.video_title, saved.title)
    assert.equal(candidate.video_description, saved.description)
    assert.equal(candidate.reference_ids, undefined)
    assert.equal(candidate.reference_adaptation, undefined)
    assert.equal(searches.length, scenario.referenceCount ? 4 : 6)
    assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords',
      ...(scenario.referenceCount ? ['history-title-shortlist'] : []),
      'history-title-original', 'history-title-packages'])
    assert.equal(calls.some(call => call.purpose === 'lm-title-rewrite'), false)
    const loaded = await (await app.request('/history-scripts/52/delivery')).json()
    assert.deepEqual(loaded.data, saved)
    assert.deepEqual(getHistoryDelivery(52), saved)
  })
}

test('a 16-character rewritten title is saved without truncation in both shared short-title fields', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  const title = '司马家统一天下后为何自己打起来？'
  assert.equal(title.length, 16)
  const titles = [title, ...defaultTitles(fixture).slice(1)]
  mockPublishingProvider(t, { fixture, titles })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.title, title)
  assert.equal(body.data.coverDesign.main_title, title)
  assert.equal(body.data.coverPlan.title_rewrites.rewrites[0].title, title)
  assert.equal(getHistoryDelivery(52).coverPlanStatus, 'selected')
})

test('overlong generated platform titles complete, survive refresh with warnings and can be manually corrected', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  const title = '司马家好不容易结束三国统一天下 为何自家皇族却先把江山砸了？'
  const baijiahaoTitle = '八王之乱：西晋皇族为何在统一之后同室操戈 一场争权如何让到手的天下再度分裂并改变此后历史？'
  assert.ok(title.length > 25)
  assert.ok(baijiahaoTitle.length > 40)
  const titles = defaultTitles(fixture)
  titles[2] = title
  const calls = mockPublishingProvider(t, { fixture, titles,
    selection: selection => ({ ...selection, selected_id: 'candidate-3' }),
    candidates: candidates => candidates.map(candidate => ({ ...candidate, baijiahao_title: baijiahaoTitle })),
  })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.title, title)
  assert.equal(body.data.coverDesign.main_title, title)
  assert.equal(body.data.baijiahaoTitle, baijiahaoTitle)
  assert.equal(body.data.coverPlanStatus, 'selected')
  assert.equal(body.data.coverPlan.selected_id, 'candidate-3')
  assert.equal(body.data.coverPlan.title_rewrites.rewrites[2].title, title)
  assert.deepEqual(body.data.publishingWarnings, [
    `视频号短标题与封面主标题共${title.length}字，超过16字上限，请在发布前修改。`,
    `百家号标题共${baijiahaoTitle.length}字，超过40字上限，请在发布前修改。`,
  ])
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
  const refreshed = await (await app.request('/history-scripts/52/delivery')).json()
  assert.deepEqual(refreshed.data, body.data)
  const updated = await app.request('/history-scripts/52/delivery', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '八王之乱为何打散天下？', baijiahaoTitle: '八王之乱：西晋皇族为何把到手的天下打散？' }),
  })
  const corrected = await updated.json()
  assert.equal(updated.status, 200, JSON.stringify(corrected))
  assert.equal(corrected.data.coverDesign.main_title, corrected.data.title)
  assert.deepEqual(corrected.data.publishingWarnings, [])
  const reloaded = await (await app.request('/history-scripts/52/delivery')).json()
  assert.deepEqual(reloaded.data.publishingWarnings, [])
  assert.equal(reloaded.data.title, corrected.data.title)
})

test('a 17-character title rewrite completes with a warning instead of a second rewrite', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  saveHistoryDelivery(52, { title: '已经保存的标题', description: '已经保存的简介' })
  const title = '司马家统一天下后为何自己打起来？？'
  assert.equal(title.length, 17)
  const calls = mockPublishingProvider(t, { fixture, titles: [title, ...defaultTitles(fixture).slice(1)] })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.title, title)
  assert.equal(body.data.coverDesign.main_title, title)
  assert.deepEqual(body.data.publishingWarnings, ['视频号短标题与封面主标题共17字，超过16字上限，请在发布前修改。'])
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
})

test('the production route saves a 40-character Baijiahao title and an untruncated video description', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  const baijiahaoTitle = '八王之乱' + '晋'.repeat(35) + '？'
  const description = '八王之乱的过程与背景，需要把正文中的不同变化放在一起理解。'.repeat(160)
  assert.equal(baijiahaoTitle.length, 40)
  assert.ok(description.length > 4000)
  const calls = mockPublishingProvider(t, { fixture, candidates: candidates => candidates.map(candidate => ({
    ...candidate, baijiahao_title: baijiahaoTitle, video_description: description,
  })) })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.baijiahaoTitle, baijiahaoTitle)
  assert.equal(body.data.description, description)
  assert.equal(body.data.title, defaultTitles(fixture)[0])
  assert.equal(body.data.coverPlan.candidates.length, 1)
  assert.equal(body.data.coverPlan.candidates[0].baijiahao_title, baijiahaoTitle)
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
})

for (const invalid of [undefined, '', '   ', '🔥']) {
  test(`an incomplete Baijiahao title ${JSON.stringify(invalid)} preserves the prior platform package`, async t => {
    mockTitleSearch(t)
    const fixture = fixtures[1]!
    const previous = saveHistoryDelivery(52, { title: '旧短标题', baijiahaoTitle: '旧百家号标题：这段历史为何值得追问？', description: '旧视频号简介' })
    mockPublishingProvider(t, { fixture, candidates: candidates => candidates.map(candidate => ({
      ...candidate, baijiahao_title: invalid,
    })) })
    const body = await generateDesign(52)
    assert.equal(body.data.designStatus, 'failed')
    assertPreservedPackage(getHistoryDelivery(52), previous)
  })
}

test('a complete 41-character Baijiahao draft is saved once with a platform warning', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  const baijiahaoTitle = '晋'.repeat(40) + '？'
  const calls = mockPublishingProvider(t, { fixture, candidates: candidates => candidates.map(candidate => ({
    ...candidate, baijiahao_title: baijiahaoTitle,
  })) })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
  assert.equal(body.data.baijiahaoTitle, baijiahaoTitle)
  assert.deepEqual(body.data.publishingWarnings, ['百家号标题共41字，超过40字上限，请在发布前修改。'])
  assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
  assert.deepEqual(getHistoryDelivery(52).publishingWarnings, body.data.publishingWarnings)
})

for (const title of ['司马家把天下/自己砸了', '皇族\n为何先打起来？', '皇族\u200b为何先打起来？', '八王之乱🔥天下遭殃！']) {
  test(`a generated draft ${JSON.stringify(title)} preserves its symbols and restores editable warnings`, async t => {
    mockTitleSearch(t)
    const fixture = fixtures[1]!
    const baijiahaoTitle = '八王之乱！皇族争权为何让天下遭殃？'
    const calls = mockPublishingProvider(t, { fixture, titles: [title, ...defaultTitles(fixture).slice(1)],
      candidates: candidates => candidates.map(candidate => ({ ...candidate, baijiahao_title: baijiahaoTitle })),
    })
    const body = await generateDesign(52)
    assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
    assert.equal(body.data.title, title)
    assert.equal(body.data.coverDesign.main_title, title)
    assert.equal(body.data.baijiahaoTitle, baijiahaoTitle)
    assert.equal(body.data.coverPlan.title_rewrites.rewrites[0].title, title)
    assert.equal(body.data.publishingWarnings.length, 2)
    assert.ok(body.data.publishingWarnings.every((warning: string) => warning.includes('不支持')))
    assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', ...pipelinePurposes])
    assert.deepEqual((await (await app.request('/history-scripts/52/delivery')).json()).data, body.data)
  })
}

test('an invalid title shortlist cannot overwrite the saved package or reach the local writer', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  const previous = saveHistoryDelivery(52, { title: '已经保存的标题', description: '已经保存的简介' })
  const calls = mockPublishingProvider(t, { fixture, reply: input => input.purpose === 'history-title-shortlist'
    ? { selected: [{ reference_id: 'R99', reason: '虚构母题' }] }
    : undefined })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'failed')
  assert.ok(calls.some(call => call.purpose === 'history-title-shortlist'))
  assert.equal(calls.some(call => ['lm-title-rewrite', 'history-title-packages', 'history-title-review'].includes(call.purpose)), false)
  assertPreservedPackage(getHistoryDelivery(52), previous)
})

const localFailures: { name: string; reply: NonNullable<Parameters<typeof mockPublishingProvider>[1]>['localReply'] }[] = [
  { name: 'unavailable local service', reply: async () => { throw new TypeError('ECONNREFUSED private-local-token') } },
  { name: 'local HTTP failure', reply: () => new Response('private-local-token', { status: 503 }) },
  { name: 'empty local output', reply: () => localTitleReply('   ') },
  { name: 'nonstring final message content', reply: () => localTitleReply({ title: '司马家把天下自己砸了' }) },
  { name: 'truncated local output', reply: () => localTitleReply('司马家把天下自己砸了', 'length') },
]
for (const failure of localFailures) {
  test(`${failure.name} falls back to a complete original package without claiming a reference rewrite`, async t => {
    mockTitleSearch(t)
    const fixture = fixtures[1]!
    const calls = mockPublishingProvider(t, { fixture, localReply: failure.reply, fallback: 'rewrite_unavailable' })
    const body = await generateDesign(52)
    assert.equal(body.data.designStatus, 'completed', JSON.stringify(body))
    assert.equal(body.data.title, defaultTitles(fixture)[0])
    assert.equal(body.data.coverDesign.main_title, body.data.title)
    assert.equal(body.data.description, fixture.description)
    assert.equal(body.data.coverPlanStatus, 'selected')
    assert.equal(body.data.coverPlan.title_fallback, 'rewrite_unavailable')
    assert.equal(body.data.coverPlan.title_research.references.length, 4)
    assert.equal(body.data.coverPlan.title_rewrites, undefined)
    assert.equal(body.data.coverPlan.candidates[0].reference_ids, undefined)
    assert.equal(body.data.coverPlan.candidates[0].reference_adaptation, undefined)
    assert.doesNotMatch(JSON.stringify(body), /private-local-token/)
    assert.deepEqual(calls.map(call => call.purpose), ['history-title-keywords', 'history-title-shortlist',
      'lm-title-rewrite', 'history-title-original', 'history-title-packages'])
    assert.deepEqual(getHistoryDelivery(52), body.data)
  })
}

for (const changed of ['title', 'reference']) {
  test(`packaging cannot change a locked ${changed} and overwrite saved copy`, async t => {
    mockTitleSearch(t)
    const fixture = fixtures[1]!
    const previous = saveHistoryDelivery(52, { title: '已经保存的标题', description: '已经保存的简介' })
    const calls = mockPublishingProvider(t, { fixture, candidates: candidates => candidates.map((candidate, index) => index ? candidate : {
      ...candidate, ...(changed === 'title' ? { main_title: '包装阶段擅自换的标题', video_title: '包装阶段擅自换的标题' } : { reference_ids: ['R1'] }),
    }) })
    const body = await generateDesign(52)
    assert.equal(body.data.designStatus, 'failed')
    assert.match(body.data.designError, /不得修改已改写的锁定标题或更换原题/)
    assert.ok(calls.some(call => call.purpose === 'history-title-packages'))
    assert.equal(calls.some(call => call.purpose === 'history-title-review'), false)
    assertPreservedPackage(getHistoryDelivery(52), previous)
  })
}

test('a publishing edit made while curiosity selection runs cannot be overwritten by the generated package', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  saveHistoryDelivery(52, { title: '开始前保存的标题', description: '开始前保存的简介' })
  let concurrent: ReturnType<typeof saveHistoryDelivery> | undefined
  mockPublishingProvider(t, { fixture, onInput: input => {
    if (input.purpose === 'history-title-select') concurrent = saveHistoryDelivery(52, { title: '生成期间用户改的标题', description: '生成期间用户改的简介' })
  } })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'failed')
  assert.match(body.data.designError, /已修改/)
  assert.ok(concurrent)
  assertPreservedPackage(getHistoryDelivery(52), concurrent)
})

test('a Baijiahao-only edit while the selected package is written cannot be overwritten', async t => {
  mockTitleSearch(t)
  const fixture = fixtures[1]!
  saveHistoryDelivery(52, { title: '开始前保存的标题', baijiahaoTitle: '开始前保存的百家号标题', description: '开始前保存的简介' })
  let concurrent: ReturnType<typeof saveHistoryDelivery> | undefined
  mockPublishingProvider(t, { fixture, onInput: input => {
    if (input.purpose === 'history-title-packages') concurrent = saveHistoryDelivery(52, { baijiahaoTitle: '用户刚保存的百家号标题：天下为何守不住？' })
  } })
  const body = await generateDesign(52)
  assert.equal(body.data.designStatus, 'failed')
  assert.match(body.data.designError, /已修改/)
  assert.ok(concurrent)
  assertPreservedPackage(getHistoryDelivery(52), concurrent)
})
