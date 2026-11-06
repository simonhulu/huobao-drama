import {layoutMapForces, projectMapPoint, type HistoryMapForce, type MapForceBox} from './history-map-forces';

export type MapGeographicLabel = {
  id: string; text: string; kind: 'mountain' | 'river' | 'region' | 'lake';
  x: number; y: number; angle?: number; priority?: number; waterwayId?: string;
};
export type MapWaterway = {id: string; name?: string; points: [number, number][]; rank?: number};
export type MapWaterArea = {id: string; kind: 'ocean' | 'lake'; rings: [number, number][][]};
export type AtlasCity = {
  name: string; x: number; y: number; role?: 'primary' | 'context';
  kind?: 'capital' | 'city' | 'pass' | 'battlefield';
};
type Camera = {focusX: number; focusY: number; zoom: number};
type Viewport = {width: number; height: number};
type AtlasMap = {
  width: number; height: number; cities?: AtlasCity[];
  routes?: {points: [number, number][]}[]; forces?: HistoryMapForce[];
  geographicLabels?: MapGeographicLabel[];
  waterways?: MapWaterway[];
  camera?: {keyframes: (Camera & {t: number})[]};
  encirclement?: {center: [number, number]; radiusX: number; radiusY: number};
};
export type AtlasLabel = {
  id: string; text: string; kind: 'city' | MapGeographicLabel['kind'];
  x: number; y: number; primary: boolean; angle: number; fontSize: number; letterSpacing: number;
  offsetX: number; offsetY: number; width: number; height: number; hidden: boolean;
};
const baseCamera: Camera = {focusX: .5, focusY: .5, zoom: 1};
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export const mapLabelOverlap = (a: MapForceBox, b: MapForceBox) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const pad = (box: MapForceBox, n: number): MapForceBox => ({x: box.x - n, y: box.y - n, width: box.width + n * 2, height: box.height + n * 2});

/** Round only waterway corners. A quadratic fillet stays within two screen pixels of the source polyline. */
export function atlasWaterwayPath(points: [number, number][], width: number, height: number, unitsPerScreenPixel = 1) {
  const vertices = points.map(([x, y]) => [x * width, y * height] as [number, number])
    .filter((point, index, all) => !index || Math.hypot(point[0] - all[index - 1][0], point[1] - all[index - 1][1]) > 1e-8);
  if (!vertices.length) return '';
  const coordinate = (point: [number, number]) => `${point[0]} ${point[1]}`;
  const commands = [`M${coordinate(vertices[0])}`];
  for (let i = 1; i < vertices.length - 1; i++) {
    const previous = vertices[i - 1], vertex = vertices[i], next = vertices[i + 1];
    const incoming = Math.hypot(vertex[0] - previous[0], vertex[1] - previous[1]);
    const outgoing = Math.hypot(next[0] - vertex[0], next[1] - vertex[1]);
    // Each neighboring corner uses at most half of the shared segment; endpoints remain exact.
    const reach = Math.min(incoming / 2, outgoing / 2, 8 * unitsPerScreenPixel);
    const enter: [number, number] = [vertex[0] + (previous[0] - vertex[0]) * reach / incoming, vertex[1] + (previous[1] - vertex[1]) * reach / incoming];
    const leave: [number, number] = [vertex[0] + (next[0] - vertex[0]) * reach / outgoing, vertex[1] + (next[1] - vertex[1]) * reach / outgoing];
    commands.push(`L${coordinate(enter)} Q${coordinate(vertex)} ${coordinate(leave)}`);
  }
  if (vertices.length > 1) commands.push(`L${coordinate(vertices[vertices.length - 1])}`);
  return commands.join(' ');
}

function riverAnchor(label: MapGeographicLabel, map: AtlasMap): MapGeographicLabel {
  if (label.kind !== 'river') return label;
  const waterways = map.waterways?.filter(waterway => label.waterwayId ? waterway.id === label.waterwayId : waterway.name === label.text) ?? [];
  let best: {distance: number; x: number; y: number} | undefined;
  for (const waterway of waterways) for (let i = 1; i < waterway.points.length; i++) {
    const [ax, ay] = waterway.points[i - 1], [bx, by] = waterway.points[i];
    const dx = (bx - ax) * map.width, dy = (by - ay) * map.height;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? clamp(((label.x - ax) * map.width * dx + (label.y - ay) * map.height * dy) / lengthSquared, 0, 1) : 0;
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    const distance = Math.hypot((x - label.x) * map.width, (y - label.y) * map.height);
    if (!best || distance < best.distance) best = {distance, x, y};
  }
  return best ? {...label, x: best.x, y: best.y} : label;
}

export function atlasLabelBounds(viewport: Viewport): MapForceBox {
  const portrait = viewport.width < viewport.height;
  return {x: 36, y: portrait ? 160 : 130, width: viewport.width - 72, height: viewport.height * .72 - (portrait ? 160 : 130)};
}

function dimensions(text: string, fontSize: number, spacing: number, angle: number) {
  const characters = [...text];
  const width = characters.reduce((sum, c) => sum + fontSize * (/^[\x00-\x7F]$/.test(c) ? .6 : 1), 0) + Math.max(0, characters.length - 1) * spacing + 14;
  const height = fontSize * 1.3 + 8, radians = angle * Math.PI / 180;
  return {width: Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians)),
    height: Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians))};
}

export function atlasLabelAt(label: AtlasLabel, map: AtlasMap, camera: Camera, viewport: Viewport) {
  const anchor = projectMapPoint({x: label.x * map.width, y: label.y * map.height}, map, camera, viewport);
  const center = {x: anchor.x + label.offsetX, y: anchor.y + label.offsetY};
  return {anchor, center, box: {x: center.x - label.width / 2, y: center.y - label.height / 2, width: label.width, height: label.height}};
}

