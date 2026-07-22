/**
 * Pure conversion boundary for the production Magnates Remotion adapter.
 *
 * This module deliberately has no filesystem, network, environment, or
 * repository-root dependencies. The adapter owns artifact I/O; this function
 * only validates an already-canonical recipe and converts inventory identities
 * into the representation consumed by Remotion.
 */

const SCHEMA_VERSION = "magnates-remotion-recipe-v2";
const COMPOSITION_ID = "MagnatesEditorial";
const LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 720;

export const TARGET_PROFILES = Object.freeze({
  "youtube-720p": Object.freeze({
    profileId: "youtube-720p",
    logicalWidth: LOGICAL_WIDTH,
    logicalHeight: LOGICAL_HEIGHT,
    width: 1280,
    height: 720,
    fps: 30,
    scale: 1,
  }),
  "youtube-1080p": Object.freeze({
    profileId: "youtube-1080p",
    logicalWidth: LOGICAL_WIDTH,
    logicalHeight: LOGICAL_HEIGHT,
    width: 1920,
    height: 1080,
    fps: 30,
    scale: 1.5,
  }),
});

const TRANSITIONS = new Set([
  "hard_cut",
  "dissolve",
  "blur_bridge",
  "matte_transition",
  "graphic_transition",
  "distortion",
  "ambiguous",
  "no_local_delta",
  "within_setup_change",
]);
const CAMERAS = new Set([
  "hold",
  "push_in",
  "pull_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "whip",
]);
const TEXT_ENTRIES = new Set(["none", "fade", "slide_up", "slide_left", "wipe", "type_on", "counter"]);
const TEXT_EXITS = new Set(["none", "fade", "slide_down"]);
const GRAPHICS = new Set(["underline", "bar", "globe", "grid", "monitor", "divider", "badge"]);
const ROLES = new Set(["hook", "establishing", "mechanism", "comparison", "reversal", "crisis", "resolution"]);
const GENERIC_SUBJECTS = new Set(["", "subject", "text", "shape", "layer", "person", "company", "unknown", "tbd"]);
const AUDIO_MODES = new Set(["required", "optional", "forbidden"]);
const POSITIONS = new Set(["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"]);
const FILTERS = new Set(["none", "monochrome", "warm", "cool", "high_contrast", "soft_blur"]);

const ROOT_KEYS = new Set([
  "schemaVersion",
  "durationInFrames",
  "fps",
  "title",
  "shots",
  "audioAssetId",
  "audioMode",
]);
const SHOT_KEYS = new Set([
  "id",
  "durationInFrames",
  "background",
  "semanticRole",
  "camera",
  "transitionIn",
  "transitionOut",
  "texts",
  "graphics",
  "tint",
  "grain",
  "sourceLabel",
]);
const ASSET_KEYS = new Set(["assetId", "fit", "position", "filter"]);
const CAMERA_KEYS = new Set(["preset", "intensity", "focus", "startScale", "endScale"]);
const FOCUS_KEYS = new Set(["x", "y"]);
const TRANSITION_KEYS = new Set(["class", "frames", "accent"]);
const TEXT_KEYS = new Set([
  "id",
  "type",
  "subject",
  "subjectId",
  "text",
  "startFrame",
  "endFrame",
  "entry",
  "exit",
  "x",
  "y",
  "width",
  "align",
  "fontSize",
  "weight",
  "color",
  "accent",
  "prefix",
  "suffix",
  "metricId",
  "unit",
  "period",
  "from",
  "to",
  "decimals",
  "label",
]);
const GRAPHIC_KEYS = new Set([
  "id",
  "kind",
  "subject",
  "subjectId",
  "startFrame",
  "endFrame",
  "x",
  "y",
  "width",
  "height",
  "color",
  "secondaryColor",
  "label",
]);

export class MagnatesPropsError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MagnatesPropsError";
    this.code = "INVALID_MAGNATES_RECIPE";
    this.category = "invalid-input";
    this.details = details;
  }
}

function fail(message, pointer = "$") {
  throw new MagnatesPropsError(`${pointer}: ${message}`, { pointer });
}

function record(value, pointer) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object", pointer);
  return value;
}

