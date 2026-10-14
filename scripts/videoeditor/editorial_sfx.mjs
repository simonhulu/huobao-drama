import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolveUploadEncoding,uploadEncodingReport} from './upload_encoding.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const rate=48000;
const rpg='data/sfx/library/rpg-sounds/OGG/';
const ui='data/sfx/library/kenney-interface/Audio/';
export const specs={
  confused:{file:ui+'scratch_003.ogg',duration:.52,gainDb:-9,label:'short dry scratch / puzzled interruption'},
  sweat:{file:ui+'drop_003.ogg',duration:.36,gainDb:-11,label:'small rounded drop'},
  thought:{file:ui+'pluck_001.mp3',duration:.42,gainDb:-11,label:'quiet pluck / question forming'},
  alert:{file:rpg+'metalClick.ogg',duration:.30,gainDb:-10,label:'brief metallic attention tick'},
  anger:{file:rpg+'clothBelt.ogg',duration:.48,gainDb:-12,label:'dry leather snap / restrained frustration'},
  gloom:{file:ui+'minimize_004.mp3',duration:.62,gainDb:-20,label:'descending soft gesture'},
  idea:{file:ui+'confirmation_002.mp3',duration:.58,gainDb:-20,label:'brief bright resolution'},
  scroll:{file:rpg+'bookOpen.mp3',duration:.74,gainDb:-13,label:'paper opening'},
  brush:{file:rpg+'cloth3.ogg',duration:.48,gainDb:-14,label:'soft textured brush substitute'},
  stamp:{file:rpg+'bookPlace2.ogg',duration:.38,gainDb:-6,label:'muted solid paper thud'},
  paper:{file:rpg+'bookFlip1.ogg',duration:.72,gainDb:-6,label:'single paper page turn'},
  coin:{file:rpg+'handleCoins.ogg',duration:.8,gainDb:-9,label:'small handful of coins'},
  coins:{file:rpg+'handleCoins2.mp3',duration:1.05,gainDb:-11,label:'coins handled / financial reveal'},
  footstep:{file:rpg+'footstep07.ogg',duration:.55,gainDb:-10,label:'restrained footfall'},
  door:{file:rpg+'doorClose_2.ogg',duration:.85,gainDb:-14,label:'wooden door closing'},
  lock:{file:rpg+'metalLatch.ogg',duration:.55,gainDb:-8,label:'metal latch / confinement'},
  wood:{file:rpg+'bookPlace3.ogg',duration:.55,gainDb:-10,label:'document landing on desk'},
  cloth:{file:rpg+'cloth4.ogg',duration:.7,gainDb:-11,label:'short cloth movement'},
  sword:{file:rpg+'drawKnife2.ogg',duration:.7,gainDb:-12,label:'restrained blade draw / threatening turn'},
};
const run=(cmd,args,options={})=>execFileSync(cmd,args,{maxBuffer:64*1024*1024,...options});
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const sha=p=>{
  const digest=createHash('sha256');
  const fd=fs.openSync(p,'r');
  const buffer=Buffer.allocUnsafe(1024*1024);
  try{
    let bytes=0;
    while((bytes=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,bytes));
  }finally{fs.closeSync(fd);}
  return digest.digest('hex');
};
const probe=p=>JSON.parse(run('ffprobe',['-v','error','-show_entries','stream=codec_type,nb_frames,duration:format=duration','-of','json',p]));

export function schedule(plan){
  const catalog=plan.soundAssets??specs;
  if(!Number.isFinite(plan.fps)||plan.fps<=0||!Number.isFinite(plan.duration)||plan.duration<=0)throw Error('Invalid fps/duration');
  const events=[];
  for(const s of plan.shots){
    if(!Number.isInteger(s.startFrame)||s.startFrame<0||!Number.isInteger(s.frames)||s.frames<1)throw Error('Invalid shot frame bounds');
    for(const c of s.audioCues??[]){
      if(!Object.hasOwn(catalog,c.kind))throw Error('Unknown/unsafe cue kind');
      const spec=catalog[c.kind];
      if(!Number.isFinite(spec.duration)||spec.duration<=0||spec.duration>10)throw Error('Invalid asset duration');
      if(!Number.isInteger(c.frame)||c.frame<0||c.frame>=s.frames)throw Error('Cue outside shot');
      const gainDb=c.gainDb??spec.gainDb;
      if(!Number.isFinite(gainDb)||gainDb> -6||gainDb< -60)throw Error('Unsafe cue gain');
      const startSample=Math.round((s.startFrame+c.frame)/plan.fps*rate);
      const endSample=Math.min(Math.round((s.startFrame+s.frames)/plan.fps*rate),Math.round(plan.duration*rate),startSample+Math.round(spec.duration*rate));
      if(endSample<=startSample)throw Error('Cue outside episode');
      events.push({...c,gainDb,shot:s.storyboardNumber,startSample,endSample,globalFrame:s.startFrame+c.frame});
    }
  }
  events.sort((a,b)=>a.startSample-b.startSample);
  for(let i=0;i<events.length;i++)if(events.slice(0,i+1).filter(e=>e.endSample>events[i].startSample).length>2)throw Error('More than two simultaneous cues');
  return events;
}

