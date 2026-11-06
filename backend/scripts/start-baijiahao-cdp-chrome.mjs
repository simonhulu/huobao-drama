#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PROFILE_DIR, CREATE_URL } from './baijiahao/lib.mjs'

const chrome = process.env.BAIJIAHAO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = process.env.BAIJIAHAO_CDP_PORT || '9225'
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('无效的 CDP 端口')
if (!fs.existsSync(chrome)) throw new Error('找不到 Chrome，请设置 BAIJIAHAO_CHROME_PATH')
try {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
  if (response.ok) { console.log(`[baijiahao] CDP ${port} 已在运行，请复用，不重复启动`); process.exit(0) }
} catch { /* Start the dedicated browser only when the endpoint is not available. */ }
fs.mkdirSync(PROFILE_DIR, { recursive: true })
const log = fs.openSync(path.join(PROFILE_DIR, 'chrome.log'), 'a')
const child = spawn(chrome, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', CREATE_URL], { detached: true, stdio: ['ignore', log, log] })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.unref()
fs.closeSync(log)
console.log(`[baijiahao] Chrome pid=${child.pid}, CDP=http://127.0.0.1:${port}, profile=${PROFILE_DIR}`)
