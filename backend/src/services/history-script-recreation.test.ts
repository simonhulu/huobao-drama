import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryTranscriptReview } from './history-script-processing.js'
import type { HistoryRecreationPlan } from './history-script-recreation.js'

const environmentNames = ['DB_PATH', 'TASK_WORKER_DISABLED', 'SCIENCE_WRITER_API_URL', 'SCIENCE_WRITER_MODEL', 'SCIENCE_WRITER_MAX_TOKENS',
  'HISTORY_WRITER_ENABLE_THINKING', 'SCIENCE_WRITER_THINKING_BUDGET_TOKENS', 'HISTORY_WRITER_MAX_TOKENS', 'HISTORY_WRITER_THINKING_BUDGET_TOKENS']
const previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]))
const directory = mkdtempSync(join(tmpdir(), 'history-recreation-test-'))
const databasePath = join(directory, 'unused.db')
process.env.DB_PATH = databasePath
process.env.TASK_WORKER_DISABLED = '1'
const { recreateHistoryScript, condenseHistoryScript, historyScriptCharacters, HISTORY_SCRIPT_TARGET_CHARACTERS } = await import('./history-script-recreation.js')
const { SCIENCE_WRITING_MODEL } = await import('./science-writing-model.js')
const originalFetch = globalThis.fetch
const writerUrl = 'http://127.0.0.1:18788/v1/chat/completions'
after(() => {
  globalThis.fetch = originalFetch
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  rmSync(directory, { recursive: true, force: true })
})
beforeEach(() => {
  globalThis.fetch = originalFetch
  process.env.SCIENCE_WRITER_API_URL = 'http://127.0.0.1:18788'
  delete process.env.SCIENCE_WRITER_MODEL
  delete process.env.SCIENCE_WRITER_MAX_TOKENS
  delete process.env.HISTORY_WRITER_ENABLE_THINKING
  delete process.env.SCIENCE_WRITER_THINKING_BUDGET_TOKENS
  delete process.env.HISTORY_WRITER_MAX_TOKENS
  delete process.env.HISTORY_WRITER_THINKING_BUDGET_TOKENS
})

const reference = '古人说败北，为什么用了一个方向字？这个字被解释为与背对背的字形有关。具体词源仍需要查证。'
const script = '古人用败北表示失败，可为什么偏偏用了北这个方向字？有一种解释，把它和背对背的字形联系起来。不过具体的词源，还要继续查证。'
const review: HistoryTranscriptReview = { correctedTranscript: reference, corrections: [],
  factualConcerns: [{ claim: '北与背对背的字形有关', reason: '词源尚待查证', searchQuery: '北 字源' }], factCheckStatus: 'needs_sources' }
const output = `标题：败北为什么用了一个方向字？\n\n封面文字：败北的北是什么意思？\n\n口播正文：\n${script}`
const response = (content: unknown, finishReason: unknown = 'stop') => Response.json({ choices: [{ finish_reason: finishReason, message: { content } }] })
function writingInput(content: string) {
  if (content.startsWith('{')) return JSON.parse(content)
  const fragment = /^将以下片段缩写成(\d+)字左右，[^\n]*\n\n/.exec(content)
  if (fragment) return { referenceScript: content.slice(fragment[0].length), targetCharacters: Number(fragment[1]) }
  const start = content.indexOf('<referenceScript>\n') + '<referenceScript>\n'.length
  return { referenceScript: content.slice(start, content.lastIndexOf('\n</referenceScript>')),
    sourceTitle: /^原标题：(.*)$/m.exec(content)?.[1], sourceAuthor: /^来源作者：(.*)$/m.exec(content)?.[1] }
}

function fragmentDraft(index: number, target: number): string {
  const prefix = `第${index}片缩写：`
  return prefix + '琨'.repeat(Math.max(0, target - prefix.length - 1)) + '。'
}
function mockDraft(content: string) {
  let calls = 0
  globalThis.fetch = async url => {
    calls++
    assert.equal(String(url), writerUrl)
    return response(content)
  }
  return () => calls
}

