import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { collectNbaNews, resolveNbaGame, resolveNbaVideoGame } from './nba-news.js'
import type { NbaArticle, NbaIntakeInput, NbaTopic } from './nba-types.js'

const api = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const clock = () => new Date('2026-11-04T08:00:00Z')
const recap = 'https://www.espn.com/nba/recap?gameId=401909907'
const english = `Cleveland Cavaliers lost to the Oklahoma City Thunder 117-112 on Monday. ` +
  Array.from({length: 12}, (_, index) => `The visiting player number ${index} explained how teammates created better scoring opportunities while defenders rotated toward the basket and contested every attempt.`).join('\n\n')
const chinese = '北京时间2026年11月3日，雷霆以117比112击败骑士。' +
  '主队在第三节通过外线投篮追近比分，客队在最后时刻重新取得领先。教练在赛后谈到球员之间的配合与轮换，表示球队需要继续改善防守。双方在比赛末段多次交换领先，替补球员也为球队贡献了得分。终场哨响之后，两队球员互相致意，随后准备下一场比赛。'
function game(options: { complete?: boolean; date?: string; home?: string; neutral?: boolean; city?: string } = {}) {
  return { header: { id: '401909907', competitions: [{ id: '401909907', date: options.date || '2026-11-03T00:00Z', neutralSite: options.neutral || false,
    status: { type: { completed: options.complete ?? true, state: options.complete === false ? 'in' : 'post' } }, competitors: [
      { homeAway: 'home', score: '112', team: { displayName: 'Cleveland Cavaliers', abbreviation: options.home || 'CLE' } },
      { homeAway: 'away', score: '117', team: { displayName: 'Oklahoma City Thunder', abbreviation: 'OKC' } },
    ] }] }, gameInfo: { venue: { address: { city: options.city || 'Cleveland' } } },
    article: { headline: 'Thunder defeat Cavaliers 117-112 after late rally', source: 'Associated Press', byline: 'Joe Reedy', published: '2026-11-04T02:00:00Z', story: english, gameId: '401909907' } }
}
const base = (extra: Partial<NbaIntakeInput> = {}): NbaIntakeInput => ({ languages: ['en','zh'], limit: 4, articleUrls: [], ...extra })
function fixture(rows: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = String(input); calls.push(url)
    if (!(url in rows)) throw Error(`Unexpected fixture URL ${url}`)
    const value = rows[url]
    if (value instanceof Response) return new Response(await value.clone().arrayBuffer(), { status: value.status, headers: value.headers })
    if (value instanceof Error) throw value
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers: { 'content-type': typeof value === 'string' ? 'text/html; charset=utf-8' : 'application/json' } })
  }) as typeof fetch
}
function page(title: string, body: string, more: Record<string, unknown> = {}) {
  return `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: title, articleBody: body, publisher: {name: 'Independent Daily'}, ...more })}</script></html>`
}
function previous(body = english): NbaArticle {
  return { id:'old',url:'https://apnews.com/article/original',title:'Original AP report',language:'en',publisher:'Associated Press',byline:'Joe Reedy',body,
    bodyHash:createHash('sha256').update(body).digest('hex'),wordCount:200,characterCount:0,collectedAt:clock().toISOString() }
}

const topic: NbaTopic = { id:'youtube-rhZ6oVlNZHs',videoId:'rhZ6oVlNZHs',youtubeUrl:'https://www.youtube.com/watch?v=rhZ6oVlNZHs',
  title:'Luka Dončić On His HISTORIC Scoring Run After Another 40-Point Night | November 2, 2026',
  description:'Luka scored 42 points and discussed his historic scoring run.' }
const topicPlan = async () => ({en:'Luka Doncic scoring run',zh:'东契奇 得分纪录',anchors:['Luka Doncic','东契奇'],keywords:['scoring','得分','纪录']})

test('sports topic intake accepts a complete interview without a game, date or final score', async () => {
  const url = 'https://news.example.com/interview', calls:string[] = []
  const body = 'Luka Doncic discussed his scoring run and training. '+english
  const result = await collectNbaNews(base({topic,articleUrls:[url]}),{now:clock,topicPlan,fetchImpl:fixture({[url]:page('Luka Doncic on his scoring run',body)},calls)})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].body,body)
  assert.equal(result.articles[0].game,undefined)
  assert.equal(result.articles[0].heldReason,undefined)
  assert.equal(result.articles[0].topic?.videoId,topic.videoId)
  assert.equal(result.articles[0].youtubeUrl,topic.youtubeUrl)
  assert.deepEqual(calls,[url])
})

test('an explicit video matchup rejects a different opponent while allowing related interviews without scores', async () => {
  for (const language of ['en','zh'] as const) {
    const wrong = 'https://news.example.com/wrong-opponent', correct = 'https://news.example.com/matching-opponents', interview = 'https://news.example.com/team-interview'
    const titles = language === 'en' ? ['Trail Blazers defeat Lakers','Nuggets rally against Lakers','Lakers coach interview']
      : ['开拓者击败湖人','掘金逆转湖人','湖人教练专访']
    const body = language === 'en' ? 'The Lakers coach discussed basketball. '+english : '湖人教练谈篮球。'+chinese
    const interviewBody = language === 'en' ? 'Lakers coach basketball interview. '+Array.from({length:120},(_,index) => `training${index}`).join(' ')
      : '湖人教练在采访中介绍了篮球训练计划。'+'这次专题介绍休赛期的训练安排，以及年轻队员如何熟悉新的战术体系和身体恢复课程。'.repeat(5)
    const result = await collectNbaNews(base({topic:{...topic,title:'One of the WILDEST ENDINGS | Nuggets vs. Lakers',description:''},
      languages:[language],articleUrls:[wrong,correct,interview]}),{now:clock,
      topicPlan:async () => ({en:'Nuggets Lakers',zh:'掘金 湖人',anchors:['Lakers','湖人'],keywords:[]}),
      fetchImpl:fixture({[wrong]:page(titles[0],body),[correct]:page(titles[1],body),[interview]:page(titles[2],interviewBody)}),
    })
    assert.deepEqual(result.articles.map(article => article.url),[correct,interview])
    assert.match(result.excluded.find(row => row.url === wrong)!.reason,/双方球队不符/)
    assert.ok(result.articles.every(article => !article.heldReason && !article.game))
  }
})

