import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { articleTypography, renderHistoryArticle } from './history-script-article-renderer.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-article-test-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource, getHistorySource } = await import('./history-script-library.js')
const { startHistoryArticle, getHistoryArticle, exportHistoryArticle, validateHistoryArticleSelection, extractHistoryArticleFrames, rewriteHistoryArticle, cleanHistoryArticleTitle, splitHistoryArticleParagraphs } = await import('./history-script-article.js')
const { getHistoryProductionGate } = await import('./history-production-gate.js')
const exec = promisify(execFile)
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const sentences = ['明朝冬季的蔬菜供应有限。', '因为运输困难，城里鲜菜可能更贵。', '但这不表示所有地区的价格相同。', '所以比较价格时，需要说明时间和地点。']
const corrected = sentences.join('')
const modelSelection = { sections: [
  { heading: '蔬菜供应有限', paragraphs: [{ quotes: [sentences[0], sentences[1]], highlights: ['蔬菜供应有限', '运输困难'] }] },
  { heading: '比较价格', paragraphs: [{ quotes: [sentences[2], sentences[3]], highlights: ['比较价格', '时间和地点'] }] },
] }
const caller = async (_messages: Array<{ role: string; content: string }> = []) => JSON.stringify(modelSelection)

beforeEach(() => {
  db.$client.prepare('DELETE FROM history_script_deliveries').run()
  db.delete(schema.historyScriptSources).run()
})
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })

function seed() {
  const source = storeHistorySource({ sourceVideoId: '7395681234567890123', title: '明朝冬季的菜价', category: 'historical_commentary', authorName: '原视频作者', metrics: {}, selection: { reason: 'test', observedAt: '2026-10-14T08:00:00Z', comments: [] } })
  current(source.id)
  const directory = path.join(root, 'history-deliveries', String(source.id))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'abc-123.mp4'), 'associated produced video')
  db.$client.prepare('INSERT INTO history_script_deliveries(script_id,video_path,script_sha256,updated_at) VALUES(?,?,?,?)')
    .run(source.id, `static/history-deliveries/${source.id}/abc-123.mp4`, hash('改写稿不作为公众号正文来源。'), new Date().toISOString())
  return source.id
}

function current(id: number, text = corrected) {
  updateHistorySource(id, {
    status: 'needs_review', rawTranscript: text, correctedTranscript: text, rewrittenScript: '改写稿不作为公众号正文来源。',
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ correctedTranscript: text, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(text), correctedTranscriptSha256: hash(text), rewriteInputSha256: hash(text) }),
  })
}

const extract: typeof extractHistoryArticleFrames = async (_video, directory, baseUrl, sections) => {
  fs.mkdirSync(directory)
  return [1, 2, 3].map((index) => {
    fs.writeFileSync(path.join(directory, `frame-${index}.jpg`), Buffer.from([0xff, 0xd8, index, 0xff, 0xd9]))
    return { url: `${baseUrl}/frame-${index}.jpg`, timestamp: index * 3, sectionIndex: Math.min(index - 1, sections.length - 1) }
  })
}
// These extract fixtures are intentionally not decodable JPEGs. Image selection
// is tested through the real CLI separately; generation still persists its proof.
const prepareImages: typeof import('./history-article-images.js').prepareHistoryArticleImages = async (directory, screenshots, signal) => {
  signal?.throwIfAborted()
  const manifest = { version: 1 as const, images: screenshots.slice(0, 2).map(image => ({
    url: image.url, sha256: hash(fs.readFileSync(path.join(directory, path.basename(image.url)))), quality: { score: 1 },
  })) }
  fs.writeFileSync(path.join(directory, 'body-cover-selection.json'), JSON.stringify(manifest))
  return manifest
}
const options = { root, caller, extract, prepareImages, diagnosticsRoot: path.join(root, 'private-diagnostics') }
async function completed(id: number, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = getHistoryArticle(id, { root })
    if (state.status !== 'generating') return state
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Article job did not settle')
}

test('manual article waits for a project slot, renews its lock and starts its execution deadline only after admission', async t => {
  const id = seed()
  const gate = getHistoryProductionGate(db.$client)
  gate.tryAcquire(900001, 'test:article-blocker-1'); gate.tryAcquire(900002, 'test:article-blocker-2')
  t.after(async () => { gate.release('test:article-blocker-1'); gate.release('test:article-blocker-2'); await completed(id, 600) })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const timeout = AbortSignal.timeout
  const deadlines: number[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { deadlines.push(milliseconds); return timeout(milliseconds) })
  let calls = 0
  startHistoryArticle(id, {}, { ...options, caller: async () => { calls++; return caller() } })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 0, 'Manual entry must also wait for a project slot')
  assert.equal(deadlines.includes(10 * 60_000), false, 'Waiting must not consume the execution deadline')
  t.mock.timers.tick(13 * 60_000)
  const directory = path.join(root, 'history-articles', String(id))
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'article.json'), 'utf8'))
  assert.ok(state.leaseUntil > Date.now(), 'The waiting generation lease must stay current')
  assert.ok(Date.now() - fs.statSync(path.join(directory, 'generation.lock')).mtimeMs < 60_000)
  assert.equal(getHistoryArticle(id, { root }).status, 'generating')
  assert.throws(() => startHistoryArticle(id, {}, options), /正在生成/)
  gate.release('test:article-blocker-1')
  assert.equal((await completed(id, 600)).status, 'completed')
  assert.equal(calls, 1)
  assert.equal(deadlines.filter(value => value === 10 * 60_000).length, 1)
  assert.equal(gate.isActive(id), false)
})

