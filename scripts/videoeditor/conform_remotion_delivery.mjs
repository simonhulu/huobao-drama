#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {existsSync, renameSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

function parseRatio(value) {
  const [numerator, denominator = '1'] = String(value ?? '').split('/').map(Number);
  return denominator ? numerator / denominator : Number.NaN;
}

function readFrameCount(stream) {
  const value = stream.nb_read_frames ?? stream.nb_frames;
  const frames = Number(value);
  return Number.isSafeInteger(frames) && frames > 0 ? frames : null;
}

export function probeDelivery(filePath) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    filePath,
  ], {encoding: 'utf8'}));
}

export function verifyDeliveryProbe(payload, expected) {
  const videos = (payload.streams ?? []).filter((stream) => stream.codec_type === 'video');
  const audios = (payload.streams ?? []).filter((stream) => stream.codec_type === 'audio');
  if (videos.length !== 1) throw new Error(`Delivery must contain exactly one video stream, got ${videos.length}`);
  if (audios.length !== 1) throw new Error(`Delivery must contain exactly one audio stream, got ${audios.length}`);
  const video = videos[0];
  const audio = audios[0];
  const fps = parseRatio(video.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video.r_frame_rate);
  const frames = readFrameCount(video);
  if (video.codec_name !== 'h264') throw new Error(`Delivery video codec must be h264, got ${video.codec_name}`);
  if (Number(video.width) !== expected.width || Number(video.height) !== expected.height) {
    throw new Error(`Delivery dimensions must be ${expected.width}x${expected.height}, got ${video.width}x${video.height}`);
  }
  if (!Number.isFinite(fps) || Math.abs(fps - expected.fps) > 1e-6) throw new Error(`Delivery fps must be ${expected.fps}, got ${fps}`);
  if (frames !== expected.frames) throw new Error(`Delivery frame count must be ${expected.frames}, got ${frames ?? 'unknown'}`);
  if (video.pix_fmt !== 'yuv420p') throw new Error(`Delivery pixel format must be yuv420p, got ${video.pix_fmt}`);
  if (video.color_range !== 'tv') throw new Error(`Delivery color range must be limited/tv, got ${video.color_range ?? 'unknown'}`);
  if (audio.codec_name !== 'aac') throw new Error(`Delivery audio codec must be AAC, got ${audio.codec_name}`);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps,
    frames,
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    colorRange: video.color_range,
    audioCodec: audio.codec_name,
    audioChannels: Number(audio.channels),
    audioSampleRate: Number(audio.sample_rate),
  };
}

function audioPacketHash(filePath) {
  const output = execFileSync('ffmpeg', [
    '-v', 'error',
    '-i', filePath,
    '-map', '0:a:0',
    '-c:a', 'copy',
    '-f', 'hash',
    '-hash', 'sha256',
    '-',
  ], {encoding: 'utf8'}).trim();
  const match = output.match(/SHA256=([a-f0-9]{64})/iu);
  if (!match) throw new Error(`Unable to hash AAC packets in ${filePath}`);
  return match[1].toLowerCase();
}

export function conformRemotionDelivery({input, output, width = 1280, height = 720, fps = 30, frames = 2670}) {
  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  if (inputPath === outputPath) throw new Error('Input and output paths must differ for atomic delivery conformance');
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.partial-${process.pid}.mp4`);
  const expected = {width, height, fps, frames};
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  const inputAudioHash = audioPacketHash(inputPath);
  try {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-vf', 'scale=out_range=tv,setparams=range=tv',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '17',
      '-x264-params', 'range=tv',
      '-pix_fmt', 'yuv420p',
      '-color_range', 'tv',
      '-bsf:v', 'h264_metadata=video_full_range_flag=0',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      temporaryPath,
    ], {stdio: 'inherit'});
    const verification = verifyDeliveryProbe(probeDelivery(temporaryPath), expected);
    const outputAudioHash = audioPacketHash(temporaryPath);
    if (outputAudioHash !== inputAudioHash) {
      throw new Error(`AAC packet hash changed during delivery conformance: ${inputAudioHash} != ${outputAudioHash}`);
    }
    renameSync(temporaryPath, outputPath);
    return {inputPath, outputPath, audioPacketSha256: outputAudioHash, ...verification};
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = argumentValue('--input');
  const output = argumentValue('--output');
  if (!input || !output) throw new Error('--input <render.mp4> and --output <delivery.mp4> are required');
  const result = conformRemotionDelivery({
    input,
    output,
    width: Number(argumentValue('--width') ?? 1280),
    height: Number(argumentValue('--height') ?? 720),
    fps: Number(argumentValue('--fps') ?? 30),
    frames: Number(argumentValue('--frames') ?? 2670),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
