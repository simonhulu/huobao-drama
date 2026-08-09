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
 *   node scripts/videoeditor/check_dharma_sync.mjs <episodeId> [propsPath] [--fps=30] [--titles=/absolute/frozen-titles.json] [--allow-partial]
 * 默认 propsPath = data/static/temp/dharma-props-<episodeId>.json；
 * 可用 DB_PATH 指向替代 SQLite 数据库（测试/隔离校验）。
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
const titlesArg = args.find((a) => a.startsWith('--titles='))
const frozenTitlesPath = titlesArg ? path.resolve(titlesArg.slice('--titles='.length)) : null
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

if (!fs.existsSync(propsPath)) {
  console.error(`FAIL: props 不存在：${propsPath}`)
  process.exit(1)
}
let props
try {
  props = JSON.parse(fs.readFileSync(propsPath, 'utf8'))
} catch {
  console.error(`FAIL: props 解析失败：${propsPath}`)
  process.exit(1)
}

const normLen = (s) => (s || '').replace(/\s+/g, '')
const violations = []
const fail = (msg) => violations.push(msg)

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(repoRoot, 'data/huobao_drama.db')
const db = new Database(dbPath, { readonly: true })

// 1) 主时间轴
const ep = db
  .prepare(`SELECT id, pre_tts_audio_url AS preTtsAudioUrl, pre_tts_titles_json AS preTtsTitlesJson, bgm_audio_url AS bgmAudioUrl
            FROM episodes WHERE id = ?`)
  .get(episodeId)
