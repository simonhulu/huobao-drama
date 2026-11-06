import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ease, makeRouteCurve, placeCommander, placeRegiment, regimentAtOffset, commanderAtOffset, planRefinedLayout, refinedTimeline, routeAt, routeRibbon, routeClearance, type Point, type Rect, type RouteCurve, type RefinedLayout} from './jiangshan-refined-geometry';

export type JiangshanRefinedInput = {
  frame: number; fps: number; width: number; height: number;
  cities: {name: string; x: number; y: number}[];
  labelObstacles?: Rect[];
  layout?: RefinedLayout;
  assets: {guoPortrait: string; liPortrait: string; cavalry: string; infantry: string};
};
const COLORS = {red: '#9c362d', redLight: '#d36a45', blue: '#285c68', blueLight: '#5d9296', ink: '#382d21', gold: '#b39155', paper: '#f4edda'};
const unitInfo = [
  {key: 'guo', name: '郭子仪', role: '骑军 · 主攻', flag: '郭', color: COLORS.red, light: COLORS.redLight, side: -1 as const},
  {key: 'li', name: '李光弼', role: '步军 · 迂回', flag: '李', color: COLORS.blue, light: COLORS.blueLight, side: 1 as const},
];

export function jiangshanRefinedState(input: JiangshanRefinedInput) {
  if (!Number.isInteger(input.frame) || input.frame < 0 || !Number.isFinite(input.fps) || input.fps <= 0
    || !Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) throw Error('Invalid refined map clock or viewport');
  const city = (name: string) => {
    const matches = input.cities.filter(item => item.name === name && Number.isFinite(item.x) && Number.isFinite(item.y));
    if (matches.length !== 1) throw Error(`Missing or ambiguous native city: ${name}`);
    return matches[0];
  };
  const start = city('长安'), auxiliary = city('商州'), target = city('洛阳');
  const seconds = input.frame / input.fps, timeline = refinedTimeline(seconds), scale = Math.min(input.width / 1920, input.height / 1080);
  const span = Math.hypot(target.x - start.x, target.y - start.y);
  // Positions on the siege perimeter are schematic offsets, not claims about historical troop locations.
  const approaches = [{x: target.x - span * .06, y: target.y - span * .20}, {x: target.x - span * .04, y: target.y + span * .24}];
  const curves = [makeRouteCurve(start, approaches[0], -.34), makeRouteCurve(auxiliary, approaches[1], .35)];
  const regimentBoxes: Rect[] = [];
  const formations = curves.map((curve, index) => {
    const anchor = routeAt(curve, timeline.routeProgress);
    const display = input.layout ? regimentAtOffset(anchor, input.layout.regiments[index], scale)
      : placeRegiment(anchor, unitInfo[index].side, input, input.labelObstacles || [], regimentBoxes);
    regimentBoxes.push(display.box);
    return {index, curve, anchor, display, ...unitInfo[index]};
  });
  const reserved: Rect[] = [];
  const units = formations.map(unit => {
    const card = input.layout ? commanderAtOffset(unit.anchor, input.layout.commanders[unit.index], scale, input)
      : placeCommander(unit.anchor, unit.side, input, [...(input.labelObstacles || []), ...regimentBoxes], reserved);
    reserved.push(card);
    return {...unit, card};
  });
  return {seconds, timeline, scale, target, span, units};
}

function Banner({x, y, color, text, seconds, scale = 1}: {x: number; y: number; color: string; text: string; seconds: number; scale?: number}) {
  const wave = Math.sin(seconds * 3.2) * 2.4;
  return <g transform={`translate(${x} ${y}) scale(${scale})`}>
    <path d="M0 -42 V21" stroke="#f4e7ca" strokeWidth={4}/>
    <path d="M0 -42 V21" stroke="#654c2f" strokeWidth={1.7}/>
    <path d={`M2 -40 Q20 ${-44 + wave} 41 -38 L${38 + wave} -12 Q21 ${-16 + wave} 2 -10Z`} fill={color} stroke="#d8bd83" strokeWidth={1.2}/>
    <path d={`M7 -36 Q20 ${-39 + wave} 35 -34`} fill="none" stroke="#f3d69e" strokeWidth={.7} opacity={.65}/>
    <text x={21} y={-19} fontSize={19} fontWeight={700} textAnchor="middle" fill="#f9edd1">{text}</text>
  </g>;
}

