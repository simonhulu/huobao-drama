#!/usr/bin/env node
// Research bridge: renders the upstream DOM itself, with frame-driven local overlays.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {once} from 'node:events';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req=createRequire(path.join(root,'backend/package.json'));
const args=process.argv.slice(2);
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const source=path.resolve(option('--source','/tmp/jiangshan-map-study-20261101'));
const variant=option('--variant','pilot');
if(!['pilot','refined'].includes(variant))throw Error(`Unknown variant: ${variant}`);
const refined=variant==='refined';
const output=path.resolve(option('--output',path.join(root,refined?'outputs/jiangshan-map-refined-20261102/render-v1':'outputs/jiangshan-map-study-20261101/native')));
const assetDirectory=path.resolve(option('--assets',path.join(root,'outputs/jiangshan-map-refined-20261102/assets')));
const assetNames=refined?{guoPortrait:'portrait-guo.png',liPortrait:'portrait-li.png',cavalry:'cavalry.png',infantry:'infantry.png'}:{};
for(const filename of Object.values(assetNames))await fs.access(path.join(assetDirectory,filename));
const preview=args.includes('--preview');
const width=1920,height=1080,fps=30,duration=refined?18:12,frames=duration*fps,year=refined?757:741;
const upstreamCommit='a81c0d0205e4e658d325ae4fbeb2ddd1c2cc549a';
const actualCommit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(actualCommit!==upstreamCommit) throw Error(`Unreviewed upstream revision: ${actualCommit}`);
const movie=path.join(output,refined?'jiangshan-refined-map-demo.mp4':'jiangshan-native-map-pilot.mp4');
try {await fs.access(movie);throw Error(`Refusing to replace ${movie}; select a new --output.`);} catch(e) {if(e.code!=='ENOENT')throw e;}
await fs.mkdir(output,{recursive:true});
const bundle=path.join(output,'native-overlay.js');
execFileSync(process.execPath,[path.join(root,'scripts/jiangshan-map-pilot/build-overlay.mjs'),'--output',bundle,'--variant',variant],{stdio:'inherit'});
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const save=(name,value)=>fs.writeFile(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://127.0.0.1');
  const assetName=url.pathname.startsWith('/__assets/')?url.pathname.slice('/__assets/'.length):null;
  const assetPath=assetName&&Object.values(assetNames).includes(assetName)?path.join(assetDirectory,assetName):null;
  const target=url.pathname==='/__overlay.js'?bundle:assetPath||path.resolve(source,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(target!==bundle&&target!==assetPath&&!target.startsWith(source+path.sep)){response.writeHead(403).end();return;}
  const body=await fs.readFile(target);
  response.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);
 }catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const puppeteer=req('puppeteer-core');
