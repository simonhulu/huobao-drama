import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { collectNbaChannelNews, type NbaChannelCollectionOptions } from './nba-channel-collection.js'
import { resolveNbaVideoGame } from './nba-news.js'
import type { HistoryYoutubeRunner } from './history-source-youtube.js'
import type { NbaArticle, NbaChannelVideo, NbaGame, NbaIntakeInput } from './nba-types.js'

const database = mkdtempSync(path.join(tmpdir(),'nba-channel-db-'))
process.env.DB_PATH = path.join(database,'test.db')
const { collectHistoryYoutubeVideos } = await import('./history-source-youtube.js')
const channel = 'https://www.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ/videos'
const id = 'vDdPLHaKK4k', secondId = 'abcdefghijk'
const url = `https://www.youtube.com/watch?v=${id}`
const api = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const title = 'Shai Gilgeous-Alexander TAKES OVER | November 2, 2026'
const description = 'Shai Gilgeous-Alexander scored 43 points as Oklahoma City Thunder defeated Cleveland Cavaliers 117-112.'
const verified:NbaGame = {id:'espn-401909907',espnEventId:'401909907',verified:true,tipoffUtc:'2026-11-03T00:00:00.000Z',localDate:'2026-11-02',localTimezone:'America/New_York',
  home:{name:'Cleveland Cavaliers',abbreviation:'CLE',score:112},away:{name:'Oklahoma City Thunder',abbreviation:'OKC',score:117},evidenceUrls:[`${api}/scoreboard?dates=20261102`]}
const clock = () => new Date('2026-11-04T08:00:00Z')
const metadata = (videoId = id) => ({id:videoId,title,description,upload_date:'20261103',channel:'NBA',channel_id:'UCWJ2lWNubArHWmf3FIHbfcQ',live_status:'not_live'})
function article(language:'en'|'zh' = 'en', suffix = ''):NbaArticle {
  return {id:`article-${language}${suffix}`,url:`https://news.example.com/${language}${suffix}`,title:'Independent report',language,publisher:'Daily News',body:language === 'en' ? 'basketball '.repeat(120) : '球'.repeat(120),
    wordCount:language === 'en' ? 120 : 0,characterCount:language === 'zh' ? 120 : 0,bodyHash:`body-${language}${suffix}`,collectedAt:clock().toISOString(),game:verified}
}
const input = (extra:Partial<Parameters<typeof collectNbaChannelNews>[0]> = {}) => ({youtubeChannels:[channel],videosPerChannel:2,languages:['en','zh'] as ('en'|'zh')[],limit:2,signal:new AbortController().signal,...extra})
function runner(entries = [metadata(),metadata(secondId)], details:Record<string,unknown> = {}, calls:string[][] = []):HistoryYoutubeRunner {
  return async args => {
    calls.push(args)
    if (args.includes('--flat-playlist')) return {stdout:JSON.stringify({channel:'NBA',entries})}
    const videoId = new URL(args.at(-1)!).searchParams.get('v')!
    const value = details[videoId] || metadata(videoId)
    if (value instanceof Error) throw value
    return {stdout:typeof value === 'string' ? value : JSON.stringify(value)}
  }
}
const options = (extra:Partial<NbaChannelCollectionOptions> = {}):NbaChannelCollectionOptions => ({now:clock,collectYoutube:collectHistoryYoutubeVideos,youtubeRunner:runner(),
  resolveVideoGame:async () => verified,collectNews:async () => ({articles:[article('en'),article('zh')],excluded:[],sources:[]}),...extra})
function scoreboard(complete = true) {
  return {id:'401909907',competitions:[{date:'2026-11-03T00:00:00Z',status:{type:{completed:complete,state:complete ? 'post' : 'in'}},competitors:[
    {homeAway:'home',score:'112',team:{abbreviation:'CLE',displayName:'Cleveland Cavaliers'}},{homeAway:'away',score:'117',team:{abbreviation:'OKC',displayName:'Oklahoma City Thunder'}},
  ]}]}
}
function fetchFixture(rows:Record<string,unknown>, calls:string[] = []):typeof fetch {
  return (async value => {
    const request = String(value); calls.push(request)
    if (!(request in rows)) throw Error(`Unexpected URL ${request}`)
    if (rows[request] instanceof Error) throw rows[request]
    return new Response(JSON.stringify(rows[request]),{headers:{'content-type':'application/json'}})
  }) as typeof fetch
}

