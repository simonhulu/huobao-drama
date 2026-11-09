import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { getVideoEncoderOptions } from './video-encoder.js'

test('Intel Macs use bitrate control without unsupported VideoToolbox qscale', t => {
  t.mock.method(os, 'platform', () => 'darwin')
  t.mock.method(os, 'arch', () => 'x64')
  const args = getVideoEncoderOptions({ width: 1920, height: 1080 })
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_videotoolbox')
  assert.ok(args.includes('-b:v'))
  assert.ok(!args.includes('-q:v'))
})

test('Apple Silicon retains its supported quality setting', t => {
  t.mock.method(os, 'platform', () => 'darwin')
  t.mock.method(os, 'arch', () => 'arm64')
  const args = getVideoEncoderOptions({ width: 1920, height: 1080 })
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_videotoolbox')
  assert.equal(args[args.indexOf('-q:v') + 1], process.env.VIDEO_QUALITY ?? '65')
})

test('other platforms retain libx264 encoding', t => {
  t.mock.method(os, 'platform', () => 'linux')
  t.mock.method(os, 'arch', () => 'x64')
  const args = getVideoEncoderOptions({ width: 1920, height: 1080 })
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264')
  assert.ok(args.includes('-crf'))
  assert.ok(!args.includes('-q:v'))
})
