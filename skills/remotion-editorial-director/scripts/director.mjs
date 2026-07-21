#!/usr/bin/env node

import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, mkdir, readFile, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {promoteArtifact} from './lib/artifact-store.mjs';
import {snapshotAssetInventory} from './lib/asset-snapshot.mjs';
import {
  buildDeterministicAuthoringResult,
  validateAuthoringTrace,
} from './lib/authoring/deterministic-planner.mjs';
import {
  acceptAgentResponse,
  prepareAgentAttempt,
  sha256File,
} from './lib/authoring/agent-handshake.mjs';
import {hashPayload, parseStrictJson} from './lib/canonical-json.mjs';
import {createContractValidator} from './lib/contract-validator.mjs';
import {
  resolveDirectorManifest,
  resolveDirectorProjectOptions,
} from './lib/config.mjs';
import {runDoctor} from './doctor.mjs';
import {hashFile} from './lib/media-facts-cache.mjs';
import {cleanupRuns} from './lib/maintenance/cleanup.mjs';
import {migrateRecipe} from './lib/maintenance/migrate.mjs';
import {conformNarration, expectedAudioSamples} from './lib/media/audio-conformance.mjs';
import {runPythonWorker} from './lib/python-worker.mjs';
import {evaluateDeterministicQa} from './lib/qa/deterministic-qa.mjs';
import {normalizeLayoutTelemetryForQa} from './lib/qa/formal-telemetry.mjs';
import {RunStore} from './lib/run-store.mjs';
import {DirectorEngine} from './lib/stage-engine.mjs';
import {runJsonSubprocess} from './lib/subprocess-boundary.mjs';
import {
  OPERATION_STEPS,
  STAGE_DEFINITIONS,
  createWorkflowStages,
} from './lib/workflow-definition.mjs';

const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contractsDirectory = path.join(skillRoot, 'contracts');
const productionOperations = new Set(Object.keys(OPERATION_STEPS));
const producer = Object.freeze({name: 'remotion-editorial-director', version: '0.1.0'});
const execFileAsync = promisify(execFile);
const techniqueIds = Object.freeze([
  'hard_cut', 'dissolve', 'blur_bridge', 'graphic_transition', 'matte_transition',
  'distortion', 'ambiguous', 'no_local_delta', 'within_setup_change', 'layer_entry',
  'layer_transform', 'mask_reveal', 'persistent_overlay_footage_cut', 'type_on',
  'text_replace', 'text_counter_change', 'underline_entry', 'push_in', 'pull_out',
  'pan_or_tilt', 'scale_track', 'globe_line_assembly', 'comparison_split',
]);

const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  exitCode: 4,
  ...fields,
});

const readStrictJson = async (filePath) => parseStrictJson(await readFile(filePath, 'utf8'));
const artifactPayload = async (filePath) => {
  const value = await readStrictJson(filePath);
  return value?.schemaVersion === 'editorial://schema/artifact-envelope/v1' ? value.payload : value;
};
const localPath = (base, candidate, label) => {
  if (typeof candidate !== 'string' || candidate.length === 0 || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|data:)/u.test(candidate)) {
    throw codedError('LOCAL_PATH_REQUIRED', `${label} must be a local path`, {exitCode: 2});
  }
  return path.resolve(base, candidate);
};
const stageArtifact = (key, reference) => ({key, ...reference});
const stripArtifactKey = ({key: _key, ...reference}) => reference;

const samePayload = (left, right) => hashPayload(left) === hashPayload(right);

const customJsonArtifact = async ({artifactType, payload, relativePath, schemaId, store}) => {
  await store.promoteJson(relativePath, payload);
  const absolutePath = path.join(store.root, relativePath);
  return {
    artifactType,
    path: absolutePath,
    schemaId,
    sha256: await hashFile(absolutePath),
  };
};

const assertRecipeIdentity = ({lock, recipe, target}) => {
  if (
    lock.recipeSchemaVersion !== 'magnates-remotion-recipe-v2' ||
    recipe.schemaVersion !== 'magnates-remotion-recipe-v2'
  ) {
    throw codedError('RECIPE_VERSION_MISMATCH', 'Recipe lock and payload must use immutable recipe v2', {
      exitCode: 4,
    });
  }
  const payloadHash = hashPayload(recipe);
  if (payloadHash !== lock.payloadHash) {
    throw codedError('RECIPE_PAYLOAD_HASH_MISMATCH', 'Recipe payload does not match its immutable lock', {
      exitCode: 4,
    });
  }
  const shotFrames = recipe.shots.reduce((total, shot) => total + shot.durationInFrames, 0);
  if (shotFrames !== recipe.durationInFrames || recipe.fps !== target.fps) {
    throw codedError('RECIPE_TIMELINE_MISMATCH', 'Recipe duration or fps does not match its locked timeline', {
      exitCode: 4,
    });
  }
  return payloadHash;
};

const printable = (value) => typeof value === 'string' ? value : JSON.stringify(value);

const rawArtifact = async ({
  artifactType,
  payload,
  relativePath,
  schemaName,
  store,
  validator,
}) => {
  validator.validate(schemaName, payload);
  const entry = validator.registry.schemas.find(({name}) => name === schemaName);
  await store.promoteJson(relativePath, payload);
  const absolutePath = path.join(store.root, relativePath);
  return {
    artifactType,
    path: absolutePath,
    schemaId: entry.id,
    sha256: await hashFile(absolutePath),
  };
};

const collectInputIdentity = async ({manifest, manifestPath}) => {
  const directory = path.dirname(manifestPath);
  const records = [
    {label: 'manifest', path: manifestPath, sha256: await hashFile(manifestPath)},
    {label: 'resolved-manifest', path: manifestPath, sha256: hashPayload(manifest)},
  ];
  const add = async (label, candidate, base = directory) => {
    if (candidate === undefined) return undefined;
    const absolutePath = localPath(base, candidate, label);
    records.push({label, path: absolutePath, sha256: await hashFile(absolutePath)});
    return absolutePath;
  };
  await add('narration.script', manifest.narration?.script);
  await add('narration.timing', manifest.narration?.timing);
  await add('narration.audio', manifest.narration?.audio);
  const inventoryPath = await add('assets', manifest.assets);
  if (inventoryPath) {
    const inventory = await readStrictJson(inventoryPath);
    for (const asset of inventory.assets ?? []) {
      await add(`asset.${asset.assetId}`, asset.path, path.dirname(inventoryPath));
    }
  }
  await add('evidence', manifest.evidence);
  const recipeLockPath = await add('recipeLock', manifest.recipeLock);
  if (recipeLockPath) {
    const recipeLock = await readStrictJson(recipeLockPath);
    await add('recipeLock.payload', recipeLock.payloadPath, path.dirname(recipeLockPath));
    const sourceRunPath = path.join(path.dirname(path.dirname(recipeLockPath)), 'run.json');
    try {
      const sourceRun = await readStrictJson(sourceRunPath);
      const conformReference = sourceRun.artifacts?.['narration-conform'];
      const audioReference = sourceRun.artifacts?.['conformed-narration'];
      if (conformReference?.path) await add('recipeLock.narrationConform', conformReference.path);
      if (audioReference?.path) await add('recipeLock.conformedNarration', audioReference.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await add('adapterConfig', manifest.adapterConfig);
  await add('modelPolicy.authoringReplay', manifest.modelPolicy?.authoringReplay);
  await add('modelPolicy.reviewReplay', manifest.modelPolicy?.reviewReplay);
  for (const source of manifest.referenceCorpus ?? []) {
    await add(`reference.${source.sourceId}.video`, source.video);
    await add(`reference.${source.sourceId}.subtitles`, source.subtitles);
  }
  records.sort((left, right) => left.label.localeCompare(right.label));
  return {hash: hashPayload(records), records};
};

const implementationIdentity = async () => {
  const digests = await readStrictJson(path.join(skillRoot, 'generated', 'schema-digests.json'));
  return hashPayload({directorVersion: producer.version, schemaDigests: digests});
};

const buildSemanticOutline = ({timing, inventory, fps}) => {
  let cursor = 0;
  const units = timing.spans.map((span, index) => {
    if (span.startSeconds !== cursor || span.endSeconds <= span.startSeconds) {
      throw codedError('TIMED_TRANSCRIPT_NOT_CONTIGUOUS', 'Timed transcript spans must be positive and contiguous');
    }
    cursor = span.endSeconds;
    const narrativeRole = index === 0 ? 'hook' : index === timing.spans.length - 1 ? 'resolution' : 'mechanism';
    const assetId = inventory.assets[index % inventory.assets.length]?.assetId;
    if (!assetId) throw codedError('ASSET_INVENTORY_EMPTY', 'Planning requires at least one staged visual asset');
    return {
      assetRequirements: [assetId],
      claimIds: [`claim-${span.spanId}`],
      emphasis: index === 0 ? 0.85 : 0.6,
      endSeconds: span.endSeconds,
      entityIds: inventory.assets[index % inventory.assets.length].entityIds,
      narrativeRole,
      semanticUnitId: `unit-${span.spanId}`,
      startSeconds: span.startSeconds,
      text: span.text,
      uncertainty: 0,
    };
  });
  if (cursor !== timing.durationSeconds || Math.round(cursor * fps) <= 0) {
    throw codedError('TIMED_TRANSCRIPT_DURATION_MISMATCH', 'Timed transcript does not conserve its duration');
  }
  const entityIds = [...new Set(inventory.assets.flatMap(({entityIds}) => entityIds))];
  return {
    claims: units.map((unit) => ({
      claimId: unit.claimIds[0],
      evidenceClaimIds: [],
      sourceNote: `Locked narration unit ${unit.semanticUnitId}.`,
      text: unit.text,
    })),
    entities: entityIds.map((entityId) => ({entityId, kind: 'concept', label: entityId})),
    metrics: [],
    outlineId: `outline-${hashPayload(units).slice(0, 16)}`,
    schemaVersion: 'editorial://schema/semantic-outline/v1',
    units,
  };
};

const fraction = (value) => {
  const [numerator, denominator = '1'] = String(value).split('/');
  return Number(numerator) / Number(denominator);
};

const probeReferenceVideo = async (videoPath) => {
  const {stdout} = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_frames,r_frame_rate,duration:format=duration',
    '-of', 'json', videoPath,
  ], {maxBuffer: 10 * 1024 * 1024});
  const payload = parseStrictJson(stdout);
  const stream = payload.streams?.[0];
  const durationSeconds = Number(stream?.duration ?? payload.format?.duration);
  const fps = fraction(stream?.r_frame_rate);
  const sourceFrames = Number(stream?.nb_frames) || Math.round(durationSeconds * fps);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0 ||
    !Number.isSafeInteger(sourceFrames) || sourceFrames <= 0) {
    throw codedError('REFERENCE_PROBE_INVALID', `Unable to establish timeline for ${videoPath}`, {exitCode: 5});
  }
  return {durationSeconds, fps, sourceFrames};
};

