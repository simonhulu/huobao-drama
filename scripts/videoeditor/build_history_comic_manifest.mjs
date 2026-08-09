#!/usr/bin/env node
/**
 * 历史漫剧五格渐进漫画 manifest 推导器（history-comic-five-v1）。
 *
 * 把一个历史 Episode 已落库的 narrative plan（visual_beats 权威毫秒时间轴）+
 * 已生成的 panel 图（storyboard_panels.final_path）推导成内容无关五格渐进漫画
 * 原生渲染器（dharma_comic_native_renderer.mjs，契约 comic-progressive-five-v1 /
 * props variant progressive_five）所需的 manifest。纯推导，不生成任何媒体。
 *
 * 设计原则（repo 教训：文档约束不住实现，gate 必须是代码）：每一步推导都有
 * 硬 gate，任何契约违反立即失败并给出可操作的报错（该重跑哪步、哪些 panel
 * 要重新生成），绝不产出静默降级的 manifest。
 *
 * Gate 一览（按执行顺序）：
 *   1. episode 存在；pre_tts_audio_url / pre_tts_titles_json 齐备；
 *   2. TTS 标题合法：非空 text、time_end > time_begin、有序不重叠（容差 1ms 浮点抖动）；
 *   3. 主音轨文件存在且非空（static/... 解析到 <repoRoot>/data/static/...）；
 *   4. 覆盖率 gate：标题跨度 / ffprobe 音频时长 ∈ [0.60, 1.05]；
 *   5. 最新真实 plan 存在（kind='full' 且 timing_source != 'storyboard_grid_fallback'，
 *      fallback plan 只是 UI 占位，拒绝）；
 *   6. plan 的 panel beat ≥ 5（一页五格）；窗口 end > start；单调不减（重叠 ≤ 500ms，
 *      与 check_dharma_sync.mjs:305-309 一致）；
 *   7. 每个 panel：gen_status='completed'、final_path 非空、文件存在非空；
 *      panel_key 必须能解析出 storyboard id（sb-(\d+)）；
 *   8. 每个 beat 窗口必须与至少一个 TTS 标题相交（否则落在旁白流之外）。
 *
 * 用法：
 *   node scripts/videoeditor/build_history_comic_manifest.mjs <episodeId> --out <manifestPath> [--db <path>] [--tail-sec 1.5]
 * 成功：原子写出 manifest（临时文件 + rename），stdout 打一行 JSON 摘要，退出 0。
 * 失败：stderr 打 FAIL: <原因>，退出 1，不写任何文件。
 * DB 路径优先级：--db > DB_PATH 环境变量 > <repoRoot>/data/huobao_drama.db。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const CONTRACT = 'history-comic-five-manifest-v1'
const FACTORY = 'history-comic-five-v1'
const MODEL = 'grid-narrative-panel'
const FPS = 30
const MIN_PANELS = 5
const DEFAULT_TAIL_SEC = 1.5
// 下游同步校验最多容忍 30fps × 2s = 60 帧尾部
const MAX_TAIL_SEC = 2.0
// 与 check_dharma_sync.mjs:305-309 的窗口重叠容差一致
const MAX_BEAT_OVERLAP_MS = 500
// TTS 标题有序性容差：MiniMax 输出是浮点毫秒，允许 1ms 抖动
const TITLE_OVERLAP_TOLERANCE_MS = 1
const COVERAGE_MIN = 0.60
const COVERAGE_MAX = 1.05

function fail(message) {
  throw new Error(message)
}

const round1 = (value) => Math.round(value * 10) / 10
const round3 = (value) => Math.round(value * 1000) / 1000

function loadDatabase(repoRoot) {
  const require = createRequire(path.join(repoRoot, 'backend/package.json'))
  return require('better-sqlite3')
}

/** ffprobe 取媒体时长（秒）。30s 超时；任何失败都抛出，绝不猜测时长。 */
export function probeMediaDurationSec(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.error) fail(`ffprobe 调用失败（${filePath}）：${result.error.message}`)
  if (result.status !== 0) {
    fail(`ffprobe 失败（exit ${result.status}，${filePath}）：${(result.stderr || '').trim()}`)
  }
  const seconds = Number.parseFloat((result.stdout || '').trim())
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail(`ffprobe 返回无效时长「${(result.stdout || '').trim()}」（${filePath}）`)
  }
  return seconds
}

