import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

type Point = {x: number; y: number};
export type HistoryMapScene = {
  width: number;
  height: number;
  routes: Record<'redMain' | 'redFlank' | 'blueAdvance' | 'blueRetreat', Point[]>;
  places: Record<'pass' | 'redCamp' | 'blueCamp' | 'northRidge' | 'river', Point>;
};

const FONT = '"PingFang SC", "Hiragino Sans GB", sans-serif';
const INK = '#f3f5eb';
const RED = '#ef745b';
const BLUE = '#72c4e7';
const GOLD = '#f1ce7b';
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const smooth = (value: number) => {const t = clamp(value); return t * t * (3 - 2 * t);};
const progress = (time: number, start: number, end: number) => smooth((time - start) / (end - start));

function along(points: Point[], fraction: number): Point & {angle: number} {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  let distance = clamp(fraction) * lengths.reduce((sum, length) => sum + length, 0);
  for (let index = 0; index < lengths.length; index++) {
    if (distance <= lengths[index] || index === lengths.length - 1) {
      const start = points[index], end = points[index + 1];
      const t = lengths[index] ? clamp(distance / lengths[index]) : 0;
      return {x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t,
        angle: Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI};
    }
    distance -= lengths[index];
  }
  return {...points[0], angle: 0};
}

function Route({points, value, color, opacity = 1, dashed = false}: {
  points: Point[]; value: number; color: string; opacity?: number; dashed?: boolean;
}) {
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const head = along(points, value);
  return <g opacity={opacity}>
    <path d={path} fill="none" stroke={color} strokeWidth={3} opacity={0.19} strokeDasharray="6 12"/>
    <path d={path} fill="none" stroke="#132d29" strokeWidth={17} strokeLinecap="round"
      pathLength={1} strokeDasharray="1" strokeDashoffset={1 - value} opacity={0.65}/>
    <path d={path} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round"
      pathLength={1} strokeDasharray="1" strokeDashoffset={1 - value}/>
    {!dashed && <path d={path} fill="none" stroke="#fff9dd" strokeWidth={1.6} opacity={0.6}
      pathLength={1} strokeDasharray="1" strokeDashoffset={1 - value}/>}
    {value > 0.005 && <path d="M 13 0 L -12 -10 L -7 0 L -12 10 Z" fill={color}
      stroke="#172d27" strokeWidth={2} transform={`translate(${head.x} ${head.y}) rotate(${head.angle})`}/>}
  </g>;
}

function Army({point, label, color, time, moving, opacity = 1, size = 1, labelX = 4, labelY = 55}: {
  point: Point; label: string; color: string; time: number; moving: boolean; opacity?: number; size?: number; labelX?: number; labelY?: number;
}) {
  const wave = Math.sin(time * 7) * 3;
  return <g transform={`translate(${point.x} ${point.y}) scale(${size})`} opacity={opacity}>
    <ellipse cx={2} cy={19} rx={37} ry={16} fill="#102019" opacity={0.45}/>
    {Array.from({length: 12}, (_, index) => {
      const x = (index % 4 - 1.5) * 16;
      const y = (Math.floor(index / 4) - 1) * 12;
      const march = moving ? Math.sin(time * 10 + index * 0.6) * 1.8 : 0;
      return <g key={index} transform={`translate(${x} ${y + march})`}>
        <path d="M -5 -5 L 4 -7 L 7 1 L 0 6 L -6 3 Z" fill={color} stroke="#263a30" strokeWidth={1.8}/>
        <path d="M -4 -5 L 2 -6" stroke="#fff0c5" strokeWidth={1.5} opacity={0.9}/>
      </g>;
    })}
    <path d="M 1 10 V -70" stroke="#152720" strokeWidth={5}/>
    <path d="M 0 9 V -70" stroke="#f2dfac" strokeWidth={2.5}/>
    <path d={`M 1 -69 Q 21 ${-73 + wave} 46 -66 L 40 -41 Q 20 ${-49 + wave} 1 -43 Z`}
      fill={color} stroke="#ffe8b3" strokeWidth={1.5}/>
    <path d={`M 7 -64 Q 20 ${-68 + wave} 36 -63`} fill="none" stroke="#fff2ce" strokeWidth={1.4} opacity={0.65}/>
    <text x={labelX} y={labelY} textAnchor="middle" fontFamily={FONT} fontSize={25} fontWeight={650}
      fill={INK} stroke="#18382b" strokeWidth={7} paintOrder="stroke">{label}</text>
    {moving && Array.from({length: 4}, (_, index) => {
      const age = (time * 0.65 + index * 0.23) % 1;
      return <ellipse key={index} cx={-20 - age * 28} cy={16 + index * 3} rx={3 + age * 7} ry={1.5 + age * 3}
        fill="#d5d6a8" opacity={(1 - age) * 0.18}/>;
    })}
  </g>;
}