function keys(value, allowed, pointer) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown property ${key}`, `${pointer}.${key}`);
  }
}

function requiredString(value, pointer) {
  if (typeof value !== "string" || !value.trim()) fail("must be a non-empty string", pointer);
  return value;
}

function stableId(value, pointer) {
  const result = requiredString(value, pointer);
  if (result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail("must be a stable identity", pointer);
  return result;
}

function optionalString(value, pointer) {
  if (value === undefined) return undefined;
  return requiredString(value, pointer);
}

function integer(value, pointer, { minimum = undefined, maximum = undefined } = {}) {
  if (!Number.isInteger(value)) fail("must be an integer", pointer);
  if (minimum !== undefined && value < minimum) fail(`must be >= ${minimum}`, pointer);
  if (maximum !== undefined && value > maximum) fail(`must be <= ${maximum}`, pointer);
  return value;
}

function number(value, pointer, { minimum = undefined, maximum = undefined } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a finite number", pointer);
  if (minimum !== undefined && value < minimum) fail(`must be >= ${minimum}`, pointer);
  if (maximum !== undefined && value > maximum) fail(`must be <= ${maximum}`, pointer);
  return value;
}

function enumValue(value, allowed, pointer) {
  if (typeof value !== "string" || !allowed.has(value)) fail(`unsupported value ${String(value)}`, pointer);
  return value;
}

function concreteSubject(value, pointer) {
  const subject = requiredString(value, pointer);
  if (GENERIC_SUBJECTS.has(subject.trim().toLowerCase())) fail("must identify a concrete subject", pointer);
  return subject;
}

function validateColorish(value, pointer) {
  if (value === undefined) return undefined;
  const color = requiredString(value, pointer);
  if (!/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(color)) fail("must be a hex color", pointer);
  return color;
}

function validateFrameRange(raw, duration, pointer) {
  const start = integer(raw.startFrame, `${pointer}.startFrame`, { minimum: 0 });
  const end = integer(raw.endFrame, `${pointer}.endFrame`, { minimum: 1 });
  if (start >= end || end > duration) fail(`must be in [0, ${duration})`, pointer);
  return { startFrame: start, endFrame: end };
}

function validateFocus(raw, pointer) {
  if (raw === undefined) return undefined;
  const focus = record(raw, pointer);
  keys(focus, FOCUS_KEYS, pointer);
  return {
    x: number(focus.x, `${pointer}.x`, { minimum: 0, maximum: 1 }),
    y: number(focus.y, `${pointer}.y`, { minimum: 0, maximum: 1 }),
  };
}

function validateCamera(raw, pointer) {
  if (raw === undefined) return undefined;
  const camera = record(raw, pointer);
  keys(camera, CAMERA_KEYS, pointer);
  const result = { preset: enumValue(camera.preset, CAMERAS, `${pointer}.preset`) };
  if (camera.intensity !== undefined) result.intensity = number(camera.intensity, `${pointer}.intensity`, { minimum: 0, maximum: 1 });
  if (camera.focus !== undefined) result.focus = validateFocus(camera.focus, `${pointer}.focus`);
  if (camera.startScale !== undefined) result.startScale = number(camera.startScale, `${pointer}.startScale`, { minimum: 1, maximum: 4 });
  if (camera.endScale !== undefined) result.endScale = number(camera.endScale, `${pointer}.endScale`, { minimum: 1, maximum: 4 });
  return result;
}

function validateTransition(raw, pointer) {
  if (raw === undefined) return undefined;
  const transition = record(raw, pointer);
  keys(transition, TRANSITION_KEYS, pointer);
  const result = { class: enumValue(transition.class, TRANSITIONS, `${pointer}.class`) };
  if (transition.frames !== undefined) result.frames = integer(transition.frames, `${pointer}.frames`, { minimum: 0, maximum: 45 });
  if (transition.accent !== undefined) result.accent = validateColorish(transition.accent, `${pointer}.accent`);
  return result;
}

function validateAssetRef(raw, pointer) {
  const asset = record(raw, pointer);
  keys(asset, ASSET_KEYS, pointer);
  const result = { assetId: stableId(asset.assetId, `${pointer}.assetId`) };
  if (asset.fit !== undefined) result.fit = enumValue(asset.fit, new Set(["cover", "contain"]), `${pointer}.fit`);
  if (asset.position !== undefined) result.position = enumValue(asset.position, POSITIONS, `${pointer}.position`);
  if (asset.filter !== undefined) result.filter = enumValue(asset.filter, FILTERS, `${pointer}.filter`);
  return result;
}

function validateText(raw, duration, pointer) {
  const cue = record(raw, pointer);
  keys(cue, TEXT_KEYS, pointer);
  const result = {
    id: stableId(cue.id, `${pointer}.id`),
    type: enumValue(cue.type, new Set(["text", "counter"]), `${pointer}.type`),
    subject: concreteSubject(cue.subject, `${pointer}.subject`),
    subjectId: stableId(cue.subjectId, `${pointer}.subjectId`),
    ...validateFrameRange(cue, duration, pointer),
  };
  if (cue.text !== undefined) result.text = requiredString(cue.text, `${pointer}.text`);
  if (result.type === "text" && cue.text === undefined) fail("text cue requires text", `${pointer}.text`);
  if (cue.entry !== undefined) result.entry = enumValue(cue.entry, TEXT_ENTRIES, `${pointer}.entry`);
  if (cue.exit !== undefined) result.exit = enumValue(cue.exit, TEXT_EXITS, `${pointer}.exit`);
  if (cue.x !== undefined) result.x = number(cue.x, `${pointer}.x`, { minimum: 0, maximum: 1 });
  if (cue.y !== undefined) result.y = number(cue.y, `${pointer}.y`, { minimum: 0, maximum: 1 });
  if (cue.width !== undefined) {
    result.width = number(cue.width, `${pointer}.width`, { minimum: Number.MIN_VALUE, maximum: 1 });
  }
  if (cue.align !== undefined) result.align = enumValue(cue.align, new Set(["left", "center", "right"]), `${pointer}.align`);
  if (cue.fontSize !== undefined) result.fontSize = number(cue.fontSize, `${pointer}.fontSize`, { minimum: 10, maximum: 180 });
  if (cue.weight !== undefined) {
    result.weight = integer(cue.weight, `${pointer}.weight`, { minimum: 100, maximum: 900 });
    if (result.weight % 100 !== 0) fail("must be a multiple of 100", `${pointer}.weight`);
  }
  for (const name of ["color", "accent", "prefix", "suffix", "unit", "period", "label"]) {
    if (cue[name] !== undefined) result[name] = name === "color" || name === "accent"
      ? validateColorish(cue[name], `${pointer}.${name}`)
      : requiredString(cue[name], `${pointer}.${name}`);
  }
  if (cue.from !== undefined) result.from = number(cue.from, `${pointer}.from`);
  if (cue.to !== undefined) result.to = number(cue.to, `${pointer}.to`);
  if (cue.decimals !== undefined) result.decimals = integer(cue.decimals, `${pointer}.decimals`, { minimum: 0, maximum: 4 });
  const counter = result.type === "counter" || result.entry === "counter" || cue.metricId !== undefined;
  if (counter) {
    result.type = "counter";
    result.entry = result.entry ?? "counter";
    result.metricId = stableId(cue.metricId, `${pointer}.metricId`);
    requiredString(cue.unit, `${pointer}.unit`);
    requiredString(cue.period, `${pointer}.period`);
    if (cue.to === undefined) fail("counter requires to", `${pointer}.to`);
  } else if (cue.metricId !== undefined) {
    fail("metricId is only valid on counter cues", `${pointer}.metricId`);
  }
  return result;
}

function validateGraphic(raw, duration, pointer) {
  const cue = record(raw, pointer);
  keys(cue, GRAPHIC_KEYS, pointer);
  const result = {
    id: stableId(cue.id, `${pointer}.id`),
    kind: enumValue(cue.kind, GRAPHICS, `${pointer}.kind`),
    subject: concreteSubject(cue.subject, `${pointer}.subject`),
    subjectId: stableId(cue.subjectId, `${pointer}.subjectId`),
    ...validateFrameRange(cue, duration, pointer),
  };
  for (const name of ["x", "y", "width", "height"]) {
    if (cue[name] !== undefined) result[name] = number(cue[name], `${pointer}.${name}`, { minimum: name === "width" || name === "height" ? Number.MIN_VALUE : 0, maximum: 1 });
  }
  for (const name of ["color", "secondaryColor", "label"]) {
    if (cue[name] !== undefined) result[name] = name === "label" ? requiredString(cue[name], `${pointer}.${name}`) : validateColorish(cue[name], `${pointer}.${name}`);
  }
  return result;
}

function validateShot(raw, index) {
  const pointer = `$.shots[${index}]`;
  const shot = record(raw, pointer);
  keys(shot, SHOT_KEYS, pointer);
  const duration = integer(shot.durationInFrames, `${pointer}.durationInFrames`, { minimum: 1 });
  const result = {
    id: stableId(shot.id, `${pointer}.id`),
    durationInFrames: duration,
    background: validateAssetRef(shot.background, `${pointer}.background`),
    semanticRole: enumValue(shot.semanticRole, ROLES, `${pointer}.semanticRole`),
  };
  if (shot.camera !== undefined) result.camera = validateCamera(shot.camera, `${pointer}.camera`);
  if (shot.transitionIn !== undefined) result.transitionIn = validateTransition(shot.transitionIn, `${pointer}.transitionIn`);
  if (shot.transitionOut !== undefined) result.transitionOut = validateTransition(shot.transitionOut, `${pointer}.transitionOut`);
  if (shot.texts !== undefined) {
    if (!Array.isArray(shot.texts)) fail("must be an array", `${pointer}.texts`);
    result.texts = shot.texts.map((cue, cueIndex) => validateText(cue, duration, `${pointer}.texts[${cueIndex}]`));
  }
  if (shot.graphics !== undefined) {
    if (!Array.isArray(shot.graphics)) fail("must be an array", `${pointer}.graphics`);
    result.graphics = shot.graphics.map((cue, cueIndex) => validateGraphic(cue, duration, `${pointer}.graphics[${cueIndex}]`));
  }
  if (shot.tint !== undefined) result.tint = validateColorish(shot.tint, `${pointer}.tint`);
  if (shot.grain !== undefined) result.grain = number(shot.grain, `${pointer}.grain`, { minimum: 0, maximum: 1 });
  if (shot.sourceLabel !== undefined) result.sourceLabel = requiredString(shot.sourceLabel, `${pointer}.sourceLabel`);
  return result;
}

function validateRecipe(recipe) {
  const input = record(recipe, "$");
  keys(input, ROOT_KEYS, "$");
  if (input.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCHEMA_VERSION}`, "$.schemaVersion");
  }
  const fps = number(input.fps, "$.fps", { minimum: Number.MIN_VALUE });
  if (fps !== 30) fail("fps must be exactly 30 for the supported YouTube targets", "$.fps");
  const durationInFrames = integer(input.durationInFrames, "$.durationInFrames", { minimum: 1 });
  if (!Array.isArray(input.shots) || input.shots.length === 0) fail("shots must contain at least one shot", "$.shots");
  const result = {
    schemaVersion: SCHEMA_VERSION,
    fps,
    durationInFrames,
    shots: input.shots.map(validateShot),
  };
  if (input.title !== undefined) result.title = requiredString(input.title, "$.title");
  if (input.audioAssetId !== undefined) result.audioAssetId = requiredString(input.audioAssetId, "$.audioAssetId");
  if (input.audioMode !== undefined) result.audioMode = enumValue(input.audioMode, AUDIO_MODES, "$.audioMode");
  const shotSum = result.shots.reduce((sum, shot) => sum + shot.durationInFrames, 0);
  if (shotSum !== durationInFrames) fail(`must equal exact shot total ${shotSum}`, "$.durationInFrames");
  return result;
}

