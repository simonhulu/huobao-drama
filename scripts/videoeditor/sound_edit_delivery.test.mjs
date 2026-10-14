import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {soundDeliveryIdentity,soundComparison,selectHighlightShots,soundReviewHtml,packageSoundDelivery} from './sound_edit_delivery.mjs';

test('arbitrary episodes require explicit separate output identity',()=>{
  assert.deepEqual(soundDeliveryIdentity({episodeId:777,deliveryStem:'episode-777-refined-v1'}),{stem:'episode-777-refined-v1',label:'第 777 集 · 精细剪辑'});
  for(const deliveryStem of [undefined,'','../overwrite','bad name'])assert.throws(()=>soundDeliveryIdentity({deliveryStem}),/deliveryStem/);
});
test('comparison is optional, explicit and must exist beside the new video',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sound-delivery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal(soundComparison({},dir),null);
  assert.throws(()=>soundComparison({comparisonFile:'old.mp4'},dir),/Comparison video not found/);
  assert.throws(()=>soundComparison({comparisonFile:'../old.mp4'},dir),/explicit MP4 filename/);
  fs.writeFileSync(path.join(dir,'episode-777-dry.mp4'),'fixture');
  assert.deepEqual(soundComparison({deliveryStem:'episode-777-final',comparisonFile:'episode-777-dry.mp4'},dir),{file:'episode-777-dry.mp4',label:'对照版本'});
  assert.throws(()=>soundComparison({deliveryStem:'episode-777-dry',comparisonFile:'episode-777-dry.mp4'},dir),/different/);
});
test('highlight fallback spans edited shots, and invalid manual selections fail',()=>{
  const shots=Array.from({length:20},(_,i)=>({storyboardNumber:i+1,startFrame:i*90,frames:90,audioCues:i%2?[{reason:'short sound'}]:[]}));
  const selected=selectHighlightShots({shots});
  assert.equal(selected.length,8);assert.equal(selected[0].storyboardNumber,2);assert.equal(selected.at(-1).storyboardNumber,20);
  assert.deepEqual(selectHighlightShots({shots,highlightShots:[12,2]}).map(s=>s.storyboardNumber),[2,12]);
  for(const highlightShots of [[],[1,1],[99]])assert.throws(()=>selectHighlightShots({shots,highlightShots}),/unique existing/);
});
test('review HTML has no episode/version-specific story claims or hidden comparison',()=>{
  const plan={episodeId:777,deliveryStem:'episode-777-refined',soundSummary:'情绪 < 精细'};
  const args={plan,report:{cueCount:1},...soundDeliveryIdentity(plan),comparison:null,seconds:3};
  const html=soundReviewHtml(args);
  assert.ok(!/1038|v5|钱币|诗歌|死亡/.test(html));
  assert.ok(!html.includes('<select'));assert.ok(html.includes('情绪 &lt; 精细'));
  assert.ok(html.includes('episode-777-refined-highlights.mp4'));
  assert.ok(soundReviewHtml({...args,comparison:{file:'episode-777-dry.mp4',label:'原版'}}).includes('<select'));
});
test('existing v7 explicit fields retain filenames and comparison label',()=>{
  const plan={episodeId:1038,deliveryStem:'episode-1038-local-v7',deliveryLabel:'本地音效重设计 v7',soundSummary:'使用本地库重配情绪声音'};
  const html=soundReviewHtml({plan,report:{cueCount:57},...soundDeliveryIdentity(plan),comparison:{file:'episode-1038-sound-v6.mp4',label:'上一版 v6'},seconds:6});
  assert.ok(html.includes('episode-1038-local-v7.mp4'));assert.ok(html.includes('上一版 v6'));assert.ok(html.includes('57 处短音效'));
  assert.ok(!html.includes('画面沿用 v5'));
});
test('stale mix report fails before any packaging files are written',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sound-delivery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'sfx'));
  const output=path.join(dir,'episode-777-final.mp4');fs.writeFileSync(output,'fixture');
  fs.writeFileSync(path.join(dir,'edit-plan.json'),JSON.stringify({episodeId:777,deliveryStem:'episode-777-final'}));
  fs.writeFileSync(path.join(dir,'sfx/mix-report.json'),JSON.stringify({output,planSha256:'stale'}));
  assert.throws(()=>packageSoundDelivery(dir),/stale plan/);
  assert.ok(!fs.existsSync(path.join(dir,'episode-777-final-assets')));
});
test('an existing published page blocks packaging before any media or metadata write',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sound-delivery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'sfx'));
  const output=path.join(dir,'episode-777-final.mp4'),planPath=path.join(dir,'edit-plan.json'),page=path.join(dir,'episode-777-final-review.html');
  const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(output,'fixture');
  fs.writeFileSync(planPath,JSON.stringify({episodeId:777,deliveryStem:'episode-777-final',fps:30,duration:1,shots:[{storyboardNumber:1,startFrame:0,frames:30}]}));
  fs.writeFileSync(path.join(dir,'sfx/mix-report.json'),JSON.stringify({output,planSha256:digest(planPath),sha256:digest(output),noBgm:true,videoFrames:30,duration:1,cueCount:0}));
  fs.writeFileSync(page,'retained review');
  assert.throws(()=>packageSoundDelivery(dir),/Refusing to overwrite/);
  assert.equal(fs.readFileSync(page,'utf8'),'retained review');
  assert.ok(!fs.existsSync(path.join(dir,'episode-777-final-assets')));
  assert.ok(!fs.existsSync(path.join(dir,'delivery.json')));
});

test('an over-budget final mix cannot be packaged as an upload-ready delivery',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sound-delivery-budget-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'sfx'));
  const output=path.join(dir,'episode-777-final.mp4'),planPath=path.join(dir,'edit-plan.json');
  const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(output,'fixture');
  fs.writeFileSync(planPath,JSON.stringify({episodeId:777,deliveryStem:'episode-777-final',fps:30,duration:1,shots:[{storyboardNumber:1,startFrame:0,frames:30}]}));
  fs.writeFileSync(path.join(dir,'sfx/mix-report.json'),JSON.stringify({output,planSha256:digest(planPath),sha256:digest(output),noBgm:true,videoFrames:30,duration:1,cueCount:0,uploadEncoding:{status:'over-budget'}}));
  assert.throws(()=>packageSoundDelivery(dir),/filesize budget/);
  assert.ok(!fs.existsSync(path.join(dir,'episode-777-final-assets')));
  assert.ok(!fs.existsSync(path.join(dir,'delivery.json')));
});
