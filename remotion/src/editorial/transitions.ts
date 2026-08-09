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
      return { opacity: p, filter: `blur(${(1 - p) * 22}px) saturate(${0.58 + p * 0.42}) contrast(${1.24 - p * 0.24})`, transform: `scale(${1.13 - p * 0.13})` };
    case "matte_transition":
      return { opacity: 1, clipPath: matteClipPath(p) };
    case "graphic_transition":
      return { opacity: 1, clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`, filter: `blur(${(1 - p) * 8}px)`, transform: `scale(${1.1 - p * 0.1})` };
    case "distortion":
      return { opacity: p, filter: `saturate(${1.75 - p * 0.75}) contrast(${1.32 - p * 0.32}) hue-rotate(${(1 - p) * -12}deg)`, transform: `translateX(${(1 - p) * 24}px) skewX(${(1 - p) * -4}deg) scale(${1.08 - p * 0.08})` };
    case "iris_reveal":
      return { opacity: 1, clipPath: `circle(${p * 74}% at 50% 48%)`, filter: `contrast(${1.12 - p * 0.12})` };
    case "film_burn":
      return { opacity: p, filter: `sepia(${(1 - p) * 0.8}) saturate(${1.9 - p * 0.9}) brightness(${1.42 - p * 0.42}) blur(${(1 - p) * 8}px)`, transform: `scale(${1.08 - p * 0.08})` };
    case "directional_blur":
      return { opacity: p, filter: `blur(${(1 - p) * 18}px) contrast(${1.16 - p * 0.16})`, transform: `translateY(${(1 - p) * 3.5}%) scale(${1.07 - p * 0.07})` };
    case "zoom_blur":
      return { opacity: p, filter: `blur(${(1 - p) * 14}px) saturate(${0.72 + p * 0.28})`, transform: `scale(${1.2 - p * 0.2})` };
    case "ink_bleed": {
      const radius = 5 + p * 72;
      return {
        opacity: 1,
        maskImage: `radial-gradient(circle at 48% 48%, #000 0 ${radius}%, transparent ${Math.min(100, radius + 12)}%)`,
        WebkitMaskImage: `radial-gradient(circle at 48% 48%, #000 0 ${radius}%, transparent ${Math.min(100, radius + 12)}%)`,
        filter: `contrast(${1.24 - p * 0.24}) saturate(${0.68 + p * 0.32})`,
      };
    }
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
  if (kind === "iris_reveal") return {opacity: 1 - p * 0.45, filter: `blur(${p * 4}px)`};
  if (kind === "film_burn") return {opacity: 1 - p, filter: `sepia(${p}) saturate(${1 + p * 1.4}) brightness(${1 + p * 0.8}) blur(${p * 7}px)`};
  if (kind === "directional_blur") return {opacity: 1 - p, filter: `blur(${p * 15}px)`, transform: `translateY(${p * -2.5}%) scale(${1 + p * 0.05})`};
  if (kind === "zoom_blur") return {opacity: 1 - p, filter: `blur(${p * 12}px)`, transform: `scale(${1 - p * 0.08})`};
  if (kind === "ink_bleed") return {opacity: 1 - p * 0.55, filter: `contrast(${1 + p * 0.2}) blur(${p * 3}px)`};
  return { opacity: 1 };
}

export function isBridgeTransition(kind: EditorialTransitionClass) {
  return kind === "blur_bridge"
    || kind === "graphic_transition"
    || kind === "distortion"
    || kind === "film_burn"
    || kind === "directional_blur"
    || kind === "zoom_blur"
    || kind === "ink_bleed";
}
