import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectCzgtsArticles, createCzgtsCredentialStore, CzgtsSourceError, czgtsTimeRangeSchema, normalizeCzgtsCookie, searchCzgtsArticles, shanghaiDateTime, type CzgtsCollectedArticle } from './history-source-czgts.js'

const range = { startTime: '2026-10-20 15:44:23', endTime: '2026-10-21 15:44:23' }
const row = (id: string, extra = {}) => ({ gid: `9${id}`, url: `https://baijiahao.baidu.com/s?id=${id}`, title: `历史文章${id}`, authorName: '作者', platform: '百家号', category: '历史', publishTime: '2026-10-20 16:00', keywords: ['明朝'], readCnt: '10886', diggCnt: '232', commentCnt: '3', fans: '-1', ...extra })
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

test('search sends the observed fixed article contract to CZGTS only, not browser transport headers', async () => {
  let request: RequestInit | undefined
  const data = await searchCzgtsArticles({ ...range, offset: 50, searchId: 'search-1' }, { cookie: 'sessionid=TEST-SECRET', fetchFn: async (url, init) => {
    assert.equal(url, 'https://www.czgts.cn/muse/content/api/v1/hots/search?appVersion=')
    request = init
    return response({ code: 0, total: 51, list: [row('1879511407398993709')], searchId: 'search-1' })
  } })
  assert.equal(data.total, 51)
  assert.equal(request?.redirect, 'error')
  const headers = new Headers(request?.headers)
  assert.equal(headers.get('cookie'), 'sessionid=TEST-SECRET')
  assert.equal(headers.has('content-length'), false)
  assert.deepEqual(JSON.parse(String(request?.body)), { ...range, limit: 50, offset: 50, searchId: 'search-1', postType: 1, platforms: ['百家号'], categories: ['历史'], articleGenres: ['文章'], sortBy: 2, fansLimits: '', readLimits: '', videoDurationLimits: '' })
})

test('search errors classify expired login, never expose response/transport credentials, and reject malformed lists', async () => {
  const cases: Array<[() => Promise<Response>, string]> = [
    [async () => response({}, 401), 'login_required'],
    [async () => response({ code: 7, message: 'session expired TEST-SECRET' }), 'login_required'],
    [async () => response({ code: 9, message: 'TEST-SECRET' }), 'upstream'],
    [async () => { throw new Error('cookie=sessionid=TEST-SECRET') }, 'network'],
    [async () => response({ code: 0, total: 1, list: 'bad', searchId: 'one' }), 'invalid_response'],
    [async () => new Response('not json TEST-SECRET'), 'invalid_response'],
    [async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'invalid_response'],
  ]
  for (const [fetchFn, code] of cases) {
    await assert.rejects(searchCzgtsArticles(range, { cookie: 'sessionid=TEST-SECRET', fetchFn }), error => {
      assert.ok(error instanceof CzgtsSourceError)
      assert.equal(error.code, code)
      assert.equal(error.message.includes('TEST-SECRET'), false)
      return true
    })
  }
})

test('cookie store is private and write-only in status, rejecting symlink targets and invalid cookies without overwriting', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'czgts-credentials-')))
  const file = path.join(directory, 'private', 'credentials.json')
  const store = createCzgtsCredentialStore(file)
  assert.deepEqual(await store.status(), { configured: false, updatedAt: null })
  assert.equal(normalizeCzgtsCookie('Cookie: sessionid=TEST-SECRET; a=b==;'), 'sessionid=TEST-SECRET; a=b==')
  const saved = await store.save('sessionid=TEST-SECRET')
  assert.deepEqual(await store.status(), saved)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700)
  const old = await readFile(file, 'utf8')
  for (const value of ['', 'bad', 'sessionid=a\r\nX-Evil: yes', 'a=中文']) await assert.rejects(store.save(value), /Cookie/)
  assert.equal(await readFile(file, 'utf8'), old)
  const victim = path.join(directory, 'victim.json')
  await writeFile(victim, 'unchanged')
  const link = path.join(directory, 'linked.json')
  await symlink(victim, link)
  await assert.rejects(createCzgtsCredentialStore(link).save('a=b'), /配置/)
  assert.equal(await readFile(victim, 'utf8'), 'unchanged')
})

