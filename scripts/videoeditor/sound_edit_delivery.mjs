import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {resolveUploadEncoding,uploadVideoArgs} from './upload_encoding.mjs';

// Package an audio-only revision without rerendering or re-approving its pictures.
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
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
export function soundDeliveryIdentity(plan){
  if(typeof plan.deliveryStem!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(plan.deliveryStem))throw Error('An explicit safe plan.deliveryStem is required');
  return {stem:plan.deliveryStem,label:plan.deliveryLabel||`第 ${plan.episodeId} 集 · 精细剪辑`};
}
export function soundComparison(plan,outDir){
  if(plan.comparisonFile===undefined||plan.comparisonFile===null)return null;
  if(typeof plan.comparisonFile!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.mp4$/.test(plan.comparisonFile))throw Error('comparisonFile must be an explicit MP4 filename in the output directory');
  const file=path.join(outDir,plan.comparisonFile);
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw Error(`Comparison video not found: ${file}`);
  if(plan.comparisonFile===`${plan.deliveryStem}.mp4`)throw Error('Comparison must be a different video');
  return {file:plan.comparisonFile,label:plan.comparisonLabel||'对照版本'};
}
export function selectHighlightShots(plan){
  if(!Array.isArray(plan.shots)||!plan.shots.length)throw Error('Plan needs shots');
  const byNumber=new Map(plan.shots.map(s=>[s.storyboardNumber,s]));
  if(byNumber.size!==plan.shots.length)throw Error('Duplicate storyboard numbers');
  if(plan.highlightShots!==undefined){
    if(!Array.isArray(plan.highlightShots)||!plan.highlightShots.length||new Set(plan.highlightShots).size!==plan.highlightShots.length||plan.highlightShots.some(n=>!byNumber.has(n)))throw Error('highlightShots must contain unique existing storyboard numbers');
    return plan.shots.filter(s=>plan.highlightShots.includes(s.storyboardNumber));
  }
  const marked=plan.shots.filter(s=>s.audioCues?.length||s.effects?.length||s.page),pool=marked.length?marked:plan.shots;
  return pool.length<=8?pool:Array.from({length:8},(_,i)=>pool[Math.round(i*(pool.length-1)/7)]);
}
export function packageSoundDelivery(directory){
const dir=path.resolve(directory);
const plan=read(path.join(dir,'edit-plan.json'));
const encoding=resolveUploadEncoding(plan.uploadEncoding);
const report=read(path.join(dir,'sfx/mix-report.json'));
const {stem,label}=soundDeliveryIdentity(plan);
if(typeof report.output!=='string'||!path.isAbsolute(report.output))throw Error('mix-report output must be absolute');
const output=report.output,outDir=path.dirname(output);
if(path.basename(output)!==stem+'.mp4')throw Error('Mixed video filename must match deliveryStem.mp4');
if(!fs.existsSync(output))throw Error(`Mixed video not found: ${output}`);
if(report.planSha256!==hash(path.join(dir,'edit-plan.json')))throw Error('Mix report uses a stale plan; mix the frozen final plan first');
if(report.sha256!==hash(output))throw Error('Mixed video fingerprint does not match report');
if(report.noBgm!==true)throw Error('Expected a no-BGM mix report');
if(!Number.isFinite(plan.fps)||plan.fps<=0||!Number.isFinite(plan.duration)||plan.duration<=0)throw Error('Invalid plan fps/duration');
const comparison=soundComparison(plan,outDir),shots=selectHighlightShots(plan);
let nextFrame=0;
for(const s of plan.shots){if(!Number.isInteger(s.startFrame)||s.startFrame!==nextFrame||!Number.isInteger(s.frames)||s.frames<1)throw Error('Plan shot timeline must be contiguous integer frames');nextFrame+=s.frames;}
if(report.videoFrames!==nextFrame||!Number.isFinite(report.duration)||Math.abs(report.duration-plan.duration)>.04||report.cueCount!==plan.shots.reduce((n,s)=>n+(s.audioCues?.length||0),0))throw Error('Mix report does not match plan frame/duration/cue totals');
if(report.uploadEncoding?.status==='over-budget')throw Error('Mixed video exceeds upload filesize budget; review encoding before delivery');
const run=(args)=>execFileSync('ffmpeg',args,{stdio:['ignore','ignore','pipe']});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const assets=path.join(outDir,stem+'-assets'),highlights=path.join(outDir,stem+'-highlights.mp4'),page=path.join(outDir,stem+'-review.html'),concat=path.join(dir,'highlights.txt');
for(const target of [assets,highlights,page,concat])if(fs.existsSync(target))throw Error(`Refusing to overwrite existing delivery artifact: ${target}`);
const deliveryPath=path.join(dir,'delivery.json');
if(fs.existsSync(deliveryPath)&&!fs.existsSync(path.join(dir,'dry-delivery.json')))fs.copyFileSync(deliveryPath,path.join(dir,'dry-delivery.json'),fs.constants.COPYFILE_EXCL);
fs.mkdirSync(assets,{recursive:true});
const clips=[];
for(const s of shots){
  const clip=path.join(assets,`shot-${s.storyboardNumber}.mp4`);
  run(['-v','error','-n','-ss',String(s.startFrame/plan.fps),'-i',output,'-t',String(s.frames/plan.fps),'-map','0:v:0','-map','0:a:0',...uploadVideoArgs(encoding),'-c:a','aac','-b:a',encoding.audioBitrate,'-movflags','+faststart',clip]);
  clips.push(clip);
}
fs.writeFileSync(concat,clips.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join('\n')+'\n',{flag:'wx'});
run(['-v','error','-n','-f','concat','-safe','0','-i',concat,'-c','copy','-movflags','+faststart',highlights]);
const seconds=shots.reduce((sum,s)=>sum+s.frames/plan.fps,0);
const buttons=shots.map(s=>`<button data-time="${s.startFrame/plan.fps}">第 ${s.storyboardNumber} 镜 · ${esc(s.audioCues?.map(c=>c.reason).filter(Boolean).join(' / ')||s.intent||'镜头预览')}</button>`).join('');
const html=soundReviewHtml({plan,report,stem,label,comparison,buttons,seconds});
fs.writeFileSync(page,html,{flag:'wx'});
const delivery={status:'packaged-awaiting-final-technical-and-listening-qa',episodeId:plan.episodeId,output,sha256:report.sha256,duration:report.duration,frames:report.videoFrames,cueCount:report.cueCount,noBgm:true,videoPacketHash:report.videoPacketHash,highlights,page,comparison,highlightSeconds:seconds,highlightShots:shots.map(s=>s.storyboardNumber),visualChange:'No video changes during sound mixing; videoPacketHash refers to the mixed input master',loudness:report.loudness,...(report.uploadEncoding?{uploadEncoding:report.uploadEncoding}:{})};
fs.writeFileSync(deliveryPath,JSON.stringify(delivery,null,2)+'\n');
return delivery;
}

