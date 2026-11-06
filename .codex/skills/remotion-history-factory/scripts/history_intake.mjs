#!/usr/bin/env node

/**
 * history_intake.mjs — 历史视频工厂 intake（--source-only 交接 videoeditor）
 *
 * 把「稿件 → 上游创作合同就绪」的全过程固化成一个幂等命令：
 *
 *   node history_intake.mjs --script <稿件路径> \
 *       [--drama <drama-id> | --create-drama] [--style <style-id>] \
 *       [--source-only] [--bgm <static/music/路径>] [--publishing-package <path>] [--force-break] [--retry-pre-tts]
 *
 * 步骤（每步幂等，已完成的报告 skipped）：
 *   1. episode_import    读取稿件 frontmatter 的 confirmed title，剥离元数据后
 *                        复用或创建 drama，再用同一 title POST /dramas/:id/import-script
 *                        建 direct_script 集（同稿件重导入自动跳过）
 *   2. neutralize_tasks  取消 import 自动调度的合同外任务：storyboard_breaker LLM
 *                        （会删确定性分镜）、cover/hook/intro/recap（合同外生成开销）
 *   3. pre_tts           轮询等 tts.pre_generate 产出 pre_tts_audio_url + titles（≤15min）
 *   4. break             POST /episodes/:id/storyboards:break-deterministic（无 LLM）
 *      --source-only     回读验证稿件、发布包、TTS 与分镜，输出 source-ready 并交接
 *                        videoeditor；不建漫画项目/叙事层级、不继承或写入 BGM
 *   5. remotion_project  建 Remotion 项目（复用"narration 精确覆盖"校验）
 *   6. narrative_plan    从 titles+storyboards 机械构建 kind='full' 计划并 import
 *                        （1 event = 1 beat = 1 panel，Sequence 按 ~10-15 panel 均衡分组，
 *                        timing_source='tts-time-begin-end'，build_ep790 模板泛化）
 *   7. bgm               --bgm 显式设置；否则继承 drama 最近一集；都没有则报错
 *   8. final_check       逐条打印合同 5 项状态，输出紧凑单行 JSON，exit 0
 *
 * 失败约定：任何步骤失败打印 {"step":...,"error":...,"direction":...} 并 exit 1。
 * 后端地址：默认 http://localhost:5679，env BASE_URL 覆盖。DB：env DB_PATH 覆盖
 * （默认 <repo>/data/huobao_drama.db，只读，用于计划/终检的状态探测）。
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { publishingPackageFingerprint, readPublishingPackage } from '../../remotion-dharma-factory/scripts/dharma_publishing_package.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../../..')
const requireFromBackend = createRequire(join(repoRoot, 'backend/package.json'))

const baseUrl = (process.env.BASE_URL || 'http://localhost:5679').replace(/\/+$/u, '')
const apiBase = `${baseUrl}/api/v1`
const dbPath = process.env.DB_PATH || join(repoRoot, 'data/huobao_drama.db')

const PRE_TTS_TIMEOUT_MS = 15 * 60 * 1000
const PRE_TTS_POLL_MS = 6000
const MIN_BGM_SEC = 30
const PLAN_SKIP_DURATION_TOLERANCE_MS = 1500
const SEQUENCE_TARGET_PANELS = 12

/* ===== 参数与输出 ===== */

function usage() {
  console.error('Usage: node history_intake.mjs --script <path> [--episode <id>] [--drama <id> | --create-drama] [--style <style-id>] [--source-only] [--bgm <static/music/...>] [--publishing-package <path>] [--force-break] [--retry-pre-tts]')
  process.exit(2)
}

function parseArgs(argv) {
  const options = { force_break: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) usage()
    const name = token.slice(2)
    if (name === 'force-break' || name === 'retry-pre-tts' || name === 'source-only') {
      options[name.replaceAll('-', '_')] = true
      continue
    }
    if (name === 'create-drama') {
      options.create_drama = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) usage()
    index += 1
    options[name.replaceAll('-', '_')] = value
  }
  if (!options.script) usage()
  if (options.drama !== undefined) {
    options.drama = Number(options.drama)
    if (!Number.isInteger(options.drama) || options.drama <= 0) usage()
  }
  if (options.episode !== undefined) {
    options.episode = Number(options.episode)
    if (!Number.isInteger(options.episode) || options.episode <= 0) usage()
  }
  if (options.drama && options.create_drama) usage()
  if (options.episode && options.create_drama) usage()
  // Without either an episode or drama id, "create or reuse by script" is the
  // default. An explicit episode always targets an existing record.
  options.create_drama = options.create_drama || (!options.drama && !options.episode)
  return options
}

const stepReports = []

function logLine(message) {
  console.error(`[intake] ${message}`)
}

function reportStep(step, status, detail = {}) {
  stepReports.push({ step, status, ...detail })
  logLine(`${step}: ${status} ${JSON.stringify(detail)}`)
}

function failStep(step, error, direction) {
  process.stdout.write(`${JSON.stringify({ step, error, direction, steps: stepReports })}\n`)
  process.exit(1)
}

/* ===== HTTP ===== */

