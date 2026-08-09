import assert from 'node:assert/strict';
import test from 'node:test';

import {planNarrativeAudioDesign} from './narrative_audio_planner.mjs';

const musicLibrary = {
  entries: [
    {filename: 'tension.mp3', relativePath: 'static/music/tension.mp3', duration: 120, prompt: '纪录片低音弦乐，压抑肃杀，适合冲突与权力', emotionBucket: 'tense', intensity: 'high', tags: ['tense', 'high']},
    {filename: 'violence.mp3', relativePath: 'static/music/violence.mp3', duration: 90, prompt: '纪录片弦乐与打击乐，骤变的紧张节奏，从庄严坠入暴力', emotionBucket: 'tense', intensity: 'high', tags: ['tense', 'high']},
    {filename: 'solitude.mp3', relativePath: 'static/music/solitude.mp3', duration: 100, prompt: '纪录片低音大提琴与箫，沉郁而隐忍，适合孤独童年与命运转折', emotionBucket: 'sad', intensity: 'low', tags: ['sad', 'low']},
  ],
};

const sfxMapping = {
  entries: [
    {pack: 'historical-reusable', relativePath: 'library/historical-reusable/horse.mp3', keywords: ['horse', 'hoof', 'gallop', 'historical', 'outdoor', 'loopable'], roles: ['cavalry_hoof']},
    {pack: 'historical-reusable', relativePath: 'library/historical-reusable/sword.mp3', keywords: ['sword', 'blade', 'clash', 'metal', 'impact', 'historical']},
    {pack: 'historical-reusable', relativePath: 'library/historical-reusable/bow.mp3', keywords: ['bow', 'string', 'release', 'arrow', 'historical'], roles: ['bow_release']},
    {pack: 'historical-reusable', relativePath: 'library/historical-reusable/bow-draw.mp3', keywords: ['bow', 'draw', 'tension'], roles: ['bow_draw']},
    {pack: 'historical-reusable', relativePath: 'library/historical-reusable/arrow-flight.mp3', keywords: ['arrow', 'flight', 'whoosh'], roles: ['arrow_flight']},
    {pack: 'cc0', relativePath: 'library/cc0/hit.mp3', keywords: ['arrow', 'impact', 'wood'], roles: ['arrow_impact']},
    {pack: 'historical-reusable', relativePath: 'library/historical-reusable/rural.mp3', keywords: ['rural', 'breeze', 'birds', 'ambient', 'outdoor', 'loopable']},
    {pack: 'misc', relativePath: 'library/misc/click.mp3', keywords: ['ui', 'click']},
  ],
};

const props = {
  durationMs: 30000,
  audioSrc: 'narration.mp3',
  sequences: [
    {id: 'seq-hunt', title: '皇家猎场的死亡谜案', startMs: 0, endMs: 10000},
    {id: 'seq-conflict', title: '袭击与复仇', startMs: 10000, endMs: 22000},
    {id: 'seq-childhood', title: '孤独的童年', startMs: 22000, endMs: 30000},
  ],
  captions: [
    {id: 'c1', text: '汉武帝带着群臣到甘泉宫打猎。', startMs: 0, endMs: 4000},
    {id: 'c2', text: '射死李敢的人是霍去病。', startMs: 4000, endMs: 8000},
    {id: 'c3', text: '李敢一时愤怒，对卫青动了手。', startMs: 10500, endMs: 15000},
    {id: 'c4', text: '霍去病却在猎场上直接要了李敢的命。', startMs: 15500, endMs: 21000},
    {id: 'c5', text: '卫青小时候被使唤出去放羊。', startMs: 24500, endMs: 29500},
  ],
  shots: [
    {id: 's1', startMs: 0, endMs: 10000, editorial: {semanticRole: 'hook'}},
    {id: 's2', startMs: 10000, endMs: 22000, editorial: {semanticRole: 'crisis'}},
    {id: 's3', startMs: 22000, endMs: 30000, editorial: {semanticRole: 'establishing'}},
  ],
};

test('plans deterministic sequence BGM and semantic reusable SFX without fixed project timestamps', () => {
  const input = {props, musicLibrary, sfxMapping, baseUrl: 'http://media.local'};
  const first = planNarrativeAudioDesign(input);
  const second = planNarrativeAudioDesign(input);

  assert.deepEqual(first, second);
  assert.equal(first.bgmTracks.length, 3);
  assert.deepEqual(first.bgmTracks.map((track) => track.src), [
    'http://media.local/static/music/tension.mp3',
    'http://media.local/static/music/violence.mp3',
    'http://media.local/static/music/solitude.mp3',
  ]);
  assert.ok(first.bgmTracks[0].endMs > first.bgmTracks[1].startMs, 'adjacent BGM sections should crossfade');

  const tags = first.soundCues.flatMap((cue) => cue.tags ?? []);
  assert.ok(tags.includes('horse'));
  assert.ok(tags.includes('sword'));
  assert.ok(tags.includes('bow'));
  assert.ok(tags.includes('arrow-impact'));
  assert.ok(tags.includes('rural'));
  assert.equal(first.soundCues.some((cue) => cue.role === 'narration'), false);
  assert.equal(new Set([...first.bgmTracks, ...first.soundCues].map((item) => item.id)).size, first.bgmTracks.length + first.soundCues.length);
  assert.equal(first.metrics.sequenceMusicCoverage, 1);
  assert.ok(first.metrics.soundableEventCoverage >= 0.8);
});

