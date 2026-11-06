import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'
import puppeteer from 'puppeteer-core'
import {
  assertHistoryCanStage, fillShortTitle, fillDescription,
  historyManifestFingerprint, readHistoryPublishState, saveHistoryDraft,
  validateHistoryManifest, writeHistoryPublishState,
} from './lib.mjs'

const run = promisify(execFile)
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-history-package-'))
  const video = Buffer.from('frozen video fixture')
  const portrait = await sharp({ create: { width: 90, height: 120, channels: 3, background: '#467d63' } }).png().toBuffer()
  const landscape = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#8c5049' } }).png().toBuffer()
  const manifest = {
    platform: 'wechat_channels', source_type: 'history_script', publish_package_id: 'history-1-fixed',
    history_source_id: 1, session: 'wechat-history-1-fixed', title: '古代食品造假', description: '从古代食品加工看饮食史。',
    video_path: path.join(directory, 'video.mp4'), video_sha256: hash(video),
    cover_3x4_path: path.join(directory, 'portrait.png'), cover_3x4_sha256: hash(portrait),
    cover_4x3_path: path.join(directory, 'landscape.png'), cover_4x3_sha256: hash(landscape),
  }
  await fs.writeFile(manifest.video_path, video)
  await fs.writeFile(manifest.cover_3x4_path, portrait)
  await fs.writeFile(manifest.cover_4x3_path, landscape)
  return { directory, manifest, stateDir: path.join(directory, 'state'), cleanup: () => fs.rm(directory, { recursive: true, force: true }) }
}

test('history manifests reject changed assets and oversized titles without truncation', async () => {
  const f = await fixture()
  try {
    assert.equal(await validateHistoryManifest(f.manifest), f.manifest)
    await assert.rejects(validateHistoryManifest({ ...f.manifest, title: '字'.repeat(17) }), /不会自动截断/)
    const longDescription = { ...f.manifest, description: '字'.repeat(201) }
    assert.equal(await validateHistoryManifest(longDescription), longDescription)
    await assert.rejects(fillShortTitle({}, '字'.repeat(17), { strict: true }), /不会自动截断/)
    await assert.rejects(fillDescription({}, '', { strict: true }), /描述不能为空/)
    await assert.rejects(validateHistoryManifest({ ...f.manifest,
      cover_4x3_path: f.manifest.cover_3x4_path, cover_4x3_sha256: f.manifest.cover_3x4_sha256 }), /封面比例不符合要求/)
    await fs.appendFile(f.manifest.video_path, 'changed')
    await assert.rejects(validateHistoryManifest(f.manifest), /video 文件指纹不匹配/)
  } finally { await f.cleanup() }
})

test('strict description filling keeps more than 200 characters intact in the editor', async (t) => {
  const browser = await puppeteer.launch({
    executablePath: process.env.WECHAT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--no-first-run'],
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<div class="input-editor" contenteditable="true"></div>')
  const description = '英国圈地运动究竟改变了什么？'.repeat(17)
  assert.ok(description.length > 200)
  assert.equal(await fillDescription(page, description, { strict: true }), true)
  assert.equal(await page.$eval('.input-editor', (element) => element.innerText), description)
})

test('confirmed history manifests reject unsupported title symbols without changing the title', async () => {
  const f = await fixture()
  try {
    for (const title of ['明朝，竟然这样？', '明朝,竟然这样?', '明朝竟然这样！', '明朝竟然这样。', '明朝/真相', '明朝\n真相']) {
      const manifest = { ...f.manifest, title }
      await assert.rejects(validateHistoryManifest(manifest), /书名号.*问号/)
      assert.equal(manifest.title, title)
    }
    for (const title of ['《明史》：“帝”+10%？', '冬菜：5℃？']) {
      const manifest = { ...f.manifest, title }
      assert.equal(await validateHistoryManifest(manifest), manifest)
      assert.equal(manifest.title, title)
    }
  } finally { await f.cleanup() }
})

test('strict short title filling rejects unsupported symbols before touching the page', async () => {
  for (const title of ['明朝，竟然这样？', '明朝,竟然这样?', '明朝竟然这样！', '明朝/真相', '明朝\n真相']) {
    await assert.rejects(fillShortTitle({}, title, { strict: true }), /书名号.*问号/)
  }
})

test('legacy short title filling preserves its existing punctuation behavior', async () => {
  let entered
  const page = { evaluate: async (_callback, text) => {
    if (text !== undefined) entered = text
    return true
  } }
  assert.equal(await fillShortTitle(page, '明朝，竟然这样！'), true)
  assert.equal(entered, '明朝，竟然这样！')
})

test('prepare --package preserves confirmed copy, paths and cover bytes', async () => {
  const f = await fixture()
  try {
    const input = path.join(f.directory, 'manifest.json')
    const output = path.join(f.directory, 'prepared.json')
    await fs.writeFile(input, JSON.stringify(f.manifest))
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL('./prepare.mjs', import.meta.url)),
      '--package', input, '--out', output])
    assert.equal(JSON.parse(stdout).ok, true)
    assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), f.manifest)
    assert.equal(hash(await fs.readFile(f.manifest.cover_3x4_path)), f.manifest.cover_3x4_sha256)
    assert.equal(hash(await fs.readFile(f.manifest.cover_4x3_path)), f.manifest.cover_4x3_sha256)
  } finally { await f.cleanup() }
})

