import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {freezePlan} from './render.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const requireRemotion=createRequire(path.join(root,'remotion/package.json'));
const browserExecutable=process.env.REMOTION_BROWSER_EXECUTABLE || path.join(root,'.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const ffmpeg=args=>execFileSync('ffmpeg',['-v','error','-n',...args],{timeout:60_000,maxBuffer:4*1024*1024});

function centerPixel(filename) {
  return [...ffmpeg(['-i',filename,'-frames:v','1','-vf','crop=1:1:960:540','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])];
}

function assertGreen(pixel,label) {
  const [red,green,blue]=pixel;
  assert.ok(green>210 && red<35 && blue<35,`${label}: selected green footage must remain visible, not black or an adjacent source segment; RGB ${pixel}`);
}

function assertImage(pixel,label) {
  const [red,green,blue]=pixel;
  assert.ok(red>210 && green<35 && blue>210,`${label}: incoming magenta image must replace the footage; RGB ${pixel}`);
}

test('real rendering preserves a nonzero source range through slowdown, frozen tails, and scene dissolves',{
  skip:fs.existsSync(browserExecutable) ? false : 'Set REMOTION_BROWSER_EXECUTABLE to run the real Chromium regression',
  timeout:180_000,
},async t=>{
  const parent=process.env.HISTORY_MOTION_SAMPLE_DIR ? path.resolve(process.env.HISTORY_MOTION_SAMPLE_DIR) : os.tmpdir();
  fs.mkdirSync(parent,{recursive:true});
  const directory=fs.mkdtempSync(path.join(parent,'history-motion-transition-'));
  if(!process.env.HISTORY_MOTION_SAMPLE_DIR) t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'red-green-blue.mp4'),image=path.join(directory,'magenta.png'),audio=path.join(directory,'narration.m4a');
  // The selected source is exactly the middle green segment, [1, 2.8).
  // Red catches ignored inPoint; blue catches playback spilling past outPoint.
  ffmpeg(['-f','lavfi','-i','color=c=red:s=320x180:r=30:d=1',
    '-f','lavfi','-i','color=c=lime:s=320x180:r=30:d=1.8',
    '-f','lavfi','-i','color=c=blue:s=320x180:r=30:d=1',
    '-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]','-map','[out]',
    '-an','-c:v','libx264','-crf','10','-pix_fmt','yuv420p',source]);
  ffmpeg(['-f','lavfi','-i','color=c=magenta:s=320x180','-frames:v','1',image]);
  ffmpeg(['-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','10','-c:a','aac',audio]);
  const publicDir=path.join(directory,'public');
  const {props}=await freezePlan({width:1920,height:1080,fps:30,durationInFrames:300,audioPath:audio,shots:[
    {shotId:'slowdown',startFrame:0,frames:60,sourcePath:source,inPoint:1,outPoint:2.8,shortfallPolicy:'freeze'},
    {shotId:'after-slowdown',startFrame:60,frames:60,imagePath:image},
    {shotId:'freeze',startFrame:120,frames:120,sourcePath:source,inPoint:1,outPoint:2.8,shortfallPolicy:'freeze'},
    {shotId:'after-freeze',startFrame:240,frames:60,imagePath:image},
  ]},publicDir);
  assert.equal(props.shots[0].playbackRate,.9);
  assert.equal(props.shots[0].playableFrames,60);
  assert.equal(props.shots[2].playbackRate,.8);
  assert.ok(props.shots[2].playableFrames>props.shots[2].sourceFrames && props.shots[2].playableFrames<props.shots[2].frames);
  const freezeStart=props.shots[2].startFrame+props.shots[2].playableFrames;

  const {bundle}=await import(requireRemotion.resolve('@remotion/bundler'));
  const {selectComposition,renderStill}=await import(requireRemotion.resolve('@remotion/renderer'));
  const serveUrl=await bundle({entryPoint:path.join(root,'remotion/src/history-motion-factory-entry.tsx'),rootDir:path.join(root,'remotion'),
    publicDir,outDir:path.join(directory,'bundle')});
  const composition=await selectComposition({serveUrl,id:'HistoryMotionFactory',inputProps:props,browserExecutable});
  const samples=[
    {frame:0,label:'nonzero inPoint',expect:'green'},
    {frame:59,label:'slowdown final frame',expect:'green'},
    {frame:60,label:'slowdown handoff start',expect:'green'},
    {frame:65,label:'slowdown handoff middle',expect:'blend'},
    {frame:71,label:'slowdown handoff complete',expect:'image'},
    {frame:freezeStart-1,label:'last playable frame before freeze',expect:'green'},
    {frame:freezeStart,label:'first frozen frame',expect:'green'},
    {frame:239,label:'frozen shot final frame',expect:'green'},
    {frame:240,label:'frozen shot handoff start',expect:'green'},
    {frame:251,label:'frozen shot handoff complete',expect:'image'},
  ];
  const evidence=[];
  for(const sample of samples) {
    const output=path.join(directory,`frame-${sample.frame}.png`);
    await renderStill({serveUrl,composition,inputProps:props,browserExecutable,frame:sample.frame,imageFormat:'png',output,logLevel:'error'});
    const pixel=centerPixel(output);
    evidence.push({...sample,pixel});
    t.diagnostic(`${sample.label} (${sample.frame}): RGB ${pixel}`);
  }
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  t.diagnostic(`Rendered ${samples.length} real composition frames; artifacts: ${directory}`);
  for(const sample of evidence) {
    if(sample.expect==='green') assertGreen(sample.pixel,sample.label);
    else if(sample.expect==='image') assertImage(sample.pixel,sample.label);
    else assert.ok(sample.pixel.every(channel=>channel>60 && channel<200),`${sample.label}: green and magenta must visibly mix without a black dip; RGB ${sample.pixel}`);
  }
});