test('a 100-article batch reads every supplied original instead of truncating at 60 candidates', async () => {
  const urls = Array.from({ length: 100 }, (_, index) => `https://news.example.com/interview/${index}`)
  const rows = Object.fromEntries(urls.map((url, index) => {
    const key = String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)
    const body = 'Luka Doncic discussed his scoring run. ' + Array.from({ length: 120 }, (_, word) => `player${key}score${word}`).join(' ')
    return [url, page(`Luka Doncic scoring run interview ${index}`, body)]
  }))
  const calls: string[] = []
  const result = await collectNbaNews(base({ topic, languages: ['en'], limit: 100, articleUrls: urls }),
    { now: clock, topicPlan, fetchImpl: fixture(rows, calls) })
  assert.equal(result.articles.length, 100, JSON.stringify(result.excluded.slice(0, 2)))
  assert.deepEqual(calls, urls)
  assert.deepEqual(result.excluded, [])
})

test('topic intake searches both languages and reads originals rather than search snippets or video descriptions', async () => {
  const enUrl = 'https://news.example.com/english', zhUrl = 'https://chinese.example.com/news', queries:string[] = []
  const result = await collectNbaNews(base({topic,limit:2}),{now:clock,topicPlan,
    searchImpl:async query => { queries.push(query); return {organic:[{title:query,link:queries.length === 1 ? enUrl : zhUrl,snippet:'short search snippet'}]} },
    fetchImpl:fixture({[enUrl]:page('Luka Doncic scoring run interview','Luka Doncic talks about scoring. '+english),
      [zhUrl]:page('东契奇谈得分纪录','东契奇在采访中谈到了得分纪录。'+chinese)}),
  })
  assert.deepEqual(queries,['Luka Doncic scoring run','东契奇 得分纪录'])
  assert.deepEqual(result.articles.map(article => article.language),['en','zh'])
  assert.ok(result.articles.every(article => !article.heldReason && article.body !== topic.description && !article.body.includes('short search snippet')))
})

test('topic intake retains minimum body length, relevance and article deduplication', async () => {
  const urls = ['https://news.example.com/short','https://news.example.com/unrelated','https://news.example.com/original','https://news.example.com/copy']
  const original = 'Luka Doncic talks about scoring. '+english
  const result = await collectNbaNews(base({topic,articleUrls:urls}),{now:clock,topicPlan,fetchImpl:fixture({
    [urls[0]]:page('Luka Doncic scoring run','Luka Doncic had another great game.'),
    [urls[1]]:page('An unrelated player',english),
    [urls[2]]:page('Luka Doncic scoring run interview',original),
    [urls[3]]:page('Another title about Luka Doncic',original),
  })})
  assert.equal(result.articles.length,1)
  assert.ok(result.excluded.some(row => /少于100/.test(row.reason)))
  assert.ok(result.excluded.some(row => /不匹配/.test(row.reason)))
  assert.equal(result.excluded.find(row => row.duplicateOf)?.duplicateOf,urls[2])
})

test('topic intake allows WNBA media day and sports previews without an NBA fixture', async () => {
  const sportsTopic = {...topic,title:'Caitlin Clark at WNBA Media Day',description:'Caitlin Clark discusses preparations for the coming WNBA season.'}
  const url = 'https://news.example.com/wnba'
  const result = await collectNbaNews(base({topic:sportsTopic,articleUrls:[url]}),{now:clock,
    topicPlan:async () => ({en:'Caitlin Clark media day',zh:'克拉克 媒体日',anchors:['Caitlin Clark'],keywords:['media day']}),
    fetchImpl:fixture({[url]:page('Caitlin Clark at WNBA Media Day: season preview','Caitlin Clark discussed training at media day. '+english)}),
  })
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].heldReason,undefined)
  assert.equal(result.articles[0].game,undefined)
})

test('a non-NBA ESPN recap reads its original page without querying the NBA game API', async () => {
  const url = 'https://www.espn.com/wnba/recap/_/gameId/777', calls:string[] = []
  const result = await collectNbaNews(base({topic,articleUrls:[url]}),{now:clock,topicPlan,fetchImpl:fixture({
    [url]:page('Luka Doncic visits a WNBA game','Luka Doncic discussed scoring during a visit. '+english),
  },calls)})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].game,undefined)
  assert.deepEqual(calls,[url])
})

