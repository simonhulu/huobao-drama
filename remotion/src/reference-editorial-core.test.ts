import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceEffectState, referenceEmotionMotion, referenceAccentMotion, referenceSweatMotion, referenceTitleMotion, referencePageState, referenceTextFit, referenceRoutePoint, referenceMapRouteState, validateReferenceEditorialProps, type ReferenceEditorialProps, type ReferenceEffect, type ReferenceMapRoute} from './reference-editorial-core';

const effect: ReferenceEffect = {id:'title',kind:'title-scroll',text:'收回权力',x:.3,y:.05,width:.4,height:.16,startFrame:12,endFrame:72,space:'screen'};
const props: ReferenceEditorialProps = {width:1920,height:1080,fps:30,durationInFrames:90,shotDurationInFrames:240,shotFrameOffset:60,camera:{mode:'push',amount:.02,focusX:.5,focusY:.5},effects:[effect]};
test('reference title has exact clip boundaries, fade in, stable hold and clean exit',()=>{
  assert.equal(referenceEffectState(effect,11,30).active,false);
  assert.equal(referenceEffectState(effect,12,30).opacity,0);
  assert.equal(referenceEffectState(effect,20,30).opacity,1);
  assert.equal(referenceEffectState(effect,45,30).opacity,1);
  assert.equal(referenceEffectState(effect,71,30).opacity,0);
  assert.equal(referenceEffectState(effect,72,30).active,false);
});
test('book page preserves clip timing and fades the full layout as one layer',()=>{
  const page={title:'收回权力',imageSrc:'https://localhost/image.png',startFrame:10,endFrame:80};
  assert.equal(referencePageState(page,9,30).active,false);
  assert.equal(referencePageState(page,10,30).opacity,0);
  assert.equal(referencePageState(page,10,30).blackOpacity,0);
  assert.equal(referencePageState(page,13,30).blackOpacity,.5);
  assert.equal(referencePageState(page,16,30).blackOpacity,1);
  assert.equal(referencePageState(page,16,30).opacity,0);
  assert.equal(referencePageState(page,23,30).opacity,.5);
  assert.equal(referencePageState(page,30,30).opacity,1);
  assert.equal(referencePageState(page,79,30).opacity,1);
  assert.equal(referencePageState(page,80,30).active,false);
  assert.equal(referencePageState(page,80,30).blackOpacity,0);
  assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,page,captions:[{startFrame:10,endFrame:50,text:'收回权力\\N稳住朝局'}]}));
  for (const patch of [{title:''},{imageSrc:''},{startFrame:-1},{endFrame:91},{fontSize:0}]) assert.throws(()=>validateReferenceEditorialProps({...props,page:{...page,...patch}}));
  assert.throws(()=>validateReferenceEditorialProps({...props,page,captions:[{startFrame:10,endFrame:50,text:'a'},{startFrame:49,endFrame:70,text:'b'}]}));
});
test('short book transition leaves a readable hold without extending its window',()=>{
  const page={title:'权力',imageSrc:'a.png',startFrame:0,endFrame:12};
  assert.equal(referencePageState(page,1,30).blackOpacity,1);
  assert.equal(referencePageState(page,1,30).opacity,0);
  assert.equal(referencePageState(page,5,30).opacity,1);
  assert.equal(referencePageState(page,11,30).opacity,1);
  assert.equal(referencePageState(page,12,30).active,false);
});
test('reaction stages settle monotonically and never loop',()=>{
  const a=referenceEffectState(effect,19,30);
  assert.equal(a.part(8,6),0);
  assert.ok(a.part(0,8)>a.part(4,8));
  for(const frame of [35,45,60]) assert.equal(referenceEffectState(effect,frame,30).part(8,6),1);
  assert.equal(referenceEffectState(effect,45,30).draw,1);
});
test('multiline title fits both width and height without squeezing glyphs',()=>{
  const fit=referenceTextFit('收回权力\n稳住朝局',300,120,100);
  assert.equal(fit.lines.length,2);
  assert.ok(fit.size*4<=300);
  assert.ok(fit.size*2*1.18<=120);
});
test('rejects invalid windows, offscreen bounds and empty titles',()=>{
  assert.doesNotThrow(()=>validateReferenceEditorialProps(props));
  for(const patch of [{endFrame:91},{startFrame:-1},{text:''},{x:.8},{width:NaN},{fontSize:0}])
    assert.throws(()=>validateReferenceEditorialProps({...props,effects:[{...effect,...patch}]}));
  assert.throws(()=>validateReferenceEditorialProps({...props,shotFrameOffset:200}));
  assert.throws(()=>validateReferenceEditorialProps({...props,effects:[effect,effect]}));
});
test('brush glyphs stagger and scroll completes without squeezing the held title',()=>{
  assert.ok(referenceTitleMotion(8,30,90,0,4).reveal > referenceTitleMotion(8,30,90,3,4).reveal);
  assert.ok(referenceTitleMotion(10,30,90,0,4,true).open < 1);
  for (const duration of [12,90]) {
    const m=referenceTitleMotion(Math.floor(duration*.5),30,duration,3,4,true);
    assert.equal(m.open,1);
    assert.equal(m.reveal,1);
    assert.equal(m.scale,1);
    assert.equal(m.y,0);
  }
});
test('emotions visibly evolve after the initial half second and remain deterministic',()=>{
  const a=referenceEmotionMotion(.8),b=referenceEmotionMotion(1.4),c=referenceEmotionMotion(2.1);
  assert.notEqual(a.phase,b.phase);
  assert.notEqual(b.tilt,c.tilt);
  assert.ok(a.energy>.5 && b.energy>.5 && c.energy>.5);
  assert.deepEqual(referenceEmotionMotion(1.4),b);
  for(let t=0;t<10;t+=.02) {
    const m=referenceEmotionMotion(t);
    assert.ok(Math.abs(m.tilt)<=3.2);
    assert.ok(m.cloudScale>=0 && m.cloudScale<1.2);
  }
});
test('sweat forms, falls, fades and repeats invisibly with staggered timing',()=>{
  assert.equal(referenceSweatMotion(.1,0).opacity,0);
  const a=referenceSweatMotion(.8,0),b=referenceSweatMotion(1.35,0);
  assert.ok(b.y>a.y);
  assert.notEqual(a.y,referenceSweatMotion(.8,1).y);
  assert.ok(referenceSweatMotion(1.9,0).opacity<.02);
  assert.ok(referenceSweatMotion(2.5,0).opacity>.5);
  assert.equal(referenceEffectState({...effect,kind:'reaction-sweat'},72,30).active,false);
  assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,effects:[{...effect,kind:'reaction-sweat'}]}));
  assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,effects:[{...effect,motion:'stamp'}]}));
});
test('new emotions use distinct clocks, two anger pulses and sustained secondary motion',()=>{
  assert.ok(referenceAccentMotion(.28).angerScale>referenceAccentMotion(.6).angerScale);
  assert.ok(referenceAccentMotion(.95).angerScale>referenceAccentMotion(.6).angerScale);
  assert.ok(Math.abs(referenceAccentMotion(2).angerScale-1)<.001);
  assert.ok(referenceAccentMotion(.15).burst>.8);
  assert.equal(referenceAccentMotion(.6).burst,0);
  assert.notEqual(referenceAccentMotion(.8).steamY,referenceAccentMotion(1.4).steamY);
  assert.notEqual(referenceAccentMotion(.8).stressY,referenceAccentMotion(1.4).stressY);
  assert.notEqual(referenceAccentMotion(.8).glintScale,referenceAccentMotion(1.4).glintScale);
  assert.deepEqual(referenceAccentMotion(1.4),referenceAccentMotion(1.4));
  for(let t=0;t<6;t+=.025) {
    const m=referenceAccentMotion(t);
    assert.ok(m.shockScale>=0 && m.shockScale<1.2);
    assert.ok(m.steamOpacity>=0 && m.steamOpacity<=.78);
  }
});
test('new emotion kinds preserve exact windows and stamp impact appears faster than brush',()=>{
  for(const kind of ['reaction-anger','reaction-shock','reaction-gloom','reaction-idea'] as const){
    const e={...effect,kind};
    assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,effects:[e]}));
    assert.equal(referenceEffectState(e,11,30).active,false);
    assert.equal(referenceEffectState(e,12,30).opacity,0);
    assert.equal(referenceEffectState(e,71,30).opacity,0);
    assert.equal(referenceEffectState(e,72,30).active,false);
  }
  assert.equal(referenceEffectState({...effect,motion:'stamp'},14,30).opacity,1);
  assert.ok(referenceEffectState(effect,14,30).opacity<.2);
  assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,effects:[{...effect,emphasisText:'权力',emphasisColor:'#963e2d'}]}));
  assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,effects:[{...effect,text:'寄\n生',emphasisText:'寄生',emphasisColor:'#963e2d'}]}));
  assert.doesNotThrow(()=>validateReferenceEditorialProps({...props,effects:[{...effect,text:'收回\n权力',emphasisText:'回\n权'}]}));
  assert.throws(()=>validateReferenceEditorialProps({...props,effects:[{...effect,emphasisText:'missing'}]}));
});

