import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {editorialDigest, fileHash, validateJob, writeJson} from './core.mjs';
import {selectedEditions} from './editions.mjs';
import {CBA_PRODUCTION_POLICY} from './production-policy.mjs';

const run = promisify(execFile);
const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
export const EDITORIAL_CHECKS = Object.freeze([
  'newsAngle', 'sourceAttribution', 'noProductionTalk', 'footageDisclosure',
  'playBoundaries', 'eventFootageAccuracy',
]);
const stringSchema = {type: 'string'};
const hashSchema = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const idArraySchema = {type: 'array', items: stringSchema};
const objectSchema = properties => ({type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties});
const checkSchema = objectSchema({passed: {type: 'boolean'}, reason: stringSchema,
  sourceIds: idArraySchema, clipIds: idArraySchema, segmentIds: idArraySchema, evidenceIds: idArraySchema});
// Serializable JSON Schema for `codex exec --output-schema`. The backend must
// overwrite reviewer metadata from its own subprocess records, not trust the model.
export const editorialAuditSchema = objectSchema({
  version: {type: 'integer', enum: [1]}, editorialDigest: hashSchema,
  packetPath: stringSchema, packetSha256: hashSchema,
  decision: {type: 'string', enum: ['pass','revise','blocked']},
  reviewer: objectSchema({provider: {type: 'string', enum: ['codex']},
    role: {type: 'string', enum: ['independent-editorial-reviewer']}, runId: stringSchema, producerRunId: stringSchema}),
  reviewedAt: stringSchema,
  checks: objectSchema(Object.fromEntries(EDITORIAL_CHECKS.map(name => [name, checkSchema]))),
  clipObservations: {type: 'array', items: objectSchema({clipId: stringSchema, observation: stringSchema,
    startObservation: stringSchema, endObservation: stringSchema, evidenceIds: idArraySchema})},
  issues: {type: 'array', items: objectSchema({code: stringSchema, severity: {type: 'string', enum: ['error','warning']},
    message: stringSchema, suggestion: stringSchema, clipIds: idArraySchema, segmentIds: idArraySchema, sourceIds: idArraySchema, evidenceIds: idArraySchema})},
});
const blockedPhases = new Set(['discovery', 'editing', 'audit']);
const hashBuffer = value => createHash('sha256').update(value).digest('hex');
const newsSegments = job => selectedEditions(job).includes('news') ? job.news?.segments ?? [] : [];
const selectedIds = job => [...new Set([
  ...newsSegments(job).flatMap(segment => segment.clipIds ?? []),
  ...(selectedEditions(job).includes('highlights') ? job.highlights?.clipIds ?? [] : []),
])];
const substantive = (text, minimum = 12) => typeof text === 'string'
  && [...text.trim()].length >= minimum
  && !/^(?:已核实|通过|符合|正常|pass|verified|ok)[。.!\s]*$/i.test(text.trim());
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Bind structured generation to this package, instead of asking a model to copy
 * hashes or remember which ID namespace a value belongs to. */
