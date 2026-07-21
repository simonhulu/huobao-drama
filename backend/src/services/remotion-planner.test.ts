import test from 'node:test'
import assert from 'node:assert/strict'
import { planRemotionShots, segmentScriptToStoryboards } from './remotion-planner.js'
import { REMOTION_SHOT_RHYTHM } from './remotion-segmentation.js'

const stockCatalog = [{
  provider: 'pixabay',
  videoId: 'crowd-1',
  query: 'historical crowd gathering',
  title: 'historical village gathering',
  localPath: 'data/static/remotion/stock/pixabay-23258.mp4',
  duration: 18,
}]

test('planner rejects modern stock footage for historical crowd scenes', () => {
  const plan = planRemotionShots([{
    storyboardNumber: 1,
    title: '会众聚集',
    action: '会众在村落聚集',
    narration: '村里的会众聚集起来。',
    duration: 5,
  }], [], [{
    provider: 'pixabay',
    videoId: 'modern-city',
    query: 'crowd people street',
    title: 'seoul urban night market',
    localPath: 'data/static/remotion/stock/pixabay-modern.mp4',
  }])
  assert.equal(plan.shots[0].shotType, 'ai_plate')
  assert.equal(plan.assets.some((asset) => asset.assetType === 'stock_video'), false)
})

test('Remotion planner keeps maps, stock b-roll, and layered people distinct', () => {
  const plan = planRemotionShots([
    {
      id: 12,
      storyboardNumber: 12,
      title: '洪秀全广州奔走',
      location: '广州城街道',
      action: '洪秀全奔走营救冯云山',
      narration: '洪秀全跑去广州营救冯云山。',
      duration: 6,
    },
    {
      id: 13,
      storyboardNumber: 13,
      title: '群龙无首的会众',
      action: '会众聚集，焦虑不安',
      narration: '会众开始聚集，没人知道该听谁的。',
      duration: 5,
    },
    {
      id: 16,
      storyboardNumber: 16,
      title: '杨秀清站出来',
      action: '杨秀清从草棚外走出',
      narration: '杨秀清站了出来。',
      duration: 5,
    },
    {
      id: 31,
      storyboardNumber: 31,
      title: '洪秀全也回来了',
      action: '洪秀全和冯云山相遇，远处有杨秀清和萧朝贵，会众聚集',
      narration: '洪秀全和冯云山回来了。',
      duration: 5,
    },
  ], [], stockCatalog)

  assert.deepEqual(plan.shots.map((shot) => shot.shotType), ['map', 'stock', 'hybrid', 'hybrid'])

  const characterShot = plan.shots.find((shot) => shot.shotNumber === 16)
  assert.equal(characterShot?.visualPlan.visualMode, 'hybrid-composite')
  assert.equal(characterShot?.visualPlan.layerMode, 'alpha-composite')
  assert.equal(characterShot?.visualSetupId, 'setup-杨秀清站出来')
  assert.deepEqual(characterShot?.visualPlan.motionChannels, ['camera', 'parallax', 'subject-pose'])
  assert.equal(characterShot?.visualPlan.assetStrategy, 'static-layered-remotion')
  assert.equal(characterShot?.visualPlan.fallback, '等待透明人物层时使用 AI clean plate 或素材库 cutaway，不回退为单人物整图')
  assert.equal(characterShot?.shotType, 'hybrid')
  assert.equal((characterShot?.visualPlan.renderContract as any).forbidFullFrameCharacter, true)
  assert.ok(plan.assets.some((asset) => asset.assetKey === 'shot-16-scene-plate' && asset.assetType === 'ai_image'))
  assert.ok(plan.assets.some((asset) => asset.assetKey === 'shot-16-character-yang-xiuqing' && asset.assetType === 'character'))
  assert.equal(
    (plan.assets.find((asset) => asset.assetKey === 'shot-16-character-yang-xiuqing')?.metadata as any).reuseKey,
    'setup-杨秀清站出来-character-yang-xiuqing',
  )
  assert.equal((plan.assets.find((asset) => asset.assetKey === 'shot-16-scene-plate')?.metadata as any).reuseKey, 'setup-杨秀清站出来-scene-plate')

  const hybridShot = plan.shots.find((shot) => shot.shotNumber === 31)
  assert.equal(hybridShot?.visualPlan.visualMode, 'hybrid-composite')
  assert.equal(plan.summary.shotTypes.map, 1)
  assert.equal(plan.summary.shotTypes.stock, 1)
  assert.equal(plan.summary.shotTypes.character, 0)
  assert.equal(plan.summary.shotTypes.hybrid, 2)
  assert.equal((hybridShot?.visualPlan.stock as any).usage, 'cutaway')
  assert.equal((hybridShot?.visualPlan.stock as any).presentation, 'inset-cutaway')
})

