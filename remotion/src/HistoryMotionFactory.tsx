import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Audio, Freeze, Img, OffthreadVideo, Sequence, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {ReferenceEditorialOverlay} from './ReferenceEditorialOverlay';
import {HistoryCompanionGraphic} from './HistoryCompanionGraphic';
export {companionGraphicLayout,companionReveal} from './HistoryCompanionGraphic';
import {referenceRoutePoint, type ReferenceEffect} from './reference-editorial-core';

export type HistoryMotionTitle = {text: string; start: number; duration: number; emphasis?: string; motion?: 'brush' | 'stamp'; x?: number; y?: number; width?: number; height?: number};
export type HistoryMotionGraphic = {
  kind: 'timeline' | 'comparison' | 'relationship' | 'quote'; title: string;
  items: {label: string; detail?: string; value?: string}[];
};
export type HistoryMotionSoundEffect = {sourcePath: string; sha256?: string; sourceName?: string; startFrame: number; frames: number; volume?: number};
export type {HistoryMotionMap} from './HistoryMapScene';
import {HistoryMapScene, type HistoryMotionMap} from './HistoryMapScene';

export type HistoryMotionShot = {
  shotId: string; startFrame: number; frames: number; sourcePath?: string; sourceFrames?: number; playbackRate?: number; playableFrames?: number;
  visualType?: 'video' | 'map' | 'image' | 'graphic';
  imagePath?: string; imageSha256?: string; graphic?: HistoryMotionGraphic;
  inPoint?: number; outPoint?: number; shortfallPolicy?: 'freeze';
  crop?: 'center' | 'cover' | 'contain' | 'left' | 'right'; narration?: string; sourceNote?: string;
  motion?: {kind?: string; durationScale?: number; keyframes?: {t: number; focusX: number; focusY: number; zoom: number; easing?: string}[]};
  titles?: HistoryMotionTitle[]; map?: HistoryMotionMap | null;
  shotcraft?: {version:number;recipe:string;transition?:string;vignette?:number;graphicRecipe?:string};
};
export type HistoryMotionFactoryProps = {
  width: number; height: number; fps: number; durationInFrames: number;
  audioSrc?: string; shots: HistoryMotionShot[]; captions?: {text: string; startFrame: number; endFrame: number}[];
  soundEffects?: HistoryMotionSoundEffect[];
};

// The worker stages every input into the composition's public directory.
const media = (source: string) => staticFile(source);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {const t = clamp(value); return t * t * (3 - 2 * t);};

function useCaptionFont() {
  const [handle] = useState(() => delayRender('Load local history caption font'));
  useEffect(() => {
    let active = true;
    new FontFace('HistoryMotionWenKai', `url("${staticFile('fonts/LXGWWenKaiScreen.ttf')}")`).load()
      .then(font => {document.fonts.add(font); if (active) continueRender(handle);})
      .catch(cancelRender);
    return () => {active = false; continueRender(handle);};
  }, [handle]);
}

export function motionAt(shot: HistoryMotionShot, frame: number) {
  const keys = shot.motion?.keyframes;
  if (!keys?.length || shot.motion?.kind === 'static') return {focusX: .5, focusY: .5, zoom: 1};
  const t = clamp(frame / Math.max(1, (shot.frames - 1) * (shot.motion?.durationScale ?? 1)));
  const index = Math.max(0, keys.slice(1).findIndex(key => t <= key.t));
  const before = t >= keys[keys.length - 1].t ? keys[keys.length - 1] : keys[index];
  const after = keys[index + 1] ?? before;
  const raw = clamp((t - before.t) / Math.max(.0001, after.t - before.t));
  const local = after.easing === 'linear' ? raw : after.easing === 'ease-in' ? raw * raw : after.easing === 'ease-out' ? 1 - (1 - raw) ** 2 : smooth(raw);
  return {focusX: before.focusX + (after.focusX - before.focusX) * local,
    focusY: before.focusY + (after.focusY - before.focusY) * local, zoom: before.zoom + (after.zoom - before.zoom) * local};
}

type GraphicRect = {x: number; y: number; width: number; height: number};