test('time range uses Shanghai and rejects nonexistent calendar dates and reversed ranges', () => {
  assert.equal(shanghaiDateTime(new Date('2026-10-21T08:00:00Z')), '2026-10-21 16:00:00')
  assert.ok(czgtsTimeRangeSchema.safeParse(range).success)
  assert.equal(czgtsTimeRangeSchema.safeParse({ startTime: '2026-02-30 00:00:00', endTime: range.endTime }).success, false)
  assert.equal(czgtsTimeRangeSchema.safeParse({ startTime: range.endTime, endTime: range.startTime }).success, false)
})

test('pagination reuses returned searchId and raw offset, deduplicates articles, skips known sources and preserves metrics/full text', async () => {
  const saved: CzgtsCollectedArticle[] = [], requests: unknown[] = [], stages: string[] = []
  const one = '1879511407398993709', two = '1879578871894669746', three = '1879510454824840755'
  const pages = [[row(one), row(two)], [row(two), row(three)]]
  await collectCzgtsArticles({ ...range, signal: new AbortController().signal, targetCount: null,
    isKnownArticle: id => id === one, onArticle: async article => { saved.push(article) }, report: event => stages.push(event.stage),
  }, { pauseMs: 0, search: async input => { requests.push(input); return { code: 0, total: 4, list: pages[requests.length - 1]!, searchId: 'stable-search' } },
    fetchArticle: async url => ({ title: '原站标题', text: `完整正文第一段\n\n第二段 ${url}` }),
  })
  assert.deepEqual(requests, [{ ...range, offset: 0, searchId: '' }, { ...range, offset: 2, searchId: 'stable-search' }])
  assert.deepEqual(saved.map(article => article.articleId), [two, three])
  assert.equal(saved[0]!.metadata.reads, 10886)
  assert.equal(saved[0]!.metadata.fans, undefined)
  assert.equal(saved[0]!.title, '原站标题')
  assert.match(saved[0]!.text, /第一段\n\n第二段/)
  assert.equal(stages.at(-1), 'exhausted')
})

test('failed or foreign article links never become imported; target counts actual full articles', async () => {
  const fetched: string[] = [], imported: string[] = [], stages: string[] = []
  const failed = '1879511407398993709', success = '1879578871894669746'
  await collectCzgtsArticles({ ...range, signal: new AbortController().signal, targetCount: 1,
    isKnownArticle: () => false, onArticle: async article => { imported.push(article.articleId) }, report: event => stages.push(event.stage),
  }, { pauseMs: 0,
    search: async () => ({ code: 0, total: 100, searchId: 'id', list: [row(failed, {url:'http://127.0.0.1/private'}), row(failed), row(success), row('1879510454824840755')] }),
    fetchArticle: async url => { fetched.push(url); if (url.includes(failed)) throw new Error('private details'); return { text: 'complete original' } },
  })
  assert.equal(fetched.length, 2)
  assert.deepEqual(imported, [success])
  assert.ok(stages.includes('article_failed'))
})

