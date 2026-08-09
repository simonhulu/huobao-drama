#!/usr/bin/env node

/**
 * 为 episode 768（圆明园毁损罪魁真相）生成叙事层级计划并写库。
 * 依据 build_ep659_narrative_plan.mjs 的成熟模式：
 *  - 序列对应脚本编辑段落（10 段 → 10 序列）；
 *  - 每个分镜一个 cut beat + panel，panel_key = sb-<id>；
 *  - beat 窗口用「分镜旁白 → TTS 标题流字符定位插值」对齐 titles 时间轴。
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(root, 'backend/package.json'))
const Database = require('better-sqlite3')

const EPISODE_ID = 768
const REMOTION_PROJECT_ID = 20
const STYLE_PROFILE = 'historical_systems'
const OUTPUT = path.join(root, 'data/temp/episode-768-narrative-plan.json')
const API_BASE = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '')

// 10 个叙事序列对应脚本的 10 个编辑段落（由段落首句在分镜旁白中的定位推得）
const sequenceSpecs = [
  ['seq-01-hotsearch-misattribution', '热搜错位：账不该记在日本人头上', 1, 7],
  ['seq-02-private-garden',           '皇帝的私园：万园之园不是老百姓的', 8, 13],
  ['seq-03-empty-gate-1860',          '1860：门开着没人守，文丰投水', 14, 21],
  ['seq-04-for-39-men',               '为了39个人：使节之死与天子的架子', 22, 36],
  ['seq-05-fire-cannot-burn-stone',   '火烧不掉石头地基', 37, 45],
  ['seq-06-decades-of-removal',       '一百年被搬没的园子', 46, 58],
  ['seq-07-new-china-guardian',       '新中国：周恩来要保护，文革毁尽', 59, 65],
  ['seq-08-the-locals',               '本地人不是汉奸：活命不是卖国', 66, 82],
  ['seq-09-the-ledger',               '账该记在谁头上', 83, 91],
  ['seq-10-cow-and-villa',            '牛马与别墅：那是他的园子，不是你的', 92, 95],
]

function normalize(s) {
  return (s || '').replace(/[\s\n\r​-‏﻿]/g, '').replace(/[，。！？、；：""''（）—…·]/g, '')
}

function loadInputs() {
  const db = new Database(path.join(root, 'data/huobao_drama.db'), { readonly: true })
  const ep = db.prepare('SELECT id, pre_tts_titles_json FROM episodes WHERE id = ?').get(EPISODE_ID)
  if (!ep?.pre_tts_titles_json) throw new Error(`episode ${EPISODE_ID} 缺少 pre_tts_titles_json`)
  const titles = JSON.parse(ep.pre_tts_titles_json)
  const storyboards = db.prepare(
    'SELECT id, storyboard_number, narration, duration FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number',
  ).all(EPISODE_ID)
  if (!storyboards.length) throw new Error(`episode ${EPISODE_ID} 没有分镜`)
  console.log(`Loaded ${titles.length} titles, ${storyboards.length} storyboards`)
  db.close()
  return { titles, storyboards }
}

function buildTimeline(titles) {
  let stream = ''
  const spans = []
  for (const t of titles) {
    const text = normalize(t.text)
    spans.push({ startChar: stream.length, endChar: stream.length + text.length, startMs: t.time_begin, endMs: t.time_end })
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
  return { stream, spans, timeAt, durationMs: Math.round(spans[spans.length - 1].endMs) }
}

function buildPlan({ titles, storyboards }) {
  const { stream, timeAt, durationMs } = buildTimeline(titles)

  let cursor = 0
  const windows = new Map()
  for (const sb of storyboards) {
    const text = normalize(sb.narration)
    if (!text) {
      const prevWindow = windows.get(sb.storyboard_number - 1)
      if (prevWindow) {
        windows.set(sb.storyboard_number, { startMs: prevWindow.endMs, endMs: prevWindow.endMs + (sb.duration || 0) * 1000 })
      }
      continue
    }
    let idx = stream.indexOf(text, cursor)
    if (idx < 0) idx = stream.indexOf(text)
    if (idx < 0) {
      console.warn(`分镜 #${sb.storyboard_number} 不在 TTS 流中："${(sb.narration || '').slice(0, 40)}"，使用邻近估算`)
      const prevWindow = windows.get(sb.storyboard_number - 1)
      if (prevWindow) {
        windows.set(sb.storyboard_number, { startMs: prevWindow.endMs, endMs: prevWindow.endMs + (sb.duration || 0) * 1000 })
      }
      continue
    }
    windows.set(sb.storyboard_number, { startMs: timeAt(idx), endMs: timeAt(idx + text.length) })
    cursor = idx + text.length
  }

  const sequences = []
  let eventNumber = 0

  for (const [seqKey, title, fromNum, toNum] of sequenceSpecs) {
    const members = storyboards.filter((sb) => sb.storyboard_number >= fromNum && sb.storyboard_number <= toNum)
    if (!members.length) {
      console.warn(`Sequence ${seqKey} 没有分镜，跳过`)
      continue
    }

    const firstWin = windows.get(members[0].storyboard_number)
    const lastWin = windows.get(members[members.length - 1].storyboard_number)
    const seqStart = firstWin?.startMs ?? 0
    const seqEnd = lastWin?.endMs ?? durationMs

    const events = []
    const beats = []
    const panels = []
    const shots = []

    for (const sb of members) {
      let w = windows.get(sb.storyboard_number)
      if (!w) {
        const prevWin = windows.get(sb.storyboard_number - 1)
        if (prevWin) {
          w = { startMs: prevWin.endMs, endMs: prevWin.endMs + (sb.duration || 0) * 1000 }
        } else {
          w = { startMs: 0, endMs: (sb.duration || 0) * 1000 }
        }
      }

      eventNumber += 1
      const padNum = String(eventNumber).padStart(3, '0')
      const eventKey = `evt-${padNum}`
      const beatKey = `beat-${padNum}`
      const panelKey = `sb-${sb.id}`
      const text = String(sb.narration || '').trim()

      events.push({ eventKey, eventIndex: eventNumber - 1, startMs: w.startMs, endMs: w.endMs, text })
      beats.push({
        beatKey,
        eventKey,
        kind: 'cut',
        startMs: w.startMs,
        endMs: w.endMs,
        description: text ? `叙事动作：${text.slice(0, 60)}` : '过渡镜头',
      })
      panels.push({ panelKey, beatKey, eventKey, description: text.slice(0, 100) || '过渡画面' })
      shots.push({
        shotKey: `shot-${padNum}`,
        eventKey,
        sourceKind: 'cut',
        sourceBeatKey: beatKey,
        description: `${(w.startMs / 1000).toFixed(1)}s–${(w.endMs / 1000).toFixed(1)}s`,
        startMs: w.startMs,
        endMs: w.endMs,
      })
    }

    if (events.length > 0) {
      sequences.push({ seqKey, title, startMs: seqStart, endMs: seqEnd, events, beats, panels, shots })
    }
  }

  const mappedBoards = new Set()
  for (const seq of sequences) {
    for (const p of seq.panels) {
      const match = p.panelKey?.match(/^sb-(\d+)/)
      if (match) mappedBoards.add(Number(match[1]))
    }
  }
  console.log(`Mapped ${mappedBoards.size}/${storyboards.length} storyboards to timeline`)

  const unmapped = storyboards.filter((sb) => !mappedBoards.has(sb.id))
  if (unmapped.length > 0) {
    console.warn(`⚠ ${unmapped.length} unmapped storyboards: ${unmapped.map((s) => `#${s.storyboard_number}`).join(', ')}`)
  }

  return {
    kind: 'full',
    styleProfile: STYLE_PROFILE,
    durationMs,
    timingSource: 'tts-time-begin-end',
    sourcePath: path.relative(root, OUTPUT),
    sequences,
  }
}

async function importPlan(plan) {
  const url = `${API_BASE}/api/v1/remotion/projects/${REMOTION_PROJECT_ID}/narrative-hierarchy/import`
  console.log(`POST ${url}`)
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan),
  })
  const body = await resp.json()
  console.log('Import response:', JSON.stringify(body, null, 2))
  return body
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  console.log(`Building plan for episode ${EPISODE_ID}, project ${REMOTION_PROJECT_ID}`)
  const inputs = loadInputs()
  const plan = buildPlan(inputs)
  writeFileSync(OUTPUT, JSON.stringify(plan, null, 2))
  console.log(`Plan written to ${OUTPUT}`)
  console.log(`Sequences: ${plan.sequences.length}`)
  const totalEvents = plan.sequences.reduce((s, seq) => s + seq.events.length, 0)
  console.log(`Events: ${totalEvents}`)
  console.log(`Duration: ${(plan.durationMs / 1000).toFixed(1)}s`)

  if (!dryRun) {
    const result = await importPlan(plan)
    if (result.code === 200 || result.code === 201) {
      console.log('✅ Narrative plan imported successfully')
    } else {
      console.error('❌ Import failed:', result.message || result.code)
      process.exit(1)
    }
  } else {
    console.log('Dry run — skipping import')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
