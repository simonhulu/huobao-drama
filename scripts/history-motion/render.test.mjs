import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {buildCaptions,cleanupHistoryMotionRenderCache,fileSha256,freezePlan,renderHistoryMotion,validateGraphic,validateMap,validateOutput,validatePlan,visualTypeForShot} from './render.mjs';
import {mapSceneAssetKey} from './scene-assets.mjs';
import {applyShotcraftDesign} from './shotcraft.mjs';
const requireRemotion=createRequire(new URL('../../remotion/package.json',import.meta.url));
const requireBackend=createRequire(new URL('../../backend/package.json',import.meta.url));
const Database=requireBackend('better-sqlite3');

const plan=()=>({width:1920,height:1080,fps:30,durationInFrames:60,audioPath:'/audio.m4a',shots:[
  {shotId:'one',startFrame:0,frames:60,sourcePath:'/video.mp4',inPoint:0,outPoint:2,narration:'秦军进入上党。'}]});
const map=()=>({enabled:true,backgroundSrc:'/map.png',width:1920,height:1080,
  provenance:{verified:true,source:'Natural Earth',license:'Public domain',projection:'equirectangular',historyStatus:'illustrative',attribution:'Natural Earth; control schematic'},
  cities:[{name:'长平',x:.5,y:.5}],territories:[{name:'秦',color:'#b63d35',points:[[.1,.2],[.6,.2],[.4,.8]],initialPoints:[[.1,.2],[.3,.2],[.2,.8]],from:0,to:1}],
  routes:[{points:[[.1,.2],[.5,.5]],color:'#b63d35',start:0,end:1}]});

test('timeline, source ranges and unique shots are enforced',()=>{
  assert.equal(validatePlan(plan()).frames,60);
  for(const patch of [{startFrame:1},{frames:59},{outPoint:1.9},{inPoint:2},{outPoint:0}]) {
    const value=plan();Object.assign(value.shots[0],patch);assert.throws(()=>validatePlan(value));
  }
  const duplicate=plan();duplicate.shots.push({...duplicate.shots[0],startFrame:60});duplicate.durationInFrames=120;
  assert.throws(()=>validatePlan(duplicate),/unique/);
  const freeze=plan();freeze.shots[0].outPoint=1;freeze.shots[0].shortfallPolicy='freeze';assert.equal(validatePlan(freeze).frames,60);
});

test('map shots require provenance and preserve the geometry canvas',()=>{
  validateMap(map(),2);
  const value=plan();delete value.shots[0].sourcePath;value.shots[0].map=map();validatePlan(value);
  for(const invalid of [{...map(),backgroundSrc:''},{...map(),width:0},{...map(),provenance:{...map().provenance,verified:false}},
    {...map(),cities:[{name:'Wrong',x:2,y:.5}]},{...map(),territories:[{...map().territories[0],initialPoints:[[.1,.2],[.3,.2]]}]}])assert.throws(()=>validateMap(invalid,2));
});

test('map presentation rejects invalid timing, camera and unsourced exact encirclement',()=>{
  const value={...map(),camera:{keyframes:[{t:0,focusX:.5,focusY:.5,zoom:1},{t:8,focusX:.4,focusY:.5,zoom:1.1}]},
    stages:[{start:0,end:2,label:'定位'},{start:2,end:10,label:'包围示意'}],
    legend:[{label:'活动空间',color:'#b85b4f',kind:'area'}],
    encirclement:{center:[.5,.5],radiusX:.23,radiusY:.3,start:2,end:4,compressionStart:5,compressionEnd:8,innerScale:.62,color:'#365b7b',fillColor:'#b85b4f',label:'部署示意'}};
  assert.doesNotThrow(()=>validateMap(value,10));
  for(const patch of [{radiusX:.7},{end:11},{compressionEnd:4},{compressionStart:undefined},{innerScale:1},{label:'精确包围线'}])
    assert.throws(()=>validateMap({...value,encirclement:{...value.encirclement,...patch}},10));
  assert.throws(()=>validateMap({...value,provenance:{...value.provenance,historyStatus:'sourced'}},10),/illustrative/);
  assert.throws(()=>validateMap({...value,camera:{keyframes:[value.camera.keyframes[0],{...value.camera.keyframes[1],t:0}]}},10),/camera/);
  assert.throws(()=>validateMap({...value,stages:[...value.stages,{start:9,end:10,label:'重叠'}]},10),/stage/);
});

