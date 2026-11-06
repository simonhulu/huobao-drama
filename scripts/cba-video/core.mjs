import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertEditorialAudit, assertProductionPhaseAllowed} from './editorial-gate.mjs';
import {validateTitlePolicy} from './title-policy.mjs';
import {selectedEditions} from './editions.mjs';
import {CBA_PRODUCTION_POLICY, productionQuality, matchEvidenceErrors} from './production-policy.mjs';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function createJob(match) {
  if (!match?.id || !/^[\w-]+$/.test(match.id) || match.league !== 'CBA'
      || !/^\d{4}-\d{2}-\d{2}$/.test(match.date) || !match.home || !match.away || match.home === match.away) {
    throw Error('Match requires a safe id, league CBA, ISO date, distinct home and away teams.');
  }
  return {version: 1, match: {...match, verified: match.verified === true}, status: 'collecting',
    createdAt: new Date().toISOString(), profile: {width: 1920, height: 1080, fps: 30,
      newsSeconds: [120, 180], highlightsSeconds: [180, 300], platforms: ['wechat-channels', 'baijiahao']},
    sources: [], facts: [], media: [], mediaSearch: null, clips: [], news: {title: '', summary: '', segments: []},
    highlights: {title: '', clipIds: []},
    tts: {voice: 'Chinese (Mandarin)_Radio_Host', model: 'speech-2.8-hd', speed: 1.08, emotion: 'fluent'},
    review: null, approval: null, blockers: [], mediaBlocker: null, outputs: null};
}
export function editorialDigest(job) {
  return digest({version: job.version, match: job.match, profile: job.profile, sources: job.sources,
    facts: job.facts, media: job.media, clips: job.clips,
    news: {...job.news, segments: (job.news?.segments ?? []).map(({audioPath, audioDigest, ...segment}) => segment)},
    highlights: job.highlights, tts: job.tts,
    ...(job.profile?.productionPolicy === CBA_PRODUCTION_POLICY ? {matchEvidence: job.matchEvidence} : {})});
}
function hasRequiredMedia(job) {
  return (job.media ?? []).some(media => media.kind === 'full_replay'
    || (job.profile?.sourceScope === 'highlights' && media.kind === 'highlights'));
}
export function validateJob(job, {ready = false} = {}) {
  const errors = [], warnings = [];
  let editions = [];
  try { editions = selectedEditions(job); } catch (error) { errors.push(error.message); }
  const hasNews = editions.includes('news'), hasHighlights = editions.includes('highlights');
  const sourceScope = job.profile?.sourceScope ?? 'full_replay';
  if (!['full_replay','highlights'].includes(sourceScope)) errors.push('Profile sourceScope must be full_replay or highlights');
  if (sourceScope === 'highlights') warnings.push('素材范围：已剪辑集锦，不代表整场比赛覆盖；解读只使用已核实事实和实际可见回合。');
  const indexes = {};
  for (const key of ['sources', 'facts', 'media', 'clips']) {
    indexes[key] = new Map();
    for (const item of job[key] ?? []) {
      if (!item.id || !/^[\w-]+$/.test(item.id) || indexes[key].has(item.id)) errors.push(`${key}: missing, unsafe or duplicate id ${item.id}`);
      indexes[key].set(item.id, item);
    }
  }
  for (const source of job.sources ?? []) {
    if (!/^https?:\/\//.test(source.url ?? '') || !source.title) errors.push(`Source ${source.id}: HTTP URL and title required`);
  }
  for (const fact of job.facts ?? []) {
    if (!fact.text?.trim() || !fact.sourceIds?.length || fact.sourceIds.some(id => !indexes.sources.has(id))) errors.push(`Fact ${fact.id}: text and existing sourceIds required`);
    if (ready && fact.verified !== true) errors.push(`Fact ${fact.id} is not verified`);
  }
  for (const media of job.media ?? []) {
    if (!path.isAbsolute(media.path ?? '') || !fs.existsSync(media.path)) errors.push(`Media ${media.id}: local file missing`);
    if (!(media.probe?.duration > 0) || !(media.probe?.width > 0) || !(media.probe?.height > 0)) errors.push(`Media ${media.id}: invalid video probe`);
    if (ready && (media.matchConfirmed !== true || media.matchId !== job.match.id || !media.sha256)) errors.push(`Media ${media.id}: match identity/fingerprint not confirmed`);
  }
  for (const clip of job.clips ?? []) {
    const media = indexes.media.get(clip.mediaId);
    if (!media || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start || clip.end > media.probe?.duration + 0.1) errors.push(`Clip ${clip.id}: invalid media or time range`);
    if (clip.factIds?.some(id => !indexes.facts.has(id))) errors.push(`Clip ${clip.id}: unknown fact reference`);
  }
  const usedClips = new Set(hasHighlights ? job.highlights?.clipIds ?? [] : []);
  const newsClips = new Set();
  const segmentIds = new Set();
  for (const segment of hasNews ? job.news?.segments ?? [] : []) {
    if (!segment.id || !/^[\w-]+$/.test(segment.id) || segmentIds.has(segment.id)) errors.push('News segment ids must be safe and unique');
    segmentIds.add(segment.id);
    if (segment.mode && !['original','narration'].includes(segment.mode)) errors.push(`Segment ${segment.id}: unsupported audio mode`);
    if (segment.mode !== 'original' && !segment.text?.trim()) errors.push(`Segment ${segment.id}: narration text missing`);
    if (!segment.factIds?.length || segment.factIds.some(id => !indexes.facts.has(id))) errors.push(`Segment ${segment.id}: supporting facts missing`);
    if (ready && !segment.clipIds?.length) errors.push(`Segment ${segment.id}: no footage assigned`);
    for (const id of segment.clipIds ?? []) {
      if (newsClips.has(id)) errors.push(`News clip ${id} is repeated`);
      newsClips.add(id); usedClips.add(id);
      const clip = indexes.clips.get(id), media = clip && indexes.media.get(clip.mediaId);
      if (ready && segment.mode === 'original' && media?.probe?.hasAudio !== true) errors.push(`Original segment ${segment.id} needs source audio`);
    }
  }
  for (const id of usedClips) {
    const clip = indexes.clips.get(id);
    if (!clip) errors.push(`Unknown selected clip ${id}`);
    else if (ready && (clip.verified !== true || !clip.verificationNote?.trim())) errors.push(`Clip ${id}: visual verification and note required`);
  }
  const highlightIds = hasHighlights ? job.highlights?.clipIds ?? [] : [];
  if (new Set(highlightIds).size !== highlightIds.length) errors.push('Highlights contain duplicate clip ids');
  const byMedia = new Map();
  for (const id of highlightIds) {
    const clip = indexes.clips.get(id);
    if (!clip) continue;
    if (ready && indexes.media.get(clip.mediaId)?.probe?.hasAudio !== true) errors.push(`Highlight ${id} needs original audio`);
    const preceding = byMedia.get(clip.mediaId);
    if (preceding && clip.start < preceding.end) errors.push(`Highlights overlap or reverse time at ${id}`);
    byMedia.set(clip.mediaId, clip);
  }
  if (ready) {
    errors.push(...validateTitlePolicy(job));
    if (!job.match.verified) errors.push('Match identity is not verified');
    if (!hasRequiredMedia(job)) errors.push(sourceScope === 'highlights'
      ? 'A local replay or highlights source is required by this production profile'
      : 'A full replay is required by this production profile');
    if (hasNews && (!job.news?.title || !job.news?.segments?.length)) errors.push('News title/script missing');
    if (hasHighlights && (!job.highlights?.title || !highlightIds.length)) errors.push('Highlights title/cut list missing');
  }
  const seconds = highlightIds.reduce((sum, id) => { const c = indexes.clips.get(id); return sum + (c ? c.end - c.start : 0); }, 0);
  if (seconds && (seconds < 180 || seconds > 300)) warnings.push(`Highlights ${seconds.toFixed(1)}s; target is 180–300s. Keep complete meaningful possessions; do not pad.`);
  if (ready && editions.length) {
    const quality = productionQuality(job);
    errors.push(...quality.errors, ...matchEvidenceErrors(job)); warnings.push(...quality.warnings);
  }
  return {errors: [...new Set(errors)], warnings};
}
export function refreshStatus(job) {
  if (job.approval?.digest !== editorialDigest(job)) { job.approval = null; job.outputs = null; }
  if (job.approval) job.status = job.outputs ? 'rendered' : 'approved';
  else if (!hasRequiredMedia(job)) job.status = 'waiting_for_media';
  else job.status = validateJob(job, {ready: true}).errors.length ? 'needs_edit' : 'awaiting_review';
  return job;
}
export function approveJob(job, {digest: reviewedDigest, note}) {
  assertProductionPhaseAllowed();
  if (job.automation?.requireAudit === true) assertEditorialAudit(job);
  const current = editorialDigest(job);
  if (!note?.trim()) throw Error('Record the user’s actual preview approval in --note.');
  if (reviewedDigest !== current || job.review?.digest !== current || !job.review?.complete) throw Error('Approval requires the current complete review preview and its digest.');
  const {errors} = validateJob(job, {ready: true});
  if (errors.length) throw Error(errors.join('\n'));
  job.approval = {digest: current, at: new Date().toISOString(), note};
  job.status = 'approved';
  return job;
}
export async function assertApproved(job) {
  assertProductionPhaseAllowed();
  if (job.automation?.requireAudit === true) assertEditorialAudit(job);
  if (!job.approval || job.approval.digest !== editorialDigest(job)) throw Error('User approval of the current script and clip preview is required before TTS/render.');
  const {errors} = validateJob(job, {ready: true});
  if (errors.length) throw Error(errors.join('\n'));
  for (const media of job.media) if (await fileHash(media.path) !== media.sha256) throw Error(`Media ${media.id} changed after review; re-import and review.`);
}
