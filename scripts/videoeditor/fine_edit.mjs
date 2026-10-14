import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readAssCues} from './semantic_overlay.mjs';
import {resolveUploadEncoding,uploadVideoArgs,uploadEncodingReport} from './upload_encoding.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const req=createRequire(path.join(root,'remotion/package.json'));
const sharp=createRequire(path.join(root,'backend/package.json'))('sharp');
const exec=promisify(execFile);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
const local=p=>path.isAbsolute(p)?p:path.join(root,'data',p);
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const norm=s=>String(s).normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
const fps=30,W=1920,H=1080;
export function captionLines(text){
  const tokens=String(text).replace(/\s+/g,' ').trim().match(/\d+(?:\.\d+)?(?:\s*(?:万|亿|余|多))?\s*(?:年|月|日|天|岁|两|家|顷|石|间)?|[A-Za-z]+|./gu)||[];
  const lines=[];let line='';
  for(const token of tokens){if(Array.from(line+token).length>23&&line){if(/^[，。！？；：、）”」】]$/.test(token))line+=token;else{lines.push(line.trim());line=token;}if(Array.from(line).length>23){lines.push(line.trim());line='';}}else line+=token;}
  if(line.trim())lines.push(line.trim());return lines.join('\\N');
}
export function narrationCaptionChunks(text){
  const clauses=String(text).replace(/\s+/g,' ').trim().match(/[^，。！？；：]+[，。！？；：]?/gu)||[];
  const chunks=[];let line='';
  for(const c of clauses){if(Array.from(line+c).length>34&&line){chunks.push(line.trim());line='';}line+=c;if(Array.from(line).length>=25){chunks.push(line.trim());line='';}}
  if(line.trim())chunks.push(line.trim());
  return chunks.flatMap(c=>{if(Array.from(c).length<=44)return [c];return captionLines(c).split('\\N');});
}
function asrTextIndex(asr){let text='',times=[];for(const t of asr){for(const c of norm(t.text)){text+=c;times.push(t.offsets.from/1000);}}return {text,times};}
function alignedCaptionStart(text,expected,near){
  const clean=norm(text);let candidates=[];
  for(let len=Math.min(10,clean.length);len>=4;len--){const q=clean.slice(0,len);let p=near.text.indexOf(q);while(p>=0){if(Math.abs(near.times[p]-expected)<2)candidates.push({time:near.times[p],len});p=near.text.indexOf(q,p+1);}if(candidates.length)break;}
  candidates.sort((a,b)=>Math.abs(a.time-expected)-Math.abs(b.time-expected));return candidates[0]?.time;
}
function rebuildCaptions(shot,asr,dir){
  const parts=narrationCaptionChunks(shot.narration),full=parts.reduce((n,t)=>n+norm(t).length,0),starts=[0],evidence=[];
  const absolute=shot.startFrame/fps;
  const near=asrTextIndex(asr.filter(x=>x.offsets.from/1000>=absolute-.5&&x.offsets.from/1000<absolute+shot.duration+.5));
  let used=norm(parts[0]||'').length;
  for(let i=1;i<parts.length;i++){
    const estimated=shot.duration*used/full,matched=alignedCaptionStart(parts[i],absolute+estimated,near);
    const chosen=Math.min(shot.duration-(parts.length-i)*.6,Math.max(starts.at(-1)+.6,matched===undefined?estimated:matched-absolute));
    starts.push(chosen);evidence.push({text:parts[i],start:chosen,method:matched===undefined?'intra-shot text-weight fallback':'ASR clause-prefix match'});used+=norm(parts[i]).length;
  }
  const time=t=>{const cs=Math.round(t*100);return `${Math.floor(cs/360000)}:${String(Math.floor(cs/6000)%60).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;};
  const file=path.join(dir,'captions',`${shot.storyboardNumber}.ass`);fs.mkdirSync(path.dirname(file),{recursive:true});
  const head=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,PingFang SC,48,&H00FFFFFF,&H00FFFFFF,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,2.5,0,2,140,140,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  fs.writeFileSync(file,head+parts.map((p,i)=>`Dialogue: 0,${time(starts[i])},${time(starts[i+1]??shot.frames/fps)},Default,,0,0,0,,${captionLines(p).replace(/[{}]/g,'')}`).join('\n')+'\n');
  return {file,parts,evidence};
}
export function framesForShots(shots,fullDuration){
  let cursor=0,previous=0;
  return shots.map((s,i)=>{cursor+=s.duration;const end=Math.round((i===shots.length-1?fullDuration:cursor)*fps);const n=end-previous;if(n<=0)throw Error('Empty shot');const out={startFrame:previous,frames:n};previous=end;return out;});
}
export function cameraFilter(camera,frames){
  const p=`clip((on/${Math.max(1,frames-1)}-0.15)/0.70,0,1)`;
  const e=`((${p})*(${p})*(3-2*(${p})))`;
  let z='1',x=String(camera.focusX);
  if(camera.mode==='push')z=`1+${camera.amount}*${e}`;
  if(camera.mode==='pull')z=`1+${camera.amount}*(1-${e})`;
  if(camera.mode.startsWith('pan-')){z=String(1+camera.amount);x=`clip(${camera.focusX}+${camera.mode==='pan-right'?1:-1}*(${e}-0.5)*0.30,0,1)`;}
  return `scale=3840:2160:flags=lanczos,format=yuv444p,zoompan=z='${z}':x='(iw-iw/zoom)*(${x})':y='(ih-ih/zoom)*${camera.focusY}':d=${frames}:s=${W}x${H}:fps=${fps}`;
}
async function probe(file){return JSON.parse((await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height,nb_frames,pix_fmt,r_frame_rate:format=duration','-of','json',file])).stdout);}
function effectTime(shot,e,asr){
  const target=norm(e.anchorText||e.trigger);
  const near=asr.filter(t=>t.offsets.to/1000>=shot.startFrame/fps-.7&&t.offsets.from/1000<(shot.startFrame+shot.frames)/fps+.7);
  let joined='',chars=[];
  for(const t of near){for(const c of norm(t.text)){joined+=c;chars.push(t.offsets.from/1000);}}
  const idx=joined.indexOf(target);
  if(idx>=0)return {start:Math.max(.12,chars[idx]-shot.startFrame/fps),method:'ASR exact phrase within shot window',matched:target};
  const cues=readAssCues(fs.readFileSync(local(shot.subtitleUrl),'utf8'));
  const cue=cues.find(c=>norm(c.text).includes(target));
  if(cue){const text=norm(cue.text);return {start:Math.max(.12,cue.start+(cue.end-cue.start)*text.indexOf(target)/Math.max(1,text.length)),method:'ASS cue + intra-cue text estimate; not word alignment',matched:target};}
  const text=norm(shot.narration),pos=text.indexOf(target);
  if(pos<0)throw Error(`No trigger in narration for ${shot.storyboardNumber}: ${target}`);
  return {start:Math.max(.12,shot.duration*pos/Math.max(1,text.length)),method:'narration proportion fallback; inspect before delivery',matched:target};
}
export function safeEffectWindow(start,frames,desired=1.8){
  const begin=Math.max(4,Math.round(start*fps));
  const end=Math.min(frames-2,begin+Math.round(desired*fps));
  if(end-begin<18)throw Error('Insufficient effect reading window');
  return {startFrame:begin,endFrame:end};
}
async function plan(dir,snapshotFile,decisionFiles){
  const snapshot=read(snapshotFile),source=local(snapshot.episode.videoUrl),media=await probe(source);
  const duration=Number(media.format.duration),decisions=decisionFiles.flatMap(read),asr=read(path.join(dir,'asr.json')).transcription;
  if(decisions.length!==snapshot.storyboards.length||new Set(decisions.map(d=>d.storyboardNumber)).size!==decisions.length)throw Error('Need unique per-shot decisions');
  const frames=framesForShots(snapshot.storyboards,duration);
  const shots=snapshot.storyboards.map((s,i)=>{
    const d=decisions.find(x=>x.storyboardNumber===s.storyboardNumber);if(!d?.visualEvidence||!d.rationale)throw Error('Missing visual decision');
    const {camera}=d;
    if(!['hold','push','pull','pan-left','pan-right'].includes(camera.mode)||camera.amount<0||camera.amount>.045)throw Error('Invalid restrained camera');
    const shot={...s,...frames[i],camera,intent:d.intent,visualEvidence:d.visualEvidence,editDecision:d.rationale};
    const effects=d.effects.map((e,j)=>{
      if(!s.narration.includes(e.trigger)||e.trigger.includes('待核'))throw Error('Unsafe trigger');
      const timing=effectTime(shot,e,asr),window=safeEffectWindow(timing.start,shot.frames,e.kind==='emphasis'?Math.min(2.8,1+Array.from(e.text||'').length*.12):1.6);
      return {...e,...window,id:`fine-${s.id}-${j}`,timingEvidence:timing,fontSize:e.fontSize||(e.kind==='emphasis'?78:48)};
    });
    const warnings=[...(d.warnings||[]),...(!s.videoPrompt?['missing shot/video prompt; decisions based on narration and inspected image']:[])];
    const cuts=[0,s.duration*.15,s.duration*.85,s.duration];
    const beats=cuts.slice(0,-1).map((start,j)=>({id:`${s.id}-${j}`,start,end:cuts[j+1],text:s.narration,role:j===1?d.intent:'hold',framing:'full image safe crop',focus:{x:camera.focusX,y:camera.focusY,zoom:1+camera.amount},motion:j===1?camera.mode:'hold',easing:'ease-in-out',transition:'smooth',rationale:j===1?d.rationale:'保持镜头起止取景，给观众读取画面和字幕的时间。',layerMode:'crop',layers:[],fallback:null,warnings:[]}));
    return {...shot,caption:rebuildCaptions(shot,asr,dir),shotId:s.id,sourceEvidence:{narration:s.narration||'',dialogue:s.dialogue||'',videoPrompt:s.videoPrompt||'',movement:s.movement||'',asset:s.firstFrameImage},duration:s.duration,beats,warnings,effects};
  });
  const result={schemaVersion:1,episodeId:snapshot.episode.id,sourcePath:source,sourceFingerprint:hash(source),duration,fps,width:W,height:H,audioPolicy:'copy source audio bit-for-bit; no added BGM/SFX',shots};
  save(path.join(dir,'edit-plan.json'),result);
  save(path.join(dir,'snapshot.json'),snapshot);
  console.log(JSON.stringify({shots:shots.length,frames:shots.reduce((n,s)=>n+s.frames,0),effects:shots.flatMap(s=>s.effects).length,cameras:shots.reduce((m,s)=>(m[s.camera.mode]=(m[s.camera.mode]||0)+1,m),{})}));
}
async function pool(items,limit,fn){let i=0;await Promise.all(Array.from({length:limit},async()=>{while(i<items.length){const item=items[i++];await fn(item);}}));}
function escapedFilter(p){return p.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");}
async function base(plan,dir){
  if(hash(plan.sourcePath)!==plan.sourceFingerprint)throw Error('Source changed');
  const shotsDir=path.join(dir,'shots');fs.mkdirSync(shotsDir,{recursive:true});
  await pool(plan.shots,3,async s=>{
    const out=path.join(shotsDir,`${s.storyboardNumber}.mp4`);
    const subtitle=s.caption?.file||local(s.subtitleUrl);
    const signature=createHash('sha256').update(JSON.stringify({camera:s.camera,frames:s.frames,image:hash(local(s.firstFrameImage)),subtitle:hash(subtitle),filterVersion:1})).digest('hex');
    const stamp=out+'.json';
    if(fs.existsSync(out)&&fs.existsSync(stamp)&&read(stamp).signature===signature)return;
    const vf=cameraFilter(s.camera,s.frames)+`,subtitles='${escapedFilter(subtitle)}',format=yuv420p`;
    const partial=out+'.partial.mp4';
    await exec('ffmpeg',['-v','error','-y','-threads','2','-i',local(s.firstFrameImage),'-vf',vf,'-frames:v',String(s.frames),'-an','-c:v','h264_videotoolbox','-b:v','6500k','-pix_fmt','yuv420p','-movflags','+faststart',partial],{maxBuffer:8e6});
    const meta=await probe(partial);if(Number(meta.streams[0].nb_frames)!==s.frames)throw Error('Frame count mismatch');
    fs.renameSync(partial,out);save(stamp,{signature,frames:s.frames});
    console.log(JSON.stringify({phase:'base',shot:s.storyboardNumber,total:plan.shots.length}));
  });
  const list=path.join(dir,'concat.txt');fs.writeFileSync(list,plan.shots.map(s=>`file '${path.join(shotsDir,`${s.storyboardNumber}.mp4`)}'`).join('\n'));
  await exec('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-i',plan.sourcePath,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',path.join(dir,'base.mp4')],{maxBuffer:8e6});
  console.log(JSON.stringify({phase:'base-complete',file:path.join(dir,'base.mp4')}));
}
async function overlays(plan,dir){
  const {bundle}=await import(req.resolve('@remotion/bundler'));
  const {selectComposition,renderMedia,renderStill}=await import(req.resolve('@remotion/renderer'));
  const browserExecutable=path.join(root,'.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  const publicDir=path.join(dir,'public');fs.mkdirSync(path.join(publicDir,'fonts'),{recursive:true});
  fs.copyFileSync(path.join(root,'remotion/public/fonts/LXGWWenKaiScreen.ttf'),path.join(publicDir,'fonts/LXGWWenKaiScreen.ttf'));
  const serveUrl=await bundle({entryPoint:path.join(root,'remotion/src/fine-edit-entry.tsx'),rootDir:path.join(root,'remotion'),publicDir,outDir:path.join(dir,'bundle')});
  const codeHash=createHash('sha256');for(const f of ['FineEditOverlay.tsx','fine-edit-core.ts','fine-edit-entry.tsx','SemanticShotOverlay.tsx','semantic-overlay-core.ts'])codeHash.update(fs.readFileSync(path.join(root,'remotion/src',f)));
  const code=codeHash.digest('hex'),clips=[];
  for(const s of plan.shots.filter(s=>s.effects.length)){
    const offset=Math.min(...s.effects.map(e=>e.startFrame)),end=Math.max(...s.effects.map(e=>e.endFrame));
    const props={width:W,height:H,fps,durationInFrames:end-offset,shotDurationInFrames:s.frames,shotFrameOffset:offset,camera:s.camera,effects:s.effects.map(e=>({...e,startFrame:e.startFrame-offset,endFrame:e.endFrame-offset}))};
    const signature=createHash('sha256').update(JSON.stringify({props,code})).digest('hex').slice(0,12),clip=path.join(dir,`effect-${s.storyboardNumber}-${signature}.mov`);
    const composition=await selectComposition({serveUrl,id:'FineEditOverlay',inputProps:props,browserExecutable});
    if(!fs.existsSync(clip)){await renderMedia({composition,serveUrl,inputProps:props,browserExecutable,outputLocation:clip+'.partial.mov',codec:'prores',proResProfile:'4444',pixelFormat:'yuva444p10le',imageFormat:'png',concurrency:3,muted:true,logLevel:'error'});fs.renameSync(clip+'.partial.mov',clip);}
    const meta=await probe(clip);if(meta.streams[0].nb_frames!=props.durationInFrames||!meta.streams[0].pix_fmt.startsWith('yuva'))throw Error('Invalid overlay');
    const frame=Math.min(props.durationInFrames-1,Math.round(props.durationInFrames*.5));
    const png=path.join(dir,`effect-${s.storyboardNumber}.png`);
    await renderStill({composition,serveUrl,inputProps:props,browserExecutable,frame,output:png,imageFormat:'png',logLevel:'error'});
    clips.push({shot:s.storyboardNumber,clip,globalStart:(s.startFrame+offset)/fps,globalEnd:(s.startFrame+end)/fps,previewTime:(s.startFrame+offset+frame)/fps,alphaPng:png,fingerprint:hash(clip)});
    console.log(JSON.stringify({phase:'overlay',shot:s.storyboardNumber,frames:props.durationInFrames}));
  }
  save(path.join(dir,'overlays.json'),{planFingerprint:hash(path.join(dir,'edit-plan.json')),clips});
}
async function compose(plan,dir,output){
  if(path.resolve(output)===plan.sourcePath||fs.existsSync(output))throw Error('Refuse to overwrite an existing video');
  const encoding=resolveUploadEncoding(plan.uploadEncoding);
  const manifest=read(path.join(dir,'overlays.json'));if(manifest.planFingerprint!==hash(path.join(dir,'edit-plan.json')))throw Error('Stale overlays');
  const args=['-v','error','-y','-filter_complex_threads','2','-i',path.join(dir,'base.mp4')],filters=[];
  let current='0:v';
  for(const [i,c] of manifest.clips.entries()){
    if(hash(c.clip)!==c.fingerprint)throw Error('Overlay changed');args.push('-i',c.clip);
    filters.push(`[${i+1}:v]setpts=PTS-STARTPTS+${c.globalStart}/TB[e${i}]`);
    filters.push(`[${current}][e${i}]overlay=0:0:format=auto:eof_action=pass:repeatlast=0:enable='gte(t,${c.globalStart})*lt(t,${c.globalEnd})'[v${i}]`);current=`v${i}`;
  }
  args.push('-filter_complex',filters.join(';'),'-map',`[${current}]`,'-map','0:a:0',...uploadVideoArgs(encoding),'-c:a','copy','-movflags','+faststart',output+'.partial.mp4');
  await exec('ffmpeg',args,{maxBuffer:8e6});
  const audioHash=async p=>(await exec('ffmpeg',['-v','error','-i',p,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
  const [before,after,media]=await Promise.all([audioHash(plan.sourcePath),audioHash(output+'.partial.mp4'),probe(output+'.partial.mp4')]);
  if(before!==after)throw Error('Audio changed');
  if(Math.abs(Number(media.format.duration)-plan.duration)>.04)throw Error('Duration changed');
  const expectedFrames=plan.shots.reduce((sum,s)=>sum+s.frames,0);
  if(Number(media.streams.find(s=>s.codec_type==='video').nb_frames)!==expectedFrames)throw Error('Final frame count mismatch');
  const uploadEncoding=uploadEncodingReport(media,fs.statSync(output+'.partial.mp4').size,encoding);
  save(path.join(dir,'upload-encoding-report.json'),uploadEncoding);
  if(uploadEncoding.status!=='within-budget')throw Error('Final composition exceeds upload filesize budget; review quality/settings in a new revision');
  fs.renameSync(output+'.partial.mp4',output);
  const report={status:'rendered-awaiting-visual-review',episodeId:plan.episodeId,output,url:`http://127.0.0.1:3013/${path.relative(path.join(root,'data'),output)}`,duration:Number(media.format.duration),frames:expectedFrames,audioHash:after,outputFingerprint:hash(output),shots:plan.shots.length,effectShots:manifest.clips.length,sourceFingerprint:plan.sourceFingerprint,uploadEncoding};
  save(path.join(dir,'delivery.json'),report);console.log(JSON.stringify(report));
}
async function previews(plan,dir){
  const {clips}=read(path.join(dir,'overlays.json'));let tiles=[];
  for(const [i,c] of clips.entries()){
    const original=path.join(dir,`preview-base-${c.shot}.png`),out=path.join(dir,`preview-${c.shot}.png`);
    await exec('ffmpeg',['-v','error','-y','-ss',String(c.previewTime),'-i',path.join(dir,'base.mp4'),'-frames:v','1',original]);
    await sharp(original).composite([{input:c.alphaPng}]).png().toFile(out);
    tiles.push({input:await sharp(out).resize(640,360).png().toBuffer(),left:(i%3)*640,top:Math.floor(i/3)*385});
    tiles.push({input:Buffer.from(`<svg width="640" height="25"><rect width="640" height="25" fill="white"/><text x="10" y="19" font-size="18">Shot ${c.shot} / ${c.previewTime.toFixed(2)}s</text></svg>`),left:i%3*640,top:Math.floor(i/3)*385+360});
  }
  await sharp({create:{width:1920,height:Math.ceil(clips.length/3)*385,channels:3,background:'white'}}).composite(tiles).jpeg({quality:90}).toFile(path.join(dir,'effect-contact.jpg'));
}
async function main(){const [command,dirArg,...args]=process.argv.slice(2),dir=path.resolve(dirArg);fs.mkdirSync(dir,{recursive:true});if(command==='plan')return plan(dir,args[0],args.slice(1));const p=read(path.join(dir,'edit-plan.json'));if(command==='base')return base(p,dir);if(command==='overlays')return overlays(p,dir);if(command==='previews')return previews(p,dir);if(command==='compose')return compose(p,dir,path.resolve(args[0]));throw Error('Unknown command');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1});
