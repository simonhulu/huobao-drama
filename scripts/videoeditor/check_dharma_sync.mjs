#!/usr/bin/env node
/**
 * DharmaEpisode 渲染 props 的旁白/画面/字幕同步独立校验器。
 *
 * 契约（佛学管线 Authoritative Timing Contract）：每个分镜的绝对起止必须从
 * preTtsTitlesJson 主时间轴顺序定位（与 buildDharmaProps 同一份契约，但本脚本
 * 独立重推导，不复用后端代码）。校验：
 *   1. 所有分镜旁白都能在主时间轴上定位，窗口连续且单调不减；
 *   2. props.segments 的并集恰好覆盖这些窗口（段落合并只允许相邻同素材视频）；
 *   3. 首个段落起始于 0 帧，durationInFrames 等于最后段落终点（±1 帧取整容差）；
 *   4. 主音轨与 BGM 已挂载；字幕窗口落在渲染时长内。
 * 任何按字数比例估算/累计堆叠出来的 props 都会在这里失败。
 *
 * 用法：
 *   node scripts/videoeditor/check_dharma_sync.mjs <episodeId> [propsPath] [--fps=30] [--allow-partial]
 * 默认 propsPath = data/static/temp/dharma-props-<episodeId>.json；
 * --allow-partial 会优先读取最近生成的 partial props（review pilot 或风险 canary）。
 * 退出码：0 = 全部命中；1 = 有违规或数据缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const require = createRequire(path.join(repoRoot, 'backend/package.json'))
const Database = require('better-sqlite3')

const args = process.argv.slice(2)
const episodeId = Number(args[0])
if (!Number.isFinite(episodeId) || episodeId <= 0) {
  console.error('usage: check_dharma_sync.mjs <episodeId> [propsPath] [--fps=30] [--allow-partial]')
  process.exit(1)
}
const fpsArg = args.find((a) => a.startsWith('--fps='))
const fps = fpsArg ? Number(fpsArg.slice(6)) : 30
const allowPartial = args.includes('--allow-partial')
const explicitPropsPath = args[1] && !args[1].startsWith('--') ? path.resolve(args[1]) : null
const defaultPropsPath = path.join(repoRoot, 'data/static/temp', `dharma-props-${episodeId}.json`)
const tempPropsDir = path.dirname(defaultPropsPath)
const partialPropsPath = (() => {
  if (!allowPartial) return null
  try {
    return fs.readdirSync(tempPropsDir)
      .filter((file) => new RegExp(`^dharma-props-${episodeId}-pilot-\\d+s\\.json$`).test(file))
      .map((file) => ({ file, mtimeMs: fs.statSync(path.join(tempPropsDir, file)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? null
  } catch {
    return null
  }
})()
const propsPath = explicitPropsPath
  ?? (partialPropsPath ? path.join(tempPropsDir, partialPropsPath) : defaultPropsPath)

const normLen = (s) => (s || '').replace(/\s+/g, '')
const violations = []
const fail = (msg) => violations.push(msg)

const db = new Database(path.join(repoRoot, 'data/huobao_drama.db'), { readonly: true })

// 1) 主时间轴
const ep = db
  .prepare(`SELECT id, pre_tts_audio_url AS preTtsAudioUrl, pre_tts_titles_json AS preTtsTitlesJson, bgm_audio_url AS bgmAudioUrl
            FROM episodes WHERE id = ?`)
  .get(episodeId)
if (!ep) {
  console.error(`FAIL: episode ${episodeId} 不存在`)
  process.exit(1)
}
if (!ep.preTtsAudioUrl || !ep.preTtsTitlesJson) {
  console.error(`FAIL: episode ${episodeId} 缺少 preTtsAudioUrl/preTtsTitlesJson`)
  process.exit(1)
}
let titles = []
try {
  titles = JSON.parse(ep.preTtsTitlesJson)
} catch {
  console.error('FAIL: preTtsTitlesJson 解析失败')
  process.exit(1)
}
let stream = ''
const spans = []
for (const t of titles) {
  const text = normLen(t?.text)
  const beginSec = Number(t?.time_begin ?? 0) / 1000
  const endSec = Number(t?.time_end ?? 0) / 1000
  if (!text || !(endSec > beginSec)) continue
  spans.push({ charStart: stream.length, charEnd: stream.length + text.length, beginSec, endSec })
  stream += text
}
const masterTimeAt = (pos) => {
  if (pos <= 0) return spans[0].beginSec
  for (const span of spans) {
    if (pos < span.charEnd) {
      const ratio = (pos - span.charStart) / (span.charEnd - span.charStart)
      return span.beginSec + ratio * (span.endSec - span.beginSec)
    }
  }
  return spans[spans.length - 1].endSec
}
const locate = (narration, cursor) => {
  if (!narration) return null
  const probe12 = narration.slice(0, Math.min(12, narration.length))
  const probe8 = narration.slice(0, Math.min(8, narration.length))
  let idx = stream.indexOf(probe12, cursor)
  if (idx < 0) idx = stream.indexOf(probe8, cursor)
  if (idx < 0) idx = stream.indexOf(probe8)
  if (idx < 0) return null
  return { start: idx, end: idx + narration.length, cursor: idx + narration.length }
}

// 2) 期望的分镜窗口（独立重推导）
const storyboards = db
  .prepare(`SELECT id, storyboard_number AS num, narration, description, grid_cells AS gridCells
            FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number`)
  .all(episodeId)
if (!storyboards.length) {
  console.error(`FAIL: episode ${episodeId} 没有分镜`)
  process.exit(1)
}
let cursor = 0
const expected = []
for (const sb of storyboards) {
  const narration = normLen(sb.narration || sb.description)
  const located = locate(narration, cursor)
  if (!located) {
    fail(`分镜 #${sb.num} 旁白无法在主时间轴定位「${narration.slice(0, 24)}…」`)
    continue
  }
  cursor = located.cursor
  expected.push({
    num: sb.num,
    startMs: Math.round(masterTimeAt(located.start) * 1000),
    endMs: Math.round(masterTimeAt(located.end) * 1000),
  })
}
for (let i = 1; i < expected.length; i++) {
  if (expected[i].startMs < expected[i - 1].endMs - 500) {
    fail(`分镜窗口重叠/乱序（#${expected[i - 1].num} 结束 ${expected[i - 1].endMs}ms，#${expected[i].num} 起始 ${expected[i].startMs}ms）`)
  }
}

// 3) props 校验
if (!fs.existsSync(propsPath)) {
  console.error(`FAIL: props 不存在：${propsPath}`)
  process.exit(1)
}
const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'))
if (!props.audio) fail('props 未挂载主音轨 audio')
if (!props.bgm?.src) fail('props 未挂载 BGM（佛学管线要求单轨 BGM 内混）')
if (!Array.isArray(props.segments) || !props.segments.length) fail('props.segments 为空')

if (violations.length === 0 && expected.length) {
  const firstStartMs = expected[0].startMs
  // A canary starts at a server-selected later storyboard. Its audioStartFrame
  // is the authoritative rebased origin; assuming episode frame zero makes a
  // healthy partial render appear to truncate narration.
  const renderStartMs = Number.isInteger(props.audioStartFrame) && props.audioStartFrame >= 0
    ? props.audioStartFrame * (1000 / fps)
    : firstStartMs
  const renderEndMs = renderStartMs + props.durationInFrames * (1000 / fps)
  const finalCompleteTitleEndMs = allowPartial
    ? Math.max(
        renderStartMs,
        ...spans
          .map((span) => span.endSec * 1000)
          .filter((endMs) => endMs >= renderStartMs - 1 && endMs <= renderEndMs + 1),
      )
    : renderEndMs
  const inScope = allowPartial
    ? expected
        .filter((t) => t.startMs >= renderStartMs - 100 && t.startMs < finalCompleteTitleEndMs - 1)
        .map((t) => ({ ...t, endMs: Math.min(t.endMs, finalCompleteTitleEndMs) }))
    : expected
  if (!inScope.length) fail('partial props 没有覆盖任何完整旁白窗口')
  // 段落并集必须覆盖所有期望窗口（允许相邻同素材合并，所以按窗口逐一对齐段落区间）
  const segWindows = props.segments.map((s) => ({
    startMs: renderStartMs + (s.startFrame / fps) * 1000,
    endMs: renderStartMs + ((s.startFrame + s.durationInFrames) / fps) * 1000,
  }))
  for (const t of inScope) {
    const covered = segWindows.some((w) => t.startMs >= w.startMs - 100 && t.endMs <= w.endMs + 100)
    if (!covered) fail(`分镜 #${t.num} 的窗口（${t.startMs}→${t.endMs}ms）未被任何段落覆盖`)
  }
  const firstSeg = props.segments[0]
  if (Math.abs(firstSeg.startFrame) > 1) fail(`首个段落未起始于 0 帧（实际 ${firstSeg.startFrame}）`)
  const lastEnd = Math.max(...props.segments.map((s) => s.startFrame + s.durationInFrames))
  if (Math.abs(props.durationInFrames - lastEnd) > 1) {
    fail(`durationInFrames ${props.durationInFrames} 与最后段落终点 ${lastEnd} 不一致`)
  }
  const lastExpectedEndFrame = Math.round(((inScope[inScope.length - 1].endMs - renderStartMs) / 1000) * fps)
  if (!allowPartial && Math.abs(props.durationInFrames - lastExpectedEndFrame) > 2) {
    fail(`durationInFrames ${props.durationInFrames} 与主时间轴推导终点 ${lastExpectedEndFrame} 偏差 >2 帧`)
  }
  if (allowPartial) {
    if (!Number.isInteger(props.narrationEndFrame)) {
      fail('partial props 缺少 narrationEndFrame，无法证明 60 秒尾奏没有截断下一句旁白')
    } else if (Math.abs(props.narrationEndFrame - lastExpectedEndFrame) > 1) {
      fail(`narrationEndFrame ${props.narrationEndFrame} 与最后完整旁白终点 ${lastExpectedEndFrame} 不一致`)
    }
  }
  for (const sub of props.subtitles ?? []) {
    if (sub.endSec * fps > props.durationInFrames + fps) {
      fail(`字幕「${sub.text.slice(0, 16)}…」终点 ${sub.endSec}s 超出渲染时长`)
    }
  }
}

db.close()
if (violations.length) {
  console.error(`FAIL: ${violations.length} 处违规`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log(`OK: episode ${episodeId} props 与 TTS 主时间轴同步（${props.segments.length} 段落 / ${props.durationInFrames} 帧）`)