test('map routes use verified waypoint locations only when they are named places', () => {
  const [shot] = planRemotionShots([{
    storyboardNumber: 39,
    title: '天京事变的远因',
    location: '广西紫荆山 → 天京（南京）',
    action: '裂缝从紫荆山延伸到天京',
    narration: '这道裂缝一直延伸到天京。',
    duration: 4,
  }]).shots
  const map = shot.visualPlan.map as any
  assert.deepEqual(map.locations.map((location: any) => location.id), ['guiping', 'nanjing'])
  assert.equal(map.routes[0].waypoints.length, 2)
  assert.equal(map.routes[0].historyStatus, 'illustrative')
})

test('trade and silver-flow language selects the world map renderer', () => {
  const plan = planRemotionShots([
    {
      storyboardNumber: 13,
      title: '贸易顺差',
      location: '广州港与世界市场',
      action: '茶叶、丝绸和瓷器出海，白银流入中国',
      narration: '贸易流向改变了白银的方向。',
      duration: 8,
    },
  ])
  const shot = plan.shots[0]
  assert.equal(shot.shotType, 'map')
  assert.equal(shot.visualPlan.visualMode, 'silver-flow-map-video')
  assert.equal((shot.visualPlan.map as any).renderer, 'remotion-map-video')
  assert.equal((shot.visualPlan.map as any).bounds.minLon, -20)
  assert.deepEqual((shot.visualPlan.map as any).routes.map((route: any) => route.id), ['industrial-goods', 'silver-to-china'])
  assert.deepEqual((shot.visualPlan.characters as any[]), [])
})

test('raw narration is segmented into documentary-sized shots', () => {
  const script = Array.from({ length: 80 }, (_, index) => (
    `第${index + 1}个节点改变了局势，人物开始承担新的代价，市场也因此出现了完全不同的方向。`
  )).join('')
  const storyboards = segmentScriptToStoryboards(script)
  const plan = planRemotionShots(storyboards)

  assert.ok(storyboards.length > 20)
  assert.ok(plan.shots.length > 20)
  assert.ok(plan.shots.every((shot) => shot.durationMs <= REMOTION_SHOT_RHYTHM.maxShotDurationMs))
  assert.ok(plan.shots.every((shot) => shot.durationMs <= REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs))
  assert.ok(plan.shots.every((shot) => shot.beatIds.length > 0))
})

test('script paragraph boundaries provide stable reusable visual setups', () => {
  const storyboards = segmentScriptToStoryboards([
    '第一段包含足够长的叙事，应该被拆成多个镜头，同时保持同一场景。'.repeat(4),
    '第二段切换到新的叙事空间，也应该使用新的场景。',
  ].join('\n\n'))
  const plan = planRemotionShots(storyboards)
  const firstSetup = plan.shots[0]?.visualSetupId
  assert.ok(firstSetup)
  assert.ok(plan.shots.filter((shot) => shot.visualSetupId === firstSetup).length > 1)
  assert.equal(plan.shots.at(-1)?.visualSetupId, 'script-paragraph-2')
  const firstSetupAssetReuseKeys = plan.assets
    .filter((asset) => (asset.metadata as any)?.visualSetupId === firstSetup)
    .map((asset) => (asset.metadata as any)?.reuseKey)
  assert.ok(firstSetupAssetReuseKeys.length > 1)
  assert.equal(new Set(firstSetupAssetReuseKeys).size, 1)
})

test('generic Rockefeller narration is not misclassified as a migration map by shot number', () => {
  const [shot] = planRemotionShots([{
    storyboardNumber: 12,
    title: '托拉斯结构',
    action: '标准石油把分散资产放入统一管理结构。',
    narration: '结构一旦建立，财富机器会自己运转。',
    duration: 5,
  }]).shots
  assert.equal(shot.shotType, 'ai_plate')
  assert.equal(shot.visualPlan.map, undefined)
})

