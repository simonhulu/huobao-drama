import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createJob, validateJob, refreshStatus, approveJob, assertApproved, editorialDigest, fileHash, writeJson, readJson, digest} from './core.mjs';
import {importMedia, withJobLock, renderInputDigest, validateRenderProduction} from './cli.mjs';
import {buildReview} from './review.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const match = {id:'test-game',league:'CBA',date:'2026-10-18',home:'南京',away:'广东',score:'96–95',verified:true};
function temporary(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cba-contract-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir;
}
function researched() {
  const job=createJob(match);
  job.sources=[{id:'s1',url:'https://example.com/report',title:'测试来源'}];
  job.facts=[{id:'f1',text:'南京96–95广东。',sourceIds:['s1'],verified:true}];
  job.news={title:'测试新闻',summary:'测试简介',segments:[{id:'n1',text:'南京一分取胜。',factIds:['f1'],clipIds:[]}]};
  job.highlights={title:'测试集锦',clipIds:[]};return job;
}

test('editing the material scope preserves output size and duration settings needed by render', t => {
  const dir=temporary(t),job=researched();
  writeJson(path.join(dir,'job.json'),job);
  writeJson(path.join(dir,'edit.json'),{profile:{sourceScope:'highlights',preset:'fast'}});
  execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'edit','--job',dir,'--input',path.join(dir,'edit.json')]);
  assert.deepEqual(readJson(path.join(dir,'job.json')).profile,{...job.profile,sourceScope:'highlights',preset:'fast'});
});
async function ready(t) {
  const dir=temporary(t),job=researched(),file=path.join(dir,'source.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',file]);
  await importMedia(job,{file,matchConfirmed:true});
  job.clips=[{id:'c1',mediaId:'replay',start:.3,end:1.3,label:'测试回合',factIds:['f1'],verified:true,verificationNote:'合成素材，仅用于门禁测试'}];
  job.news.segments[0].clipIds=['c1'];job.highlights.clipIds=['c1'];
  return {job,dir,file};
}

test('missing recording produces a clearly incomplete preview and cannot be approved',async t=>{
  const dir=temporary(t),job=researched();
  refreshStatus(job);assert.equal(job.status,'waiting_for_media');
  const result=await buildReview(job,dir);
  assert.equal(result.complete,false);assert.equal(result.clipCount,0);
  assert.match(fs.readFileSync(result.path,'utf8'),/尚未分配时间码/);
  assert.throws(()=>approveJob(job,{digest:editorialDigest(job),note:'确认方案'}),/complete review/);
  await assert.rejects(assertApproved(job),/User approval/);
});

test('approval requires current complete review; edits and changed recording revoke permission',async t=>{
  const {job,dir,file}=await ready(t);
  assert.throws(()=>approveJob(job,{digest:editorialDigest(job),note:'已确认'}),/complete review/);
  const review=await buildReview(job,dir);assert.equal(review.complete,true);
  const clip=path.join(dir,'review/clips/c1.mp4');assert.ok(fs.statSync(clip).size>100);
  approveJob(job,{digest:review.digest,note:'用户已看过并确认本版稿件和片段'});
  await assertApproved(job);
  const old=job.news.segments[0].text;job.news.segments[0].text+='更新。';
  await assert.rejects(assertApproved(job),/User approval/);
  job.news.segments[0].text=old;
  fs.appendFileSync(file,Buffer.from('changed'));
  await assert.rejects(assertApproved(job),/changed after review/);
  await assert.rejects(buildReview(job,dir),/changed since import/);
});

test('invalid evidence, unverified clips and overlapping highlights fail readiness',async t=>{
  const {job}=await ready(t);assert.deepEqual(validateJob(job,{ready:true}).errors,[]);
  job.facts[0].sourceIds=['nonexistent'];job.clips[0].verified=false;
  job.clips.push({...job.clips[0],id:'c2',start:1,end:2});job.highlights.clipIds.push('c2');
  const errors=validateJob(job,{ready:true}).errors.join('\n');
  assert.match(errors,/existing sourceIds/);assert.match(errors,/visual verification/);assert.match(errors,/overlap/);
});

test('versioned titles are checked before approval and both platform titles bind the editorial digest',async t=>{
  const {job}=await ready(t);
  const oldDigest=editorialDigest(job);
  job.profile.titlePolicy='source-date-cba-v1';
  assert.notEqual(editorialDigest(job),oldDigest);
  assert.ok(validateJob(job,{ready:true}).errors.length>0);
  job.match.seedUrls=[job.sources[0].url];
  job.news.title='2026-10-18 CBA｜南京一分取胜';job.news.shortTitle='CBA南京一分取胜';
  job.highlights.title='2026-10-18 CBA｜南京广东关键回合集锦';job.highlights.shortTitle='CBA南京广东关键回合';
  assert.deepEqual(validateJob(job,{ready:true}).errors,[]);
  job.approval={digest:editorialDigest(job)};job.outputs={test:true};
  job.news.shortTitle='CBA南京险胜广东';refreshStatus(job);
  assert.equal(job.approval,null);assert.equal(job.outputs,null);
  job.news.title='2026-10-19 CBA｜南京一分取胜';
  assert.ok(validateJob(job,{ready:true}).errors.length>0,'wrong match date cannot pass the paid-work gate');
});

