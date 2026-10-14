import React, {useEffect, useMemo, useState} from 'react';
import {AbsoluteFill, Img, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame} from 'remotion';
import {fineCameraAt} from './fine-edit-core';
import {referenceEffectState, referenceEmotionMotion, referenceAccentMotion, referenceSweatMotion, referenceTitleMotion, referencePageState, referenceTextFit, referenceMapRouteState, validateReferenceEditorialProps, type ReferenceEditorialProps, type ReferenceEffect} from './reference-editorial-core';

const INK = '#211811';
const BRUSH = 'ReferenceMaShan';
const FONT_URL = 'fonts/MaShanZheng-Regular.ttf';
const WENKAI = 'ReferenceWenKai';

function useBrushFont() {
  const [handle] = useState(() => delayRender('Load editorial brush font'));
  useEffect(() => {
    let canceled = false;
    const fonts = [new FontFace(BRUSH, `url("${staticFile(FONT_URL)}")`), new FontFace(WENKAI, `url("${staticFile('fonts/LXGWWenKaiScreen.ttf')}")`)];
    Promise.all(fonts.map(font => font.load())).then(loaded => {
      loaded.forEach(font => document.fonts.add(font));
      return document.fonts.ready;
    }).then(() => {if (!canceled) continueRender(handle);}).catch(error => cancelRender(error));
    return () => {canceled = true; continueRender(handle);};
  }, [handle]);
}