test('character layers follow visible action rather than a narration name drop', () => {
  const narrationOnly = planRemotionShots([{
    storyboardNumber: 1,
    title: '资产流动',
    shotType: 'ai_plate',
    action: '账本沿着铁路转手，运输成本随之下降。',
    narration: '洛克菲勒的帝国随后扩张。',
    duration: 5,
  }]).shots[0]
  assert.equal(narrationOnly?.shotType, 'ai_plate')
  assert.deepEqual(narrationOnly?.visualPlan.characters, [])

  const visibleAction = planRemotionShots([{
    storyboardNumber: 2,
    title: '签下协议',
    shotType: 'ai_plate',
    action: '洛克菲勒按住协议，在铁路公司的代表面前签字。',
    narration: '这份协议改变了运输成本。',
    duration: 5,
  }]).shots[0]
  assert.equal(visibleAction?.shotType, 'hybrid')
  assert.equal((visibleAction?.visualPlan.characters as any[]).length, 1)
})

test('planner does not invent an establishing beat when no semantic beats exist', () => {
  const [shot] = planRemotionShots([{
    storyboardNumber: 1,
    title: '有动作但没有 beat 数据',
    action: '洛克菲勒在账桌前记账。',
    narration: '他开始记录每一笔收入。',
    duration: 5,
  }]).shots
  assert.deepEqual(shot.visualPlan.beats, [])
  assert.equal((shot.visualPlan.beats as any[]).some((beat) => (beat as any).role === 'establishing'), false)
})

test('planner keeps a validated story contract attached to the shot', () => {
  const story = {
    beatId: 'B01-E01',
    sourceSpans: [{ start: 0, end: 12, text: '洛克菲勒签下协议' }],
    function: 'event',
    actorIds: ['P01'],
    target: '铁路公司',
    action: '洛克菲勒与铁路公司交换并签下协议',
    phase: 'execute',
    beforeState: '运输成本相同',
    afterState: '运输成本降低',
    visualProof: ['手部签字和协议落章'],
  }
  const [shot] = planRemotionShots([{
    storyboardNumber: 1,
    title: '铁路折扣协议',
    action: story.action,
    narration: '洛克菲勒签下铁路折扣协议。',
    duration: 5,
    people: ['P01'],
    visualPlan: {
      characters: [{ actorId: 'P01', name: '洛克菲勒', layerType: 'character-alpha' }],
      story,
    },
  }]).shots
  assert.equal((shot.visualPlan.story as any).beatId, 'B01-E01')
  assert.deepEqual(shot.beatIds, ['B01-E01'])
  assert.equal((shot.sourceEvidence.story as any).target, '铁路公司')
})

test('planner preserves an explicit temporal-2grid story shot without runtime layers', () => {
  const story = {
    beatId: 'B01-E02',
    sourceSpans: [{ start: 0, end: 14, text: '洛克菲勒签下协议' }],
    function: 'event',
    actorIds: ['P01'],
    target: '铁路公司',
    action: '洛克菲勒按住协议并签下折扣条款',
    phase: 'execute',
    beforeState: '铁路公司尚未给出折扣',
    afterState: '折扣条款落印并开始生效',
    visualProof: ['手部签字、协议落章和铁路印章'],
    nextBeatId: null,
  }
  const [shot] = planRemotionShots([{
    storyboardNumber: 1,
    title: '铁路折扣协议',
    action: story.action,
    result: story.afterState,
    narration: '洛克菲勒签下铁路折扣协议。',
    duration: 5,
    people: ['P01'],
    visualPlan: {
      visualMode: 'temporal-2grid',
      assetStrategy: 'temporal-2grid-remotion',
      actorIds: ['P01'],
      story,
      temporalGrid: {
        schemaVersion: 1,
        layout: '2x1',
        rows: 1,
        columns: 2,
        sheetAssetKey: 'shot-1-temporal-2grid',
        panels: [
          { index: 0, semantic: '洛克菲勒按住协议，铁路代表仍在犹豫', visualProof: '未落印的协议和伸出的手' },
          { index: 1, semantic: '铁路代表盖章，折扣条款正式生效', visualProof: '落下的印章和已签字的协议' },
        ],
        keyframes: [
          { atMs: 0, panel: 0, sourceIndex: 0, action: '洛克菲勒按住协议，铁路代表仍在犹豫' },
          { atMs: 2500, panel: 1, sourceIndex: 1, action: '铁路代表盖章，折扣条款正式生效' },
        ],
      },
      motion: { camera: 'push-in', transition: 'crossfade' },
    },
  }]).shots

  assert.equal(shot.shotType, 'hybrid')
  assert.equal(shot.visualPlan.visualMode, 'temporal-2grid')
  assert.equal(shot.visualPlan.assetStrategy, 'temporal-2grid-remotion')
  assert.deepEqual(shot.visualPlan.layers, [])
  assert.deepEqual(shot.visualPlan.characters, [])
  assert.equal((shot.visualPlan.renderContract as any).renderer, 'remotion-temporal-grid')
  assert.equal((shot.visualPlan.renderContract as any).forbidRuntimeLayers, true)
  assert.equal((shot.visualPlan.renderContract as any).forbidRuntimeCards, true)
  assert.deepEqual(shot.visualPlan.motionChannels, [
    'temporal-keyframe-reveal',
    'ken-burns-camera',
    'shot-transition',
  ])
  assert.deepEqual(planRemotionShots([{
    storyboardNumber: 1,
    title: '铁路折扣协议',
    action: story.action,
    result: story.afterState,
    narration: '洛克菲勒签下铁路折扣协议。',
    duration: 5,
    visualPlan: {
      visualMode: 'temporal-2grid',
      assetStrategy: 'temporal-2grid-remotion',
      actorIds: ['P01'],
      story,
      temporalGrid: {
        schemaVersion: 1,
        layout: '2x1',
        rows: 1,
        columns: 2,
        sheetAssetKey: 'shot-1-temporal-2grid',
        panels: [
          { index: 0, semantic: '签字前', visualProof: '未落印的协议' },
          { index: 1, semantic: '签字后', visualProof: '已落印的协议' },
        ],
        keyframes: [
          { atMs: 0, panel: 0 },
          { atMs: 2500, panel: 1 },
        ],
      },
    },
  }]).assets.map((asset) => ({ key: asset.assetKey, type: asset.assetType, role: (asset.metadata as any)?.role })), [
    { key: 'shot-1-temporal-2grid', type: 'ai_image', role: 'temporal-2grid-sheet' },
  ])
})

