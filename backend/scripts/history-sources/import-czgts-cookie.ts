// Explicit local action: import only czgts.cn cookies from the standard macOS Chrome profile.
import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { czgtsCredentials, searchCzgtsArticles, shanghaiDateTime } from '../../src/services/history-source-czgts.js'

async function main() {
  if (process.platform !== 'darwin') throw new Error('此同步脚本仅支持 macOS Chrome')
  const db = new Database(path.join(homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies'), { readonly: true, fileMustExist: true })
  let rows: Array<{host_key:string;name:string;value:string;encrypted_value:Buffer;path:string;expires_utc:number}>
  let version: number
  try {
    version = Number((db.prepare("SELECT value FROM meta WHERE key='version'").get() as {value:string}).value)
    rows = db.prepare('SELECT host_key,name,value,encrypted_value,path,expires_utc FROM cookies WHERE host_key IN (?,?,?,?)')
      .all('czgts.cn', '.czgts.cn', 'www.czgts.cn', '.www.czgts.cn') as typeof rows
  } finally { db.close() }
  const active = rows.filter(row => '/muse/content/api/v1/hots/search'.startsWith(row.path)
    && (!row.expires_utc || row.expires_utc / 1_000_000 - 11_644_473_600 > Date.now() / 1000))
  if (!active.some(row => row.name === 'sessionid')) throw new Error('Chrome 中尚无有效 czgts.cn 登录，请先在该网站登录')
  const { stdout } = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { timeout: 60_000, maxBuffer: 4096 })
  const key = pbkdf2Sync(stdout.replace(/\r?\n$/, ''), 'saltysalt', 1003, 16, 'sha1')
  const pairs = new Map<string,string>()
  try {
    for (const row of active) {
      let value = row.value
      if (row.encrypted_value.length) {
        if (row.encrypted_value.subarray(0,3).toString() !== 'v10') throw new Error('当前 Chrome Cookie 加密格式不受支持')
        const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32))
        let plaintext = Buffer.concat([decipher.update(row.encrypted_value.subarray(3)), decipher.final()])
        if (version >= 24) {
          const digest = createHash('sha256').update(row.host_key).digest()
          if (!plaintext.subarray(0,32).equals(digest)) throw new Error('Cookie 域名校验失败')
          plaintext = plaintext.subarray(32)
        }
        value = plaintext.toString('utf8')
      }
      pairs.set(row.name, value)
    }
  } finally { key.fill(0) }
  const cookie = [...pairs].map(([name,value]) => `${name}=${value}`).join('; ')
  const end = new Date()
  const result = await searchCzgtsArticles({ startTime: shanghaiDateTime(new Date(end.getTime()-86_400_000)), endTime: shanghaiDateTime(end) }, { cookie })
  const status = await czgtsCredentials.save(cookie)
  console.log(JSON.stringify({ ...status, importedDomain: 'czgts.cn', cookieCount: pairs.size, verified: true, total: result.total }))
}

main().catch(() => { console.error('czgts.cn 登录同步未完成；请检查 Chrome 登录状态与钥匙串访问后重试。原有配置未替换。'); process.exitCode = 1 })
