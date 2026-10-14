import type {FineCamera} from './fine-edit-core';

export type ReferenceMapRoute = {
  /** Full-frame normalized coordinates, sourced from the base map projection. */
  points: [number, number][];
  /** Relative to this effect's start, not the shot or cropped render window. */
  revealStartOffset: number;
  revealEndOffset: number;
  pulseFrames: number;
  marker?: 'dot' | 'ship';
  historyStatus: 'illustrative' | 'sourced';
  coordinateSource: string;
};

export type ReferenceEffect = {
  id: string;
  kind: 'title-scroll' | 'title-ink' | 'reaction-thought' | 'reaction-confused' | 'reaction-sweat' | 'reaction-alert' | 'reaction-anger' | 'reaction-shock' | 'reaction-gloom' | 'reaction-idea' | 'prop-ring' | 'underline' | 'connector' | 'map-route';
  text?: string;
  x: number; y: number; width: number; height: number;
  startFrame: number; endFrame: number;
  fontSize?: number;
  font?: 'mashan' | 'wenkai';
  space: 'screen' | 'image';
  color?: string;
  motion?: 'brush' | 'stamp';
  emphasisText?: string;
  emphasisColor?: string;
  route?: ReferenceMapRoute;
};
export type ReferenceEditorialProps = {
  width: number; height: number; fps: number; durationInFrames: number;
  shotDurationInFrames: number; shotFrameOffset: number;
  camera: FineCamera;
  effects: ReferenceEffect[];
  page?: {title: string; imageSrc: string; startFrame: number; endFrame: number; fontSize?: number};
  captions?: {startFrame: number; endFrame: number; text: string}[];
};
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => {const t = clamp01(v); return t * t * (3 - 2 * t);};

/** Follow actual screen-space arc length, including unequal-length route segments. */
export function referenceRoutePoint(points: [number, number][], progress: number, width: number, height: number) {
  const pixels = points.map(([x,y]) => [x*width,y*height]);
  const lengths = pixels.slice(1).map(([x,y],i) => Math.hypot(x-pixels[i][0],y-pixels[i][1]));
  let remaining = clamp01(progress)*lengths.reduce((sum,n)=>sum+n,0);
  for(let i=0;i<lengths.length;i++) {
    if(lengths[i]===0) continue;
    if(remaining<=lengths[i] || i===lengths.length-1) {
      const t=clamp01(remaining/lengths[i]);
      const [x,y]=pixels[i], [endX,endY]=pixels[i+1];
      return {x:x+(endX-x)*t,y:y+(endY-y)*t,angle:Math.atan2(endY-y,endX-x)*180/Math.PI};
    }
    remaining-=lengths[i];
  }
  const last=pixels[pixels.length-1];
  return {x:last[0],y:last[1],angle:0};
}

export function referenceMapRouteState(route: ReferenceMapRoute, local: number, width: number, height: number) {
  const reveal=smooth((local-route.revealStartOffset)/(route.revealEndOffset-route.revealStartOffset));
  const pulseAge=local-route.revealEndOffset;
  const pulse=clamp01(pulseAge/route.pulseFrames);
  return {reveal,head:referenceRoutePoint(route.points,reveal,width,height),
    pulseRadius:12+32*smooth(pulse),
    pulseOpacity:pulseAge>=0 && pulseAge<route.pulseFrames ? .72*(1-smooth(pulse)) : 0};
}

export function validateReferenceMapRoute(effect: ReferenceEffect, camera: FineCamera, fps: number) {
  const route=effect.route, duration=effect.endFrame-effect.startFrame;
  if(effect.space!=='screen' || effect.x!==0 || effect.y!==0 || effect.width!==1 || effect.height!==1
    || camera.mode!=='hold' || camera.amount!==0) throw new Error('Reference overlay: map-route requires full-frame screen space and a hold camera');
  if(!route || !Array.isArray(route.points) || route.points.length<2 || route.points.length>256
    || route.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v)||v<0||v>1))
    || route.points.every(p=>p[0]===route.points[0][0]&&p[1]===route.points[0][1])) throw new Error('Reference overlay: map-route requires distinct normalized points');
  if(![route.revealStartOffset,route.revealEndOffset,route.pulseFrames].every(Number.isInteger)
    || route.revealStartOffset<0 || route.revealEndOffset<=route.revealStartOffset || route.pulseFrames<1
    || route.revealEndOffset+Math.max(route.pulseFrames,Math.ceil(fps*.7))>duration) throw new Error('Reference overlay: map-route needs valid reveal offsets, arrival pulse and readable hold');
  if((route.marker!==undefined && !['dot','ship'].includes(route.marker))
    || !['illustrative','sourced'].includes(route.historyStatus) || typeof route.coordinateSource!=='string' || !route.coordinateSource.trim()) throw new Error('Reference overlay: map-route needs a valid marker and coordinate provenance');
}