/** Layout is calculated once for the shot, including army motion, so labels never jump between frames. */
export function layoutAtlasLabels(map: AtlasMap, viewport: Viewport): AtlasLabel[] {
  const bounds = atlasLabelBounds(viewport);
  const cameras = [baseCamera, ...(map.camera?.keyframes ?? []).map(key => ({
    ...key, focusX: clamp(key.focusX, .5 / key.zoom, 1 - .5 / key.zoom), focusY: clamp(key.focusY, .5 / key.zoom, 1 - .5 / key.zoom),
  }))].filter((camera, i, all) => all.findIndex(other => other.focusX === camera.focusX && other.focusY === camera.focusY && other.zoom === camera.zoom) === i);
  const forceTimes = [...new Set([0, ...(map.forces ?? []).flatMap(force => Array.from({length: 9}, (_, i) => force.start + (force.end - force.start) * i / 8))])];
  const forceObstacles = cameras.map(camera => forceTimes.flatMap(seconds => layoutMapForces(map, seconds, camera, viewport).map(item => pad(item.box, 8))));
  const cityObstacles = cameras.map(camera => (map.cities ?? []).map(city => {
    const p = projectMapPoint({x: city.x * map.width, y: city.y * map.height}, map, camera, viewport);
    return {x: p.x - 15, y: p.y - 15, width: 30, height: 30};
  }));
  const planned: AtlasLabel[] = [];
  const items = [
    ...(map.cities ?? []).map(city => ({id: `city:${city.name}`, text: city.name, kind: 'city' as const,
      x: city.x, y: city.y, primary: city.role !== 'context', priority: city.role !== 'context' ? 1000 : 200, angle: 0})),
    ...(map.geographicLabels ?? []).map(source => {
      const label = riverAnchor(source, map);
      return {...label, primary: false, priority: label.priority ?? 50, angle: clamp(label.angle ?? 0, -70, 70)};
    }),
  ].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const item of items) {
    const fontSize = item.kind === 'city' ? item.primary ? 36 : 24 : item.kind === 'mountain' ? 30 : item.kind === 'region' ? 28 : 25;
    const letterSpacing = item.kind === 'mountain' ? 7 : item.kind === 'region' ? 5 : item.kind === 'city' ? 1 : 2;
    const size = dimensions(item.text, fontSize, letterSpacing, item.angle);
    const label: AtlasLabel = {...item, ...size, fontSize, letterSpacing, offsetX: 0, offsetY: 0, hidden: false};
    const anchors = cameras.map(camera => atlasLabelAt(label, map, camera, viewport).anchor);
    const minOffsetX = Math.max(...anchors.map(anchor => bounds.x + size.width / 2 - anchor.x));
    const maxOffsetX = Math.min(...anchors.map(anchor => bounds.x + bounds.width - size.width / 2 - anchor.x));
    const minOffsetY = Math.max(...anchors.map(anchor => bounds.y + size.height / 2 - anchor.y));
    const maxOffsetY = Math.min(...anchors.map(anchor => bounds.y + bounds.height - size.height / 2 - anchor.y));
    const radians = item.angle * Math.PI / 180;
    const riverOffsets = [18, -18, 0].flatMap(normal => [0, -8, 8].map(along => [
      Math.cos(radians) * along - Math.sin(radians) * normal,
      Math.sin(radians) * along + Math.cos(radians) * normal,
    ]));
    const offsets = item.kind === 'city' ? [12, 28, 52, 84, 128, 184, 250].flatMap(gap => [
      [size.width / 2 + gap, -size.height / 2 - 5], [-size.width / 2 - gap, -size.height / 2 - 5],
      [size.width / 2 + gap, size.height / 2 + 5], [-size.width / 2 - gap, size.height / 2 + 5],
      [0, -size.height / 2 - gap], [0, size.height / 2 + gap],
    ]) : item.kind === 'river' ? riverOffsets : [[0, 0], [0, -22], [0, 22], [-30, 0], [30, 0]];
    const candidates = offsets.map(([dx, dy]) => ({...label,
      offsetX: clamp(dx, minOffsetX, maxOffsetX),
      offsetY: clamp(dy, minOffsetY, maxOffsetY),
    }));
    const collision = (candidate: AtlasLabel) => cameras.reduce((sum, camera, index) => {
      const {box} = atlasLabelAt(candidate, map, camera, viewport);
      const outside = box.width * box.height - mapLabelOverlap(box, bounds);
      const obstacles = [...forceObstacles[index], ...cityObstacles[index],
        ...planned.filter(other => !other.hidden).map(other => pad(atlasLabelAt(other, map, camera, viewport).box, 7))];
      return sum + outside * 20 + obstacles.reduce((total, obstacle) => total + mapLabelOverlap(box, obstacle), 0);
    }, 0);
    const ranked = candidates.map((candidate, index) => ({candidate, overlap: collision(candidate), index}));
    ranked.sort((a, b) => a.overlap - b.overlap || (item.kind === 'river' ? a.index - b.index :
      Math.hypot(a.candidate.offsetX, a.candidate.offsetY) - Math.hypot(b.candidate.offsetX, b.candidate.offsetY)) || a.index - b.index);
    const best = ranked[0];
    // Geographic names stay near their actual feature; safe-area clamping must not move a peninsula into the sea.
    const geographicDisplacement = item.kind !== 'city' && Math.hypot(best.candidate.offsetX, best.candidate.offsetY) > (item.kind === 'river' ? 22 : 48);
    // Secondary context yields to cities and army badges; primary city names keep a leader when crowded.
    planned.push({...best.candidate, hidden: !item.primary && (best.overlap > .1 || geographicDisplacement)});
  }
  return planned;
}