test('edited highlights require an explicit source scope and remain fact and media checked',async t=>{
  const {job,dir}=await ready(t);
  job.media[0].kind='highlights';
  assert.match(validateJob(job,{ready:true}).errors.join('\n'),/full replay/);
  refreshStatus(job);assert.equal(job.status,'waiting_for_media');
  const originalDigest=editorialDigest(job);
  job.profile.sourceScope='highlights';
  assert.notEqual(editorialDigest(job),originalDigest,'source scope must invalidate review approval');
  assert.deepEqual(validateJob(job,{ready:true}).errors,[]);
  refreshStatus(job);assert.equal(job.status,'awaiting_review');
  const review=await buildReview(job,dir);
  assert.equal(review.complete,true);
  assert.match(fs.readFileSync(review.path,'utf8'),/素材范围：已剪辑集锦/);
  assert.match(fs.readFileSync(review.path,'utf8'),/不代表整场比赛覆盖/);
  job.media[0].matchConfirmed=false;
  assert.match(validateJob(job,{ready:true}).errors.join('\n'),/match identity/);
  job.media[0].matchConfirmed=true;job.clips[0].verified=false;
  assert.match(validateJob(job,{ready:true}).errors.join('\n'),/visual verification/);
  job.clips[0].verified=true;job.facts[0].verified=false;
  assert.match(validateJob(job,{ready:true}).errors.join('\n'),/Fact f1 is not verified/);
});

test('highlight source scope cannot make missing footage or an unknown scope ready',async t=>{
  const job=researched();
  job.profile.sourceScope='highlights';
  refreshStatus(job);assert.equal(job.status,'waiting_for_media');
  assert.match(validateJob(job,{ready:true}).errors.join('\n'),/local replay or highlights/);
  job.profile.sourceScope='any-file';
  assert.match(validateJob(job).errors.join('\n'),/sourceScope/);
});

test('preview escapes source and script text rather than injecting HTML',async t=>{
  const dir=temporary(t),job=researched();job.news.segments[0].text='<script>alert(1)</script>';
  const result=await buildReview(job,dir),html=fs.readFileSync(result.path,'utf8');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('same game from multiple stories is grouped even with different candidate ids',t=>{
  const dir=temporary(t),file=path.join(dir,'candidates.json');
  writeJson(file,[{match,reason:'赛果',sourceUrls:['https://example.com/one']},
    {match:{...match,id:'another-story'},reason:'球员表现',sourceUrls:['https://example.com/two']}]);
  const output=JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'recommend','--input',file],{encoding:'utf8'}));
  assert.equal(output.length,1);assert.equal(output[0].sourceUrls.length,2);
});

test('task mutation lock prevents concurrent writers and clears on errors',async t=>{
  const dir=temporary(t);
  await withJobLock(dir,async()=>{await assert.rejects(withJobLock(dir,async()=>{}),/locked/);});
  await assert.rejects(withJobLock(dir,async()=>{throw Error('failure');}),/failure/);
  assert.ok(!fs.existsSync(path.join(dir,'.lock')));
});

test('TTS entry rejects unapproved job before provider import or audio generation',t=>{
  const dir=temporary(t);writeJson(path.join(dir,'job.json'),researched());
  assert.throws(()=>execFileSync(process.execPath,[path.join(root,'backend/run-tsx.mjs'),path.join(root,'scripts/cba-video/tts-project.mts'),'--job',dir],
    {encoding:'utf8',stdio:'pipe',timeout:20000}),error=>{assert.match(error.stderr,/User approval/);return true;});
  assert.ok(!fs.existsSync(path.join(dir,'audio')));
});

test('status invalidates previous approval when voice configuration changes',async t=>{
  const {job,dir}=await ready(t);await buildReview(job,dir);
  approveJob(job,{digest:editorialDigest(job),note:'确认预览'});
  job.tts.speed=1.1;refreshStatus(job);
  assert.equal(job.approval,null);assert.equal(job.status,'awaiting_review');
});

test('readiness rejects silent highlights and repeated news footage before paid TTS',async t=>{
  const {job}=await ready(t);
  job.media[0].probe.hasAudio=false;
  job.news.segments.push({...job.news.segments[0],id:'n2'});
  const errors=validateJob(job,{ready:true}).errors.join('\n');
  assert.match(errors,/needs original audio/);assert.match(errors,/News clip c1 is repeated/);
});