test('the complete source goes directly to the remote writer without GPT configuration or planning', async () => {
  let calls = 0, system = ''
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(String(url), writerUrl)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, SCIENCE_WRITING_MODEL)
    assert.equal(body.temperature, .3)
    assert.equal(body.max_tokens, 40960)
    assert.equal(body.stream, false)
    assert.equal(body.response_format, undefined)
    assert.equal(body.tools, undefined)
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true })
    assert.equal(body.reasoning_budget_tokens, 8192)
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    assert.ok(init?.signal)
    assert.equal(body.messages.length, 2)
    system = body.messages[0].content
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[1].role, 'user')
    assert.deepEqual(JSON.parse(body.messages[1].content), {
      sourceTitle: '败北的词源', sourceAuthor: '史说小陈', referenceScript: reference,
    })
    assert.ok(system.includes('请将下面这段文本改写为更自然、更有人类写作风格的表达，要求句子间的逻辑更合理，更通俗，可读性更强，句子更通顺。保持原意不变。'))
    assert.doesNotMatch(system, /默认以十分钟|相反立场|三个.*角度|chosenAngle|writingOutline/)
    return response(script)
  }
  const result = await recreateHistoryScript(reference, review, { sourceTitle: '败北的词源', sourceAuthor: '史说小陈' })
  assert.equal(calls, 1)
  assert.equal(existsSync(databasePath), false, 'A writing-only request must not initialize the GPT configuration database')
  assert.equal(result.script, script)
  assert.equal(result.title, '败北的词源')
  assert.equal(result.coverText, '')
  assert.equal(result.skillName, 'history-source-paraphrase')
  assert.equal(result.skillRevision, 'history-source-paraphrase-v1')
  assert.equal(result.skillSha256, createHash('sha256').update(system).digest('hex'))
  assert.equal(result.model, SCIENCE_WRITING_MODEL)
  assert.equal(result.provider, 'remote-writer')
  for (const property of ['analysis', 'angles', 'selectedAngleId', 'selectionReason', 'writingOutline', 'plan', 'analysisModel', 'analysisProvider']) {
    assert.equal(property in result, false, `${property} must not describe a source-paraphrase result`)
  }
})

test('legacy perspective plans and factual concerns do not become writing instructions', async () => {
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(String(url), writerUrl)
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    assert.deepEqual(input, { referenceScript: reference })
    return response(script)
  }
  const result = await recreateHistoryScript(reference, review, {
    plan: { selectedAngleId: 'opposing', analysis: { coreViewpoint: 'Legacy angle must not be used' } } as HistoryRecreationPlan,
    onPlan() { assert.fail('No planning is performed for a full source paraphrase') },
  })
  assert.equal(calls, 1)
  assert.equal(result.script, script)
})

test('configured model and output budget are used and recorded by the remote writer', async () => {
  process.env.SCIENCE_WRITER_MODEL = 'configured-history-writer'
  process.env.HISTORY_WRITER_MAX_TOKENS = '6000'
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(String(url), writerUrl)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'configured-history-writer')
    assert.equal(body.max_tokens, 14192)
    return response(script)
  }
  const result = await recreateHistoryScript(reference, review)
  assert.equal(calls, 1)
  assert.equal(result.model, 'configured-history-writer')
})

test('private reasoning is never returned as narration or saved provenance', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: script, reasoning_content: 'private reasoning',
    } }] })
  }
  const result = await recreateHistoryScript(reference, review)
  assert.equal(calls, 1)
  assert.equal(result.script, script)
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|reasoning_content/)
})

test('history thinking can be disabled without reducing the prose token allowance', async () => {
  process.env.HISTORY_WRITER_ENABLE_THINKING = 'false'
  process.env.HISTORY_WRITER_THINKING_BUDGET_TOKENS = 'unused-invalid-value'
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
    assert.equal(body.reasoning_budget_tokens, 0)
    assert.equal(body.max_tokens, 32768)
    return response(script)
  }
  assert.equal((await recreateHistoryScript(reference, review)).script, script)
  assert.equal(calls, 1)
})

test('configured thinking budgets reserve tokens separately from the full prose allowance', async () => {
  for (const budget of [1, 512, 8192]) {
    process.env.HISTORY_WRITER_THINKING_BUDGET_TOKENS = String(budget)
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.reasoning_budget_tokens, budget)
      assert.equal(body.max_tokens, 32768 + budget)
      return response(script)
    }
    assert.equal((await recreateHistoryScript(reference, review)).script, script)
    assert.equal(calls, 1)
  }
})

