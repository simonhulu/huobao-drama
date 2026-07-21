#!/usr/bin/env node
/**
 * Persist the clean output of polish-video-script into cheat-on-content's
 * canonical scripts/ directory.
 *
 * Usage:
 *   node tools/persist-polished-script.mjs \
 *     --input /tmp/polished.txt \
 *     --title "大礼议" \
 *     [--notes /tmp/polished-notes.md] \
 *     [--date 2026-07-13] \
 *     [--root /path/to/project]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`不支持的位置参数：${argument}`)
    const key = argument.slice(2)
    if (!['input', 'title', 'notes', 'date', 'root'].includes(key)) {
      throw new Error(`不支持的参数：${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少值`)
    options[key] = value
    index += 1
  }
  if (!options.input) throw new Error('必须提供 --input')
  if (!options.title) throw new Error('必须提供 --title')
  return options
}

function resolveFromRoot(root, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
}

function normalizeScript(content) {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!normalized) throw new Error('口播正文为空，未写入 scripts/')
  return `${normalized}\n`
}

export function slugifyTitle(title) {
  const safe = String(title)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
  return [...safe].slice(0, 8).join('') || '口播稿'
}

function localDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日期格式必须是 YYYY-MM-DD：${value}`)
  return value
}

export function persistPolishedScript({ input, title, notes = '', date = localDate(), root = process.cwd() }) {
  const projectRoot = path.resolve(root)
  const inputPath = resolveFromRoot(projectRoot, input)
  if (!fs.existsSync(inputPath)) throw new Error(`找不到口播正文：${inputPath}`)

  const content = normalizeScript(fs.readFileSync(inputPath, 'utf8'))
  const id = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12)
  const datePart = validateDate(date)
  const slug = slugifyTitle(title)
  const scriptsDir = path.join(projectRoot, 'scripts')
  const scriptPath = path.join(scriptsDir, `${datePart}_${id}_${slug}.md`)
  fs.mkdirSync(scriptsDir, { recursive: true })

  if (path.resolve(inputPath) !== path.resolve(scriptPath)) {
    fs.writeFileSync(scriptPath, content, 'utf8')
  }

  let notesPath = null
  if (notes) {
    const notesInputPath = resolveFromRoot(projectRoot, notes)
    if (!fs.existsSync(notesInputPath)) throw new Error(`找不到编辑 notes：${notesInputPath}`)
    const notesDir = path.join(scriptsDir, 'polish-notes')
    notesPath = path.join(notesDir, `${datePart}_${id}_${slug}-notes.md`)
    fs.mkdirSync(notesDir, { recursive: true })
    if (path.resolve(notesInputPath) !== path.resolve(notesPath)) {
      fs.copyFileSync(notesInputPath, notesPath)
    }
  }

  return {
    scriptPath: path.relative(projectRoot, scriptPath),
    notesPath: notesPath ? path.relative(projectRoot, notesPath) : null,
    articleId: id,
    scriptHash: `sha256:${id}`,
    title: String(title),
    date: datePart,
    characters: [...content.replace(/\n/g, '')].length,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = persistPolishedScript(options)
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  } catch (error) {
    console.error(`[persist-polished-script] ${error.message || error}`)
    process.exitCode = 1
  }
}
