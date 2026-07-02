import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-sb-image-prompt-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const {
  buildStoryboardImagePrompt,
  describeDialoguePerformance,
  parseDialogueLines,
} = await import('./storyboard-image-prompt.js')
const { now } = await import('../utils/response.js')

let episodeSeq = 0
function nextEpisodeId() {
  return ++episodeSeq + 1000
}

function createDrama(style?: string) {
  const result = db.insert(schema.dramas).values({
    title: `Test Drama ${nextEpisodeId()}`,
    status: 'draft',
    style: style ?? 'realistic',
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function createEpisode(dramaId: number) {
  const result = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Test Episode',
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function createCharacter(dramaId: number, name: string, appearance?: string) {
  const result = db.insert(schema.characters).values({
    dramaId,
    name,
    appearance: appearance ?? null,
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function createStoryboard(overrides: Partial<typeof schema.storyboards.$inferInsert> & { episodeId: number; storyboardNumber: number }) {
  const result = db.insert(schema.storyboards).values({
    title: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  }).run()
  return Number(result.lastInsertRowid)
}

function bindCharacter(storyboardId: number, characterId: number) {
  db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
}

test('parseDialogueLines parses 角色名：台词 format', () => {
  const lines = parseDialogueLines('小明：你怎么还不走？\n小红：再等一下。')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], { speaker: '小明', text: '你怎么还不走？' })
  assert.deepEqual(lines[1], { speaker: '小红', text: '再等一下。' })
})

test('describeDialoguePerformance: 只演不写字（不含台词原文）', () => {
  const out = describeDialoguePerformance('小明：你怎么还不走？', ['小明'])
  assert.match(out, /小明/)
  assert.match(out, /正在说话/)
  assert.match(out, /疑问|探询/)
  // 关键：不渲染台词文字
  assert.doesNotMatch(out, /你怎么还不走/)
})

test('describeDialoguePerformance: 多角色对话有互动描述', () => {
  const out = describeDialoguePerformance('小明：走吧！\n小红：好！', ['小明', '小红'])
  assert.match(out, /互动|对话/)
  assert.doesNotMatch(out, /走吧/)
})

test('describeDialoguePerformance: 无对白返回空', () => {
  assert.equal(describeDialoguePerformance('', []), '')
  assert.equal(describeDialoguePerformance(null, []), '')
})

test('buildStoryboardImagePrompt: 对白镜头转化为表演且不含台词', () => {
  const episodeId = nextEpisodeId()
  const charId = createCharacter(1, '小明', '黑色短发，白衬衫')
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '咖啡厅内，近景',
    dialogue: '小明：你怎么还不走？',
    action: '小明低头看手机',
  })
  bindCharacter(sbId, charId)

  const prompt = buildStoryboardImagePrompt(sbId)
  assert.match(prompt, /咖啡厅/)
  assert.match(prompt, /正在说话/)
  assert.match(prompt, /黑色短发/)        // 角色外观注入
  assert.doesNotMatch(prompt, /你怎么还不走/) // 不含台词
})

test('buildStoryboardImagePrompt: 无对白纯环境镜头正常拼装', () => {
  const episodeId = nextEpisodeId()
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '空旷的街道，黄昏',
    atmosphere: '暖色调，孤独感',
  })

  const prompt = buildStoryboardImagePrompt(sbId)
  assert.match(prompt, /空旷的街道/)
  assert.match(prompt, /暖色调/)
  assert.doesNotMatch(prompt, /正在说话/)
})

test('buildStoryboardImagePrompt: 上下文承接相邻镜头摘要', () => {
  const episodeId = nextEpisodeId()
  createStoryboard({ episodeId, storyboardNumber: 1, title: '噩梦惊醒' })
  const sb2 = createStoryboard({ episodeId, storyboardNumber: 2, imagePrompt: '主角坐起', title: '坐起身' })
  createStoryboard({ episodeId, storyboardNumber: 3, title: '走向窗边' })

  const prompt = buildStoryboardImagePrompt(sb2)
  assert.match(prompt, /承接上一镜：噩梦惊醒/)
  assert.match(prompt, /将引出下一镜：走向窗边/)
})

test('buildStoryboardImagePrompt: 首尾镜头边界不报错', () => {
  const episodeId = nextEpisodeId()
  const only = createStoryboard({ episodeId, storyboardNumber: 1, imagePrompt: '独镜' })
  const prompt = buildStoryboardImagePrompt(only)
  assert.match(prompt, /独镜/)
})

test('buildStoryboardImagePrompt: 长度预算下必保层不被裁', () => {
  const episodeId = nextEpisodeId()
  const charId = createCharacter(1, '甲', '红衣')
  const longAtmosphere = '氛围'.repeat(2000)
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '关键画面主体',
    dialogue: '甲：快跑！',
    atmosphere: longAtmosphere,
  })
  bindCharacter(sbId, charId)

  const prompt = buildStoryboardImagePrompt(sbId)
  // 必保层保留
  assert.match(prompt, /关键画面主体/)
  assert.match(prompt, /正在说话/)
  assert.match(prompt, /红衣/)
  // 超长可裁层被跳过，整体不会无限膨胀（必保层之外控制在预算附近）
  assert.ok(prompt.length < longAtmosphere.length, '超长氛围层应被裁剪')
})

test('buildStoryboardImagePrompt: 清理 XML 标签', () => {
  const episodeId = nextEpisodeId()
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '<location>咖啡厅</location>，<role>小明</role>站立',
  })
  const prompt = buildStoryboardImagePrompt(sbId)
  assert.doesNotMatch(prompt, /<location>|<\/location>|<role>|<\/role>/)
  assert.match(prompt, /咖啡厅/)
  assert.match(prompt, /小明/)
})

test('buildStoryboardImagePrompt: final image prompt 不再追加动作和上下文', () => {
  const episodeId = nextEpisodeId()
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '横屏16:9，桌上一只旧相框里的校服女孩生活照，窗外雨幕，克制悲伤。',
    imagePromptFinal: true,
    action: '小玲抑郁症跳楼去世',
    atmosphere: '沉重',
  })

  const prompt = buildStoryboardImagePrompt(sbId)
  assert.equal(prompt, '横屏16:9，桌上一只旧相框里的校服女孩生活照，窗外雨幕，克制悲伤。')
  assert.doesNotMatch(prompt, /跳楼|抑郁症|动作|氛围/)
})

test('buildStoryboardImagePrompt: 不存在的分镜返回兜底', () => {
  const prompt = buildStoryboardImagePrompt(999999)
  assert.equal(prompt, 'Storyboard 999999')
})

test('buildStoryboardImagePrompt: 注入本剧视觉风格到 prompt 开头', () => {
  const dramaId = createDrama('ghibli')
  const episodeId = createEpisode(dramaId)
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '草原上的小木屋，黄昏',
  })

  const prompt = buildStoryboardImagePrompt(sbId)
  assert.match(prompt, /^Studio Ghibli style/)
  assert.match(prompt, /草原上的小木屋/)
})

test('buildStoryboardImagePrompt: final prompt 也会补上视觉风格', () => {
  const dramaId = createDrama('anime')
  const episodeId = createEpisode(dramaId)
  const sbId = createStoryboard({
    episodeId,
    storyboardNumber: 1,
    imagePrompt: '赛博朋克街道，霓虹灯',
    imagePromptFinal: true,
  })

  const prompt = buildStoryboardImagePrompt(sbId)
  assert.match(prompt, /^anime style/)
})