test('invalid enabled-thinking configuration fails before a remote request', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return response(script) }
  for (const value of ['yes', '1', 'FALSE']) {
    process.env.HISTORY_WRITER_ENABLE_THINKING = value
    await assert.rejects(recreateHistoryScript(reference, review), /HISTORY_WRITER_ENABLE_THINKING/)
  }
  process.env.HISTORY_WRITER_ENABLE_THINKING = 'true'
  for (const value of ['0', '-1', '1.5', '8193', 'invalid']) {
    process.env.HISTORY_WRITER_THINKING_BUDGET_TOKENS = value
    await assert.rejects(recreateHistoryScript(reference, review), /HISTORY_WRITER_THINKING_BUDGET_TOKENS/)
  }
  assert.equal(calls, 0)
})

test('history budgets are independent of science output and thinking settings', async () => {
  for (const [scienceMaximum, scienceThinking] of [['1000', '1'], ['invalid', 'invalid']]) {
    process.env.SCIENCE_WRITER_MAX_TOKENS = scienceMaximum
    process.env.SCIENCE_WRITER_THINKING_BUDGET_TOKENS = scienceThinking
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.max_tokens, 40960)
      assert.equal(body.reasoning_budget_tokens, 8192)
      return response(script)
    }
    assert.equal((await recreateHistoryScript(reference, review)).script, script)
    assert.equal(calls, 1)
  }
})

test('the full configured history prose budget reaches the API including the 65536-token maximum', async () => {
  for (const maximum of [1, 32768, 65536]) {
    process.env.HISTORY_WRITER_MAX_TOKENS = String(maximum)
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(body.max_tokens, maximum + 8192)
      assert.equal(body.reasoning_budget_tokens, 8192)
      return response(script)
    }
    assert.equal((await recreateHistoryScript(reference, review)).script, script)
    assert.equal(calls, 1)
  }
})

test('invalid independent history prose budgets fail before transmitting source text', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return response(script) }
  for (const maximum of ['0', '-1', '1.5', '65537', 'invalid']) {
    process.env.HISTORY_WRITER_MAX_TOKENS = maximum
    await assert.rejects(recreateHistoryScript(reference, review), /HISTORY_WRITER_MAX_TOKENS/)
  }
  assert.equal(calls, 0)
})

for (const characters of [21530, 22186]) {
  test(`a ${characters}-character manuscript is fully covered by ordered fragments without reducing the output budget`, async () => {
    const opening = `历史长稿${characters}字开头。`
    const ending = `历史长稿${characters}字末尾。`
    const source = opening + reference.repeat(Math.ceil(characters / reference.length))
      .slice(0, characters - opening.length - ending.length) + ending
    assert.equal(source.length, characters)
    let calls = 0, system = ''
    const inputs: string[] = [], targets: number[] = [], outputs: string[] = []
    globalThis.fetch = async (url, init) => {
      calls++
      assert.equal(String(url), writerUrl)
      const body = JSON.parse(String(init?.body))
      system = body.messages[0].content
      assert.match(system, /缩写/)
      assert.match(system, /连续片段/)
      assert.doesNotMatch(system, /不主动缩写/)
      assert.doesNotMatch(system, /4000-4500|15.*分钟/)
      const input = writingInput(body.messages[1].content)
      inputs.push(input.referenceScript)
      targets.push(input.targetCharacters)
      assert.ok(historyScriptCharacters(input.referenceScript) > 0)
      assert.ok(historyScriptCharacters(input.referenceScript) <= 3500)
      assert.match(body.messages[1].content, /缩写/)
      assert.equal(body.max_tokens, 40960)
      assert.equal(body.reasoning_budget_tokens, 8192)
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true })
      const localLength = characters === 21530 && calls === 1 ? input.targetCharacters * 2 + 80 : input.targetCharacters
      const condensed = fragmentDraft(calls, localLength)
      outputs.push(condensed)
      return response(condensed)
    }
    const result = await recreateHistoryScript(source, { ...review, correctedTranscript: source })
    assert.equal(inputs.join(''), source)
    assert.equal(targets.reduce((sum, target) => sum + target, 0), 4300)
    for (let index = 0; index < targets.length - 1; index++) {
      assert.equal(targets[index], Math.round(historyScriptCharacters(inputs[index]) / characters * 4300))
    }
    assert.equal(result.script, outputs.join('\n\n'))
    assert.equal(historyScriptCharacters(result.script), 4300 + (characters === 21530 ? targets[0] + 80 : 0))
    assert.ok(historyScriptCharacters(result.script) <= 5400)
    assert.equal(result.skillRevision, 'history-source-condensed-v1')
    assert.equal(result.skillSha256, createHash('sha256').update(system).digest('hex'))
    assert.ok(calls >= 6)
    assert.equal(calls, inputs.length)
  })
}

