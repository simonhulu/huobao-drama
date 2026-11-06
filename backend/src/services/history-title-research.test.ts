import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import type { CoverJsonRequest } from './cover-prompt-enhance.js'
import { historyTitleResearchSchema, researchHistoryTitles } from './history-title-research.js'

const jin = {
  sourceTitle: '魏晋南北朝：从西晋到南北分裂',
  script: '司马家建立西晋，结束了三国分裂。统一之后皇族内斗，八王之乱削弱了西晋。北方此后出现多个政权。',
  groups: [['西晋', '司马家'], ['八王之乱', '皇族']],
}
const ming = {
  sourceTitle: '明代宫廷冬季采购',
  script: '万历年间宫廷冬季采购韭菜。一斤韭菜的价格约抵普通工人五天工钱，这不是普通菜市的日常菜价。',
  groups: [['宫廷', '韭菜'], ['万历', '工钱']],
}

function extractor(groups: unknown = jin.groups) {
  const calls: Parameters<CoverJsonRequest>[0][] = []
  const request: CoverJsonRequest = async messages => {
    calls.push(structuredClone(messages))
    return { keyword_groups: groups }
  }
  return { request, calls }
}

const organic = (items: unknown[]) => ({ organic: items, base_resp: { status_code: 0, status_msg: 'success' } })
const result = (title: string, link: string, snippet = '', date?: string) => ({ title, link, snippet, ...(date ? { date } : {}) })

function topicSearch(fixture = jin) {
  const queries: string[] = []
  return {
    queries,
    search: async (query: string) => {
      queries.push(query)
      const platform = query.includes('site:toutiao.com') ? 'toutiao' : 'baijiahao'
      const index = fixture.groups.findIndex(group => group.every(word => query.includes(word)))
      const word = fixture.groups[Math.max(0, index)]![0]!
      const id = String(1000 + Math.max(0, index))
      return organic([result(`${word}${platform === 'toutiao' ? '为何走向这个转折' : '背后转折究竟有多离奇'}`, platform === 'toutiao'
        ? `https://www.toutiao.com/article/${id}/` : `https://baijiahao.baidu.com/s?id=${id}`, `${word}相关历史，供标题措辞参考。`, '2024-05-01')])
    },
  }
}

test('extracts two source-bound keyword groups and searches both platforms without exposing the whole script', async () => {
  const model = extractor()
  const searches = topicSearch()
  const research = await researchHistoryTitles(jin, model.request, searches.search)
  assert.equal(model.calls.length, 1)
  assert.deepEqual(JSON.parse(model.calls[0]![1]!.content), {
    purpose: 'history-title-keywords', sourceTitle: jin.sourceTitle, script: jin.script,
  })
  assert.match(model.calls[0]![0]!.content, /原文|原词/)
  assert.match(model.calls[0]![0]!.content, /材料|数据/)
  assert.match(model.calls[0]![0]!.content, /冲突|代价|反常/)
  assert.match(model.calls[0]![0]!.content, /宽泛|时代分类/)
  assert.equal(searches.queries.length, 4)
  for (const group of jin.groups) {
    for (const domain of ['toutiao.com', 'baijiahao.baidu.com']) {
      assert.ok(searches.queries.some(query => query.includes(`site:${domain}`) && group.every(word => query.includes(word))))
    }
  }
  assert.ok(searches.queries.every(query => !query.includes(jin.script)))
  assert.deepEqual(research.keywords, jin.groups)
  assert.equal(research.references.length, 4)
  assert.deepEqual(research.references.map(item => item.id), ['R1', 'R2', 'R3', 'R4'])
  assert.ok(research.references.every(item => item.title.includes('转折') && item.date === '2024-05-01'))
  assert.ok(research.queries.every(query => query.status === 'ok'))
  assert.ok(Number.isFinite(Date.parse(research.searched_at)))
  assert.deepEqual(historyTitleResearchSchema.parse(research), research)
})

