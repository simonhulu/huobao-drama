import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

import {parseStrictJson} from './canonical-json.mjs';

const CONFIG_NAME = '.remotion-editorial-director.json';
const CONFIG_KEYS = new Set([
  'adapterConfig',
  'modelPolicy',
  'outputRoot',
  'policy',
  'schemaVersion',
  'target',
]);

const exists = async (candidate) => {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

const mergeObjects = (base, override) => {
  const merged = {...base};
  for (const [key, value] of Object.entries(override ?? {})) {
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])
    ) {
      merged[key] = mergeObjects(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
};

export const defaultDirectorConfig = Object.freeze({
  modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
  outputRoot: '.remotion-editorial-runs',
  policy: {
    adapterTimeoutSeconds: 900,
    analysisTimeoutSeconds: 120,
  },
  schemaVersion: 1,
});

export const findNearestProjectConfig = async (startDirectory) => {
  let current = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(current, CONFIG_NAME);
    if (await exists(candidate)) return candidate;
    const gitMarker = path.join(current, '.git');
    if (await exists(gitMarker)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

export const readProjectConfig = async (configPath) => {
  if (!configPath) return {};
  const config = parseStrictJson(await readFile(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw Object.assign(new Error('Project config must be a JSON object'), {
      code: 'PROJECT_CONFIG_INVALID',
      exitCode: 2,
    });
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`Unknown project config fields: ${unknown.join(', ')}`), {
      code: 'PROJECT_CONFIG_INVALID',
      exitCode: 2,
    });
  }
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw Object.assign(new Error('Project config schemaVersion must be 1'), {
      code: 'PROJECT_CONFIG_INVALID',
      exitCode: 2,
    });
  }
  return config;
};

export const resolveDirectorManifest = async ({cli = {}, manifest, manifestPath}) => {
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const configPath = await findNearestProjectConfig(manifestDirectory);
  const project = await readProjectConfig(configPath);
  const projectDirectory = configPath ? path.dirname(configPath) : manifestDirectory;
  const normalizedProject = {
    ...project,
    ...(project.adapterConfig === undefined ? {} : {
      adapterConfig: path.resolve(projectDirectory, project.adapterConfig),
    }),
    ...(project.outputRoot === undefined ? {} : {
      outputRoot: path.resolve(projectDirectory, project.outputRoot),
    }),
  };
  const cliManifest = Object.fromEntries(
    Object.entries({adapterConfig: cli.adapterConfig, outputRoot: cli.outputRoot})
      .filter(([, value]) => value !== undefined),
  );
  const resolved = mergeObjects(
    mergeObjects(mergeObjects(defaultDirectorConfig, normalizedProject), manifest),
    cliManifest,
  );
  delete resolved.schemaVersion;
  return {configPath, manifest: resolved};
};

export const resolveDirectorProjectOptions = async ({cli = {}, startDirectory = process.cwd()} = {}) => {
  const configPath = await findNearestProjectConfig(startDirectory);
  const project = await readProjectConfig(configPath);
  const resolved = mergeObjects(mergeObjects(defaultDirectorConfig, project), cli);
  const baseDirectory = configPath ? path.dirname(configPath) : path.resolve(startDirectory);
  const outputRoot = path.resolve(baseDirectory, resolved.outputRoot);
  return {
    configPath,
    options: {
      ...resolved,
      ...(resolved.adapterConfig === undefined ? {} : {
        adapterConfig: path.resolve(baseDirectory, resolved.adapterConfig),
      }),
      outputRoot,
    },
    outputRoot,
  };
};