const detectReferenceBoundaries = async ({sourceHash, sourceId, videoPath}) => {
  const probe = await probeReferenceVideo(videoPath);
  const {stderr = ''} = await execFileAsync('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', videoPath,
    '-vf', 'select=gt(scene\\,0.18),showinfo',
    '-an', '-f', 'null', '-',
  ], {maxBuffer: 32 * 1024 * 1024});
  const boundaryFrames = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/gu)]
    .map((match) => Math.min(probe.sourceFrames - 1, Math.max(0, Math.round(Number(match[1]) * probe.fps))))
    .filter((frame, index, frames) => index === 0 || frame !== frames[index - 1]);
  const intervals = [];
  let cursor = 0;
  for (const [index, frame] of boundaryFrames.entries()) {
    if (cursor < frame) {
      intervals.push({
        endFrame: frame,
        frameReferences: [],
        intervalId: `stable-${index + 1}`,
        kind: 'stable',
        score: 1,
        startFrame: cursor,
      });
    }
    intervals.push({
      endFrame: Math.min(probe.sourceFrames, frame + 1),
      frameReferences: [frame],
      intervalId: `boundary-${index + 1}`,
      kind: 'boundary',
      score: 0.5,
      startFrame: frame,
    });
    cursor = frame + 1;
  }
  if (cursor < probe.sourceFrames) {
    intervals.push({
      endFrame: probe.sourceFrames,
      frameReferences: [],
      intervalId: `stable-${intervals.length + 1}`,
      kind: 'stable',
      score: 1,
      startFrame: cursor,
    });
  }
  return {
    payload: {
      coverage: {
        endFrame: probe.sourceFrames,
        sampledFrames: boundaryFrames.length,
        sourceFrames: probe.sourceFrames,
        startFrame: 0,
      },
      detector: {
        configHash: hashPayload({sceneThreshold: 0.18}),
        name: 'ffmpeg-scene-detector',
        version: '1.0.0',
      },
      intervals,
      schemaVersion: 'editorial://schema/boundary-samples/v1',
      sourceHash,
      sourceId,
    },
    probe,
  };
};

const buildReferenceSemanticOutline = async ({manifest, manifestDirectory, inputIdentity, signal}) => {
  const units = [];
  const claims = [];
  for (const source of manifest.referenceCorpus) {
    const videoPath = localPath(manifestDirectory, source.video, `${source.sourceId}.video`);
    const subtitlePath = localPath(manifestDirectory, source.subtitles, `${source.sourceId}.subtitles`);
    const probe = await probeReferenceVideo(videoPath);
    const parsed = await runPythonWorker({
      operation: 'parse_srt',
      packageRoot: path.join(skillRoot, 'python'),
      params: {
        mediaDurationSeconds: probe.durationSeconds,
        text: await readFile(subtitlePath, 'utf8'),
      },
      signal,
      timeoutMs: (manifest.policy?.analysisTimeoutSeconds ?? 120) * 1000,
    });
    for (const cue of parsed.result) {
      const semanticUnitId = `unit-${source.sourceId}-${cue.id}`;
      const claimId = `claim-${source.sourceId}-${cue.id}`;
      const evidenceClaimId = `evidence-${source.sourceId}-${cue.id}`;
      units.push({
        assetRequirements: [],
        claimIds: [claimId],
        emphasis: 0.5,
        endSeconds: cue.endSeconds,
        entityIds: [],
        narrativeRole: units.length === 0 ? 'hook' : 'mechanism',
        semanticUnitId,
        startSeconds: cue.startSeconds,
        text: cue.text,
        uncertainty: 0.5,
      });
      claims.push({
        claimId,
        evidenceClaimIds: [evidenceClaimId],
        sourceNote: `Locked subtitle cue ${source.sourceId}/${cue.id}.`,
        text: cue.text,
      });
    }
  }
  return {
    claims,
    entities: [],
    metrics: [],
    outlineId: `outline-${inputIdentity.hash.slice(0, 16)}`,
    schemaVersion: 'editorial://schema/semantic-outline/v1',
    units,
  };
};

const plannerInputs = ({outline, inventory, fps}) => {
  const durationInFrames = Math.round(outline.units.at(-1).endSeconds * fps);
  const semanticUnits = outline.units.map((unit) => ({
    assetId: unit.assetRequirements[0],
    endFrame: Math.round(unit.endSeconds * fps),
    evidenceClaimIds: outline.claims
      .filter(({claimId}) => unit.claimIds.includes(claimId))
      .flatMap(({evidenceClaimIds}) => evidenceClaimIds),
    grammarRuleIds: [`default-${unit.narrativeRole}`],
    narrativeRole: unit.narrativeRole,
    semanticUnitId: unit.semanticUnitId,
    startFrame: Math.round(unit.startSeconds * fps),
  }));
  const roles = [...new Set(semanticUnits.map(({narrativeRole}) => narrativeRole))];
  return {
    assetInventory: {assets: inventory.assets.map(({assetId}) => ({assetId}))},
    grammar: {rules: roles.map((role) => ({
      allowedCameras: ['hold'],
      allowedTransitions: ['hard_cut'],
      defaults: {camera: 'hold', transition: 'hard_cut'},
      grammarRuleId: `default-${role}`,
    }))},
    semanticOutline: {durationInFrames, fps, semanticUnits},
  };
};

const latestAgentAttempt = async (runDirectory, stage) => {
  const root = path.join(runDirectory, 'agent', stage.toLowerCase());
  const attempts = (await readdir(root, {withFileTypes: true}))
    .filter((entry) => entry.isDirectory())
    .map(({name}) => name)
    .sort();
  if (attempts.length === 0) throw codedError('AGENT_ATTEMPT_MISSING', `No ${stage} attempt exists`, {exitCode: 3});
  const attemptId = attempts.at(-1);
  const attemptDirectory = path.join(root, attemptId);
  const requestPath = path.join(attemptDirectory, 'request.json');
  const request = await readStrictJson(requestPath);
  return {
    attemptDirectory,
    attemptId,
    inputLockHash: request.inputHashes.inputLockHash,
    request,
    requestHash: hashPayload(request),
    requestId: request.requestId,
    requestPath,
    runId: request.runId,
    stage,
  };
};

const artifactMapFromState = (state) => {
  const artifacts = {};
  for (const [index, artifact] of (state.artifacts ?? []).entries()) {
    const key = artifact.key ?? `${artifact.artifactType}-${index + 1}`;
    artifacts[key] = stripArtifactKey(artifact);
  }
  return artifacts;
};

const internalRunFromIndex = (run) => ({
  artifacts: Object.entries(run.artifacts).map(([key, reference]) => ({key, ...reference})),
  attempts: run.stageAttempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    completedAt: attempt.endedAt,
    stage: attempt.stage,
    startedAt: attempt.startedAt,
    status: attempt.status === 'failed' ? 'failed' : 'succeeded',
  })),
  completedStages: run.stageAttempts
    .filter(({status}) => ['complete', 'awaiting_agent'].includes(status))
    .map(({stage}) => stage),
  currentStage: run.currentStage,
  implementationLockHash: run.implementationVersions.implementationLockHash,
  inputLockHash: run.implementationVersions.inputLockHash,
  outputHashes: {},
  status: run.status,
});

