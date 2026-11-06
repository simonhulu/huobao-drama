export type Point = {x: number; y: number};
export type Rect = Point & {width: number; height: number};
export type CurveSample = Point & {distance: number; angle: number};
export type RouteCurve = {points: CurveSample[]; length: number; path: string};
export const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
export const ease = (value: number) => {const t = clamp01(value); return t * t * (3 - 2 * t);};
const pointText = (point: Point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;

/** Cubic control points are relative to geographic anchors, so the curve follows their projection. */
export function makeRouteCurve(start: Point, end: Point, bend: number, samples = 120): RouteCurve {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < .01 || !Number.isFinite(bend)) throw Error('A curved route requires two distinct finite anchors');
  const normal = {x: -dy / length, y: dx / length};
  const c1 = {x: start.x + dx * .31 + normal.x * length * bend, y: start.y + dy * .31 + normal.y * length * bend};
  const c2 = {x: start.x + dx * .72 + normal.x * length * bend, y: start.y + dy * .72 + normal.y * length * bend};
  const points: CurveSample[] = [];
  let distance = 0;
  for (let index = 0; index <= samples; index++) {
    const t = index / samples, u = 1 - t;
    const x = u ** 3 * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x;
    const y = u ** 3 * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * end.y;
    const tx = 3 * u * u * (c1.x - start.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (end.x - c2.x);
    const ty = 3 * u * u * (c1.y - start.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (end.y - c2.y);
    if (points.length) distance += Math.hypot(x - points[index - 1].x, y - points[index - 1].y);
    points.push({x, y, distance, angle: Math.atan2(ty, tx)});
  }
  return {points, length: distance, path: `M${pointText(start)} C${pointText(c1)} ${pointText(c2)} ${pointText(end)}`};
}

/** Arc-length sampling is shared by the ribbon tip, regiment and marching decorations. */
export function routeAt(curve: RouteCurve, progress: number): CurveSample {
  const distance = clamp01(progress) * curve.length;
  let index = curve.points.findIndex(point => point.distance >= distance);
  if (index < 1) return {...curve.points[0], distance};
  const a = curve.points[index - 1], b = curve.points[index];
  const mix = (distance - a.distance) / Math.max(.0001, b.distance - a.distance);
  let rotation = b.angle - a.angle;
  if (rotation > Math.PI) rotation -= 2 * Math.PI;
  if (rotation < -Math.PI) rotation += 2 * Math.PI;
  return {x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, distance, angle: a.angle + rotation * mix};
}

/** A continuous tapered arrow silhouette; its pointed tip is exactly routeAt(curve, progress). */
export function routeRibbon(curve: RouteCurve, progress: number, width = 16): {path: string; tip: CurveSample} {
  const tip = routeAt(curve, progress), distance = tip.distance;
  if (distance < 2) return {path: '', tip};
  const headLength = Math.min(width * 2.2, distance * .38);
  const bodyLength = Math.max(0, distance - headLength);
  const left: Point[] = [], right: Point[] = [];
  const steps = Math.max(2, Math.ceil(bodyLength / 5));
  for (let index = 0; index <= steps; index++) {
    const d = bodyLength * index / steps;
    const point = routeAt(curve, d / curve.length);
    const half = width * (.12 + .38 * Math.sqrt(index / steps));
    const nx = -Math.sin(point.angle), ny = Math.cos(point.angle);
    left.push({x: point.x + nx * half, y: point.y + ny * half});
    right.push({x: point.x - nx * half, y: point.y - ny * half});
  }
  const neck = routeAt(curve, bodyLength / curve.length);
  const nx = -Math.sin(neck.angle), ny = Math.cos(neck.angle);
  const shoulder = width * 1.02;
  const outline = [...left, {x: neck.x + nx * shoulder, y: neck.y + ny * shoulder}, tip,
    {x: neck.x - nx * shoulder, y: neck.y - ny * shoulder}, ...right.reverse()];
  return {path: `M${outline.map(pointText).join(' L')} Z`, tip};
}

export function refinedTimeline(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw Error('Invalid map clock');
  const march = ease((seconds - 2.5) / 6);
  const assault = ease((seconds - 8.5) / 3.5);
  const occupation = ease((seconds - 12) / 2);
  const phaseIndex = seconds < 2.5 ? 0 : seconds < 8.5 ? 1 : seconds < 12 ? 2 : seconds < 14 ? 3 : 4;
  return {phaseIndex, phase: ['两路部署', '分进合击', '合围推进', '控制据点', '驻军留守'][phaseIndex],
    march, assault, occupation, routeProgress: .82 * march + .12 * assault, occupationComplete: seconds >= 14};
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export type RefinedLayout = {regiments: Point[]; commanders: Point[]};
export type LayoutSample = {anchors: Point[]; obstacles: Rect[]; routeObstacles?: Rect[]};

/** Reserve the whole route, including its arrowhead and outline, before placing portrait cards. */
export function routeClearance(curve: RouteCurve, padding: number): Rect[] {
  const boxes: Rect[] = [];
  for (let i = 0; i < curve.points.length - 1; i += 4) {
    const points = curve.points.slice(i, i + 5);
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    boxes.push({x: x - padding, y: y - padding, width: Math.max(...xs) - x + padding * 2, height: Math.max(...ys) - y + padding * 2});
  }
  return boxes;
}

export function regimentAtOffset(anchor: Point, offset: Point, scale: number) {
  const x = anchor.x + offset.x * scale, y = anchor.y + offset.y * scale;
  return {x, y, box: {x: x - 76 * scale, y: y - 112 * scale, width: 156 * scale, height: 126 * scale}};
}

export function commanderAtOffset(anchor: Point, offset: Point, scale: number, viewport?: {width: number; height: number}): Rect {
  const x = anchor.x + offset.x * scale, y = anchor.y + offset.y * scale;
  return {x: viewport ? Math.max(28 * scale, Math.min(viewport.width - 136 * scale, x)) : x,
    y: viewport ? Math.max(105 * scale, Math.min(viewport.height - 262 * scale, y)) : y,
    width: 108 * scale, height: 150 * scale};
}

/** Choose one offset for the whole shot: native labels cannot cause per-frame teleporting. */
export function planRefinedLayout(samples: LayoutSample[], viewport: {width: number; height: number}): RefinedLayout {
  if (!samples.length || samples.some(sample => sample.anchors.length !== 2)) throw Error('A layout needs both army anchors for the whole shot');
  const scale = Math.min(viewport.width / 1920, viewport.height / 1080);
  const layout: RefinedLayout = {regiments: [], commanders: []};
  const chosen: Rect[][] = samples.map(() => []);
  const choose = (unit: number, card: boolean) => {
    let best: Point = {x: 0, y: 0}, bestScore = Infinity;
    const preferred = card ? {x: unit === 0 ? -198 : 82, y: unit === 0 ? -190 : 55} : {x: 0, y: 0};
    const candidates: Point[] = [preferred];
    for (let y = card ? (unit === 0 ? -420 : 40) : -160; y <= (card ? (unit === 0 ? -165 : 260) : 180); y += 15)
      for (let x = card ? -520 : -180; x <= (card ? 440 : 180); x += 15) candidates.push({x, y});
    for (const offset of candidates) {
      let score = card ? .2 * Math.hypot(offset.x + 54, offset.y + (unit === 0 ? 150 : 0)) : Math.hypot(offset.x, offset.y);
      let collisions = 0;
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i], anchor = sample.anchors[unit];
        const box = card ? commanderAtOffset(anchor, offset, scale, viewport) : regimentAtOffset(anchor, offset, scale).box;
        if (box.x < 28 * scale || box.x + box.width > viewport.width - 28 * scale || box.y < (card ? 105 : 155) * scale || box.y + box.height > viewport.height - 112 * scale) {
          score = Infinity; break;
        }
        const area = sample.obstacles.reduce((sum, obstacle) => sum + overlap(box, obstacle), 0);
        const reservedArea = chosen[i].reduce((sum, obstacle) => sum + overlap(box, obstacle), 0);
        if (reservedArea > 0) {score = Infinity; break;}
        // Include the title tab and shadow; neither may cut through an animated arrow.
        const cardBounds = {x: box.x - 6 * scale, y: box.y - 12 * scale, width: box.width + 12 * scale, height: box.height + 18 * scale};
        if (card && sample.routeObstacles?.some(obstacle => overlap(cardBounds, obstacle) > 0)) {score = Infinity; break;}
        collisions += area / (scale * scale);
      }
      score += collisions / samples.length * 30;
      if (score < bestScore) {best = offset; bestScore = score;}
    }
    if (!Number.isFinite(bestScore)) throw Error(`No stable ${card ? 'commander' : 'regiment'} layout for unit ${unit}`);
    samples.forEach((sample, index) => {
      const box = card ? commanderAtOffset(sample.anchors[unit], best, scale, viewport) : regimentAtOffset(sample.anchors[unit], best, scale).box;
      chosen[index].push(box);
    });
    return best;
  };
  for (let unit = 0; unit < 2; unit++) layout.regiments.push(choose(unit, false));
  for (let unit = 0; unit < 2; unit++) layout.commanders.push(choose(unit, true));
  return layout;
}

/** The dot keeps the geographic anchor; a nearby sprite yields to native labels. */
export function placeRegiment(anchor: Point, side: -1 | 1, viewport: {width: number; height: number}, obstacles: Rect[], reserved: Rect[] = []) {
  const scale = Math.min(viewport.width / 1920, viewport.height / 1080);
  const offsets = [{x: 0, y: 0}, {x: side * 112, y: 0}, {x: -side * 112, y: 0}, {x: 0, y: 112}, {x: 0, y: -100}, {x: side * 165, y: 42}];
  const options = offsets.map(offset => {
    const x = Math.max(90 * scale, Math.min(viewport.width - 90 * scale, anchor.x + offset.x * scale));
    const y = Math.max(250 * scale, Math.min(viewport.height - 150 * scale, anchor.y + offset.y * scale));
    return {x, y, box: {x: x - 76 * scale, y: y - 112 * scale, width: 156 * scale, height: 126 * scale}};
  });
  const score = (candidate: typeof options[number], index: number) => [...obstacles, ...reserved].reduce((sum, item) => sum + overlap(candidate.box, item), 0) * 10000
    + Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y) + index * 5;
  return options.reduce((best, candidate, index) => score(candidate, index) < score(best.value, best.index) ? {value: candidate, index} : best,
    {value: options[0], index: 0}).value;
}

