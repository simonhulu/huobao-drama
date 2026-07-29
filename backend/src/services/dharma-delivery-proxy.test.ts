import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDharmaDeliveryProxyCacheKey,
  buildDharmaDeliveryProxyFfmpegArgs,
  getDharmaDeliveryProxyPath,
  isDharmaDeliveryProxyCacheChild,
  isDharmaDeliveryDurationCompatible,
  isDharmaDeliveryProxyRequired,
  isDharmaDeliverySourceChromeSafe,
  isValidDharmaDeliveryProxy,
  selectDharmaDeliveryProxyEncoders,
  type DharmaVideoProbe,
} from './dharma-delivery-proxy.js'

const validProxy: DharmaVideoProbe = {
  streams: [
    {
      codecType: 'video',
      codecName: 'h264',
      width: 1280,
      height: 720,
      pixelFormat: 'yuv420p',
    },
  ],
}

test('Dharma delivery proxy cache key is stable for one source identity and changes when it changes', () => {
  const first = buildDharmaDeliveryProxyCacheKey('/private/stock/temple.mp4', 5_000_000, 1_722_146_123_456.789)
  assert.equal(first, buildDharmaDeliveryProxyCacheKey('/private/stock/temple.mp4', 5_000_000, 1_722_146_123_456.789))
  assert.notEqual(first, buildDharmaDeliveryProxyCacheKey('/private/stock/temple.mp4', 5_000_001, 1_722_146_123_456.789))
  assert.notEqual(first, buildDharmaDeliveryProxyCacheKey('/private/stock/temple.mp4', 5_000_000, 1_722_146_123_456.790))
  assert.notEqual(first, buildDharmaDeliveryProxyCacheKey('/private/stock/other.mp4', 5_000_000, 1_722_146_123_456.789))
})

test('Dharma delivery proxy cache paths stay in the configured cache directory', () => {
  const key = buildDharmaDeliveryProxyCacheKey('/private/stock/temple.mp4', 5_000_000, 1_722_146_123_456)
  const cacheDirectory = '/var/tmp/dharma-cache'
  const proxyPath = getDharmaDeliveryProxyPath(cacheDirectory, key)
  assert.equal(isDharmaDeliveryProxyCacheChild(cacheDirectory, proxyPath), true)
  assert.equal(isDharmaDeliveryProxyCacheChild(cacheDirectory, '/var/tmp/not-dharma-cache/file.mp4'), false)
  assert.throws(() => getDharmaDeliveryProxyPath(cacheDirectory, '../escape'), /cache key 无效/)
})

test('Dharma delivery proxy only transcodes sources beyond the 1280x720 delivery ceiling', () => {
  assert.equal(isDharmaDeliveryProxyRequired({ width: 1280, height: 720 }), false)
  assert.equal(isDharmaDeliveryProxyRequired({ width: 720, height: 1280 }), true)
  assert.equal(isDharmaDeliveryProxyRequired({ width: 1920, height: 1080 }), true)
  assert.equal(isDharmaDeliveryProxyRequired({ width: 1279, height: 719 }), false)
})

test('Dharma delivery proxy also conforms small incompatible sources for Chrome decode', () => {
  assert.equal(isDharmaDeliverySourceChromeSafe({
    streams: [{ codecType: 'video', codecName: 'h264', width: 1280, height: 720, pixelFormat: 'yuv420p' }],
  }), true)
  assert.equal(isDharmaDeliverySourceChromeSafe({
    streams: [{ codecType: 'video', codecName: 'hevc', width: 1280, height: 720, pixelFormat: 'yuv420p10le' }],
  }), false)
  assert.equal(isDharmaDeliveryDurationCompatible(20, 20.12), true)
  assert.equal(isDharmaDeliveryDurationCompatible(20, 20.5), false)
})

test('Dharma delivery proxy validation accepts only a 1280x720 video-only H.264 yuv420p file', () => {
  assert.equal(isValidDharmaDeliveryProxy(validProxy), true)
  assert.equal(isValidDharmaDeliveryProxy({
    streams: [...validProxy.streams, { codecType: 'audio', codecName: 'aac' }],
  }), false)
  assert.equal(isValidDharmaDeliveryProxy({
    streams: [{ ...validProxy.streams[0], width: 1279 }],
  }), false)
  assert.equal(isValidDharmaDeliveryProxy({
    streams: [{ ...validProxy.streams[0], codecName: 'hevc' }],
  }), false)
  assert.equal(isValidDharmaDeliveryProxy({
    streams: [{ ...validProxy.streams[0], pixelFormat: 'yuvj420p' }],
  }), false)
})

test('Dharma delivery proxy tries VideoToolbox only when macOS has advertised it, then retains libx264 fallback', () => {
  assert.deepEqual(selectDharmaDeliveryProxyEncoders('darwin', true), ['h264_videotoolbox', 'libx264'])
  assert.deepEqual(selectDharmaDeliveryProxyEncoders('darwin', false), ['libx264'])
  assert.deepEqual(selectDharmaDeliveryProxyEncoders('linux', true), ['libx264'])
})

test('Dharma delivery proxy ffmpeg command makes an exact video-only yuv420p delivery file', () => {
  const args = buildDharmaDeliveryProxyFfmpegArgs('/input/original.mov', '/cache/proxy.tmp.mp4', 'libx264')
  assert.deepEqual(args.slice(0, 6), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i'])
  assert.ok(args.includes('-map'))
  assert.ok(args.includes('0:v:0'))
  assert.ok(args.includes('-an'))
  assert.ok(args.includes('-pix_fmt'))
  assert.ok(args.includes('yuv420p'))
  assert.ok(args.some((arg) => arg.includes('scale=1280:720')))
  assert.ok(args.some((arg) => arg.includes('pad=1280:720')))
  assert.equal(args.at(-1), '/cache/proxy.tmp.mp4')
})
