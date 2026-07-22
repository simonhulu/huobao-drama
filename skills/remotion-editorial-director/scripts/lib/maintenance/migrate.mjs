import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {migrateRecipeV1ToV2} from '../authoring/migrate-v1.mjs';
import {parseStrictJson} from '../canonical-json.mjs';
import {createContractValidator} from '../contract-validator.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (candidate) => parseStrictJson(await readFile(candidate, 'utf8'));
const existsJson = async (candidate) => {
  try {
    return await readJson(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const bindingDiagnostics = ({identityMap, inventory, outline}) => {
  const diagnostics = [];
  const assetIds = new Set((inventory?.assets ?? []).map(({assetId}) => assetId));
  const entityIds = new Set((outline?.entities ?? []).map(({entityId}) => entityId));
  const metricIds = new Set((outline?.metrics ?? []).map(({metricId}) => metricId));
  for (const [source, assetId] of Object.entries(identityMap.assetsBySource ?? {})) {
    if (!assetIds.has(assetId)) diagnostics.push({code: 'MAPPING_TARGET_UNKNOWN', kind: 'assetId', pointer: `/assetsBySource/${source}`});
  }
  for (const [pointer, subjectId] of Object.entries(identityMap.subjectsByPointer ?? {})) {
    if (!entityIds.has(subjectId) && !metricIds.has(subjectId)) {
      diagnostics.push({code: 'MAPPING_TARGET_UNKNOWN', kind: 'subjectId', pointer: `/subjectsByPointer/${pointer}`});
    }
  }
  for (const [pointer, metric] of Object.entries(identityMap.metricsByPointer ?? {})) {
    if (!metricIds.has(metric?.metricId)) diagnostics.push({code: 'MAPPING_TARGET_UNKNOWN', kind: 'metricId', pointer: `/metricsByPointer/${pointer}`});
  }
  return diagnostics;
};

export const migrateRecipe = async ({
  assetInventoryPath,
  contractsDirectory,
  identityMapPath,
  inputPath,
  outputDirectory,
  semanticOutlinePath,
  to,
}) => {
  if (to !== 'magnates-remotion-recipe-v2') {
    throw Object.assign(new Error(`Unsupported migration target: ${to}`), {
      code: 'MIGRATION_TARGET_UNSUPPORTED',
      exitCode: 2,
    });
  }
  const absoluteInput = path.resolve(inputPath);
  const directory = path.dirname(absoluteInput);
  const sourceBytes = await readFile(absoluteInput);
  const recipe = parseStrictJson(sourceBytes.toString('utf8'));
  const validator = await createContractValidator({contractsDirectory});
  validator.validate('recipeV1', recipe);
  const identityPath = path.resolve(identityMapPath ?? path.join(directory, 'identity-map.json'));
  const inventoryPath = path.resolve(assetInventoryPath ?? path.join(directory, 'asset-inventory.json'));
  const outlinePath = path.resolve(semanticOutlinePath ?? path.join(directory, 'semantic-outline.json'));
  const [identityMap, inventory, outline] = await Promise.all([
    existsJson(identityPath),
    existsJson(inventoryPath),
    existsJson(outlinePath),
  ]);
  const missing = [
    [identityMap, 'identity-map'],
    [inventory, 'asset-inventory'],
    [outline, 'semantic-outline'],
  ].filter(([value]) => value === null).map(([, label]) => ({
    code: 'MAPPING_INPUT_REQUIRED',
    kind: label,
    pointer: '',
  }));
  if (missing.length > 0) {
    return {artifacts: {}, diagnostics: missing, error: null, exitCode: 0, operation: 'migrate', status: 'needs_mapping', terminalStage: null, warnings: []};
  }
  validator.validate('assetInventory', inventory);
  validator.validate('semanticOutline', outline);
  const invalidBindings = bindingDiagnostics({identityMap, inventory, outline});
  const migrated = migrateRecipeV1ToV2({identityMap, recipe, sourceHash: sha256(sourceBytes)});
  const diagnostics = [...invalidBindings, ...migrated.diagnostics];
  if (diagnostics.length > 0) {
    return {artifacts: {}, diagnostics, error: null, exitCode: 0, operation: 'migrate', status: 'needs_mapping', terminalStage: null, warnings: []};
  }
  validator.validate('recipeV2', migrated.recipeCandidate);
  const destination = path.resolve(outputDirectory ?? directory);
  await mkdir(destination, {recursive: true});
  const stem = path.basename(absoluteInput, path.extname(absoluteInput));
  const draftPath = path.join(destination, `${stem}.v2.draft.json`);
  const reportPath = path.join(destination, `${stem}.migration-report.json`);
  await writeFile(draftPath, `${JSON.stringify(migrated.recipeCandidate, null, 2)}\n`, {flag: 'wx'});
  await writeFile(reportPath, `${JSON.stringify(migrated.report, null, 2)}\n`, {flag: 'wx'});
  return {
    artifacts: {
      migrationReport: {artifactType: 'migration-report', path: reportPath, schemaId: 'editorial://schema/migration-report/v1', sha256: sha256(await readFile(reportPath))},
      recipeDraft: {artifactType: 'recipe-v2', path: draftPath, schemaId: 'editorial://schema/magnates-remotion-recipe-v2', sha256: sha256(await readFile(draftPath))},
    },
    diagnostics: [],
    error: null,
    exitCode: 0,
    operation: 'migrate',
    status: 'ok',
    terminalStage: null,
    warnings: ['Migration output is an unlocked draft and must pass normal validation and approval.'],
  };
};