const runIndexFromState = ({state, base, implementationLockHash, inputLockHash}) => {
  const awaiting = state.status === 'awaiting_agent';
  const stageAttempts = (state.attempts ?? []).map((attempt, index, attempts) => ({
    attemptId: attempt.attemptId,
    endedAt: attempt.completedAt,
    stage: attempt.stage,
    startedAt: attempt.startedAt,
    status: awaiting && index === attempts.length - 1 ? 'awaiting_agent' :
      attempt.status === 'failed' ? 'failed' : 'complete',
  }));
  const failure = state.failure ? {
    category: String(state.failure.exitCode ?? 5),
    code: state.failure.code,
    diagnosticId: `diagnostic-${randomUUID()}`,
    retryable: Boolean(state.failure.retryable),
    stage: state.failure.stage,
  } : null;
  return {
    artifacts: artifactMapFromState(state),
    createdAt: base.createdAt,
    currentStage: state.currentStage ?? 'CREATED',
    failure,
    implementationVersions: {
      director: producer.version,
      implementationLockHash,
      inputLockHash,
      ...(state.outputHashes?.AUTHORING_INPUT_READY ? {
        agentRequestHash: state.outputHashes.AUTHORING_INPUT_READY,
      } : base.implementationVersions.agentRequestHash ? {
        agentRequestHash: base.implementationVersions.agentRequestHash,
      } : {}),
      ...(base.implementationVersions.agentResponseHash ? {
        agentResponseHash: base.implementationVersions.agentResponseHash,
      } : {}),
    },
    operation: base.operation,
    runId: base.runId,
    schemaVersion: 'editorial://schema/run/v1',
    stageAttempts,
    status: state.status,
    supersedesRunId: base.supersedesRunId ?? null,
    updatedAt: new Date().toISOString(),
  };
};

const resultFromRun = (run, runPath, exitCode = run.status === 'awaiting_agent' ? 10 : 0) => ({
  artifacts: run.artifacts,
  error: run.failure,
  exitCode,
  operation: run.operation,
  runId: run.runId,
  runPath,
  status: run.status === 'complete' ? 'ok' : run.status,
  terminalStage: run.currentStage,
  warnings: [],
});

