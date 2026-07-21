import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { composeIntroForEpisode } from './intro-composer.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import http from 'http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEST_PORT = '5699'

const TEMPLATES = [
  {
    id: 'classic-title-fade',
    name: '经典黑场标题淡入',
    config: {
      duration: 4,
      background: { type: 'color', value: '#000000' },
      variables: { dramaTitle: { source: 'drama.title', fallback: '精彩短剧' } },
      layers: [{ type: 'text', content: '{{dramaTitle}}', fontSize: 72, color: '#ffffff', position: 'center', animation: { type: 'fadeIn', duration: 1.5, delay: 0.5 } }],
      audio: null,
    },
    isDefault: false,
  },
  {
    id: 'black-title-fade',
    name: '电影感标题淡入（Remotion）',
    config: { duration: 4, component: 'BlackTitleIntro', background: { type: 'color', value: '#000000' }, layers: [], audio: null, bgmAssetId: '2342ac04-1107-4b15-96a3-00a9e64246e6' },
    isDefault: true,
  },
  {
    id: 'dynasty-year-flash',
    name: '朝代年号快闪（Remotion）',
    config: { duration: 4, component: 'DynastyYearFlash', background: { type: 'color', value: '#0a0a0a' }, cards: [{ text: '大明', sub: 'Ming Dynasty' }, { text: '万历十年', sub: 'Year of Wanli 10' }, { text: '1582', sub: 'June' }, { text: '张居正卒', sub: 'Zhang Juzheng died' }], layers: [], audio: null },
    isDefault: false,
  },
  {
    id: 'vintage-ken-burns',
    name: '老照片 Ken Burns（Remotion）',
    config: { duration: 6, component: 'VintageKenBurns', background: { type: 'color', value: '#1a1510' }, layers: [], audio: null },
    isDefault: false,
  },
]

function now() {
  return new Date().toISOString()
}

function waitForHealth(port: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tryOnce = () => {
      http.get(`http://localhost:${port}/api/v1/health`, (res) => {
        if (res.statusCode === 200) return resolve()
        res.resume()
        retry()
      }).on('error', retry)
    }
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error(`Server did not become healthy on port ${port}`))
      setTimeout(tryOnce, 200)
    }
    tryOnce()
  })
}

describe('intro composer', () => {
  let serverProc: ReturnType<typeof spawn> | null = null

  before(() => {
    for (const t of TEMPLATES) {
      const existing = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, t.id)).all()[0]
      const values = {
        name: t.name,
        config: t.config,
        isDefault: t.isDefault,
        updatedAt: now(),
      }
      if (existing) {
        db.update(schema.introTemplates).set(values).where(eq(schema.introTemplates.id, t.id)).run()
      } else {
        db.insert(schema.introTemplates).values({ id: t.id, ...values, createdAt: now() }).run()
      }
    }
  })

  before(async () => {
    process.env.PORT = TEST_PORT
    serverProc = spawn('npm', ['run', 'start'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, PORT: TEST_PORT, TASK_WORKER_DISABLED: '1' },
      stdio: 'ignore',
      detached: true,
    })
    serverProc.unref()
    await waitForHealth(TEST_PORT)
  })

  after(() => {
    if (serverProc && serverProc.pid) {
      try {
        process.kill(-serverProc.pid, 'SIGTERM')
      } catch {
        try {
          serverProc.kill('SIGTERM')
        } catch {}
      }
    }
  })

  it('renders a mp4 intro using black-title-fade even when classic template is requested', async () => {
    const result = await composeIntroForEpisode({
      episodeId: 1,
      episodeNumber: 1,
      dramaTitle: '测试短剧',
      templateId: 'classic-title-fade',
    })
    assert.ok(result)
    assert.ok(result!.endsWith('-black-title-fade.mp4'))
    const absPath = path.resolve(__dirname, '../../../data', result!)
    assert.ok(fs.existsSync(absPath), `Expected intro file at ${absPath}`)
  })

  it('falls back to default black-title-fade template when templateId is missing', async () => {
    const result = await composeIntroForEpisode({
      episodeId: 2,
      episodeNumber: 1,
      dramaTitle: '默认模板测试',
    })
    assert.ok(result)
    assert.ok(result!.endsWith('-black-title-fade.mp4'))
  })

  const remotionTests = [
    { id: 'black-title-fade', suffix: '-black-title-fade.mp4' },
    { id: 'dynasty-year-flash', suffix: '-dynasty-year-flash.mp4' },
    { id: 'vintage-ken-burns', suffix: '-vintage-ken-burns.mp4' },
  ]

  for (const t of remotionTests) {
    it(`renders Remotion intro for ${t.id}`, { timeout: 180000 }, async () => {
      const result = await composeIntroForEpisode({
        episodeId: 999001,
        episodeNumber: 1,
        dramaTitle: '测试历史短剧',
        templateId: t.id,
        aspectRatio: '16:9',
      })
      assert.ok(result)
      assert.ok(result!.endsWith(t.suffix), `Expected path ending with ${t.suffix}, got ${result}`)
      const absPath = path.resolve(__dirname, '../../../data', result!)
      assert.ok(fs.existsSync(absPath), `Expected intro file at ${absPath}`)
      const stats = fs.statSync(absPath)
      assert.ok(stats.size > 0)
    })
  }
})