test('structured sports search supplies originals without depending on a general search service', async () => {
  const enUrl = 'https://news.example.com/english', zhUrl = 'https://sports.sina.com.cn/general/topic.shtml'
  const result = await collectNbaNews(base({topic,limit:2}),{now:clock,topicPlan,fetchImpl:fixture({
    'https://site.web.api.espn.com/apis/search/v2?region=us&lang=en&query=Luka%20Doncic%20scoring%20run&limit=15&page=1':
      {results:[{type:'article',contents:[{displayName:'Luka Doncic scoring interview',link:{web:enUrl}}]},{type:'clips',contents:[{link:{web:'https://espn.com/video/clip'}}]}]},
    'https://search.sina.com.cn/api/news?q=%E4%B8%9C%E5%A5%91%E5%A5%87%20%E5%BE%97%E5%88%86%E7%BA%AA%E5%BD%95&page=1&size=20':
      {code:0,data:{list:[{title:'<font>东契奇</font>得分纪录',url:zhUrl}]}},
    [enUrl]:page('Luka Doncic scoring run','Luka Doncic talks about scoring. '+english),[zhUrl]:page('东契奇得分纪录',`东契奇得分纪录。${chinese}`),
  })})
  assert.deepEqual(result.articles.map(article => article.language),['en','zh'])
  assert.equal(result.sources.filter(row => row.status === 'failed').length,0)
})

