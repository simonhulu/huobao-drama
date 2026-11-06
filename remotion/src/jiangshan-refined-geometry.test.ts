import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRouteCurve, routeAt, routeRibbon, refinedTimeline, placeCommander, placeRegiment, planRefinedLayout, regimentAtOffset, commanderAtOffset, routeClearance} from './jiangshan-refined-geometry';

test('curved routes preserve endpoints, have real curvature and share the ribbon tip with the army anchor', () => {
  const route = makeRouteCurve({x: 300, y: 500}, {x: 1100, y: 480}, -.34);
  assert.equal(routeAt(route, 0).x, 300);
  assert.equal(routeAt(route, 1).x, 1100);
  assert.equal(routeAt(route, 1).y, 480);
  assert.ok(routeAt(route, .5).y < 380, 'the route must be visibly curved, not a straight arrow');
  assert.ok(route.length > Math.hypot(800, -20));
  for (const progress of [.05, .3, .7, .94]) {
    const anchor = routeAt(route, progress), ribbon = routeRibbon(route, progress);
    assert.deepEqual(ribbon.tip, anchor);
    assert.ok(ribbon.path.endsWith(' Z'));
  }
});

test('projection translation and uniform scale keep the route and army at matching geographic anchors', () => {
  const source = makeRouteCurve({x: 300, y: 500}, {x: 1100, y: 480}, -.34);
  const transformed = makeRouteCurve({x: 300 * 1.3 + 80, y: 500 * 1.3 - 50}, {x: 1100 * 1.3 + 80, y: 480 * 1.3 - 50}, -.34);
  for (const progress of [.2, .5, .94]) {
    const a = routeAt(source, progress), b = routeAt(transformed, progress);
    assert.ok(Math.abs(b.x - (a.x * 1.3 + 80)) < .00001);
    assert.ok(Math.abs(b.y - (a.y * 1.3 - 50)) < .00001);
  }
});

test('attack never completes occupation early, final state holds and seeking has no history dependence', () => {
  assert.equal(refinedTimeline(2.5).routeProgress, 0);
  assert.equal(refinedTimeline(8.5).routeProgress, .82);
  assert.equal(refinedTimeline(12).routeProgress, .94);
  assert.equal(refinedTimeline(12).occupation, 0);
  assert.equal(refinedTimeline(13.999).occupationComplete, false);
  assert.equal(refinedTimeline(14).occupationComplete, true);
  assert.equal(refinedTimeline(17.5).occupationComplete, true);
  const before = refinedTimeline(7.3);
  refinedTimeline(16);
  assert.deepEqual(before, refinedTimeline(7.3));
});

test('commander placement can clear a real native city name and reserves the other commander', () => {
  const anchor = {x: 900, y: 500}, viewport = {width: 1920, height: 1080};
  const initial = placeCommander(anchor, -1, viewport, []);
  const resolved = placeCommander(anchor, -1, viewport, [{...initial}]);
  assert.notDeepEqual(resolved, initial);
  const other = placeCommander(anchor, 1, viewport, [], [resolved]);
  assert.ok(other.y >= resolved.y + resolved.height);
});

const intersects = (a: {x: number; y: number; width: number; height: number}, b: typeof a) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('portrait cards clear the entire curved route, including the formerly covered blue midsection', () => {
  const viewport = {width: 1920, height: 1080};
  const start = {x: 844.1169680700277, y: 644.5020776549};
  const target = {x: 1256.1566009530507, y: 495.4201605140506};
  const span = Math.hypot(target.x - 680.1872216542015, target.y - 551.1590728160072);
  const curve = makeRouteCurve(start, {x: target.x - span * .04, y: target.y + span * .24}, .35);
  const anchor = routeAt(curve, .94), routeObstacles = routeClearance(curve, 22);
  const oldCard = commanderAtOffset(anchor, {x: -280, y: 70}, 1, viewport);
  assert.ok(routeObstacles.some(box => intersects(oldCard, box)), 'fixture reproduces the reported card over the blue arrow');
  const samples = [{anchors: [{x: 1187, y: 359}, anchor], obstacles: [], routeObstacles}];
  const layout = planRefinedLayout(samples, viewport);
  for (let unit = 0; unit < 2; unit++) {
    const card = commanderAtOffset(samples[0].anchors[unit], layout.commanders[unit], 1, viewport);
    for (const obstacle of routeObstacles) assert.equal(intersects(card, obstacle), false);
  }
});

test('regiment displacement preserves its true anchor while clearing a native label and a reserved unit', () => {
  const anchor = {x: 994, y: 718}, viewport = {width: 1920, height: 1080};
  const label = {x: 910, y: 625, width: 90, height: 48};
  const first = placeRegiment(anchor, 1, viewport, [label]);
  assert.equal(intersects(first.box, label), false);
  const second = placeRegiment(anchor, -1, viewport, [label], [first.box]);
  assert.equal(intersects(second.box, first.box), false);
  assert.deepEqual(anchor, {x: 994, y: 718});
});

test('whole-shot layout clears a changing label without adding motion jumps or card collisions', () => {
  const viewport = {width: 1920, height: 1080};
  const samples = Array.from({length: 40}, (_, frame) => ({
    anchors: [{x: 700 + frame * 2, y: 430}, {x: 1100 + frame, y: 670}],
    obstacles: frame > 15 && frame < 25 ? [{x: 690, y: 370, width: 95, height: 40}] : [],
  }));
  const layout = planRefinedLayout(samples, viewport);
  assert.deepEqual(planRefinedLayout(samples, viewport), layout);
  const boxes = samples.map(sample => sample.anchors.map((anchor, index) => ({
    unit: regimentAtOffset(anchor, layout.regiments[index], 1).box,
    card: commanderAtOffset(anchor, layout.commanders[index], 1),
  })));
  for (let frame = 0; frame < samples.length; frame++) {
    const all = boxes[frame].flatMap(item => [item.unit, item.card]);
    all.forEach((box, index) => {
      for (const obstacle of samples[frame].obstacles) assert.equal(intersects(box, obstacle), false);
      for (const other of all.slice(index + 1)) assert.equal(intersects(box, other), false);
    });
    if (frame > 0) for (let unit = 0; unit < 2; unit++) {
      assert.equal(boxes[frame][unit].card.x - boxes[frame - 1][unit].card.x, unit === 0 ? 2 : 1);
      assert.equal(boxes[frame][unit].unit.x - boxes[frame - 1][unit].unit.x, unit === 0 ? 2 : 1);
    }
  }
});