const mapRoute: ReferenceMapRoute = {points:[[.1,.2],[.3,.2],[.3,.8]],revealStartOffset:6,revealEndOffset:54,pulseFrames:15,marker:'ship',historyStatus:'illustrative',coordinateSource:'Natural Earth WGS84; intermediate vertices illustrative'};
const mapEffect: ReferenceEffect = {id:'eastward',kind:'map-route',x:0,y:0,width:1,height:1,startFrame:0,endFrame:90,space:'screen',route:mapRoute};
const mapProps: ReferenceEditorialProps = {...props,shotFrameOffset:0,camera:{mode:'hold',amount:0,focusX:.5,focusY:.5},effects:[mapEffect]};

test('map marker travels by pixel length rather than point index or normalized distance',()=>{
  assert.deepEqual(referenceRoutePoint(mapRoute.points,0,200,100),{x:20,y:20,angle:0});
  const halfway=referenceRoutePoint(mapRoute.points,.5,200,100);
  assert.equal(halfway.x,60);
  assert.equal(halfway.y,30);
  assert.equal(halfway.angle,90);
  assert.deepEqual(referenceRoutePoint(mapRoute.points,1,200,100),{x:60,y:80,angle:90});
  assert.deepEqual(referenceRoutePoint([[.1,.2],[.1,.2],[.3,.2]],.5,200,100),{x:40,y:20,angle:0});
});

