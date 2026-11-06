import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createJob, editorialDigest, fileHash, approveJob, assertApproved} from './core.mjs';
import {prepareEditorialAudit, validateEditorialAudit, normalizeEditorialAudit, assertEditorialAudit,
  EDITORIAL_CHECKS, editorialAuditSchema, buildEditorialAuditSchema} from './editorial-gate.mjs';

const sharp = createRequire(new URL('../../backend/package.json', import.meta.url))('sharp');
const Ajv = createRequire(new URL('../../backend/package.json', import.meta.url))('ajv');
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-editorial-gate-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const video = path.join(directory, 'actual-colors.mp4');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=red:s=160x90:r=10:d=1',
    '-f','lavfi','-i','color=blue:s=160x90:r=10:d=1',
    '-f','lavfi','-i','color=green:s=160x90:r=10:d=1',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map','[v]','-map','3:a','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',video]);
  const job = createJob({id:'beikong-editorial-test',league:'CBA',date:'2026-10-23',home:'北控',away:'江苏',
    score:'93–82',verified:true,seedUrls:['https://bbs.hupu.com/643193388.html']});
  job.automation = {requireAudit: true, producerRunId: 'production-run-1'};
  job.profile.sourceScope = 'highlights';
  job.sources = [{id:'hupu-story',url:'https://bbs.hupu.com/643193388.html',kind:'media',
    title:'廖三宁17分2板6助，受伤后第四节重新登场',
    text:'虎扑报道北控93–82战胜江苏。廖三宁10投6中得到17分2篮板6助攻，比赛中遭遇脚踝伤势，第四节重新登场。'}];
  job.facts = [{id:'reported-news',text:'据虎扑报道，廖三宁17分2板6助，伤退后末节回归。',sourceIds:['hupu-story'],verified:true}];
  job.media = [{id:'test-source',path:video,kind:'highlights',matchId:job.match.id,matchConfirmed:true,
    sha256:await fileHash(video),probe:{duration:3,width:160,height:90,fps:10,hasAudio:true}}];
  job.clips = [
    {id:'label',mediaId:'test-source',start:.2,end:.5,label:'测试资料画面标识',verified:true,verificationNote:'仅供测试的红色画面',factIds:['reported-news']},
    {id:'play',mediaId:'test-source',start:.5,end:1.8,label:'测试红蓝画面边界',verified:true,verificationNote:'真实编码的颜色测试序列，非赛事素材',factIds:['reported-news']},
  ];
  job.news = {title:'廖三宁17分6助，伤退后末节回归',summary:'准确归因报道',segments:[
    {id:'disclosure',mode:'original',text:'本场比赛资料画面',factIds:['reported-news'],clipIds:['label']},
    {id:'report',text:'据虎扑报道，廖三宁得到十七分，脚踝受伤下场后在第四节重新登场。',factIds:['reported-news'],clipIds:['play']},
  ]};
  job.highlights = {title:'合成测试序列',clipIds:['label','play']};
  return {job, directory, video};
}

function passing(job, prepared) {
  const packet = JSON.parse(fs.readFileSync(prepared.packetPath, 'utf8'));
  const sourceIds = job.sources.map(source => source.id), clipIds = packet.selectedClipIds;
  const segmentIds = job.news.segments.map(segment => segment.id), evidenceIds = packet.evidence.map(item => item.id);
  return {version:1,editorialDigest:prepared.digest,packetPath:prepared.packetPath,packetSha256:prepared.packetSha256,
    decision:'pass',reviewer:{provider:'codex',role:'independent-editorial-reviewer',runId:'independent-run-2',producerRunId:'production-run-1'},
    reviewedAt:new Date().toISOString(),checks:Object.fromEntries(EDITORIAL_CHECKS.map(name => [name,
      {passed:true,reason:`${name}：测试稿保留伤退后回归的主线且明确归因虎扑，图片为真实编码测试帧，未声称识别赛事动作。`,
        sourceIds,clipIds,segmentIds,evidenceIds}])),
    clipObservations:packet.evidence.map(item => ({clipId:item.clipId,
      observation:item.clipId === 'play' ? '0.50秒红色画面进入1.15秒蓝色画面，2.20秒区间外画面转绿；这是合成测试序列。' : '0.20至0.50秒为红色合成画面，片头文字单独展示且随后连续衔接。',
      startObservation:`源时间${job.clips.find(clip => clip.id === item.clipId).start}秒是红色画面，前一采样仍然为红色。`,
      endObservation:item.clipId === 'play' ? '源时间1.70秒末帧为蓝色，2.20秒区间外采样变绿。' : '源时间0.40秒末帧仍红色，0.90秒区间外采样也为红色。',
      evidenceIds:[item.id]})),issues:[]};
}