test('video description, stated game date and score resolve to ESPN local game date rather than upload date', async () => {
  const calls:string[] = []
  const game = await resolveNbaVideoGame({title,description,uploadDate:'20300101'},undefined,{fetchImpl:fetchFixture({
    [`${api}/scoreboard?dates=20261102`]:{events:[scoreboard()]},[`${api}/scoreboard?dates=20261101`]:{events:[]},
  },calls)})
  assert.equal(game?.espnEventId,'401909907')
  assert.equal(game?.localDate,'2026-11-02')
  assert.ok(calls.every(value => !value.includes('2030')))
})

test('missing date, wrong teams, wrong year and unfinished game do not identify footage', async () => {
  const calls:string[] = []
  const fetchImpl = fetchFixture({[`${api}/scoreboard?dates=20261102`]:{events:[scoreboard(false)]},[`${api}/scoreboard?dates=20261101`]:{events:[]}},calls)
  assert.equal(await resolveNbaVideoGame({title:'SGA highlights',description,uploadDate:'20261102'},undefined,{fetchImpl}),undefined)
  assert.equal(calls.length,0)
  assert.equal(await resolveNbaVideoGame({title,description:'The Thunder played Cavaliers.'},undefined,{fetchImpl}),undefined)
  assert.equal(await resolveNbaVideoGame({title,description},undefined,{fetchImpl}),undefined)
  const wrong = await resolveNbaVideoGame({title:title.replace('2026','2025'),description},undefined,{fetchImpl:fetchFixture({
    [`${api}/scoreboard?dates=20251102`]:{events:[scoreboard()]},[`${api}/scoreboard?dates=20251101`]:{events:[]},
  })})
  assert.equal(wrong,undefined)
  assert.equal(await resolveNbaVideoGame({title,description:description.replace('117-112','118-112')},undefined,{fetchImpl:fetchFixture({
    [`${api}/scoreboard?dates=20261102`]:{events:[scoreboard()]},[`${api}/scoreboard?dates=20261101`]:{events:[]},
  })}),undefined)
})

test('Beijing game date and American numeric title dates are supported with adjacent-day scoreboard lookup', async () => {
  const fetchImpl = fetchFixture({[`${api}/scoreboard?dates=20261103`]:{events:[]},[`${api}/scoreboard?dates=20261102`]:{events:[scoreboard()]},[`${api}/scoreboard?dates=20261101`]:{events:[]}})
  const chinese = await resolveNbaVideoGame({title:'雷霆骑士集锦',description:'北京时间2026年11月3日，雷霆117比112战胜骑士。'},undefined,{fetchImpl})
  assert.equal(chinese?.localDate,'2026-11-02')
  assert.equal((await resolveNbaVideoGame({title:'Thunder at Cavaliers | 11/2/2026',description},undefined,{fetchImpl}))?.espnEventId,'401909907')
})

test('bounded channel listing reads complete metadata, binds independent articles and persists auditable description', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'nba-channel-snapshot-')); t.after(() => rmSync(directory,{recursive:true,force:true}))
  const calls:string[][] = []
  let request:NbaIntakeInput | undefined
  const result = await collectNbaChannelNews(input({snapshotDir:directory,videosPerChannel:1}),options({youtubeRunner:runner(undefined,{},calls),collectNews:async value => {
    request = value; return {articles:[article('en'),article('zh')],excluded:[],sources:[]}
  }}))
  assert.equal(calls[0][calls[0].indexOf('--playlist-items') + 1],'1:1')
  assert.equal(calls.length,2)
  assert.equal(calls[0].includes('--ignore-no-formats-error'),false)
  assert.equal(calls[1].includes('--ignore-no-formats-error'),true)
  assert.ok(calls[1].includes('--skip-download'))
  assert.equal(result.videos[0].status,'collected')
  assert.equal(result.videos[0].gameId,verified.id)
  assert.equal(result.articles.length,2)
  assert.ok(result.articles.every(value => value.sourceVideoId === id && value.sourceChannel === channel && value.youtubeUrl === url))
  assert.equal(request?.espnEventId,'401909907')
  assert.equal(request?.gameDate,'2026-11-02')
  assert.deepEqual(request?.topic,{id:`youtube-${id}`,videoId:id,title,description,youtubeUrl:url,channel:'NBA',uploadDate:'20261103'})
  assert.ok(result.articles.every(value => value.topic?.videoId === id && value.topic.description === description))
  assert.equal(readFileSync(path.join(directory,`${id}.description.txt`),'utf8'),description)
  const saved = JSON.parse(readFileSync(path.join(directory,`${id}.metadata.json`),'utf8'))
  assert.equal(saved.metadata.upload_date,'20261103')
  assert.equal(saved.metadata.description,description)
  assert.equal(saved.game.localDate,'2026-11-02')
  assert.equal(saved.outcome.status,'collected')
})