test('paragraph fragmentation preserves Unicode, whitespace and paragraph boundaries while requests run serially', async () => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `第${index + 1}段𠮷　${'刘琨守城。'.repeat(65)}\t段尾。\n\n`)
  const source = paragraphs.join('')
  const paragraphEnds = new Set<number>()
  let end = 0
  for (const paragraph of paragraphs) { end += paragraph.length; paragraphEnds.add(end) }
  const fragments: string[] = [], outputs: string[] = [], targets: number[] = []
  let active = 0, peak = 0
  globalThis.fetch = async (_url, init) => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>(resolve => setImmediate(resolve))
    const body = JSON.parse(String(init?.body))
    const input = writingInput(body.messages[1].content)
    fragments.push(input.referenceScript)
    targets.push(input.targetCharacters)
    const output = fragmentDraft(fragments.length, input.targetCharacters)
    outputs.push(output)
    active--
    return response(output)
  }
  const result = await condenseHistoryScript(source, { sourceTitle: '连续历史正文' })
  assert.equal(fragments.join(''), source)
  assert.ok(fragments.length > 1)
  end = 0
  for (const fragment of fragments) {
    end += fragment.length
    assert.ok(paragraphEnds.has(end), 'An ordinary paragraph must not be split')
    assert.ok(historyScriptCharacters(fragment) <= 3500)
    assert.doesNotMatch(fragment, /\uFFFD/)
  }
  assert.equal(peak, 1)
  assert.equal(targets.reduce((sum, target) => sum + target, 0), 4300)
  assert.equal(result.title, '连续历史正文')
  assert.equal(result.script, outputs.join('\n\n'))
})

test('canceling a later fragment discards partial results and prevents subsequent requests', async () => {
  const source = reference.repeat(400)
  const controller = new AbortController()
  let calls = 0
  globalThis.fetch = async () => {
    if (++calls === 2) controller.abort(Error('operator stopped'))
    return response(script)
  }
  await assert.rejects(condenseHistoryScript(source, { signal: controller.signal }), /operator stopped/)
  assert.equal(calls, 2)
})

for (const failure of ['length', 'copy', 'oversized', 'network']) {
  test(`a ${failure} failure in the second fragment prevents a partial manuscript or further requests`, async () => {
    const source = reference.repeat(400)
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      if (calls === 1) return response(script)
      const input = writingInput(JSON.parse(String(init?.body)).messages[1].content)
      if (failure === 'network') throw Error('unknown fragment outcome')
      if (failure === 'length') return response(script, 'length')
      if (failure === 'copy') return response(input.referenceScript)
      return response('琨'.repeat(input.targetCharacters * 2 + 81))
    }
    await assert.rejects(condenseHistoryScript(source), /输出被截断或未正常完成|与原文相同|片段缩写|unknown fragment outcome/)
    assert.equal(calls, 2)
  })
}

test('combined fragment drafts above the overall fifteen-minute tolerance are rejected after complete processing', async () => {
  const source = reference.repeat(400)
  let calls = 0
  const fragments: string[] = []
  globalThis.fetch = async (_url, init) => {
    calls++
    const input = writingInput(JSON.parse(String(init?.body)).messages[1].content)
    fragments.push(input.referenceScript)
    return response(fragmentDraft(calls, Math.floor(input.targetCharacters * 1.3 + 79)))
  }
  await assert.rejects(condenseHistoryScript(source), /明显超出约15分钟/)
  assert.equal(fragments.join(''), source)
  assert.ok(calls > 1)
})

test('history character counting uses Unicode code points and excludes whitespace', () => {
  assert.equal(HISTORY_SCRIPT_TARGET_CHARACTERS, 4500)
  assert.equal(historyScriptCharacters(' 刘\t琨\n𠮷\r\n守城　。 '), 6)
  assert.equal(historyScriptCharacters(' \t\r\n　'), 0)
})

