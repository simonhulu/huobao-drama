import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanHistorySourceTitle, sourceTitleNumbers, rewriteHistorySourceTitle, sourceTitleRewriteSchema,
  hasCompleteSourceTitleRewrite } from './history-title-source.js'
import type { CoverJsonRequest } from './cover-prompt-enhance.js'

const sourceTitle = '朱棣1399年起兵 为何只用三年打进南京？｜助眠睡前歷史故事｜欢迎订阅'
const reply = () => ({ title: '朱棣1399年起兵 为何三年就打进南京？', keywords: [
  { text: '朱棣', kind: 'person' }, { text: '1399年', kind: 'time' },
  { text: '三年', kind: 'number' }, { text: '南京', kind: 'place' },
] })
const script = '朱棣在1399年起兵，三年后打进南京。'

test('rewrites the collected original and preserves people, dates and numbers beyond the old 16-character limit', async () => {
  const calls: Parameters<CoverJsonRequest>[0][] = []
  const result = await rewriteHistorySourceTitle({ sourceTitle, script }, async messages => {
    calls.push(messages)
    assert.equal(JSON.parse(messages[1]!.content).sourceTitle, sourceTitle)
    assert.equal(JSON.parse(messages[1]!.content).script, script)
    return reply()
  })
  assert.equal(calls.length, 1)
  assert.equal(result.title, reply().title)
  assert.ok(result.title.length > 16 && result.title.length <= 40)
  assert.deepEqual(result.removed_promotions, ['助眠睡前歷史故事', '欢迎订阅'])
  assert.deepEqual(result.protected_numbers, ['1399年', '三年', '1399'])
  assert.equal(hasCompleteSourceTitleRewrite(sourceTitleRewriteSchema.parse(JSON.parse(JSON.stringify(result)))), true)
})

test('Qin and Han traditional source retains both dynasties and its two-hundred-year comparison', async () => {
  const sourceTitle = '秦朝亡了沒人救 漢朝亡了憑什麼還能再活兩百年？-助眠睡前歷史故事'
  const result = await rewriteHistorySourceTitle({ sourceTitle, script: '秦朝與漢朝的興亡。' }, async () => ({
    title: '秦朝亡了無人救 漢朝為何還能再活兩百年？',
    keywords: [{ text: '秦朝', kind: 'dynasty' }, { text: '漢朝', kind: 'dynasty' }, { text: '兩百年', kind: 'number' }],
  }))
  assert.equal(result.cleaned_title, '秦朝亡了沒人救 漢朝亡了憑什麼還能再活兩百年？')
  assert.deepEqual(result.protected_numbers, ['兩百年'])
  assert.equal(hasCompleteSourceTitleRewrite(result), true)
})

test('promotion cleanup retains historical brackets, topical hashtags and a date range', () => {
  const result = cleanHistorySourceTitle('【明朝】朱棣1399-1402年征战 #靖难之役｜欢迎订阅 https://example.com/channel')
  assert.equal(result.cleaned, '【明朝】朱棣1399-1402年征战 靖难之役')
  assert.deepEqual(sourceTitleNumbers(result.cleaned), ['1402年', '1399', '1402'])
  assert.equal(cleanHistorySourceTitle('唐太宗【关注百姓生活】为何睡前读史').cleaned, '唐太宗【关注百姓生活】为何睡前读史')
})

test('long promotional URLs can be recorded without invalidating a usable title', async () => {
  const url = `https://example.com/${'channel'.repeat(30)}`
  const result = await rewriteHistorySourceTitle({ sourceTitle: `朱棣为何起兵？ ${url}`, script }, async () => ({
    title: '朱棣起兵是为何？', keywords: [{ text: '朱棣', kind: 'person' }],
  }))
  assert.deepEqual(result.removed_promotions, [url])
  assert.equal(hasCompleteSourceTitleRewrite(result), true)
})

