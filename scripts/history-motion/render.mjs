#!/usr/bin/env node
import fs from 'node:fs';
import {release} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveMotionHardwareEncoding,motionHardwareRenderOptions,motionEncodingReport} from './encoding.mjs';
import {mapSceneAssetKey} from './scene-assets.mjs';
import {applyShotcraftDesign} from './shotcraft.mjs';
import {removeBundlePublicAlias,renderStaticImageTimeline,staticImageRenderSchedule} from './static-render.mjs';
import {assertMediaDiskSpace,watchMediaDiskSpace} from '../../backend/src/services/storage-space.ts';
import {createHistoryMotionRenderCacheGuard} from '../../backend/src/services/storage-render-cache.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireRemotion = createRequire(path.join(root, 'remotion/package.json'));
const save = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
const probe = filename => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], {encoding: 'utf8', timeout: 60_000}));
const normalizeText = text => String(text).normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const normalized = value => finite(value) && value >= 0 && value <= 1;
const color = value => typeof value === 'string' && /^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(value);
const assertion = (value, message) => {if (!value) throw Error(message);};
const maxEffectVolume = .18;

export async function fileSha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function localFile(filename, label) {
  assertion(nonempty(filename) && path.isAbsolute(filename), `${label} must be an absolute local file`);
  const real = fs.realpathSync(filename);
  assertion(fs.statSync(real).isFile() && fs.statSync(real).size > 0, `${label} is not a nonempty file`);
  return real;
}

function pointsValid(points, min) {
  return Array.isArray(points) && points.length >= min && points.length <= 2048
    && points.every(p => Array.isArray(p) && p.length === 2 && p.every(normalized));
}

export function validateMap(map, duration) {
  const p = map?.provenance;
  assertion(map?.enabled === true && nonempty(map.backgroundSrc), 'Map requires an explicit local background');
  assertion(p?.verified === true && ['illustrative', 'sourced'].includes(p.historyStatus)
    && [p.source, p.license, p.projection, p.attribution].every(nonempty), 'Map requires verified source, license, projection, historical status and attribution');
  assertion(Number.isInteger(map.width) && map.width > 0 && Number.isInteger(map.height) && map.height > 0,
    'Map requires its original pixel dimensions to preserve projected coordinates');
  assertion(!map.territories || Array.isArray(map.territories), 'Invalid map territories');
  assertion(!map.routes || Array.isArray(map.routes), 'Invalid map routes');
  assertion(!map.cities || Array.isArray(map.cities), 'Invalid map cities');
  if (map.cartography !== undefined) assertion(map.cartography?.version === 1
    && map.cartography.style === 'relief-atlas', 'Invalid map cartography version');
  if (map.geographicLabels !== undefined) {
    assertion(Array.isArray(map.geographicLabels) && map.geographicLabels.length <= 80, 'Too many geographic labels');
    const ids = new Set();
    for (const label of map.geographicLabels) {
      assertion(nonempty(label.id) && !ids.has(label.id) && nonempty(label.text) && label.text.length <= 60
        && ['mountain','river','region','lake'].includes(label.kind) && normalized(label.x) && normalized(label.y)
        && (label.angle === undefined || finite(label.angle) && Math.abs(label.angle) <= 180)
        && (label.waterwayId === undefined || label.kind === 'river' && nonempty(label.waterwayId) && map.waterways?.some(river => river.id === label.waterwayId))
        && (label.priority === undefined || finite(label.priority) && label.priority >= 0), 'Invalid geographic label');
      ids.add(label.id);
    }
  }
  if (map.waterways !== undefined) {
    assertion(Array.isArray(map.waterways) && map.waterways.length <= 1200, 'Too many map waterways');
    const ids = new Set();
    for (const river of map.waterways) {
      assertion(nonempty(river.id) && !ids.has(river.id) && pointsValid(river.points, 2)
        && (river.name === undefined || nonempty(river.name) && river.name.length <= 80)
        && (river.rank === undefined || [1,2,3].includes(river.rank)), 'Invalid map waterway');
      ids.add(river.id);
    }
  }
  if (map.waterAreas !== undefined) {
    assertion(Array.isArray(map.waterAreas) && map.waterAreas.length <= 200, 'Too many map water areas');
    const ids = new Set();
    for (const area of map.waterAreas) {
      assertion(nonempty(area.id) && !ids.has(area.id) && ['ocean','lake'].includes(area.kind)
        && Array.isArray(area.rings) && area.rings.length > 0 && area.rings.length <= 100
        && area.rings.every(ring => pointsValid(ring, 3)), 'Invalid map water area');
      ids.add(area.id);
    }
  }
  for (const territory of map.territories ?? []) {
    assertion(nonempty(territory.name) && color(territory.color) && pointsValid(territory.points, 3), 'Invalid map territory');
    assertion(!territory.initialPoints || (pointsValid(territory.initialPoints, 3) && territory.initialPoints.length === territory.points.length), 'Territory morph needs matching vertex counts');
    const start = territory.from ?? 0, end = territory.to ?? Math.min(1,duration);
    assertion(finite(start) && start >= 0 && end > start && end <= duration, 'Invalid territory timing');
  }
  for (const route of map.routes ?? []) {
    const start = route.start ?? 0, end = route.end ?? Math.min(1,duration);
    assertion(color(route.color) && pointsValid(route.points, 2)
      && finite(start) && start >= 0 && end > start && end <= duration,
    'Invalid map route geometry or timing');
    assertion(route.points.some(p => p[0] !== route.points[0][0] || p[1] !== route.points[0][1]), 'Map route cannot collapse to a point');
  }
  for (const city of map.cities ?? []) {
    assertion(nonempty(city.name) && normalized(city.x) && normalized(city.y), 'Invalid map city');
    assertion(city.color === undefined || color(city.color), 'Invalid map city color');
    assertion(city.kind === undefined || ['capital','city','pass','battlefield'].includes(city.kind), 'Invalid map city kind');
    if (city.highlightStart !== undefined) assertion(finite(city.highlightStart) && city.highlightStart >= 0
      && positive(city.highlightDuration ?? 1.2) && city.highlightStart + (city.highlightDuration ?? 1.2) <= duration, 'Invalid city highlight timing');
  }
  if (map.forces !== undefined) {
    assertion(Array.isArray(map.forces) && map.forces.length <= 8, 'Invalid map forces');
    const ids = new Set();
    for (const force of map.forces) {
      assertion(nonempty(force.id) && !ids.has(force.id) && nonempty(force.faction)
        && nonempty(force.flagText) && [...force.flagText].length <= 3 && color(force.color)
        && ['hold','march','attack','occupy','retreat'].includes(force.action)
        && (force.commander === undefined || nonempty(force.commander))
        && (force.troopKind === undefined || ['infantry','cavalry'].includes(force.troopKind)), 'Invalid map force identity');
      ids.add(force.id);
      const city = map.cities?.find(city => city.name === force.city);
      assertion(city, 'Map force requires a known city');
      assertion(finite(force.start) && force.start >= 0 && finite(force.end)
        && force.end > force.start && force.end <= duration, 'Invalid map force timing');
      assertion(!['march','retreat'].includes(force.action) || force.routeIndex !== undefined, 'Moving force requires a route');
      if (force.routeIndex !== undefined) {
        assertion(Number.isInteger(force.routeIndex) && force.routeIndex >= 0 && map.routes?.[force.routeIndex], 'Invalid map force route');
        const route = map.routes[force.routeIndex], destination = route.points.at(-1);
        assertion(Math.hypot(destination[0]-city.x,destination[1]-city.y) < .001, 'Map force route must end at its city');
        assertion(Math.abs(route.start-force.start) < .001 && Math.abs(route.end-force.end) < .001, 'Map force and route timing must agree');
      }
      assertion(force.portraitSrc === undefined || nonempty(force.portraitSrc), 'Invalid map portrait');
      assertion(force.portraitSha256 === undefined || /^[a-f\d]{64}$/i.test(force.portraitSha256), 'Invalid map portrait fingerprint');
    }
  }
  if (map.camera !== undefined) {
    const keys=map.camera?.keyframes;
    assertion(Array.isArray(keys) && keys.length>=2 && keys.length<=20 && keys[0].t===0, 'Map camera requires keyframes starting at zero');
    let previous=-1;
    for (const key of keys) {
      assertion(finite(key.t) && key.t>previous && key.t<=duration && normalized(key.focusX) && normalized(key.focusY)
        && finite(key.zoom) && key.zoom>=1 && key.zoom<=2.2, 'Invalid map camera keyframe');
      previous=key.t;
    }
  }
  if (map.stages !== undefined) {
    assertion(Array.isArray(map.stages) && map.stages.length<=12, 'Invalid map stages');
    let previous=0;
    for (const stage of map.stages) {
      assertion(nonempty(stage.label) && finite(stage.start) && stage.start>=previous
        && finite(stage.end) && stage.end>stage.start && stage.end<=duration, 'Invalid map stage timing');
      previous=stage.end;
    }
  }
  if (map.legend !== undefined) {
    assertion(Array.isArray(map.legend) && map.legend.length<=8 && map.legend.every(item=>nonempty(item.label)
      && color(item.color) && (item.kind===undefined || ['line','area','point'].includes(item.kind))), 'Invalid map legend');
  }
  if (map.encirclement !== undefined) {
    const e=map.encirclement;
    assertion(pointsValid([e?.center],1) && positive(e.radiusX) && positive(e.radiusY)
      && e.center[0]-e.radiusX>=0 && e.center[0]+e.radiusX<=1
      && e.center[1]-e.radiusY>=0 && e.center[1]+e.radiusY<=1
      && color(e.color) && color(e.fillColor) && nonempty(e.label), 'Invalid map encirclement geometry');
    assertion(p.historyStatus==='illustrative' && /示意/.test(e.label), 'Conceptual encirclement must be labelled as illustrative');
    assertion(finite(e.start) && e.start>=0 && finite(e.end) && e.end>e.start && e.end<=duration, 'Invalid encirclement timing');
    if (e.compressionStart!==undefined || e.compressionEnd!==undefined || e.innerScale!==undefined)
      assertion(finite(e.compressionStart) && e.compressionStart>=e.end && finite(e.compressionEnd)
        && e.compressionEnd>e.compressionStart && e.compressionEnd<=duration
        && positive(e.innerScale) && e.innerScale<1, 'Invalid encirclement compression');
  }
}