const Title: React.FC<{e: ReferenceEffect; w: number; h: number; uid: string; state: ReturnType<typeof referenceEffectState>}> = ({e, w, h, uid, state}) => {
  const scroll = e.kind === 'title-scroll';
  const font = e.font === 'wenkai' ? WENKAI : BRUSH;
  const text = referenceTextFit(e.text ?? '', w * (scroll ? .79 : .94), h * (scroll ? .61 : .92), e.fontSize ?? h * (scroll ? .69 : .95));
  const rod = Math.min(w * .034, h * .15);
  const open = referenceTitleMotion(state.local,state.fps,state.duration,0,1,true).open;
  const count = text.lines.reduce((n,line)=>n+[...line].length,0);
  const stamp=e.motion==='stamp' && !scroll;
  const stampProgress=state.part(0,Math.max(1,Math.min(state.fps*.36,state.duration*.35)));
  let glyphIndex = 0;
  const plainTitle=(e.text ?? '').replace(/\n/g,'');
  const emphasis=e.emphasisText?.replace(/\n/g,'');
  const emphasisStart=emphasis ? [...plainTitle.slice(0,plainTitle.indexOf(emphasis))].length : -1;
  return <>
    <defs>
      <linearGradient id={`${uid}-paper`} x2="0" y2="1"><stop stopColor="#e4bf80"/><stop offset=".16" stopColor="#ffedc5"/><stop offset=".55" stopColor="#f6e1b4"/><stop offset="1" stopColor="#e6c68e"/></linearGradient>
      <linearGradient id={`${uid}-wood`}><stop stopColor="#735039"/><stop offset=".28" stopColor="#e5b673"/><stop offset=".55" stopColor="#f5d198"/><stop offset="1" stopColor="#81543a"/></linearGradient>
      <clipPath id={`${uid}-unroll`}><rect x={w*.5*(1-open)} y={0} width={w*open} height={h}/></clipPath>
    </defs>
    {scroll ? <g>
      <g clipPath={`url(#${uid}-unroll)`}>
      <path d={`M ${rod} ${h*.12} Q ${w*.5} ${h*.06} ${w-rod} ${h*.12} L ${w-rod} ${h*.88} Q ${w*.5} ${h*.93} ${rod} ${h*.88} Z`} fill={`url(#${uid}-paper)`} stroke="#604532" strokeWidth={h*.024}/>
      <path d={`M ${rod*2} ${h*.2} H ${w-rod*2} M ${rod*2} ${h*.8} H ${w-rod*2}`} fill="none" stroke="#b19060" strokeWidth={h*.009}/>
      {[.28,.44,.67].map((y,i) => <path key={y} d={`M ${w*(.13+i*.05)} ${h*y} Q ${w*.5} ${h*(y+.017)} ${w*(.9-i*.07)} ${h*y}`} stroke="#ad8754" strokeWidth={.8} opacity={.14} fill="none"/>)}
      </g>
      {[rod*.45, w-rod*1.45].map((x,i) => <g key={i} transform={`translate(${(w*.5-rod*.5-x)*(1-open)} 0)`}><rect x={x} y={h*.055} width={rod} height={h*.89} rx={rod*.34} fill={`url(#${uid}-wood)`} stroke="#634733" strokeWidth={h*.019}/><rect x={x-rod*.18} y={h*.015} width={rod*1.36} height={h*.08} rx={rod*.2} fill="#8c6343" stroke="#513927" strokeWidth={h*.012}/><rect x={x-rod*.18} y={h*.905} width={rod*1.36} height={h*.08} rx={rod*.2} fill="#8c6343" stroke="#513927" strokeWidth={h*.012}/></g>)}
    </g> : null}
    <g clipPath={scroll ? `url(#${uid}-unroll)` : undefined} transform={stamp ? `translate(${w/2} ${h/2}) rotate(${-5*(1-stampProgress)}) scale(${1+.17*(1-stampProgress)}) translate(${-w/2} ${-h/2})` : undefined}>
    {text.lines.flatMap((line,lineIndex)=>{
      const units=[...line].map(c=>/[\x00-\x7f]/.test(c) ? .58 : 1);
      let x=(w-units.reduce((a,b)=>a+b,0)*text.size)/2;
      return [...line].map((char,i)=>{
        const index=glyphIndex++, m=stamp ? {reveal:1,y:0,scale:1} : referenceTitleMotion(state.local,state.fps,state.duration,index,count,scroll);
        const cx=x+units[i]*text.size/2, y=h/2+(lineIndex-(text.lines.length-1)/2)*text.size*1.18+text.size*.35;
        const fill=emphasis && index>=emphasisStart && index<emphasisStart+[...emphasis].length ? (e.emphasisColor ?? '#963e2d') : (e.color ?? '#140d08');
        x+=units[i]*text.size;
        const clip=`${uid}-glyph-${index}`;
        return <g key={index} transform={`translate(${cx} ${y+text.size*m.y}) scale(${m.scale})`}>
          <defs><clipPath id={clip}><path d={`M ${-text.size*.68} ${-text.size*1.07} H ${text.size*(-.68+1.4*m.reveal)} l ${-text.size*.04} ${text.size*.28} l ${text.size*.02} ${text.size*.24} l ${-text.size*.04} ${text.size*.4} l ${text.size*.02} ${text.size*.5} H ${-text.size*.68} Z`}/></clipPath></defs>
          <g clipPath={`url(#${clip})`}>
            {!scroll ? <text textAnchor="middle" fill="none" stroke="#fff8e8" strokeWidth={Math.max(6,Math.min(9,text.size*.0375))+text.size*.025} strokeLinejoin="round" fontFamily={font} fontSize={text.size}>{char}</text> : null}
            <text textAnchor="middle" fill={fill} stroke={fill} strokeWidth={text.size*.025} strokeLinejoin="round" paintOrder="stroke" fontFamily={font} fontSize={text.size}>{char}</text>
          </g>
        </g>;
      });
    })}
    </g>
  </>;
};