const buildExecutors = (runtime) => {
  const artifactReference = async (key) => runtime.currentArtifacts()[key];
  const readInputs = async () => ({
    inventory: await artifactPayload((await artifactReference('asset-inventory')).path),
    outline: await artifactPayload((await artifactReference('semantic-outline')).path),
  });
  const readRecipeSourceRun = async () => {
    const recipeLockPath = localPath(
      runtime.manifestDirectory,
      runtime.manifest.recipeLock,
      'recipeLock',
    );
    const sourceRunPath = path.join(path.dirname(path.dirname(recipeLockPath)), 'run.json');
    let sourceRun;
    try {
      sourceRun = await readStrictJson(sourceRunPath);
      runtime.validator.validate('run', sourceRun);
    } catch (error) {
      throw codedError(
        'ASSET_INVENTORY_MISSING',
        'render-recipe requires manifest.assets or a recipe lock from a Director run',
        {cause: error, exitCode: 4},
      );
    }
    return sourceRun;
  };
  const readSourceInventory = async () => {
    if (runtime.manifest.assets) {
      const inventoryPath = localPath(runtime.manifestDirectory, runtime.manifest.assets, 'assets');
      return {inventory: await readStrictJson(inventoryPath), inventoryPath};
    }
    if (runtime.operation !== 'render-recipe') {
      throw codedError('ASSET_INVENTORY_MISSING', 'The operation requires an asset inventory', {exitCode: 4});
    }
    const sourceRun = await readRecipeSourceRun();
    const reference = sourceRun.artifacts['asset-inventory'];
    if (!reference || await hashFile(reference.path) !== reference.sha256) {
      throw codedError('ASSET_INVENTORY_HASH_MISMATCH', 'Source run asset inventory is missing or changed', {
        exitCode: 4,
      });
    }
    return {inventory: await artifactPayload(reference.path), inventoryPath: reference.path};
  };
  const adapterRuntime = async () => {
    const configPath = localPath(
      runtime.manifestDirectory,
      runtime.manifest.adapterConfig,
      'adapterConfig',
    );
    const config = await readStrictJson(configPath);
    runtime.validator.validate('adapterConfig', config);
    return {
      command: config.command,
      config,
      configPath,
      workspace: localPath(path.dirname(configPath), config.workspace, 'adapterConfig.workspace'),
    };
  };
  const runAdapter = async ({expectedHashes, inputs, operation, outputs, signal}) => {
    const adapter = await adapterRuntime();
    const timeoutMs = (runtime.manifest.policy?.adapterTimeoutSeconds ?? 120) * 1000;
    const request = {
      adapterProtocolVersion: 1,
      deadline: new Date(Date.now() + timeoutMs).toISOString(),
      expectedHashes,
      inputs,
      operation,
      operationId: randomUUID(),
      outputs,
      recipeSchemaVersion: 'magnates-remotion-recipe-v2',
      runDirectory: runtime.runDirectory,
      target: runtime.manifest.target.profile,
      workspace: adapter.workspace,
    };
    runtime.validator.validate('adapterRequest', request);
    const result = await runJsonSubprocess({
      command: adapter.command,
      cwd: adapter.workspace,
      environmentNames: adapter.config.environmentVariables ?? [],
      request,
      signal,
      timeoutMs,
    });
    const {diagnostics, ...response} = result;
    runtime.validator.validate('adapterResponse', response);
    if (response.status !== 'ok') {
      throw codedError(response.error.code, response.error.message, {
        exitCode: diagnostics.exitCode,
        retryable: response.error.retryable,
        stage: response.error.stage,
      });
    }
    if (response.warnings.some(({blocking}) => blocking)) {
      throw codedError('ADAPTER_BLOCKING_WARNING', 'Adapter returned a blocking warning', {
        exitCode: 5,
        stage: operation,
      });
    }
    return {adapter, request, response};
  };
  const assertContainedFile = async (candidate, expectedPath, label) => {
    const resolved = path.resolve(candidate);
    const expected = path.resolve(expectedPath);
    const relative = path.relative(runtime.runDirectory, resolved);
    if (resolved !== expected || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw codedError('ADAPTER_ARTIFACT_PATH_MISMATCH', `${label} was not written to its requested run path`, {
        exitCode: 7,
      });
    }
    const stats = await lstat(resolved);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw codedError('ADAPTER_ARTIFACT_INVALID', `${label} must be a regular non-symlink file`, {
        exitCode: 7,
      });
    }
    const [rootRealPath, fileRealPath] = await Promise.all([realpath(runtime.runDirectory), realpath(resolved)]);
    const realRelative = path.relative(rootRealPath, fileRealPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw codedError('ADAPTER_ARTIFACT_PATH_MISMATCH', `${label} escapes the run directory`, {exitCode: 7});
    }
    return resolved;
  };
  const validateAdapterArtifacts = async (response, expected) => {
    if (response.artifacts.length !== Object.keys(expected).length) {
      throw codedError('ADAPTER_ARTIFACT_SET_MISMATCH', 'Adapter returned an unexpected artifact set', {
        exitCode: 7,
      });
    }
    const references = {};
    for (const [type, specification] of Object.entries(expected)) {
      const matches = response.artifacts.filter((artifact) => artifact.type === type);
      if (matches.length !== 1) {
        throw codedError('ADAPTER_ARTIFACT_SET_MISMATCH', `Adapter must return exactly one ${type}`, {
          exitCode: 7,
        });
      }
      const artifact = matches[0];
      const artifactPath = await assertContainedFile(artifact.path, specification.path, type);
      if (artifact.schemaId !== specification.schemaId || await hashFile(artifactPath) !== artifact.sha256) {
        throw codedError('ADAPTER_ARTIFACT_HASH_MISMATCH', `${type} identity is invalid`, {exitCode: 7});
      }
      references[type] = {
        artifactType: type,
        path: artifactPath,
        schemaId: artifact.schemaId,
        sha256: artifact.sha256,
      };
    }
    return references;
  };

  return {
    INTAKE_LOCKED: async () => {
      const artifacts = [];
      const lockedManifest = await promoteArtifact({
        artifactType: 'input-manifest',
        inputHashes: Object.fromEntries(runtime.inputIdentity.records.map((record, index) => [
          `source-${index + 1}`,
          record.sha256,
        ])),
        payload: runtime.manifest,
        relativePath: 'input-manifest.lock.json',
        runId: runtime.runId,
        schemaName: 'inputManifest',
        store: runtime.store,
        validator: runtime.validator,
      });
      artifacts.push(stageArtifact('input-manifest', lockedManifest.reference));
      if (['plan-edit', 'produce'].includes(runtime.operation)) {
        const timingPath = localPath(runtime.manifestDirectory, runtime.manifest.narration.timing, 'narration.timing');
        const timing = await readStrictJson(timingPath);
        runtime.validator.validate('timedTranscript', timing);
        const timingArtifact = await promoteArtifact({
          artifactType: 'timed-transcript',
          inputHashes: {source: await hashFile(timingPath)},
          payload: timing,
          relativePath: 'evidence/timed-transcript.json',
          runId: runtime.runId,
          schemaName: 'timedTranscript',
          store: runtime.store,
          validator: runtime.validator,
        });
        artifacts.push(stageArtifact('timed-transcript', timingArtifact.reference));
      }
      if (['plan-edit', 'produce', 'render-recipe'].includes(runtime.operation)) {
        const {inventory: sourceInventory, inventoryPath} = await readSourceInventory();
        runtime.validator.validate('assetInventory', sourceInventory);
        const inventory = await snapshotAssetInventory({
          inventory: sourceInventory,
          inventoryDirectory: path.dirname(inventoryPath),
          runDirectory: runtime.runDirectory,
        });
        const inventoryArtifact = await rawArtifact({
          artifactType: 'asset-inventory',
          payload: inventory,
          relativePath: 'evidence/asset-inventory.json',
          schemaName: 'assetInventory',
          store: runtime.store,
          validator: runtime.validator,
        });
        artifacts.push(stageArtifact('asset-inventory', inventoryArtifact));
      }
      return {artifacts, outputHashes: {INTAKE_LOCKED: runtime.inputIdentity.hash}};
    },
    SEMANTICS_READY: async ({signal}) => {
      let outline;
      let inputHashes;
      if (runtime.operation === 'analyze-reference') {
        outline = await buildReferenceSemanticOutline({
          inputIdentity: runtime.inputIdentity,
          manifest: runtime.manifest,
          manifestDirectory: runtime.manifestDirectory,
          signal,
        });
        inputHashes = {corpus: runtime.inputIdentity.hash};
      } else {
        const timing = await artifactPayload((await artifactReference('timed-transcript')).path);
        const inventory = await artifactPayload((await artifactReference('asset-inventory')).path);
        outline = buildSemanticOutline({fps: runtime.manifest.target.profile.fps, inventory, timing});
        inputHashes = {timing: hashPayload(timing)};
      }
      const promoted = await promoteArtifact({
        artifactType: 'semantic-outline',
        inputHashes,
        payload: outline,
        relativePath: 'evidence/semantic-outline.json',
        runId: runtime.runId,
        schemaName: 'semanticOutline',
        store: runtime.store,
        validator: runtime.validator,
      });
      return {
        artifacts: [stageArtifact('semantic-outline', promoted.reference)],
        outputHashes: {SEMANTICS_READY: promoted.contentHash},
      };
    },
    BOUNDARIES_READY: async () => {
      const artifacts = [];
      const references = [];
      for (const source of runtime.manifest.referenceCorpus) {
        const videoPath = localPath(
          runtime.manifestDirectory,
          source.video,
          `reference.${source.sourceId}.video`,
        );
        const sourceHash = runtime.inputIdentity.records
          .find(({label}) => label === `reference.${source.sourceId}.video`)?.sha256;
        const {payload} = await detectReferenceBoundaries({
          sourceHash,
          sourceId: source.sourceId,
          videoPath,
        });
        const promoted = await promoteArtifact({
          artifactType: 'boundary-samples',
          inputHashes: {source: sourceHash},
          payload,
          relativePath: `evidence/boundary-samples/${source.sourceId}.json`,
          runId: runtime.runId,
          schemaName: 'boundarySamples',
          store: runtime.store,
          validator: runtime.validator,
        });
        const reference = promoted.reference;
        references.push(reference);
        artifacts.push(stageArtifact(`boundary-samples-${source.sourceId}`, reference));
      }
      const index = {
        schemaVersion: 'editorial://schema/boundary-index/v1',
        sources: references,
      };
      const relativePath = 'evidence/boundary-samples/index.json';
      await runtime.store.promoteJson(relativePath, index);
      const indexPath = path.join(runtime.runDirectory, relativePath);
      const indexReference = {
        artifactType: 'boundary-index',
        path: indexPath,
        schemaId: 'editorial://schema/boundary-index/v1',
        sha256: await hashFile(indexPath),
      };
      artifacts.push(stageArtifact('boundary-samples-index', indexReference));
      return {
        artifacts,
        outputHashes: {BOUNDARIES_READY: hashPayload(index)},
      };
    },
    REVIEW_INPUT_READY: async ({attemptId}) => {
      const outlineReference = await artifactReference('semantic-outline');
      const outline = await artifactPayload(outlineReference.path);
      const sources = runtime.manifest.referenceCorpus.map((source) => ({
        calibrationTier: 'machine_only',
        mediaHash: runtime.inputIdentity.records
          .find(({label}) => label === `reference.${source.sourceId}.video`).sha256,
        sourceId: source.sourceId,
        transcriptHash: runtime.inputIdentity.records
          .find(({label}) => label === `reference.${source.sourceId}.subtitles`).sha256,
      }));
      const claims = outline.units.map((unit) => {
        const sourceId = runtime.manifest.referenceCorpus
          .find((source) => unit.semanticUnitId.startsWith(`unit-${source.sourceId}-`)).sourceId;
        return {
          claimId: unit.claimIds[0].replace(/^claim-/u, 'evidence-'),
          confidence: 0.5,
          evidenceType: 'unresolved',
          frameReferences: [],
          semanticUnitIds: [unit.semanticUnitId],
          sourceId,
          statement: unit.text,
          timeRange: {endSeconds: unit.endSeconds, startSeconds: unit.startSeconds},
        };
      });
      const corpusEvidence = {
        analysisVersion: '1.0.0',
        claims,
        corpusId: `corpus-${runtime.inputIdentity.hash.slice(0, 16)}`,
        schemaVersion: 'editorial://schema/corpus-evidence/v1',
        sources,
      };
      const promoted = await promoteArtifact({
        artifactType: 'corpus-evidence',
        inputHashes: {corpus: runtime.inputIdentity.hash},
        payload: corpusEvidence,
        relativePath: 'evidence/corpus-evidence.json',
        runId: runtime.runId,
        schemaName: 'corpusEvidence',
        store: runtime.store,
        validator: runtime.validator,
      });
      const boundaryIndex = await artifactReference('boundary-samples-index');
      const attempt = await prepareAgentAttempt({
        attemptId,
        inputLockHash: runtime.inputIdentity.hash,
        payload: {
          boundarySamples: boundaryIndex,
          corpusEvidence: promoted.reference,
          semanticOutline: outlineReference,
          techniqueIds,
        },
        runDirectory: runtime.runDirectory,
        runId: runtime.runId,
        stage: 'REVIEW',
      });
      const requestReference = {
        artifactType: 'agent-request',
        path: attempt.requestPath,
        schemaId: 'editorial://schema/agent-request/v1',
        sha256: await sha256File(attempt.requestPath),
      };
      return {
        artifacts: [
          stageArtifact('corpus-evidence', promoted.reference),
          stageArtifact('agent-review-request', requestReference),
        ],
        ...(runtime.reviewMode === 'agent' ? {
          awaitingAgent: {attemptId, stage: 'REVIEW'},
        } : {}),
        outputHashes: {REVIEW_INPUT_READY: attempt.requestHash},
      };
    },
    TECHNIQUES_CLASSIFIED: async () => {
      const corpusEvidence = await artifactPayload((await artifactReference('corpus-evidence')).path);
      let annotations;
      if (runtime.reviewMode === 'agent') {
        const attempt = await latestAgentAttempt(runtime.runDirectory, 'REVIEW');
        const response = await readStrictJson(path.join(attempt.attemptDirectory, 'response.json'));
        if (response.status !== 'ok') {
          throw codedError('AGENT_REVIEW_NEEDS_REVIEW', response.payload.summary, {exitCode: 4});
        }
        annotations = response.payload.techniqueAnnotations;
      } else if (runtime.reviewMode === 'replay') {
        const replayPath = localPath(
          runtime.manifestDirectory,
          runtime.manifest.modelPolicy.reviewReplay,
          'modelPolicy.reviewReplay',
        );
        const replay = await readStrictJson(replayPath);
        annotations = replay.payload?.techniqueAnnotations ?? replay.techniqueAnnotations ?? replay;
      } else {
        annotations = {
          annotationSetId: `annotations-${runtime.inputIdentity.hash.slice(0, 16)}`,
          claims: corpusEvidence.claims.map((claim) => ({
            claimId: `technique-${claim.claimId}`,
            evidenceType: 'unresolved',
            frameReferences: [],
            notes: 'Deterministic analysis cannot assign a named editorial technique without review.',
            reviewStatus: 'needs_review',
            semanticUnitIds: claim.semanticUnitIds,
            sourceId: claim.sourceId,
            techniqueId: 'ambiguous',
            timeRange: claim.timeRange,
          })),
          reviewStatus: 'needs_review',
          schemaVersion: 'editorial://schema/technique-annotations/v1',
          sourceHash: hashPayload(corpusEvidence),
        };
      }
      runtime.validator.validate('techniqueAnnotations', annotations);
      const promoted = await promoteArtifact({
        artifactType: 'technique-annotations',
        inputHashes: {review: runtime.state.outputHashes.REVIEW_INPUT_READY},
        payload: annotations,
        relativePath: 'evidence/technique-annotations.json',
        runId: runtime.runId,
        schemaName: 'techniqueAnnotations',
        store: runtime.store,
        validator: runtime.validator,
      });
      return {
        artifacts: [stageArtifact('technique-annotations', promoted.reference)],
        outputHashes: {TECHNIQUES_CLASSIFIED: promoted.contentHash},
      };
    },
    AUTHORING_INPUT_READY: async ({attemptId}) => {
      const outlineReference = await artifactReference('semantic-outline');
      const inventoryReference = await artifactReference('asset-inventory');
      const outline = await artifactPayload(outlineReference.path);
      const grammarRuleIds = [...new Set(outline.units.map(({narrativeRole}) => `default-${narrativeRole}`))];
      const attempt = await prepareAgentAttempt({
        attemptId,
        inputLockHash: runtime.inputIdentity.hash,
        payload: {
          assetInventory: inventoryReference,
          grammarRuleIds,
          semanticOutline: outlineReference,
          target: runtime.manifest.target.profile,
        },
        runDirectory: runtime.runDirectory,
        runId: runtime.runId,
        stage: 'AUTHORING',
      });
      const reference = {
        artifactType: 'agent-request',
        path: attempt.requestPath,
        schemaId: 'editorial://schema/agent-request/v1',
        sha256: await sha256File(attempt.requestPath),
      };
      return {
        artifacts: [stageArtifact('agent-authoring-request', reference)],
        ...(runtime.authoringMode === 'agent' ? {
          awaitingAgent: {attemptId, stage: 'AUTHORING'},
        } : {}),
        outputHashes: {AUTHORING_INPUT_READY: attempt.requestHash},
      };
    },
    RECIPE_DRAFTED: async () => {
      const {inventory, outline} = await readInputs();
      const planning = plannerInputs({fps: runtime.manifest.target.profile.fps, inventory, outline});
      let authoringResult;
      if (runtime.authoringMode === 'deterministic') {
        authoringResult = buildDeterministicAuthoringResult(planning);
      } else if (runtime.authoringMode === 'replay') {
        const replayPath = localPath(
          runtime.manifestDirectory,
          runtime.manifest.modelPolicy.authoringReplay,
          'modelPolicy.authoringReplay',
        );
        const replay = await readStrictJson(replayPath);
        authoringResult = replay.payload?.authoringResult ?? replay.authoringResult ?? replay;
      } else {
        const attempt = await latestAgentAttempt(runtime.runDirectory, 'AUTHORING');
        const response = await readStrictJson(path.join(attempt.attemptDirectory, 'response.json'));
        if (response.status !== 'ok') {
          throw codedError('AGENT_AUTHORING_NEEDS_REVIEW', response.payload.summary, {exitCode: 4});
        }
        authoringResult = response.payload.authoringResult;
      }
      runtime.validator.validate('authoringResult', authoringResult);
      validateAuthoringTrace({authoringResult, ...planning});
      const promoted = await promoteArtifact({
        artifactType: 'authoring-result',
        inputHashes: {request: runtime.agentRequestHash()},
        payload: authoringResult,
        relativePath: 'recipe/authoring-result.json',
        runId: runtime.runId,
        schemaName: 'authoringResult',
        store: runtime.store,
        validator: runtime.validator,
      });
      const draft = await rawArtifact({
        artifactType: 'recipe-v2',
        payload: authoringResult.recipeCandidate,
        relativePath: 'recipe/recipe.draft.json',
        schemaName: 'recipeV2',
        store: runtime.store,
        validator: runtime.validator,
      });
      return {
        artifacts: [
          stageArtifact('authoring-result', promoted.reference),
          stageArtifact('recipe-draft', draft),
        ],
        outputHashes: {RECIPE_DRAFTED: hashPayload(authoringResult.recipeCandidate)},
      };
    },
    RECIPE_VALIDATED: async () => {
      if (runtime.operation === 'render-recipe') {
        const sourceLockPath = localPath(
          runtime.manifestDirectory,
          runtime.manifest.recipeLock,
          'recipeLock',
        );
        const lock = await readStrictJson(sourceLockPath);
        runtime.validator.validate('recipeLock', lock);
        const sourcePayloadPath = localPath(path.dirname(sourceLockPath), lock.payloadPath, 'recipeLock.payloadPath');
        const recipe = await readStrictJson(sourcePayloadPath);
        runtime.validator.validate('recipeV2', recipe);
        const recipeHash = assertRecipeIdentity({
          lock,
          recipe,
          target: runtime.manifest.target.profile,
        });
        const validation = {
          authoringResultHash: lock.authoringResultHash,
          checks: [{
            checkId: 'external-lock-and-payload',
            instancePath: '',
            message: 'External recipe lock, payload hash, v2 identity, and timeline passed.',
            severity: 'error',
            status: 'pass',
          }],
          recipeHash,
          recipeSchemaVersion: 'magnates-remotion-recipe-v2',
          schemaVersion: 'editorial://schema/validation-report/v1',
          valid: true,
          validatedAt: new Date().toISOString(),
          validator: producer,
        };
        const payloadReference = await rawArtifact({
          artifactType: 'recipe-v2',
          payload: recipe,
          relativePath: 'recipe/recipe.payload.json',
          schemaName: 'recipeV2',
          store: runtime.store,
          validator: runtime.validator,
        });
        const lockReference = await rawArtifact({
          artifactType: 'recipe-lock',
          payload: lock,
          relativePath: 'recipe/recipe.lock.json',
          schemaName: 'recipeLock',
          store: runtime.store,
          validator: runtime.validator,
        });
        const validationReference = await rawArtifact({
          artifactType: 'validation-report',
          payload: validation,
          relativePath: 'recipe/recipe.validation.json',
          schemaName: 'validationReport',
          store: runtime.store,
          validator: runtime.validator,
        });
        return {
          artifacts: [
            stageArtifact('recipe-payload', payloadReference),
            stageArtifact('recipe-validation', validationReference),
            stageArtifact('recipe-lock', lockReference),
          ],
          outputHashes: {RECIPE_VALIDATED: recipeHash},
        };
      }
      const draft = await readStrictJson((await artifactReference('recipe-draft')).path);
      const authoringResult = await artifactPayload((await artifactReference('authoring-result')).path);
      runtime.validator.validate('recipeV2', draft);
      const recipeHash = hashPayload(draft);
      const authoringResultHash = hashPayload(authoringResult);
      const now = new Date().toISOString();
      const validation = {
        authoringResultHash,
        checks: [{
          checkId: 'schema-and-trace',
          instancePath: '',
          message: 'Recipe schema, duration, identities, and trace coverage passed.',
          severity: 'error',
          status: 'pass',
        }],
        recipeHash,
        recipeSchemaVersion: 'magnates-remotion-recipe-v2',
        schemaVersion: 'editorial://schema/validation-report/v1',
        valid: true,
        validatedAt: now,
        validator: producer,
      };
      const payload = await rawArtifact({
        artifactType: 'recipe-v2',
        payload: draft,
        relativePath: 'recipe/recipe.payload.json',
        schemaName: 'recipeV2',
        store: runtime.store,
        validator: runtime.validator,
      });
      const validationReference = await rawArtifact({
        artifactType: 'validation-report',
        payload: validation,
        relativePath: 'recipe/recipe.validation.json',
        schemaName: 'validationReport',
        store: runtime.store,
        validator: runtime.validator,
      });
      const responseHash = runtime.authoringMode === 'agent'
        ? await sha256File(path.join((await latestAgentAttempt(runtime.runDirectory, 'AUTHORING')).attemptDirectory, 'response.json'))
        : undefined;
      const lock = {
        authoringIdentity: {
          mode: runtime.authoringMode,
          producer,
          ...(responseHash ? {responseHash} : {}),
        },
        authoringResultHash,
        evidenceHashes: {},
        lockId: `recipe-lock-${runtime.runId}`,
        lockedAt: now,
        payloadHash: recipeHash,
        payloadPath: payload.path,
        reason: 'initial',
        recipeSchemaVersion: 'magnates-remotion-recipe-v2',
        schemaVersion: 'editorial://schema/recipe-lock/v1',
        supersedes: null,
        validationReportHash: hashPayload(validation),
      };
      assertRecipeIdentity({lock, recipe: draft, target: runtime.manifest.target.profile});
      const lockReference = await rawArtifact({
        artifactType: 'recipe-lock',
        payload: lock,
        relativePath: 'recipe/recipe.lock.json',
        schemaName: 'recipeLock',
        store: runtime.store,
        validator: runtime.validator,
      });
      return {
        artifacts: [
          stageArtifact('recipe-payload', payload),
          stageArtifact('recipe-validation', validationReference),
          stageArtifact('recipe-lock', lockReference),
        ],
        outputHashes: {RECIPE_VALIDATED: recipeHash},
      };
    },
    AUDIO_CONFORMED: async ({signal}) => {
      const recipe = await readStrictJson((await artifactReference('recipe-payload')).path);
      const audioMode = runtime.manifest.target.outputPolicy.audioMode;
      let sourceAudio = runtime.manifest.narration?.audio;
      let lockedSourceHash;
      if (!sourceAudio && runtime.operation === 'render-recipe' && audioMode !== 'forbidden') {
        const sourceRun = await readRecipeSourceRun();
        const conformReference = sourceRun.artifacts['narration-conform'];
        const audioReference = sourceRun.artifacts['conformed-narration'];
        if (conformReference && await hashFile(conformReference.path) === conformReference.sha256) {
          const priorConform = await readStrictJson(conformReference.path);
          if (
            priorConform.status === 'conformed' && audioReference &&
            priorConform.output?.sha256 === audioReference.sha256 &&
            await hashFile(audioReference.path) === audioReference.sha256
          ) {
            sourceAudio = audioReference.path;
            lockedSourceHash = audioReference.sha256;
          }
        }
      }
      if (audioMode === 'required' && !sourceAudio) {
        throw codedError('NARRATION_AUDIO_REQUIRED', 'The target audio policy requires narration audio', {
          exitCode: 2,
          stage: 'AUDIO_CONFORMED',
        });
      }
      const expectedSamples = expectedAudioSamples({
        durationInFrames: recipe.durationInFrames,
        fps: recipe.fps,
      });
      const artifacts = [];
      let record;
      if (sourceAudio && audioMode !== 'forbidden') {
        const inputPath = localPath(runtime.manifestDirectory, sourceAudio, 'narration.audio');
        const outputPath = path.join(runtime.runDirectory, 'audio', 'narration.wav');
        await mkdir(path.dirname(outputPath), {recursive: true});
        const conformed = await conformNarration({
          durationInFrames: recipe.durationInFrames,
          fps: recipe.fps,
          inputPath,
          outputPath,
          signal,
        });
        const audioReference = {
          artifactType: 'conformed-narration',
          path: outputPath,
          schemaId: 'audio/wav',
          sha256: await hashFile(outputPath),
        };
        artifacts.push(stageArtifact('conformed-narration', audioReference));
        record = {
          audioMode,
          durationInFrames: recipe.durationInFrames,
          fps: recipe.fps,
          output: audioReference,
          sampleCount: conformed.sampleCount,
          sampleRate: conformed.sampleRate,
          schemaVersion: 'editorial://schema/narration-conform/v1',
          sourceHash: lockedSourceHash ?? await hashFile(inputPath),
          status: 'conformed',
        };
      } else {
        record = {
          audioMode,
          durationInFrames: recipe.durationInFrames,
          fps: recipe.fps,
          output: null,
          reason: audioMode === 'forbidden' ? 'forbidden_by_policy' : 'not_supplied',
          sampleCount: expectedSamples,
          sampleRate: 48000,
          schemaVersion: 'editorial://schema/narration-conform/v1',
          status: 'absent',
        };
      }
      const conformReference = await customJsonArtifact({
        artifactType: 'narration-conform',
        payload: record,
        relativePath: 'audio/narration-conform.json',
        schemaId: 'editorial://schema/narration-conform/v1',
        store: runtime.store,
      });
      artifacts.push(stageArtifact('narration-conform', conformReference));
      return {
        artifacts,
        outputHashes: {AUDIO_CONFORMED: conformReference.sha256},
      };
    },
    ADAPTER_READY: async ({signal}) => {
      const {request, response} = await runAdapter({
        expectedHashes: {},
        inputs: {},
        operation: 'capabilities',
        outputs: {},
        signal,
      });
      const capabilities = response.capabilities;
      const targetSupported = capabilities.targetProfiles.some((target) =>
        samePayload(target, runtime.manifest.target.profile));
      if (
        !samePayload(response.adapter, capabilities.adapter) ||
        !capabilities.supportedProtocolVersions.includes(1) ||
        !capabilities.recipeSchemaVersions.includes('magnates-remotion-recipe-v2') ||
        !['capabilities', 'build-props', 'render', 'inspect']
          .every((operation) => capabilities.operations.includes(operation)) ||
        !capabilities.compositionIds.includes((await adapterRuntime()).config.compositionId) ||
        !capabilities.audioModes.includes(runtime.manifest.target.outputPolicy.audioMode) ||
        !targetSupported
      ) {
        throw codedError('ADAPTER_CAPABILITIES_MISMATCH', 'Adapter cannot satisfy the locked render request', {
          exitCode: 3,
          stage: 'ADAPTER_READY',
        });
      }
      const capabilitiesReference = await rawArtifact({
        artifactType: 'adapter-capabilities',
        payload: capabilities,
        relativePath: 'adapter/capabilities.json',
        schemaName: 'adapterCapabilities',
        store: runtime.store,
        validator: runtime.validator,
      });
      const environmentLock = {
        adapter: capabilities.adapter,
        capabilitiesHash: hashPayload(capabilities),
        environmentIdentity: capabilities.environmentIdentity,
        lockId: `renderer-environment-${runtime.runId}`,
        lockedAt: new Date().toISOString(),
        outputPolicy: runtime.manifest.target.outputPolicy,
        schemaDigests: capabilities.schemaDigests,
        schemaVersion: 'editorial://schema/renderer-environment-lock/v1',
        target: runtime.manifest.target.profile,
      };
      const environmentReference = await rawArtifact({
        artifactType: 'renderer-environment-lock',
        payload: environmentLock,
        relativePath: 'adapter/renderer-environment.lock.json',
        schemaName: 'rendererEnvironmentLock',
        store: runtime.store,
        validator: runtime.validator,
      });
      return {
        artifacts: [
          stageArtifact('adapter-capabilities', capabilitiesReference),
          stageArtifact('renderer-environment-lock', environmentReference),
        ],
        outputHashes: {ADAPTER_READY: hashPayload({
          capabilities: capabilitiesReference.sha256,
          environment: environmentReference.sha256,
          operationId: request.operationId,
        })},
      };
    },
    PROPS_BUILT: async ({signal}) => {
      const recipePayload = await artifactReference('recipe-payload');
      const recipeLock = await artifactReference('recipe-lock');
      const assetInventory = await artifactReference('asset-inventory');
      const narrationConform = await artifactReference('narration-conform');
      const propsPath = path.join(runtime.runDirectory, 'render', 'remotion-props.json');
      const buildTelemetryPath = path.join(runtime.runDirectory, 'render', 'build-telemetry.json');
      const {request, response} = await runAdapter({
        expectedHashes: {
          assetInventory: assetInventory.sha256,
          narrationConform: narrationConform.sha256,
          recipeLock: recipeLock.sha256,
          recipePayload: recipePayload.sha256,
        },
        inputs: {
          assetInventory: assetInventory.path,
          narrationConform: narrationConform.path,
          recipeLock: recipeLock.path,
          recipePayload: recipePayload.path,
        },
        operation: 'build-props',
        outputs: {buildTelemetry: buildTelemetryPath, props: propsPath},
        signal,
      });
      const references = await validateAdapterArtifacts(response, {
        'build-telemetry': {
          path: buildTelemetryPath,
          schemaId: 'editorial://schema/build-telemetry/v1',
        },
        'remotion-props': {path: propsPath, schemaId: 'editorial://schema/remotion-props/v1'},
      });
      const props = await readStrictJson(propsPath);
      runtime.validator.validate('remotionProps', props);
      const recipe = await readStrictJson(recipePayload.path);
      const config = (await adapterRuntime()).config;
      if (
        props.recipeHash !== hashPayload(recipe) ||
        props.durationInFrames !== recipe.durationInFrames ||
        props.fps !== recipe.fps ||
        props.compositionId !== config.compositionId ||
        !samePayload(props.target, runtime.manifest.target.profile)
      ) {
        throw codedError('REMOTION_PROPS_IDENTITY_MISMATCH', 'Adapter props do not match the locked recipe', {
          exitCode: 7,
          stage: 'PROPS_BUILT',
        });
      }
      const capabilities = await readStrictJson((await artifactReference('adapter-capabilities')).path);
      if (!samePayload(response.adapter, capabilities.adapter)) {
        throw codedError('ADAPTER_IDENTITY_MISMATCH', 'Adapter identity changed after capability negotiation', {
          exitCode: 3,
          stage: 'PROPS_BUILT',
        });
      }
      return {
        artifacts: [
          stageArtifact('remotion-props', references['remotion-props']),
          stageArtifact('build-telemetry', references['build-telemetry']),
        ],
        outputHashes: {PROPS_BUILT: references['remotion-props'].sha256},
      };
    },
    RENDERED: async ({signal}) => {
      const propsReference = await artifactReference('remotion-props');
      const environmentReference = await artifactReference('renderer-environment-lock');
      const config = (await adapterRuntime()).config;
      const mediaPath = path.join(runtime.runDirectory, 'render', 'final.mp4');
      const manifestPath = path.join(runtime.runDirectory, 'render', 'render-manifest.json');
      const telemetryPath = path.join(runtime.runDirectory, 'render', 'render-telemetry.json');
      const {request, response} = await runAdapter({
        expectedHashes: {
          props: propsReference.sha256,
          rendererEnvironmentLock: environmentReference.sha256,
        },
        inputs: {
          compositionId: config.compositionId,
          props: propsReference.path,
          propsHash: propsReference.sha256,
          rendererEnvironmentLock: environmentReference.path,
        },
        operation: 'render',
        outputs: {media: mediaPath, renderManifest: manifestPath, renderTelemetry: telemetryPath},
        signal,
      });
      const references = await validateAdapterArtifacts(response, {
        media: {path: mediaPath, schemaId: 'editorial://schema/media/v1'},
        'render-manifest': {path: manifestPath, schemaId: 'editorial://schema/render-manifest/v1'},
        'render-telemetry': {path: telemetryPath, schemaId: 'editorial://schema/render-telemetry/v1'},
      });
      const renderManifest = await readStrictJson(manifestPath);
      runtime.validator.validate('renderManifest', renderManifest);
      const recipe = await readStrictJson((await artifactReference('recipe-payload')).path);
      const capabilities = await readStrictJson((await artifactReference('adapter-capabilities')).path);
      if (
        renderManifest.operationId !== request.operationId ||
        renderManifest.recipeHash !== hashPayload(recipe) ||
        renderManifest.propsHash !== propsReference.sha256 ||
        renderManifest.compositionId !== config.compositionId ||
        renderManifest.environmentLockHash !== environmentReference.sha256 ||
        !samePayload(renderManifest.target, runtime.manifest.target.profile) ||
        !samePayload(renderManifest.outputSettings, runtime.manifest.target.outputPolicy) ||
        !samePayload(renderManifest.adapter, capabilities.adapter) ||
        renderManifest.media.path !== mediaPath ||
        renderManifest.media.sha256 !== references.media.sha256 ||
        renderManifest.media.frameCount !== recipe.durationInFrames
      ) {
        throw codedError('RENDER_MANIFEST_IDENTITY_MISMATCH', 'Render manifest does not match locked inputs', {
          exitCode: 7,
          stage: 'RENDERED',
        });
      }
      return {
        artifacts: [
          stageArtifact('rendered-media', references.media),
          stageArtifact('render-manifest', references['render-manifest']),
          stageArtifact('render-telemetry', references['render-telemetry']),
        ],
        outputHashes: {RENDERED: references.media.sha256},
      };
    },
    INSPECTED: async ({signal}) => {
      const mediaReference = await artifactReference('rendered-media');
      const renderManifestReference = await artifactReference('render-manifest');
      const renderTelemetryReference = await artifactReference('render-telemetry');
      const inspectReportPath = path.join(runtime.runDirectory, 'inspect', 'inspect-report.json');
      const layoutTelemetryPath = path.join(runtime.runDirectory, 'inspect', 'layout-telemetry.json');
      const {request, response} = await runAdapter({
        expectedHashes: {
          media: mediaReference.sha256,
          renderManifest: renderManifestReference.sha256,
          renderTelemetry: renderTelemetryReference.sha256,
        },
        inputs: {
          media: mediaReference.path,
          mediaHash: mediaReference.sha256,
          renderManifest: renderManifestReference.path,
          renderTelemetry: renderTelemetryReference.path,
        },
        operation: 'inspect',
        outputs: {inspectReport: inspectReportPath, layoutTelemetry: layoutTelemetryPath},
        signal,
      });
      const references = await validateAdapterArtifacts(response, {
        'inspect-report': {path: inspectReportPath, schemaId: 'editorial://schema/inspect-report/v1'},
        'layout-telemetry': {
          path: layoutTelemetryPath,
          schemaId: 'editorial://schema/layout-telemetry/v1',
        },
      });
      const inspectReport = await readStrictJson(inspectReportPath);
      const layoutTelemetry = await readStrictJson(layoutTelemetryPath);
      runtime.validator.validate('inspectReport', inspectReport);
      runtime.validator.validate('layoutTelemetry', layoutTelemetry);
      const renderManifest = await readStrictJson(renderManifestReference.path);
      if (
        inspectReport.operationId !== request.operationId ||
        inspectReport.media.path !== mediaReference.path ||
        inspectReport.media.sha256 !== mediaReference.sha256 ||
        inspectReport.renderManifestHash !== renderManifestReference.sha256 ||
        inspectReport.layoutTelemetry.path !== layoutTelemetryPath ||
        inspectReport.layoutTelemetry.sha256 !== references['layout-telemetry'].sha256 ||
        inspectReport.frameCount !== renderManifest.media.frameCount ||
        layoutTelemetry.operationId !== request.operationId ||
        layoutTelemetry.frameCount !== renderManifest.media.frameCount ||
        !samePayload(layoutTelemetry.target, runtime.manifest.target.profile)
      ) {
        throw codedError('INSPECTION_IDENTITY_MISMATCH', 'Inspection artifacts do not match the render', {
          exitCode: 7,
          stage: 'INSPECTED',
        });
      }
      return {
        artifacts: [
          stageArtifact('inspect-report', references['inspect-report']),
          stageArtifact('layout-telemetry', references['layout-telemetry']),
        ],
        outputHashes: {INSPECTED: references['layout-telemetry'].sha256},
      };
    },
    QA_PASSED: async () => {
      const recipeReference = await artifactReference('recipe-payload');
      const mediaReference = await artifactReference('rendered-media');
      const renderManifestReference = await artifactReference('render-manifest');
      const inspectReportReference = await artifactReference('inspect-report');
      const layoutTelemetryReference = await artifactReference('layout-telemetry');
      const recipe = await readStrictJson(recipeReference.path);
      const inspectReport = await readStrictJson(inspectReportReference.path);
      const layoutTelemetry = await readStrictJson(layoutTelemetryReference.path);
      let telemetry;
      let telemetryError = null;
      try {
        telemetry = normalizeLayoutTelemetryForQa({
          target: runtime.manifest.target.profile,
          telemetry: layoutTelemetry,
        });
      } catch (error) {
        telemetryError = error;
        telemetry = {frames: []};
      }
      const video = inspectReport.streams.find(({kind}) => kind === 'video');
      const audio = inspectReport.streams.find(({kind}) => kind === 'audio');
      const qa = evaluateDeterministicQa({
        mediaFacts: {
          audioSampleRate: audio?.sampleRate,
          decodable: inspectReport.decodeStatus === 'decoded',
          durationSeconds: video?.durationSeconds,
          fps: runtime.manifest.target.profile.fps,
          frameCount: inspectReport.frameCount,
          hasAudio: Boolean(audio),
          height: video?.height,
          unintendedBlackRuns: [],
          width: video?.width,
        },
        policy: {
          audioMode: runtime.manifest.target.outputPolicy.audioMode,
          safeAreaInset: Math.max(...Object.values(runtime.manifest.target.outputPolicy.safeArea)),
        },
        recipe,
        target: runtime.manifest.target.profile,
        telemetry,
      });
      if (telemetryError) {
        qa.checks.unshift({
          expected: 'complete contiguous RLE coverage for every declared layer interval',
          id: 'telemetry-structure',
          observed: `${telemetryError.code}: ${telemetryError.message}`,
          remediation: 'Regenerate formal layout telemetry with complete, non-overlapping half-open runs',
          severity: 'blocking',
          status: 'failed',
        });
        qa.status = 'failed';
      }
      const checks = qa.checks.map((check) => {
        const telemetryEvidence = ['telemetry-coverage', 'safe-area'].includes(check.id);
        const evidenceArtifact = telemetryEvidence ? layoutTelemetryReference : inspectReportReference;
        return {
          checkId: check.id,
          evidenceArtifact,
          expected: printable(check.expected ?? check.observed),
          observed: printable(check.observed),
          remediation: check.remediation ?? 'No remediation is required.',
          severity: check.severity === 'blocking' ? 'blocking' : 'non_blocking',
          status: check.status === 'passed' ? 'pass' : 'fail',
        };
      });
      const report = {
        aestheticReview: null,
        aestheticStatus: 'not_run',
        checks,
        createdAt: new Date().toISOString(),
        deterministicStatus: qa.status === 'passed' ? 'pass' : 'fail',
        layoutTelemetryHash: layoutTelemetryReference.sha256,
        mediaHash: mediaReference.sha256,
        recipeHash: hashPayload(recipe),
        renderManifestHash: renderManifestReference.sha256,
        schemaVersion: 'editorial://schema/qa-report/v1',
      };
      const reportReference = await rawArtifact({
        artifactType: 'qa-report',
        payload: report,
        relativePath: 'qa/qa-report.json',
        schemaName: 'qaReport',
        store: runtime.store,
        validator: runtime.validator,
      });
      if (qa.status !== 'passed') {
        throw codedError('DETERMINISTIC_QA_FAILED', 'Rendered media failed deterministic QA', {
          artifacts: [stageArtifact('qa-report', reportReference)],
          exitCode: 6,
          outputHashes: {QA_PASSED: reportReference.sha256},
          stage: 'QA_PASSED',
        });
      }
      return {
        artifacts: [
          stageArtifact('qa-report', reportReference),
          stageArtifact('final-media', {
            ...mediaReference,
            artifactType: 'final-media',
          }),
        ],
        outputHashes: {QA_PASSED: reportReference.sha256},
      };
    },
  };
};

