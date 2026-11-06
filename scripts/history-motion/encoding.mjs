import {resolveUploadEncoding,uploadEncodingReport} from '../videoeditor/upload_encoding.mjs';

const hardwareProfile='history-motion-hardware-h264-v1';
const hardwareEncoder='h264_videotoolbox';

export function resolveMotionHardwareEncoding(legacyOverrides) {
  const legacy=resolveUploadEncoding(legacyOverrides);
  return Object.freeze({profile:hardwareProfile,encoder:hardwareEncoder,hardwareAcceleration:'required',
    videoBitrateKbps:legacy.maxRateKbps,audioBitrate:legacy.audioBitrate,maxMegabytesPerMinute:legacy.maxMegabytesPerMinute});
}

export function motionHardwareRenderOptions(encoding) {
  if(encoding?.profile!==hardwareProfile || encoding.encoder!==hardwareEncoder || encoding.hardwareAcceleration!=='required'
    || !Number.isInteger(encoding.videoBitrateKbps) || encoding.videoBitrateKbps<1000 || encoding.videoBitrateKbps>4000) {
    throw Error('Invalid required hardware motion encoding settings');
  }
  return {codec:'h264',hardwareAcceleration:'required',videoBitrate:`${encoding.videoBitrateKbps}k`,crf:null,x264Preset:null};
}

export function motionEncodingReport(metadata,bytes,legacyOverrides,{requireHardware=true}={}) {
  const budget=uploadEncodingReport(metadata,bytes,legacyOverrides);
  const video=metadata?.streams?.find(stream=>stream.codec_type==='video');
  const encoderTag=typeof video?.tags?.encoder==='string'?video.tags.encoder.trim():'';
  const software=/\blibx264\b/i.test(encoderTag);
  const hardware=video?.codec_name==='h264' && /\bh264_videotoolbox\b/i.test(encoderTag) && !software;
  const encoder=hardware?hardwareEncoder:software?'libx264':encoderTag || 'unknown';
  if(requireHardware && !hardware) {
    throw Error('Required hardware encoding was not verified: expected H.264 with an h264_videotoolbox encoder tag');
  }
  return {...budget,settings:hardware?resolveMotionHardwareEncoding(legacyOverrides):budget.settings,
    encoder,encoderTag:encoderTag || null};
}
