const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const normalize = (value) => String(value ?? '').toLowerCase();

const includesAny = (text, words) => words.some((word) => text.includes(word));

const mediaUrl = (baseUrl, pathname) => `${String(baseUrl ?? '').replace(/\/$/, '')}/${String(pathname).replace(/^\/+/, '')}`;

const stableId = (prefix, sourceId, suffix = '') => `${prefix}-${String(sourceId).replace(/[^a-zA-Z0-9_-]+/g, '-')}${suffix}`;

function validateTimeline(props) {
  if (!props?.audioSrc) throw new Error('Narrative audio planning requires one narration master');
  if (!Number.isInteger(props.durationMs) || props.durationMs <= 0) throw new Error('Narrative duration must be a positive integer');
  if (!Array.isArray(props.sequences) || props.sequences.length === 0) throw new Error('Narrative sequences are required');
  if (!Array.isArray(props.captions) || props.captions.length === 0) throw new Error('Timed captions are required');
  let cursor = 0;
  for (const sequence of props.sequences) {
    if (sequence.startMs !== cursor || !Number.isInteger(sequence.endMs) || sequence.endMs <= sequence.startMs) {
      throw new Error(`Narrative sequences must be positive and contiguous at ${sequence.id ?? 'unknown'}`);
    }
    cursor = sequence.endMs;
  }
  if (cursor !== props.durationMs) throw new Error(`Narrative sequences must end at ${props.durationMs}ms`);
}

const MUSIC_PROFILES = {
  hook: {
    positive: ['肃杀', '压抑', '权力', '低音弦乐', '不祥', '历史', '庄严'],
    negative: ['轻快', '温暖', '喜悦'],
    volume: 0.13,
    duck: 0.52,
  },
  conflict: {
    positive: ['暴力', '紧张', '冲突', '骤变', '打击乐', '急促', '压迫'],
    negative: ['平和', '舒缓', '希望'],
    volume: 0.14,
    duck: 0.5,
  },
  reflective: {
    positive: ['孤独', '童年', '命运', '沉郁', '隐忍', '忧伤', '箫', '大提琴', '悲凉'],
    negative: ['急促', '暴力', '战鼓', '欢快'],
    volume: 0.105,
    duck: 0.56,
  },
};

function sequenceText(props, sequence) {
  const captionText = props.captions
    .filter((caption) => caption.endMs > sequence.startMs && caption.startMs < sequence.endMs)
    .map((caption) => caption.text)
    .join(' ');
  const roles = (props.shots ?? [])
    .filter((shot) => shot.endMs > sequence.startMs && shot.startMs < sequence.endMs)
    .map((shot) => shot.editorial?.semanticRole)
    .filter(Boolean)
    .join(' ');
  return normalize(`${sequence.title ?? ''} ${captionText} ${roles}`);
}

function classifyMusicProfile(props, sequence, index) {
  const text = sequenceText(props, sequence);
  if (index === 0) return 'hook';
  if (includesAny(text, ['童年', '小时候', '放羊', '奴仆', '孤独', '苦难', '身世'])) return 'reflective';
  if (includesAny(text, ['袭击', '复仇', '打伤', '动了手', '杀人', '杀死', '愤怒', '冲突', 'crisis'])) return 'conflict';
  return 'conflict';
}

function scoreMusic(entry, profileName) {
  const profile = MUSIC_PROFILES[profileName];
  const haystack = normalize(`${entry.prompt ?? ''} ${entry.emotionBucket ?? ''} ${entry.intensity ?? ''} ${(entry.tags ?? []).join(' ')}`);
  let score = 0;
  for (const keyword of profile.positive) if (haystack.includes(normalize(keyword))) score += 4;
  for (const keyword of profile.negative) if (haystack.includes(normalize(keyword))) score -= 5;
  if (profileName === 'conflict' && entry.intensity === 'high') score += 2;
  if (profileName === 'reflective' && entry.intensity === 'low') score += 2;
  if (Number(entry.duration) >= 45) score += 1;
  return score;
}

function chooseMusic(entries, profileName, used) {
  const ranked = entries
    .map((entry) => ({entry, score: scoreMusic(entry, profileName)}))
    .sort((a, b) => b.score - a.score || String(a.entry.relativePath).localeCompare(String(b.entry.relativePath)));
  return ranked.find(({entry, score}) => score > 0 && !used.has(entry.relativePath))
    ?? ranked.find(({score}) => score > 0)
    ?? null;
}

