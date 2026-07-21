import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRemotionStageOutput } from './remotion-contract.js'

function envelope(factoryStage: string, payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    factoryStage,
    artifacts: [],
    checks: [],
    risks: [],
    ...payload,
  }
}

function directorPlan() {
  return {
    schemaVersion: 1,
    genre: 'historical-biography-docudrama',
    format: '历史人物传记式纪录片',
    protagonist: { name: '吕雉', arc: '从家庭创伤走向具体的政治决策' },
    dramaticQuestion: '她如何把个人处境转化为行动权？',
    thesis: '用可观察的动作和后果推动人物，而不是用抽象隐喻代替事件。',
    scenes: [{
      id: 'S1', location: '长乐宫', time: '西汉初年', purpose: '让一次政令通过人物动作产生后果',
      emotionalTurn: '等待转为执行', characters: ['吕雉', '官员'], conflict: '官员等待决定',
      anchorAction: '吕雉接过奏牍并把诏令递给中官', exitTransition: '传令脚步接下一 beat',
    }],
    beats: [{
      id: 'B01', sceneId: 'S1', sourceSpans: [{ start: 0, end: 18, text: '她接过奏牍并交出诏令' }],
      function: 'event', actorIds: ['吕雉'], target: '奏牍与诏令', action: '吕雉按住奏牍并把诏令递给中官',
      beforeState: '奏牍仍在官员手中，执行方向未定', afterState: '诏令离开案几，中官转身执行',
      result: '官员让开通道，政令开始向殿外传递', visualProof: ['手接奏牍', '中官接令转身'],
      causalReason: '动作把抽象权力变成可见的执行链', nextBeatId: null,
      shot: {
        shotType: '中景', angle: '过肩', blocking: '官员递出奏牍，中官在侧后方等待',
        camera: '从奏牍推到递令动作', transition: '脚步声接到下一场',
        reference: { shotCafeQuery: 'https://shot.cafe/tag/hands', flimQuery: 'official receives scroll in palace', transferableRule: '保持人物视线轴和递交动作清晰' },
      },
      assetStrategy: 'new-static-image',
    }],
    visualRules: {
      continuityAnchors: ['人物服饰', '奏牍和诏令'],
      forbiddenPatterns: ['棋盘隐喻', '抽象权力空间', '分屏拼贴'],
      periodAndStyle: '汉初历史质感，克制写实纪录片风格',
    },
  }
}

function staticLayeredPlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    visualSetupId: 'setup-court-01',
    assetStrategy: 'static-layered-remotion',
    layers: [
      { assetKey: 'setup-court-01-scene', role: 'background', zIndex: 0 },
      { assetKey: 'setup-court-01-ruler', role: 'character', zIndex: 20, requiresAlpha: true },
    ],
    motion: {
      camera: 'restrained-push-in',
      parallax: 'three-depth',
      subject: 'staggered-enter-breathe-pose-swap',
      text: 'phrase-reveal',
      transition: 'narrative-cut',
    },
    motionChannels: ['camera', 'parallax', 'subject-pose'],
    audioCues: ['narration'],
    ...overrides,
  }
}

function storyContract(overrides: Record<string, unknown> = {}) {
  return {
    beatId: 'B01-E01',
    sourceSpans: [{ start: 0, end: 24, text: '洛克菲勒与铁路公司签下运输协议' }],
    function: 'event',
    actorIds: ['P01'],
    target: '铁路公司',
    action: '洛克菲勒与铁路公司交换并签下运输协议',
    phase: 'execute',
    beforeState: '运输成本与竞争对手相同',
    afterState: '他的运输成本低于竞争对手',
    visualProof: ['手部签字并盖章', '账簿两栏运价出现差异'],
    nextBeatId: 'B01-E02',
    ...overrides,
  }
}

function temporalGridPlan(overrides: Record<string, unknown> = {}) {
  const sheetAssetKey = 'shot-1-temporal-sheet'
  return {
    schemaVersion: 1,
    visualSetupId: sheetAssetKey,
    assetStrategy: 'temporal-2grid-remotion',
    visualMode: 'temporal-2grid',
    layers: [],
    actorIds: ['P01'],
    motion: {
      camera: 'restrained-push-in',
      parallax: 'sheet-crop',
      subject: 'temporal-state-change',
      text: 'phrase-reveal',
      transition: 'narrative-cut',
    },
    motionChannels: ['temporal-grid-crop', 'camera'],
    audioCues: ['narration'],
    story: storyContract(),
    temporalGrid: {
      schemaVersion: 1,
      sheetAssetKey,
      rows: 1,
      columns: 2,
      panels: [
        { index: 0, semantic: '谈判前的高运价', visualProof: '账簿显示原始运价', storyBeatId: 'B01-E01' },
        { index: 1, semantic: '协议落章后成本下降', visualProof: '印章压下，账簿出现较低运价', storyBeatId: 'B01-E01' },
      ],
      keyframes: [
        { atMs: 0, panel: 0 },
        { atMs: 2800, panel: 1 },
      ],
    },
    renderContract: {
      renderer: 'remotion-temporal-grid',
      forbidRuntimeCards: true,
      forbidRuntimeLayers: true,
      forbidI2V: true,
    },
    ...overrides,
  }
}

