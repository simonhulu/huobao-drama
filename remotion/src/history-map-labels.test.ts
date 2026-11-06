import test from 'node:test';
import assert from 'node:assert/strict';
import {atlasLabelAt, atlasLabelBounds, atlasWaterwayPath, layoutAtlasLabels, mapLabelOverlap, type MapGeographicLabel} from './history-map-labels';
import {layoutMapForces, type HistoryMapForce} from './history-map-forces';

const viewport = {width: 1920, height: 1080};
const camera = {focusX: .5, focusY: .5, zoom: 1};
const force: HistoryMapForce = {id: 'yan', city: '北平', commander: '朱棣', faction: '燕军', flagText: '燕',
  color: '#a54232', action: 'hold', start: 0, end: .4, portraitSrc: 'portrait.png'};
const map = {
  ...viewport,
  cities: [{name: '北平', x: .54, y: .47}, {name: '通州', x: .60, y: .49}, {name: '居庸关', x: .48, y: .39}, {name: '怀来', x: .4, y: .36}],
  forces: [force],
  camera: {keyframes: [{...camera, t: 0}, {...camera, zoom: 1.04, t: 7}]},
  geographicLabels: [
    {id: 'yan-mountains', text: '燕山', kind: 'mountain', x: .71, y: .29, angle: -13, priority: 80},
    {id: 'plain', text: '华北平原', kind: 'region', x: .73, y: .64, priority: 30},
  ] as MapGeographicLabel[],
};

test('city labels avoid each other, army cards and title/subtitle bands throughout camera movement', () => {
  const labels = layoutAtlasLabels(map, viewport);
  assert.equal(labels.filter(label => label.primary && !label.hidden).length, 4);
  for (const zoom of [1, 1.02, 1.04]) {
    const current = {...camera, zoom};
    const boxes = labels.filter(label => !label.hidden).map(label => atlasLabelAt(label, map, current, viewport).box);
    const bounds = atlasLabelBounds(viewport);
    const badges = layoutMapForces(map, 5, current, viewport).map(item => item.box);
    for (const [i, box] of boxes.entries()) {
      assert.ok(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width);
      assert.ok(box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height);
      for (const other of boxes.slice(i + 1)) assert.equal(mapLabelOverlap(box, other), 0);
      for (const badge of badges) assert.equal(mapLabelOverlap(box, badge), 0);
    }
  }
});

test('primary names at the lower map edge move inside the safe band and keep their geographic anchor', () => {
  const lower = {...viewport, cities: [{name: '济南', x: .64, y: .82}],
    camera: {keyframes: [{...camera, t: 0}, {...camera, zoom: 1.04, t: 5}]},
    forces: [{...force, city: '济南'}]};
  const [label] = layoutAtlasLabels(lower, viewport);
  const {anchor, box} = atlasLabelAt(label, lower, camera, viewport);
  const bounds = atlasLabelBounds(viewport);
  assert.equal(label.hidden, false);
  assert.equal(anchor.y, .82 * 1080);
  assert.ok(box.y + box.height <= bounds.y + bounds.height);
  assert.ok(label.offsetY < 0);
  for (const zoom of [1, 1.02, 1.04]) {
    const current = {...camera, zoom};
    const currentBox = atlasLabelAt(label, lower, current, viewport).box;
    assert.ok(currentBox.y + currentBox.height <= bounds.y + bounds.height + 1e-8);
    for (const badge of layoutMapForces(lower, 2, current, viewport)) assert.equal(mapLabelOverlap(currentBox, badge.box), 0);
  }
});

test('river labels yield to a city instead of covering its marker or name', () => {
  const crowded = {...viewport, cities: [{name: '德州', x: .5, y: .5}], geographicLabels: [
    {id: 'river', text: '河流标注', kind: 'river' as const, x: .5, y: .5},
  ]};
  const labels = layoutAtlasLabels(crowded, viewport);
  const city = labels.find(label => label.kind === 'city')!;
  const river = labels.find(label => label.kind === 'river')!;
  assert.equal(city.hidden, false);
  if (!river.hidden) assert.equal(mapLabelOverlap(atlasLabelAt(city, crowded, camera, viewport).box, atlasLabelAt(river, crowded, camera, viewport).box), 0);
});

