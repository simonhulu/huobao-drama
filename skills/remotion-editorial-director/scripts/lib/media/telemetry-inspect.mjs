import {canonicalizePayload} from '../canonical-json.mjs';

const codedError = (code, message, details = {}) => Object.assign(new Error(message), {
  category: 6,
  code,
  exitCode: 6,
  ...details,
});

const same = (left, right) => canonicalizePayload(left) === canonicalizePayload(right);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const validateBounds = (bounds, width, height, label) => {
  if (
    bounds === null || typeof bounds !== 'object' ||
    !finite(bounds.x) || !finite(bounds.y) ||
    !finite(bounds.width) || !finite(bounds.height) ||
    bounds.x < 0 || bounds.y < 0 || bounds.width < 0 || bounds.height < 0 ||
    bounds.x + bounds.width > width || bounds.y + bounds.height > height
  ) {
    throw codedError('TELEMETRY_GEOMETRY_INVALID', `Invalid ${label} bounds`);
  }
};

const validateSample = (sample, declared, manifest) => {
  if (!declared || !same(sample.interval, {
    endFrame: declared.endFrame,
    startFrame: declared.startFrame,
  })) {
    throw codedError('TELEMETRY_LAYER_INTERVAL_MISMATCH', `Invalid interval for ${sample.layerId}`);
  }
  validateBounds(sample.bounds, manifest.width, manifest.height, sample.layerId);
  if (sample.maskBounds !== null && sample.maskBounds !== undefined) {
    validateBounds(sample.maskBounds, manifest.width, manifest.height, `${sample.layerId} mask`);
  }
  if (!finite(sample.opacity) || sample.opacity < 0 || sample.opacity > 1) {
    throw codedError('TELEMETRY_STYLE_INVALID', `Invalid opacity for ${sample.layerId}`);
  }
  const transform = sample.transform;
  if (
    transform === null || typeof transform !== 'object' ||
    !['translateX', 'translateY', 'scaleX', 'scaleY', 'rotationDegrees']
      .every((field) => finite(transform[field]))
  ) {
    throw codedError('TELEMETRY_STYLE_INVALID', `Invalid transform for ${sample.layerId}`);
  }
  if (sample.sourceAssetId && sample.decodeStatus !== 'ready') {
    throw codedError(
      'TELEMETRY_ASSET_DECODE_FAILED',
      `Asset ${sample.sourceAssetId} did not decode for ${sample.layerId}`,
    );
  }
};

const compressFrames = (frames) => {
  const runsByLayer = {};
  for (const {frame, layers} of frames) {
    for (const sample of layers) {
      const runs = runsByLayer[sample.layerId] ??= [];
      const previous = runs.at(-1);
      if (previous && previous.endFrame === frame && same(previous.sample, sample)) {
        previous.endFrame = frame + 1;
      } else {
        runs.push({endFrame: frame + 1, sample, startFrame: frame});
      }
    }
  }
  return runsByLayer;
};

export const inspectTelemetryPackets = ({manifest, packets}) => {
  const declaredLayers = new Map();
  for (const layer of manifest.layers) {
    if (declaredLayers.has(layer.layerId)) {
      throw codedError('TELEMETRY_LAYER_DUPLICATE', `Duplicate manifest layer ${layer.layerId}`);
    }
    declaredLayers.set(layer.layerId, layer);
  }
  const packetsByFrame = new Map();
  let duplicatePackets = 0;
  let totalBytes = 0;
  for (const packet of packets) {
    const packetBytes = Buffer.byteLength(JSON.stringify(packet));
    totalBytes += packetBytes;
    if (packetBytes > manifest.maxPacketBytes || totalBytes > manifest.maxTotalBytes) {
      throw codedError('TELEMETRY_PACKET_LIMIT', 'Telemetry exceeded its declared byte budget');
    }
    if (packet.operationId !== manifest.operationId) {
      throw codedError('TELEMETRY_OPERATION_MISMATCH', 'Telemetry operation ID mismatch');
    }
    if (!Number.isSafeInteger(packet.frame) || packet.frame < 0 || packet.frame >= manifest.frameCount) {
      throw codedError('TELEMETRY_FRAME_OUT_OF_RANGE', `Invalid telemetry frame ${packet.frame}`);
    }
    if (!Array.isArray(packet.layers) || packet.layers.length > manifest.maxLayersPerFrame) {
      throw codedError('TELEMETRY_LAYER_LIMIT', `Frame ${packet.frame} exceeded its layer budget`);
    }
    const previous = packetsByFrame.get(packet.frame);
    if (previous) {
      if (!same(previous, packet)) {
        throw codedError('TELEMETRY_CONFLICTING_RETRY', `Conflicting retry for frame ${packet.frame}`);
      }
      duplicatePackets += 1;
      continue;
    }
    packetsByFrame.set(packet.frame, packet);
  }

  const frames = [];
  for (let frame = 0; frame < manifest.frameCount; frame += 1) {
    const packet = packetsByFrame.get(frame);
    if (!packet) throw codedError('TELEMETRY_FRAME_MISSING', `Missing telemetry frame ${frame}`);
    const expectedIds = [...declaredLayers.values()]
      .filter(({startFrame, endFrame}) => startFrame <= frame && frame < endFrame)
      .map(({layerId}) => layerId)
      .sort();
    const layers = [...packet.layers].sort((left, right) => left.layerId.localeCompare(right.layerId));
    const actualIds = layers.map(({layerId}) => layerId);
    if (!same(actualIds, expectedIds) || new Set(actualIds).size !== actualIds.length) {
      throw codedError('TELEMETRY_LAYER_COVERAGE', `Layer coverage mismatch at frame ${frame}`);
    }
    for (const sample of layers) validateSample(sample, declaredLayers.get(sample.layerId), manifest);
    frames.push({frame, layers});
  }

  return {
    duplicatePackets,
    frames,
    rawBytes: totalBytes,
    runsByLayer: compressFrames(frames),
  };
};

export const expandTelemetryRuns = (runsByLayer) => {
  const frameMap = new Map();
  for (const runs of Object.values(runsByLayer)) {
    for (const run of runs) {
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
        const layers = frameMap.get(frame) ?? [];
        layers.push(structuredClone(run.sample));
        frameMap.set(frame, layers);
      }
    }
  }
  const lastFrame = Math.max(-1, ...frameMap.keys());
  return Array.from({length: lastFrame + 1}, (_, frame) => ({
    frame,
    layers: (frameMap.get(frame) ?? []).sort((left, right) => left.layerId.localeCompare(right.layerId)),
  }));
};