test('condensing a source at or below 4500 characters preserves it without any remote call', async () => {
  globalThis.fetch = async () => { assert.fail('A source at the target needs no condensation') }
  for (const source of [reference, ` \n${'𠮷'.repeat(4500)}\n `]) {
    const result = await condenseHistoryScript(source, { sourceTitle: '已有短稿' })
    assert.equal(result.script, source)
    assert.equal(result.title, '已有短稿')
    assert.notEqual(result.provider, 'remote-writer')
  }
})

test('recreation starts semantic condensation only above the 4500-character threshold', async () => {
  for (const characters of [4500, 4501]) {
    const source = '刘'.repeat(characters)
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.equal(writingInput(body.messages[1].content).referenceScript, source)
      if (characters === 4500) assert.doesNotMatch(body.messages[0].content, /4000-4500/)
      else assert.match(body.messages[0].content, /4000-4500/)
      return response(script)
    }
    const result = await recreateHistoryScript(source, { ...review, correctedTranscript: source })
    assert.equal(result.skillRevision, characters === 4500 ? 'history-source-paraphrase-v1' : 'history-source-condensed-v1')
    assert.equal(calls, 1)
  }
})

test('a short source whose rewritten draft exceeds the target is condensed once in full', async () => {
  const draft = '刘琨守城，粮援不足。'.repeat(510)
  const condensed = '刘琨守城，粮援不足。'.repeat(410)
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    const input = writingInput(body.messages[1].content)
    assert.equal(input.sourceTitle, '守城')
    assert.equal(input.sourceAuthor, '原作者')
    if (calls === 1) {
      assert.equal(input.referenceScript, reference)
      assert.doesNotMatch(body.messages[0].content, /4000-4500/)
      return response(draft)
    }
    assert.equal(input.referenceScript, draft)
    assert.match(body.messages[0].content, /4000-4500/)
    return response(condensed)
  }
  const result = await recreateHistoryScript(reference, review, { sourceTitle: '守城', sourceAuthor: '原作者' })
  assert.equal(result.script, condensed)
  assert.equal(result.skillRevision, 'history-source-condensed-v1')
  assert.equal(calls, 2)
})

test('a complete condensed draft slightly above 4500 characters is kept without truncation or another request', async () => {
  const source = '刘琨坚守晋阳。'.repeat(1000)
  const condensed = `${'刘'.repeat(4510)}。`
  const calls = mockDraft(condensed)
  const result = await recreateHistoryScript(source, { ...review, correctedTranscript: source })
  assert.equal(result.script, condensed)
  assert.equal(result.skillRevision, 'history-source-condensed-v1')
  assert.equal(calls(), 1)
})

test('semantic condensation must shorten the source and cannot use a differently worded expansion', async () => {
  const source = '刘'.repeat(4501)
  for (const draft of ['琨'.repeat(4501), '琨'.repeat(4600)]) {
    const calls = mockDraft(draft)
    await assert.rejects(condenseHistoryScript(source), /缩短|缩写/)
    assert.equal(calls(), 1)
  }
})

test('a nominally shorter manuscript that still greatly exceeds fifteen minutes is not accepted as condensed', async () => {
  const calls = mockDraft('琨'.repeat(6000))
  await assert.rejects(condenseHistoryScript('刘'.repeat(7000)), /仍有6000字.*15分钟/)
  assert.equal(calls(), 1)
})

test('condensation retains reasoning isolation and rejects truncated or canceled generations', async () => {
  const source = '刘'.repeat(4501)
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: script, reasoning_content: 'private reasoning' } }] })
  }
  const result = await condenseHistoryScript(source)
  assert.equal(result.script, script)
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|reasoning_content/)
  assert.equal(calls, 1)
  globalThis.fetch = async () => { calls++; return response(script, 'length') }
  await assert.rejects(condenseHistoryScript(source), /输出被截断或未正常完成/)
  assert.equal(calls, 2)
  const controller = new AbortController()
  globalThis.fetch = async () => { calls++; controller.abort(Error('operator stopped')); return response(script) }
  await assert.rejects(condenseHistoryScript(source, { signal: controller.signal }), /operator stopped/)
  assert.equal(calls, 3)
})