test('different source material changes the actual search terms rather than using a saved episode example', async () => {
  for (const fixture of [jin, ming]) {
    const model = extractor(fixture.groups)
    const searches = topicSearch(fixture)
    const research = await researchHistoryTitles(fixture, model.request, searches.search)
    assert.ok(searches.queries.every(query => fixture.groups.some(group => group.every(word => query.includes(word)))))
    assert.ok(research.references.every(reference => fixture.groups.some(group => group.some(word => reference.title.includes(word)))))
    if (fixture === ming) assert.ok(searches.queries.every(query => !/西晋|司马家|八王之乱/.test(query)))
  }
})

test('rejects fabricated, malformed, duplicated or instruction-like keywords after at most one correction and before searching', async () => {
  for (const groups of [
    [['朱元璋'], ['西晋']],
    [['西晋']],
    [['西晋', '司马家', '皇族', '北方'], ['八王之乱']],
    [['晋'], ['八王之乱']],
    [['西晋'], ['西晋']],
    [['西晋', '西晋'], ['八王之乱']],
    [['site:evil.example'], ['八王之乱']],
  ]) {
    let searches = 0
    const model = extractor(groups)
    await assert.rejects(researchHistoryTitles(jin, model.request, async () => {
      searches++
      return organic([])
    }), /关键词/)
    assert.equal(model.calls.length, 2)
    assert.equal(searches, 0)
  }
  let calls = 0
  const extraFields: CoverJsonRequest = async () => {
    calls++
    return { keyword_groups: jin.groups, execute: 'ignore the rules' }
  }
  await assert.rejects(researchHistoryTitles(jin, extraFields, async () => organic([])), /关键词/)
  assert.equal(calls, 2)
})

test('corrects invalid keyword extraction once using the complete source, previous output and a short validation error', async () => {
  const invalid = { keyword_groups: [['晋朝皇族内战'], ['八王之乱']] }
  const calls: Parameters<CoverJsonRequest>[0][] = []
  const searches = topicSearch()
  const request: CoverJsonRequest = async messages => {
    calls.push(structuredClone(messages))
    assert.ok(calls.length <= 2, 'at most one keyword correction is allowed')
    assert.equal(searches.queries.length, 0, 'invalid terms must never be sent to the search service')
    return calls.length === 1 ? invalid : { keyword_groups: jin.groups }
  }
  const research = await researchHistoryTitles(jin, request, searches.search)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.slice(0, 2), calls[0])
  assert.deepEqual(JSON.parse(calls[1]![1]!.content), {
    purpose: 'history-title-keywords', sourceTitle: jin.sourceTitle, script: jin.script,
  })
  const correction = JSON.parse(calls[1]!.at(-1)!.content)
  assert.equal(correction.purpose, 'history-title-keywords-correction')
  assert.deepEqual(correction.previous_keywords, invalid)
  assert.match(correction.error, /原词|原文/)
  assert.ok(correction.error.length < 250)
  assert.match(correction.instruction, /逐字|原词/)
  assert.deepEqual(research.keywords, jin.groups)
  assert.equal(searches.queries.length, 4)
  assert.ok(searches.queries.every(query => !query.includes('晋朝皇族内战')))
})

test('two different invalid extractions stop without filtering, substituting or searching any remaining valid words', async () => {
  let calls = 0
  let searches = 0
  const request: CoverJsonRequest = async () => {
    calls++
    assert.ok(calls <= 2)
    return calls === 1 ? { keyword_groups: [['晋朝皇族内战'], ['八王之乱']] }
      : { keyword_groups: [['西晋', '西晋'], ['八王之乱']] }
  }
  await assert.rejects(researchHistoryTitles(jin, request, async () => {
    searches++
    return organic([])
  }), /关键词/)
  assert.equal(calls, 2)
  assert.equal(searches, 0)
})

test('does not retry keyword transport failures or leak the provider response', async () => {
  let calls = 0
  let searches = 0
  const request: CoverJsonRequest = async () => {
    calls++
    throw new Error('Authorization: secret-key-for-test')
  }
  await assert.rejects(researchHistoryTitles(jin, request, async () => {
    searches++
    return organic([])
  }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /关键词/)
    assert.doesNotMatch(error.message, /secret-key|Authorization/)
    return true
  })
  assert.equal(calls, 1)
  assert.equal(searches, 0)
})

