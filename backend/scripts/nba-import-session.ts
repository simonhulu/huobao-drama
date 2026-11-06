import '../src/load-env.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { NbaVideoService } from '../src/services/nba-video.js'
import { nbaGameFingerprint } from '../src/services/nba-production.js'
import type { NbaArticle, NbaGame, NbaJob, NbaMedia } from '../src/services/nba-types.js'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function retain(source: string, target: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) {
    if (hash(source) !== hash(target)) throw new Error(`导入目标已有不同内容：${path.basename(target)}`)
    return target
  }
  try { fs.linkSync(source, target) }
  catch (error: any) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL) }
  return target
}

export async function importSessionNbaVideos(root = path.join(project, 'data/nba-video')) {
  if (fs.existsSync(path.join(root, '.production.lock'))) throw new Error('NBA 生产正在运行，请停止后再导入既有产物')
  const library = path.join(project, 'outputs/youtube-english-news-vDdPLHaKK4k-20261104')
  const videos = path.join(project, 'outputs/youtube-english-videos-vDdPLHaKK4k-20261104')
  const manifest = read(path.join(library, 'manifest.json'))
  const delivery = read(path.join(videos, 'delivery.json'))
  const scripts = read(path.join(videos, 'scripts.json'))
  const ledger = read(path.join(videos, 'research-ledger.json'))
  const now = new Date().toISOString()
  const game: NbaGame = { id: `espn-${manifest.match.espnEventId}`, espnEventId: manifest.match.espnEventId, nbaGameId: manifest.match.nbaGameId,
    tipoffUtc: manifest.match.utcTipoff, localDate: manifest.match.localDate, localTimezone: manifest.match.localTimezone,
    home: { name: 'Cleveland Cavaliers', abbreviation: 'CLE', score: 112 }, away: { name: 'Oklahoma City Thunder', abbreviation: 'OKC', score: 117 }, verified: true,
    evidenceUrls: [`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${manifest.match.espnEventId}`, `https://www.nba.com/game/${manifest.match.nbaGameId}`] }
  const shared = path.join(root, 'shared', game.id)
  const source = path.join(videos, 'assets')
  const sourceReport = read(path.join(source, 'asset-report.json'))
  const media: NbaMedia = { id: 'youtube-vDdPLHaKK4k', gameId: game.id, sourceUrl: manifest.video,
    path: retain(path.join(source, 'original.mp4'), path.join(shared, 'original.mp4')),
    reducedAudioPath: retain(path.join(source, 'reduced_commentary.wav'), path.join(shared, 'reduced_commentary.wav')),
    duration: 258.3414166666667, fps: 60000 / 1001, width: 1920, height: 1080,
    sha256: sourceReport.assets['original.mp4'].sha256, liveEndSeconds: 170.03653333333335, closingStartSeconds: 254.33741666666668,
    verified: true, verificationNotes: ['本会话已核验同场 NBA 官方视频、完整回合及球员反应；固定镜头点仅适用于此素材摘要', '源视频说明的 SGA 篮板数有冲突，已在中文稿中省略；球场声模型的局限已保留'] }
  if (hash(media.path) !== media.sha256 || hash(media.reducedAudioPath!) !== sourceReport.assets['reduced_commentary.wav'].sha256) throw new Error('共享素材校验失败')
  retain(path.join(source, 'source.info.json'), path.join(shared, 'source.info.json'))
  retain(path.join(source, 'source.description'), path.join(shared, 'source.description'))
  retain(path.join(source, 'asset-report.json'), path.join(shared, 'original-asset-report.json'))
  fs.writeFileSync(path.join(shared, 'manifest.json'), JSON.stringify({ version: 1, media, gameFingerprint: nbaGameFingerprint(game),
    sourceMetadata: read(path.join(source, 'source.info.json')), reducedAudioSha256: sourceReport.assets['reduced_commentary.wav'].sha256 }, null, 2) + '\n')
  const jobs: NbaJob[] = []
  for (const output of delivery.articles) {
    const entry = manifest.articles.find((item: any) => item.id === output.sourceArticleId)
    if (!entry?.videoCandidate || entry.requiresEditorialReview) throw new Error('待审核文章不能自动导入成片')
    const bodyFile = path.join(library, entry.bodyFile)
    if (hash(bodyFile) !== entry.bodySha256) throw new Error('新闻正文摘要发生变化')
    const article: NbaArticle = { id: entry.id, url: entry.url, title: entry.title, language: 'en', publisher: entry.publisher,
      byline: entry.byline, publishedAt: entry.published, body: fs.readFileSync(bodyFile, 'utf8'), bodyHash: entry.bodySha256,
      wordCount: entry.wordCount, characterCount: 0, collectedAt: `${manifest.collectedOn}T00:00:00+08:00`, game, youtubeUrl: manifest.video }
    const script = scripts.reports.find((item: any) => item.id === output.id)
    const target = path.join(root, 'jobs', `nba-session-${output.id}`)
    const jobSource = path.join(videos, output.id)
    const facts = script.factIds.map((id: string) => ledger.facts.find((fact: any) => fact.id === id)).map((fact: any) => ({ claim: fact.statement, paragraph: fact.paragraphs[0] }))
    const verification = read(path.join(jobSource, 'story-verification.json'))
    const videoPath = retain(path.join(videos, output.video), path.join(target, 'news.mp4'))
    if (hash(videoPath) !== output.sha256) throw new Error('成片摘要发生变化')
    for (const file of ['story-verification.json', 'ending-plan.json', 'captions.json', 'timing.json', 'output-probe.json']) retain(path.join(jobSource, file), path.join(target, `imported-${file}`))
    retain(path.join(videos, 'source-audit.json'), path.join(target, 'source-audit.json'))
    retain(path.join(videos, 'research-ledger.json'), path.join(target, 'research-ledger.json'))
    jobs.push({ id: `nba-session-${output.id}`, title: output.title, article, game, script: { title: script.title, text: script.text, facts },
      review: { passed: true, checkedAt: now, issues: [] }, media,
      delivery: { videoPath, coverPath: retain(path.join(jobSource, 'check.jpg'), path.join(target, 'cover.jpg')),
        voicePath: retain(path.join(jobSource, 'voice.wav'), path.join(target, 'voice.wav')),
        subtitlesPath: retain(path.join(jobSource, 'subtitles.srt'), path.join(target, 'subtitles.srt')),
        assPath: retain(path.join(jobSource, 'subtitles.ass'), path.join(target, 'subtitles.ass')),
        duration: output.seconds, bytes: output.bytes, sha256: output.sha256, verification: { ...verification, importedExistingDelivery: true } },
      status: 'completed', stage: 'completed', message: '已导入本会话完成的英文报道中文视频', createdAt: now, updatedAt: now,
      attempts: 0, canResume: false, logs: [{ at: now, stage: 'completed', message: '导入既有真实产物，核对正文、共享素材和成片 SHA-256；本次导入未重新生成' }] })
  }
  const service = new NbaVideoService({ root, scheduling: false })
  try { return service.importJobs(jobs) } finally { await service.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await importSessionNbaVideos(process.argv[2] ? path.resolve(process.argv[2]) : undefined)))
}