export const runDirectorOperation = async ({
  force = false,
  from,
  manifestPath,
  operation,
  outputRoot,
  resume,
  signal,
}) => {
  if (!productionOperations.has(operation)) {
    return {
      artifacts: {}, error: {code: 'UNKNOWN_OPERATION', message: `Unknown operation: ${operation}`},
      exitCode: 2, operation, status: 'invalid_input', terminalStage: null, warnings: [],
    };
  }
  const resolvedManifestPath = path.resolve(manifestPath);
  const rawManifest = await readStrictJson(resolvedManifestPath);
  const {manifest} = await resolveDirectorManifest({
    cli: {outputRoot},
    manifest: rawManifest,
    manifestPath: resolvedManifestPath,
  });
  const validator = await createContractValidator({contractsDirectory});
  try {
    validator.validate('inputManifest', manifest);
  } catch (error) {
    error.exitCode ??= 4;
    throw error;
  }
  if (manifest.operation !== operation) {
    throw codedError('OPERATION_MANIFEST_MISMATCH', 'CLI operation does not match manifest.operation', {exitCode: 2});
  }
  const manifestDirectory = path.dirname(resolvedManifestPath);
  const resolvedOutputRoot = path.resolve(manifestDirectory, manifest.outputRoot);
  const inputIdentity = await collectInputIdentity({manifest, manifestPath: resolvedManifestPath});
  const implementationLockHash = await implementationIdentity();
  let runId = resume;
  let supersedesRunId = null;
  let resumeExisting = Boolean(resume && !force);
  if (resumeExisting) {
    const predecessor = await readStrictJson(path.join(resolvedOutputRoot, resume, 'run.json'));
    validator.validate('run', predecessor);
    if (predecessor.operation !== operation) {
      throw codedError('RUN_OPERATION_MISMATCH', 'Resume operation does not match the existing run', {exitCode: 3});
    }
    const versions = predecessor.implementationVersions;
    if (
      versions.inputLockHash !== inputIdentity.hash ||
      versions.implementationLockHash !== implementationLockHash
    ) {
      supersedesRunId = resume;
      runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      resumeExisting = false;
    }
  }
  if (!runId || force) {
    supersedesRunId = force ? resume ?? null : null;
    runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    resumeExisting = false;
  }
  const runDirectory = path.join(resolvedOutputRoot, runId);
  const runPath = path.join(runDirectory, 'run.json');
  const store = await RunStore.open(runDirectory, {command: `${operation}${resumeExisting ? ' --resume' : ''}`, runId});
  let base;
  try {
    if (resumeExisting) {
      base = await store.readRun();
      validator.validate('run', base);
      if (base.operation !== operation) {
        throw codedError('RUN_OPERATION_MISMATCH', 'Resume operation does not match the existing run', {exitCode: 3});
      }
    } else {
      const now = new Date().toISOString();
      base = {
        artifacts: {},
        createdAt: now,
        currentStage: 'CREATED',
        failure: null,
        implementationVersions: {
          director: producer.version,
          implementationLockHash,
          inputLockHash: inputIdentity.hash,
        },
        operation,
        runId,
        schemaVersion: 'editorial://schema/run/v1',
        stageAttempts: [],
        status: 'created',
        supersedesRunId,
        updatedAt: now,
      };
      validator.validate('run', base);
      await store.initialize({operation});
      await store.commitRun(base);
    }
    const internal = internalRunFromIndex(base);
    const runtime = {
      authoringMode: manifest.modelPolicy?.authoringMode ?? 'deterministic',
      currentArtifacts: () => artifactMapFromState(runtime.state),
      agentRequestHash: () => runtime.state.outputHashes?.AUTHORING_INPUT_READY ??
        base.implementationVersions.agentRequestHash,
      inputIdentity,
      manifest,
      manifestDirectory,
      operation,
      reviewMode: manifest.modelPolicy?.reviewMode ?? 'deterministic',
      runDirectory,
      runId,
      state: internal,
      store,
      validator,
    };
    const engine = new DirectorEngine({
      operations: OPERATION_STEPS,
      stages: createWorkflowStages(buildExecutors(runtime)),
    });
    const state = await engine.execute({
      commit: async (nextState) => {
        runtime.state = structuredClone(nextState);
        const run = runIndexFromState({
          base,
          implementationLockHash,
          inputLockHash: inputIdentity.hash,
          state: nextState,
        });
        validator.validate('run', run);
        await store.commitRun(run);
        base = run;
      },
      context: {runDirectory},
      from,
      implementationLockHash,
      inputLockHash: inputIdentity.hash,
      operation,
      resume: resumeExisting,
      run: internal,
      signal,
    });
    const finalRun = runIndexFromState({base, implementationLockHash, inputLockHash: inputIdentity.hash, state});
    validator.validate('run', finalRun);
    await store.commitRun(finalRun);
    return resultFromRun(finalRun, runPath);
  } catch (error) {
    const exitCode = error.exitCode ?? (error.code === 'RUN_REVISION_REQUIRED' ? 3 : 5);
    let run = base;
    try {
      run = await store.readRun();
      if (Array.isArray(error.artifacts) && error.artifacts.length > 0) {
        run = {
          ...run,
          artifacts: {
            ...run.artifacts,
            ...Object.fromEntries(error.artifacts.map(({key, ...reference}) => [key, reference])),
          },
          updatedAt: new Date().toISOString(),
        };
        validator.validate('run', run);
        await store.commitRun(run);
      }
    } catch {
      // The failure may happen before the initial run index exists.
    }
    return {
      artifacts: run?.artifacts ?? {},
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: error.message,
        ...(error.diagnostics ? {details: error.diagnostics} : {}),
      },
      exitCode,
      operation,
      runId,
      runPath,
      status: exitCode === 130 ? 'cancelled' : exitCode === 3 ? 'conflict' : 'failed',
      terminalStage: run?.currentStage ?? 'CREATED',
      warnings: [],
    };
  } finally {
    await store.close();
  }
};