test('operate and verify do not prevalidate metadata or asset fingerprints', async () => {
  const f = await fixture()
  try {
    const input = path.join(f.directory, 'manifest.json')
    await fs.writeFile(input, JSON.stringify({ ...f.manifest, title: '字'.repeat(17), description: '', video_sha256: '0'.repeat(64) }))
    await assert.rejects(run(process.execPath, [fileURLToPath(new URL('operate.mjs', import.meta.url)), '--manifest', input],
      { env: { ...process.env, WECHAT_CHANNELS_CDP_URL: 'http://127.0.0.1:1' } }), /Failed to fetch browser webSocket URL/)
    await assert.rejects(run(process.execPath, [fileURLToPath(new URL('verify.mjs', import.meta.url)), '--manifest', input],
      { env: { ...process.env, WECHAT_CHANNELS_CDP_URL: 'http://127.0.0.1:1' } }), /视频、双封面和文案尚未全部就绪/)
  } finally { await f.cleanup() }
})

test('successful save is durable and repeated saves do not connect or click again', async () => {
  const f = await fixture()
  try {
    writeHistoryPublishState(f.manifest, { status: 'staged' }, f.stateDir)
    let readyCalls = 0
    let saveCalls = 0
    const options = { stateDir: f.stateDir,
      assertReady: async () => { readyCalls++ }, save: async () => { saveCalls++; return true } }
    assert.equal((await saveHistoryDraft(f.manifest, options)).saved, true)
    const second = await saveHistoryDraft(f.manifest, options)
    assert.equal(second.skipped, true)
    assert.equal(readyCalls, 1)
    assert.equal(saveCalls, 1)
    assert.equal(readHistoryPublishState(f.manifest, f.stateDir).status, 'saved')
    assert.throws(() => assertHistoryCanStage(f.manifest, f.stateDir), /已保存草稿/)
    assert.throws(() => readHistoryPublishState({ ...f.manifest, title: '新的标题' }, f.stateDir), /已有其他内容/)
  } finally { await f.cleanup() }
})

test('uncertain saves persist unknown and cannot be retried automatically', async () => {
  for (const save of [async () => false, async () => { throw new Error('connection lost after click') }]) {
    const f = await fixture()
    try {
      writeHistoryPublishState(f.manifest, { status: 'staged' }, f.stateDir)
      try { await saveHistoryDraft(f.manifest, { stateDir: f.stateDir, assertReady: async () => {}, save }) } catch (error) {
        assert.match(error.message, /connection lost/)
      }
      assert.equal(readHistoryPublishState(f.manifest, f.stateDir).status, 'unknown')
      await assert.rejects(saveHistoryDraft(f.manifest, {
        stateDir: f.stateDir, assertReady: async () => assert.fail('must not connect'), save: async () => assert.fail('must not click'),
      }), /上次保存结果未知/)
    } finally { await f.cleanup() }
  }
})

test('saving state survives crashes and concurrent attempts are blocked', async () => {
  const f = await fixture()
  try {
    writeHistoryPublishState(f.manifest, { status: 'staged' }, f.stateDir)
    let releaseSave
    let markStarted
    const started = new Promise((resolve) => { markStarted = resolve })
    const gate = new Promise((resolve) => { releaseSave = resolve })
    const first = saveHistoryDraft(f.manifest, { stateDir: f.stateDir, assertReady: async () => {},
      save: async () => { markStarted(); return gate } })
    await started
    assert.equal(readHistoryPublishState(f.manifest, f.stateDir).status, 'saving')
    try {
      await assert.rejects(saveHistoryDraft(f.manifest, { stateDir: f.stateDir }), /已有操作/)
    } finally { releaseSave(true) }
    await first
    writeHistoryPublishState(f.manifest, { status: 'saving' }, f.stateDir)
    await assert.rejects(saveHistoryDraft(f.manifest, { stateDir: f.stateDir }), /上次保存结果未知/)
    assert.equal(readHistoryPublishState(f.manifest, f.stateDir).fingerprint, historyManifestFingerprint(f.manifest))
  } finally { await f.cleanup() }
})