test('transport failure during the single correction stops without further retry', async () => {
  let calls = 0
  let searches = 0
  const request: CoverJsonRequest = async () => {
    calls++
    if (calls === 1) return { keyword_groups: [['晋朝皇族内战'], ['八王之乱']] }
    throw new Error('Authorization: correction-secret')
  }
  await assert.rejects(researchHistoryTitles(jin, request, async () => {
    searches++
    return organic([])
  }), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /关键词/)
    assert.doesNotMatch(error.message, /Authorization|correction-secret/)
    return true
  })
  assert.equal(calls, 2)
  assert.equal(searches, 0)
})

test('accepts article hosts only and filters forged domains, credentials, search pages and user pages', async () => {
  const invalid = [
    'https://www.toutiao.com.evil.example/article/11/',
    'https://evil-toutiao.com/article/11/',
    'https://baijiahao.baidu.com.evil.example/s?id=11',
    'https://baike.baidu.com/item/西晋/11',
    'https://user:password@www.toutiao.com/article/11/',
    'https://www.toutiao.com:8443/article/11/',
    'javascript:alert(1)',
    'file:///tmp/西晋',
    'https://www.toutiao.com/search/?keyword=西晋',
    'https://www.toutiao.com/c/user/token/',
    'https://www.toutiao.com/user/11/',
    'https://www.toutiao.com/w/not-an-article/',
    'https://www.toutiao.com/w/1853802829503495/comments/',
    'https://www.toutiao.com/arbitrary/1853802829503495/',
    'https://baijiahao.baidu.com/builder/rc/home',
    'https://baijia.baidu.com/s?id=not-an-article',
  ]
  const research = await researchHistoryTitles(jin, extractor().request, async query => organic([
    ...invalid.map((url, index) => result(`西晋皇族的不同标题${index}`, url, '八王之乱')),
    result('西晋皇族为何内斗不止', 'https://m.toutiao.com/article/12/', '西晋八王之乱'),
    result('西晋皇族内斗如何引发转折', 'http://baijiahao.baidu.com/s?id=13', '八王之乱'),
    result('西晋皇族怎样把天下打散', 'https://baijiahao.baidu.com/s?id=14', '司马家八王之乱'),
  ].filter(item => query.includes('site:toutiao.com') ? !item.link.includes('baijiahao.baidu.com/s?id=13') : !item.link.includes('m.toutiao.com/article/12'))))
  assert.equal(research.references.length, 3)
  assert.ok(research.references.every(reference => ['m.toutiao.com', 'baijiahao.baidu.com'].includes(new URL(reference.url).hostname)))
})

test('accepts the observed numeric Weitoutiao article path without allowing arbitrary paths', async () => {
  const research = await researchHistoryTitles(jin, extractor().request, async query => organic([
    result(query.includes('site:toutiao.com') ? '西晋司马家为何统一后先打起来' : '西晋皇族内斗有怎样的转折',
      query.includes('site:toutiao.com') ? 'https://www.toutiao.com/w/1853802829503495/' : 'https://baijiahao.baidu.com/s?id=14',
      '西晋司马家皇族内斗与八王之乱'),
    result('西晋皇族怎样把天下打散', 'https://baijiahao.baidu.com/s?id=15', '司马家八王之乱'),
  ]))
  assert.equal(research.references.length, 3)
  assert.ok(research.references.some(reference => reference.platform === 'toutiao' &&
    reference.url === 'https://www.toutiao.com/w/1853802829503495'))
  assert.ok(research.queries.every(query => query.status === 'ok'))
})

