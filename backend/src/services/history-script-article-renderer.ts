/** Components copied from gzh-design's red-white and common-components libraries.
 * The source prose is retained; only display punctuation and inline emphasis change.
 */
export interface ArticleParagraph {
  text: string
  highlights: string[]
  sourceEvidence: Array<{ quote: string; start: number; end: number }>
}
export interface ArticleSection { heading: string; paragraphs: ArticleParagraph[] }
export interface ArticleScreenshot { url: string; timestamp: number; sectionIndex: number }

export function escapeArticleHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

// Typographic normalization only. URLs and English identifiers retain their spelling.
export function articleTypography(value: string) {
  let doubleOpen = true
  let singleOpen = true
  return value.split(/(https?:\/\/[^\s<>]+|[A-Za-z0-9_]+(?:[.'-][A-Za-z0-9_]+)+)/g).map(part => {
    if (/^https?:\/\//.test(part) || /^[A-Za-z0-9_]+(?:[.'-][A-Za-z0-9_]+)+$/.test(part)) return part
    return part.replace(/[,.:;!?()]/g, char => ({ ',': '，', '.': '。', ':': '：', ';': '；', '!': '！', '?': '？', '(': '（', ')': '）' })[char]!)
      .replace(/"/g, () => { const mark = doubleOpen ? '“' : '”'; doubleOpen = !doubleOpen; return mark })
      .replace(/'/g, () => { const mark = singleOpen ? '‘' : '’'; singleOpen = !singleOpen; return mark })
  }).join('')
}

const leaf = (text: string) => `<span leaf="">${escapeArticleHtml(articleTypography(text))}</span>`
const normalizedLeaf = (text: string) => `<span leaf="">${escapeArticleHtml(text)}</span>`
const paragraph = (content: string) => `<p style="margin-bottom:20px;font-size:17px;line-height:1.9;text-align:justify;">${content}</p>`
const separator = '<section style="padding:0 10px;"><section style="height:1px;background:linear-gradient(to right,transparent,#FCA5A5,#DC2626,#FCA5A5,transparent);margin:0;"><span leaf=""><br></span></section></section>'

function highlighted(paragraph: ArticleParagraph, introduction = false) {
  // Normalize once before splitting: quotation pairs can straddle a highlight.
  // Every typographic replacement is one UTF-16 unit, so source offsets remain valid.
  const normalized = articleTypography(paragraph.text)
  const ranges = paragraph.highlights.map(text => ({ start: paragraph.text.indexOf(text), text }))
    .filter(item => item.start >= 0).sort((a, b) => a.start - b.start)
  let cursor = 0
  let html = ''
  for (const range of ranges) {
    if (range.start < cursor) continue
    html += normalizedLeaf(normalized.slice(cursor, range.start))
    html += `<span style="${introduction ? 'background:#FEE2E2;padding:1px 6px;border-radius:3px;font-weight:600;color:#991B1B;' : 'border-bottom:2px solid #FECACA;font-weight:600;'}">${normalizedLeaf(normalized.slice(range.start, range.start + range.text.length))}</span>`
    cursor = range.start + range.text.length
  }
  return html + normalizedLeaf(normalized.slice(cursor))
}

function screenshotHtml(screenshot: ArticleScreenshot) {
  if (!/^\/static\/history-articles\/\d+\/[a-f0-9-]+\/frame-\d+\.jpg$/.test(screenshot.url)) throw new Error('Invalid article image URL')
  return `<section style="background:#FFF;border-radius:12px;padding:6px;border:1px solid #E5E7EB;box-shadow:0 4px 12px -2px rgba(0,0,0,0.08);margin-bottom:10px;"><section style="margin:0;border-radius:8px;overflow:hidden;"><span leaf=""><img src="${escapeArticleHtml(screenshot.url)}" alt="配图" style="max-width:100%;height:auto;display:block;margin:0 auto;"></span></section></section>`
}

export function renderHistoryArticle(input: {
  title: string; sections: ArticleSection[]; screenshots: ArticleScreenshot[]
}) {
  const { sections, screenshots } = input
  const intro = sections[0]?.paragraphs[0]
  const blocks: string[] = []
  const introOnlyChapter = sections[0]?.paragraphs.length === 1
  const bodySections = sections.map((section, index) => ({ section, index })).filter(({ index }) => index !== 0 || !introOnlyChapter)
  // Move the first source paragraph into the introduction, without duplicating prose.
  if (intro) blocks.push(`<section style="margin:10px 10px 32px;background:#ffffff;border-radius:12px;box-shadow:0 4px 24px -4px rgba(220,38,38,0.15);padding:28px 24px 22px;overflow:hidden;"><p style="font-size:42px;color:#DC2626;font-weight:900;margin:0;line-height:0.6;">${leaf('“')}</p><p style="font-size:17px;font-weight:800;color:#1C1917;margin:12px 0 8px;line-height:1.9;padding-left:4px;text-align:left!important;"><span style="display:block;text-align:left!important;">${highlighted(intro, true)}</span></p></section>`)
  if (introOnlyChapter) blocks.push(`<section style="padding:0 10px;">${screenshots.filter(image => image.sectionIndex === 0).map(screenshotHtml).join('')}</section>`)
  // The red-white library's three-column overview is optional; a full vertical
  // list uses its paragraph component so every chapter is visible on phones.
  if (bodySections.length >= 3) blocks.push(`<section style="padding:0 10px 32px;"><p style="font-size:15px;color:#9CA3AF;margin:0 0 14px;letter-spacing:1px;">${leaf('本文目录')}</p>${bodySections.map(({ section }, index) => paragraph(leaf(`${String(index + 1).padStart(2, '0')}　${section.heading}`))).join('')}</section>`)
  bodySections.forEach(({ section, index }, bodyIndex) => {
    if (bodyIndex) blocks.push(separator)
    const paragraphs = section.paragraphs.filter((_paragraph, paragraphIndex) => index !== 0 || paragraphIndex !== 0)
    blocks.push(`<section style="margin-top:${bodyIndex ? 48 : 16}px;margin-bottom:28px;padding:0 10px;"><section style="display:flex;align-items:center;justify-content:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid #DC2626;"><section style="display:flex;align-items:center;justify-content:flex-start;width:100%;min-width:0;"><span style="display:inline-block;flex:0 0 auto;flex-shrink:0;min-width:52px;box-sizing:border-box;background:#DC2626;color:#FFFFFF;font-size:18px;font-weight:900;padding:4px 14px;border-radius:6px;margin-right:14px;line-height:1.3;text-align:center;white-space:nowrap;">${leaf(String(bodyIndex + 1).padStart(2, '0'))}</span><section style="flex:1;min-width:0;text-align:left;"><h3 style="font-size:18px;font-weight:800;color:#1C1917;margin:0;letter-spacing:0.5px;text-align:left;">${leaf(section.heading)}</h3></section></section></section>${paragraphs.map(item => paragraph(highlighted(item))).join('')}${screenshots.filter(image => image.sectionIndex === index).map(screenshotHtml).join('')}</section>`)
  })
  const html = `<section style="max-width:677px;margin:0 auto;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#374151;font-size:17px;line-height:1.9;letter-spacing:0.5px;overflow-x:hidden;">${blocks.join('')}</section>`
  const markdownEscape = (value: string) => value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&')
  const markdown = [`# ${markdownEscape(input.title)}`, ...sections.map((section, index) => [
    `## ${String(index + 1).padStart(2, '0')} ${markdownEscape(section.heading)}`,
    ...section.paragraphs.map(item => markdownEscape(item.text)),
    ...screenshots.filter(image => image.sectionIndex === index).map(image => `![配图](${image.url})`),
  ].join('\n\n'))].join('\n\n') + '\n'
  return { html, markdown }
}