test('missing or unavailable game information does not block topic-based news collection', async () => {
  for (const resolveVideoGame of [async () => undefined,async () => { throw Error('scoreboard unavailable') },async () => ({...verified,verified:false})]) {
    let searched = false
    const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({resolveVideoGame,collectNews:async request => {
      searched = true
      assert.equal(request.topic?.title,title)
      assert.equal(request.topic?.description,description)
      return {articles:[{...article(),game:undefined}],sources:[],excluded:[]}
    }}))
    assert.equal(searched,true)
    assert.equal(result.articles.length,1)
    assert.equal(result.videos[0].status,'collected')
    assert.equal(result.excluded.length,0)
    assert.ok(result.sources.every(row => row.status === 'ok'))
  }
})

test('sports interviews, media days, advertisements, compilations and other sports are collected by video topic', async () => {
  const headings = [
    'Luka Doncic On His HISTORIC Scoring Run After Another 40-Point Night | November 2, 2026',
    'Inside the Game with JJ Redick, Mitch Johnson & More | Coaches Corner powered by AWS',
    'Tyler Herro Talks Milwaukee Homecoming, Building a New Culture & More at Bucks Media Day',
    'LeBron James on Why He Chose Philly, His New Teammates & Life Lessons at 76ers Media Day',
    'Worn With Obsession | Nike x NBA', 'NBA Tap to Watch',
    'Top "Jelly" Finishes of the 2025-26 Season',
    "Klay Thompson's FULL Heat Introductory Press Conference",
    'Air Time Presents: Road to Peach Jam | Episode 3',
    'Chicago and Caleb | Road to the Draft presented by New Balance Basketball',
    'PlayStation NBA CREATOR CUP | FULL GAME HIGHLIGHTS | July 9, 2026',
    'The 76ers Have Been Too Fun To Watch | Top Plays So Far',
    'Top 10 Plays Of The Night', 'The BEST NBA PLAYS This Season',
    'WNBA Finals Highlights', 'CBA赛前前瞻', 'NCAA Tournament Preview',
    'EuroLeague best plays', 'World Cup Football Interview',
  ]
  for (const heading of headings) {
    const calls:string[][] = [], fullDescription = `${heading}: full video description`
    let searched = false
    const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({
      youtubeRunner:runner([{...metadata(),title:heading}],{[id]:{...metadata(),title:heading,description:fullDescription}},calls),
      resolveVideoGame:async () => undefined,
      collectNews:async request => {
        searched = true
        assert.equal(request.topic?.title,heading)
        assert.equal(request.topic?.description,fullDescription)
        assert.equal(request.espnEventId,undefined)
        return {articles:[{...article(),game:undefined}],sources:[],excluded:[]}
      },
    }))
    assert.equal(calls.length,2,heading)
    assert.equal(searched,true,heading)
    assert.equal(result.videos[0].status,'collected',heading)
    assert.equal(result.articles[0].topic?.title,heading)
    assert.equal(result.articles[0].youtubeUrl,url,heading)
    assert.ok(result.sources.every(row=>row.status === 'ok'),heading)
  }
})

test('historical comeback videos retain their full topic without needing a complete game date', async () => {
  const promos = [
    {title:'One of the WILDEST ENDINGS of the Season Nuggets vs. Lakers | Presented by @xfinity',description:"One of last year's WILDEST endings: Nuggets/Lakers on March 14. The 2026-27 season begins Oct. 20!"},
    {title:'22-POINT COMEBACK vs. the UNDEFEATED CHAMPS Trail Blazers vs. Thunder | Presented by @xfinity',description:'The Blazers pulled off an incredible comeback last November. The 2026-27 season starts Oct. 20!'},
    {title:'LARGEST OT COMEBACK of the Play-by-Play Era Timberwolves vs. Rockets | Presented by @xfinity',description:'On March 25, the Timberwolves pulled off the largest overtime comeback. The 2026-27 season begins Oct. 20!'},
  ]
  for (const promo of promos) {
    const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({
      youtubeRunner:runner([{...metadata(),title:promo.title}],{[id]:{...metadata(),...promo}}),
      resolveVideoGame:async () => undefined,
    }))
    assert.equal(result.videos[0].status,'collected')
    assert.equal(result.articles[0].topic?.title,promo.title)
    assert.equal(result.articles[0].topic?.description,promo.description)
    assert.ok(result.sources.every(row=>row.status === 'ok'))
  }
})