test('article admission rechecks source provenance and run ownership before any model call', async t => {
  for (const change of ['provenance', 'run'] as const) await t.test(change, async child => {
    const id = seed()
    const gate = getHistoryProductionGate(db.$client)
    gate.tryAcquire(900001, 'test:article-blocker-1'); gate.tryAcquire(900002, 'test:article-blocker-2')
    child.after(async () => { gate.release('test:article-blocker-1'); gate.release('test:article-blocker-2'); await completed(id, 600) })
    let calls = 0
    startHistoryArticle(id, {}, { ...options, caller: async () => { calls++; return caller() } })
    const directory = path.join(root, 'history-articles', String(id))
    const filename = path.join(directory, 'article.json')
    if (change === 'provenance') current(id, corrected + '历史材料还需要结合具体地区判断。')
    else {
      const state = JSON.parse(fs.readFileSync(filename, 'utf8'))
      fs.writeFileSync(filename, JSON.stringify({ ...state, status: 'failed', runId: 'replacement-run', leaseUntil: null, error: 'replacement state' }))
      fs.writeFileSync(path.join(directory, 'generation.lock'), 'replacement-run')
    }
    gate.release('test:article-blocker-1')
    // The gate polls once a second; wait for the original work reservation to release.
    for (let attempt = 0; attempt < 600 && gate.overview().waitingProjects; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    const result = await completed(id, 600)
    assert.equal(result.status, 'failed')
    assert.equal(calls, 0)
    assert.equal(gate.isActive(id), false)
    if (change === 'provenance') assert.match(result.error!, /原文或成片已变化/)
    else {
      assert.equal(result.error, 'replacement state')
      assert.equal(fs.readFileSync(path.join(directory, 'generation.lock'), 'utf8'), 'replacement-run')
      fs.rmSync(path.join(directory, 'generation.lock'))
    }
  })
})

test('legacy excerpt output preserves source facts and renders an article with actual frames', async () => {
  const id = seed()
  const before = getHistorySource(id)
  let suppliedText = ''
  let modelCalls = 0
  const started = startHistoryArticle(id, {}, { ...options, caller: async (messages, settings) => {
    modelCalls++
    assert.equal(modelCalls, 1, 'Generation must not call an independent reviewer')
    suppliedText = JSON.parse(messages[1].content).correctedTranscript
    assert.equal(settings?.requireComplete, true)
    assert.ok(settings?.signal)
    return caller(messages)
  } })
  assert.equal(started.status, 'generating')
  assert.equal(started.canGenerate, false)
  const state = await completed(id)
  assert.equal(state.status, 'completed', state.error || '')
  assert.equal(state.stale, false)
  assert.equal(modelCalls, 1)
  assert.equal('semanticReview' in state.article!, false)
  assert.ok(state.article!.notices.every(notice => !notice.includes('已通过')))
  assert.equal(suppliedText, corrected)
  assert.deepEqual(getHistorySource(id), before)
  assert.equal(state.article?.articleLength, state.article?.sourceLength)
  assert.ok(state.article!.markdown.includes('可能更贵'))
  assert.ok(state.article!.markdown.includes('但这不表示'))
  assert.doesNotMatch(state.article!.html + state.article!.markdown, /素材来源：|署名：|原视频作者|历史阅读记录/)
  assert.ok(!state.article!.html.includes('改写稿不作为'))
  assert.equal(state.article!.screenshots.length, 3)
  for (const image of state.article!.screenshots) assert.ok(fs.existsSync(path.join(root, image.url.slice('/static/'.length))))
  const html = exportHistoryArticle(id, 'html', { root })
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 3)
  assert.ok(!html.includes('src="/static/'))
  assert.ok(html.startsWith('<section'))
})