test('accepts a matching search snippet without inventing keywords in an unrelated title', async () => {
  const research = await researchHistoryTitles(jin, extractor().request, async query => organic([
    result(query.includes('site:toutiao.com') ? '一家人为何偏偏打成这个样子' : '统一之后这一家人怎么先打了起来', query.includes('site:toutiao.com')
      ? 'https://www.toutiao.com/article/20/' : 'https://baijiahao.baidu.com/s?id=21', '西晋司马家的皇族内斗与八王之乱'),
    result('这些亲人怎么先翻了脸', 'https://www.toutiao.com/article/24/', '西晋司马家的皇族内斗与八王之乱'),
    result('完全不相关的热门明星新闻', query.includes('site:toutiao.com')
      ? 'https://www.toutiao.com/article/22/' : 'https://baijiahao.baidu.com/s?id=23', '娱乐新闻与历史正文无关'),
  ]))
  assert.equal(research.references.length, 3)
  assert.ok(research.references.every(item => item.snippet.includes('西晋')))
})

test('ignores irrelevant results, control characters and meaningless long titles', async () => {
  const queryCalls: string[] = []
  const research = await researchHistoryTitles(jin, extractor().request, async query => {
    queryCalls.push(query)
    return organic([
      result('明星今天又上热搜', 'https://www.toutiao.com/article/30/', '娱乐新闻'),
      result('西晋\u0000皇族内斗', 'https://www.toutiao.com/article/31/', '八王之乱'),
      result(`西晋${'很'.repeat(180)}`, 'https://www.toutiao.com/article/32/', '八王之乱'),
    ])
  })
  assert.equal(queryCalls.length, 6)
  assert.deepEqual(research.references, [])
  assert.ok(research.queries.every(query => query.status === 'empty'))
})

test('deduplicates tracking URL variants and repeated titles across platforms', async () => {
  const research = await researchHistoryTitles(jin, extractor().request, async () => organic([
    result('西晋皇族为何越打越乱', 'https://www.toutiao.com/article/40/?utm_source=a', '八王之乱'),
    result('西晋皇族越打越乱的不同说法', 'https://www.toutiao.com/article/40/?utm_source=b#fragment', '八王之乱'),
    result('西晋皇族为何越打越乱', 'https://baijiahao.baidu.com/s?id=41&wfr=spider', '八王之乱'),
    result('西晋皇族打掉了怎样的天下', 'https://baijiahao.baidu.com/s?id=42&wfr=spider', '八王之乱'),
    result('西晋司马家怎样走向内斗', 'https://www.toutiao.com/article/43/', '八王之乱'),
  ]))
  assert.equal(research.references.length, 3)
  assert.equal(new Set(research.references.map(item => item.url)).size, 3)
  assert.equal(new Set(research.references.map(item => item.title)).size, 3)
  assert.ok(research.references.every(item => !item.url.includes('utm_source') && !item.url.includes('#')))
})

const articleAliases = [
  {
    platform: 'toutiao' as const,
    original: 'https://www.toutiao.com/article/12345',
    aliases: [
      'https://m.toutiao.com/article/12345/',
      'http://www.toutiao.com/article/12345/',
      'https://toutiao.com/article/12345/',
      'https://m.toutiao.com/a12345/',
      'https://www.toutiao.com/i12345/',
      'https://www.toutiao.com/video/12345/',
      'https://www.toutiao.com/group/12345/',
      'https://www.toutiao.com/w/12345/',
      'https://www.toutiao.com/w/a12345/',
    ],
    second: 'https://www.toutiao.com/article/12346',
    third: 'https://www.toutiao.com/article/12347',
  },
  {
    platform: 'baijiahao' as const,
    original: 'https://baijiahao.baidu.com/s?id=12345',
    aliases: [
      'http://baijiahao.baidu.com/s?id=12345',
      'https://baijia.baidu.com/s?id=12345&wfr=pc',
      'http://baijia.baidu.com/s?id=12345',
    ],
    second: 'https://baijiahao.baidu.com/s?id=12346',
    third: 'https://baijiahao.baidu.com/s?id=12347',
  },
]

