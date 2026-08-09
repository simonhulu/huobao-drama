import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DHARMA_VIDEO_ENCODER,
  appendFilterThreadOptions,
  appendLoopedImageInput,
  appendVideoToolboxEncoderOptions,
} from './dharma_ffmpeg_config.mjs'

test('looped image inputs are bounded to the interval duration', () => {
  const args = []
  appendLoopedImageInput(args, '/tmp/state.png', 11.8, 30)
  assert.deepEqual(args, [
    '-loop', '1', '-framerate', '30', '-t', '11.800000', '-i', '/tmp/state.png',
  ])
})

test('Dharma filter graphs use two filter workers', () => {
  const args = []
  appendFilterThreadOptions(args)
  assert.deepEqual(args, ['-filter_threads', '2', '-filter_complex_threads', '2'])
})

test('VideoToolbox encoding is explicit and cannot fall back to software', () => {
  const args = []
  appendVideoToolboxEncoderOptions(args)
  assert.equal(args[args.indexOf('-c:v') + 1], DHARMA_VIDEO_ENCODER)
  assert.deepEqual(args.slice(args.indexOf('-allow_sw'), args.indexOf('-allow_sw') + 2), ['-allow_sw', '0'])
  assert.ok(args.includes('-b:v'), 'hardware quality is controlled by bitrate')
  assert.ok(!args.includes('-crf'), 'CRF is not supported by VideoToolbox')
  assert.ok(!args.includes('-preset'), 'x264 presets must not be passed to VideoToolbox')
  assert.ok(!args.includes('-x264-params'), 'x264-only parameters must not be passed to VideoToolbox')
})
