import {referenceRoutePoint} from './reference-editorial-core';

export type HistoryMapForce = {
  id: string;
  commander?: string;
  faction: string;
  flagText: string;
  color: string;
  city: string;
  routeIndex?: number;
  action: 'hold' | 'march' | 'attack' | 'occupy' | 'retreat';
  troopKind?: 'infantry' | 'cavalry';
  start: number;
  end: number;
  portraitSrc?: string;
  portraitSha256?: string;
};

type MapCity = {name: string; x: number; y: number; role?: 'primary' | 'context'};
type ForceMap = {
  width: number;
  height: number;
  cities?: MapCity[];
  routes?: {points: [number, number][]}[];
  forces?: HistoryMapForce[];
  encirclement?: {center: [number, number]; radiusX: number; radiusY: number};
};
type Point = {x: number; y: number};
export type MapForceBox = Point & {width: number; height: number};
type MapCamera = {focusX: number; focusY: number; zoom: number};
type Viewport = {width: number; height: number};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {const t = clamp(value); return t * t * (3 - 2 * t);};

export function mapForceState(force: HistoryMapForce, map: ForceMap, seconds: number) {
  const city = map.cities?.find(item => item.name === force.city);
  const route = force.routeIndex === undefined ? undefined : map.routes?.[force.routeIndex];
  const progress = smooth((seconds - force.start) / Math.max(.001, force.end - force.start));
  const perimeter = !route && force.action === 'attack' ? map.encirclement : undefined;
  // A schematic siege advances from the existing perimeter, never from inside the defended city.
  const perimeterRadius = 1.24 - .2 * progress;
  const anchor = route?.points.length && route.points.length > 1
    ? referenceRoutePoint(route.points, progress, map.width, map.height)
    : perimeter ? {
      x: (perimeter.center[0] + Math.cos(.72) * perimeter.radiusX * perimeterRadius) * map.width,
      y: (perimeter.center[1] + Math.sin(.72) * perimeter.radiusY * perimeterRadius) * map.height,
      angle: (.72 + Math.PI) * 180 / Math.PI,
    }
    : {x: (city?.x ?? .5) * map.width, y: (city?.y ?? .5) * map.height, angle: 0};
  return {
    visible: Boolean(city) && seconds >= force.start,
    anchor,
    progress,
    moving: Boolean(route || perimeter) && seconds >= force.start && seconds < force.end,
    arrived: seconds >= force.end,
    opacity: smooth((seconds - force.start) / Math.min(.35, Math.max(.05, (force.end - force.start) / 4))),
    arrival: smooth((seconds - force.end) / .4),
  };
}

export function mapCityControlAt(map: ForceMap, city: string, seconds: number) {
  return map.forces?.filter(force => force.city === city && force.action === 'occupy' && seconds >= force.end)
    .reduce<HistoryMapForce | undefined>((latest, force) => !latest || force.end >= latest.end ? force : latest, undefined);
}

export function projectMapPoint(point: Point, map: Pick<ForceMap, 'width' | 'height'>, camera: MapCamera, viewport: Viewport): Point {
  const fit = Math.min(viewport.width / map.width, viewport.height / map.height);
  return {
    x: viewport.width / 2 + (point.x - camera.focusX * map.width) * camera.zoom * fit,
    y: viewport.height / 2 + (point.y - camera.focusY * map.height) * camera.zoom * fit,
  };
}

const overlapArea = (a: MapForceBox, b: MapForceBox) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export function mapForceSafeBounds(viewport: Viewport): MapForceBox {
  const top = viewport.width < viewport.height ? 150 : 136;
  return {x: 28, y: top, width: viewport.width - 56, height: viewport.height * .69 - top};
}