test('generation waits for prepared images and persists the selection before completing', async () => {
  const id = seed()
  let finish!: () => void
  let entered!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const preparing = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  let selectedDirectory = ''
  startHistoryArticle(id, {}, { ...options, prepareImages: async (directory, screenshots, signal) => {
    calls++
    selectedDirectory = directory
    assert.equal(screenshots.length, 3)
    assert.ok(signal instanceof AbortSignal)
    for (const image of screenshots) assert.ok(fs.existsSync(path.join(directory, path.basename(image.url))))
    entered()
    await pending
    return prepareImages(directory, screenshots, signal)
  } })
  try {
    await Promise.race([preparing, new Promise((_, reject) => setTimeout(() => reject(new Error('Image preparation was never called')), 200))])
    assert.equal(getHistoryArticle(id, { root }).status, 'generating')
    assert.equal(getHistoryArticle(id, { root }).article, null)
    assert.ok(!fs.existsSync(path.join(selectedDirectory, 'body-cover-selection.json')))
  } finally { finish() }
  const result = await completed(id)
  assert.equal(result.status, 'completed', result.error || '')
  assert.equal(calls, 1)
  const manifest = JSON.parse(fs.readFileSync(path.join(selectedDirectory, 'body-cover-selection.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.images.length, 2)
  for (const image of manifest.images) {
    assert.ok(result.article!.html.includes(`src="${image.url}"`))
    assert.equal(image.sha256, hash(fs.readFileSync(path.join(selectedDirectory, path.basename(image.url)))))
  }
})

test('image preparation failures identify the screenshot stage and preserve the previous article and selection', async () => {
  const id = seed()
  startHistoryArticle(id, {}, options)
  const previous = (await completed(id)).article!
  const oldDirectory = path.dirname(path.join(root, previous.screenshots[0].url.slice('/static/'.length)))
  const oldSelection = fs.readFileSync(path.join(oldDirectory, 'body-cover-selection.json'), 'utf8')
  startHistoryArticle(id, {}, { ...options, prepareImages: async () => {
    throw new Error('正文配图不足：需要 2 张，找到 1 张，缺少 1 张')
  } })
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /文章配图准备失败.*需要 2 张，找到 1 张/)
  assert.equal(failed.diagnostics?.stage, 'screenshot_preparation')
  assert.deepEqual(failed.article, previous)
  assert.equal(fs.readFileSync(path.join(oldDirectory, 'body-cover-selection.json'), 'utf8'), oldSelection)
  assert.equal(failed.canGenerate, true)
})

test('saved articles omit legacy footers on preview and both exports without regenerating or rewriting storage', async () => {
  const id = seed()
  startHistoryArticle(id, {}, options)
  await completed(id)
  const filename = path.join(root, 'history-articles', String(id), 'article.json')
  const stored = JSON.parse(fs.readFileSync(filename, 'utf8'))
  const footer = '素材来源：原视频作者；https://www.douyin.com/video/123\n\n署名：疤哥职场\n\n我是疤哥，分享职场沟通与成长。'
  stored.article.html += `<section>${footer}</section>`
  stored.article.markdown += `\n\n---\n\n${footer}`
  stored.article.notices.push('红白色系排版；来源信息与作者署名单列，不添加互动口号。', '作者署名尚未配置，请替换文末的作者名与简介占位。')
  fs.writeFileSync(filename, JSON.stringify(stored))
  const before = fs.readFileSync(filename, 'utf8')
  const state = getHistoryArticle(id, { root })
  assert.equal(state.status, 'completed')
  assert.equal(state.stale, false)
  assert.equal(state.article!.generatedAt, stored.article.generatedAt)
  assert.deepEqual(state.article!.sections, stored.article.sections)
  assert.deepEqual(state.article!.screenshots, stored.article.screenshots)
  assert.deepEqual(state.article!.provenance, stored.article.provenance)
  for (const output of [state.article!.html, state.article!.markdown, exportHistoryArticle(id, 'html', { root }), exportHistoryArticle(id, 'markdown', { root })]) {
    assert.doesNotMatch(output, /素材来源：|署名：|原视频作者|疤哥职场|我是疤哥/)
    assert.ok(output.includes(sentences[2]))
  }
  assert.ok(state.article!.notices.every((notice: string) => !/署名|作者名与简介/.test(notice)))
  assert.equal(fs.readFileSync(filename, 'utf8'), before)
})

test('rejects reordered or invented evidence while restoring truncated source conditions', () => {
  const invalid = (quotes: string[], heading = '蔬菜') => ({ sections: [{ heading, paragraphs: [{ quotes, highlights: [] }] }] })
  assert.throws(() => validateHistoryArticleSelection(corrected, invalid([sentences[1], sentences[0]]), 2000), /顺序/)
  assert.throws(() => validateHistoryArticleSelection(corrected, invalid(['明朝人从来不吃蔬菜。']), 2000), /不一致/)
  const restored = validateHistoryArticleSelection(corrected, invalid(['城里鲜菜可能更贵。'], '运输困难'), 2000)
  assert.equal(restored[0].paragraphs[0].text, sentences[1])
  const bothEnds = validateHistoryArticleSelection(corrected, invalid(['运输困难'], '运输困难'), 2000)
  assert.equal(bothEnds[0].paragraphs[0].text, sentences[1])
  const summarized = validateHistoryArticleSelection(corrected, invalid([sentences[0]], '鲜菜供给的局限'), 2000)
  assert.equal(corrected.includes('鲜菜供给的局限'), false)
  assert.equal(summarized[0].heading, '鲜菜供给的局限')
  assert.equal(summarized[0].paragraphs[0].text, sentences[0])
  assert.throws(() => validateHistoryArticleSelection(corrected, invalid([sentences[0], sentences[0]]), 2000), /不一致/)
  const repeated = '历史结论仍然有条件。'.repeat(300)
  assert.doesNotThrow(() => validateHistoryArticleSelection(repeated, invalid([repeated], '历史结论'), 1500))
  assert.doesNotThrow(() => validateHistoryArticleSelection(repeated, invalid(['历史结论仍然有条件。'], '历史结论'), 1500))
})

test('numbered selection reconstructs exact original sentences and rejects invalid or reordered IDs', () => {
  const selection = (sentenceIds: number[]) => ({ sections: [{ heading: '原因与结论', paragraphs: [{ sentenceIds }] }] })
  const result = validateHistoryArticleSelection(corrected, selection([1, 3]), 1500)
  assert.equal(result[0].paragraphs[0].text, sentences[1] + sentences[3])
  assert.equal(result[0].paragraphs[0].sourceEvidence[0].start, sentences[0].length)
  for (const ids of [[1, 0], [0, 0], [999], [-1], [0.5]]) {
    assert.throws(() => validateHistoryArticleSelection(corrected, selection(ids), 1500))
  }
  const repeated = validateHistoryArticleSelection('同一句。不同句。同一句。', selection([2]), 1500)
  assert.equal(repeated[0].paragraphs[0].sourceEvidence[0].start, 8)
})

test('rewriting supplies the full corrected source and still accepts legacy numbered output', async () => {
  const result = await rewriteHistoryArticle(corrected, async messages => {
    const input = JSON.parse(messages[1].content)
    assert.deepEqual(input, { correctedTranscript: corrected })
    return JSON.stringify({ sections: [{ heading: '供给与价格', paragraphs: [{ sentenceIds: [0, 1, 2, 3] }] }] })
  })
  assert.equal(result.flatMap(s => s.paragraphs.map(p => p.text)).join(''), corrected)
})

test('rewriting accepts a model title and preserves the public sections array without title length gates', async () => {
  const expected = splitHistoryArticleParagraphs(validateHistoryArticleSelection(corrected, modelSelection))
  for (const title of ['史', '明朝冬季的蔬菜价格与运输条件'.repeat(100)]) {
    let calls = 0
    const sections = await rewriteHistoryArticle(corrected, async () => {
      calls++
      return JSON.stringify({ title, ...modelSelection })
    })
    assert.equal(calls, 1)
    assert.ok(Array.isArray(sections))
    assert.deepEqual(sections, expected)
  }
})

test('missing or malformed titles fall back and multiline titles normalize without failing or retrying the body', async () => {
  const id = seed()
  updateHistorySource(id, { title: '第18集 | 明朝冬季的菜价 #历史 #明朝' })
  const before = getHistorySource(id)
  const cases: [unknown, string][] = [
    ...[undefined, '', ' \t ', null, 123, false, {}, ['菜价']].map(value => [value, '明朝冬季的菜价'] as [unknown, string]),
    ['菜价\n运输', '菜价 运输'], ['\n菜价', '菜价'], ['菜价\r', '菜价'],
    ['菜价\r\n运输', '菜价 运输'], ['菜价\u2028运输', '菜价 运输'], ['菜价\u2029运输', '菜价 运输'],
  ]
  for (const [title, expectedTitle] of cases) {
    let calls = 0
    startHistoryArticle(id, {}, { ...options, caller: async () => {
      calls++
      return JSON.stringify({ title, ...modelSelection })
    } })
    const state = await completed(id)
    assert.equal(state.status, 'completed', `title=${JSON.stringify(title)}: ${state.error}`)
    assert.equal(calls, 1)
    assert.equal(state.article!.title, expectedTitle)
    assert.equal(state.article!.markdown.split('\n')[0], `# ${expectedTitle}`)
    assert.equal(state.article!.sections.flatMap(section => section.paragraphs.map(paragraph => paragraph.text)).join(''), corrected)
    assert.equal(state.stale, false)
    assert.equal(state.diagnostics, null)
  }
  assert.deepEqual(getHistorySource(id), before)
})

test('writes a standalone article for ordinary older readers instead of copying video narration', async () => {
  const id = seed()
  const sourceTitle = '抖音独家丨诸葛亮北伐，街亭之败 #历史'
  const articleTitle = '街亭失守，诸葛亮的第一次北伐为何受挫'
  updateHistorySource(id, { title: sourceTitle })
  const source = '而我们今天这期视频就主要来讲一讲这五次北伐的全过程。公元228年，诸葛亮第一次北伐。街亭失守，蜀军撤退。'
  current(id, source)
  const before = getHistorySource(id)
  let calls = 0
  startHistoryArticle(id, {}, { ...options, caller: async messages => {
    calls++
    assert.match(messages[0].content, /独立.*文章/)
    assert.match(messages[0].content, /40.*以上/)
    assert.match(messages[0].content, /不.*逐字/)
    assert.equal(JSON.parse(messages[1].content).correctedTranscript, source)
    return JSON.stringify({ title: `  ${articleTitle}\t`, sections: [{ heading: '第一次北伐，败在街亭', paragraphs: [
      { text: '228年，诸葛亮率军北伐。' },
      { text: '街亭丢了，蜀军只得撤退。', highlights: ['蜀军只得撤退'] },
    ] }] })
  } })
  const state = await completed(id)
  assert.equal(state.status, 'completed', state.error || '')
  assert.equal(calls, 1, 'Do not add a separate quality-review model call')
  assert.equal(state.article!.title, articleTitle)
  assert.equal(state.article!.markdown.split('\n')[0], `# ${articleTitle}`)
  assert.equal(exportHistoryArticle(id, 'markdown', { root }).split('\n')[0], `# ${articleTitle}`)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'history-articles', String(id), 'article.json'), 'utf8')).article.title, articleTitle)
  assert.equal(state.article!.provenance.sourceMetadataSha256, hash(JSON.stringify([sourceTitle, before!.authorName, before!.sourceUrl])))
  assert.equal(state.article!.provenance.correctedSha256, hash(source))
  assert.equal(state.stale, false)
  assert.equal(state.article?.selectionMethod, 'model-adapted')
  assert.equal('targetLength' in state.article!, false)
  assert.ok(state.article!.markdown.includes('街亭丢了，蜀军只得撤退。'))
  assert.doesNotMatch(state.article!.markdown, /这期视频|本期视频/)
  assert.deepEqual(getHistorySource(id), before)
  assert.ok(state.article!.sections.every(section => section.paragraphs.every(paragraph => paragraph.sourceEvidence.length === 0)), 'Adapted prose must not pretend to be a verbatim quotation')
})

