#!/usr/bin/env node
/**
 * Build a directional diagnostic from matched narration scripts and Douyin
 * metrics. Historical imports are observational data, not formal blind
 * calibration samples, so this script only writes a report and never edits
 * rubric_notes.md or script_patterns.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { PROJECT_ROOT } from './lib.mjs'

const VIDEOS_DIR = path.join(PROJECT_ROOT, 'videos')
const STATE_PATH = path.join(PROJECT_ROOT, '.cheat-state.json')
const REPORT_PATH = path.join(VIDEOS_DIR, 'douyin-script-performance-analysis.md')
const JSON_PATH = path.join(VIDEOS_DIR, 'douyin-script-performance-analysis.json')
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'data/huobao_drama.db')

const TRAFFIC_METRIC_CONFIG = [
  { key: 'bounce_rate_2s', field: 'bounceRate2s', label: '2 秒跳出率', kind: 'rate', direction: 'lower' },
  { key: 'completion_rate_5s', field: 'completionRate5s', label: '5 秒完播率', kind: 'rate', direction: 'higher' },
  { key: 'avg_view_second', field: 'averageViewSeconds', label: '平均播放时长', kind: 'seconds', direction: 'higher' },
  { key: 'avg_view_proportion', field: 'averageViewProportion', label: '平均播放占比', kind: 'rate', direction: 'higher' },
  { key: 'completion_rate', field: 'completionRate', label: '完播率', kind: 'rate', direction: 'higher' },
  { key: 'comment_rate', field: 'commentRate', label: '评论率', kind: 'rate', direction: 'higher' },
  { key: 'like_rate', field: 'likeRate', label: '点赞率', kind: 'rate', direction: 'higher' },
  { key: 'share_rate', field: 'shareRate', label: '分享率', kind: 'rate', direction: 'higher' },
]

const TRAFFIC_ANALYSIS_SOURCE = 'douyin:traffic-analysis:item_compare'

function numeric(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function percent(value) {
  const number = numeric(value)
  if (number === null) return null
  return Math.abs(number) <= 1 ? number * 100 : number
}

function normalize(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '')
}

function countMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length
}

function firstNumber(value) {
  const match = String(value || '').match(/[0-9０-９一二三四五六七八九十百千万亿]+/u)
  return Boolean(match)
}

function sentenceStats(script) {
  const sentences = String(script || '')
    .split(/[。！？!?；;]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  const lengths = sentences.map((sentence) => normalize(sentence).length)
  return {
    sentenceCount: sentences.length,
    averageSentenceChars: lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0,
    shortSentenceRatio: lengths.length ? lengths.filter((value) => value <= 25).length / lengths.length : 0,
  }
}

function extractFeatures(work, episode, script) {
  const text = String(script || '').trim()
  const opening = text.slice(0, 140)
  const sentences = sentenceStats(text)
  const paragraphs = text.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean).length
  const contrastPattern = /但是|然而|可是|却|反而|没想到|真正|不是.{0,16}而是/gu
  const questionPattern = /为什么|为何|怎么|如何|难道|？|\?/gu
  const revealPattern = /答案|真相|关键|原来|背后|真正原因|秘密/gu
  const cliffhangerPattern = /下一集|下期|接下来|敬请期待|会怎样|能成功吗/gu
  const trafficAvailable = isTrafficAvailable(work)
  const metrics = trafficAvailable ? work.trafficAnalysis.metrics : (work.metrics || {})
  const statistics = work.statistics || {}
  const metric = (key, fallback) => numeric(metrics[key] ?? statistics[fallback])
  const views = metric('view_count', 'play_count')
  const createdAt = numeric(work.createTime)
  const ageDays = createdAt ? Math.max(0, (Date.now() - createdAt * 1000) / 86_400_000) : null

  return {
    awemeId: work.awemeId,
    title: work.title || work.description || work.awemeId,
    episodeId: work.sourceMatch?.episodeId || null,
    episodeTitle: episode?.title || null,
    createdAt: work.createTime || null,
    ageDays,
    trafficAvailable,
    trafficSource: trafficAvailable ? TRAFFIC_ANALYSIS_SOURCE : 'douyin:work-list',
    trafficComparison: trafficAvailable ? (work.trafficAnalysis.comparison || {}) : {},
    views,
    likes: metric('like_count', 'digg_count'),
    comments: metric('comment_count', 'comment_count'),
    shares: metric('share_count', 'share_count'),
    favorites: metric('favorite_count', 'collect_count'),
    averageViewSeconds: numeric(metrics.avg_view_second),
    averageViewProportion: numeric(metrics.avg_view_proportion),
    bounceRate2s: numeric(metrics.bounce_rate_2s),
    completionRate5s: numeric(metrics.completion_rate_5s),
    completionRate: numeric(metrics.completion_rate),
    likeRate: numeric(metrics.like_rate),
    commentRate: numeric(metrics.comment_rate),
    shareRate: numeric(metrics.share_rate),
    favoriteRate: numeric(metrics.favorite_rate),
    scriptChars: normalize(text).length,
    openingChars: normalize(opening).length,
    sentenceCount: sentences.sentenceCount,
    averageSentenceChars: sentences.averageSentenceChars,
    shortSentenceRatio: sentences.shortSentenceRatio,
    paragraphCount: paragraphs,
    questionCount: countMatches(text, questionPattern),
    contrastCount: countMatches(text, contrastPattern),
    revealCount: countMatches(text, revealPattern),
    hasOpeningQuestion: questionPattern.test(opening),
    hasOpeningContrast: /但是|然而|可是|却|反而|没想到|真正|不是.{0,16}而是/u.test(opening),
    hasOpeningNumber: firstNumber(opening),
    hasCliffhanger: cliffhangerPattern.test(text),
  }
}

function loadRows(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const episodes = new Map(db.prepare('SELECT * FROM episodes').all().map((episode) => [episode.id, episode]))
    const folders = fs.readdirSync(VIDEOS_DIR)
      .filter((name) => name !== 'douyin-import-summary.md'
        && name !== 'douyin-script-link-summary.md'
        && name !== 'douyin-script-performance-analysis.md'
        && name !== 'douyin-script-performance-analysis.json')
      .map((name) => path.join(VIDEOS_DIR, name))
      .filter((folder) => fs.statSync(folder).isDirectory())
    const rows = []
    for (const folder of folders) {
      const dataPath = path.join(folder, 'data.json')
      const matchPath = path.join(folder, 'source-match.json')
      if (!fs.existsSync(dataPath) || !fs.existsSync(matchPath)) continue
      const work = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
      const match = JSON.parse(fs.readFileSync(matchPath, 'utf8'))
      if (match.status !== 'matched' || !match.episodeId) continue
      const episode = episodes.get(Number(match.episodeId))
      if (!episode) continue
      const script = String(episode.script_content || episode.content || '').trim()
      if (script.length < 100) continue
      rows.push(extractFeatures({ ...work, sourceMatch: match }, episode, script))
    }
    return rows
  } finally {
    db.close()
  }
}

function topBottom(rows) {
  const usable = rows.filter((row) => numeric(row.views) !== null && row.views > 0).sort((a, b) => b.views - a.views)
  const size = Math.max(5, Math.ceil(usable.length * 0.25))
  return { usable, top: usable.slice(0, size), bottom: usable.slice(-size) }
}

function featureMedian(rows, key) {
  return median(rows.map((row) => numeric(row[key])))
}

function featureRate(rows, key) {
  const values = rows.map((row) => row[key] ? 1 : 0)
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function buildSignals(top, bottom) {
  const numericKeys = [
    'scriptChars',
    'openingChars',
    'sentenceCount',
    'averageSentenceChars',
    'shortSentenceRatio',
    'questionCount',
    'contrastCount',
    'revealCount',
    'paragraphCount',
    'averageViewProportion',
    'completionRate5s',
    'completionRate',
    'bounceRate2s',
  ]
  const booleanKeys = ['hasOpeningQuestion', 'hasOpeningContrast', 'hasOpeningNumber', 'hasCliffhanger']
  const numericSignals = numericKeys.map((key) => {
    const topValue = featureMedian(top, key)
    const bottomValue = featureMedian(bottom, key)
    return {
      feature: key,
      topMedian: topValue,
      bottomMedian: bottomValue,
      delta: topValue === null || bottomValue === null ? null : topValue - bottomValue,
    }
  })
  const booleanSignals = booleanKeys.map((key) => {
    const topRate = featureRate(top, key)
    const bottomRate = featureRate(bottom, key)
    return {
      feature: key,
      topRate,
      bottomRate,
      delta: topRate - bottomRate,
    }
  })
  return { numeric: numericSignals, boolean: booleanSignals }
}

function trafficComparison(row, config) {
  return row.trafficComparison?.[config.key] || {}
}

function trafficIsWeak(row, config) {
  const change = numeric(trafficComparison(row, config).changeRatio)
  if (change === null) return false
  return config.direction === 'lower' ? change > 0.05 : change < -0.05
}

function trafficIssues(row) {
  return TRAFFIC_METRIC_CONFIG
    .filter((config) => trafficIsWeak(row, config))
    .map((config) => ({
      config,
      comparison: trafficComparison(row, config),
      change: numeric(trafficComparison(row, config).changeRatio),
    }))
    .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
}

function trafficStatus(row) {
  const issues = trafficIssues(row)
  if (issues.length) return issues.slice(0, 3).map(({ config, change }) => `${config.label}${formatRelativeChange(change)}`).join('；')
  return '相对对比无明显短板'
}

function trafficAnalysisReport(rows) {
  const detailRows = rows.filter((row) => row.trafficAvailable)
  const lines = [
    '## 流量分析重点（详情页）',
    '',
    `- 详情页“流量分析”可用：${detailRows.length} / ${rows.length} 条。`,
    `- 本节只使用详情页 \`item_compare\` 返回的当前值、对比值和官方建议；其余 ${rows.length - detailRows.length} 条不混入本节。`,
    '- 2 秒跳出率越低越好；5 秒完播率、平均播放时长、平均播放占比和互动率越高越好。',
    '- 样本来自不同发布时间、题材和分发阶段，以下用于定位脚本/镜头问题，不直接证明因果，也不自动写入正式 rubric。',
    '',
  ]
  if (!detailRows.length) {
    lines.push('当前没有可用的详情页流量分析数据。')
    return lines.join('\n')
  }

  lines.push(
    '| 指标 | 详情样本 | 当前中位数 | 对比中位数 | 优于对比 | 方向 |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  )
  for (const config of TRAFFIC_METRIC_CONFIG) {
    const currentValues = detailRows.map((row) => numeric(row[config.field]))
    const compareValues = detailRows.map((row) => numeric(trafficComparison(row, config).compareValue))
    const betterCount = detailRows.filter((row) => {
      const change = numeric(trafficComparison(row, config).changeRatio)
      if (change === null || Math.abs(change) <= 0.01) return false
      return config.direction === 'lower' ? change < 0 : change > 0
    }).length
    lines.push(`| ${config.label} | ${currentValues.filter((value) => value !== null).length} | ${formatTrafficValue(config, median(currentValues))} | ${formatTrafficValue(config, median(compareValues))} | ${betterCount}/${detailRows.length} | ${config.direction === 'lower' ? '越低越好' : '越高越好'} |`)
  }
  const commentValues = detailRows.map((row) => numeric(row.comments)).filter((value) => value !== null)
  lines.push('', `- 评论量：详情样本合计 ${formatMetric(commentValues.reduce((sum, value) => sum + value, 0), 0)} 条；中位数 ${formatMetric(median(commentValues), 0)} 条；有评论作品 ${commentValues.filter((value) => value > 0).length}/${detailRows.length} 条。`)

  lines.push(
    '',
    '### 详情页指标与口播稿对应',
    '',
    '| 作品 | episode | 播放（总览） | 口播字数 | 开头特征 | 2 秒跳出 | 5 秒完播 | 平均时长 | 平均占比 | 评论 | 详情页相对表现 |',
    '| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  )
  for (const row of [...detailRows].sort((left, right) => (right.views || 0) - (left.views || 0))) {
    const title = String(row.title || '').replaceAll('|', '\\|')
    const openingFeatures = [
      row.hasOpeningQuestion ? '问句' : '',
      row.hasOpeningContrast ? '转折' : '',
      row.hasOpeningNumber ? '数字' : '',
    ].filter(Boolean).join('、') || '-'
    lines.push(`| ${title} | ${row.episodeId || '-'} | ${formatMetric(row.views, 0)} | ${row.scriptChars} | ${openingFeatures} | ${formatTrafficValue(TRAFFIC_METRIC_CONFIG[0], row.bounceRate2s)} | ${formatTrafficValue(TRAFFIC_METRIC_CONFIG[1], row.completionRate5s)} | ${formatTrafficValue(TRAFFIC_METRIC_CONFIG[2], row.averageViewSeconds)} | ${formatTrafficValue(TRAFFIC_METRIC_CONFIG[3], row.averageViewProportion)} | ${formatMetric(row.comments, 0)} | ${trafficStatus(row)} |`)
  }

  const adviceRows = detailRows
    .map((row) => {
      const issue = trafficIssues(row)[0]
      if (!issue) return null
      return { row, issue }
    })
    .filter(Boolean)
  lines.push('', '### 抖音官方诊断建议（详情页相对较弱指标）', '')
  if (!adviceRows.length) {
    lines.push('当前详情样本没有超过 5% 相对差异阈值的明显短板。')
  } else {
    lines.push('| 作品 | episode | 主要短板 | 相对对比 | 抖音建议 |', '| --- | ---: | --- | ---: | --- |')
    for (const { row, issue } of adviceRows) {
      const title = String(row.title || '').replaceAll('|', '\\|')
      const suggestion = String(issue.comparison.suggestion || '详情页未提供具体建议').replaceAll('|', '\\|').replaceAll('\n', ' ')
      lines.push(`| ${title} | ${row.episodeId || '-'} | ${issue.config.label} | ${formatRelativeChange(issue.change)} | ${suggestion} |`)
    }
  }
  return lines.join('\n')
}

function formatMetric(value, digits = 1) {
  if (!Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

function formatTrafficValue(config, value) {
  const number = numeric(value)
  if (number === null) return '-'
  if (config.kind === 'rate') {
    const percentage = percent(number)
    return `${formatMetric(percentage, Math.abs(percentage) >= 10 ? 1 : 2)}%`
  }
  if (config.kind === 'seconds') return `${formatMetric(number, 1)} 秒`
  return formatMetric(number, 1)
}

function formatRelativeChange(value) {
  const number = numeric(value)
  if (number === null) return '-'
  const percentage = percent(number)
  const sign = percentage > 0 ? '+' : ''
  return `${sign}${formatMetric(percentage, Math.abs(percentage) >= 10 ? 1 : 2)}%`
}

function isTrafficAvailable(work) {
  return work.trafficAnalysis?.source === TRAFFIC_ANALYSIS_SOURCE
    && work.trafficAnalysis?.metrics
    && typeof work.trafficAnalysis.metrics === 'object'
}

function markdownReport(rows, groups, signals, capturedAt) {
  const lines = [
    '# 抖音作品与口播文稿历史诊断',
    '',
    `- 生成时间：${capturedAt}`,
    '- 数据范围：已匹配到本地 episode 的历史导入作品',
    '- 用途：写作诊断和候选 pattern 发现，不是正式盲校准样本',
    '- 重要限制：不同作品的发布时间、题材、封面和账号分发状态不同，以下是相关性信号，不是因果结论',
    '',
    '## 样本概览',
    '',
    `- 匹配脚本：${rows.length} 条`,
    `- 有正播放数据：${groups.usable.length} 条`,
    `- 播放中位数：${formatMetric(median(groups.usable.map((row) => row.views)), 0)}`,
    `- 高播放组：前 ${groups.top.length} 条；低播放组：后 ${groups.bottom.length} 条`,
  ]
  lines.push('', ...trafficAnalysisReport(rows).split('\n'), '', '## 播放量分组对照（总览，仅用于排序）', '', '- 播放量只用于形成高/低组；没有详情页流量分析的作品不会被当作详情样本。', '', '| 特征 | 高播放组中位数/比例 | 低播放组中位数/比例 | 差值 |', '| --- | ---: | ---: | ---: |')
  for (const signal of signals.numeric) {
    lines.push(`| ${signal.feature} | ${formatMetric(signal.topMedian, 3)} | ${formatMetric(signal.bottomMedian, 3)} | ${formatMetric(signal.delta, 3)} |`)
  }
  for (const signal of signals.boolean) {
    lines.push(`| ${signal.feature} | ${formatMetric(signal.topRate * 100, 1)}% | ${formatMetric(signal.bottomRate * 100, 1)}% | ${formatMetric(signal.delta * 100, 1)} 个百分点 |`)
  }
  lines.push('', '## 作品明细（总览排序）', '', '| 播放排名 | 标题 | episode | 播放 | 平均观看比例 | 5 秒完播 | 流量数据源 | 开头问题 | 开头反转 | 开头数字 | 口播字数 |', '| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: |')
  const ranked = [...groups.usable]
  for (let index = 0; index < ranked.length; index += 1) {
    const row = ranked[index]
    const title = String(row.title || '').replaceAll('|', '\\|')
    lines.push(`| ${index + 1} | ${title} | ${row.episodeId || '-'} | ${formatMetric(row.views, 0)} | ${formatMetric(percent(row.averageViewProportion), 1)}% | ${formatMetric(percent(row.completionRate5s), 1)}% | ${row.trafficAvailable ? '详情页' : '作品列表'} | ${row.hasOpeningQuestion ? '是' : '否'} | ${row.hasOpeningContrast ? '是' : '否'} | ${row.hasOpeningNumber ? '是' : '否'} | ${row.scriptChars} |`)
  }
  lines.push('', '## 下一步使用', '', '1. 先看高播放组和低播放组的实际 `script.md`，确认统计信号是否符合内容直觉。', '2. 只把能在至少 2 条相似题材作品中重复出现的现象，提议加入 `script_patterns.md`。', '3. 新稿发布前继续走 `cheat-predict`，发布后 T+3 天走 `cheat-retro`；正式 `calibration_samples` 仍只从这个闭环增加。', '')
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

function updateState(capturedAt, rows) {
  if (!fs.existsSync(STATE_PATH)) return
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  state.douyin_script_analysis = 'videos/douyin-script-performance-analysis.md'
  state.douyin_script_analysis_samples = rows.length
  state.last_douyin_script_analysis_at = capturedAt
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function analyzeHistoricalScriptPerformance({ dbPath = process.env.DB_PATH || DEFAULT_DB_PATH, dryRun = false } = {}) {
  const rows = loadRows(dbPath)
  const groups = topBottom(rows)
  const signals = buildSignals(groups.top, groups.bottom)
  const capturedAt = localIso()
  const payload = {
    generatedAt: capturedAt,
    sampleCount: rows.length,
    positiveViewCount: groups.usable.length,
    medianViews: median(groups.usable.map((row) => row.views)),
    trafficAnalysisSampleCount: rows.filter((row) => row.trafficAvailable).length,
    topCount: groups.top.length,
    bottomCount: groups.bottom.length,
    signals,
    rows,
  }
  if (!dryRun) {
    fs.writeFileSync(JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.writeFileSync(REPORT_PATH, markdownReport(rows, groups, signals, capturedAt), 'utf8')
    updateState(capturedAt, rows)
  }
  return { ...payload, report: path.relative(PROJECT_ROOT, REPORT_PATH) }
}

function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const result = analyzeHistoricalScriptPerformance({ dryRun })
  console.log(JSON.stringify({
    ok: true,
    samples: result.sampleCount,
    positiveViews: result.positiveViewCount,
    trafficAnalysisSamples: result.trafficAnalysisSampleCount,
    medianViews: result.medianViews,
    dryRun,
    report: result.report,
  }, null, 2))
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    console.error(`[douyin-analysis] ${error.stack || error.message || error}`)
    process.exitCode = 1
  }
}