test('audit package contains actual boundary and middle frames, and valid independent review unlocks production', async t => {
  const {job,directory} = await fixture(t);
  const prepared = await prepareEditorialAudit(job,directory);
  const packet = JSON.parse(fs.readFileSync(prepared.packetPath,'utf8'));
  assert.equal(packet.originalNews.stories[0].title,job.sources[0].title);
  assert.equal(packet.editorial.sources[0].text,job.sources[0].text);
  assert.equal(prepared.imagePaths.length,2);
  const evidence = packet.evidence.find(item => item.clipId === 'play');
  const pixel = async role => {
    const index = evidence.samples.findIndex(sample => sample.role === role);
    return sharp(evidence.path).extract({left:(index % 3)*480+240,top:Math.floor(index/3)*302+135,width:1,height:1}).raw().toBuffer();
  };
  const start = await pixel('start'), middle = await pixel('middle'), end = await pixel('end');
  assert.ok(start[0] > 220 && start[2] < 30,'start frame must decode actual red source pixels');
  assert.ok(middle[2] > 220 && middle[0] < 30,'middle frame must decode actual blue source pixels');
  assert.ok(end[2] > 220 && end[0] < 30,'end frame must decode actual blue source pixels');
  job.automation.audit = passing(job,prepared);
  assert.deepEqual(validateEditorialAudit(job),{valid:true,errors:[],repairTarget:'none'});
  job.review = {complete:true,digest:editorialDigest(job)};
  approveJob(job,{digest:job.review.digest,note:'独立测试审查已完成'});
  await assertApproved(job);
  job.news.segments[1].text += '修改稿件。';
  await assert.rejects(assertApproved(job),/stale|current edit/);
});

test('news-only audit ignores an unselected highlights edit while requiring every news clip', async t => {
  const {job,directory}=await fixture(t);
  job.profile.editions=['news'];
  job.clips.push({id:'unused-highlight',mediaId:'test-source',start:1.9,end:2.8,factIds:['reported-news'],verified:false});
  job.highlights={title:'',clipIds:['unused-highlight']};
  const prepared=await prepareEditorialAudit(job,directory);
  const packet=JSON.parse(fs.readFileSync(prepared.packetPath,'utf8'));
  assert.deepEqual(packet.selectedClipIds,['label','play']);
  assert.equal(prepared.imagePaths.length,2);
  job.automation.audit=passing(job,prepared);
  assert.deepEqual(validateEditorialAudit(job),{valid:true,errors:[],repairTarget:'none'});
  job.review={complete:true,digest:editorialDigest(job)};
  approveJob(job,{digest:job.review.digest,note:'仅新闻版合成测试审核'});
  await assertApproved(job);
  job.automation.audit.clipObservations.pop();
  assert.equal(validateEditorialAudit(job).valid,false);
});

test('a blanket passed flag cannot conceal missing observations, source references or image evidence', async t => {
  const {job,directory} = await fixture(t), prepared = await prepareEditorialAudit(job,directory);
  const good = passing(job,prepared);
  for (const mutate of [
    audit => { audit.clipObservations = []; },
    audit => { audit.checks.newsAngle.sourceIds = []; },
    audit => { audit.checks.sourceAttribution.segmentIds = ['disclosure']; },
    audit => { audit.checks.playBoundaries.evidenceIds = []; },
    audit => { audit.clipObservations[1].evidenceIds = ['image-label']; },
    audit => { audit.reviewer.runId = audit.reviewer.producerRunId; },
    audit => { audit.decision = 'revise'; },
    audit => { audit.checks.eventFootageAccuracy.passed = false; },
    audit => { audit.clipObservations = {}; },
    audit => { audit.reviewer.runId = 7; },
    audit => { audit.checks.sourceAttribution.sourceIds = {}; },
  ]) {
    const audit = structuredClone(good); mutate(audit);
    assert.equal(validateEditorialAudit(job,audit).valid,false);
  }
  assert.equal(validateEditorialAudit(job,{passed:true}).valid,false);
  const image = prepared.imagePaths[0]; fs.appendFileSync(image,'changed');
  assert.match(validateEditorialAudit(job,good).errors.join('\n'),/image missing, invalid or changed/);
});