function validateMotion(motion) {
  if (!motion) return;
  assertion(['static','kenburns','pan','keyframes'].includes(motion.kind), 'Invalid motion kind');
  if (motion.durationScale !== undefined) assertion(positive(motion.durationScale) && motion.durationScale <= 1, 'Invalid motion duration scale');
  if (motion.kind === 'static') return;
  const keys = motion.keyframes;
  assertion(Array.isArray(keys) && keys.length >= 2 && keys.length <= 20 && keys[0].t === 0 && keys.at(-1).t === 1, 'Motion requires ordered keyframes from 0 to 1');
  let previous = -1;
  for (const key of keys) {
    assertion(normalized(key.t) && key.t > previous && normalized(key.focusX) && normalized(key.focusY)
      && finite(key.zoom) && key.zoom >= 1 && key.zoom <= 2.2, 'Invalid motion keyframe');
    assertion(key.easing === undefined || ['linear','ease-in','ease-out','ease-in-out'].includes(key.easing), 'Invalid motion easing');
    assertion(key.transition === undefined || key.transition === 'smooth', 'This renderer supports smooth camera keyframes; split cuts into shots');
    previous = key.t;
  }
}

export function validateGraphic(graphic) {
  assertion(graphic && ['timeline','comparison','relationship','quote'].includes(graphic.kind)
    && nonempty(graphic.title) && Array.isArray(graphic.items) && graphic.items.length > 0,
  'Graphic requires a supported kind, title and nonempty items');
  for (const item of graphic.items) assertion(item && nonempty(item.label)
    && (item.detail === undefined || typeof item.detail === 'string')
    && (item.value === undefined || typeof item.value === 'string'), 'Invalid graphic item');
}

export function visualTypeForShot(shot) {
  if (shot.visualType && shot.visualType !== 'auto') {
    assertion(['map','image','video','graphic'].includes(shot.visualType), `Shot ${shot.shotId} has an invalid visualType`);
    return shot.visualType;
  }
  return shot.map?.enabled ? 'map' : shot.imagePath ? 'image' : shot.sourcePath ? 'video' : 'graphic';
}

function renderedGraphic(shot) {
  // A graphic is an explanation layer. It may sit over a video, image or map;
  // only a shot without any underlying visual remains a full-frame graphic.
  return shot.graphic;
}