async function api(method, path, body) {
  const resp = await fetch(`${apiBase}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await resp.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 保留原文 */ }
  return { status: resp.status, json, text }
}

function unwrap(result) {
  if (result.json && (result.json.code === 200 || result.json.code === 201)) {
    return result.json.data !== undefined ? result.json.data : result.json
  }
  return undefined
}

function apiErrorMessage(result) {
  return result.json?.message || result.text.slice(0, 300)
}

async function retryFailedPreTts(episodeId) {
  const tasksResult = await api('GET', `/tasks?episode_id=${episodeId}&type=tts.pre_generate`)
  const tasks = unwrap(tasksResult)
  if (!Array.isArray(tasks)) throw new Error(apiErrorMessage(tasksResult))
  const latest = [...tasks].sort((a, b) => b.id - a.id)[0]
  if (latest?.status !== 'failed') {
    return { requested: false, task_id: latest?.id ?? null, status: latest?.status ?? null }
  }
  const result = await api('POST', `/episodes/${episodeId}/regenerate-production`, { force: false })
  const recovery = unwrap(result)
  if (!recovery?.task_id) throw new Error(apiErrorMessage(result))
  return { requested: true, task_id: recovery.task_id, status: recovery.status }
}

function parseMetadata(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// Source readiness is deliberately separate from finished-video readiness. Read the persisted
// rows again rather than trusting the split response or a previously cached episode snapshot.
async function verifySourceReadiness({ episodeId, dramaId, title, scriptSha, normalizedScript, publishingPackage, storyboardCount }) {
  const finalEpisode = unwrap(await api('GET', `/episodes/${episodeId}`))
  const finalDrama = unwrap(await api('GET', `/dramas/${dramaId}`))
  const rows = unwrap(await api('GET', `/episodes/${episodeId}/storyboards`))
  const storyboards = Array.isArray(rows) ? rows.slice().sort((a, b) => a.storyboard_number - b.storyboard_number) : []
  const metadata = parseMetadata(finalEpisode?.metadata)
  const finalPackage = metadata.dharmaPublishing?.package
  let packageFingerprint = null
  try { packageFingerprint = publishingPackageFingerprint(finalPackage) } catch { /* invalid persisted package */ }

  let finalTitles = []
  try {
    const parsed = JSON.parse(finalEpisode?.pre_tts_titles_json || '[]')
    if (Array.isArray(parsed)) finalTitles = parsed
  } catch { /* invalid persisted titles */ }
  if (finalTitles.length && finalTitles.every((item) => Number.isFinite(Number(item?.text_begin)))) {
    finalTitles.sort((a, b) => Number(a.text_begin) - Number(b.text_begin))
  }
  const spokenTitles = finalTitles.filter((item) => normalizeForMatch(String(item?.text || '')))
  const titleTimingValid = spokenTitles.length > 0 && spokenTitles.every((item) => (
    Number.isFinite(Number(item.time_begin)) && Number(item.time_begin) >= 0
    && Number.isFinite(Number(item.time_end)) && Number(item.time_end) > Number(item.time_begin)
  ))
  const sourceText = normalizeForMatch(normalizedScript)
  const contract = {
    manuscript: {
      ok: finalEpisode?.title === title
        && sha256(normalizeTtsText(String(finalEpisode?.script_content || finalEpisode?.content || ''))) === scriptSha,
      title: finalEpisode?.title ?? null,
      expected_sha256: scriptSha,
    },
    publishing_package: {
      ok: packageFingerprint === publishingPackage.sha256
        && metadata.dharmaPublishing?.package_sha256 === publishingPackage.sha256,
      sha256: packageFingerprint,
      expected_sha256: publishingPackage.sha256,
    },
    episode_style: {
      ok: finalEpisode?.workflow_type === 'direct_script'
        && Number(finalEpisode?.drama_id ?? finalEpisode?.dramaId) === dramaId
        && Number(finalDrama?.id) === dramaId && !!String(finalDrama?.style || '').trim(),
      style: finalDrama?.style ?? null,
    },
    pre_tts: {
      ok: !!String(finalEpisode?.pre_tts_audio_url || '').trim() && titleTimingValid
        && normalizeForMatch(spokenTitles.map((item) => item.text).join('')) === sourceText,
      audio_url: finalEpisode?.pre_tts_audio_url ?? null,
      title_count: finalTitles.length,
      duration_ms: titleTimingValid ? Math.max(...spokenTitles.map((item) => Number(item.time_end))) : null,
    },
    storyboards: {
      ok: storyboards.length > 0 && storyboards.length === Number(storyboardCount)
        && storyboards.every((shot, index) => Number(shot.storyboard_number) === index + 1
          && normalizeForMatch(String(shot.narration || '')).length > 0
          && Number.isFinite(Number(shot.duration)) && Number(shot.duration) > 0 && Number(shot.duration) <= 8)
        && normalizeForMatch(storyboards.map((shot) => shot.narration || '').join('')) === sourceText
        && metadata.episodeProduction?.storyboardsStale !== true,
      count: storyboards.length,
      expected_count: Number(storyboardCount),
    },
  }
  return { ok: Object.values(contract).every((check) => check.ok), contract, storyboardCount: storyboards.length }
}

/* ===== 文本工具（与 backend/src/utils/tts-text.ts 的 normalizeTtsText 完全一致） ===== */

function normalizeTtsText(text) {
  if (!text) return ''
  return text
    .replace(/[\u200B-\u200F\uFEFF\u00A0\u3000\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u2500-\u257F\u2580-\u259F]/g, '')
    .replace(/([\u4e00-\u9fa5\u3400-\u4dbf])\s+(?=[\u4e00-\u9fa5\u3400-\u4dbf])/g, '$1')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// polish-video-script writes this exact envelope after the creator confirms a title. Keep the
// title out of spoken narration and refuse malformed metadata instead of guessing from filenames.
function extractConfirmedTitleAndBody(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/u, '')
  const match = text.match(/^---\r?\ntitle:\s*(.+?)\r?\n---(?:\r?\n|$)/u)
  if (!match) return { title: null, body: text }

  const encodedTitle = match[1].trim()
  let title
  try {
    title = JSON.parse(encodedTitle)
  } catch {
    throw new Error('title frontmatter must be a JSON-quoted string')
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('title frontmatter must contain a non-empty string')
  }
  return { title: title.trim(), body: text.slice(match[0].length) }
}

const SPOKEN_BODY_PROCESS_LABEL_RE = /^\s*(?:最终稿|初稿|口播稿|口播正文|正文|标题|大纲|创作方案|发布文案|发布包|流程|步骤|备注|说明)\s*(?:[:：]|$)/u
const SPOKEN_BODY_METADATA_KEY_RE = /^\s*(?:title|schema_version|opening_hook|cliffhanger|creative_brief|cover_design|chapter_hooks)\s*:/iu

function findSpokenBodyViolation(body) {
  const lines = String(body || '').split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (/^\s{0,3}#{1,6}(?:[ \t]+|$)/u.test(line)) {
      return { line: index + 1, kind: 'Markdown heading', text: trimmed }
    }
    if (/^\s{0,3}(?:---+|\*\*\*+|___+)[ \t]*$/u.test(line)) {
      return { line: index + 1, kind: 'Markdown separator or frontmatter marker', text: trimmed }
    }
    if (SPOKEN_BODY_PROCESS_LABEL_RE.test(line) || SPOKEN_BODY_METADATA_KEY_RE.test(line)) {
      return { line: index + 1, kind: 'production metadata label', text: trimmed }
    }
  }
  return null
}

function assertSpokenBodyContract(body) {
  const violation = findSpokenBodyViolation(body)
  if (!violation) return String(body || '')
  throw new Error(`spoken body contains ${violation.kind} at line ${violation.line}: ${violation.text}`)
}

// A script-only invocation must be rerunnable without creating a second series.
// Search the enriched drama response for an exact normalized body match before
// creating anything. The confirmed manuscript title remains the only title
// input; the script hash is only an idempotency key.
async function findExistingDramaByScript(scriptSha) {
  const result = await api('GET', '/dramas?page=1&page_size=1000')
  const payload = unwrap(result)
  if (!payload && result.status >= 400) {
    failStep('episode_import', apiErrorMessage(result), '无法查询已有 drama；确认后端可用后重跑')
  }
  const dramas = Array.isArray(payload) ? payload : payload?.items || []
  for (const drama of dramas) {
    const episode = (drama.episodes || [])
      .find((candidate) => sha256(normalizeTtsText(String(candidate.script_content || candidate.content || ''))) === scriptSha)
    if (episode) return { drama, episode }
  }
  return null
}

async function resolveDramaForIntake({ options, title, scriptSha }) {
  if (options.episode) {
    const episodeResult = await api('GET', `/episodes/${options.episode}`)
    const existingEpisode = unwrap(episodeResult)
    if (!existingEpisode) {
      failStep('episode_import', `episode ${options.episode} not found`, '确认 --episode id 后重跑')
    }
    const episodeDramaId = Number(existingEpisode.drama_id || existingEpisode.dramaId)
    if (!Number.isInteger(episodeDramaId) || episodeDramaId <= 0) {
      failStep('episode_import', `episode ${options.episode} has no valid drama_id`, '确认 episode 归属后重跑')
    }
    if (options.drama && Number(options.drama) !== episodeDramaId) {
      failStep('episode_import', `episode ${options.episode} does not belong to drama ${options.drama}`, '使用匹配的 --episode 和 --drama，或省略 --drama')
    }
    const dramaResult = await api('GET', `/dramas/${episodeDramaId}`)
    const drama = unwrap(dramaResult)
    if (!drama) {
      failStep('episode_import', `drama ${episodeDramaId} not found for episode ${options.episode}`, '确认 episode 与 drama 状态后重跑')
    }
    return { drama, dramaId: episodeDramaId, dramaCreated: false, existingEpisode }
  }

  if (options.drama) {
    const result = await api('GET', `/dramas/${options.drama}`)
    const drama = unwrap(result)
    if (!drama) {
      failStep('episode_import', `drama ${options.drama} not found`, '确认 drama id，或省略 --drama 让 intake 按确认标题创建 drama')
    }
    return { drama, dramaId: Number(options.drama), dramaCreated: false, existingEpisode: null }
  }

  const existing = await findExistingDramaByScript(scriptSha)
  if (existing) {
    return {
      drama: existing.drama,
      dramaId: Number(existing.drama.id),
      dramaCreated: false,
      existingEpisode: existing.episode,
    }
  }

  let style
  try {
    style = requireExplicitStyle(options)
  } catch {
    failStep('episode_import', 'new drama style is required',
      '先询问用户要使用哪一种视觉风格，再用 --style <style-id> 重跑；禁止自动使用 historical_systems')
  }
  const result = await api('POST', '/dramas', {
    title,
    genre: 'history',
    style,
    total_episodes: 0,
  })
  const created = unwrap(result)
  const dramaId = Number(created?.id || created?.drama_id)
  if (!created || !Number.isInteger(dramaId) || dramaId <= 0) {
    failStep('episode_import', apiErrorMessage(result), '创建 drama 失败；检查媒体账号、style 和后端日志')
  }
  const readback = unwrap(await api('GET', `/dramas/${dramaId}`))
  return {
    drama: readback || created,
    dramaId,
    dramaCreated: true,
    existingEpisode: null,
  }
}

/** 与后端 narration-generation / deterministic-breaker 相同的归一化：忽略空白/标点/符号（含 『』「」""《》——ep788 实证坑） */
function normalizeForMatch(text) {
  return (text || '').replace(/[\s\p{P}\p{S}]/gu, '')
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function requireExplicitStyle(options) {
  const style = String(options?.style || '').trim()
  if (!style) throw new Error('new drama style is required')
  return style
}

export function resolvePublishingPackagePath(scriptPath, explicitPath) {
  return resolve(explicitPath || join(dirname(resolve(scriptPath)), '07-publishing-package.json'))
}

/* ===== DB（只读探测，可选） ===== */

function openDbReadonly() {
  try {
    const Database = requireFromBackend('better-sqlite3')
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
}

function readPlanStatusFromDb(episodeId) {
  const db = openDbReadonly()
  if (!db) return null
  try {
    const plan = db.prepare(
      "SELECT id, timing_source, duration_ms FROM narrative_plans WHERE episode_id = ? AND kind = 'full'",
    ).get(episodeId)
    if (!plan) return { exists: false }
    const beatCoverage = db.prepare(
      `SELECT COUNT(*) AS n FROM visual_beats vb
       JOIN narration_events ne ON ne.id = vb.event_id
       JOIN narrative_sequences ns ON ns.id = ne.sequence_id
       WHERE ns.plan_id = ? AND vb.start_ms IS NOT NULL AND vb.end_ms IS NOT NULL`,
    ).get(plan.id).n
    return { exists: true, planId: plan.id, timingSource: plan.timing_source, durationMs: plan.duration_ms, beatCoverage }
  } finally {
    db.close()
  }
}

/* ===== 叙事计划构建（build_ep790 模板泛化：段落分组 → ~10-15 panel 均衡分组） ===== */

function buildTitleTimeline(titles) {
  let stream = ''
  const spans = []
  const sorted = titles.slice()
  if (sorted.length > 0 && sorted.every((t) => Number.isFinite(Number(t?.text_begin)))) {
    sorted.sort((a, b) => Number(a.text_begin) - Number(b.text_begin))
  }
  for (const t of sorted) {
    const text = normalizeForMatch(String(t?.text || ''))
    if (!text) continue
    spans.push({
      startChar: stream.length,
      endChar: stream.length + text.length,
      startMs: Number(t.time_begin),
      endMs: Number(t.time_end),
    })
    stream += text
  }
  const timeAt = (pos) => {
    for (const sp of spans) {
      if (pos <= sp.endChar) {
        const len = Math.max(1, sp.endChar - sp.startChar)
        const ratio = Math.min(1, Math.max(0, (pos - sp.startChar) / len))
        return Math.round(sp.startMs + ratio * (sp.endMs - sp.startMs))
      }
    }
    return spans[spans.length - 1].endMs
  }
  return { stream, timeAt, durationMs: Math.round(spans[spans.length - 1].endMs) }
}

/** 把 N 个分镜均衡分成若干 Sequence：N≤15 一个；否则 k=ceil(N/12)，每组 floor/ceil 均分 */
function sequenceSizes(count) {
  if (count <= 15) return [count]
  const k = Math.ceil(count / SEQUENCE_TARGET_PANELS)
  const base = Math.floor(count / k)
  const extra = count - base * k
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0))
}

function buildNarrativePlan({ titles, storyboards, styleProfile, sourcePath }) {
  const { stream, timeAt, durationMs } = buildTitleTimeline(titles)

  // 每个分镜：旁白在 TTS 流中顺序定位（cursor 推进，重复短语不会错配到更早出现处）→ 时间窗
  const rows = []
  let cursor = 0
  for (const sb of storyboards) {
    const text = normalizeForMatch(sb.narration)
    const prev = rows[rows.length - 1]
    const fallback = prev
      ? { startMs: prev.endMs, endMs: prev.endMs + (sb.duration || 0) * 1000 }
      : { startMs: 0, endMs: (sb.duration || 0) * 1000 }
    if (!text) {
      rows.push({ sb, ...fallback })
      continue
    }
    let idx = stream.indexOf(text, cursor)
    if (idx < 0) idx = stream.indexOf(text)
    if (idx < 0) {
      logLine(`warn: 分镜 #${sb.storyboard_number} 不在 TTS 流中，使用邻近估算窗口`)
      rows.push({ sb, ...fallback })
      continue
    }
    const startMs = timeAt(idx)
    const endMs = timeAt(idx + text.length)
    cursor = idx + text.length
    rows.push({ sb, startMs, endMs })
  }

  const sizes = sequenceSizes(rows.length)
  const sequences = []
  let eventNumber = 0
  let rowIndex = 0

  for (let si = 0; si < sizes.length; si += 1) {
    const members = rows.slice(rowIndex, rowIndex + sizes[si])
    rowIndex += sizes[si]
    const seqKey = `seq-${String(si + 1).padStart(2, '0')}`
    const firstText = String(members[0].sb.narration || '').trim()
    const title = `第${si + 1}组：${firstText.slice(0, 18)}${firstText.length > 18 ? '…' : ''}`
    const seqStart = members[0].startMs
    const seqEnd = members[members.length - 1].endMs

    const events = []
    const beats = []
    const panels = []
    const shots = []

    for (const row of members) {
      const sb = row.sb
      eventNumber += 1
      const padNum = String(eventNumber).padStart(3, '0')
      const eventKey = `evt-${padNum}`
      const beatKey = `beat-${padNum}`
      const panelKey = `sb-${sb.id}`
      const text = String(sb.narration || '').trim()

      events.push({ eventKey, eventIndex: eventNumber - 1, startMs: row.startMs, endMs: row.endMs, text })
      beats.push({
        beatKey,
        eventKey,
        kind: 'cut',
        startMs: row.startMs,
        endMs: row.endMs,
        description: text ? `叙事动作：${text.slice(0, 60)}` : '过渡镜头',
      })
      panels.push({ panelKey, beatKey, eventKey, description: text.slice(0, 100) || '过渡画面' })
      shots.push({
        shotKey: `shot-${padNum}`,
        eventKey,
        sourceKind: 'cut',
        sourceBeatKey: beatKey,
        description: `${(row.startMs / 1000).toFixed(1)}s–${(row.endMs / 1000).toFixed(1)}s`,
        startMs: row.startMs,
        endMs: row.endMs,
      })
    }

    sequences.push({ seqKey, title, startMs: seqStart, endMs: seqEnd, events, beats, panels, shots })
  }

  // import 前自检：beatCoverage == storyboardCount，且每个 beat 窗口完备
  const totalPanels = sequences.reduce((sum, seq) => sum + seq.panels.length, 0)
  if (totalPanels !== storyboards.length) {
    throw new Error(`plan self-check failed: panels ${totalPanels} != storyboards ${storyboards.length}`)
  }
  for (const seq of sequences) {
    for (const beat of seq.beats) {
      if (!Number.isFinite(beat.startMs) || !Number.isFinite(beat.endMs) || beat.endMs <= beat.startMs) {
        throw new Error(`plan self-check failed: beat ${beat.beatKey} has invalid window`)
      }
    }
  }

  return {
    kind: 'full',
    styleProfile,
    durationMs,
    timingSource: 'tts-time-begin-end',
    sourcePath,
    sequences,
  }
}