function inventoryEntries(assetInventory) {
  if (Array.isArray(assetInventory)) return assetInventory;
  const inventory = record(assetInventory, "assetInventory");
  if (!Array.isArray(inventory.assets)) fail("assets must be an array", "assetInventory.assets");
  return inventory.assets;
}

function inventoryIdentity(entry, index) {
  const pointer = `assetInventory.assets[${index}]`;
  const item = record(entry, pointer);
  const assetId = item.assetId ?? item.id;
  const stagedPath = item.stagedPath ?? item.path ?? item.src;
  if (typeof assetId !== "string" || !assetId.trim()) fail("assetId must be a non-empty string", `${pointer}.assetId`);
  if (typeof stagedPath !== "string" || !stagedPath.trim()) fail("stagedPath must be a non-empty string", `${pointer}.stagedPath`);
  if (/^(?:https?:|data:)/i.test(stagedPath)) fail("stagedPath must reference a staged local asset", `${pointer}.stagedPath`);
  // The durable asset-inventory contract is itself a verified snapshot: it
  // carries a content hash, byte size, and provenance. Keep accepting the
  // smaller legacy inventory shape while the compatibility CLI is alive.
  if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256))) {
    fail("sha256 must be a SHA-256 digest", `${pointer}.sha256`);
  }
  const hasInventoryHash = typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256);
  const verified = item.verified === true || ["completed", "verified", "locked"].includes(item.status) || hasInventoryHash;
  if (!verified) {
    fail("asset must be verified", pointer);
  }
  const kind = item.kind === "video" || item.assetType === "video" || item.assetType === "stock_video" || /\.(?:mp4|mov|webm|m4v)(?:$|[?#])/i.test(stagedPath)
    ? "video"
    : item.kind === "audio" || /\.(?:mp3|wav|m4a|aac|ogg|flac)(?:$|[?#])/i.test(stagedPath)
      ? "audio"
      : item.kind === "font" || /\.(?:ttf|otf|woff2?)(?:$|[?#])/i.test(stagedPath)
        ? "font"
        : "image";
  return { id: assetId, path: stagedPath, kind, sha256: hasInventoryHash ? item.sha256.toLowerCase() : undefined };
}

function buildAssetMap(assetInventory) {
  const map = new Map();
  inventoryEntries(assetInventory).forEach((entry, index) => {
    const normalized = inventoryIdentity(entry, index);
    if (map.has(normalized.id)) fail(`duplicate assetId ${normalized.id}`, `assetInventory.assets[${index}].assetId`);
    map.set(normalized.id, normalized);
  });
  return map;
}

function collectIdentityIds(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) collectIdentityIds(item, result);
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "id" || key.endsWith("Id")) && typeof child === "string" && child.trim()) result.add(child);
    collectIdentityIds(child, result);
  }
  return result;
}

function collectMetricRecords(value, result = new Map()) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) collectMetricRecords(item, result);
    return result;
  }
  const metricId = value.metricId ?? (value.type === "metric" ? value.id : undefined);
  if (typeof metricId === "string" && metricId.trim()) result.set(metricId, value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "metrics" && Array.isArray(child)) {
      for (const metric of child) {
        if (metric && typeof metric === "object" && !Array.isArray(metric)) {
          const id = metric.metricId ?? metric.id;
          if (typeof id === "string" && id.trim()) result.set(id, metric);
        }
      }
    }
    collectMetricRecords(child, result);
  }
  return result;
}

