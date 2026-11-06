import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const changingCamera=motion=>motion?.kind!=='static' && motion?.keyframes?.some((key,_,keys)=>
  key.focusX!==keys[0].focusX || key.focusY!==keys[0].focusY || key.zoom!==keys[0].zoom);

// Keep this schedule aligned with HistoryMotionFactory's static image, caption
// and outgoing-scene contracts. Animated features always use the full renderer.
export function staticImageRenderSchedule(props) {
  const reasons=[],boundaries=new Set([0,props?.durationInFrames]);
  const totalFrames=props?.durationInFrames;
  if(![1920,1080].includes(props?.width) || props?.width+props?.height!==3000 || props?.fps!==30
    || !Number.isInteger(totalFrames) || totalFrames<1 || !props?.shots?.length)reasons.push('unsupported timeline');
  if(!props?.audioSrc)reasons.push('missing narration');
  if(props?.soundEffects?.length)reasons.push('sound effects require the full renderer');
  let cursor=0;
  for(const [index,shot] of (props?.shots || []).entries()) {
    const unsupported=shot.sourcePath || shot.map?.enabled || !shot.imagePath || shot.graphic
      || shot.titles?.length || shot.shotcraft?.vignette || changingCamera(shot.motion);
    if(unsupported)reasons.push(`shot ${shot.shotId}: animated or non-image scene`);
    if(shot.startFrame!==cursor || !Number.isInteger(shot.frames) || shot.frames<1)reasons.push('non-contiguous image timeline');
    cursor=shot.startFrame+shot.frames;
    boundaries.add(shot.startFrame);boundaries.add(cursor);
    const previous=props.shots[index-1];
    if(!previous || previous.startFrame+previous.frames!==shot.startFrame
      || shot.shotcraft?.transition==='cut' || previous.shotcraft?.recipe==='slow-push-in')continue;
    const illustrated=previous.map?.enabled || shot.map?.enabled || previous.imagePath || shot.imagePath;
    const frames=Math.max(0,Math.min(Math.round(props.fps*(illustrated ? .4 : .267)),Math.floor(previous.frames/5),Math.floor(shot.frames/5)));
    // Capture every changing blend; never hold the outgoing/incoming midpoint.
    if(frames>1)for(let frame=shot.startFrame;frame<=shot.startFrame+frames;frame++)boundaries.add(frame);
  }
  if(cursor!==totalFrames)reasons.push('incorrect image timeline duration');
  let captionEnd=0;
  for(const caption of props?.captions || []) {
    if(!Number.isInteger(caption.startFrame) || !Number.isInteger(caption.endFrame) || caption.startFrame<captionEnd
      || caption.endFrame<=caption.startFrame || caption.endFrame>totalFrames)reasons.push('invalid caption interval');
    captionEnd=caption.endFrame;
    boundaries.add(caption.startFrame);boundaries.add(caption.endFrame);
  }
  if(reasons.length)return {eligible:false,reasons:[...new Set(reasons)],totalFrames};
  const frames=[...boundaries].sort((a,b)=>a-b);
  const spans=frames.slice(0,-1).map((frame,index)=>({frame,frames:frames[index+1]-frame}));
  if(spans.length>=totalFrames/2)return {eligible:false,reasons:['insufficient static-frame capture savings'],totalFrames};
  return {eligible:true,reasons:[],totalFrames,capturedFrames:spans.length,spans};
}

export function removeBundlePublicAlias(bundleDir,publicDir) {
  const alias=path.join(bundleDir,'public');
  let stat;
  try {stat=fs.lstatSync(alias);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!stat.isSymbolicLink())return false;
  const expected=path.resolve(publicDir),target=path.resolve(path.dirname(alias),fs.readlinkSync(alias));
  if(target!==expected || fs.realpathSync(alias)!==fs.realpathSync(expected))throw Error('Bundle public alias points outside the frozen assets');
  fs.unlinkSync(alias);
  return true;
}

