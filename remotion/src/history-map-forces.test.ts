import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMapForces, mapCityControlAt, mapForceSafeBounds, mapForceState, projectMapPoint, type HistoryMapForce} from './history-map-forces';

const force: HistoryMapForce = {
  id: 'attacking-army', faction: '秦军', flagText: '秦', commander: '白起', color: '#9e4134', city: '长平',
  routeIndex: 0, action: 'attack', start: 1, end: 5,
};
const map = {
  width: 1920, height: 1080,
  cities: [{name: '起点', x: .2, y: .4}, {name: '长平', x: .6, y: .5}],
  routes: [{points: [[.2, .4], [.4, .4], [.6, .5]] as [number, number][]}],
  forces: [force],
};
const camera = {focusX: .5, focusY: .5, zoom: 1};

test('army travels on shared route by length, stops at arrival, and remains after end', () => {
  assert.equal(mapForceState(force, map, .9).visible, false);
  const start = mapForceState(force, map, 1), middle = mapForceState(force, map, 3), end = mapForceState(force, map, 5);
  assert.deepEqual(start.anchor, {x: 384, y: 432, angle: 0});
  assert.equal(middle.progress, .5);
  assert.ok(middle.anchor.x > start.anchor.x);
  assert.ok(middle.anchor.x < end.anchor.x);
  assert.equal(middle.moving, true);
  assert.equal(end.moving, false);
  assert.equal(end.arrived, true);
  assert.equal(end.visible, true);
  assert.deepEqual(end.anchor, mapForceState(force, map, 12).anchor);
  assert.equal(mapForceState(force, map, 12).opacity, 1);
});

test('static garrison uses named city and missing cities do not get invented anchors', () => {
  const hold = {...force, routeIndex: undefined, action: 'hold' as const};
  assert.deepEqual(mapForceState(hold, map, 3).anchor, {x: 1152, y: 540, angle: 0});
  assert.equal(mapForceState(hold, map, 3).moving, false);
  assert.equal(mapForceState({...hold, city: '不存在'}, map, 3).visible, false);
});

test('schematic attacker advances along siege perimeter and never occupies the city', () => {
  const attack = {...force, routeIndex: undefined};
  const encirclement = {center: [.6, .5] as [number, number], radiusX: .12, radiusY: .16};
  const siege = {...map, encirclement, forces: [attack]};
  const normalizedRadius = (seconds: number) => {
    const {anchor} = mapForceState(attack, siege, seconds);
    return Math.hypot((anchor.x / map.width - encirclement.center[0]) / encirclement.radiusX, (anchor.y / map.height - encirclement.center[1]) / encirclement.radiusY);
  };
  assert.ok(normalizedRadius(1) > normalizedRadius(3));
  assert.ok(normalizedRadius(3) > normalizedRadius(5));
  assert.ok(normalizedRadius(5) > 1, 'attack remains outside the perimeter');
  assert.equal(mapForceState(attack, siege, 3).moving, true);
  assert.equal(mapForceState(attack, siege, 5).moving, false);
  assert.deepEqual(mapForceState(attack, siege, 5).anchor, mapForceState(attack, siege, 9).anchor);
  assert.equal(mapCityControlAt(siege, '长平', 9), undefined);
  const hold = {...attack, action: 'hold' as const};
  assert.deepEqual(mapForceState(hold, siege, 3).anchor, {x: 1152, y: 540, angle: 0});
});

test('only completed occupation changes city control, newest completed occupation wins', () => {
  assert.equal(mapCityControlAt(map, '长平', 20), undefined);
  for (const action of ['march', 'hold', 'attack', 'retreat'] as const) {
    assert.equal(mapCityControlAt({...map, forces: [{...force, action}]}, '长平', 20), undefined);
  }
  const first = {...force, id: 'first', action: 'occupy' as const}, later = {...first, id: 'second', faction: '赵军', color: '#376885', start: 5, end: 7};
  const occupied = {...map, forces: [later, first]};
  assert.equal(mapCityControlAt(occupied, '长平', 4.9), undefined);
  assert.equal(mapCityControlAt(occupied, '长平', 5)?.id, 'first');
  assert.equal(mapCityControlAt(occupied, '长平', 6)?.id, 'first');
  assert.equal(mapCityControlAt(occupied, '长平', 7)?.id, 'second');
  assert.equal(mapCityControlAt(occupied, '起点', 20), undefined);
});