test('omits unrelated library entries and reports unresolved soundable events', () => {
  const result = planNarrativeAudioDesign({
    props: {
      durationMs: 5000,
      audioSrc: 'voice.mp3',
      sequences: [{id: 'seq', title: '城门崩塌', startMs: 0, endMs: 5000}],
      captions: [{id: 'c1', text: '巨大的城门轰然倒塌。', startMs: 0, endMs: 5000}],
      shots: [{id: 's1', startMs: 0, endMs: 5000, editorial: {semanticRole: 'crisis'}}],
    },
    musicLibrary,
    sfxMapping: {entries: [{pack: 'ui', relativePath: 'library/ui/click.mp3', keywords: ['click', 'ui']}]},
    baseUrl: 'http://media.local',
  });

  assert.equal(result.soundCues.length, 0);
  assert.equal(result.unresolvedEvents.length, 1);
  assert.equal(result.unresolvedEvents[0].eventType, 'collapse-impact');
});

test('requires complete, semantically distinct battle and archery systems for a production mix', () => {
  const battleProps = {
    durationMs: 12000,
    audioSrc: 'voice.mp3',
    sequences: [{id: 'battle', title: '骑兵冲入战场', startMs: 0, endMs: 12000}],
    captions: [
      {id: 'battle-1', text: '八百骑冲进战场，双方交战厮杀。', startMs: 0, endMs: 6000},
      {id: 'arrow-1', text: '霍去病拉弓放箭，箭矢射中敌军。', startMs: 6000, endMs: 12000},
    ],
    shots: [{id: 'battle-shot', startMs: 0, endMs: 12000, editorial: {semanticRole: 'crisis'}}],
  };
  const completeMapping = {
    entries: [
      {relativePath: 'library/historical/battlefield.mp3', keywords: ['battle', 'battlefield', 'ambience'], roles: ['battlefield_ambience']},
      {relativePath: 'library/historical/crowd.mp3', keywords: ['battle', 'crowd', 'charge'], roles: ['battle_crowd']},
      {relativePath: 'library/historical/melee.mp3', keywords: ['battle', 'melee', 'swords'], roles: ['battle_melee']},
      {relativePath: 'library/historical/horse.mp3', keywords: ['horse', 'hoof', 'gallop'], roles: ['cavalry_hoof']},
      {relativePath: 'library/historical/draw.mp3', keywords: ['bow', 'draw', 'tension'], roles: ['bow_draw']},
      {relativePath: 'library/historical/release.mp3', keywords: ['bow', 'release', 'string'], roles: ['bow_release']},
      {relativePath: 'library/historical/flyby.mp3', keywords: ['arrow', 'flight', 'whoosh'], roles: ['arrow_flight']},
      {relativePath: 'library/historical/impact.mp3', keywords: ['arrow', 'impact', 'wood'], roles: ['arrow_impact']},
      {relativePath: 'library/historical/clash.mp3', keywords: ['sword', 'blade', 'clash', 'metal'], roles: ['weapon_clash']},
    ],
  };

  const design = planNarrativeAudioDesign({props: battleProps, musicLibrary, sfxMapping: completeMapping, baseUrl: 'http://media.local', strict: true});
  const byCaption = new Map();
  for (const cue of design.soundCues) {
    if (!byCaption.has(cue.sourceId)) byCaption.set(cue.sourceId, []);
    byCaption.get(cue.sourceId).push(cue);
  }
  const battleCues = byCaption.get('battle-1');
  assert.deepEqual(new Set(battleCues.map((cue) => cue.semanticRole)), new Set(['battlefield_ambience', 'battle_crowd', 'battle_melee', 'cavalry_hoof', 'weapon_clash']));
  const arrowCues = byCaption.get('arrow-1');
  assert.deepEqual(new Set(arrowCues.map((cue) => cue.semanticRole)), new Set(['bow_draw', 'bow_release', 'arrow_flight', 'arrow_impact']));
  assert.equal(new Set(arrowCues.map((cue) => cue.src)).size, 4);

  assert.throws(
    () => planNarrativeAudioDesign({
      props: battleProps,
      musicLibrary,
      sfxMapping: {entries: completeMapping.entries.filter((entry) => !entry.roles.includes('battle_crowd'))},
      baseUrl: 'http://media.local',
      strict: true,
    }),
    /battle-crowd.*no-library-match/i,
  );
});

test('fails closed when narration, sequences, or library contracts are malformed', () => {
  assert.throws(() => planNarrativeAudioDesign({props: {...props, audioSrc: null}, musicLibrary, sfxMapping}), /narration master/i);
  assert.throws(() => planNarrativeAudioDesign({props: {...props, sequences: [{id: 'bad', title: 'bad', startMs: 1, endMs: 30000}]}, musicLibrary, sfxMapping}), /contiguous/i);
  assert.throws(() => planNarrativeAudioDesign({props, musicLibrary: {entries: []}, sfxMapping}), /music library/i);
});
