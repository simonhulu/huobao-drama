const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});

const sameTarget = (left, right) =>
  ['profileId', 'width', 'height', 'fps'].every((field) => left?.[field] === right?.[field]);

const pixelBox = (box, target) => box === null ? null : ({
  height: box.height * target.height,
  width: box.width * target.width,
  x: box.x * target.width,
  y: box.y * target.height,
});

const pixelPoint = (point, target) => ({
  x: point.x * target.width,
  y: point.y * target.height,
});

const qaSample = ({layer, sample, target}) => ({
  bounds: pixelBox(sample.boundingBox, target),
  decodeStatus: sample.decodeStatus === 'decoded' ? 'ready' : sample.decodeStatus,
  interval: structuredClone(layer.interval),
  kind: layer.kind,
  layerId: layer.layerId,
  maskBounds: pixelBox(sample.maskBounds, target),
  opacity: sample.opacity,
  ...(layer.sourceAsset ? {
    sourceAssetHash: layer.sourceAsset.sha256,
    sourceAssetId: layer.sourceAsset.assetId,
  } : {}),
  transform: {
    rotationDegrees: sample.transform.rotation,
    scaleX: sample.transform.scaleX,
    scaleY: sample.transform.scaleY,
    translateX: sample.transform.translateX,
    translateY: sample.transform.translateY,
  },
  transformOrigin: pixelPoint(sample.transformOrigin, target),
});

export const normalizeLayoutTelemetryForQa = ({telemetry, target}) => {
  if (!sameTarget(telemetry.target, target)) {
    throw codedError('TELEMETRY_TARGET_MISMATCH', 'Layout telemetry target does not match the render target');
  }
  const frames = Array.from({length: telemetry.frameCount}, (_unused, frame) => ({frame, layers: []}));
  const layerIds = new Set();
  const layers = [...telemetry.layers].sort((left, right) => left.layerId.localeCompare(right.layerId));

  for (const layer of layers) {
    if (layerIds.has(layer.layerId)) {
      throw codedError('TELEMETRY_LAYER_DUPLICATE', `Duplicate layout telemetry layer ${layer.layerId}`);
    }
    layerIds.add(layer.layerId);
    const {startFrame, endFrame} = layer.interval;
    if (startFrame >= endFrame || endFrame > telemetry.frameCount) {
      throw codedError('TELEMETRY_LAYER_INTERVAL_INVALID', `Invalid interval for ${layer.layerId}`);
    }
    let cursor = startFrame;
    for (const run of layer.runs) {
      if (run.startFrame !== cursor || run.startFrame >= run.endFrame || run.endFrame > endFrame) {
        throw codedError('TELEMETRY_RUN_COVERAGE_INVALID', `Non-contiguous runs for ${layer.layerId}`);
      }
      const sample = qaSample({layer, sample: run.sample, target});
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
        frames[frame].layers.push(structuredClone(sample));
      }
      cursor = run.endFrame;
    }
    if (cursor !== endFrame) {
      throw codedError('TELEMETRY_RUN_COVERAGE_INVALID', `Incomplete runs for ${layer.layerId}`);
    }
  }

  for (const frame of frames) {
    frame.layers.sort((left, right) => left.layerId.localeCompare(right.layerId));
  }
  return {
    coordinateSpace: 'output_pixels',
    frames,
    operationId: telemetry.operationId,
  };
};
