import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readAssCues} from './semantic_overlay.mjs';
import {cameraFilter} from './fine_edit.mjs';
import {resolveUploadEncoding,uploadVideoArgs,uploadEncodingReport} from './upload_encoding.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const req=createRequire(path.join(root,'remotion/package.json'));
const sharp=createRequire(path.join(root,'backend/package.json'))('sharp');
const exec=promisify(execFile),fps=30;
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const hash=p=>{
  const digest=createHash('sha256');
  const fd=fs.openSync(p,'r');
  const buffer=Buffer.allocUnsafe(1024*1024);
  try{
    let bytes=0;
    while((bytes=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,bytes));
  }finally{fs.closeSync(fd);}
  return digest.digest('hex');
};
const local=p=>path.isAbsolute(p)?p:path.join(root,'data',p);
const probe=async p=>JSON.parse((await exec('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,pix_fmt:format=duration','-of','json',p])).stdout);
const codeFingerprint=()=>{
  const code=createHash('sha256');
  for(const f of ['ReferenceEditorialOverlay.tsx','reference-editorial-core.ts','reference-editorial-entry.tsx','fine-edit-core.ts'])code.update(fs.readFileSync(path.join(root,'remotion/src',f)));
  code.update(fs.readFileSync(path.join(root,'remotion/public/fonts/MaShanZheng-Regular.ttf')));
  code.update(fs.readFileSync(path.join(root,'remotion/public/fonts/LXGWWenKaiScreen.ttf')));
  code.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  return code.digest('hex');
};
const escapedFilter=p=>p.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
async function shotBase(s,plan,dir){
  if(!s.page)return path.join(plan.baseDir,'shots',`${s.storyboardNumber}.mp4`);
  const key=createHash('sha256').update(JSON.stringify({image:hash(local(s.firstFrameImage)),camera:s.camera,frames:s.frames,filter:cameraFilter(s.camera,s.frames)})).digest('hex').slice(0,12);
  const file=path.join(dir,`clean-${s.storyboardNumber}-${key}.mp4`);
  if(!fs.existsSync(file))await exec('ffmpeg',['-v','error','-y','-threads','2','-i',local(s.firstFrameImage),'-vf',cameraFilter(s.camera,s.frames)+',format=yuv420p','-frames:v',String(s.frames),'-an','-c:v','h264_videotoolbox','-b:v','6500k',file]);
  return file;
}