test('atlas geography preserves normalized coordinates and rejects malformed layers before rendering',()=>{
  const value={...map(),cartography:{version:1,style:'relief-atlas'},
    geographicLabels:[{id:'ridge',text:'太行山',kind:'mountain',x:.25,y:.4,angle:-60,priority:2}],
    waterways:[{id:'river',name:'滹沱河',rank:1,points:[[.1,.3],[.4,.45],[.8,.5]]}],
    waterAreas:[{id:'sea',kind:'ocean',rings:[[[.8,.1],[1,.1],[1,.8],[.9,.7]]]}],
    cities:[{...map().cities[0],kind:'battlefield'}]};
  validateMap(value,2);
  for(const patch of [{x:114},{kind:'troop'},{angle:Infinity},{text:''}])
    assert.throws(()=>validateMap({...value,geographicLabels:[{...value.geographicLabels[0],...patch}]},2),/geographic label/);
  for(const patch of [{rank:0},{points:[[114,38],[115,39]]},{points:[[.1,.2]]}])
    assert.throws(()=>validateMap({...value,waterways:[{...value.waterways[0],...patch}]},2),/waterway/);
  assert.throws(()=>validateMap({...value,waterways:[...value.waterways,...value.waterways]},2),/waterway/);
  assert.throws(()=>validateMap({...value,waterAreas:[{...value.waterAreas[0],rings:[[[1.1,0],[1,1],[0,1]]]}]},2),/water area/);
  assert.throws(()=>validateMap({...value,cartography:{version:2,style:'relief-atlas'}},2),/cartography/);
});

test('map forces require city anchors, matching routes and bounded timing',()=>{
  const force={id:'yan',commander:'朱棣',faction:'燕军',flagText:'燕',color:'#a54232',city:'长平',routeIndex:0,action:'occupy',start:0,end:1};
  const value={...map(),forces:[force]};
  validateMap(value,2);
  for(const patch of [{city:'不存在'},{routeIndex:1},{end:3},{start:1},{flagText:'过长的旗帜文字'},{action:'win'},{portraitSha256:'bad'}])
    assert.throws(()=>validateMap({...value,forces:[{...force,...patch}]},2));
  assert.throws(()=>validateMap({...value,forces:[force,force]},2),/identity/);
  assert.throws(()=>validateMap({...value,forces:[{...force,action:'retreat',routeIndex:undefined}]},2),/route/);
  assert.throws(()=>validateMap({...value,forces:[{...force,start:.2}]},2),/timing/);
  assert.throws(()=>validateMap({...value,cities:[{name:'长平',x:.8,y:.8}]},2),/end at/);
});

test('map identity follows geographic action, not labels, camera, colors or duration',()=>{
  const source=map(),key=mapSceneAssetKey('terrain',source);
  const styled=structuredClone(source);styled.title='换标题';styled.camera={keyframes:[{t:0,focusX:.4,focusY:.5,zoom:1.2}]};
  styled.routes[0]={...styled.routes[0],color:'#123456',start:4,end:9,name:'换路线名'};
  styled.territories[0]={...styled.territories[0],color:'#123456',name:'换区域名',from:3,to:8};
  styled.cities[0]={...styled.cities[0],color:'#123456',highlightStart:4,highlightDuration:3};
  assert.equal(mapSceneAssetKey('terrain',styled),key);
  for(const change of [
    {...source,routes:[]},
    {...source,routes:[{...source.routes[0],points:[...source.routes[0].points].reverse()}]},
    {...source,territories:[{...source.territories[0],initialPoints:source.territories[0].points}]},
    {...source,cities:[{...source.cities[0],name:'另一地点'}]},
  ])assert.notEqual(mapSceneAssetKey('terrain',change),key);
  const enclosure={center:[.5,.5],radiusX:.23,radiusY:.3,start:1,end:3,color:'#365b7b',fillColor:'#b85b4f',label:'部署示意'};
  const enclosing={...source,encirclement:enclosure};
  assert.notEqual(mapSceneAssetKey('terrain',enclosing),key);
  assert.notEqual(mapSceneAssetKey('terrain',enclosing),mapSceneAssetKey('terrain',{...enclosing,encirclement:{...enclosure,compressionStart:4,compressionEnd:7,innerScale:.62}}));
});

test('map identity includes force actions but ignores portrait styling and timing',()=>{
  const force={id:'yan',commander:'朱棣',faction:'燕军',flagText:'燕',city:'长平',action:'attack',routeIndex:0,start:0,end:1};
  const source={...map(),forces:[force]},key=mapSceneAssetKey('terrain',source);
  assert.notEqual(key,mapSceneAssetKey('terrain',map()));
  assert.notEqual(key,mapSceneAssetKey('terrain',{...source,forces:[{...force,action:'occupy'}]}));
  assert.equal(key,mapSceneAssetKey('terrain',{...source,forces:[{...force,id:'new',start:2,end:5,color:'#123456',portraitSrc:'/different.png'}]}));
});