test('the discarded Beikong production-disclaimer script fails even with a current package and every passed flag', async t => {
  const {job,directory} = await fixture(t);
  job.news.title = '廖三宁伤情暂不下结论：北控93–82江苏';
  job.news.segments[1].text = '虎扑这条新闻聚焦廖三宁在比赛中的伤情。先说明素材边界：目前取得并核验的是咪咕官方剪辑集锦，不是整场录像，因此本片不对伤情细节下结论。';
  const prepared = await prepareEditorialAudit(job,directory);
  job.automation.audit = passing(job,prepared);
  job.review = {complete:true,digest:editorialDigest(job)};
  assert.match(validateEditorialAudit(job).errors.join('\n'),/production or verification boilerplate/);
  assert.throws(() => approveJob(job,{digest:job.review.digest,note:'不能自行宣称通过'}),/boilerplate/);
  await assert.rejects(assertApproved(job),/boilerplate/);
});

test('approval and TTS/render are blocked in editing phases while existing legacy approvals remain usable', async t => {
  const {job} = await fixture(t);
  delete job.automation;
  job.review = {complete:true,digest:editorialDigest(job)};
  approveJob(job,{digest:job.review.digest,note:'已有人工审核版本'});
  await assertApproved(job);
  const old = process.env.CBA_AUTOMATION_PHASE;
  try {
    for (const phase of ['discovery','editing','audit']) {
      process.env.CBA_AUTOMATION_PHASE = phase;
      assert.throws(() => approveJob(job,{digest:job.review.digest,note:'不允许子进程自批'}),/cannot approve/);
      await assert.rejects(assertApproved(job),/cannot approve/);
    }
  } finally {
    if (old === undefined) delete process.env.CBA_AUTOMATION_PHASE;
    else process.env.CBA_AUTOMATION_PHASE = old;
  }
  job.automation = {requireAudit:true,producerRunId:'production-run-1'};
  assert.throws(() => approveJob(job,{digest:job.review.digest,note:'必须独立审核'}),/audit is missing/);
  await assert.rejects(assertApproved(job),/audit is missing/);
});

test('structured output schema is strict and preparation rejects a replaced source before producing images', async t => {
  assert.equal(editorialAuditSchema.additionalProperties,false);
  assert.deepEqual(editorialAuditSchema.properties.checks.required,EDITORIAL_CHECKS);
  assert.ok(editorialAuditSchema.required.includes('clipObservations'));
  assert.equal(new RegExp(editorialAuditSchema.properties.editorialDigest.pattern).test('用一段评论冒充摘要'),false);
  assert.equal(new RegExp(editorialAuditSchema.properties.editorialDigest.pattern).test('a'.repeat(64)),true);
  const {job,directory,video} = await fixture(t);
  fs.appendFileSync(video,'tampered source');
  await assert.rejects(prepareEditorialAudit(job,directory),/changed before editorial audit/);
  assert.throws(() => assertEditorialAudit(job),/audit is missing/);
});