export function graphicLayout(kind: HistoryMotionGraphic['kind'], count: number, width: number, height: number, hasTitles = false) {
  const portrait = width < height;
  const capacity = kind === 'comparison' ? 4 : kind === 'quote' ? 2 : portrait ? 3 : 4;
  const visible = Math.min(count, capacity), columns = kind === 'comparison' ? 2 : portrait ? 1 : visible;
  const rows = Math.ceil(visible / columns), gap = 40;
  const top = hasTitles ? .36 : .28;
  const content = {x: width * .08, y: height * top, width: width * .84, height: height * (.76 - top)};
  const timelineGutter = portrait && ['timeline','relationship'].includes(kind) ? 54 : 0;
  const boxes = Array.from({length: visible}, (_, index) => ({
    x: content.x + (index % columns) * (content.width + gap) / columns + timelineGutter,
    y: content.y + Math.floor(index / columns) * (content.height + gap) / rows,
    width: (content.width - gap * (columns - 1)) / columns - timelineGutter,
    height: (content.height - gap * (rows - 1)) / rows,
  }));
  return {portrait,capacity,columns,content,boxes,
    title: {x: width * .08,y: height * (hasTitles ? .18 : .08),width: width * .84,height: height * .15}};
}

export function graphicReveal(frame: number, frames: number, index: number, count: number) {
  const t = clamp(frame / Math.max(1,frames - 1));
  const start = .1 + index * .46 / Math.max(1,count);
  return {enter: smooth((t - start) / .12), detail: smooth((t - start - .1) / .12)};
}

export function fitGraphicText(text: string, width: number, height: number, maximum: number) {
  // Conservative glyph widths keep both Chinese text and long Latin words inside fixed boxes.
  const fits = (size: number) => {
    let lines = 1, used = 0;
    for (const character of text) {
      if (character === '\n') {lines++; used = 0; continue;}
      const advance = size * (/^[\x00-\x7f]$/.test(character) ? .68 : 1.05);
      if (used + advance > width) {lines++; used = 0;}
      used += advance;
    }
    return lines * size * 1.32 <= height;
  };
  let size = maximum;
  while (size > 6 && !fits(size)) size--;
  return size;
}

function GraphicText({text,box,maximum,color = '#f3f5ed',reveal = 1}: {text: string; box: GraphicRect; maximum: number; color?: string; reveal?: number}) {
  return <div data-graphic-text style={{position: 'absolute',left: box.x,top: box.y,width: box.width,height: box.height,
    fontSize: fitGraphicText(text,box.width,box.height,maximum),lineHeight: 1.32,color,letterSpacing: 0,
    whiteSpace: 'pre-wrap',overflowWrap: 'anywhere',opacity: reveal,clipPath: `inset(0 ${(1-reveal)*100}% 0 0)`}}>{text}</div>;
}

