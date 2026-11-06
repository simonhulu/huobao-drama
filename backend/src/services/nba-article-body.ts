import { parseHTML } from 'linkedom'

export interface NbaArticleBody {
  body: string
  changed: boolean
  removedCharacters: number
  removedSections: string[]
  safe: boolean
  issues: string[]
}

const footerBoundary = /^(?:特别声明\s*[：:]\s*以上文章内容|权利保护声明页(?:\s*\/\s*Notice to Right Holders)?|(?:相关新闻|相关推荐|推荐阅读|相关阅读|阅读排行榜|评论排行榜|图片新闻|视频新闻|新媒体实验室)\s*[:：]?\s*$|点击进入专题\s*[：:]|责任编辑\s*[：:]|举报邮箱\s*[：:]|投资热点尽在.{0,40}APP|Copyright\s*(?:©|\(c\)|\d)|All Rights Reserved\b|SINA English\s*$|Related (?:articles|stories|coverage)\s*$|Recommended (?:articles|stories|for you)\s*$|Most (?:Read|Popular)\s*$|See AP['’]s full NBA coverage here|AP NBA:\s*https?:\/\/)/i
const residualNoise = /特别声明\s*[：:]\s*以上文章内容|权利保护声明页|Notice to Right Holders|投资热点尽在.{0,40}APP|举报邮箱\s*[：:]|Copyright\s*(?:©|\(c\)|\d)|All Rights Reserved\s+新浪公司|SINA Corporation/i

/** Remove publisher furniture from a saved body without rewriting its reporting. */
export function cleanNbaArticleBody(value: string): NbaArticleBody {
  const paragraphs = value.replace(/\r\n?/g, '\n').split(/\n+/).map(part => part.trim()).filter(Boolean)
  const removedSections: string[] = [], kept: string[] = []
  for (const paragraph of paragraphs) {
    if (footerBoundary.test(paragraph)) { removedSections.push(paragraph.slice(0, 100)); break }
    if (/^(?:广告|Advertisement|ADVERTISEMENT|Sponsored content)\s*$/i.test(paragraph)
      || !kept.length && /^(?:来源|文章来源|作者|责编)\s*[：:].{1,100}$/.test(paragraph)) {
      removedSections.push(paragraph.slice(0, 100)); continue
    }
    kept.push(paragraph)
  }
  const body = kept.join('\n\n')
  const issues = !body ? ['未取得独立文章正文'] : residualNoise.test(body) ? ['正文仍包含网站声明、推荐或版权模板'] : []
  return { body, changed: body !== value, removedCharacters: Math.max(0, value.length - body.length), removedSections, safe: issues.length === 0, issues }
}

const ignoredElements = 'script,style,noscript,template,figure,aside,nav,footer,form,button,iframe,video,audio,ins,[hidden],[aria-hidden="true"],.article-notice,.show_author,.wap_special,.img_wrapper,.advertisement,.ad,.top-ad,.related-news,.related-articles,.related-stories,.recommended,.recommendations,.comments,.comment-list,.article-content-right,.copy-right,.report-infor'
const blocks = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'table', 'tr'])

function textFromHtml(html: string) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  for (const node of document.querySelectorAll(ignoredElements)) node.remove()
  const render = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const tag = (node as Element).localName
    if (tag === 'br') return '\n'
    const content = [...node.childNodes].map(render).join('')
    return blocks.has(tag) ? `\n\n${content}\n\n` : content
  }
  return [...document.body.childNodes].map(render).join('').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

/** Select a bounded article element, never the document's full visible text. */
export function extractNbaArticleBody(html: string, structuredBody?: string): NbaArticleBody & { method: string } {
  const { document } = parseHTML(html)
  const selectors = ['#artibody', '#article', '[itemprop="articleBody"]', '.article-body', '.articleBody', '.story-body', '.story__body', '.caas-body', '.article-content', 'article']
  let selected: Element | null = null, selector = ''
  for (const candidate of selectors) {
    selected = document.querySelector(candidate)
    if (selected) { selector = candidate; break }
  }
  // Specific publisher body elements exclude sidebars that broad page wrappers include.
  const useElement = selected && ['#artibody', '#article', '[itemprop="articleBody"]'].includes(selector)
  const original = useElement ? selected!.innerHTML : structuredBody || selected?.innerHTML || ''
  const method = useElement ? `dom:${selector}` : structuredBody ? 'json-ld:articleBody' : selected ? `dom:${selector}` : 'missing-article'
  const cleaned = cleanNbaArticleBody(textFromHtml(original))
  return { ...cleaned, method }
}
