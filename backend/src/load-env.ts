import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const initialEnvKeys = new Set(Object.keys(process.env))

loadEnvFile(path.join(root, '.env'))
loadEnvFile(path.join(root, '.env.local'), { localOverride: true })

function loadEnvFile(filePath: string, options: { localOverride?: boolean } = {}) {
  if (!fs.existsSync(filePath)) return

  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue

    const { key, value } = parsed
    if (initialEnvKeys.has(key)) continue
    if (!options.localOverride && process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
  if (!match) return null

  return {
    key: match[1],
    value: unquoteEnvValue(match[2].trim()),
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