test('known Rockefeller characters reuse local alpha-ready layers', () => {
  const plan = planRemotionShots([{
    storyboardNumber: 1,
    title: '少年洛克菲勒',
    action: '洛克菲勒在账桌前记账。',
    narration: '洛克菲勒很早学会把每一笔钱记下来。',
    duration: 5,
  }])
  const character = plan.assets.find((asset) => asset.assetType === 'character')
  assert.equal(plan.shots[0]?.shotType, 'hybrid')
  assert.equal(character?.provider, 'local-library')
  assert.equal(character?.status, 'completed')
  assert.equal(character?.metadata && (character.metadata as any).alphaReady, true)
  assert.match(String(character?.localPath), /data\/static\/remotion\/project-2\/characters/)
})

test('character asset rows stay unique while reuseKey stays setup-scoped', () => {
  const plan = planRemotionShots([
    {
      storyboardNumber: 1,
      title: '同一场景一',
      action: '洛克菲勒在账桌前记账。',
      narration: '他开始记录每一笔收入。',
      duration: 5,
      visualPlan: { visualSetupId: 'shared-setup' },
    },
    {
      storyboardNumber: 2,
      title: '同一场景二',
      action: '洛克菲勒继续核对账本。',
      narration: '他把账本反复核对。',
      duration: 5,
      visualPlan: { visualSetupId: 'shared-setup' },
    },
  ])
  const characterAssets = plan.assets.filter((asset) => asset.assetType === 'character')
  assert.deepEqual(characterAssets.map((asset) => asset.assetKey), [
    'shot-1-character-约翰-d-洛克菲勒',
    'shot-2-character-约翰-d-洛克菲勒',
  ])
  assert.deepEqual(characterAssets.map((asset) => (asset.metadata as any).reuseKey), [
    'shared-setup-character-约翰-d-洛克菲勒',
    'shared-setup-character-约翰-d-洛克菲勒',
  ])
})

test('a legacy 100-second storyboard is split before planning', () => {
  const narration = Array.from({ length: 36 }, (_, index) => (
    `第${index + 1}段叙事说明了成本、信息和权力之间的变化。`
  )).join('')
  const plan = planRemotionShots([{
    storyboardNumber: 1,
    title: '旧分镜长段落',
    narration,
    duration: 100,
  }])

  assert.ok(plan.shots.length > 10)
  assert.equal(plan.shots.reduce((sum, shot) => sum + shot.durationMs, 0), 100000)
  assert.ok(plan.shots.every((shot) => shot.durationMs <= REMOTION_SHOT_RHYTHM.maxShotDurationMs))
})