export function GraphicLayer({graphic,frame,frames,width,height,hasTitles = false,hasBackdrop = false}: {
  graphic: HistoryMotionGraphic; frame: number; frames: number; width: number; height: number; hasTitles?: boolean; hasBackdrop?: boolean;
}) {
  const layout = graphicLayout(graphic.kind,graphic.items.length,width,height,hasTitles);
  const pages = Math.ceil(graphic.items.length / layout.capacity);
  const page = Math.min(pages - 1,Math.floor(frame * pages / frames));
  const pageStart = Math.ceil(page * frames / pages), pageEnd = Math.ceil((page + 1) * frames / pages);
  const local = frame - pageStart, pageFrames = pageEnd - pageStart;
  const items = graphic.items.slice(page * layout.capacity,(page + 1) * layout.capacity);
  const titleEnter = smooth(frame / Math.max(1,Math.min(12,frames * .12)));
  const connected = graphic.kind === 'timeline' || graphic.kind === 'relationship';
  const node = (box: GraphicRect) => ({x: box.x - (layout.portrait ? 38 : 0),y: box.y + (layout.portrait ? 24 : 12)});
  return <AbsoluteFill data-graphic-kind={graphic.kind} data-graphic-page={page} style={{
    background: hasBackdrop ? 'rgba(12,25,23,.88)' : 'transparent',fontFamily: 'HistoryMotionWenKai',letterSpacing: 0}}>
    <GraphicText text={graphic.title} box={layout.title} maximum={layout.portrait ? 58 : 66} reveal={titleEnter}/>
    <div style={{position: 'absolute',left: layout.title.x,top: layout.title.y-18,width: 86*titleEnter,height: 5,background: '#ed866c'}}/>
    {pages > 1 ? <div style={{position: 'absolute',right: '8%',top: '79%',fontSize: 24,color: '#b4cdc3'}}>{page+1} / {pages}</div> : null}
    {connected ? <svg width={width} height={height} style={{position: 'absolute',inset: 0}}>
      {items.map((_,index) => {
        const point = node(layout.boxes[index]), state = graphicReveal(local,pageFrames,index,items.length);
        const previous = index ? node(layout.boxes[index-1]) : point;
        return <g key={index}>
          {index ? <path d={`M ${previous.x} ${previous.y} L ${point.x} ${point.y}`} fill="none" stroke="#6eaaa1" strokeWidth={3}
            pathLength={1} strokeDasharray="1 1" strokeDashoffset={1-state.enter}/> : null}
          <circle cx={point.x} cy={point.y} r={8*state.enter} fill={index===items.length-1 ? '#ed866c' : '#8bcec3'}/>
          {graphic.kind === 'relationship' && index ? <path d="M -10 -6 L 0 0 L -10 6" fill="none" stroke="#8bcec3" strokeWidth={3}
            opacity={state.enter} transform={`translate(${point.x-(layout.portrait ? 0 : 18)} ${point.y-(layout.portrait ? 18 : 0)}) rotate(${layout.portrait ? 90 : 0})`}/> : null}
        </g>;
      })}
    </svg> : null}
    {items.map((item,index) => {
      const rect = layout.boxes[index], state = graphicReveal(local,pageFrames,index,items.length);
      const inset = connected && !layout.portrait ? 44 : graphic.kind === 'quote' ? 30 : 18;
      const box = {x: 0,y: inset,width: rect.width-(graphic.kind === 'quote' ? 40 : 16),height: rect.height-inset};
      const valueHeight = item.value ? box.height*.3 : 0;
      const labelHeight = item.detail ? box.height*(item.value ? .28 : .34) : box.height-valueHeight-10;
      const accent = index % 2 ? '#8bcec3' : '#ed866c';
      return <div key={page*layout.capacity+index} data-graphic-item style={{position: 'absolute',left: rect.x,top: rect.y,
        width: rect.width,height: rect.height,opacity: state.enter,transform: `translateY(${(1-state.enter)*20}px)`}}>
        {!connected ? <div style={{position: 'absolute',top: 0,left: 0,width: graphic.kind === 'quote' ? 5 : rect.width*state.enter,
          height: graphic.kind === 'quote' ? rect.height : 3,background: accent}}/> : null}
        <div style={{position: 'absolute',inset: graphic.kind === 'quote' ? '0 0 0 24px' : 0}}>
          {item.value ? <GraphicText text={item.value} box={{...box,height: valueHeight}} maximum={layout.portrait ? 64 : 72} color={accent} reveal={state.detail}/> : null}
          <GraphicText text={item.label} box={{...box,y: inset+valueHeight+(item.value ? 8 : 0),height: labelHeight}} maximum={layout.portrait ? 44 : 46}/>
          {item.detail ? <GraphicText text={item.detail} box={{...box,y: inset+valueHeight+labelHeight+16,
            height: Math.max(1,box.height-valueHeight-labelHeight-16)}} maximum={layout.portrait ? 32 : 34} color="#c8dcd4" reveal={state.detail}/> : null}
        </div>
      </div>;
    })}
  </AbsoluteFill>;
}

/** Explanations accompany the scene, leaving its subject and subtitles visible. */
export function CompanionGraphic({graphic,frame,frames,width,height}: {
  graphic: HistoryMotionGraphic; frame: number; frames: number; width: number; height: number;
}) {
  return <HistoryCompanionGraphic graphic={graphic} frame={frame} frames={frames} width={width} height={height}/>;
}