export function buildEditorialAuditSchema(prepared, job, reviewerInfo = {}) {
  const current = editorialDigest(job);
  if (prepared.digest !== current || !path.isAbsolute(prepared.packetPath ?? '')) {
    throw Error('Editorial schema requires the current prepared input package.');
  }
  const bytes = fs.readFileSync(prepared.packetPath);
  const packet = JSON.parse(bytes);
  if (hashBuffer(bytes) !== prepared.packetSha256 || packet.editorialDigest !== current
      || editorialDigest(packet.editorial) !== current || !Array.isArray(packet.evidence)) {
    throw Error('Editorial schema input package changed or does not match the job.');
  }
  const schema = structuredClone(editorialAuditSchema);
  for (const [key, value] of Object.entries({editorialDigest: current,
    packetPath: prepared.packetPath, packetSha256: prepared.packetSha256})) {
    schema.properties[key] = {type: 'string', enum: [value]};
  }
  const ids = {sourceIds: job.sources.map(source => source.id), clipIds: selectedIds(job),
    segmentIds: newsSegments(job).map(segment => segment.id), evidenceIds: packet.evidence.map(item => item.id)};
  const enumArray = values => values.length ? {type: 'array', items: {type: 'string', enum: values}}
    : {type: 'array', items: {type: 'string'}, maxItems: 0};
  for (const properties of [...EDITORIAL_CHECKS.map(name => schema.properties.checks.properties[name].properties),
    schema.properties.issues.items.properties]) {
    for (const [key, values] of Object.entries(ids)) properties[key] = enumArray(values);
  }
  const observations = schema.properties.clipObservations;
  observations.minItems = ids.clipIds.length;
  observations.maxItems = ids.clipIds.length;
  if (ids.clipIds.length) observations.items.properties.clipId = {type: 'string', enum: ids.clipIds};
  else observations.maxItems = 0;
  observations.items.properties.evidenceIds = enumArray(ids.evidenceIds);
  const reviewer = {provider: 'codex', role: 'independent-editorial-reviewer',
    producerRunId: job.automation?.producerRunId, ...reviewerInfo};
  for (const key of Object.keys(schema.properties.reviewer.properties)) {
    if (typeof reviewer[key] === 'string' && reviewer[key].trim()) {
      schema.properties.reviewer.properties[key] = {type: 'string', enum: [reviewer[key]]};
    }
  }
  return schema;
}

/** Repair representation only. Never manufacture a reviewer observation or
 * discard an objection, an unknown ID, or an invalid evidence reference. */
export function normalizeEditorialAudit(job, audit) {
  if (!audit || typeof audit !== 'object') return audit;
  const normalized = structuredClone(audit);
  let selected;
  try { selected = new Set(selectedIds(job)); } catch { return normalized; }
  if (Array.isArray(normalized.clipObservations)) {
    const groups = new Map();
    for (const item of normalized.clipObservations) {
      if (!item || !selected.has(item.clipId)) continue;
      if (!groups.has(item.clipId)) groups.set(item.clipId, []);
      groups.get(item.clipId).push(item);
    }
    const merged = new Map();
    for (const [id, items] of groups) {
      // Incomplete rows stay unmodified so the validator still reports them.
      if (items.length < 2 || !items.every(item => substantive(item.observation)
          && substantive(item.startObservation, 8) && substantive(item.endObservation, 8)
          && Array.isArray(item.evidenceIds) && item.evidenceIds.length
          && item.evidenceIds.every(value => typeof value === 'string'))) continue;
      const result = {...items[0]};
      for (const field of ['observation','startObservation','endObservation']) {
        result[field] = [...new Set(items.map(item => item[field]))].join('\n');
      }
      result.evidenceIds = [...new Set(items.flatMap(item => item.evidenceIds))];
      merged.set(id, result);
    }
    const emitted = new Set();
    normalized.clipObservations = normalized.clipObservations.flatMap(item => {
      if (!merged.has(item?.clipId)) return [item];
      if (emitted.has(item.clipId)) return [];
      emitted.add(item.clipId); return [merged.get(item.clipId)];
    });
  }
  // A passing check plus optional advice is not a request to change content.
  // All other validation (including substantive reasons and IDs) still applies.
  if (normalized.decision === 'revise'
      && EDITORIAL_CHECKS.every(name => normalized.checks?.[name]?.passed === true)
      && Array.isArray(normalized.issues) && normalized.issues.length
      && normalized.issues.every(issue => issue?.severity === 'warning')) normalized.decision = 'pass';
  return normalized;
}

export function assertProductionPhaseAllowed(env = process.env) {
  if (blockedPhases.has(env.CBA_AUTOMATION_PHASE)) {
    throw Error(`CBA automation phase ${env.CBA_AUTOMATION_PHASE} cannot approve, generate TTS or render; independent backend review is required.`);
  }
}

function originalNews(job) {
  const seedUrls = job.match?.seedUrls ?? [];
  const sources = (job.sources ?? []).filter(source => seedUrls.includes(source.url));
  return {seedUrls, sourceIds: sources.map(source => source.id),
    stories: sources.map(({id, url, title, text, publishedAt}) => ({id, url, title, text, publishedAt}))};
}

