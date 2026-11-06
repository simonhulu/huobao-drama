import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanNbaArticleBody, extractNbaArticleBody } from './nba-article-body.js'

test('saved body cleaning removes Sina footer furniture and retains the entire final reporting paragraph', () => {
  const paragraphs = ['库里第三节得到18分，帮助勇士逆转太阳。', '太阳：布克26分3板5助，吉莱斯皮3分1板2助2断。']
  const source = `${paragraphs.join('\n\n')}\n\n特别声明：以上文章内容仅代表作者本人观点，不代表新浪网观点或立场。\n\n赛博对话\n\n相关新闻\n\n阅读排行榜\n\n福建舰入列一周年\n\nCopyright © 1996-2026 SINA Corporation`
  const result = cleanNbaArticleBody(source)
  assert.equal(result.body, paragraphs.join('\n\n'))
  assert.equal(result.safe, true)
  assert.equal(result.changed, true)
  assert.equal(result.removedCharacters, source.length - result.body.length)
  assert.equal(result.removedSections.length, 1)
})

test('a source line and trailing topic/editor modules are removed without changing article wording', () => {
  const paragraph = '勇士（5-3）：库里34分6板7助，佩顿2分2板1助。'
  const result = cleanNbaArticleBody(`来源：直播吧\n\n　　${paragraph}\n\n点击进入专题：\n2026-2027赛季NBA常规赛\n\n责任编辑：过博文\n\n相关新闻`)
  assert.equal(result.body, paragraph)
  assert.equal(result.removedSections.length, 2)
  assert.equal(result.safe, true)
})

test('ordinary reporting mentions and the English schedule are not mistaken for website modules', () => {
  const body = '相关新闻显示，库里将在周四回归。\n\n球员说：“图片新闻里的这个动作很有意思。”\n\nUp next\n\nWarriors: Host Miami on Thursday night.'
  assert.deepEqual(cleanNbaArticleBody(body), { body, changed: false, removedCharacters: 0, removedSections: [], safe: true, issues: [] })
})

test('standalone in-body advertising labels do not discard the subsequent final paragraph', () => {
  const result = cleanNbaArticleBody('The Warriors rallied in the third quarter.\n\nAdvertisement\n\nCurry finished with 34 points.')
  assert.equal(result.body, 'The Warriors rallied in the third quarter.\n\nCurry finished with 34 points.')
  assert.equal(result.safe, true)
})

test('unbounded plain text pollution fails safely instead of pretending the report is clean', () => {
  const result = cleanNbaArticleBody('库里得到34分。网页杂项混在同一段内。特别声明：以上文章内容仅代表作者本人观点。')
  assert.equal(result.safe, false)
  assert.match(result.issues.join(''), /网站声明/)
  assert.equal(cleanNbaArticleBody('').safe, false)
})

test('DOM extraction resolves nested article content and removes only non-reporting children', () => {
  const html = '<div class="article-content"><div id="article"><p>库里得到<strong>34分</strong>，勇士逆转太阳。</p><div><p>布克得到26分。</p><aside>推荐其他比赛</aside></div><p>太阳最后一攻没有命中。</p><div class="article-notice">特别声明：以上文章内容仅代表作者本人观点</div></div><div class="article-content-right"><p>阅读排行榜</p><p>无关新闻</p></div></div>'
  const result = extractNbaArticleBody(html)
  assert.equal(result.body, '库里得到34分，勇士逆转太阳。\n\n布克得到26分。\n\n太阳最后一攻没有命中。')
  assert.equal(result.method, 'dom:#article')
  assert.equal(result.safe, true)
})

test('JSON-LD bodies receive the same footer cleaning and do not absorb surrounding page text', () => {
  const result = extractNbaArticleBody('<html><body><div>相关新闻 全网页不应作为正文</div></body></html>', 'The Warriors won 116-113.\n\nUp next\n\nSuns: Host Portland.\n\nRelated articles\n\nThe latest transfer news')
  assert.equal(result.body, 'The Warriors won 116-113.\n\nUp next\n\nSuns: Host Portland.')
  assert.equal(result.method, 'json-ld:articleBody')
  assert.equal(result.safe, true)
})

test('a page without an identified article container never falls back to all visible text', () => {
  const result = extractNbaArticleBody('<html><body><main><h1>Today in sports</h1><p>Headline list, sidebar, footer</p></main></body></html>')
  assert.equal(result.body, '')
  assert.equal(result.method, 'missing-article')
  assert.equal(result.safe, false)
})

test('DOM text ignores executable markup, comments and image captions while preserving HTML entities', () => {
  const result = extractNbaArticleBody('<article><p>Curry &amp; Green combined.</p><script>fake report</script><!-- hidden --><figure>Picture caption</figure><p>The final lead was &lt; 4 points.</p><iframe>embedded ad</iframe></article>')
  assert.equal(result.body, 'Curry & Green combined.\n\nThe final lead was < 4 points.')
  assert.equal(result.safe, true)
})
