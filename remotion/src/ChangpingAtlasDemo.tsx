import React, {useEffect, useState} from 'react';
import {AbsoluteFill, cancelRender, continueRender, delayRender, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {createAtlasMap, projectAtlas as project} from './changping-atlas-data';
import {changpingMap, type Geo} from './changping-data';

const data = createAtlasMap(changpingMap);
const QIN = '#b63d35', ZHAO = '#2675a6', HAN = '#c69d39', INK = '#223d3c';
const FONT = '"PingFang SC", "Hiragino Sans GB", sans-serif';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => {const t = clamp(n); return t * t * (3 - 2 * t);};
const ramp = (time: number, start: number, end: number) => smooth((time - start) / (end - start));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const line = (points: readonly Geo[]) => points.map((p, i) => {const v = project(p); return `${i ? 'L' : 'M'}${v.x.toFixed(2)} ${v.y.toFixed(2)}`;}).join(' ');
const zone = (points: readonly Geo[]) => {
  const p = points.map(project);
  return `M ${p[0].x} ${p[0].y} ` + p.map((v, i) => {
    const previous = p[(i + p.length - 1) % p.length], next = p[(i + 1) % p.length], after = p[(i + 2) % p.length];
    return `C ${v.x + (next.x - previous.x) * .10} ${v.y + (next.y - previous.y) * .10} ${next.x - (after.x - v.x) * .10} ${next.y - (after.y - v.y) * .10} ${next.x} ${next.y}`;
  }).join(' ') + ' Z';
};

type Geography = {
  rivers: {name: string; nameZh?: string; coordinates: Geo[]}[];
  cities: {name: string; nameZh?: string; point: Geo}[];
};

function Label({at, text, zoom, dx = 0, dy = 0, size = 26, color = INK, sub}: {
  at: Geo; text: string; zoom: number; dx?: number; dy?: number; size?: number; color?: string; sub?: string;
}) {
  const point = project(at);
  return <g transform={`translate(${point.x} ${point.y}) scale(${1 / zoom}) translate(${dx} ${dy})`}>
    <text fontFamily={FONT} fontSize={size} fontWeight={600} textAnchor="middle" fill={color} stroke="#f4f6ef" strokeWidth={5} paintOrder="stroke">{text}</text>
    {sub && <text y={26} fontFamily={FONT} fontSize={16} textAnchor="middle" fill={color} stroke="#f4f6ef" strokeWidth={4} paintOrder="stroke">{sub}</text>}
  </g>;
}

function City({at, label, zoom, dx = 33, dy = -16, sub, color = INK, small = false}: {
  at: Geo; label: string; zoom: number; dx?: number; dy?: number; sub?: string; color?: string; small?: boolean;
}) {
  const p = project(at);
  return <g>
    <circle cx={p.x} cy={p.y} r={(small ? 3 : 5) / zoom} fill="#fbfcf6" stroke={color} strokeWidth={(small ? 1.5 : 2.5) / zoom}/>
    <Label at={at} text={label} sub={sub} zoom={zoom} dx={dx} dy={dy} size={small ? 19 : 28} color={color}/>
  </g>;
}

function Arrow({points, amount, zoom, color, opacity = 1}: {points: Geo[]; amount: number; zoom: number; color: string; opacity?: number}) {
  const pixels = points.map(project), lengths = pixels.slice(1).map((p, i) => Math.hypot(p.x - pixels[i].x, p.y - pixels[i].y));
  let remaining = clamp(amount) * lengths.reduce((a, b) => a + b, 0), head = pixels[0], angle = 0;
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
    <path d={line(points)} fill="none" stroke="#f9fbf5" strokeWidth={12 / zoom} strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - amount}/>
    <path d={line(points)} fill="none" stroke={color} strokeWidth={7 / zoom} strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - amount}/>
    {amount > .01 && <path d="M 14 0 L -10 -9 L -6 0 L -10 9 Z" fill={color} stroke="#f9fbf5" strokeWidth={2}
      transform={`translate(${head.x} ${head.y}) rotate(${angle}) scale(${1 / zoom})`}/>}
  </g>;
}