test('freezing reuses terrain for different map scenes but rejects the same scene under a changed title',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-map-scene-assets-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const terrain=path.join(dir,'terrain.png'),portrait=path.join(dir,'portrait.png'),audio=path.join(dir,'audio.m4a');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x355b52:s=320x180','-frames:v','1',terrain]);
  fs.copyFileSync(terrain,portrait);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:a','aac',audio]);
  const force={id:'garrison',commander:'朱棣',faction:'燕军',flagText:'燕',color:'#a54232',city:'长平',action:'hold',start:0,end:.5,portraitSrc:portrait};
  const locator={...map(),width:320,height:180,backgroundSrc:terrain,routes:[],territories:[],forces:[force]};
  const route={...locator,routes:map().routes};
  const value={...plan(),audioPath:audio,uniqueSceneAssets:true,shots:[
    {shotId:'locate',startFrame:0,frames:30,visualType:'map',map:locator},
    {shotId:'route',startFrame:30,frames:30,visualType:'map',map:route},
  ]};
  const frozen=await freezePlan(value,path.join(dir,'unique'));
  assert.equal(frozen.props.shots[0].map.backgroundSrc,frozen.props.shots[1].map.backgroundSrc);
  assert.match(frozen.props.shots[0].map.forces[0].portraitSrc,/^assets\//);
  assert.equal(frozen.props.shots[0].map.forces[0].portraitSrc,frozen.props.shots[1].map.forces[0].portraitSrc);
  assert.match(frozen.props.shots[0].map.forces[0].portraitSha256,/^[a-f\d]{64}$/);
  assert.notEqual(frozen.props.shots[0].assetKey,frozen.props.shots[1].assetKey);
  assert.equal(frozen.props.shots[0].assetKey,mapSceneAssetKey(frozen.props.shots[0].map.backgroundSha256,locator));
  value.shots[1].map={...locator,title:'另一个标题'};
  await assert.rejects(freezePlan(value,path.join(dir,'repeated')),/repeats the scene asset/);
});

test('horizontal and vertical profiles preserve caption text without overlapping windows',()=>{
  const value=plan();value.width=1080;value.height=1920;value.shots[0].narration='赵军守住阵地，秦军改变行军方向。双方在长平展开对峙，战局逐渐发生变化。';
  const captions=buildCaptions(value);assert.ok(captions.length>1);assert.equal(captions.map(c=>c.text).join(''),value.shots[0].narration);
  assert.equal(captions[0].startFrame,0);assert.equal(captions.at(-1).endFrame,60);validatePlan(value);
  value.captions=[{text:'少了一句',startFrame:0,endFrame:60}];assert.throws(()=>validatePlan(value),/complete/);
  value.width=1280;assert.throws(()=>validatePlan(value),/profile/);
});

test('title clipping and invalid motion cannot reach Remotion',()=>{
  const value=plan();value.shots[0].titles=[{text:'长平',start:1.5,duration:1}];assert.throws(()=>validatePlan(value),/Title/);
  value.shots[0].titles=[];value.shots[0].motion={kind:'keyframes',keyframes:[{t:0,zoom:1,focusX:.5,focusY:.5},{t:1,zoom:.9,focusX:.5,focusY:.5}]};
  assert.throws(()=>validatePlan(value),/keyframe/);
});

test('frozen local sources verify actual duration, hashes and reject remote media',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-render-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const video=path.join(dir,'source.mp4'),audio=path.join(dir,'narration.m4a');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=192x108:r=30','-t','2','-an','-c:v','libx264','-pix_fmt','yuv420p',video]);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:a','aac',audio]);
  const value=plan();value.audioPath=audio;value.shots[0].sourcePath=video;
  const frozen=await freezePlan(value,path.join(dir,'public'));
  assert.equal(frozen.props.shots[0].sourceFrames,60);assert.equal(frozen.props.audioSrc,'assets/0001.m4a');
  assert.equal(frozen.props.shots[0].playbackRate,1);assert.equal(frozen.props.shots[0].playableFrames,60);
  assert.match(frozen.assets[0].sha256,/^[a-f\d]{64}$/);assert.ok(frozen.assets.every(asset=>fs.existsSync(path.join(dir,'public',asset.path))));
  value.shots[0].assetSha256='a'.repeat(64);await assert.rejects(freezePlan(value,path.join(dir,'wrong-hash')),/fingerprint/);
  delete value.shots[0].assetSha256;value.shots[0].outPoint=3;await assert.rejects(freezePlan(value,path.join(dir,'wrong-range')),/actual media/);
  value.shots[0].sourcePath='https://example.com/video.mp4';await assert.rejects(freezePlan(value,path.join(dir,'remote')),/absolute local/);
  value.shots[0].sourcePath=video;value.shots[0].outPoint=1.8;value.shots[0].shortfallPolicy='freeze';
  const fitted=await freezePlan(value,path.join(dir,'gentle-slowdown'));
  assert.equal(fitted.props.shots[0].sourceFrames,54);assert.equal(fitted.props.shots[0].playbackRate,.9);
  assert.equal(fitted.props.shots[0].playableFrames,60,'a modest shortage is filled with continuous footage');
  value.shots[0].inPoint=.2;value.shots[0].outPoint=1.2;
  const capped=await freezePlan(value,path.join(dir,'bounded-slowdown'));
  assert.equal(capped.props.shots[0].playbackRate,.8,'large shortages must not cause extreme slow motion');
  assert.equal(capped.props.shots[0].sourceFrames,30,'retiming never reads beyond the selected source range');
  assert.equal(capped.props.shots[0].playableFrames,37);
  const cappedShot=capped.props.shots[0];
  const lastSampleFrame=Math.round(cappedShot.inPoint*30+(cappedShot.playableFrames-1)*cappedShot.playbackRate);
  assert.ok(lastSampleFrame<cappedShot.outPoint*30,'the final sample and frozen tail stay before the exclusive source outPoint');
});

