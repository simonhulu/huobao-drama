import test from 'node:test';
import assert from 'node:assert/strict';
import {schedule,wav} from './editorial_sfx.mjs';
const plan=(cues)=>({fps:30,duration:3,shots:[{storyboardNumber:2,startFrame:30,frames:30,audioCues:cues}]});
test('cue local frame maps exactly to global sample and clips to cut',()=>{
 const [e]=schedule(plan([{kind:'scroll',frame:28,gainDb:-24}]));
 assert.equal(e.globalFrame,58);assert.equal(e.startSample,92800);assert.equal(e.endSample,96000);
});
test('rejects invalid kinds, times and unreasonably loud gains',()=>{
 for(const c of [{kind:'../foo',frame:0},{kind:'__proto__',frame:0},{kind:'stamp',frame:-1},{kind:'stamp',frame:30},{kind:'stamp',frame:.5},{kind:'stamp',frame:0,gainDb:0},{kind:'stamp',frame:0,gainDb:NaN}])assert.throws(()=>schedule(plan([c])));
});
test('permits two overlapping cues, rejects three and out-of-episode events',()=>{
 const c={kind:'stamp',frame:2};assert.equal(schedule(plan([c,c])).length,2);assert.throws(()=>schedule(plan([c,c,c])));
 const p=plan([c]);p.duration=.5;assert.throws(()=>schedule(p));
});
test('PCM wave has correct stereo sample clock and bounded samples',()=>{
 const b=wav(new Float32Array([2,-2,.25,-.25]),2);
 assert.equal(b.readUInt32LE(24),48000);assert.equal(b.readUInt16LE(22),2);assert.equal(b.readUInt32LE(40),8);assert.equal(b.readInt16LE(44),32767);assert.equal(b.readInt16LE(46),-32767);
});
test('a per-project sound library controls cue duration without falling back to Kenney',()=>{
 const p=plan([{kind:'local_reaction',frame:0}]);
 p.soundAssets={local_reaction:{duration:.25,gainDb:-9}};
 const [event]=schedule(p);
 assert.equal(event.endSample-event.startSample,12000);
 assert.equal(event.gainDb,-9);
 p.shots[0].audioCues=[{kind:'stamp',frame:0}];
 assert.throws(()=>schedule(p),/Unknown/);
});
test('custom sound durations must be finite, positive and bounded',()=>{
 for(const duration of [0,-1,NaN,Infinity,11]){
  const p=plan([{kind:'local',frame:0}]);p.soundAssets={local:{duration,gainDb:-9}};
  assert.throws(()=>schedule(p),/duration/);
 }
});