function Route({curve, progress, index, scale, seconds}: {curve: RouteCurve; progress: number; index: number; scale: number; seconds: number}) {
  const info = unitInfo[index], ribbon = routeRibbon(curve, progress, 16 * scale);
  return <g mask="url(#refined-city-symbol-mask)" data-route={index}>
    <path data-route-centerline={index} d={curve.path} fill="none" stroke="#fff7df" strokeWidth={4 * scale} opacity={.38}/>
    <path d={curve.path} fill="none" stroke={info.color} strokeWidth={1.6 * scale} strokeDasharray={`${3 * scale} ${9 * scale}`} opacity={.42}/>
    {ribbon.path ? <>
      <path d={ribbon.path} fill={info.color} stroke="#fff4d7" strokeWidth={5 * scale} strokeLinejoin="round" opacity={.48}/>
      <path d={ribbon.path} fill={`url(#refined-arrow-${index})`} stroke={info.color} strokeWidth={1.1 * scale} strokeLinejoin="round"/>
      <path d={curve.path} fill="none" stroke="#ffe2aa" strokeWidth={.8 * scale} pathLength={1}
        strokeDasharray={`${Math.max(0, progress - .045)} 1`} opacity={.56}/>
    </> : null}
    {[.19, .37, .56, .73].filter(fraction => fraction < progress - .03).map((fraction, i) => {
      const point = routeAt(curve, fraction);
      return <path key={fraction} d="M-5 -4 L0 0 L-5 4" fill="none" stroke="#fce7bd" strokeWidth={1.7}
        opacity={.45 + .18 * Math.sin(seconds * 2 - i)} transform={`translate(${point.x} ${point.y}) rotate(${point.angle * 180 / Math.PI}) scale(${scale})`}/>;
    })}
  </g>;
}

function Commander({box, image, index, anchor, scale}: {box: Rect; image: string; index: number; anchor: Point; scale: number}) {
  const info = unitInfo[index], cx = box.x + box.width / 2;
  const originY = info.side < 0 ? box.y + box.height : box.y;
  return <g>
    <path d={`M${cx} ${originY} Q${cx} ${(originY + anchor.y) / 2} ${anchor.x} ${anchor.y}`} fill="none" stroke="#fbf1d8" strokeWidth={3.2 * scale} opacity={.72}/>
    <path d={`M${cx} ${originY} Q${cx} ${(originY + anchor.y) / 2} ${anchor.x} ${anchor.y}`} fill="none" stroke={info.color} strokeWidth={1.2 * scale} opacity={.72}/>
    <g transform={`translate(${box.x} ${box.y}) scale(${scale})`} filter="url(#refined-card-shadow)">
      <path d="M8 0 H100 Q108 0 108 8 V128 L98 147 H10 L0 128 V8 Q0 0 8 0Z" fill="#f7efdc" stroke="#7a6445" strokeWidth={1}/>
      <path d="M7 6 H101 V94 L94 102 H14 L7 94Z" fill="#282b2b" stroke={info.color} strokeWidth={2}/>
      <image href={image} x={-9} y={-7} width={126} height={128} preserveAspectRatio="xMidYMid slice" clipPath={`url(#refined-portrait-${index})`}/>
      <path d="M7 76 V94 L14 102 H94 L101 94 V76" fill={`url(#refined-portrait-shade)`}/>
      <path d="M12 110 H96" stroke={info.color} strokeWidth={1} opacity={.44}/>
      <text x={54} y={130} fontSize={24} fontWeight={700} fill={COLORS.ink} textAnchor="middle">{info.name}</text>
      <rect x={18} y={-9} width={72} height={22} rx={2} fill={info.color} stroke="#dcc28d" strokeWidth={1}/>
      <text x={54} y={6} fontSize={13} fontWeight={600} textAnchor="middle" fill="#fff1d3">{info.role}</text>
      <path d="M4 9 V33 M104 9 V33 M8 140 H26 M82 140 H100" stroke="#c3a36c" strokeWidth={1.2}/>
    </g>
  </g>;
}

