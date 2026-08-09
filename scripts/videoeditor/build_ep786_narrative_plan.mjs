#!/usr/bin/env node

/**
 * 为 episode 786（满族饭票塌房辞退）生成叙事层级计划并写库。
 * 依据 build_ep785_narrative_plan.mjs 的成熟模式：
 *  - 序列对应脚本 15 个编辑段落（段1/15 … 段15/15）；
 *  - 每个分镜一个 cut beat + panel，panel_key = sb-<id>；
 *  - beat 窗口用「分镜旁白 → TTS 标题流字符定位插值」对齐 titles 时间轴。
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(root, 'backend/package.json'))
const Database = require('better-sqlite3')

const EPISODE_ID = 786
const REMOTION_PROJECT_ID = Number(process.env.REMOTION_PROJECT_ID || 0)
const STYLE_PROFILE = 'japanese_cel_animation_twilight'
const OUTPUT = path.join(root, 'data/temp/episode-786-narrative-plan.json')
const API_BASE = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '')

if (!REMOTION_PROJECT_ID) {
  console.error('REMOTION_PROJECT_ID is required')
  process.exit(1)
}

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

// 15 个叙事序列对应脚本 15 个编辑段落。由脚本段首句在 TTS 流中的定位自动划分，
// 无需硬编码 storyboard_number 范围，避免 breaker 分镜数波动时失效。
const segmentOpeners = [
  '1924年，北京把最后一笔旗饷停了',   // 段1：三百年饭票作废
  '满族人不种地、不做工、不学手艺',     // 段2：铁杆庄稼/雇员
  '1912年，清帝退位',               // 段3：承诺与断饷塌房
  '断饷，是断了命',                 // 段4：断饷断命/藏身份
  '藏身份，第一步是改姓',            // 段5：改姓（程砚秋）
  '改姓还不够，连习俗一起藏',         // 段6：藏习俗/家谱
  '说出来的代价是什么',              // 段7：说出来的代价
  '到这儿，先把账摆平',              // 段8：在档者旗/销除旗档
  '清廷自己，早就在裁员',            // 段9：出旗为民
  '正红旗护军，舒永寿',              // 段10：舒永寿/老舍
  '每一任政权，都在给',              // 段11：东北改报
  '1953年，普查员挨家挨户敲门',       // 段12：1953 普查
  '1982年，一纸通知下来',            // 段13：1982 恢复
  '算总账',                        // 段14：算总账 1990
  '我们回头，看看那个最忠诚的雇员',    // 段15：回头收束
]

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

  // 按段首句给每个分镜归属序列
  const seqForSb = new Map()
  let currentSeq = 0
  for (const sb of storyboards) {
    const text = String(sb.narration || '')
    for (let si = currentSeq; si < segmentOpeners.length; si++) {
      if (text.includes(segmentOpeners[si])) {
        currentSeq = si
        break
      }
    }
    seqForSb.set(sb.storyboard_number, currentSeq)
  }

  const sequences = []
  let eventNumber = 0

  for (let si = 0; si < segmentOpeners.length; si++) {
    const members = storyboards.filter((sb) => seqForSb.get(sb.storyboard_number) === si)
    if (!members.length) {
      console.warn(`Sequence #${si + 1} 没有分镜，跳过`)
      continue
    }
    const seqKey = `seq-${String(si + 1).padStart(2, '0')}`
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
      sequences.push({ seqKey, title: `第${si + 1}段：${segmentOpeners[si]}…`, startMs: seqStart, endMs: seqEnd, events, beats, panels, shots })
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