test('projection follows camera and letterboxing in landscape and portrait', () => {
  assert.deepEqual(projectMapPoint({x: 960, y: 540}, map, camera, {width: 1920, height: 1080}), {x: 960, y: 540});
  assert.deepEqual(projectMapPoint({x: 960, y: 540}, map, camera, {width: 1080, height: 1920}), {x: 540, y: 960});
  assert.deepEqual(projectMapPoint({x: 1152, y: 540}, map, {...camera, focusX: .6, zoom: 1.5}, {width: 1920, height: 1080}), {x: 960, y: 540});
});

test('portrait and army labels avoid each other, city name, title and caption bands', () => {
  const colocated = {...map, forces: [
    {...force, routeIndex: undefined, portraitSrc: 'baiqi.png'},
    {...force, id: 'other-force', routeIndex: undefined, commander: '廉颇', faction: '赵军', color: '#376885'},
  ]};
  for (const viewport of [{width: 1920, height: 1080}, {width: 1080, height: 1920}]) {
    const layouts = layoutMapForces(colocated, 7, camera, viewport), bounds = mapForceSafeBounds(viewport);
    assert.equal(layouts.length, 2);
    for (const {box, anchor} of layouts) {
      assert.ok(box.x >= bounds.x);
      assert.ok(box.y >= bounds.y);
      assert.ok(box.x + box.width <= bounds.x + bounds.width);
      assert.ok(box.y + box.height <= bounds.y + bounds.height);
      assert.ok(box.x + box.width < anchor.x + 12 || box.x > anchor.x + 105 || box.y + box.height < anchor.y - 59 || box.y > anchor.y - 4);
    }
    const [a, b] = layouts.map(item => item.box);
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    assert.deepEqual(layoutMapForces(colocated, 7, camera, viewport), layouts);
  }
});

test('moving badge keeps its chosen side through route progress and camera changes', () => {
  const viewport = {width: 1920, height: 1080};
  const moving = {...map, routes: [{points: [[.25, .45], [.7, .5]] as [number, number][]}]};
  const offsets = [1.5, 2, 2.5, 3, 3.5, 4, 4.5].map(seconds => {
    const [layout] = layoutMapForces(moving, seconds, {...camera, focusX: .45 + seconds * .015, zoom: 1.1}, viewport);
    return {x: layout.box.x - layout.anchor.x, y: layout.box.y - layout.anchor.y};
  });
  for (const offset of offsets) {
    assert.ok(Math.abs(offset.x - offsets[0].x) < 1e-8);
    assert.ok(Math.abs(offset.y - offsets[0].y) < 1e-8);
  }
});

test('native screen-space labels are avoided at the moving position and on either side of the destination', () => {
  const viewport = {width: 1920, height: 1080};
  const moving = {
    ...map,
    cities: [{name: '起点', x: 400 / 1920, y: 500 / 1080}, {name: '长平', x: 1200 / 1920, y: 500 / 1080}],
    routes: [{points: [[400 / 1920, 500 / 1080], [1200 / 1920, 500 / 1080]] as [number, number][]}],
    forces: [{...force, action: 'march' as const, start: 2, end: 6}],
  };
  // Native SVG text can be placed left OR right of a marker. The first box is
  // along the route, far away from the endpoint used by the original layout.
  const labels = [
    {x: 610, y: 440, width: 180, height: 55},
    {x: 1010, y: 440, width: 185, height: 55},
    {x: 1230, y: 440, width: 140, height: 55},
  ];
  const overlaps = (a: typeof labels[number], b: typeof labels[number]) => a.x < b.x + b.width
    && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const offsets = [];
  for (const seconds of [3.95, 4, 4.05, 6, 8]) {
    const [layout] = layoutMapForces(moving, seconds, camera, viewport, labels);
    assert.ok(labels.every(label => !overlaps(layout.box, label)), `Badge covers native text at ${seconds}s`);
    assert.deepEqual(layoutMapForces(moving, seconds, camera, viewport, labels)[0].box, layout.box);
    if (seconds < 6) offsets.push({x: layout.box.x - layout.anchor.x, y: layout.box.y - layout.anchor.y});
  }
  for (const offset of offsets) assert.ok(Math.hypot(offset.x - offsets[0].x, offset.y - offsets[0].y) < 1e-8,
    'Nearby frames retain the same clear placement');
});