export function buildCaptions(plan) {
  if (plan.captions !== undefined) return plan.captions;
  const lineLength = plan.width < plan.height ? 16 : 28;
  return plan.shots.flatMap(shot => {
    const chars = [...(shot.narration || '')];
    const chunks = [];
    for (let start = 0; start < chars.length; start += lineLength) {
      const end = Math.min(chars.length, start + lineLength);
      chunks.push({text: chars.slice(start,end).join(''),
        startFrame: shot.startFrame + Math.round(start / chars.length * shot.frames),
        endFrame: shot.startFrame + Math.round(end / chars.length * shot.frames),
        timingEvidence: 'Character-proportional estimate within the narration shot; not word-level alignment'});
    }
    return chunks;
  });
}

export function validatePlan(plan) {
  assertion(plan && [[1920,1080],[1080,1920]].some(([w,h]) => plan.width === w && plan.height === h)
    && plan.fps === 30, 'Expected a 1920×1080 or 1080×1920 profile at 30 fps');
  assertion(Number.isInteger(plan.durationInFrames) && plan.durationInFrames > 0, 'Invalid total frames');
  assertion(Array.isArray(plan.shots) && plan.shots.length > 0 && plan.shots.length <= 1000, 'Plan requires shots');
  assertion(nonempty(plan.audioPath), 'Plan requires frozen narration audioPath');
  let cursor = 0;
  const ids = new Set();
  for (const shot of plan.shots) {
    assertion(nonempty(shot.shotId) && !ids.has(shot.shotId), 'Shot IDs must be unique');
    assertion(shot.startFrame === cursor && Number.isInteger(shot.frames) && shot.frames > 0, 'Shot timeline must tile without gaps or overlaps');
    ids.add(shot.shotId); cursor += shot.frames;
    assertion(shot.sourceNote === undefined || nonempty(shot.sourceNote) && shot.sourceNote.length <= 100, 'Invalid shot source note');
    validateMotion(shot.motion);
    const duration = shot.frames / plan.fps;
    const visualType = visualTypeForShot(shot), graphic = renderedGraphic(shot);
    if (graphic !== undefined) validateGraphic(graphic);
    if (visualType === 'map') validateMap(shot.map, duration);
    else if (visualType === 'image') assertion(nonempty(shot.imagePath), `Shot ${shot.shotId} needs a local imagePath`);
    else if (visualType === 'video') {
      assertion(nonempty(shot.sourcePath), `Shot ${shot.shotId} needs local footage`);
      assertion(finite(shot.inPoint ?? 0) && (shot.inPoint ?? 0) >= 0 && positive(shot.outPoint)
        && shot.outPoint > (shot.inPoint ?? 0), `Shot ${shot.shotId} has an invalid source range`);
      const availableFrames = Math.floor((shot.outPoint - (shot.inPoint ?? 0)) * plan.fps + .00001);
      assertion(availableFrames > 0, `Shot ${shot.shotId} source range contains no complete frame`);
      assertion(availableFrames >= shot.frames || shot.shortfallPolicy === 'freeze', `Shot ${shot.shotId} source range is too short; an explicit freeze policy is required`);
    } else assertion(graphic, `Shot ${shot.shotId} needs local footage, an image, a verified map or a graphic`);
    assertion(!shot.crop || ['center','cover','contain','left','right'].includes(shot.crop), 'Invalid crop');
    assertion(!shot.titles || Array.isArray(shot.titles), 'Invalid titles');
    for (const title of shot.titles ?? []) {
      assertion(nonempty(title.text) && title.text.length <= 80 && finite(title.start) && title.start >= 0
        && positive(title.duration) && title.start+title.duration <= duration+.00001, 'Title must fit inside its shot');
      assertion(Math.round((title.start+title.duration)*plan.fps)>Math.round(title.start*plan.fps), 'Title requires at least one frame');
      assertion(!title.motion || ['brush','stamp'].includes(title.motion), 'Invalid title motion');
      assertion(!title.emphasis || title.text.includes(title.emphasis), 'Emphasis must occur in the title');
      const x = title.x ?? .08, y = title.y ?? (visualType === 'map' ? .65 : graphic ? .04 : .15), w = title.width ?? .84, h = title.height ?? (graphic ? .1 : .16);
      assertion([x,y,w,h].every(normalized) && w>0 && h>0 && x+w<=1.00001 && y+h<=1.00001, 'Title is outside the canvas');
    }
  }
  assertion(cursor === plan.durationInFrames, 'Shot frames do not match the total duration');
  assertion(plan.soundEffects === undefined || Array.isArray(plan.soundEffects), 'Invalid soundEffects');
  for (const [index, effect] of (plan.soundEffects ?? []).entries()) {
    assertion(effect && nonempty(effect.sourcePath) && Number.isInteger(effect.startFrame) && effect.startFrame >= 0
      && effect.startFrame < cursor && Number.isInteger(effect.frames) && effect.frames > 0
      && (effect.volume === undefined || finite(effect.volume)) && (effect.volume ?? .14) >= 0,
    `Sound effect ${index + 1} requires a local source, frame timing and nonnegative volume`);
  }
  const captions = buildCaptions(plan);
  assertion(Array.isArray(captions), 'Invalid captions');
  let previous = 0;
  for (const caption of captions) {
    assertion(nonempty(caption.text) && Number.isInteger(caption.startFrame) && Number.isInteger(caption.endFrame)
      && caption.startFrame >= previous && caption.endFrame > caption.startFrame && caption.endFrame <= cursor, 'Invalid or overlapping caption');
    previous = caption.endFrame;
  }
  const narration = plan.shots.map(shot => shot.narration || '').join('');
  if (narration) assertion(normalizeText(captions.map(c => c.text).join('')) === normalizeText(narration), 'Captions must preserve the complete shot narration');
  return {frames: cursor, captions};
}

function safeExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  assertion(/^\.[a-z0-9]{1,8}$/.test(ext), 'Media file needs a conventional extension');
  return ext;
}