test('dated preseason and sponsored full-game highlights remain eligible without a description score', async () => {
  for (const heading of ['THUNDER at CAVALIERS | NBA PRESEASON FULL GAME HIGHLIGHTS | October 16, 2026',
    'THUNDER at CAVALIERS | FULL GAME HIGHLIGHTS | November 2, 2026 | Presented by @xfinity']) {
    const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({
      youtubeRunner:runner([{...metadata(),title:heading}],{[id]:{...metadata(),title:heading,description:'Never miss a moment. Subscribe to the NBA.'}}),
    }))
    assert.equal(result.videos[0].status,'collected',heading)
    assert.equal(result.articles[0].youtubeUrl,url)
  }
})

test('personal highlights always retain their original video even when same-game full highlights exist', async () => {
  const heading = 'Shai Gilgeous-Alexander Joins History with 4th 40-PT Game vs Cavaliers | November 2, 2026'
  const full:NbaChannelVideo = {videoId:secondId,url:`https://www.youtube.com/watch?v=${secondId}`,channel,
    title:'THUNDER at CAVALIERS | FULL GAME HIGHLIGHTS | November 2, 2026',gameId:verified.id,status:'collected',message:'Saved',articleIds:['old'],searchedLanguages:['en','zh']}
  for (const existingVideos of [[],[full]]) {
    const result = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos}),options({
      youtubeRunner:runner([{...metadata(),title:heading}],{[id]:{...metadata(),title:heading,description:'Shai put up 43 points and helped his teammates.'}}),
    }))
    assert.equal(result.videos[0].status,'collected')
    assert.equal(result.videos[0].videoId,id)
    assert.equal(result.articles[0].youtubeUrl,url)
    assert.equal(result.articles[0].sourceVideoId,id)
    assert.equal(result.articles[0].topic?.title,heading)
  }
})

test('different video topics in the same round keep their own source footage', async () => {
  const full = {...metadata(),title:'THUNDER at CAVALIERS | FULL GAME HIGHLIGHTS | November 2, 2026'}
  const personal = {...metadata(secondId),title:'Shai Joins History vs Cavaliers | November 2, 2026',description:'Shai scored 43 points.'}
  let newsCalls = 0
  const result = await collectNbaChannelNews(input({limit:4}),options({youtubeRunner:runner([full,personal],{[id]:full,[secondId]:personal}),
    collectNews:async () => ({articles:[article('en',String(newsCalls++)),article('zh',String(newsCalls))],sources:[],excluded:[]}),
  }))
  assert.equal(result.articles.length,4)
  assert.ok(result.articles.slice(0,2).every(row=>row.youtubeUrl === url && row.sourceVideoId === id && row.topic?.title === full.title))
  assert.ok(result.articles.slice(2).every(row=>row.youtubeUrl === `https://www.youtube.com/watch?v=${secondId}` && row.sourceVideoId === secondId && row.topic?.title === personal.title))
})

test('repeated history skips keep one prefix without growing the stored message', async () => {
  const saved:NbaChannelVideo = {videoId:id,url,channel,title,status:'collected',message:'已跳过：已跳过：已核验比赛并采集1篇独立完整新闻',articleIds:['old'],searchedLanguages:['en','zh']}
  const result = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:[saved]}),options({youtubeRunner:runner([metadata()])}))
  assert.equal(result.videos[0].message,'已跳过：已核验比赛并采集1篇独立完整新闻')
})

test('known successful or duplicate videos with complete language coverage skip metadata while failures are retried', async () => {
  const existing:NbaChannelVideo = {videoId:id,url,channel,title,status:'collected',message:'Saved',articleIds:['old'],searchedLanguages:['en','zh']}
  for (const status of ['collected','excluded'] as const) {
    const calls:string[][] = []
    const result = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:[{...existing,status}]}),options({youtubeRunner:runner([metadata()],{},calls)}))
    assert.equal(calls.length,1)
    assert.equal(result.articles.length,0)
    assert.equal(result.videos[0].status,status)
  }
  const retried = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:[{...existing,status:'failed'}]}),options({youtubeRunner:runner([metadata()])}))
  assert.equal(retried.videos[0].status,'collected')
})

