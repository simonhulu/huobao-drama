import type { EditorialCoordinateMode } from "./types";

export const EDITORIAL_LOGICAL_WIDTH = 1280;
export const EDITORIAL_LOGICAL_HEIGHT = 720;

/** Convert v2 normalized coordinates or preview legacy percentages to CSS. */
export function positionCss(
  value: number | undefined,
  fallback: number,
  mode: EditorialCoordinateMode,
) {
  const coordinate = value ?? fallback;
  return `${mode === "normalized" ? coordinate * 100 : coordinate}%`;
}

/** Convert a dimension into logical design-space pixels. */
export function dimensionPx(
  value: number | undefined,
  fallback: number,
  axis: "x" | "y",
  mode: EditorialCoordinateMode,
) {
  const dimension = value ?? fallback;
  return mode === "normalized"
    ? dimension * (axis === "x" ? EDITORIAL_LOGICAL_WIDTH : EDITORIAL_LOGICAL_HEIGHT)
    : dimension;
}

export function textWidth(value: number | string | undefined, mode: EditorialCoordinateMode) {
  if (value === undefined) return "auto";
  return mode === "normalized" && typeof value === "number" ? `${value * 100}%` : value;
}
