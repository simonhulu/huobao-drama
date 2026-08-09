#!/usr/bin/env node
/**
 * GridStoryPreview 渲染 props 的旁白/画面/字幕同步独立校验器。
 *
 * 契约（v8 Authoritative Timing Contract）：每个 Shot 的 startFrame/durationInFrames
 * 必须等于其 Beat 权威窗口（storyboard_panels 'sb-{id}'[-pN] -> visual_beats.start_ms/end_ms）
 * 换算的绝对帧（±1 帧取整容差），且相对首个 Shot 的起点做 0 帧重基。
 * 任何按字数比例估算/累计堆叠出来的 props 都会在这里失败。
 *
 * 用法：
 *   node scripts/videoeditor/check_grid_story_sync.mjs <episodeId> [propsPath] [--fps=30]
 * 默认 propsPath = data/static/temp/grid-story-props-<episodeId>.json
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
  console.error('usage: check_grid_story_sync.mjs <episodeId> [propsPath] [--fps=30]')
  process.exit(1)
}
const fpsArg = args.find((a) => a.startsWith('--fps='))
const fps = fpsArg ? Number(fpsArg.slice(6)) : 30
const allowPartial = args.includes('--allow-partial') // pilot 试渲染：镜头数少于整集属预期
const propsPath =
  args[1] && !args[1].startsWith('--')
    ? path.resolve(args[1])
    : path.join(repoRoot, 'data/static/temp', `grid-story-props-${episodeId}.json`)

const normLen = (s) => (s || '').replace(/\s+/g, '')

const db = new Database(path.join(repoRoot, 'data/huobao_drama.db'), { readonly: true })

// 1) 权威窗口：kind='full' 计划 -> panels -> beats
const plan = db
  .prepare(`SELECT id FROM narrative_plans WHERE episode_id = ? AND kind = 'full'`)
  .get(episodeId)
if (!plan) {
  console.error(`FAIL: episode ${episodeId} 没有 kind='full' 叙事计划`)
  process.exit(1)
}
const rows = db
  .prepare(
    `SELECT p.panel_key AS panelKey, vb.start_ms AS startMs, vb.end_ms AS endMs
     FROM storyboard_panels p JOIN visual_beats vb ON vb.id = p.beat_id
     WHERE p.plan_id = ?`,
  )
  .all(plan.id)
const beatByStoryboard = new Map()
for (const row of rows) {
  const m = /^sb-(\d+)(?:-p\d+)?$/.exec(row.panelKey)
  if (!m) {
    console.error(`FAIL: 无法识别的 panel_key「${row.panelKey}」`)
    process.exit(1)
  }
  const id = Number(m[1])
  const prev = beatByStoryboard.get(id)
  beatByStoryboard.set(
    id,
    prev
      ? { startMs: Math.min(prev.startMs, row.startMs), endMs: Math.max(prev.endMs, row.endMs) }
      : { startMs: row.startMs, endMs: row.endMs },
  )
}

// 2) 期望的镜头序列：按 storyboard_number 排序，复刻「可发射」判定（缺图镜头不进 props）
const storyboards = db
  .prepare(`SELECT id, storyboard_number AS num, narration, description, grid_cells AS gridCells
            FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number`)
  .all(episodeId)
const expected = []
for (const sb of storyboards) {
  let parsed = null
  try {
    const raw = sb.gridCells ? JSON.parse(sb.gridCells) : null
    if ([1, 2].includes(raw?.cells?.length) && raw.cells.every((c) => c?.src)) parsed = raw
  } catch {
    /* not emittable */
  }
  if (!parsed) continue
  const win = beatByStoryboard.get(sb.id)
  if (!win) {
    console.error(`FAIL: storyboard #${sb.num} (id ${sb.id}) 缺 Beat 权威窗口`)
    process.exit(1)
  }
  expected.push({
    num: sb.num,
    narration: normLen(sb.narration || sb.description),
    absStartFrame: Math.round((win.startMs / 1000) * fps),
    absEndFrame: Math.max(Math.round((win.startMs / 1000) * fps) + 1, Math.round((win.endMs / 1000) * fps)),
  })
}

// 3) 读取 props 并逐镜比对（渲染以首个 Shot 为 0 帧重基）
if (!fs.existsSync(propsPath)) {
  console.error(`FAIL: props 不存在: ${propsPath}`)
  process.exit(1)
}
const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'))
const shots = props.shots || []
if (!props.audio) {
  console.error('FAIL: props 缺整集 narration 主音轨 audio')
  process.exit(1)
}
const baseFrame = expected.length ? expected[0].absStartFrame : 0

let violations = 0
const n = Math.min(shots.length, expected.length)
for (let i = 0; i < n; i++) {
  const exp = expected[i]
  const got = shots[i]
  const wantStart = exp.absStartFrame - baseFrame
  const wantDur = exp.absEndFrame - exp.absStartFrame
  const problems = []
  if (typeof got.startFrame !== 'number') problems.push('缺 startFrame（累计堆叠式旧 props）')
  else if (Math.abs(got.startFrame - wantStart) > 1) problems.push(`startFrame ${got.startFrame} != ${wantStart}`)
  if (Math.abs(got.durationInFrames - wantDur) > 1) problems.push(`durationInFrames ${got.durationInFrames} != ${wantDur}`)
  if (exp.narration && normLen(got.narration) !== exp.narration) problems.push('narration 文本不一致（镜头顺序错位？）')
  if (problems.length) {
    violations += 1
    console.error(`MISMATCH shot#${i} (storyboard #${exp.num}): ${problems.join('；')}`)
  }
}
if (shots.length !== expected.length) {
  if (allowPartial && shots.length < expected.length) {
    console.log(`NOTE: 部分渲染（pilot）：props ${shots.length} 镜 < 整集 ${expected.length} 镜，仅比对前 ${n} 镜`)
  } else {
    violations += 1
    console.error(`MISMATCH shot 数量: props ${shots.length} != 期望 ${expected.length}`)
  }
}
const total = shots.reduce((a, s) => Math.max(a, (s.startFrame || 0) + s.durationInFrames), 0)
if (total !== props.durationInFrames) {
  violations += 1
  console.error(`MISMATCH 总帧数: 声明 ${props.durationInFrames} != 实际末镜结束 ${total}`)
}

if (violations) {
  console.error(`\nFAIL: ${violations} 处违规（${n} 镜受检，fps=${fps}）`)
  process.exit(1)
}
console.log(`PASS: ${n} 镜全部命中 Beat 权威窗口（±1 帧），主音轨在位，总帧数一致（${(total / fps).toFixed(2)}s）`)
