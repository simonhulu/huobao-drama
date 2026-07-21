import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..')
const PROFILE_DIR = path.join(PROJECT_ROOT, 'data/douyin-profile')
const CDP_PORT = process.env.DOUYIN_CDP_PORT || '9224'
const START_URL = process.env.DOUYIN_START_URL || 'https://creator.douyin.com/creator-micro/content/upload'
const WINDOW_WIDTH = process.env.DOUYIN_WINDOW_WIDTH || '1440'
const WINDOW_HEIGHT = process.env.DOUYIN_WINDOW_HEIGHT || '900'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

fs.mkdirSync(PROFILE_DIR, { recursive: true })

const args = [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--enable-automation',
  '--disable-blink-features=AutomationControlled',
  '--window-position=40,60',
  `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
  START_URL,
]

console.log(`[cdp] launching ${CHROME} with profile ${PROFILE_DIR}`)
console.log(`[cdp] start url ${START_URL}`)
const out = fs.openSync(path.join(PROFILE_DIR, 'cdp-chrome.out.log'), 'a')
const err = fs.openSync(path.join(PROFILE_DIR, 'cdp-chrome.err.log'), 'a')
const proc = spawn(CHROME, args, {
  stdio: ['ignore', out, err],
})

console.log(`[cdp] Chrome pid=${proc.pid}`)

proc.on('exit', (code) => {
  console.log(`[cdp] Chrome exited with code ${code}`)
})

proc.on('error', (err) => {
  console.error('[cdp] failed to launch Chrome:', err.message)
  process.exit(1)
})

// 保持父进程存活，避免后台任务被清理时连带杀掉 Chrome
setInterval(() => {
  if (proc.exitCode !== null) {
    console.log('[cdp] Chrome no longer running, wrapper exiting')
    process.exit(proc.exitCode ?? 1)
  }
}, 5000)