export function soundEffectEnvelope(effect: HistoryMotionSoundEffect, frame: number, fps: number) {
  const local = frame - effect.startFrame;
  if (local < 0 || local >= effect.frames) return 0;
  const fade = Math.min(Math.round(fps*.12),Math.floor((effect.frames-1)/2));
  return Math.max(0,Math.min(.18,effect.volume ?? .14)) * (fade > 0 ? smooth(local/fade)*smooth((effect.frames-1-local)/fade) : 1);
}

export function soundEffectVolume(effects: HistoryMotionSoundEffect[], index: number, frame: number, fps: number) {
  const gains = effects.map(effect=>soundEffectEnvelope(effect,frame,fps));
  const total = gains.reduce((sum,gain)=>sum+gain,0);
  return gains[index] * Math.min(1,.15 / Math.max(.15,total));
}

export function mapRouteState(route: NonNullable<HistoryMotionMap['routes']>[number], seconds: number, width: number, height: number, duration: number) {
  const start = route.start ?? 0, end = route.end ?? Math.min(1,duration);
  const progress = smooth((seconds-start)/Math.max(.0001,end-start));
  return {progress,head: referenceRoutePoint(route.points,progress,width,height),
    path: route.points.map(([x,y],i)=>`${i ? 'L' : 'M'} ${x*width} ${y*height}`).join(' ')};
}


export function shotTransitionFrames(previous: HistoryMotionShot | undefined, shot: HistoryMotionShot, fps: number) {
  if (!previous || previous.startFrame + previous.frames !== shot.startFrame) return 0;
  if(shot.shotcraft?.transition==='cut' || previous.shotcraft?.recipe==='slow-push-in')return 0;
  const illustrated = Boolean(previous.map?.enabled || shot.map?.enabled || previous.imagePath || shot.imagePath);
  const desired = Math.round(fps * (illustrated ? .4 : .267));
  return Math.max(0, Math.min(desired, Math.floor(previous.frames / 5), Math.floor(shot.frames / 5)));
}

export function outgoingSceneOpacity(frame: number, frames: number) {
  return frames < 2 ? 0 : 1 - smooth(frame / (frames - 1));
}

function ShotScene({shot, props, annotations = true}: {shot: HistoryMotionShot; props: HistoryMotionFactoryProps; annotations?: boolean}) {
  const frame = useCurrentFrame();
  const map = shot.map?.enabled ? shot.map : null;
  const camera = map ? {focusX:.5,focusY:.5,zoom:1} : motionAt(shot, frame);
  const sourceFrames = shot.sourceFrames ?? shot.frames;
  const available = Math.min(shot.frames, shot.playableFrames ?? sourceFrames);
  const mediaStyle: React.CSSProperties = {width: '100%',height: '100%',objectFit: shot.crop === 'contain' ? 'contain' : 'cover',objectPosition: shot.crop === 'left' ? 'left center' : shot.crop === 'right' ? 'right center' : 'center'};
  // The parent Sequence bounds playback in timeline frames. OffthreadVideo's
  // endAt truncates that timeline before a slowed clip reaches its source end.
  const video = shot.sourcePath ? <OffthreadVideo src={media(shot.sourcePath)} muted playbackRate={shot.playbackRate ?? 1} startFrom={Math.round((shot.inPoint || 0)*props.fps)} style={mediaStyle}/> : null;
  const effects: ReferenceEffect[] = (shot.graphic ? [] : shot.titles ?? []).map((title, i) => ({id: `${shot.shotId}-title-${i}`, kind: 'title-ink', text: title.text,
    startFrame: Math.round(title.start*props.fps), endFrame: Math.round((title.start+title.duration)*props.fps),
    x: title.x ?? .05, y: title.y ?? (map ? .65 : .09), width: title.width ?? (props.width < props.height ? .75 : .46), height: title.height ?? .09,
    space: 'screen', font: 'mashan', motion: title.motion ?? 'brush', emphasisText: title.emphasis,
    color: shot.graphic ? '#f3f5ed' : '#382416', emphasisColor: shot.graphic ? '#ed866c' : '#a44332'}));
  return <AbsoluteFill style={{overflow: 'hidden', background: '#120f0c'}}>
    <AbsoluteFill style={{transformOrigin: '0 0', transform: `translate(${-props.width*(camera.zoom-1)*camera.focusX}px, ${-props.height*(camera.zoom-1)*camera.focusY}px) scale(${camera.zoom})`}}>
      {map ? <HistoryMapScene map={map} seconds={frame/props.fps} duration={shot.frames/props.fps}/> : shot.imagePath ? <Img src={media(shot.imagePath)} style={mediaStyle}/> : <>
        <Sequence durationInFrames={available}>{video}</Sequence>
        {available < shot.frames && shot.shortfallPolicy === 'freeze' ? <Sequence from={available} durationInFrames={shot.frames-available}><Freeze frame={available-1}>{video}</Freeze></Sequence> : null}
      </>}
    </AbsoluteFill>
    {shot.shotcraft?.vignette?<AbsoluteFill style={{pointerEvents:'none',
      opacity:shot.shotcraft.vignette*(frame/Math.max(1,shot.frames-1))**2,
      background:'radial-gradient(ellipse 62% 55% at 50% 50%,transparent 45%,rgba(0,0,0,.95) 100%)'}}/>:null}
    {annotations && shot.graphic ? (map || shot.imagePath || shot.sourcePath ?
      <CompanionGraphic graphic={shot.graphic} frame={frame} frames={shot.frames} width={props.width} height={props.height}/> :
      <GraphicLayer graphic={shot.graphic} frame={frame} frames={shot.frames} width={props.width} height={props.height} hasBackdrop/>) : null}
    {annotations && effects.length ? <ReferenceEditorialOverlay width={props.width} height={props.height} fps={props.fps} durationInFrames={shot.frames} shotDurationInFrames={shot.frames} shotFrameOffset={0} camera={{mode: 'hold', amount: 0, focusX: .5, focusY: .5}} effects={effects}/> : null}
  </AbsoluteFill>;
}

