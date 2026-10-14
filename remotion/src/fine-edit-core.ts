import {validateSemanticOverlayProps, type SemanticEffect} from './semantic-overlay-core';

export const FINE_EDIT_INK = '#923d36';
export type FineCamera = {
  mode: 'hold' | 'push' | 'pull' | 'pan-left' | 'pan-right';
  focusX: number;
  focusY: number;
  amount: number;
};
export type FineEffect = Omit<SemanticEffect, 'kind' | 'lines' | 'trackTo'> & {
  kind: SemanticEffect['kind'] | 'ring' | 'connector';
  space: 'screen' | 'image';
};
export type FineEditProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  shotDurationInFrames: number;
  shotFrameOffset: number;
  camera: FineCamera;
  effects: FineEffect[];
};
const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));

// Identical camera curve is used by the base-image renderer. Frame zero is the
// shot origin, not the origin of the (possibly much shorter) overlay clip.
export function fineCameraAt(camera: FineCamera, frame: number, shotDurationInFrames: number) {
  const t = clamp(frame / Math.max(1, shotDurationInFrames - 1));
  const p = clamp((t - 0.15) / 0.70);
  const e = p * p * (3 - 2 * p);
  let zoom = 1;
  let focusX = camera.focusX;
  if (camera.mode === 'push') zoom += camera.amount * e;
  if (camera.mode === 'pull') zoom += camera.amount * (1 - e);
  if (camera.mode === 'pan-left' || camera.mode === 'pan-right') {
    zoom += camera.amount;
    focusX += (camera.mode === 'pan-right' ? 1 : -1) * (e - 0.5) * 0.30;
  }
  return {zoom, focusX: clamp(focusX), focusY: clamp(camera.focusY)};
}

export function projectFineEffect(effect: FineEffect, camera: ReturnType<typeof fineCameraAt>) {
  if (effect.space === 'screen') return {x: effect.x, y: effect.y, width: effect.width, height: effect.height};
  const {zoom: z, focusX, focusY} = camera;
  return {
    x: (effect.x - (1 - 1 / z) * focusX) * z,
    y: (effect.y - (1 - 1 / z) * focusY) * z,
    width: effect.width * z,
    height: effect.height * z,
  };
}

export function fineEffectState(effect: FineEffect, frame: number, fps: number) {
  const local = frame - effect.startFrame;
  const duration = effect.endFrame - effect.startFrame;
  const active = local >= 0 && local < duration;
  const entry = Math.max(1, Math.min(fps * 0.35, duration / 2));
  const exit = Math.max(1, Math.min(fps * 0.15, duration / 2));
  return {
    active,
    draw: clamp(local / entry),
    opacity: active ? Math.min(clamp(local / entry), clamp((duration - 1 - local) / exit)) : 0,
  };
}

export function validateFineEditProps(props: FineEditProps): void {
  if (!Number.isInteger(props.shotDurationInFrames) || props.shotDurationInFrames <= 0
    || !Number.isInteger(props.shotFrameOffset) || props.shotFrameOffset < 0
    || props.shotFrameOffset + props.durationInFrames > props.shotDurationInFrames) {
    throw new Error('Fine edit: overlay clip must fit inside the shot');
  }
  const camera = props.camera;
  if (!camera || !['hold', 'push', 'pull', 'pan-left', 'pan-right'].includes(camera.mode)
    || ![camera.focusX, camera.focusY, camera.amount].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error('Fine edit: invalid camera mode, normalized focus, or zoom amount');
  }
  if (!Array.isArray(props.effects)) throw new Error('Fine edit: effects must be an array');
  for (const effect of props.effects) {
    if (!effect || !['thought', 'scribble', 'emphasis', 'underline', 'ring', 'connector'].includes(effect.kind)
      || !['screen', 'image'].includes(effect.space)) throw new Error('Fine edit: invalid effect kind or coordinate space');
  }
  // Existing text-fit, safe-area, unique-ID, color, and frame-window contract.
  validateSemanticOverlayProps({...props, effects: props.effects.map((effect) => ({
    ...effect, kind: effect.kind === 'ring' || effect.kind === 'connector' ? 'underline' : effect.kind,
  }))});
}