/** Resolve against current native label bounds, preferring one consistent side of each route. */
export function placeCommander(anchor: Point, side: -1 | 1, viewport: {width: number; height: number}, obstacles: Rect[], reserved: Rect[] = []): Rect {
  const scale = Math.min(viewport.width / 1920, viewport.height / 1080), width = 108 * scale, height = 150 * scale;
  const candidates = [
    {x: anchor.x - width * .5, y: anchor.y + (side < 0 ? -height - 76 * scale : 86 * scale)},
    {x: anchor.x - width - 90 * scale, y: anchor.y + (side < 0 ? -height - 40 * scale : 55 * scale)},
    {x: anchor.x + 82 * scale, y: anchor.y + (side < 0 ? -height - 40 * scale : 55 * scale)},
    {x: anchor.x - width * .5, y: anchor.y + (side < 0 ? -height - 130 * scale : 140 * scale)},
  ].map(point => ({x: Math.max(30 * scale, Math.min(viewport.width - width - 30 * scale, point.x)),
    y: Math.max(150 * scale, Math.min(viewport.height - height - 100 * scale, point.y)), width, height}));
  const score = (box: Rect, index: number) => obstacles.reduce((sum, item) => sum + overlap(box, item), 0) * 30
    + reserved.reduce((sum, item) => sum + overlap(box, item), 0) * 300 + index * 140;
  return candidates.reduce((best, box, index) => score(box, index) < score(best.box, best.index) ? {box, index} : best,
    {box: candidates[0], index: 0}).box;
}
