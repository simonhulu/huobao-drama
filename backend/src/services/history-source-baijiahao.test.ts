import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchBaijiahaoArticle, normalizeBaijiahaoArticleUrl } from './history-source-baijiahao.js'

const url = 'https://baijiahao.baidu.com/s?id=1879511407398993709'
const first = '这是第一段原文，保持作者原有的叙述逻辑、标点和顺序，不增加外部信息。'.repeat(3)
const last = '这是最后一段原文，必须保留到正文末尾，不要混入推荐文章和评论。'.repeat(3)
const sections = [{ type: 'text', content: first }, { type: 'img', link: 'https://example.com/image.jpg', caption: '' }, { type: 'text', content: last }]
function html(parts: unknown[] = sections, extras: Record<string, unknown> = {}) {
  return `<title>文章</title><nav>推荐导航</nav><script>window.jsonData = ${JSON.stringify({
    bsData: { superlanding: [{ itemType: 'article', itemData: { header: '历史文章', sections: parts, readsrc: { link: url }, ...extras } }] },
  }).replace(/<\//g, '<\\/')};window.firstScreenTime=Date.now();globalThis.__articleExecuted=true;</script><footer>广告评论</footer>`
}
const response = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
const fromHtml = (body: string) => fetchBaijiahaoArticle(url, { fetchFn: async () => response(body) })

test('canonicalizes only public Baijiahao article URLs', () => {
  assert.deepEqual(normalizeBaijiahaoArticleUrl(`${url}&from=share#top`), { articleId: '1879511407398993709', url })
  for (const invalid of ['http://baijiahao.baidu.com/s?id=1234567890', 'https://baijiahao.baidu.com.evil.test/s?id=1234567890',
    'https://baijiahao.baidu.com@localhost/s?id=1234567890', 'https://baijiahao.baidu.com:123/s?id=1234567890',
    'https://baijiahao.baidu.com/other?id=1234567890', `${url}&id=1234567890`, `${url}abc`, 'file:///etc/passwd']) {
    assert.throws(() => normalizeBaijiahaoArticleUrl(invalid))
  }
})

test('extracts only article sections in order without executing remote JavaScript', async () => {
  const article = await fromHtml(html())
  assert.deepEqual(article, { title: '历史文章', text: `${first}\n\n${last}` })
  assert.equal((globalThis as Record<string, unknown>).__articleExecuted, undefined)
})

test('handles escaped JSON braces, formatting, entities and image captions in article order', async () => {
  const article = await fromHtml(html([
    { type: 'text', content: `<b>${first}</b> &amp; &#x4e2d; &#25991; {"引号"}` },
    { type: 'img', caption: '原文图注' },
    { type: 'text', data_html: `<p>${last}</p><script>alert(1)</script>` },
  ]))
  assert.equal(article.text, `${first} & 中 文 {"引号"}\n\n原文图注\n\n${last}`)
})

test('does not use page body, recommendations, title-only or unsupported partial content as article', async () => {
  await assert.rejects(fromHtml(`<title>文章</title><body>${first}${last}</body>`), /未找到百家号完整正文/)
  await assert.rejects(fromHtml(html([{ type: 'text', content: '历史文章' }])), /正文/)
  await assert.rejects(fromHtml(html([...sections, { type: 'unknown', content: '额外正文' }])), /不支持的正文结构/)
  await assert.rejects(fromHtml(html([{ type: 'text' }])), /结构不完整/)
  await assert.rejects(fromHtml('<title>百度安全验证</title><p>请完成验证</p>'), /要求登录或安全验证/)
  await assert.rejects(fromHtml('<script>window.jsonData = {broken};</script>'), /未找到/)
})

test('rejects mismatched embedded article identity', async () => {
  await assert.rejects(fromHtml(html(sections, { readsrc: { link: 'http://baijiahao.baidu.com/s?id=1879578871894669746' } })), /不一致/)
})

test('never sends authentication cookies and uses manual redirect handling', async () => {
  await fetchBaijiahaoArticle(url, { fetchFn: async (input, init) => {
    assert.equal(input, url)
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.redirect, 'manual')
    assert.equal(new Headers(init?.headers).has('cookie'), false)
    return response(html())
  } })
})

test('allows same-article redirects but blocks outside hosts and different articles before fetching', async () => {
  let calls = 0
  const result = await fetchBaijiahaoArticle(url, { fetchFn: async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: '/s?id=1879511407398993709&from=redirect' } }) : response(html()) })
  assert.equal(calls, 2)
  assert.equal(result.text, `${first}\n\n${last}`)
  for (const location of ['http://127.0.0.1/secrets', 'https://passport.baidu.com/login', '/s?id=1879578871894669746']) {
    calls = 0
    await assert.rejects(fetchBaijiahaoArticle(url, { fetchFn: async () => {
      calls++
      return new Response(null, { status: 302, headers: { location } })
    } }), /跳转|其他文章/)
    assert.equal(calls, 1)
  }
})

test('limits redirect loops', async () => {
  let calls = 0
  await assert.rejects(fetchBaijiahaoArticle(url, { fetchFn: async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: url } })
  } }), /重定向异常/)
  assert.equal(calls, 4)
})

test('checks status and format without echoing remote response or network error content', async () => {
  await assert.rejects(fetchBaijiahaoArticle(url, { fetchFn: async () => new Response('REMOTE_SECRET', { status: 403 }) }), { message: '百家号正文请求失败（HTTP 403）' })
  await assert.rejects(fetchBaijiahaoArticle(url, { fetchFn: async () => new Response('REMOTE_SECRET', { headers: { 'content-type': 'application/json' } }) }), /未返回文章网页/)
  await assert.rejects(fetchBaijiahaoArticle(url, { fetchFn: async () => { throw new Error('REMOTE_SECRET') } }), { message: '百家号正文请求失败，请稍后重试' })
})

test('bounds declared and actual streamed HTML sizes', async () => {
  await assert.rejects(fetchBaijiahaoArticle(url, { fetchFn: async () => new Response('', { headers: { 'content-type': 'text/html', 'content-length': '5000000' } }) }), /页面过大/)
  await assert.rejects(fromHtml('x'.repeat(4 * 1024 * 1024 + 1)), /页面过大/)
})

test('preserves cancellation before and during fetching', async () => {
  const controller = new AbortController()
  controller.abort(new DOMException('已取消', 'AbortError'))
  let calls = 0
  await assert.rejects(fetchBaijiahaoArticle(url, { signal: controller.signal, fetchFn: async () => { calls++; return response(html()) } }), { name: 'AbortError' })
  assert.equal(calls, 0)
  const during = new AbortController()
  await assert.rejects(fetchBaijiahaoArticle(url, { signal: during.signal, fetchFn: async () => { during.abort(); throw new Error('network') } }), { name: 'AbortError' })
})