function temporalShot(overrides: Record<string, unknown> = {}) {
  return {
    shotNumber: 1,
    durationMs: 5000,
    shotType: 'graphic',
    visualSetupId: 'shot-1-temporal-sheet',
    beatIds: ['B01-E01'],
    visualPlan: temporalGridPlan(),
    ...overrides,
  }
}

test('zero-I2V storyboard contract requires setup, motion channels, and audio cue', () => {
  assert.doesNotThrow(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    shots: [{
      shotNumber: 1,
      durationMs: 5000,
      shotType: 'hybrid',
      visualSetupId: 'setup-court-01',
      beatIds: ['beat-1'],
      visualPlan: staticLayeredPlan(),
    }],
  })))

  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    shots: [{
      shotNumber: 1,
      durationMs: 5000,
      shotType: 'hybrid',
      visualSetupId: 'setup-court-01',
      beatIds: ['beat-1'],
      visualPlan: staticLayeredPlan({ motionChannels: ['camera'] }),
    }],
  })), /motionChannels: Too small|motionChannels/)
})

test('story-first shots require a complete story contract', () => {
  const valid = staticLayeredPlan({
    characters: [{ actorId: 'P01', name: '洛克菲勒' }],
    story: storyContract(),
  })
  assert.doesNotThrow(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    storyFirst: true,
    directorPlan: directorPlan(),
    shots: [{
      shotNumber: 1,
      durationMs: 5000,
      shotType: 'hybrid',
      visualSetupId: 'setup-court-01',
      beatIds: ['B01-E01'],
      visualPlan: valid,
    }],
  })))

  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    storyFirst: true,
    directorPlan: directorPlan(),
    shots: [{
      shotNumber: 1,
      durationMs: 5000,
      shotType: 'hybrid',
      visualSetupId: 'setup-court-01',
      beatIds: ['B01-E01'],
      visualPlan: staticLayeredPlan({
        characters: [{ actorId: 'P01', name: '洛克菲勒' }],
        story: storyContract({ target: '' }),
      }),
    }],
  })), /story contract.*target/)

  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    storyFirst: true,
    directorPlan: directorPlan(),
    shots: [{
      shotNumber: 1,
      durationMs: 5000,
      shotType: 'hybrid',
      visualSetupId: 'setup-court-01',
      beatIds: ['B01-E01'],
      visualPlan: staticLayeredPlan({
        characters: [{ actorId: 'P01', name: '洛克菲勒' }],
        story: storyContract({ nextBeatId: undefined }),
      }),
    }],
  })), /nextBeatId/)
})

test('temporal-2grid requires two semantic states and an independent sheet', () => {
  assert.doesNotThrow(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot()],
  })))

  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot({ visualPlan: temporalGridPlan({ layers: [{ assetKey: 'runtime-card' }] }) })],
  })), /forbids runtime layers/)

  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot({
      visualPlan: temporalGridPlan({
        temporalGrid: {
          ...temporalGridPlan().temporalGrid,
          panels: temporalGridPlan().temporalGrid.panels.map((panel: Record<string, unknown>) => ({ ...panel, semantic: '同一状态' })),
        },
      }),
    })],
  })), /two distinct semantics/)

  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot({
      visualPlan: temporalGridPlan({
        temporalGrid: {
          ...temporalGridPlan().temporalGrid,
          keyframes: [
            { atMs: 0, panel: 0 },
            { atMs: 100, panel: 0 },
            { atMs: 200, panel: 0 },
            { atMs: 300, panel: 0 },
          ],
        },
      }),
    })],
  })), /keyframes must cover panels/)

  const second = temporalShot({
    shotNumber: 2,
    visualSetupId: 'shot-2-temporal-sheet',
    visualPlan: temporalGridPlan({ visualSetupId: 'shot-2-temporal-sheet' }),
  })
  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot(), second],
  })), /independent sheetAssetKey/)
})

test('temporal-2grid rejects ai plates and concept-only fallbacks', () => {
  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot({ shotType: 'ai_plate' })],
  })), /cannot use ai_plate/)
  assert.throws(() => validateRemotionStageOutput('storyboard', envelope('storyboard', {
    directorPlan: directorPlan(),
    shots: [temporalShot({
      visualPlan: temporalGridPlan({ fallback: 'ai_plate fallback' }),
    })],
  })), /cannot fall back to ai_plate/)
})

test('shot composition requires a passed static contact-sheet gate', () => {
  const base = {
    renders: [{ shotId: 1, status: 'succeeded', outputPath: 'data/static/remotion/shot-1.mp4' }],
  }
  assert.throws(() => validateRemotionStageOutput('shot_composition', envelope('shot_composition', base)), /staticGate/)
  assert.doesNotThrow(() => validateRemotionStageOutput('shot_composition', envelope('shot_composition', {
    ...base,
    staticGate: {
      decision: 'passed',
      contactSheetPath: 'data/temp/remotion/contact-sheet-01.jpg',
      checks: ['layer_order', 'alpha_edges', 'safe_area'],
    },
  })))
})

test('asset plan rejects I2V and Seedance providers', () => {
  assert.throws(() => validateRemotionStageOutput('asset_plan', envelope('asset_plan', {
    assets: [{
      assetKey: 'setup-court-01-scene',
      assetType: 'ai_image',
      production: { provider: 'seedance-i2v', mode: 'video_generation' },
    }],
  })), /video-generation provider/)
})