test('per-package structured schema rejects copied hashes and mixed source, media, clip and segment IDs', async t => {
  const {job,directory} = await fixture(t), prepared = await prepareEditorialAudit(job,directory);
  const good = passing(job,prepared);
  const schema = buildEditorialAuditSchema(prepared,job,good.reviewer);
  const validate = new Ajv({strict:true}).compile(schema);
  assert.equal(schema.properties.clipObservations.minItems,good.clipObservations.length);
  assert.equal(schema.properties.clipObservations.maxItems,good.clipObservations.length);
  assert.equal(validate(good),true,JSON.stringify(validate.errors));
  for (const mutate of [
    audit => { audit.editorialDigest = '原报道与新闻角度完整，但是镜头不符。'; },
    audit => { audit.editorialDigest = 'b'.repeat(64); },
    audit => { audit.packetSha256 = 'c'.repeat(64); },
    audit => { audit.packetPath += '-wrong'; },
    audit => { audit.checks.playBoundaries.sourceIds = ['test-source']; },
    audit => { audit.checks.footageDisclosure.segmentIds = ['play']; },
    audit => { audit.checks.eventFootageAccuracy.clipIds = ['report']; },
    audit => { audit.checks.eventFootageAccuracy.evidenceIds = ['made-up-image']; },
    audit => { audit.clipObservations[0].clipId = 'test-source'; },
    audit => { audit.clipObservations[0].evidenceIds = ['hupu-story']; },
    audit => { audit.clipObservations.push(structuredClone(audit.clipObservations[0])); },
    audit => { audit.clipObservations.pop(); },
    audit => { audit.reviewer.runId = 'model-invented-run'; },
    audit => { audit.issues = [{code:'test',severity:'warning',message:'测试错误引用不应该通过',suggestion:'使用来源列表中真实的标识符',
      sourceIds:['test-source'],clipIds:[],segmentIds:[],evidenceIds:[]}]; },
  ]) {
    const bad = structuredClone(good); mutate(bad);
    assert.equal(validate(bad),false,JSON.stringify(bad));
  }
  assert.throws(() => buildEditorialAuditSchema({...prepared,packetSha256:'a'.repeat(64)},job),/changed/);
  assert.equal(editorialAuditSchema.properties.editorialDigest.enum,undefined,'building a bound schema must not mutate the reusable schema');
});

test('empty ID namespaces produce valid maxItems-zero arrays rather than invalid empty enums', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'cba-editorial-empty-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const job = createJob({id:'empty',league:'CBA',date:'2026-10-23',home:'北控',away:'江苏'});
  const signature = editorialDigest(job), packetPath = path.join(directory,'packet.json');
  fs.writeFileSync(packetPath,JSON.stringify({version:1,editorialDigest:signature,editorial:job,evidence:[]}));
  const schema = buildEditorialAuditSchema({digest:signature,packetPath,packetSha256:await fileHash(packetPath)},job);
  assert.doesNotThrow(() => new Ajv({strict:true}).compile(schema));
  for (const field of ['sourceIds','clipIds','segmentIds','evidenceIds']) {
    assert.equal(schema.properties.checks.properties.newsAngle.properties[field].maxItems,0);
    assert.equal(schema.properties.issues.items.properties[field].maxItems,0);
  }
  assert.equal(schema.properties.clipObservations.maxItems,0);
});

test('duplicate observations are merged without losing reviewer evidence or changing the edit', async t => {
  const {job,directory}=await fixture(t), prepared=await prepareEditorialAudit(job,directory);
  const audit=passing(job,prepared), duplicate=structuredClone(audit.clipObservations[1]);
  duplicate.observation='同一片段补充观察：中间蓝色画面与结尾蓝色画面相连续，未出现不同素材。';
  duplicate.startObservation='补充观察：前一帧与开场帧都是红色，身份和画面连续。';
  audit.clipObservations.push(duplicate);
  const original=structuredClone(audit), digest=editorialDigest(job);
  assert.equal(validateEditorialAudit(job,audit).repairTarget,'report');
  const normalized=normalizeEditorialAudit(job,audit);
  assert.deepEqual(audit,original,'normalization must not mutate the original response');
  assert.equal(editorialDigest(job),digest);
  assert.equal(normalized.clipObservations.length,2);
  for(const field of ['observation','startObservation','endObservation']) {
    assert.ok(normalized.clipObservations[1][field].includes(original.clipObservations[1][field]));
    assert.ok(normalized.clipObservations[1][field].includes(duplicate[field]));
  }
  assert.deepEqual(validateEditorialAudit(job,normalized),{valid:true,errors:[],repairTarget:'none'});
  for(const mutate of [
    value=>{value.clipObservations[2].evidenceIds=['image-label'];},
    value=>{value.clipObservations[2].evidenceIds=['invented-evidence'];},
    value=>{value.clipObservations[2].clipId='invented-clip';},
    value=>{value.clipObservations[2].evidenceIds=null;},
    value=>{value.clipObservations[2].observation='pass';},
  ]) {
    const bad=structuredClone(original);mutate(bad);
    assert.equal(validateEditorialAudit(job,normalizeEditorialAudit(job,bad)).valid,false);
  }
});

