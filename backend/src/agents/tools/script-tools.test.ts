import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-script-tools-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const { createScriptTools } = await import('./script-tools.js')

function seedEpisode() {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Script Cover Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 2,
    title: '账本里的秘密',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

test('save_script extracts and persists the polish cover plan', async () => {
  const episodeId = seedEpisode()
  const tools: any = createScriptTools(episodeId)
  const result = await tools.saveScript.execute({
    content: `## 二、优化后口播脚本\n她翻开旧账本。\n\n## 八、封面设计方案\n### 封面 A：悬念型\n- **主标题文案**：账本里的秘密\n- **副标题文案**：一笔银子如何改变所有人\n- **AI图片生成提示词**：cinematic old ledger close-up, highly detailed, no text, no watermark\n- **为什么有效**：具体物件制造追问。`,
  })

  assert.equal(result.cover_design_saved, true)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(JSON.parse(episode.coverDesignJson || '{}').main_title, '账本里的秘密')
  assert.match(episode.coverPrompt || '', /old ledger close-up/)
})

test('save_script accepts a separate cover_design object', async () => {
  const episodeId = seedEpisode()
  const tools: any = createScriptTools(episodeId)
  const result = await tools.saveScript.execute({
    content: '## S01 | 内景 · 书房 | 深夜\n他合上账本。',
    cover_design: {
      type: '制度拆解',
      main_title: '谁在付账',
      sub_title: '一场繁华如何转嫁代价',
      ai_prompt: 'cinematic study at night, highly detailed, no text, no watermark',
    },
  })

  assert.equal(result.cover_design_saved, true)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(JSON.parse(episode.coverDesignJson || '{}').main_title, '谁在付账')
})
