import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {changpingMap as data, projectChangping as project, type Geo} from './changping-data';

const QIN = '#b74436', ZHAO = '#367aab', HAN = '#c7a14f', INK = '#253a3a';
const FONT = '"PingFang SC", "Hiragino Sans GB", sans-serif';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => {const t = clamp(n); return t * t * (3 - 2 * t);};
const ramp = (time: number, start: number, end: number) => smooth((time - start) / (end - start));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const P = (points: Geo[], close = true) => points.map((p, i) => {const v = project(p); return `${i ? 'L' : 'M'} ${v.x} ${v.y}`;}).join(' ') + (close ? ' Z' : '');
const zone = (points: Geo[]) => {
  const pixels = points.map(project);
  const midpoints = pixels.map((p, i) => ({x: (p.x + pixels[(i + 1) % pixels.length].x) / 2,
    y: (p.y + pixels[(i + 1) % pixels.length].y) / 2}));
  const start = midpoints[midpoints.length - 1];
  return `M ${start.x} ${start.y} ` + pixels.map((p, i) => `Q ${p.x} ${p.y} ${midpoints[i].x} ${midpoints[i].y}`).join(' ') + ' Z';
};

function Arrow({points, amount, color, opacity = 1, dashed = false}: {
  points: Geo[]; amount: number; color: string; opacity?: number; dashed?: boolean;
}) {
  const pixels = points.map(project);
  const lengths = pixels.slice(1).map((p, i) => Math.hypot(p.x - pixels[i].x, p.y - pixels[i].y));
  let remaining = clamp(amount) * lengths.reduce((a, b) => a + b, 0);
  let head = pixels[0], angle = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? clamp(remaining / lengths[i]) : 0;
      head = {x: mix(pixels[i].x, pixels[i + 1].x, t), y: mix(pixels[i].y, pixels[i + 1].y, t)};
      angle = Math.atan2(pixels[i + 1].y - pixels[i].y, pixels[i + 1].x - pixels[i].x) * 180 / Math.PI;
      break;
    }
    remaining -= lengths[i];
  }
  return <g opacity={opacity}>
    <path d={P(points, false)} fill="none" stroke="#f9faf5" strokeWidth={11} strokeLinecap="round"
      pathLength={1} strokeDasharray="1" strokeDashoffset={1 - amount} opacity={0.8}/>
    <path d={P(points, false)} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round"
      pathLength={1} strokeDasharray="1" strokeDashoffset={1 - amount}/>
    {dashed && <path d={P(points, false)} fill="none" stroke="#f5f1d5" strokeWidth={2} strokeDasharray="4 7" opacity={0.65}/>}
    {amount > 0.01 && <path d="M 13 0 L -10 -9 L -6 0 L -10 9 Z" fill={color} stroke="#f7f8ef" strokeWidth={1.5}
      transform={`translate(${head.x} ${head.y}) rotate(${angle})`}/>}
  </g>;
}

function Label({at, text, zoom, dx = 0, dy = 0, size = 28, color = INK, sub}: {
  at: Geo; text: string; zoom: number; dx?: number; dy?: number; size?: number; color?: string; sub?: string;
}) {
  const point = project(at);
  return <g transform={`translate(${point.x} ${point.y}) scale(${1 / zoom}) translate(${dx} ${dy})`}>
    <text fontFamily={FONT} fontSize={size} fontWeight={650} textAnchor="middle" fill={color}
      stroke="#f5f7ee" strokeWidth={5} paintOrder="stroke">{text}</text>
    {sub && <text y={27} fontFamily={FONT} fontSize={17} textAnchor="middle" fill={color}
      stroke="#f5f7ee" strokeWidth={4} paintOrder="stroke">{sub}</text>}
  </g>;
}

function City({at, zoom, label, sub, dx = 19, dy = -15, accent = INK}: {
  at: Geo; zoom: number; label: string; sub?: string; dx?: number; dy?: number; accent?: string;
}) {
  const point = project(at);
  return <g>
    <circle cx={point.x} cy={point.y} r={6 / zoom} fill="#fffaf0" stroke={accent} strokeWidth={3 / zoom}/>
    <Label at={at} text={label} sub={sub} zoom={zoom} dx={dx} dy={dy} color={accent}/>
  </g>;
}