export function soundReviewHtml({plan,report,stem,label,comparison,buttons='',seconds}){
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selector=comparison?`<h2>同一位置切换版本</h2><select id="version"><option value="${stem}.mp4">${esc(label)}</option><option value="${comparison.file}">${esc(comparison.label)}</option></select>`:'<h2>完整成片</h2>';
return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(label)}</title><style>body{max-width:1100px;margin:32px auto;padding:0 20px;background:#191d22;color:#eee;font:17px/1.7 system-ui}a{color:#ecc38d}video{width:100%;max-height:75vh;background:black}button{display:block;width:100%;text-align:left;background:#29333e;color:#eee;border:1px solid #55616b;padding:12px;margin:8px 0;cursor:pointer}select{padding:10px}.note{color:#c6c9cc}</style><h1>${esc(label)}</h1><p>${report.cueCount} 处短音效 · 旁白优先 · 无背景音乐。${esc(plan.soundSummary||'按镜头动作与情绪安排短音效，保留原旁白与画面节奏。')}</p><h2>${Math.round(seconds)} 秒精选</h2><video id="preview" controls preload="metadata" src="${stem}-highlights.mp4"></video><p><a href="${stem}.mp4">打开完整新版</a> · <a href="${stem}-highlights.mp4">打开精选</a></p>${selector}<video id="full" controls preload="metadata" src="${stem}.mp4"></video><p class="note">${comparison?'切换版本会保留播放位置；':''}一次只播放一条音轨。请打开声音检查旁白、动画与音效的配合。</p>${buttons}<script>const p=document.getElementById('preview'),v=document.getElementById('full');p.onplay=()=>v.pause();v.onplay=()=>p.pause();const selector=document.getElementById('version');if(selector)selector.onchange=e=>{const t=v.currentTime,playing=!v.paused;v.pause();v.src=e.target.value;v.addEventListener('loadedmetadata',()=>{v.currentTime=Math.min(t,Math.max(0,v.duration-.05));if(playing)v.play().catch(()=>{})},{once:true});v.load()};document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{p.pause();v.currentTime=Number(b.dataset.time);v.play().catch(()=>{})});</script></html>`;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('Usage: node scripts/videoeditor/sound_edit_delivery.mjs <edit-directory>');
    console.log(JSON.stringify(packageSoundDelivery(process.argv[2]),null,2));
  }catch(error){console.error(`[videoeditor] ${error.message}`);process.exitCode=1;}
}