test('video presentation sentences are removed while factual clauses and ordinary mentions of video survive', () => {
  const intro = '而我们今天这期视频就主要来讲一讲这五次北伐的全过程。'
  const source = intro + '公元228年，诸葛亮第一次北伐。街亭失守，蜀军撤退。'
  const legacy = validateHistoryArticleSelection(source, { sections: [{ heading: '第一次北伐', paragraphs: [{ quotes: [source] }] }] }, 1500)
  const legacyBody = splitHistoryArticleParagraphs(legacy).flatMap(section => section.paragraphs.map(paragraph => paragraph.text)).join('')
  assert.equal(legacyBody, '公元228年，诸葛亮第一次北伐。街亭失守，蜀军撤退。')
  const adapted = validateHistoryArticleSelection(source, { sections: [{ heading: '街亭失守', paragraphs: [{
    text: '上期视频我们讲过，街亭失守后，蜀军撤退。视频资料记录了遗址的变化。喜欢这期视频的朋友，记得点赞关注。',
  }] }] }, 1500)
  assert.equal(adapted[0].paragraphs[0].text, '街亭失守后，蜀军撤退。视频资料记录了遗址的变化。')
})

test('adapted paragraphs split by their own sentences without restoring removed video boilerplate', () => {
  const sentence = '街亭丢失以后，蜀军失去了一处要地，只得撤退。'
  const text = sentence.repeat(20)
  const sections = validateHistoryArticleSelection(corrected, { sections: [{ heading: '街亭失守以后', paragraphs: [{ text }] }] }, 1500)
  const split = splitHistoryArticleParagraphs(sections)
  assert.equal(split.flatMap(section => section.paragraphs.map(paragraph => paragraph.text)).join(''), text)
  assert.ok(split[0].paragraphs.length > 1)
  assert.ok(split[0].paragraphs.every(paragraph => paragraph.sourceEvidence.length === 0))
})

