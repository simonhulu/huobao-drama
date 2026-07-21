import { Easing, interpolate } from "remotion";
import type { EditorialCamera, LayerStyle } from "./types";
import { clamp, frameProgress } from "./timing";

const DEFAULT_CAMERA: EditorialCamera = { preset: "hold", intensity: 0.35, focus: { x: 0.5, y: 0.5 } };

function easedProgress(frame: number, durationInFrames: number) {
  return interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export function cameraTransform(
  frame: number,
  durationInFrames: number,
  camera: EditorialCamera = DEFAULT_CAMERA,
) {
  const progress = easedProgress(frame, durationInFrames);
  const intensity = clamp(camera.intensity ?? 0.35, 0, 1);
  const focus = camera.focus ?? { x: 0.5, y: 0.5 };
  const isHold = camera.preset === "hold";
  const isDirectional = camera.preset === "pan_left"
    || camera.preset === "pan_right"
    || camera.preset === "tilt_up"
    || camera.preset === "tilt_down";
  const startScale = camera.startScale ?? (isHold ? 1.035 : isDirectional ? 1.045 : 1.045);
  // A hold is a resolved still, not a hidden push-in. Pan/tilt gets only the
  // crop headroom needed to avoid revealing an edge while it translates.
  const endScale = camera.endScale ?? (
    isHold
      ? startScale
      : camera.preset === "pull_out"
        ? 1.035
        : isDirectional
          ? 1.055
          : 1.11 + intensity * 0.08
  );
  let x = 0;
  let y = 0;
  let rotate = 0;
  const boundedStartScale = isDirectional ? Math.min(startScale, 1.06) : startScale;
  const boundedEndScale = isDirectional ? Math.min(endScale, 1.06) : endScale;
  let scale = interpolate(progress, [0, 1], [boundedStartScale, boundedEndScale]);

  switch (camera.preset) {
    case "push_in":
      x = interpolate(progress, [0, 1], [0, (0.5 - focus.x) * 15 * intensity]);
      y = interpolate(progress, [0, 1], [0, (0.5 - focus.y) * 11 * intensity]);
      break;
    case "pull_out":
      x = interpolate(progress, [0, 1], [(0.5 - focus.x) * 10 * intensity, 0]);
      y = interpolate(progress, [0, 1], [(0.5 - focus.y) * 8 * intensity, 0]);
      break;
    case "pan_left":
      x = interpolate(progress, [0, 1], [8 * intensity, -8 * intensity]);
      scale = Math.min(1.06, Math.max(scale, 1.055));
      break;
    case "pan_right":
      x = interpolate(progress, [0, 1], [-8 * intensity, 8 * intensity]);
      scale = Math.min(1.06, Math.max(scale, 1.055));
      break;
    case "tilt_up":
      y = interpolate(progress, [0, 1], [6 * intensity, -6 * intensity]);
      scale = Math.min(1.06, Math.max(scale, 1.055));
      break;
    case "tilt_down":
      y = interpolate(progress, [0, 1], [-6 * intensity, 6 * intensity]);
      scale = Math.min(1.06, Math.max(scale, 1.055));
      break;
    case "whip":
      x = interpolate(progress, [0, 0.25, 1], [-14 * intensity, 12 * intensity, 2 * intensity]);
      rotate = interpolate(progress, [0, 0.4, 1], [-1.1 * intensity, 0.6 * intensity, 0]);
      scale = Math.max(scale, 1.08);
      break;
    case "hold":
    default:
      break;
  }

  return `translate3d(${x.toFixed(3)}%, ${y.toFixed(3)}%, 0) scale(${scale.toFixed(4)}) rotate(${rotate.toFixed(3)}deg)`;
}

export function cameraLayerStyle(
  frame: number,
  durationInFrames: number,
  camera?: EditorialCamera,
): LayerStyle {
  return {
    transform: cameraTransform(frame, durationInFrames, camera),
    transformOrigin: `${(camera?.focus?.x ?? 0.5) * 100}% ${(camera?.focus?.y ?? 0.5) * 100}%`,
  };
}

export function pulseProgress(frame: number, start: number, end: number) {
  return frameProgress(frame, start, end);
}
