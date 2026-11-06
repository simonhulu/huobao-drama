const MAX_HTML_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

/** Only canonical public article URLs are allowed; tracking parameters are discarded. */
export function normalizeBaijiahaoArticleUrl(value: string): { articleId: string; url: string } {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('百家号文章链接格式不正确') }
  const ids = parsed.searchParams.getAll('id')
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'baijiahao.baidu.com'
    || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/s'
    || ids.length !== 1 || !/^\d{10,24}$/.test(ids[0]!)) {
    throw new Error('仅支持 https://baijiahao.baidu.com/s?id=文章编号 链接')
  }
  return { articleId: ids[0]!, url: `https://baijiahao.baidu.com/s?id=${ids[0]}` }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

// Extract a JSON object without evaluating any of the surrounding remote JavaScript.
function jsonObjectAt(source: string, start: number): unknown {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)) } catch { return undefined }
    }
  }
  return undefined
}

function plainText(value: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ensp: ' ', emsp: ' ', ndash: '–', mdash: '—', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
  }
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|h[1-6]|li|blockquote)\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
      if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? match
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : match
    })
    .replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function extractArticle(html: string, articleId: string): { text: string; title?: string } {
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const source = script[1]!
    const assignment = /\bwindow\.jsonData\s*=\s*(\{)/.exec(source)
    if (!assignment) continue
    const data = object(jsonObjectAt(source, assignment.index + assignment[0].length - 1))
    const items = object(data?.bsData)?.superlanding
    if (!Array.isArray(items)) continue
    const articles = items.map(object).filter(item => item?.itemType === 'article')
    if (articles.length !== 1) continue
    const article = object(articles[0]?.itemData)
    const readSource = object(article?.readsrc)
    if (typeof readSource?.link === 'string') {
      // Baidu embeds its own historical http URL even when served over https.
      let embedded: URL
      try { embedded = new URL(readSource.link) } catch { throw new Error('百家号正文来源校验失败') }
      if (embedded.hostname !== 'baijiahao.baidu.com' || embedded.pathname !== '/s'
        || embedded.searchParams.get('id') !== articleId) throw new Error('百家号正文与请求文章不一致')
    }
    if (!Array.isArray(article?.sections)) continue
    const paragraphs: string[] = []
    for (const value of article.sections) {
      const section = object(value)
      if (!section) throw new Error('百家号正文结构不完整，未保存文章')
      if (section.type === 'img') {
        if (typeof section.caption === 'string' && section.caption.trim()) paragraphs.push(plainText(section.caption))
        continue
      }
      if (section.type !== 'text') throw new Error('百家号文章包含暂不支持的正文结构，未保存不完整文章')
      const content = typeof section.content === 'string' ? section.content : section.data_html
      if (typeof content !== 'string') throw new Error('百家号正文结构不完整，未保存文章')
      const text = plainText(content)
      if (text) paragraphs.push(text)
    }
    const text = paragraphs.join('\n\n')
    const title = typeof article.header === 'string' ? plainText(article.header) : undefined
    if (text.replace(/\s/g, '').length < 100 || text === title) {
      throw new Error('百家号未返回足够的文章正文，可能仅有标题或正文受限')
    }
    return { text, ...(title ? { title } : {}) }
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  if (/百度安全验证|安全验证|访问验证|验证码|登录|人机验证/.test(title)) {
    throw new Error('百家号要求登录或安全验证，请在原站处理后重试')
  }
  throw new Error('未找到百家号完整正文，文章可能已下线、受限或页面结构已变化')
}

async function readBoundedHtml(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) {
    await response.body?.cancel()
    throw new Error('百家号文章页面过大，已停止读取')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('百家号返回空页面')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_HTML_BYTES) {
        await reader.cancel()
        throw new Error('百家号文章页面过大，已停止读取')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

/** Public article request. No authentication Cookie is accepted or forwarded. */
export async function fetchBaijiahaoArticle(
  input: string,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<{ text: string; title?: string }> {
  const canonical = normalizeBaijiahaoArticleUrl(input)
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const fetchFn = options.fetchFn ?? fetch
  let url = canonical.url
  try {
    signal.throwIfAborted()
    for (let redirects = 0; redirects <= 3; redirects++) {
      let response: Response
      try {
        response = await fetchFn(url, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal,
          headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        })
      } catch { throw new Error('百家号正文请求失败，请稍后重试') }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || redirects === 3) throw new Error('百家号文章重定向异常')
        let next: ReturnType<typeof normalizeBaijiahaoArticleUrl>
        try { next = normalizeBaijiahaoArticleUrl(new URL(location, url).href) }
        catch { throw new Error('百家号文章跳转至非文章页面，可能需要安全验证') }
        if (next.articleId !== canonical.articleId) throw new Error('百家号文章重定向到其他文章，已停止读取')
        url = next.url
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`百家号正文请求失败（HTTP ${response.status}）`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        await response.body?.cancel()
        throw new Error('百家号未返回文章网页')
      }
      const html = await readBoundedHtml(response)
      signal.throwIfAborted()
      return extractArticle(html, canonical.articleId)
    }
    throw new Error('百家号文章重定向异常')
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('已取消文章采集', 'AbortError')
    if (timeout.aborted) throw new Error('百家号正文读取超时，请稍后重试')
    // Never surface fetch internals, response bodies, or remote script errors.
    if (error instanceof Error && /^(百家号|未找到百家号)/.test(error.message)) throw error
    throw new Error('百家号正文读取失败，请稍后重试')
  }
}