test('invalid or pre-canceled condensation input never requests the remote writer', async () => {
  globalThis.fetch = async () => { assert.fail('No request should be made') }
  await assert.rejects(condenseHistoryScript(' \n '), /完整|空/)
  const controller = new AbortController()
  controller.abort(Error('operator stopped'))
  await assert.rejects(condenseHistoryScript(reference, { signal: controller.signal }), /operator stopped/)
})

test('truncation diagnostics show request budgets and usage without exposing source or reasoning', async () => {
  let calls = 0
  const source = 'private-source-text'
  globalThis.fetch = async () => {
    calls++
    return Response.json({
      choices: [{ finish_reason: 'length', message: { content: 'private-partial-draft', reasoning_content: 'private-reasoning-text' } }],
      usage: { prompt_tokens: 23456, completion_tokens: 31877, total_tokens: 55333,
        completion_tokens_details: { reasoning_tokens: 8192 } },
    })
  }
  await assert.rejects(recreateHistoryScript(source, { ...review, correctedTranscript: source }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /输出被截断或未正常完成/)
    for (const diagnostic of ['40960', '32768', '8192', '31877']) assert.ok(error.message.includes(diagnostic), `Missing budget or usage ${diagnostic}`)
    assert.doesNotMatch(error.message, /private-source-text|private-partial-draft|private-reasoning-text/)
    return true
  })
  assert.equal(calls, 1)
})

test('reasoning-only responses cannot become manuscripts even if the service reports stop', async () => {
  for (const finishReason of ['length', 'stop']) {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return Response.json({ choices: [{ finish_reason: finishReason, message: {
        content: null, reasoning_content: 'private reasoning',
      } }] })
    }
    await assert.rejects(recreateHistoryScript(reference, review), /输出被截断或未正常完成|没有返回正文/)
    assert.equal(calls, 1)
  }
})

test('the original source is transmitted in full without hidden shortening', async () => {
  const longReference = `${reference}\n`.repeat(500)
  let calls = 0
  const fragments: string[] = []
  globalThis.fetch = async (_url, init) => {
    calls++
    const input = writingInput(JSON.parse(String(init?.body)).messages[1].content)
    fragments.push(input.referenceScript)
    return response(script)
  }
  await recreateHistoryScript(longReference, { ...review, correctedTranscript: longReference })
  assert.equal(fragments.join(''), longReference)
  assert.ok(calls > 1)
})

test('HTTP 429 retries only definite refusals and stops after three attempts', async () => {
  let calls = 0
  globalThis.fetch = async url => {
    assert.equal(String(url), writerUrl)
    calls++
    return calls < 3 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } }) : response(script)
  }
  assert.equal((await recreateHistoryScript(reference, review)).script, script)
  assert.equal(calls, 3)
  calls = 0
  globalThis.fetch = async url => {
    assert.equal(String(url), writerUrl)
    calls++
    return new Response('busy', { status: 429, headers: { 'retry-after': '0' } })
  }
  await assert.rejects(recreateHistoryScript(reference, review), /429/)
  assert.equal(calls, 3)
})

test('long rate-limit waits are not silently scheduled', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('busy', { status: 429, headers: { 'retry-after': '61' } })
  }
  await assert.rejects(recreateHistoryScript(reference, review), /429/)
  assert.equal(calls, 1)
})

test('unknown network outcomes and other HTTP errors never resubmit or fall back to GPT', async () => {
  for (const status of [400, 401, 500, 503, null]) {
    let calls = 0
    globalThis.fetch = async url => {
      calls++
      assert.equal(String(url), writerUrl)
      if (status === null) throw Error('unknown remote outcome')
      return new Response('remote error', { status })
    }
    await assert.rejects(recreateHistoryScript(reference, review), /拒绝请求|401|500|503|unknown remote outcome/)
    assert.equal(calls, 1)
  }
})

test('cancellation during rate-limit waiting prevents another generation', async () => {
  let calls = 0
  const controller = new AbortController()
  globalThis.fetch = async () => {
    calls++
    setTimeout(() => controller.abort(Error('operator stopped')), 10)
    return new Response('busy', { status: 429, headers: { 'retry-after': '30' } })
  }
  await assert.rejects(recreateHistoryScript(reference, review, { signal: controller.signal }), /operator stopped|abort/i)
  assert.equal(calls, 1)
})

