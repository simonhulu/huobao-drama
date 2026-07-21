import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {hashPayload, parseStrictJson} from './canonical-json.mjs';
import {createContractValidator} from './contract-validator.mjs';
import {runJsonSubprocess} from './subprocess-boundary.mjs';

const target = Object.freeze({fps: 30, height: 720, profileId: 'youtube-720p', width: 1280});
const outputPolicy = Object.freeze({
  audioMode: 'forbidden',
  codec: 'h264',
  container: 'mp4',
  crf: 18,
  durationToleranceFrames: 0,
  hardwareAcceleration: 'disabled',
  pixelFormat: 'yuv420p',
  safeArea: {bottom: 0.05, left: 0.05, right: 0.05, top: 0.05},
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxAADCBYAG10CBdmzJXQAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checked = (id, expected, observed) => ({
  blocking: true,
  command: null,
  expected,
  id,
  message: null,
  observed,
  status: 'passed',
});
const failed = (id, error) => ({
  blocking: true,
  command: null,
  expected: 'valid project adapter response and authenticated artifacts',
  id,
  message: error.message,
  observed: {code: error.code ?? 'INTERNAL_ERROR'},
  status: 'failed',
});
const writeJson = async (filePath, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  await writeFile(filePath, bytes);
  return sha256(bytes);
};
const artifact = (response, type) => {
  const found = response.artifacts.find((candidate) => candidate.type === type);
  if (!found) throw Object.assign(new Error(`Adapter omitted ${type} artifact`), {code: 'DOCTOR_ADAPTER_ARTIFACT_MISSING'});
  return found;
};
const validateResponse = (validator, response) => {
  const {diagnostics: _diagnostics, ...payload} = response;
  validator.validate('adapterResponse', payload);
  if (payload.status !== 'ok') {
    throw Object.assign(new Error(payload.error?.message ?? 'Adapter returned an error response'), {
      code: payload.error?.code ?? 'DOCTOR_ADAPTER_FAILED',
    });
  }
};

const adapterSourcePath = (config, workspace) => {
  const [executable, ...args] = config.command;
  const source = /(?:^|[/\\])node(?:\.exe)?$/u.test(executable)
    ? args.find((argument) => /\.(?:c?js|mjs)$/u.test(argument))
    : executable.includes(path.sep) || executable.startsWith('.') ? executable : null;
  return source ? path.resolve(workspace, source) : null;
};

const invoke = async ({config, operation, runDirectory, timeoutMs, workspace, inputs, outputs, expectedHashes}) => {
  const request = {
    adapterProtocolVersion: config.adapterProtocolVersion,
    deadline: new Date(Date.now() + timeoutMs).toISOString(),
    expectedHashes,
    inputs,
    operation,
    operationId: randomUUID(),
    outputs,
    recipeSchemaVersion: 'magnates-remotion-recipe-v2',
    runDirectory,
    target,
    workspace,
  };
  return runJsonSubprocess({
    command: config.command,
    cwd: workspace,
    environmentNames: config.environmentVariables ?? [],
    request,
    timeoutMs,
  });
};

export const verifyProjectAdapter = async ({
  adapterConfigPath,
  contractsDirectory,
  renderSmoke = false,
  timeoutMs = 300000,
}) => {
  const checks = [];
  const validator = await createContractValidator({contractsDirectory});
  const configPath = path.resolve(adapterConfigPath);
  const config = parseStrictJson(await readFile(configPath, 'utf8'));
  validator.validate('adapterConfig', config);
  const workspace = path.resolve(path.dirname(configPath), config.workspace);
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), 'editorial-doctor-adapter-'));
  try {
    let capabilitiesResponse;
    try {
      capabilitiesResponse = await invoke({
        config,
        expectedHashes: {},
        inputs: {},
        operation: 'capabilities',
        outputs: {},
        runDirectory,
        timeoutMs,
        workspace,
      });
      validateResponse(validator, capabilitiesResponse);
      const capabilities = capabilitiesResponse.capabilities;
      validator.validate('adapterCapabilities', capabilities);
      if (!capabilities.operations.every((operation) => ['capabilities', 'build-props', 'render', 'inspect'].includes(operation)) ||
        !capabilities.compositionIds.includes(config.compositionId) ||
        !capabilities.targetProfiles.some((profile) =>
          ['profileId', 'width', 'height', 'fps'].every((key) => profile[key] === target[key]))) {
        throw Object.assign(new Error('Adapter capabilities do not cover the configured composition and target'), {code: 'DOCTOR_ADAPTER_CAPABILITY_MISMATCH'});
      }
      checks.push(checked('adapter-capabilities', 'closed capabilities with configured composition and youtube-720p', {
        adapter: capabilities.adapter,
        compositionId: config.compositionId,
      }));
      const sourcePath = adapterSourcePath(config, workspace);
      if (!sourcePath) throw Object.assign(new Error('Doctor cannot resolve adapter executable bytes from command'), {code: 'DOCTOR_ADAPTER_IDENTITY_UNRESOLVED'});
      const executableHash = sha256(await readFile(sourcePath));
      if (capabilities.environmentIdentity.adapterExecutableHash !== executableHash) {
        throw Object.assign(new Error('Adapter executable hash does not match advertised identity'), {code: 'DOCTOR_ADAPTER_IDENTITY_MISMATCH'});
      }
      checks.push(checked('adapter-identity', executableHash, capabilities.environmentIdentity.adapterExecutableHash));
    } catch (error) {
      checks.push(failed('adapter-capabilities', error));
      return {checks};
    }

    const recipe = {
      durationInFrames: 30,
      fps: 30,
      schemaVersion: 'magnates-remotion-recipe-v2',
      shots: [{
        background: {assetId: 'asset-doctor'},
        camera: {preset: 'hold'},
        durationInFrames: 30,
        id: 'shot-doctor',
        semanticRole: 'hook',
      }],
    };
    const assetPath = path.join(runDirectory, 'doctor.png');
    const recipePath = path.join(runDirectory, 'recipe.json');
    const lockPath = path.join(runDirectory, 'recipe.lock.json');
    const inventoryPath = path.join(runDirectory, 'asset-inventory.json');
    await writeFile(assetPath, png);
    const recipeHash = await writeJson(recipePath, recipe);
    const lockHash = await writeJson(lockPath, {payloadHash: hashPayload(recipe)});
    const inventoryHash = await writeJson(inventoryPath, {assets: [{
      assetId: 'asset-doctor',
      kind: 'image',
      sha256: sha256(png),
      stagedPath: assetPath,
    }]});
    const propsPath = path.join(runDirectory, 'remotion-props.json');
    const buildTelemetryPath = path.join(runDirectory, 'build-telemetry.json');
    let buildResponse;
    try {
      buildResponse = await invoke({
        config,
        expectedHashes: {assetInventory: inventoryHash, recipeLock: lockHash, recipePayload: recipeHash},
        inputs: {assetInventory: inventoryPath, recipeLock: lockPath, recipePayload: recipePath},
        operation: 'build-props',
        outputs: {buildTelemetry: buildTelemetryPath, props: propsPath},
        runDirectory,
        timeoutMs,
        workspace,
      });
      validateResponse(validator, buildResponse);
      validator.validate('remotionProps', parseStrictJson(await readFile(propsPath, 'utf8')));
      checks.push(checked('adapter-build-props', 'schema-valid authenticated remotion-props/v1', artifact(buildResponse, 'remotion-props').sha256));
    } catch (error) {
      checks.push(failed('adapter-build-props', error));
      return {checks};
    }

    if (renderSmoke) {
      try {
        const capabilities = capabilitiesResponse.capabilities;
        const environmentLockPath = path.join(runDirectory, 'renderer-environment.lock.json');
        const environmentLock = {
          adapter: capabilities.adapter,
          capabilitiesHash: hashPayload(capabilities),
          environmentIdentity: capabilities.environmentIdentity,
          lockId: `doctor-${randomUUID()}`,
          lockedAt: new Date().toISOString(),
          outputPolicy,
          schemaDigests: capabilities.schemaDigests,
          schemaVersion: 'editorial://schema/renderer-environment-lock/v1',
          target,
        };
        validator.validate('rendererEnvironmentLock', environmentLock);
        const environmentLockHash = await writeJson(environmentLockPath, environmentLock);
        const propsHash = sha256(await readFile(propsPath));
        const mediaPath = path.join(runDirectory, 'doctor.mp4');
        const renderManifestPath = path.join(runDirectory, 'render-manifest.json');
        const renderTelemetryPath = path.join(runDirectory, 'render-telemetry.jsonl');
        const renderResponse = await invoke({
          config,
          expectedHashes: {propsHash, rendererEnvironmentLock: environmentLockHash},
          inputs: {compositionId: config.compositionId, props: propsPath, propsHash, rendererEnvironmentLock: environmentLockPath},
          operation: 'render',
          outputs: {media: mediaPath, renderManifest: renderManifestPath, renderTelemetry: renderTelemetryPath},
          runDirectory,
          timeoutMs,
          workspace,
        });
        validateResponse(validator, renderResponse);
        validator.validate('renderManifest', parseStrictJson(await readFile(renderManifestPath, 'utf8')));
        const mediaHash = sha256(await readFile(mediaPath));
        const inspectReportPath = path.join(runDirectory, 'inspect-report.json');
        const layoutTelemetryPath = path.join(runDirectory, 'layout-telemetry.json');
        const inspectResponse = await invoke({
          config,
          expectedHashes: {
            media: mediaHash,
            renderManifest: sha256(await readFile(renderManifestPath)),
            renderTelemetry: sha256(await readFile(renderTelemetryPath)),
          },
          inputs: {media: mediaPath, mediaHash, renderManifest: renderManifestPath, renderTelemetry: renderTelemetryPath},
          operation: 'inspect',
          outputs: {inspectReport: inspectReportPath, layoutTelemetry: layoutTelemetryPath},
          runDirectory,
          timeoutMs,
          workspace,
        });
        validateResponse(validator, inspectResponse);
        validator.validate('inspectReport', parseStrictJson(await readFile(inspectReportPath, 'utf8')));
        validator.validate('layoutTelemetry', parseStrictJson(await readFile(layoutTelemetryPath, 'utf8')));
        checks.push(checked('adapter-render-smoke', 'rendered and inspected 30-frame youtube-720p media', {
          mediaHash,
          renderManifestHash: artifact(renderResponse, 'render-manifest').sha256,
        }));
      } catch (error) {
        checks.push(failed('adapter-render-smoke', error));
      }
    }
    return {checks};
  } finally {
    await rm(runDirectory, {force: true, recursive: true});
  }
};