function planMusic(props, musicLibrary, baseUrl) {
  const entries = musicLibrary?.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Music library has no indexed entries');
  const used = new Set();
  const decisions = [];
  const crossfadeMs = 1200;
  const tracks = props.sequences.map((sequence, index) => {
    const profileName = classifyMusicProfile(props, sequence, index);
    const selected = chooseMusic(entries, profileName, used);
    if (!selected) throw new Error(`Music library has no suitable entry for ${sequence.id}`);
    used.add(selected.entry.relativePath);
    const profile = MUSIC_PROFILES[profileName];
    const startMs = index === 0 ? sequence.startMs : Math.max(0, sequence.startMs - crossfadeMs);
    const endMs = index === props.sequences.length - 1 ? sequence.endMs : Math.min(props.durationMs, sequence.endMs + crossfadeMs);
    const track = {
      id: stableId('bgm', sequence.id),
      src: mediaUrl(baseUrl, selected.entry.relativePath),
      startMs,
      endMs,
      sourceStartMs: 0,
      volume: profile.volume,
      narrationDuck: profile.duck,
      fadeInMs: index === 0 ? 900 : crossfadeMs,
      fadeOutMs: index === props.sequences.length - 1 ? 1600 : crossfadeMs,
      loop: Number(selected.entry.duration) * 1000 < endMs - startMs,
      tags: ['narrative-bgm', profileName, ...(selected.entry.tags ?? [])],
      gainPoints: profileName === 'conflict'
        ? [{atMs: 0, gain: 0.84}, {atMs: Math.round((endMs - startMs) * 0.58), gain: 1}, {atMs: endMs - startMs, gain: 0.92}]
        : profileName === 'reflective'
          ? [{atMs: 0, gain: 0.82}, {atMs: Math.round((endMs - startMs) * 0.48), gain: 0.94}, {atMs: endMs - startMs, gain: 0.72}]
          : [{atMs: 0, gain: 0.8}, {atMs: Math.round((endMs - startMs) * 0.62), gain: 1}, {atMs: endMs - startMs, gain: 0.88}],
    };
    decisions.push({kind: 'bgm', targetId: sequence.id, profile: profileName, selectedPath: selected.entry.relativePath, score: selected.score});
    return track;
  });
  return {tracks, decisions};
}

const EVENT_DEFINITIONS = {
  'battle-ambience': {target: ['battlefield', 'battle', 'ambience'], semanticRole: 'battlefield_ambience', forbidden: ['ui'], role: 'ambience', volume: 0.18, tags: ['battle', 'ambient', 'distant']},
  'battle-crowd': {target: ['battle', 'crowd', 'charge'], semanticRole: 'battle_crowd', forbidden: ['ui'], role: 'ambience', volume: 0.14, tags: ['battle', 'crowd', 'charge']},
  'battle-melee': {target: ['battle', 'melee', 'swords'], semanticRole: 'battle_melee', forbidden: ['ui'], role: 'ambience', volume: 0.16, tags: ['battle', 'melee', 'combat']},
  'battle-clash': {target: ['sword', 'blade', 'clash', 'metal'], semanticRole: 'weapon_clash', forbidden: ['ui'], role: 'impact', volume: 0.29, tags: ['battle', 'sword', 'clash']},
  horse: {target: ['horse', 'hoof', 'gallop'], semanticRole: 'cavalry_hoof', forbidden: ['ui'], role: 'foley', volume: 0.22, tags: ['horse', 'hoof', 'gallop', 'historical']},
  'weapon-draw': {target: ['weapon', 'draw', 'metal'], required: ['draw'], forbidden: ['ui'], role: 'foley', volume: 0.16, tags: ['weapon', 'draw', 'metal']},
  'sword-clash': {target: ['sword', 'blade', 'clash', 'metal', 'impact'], forbidden: ['ui'], role: 'impact', volume: 0.29, tags: ['sword', 'blade', 'clash', 'metal', 'impact']},
  'bow-draw': {target: ['bow', 'draw', 'tension'], semanticRole: 'bow_draw', forbidden: ['ui'], role: 'foley', volume: 0.18, tags: ['bow', 'draw', 'tension']},
  'bow-release': {target: ['bow', 'string', 'release', 'arrow'], semanticRole: 'bow_release', forbidden: ['ui'], role: 'foley', volume: 0.22, tags: ['bow', 'string', 'release', 'arrow']},
  'arrow-flight': {target: ['arrow', 'flight', 'whoosh'], semanticRole: 'arrow_flight', forbidden: ['ui'], role: 'foley', volume: 0.22, tags: ['arrow', 'flight', 'whoosh']},
  'arrow-impact': {target: ['arrow', 'impact', 'wood'], semanticRole: 'arrow_impact', forbidden: ['sword', 'blade', 'ui'], role: 'impact', volume: 0.26, tags: ['arrow-impact', 'impact', 'historical']},
  rural: {target: ['rural', 'breeze', 'birds', 'ambient', 'outdoor'], forbidden: ['ui'], role: 'ambience', volume: 0.08, tags: ['rural', 'ambient', 'outdoor']},
  'collapse-impact': {target: ['collapse', 'debris', 'stone', 'impact'], forbidden: ['ui'], role: 'impact', volume: 0.28, tags: ['collapse', 'impact']},
};

