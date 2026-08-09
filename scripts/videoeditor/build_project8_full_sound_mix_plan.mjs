#!/usr/bin/env node

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const DEFAULT_PLAN = path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json');
const DEFAULT_MUSIC_LIBRARY = path.join(root, 'data/static/music/library.json');
const DEFAULT_OUTPUT = path.join(root, 'data/temp/project-8-full-sound-mix-plan.json');

const SFX = {
  battleAmbience: [
    'sfx/library/historical-reference-only/battlefield_troops_horses_chinaz.mp3',
    'sfx/library/historical-reusable/battlefield_ambience_cc0.mp3',
  ],
  battleCrowd: [
    'sfx/library/historical-reference-only/battle_charge_yells_chinaz.mp3',
    'sfx/library/historical-reusable/battle_crowd_charge_cc0.mp3',
  ],
  battleMelee: [
    'sfx/library/historical-reference-only/chibi_battle_melee_chinaz.mp3',
    'sfx/library/historical-reference-only/ancient_horse_spear_chinaz.mp3',
    'sfx/library/taira-komori/sword_battle_loop.mp3',
  ],
  hoof: 'sfx/library/historical-reusable/horse_hoof_gallop_six_horses_outdoor_loop.mp3',
  bowDraw: 'sfx/library/historical-reference-only/bow_draw_fast_chinaz.mp3',
  bowRelease: 'sfx/library/historical-reference-only/archer_arrow_release_chinaz.mp3',
  arrowWhoosh: 'sfx/library/historical-reference-only/arrow_flight_whoosh_chinaz.mp3',
  arrowImpact: 'sfx/library/historical-reference-only/arrow_solid_impact_chinaz.mp3',
  clash: [
    ...[1, 2, 3, 4, 5].map((number) => `sfx/library/historical-reusable/sword_blade_clash_metal_impact_${String(number).padStart(2, '0')}.mp3`),
    'sfx/library/taira-komori/wow_katana1.mp3',
    'sfx/library/taira-komori/wow_katana2.mp3',
    'sfx/library/taira-komori/sword_attack1.mp3',
    'sfx/library/taira-komori/sword_attack2.mp3',
  ],
  armorHit: 'sfx/library/100-cc0-sfx-v2/sfx100v2_metal_hit_02.mp3',
  weaponDraw: 'sfx/library/rpg-sounds/OGG/drawKnife1.ogg',
  tack: 'sfx/library/rpg-sounds/OGG/handleSmallLeather.ogg',
  wind: 'sfx/library/historical-reusable/rural_gentle_breeze_birds_ambient_loop.mp3',
};

const CUE_CONTRACTS = {
  battle_ambience: {role: 'battlefield_ambience_bed', sourceRole: 'battlefield_ambience', loop: true},
  battle_crowd: {role: 'battle_crowd_charge', sourceRole: 'battle_crowd', loop: true},
  battle_melee: {role: 'battle_melee_bed', sourceRole: 'battle_melee', loop: true},
  weapon_clash_cluster: {role: 'weapon_clash_cluster', sourceRole: 'weapon_clash', loop: false},
  horse_hoof: {role: 'cavalry_hoof_loop', sourceRole: 'cavalry_hoof', loop: true},
  horse_tack: {role: 'sparse_leather_tack', sourceRole: 'horse_tack', loop: true},
  wind_sand: {role: 'open_air_wind_bed', sourceRole: 'open_air_wind', loop: true},
  bow_draw: {role: 'bow_draw_tension', sourceRole: 'bow_draw', loop: false},
  bow_release: {role: 'bow_release', sourceRole: 'bow_release', loop: false},
  arrow_whoosh: {role: 'arrow_flight_whoosh', sourceRole: 'arrow_flight', loop: false},
  arrow_impact: {role: 'arrow_wood_impact', sourceRole: 'arrow_impact', loop: false},
  armor_hit: {role: 'lamellar_impact', sourceRole: 'armor_impact', loop: false},
  weapon_draw: {role: 'weapon_draw', sourceRole: 'weapon_draw', loop: false},
};