function validateIdentities(recipe, assetMap, metadata) {
  const identityIds = collectIdentityIds(metadata);
  for (const id of assetMap.keys()) identityIds.add(id);
  const metricRecords = collectMetricRecords(metadata);
  const seen = new Map();
  const claimIds = collectIdentityIds(metadata);
  for (const [shotIndex, shot] of recipe.shots.entries()) {
    const shotPointer = `$.shots[${shotIndex}]`;
    if (seen.has(shot.id)) fail(`duplicate node id ${shot.id}`, `${shotPointer}.id`);
    seen.set(shot.id, shotPointer);
    if (!assetMap.has(shot.background.assetId)) fail(`unresolved assetId ${shot.background.assetId}`, `${shotPointer}.background.assetId`);
    for (const [kind, cues] of [["texts", shot.texts ?? []], ["graphics", shot.graphics ?? []]]) {
      for (const [cueIndex, cue] of cues.entries()) {
        const pointer = `${shotPointer}.${kind}[${cueIndex}]`;
        if (seen.has(cue.id)) fail(`duplicate node id ${cue.id}`, `${pointer}.id`);
        seen.set(cue.id, pointer);
        if (!identityIds.has(cue.subjectId)) fail(`unresolved subjectId ${cue.subjectId}`, `${pointer}.subjectId`);
        if (cue.metricId !== undefined) {
          const metric = metricRecords.get(cue.metricId);
          if (!metric) fail(`unresolved metricId ${cue.metricId}`, `${pointer}.metricId`);
          const sourceNote = metric.sourceNote ?? metric.source ?? metric.sourceDescription;
          const evidence = metric.evidenceClaimId ?? metric.claimId ?? metric.evidenceId;
          if (typeof sourceNote !== "string" || !sourceNote.trim()) fail("metric source note is required", `${pointer}.metricId`);
          if (typeof evidence !== "string" || !evidence.trim() || !claimIds.has(evidence)) fail("metric evidence/claim reference is required", `${pointer}.metricId`);
        }
      }
    }
  }
}