test('reserved video tasks skip incomplete language history and leave the news quota for a new video', async () => {
  const saved:NbaChannelVideo = {videoId:id,url,channel,title,status:'collected',message:'Saved English',articleIds:['old'],searchedLanguages:['en']}
  const calls:string[][] = [], searched:string[] = []
  const result = await collectNbaChannelNews(input({limit:1,reservedVideoIds:[id],existingVideos:[saved]}),options({
    youtubeRunner:runner(undefined,{},calls),collectNews:async request => {
      searched.push(request.topic!.videoId)
      return {articles:[article('zh')],excluded:[],sources:[]}
    },
  }))
  assert.deepEqual(searched,[secondId])
  assert.equal(calls.length,2)
  assert.equal(new URL(calls[1].at(-1)!).searchParams.get('v'),secondId)
  assert.deepEqual(result.videos[0].articleIds,['old'])
  assert.deepEqual(result.videos[0].searchedLanguages,['en'])
  assert.match(result.videos[0].message,/已有.*任务/)
  assert.equal(result.articles[0].sourceVideoId,secondId)
})

test('reserved videos without stored history are safely reported from channel candidates', async () => {
  const calls:string[][] = []
  const result = await collectNbaChannelNews(input({videosPerChannel:1,reservedVideoIds:[id]}),options({
    youtubeRunner:runner([metadata()],{},calls),collectNews:async () => assert.fail('Reserved task must not search news'),
  }))
  assert.equal(calls.length,1)
  assert.equal(result.articles.length,0)
  assert.deepEqual(result.videos[0],{videoId:id,url,channel,title,status:'excluded',message:'已跳过：该视频已有制作任务，请继续原任务',articleIds:[]})
})

test('reserved failed history is skipped while an ordinary failed video still retries', async () => {
  const failed:NbaChannelVideo = {videoId:id,url,channel,title,status:'failed',message:'temporary failure',articleIds:[]}
  const ordinary = {...failed,videoId:secondId,url:`https://www.youtube.com/watch?v=${secondId}`}
  const searched:string[] = []
  const result = await collectNbaChannelNews(input({reservedVideoIds:[id],existingVideos:[failed,ordinary]}),options({
    collectNews:async request => { searched.push(request.topic!.videoId); return {articles:[article('en')],excluded:[],sources:[]} },
  }))
  assert.deepEqual(searched,[secondId])
  assert.equal(result.videos[0].status,'excluded')
  assert.match(result.videos[0].message,/已有.*任务/)
  assert.equal(result.videos[1].status,'collected')
  assert.equal(result.sources[0].status,'ok')
})

test('legacy exclusions without language coverage are reconsidered as sports topics', async () => {
  const calls:string[][] = []
  const result = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:[{
    videoId:id,url,channel,title,status:'excluded',message:'采访，不作为单场比赛素材',articleIds:[],
  }]}),options({youtubeRunner:runner([metadata()],{},calls),resolveVideoGame:async () => undefined}))
  assert.equal(calls.length,2)
  assert.equal(result.videos[0].status,'collected')
  assert.equal(result.articles[0].topic?.videoId,id)
})

test('adding Chinese revisits English-only history and retains existing reports for deduplication', async () => {
  const previous = {...article('en'),sourceVideoId:id}
  const saved:NbaChannelVideo = {videoId:id,url,channel,title,status:'collected',message:'Saved English',articleIds:[previous.id],gameId:verified.id}
  const calls:string[][] = []
  const result = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:[saved],existingArticles:[previous]}),options({
    youtubeRunner:runner([metadata()],{},calls),collectNews:async request => {
      assert.deepEqual(request.languages,['en','zh'])
      assert.equal(request.existingArticles?.[0].id,previous.id)
      return {articles:[article('zh')],sources:[],excluded:[{url:previous.url,title:previous.title,reason:'正文重复',duplicateOf:previous.url}]}
    },
  }))
  assert.equal(calls.length,2)
  assert.deepEqual(result.articles.map(row=>row.language),['zh'])
  assert.deepEqual(result.videos[0].searchedLanguages,['en','zh'])
  const skippedCalls:string[][] = []
  const skipped = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:result.videos,existingArticles:[previous,...result.articles]}),options({
    youtubeRunner:runner([metadata()],{},skippedCalls),collectNews:async () => assert.fail('Both languages were already searched'),
  }))
  assert.equal(skippedCalls.length,1)
  assert.equal(skipped.articles.length,0)
})

