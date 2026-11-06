import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {compileFunction} from 'node:vm';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const requireRemotion=createRequire(path.join(root,'remotion/package.json'));
const compiled=requireRemotion('esbuild').buildSync({
  entryPoints:[path.join(root,'remotion/src/HistoryMotionFactory.tsx')],bundle:true,write:false,
  platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent',
});
const factory={exports:{}};
compileFunction(compiled.outputFiles[0].text,['require','module','exports'])(requireRemotion,factory,factory.exports);
const {graphicLayout,graphicReveal,GraphicLayer,CompanionGraphic,companionGraphicLayout,companionReveal,fitGraphicText,mapRouteState,motionAt,soundEffectEnvelope,soundEffectVolume,shotTransitionFrames,outgoingSceneOpacity}=factory.exports;
const React=requireRemotion('react');
const {renderToStaticMarkup}=requireRemotion('react-dom/server');

test('all graphic layouts reserve subtitle space on both profiles, including additional title overlays',()=>{
  for (const [width,height] of [[1920,1080],[1080,1920]]) {
    for (const kind of ['timeline','comparison','relationship','quote']) {
      for (const count of [1,2,3,4,9]) for (const titles of [false,true]) {
        const layout=graphicLayout(kind,count,width,height,titles);
        assert.ok(layout.title.y+layout.title.height<layout.content.y);
        for (const box of layout.boxes) {
          assert.ok(box.x>=0 && box.y>=0 && box.width>0 && box.height>0);
          assert.ok(box.x+box.width<=width*.92+.01);
          assert.ok(box.y+box.height<=height*.76+.01,'graphic must stay clear of captions');
        }
        for(let i=0;i<layout.boxes.length;i++) for(let j=i+1;j<layout.boxes.length;j++) {
          const a=layout.boxes[i],b=layout.boxes[j];
          assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
        }
      }
    }
  }
});

test('graphic information enters in order, then holds; pagination preserves every item',()=>{
  assert.deepEqual(graphicReveal(0,120,0,4),{enter:0,detail:0});
  assert.ok(graphicReveal(30,120,0,4).enter>graphicReveal(30,120,3,4).enter);
  for(let index=0;index<4;index++) {
    assert.deepEqual(graphicReveal(90,120,index,4),{enter:1,detail:1});
    assert.deepEqual(graphicReveal(115,120,index,4),{enter:1,detail:1});
  }
  const graphic={kind:'timeline',title:'事件顺序',items:Array.from({length:9},(_,i)=>({label:`步骤${i+1}`,detail:`细节${i+1}`}))};
  const pages=[89,179,269].map(frame=>renderToStaticMarkup(React.createElement(GraphicLayer,{graphic,frame,frames:270,width:1920,height:1080})));
  for(let i=0;i<9;i++) assert.ok(pages.some(html=>html.includes(`步骤${i+1}`)&&html.includes(`细节${i+1}`)));
  assert.ok(!pages[0].includes('步骤5'));
});

test('long Chinese labels and unbroken words shrink inside fixed text boxes',()=>{
  assert.equal(fitGraphicText('秦军',400,100,46),46);
  assert.ok(fitGraphicText('秦军沿河谷行军并切断赵军退路'.repeat(3),200,100,46)<46);
  assert.ok(fitGraphicText('UninterruptedHistoricalIdentifier'.repeat(3),160,80,46)<46);
});

test('static images share camera keyframes, including final-frame hold after accelerated movement',()=>{
  const shot={frames:120,motion:{kind:'kenburns',durationScale:.6,keyframes:[
    {t:0,focusX:.3,focusY:.4,zoom:1},{t:1,focusX:.7,focusY:.6,zoom:1.2,easing:'linear'},
  ]}};
  assert.equal(motionAt(shot,0).zoom,1);
  assert.ok(motionAt(shot,30).zoom>1);
  assert.equal(motionAt(shot,90).zoom,1.2);
  assert.deepEqual(motionAt(shot,90),motionAt(shot,119));
});

test('map routes draw over time and move the marker by screen-space arc length',()=>{
  const route={points:[[.1,.5],[.2,.5],[.9,.5]],color:'#ed3f57',start:1,end:3};
  const start=mapRouteState(route,.5,1000,500,4),middle=mapRouteState(route,2,1000,500,4),end=mapRouteState(route,4,1000,500,4);
  assert.equal(start.progress,0);assert.equal(start.head.x,100);
  assert.equal(middle.progress,.5);assert.equal(middle.head.x,500);
  assert.equal(end.progress,1);assert.equal(end.head.x,900);
  assert.ok(middle.path.includes('L 200 250'));
  const short=mapRouteState({points:route.points,color:route.color},.5,1000,500,.5);
  assert.equal(short.progress,1,'default route timing must fit short shots');
});

