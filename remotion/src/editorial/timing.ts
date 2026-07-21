import type { EditorialShot } from "./types";

export type TimelineItem = {
  shot: EditorialShot;
  startFrame: number;
  incomingOffsetFrames: number;
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function frameProgress(frame: number, start: number, end: number) {
  if (end <= start) return frame >= end ? 1 : 0;
  return clamp((frame - start) / (end - start), 0, 1);
}

/** Zero-based, start-inclusive, end-exclusive visibility semantics. */
export function isFrameVisible(frame: number, start: number, end: number) {
  return frame >= start && frame < end;
}

export function buildTimeline(shots: EditorialShot[], fps = 30): TimelineItem[] {
  let cursor = 0;
  return shots.map((shot, index) => {
    const startFrame = cursor;
    const transitionClass = shot.transitionIn?.class;
    const directBoundary = transitionClass === "hard_cut"
      || transitionClass === "ambiguous"
      || transitionClass === "no_local_delta"
      || transitionClass === "within_setup_change";
    const requested = index === 0 || directBoundary
      ? 0
      : shot.transitionIn?.frames ?? Math.round(0.4 * fps);
    const incomingOffsetFrames = Math.min(
      Math.max(0, requested),
      Math.max(0, Math.floor(shot.durationInFrames * 0.45)),
    );
    cursor += shot.durationInFrames;
    return { shot, startFrame, incomingOffsetFrames };
  });
}

export function totalDurationInFrames(shots: EditorialShot[]) {
  return shots.reduce((total, shot) => total + shot.durationInFrames, 0);
}

const GENERIC_SUBJECTS = new Set(["text", "shape", "layer"]);

/**
 * The VLM grammar requires a cue to identify the visible thing it changes.
 * Keep this check in the renderer-side contract so malformed generated props
 * fail before a render silently produces an anonymous text/shape layer.
 */
export function isConcreteSubject(subject: unknown): subject is string {
  if (typeof subject !== "string") return false;
  const normalized = subject.trim().toLowerCase();
  return normalized.length >= 2 && !GENERIC_SUBJECTS.has(normalized);
}

function validateCueRange(
  shotId: string,
  cueKind: "text" | "graphic",
  startFrame: unknown,
  endFrame: unknown,
  durationInFrames: number,
  subject: unknown,
) {
  const errors: string[] = [];
  const prefix = `${shotId}: ${cueKind} cue`;
  if (!isConcreteSubject(subject)) {
    errors.push(`${prefix} subject must be concrete`);
  }
  const start = Number(startFrame);
  const end = Number(endFrame);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    errors.push(`${prefix} frame range must use integer frames`);
  } else if (start < 0 || end > durationInFrames || start >= end) {
    errors.push(`${prefix} frame range must be within 0..${durationInFrames}`);
  }
  return errors;
}

function sameBackgroundSetup(left: EditorialShot["background"], right: EditorialShot["background"]) {
  return left.src === right.src
    && left.kind === right.kind
    && left.fit === right.fit
    && left.position === right.position
    && left.filter === right.filter;
}

export function validateTimeline(shots: EditorialShot[], durationInFrames: number) {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  shots.forEach((shot, index) => {
    const id = typeof shot.id === "string" ? shot.id.trim() : "";
    if (!id) errors.push("shot id must not be empty");
    if (id && seenIds.has(id)) errors.push(`${id}: shot id must be unique`);
    if (id) seenIds.add(id);
    if (!Number.isInteger(shot.durationInFrames) || shot.durationInFrames < 1) {
      errors.push(`${id || "shot"}: durationInFrames must be a positive integer`);
    }
    const previous = shots[index - 1];
    if (shot.transitionIn?.class === "within_setup_change") {
      if (!previous || !sameBackgroundSetup(previous.background, shot.background)) {
        errors.push(`${id || "shot"}: within_setup_change requires the previous shot background setup`);
      }
    }
    (shot.texts ?? []).forEach((cue) => {
      if (cue.id) {
        if (seenIds.has(cue.id)) errors.push(`${id || "shot"}: node id ${cue.id} must be unique`);
        seenIds.add(cue.id);
      }
      errors.push(...validateCueRange(
        id || "shot",
        "text",
        cue.startFrame,
        cue.endFrame,
        shot.durationInFrames,
        cue.subject,
      ));
      if (cue.type === "counter" || cue.entry === "counter") {
        if (!cue.unit?.trim()) errors.push(`${id || "shot"}: counter cue unit must not be empty`);
        if (!cue.period?.trim()) errors.push(`${id || "shot"}: counter cue period must not be empty`);
      }
    });
    (shot.graphics ?? []).forEach((cue) => {
      if (cue.id) {
        if (seenIds.has(cue.id)) errors.push(`${id || "shot"}: node id ${cue.id} must be unique`);
        seenIds.add(cue.id);
      }
      errors.push(...validateCueRange(
        id || "shot",
        "graphic",
        cue.startFrame,
        cue.endFrame,
        shot.durationInFrames,
        cue.subject,
      ));
    });
  });
  const total = totalDurationInFrames(shots);
  if (total !== durationInFrames) {
    errors.push(`durationInFrames ${durationInFrames} does not match shot total ${total}`);
  }
  return errors;
}