test('output verification rejects missing audio, incorrect frames, software encoding and excessive size',()=>{
  const metadata={streams:[{codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',width:1920,height:1080,r_frame_rate:'30/1',nb_frames:'60',tags:{encoder:'Lavc61 h264_videotoolbox'}},{codec_type:'audio',codec_name:'aac'}],format:{duration:'2'}};
  assert.equal(validateOutput(metadata,100000,plan()).status,'within-budget');
  const noAudio=structuredClone(metadata);noAudio.streams.pop();assert.throws(()=>validateOutput(noAudio,100000,plan()),/AAC/);
  const wrong=structuredClone(metadata);wrong.streams[0].nb_frames='59';assert.throws(()=>validateOutput(wrong,100000,plan()),/frame count/);
  assert.throws(()=>validateOutput(metadata,10000000,plan()),/budget/);
  const software=structuredClone(metadata);software.streams[0].tags.encoder='Lavc61 libx264';
  assert.throws(()=>validateOutput(software,100000,plan()),/Required hardware encoding/);
});

test('image, graphic and sound-effect contracts freeze real local assets',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-rich-render-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const image=path.join(dir,'image.png'), audio=path.join(dir,'narration.m4a'), effect=path.join(dir,'effect.wav');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x355b52:s=320x180:r=30','-frames:v','1',image]);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:a','aac',audio]);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=900:sample_rate=48000','-t','0.5','-c:a','pcm_s16le',effect]);
  const value=plan();value.audioPath=audio;value.shots=[
    {shotId:'image',startFrame:0,frames:30,imagePath:image,visualType:'image',graphic:{kind:'quote',title:'Unused fallback',items:[{label:'Not rendered'}]},narration:'秦军前进。'},
    {shotId:'graphic',startFrame:30,frames:30,graphic:{kind:'comparison',title:'两军兵力',items:[{label:'秦军',value:'十万',detail:'主力推进'},{label:'赵军',value:'八万',detail:'固守关口'}]},narration:'双方兵力不同。'},
  ];
  value.soundEffects=[{sourcePath:effect,sourceName:'test cue',startFrame:12,frames:30,volume:.8}];
  assert.doesNotThrow(()=>validateGraphic(value.shots[1].graphic));
  const frozen=await freezePlan(value,path.join(dir,'public'));
  assert.equal(frozen.props.shots[0].imagePath,'assets/0002.png');
  assert.equal(frozen.props.shots[0].visualType,'image');
  assert.equal(frozen.props.shots[0].graphic.kind,'quote','graphic explanations may accompany an image');
  assert.equal(frozen.graphics.length,2,'both companion and full-frame graphic layers are recorded');
  assert.equal(frozen.props.shots[1].visualType,'graphic');
  assert.equal(frozen.graphics[1].kind,'comparison');
  assert.equal(frozen.soundEffects[0].frames,15);
  assert.ok(frozen.images[0].sha256.match(/^[a-f\d]{64}$/));
  assert.ok(frozen.soundEffects[0].source.match(/effect\.wav$/));
  assert.equal(frozen.props.soundEffects[0].volume,.18);
  assert.equal(frozen.props.soundEffects[0].sha256,frozen.soundEffects[0].sha256);
  assert.equal(frozen.soundEffects[0].sourceName,'test cue');
  assert.equal(frozen.props.soundEffects[0].sourceName,'test cue');
  const defaultVolume=structuredClone(value);delete defaultVolume.soundEffects[0].volume;
  assert.equal((await freezePlan(defaultVolume,path.join(dir,'default-volume'))).props.soundEffects[0].volume,.14);
  assert.deepEqual(frozen.graphics[1].items,value.shots[1].graphic.items);
  assert.ok(frozen.assets.every(asset=>fs.existsSync(path.join(dir,'public',asset.path))));
  const wrongImage=structuredClone(value);wrongImage.shots[0].imageSha256='a'.repeat(64);
  await assert.rejects(freezePlan(wrongImage,path.join(dir,'wrong-image')),/Image image fingerprint/);
  const duplicate=structuredClone(value);duplicate.uniqueSceneAssets=true;
  duplicate.shots[1]={...duplicate.shots[0],shotId:'image-repeat',startFrame:30};
  await assert.rejects(freezePlan(duplicate,path.join(dir,'duplicate-image')),/repeats the scene asset/);
  const unsupported=structuredClone(value);unsupported.companionGraphicsOnly=true;
  await assert.rejects(freezePlan(unsupported,path.join(dir,'standalone-graphic')),/needs underlying footage/);
  const wrongEffect=structuredClone(value);wrongEffect.soundEffects[0].sha256='a'.repeat(64);
  await assert.rejects(freezePlan(wrongEffect,path.join(dir,'wrong-effect')),/Sound effect 1 fingerprint/);
  const remote=structuredClone(value);remote.soundEffects[0].sourcePath='https://example.com/effect.wav';
  await assert.rejects(freezePlan(remote,path.join(dir,'remote-effect')),/absolute local/);
  const noAudio=structuredClone(value);noAudio.soundEffects[0].sourcePath=image;
  await assert.rejects(freezePlan(noAudio,path.join(dir,'no-effect-audio')),/readable audio/);
  const clipped=structuredClone(value);clipped.soundEffects[0].startFrame=58;
  assert.equal((await freezePlan(clipped,path.join(dir,'clipped-effect'))).props.soundEffects[0].frames,2);
  const invalid=structuredClone(value);invalid.shots[1].graphic.items=[];assert.throws(()=>validatePlan(invalid),/nonempty items/);
});