const BookPage: React.FC<{props: ReferenceEditorialProps; frame: number}> = ({props,frame}) => {
  const page = props.page;
  if (!page) return null;
  const state = referencePageState(page,frame,props.fps);
  if (!state.active) return null;
  const {width:w,height:h}=props;
  // Cap the visible title band at 19% of the canvas. The generic fitter reserves
  // 1.18 em leading; compensate here because a single book heading has no leading.
  const title=referenceTextFit(page.title,w*.85,h*.19*1.18,page.fontSize ?? ([...page.title.replace(/\s/g,'')].length<=4 ? 210 : 190));
  const caption=props.captions?.find(c=>frame>=c.startFrame && frame<c.endFrame);
  const lines=caption?.text.replace(/\\N/g,'\n').split('\n') ?? [];
  return <>
  <AbsoluteFill style={{opacity:state.blackOpacity,backgroundColor:'#000'}}/>
  <AbsoluteFill style={{opacity:state.opacity,backgroundColor:'#bd9463'}}>
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{position:'absolute',inset:0}}>
      <defs>
        <linearGradient id="ref-book-left"><stop stopColor="#d9b982"/><stop offset=".07" stopColor="#f7e9c9"/><stop offset=".9" stopColor="#f3e3bd"/><stop offset="1" stopColor="#d4b17a"/></linearGradient>
        <linearGradient id="ref-book-right"><stop stopColor="#d4b17a"/><stop offset=".1" stopColor="#f6e7c4"/><stop offset=".9" stopColor="#f7e9c9"/><stop offset="1" stopColor="#d4b17a"/></linearGradient>
      </defs>
      <path d={`M ${w*.025} ${h*.04} Q ${w*.29} ${-h*.025} ${w*.5} ${h*.035} Q ${w*.74} ${-h*.025} ${w*.975} ${h*.04} L ${w*.985} ${h*.97} Q ${w*.74} ${h*.945} ${w*.5} ${h*.975} Q ${w*.25} ${h*.945} ${w*.015} ${h*.97} Z`} fill="#c29b66" stroke="#604730" strokeWidth={5}/>
      <path d={`M ${w*.04} ${h*.045} Q ${w*.27} ${h*.003} ${w*.5} ${h*.04} L ${w*.5} ${h*.96} Q ${w*.26} ${h*.925} ${w*.033} ${h*.95} Z`} fill="url(#ref-book-left)" stroke="#9b794c" strokeWidth={3}/>
      <path d={`M ${w*.5} ${h*.04} Q ${w*.73} ${h*.003} ${w*.96} ${h*.045} L ${w*.967} ${h*.95} Q ${w*.74} ${h*.925} ${w*.5} ${h*.96} Z`} fill="url(#ref-book-right)" stroke="#9b794c" strokeWidth={3}/>
      <path d={`M ${w*.053} ${h*.057} Q ${w*.27} ${h*.021} ${w*.486} ${h*.054} M ${w*.514} ${h*.054} Q ${w*.73} ${h*.021} ${w*.947} ${h*.057} M ${w*.053} ${h*.057} L ${w*.049} ${h*.932} M ${w*.947} ${h*.057} L ${w*.951} ${h*.932}`} fill="none" stroke="#b89a68" strokeWidth={2}/>
      <path d={`M ${w*.5} ${h*.04} Q ${w*.497} ${h*.5} ${w*.5} ${h*.96}`} fill="none" stroke="#967147" strokeWidth={3} opacity={.7}/>
      <text x={w*.5} textAnchor="middle" fill="#140d08" stroke="#140d08" strokeWidth={title.size*.025} strokeLinejoin="round" fontFamily={BRUSH} fontSize={title.size}>
        {title.lines.map((line,i)=><tspan key={i} x={w*.5} y={h*.12+(i-(title.lines.length-1)/2)*title.size*1.18+title.size*.35}>{line}</tspan>)}
      </text>
    </svg>
    <div style={{position:'absolute',left:w*.045,top:h*.21,width:w*.91,height:h*.73,overflow:'hidden',clipPath:'polygon(0% 1%, 50% 0%, 100% 1%, 100% 98%, 50% 100%, 0% 98%)',maskImage:'linear-gradient(to bottom, transparent 0%, black 4%, black 95%, transparent 100%)',WebkitMaskImage:'linear-gradient(to bottom, transparent 0%, black 4%, black 95%, transparent 100%)'}}>
      <Img src={/^(https?:|data:|\/)/.test(page.imageSrc) ? page.imageSrc : staticFile(page.imageSrc)} style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top'}}/>
    </div>
    {lines.length ? <svg width={w} height={h} style={{position:'absolute',inset:0}}>
      <text textAnchor="middle" fontFamily="PingFang SC, sans-serif" fontSize={48} fill="white" stroke="#171717" strokeWidth={5} strokeLinejoin="round" paintOrder="stroke">
        {lines.map((line,i)=><tspan key={i} x={w*.5} y={h-40-(lines.length-1-i)*57.6}>{line}</tspan>)}
      </text>
    </svg> : null}
  </AbsoluteFill>
  </>;
};

