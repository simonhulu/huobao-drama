import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {probeMedia, runHighlighter} from './media.mjs';

const exec = promisify(execFile);
let directory;
let source;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cba-media-test-'));
  source = path.join(directory, '录像 with spaces.mp4');
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30000/1001:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', source,
  ]);
});

after(async () => {
  if (directory) await rm(directory, {recursive: true, force: true});
});

// Fixtures exercise the documented Python API boundary without ML packages.
// A real-upstream smoke run is separate and must not be inferred from these.
async function fixturePipeline(body) {
  const repoPath = await mkdtemp(path.join(directory, 'upstream-'));
  await mkdir(path.join(repoPath, 'modules', 'vision'), {recursive: true});
  await writeFile(path.join(repoPath, 'modules', 'vision', 'detection_backend.py'),
    'def build_object_detector(*args, **kwargs):\n    raise RuntimeError("unexpected model download")\n');
  await writeFile(path.join(repoPath, 'object_recognition.py'),
    'def directml_detector(*args, **kwargs):\n    raise RuntimeError("unexpected model download")\n');
  await writeFile(path.join(repoPath, 'pipeline.py'), body);
  return repoPath;
}

test('ffprobe reads fractional FPS, dimensions, duration and audio on a real file', async () => {
  const actual = await probeMedia(source);
  assert.equal(actual.width, 320);
  assert.equal(actual.height, 180);
  assert.equal(actual.hasAudio, true);
  assert.ok(Math.abs(actual.fps - 30000 / 1001) < 0.001);
  assert.ok(actual.duration >= 3 && actual.duration < 3.2);
});

test('probe rejects missing, corrupt and audio-only inputs', async () => {
  await assert.rejects(probeMedia(path.join(directory, 'missing.mp4')), /does not exist/);
  const corrupt = path.join(directory, 'corrupt.mp4');
  await writeFile(corrupt, 'not a video');
  await assert.rejects(probeMedia(corrupt), /Cannot probe recording/);
  const audio = path.join(directory, 'audio.wav');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', audio]);
  await assert.rejects(probeMedia(audio), /no usable video stream/);
});

test('bridge uses report_only, extracts scores and preserves source timecodes as unverified candidates', async () => {
  const repoPath = await fixturePipeline(`
import json
from pathlib import Path
def run_highlighter(video_path, sample_rate=5, gui_config=None, log_fn=print):
    from modules.vision.detection_backend import build_object_detector
    from object_recognition import directml_detector
    assert build_object_detector(auto_install=True) == (None, [])
    assert directml_detector() is None
    assert gui_config["report_only"] is True
    assert gui_config["use_time_range"] is False
    assert gui_config["create_timeline_viewer"] is False
    assert gui_config["narrate_clips"] is False
    assert gui_config["use_transcript"] is False
    output = Path(gui_config["output_file"]).with_suffix("")
    Path(str(output) + "_why.json").write_text(json.dumps({"segments": [
        {"start": 1.25, "end": 2.75, "score": 11.5}
    ]}))
    log_fn("fixture: candidates only")
    return [(1.25, 2.75)]
`);
  const result = await runHighlighter({input: source, outputDir: path.join(directory, 'output'), repoPath});
  assert.deepEqual(result.clips, [{start: 1.25, end: 2.75, score: 11.5, semanticVerified: false}]);
  assert.equal(result.semanticVerified, false);
  assert.equal(result.source, 'VideoHighlighter');
  assert.equal(result.metadata.width, 320);
  assert.equal(result.artifacts.length, 4);
  assert.match(result.warnings[0], /verify the game/);
  const log = result.artifacts.find((item) => item.endsWith('analysis.log'));
  assert.match(await readFile(log, 'utf8'), /fixture: candidates only/);
});

test('empty results are explicit and do not claim detected events', async () => {
  const repoPath = await fixturePipeline('def run_highlighter(**kwargs):\n    return []\n');
  const result = await runHighlighter({input: source, outputDir: path.join(directory, 'empty'), repoPath});
  assert.deepEqual(result.clips, []);
  assert.ok(result.warnings.some((warning) => warning.includes('No candidate clips')));
});

test('upstream failure carries its diagnostic and saved log location', async () => {
  const repoPath = await fixturePipeline('def run_highlighter(**kwargs):\n    print("broken decoder")\n    return None\n');
  await assert.rejects(
    runHighlighter({input: source, outputDir: path.join(directory, 'failure'), repoPath}),
    (error) => /VideoHighlighter failed/.test(error.message) && /broken decoder/.test(error.message) && /analysis.log/.test(error.message),
  );
});

test('bridge rejects malformed and out-of-recording candidate timecodes', async () => {
  for (const result of ['"highlight.mp4"', '[(2.5, 9)]', '[(2, 1)]']) {
    const repoPath = await fixturePipeline(`def run_highlighter(**kwargs):\n    return ${result}\n`);
    await assert.rejects(
      runHighlighter({input: source, outputDir: path.join(directory, 'invalid'), repoPath}),
      /Invalid candidate timecode|report-only segment tuples|Invalid upstream time range/,
    );
  }
});

test('trim-relative configurations are rejected before analysis', async () => {
  const repoPath = await fixturePipeline('def run_highlighter(**kwargs):\n    raise Exception("must not run")\n');
  await assert.rejects(
    runHighlighter({input: source, outputDir: path.join(directory, 'trim'), repoPath, config: {use_time_range: true}}),
    /timecodes must refer to the original/,
  );
});

test('missing Python dependency produces an actionable environment error', async () => {
  const repoPath = await fixturePipeline('import missing_cba_test_dependency\n');
  await assert.rejects(
    runHighlighter({input: source, outputDir: path.join(directory, 'dependency'), repoPath}),
    /VIDEOHIGHLIGHTER_PYTHON/,
  );
});

test('an analysis timeout stops the worker and reports the retained log', async () => {
  const repoPath = await fixturePipeline('import time\ndef run_highlighter(**kwargs):\n    time.sleep(10)\n');
  await assert.rejects(
    runHighlighter({input: source, outputDir: path.join(directory, 'timeout'), repoPath, timeoutMs: 100}),
    /Analysis exceeded.*analysis.log/,
  );
});