if (!ep) {
  console.error(`FAIL: episode ${episodeId} 不存在`)
  process.exit(1)
}
if (!ep.preTtsAudioUrl || (!ep.preTtsTitlesJson && !frozenTitlesPath)) {
  console.error(`FAIL: episode ${episodeId} 缺少 preTtsAudioUrl/preTtsTitlesJson`)
  process.exit(1)
}
let titles = []
try {
  titles = frozenTitlesPath
    ? JSON.parse(fs.readFileSync(frozenTitlesPath, 'utf8'))
    : JSON.parse(ep.preTtsTitlesJson)
} catch {
  console.error(`FAIL: TTS titles 解析失败${frozenTitlesPath ? `：${frozenTitlesPath}` : ''}`)
  process.exit(1)
}
let stream = ''
const spans = []
const authoritativeTitles = []
for (const [titleIndex, t] of titles.entries()) {
  const rawText = String(t?.text || '')
  const text = normLen(t?.text)
  const beginSec = Number(t?.time_begin ?? 0) / 1000
  const endSec = Number(t?.time_end ?? 0) / 1000
  if (!rawText || !text || !(endSec > beginSec)) {
    fail(`TTS title #${titleIndex + 1} 文本或时间范围无效`)
    continue
  }
  authoritativeTitles.push({ titleIndex, text: rawText, beginSec, endSec })
  spans.push({ titleIndex, charStart: stream.length, charEnd: stream.length + text.length, beginSec, endSec })
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

// 2) 期望的旁白窗口（独立重推导）
// Hybrid props use database storyboards. Progressive-five comic props are
// authored directly against complete TTS titles and therefore carry one
// narrationWindow per title instead of requiring duplicate storyboard rows.
let cursor = 0
const expected = []
if (props.variant === 'progressive_five') {
  const audioStartFrame = Number.isInteger(props.audioStartFrame) && props.audioStartFrame >= 0
    ? props.audioStartFrame
    : 0
  const actualWindows = Array.isArray(props.narrationWindows) ? props.narrationWindows : []
  const allAuthoritativeWindows = authoritativeTitles
    .map((title) => ({
      num: `TTS ${title.titleIndex + 1}`,
      titleIndex: title.titleIndex,
      startMs: Math.round(title.beginSec * 1000),
      endMs: Math.round(title.endSec * 1000),
      startFrame: Math.round(title.beginSec * fps) - audioStartFrame,
      endFrame: Math.round(title.endSec * fps) - audioStartFrame,
    }))
  const authoritativeWindows = allowPartial
    ? allAuthoritativeWindows.filter((window) => window.startFrame >= -1 && window.endFrame <= props.durationInFrames + 1)
    : allAuthoritativeWindows

  expected.push(...authoritativeWindows)
  const finalAuthoritativeEndFrame = allAuthoritativeWindows.at(-1)?.endFrame
  if (!allowPartial && Number.isFinite(finalAuthoritativeEndFrame) && finalAuthoritativeEndFrame > props.durationInFrames + 1) {
    fail(`progressive_five full production durationInFrames ${props.durationInFrames} 截断 TTS 主时间轴终点 ${finalAuthoritativeEndFrame}`)
  }
  if (!actualWindows.length) {
    fail('progressive_five props.narrationWindows 为空')
  } else if (actualWindows.length !== authoritativeWindows.length) {
    fail(`progressive_five 旁白窗口数量 ${actualWindows.length} 与 TTS title 数量 ${authoritativeWindows.length} 不一致`)
  }
  for (let index = 0; index < Math.min(actualWindows.length, authoritativeWindows.length); index++) {
    const actual = actualWindows[index]
    const authoritative = authoritativeWindows[index]
    if (!Number.isInteger(actual?.startFrame) || !Number.isInteger(actual?.endFrame) || actual.endFrame <= actual.startFrame) {
      fail(`progressive_five 旁白窗口 #${index + 1} 无效`)
      continue
    }
    if (Math.abs(actual.startFrame - authoritative.startFrame) > 1
      || Math.abs(actual.endFrame - authoritative.endFrame) > 1) {
      fail(`progressive_five 旁白窗口 #${index + 1} 与 TTS 不一致（${actual.startFrame}→${actual.endFrame}，期望 ${authoritative.startFrame}→${authoritative.endFrame}）`)
    }
  }

  const expectedSubtitleIndexes = new Set(authoritativeWindows.map((window) => window.titleIndex))
  const subtitles = Array.isArray(props.subtitles) ? props.subtitles : []
  const subtitlesByTitle = new Map()
  let previousSubtitleIndex = -1
  for (const [subtitleIndex, subtitle] of subtitles.entries()) {
    const titleIndex = Number(subtitle?.ttsTitleIndex)
    if (!Number.isInteger(titleIndex) || !expectedSubtitleIndexes.has(titleIndex)) {
      fail(`字幕 #${subtitleIndex + 1} 缺少有效的 TTS title 来源索引`)
      continue
    }
    if (titleIndex < previousSubtitleIndex) {
      fail(`字幕 #${subtitleIndex + 1} 的 TTS title 来源索引乱序`)
    }
    previousSubtitleIndex = titleIndex
    const group = subtitlesByTitle.get(titleIndex) || []
    group.push(subtitle)
    subtitlesByTitle.set(titleIndex, group)
  }
  const orderedPropsSubtitles = []
  const expectedSpokenWindows = []
  for (const titleIndex of expectedSubtitleIndexes) {
    const title = authoritativeTitles.find((item) => item.titleIndex === titleIndex)
    const group = subtitlesByTitle.get(titleIndex) || []
    if (!group.length) {
      fail(`TTS title #${titleIndex + 1} 没有对应字幕`)
      continue
    }
    const subtitleText = group.map((subtitle) => String(subtitle.text || '')).join('')
    if (subtitleText !== title.text) {
      fail(`TTS title #${titleIndex + 1} 的字幕文本与来源不一致`)
    }
    let consumedCharacters = 0
    for (const [partIndex, subtitle] of group.entries()) {
      const text = String(subtitle.text || '')
      const expectedStartSec = title.beginSec
        + (title.endSec - title.beginSec) * (consumedCharacters / title.text.length)
      consumedCharacters += text.length
      const expectedEndSec = title.beginSec
        + (title.endSec - title.beginSec) * (consumedCharacters / title.text.length)
      orderedPropsSubtitles.push(subtitle)
      expectedSpokenWindows.push({ startSec: expectedStartSec, endSec: expectedEndSec })
      const startSec = Number(subtitle.startSec)
      const endSec = Number(subtitle.endSec)
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec
        || Math.abs(startSec - expectedStartSec) > 1 / fps
        || Math.abs(endSec - expectedEndSec) > 1 / fps) {
        fail(`字幕 #${titleIndex + 1}.${partIndex + 1} 与 TTS title #${titleIndex + 1} 时间不一致`)
      }
    }
  }

  // ink-read-v2 驻留规则独立重算：显示窗口 = spoken 窗口 +0.35s 驻留（与下一句
  // 间隙 <12 帧时减半），退场与下一句入场重叠封顶 3 帧。props 里的
  // displayStartSec/displayEndSec 必须与此推导一致（容差 ±1 帧），缺失或不符
  // 都视为字幕时序被篡改。
  if (orderedPropsSubtitles.length && orderedPropsSubtitles.length === expectedSpokenWindows.length) {
    const dwellSec = 0.35
    const shortGapSec = 12 / fps
    const exitOverlapSec = 3 / fps
    expectedSpokenWindows.forEach((window, index) => {
      const subtitle = orderedPropsSubtitles[index]
      const next = expectedSpokenWindows[index + 1]
      const gapSec = next ? next.startSec - window.endSec : Number.POSITIVE_INFINITY
      const expectedDwellSec = gapSec < shortGapSec ? dwellSec / 2 : dwellSec
      let expectedDisplayEndSec = window.endSec + expectedDwellSec
      if (next) expectedDisplayEndSec = Math.min(expectedDisplayEndSec, next.startSec + exitOverlapSec)
      const displayStartSec = Number(subtitle?.displayStartSec)
      const displayEndSec = Number(subtitle?.displayEndSec)
      if (!Number.isFinite(displayStartSec) || !Number.isFinite(displayEndSec)) {
        fail(`字幕 #${index + 1} 缺少 ink-read-v2 display 窗口（displayStartSec/displayEndSec）`)
        return
      }
      if (Math.abs(displayStartSec - window.startSec) > 1 / fps
        || Math.abs(displayEndSec - expectedDisplayEndSec) > 1 / fps
        || displayEndSec <= displayStartSec) {
        fail(`字幕 #${index + 1} 的 ink-read-v2 display 窗口与驻留规则不一致（${displayStartSec}→${displayEndSec}，期望 ${window.startSec}→${expectedDisplayEndSec}）`)
      }
    })
  }

  const titleTimeAt = (range, characterIndex, edge) => {
    let characterCursor = 0
    for (const title of range) {
      const end = characterCursor + title.text.length
      const inside = edge === 'start'
        ? characterIndex >= characterCursor && characterIndex < end
        : characterIndex > characterCursor && characterIndex <= end
      if (inside) {
        const progress = (characterIndex - characterCursor) / title.text.length
        return title.beginSec + (title.endSec - title.beginSec) * progress
      }
      characterCursor = end
    }
    return edge === 'start' && characterIndex === characterCursor
      ? range.at(-1)?.endSec
      : Number.NaN
  }
  for (const [quoteIndex, quote] of (props.quotes || []).entries()) {
    const ttsTitleStart = Number(quote?.ttsTitleStart)
    const ttsTitleEnd = Number(quote?.ttsTitleEnd)
    if (!Number.isInteger(ttsTitleStart) || !Number.isInteger(ttsTitleEnd)
      || ttsTitleStart < 0 || ttsTitleEnd < ttsTitleStart || ttsTitleEnd >= titles.length) {
      fail(`金句 #${quoteIndex + 1} 缺少有效的 TTS title 范围`)
      continue
    }
    const range = authoritativeTitles.filter((title) => (
      title.titleIndex >= ttsTitleStart && title.titleIndex <= ttsTitleEnd
    ))
    if (range.length !== ttsTitleEnd - ttsTitleStart + 1) {
      fail(`金句 #${quoteIndex + 1} 的 TTS title 范围包含无效 title`)
      continue
    }
    const quoteText = String(quote?.text || '').trim()
    const rangeText = range.map((title) => title.text).join('')
    const relativeStart = rangeText.indexOf(quoteText)
    if (!quoteText || relativeStart < 0) {
      fail(`金句 #${quoteIndex + 1} 不在声明的 TTS title 范围内`)
      continue
    }
    const spokenStartSec = titleTimeAt(range, relativeStart, 'start')
    const spokenEndSec = titleTimeAt(range, relativeStart + quoteText.length, 'end')
    const expectedStartFrame = Math.max(0, Math.floor((spokenStartSec - 0.35) * fps))
    const expectedSpokenEndFrame = Math.ceil((spokenEndSec + 0.65) * fps)
    const expectedDurationInFrames = Math.max(90, expectedSpokenEndFrame - expectedStartFrame)
    if (Number(quote.startFrame) !== expectedStartFrame
      || Number(quote.durationInFrames) !== expectedDurationInFrames) {
      fail(`金句 #${quoteIndex + 1} 与声明的 TTS title 范围时间不一致`)
    }
  }
} else {
  const storyboards = db
    .prepare(`SELECT id, storyboard_number AS num, narration, description, grid_cells AS gridCells
              FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number`)
    .all(episodeId)
  if (!storyboards.length) {
    fail(`episode ${episodeId} 没有分镜`)
  }
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
}
for (let i = 1; i < expected.length; i++) {
  if (expected[i].startMs < expected[i - 1].endMs - 500) {
    fail(`分镜窗口重叠/乱序（#${expected[i - 1].num} 结束 ${expected[i - 1].endMs}ms，#${expected[i].num} 起始 ${expected[i].startMs}ms）`)
  }
}