const Reaction: React.FC<{e: ReferenceEffect; w: number; h: number; state: ReturnType<typeof referenceEffectState>}> = ({e,w,h,state}) => {
  const ink = e.color ?? '#653a2f';
  const stroke = Math.max(3, Math.min(w,h)*.028);
  const motion=referenceEmotionMotion(state.seconds);
  const accent=referenceAccentMotion(state.seconds);
  if(e.kind==='reaction-anger') return <g fill="none" strokeLinecap="round" strokeLinejoin="round">
    {[0,1].map(i=>{const a=referenceAccentMotion(state.seconds,i);const x=w*(i ? .84 : .16);return <path key={i} d={`M ${x} ${h*.49} C ${x-w*.15} ${h*.34} ${x+w*(.15+a.steamBend)} ${h*.3} ${x} ${h*.17}`} transform={`translate(0 ${-h*a.steamY})`} opacity={a.steamOpacity} stroke="#fff4dc" strokeWidth={stroke*1.5}/>;})}
    <g transform={`translate(${w*.5} ${h*.62}) scale(${accent.angerScale})`} stroke={e.color ?? '#ae493b'} strokeWidth={stroke*1.9}>
      {[0,90,180,270].map(a=><path key={a} transform={`rotate(${a})`} d={`M ${-w*.065} ${-h*.25} Q ${-w*.04} ${-h*.055} ${-w*.24} ${-h*.065}`} />)}
    </g>
  </g>;
  if(e.kind==='reaction-shock') return <g>
    <g opacity={accent.burst} stroke="#bc6244" strokeWidth={stroke*.9} strokeLinecap="round">
      {[-145,-105,-65,-25,25].map((a,i)=>{const rad=a*Math.PI/180;return <path key={i} d={`M ${w*(.5+Math.cos(rad)*.3)} ${h*(.45+Math.sin(rad)*.3)} L ${w*(.5+Math.cos(rad)*.43)} ${h*(.45+Math.sin(rad)*.43)}`}/>;})}
    </g>
    <g transform={`translate(${w*.5} ${h*.5}) scale(${accent.shockScale})`} fill={e.color ?? '#a44832'} stroke="#fff4df" strokeWidth={stroke*.6} strokeLinejoin="round" paintOrder="stroke">
      <path d={`M ${-w*.07} ${-h*.34} Q 0 ${-h*.38} ${w*.07} ${-h*.34} L ${w*.035} ${h*.12} Q 0 ${h*.15} ${-w*.035} ${h*.12} Z`}/>
      <ellipse cy={h*.27} rx={w*.054} ry={h*.052}/>
    </g>
  </g>;
  if(e.kind==='reaction-gloom') return <g fill="none" strokeLinecap="round">
    {[0,1,2].map(i=>{const a=referenceAccentMotion(state.seconds,i);const x=w*(.27+i*.23);const d=`M ${x} ${h*.13} Q ${x-w*.018} ${h*.39} ${x+w*.015} ${h*(.65+(i===1 ? .12 : 0))}`;return <g key={i} transform={`translate(0 ${h*a.stressY})`}>
      <path d={d} stroke="#f0f0df" strokeWidth={stroke*1.5} pathLength={1} strokeDasharray={1} strokeDashoffset={1-a.stress}/>
      <path d={d} stroke={e.color ?? '#637384'} strokeWidth={stroke*.9} pathLength={1} strokeDasharray={1} strokeDashoffset={1-a.stress}/>
    </g>;})}
  </g>;
  if(e.kind==='reaction-idea') return <g>
    {[{x:.49,y:.45,s:1},{x:.79,y:.23,s:.35}].map((p,i)=>{const a=referenceAccentMotion(state.seconds,i);return <g key={i} opacity={a.glintOpacity} transform={`translate(${w*p.x} ${h*p.y}) scale(${p.s*a.glintScale*state.part(i*4,7)})`}>
      <path d={`M 0 ${-h*.29} Q ${w*.03} ${-h*.035} ${w*.24} 0 Q ${w*.03} ${h*.035} 0 ${h*.29} Q ${-w*.03} ${h*.035} ${-w*.24} 0 Q ${-w*.03} ${-h*.035} 0 ${-h*.29} Z`} fill={e.color ?? '#f4c365'} stroke="#946638" strokeWidth={stroke*.55}/>
    </g>;})}
    {[-120,-30,60,150].map((a,i)=>{const rad=a*Math.PI/180;return <path key={a} d={`M ${w*(.49+Math.cos(rad)*.32)} ${h*(.45+Math.sin(rad)*.34)} l ${w*Math.cos(rad)*.075} ${h*Math.sin(rad)*.08}`} stroke="#b98947" strokeWidth={stroke*.7} strokeLinecap="round" opacity={accent.glintOpacity*state.part(5+i,6)}/>;})}
  </g>;
  const sweat=<g>{(e.kind==='reaction-sweat' ? [.3,.68] : [.12,.87]).map((x,i)=>{
    const drop=referenceSweatMotion(state.seconds,i);
    const y=h*(e.kind==='reaction-sweat' ? .08 : .58);
    return <g key={i} opacity={drop.opacity} transform={`translate(${w*x} ${y+h*drop.y}) scale(${drop.scaleX*(e.kind==='reaction-sweat' ? 1.8 : 1)} ${drop.scaleY})`}>
      <path d={`M 0 0 C ${-w*.012} ${h*.048} ${-w*.052} ${h*.085} ${-w*.044} ${h*.126} C ${-w*.032} ${h*.185} ${w*.052} ${h*.174} ${w*.047} ${h*.119} C ${w*.043} ${h*.073} ${w*.012} ${h*.04} 0 0 Z`} fill="#b2d7e3" stroke="#517c82" strokeWidth={stroke*.62}/>
      <path d={`M ${-w*.021} ${h*.098} Q ${-w*.03} ${h*.129} ${-w*.013} ${h*.143}`} fill="none" stroke="#effaff" strokeWidth={stroke*.6} strokeLinecap="round"/>
    </g>;
  })}</g>;
  if(e.kind==='reaction-sweat') return sweat;
  if (e.kind === 'reaction-alert') return <g stroke={ink} strokeWidth={stroke*1.3} strokeLinecap="round">
    {[[.25,.65,.12,.33],[.48,.48,.47,.1],[.7,.6,.86,.29]].map(([x1,y1,x2,y2],i) => {
      const p=state.part(i*2,Math.min(state.fps*.3,state.duration*.3));
      const scale=.65+.35*p+.23*Math.sin(p*Math.PI);
      return <path key={i} d={`M ${w*x1} ${h*y1} L ${w*x2} ${h*y2}`} transform={`translate(${w*x1} ${h*y1}) scale(${scale}) translate(${-w*x1} ${-h*y1})`} pathLength={1} strokeDasharray={1} strokeDashoffset={1-state.part(i*2,5)} opacity={state.part(i*2,3)}/>;
    })}</g>;
  if (e.kind === 'reaction-confused') {
    const paths=[0,1].map(layer=>{
      const points=Array.from({length:85},(_,i)=>{
        const t=i/84*Math.PI*7, phase=motion.phase+layer*1.8;
        return [w*(.5+.31*Math.cos(t)+.05*Math.sin(t*2.4+phase)*motion.energy),h*(.32+.18*Math.sin(t*1.7+phase*.32)+.035*Math.cos(t*3-phase)*motion.energy)];
      });
      return points.reduce((d,p,i)=>i===0 ? `M ${p[0]} ${p[1]}` : d+` Q ${points[i-1][0]} ${points[i-1][1]} ${(points[i-1][0]+p[0])/2} ${(points[i-1][1]+p[1])/2}`,'');
    });
    return <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <g transform={`rotate(${motion.tilt} ${w*.5} ${h*.32})`}>
        {paths.map((d,i)=><path key={`halo-${i}`} d={d} stroke="#fff3dc" strokeWidth={stroke*(i ? .8 : 1.2)} opacity={i ? .28 : .8} pathLength={1} strokeDasharray={1} strokeDashoffset={1-state.draw}/>)}
        {paths.map((d,i)=><path key={i} d={d} stroke={ink} strokeWidth={stroke*(i ? .5 : .85)} opacity={i ? .35 : 1} pathLength={1} strokeDasharray={1} strokeDashoffset={1-state.draw}/>)}
      </g>{sweat}
    </g>;
  }
  return <g>
    {[{x:.25,y:.9,r:.033},{x:.33,y:.78,r:.048}].map((dot,i) => <circle key={i} cx={w*dot.x} cy={h*dot.y} r={Math.min(w,h)*dot.r*state.part(i*3,4)} fill="#fff5de" stroke={INK} strokeWidth={stroke*.7}/>)}
    <g transform={`translate(${w*.45} ${h*.65}) scale(${referenceEmotionMotion(Math.max(0,state.seconds-.12)).cloudScale}) translate(${-w*.45} ${-h*.65})`}>
    <path d={`M ${w*.2} ${h*.52} C ${w*.06} ${h*.42} ${w*.15} ${h*.16} ${w*.31} ${h*.18} C ${w*.35} ${h*.02} ${w*.59} ${h*.04} ${w*.64} ${h*.15} C ${w*.85} ${h*.1} ${w*.97} ${h*.35} ${w*.82} ${h*.46} C ${w*.87} ${h*.63} ${w*.63} ${h*.72} ${w*.53} ${h*.64} C ${w*.4} ${h*.77} ${w*.2} ${h*.69} ${w*.2} ${h*.52} Z`} fill="#fff5de" stroke={INK} strokeWidth={stroke*.78} opacity={state.part(4,5)}/>
    {(e.text ?? '？').split('').slice(0,3).map((char,i,chars) => {const p=state.part(7+i*4,7); const x=w*(.51+(i-(chars.length-1)/2)*.19);return <text key={i} x={x} y={h*.53} textAnchor="middle" fontFamily={BRUSH} fontSize={h*.43} fill={ink} opacity={p} transform={`translate(${x} ${h*.4}) rotate(${Math.sin(state.seconds*4.5+i*.8)*5*motion.energy}) scale(${.78+.22*p}) translate(${-x} ${-h*.4})`}>{char}</text>;})}
    </g>
  </g>;
};

