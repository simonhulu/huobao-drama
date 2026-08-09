#!/usr/bin/env node

/**
 * 为 episode 791（清朝人口为何暴涨四亿）生成叙事层级计划并写库。
 * 依据 build_ep790_narrative_plan.mjs 的成熟模式：
 *  - 序列对应脚本编辑段落；
 *  - 每个分镜一个 cut beat + panel，panel_key = sb-<id>；
 *  - beat 窗口用「分镜旁白 → TTS 标题流字符定位插值」对齐 titles 时间轴；
 *  - 每个分镜必须有 panel，保证 beat 覆盖 == 分镜数。
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(root, 'backend/package.json'))
const Database = require('better-sqlite3')

const EPISODE_ID = 791
const STYLE_PROFILE = 'historical_systems'
const OUTPUT = path.join(root, 'data/temp/episode-791-narrative-plan.json')
const SCRIPT_PATH = path.join(root, 'scripts/2026-08-02_61811bc3b03d_清朝人口为何暴涨四亿.md')
const API_BASE = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '')

function normalize(s) {
  return (s || '').replace(/[\s\n\r​-‏﻿]/g, '').replace(/[，。！？、；：""''（）—…·《》〈〉「」『』]/g, '')
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
  const project = db.prepare(
    'SELECT id FROM remotion_projects WHERE source_episode_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
  ).get(EPISODE_ID)
  db.close()

  const fs = require('node:fs')
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8').trim()
  const paragraphs = script.split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean)
  console.log(`Loaded ${titles.length} titles, ${storyboards.length} storyboards, ${paragraphs.length} paragraphs, project=${project?.id ?? 'MISSING'}`)
  return { titles, storyboards, paragraphs, projectId: project?.id ?? null }
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

function buildPlan({ titles, storyboards, paragraphs }) {
  const { stream, timeAt, durationMs } = buildTimeline(titles)
  const paraTexts = paragraphs.map((p) => normalize(p))

  const rows = []
  let cursor = 0
  for (const sb of storyboards) {
    const text = normalize(sb.narration)
    if (!text) {
      rows.push({ sb, startMs: null, endMs: null, paraIndex: null })
      continue
    }
    let idx = stream.indexOf(text, cursor)
    if (idx < 0) idx = stream.indexOf(text)
    let startMs, endMs, paraIndex
    if (idx < 0) {
      console.warn(`分镜 #${sb.storyboard_number} 不在 TTS 流中："${(sb.narration || '').slice(0, 40)}"，用邻近估算`)
      startMs = null
      endMs = null
      paraIndex = null
    } else {
      startMs = timeAt(idx)
      endMs = timeAt(idx + text.length)
      paraIndex = paraTexts.findIndex((p) => p.includes(text))
      cursor = idx + text.length
    }
    rows.push({ sb, startMs, endMs, paraIndex })
  }

  const paraMembers = paragraphs.map(() => [])
  let lastAssigned = 0
  for (const row of rows) {
    let pi = row.paraIndex
    if (pi == null || pi < 0) pi = lastAssigned
    if (pi >= paraMembers.length) pi = paraMembers.length - 1
    paraMembers[pi].push(row)
    lastAssigned = pi
  }

  const sequences = []
  let eventNumber = 0

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const members = paraMembers[pi].filter((r) => r.sb)
    if (!members.length) {
      console.warn(`Sequence para ${pi + 1} 没有分镜，跳过`)
      continue
    }
    const seqKey = `seq-${String(pi + 1).padStart(2, '0')}`
    const para = paragraphs[pi]
    const title = `第${pi + 1}段：${para.slice(0, 18)}${para.length > 18 ? '…' : ''}`

    const firstRow = members[0]
    const lastRow = members[members.length - 1]
    const seqStart = firstRow.startMs ?? firstRow.endMs ?? 0
    const seqEnd = lastRow.endMs ?? lastRow.startMs ?? durationMs

    const events = []
    const beats = []
    const panels = []
    const shots = []

    for (const row of members) {
      const sb = row.sb
      let w = { startMs: row.startMs, endMs: row.endMs }
      if (w.startMs == null || w.endMs == null) {
        const prev = beats[beats.length - 1]
        w = prev
          ? { startMs: prev.endMs, endMs: prev.endMs + (sb.duration || 0) * 1000 }
          : { startMs: seqStart, endMs: seqStart + (sb.duration || 0) * 1000 }
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

async function importPlan(plan, projectId) {
  if (!projectId) throw new Error('episode 没有 Remotion 项目，先创建项目再导入计划')
  const url = `${API_BASE}/api/v1/remotion/projects/${projectId}/narrative-hierarchy/import`
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
  console.log(`Building plan for episode ${EPISODE_ID}`)
  const inputs = loadInputs()
  const plan = buildPlan(inputs)
  writeFileSync(OUTPUT, JSON.stringify(plan, null, 2))
  console.log(`Plan written to ${OUTPUT}`)
  console.log(`Sequences: ${plan.sequences.length}`)
  const totalEvents = plan.sequences.reduce((s, seq) => s + seq.events.length, 0)
  console.log(`Events: ${totalEvents}`)
  console.log(`Duration: ${(plan.durationMs / 1000).toFixed(1)}s`)

  if (!dryRun) {
    const result = await importPlan(plan, inputs.projectId)
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

main()
