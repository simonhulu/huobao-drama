import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { generateMysteryCoverPosters, MYSTERY_COVER_STYLE, MYSTERY_COVER_TOOL } from './mystery-cover.js'
import type { SciencePosterOptions, SciencePosterImageRuntime } from './science-cover-poster.js'

test('story covers use grounded independent compositions, explicit illustration labels and a distinct resumable profile', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mystery-cover-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const quote = '那把钥匙可能还在门口，直到今天也没有确切的答案。'
  const plan = { headlineLines: ['钥匙', '去了哪里？'], highlight: '钥匙', subject: '旧木门旁的一把黄铜钥匙',
    evidenceQuote: quote, payoff: '原稿保留未知，仅呈现当时线索。',
    landscapeTextSide: 'text-left',
    landscapePrompt: '横版纪实故事场景示意，右侧旧木门和一把黄铜钥匙，克制的冷色侧光，左侧黑色留白，禁止文字与真实证据伪造。',
    portraitPrompt: '竖版纪实场景示意，下方旧木门边缘和一把黄铜钥匙，上方暗色留白，柔和冷色光线，禁止文字和真实案件照片伪造。',
  }
  const requests: Array<Parameters<SciencePosterImageRuntime['create']>[0]> = []
  const states = new Map<number, NonNullable<Awaited<ReturnType<SciencePosterImageRuntime['state']>>>>()
  let modelCalls = 0
  const dependencies: NonNullable<SciencePosterOptions['dependencies']> = {
    call: async (messages, options) => {
      modelCalls++
      assert.deepEqual(options?.toolChoice, { type: 'function', function: { name: MYSTERY_COVER_TOOL } })
      assert.match(messages[0]!.content, /不把未解之谜说成已经破案/)
      assert.match(messages[0]!.content, /不编造人物身份/)
      assert.doesNotMatch(messages[0]!.content, /你是科普/)
      return JSON.stringify(plan)
    },
    images: {
      config: async () => ({ id: 5, identity: 'image-provider' }),
      create: async request => {
        requests.push(request)
        states.set(requests.length, { status: 'processing', taskId: null, localPath: null, errorMsg: null, lastErrorCode: null })
        return requests.length
      },
      state: async id => states.get(id) || null,
      execute: async id => {
        const file = path.join(directory, 'base-' + id + '.png')
        await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#222831' } }).png().toFile(file)
        states.set(id, { status: 'completed', taskId: 'remote-' + id, localPath: file, errorMsg: null, lastErrorCode: null })
        return file
      },
    },
    compose: async request => {
      assert.equal(request.design.kicker, '示意画面')
      return Promise.all(request.variants.map(async variant => {
        const file = path.join(request.outputDir, variant.key + '.png')
        await sharp(variant.baseImagePath).resize(variant.width, variant.height).png().toFile(file)
        return { ...variant, path: file }
      }))
    },
  }
  const input = { title: '失踪的钥匙', script: quote, directory, revision: 1 }
  const options = { signal: new AbortController().signal, dependencies }
  const result = await generateMysteryCoverPosters(input, options)
  assert.equal((await sharp(result.landscapePath).metadata()).width, 1280)
  assert.equal((await sharp(result.portraitPath).metadata()).height, 1080)
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.imageType, 'mystery_cover_base')
    assert.match(request.prompt, /场景示意/)
    assert.doesNotMatch(request.prompt, /科普海报/)
  }
  const checkpoint = JSON.parse(await fs.readFile(path.join(directory, 'poster-checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.style, MYSTERY_COVER_STYLE)
  await generateMysteryCoverPosters(input, options)
  assert.equal(modelCalls, 1)
  assert.equal(requests.length, 2)
})