function Regiment({image, anchor: geographicAnchor, display: anchor, index, seconds, moving, scale}: {image: string; anchor: Point; display: Point; index: number; seconds: number; moving: boolean; scale: number}) {
  const info = unitInfo[index], bounce = moving ? Math.sin(seconds * 8 + index) * 1.5 * scale : 0;
  return <g data-regiment={info.key}>
    <path d={`M${geographicAnchor.x} ${geographicAnchor.y} L${anchor.x} ${anchor.y}`} fill="none" stroke="#f6e9c9" strokeWidth={3} opacity={.8}/>
    <path d={`M${geographicAnchor.x} ${geographicAnchor.y} L${anchor.x} ${anchor.y}`} fill="none" stroke={info.color} strokeWidth={1} opacity={.6}/>
    <ellipse cx={anchor.x} cy={anchor.y + 3 * scale} rx={45 * scale} ry={12 * scale} fill="#423425" opacity={.15}/>
    <ellipse cx={anchor.x} cy={anchor.y + 2 * scale} rx={38 * scale} ry={9 * scale} fill={info.color} opacity={.14} stroke={info.color} strokeWidth={1}/>
    <image href={image} x={anchor.x - 64 * scale} y={anchor.y - 103 * scale + bounce} width={128 * scale} height={112 * scale} preserveAspectRatio="xMidYMid meet"/>
    <Banner x={anchor.x + 38 * scale} y={anchor.y - 28 * scale + bounce} color={info.color} text={info.flag} seconds={seconds} scale={.7 * scale}/>
    <circle cx={geographicAnchor.x} cy={geographicAnchor.y} r={3.8 * scale} fill={info.color} stroke="#ffefcf" strokeWidth={1.5}/>
    {moving ? [0, 1, 2].map(i => <ellipse key={i} cx={anchor.x - (16 + i * 13) * scale} cy={anchor.y + 8 * scale}
      rx={(9 + i * 4) * scale} ry={(3 + i) * scale} fill="#a88754" opacity={.045 + .02 * Math.sin(seconds * 3 + i)}/>) : null}
  </g>;
}

function ellipseArc(center: Point, rx: number, ry: number, start: number, end: number) {
  const a = {x: center.x + Math.cos(start) * rx, y: center.y + Math.sin(start) * ry};
  const b = {x: center.x + Math.cos(end) * rx, y: center.y + Math.sin(end) * ry};
  return `M${a.x} ${a.y} A${rx} ${ry} 0 ${end - start > Math.PI ? 1 : 0} 1 ${b.x} ${b.y}`;
}