test('truncated or filtered remote outputs are rejected without silent retries', async () => {
  for (const finish of ['length', 'content_filter', null]) {
    let calls = 0
    globalThis.fetch = async () => { calls++; return response(script, finish) }
    await assert.rejects(recreateHistoryScript(reference, review), /输出被截断或未正常完成/)
    assert.equal(calls, 1)
  }
})

test('responses without usable narration are rejected in one remote call', async () => {
  for (const content of ['把完整参考稿发我。', '   ', '标题：有标题\n封面文字：有封面\n口播正文：',
    '标题：有标题\n封面文字：只有附属文字', '<think>只有分析</think>', '<think>未完成的分析',
    JSON.stringify({ title: '只有标题', coverText: '没有正文' })]) {
    const calls = mockDraft(content)
    await assert.rejects(recreateHistoryScript(reference, review), /二创|没有返回正文/)
    assert.equal(calls(), 1)
  }
})

test('legacy body formatting is normalized without contaminating narration or repair calls', async () => {
  const cases = [
    { content: script, title: '来源标题', coverText: '' },
    { content: `口播正文：${script}`, title: '来源标题', coverText: '' },
    { content: `标题：\n封面文字：\n口播正文：${script}`, title: '来源标题', coverText: '' },
    { content: `标题：第一行\n第二行\n封面文字：第一行\n第二行\n口播正文：${script}`, title: '第一行 第二行', coverText: '第一行 第二行' },
    { content: `收到。\n${output}`, title: '败北为什么用了一个方向字？', coverText: '败北的北是什么意思？' },
    { content: `\uFEFF### 标题: 题目\r\n**封面文字：** 第一行\r\n第二行\r\n### 口播正文\r\n${script}`, title: '题目', coverText: '第一行 第二行' },
    { content: `\x60\x60\x60text\n${output}\n\x60\x60\x60`, title: '败北为什么用了一个方向字？', coverText: '败北的北是什么意思？' },
    { content: `<think>先分析材料</think>\n${script}`, title: '来源标题', coverText: '' },
    { content: JSON.stringify({ script, title: '标题\n建议', coverText: '封面\n建议' }), title: '标题 建议', coverText: '封面 建议' },
    { content: `标题：\n败北的来历\n\n封面文字：\n败北与北方有关吗？\n\n口播正文：\n${script}`, title: '败北的来历', coverText: '败北与北方有关吗？' },
  ]
  for (const { content, title, coverText } of cases) {
    const calls = mockDraft(content)
    const result = await recreateHistoryScript(reference, review, { sourceTitle: '来源标题' })
    assert.equal(result.script, script)
    assert.equal(result.title, title)
    assert.equal(result.coverText, coverText)
    assert.equal(calls(), 1)
  }
})

test('output length is preserved without a fixed minimum or source ratio', async () => {
  const longReference = reference.repeat(12)
  for (const body of [script, script.repeat(40)]) {
    const calls = mockDraft(body)
    const result = await recreateHistoryScript(longReference, { ...review, correctedTranscript: longReference })
    assert.equal(result.script, body)
    assert.equal('lengthCheck' in result, false)
    assert.equal(calls(), 1)
  }
})

test('unchanged source copies and punctuation-only changes are rejected', async () => {
  for (const body of [reference, reference.replace(/。/g, '！\n')]) {
    const calls = mockDraft(body)
    await assert.rejects(recreateHistoryScript(reference, review), /与原文相同/)
    assert.equal(calls(), 1)
  }
})

test('invalid input and pre-aborted calls do not request the model', async () => {
  globalThis.fetch = async () => { assert.fail('No model call should be made') }
  await assert.rejects(recreateHistoryScript('', review), /完整且匹配/)
  await assert.rejects(recreateHistoryScript('a different source', review), /完整且匹配/)
  const controller = new AbortController()
  controller.abort(Error('operator stopped'))
  await assert.rejects(recreateHistoryScript(reference, review, { signal: controller.signal }), /operator stopped/)
})

test('a response arriving after cancellation is discarded', async () => {
  let calls = 0
  const controller = new AbortController()
  globalThis.fetch = async () => {
    calls++
    controller.abort(Error('operator stopped'))
    return response(script)
  }
  await assert.rejects(recreateHistoryScript(reference, review, { signal: controller.signal }), /operator stopped/)
  assert.equal(calls, 1)
})
