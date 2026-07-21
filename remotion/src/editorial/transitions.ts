import { Easing, interpolate } from "remotion";
import type { EditorialTransition, EditorialTransitionClass, LayerStyle } from "./types";
import { clamp, frameProgress } from "./timing";

export function transitionFrames(transition: EditorialTransition | undefined, fallback = 12) {
  if (!transition) return 0;
  if (
    transition.class === "hard_cut"
    || transition.class === "ambiguous"
    || transition.class === "no_local_delta"
    || transition.class === "within_setup_change"
  ) return 0;
  return Math.max(1, Math.round(transition.frames ?? fallback));
}

export function transitionProgress(frame: number, durationInFrames: number) {
  return interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export function matteClipPath(progress: number) {
  const p = clamp(progress, 0, 1);
  const top = p * 100;
  const shoulder = Math.max(0, top - 10);
  return `polygon(0% 0%, 100% 0%, 100% ${shoulder}%, 82% ${top}%, 63% ${Math.min(100, top + 5)}%, 40% ${Math.max(0, top - 3)}%, 18% ${Math.min(100, top + 7)}%, 0% ${top}%)`;
}

export function incomingTransitionStyle(
  transition: EditorialTransition | undefined,
  frame: number,
  offsetFrames: number,
): LayerStyle {
  const kind = transition?.class ?? "hard_cut";
  if (
    offsetFrames <= 0
    || kind === "hard_cut"
    || kind === "ambiguous"
    || kind === "within_setup_change"
    || kind === "no_local_delta"
  ) {
    return { opacity: 1 };
  }
  const p = frameProgress(frame, 0, offsetFrames);
  switch (kind) {
    case "dissolve":
      return { opacity: p };
    case "blur_bridge":
      return { opacity: p, filter: `blur(${(1 - p) * 12}px) saturate(${0.72 + p * 0.28})`, transform: `scale(${1.06 - p * 0.06})` };
    case "matte_transition":
      return { opacity: 1, clipPath: matteClipPath(p) };
    case "graphic_transition":
      return { opacity: p, filter: `blur(${(1 - p) * 5}px)`, transform: `scale(${1.08 - p * 0.08})` };
    case "distortion":
      return { opacity: p, filter: `saturate(${1.3 - p * 0.3}) contrast(${1.08 - p * 0.08})`, transform: `translateX(${(1 - p) * 9}px) skewX(${(1 - p) * -2}deg)` };
    default:
      return { opacity: 1 };
  }
}

export function outgoingTransitionStyle(
  transition: EditorialTransition | undefined,
  frame: number,
  durationInFrames: number,
): LayerStyle {
  const kind = transition?.class ?? "hard_cut";
  const frames = transitionFrames(transition);
  if (
    frames <= 0
    || kind === "hard_cut"
    || kind === "ambiguous"
    || kind === "within_setup_change"
    || kind === "no_local_delta"
  ) return { opacity: 1 };
  const p = frameProgress(frame, Math.max(0, durationInFrames - frames), durationInFrames);
  if (kind === "dissolve" || kind === "blur_bridge" || kind === "graphic_transition") {
    return { opacity: 1 - p, filter: kind === "blur_bridge" ? `blur(${p * 12}px)` : undefined };
  }
  if (kind === "matte_transition") {
    return { opacity: 1, clipPath: matteClipPath(1 - p) };
  }
  if (kind === "distortion") {
    return { opacity: 1 - p * 0.35, filter: `saturate(${1 + p * 0.8}) contrast(${1 + p * 0.25})`, transform: `translateX(${p * -8}px) skewX(${p * 2}deg)` };
  }
  return { opacity: 1 };
}

export function isBridgeTransition(kind: EditorialTransitionClass) {
  return kind === "blur_bridge" || kind === "graphic_transition" || kind === "distortion";
}
