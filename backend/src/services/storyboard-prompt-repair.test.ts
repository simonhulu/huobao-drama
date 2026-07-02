import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-prompt-repair-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { repairStoryboardImagePromptForGeneration } = await import('./storyboard-prompt-repair.js')

const originalFetch = global.fetch

test.afterEach(() => {
  global.fetch = originalFetch
  delete process.env.STORYBOARD_PROMPT_REPAIR_MODEL
})

test('repairStoryboardImagePromptForGeneration uses deepseek-v4-flash and updates storyboard plus generation prompt', async () => {
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'DeepSeek text',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: JSON.stringify(['deepseek-v4-pro']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 1,
    title: 'Episode',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 21,
    title: '小玲的遗像',
    imagePrompt: '横屏16:9特写桌上遗像相框。十六七岁女孩穿整洁校服。',
    action: '小玲抑郁症跳楼去世，学校想把事情压下去',
    atmosphere: '克制悲伤',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const generationId = Number(db.insert(schema.imageGenerations).values({
    storyboardId,
    dramaId: 1,
    provider: 'apimart',
    prompt: 'unsafe prompt',
    model: 'gpt-image-2',
    size: '1024x576',
    status: 'failed',
    taskId: 'remote-task-1',
    errorMsg: 'Your request was rejected by the safety system.',
    lastErrorCode: 'content_policy_violation',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  let requestBody: any
  global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"image_prompt":"横屏16:9，桌上一只旧相框里的年轻女性生活照，窗外雨幕，家人沉默坐在背景中，克制悲伤。"}',
        },
      }],
    }), { status: 200 })
  }) as typeof fetch

  const result = await repairStoryboardImagePromptForGeneration(
    generationId,
    'Your request was rejected by the safety system.',
  )

  assert.equal(requestBody.model, 'deepseek-v4-flash')
  assert.match(requestBody.messages[0].content, /视觉任务/)
  assert.match(requestBody.messages[1].content, /小玲的遗像/)
  assert.equal(result.repairedPrompt, '横屏16:9，桌上一只旧相框里的年轻女性生活照，窗外雨幕，家人沉默坐在背景中，克制悲伤。')
  assert.equal(result.model, 'deepseek-v4-flash')

  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  assert.equal(storyboard.imagePrompt, result.repairedPrompt)

  const [generation] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, generationId)).all()
  assert.equal(generation.prompt, result.repairedPrompt)
  assert.equal(generation.status, 'processing')
  assert.equal(generation.taskId, null)
  assert.equal(generation.errorMsg, null)
  assert.equal(generation.lastErrorCode, null)
})

test('repair model can be overridden by STORYBOARD_PROMPT_REPAIR_MODEL', async () => {
  process.env.STORYBOARD_PROMPT_REPAIR_MODEL = 'custom-cheap-model'
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'DeepSeek text override',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: JSON.stringify(['deepseek-v4-pro']),
    isActive: true,
    priority: 10,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 2,
    title: 'Episode',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '危险镜头',
    imagePrompt: '危险提示词',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const generationId = Number(db.insert(schema.imageGenerations).values({
    storyboardId,
    provider: 'apimart',
    prompt: 'unsafe prompt',
    model: 'gpt-image-2',
    size: '1024x576',
    status: 'failed',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  let model = ''
  global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    model = JSON.parse(String(init?.body)).model
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"image_prompt":"安全 prompt"}' } }],
    }), { status: 200 })
  }) as typeof fetch

  const result = await repairStoryboardImagePromptForGeneration(generationId, 'content policy')
  assert.equal(model, 'custom-cheap-model')
  assert.equal(result.model, 'custom-cheap-model')
})

test('repair retries with stricter prompt when repaired prompt keeps the same visual task', async () => {
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'DeepSeek text retry',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: JSON.stringify(['deepseek-v4-pro']),
    isActive: true,
    priority: 20,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 3,
    title: 'Episode',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '小玲的遗像',
    imagePrompt: '遗像相框',
    action: '抑郁症跳楼去世',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const originalPrompt = '横屏16:9特写桌上遗像相框，十六七岁女孩穿整洁校服，背景是雨窗和悲伤家人。'
  const generationId = Number(db.insert(schema.imageGenerations).values({
    storyboardId,
    provider: 'apimart',
    prompt: originalPrompt,
    model: 'gpt-image-2',
    size: '1024x576',
    status: 'failed',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const bodies: any[] = []
  global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    const imagePrompt = bodies.length === 1
      ? originalPrompt
      : '桌上旧相框里的年轻女性生活照，窗外雨幕，家人沉默坐在背景中，克制悲伤。'
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ image_prompt: imagePrompt }) } }],
    }), { status: 200 })
  }) as typeof fetch

  const result = await repairStoryboardImagePromptForGeneration(generationId, 'content policy')
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].response_format.type, 'json_object')
  assert.equal(bodies[0].thinking.type, 'disabled')
  assert.match(bodies[1].messages[1].content, /修正后的 prompt 与原 prompt 过于接近/)
  assert.match(bodies[1].messages[1].content, /改变“画面要生成的任务”/)
  assert.equal(result.repairedPrompt, '桌上旧相框里的年轻女性生活照，窗外雨幕，家人沉默坐在背景中，克制悲伤。')
})