test('explicit visualType chooses the actual visual and ignores unused fallback sources',()=>{
  const value=plan();value.shots[0].visualType='graphic';value.shots[0].outPoint=undefined;
  value.shots[0].map={enabled:true};value.shots[0].imagePath='/unused.png';
  value.shots[0].graphic={kind:'quote',title:'行动',items:[{label:'推进'}]};
  assert.equal(visualTypeForShot(value.shots[0]),'graphic');
  assert.doesNotThrow(()=>validatePlan(value));
  value.shots[0].visualType='map';assert.throws(()=>validatePlan(value),/Map/);
  value.shots[0].visualType='unknown';assert.throws(()=>validatePlan(value),/visualType/);
});

test('graphic-only shots need no video range; malformed graphics and sound timing fail clearly',()=>{
  for (const kind of ['timeline','comparison','relationship','quote']) {
    const value=plan();delete value.shots[0].sourcePath;delete value.shots[0].outPoint;
    value.shots[0].graphic={kind,title:'事件经过',items:[{label:'推进',detail:'保持原有叙事',value:'第一步'}]};
    assert.equal(validatePlan(value).frames,60);
  }
  for (const graphic of [null,{kind:'other',title:'事件',items:[{label:'推进'}]},
    {kind:'quote',title:'事件',items:[]},{kind:'quote',title:'事件',items:[{label:'推进',value:20}]}]) {
    assert.throws(()=>validateGraphic(graphic),/Graphic|graphic/);
  }
  for (const patch of [{startFrame:-1},{startFrame:60},{startFrame:.5},{frames:0},{volume:NaN},{volume:-1}]) {
    const value=plan();value.soundEffects=[{sourcePath:'/effect.wav',startFrame:1,frames:30,volume:.12,...patch}];
    assert.throws(()=>validatePlan(value),/Sound effect/);
  }
});

async function completedCache(t) {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-cache-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const output=path.join(directory,'movie.mp4'),work=output+'.render',publicDir=path.join(work,'public'),bundle=path.join(work,'bundle');
  const put=(filename,value)=>{fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,value);};
  const assets=[];
  for(const [relative,content] of [['assets/0001.mp4','original video'],['assets/0002.m4a','original narration'],['fonts/example.ttf','original font']]) {
    const source=path.join(directory,'originals',path.basename(relative));
    put(source,content);put(path.join(publicDir,relative),content);put(path.join(bundle,'public',relative),content);
    assets.push({source,path:relative,sha256:await fileSha256(source),bytes:Buffer.byteLength(content)});
  }
  const preview=path.join(directory,'movie-preview.mp4');
  put(output,'completed movie');put(preview,'completed preview');put(path.join(directory,'movie-review.html'),'review');
  put(path.join(work,'samples','frame.png'),'sample evidence');put(path.join(bundle,'bundle.js'),'generated bundle');
  for(const filename of ['plan.json','props.json'])put(path.join(work,filename),'{}');
  const report={status:'completed',output,preview,sha256:await fileSha256(output),assets,qa:{technical:'passed'}};
  const saveReport=()=>{for(const filename of [output+'.json',path.join(work,'delivery.json')])put(filename,JSON.stringify(report));};
  put(path.join(work,'assets.json'),JSON.stringify(assets));saveReport();
  return {directory,output,work,publicDir,bundle,assets,report,saveReport,put};
}

function cacheReferenceDatabase(t,f) {
  const filename=path.join(f.directory,'data/huobao_drama.db');
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const database=new Database(filename);
  database.exec(`CREATE TABLE storage_artifacts(id INTEGER PRIMARY KEY,path TEXT,pinned INTEGER);
    CREATE TABLE storage_artifact_refs(artifact_id INTEGER,owner_type TEXT,owner_id TEXT,purpose TEXT,state TEXT);
    CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT);`);
  t.after(()=>database.close());
  return database;
}

test('direct renderer cleanup retains the entire cache when any file is pinned or used by another project',async t=>{
  for(const protection of ['pinned','shared-registry','fresh-project-input','invalid-registry']) {
    const f=await completedCache(t),database=cacheReferenceDatabase(t,f),filename=path.join(f.publicDir,f.assets[0].path);
    database.prepare('INSERT INTO storage_artifacts VALUES(1,?,?)').run(filename,Number(protection==='pinned'));
    if(protection==='shared-registry')database.exec("INSERT INTO storage_artifact_refs VALUES(1,'episode','27','source','completed')");
    if(protection==='fresh-project-input')database.prepare('INSERT INTO remotion_assets VALUES(27,?)').run(filename);
    if(protection==='invalid-registry')database.exec('DROP TABLE storage_artifact_refs');
    const result=await cleanupHistoryMotionRenderCache(f.output,{referenceOptions:{projectRoot:f.directory}});
    assert.equal(result.status,'retained',protection);assert.equal(result.logicalBytesRemoved,0);
    assert.ok(fs.existsSync(f.bundle));assert.ok(fs.existsSync(filename));
  }
});