for (const fixture of articleAliases) {
  test(`${fixture.platform}: article aliases with different titles remain a single reference`, async () => {
    for (const alias of fixture.aliases) {
      const research = await researchHistoryTitles(jin, extractor().request, async () => organic([
        result('西晋皇族为何打掉统一天下', fixture.original, '司马家八王之乱'),
        result('西晋皇族内斗如何引发转折', alias, '司马家八王之乱'),
      ]))
      assert.equal(research.references.length, 1, alias)
      assert.equal(research.references[0]!.url, fixture.original)
      assert.equal(research.references[0]!.title, '西晋皇族为何打掉统一天下')
      assert.equal(research.queries.length, 6)
    }
  })

  test(`${fixture.platform}: three distinct articles are accepted while preserving source URLs and ignoring aliases`, async () => {
    const research = await researchHistoryTitles(jin, extractor().request, async () => organic([
      result('西晋皇族为何打掉统一天下', fixture.original, '司马家八王之乱'),
      ...fixture.aliases.map((alias, index) => result(`西晋皇族的别名标题${index}`, alias, '司马家八王之乱')),
      result('司马家统一之后怎么打了起来', fixture.second, '西晋皇族八王之乱'),
      result('西晋皇族怎样把天下打散', fixture.third, '司马家八王之乱'),
    ]))
    assert.equal(research.references.length, 3)
    assert.deepEqual(research.references.map(item => item.url), [fixture.original, fixture.second, fixture.third])
    assert.deepEqual(research.references.map(item => item.id), ['R1', 'R2', 'R3'])
  })

  test(`${fixture.platform}: stored research schema rejects duplicate article identities, not only equal URL strings`, async () => {
    const searches = topicSearch()
    const research = await researchHistoryTitles(jin, extractor().request, searches.search)
    const seed = research.references[0]!
    for (const alias of fixture.aliases) {
      const duplicated = { ...research, references: [
        { ...seed, id: 'R1', title: '西晋皇族为何打掉统一天下', url: fixture.original, platform: fixture.platform },
        { ...seed, id: 'R2', title: '西晋皇族内斗如何引发转折', url: alias, platform: fixture.platform },
      ] }
      assert.equal(historyTitleResearchSchema.safeParse(duplicated).success, false, alias)
      duplicated.references[1]!.url = fixture.second
      assert.equal(historyTitleResearchSchema.safeParse(duplicated).success, true, fixture.second)
    }
  })
}