/** 文件存在、是 regular file、且非零字节。 */
export function fileExistsNonZero(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/** DB 里的 static/... 相对路径解析到 <staticRoot>/static/...（repo 根下的 data/，不是 backend/）。 */
function resolveMediaPath(staticRoot, dbPathValue) {
  return path.isAbsolute(dbPathValue) ? dbPathValue : path.join(staticRoot, dbPathValue)
}

function parseStoryboardId(panelKey) {
  const match = /^sb-(\d+)$/.exec(panelKey || '')
  return match ? Number(match[1]) : null
}

/** 报错里统一用「panel_key(storyboard <id|?>)」指认一个 panel。 */
function panelLabel(row) {
  const storyboardId = parseStoryboardId(row.panel_key)
  return `${row.panel_key ?? '(无 panel_key)'}(storyboard ${storyboardId ?? '?'})`
}

function parseTtsTitles(rawJson, episodeId) {
  let titles
  try {
    titles = JSON.parse(rawJson)
  } catch {
    fail(`episode ${episodeId} 的 pre_tts_titles_json 不是合法 JSON`)
  }
  if (!Array.isArray(titles) || titles.length === 0) {
    fail(`episode ${episodeId} 的 pre_tts_titles_json 为空或不是数组`)
  }
  for (let i = 0; i < titles.length; i += 1) {
    const title = titles[i]
    if (!title || typeof title.text !== 'string' || title.text.trim() === '') {
      fail(`TTS 标题 #${i} 缺少非空 text`)
    }
    if (!Number.isFinite(title.time_begin) || !Number.isFinite(title.time_end)
      || title.time_end <= title.time_begin) {
      fail(`TTS 标题 #${i} 时间窗非法（time_begin=${title?.time_begin}, time_end=${title?.time_end}）`)
    }
    if (i > 0 && title.time_begin < titles[i - 1].time_end - TITLE_OVERLAP_TOLERANCE_MS) {
      fail(`TTS 标题 #${i} 与 #${i - 1} 重叠/乱序（#${i - 1} 结束 ${titles[i - 1].time_end}ms，#${i} 起始 ${title.time_begin}ms）`)
    }
  }
  return titles
}

/**
 * 推导历史漫剧五格漫画 manifest。纯函数式（副作用依赖全部可注入）：
 * @param {object} options
 * @param {string} options.dbPath SQLite 数据库路径
 * @param {number} options.episodeId 目标 episode
 * @param {number} [options.tailSec=1.5] 旁白结束后的尾部留白（≤ 2.0）
 * @param {string} [options.repoRoot] repo 根（用于定位 backend 依赖）
 * @param {string} [options.staticRoot] static 文件根（默认 <repoRoot>/data）
 * @param {(filePath: string) => number} [options.mediaDurationSec] 媒体时长探测（默认 ffprobe）
 * @param {(filePath: string) => boolean} [options.fsExists] 文件存在且非零判定
 * @param {object} [options.Database] better-sqlite3 构造函数（测试可注入）
 * @returns {{ manifest: object, planId: number, coverageRatio: number, narrationEndSec: number }}
 */
export function buildHistoryComicManifest(options) {
  const {
    dbPath,
    episodeId,
    tailSec = DEFAULT_TAIL_SEC,
    repoRoot = DEFAULT_REPO_ROOT,
    mediaDurationSec = probeMediaDurationSec,
    fsExists = fileExistsNonZero,
  } = options
  const staticRoot = options.staticRoot ?? path.join(repoRoot, 'data')
  const Database = options.Database ?? loadDatabase(repoRoot)

  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    fail(`episodeId 非法：${episodeId}`)
  }
  if (!Number.isFinite(tailSec) || tailSec < 0 || tailSec > MAX_TAIL_SEC) {
    fail(`tail-sec 必须在 [0, ${MAX_TAIL_SEC}] 内（下游同步校验最多容忍 ${FPS}fps × ${MAX_TAIL_SEC}s = ${FPS * MAX_TAIL_SEC} 帧尾部），收到：${tailSec}`)
  }

  const db = new Database(dbPath, { readonly: true })
  try {
    // 1) episode + 主音轨 + TTS 标题
    const episode = db.prepare(`
      SELECT e.id, e.drama_id, e.title AS episode_title,
             e.pre_tts_audio_url, e.pre_tts_titles_json,
             d.title AS drama_title, d.style AS drama_style
      FROM episodes e
      LEFT JOIN dramas d ON d.id = e.drama_id
      WHERE e.id = ?
    `).get(episodeId)
    if (!episode) fail(`episode ${episodeId} 不存在`)
    if (!episode.pre_tts_audio_url || !episode.pre_tts_titles_json) {
      fail(`episode ${episodeId} 缺少 pre_tts_audio_url 或 pre_tts_titles_json（先跑 pre-TTS 主时间轴生成）`)
    }
    const titles = parseTtsTitles(episode.pre_tts_titles_json, episodeId)

    const audioPath = resolveMediaPath(staticRoot, episode.pre_tts_audio_url)
    if (!fsExists(audioPath)) {
      fail(`主音轨文件缺失或为零字节：${audioPath}（DB 值 ${episode.pre_tts_audio_url}）`)
    }

    // 2) 覆盖率 gate：标题跨度必须解释音频时长的 [60%, 105%]
    const audioDurationSec = mediaDurationSec(audioPath)
    const titlesSpanMs = titles.at(-1).time_end - titles[0].time_begin
    const coverageRatio = titlesSpanMs / (audioDurationSec * 1000)
    if (coverageRatio < COVERAGE_MIN || coverageRatio > COVERAGE_MAX) {
      fail(`TTS 标题覆盖率 coverage=${coverageRatio.toFixed(4)} 超出 [${COVERAGE_MIN}, ${COVERAGE_MAX}]`
        + `（标题跨度 ${titlesSpanMs}ms / 音频 ${audioDurationSec}s）— 主时间轴与音频不匹配，拒绝推导`)
    }

    // 3) 最新真实 plan（fallback 是 UI 占位，拒绝）
    const plan = db.prepare(`
      SELECT id, kind, timing_source, created_at
      FROM narrative_plans
      WHERE episode_id = ?
        AND kind = 'full'
        AND COALESCE(timing_source, '') != 'storyboard_grid_fallback'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(episodeId)
    if (!plan) {
      fail(`episode ${episodeId} 没有真实 narrative plan（kind='full' 且 timing_source != 'storyboard_grid_fallback'；`
        + `fallback plan 只是 UI 占位）— re-run narrative-hierarchy/import`)
    }

    // 4) plan 的 beat × panel（visual_beats 毫秒时间轴是 panel 时序的权威来源）
    const rows = db.prepare(`
      SELECT vb.id AS beat_id, vb.start_ms, vb.end_ms, vb.description AS beat_description,
             p.id AS panel_row_id, p.panel_key, p.gen_status, p.final_path
      FROM visual_beats vb
      JOIN narration_events e ON e.id = vb.event_id
      JOIN narrative_sequences s ON s.id = e.sequence_id
      JOIN storyboard_panels p ON p.beat_id = vb.id AND p.plan_id = s.plan_id
      WHERE s.plan_id = ?
      ORDER BY vb.start_ms, vb.id
    `).all(plan.id)
    if (rows.length < MIN_PANELS) {
      fail(`plan ${plan.id} 只有 ${rows.length} 个 panel beat（< ${MIN_PANELS}，不足一页五格）— re-run narrative-hierarchy/import 或 panel 生成`)
    }

    const badTiming = rows.filter((row) => !Number.isFinite(row.start_ms) || !Number.isFinite(row.end_ms)
      || row.end_ms <= row.start_ms)
    if (badTiming.length) {
      fail(`beat 时间窗非法（需要 end_ms > start_ms 且非空）：`
        + badTiming.map((row) => `${panelLabel(row)} [${row.start_ms}, ${row.end_ms})`).join('；'))
    }

    const disordered = []
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].start_ms < rows[i - 1].end_ms - MAX_BEAT_OVERLAP_MS) {
        disordered.push(`${panelLabel(rows[i - 1])} 结束 ${rows[i - 1].end_ms}ms，${panelLabel(rows[i])} 起始 ${rows[i].start_ms}ms`)
      }
    }
    if (disordered.length) {
      fail(`beat 窗口重叠/乱序（容差 ${MAX_BEAT_OVERLAP_MS}ms）：${disordered.join('；')}`)
    }

    const badAssets = rows.filter((row) => row.gen_status !== 'completed'
      || !row.final_path
      || !fsExists(resolveMediaPath(staticRoot, row.final_path)))
    if (badAssets.length) {
      fail(`panel 素材未就绪（需 gen_status='completed' 且 final_path 文件存在非零）：`
        + badAssets.map((row) => `${panelLabel(row)} gen_status=${row.gen_status ?? '(空)'} final_path=${row.final_path ?? '(空)'}`).join('；')
        + ` — 按 storyboard id 重新生成这些 panel 图`)
    }

    const badKeys = rows.filter((row) => parseStoryboardId(row.panel_key) === null)
    if (badKeys.length) {
      fail(`panel_key 无法解析 storyboard id（期望格式 sb-<id>）：`
        + badKeys.map((row) => JSON.stringify(row.panel_key)).join('、'))
    }

    // 5) 每个 beat 窗口与 TTS 主时间轴求交，切出该 panel 的旁白原文
    const panels = []
    const outside = []
    for (const row of rows) {
      const hitIndices = []
      for (let i = 0; i < titles.length; i += 1) {
        if (titles[i].time_begin < row.end_ms && titles[i].time_end > row.start_ms) hitIndices.push(i)
      }
      if (!hitIndices.length) {
        outside.push(`${panelLabel(row)} beat ${row.beat_id} 窗口 [${row.start_ms}, ${row.end_ms})ms`)
        continue
      }
      panels.push({
        key: row.panel_key,
        storyboardId: parseStoryboardId(row.panel_key),
        beatId: row.beat_id,
        startSec: round3(row.start_ms / 1000),
        endSec: round3(row.end_ms / 1000),
        narrationText: hitIndices.map((i) => titles[i].text).join(''),
        ttsTitleStart: hitIndices[0],
        ttsTitleEnd: hitIndices.at(-1),
        src: row.final_path,
        focusX: 50,
        focusY: 50,
      })
    }
    if (outside.length) {
      fail(`beat 窗口落在旁白流之外（outside narration stream，与任何 TTS 标题无交集）：${outside.join('；')}`)
    }

    const narrationEndSec = round3(titles.at(-1).time_end / 1000)
    const manifest = {
      contract: CONTRACT,
      factory: FACTORY,
      episodeId,
      dramaId: episode.drama_id,
      title: episode.drama_title?.trim() || episode.episode_title?.trim() || `episode ${episodeId}`,
      stylePreset: episode.drama_style ?? null,
      model: MODEL,
      targetDurationSec: round1(titles.at(-1).time_end / 1000 + tailSec),
      narrationEndSec,
      fps: FPS,
      panels,
    }
    return { manifest, planId: plan.id, coverageRatio, narrationEndSec }
  } finally {
    db.close()
  }
}

/** 原子写：同目录临时文件 + rename，失败不留半截 manifest。 */
function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content)
  fs.renameSync(temporary, filePath)
}

function main() {
  const argv = process.argv.slice(2)
  const positional = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        console.error(`FAIL: ${token} 缺少参数值`)
        process.exit(1)
      }
      flags.set(token, value)
      i += 1
    } else {
      positional.push(token)
    }
  }

  const episodeId = Number(positional[0])
  const outArg = flags.get('--out')
  if (!Number.isInteger(episodeId) || episodeId <= 0 || !outArg) {
    console.error('usage: build_history_comic_manifest.mjs <episodeId> --out <manifestPath> [--db <path>] [--tail-sec 1.5]')
    process.exit(1)
  }
  const tailSec = flags.has('--tail-sec') ? Number(flags.get('--tail-sec')) : DEFAULT_TAIL_SEC
  const dbPath = path.resolve(flags.get('--db') ?? process.env.DB_PATH ?? path.join(DEFAULT_REPO_ROOT, 'data/huobao_drama.db'))
  const manifestPath = path.resolve(outArg)

  try {
    const { manifest, planId, narrationEndSec } = buildHistoryComicManifest({ dbPath, episodeId, tailSec })
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(JSON.stringify({
      manifestPath,
      episodeId,
      planId,
      panels: manifest.panels.length,
      targetDurationSec: manifest.targetDurationSec,
      narrationEndSec,
    }))
  } catch (error) {
    console.error(`FAIL: ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