const BATTLE_BED = 'static/music/freepacks/qazijamjam-battle/QaziJamJam.wav';

const sequenceProfiles = {
  'seq-01-hunting-death': {emotion: 'tense', intensity: 'high'},
  'seq-02-assault-and-response': {emotion: 'tense', intensity: 'high'},
  'seq-03-wei-qing-childhood': {emotion: 'sad', intensity: 'medium'},
  'seq-04-rise-from-servitude': {emotion: 'tense', intensity: 'medium'},
  'seq-05-power-with-restraint': {emotion: 'epic', intensity: 'medium'},
  'seq-06-huo-qubing-rises': {emotion: 'epic', intensity: 'high'},
  'seq-07-two-ways-of-war': {emotion: 'epic', intensity: 'high'},
  'seq-08-favor-and-character': {emotion: 'tense', intensity: 'medium'},
  'seq-09-li-gan-grievance': {emotion: 'sad', intensity: 'medium'},
  'seq-10-killing-and-coverup': {emotion: 'tense', intensity: 'high'},
  'seq-11-power-conclusion': {emotion: 'calm', intensity: 'low'},
  'seq-12-epilogue': {emotion: 'sad', intensity: 'medium'},
};

const BATTLE_EVENT_PROFILES = {
  // Cavalry raids need the troop bed to lead; clashes remain present but not dominant.
  'evt-028': {name: 'cavalry-breakthrough', volume: {battle_ambience: 1.18, battle_crowd: 0.88, battle_melee: 0.9, weapon_clash_cluster: 0.9}},
  'evt-049': {name: 'light-cavalry-raid', volume: {battle_ambience: 1.2, battle_crowd: 0.9, battle_melee: 0.88, weapon_clash_cluster: 0.9}},
  'evt-053': {name: 'long-range-pursuit', volume: {battle_ambience: 1.16, battle_crowd: 0.9, battle_melee: 0.9, weapon_clash_cluster: 0.88}},
  'evt-067': {name: 'breakthrough-charge', volume: {battle_ambience: 1.16, battle_crowd: 1.04, battle_melee: 0.92, weapon_clash_cluster: 0.96}},
  'evt-086': {name: 'deep-strike', volume: {battle_ambience: 1.16, battle_crowd: 0.96, battle_melee: 0.94, weapon_clash_cluster: 0.96}},
  'evt-096': {name: 'lone-cavalry-escape', volume: {battle_ambience: 1.12, battle_crowd: 0.84, battle_melee: 1.08, weapon_clash_cluster: 1.16}},
  'evt-097': {name: 'banner-capture', volume: {battle_ambience: 0.96, battle_crowd: 1.08, battle_melee: 1.14, weapon_clash_cluster: 1.2}},
  'evt-116': {name: 'decisive-strike', volume: {battle_ambience: 1.08, battle_crowd: 0.94, battle_melee: 1.1, weapon_clash_cluster: 1.14}},
  'evt-117': {name: 'immediate-attack', volume: {battle_ambience: 1.02, battle_crowd: 0.96, battle_melee: 1.16, weapon_clash_cluster: 1.18}},

  // The main line battle moves closer, while the sand encirclement falls back into wind and distance.
  'evt-034': {name: 'army-collapse', volume: {battle_ambience: 0.92, battle_crowd: 1.08, battle_melee: 1.18, weapon_clash_cluster: 1.16}},
  'evt-063': {name: 'defensive-line', volume: {battle_ambience: 0.94, battle_crowd: 1.0, battle_melee: 1.18, weapon_clash_cluster: 1.14}},
  'evt-064': {name: 'sandstorm-encirclement', volume: {battle_ambience: 0.76, battle_crowd: 0.66, battle_melee: 0.68, weapon_clash_cluster: 0.76}},
  'evt-085': {name: 'main-force-defeat', volume: {battle_ambience: 0.94, battle_crowd: 1.06, battle_melee: 1.18, weapon_clash_cluster: 1.14}},

  // Historical callbacks should read as restrained memory, never a full-volume action scene.
  'evt-036': {name: 'restraint-callback', volume: {battle_ambience: 0.7, battle_crowd: 0.62, battle_melee: 0.66, weapon_clash_cluster: 0.7}},
  'evt-084': {name: 'battle-retrospective', volume: {battle_ambience: 0.72, battle_crowd: 0.66, battle_melee: 0.68, weapon_clash_cluster: 0.7}},
  'evt-091': {name: 'victory-retrospective', volume: {battle_ambience: 0.72, battle_crowd: 0.66, battle_melee: 0.68, weapon_clash_cluster: 0.7}},
  'evt-099': {name: 'campaign-context', volume: {battle_ambience: 0.7, battle_crowd: 0.64, battle_melee: 0.66, weapon_clash_cluster: 0.7}},
  'evt-106': {name: 'discipline-callback', volume: {battle_ambience: 0.7, battle_crowd: 0.62, battle_melee: 0.66, weapon_clash_cluster: 0.7}},
  'evt-123': {name: 'aftermath-callback', volume: {battle_ambience: 0.7, battle_crowd: 0.62, battle_melee: 0.66, weapon_clash_cluster: 0.7}},
};