export function wav(samples,channels=1){
  const b=Buffer.alloc(44+samples.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples.length*2,40);
  for(let i=0;i<samples.length;i++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);
  return b;
}

export function prepare(dir,catalog=specs){
  const assetDir=path.join(dir,'sfx');fs.mkdirSync(assetDir,{recursive:true});
  const assets=[];
  for(const [kind,spec] of Object.entries(catalog)){
    if(!/^[a-zA-Z0-9_-]+$/.test(kind))throw Error('Unsafe asset key');
    if(!Number.isFinite(spec.trimStart??0)||(spec.trimStart??0)<0||!Number.isFinite(spec.targetRmsDb??-18)||(spec.targetRmsDb??-18)>-3)throw Error('Invalid preparation level/offset');
    const custom=catalog!==specs,channels=custom?2:1;
    const input=path.resolve(root,spec.file),output=path.join(assetDir,kind+'.wav');
    const filters=custom?'highpass=f=40':'highpass=f=90,lowpass=f=7500,acompressor=threshold=0.04:ratio=4:attack=0.5:release=50:makeup=1';
    const raw=run('ffmpeg',['-v','error','-ss',String(spec.trimStart??0),'-i',input,'-t',String(spec.duration),'-af',filters,'-ar',String(rate),'-ac',String(channels),'-f','f32le','pipe:1']);
    const data=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.length));
    let peak=0;for(const v of data)peak=Math.max(peak,Math.abs(v));
    if(peak<.00001)throw Error('Silent asset '+kind);
    let energy=0,active=0;for(const v of data)if(Math.abs(v)>peak*.03){energy+=v*v;active++;}
    const rms=Math.sqrt(energy/Math.max(1,active));
    const gain=custom?Math.min(10**(-3/20)/peak,10**((spec.targetRmsDb??-18)/20)/rms):10**(-1/20)/peak;
    for(let i=0;i<data.length;i++)data[i]*=gain*Math.min(1,i/(96*channels),(data.length-1-i)/((custom?1920:480)*channels));
    fs.writeFileSync(output,wav(data,channels));
    const provenance=custom?{source:spec.source,license:spec.license,processing:'48k stereo; 40Hz highpass; preserve dynamics, active RMS calibration with -3 dBFS peak cap; 2ms attack/40ms release; narration-driven SFX ducking'}:{source:'Kenney local licensed library',license:'CC0-1.0',licenseFile:path.join(root,spec.file.startsWith(rpg)?'data/sfx/library/rpg-sounds/license.txt':'data/sfx/library/kenney-interface/License.txt'),sourceUrl:'https://kenney.nl/assets',processing:'48k mono; 90Hz highpass, 7.5kHz lowpass; transient compression; peak -1 dBFS; 2ms attack/10ms release'};
    assets.push({kind,...spec,prepared:output,sourceSha256:sha(input),preparedSha256:sha(output),channels,normalizationGainDb:20*Math.log10(gain),...provenance});
  }
  save(path.join(assetDir,'provenance.json'),{generator:'editorial_sfx.mjs',noMusic:true,assets});
  const audition=new Float32Array(rate*Object.keys(catalog).length*12*2),chapters=[];
  for(const [i,kind] of Object.keys(catalog).entries()){
    const b=fs.readFileSync(path.join(assetDir,kind+'.wav'));
    const channels=b.readUInt16LE(22);
    for(let j=0;j<(b.length-44)/2/channels;j++)for(let ch=0;ch<2;ch++)audition[(i*rate*12+j)*2+ch]=b.readInt16LE(44+(j*channels+Math.min(ch,channels-1))*2)/32768;
    chapters.push({kind,startSeconds:i*12,gainDb:0,note:'Prepared asset at unity; final cue has its own gain'});
  }
  fs.writeFileSync(path.join(assetDir,'audition.wav'),wav(audition,2));save(path.join(assetDir,'audition-chapters.json'),chapters);
  return assets;
}

