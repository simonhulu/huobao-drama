import { interpolate } from "remotion";
import type { EditorialTextCue, LayerStyle } from "./types";
import { clamp, frameProgress } from "./timing";

export function cueProgress(frame: number, cue: EditorialTextCue) {
  return frameProgress(frame, cue.startFrame, cue.endFrame);
}

export function cueEntryProgress(frame: number, cue: EditorialTextCue) {
  const duration = Math.max(1, cue.endFrame - cue.startFrame);
  const requested = cue.entry === "type_on" ? 20 : cue.entry === "counter" || cue.type === "counter" ? 30 : 14;
  const entryEnd = cue.startFrame + Math.min(duration, requested);
  return frameProgress(frame, cue.startFrame, entryEnd);
}

export function cueText(cue: EditorialTextCue, frame: number) {
  const text = cue.text ?? "";
  if (cue.entry !== "type_on") return text;
  const progress = cueEntryProgress(frame, cue);
  return text.slice(0, Math.max(0, Math.ceil(progress * text.length)));
}

export function counterText(cue: EditorialTextCue, frame: number) {
  const progress = cueEntryProgress(frame, cue);
  const from = cue.from ?? 0;
  const to = cue.to ?? from;
  const decimals = cue.decimals ?? 0;
  const value = interpolate(progress, [0, 1], [from, to]);
  const formatted = value.toFixed(decimals);
  return `${cue.prefix ?? ""}${formatted}${cue.suffix ?? ""}`;
}

export function textCueStyle(cue: EditorialTextCue, frame: number): LayerStyle {
  const progress = cueEntryProgress(frame, cue);
  const entry = cue.entry ?? "fade";
  const exit = cue.exit ?? "none";
  const inOpacity = entry === "none" ? 1 : progress;
  const exitStart = Math.max(cue.startFrame, cue.endFrame - 12);
  const outProgress = exit === "none" ? 0 : frameProgress(frame, exitStart, cue.endFrame);
  let x = 0;
  let y = 0;
  if (entry === "slide_up") y = (1 - progress) * 18;
  if (entry === "slide_left") x = (1 - progress) * 24;
  if (exit === "slide_down") y += outProgress * 14;
  const style: LayerStyle = {
    opacity: clamp(inOpacity * (1 - outProgress), 0, 1),
    transform: `translate3d(${x}px, ${y}px, 0)`,
    color: cue.color ?? "#f8f5ee",
    fontSize: cue.fontSize ?? 54,
    fontWeight: cue.weight ?? 700,
    textAlign: cue.align ?? "left",
    width: cue.width ?? "auto",
    lineHeight: 1.02,
    fontFamily: 'Arial, "Helvetica Neue", sans-serif',
    textShadow: "0 2px 20px rgba(0,0,0,0.48)",
  };
  if (entry === "wipe") {
    style.clipPath = `inset(0 ${Math.max(0, (1 - progress) * 100)}% 0 0)`;
  }
  return style;
}