const DEFAULT_BATTLE_PROFILE = {name: 'general-battle', volume: {}};

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(root, process.argv[index + 1]) : fallback;
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function staticPath(relativePath) {
  return path.join(root, 'data', relativePath);
}

function stableIndex(value, size) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

function selectBattleSource({soundBeat, pool, history, eventSources}) {
  const uniquePool = [...new Set(pool)];
  if (!uniquePool.length) throw new Error(`No battle sound sources for ${soundBeat.type}`);

  const usedInEvent = eventSources.get(soundBeat.eventId) || new Set();
  const recent = history.get(soundBeat.type) || [];
  // With N alternatives, keep the last min(3, N - 1) out of rotation. This
  // guarantees no adjacent repeat while using longer pools more evenly.
  const remembered = new Set(recent.slice(-Math.min(3, Math.max(0, uniquePool.length - 1))));
  let candidates = uniquePool.filter((candidate) => !remembered.has(candidate) && !usedInEvent.has(candidate));
  if (!candidates.length) candidates = uniquePool.filter((candidate) => !usedInEvent.has(candidate));
  if (!candidates.length) candidates = uniquePool;

  const selected = candidates[stableIndex(`${soundBeat.eventId}:${soundBeat.type}`, candidates.length)];
  eventSources.set(soundBeat.eventId, new Set([...usedInEvent, selected]));
  history.set(soundBeat.type, [...recent, selected].slice(-3));
  return selected;
}

function battleProfileFor(eventId) {
  return BATTLE_EVENT_PROFILES[eventId] || DEFAULT_BATTLE_PROFILE;
}

function isBattleLayer(type) {
  return type === 'battle_ambience' || type === 'battle_crowd' || type === 'battle_melee';
}

export function soundAssetFor(soundBeat, index, state = {}) {
  const battleHistory = state.battleHistory || new Map();
  const battleEventSources = state.battleEventSources || new Map();
  const rotation = SFX.clash[index % SFX.clash.length];
  const battleSources = {
    battle_ambience: SFX.battleAmbience,
    battle_crowd: SFX.battleCrowd,
    battle_melee: SFX.battleMelee,
  };
  const mappings = {
    weapon_clash_cluster: rotation,
    horse_hoof: SFX.hoof,
    horse_tack: SFX.tack,
    wind_sand: SFX.wind,
    bow_draw: SFX.bowDraw,
    bow_release: SFX.bowRelease,
    arrow_whoosh: SFX.arrowWhoosh,
    arrow_impact: SFX.arrowImpact,
    armor_hit: SFX.armorHit,
    weapon_draw: SFX.weaponDraw,
  };
  const relativePath = isBattleLayer(soundBeat.type)
    ? selectBattleSource({
      soundBeat,
      pool: battleSources[soundBeat.type],
      history: battleHistory,
      eventSources: battleEventSources,
    })
    : mappings[soundBeat.type];
  const contract = CUE_CONTRACTS[soundBeat.type];
  if (!relativePath || !contract) throw new Error(`No reusable local asset mapping for ${soundBeat.type}`);
  return {...contract, relativePath, absolutePath: staticPath(relativePath)};
}