test('direct renderer cleanup fails closed for a missing ownership database and honors an explicit preserve marker',async t=>{
  for(const protection of ['missing-database','preserve-marker']) {
    const f=await completedCache(t);
    if(protection==='preserve-marker')f.put(path.join(f.work,'storage-preserve.json'),JSON.stringify({version:1,files:['bundle']}));
    const result=await cleanupHistoryMotionRenderCache(f.output,
      protection==='missing-database'?{referenceOptions:{projectRoot:f.directory}}:{});
    assert.equal(result.status,'retained');assert.ok(fs.existsSync(f.bundle));
  }
});

test('direct renderer cleanup still releases an unreferenced cache with a readable registry',async t=>{
  const f=await completedCache(t);cacheReferenceDatabase(t,f);
  const result=await cleanupHistoryMotionRenderCache(f.output,{referenceOptions:{projectRoot:f.directory}});
  assert.equal(result.status,'completed');assert.ok(result.logicalBytesRemoved>0);
});

test('successful render cache cleanup preserves delivery, originals, fonts and evidence',async t=>{
  const f=await completedCache(t),result=await cleanupHistoryMotionRenderCache(f.output);
  assert.equal(result.status,'completed');assert.ok(result.logicalBytesRemoved>0);
  assert.equal(fs.existsSync(f.bundle),false);assert.equal(fs.existsSync(path.join(f.publicDir,'assets')),false);
  for(const filename of [f.output,f.report.preview,...f.assets.map(asset=>asset.source),
    path.join(f.publicDir,'fonts/example.ttf'),path.join(f.work,'plan.json'),path.join(f.work,'props.json'),
    path.join(f.work,'assets.json'),path.join(f.work,'samples/frame.png'),path.join(f.directory,'movie-review.html')])
    assert.ok(fs.existsSync(filename),filename);
  assert.equal(JSON.parse(fs.readFileSync(f.output+'.json','utf8')).cacheCleanup.status,'completed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.work,'cache-cleanup.json'),'utf8')).status,'completed');
  assert.equal((await cleanupHistoryMotionRenderCache(f.output)).status,'completed','cleanup is idempotent');
});

test('cache cleanup retains copies when an original is missing or changed',async t=>{
  for(const change of ['missing','changed']) {
    const f=await completedCache(t);
    if(change==='missing')fs.unlinkSync(f.assets[0].source);else fs.writeFileSync(f.assets[0].source,'replacement video');
    const result=await cleanupHistoryMotionRenderCache(f.output);
    assert.equal(result.status,'retained');assert.ok(result.reason);
    assert.ok(fs.existsSync(f.bundle));assert.ok(fs.existsSync(path.join(f.publicDir,f.assets[0].path)));
    assert.equal(JSON.parse(fs.readFileSync(f.output+'.json','utf8')).status,'completed');
  }
});

test('cache cleanup requires complete evidence and never touches an active or failed render',async t=>{
  for(const change of ['active','failed','missing-preview','missing-props','changed-output']) {
    const f=await completedCache(t);
    if(change==='active')f.put(f.output+'.lock','active');
    if(change==='failed'){f.report.status='failed';f.saveReport();}
    if(change==='missing-preview')fs.unlinkSync(f.report.preview);
    if(change==='missing-props')fs.unlinkSync(path.join(f.work,'props.json'));
    if(change==='changed-output')fs.writeFileSync(f.output,'different movie');
    const result=await cleanupHistoryMotionRenderCache(f.output);
    assert.equal(result.status,'retained');assert.ok(fs.existsSync(f.bundle));
    assert.ok(fs.existsSync(path.join(f.publicDir,f.assets[0].path)));
  }
});

test('cache cleanup preserves unique cache content and sources inside the deletion targets',async t=>{
  for(const change of ['changed-copy','unknown-copy','source-inside-cache']) {
    const f=await completedCache(t);
    if(change==='changed-copy')fs.writeFileSync(path.join(f.publicDir,f.assets[0].path),'unique edit');
    if(change==='unknown-copy')f.put(path.join(f.bundle,'public/assets/unique.mp4'),'unique video');
    if(change==='source-inside-cache') {
      f.assets[0].source=path.join(f.publicDir,f.assets[0].path);
      f.put(path.join(f.work,'assets.json'),JSON.stringify(f.assets));f.saveReport();
    }
    const result=await cleanupHistoryMotionRenderCache(f.output);
    assert.equal(result.status,'retained');assert.ok(fs.existsSync(f.bundle));
    assert.ok(fs.existsSync(path.join(f.publicDir,f.assets[0].path)));
  }
});

test('cache retention is available for debugging and cleanup errors keep the movie completed',async t=>{
  const retained=await completedCache(t);
  assert.equal((await cleanupHistoryMotionRenderCache(retained.output,{retainCache:true})).status,'retained');
  assert.ok(fs.existsSync(retained.bundle));
  const failing=await completedCache(t),remove=fs.rmSync;
  const mock=t.mock.method(fs,'rmSync',(filename,options)=>{
    if(filename===failing.bundle)throw Error('simulated filesystem cleanup failure');
    return remove(filename,options);
  });
  const result=await cleanupHistoryMotionRenderCache(failing.output);
  mock.mock.restore();
  assert.equal(result.status,'failed');assert.match(result.reason,/simulated/);
  assert.equal(JSON.parse(fs.readFileSync(failing.output+'.json','utf8')).status,'completed');
  assert.ok(fs.existsSync(failing.output));assert.ok(fs.existsSync(failing.report.preview));
});

test('render finalization cleans only after releasing its lock and preserves failed-render caches',async t=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-cache-finalize-')));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const source=path.join(directory,'original.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=1920x1080:r=30',
    '-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast',
    '-pix_fmt','yuv420p','-c:a','aac',source]);
  const value=plan();value.audioPath=source;value.shots[0].sourcePath=source;
  const prepare=(name,input)=>{
    const output=path.join(directory,name+'.mp4'),work=output+'.render',planFile=path.join(directory,name+'-plan.json');
    fs.mkdirSync(work);fs.writeFileSync(planFile,JSON.stringify(input));fs.writeFileSync(path.join(work,'plan.json'),JSON.stringify(input));
    fs.copyFileSync(source,output+'.partial.mp4');return {output,work,plan:planFile,resume:true};
  };
  const success=prepare('completed',value),report=await renderHistoryMotion(success);
  assert.equal(report.status,'completed');assert.equal(report.cacheCleanup.status,'completed');
  assert.equal(report.uploadEncoding.encoder,'libx264');assert.equal(report.encoding.hardwareAcceleration,undefined);
  assert.equal(report.frameCapture,null,'finalization cannot infer how a preexisting partial captured its frames');
  assert.equal(fs.existsSync(success.output+'.lock'),false);
  assert.equal(fs.existsSync(path.join(success.work,'public/assets')),false);
  assert.ok(fs.existsSync(source));assert.ok(fs.existsSync(report.preview));
  const designed=prepare('saved-design',value),savedPlan=applyShotcraftDesign(value);
  savedPlan.shots[0].shotcraft.recipe='saved-custom-recipe';
  fs.writeFileSync(path.join(designed.work,'shotcraft-plan.json'),JSON.stringify({sourcePlanSha256:await fileSha256(designed.plan),plan:savedPlan}));
  const resumed=await renderHistoryMotion(designed);
  assert.equal(resumed.visuals[0].shotcraft.recipe,'saved-custom-recipe','resume uses the frozen design, not current automatic rules');
  assert.deepEqual(resumed.shotcraft,savedPlan.shotcraft);
  const mismatched=prepare('wrong-design',value);
  fs.writeFileSync(path.join(mismatched.work,'shotcraft-plan.json'),JSON.stringify({sourcePlanSha256:'0'.repeat(64),plan:savedPlan}));
  await assert.rejects(renderHistoryMotion(mismatched),/design from a different plan/);
  assert.ok(fs.existsSync(mismatched.output+'.partial.mp4'),'a mismatched manifest must preserve the rendered partial');
  const invalid=structuredClone(value);invalid.durationInFrames=90;invalid.shots[0].frames=90;invalid.shots[0].shortfallPolicy='freeze';
  const failed=prepare('failed',invalid);
  await assert.rejects(renderHistoryMotion(failed),/Narration duration/);
  assert.ok(fs.existsSync(path.join(failed.work,'public/assets/0001.mp4')));
  assert.ok(fs.existsSync(path.join(failed.work,'failure.json')));
  assert.equal(fs.existsSync(path.join(failed.work,'cache-cleanup.json')),false);
});