export function JiangshanMapRefined(input: JiangshanRefinedInput) {
  const state = jiangshanRefinedState(input), {scale, seconds, timeline, target, units} = state;
  const {width, height} = input;
  const reveal = ease(seconds / .8), stageNames = ['部署', '行军', '合围', '占领', '驻留'];
  const siegeVisible = seconds >= 8.5, siegeOpacity = ease((seconds - 8.5) / .5);
  const radius = (118 - 40 * timeline.assault) * scale;
  return <div style={{position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', fontFamily: '"Songti SC", "Noto Serif SC", serif', color: COLORS.ink}}>
    <svg width={width} height={height} style={{position: 'absolute', inset: 0}} aria-label="将领、兵种和双路合击演示">
      <defs>
        <filter id="refined-card-shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx={0} dy={3} stdDeviation={3} floodColor="#2d2416" floodOpacity={.25}/></filter>
        <radialGradient id="refined-control-wash"><stop offset="0%" stopColor="#bc7848" stopOpacity={.25}/><stop offset="100%" stopColor="#bc7848" stopOpacity={0}/></radialGradient>
        <linearGradient id="refined-portrait-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#171e20" stopOpacity={0}/><stop offset="100%" stopColor="#171e20" stopOpacity={.55}/></linearGradient>
        {units.map((unit, index) => <React.Fragment key={unit.key}>
          <linearGradient id={`refined-arrow-${index}`} gradientUnits="userSpaceOnUse" x1={unit.curve.points[0].x} y1={unit.curve.points[0].y}
            x2={unit.curve.points.at(-1)!.x} y2={unit.curve.points.at(-1)!.y}><stop offset="0%" stopColor={unit.color}/><stop offset="70%" stopColor={unit.light}/><stop offset="100%" stopColor={unit.color}/></linearGradient>
          <clipPath id={`refined-portrait-${index}`} clipPathUnits="userSpaceOnUse"><path d="M8 7 H100 V94 L94 101 H14 L8 94Z"/></clipPath>
        </React.Fragment>)}
        <mask id="refined-native-label-mask" maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
          <rect width={width} height={height} fill="white"/>
          {input.labelObstacles?.map((box, index) => <rect key={index} x={box.x - 3} y={box.y - 3} width={box.width + 6} height={box.height + 6} fill="black"/>)}
          {input.cities.map(city => <circle key={city.name} cx={city.x} cy={city.y} r={21 * scale} fill="black"/>)}
        </mask>
        <mask id="refined-city-symbol-mask" maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
          <rect width={width} height={height} fill="white"/>
          {input.cities.map(city => <circle key={city.name} cx={city.x} cy={city.y} r={21 * scale} fill="black"/>)}
        </mask>
      </defs>
      <g opacity={reveal}>{units.map((unit, index) => <Route key={unit.key} curve={unit.curve} progress={timeline.routeProgress} index={index} scale={scale} seconds={seconds}/>)}</g>
      {siegeVisible ? <g opacity={siegeOpacity} mask="url(#refined-native-label-mask)">
        <ellipse cx={target.x} cy={target.y} rx={radius * 1.13} ry={radius * .8} fill="url(#refined-control-wash)"/>
        <ellipse cx={target.x} cy={target.y} rx={radius} ry={radius * .66} fill="none" stroke="#755333" strokeWidth={1.2 * scale} strokeDasharray={`${4 * scale} ${8 * scale}`} opacity={.5}/>
        <path d={ellipseArc(target, radius, radius * .66, Math.PI * 1.02, Math.PI * 1.8)} fill="none" stroke={COLORS.red} strokeWidth={3 * scale} strokeLinecap="round" opacity={.8}/>
        <path d={ellipseArc(target, radius, radius * .66, Math.PI * .08, Math.PI * .88)} fill="none" stroke={COLORS.blue} strokeWidth={3 * scale} strokeLinecap="round" opacity={.8}/>
        {seconds < 12 ? [-2.5, 2.5].map((angle, i) => {
          const pulse = (seconds - 8.5) / 1.3 % 1, r = radius * (1.22 - pulse * .4);
          return <path key={angle} d="M-7 -6 L3 0 L-7 6" fill="none" stroke={unitInfo[i].color} strokeWidth={2.5 * scale} opacity={.7 * Math.sin(Math.PI * pulse)}
            transform={`translate(${target.x + Math.cos(angle) * r} ${target.y + Math.sin(angle) * r * .66}) rotate(${angle * 180 / Math.PI + 180}) scale(${scale})`}/>;
        }) : null}
      </g> : null}
      <g opacity={reveal}>{units.map((unit, index) => <React.Fragment key={unit.key}>
        <Commander box={unit.card} image={index === 0 ? input.assets.guoPortrait : input.assets.liPortrait} index={index} anchor={unit.anchor} scale={scale}/>
        <Regiment image={index === 0 ? input.assets.cavalry : input.assets.infantry} anchor={unit.anchor} display={unit.display} index={index}
          seconds={seconds} moving={seconds >= 2.5 && seconds < 12} scale={scale}/>
      </React.Fragment>)}</g>
      {timeline.occupation > 0 ? <g>
        <circle cx={target.x} cy={target.y} r={25 * scale} fill="#f8e9c5" opacity={timeline.occupation * .65}/>
        <circle cx={target.x} cy={target.y} r={25 * scale} fill="none" stroke="#9c362d" strokeWidth={3 * scale} pathLength={1}
          strokeDasharray="1" strokeDashoffset={1 - timeline.occupation} transform={`rotate(-90 ${target.x} ${target.y})`}/>
        {timeline.occupationComplete ? <>
          <Banner x={target.x + 11 * scale} y={target.y - 23 * scale} color={COLORS.red} text="唐" seconds={seconds} scale={.94 * scale}/>
          <circle cx={target.x} cy={target.y} r={7 * scale} fill={COLORS.red} stroke="#f7e7c1" strokeWidth={2}/>
        </> : null}
      </g> : null}
    </svg>
    <div style={{position: 'absolute', top: 28 * scale, left: 36 * scale, padding: `${12 * scale}px ${20 * scale}px`, background: 'linear-gradient(90deg,rgba(249,242,222,.96),rgba(249,242,222,.83))', borderLeft: `${4 * scale}px solid ${COLORS.red}`}}>
      <div style={{fontSize: 13 * scale, letterSpacing: 5 * scale, color: '#8c6c3c', marginBottom: 4 * scale}}>军 略 推 演</div>
      <div style={{fontSize: 38 * scale, fontWeight: 700, letterSpacing: 4 * scale}}>双路合击</div>
      <div style={{fontSize: 16 * scale, marginTop: 4 * scale, color: '#6d5d44'}}>将领 · 兵种 · 战术演示</div>
    </div>
    <div style={{position: 'absolute', right: 36 * scale, top: 28 * scale, padding: `${14 * scale}px ${20 * scale}px`, background: 'rgba(249,242,222,.9)', borderTop: `${2 * scale}px solid ${COLORS.gold}`}}>
      <div style={{fontSize: 13 * scale, color: '#87704e', letterSpacing: 3 * scale}}>战术阶段 · 0{timeline.phaseIndex + 1}</div>
      <div style={{fontSize: 27 * scale, fontWeight: 700, marginTop: 6 * scale}}>{timeline.phase}</div>
      <div style={{display: 'flex', gap: 17 * scale, fontSize: 15 * scale, marginTop: 8 * scale}}>
        <span style={{color: COLORS.red}}>● 骑军主攻</span><span style={{color: COLORS.blue}}>● 步军迂回</span>
      </div>
    </div>
    <div style={{position: 'absolute', bottom: 52 * scale, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 6 * scale, padding: `${9 * scale}px ${20 * scale}px`, background: 'rgba(248,241,221,.9)'}}>
      {stageNames.map((name, index) => <div key={name} style={{width: 86 * scale, textAlign: 'center', fontSize: 16 * scale, color: index === timeline.phaseIndex ? COLORS.red : '#8c806b', fontWeight: index === timeline.phaseIndex ? 700 : 400}}>
        <div style={{height: 2 * scale, background: index <= timeline.phaseIndex ? COLORS.red : '#d7cbb3', marginBottom: 7 * scale}}/>{name}
      </div>)}
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 38 * scale, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(246,239,220,.90)', color: '#76654b', fontSize: 16 * scale, letterSpacing: .5 * scale}}>
      将领示意立绘 · 行军与部署为动画演示，非战役复原 · 江山原生地图
    </div>
  </div>;
}

let root: Root | undefined, rootElement: HTMLElement | null = null;
export function renderJiangshanRefined(input: JiangshanRefinedInput) {
  const state = jiangshanRefinedState(input);
  const element = document.getElementById('jiangshan-video-overlay');
  if (!element) throw Error('Missing #jiangshan-video-overlay');
  if (element !== rootElement) {root?.unmount();root = createRoot(element);rootElement = element;}
  flushSync(() => root!.render(<JiangshanMapRefined {...input}/>));
  return {frame: input.frame, seconds: state.seconds, phase: state.timeline.phase, phaseIndex: state.timeline.phaseIndex,
    routeProgress: state.timeline.routeProgress, occupationProgress: state.timeline.occupation,
    occupationComplete: state.timeline.occupationComplete, historicalTerritoryChanged: false,
    units: state.units.map(unit => ({id: unit.key, name: unit.name, anchor: {x: unit.anchor.x, y: unit.anchor.y}, display: {x: unit.display.x, y: unit.display.y}, card: unit.card,
      arrowTip: routeRibbon(unit.curve, state.timeline.routeProgress, 16 * state.scale).tip, curveLength: unit.curve.length}))};
}
export function prepareJiangshanRefinedLayout(inputs: JiangshanRefinedInput[]) {
  return planRefinedLayout(inputs.map(input => {
    const state = jiangshanRefinedState(input);
    return {anchors: state.units.map(unit => unit.anchor), obstacles: input.labelObstacles || [],
      routeObstacles: state.units.flatMap(unit => routeClearance(unit.curve, 22 * state.scale))};
  }), inputs[0]);
}
declare global {interface Window {renderJiangshanRefined: typeof renderJiangshanRefined; prepareJiangshanRefinedLayout: typeof prepareJiangshanRefinedLayout;}}
window.renderJiangshanRefined = renderJiangshanRefined;
window.prepareJiangshanRefinedLayout = prepareJiangshanRefinedLayout;
