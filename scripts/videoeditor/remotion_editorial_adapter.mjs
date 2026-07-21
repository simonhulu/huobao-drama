#!/usr/bin/env node

/**
 * Project-local Magnates adapter.
 *
 * The process is intentionally a one-request/one-response JSON protocol. All
 * diagnostics go to stderr; stdout is reserved for exactly one response
 * object so the director can safely hash and validate it.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildMagnatesProps, MagnatesPropsError, TARGET_PROFILES, magnatesRecipeSchemaVersion } from "./magnates_props_core.mjs";

const PROTOCOL_VERSION = 1;
const ADAPTER = Object.freeze({ name: "huobao-remotion", version: "1.0.0" });
const COMPOSITION_ID = "MagnatesEditorial";
const PROJECT_PROPS_SCHEMA_ID = "editorial://project/huobao-drama/magnates-editorial-props/v2";
const REMOTION_PROPS_SCHEMA_ID = "editorial://schema/remotion-props/v1";
const TELEMETRY_NAMESPACE = "huobao.editorial.telemetry/v1";
const RENDER_MANIFEST_SCHEMA_ID = "editorial://schema/render-manifest/v1";
const INSPECT_REPORT_SCHEMA_ID = "editorial://schema/inspect-report/v1";
const LAYOUT_TELEMETRY_SCHEMA_ID = "editorial://schema/layout-telemetry/v1";
const NARRATION_CONFORM_SCHEMA_ID = "editorial://schema/narration-conform/v1";
const CONFORMED_NARRATION_ASSET_ID = "narration-conformed";
const DEFAULT_TELEMETRY_LIMITS = Object.freeze({
  maximumFramePacketBytes: 1024 * 1024,
  maximumRawTelemetryBytes: 64 * 1024 * 1024,
});
const ADAPTER_EXECUTABLE = fileURLToPath(import.meta.url);
const LOCAL_WORKSPACE = path.resolve(path.dirname(ADAPTER_EXECUTABLE), "../..");
const REQUEST_KEYS = new Set([
  "adapterProtocolVersion",
  "operationId",
  "operation",
  "recipeSchemaVersion",
  "workspace",
  "runDirectory",
  "target",
  "inputs",
  "outputs",
  "expectedHashes",
  "deadline",
]);
const TARGET_KEYS = new Set(["profileId", "width", "height", "fps"]);
const OUTPUT_POLICY_KEYS = new Set([
  "container",
  "codec",
  "pixelFormat",
  "audioMode",
  "audioCodec",
  "videoBitrate",
  "crf",
  "safeArea",
  "durationToleranceFrames",
  "audioToleranceFrames",
  "hardwareAcceleration",
]);
const OPERATIONS = new Set(["capabilities", "build-props", "render", "inspect"]);
const EXIT = Object.freeze({
  success: 0,
  internal: 1,
  invalidInput: 2,
  protocolMismatch: 3,
  asset: 4,
  operation: 5,
  inspection: 6,
  protocol: 7,
  cancelled: 130,
});

export class AdapterError extends Error {
  constructor(code, category, message, {
    retryable = false,
    stage = "adapter",
    details = undefined,
    exitCode = EXIT.operation,
  } = {}) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.stage = stage;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function object(value, pointer) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer} must be an object`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  return value;
}

function keys(value, allowed, pointer, { required = [] } = {}) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer}.${key} is not allowed`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  for (const key of required) {
    if (!(key in value)) throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer}.${key} is required`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
}

function nonEmptyString(value, pointer) {
  if (typeof value !== "string" || !value.trim()) throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer} must be a non-empty string`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  return value;
}

function validateTarget(raw) {
  const target = object(raw, "target");
  keys(target, TARGET_KEYS, "target", { required: ["profileId", "width", "height", "fps"] });
  const expected = TARGET_PROFILES[target.profileId];
  if (!expected) throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", `target.profileId ${String(target.profileId)} is unsupported`, { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  for (const key of ["width", "height", "fps"]) {
    if (target[key] !== expected[key]) throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", `target.${key} must equal ${expected[key]}`, { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  }
  return expected;
}

function sameTarget(left, right) {
  return Boolean(left && right)
    && left.profileId === right.profileId
    && left.width === right.width
    && left.height === right.height
    && left.fps === right.fps;
}

function validateOutputPolicy(raw, props) {
  const policy = object(raw, "rendererEnvironmentLock.outputPolicy");
  keys(policy, OUTPUT_POLICY_KEYS, "rendererEnvironmentLock.outputPolicy", {
    required: ["container", "codec", "pixelFormat", "audioMode", "safeArea"],
  });
  if (policy.container !== "mp4" || policy.codec !== "h264" || policy.pixelFormat !== "yuv420p") {
    throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", "renderer output policy must use mp4/h264/yuv420p", { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  }
  if (!["required", "optional", "forbidden"].includes(policy.audioMode)) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "renderer output policy audioMode is unsupported", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  if (policy.audioCodec !== undefined && policy.audioCodec !== "aac") {
    throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", "renderer output policy audioCodec must be aac", { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  }
  const hasBitrate = typeof policy.videoBitrate === "string" && /^[1-9][0-9]*(?:k|M)$/u.test(policy.videoBitrate);
  const hasCrf = Number.isInteger(policy.crf) && policy.crf >= 0 && policy.crf <= 51;
  if (hasBitrate === hasCrf) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "renderer output policy must specify exactly one of videoBitrate or crf", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  if (policy.videoBitrate !== undefined && !hasBitrate) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "renderer output policy videoBitrate is malformed", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  if (policy.crf !== undefined && !hasCrf) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "renderer output policy crf is malformed", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  const safeArea = object(policy.safeArea, "rendererEnvironmentLock.outputPolicy.safeArea");
  keys(safeArea, new Set(["left", "right", "top", "bottom"]), "rendererEnvironmentLock.outputPolicy.safeArea", { required: ["left", "right", "top", "bottom"] });
  for (const edge of ["left", "right", "top", "bottom"]) {
    if (typeof safeArea[edge] !== "number" || !Number.isFinite(safeArea[edge]) || safeArea[edge] < 0 || safeArea[edge] > 0.5) {
      throw new AdapterError("INVALID_INPUT", "invalid_input", `renderer output policy safeArea.${edge} is outside [0, 0.5]`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
    }
  }
  for (const field of ["durationToleranceFrames", "audioToleranceFrames"]) {
    if (policy[field] !== undefined && (!Number.isInteger(policy[field]) || policy[field] < 0 || policy[field] > 10)) {
      throw new AdapterError("INVALID_INPUT", "invalid_input", `renderer output policy ${field} is malformed`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
    }
  }
  if (policy.hardwareAcceleration !== undefined && !["disabled", "required"].includes(policy.hardwareAcceleration)) {
    throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", "renderer output policy hardwareAcceleration is unsupported", { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  }
  if (policy.audioMode === "required" && !props.audioUrl) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "renderer output policy requires audio but props contain no audio asset", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  if (policy.audioMode === "forbidden" && props.audioUrl) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "renderer output policy forbids audio but props contain an audio asset", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  return structuredClone(policy);
}

function validateRequest(raw) {
  const request = object(raw, "request");
  keys(request, REQUEST_KEYS, "request", {
    required: ["adapterProtocolVersion", "operationId", "operation", "recipeSchemaVersion", "workspace", "runDirectory", "target", "inputs", "outputs", "expectedHashes", "deadline"],
  });
  if (request.adapterProtocolVersion !== PROTOCOL_VERSION) throw new AdapterError("PROTOCOL_VERSION_MISMATCH", "protocol_mismatch", `adapterProtocolVersion ${String(request.adapterProtocolVersion)} is unsupported`, { stage: "ADAPTER_READY", exitCode: EXIT.protocol });
  nonEmptyString(request.operationId, "operationId");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.operationId)) throw new AdapterError("INVALID_INPUT", "invalid_input", "operationId must be a UUID", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (!OPERATIONS.has(request.operation)) throw new AdapterError("INVALID_INPUT", "invalid_input", `operation ${String(request.operation)} is unsupported`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (request.recipeSchemaVersion !== magnatesRecipeSchemaVersion) throw new AdapterError("INVALID_INPUT", "invalid_input", `recipeSchemaVersion must be ${magnatesRecipeSchemaVersion}`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  nonEmptyString(request.workspace, "workspace");
  nonEmptyString(request.runDirectory, "runDirectory");
  if (!path.isAbsolute(request.workspace) || !path.isAbsolute(request.runDirectory)) throw new AdapterError("INVALID_INPUT", "invalid_input", "workspace and runDirectory must be absolute paths", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  validateTarget(request.target);
  object(request.inputs, "inputs");
  object(request.outputs, "outputs");
  object(request.expectedHashes, "expectedHashes");
  for (const [key, value] of Object.entries(request.expectedHashes)) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new AdapterError("INVALID_INPUT", "invalid_input", `expectedHashes.${key} must be a SHA-256 hex digest`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
    }
  }
  nonEmptyString(request.deadline, "deadline");
  if (!Number.isNaN(Date.parse(request.deadline))) {
    // Date.parse is deliberately used only as a syntax guard; the director
    // owns deadline policy and process cancellation.
  } else {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "deadline must be RFC3339 date-time", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  const inputKeys = request.inputs && Object.keys(request.inputs);
  const outputKeys = request.outputs && Object.keys(request.outputs);
  if (request.operation === "capabilities") {
    if (inputKeys.length || outputKeys.length) throw new AdapterError("INVALID_INPUT", "invalid_input", "capabilities inputs and outputs must be empty", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  } else if (request.operation === "build-props") {
    keys(request.inputs, new Set(["recipePayload", "recipeLock", "assetInventory", "narrationConform"]), "inputs", { required: ["recipePayload", "recipeLock", "assetInventory"] });
    keys(request.outputs, new Set(["props", "buildTelemetry"]), "outputs", { required: ["props", "buildTelemetry"] });
  } else if (request.operation === "render") {
    keys(request.inputs, new Set(["props", "propsHash", "compositionId", "rendererEnvironmentLock"]), "inputs", { required: ["props", "propsHash", "compositionId", "rendererEnvironmentLock"] });
    keys(request.outputs, new Set(["media", "renderManifest", "renderTelemetry"]), "outputs", { required: ["media", "renderManifest", "renderTelemetry"] });
  } else if (request.operation === "inspect") {
    keys(request.inputs, new Set(["media", "mediaHash", "renderManifest", "renderTelemetry"]), "inputs", { required: ["media", "mediaHash", "renderManifest", "renderTelemetry"] });
    keys(request.outputs, new Set(["inspectReport", "layoutTelemetry"]), "outputs", { required: ["inspectReport", "layoutTelemetry"] });
  }
  const pathFields = request.operation === "build-props"
    ? [...Object.keys(request.inputs), ...Object.keys(request.outputs)]
    : request.operation === "render"
      ? ["props", "rendererEnvironmentLock", ...Object.keys(request.outputs)]
      : request.operation === "inspect"
        ? ["media", "renderManifest", "renderTelemetry", ...Object.keys(request.outputs)]
        : [];
  const pathValues = [...Object.entries(request.inputs), ...Object.entries(request.outputs)];
  for (const [key, value] of pathValues) {
    if (pathFields.includes(key) && (typeof value !== "string" || !path.isAbsolute(value))) {
      throw new AdapterError("INVALID_INPUT", "invalid_input", `${key} must be an absolute path`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
    }
  }
  return request;
}

// JSON object member order is not part of the recipe contract. Hash the
// canonical value so equivalent payloads produce the same recipe identity
// regardless of how an upstream writer ordered its keys.
function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AdapterError("INVALID_INPUT", "invalid_input", "canonical JSON cannot contain a non-finite number", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new AdapterError("INVALID_INPUT", "invalid_input", "canonical JSON cannot contain an unsupported value", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
}

function hashCanonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sha256File(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function existingFile(candidates) {
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (sha256File(absolute)) return absolute;
  }
  return null;
}

function commandFile(command, candidates = []) {
  const fromCandidates = existingFile(candidates);
  if (fromCandidates) return fromCandidates;
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return existingFile(pathEntries.map((entry) => path.join(entry, command))) ?? null;
}

function executableVersion(filePath, args) {
  if (!filePath) return "unknown";
  try {
    const result = spawnSync(filePath, args, { encoding: "utf8", timeout: 10_000 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/u);
    return match?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function requiredIdentityFile(label, candidates) {
  const filePath = existingFile(candidates);
  if (!filePath) {
    throw new AdapterError(
      "ADAPTER_ENVIRONMENT_UNAVAILABLE",
      "adapter_failure",
      `${label} executable or package file was not found`,
      { stage: "ADAPTER_READY", retryable: false, exitCode: EXIT.operation },
    );
  }
  return filePath;
}

function toolIdentity(label, filePath, versionArgs) {
  const sha256 = sha256File(filePath);
  if (!sha256) {
    throw new AdapterError(
      "ADAPTER_ENVIRONMENT_UNAVAILABLE",
      "adapter_failure",
      `${label} identity file could not be read`,
      { stage: "ADAPTER_READY", retryable: false, exitCode: EXIT.operation },
    );
  }
  return {
    path: filePath,
    version: executableVersion(filePath, versionArgs),
    sha256,
  };
}

function fontIdentity(workspace) {
  const fontPath = existingFile([
    path.join(workspace, "remotion/public/fonts/Arial.ttf"),
    path.join(LOCAL_WORKSPACE, "remotion/public/fonts/Arial.ttf"),
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf",
  ]);
  if (!fontPath) {
    throw new AdapterError(
      "ADAPTER_ENVIRONMENT_UNAVAILABLE",
      "adapter_failure",
      "Arial system font could not be identified",
      { stage: "ADAPTER_READY", retryable: false, exitCode: EXIT.operation },
    );
  }
  return { "Arial.system": sha256File(fontPath) };
}

function capabilities(request) {
  const workspace = request?.workspace || "/project";
  const remotionCli = requiredIdentityFile("Remotion CLI", [
    path.join(workspace, "remotion/node_modules/.bin/remotion"),
    path.join(LOCAL_WORKSPACE, "remotion/node_modules/.bin/remotion"),
  ]);
  const packageLock = requiredIdentityFile("Remotion package lock", [
    path.join(workspace, "remotion/package-lock.json"),
    path.join(LOCAL_WORKSPACE, "remotion/package-lock.json"),
  ]);
  const browser = requiredIdentityFile("Chrome headless shell", [
    path.join(workspace, "remotion/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    path.join(workspace, "remotion/node_modules/.remotion/chrome-headless-shell/linux-x64/chrome-headless-shell-linux-x64/chrome-headless-shell"),
    path.join(workspace, "remotion/node_modules/.remotion/chrome-headless-shell/chrome-headless-shell"),
    path.join(LOCAL_WORKSPACE, "remotion/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    path.join(LOCAL_WORKSPACE, "remotion/node_modules/.remotion/chrome-headless-shell/linux-x64/chrome-headless-shell-linux-x64/chrome-headless-shell"),
    path.join(LOCAL_WORKSPACE, "remotion/node_modules/.remotion/chrome-headless-shell/chrome-headless-shell"),
  ]);
  const ffmpeg = commandFile("ffmpeg", ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]);
  const ffprobe = commandFile("ffprobe", ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);
  const ffmpegFile = requiredIdentityFile("ffmpeg", ffmpeg ? [ffmpeg] : []);
  const ffprobeFile = requiredIdentityFile("ffprobe", ffprobe ? [ffprobe] : []);
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  return {
    adapter: ADAPTER,
    supportedProtocolVersions: [PROTOCOL_VERSION],
    recipeSchemaVersions: [magnatesRecipeSchemaVersion],
    operations: ["capabilities", "build-props", "render", "inspect"],
    compositionIds: [COMPOSITION_ID],
    targetProfiles: Object.values(TARGET_PROFILES).map(({ profileId, width, height, fps }) => ({ profileId, width, height, fps })),
    audioModes: ["required", "optional", "forbidden"],
    telemetryFields: ["layerId", "frameInterval", "boundingBox", "opacity", "transform", "maskBounds", "assetId", "decodeStatus"],
    schemaDigests: {
      ["editorial://schema/adapter-request/v1"]: digest("editorial://schema/adapter-request/v1"),
      ["editorial://schema/adapter-response/v1"]: digest("editorial://schema/adapter-response/v1"),
    },
    environmentIdentity: {
      remotion: toolIdentity("Remotion CLI", remotionCli, ["--version"]),
      packageLockHash: sha256File(packageLock),
      browser: toolIdentity("Chrome headless shell", browser, ["--version"]),
      fontHashes: fontIdentity(workspace),
      nodeVersion: process.version,
      os: process.platform === "linux" ? "linux" : "darwin",
      architecture: process.arch === "x64" ? "x64" : "arm64",
      ffmpeg: toolIdentity("ffmpeg", ffmpegFile, ["-version"]),
      ffprobe: toolIdentity("ffprobe", ffprobeFile, ["-version"]),
      supportedCodecs: ["h264", "aac"],
      adapterExecutableHash: sha256File(ADAPTER_EXECUTABLE),
      adapterConfigHash: digest("huobao-remotion-adapter-config-v1"),
    },
  };
}

function ensureContained(runDirectory, candidate, pointer) {
  const resolvedRun = path.resolve(runDirectory);
  const resolvedCandidate = path.resolve(runDirectory, candidate);
  const relative = path.relative(resolvedRun, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer} must remain inside runDirectory`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  return resolvedCandidate;
}

function outputPathFor(request, key) {
  const candidate = request.outputs[key];
  if (typeof candidate !== "string" || !candidate.trim()) throw new AdapterError("INVALID_INPUT", "invalid_input", `outputs.${key} must be a non-empty string`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  return ensureContained(request.runDirectory, candidate, `outputs.${key}`);
}

function readJsonArtifact(request, value, pointer, hashKey) {
  const bytes = readArtifactBytes(request, value, pointer, hashKey);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new AdapterError("ASSET_FAILURE", "asset_failure", `${pointer} could not be read as JSON`, { stage: "ADAPTER_READY", details: { artifactPath: ensureContained(request.runDirectory, value, pointer) }, exitCode: EXIT.asset });
  }
}

function readArtifactBytes(request, value, pointer, hashKey, stage = "ADAPTER_READY") {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer} must be an absolute JSON path`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  const absolute = ensureContained(request.runDirectory, value, pointer);
  try {
    const bytes = fs.readFileSync(absolute);
    const expected = request.expectedHashes[hashKey] ?? (hashKey === "propsHash" ? request.expectedHashes.props : undefined);
    if (expected) {
      const actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (actual !== expected) {
        throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", `${pointer} hash does not match expectedHashes.${hashKey}`, { stage, details: { artifactPath: absolute }, exitCode: EXIT.asset });
      }
    }
    return bytes;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("ASSET_FAILURE", "asset_failure", `${pointer} could not be read`, { stage, details: { artifactPath: absolute }, exitCode: EXIT.asset });
  }
}

function inventoryItems(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.assets)) return value.assets;
  throw new AdapterError("INVALID_INPUT", "invalid_input", "assetInventory.assets must be an array", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
}

function inventoryAssetId(item, index) {
  const id = item?.assetId ?? item?.id;
  if (typeof id !== "string" || !id.trim()) throw new AdapterError("INVALID_INPUT", "invalid_input", `assetInventory.assets[${index}].assetId must be a non-empty string`, { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  return id;
}

function inventoryAssetPath(item, index, workspace) {
  const raw = item?.stagedPath ?? item?.path ?? item?.src;
  if (typeof raw !== "string" || !raw.trim() || /^(?:https?:|data:)/i.test(raw)) {
    throw new AdapterError("ASSET_FAILURE", "asset_failure", `assetInventory.assets[${index}] does not reference a staged local asset`, { stage: "PROPS_BUILT", exitCode: EXIT.asset });
  }
  return path.resolve(workspace, raw);
}

function inventoryAssetKind(item, assetPath) {
  if (["image", "video", "audio", "font"].includes(item?.kind)) return item.kind;
  if (item?.assetType === "video" || item?.assetType === "stock_video" || /\.(?:mp4|mov|webm|m4v)(?:$|[?#])/i.test(assetPath)) return "video";
  if (/\.(?:mp3|wav|m4a|aac|ogg|flac)(?:$|[?#])/i.test(assetPath)) return "audio";
  if (/\.(?:ttf|otf|woff2?)(?:$|[?#])/i.test(assetPath)) return "font";
  return "image";
}

function inventoryAssetHash(item, assetPath, index) {
  if (item?.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256))) {
    throw new AdapterError("ASSET_FAILURE", "asset_failure", `assetInventory.assets[${index}].sha256 must be a SHA-256 digest`, { stage: "PROPS_BUILT", exitCode: EXIT.asset });
  }
  if (typeof item?.sha256 === "string") {
    const expected = item.sha256.toLowerCase();
    if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
      if (actual !== expected) {
        throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", `assetInventory.assets[${index}] does not match its declared SHA-256`, { stage: "PROPS_BUILT", details: { artifactPath: assetPath }, exitCode: EXIT.asset });
      }
    }
    return expected;
  }
  // Compatibility inventories predating the durable asset schema may only
  // declare `verified`. Prefer a real file hash when available; the path
  // digest keeps old fixture-only inventories deterministic without changing
  // the behavior of full inventories, which must carry their own SHA-256.
  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    return crypto.createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  }
  if (item?.verified === true || ["completed", "verified", "locked"].includes(item?.status)) {
    return crypto.createHash("sha256").update(assetPath).digest("hex");
  }
  throw new AdapterError("ASSET_FAILURE", "asset_failure", `assetInventory.assets[${index}] is missing a verified SHA-256`, { stage: "PROPS_BUILT", exitCode: EXIT.asset });
}

function referencedAssetIds(props) {
  const ids = new Set();
  for (const shot of props.shots ?? []) {
    if (shot.background?.assetId) ids.add(shot.background.assetId);
  }
  if (props.audioAssetId) ids.add(props.audioAssetId);
  return ids;
}

function buildAssetBindings(assetInventory, props, workspace) {
  const requested = referencedAssetIds(props);
  const bindings = {};
  const seen = new Set();
  inventoryItems(assetInventory).forEach((item, index) => {
    const assetId = inventoryAssetId(item, index);
    if (seen.has(assetId)) throw new AdapterError("INVALID_INPUT", "invalid_input", `duplicate assetId ${assetId}`, { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
    seen.add(assetId);
    if (!requested.has(assetId)) return;
    const absolutePath = inventoryAssetPath(item, index, workspace);
    bindings[assetId] = {
      kind: inventoryAssetKind(item, absolutePath),
      path: absolutePath,
      sha256: inventoryAssetHash(item, absolutePath, index),
    };
  });
  for (const assetId of requested) {
    if (!bindings[assetId]) throw new AdapterError("ASSET_FAILURE", "asset_failure", `assetInventory does not contain referenced assetId ${assetId}`, { stage: "PROPS_BUILT", exitCode: EXIT.asset });
  }
  return bindings;
}

function containedAudioFile(request, candidate, pointer) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer}.path must be an absolute path`, { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  const absolutePath = ensureContained(request.runDirectory, candidate, `${pointer}.path`);
  let realRunDirectory;
  let realAudioPath;
  let stats;
  try {
    realRunDirectory = fs.realpathSync(request.runDirectory);
    realAudioPath = fs.realpathSync(absolutePath);
    stats = fs.statSync(realAudioPath);
  } catch {
    throw new AdapterError("ASSET_FAILURE", "asset_failure", `${pointer}.path does not reference a readable conformed audio file`, { stage: "PROPS_BUILT", details: { artifactPath: absolutePath }, exitCode: EXIT.asset });
  }
  const relative = path.relative(realRunDirectory, realAudioPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", `${pointer}.path must remain inside runDirectory`, { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  if (!stats.isFile()) {
    throw new AdapterError("ASSET_FAILURE", "asset_failure", `${pointer}.path is not a file`, { stage: "PROPS_BUILT", details: { artifactPath: absolutePath }, exitCode: EXIT.asset });
  }
  return absolutePath;
}

function prepareNarrationConform(request, assetInventory, recipePayload) {
  const narrationConformPath = request.inputs.narrationConform;
  if (narrationConformPath === undefined) {
    return { assetInventory, metadata: assetInventory, recipe: recipePayload };
  }
  if (!request.expectedHashes.narrationConform) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "expectedHashes.narrationConform is required when inputs.narrationConform is supplied", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  const conform = readJsonArtifact(request, narrationConformPath, "inputs.narrationConform", "narrationConform");
  object(conform, "narrationConform");
  if (conform.schemaVersion !== NARRATION_CONFORM_SCHEMA_ID) {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", `narrationConform.schemaVersion must be ${NARRATION_CONFORM_SCHEMA_ID}`, { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  if (!["required", "optional", "forbidden"].includes(conform.audioMode)) {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "narrationConform.audioMode is unsupported", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  if (!["conformed", "absent"].includes(conform.status)) {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "narrationConform.status is unsupported", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  if (conform.status === "absent") {
    if (conform.output !== null) {
      throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "absent narrationConform output must be null", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
    }
    if (conform.audioMode === "required") {
      throw new AdapterError("INVALID_INPUT", "invalid_input", "narrationConform is absent but audioMode is required", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
    }
    return { assetInventory, metadata: assetInventory, recipe: recipePayload };
  }
  if (conform.audioMode === "forbidden") {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "conformed narration is forbidden by audioMode", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  const output = object(conform.output, "narrationConform.output");
  if (output.schemaId !== "audio/wav") {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "narrationConform.output.schemaId must be audio/wav", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  if (typeof output.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(output.sha256)) {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "narrationConform.output.sha256 must be a SHA-256 digest", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  const audioPath = containedAudioFile(request, output.path, "narrationConform.output");
  const actualHash = sha256File(audioPath);
  if (actualHash !== output.sha256.toLowerCase()) {
    throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", "narrationConform.output does not match its declared SHA-256", { stage: "PROPS_BUILT", details: { artifactPath: audioPath }, exitCode: EXIT.asset });
  }
  const existing = inventoryItems(assetInventory).some((item) => (item?.assetId ?? item?.id) === CONFORMED_NARRATION_ASSET_ID);
  if (existing) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", `assetInventory already contains reserved assetId ${CONFORMED_NARRATION_ASSET_ID}`, { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  const audioAsset = {
    assetId: CONFORMED_NARRATION_ASSET_ID,
    kind: "audio",
    stagedPath: audioPath,
    sha256: output.sha256.toLowerCase(),
    verified: true,
  };
  const temporaryInventory = Array.isArray(assetInventory)
    ? [...assetInventory, audioAsset]
    : { ...assetInventory, assets: [...inventoryItems(assetInventory), audioAsset] };
  const metadata = Array.isArray(assetInventory)
    ? { audioAssetId: CONFORMED_NARRATION_ASSET_ID }
    : { ...assetInventory, audioAssetId: CONFORMED_NARRATION_ASSET_ID };
  const recipe = { ...recipePayload, audioAssetId: CONFORMED_NARRATION_ASSET_ID };
  return { assetInventory: temporaryInventory, metadata, recipe };
}

function validateRecipeLock(recipeLock, recipeHash) {
  if (!recipeLock || typeof recipeLock !== "object" || Array.isArray(recipeLock)) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "recipeLock must be an object", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
  if (recipeLock.payloadHash !== undefined && recipeLock.payloadHash !== recipeHash) {
    throw new AdapterError("INVALID_INPUT", "invalid_input", "recipeLock.payloadHash does not match recipePayload", { stage: "PROPS_BUILT", exitCode: EXIT.invalidInput });
  }
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes, pointer, stage, detailsPath) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    const inspection = stage === "INSPECTED";
    throw new AdapterError(inspection ? "ADAPTER_INSPECTION_FAILED" : "MALFORMED_OUTPUT", inspection ? "inspection_failure" : "protocol_failure", `${pointer} is not valid JSON`, {
      stage,
      details: detailsPath ? { artifactPath: detailsPath } : undefined,
      exitCode: inspection ? EXIT.inspection : EXIT.protocol,
    });
  }
}

function validatePropsEnvelope(envelope, request) {
  object(envelope, "propsEnvelope");
  if (envelope.schemaVersion !== REMOTION_PROPS_SCHEMA_ID) throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", `props.schemaVersion must be ${REMOTION_PROPS_SCHEMA_ID}`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (envelope.recipeSchemaVersion !== magnatesRecipeSchemaVersion) throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", `props.recipeSchemaVersion must be ${magnatesRecipeSchemaVersion}`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (!/^[a-f0-9]{64}$/i.test(envelope.recipeHash ?? "")) throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "props.recipeHash must be a SHA-256 digest", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (!Number.isInteger(envelope.durationInFrames) || envelope.durationInFrames < 1) throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "props.durationInFrames must be a positive integer", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (envelope.fps !== 30) throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "props.fps must be 30", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  if (envelope.compositionId !== COMPOSITION_ID || request.inputs.compositionId !== COMPOSITION_ID) throw new AdapterError("INVALID_INPUT", "invalid_input", `render compositionId must be ${COMPOSITION_ID}`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  const target = object(envelope.target, "props.target");
  for (const key of ["profileId", "width", "height", "fps"]) {
    if (target[key] !== request.target[key]) throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", `props.target.${key} does not match the render request`, { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  }
  const props = object(envelope.props, "propsEnvelope.props");
  if (props.schemaVersion !== 2 || props.recipeSchemaVersion !== magnatesRecipeSchemaVersion || props.compositionId !== COMPOSITION_ID || props.kind !== "magnates-editorial-recipe-props" || props.visualMode !== "magnates-editorial") {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "propsEnvelope.props is not canonical MagnatesEditorial production props", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  if (props.durationInFrames !== envelope.durationInFrames || props.fps !== envelope.fps || props.targetProfileId !== target.profileId || props.width !== target.width || props.height !== target.height) {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "props envelope metadata does not match nested production props", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  object(envelope.assetBindings, "propsEnvelope.assetBindings");
  for (const [assetId, binding] of Object.entries(envelope.assetBindings)) {
    object(binding, `propsEnvelope.assetBindings.${assetId}`);
    if (!["image", "video", "audio", "font"].includes(binding.kind) || typeof binding.path !== "string" || !path.isAbsolute(binding.path) || !/^[a-f0-9]{64}$/i.test(binding.sha256 ?? "")) {
      throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", `asset binding ${assetId} is malformed`, { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
    }
  }
  return { props, assetBindings: envelope.assetBindings, recipeHash: envelope.recipeHash.toLowerCase(), durationInFrames: envelope.durationInFrames };
}

function executablePath(candidates) {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile() && (process.platform === "win32" || (fs.statSync(candidate).mode & 0o111))) return candidate;
    } catch {
      // Try the next installation candidate.
    }
  }
  return null;
}

function findBrowserExecutable(workspace) {
  const remotionRoot = path.join(workspace, "remotion");
  const candidates = [
    path.join(remotionRoot, "node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    path.join(remotionRoot, "node_modules/.remotion/chrome-headless-shell/linux-x64/chrome-headless-shell-linux-x64/chrome-headless-shell"),
    path.join(remotionRoot, "node_modules/.remotion/chrome-headless-shell/chrome-headless-shell"),
  ];
  return executablePath(candidates);
}

function ffprobeExecutable() {
  const candidates = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"];
  return executablePath(candidates) ?? "ffprobe";
}

function probeMedia(mediaPath, { stage = "RENDERED" } = {}) {
  const ffprobe = ffprobeExecutable();
  const result = spawnSync(ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-print_format", "json",
    mediaPath,
  ], { encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new AdapterError(stage === "INSPECTED" ? "ADAPTER_INSPECTION_FAILED" : "ADAPTER_OPERATION_FAILED", stage === "INSPECTED" ? "inspection_failure" : "adapter_failure", `ffprobe could not decode ${mediaPath}`, { stage, details: { artifactPath: mediaPath }, exitCode: stage === "INSPECTED" ? EXIT.inspection : EXIT.operation });
  }
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new AdapterError(stage === "INSPECTED" ? "ADAPTER_INSPECTION_FAILED" : "ADAPTER_OPERATION_FAILED", stage === "INSPECTED" ? "inspection_failure" : "adapter_failure", "ffprobe returned malformed JSON", { stage, exitCode: stage === "INSPECTED" ? EXIT.inspection : EXIT.operation });
  }
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new AdapterError(stage === "INSPECTED" ? "ADAPTER_INSPECTION_FAILED" : "ADAPTER_OPERATION_FAILED", stage === "INSPECTED" ? "inspection_failure" : "adapter_failure", "rendered media has no video stream", { stage, exitCode: stage === "INSPECTED" ? EXIT.inspection : EXIT.operation });
  const duration = Number(video.duration ?? metadata.format?.duration);
  const frameCount = Number.parseInt(video.nb_read_frames ?? video.nb_frames, 10);
  const fallbackFrameCount = Number.isFinite(duration) && duration > 0
    ? Math.max(1, Math.round(duration * parseRate(video.avg_frame_rate || video.r_frame_rate || "30/1")))
    : 0;
  const normalizedFrameCount = Number.isInteger(frameCount) && frameCount > 0 ? frameCount : fallbackFrameCount;
  if (!normalizedFrameCount || !Number.isFinite(duration) || duration <= 0) throw new AdapterError(stage === "INSPECTED" ? "ADAPTER_INSPECTION_FAILED" : "ADAPTER_OPERATION_FAILED", stage === "INSPECTED" ? "inspection_failure" : "adapter_failure", "ffprobe returned no usable duration/frame count", { stage, exitCode: stage === "INSPECTED" ? EXIT.inspection : EXIT.operation });
  return {
    frameCount: normalizedFrameCount,
    durationSeconds: duration,
    streams: streams.map((stream, index) => ({
      index,
      kind: stream.codec_type === "audio" ? "audio" : stream.codec_type === "video" ? "video" : null,
      codec: stream.codec_name || "unknown",
      durationSeconds: Number(stream.duration ?? metadata.format?.duration ?? duration),
      ...(stream.width ? { width: Number(stream.width) } : {}),
      ...(stream.height ? { height: Number(stream.height) } : {}),
      ...(stream.sample_rate ? { sampleRate: Number(stream.sample_rate) } : {}),
      ...(stream.channels ? { channels: Number(stream.channels) } : {}),
    })).filter((stream) => stream.kind),
  };
}

function parseRate(value) {
  const [numerator, denominator] = String(value).split("/").map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : 30;
}

function safeAssetFilename(assetId, sourcePath, kind) {
  const extension = path.extname(sourcePath).replace(/[^A-Za-z0-9.]/g, "").slice(0, 12);
  const fallback = kind === "video" ? ".mp4" : kind === "audio" ? ".m4a" : kind === "font" ? ".woff2" : ".bin";
  return `${assetId.replace(/[^A-Za-z0-9._-]/g, "_")}${extension || fallback}`;
}

function stageRenderAssets(envelope, request) {
  const publicDir = ensureContained(request.runDirectory, "render-public", "render-public");
  fs.rmSync(publicDir, { recursive: true, force: true });
  fs.mkdirSync(publicDir, { recursive: true });
  const stagedNames = {};
  for (const [assetId, binding] of Object.entries(envelope.assetBindings)) {
    let stats;
    try {
      stats = fs.statSync(binding.path);
    } catch {
      throw new AdapterError("ASSET_FAILURE", "asset_failure", `asset binding ${assetId} does not exist`, { stage: "ADAPTER_READY", details: { artifactPath: binding.path }, exitCode: EXIT.asset });
    }
    if (!stats.isFile()) throw new AdapterError("ASSET_FAILURE", "asset_failure", `asset binding ${assetId} is not a file`, { stage: "ADAPTER_READY", details: { artifactPath: binding.path }, exitCode: EXIT.asset });
    const actualHash = sha256Bytes(fs.readFileSync(binding.path));
    if (actualHash !== binding.sha256.toLowerCase()) throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", `asset binding ${assetId} does not match its declared SHA-256`, { stage: "ADAPTER_READY", details: { artifactPath: binding.path }, exitCode: EXIT.asset });
    const filename = safeAssetFilename(assetId, binding.path, binding.kind);
    fs.copyFileSync(binding.path, path.join(publicDir, filename));
    stagedNames[assetId] = `public/${filename}`;
  }
  const props = structuredClone(envelope.props);
  for (const shot of props.shots ?? []) {
    const assetId = shot.background?.assetId;
    if (!assetId || !stagedNames[assetId]) throw new AdapterError("ASSET_FAILURE", "asset_failure", `production props references unbound background asset ${String(assetId)}`, { stage: "ADAPTER_READY", exitCode: EXIT.asset });
    shot.background.src = stagedNames[assetId];
  }
  if (props.audioAssetId) {
    if (!stagedNames[props.audioAssetId]) throw new AdapterError("ASSET_FAILURE", "asset_failure", `production props references unbound audio asset ${props.audioAssetId}`, { stage: "ADAPTER_READY", exitCode: EXIT.asset });
    props.audioUrl = stagedNames[props.audioAssetId];
  }
  return { props, publicDir };
}

function layerIntervalsForProps(props) {
  const intervals = {};
  let shotStart = 0;
  for (const shot of props.shots ?? []) {
    const shotEnd = shotStart + shot.durationInFrames;
    intervals[`shot:${shot.id}:background`] = { startFrame: shotStart, endFrame: shotEnd };
    for (const cue of [...(shot.texts ?? []), ...(shot.graphics ?? [])]) {
      const id = `cue:${cue.id}:root`;
      intervals[id] = { startFrame: shotStart + cue.startFrame, endFrame: shotStart + cue.endFrame };
    }
    shotStart = shotEnd;
  }
  return intervals;
}

function telemetryLimits(durationInFrames, layerIntervals) {
  const visibleLayers = Math.max(1, Object.keys(layerIntervals).length);
  return {
    maximumRenderedFrames: durationInFrames,
    maximumVisibleLayersPerFrame: Math.min(10000, visibleLayers),
    maximumFramePacketBytes: DEFAULT_TELEMETRY_LIMITS.maximumFramePacketBytes,
    maximumRawTelemetryBytes: Math.max(DEFAULT_TELEMETRY_LIMITS.maximumRawTelemetryBytes, durationInFrames * DEFAULT_TELEMETRY_LIMITS.maximumFramePacketBytes),
  };
}

function outputPolicyFor(policy) {
  return structuredClone(policy);
}

async function remotionModules(workspace) {
  const remotionRoot = path.join(workspace, "remotion");
  const bundlerPath = path.join(remotionRoot, "node_modules/@remotion/bundler/dist/index.js");
  const rendererPath = path.join(remotionRoot, "node_modules/@remotion/renderer/dist/index.js");
  try {
    const [bundler, renderer] = await Promise.all([
      import(pathToFileURL(bundlerPath).href),
      import(pathToFileURL(rendererPath).href),
    ]);
    if (typeof bundler.bundle !== "function" || typeof renderer.selectComposition !== "function" || typeof renderer.renderMedia !== "function") throw new Error("project Remotion packages do not expose the required programmatic APIs");
    return { bundle: bundler.bundle, selectComposition: renderer.selectComposition, renderMedia: renderer.renderMedia };
  } catch (error) {
    throw new AdapterError("ADAPTER_OPERATION_FAILED", "adapter_failure", `could not load project Remotion APIs: ${error instanceof Error ? error.message : String(error)}`, { stage: "ADAPTER_READY", exitCode: EXIT.operation });
  }
}

function browserLogPacket(text) {
  if (typeof text !== "string" || !text.includes(TELEMETRY_NAMESPACE)) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "browser telemetry log was not a JSON packet", { stage: "RENDERED", exitCode: EXIT.inspection });
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "browser telemetry log was malformed JSON", { stage: "RENDERED", exitCode: EXIT.inspection });
  }
}

function validateTelemetryPacket(packet, request, limits, writePacket) {
  if (!packet || packet.namespace !== TELEMETRY_NAMESPACE || packet.operationId !== request.operationId || !Number.isInteger(packet.frame) || packet.frame < 0 || packet.frame >= limits.maximumRenderedFrames || !Array.isArray(packet.layers)) {
    throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "browser telemetry packet failed the render boundary contract", { stage: "RENDERED", exitCode: EXIT.inspection });
  }
  const seen = new Set();
  for (const layer of packet.layers) {
    if (!layer || typeof layer.layerId !== "string" || seen.has(layer.layerId)) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "browser telemetry packet contains duplicate or invalid layer IDs", { stage: "RENDERED", exitCode: EXIT.inspection });
    seen.add(layer.layerId);
  }
  const bytes = Buffer.byteLength(`${canonicalJson(packet)}\n`);
  if (bytes > limits.maximumFramePacketBytes) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "browser telemetry frame packet exceeded its byte limit", { stage: "RENDERED", exitCode: EXIT.inspection });
  writePacket(packet, bytes);
}

async function renderOperation(request) {
  const mediaPath = outputPathFor(request, "media");
  const manifestPath = outputPathFor(request, "renderManifest");
  const telemetryPath = outputPathFor(request, "renderTelemetry");
  for (const [key, candidate] of [["media", mediaPath], ["renderManifest", manifestPath], ["renderTelemetry", telemetryPath]]) {
    if (fs.existsSync(candidate)) throw new AdapterError("INVALID_INPUT", "invalid_input", `outputs.${key} already exists`, { stage: "ADAPTER_READY", details: { artifactPath: candidate }, exitCode: EXIT.invalidInput });
  }
  const propsBytes = readArtifactBytes(request, request.inputs.props, "inputs.props", "propsHash", "ADAPTER_READY");
  if (sha256Bytes(propsBytes) !== request.inputs.propsHash.toLowerCase()) {
    throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", "inputs.props does not match inputs.propsHash", { stage: "ADAPTER_READY", details: { artifactPath: request.inputs.props }, exitCode: EXIT.asset });
  }
  const envelope = parseJsonBytes(propsBytes, "inputs.props", "ADAPTER_READY", request.inputs.props);
  const validated = validatePropsEnvelope(envelope, request);
  const rendererLockBytes = readArtifactBytes(request, request.inputs.rendererEnvironmentLock, "inputs.rendererEnvironmentLock", "rendererEnvironmentLock", "ADAPTER_READY");
  const rendererEnvironmentLock = parseJsonBytes(rendererLockBytes, "inputs.rendererEnvironmentLock", "ADAPTER_READY", request.inputs.rendererEnvironmentLock);
  if (rendererEnvironmentLock.schemaVersion !== "editorial://schema/renderer-environment-lock/v1" || !sameTarget(rendererEnvironmentLock.target, request.target)) {
    throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", "renderer environment lock does not match the negotiated target", { stage: "ADAPTER_READY", exitCode: EXIT.protocolMismatch });
  }
  const environmentLockHash = sha256Bytes(rendererLockBytes);
  const { props, publicDir } = stageRenderAssets(validated, request);
  const outputPolicy = validateOutputPolicy(rendererEnvironmentLock.outputPolicy, props);
  const layerIntervals = layerIntervalsForProps(props);
  const limits = telemetryLimits(validated.durationInFrames, layerIntervals);
  const browserExecutable = findBrowserExecutable(request.workspace);
  if (!browserExecutable) throw new AdapterError("ADAPTER_OPERATION_FAILED", "adapter_failure", "project Chrome headless shell was not found", { stage: "ADAPTER_READY", exitCode: EXIT.operation });
  const { bundle, selectComposition, renderMedia } = await remotionModules(request.workspace);
  const remotionRoot = path.join(request.workspace, "remotion");
  const entryPoint = path.join(remotionRoot, "src/index.tsx");
  if (!fs.existsSync(entryPoint)) throw new AdapterError("ADAPTER_OPERATION_FAILED", "adapter_failure", `Remotion entry point does not exist: ${entryPoint}`, { stage: "ADAPTER_READY", exitCode: EXIT.operation });
  const bundleDir = ensureContained(request.runDirectory, "render-bundle", "render-bundle");
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundleDir), { recursive: true });
  const deadlineMs = Date.parse(request.deadline) - Date.now();
  if (deadlineMs <= 0) throw new AdapterError("ADAPTER_TIMEOUT", "adapter_failure", "render deadline has elapsed", { stage: "ADAPTER_READY", exitCode: EXIT.operation, retryable: true });
  let bundleLocation;
  try {
    bundleLocation = await bundle({
      entryPoint,
      rootDir: remotionRoot,
      outDir: bundleDir,
      publicDir,
      enableCaching: false,
      ignoreRegisterRootWarning: true,
      onProgress: () => {},
    });
  } catch (error) {
    throw new AdapterError("ADAPTER_OPERATION_FAILED", "adapter_failure", `Remotion bundle failed: ${error instanceof Error ? error.message : String(error)}`, { stage: "ADAPTER_READY", exitCode: EXIT.operation, retryable: true });
  }
  let composition;
  try {
    composition = await selectComposition({
      serveUrl: bundleLocation,
      id: COMPOSITION_ID,
      inputProps: props,
      envVariables: { EDITORIAL_OPERATION_ID: request.operationId },
      browserExecutable,
      timeoutInMilliseconds: Math.max(1000, Math.min(deadlineMs, 120_000)),
      logLevel: "error",
    });
  } catch (error) {
    throw new AdapterError("ADAPTER_OPERATION_FAILED", "adapter_failure", `Remotion composition selection failed: ${error instanceof Error ? error.message : String(error)}`, { stage: "ADAPTER_READY", exitCode: EXIT.operation, retryable: true });
  }
  if (composition.width !== request.target.width || composition.height !== request.target.height || composition.fps !== request.target.fps || composition.durationInFrames !== validated.durationInFrames) {
    throw new AdapterError("SCHEMA_VALIDATION_FAILED", "invalid_input", "selected composition metadata does not match the locked props and target", { stage: "ADAPTER_READY", exitCode: EXIT.invalidInput });
  }
  let telemetryBytes = 0;
  let telemetryFailure = null;
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  fs.writeFileSync(telemetryPath, "", "utf8");
  const writePacket = (packet, bytes) => {
    if (telemetryBytes + bytes > limits.maximumRawTelemetryBytes) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "render telemetry exceeded its declared byte budget", { stage: "RENDERED", exitCode: EXIT.inspection });
    fs.appendFileSync(telemetryPath, `${canonicalJson(packet)}\n`, "utf8");
    telemetryBytes += bytes;
  };
  const onBrowserLog = (log) => {
    try {
      const packet = browserLogPacket(log?.text);
      if (packet) validateTelemetryPacket(packet, request, limits, writePacket);
    } catch (error) {
      telemetryFailure = error instanceof AdapterError ? error : new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", error instanceof Error ? error.message : String(error), { stage: "RENDERED", exitCode: EXIT.inspection });
    }
  };
  const startedAt = new Date().toISOString();
  try {
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      inputProps: props,
      envVariables: { EDITORIAL_OPERATION_ID: request.operationId },
      codec: outputPolicy.codec,
      pixelFormat: outputPolicy.pixelFormat,
      ...(outputPolicy.crf !== undefined ? { crf: outputPolicy.crf } : {}),
      ...(outputPolicy.videoBitrate !== undefined ? { videoBitrate: outputPolicy.videoBitrate } : {}),
      ...(props.audioUrl && outputPolicy.audioCodec ? { audioCodec: outputPolicy.audioCodec } : {}),
      muted: outputPolicy.audioMode === "forbidden",
      enforceAudioTrack: outputPolicy.audioMode === "required",
      outputLocation: mediaPath,
      overwrite: false,
      browserExecutable,
      timeoutInMilliseconds: Math.max(1000, Math.min(deadlineMs, 120_000)),
      logLevel: "error",
      hardwareAcceleration: outputPolicy.hardwareAcceleration === "required" ? "required" : "disable",
      concurrency: 1,
      onBrowserLog,
    });
  } catch (error) {
    throw new AdapterError("ADAPTER_OPERATION_FAILED", "adapter_failure", `Remotion render failed: ${error instanceof Error ? error.message : String(error)}`, { stage: "RENDERED", exitCode: EXIT.operation, retryable: true });
  }
  if (telemetryFailure) throw telemetryFailure;
  if (!fs.existsSync(mediaPath)) throw new AdapterError("MALFORMED_OUTPUT", "adapter_failure", "Remotion returned without creating media output", { stage: "RENDERED", exitCode: EXIT.operation });
  const mediaBytes = fs.readFileSync(mediaPath);
  const mediaHash = sha256Bytes(mediaBytes);
  const mediaFacts = probeMedia(mediaPath, { stage: "RENDERED" });
  const endedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: RENDER_MANIFEST_SCHEMA_ID,
    operationId: request.operationId,
    recipeHash: validated.recipeHash,
    propsHash: sha256Bytes(propsBytes),
    compositionId: COMPOSITION_ID,
    environmentLockHash,
    target: {
      profileId: request.target.profileId,
      width: request.target.width,
      height: request.target.height,
      fps: request.target.fps,
    },
    outputSettings: outputPolicyFor(outputPolicy),
    media: { path: mediaPath, sha256: mediaHash, frameCount: mediaFacts.frameCount },
    processTiming: {
      startedAt,
      endedAt,
      durationMilliseconds: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    },
    adapter: ADAPTER,
    layerIntervals,
    telemetryLimits: limits,
  };
  const manifestSerialized = `${canonicalJson(manifest)}\n`;
  fs.writeFileSync(manifestPath, manifestSerialized, "utf8");
  const telemetryHash = sha256Bytes(fs.readFileSync(telemetryPath));
  const artifacts = [
    { type: "media", path: mediaPath, sha256: mediaHash, schemaId: "editorial://schema/media/v1" },
    { type: "render-manifest", path: manifestPath, sha256: sha256Bytes(Buffer.from(manifestSerialized)), schemaId: RENDER_MANIFEST_SCHEMA_ID },
    { type: "render-telemetry", path: telemetryPath, sha256: telemetryHash, schemaId: "editorial://schema/render-telemetry/v1" },
  ];
  return { artifacts, telemetry: { artifacts: artifacts.slice(1) }, warnings: telemetryBytes === 0 ? [{ code: "TELEMETRY_NOT_CAPTURED", message: "InstrumentedLayer emitted no browser telemetry packets; inspect will fail closed until the renderer emits them.", blocking: true }] : [] };
}

function normalizedBox(raw, target, pointer) {
  object(raw, pointer);
  const values = [raw.x, raw.y, raw.width, raw.height].map(Number);
  if (values.some((value) => !Number.isFinite(value))) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `${pointer} contains non-finite geometry`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  const pixelSpace = values.some((value) => Math.abs(value) > 1);
  const result = pixelSpace
    ? { x: values[0] / target.width, y: values[1] / target.height, width: values[2] / target.width, height: values[3] / target.height }
    : { x: values[0], y: values[1], width: values[2], height: values[3] };
  if (Object.values(result).some((value) => value < 0 || value > 1)) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `${pointer} lies outside normalized output bounds`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  return result;
}

function normalizedPoint(raw, pointer) {
  object(raw, pointer);
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `${pointer} is not a normalized point`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  return { x, y };
}

function sampleFromPacket(layer, target, pointer) {
  const geometry = layer.geometry ?? layer.boundingBox;
  const transform = object(layer.transform ?? {}, `${pointer}.transform`);
  const transformOrigin = layer.transformOrigin ?? { x: 0.5, y: 0.5 };
  const opacity = Number(layer.opacity ?? 1);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `${pointer}.opacity is outside [0, 1]`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  const result = {
    boundingBox: normalizedBox(geometry, target, `${pointer}.geometry`),
    opacity,
    transform: {
      translateX: Number(transform.translateX ?? 0),
      translateY: Number(transform.translateY ?? 0),
      scaleX: Number(transform.scaleX ?? 1),
      scaleY: Number(transform.scaleY ?? 1),
      rotation: Number(transform.rotation ?? 0),
    },
    transformOrigin: normalizedPoint(transformOrigin, `${pointer}.transformOrigin`),
    maskBounds: layer.mask ? normalizedBox(layer.mask, target, `${pointer}.mask`) : null,
    decodeStatus: ["decoded", "pending", "failed", "not_applicable"].includes(layer.decodeStatus) ? layer.decodeStatus : "not_applicable",
  };
  if (Object.values(result.transform).some((value) => !Number.isFinite(value))) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `${pointer}.transform contains non-finite values`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  if (result.transform.scaleX < 0 || result.transform.scaleY < 0) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `${pointer}.transform scale is negative`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  return result;
}

function layerKindForId(layerId) {
  if (layerId.endsWith(":background")) return "background";
  if (layerId.includes(":transition")) return "transition";
  if (layerId.includes(":mask")) return "mask";
  // Current InstrumentedLayer does not include cue type in its browser packet;
  // preserve the stable cue ID and use the broad graphic kind until the
  // project renderer emits an explicit text/graphic discriminator.
  return "graphic";
}

function runLengthEncode(frames) {
  const sorted = [...frames].sort((left, right) => left.frame - right.frame);
  const runs = [];
  for (const item of sorted) {
    const previous = runs[runs.length - 1];
    const sampleKey = canonicalJson(item.sample);
    if (previous && previous.endFrame === item.frame && canonicalJson(previous.sample) === sampleKey) {
      previous.endFrame += 1;
    } else {
      runs.push({ startFrame: item.frame, endFrame: item.frame + 1, sample: item.sample });
    }
  }
  return runs;
}

function inspectTelemetry(manifest, telemetryBytes, mediaFacts, request) {
  const renderOperationId = manifest.operationId;
  const text = telemetryBytes.toString("utf8");
  const packets = [];
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const packet = parseJsonBytes(Buffer.from(line), `renderTelemetry line ${lineIndex + 1}`, "INSPECTED");
    if (packet.namespace !== TELEMETRY_NAMESPACE || packet.operationId !== renderOperationId || !Number.isInteger(packet.frame) || packet.frame < 0 || packet.frame >= manifest.telemetryLimits.maximumRenderedFrames || !Array.isArray(packet.layers)) {
      throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `renderTelemetry line ${lineIndex + 1} failed packet validation`, { stage: "INSPECTED", exitCode: EXIT.inspection });
    }
    packets.push(packet);
  }
  if (packets.length === 0) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "render telemetry contains no browser frame packets; InstrumentedLayer telemetry is not wired to renderMedia", { stage: "INSPECTED", exitCode: EXIT.inspection });
  const byFrame = new Map();
  for (const packet of packets) {
    const canonical = canonicalJson(packet);
    const previous = byFrame.get(packet.frame);
    if (previous && previous !== canonical) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `conflicting telemetry packets for frame ${packet.frame}`, { stage: "INSPECTED", exitCode: EXIT.inspection });
    byFrame.set(packet.frame, canonical);
  }
  for (let frame = 0; frame < mediaFacts.frameCount; frame += 1) {
    if (!byFrame.has(frame)) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `missing telemetry packet for frame ${frame}`, { stage: "INSPECTED", exitCode: EXIT.inspection });
  }
  const framesByLayer = new Map();
  for (const [frame, canonical] of byFrame.entries()) {
    const packet = JSON.parse(canonical);
    const seen = new Set();
    for (const layer of packet.layers) {
      if (seen.has(layer.layerId)) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `duplicate layer ${layer.layerId} in frame ${frame}`, { stage: "INSPECTED", exitCode: EXIT.inspection });
      seen.add(layer.layerId);
      const interval = manifest.layerIntervals[layer.layerId];
      if (!interval || frame < interval.startFrame || frame >= interval.endFrame) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `layer ${layer.layerId} is outside its locked interval`, { stage: "INSPECTED", exitCode: EXIT.inspection });
      const key = layer.layerId;
      const frames = framesByLayer.get(key) ?? [];
      frames.push({ frame, sample: sampleFromPacket(layer, manifest.target, `frame ${frame} layer ${key}`) });
      framesByLayer.set(key, frames);
    }
  }
  for (const [layerId, interval] of Object.entries(manifest.layerIntervals)) {
    const frames = framesByLayer.get(layerId) ?? [];
    const frameSet = new Set(frames.map((item) => item.frame));
    for (let frame = interval.startFrame; frame < interval.endFrame; frame += 1) {
      if (!frameSet.has(frame)) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", `missing telemetry sample for ${layerId} at frame ${frame}`, { stage: "INSPECTED", exitCode: EXIT.inspection });
    }
  }
  const layers = Object.entries(manifest.layerIntervals).sort(([left], [right]) => left.localeCompare(right)).map(([layerId, interval]) => ({
    layerId,
    kind: layerKindForId(layerId),
    interval,
    sampling: "per_frame",
    sourceAsset: null,
    runs: runLengthEncode(framesByLayer.get(layerId) ?? []),
  }));
  return {
    schemaVersion: LAYOUT_TELEMETRY_SCHEMA_ID,
    operationId: request.operationId,
    target: manifest.target,
    frameCount: mediaFacts.frameCount,
    coordinateSpace: {
      origin: "top_left",
      geometryUnits: "normalized_output",
      translationUnits: "output_pixels",
      rotationUnits: "degrees_clockwise",
      intervalSemantics: "zero_based_start_inclusive_end_exclusive",
    },
    layers,
  };
}

async function inspectOperation(request) {
  const inspectReportPath = outputPathFor(request, "inspectReport");
  const layoutTelemetryPath = outputPathFor(request, "layoutTelemetry");
  for (const [key, candidate] of [["inspectReport", inspectReportPath], ["layoutTelemetry", layoutTelemetryPath]]) {
    if (fs.existsSync(candidate)) throw new AdapterError("INVALID_INPUT", "invalid_input", `outputs.${key} already exists`, { stage: "ADAPTER_READY", details: { artifactPath: candidate }, exitCode: EXIT.invalidInput });
  }
  const mediaPath = ensureContained(request.runDirectory, request.inputs.media, "inputs.media");
  const mediaBytes = readArtifactBytes(request, request.inputs.media, "inputs.media", "mediaHash", "INSPECTED");
  if (sha256Bytes(mediaBytes) !== request.inputs.mediaHash.toLowerCase()) {
    throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", "inputs.media does not match inputs.mediaHash", { stage: "INSPECTED", details: { artifactPath: mediaPath }, exitCode: EXIT.asset });
  }
  const manifestBytes = readArtifactBytes(request, request.inputs.renderManifest, "inputs.renderManifest", "renderManifest", "INSPECTED");
  const telemetryBytes = readArtifactBytes(request, request.inputs.renderTelemetry, "inputs.renderTelemetry", "renderTelemetry", "INSPECTED");
  const manifest = parseJsonBytes(manifestBytes, "renderManifest", "INSPECTED", request.inputs.renderManifest);
  if (manifest.schemaVersion !== RENDER_MANIFEST_SCHEMA_ID || typeof manifest.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.operationId) || manifest.media?.path !== mediaPath) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "render manifest does not match the inspect request", { stage: "INSPECTED", exitCode: EXIT.inspection });
  if (manifest.target?.profileId !== request.target.profileId || manifest.target?.width !== request.target.width || manifest.target?.height !== request.target.height || manifest.target?.fps !== request.target.fps) throw new AdapterError("TARGET_UNSUPPORTED", "protocol_mismatch", "render manifest target does not match the inspect request", { stage: "INSPECTED", exitCode: EXIT.inspection });
  if (manifest.media.sha256 !== sha256Bytes(mediaBytes)) throw new AdapterError("ASSET_HASH_MISMATCH", "asset_failure", "render manifest media hash does not match media input", { stage: "INSPECTED", details: { artifactPath: mediaPath }, exitCode: EXIT.asset });
  const mediaFacts = probeMedia(mediaPath, { stage: "INSPECTED" });
  if (manifest.media.frameCount !== mediaFacts.frameCount) throw new AdapterError("ADAPTER_INSPECTION_FAILED", "inspection_failure", "render manifest frame count does not match ffprobe", { stage: "INSPECTED", exitCode: EXIT.inspection });
  const layoutTelemetry = inspectTelemetry(manifest, telemetryBytes, mediaFacts, request);
  const layoutSerialized = `${canonicalJson(layoutTelemetry)}\n`;
  fs.writeFileSync(layoutTelemetryPath, layoutSerialized, "utf8");
  const layoutHash = sha256Bytes(Buffer.from(layoutSerialized));
  const renderManifestHash = sha256Bytes(manifestBytes);
  const inspectReport = {
    schemaVersion: INSPECT_REPORT_SCHEMA_ID,
    operationId: request.operationId,
    media: { path: mediaPath, sha256: sha256Bytes(mediaBytes) },
    renderManifestHash,
    layoutTelemetry: { path: layoutTelemetryPath, sha256: layoutHash },
    frameCount: mediaFacts.frameCount,
    decodeStatus: "decoded",
    streams: mediaFacts.streams,
    assetDecodeResults: [],
    warnings: [],
    inspectedAt: new Date().toISOString(),
  };
  const inspectSerialized = `${canonicalJson(inspectReport)}\n`;
  fs.writeFileSync(inspectReportPath, inspectSerialized, "utf8");
  const artifacts = [
    { type: "inspect-report", path: inspectReportPath, sha256: sha256Bytes(Buffer.from(inspectSerialized)), schemaId: INSPECT_REPORT_SCHEMA_ID },
    { type: "layout-telemetry", path: layoutTelemetryPath, sha256: layoutHash, schemaId: LAYOUT_TELEMETRY_SCHEMA_ID },
  ];
  return { artifacts, telemetry: { artifacts }, warnings: [] };
}

function buildProps(request) {
  const inputs = request.inputs;
  const recipePayload = readJsonArtifact(request, inputs.recipePayload, "inputs.recipePayload", "recipePayload");
  const recipeLock = readJsonArtifact(request, inputs.recipeLock, "inputs.recipeLock", "recipeLock");
  const assetInventory = readJsonArtifact(request, inputs.assetInventory, "inputs.assetInventory", "assetInventory");
  const propsPath = outputPathFor(request, "props");
  const buildTelemetryPath = outputPathFor(request, "buildTelemetry");
  const recipeHash = hashCanonical(recipePayload);
  validateRecipeLock(recipeLock, recipeHash);
  const prepared = prepareNarrationConform(request, assetInventory, recipePayload);
  const props = buildMagnatesProps({
    recipe: prepared.recipe,
    assetInventory: prepared.assetInventory,
    target: request.target,
    metadata: prepared.metadata,
  });
  const envelope = {
    schemaVersion: REMOTION_PROPS_SCHEMA_ID,
    recipeSchemaVersion: magnatesRecipeSchemaVersion,
    recipeHash,
    durationInFrames: props.durationInFrames,
    fps: props.fps,
    compositionId: COMPOSITION_ID,
    target: {
      profileId: request.target.profileId,
      width: request.target.width,
      height: request.target.height,
      fps: request.target.fps,
    },
    projectPropsSchemaId: PROJECT_PROPS_SCHEMA_ID,
    assetBindings: buildAssetBindings(prepared.assetInventory, props, request.workspace),
    props,
  };
  const serialized = `${canonicalJson(envelope)}\n`;
  const propsHash = crypto.createHash("sha256").update(serialized).digest("hex");
  fs.mkdirSync(path.dirname(propsPath), { recursive: true });
  fs.mkdirSync(path.dirname(buildTelemetryPath), { recursive: true });
  fs.writeFileSync(propsPath, serialized, "utf8");
  const telemetry = {
    schemaVersion: 1,
    operationId: request.operationId,
    compositionId: props.compositionId,
    recipeHash,
    propsHash,
    durationInFrames: props.durationInFrames,
    targetProfileId: props.targetProfileId,
  };
  const telemetrySerialized = `${JSON.stringify(telemetry, null, 2)}\n`;
  fs.writeFileSync(buildTelemetryPath, telemetrySerialized, "utf8");
  const artifact = [
    { type: "remotion-props", path: propsPath, sha256: propsHash, schemaId: REMOTION_PROPS_SCHEMA_ID },
    { type: "build-telemetry", path: buildTelemetryPath, sha256: crypto.createHash("sha256").update(telemetrySerialized).digest("hex"), schemaId: "editorial://schema/build-telemetry/v1" },
  ];
  return {
    artifacts: artifact,
    telemetry: { artifacts: [artifact[1]] },
    warnings: [],
  };
}

async function operationResult(request) {
  if (request.operation === "capabilities") return { capabilities: capabilities(request), artifacts: [], telemetry: {}, warnings: [] };
  if (request.operation === "build-props") return buildProps(request);
  if (request.operation === "render") return renderOperation(request);
  return inspectOperation(request);
}

function responseFor(request, result) {
  return {
    adapterProtocolVersion: PROTOCOL_VERSION,
    operationId: request.operationId,
    operation: request.operation,
    status: "ok",
    adapter: ADAPTER,
    capabilities: result.capabilities ?? null,
    artifacts: result.artifacts ?? [],
    telemetry: result.telemetry ?? {},
    warnings: result.warnings ?? [],
    error: null,
  };
}

function errorResponse(error, request = {}) {
  const known = error instanceof AdapterError || error instanceof MagnatesPropsError;
  const wrapped = known
    ? error
    : new AdapterError("INTERNAL_ERROR", "internal", error instanceof Error ? error.message : String(error), { stage: "ADAPTER_READY", exitCode: EXIT.internal });
  const operationId = typeof request.operationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.operationId)
    ? request.operationId
    : "00000000-0000-4000-8000-000000000000";
  const operation = OPERATIONS.has(request.operation) ? request.operation : "capabilities";
  const normalizedCode = wrapped instanceof MagnatesPropsError ? "INVALID_INPUT" : (wrapped.code ?? "INTERNAL_ERROR");
  const normalizedCategory = wrapped instanceof MagnatesPropsError ? "invalid_input" : (wrapped.category ?? "internal");
  const normalizedStage = ["ADAPTER_READY", "PROPS_BUILT", "RENDERED", "INSPECTED"].includes(wrapped.stage)
    ? wrapped.stage
    : "ADAPTER_READY";
  return {
    response: {
      adapterProtocolVersion: PROTOCOL_VERSION,
      operationId,
      operation,
      status: "error",
      adapter: ADAPTER,
      capabilities: null,
      artifacts: [],
      telemetry: {},
      warnings: [],
      error: {
        code: normalizedCode,
        category: normalizedCategory,
        message: wrapped.message,
        retryable: Boolean(wrapped.retryable),
        stage: normalizedStage,
        ...(wrapped.details ? { details: { diagnosticId: "adapter-error", ...(wrapped.details.artifactPath ? { artifactPath: wrapped.details.artifactPath } : {}) } } : {}),
      },
    },
    exitCode: wrapped.exitCode ?? (wrapped instanceof MagnatesPropsError ? EXIT.invalidInput : EXIT.operation),
  };
}

export async function handleRequest(raw) {
  let request;
  try {
    request = validateRequest(raw);
    return { response: responseFor(request, await operationResult(request)), exitCode: EXIT.success };
  } catch (error) {
    return errorResponse(error, request ?? raw ?? {});
  }
}

async function main() {
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      let chunks = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { chunks += chunk; });
      process.stdin.on("end", () => resolve(chunks));
      process.stdin.on("error", reject);
    });
    if (!raw.trim()) throw new AdapterError("PROTOCOL_VIOLATION", "protocol_failure", "stdin did not contain a JSON request", { stage: "ADAPTER_READY", exitCode: EXIT.protocol });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AdapterError("PROTOCOL_VIOLATION", "protocol_failure", "stdin did not contain exactly one JSON request object", { stage: "ADAPTER_READY", details: { diagnosticId: "malformed-json" }, exitCode: EXIT.protocol });
    }
    const result = await handleRequest(parsed);
    process.stdout.write(`${JSON.stringify(result.response)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const result = errorResponse(error, {});
    process.stdout.write(`${JSON.stringify(result.response)}\n`);
    process.exitCode = result.exitCode;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
