import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-wechat-publish-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const publishModule = await import('./publish-wechat-channels.js') as Record<string, any>

test('wechat publish handler does not auto-retry a browser workflow without checkpoints', () => {
  const handler = publishModule.createPublishWeChatChannelsHandler()

  assert.equal(handler.resumable, false)
  assert.equal(handler.maxAttempts, 1)
})

test('wechat browser window is clamped to the available screen work area', () => {
  assert.equal(typeof publishModule.calculateWeChatWindowBounds, 'function')

  assert.deepEqual(publishModule.calculateWeChatWindowBounds({
    availLeft: 0,
    availTop: 30,
    availWidth: 1440,
    availHeight: 819,
  }, {
    width: 1400,
    height: 860,
  }), {
    left: 20,
    top: 30,
    width: 1400,
    height: 819,
  })
})

test('wechat cover validation checks real pixels instead of the database label', () => {
  assert.equal(publishModule.isWeChatCoverAspectRatioCompatible(1672, 941, '4:3'), false)
  assert.equal(publishModule.isWeChatCoverAspectRatioCompatible(941, 1672, '3:4'), false)
  assert.equal(publishModule.isWeChatCoverAspectRatioCompatible(1200, 900, '4:3'), true)
  assert.equal(publishModule.isWeChatCoverAspectRatioCompatible(900, 1200, '3:4'), true)
})

test('wechat cover normalization produces an exact target ratio', async () => {
  const source = join(dbDir, 'source-16x9.png')
  const outputDir = join(dbDir, 'normalized-covers')
  await sharp({
    create: {
      width: 160,
      height: 90,
      channels: 3,
      background: '#d97706',
    },
  }).png().toFile(source)

  const normalized = await publishModule.ensureWeChatCoverAspectRatio(source, '4:3', outputDir)
  const metadata = await sharp(normalized).metadata()

  assert.notEqual(normalized, source)
  assert.equal(metadata.width, 1200)
  assert.equal(metadata.height, 900)
})

test('wechat cover cards are classified at their real responsive size', () => {
  assert.equal(
    publishModule.classifyWeChatCoverCardGeometry(74, 98),
    '个人主页卡片(3:4)',
  )
  assert.equal(
    publishModule.classifyWeChatCoverCardGeometry(128, 98),
    '分享卡片(4:3)',
  )
  assert.equal(publishModule.classifyWeChatCoverCardGeometry(64, 64), null)
  assert.equal(publishModule.classifyWeChatCoverCardGeometry(40, 80), null)
})

test('wechat publish record selection is isolated by platform', () => {
  assert.equal(typeof publishModule.findPublishRecordForPlatform, 'function')

  const record = publishModule.findPublishRecordForPlatform([
    { id: 11, platform: 'douyin' },
    { id: 12, platform: 'wechat_channels' },
  ], 'wechat_channels')

  assert.equal(record?.id, 12)
})

test('video is ready only after both generated cover cards are available', () => {
  assert.equal(typeof publishModule.isWeChatVideoReady, 'function')

  assert.equal(publishModule.isWeChatVideoReady({
    hasCoverPreview: true,
    hasVisibleVideo: true,
    generating: true,
    personalCoverSrc: null,
    shareCoverSrc: null,
  }), false)

  assert.equal(publishModule.isWeChatVideoReady({
    hasCoverPreview: true,
    hasVisibleVideo: true,
    generating: false,
    uploading: false,
    personalCoverSrc: 'https://example.test/personal.jpg',
    shareCoverSrc: 'https://example.test/share.jpg',
  }), true)

  // 封面缩略图已生成，但文件仍在上传（uploading=true）时不算就绪——否则会在
  // 「文件上传中，请等待完成后再编辑」横幅下点封面编辑，弹窗打不开。
  assert.equal(publishModule.isWeChatVideoReady({
    hasCoverPreview: true,
    hasVisibleVideo: true,
    generating: false,
    uploading: true,
    personalCoverSrc: 'https://example.test/personal.jpg',
    shareCoverSrc: 'https://example.test/share.jpg',
  }), false)
})

test('an in-progress video page is resumed without selecting the video again', () => {
  assert.equal(typeof publishModule.shouldStartWeChatVideoUpload, 'function')

  assert.equal(publishModule.shouldStartWeChatVideoUpload({
    hasCoverPreview: true,
    hasVisibleVideo: true,
    generating: true,
    personalCoverSrc: null,
    shareCoverSrc: null,
  }), false)

  assert.equal(publishModule.shouldStartWeChatVideoUpload({
    hasCoverPreview: false,
    hasVisibleVideo: false,
    generating: false,
    personalCoverSrc: null,
    shareCoverSrc: null,
  }), true)
})