test('legacy English coverage still skips English-only requests without reading metadata', async () => {
  const previous = article('en'), calls:string[][] = []
  await collectNbaChannelNews(input({videosPerChannel:1,languages:['en'],existingArticles:[previous],existingVideos:[{
    videoId:id,url,channel,title,status:'collected',message:'Saved',articleIds:[previous.id],gameId:verified.id,
  }]}),options({youtubeRunner:runner([metadata()],{},calls),collectNews:async () => assert.fail('Existing English report should be skipped')}))
  assert.equal(calls.length,1)
})

test('a partial source failure or one remaining slot cannot mark both languages as searched', async () => {
  for (const partial of [true,false]) {
    const result = await collectNbaChannelNews(input({videosPerChannel:1,limit:partial ? 2 : 1}),options({
      youtubeRunner:runner([metadata()]),collectNews:async () => ({articles:[article('en')],excluded:[],
        sources:partial ? [{id:'sina',label:'Chinese source',status:'failed',count:0,error:'temporary failure'}] : []}),
    }))
    assert.equal(result.videos[0].status,'collected')
    assert.equal(result.videos[0].searchedLanguages,undefined)
  }
})

test('scanning stops at videosPerChannel even when early videos are already known', async () => {
  const calls:string[][] = []
  const result = await collectNbaChannelNews(input({videosPerChannel:1,existingVideos:[{videoId:id,url,channel,title,status:'excluded',message:'Duplicate',articleIds:[],searchedLanguages:['en','zh']}]}),options({youtubeRunner:runner(undefined,{},calls)}))
  assert.equal(calls.length,1)
  assert.equal(result.articles.length,0)
  assert.equal(result.videos.length,1)
})

test('pagination beyond 30 remains capped at the configured per-round scan limit', async () => {
  const ids = Array.from({length:35},(_,index)=>`video${String(index).padStart(6,'0')}`), calls:string[][] = []
  const existing = ids.slice(0,30).map(videoId=>({videoId,url:`https://www.youtube.com/watch?v=${videoId}`,channel,title,status:'excluded' as const,message:'Duplicate',articleIds:[],searchedLanguages:['en','zh'] as ('en'|'zh')[]}))
  const youtubeRunner:HistoryYoutubeRunner = async args => {
    calls.push(args)
    if (!args.includes('--flat-playlist')) return {stdout:JSON.stringify(metadata(new URL(args.at(-1)!).searchParams.get('v')!))}
    const range = args[args.indexOf('--playlist-items') + 1]
    return {stdout:JSON.stringify({entries:(range.startsWith('1:') ? ids.slice(0,30) : ids.slice(30)).map(videoId=>({id:videoId,title}))})}
  }
  const result = await collectNbaChannelNews(input({videosPerChannel:35,limit:1,existingVideos:existing}),options({youtubeRunner}))
  assert.equal(calls[0][calls[0].indexOf('--playlist-items') + 1],'1:30')
  assert.equal(calls[1][calls[1].indexOf('--playlist-items') + 1],'31:35')
  assert.equal(calls.length,3)
  assert.equal(result.articles.length,1)
  assert.equal(result.videos.at(-1)?.videoId,ids[30])
})

test('continuous rounds check new uploads first then advance committed historical progress', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'nba-channel-continuous-')); t.after(() => rmSync(directory,{recursive:true,force:true}))
  const scanStatePath = path.join(directory,'scan.json'), calls:string[] = []
  let ids = Array.from({length:120},(_,index)=>`video${String(index).padStart(6,'0')}`)
  const previous:NbaChannelVideo[] = [], articles:NbaArticle[] = []
  const youtubeRunner:HistoryYoutubeRunner = async args => {
    if (!args.includes('--flat-playlist')) return {stdout:JSON.stringify(metadata(new URL(args.at(-1)!).searchParams.get('v')!))}
    const range = args[args.indexOf('--playlist-items') + 1]; calls.push(range)
    const [start,end] = range.split(':').map(Number)
    return {stdout:JSON.stringify({entries:ids.slice(start - 1,end).map(videoId=>({id:videoId,title}))})}
  }
  const request = () => input({videosPerChannel:60,limit:100,scanStatePath,includeHistory:true,existingVideos:previous,existingArticles:articles})
  const collectNews:NbaChannelCollectionOptions['collectNews'] = async value => ({articles:[article('en',value.topic!.videoId)],excluded:[],sources:[]})
  const first = await collectNbaChannelNews(request(),options({youtubeRunner,collectNews}))
  assert.equal(first.videos.length,60)
  assert.equal(first.scanState!.channels[channel].nextIndex,61)
  assert.throws(()=>readFileSync(scanStatePath),'the caller must commit scan progress only after durable article storage')
  writeFileSync(scanStatePath,JSON.stringify(first.scanState)); previous.push(...first.videos); articles.push(...first.articles)
  ids = ['newest00001',...ids]
  calls.length = 0
  const second = await collectNbaChannelNews(request(),options({youtubeRunner,collectNews}))
  assert.equal(second.articles[0].sourceVideoId,'newest00001')
  assert.ok(second.videos.some(row=>row.videoId === ids[70]))
  assert.ok(second.scanState!.channels[channel].nextIndex > 80)
  assert.equal(calls[0],'1:30')
  assert.ok(calls.some(range=>Number(range.split(':')[0]) > 30))
  assert.ok(second.articles.every(row=>!articles.some(saved=>saved.sourceVideoId === row.sourceVideoId)))
})

