const passed = (id, expected, observed, remediation) => ({
  expected,
  id,
  observed,
  remediation,
  severity: 'blocking',
  status: 'passed',
});
const failed = (id, expected, observed, remediation) => ({
  expected,
  id,
  observed,
  remediation,
  severity: 'blocking',
  status: 'failed',
});

const check = (condition, id, expected, observed, remediation) =>
  condition ? passed(id, expected, observed, remediation) : failed(id, expected, observed, remediation);

const telemetryFramesAreComplete = (frames, expected) =>
  Array.isArray(frames) &&
  frames.length === expected &&
  frames.every(({frame}, index) => frame === index);

const allCueBoundsAreSafe = ({recipe, telemetry, target, inset}) => {
  const cueIds = new Set(recipe.shots.flatMap((shot) => [
    ...(shot.texts ?? []),
    ...(shot.graphics ?? []),
  ]).map(({id}) => `cue:${id}:root`));
  if (cueIds.size === 0) return true;
  const left = target.width * inset;
  const top = target.height * inset;
  const right = target.width * (1 - inset);
  const bottom = target.height * (1 - inset);
  return telemetry.frames.every(({layers}) => layers.every(({layerId, bounds}) =>
    !cueIds.has(layerId) || (
      bounds.x >= left && bounds.y >= top &&
      bounds.x + bounds.width <= right && bounds.y + bounds.height <= bottom
    ),
  ));
};

export const evaluateDeterministicQa = ({recipe, target, mediaFacts, telemetry, policy}) => {
  const checks = [];
  checks.push(check(
    mediaFacts.decodable === true,
    'media-decode',
    true,
    mediaFacts.decodable,
    'Render a fully decodable output',
  ));
  checks.push(check(
    mediaFacts.width === target.width && mediaFacts.height === target.height && mediaFacts.fps === target.fps,
    'target-profile',
    target,
    {fps: mediaFacts.fps, height: mediaFacts.height, width: mediaFacts.width},
    'Render the exact negotiated target profile',
  ));
  checks.push(check(
    mediaFacts.frameCount === recipe.durationInFrames,
    'frame-count',
    recipe.durationInFrames,
    mediaFacts.frameCount,
    'Render the complete recipe frame range',
  ));
  const durationTolerance = Math.max(1 / target.fps, 0.05);
  const expectedDuration = recipe.durationInFrames / recipe.fps;
  checks.push(check(
    Math.abs(mediaFacts.durationSeconds - expectedDuration) <= durationTolerance,
    'container-duration',
    {seconds: expectedDuration, tolerance: durationTolerance},
    mediaFacts.durationSeconds,
    'Correct output container duration or time base',
  ));
  const audioValid = policy.audioMode === 'required'
    ? mediaFacts.hasAudio === true && mediaFacts.audioSampleRate === 48000
    : policy.audioMode === 'forbidden'
      ? mediaFacts.hasAudio === false
      : mediaFacts.hasAudio === false || mediaFacts.audioSampleRate === 48000;
  checks.push(check(
    audioValid,
    'audio-policy',
    policy.audioMode,
    {hasAudio: mediaFacts.hasAudio, sampleRate: mediaFacts.audioSampleRate},
    'Conform narration to the declared audio policy at 48 kHz',
  ));
  const blackRuns = mediaFacts.unintendedBlackRuns ?? [];
  checks.push(check(
    blackRuns.every(({startFrame, endFrame}) => endFrame - startFrame <= 3),
    'black-frame',
    'no unintended black run longer than 3 frames',
    blackRuns,
    'Repair uncovered timeline frames or unintended blackout',
  ));
  checks.push(check(
    telemetryFramesAreComplete(telemetry.frames, recipe.durationInFrames),
    'telemetry-coverage',
    recipe.durationInFrames,
    telemetry.frames?.length,
    'Inspect one accepted telemetry packet for every output frame',
  ));
  checks.push(check(
    allCueBoundsAreSafe({
      inset: policy.safeAreaInset ?? 0.05,
      recipe,
      target,
      telemetry,
    }),
    'safe-area',
    `cue bounds inside ${(policy.safeAreaInset ?? 0.05) * 100}% inset`,
    'measured layout telemetry',
    'Move or resize the cue inside the target safe area',
  ));
  return {
    checks,
    status: checks.some(({status}) => status === 'failed') ? 'failed' : 'passed',
  };
};
