#!/usr/bin/env node
/**
 * Collect the metrics shown under a Douyin work detail page's "流量分析" tab.
 *
 * It reuses the authenticated CDP page and the creator-center endpoint used
 * by that tab. The endpoint is read-only and returns both the current metric
 * and Douyin's comparison value/suggestion.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import { CDP_URL, PROJECT_ROOT, sleep } from './lib.mjs'

const TRAFFIC_ENDPOINT = '/janus/douyin/creator/data/diagnose/item_compare'
const DATA_CENTER_URL = 'https://creator.douyin.com/creator-micro/data-center/content'
const VIDEOS_DIR = path.join(PROJECT_ROOT, 'videos')
const STATE_PATH = path.join(PROJECT_ROOT, '.cheat-state.json')
const SUMMARY_PATH = path.join(VIDEOS_DIR, 'douyin-traffic-analysis-summary.md')

const RATE_METRICS = new Set([
  'bounce_rate_2s',
  'comment_rate',
  'completion_rate',
  'completion_rate_5s',
  'cover_click_rate',
  'dislike_rate',
  'favorite_rate',
  'fan_view_proportion',
  'like_rate',
  'share_rate',
  'subscribe_rate',
  'unsubscribe_rate',
  'avg_view_proportion',
])

const DISPLAY_METRICS = [
  ['bounce_rate_2s', '2 秒跳出率'],
  ['completion_rate_5s', '5 秒完播率'],
  ['comment_count', '评论量'],
  ['comment_rate', '评论率'],
  ['avg_view_second', '平均播放时长'],
  ['avg_view_proportion', '平均播放占比'],
  ['completion_rate', '完播率'],
  ['like_count', '点赞量'],
  ['share_count', '分享量'],
  ['favorite_count', '收藏量'],
  ['subscribe_count', '吸粉量'],
]

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function formatNumber(value) {
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

function formatMetric(name, value) {
  if (value === null || value === undefined || value === '') return '-'
  if (name === 'avg_view_second') {
    const parsed = numeric(value)
    return parsed === null ? '-' : `${parsed.toFixed(1)} 秒`
  }
  if (RATE_METRICS.has(name)) return formatRate(value)
  return formatNumber(value)
}

export function localIso() {
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

export function normalizeTrafficPayload(payload, capturedAt = localIso()) {
  const item = payload.item || payload.items?.[0] || {}
  const metrics = item.metrics || {}
  const comparison = Object.fromEntries((Array.isArray(payload.metrics) ? payload.metrics : []).map((metric) => [metric.name, {
    name: metric.name,
    nameDesc: metric.name_desc || metric.name,
    selfValue: metric.self_value ?? metrics[metric.name] ?? null,
    compareValue: metric.compare_value ?? null,
    changeRatio: numeric(metric.change_ratio),
    diffValue: numeric(metric.diff_value),
    affectType: metric.affect_type ?? null,
    suggestion: metric.suggestion || '',
    summary: metric.summary || '',
  }]))
  return {
    source: 'douyin:traffic-analysis:item_compare',
    capturedAt,
    itemId: String(item.id || ''),
    metrics,
    comparison,
    selectedMetrics: payload.selected_metrics || [],
    viewCountMetric: payload.view_count_metric || null,
    compareHour: payload.compare_hour || null,
  }
}

export async function fetchTrafficAnalysis(page, awemeId) {
  const result = await page.evaluate(async ({ endpoint, id }) => {
    const url = `${endpoint}?item_id=${encodeURIComponent(id)}&selected_metric_count=2`
    const response = await fetch(url, { credentials: 'include' })
    return { status: response.status, body: await response.text() }
  }, { endpoint: TRAFFIC_ENDPOINT, id: String(awemeId) })
  if (result.status < 200 || result.status >= 300) throw new Error(`流量分析请求失败: HTTP ${result.status}`)
  const payload = JSON.parse(result.body)
  if (Number(payload.status_code ?? payload.BaseResp?.StatusCode ?? 0) !== 0) {
    throw new Error(`流量分析接口错误: ${payload.status_msg || payload.BaseResp?.StatusMessage || 'unknown'}`)
  }
  return normalizeTrafficPayload(payload)
}

export async function enrichRecordsWithTraffic(page, records, { onProgress } = {}) {
  const result = { enriched: 0, failed: 0, errors: [] }
  for (const [index, record] of records.entries()) {
    try {
      const analysis = await fetchTrafficAnalysis(page, record.awemeId)
      record.trafficAnalysis = analysis
      record.trafficAnalysisFetchStatus = 'available'
      delete record.trafficAnalysisError
      record.metrics = { ...(record.metrics || {}), ...(analysis.metrics || {}) }
      result.enriched += 1
    } catch (error) {
      record.trafficAnalysisFetchStatus = 'unavailable'
      record.trafficAnalysisError = error.message
      result.failed += 1
      result.errors.push({ awemeId: record.awemeId, message: error.message })
    }
    onProgress?.(index + 1, records.length, record)
    await sleep(120)
  }
  return result
}

export function trafficAnalysisMarkdown(analysis) {
  if (!analysis?.metrics) return ''
  const lines = [
    '## 流量分析（作品分析）',
    '',
    '| 指标 | 当前值 | 对比往期 | 变化 | 抖音建议 |',
    '| --- | ---: | ---: | ---: | --- |',
  ]
  for (const [name, label] of DISPLAY_METRICS) {
    const comparison = analysis.comparison?.[name]
    const change = comparison?.changeRatio === null || comparison?.changeRatio === undefined
      ? '-'
      : formatRate(comparison.changeRatio)
    const suggestion = String(comparison?.suggestion || '').replaceAll('|', '\\|').replaceAll('\n', ' ')
    lines.push(`| ${label} | ${formatMetric(name, analysis.metrics[name])} | ${formatMetric(name, comparison?.compareValue)} | ${change} | ${suggestion || '-'} |`)
  }
  return lines.join('\n')
}

export function trafficAnalysisUnavailableMarkdown(error) {
  const message = String(error || '详情页流量分析接口未返回数据').replaceAll('|', '\\|').replaceAll('\n', ' ')
  return [
    '## 流量分析（作品分析）',
    '',
    `- 详情页指标不可用：${message}`,
    '- 本次保留作品列表中的基础数据，但没有把它当作详情页“流量分析”数据。',
  ].join('\n')
}

function trafficFetchAvailable(record) {
  if (record.trafficAnalysisFetchStatus) return record.trafficAnalysisFetchStatus === 'available'
  return Boolean(record.trafficAnalysis)
}

export function upsertReportSection(report, section) {
  if (!section) return report
  const marker = '## 流量分析（作品分析）'
  const start = report.indexOf(marker)
  if (start >= 0) {
    const next = report.indexOf('\n## ', start + marker.length)
    if (next >= 0) return `${report.slice(0, start).trimEnd()}\n\n${section}\n${report.slice(next)}`
    return `${report.slice(0, start).trimEnd()}\n\n${section}\n`
  }
  const commentsStart = report.indexOf('\n## 评论')
  if (commentsStart >= 0) return `${report.slice(0, commentsStart).trimEnd()}\n\n${section}\n${report.slice(commentsStart)}`
  return `${report.trimEnd()}\n\n${section}\n`
}

function updateState(records, capturedAt) {
  if (!fs.existsSync(STATE_PATH)) return
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  state.douyin_traffic_analysis_collector = 'backend/scripts/douyin/collect-traffic-analysis.mjs'
  state.douyin_traffic_analysis_count = records.filter(trafficFetchAvailable).length
  state.last_douyin_traffic_analysis_at = capturedAt
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function persistTrafficArtifacts(records, capturedAt = localIso()) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true })
  for (const record of records) {
    const folder = path.isAbsolute(record.folder) ? record.folder : path.join(PROJECT_ROOT, record.folder)
    const sourceMatchPath = path.join(folder, 'source-match.json')
    const linkedMatch = fs.existsSync(sourceMatchPath)
      ? JSON.parse(fs.readFileSync(sourceMatchPath, 'utf8'))
      : null
    const episodeId = record.episodeId ?? record.sourceMatch?.episodeId ?? linkedMatch?.episodeId ?? null
    const dataPath = path.join(folder, 'data.json')
    if (fs.existsSync(dataPath)) {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
      const currentFetchAvailable = trafficFetchAvailable(record)
      if (record.trafficAnalysis) {
        data.metrics = { ...(data.metrics || {}), ...(record.metrics || {}) }
        data.trafficAnalysis = record.trafficAnalysis
      }
      data.trafficAnalysisStatus = {
        status: currentFetchAvailable ? 'available' : (data.trafficAnalysis ? 'stale' : 'unavailable'),
        capturedAt,
        error: currentFetchAvailable ? null : (record.trafficAnalysisError || null),
      }
      fs.writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    }
    const reportPath = path.join(folder, 'report.md')
    if (fs.existsSync(reportPath)) {
      const report = fs.readFileSync(reportPath, 'utf8')
      const section = trafficFetchAvailable(record) && record.trafficAnalysis
        ? trafficAnalysisMarkdown(record.trafficAnalysis)
        : trafficAnalysisUnavailableMarkdown(record.trafficAnalysisError)
      fs.writeFileSync(reportPath, upsertReportSection(report, section), 'utf8')
    }
  }
  const available = records.filter(trafficFetchAvailable)
  const unavailable = records.filter((record) => !available.includes(record))
  const lines = [
    '# 抖音流量分析数据摘要',
    '',
    `- 数据来源：详情页“流量分析”接口（CDP ${CDP_URL}）`,
    `- 抓取时间：${capturedAt}`,
    `- 详情页流量分析可用：${available.length} / ${records.length}`,
    `- 详情页流量分析不可用：${unavailable.length}（通常是播放量或历史作品数未达到抖音的分析门槛）`,
    '- 重要：不可用作品只保留基础数据，不用作品列表数据冒充详情页流量分析。',
    '',
    '| 作品 | episode | 2 秒跳出率 | 5 秒完播率 | 评论量 | 平均播放时长 | 平均播放占比 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const record of records) {
    const analysis = record.trafficAnalysis
    const isAvailable = trafficFetchAvailable(record)
    if (!analysis || !isAvailable) continue
    const metrics = analysis.metrics || {}
    const title = String(record.title || record.description || record.awemeId).replaceAll('|', '\\|')
    const episodeId = record.episodeId ?? record.sourceMatch?.episodeId ?? '-'
    lines.push(`| ${title} | ${episodeId || '-'} | ${formatRate(metrics.bounce_rate_2s)} | ${formatRate(metrics.completion_rate_5s)} | ${formatNumber(metrics.comment_count)} | ${formatMetric('avg_view_second', metrics.avg_view_second)} | ${formatRate(metrics.avg_view_proportion)} |`)
  }
  if (unavailable.length) {
    lines.push('', '## 详情页流量分析不可用的作品', '', '| 作品 | awemeId | 原因 |', '| --- | --- | --- |')
    for (const record of unavailable) {
      const title = String(record.title || record.description || record.awemeId).replaceAll('|', '\\|')
      const reason = String(record.trafficAnalysisError || '本次未返回详情页数据').replaceAll('|', '\\|').replaceAll('\n', ' ')
      lines.push(`| ${title} | ${record.awemeId} | ${reason} |`)
    }
  }
  fs.writeFileSync(SUMMARY_PATH, `${lines.join('\n')}\n`, 'utf8')
  updateState(records, capturedAt)
  return { summary: path.relative(PROJECT_ROOT, SUMMARY_PATH), enriched: available.length, failed: unavailable.length }
}

function localRecords() {
  if (!fs.existsSync(VIDEOS_DIR)) return []
  return fs.readdirSync(VIDEOS_DIR)
    .map((name) => path.join(VIDEOS_DIR, name))
    .filter((folder) => fs.statSync(folder).isDirectory() && fs.existsSync(path.join(folder, 'data.json')))
    .map((folder) => {
      const data = JSON.parse(fs.readFileSync(path.join(folder, 'data.json'), 'utf8'))
      const sourceMatchPath = path.join(folder, 'source-match.json')
      const sourceMatch = fs.existsSync(sourceMatchPath)
        ? JSON.parse(fs.readFileSync(sourceMatchPath, 'utf8'))
        : null
      const linkedMatch = data.sourceMatch || sourceMatch
      return {
        folder,
        ...data,
        sourceMatch: linkedMatch,
        episodeId: data.episodeId ?? linkedMatch?.episodeId ?? null,
        episodeNumber: data.episodeNumber ?? linkedMatch?.episodeNumber ?? null,
        trafficAnalysisError: data.trafficAnalysisStatus?.error || data.trafficAnalysisError || null,
      }
    })
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  const page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  try {
    await page.goto(DATA_CENTER_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await sleep(6_000)
    const records = localRecords()
    const result = await enrichRecordsWithTraffic(page, records, {
      onProgress: (current, total, record) => console.log(`[douyin-traffic] ${current}/${total} ${record.awemeId}`),
    })
    const persisted = persistTrafficArtifacts(records)
    console.log(JSON.stringify({ ok: true, total: records.length, ...result, ...persisted }, null, 2))
  } finally {
    await page.close().catch(() => {})
    browser.disconnect()
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[douyin-traffic] ${error.stack || error.message || error}`)
    process.exitCode = 1
  })
}
