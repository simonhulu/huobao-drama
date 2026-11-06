import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir, rename, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {assertApproved, digest, fileHash, readJson, writeJson} from './core.mjs';

import {selectedEditions} from './editions.mjs';

const exec = promisify(execFile);

function narrationFailureMessage(error) {
  const causes = [];
  for (let current = error; current && causes.length < 4; current = current.cause) {
    causes.push(String(current.message || current));
  }
  return causes.join(' → ').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:Bearer\s+|Basic\s+|sk-)[A-Za-z0-9+/._=-]+/gi, '[已隐藏]')
    .replace(/(["']?(?:api[_-]?key|authorization|token|secret|cookie|password)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g, '[链接已隐藏]').slice(-1800);
}

async function probeAudio(file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`Generated audio is missing or empty: ${file}`);
  let data;
  try {
    const {stdout} = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,sample_rate,channels',
      '-of', 'json', file,
    ], {timeout: 30_000, maxBuffer: 1024 * 1024});
    data = JSON.parse(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('ffprobe is missing; install FFmpeg before generating narration.');
    throw new Error(`Generated audio is invalid: ${file}. ${error.stderr?.trim() || error.message}`);
  }
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(audio?.duration ?? data.format?.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0 || !(Number(audio.sample_rate) > 0) || !(Number(audio.channels) > 0)) {
    throw new Error(`Generated file has no valid audio stream with positive duration: ${file}`);
  }
  return {duration};
}

async function reusable(segment, request) {
  if (segment.audioDigest?.request !== request || !segment.audioPath || !segment.audioDigest.sha256) return false;
  try {
    if (await fileHash(segment.audioPath) !== segment.audioDigest.sha256) return false;
    await probeAudio(segment.audioPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate real audio for approved narration segments, saving each completed
 * segment before starting the next. The caller supplies the existing provider
 * and owns the job lock. This module does not import or call a paid service.
 */
export async function generateNarrations({jobDir, generate, storageRoot}) {
  const directory = path.resolve(jobDir);
  const jobFile = path.join(directory, 'job.json');
  const job = readJson(jobFile);
  await assertApproved(job);
  if (!selectedEditions(job).includes('news')) return {generated: [], reused: [], skipped: []};
  if (typeof generate !== 'function') throw new Error('A narration generator function is required.');
  if (!storageRoot || typeof storageRoot !== 'string') throw new Error('storageRoot is required to locate the generated audio.');

  const audioDir = path.join(directory, 'audio');
  const generated = [], reused = [], skipped = [];
  for (const segment of job.news.segments) {
    if (segment.mode === 'original') {
      skipped.push(segment.id);
      continue;
    }
    const request = digest({text: segment.text, tts: job.tts});
    if (await reusable(segment, request)) {
      reused.push(segment.id);
      continue;
    }
    // Detect a missing FFmpeg installation before making a paid request.
    try {
      await exec('ffprobe', ['-version'], {timeout: 10_000, maxBuffer: 1024 * 1024});
    } catch (error) {
      throw new Error(`ffprobe is unavailable; install FFmpeg before generating narration. ${error.message}`);
    }
    let temporary;
    try {
      const result = await generate({
        ...job.tts, text: segment.text, subtitleEnable: true, subtitleType: 'sentence',
      });
      if (typeof result?.audioUrl !== 'string' || !result.audioUrl.trim()) {
        throw new Error('The narration provider returned no audioUrl.');
      }
      const filename = path.basename(decodeURIComponent(new URL(result.audioUrl, 'http://local.invalid/').pathname));
      if (!filename || filename === '.' || filename === '..') throw new Error('The narration provider returned an invalid audio filename.');
      const source = path.join(path.resolve(storageRoot), 'audio', filename);
      await probeAudio(source);
      await mkdir(audioDir, {recursive: true});
      const destination = path.join(audioDir, `${segment.id}-${request.slice(0, 12)}${path.extname(filename) || '.audio'}`);
      temporary = path.join(audioDir, `.${segment.id}-${randomUUID()}.partial`);
      await copyFile(source, temporary);
      const {duration} = await probeAudio(temporary);
      const sha256 = await fileHash(temporary);
      await rename(temporary, destination);
      temporary = null;
      const audioDigest = {request, sha256, duration};
      if (Array.isArray(result.titles) && result.titles.length) {
        audioDigest.titlesPath = `${destination}.titles.json`;
        writeJson(audioDigest.titlesPath, result.titles);
      }
      segment.audioPath = destination;
      segment.audioDigest = audioDigest;
      // A newly generated track may differ from the one used in prior exports.
      job.outputs = null;
      job.status = 'approved';
      writeJson(jobFile, job);
      generated.push(segment.id);
    } catch (error) {
      const message = `Narration ${segment.id} failed: ${narrationFailureMessage(error)}`;
      writeJson(path.join(directory, 'narration-error.json'), {
        failedAt: new Date().toISOString(), segmentId: segment.id, requestDigest: request,
        configId: job.tts?.configId, message,
      });
      throw new Error(message);
    } finally {
      if (temporary) await rm(temporary, {force: true});
    }
  }
  await rm(path.join(directory, 'narration-error.json'), {force: true});
  return {job, generated, reused, skipped};
}
