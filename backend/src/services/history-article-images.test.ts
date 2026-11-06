import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { prepareHistoryArticleImages } from './history-article-images.js'
import type { ArticleScreenshot } from './history-script-article-renderer.js'

const exec = promisify(childProcess.execFile)
const originalPython = process.env.SOCIAL_AUTO_UPLOAD_PYTHON
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const success = `
const manifest = { version: 1, images: payload.images.slice(0, 2).map(image => ({
  url: image.url, sha256: crypto.createHash('sha256').update(fs.readFileSync(image.path)).digest('hex'), quality: { score: 1 },
})) };
fs.writeFileSync(path.join(directory, 'body-cover-selection.json'), JSON.stringify(manifest));
process.stdout.write(JSON.stringify(manifest));
`

function fixture(t: TestContext, handler = success) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'article-images-'))
  const previous = process.env.SOCIAL_AUTO_UPLOAD_PYTHON
  const python = path.join(directory, 'fixture-python')
  fs.writeFileSync(python, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const directory = path.dirname(payload.images[0].path);
  fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ args: process.argv.slice(2), payload }));
  ${handler}
});
`, { mode: 0o700 })
  process.env.SOCIAL_AUTO_UPLOAD_PYTHON = python
  t.after(() => {
    if (previous === undefined) delete process.env.SOCIAL_AUTO_UPLOAD_PYTHON
    else process.env.SOCIAL_AUTO_UPLOAD_PYTHON = previous
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const screenshots: ArticleScreenshot[] = [1, 2, 3].map(index => {
    fs.writeFileSync(path.join(directory, `frame-${index}.jpg`), `unaltered image ${index}`)
    return { url: `/static/history-articles/58/abc-123/frame-${index}.jpg`, timestamp: index, sectionIndex: index - 1 }
  })
  return { directory, screenshots }
}

test('preparation invokes the standalone CLI, preserves pixels and requires persisted choices in article order', async t => {
  const { directory, screenshots } = fixture(t)
  const before = screenshots.map(image => fs.readFileSync(path.join(directory, path.basename(image.url))))
  const controller = new AbortController()
  const result = await prepareHistoryArticleImages(directory, [...screenshots].reverse(), controller.signal)
  const request = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'))
  assert.match(request.args[0], /scripts\/social-auto-upload\/article_cover_selection\.py$/)
  assert.equal(request.args[1], 'prepare')
  assert.deepEqual(Object.keys(request.payload).sort(), ['articleHtml', 'images'])
  assert.deepEqual(request.payload.images, screenshots.map(image => ({ url: image.url, path: path.join(directory, path.basename(image.url)) })))
  assert.equal(request.payload.articleHtml, screenshots.map(image => `<img src="${image.url}">`).join(''))
  assert.deepEqual(result, JSON.parse(fs.readFileSync(path.join(directory, 'body-cover-selection.json'), 'utf8')))
  assert.deepEqual(result.images.map(image => image.url), screenshots.slice(0, 2).map(image => image.url))
  for (const [index, image] of screenshots.entries()) assert.deepEqual(fs.readFileSync(path.join(directory, path.basename(image.url))), before[index])
})

test('a nonzero CLI exit preserves the actionable image shortage reason', async t => {
  const { directory, screenshots } = fixture(t, `process.stdout.write(JSON.stringify({error:'正文配图不足：需要 2 张，找到 1 张（画面模糊：2）'})); process.exitCode = 1;`)
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /正文配图不足：需要 2 张，找到 1 张（画面模糊：2）/)
  assert.equal(fs.existsSync(path.join(directory, 'body-cover-selection.json')), false)
})

test('successful stdout without a persisted manifest cannot complete preparation', async t => {
  const { directory, screenshots } = fixture(t, success.replace("fs.writeFileSync(path.join(directory, 'body-cover-selection.json'), JSON.stringify(manifest));", ''))
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /配图选择清单未正确保存/)
})

test('prepared choices must contain two different images belonging to this article', async t => {
  const { directory, screenshots } = fixture(t, success.replace('payload.images.slice(0, 2)', '[payload.images[0], payload.images[0]]'))
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /两张不同的正文图片/)
})

test('missing interpreter and image dependencies produce configuration errors, not upload errors', async t => {
  const { directory, screenshots } = fixture(t, `process.stderr.write("ModuleNotFoundError: No module named 'cv2'"); process.exitCode = 1;`)
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /缺少图像依赖.*cv2.*numpy/)
  process.env.SOCIAL_AUTO_UPLOAD_PYTHON = path.join(directory, 'missing-python')
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /找不到配图处理 Python.*SOCIAL_AUTO_UPLOAD_PYTHON/)
})

test('cancelled preparation does not spawn a process', async t => {
  const { directory, screenshots } = fixture(t)
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots, AbortSignal.abort()), /配图准备已取消/)
  assert.equal(fs.existsSync(path.join(directory, 'request.json')), false)
})

test('cancellation terminates an active preparation without saving a manifest', async t => {
  const { directory, screenshots } = fixture(t, 'setInterval(() => {}, 1000);')
  const controller = new AbortController()
  const operation = prepareHistoryArticleImages(directory, screenshots, controller.signal)
  const rejected = assert.rejects(operation, /配图准备已取消/)
  try {
    for (let attempts = 0; attempts < 200 && !fs.existsSync(path.join(directory, 'request.json')); attempts++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(fs.existsSync(path.join(directory, 'request.json')), 'The subprocess must be running before cancellation')
  } finally { controller.abort() }
  await rejected
  assert.equal(fs.existsSync(path.join(directory, 'body-cover-selection.json')), false)
})

test('hung preparation has a hard 20-second process deadline and an actionable timeout', async t => {
  const { directory, screenshots } = fixture(t, 'setInterval(() => {}, 1000);')
  const original = childProcess.execFile
  const override: typeof childProcess.execFile = ((file: string, args: string[], options: childProcess.ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(options.timeout, 20_000)
    assert.equal(options.killSignal, 'SIGKILL')
    // Exercise real subprocess termination without spending 20 seconds per test.
    return original(file, args, { ...options, timeout: 100, encoding: 'utf8' }, callback)
  }) as typeof childProcess.execFile
  t.mock.method(childProcess, 'execFile', override)
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /配图准备超时（20 秒）/)
  assert.equal(fs.existsSync(path.join(directory, 'body-cover-selection.json')), false)
})

test('real optional Python CLI prepares full-resolution JPEGs and rejects unusable frames', async t => {
  const localPython = path.join(os.homedir(), '.local/share/social-auto-upload/.venv/bin/python')
  const python = originalPython || (fs.existsSync(localPython) ? localPython : 'python3')
  try { await exec(python, ['-c', 'import cv2, numpy'], { timeout: 5000 }) }
  catch { t.skip('An existing Python with cv2/numpy is optional; subprocess contract tests run without SAU'); return }
  const { directory, screenshots } = fixture(t)
  process.env.SOCIAL_AUTO_UPLOAD_PYTHON = python
  for (const [index, image] of screenshots.entries()) {
    const pixels = Buffer.alloc(1280 * 720 * 3)
    let random = index + 1
    for (let cursor = 0; cursor < pixels.length; cursor++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      pixels[cursor] = random >>> 24
    }
    await sharp(pixels, { raw: { width: 1280, height: 720, channels: 3 } }).jpeg({ quality: 95 }).toFile(path.join(directory, path.basename(image.url)))
  }
  const before = screenshots.map(image => hash(fs.readFileSync(path.join(directory, path.basename(image.url)))))
  const prepared = await prepareHistoryArticleImages(directory, screenshots)
  assert.equal(prepared.images.length, 2)
  assert.equal(new Set(prepared.images.map(image => image.sha256)).size, 2)
  for (const [index, image] of screenshots.entries()) {
    const filename = path.join(directory, path.basename(image.url))
    assert.equal(hash(fs.readFileSync(filename)), before[index])
    const metadata = await sharp(filename).metadata()
    assert.deepEqual([metadata.width, metadata.height], [1280, 720])
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 100, g: 100, b: 100 } } }).jpeg().toFile(filename)
  }
  await assert.rejects(prepareHistoryArticleImages(directory, screenshots), /正文配图不足.*画面模糊/)
})