test('a manual video plus original article enters topic mode without requiring a final score', async () => {
  const url = 'https://news.example.com/manual'
  const result = await collectNbaNews(base({articleUrls:[url],youtubeUrl:topic.youtubeUrl}),{now:clock,topicPlan,fetchImpl:fixture({
    [`https://www.youtube.com/oembed?url=${encodeURIComponent(topic.youtubeUrl)}&format=json`]:{title:topic.title},
    [topic.youtubeUrl]:`<script>var details = ${JSON.stringify({shortDescription:topic.description})};</script>`,
    [url]:page('Luka Doncic scoring run interview','Luka Doncic discussed scoring. '+english),
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].heldReason,undefined)
  assert.equal(result.articles[0].topic?.videoId,topic.videoId)
})

test('a topic search with no results retries concise subject and event words before using a general search', async () => {
  const url = 'https://sports.sina.com.cn/basketball/nba/topic.shtml', calls:string[] = []
  const result = await collectNbaNews(base({topic,languages:['zh'],limit:1}),{now:clock,
    topicPlan:async () => ({en:'Luka scoring run',zh:'东契奇 连续五场35分 2026年11月2日',anchors:['卢卡·东契奇'],keywords:['得分纪录']}),
    fetchImpl:fixture({
      [`https://search.sina.com.cn/api/news?q=${encodeURIComponent('东契奇 连续五场35分 2026年11月2日')}&page=1&size=20`]:{code:0,data:{list:[]}},
      [`https://search.sina.com.cn/api/news?q=${encodeURIComponent('东契奇 得分')}&page=1&size=20`]:{code:0,data:{list:[{url,title:'东契奇得分纪录'}]}},
      [url]:page('东契奇得分纪录',`东契奇。${chinese}`),
    },calls),
  })
  assert.equal(result.articles.length,1)
  assert.equal(calls.length,3)
})

test('dated full-game titles resolve without a final score in the video description', async () => {
  const resolved = await resolveNbaVideoGame({title:'THUNDER at CAVALIERS | FULL GAME HIGHLIGHTS | November 2, 2026',
    description:'Never miss a moment with NBA highlights.',uploadDate:'20300101'},undefined,{fetchImpl:fixture({
    [`${api}/scoreboard?dates=20261102`]:{events:[game().header]},[`${api}/scoreboard?dates=20261101`]:{events:[]},
  })})
  assert.equal(resolved?.espnEventId,'401909907')
  assert.equal(resolved?.home.score,112)
  assert.equal(resolved?.away.score,117)
})

test('an explicit opponent and game date identify a player clip without treating player stats as a final score', async () => {
  const resolved = await resolveNbaVideoGame({title:'Shai scores 43 vs Cavaliers | November 2, 2026',
    description:'Shai put up 43 points, 7 rebounds and 5 assists tonight.'},undefined,{fetchImpl:fixture({
    [`${api}/scoreboard?dates=20261102`]:{events:[game().header]},[`${api}/scoreboard?dates=20261101`]:{events:[]},
  })})
  assert.equal(resolved?.espnEventId,'401909907')
})

test('missing matchup, contradictory scores and ambiguous opponent games cannot resolve a video', async () => {
  const rows = {[`${api}/scoreboard?dates=20261102`]:{events:[game().header]},[`${api}/scoreboard?dates=20261101`]:{events:[]}}
  assert.equal(await resolveNbaVideoGame({title:'Shai talks about his performance | November 2, 2026',description:'Shai scored 43 points.'},undefined,{fetchImpl:fixture({})}),undefined)
  assert.equal(await resolveNbaVideoGame({title:'THUNDER at CAVALIERS | November 2, 2026',description:'Cleveland won 120-110.'},undefined,{fetchImpl:fixture(rows)}),undefined)
  const other = structuredClone(game().header); other.id = '401909999'; other.competitions[0].id = '401909999'
  assert.equal(await resolveNbaVideoGame({title:'Shai vs Cavaliers | November 2, 2026',description:''},undefined,{fetchImpl:fixture({
    ...rows,[`${api}/scoreboard?dates=20261102`]:{events:[game().header,other]},
  })}),undefined)
})

test('ESPN recap reads full body, hashes it, and verifies local date from tipoff rather than publication', async () => {
  const calls: string[] = []
  const result = await collectNbaNews(base({articleUrls:[recap]}), {now:clock,fetchImpl:fixture({[`${api}/summary?event=401909907`]:game()},calls)})
  assert.equal(result.articles.length,1)
  const article = result.articles[0]
  assert.equal(article.game?.localDate,'2026-11-02')
  assert.equal(article.game?.tipoffUtc,'2026-11-03T00:00:00.000Z')
  assert.equal(article.game?.localTimezone,'America/New_York')
  assert.equal(article.game?.away.score,117)
  assert.equal(article.game?.home.score,112)
  assert.equal(article.bodyHash,createHash('sha256').update(article.body).digest('hex'))
  assert.ok(article.wordCount >= 100)
  assert.equal(calls.length,1)
})

test('direct ESPN story ID uses structured article body and event category', async () => {
  const result = await collectNbaNews(base({articleUrls:['https://www.espn.com/nba/story/_/id/50364171/report']}), {now:clock,fetchImpl:fixture({
    [`${api}/news/50364171`]: {headlines:[{headline:'An independent postgame report',story:english,categories:[{type:'event',eventId:401909907}]}]},
    [`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles[0].game?.espnEventId,'401909907')
  assert.equal(result.articles[0].heldReason,undefined)
})

test('an ESPN topic story falls back to the original article page when its news API returns 404', async () => {
  const url = 'https://www.espn.com/nba/story/_/id/50366831/luka-interview'
  const body = 'Luka Doncic discussed his scoring run. '+english
  const result = await collectNbaNews(base({topic,articleUrls:[url]}),{now:clock,topicPlan,fetchImpl:fixture({
    [`${api}/news/50366831`]:new Response('not found',{status:404}),[url]:page('Luka Doncic on scoring',body),
  })})
  assert.equal(result.articles[0].body,body)
  assert.equal(result.articles[0].heldReason,undefined)
})

test('latest sources alternate eligible Chinese and English bodies before applying limit', async () => {
  const zhUrl = 'https://sports.sina.com.cn/basketball/nba/2026-11-04/doc-news.shtml'
  const result = await collectNbaNews(base({limit:2}), {now:clock,fetchImpl:fixture({
    [`${api}/news?limit=30`]:{articles:[1,2,3].map(id=>({id,headline:'NBA game report',links:{web:{href:`https://www.espn.com/nba/story/_/id/${id}/report`}}}))},
    'https://interface.sina.cn/sports/pc_sports_caipiao_common_list_api.d.json?ename=nba&last_ts=&page=1&size=20':{result:{status:{code:0},data:{items:[{url:zhUrl,title:'雷霆险胜骑士'}]}}},
    [`${api}/news/1`]:{headlines:[{headline:'First full report',story:english,gameId:401909907}]},
    [`${api}/news/2`]:{headlines:[{headline:'Second report',story:english,gameId:401909907}]},
    [`${api}/news/3`]:{headlines:[{headline:'Third report',story:english,gameId:401909907}]},
    [`${api}/summary?event=401909907`]:game(),
    [`${api}/scoreboard?dates=20261103`]:{events:[]},
    [`${api}/scoreboard?dates=20261102`]:{events:[game().header]},
    [zhUrl]:page('雷霆117比112击败骑士',chinese),
  })})
  assert.deepEqual(result.articles.map(row=>row.language),['en','zh'])
  assert.equal(result.articles[1].game?.localDate,'2026-11-02')
})

test('100-word/100-Han thresholds reject summaries and do not count Latin characters as Chinese', async () => {
  const urls = ['https://news.example.com/short-en','https://news.example.com/short-zh','https://news.example.com/summary-only']
  const result = await collectNbaNews(base({articleUrls:urls}), {now:clock,fetchImpl:fixture({
    [urls[0]]:page('Thunder report','basketball '.repeat(99)),
    [urls[1]]:page('中文报道','球'.repeat(99)),
    [urls[2]]:'<meta property="og:description" content="'+english+'"><h1>A summary without a body</h1>',
  })})
  assert.equal(result.articles.length,0)
  assert.ok(result.excluded.some(row=>row.reason.includes('99词')))
  assert.ok(result.excluded.some(row=>row.reason.includes('99个汉字')))
  assert.ok(result.excluded.some(row=>row.reason.includes('无法读取完整新闻正文')))
})

test('AI podcast digests, previews, and another competition are excluded with explicit reasons', async () => {
  const urls = ['https://news.example.com/ai','https://news.example.com/preview','https://news.example.com/cba']
  const result = await collectNbaNews(base({articleUrls:urls}), {now:clock,fetchImpl:fixture({
    [urls[0]]:page('Cavaliers podcast summary',english+' This summary was AI-assisted.'),
    [urls[1]]:page('Thunder versus Cavaliers preview: how to watch',english),
    [urls[2]]:page('CBA teams prepare for next season',english),
  })})
  assert.equal(result.articles.length,0)
  assert.equal(result.excluded.length,3)
  assert.ok(result.excluded.some(row=>/AI/.test(row.reason)))
  assert.ok(result.excluded.some(row=>/赛前/.test(row.reason)))
  assert.ok(result.excluded.some(row=>/非 NBA/.test(row.reason)))
})

test('AP syndications and an expanded adaptation deduplicate against existing bodies', async () => {
  const url = 'https://news.example.com/wire-adaptation'
  const result = await collectNbaNews(base({articleUrls:[url],existingArticles:[previous()]}), {now:clock,fetchImpl:fixture({
    [url]:page('A differently titled recap',`A new introduction and a different headline do not make a wire story independent.\n\n${english}\n\nAdditional material appears after the original agency report.`,{publisher:{name:'ESPN News Services'}}),
  })})
  assert.equal(result.articles.length,0)
  assert.equal(result.excluded[0].duplicateOf,'https://apnews.com/article/original')
})

test('distinct same-game reporting remains independent rather than grouping by score or teams', async () => {
  const url = 'https://news.example.com/independent'
  const other = 'The Cleveland Cavaliers lost 112-117 to the Oklahoma City Thunder. '+Array.from({length:15},(_,index)=>`Coach response ${index} focused on foul shooting, defensive communication, lineup decisions, substitutions, spacing, rebounding responsibility, and the next training session.`).join('\n\n')
  const result = await collectNbaNews(base({articleUrls:[url],existingArticles:[previous()],espnEventId:'401909907'}), {now:clock,fetchImpl:fixture({
    [url]:page('Cleveland coach explains mistakes',other),[`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].game?.verified,true)
})

test('an unfinished game remains held and is never marked verified', async () => {
  const result = await collectNbaNews(base({articleUrls:[recap]}), {now:clock,fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game({complete:false}),
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].game,undefined)
  assert.match(result.articles[0].heldReason || '',/尚待核验/)
})

test('unknown match does not use article publication date to query scoreboard', async () => {
  const article = {...previous(),publishedAt:'2023-11-09T00:00:00Z',body:'A substantial player profile without teams, final score, or any game date.'}
  const calls: string[] = []
  const resolved = await resolveNbaGame(article,undefined,{fetchImpl:fixture({[`${api}/scoreboard`]:{events:[game().header]},[`${api}/scoreboard?dates=20261103`]:{events:[]}},calls),now:clock})
  assert.equal(resolved,undefined)
  assert.deepEqual(calls,[`${api}/scoreboard`,`${api}/scoreboard?dates=20261103`])
})

test('an unknown neutral venue does not inherit the home franchise timezone', async () => {
  const result = await collectNbaNews(base({articleUrls:[recap]}), {now:clock,fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game({neutral:true,city:'Unknown exhibition venue'}),
  })})
  assert.equal(result.articles[0].game,undefined)
})

test('a specified game date is a local-game constraint, not an article publication filter', async () => {
  const result = await collectNbaNews(base({articleUrls:[recap],gameDate:'2026-11-03'}),{now:clock,fetchImpl:fixture({[`${api}/summary?event=401909907`]:game()})})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/指定比赛/)
})

test('YouTube description is a constraint, never an eligible article body', async () => {
  const youtube = 'https://www.youtube.com/watch?v=abcdefghijk'
  const result = await collectNbaNews(base({articleUrls:[recap],youtubeUrl:youtube,espnEventId:'401909907'}),{now:clock,fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game(),
    [`https://www.youtube.com/oembed?url=${encodeURIComponent(youtube)}&format=json`]:{title:'SGA takes over'},
    [youtube]:'<html><script>var details = {"shortDescription":"Oklahoma City Thunder defeated Cleveland Cavaliers 117-112."};</script></html>',
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].body,english)
  assert.equal(result.articles[0].youtubeUrl,youtube)
  assert.equal(result.articles[0].heldReason,undefined)
})

test('a mismatched YouTube pairing is excluded even when the news itself is valid', async () => {
  const youtube = 'https://www.youtube.com/watch?v=abcdefghijk'
  const result = await collectNbaNews(base({articleUrls:[recap],youtubeUrl:youtube}),{now:clock,
    topicPlan:async () => ({en:'Lakers Celtics',zh:'湖人 凯尔特人',anchors:['Lakers','Celtics','湖人','凯尔特人'],keywords:[]}),fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game(),
    [`https://www.youtube.com/oembed?url=${encodeURIComponent(youtube)}&format=json`]:{title:'Lakers vs Celtics full highlights'},
    [youtube]:'<html></html>',
  })})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/不匹配/)
})

test('caller cancellation propagates rather than becoming a successful empty collection', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(collectNbaNews(base({signal:controller.signal}),{fetchImpl:fixture({})}),{name:'AbortError'})
})

test('article source errors are retained while other sources remain usable', async () => {
  const result = await collectNbaNews(base({articleUrls:['https://news.example.com/denied',recap]}), {now:clock,fetchImpl:fixture({
    'https://news.example.com/denied':new Response('denied',{status:403}),[`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles.length,1)
  assert.ok(result.sources.some(row=>row.status === 'failed' && row.error === 'HTTP 403'))
})

test('redirects to local addresses cannot read internal services', async () => {
  const result = await collectNbaNews(base({articleUrls:['https://news.example.com/redirect']}),{now:clock,fetchImpl:fixture({
    'https://news.example.com/redirect':new Response(null,{status:302,headers:{location:'http://127.0.0.1:5679/private'}}),
  })})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/公开新闻/)
})

test('NBA game URL resolves through NBA box score to a matching ESPN final recap', async () => {
  const result = await collectNbaNews(base({articleUrls:['https://www.nba.com/game/okc-vs-cle-0022600158']}),{now:clock,fetchImpl:fixture({
    'https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022600158.json':{game:{gameStatus:3,gameTimeUTC:'2026-11-03T00:00:00Z',homeTeam:{teamTricode:'CLE',score:112},awayTeam:{teamTricode:'OKC',score:117}}},
    [`${api}/scoreboard?dates=20261102`]:{events:[game().header]},[`${api}/scoreboard?dates=20261103`]:{events:[]},
    [`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles[0].game?.nbaGameId,'0022600158')
  assert.equal(result.articles[0].url,recap)
})

test('English historical dates constrain a same-score match rather than using the current game', async () => {
  const article = {...previous(),body:`November 2, 2025. ${english}`}
  const resolved = await resolveNbaGame(article,undefined,{now:clock,fetchImpl:fixture({
    [`${api}/scoreboard?dates=20251102`]:{events:[game().header]},[`${api}/scoreboard?dates=20251101`]:{events:[]},
  })})
  assert.equal(resolved,undefined)
})

test('English date with an abbreviation identifies the actual local game day', async () => {
  const article = {...previous(),body:`Nov. 2, 2026. ${english}`}
  const resolved = await resolveNbaGame(article,undefined,{now:clock,fetchImpl:fixture({
    [`${api}/scoreboard?dates=20261102`]:{events:[game().header]},[`${api}/scoreboard?dates=20261101`]:{events:[]},
  })})
  assert.equal(resolved?.localDate,'2026-11-02')
})

test('a complete ESPN article survives a temporary game API failure as a held article', async () => {
  const url = 'https://www.espn.com/nba/story/_/id/9999/report'
  const result = await collectNbaNews(base({articleUrls:[url]}),{now:clock,fetchImpl:fixture({
    [`${api}/news/9999`]:{headlines:[{headline:'Cavaliers postgame report',story:english,gameId:401909907}]},
    [`${api}/summary?event=401909907`]:new Response('temporarily unavailable',{status:503}),
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].body,english)
  assert.equal(result.articles[0].game,undefined)
  assert.match(result.articles[0].heldReason || '',/尚待核验/)
  assert.equal(result.excluded.length,0)
})

test('insufficient article linkage is recoverable when an explicit game was supplied', async () => {
  const url = 'https://news.example.com/interview'
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907'}),{now:clock,fetchImpl:fixture({
    [url]:page('A player talks about training','The interview focused on practice and recovery. '+ 'A coach discussed preparation, communication, effort, recovery, concentration, and physical training with the young players. '.repeat(10)),
    [`${api}/summary?event=401909907`]:game(),[`${api}/scoreboard`]:{events:[game().header]},[`${api}/scoreboard?dates=20261103`]:{events:[]},
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].game,undefined)
  assert.match(result.articles[0].heldReason || '',/尚待核验/)
})

test('malformed article links are excluded without aborting valid sources', async () => {
  const result = await collectNbaNews(base({articleUrls:['not a url',recap]}),{now:clock,fetchImpl:fixture({[`${api}/summary?event=401909907`]:game()})})
  assert.equal(result.articles.length,1)
  assert.equal(result.excluded[0].url,'not a url')
})

test('an unrelated sidebar about AI does not become a disclosure for the article', async () => {
  const url = 'https://news.example.com/sidebar'
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907'}),{now:clock,fetchImpl:fixture({
    [url]:page('Cavaliers defeat report',english)+'<aside>Read more: AI-assisted sports tools are changing television</aside>',[`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles.length,1)
})

test('automated AP pregame blocks are excluded even without preview in the title', async () => {
  const url = 'https://news.example.com/pregame'
  const result = await collectNbaNews(base({articleUrls:[url]}),{now:clock,fetchImpl:fixture({
    [url]:page('Gilgeous-Alexander leads Thunder against Cavaliers after 43-point game','BOTTOM LINE: The teams meet on Wednesday. '+english),
  })})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/赛前/)
})

test('an explicitly different date in YouTube metadata rejects a same-team article', async () => {
  const youtube = 'https://www.youtube.com/watch?v=abcdefghijk'
  const result = await collectNbaNews(base({articleUrls:[recap],youtubeUrl:youtube}),{now:clock,
    topicPlan:async () => ({en:'Thunder Cavaliers',zh:'雷霆 骑士',anchors:['Thunder','Cavaliers'],keywords:[]}),fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game(),
    [`https://www.youtube.com/oembed?url=${encodeURIComponent(youtube)}&format=json`]:{title:'Thunder vs Cavaliers, November 2, 2025 full highlights'},[youtube]:'<html></html>',
  })})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/YouTube.*日期/)
})

test('requested game hints survive intake failure and constrain a later resume', async () => {
  const url = 'https://news.example.com/held'
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907',gameDate:'2026-11-02'}),{now:clock,fetchImpl:fixture({
    [url]:page('Cavaliers postgame report',english),[`${api}/summary?event=401909907`]:new Response('unavailable',{status:503}),
  })})
  const article = result.articles[0]
  assert.equal(article.requestedEspnEventId,'401909907')
  assert.equal(article.requestedGameDate,'2026-11-02')
  assert.equal(article.game,undefined)
  const resumed = await resolveNbaGame(article,undefined,{now:clock,fetchImpl:fixture({[`${api}/summary?event=401909907`]:game()})})
  assert.equal(resumed?.espnEventId,'401909907')
  const wrongDate = await resolveNbaGame({...article,requestedGameDate:'2026-11-01'},undefined,{now:clock,fetchImpl:fixture({[`${api}/summary?event=401909907`]:game()})})
  assert.equal(wrongDate,undefined)
})