function editorialSnapshot(job) {
  const {version, match, profile, sources, facts, media, clips, news, highlights, tts} = job;
  return {version, match, profile, sources, facts, media, clips,
    news: {...news, segments: (news?.segments ?? []).map(({audioPath, audioDigest, ...segment}) => segment)}, highlights, tts,
    ...(profile?.productionPolicy === CBA_PRODUCTION_POLICY ? {matchEvidence: job.matchEvidence} : {})};
}

function sampleTimes(clip, media) {
  const frame = 1 / (media.probe.fps || 25);
  const last = Math.max(0, media.probe.duration - frame);
  const duration = clip.end - clip.start;
  const times = [
    {role: 'before-start', time: Math.max(0, clip.start - .4)},
    {role: 'start', time: clip.start},
    {role: 'after-start', time: Math.min(clip.end - frame, clip.start + .4)},
  ];
  // Include the full progression of long selections, not just their midpoint.
  const intervals = Math.max(2, Math.ceil(duration / 12));
  for (let i = 1; i < intervals; i++) times.push({role: 'middle', time: clip.start + duration * i / intervals});
  times.push({role: 'before-end', time: Math.max(clip.start, clip.end - .4)},
    {role: 'end', time: Math.max(clip.start, clip.end - frame)},
    {role: 'after-end', time: Math.min(last, clip.end + .4)});
  return times.map(({role, time}) => ({role, sourceTime: Math.max(0, Math.min(last, Number(time.toFixed(4))))}));
}

/** Generate an immutable, image-backed input package for a separate reviewer. */
export async function prepareEditorialAudit(job, jobDir) {
  const errors = validateJob(job, {ready: true}).errors;
  if (errors.length) throw Error(`Cannot prepare editorial audit: ${errors.join('; ')}`);
  const digest = editorialDigest(job);
  const directory = path.resolve(jobDir, 'editorial-audit', digest);
  fs.mkdirSync(directory, {recursive: true});
  const ids = selectedIds(job);
  const clips = ids.map(id => job.clips.find(clip => clip.id === id));
  const mediaById = new Map(job.media.map(media => [media.id, media]));
  for (const id of new Set(clips.map(clip => clip.mediaId))) {
    const media = mediaById.get(id);
    if (await fileHash(media.path) !== media.sha256) throw Error(`Media ${id} changed before editorial audit.`);
  }
  const sharp = requireBackend('sharp');
  const evidence = [];
  for (const clip of clips) {
    const media = mediaById.get(clip.mediaId), samples = sampleTimes(clip, media);
    const width = 480, imageHeight = 270, cellHeight = 302, columns = 3;
    const layers = [];
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const {stdout} = await run('ffmpeg', ['-v','error','-nostdin','-ss',String(sample.sourceTime),
        '-i',media.path,'-map','0:v:0','-frames:v','1','-vf',
        `scale=${width}:${imageHeight}:force_original_aspect_ratio=decrease,pad=${width}:${imageHeight}:(ow-iw)/2:(oh-ih)/2`,
        '-f','image2pipe','-vcodec','png','pipe:1'], {encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 30_000});
      if (!stdout.length) throw Error(`No actual frame for ${clip.id} at ${sample.sourceTime}s.`);
      const x = i % columns * width, y = Math.floor(i / columns) * cellHeight;
      layers.push({input: stdout, left: x, top: y});
      layers.push({input: Buffer.from(`<svg width="${width}" height="32"><rect width="100%" height="100%" fill="#17202a"/><text x="8" y="22" fill="white" font-size="16">${esc(clip.id)} · ${sample.role} · ${sample.sourceTime.toFixed(2)}s</text></svg>`), left: x, top: y + imageHeight});
    }
    const file = path.join(directory, `${clip.id}-contact.jpg`);
    await sharp({create: {width: width * columns, height: Math.ceil(samples.length / columns) * cellHeight,
      channels: 3, background: '#17202a'}}).composite(layers).jpeg({quality: 88}).toFile(file);
    evidence.push({id: `image-${clip.id}`, kind: 'contact-sheet', clipId: clip.id, mediaId: clip.mediaId,
      path: file, sha256: await fileHash(file), samples});
  }
  const packet = {version: 1, editorialDigest: digest, createdAt: new Date().toISOString(),
    originalNews: originalNews(job), editorial: editorialSnapshot(job),
    selectedClipIds: ids, evidence,
    instructions: 'Read the original news and source text. Inspect every actual contact sheet, including frames before and after cuts. Require correct facts, attribution and match identity. For a specifically identified action or original-audio highlights, preserve the essential action and outcome; inspect the local source video when the supplied samples cannot establish them. Disclosed same-match archival footage does not need a complete possession at every cut: harmless transitions and optional frame-level refinements are warnings, not reasons to revise. Report all material errors in the first review, with exact affected IDs and corrections; in a revision check the correction and any actual newly introduced error without adding optional polish requirements. Never infer semantics from verificationNote or a passed flag. Return the documented audit schema with one substantive observation per selected clip and exact source, segment, clip and evidence IDs.',
    requiredChecks: EDITORIAL_CHECKS};
  const packetPath = path.join(directory, 'packet.json');
  writeJson(packetPath, packet);
  return {digest, packetPath, packetSha256: await fileHash(packetPath), imagePaths: evidence.map(item => item.path)};
}

