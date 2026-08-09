const highEnergyTransitions = new Set(['distortion', 'matte_transition', 'graphic_transition', 'film_burn', 'zoom_blur', 'ink_bleed']);
const focusBridgeThreshold = 0.18;
const scaleBridgeThreshold = 0.12;

export const controlledCameraPresets = Object.freeze([
  'hold',
  'push_in',
  'pull_out',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
]);

export const controlledTransitionClasses = Object.freeze([
  'hard_cut',
  'dissolve',
  'blur_bridge',
  'graphic_transition',
  'matte_transition',
  'distortion',
  'iris_reveal',
  'film_burn',
  'directional_blur',
  'zoom_blur',
  'ink_bleed',
]);

const protectedBeat = (role, emphasis) =>
  (role === 'crisis' || role === 'reversal') && emphasis >= 0.85;

const transitionFrames = Object.freeze({
  blur_bridge: 16,
  directional_blur: 16,
  dissolve: 20,
  film_burn: 18,
  ink_bleed: 16,
  iris_reveal: 14,
  zoom_blur: 14,
});

const transition = (transitionClass) => transitionClass === 'hard_cut'
  ? {class: transitionClass}
  : {class: transitionClass, frames: transitionFrames[transitionClass] ?? 16};

const roleCamera = (role) => {
  if (role === 'hook') return {preset: 'push_in', intensity: 0.9, startScale: 1.04, endScale: 1.18};
  if (role === 'establishing') return {preset: 'pull_out', intensity: 0.8, startScale: 1.18, endScale: 1.04};
  if (role === 'comparison') return {preset: 'pan_right', intensity: 0.85, startScale: 1.08, endScale: 1.08};
  if (role === 'reversal') return {preset: 'push_in', intensity: 0.86, startScale: 1.04, endScale: 1.14};
  if (role === 'crisis') return {preset: 'push_in', intensity: 0.88, startScale: 1.04, endScale: 1.18};
  if (role === 'resolution') return {preset: 'pull_out', intensity: 0.65, startScale: 1.1, endScale: 1.04};
  return {preset: 'hold', intensity: 0.55, startScale: 1.08, endScale: 1.08};
};

const roleTransition = (role) => {
  if (role === 'hook') return transition('film_burn');
  if (role === 'establishing' || role === 'resolution') return transition('dissolve');
  if (role === 'comparison') return transition('iris_reveal');
  if (role === 'reversal') return transition('ink_bleed');
  if (role === 'crisis') return transition('zoom_blur');
  return transition('hard_cut');
};

const focusDelta = (currentFocus, nextFocus) => ({
  x: (nextFocus?.x ?? currentFocus?.x ?? 0.5) - (currentFocus?.x ?? nextFocus?.x ?? 0.5),
  y: (nextFocus?.y ?? currentFocus?.y ?? 0.5) - (currentFocus?.y ?? nextFocus?.y ?? 0.5),
});

const continuityCamera = ({currentFocus, nextFocus, role, scaleDelta}) => {
  if (role === 'hook') return roleCamera(role);
  if (scaleDelta >= scaleBridgeThreshold) {
    return {preset: 'push_in', intensity: 0.78, startScale: 1.04, endScale: 1.16};
  }
  if (scaleDelta <= -scaleBridgeThreshold) {
    return {preset: 'pull_out', intensity: 0.76, startScale: 1.16, endScale: 1.04};
  }
  const delta = focusDelta(currentFocus, nextFocus);
  if (Math.abs(delta.x) >= focusBridgeThreshold && Math.abs(delta.x) >= Math.abs(delta.y)) {
    return {preset: delta.x > 0 ? 'pan_right' : 'pan_left', intensity: 0.8, startScale: 1.08, endScale: 1.08};
  }
  if (Math.abs(delta.y) >= focusBridgeThreshold) {
    return {preset: delta.y > 0 ? 'tilt_down' : 'tilt_up', intensity: 0.72, startScale: 1.06, endScale: 1.06};
  }
  return roleCamera(role);
};

const continuityTransition = ({currentFocus, emphasis, nextFocus, role, scaleDelta}) => {
  if (role === 'hook') return roleTransition(role);
  const delta = focusDelta(currentFocus, nextFocus);
  if (Math.abs(delta.x) >= focusBridgeThreshold || Math.abs(delta.y) >= focusBridgeThreshold) {
    return transition('directional_blur');
  }
  if (Math.abs(scaleDelta) >= scaleBridgeThreshold) return transition('zoom_blur');
  return roleTransition(role);
};

const coolCamera = ({camera, recent, role, emphasis}) => {
  const clustered = recent.slice(-2).length === 2 && recent.slice(-2).every((preset) => preset === camera.preset);
  if (!clustered || camera.preset === 'hold') return camera;
  return {preset: 'hold', intensity: 0.5, startScale: camera.startScale ?? 1.08, endScale: camera.startScale ?? 1.08};
};

const transitionCooldown = Object.freeze({
  directional_blur: 'blur_bridge',
  zoom_blur: 'dissolve',
  film_burn: 'dissolve',
  ink_bleed: 'hard_cut',
  iris_reveal: 'dissolve',
  dissolve: 'hard_cut',
  hard_cut: 'blur_bridge',
});

export const isHighEnergyTransition = (value) => highEnergyTransitions.has(value);

export function budgetTransition({role, emphasis = 0.6, requested, recent = []}) {
  if (!requested || !isHighEnergyTransition(requested.class)) return requested;
  const clustered = recent.slice(-2).filter(isHighEnergyTransition).length >= 2;
  if (!clustered || protectedBeat(role, emphasis)) return requested;
  return {class: 'blur_bridge', frames: Math.min(16, Math.max(12, requested.frames ?? 14))};
}

export function selectEditorialTreatment({
  role,
  emphasis = 0.6,
  currentFocus,
  nextFocus,
  scaleDelta = 0,
  recent = {},
  transitionEnergy = 'medium',
}) {
  const recentCameras = recent.cameras ?? [];
  const recentTransitions = recent.transitions ?? [];
  const baseCamera = continuityCamera({currentFocus, nextFocus, role, scaleDelta});
  const camera = coolCamera({camera: baseCamera, recent: recentCameras, role, emphasis});
  let requested = continuityTransition({currentFocus, emphasis, nextFocus, role, scaleDelta});

  if (transitionEnergy === 'low' && isHighEnergyTransition(requested.class)) {
    requested = transition('blur_bridge');
  } else if (
    transitionEnergy === 'high' &&
    protectedBeat(role, emphasis) &&
    !isHighEnergyTransition(requested.class)
  ) {
    requested = roleTransition(role);
  }

  if (!protectedBeat(role, emphasis) && recentTransitions.at(-1) === requested.class) {
    requested = transition(transitionCooldown[requested.class] ?? 'hard_cut');
  }

  return {
    camera,
    transition: budgetTransition({role, emphasis, requested, recent: recentTransitions}),
  };
}
