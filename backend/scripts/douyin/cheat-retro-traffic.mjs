#!/usr/bin/env node
/**
 * Single-work Douyin traffic-analysis bridge for cheat-retro.
 *
 * The browser is the existing publish-douyin CDP Chrome. This command never
 * creates a login profile or asks the user to scan a QR code.
 *
 * Usage:
 *   node backend/scripts/douyin/cheat-retro-traffic.mjs \
 *     <aweme_id> <video_folder> [script_path]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { CDP_URL, PROJECT_ROOT, sleep } from './lib.mjs'
import {
  fetchTrafficAnalysis,
  localIso,
  trafficAnalysisMarkdown,
  trafficAnalysisUnavailableMarkdown,
  upsertReportSection,
} from './collect-traffic-analysis.mjs'

const DATA_CENTER_URL = 'https://creator.douyin.com/creator-micro/data-center/content'
const CDP_UNAVAILABLE_EXIT_CODE = 2

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatCount(value) {
  const parsed = numeric(value)
  if (parsed === null) return '-'
  if (parsed >= 10000) return `${(parsed / 10000).toFixed(1)}w`
  return String(Math.round(parsed))
}

function formatRate(value) {
  const parsed = numeric(value)
  if (parsed === null) return '-'
  const percentage = Math.abs(parsed) <= 1 ? parsed * 100 : parsed
  return `${percentage.toFixed(percentage >= 10 ? 1 : 2)}%`
}

function formatSeconds(value) {
  const parsed = numeric(value)
  return parsed === null ? '-' : `${parsed.toFixed(1)} 秒`
}

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 ${filePath}: ${error.message}`)
  }
}

function resolveFolder(rawFolder) {
  return path.isAbsolute(rawFolder)
    ? path.resolve(rawFolder)
    : path.resolve(PROJECT_ROOT, rawFolder)
}

function recordFromFolder(awemeId, folder) {
  const dataPath = path.join(folder, 'data.json')
  const sourceMatchPath = path.join(folder, 'source-match.json')
  const data = readJson(dataPath, {})
  const sourceMatch = readJson(sourceMatchPath, {})
  const resolvedAwemeId = String(awemeId || data.awemeId || data.aweme_id || sourceMatch.awemeId)
  return {
    ...data,
    awemeId: resolvedAwemeId,
    title: data.title || data.desc || sourceMatch.workTitle || `抖音作品 ${resolvedAwemeId}`,
    shareUrl: data.shareUrl || data.url || `https://www.douyin.com/video/${resolvedAwemeId}`,
    sourceMatch: data.sourceMatch || sourceMatch,
    metrics: { ...(data.metrics || {}) },
  }
}

function mergeTrafficRecord(record, analysis, capturedAt, error = null) {
  const hasAnalysis = Boolean(analysis?.metrics)
  const merged = {
    ...record,
    metrics: hasAnalysis
      ? { ...(record.metrics || {}), ...(analysis.metrics || {}) }
      : { ...(record.metrics || {}) },
    trafficAnalysisStatus: {
      status: hasAnalysis ? 'available' : (record.trafficAnalysis ? 'stale' : 'unavailable'),
      source: 'adapter:douyin-cdp',
      capturedAt,
      error: hasAnalysis ? null : (error || null),
    },
    trafficAnalysisFetchStatus: hasAnalysis ? 'available' : 'unavailable',
  }
  if (hasAnalysis) {
    merged.trafficAnalysis = analysis
    delete merged.trafficAnalysisError
  } else if (error) {
    merged.trafficAnalysisError = error
  }
  return merged
}

function basicReport(record, capturedAt) {
  const metrics = record.metrics || {}
  const views = metrics.view_count ?? record.statistics?.play_count ?? record.play_count
  const likes = metrics.like_count ?? record.statistics?.digg_count ?? record.like_count
  const comments = metrics.comment_count ?? record.statistics?.comment_count ?? record.comment_count
  const shares = metrics.share_count ?? record.statistics?.share_count ?? record.share_count
  const favorites = metrics.favorite_count ?? record.statistics?.collect_count ?? record.favorite_count
  return [
    `# ${record.title || '(无标题)'}`,
    '',
    '- 数据来源：`adapter:douyin-cdp`（复用 publish-douyin 的 CDP 会话）',
    `- 抓取时间：${capturedAt}`,
    `- 视频 ID：\`${record.awemeId}\``,
    `- 链接：${record.shareUrl}`,
    '',
    '## 作品数据',
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 播放 | ${formatCount(views)} |`,
    `| 点赞 | ${formatCount(likes)} |`,
    `| 评论 | ${formatCount(comments)} |`,
    `| 分享 | ${formatCount(shares)} |`,
    `| 收藏 | ${formatCount(favorites)} |`,
    '',
    '## 观看与互动率',
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 平均播放时长 | ${formatSeconds(metrics.avg_view_second)} |`,
    `| 平均播放占比 | ${formatRate(metrics.avg_view_proportion)} |`,
    `| 2 秒跳出率 | ${formatRate(metrics.bounce_rate_2s)} |`,
    `| 5 秒完播率 | ${formatRate(metrics.completion_rate_5s)} |`,
    `| 点赞率 | ${formatRate(metrics.like_rate)} |`,
    `| 评论率 | ${formatRate(metrics.comment_rate)} |`,
    `| 分享率 | ${formatRate(metrics.share_rate)} |`,
    `| 收藏率 | ${formatRate(metrics.favorite_rate)} |`,
    '',
  ].join('\n')
}

function trafficSection(analysis, error) {
  if (analysis?.metrics) return trafficAnalysisMarkdown(analysis)
  return trafficAnalysisUnavailableMarkdown(error)
}

export function buildTrafficReport(existingReport, record, analysis, capturedAt, error = null) {
  const section = trafficSection(analysis, error)
  if (existingReport) return upsertReportSection(existingReport, section)
  return `${upsertReportSection(basicReport(record, capturedAt), section)}\n`
}

export function persistTrafficRetro({ awemeId, videoFolder, analysis, capturedAt = localIso(), error = null }) {
  if (!awemeId || !videoFolder) throw new Error('缺少 aweme_id 或 video_folder')
  const folder = resolveFolder(videoFolder)
  fs.mkdirSync(folder, { recursive: true })
  const record = recordFromFolder(awemeId, folder)
  const merged = mergeTrafficRecord(record, analysis, capturedAt, error)
  const dataPath = path.join(folder, 'data.json')
  fs.writeFileSync(dataPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  const trafficPath = path.join(folder, 'traffic-analysis.json')
  fs.writeFileSync(trafficPath, `${JSON.stringify({
    awemeId: merged.awemeId,
    source: 'douyin:traffic-analysis:item_compare',
    capturedAt,
    status: analysis?.metrics ? 'available' : 'unavailable',
    error: analysis?.metrics ? null : (error || null),
    analysis: analysis || null,
  }, null, 2)}\n`, 'utf8')

  const reportPath = path.join(folder, 'report.md')
  const existingReport = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : ''
  fs.writeFileSync(reportPath, buildTrafficReport(existingReport, merged, analysis, capturedAt, error), 'utf8')
  return {
    folder,
    reportPath,
    dataPath,
    trafficPath,
    status: merged.trafficAnalysisStatus.status,
  }
}

function expectedUnavailable(error) {
  return /view count less than min view count|历史作品数|详情页指标不可用/i.test(String(error || ''))
}

async function collect(awemeId, videoFolder, scriptPath = '') {
  let browser
  let page
  try {
    try {
      browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
    } catch (error) {
      error.exitCode = CDP_UNAVAILABLE_EXIT_CODE
      throw error
    }

    page = await browser.newPage()
    page.setDefaultTimeout(60_000)
    await page.goto(DATA_CENTER_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await sleep(6_000)

    const analysis = await fetchTrafficAnalysis(page, awemeId)
    const result = persistTrafficRetro({ awemeId, videoFolder, analysis, capturedAt: analysis.capturedAt })
    if (scriptPath && fs.existsSync(scriptPath)) {
      const folder = resolveFolder(videoFolder)
      if (!fs.existsSync(path.join(folder, 'script.md')) && !fs.existsSync(path.join(folder, 'script.txt'))) {
        fs.copyFileSync(scriptPath, path.join(folder, 'script.txt'))
      }
    }
    console.log(JSON.stringify({ ok: true, source: 'douyin-cdp', ...result }, null, 2))
    return 0
  } catch (error) {
    const message = error?.message || String(error)
    if (error?.exitCode === CDP_UNAVAILABLE_EXIT_CODE) {
      console.error(`[douyin-cdp] CDP unavailable: ${message}`)
      return CDP_UNAVAILABLE_EXIT_CODE
    }

    try {
      const result = persistTrafficRetro({ awemeId, videoFolder, error: message })
      console.error(`[douyin-cdp] traffic analysis unavailable: ${message}`)
      console.log(JSON.stringify({ ok: expectedUnavailable(message), source: 'douyin-cdp', ...result }, null, 2))
    } catch (persistError) {
      console.error(`[douyin-cdp] ${message}`)
      console.error(`[douyin-cdp] failed to persist unavailable status: ${persistError.message}`)
    }
    return expectedUnavailable(message) ? 0 : 1
  } finally {
    if (page) await page.close().catch(() => {})
    if (browser) browser.disconnect()
  }
}

async function main() {
  const [awemeId, videoFolder, scriptPath = ''] = process.argv.slice(2)
  if (!awemeId || !videoFolder) {
    console.error('Usage: node cheat-retro-traffic.mjs <aweme_id> <video_folder> [script_path]')
    return 3
  }
  return collect(String(awemeId), videoFolder, scriptPath)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(`[douyin-cdp] ${error.stack || error.message || error}`)
    process.exitCode = 1
  })
}