test('confirmed full recording clears only the material blocker',async t=>{
  const {job,file}=await ready(t);job.clips=[];
  job.mediaBlocker='等待本地录像';job.blockers=['比分仍待复核'];
  await importMedia(job,{file,matchConfirmed:true});
  assert.equal(job.mediaBlocker,null);assert.deepEqual(job.blockers,['比分仍待复核']);
});

test('render cache identity changes when renderer contents change at the same path',async t=>{
  const dir=temporary(t),job=researched(),renderer=path.join(dir,'renderer.mjs');
  const firstSource='export const subtitleMargin = 45;\n';
  fs.writeFileSync(renderer,firstSource);
  const first=await renderInputDigest(job,renderer);
  assert.equal(await renderInputDigest(job,renderer),first);
  fs.writeFileSync(renderer,'export const subtitleMargin = 150;\n');
  assert.notEqual(await renderInputDigest(job,renderer),first);
  fs.writeFileSync(renderer,firstSource);
  assert.equal(await renderInputDigest(job,renderer),first,'cache version follows content rather than file modification time');
});

test('render resume restores missing deliverables and uses current narration fingerprints',async t=>{
  const {job,dir}=await ready(t);job.profile.width=320;job.profile.height=180;job.profile.fps=10;
  await buildReview(job,dir);approveJob(job,{digest:editorialDigest(job),note:'测试夹具审核'});
  const audio=path.join(dir,'voice.m4a');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','1','-c:a','aac',audio]);
  job.news.segments[0].audioPath=audio;
  job.news.segments[0].audioDigest={request:digest({text:job.news.segments[0].text,tts:job.tts}),sha256:await fileHash(audio)};
  writeJson(path.join(dir,'job.json'),job);
  const render=(env={})=>JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'render','--job',dir],{encoding:'utf8',timeout:30000,env:{...process.env,...env}}));
  const first=render();assert.equal(first.artifacts.length,6);
  assert.equal(render().reused,true);
  const lowSpace={MEDIA_DISK_RESERVE_GIB:'1000000000'};
  assert.equal(render(lowSpace).reused,true,'verified delivery is reusable even below the disk reserve');
  const originalHash=await fileHash(first.news.path);
  fs.unlinkSync(first.news.subtitlePath);
  assert.throws(()=>render(lowSpace),error=>{assert.match(error.stderr,/磁盘空间不足/);return true;});
  assert.equal(await fileHash(first.news.path),originalHash,'low-space rejection must preserve the previous movie');
  assert.equal(fs.existsSync(first.news.subtitlePath),false,'new render must not start');
  const repaired=render();assert.ok(!repaired.reused);assert.ok(fs.existsSync(repaired.news.subtitlePath));
  const persisted=readJson(path.join(dir,'job.json'));
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','1','-c:a','aac',audio]);
  persisted.news.segments[0].audioDigest.sha256=await fileHash(audio);writeJson(path.join(dir,'job.json'),persisted);
  const changed=render();assert.notEqual(changed.news.path,first.news.path);
});

test('news-only CLI produces a complete single-edition preview and four verified delivery artifacts without highlights',async t=>{
  const {job,dir}=await ready(t);
  Object.assign(job.profile,{editions:['news'],width:320,height:180,fps:10});
  delete job.highlights;
  job.news.segments[0].mode='original';
  assert.deepEqual(validateJob(job,{ready:true}).errors,[]);
  const review=await buildReview(job,dir);
  assert.equal(review.complete,true);
  assert.deepEqual(review.sequences.map(item=>item.id),['news']);
  const html=fs.readFileSync(review.path,'utf8');
  assert.match(html,/横屏新闻版/);assert.doesNotMatch(html,/集锦版|两条均/);
  assert.equal(fs.existsSync(path.join(dir,'review/highlights-preview.mp4')),false);
  approveJob(job,{digest:editorialDigest(job),note:'合成素材单新闻版测试'});
  writeJson(path.join(dir,'job.json'),job);
  const render=()=>JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'render','--job',dir],{encoding:'utf8',timeout:30000}));
  const output=render();
  assert.equal(output.highlights,undefined);assert.equal(output.artifacts.length,4);
  assert.equal(fs.existsSync(path.join(path.dirname(output.news.path),'highlights.mp4')),false);
  for (const artifact of output.artifacts) assert.equal(await fileHash(artifact.path),artifact.sha256);
  const delivery=readJson(path.join(path.dirname(output.news.path),'delivery.json'));
  assert.equal(delivery.outputs.highlights,undefined);assert.equal(delivery.publishing.highlights,undefined);
  assert.equal(delivery.publishing.news.title,job.news.title);
  assert.equal(render().reused,true);
  fs.unlinkSync(output.news.subtitlePath);
  const repaired=render();assert.ok(!repaired.reused);assert.equal(repaired.artifacts.length,4);
  assert.ok(fs.existsSync(repaired.news.subtitlePath));
});