export const supplyAgentResponse = async ({inputPath, outputRoot, runId, stage}) => {
  const normalizedStage = String(stage).toUpperCase();
  if (!['AUTHORING', 'REVIEW'].includes(normalizedStage)) {
    throw codedError('AGENT_STAGE_INVALID', `Invalid agent stage: ${stage}`, {exitCode: 2});
  }
  const resolvedOutputRoot = outputRoot ?? (await resolveDirectorProjectOptions()).outputRoot;
  const runDirectory = path.resolve(resolvedOutputRoot, runId);
  const store = await RunStore.open(runDirectory, {command: 'supply-agent-response', runId});
  try {
    const validator = await createContractValidator({contractsDirectory});
    const run = await store.readRun();
    validator.validate('run', run);
    if (run.status !== 'awaiting_agent' || run.currentStage !== `${normalizedStage}_AWAITING_AGENT`) {
      throw codedError('RUN_NOT_AWAITING_AGENT', `Run is not awaiting ${normalizedStage}`, {exitCode: 3});
    }
    const attempt = await latestAgentAttempt(runDirectory, normalizedStage);
    const accepted = await acceptAgentResponse({
      attempt,
      currentInputLockHash: run.implementationVersions.inputLockHash,
      inputPath: path.resolve(inputPath),
    });
    const responseReference = {
      artifactType: 'agent-response',
      path: accepted.responsePath,
      schemaId: 'editorial://schema/agent-response/v1',
      sha256: accepted.rawResponseHash,
    };
    const updated = {
      ...run,
      artifacts: {...run.artifacts, [`agent-${stage}-response`]: responseReference},
      implementationVersions: {
        ...run.implementationVersions,
        agentResponseHash: accepted.rawResponseHash,
      },
      updatedAt: new Date().toISOString(),
    };
    validator.validate('run', updated);
    await store.commitRun(updated);
    return {...resultFromRun(updated, path.join(runDirectory, 'run.json'), 0), status: 'accepted'};
  } finally {
    await store.close();
  }
};

