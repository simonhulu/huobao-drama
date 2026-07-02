import { describe, it, before } from 'node:test'
import assert from 'node:assert'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { composeIntroForEpisode } from './intro-composer.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('intro composer', () => {
  before(() => {
    const existing = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, 'classic-title-fade')).all()[0]
    if (!existing) {
      db.insert(schema.introTemplates).values({
        id: 'classic-title-fade',
        name: '经典黑场标题淡入',
        config: {
          duration: 3,
          background: { type: 'color', value: '#000000' },
          variables: { dramaTitle: { source: 'drama.title', fallback: '精彩短剧' } },
          layers: [{ type: 'text', content: '{{dramaTitle}}', fontSize: 72, color: '#ffffff', position: 'center', animation: { type: 'fadeIn', duration: 1.5, delay: 0.5 } }],
          audio: null,
        },
        isDefault: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run()
    }
  })

  it('renders a mp4 intro for the default template', async () => {
    const result = await composeIntroForEpisode({
      episodeId: 1,
      episodeNumber: 1,
      dramaTitle: '测试短剧',
      templateId: 'classic-title-fade',
    })
    assert.ok(result)
    assert.ok(result!.endsWith('-intro.mp4'))
    const absPath = path.resolve(__dirname, '../../../data', result!)
    assert.ok(fs.existsSync(absPath), `Expected intro file at ${absPath}`)
  })

  it('falls back to default template when templateId is missing', async () => {
    const result = await composeIntroForEpisode({
      episodeId: 2,
      episodeNumber: 1,
      dramaTitle: '默认模板测试',
    })
    assert.ok(result)
    assert.ok(result!.endsWith('-intro.mp4'))
  })
})
