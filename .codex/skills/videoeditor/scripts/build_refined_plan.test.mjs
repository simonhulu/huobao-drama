import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {alignTimeline, captionsForShot, compilePlan, writeNewOrIdentical} from './build_refined_plan.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const compiler = path.join(scriptDir, 'build_refined_plan.mjs');
const validator = path.join(scriptDir, 'validate_edit_plan.mjs');
const normalized = text => String(text).normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
const boards = texts => texts.map((narration, i) => ({id: i + 100, storyboardNumber: i + 1, narration, duration: 999}));
const titles = [{text: '皇帝，已经下令。', time_begin: 100, time_end: 1900}, {text: '大臣退下。', time_begin: 2200, time_end: 3200}];

test('frozen text tiles across title boundaries with contiguous integer frames', () => {
  const source = boards(['皇帝已经', '下令，大臣', '退下。']);
  const result = alignTimeline(source, titles, 3.403);
  assert.equal(result.totalFrames, 102);
  assert.equal(result.shots.reduce((sum, shot) => sum + shot.frames, 0), 102);
  for (let i = 1; i < result.shots.length; i++) assert.equal(result.shots[i].startFrame, result.shots[i - 1].startFrame + result.shots[i - 1].frames);
  assert.equal(result.shots[0].startFrame, 0);
  assert.match(result.shots[1].startEvidence.method, /estimate; NOT exact word timing/);
  assert.equal(result.shots.at(-1).startFrame + result.shots.at(-1).frames, 102);
});

test('whole title boundary uses next real title start, preserving silence', () => {
  const result = alignTimeline(boards(['皇帝已经下令。', '大臣退下。']), titles, 3.403);
  assert.equal(result.shots[1].startFrame, 66);
  assert.match(result.shots[1].startEvidence.method, /^frozen title start/);
  assert.equal(result.shots[0].frames, 66);
});

test('caption split retains every word and punctuation without duplicated title text', () => {
  const source = boards(['皇帝已经', '下令，大臣', '退下。']);
  const timeline = alignTimeline(source, titles, 3.403);
  const captions = timeline.shots.map((s, i) => captionsForShot({...s, narration: source[i].narration}, timeline.titles));
  assert.equal(captions.flat().map(c => c.text).join(''), '皇帝，已经下令。大臣退下。');
  for (let i = 0; i < captions.length; i++) {
    assert.equal(normalized(captions[i].map(c => c.text).join('')), normalized(source[i].narration));
    for (const c of captions[i]) assert.ok(c.start >= 0 && c.end <= timeline.shots[i].duration && c.end > c.start);
  }
});

test('mismatched, missing and reordered words fail instead of guessing timing', () => {
  for (const narration of ['皇帝没有下令大臣退下', '皇帝已经下令', '大臣退下皇帝已经下令']) assert.throws(() => alignTimeline(boards([narration]), titles, 3.403), /do not rewrite/);
  assert.throws(() => alignTimeline(boards(['皇帝已经下令', '']), titles, 3.403));
});

test('ambiguous title time units, overlap, out of bounds and zero-frame shots fail', () => {
  const source = boards(['甲', '乙']);
  assert.throws(() => alignTimeline(source, [{text: '甲', time_begin: 0, time_end: 900}, {text: '乙', time_begin: 800, time_end: 1100}], 2), /overlapping/);
  assert.throws(() => alignTimeline(source, [{text: '甲乙', time_begin: 0, time_end: 5000}], 2), /milliseconds/);
  assert.throws(() => alignTimeline(source, [{text: '甲乙', time_begin: 0, time_end: 1}], 2), /no frames/);
  assert.throws(() => alignTimeline(source, [{text: '甲乙', time_begin: '0', time_end: 1000}], 2), /milliseconds/);
});

test('AAC duration millisecond rounding does not reject a submillisecond title tail', () => {
  const source = boards(['最后一句']);
  const result = alignTimeline(source, [{text:'最后一句',time_begin:0,time_end:20633.333333}], 20.633);
  assert.equal(result.totalFrames, 619);
  assert.throws(() => alignTimeline(source, [{text:'最后一句',time_begin:0,time_end:20635}], 20.633), /milliseconds/);
});