test('presentation prefix cleanup retains facts in the same clause and removes only a topical suffix', () => {
  const rewrite = (text: string) => validateHistoryArticleSelection(text, { sections: [{ heading: '北伐经过', paragraphs: [{ text }] }] })
    .flatMap(section => section.paragraphs.map(paragraph => paragraph.text)).join('')
  assert.equal(rewrite('本期视频我们讲讲街亭失守导致粮道断绝，蜀军因此撤退。'), '街亭失守导致粮道断绝，蜀军因此撤退。')
  assert.equal(rewrite('本期视频我们讲讲街亭失守导致粮道断绝。'), '街亭失守导致粮道断绝。')
  assert.equal(rewrite('诸葛亮曾先后五次北伐曹魏，而我们今天这期视频就主要来讲一讲这五次北伐的全过程。'), '诸葛亮曾先后五次北伐曹魏。')
})

test('sentence expansion restores the actual lost causal premise and merges overlapping clause selections', () => {
  const text = '崇祯想找大臣们商量对策，可没人敢来上朝。他又想带着太监打出去，也没人支援他，于是他决定殉国。'
  const selection = { sections: [{ heading: '决定殉国', paragraphs: [{ quotes: ['他又想带着太监打出去', '于是他决定殉国。'], highlights: [] }] }] }
  const sections = validateHistoryArticleSelection(text, selection, 2000)
  assert.equal(sections[0].paragraphs[0].text, '他又想带着太监打出去，也没人支援他，于是他决定殉国。')
  assert.equal(sections[0].paragraphs[0].sourceEvidence.length, 1)
  const evidence = sections[0].paragraphs[0].sourceEvidence[0]
  assert.equal(text.slice(evidence.start, evidence.end), evidence.quote)
})

test('optional emphasis ignores missing, short, oversized and ungrounded highlights without changing excerpts', () => {
  for (const highlights of [undefined, null, ['朱元璋', '蔬菜供应有限', '这是一段过长而且不适合下划线的强调文字', '根本不存在的文字'], '蔬菜供应有限']) {
    const sections = validateHistoryArticleSelection(corrected, { sections: [{ heading: '蔬菜供应', paragraphs: [{ quotes: [sentences[0]], highlights }] }] }, 2000)
    assert.equal(sections[0].paragraphs[0].text, sentences[0])
    assert.ok(sections[0].paragraphs[0].highlights.every(highlight => corrected.includes(highlight) && highlight.length >= 4 && highlight.length <= 15))
  }
})

test('unavailable corrected source and missing or outdated produced video prevent model calls', () => {
  const id = seed()
  updateHistorySource(id, { rawTranscript: '新转录尚未纠错。' })
  assert.equal(getHistoryArticle(id, { root }).canGenerate, false)
  assert.throws(() => startHistoryArticle(id, {}, options), /纠错/)
  current(id)
  db.$client.prepare('UPDATE history_script_deliveries SET video_path=NULL WHERE script_id=?').run(id)
  assert.throws(() => startHistoryArticle(id, {}, options), /关联已产出/)
  db.$client.prepare('UPDATE history_script_deliveries SET video_path=?,script_sha256=? WHERE script_id=?').run(`static/history-deliveries/${id}/abc-123.mp4`, 'stale', id)
  assert.throws(() => startHistoryArticle(id, {}, options), /脚本已变化/)
})

test('never uses downloaded source videos, symlink escapes, or shell-bearing paths as produced media', () => {
  const id = seed()
  for (const bad of ['static/history-sources/1/source.mp4', `static/history-deliveries/${id}/../../abc.mp4`, `static/history-deliveries/${id}/$(touch bad).mp4`]) {
    db.$client.prepare('UPDATE history_script_deliveries SET video_path=? WHERE script_id=?').run(bad, id)
    assert.throws(() => startHistoryArticle(id, {}, options), /路径无效/)
  }
  const outside = path.join(root, 'outside.mp4')
  fs.writeFileSync(outside, 'other video')
  const linked = path.join(root, 'history-deliveries', String(id), 'abc-456.mp4')
  fs.symlinkSync(outside, linked)
  db.$client.prepare('UPDATE history_script_deliveries SET video_path=? WHERE script_id=?').run(`static/history-deliveries/${id}/abc-456.mp4`, id)
  assert.throws(() => startHistoryArticle(id, {}, options), /不存在或不可读取/)
})

test('concurrent jobs reject while a failed regeneration preserves the previous article', async () => {
  const id = seed()
  startHistoryArticle(id, {}, options)
  const previous = (await completed(id)).article
  let finish: (text: string) => void = () => {}
  const pending = new Promise<string>(resolve => { finish = resolve })
  startHistoryArticle(id, { targetLength: 1500 }, { ...options, caller: async () => pending })
  assert.throws(() => startHistoryArticle(id, {}, options), /正在生成/)
  finish('not JSON')
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.article, previous)
  assert.equal(failed.canGenerate, true)
  assert.equal(failed.stale, false)
})

test('onlyIfMissing joins an active article and reuses a current completed article without another model call', async () => {
  const id = seed()
  let finish!: (response: string) => void
  let calls = 0
  const response = new Promise<string>(resolve => { finish = resolve })
  const ensureOptions = { ...options, onlyIfMissing: true, caller: async () => { calls++; return response } }
  assert.equal(startHistoryArticle(id, {}, ensureOptions).status, 'generating')
  assert.equal(startHistoryArticle(id, {}, ensureOptions).status, 'generating')
  finish(JSON.stringify(modelSelection))
  const saved = await completed(id)
  assert.equal(saved.status, 'completed')
  assert.deepEqual(startHistoryArticle(id, {}, ensureOptions).article, saved.article)
  assert.equal(calls, 1)
})