test('cancellation during scoreboard resolution interrupts adjacent-day fallback', async () => {
  const controller = new AbortController(), calls:string[] = []
  const fetchImpl = (async (url: string | URL | Request) => { calls.push(String(url)); controller.abort(new Error('user stopped')); throw controller.signal.reason }) as typeof fetch
  await assert.rejects(resolveNbaGame(previous(),controller.signal,{fetchImpl,now:clock}),/user stopped/)
  assert.equal(calls.length,1)
})

test('Cleveland reader fallback isolates full authored prose from navigation, video, related links, and author bio', async () => {
  const url = 'https://www.cleveland.com/cavs/2026/11/full-report.html', title = 'Thunder defeat Cavaliers 117-112'
  const content = `Your Privacy Choices\n\n${'advertising '.repeat(150)}\n\n# ${title}\n\nPublished: Nov. 2, 2026\n\n![Image 1](https://images.example.com/photo.jpg)\n\nBy \n*   [Chris Fedor, cleveland.com](https://www.cleveland.com/staff/cfedor/ "Chris Fedor")\n\n${english}\n\n[Video 6](blob:https://www.cleveland.com/video)\n\n0:01\n\n/\n\n0:37\n\nWatch More\n\nKeep Watching\n\nAn unrelated video headline\n\n## More Cavs coverage\n\n* [Another article](https://www.cleveland.com/cavs/another.html)\n\n* **RELATED**: [Betting predictions](https://www.cleveland.com/betting/story.html)\n\n## **Up next**\n\nThe Cavs will travel to Oklahoma City on Wednesday.\n\n[![Image 40: Chris Fedor headshot](https://images.example.com/author.png)](https://www.cleveland.com/staff/cfedor/)\n\n${'Author biography '.repeat(50)}\n\n## Comments`
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907'}),{now:clock,fetchImpl:fixture({
    [url]:new Response('Forbidden',{status:403}),
    'https://r.jina.ai/https://cleveland.com/cavs/2026/11/full-report.html':{code:200,data:{title,url:url.replace('www.',''),httpStatus:200,publishedTime:'2026-11-03T02:49:49.644Z',content}},
    [`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles.length,1)
  const article = result.articles[0]
  assert.equal(article.body,`${english}\n\nThe Cavs will travel to Oklahoma City on Wednesday.`)
  assert.equal(article.byline,'Chris Fedor')
  assert.equal(article.publisher,'cleveland.com')
  assert.equal(article.publishedAt,'2026-11-03T02:49:49.644Z')
  assert.equal(article.url,url)
  assert.equal(article.game?.localDate,'2026-11-02')
})

test('Cleveland reader metadata or a body without a known ending is not accepted as a complete article', async () => {
  const url = 'https://www.cleveland.com/cavs/2026/11/truncated.html', title = 'Thunder defeat Cavaliers'
  const result = await collectNbaNews(base({articleUrls:[url]}),{now:clock,fetchImpl:fixture({
    [url]:new Response('Forbidden',{status:403}),
    'https://r.jina.ai/https://cleveland.com/cavs/2026/11/truncated.html':{code:200,data:{title,url:url.replace('www.',''),content:`# ${title}\n\nBy\n[Chris Fedor](https://www.cleveland.com/staff/cfedor/)\n\n${english}`}},
  })})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/结尾/)
})

