import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { repairHuashengMaterialDescriptions } from '../../src/services/huasheng-material-descriptions.mjs'

const options = { apply: false, database: process.env.DB_PATH || fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url)) }
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  if (argument === '--apply') options.apply = true
  else if (['--database', '--project', '--report'].includes(argument)) {
    const value = process.argv[++index]
    if (!value || value.startsWith('--')) throw Error(`${argument} requires a value`)
    options[argument === '--project' ? 'projectId' : argument.slice(2)] = value
  } else throw Error(`Unknown option: ${argument}`)
}
const database = new Database(options.database, { readonly: !options.apply, fileMustExist: true, timeout: 30000 })
try {
  const report = { at: new Date().toISOString(), ...repairHuashengMaterialDescriptions(database, options) }
  if (options.report) {
    fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true })
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report, null, 2))
} finally { database.close() }