test('onlyIfMissing never retries a failed model; an explicit generation still retries', async () => {
  const id = seed()
  let calls = 0
  startHistoryArticle(id, {}, { ...options, onlyIfMissing: true, caller: async () => { calls++; throw new Error('model unavailable') } })
  assert.equal((await completed(id)).status, 'failed')
  assert.equal(startHistoryArticle(id, {}, { ...options, onlyIfMissing: true, caller: async () => { calls++; return caller() } }).status, 'failed')
  assert.equal(calls, 1)
  startHistoryArticle(id, {}, { ...options, caller: async () => { calls++; return caller() } })
  assert.equal((await completed(id)).status, 'completed')
  assert.equal(calls, 2)
})

test('source and video changes during generation cannot replace an existing result, and stale exports fail', async () => {
  const id = seed()
  startHistoryArticle(id, {}, options)
  const previous = (await completed(id)).article
  startHistoryArticle(id, {}, { ...options, caller: async () => {
    current(id, corrected + '补充观点仍需查证。')
    return caller()
  } })
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.article, previous)
  assert.equal(failed.stale, true)
  assert.throws(() => exportHistoryArticle(id, 'html', { root }), /已变化/)
  current(id)
  assert.equal(getHistoryArticle(id, { root }).stale, false)
  startHistoryArticle(id, {}, { ...options, extract: async (...args) => {
    const images = await extract(...args)
    fs.appendFileSync(path.join(root, 'history-deliveries', String(id), 'abc-123.mp4'), 'replaced content')
    return images
  } })
  const changedVideo = await completed(id)
  assert.equal(changedVideo.status, 'failed')
  assert.deepEqual(changedVideo.article, previous)
  assert.ok(changedVideo.staleReasons.includes('关联成片已变化'))
})

test('expired persisted jobs recover and a removed source cannot be exported', async () => {
  const id = seed()
  startHistoryArticle(id, {}, options)
  await completed(id)
  const filename = path.join(root, 'history-articles', String(id), 'article.json')
  const state = JSON.parse(fs.readFileSync(filename, 'utf8'))
  fs.writeFileSync(filename, JSON.stringify({ ...state, status: 'generating', runId: 'old-run', leaseUntil: Date.now() - 1 }))
  const lock = path.join(path.dirname(filename), 'generation.lock')
  fs.writeFileSync(lock, 'old-run')
  fs.utimesSync(lock, new Date(0), new Date(0))
  assert.equal(getHistoryArticle(id, { root }).status, 'failed')
  startHistoryArticle(id, {}, options)
  assert.equal((await completed(id)).status, 'completed')
  db.$client.prepare('UPDATE history_script_sources SET deleted_at=? WHERE id=?').run(new Date().toISOString(), id)
  assert.throws(() => exportHistoryArticle(id, 'html', { root }), /不存在/)
})

test('model and rendering errors never leak provider secrets or overwrite previous text', async () => {
  const id = seed()
  startHistoryArticle(id, {}, { ...options, caller: async () => { throw new Error('Authorization: secret-key') } })
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.ok(!failed.error!.includes('secret-key'))
  assert.equal(failed.diagnostics?.stage, 'selection_model')
  assert.ok(!JSON.stringify(failed.diagnostics).includes('secret-key'))
  assert.equal(failed.article, null)
  await assert.rejects(rewriteHistoryArticle('', caller), /原文为空/)
})

test('model deadline failures report timeout without exposing provider details', async () => {
  const id = seed()
  startHistoryArticle(id, {}, { ...options, caller: async () => {
    throw new DOMException('provider timeout with secret-key', 'TimeoutError')
  } })
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.diagnostics?.stage, 'selection_model')
  assert.equal(failed.diagnostics?.kind, 'timeout')
  assert.match(failed.error!, /模型响应超时/)
  assert.doesNotMatch(failed.error!, /secret-key|成片/)
})

test('full source rewriting has no target length, source cap or length-based retry', async () => {
  const sentence = '历史事件仍需核对相关背景与记载。'
  const text = sentence.repeat(7000)
  const selection = (text: string) => JSON.stringify({ sections: [{ heading: '事件背景', paragraphs: [{ text }] }] })
  let attempts = 0
  const sections = await rewriteHistoryArticle(text, async messages => {
    attempts++
    const input = JSON.parse(messages[1].content)
    assert.equal(input.correctedTranscript, text)
    assert.equal(input.targetLength, undefined)
    assert.equal(input.lengthFeedback, undefined)
    return selection(text)
  })
  assert.equal(attempts, 1)
  assert.equal(sections.flatMap(s => s.paragraphs.map(p => p.text)).join(''), text)
})

test('legacy targetLength is ignored and neither short nor long articles are rejected', async () => {
  const id = seed()
  for (const text of ['街亭丢了，蜀军只得撤退。', '街亭丢了，蜀军只得撤退。'.repeat(500)]) {
    let calls = 0
    startHistoryArticle(id, { targetLength: 1000 }, { ...options, caller: async messages => {
      calls++
      assert.deepEqual(JSON.parse(messages[1].content), { correctedTranscript: corrected })
      return JSON.stringify({ sections: [{ heading: '街亭失守', paragraphs: [{ text }] }] })
    } })
    const state = await completed(id)
    assert.equal(state.status, 'completed', state.error || '')
    assert.equal(calls, 1)
    assert.equal('targetLength' in state.article!, false)
    assert.equal(state.article!.sections.flatMap(section => section.paragraphs.map(paragraph => paragraph.text)).join(''), text)
  }
})

test('model transport timeout retries once within the same deadline and reports exhausted timeouts safely', async () => {
  let attempts = 0
  let firstSignal: AbortSignal | undefined
  const timeout = () => new TypeError('fetch failed with secret-key', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })
  const sections = await rewriteHistoryArticle(corrected, async (_messages, settings) => {
    attempts++
    if (attempts === 1) { firstSignal = settings?.signal; throw timeout() }
    assert.equal(settings?.signal, firstSignal)
    return JSON.stringify(modelSelection)
  })
  assert.equal(attempts, 2)
  assert.equal(sections.length, 2)
  attempts = 0
  await assert.rejects(rewriteHistoryArticle(corrected, async () => { attempts++; throw timeout() }), error => {
    assert.match((error as Error).message, /模型响应超时/)
    assert.doesNotMatch((error as Error).message, /secret-key|成片/)
    return true
  })
  assert.equal(attempts, 2)
  const controller = new AbortController()
  attempts = 0
  await assert.rejects(rewriteHistoryArticle(corrected, async () => {
    attempts++; controller.abort(new DOMException('deadline', 'TimeoutError')); throw timeout()
  }, controller.signal), /模型响应超时/)
  assert.equal(attempts, 1)
})

