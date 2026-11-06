import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
import type { collectHistoryYoutubeVideos, HistoryYoutubeCandidate, HistoryYoutubeRunner } from './history-source-youtube.js'
import { collectNbaNews, resolveNbaVideoGame, type NbaNewsOptions, type NbaVideoMetadata } from './nba-news.js'
import type { NbaArticle, NbaChannelVideo, NbaGame, NbaIntakeResult, NbaLanguage, NbaSourceReport, NbaTopic } from './nba-types.js'

export interface NbaChannelCollectionInput {
  youtubeChannels: string[]
  videosPerChannel: number
  languages: NbaLanguage[]
  limit: number
  signal: AbortSignal
  existingArticles?: NbaArticle[]
  existingVideos?: NbaChannelVideo[]
  reservedVideoIds?: string[]
  snapshotDir?: string
  scanStatePath?: string
  includeHistory?: boolean
  progress?: (message:string) => void
}
export interface NbaChannelScanState {
  version: 1
  channels: Record<string,{nextIndex:number;updatedAt:string}>
}
export type NbaChannelCollectionResult = NbaIntakeResult & {videos:NbaChannelVideo[];scanState?:NbaChannelScanState}
export interface NbaChannelCollectionOptions extends NbaNewsOptions {
  collectYoutube?: typeof collectHistoryYoutubeVideos
  youtubeRunner?: HistoryYoutubeRunner
  resolveVideoGame?: (metadata:NbaVideoMetadata, signal?:AbortSignal, options?:NbaNewsOptions) => Promise<NbaGame | undefined>
  collectNews?: typeof collectNbaNews
}
type Metadata = Record<string,unknown>
const message = (error:unknown) => String(error instanceof Error ? error.message : error).slice(0,1200)
async function snapshot(directory:string | undefined, candidate:HistoryYoutubeCandidate, raw:Metadata, game:NbaGame | undefined, outcome:NbaChannelVideo, now:() => Date) {
  if (!directory) return
  await mkdir(directory,{recursive:true,mode:0o700})
  const metadata = path.join(directory,`${candidate.videoId}.metadata.json`), temporary = `${metadata}.${randomUUID()}.tmp`
  await writeFile(temporary,JSON.stringify({collectedAt:now().toISOString(),channel:candidate.collectionUrl,candidate,metadata:raw,game,outcome},null,2),{mode:0o600,flag:'wx'})
  await rename(temporary,metadata)
  await writeFile(path.join(directory,`${candidate.videoId}.description.txt`),typeof raw.description === 'string' ? raw.description : '',{mode:0o600})
}