export async function freezePlan(plan, publicDir, {checkDiskSpace}={}) {
  const checked = validatePlan(plan), assets = [], staged = new Map();
  fs.mkdirSync(path.join(publicDir,'assets'), {recursive:true});
  fs.mkdirSync(path.join(publicDir,'fonts'), {recursive:true});
  async function freeze(source, label, expectedHash) {
    const real = localFile(source,label);
    const existing = staged.get(real);
    if (existing) {
      assertion(!expectedHash || expectedHash === existing.sha256, `${label} fingerprint changed`);
      return existing;
    }
    const name = `${String(assets.length+1).padStart(4,'0')}${safeExtension(real)}`;
    const target = path.join(publicDir,'assets',name);
    await checkDiskSpace?.(publicDir,fs.statSync(real).size);
    fs.copyFileSync(real,target,fs.constants.COPYFILE_FICLONE);
    const sha256 = await fileSha256(target);
    assertion(!expectedHash || expectedHash === sha256, `${label} fingerprint changed`);
    const record = {source:real,path:`assets/${name}`,sha256,bytes:fs.statSync(target).size};
    staged.set(real,record); assets.push(record);
    return record;
  }
  const audio = await freeze(plan.audioPath,'Narration',plan.audioSha256);
  const audioInfo = probe(path.join(publicDir,audio.path));
  assertion(audioInfo.streams.filter(s=>s.codec_type==='audio').length === 1, 'Narration must have one audio stream');
  assertion(Math.abs(Number(audioInfo.format.duration)-checked.frames/plan.fps) <= .12, 'Narration duration does not match the planned timeline');
  const shots = [], images = [], graphics = [], soundEffects = [], soundEffectSources = [];
  const usedSceneAssets = new Map();
  function uniqueSceneAsset(asset, shot, key=asset.sha256) {
    if (!plan.uniqueSceneAssets) return;
    const previous=usedSceneAssets.get(key);
    assertion(!previous, `Shot ${shot.shotId} repeats the scene asset already used by ${previous}`);
    usedSceneAssets.set(key,shot.shotId);
  }
  for (const original of plan.shots) {
    const visualType = visualTypeForShot(original);
    const shot = {...original,visualType,graphic:renderedGraphic(original),
      sourcePath:visualType === 'video' ? original.sourcePath : undefined,
      imagePath:visualType === 'image' ? original.imagePath : undefined,
      map:visualType === 'map' ? original.map : undefined};
    if (plan.companionGraphicsOnly) assertion(visualType !== 'graphic', `Shot ${shot.shotId} needs underlying footage or an image for its explanation`);
    if (shot.graphic) graphics.push({shotId:shot.shotId,startFrame:shot.startFrame,frames:shot.frames,...shot.graphic});
    if (shot.map?.enabled) {
      assertion(/\.(png|jpe?g|webp|avif)$/i.test(shot.map.backgroundSrc), `Map ${shot.shotId} background must be a supported raster image`);
      const background = await freeze(shot.map.backgroundSrc,`Map ${shot.shotId}`,shot.map.backgroundSha256);
      const assetKey=mapSceneAssetKey(background.sha256,shot.map);
      uniqueSceneAsset(background,shot,assetKey);
      const info = probe(path.join(publicDir,background.path));
      const picture = info.streams.find(s=>s.codec_type==='video');
      assertion(picture?.width === shot.map.width && picture?.height === shot.map.height, `Map ${shot.shotId} dimensions differ from its coordinate canvas`);
      const forces = [];
      for (const force of shot.map.forces || []) {
        if (!force.portraitSrc) {forces.push(force);continue;}
        assertion(/\.(png|jpe?g|webp|avif)$/i.test(force.portraitSrc), `Map ${shot.shotId} portrait must be a supported raster image`);
        const portrait = await freeze(force.portraitSrc,`Map ${shot.shotId} portrait ${force.commander || force.id}`,force.portraitSha256);
        const picture = probe(path.join(publicDir,portrait.path)).streams.find(s=>s.codec_type==='video');
        assertion(picture?.width > 0 && picture?.height > 0 && !(Number(picture.nb_frames) > 1), 'Map portrait must be a readable static image');
        forces.push({...force,portraitSrc:portrait.path,portraitSha256:portrait.sha256});
      }
      shots.push({...shot,assetKey,visualType:'map',sourcePath:undefined,imagePath:undefined,map:{...shot.map,backgroundSha256:background.sha256,backgroundSrc:background.path,...(shot.map.forces ? {forces} : {})}});
    } else if (shot.imagePath) {
      assertion(/\.(png|jpe?g|webp|avif)$/i.test(shot.imagePath), `Image ${shot.shotId} must be a supported raster image`);
      const image = await freeze(shot.imagePath,`Image ${shot.shotId}`,shot.imageSha256);
      uniqueSceneAsset(image,shot);
      const info = probe(path.join(publicDir,image.path));
      const picture = info.streams.find(s=>s.codec_type==='video');
      assertion(picture?.width > 0 && picture?.height > 0 && !(Number(picture.nb_frames) > 1), `Image ${shot.shotId} must be a readable static image`);
      images.push({shotId:shot.shotId,startFrame:shot.startFrame,frames:shot.frames,...image,width:picture.width,height:picture.height,motion:shot.motion ?? {kind:'static'}});
      shots.push({...shot,visualType:'image',sourcePath:undefined,imagePath:image.path,imageSha256:image.sha256});
    } else if (shot.sourcePath) {
      const source = await freeze(shot.sourcePath,`Shot ${shot.shotId}`,shot.assetSha256);
      uniqueSceneAsset(source,shot);
      const info = probe(path.join(publicDir,source.path));
      const video = info.streams.find(s=>s.codec_type==='video');
      const duration = Number(video?.duration || info.format.duration);
      assertion(video && duration>0 && shot.outPoint <= duration+.001, `Shot ${shot.shotId} source range exceeds the actual media duration`);
      const sourceFrames = Math.min(shot.frames,Math.floor((shot.outPoint-(shot.inPoint||0))*plan.fps+.00001));
      // A small, silent-footage speed adjustment fills modest shortages before
      // resorting to a hold. Never loop a clip or slow it below 0.8x.
      const playbackRate = Math.max(.8,Math.min(1,sourceFrames/shot.frames));
      // Round down: the final fractional sample can otherwise decode the frame
      // at outPoint, outside the selected range, and freeze that adjacent scene.
      const playableFrames = Math.min(shot.frames,Math.floor(sourceFrames/playbackRate+.00001));
      shots.push({...shot,visualType:'video',sourcePath:source.path,sourceFrames,playbackRate,playableFrames});
    } else shots.push({...shot,visualType:'graphic'});
  }
  for (const [index,effect] of (plan.soundEffects ?? []).entries()) {
    const source = await freeze(effect.sourcePath,`Sound effect ${index + 1}`,effect.sha256);
    const info = probe(path.join(publicDir,source.path));
    const stream = info.streams.find(s=>s.codec_type==='audio');
    const duration = Number(stream?.duration || info.format.duration);
    assertion(stream && Number.isFinite(duration) && duration > 0, `Sound effect ${index + 1} must contain readable audio`);
    const frames = Math.min(effect.frames,checked.frames-effect.startFrame,Math.floor(duration*plan.fps+.00001));
    assertion(frames > 0, `Sound effect ${index + 1} contains no complete frame`);
    const requestedVolume = effect.volume ?? .14;
    const volume = Math.min(requestedVolume,maxEffectVolume);
    soundEffects.push({sourcePath:source.path,sha256:source.sha256,sourceName:effect.sourceName,startFrame:effect.startFrame,frames,volume});
    soundEffectSources.push({index,...source,sourceName:effect.sourceName,startFrame:effect.startFrame,requestedFrames:effect.frames,frames,
      requestedVolume,volume,duration});
  }
  for (const name of ['MaShanZheng-Regular.ttf','LXGWWenKaiScreen.ttf']) {
    const font = path.join(root,'remotion/public/fonts',name);
    fs.copyFileSync(font,path.join(publicDir,'fonts',name));
    assets.push({source:font,path:`fonts/${name}`,sha256:await fileSha256(font),bytes:fs.statSync(font).size});
  }
  const props = {width:plan.width,height:plan.height,fps:plan.fps,durationInFrames:checked.frames,
    audioSrc:audio.path,shots,captions:checked.captions,soundEffects};
  return {props,assets,images,graphics,soundEffects:soundEffectSources,audioCodec:audioInfo.streams.find(s=>s.codec_type==='audio').codec_name};
}