test('busy rounds refresh newest videos without consuming historical progress', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'nba-channel-busy-')); t.after(() => rmSync(directory,{recursive:true,force:true}))
  const scanStatePath = path.join(directory,'scan.json')
  writeFileSync(scanStatePath,JSON.stringify({version:1,channels:{[channel]:{nextIndex:101,updatedAt:clock().toISOString()}}}))
  const ids = Array.from({length:120},(_,index)=>`video${String(index).padStart(6,'0')}`), ranges:string[] = []
  const existingVideos = ids.map(videoId=>({videoId,url:`https://www.youtube.com/watch?v=${videoId}`,channel,title,status:'excluded' as const,message:'known',articleIds:[],searchedLanguages:['en','zh'] as ('en'|'zh')[]}))
  const youtubeRunner:HistoryYoutubeRunner = async args => {
    const range = args[args.indexOf('--playlist-items') + 1]; ranges.push(range)
    const [start,end] = range.split(':').map(Number)
    return {stdout:JSON.stringify({entries:ids.slice(start-1,end).map(videoId=>({id:videoId,title}))})}
  }
  const result = await collectNbaChannelNews(input({videosPerChannel:1000,limit:100,scanStatePath,includeHistory:false,existingVideos}),options({youtubeRunner}))
  assert.deepEqual(ranges,['1:30'])
  assert.equal(result.scanState!.channels[channel].nextIndex,101)
  assert.equal(result.articles.length,0)
})

test('a quota reached mid-page retains the first unprocessed historical position', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'nba-channel-quota-')); t.after(() => rmSync(directory,{recursive:true,force:true}))
  const result = await collectNbaChannelNews(input({videosPerChannel:1000,limit:1,scanStatePath:path.join(directory,'scan.json'),includeHistory:true}),options())
  assert.equal(result.articles.length,1)
  assert.equal(result.scanState!.channels[channel].nextIndex,2)
})

test('scan limits above fifty paginate within the larger round budget', async () => {
  const ids = Array.from({length:1000},(_,index)=>`video${String(index).padStart(6,'0')}`), ranges:string[] = []
  const existingVideos = ids.map(videoId=>({videoId,url:`https://www.youtube.com/watch?v=${videoId}`,channel,title,status:'excluded' as const,message:'known',articleIds:[],searchedLanguages:['en','zh'] as ('en'|'zh')[]}))
  const youtubeRunner:HistoryYoutubeRunner = async args => {
    const range = args[args.indexOf('--playlist-items') + 1]; ranges.push(range)
    const [start,end] = range.split(':').map(Number)
    return {stdout:JSON.stringify({entries:ids.slice(start-1,end).map(videoId=>({id:videoId,title}))})}
  }
  const result = await collectNbaChannelNews(input({videosPerChannel:1000,limit:1,existingVideos}),options({youtubeRunner}))
  assert.equal(result.videos.length,1000)
  assert.equal(ranges.at(-1),'991:1000')
})

test('malformed metadata, wrong identity, missing title and channel errors remain visible and retryable', async () => {
  for (const value of ['not json',{...metadata(),id:secondId},{...metadata(),title:''},new Error('temporary YouTube outage')]) {
    const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({youtubeRunner:runner([metadata()],{[id]:value})}))
    assert.equal(result.videos[0].status,'failed')
    assert.equal(result.articles.length,0)
    assert.ok(result.sources.some(row=>row.status === 'failed'))
  }
  const empty = await collectNbaChannelNews(input(),options({youtubeRunner:runner([])}))
  assert.equal(empty.sources[0].status,'failed')
  assert.match(empty.sources[0].error || '',/可用视频/)
})