test('rounded boundaries conserve frames over many fractional shots', () => {
  const text = Array.from({length: 200}, (_, i) => String.fromCodePoint(0x4e00 + i));
  const duration = 61.017;
  const result = alignTimeline(boards(text), [{text: text.join(''), time_begin: 77, time_end: 61000}], duration);
  assert.equal(result.shots.reduce((sum, s) => sum + s.frames, 0), Math.round(duration * 30));
  assert.ok(result.shots.every(s => s.frames > 0));
  assert.ok(Math.abs(result.frameDuration - duration) <= 1 / 60);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refined-plan-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const audio = path.join(dir, 'narration.m4a'), image = path.join(dir, 'image.png');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3.4', '-c:a', 'aac', audio]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:size=32x18', '-frames:v', '1', image]);
  const snapshot = {schemaVersion: 1, episode: {id: 777}, storyboards: boards(['皇帝已经下令。', '大臣退下。']).map(s => ({...s, firstFrameImage: image}))};
  const decisions = snapshot.storyboards.map(s => ({storyboardNumber: s.storyboardNumber, intent: '旁白说明', visualEvidence: '已检查全幅人物图，头部上方有留白', rationale: '保留安静读图，当前动作无需音效', camera: {mode: 'hold', amount: 0, focusX: .5, focusY: .5}, effects: []}));
  return {dir, audio, image, snapshot, decisions, duration: 3.4, titles, stem: 'episode-777-refined-test', outputDir: path.join(dir, 'output')};
}

test('compiler CLI consumes a real frozen AAC/image fixture and validator accepts output', t => {
  const f = fixture(t);
  for (const key of ['snapshot', 'titles', 'decisions']) fs.writeFileSync(path.join(f.dir, key + '.json'), JSON.stringify(f[key]));
  const args = ['--snapshot', path.join(f.dir, 'snapshot.json'), '--titles', path.join(f.dir, 'titles.json'), '--decisions', path.join(f.dir, 'decisions.json'), '--audio', f.audio, '--output-dir', f.outputDir, '--stem', f.stem];
  const stdout = execFileSync(process.execPath, [compiler, ...args], {encoding: 'utf8'});
  assert.equal(JSON.parse(stdout).shots, 2);
  const planPath = path.join(f.outputDir, 'edit-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath));
  assert.equal(plan.episodeId, 777);
  assert.equal(plan.layout, 'single-full-frame');
  assert.equal(plan.sourcePath, f.audio);
  assert.equal(plan.baseDir, path.join(f.outputDir, 'base'));
  assert.equal(plan.sourceFingerprint.length, 64);
  assert.deepEqual(plan.soundAssets, {});
  assert.equal(plan.uploadEncoding.crf,24);
  assert.equal(plan.uploadEncoding.preset,'slow');
  assert.equal(plan.uploadEncoding.maxRateKbps,2000);
  assert.equal(plan.shots[0].sourceDuration, 999);
  assert.equal(plan.shots[0].duration, 2.2);
  assert.ok(plan.shots.every(s => s.effects.length === 0 && s.audioCues.length === 0));
  assert.equal(fs.readFileSync(planPath, 'utf8'), fs.readFileSync(path.join(f.outputDir, 'base', 'edit-plan.json'), 'utf8'));
  const validation = JSON.parse(execFileSync(process.execPath, [validator, path.join(f.outputDir, 'snapshot.json'), planPath], {encoding: 'utf8'}));
  assert.equal(validation.valid, true);
  execFileSync(process.execPath, [compiler, ...args]); // Identical inputs are an idempotent rerun.
  assert.match(fs.readFileSync(plan.shots[0].caption.file, 'utf8'), /皇帝，已经下令。/);
});

test('reviewed encoding exceptions are frozen in both plans and cannot silently raise the budget',t=>{
  const f=fixture(t);
  assert.throws(()=>compilePlan({...f,uploadEncoding:{crf:22}}),/reason/);
  assert.equal(fs.existsSync(f.outputDir),false);
  const {plan,files}=compilePlan({...f,uploadEncoding:{crf:22,maxRateKbps:3000,maxMegabytesPerMinute:25,reason:'Reviewed map labels require more detail'}});
  assert.equal(plan.uploadEncoding.crf,22);
  assert.equal(plan.uploadEncoding.reason,'Reviewed map labels require more detail');
  assert.equal(files.get(path.join(f.outputDir,'edit-plan.json')),files.get(path.join(f.outputDir,'base','edit-plan.json')));
});

test('bad decisions, invalid triggers and incompatible WAV fail before writing', t => {
  const f = fixture(t);
  const missingEvidence = structuredClone(f);
  missingEvidence.decisions[0].visualEvidence = '';
  assert.throws(() => compilePlan(missingEvidence), /visualEvidence/);
  assert.equal(fs.existsSync(f.outputDir), false);
  const wrongTrigger = structuredClone(f);
  wrongTrigger.decisions[0].effects = [{kind: 'reaction-anger', trigger: '下一任皇帝', timingEvidence: {method: 'reviewed title onset'}, space: 'image', x: .2, y: .2, width: .1, height: .1, startFrame: 10, endFrame: 35}];
  assert.throws(() => compilePlan(wrongTrigger), /trigger must belong/);
  assert.equal(fs.existsSync(f.outputDir), false);
  const wave = path.join(f.dir, 'narration.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-i', f.audio, wave]);
  const out = spawnSync(process.execPath, [compiler, '--snapshot', 'unused.json', '--titles', 'unused.json', '--decisions', 'unused.json', '--audio', wave, '--output-dir', f.outputDir, '--stem', f.stem], {encoding: 'utf8'});
  assert.equal(out.status, 1);
  assert.match(out.stderr, /must be AAC/);
  assert.equal(fs.existsSync(f.outputDir), false);
});

