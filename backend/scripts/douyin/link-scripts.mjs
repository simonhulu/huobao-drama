#!/usr/bin/env node
/**
 * Link imported Douyin works to the local episode narration stored in SQLite.
 *
 * The database is opened read-only. A link is only promoted to `matched` when
 * the work description is strongly covered by one episode and the runner-up
 * is sufficiently weaker. Otherwise the result stays `needs_review` with
 * ranked candidates instead of inventing attribution.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { PROJECT_ROOT } from './lib.mjs'

const VIDEOS_DIR = path.join(PROJECT_ROOT, 'videos')
const STATE_PATH = path.join(PROJECT_ROOT, '.cheat-state.json')
const SUMMARY_PATH = path.join(VIDEOS_DIR, 'douyin-script-link-summary.md')
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data/huobao_drama.db')

function parseArgs(argv) {
  const args = { dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--db') {
      args.dbPath = argv[index + 1]
      index += 1
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/douyin/link-scripts.mjs [--db PATH] [--dry-run]')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/#[\p{L}\p{N}_-]+/gu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function ngrams(value, size = 3) {
  const text = normalizeText(value)
  if (!text) return new Set()
  const actualSize = text.length < size ? 1 : size
  const result = new Set()
  for (let index = 0; index + actualSize <= text.length; index += 1) {
    result.add(text.slice(index, index + actualSize))
  }
  return result
}

export function textCoverage(source, target) {
  const sourceGrams = ngrams(source)
  if (!sourceGrams.size) return 0
  const targetGrams = ngrams(target)
  let hits = 0
  for (const gram of sourceGrams) {
    if (targetGrams.has(gram)) hits += 1
  }
  return hits / sourceGrams.size
}

function maxCoverage(source, targets) {
  return Math.max(0, ...targets.map((target) => textCoverage(source, target)))
}

function episodeScript(episode) {
  if (String(episode.script_content || '').trim().length > 40) {
    return { field: 'script_content', text: episode.script_content.trim() }
  }
  if (String(episode.content || '').trim().length > 40) {
    return { field: 'content', text: episode.content.trim() }
  }
  return { field: null, text: '' }
}

function episodeCorpus(episode) {
  return [
    episode.title,
    episode.video_title,
    episode.description,
    episode.opening_hook,
    episode.cliffhanger,
    episode.content,
    episode.script_content,
  ].join(' ')
}

export function scoreEpisodeMatch(work, episode) {
  const script = episodeScript(episode)
  const workTitle = normalizeText(work.title)
  const episodeTitles = [episode.title, episode.video_title].filter(Boolean)
  const titleText = episodeTitles.join(' ')
  const titleExact = Boolean(workTitle && episodeTitles.some((title) => workTitle === normalizeText(title)))
  const titleCoverage = maxCoverage(work.title, [titleText])
  const titleReverseCoverage = maxCoverage(titleText, [work.title])
  const titleSimilarity = Math.max(titleCoverage, titleReverseCoverage)
  const corpus = episodeCorpus(episode)
  const descriptionCoverage = maxCoverage(work.description, [corpus, script.text])
  const episodeHookCoverage = maxCoverage(
    [episode.opening_hook, episode.cliffhanger].filter(Boolean).join(' '),
    [work.description],
  )
  const fullCoverage = textCoverage(`${work.title} ${work.description}`, corpus)
  const score = titleExact * 0.35
    + titleSimilarity * 0.2
    + Math.max(descriptionCoverage, episodeHookCoverage) * 0.35
    + fullCoverage * 0.1

  return {
    episode,
    script,
    score,
    titleExact,
    titleSimilarity,
    descriptionCoverage,
    episodeHookCoverage,
    fullCoverage,
  }
}

function scoreManifestMatch(work, manifest) {
  const titleSimilarity = Math.max(
    textCoverage(work.title, manifest.title),
    textCoverage(manifest.title, work.title),
  )
  const descriptionSimilarity = Math.max(
    textCoverage(manifest.description, work.description),
    textCoverage(work.description, manifest.description),
  )
  return {
    manifest,
    titleSimilarity,
    descriptionSimilarity,
    score: titleSimilarity * 0.35 + descriptionSimilarity * 0.65,
  }
}

function rankManifestMatches(work, manifests) {
  return manifests
    .map((manifest) => scoreManifestMatch(work, manifest))
    .sort((left, right) => right.score - left.score)
}

function rankEpisodeMatches(work, episodes) {
  return episodes
    .filter((episode) => episodeScript(episode).text.length > 100)
    .map((episode) => scoreEpisodeMatch(work, episode))
    .sort((left, right) => right.score - left.score)
}

function classifyEpisodeMatch(top, runnerUp) {
  if (!top) return { status: 'unmatched', confidence: 'none' }
  const margin = top.score - (runnerUp?.score || 0)
  const strongDescription = top.descriptionCoverage >= 0.72 && margin >= 0.1
  const exactTitle = top.titleExact && top.descriptionCoverage >= 0.2 && margin >= 0.1
  if (strongDescription || exactTitle) return { status: 'matched', confidence: 'high' }
  if (top.score >= 0.25) return { status: 'needs_review', confidence: 'medium' }
  return { status: 'unmatched', confidence: 'low' }
}

function formatScore(value) {
  return Number(value.toFixed(3))
}

function relativeFolder(folder) {
  return path.relative(PROJECT_ROOT, folder)
}

function readWorks() {
  if (!fs.existsSync(VIDEOS_DIR)) return []
  return fs.readdirSync(VIDEOS_DIR)
    .filter((name) => name !== 'douyin-import-summary.md' && name !== 'douyin-script-link-summary.md')
    .map((name) => path.join(VIDEOS_DIR, name))
    .filter((folder) => fs.statSync(folder).isDirectory())
    .map((folder) => ({
      folder,
      dataPath: path.join(folder, 'data.json'),
      data: JSON.parse(fs.readFileSync(path.join(folder, 'data.json'), 'utf8')),
    }))
}

function readManifests() {
  const manifestDir = path.join(PROJECT_ROOT, 'data/publish-manifests')
  if (!fs.existsSync(manifestDir)) return []
  return fs.readdirSync(manifestDir)
    .filter((name) => name.startsWith('douyin-') && name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(manifestDir, name), 'utf8')))
}

function candidateForOutput(item) {
  if (!item) return null
  return {
    episodeId: item.episode.id,
    dramaId: item.episode.drama_id,
    episodeNumber: item.episode.episode_number,
    title: item.episode.title,
    score: formatScore(item.score),
    titleExact: item.titleExact,
    titleSimilarity: formatScore(item.titleSimilarity),
    descriptionCoverage: formatScore(item.descriptionCoverage),
    fullCoverage: formatScore(item.fullCoverage),
    scriptField: item.script.field,
    scriptLength: item.script.text.length,
  }
}

function buildLink(work, episodes, manifests) {
  const manifestRanking = rankManifestMatches(work.data, manifests)
  const bestManifest = manifestRanking[0]
  const secondManifest = manifestRanking[1]
  const manifestAccepted = Boolean(
    bestManifest
      && bestManifest.titleSimilarity >= 0.45
      && bestManifest.descriptionSimilarity >= 0.55
      && bestManifest.score - (secondManifest?.score || 0) >= (manifests.length > 1 ? 0.04 : 0),
  )
  const episodeRanking = rankEpisodeMatches(work.data, episodes)
  const top = episodeRanking[0]
  const runnerUp = episodeRanking[1]
  const classification = classifyEpisodeMatch(top, runnerUp)
  const manifestEpisode = manifestAccepted
    ? episodes.find((episode) => episode.id === Number(bestManifest.manifest.episode_id))
    : null
  const selected = manifestEpisode ? scoreEpisodeMatch(work.data, manifestEpisode) : top
  const selectedClassification = manifestEpisode
    ? { status: 'matched', confidence: 'high' }
    : classification
  const margin = selected ? selected.score - (runnerUp?.score || 0) : 0

  return {
    status: selectedClassification.status,
    confidence: selectedClassification.confidence,
    method: manifestEpisode ? 'publish-manifest+episode-id' : 'text-similarity',
    awemeId: work.data.awemeId,
    workTitle: work.data.title,
    workFolder: relativeFolder(work.folder),
    episodeId: selected?.episode.id || null,
    dramaId: selected?.episode.drama_id || null,
    episodeNumber: selected?.episode.episode_number || null,
    episodeTitle: selected?.episode.title || null,
    sourceField: selected?.script.field || null,
    sourceScriptLength: selected?.script.text.length || 0,
    score: selected ? formatScore(selected.score) : 0,
    margin: formatScore(margin),
    signals: selected ? {
      titleExact: selected.titleExact,
      titleSimilarity: formatScore(selected.titleSimilarity),
      descriptionCoverage: formatScore(selected.descriptionCoverage),
      episodeHookCoverage: formatScore(selected.episodeHookCoverage),
      fullCoverage: formatScore(selected.fullCoverage),
      manifestScore: manifestAccepted ? formatScore(bestManifest.score) : null,
    } : null,
    candidates: episodeRanking.slice(0, 5).map(candidateForOutput),
    manifest: manifestAccepted ? {
      episodeId: Number(bestManifest.manifest.episode_id),
      title: bestManifest.manifest.title,
      score: formatScore(bestManifest.score),
    } : null,
    scriptText: selected?.script.text || '',
  }
}

function scriptMarkdown(link) {
  return [
    `# 口播文稿：${link.workTitle || '(无标题)'}`,
    '',
    `- 抖音作品 ID：\`${link.awemeId}\``,
    `- 本地 episode：\`${link.episodeId}\`（${link.episodeTitle || '未知'}）`,
    `- 匹配方式：\`${link.method}\``,
    `- 匹配置信度：${link.confidence}（score ${link.score}，margin ${link.margin}）`,
    `- 来源字段：\`${link.sourceField}\``,
    '',
    '## 数据库中的口播正文',
    '',
    link.scriptText.trim(),
    '',
  ].join('\n')
}

function updateDataFile(work, link) {
  const data = JSON.parse(fs.readFileSync(work.dataPath, 'utf8'))
  data.sourceMatch = {
    status: link.status,
    confidence: link.confidence,
    method: link.method,
    episodeId: link.episodeId,
    dramaId: link.dramaId,
    episodeNumber: link.episodeNumber,
    score: link.score,
    margin: link.margin,
    sourceField: link.sourceField,
  }
  fs.writeFileSync(work.dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function annotateReport(work, link) {
  const reportPath = path.join(work.folder, 'report.md')
  if (!fs.existsSync(reportPath)) return
  const report = fs.readFileSync(reportPath, 'utf8')
  const line = link.status === 'matched'
    ? `- 原稿状态：已匹配 episode ${link.episodeId}（${link.confidence}，score ${link.score}）`
    : link.status === 'needs_review'
      ? `- 原稿状态：待人工确认（最佳候选 episode ${link.episodeId || '-'}，score ${link.score}）`
      : '- 原稿状态：未匹配'
  const next = report.replace(/^- 原稿状态：.*$/m, line)
  if (next !== report) fs.writeFileSync(reportPath, next, 'utf8')
}

function writeLinkArtifacts(work, link) {
  fs.writeFileSync(path.join(work.folder, 'source-match.json'), `${JSON.stringify({ ...link, scriptText: undefined }, null, 2)}\n`, 'utf8')
  if (link.status === 'matched' && link.scriptText) {
    const scriptPath = path.join(work.folder, 'script.md')
    if (!fs.existsSync(scriptPath)) fs.writeFileSync(scriptPath, scriptMarkdown(link), 'utf8')
  }
  updateDataFile(work, link)
  annotateReport(work, link)
}

function linkSummary(links) {
  const matched = links.filter((link) => link.status === 'matched').length
  const review = links.filter((link) => link.status === 'needs_review').length
  const unmatched = links.filter((link) => link.status === 'unmatched').length
  const lines = [
    '# 抖音作品与口播文稿匹配摘要',
    '',
    '- 数据库：`data/huobao_drama.db`（只读）',
    `- 作品总数：${links.length}`,
    `- 高置信度已匹配：${matched}`,
    `- 待人工确认：${review}`,
    `- 未匹配：${unmatched}`,
    '',
    '| 状态 | 抖音作品 | episode | 匹配方式 | score | margin |',
    '| --- | --- | ---: | --- | ---: | ---: |',
  ]
  for (const link of links) {
    const title = String(link.workTitle || '(无标题)').replaceAll('|', '\\|')
    lines.push(`| ${link.status} | ${title} | ${link.episodeId || '-'} | ${link.method} | ${link.score} | ${link.margin} |`)
  }
  return `${lines.join('\n')}\n`
}

function localIso() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+08:00`
}

function updateState(links, capturedAt) {
  if (!fs.existsSync(STATE_PATH)) return
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  state.douyin_script_linker = 'backend/scripts/douyin/link-scripts.mjs'
  state.historical_scripts_matched = links.filter((link) => link.status === 'matched').length
  state.historical_scripts_needs_review = links.filter((link) => link.status === 'needs_review').length
  state.last_douyin_script_link_at = capturedAt
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function linkHistoricalWorks({ dbPath = process.env.DB_PATH || DEFAULT_DB_PATH, dryRun = false } = {}) {
  const works = readWorks()
  const manifests = readManifests()
  const db = new Database(dbPath, { readonly: true })
  try {
    const episodes = db.prepare('SELECT * FROM episodes ORDER BY id').all()
    const links = works.map((work) => buildLink(work, episodes, manifests))
    if (!dryRun) {
      for (let index = 0; index < works.length; index += 1) writeLinkArtifacts(works[index], links[index])
      fs.writeFileSync(SUMMARY_PATH, linkSummary(links), 'utf8')
      updateState(links, localIso())
    }
    return {
      total: links.length,
      matched: links.filter((link) => link.status === 'matched').length,
      needsReview: links.filter((link) => link.status === 'needs_review').length,
      unmatched: links.filter((link) => link.status === 'unmatched').length,
      summary: path.relative(PROJECT_ROOT, SUMMARY_PATH),
      links,
    }
  } finally {
    db.close()
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = linkHistoricalWorks(args)
  console.log(JSON.stringify({
    ok: true,
    total: result.total,
    matched: result.matched,
    needsReview: result.needsReview,
    unmatched: result.unmatched,
    dryRun: args.dryRun,
    summary: result.summary,
  }, null, 2))
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    console.error(`[douyin-linker] ${error.stack || error.message || error}`)
    process.exitCode = 1
  }
}