// All motion follows the clip clock, so seeking and parallel rendering agree.
export function referenceEffectState(effect: ReferenceEffect, frame: number, fps: number) {
  const local = frame - effect.startFrame;
  const duration = effect.endFrame - effect.startFrame;
  const impact = effect.motion === 'stamp' || effect.kind === 'reaction-shock';
  const entry = Math.max(1, Math.min(Math.round(fps * (impact ? .08 : .25)), Math.floor(duration / 3)));
  const exit = Math.max(1, Math.min(Math.round(fps * .17), Math.floor(duration / 3)));
  const active = local >= 0 && local < duration;
  return {active, local, seconds: local / fps, fps, duration,
    opacity: active ? Math.min(smooth(local / entry), smooth((duration - 1 - local) / exit)) : 0,
    draw: smooth(local / Math.max(1, Math.min(fps * .48, duration / 2))),
    part: (delay: number, length = 6) => smooth((local - delay) / Math.max(1, length)),
  };
}

export function referenceAccentMotion(seconds: number, index = 0) {
  const t=Math.max(0,seconds);
  const pulse=(center:number,width:number)=>Math.exp(-(((t-center)/width)**2));
  const age=t-index*.15;
  const phase=age<0 ? 0 : age%1.6/1.6;
  return {
    angerScale:1+.19*pulse(.28,.13)+.14*pulse(.95,.17),
    steamY:phase*.28,
    steamOpacity:age<0 ? 0 : Math.sin(Math.PI*phase)*.78,
    steamBend:Math.sin(t*3.8+index)*.04,
    shockScale:1-Math.exp(-t*10)*Math.cos(t*15),
    burst:smooth(t/.12)*(1-smooth((t-.2)/.3)),
    stress:smooth((t-index*.13)/.55),
    stressY:.028*Math.sin(t*3+index),
    glintScale:.9+.12*Math.sin(t*3+index*.8),
    glintOpacity:.72+.28*Math.sin(t*2.5+index)**2,
  };
}

export function referenceTitleMotion(local: number, fps: number, duration: number, index = 0, count = 1, scroll = false) {
  // Reserve at least half of even a brief event for readable text.
  const unit = Math.min(fps, Math.max(1, duration * .48));
  const delay = (scroll ? .23 : .02) * unit + index / Math.max(1, count - 1) * unit * .24;
  const p = clamp01((local - delay) / (unit * .32));
  const ease = 1 - Math.pow(1 - p, 3);
  return {reveal: smooth(p), y: (1 - ease) * .16,
    scale: 1 + .075 * Math.sin(p * Math.PI) * (1 - p),
    open: smooth(local / (unit * .62))};
}

export function referenceEmotionMotion(seconds: number) {
  const t = Math.max(0, seconds);
  // Activity stays visible through a long worried beat, with a soft breathing
  // envelope instead of vibrating the entire icon or randomly teleporting it.
  const energy = smooth(t / .35) * (.72 + .28 * Math.sin(t * 2.2) ** 2);
  return {phase: t * 4.4, energy, tilt: Math.sin(t * 5.1) * 3.2 * energy,
    cloudScale: 1 - Math.exp(-t * 8) * Math.cos(t * 11)};
}

export function referenceSweatMotion(seconds: number, index: number) {
  const age = seconds - .28 - index * .34;
  if (age < 0) return {opacity: 0, y: 0, scaleX: 0, scaleY: 0};
  const phase = (age % 1.65) / 1.65;
  const form = smooth(phase / .18);
  const fall = smooth((phase - .22) / .67);
  return {opacity: form * (1 - smooth((phase - .69) / .29)), y: fall * .32,
    scaleX: form * (1 - fall * .15), scaleY: form * (1 + Math.sin(fall * Math.PI) * .3)};
}

export function referenceTextFit(text: string, width: number, height: number, requested = 100) {
  const lines = text.split('\n');
  const maxUnits = Math.max(1, ...lines.map(line => [...line].reduce((n, c) => n + (/[\x00-\x7f]/.test(c) ? .58 : 1), 0)));
  return {lines, size: Math.min(requested, width / maxUnits, height / (lines.length * 1.18))};
}

