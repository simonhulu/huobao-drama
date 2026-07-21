import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDirectorPlan } from './director-plan.js'

function plan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    genre: 'historical-biography-docudrama',
    format: '历史人物传记式纪录片',
    protagonist: { name: '吕雉', arc: '从受害者到决策者' },
    dramaticQuestion: '她如何取得行动权？',
    thesis: '用具体行动证明人物变化。',
    scenes: [{
      id: 'S1', location: '朝堂', time: '西汉初年', purpose: '展示决策', emotionalTurn: '紧张到决断',
      characters: ['吕雉', '官员'], conflict: '官员等待命令', anchorAction: '吕雉接过奏牍', exitTransition: '印玺声接下一镜',
    }],
    beats: [{
      id: 'B1', sceneId: 'S1', sourceSpans: [{ start: 0, end: 12, text: '她接过奏牍并落印' }],
      function: 'event', actorIds: ['吕雉'], target: '奏牍与印玺', action: '吕雉接过奏牍并按住印玺',
      beforeState: '奏牍还在官员手中', afterState: '诏令完成并交给中官', result: '中官转身传令',
      visualProof: ['手接奏牍', '印玺落下'], causalReason: '开场事件', nextBeatId: null,
      shot: {
        shotType: '中景', angle: '过肩', blocking: '官员递出奏牍', camera: '缓慢推近手部', transition: '印玺声切黑',
        reference: { shotCafeQuery: 'https://shot.cafe/tag/hands', flimQuery: 'official receives scroll', transferableRule: '过肩保持视线轴' },
      },
      assetStrategy: 'new-static-image',
    }],
    visualRules: {
      continuityAnchors: ['服饰', '奏牍'], forbiddenPatterns: ['棋盘隐喻', '分屏'], periodAndStyle: '历史纪录片写实',
    },
    ...overrides,
  }
}

test('director plan accepts a concrete causal event', () => {
  assert.equal(validateDirectorPlan(plan()).beats.length, 1)
})

test('director plan rejects a concept image disguised as an action', () => {
  assert.throws(() => validateDirectorPlan(plan({
    beats: [{
      ...plan().beats[0],
      action: '一个女人站在巨大棋盘中央象征权力',
      beforeState: '棋盘还没有女人',
      afterState: '女人站在棋盘中央',
    }],
  })), /conceptual|concrete observable verb|beforeState/)
})

test('director plan rejects a broken scene reference', () => {
  assert.throws(() => validateDirectorPlan(plan({
    beats: [{ ...plan().beats[0], sceneId: 'S404' }],
  })), /unknown scene/)
})