test('SFX fade at clip boundaries and simultaneous effects cannot overpower narration',()=>{
  const effects=Array.from({length:8},(_,i)=>({sourcePath:`effect-${i}.wav`,startFrame:30,frames:60,volume:i===0 ? .01 : 10}));
  for(let frame=0;frame<120;frame++) {
    const gains=effects.map((_,index)=>soundEffectVolume(effects,index,frame,30));
    assert.ok(gains.every(gain=>Number.isFinite(gain)&&gain>=0&&gain<=.18));
    assert.ok(gains.reduce((sum,gain)=>sum+gain,0)<=.15000001);
    if(frame<30||frame>=90) assert.ok(gains.every(gain=>gain===0));
  }
  assert.equal(soundEffectEnvelope(effects[1],30,30),0);
  assert.equal(soundEffectEnvelope(effects[1],89,30),0);
  assert.ok(soundEffectEnvelope(effects[1],31,30)>0);
  assert.ok(soundEffectEnvelope(effects[1],31,30)<soundEffectEnvelope(effects[1],40,30));
  for(const frames of [1,2,3]) assert.ok(Number.isFinite(soundEffectVolume([{...effects[0],frames}],0,30,30)));
});

test('scene handoffs preserve the locked timeline and stay short for brief shots',()=>{
  const shots=[{shotId:'first',startFrame:0,frames:150,sourcePath:'a.mp4'},
    {shotId:'second',startFrame:150,frames:120,sourcePath:'b.mp4'},
    {shotId:'image',startFrame:270,frames:90,imagePath:'c.png'},
    {shotId:'brief',startFrame:360,frames:15,sourcePath:'d.mp4'}];
  const before=structuredClone(shots);
  assert.equal(shotTransitionFrames(undefined,shots[0],30),0,'opening frame must not fade in from black');
  assert.equal(shotTransitionFrames(shots[0],shots[1],30),8);
  assert.equal(shotTransitionFrames(shots[1],shots[2],30),12);
  assert.equal(shotTransitionFrames(shots[2],shots[3],30),3,'brief scenes retain time to read');
  assert.equal(shotTransitionFrames(shots[0],{...shots[1],startFrame:151},30),0);
  assert.deepEqual(shots,before,'dissolve must not shift narration, shorten shots or extend the composition');
  for(const frames of [3,8,12]) {
    const opacity=Array.from({length:frames},(_,frame)=>outgoingSceneOpacity(frame,frames));
    assert.equal(opacity[0],1);assert.equal(opacity.at(-1),0);
    assert.ok(opacity.every((value,index)=>value>=0 && value<=1 && (!index || value<=opacity[index-1])));
    assert.ok(opacity.slice(1,-1).some(value=>value>0 && value<1),'a real two-scene blend must occur');
  }
});

test('shotcraft handoffs honor a deliberate hard cut after the tension camera',()=>{
  const prior={startFrame:0,frames:150,imagePath:'a.png',shotcraft:{recipe:'slow-push-in'}};
  const next={startFrame:150,frames:150,imagePath:'b.png',shotcraft:{transition:'cut'}};
  assert.equal(shotTransitionFrames(prior,next,30),0);
});

test('companion explanations have distinct readable layouts and retain every fact across pages',()=>{
  for(const [width,height]of [[1920,1080],[1080,1920]]) {
    for(const kind of ['timeline','relationship','comparison','quote']) {
      const graphic={kind,title:'说明标题',items:Array.from({length:6},(_,i)=>({label:`第${i+1}项内容`,detail:`第${i+1}项原始细节`,value:`${i+1}`}))};
      const layout=companionGraphicLayout(kind,width,height);
      assert.ok(layout.y+layout.height<=height*.78,'explanations stay out of the caption area');
      assert.ok(layout.width<width*.92,'footage remains visible');
      const markup=Array.from({length:6},(_,page)=>renderToStaticMarkup(React.createElement(CompanionGraphic,
        {graphic,frame:page*90+75,frames:540,width,height})));
      for(const item of graphic.items)assert.ok(markup.some(html=>html.includes(item.label)&&html.includes(item.detail)));
      assert.ok(markup.every(html=>html.includes(`data-explanation="${kind}"`)));
    }
  }
  const state=companionReveal(21,150,1,3);
  assert.ok(state.connector>state.enter,'a relationship line must lead its node');
  assert.deepEqual(companionReveal(120,150,2,3),companionReveal(145,150,2,3),'finished information holds still');
});
