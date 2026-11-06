import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {removeBundlePublicAlias,renderStaticImageTimeline,staticImageRenderSchedule} from './static-render.mjs';

const props=()=>({width:1920,height:1080,fps:30,durationInFrames:180,audioSrc:'assets/narration.m4a',soundEffects:[],
  shots:[
    {shotId:'one',startFrame:0,frames:90,visualType:'image',imagePath:'assets/one.jpg',motion:{kind:'static'}},
    {shotId:'two',startFrame:90,frames:90,visualType:'image',imagePath:'assets/two.jpg',motion:{kind:'static'}},
  ],captions:[{text:'First caption',startFrame:0,endFrame:45},{text:'Second caption',startFrame:45,endFrame:120},
    {text:'Last caption',startFrame:120,endFrame:180}]});

test('static captures preserve every caption change and every original dissolve frame',()=>{
  const result=staticImageRenderSchedule(props());
  assert.equal(result.eligible,true);
  assert.equal(result.totalFrames,180);
  assert.deepEqual(result.spans.slice(0,2),[{frame:0,frames:45},{frame:45,frames:45}]);
  assert.deepEqual(result.spans.filter(span=>span.frame>=90&&span.frame<102),
    Array.from({length:12},(_,index)=>({frame:90+index,frames:1})));
  assert.deepEqual(result.spans.slice(-2),[{frame:102,frames:18},{frame:120,frames:60}]);
  assert.equal(result.spans.reduce((sum,span)=>sum+span.frames,0),180);
  assert.ok(result.capturedFrames<180);
});

test('moving cameras and complex visual or audio features always keep the full renderer',()=>{
  for(const patch of [
    {sourcePath:'assets/video.mp4',visualType:'video'},
    {map:{enabled:true}},
    {graphic:{kind:'quote',title:'Title',items:[]}},
    {titles:[{text:'Animated title',start:0,duration:1}]},
    {shotcraft:{vignette:.5}},
    {motion:{kind:'pan',keyframes:[{t:0,focusX:.2,focusY:.5,zoom:1.1},{t:1,focusX:.8,focusY:.5,zoom:1.1}]}},
  ]) {
    const value=props();Object.assign(value.shots[0],patch);
    assert.equal(staticImageRenderSchedule(value).eligible,false,JSON.stringify(patch));
  }
  const sfx=props();sfx.soundEffects=[{sourcePath:'assets/effect.wav',startFrame:0,frames:30}];
  assert.equal(staticImageRenderSchedule(sfx).eligible,false);
});

test('explicit cuts and frozen-camera holds preserve exact durations without redundant frames',()=>{
  const value=props();value.shots[1].shotcraft={transition:'cut'};
  const result=staticImageRenderSchedule(value);
  assert.equal(result.eligible,true);
  assert.deepEqual(result.spans,[{frame:0,frames:45},{frame:45,frames:45},{frame:90,frames:30},{frame:120,frames:60}]);
  const frozen=props();frozen.shots[0].motion={kind:'kenburns',keyframes:[{t:0,focusX:.5,focusY:.5,zoom:1.1},{t:1,focusX:.5,focusY:.5,zoom:1.1}]};
  assert.equal(staticImageRenderSchedule(frozen).eligible,true);
});

test('capturing an almost entirely changing timeline is rejected rather than adding overhead',()=>{
  const value=props();value.durationInFrames=2;value.shots=[{...value.shots[0],frames:2}];
  value.captions=[{text:'A',startFrame:0,endFrame:1},{text:'B',startFrame:1,endFrame:2}];
  const result=staticImageRenderSchedule(value);
  assert.equal(result.eligible,false);
  assert.match(result.reasons.join(' '),/capture|saving/);
});

test('bundle aliases can be removed without deleting the actual frozen assets',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-bundle-alias-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const publicDir=path.join(directory,'public'),bundle=path.join(directory,'bundle');
  fs.mkdirSync(publicDir);fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(publicDir,'original.txt'),'frozen input');
  fs.symlinkSync(publicDir,path.join(bundle,'public'));
  assert.equal(removeBundlePublicAlias(bundle,publicDir),true);
  assert.equal(fs.existsSync(path.join(bundle,'public')),false);
  assert.equal(fs.readFileSync(path.join(publicDir,'original.txt'),'utf8'),'frozen input');
  assert.equal(removeBundlePublicAlias(bundle,publicDir),false);
  fs.mkdirSync(path.join(bundle,'public'));
  assert.equal(removeBundlePublicAlias(bundle,publicDir),false,'legacy copied bundles remain for guarded cleanup');
});

test('an unexpected bundle alias is retained rather than removing arbitrary input links',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-bundle-wrong-alias-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const publicDir=path.join(directory,'public'),other=path.join(directory,'other'),bundle=path.join(directory,'bundle');
  for(const name of [publicDir,other,bundle])fs.mkdirSync(name);
  fs.symlinkSync(other,path.join(bundle,'public'));
  assert.throws(()=>removeBundlePublicAlias(bundle,publicDir),/outside/);
  assert.equal(fs.lstatSync(path.join(bundle,'public')).isSymbolicLink(),true);
});

test('failed capture removes temporary frames even if closing the browser also fails',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-static-capture-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const value=props();
  await assert.rejects(renderStaticImageTimeline({props:value,schedule:staticImageRenderSchedule(value),work:directory,
    renderer:{openBrowser:async()=>({close:async()=>{throw Error('browser already gone');}}),
      renderStill:async({output})=>{fs.writeFileSync(output,'partial capture');throw Error('capture canceled');}}}),
    /capture canceled/);
  assert.equal(fs.existsSync(path.join(directory,'static-frames')),false);
});