export function mix(dir,video,output){
  if(fs.existsSync(output))throw Error('Refusing to overwrite output');
  const planFile=path.join(dir,'edit-plan.json'),planSha256=sha(planFile),plan=read(planFile),events=schedule(plan);
  const encoding=resolveUploadEncoding(plan.uploadEncoding);
  if(!events.length)throw Error('No audio cues');
  prepare(dir,plan.soundAssets??specs);
  const count=Math.round(plan.duration*rate),bed=new Float32Array(count*2),cache={};
  for(const e of events){
    const samples=cache[e.kind]??=fs.readFileSync(path.join(dir,'sfx',e.kind+'.wav'));
    const channels=samples.readUInt16LE(22);
    const n=Math.min((samples.length-44)/2/channels,e.endSample-e.startSample);
    for(let i=0;i<n;i++){
      const gain=10**(e.gainDb/20)*Math.min(1,(n-1-i)/(plan.soundAssets?1920:480));
      bed[(e.startSample+i)*2]+=samples.readInt16LE(44+i*2*channels)/32768*gain;
      bed[(e.startSample+i)*2+1]+=samples.readInt16LE(44+(i*channels+channels-1)*2)/32768*gain;
    }
  }
  const bedFile=path.join(dir,'sfx','emotion-bed.wav');fs.writeFileSync(bedFile,wav(bed,2));
  const filters='[1:a]aresample=48000,asplit=2[voice][key];[2:a][key]sidechaincompress=threshold=0.08:ratio=2:attack=5:release=100[duck];[voice][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=true[mix]';
  run('ffmpeg',['-v','error','-n','-filter_complex_threads','1','-i',video,'-i',plan.sourcePath,'-i',bedFile,'-filter_complex',filters,'-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-b:a',encoding.audioBitrate,'-t',String(plan.duration),'-movflags','+faststart',output]);
  const before=probe(video),after=probe(output),videoFrames=m=>Number(m.streams.find(s=>s.codec_type==='video')?.nb_frames);
  if(videoFrames(before)!==videoFrames(after)||Math.abs(Number(after.format.duration)-Number(before.format.duration))>1/plan.fps)throw Error('Output duration/frames mismatch');
  const packetHash=p=>run('ffmpeg',['-v','error','-i',p,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','pipe:1']).toString().trim();
  if(packetHash(video)!==packetHash(output))throw Error('Video copy verification failed');
  // Capture decoded loudness and true peak evidence.
  const stats=path.join(dir,'sfx','loudness.log'),fd=fs.openSync(stats,'w');
  try{run('ffmpeg',['-hide_banner','-i',output,'-vn','-af','ebur128=peak=true','-f','null','-'],{stdio:['ignore','ignore',fd]});}finally{fs.closeSync(fd);}
  const loudness=fs.readFileSync(stats,'utf8').split('Summary:').at(-1).trim();
  if(sha(planFile)!==planSha256)throw Error('Plan changed while mixing; do not reuse this audio');
  const uploadEncoding=uploadEncodingReport(after,fs.statSync(output).size,encoding);
  const result={status:'mixed-awaiting-listening-QA',output:path.resolve(output),sha256:sha(output),planSha256,sourceAudio:path.resolve(plan.sourcePath),sourceUnmodified:true,videoPacketHash:packetHash(output),videoFrames:videoFrames(after),duration:Number(after.format.duration),cueCount:events.length,events,loudness,ducking:'Only SFX duck against narration; narration remains at unity until final -0.45 dBFS safety limiter',codec:`AAC ${encoding.audioBitrate}bps, stereo 48kHz`,noBgm:true,uploadEncoding};
  save(path.join(dir,'sfx','mix-report.json'),result);return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [cmd,dir,video,output]=process.argv.slice(2);
  if(!dir||!['prepare','mix'].includes(cmd)||(cmd==='mix'&&(!video||!output)))throw Error('Usage: editorial_sfx.mjs prepare <dir> | mix <dir> <video> <newoutput>');
  const planFile=path.resolve(dir,'edit-plan.json');
  console.log(JSON.stringify(cmd==='prepare'?prepare(path.resolve(dir),fs.existsSync(planFile)?read(planFile).soundAssets??specs:specs):mix(path.resolve(dir),path.resolve(video),path.resolve(output)),null,2));
}