export function propsForShot(s) {
  const ranges=[...s.effects,...(s.page?[s.page]:[])];
  if(!ranges.length) return null;
  const offset=Math.min(...ranges.map(e=>e.startFrame));
  const end=Math.max(...ranges.map(e=>e.endFrame));
  const props={width:1920,height:1080,fps,durationInFrames:end-offset,
    shotDurationInFrames:s.frames,shotFrameOffset:offset,camera:s.camera,
    effects:s.effects.map(e=>({...e,startFrame:e.startFrame-offset,endFrame:e.endFrame-offset}))};
  if(s.page){
    props.page={...s.page,imageSrc:`assets/${s.storyboardNumber}${path.extname(s.firstFrameImage)}`,startFrame:s.page.startFrame-offset,endFrame:s.page.endFrame-offset};
    props.captions=readAssCues(fs.readFileSync(s.caption.file,'utf8')).map(c=>({startFrame:Math.max(0,Math.round(c.start*fps)-offset),endFrame:Math.min(end-offset,Math.round(c.end*fps)-offset),text:c.text})).filter(c=>c.endFrame>c.startFrame);
  }
  return props;
}
async function renderer(plan,dir) {
  const publicDir=path.join(dir,'public');fs.mkdirSync(path.join(publicDir,'fonts'),{recursive:true});fs.mkdirSync(path.join(publicDir,'assets'),{recursive:true});
  fs.copyFileSync(path.join(root,'remotion/public/fonts/MaShanZheng-Regular.ttf'),path.join(publicDir,'fonts/MaShanZheng-Regular.ttf'));
  fs.copyFileSync(path.join(root,'remotion/public/fonts/LXGWWenKaiScreen.ttf'),path.join(publicDir,'fonts/LXGWWenKaiScreen.ttf'));
  for(const s of plan.shots.filter(s=>s.page))fs.copyFileSync(local(s.firstFrameImage),path.join(publicDir,'assets',`${s.storyboardNumber}${path.extname(s.firstFrameImage)}`));
  const {bundle}=await import(req.resolve('@remotion/bundler'));
  const api=await import(req.resolve('@remotion/renderer'));
  const browserExecutable=path.join(root,'.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  const serveUrl=await bundle({entryPoint:path.join(root,'remotion/src/reference-editorial-entry.tsx'),rootDir:path.join(root,'remotion'),publicDir,outDir:path.join(dir,'bundle')});
  return {...api,serveUrl,browserExecutable,code:codeFingerprint()};
}
async function stills(plan,dir,only) {
  const r=await renderer(plan,dir),tiles=[],records=[];
  const selected=plan.shots.filter(s=>(s.effects.length||s.page)&&(!only||only.includes(s.storyboardNumber)));
  fs.mkdirSync(path.join(dir,'qa'),{recursive:true});
  for(const s of selected){
    const props=propsForShot(s);if(s.page)props.captions=[];
    const composition=await r.selectComposition({...r,id:'ReferenceEditorialOverlay',inputProps:props});
    const frame=Math.min(props.durationInFrames-7,Math.max(18,Math.floor(props.durationInFrames*.56)));
    const alpha=path.join(dir,`alpha-${s.storyboardNumber}.png`),base=path.join(dir,`base-${s.storyboardNumber}.png`),out=path.join(dir,`preview-${s.storyboardNumber}.png`);
    await r.renderStill({...r,composition,inputProps:props,frame,output:alpha,imageFormat:'png',logLevel:'error'});
    await exec('ffmpeg',['-v','error','-y','-ss',String((props.shotFrameOffset+frame)/fps),'-i',await shotBase(s,plan,dir),'-frames:v','1',base]);
    if(s.page){
      const raw=out+'.raw.png';await sharp(base).composite([{input:alpha}]).png().toFile(raw);
      const t=(props.shotFrameOffset+frame)/fps;
      await exec('ffmpeg',['-v','error','-y','-i',raw,'-vf',`setpts=PTS+${t}/TB,subtitles='${escapedFilter(s.caption.file)}'`,'-frames:v','1',out]);
    }else await sharp(base).composite([{input:alpha}]).png().toFile(out);
    const i=records.length;
    tiles.push({input:await sharp(out).resize(480,270).png().toBuffer(),left:i%4*480,top:Math.floor(i/4)*296});
    tiles.push({input:Buffer.from(`<svg width="480" height="26"><rect width="480" height="26" fill="white"/><text x="8" y="19" font-size="17">Shot ${s.storyboardNumber} / ${((s.startFrame+props.shotFrameOffset+frame)/fps).toFixed(2)}s</text></svg>`),left:i%4*480,top:Math.floor(i/4)*296+270});
    records.push({shot:s.storyboardNumber,frame:props.shotFrameOffset+frame,out});
    console.log(`still ${s.storyboardNumber}`);
  }
  await sharp({create:{width:1920,height:Math.ceil(records.length/4)*296,channels:3,background:'white'}}).composite(tiles).jpeg({quality:92}).toFile(path.join(dir,'qa',only?'sample-contact.jpg':'all-effects.jpg'));
  save(path.join(dir,'qa','still-evidence.json'),records);
}
async function render(plan,dir,only){
  const r=await renderer(plan,dir),clips=[];
  fs.mkdirSync(path.join(dir,'shots'),{recursive:true});
  for(const s of plan.shots.filter(s=>(s.effects.length||s.page)&&(!only||only.includes(s.storyboardNumber)))){
    const props=propsForShot(s);if(s.page)props.captions=[];
    const base=await shotBase(s,plan,dir);
    const signature=createHash('sha256').update(JSON.stringify({props,code:r.code,image:hash(local(s.firstFrameImage)),base:hash(base),caption:hash(s.caption.file)})).digest('hex').slice(0,16);
    const clip=path.join(dir,`overlay-${s.storyboardNumber}-${signature}.mov`),out=path.join(dir,'shots',`${s.storyboardNumber}.mp4`),stamp=out+'.json';
    if(!fs.existsSync(out)||!fs.existsSync(stamp)||read(stamp).signature!==signature){
      const composition=await r.selectComposition({...r,id:'ReferenceEditorialOverlay',inputProps:props});
      if(!fs.existsSync(clip)){
        await r.renderMedia({...r,composition,inputProps:props,outputLocation:clip+'.partial.mov',codec:'prores',proResProfile:'4444',pixelFormat:'yuva444p10le',imageFormat:'png',concurrency:3,muted:true,logLevel:'error'});
        fs.renameSync(clip+'.partial.mov',clip);
      }
      const meta=await probe(clip);
      if(Number(meta.streams[0].nb_frames)!==props.durationInFrames||!meta.streams[0].pix_fmt.startsWith('yuva'))throw Error('Invalid transparent overlay');
      const start=props.shotFrameOffset/fps,end=start+props.durationInFrames/fps;
      const captionFilter=s.page?`,subtitles='${escapedFilter(s.caption.file)}'`:'';
      await exec('ffmpeg',['-v','error','-y','-filter_complex_threads','2','-i',base,'-i',clip,'-filter_complex',`[1:v]setpts=PTS-STARTPTS+${start}/TB[e];[0:v][e]overlay=0:0:eof_action=pass:repeatlast=0:enable='gte(t,${start})*lt(t,${end})'${captionFilter},format=yuv420p[v]`,'-map','[v]','-an','-c:v','h264_videotoolbox','-b:v','6500k','-frames:v',String(s.frames),'-movflags','+faststart',out+'.partial.mp4'],{maxBuffer:8e6});
      if(Number((await probe(out+'.partial.mp4')).streams[0].nb_frames)!==s.frames)throw Error('Shot frame count changed');
      fs.renameSync(out+'.partial.mp4',out);save(stamp,{signature,frames:s.frames});
    }
    clips.push({shot:s.storyboardNumber,clip,output:out,globalStart:(s.startFrame+props.shotFrameOffset)/fps,globalEnd:(s.startFrame+props.shotFrameOffset+props.durationInFrames)/fps});
    console.log(`rendered ${s.storyboardNumber} (${clips.length})`);
  }
  save(path.join(dir,only?'sample-overlays.json':'overlays.json'),{planFingerprint:hash(path.join(dir,'edit-plan.json')),codeFingerprint:r.code,clips});
}
async function merge(plan,dir,output){
  if(fs.existsSync(output))throw Error('Refuse overwrite');
  const encoding=resolveUploadEncoding(plan.uploadEncoding);
  const manifest=read(path.join(dir,'overlays.json'));
  if(manifest.planFingerprint!==hash(path.join(dir,'edit-plan.json')))throw Error('Stale render plan');
  if(manifest.codeFingerprint!==codeFingerprint())throw Error('Renderer changed since shot rendering');
  const changed=new Map(manifest.clips.map(c=>[c.shot,c]));
  if(changed.size!==plan.shots.filter(s=>s.effects.length||s.page).length)throw Error('Missing edited shots');
  const list=path.join(dir,'concat.txt');
  fs.writeFileSync(list,plan.shots.map(s=>`file '${changed.get(s.storyboardNumber)?.output||path.join(plan.baseDir,'shots',`${s.storyboardNumber}.mp4`)}'`).join('\n'));
  await exec('ffmpeg',['-v','error','-n','-f','concat','-safe','0','-i',list,'-i',plan.sourcePath,'-map','0:v:0','-map','1:a:0',...uploadVideoArgs(encoding),'-c:a','copy','-movflags','+faststart',output+'.partial.mp4'],{maxBuffer:8e6});
  const info=await probe(output+'.partial.mp4');
  if(Number(info.streams.find(s=>s.codec_type==='video').nb_frames)!==plan.shots.reduce((n,s)=>n+s.frames,0)||Math.abs(Number(info.format.duration)-plan.duration)>.04)throw Error('Timeline changed');
  const audioHash=async p=>(await exec('ffmpeg',['-v','error','-i',p,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
  const audio=await audioHash(output+'.partial.mp4');if(audio!==await audioHash(plan.sourcePath))throw Error('Audio changed');
  const uploadEncoding=uploadEncodingReport(info,fs.statSync(output+'.partial.mp4').size,encoding);
  save(path.join(dir,'upload-encoding-report.json'),uploadEncoding);
  if(uploadEncoding.status!=='within-budget')throw Error('Final assembly exceeds upload filesize budget; review quality/settings in a new revision');
  fs.renameSync(output+'.partial.mp4',output);
  save(path.join(dir,'delivery.json'),{status:'rendered-awaiting-review',output,url:`http://127.0.0.1:3013/${path.relative(path.join(root,'data'),output)}`,duration:Number(info.format.duration),audioHash:audio,sha256:hash(output),editedShots:changed.size,uploadEncoding});
  console.log('Merged '+output);
}
async function main(){
  const [command,directory,arg]=process.argv.slice(2),dir=path.resolve(directory),plan=read(path.join(dir,'edit-plan.json'));
  const only=arg&&command!=='merge'?arg.split(',').map(Number):undefined;
  if(command==='stills')return stills(plan,dir,only);
  if(command==='render')return render(plan,dir,only);
  if(command==='merge')return merge(plan,dir,path.resolve(arg));
  throw Error('Expected stills, render, or merge');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1});