function scoreBgm(entry, profile) {
  const tags = [entry.emotionBucket, entry.emotion_bucket, entry.intensity, ...(entry.tags || []), entry.prompt].map(normalize).join(' ');
  let score = 0;
  if (normalize(entry.emotionBucket || entry.emotion_bucket) === profile.emotion) score += 32;
  if (normalize(entry.intensity) === profile.intensity) score += 14;
  if (tags.includes('historical') || /古琴|古筝|箫|编钟|国风|纪录片/u.test(String(entry.prompt || ''))) score += 8;
  if (Number(entry.duration) >= 75) score += 6;
  if (Number(entry.duration) < 25) score -= 20;
  return score;
}

export function selectBgm(library, profile, index) {
  const entries = (library.entries || [])
    .filter((entry) => entry.relativePath && existsSync(staticPath(String(entry.relativePath).replace(/^\/+/, ''))))
    .map((entry) => ({entry, score: scoreBgm(entry, profile)}))
    .sort((a, b) => b.score - a.score || String(a.entry.relativePath).localeCompare(String(b.entry.relativePath)));
  if (!entries.length || entries[0].score < 10) throw new Error(`No suitable local BGM for ${profile.emotion}/${profile.intensity}`);
  const nearBest = entries.filter(({score}) => score >= entries[0].score - 3).slice(0, 6);
  return nearBest[index % nearBest.length].entry;
}

export function buildProject8FullSoundMixPlan({storyboardPlan, musicLibrary}) {
  const bgmTracks = storyboardPlan.sequences.map((sequence, index) => {
    const profile = sequenceProfiles[sequence.id] || {emotion: 'tense', intensity: 'medium'};
    const directBattleBed = ['seq-01-hunting-death', 'seq-06-huo-qubing-rises', 'seq-07-two-ways-of-war', 'seq-10-killing-and-coverup'].includes(sequence.id);
    const selected = directBattleBed && existsSync(staticPath(BATTLE_BED))
      ? {relativePath: BATTLE_BED, duration: 180, source: 'freepack', prompt: 'battle bed'}
      : selectBgm(musicLibrary, profile, index);
    return {
      id: `bgm-${sequence.id}`,
      role: 'bgm',
      sequenceId: sequence.id,
      startMs: sequence.startMs,
      endMs: sequence.endMs,
      relativePath: selected.relativePath,
      absolutePath: staticPath(selected.relativePath),
      loop: true,
      volume: directBattleBed ? 0.075 : 0.09,
      duckedUnderNarration: true,
      fadeMs: 1200,
      profile,
    };
  });
  const battleAssetState = {battleHistory: new Map(), battleEventSources: new Map()};
  const soundCues = storyboardPlan.soundBeats.map((soundBeat, index) => {
    const asset = soundAssetFor(soundBeat, index, battleAssetState);
    if (!existsSync(asset.absolutePath)) throw new Error(`Required local sound asset is absent: ${asset.absolutePath}`);
    const battleProfile = battleProfileFor(soundBeat.eventId);
    const volumeMultiplier = battleProfile.volume[soundBeat.type] || 1;
    return {
      id: soundBeat.id,
      type: soundBeat.type,
      eventId: soundBeat.eventId,
      startMs: soundBeat.startMs,
      endMs: soundBeat.endMs,
      relativePath: asset.relativePath,
      absolutePath: asset.absolutePath,
      loop: asset.loop,
      role: asset.role,
      sourceRole: asset.sourceRole,
      volume: Number((soundBeat.volume * volumeMultiplier).toFixed(3)),
      layer: soundBeat.layer,
      tags: soundBeat.tags,
      ...(isBattleLayer(soundBeat.type) ? {battleProfile: battleProfile.name} : {}),
    };
  });
  const plan = {
    schemaVersion: 'project8-full-sound-mix-v2',
    durationMs: storyboardPlan.durationMs,
    narrationPolicy: 'one-master-track-postmixed-once',
    bgmTracks,
    soundCues,
  };
  validateProject8FullSoundMixPlan(plan);
  return plan;
}