function Army({at, side, zoom, opacity = 1}: {at: Geo; side: 'qin' | 'zhao'; zoom: number; opacity?: number}) {
  const p = project(at), color = side === 'qin' ? QIN : ZHAO;
  return <g transform={`translate(${p.x} ${p.y}) scale(${1 / zoom})`} opacity={opacity}>
    {Array.from({length: 8}, (_, i) => <rect key={i} x={(i % 4 - 2) * 12} y={Math.floor(i / 4) * 12 - 5} width={8} height={8} fill={color} stroke="#fcf9eb" strokeWidth={1.5}/>)}
    <path d="M 0 5 V -51" stroke="#fcf9eb" strokeWidth={4}/>
    <path d="M 1 -52 H 36 L 31 -28 H 1 Z" fill={color} stroke="#fcf9eb"/>
    <text x={17} y={-35} fontSize={17} textAnchor="middle" fill="white" fontFamily={FONT}>{side === 'qin' ? '秦' : '赵'}</text>
  </g>;
}

export const ChangpingAtlasDemo: React.FC = () => {
  const frame = useCurrentFrame(), {fps} = useVideoConfig(), time = frame / fps;
  const [geography, setGeography] = useState<Geography | null>(null);
  const [handle] = useState(() => delayRender('Load locally cached geographic vectors'));
  useEffect(() => {
    let active = true;
    fetch(staticFile('changping-demo-v2/geographic-data.json')).then(response => {
      if (!response.ok) throw Error(`Geographic data HTTP ${response.status}`);
      return response.json();
    }).then(value => {if (active) {setGeography(value); continueRender(handle);}}).catch(cancelRender);
    return () => {active = false;};
  }, [handle]);
  const stageIndex = Math.min(4, Math.floor(time / 9)), stage = data.stages[stageIndex];
  const transfer = ramp(time, 2, 6.6), advance = ramp(time, 9.5, 15.3), sortie = ramp(time, 19, 24.5);
  const surround = ramp(time, 27.7, 33.7), collapse = ramp(time, 36.5, 39.1), postwar = ramp(time, 39.3, 43);
  const zoom = interpolate(time, [0, 8, 15, 25, 35, 40, 44.9], [1, 1, 2.8, 3.05, 3.05, 1.7, 1], {extrapolateRight: 'clamp'});
  const focus = project([112.87, 36.03]), focusAmount = clamp((zoom - 1) / 1.8);
  const camera = `translate(690 506) scale(${zoom}) translate(${-mix(690, focus.x, focusAmount)} ${-mix(506, focus.y, focusAmount)})`;
  const wide = 1 - smooth((zoom - 1.05) / .4);
  const qinFront: Geo[] = [[111.4, 34.8], [113.8, 34.8], [113.3, mix(mix(35, 35.55, advance), 35.88, surround)],
    [113.06, mix(mix(35.03, 35.73, advance), 36.12, surround)], [112.86, mix(mix(35.09, 35.88, advance), 36.13, surround)],
    [112.6, mix(mix(35.2, 36.01, advance), 36.13, surround)], [112.26, mix(mix(35.37, 36.09, advance), 36.11, surround)], [111.4, 36.2]];
  const western = mix(112.91, 112.49, sortie);
  const salient: Geo[] = [[113.19, 36.01], [112.97, 36.01], [western + .05, 35.96], [western, 35.82], [western + .08, 35.68], [112.96, 35.72], [113.19, 35.87]];
  const qin: Geo = [mix(mix(112.15, 112.73, advance), 112.41, surround), mix(mix(35.45, 35.73, advance), 35.64, surround)];
  const zhao: Geo = [mix(113.06, 112.69, sortie), mix(35.94, 35.84, sortie)];
  const pocket = project([112.69, 35.84]);
  const modernNames: Record<string, string> = {Xian: '西安', Xianyang: '咸阳', Weinan: '渭南', Luoyang: '洛阳', Linfen: '临汾', Jincheng: '晋城', Changzhi: '长治', Anyang: '安阳', Xiangtai: '邢台', Kaifeng: '开封', Xinxiang: '新乡', Jiaozuo: '焦作', Zhengzhou: '郑州', Pingdingshan: '平顶山', Hancheng: '韩城', Puyang: '濮阳'};
  const contextCities = (geography?.cities ?? []).filter(city => modernNames[city.name] && project(city.point).y < 842);

  return <AbsoluteFill style={{backgroundColor: '#f3f5ef', color: INK, fontFamily: FONT}}>
    <svg width={1920} height={1080} viewBox="0 0 1920 1080">
      <defs>
        <clipPath id="atlas-theatre"><rect y={130} width={1380} height={752}/></clipPath>
        <clipPath id="atlas-shangdang"><path d={zone(data.shangdangZone)}/></clipPath>
        <clipPath id="atlas-transfer"><rect width={1380} height={130 + transfer * 790}/></clipPath>
        <mask id="atlas-zhao"><rect width={1380} height={1080} fill="white"/><path d={zone(qinFront)} fill="black" opacity={advance}/><path d={zone(data.shangdangZone)} fill="black" opacity={postwar}/></mask>
        <pattern id="atlas-hatch" width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M0 0 V5" stroke="#e6f3fb" strokeWidth={1.3} opacity={.7}/></pattern>
      </defs>
      <g clipPath="url(#atlas-theatre)">
        <g transform={camera}>
          <image href={staticFile('changping-demo-v2/terrain.png')} x={0} y={130} width={1380} height={752} preserveAspectRatio="none"/>
          <path d={zone([[107, 33], [111.0, 33], [111.3, 34.65], [110.8, 35.25], [110.6, 36.1], [110.3, 37.1], [107, 37.5]])} fill={QIN} fillOpacity={.12}/>
          <path d={zone([[111.9, 38], [116.8, 38], [116.8, 35.9], [114.5, 36.04], [114, 36.12], [113.6, 36.45], [113.13, 36.47], [112, 36.9]])} fill={ZHAO} fillOpacity={.14}/>
          <path d={zone(data.shangdangZone)} fill={HAN} fillOpacity={.22 * (1 - transfer)}/>
          <g clipPath="url(#atlas-transfer)" mask="url(#atlas-zhao)"><path d={zone(data.shangdangZone)} fill={ZHAO} fillOpacity={.37}/></g>
          <g clipPath="url(#atlas-shangdang)">
            <path d={zone(qinFront)} fill={QIN} fillOpacity={.4 * advance * (1 - postwar)}/>
            <path d={zone(data.shangdangZone)} fill={QIN} fillOpacity={.42 * postwar}/>
            <g opacity={sortie * (1 - surround) * (1 - collapse)}>
              <path d={zone(salient)} fill={ZHAO} fillOpacity={.65}/><path d={zone(salient)} fill="url(#atlas-hatch)"/>
              <path d={zone(salient)} fill="none" stroke={ZHAO} strokeWidth={1.3 / zoom}/>
            </g>
          </g>
          <path d={zone(data.shangdangZone)} fill="none" stroke="#f7f9ef" strokeWidth={3 / zoom}/>
          <path d={zone(data.shangdangZone)} fill="none" stroke="#667d73" strokeWidth={1.2 / zoom} strokeDasharray={`${7 / zoom} ${5 / zoom}`}/>
          {(geography?.rivers ?? []).map((river, i) => <g key={i}>
            <path d={line(river.coordinates)} fill="none" stroke="#edf4e9" strokeWidth={(river.name === 'Huang He' || river.name === 'Huang' ? 5.5 : 3.2) / zoom} strokeLinejoin="round"/>
            <path d={line(river.coordinates)} fill="none" stroke="#55989f" strokeWidth={(river.name === 'Huang He' || river.name === 'Huang' ? 3.3 : 1.6) / zoom} strokeLinejoin="round"/>
          </g>)}
          <path d={line(data.rearLink)} fill="none" stroke="#f7faf1" strokeWidth={6 / zoom} opacity={1 - surround}/>
          <path d={line(data.rearLink)} fill="none" stroke={ZHAO} strokeWidth={2.5 / zoom} strokeDasharray={`${7 / zoom} ${5 / zoom}`} opacity={1 - surround}/>
          <g opacity={wide}>
            <Label at={[109.30, 35.4]} text="秦国" zoom={zoom} size={57} color="#873e37"/>
            <Label at={[115.0, 37.22]} text="赵国" zoom={zoom} size={57} color="#2e6284"/>
            {contextCities.map(city => <City key={city.name} at={city.point} label={`今${city.nameZh ?? modernNames[city.name]}`} zoom={zoom} small color="#677873" dx={city.name === 'Jincheng' ? -42 : city.name === 'Xianyang' ? -27 : 35} dy={city.name === 'Changzhi' ? -10 : city.name === 'Xianyang' ? -18 : 22}/>)}
            <City at={data.places.handan.point} label="邯郸" sub="赵都" zoom={zoom} color={ZHAO} dx={47}/>
            <City at={data.places.yewang.point} label="野王" sub="今沁阳" zoom={zoom} color={QIN} dx={0} dy={-31}/>
            <Label at={[110.55, 35.95]} text="黄河" zoom={zoom} dx={-40} size={22} color="#477d89"/>
            <Label at={[111.32, 36.6]} text="汾河" zoom={zoom} size={21} color="#477d89"/>
            <Label at={[112.20, 35.15]} text="沁河" zoom={zoom} size={21} color="#477d89"/>
          </g>
          <Label at={[113.66, 36.08]} text="太行山脉" zoom={zoom} size={23} color="#5a6b57"/>
          <Label at={[112.02, 36.49]} text="太岳山" zoom={zoom} size={22} color="#5a6b57"/>
          <g opacity={wide}><Label at={[110.92, 34.94]} text="中条山" zoom={zoom} size={22} color="#5a6b57"/></g>
          <City at={data.places.shangdang.point} label="上党" sub={time < 9 ? '韩上党 → 归赵' : time > 40 ? '战后秦控制' : '秦赵争夺区'} zoom={zoom} dx={-64} dy={-24}/>
          <City at={data.places.changping.point} label="长平" sub="今高平" zoom={zoom} dx={67} dy={36}/>
          {surround > 0 && <g opacity={surround * (1 - collapse)}>
            <ellipse cx={pocket.x} cy={pocket.y} rx={45 / zoom} ry={31 / zoom} fill={ZHAO} fillOpacity={.8} stroke="#f7faf1" strokeWidth={2 / zoom}/>
            <ellipse cx={pocket.x} cy={pocket.y} rx={63 / zoom} ry={46 / zoom} fill="none" stroke={QIN} strokeWidth={2 / zoom} strokeDasharray={`${5 / zoom} ${4 / zoom}`}/>
          </g>}
          {time > 9 && time < 19 && <Arrow points={[[112.12, 35.36], [112.4, 35.51], [112.7, 35.72]]} amount={advance} color={QIN} zoom={zoom} opacity={1 - ramp(time, 17, 19)}/>}
          {time > 19 && time < 29 && <Arrow points={[[113.07, 35.97], [112.89, 35.9], [112.54, 35.83]]} amount={sortie} color={ZHAO} zoom={zoom} opacity={1 - ramp(time, 26.7, 29)}/>}
          {time > 27 && time < 39 && <g opacity={1 - collapse}>
            <Arrow points={[[112.37, 35.65], [112.36, 36.09], [112.91, 36.09], [113.14, 35.98]]} amount={surround} color={QIN} zoom={zoom}/>
            <Arrow points={[[112.47, 35.58], [113.11, 35.57], [113.33, 35.88]]} amount={surround} color={QIN} zoom={zoom}/>
          </g>}
          {time > 9 && time < 38 && <Army at={qin} side="qin" zoom={zoom}/>}
          {time > 9 && time < 39 && <Army at={zhao} side="zhao" zoom={zoom} opacity={1 - collapse}/>}
          {time > 11 && time < 18 && <Label at={[113.15, 36.13]} text="廉颇固守" zoom={zoom} dx={76} dy={-12} size={22} color={ZHAO}/>}
          {surround > .65 && collapse < 1 && <g opacity={1 - collapse}>
            <Label at={[112.69, 35.84]} text="赵军被围" zoom={zoom} dy={80} size={24} color={ZHAO}/>
            <Label at={[113.14, 36.09]} text="后路被截" zoom={zoom} dx={42} dy={-36} size={23} color={QIN}/>
            <Label at={[113.12, 36.0]} text="×" zoom={zoom} size={38} color={QIN}/>
          </g>}
        </g>
      </g>
    </svg>
    <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: 130, backgroundColor: '#f6f8f2', borderBottom: '1px solid #cdd7ca', padding: '23px 52px', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 26}}><div style={{width: 4, height: 65, backgroundColor: QIN}}/><div style={{fontSize: 46, fontWeight: 650}}>长平之战</div><div style={{borderLeft: '1px solid #c7d2c4', paddingLeft: 24, fontSize: 24, lineHeight: 1.6}}>秦赵势力消长<br/><span style={{fontSize: 17, color: '#6e7e71'}}>前262年—前260年 · 上党战区</span></div></div>
      <div style={{textAlign: 'right'}}><div style={{fontSize: 28, fontWeight: 600}}>{stage.date}</div><div style={{display: 'flex', gap: 24, marginTop: 11, justifyContent: 'flex-end'}}>{[{label: '秦', color: QIN}, {label: '赵', color: ZHAO}, {label: '韩', color: HAN}].map(item => <span key={item.label} style={{display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 19}}><span style={{width: 24, height: 9, backgroundColor: item.color}}/>{item.label}</span>)}</div></div>
    </div>
    <div style={{position: 'absolute', left: 28, top: 151, color: '#526b60', fontSize: 16}}>灰字：今地参照 · 战区范围与路线示意</div>
    <div style={{position: 'absolute', left: 27, top: 190, textAlign: 'center', color: '#47645b', fontSize: 17}}><svg width={24} height={38} viewBox="0 0 24 38"><path d="M12 0 L23 32 L12 24 L1 32 Z" fill="#587165"/></svg><div>北</div></div>
    <div style={{position: 'absolute', left: 1380, top: 130, width: 540, height: 752, backgroundColor: '#f4f7f0', borderLeft: '1px solid #c8d3c5', padding: '24px 32px'}}>
      <div style={{fontSize: 25, fontWeight: 600}}>战国七雄</div><div style={{fontSize: 17, color: '#6a7b6e', marginTop: 5}}>约前260年 · 历史形势总览</div>
      <Img src={staticFile('changping-demo-v2/warring-states-260bce.jpg')} style={{display: 'block', width: 476, height: 438, objectFit: 'contain', marginTop: 17}}/>
      <div style={{fontSize: 14, color: '#6b7b70', marginTop: 9}}>Philg88 · Wikimedia Commons · CC BY-SA 3.0</div>
      <div style={{height: 1, backgroundColor: '#cdd8c8', marginTop: 21, marginBottom: 18}}/>
      <div style={{display: 'flex', gap: 19, flexWrap: 'wrap', fontSize: 18, color: '#4e685e'}}><span>咸阳 · 秦都</span><span>邯郸 · 赵都</span><span>长平 · 今高平</span></div>
      <div style={{marginTop: 16, fontSize: 12, color: '#748174', lineHeight: 1.7}}>Terrain: Mapzen / USGS SRTM, GMTED2010<br/>Rivers & city coordinates: Natural Earth · Public Domain</div>
    </div>
    <div style={{position: 'absolute', bottom: 0, left: 0, right: 0, height: 198, backgroundColor: '#f6f8f2', borderTop: '1px solid #cbd5c6', padding: '20px 52px'}}>
      <div style={{display: 'flex', gap: 24, alignItems: 'baseline'}}><span style={{fontSize: 20, color: QIN}}>0{stageIndex + 1}</span><div style={{fontSize: 36, fontWeight: 650}}>{stage.title}</div></div>
      <div style={{fontSize: 25, marginTop: 11, color: '#566e60'}}>{stage.caption}</div>
      <div style={{display: 'flex', gap: 24, marginTop: 23}}>{data.stages.map((item, index) => <div key={item.short} style={{display: 'flex', alignItems: 'center', gap: 12, flex: 1}}><span style={{fontSize: 17, whiteSpace: 'nowrap', color: index === stageIndex ? INK : '#869580'}}>{item.short}</span><div style={{height: 3, width: '100%', backgroundColor: '#d8e0d0'}}><div style={{width: `${clamp((time - item.start) / 9) * 100}%`, height: '100%', backgroundColor: index === stageIndex ? QIN : '#93a78a'}}/></div></div>)}</div>
    </div>
  </AbsoluteFill>;
};
