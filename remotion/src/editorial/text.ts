import { interpolate } from "remotion";
import type { EditorialTextCue, LayerStyle } from "./types";
import { clamp, frameProgress } from "./timing";

export function cueProgress(frame: number, cue: EditorialTextCue) {
  return frameProgress(frame, cue.startFrame, cue.endFrame);
}

export function cueEntryProgress(frame: number, cue: EditorialTextCue) {
  const duration = Math.max(1, cue.endFrame - cue.startFrame);
  const requested = cue.entry === "type_on" ? 20 : cue.entry === "kinetic" ? 18 : cue.entry === "counter" || cue.type === "counter" ? 30 : 14;
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
  const variant = cue.variant ?? "impact";
  const exit = cue.exit ?? "none";
  const inOpacity = entry === "none" ? 1 : progress;
  const exitStart = Math.max(cue.startFrame, cue.endFrame - 12);
  const outProgress = exit === "none" ? 0 : frameProgress(frame, exitStart, cue.endFrame);
  let x = 0;
  let y = 0;
  let scale = 1;
  let rotate = 0;
  if (entry === "slide_up") y = (1 - progress) * 18;
  if (entry === "slide_left") x = (1 - progress) * 24;
  if (entry === "kinetic") {
    if (variant === "stamp") {
      y = (1 - progress) * -16;
      scale = 1.62 - progress * 0.62;
      rotate = (1 - progress) * 3.2;
    } else if (variant === "whisper") {
      x = (1 - progress) * -14;
      y = (1 - progress) * 6;
      scale = 0.97 + progress * 0.03;
    } else {
      x = (1 - progress) * -34;
      y = (1 - progress) * 18;
      scale = 1.34 - progress * 0.34;
      rotate = (1 - progress) * -2.4;
    }
  }
  if (exit === "slide_down") y += outProgress * 14;
  const style: LayerStyle = {
    opacity: clamp(inOpacity * (1 - outProgress), 0, 1),
    transform: `translate3d(${x}px, ${y}px, 0) scale(${scale}) rotate(${rotate}deg)`,
    color: cue.color ?? "#f8f5ee",
    fontSize: cue.fontSize ?? 54,
    fontWeight: cue.weight ?? 700,
    textAlign: cue.align ?? "left",
    width: cue.width ?? "auto",
    lineHeight: 1.02,
    fontFamily: '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    letterSpacing: 0,
    boxSizing: "border-box",
    textShadow: entry !== "kinetic"
      ? "0 5px 24px rgba(0,0,0,0.88)"
      : variant === "stamp"
        ? `0 2px 0 ${cue.accent ?? "#F2B84B"}, 0 12px 30px rgba(0,0,0,0.8)`
        : variant === "whisper"
          ? "0 4px 18px rgba(0,0,0,0.9)"
          : `3px 0 0 ${cue.accent ?? "#E56B55"}, -2px 2px 0 rgba(5,8,8,0.92), 0 10px 34px rgba(0,0,0,0.78)`,
  };
  if (entry === "wipe") {
    style.clipPath = `inset(0 ${Math.max(0, (1 - progress) * 100)}% 0 0)`;
  }
  if (entry === "kinetic") {
    style.filter = variant === "whisper"
      ? `blur(${(1 - progress) * 2.5}px)`
      : `blur(${(1 - progress) * 7}px) contrast(${1 + (1 - progress) * 0.32})`;
    if (variant === "stamp") style.WebkitTextStroke = `1px ${cue.accent ?? "#F2B84B"}`;
  }
  return style;
}