for (const [label, mutate] of [
  ['removed numeric date', (value: ReturnType<typeof reply>) => { value.title = '朱棣起兵 为何三年就打进南京？'; value.keywords = value.keywords.filter(item => item.kind !== 'time') }],
  ['changed Chinese number', (value: ReturnType<typeof reply>) => { value.title = '朱棣1399年起兵 为何四年就打进南京？'; value.keywords = value.keywords.filter(item => item.kind !== 'number') }],
  ['new Chinese number', (value: ReturnType<typeof reply>) => { value.title += '一日就攻陷？' }],
  ['invented person', (value: ReturnType<typeof reply>) => { value.keywords.push({ text: '李世民', kind: 'person' }) }],
  ['overlong title', (value: ReturnType<typeof reply>) => { value.title += '为何'.repeat(20) }],
] as const) {
  test(`${label} gets only one correction and cannot become a completed title`, async () => {
    let count = 0
    const value = reply(); mutate(value)
    await assert.rejects(rewriteHistorySourceTitle({ sourceTitle, script }, async () => { count++; return value }), /原标题改写未完成/)
    assert.equal(count, 2)
  })
}

test('one correction can recover a malformed title without changing its source', async () => {
  let count = 0
  const result = await rewriteHistorySourceTitle({ sourceTitle, script }, async messages => {
    const payload = JSON.parse(messages[1]!.content)
    assert.equal(payload.sourceTitle, sourceTitle)
    if (++count === 1) return { ...reply(), title: '！' }
    assert.ok(payload.correction)
    return reply()
  })
  assert.equal(count, 2)
  assert.equal(result.title, reply().title)
})

test('fabricated removal evidence and drift in stored provenance fail validation', async () => {
  const good = await rewriteHistorySourceTitle({ sourceTitle, script }, async () => reply())
  for (const mutation of [
    { source_title: '替换后的原标题' }, { cleaned_title: '替换后的清理标题' },
    { removed_promotions: ['原标题没有的订阅广告'] }, { protected_numbers: [] },
    { title: '另一个题目' },
  ]) assert.equal(hasCompleteSourceTitleRewrite({ ...good, ...mutation }), false)
})

test('missing source and provider failure do not silently substitute script text or fabricate a title', async () => {
  let count = 0
  const request: CoverJsonRequest = async () => { count++; throw new Error('model unavailable') }
  await assert.rejects(rewriteHistorySourceTitle({ sourceTitle: '', script }, request), /原标题/)
  assert.equal(count, 0)
  await assert.rejects(rewriteHistorySourceTitle({ sourceTitle, script }, request), /model unavailable/)
  assert.equal(count, 1)
})

test('a second video receives its variant and corrects a duplicate title while preserving original numbers', async () => {
  const publishingVariant = { videoId: 12, producer: 'motion' as const, otherPackages: [
    { producer: 'huasheng', title: reply().title, mainTitle: '三年打进南京', imagePrompt: 'An army outside Nanjing' },
  ] }
  let calls = 0
  const result = await rewriteHistorySourceTitle({ sourceTitle, script, publishingVariant }, async messages => {
    const payload = JSON.parse(messages[1]!.content)
    assert.deepEqual(payload.publishingVariant, publishingVariant)
    assert.match(messages[0]!.content, /不同表达/)
    calls++
    if (calls === 1) return { ...reply(), title: '朱棣1399年起兵 为何三年就打进南京？精细化版' }
    assert.match(payload.correction, /重复/)
    return { ...reply(), title: '1399年朱棣起兵，打进南京为何仅用三年？' }
  })
  assert.equal(calls, 2)
  assert.equal(result.title, '1399年朱棣起兵 打进南京为何仅用三年？')
  assert.deepEqual(result.protected_numbers, ['1399年', '三年', '1399'])
})

test('a title that still matches the other video after correction cannot become a package', async () => {
  let calls = 0
  await assert.rejects(rewriteHistorySourceTitle({ sourceTitle, script, publishingVariant: {
    videoId: 13, producer: 'motion', otherPackages: [
      { producer: 'huasheng', title: reply().title, mainTitle: '', imagePrompt: '' },
    ],
  } }, async () => { calls++; return { ...reply(), title: '朱棣1399年起兵：为何三年就打进南京？' } }), /重复/)
  assert.equal(calls, 2)
})