const Mark: React.FC<{e: ReferenceEffect; w: number; h: number; state: ReturnType<typeof referenceEffectState>}> = ({e,w,h,state}) => {
  const ring = e.kind === 'prop-ring';
  const d = ring ? `M ${w*.72} ${h*.14} C ${w*.37} ${-h*.01} ${w*.04} ${h*.22} ${w*.08} ${h*.54} S ${w*.54} ${h*.98} ${w*.84} ${h*.75} S ${w*.89} ${h*.15} ${w*.59} ${h*.12}` : `M ${w*.05} ${h*.6} Q ${w*.47} ${h*.4} ${w*.94} ${h*.53}`;
  return <g fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} stroke="#efce8c" strokeWidth={6} opacity={.85} pathLength={1} strokeDasharray={1} strokeDashoffset={1-state.draw}/>
    <path d={d} transform={`translate(${w*.012} ${h*.013})`} stroke={e.color ?? '#a64b35'} strokeWidth={3} pathLength={1} strokeDasharray={1} strokeDashoffset={1-state.draw}/>
    {e.kind === 'connector' ? <path d={`M ${w*.82} ${h*.3} L ${w*.94} ${h*.53} L ${w*.81} ${h*.75}`} stroke={e.color ?? '#a64b35'} strokeWidth={3} opacity={state.part(9,4)}/> : null}
  </g>;
};