function MapLabel({point, text, dx = 0, dy = 0, color = INK, small = false}: {
  point: Point; text: string; dx?: number; dy?: number; color?: string; small?: boolean;
}) {
  return <g transform={`translate(${point.x + dx} ${point.y + dy})`}>
    <text textAnchor="middle" fontSize={small ? 24 : 30} fontFamily={FONT} fontWeight={600}
      fill={color} stroke="#19372b" strokeWidth={7} paintOrder="stroke">{text}</text>
  </g>;
}

const stages = [
  {start: 0, end: 6, title: '隔河对峙', subtitle: '两军隔河对峙，中央隘口扼住通道。'},
  {start: 6, end: 12.4, title: '正面牵制，北侧迂回', subtitle: '红军正面牵制，另一支部队沿北侧山路绕行。'},
  {start: 12.4, end: 18.3, title: '侧翼抵达，两路合击', subtitle: '侧翼抵达。两路同时压上，蓝军腹背受敌。'},
  {start: 18.3, end: 24, title: '威胁退路，迫敌撤离', subtitle: '退路受到威胁，蓝军撤离河谷。夹击完成。'},
];

export const HistoryMapDemo: React.FC<{scene: HistoryMapScene}> = ({scene}) => {
  const frame = useCurrentFrame(), {fps} = useVideoConfig();
  const time = frame / fps;
  const stageIndex = Math.max(0, stages.findIndex(stage => time >= stage.start && time < stage.end));
  const stage = stages[stageIndex];
  const enter = progress(time, stage.start, stage.start + 0.55);
  const exit = 1 - progress(time, stage.end - 0.28, stage.end);
  const main = progress(time, 2.4, 8.4);
  const flank = progress(time, 6, 13.8);
  const advance = progress(time, 1.4, 4.9);
  const retreat = progress(time, 18.7, 22.7);
  const mainHead = along(scene.routes.redMain, main);
  const flankHead = along(scene.routes.redFlank, flank);
  const blueHead = time < 18.7 ? along(scene.routes.blueAdvance, advance) : along(scene.routes.blueRetreat, retreat);
  const target = scene.routes.blueAdvance.at(-1)!;
  const mainAttack = [scene.routes.redMain.at(-1)!, {x: target.x - 40, y: target.y + 12}];
  const flankAttack = [scene.routes.redFlank.at(-1)!, {x: target.x + 28, y: target.y - 55}];
  const attack = progress(time, 14.1, 16.8);
  const redPosition = time > 14.1 ? along(mainAttack, attack * 0.68) : mainHead;
  const flankPosition = time > 14.1 ? along(flankAttack, attack * 0.64) : flankHead;
  const zoom = interpolate(time, [0, 4, 11, 16.5, 20.5, 24], [1.015, 1.04, 1.065, 1.10, 1.07, 1.025], {extrapolateRight: 'clamp'});
  const shiftX = interpolate(time, [0, 7, 15, 24], [0, 8, -28, 0]);
  const shiftY = interpolate(time, [0, 11, 16, 24], [8, 19, 26, 8]);
  const encirclement = progress(time, 15.1, 17.1) * (1 - progress(time, 19, 21.5));

  return <AbsoluteFill style={{backgroundColor: '#182f26', fontFamily: FONT, color: INK, overflow: 'hidden'}}>
    <AbsoluteFill style={{transform: `translate(${shiftX}px, ${shiftY}px) scale(${zoom})`, transformOrigin: '50% 50%'}}>
      <Img src={staticFile('history-map-demo/terrain.png')} style={{width: 1920, height: 1080}}/>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{position: 'absolute', inset: 0}}>
        <MapLabel point={scene.places.northRidge} text="北岭" dy={50} color="#dfe4ce"/>
        <MapLabel point={scene.places.river} text="河谷" dx={-48} dy={54} color="#b0d7d5" small/>
        <MapLabel point={scene.places.pass} text="中央隘口" dx={-145} dy={-105}/>
        <path d={`M ${scene.places.pass.x - 104} ${scene.places.pass.y - 93} L ${scene.places.pass.x - 35} ${scene.places.pass.y - 25}`}
          fill="none" stroke={INK} strokeWidth={1.5} opacity={0.65}/>
        <g opacity={0.6 + 0.2 * Math.sin(time * 2)}>
          <ellipse cx={scene.places.pass.x} cy={scene.places.pass.y} rx={42} ry={19} fill="none" stroke={GOLD} strokeWidth={2}/>
          <circle cx={scene.places.pass.x} cy={scene.places.pass.y} r={5} fill={GOLD}/>
        </g>
        {time > 1.4 && <Route points={scene.routes.blueAdvance} value={advance} color={BLUE} opacity={1 - retreat * 0.8}/>}
        {time > 2.4 && <Route points={scene.routes.redMain} value={main} color={RED}/>}
        {time >= 6 && <Route points={scene.routes.redFlank} value={flank} color={RED} opacity={progress(time, 6, 6.5)}/>}
        {time > 14.1 && <>
          <Route points={mainAttack} value={attack} color={GOLD} opacity={1 - retreat * 0.8}/>
          <Route points={flankAttack} value={attack} color={GOLD} opacity={1 - retreat * 0.8}/>
        </>}
        {time > 18.7 && <Route points={scene.routes.blueRetreat} value={retreat} color={BLUE} dashed/>}
        {encirclement > 0 && <g opacity={encirclement}>
          <ellipse cx={target.x} cy={target.y} rx={110} ry={78} fill="#f0b971" fillOpacity={0.09}
            stroke={GOLD} strokeWidth={2.5} strokeDasharray="9 8"/>
          {[0, 1].map(index => {
            const pulse = ((time - 15.1) * 0.58 + index * 0.5) % 1;
            return <ellipse key={index} cx={target.x} cy={target.y} rx={60 + pulse * 75} ry={40 + pulse * 50}
              fill="none" stroke={GOLD} strokeWidth={2} opacity={(1 - pulse) * 0.5}/>;
          })}
        </g>}
        <Army point={redPosition} label="红军主力" color={RED} time={time} labelX={-38} labelY={65}
          moving={(main > 0 && main < 1) || (attack > 0 && attack < 1)}/>
        {time > 5.8 && <Army point={flankPosition} label="红军侧翼" color={RED} time={time + 0.6}
          moving={flank < 1 || (attack > 0 && attack < 1)} opacity={progress(time, 5.8, 6.3)} size={0.88} labelY={-92}/>}
        <Army point={blueHead} label={retreat > 0 ? '蓝军撤退' : '蓝军'} color={BLUE} time={time + 1.2}
          moving={(advance > 0 && advance < 1) || (retreat > 0 && retreat < 1)} labelX={90} labelY={38}/>
        {time > 7.3 && time < 13 && <MapLabel point={along(scene.routes.redFlank, 0.6)} text="迂回山路"
          dy={-39} color="#f1ce7b" small/>}
      </svg>
    </AbsoluteFill>
    <div style={{position: 'absolute', inset: '0 0 auto', height: 154, background: 'rgba(12, 29, 23, 0.88)',
      borderBottom: '1px solid rgba(225,236,216,0.19)', padding: '25px 72px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 28}}>
        <div style={{width: 4, height: 65, backgroundColor: GOLD}}/>
        <div><div style={{fontSize: 20, color: '#bfcbb9', marginBottom: 7}}>战役地图 · 示意推演</div>
          <div style={{fontSize: 46, fontWeight: 650, lineHeight: 1.2}}>峡谷夹击</div></div>
      </div>
      <div style={{display: 'flex', alignItems: 'center', gap: 40, fontSize: 23}}>
        {[{text: '红军', color: RED}, {text: '蓝军', color: BLUE}].map(item => <div key={item.text} style={{display: 'flex', alignItems: 'center', gap: 12}}>
          <span style={{width: 12, height: 12, backgroundColor: item.color, transform: 'rotate(45deg)'}}/>{item.text}</div>)}
        <div style={{height: 34, width: 1, backgroundColor: '#6a7d68'}}/>
        <div style={{fontVariantNumeric: 'tabular-nums', color: GOLD, fontSize: 30}}>{String(stageIndex + 1).padStart(2, '0')}<span style={{fontSize: 20, color: '#bac5b1'}}> / 04</span></div>
      </div>
    </div>
    <div style={{position: 'absolute', left: 82, top: 202, color: '#e9ecdf', textAlign: 'center', opacity: 0.8}}>
      <svg width={30} height={55} viewBox="0 0 30 55"><path d="M15 0 L27 40 L15 31 L3 40 Z" fill="#e9ecdf"/><path d="M15 0 V31 L3 40 Z" fill="#567866"/></svg>
      <div style={{fontSize: 19, marginTop: 2}}>北</div>
    </div>
    <div style={{position: 'absolute', inset: 'auto 0 0', height: 212, background: 'rgba(12, 29, 23, 0.94)',
      borderTop: '1px solid rgba(225,236,216,0.17)', padding: '25px 78px 22px'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 25, opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 15}px)`}}>
        <div style={{color: GOLD, fontSize: 20, fontWeight: 600, minWidth: 90}}>第{['一', '二', '三', '四'][stageIndex]}阶段</div>
        <div style={{fontSize: 39, fontWeight: 650, lineHeight: 1.3}}>{stage.title}</div>
      </div>
      <div style={{marginTop: 18, fontSize: 29, color: '#d7e0cf', opacity: enter * exit}}>{stage.subtitle}</div>
      <div style={{position: 'absolute', left: 78, bottom: 19, fontSize: 17, color: '#9fac97'}}>虚构地形与战局，仅作动画示意</div>
      <div style={{position: 'absolute', right: 78, bottom: 21, display: 'flex', alignItems: 'center', gap: 12}}>
        {stages.map((item, index) => <div key={item.title} style={{position: 'relative', width: 116, height: 3, backgroundColor: '#40513f'}}>
          <div style={{width: `${clamp((time - item.start) / (item.end - item.start)) * 100}%`, height: '100%', backgroundColor: index === stageIndex ? GOLD : '#a0b091'}}/>
        </div>)}
      </div>
    </div>
  </AbsoluteFill>;
};