test('map reveal, arrival pulse and settled hold are deterministic across cropped clips',()=>{
  assert.equal(referenceMapRouteState(mapRoute,5,1920,1080).reveal,0);
  assert.equal(referenceMapRouteState(mapRoute,30,1920,1080).reveal,.5);
  assert.equal(referenceMapRouteState(mapRoute,53,1920,1080).pulseOpacity,0);
  assert.equal(referenceMapRouteState(mapRoute,54,1920,1080).pulseOpacity,.72);
  const arrival=referenceMapRouteState(mapRoute,54,1920,1080);
  const later=referenceMapRouteState(mapRoute,62,1920,1080);
  assert.ok(later.pulseRadius>arrival.pulseRadius);
  assert.ok(later.pulseOpacity<arrival.pulseOpacity);
  for(const frame of [69,77,83]) {
    const hold=referenceMapRouteState(mapRoute,frame,1920,1080);
    assert.equal(hold.reveal,1);
    assert.equal(hold.pulseOpacity,0);
    assert.deepEqual(hold.head,arrival.head);
    assert.equal(referenceEffectState(mapEffect,frame,30).opacity,1);
  }
  // propsForShot subtracts only effect.start/end; offsets stay effect-relative.
  const original={...mapEffect,startFrame:20,endFrame:110};
  assert.deepEqual(referenceMapRouteState(mapRoute,referenceEffectState(original,70,30).local,1920,1080),referenceMapRouteState(mapRoute,referenceEffectState(mapEffect,50,30).local,1920,1080));
});

test('map contract rejects camera drift, invalid geometry, lost hold and absent provenance',()=>{
  assert.doesNotThrow(()=>validateReferenceEditorialProps(mapProps));
  assert.throws(()=>validateReferenceEditorialProps({...mapProps,camera:props.camera}),/hold camera/);
  for(const patch of [{space:'image' as const},{x:.1,width:.9}])
    assert.throws(()=>validateReferenceEditorialProps({...mapProps,effects:[{...mapEffect,...patch}]}),/full-frame/);
  for(const patch of [{points:[[0,0],[1920,1080]]},{points:[[.2,.3],[.2,.3]]},{points:[[0,0],[NaN,1]]},{points:[[0,0]]}])
    assert.throws(()=>validateReferenceEditorialProps({...mapProps,effects:[{...mapEffect,route:{...mapRoute,...patch} as ReferenceMapRoute}]}),/normalized points/);
  for(const patch of [{revealEndOffset:75},{revealStartOffset:54},{pulseFrames:60},{revealStartOffset:1.5}])
    assert.throws(()=>validateReferenceEditorialProps({...mapProps,effects:[{...mapEffect,route:{...mapRoute,...patch}}]}),/readable hold/);
  assert.throws(()=>validateReferenceEditorialProps({...mapProps,effects:[{...mapEffect,route:{...mapRoute,coordinateSource:''}}]}),/provenance/);
});