const MapRoute: React.FC<{e: ReferenceEffect; w: number; h: number; state: ReturnType<typeof referenceEffectState>}> = ({e,w,h,state}) => {
  const route=e.route!;
  const motion=referenceMapRouteState(route,state.local,w,h);
  const d=route.points.map(([x,y],i)=>`${i?'L':'M'} ${x*w} ${y*h}`).join(' ');
  const ink=e.color ?? '#de7155';
  const last=route.points[route.points.length-1];
  // The quiet underlay shows the destination while the stronger stroke reveals progress.
  return <g fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} stroke="#6b7d70" strokeWidth={3} strokeDasharray="9 13" opacity={.24}/>
    <path d={d} stroke="#fff5d7" strokeWidth={14} pathLength={1} strokeDasharray={1} strokeDashoffset={1-motion.reveal}/>
    <path d={d} stroke={ink} strokeWidth={7} pathLength={1} strokeDasharray={1} strokeDashoffset={1-motion.reveal}/>
    <circle cx={last[0]*w} cy={last[1]*h} r={motion.pulseRadius} stroke={ink} strokeWidth={3} opacity={motion.pulseOpacity}/>
    <g transform={`translate(${motion.head.x} ${motion.head.y})`} opacity={state.local>=route.revealStartOffset ? 1 : 0}>
      {route.marker==='ship' ? <g transform={`scale(${Math.cos(motion.head.angle*Math.PI/180)<0 ? -1 : 1} 1)`}>
        <path d="M -20 6 L 23 6 L 14 18 L -11 18Z" fill="#916b48" stroke="#fff5d7" strokeWidth={3}/>
        <path d="M -2 3 L -2 -25 L 19 1Z" fill="#fff3d2" stroke="#775c46" strokeWidth={2.5}/>
        <path d="M -7 -20 L -7 2 L -22 2Z" fill="#f3ca85" stroke="#775c46" strokeWidth={2}/>
      </g> : <><circle r={12} fill={ink} stroke="#fff5d7" strokeWidth={5}/><circle r={4} fill="#fff5d7" stroke="none"/></>}
    </g>
  </g>;
};