/* ===== BGM ===== */

function resolveStaticFile(urlPath) {
  if (!urlPath) return null
  const rel = String(urlPath).replace(/^\/+/, '')
  const abs = join(repoRoot, 'data', rel)
  return existsSync(abs) ? abs : null
}

function probeAudioDurationSec(absPath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    absPath,
  ], { encoding: 'utf8' })
  if (result.status !== 0) return null
  try {
    const duration = Number(JSON.parse(result.stdout)?.format?.duration)
    return Number.isFinite(duration) ? duration : null
  } catch {
    return null
  }
}

/* ===== 主流程 ===== */

async function main() {
  const options = parseArgs(process.argv.slice(2))

  // 0. 后端健康检查
  try {
    const resp = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) throw new Error(`status ${resp.status}`)
  } catch {
    failStep('health', `backend unreachable at ${baseUrl}`, '先启动后端：cd backend && npm run dev')
  }

  // 1. 稿件与 drama 前置检查
  const scriptPath = resolve(process.cwd(), options.script)
  if (!existsSync(scriptPath)) failStep('episode_import', `script file not found: ${scriptPath}`, '确认 --script 路径')
  const rawManuscript = readFileSync(scriptPath, 'utf8')
  let manuscript
  try {
    manuscript = extractConfirmedTitleAndBody(rawManuscript)
  } catch (error) {
    failStep('episode_import', error instanceof Error ? error.message : String(error),
      '使用 polish-video-script Step 12 写入合法的 title frontmatter')
  }
  const embeddedTitle = manuscript.title
  const optionTitle = typeof options.title === 'string' && options.title.trim() ? options.title.trim() : null
  if (embeddedTitle && optionTitle && embeddedTitle !== optionTitle) {
    failStep('episode_import', 'CLI --title does not match manuscript frontmatter title',
      '删除 --title，让已确认的文稿标题作为唯一来源')
  }
  const title = embeddedTitle || optionTitle
  if (!title) {
    failStep('episode_import', 'confirmed title frontmatter is required',
      '先运行 polish-video-script Step 12 并把用户确认的标题写入文稿')
  }
  let rawScript
  try {
    rawScript = assertSpokenBodyContract(manuscript.body)
  } catch (error) {
    failStep('episode_import', error instanceof Error ? error.message : String(error),
      '修复 05-final-script.md：frontmatter 之后只能保留纯口播正文，删除 Markdown 标题、流程标签和其他生产元数据后重跑')
  }
  const publishingPackagePath = resolvePublishingPackagePath(scriptPath, options.publishing_package)
  let publishingPackage
  try {
    publishingPackage = readPublishingPackage(publishingPackagePath, { expectedTitle: title })
  } catch (error) {
    failStep('episode_import', error instanceof Error ? error.message : String(error),
      '在最终稿同目录提供 07-publishing-package.json，或用 --publishing-package 显式指定；确认标题、双钩子和 cover_design 完整')
  }
  const normalizedScript = normalizeTtsText(rawScript)
  if (!normalizedScript) failStep('episode_import', 'script is empty after normalization', '确认稿件包含可朗读正文')

  const scriptSha = sha256(normalizedScript)
  const resolvedDrama = await resolveDramaForIntake({ options, title, scriptSha })
  const drama = resolvedDrama.drama
  const dramaId = resolvedDrama.dramaId
  if (!String(drama.style || '').trim()) {
    failStep('episode_import', `drama ${dramaId} style is empty`, '先锁定 dramas.style（读 references/visual-style-library.md 选有效历史视觉档案）')
  }

  // 2. episode：同稿件已导入则复用（幂等），否则 import-script
  const existingEpisode = resolvedDrama.existingEpisode || (drama.episodes || [])
    .filter((ep) => sha256(String(ep.script_content || ep.content || '')) === scriptSha)
    .sort((a, b) => b.episode_number - a.episode_number)[0]

  let episodeId
  let episode
  if (existingEpisode) {
    episodeId = existingEpisode.id
    episode = existingEpisode
    if (options.source_only && sha256(normalizeTtsText(String(episode.script_content || episode.content || ''))) !== scriptSha) {
      failStep('episode_import', 'target episode manuscript does not match the supplied script',
        '使用与已确认稿件一致的 episode；不要把不同稿件的配音和分镜交给 videoeditor')
    }
    let titleSync = false
    if (String(existingEpisode.title || '').trim() !== title) {
      const titleResult = await api('PUT', `/episodes/${episodeId}`, { title })
      if (!unwrap(titleResult)) {
        failStep('episode_import', apiErrorMessage(titleResult), '无法同步已存在 episode 的 confirmed title')
      }
      episode = unwrap(await api('GET', `/episodes/${episodeId}`)) || { ...existingEpisode, title }
      titleSync = true
    }
    const markerResult = await api('PUT', `/episodes/${episodeId}`, {
      history_factory: 'remotion-history-factory',
    })
    if (!unwrap(markerResult)) {
      failStep('episode_import', apiErrorMessage(markerResult), '无法写入 history factory 封面合同标记')
    }
    const packageResult = await api('PUT', `/episodes/${episodeId}`, {
      publishing_package: publishingPackage.package,
    })
    if (!unwrap(packageResult)) {
      failStep('episode_import', apiErrorMessage(packageResult), '无法把 publishing package 写入 episode 数据库')
    }
    episode = unwrap(await api('GET', `/episodes/${episodeId}`)) || episode
    reportStep('episode_import', 'skipped', {
      episode_id: episodeId,
      drama_id: dramaId,
      drama_created: resolvedDrama.dramaCreated,
      title: episode.title,
      title_source: embeddedTitle ? 'manuscript-frontmatter' : 'legacy-cli-override',
      title_sync: titleSync,
      publishing_package_sha256: publishingPackage.sha256,
      publishing_package_path: publishingPackage.path,
      reason: 'same script already imported',
    })
  } else {
    const importResult = await api('POST', `/dramas/${dramaId}/import-script`, {
      script_content: rawScript,
      title,
      skip_cover_generation: true,
      history_factory: 'remotion-history-factory',
    })
    const imported = unwrap(importResult)
    if (!imported || !imported.episodes?.length) {
      failStep('episode_import', apiErrorMessage(importResult), '检查 drama 状态与稿件内容')
    }
    episodeId = imported.episodes[0].id
    const readback = unwrap(await api('GET', `/episodes/${episodeId}`))
    episode = readback || imported.episodes[0]
    const packageResult = await api('PUT', `/episodes/${episodeId}`, {
      publishing_package: publishingPackage.package,
    })
    if (!unwrap(packageResult)) {
      failStep('episode_import', apiErrorMessage(packageResult), '无法把 publishing package 写入 episode 数据库')
    }
    reportStep('episode_import', 'done', {
      episode_id: episodeId,
      drama_id: dramaId,
      drama_created: resolvedDrama.dramaCreated,
      drama_title: drama.title,
      title: episode.title,
      title_source: embeddedTitle ? 'manuscript-frontmatter' : 'legacy-cli-override',
      publishing_package_sha256: publishingPackage.sha256,
      publishing_package_path: publishingPackage.path,
    })
  }

  // 3. 取消 import 自动调度的合同外任务（extractor 保留：后续 grid 阶段可用，不阻塞）
  const tasksResult = unwrap(await api('GET', `/tasks?episode_id=${episodeId}&active_only=true`))
  const cancelTypes = new Set(['cover.generate', 'hook.design', 'intro.compose', 'recap.compose'])
  const cancelledTaskIds = []
  for (const task of tasksResult || []) {
    const idem = String(task.idempotency_key || task.idempotencyKey || '')
    const isLlmBreaker = task.type === 'agent.run' && idem.startsWith('agent.run:storyboard_breaker:')
    if (!isLlmBreaker && !cancelTypes.has(task.type)) continue
    const cancelResult = await api('POST', `/tasks/${task.id}/cancel`, {
      reason: 'history-intake: LLM breaker replaced by deterministic break; out-of-contract generation skipped',
      actor: 'history_intake.mjs',
    })
    if (cancelResult.status === 200) cancelledTaskIds.push(task.id)
  }
  reportStep('neutralize_tasks', cancelledTaskIds.length ? 'done' : 'skipped', { cancelled_task_ids: cancelledTaskIds })

  if (options.retry_pre_tts) {
    try {
      const recovery = await retryFailedPreTts(episodeId)
      reportStep('pre_tts_recovery', recovery.requested ? 'done' : 'skipped', recovery)
    } catch (error) {
      failStep('pre_tts', error instanceof Error ? error.message : String(error),
        '保留原配音失败记录；先修复错误或等待本集已有制作任务退出，再用 --retry-pre-tts 重跑')
    }
  }

  // 4. 等 pre-TTS（import 后后端自动调度 tts.pre_generate；MiniMax API）
  const ttsDeadline = Date.now() + PRE_TTS_TIMEOUT_MS
  let titles = null
  while (Date.now() < ttsDeadline) {
    const ep = unwrap(await api('GET', `/episodes/${episodeId}`))
    if (ep) {
      episode = ep
      if (ep.pre_tts_audio_url && ep.pre_tts_titles_json) {
        try {
          const parsed = JSON.parse(ep.pre_tts_titles_json)
          if (Array.isArray(parsed) && parsed.length) titles = parsed
        } catch { /* titles 未就绪 */ }
      }
    }
    if (titles) break
    const ttsTasks = unwrap(await api('GET', `/tasks?episode_id=${episodeId}&type=tts.pre_generate`))
    const latest = (ttsTasks || []).sort((a, b) => b.id - a.id)[0]
    if (latest?.status === 'failed') {
      failStep('pre_tts', `tts.pre_generate failed: ${latest.error_message || latest.errorMessage || 'unknown'}`,
        '检查 MiniMax audio 配置、API key 与额度，修复后重跑本脚本')
    }
    await new Promise((r) => setTimeout(r, PRE_TTS_POLL_MS))
  }
  if (!titles) {
    failStep('pre_tts', `pre-TTS not ready within ${PRE_TTS_TIMEOUT_MS / 60000}min`, '查看 tts.pre_generate 任务状态与 MiniMax API 错误日志，修复后重跑本脚本')
  }
  reportStep('pre_tts', 'done', { title_count: titles.length, audio_url: episode.pre_tts_audio_url })

  // 5. 确定性拆分（script 原文为唯一真源，精确平铺 + ≤8s + 写前自检）
  const breakUrl = `/episodes/${episodeId}/storyboards:break-deterministic${options.force_break ? '?force=true' : ''}`
  const breakResult = await api('POST', breakUrl)
  const breakData = unwrap(breakResult)
  let storyboardCount
  if (breakData) {
    storyboardCount = breakData.storyboard_count
    reportStep('break', 'done', {
      storyboard_count: storyboardCount,
      total_chars: breakData.total_chars,
      script_chars: breakData.script_chars,
      coverage_verified: breakData.coverage_verified,
      max_duration_sec: breakData.max_duration_sec,
      cancelled_breaker_task_ids: breakData.cancelled_breaker_task_ids,
    })
  } else if (breakResult.status === 409 && breakResult.json?.data?.existingMatchesDeterministic) {
    storyboardCount = breakResult.json.data.existingStoryboards
    reportStep('break', 'skipped', { storyboard_count: storyboardCount, reason: 'existing storyboards match deterministic plan' })
  } else if (breakResult.status === 409) {
    failStep('break', apiErrorMessage(breakResult), '现有分镜与确定性结果不一致；人工确认后用 --force-break 重跑本脚本')
  } else {
    failStep('break', apiErrorMessage(breakResult), breakResult.json?.data?.direction || '检查 pre-TTS titles 与 script 是否一致')
  }

  if (options.source_only) {
    const source = await verifySourceReadiness({
      episodeId, dramaId, title, scriptSha, normalizedScript, publishingPackage, storyboardCount,
    })
    reportStep('source_check', source.ok ? 'done' : 'failed', { contract: source.contract })
    process.stdout.write(`${JSON.stringify({
      ok: source.ok,
      status: source.ok ? 'source-ready' : 'source-not-ready',
      episode_id: episodeId,
      drama_id: dramaId,
      storyboard_count: source.storyboardCount,
      pre_tts: source.contract.pre_tts,
      next_skill: source.ok ? 'videoeditor' : null,
      layout: 'full-frame',
      production_complete: false,
      contract: source.contract,
      steps: stepReports,
      ...(source.ok ? {} : { direction: '修复 source_check 未通过的回读合同后重跑；尚未进入素材生成或精细剪辑' }),
    })}\n`)
    process.exitCode = source.ok ? 0 : 1
    return
  }

  // 6. Remotion 项目（创建时后端复用"narration 精确覆盖"校验）
  const projectsResult = unwrap(await api('GET', `/remotion/projects?source_episode_id=${episodeId}`))
  let project = (projectsResult || []).find((p) => !(p.deleted_at ?? p.deletedAt ?? null))
  if (project) {
    reportStep('remotion_project', 'skipped', { project_id: project.id })
  } else {
    const createResult = await api('POST', '/remotion/projects', { episode_id: episodeId })
    const snapshot = unwrap(createResult)
    project = snapshot?.project || snapshot
    if (!project?.id) {
      failStep('remotion_project', apiErrorMessage(createResult), '确认 drama 绑定的媒体账号已配置 positioning（媒体账号页设置账号定位）；若报 narration 覆盖校验错误，先确保 deterministic break 通过')
    }
    reportStep('remotion_project', 'done', { project_id: project.id })
  }

  // 7. 叙事计划：DB 探测到真实计划且时长吻合则跳过，否则机械构建并 import（整体替换，幂等）
  const storyboardsResult = unwrap(await api('GET', `/episodes/${episodeId}/storyboards`))
  const storyboards = (storyboardsResult || []).sort((a, b) => a.storyboard_number - b.storyboard_number)
  if (!storyboards.length) failStep('narrative_plan', 'no storyboards after break', '先完成 deterministic break')

  const planOutputPath = join(repoRoot, 'scripts/history-notes', `episode-${episodeId}`, 'intake-narrative-plan.json')
  const planRelPath = `scripts/history-notes/episode-${episodeId}/intake-narrative-plan.json`
  const plan = buildNarrativePlan({
    titles,
    storyboards,
    styleProfile: String(drama.style),
    sourcePath: planRelPath,
  })

  const planStatus = readPlanStatusFromDb(episodeId)
  let planId = planStatus?.exists ? planStatus.planId : null
  if (
    planStatus?.exists
    && planStatus.timingSource
    && planStatus.timingSource !== 'storyboard_grid_fallback'
    && planStatus.durationMs != null
    && Math.abs(planStatus.durationMs - plan.durationMs) <= PLAN_SKIP_DURATION_TOLERANCE_MS
    && planStatus.beatCoverage === storyboards.length
  ) {
    reportStep('narrative_plan', 'skipped', { plan_id: planId, reason: 'real plan already imported' })
  } else {
    mkdirSync(dirname(planOutputPath), { recursive: true })
    writeFileSync(planOutputPath, `${JSON.stringify(plan, null, 2)}\n`)
    const importResult = await api('POST', `/remotion/projects/${project.id}/narrative-hierarchy/import`, plan)
    const imported = unwrap(importResult)
    if (!imported) {
      failStep('narrative_plan', apiErrorMessage(importResult), '检查 remotion project 与计划结构；计划已写入 ' + planRelPath)
    }
    planId = imported.planId ?? imported.plan_id ?? planId
    reportStep('narrative_plan', 'done', {
      plan_id: planId,
      sequences: plan.sequences.length,
      events: plan.sequences.reduce((sum, seq) => sum + seq.events.length, 0),
      panels: plan.sequences.reduce((sum, seq) => sum + seq.panels.length, 0),
      duration_ms: plan.durationMs,
    })
  }

  // 8. BGM：显式 > 已有 > 继承 drama 最近一集 > 报错
  let bgmUrl = options.bgm ? String(options.bgm).replace(/^\/+/, '') : null
  let bgmAction = 'done'
  if (bgmUrl && episode.bgm_audio_url === bgmUrl) bgmAction = 'skipped'
  if (!bgmUrl && episode.bgm_audio_url) {
    bgmUrl = episode.bgm_audio_url
    bgmAction = 'skipped'
  }
  let inheritedFrom = null
  if (!bgmUrl) {
    const donor = (drama.episodes || [])
      .filter((ep) => ep.id !== episodeId && ep.bgm_audio_url)
      .sort((a, b) => b.episode_number - a.episode_number)[0]
    if (!donor) {
      failStep('bgm', 'no bgm_audio_url and no donor episode in this drama',
        '把 ≥30s 成品轨放到 data/static/music/，然后用 --bgm static/music/<file> 重跑本脚本')
    }
    bgmUrl = donor.bgm_audio_url
    inheritedFrom = donor.id
  }
  if (bgmAction !== 'skipped') {
    const putResult = await api('PUT', `/episodes/${episodeId}`, { bgm_audio_url: bgmUrl })
    if (!unwrap(putResult)) failStep('bgm', apiErrorMessage(putResult), '检查 episode 状态后重跑')
  }
  // 实测文件与时长（合同要求 ≥30s）
  const bgmAbs = resolveStaticFile(bgmUrl)
  if (!bgmAbs) {
    failStep('bgm', `bgm file not found under data/: ${bgmUrl}`, '确认文件在 data/ 下且路径以 static/ 开头')
  }
  const bgmDurationSec = probeAudioDurationSec(bgmAbs)
  if (bgmDurationSec != null && bgmDurationSec < MIN_BGM_SEC) {
    failStep('bgm', `bgm duration ${bgmDurationSec.toFixed(1)}s < ${MIN_BGM_SEC}s`, '换一条 ≥30s 的成品轨（static/music/）后重跑')
  }
  reportStep('bgm', bgmAction, { bgm_audio_url: bgmUrl, inherited_from_episode: inheritedFrom, duration_sec: bgmDurationSec })

  // 9. 终检：合同 5 项
  const finalEpisode = unwrap(await api('GET', `/episodes/${episodeId}`)) || episode
  const finalPlanStatus = readPlanStatusFromDb(episodeId)
  const finalPackage = parseMetadata(finalEpisode.metadata)?.dharmaPublishing?.package
  const finalPackageSha256 = String(parseMetadata(finalEpisode.metadata)?.dharmaPublishing?.package_sha256 || '').trim()
  const contract = {
    publishing_package: {
      ok: Boolean(
        finalPackage
        && finalPackage.title === title
        && finalPackage.opening_hook === publishingPackage.package.opening_hook
        && finalPackage.cliffhanger === publishingPackage.package.cliffhanger
        && finalPackageSha256 === publishingPackage.sha256,
      ),
      title: finalPackage?.title || null,
      sha256: finalPackageSha256 || null,
      expected_sha256: publishingPackage.sha256,
    },
    episode_style: finalEpisode.workflow_type === 'direct_script' && !!String(drama.style || '').trim(),
    pre_tts: !!(finalEpisode.pre_tts_audio_url && finalEpisode.pre_tts_titles_json),
    narrative_plan: {
      ok: !!(finalPlanStatus?.exists && finalPlanStatus.timingSource && finalPlanStatus.timingSource !== 'storyboard_grid_fallback'
        && finalPlanStatus.beatCoverage === storyboards.length),
      plan_id: finalPlanStatus?.planId ?? planId ?? null,
      timing_source: finalPlanStatus?.timingSource ?? plan.timingSource,
      beat_coverage: finalPlanStatus?.beatCoverage ?? storyboards.length,
      storyboard_count: storyboards.length,
    },
    bgm: {
      ok: !!(finalEpisode.bgm_audio_url && (bgmDurationSec == null || bgmDurationSec >= MIN_BGM_SEC)),
      url: finalEpisode.bgm_audio_url,
      duration_sec: bgmDurationSec,
    },
  }
  const ok = contract.publishing_package.ok && contract.episode_style && contract.pre_tts && contract.narrative_plan.ok && contract.bgm.ok

  logLine(`contract[1] publishing package (${contract.publishing_package.sha256 || 'missing'}): ${contract.publishing_package.ok ? 'OK' : 'FAIL'}`)
  logLine(`contract[2] episode+style(direct_script, ${drama.style}): ${contract.episode_style ? 'OK' : 'FAIL'}`)
  logLine(`contract[3] pre-TTS master (audio + ${titles.length} titles): ${contract.pre_tts ? 'OK' : 'FAIL'}`)
  logLine(`contract[4] narrative plan (kind=full, timing=${contract.narrative_plan.timing_source}, beats ${contract.narrative_plan.beat_coverage}/${contract.narrative_plan.storyboard_count}): ${contract.narrative_plan.ok ? 'OK' : 'FAIL'}`)
  logLine(`contract[5] bgm (${contract.bgm.url}, ${bgmDurationSec == null ? 'unverified' : `${bgmDurationSec.toFixed(1)}s`}): ${contract.bgm.ok ? 'OK' : 'FAIL'}`)

  process.stdout.write(`${JSON.stringify({
    ok,
    episode_id: episodeId,
    drama_id: dramaId,
    project_id: project.id,
    plan_id: contract.narrative_plan.plan_id,
    storyboard_count: storyboards.length,
    contract,
    steps: stepReports,
  })}\n`)
  process.exit(ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    failStep('unexpected', error instanceof Error ? error.message : String(error), '保留输出并检查 intake 脚本输入与后端日志')
  })
}

export {
  assertSpokenBodyContract,
  extractConfirmedTitleAndBody,
  findSpokenBodyViolation,
  findExistingDramaByScript,
  normalizeTtsText,
  parseArgs,
  resolveDramaForIntake,
  retryFailedPreTts,
}
