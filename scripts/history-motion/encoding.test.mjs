import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {UPLOAD_ENCODING} from '../videoeditor/upload_encoding.mjs';
import {resolveMotionHardwareEncoding,motionHardwareRenderOptions,motionEncodingReport} from './encoding.mjs';

const requireRemotion=createRequire(new URL('../../remotion/package.json',import.meta.url));
const rendererRoot=path.dirname(requireRemotion.resolve('@remotion/renderer/package.json'));
const {validateQualitySettings}=requireRemotion(path.join(rendererRoot,'dist/crf.js'));
const {getCodecName}=requireRemotion(path.join(rendererRoot,'dist/get-codec-name.js'));
const {resolveHardwareAcceleration}=requireRemotion(path.join(rendererRoot,'dist/probe-encoder.js'));
const metadata=(encoder='Lavc61.19.100 h264_videotoolbox')=>({
  streams:[{codec_type:'video',codec_name:'h264',width:1920,height:1080,r_frame_rate:'30/1',tags:{encoder}},
    {codec_type:'audio',codec_name:'aac'}],format:{duration:'60'},
});

test('legacy upload plans resolve to an accurate immutable hardware profile',()=>{
  const overrides={...UPLOAD_ENCODING};
  const encoding=resolveMotionHardwareEncoding(overrides);
  assert.deepEqual(encoding,{profile:'history-motion-hardware-h264-v1',encoder:'h264_videotoolbox',hardwareAcceleration:'required',
    videoBitrateKbps:2000,audioBitrate:'128k',maxMegabytesPerMinute:17});
  assert.ok(Object.isFrozen(encoding));
  assert.deepEqual(overrides,UPLOAD_ENCODING);
  for(const key of ['crf','preset','maxRateKbps','encodingMaxRate','encodingBufferSize'])assert.equal(Object.hasOwn(encoding,key),false);
});

test('old custom bitrate, audio and budget settings retain their validation',()=>{
  const encoding=resolveMotionHardwareEncoding({maxRateKbps:3000,audioBitrate:'192k',maxMegabytesPerMinute:20,reason:'Approved upload budget'});
  assert.equal(encoding.videoBitrateKbps,3000);assert.equal(encoding.audioBitrate,'192k');assert.equal(encoding.maxMegabytesPerMinute,20);
  for(const invalid of [{profile:'other'},{maxRateKbps:999},{crf:null},{preset:'ultrafast'},{maxRateKbps:3000},{encoder:'libx264'}]) {
    assert.throws(()=>resolveMotionHardwareEncoding(invalid));
  }
});

test('render options are legal for required hardware and contain no software quality flags',()=>{
  const options=motionHardwareRenderOptions(resolveMotionHardwareEncoding());
  assert.deepEqual(options,{codec:'h264',hardwareAcceleration:'required',videoBitrate:'2000k',crf:null,x264Preset:null});
  assert.equal(Object.hasOwn(options,'encodingMaxRate'),false);assert.equal(Object.hasOwn(options,'encodingBufferSize'),false);
  const normalized={...options,encodingMaxRate:null,encodingBufferSize:null,indent:false,logLevel:'error'};
  assert.deepEqual(validateQualitySettings({...normalized,hardwareAccelerated:true}),['-b:v','2000k']);
  if(process.platform==='darwin')assert.deepEqual(getCodecName(normalized),{encoderName:'h264_videotoolbox',hardwareAccelerated:true});
  for(const patch of [{hardwareAcceleration:'if-possible'},{encoder:'libx264'},{videoBitrateKbps:NaN},{videoBitrateKbps:5000}]) {
    assert.throws(()=>motionHardwareRenderOptions({...resolveMotionHardwareEncoding(),...patch}),/required hardware/);
  }
});

test('the installed renderer fails required hardware instead of falling back when the encoder is unavailable',()=>{
  const options=motionHardwareRenderOptions(resolveMotionHardwareEncoding());
  assert.throws(()=>resolveHardwareAcceleration({...options,encodingMaxRate:null,encodingBufferSize:null,
    binariesDirectory:path.join(os.tmpdir(),`history-motion-no-encoder-${randomUUID()}`),indent:false,logLevel:'error'}),/not available|does not support/);
  for(const patch of [{crf:24},{encodingMaxRate:'2000k',encodingBufferSize:'4000k'}]) {
    assert.throws(()=>getCodecName({...options,encodingMaxRate:null,encodingBufferSize:null,...patch,indent:false,logLevel:'error'}),/not supported/);
  }
});

test('fresh reports require the video stream to verify VideoToolbox encoding',()=>{
  const report=motionEncodingReport(metadata(),1_000_000);
  assert.equal(report.encoder,'h264_videotoolbox');assert.equal(report.encoderTag,'Lavc61.19.100 h264_videotoolbox');
  assert.deepEqual(report.settings,resolveMotionHardwareEncoding());
  for(const encoder of ['Lavc61.19.100 libx264','unknown','',undefined,'libx264 h264_videotoolbox']) {
    const value=metadata();value.streams[0].tags.encoder=encoder;
    assert.throws(()=>motionEncodingReport(value,1_000_000),/Required hardware encoding/);
  }
  const audioOnly=metadata('libx264');audioOnly.streams[1].tags={encoder:'h264_videotoolbox'};
  assert.throws(()=>motionEncodingReport(audioOnly,1_000_000),/Required hardware encoding/);
  const wrongCodec=metadata();wrongCodec.streams[0].codec_name='hevc';
  assert.throws(()=>motionEncodingReport(wrongCodec,1_000_000),/Required hardware encoding/);
});

test('hardware reports preserve the existing filesize budget boundary and input guards',()=>{
  const allowed=17_000_000+500_000;
  const report=motionEncodingReport(metadata(),allowed);
  assert.equal(report.budgetBytes,allowed);assert.equal(report.status,'within-budget');
  assert.equal(motionEncodingReport(metadata(),allowed+1).status,'over-budget');
  assert.equal(motionEncodingReport(metadata(),20_500_000,{maxMegabytesPerMinute:20,reason:'Approved budget'}).status,'within-budget');
  for(const bytes of [0,-1,NaN,1.5])assert.throws(()=>motionEncodingReport(metadata(),bytes),/file size/);
  const invalidDuration=metadata();invalidDuration.format.duration='0';
  assert.throws(()=>motionEncodingReport(invalidDuration,1000),/duration/);
});

test('legacy partial resume records the observed encoder without claiming hardware settings',()=>{
  const report=motionEncodingReport(metadata('Lavc61.19.100 libx264'),1_000_000,undefined,{requireHardware:false});
  assert.equal(report.encoder,'libx264');assert.equal(report.encoderTag,'Lavc61.19.100 libx264');
  assert.deepEqual(report.settings,UPLOAD_ENCODING);assert.equal(Object.hasOwn(report.settings,'hardwareAcceleration'),false);
  const missing=metadata();delete missing.streams[0].tags;
  const unknown=motionEncodingReport(missing,1_000_000,undefined,{requireHardware:false});
  assert.equal(unknown.encoder,'unknown');assert.equal(unknown.encoderTag,null);assert.deepEqual(unknown.settings,UPLOAD_ENCODING);
  const other=motionEncodingReport(metadata('Lavc61.19.100 libopenh264'),1_000_000,undefined,{requireHardware:false});
  assert.equal(other.encoder,'Lavc61.19.100 libopenh264');assert.deepEqual(other.settings,UPLOAD_ENCODING);
  assert.equal(motionEncodingReport(metadata('libx264'),17_500_001,undefined,{requireHardware:false}).status,'over-budget');
});
