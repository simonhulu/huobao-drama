import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {UPLOAD_ENCODING, resolveUploadEncoding, uploadVideoArgs, uploadEncodingReport} from './upload_encoding.mjs';
import {mix} from './editorial_sfx.mjs';
import {packageSoundDelivery} from './sound_edit_delivery.mjs';

test('upload encoding uses constrained CRF, not hardware target-bitrate encoding',()=>{
  assert.equal(UPLOAD_ENCODING.crf,24);
  assert.equal(UPLOAD_ENCODING.maxRateKbps,2000);
  assert.equal(UPLOAD_ENCODING.audioBitrate,'128k');
  const args=uploadVideoArgs();
  const option=k=>args[args.indexOf(k)+1];
  assert.equal(option('-c:v'),'libx264');
  assert.equal(option('-preset'),'slow');
  assert.equal(option('-crf'),'24');
  assert.equal(option('-maxrate'),'2000k');
  assert.equal(option('-bufsize'),'4000k');
  assert.equal(option('-pix_fmt'),'yuv420p');
  assert.ok(!args.includes('-b:v'));
  assert.ok(!args.includes('-vf'));
  assert.ok(!args.includes('-r'));
});

test('quality exceptions must be explicit, bounded and reproducible',()=>{
  const changed={...UPLOAD_ENCODING,crf:22,maxRateKbps:3000,maxMegabytesPerMinute:25};
  assert.throws(()=>resolveUploadEncoding(changed),/reason/);
  const config=resolveUploadEncoding({...changed,reason:'Small map labels fail visual review at the default settings'});
  assert.equal(config.crf,22);
  assert.equal(uploadVideoArgs(config)[uploadVideoArgs(config).indexOf('-bufsize')+1],'6000k');
  for(const patch of [{crf:NaN},{crf:35},{maxRateKbps:0},{preset:'ultrafast'},{profile:'unknown'},{audioBitrate:'16k'},{unexpected:true}]) {
    assert.throws(()=>resolveUploadEncoding({...UPLOAD_ENCODING,...patch,reason:'test'}));
  }
});

test('delivery checks actual bytes per minute; peak bitrate is not a filesize guarantee',()=>{
  const metadata={format:{duration:'900'},streams:[]};
  const compact=uploadEncodingReport(metadata,200_000_000);
  assert.equal(compact.status,'within-budget');
  assert.ok(Math.abs(compact.megabytesPerMinute-13.333333)<.00001);
  assert.equal(uploadEncodingReport(metadata,400_000_000).status,'over-budget');
  assert.equal(uploadEncodingReport({format:{duration:'1'}},200_000).status,'within-budget');
  for(const duration of ['N/A',0,NaN])assert.throws(()=>uploadEncodingReport({format:{duration}},1),/duration/);
  for(const bytes of [0,-1,NaN])assert.throws(()=>uploadEncodingReport(metadata,bytes),/size/);
});

test('real FFmpeg final assembly preserves frames, resolution, FPS and AAC packets',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-upload-encoding-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const shot=path.join(dir,'shot.mp4'),audio=path.join(dir,'narration.m4a'),list=path.join(dir,'concat.txt'),output=path.join(dir,'final.mp4');
  const run=args=>execFileSync('ffmpeg',['-v','error','-n',...args],{timeout:30000});
  run(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=1','-c:v','libx264','-preset','ultrafast',shot]);
  run(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:a','aac','-b:a','128k',audio]);
  fs.writeFileSync(list,`file '${shot}'\nfile '${shot}'\n`);
  run(['-f','concat','-safe','0','-i',list,'-i',audio,'-map','0:v:0','-map','1:a:0',...uploadVideoArgs(),'-c:a','copy','-movflags','+faststart',output]);
  const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output]));
  const video=metadata.streams.find(s=>s.codec_type==='video');
  assert.equal(video.codec_name,'h264');
  assert.equal(video.pix_fmt,'yuv420p');
  assert.equal(video.width,320);assert.equal(video.height,180);
  assert.equal(video.r_frame_rate,'30/1');assert.equal(Number(video.nb_frames),60);
  const packetHash=file=>run(['-i',file,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-']).toString();
  assert.equal(packetHash(output),packetHash(audio));
  assert.equal(uploadEncodingReport(metadata,fs.statSync(output).size).status,'within-budget');
  const header=fs.readFileSync(output).subarray(0,64);
  assert.ok(header.indexOf('moov')>=0);
  const effect=path.join(dir,'effect.wav'),mixed=path.join(dir,'fixture-mixed.mp4');
  run(['-f','lavfi','-i','sine=frequency=900:sample_rate=48000:duration=0.2',effect]);
  fs.writeFileSync(path.join(dir,'edit-plan.json'),JSON.stringify({episodeId:777,deliveryStem:'fixture-mixed',sourcePath:audio,duration:2,fps:30,uploadEncoding:UPLOAD_ENCODING,
    soundAssets:{effect:{file:effect,duration:.2,gainDb:-12,source:'Generated test fixture',license:'test-only'}},
    shots:[{storyboardNumber:1,startFrame:0,frames:60,effects:[],audioCues:[{kind:'effect',frame:12,gainDb:-12}]}]}));
  const report=mix(dir,output,mixed);
  assert.equal(report.uploadEncoding.status,'within-budget');
  assert.equal(report.uploadEncoding.settings.audioBitrate,'128k');
  const videoHash=file=>run(['-i',file,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-']).toString().trim();
  assert.equal(report.videoPacketHash,videoHash(output));
  const delivery=packageSoundDelivery(dir);
  assert.equal(delivery.uploadEncoding.bytes,fs.statSync(mixed).size);
  assert.equal(delivery.frames,60);
  assert.ok(fs.existsSync(delivery.highlights));
});