/** Validate the complete review contract, rather than trusting an overall pass flag. */
export function validateEditorialAudit(job, audit = job.automation?.audit) {
  const errors = [];
  let repairTarget = 'none';
  const priority = {none: 0, report: 1, content: 2, evidence: 3};
  const fail = (message, target = 'report') => {
    errors.push(message);
    if (priority[target] > priority[repairTarget]) repairTarget = target;
  };
  const result = () => ({valid: errors.length === 0, errors: [...new Set(errors)], repairTarget});
  try { selectedEditions(job); } catch (error) { fail(error.message, 'content'); return result(); }
  if (!audit || typeof audit !== 'object') { fail('Independent editorial audit is missing.'); return result(); }
  if (audit.version !== 1) fail('Editorial audit version must be 1.');
  if (!['pass','revise','blocked'].includes(audit.decision)) fail('Editorial audit decision is invalid.');
  if (audit.decision !== 'pass') fail(`Editorial audit decision is ${audit.decision ?? 'missing'}.`, audit.decision === 'blocked' ? 'content' : 'report');
  // Record substantive objections before early returns for malformed reports.
  for (const name of EDITORIAL_CHECKS) {
    if (audit.checks?.[name]?.passed === false) fail(`Editorial check ${name} needs a passing decision and a specific explanation.`, 'content');
  }
  for (const issue of Array.isArray(audit.issues) ? audit.issues : []) {
    if (issue?.severity === 'error') fail(`Unresolved editorial issue ${issue.code}: ${issue.message}`, 'content');
  }
  const current = editorialDigest(job);
  if (audit.editorialDigest !== current) fail('Editorial audit is stale for the current script and clips.', 'evidence');
  const reviewer = audit.reviewer;
  if (reviewer?.provider !== 'codex' || reviewer?.role !== 'independent-editorial-reviewer'
      || typeof reviewer.runId !== 'string' || !reviewer.runId.trim()
      || typeof reviewer.producerRunId !== 'string' || !reviewer.producerRunId.trim()
      || reviewer.runId === reviewer.producerRunId
      || reviewer.producerRunId !== job.automation?.producerRunId) fail('Editorial audit requires distinct, backend-recorded reviewer and producer run IDs.');
  if (!Number.isFinite(Date.parse(audit.reviewedAt))) fail('Editorial audit reviewedAt is required.');
  let packet;
  try {
    if (!path.isAbsolute(audit.packetPath ?? '')) throw Error('absolute packetPath required');
    const bytes = fs.readFileSync(audit.packetPath);
    if (hashBuffer(bytes) !== audit.packetSha256) throw Error('packet fingerprint changed');
    packet = JSON.parse(bytes);
    if (packet.version !== 1 || packet.editorialDigest !== current
        || editorialDigest(packet.editorial) !== current) throw Error('packet does not match the current edit');
    if (JSON.stringify(packet.originalNews) !== JSON.stringify(originalNews(job))) throw Error('original news references differ');
  } catch (error) { fail(`Editorial audit input package invalid: ${error.message}`, 'evidence'); }
  if (!packet?.editorial || !Array.isArray(packet.evidence)) {
    fail('Editorial audit input package is missing editorial or evidence data.', 'evidence'); return result();
  }
  const clips = new Map(job.clips.map(clip => [clip.id, clip]));
  const sourceIds = new Set(job.sources.map(source => source.id));
  const segmentIds = new Set(newsSegments(job).map(segment => segment.id));
  const selected = selectedIds(job), selectedSet = new Set(selected);
  if (JSON.stringify(packet.selectedClipIds) !== JSON.stringify(selected)) fail('Audit package must cover every selected clip.', 'evidence');
  const evidence = new Map();
  for (const item of packet.evidence) {
    if (!item?.id || evidence.has(item.id)) { fail('Audit image evidence IDs must be unique.', 'evidence'); continue; }
    evidence.set(item.id, item);
    const clip = clips.get(item.clipId), media = job.media.find(m => m.id === clip?.mediaId);
    if (!selectedSet.has(item.clipId) || item.mediaId !== clip?.mediaId || item.kind !== 'contact-sheet') fail(`Invalid image evidence association: ${item.id}`, 'evidence');
    if (clip && media && JSON.stringify(item.samples) !== JSON.stringify(sampleTimes(clip, media))) fail(`Evidence ${item.id} does not cover the actual boundaries and middle samples.`, 'evidence');
    try {
      if (!path.isAbsolute(item.path) || path.dirname(item.path) !== path.dirname(audit.packetPath)) throw Error('image must be in the input package');
      const bytes = fs.readFileSync(item.path);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || hashBuffer(bytes) !== item.sha256) throw Error('image missing, invalid or changed');
    } catch (error) { fail(`Evidence ${item.id}: ${error.message}`, 'evidence'); }
  }
  const checkReferences = (value, label) => {
    for (const [key, allowed] of [['sourceIds',sourceIds],['clipIds',selectedSet],['segmentIds',segmentIds],['evidenceIds',new Set(evidence.keys())]]) {
      if (!Array.isArray(value?.[key]) || value[key].some(id => !allowed.has(id))) fail(`${label} has missing or unknown ${key}.`);
    }
  };
  for (const name of EDITORIAL_CHECKS) {
    const check = audit.checks?.[name];
    if (check?.passed !== true || !substantive(check.reason)) fail(`Editorial check ${name} needs a passing decision and a specific explanation.`, check?.passed === false ? 'content' : 'report');
    checkReferences(check, `Check ${name}`);
  }
  // The report is untrusted structured output. Reject malformed references before
  // traversing them, so validation fails closed rather than throwing a TypeError.
  if (EDITORIAL_CHECKS.some(name => ['sourceIds','clipIds','segmentIds','evidenceIds']
    .some(key => !Array.isArray(audit.checks?.[name]?.[key])))) return result();
  const hasNews = selectedEditions(job).includes('news');
  for (const name of ['newsAngle','sourceAttribution']) {
    const check = audit.checks?.[name];
    if (!check?.sourceIds?.length || hasNews && !check?.segmentIds?.length) fail(`Check ${name} must cite actual source text and script segments.`);
  }
  const originalIds = new Set(packet.originalNews?.sourceIds ?? []);
  if (hasNews && (!originalIds.size || !audit.checks?.newsAngle?.sourceIds?.some(id => originalIds.has(id)))) fail('News-angle review must cite the original seed story, not only the match result.', originalIds.size ? 'report' : 'content');
  for (const id of new Set([...(audit.checks?.sourceAttribution?.sourceIds ?? []), ...(audit.checks?.newsAngle?.sourceIds ?? [])])) {
    const text = job.sources.find(source => source.id === id)?.text;
    if (sourceIds.has(id) && (typeof text !== 'string' || !text.trim())) fail(`Source ${id} lacks the original excerpt needed for editorial review.`, 'content');
  }
  const narrated = newsSegments(job).filter(segment => segment.mode !== 'original');
  for (const name of ['sourceAttribution','noProductionTalk']) {
    for (const segment of narrated) if (!audit.checks?.[name]?.segmentIds?.includes(segment.id)) fail(`Check ${name} omits narrated segment ${segment.id}.`);
  }
  for (const segment of narrated) for (const factId of segment.factIds ?? []) {
    const fact = job.facts.find(item => item.id === factId);
    if (!fact?.sourceIds?.some(id => audit.checks.sourceAttribution.sourceIds.includes(id))) {
      fail(`Source-attribution review lacks a supporting source for ${segment.id}/${factId}.`,
        fact?.sourceIds?.some(id => sourceIds.has(id)) ? 'report' : 'content');
    }
  }
  for (const name of ['playBoundaries','eventFootageAccuracy']) {
    for (const id of selected) {
      const check = audit.checks?.[name];
      if (!check?.clipIds?.includes(id) || !check.evidenceIds?.some(eid => evidence.get(eid)?.clipId === id)) fail(`Check ${name} lacks actual image evidence for clip ${id}.`);
    }
  }
  const observations = new Map();
  if (!Array.isArray(audit.clipObservations)) fail('Per-clip visual observations are required.');
  for (const item of Array.isArray(audit.clipObservations) ? audit.clipObservations : []) {
    if (!item || typeof item !== 'object') { fail('Clip observation must be an object.'); continue; }
    if (!selectedSet.has(item.clipId) || observations.has(item.clipId)) { fail('Clip observations must reference each selected clip exactly once.'); continue; }
    observations.set(item.clipId, item);
    if (!substantive(item.observation) || !substantive(item.startObservation, 8) || !substantive(item.endObservation, 8)) fail(`Clip ${item.clipId} needs concrete content and start/end observations.`);
    if (!Array.isArray(item.evidenceIds) || !item.evidenceIds.length
        || item.evidenceIds.some(id => evidence.get(id)?.clipId !== item.clipId)) fail(`Clip ${item.clipId} must cite its own generated image evidence.`);
  }
  for (const id of selected) if (!observations.has(id)) fail(`Selected clip ${id} has no independent visual observation.`);
  // A concrete regression guard for the discarded script: production narration
  // cannot be approved merely by labeling the semantic check as passed.
  const productionTalk = /先说明素材边界|目前取得并核验|本片只(?:交代|陈述)|本条视频只交代|球队标识[、，]?比分牌彼此对应|报道中的具体伤情事件没有在本片|不能代替整场比赛|不代表整场比赛覆盖/;
  if (narrated.some(segment => productionTalk.test(segment.text ?? ''))) fail('Narration contains production or verification boilerplate instead of the news.', 'content');
  if (hasNews && job.profile?.sourceScope === 'highlights') {
    const disclosures = newsSegments(job).filter(segment => segment.mode === 'original' && /(?:本场比赛资料画面|比赛资料画面|本场比赛集锦)/.test(segment.text ?? ''));
    if (!disclosures.some(segment => audit.checks?.footageDisclosure?.segmentIds?.includes(segment.id))) fail('Highlights-based news needs an actual on-screen footage disclosure and its segment reference.', disclosures.length ? 'report' : 'content');
  }
  if (!Array.isArray(audit.issues)) fail('Editorial audit issues must be an array.');
  for (const issue of Array.isArray(audit.issues) ? audit.issues : []) {
    if (!issue || typeof issue !== 'object') { fail('Audit issue must be an object.'); continue; }
    if (!['error','warning'].includes(issue.severity) || !issue.code || !substantive(issue.message) || !substantive(issue.suggestion)) fail('Audit issues need a code, severity, concrete problem and correction.');
    for (const [key, allowed] of [['clipIds',selectedSet],['segmentIds',segmentIds],['sourceIds',sourceIds],['evidenceIds',new Set(evidence.keys())]]) {
      if (!Array.isArray(issue[key]) || issue[key].some(id => !allowed.has(id))) fail(`Audit issue ${issue.code ?? ''} contains missing or unknown ${key}.`);
    }
    if (issue.severity === 'error') fail(`Unresolved editorial issue ${issue.code}: ${issue.message}`, 'content');
  }
  return result();
}

export function assertEditorialAudit(job, audit = job.automation?.audit) {
  const result = validateEditorialAudit(job, audit);
  if (!result.valid) throw Error(`Independent editorial audit required before production:\n${result.errors.join('\n')}`);
}