function detectSoundEvents(props) {
  const events = [];
  const captions = props.captions;
  const roleAt = (timeMs) => (props.shots ?? []).find((shot) => timeMs >= shot.startMs && timeMs < shot.endMs)?.editorial?.semanticRole;
  const battlePattern = /大战|战场|交战|迎战|包围|全军覆没|冲进|杀出来|斩杀|俘获|奔袭|出兵|主力|厮杀/;
  const archeryPattern = /射杀|射死|放箭|中箭|把他射|弓箭|骑马射箭/;
  const windowAt = (caption, ratio, durationMs) => {
    const duration = caption.endMs - caption.startMs;
    const startMs = Math.max(caption.startMs, Math.round(caption.startMs + duration * ratio - durationMs * 0.35));
    return {startMs, endMs: Math.min(caption.endMs, startMs + durationMs)};
  };

  for (const caption of captions) {
    const duration = caption.endMs - caption.startMs;
    const directBattle = battlePattern.test(caption.text) && !/没有赶上主战场|未到战场|迷路/.test(caption.text);
    if (directBattle) {
      for (const eventType of ['battle-ambience', 'battle-crowd', 'battle-melee']) {
        events.push({eventType, sourceId: caption.id, text: caption.text, startMs: caption.startMs, endMs: caption.endMs, required: true});
      }
      const clash = windowAt(caption, 0.58, 1800);
      events.push({eventType: 'battle-clash', sourceId: caption.id, text: caption.text, ...clash, required: true});
    }
    if (/打猎|猎场|骑兵|八百骑|一万骑|数十骑|奔马/.test(caption.text)) {
      events.push({eventType: 'horse', sourceId: caption.id, text: caption.text, startMs: caption.startMs < 500 ? 0 : Math.max(0, caption.startMs - 200), endMs: caption.endMs});
    }
    if (/愤怒|拔刀|抽刀|亮出兵器/.test(caption.text)) {
      const startMs = caption.startMs + Math.round(duration * 0.28);
      events.push({eventType: 'weapon-draw', sourceId: caption.id, text: caption.text, startMs, endMs: Math.min(props.durationMs, startMs + 1050)});
    }
    if (!directBattle && /动了手|打伤|交战|打斗|厮杀|刀剑相/.test(caption.text) && !['comparison', 'resolution'].includes(roleAt(caption.startMs))) {
      const startMs = caption.startMs + Math.round(duration * 0.16);
      events.push({eventType: 'sword-clash', sourceId: caption.id, text: caption.text, startMs, endMs: Math.min(props.durationMs, startMs + 1150)});
    }
    if (/放羊|牧羊|乡野|田野/.test(caption.text)) {
      events.push({eventType: 'rural', sourceId: caption.id, text: caption.text, startMs: caption.startMs, endMs: caption.endMs});
    }
    if (/崩塌|倒塌|坍塌|轰然倒下/.test(caption.text)) {
      const startMs = caption.startMs + Math.round(duration * 0.62);
      events.push({eventType: 'collapse-impact', sourceId: caption.id, text: caption.text, startMs, endMs: Math.min(props.durationMs, startMs + 1200)});
    }
    if (archeryPattern.test(caption.text)) {
      for (const [eventType, ratio, durationMs] of [
        ['bow-draw', 0.22, 900],
        ['bow-release', 0.38, 800],
        ['arrow-flight', 0.48, 950],
        ['arrow-impact', 0.62, 850],
      ]) {
        events.push({eventType, sourceId: caption.id, text: caption.text, ...windowAt(caption, ratio, durationMs), required: true});
      }
    }
  }

  const ordered = events
    .filter((event) => event.endMs > event.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.eventType.localeCompare(b.eventType));
  const merged = [];
  for (const event of ordered) {
    const previous = merged.at(-1);
    if (previous?.eventType === event.eventType && event.startMs - previous.endMs <= 300) {
      previous.endMs = Math.max(previous.endMs, event.endMs);
      previous.text = `${previous.text} ${event.text}`;
      continue;
    }
    merged.push({...event});
  }
  return merged;
}

