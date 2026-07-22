import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandTelemetryRuns,
  inspectTelemetryPackets,
} from '../../scripts/lib/media/telemetry-inspect.mjs';

const manifest = {
  frameCount: 3,
  height: 720,
  layers: [{endFrame: 3, layerId: 'shot:s1:background', startFrame: 0}],
  maxLayersPerFrame: 2,
  maxPacketBytes: 2048,
  maxTotalBytes: 8192,
  operationId: 'render-1',
  width: 1280,
};

const packet = (frame, translateX = frame) => ({
  frame,
  layers: [{
    bounds: {height: 720, width: 1280, x: 0, y: 0},
    decodeStatus: 'ready',
    interval: {endFrame: 3, startFrame: 0},
    layerId: 'shot:s1:background',
    maskBounds: null,
    opacity: 1,
    sourceAssetId: 'asset-1',
    transform: {rotationDegrees: 0, scaleX: 1, scaleY: 1, translateX, translateY: 0},
  }],
  operationId: 'render-1',
  version: 1,
});

test('telemetry inspection sorts retries and emits lossless half-open RLE', () => {
  const packets = [packet(2, 1), packet(0, 0), packet(1, 1), packet(1, 1)];
  const result = inspectTelemetryPackets({manifest, packets});
  assert.equal(result.duplicatePackets, 1);
  assert.deepEqual(result.frames.map(({frame}) => frame), [0, 1, 2]);
  assert.deepEqual(
    result.runsByLayer['shot:s1:background'].map(({startFrame, endFrame}) => ({startFrame, endFrame})),
    [{startFrame: 0, endFrame: 1}, {startFrame: 1, endFrame: 3}],
  );
  assert.deepEqual(expandTelemetryRuns(result.runsByLayer), result.frames);
});

test('telemetry inspection rejects conflicting retries, missing frames, and overrun', () => {
  assert.throws(
    () => inspectTelemetryPackets({manifest, packets: [packet(0), packet(1), packet(1, 9), packet(2)]}),
    (error) => error.code === 'TELEMETRY_CONFLICTING_RETRY',
  );
  assert.throws(
    () => inspectTelemetryPackets({manifest, packets: [packet(0), packet(2)]}),
    (error) => error.code === 'TELEMETRY_FRAME_MISSING',
  );
  assert.throws(
    () => inspectTelemetryPackets({
      manifest: {...manifest, maxPacketBytes: 10},
      packets: [packet(0), packet(1), packet(2)],
    }),
    (error) => error.code === 'TELEMETRY_PACKET_LIMIT',
  );
});

test('telemetry inspection rejects invalid operation, geometry, visibility, and decode samples', () => {
  const wrongOperation = {...packet(0), operationId: 'other'};
  assert.throws(
    () => inspectTelemetryPackets({manifest, packets: [wrongOperation, packet(1), packet(2)]}),
    (error) => error.code === 'TELEMETRY_OPERATION_MISMATCH',
  );
  const badGeometry = packet(0);
  badGeometry.layers[0].bounds.x = -1;
  assert.throws(
    () => inspectTelemetryPackets({manifest, packets: [badGeometry, packet(1), packet(2)]}),
    (error) => error.code === 'TELEMETRY_GEOMETRY_INVALID',
  );
  const missingLayer = {...packet(0), layers: []};
  assert.throws(
    () => inspectTelemetryPackets({manifest, packets: [missingLayer, packet(1), packet(2)]}),
    (error) => error.code === 'TELEMETRY_LAYER_COVERAGE',
  );
  const failedDecode = packet(0);
  failedDecode.layers[0].decodeStatus = 'error';
  assert.throws(
    () => inspectTelemetryPackets({manifest, packets: [failedDecode, packet(1), packet(2)]}),
    (error) => error.code === 'TELEMETRY_ASSET_DECODE_FAILED',
  );
});
