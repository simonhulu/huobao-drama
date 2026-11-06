import {spawn} from 'node:child_process';
import {open, stat, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const bridgePath = fileURLToPath(new URL('./highlighter_bridge.py', import.meta.url));

async function requireFile(filename, description) {
  const resolved = path.resolve(filename);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`${description} does not exist or is empty: ${resolved}`);
  }
  return resolved;
}

function capture(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8000); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

function frameRate(value) {
  const [numerator, denominator = '1'] = String(value ?? '').split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/** Probe a local recording without changing it. ffprobe must be on PATH. */
export async function probeMedia(filename) {
  const input = await requireFile(filename, 'Video file');
  let output;
  try {
    output = await capture('ffprobe', [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', input,
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('ffprobe is missing. Install FFmpeg and put ffprobe on PATH.');
    throw new Error(`Cannot probe recording ${input}: ${error.message}`);
  }
  const data = JSON.parse(output);
  const video = data.streams?.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const duration = Number(data.format?.duration ?? video?.duration);
  const width = Number(video?.width);
  const height = Number(video?.height);
  const fps = frameRate(video?.avg_frame_rate) || frameRate(video?.r_frame_rate);
  if (!video || !Number.isFinite(duration) || duration <= 0 || !(width > 0 && height > 0 && fps > 0)) {
    throw new Error(`Recording has no usable video stream or finite duration: ${input}`);
  }
  return {duration, width, height, fps, hasAudio: data.streams.some((stream) => stream.codec_type === 'audio')};
}

async function runBridge(pythonPath, args, {cwd, logPath, timeoutMs}) {
  const log = await open(logPath, 'w');
  try {
    await new Promise((resolve, reject) => {
      // A process group lets a timeout also stop FFmpeg subprocesses on POSIX.
      const child = spawn(pythonPath, args, {
        cwd, detached: process.platform !== 'win32',
        stdio: ['ignore', log.fd, log.fd],
        env: {...process.env, PYTHONUNBUFFERED: '1'},
      });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* The child may already have exited. */ }
      }, timeoutMs);
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (timedOut) reject(new Error(`Analysis exceeded ${Math.round(timeoutMs / 1000)} seconds`));
        else if (code !== 0) reject(new Error(`Analysis exited with ${signal ?? code}`));
        else resolve();
      });
    });
  } catch (error) {
    const detail = (await readFile(logPath, 'utf8').catch(() => '')).slice(-5000).trim();
    throw new Error(`VideoHighlighter failed: ${error.message}. Check ${logPath}. ${detail}`, {cause: error});
  } finally {
    await log.close();
  }
}

/**
 * Invoke the real upstream pipeline in report_only mode. Returned timestamps
 * always refer to the original recording. A score is not event verification.
 * config uses upstream gui_config keys (scene_points, clip_time, etc.).
 */
export async function runHighlighter({
  input, outputDir, repoPath = process.env.VIDEOHIGHLIGHTER_REPO,
  pythonPath = process.env.VIDEOHIGHLIGHTER_PYTHON || 'python3',
  config = {}, timeoutMs = 2 * 60 * 60 * 1000,
}) {
  if (!repoPath) throw new Error('Set VIDEOHIGHLIGHTER_REPO or pass repoPath for a VideoHighlighter source checkout.');
  if (!outputDir) throw new Error('An outputDir is required for VideoHighlighter reports and logs.');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Highlighter config must be an object.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.');
  if (config.use_time_range) throw new Error('use_time_range is unsupported: candidate timecodes must refer to the original recording.');
  const source = await requireFile(input, 'Video file');
  const repository = path.resolve(repoPath);
  await requireFile(path.join(repository, 'pipeline.py'), 'VideoHighlighter pipeline.py');
  const metadata = await probeMedia(source);
  const destination = path.resolve(outputDir);
  await mkdir(destination, {recursive: true});
  const runDir = await mkdtemp(path.join(destination, 'run-'));
  const requestPath = path.join(runDir, 'request.json');
  const resultPath = path.join(runDir, 'candidates.json');
  const logPath = path.join(runDir, 'analysis.log');
  await writeFile(requestPath, JSON.stringify({
    input: source, repoPath: repository, runDir,
    cacheDir: path.join(destination, 'cache'), config,
  }, null, 2));
  await runBridge(pythonPath, [bridgePath, '--request', requestPath, '--result', resultPath], {
    cwd: repository, logPath, timeoutMs,
  });
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  if (!Array.isArray(result.clips)) throw new Error(`Invalid VideoHighlighter result: ${resultPath}`);
  for (const clip of result.clips) {
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 ||
        clip.end <= clip.start || clip.end > metadata.duration + 0.1) {
      throw new Error(`Invalid candidate timecode in ${resultPath}; inspect the upstream report before continuing.`);
    }
    clip.semanticVerified = false;
  }
  return {
    ...result, input: source, metadata, semanticVerified: false,
    artifacts: [...new Set([requestPath, resultPath, logPath, ...(result.artifacts || [])])],
  };
}