// 3) props 校验
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
  if (props.variant === 'progressive_five') {
    if (!Number.isInteger(props.narrationEndFrame)) {
      fail('progressive_five props 缺少 narrationEndFrame，无法证明尾奏没有截断旁白')
    } else if (Math.abs(props.narrationEndFrame - lastExpectedEndFrame) > 1) {
      fail(`narrationEndFrame ${props.narrationEndFrame} 与最后完整旁白终点 ${lastExpectedEndFrame} 不一致`)
    } else {
      const tailFrames = props.durationInFrames - props.narrationEndFrame
      if (tailFrames < 0 || tailFrames > fps * 2) {
        fail(`progressive_five 尾奏 ${tailFrames} 帧超出 0-${fps * 2} 帧范围`)
      }
    }
  } else if (!allowPartial && Math.abs(props.durationInFrames - lastExpectedEndFrame) > 2) {
    fail(`durationInFrames ${props.durationInFrames} 与主时间轴推导终点 ${lastExpectedEndFrame} 偏差 >2 帧`)
  } else if (allowPartial && !Number.isInteger(props.narrationEndFrame)) {
    fail('partial props 缺少 narrationEndFrame，无法证明尾奏没有截断下一句旁白')
  } else if (allowPartial && Math.abs(props.narrationEndFrame - lastExpectedEndFrame) > 1) {
    fail(`narrationEndFrame ${props.narrationEndFrame} 与最后完整旁白终点 ${lastExpectedEndFrame} 不一致`)
  }
  for (const sub of props.subtitles ?? []) {
    if (sub.endSec * fps > props.durationInFrames + fps) {
      fail(`字幕「${sub.text.slice(0, 16)}…」终点 ${sub.endSec}s 超出渲染时长`)
    }
    if (Number.isFinite(Number(sub.displayEndSec))
      && Number(sub.displayEndSec) * fps > props.durationInFrames + fps) {
      fail(`字幕「${sub.text.slice(0, 16)}…」display 终点 ${sub.displayEndSec}s 超出渲染时长`)
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