test('a provider ignoring cancellation cannot hold article execution indefinitely or replay its late response', async () => {
  const controller = new AbortController()
  let finish!: (value: string) => void
  let entered!: () => void
  const pending = new Promise<string>(resolve => { finish = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const running = rewriteHistoryArticle(corrected, async () => { calls++; entered(); return pending }, controller.signal)
  const rejected = assert.rejects(running, /模型响应超时/)
  await started
  controller.abort(new DOMException('deadline', 'TimeoutError'))
  await rejected
  finish(JSON.stringify(modelSelection))
  await Promise.resolve()
  assert.equal(calls, 1)
})

test('failed model structures persist bounded field diagnostics and private replay evidence', async () => {
  const id = seed()
  startHistoryArticle(id, {}, { ...options, caller: async () => JSON.stringify({ title: '历史文章', sections: [{ heading: '历史', paragraphs: [{ quotes: 'not-an-array' }] }] }) })
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.diagnostics?.stage, 'selection_validation')
  assert.deepEqual(failed.diagnostics?.issues, [{ path: 'sections.0.paragraphs.0', code: 'invalid_union' }])
  assert.ok(failed.diagnostics?.artifactId)
  const diagnosticFile = path.join(options.diagnosticsRoot, String(id), `${failed.diagnostics!.artifactId}.json`)
  assert.equal(fs.statSync(diagnosticFile).mode & 0o777, 0o600)
  const diagnostic = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8'))
  assert.equal(diagnostic.modelResponses.length, 1)
  assert.equal(diagnostic.modelResponses[0].stage, 'selection')
  assert.ok(!fs.existsSync(path.join(root, 'history-articles', String(id), `${failed.diagnostics!.artifactId}.json`)))
})

test('extra chapter highlights and optional model metadata preserve the complete rewritten article without another model call', async () => {
  const id = seed()
  const prose = ['冬天里，明朝各地的菜价并不一样。', '路不好走，运菜费力，价格自然会受影响。']
  let calls = 0
  startHistoryArticle(id, {}, {
    ...options,
    caller: async () => {
      calls++
      return JSON.stringify({ title: '冬天的菜为何贵', comment: 'optional metadata', sections: [
        { heading: '不同地方不同价', highlights: ['不同地方'], paragraphs: [{ text: prose[0], emphasis: true }] },
        { heading: '运菜也要花钱', highlights: ['运菜'], paragraphs: [{ text: prose[1] }] },
      ] })
    },
  })
  const result = await completed(id)
  assert.equal(result.status, 'completed', result.error || '')
  assert.equal(calls, 1)
  assert.deepEqual(result.article!.sections.flatMap(section => section.paragraphs.map(paragraph => paragraph.text)), prose)
  assert.equal(result.article!.title, '冬天的菜为何贵')
  assert.equal(result.article!.screenshots.length, 3)
})

test('internal manual selection records provenance without claiming model approval', async () => {
  const id = seed()
  startHistoryArticle(id, {}, { ...options, selectionMethod: 'manual-source-exact' })
  const result = await completed(id)
  assert.equal(result.status, 'completed')
  assert.equal(result.article?.selectionMethod, 'manual-source-exact')
  assert.equal('semanticReview' in result.article!, false)
})

test('articles without semantic approval remain exportable when source and video are current', async () => {
  const id = seed()
  startHistoryArticle(id, {}, options)
  await completed(id)
  assert.equal(getHistoryArticle(id, { root }).stale, false)
  assert.ok(exportHistoryArticle(id, 'html', { root }).includes('<section'))
  startHistoryArticle(id, {}, { ...options, caller: async () => { throw new Error('model unavailable') } })
  const failed = await completed(id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.stale, false)
  assert.ok(exportHistoryArticle(id, 'html', { root }).includes('<section'))
})

test('mobile paragraphs split at source sentence boundaries without adding or losing text', () => {
  const sentence = '因为当时的交通条件存在限制，所以各地的价格并不相同。'
  const text = sentence.repeat(20)
  const sections = validateHistoryArticleSelection(text, { sections: [{ heading: '交通条件', paragraphs: [{ quotes: [text], highlights: ['交通条件'] }] }] }, 2000)
  const split = splitHistoryArticleParagraphs(sections)
  assert.ok(split[0].paragraphs.length >= 3)
  assert.ok(split[0].paragraphs.every(paragraph => paragraph.text.length <= 220))
  assert.equal(split[0].paragraphs.map(paragraph => paragraph.text).join(''), text)
  for (const paragraph of split[0].paragraphs) for (const evidence of paragraph.sourceEvidence) assert.equal(text.slice(evidence.start, evidence.end), evidence.quote)
})

test('renderer escapes body HTML and rejects remote or active screenshot URLs', () => {
  const sections = validateHistoryArticleSelection(corrected, modelSelection, 2000)
  sections[0].paragraphs[0].text += ' <script>bad</script> 阅读, "历史"!'
  const input = { title: '<script>bad</script>', sections, screenshots: [] }
  const output = renderHistoryArticle(input)
  assert.ok(!/<script|<img onerror/.test(output.html))
  assert.ok(output.html.includes('&lt;script&gt;'))
  assert.ok(output.html.includes('阅读， “历史”'))
  assert.throws(() => renderHistoryArticle({ ...input, screenshots: [{ url: 'javascript:alert(1)', timestamp: 1, sectionIndex: 0 }] }), /Invalid article image/)
  assert.ok(!/\s(?:class|id)=/.test(output.html))
  assert.ok(!/\bwidth:100%;height:auto/.test(output.html))
})

test('renderer does not append a configured signature or first-person bio', () => {
  const sections = validateHistoryArticleSelection(corrected, modelSelection, 2000)
  const legacyInput = { title: '菜价', sections, screenshots: [], sourceUrl: 'https://www.douyin.com/video/1', sourceAuthor: null, author: { name: '历史笔记', bio: '我是小史，记录阅读见闻。' } }
  const rendered = renderHistoryArticle(legacyInput)
  assert.doesNotMatch(rendered.html + rendered.markdown, /素材来源：|署名：|历史笔记|我是小史|记录阅读见闻/)
})

test('typography pairs quotes across highlights and retains URLs, decimals and English identifiers', () => {
  const text = '当时的"蔬菜供应"仍然有限.因为(运输困难),城里可能贵!价格为3.14元，资料在https://example.com/a.b。'
  const output = renderHistoryArticle({ title: '菜价', sections: [{ heading: '蔬菜供应', paragraphs: [{ text, highlights: ['蔬菜供应', '运输困难'], sourceEvidence: [] }] }], screenshots: [] })
  const visible = output.html.replace(/<[^>]+>/g, '')
  assert.ok(visible.includes('当时的“蔬菜供应”仍然有限。因为（运输困难），城里可能贵！价格为3.14元'))
  assert.ok(visible.includes('https://example.com/a.b'))
  assert.ok(!output.html.includes('<h3'), 'An introduction-only chapter does not create an empty section')
  assert.equal(articleTypography('版本example.test，数值1.25。'), '版本example.test，数值1.25。')
})

test('article title removes social tags and episode prefix while original source and provenance remain intact', async () => {
  const id = seed()
  const originalTitle = '第18集 | 明朝冬季的菜价 #历史 #明朝'
  updateHistorySource(id, { title: originalTitle })
  startHistoryArticle(id, {}, options)
  const result = await completed(id)
  assert.equal(result.article?.title, '明朝冬季的菜价')
  assert.equal(getHistorySource(id)?.title, originalTitle)
  assert.equal(result.article?.provenance.sourceMetadataSha256, hash(JSON.stringify([originalTitle, '原视频作者', getHistorySource(id)!.sourceUrl])))
  assert.equal(cleanHistoryArticleTitle('正常标题'), '正常标题')
  assert.equal(cleanHistoryArticleTitle('第十八集：明朝历史'), '明朝历史')
})

test('real ffmpeg extracts three interior JPEG frames from associated produced video and HTML passes installed skill validator', async () => {
  const video = path.join(root, 'actual-produced.mp4')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-pix_fmt', 'yuv420p', '-n', video], { timeout: 30_000 })
  const sections = validateHistoryArticleSelection(corrected, modelSelection, 2000)
  const screenshots = await extractHistoryArticleFrames(video, path.join(root, 'real-frames'), '/static/history-articles/1/abc-123', sections)
  assert.equal(screenshots.length, 3)
  for (const [index, image] of screenshots.entries()) {
    assert.ok(image.timestamp > 0 && image.timestamp < 2)
    const jpeg = fs.readFileSync(path.join(root, 'real-frames', `frame-${index + 1}.jpg`))
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8])
    assert.ok(jpeg.length > 500)
    const metadata = await sharp(jpeg).metadata()
    assert.deepEqual([metadata.width, metadata.height], [160, 120], 'Small videos must not be upscaled')
  }
  const fixtureSections = structuredClone(sections)
  fixtureSections[0].paragraphs[0].text = '当时的"蔬菜供应"仍然有限.因为(运输困难),城里可能贵!价格为3.14元。'
  fixtureSections[0].paragraphs[0].highlights = ['蔬菜供应', '运输困难']
  const { html } = renderHistoryArticle({ title: '菜价', sections: fixtureSections, screenshots })
  const filename = path.join(root, 'article-fixture.html')
  fs.writeFileSync(filename, html)
  const validator = path.join(os.homedir(), '.agents/skills/gzh-design/scripts/validate_gzh_html.py')
  if (fs.existsSync(validator)) {
    const result = await exec('python3', [validator, filename], { timeout: 30_000 })
    assert.ok(!result.stdout.includes('WARNING'), result.stdout)
    assert.ok(result.stdout.includes('完全合规'), result.stdout)
  }
})

