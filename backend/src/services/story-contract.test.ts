import test from 'node:test'
import assert from 'node:assert/strict'
import { validateStoryContract } from './story-contract.js'

const base = {
  beatId: 'B01-E01',
  sourceSpans: [{ start: 0, end: 18, text: '洛克菲勒取得铁路运输折扣' }],
  function: 'event',
  actorIds: ['P01'],
  target: '铁路公司',
  propIds: ['O-rail-deal'],
  action: '洛克菲勒与铁路方交换并签下折扣协议',
  phase: 'execute',
  beforeState: '运输成本与竞争对手相同',
  afterState: '他的运输成本低于竞争对手',
  visualProof: ['手部签字/交换协议', '账簿两栏运价对比'],
}

test('story contract accepts a concrete causal event', () => {
  assert.doesNotThrow(() => validateStoryContract(base, {
    characters: [{ actorId: 'P01', name: '洛克菲勒' }],
  }))
})

test('story contract rejects generic layer-filling poses', () => {
  assert.throws(() => validateStoryContract({ ...base, action: '人物停住' }), /generic pose/)
  assert.throws(() => validateStoryContract({ ...base, action: '成年洛克菲勒抬手指向画外，先建立人物' }), /generic pose/)
  assert.throws(() => validateStoryContract({ ...base, visualProof: [] }), /visualProof/)
  assert.throws(() => validateStoryContract({ ...base, actorIds: [] }), /actorIds/)
})

test('event shots require a target and a real state transition', () => {
  assert.throws(() => validateStoryContract({ ...base, target: undefined, propIds: ['O-rail-deal'] }), /requires target/)
  assert.throws(() => validateStoryContract({ ...base, beforeState: '不变' }), /beforeState\/afterState change/)
  assert.throws(() => validateStoryContract({ ...base, beforeState: base.afterState }), /beforeState\/afterState change/)
})

test('every declared actor must have a corresponding visual layer', () => {
  const plan = { characters: [{ actorId: 'P01', name: '洛克菲勒' }] }
  assert.doesNotThrow(() => validateStoryContract(base, plan))
  assert.throws(() => validateStoryContract({ ...base, actorIds: ['P01', 'P02'] }, plan), /P02/)
})

test('source spans must carry traceable text', () => {
  assert.throws(() => validateStoryContract({ ...base, sourceSpans: [{ start: 0, end: 3 }] }), /sourceSpans/)
  assert.throws(() => validateStoryContract({ ...base, sourceSpans: [{ start: 0, end: 2, text: '洛克菲勒' }] }), /exceeds/)
})

test('map or stock visuals declare what historical evidence they provide', () => {
  const plan = { characters: [{ actorId: 'P01' }], map: { mode: 'route' } }
  assert.throws(() => validateStoryContract(base, plan), /assetSemantics/)
  assert.doesNotThrow(() => validateStoryContract({ ...base, assetSemantics: ['铁路路线汇入仓库'] }, plan))
})

test('context shot without an actor must explain why', () => {
  const context = {
    ...base,
    function: 'context',
    actorIds: [],
    target: undefined,
    propIds: [],
    beforeState: undefined,
    afterState: undefined,
    action: '账单落在空桌面上',
  }
  assert.throws(() => validateStoryContract(context), /whyNoActor/)
  assert.doesNotThrow(() => validateStoryContract({ ...context, whyNoActor: '本镜头只展示无人处理的账单，下一镜由母亲接手。' }))
})