test('low-space preflight leaves an existing render checkpoint untouched before copying media',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-space-preflight-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const output=path.join(directory,'movie.mp4'),work=output+'.render',planFile=path.join(directory,'plan.json');
  const value=plan();fs.mkdirSync(work);fs.writeFileSync(planFile,JSON.stringify(value));
  fs.writeFileSync(path.join(work,'plan.json'),JSON.stringify(value));fs.writeFileSync(output+'.partial.mp4','saved partial');
  const lowSpace=Object.assign(new Error('reserve reached'),{code:'MEDIA_DISK_FULL'});
  await assert.rejects(renderHistoryMotion({plan:planFile,output,resume:true},{checkDiskSpace:async()=>{throw lowSpace;}}),lowSpace);
  assert.equal(fs.readFileSync(output+'.partial.mp4','utf8'),'saved partial');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work,'plan.json'),'utf8')),value);
  assert.equal(fs.existsSync(path.join(work,'public')),false);
  assert.equal(fs.existsSync(output+'.lock'),false);
});

test('a render is canceled when disk reserve falls and keeps its partial media and checkpoint',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-space-cancel-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const audio=path.join(directory,'audio.m4a'),planFile=path.join(directory,'plan.json'),output=path.join(directory,'movie.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:a','aac',audio]);
  const value=plan();value.audioPath=audio;value.shots=[{shotId:'one',startFrame:0,frames:60,visualType:'graphic',
    graphic:{kind:'quote',title:'Saved checkpoint',items:[{label:'Saved checkpoint'}]}}];
  fs.writeFileSync(planFile,JSON.stringify(value));
  t.mock.timers.enable({apis:['setInterval']});
  const lowSpace=Object.assign(new Error('reserve reached during render'),{code:'MEDIA_DISK_FULL'});
  const {makeCancelSignal}=requireRemotion('@remotion/renderer');
  let rendering=false,canceled=false,checks=0,notifyStarted;
  const started=new Promise(resolve=>{notifyStarted=resolve;});
  const promise=renderHistoryMotion({plan:planFile,output},{
    browserExecutable:process.execPath,bundler:{bundle:async()=>directory},
    checkDiskSpace:async()=>{checks++;if(rendering)throw lowSpace;},
    renderer:{makeCancelSignal,selectComposition:async()=>({}),renderMedia:async({cancelSignal,outputLocation})=>{
      fs.writeFileSync(outputLocation,'render progress');rendering=true;notifyStarted();
      return new Promise((_resolve,reject)=>cancelSignal(()=>{canceled=true;reject(Error('renderMedia() got cancelled'));}));
    }},
  });
  const rejected=assert.rejects(promise,lowSpace);
  await started;t.mock.timers.tick(1000);await rejected;
  assert.equal(canceled,true);
  assert.equal(fs.readFileSync(output+'.partial.mp4','utf8'),'render progress');
  assert.ok(fs.existsSync(path.join(output+'.render','plan.json')));
  assert.ok(fs.existsSync(path.join(output+'.render','props.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(output+'.render','failure.json'),'utf8')).error,lowSpace.message);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output+'.render','failure.json'),'utf8')).code,'MEDIA_DISK_FULL');
  assert.equal(fs.existsSync(output+'.lock'),false);
  assert.equal(fs.existsSync(output),false);
  const completedChecks=checks;t.mock.timers.tick(5000);await Promise.resolve();assert.equal(checks,completedChecks);
});

test('new renders require hardware without software quality flags and preserve failed hardware checkpoints',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-hardware-contract-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const audio=path.join(directory,'audio.m4a'),planFile=path.join(directory,'plan.json'),output=path.join(directory,'movie.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:a','aac',audio]);
  const value=plan();value.audioPath=audio;value.shots=[{shotId:'one',startFrame:0,frames:60,visualType:'graphic',
    graphic:{kind:'quote',title:'Hardware contract',items:[{label:'Hardware contract'}]}}];
  fs.writeFileSync(planFile,JSON.stringify(value));
  const {makeCancelSignal}=requireRemotion('@remotion/renderer');
  let calls=0,options;
  await assert.rejects(renderHistoryMotion({plan:planFile,output},{checkDiskSpace:async()=>{},browserExecutable:process.execPath,
    bundler:{bundle:async()=>directory},renderer:{makeCancelSignal,selectComposition:async()=>({}),renderMedia:async input=>{
      calls++;options=input;
      input.onProgress({progress:.5,renderedFrames:40,encodedFrames:20,renderedDoneIn:null,encodedDoneIn:null,stitchStage:'encoding'});
      throw Error('Hardware encoder unavailable');
    }}}),/Hardware encoder unavailable/);
  assert.equal(calls,1);
  assert.equal(options.hardwareAcceleration,'required');
  assert.equal(options.videoBitrate,'2000k');
  assert.equal(options.crf,null);
  assert.equal(options.x264Preset,null);
  assert.equal(options.encodingMaxRate,undefined);
  assert.equal(options.encodingBufferSize,undefined);
  assert.equal(fs.existsSync(output),false);
  const work=output+'.render',progress=JSON.parse(fs.readFileSync(path.join(work,'progress.json'),'utf8'));
  const design=JSON.parse(fs.readFileSync(path.join(work,'shotcraft-plan.json'),'utf8'));
  assert.equal(design.sourcePlanSha256,await fileSha256(planFile));assert.equal(design.plan.shotcraft.version,1);
  assert.equal(progress.renderedFrames,40);assert.equal(progress.encodedFrames,20);
  assert.equal(progress.stitchStage,'encoding');
  const failure=JSON.parse(fs.readFileSync(path.join(work,'failure.json'),'utf8'));
  assert.match(failure.error,/Hardware encoder unavailable/);
  assert.equal(failure.performance.frameRenderingMs,null);assert.equal(failure.performance.encodingAndMuxingMs,null);
  assert.ok(failure.performance.renderMediaMs>=0);assert.ok(failure.performance.totalMs>=failure.performance.renderMediaMs);
});
