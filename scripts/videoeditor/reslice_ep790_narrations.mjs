#!/usr/bin/env node

/**
 * 把 episode 790 的 source 原文按句子重新切片，分配给全部 storyboard，
 * 保证 narration 片段按顺序精确覆盖 source（无缺口、无重叠）。
 * 这是 direct_script/verbatim 语义下逐镜头 TTS 原文切片，旁白与画面天然对齐。
 */

import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(root, 'backend/package.json'))
const Database = require('better-sqlite3')

const EPISODE_ID = 790

function splitSentences(text) {
  const major = text
    .replace(/([。！？；\.\!\?\;])/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const result = []
  const maxChars = 300
  for (const s of major) {
    if (s.length <= maxChars) {
      result.push(s)
      continue
    }
    let remaining = s
    while (remaining.length > maxChars) {
      let cutAt = remaining.lastIndexOf('，', maxChars)
      if (cutAt < maxChars / 2) cutAt = remaining.lastIndexOf('、', maxChars)
      if (cutAt < maxChars / 2) cutAt = remaining.lastIndexOf('；', maxChars)
      if (cutAt < maxChars / 2) cutAt = remaining.lastIndexOf(',', maxChars)
      if (cutAt < maxChars / 2) cutAt = maxChars
      result.push(remaining.slice(0, cutAt).trim())
      remaining = remaining.slice(cutAt).trim()
    }
    if (remaining) result.push(remaining)
  }
  return result
}

function main() {
  const db = new Database(path.join(root, 'data/huobao_drama.db'))
  const ep = db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(EPISODE_ID)
  const source = String(ep.script_content || '').trim()
  if (!source) throw new Error(`episode ${EPISODE_ID} has no script_content`)

  const sbs = db.prepare(
    'SELECT id, storyboard_number FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number',
  ).all(EPISODE_ID)
  if (!sbs.length) throw new Error(`episode ${EPISODE_ID} has no storyboards`)

  const sentences = splitSentences(source)
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0)
  const target = totalChars / sbs.length

  // 按句均分到 shot（保留句边界，近似等长），并保证每个 shot 至少 1 句
  const chunks = []
  let current = []
  let currentChars = 0
  const N = sbs.length
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]
    const remainingSentences = sentences.length - i
    const remainingShots = N - chunks.length
    // 剩余句数必须足够给剩余 shot 各分 1 句
    const mustFlush = remainingSentences === remainingShots
    const pastTarget = currentChars > 0 && currentChars + sentence.length > target * 1.2
    if (chunks.length < N - 1 && current.length > 0 && (pastTarget || mustFlush)) {
      chunks.push(current.join(''))
      current = [sentence]
      currentChars = sentence.length
    } else {
      current.push(sentence)
      currentChars += sentence.length
    }
  }
  if (current.length > 0) chunks.push(current.join(''))

  if (chunks.length > N) {
    const overflow = chunks.slice(N)
    chunks[N - 1] = chunks[N - 1] + overflow.join('')
    chunks.length = N
  }
  while (chunks.length < N) chunks.push('')

  const emptyIdx = chunks.map((c, i) => (c ? null : i)).filter((i) => i != null)
  if (emptyIdx.length) {
    console.error(`仍有 ${emptyIdx.length} 个空 shot: ${emptyIdx.join(', ')}`)
    process.exit(1)
  }

  // 校验：按顺序拼接后必须与 source 一致（normalize 空白后）
  const joined = chunks.join('')
  const norm = (s) => (s || '').replace(/[\s\n\r​-‍‎‏﻿]/g, '')
  if (norm(joined) !== norm(source)) {
    console.error(`覆盖校验失败：normalized joined len=${norm(joined).length}, source len=${norm(source).length}`)
    process.exit(1)
  }

  const ts = new Date().toISOString()
  const update = db.prepare('UPDATE storyboards SET narration = ?, updated_at = ? WHERE id = ?')
  for (let i = 0; i < sbs.length; i++) {
    update.run(chunks[i], ts, sbs[i].id)
  }
  console.log(`Re-sliced ${sbs.length} storyboards; joined len=${joined.length}; chunks=${chunks.length}`)
  db.close()
}

main()