let browser,encoder;
const blocked=new Set(),errors=[],localFailures=[];
try{
 browser=await puppeteer.launch({executablePath:path.join(root,'.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell'),headless:true,args:['--disable-background-networking']});
 const page=await browser.newPage();
 await page.setViewport({width,height,deviceScaleFactor:1});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.url().startsWith(origin)&&r.status()>=400)localFailures.push({url:r.url(),status:r.status()});});
 await page.setRequestInterception(true);
 page.on('request',r=>{const u=r.url();if(u.startsWith(origin+'/')||u.startsWith('data:')||u.startsWith('blob:'))r.continue();else{blocked.add(u);r.abort();}});
 await page.goto(`${origin}/?year=${year}`,{waitUntil:'networkidle0'});
 await page.waitForFunction(()=>window.atlasApp?._fullSnapshotsLoaded&&window.atlasAPI);
 await page.addStyleTag({content:`
 html,body,#atlas-shell,#workspace-body,#viewport-frame,#svg-stage-wrap { margin:0!important;padding:0!important;border:0!important;border-radius:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;min-height:0!important;overflow:hidden!important; }
 #atlas-shell,#workspace-body,#viewport-frame,#svg-stage-wrap {display:block!important;position:absolute!important;inset:0!important;}
 #atlas-svg {position:absolute!important;inset:0!important;width:100%!important;height:100%!important;}
 #atlas-shell > :not(#workspace-body), #workspace-body > :not(#viewport-frame), #viewport-frame > :not(#svg-stage-wrap), body > :not(#atlas-shell):not(#jiangshan-video-overlay) {display:none!important;}
 #grp-milestones,#grp-genealogy,#grp-journey,#grp-ghost-diff,#grp-challenge {display:none!important;}
 *,*::before,*::after {animation:none!important;transition:none!important;caret-color:transparent!important;}
 #jiangshan-video-overlay {position:fixed;inset:0;z-index:100;pointer-events:none;}
 `});
 await page.evaluate(async({year,assets})=>{
  await document.fonts.ready;
  await Promise.all(Object.values(assets).map(async src=>{const asset=new Image();asset.src=src;await asset.decode();}));
  const image=new Image();image.src=document.querySelector('#terrain-relief-img').getAttribute('href');await image.decode();
  const a=window.atlasApp;
  a.stopAutoplay();clearInterval(a.personTimer);clearTimeout(a.ghostTimer);clearTimeout(a._gestureGuideTimer);
  if(a.flyRaf)cancelAnimationFrame(a.flyRaf);a.flyRaf=null;
  a.activeMilestone=null;a.activeTrace=null;
  a._dismissTraceOnboarding();
  a.grpMilestones.classList.add('is-hidden');
  a.jumpToYear(year);
  const overlay=document.createElement('div');overlay.id='jiangshan-video-overlay';document.body.append(overlay);
 },{year,assets:Object.fromEntries(Object.entries(assetNames).map(([key,file])=>[key,origin+'/__assets/'+file]))});
 await page.addScriptTag({url:origin+'/__overlay.js'});
 const setup=await page.evaluate(({width,height,fps,frames,year,refined,assets})=>{
  const a=window.atlasApp;
  const cities=(refined?['长安','洛阳','商州']:['长安','洛阳']).map(name=>{
   // Use the year's native settlement records, preserving their exact map anchors.
   const matches=a.dynasties[a.dynastyIdx].settlements.filter(p=>(p.ancient===name||p.aliases?.includes(name))
    &&(p.appear===undefined||year>=p.appear)&&(p.vanish===undefined||year<p.vanish));
   const s=matches.length===1?matches[0]:null;
   if(!s)throw Error(`Native settlement missing: ${name}`);
   return {name,coord:s.coord,remark:s.remark};
  });
  const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
  let layout;
  const snapshot=frame=>{
   if(!Number.isInteger(frame)||frame<0||frame>=frames)throw Error('Frame out of range');
   const seconds=frame/fps,move=smooth((seconds-(refined?2.5:1.8))/(refined?7:5));
   const center=a.projector.toScreen(refined?110.3+move*.35:110.1+move*.65,refined?34.45-move*.05:34.25+move*.15);
   const startWidth=a.projector.toScreen(refined?116.5:120,34)[0]-a.projector.toScreen(refined?103.5:100,34)[0];
   const w=startWidth*(1-move*(refined?.1:.27)),h=w*height/width;
   a.camera={x:center[0]-w/2,y:center[1]-h/2,w,h,zoom:1000/w};
   // Force native label placement to finish before capturing this frame.
   a._typoDirty=true;a._applyCamera(true);
   const matrix=a.svg.getScreenCTM();
   const projected=cities.map(c=>{const [x,y]=a.projector.toScreen(...c.coord);const p=new DOMPoint(x,y).matrixTransform(matrix);return {...c,x:p.x,y:p.y};});
   const labelObstacles=[...a.svg.querySelectorAll('text')].flatMap(node=>{
    const style=getComputedStyle(node),r=node.getBoundingClientRect();
    if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0||!r.width||!r.height
      ||r.right<0||r.bottom<0||r.left>width||r.top>height)return [];
    return [{x:r.x-6,y:r.y-6,width:r.width+12,height:r.height+12}];
   });
   return {frame,fps,width,height,cities:projected,labelObstacles,assets,layout};
  };
  window.jiangshanVideo={prepare(){
   if(!refined)return null;
   const inputs=[];
   for(let frame=0;frame<frames;frame++)inputs.push(snapshot(frame));
   layout=window.prepareJiangshanRefinedLayout(inputs);
   return layout;
  },seek(frame){
   const input=snapshot(frame),renderOverlay=refined?window.renderJiangshanRefined:window.renderJiangshanOverlay;
   const state=renderOverlay(input);
   return {frame,seconds:frame/fps,camera:{...a.camera},viewBox:a.svg.getAttribute('viewBox'),cities:input.cities,overlay:state};
  }};
  return {cities,projection:'Upstream MercatorProjector -> native SVG getScreenCTM -> screen overlay',bounds:a.projector.bounds,api:Object.keys(window.atlasAPI),terrainHref:document.querySelector('#terrain-relief-img').getAttribute('href')};
 },{width,height,fps,frames,year,refined,assets:Object.fromEntries(Object.entries(assetNames).map(([key,file])=>[key,origin+'/__assets/'+file]))});
 setup.layout=await page.evaluate(()=>window.jiangshanVideo.prepare());
 const seek=frame=>page.evaluate(frame=>window.jiangshanVideo.seek(frame),frame);
 if(args.includes('--audit-motion')){
  const motion=[];
  for(let frame=0;frame<frames;frame++)motion.push(await seek(frame));
  await save('motion-audit.json',motion);
 }
 const checkpoints=refined?[30,150,240,330,390,480]:[0,120,210,270,330];
 const states=[],routeVisibility=[];
 for(const frame of checkpoints){
  const state=await seek(frame);states.push(state);
  const png=await page.screenshot({path:path.join(output,`frame-${String(frame).padStart(3,'0')}.png`)});
  if(refined){
   // Inspect actual composited pixels: correct path geometry alone misses masks and covering cards.
   const samples=await page.evaluate(({progress,cities})=>[...document.querySelectorAll('[data-route-centerline]')].flatMap(node=>{
    const route=Number(node.getAttribute('data-route-centerline')),points=[];
    for(let distance=30;distance<node.getTotalLength()*progress-12;distance+=4){
     const {x,y}=node.getPointAtLength(distance);
     if(cities.every(city=>Math.hypot(x-city.x,y-city.y)>27))points.push({route,x,y});
    }
    return points;
   }),{progress:state.overlay.routeProgress,cities:state.cities});
   const {data,info}=await req('sharp')(png).removeAlpha().raw().toBuffer({resolveWithObject:true});
   const hidden=samples.filter(point=>{
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
     const x=Math.round(point.x)+dx,y=Math.round(point.y)+dy;
     if(x<0||y<0||x>=info.width||y>=info.height)continue;
     const offset=(y*info.width+x)*info.channels,r=data[offset],g=data[offset+1],b=data[offset+2];
     if(point.route===0?r>g*1.25&&r>b*1.35:b>r*1.10&&g>r*1.05&&b>60)return false;
    }
    return true;
   });
   routeVisibility.push({frame,sampleCount:samples.length,hiddenCount:hidden.length,hidden,samples});
  }
 }
 if(refined){
  await save('route-visibility.json',routeVisibility);
  if(routeVisibility.some(check=>check.hiddenCount))throw Error('A route is obscured in the rendered pixels; see route-visibility.json');
 }
 // Random seeking must produce identical pixels, not depend on real-time playback.
 await seek(165);const first=await page.screenshot();
 await seek(330);await seek(165);const repeated=await page.screenshot();
 const deterministic={frames:[165,330,165],firstSha256:hash(first),repeatedSha256:hash(repeated),passed:hash(first)===hash(repeated)};
 if(!deterministic.passed)throw Error('Native frame seek is history-dependent');
 await save('native-preview-evidence.json',{upstreamCommit,setup,states,deterministic,blockedExternalRequests:[...blocked],pageErrors:errors,localFailures});
 if(errors.length||localFailures.length)throw Error(`Browser failed: ${JSON.stringify({errors,localFailures})}`);
 console.log(JSON.stringify({preview:true,deterministic:deterministic.passed,output,states:states.map(s=>({frame:s.frame,phase:s.overlay.phase,cities:s.cities.map(c=>({name:c.name,x:c.x,y:c.y}))}))}));
 if(!preview){
  const dry=path.join(output,'native-silent.mp4');
  encoder=spawn('ffmpeg',['-v','error','-n','-f','image2pipe','-vcodec','mjpeg','-framerate',String(fps),'-i','pipe:0','-an',
   '-vf','scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
   '-c:v','h264_videotoolbox','-b:v','8M','-pix_fmt','yuv420p','-color_range','tv',
   '-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709','-movflags','+faststart',dry],{stdio:['pipe','ignore','pipe']});
  let encoderError='';encoder.stderr.on('data',d=>encoderError+=d);
  const closed=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(Error(encoderError||`ffmpeg exited ${code}`)));});
  // Attach rejection handler while rendering so pipe errors cannot become unhandled.
  closed.catch(()=>{});encoder.stdin.on('error',()=>{});
  const started=Date.now();
  for(let frame=0;frame<frames;frame++){
   await seek(frame);const jpeg=await page.screenshot({type:'jpeg',quality:95});
   if(!encoder.stdin.write(jpeg))await Promise.race([once(encoder.stdin,'drain'),closed.then(()=>{throw Error('Encoder ended early');})]);
   if(frame%60===0)console.log(`Native map frame ${frame}/${frames}`);
  }
  encoder.stdin.end();await closed;encoder=null;
  const renderSeconds=(Date.now()-started)/1000;
  const cues=refined?[{start:.25,end:2.3,text:'双路合击，先看将领与部署。'},{start:2.7,end:6.6,text:'郭子仪领骑兵推进，李光弼率步军迂回。'},{start:8.8,end:11.8,text:'两路压向城下，逐步收紧包围。'},{start:14.1,end:17.7,text:'占领完成，将领与驻军继续留守。'}]:[{start:.2,end:1.9,text:'原生地图与地名。'},{start:2.1,end:5.7,text:'演示军从长安行进。'},{start:6.1,end:7.9,text:'抵达洛阳，发起进攻。'},{start:10.1,end:11.9,text:'占领完成，驻军留守。'}];
  const probe=file=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'}));
  for(const [i,cue]of cues.entries()){
   cue.file=path.join(output,`voice-${i}.aiff`);
   execFileSync('say',['-v','Tingting','-r','240','-o',cue.file,cue.text]);
   cue.sourceDuration=Number(probe(cue.file).format.duration);
   cue.speed=Math.max(1,cue.sourceDuration/(cue.end-cue.start));
  }
  const filters=cues.map((c,i)=>`[${i+1}:a]atempo=${c.speed.toFixed(6)},adelay=${Math.round(c.start*1000)}:all=1[a${i}]`);
  filters.push(`${cues.map((_,i)=>`[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,apad,atrim=duration=${duration},alimiter=limit=0.9:level=false[mix]`);
  execFileSync('ffmpeg',['-v','error','-n','-i',dry,...cues.flatMap(c=>['-i',c.file]),'-filter_complex',filters.join(';'),'-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-ar','48000','-b:a','128k','-movflags','+faststart',movie]);
  const media=probe(movie),video=media.streams.find(s=>s.codec_type==='video');
  if(video.width!==width||video.height!==height||video.r_frame_rate!=='30/1'||Number(video.nb_frames)!==frames||!media.streams.some(s=>s.codec_type==='audio'))throw Error('Media contract failed');
  const sourceFiles=['index.html','css/style.css','js/app.js','js/map_data.js','js/atlas_snapshots.js','assets/terrain_relief.webp'];
  const assetHashes=Object.fromEntries(await Promise.all(Object.values(assetNames).map(async file=>[file,hash(await fs.readFile(path.join(assetDirectory,file)))])));
  const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,hash(await fs.readFile(path.join(source,file)))])));
  await save('delivery.json',{status:'internal-research-preview',movie,sha256:hash(await fs.readFile(movie)),variant,year,upstreamCommit,sourceHashes,assetHashes,renderSeconds,width,height,fps,frames,duration:media.format.duration,setup,states,deterministic,cues,licenseStatus:'Upstream GPL-3.0 with CHGIS/Hartwell noncommercial exceptions; per-layer provenance unresolved. Not approved for commercial publication.',historicalStatus:`Fictional action demonstration on the year ${year} native map; ${refined?'commander portraits are generated illustrations; curved routes and convergence are schematic':'route is a schematic straight connection'}, not a reconstructed road or attested battle.`,nativeLayers:'Original upstream terrain, boundaries, rivers, corridors, settlement symbols, labels and label placement',audio:'Local macOS Tingting temporary demo narration; no production voice',blockedExternalRequests:[...blocked],pageErrors:errors,localFailures,limitations:['Prototype calls private upstream camera methods; pinned revision required',`Only 1920x1080 and this ${duration}-second demonstration validated`,'No production factory switch; no general event/voice plan importer yet','Native data permissions and historical interpretation need per-use review']});
  console.log(JSON.stringify({movie,renderSeconds,sha256:hash(await fs.readFile(movie)),audio:true}));
 }
}finally{
 if(encoder)encoder.kill('SIGTERM');
 if(browser)await browser.close();
 await new Promise(resolve=>server.close(resolve));
}
