/**
 * Collect Douyin creator metrics through the existing CDP Chrome session.
 *
 * This deliberately reuses the browser started by publish-douyin:
 *   - CDP: 127.0.0.1:9224
 *   - profile: data/douyin-profile
 *   - authentication: the browser's existing session/cookies
 *
 * It only reads creator-center data. It does not publish, save drafts, or
 * mutate comments.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { CDP_URL, PROJECT_ROOT, sleep } from './lib.mjs'
import { linkHistoricalWorks } from './link-scripts.mjs'
import { analyzeHistoricalScriptPerformance } from './analyze-script-performance.mjs'
import { enrichRecordsWithTraffic, persistTrafficArtifacts, trafficAnalysisMarkdown } from './collect-traffic-analysis.mjs'

const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage'
const COMMENT_URL = 'https://creator.douyin.com/creator-micro/interactive/comment'
const WORK_LIST_URL = 'https://creator.douyin.com/janus/douyin/creator/pc/work_list'
const COMMENT_API_MARKER = '/web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/select/'
const VIDEOS_DIR = path.join(PROJECT_ROOT, 'videos')
const CACHE_DIR = path.join(PROJECT_ROOT, '.cheat-cache', 'douyin-cdp')
const STATE_PATH = path.join(PROJECT_ROOT, '.cheat-state.json')
const SUMMARY_PATH = path.join(VIDEOS_DIR, 'douyin-import-summary.md')

function parseArgs(argv) {
  const args = { limit: 100, comments: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--limit') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value < 1) throw new Error('--limit must be a positive integer')
      args.limit = value
      i += 1
    } else if (arg === '--no-comments') {
      args.comments = false
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node backend/scripts/douyin/collect-data.mjs [--limit N] [--no-comments]')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function nowIsoLocal() {
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

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function datePart(unixSeconds) {
  if (!unixSeconds) return 'unknown-date'
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(unixSeconds * 1000))
}

function slug(text) {
  return String(text || 'untitled')
    .replace(/[<>:"/\\|?*\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18) || 'untitled'
}

function folderName(work) {
  const shortId = crypto
    .createHash('sha256')
    .update(`${work.title || work.description}|${work.awemeId}`)
    .digest('hex')
    .slice(0, 12)
  return `${datePart(work.createTime)}_${shortId}_${slug(work.title || work.description)}`
}

function compactText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function formatNumber(value) {
  const number = numeric(value)
  if (number === null) return '-'
  if (number >= 10000) return `${(number / 10000).toFixed(1)}w`
  return String(Math.round(number))
}

function formatRate(value) {
  const number = numeric(value)
  if (number === null) return '-'
  const percent = Math.abs(number) <= 1 ? number * 100 : number
  return `${percent.toFixed(percent >= 10 ? 1 : 2)}%`
}

function formatDateTime(unixSeconds) {
  if (!unixSeconds) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(unixSeconds * 1000))
}

async function openBrowserPage(browser, url) {
  const page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  page.setDefaultNavigationTimeout(60_000)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  return page
}

async function fetchWorks(page, limit) {
  return page.evaluate(async ({ workListUrl, requestedLimit }) => {
    const normalizeDescription = (value) => String(value || '').replace(/\s+/g, ' ').trim()
    const records = []
    const seen = new Set()
    let cursor = 0
    let total = 0
    let hasMore = true
    let pageCount = 0

    while (hasMore && records.length < requestedLimit && pageCount < 20) {
      const url = new URL(workListUrl)
      url.searchParams.set('status', '0')
      url.searchParams.set('count', '12')
      url.searchParams.set('max_cursor', String(cursor))
      url.searchParams.set('scene', 'star_atlas')
      url.searchParams.set('device_platform', 'android')
      url.searchParams.set('aid', '1128')

      const response = await fetch(url.toString(), { credentials: 'include' })
      if (!response.ok) throw new Error(`作品列表请求失败: HTTP ${response.status}`)
      const payload = await response.json()
      const awemes = Array.isArray(payload.aweme_list) ? payload.aweme_list : []
      const analytics = Array.isArray(payload.items) ? payload.items : []
      total = Number(payload.total || total || 0)

      const analyticsByKey = new Map()
      for (const item of analytics) {
        const key = `${item.create_time || 0}|${normalizeDescription(item.description)}`
        if (!analyticsByKey.has(key)) analyticsByKey.set(key, item)
      }

      for (const [index, aweme] of awemes.entries()) {
        const awemeId = String(aweme.aweme_id || aweme.item_id || aweme.id || '')
        if (!awemeId || seen.has(awemeId)) continue
        seen.add(awemeId)

        const description = aweme.desc || aweme.caption || ''
        const key = `${aweme.create_time || 0}|${normalizeDescription(description)}`
        let analyticsItem = analyticsByKey.get(key)
        if (!analyticsItem) {
          analyticsItem = analytics.find((item) => {
            if (Number(item.create_time || 0) !== Number(aweme.create_time || 0)) return false
            const itemDescription = normalizeDescription(item.description)
            const awemeDescription = normalizeDescription(description)
            return itemDescription === awemeDescription
              || itemDescription.includes(normalizeDescription(aweme.item_title))
              || awemeDescription.includes(itemDescription)
          })
        }

        records.push({
          awemeId,
          title: aweme.item_title || String(description).split(/\s+/)[0] || awemeId,
          description,
          createTime: Number(aweme.create_time || 0),
          durationMs: Number(aweme.duration || aweme.video?.duration || 0),
          shareUrl: `https://www.douyin.com/video/${awemeId}`,
          status: aweme.status || null,
          statistics: aweme.statistics || {},
          metrics: analyticsItem?.metrics || null,
          analyticsMatched: Boolean(analyticsItem),
          listIndex: index,
        })
        if (records.length >= requestedLimit) break
      }

      const nextCursor = Number(payload.max_cursor || 0)
      hasMore = Boolean(payload.has_more) && nextCursor !== cursor && records.length < requestedLimit
      cursor = nextCursor
      pageCount += 1
    }

    return { total, pageCount, hasMore, records }
  }, { workListUrl: WORK_LIST_URL, requestedLimit: limit })
}

async function captureCommentTemplate(page) {
  let templateUrl = ''
  const listener = (response) => {
    if (response.url().includes(COMMENT_API_MARKER) && !templateUrl) templateUrl = response.url()
  }
  page.on('response', listener)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await sleep(7_000)
  page.off('response', listener)
  return templateUrl
}

async function fetchComments(page, templateUrl, awemeId) {
  if (!templateUrl) return []
  return page.evaluate(async ({ baseUrl, id }) => {
    const comments = []
    const seen = new Set()
    let cursor = 0
    let hasMore = true

    for (let pageIndex = 0; hasMore && pageIndex < 10; pageIndex += 1) {
      const url = new URL(baseUrl)
      url.searchParams.set('aweme_id', id)
      url.searchParams.set('cursor', String(cursor))
      url.searchParams.set('count', '50')
      const response = await fetch(url.toString(), { credentials: 'include' })
      if (!response.ok) break
      const payload = await response.json()
      const batch = Array.isArray(payload.comments) ? payload.comments : []
      for (const comment of batch) {
        const commentId = String(comment.cid || comment.comment_id || comment.id || '')
        if (!commentId || seen.has(commentId)) continue
        seen.add(commentId)
        comments.push({
          id: commentId,
          text: comment.text || comment.content || '',
          diggCount: Number(comment.digg_count || comment.like_count || 0),
          replyCount: Number(comment.reply_comment_total || comment.reply_count || 0),
          createTime: Number(comment.create_time || 0),
          userName: comment.user?.nickname || comment.user_info?.nickname || comment.user_name || '',
          ipLabel: comment.ip_label || comment.ip_location || '',
        })
      }
      hasMore = Boolean(payload.has_more)
      const nextCursor = Number(payload.cursor || 0)
      if (nextCursor === cursor) break
      cursor = nextCursor
    }

    return comments.sort((a, b) => b.diggCount - a.diggCount).slice(0, 50)
  }, { baseUrl: templateUrl, id: awemeId })
}

function metricValue(work, key, fallbackKey) {
  const metricsValue = work.metrics?.[key]
  if (metricsValue !== undefined && metricsValue !== null) return metricsValue
  return work.statistics?.[fallbackKey]
}

function reportFor(work, comments, capturedAt, folder) {
  const views = metricValue(work, 'view_count', 'play_count')
  const likes = metricValue(work, 'like_count', 'digg_count')
  const commentCount = metricValue(work, 'comment_count', 'comment_count')
  const shares = metricValue(work, 'share_count', 'share_count')
  const favorites = metricValue(work, 'favorite_count', 'collect_count')
  const rateRows = [
    ['平均观看时长', work.metrics?.avg_view_second == null ? '-' : `${Number(work.metrics.avg_view_second).toFixed(1)} 秒`],
    ['平均观看比例', formatRate(work.metrics?.avg_view_proportion)],
    ['2 秒跳出率', formatRate(work.metrics?.bounce_rate_2s)],
    ['5 秒完播率', formatRate(work.metrics?.completion_rate_5s)],
    ['完播率', formatRate(work.metrics?.completion_rate)],
    ['封面点击率', formatRate(work.metrics?.cover_click_rate)],
    ['点赞率', formatRate(work.metrics?.like_rate)],
    ['评论率', formatRate(work.metrics?.comment_rate)],
    ['分享率', formatRate(work.metrics?.share_rate)],
    ['收藏率', formatRate(work.metrics?.favorite_rate)],
  ]

  const lines = [
    `# ${work.title || '(无标题)'}`,
    '',
    `- 数据来源：\`adapter:douyin-cdp\`（复用 publish-douyin 的 CDP ${CDP_URL}）`,
    `- 抓取时间：${capturedAt}`,
    `- 视频 ID：\`${work.awemeId}\``,
    `- 链接：${work.shareUrl}`,
    `- 发布时间：${formatDateTime(work.createTime)}`,
    `- 时长：${work.durationMs ? `${(work.durationMs / 1000).toFixed(1)} 秒` : '-'}`,
    `- 原稿状态：${fs.existsSync(path.join(folder, 'script.md')) ? '已存在 script.md' : '未导入（script_lost）'}`,
    '',
    '## 作品数据',
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 播放 | ${formatNumber(views)} |`,
    `| 点赞 | ${formatNumber(likes)} |`,
    `| 评论 | ${formatNumber(commentCount)} |`,
    `| 分享 | ${formatNumber(shares)} |`,
    `| 收藏 | ${formatNumber(favorites)} |`,
    '',
    '## 观看与互动率',
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    ...rateRows.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    `## 评论（按点赞排序，共 ${comments.length} 条）`,
    '',
  ]

  if (!comments.length) {
    lines.push('（没有抓到评论，或该作品当前评论数为 0。）')
  } else {
    for (const comment of comments) {
      const text = compactText(comment.text).replaceAll('|', '\\|')
      const author = comment.userName ? `（${comment.userName}）` : ''
      const replies = comment.replyCount ? `，回复 ${comment.replyCount}` : ''
      lines.push(`- 👍${comment.diggCount}${replies} ${author}：${text}`)
    }
  }

  lines.push('', '## 使用说明', '', '- 这是历史数据导入，不等同于盲预测复盘。', '- 如保留了原稿，请将原稿放到本目录的 `script.md`，再进行历史重建评分。', '')
  const trafficSection = trafficAnalysisMarkdown(work.trafficAnalysis)
  if (trafficSection) lines.push('', trafficSection, '')
  return `${lines.join('\n')}\n`
}

function writeReports(records, capturedAt) {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true })
  return records.map((record) => {
    const folder = path.join(VIDEOS_DIR, folderName(record))
    fs.mkdirSync(folder, { recursive: true })
    const comments = record.comments || []
    fs.writeFileSync(path.join(folder, 'report.md'), reportFor(record, comments, capturedAt, folder), 'utf8')
    fs.writeFileSync(path.join(folder, 'data.json'), `${JSON.stringify({ ...record, comments }, null, 2)}\n`, 'utf8')
    return { ...record, folder: path.relative(PROJECT_ROOT, folder) }
  })
}

function writeSummary(records, capturedAt, total, baselinePlays) {
  const lines = [
    '# 抖音历史数据导入摘要',
    '',
    `- 数据来源：publish-douyin CDP（${CDP_URL}）`,
    `- 抓取时间：${capturedAt}`,
    `- 创作者中心作品总数：${total || records.length}`,
    `- 本次导入：${records.length} 条`,
    `- 正播放中位数（排除无数据作品）：${baselinePlays == null ? '-' : formatNumber(baselinePlays)}`,
    '',
    '| 发布时间 | 标题 | 播放 | 评论 | 抓取目录 |',
    '| --- | --- | ---: | ---: | --- |',
  ]
  for (const record of records) {
    const views = metricValue(record, 'view_count', 'play_count')
    const comments = metricValue(record, 'comment_count', 'comment_count')
    const title = compactText(record.title || record.description).replaceAll('|', '\\|')
    lines.push(`| ${datePart(record.createTime)} | ${title} | ${formatNumber(views)} | ${formatNumber(comments)} | ${record.folder} |`)
  }
  fs.writeFileSync(SUMMARY_PATH, `${lines.join('\n')}\n`, 'utf8')
}

function updateState(records, baselinePlays, capturedAt) {
  if (!fs.existsSync(STATE_PATH)) return
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  state.adapter_setup_status = 'ready'
  state.douyin_collector = 'backend/scripts/douyin/collect-data.mjs'
  state.douyin_imported_count = records.length
  state.last_douyin_import_at = capturedAt
  state.baseline_plays = baselinePlays
  state.historical_samples_estimate = records.length
  state.historical_data_imported = true
  if (state.calibration_samples_source !== 'formal-retro') state.calibration_samples = 0
  state.calibration_samples_source = 'formal-retro'
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const capturedAt = nowIsoLocal()
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  let managePage
  let commentPage
  try {
    managePage = await openBrowserPage(browser, MANAGE_URL)
    const result = await fetchWorks(managePage, args.limit)
    if (!result.records.length) throw new Error('未抓到作品。请确认 CDP Chrome 已登录抖音创作者中心。')

    console.log(`[douyin-cdp] found ${result.records.length}/${result.total || result.records.length} works`)
    let templateUrl = ''
    if (args.comments) {
      commentPage = await openBrowserPage(browser, COMMENT_URL)
      templateUrl = await captureCommentTemplate(commentPage)
      if (!templateUrl) console.warn('[douyin-cdp] comment API template not found; continuing without comments')
    }

    for (const [index, record] of result.records.entries()) {
      const commentCount = numeric(metricValue(record, 'comment_count', 'comment_count')) || 0
      record.comments = []
      if (args.comments && templateUrl && commentCount > 0) {
        try {
          record.comments = await fetchComments(commentPage, templateUrl, record.awemeId)
        } catch (error) {
          console.warn(`[douyin-cdp] comments failed for ${record.awemeId}: ${error.message}`)
        }
      }
      console.log(`[douyin-cdp] ${index + 1}/${result.records.length} ${record.awemeId} comments=${record.comments.length}`)
      await sleep(150)
    }

    const trafficAnalysis = await enrichRecordsWithTraffic(managePage, result.records, {
      onProgress: (current, total, record) => console.log(`[douyin-traffic] ${current}/${total} ${record.awemeId}`),
    })

    const views = result.records
      .map((record) => numeric(metricValue(record, 'view_count', 'play_count')))
      .filter((value) => value !== null && value > 0)
    const baselinePlays = median(views)
    const written = writeReports(result.records, capturedAt)
    fs.writeFileSync(path.join(CACHE_DIR, 'works.json'), `${JSON.stringify({ capturedAt, total: result.total, records: written }, null, 2)}\n`, 'utf8')
    writeSummary(written, capturedAt, result.total, baselinePlays)
    const scriptLinking = linkHistoricalWorks()
    const trafficArtifacts = persistTrafficArtifacts(written, capturedAt)
    updateState(written, baselinePlays, capturedAt)
    const scriptAnalysis = analyzeHistoricalScriptPerformance()
    console.log(JSON.stringify({ ok: true, total: result.total, imported: written.length, baselinePlays, summary: path.relative(PROJECT_ROOT, SUMMARY_PATH), trafficAnalysis: { enriched: trafficAnalysis.enriched, failed: trafficAnalysis.failed, summary: trafficArtifacts.summary }, scriptLinking: { matched: scriptLinking.matched, needsReview: scriptLinking.needsReview, unmatched: scriptLinking.unmatched }, scriptAnalysis: { samples: scriptAnalysis.sampleCount, report: scriptAnalysis.report } }, null, 2))
  } finally {
    if (commentPage) await commentPage.close().catch(() => {})
    if (managePage) await managePage.close().catch(() => {})
    browser.disconnect()
  }
}

main().catch((error) => {
  console.error(`[douyin-cdp] ${error.stack || error.message || error}`)
  process.exitCode = 1
})