test('sound catalog is explicit, evidence-bound, and must retain its full tail', t => {
  const f = fixture(t);
  const sound = path.join(f.dir, 'tick.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000:duration=0.2', sound]);
  f.soundAssets = {tick: {file: sound, duration: .2, gainDb: -12}};
  f.decisions[0].audioCues = [{kind: 'tick', frame: 15, trigger: '下令', reason: '已试听短落版重音', timingEvidence: {method: 'manual sound onset matches reviewed typography impact'}}];
  const {plan} = compilePlan(f);
  assert.equal(plan.shots[0].audioCues.length, 1);
  assert.equal(plan.soundAssets.tick.sourceFingerprint.length, 64);
  const tooLate = structuredClone(f);
  tooLate.decisions[0].audioCues[0].frame = 64;
  assert.throws(() => compilePlan(tooLate), /lose its tail/);
  const unknown = structuredClone(f);
  unknown.decisions[0].audioCues[0].kind = 'kenney-fallback';
  assert.throws(() => compilePlan(unknown), /Unused sound asset|Unknown/);
});

test('changed outputs are never overwritten and conflicts preflight every artifact', t => {
  const f = fixture(t), first = compilePlan(f);
  writeNewOrIdentical(first.files);
  const snapshot = path.join(f.outputDir, 'snapshot.json'), original = fs.readFileSync(snapshot, 'utf8');
  const newFile = path.join(f.outputDir, 'must-not-exist.json');
  assert.throws(() => writeNewOrIdentical(new Map([[newFile, '{}'], [snapshot, 'changed']])) , /Refusing to overwrite/);
  assert.equal(fs.existsSync(newFile), false);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), original);
  f.decisions[0].rationale = '不同镜头决定需要新版本';
  assert.throws(() => writeNewOrIdentical(compilePlan(f).files), /new revision/);
});

test('map routes compile only with stable full-frame geometry and a readable completion hold', t => {
  const f=fixture(t);
  const route={points:[[.2,.4],[.5,.5],[.8,.45]],revealStartOffset:6,revealEndOffset:36,pulseFrames:12,marker:'ship',historyStatus:'illustrative',coordinateSource:'Natural Earth; map.geometry.json'};
  const e={id:'map-route',kind:'map-route',x:0,y:0,width:1,height:1,space:'screen',startFrame:0,endFrame:66,trigger:'皇帝',timingEvidence:{method:'reviewed narration onset; authored map beat'},route};
  f.decisions[0].effects=[e];
  const {plan}=compilePlan(f);
  assert.deepEqual(plan.shots[0].effects[0].route,route);
  for(const patch of [{points:[[0,0],[1920,1080]]},{points:[[.2,.4],[.2,.4]]},{coordinateSource:''},{revealEndOffset:55},{revealStartOffset:36},{pulseFrames:40},{marker:'unknown'}]) {
    const broken=structuredClone(f);
    broken.decisions[0].effects[0].route={...route,...patch};
    assert.throws(()=>compilePlan(broken),/map-route/);
  }
  for(const patch of [{mode:'push',amount:.02},{mode:'hold',amount:0}]) {
    const broken=structuredClone(f);
    broken.decisions[0].camera={...broken.decisions[0].camera,...patch};
    if(patch.mode==='hold') broken.decisions[0].effects[0].space='image';
    assert.throws(()=>compilePlan(broken),/hold camera/);
  }
});