export function validateProject8FullSoundMixPlan(plan) {
  if (!Number.isFinite(plan.durationMs) || plan.durationMs <= 0) throw new Error('Sound mix duration is invalid');
  if (!plan.bgmTracks.length) throw new Error('Sound mix needs BGM coverage');
  if (!plan.soundCues.length) throw new Error('Sound mix needs planned SFX coverage');
  for (const track of [...plan.bgmTracks, ...plan.soundCues]) {
    if (track.startMs < 0 || track.endMs <= track.startMs || track.endMs > plan.durationMs) throw new Error(`Invalid sound range ${track.id}`);
    if (!track.relativePath || !track.absolutePath || !existsSync(track.absolutePath)) throw new Error(`Missing local source for ${track.id}`);
  }
  const byEvent = new Map();
  for (const cue of plan.soundCues) {
    const contract = CUE_CONTRACTS[cue.type];
    if (!contract || cue.role !== contract.role || cue.sourceRole !== contract.sourceRole || cue.loop !== contract.loop) {
      throw new Error(`Sound cue ${cue.id} violates the semantic contract for ${cue.type}`);
    }
    if (!byEvent.has(cue.eventId)) byEvent.set(cue.eventId, []);
    byEvent.get(cue.eventId).push(cue);
  }
  for (const cues of byEvent.values()) {
    const byType = new Map(cues.map((cue) => [cue.type, cue]));
    if (byType.has('battle_ambience')) {
      const required = ['battle_ambience', 'battle_crowd', 'battle_melee', 'weapon_clash_cluster'];
      if (required.some((type) => !byType.has(type))) throw new Error('Battle cue is missing a required sound layer');
      if (new Set(required.map((type) => byType.get(type).relativePath)).size !== required.length) {
        throw new Error('Battle cue layers must use distinct source files');
      }
    }
    if (byType.has('bow_draw')) {
      const required = ['bow_draw', 'bow_release', 'arrow_whoosh', 'arrow_impact'];
      if (required.some((type) => !byType.has(type))) throw new Error('Archery cue is missing a required action phase');
      if (new Set(required.map((type) => byType.get(type).relativePath)).size !== required.length) {
        throw new Error('Archery draw, release, flight, and impact must use distinct source files');
      }
    }
  }

  for (const type of ['battle_ambience', 'battle_crowd', 'battle_melee']) {
    const ordered = plan.soundCues
      .filter((cue) => cue.type === type)
      .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].relativePath === ordered[index - 1].relativePath) {
        throw new Error(`Adjacent battle events repeat ${type}: ${ordered[index].relativePath}`);
      }
    }
  }
  return {bgmTracks: plan.bgmTracks.length, soundCues: plan.soundCues.length};
}

function main() {
  const storyboardPlan = JSON.parse(readFileSync(argument('--plan', DEFAULT_PLAN), 'utf8'));
  const musicLibrary = JSON.parse(readFileSync(argument('--music-library', DEFAULT_MUSIC_LIBRARY), 'utf8'));
  const output = argument('--output', DEFAULT_OUTPUT);
  const mixPlan = buildProject8FullSoundMixPlan({storyboardPlan, musicLibrary});
  writeFileSync(output, `${JSON.stringify(mixPlan, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({output, ...validateProject8FullSoundMixPlan(mixPlan)}, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
