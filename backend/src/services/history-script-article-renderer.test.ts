import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderHistoryArticle, type ArticleSection } from './history-script-article-renderer.js'

const paragraph = (text: string, highlights: string[] = []) => ({ text, highlights, sourceEvidence: [] })
const sections: ArticleSection[] = [
  { heading: '先说一件小事', paragraphs: [paragraph('买菜这件小事，也能看出当年的日子。', ['买菜'])] },
  { heading: '为何菜价高', paragraphs: [paragraph('冬天运输不便，菜送到城里就更贵。', ['运输不便']), paragraph('普通人家只能仔细盘算，把钱花在要紧处。')] },
  { heading: '怎么过日子', paragraphs: [paragraph('邻里互相帮衬，常常能省下一笔开销。')] },
  { heading: '最后想说的话', paragraphs: [paragraph('读懂这些琐事，就更容易理解普通人的处境。')] },
]
const screenshots = [
  { url: '/static/history-articles/56/abc-123/frame-1.jpg', timestamp: 95.5, sectionIndex: 0 },
  { url: '/static/history-articles/56/abc-123/frame-2.jpg', timestamp: 215.8, sectionIndex: 1 },
]
const input = { title: '菜价背后的日子', sections, screenshots, sourceUrl: 'https://www.douyin.com/video/123?from=article&source=credit', sourceAuthor: '讲历史的老张', author: { name: '小史', bio: '一起读懂过去的日子。' } }
const textContent = (html: string) => html.replace(/<[^>]*>/g, '')

test('article headings use consecutive numbers and Chinese titles without English decoration or infinity badges', () => {
  const { html, markdown } = renderHistoryArticle(input)
  assert.doesNotMatch(textContent(html), /\b(?:HISTORY|ANALYSIS|THE END|END)\b|∞/)
  const headings = [...html.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/g)].map(match => textContent(match[1]))
  assert.deepEqual(headings, ['为何菜价高', '怎么过日子', '最后想说的话'])
  const chapterBadges = [...html.matchAll(/<span style="[^"]*background:#DC2626;color:#FFFFFF;[^"]*"><span leaf="">([^<]+)<\/span><\/span>/g)].map(match => match[1])
  assert.deepEqual(chapterBadges, ['01', '02', '03'])
  for (const section of sections) {
    for (const item of section.paragraphs) {
      assert.equal(textContent(html).split(item.text).length - 1, 1, `HTML retains each paragraph once: ${item.text}`)
      assert.equal(markdown.split(item.text).length - 1, 1, `Markdown retains each paragraph once: ${item.text}`)
    }
  }
})

test('published images retain their URLs without screenshot labels or timestamps in HTML and Markdown', () => {
  const { html, markdown } = renderHistoryArticle(input)
  assert.doesNotMatch(html, /成片截图|1分35秒|3分35秒|95\.5|215\.8/)
  assert.doesNotMatch(markdown, /成片截图|95\.5\s*秒|215\.8\s*秒/)
  for (const image of screenshots) {
    assert.ok(html.includes(`src="${image.url}"`))
    assert.ok(markdown.includes(`![配图](${image.url})`))
  }
  assert.equal((html.match(/<img\b/g) || []).length, 2)
})

test('body paragraphs and introduction use readable 17px type with comfortable line spacing', () => {
  const { html } = renderHistoryArticle(input)
  for (const section of sections) {
    for (const item of section.paragraphs) {
      const block = [...html.matchAll(/<p\b([^>]*)>(.*?)<\/p>/g)].find(match => textContent(match[2]) === item.text)
      assert.ok(block, `Paragraph remains in the article: ${item.text}`)
      assert.match(block[1], /font-size:17px;/)
      assert.match(block[1], /line-height:1\.9;/)
    }
  }
  assert.match(html, /#DC2626/)
  assert.match(html, /background:#ffffff/)
})

test('article ends with its body without source credit, signature or account introduction', () => {
  const { html, markdown } = renderHistoryArticle({ ...input, screenshots: [], sections: [{ heading: '书上的字', paragraphs: [paragraph('书里写着 HISTORY 和 THE END，这些是书中的原话。')] }] })
  for (const output of [html, markdown]) {
    assert.doesNotMatch(output, /素材来源|原文来源|署名：|讲历史的老张|小史|一起读懂过去的日子/)
    assert.ok(!output.includes(input.sourceUrl))
  }
  assert.match(textContent(html), /书里写着 HISTORY 和 THE END，这些是书中的原话。/)
  assert.ok(markdown.trimEnd().endsWith('书里写着 HISTORY 和 THE END，这些是书中的原话。'))
})

test('legacy source metadata is omitted without creating links or markup', () => {
  const legacyInput = { ...input, sourceUrl: 'javascript:alert(1)', sourceAuthor: '<script>恶意标记</script>' }
  const { html, markdown } = renderHistoryArticle(legacyInput)
  assert.doesNotMatch(html, /<a\b|<script\b/)
  assert.doesNotMatch(html + markdown, /恶意标记|javascript:alert/)
})

test('rendered output passes the installed WeChat inline-style and span-leaf validator without warnings', t => {
  const validator = path.join(homedir(), '.agents/skills/gzh-design/scripts/validate_gzh_html.py')
  if (!existsSync(validator)) return t.skip('gzh-design validator is not installed')
  const { html } = renderHistoryArticle(input)
  const result = spawnSync('python3', [validator, '--stdin'], { input: html, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /ERROR|WARNING/)
  assert.match(result.stdout, /完全合规/)
})
