import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSemanticEffects,
  resolveSemanticEffectFrame,
  semanticCanvasIsTransparent,
  semanticEffectBox,
  semanticScribblePath,
  semanticTextLayout,
  validateSemanticOverlayProps,
  type SemanticEffect,
  type SemanticOverlayProps,
} from './semantic-overlay-core';

const effect: SemanticEffect = {
  id: 'thought-1', kind: 'thought', startFrame: 15, endFrame: 105,
  x: 0.4, y: 0.12, width: 0.14, height: 0.2,
};
const props: SemanticOverlayProps = {width: 1920, height: 1080, fps: 30, durationInFrames: 120, effects: [effect]};

test('semantic windows are start-inclusive and end-exclusive', () => {
  assert.equal(activeSemanticEffects(props, 14).length, 0);
  assert.equal(activeSemanticEffects(props, 15).length, 1);
  assert.equal(activeSemanticEffects(props, 104).length, 1);
  assert.equal(activeSemanticEffects(props, 105).length, 0);
});

test('empty and inactive compositions are transparent', () => {
  assert.equal(semanticCanvasIsTransparent({...props, effects: []}, 40), true);
  assert.equal(semanticCanvasIsTransparent(props, 0), true);
  assert.equal(semanticCanvasIsTransparent(props, 105), true);
  assert.equal(semanticCanvasIsTransparent(props, 45), false);
});

test('head tracking is deterministic, bounded, and reaches the target on the final visible frame', () => {
  const tracked = {...effect, trackTo: {x: 0.5, y: 0.18}};
  assert.equal(resolveSemanticEffectFrame(tracked, 0).x, effect.x);
  assert.equal(resolveSemanticEffectFrame(tracked, 104).x, 0.5);
  assert.equal(resolveSemanticEffectFrame(tracked, 104).y, 0.18);
  assert.equal(resolveSemanticEffectFrame(tracked, 150).x, 0.5);
  for (let frame = effect.startFrame; frame < effect.endFrame; frame += 1) {
    const position = resolveSemanticEffectFrame(tracked, frame);
    assert.ok(position.x >= effect.x && position.x <= 0.5);
    assert.ok(position.y >= effect.y && position.y <= 0.18);
    assert.deepEqual(position, resolveSemanticEffectFrame(tracked, frame));
  }
});

test('normalized boxes scale exactly with the composition dimensions', () => {
  assert.deepEqual(semanticEffectBox(effect, props, 15), {left: 768, top: 129.6, width: 268.8, height: 216});
  assert.doesNotThrow(() => validateSemanticOverlayProps(props));
});

test('initial and tracked boxes cannot cross canvas or subtitle boundaries', () => {
  for (const invalid of [
    {...effect, x: -0.01}, {...effect, y: -0.01}, {...effect, x: 0.9},
    {...effect, y: 0.7}, {...effect, trackTo: {x: 0.9, y: 0.12}},
    {...effect, trackTo: {x: 0.4, y: 0.7}}, {...effect, width: NaN},
  ]) {
    assert.throws(() => validateSemanticOverlayProps({...props, effects: [invalid]}));
  }
  assert.doesNotThrow(() => validateSemanticOverlayProps({...props, effects: [{...effect, y: 0.66}]}));
});

test('invalid duration, ids, effect kinds, and line windows fail fast', () => {
  assert.throws(() => validateSemanticOverlayProps({...props, width: 0}));
  assert.throws(() => validateSemanticOverlayProps({...props, fps: Infinity}));
  assert.throws(() => validateSemanticOverlayProps({...props, durationInFrames: 1.5}));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [effect, effect]}));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [{...effect, endFrame: 121}]}));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [{...effect, endFrame: 15}]}));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [{...effect, kind: 'emphasis', text: ''}]}));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [{...effect, kind: 'emphasis', lines: [{text: '15', delayFrames: 90}]}]}));
});

test('thought does not invent an internal monologue and emphasis fits explicit line boxes', () => {
  assert.equal(semanticTextLayout(effect, 260, 210).lines[0].text, '\u2026');
  const emphasis: SemanticEffect = {
    ...effect, kind: 'emphasis', width: 0.5, height: 0.22,
    lines: [{text: '15\u5929', delayFrames: 0}, {text: '\u6743\u529b\u6536\u56de', delayFrames: 8}],
  };
  const layout = semanticTextLayout(emphasis, 600, 160);
  assert.deepEqual(layout.lines, emphasis.lines);
  assert.ok(layout.fontSize <= 72);
  assert.ok(layout.lineHeight * 2 < 160);
});

test('long text shrinks to fit without truncating or changing source text', () => {
  const text = '\u5609\u5e86\u5341\u4e94\u5929\u5c31\u80fd\u62ff\u4e0b\u7684\u4eba';
  const layout = semanticTextLayout({...effect, kind: 'emphasis', text}, 320, 150);
  assert.equal(layout.lines[0].text, text);
  assert.ok(layout.fontSize < 30);
  assert.throws(() => semanticTextLayout({...effect, kind: 'emphasis', text: text.repeat(30)}, 100, 40));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [{...effect, kind: 'emphasis', text: text.repeat(30)}]}));
  assert.throws(() => validateSemanticOverlayProps({...props, effects: [{...effect, kind: 'emphasis', startFrame: 100, endFrame: 103, text: 'one\ntwo'}]}));
});

test('scribble trajectories change gently, stay inside their box, and have no random component', () => {
  const current = semanticScribblePath(30);
  assert.equal(current, semanticScribblePath(30));
  assert.notEqual(current, semanticScribblePath(60));
  assert.match(current, / Q /);
  assert.doesNotMatch(current, / L /);
  const coordinates = [...current.matchAll(/([\d.]+) ([\d.]+)/g)];
  assert.equal(coordinates.length, 179);
  for (const point of coordinates) {
    assert.ok(Number(point[1]) > 0 && Number(point[1]) < 200);
    assert.ok(Number(point[2]) > 0 && Number(point[2]) < 120);
  }
});
