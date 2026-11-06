import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {fileSha256,renderHistoryMotion} from './render.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const ffmpeg=args=>execFileSync('ffmpeg',['-v','error','-n',...args],{timeout:60_000,maxBuffer:32*1024*1024});
const json=(filename,value)=>fs.writeFileSync(filename,JSON.stringify(value,null,2)+'\n');

function pixels(movie,seconds) {
  return ffmpeg(['-ss',String(seconds),'-i',movie,'-frames:v','1','-vf','scale=320:-2','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
}

function difference(a,b) {
  assert.equal(a.length,b.length);
  return a.reduce((sum,value,index)=>sum+Math.abs(value-b[index]),0)/a.length;
}

function routePixels(frame) {
  let count=0;
  for(let i=0;i<frame.length;i+=3) {
    if(frame[i]>170&&frame[i+1]<115&&frame[i+2]>45&&frame[i+2]<145) count++;
  }
  return count;
}

function amplitude(audio,frequency,start,duration) {
  const first=Math.round(start*48000),count=Math.round(duration*48000);
  let sine=0,cosine=0;
  for(let i=0;i<count;i++) {
    const sample=audio.readFloatLE((first+i)*4),phase=2*Math.PI*frequency*i/48000;
    sine+=sample*Math.sin(phase);cosine+=sample*Math.cos(phase);
  }
  return 2*Math.hypot(sine,cosine)/count;
}

test('JPEG capture delivers limited-range H.264 with an overlay over media',{
  skip:process.env.HISTORY_MOTION_RENDER_SMOKE!=='1',timeout:120_000,
},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-jpeg-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const image=path.join(dir,'scene.png'),audio=path.join(dir,'audio.m4a'),planFile=path.join(dir,'plan.json'),output=path.join(dir,'movie.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=640x360:r=30','-frames:v','1',image]);
  ffmpeg(['-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','1','-c:a','aac',audio]);
  json(planFile,{width:1920,height:1080,fps:30,durationInFrames:30,audioPath:audio,uniqueSceneAssets:true,companionGraphicsOnly:true,
    shots:[{shotId:'one',startFrame:0,frames:30,visualType:'image',imagePath:image,narration:'编码核验。',graphic:{kind:'quote',title:'解释层',items:[{label:'保留底层画面'}]}}]});
  const report=await renderHistoryMotion({plan:planFile,output,concurrency:1});
  const metadata=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
  const video=metadata.streams.find(s=>s.codec_type==='video');
  assert.equal(video.codec_name,'h264');assert.match(video.tags.encoder,/h264_videotoolbox/);
  assert.equal(video.pix_fmt,'yuv420p');assert.equal(video.color_range,'tv');
  assert.equal(video.color_space,'bt709');assert.equal(Number(video.nb_frames),30);
  assert.equal(report.graphics.length,1);assert.equal(report.visuals[0].visualType,'image');
  assert.equal(metadata.streams.filter(s=>s.codec_type==='audio'&&s.codec_name==='aac').length,1);
  assert.equal(report.uploadEncoding.encoder,'h264_videotoolbox');assert.equal(report.uploadEncoding.status,'within-budget');
  assert.equal(report.encoding.hardwareAcceleration,'required');
  for(const key of ['assetFreezeMs','bundleMs','compositionMs','renderMediaMs','frameRenderingMs','encodingAndMuxingMs','finalizeMs','totalMs']) {
    assert.ok(Number.isFinite(report.performance[key])&&report.performance[key]>=0,`Missing timing ${key}`);
  }
  assert.match(report.performance.timingNotes,/overlap/);
  const frame=pixels(output,.5);
  assert.ok(frame.reduce((max,value)=>Math.max(max,value),0)-frame.reduce((min,value)=>Math.min(min,value),255)>50,
    'decoded frame must contain picture content');
  const decoded=ffmpeg(['-i',output,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);
  assert.ok(amplitude(decoded,330,.2,.5)>.02,'rendered audio must retain the narration tone');
  t.diagnostic(JSON.stringify({encoder:report.uploadEncoding.encoder,bytes:report.bytes,performance:report.performance}));
});

test('real landscape and portrait MP4s contain image motion, four graphics, animated map routes and mixed SFX',{
  skip:process.env.HISTORY_MOTION_RENDER_SMOKE!=='1',timeout:300_000,
},async t=>{
  const parent=process.env.HISTORY_MOTION_SAMPLE_DIR ? path.resolve(process.env.HISTORY_MOTION_SAMPLE_DIR) : os.tmpdir();
  fs.mkdirSync(parent,{recursive:true});
  const dir=fs.mkdtempSync(path.join(parent,'history-motion-renderer-'));
  t.diagnostic(`Sample artifacts: ${dir}`);
  if(!process.env.HISTORY_MOTION_SAMPLE_DIR) t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'footage.mp4'),audio=path.join(dir,'narration-tone.m4a'),effect=path.join(dir,'effect-tone.wav');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=640x360:r=30','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p',source]);
  ffmpeg(['-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','14','-c:a','aac',audio]);
  ffmpeg(['-f','lavfi','-i','sine=frequency=900:sample_rate=48000','-t','1','-c:a','pcm_s16le',effect]);
  const existing=path.join(root,'remotion/public/changping-demo-v2/terrain.png');
  let image=existing,mapWidth=3840,mapHeight=1504;
  if(!fs.existsSync(image)) {
    image=path.join(dir,'image.png');mapWidth=640;mapHeight=360;
    ffmpeg(['-f','lavfi','-i','testsrc2=s=640x360:r=30','-frames:v','1',image]);
  }
  const libraryEffect='/Users/zhangshijie/Downloads/2174款剪映音效库/12 环境音/快速翻页翻书.wav';
  const sfx=[{sourcePath:effect,sourceName:'Diagnostic 900 Hz cue',sha256:await fileSha256(effect),startFrame:30,frames:24,volume:.14}];
  if(fs.existsSync(libraryEffect)) sfx.push({sourcePath:libraryEffect,sourceName:path.basename(libraryEffect),startFrame:90,frames:24,volume:.1});
  const graphic=(kind,title,items)=>({kind,title,items});
  for(const [name,width,height] of [['landscape',1920,1080],['portrait',1080,1920]]) {
    const shots=[
      {imagePath:image,imageSha256:await fileSha256(image),narration:'秦赵交兵，先看地形。',motion:{kind:'kenburns',keyframes:[
        {t:0,focusX:.5,focusY:.5,zoom:1},{t:1,focusX:.65,focusY:.45,zoom:1.16},
      ]}},
      {graphic:graphic('timeline','战局推进',[{value:'一',label:'对峙',detail:'建立全局'},{value:'二',label:'转折',detail:'改变方向'},{value:'三',label:'合击',detail:'揭示结果'}]),narration:'先对峙，再转折，最后合击。'},
      {graphic:graphic('comparison','部署对比',[{label:'正面部队',value:'牵制',detail:'保持接触'},{label:'侧翼部队',value:'迂回',detail:'接近退路'}]),narration:'正面牵制，侧翼迂回。'},
      {graphic:graphic('relationship','行动与结果',[{label:'控制关口',detail:'改变通行条件'},{label:'限制补给',detail:'影响持续作战'},{label:'迫使调整',detail:'战局随之改变'}]),narration:'关口影响补给，补给影响战局。'},
      {graphic:graphic('quote','理解战局',[{label:'先看位置，再看行动',detail:'地图解释空间，画面呈现过程。'}]),narration:'先看位置，再看行动。'},
      {map:{enabled:true,backgroundSrc:image,width:mapWidth,height:mapHeight,title:'路线动画测试',
        provenance:{verified:true,source:fs.existsSync(existing)?'https://registry.opendata.aws/terrain-tiles/':'Generated renderer fixture',
          license:fs.existsSync(existing)?'Mapzen terrain / USGS SRTM & GMTED2010':'Test fixture',projection:'Equirectangular raster canvas',
          historyStatus:'illustrative',attribution:'渲染测试路线，不代表历史行军记录'},
        cities:[{name:'出发点',x:.16,y:.57,color:'#2675a6'},{name:'抵达点',x:.82,y:.42,color:'#2675a6'}],
        routes:[{name:'示意行进',points:[[.16,.57],[.38,.32],[.6,.54],[.82,.42]],color:'#ed3f57',start:.2,end:1.6}],
      },narration:'路线逐步展开，标记沿线移动。'},
      {sourcePath:source,inPoint:0,outPoint:1,shortfallPolicy:'freeze',narration:'保留原视频与末帧定格兼容。'},
    ].map((shot,index)=>({...shot,visualType:shot.map?'map':shot.imagePath?'image':shot.sourcePath?'video':'graphic',
      shotId:`${name}-${index+1}`,startFrame:index*60,frames:60,sourceNote:'渲染器样片 · 合成测试音轨'}));
    shots[0].graphic={kind:'quote',title:'地形参照',items:[{label:'解释与画面同时呈现'}]};
    const plan={width,height,fps:30,durationInFrames:420,audioPath:audio,shots,soundEffects:sfx};
    const planFile=path.join(dir,`${name}-plan.json`),output=path.join(dir,`${name}.mp4`);
    json(planFile,plan);
    const report=await renderHistoryMotion({plan:planFile,output,concurrency:2});
    assert.equal(report.status,'completed');assert.equal(report.qa.technical,'passed');
    assert.equal(report.qa.visual,'not-reviewed');assert.equal(report.qa.listening,'not-reviewed');
    assert.equal(report.qa.humanReviewRequired,false);
    assert.equal(report.images.length,1);assert.equal(report.graphics.length,5);assert.equal(report.soundEffects.length,sfx.length);
    assert.equal(report.maps.length,1);assert.equal(report.frozenTails.length,1);
    assert.equal(report.audioPolicy.narrationGain,1);
    assert.deepEqual(report.visuals.map(v=>v.visualType),['image','graphic','graphic','graphic','graphic','map','video']);
    assert.deepEqual(report.soundEffects.map(s=>s.sourceName),sfx.map(s=>s.sourceName));
    assert.deepEqual(report.graphics.map(g=>g.kind),['quote','timeline','comparison','relationship','quote']);
    assert.ok(report.soundEffects.every(s=>/^[a-f\d]{64}$/.test(s.sha256)&&fs.existsSync(s.source)));
    assert.equal(fs.existsSync(output+'.lock'),false);
    const imageMotion=difference(pixels(output,.3),pixels(output,1.7));
    assert.ok(imageMotion>.8,`static image must visibly move (${imageMotion})`);
    const graphicMotion=difference(pixels(output,2.05),pixels(output,3.7));
    assert.ok(graphicMotion>1,`graphic information must visibly enter (${graphicMotion})`);
    const early=routePixels(pixels(output,10.5)),late=routePixels(pixels(output,11.7));
    assert.ok(late>early*1.2,`map route must grow: ${early} -> ${late}`);
    const decoded=ffmpeg(['-i',output,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);
    const before=amplitude(decoded,900,.3,.2),during=amplitude(decoded,900,1.2,.2),after=amplitude(decoded,900,2.1,.2);
    assert.ok(during>.004&&during>Math.max(before,after)*5,`SFX must only appear at the scheduled time (${before}, ${during}, ${after})`);
    assert.ok(amplitude(decoded,330,1.2,.2)>during*3,'narration remains dominant');
    json(path.join(dir,`${name}-evidence.json`),{output,imageMotion,graphicMotion,routePixels:{early,late},
      audio:{sfxBefore:before,sfxDuring:during,sfxAfter:after},technical:'passed',humanReview:'not-performed'});
    t.diagnostic(`${name}: ${output}`);
  }
});