function scoreSfx(entry, definition) {
  const keywords = new Set((entry.keywords ?? []).map(normalize));
  const roles = new Set((entry.roles ?? []).map(normalize));
  const haystack = normalize(`${entry.relativePath ?? ''} ${entry.title ?? ''} ${[...keywords].join(' ')}`);
  if (definition.forbidden.some((word) => haystack.includes(normalize(word)))) return -Infinity;
  if (definition.semanticRole && !roles.has(normalize(definition.semanticRole))) return -Infinity;
  if (definition.required?.length && !definition.required.some((word) => haystack.includes(normalize(word)))) return -Infinity;
  let score = 0;
  for (const target of definition.target) {
    if ([...keywords].some((keyword) => keyword.includes(target) || target.includes(keyword))) score += 5;
  }
  for (const context of definition.context ?? []) if (haystack.includes(normalize(context))) score += 2;
  if (keywords.has('historical')) score += 2;
  if (keywords.has('reusable')) score += 1;
  if (definition.role === 'ambience' && (keywords.has('ambient') || keywords.has('loopable') || keywords.has('loop'))) score += 3;
  if (definition.semanticRole && roles.has(normalize(definition.semanticRole))) score += 40;
  return score;
}

function chooseSfx(entries, eventType) {
  const definition = EVENT_DEFINITIONS[eventType];
  const ranked = entries
    .map((entry) => ({entry, score: scoreSfx(entry, definition)}))
    .filter(({score}) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score || String(a.entry.relativePath).localeCompare(String(b.entry.relativePath)));
  const minimum = definition.role === 'ambience' ? 10 : 5;
  return ranked.find(({score}) => score >= minimum) ?? null;
}

function planSound(props, sfxMapping, baseUrl) {
  const entries = Array.isArray(sfxMapping?.entries) ? sfxMapping.entries : [];
  const events = detectSoundEvents(props);
  const soundCues = [];
  const decisions = [];
  const unresolvedEvents = [];
  for (const event of events) {
    const selected = chooseSfx(entries, event.eventType);
    if (!selected) {
      unresolvedEvents.push({...event, reason: 'no-library-match'});
      continue;
    }
    const definition = EVENT_DEFINITIONS[event.eventType];
    soundCues.push({
      id: stableId('sfx', event.sourceId, `-${event.eventType}`),
      src: mediaUrl(baseUrl, `sfx/${selected.entry.relativePath}`),
      startMs: event.startMs,
      endMs: event.endMs,
      volume: definition.volume,
      fadeInMs: definition.role === 'ambience' ? 220 : 0,
      fadeOutMs: definition.role === 'ambience' ? 420 : 120,
      loop: definition.role === 'ambience',
      role: definition.role,
      semanticRole: definition.semanticRole ?? null,
      sourceId: event.sourceId,
      eventType: event.eventType,
      tags: definition.tags,
    });
    decisions.push({kind: 'sfx', targetId: event.sourceId, eventType: event.eventType, selectedPath: selected.entry.relativePath, score: selected.score, text: event.text});
  }
  return {soundCues, decisions, unresolvedEvents, eventCount: events.length};
}

export function assertNarrativeAudioProductionReady(audioDesign) {
  const requiredFailures = audioDesign.unresolvedEvents.filter((event) => event.required);
  if (requiredFailures.length) {
    throw new Error(`Required narrative sound roles are unresolved: ${requiredFailures.map((event) => `${event.eventType}:${event.reason}`).join(', ')}`);
  }
  if (audioDesign.metrics.soundableEventCoverage < 1) {
    throw new Error(`Narrative audio coverage is incomplete: ${Math.round(audioDesign.metrics.soundableEventCoverage * 100)}%`);
  }
  return audioDesign;
}

export function planNarrativeAudioDesign({props, musicLibrary, sfxMapping, baseUrl = 'http://127.0.0.1:5679', strict = false}) {
  validateTimeline(props);
  const music = planMusic(props, musicLibrary, baseUrl);
  const sound = planSound(props, sfxMapping, baseUrl);
  const resolvedEvents = sound.soundCues.length;
  const design = {
    bgmTracks: music.tracks,
    soundCues: sound.soundCues,
    decisions: [...music.decisions, ...sound.decisions],
    unresolvedEvents: sound.unresolvedEvents,
    metrics: {
      sequenceMusicCoverage: music.tracks.length / props.sequences.length,
      soundableEventCoverage: sound.eventCount === 0 ? 1 : resolvedEvents / sound.eventCount,
      soundableEvents: sound.eventCount,
      resolvedSoundEvents: resolvedEvents,
      unresolvedSoundEvents: sound.unresolvedEvents.length,
    },
  };
  return strict ? assertNarrativeAudioProductionReady(design) : design;
}