export function referencePageState(page: NonNullable<ReferenceEditorialProps['page']>, frame: number, fps: number) {
  const local = frame - page.startFrame;
  const duration = page.endFrame - page.startFrame;
  // Match the reference's scene transition: old scene darkens first; the entire
  // book scene then brightens together. Short clips reserve their latter half
  // for a readable hold rather than extending the shot.
  const darkFrames = Math.min(Math.round(fps * .2), Math.floor(duration * .15));
  const revealFrames = Math.max(1, Math.min(Math.round(fps * 14 / 30), Math.floor(duration * .35)));
  const active = local >= 0 && local < duration;
  return {active,
    blackOpacity: active ? (darkFrames > 0 ? smooth(local / darkFrames) : 1) : 0,
    opacity: active ? smooth((local - darkFrames) / revealFrames) : 0};
}

export function validateReferenceEditorialProps(props: ReferenceEditorialProps) {
  if (![props.width, props.height, props.fps, props.durationInFrames, props.shotDurationInFrames].every(v => Number.isFinite(v) && v > 0)
    || !Number.isInteger(props.durationInFrames) || !Number.isInteger(props.shotDurationInFrames)
    || !Number.isInteger(props.shotFrameOffset) || props.shotFrameOffset < 0
    || props.shotFrameOffset + props.durationInFrames > props.shotDurationInFrames) throw new Error('Reference overlay: invalid clip window');
  if (!props.camera || !['hold', 'push', 'pull', 'pan-left', 'pan-right'].includes(props.camera.mode)
    || ![props.camera.amount, props.camera.focusX, props.camera.focusY].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Reference overlay: invalid camera');
  const validWindow = (v: {startFrame: number; endFrame: number}) => Number.isInteger(v.startFrame) && Number.isInteger(v.endFrame)
    && v.startFrame >= 0 && v.endFrame > v.startFrame && v.endFrame <= props.durationInFrames;
  if (props.page && (!props.page.title?.trim() || !props.page.imageSrc?.trim() || !validWindow(props.page)
    || (props.page.fontSize !== undefined && (!Number.isFinite(props.page.fontSize) || props.page.fontSize <= 0)))) throw new Error('Reference overlay: invalid book page');
  let captionEnd = 0;
  for (const caption of props.captions ?? []) {
    if (!caption.text?.trim() || !validWindow(caption) || caption.startFrame < captionEnd) throw new Error('Reference overlay: invalid or overlapping caption');
    captionEnd = caption.endFrame;
  }
  const ids = new Set<string>();
  for (const e of props.effects) {
    if (!e.id || ids.has(e.id)) throw new Error('Reference overlay: unique effect IDs required');
    ids.add(e.id);
    if (!['title-scroll', 'title-ink', 'reaction-thought', 'reaction-confused', 'reaction-sweat', 'reaction-alert', 'reaction-anger', 'reaction-shock', 'reaction-gloom', 'reaction-idea', 'prop-ring', 'underline', 'connector', 'map-route'].includes(e.kind)
      || !['screen', 'image'].includes(e.space)) throw new Error('Reference overlay: invalid kind or space');
    if (![e.x, e.y, e.width, e.height].every(Number.isFinite) || e.x < 0 || e.y < 0 || e.width <= 0 || e.height <= 0
      || e.x + e.width > 1.000001 || e.y + e.height > 1.000001) throw new Error('Reference overlay: effect outside frame');
    if (!Number.isInteger(e.startFrame) || !Number.isInteger(e.endFrame) || e.startFrame < 0 || e.endFrame <= e.startFrame || e.endFrame > props.durationInFrames) throw new Error('Reference overlay: invalid effect window');
    if (e.kind.startsWith('title-') && !e.text?.trim()) throw new Error('Reference overlay: title text required');
    if (e.fontSize !== undefined && (!Number.isFinite(e.fontSize) || e.fontSize <= 0)) throw new Error('Reference overlay: invalid font size');
    if (e.font !== undefined && !['mashan', 'wenkai'].includes(e.font)) throw new Error('Reference overlay: invalid title font');
    if (e.motion !== undefined && !['brush', 'stamp'].includes(e.motion)) throw new Error('Reference overlay: invalid title motion');
    if (e.emphasisText !== undefined && (!e.emphasisText.trim() || !e.text?.replace(/\n/g,'').includes(e.emphasisText.replace(/\n/g,'')))) throw new Error('Reference overlay: emphasis must match title');
    if (e.kind === 'map-route') validateReferenceMapRoute(e,props.camera,props.fps);
  }
}