test('Sina artibody is selected exactly and ignores layout, comment, and script markup', async () => {
  const url = 'https://sports.sina.com.cn/basketball/nba/report.shtml'
  const html = `<html><meta property="og:title" content="雷霆击败骑士"><div class="article-content-left"><p>${'推荐新闻'.repeat(100)}</p><div class="article" id="artibody"><p>${chinese}</p><!-- <div>commented advertisement --><script>const example = '<div>not a container';</script><div class="advertisement"></div></div><aside>${'页脚新闻'.repeat(100)}</aside></div></html>`
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907'}),{now:clock,fetchImpl:fixture({[url]:html,[`${api}/summary?event=401909907`]:game()})})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].body,chinese)
  assert.equal(result.articles[0].characterCount,[...chinese.matchAll(/\p{Script=Han}/gu)].length)
})

test('navigation outside Sina artibody cannot inflate a short article past the length threshold', async () => {
  const url = 'https://sports.sina.com.cn/basketball/nba/short.shtml'
  const result = await collectNbaNews(base({articleUrls:[url]}),{now:clock,fetchImpl:fixture({
    [url]:`<div class="article-content-left"><div id="artibody"><p>${'球'.repeat(99)}</p></div><p>${'页脚'.repeat(300)}</p></div>`,
  })})
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/99个汉字/)
})