function encodeTimeline(args,{signal,onFrame}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let stderr='',progress='',killTimer,settled=false;
    const abort=()=>{
      child.kill('SIGTERM');
      killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();
    };
    signal?.addEventListener('abort',abort,{once:true});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
    child.stdout.on('data',chunk=>{
      progress+=chunk.toString();
      const lines=progress.split('\n');progress=lines.pop();
      for(const line of lines)if(/^frame=\d+$/.test(line))onFrame?.(Number(line.slice(6)));
    });
    const finish=error=>{
      if(settled)return;
      settled=true;
      if(killTimer)clearTimeout(killTimer);
      signal?.removeEventListener('abort',abort);
      if(signal?.aborted)reject(signal.reason || Error('Static image render canceled'));
      else if(error)reject(error);else resolve();
    };
    child.once('error',finish);
    child.once('close',code=>finish(code===0?null:Error(`Static image hardware encoding failed (${code}): ${stderr}`)));
    if(signal?.aborted)abort();
  });
}

export async function renderStaticImageTimeline({props,schedule,renderer,composition,serveUrl,browserExecutable,
  publicDir,work,output,encoding,cancelSignal,signal,onProgress}) {
  if(!schedule?.eligible)throw Error('Static image rendering requires an eligible schedule');
  const directory=path.join(work,'static-frames');
  fs.mkdirSync(directory,{recursive:false});
  let browser,failure;
  const started=performance.now();
  try {
    browser=await renderer.openBrowser('chrome',{browserExecutable,logLevel:'error'});
    const files=[];
    for(const [index,span] of schedule.spans.entries()) {
      signal?.throwIfAborted();
      const filename=`frame-${String(index).padStart(6,'0')}.jpg`;
      await renderer.renderStill({serveUrl,composition,inputProps:props,browserExecutable,puppeteerInstance:browser,
        frame:span.frame,imageFormat:'jpeg',jpegQuality:92,output:path.join(directory,filename),cancelSignal,logLevel:'error'});
      files.push(`file '${filename}'\noption framerate ${props.fps}\nduration ${span.frames/props.fps}`);
      onProgress?.({phase:'capture',capturedFrames:index+1,totalCaptures:schedule.spans.length,renderedFrames:span.frame+span.frames,encodedFrames:0});
    }
    const captureMs=performance.now()-started;
    await browser.close({silent:true});browser=undefined;
    const manifest=path.join(directory,'timeline.ffconcat');
    files.push(`file 'frame-${String(schedule.spans.length-1).padStart(6,'0')}.jpg'\noption framerate ${props.fps}`);
    fs.writeFileSync(manifest,'ffconcat version 1.0\n'+files.join('\n')+'\n');
    const encodingStarted=performance.now();
    await encodeTimeline(['-v','error','-n','-f','concat','-safe','0','-i',manifest,
      '-i',path.join(publicDir,props.audioSrc),'-map','0:v:0','-map','1:a:0',
      '-vf',`fps=${props.fps},zscale=matrix=709:matrixin=709:range=limited,format=yuv420p`,
      '-frames:v',String(props.durationInFrames),'-t',String(props.durationInFrames/props.fps),
      '-c:v','h264_videotoolbox','-allow_sw','0','-b:v',`${encoding.videoBitrateKbps}k`,
      '-g','150','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',
      '-color_range','tv','-video_track_timescale','90000',
      '-c:a','aac','-b:a',encoding.audioBitrate,'-ar','48000','-af','apad','-movflags','+faststart',
      '-progress','pipe:1','-nostats',output],{signal,onFrame:frame=>onProgress?.({phase:'encode',
        capturedFrames:schedule.spans.length,totalCaptures:schedule.spans.length,renderedFrames:props.durationInFrames,encodedFrames:frame})});
    return {captureMs,encodingMs:performance.now()-encodingStarted,capturedFrames:schedule.spans.length,totalFrames:props.durationInFrames};
  } catch(error) {
    failure=error;throw error;
  } finally {
    try {if(browser)await browser.close({silent:true});}
    catch(error) {if(!failure)throw error;}
    finally {fs.rmSync(directory,{recursive:true,force:true});}
  }
}