export const ReferenceEditorialOverlay: React.FC<ReferenceEditorialProps> = props => {
  const frame = useCurrentFrame();
  useBrushFont();
  useMemo(() => validateReferenceEditorialProps(props), [props]);
  const camera = fineCameraAt(props.camera, frame + props.shotFrameOffset, props.shotDurationInFrames);
  return <AbsoluteFill style={{backgroundColor:'transparent',overflow:'hidden',pointerEvents:'none'}}>
    <BookPage props={props} frame={frame}/>
    {(['image','screen'] as const).map(space => <AbsoluteFill key={space} style={{transformOrigin:'0 0',transform:space==='image' ? `translate(${-props.width*(camera.zoom-1)*camera.focusX}px, ${-props.height*(camera.zoom-1)*camera.focusY}px) scale(${camera.zoom})` : undefined}}>
      {props.effects.filter(e => e.space===space).map((e,index) => {
        const state = referenceEffectState(e,frame,props.fps);
        if (!state.active) return null;
        const w=e.width*props.width,h=e.height*props.height;
        const uid=`ref-${space}-${index}`;
        return <svg key={e.id} data-editorial-effect={e.id} width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{position:'absolute',left:e.x*props.width,top:e.y*props.height,opacity:state.opacity,overflow:'visible'}}>
          {e.kind==='map-route' ? <MapRoute e={e} w={w} h={h} state={state}/> : e.kind.startsWith('title-') ? <Title e={e} w={w} h={h} uid={uid} state={state}/> : e.kind.startsWith('reaction-') ? <Reaction e={e} w={w} h={h} state={state}/> : <Mark e={e} w={w} h={h} state={state}/>}
        </svg>;
      })}
    </AbsoluteFill>)}
  </AbsoluteFill>;
};
