import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {HistoryMapFlag, HistoryMapForces} from './HistoryMapForces';
import type {HistoryMotionMap} from './HistoryMapScene';
import {mapCityControlAt, mapForceState, type MapForceBox} from './history-map-forces';
import {referenceRoutePoint} from './reference-editorial-core';

export type JiangshanOverlayInput = {
  frame: number;
  fps: number;
  width: number;
  height: number;
  /** Screen pixels from the upstream map's current getScreenCTM(), including its camera. */
  cities: {name: string; x: number; y: number}[];
  /** Current native SVG text bounds in viewport pixels. */
  labelObstacles?: MapForceBox[];
};

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => {const t = clamp(n); return t * t * (3 - 2 * t);};

export function jiangshanOverlayState(input: JiangshanOverlayInput) {
  const {frame, fps, width, height} = input;
  if (!Number.isInteger(frame) || frame < 0 || !Number.isFinite(fps) || fps <= 0
    || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw Error('Invalid overlay frame or viewport');
  const cities = ['长安', '洛阳'].map(name => {
    const matches = input.cities.filter(city => city.name === name);
    if (matches.length !== 1 || !Number.isFinite(matches[0].x) || !Number.isFinite(matches[0].y)) throw Error(`Missing or ambiguous projected city: ${name}`);
    return {name, x: matches[0].x / width, y: matches[0].y / height, role: 'primary' as const};
  });
  const seconds = frame / fps;
  const phase = seconds < 2 ? '原生地图与地名' : seconds < 6 ? '演示军从长安行进' : seconds < 8 ? '抵达洛阳，发起进攻'
    : seconds < 10 ? '占领中' : '占领完成，驻军留守';
  const route = {points: cities.map(city => [city.x, city.y] as [number, number]), color: '#b03c34', start: 2, end: 6};
  const army = {id: 'demonstration-army', faction: '演示军', flagText: '演示', color: route.color, city: '洛阳',
    routeIndex: 0, action: 'march' as const, troopKind: 'infantry' as const, start: route.start, end: route.end};
  const occupation = {id: 'demonstration-occupation', faction: '演示军', flagText: '演示', color: '#b03c34', city: '洛阳',
    action: 'occupy' as const, start: 8, end: 10};
  const map: HistoryMotionMap = {
    enabled: true, width, height, backgroundSrc: 'unused-native-map-is-owned-by-parent',
    provenance: {verified: false, source: 'Jiangshan native map viewport', license: 'Pending per-layer verification',
      projection: 'Native projected screen coordinates', historyStatus: 'illustrative', attribution: '江山地图；虚构动作演示'},
    cities, routes: [route], forces: [army, occupation],
  };
  const forceState = mapForceState(army, map, seconds);
  const owner = mapCityControlAt(map, '洛阳', seconds);
  return {seconds, phase, map, army, route, forceState, owner, occupationProgress: smooth((seconds - 8) / 2)};
}

/** No map pixels or geographic labels are rendered here: the upstream page owns them. */
export function JiangshanMapPilot(input: JiangshanOverlayInput) {
  const {width, height} = input;
  const {seconds, phase, map, army, route, forceState, owner, occupationProgress} = jiangshanOverlayState(input);
  const head = referenceRoutePoint(route.points, forceState.progress, width, height);
  const destination = route.points[1];
  const x = destination[0] * width, y = destination[1] * height;
  const path = route.points.map(([px, py], i) => `${i ? 'L' : 'M'}${px * width} ${py * height}`).join(' ');
  const attackActive = seconds >= 6 && seconds < 8;
  const attackPhase = (seconds - 6) * 1.5 % 1;
  const uiScale = Math.min(width / 1920, height / 1080);
  return <div style={{position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', color: '#302b24', fontFamily: '"Noto Serif SC", "Songti SC", serif'}}>
    <svg width={width} height={height} style={{position: 'absolute', inset: 0}} aria-label="虚构动作演示图层">
      <defs>
        <mask id="jiangshan-route-label-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
          <rect x={0} y={0} width={width} height={height} fill="white"/>
          {input.labelObstacles?.map((box, index) => <rect key={index} x={box.x - 4} y={box.y - 4}
            width={box.width + 8} height={box.height + 8} fill="black"/>)}
        </mask>
      </defs>
      <g mask="url(#jiangshan-route-label-mask)">
        <path d={path} fill="none" stroke={route.color} strokeWidth={2} strokeDasharray="6 8" opacity={.22}/>
        {forceState.progress > 0 ? <>
          <path d={path} fill="none" stroke="#fff9e8" strokeWidth={12} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - forceState.progress}/>
          <path d={path} fill="none" stroke={route.color} strokeWidth={7} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - forceState.progress}/>
          <path d="M15 0 L-12 -9 L-6 0 L-12 9Z" fill={route.color} stroke="#fff9e9" strokeWidth={1.5}
            transform={`translate(${head.x} ${head.y}) rotate(${head.angle})`}/>
        </> : null}
      </g>
      {attackActive ? <g data-action="demonstration-attack">
        <circle cx={x} cy={y} r={22 + attackPhase * 34} fill="none" stroke={route.color} strokeWidth={4} opacity={1 - attackPhase}/>
        <circle cx={x} cy={y} r={21} fill={route.color} opacity={.14 + .1 * Math.sin((seconds - 6) * Math.PI * 3) ** 2}/>
      </g> : null}
      {occupationProgress > 0 ? <g data-action="demonstration-occupation-marker">
        <circle cx={x} cy={y} r={25} fill={route.color} opacity={.15 * occupationProgress}/>
        <circle cx={x} cy={y} r={25} fill="none" stroke="#fff9e8" strokeWidth={7} opacity={occupationProgress}/>
        <circle cx={x} cy={y} r={25} fill="none" stroke={route.color} strokeWidth={4} pathLength={1}
          strokeDasharray={1} strokeDashoffset={1 - occupationProgress} transform={`rotate(-90 ${x} ${y})`}/>
        {owner ? <g transform={`translate(${x - 28} ${y - 30}) scale(.7)`}>
          <HistoryMapFlag text={owner.flagText} color={owner.color} seconds={seconds} planted/>
        </g> : null}
      </g> : null}
    </svg>
    <HistoryMapForces map={{...map, forces: [army]}} seconds={seconds}
      camera={{focusX: .5, focusY: .5, zoom: 1}} width={width} height={height} labelObstacles={input.labelObstacles}/>
    <div style={{position: 'absolute', left: 28 * uiScale, right: 28 * uiScale, top: 20 * uiScale, display: 'flex', justifyContent: 'space-between'}}>
      <div style={{padding: `${8 * uiScale}px ${16 * uiScale}px`, background: 'rgba(250,246,235,.88)', fontSize: 28 * uiScale}}>江山地图 × 逐帧推演</div>
      <div style={{padding: `${8 * uiScale}px ${16 * uiScale}px`, background: 'rgba(250,246,235,.88)', fontSize: 24 * uiScale}}>{phase}</div>
    </div>
    <div style={{position: 'absolute', left: 28 * uiScale, right: 28 * uiScale, bottom: 20 * uiScale,
      padding: `${9 * uiScale}px ${16 * uiScale}px`, background: 'rgba(250,246,235,.90)', fontSize: 24 * uiScale, textAlign: 'center'}}>
      741年唐代地图 · 虚构行动与路线示意 · 内部预览
    </div>
  </div>;
}

let root: Root | undefined;
let rootElement: HTMLElement | null = null;
export function renderJiangshanOverlay(input: JiangshanOverlayInput) {
  const state = jiangshanOverlayState(input);
  const element = document.getElementById('jiangshan-video-overlay');
  if (!element) throw Error('Missing #jiangshan-video-overlay');
  if (element !== rootElement) {
    root?.unmount();
    root = createRoot(element);
    rootElement = element;
  }
  flushSync(() => root!.render(<JiangshanMapPilot {...input}/>));
  return {frame: input.frame, seconds: state.seconds, phase: state.phase, routeProgress: state.forceState.progress,
    armyAnchor: {x: state.forceState.anchor.x, y: state.forceState.anchor.y}, occupationProgress: state.occupationProgress,
    occupationMarkerVisible: Boolean(state.owner), historicalTerritoryChanged: false};
}

declare global {
  interface Window {renderJiangshanOverlay: typeof renderJiangshanOverlay;}
}
window.renderJiangshanOverlay = renderJiangshanOverlay;
