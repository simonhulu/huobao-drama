import type {
  CameraPreset,
  EditorialTransitionClass,
  TextEntry,
} from "./types";

export type RendererDefinition = Readonly<{
  id: string;
  telemetryKind: "camera" | "transition" | "text" | "graphic";
  requiredCapabilities: readonly string[];
  sampling: "per-frame" | "constant";
}>;

export type GraphicKind = "underline" | "bar" | "globe" | "grid" | "monitor" | "divider" | "badge";
export type TextExit = "none" | "fade" | "slide_down";

const definition = (
  id: string,
  telemetryKind: RendererDefinition["telemetryKind"],
  sampling: RendererDefinition["sampling"] = "per-frame",
): RendererDefinition => ({
  id,
  telemetryKind,
  requiredCapabilities: [id],
  sampling,
});

/** Static registries are intentionally exhaustive over the recipe enums. */
export const CAMERA_RENDERERS = {
  hold: definition("camera.hold", "camera", "constant"),
  push_in: definition("camera.push_in", "camera"),
  pull_out: definition("camera.pull_out", "camera"),
  pan_left: definition("camera.pan_left", "camera"),
  pan_right: definition("camera.pan_right", "camera"),
  tilt_up: definition("camera.tilt_up", "camera"),
  tilt_down: definition("camera.tilt_down", "camera"),
  whip: definition("camera.whip", "camera"),
} satisfies Record<CameraPreset, RendererDefinition>;

export const TRANSITION_RENDERERS = {
  hard_cut: definition("transition.hard_cut", "transition", "constant"),
  dissolve: definition("transition.dissolve", "transition"),
  blur_bridge: definition("transition.blur_bridge", "transition"),
  matte_transition: definition("transition.matte_transition", "transition"),
  graphic_transition: definition("transition.graphic_transition", "transition"),
  distortion: definition("transition.distortion", "transition"),
  ambiguous: definition("transition.ambiguous", "transition", "constant"),
  no_local_delta: definition("transition.no_local_delta", "transition", "constant"),
  within_setup_change: definition("transition.within_setup_change", "transition", "constant"),
} satisfies Record<EditorialTransitionClass, RendererDefinition>;

export const TEXT_ENTRY_RENDERERS = {
  none: definition("text.entry.none", "text", "constant"),
  fade: definition("text.entry.fade", "text"),
  slide_up: definition("text.entry.slide_up", "text"),
  slide_left: definition("text.entry.slide_left", "text"),
  wipe: definition("text.entry.wipe", "text"),
  type_on: definition("text.entry.type_on", "text"),
  counter: definition("text.entry.counter", "text"),
} satisfies Record<TextEntry, RendererDefinition>;

export const TEXT_EXIT_RENDERERS = {
  none: definition("text.exit.none", "text", "constant"),
  fade: definition("text.exit.fade", "text"),
  slide_down: definition("text.exit.slide_down", "text"),
} satisfies Record<TextExit, RendererDefinition>;

export const GRAPHIC_RENDERERS = {
  underline: definition("graphic.underline", "graphic"),
  bar: definition("graphic.bar", "graphic"),
  globe: definition("graphic.globe", "graphic"),
  grid: definition("graphic.grid", "graphic"),
  monitor: definition("graphic.monitor", "graphic"),
  divider: definition("graphic.divider", "graphic"),
  badge: definition("graphic.badge", "graphic"),
} satisfies Record<GraphicKind, RendererDefinition>;

export const EDITORIAL_RENDERER_REGISTRIES = Object.freeze({
  camera: CAMERA_RENDERERS,
  transition: TRANSITION_RENDERERS,
  textEntry: TEXT_ENTRY_RENDERERS,
  textExit: TEXT_EXIT_RENDERERS,
  graphic: GRAPHIC_RENDERERS,
});

export function rendererRegistryKeys() {
  return Object.freeze({
    camera: Object.keys(CAMERA_RENDERERS),
    transition: Object.keys(TRANSITION_RENDERERS),
    textEntry: Object.keys(TEXT_ENTRY_RENDERERS),
    textExit: Object.keys(TEXT_EXIT_RENDERERS),
    graphic: Object.keys(GRAPHIC_RENDERERS),
  });
}
