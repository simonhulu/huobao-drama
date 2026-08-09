#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProject8FullSoundMixPlan} from './build_project8_full_sound_mix_plan.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const DEFAULT_MIX_PLAN = path.join(root, 'data/temp/project-8-full-sound-mix-plan.json');
const DEFAULT_MASTER = path.join(root, 'data/static/audio/6c4b1c81-8508-42fc-ba42-7bdae682648d_pre_episode591.mp3');
const DEFAULT_OUTPUT = path.join(root, 'data/static/audio/project-8-full-storyboard-soundtrack.m4a');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(root, process.argv[index + 1]) : fallback;
}

function seconds(ms) {
  return (ms / 1000).toFixed(3);
}

function audioFilter(track, inputIndex, outputLabel, totalSeconds) {
  const duration = Math.max(0.02, (track.endMs - track.startMs) / 1000).toFixed(3);
  const delay = Math.max(0, Math.round(track.startMs));
  const fades = track.fadeMs ? `,afade=t=in:st=0:d=${seconds(track.fadeMs)},afade=t=out:st=${Math.max(0, (track.endMs - track.startMs - track.fadeMs) / 1000).toFixed(3)}:d=${seconds(track.fadeMs)}` : '';
  return `[${inputIndex}:a]atrim=start=0:end=${duration},volume=${track.volume.toFixed(3)}${fades},adelay=${delay}:all=1,apad=whole_dur=${totalSeconds}[${outputLabel}]`;
}

export function buildMixCommand({masterPath, mixPlan, outputPath}) {
  validateProject8FullSoundMixPlan(mixPlan);
  if (!existsSync(masterPath)) throw new Error(`Narration master is missing: ${masterPath}`);
  const totalSeconds = seconds(mixPlan.durationMs);
  const tracks = [...mixPlan.bgmTracks, ...mixPlan.soundCues];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', masterPath];
  for (const track of tracks) {
    if (track.loop) args.push('-stream_loop', '-1');
    args.push('-i', track.absolutePath);
  }
  const bgmLabels = [];
  const sfxLabels = [];
  const filters = [`[0:a]atrim=start=0:end=${totalSeconds},aresample=48000[narration]`];
  tracks.forEach((track, index) => {
    const label = `track${index}`;
    filters.push(audioFilter(track, index + 1, label, totalSeconds));
    if (track.role === 'bgm') bgmLabels.push(`[${label}]`);
    else sfxLabels.push(`[${label}]`);
  });
  if (bgmLabels.length) {
    filters.push(`${bgmLabels.join('')}amix=inputs=${bgmLabels.length}:duration=first:dropout_transition=0:normalize=0[bgm]`);
    filters.push('[bgm][narration]sidechaincompress=threshold=0.025:ratio=10:attack=18:release=320[ducked_bgm]');
  } else {
    filters.push('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=start=0:end=' + totalSeconds + '[ducked_bgm]');
  }
  if (sfxLabels.length) filters.push(`${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=first:dropout_transition=0:normalize=0[sfx]`);
  else filters.push('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=start=0:end=' + totalSeconds + '[sfx]');
  filters.push(`[narration][ducked_bgm][sfx]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95,atrim=start=0:end=${totalSeconds},aresample=48000[mix]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[mix]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', outputPath);
  return args;
}

export function renderSoundtrack({masterPath, mixPlan, outputPath}) {
  mkdirSync(path.dirname(outputPath), {recursive: true});
  execFileSync('ffmpeg', buildMixCommand({masterPath, mixPlan, outputPath}), {stdio: 'inherit'});
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath], {encoding: 'utf8'}));
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  if (!audio || audio.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000) throw new Error('Soundtrack did not produce one AAC 48kHz stream');
  return {outputPath, durationSeconds: Number(probe.format?.duration), codec: audio.codec_name, sampleRate: Number(audio.sample_rate)};
}

function main() {
  const mixPlan = JSON.parse(readFileSync(argument('--mix-plan', DEFAULT_MIX_PLAN), 'utf8'));
  const result = renderSoundtrack({masterPath: argument('--master', DEFAULT_MASTER), mixPlan, outputPath: argument('--output', DEFAULT_OUTPUT)});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