export function validateOutput(metadata, bytes, plan, encoding, {requireHardware=true}={}) {
  const video = metadata.streams.find(s=>s.codec_type==='video');
  assertion(video?.codec_name === 'h264' && video?.pix_fmt === 'yuv420p' && video.width===plan.width && video.height===plan.height
    && video.r_frame_rate==='30/1' && Number(video.nb_frames)===plan.durationInFrames, 'Rendered video codec, dimensions, fps or frame count mismatch');
  const audio = metadata.streams.filter(s=>s.codec_type==='audio');
  assertion(audio.length===1 && audio[0].codec_name==='aac', 'Rendered output requires one AAC audio track');
  assertion(Math.abs(Number(metadata.format.duration)-plan.durationInFrames/plan.fps) <= .12, 'Rendered audio/video duration mismatch');
  const budget = motionEncodingReport(metadata,bytes,encoding,{requireHardware});
  assertion(budget.status==='within-budget', 'Rendered output exceeds the upload filesize budget');
  return budget;
}

export async function cleanupHistoryMotionRenderCache(output, {retainCache=false,referenceOptions}={}) {
  const outputPath=path.resolve(output),work=outputPath+'.render',publicDir=path.join(work,'public'),bundleDir=path.join(work,'bundle');
  const result={status:'retained',checkedAt:new Date().toISOString(),checkedAssets:0,removedDirectories:[],logicalBytesRemoved:0};
  let report,recordable=false,deleting=false,referenceGuard;
  const within=(directory,filename)=>filename===directory || filename.startsWith(directory+path.sep);
  const filesUnder=directory=>{
    if(!fs.existsSync(directory))return [];
    assertion(fs.lstatSync(directory).isDirectory(), 'Cache directory is a symbolic link or is not a directory');
    return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
      const filename=path.join(directory,entry.name);
      if(entry.isDirectory())return filesUnder(filename);
      assertion(entry.isFile(), 'Cache contains a symbolic link or a special file');
      return [filename];
    });
  };
  try {
    assertion(!fs.existsSync(outputPath+'.lock') && !fs.existsSync(outputPath+'.partial.mp4'), 'Render is still active or incomplete');
    assertion(fs.realpathSync(work)===work, 'Render work directory is not a canonical local directory');
    report=JSON.parse(fs.readFileSync(outputPath+'.json','utf8'));
    const delivery=JSON.parse(fs.readFileSync(path.join(work,'delivery.json'),'utf8'));
    assertion(report.status==='completed' && report.qa?.technical==='passed' && report.output===outputPath
      && delivery.status==='completed' && delivery.sha256===report.sha256, 'Completed delivery evidence is missing');
    assertion(await fileSha256(outputPath)===report.sha256, 'Completed movie fingerprint changed');
    const stem=path.basename(outputPath,path.extname(outputPath));
    for(const filename of [report.preview,path.join(path.dirname(outputPath),`${stem}-review.html`),
      path.join(work,'plan.json'),path.join(work,'props.json')])localFile(filename,'Completed render artifact');
    assertion(filesUnder(path.join(work,'samples')).length>0, 'Completed render samples are missing');
    const assets=JSON.parse(fs.readFileSync(path.join(work,'assets.json'),'utf8'));
    assertion(Array.isArray(assets) && assets.length && JSON.stringify(assets)===JSON.stringify(report.assets)
      && JSON.stringify(assets)===JSON.stringify(delivery.assets), 'Frozen asset evidence does not match the delivery');
    recordable=true;
    if(retainCache)result.reason='Render cache retained for debugging';
    else {
      const known=new Set();
      for(const asset of assets) {
        assertion(/^(assets|fonts)\/[a-z\d._-]+$/i.test(asset.path) && /^[a-f\d]{64}$/i.test(asset.sha256), 'Invalid frozen asset evidence');
        known.add(asset.path);
        const source=localFile(asset.source,'Original asset');
        assertion(!within(publicDir,source) && !within(bundleDir,source), 'Original asset is inside the cache');
        assertion(await fileSha256(source)===asset.sha256, `Original asset changed: ${asset.source}`);
        for(const directory of [publicDir,path.join(bundleDir,'public')]) {
          const copy=path.join(directory,asset.path);
          if(!fs.existsSync(copy))continue;
          assertion(fs.realpathSync(copy)===copy && await fileSha256(copy)===asset.sha256, `Frozen copy changed: ${copy}`);
        }
        result.checkedAssets++;
      }
      const publicAssets=path.join(publicDir,'assets'),publicFiles=filesUnder(publicAssets),bundleFiles=filesUnder(bundleDir);
      for(const filename of publicFiles)assertion(known.has(path.relative(publicDir,filename)), 'Frozen assets contain an unrecorded file');
      for(const filename of bundleFiles) {
        const relative=path.relative(bundleDir,filename);
        assertion(relative.startsWith('public'+path.sep) ? known.has(relative.slice(7))
          : /^(?:(?:\d+\.)?bundle\.js(?:\.map)?|index\.html|favicon\.ico)$/.test(relative), 'Bundle contains an unrecorded file');
      }
      referenceGuard=createHistoryMotionRenderCacheGuard(outputPath,[...bundleFiles,...publicFiles],referenceOptions);
      referenceGuard.withCleanupLock(()=>{
        if(fs.existsSync(outputPath+'.lock') || fs.existsSync(outputPath+'.partial.mp4')){recordable=false;throw Error('Render became active before cache cleanup');}
        deleting=true;
        // Both trees are disposable only after every frozen input has an intact
        // original outside them. Keep public/fonts and all manifests/evidence.
        for(const [directory,files] of [[bundleDir,bundleFiles],[publicAssets,publicFiles]]) {
          if(!fs.existsSync(directory))continue;
          referenceGuard.assertUnreferenced();
          if(fs.existsSync(outputPath+'.lock') || fs.existsSync(outputPath+'.partial.mp4')){recordable=false;throw Error('Render became active before cache cleanup');}
          const bytes=files.reduce((total,filename)=>total+fs.statSync(filename).size,0);
          fs.rmSync(directory,{recursive:true});
          result.removedDirectories.push(directory);result.logicalBytesRemoved+=bytes;
        }
      });
      result.status='completed';
    }
  } catch(error) {result.status=deleting?'failed':'retained';result.reason=error.message;}
  finally {referenceGuard?.close();}
  if(recordable) {
    report.cacheCleanup=result;
    try {
      save(path.join(work,'cache-cleanup.json'),result);
      save(path.join(work,'delivery.json'),report);save(outputPath+'.json',report);
    } catch(error) {
      result.recordError=error.message;
      console.warn(`[history-motion] Cache cleanup record could not be saved: ${error.message}`);
    }
  }
  return result;
}