export async function collectNbaChannelNews(input:NbaChannelCollectionInput, options:NbaChannelCollectionOptions = {}):Promise<NbaChannelCollectionResult> {
  input.signal.throwIfAborted()
  if (!Number.isInteger(input.videosPerChannel) || input.videosPerChannel < 1 || input.videosPerChannel > 1000) throw Error('每频道扫描数量必须为1至1000')
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !input.languages.length || input.languages.some(value => !['en','zh'].includes(value))) throw Error('NBA 采集语言或数量无效')
  if (!input.youtubeChannels.length || input.youtubeChannels.length > 30) throw Error('请配置1至30个YouTube频道')
  const channels = [...new Set(input.youtubeChannels.map(value => {
    const parsed = parseHistoryYoutubeUrl(value)
    if (parsed.kind !== 'channel') throw Error('频道采集只接受YouTube频道主页或videos链接')
    return parsed.url
  }))]
  const youtube = options.collectYoutube && options.youtubeRunner ? undefined : await import('./history-source-youtube.js')
  const collect = options.collectYoutube || youtube!.collectHistoryYoutubeVideos
  const runner = options.youtubeRunner || youtube!.runYoutube
  const now = options.now || (() => new Date()), result:NbaChannelCollectionResult = {articles:[],excluded:[],sources:[],videos:[]}
  if (input.scanStatePath) {
    let saved:NbaChannelScanState = {version:1,channels:{}}
    try { saved = JSON.parse(await readFile(input.scanStatePath,'utf8')) }
    catch (error:any) { if (error.code !== 'ENOENT') throw Error('频道历史扫描进度无法读取，请检查状态文件') }
    if (saved?.version !== 1 || !saved.channels || Array.isArray(saved.channels)
      || Object.values(saved.channels).some(row => !row || !Number.isSafeInteger(row.nextIndex) || row.nextIndex < 1)) throw Error('频道历史扫描进度无效，请检查状态文件')
    result.scanState = structuredClone(saved)
  }
  const existing = [...(input.existingArticles || [])]
  const savedVideos = new Map((input.existingVideos || []).map(row => [row.videoId,row]))
  const reserved = new Set(input.reservedVideoIds || [])
  const reservedReason = '该视频已有制作任务，请继续原任务'
  const known = new Map((input.existingVideos || []).filter(row => {
    if (row.status === 'failed') return false
    const covered = [...(row.searchedLanguages || []), ...existing.filter(article => row.articleIds.includes(article.id)
      || article.sourceVideoId === row.videoId).map(article => article.language)]
    return input.languages.every(language => covered.includes(language))
  }).map(row => [row.videoId,row]))
  const seen = new Set<string>()
  const reached = () => result.articles.length >= input.limit
  const fail = (row:NbaSourceReport,error:unknown) => { input.signal.throwIfAborted(); row.status = row.count ? 'partial' : 'failed'; row.error = message(error) }
  for (const channel of channels) {
    input.signal.throwIfAborted()
    if (reached()) break
    const report:NbaSourceReport = {id:`youtube-channel-${result.sources.length}`,label:channel,status:'ok',count:0}
    result.sources.push(report)
    let scanned = 0, observed = 0
    const savedNextIndex = result.scanState?.channels[channel]?.nextIndex || 1
    let nextIndex = savedNextIndex
    try {
      for (const mode of result.scanState ? ['latest','history'] : ['bounded']) {
        if (reached() || scanned >= input.videosPerChannel || mode === 'history' && input.includeHistory === false) break
        const budget = mode === 'latest' ? Math.min(30,input.includeHistory === false ? input.videosPerChannel : Math.ceil(input.videosPerChannel / 2)) : input.videosPerChannel - scanned
        const overlap = mode === 'history' && savedNextIndex > 1 ? Math.min(5,Math.floor(budget / 4)) : 0
        const firstIndex = mode === 'history' ? Math.max(1,nextIndex - overlap) : 1
        let passScanned = 0, sourceExhausted = false
        const limitedRunner:HistoryYoutubeRunner = async (args,runnerOptions) => {
          const playlist = args.indexOf('--playlist-items'), changed = [...args]
          if (playlist < 0) return runner(changed,runnerOptions)
          const [relativeStart,relativeEnd] = (args[playlist + 1] || '').split(':').map(Number)
          const start = firstIndex + relativeStart - 1, end = firstIndex + Math.min(relativeEnd,budget) - 1
          changed[playlist + 1] = `${start}:${end}`
          input.progress?.(`读取频道${mode === 'history' ? '历史' : '最新'}视频：第${start}至${end}条`)
          const output = await runner(changed,runnerOptions)
          try {
            const info = JSON.parse(output.stdout)
            if (Array.isArray(info.entries) && info.entries.length < end - start + 1) sourceExhausted = true
          } catch { /* The shared collector reports invalid JSON. */ }
          return output
        }
        await collect({url:channel,signal:input.signal,targetCount:budget,
        isTargetReached:() => reached() || passScanned >= budget,
        isKnownVideo:id => reserved.has(id) || seen.has(id) || known.has(id),
        knownVideoReason:id => reserved.has(id) ? reservedReason : '该视频已完成所选语言的新闻采集',
        report:event => {
          input.signal.throwIfAborted()
          if (event.scanned !== undefined) { scanned += Math.max(0,event.scanned - passScanned); passScanned = Math.max(passScanned,event.scanned) }
          if (event.candidate?.outcome === 'skipped') {
            observed++
            const videoId = event.candidate.videoId
            if (reserved.has(videoId)) {
              const saved = savedVideos.get(videoId)
              if (!result.videos.some(row => row.videoId === videoId)) result.videos.push({
                ...(saved || {videoId,url:`https://www.youtube.com/watch?v=${videoId}`,channel,title:event.candidate.title || videoId,articleIds:[]}),
                status:saved?.status === 'collected' ? 'collected' : 'excluded',message:`已跳过：${reservedReason}`,
              })
            } else {
              const saved = known.get(videoId)
              if (saved && !result.videos.some(row => row.videoId === saved.videoId)) result.videos.push({...saved,message:`已跳过：${saved.message.replace(/^(?:已跳过[：:]\s*)+/, '')}`})
            }
          }
          input.progress?.(event.message)
        },
        onCandidate:async candidate => {
          input.signal.throwIfAborted()
          if (reached()) return
          observed++
          seen.add(candidate.videoId)
          const video:NbaChannelVideo = {videoId:candidate.videoId,url:candidate.sourceUrl,channel,title:candidate.title,status:'failed',message:'正在读取完整视频描述',articleIds:[]}
          result.videos.push(video)
          let raw:Metadata = {}, game:NbaGame | undefined, complete:HistoryYoutubeCandidate | undefined
          const source:NbaSourceReport = {id:`youtube-video-${candidate.videoId}`,label:candidate.title,status:'ok',count:0}
          result.sources.push(source)
          try {
            input.progress?.(`读取完整视频描述：${candidate.title}`)
            const capture:HistoryYoutubeRunner = async (args,runnerOptions) => {
              // Metadata is still useful when YouTube withholds playable formats from the current session.
              const metadataArgs = [...args]
              metadataArgs.splice(metadataArgs.indexOf('--'),0,'--ignore-no-formats-error')
              const output = await runner(metadataArgs,runnerOptions)
              try { const parsed = JSON.parse(output.stdout); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed } catch { /* The shared collector reports invalid JSON. */ }
              return output
            }
            await collect({url:candidate.sourceUrl,signal:input.signal,targetCount:1,isKnownVideo:() => false,isTargetReached:() => Boolean(complete),
              report:event => input.progress?.(event.message),onCandidate:async value => { complete = value },
            },capture)
            input.signal.throwIfAborted()
            if (!complete) throw Error('YouTube未返回可用的单视频元数据')
            if (!Object.keys(raw).length) throw Error('未保留完整视频元数据，可重试')
            if (raw.id !== candidate.videoId || typeof raw.title !== 'string' || !raw.title.trim()) throw Error('完整视频元数据与频道视频身份不符')
            video.title = raw.title
            const description = typeof raw.description === 'string' ? raw.description : ''
            raw.description = description
            const topic:NbaTopic = {id:`youtube-${video.videoId}`,videoId:video.videoId,title:video.title,description,youtubeUrl:video.url,
              channel:typeof raw.channel === 'string' ? raw.channel : channel,uploadDate:typeof raw.upload_date === 'string' ? raw.upload_date : undefined}
            await snapshot(input.snapshotDir,candidate,raw,game,video,now)
            try {
              game = await (options.resolveVideoGame || resolveNbaVideoGame)({title:video.title,description,uploadDate:topic.uploadDate},input.signal,options)
            } catch {
              input.signal.throwIfAborted()
              input.progress?.(`比赛信息暂不可用，继续按视频主题采集新闻：${video.title}`)
            }
            video.gameId = game?.id
            const remaining = input.limit - result.articles.length
            const news = await (options.collectNews || collectNbaNews)({topic,languages:input.languages,limit:remaining,articleUrls:[],
              espnEventId:game?.espnEventId,gameDate:game?.localDate,existingArticles:existing,signal:input.signal,progress:input.progress},options)
            input.signal.throwIfAborted()
            result.excluded.push(...news.excluded); result.sources.push(...news.sources)
            for (const article of news.articles) {
              article.topic = topic; article.youtubeUrl = video.url; article.sourceVideoId = video.videoId; article.sourceChannel = channel
              result.articles.push(article); existing.push(article); video.articleIds.push(article.id)
              if (reached()) break
            }
            const repeated = !news.articles.length && news.excluded.some(row => row.duplicateOf) && !news.sources.some(row => row.status !== 'ok')
            video.status = video.articleIds.length ? 'collected' : repeated ? 'excluded' : 'failed'
            if (video.status !== 'failed' && remaining >= input.languages.length && news.sources.every(row => row.status === 'ok')) {
              video.searchedLanguages = [...input.languages]
            }
            video.message = video.articleIds.length ? `已按视频主题采集${video.articleIds.length}篇独立完整新闻` : repeated ? '该主题可用新闻正文已保存，本轮跳过重复报道' : '未取得与视频主题匹配的独立完整新闻，可重试'
            source.count = 1; report.count++
          } catch (error) {
            video.status = 'failed'; video.message = input.signal.aborted ? '采集已停止，已保留元数据与描述，可重试' : message(error)
            fail(source,error)
          } finally {
            await snapshot(input.snapshotDir,candidate,raw,game,video,now)
          }
        },
        },limitedRunner)
        if (result.scanState) {
          if (mode === 'history') nextIndex = Math.max(nextIndex,firstIndex + passScanned)
          else if (nextIndex <= passScanned + 1) nextIndex = passScanned + 1
          if (sourceExhausted && !reached()) nextIndex = 1
          result.scanState.channels[channel] = {nextIndex,updatedAt:now().toISOString()}
        }
        if (sourceExhausted) break
      }
      input.signal.throwIfAborted()
      if (!scanned || !observed) throw Error('频道未返回可用视频，未完成新闻采集')
      if (result.videos.some(row => row.channel === channel && row.status === 'failed')) { report.status = report.count ? 'partial' : 'failed'; report.error = '部分视频的元数据或新闻读取失败，可重试' }
    } catch (error) { fail(report,error) }
  }
  return result
}
