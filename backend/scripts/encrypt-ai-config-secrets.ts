import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.resolve(backendRoot, '..')
process.env.AI_CONFIG_KEY_FILE ||= path.join(projectRoot, 'data', '.ai-config-encryption-key')

const { encryptSecret, isEncryptedSecret } = await import('../src/services/secret-crypto.js')

const requestedPaths = process.argv.slice(2)
const roots = requestedPaths.length > 0
  ? requestedPaths.map(value => path.resolve(value))
  : [
      path.join(projectRoot, 'data', 'huobao_drama.db'),
      path.join(projectRoot, 'data', 'backups'),
      path.join(projectRoot, 'data', 'temp'),
    ]

function collectDatabases(target: string): string[] {
  if (!fs.existsSync(target)) return []
  const stat = fs.statSync(target)
  if (stat.isFile()) return /\.(db|sqlite|sqlite3)$/i.test(target) ? [target] : []
  if (!stat.isDirectory()) return []

  return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(target, entry.name)
    return entry.isDirectory() ? collectDatabases(child) : collectDatabases(child)
  })
}

let migratedFiles = 0
let migratedSecrets = 0
let skippedFiles = 0

for (const dbPath of [...new Set(roots.flatMap(collectDatabases))]) {
  const sqlite = new Database(dbPath, { timeout: 30_000 })
  try {
    const table = sqlite.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type = 'table' AND name = 'ai_service_configs'
      LIMIT 1
    `).get()
    if (!table) {
      skippedFiles += 1
      continue
    }

    const rows = sqlite.prepare(`SELECT id, api_key FROM ai_service_configs WHERE api_key <> ''`).all() as Array<{
      id: number
      api_key: string
    }>
    const plaintextRows = rows.filter(row => !isEncryptedSecret(row.api_key))
    if (plaintextRows.length === 0) continue

    const update = sqlite.prepare(`UPDATE ai_service_configs SET api_key = ? WHERE id = ?`)
    sqlite.transaction(() => {
      for (const row of plaintextRows) update.run(encryptSecret(row.api_key), row.id)
    })()
    migratedFiles += 1
    migratedSecrets += plaintextRows.length
  } finally {
    sqlite.close()
  }
}

console.log(JSON.stringify({ migratedFiles, migratedSecrets, skippedFiles }))