const parseArguments = (arguments_) => {
  const [command, ...rest] = arguments_;
  const options = {command};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (['--json', '--force', '--render-smoke', '--apply'].includes(flag)) options[flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = true;
    else if (flag.startsWith('--preserve-locks=')) {
      const value = flag.slice('--preserve-locks='.length);
      if (!['true', 'false'].includes(value)) {
        throw codedError('CLI_ARGUMENT_INVALID', '--preserve-locks must be true or false', {exitCode: 2});
      }
      options.preserveLocks = value === 'true';
    } else if ([
      '--manifest', '--resume', '--from', '--output-root', '--run', '--stage', '--input',
      '--adapter-config', '--to', '--older-than', '--skill-root', '--output-directory',
      '--identity-map', '--asset-inventory', '--semantic-outline',
    ].includes(flag)) {
      const value = rest[++index];
      if (!value) throw codedError('CLI_ARGUMENT_MISSING', `${flag} requires a value`, {exitCode: 2});
      options[flag.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
    } else {
      throw codedError('CLI_ARGUMENT_UNKNOWN', `Unknown argument: ${flag}`, {exitCode: 2});
    }
  }
  return options;
};

const printHuman = (result) => {
  process.stdout.write(`${result.operation}: ${result.status} (${result.terminalStage ?? 'none'})\n`);
  if (result.error) process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
};

const main = async () => {
  let options;
  let result;
  try {
    options = parseArguments(process.argv.slice(2));
    if (productionOperations.has(options.command)) {
      if (!options.manifest) throw codedError('CLI_ARGUMENT_MISSING', '--manifest is required', {exitCode: 2});
      result = await runDirectorOperation({
        force: options.force,
        from: options.from,
        manifestPath: options.manifest,
        operation: options.command,
        outputRoot: options.outputRoot,
        resume: options.resume,
      });
    } else if (options.command === 'supply-agent-response') {
      if (!options.run || !options.stage || !options.input) {
        throw codedError(
          'CLI_ARGUMENT_MISSING',
          'supply-agent-response requires --run, --stage, and --input',
          {exitCode: 2},
        );
      }
      result = await supplyAgentResponse({
        inputPath: options.input,
        outputRoot: options.outputRoot,
        runId: options.run,
        stage: options.stage,
      });
    } else if (options.command === 'doctor') {
      const project = await resolveDirectorProjectOptions({
        cli: options.adapterConfig ? {adapterConfig: options.adapterConfig} : {},
      });
      const report = await runDoctor({
        adapterConfigPath: project.options.adapterConfig,
        renderSmoke: options.renderSmoke,
        skillRoot: options.skillRoot ?? skillRoot,
      });
      result = {
        ...report,
        artifacts: {},
        error: report.productionBlocked ? {
          code: 'DOCTOR_FAILED',
          message: 'One or more blocking prerequisites failed',
        } : null,
        exitCode: report.productionBlocked ? 3 : 0,
        operation: 'doctor',
        terminalStage: null,
        warnings: [],
      };
    } else if (options.command === 'migrate') {
      if (!options.input || !options.to) {
        throw codedError('CLI_ARGUMENT_MISSING', 'migrate requires --input and --to', {exitCode: 2});
      }
      result = await migrateRecipe({
        assetInventoryPath: options.assetInventory,
        contractsDirectory,
        identityMapPath: options.identityMap,
        inputPath: options.input,
        outputDirectory: options.outputDirectory,
        semanticOutlinePath: options.semanticOutline,
        to: options.to,
      });
    } else if (options.command === 'cleanup') {
      if (!options.outputRoot || !options.olderThan) {
        throw codedError('CLI_ARGUMENT_MISSING', 'cleanup requires --output-root and --older-than', {exitCode: 2});
      }
      result = await cleanupRuns({
        apply: options.apply,
        olderThan: options.olderThan,
        outputRoot: options.outputRoot,
        preserveLocks: options.preserveLocks ?? true,
      });
    } else {
      throw codedError('CLI_COMMAND_UNKNOWN', `Unknown command: ${options.command ?? ''}`, {exitCode: 2});
    }
  } catch (error) {
    result = {
      artifacts: {},
      error: {code: error.code ?? 'INTERNAL_ERROR', message: error.message},
      exitCode: error.exitCode ?? 5,
      operation: options?.command ?? null,
      status: 'failed',
      terminalStage: null,
      warnings: [],
    };
  }
  if (options?.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else printHuman(result);
  process.exitCode = result.exitCode;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export {OPERATION_STEPS, STAGE_DEFINITIONS};