test('highlights-only CLI renders and reuses three delivery artifacts without a news script or TTS', async t => {
  const {job,dir} = await ready(t);
  job.profile.editions = ['highlights'];
  job.profile.width = 160; job.profile.height = 90; job.profile.fps = 10; job.profile.preset = 'ultrafast';
  delete job.news;
  assert.deepEqual(validateJob(job,{ready:true}).errors, []);
  const review = await buildReview(job,dir);
  assert.deepEqual(review.sequences.map(item => item.id), ['highlights']);
  assert.equal(review.complete, true);
  const html = fs.readFileSync(review.path,'utf8');
  assert.ok(!html.includes('<h2>新闻版'));
  assert.equal(fs.existsSync(path.join(dir,'news-draft.md')), false);
  approveJob(job,{digest:review.digest,note:'合成集锦测试，未使用真实新闻'});
  writeJson(path.join(dir,'job.json'),job);
  const tts = JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'tts','--job',dir],{encoding:'utf8',timeout:30000}));
  assert.equal(tts.skipped,true);
  const render = () => JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'render','--job',dir],{encoding:'utf8',timeout:30000}));
  const output = render();
  assert.equal(output.news,undefined);
  assert.equal(output.artifacts.length,3);
  assert.ok(output.highlights.duration > 0);
  assert.equal(fs.existsSync(path.join(path.dirname(output.highlights.path),'news.mp4')),false);
  assert.equal(fs.existsSync(path.join(path.dirname(output.highlights.path),'news.srt')),false);
  for (const artifact of output.artifacts) assert.equal(await fileHash(artifact.path),artifact.sha256);
  assert.equal(render().reused,true);
});

test('legacy render identity is unchanged when the new production policy is absent', async () => {
  const job = researched();
  const renderer = fileURLToPath(new URL('./render.mjs',import.meta.url));
  const expected = digest({edit:editorialDigest(job),audio:job.news.segments.map(s => ({id:s.id,sha256:s.audioDigest?.sha256,offsetSeconds:0,parts:undefined})),renderer:await fileHash(renderer)});
  assert.equal(await renderInputDigest(job),expected);
  job.profile.productionPolicy='cba-value-v2';
  assert.notEqual(await renderInputDigest(job),expected);
});

test('new CLI jobs opt into quality requirements and edit cannot lower their policy', t => {
  const dir = temporary(t), matchFile = path.join(dir,'match.json'), jobDir = path.join(dir,'job');
  writeJson(matchFile,match);
  execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'init','--job',jobDir,'--match',matchFile]);
  const job = readJson(path.join(jobDir,'job.json'));
  assert.equal(job.profile.productionPolicy,'cba-value-v2');
  assert.equal(job.profile.narrationPolicy,'xiaolu-commentator-v1');
  assert.deepEqual(job.profile.newsSeconds,[90,180]);
  const input = path.join(dir,'edit.json'); writeJson(input,{profile:{productionPolicy:null}});
  assert.throws(() => execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'edit','--job',jobDir,'--input',input],{stdio:'pipe'}), /Cannot downgrade/);
  assert.equal(readJson(path.join(jobDir,'job.json')).profile.productionPolicy,'cba-value-v2');
  writeJson(input,{profile:{narrationPolicy:null}});
  assert.throws(() => execFileSync(process.execPath,[path.join(root,'scripts/cba-video/cli.mjs'),'edit','--job',jobDir,'--input',input],{stdio:'pipe'}), /Cannot downgrade/);
  assert.equal(readJson(path.join(jobDir,'job.json')).profile.narrationPolicy,'xiaolu-commentator-v1');
});


test('v2 render measures the real narration and refuses frozen coverage despite misleading stored duration', async t => {
  const dir = temporary(t), audio = path.join(dir,'long-narration.wav');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=650:sample_rate=16000','-t','35','-c:a','pcm_s16le',audio]);
  const job = researched();
  job.profile = {...job.profile, productionPolicy:'cba-value-v2', editions:['news']};
  job.media = [{id:'source',sha256:'same'}];
  job.clips = [{id:'news-play',mediaId:'source',start:0,end:30}];
  job.news.segments = [{id:'n1',text:'据赛后报道，球队在比赛最后阶段保持领先，主教练回应了本场比赛的防守执行和球员表现。'.repeat(3),clipIds:['news-play'],audioPath:audio,audioDigest:{duration:1}}];
  await assert.rejects(validateRenderProduction(job),/停帧补时/);
  job.clips[0].end=40;
  await assert.doesNotReject(validateRenderProduction(job));
});