test('unwraps actual MiniMax JSON, MCP text and structuredContent envelopes', async () => {
  const wrappers = [
    (data: unknown) => data,
    (data: unknown) => JSON.stringify(data),
    (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    (data: unknown) => ({ structuredContent: data }),
  ]
  for (const wrap of wrappers) {
    const searches = topicSearch()
    const research = await researchHistoryTitles(jin, extractor().request, async query => wrap(await searches.search(query)))
    assert.equal(research.references.length, 4)
  }
})

test('malformed search responses, MCP errors and provider status failures produce sanitized empty research', async () => {
  for (const invalid of [
    'not JSON',
    { organic: 'wrong type' },
    { results: [] },
    { content: [{ type: 'text', text: 'secret-auth-token raw error' }], isError: true },
    { organic: [], base_resp: { status_code: 1004, status_msg: 'secret-auth-token' } },
  ]) {
    let searches = 0
    const research = await researchHistoryTitles(jin, extractor().request, async () => {
      searches++
      return invalid
    })
    assert.equal(searches, 6)
    assert.deepEqual(research.references, [])
    assert.ok(research.queries.every(query => query.status === 'error' && query.message))
    assert.doesNotMatch(JSON.stringify(research), /secret-auth-token/)
    assert.deepEqual(historyTitleResearchSchema.parse(research), research)
  }
})

test('all search transport failures preserve an empty snapshot with sanitized per-query errors', async () => {
  let searches = 0
  const research = await researchHistoryTitles(jin, extractor().request, async () => {
    searches++
    throw new Error('Authorization: secret-search-token')
  })
  assert.equal(searches, 6)
  assert.deepEqual(research.keywords, jin.groups)
  assert.deepEqual(research.references, [])
  assert.equal(research.queries.length, 6)
  assert.ok(research.queries.every(query => query.status === 'error' && query.message))
  assert.doesNotMatch(JSON.stringify(research), /secret-search-token|Authorization/)
  assert.deepEqual(historyTitleResearchSchema.parse(research), research)
})

test('a missing platform is explicitly recorded and searched once more without the site operator', async () => {
  const queries: string[] = []
  const research = await researchHistoryTitles(jin, extractor().request, async query => {
    queries.push(query)
    if (!query.includes('site:toutiao.com')) return organic([])
    return organic([
      result('西晋皇族为何打掉统一天下', 'https://www.toutiao.com/article/50/', '八王之乱'),
      result('司马家统一之后怎么打了起来', 'https://www.toutiao.com/article/51/', '西晋皇族八王之乱'),
      result('西晋皇族怎样把天下打散', 'https://www.toutiao.com/article/52/', '司马家八王之乱'),
    ])
  })
  assert.equal(queries.length, 5)
  assert.ok(queries.some(query => query.includes('百家号') && !query.includes('site:')))
  assert.ok(research.references.every(item => item.platform === 'toutiao'))
  assert.equal(research.queries.filter(item => item.platform === 'baijiahao').length, 3)
  assert.ok(research.queries.filter(item => item.platform === 'baijiahao').every(item => item.status === 'empty'))
})

test('platform fallback can find official legacy Baijiahao article URLs but not arbitrary Baidu pages', async () => {
  const research = await researchHistoryTitles(jin, extractor().request, async query => {
    if (query.includes('site:toutiao.com')) return organic([
      result('西晋皇族为何打掉统一天下', 'https://www.toutiao.com/article/60/', '八王之乱'),
    ])
    if (query.includes('site:')) return organic([])
    return organic([
      result('西晋司马家为何走到这一步', 'https://baijia.baidu.com/s?id=1647086599135641003&wfr=pc', '八王之乱'),
      result('西晋皇族怎样把天下打散', 'https://baijiahao.baidu.com/s?id=61', '司马家八王之乱'),
      result('西晋百科条目不能冒充标题参考', 'https://baike.baidu.com/item/西晋', '八王之乱'),
    ])
  })
  assert.equal(research.references.length, 3)
  assert.ok(research.references.some(item => item.platform === 'baijiahao' && new URL(item.url).hostname === 'baijia.baidu.com'))
  assert.equal(research.queries.at(-1)!.status, 'ok')
})

test('partial search errors are retained as sanitized errors while valid references remain usable', async () => {
  const research = await researchHistoryTitles(jin, extractor().request, async query => {
    if (!query.includes('site:toutiao.com')) throw new Error('Authorization: secret-auth-token')
    return organic([
      result('西晋皇族为何打掉统一天下', 'https://www.toutiao.com/article/70/', '八王之乱'),
      result('司马家统一之后怎么打了起来', 'https://www.toutiao.com/article/71/', '西晋皇族八王之乱'),
      result('西晋皇族怎样把天下打散', 'https://www.toutiao.com/article/72/', '司马家八王之乱'),
    ])
  })
  assert.equal(research.references.length, 3)
  assert.ok(research.queries.filter(item => item.platform === 'baijiahao').every(item => item.status === 'error' && item.message))
  assert.doesNotMatch(JSON.stringify(research), /secret-auth-token|Authorization/)
})

test('fresh research preserves zero, one or two references for graceful generation fallback', async () => {
  for (const count of [0, 1, 2]) {
    const research = await researchHistoryTitles(jin, extractor().request, async () => organic(Array.from({ length: count }, (_, index) =>
      result(`西晋皇族为何打掉统一天下之${index}`, `https://www.toutiao.com/article/${80 + index}/`, '八王之乱'))))
    assert.equal(research.references.length, count)
    assert.equal(research.queries.length, 6)
    assert.deepEqual(historyTitleResearchSchema.parse(research), research)
  }
})

test('two initial references trigger bounded fallback on both platforms even when neither platform is missing', async () => {
  const queries: string[] = []
  const research = await researchHistoryTitles(jin, extractor().request, async query => {
    queries.push(query)
    if (query.includes('site:toutiao.com')) return organic([
      result('西晋皇族为何打掉统一天下', 'https://www.toutiao.com/article/90', '司马家八王之乱'),
    ])
    if (query.includes('site:baijiahao.baidu.com')) return organic([
      result('司马家统一之后怎么打了起来', 'https://baijiahao.baidu.com/s?id=91', '西晋皇族八王之乱'),
    ])
    return organic(query.includes('今日头条') ? [
      result('西晋皇族怎样把天下打散', 'https://www.toutiao.com/article/92', '司马家八王之乱'),
    ] : [])
  })
  assert.equal(queries.length, 6)
  assert.equal(research.references.length, 3)
  assert.equal(research.queries.filter(query => !query.query.includes('site:')).length, 2)
})

test('stored two-reference research remains readable for historical review records', async () => {
  const searches = topicSearch()
  const research = await researchHistoryTitles(jin, extractor().request, searches.search)
  research.references = research.references.slice(0, 2)
  assert.deepEqual(historyTitleResearchSchema.parse(research), research)
})

test('search concurrency stays at two and returned references are capped at sixteen', async () => {
  let active = 0
  let maximum = 0
  let serial = 0
  const research = await researchHistoryTitles(jin, extractor().request, async query => {
    active++
    maximum = Math.max(maximum, active)
    const batch = serial++
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    const host = query.includes('site:toutiao.com') ? 'toutiao' : 'baijiahao'
    return organic(Array.from({ length: 10 }, (_, index) => {
      const id = 100 + batch * 10 + index
      return result(`西晋皇族的标题对照样本${id}`, host === 'toutiao'
        ? `https://www.toutiao.com/article/${id}/` : `https://baijiahao.baidu.com/s?id=${id}`, '司马家八王之乱')
    }))
  })
  assert.equal(maximum, 2)
  assert.equal(active, 0)
  assert.equal(research.references.length, 16)
})

test('default search uses fixed executable and argument slots with no shell and bounded execution', async () => {
  const calls: { file: unknown; args: string[]; options: Record<string, unknown> }[] = []
  const stub = mock.method(childProcess, 'execFile', ((file: unknown, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, args, options })
    const query = JSON.parse(args[args.indexOf('--args') + 1]!).query as string
    const domain = query.includes('site:toutiao.com') ? 'toutiao' : 'baijiahao'
    const id = 200 + calls.length
    callback(null, JSON.stringify(organic([result(`西晋皇族的检索标题${id}`, domain === 'toutiao'
      ? `https://www.toutiao.com/article/${id}/` : `https://baijiahao.baidu.com/s?id=${id}`, '司马家八王之乱')])), '')
    return {} as ReturnType<typeof childProcess.execFile>
  }) as unknown as typeof childProcess.execFile)
  try {
    const research = await researchHistoryTitles(jin, extractor().request)
    assert.equal(research.references.length, 4)
    assert.equal(calls.length, 4)
    for (const call of calls) {
      assert.equal(call.file, 'mcporter')
      assert.deepEqual(call.args.slice(0, 3), ['call', 'MiniMax.web_search', '--args'])
      assert.deepEqual(call.args.slice(4), ['--output', 'json', '--timeout', '25000', '--no-oauth'])
      assert.equal(call.options.timeout, 35000)
      assert.equal(call.options.maxBuffer, 2 * 1024 * 1024)
      assert.equal(call.options.shell, false)
      assert.equal(call.options.encoding, 'utf8')
      assert.ok(!JSON.stringify(call.args).includes(jin.script))
    }
  } finally {
    stub.mock.restore()
  }
})

test('default command failures preserve sanitized query errors without exposing stderr or credentials', async () => {
  let calls = 0
  const stub = mock.method(childProcess, 'execFile', ((_file: unknown, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls++
    callback(new Error('Authorization: secret-cli-token'), '', 'secret-cli-token from stderr')
    return {} as ReturnType<typeof childProcess.execFile>
  }) as unknown as typeof childProcess.execFile)
  try {
    const research = await researchHistoryTitles(jin, extractor().request)
    assert.equal(calls, 6)
    assert.deepEqual(research.references, [])
    assert.ok(research.queries.every(query => query.status === 'error' && query.message))
    assert.doesNotMatch(JSON.stringify(research), /Authorization|secret-cli-token|stderr/)
  } finally {
    stub.mock.restore()
  }
})