test('route labels avoid the moving badge and retain a fixed offset rather than jumping each frame', () => {
  const traveling = {...viewport, cities: [{name: '出发地', x: .2, y: .45}, {name: '北平', x: .75, y: .5}],
    routes: [{points: [[.2, .45], [.75, .5]] as [number, number][]}],
    forces: [{...force, action: 'retreat' as const, routeIndex: 0, start: 1, end: 5}]};
  const labels = layoutAtlasLabels(traveling, viewport);
  for (const seconds of [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
    const badges = layoutMapForces(traveling, seconds, camera, viewport);
    for (const label of labels.filter(item => !item.hidden)) {
      const placement = atlasLabelAt(label, traveling, camera, viewport);
      assert.ok(Math.abs(placement.center.x - placement.anchor.x - label.offsetX) < 1e-8);
      for (const badge of badges) assert.equal(mapLabelOverlap(placement.box, badge.box), 0);
    }
  }
  assert.deepEqual(layoutAtlasLabels(traveling, viewport), labels);
});

test('rotated mountain names reserve their rotated extent and font sizes stay independent of zoom', () => {
  const labels = layoutAtlasLabels(map, viewport);
  const mountain = labels.find(label => label.id === 'yan-mountains')!;
  assert.equal(mountain.hidden, false);
  const normal = atlasLabelAt(mountain, map, camera, viewport), zoomed = atlasLabelAt(mountain, map, {...camera, zoom: 1.4}, viewport);
  assert.equal(normal.box.width, zoomed.box.width);
  assert.equal(normal.box.height, zoomed.box.height);
  assert.ok(normal.box.height > mountain.fontSize * 1.3 + 8);
});

test('waterway fillets preserve endpoints and stay within two screen pixels of the source at different zooms', () => {
  const points: [number, number][] = [[0, .2], [.2, .2], [.2, .4], [.2, .4], [.35, .55], [.5, .55], [.52, .56], [.6, .4], [1, .5]];
  const original = structuredClone(points);
  const vertices = points.map(([x, y]) => [x * 1000, y * 500]);
  const distance = (point: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
    return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
  };
  for (const unitsPerPixel of [.6, 1, 1.8]) {
    const path = atlasWaterwayPath(points, 1000, 500, unitsPerPixel);
    assert.ok(path.startsWith('M0 100 '));
    assert.ok(path.endsWith('L1000 250'));
    assert.ok(path.includes(' Q'));
    assert.ok(!path.includes('NaN'));
    const tokens = path.match(/[MLQ]|-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi)!;
    let cursor = 0, previous = [0, 0];
    const readPoint = () => [Number(tokens[cursor++]), Number(tokens[cursor++])];
    while (cursor < tokens.length) {
      const command = tokens[cursor++];
      const first = readPoint(), end = command === 'Q' ? readPoint() : first;
      if (command === 'Q') for (let i = 0; i <= 100; i++) {
        const t = i / 100, point = [0, 1].map(axis => (1 - t) ** 2 * previous[axis] + 2 * (1 - t) * t * first[axis] + t * t * end[axis]);
        const nearest = Math.min(...vertices.slice(1).map((v, index) => distance(point, vertices[index], v)));
        assert.ok(nearest / unitsPerPixel <= 2.000001, `waterway moved ${nearest / unitsPerPixel} screen pixels`);
      }
      previous = end;
    }
  }
  assert.deepEqual(points, original);
});

test('a river label follows its explicit waterway instead of an unrelated nearby line and remains close', () => {
  const waterMap = {...viewport, waterways: [
    {id: 'main', points: [[.2, .5], [.8, .5]] as [number, number][]},
    {id: 'tributary', name: '卢沟河', points: [[.2, .53], [.8, .53]] as [number, number][]},
  ], geographicLabels: [{id: 'river-name', text: '卢沟河', kind: 'river' as const, x: .5, y: .53, waterwayId: 'main'}]};
  const [label] = layoutAtlasLabels(waterMap, viewport);
  assert.equal(label.hidden, false);
  assert.equal(label.y, .5);
  assert.equal(label.x, .5);
  assert.ok(Math.hypot(label.offsetX, label.offsetY) <= 20);
  assert.equal(label.offsetY, 18);
});

test('region, mountain and lake names outside the safe band are hidden instead of displaced to another feature', () => {
  for (const kind of ['region', 'mountain', 'lake'] as const) {
    const featureMap = {...viewport, geographicLabels: [{id: 'edge-feature', text: '山东半岛', kind, x: .742, y: .864}]};
    const [label] = layoutAtlasLabels(featureMap, viewport);
    assert.equal(label.x, .742);
    assert.equal(label.y, .864);
    assert.equal(label.hidden, true);
  }
});

test('geographic labels near their anchor remain visible, including a sea name over water', () => {
  const featureMap = {...viewport, geographicLabels: [{id: 'bohai', text: '渤海', kind: 'region' as const, x: .742, y: .4}],
    waterAreas: [{id: 'sea', kind: 'ocean' as const, rings: [[[.6, .2], [1, .2], [1, .6], [.6, .6], [.6, .2]]]}]};
  const [label] = layoutAtlasLabels(featureMap, viewport);
  assert.equal(label.hidden, false);
  assert.equal(label.offsetX, 0);
  assert.equal(label.offsetY, 0);
});
