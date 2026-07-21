import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createContractValidator } from "../../skills/remotion-editorial-director/scripts/lib/contract-validator.mjs";

const adapter = path.resolve("scripts/videoeditor/remotion_editorial_adapter.mjs");

function request(overrides = {}) {
  return {
    adapterProtocolVersion: 1,
    operationId: "11111111-1111-4111-8111-111111111111",
    operation: "capabilities",
    recipeSchemaVersion: "magnates-remotion-recipe-v2",
    workspace: "/tmp/editorial-project",
    runDirectory: "/tmp/editorial-project/run",
    target: { profileId: "youtube-720p", width: 1280, height: 720, fps: 30 },
    inputs: {},
    outputs: {},
    expectedHashes: {},
    deadline: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function run(payload) {
  const result = spawnSync(process.execPath, [adapter], { input: `${JSON.stringify(payload)}\n`, encoding: "utf8" });
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
  return { ...result, response: JSON.parse(result.stdout) };
}

function recipe() {
  return {
    schemaVersion: "magnates-remotion-recipe-v2",
    durationInFrames: 30,
    fps: 30,
    shots: [{
      id: "shot-001",
      durationInFrames: 30,
      background: { assetId: "asset-001" },
      semanticRole: "reversal",
      texts: [{ id: "cue-001", type: "text", subject: "Yahoo", subjectId: "entity-yahoo", text: "Yahoo", startFrame: 0, endFrame: 30 }],
    }],
  };
}

test("capabilities advertise production composition and exact targets only", () => {
  const result = run(request());
  assert.equal(result.status, 0);
  assert.equal(result.response.status, "ok");
  assert.deepEqual(result.response.capabilities.compositionIds, ["MagnatesEditorial"]);
  assert.deepEqual(result.response.capabilities.recipeSchemaVersions, ["magnates-remotion-recipe-v2"]);
  assert.equal(result.response.capabilities.targetProfiles.find((item) => item.profileId === "youtube-1080p").width, 1920);
});

test("capabilities report byte hashes for the actual renderer environment", () => {
  const workspace = path.resolve(".");
  const result = run(request({ workspace }));
  assert.equal(result.status, 0, result.stderr);
  const identity = result.response.capabilities.environmentIdentity;
  const hashFile = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

  assert.equal(identity.adapterExecutableHash, hashFile(adapter));
  assert.equal(identity.packageLockHash, hashFile(path.join(workspace, "remotion/package-lock.json")));
  for (const tool of [identity.remotion, identity.browser, identity.ffmpeg, identity.ffprobe]) {
    assert.equal(path.isAbsolute(tool.path), true);
    assert.equal(tool.sha256, hashFile(tool.path), tool.path);
    assert.notEqual(tool.sha256, createHash("sha256").update(`${tool.path}:${tool.version}`).digest("hex"));
  }
  assert.match(identity.remotion.version, /^4\.0\.\d+$/);
  assert.match(identity.ffmpeg.version, /^\d+\.\d+\.\d+$/);
  assert.match(identity.ffprobe.version, /^\d+\.\d+\.\d+$/);
  assert.equal(identity.fontHashes["Arial.system"].length, 64);
});

test("build-props returns one response and can write a contained artifact", () => {
  const runDirectory = mkdtempSync(path.join(tmpdir(), "editorial-adapter-"));
  try {
    const propsPath = path.join(runDirectory, "props.json");
    const telemetryPath = path.join(runDirectory, "build-telemetry.json");
    const recipePath = path.join(runDirectory, "recipe.json");
    const lockPath = path.join(runDirectory, "lock.json");
    const inventoryPath = path.join(runDirectory, "inventory.json");
    writeFileSync(recipePath, JSON.stringify(recipe()));
    writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(inventoryPath, JSON.stringify({ assets: [{ assetId: "asset-001", stagedPath: "static/yahoo.png", verified: true }], entities: [{ id: "entity-yahoo" }] }));
    const result = run(request({
      operation: "build-props",
      runDirectory,
      inputs: {
        recipePayload: recipePath,
        recipeLock: lockPath,
        assetInventory: inventoryPath,
      },
      outputs: { props: propsPath, buildTelemetry: telemetryPath },
    }));
    assert.equal(result.status, 0);
    assert.equal(result.response.status, "ok");
    assert.equal(result.response.artifacts.length, 2);
    assert.equal(result.response.artifacts[0].schemaId, "editorial://schema/remotion-props/v1");
    const written = JSON.parse(readFileSync(propsPath, "utf8"));
    assert.equal(written.recipeSchemaVersion, "magnates-remotion-recipe-v2");
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("build-props binds a verified conformed narration asset and leaves absent narration unbound", () => {
  const runDirectory = mkdtempSync(path.join(tmpdir(), "editorial-adapter-audio-"));
  try {
    const recipePath = path.join(runDirectory, "recipe.json");
    const lockPath = path.join(runDirectory, "lock.json");
    const inventoryPath = path.join(runDirectory, "inventory.json");
    const audioPath = path.join(runDirectory, "audio", "narration.wav");
    const narrationConformPath = path.join(runDirectory, "audio", "narration-conform.json");
    const propsPath = path.join(runDirectory, "props.json");
    const telemetryPath = path.join(runDirectory, "build-telemetry.json");
    const audioBytes = Buffer.from("conformed narration bytes");
    const audioHash = createHash("sha256").update(audioBytes).digest("hex");
    const hashFile = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");
    writeFileSync(recipePath, JSON.stringify(recipe()));
    writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(inventoryPath, JSON.stringify({ assets: [{ assetId: "asset-001", stagedPath: "static/yahoo.png", verified: true }], entities: [{ id: "entity-yahoo" }] }));
    mkdirSync(path.dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, audioBytes);
    const conform = {
      audioMode: "required",
      durationInFrames: 30,
      fps: 30,
      output: { artifactType: "conformed-narration", path: audioPath, schemaId: "audio/wav", sha256: audioHash },
      sampleCount: 48000,
      sampleRate: 48000,
      schemaVersion: "editorial://schema/narration-conform/v1",
      status: "conformed",
    };
    writeFileSync(narrationConformPath, JSON.stringify(conform));
    const result = run(request({
      operation: "build-props",
      runDirectory,
      inputs: { recipePayload: recipePath, recipeLock: lockPath, assetInventory: inventoryPath, narrationConform: narrationConformPath },
      outputs: { props: propsPath, buildTelemetry: telemetryPath },
      expectedHashes: { recipePayload: hashFile(recipePath), recipeLock: hashFile(lockPath), assetInventory: hashFile(inventoryPath), narrationConform: hashFile(narrationConformPath) },
    }));
    assert.equal(result.status, 0, result.stderr || JSON.stringify(result.response));
    const propsEnvelope = JSON.parse(readFileSync(propsPath, "utf8"));
    assert.equal(propsEnvelope.props.audioAssetId, "narration-conformed");
    assert.equal(propsEnvelope.props.audioUrl, audioPath);
    assert.deepEqual(propsEnvelope.assetBindings["narration-conformed"], { kind: "audio", path: audioPath, sha256: audioHash });

    const absentPath = path.join(runDirectory, "audio", "narration-absent.json");
    const absentPropsPath = path.join(runDirectory, "absent-props.json");
    const absentTelemetryPath = path.join(runDirectory, "absent-build-telemetry.json");
    writeFileSync(absentPath, JSON.stringify({ audioMode: "optional", output: null, schemaVersion: "editorial://schema/narration-conform/v1", status: "absent" }));
    const absent = run(request({
      operationId: "55555555-5555-4555-8555-555555555555",
      operation: "build-props",
      runDirectory,
      inputs: { recipePayload: recipePath, recipeLock: lockPath, assetInventory: inventoryPath, narrationConform: absentPath },
      outputs: { props: absentPropsPath, buildTelemetry: absentTelemetryPath },
      expectedHashes: { recipePayload: hashFile(recipePath), recipeLock: hashFile(lockPath), assetInventory: hashFile(inventoryPath), narrationConform: hashFile(absentPath) },
    }));
    assert.equal(absent.status, 0, absent.stderr);
    const absentEnvelope = JSON.parse(readFileSync(absentPropsPath, "utf8"));
    assert.equal(absentEnvelope.props.audioAssetId, null);
    assert.equal(absentEnvelope.props.audioUrl, null);
    assert.equal(absentEnvelope.assetBindings["narration-conformed"], undefined);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("invalid input and malformed JSON are typed failures without stdout diagnostics", () => {
  const invalid = run(request({ recipeSchemaVersion: "magnates-remotion-recipe-v1" }));
  assert.equal(invalid.status, 2);
  assert.equal(invalid.response.status, "error");
  assert.equal(invalid.response.error.code, "INVALID_INPUT");
  const malformed = spawnSync(process.execPath, [adapter], { input: "{}\n{}\n", encoding: "utf8" });
  assert.equal(malformed.status, 7);
  assert.equal(malformed.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(malformed.stdout).error.code, "PROTOCOL_VIOLATION");
});

test("render verifies the envelope byte hash before invoking Remotion", () => {
  const runDirectory = mkdtempSync(path.join(tmpdir(), "editorial-render-boundary-"));
  try {
    const propsPath = path.join(runDirectory, "props.json");
    const lockPath = path.join(runDirectory, "renderer-lock.json");
    writeFileSync(propsPath, JSON.stringify({ schemaVersion: "editorial://schema/remotion-props/v1" }));
    writeFileSync(lockPath, JSON.stringify({ schemaVersion: "editorial://schema/renderer-environment-lock/v1" }));
    const result = run(request({
      operation: "render",
      runDirectory,
      inputs: {
        props: propsPath,
        propsHash: "0".repeat(64),
        compositionId: "MagnatesEditorial",
        rendererEnvironmentLock: lockPath,
      },
      outputs: {
        media: path.join(runDirectory, "media.mp4"),
        renderManifest: path.join(runDirectory, "render-manifest.json"),
        renderTelemetry: path.join(runDirectory, "render-telemetry.jsonl"),
      },
    }));
    assert.equal(result.status, 4);
    assert.equal(result.response.error.code, "ASSET_HASH_MISMATCH");
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("inspect reports a typed inspection failure when no browser telemetry packets were captured", () => {
  const runDirectory = mkdtempSync(path.join(tmpdir(), "editorial-inspect-boundary-"));
  try {
    const mediaPath = path.join(runDirectory, "media.mp4");
    const manifestPath = path.join(runDirectory, "render-manifest.json");
    const telemetryPath = path.join(runDirectory, "render-telemetry.jsonl");
    writeFileSync(mediaPath, "not a media file");
    writeFileSync(manifestPath, JSON.stringify({}));
    writeFileSync(telemetryPath, "");
    const result = run(request({
      operation: "inspect",
      runDirectory,
      inputs: {
        media: mediaPath,
        mediaHash: createHash("sha256").update("not a media file").digest("hex"),
        renderManifest: manifestPath,
        renderTelemetry: telemetryPath,
      },
      outputs: {
        inspectReport: path.join(runDirectory, "inspect-report.json"),
        layoutTelemetry: path.join(runDirectory, "layout-telemetry.json"),
      },
    }));
    assert.equal(result.status, 6);
    assert.equal(result.response.error.code, "ADAPTER_INSPECTION_FAILED");
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("real render and inspect emit browser telemetry and validate output contracts", async () => {
  const runDirectory = mkdtempSync(path.join(tmpdir(), "editorial-real-render-"));
  try {
    const assetPath = path.join(runDirectory, "asset.png");
    const audioPath = path.join(runDirectory, "narration.wav");
    const narrationConformPath = path.join(runDirectory, "narration-conform.json");
    const recipePath = path.join(runDirectory, "recipe.json");
    const lockPath = path.join(runDirectory, "recipe-lock.json");
    const inventoryPath = path.join(runDirectory, "asset-inventory.json");
    const propsPath = path.join(runDirectory, "props.json");
    const buildTelemetryPath = path.join(runDirectory, "build-telemetry.json");
    const rendererLockPath = path.join(runDirectory, "renderer-environment.lock.json");
    const mediaPath = path.join(runDirectory, "media.mp4");
    const manifestPath = path.join(runDirectory, "render-manifest.json");
    const renderTelemetryPath = path.join(runDirectory, "render-telemetry.jsonl");
    const inspectReportPath = path.join(runDirectory, "inspect-report.json");
    const layoutTelemetryPath = path.join(runDirectory, "layout-telemetry.json");
    const assetBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxAADCBYAG10CBdmzJXQAAAAASUVORK5CYII=", "base64");
    const hashFile = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");
    const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const realRecipe = {
      schemaVersion: "magnates-remotion-recipe-v2",
      durationInFrames: 2,
      fps: 30,
      shots: [{ id: "shot-real", durationInFrames: 2, background: { assetId: "asset-real", fit: "cover" }, semanticRole: "hook", camera: { preset: "hold" } }],
    };
    writeFileSync(assetPath, assetBytes);
    const generatedAudio = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", String(2 / 30), "-c:a", "pcm_s16le", audioPath,
    ], { encoding: "utf8" });
    assert.equal(generatedAudio.status, 0, generatedAudio.stderr);
    const audioHash = hashFile(audioPath);
    writeFileSync(narrationConformPath, JSON.stringify({
      audioMode: "required",
      durationInFrames: 2,
      fps: 30,
      output: {
        artifactType: "conformed-narration",
        path: audioPath,
        schemaId: "audio/wav",
        sha256: audioHash,
      },
      sampleCount: 3200,
      sampleRate: 48000,
      schemaVersion: "editorial://schema/narration-conform/v1",
      status: "conformed",
    }));
    writeFileSync(recipePath, JSON.stringify(realRecipe));
    writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(inventoryPath, JSON.stringify({ assets: [{ assetId: "asset-real", kind: "image", sha256: hashBytes(assetBytes), stagedPath: assetPath }] }));

    const baseRequest = (operation, operationId, inputs, outputs, expectedHashes) => request({
      operation,
      operationId,
      workspace: path.resolve("."),
      runDirectory,
      inputs,
      outputs,
      expectedHashes,
    });
    const build = run(baseRequest(
      "build-props",
      "22222222-2222-4222-8222-222222222222",
      {
        recipePayload: recipePath,
        recipeLock: lockPath,
        assetInventory: inventoryPath,
        narrationConform: narrationConformPath,
      },
      { props: propsPath, buildTelemetry: buildTelemetryPath },
      {
        recipePayload: hashFile(recipePath),
        recipeLock: hashFile(lockPath),
        assetInventory: hashFile(inventoryPath),
        narrationConform: hashFile(narrationConformPath),
      },
    ));
    assert.equal(build.status, 0, build.stderr);

    const rendererEnvironmentLock = {
      schemaVersion: "editorial://schema/renderer-environment-lock/v1",
      target: { profileId: "youtube-720p", width: 1280, height: 720, fps: 30 },
      outputPolicy: {
        container: "mp4",
        codec: "h264",
        pixelFormat: "yuv420p",
        audioMode: "required",
        audioCodec: "aac",
        crf: 18,
        safeArea: { left: 0.05, right: 0.05, top: 0.05, bottom: 0.05 },
        durationToleranceFrames: 0,
        audioToleranceFrames: 0,
        hardwareAcceleration: "disabled",
      },
    };
    writeFileSync(rendererLockPath, JSON.stringify(rendererEnvironmentLock));
    const propsHash = hashFile(propsPath);
    const render = run(baseRequest(
      "render",
      "33333333-3333-4333-8333-333333333333",
      { props: propsPath, propsHash, compositionId: "MagnatesEditorial", rendererEnvironmentLock: rendererLockPath },
      { media: mediaPath, renderManifest: manifestPath, renderTelemetry: renderTelemetryPath },
      { propsHash, rendererEnvironmentLock: hashFile(rendererLockPath) },
    ));
    assert.equal(render.status, 0, render.stderr);
    assert.equal(render.response.warnings.length, 0, render.stderr);
    assert.equal(readFileSync(renderTelemetryPath, "utf8").trim().split(/\r?\n/u).length, 2);

    const mediaHash = hashFile(mediaPath);
    const inspect = run(baseRequest(
      "inspect",
      "44444444-4444-4444-8444-444444444444",
      { media: mediaPath, mediaHash, renderManifest: manifestPath, renderTelemetry: renderTelemetryPath },
      { inspectReport: inspectReportPath, layoutTelemetry: layoutTelemetryPath },
      { media: mediaHash, renderManifest: hashFile(manifestPath), renderTelemetry: hashFile(renderTelemetryPath) },
    ));
    assert.equal(inspect.status, 0, inspect.stderr);

    const validator = await createContractValidator({ contractsDirectory: path.resolve("skills/remotion-editorial-director/contracts") });
    validator.validate("renderManifest", JSON.parse(readFileSync(manifestPath, "utf8")));
    validator.validate("inspectReport", JSON.parse(readFileSync(inspectReportPath, "utf8")));
    validator.validate("layoutTelemetry", JSON.parse(readFileSync(layoutTelemetryPath, "utf8")));
    assert.equal(JSON.parse(readFileSync(inspectReportPath, "utf8")).operationId, "44444444-4444-4444-8444-444444444444");
    assert.equal(
      JSON.parse(readFileSync(inspectReportPath, "utf8")).streams.some(({ kind }) => kind === "audio"),
      true,
    );
    assert.equal(JSON.parse(readFileSync(layoutTelemetryPath, "utf8")).frameCount, 2);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});