function resolveTarget(target) {
  const candidate = target === undefined ? TARGET_PROFILES["youtube-720p"] : record(target, "target");
  const profileId = requiredString(candidate.profileId, "target.profileId");
  const expected = TARGET_PROFILES[profileId];
  if (!expected) fail(`unsupported target profile ${profileId}`, "target.profileId");
  for (const key of ["width", "height", "fps"]) {
    if (candidate[key] !== expected[key]) fail(`must exactly match ${profileId} (${expected[key]})`, `target.${key}`);
  }
  if (candidate.logicalWidth !== undefined && candidate.logicalWidth !== expected.logicalWidth) fail(`must exactly match ${expected.logicalWidth}`, "target.logicalWidth");
  if (candidate.logicalHeight !== undefined && candidate.logicalHeight !== expected.logicalHeight) fail(`must exactly match ${expected.logicalHeight}`, "target.logicalHeight");
  return expected;
}

function resolveAudio(recipe, assetMap, metadata) {
  const audioAssetId = recipe.audioAssetId ?? metadata?.audioAssetId;
  if (!audioAssetId) {
    if (recipe.audioMode === "required") fail("audioAssetId is required when audioMode is required", "$.audioAssetId");
    return { audioUrl: null, audioAssetId: null };
  }
  const audio = assetMap.get(audioAssetId);
  if (!audio) fail(`unresolved audio assetId ${audioAssetId}`, "$.audioAssetId");
  if (audio.kind !== "video" && audio.kind !== "audio" && !/\.(?:mp3|wav|m4a|aac|ogg|flac)(?:$|[?#])/i.test(audio.path)) {
    fail("audioAssetId must resolve to an audio inventory entry", "$.audioAssetId");
  }
  if (recipe.audioMode === "forbidden") fail("audioAssetId is forbidden when audioMode is forbidden", "$.audioAssetId");
  return { audioUrl: audio.path, audioAssetId };
}

function copyCue(cue) {
  return { ...cue };
}

function convertShot(shot, assetMap) {
  const asset = assetMap.get(shot.background.assetId);
  const background = {
    src: asset.path,
    assetId: shot.background.assetId,
    kind: asset.kind,
  };
  for (const key of ["fit", "position", "filter"]) if (shot.background[key] !== undefined) background[key] = shot.background[key];
  const result = {
    ...shot,
    background,
  };
  if (shot.texts !== undefined) result.texts = shot.texts.map(copyCue);
  if (shot.graphics !== undefined) result.graphics = shot.graphics.map(copyCue);
  return result;
}

/**
 * Convert a canonical v2 recipe into production Remotion props.
 *
 * The returned object is freshly allocated and safe for callers to mutate;
 * neither recipe nor inventory is changed during validation or conversion.
 */
export function buildMagnatesProps({ recipe, assetInventory, target, metadata = {} } = {}) {
  const canonical = validateRecipe(recipe);
  const targetProfile = resolveTarget(target);
  const assetMap = buildAssetMap(assetInventory);
  validateIdentities(canonical, assetMap, metadata);
  const audio = resolveAudio(canonical, assetMap, metadata);
  const props = {
    schemaVersion: 2,
    recipeSchemaVersion: SCHEMA_VERSION,
    kind: "magnates-editorial-recipe-props",
    compositionId: COMPOSITION_ID,
    visualMode: "magnates-editorial",
    title: canonical.title,
    fps: canonical.fps,
    width: targetProfile.width,
    height: targetProfile.height,
    logicalWidth: targetProfile.logicalWidth,
    logicalHeight: targetProfile.logicalHeight,
    targetProfileId: targetProfile.profileId,
    durationInFrames: canonical.durationInFrames,
    durationSeconds: canonical.durationInFrames / canonical.fps,
    audioUrl: audio.audioUrl,
    audioAssetId: audio.audioAssetId,
    shots: canonical.shots.map((shot) => convertShot(shot, assetMap)),
  };
  if (props.title === undefined) delete props.title;
  return props;
}

export const magnatesRecipeSchemaVersion = SCHEMA_VERSION;
