import { interpolate } from "remotion";

export type AudioEnvelopeOptions = {
  durationInFrames: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  volume: number;
  narrationActive?: boolean;
  narrationDuck?: number;
  automation?: Array<{frame: number; gain: number}>;
};

export function audioAutomationGain(frame: number, points: Array<{frame: number; gain: number}> = []) {
  if (points.length === 0) return 1;
  if (frame <= points[0].frame) return points[0].gain;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (frame <= current.frame) {
      return interpolate(frame, [previous.frame, current.frame], [previous.gain, current.gain], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    }
  }
  return points[points.length - 1]?.gain ?? 1;
}

export function audioEnvelopeVolume(frame: number, options: AudioEnvelopeOptions) {
  const duration = Math.max(1, options.durationInFrames);
  const fadeIn = Math.max(0, Math.min(duration, options.fadeInFrames ?? 0));
  const fadeOut = Math.max(0, Math.min(duration, options.fadeOutFrames ?? 0));
  const inGain = fadeIn === 0
    ? 1
    : interpolate(frame, [0, fadeIn], [0, 1], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const outStart = Math.max(0, duration - fadeOut);
  const outGain = fadeOut === 0
    ? 1
    : interpolate(frame, [outStart, Math.max(outStart + 1, duration - 1)], [1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const duck = options.narrationActive ? Math.max(0, Math.min(1, options.narrationDuck ?? 1)) : 1;
  const automation = Math.max(0, audioAutomationGain(frame, options.automation));
  return Math.max(0, options.volume * Math.min(inGain, outGain) * duck * automation);
}

export function narrationActiveAt(captions: Array<{startMs: number; endMs: number}>, timeMs: number, paddingMs = 90) {
  return captions.some((caption) => timeMs >= caption.startMs - paddingMs && timeMs < caption.endMs + paddingMs);
}
