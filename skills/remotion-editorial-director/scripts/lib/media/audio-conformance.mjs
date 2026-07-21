import {spawn} from 'node:child_process';

const codedError = (code, message) => Object.assign(new Error(message), {code});

const run = (command, args, {signal} = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {shell: false, stdio: ['ignore', 'pipe', 'pipe']});
  const stdout = [];
  const stderr = [];
  const onAbort = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', onAbort, {once: true});
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', (exitCode) => {
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) {
      reject(Object.assign(codedError('CANCELLED', `${command} cancelled`), {exitCode: 130}));
      return;
    }
    const result = {
      exitCode,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
    };
    if (exitCode === 0) resolve(result);
    else reject(Object.assign(codedError('MEDIA_COMMAND_FAILED', `${command} exited ${exitCode}`), result));
  });
});

export const expectedAudioSamples = ({durationInFrames, fps, sampleRate = 48000}) => {
  if (!Number.isSafeInteger(durationInFrames) || durationInFrames <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw codedError('INVALID_AUDIO_TIMELINE', 'Audio timeline requires positive frames and fps');
  }
  const samples = durationInFrames * sampleRate / fps;
  if (!Number.isSafeInteger(samples)) {
    throw codedError(
      'AUDIO_SAMPLE_COUNT_NON_INTEGER',
      `Timeline does not map to a whole ${sampleRate} Hz sample count`,
    );
  }
  return samples;
};

export const buildAudioConformArgs = ({
  durationInFrames,
  fps,
  inputPath,
  outputPath,
  sampleRate = 48000,
  channels = 2,
}) => {
  const samples = expectedAudioSamples({durationInFrames, fps, sampleRate});
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', inputPath,
    '-vn', '-ac', String(channels), '-ar', String(sampleRate),
    '-af', `aresample=${sampleRate}:async=0:first_pts=0,apad,atrim=end_sample=${samples}`,
    '-c:a', 'pcm_s16le', outputPath,
  ];
};

export const conformNarration = async ({
  durationInFrames,
  fps,
  inputPath,
  outputPath,
  sampleRate = 48000,
  channels = 2,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  signal,
}) => {
  const expectedSamples = expectedAudioSamples({durationInFrames, fps, sampleRate});
  await run(ffmpegPath, buildAudioConformArgs({
    channels,
    durationInFrames,
    fps,
    inputPath,
    outputPath,
    sampleRate,
  }), {signal});
  const probe = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,duration_ts,time_base',
    '-of', 'json',
    outputPath,
  ], {signal});
  let stream;
  try {
    [stream] = JSON.parse(probe.stdout).streams;
  } catch (error) {
    throw Object.assign(codedError('AUDIO_PROBE_INVALID', 'ffprobe returned invalid audio metadata'), {
      cause: error,
    });
  }
  const [timeBaseNumerator, timeBaseDenominator] = String(stream.time_base)
    .split('/')
    .map(Number);
  const observedSampleRate = Number(stream.sample_rate);
  const sampleCount = Number(stream.duration_ts) * timeBaseNumerator /
    timeBaseDenominator * observedSampleRate;
  if (
    stream.codec_name !== 'pcm_s16le' ||
    observedSampleRate !== sampleRate ||
    Number(stream.channels) !== channels ||
    !Number.isSafeInteger(sampleCount) ||
    sampleCount !== expectedSamples
  ) {
    throw Object.assign(codedError('AUDIO_CONFORMANCE_FAILED', 'Conformed audio did not match exact PCM policy'), {
      observed: {sampleCount, stream},
      expected: {channels, codec: 'pcm_s16le', sampleCount: expectedSamples, sampleRate},
    });
  }
  return {
    channels,
    codec: stream.codec_name,
    outputPath,
    sampleCount,
    sampleRate: observedSampleRate,
  };
};