test('wechat publish checkpoints preserve prior evidence', () => {
  assert.equal(typeof publishModule.mergeWeChatPublishCheckpoint, 'function')
  assert.equal(publishModule.getWeChatPublishSessionKey(436), 'huobao-wechat-publish-episode-436')

  const videoReady = publishModule.mergeWeChatPublishCheckpoint(null, 'video_ready', {
    personalCoverSrc: 'generated-personal',
    shareCoverSrc: 'generated-share',
  })
  const personalDone = publishModule.mergeWeChatPublishCheckpoint(videoReady, 'cover_3x4_done', {
    uploadedPersonalCoverSrc: 'custom-personal',
  })

  assert.equal(personalDone.phase, 'cover_3x4_done')
  assert.equal(personalDone.personalCoverSrc, 'generated-personal')
  assert.equal(personalDone.shareCoverSrc, 'generated-share')
  assert.equal(personalDone.uploadedPersonalCoverSrc, 'custom-personal')
})

test('a cover is skipped only when the current card matches checkpoint evidence', () => {
  assert.equal(typeof publishModule.shouldSkipWeChatCoverUpload, 'function')
  const checkpoint = publishModule.mergeWeChatPublishCheckpoint(null, 'cover_4x3_done', {
    uploadedPersonalCoverSrc: 'custom-personal',
    uploadedShareCoverSrc: 'custom-share',
  })

  assert.equal(publishModule.shouldSkipWeChatCoverUpload('个人主页卡片(3:4)', 'custom-personal', checkpoint), true)
  assert.equal(publishModule.shouldSkipWeChatCoverUpload('分享卡片(4:3)', 'generated-share', checkpoint), false)
})

test('draft persistence requires new evidence rather than an old nonzero count', () => {
  assert.equal(typeof publishModule.isWeChatDraftPersistenceVerified, 'function')

  assert.equal(publishModule.isWeChatDraftPersistenceVerified(
    { draftCount: 2, hasExpectedTitle: false },
    { draftCount: 2, hasExpectedTitle: false },
  ), false)
  assert.equal(publishModule.isWeChatDraftPersistenceVerified(
    { draftCount: 2, hasExpectedTitle: false },
    { draftCount: 3, hasExpectedTitle: false },
  ), true)
  assert.equal(publishModule.isWeChatDraftPersistenceVerified(
    { draftCount: 2, hasExpectedTitle: false },
    { draftCount: 2, hasExpectedTitle: true },
  ), true)
  assert.equal(publishModule.isWeChatDraftPersistenceVerified(
    { draftCount: 2, hasExpectedTitle: true },
    { draftCount: 2, hasExpectedTitle: true },
  ), false)
  assert.equal(publishModule.isWeChatDraftPersistenceVerified(
    { draftCount: 0, hasExpectedTitle: false },
    { draftCount: 0, hasExpectedTitle: true },
  ), false)
})

test('share-card popover is not treated as the real cover editor', () => {
  assert.equal(typeof publishModule.isWeChatCoverEditorReady, 'function')

  assert.equal(publishModule.isWeChatCoverEditorReady('分享卡片(4:3)', {
    dialogTitle: null,
    popoverVisible: true,
  }), false)
  assert.equal(publishModule.isWeChatCoverEditorReady('分享卡片(4:3)', {
    dialogTitle: '编辑分享卡片',
    popoverVisible: false,
  }), true)
})

test('sanitizeDescriptionForWeChat strips markdown/structure and clamps to 100-200 chars', () => {
  const raw = '本集以"一条鞭法"为核心主题。\n\n**叙事脉络（起承转合）：**\n【起】从流民切入——他们被税收逼到绝境。\n【承】' + '张居正改革逐步失控。'.repeat(20)
  const out = publishModule.sanitizeDescriptionForWeChat(raw)
  assert.ok(!out.includes('*'), 'no markdown asterisks')
  assert.ok(!out.includes('#'), 'no hash (avoids topic autocomplete)')
  assert.ok(!out.includes('【'), 'no section markers')
  assert.ok(!out.includes('叙事脉络'), 'label-only line dropped')
  assert.ok(out.length <= 200, `length ${out.length} <= 200`)
  assert.ok(out.length >= 100, `length ${out.length} >= 100`)
})

test('sanitizeDescriptionForWeChat returns short clean text unchanged', () => {
  assert.equal(publishModule.sanitizeDescriptionForWeChat('简短描述。'), '简短描述。')
  assert.equal(publishModule.sanitizeDescriptionForWeChat(''), '')
})