test('the real Sina article-content layout selects its inner article and excludes the adjacent recommendation column', async () => {
  const url = 'https://k.sina.com.cn/article_5887996859_15ef3b3bb001017upg.html'
  const paragraphs = [
    '新赛季开局遭遇三连败的金州勇士，在被盛赞为超级新秀伦德博格的助力下，连续拿下丹佛掘金、明尼苏达森林狼、洛杉矶湖人和洛杉矶快船，将战绩提升到了4胜3负，这一个比赛日，处于四连胜的勇士，迎来了背靠背的考验，坐镇大通中心球馆对决菲尼克斯太阳，本场比赛太阳在布克的率领下，一度建立起了17分的优势，但库里第三节单节暴走狂砍18分，帮助勇士扭转局面，最终以116-113逆转复仇太阳。',
    '球员数据',
    '勇士：库里34分6板7助、波杰姆斯基20分3板2助、贝西19分8板1助、伦德博格16分5板5助、尼昂13分4板3助、理查德6分5板、格林4分4板2助、梅尔顿2分7板2助2断、佩顿2分2板1助',
    '太阳：布克26分3板5助、布里奇斯21分6板3助4断、狄龙18分7板4助、伊戈达罗14分2板2助、格林11分8板8助2断2帽、肯纳德6分2板1助、邓恩5分3板1助、马卢阿奇5分2板、古德温4分2板2助、吉莱斯皮3分1板2助2断',
  ]
  const html = `<html><meta property="og:title" content="库里34分勇士逆转太阳"><div class="article-content clearfix" id="article_content"><div class="article-content-left"><div class="article" id="article">${paragraphs.map(p => `<p>　　${p}</p>`).join('')}<div class="article-notice">特别声明：以上文章内容仅代表作者本人观点，不代表新浪网观点或立场。</div></div><div class="related-news">相关新闻 投资热点尽在新浪财经APP</div></div><div class="article-content-right"><h3>阅读排行榜</h3><p>福建舰入列一周年</p><p>Copyright 1996-2026 SINA Corporation</p></div></div></html>`
  const result = await collectNbaNews(base({ topic, articleUrls:[url], languages:['zh'], limit:1 }), {
    now:clock, topicPlan:async () => ({en:'Curry Warriors Suns',zh:'库里勇士逆转',anchors:['库里','勇士'],keywords:['逆转']}),fetchImpl:fixture({[url]:html}),
  })
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].body,paragraphs.join('\n\n'))
  assert.doesNotMatch(result.articles[0].body,/特别声明|新浪财经|排行榜|福建舰|Copyright/)
  assert.ok(result.articles[0].body.endsWith(paragraphs.at(-1)!),'the full final player-stat paragraph is retained')
})