test('article screenshots retain 1080p and choose sharp nearby frames instead of blurred sampling centers', async () => {
  const video = path.join(root, 'sharp-and-blurred.mp4')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=1920x1080:rate=10:duration=8', '-vf',
    "gblur=sigma=16:enable='lt(mod(t,2),0.5)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', '-n', video], { timeout: 30_000 })
  const sections = validateHistoryArticleSelection(corrected, modelSelection, 1500)
  const directory = path.join(root, 'sharp-frames')
  const screenshots = await extractHistoryArticleFrames(video, directory, '/static/history-articles/1/abc-456', sections)
  assert.equal(screenshots.length, 3)
  for (const [index, image] of screenshots.entries()) {
    const filename = path.join(directory, `frame-${index + 1}.jpg`)
    const metadata = await sharp(filename).metadata()
    assert.deepEqual([metadata.width, metadata.height], [1920, 1080])
    const center = 2 * (index + 1)
    assert.ok(Math.abs(image.timestamp - center) <= 1.5, 'Selection must stay near the chapter sampling point')
    assert.ok(image.timestamp % 2 >= 0.5, `Selected a blurred frame at ${image.timestamp}`)
    const baseline = path.join(root, `blurred-center-${index}.jpg`)
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(center), '-i', video, '-frames:v', '1', '-q:v', '1', '-n', baseline])
    assert.ok((await sharp(filename).stats()).sharpness > (await sharp(baseline).stats()).sharpness * 2)
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), ['frame-1.jpg', 'frame-2.jpg', 'frame-3.jpg'])
})