function reviewHtml(movie, preview, report) {
  const esc = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>历史精细化制作回看</title><style>body{background:#171916;color:#eee;font:18px system-ui;margin:40px auto;max-width:1100px}video{width:100%;max-height:70vh}a{color:#f0cf87}p{line-height:1.7}</style><h1>历史精细化制作回看</h1><p>制作完成，技术检查已通过，可直接交付。预览保留声音；人工画面与听审尚未进行，不影响交付。</p><video controls src="${esc(preview)}"></video><p><a href="${esc(movie)}">打开完整视频</a> · ${report.width}×${report.height} · ${report.duration.toFixed(2)} 秒</p><p>字幕时间：${report.captionTiming==='provided'?'使用计划提供的时间':'镜头内按字数估算，尚未逐字校准'}</p><p>本页和抽帧不构成人工审美或听审通过记录。</p></html>`;
}

export async function renderHistoryMotion({plan:planFilename,output,concurrency=2,onProgress,resume=false,retainCache=false,engine='auto'}={},dependencies={}) {
  const startedAt=Date.now();
  assertion(nonempty(planFilename)&&nonempty(output),'Required: --plan plan.json --output movie.mp4');
  assertion(['auto','remotion'].includes(engine),'Render engine must be auto or remotion');
  const planPath=path.resolve(planFilename), outputPath=path.resolve(output);
  const plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
  validatePlan(plan);
  const encoding=resolveMotionHardwareEncoding(plan.uploadEncoding);
  const performance={assetFreezeMs:null,bundleMs:null,compositionMs:null,renderMediaMs:null,publicAssetCopyBytesAvoided:0,
    frameRenderingMs:null,encodingAndMuxingMs:null,finalizeMs:null,totalMs:null,
    timingNotes:'Frame rendering and encoding overlap. frameRenderingMs is elapsed from renderMedia start to the last frame callback. encodingAndMuxingMs is the Remotion final stitch timer, not isolated encoder CPU time.'};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  assertion(!fs.existsSync(outputPath),'Refuse to overwrite an existing movie');
  const checkDiskSpace=dependencies.checkDiskSpace || assertMediaDiskSpace;
  await checkDiskSpace(path.dirname(outputPath),512*1024**2);
  const lock=outputPath+'.lock',lockHandle=fs.openSync(lock,'wx');
  const work=outputPath+'.render',publicDir=path.join(work,'public');
  const partial=outputPath+'.partial.mp4';
  let report;
  try {
    const resumeExisting=resume===true || resume==='true';
    if(resumeExisting) {
      assertion(fs.existsSync(partial) && fs.existsSync(path.join(work,'plan.json')), 'No rendered file is available to finalize');
      assertion(JSON.stringify(JSON.parse(fs.readFileSync(path.join(work,'plan.json'),'utf8')))===JSON.stringify(plan), 'Cannot finalize a render from a different plan');
    } else {
      assertion(!fs.existsSync(work)&&!fs.existsSync(partial),'Use a new output path for each render attempt');
      fs.mkdirSync(work,{recursive:true});
      save(path.join(work,'plan.json'),plan);
    }
    const freezeStartedAt=Date.now();
    const designFile=path.join(work,'shotcraft-plan.json');
    let designedPlan=plan;
    if(resumeExisting && fs.existsSync(designFile)) {
      const savedDesign=JSON.parse(fs.readFileSync(designFile,'utf8'));
      assertion(savedDesign.sourcePlanSha256===await fileSha256(planPath),'Cannot finalize a design from a different plan');
      designedPlan=savedDesign.plan;
    } else if(!resumeExisting) {
      designedPlan=applyShotcraftDesign(plan);
      save(designFile,{sourcePlanSha256:await fileSha256(planPath),plan:designedPlan});
    }
    const frozen=await freezePlan(designedPlan,publicDir,{checkDiskSpace});
    save(path.join(work,'props.json'),frozen.props);save(path.join(work,'assets.json'),frozen.assets);
    performance.assetFreezeMs=Date.now()-freezeStartedAt;
    if(!resumeExisting) {
      const {bundle}=dependencies.bundler || await import(requireRemotion.resolve('@remotion/bundler'));
      const renderer=dependencies.renderer || await import(requireRemotion.resolve('@remotion/renderer'));
      const {selectComposition,renderMedia,makeCancelSignal}=renderer;
      const browserExecutable=dependencies.browserExecutable || process.env.REMOTION_BROWSER_EXECUTABLE||path.join(root,'.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
      assertion(fs.existsSync(browserExecutable),'Configured Remotion browser does not exist');
      await checkDiskSpace(path.dirname(outputPath),512*1024**2);
      const bundleStartedAt=Date.now();
      const serveUrl=await bundle({entryPoint:path.join(root,'remotion/src/history-motion-factory-entry.tsx'),rootDir:path.join(root,'remotion'),
        publicDir,outDir:path.join(work,'bundle'),symlinkPublicDir:true});
      performance.bundleMs=Date.now()-bundleStartedAt;
      const bundlePublic=path.join(work,'bundle/public');
      if(fs.existsSync(bundlePublic) && fs.lstatSync(bundlePublic).isSymbolicLink()) {
        performance.publicAssetCopyBytesAvoided=frozen.assets.reduce((sum,asset)=>sum+asset.bytes,0);
      }
      const compositionStartedAt=Date.now();
      const composition=await selectComposition({serveUrl,id:'HistoryMotionFactory',inputProps:frozen.props,browserExecutable});
      performance.compositionMs=Date.now()-compositionStartedAt;
      await checkDiskSpace(path.dirname(outputPath),512*1024**2);
      const {cancelSignal,cancel}=makeCancelSignal();
      const diskWatcher=watchMediaDiskSpace(path.dirname(outputPath),{check:checkDiskSpace,intervalMs:dependencies.diskCheckIntervalMs});
      diskWatcher.signal.addEventListener('abort',cancel,{once:true});
      let last=-1,lastSavedAt=0,progress;
      const renderStartedAt=Date.now();
      const progressFile=path.join(work,'progress.json');
      try {
        const schedule=staticImageRenderSchedule(frozen.props);
        const useStatic=engine==='auto' && schedule.eligible && renderer.renderStill && renderer.openBrowser;
        performance.renderRoute={engine:useStatic?'static-image-ffmpeg':'remotion',totalFrames:plan.durationInFrames,
          capturedFrames:useStatic?schedule.capturedFrames:plan.durationInFrames,
          reasons:useStatic?[]:engine==='remotion'?['full renderer explicitly selected']:schedule.eligible?['static capture API unavailable']:schedule.reasons};
        if(useStatic) {
          const result=await renderStaticImageTimeline({props:frozen.props,schedule,renderer,composition,serveUrl,browserExecutable,
            publicDir,work,output:partial,encoding,cancelSignal,signal:diskWatcher.signal,onProgress:event=>{
              const now=Date.now(),percent=Math.min(100,Math.floor(event.phase==='capture'
                ?45*event.capturedFrames/event.totalCaptures:45+55*event.encodedFrames/plan.durationInFrames));
              progress={at:new Date(now).toISOString(),elapsedMs:now-renderStartedAt,percent,...event,
                totalFrames:plan.durationInFrames,stitchStage:event.phase==='capture'?'static-capture':'encoding'};
              if(now-lastSavedAt>=5000 || percent===100){save(progressFile,progress);lastSavedAt=now;}
              if(percent>=last+5){last=percent;console.log(`render ${percent}% capture=${event.capturedFrames}/${event.totalCaptures} encoded=${event.encodedFrames}/${plan.durationInFrames} stage=${progress.stitchStage}`);onProgress?.(percent);}
            }});
          performance.frameRenderingMs=result.captureMs;performance.encodingAndMuxingMs=result.encodingMs;
          performance.timingNotes='Static images use the unchanged composition for exact caption and transition states; FFmpeg repeats unchanged frames. frameRenderingMs measures unique frame capture; encodingAndMuxingMs measures the following hardware encoding and muxing stage.';
        } else {
        const requestedConcurrency=Math.max(1,Math.min(4,Math.floor(Number(concurrency))||2));
        // Parallel Chrome tabs can stall at the first animation frame on Intel Monterey.
        const renderConcurrency=process.platform==='darwin' && process.arch==='x64' && release().startsWith('21.') ? 1 : requestedConcurrency;
        performance.renderRoute.concurrency=renderConcurrency;
        if(renderConcurrency!==requestedConcurrency)console.log('Intel macOS 12: using one Remotion render tab');
        await renderMedia({serveUrl,composition,inputProps:frozen.props,browserExecutable,outputLocation:partial,cancelSignal,
          ...motionHardwareRenderOptions(encoding),
          gopSize:150,pixelFormat:'yuv420p',colorSpace:'bt709',audioCodec:'aac',audioBitrate:encoding.audioBitrate,enforceAudioTrack:true,
          // The composition is opaque. JPEG intermediates avoid PNG compression on
          // every frame while the delivery remains full-resolution H.264/AAC.
          imageFormat:'jpeg',jpegQuality:92,concurrency:renderConcurrency,
          offthreadVideoCacheSizeInBytes:512*1024*1024,timeoutInMilliseconds:90000,
          onProgress:event=>{
            const now=Date.now(),percent=Math.floor(event.progress*100);
            if(performance.frameRenderingMs===null && event.renderedFrames>=plan.durationInFrames)performance.frameRenderingMs=now-renderStartedAt;
            if(finite(event.encodedDoneIn))performance.encodingAndMuxingMs=event.encodedDoneIn;
            progress={at:new Date(now).toISOString(),elapsedMs:now-renderStartedAt,percent,
              renderedFrames:event.renderedFrames,encodedFrames:event.encodedFrames,totalFrames:plan.durationInFrames,
              renderedDoneInMs:event.renderedDoneIn,encodedDoneInMs:event.encodedDoneIn,stitchStage:event.stitchStage};
            if(now-lastSavedAt>=5000 || percent===100){save(progressFile,progress);lastSavedAt=now;}
            if(percent>=last+5){last=percent;console.log(`render ${percent}% frames=${event.renderedFrames}/${plan.durationInFrames} encoded=${event.encodedFrames}/${plan.durationInFrames} stage=${event.stitchStage} elapsedMs=${now-renderStartedAt}`);onProgress?.(percent);}
          }});
        }
        diskWatcher.signal.throwIfAborted();
      } catch(error) {diskWatcher.signal.throwIfAborted();throw error;}
      finally {
        diskWatcher.stop();diskWatcher.signal.removeEventListener('abort',cancel);
        performance.renderMediaMs=Date.now()-renderStartedAt;
        if(progress)save(progressFile,progress);
      }
    }
    removeBundlePublicAlias(path.join(work,'bundle'),publicDir);
    const finalizeStartedAt=Date.now();
    await checkDiskSpace(path.dirname(outputPath));
    const metadata=probe(partial),bytes=fs.statSync(partial).size;
    const uploadEncoding=validateOutput(metadata,bytes,plan,plan.uploadEncoding,{requireHardware:!resumeExisting});
    fs.renameSync(partial,outputPath);
    const stem=path.basename(outputPath,path.extname(outputPath));
    const preview=path.join(path.dirname(outputPath),`${stem}-preview.mp4`);
    const previewDuration=Math.min(60,plan.durationInFrames/plan.fps);
    execFileSync('ffmpeg',['-v','error','-n','-i',outputPath,'-t',String(previewDuration),'-map','0:v:0','-map','0:a:0','-c','copy','-movflags','+faststart',preview],{timeout:60_000});
    const sampleDir=path.join(work,'samples');fs.mkdirSync(sampleDir,{recursive:true});
    // Continuous frames and beat boundaries support a subsequent visual review.
    const representatives = [...new Set([
      frozen.props.shots.find(s => s.titles?.length), frozen.props.shots.find(s => s.map?.enabled),
      frozen.props.shots.find(s => s.imagePath),
      ...['timeline','comparison','relationship','quote'].map(kind=>frozen.props.shots.find(s=>s.graphic?.kind===kind)),
      frozen.props.shots.find(s => s.motion?.kind && s.motion.kind !== 'static'),
    ].filter(Boolean))];
    if (!representatives.length) representatives.push(frozen.props.shots[0]);
    const samples = [];
    for (const [index, shot] of representatives.entries()) {
      const trigger = shot.titles?.[0]?.start ?? shot.map?.routes?.[0]?.start ?? 0;
      const offset = Math.min(shot.frames - 1, Math.round((trigger + .2) * plan.fps));
      const start = shot.startFrame + offset, count = Math.min(6, shot.frames - offset);
      execFileSync('ffmpeg',['-v','error','-n','-ss',String(start/plan.fps),'-i',outputPath,'-frames:v',String(count),path.join(sampleDir,`shot-${index + 1}-%02d.png`)],{timeout:60_000});
      const hold = shot.startFrame + Math.max(0, shot.frames - Math.ceil(plan.fps * .2));
      execFileSync('ffmpeg',['-v','error','-n','-ss',String(hold/plan.fps),'-i',outputPath,'-frames:v','1',path.join(sampleDir,`shot-${index + 1}-hold.png`)],{timeout:60_000});
      samples.push({shotId:shot.shotId,start,count,hold,directory:sampleDir});
    }
    report={status:'completed',output:outputPath,preview,sha256:await fileSha256(outputPath),
      planSha256:await fileSha256(planPath),bytes,duration:Number(metadata.format.duration),width:plan.width,height:plan.height,fps:30,frames:plan.durationInFrames,
      renderer:`Remotion ${requireRemotion('@remotion/renderer/package.json').version}${performance.renderRoute?.engine==='static-image-ffmpeg'?' + FFmpeg static-frame encoding':''}`,composition:'HistoryMotionFactory',
      encoding:uploadEncoding.settings,uploadEncoding,performance,shotcraft:designedPlan.shotcraft ?? null,
      frameCapture:resumeExisting?null:{format:'jpeg',quality:92},assets:frozen.assets,captionTiming:plan.captions?'provided':'estimated-within-shot',
      sampleFrames:samples,previewRange:{start:0,end:previewDuration},
      qa:{technical:'passed',visual:'not-reviewed',listening:'not-reviewed',humanReviewRequired:false},
      images:frozen.images,graphics:frozen.graphics,soundEffects:frozen.soundEffects,
      visuals:frozen.props.shots.map(s=>({shotId:s.shotId,startFrame:s.startFrame,frames:s.frames,visualType:s.visualType,graphicKind:s.graphic?.kind,shotcraft:s.shotcraft})),
      fallbacks:plan.fallbacks ?? [],
      maps:frozen.props.shots.filter(s=>s.map?.enabled).map(s=>({shotId:s.shotId,provenance:s.map.provenance,forces:s.map.forces,
        forceEvidence:s.map.forces?.length ? {symbols:'illustrative; not actual troop counts or exact positions',ownershipChange:'completed occupy actions only',portraits:'illustrative generated artwork; local assets frozen by SHA-256'} : undefined})),
      videoPlayback:frozen.props.shots.filter(s=>s.visualType==='video').map(s=>({shotId:s.shotId,playbackRate:s.playbackRate,sourceIn:s.inPoint || 0,sourceOut:s.outPoint,playableFrames:s.playableFrames})),
      frozenTails:frozen.props.shots.filter(s=>s.visualType==='video' && s.playableFrames<s.frames).map(s=>({shotId:s.shotId,sourceDuration:s.outPoint-(s.inPoint||0),shotDuration:s.frames/plan.fps,startFrame:s.startFrame+s.playableFrames,frames:s.frames-s.playableFrames})),
      audioPolicy:{narrationGain:1,sourceFootage:'muted',
        soundEffectMaxGain:maxEffectVolume,soundEffectCombinedMaxGain:.15,fadeSeconds:.12,
        expectedSoundEffectInputNormalization:'ffmpeg loudnorm=I=-24:TP=-5:LRA=7; supplied by pipeline, not measured by renderer',
        overlapPolicy:'Scale simultaneous effect envelopes to the combined gain budget',automaticBgm:false}};
    performance.finalizeMs=Date.now()-finalizeStartedAt;performance.totalMs=Date.now()-startedAt;
    save(path.join(work,'delivery.json'),report);save(outputPath+'.json',report);
    fs.writeFileSync(path.join(path.dirname(outputPath),`${stem}-review.html`),reviewHtml(path.basename(outputPath),path.basename(preview),report));
  } catch(error) {
    performance.totalMs=Date.now()-startedAt;
    if(fs.existsSync(work))save(path.join(work,'failure.json'),{status:'failed',error:error.message,
      ...(error.code==='MEDIA_DISK_FULL'?{code:error.code}:{}),at:new Date().toISOString(),performance});
    throw error;
  } finally {
    try {removeBundlePublicAlias(path.join(work,'bundle'),publicDir);}
    finally {fs.closeSync(lockHandle);fs.unlinkSync(lock);}
  }
  // Releasing the render lock and saving every deliverable precede cleanup.
  // A failed render never reaches this point; cache problems do not fail a movie.
  report.cacheCleanup=await cleanupHistoryMotionRenderCache(outputPath,{retainCache:retainCache===true || retainCache==='true'});
  console.log(JSON.stringify({output:outputPath,preview:report.preview,report:outputPath+'.json',status:report.status}));
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options={};
  for(let i=2;i<process.argv.length;i+=2){assertion(process.argv[i].startsWith('--')&&process.argv[i+1],'Expected --key value');options[process.argv[i].slice(2)]=process.argv[i+1];}
  // Remotion/Chromium may retain an idle IPC socket after a handled signal.
  // Once all artifacts and the report are saved, the CLI must release its runner.
  renderHistoryMotion(options).then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
}
