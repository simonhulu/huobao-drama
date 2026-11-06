import assert from 'node:assert/strict';
import test from 'node:test';
import {applyShotcraftDesign} from './shotcraft.mjs';

const legacy={kind:'kenburns',durationScale:1,keyframes:[{t:0,focusX:.5,focusY:.5,zoom:1},{t:1,focusX:.5,focusY:.5,zoom:1.06}]};
const shot=(narration,index,extra={})=>({shotId:`s${index}`,startFrame:index*180,frames:180,visualType:'image',imagePath:`${index}.png`,narration,motion:structuredClone(legacy),...extra});
const plan=shots=>({fps:30,width:1920,height:1080,durationInFrames:shots.length*180,audioPath:'voice.m4a',captions:[{text:'原文',startFrame:0,endFrame:180}],shots});

test('shot design preserves inputs, timing, narration and media while replacing repeated automatic zoom',()=>{
  const input=plan([shot('城墙向四周展开。',0),shot('危机已经逼近。',1),shot('双方开始交战。',2),shot('这段往事就此结束。',3)]);
  const before=structuredClone(input),result=applyShotcraftDesign(input);
  assert.deepEqual(input,before);assert.deepEqual(result,applyShotcraftDesign(input));
  assert.deepEqual(applyShotcraftDesign(result),result,'applying the design twice must not redesign a finished plan');
  for(const key of ['audioPath','captions','durationInFrames','fps'])assert.deepEqual(result[key],input[key]);
  result.shots.forEach((s,i)=>{
    for(const key of ['shotId','startFrame','frames','narration','imagePath'])assert.equal(s[key],input.shots[i][key]);
    assert.equal(s.shotcraft.version,1);
  });
  assert.equal(result.shots[0].shotcraft.recipe,'establishing-reveal');
  assert.equal(result.shots[1].shotcraft.recipe,'slow-push-in');
  assert.notEqual(result.shots[2].shotcraft.recipe,'slow-push-in','accent camera is not repeated throughout the film');
  assert.ok(new Set(result.shots.map(s=>JSON.stringify(s.motion))).size>=3);
  assert.ok(result.shots[0].motion.keyframes[0].zoom>result.shots[0].motion.keyframes.at(-1).zoom);
  assert.equal(result.shots[1].motion.keyframes.at(-1).zoom,1.14);
  assert.equal(result.shots[1].motion.keyframes.at(-1).easing,'ease-in');
});

test('custom cameras, static images, footage and map coordinates remain intact',()=>{
  const custom={kind:'pan',durationScale:1,keyframes:[{t:0,focusX:.25,focusY:.4,zoom:1.1},{t:1,focusX:.7,focusY:.4,zoom:1.1}]};
  const input=plan([shot('镜头',0,{motion:custom}),shot('静止',1,{motion:{kind:'static'}}),
    shot('行军',2,{visualType:'map',imagePath:undefined,map:{enabled:true,cities:[{x:.4,y:.3}]}}),
    shot('行军',3,{visualType:'video',imagePath:undefined,sourcePath:'v.mp4',motion:null})]);
  const result=applyShotcraftDesign(input);
  assert.deepEqual(result.shots[0].motion,custom);assert.deepEqual(result.shots[1].motion,{kind:'static'});
  assert.deepEqual(result.shots[2].map,input.shots[2].map);assert.deepEqual(result.shots[2].motion,input.shots[2].motion);
  assert.equal(result.shots[3].motion,null);
});

test('ordinary movement settles before the cut and short shots do not get aggressive cameras',()=>{
  const result=applyShotcraftDesign(plan([shot('城池',0),shot('观察田野',1),shot('一句话',2,{frames:24})]));
  for(const s of result.shots.slice(0,2)) {
    assert.ok(s.motion.durationScale<1);assert.ok((s.frames-1)*(1-s.motion.durationScale)>=15);
    for(const k of s.motion.keyframes)assert.ok(k.zoom>=1 && k.zoom<=1.15 && k.focusX>=0 && k.focusX<=1);
  }
  assert.equal(result.shots[2].shotcraft.recipe,'hold');
});

test('explanatory overlays retain all facts and keep the camera still for reading',()=>{
  const graphic={kind:'comparison',title:'两方部署',items:[{label:'甲',detail:'原有信息'},{label:'乙',value:'另一项'}]};
  const input=plan([shot('双方部署',0,{graphic})]);
  const result=applyShotcraftDesign(input);
  assert.deepEqual(result.shots[0].graphic,graphic);assert.equal(result.shots[0].motion.kind,'static');
  assert.equal(result.shots[0].shotcraft.graphicRecipe,'comparison');
});