test('JSON-LD articleBody is cleaned before the minimum length check and cannot be padded by page furniture', async () => {
  const url = 'https://k.sina.com.cn/article-short.html'
  const result = await collectNbaNews(base({ topic, articleUrls:[url], languages:['zh'], limit:1 }), {
    now:clock, topicPlan:async () => ({en:'Curry Warriors',zh:'库里勇士',anchors:['库里'],keywords:[]}),fetchImpl:fixture({
      [url]:page('库里勇士赛后采访','库里在赛后谈到了勇士的进攻。\n\n特别声明：以上文章内容仅代表作者本人观点，不代表新浪网观点或立场。\n\n阅读排行榜\n\n'+ '完全无关的排行榜推荐内容。'.repeat(30)),
    }),
  })
  assert.equal(result.articles.length,0)
  assert.match(result.excluded[0].reason,/少于100/)
})

test('AP coverage footers are excluded from the stored article body and lexical count', async () => {
  const payload = game(); payload.article.story += '\n\n------\n\nSee AP\u2019s full NBA coverage here'
  const result = await collectNbaNews(base({articleUrls:[recap]}),{now:clock,fetchImpl:fixture({[`${api}/summary?event=401909907`]:payload})})
  assert.equal(result.articles[0].body,english)
})

test('a Chinese news dateline is not misidentified as the date of the reported game', async () => {
  const url = 'https://news.example.com/chinese-dateline'
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907'}),{now:clock,fetchImpl:fixture({
    [url]:page('雷霆击败骑士','直播吧11月4日讯 '+chinese.replace('北京时间2026年11月3日，','')),[`${api}/summary?event=401909907`]:game(),
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].game?.localDate,'2026-11-02')
})

test('a verified game searches Sina by its teams and final score and reads the corresponding full article', async () => {
  const news = 'https://news.sina.com.cn/w/2026-11-03/doc-game.shtml', calls:string[] = []
  const query = `https://search.sina.com.cn/api/news?q=${encodeURIComponent('骑士 雷霆 112 117')}&page=1&size=20`
  const result = await collectNbaNews(base({articleUrls:[],limit:2,espnEventId:'401909907',gameDate:'2026-11-02'}),{now:clock,fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game(),[`${api}/news?limit=30`]:{articles:[]},
    [query]:{code:0,data:{list:[{url:news,title:'<font color="red">雷霆</font>117比112击败骑士',intro:'This search summary must never be the article body'}]}},
    'https://interface.sina.cn/sports/pc_sports_caipiao_common_list_api.d.json?ename=nba&last_ts=&page=1&size=20':{result:{status:{code:0},data:{items:[]}}},
    [news]:page('雷霆117比112击败骑士',chinese),
  },calls)})
  assert.deepEqual(result.articles.map(row=>row.language),['en','zh'])
  assert.equal(result.articles[1].body,chinese)
  assert.equal(result.articles[1].game?.espnEventId,'401909907')
  assert.ok(calls.includes(query))
  assert.equal(calls.filter(value=>/scoreboard/.test(value)).length,0)
})

test('an old same-score article without a full year cannot be silently assigned to a current event', async () => {
  const url = 'https://news.example.com/old-copy'
  const result = await collectNbaNews(base({articleUrls:[url],espnEventId:'401909907',gameDate:'2026-11-02'}),{now:clock,fetchImpl:fixture({
    [`${api}/summary?event=401909907`]:game(),[`${api}/scoreboard?dates=20261102`]:{events:[game().header]},
    [url]:page('雷霆击败骑士',chinese.replace('2026年',''),{datePublished:'2025-11-03T02:00:00Z'}),
  })})
  assert.equal(result.articles.length,1)
  assert.equal(result.articles[0].game,undefined)
  assert.match(result.articles[0].heldReason || '',/尚待核验/)
})