test('a valid video title supports topic collection when the description is empty or absent', async () => {
  for (const missingDescription of ['',undefined,null]) {
    const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({
      youtubeRunner:runner([metadata()],{[id]:{...metadata(),description:missingDescription}}),resolveVideoGame:async () => undefined,
      collectNews:async request => {
        assert.equal(request.topic?.title,title)
        assert.equal(request.topic?.description,'')
        return {articles:[article()],excluded:[],sources:[]}
      },
    }))
    assert.equal(result.videos[0].status,'collected')
    assert.equal(result.articles[0].topic?.description,'')
  }
})

test('a temporary news failure never permanently excludes a verified channel video', async () => {
  const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({collectNews:async () => ({articles:[],excluded:[{url:'https://news.example.com/denied',title:'News',reason:'HTTP 503'}],sources:[{id:'news',label:'News',status:'failed',count:0,error:'503'}]})}))
  assert.equal(result.videos[0].status,'failed')
  assert.equal(result.videos[0].gameId,verified.id)
  assert.match(result.videos[0].message,/可重试/)
})

test('a duplicate article alongside a temporary source failure still permits retrying the video', async () => {
  const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({collectNews:async () => ({articles:[],
    excluded:[{url:'https://news.example.com/old',title:'Old',reason:'Duplicate',duplicateOf:'https://news.example.com/old'}],
    sources:[{id:'source',label:'Source',status:'failed',count:0,error:'503'}]})}))
  assert.equal(result.videos[0].status,'failed')
})

test('only already-saved full stories make a verified video a permanent duplicate exclusion', async () => {
  const previous = article()
  const result = await collectNbaChannelNews(input({videosPerChannel:1,existingArticles:[previous]}),options({collectNews:async request => {
    assert.equal(request.existingArticles?.[0].id,previous.id)
    return {articles:[],excluded:[{url:previous.url,title:previous.title,reason:'正文重复',duplicateOf:previous.url}],sources:[]}
  }}))
  assert.equal(result.videos[0].status,'excluded')
})

test('topic collector articles do not require a verified or identical game in the channel layer', async () => {
  const unrelatedGame = {...article('zh'),game:{...verified,id:'espn-other'}}
  const result = await collectNbaChannelNews(input({videosPerChannel:1,limit:3}),options({collectNews:async () => ({articles:[
    {...article(),heldReason:'source game unverified'},unrelatedGame,{...article('en','no-game'),game:undefined},
  ],sources:[],excluded:[]})}))
  assert.equal(result.articles.length,3)
  assert.equal(result.videos[0].status,'collected')
  assert.equal(result.excluded.length,0)
  assert.ok(result.articles.every(row => row.topic?.videoId === id && row.youtubeUrl === url))
})

test('no full matching original article remains a clear retryable failure without requiring a game', async () => {
  const result = await collectNbaChannelNews(input({videosPerChannel:1}),options({collectNews:async () => ({
    articles:[],sources:[],excluded:[{url:'https://news.example.com/short',title:'Short story',reason:'少于100字'}],
  }),resolveVideoGame:async () => undefined}))
  assert.equal(result.videos[0].status,'failed')
  assert.match(result.videos[0].message,/视频主题匹配的独立完整新闻.*可重试/)
  assert.equal(result.videos[0].searchedLanguages,undefined)
})

test('cancellation keeps the captured metadata snapshot and prevents another video', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'nba-channel-stop-')); t.after(() => rmSync(directory,{recursive:true,force:true}))
  const controller = new AbortController(), calls:string[][] = []
  await assert.rejects(collectNbaChannelNews(input({signal:controller.signal,snapshotDir:directory}),options({youtubeRunner:runner(undefined,{},calls),resolveVideoGame:async () => {
    controller.abort(new Error('user stopped')); controller.signal.throwIfAborted(); return undefined
  }})),/user stopped/)
  assert.equal(calls.length,2)
  assert.equal(JSON.parse(readFileSync(path.join(directory,`${id}.metadata.json`),'utf8')).metadata.description,description)
})

test('a pre-aborted request and out-of-range scan limits do not start YouTube collection', async () => {
  const controller = new AbortController(); controller.abort(new Error('stop'))
  await assert.rejects(collectNbaChannelNews(input({signal:controller.signal}),options()),/stop/)
  for (const count of [0,1001,1.5]) await assert.rejects(collectNbaChannelNews(input({videosPerChannel:count}),options()),/1至1000/)
})
