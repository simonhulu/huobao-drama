import assert from 'node:assert/strict';
import test from 'node:test';

import {classifyNarrativeRole} from '../../scripts/director.mjs';

test('classifies historical violence as crisis beats', () => {
  assert.equal(classifyNarrativeRole('李敢打伤了卫青。', 3, 8), 'crisis');
  assert.equal(classifyNarrativeRole('霍去病在猎场上直接要了李敢的命。', 4, 8), 'crisis');
  assert.equal(classifyNarrativeRole('射死李敢的人是霍去病。', 5, 8), 'crisis');
});

test('classifies concealment and contradiction as reversals', () => {
  assert.equal(classifyNarrativeRole('朝廷给出的说法是被鹿撞死，史记却留下另一种说法。', 2, 8), 'reversal');
  assert.equal(classifyNarrativeRole('卫青受伤以后没有声张，把事情压了下来。', 3, 8), 'reversal');
  assert.equal(classifyNarrativeRole('汉武帝替他把这件事遮了过去。', 4, 8), 'reversal');
});

test('classifies historical scene setting without weakening first-frame hook', () => {
  assert.equal(classifyNarrativeRole('公元前118年，汉武帝到甘泉宫打猎。', 0, 8), 'hook');
  assert.equal(classifyNarrativeRole('要回答这个问题，得先看看卫青小时候过的是什么日子。', 5, 8), 'establishing');
  assert.equal(classifyNarrativeRole('他的母亲是平阳侯家的女奴。', 6, 8), 'establishing');
});

