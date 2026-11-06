import React from 'react';
import {Img, staticFile} from 'remotion';
import {layoutMapForces, type HistoryMapForce, type MapForceBox} from './history-map-forces';
import type {HistoryMotionMap} from './HistoryMapScene';

export function HistoryMapFlag({text, color, seconds, planted = false}: {text: string; color: string; seconds: number; planted?: boolean}) {
  const wave = Math.sin(seconds * 5.5) * 3;
  const fontSize = Math.min(25, 49 / Math.max(1, Array.from(text).length));
  return <g>
    <path d="M0 -38 V29" stroke="#faf5df" strokeWidth={7} strokeLinecap="round"/>
    <path d="M0 -38 V29" stroke="#443d2d" strokeWidth={3} strokeLinecap="round"/>
    <path d={`M2 -36 Q25 ${-40 + wave} 53 -33 L${48 + wave} -14 L54 3 Q26 ${-2 + wave} 2 2Z`} fill={color} stroke="#fff4db" strokeWidth={2}/>
    <text x={26} y={-10} textAnchor="middle" fontSize={fontSize} fontWeight={800} fill="#fff9e5" stroke={color} strokeWidth={.8} paintOrder="stroke">{text}</text>
    {planted ? <ellipse cy={31} rx={12} ry={3} fill={color} opacity={.3}/> : null}
  </g>;
}

function Soldier({color, phase, mounted}: {color: string; phase: number; mounted: boolean}) {
  const stride = Math.sin(phase) * 3.5;
  return <g transform={`translate(0 ${Math.abs(Math.sin(phase)) * -1.7})`}>
    {mounted ? <>
      <path d="M-11 12 Q-13 4 -6 4 H8 L12 -2 L18 0 L17 8 L10 13 H-8Z" fill={color} stroke="#fff3da" strokeWidth={1.3}/>
      <path d={`M-8 12 L${-10 + stride} 23 M8 12 L${9 - stride} 23`} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round"/>
    </> : <path d={`M-3 8 L${-5 + stride} 20 M3 8 L${5 - stride} 20`} fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round"/>}
    <path d="M-7 -4 L-5 10 H6 L7 -4Z" fill={color} stroke="#fff3da" strokeWidth={1.3}/>
    <circle cy={-10} r={5} fill="#e9cf9b" stroke="#3f4037" strokeWidth={1.2}/>
    <path d="M-6 -10 Q-6 -17 0 -17 Q6 -17 6 -10Z" fill={color} stroke="#fff3da" strokeWidth={1.2}/>
    <path d="M9 -4 L12 9 M12 -23 V12" stroke="#3f4037" strokeWidth={1.5} strokeLinecap="round"/>
    <path d="M12 -28 L9 -21 H15Z" fill="#68766a"/>
  </g>;
}

function ArmyFormation({force, seconds, moving, width}: {force: HistoryMapForce; seconds: number; moving: boolean; width: number}) {
  const clock = moving ? seconds * 9 : 0;
  return <g>
    <ellipse cx={width / 2} cy={94} rx={54} ry={9} fill="#37463d" opacity={.16}/>
    {Array.from({length: 9}, (_, index) => {
      const row = Math.floor(index / 3), column = index % 3;
      return <g key={index} transform={`translate(${width / 2 - 32 + column * 30 + row * 3} ${32 + row * 24})`}>
        <Soldier color={force.color} phase={clock + index * .8} mounted={force.troopKind === 'cavalry'}/>
      </g>;
    })}
    <g transform={`translate(${width / 2 + 29} 31) scale(.78)`}><HistoryMapFlag text={force.flagText} color={force.color} seconds={seconds}/></g>
  </g>;
}

const fitName = (text: string, width: number, preferred: number) => Math.min(preferred, (width - 8) / Math.max(1, Array.from(text).length));

export function HistoryMapForces({map, seconds, camera, width, height, labelObstacles}: {
  map: HistoryMotionMap; seconds: number; camera: {focusX: number; focusY: number; zoom: number}; width: number; height: number;
  labelObstacles?: MapForceBox[];
}) {
  const forces = layoutMapForces(map, seconds, camera, {width, height}, labelObstacles);
  return <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} style={{position: 'absolute', inset: 0, pointerEvents: 'none'}} aria-label="城市驻军与行军态势">
    {forces.map(({force, state, anchor, box}) => {
      const name = force.commander || force.faction;
      const nameY = force.portraitSrc ? 133 : 121;
      const targetX = Math.max(box.x + 12, Math.min(box.x + box.width - 12, anchor.x));
      const targetY = Math.max(box.y + 12, Math.min(box.y + box.height - 12, anchor.y));
      const bob = state.moving ? Math.sin(seconds * 8) * 1.4 : 0;
      return <g key={force.id} opacity={state.opacity} data-map-force={force.id} data-force-action={force.action}>
        <path d={`M${anchor.x} ${anchor.y} L${targetX} ${targetY}`} stroke="#fff6df" strokeWidth={5} opacity={.88}/>
        <path d={`M${anchor.x} ${anchor.y} L${targetX} ${targetY}`} stroke={force.color} strokeWidth={2} strokeDasharray={state.moving ? '5 5' : undefined}/>
        <circle cx={anchor.x} cy={anchor.y} r={state.moving ? 5 : 7} fill={force.color} stroke="#fff9e7" strokeWidth={2}/>
        <g transform={`translate(${box.x} ${box.y + bob})`}>
          {force.portraitSrc ? <>
            <ellipse cx={box.width / 2} cy={108} rx={46} ry={6} fill="#37463d" opacity={.17}/>
            <circle cx={box.width / 2} cy={56} r={50} fill="#faf3df" stroke={force.color} strokeWidth={4}/>
            <foreignObject x={box.width / 2 - 46} y={10} width={92} height={92}>
              <Img src={staticFile(force.portraitSrc)} style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 22%', borderRadius: '50%'}}/>
            </foreignObject>
            <g transform={`translate(${box.width / 2 + 38} 34) scale(.7)`}><HistoryMapFlag text={force.flagText} color={force.color} seconds={seconds}/></g>
          </> : <ArmyFormation force={force} seconds={seconds} moving={state.moving} width={box.width}/>}
          <text x={box.width / 2} y={nameY} textAnchor="middle" fontSize={fitName(name, box.width, 27)} fontWeight={800} fill={force.color} stroke="#fff6df" strokeWidth={7} paintOrder="stroke">{name}</text>
          {force.commander ? <text x={box.width / 2} y={nameY + 25} textAnchor="middle" fontSize={fitName(force.faction, box.width, 20)} fontWeight={600} fill="#303f36" stroke="#fff6df" strokeWidth={6} paintOrder="stroke">{force.faction}</text> : null}
        </g>
      </g>;
    })}
  </svg>;
}
