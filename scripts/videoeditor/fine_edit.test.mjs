import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {framesForShots,safeEffectWindow,cameraFilter,captionLines,narrationCaptionChunks} from './fine_edit.mjs';
test('cumulative rounding conserves a long irregular audio-backed timeline',()=>{
  const shots=Array.from({length:147},()=>({duration:5.623}));const duration=shots.length*5.623+.012;
  const a=framesForShots(shots,duration);assert.equal(a.reduce((s,x)=>s+x.frames,0),Math.round(duration*30));
  a.slice(1).forEach((x,i)=>assert.equal(x.startFrame,a[i].startFrame+a[i].frames));
});
test('trigger is never advanced to fit the effect; unreadable windows are rejected',()=>{
  assert.throws(()=>safeEffectWindow(7.8,240,2),/Insufficient/);
  const w=safeEffectWindow(7.2,240,2);assert.equal(w.startFrame,216);assert.ok(w.endFrame<240);
});
test('FFmpeg camera uses crop-space focus and a bounded hold/move/hold curve',()=>{
  const f=cameraFilter({mode:'push',focusX:.25,focusY:.4,amount:.03},150);
  assert.match(f,/clip\(\(on\/149-0.15\)\/0.70,0,1\)/);assert.match(f,/\(iw-iw\/zoom\)\*\(0.25\)/);assert.match(f,/1\+0.03/);
});
test('captions preserve final narration and keep number-unit groups on one line',()=>{
  const text='杂色元宝银 68 万两，色银 137 万余两，加起来合计白银约 301 万两。';
  const chunks=narrationCaptionChunks(text);assert.equal(chunks.join(''),text);
  assert.ok(chunks.map(captionLines).join(' ').includes('301 万两'));
  assert.equal(narrationCaptionChunks('我想到了两个字：寄生。寄生的本质是，').join(''),'我想到了两个字：寄生。寄生的本质是，');
});

test('compose CLI preserves visible overlays while encoding the upload at final composition',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fine-upload-compose-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const run=args=>execFileSync('ffmpeg',['-v','error','-n',...args],{timeout:30000});
  const voice=path.join(dir,'voice.m4a'),base=path.join(dir,'base.mp4'),overlay=path.join(dir,'overlay.mov'),output=path.join(dir,'final.mp4');
  run(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:a','aac','-b:a','128k',voice]);
  run(['-f','lavfi','-i','color=c=black:size=320x180:rate=30:duration=2','-i',voice,'-map','0:v','-map','1:a','-c:v','libx264','-c:a','copy',base]);
  run(['-f','lavfi','-i','color=c=red@0.7:size=320x180:rate=30:duration=1,format=yuva444p10le','-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le',overlay]);
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const planPath=path.join(dir,'edit-plan.json');
  fs.writeFileSync(planPath,JSON.stringify({episodeId:777,sourcePath:voice,sourceFingerprint:hash(voice),duration:2,fps:30,shots:[{frames:60}]}));
  fs.writeFileSync(path.join(dir,'overlays.json'),JSON.stringify({planFingerprint:hash(planPath),clips:[{clip:overlay,fingerprint:hash(overlay),globalStart:.5,globalEnd:1.5}]}));
  execFileSync(process.execPath,[fileURLToPath(new URL('./fine_edit.mjs',import.meta.url)),'compose',dir,output],{timeout:30000});
  const pixel=time=>run(['-ss',String(time),'-i',output,'-vf','crop=2:2:0:0','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-']);
  assert.ok(pixel(.2)[0]<10);
  assert.ok(pixel(1)[0]>100);
  assert.ok(pixel(1.8)[0]<10);
  const delivery=JSON.parse(fs.readFileSync(path.join(dir,'delivery.json')));
  assert.equal(delivery.frames,60);
  assert.equal(delivery.uploadEncoding.status,'within-budget');
  assert.equal(delivery.uploadEncoding.settings.crf,24);
});