function OutgoingScene({shot, props, frames}: {shot: HistoryMotionShot; props: HistoryMotionFactoryProps; frames: number}) {
  const frame = useCurrentFrame();
  // Keep the incoming scene fully opaque underneath. Only the outgoing image
  // fades, so the cut cannot flash black or fade the global narration/captions.
  return <AbsoluteFill style={{opacity: outgoingSceneOpacity(frame, frames)}}>
    <Freeze frame={shot.frames - 1}><ShotScene shot={shot} props={props} annotations={false}/></Freeze>
  </AbsoluteFill>;
}

export const HistoryMotionFactory: React.FC<HistoryMotionFactoryProps> = props => {
  useCaptionFont();
  const frame = useCurrentFrame();
  const caption = props.captions?.find(c => frame>=c.startFrame && frame<c.endFrame);
  return <AbsoluteFill style={{background: '#000'}}>
    {props.audioSrc ? <Audio src={media(props.audioSrc)}/> : null}
    {props.soundEffects?.map((effect,index)=><Sequence key={`sfx-${index}`} from={effect.startFrame} durationInFrames={effect.frames} layout="none">
      <Audio src={media(effect.sourcePath)} endAt={effect.frames}
        volume={localFrame=>soundEffectVolume(props.soundEffects ?? [],index,effect.startFrame+localFrame,props.fps)}/>
    </Sequence>)}
    {props.shots.map((shot, index) => {
      const previous = props.shots[index - 1], transitionFrames = shotTransitionFrames(previous, shot, props.fps);
      return <Sequence key={shot.shotId} from={shot.startFrame} durationInFrames={shot.frames} premountFor={2}>
        <ShotScene shot={shot} props={props}/>
        {transitionFrames > 1 ? <Sequence durationInFrames={transitionFrames} layout="none">
          <OutgoingScene shot={previous} props={props} frames={transitionFrames}/>
        </Sequence> : null}
      </Sequence>;
    })}
    {caption ? <div style={{position: 'absolute', left: '6%', right: '6%', bottom: '4%', color: '#fff', fontFamily: 'HistoryMotionWenKai', fontSize: props.width<props.height ? 54 : 56, lineHeight: 1.35, textAlign: 'center', whiteSpace: 'pre-line', WebkitTextStroke: '4px #171717', paintOrder: 'stroke fill', textShadow: '0 3px 8px #000'}}>{caption.text}</div> : null}
  </AbsoluteFill>;
};
