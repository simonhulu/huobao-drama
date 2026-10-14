export const UPLOAD_ENCODING=Object.freeze({
  profile:'history-upload-h264-v1',
  crf:24,
  preset:'slow',
  maxRateKbps:2000,
  audioBitrate:'128k',
  maxMegabytesPerMinute:17,
});

export function resolveUploadEncoding(overrides){
  if(overrides!==undefined&&(!overrides||typeof overrides!=='object'||Array.isArray(overrides)))throw Error('Invalid upload encoding settings');
  for(const key of Object.keys(overrides??{}))if(!Object.hasOwn(UPLOAD_ENCODING,key)&&key!=='reason')throw Error(`Unknown upload encoding option: ${key}`);
  const config={...UPLOAD_ENCODING,...overrides};
  if(config.profile!==UPLOAD_ENCODING.profile)throw Error('Unknown upload encoding profile');
  if(!Number.isInteger(config.crf)||config.crf<18||config.crf>26)throw Error('Upload CRF must be an integer from 18 to 26');
  if(!['medium','slow'].includes(config.preset))throw Error('Upload preset must be medium or slow');
  if(!Number.isInteger(config.maxRateKbps)||config.maxRateKbps<1000||config.maxRateKbps>4000)throw Error('Upload maximum bitrate must be 1000-4000 kbps');
  if(!['128k','192k'].includes(config.audioBitrate))throw Error('Upload audio bitrate must be 128k or 192k');
  if(!Number.isFinite(config.maxMegabytesPerMinute)||config.maxMegabytesPerMinute<5||config.maxMegabytesPerMinute>35)throw Error('Invalid upload filesize budget');
  if(Object.keys(UPLOAD_ENCODING).some(key=>config[key]!==UPLOAD_ENCODING[key])&&(typeof config.reason!=='string'||!config.reason.trim()))throw Error('Non-default upload encoding needs an explicit quality-review reason');
  return Object.freeze(config);
}

export function uploadVideoArgs(encoding){
  const config=resolveUploadEncoding(encoding);
  return ['-c:v','libx264','-preset',config.preset,'-crf',String(config.crf),
    '-maxrate',`${config.maxRateKbps}k`,'-bufsize',`${config.maxRateKbps*2}k`,
    '-profile:v','high','-pix_fmt','yuv420p','-g','150'];
}

export function uploadEncodingReport(metadata,bytes,encoding){
  const config=resolveUploadEncoding(encoding),duration=Number(metadata?.format?.duration);
  if(!Number.isFinite(duration)||duration<=0)throw Error('Invalid upload duration');
  if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('Invalid upload file size');
  // VBV limits short-term bitrate, not final bytes. Allow only a small startup
  // buffer/container allowance, then check the actual delivered size.
  const budgetBytes=Math.ceil(duration/60*config.maxMegabytesPerMinute*1e6+500_000);
  const video=metadata.streams?.find(s=>s.codec_type==='video');
  return {settings:config,encoder:'libx264',status:bytes<=budgetBytes?'within-budget':'over-budget',
    bytes,budgetBytes,megabytesPerMinute:bytes/1e6/(duration/60),averageTotalBitrate:bytes*8/duration,
    ...(video?{video:{codec:video.codec_name,width:video.width,height:video.height,fps:video.r_frame_rate}}:{})};
}
