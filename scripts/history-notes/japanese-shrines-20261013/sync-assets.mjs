import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '../../..')
const workDir = path.join(root, 'data/temp/japanese-shrines-20261013')
const sourcePath = path.join(workDir, 'source.json')
const outputDir = path.join(workDir, 'images')
const ledgerPath = path.join(workDir, 'asset-ledger.json')
const dbPath = path.join(root, 'data/huobao_drama.db')
const PROVIDER = 'gpt-image2'
const MODEL = 'gpt-image-2.5-flare'

const requireFromRoot = createRequire(path.join(root, 'backend/package.json'))
const Database = requireFromRoot('better-sqlite3')

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const storyboards = source.storyboards.slice().sort((a, b) => a.storyboardNumber - b.storyboardNumber)
const ids = storyboards.map((shot) => shot.id)
const db = new Database(dbPath, { readonly: true })
const placeholders = ids.map(() => '?').join(',')
const rows = db.prepare(`
  SELECT id, storyboard_id, task_id, provider, model, status, local_path, updated_at
  FROM image_generations
  WHERE drama_id = 658
    AND storyboard_id IN (${placeholders})
    AND frame_type = 'first_frame'
    AND provider = ?
    AND model = ?
  ORDER BY storyboard_id ASC, id ASC
`).all(...ids, PROVIDER, MODEL)
db.close()

const latest = new Map()
for (const row of rows) latest.set(row.storyboard_id, row)

fs.mkdirSync(outputDir, { recursive: true })
const ledger = {}
const missing = []

for (const shot of storyboards) {
  const row = latest.get(shot.id)
  const number = String(shot.storyboardNumber)
  const padded = number.padStart(3, '0')
  const sourceLocalPath = row?.local_path || null
  const sourceFile = sourceLocalPath ? path.join(root, 'data', sourceLocalPath) : null
  const frozenFile = path.join(outputDir, `${padded}.png`)

  if (!row || row.status !== 'completed' || !sourceFile || !fs.existsSync(sourceFile)) {
    missing.push({ storyboardNumber: shot.storyboardNumber, storyboardId: shot.id, status: row?.status || 'missing', sourceLocalPath })
    continue
  }

  fs.copyFileSync(sourceFile, frozenFile)
  ledger[number] = {
    storyboardId: shot.id,
    generationId: row.id,
    taskId: row.task_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    updatedAt: row.updated_at,
    sourceLocalPath,
    sourceFile,
    frozenFile,
    sha256: sha256(frozenFile),
    bytes: fs.statSync(frozenFile).size,
  }
}

writeJson(ledgerPath, {
  schemaVersion: 1,
  frozenAt: new Date().toISOString(),
  provider: PROVIDER,
  model: MODEL,
  imageCount: Object.keys(ledger).length,
  ledger,
  missing,
})

console.log(JSON.stringify({ outputDir, imageCount: Object.keys(ledger).length, missingCount: missing.length, missing }, null, 2))
if (missing.length) process.exitCode = 1
