import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import puppeteer, { type LaunchOptions } from 'puppeteer-core'
import { buildCoverHtml, composeCoverImage, composeCoverVariants } from './cover-image-composer.js'

async function stalledComposerFixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stalled-cover-composer-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const baseImagePath = path.join(directory, 'base.png')
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#345678' } }).png().toFile(baseImagePath)
  return { design: {}, variants: [{ key: 'portrait', baseImagePath, width: 32, height: 32 }], outputDir: directory }
}

test('a failed cover render escapes a stalled Chrome close and retains its original error', async t => {
  const input = await stalledComposerFixture(t), original = new Error('cover font loading failed')
  let closeStarted!: () => void, launchSignal: AbortSignal | undefined
  const closing = new Promise<void>(resolve => { closeStarted = resolve })
  let disconnected = false
  t.mock.method(puppeteer, 'launch', async (options?: LaunchOptions) => {
    launchSignal = options?.signal
    return { newPage: async () => { throw original }, close: () => { closeStarted(); return new Promise(() => {}) },
      disconnect: async () => { disconnected = true } } as any
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let outcome: unknown
  void composeCoverVariants(input).catch(error => { outcome = error })
  await closing
  t.mock.timers.tick(5001)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(outcome, original, 'a browser cleanup stall must not hide the render failure indefinitely')
  assert.equal(launchSignal?.aborted, true, 'only this composer-owned Chrome is force-stopped')
  assert.equal(disconnected, true)
})

test('a Chrome startup that never returns is bounded and aborts its owned process', async t => {
  const input = await stalledComposerFixture(t)
  let launchStarted!: () => void, launchSignal: AbortSignal | undefined
  const starting = new Promise<void>(resolve => { launchStarted = resolve })
  t.mock.method(puppeteer, 'launch', (options?: LaunchOptions) => {
    launchSignal = options?.signal
    launchStarted()
    return new Promise(() => {})
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let outcome: unknown
  void composeCoverVariants(input).catch(error => { outcome = error })
  await starting
  t.mock.timers.tick(90_001)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(String(outcome), /封面排版.*超时/)
  assert.equal(launchSignal?.aborted, true)
})

test('cancelling a stalled cover render closes its owned browser and preserves the cancellation', async t => {
  const input = await stalledComposerFixture(t), controller = new AbortController(), reason = new Error('user stopped cover generation')
  let renderStarted!: () => void, launchSignal: AbortSignal | undefined, closes = 0
  const rendering = new Promise<void>(resolve => { renderStarted = resolve })
  t.mock.method(puppeteer, 'launch', async (options?: LaunchOptions) => {
    launchSignal = options?.signal
    return { newPage: () => { renderStarted(); return new Promise(() => {}) }, close: async () => { closes++ } } as any
  })
  const result = composeCoverVariants({ ...input, signal: controller.signal })
  const rejection = assert.rejects(result, error => error === reason)
  await rendering
  controller.abort(reason)
  await rejection
  assert.equal(launchSignal?.aborted, true)
  assert.equal(closes, 1)
})

test('cover variants validate keys and dimensions before opening images or Chrome', async () => {
  const base = { key: 'cover', baseImagePath: '/nonexistent.png', width: 1280, height: 720 }
  for (const variants of [
    [],
    [{ ...base, key: '../escape' }],
    [{ ...base, width: 0 }],
    [{ ...base, height: 1.5 }],
    [base, { ...base, key: 'COVER' }],
  ]) {
    await assert.rejects(composeCoverVariants({ design: {}, variants, outputDir: '/unused' }),
      /At least one|Invalid cover|Duplicate cover/)
  }
})

test('cover variants render local images at requested sizes and reuse stable paths', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-cover-composer-'))
  try {
    const landscapePath = path.join(tempDir, 'landscape.png')
    const portraitPath = path.join(tempDir, 'portrait.png')
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#d14949' } })
      .png().toFile(landscapePath)
    await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#249e61' } })
      .png().toFile(portraitPath)
    const sourceBefore = await fs.readFile(landscapePath)
    const input = {
      design: { main_title: 'Ancient food', sub_title: 'History', kicker: 'Evidence' },
      outputDir: path.join(tempDir, 'covers'),
      variants: [
        { key: 'wide', baseImagePath: landscapePath, width: 1280, height: 720 },
        { key: 'classic', baseImagePath: landscapePath, width: 1200, height: 900 },
        { key: 'portrait', baseImagePath: portraitPath, width: 900, height: 1200 },
      ],
    }
    const covers = await composeCoverVariants(input)
    for (let index = 0; index < covers.length; index++) {
      const cover = covers[index]!
      const target = input.variants[index]!
      assert.equal(cover.path, path.join(input.outputDir, `${target.key}.png`))
      const { width, height, format } = await sharp(cover.path).metadata()
      assert.deepEqual({ width, height, format }, { width: target.width, height: target.height, format: 'png' })
      const { data, info } = await sharp(cover.path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let brightPixels = 0
      for (let offset = 0; offset < data.length; offset += info.channels) {
        if (data[offset]! > 220 && data[offset + 1]! > 220 && data[offset + 2]! > 200) brightPixels++
      }
      assert.ok(brightPixels > 100, 'rendered cover must contain the title text')
      const backgroundOffset = (Math.floor(target.height / 2) * target.width + Math.floor(target.width * 0.9)) * info.channels
      const red = data[backgroundOffset]!
      const green = data[backgroundOffset + 1]!
      assert.ok(target.key === 'portrait' ? green > red : red > green,
        'each format must use the corresponding unlettered source image')
    }
    const secondPass = await composeCoverVariants({ ...input, variants: [{
      ...input.variants[0]!, width: 640, height: 360,
    }] })
    assert.equal(secondPass[0]!.path, covers[0]!.path)
    assert.equal((await sharp(secondPass[0]!.path).metadata()).width, 640)
    assert.deepEqual(await fs.readFile(landscapePath), sourceBefore)

    const sourceRoot = process.env.STORAGE_PATH
      || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/static')
    const legacyUrl = await composeCoverImage({
      design: input.design,
      baseImagePath: path.relative(sourceRoot, landscapePath),
      frameType: '4:3',
      outputDir: path.join(tempDir, 'legacy'),
    })
    assert.match(legacyUrl, /^static\/covers\/[a-f0-9-]+\.png$/)
    const legacy = await sharp(path.join(tempDir, 'legacy', path.basename(legacyUrl))).metadata()
    assert.deepEqual([legacy.width, legacy.height], [1440, 1080])
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('thumbnail layout keeps a short two-line hook and highlighted conflict inside the safe area', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-thumbnail-composer-'))
  try {
    const source = path.join(tempDir, 'source.png')
    await sharp({ create: { width: 1200, height: 675, channels: 3, background: '#63798d' } }).png().toFile(source)
    const [cover] = await composeCoverVariants({
      design: {
        main_title: '朱棣兵少凭什么能赢',
        sub_title: '一条粮道改变战局',
        kicker: '靖难之役',
        accent_color: '#FFE044',
        thumbnail_layout: 'text-left',
        highlight_text: '兵少',
      },
      variants: [{ key: 'thumbnail', baseImagePath: source, width: 320, height: 180 }],
      outputDir: path.join(tempDir, 'out'),
    })
    assert.ok(cover)
    assert.deepEqual(await sharp(cover!.path).metadata().then(({ width, height, format }) => ({ width, height, format })),
      { width: 320, height: 180, format: 'png' })
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('legacy thumbnails fit the combined title, label and subtitle within all delivery safe areas', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-thumbnail-safe-area-'))
  try {
    const source = path.join(directory, 'source.png')
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#63798d' } }).png().toFile(source)
    const design = { main_title: '王树声为何不回信', sub_title: '先打电话查情况', kicker: '1962年',
      thumbnail_layout: 'text-left' as const, highlight_text: '不回信', accent_color: '#D7A649' }
    const before = structuredClone(design)
    const variants = [
      { key: 'wide', baseImagePath: source, width: 1280, height: 720 },
      { key: 'classic', baseImagePath: source, width: 1440, height: 1080 },
      { key: 'portrait', baseImagePath: source, width: 810, height: 1080 },
    ]
    const covers = await composeCoverVariants({ design, variants, outputDir: path.join(directory, 'out') })
    assert.equal(covers.length, 3)
    for (const [index,cover] of covers.entries()) {
      const { width,height } = await sharp(cover.path).metadata()
      assert.deepEqual([width,height],[variants[index]!.width,variants[index]!.height])
    }
    assert.deepEqual(design,before,'fitting may resize typography but must retain the approved copy')
  } finally { await fs.rm(directory,{recursive:true,force:true}) }
})

test('science posters preserve three intentional headline lines while legacy thumbnail fitting stays at two', async () => {
  const design = { main_title: '骆驼\n为什么\n这么耐渴？', highlight_text: '骆驼', thumbnail_layout: 'text-left' as const, accent_color: '#FFE600' }
  const html = buildCoverHtml({ ...design, headline_lines: 3 }, 'data:image/png;base64,', 1280, 720)
  assert.match(html, /data-fit-lines="3"/)
  assert.match(html, /<span class="highlight">骆驼<\/span><br>为什么<br>这么耐渴？/)
  const legacy = buildCoverHtml(design, 'data:image/png;base64,', 1280, 720)
  assert.match(legacy, /data-fit-lines="2"/)
  assert.doesNotMatch(legacy, /<br>/)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'science-cover-composer-'))
  try {
    const baseImagePath = path.join(directory, 'base.png')
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#101010' } }).png().toFile(baseImagePath)
    const covers = await composeCoverVariants({ design: { ...design, headline_lines: 3 }, outputDir: directory, variants: [
      { key: 'landscape', baseImagePath, width: 1280, height: 720 },
      { key: 'portrait', baseImagePath, width: 810, height: 1080 },
    ] })
    for (const cover of covers) {
      const { data, info } = await sharp(cover.path).resize(320).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let yellow = 0, white = 0
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i]! > 180 && data[i + 1]! > 150 && data[i + 2]! < 100) yellow++
        if (data[i]! > 210 && data[i + 1]! > 210 && data[i + 2]! > 210) white++
      }
      assert.ok(yellow > 50 && white > 100, 'yellow subject and white question remain visible at thumbnail size')
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
