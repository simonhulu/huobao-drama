import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {propsForShot} from './reference_edit.mjs';

test('clip-local effects preserve their exact absolute frame and camera offset',()=>{
  const s={frames:240,camera:{mode:'push',focusX:.4,focusY:.5,amount:.02},effects:[{id:'a',startFrame:60,endFrame:100},{id:'b',startFrame:120,endFrame:190}]};
  const p=propsForShot(s);
  assert.equal(p.shotFrameOffset,60);assert.equal(p.durationInFrames,130);
  assert.deepEqual(p.effects.map(e=>[e.startFrame,e.endFrame]),[[0,40],[60,130]]);
  assert.equal(p.camera,s.camera);assert.equal(p.shotDurationInFrames,240);
});
test('page subtitles intersect the overlay window without negative times or lost current caption',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-caption-test-'));
  const file=path.join(dir,'captions.ass');
  try{
    fs.writeFileSync(file,'[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,earlier\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,active\\Ncaption\nDialogue: 0,0:00:04.00,0:00:09.00,Default,,0,0,0,,later\n');
    const p=propsForShot({storyboardNumber:1,firstFrameImage:'static/images/a.png',frames:210,effects:[],page:{title:'标题',startFrame:60,endFrame:210},caption:{file}});
    assert.equal(p.page.startFrame,0);assert.equal(p.page.endFrame,150);
    assert.deepEqual(p.captions.map(c=>[c.startFrame,c.endFrame]),[[0,60],[60,150]]);
    assert.match(p.captions[0].text,/active/);assert.equal(p.page.imageSrc,'assets/1.png');
  }finally{fs.rmSync(dir,{recursive:true});}
});

test('final merge CLI encodes a compact upload directly and keeps source AAC intact',t=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-upload-merge-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const baseDir=path.join(dir,'base'),source=path.join(dir,'voice.m4a'),output=path.join(dir,'final.mp4');
  fs.mkdirSync(path.join(baseDir,'shots'),{recursive:true});
  const run=args=>execFileSync('ffmpeg',['-v','error','-n',...args],{timeout:30000});
  const first=path.join(baseDir,'shots','1.mp4');
  run(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=1','-c:v','libx264','-preset','ultrafast','-crf','0',first]);
  fs.copyFileSync(first,path.join(baseDir,'shots','2.mp4'));
  run(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:a','aac','-b:a','128k',source]);
  const planFile=path.join(dir,'edit-plan.json');
  fs.writeFileSync(planFile,JSON.stringify({baseDir,sourcePath:source,duration:2,shots:[{storyboardNumber:1,frames:30,effects:[]},{storyboardNumber:2,frames:30,effects:[]}]}));
  const code=createHash('sha256');
  for(const file of ['ReferenceEditorialOverlay.tsx','reference-editorial-core.ts','reference-editorial-entry.tsx','fine-edit-core.ts'])code.update(fs.readFileSync(path.join(root,'remotion/src',file)));
  for(const file of ['MaShanZheng-Regular.ttf','LXGWWenKaiScreen.ttf'])code.update(fs.readFileSync(path.join(root,'remotion/public/fonts',file)));
  code.update(fs.readFileSync(path.join(root,'scripts/videoeditor/reference_edit.mjs')));
  fs.writeFileSync(path.join(dir,'overlays.json'),JSON.stringify({planFingerprint:createHash('sha256').update(fs.readFileSync(planFile)).digest('hex'),codeFingerprint:code.digest('hex'),clips:[]}));
  execFileSync(process.execPath,[path.join(root,'scripts/videoeditor/reference_edit.mjs'),'merge',dir,output],{timeout:30000});
  const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output]));
  const video=metadata.streams.find(s=>s.codec_type==='video');
  assert.equal(Number(video.nb_frames),60);assert.equal(video.width,320);assert.equal(video.height,180);assert.equal(video.r_frame_rate,'30/1');
  assert.ok(fs.statSync(output).size<fs.statSync(first).size);
  const report=JSON.parse(fs.readFileSync(path.join(dir,'delivery.json')));
  assert.equal(report.uploadEncoding.status,'within-budget');
  assert.equal(report.uploadEncoding.settings.crf,24);
  assert.equal(report.uploadEncoding.bytes,fs.statSync(output).size);
  const audioHash=file=>run(['-i',file,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-']).toString();
  assert.equal(audioHash(output),audioHash(source));
  assert.throws(()=>execFileSync(process.execPath,[path.join(root,'scripts/videoeditor/reference_edit.mjs'),'merge',dir,output],{stdio:'pipe'}),/Command failed/);
});