test('warning-only advice does not trigger editing, while substantive objections still block', async t => {
  const {job,directory}=await fixture(t), prepared=await prepareEditorialAudit(job,directory);
  const audit=passing(job,prepared);
  audit.decision='revise';audit.issues=[{code:'OPTIONAL_CUT',severity:'warning',
    message:'资料画面的转场可以进一步平滑，但当前不影响理解和事实归因。',
    suggestion:'后续有时间时可优化转场节奏，本条已满足事实和画面准确要求。',
    sourceIds:['hupu-story'],clipIds:['play'],segmentIds:['report'],evidenceIds:['image-play']}];
  const normalized=normalizeEditorialAudit(job,audit);
  assert.equal(audit.decision,'revise');assert.equal(normalized.decision,'pass');
  assert.deepEqual(normalized.issues,audit.issues);
  assert.equal(validateEditorialAudit(job,normalized).valid,true);
  for(const mutate of [
    value=>{value.issues[0].severity='error';},
    value=>{value.checks.eventFootageAccuracy.passed=false;},
    value=>{value.decision='blocked';},
    value=>{value.issues=[];},
  ]) {
    const bad=structuredClone(audit);mutate(bad);
    const result=normalizeEditorialAudit(job,bad);
    assert.equal(result.decision,bad.decision);
    assert.equal(validateEditorialAudit(job,result).valid,false);
  }
});

test('audit failures route report repair, content edits and evidence regeneration independently', async t => {
  const {job,directory}=await fixture(t), prepared=await prepareEditorialAudit(job,directory);
  const good=passing(job,prepared);
  const report=structuredClone(good);report.clipObservations=[];
  assert.equal(validateEditorialAudit(job,report).repairTarget,'report');
  const reasonless=structuredClone(good);reasonless.decision='revise';
  assert.equal(validateEditorialAudit(job,reasonless).repairTarget,'report');
  const content=structuredClone(report);content.checks.eventFootageAccuracy.passed=false;
  assert.equal(validateEditorialAudit(job,content).repairTarget,'content');
  const missingReferences=structuredClone(content);missingReferences.checks.newsAngle.sourceIds=null;
  assert.equal(validateEditorialAudit(job,missingReferences).repairTarget,'content');
  const evidence=structuredClone(content);evidence.editorialDigest='0'.repeat(64);
  assert.equal(validateEditorialAudit(job,evidence).repairTarget,'evidence');
  fs.appendFileSync(prepared.imagePaths[0],'changed');
  assert.equal(validateEditorialAudit(job,good).repairTarget,'evidence');
  assert.equal(validateEditorialAudit(job).repairTarget,'report');
});

test('highlights-only audit checks source text and every actual clip without demanding a news script', async t => {
  const {job,directory} = await fixture(t);
  job.profile.editions = ['highlights'];
  job.news = {title:'',segments:[]};
  const prepared = await prepareEditorialAudit(job,directory);
  const packet = JSON.parse(fs.readFileSync(prepared.packetPath,'utf8'));
  assert.deepEqual(packet.selectedClipIds,['label','play']);
  const audit = passing(job,prepared);
  assert.deepEqual(validateEditorialAudit(job,audit),{valid:true,errors:[],repairTarget:'none'});
  audit.checks.playBoundaries.evidenceIds=[];
  assert.equal(validateEditorialAudit(job,audit).valid,false);
  const missingSource = passing(job,prepared);
  missingSource.checks.sourceAttribution.sourceIds=[];
  assert.equal(validateEditorialAudit(job,missingSource).valid,false);
});