export function layoutMapForces(map: ForceMap, seconds: number, camera: MapCamera, viewport: Viewport, labelObstacles: MapForceBox[] = []) {
  const bounds = mapForceSafeBounds(viewport);
  const referenceCamera = {focusX: .5, focusY: .5, zoom: 1};
  const occupied: MapForceBox[] = [];
  // Native labels already include camera projection and may sit on either side
  // of their markers. Padding covers text halos and the army's slight bobbing.
  const nativeLabels = labelObstacles.map(box => ({x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16}));
  const cityLabels = (map.cities ?? []).flatMap(city => {
    const anchor = projectMapPoint({x: city.x * map.width, y: city.y * map.height}, map, referenceCamera, viewport);
    const primary = city.role !== 'context', font = primary ? 42 : 27;
    const labelWidth = city.name.length * font + 24;
    return [
      {x: anchor.x - 17, y: anchor.y - 17, width: 34, height: 34},
      {x: city.x > .87 ? anchor.x + 14 - labelWidth : anchor.x + 12, y: anchor.y - (primary ? 59 : 42), width: labelWidth, height: font + 13},
    ];
  });
  return (map.forces ?? []).flatMap(force => {
    const state = mapForceState(force, map, seconds);
    const anchor = projectMapPoint(state.anchor, map, camera, viewport);
    const referenceAnchor = projectMapPoint(mapForceState(force, map, force.end).anchor, map, referenceCamera, viewport);
    const width = viewport.width < viewport.height ? 150 : 168;
    const height = force.portraitSrc ? 164 : 152;
    const perimeterAttack = force.action === 'attack' && force.routeIndex === undefined && map.encirclement;
    const preferred = perimeterAttack ? 1 : referenceAnchor.x > viewport.width * .55 ? -1 : 1;
    const offsets = [
      {x: preferred < 0 ? -width - 24 : 30, y: -height * .5},
      {x: preferred < 0 ? 30 : -width - 24, y: -height * .5},
      {x: -width * .5, y: -height - 45},
      {x: -width * .5, y: 44},
      {x: -width - 38, y: -height - 24},
      {x: 38, y: -height - 24},
      {x: -width - 38, y: 32},
      {x: 38, y: 32},
    ];
    // Pick a layout once at the destination; route/camera movement only translates and clamps it.
    const candidates = offsets.map(offset => ({
      x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, referenceAnchor.x + offset.x)),
      y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, referenceAnchor.y + offset.y)),
      width,
      height,
    }));
    const score = (box: MapForceBox, index: number) => occupied.reduce((sum, other) => sum + overlapArea(box, other) * 12, 0)
      + cityLabels.reduce((sum, label) => sum + overlapArea(box, label) * 4, 0)
      + Math.hypot(box.x + width / 2 - referenceAnchor.x, box.y + height / 2 - referenceAnchor.y) + index * 6;
    const referenceBox = candidates.reduce((best, candidate, index) => score(candidate, index) < score(best.box, best.index) ? {box: candidate, index} : best, {box: candidates[0], index: 0}).box;
    occupied.push({...referenceBox, x: referenceBox.x - 8, y: referenceBox.y - 8, width: referenceBox.width + 16, height: referenceBox.height + 16});
    if (!state.visible || anchor.x < -60 || anchor.y < -60 || anchor.x > viewport.width + 60 || anchor.y > viewport.height + 60) return [];
    const placeAtCurrentAnchor = (candidate: MapForceBox): MapForceBox => ({
      x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, anchor.x + candidate.x - referenceAnchor.x)),
      y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, anchor.y + candidate.y - referenceAnchor.y)),
      width,
      height,
    });
    let box = placeAtCurrentAnchor(referenceBox);
    const nativeOverlap = (candidate: MapForceBox) => nativeLabels.reduce((sum, label) => sum + overlapArea(candidate, label), 0);
    if (nativeOverlap(box) > 0) {
      const preferredBox = box;
      // Retain the stable destination-based placement whenever it is clear;
      // only resolve a real collision at the FINAL moving/clamped position.
      const scoreCurrent = (candidate: MapForceBox, index: number) => nativeOverlap(candidate) * 10_000
        + Math.hypot(candidate.x - preferredBox.x, candidate.y - preferredBox.y) + index * 6;
      box = candidates.map(placeAtCurrentAnchor).reduce((best, candidate, index) =>
        scoreCurrent(candidate, index) < scoreCurrent(best.box, best.index) ? {box: candidate, index} : best,
      {box: preferredBox, index: 0}).box;
    }
    return [{force, state, anchor, box}];
  });
}