test('false processing acknowledgements do not consume the target; true and legacy void stop collection immediately', async () => {
  for (const accepted of [true, undefined]) {
    const first = '1879511407398993709', second = '1879578871894669746', unused = '1879510454824840755'
    const fetched: string[] = [], processed: string[] = [], stages: string[] = []
    let searches = 0
    await collectCzgtsArticles({ ...range, signal: new AbortController().signal, targetCount: 1,
      isKnownArticle: () => false,
      onArticle: async article => { processed.push(article.articleId); return article.articleId === first ? false : accepted },
      report: event => stages.push(event.stage),
    }, { pauseMs: 0,
      search: async () => {
        assert.equal(++searches, 1, 'No further pages after reaching the successful processing target')
        return { code: 0, total: 100, searchId: 'id', list: [row(first), row(second), row(unused)] }
      },
      fetchArticle: async url => { fetched.push(url); return { text: '完整原文' } },
    })
    assert.deepEqual(processed, [first, second])
    assert.equal(fetched.length, 2)
    assert.equal(stages.includes('article_failed'), false, 'Processing refusal must not be called a body retrieval failure')
    assert.equal(stages.includes('exhausted'), false)
  }
})

test('exhaustion reports completed processing rather than calling declined callbacks saved originals', async () => {
  const messages: string[] = []
  await collectCzgtsArticles({ ...range, signal: new AbortController().signal, targetCount: 2,
    isKnownArticle: () => false, onArticle: async () => false, report: event => messages.push(event.message),
  }, { pauseMs: 0,
    search: async () => ({ code: 0, total: 1, searchId: 'id', list: [row('1879511407398993709')] }),
    fetchArticle: async () => ({ text: '已保存但未完成二创的原文' }),
  })
  assert.match(messages.at(-1)!, /完成 0 篇文章处理/)
  assert.doesNotMatch(messages.at(-1)!, /保存 1 篇/)
})

test('cancellation from article processing is propagated before target success or fetching another item', async () => {
  const controller = new AbortController()
  let fetched = 0
  await assert.rejects(collectCzgtsArticles({ ...range, signal: controller.signal, targetCount: 1,
    isKnownArticle: () => false,
    onArticle: async () => { controller.abort(new Error('stop during processing')); return true }, report: () => {},
  }, { pauseMs: 0,
    search: async () => ({ code: 0, total: 2, searchId: 'id', list: [row('1879511407398993709'), row('1879578871894669746')] }),
    fetchArticle: async () => { fetched++; return { text: '完整原文' } },
  }), /stop during processing/)
  assert.equal(fetched, 1)
})

test('repeated or prematurely empty pages cannot falsely claim exhaustion or loop indefinitely', async () => {
  for (const empty of [false, true]) {
    let calls = 0
    await assert.rejects(collectCzgtsArticles({ ...range, signal: new AbortController().signal, targetCount: null,
      isKnownArticle: () => true, onArticle: async () => { assert.fail('known articles must not import') }, report: () => {},
    }, { pauseMs: 0, search: async () => ({ code: 0, total: 100, list: ++calls > 1 && empty ? [] : [row('1879511407398993709')], searchId: 'id' }) }), /分页/)
    assert.equal(calls, 2)
  }
})

test('cancellation during body retrieval prevents an import and never becomes a skipped source', async () => {
  const controller = new AbortController(), events: string[] = []
  await assert.rejects(collectCzgtsArticles({ ...range, signal: controller.signal, targetCount: 1,
    isKnownArticle: () => false, onArticle: async () => assert.fail('aborted article must not be saved'), report: event => events.push(event.stage),
  }, { pauseMs: 0, search: async () => ({ code: 0, total: 1, list: [row('1879511407398993709')], searchId: 'id' }),
    fetchArticle: async (_url, options) => { assert.equal(options?.signal, controller.signal); controller.abort(new Error('test-stop')); throw new Error('upstream') },
  }), /test-stop/)
  assert.equal(events.includes('article_failed'), false)
})

test('persistence failure propagates instead of reporting a successful article', async () => {
  await assert.rejects(collectCzgtsArticles({ ...range, signal: new AbortController().signal, targetCount: 1,
    isKnownArticle: () => false, onArticle: async () => { throw new Error('storage failure') }, report: () => {},
  }, { pauseMs: 0, search: async () => ({ code: 0, total: 1, list: [row('1879511407398993709')], searchId: 'id' }), fetchArticle: async () => ({ text: 'full original' }) }), /storage failure/)
})