function Army({at, side, zoom, opacity = 1}: {at: Geo; side: 'qin' | 'zhao'; zoom: number; opacity?: number}) {
  const p = project(at), color = side === 'qin' ? QIN : ZHAO;
  return <g transform={`translate(${p.x} ${p.y}) scale(${1 / zoom})`} opacity={opacity}>
    <ellipse cx={0} cy={7} rx={33} ry={13} fill="#243c34" opacity={0.2}/>
    {Array.from({length: 8}, (_, i) => <rect key={i} x={(i % 4 - 2) * 13} y={Math.floor(i / 4) * 13 - 6}
      width={9} height={9} fill={color} stroke="#fff6df" strokeWidth={1.5}/>)}
    <path d="M 0 7 V -53" stroke="#f8f1d3" strokeWidth={4}/>
    <path d="M 1 -54 H 38 L 32 -30 H 1 Z" fill={color} stroke="#fff1d2" strokeWidth={1}/>
    <text x={18} y={-36} fontSize={17} textAnchor="middle" fill="white" fontFamily={FONT}>{side === 'qin' ? '秦' : '赵'}</text>
  </g>;
}

export const ChangpingControlDemo: React.FC = () => {
  const frame = useCurrentFrame(), {fps} = useVideoConfig(), time = frame / fps;
  const stageIndex = Math.min(4, Math.floor(time / 9)), stage = data.stages[stageIndex];
  const entry = ramp(time, stage.start, stage.start + 0.5);
  const transfer = ramp(time, 2, 6.6);
  const advance = ramp(time, 9.5, 15.3);
  const sortie = ramp(time, 19, 24.5);
  const surround = ramp(time, 27.7, 33.7);
  const collapse = ramp(time, 36.5, 39.1);
  const postwar = ramp(time, 39.3, 43);
  const zoom = interpolate(time, [0, 8, 14.5, 25, 34, 39, 44.9], [1, 1, 1.7, 1.85, 1.85, 1.28, 1], {extrapolateRight: 'clamp'});
  const focus = project(data.places.changping.point);
  const focusAmount = clamp((zoom - 1) / 0.85);
  const pivotX = mix(960, focus.x, focusAmount), pivotY = mix(506, focus.y, focusAmount);
  const camera = `translate(960 506) scale(${zoom}) translate(${-pivotX} ${-pivotY})`;
  const qinFront: Geo[] = [[110.6, 34.5], [114.0, 34.5], [113.3, mix(mix(35.0, 35.55, advance), 35.88, surround)],
    [113.06, mix(mix(35.03, 35.73, advance), 36.12, surround)], [112.86, mix(mix(35.09, 35.88, advance), 36.13, surround)],
    [112.60, mix(mix(35.2, 36.01, advance), 36.13, surround)], [112.26, mix(mix(35.37, 36.09, advance), 36.11, surround)], [110.6, 36.2]];
  const western = mix(112.91, 112.49, sortie);
  const salient: Geo[] = [[113.19, 36.01], [112.97, 36.01], [western + .05, 35.96],
    [western, 35.82], [western + .08, 35.68], [112.96, 35.72], [113.19, 35.87]];
  const pocket = project([112.69, 35.84]);
  const pocketOpacity = surround * (1 - collapse);
  const qinPosition: Geo = [mix(mix(112.15, 112.73, advance), 112.41, surround), mix(mix(35.45, 35.73, advance), 35.64, surround)];
  const zhaoPosition: Geo = [mix(113.06, 112.69, sortie), mix(35.94, 35.84, sortie)];
  const rearOpacity = 1 - surround;
  const wideLabels = 1 - smooth((zoom - 1.05) / .15);

  return <AbsoluteFill style={{backgroundColor: '#eef1e9', color: INK, fontFamily: FONT, overflow: 'hidden'}}>
    <svg width={1920} height={1080} viewBox="0 0 1920 1080">
      <defs>
        <clipPath id="theatre"><rect y={130} width={1920} height={752}/></clipPath>
        <clipPath id="shangdang"><path d={zone(data.shangdangZone)}/></clipPath>
        <clipPath id="transfer"><rect x={0} y={0} width={1920} height={130 + transfer * 790}/></clipPath>
        <pattern id="advance-hatch" width={14} height={14} patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <path d="M 0 0 V 14" stroke="#eff6fb" strokeWidth={4} opacity={0.45}/>
        </pattern>
      </defs>
      <g clipPath="url(#theatre)">
        <g transform={camera}>
          <image href={staticFile('changping-demo/relief.png')} x={0} y={130} width={1920} height={752} preserveAspectRatio="none"/>
          <path d={zone(data.qinApproach)} fill={QIN} fillOpacity={0.35} stroke={QIN} strokeWidth={2} strokeOpacity={0.4}/>
          <path d={zone(data.zhaoRear)} fill={ZHAO} fillOpacity={0.38} stroke={ZHAO} strokeWidth={2} strokeOpacity={0.4}/>
          <path d={zone(data.shangdangZone)} fill={HAN} fillOpacity={0.53}/>
          <g clipPath="url(#transfer)"><path d={zone(data.shangdangZone)} fill={ZHAO} fillOpacity={0.64}/></g>
          <g clipPath="url(#shangdang)">
            <path d={zone(qinFront)} fill={QIN} fillOpacity={0.8 * advance * (1 - postwar)}/>
            {sortie > 0 && <g opacity={(1 - surround) * (1 - collapse)}>
              <path d={zone(salient)} fill={ZHAO} fillOpacity={0.9}/><path d={zone(salient)} fill="url(#advance-hatch)"/>
              <path d={zone(salient)} fill="none" stroke={ZHAO} strokeWidth={2.5}/>
            </g>}
            <path d={zone(data.shangdangZone)} fill={QIN} fillOpacity={postwar * .86}/>
          </g>
          <path d={zone(data.shangdangZone)} fill="none" stroke="#f8f8ed" strokeWidth={3} strokeDasharray="8 5" opacity={0.85}/>
          <path d={P(data.rearLink, false)} fill="none" stroke="#fbfbf5" strokeWidth={7} opacity={rearOpacity * .85}/>
          <path d={P(data.rearLink, false)} fill="none" stroke={ZHAO} strokeWidth={3} strokeDasharray="7 5" opacity={rearOpacity}/>
          {pocketOpacity > 0 && <g opacity={pocketOpacity}>
            <ellipse cx={pocket.x} cy={pocket.y} rx={57 - surround * 12} ry={36 - surround * 8} fill={ZHAO} stroke="#eef9ff" strokeWidth={2}/>
            <ellipse cx={pocket.x} cy={pocket.y} rx={70} ry={46} fill="none" stroke={QIN} strokeWidth={3} strokeDasharray="5 4"/>
          </g>}
          {advance > 0 && time < 19 && <Arrow points={[[112.12, 35.36], [112.4, 35.51], [112.7, 35.72]]}
            amount={advance} color={QIN} opacity={1 - ramp(time, 17, 19)}/>}
          {sortie > 0 && time < 29 && <Arrow points={[[113.07, 35.97], [112.89, 35.9], [112.54, 35.83]]}
            amount={sortie} color={ZHAO} opacity={1 - ramp(time, 26.7, 29)}/>}
          {surround > 0 && time < 39 && <g opacity={1 - collapse}>
            <Arrow points={[[112.37, 35.65], [112.36, 36.09], [112.91, 36.09], [113.14, 35.98]]} amount={surround} color="#81312c"/>
            <Arrow points={[[112.47, 35.58], [113.11, 35.57], [113.33, 35.88]]} amount={surround} color="#81312c"/>
          </g>}
          <g opacity={wideLabels}>
            <Label at={[111.62, 35.59]} text="秦" zoom={zoom} size={90} color="#8e352b"/>
            <Label at={[114.24, 36.86]} text="赵" zoom={zoom} size={90} color="#285f89"/>
            <Label at={[112.13, 36.53]} text="太岳山" zoom={zoom} size={24} color="#66766a"/>
            <Label at={[111.53, 35.08]} text="中条山" zoom={zoom} size={23} color="#66766a"/>
            <Label at={[114.11, 35.37]} text="韩、魏方向" zoom={zoom} size={25} color="#859088"/>
            <City at={data.places.handan.point} zoom={zoom} label="邯郸" sub={time > 39 ? '赵国仍存' : '赵国都城'} dx={53} dy={-12} accent={ZHAO}/>
            <City at={data.places.yewang.point} zoom={zoom} label="野王" sub="今沁阳一带" dx={40} dy={-24} accent={QIN}/>
          </g>
          <Label at={[113.65, 36.01]} text="太行山" zoom={zoom} size={26} color="#66766a"/>
          <City at={data.places.shangdang.point} zoom={zoom} label="上党" sub={time < 9 ? transfer < .9 ? '韩上党 → 归赵' : '赵方接收' : time > 40 ? '战后转入秦控制' : '秦赵争夺'} dx={-58} dy={-29}/>
          <City at={data.places.changping.point} zoom={zoom} label="长平" sub="今高平一带" dx={86} dy={45}/>
          {time > 9 && time < 38.5 && <Army at={qinPosition} side="qin" zoom={zoom}/>}
          {time > 9 && time < 39 && <Army at={zhaoPosition} side="zhao" zoom={zoom} opacity={1 - collapse}/>}
          {time > 11 && time < 18 && <Label at={[113.22, 36.02]} text="廉颇固守" zoom={zoom} dx={85} dy={18} size={24} color={ZHAO}/>}
          {surround > .65 && collapse < 1 && <g opacity={1 - collapse}>
            <Label at={[112.69, 35.84]} text="赵军被围" zoom={zoom} dy={83} size={25} color={ZHAO}/>
            <Label at={[113.13, 36.09]} text="后路被截" zoom={zoom} dx={55} dy={-35} size={25} color={QIN}/>
            <g transform={`translate(${project([113.12, 36.0]).x} ${project([113.12, 36.0]).y}) scale(${1 / zoom})`}>
              <path d="M -11 -11 L 11 11 M -11 11 L 11 -11" stroke="#fff9e9" strokeWidth={10}/>
              <path d="M -11 -11 L 11 11 M -11 11 L 11 -11" stroke={QIN} strokeWidth={5}/>
            </g>
          </g>}
          {time > 40 && <Label at={[112.8, 35.58]} text="秦" zoom={zoom} size={68} color="#92382d"/>}
        </g>
      </g>
    </svg>
    <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: 130, backgroundColor: '#f5f6ef',
      borderBottom: '1px solid #d1d9ca', padding: '23px 64px', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 27}}>
        <div style={{width: 4, height: 70, backgroundColor: QIN}}/>
        <div style={{fontSize: 47, fontWeight: 650}}>长平之战</div>
        <div style={{borderLeft: '1px solid #c1caba', paddingLeft: 25, color: '#65746c', fontSize: 23, lineHeight: 1.7}}>秦赵势力消长<br/><span style={{fontSize: 17}}>上党战区 · 控制态势示意</span></div>
      </div>
      <div style={{textAlign: 'right'}}>
        <div style={{fontSize: 29, fontWeight: 600}}>{stage.date}</div>
        <div style={{marginTop: 10, display: 'flex', gap: 24, justifyContent: 'flex-end', fontSize: 18}}>
          {[{label: '秦', color: QIN}, {label: '赵', color: ZHAO}, {label: '韩', color: HAN}].map(item => <span key={item.label} style={{display: 'inline-flex', alignItems: 'center', gap: 9}}>
            <span style={{width: 23, height: 10, backgroundColor: item.color}}/>{item.label}</span>)}
        </div>
      </div>
    </div>
    <div style={{position: 'absolute', left: 61, top: 160, fontSize: 17, color: '#68766b'}}>地名按今地定位 · 范围与路线示意</div>
    <div style={{position: 'absolute', left: 61, top: 207, color: '#647668', fontSize: 18, textAlign: 'center'}}>
      <svg width={25} height={42} viewBox="0 0 25 42"><path d="M12.5 0 L24 35 L12.5 26 L1 35 Z" fill="#6a7e6a"/></svg><div>北</div>
    </div>
    <div style={{position: 'absolute', bottom: 0, left: 0, right: 0, height: 198, backgroundColor: '#f5f6ef', borderTop: '1px solid #ccd6c7', padding: '20px 64px'}}>
      <div style={{display: 'flex', gap: 26, alignItems: 'baseline', opacity: entry, transform: `translateY(${(1 - entry) * 10}px)`}}>
        <span style={{fontSize: 21, color: QIN, fontVariantNumeric: 'tabular-nums'}}>0{stageIndex + 1}</span>
        <div style={{fontSize: 37, fontWeight: 650}}>{stage.title}</div>
      </div>
      <div style={{fontSize: 26, marginTop: 10, color: '#56695e', opacity: entry}}>{stage.caption}</div>
      <div style={{display: 'flex', gap: 26, marginTop: 23}}>
        {data.stages.map((item, index) => <div key={item.short} style={{display: 'flex', alignItems: 'center', gap: 12, flex: 1}}>
          <span style={{fontSize: 17, whiteSpace: 'nowrap', color: index === stageIndex ? INK : '#859080'}}>{item.short}</span>
          <div style={{height: 3, width: '100%', backgroundColor: '#d5ddcd'}}><div style={{width: `${clamp((time - item.start) / 9) * 100}%`, height: '100%', backgroundColor: index === stageIndex ? QIN : '#91a58f'}}/></div>
        </div>)}
      </div>
    </div>
  </AbsoluteFill>;
};
