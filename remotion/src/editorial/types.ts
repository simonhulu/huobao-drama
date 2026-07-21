import type { CSSProperties } from "react";

export type EditorialTransitionClass =
  | "hard_cut"
  | "dissolve"
  | "blur_bridge"
  | "matte_transition"
  | "graphic_transition"
  | "distortion"
  | "ambiguous"
  | "no_local_delta"
  | "within_setup_change";

export type CameraPreset =
  | "hold"
  | "push_in"
  | "pull_out"
  | "pan_left"
  | "pan_right"
  | "tilt_up"
  | "tilt_down"
  | "whip";

export type TextEntry =
  | "none"
  | "fade"
  | "slide_up"
  | "slide_left"
  | "wipe"
  | "type_on"
  | "counter";

export type EditorialAsset = {
  src: string;
  kind?: "image" | "video";
  fit?: "cover" | "contain";
  position?: string;
  filter?: string;
};

export type EditorialCamera = {
  preset: CameraPreset;
  intensity?: number;
  focus?: { x: number; y: number };
  startScale?: number;
  endScale?: number;
};

export type EditorialTransition = {
  class: EditorialTransitionClass;
  frames?: number;
  accent?: string;
};

export type EditorialTextCue = {
  type?: "text" | "counter";
  subject: string;
  text?: string;
  startFrame: number;
  endFrame: number;
  entry?: TextEntry;
  exit?: "none" | "fade" | "slide_down";
  x?: number;
  y?: number;
  width?: number | string;
  align?: "left" | "center" | "right";
  fontSize?: number;
  weight?: number;
  color?: string;
  accent?: string;
  prefix?: string;
  suffix?: string;
  /** Required by the validator for counter cues; keeps metrics auditable. */
  unit?: string;
  period?: string;
  from?: number;
  to?: number;
  decimals?: number;
  label?: string;
};

export type EditorialGraphicCue = {
  kind: "underline" | "bar" | "globe" | "grid" | "monitor" | "divider" | "badge";
  subject: string;
  startFrame: number;
  endFrame: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  secondaryColor?: string;
  label?: string;
};

export type EditorialShot = {
  id: string;
  durationInFrames: number;
  background: EditorialAsset;
  camera?: EditorialCamera;
  semanticRole?:
    | "hook"
    | "establishing"
    | "mechanism"
    | "comparison"
    | "reversal"
    | "crisis"
    | "resolution";
  transitionIn?: EditorialTransition;
  transitionOut?: EditorialTransition;
  texts?: EditorialTextCue[];
  graphics?: EditorialGraphicCue[];
  tint?: string;
  grain?: number;
  sourceLabel?: string;
};

type MagnatesEditorialTimeline = {
  durationInFrames: number;
  fps: number;
  title?: string;
  shots: EditorialShot[];
};

export type MagnatesEditorialRecipe = MagnatesEditorialTimeline & {
  schemaVersion: "magnates-remotion-recipe-v1";
};

export type MagnatesEditorialProps = MagnatesEditorialTimeline & {
  schemaVersion?: 1 | "magnates-remotion-recipe-v1";
  recipeSchemaVersion?: "magnates-remotion-recipe-v1";
  audioUrl?: string | null;
};

export type LayerStyle = CSSProperties & { [key: string]: string | number | undefined };
