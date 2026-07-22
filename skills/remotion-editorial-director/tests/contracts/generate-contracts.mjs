import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const GENERATOR_VERSION = 1;
const root = fileURLToPath(new URL('../..', import.meta.url));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function asConst(name, value) {
  return `export const ${name} = ${JSON.stringify(value, null, 2)} as const;\n`;
}

function renderTypes({registry, recipe, request, capabilities, errors, digests, vectorDigest}) {
  const schemaIds = Object.fromEntries(registry.schemas.map((entry) => [entry.name, entry.id]));
  const operations = request.properties.operation.enum;
  const artifactTypes = readJson('contracts/artifact-envelope.schema.json').properties.artifactType.enum;
  const targetProfiles = capabilities.$defs.targetProfile.oneOf.map((profile) => ({
    profileId: profile.properties.profileId.const,
    width: profile.properties.width.const,
    height: profile.properties.height.const,
    fps: profile.properties.fps.const,
  }));
  const errorCodes = errors.errors.map((entry) => entry.code);
  const errorCategories = [...new Set(errors.errors.map((entry) => entry.category))];
  const exitByCategory = Object.fromEntries(
    errorCategories.map((category) => [
      category,
      errors.errors.find((entry) => entry.category === category).exitCode,
    ]),
  );

  let output = '// Generated from contracts/. Do not edit.\n';
  output += `// Generator version: ${GENERATOR_VERSION}\n\n`;
  output += asConst('SCHEMA_IDS', schemaIds);
  output += 'export type SchemaName = keyof typeof SCHEMA_IDS;\n';
  output += 'export type SchemaId = (typeof SCHEMA_IDS)[SchemaName];\n\n';
  output += asConst('SCHEMA_SHA256', digests);
  output += '\n';
  output += asConst('RECIPE_SCHEMA_VERSION', recipe.properties.schemaVersion.const);
  output += asConst('LEGACY_RECIPE_SCHEMA_VERSION', 'magnates-remotion-recipe-v1');
  output += '\n';
  output += asConst('ADAPTER_PROTOCOL_VERSION', 1);
  output += asConst('ADAPTER_OPERATIONS', operations);
  output += 'export type AdapterOperation = (typeof ADAPTER_OPERATIONS)[number];\n\n';
  output += asConst('ARTIFACT_TYPES', artifactTypes);
  output += 'export type ArtifactType = (typeof ARTIFACT_TYPES)[number];\n\n';
  output += asConst('TARGET_PROFILES', targetProfiles);
  output += 'export type TargetProfile = (typeof TARGET_PROFILES)[number];\n';
  output += 'export type TargetProfileId = TargetProfile["profileId"];\n\n';
  output += asConst('TRANSITION_CLASSES', recipe.$defs.transitionClass.enum);
  output += 'export type TransitionClass = (typeof TRANSITION_CLASSES)[number];\n';
  output += asConst('CAMERA_PRESETS', recipe.$defs.camera.properties.preset.enum);
  output += 'export type CameraPreset = (typeof CAMERA_PRESETS)[number];\n';
  output += asConst('TEXT_CUE_TYPES', recipe.$defs.textCue.properties.type.enum);
  output += 'export type TextCueType = (typeof TEXT_CUE_TYPES)[number];\n';
  output += asConst('GRAPHIC_KINDS', recipe.$defs.graphicCue.properties.kind.enum);
  output += 'export type GraphicKind = (typeof GRAPHIC_KINDS)[number];\n\n';
  output += asConst('ERROR_CODES', errorCodes);
  output += 'export type EditorialErrorCode = (typeof ERROR_CODES)[number];\n';
  output += asConst('ERROR_CATEGORIES', errorCategories);
  output += 'export type EditorialErrorCategory = (typeof ERROR_CATEGORIES)[number];\n';
  output += asConst('ERROR_REGISTRY', errors.errors);
  output += asConst('EXIT_CODE_BY_CATEGORY', exitByCategory);
  output += '\n';
  output += asConst('RFC8785_VECTOR_SET_SHA256', vectorDigest);
  output += '\n';
  output += `export interface ArtifactProducer {\n`;
  output += `  readonly name: string;\n`;
  output += `  readonly version: string;\n`;
  output += `}\n\n`;
  output += `export interface ArtifactEnvelope<TPayload, TType extends ArtifactType = ArtifactType> {\n`;
  output += `  readonly schemaVersion: typeof SCHEMA_IDS.artifactEnvelope;\n`;
  output += `  readonly runId: string;\n`;
  output += `  readonly artifactType: TType;\n`;
  output += `  readonly createdAt: string;\n`;
  output += `  readonly producer: ArtifactProducer;\n`;
  output += `  readonly inputHashes: Readonly<Record<string, string>>;\n`;
  output += `  readonly payload: TPayload;\n`;
  output += `  readonly contentHash: string;\n`;
  output += `}\n\n`;
  output += `export interface RecipeAssetV2 {\n`;
  output += `  readonly assetId: string;\n`;
  output += `  readonly fit?: "cover" | "contain";\n`;
  output += `  readonly position?: "center" | "top" | "bottom" | "left" | "right" | "top_left" | "top_right" | "bottom_left" | "bottom_right";\n`;
  output += `  readonly filter?: "none" | "monochrome" | "warm" | "cool" | "high_contrast" | "soft_blur";\n`;
  output += `}\n\n`;
  output += `export interface RecipeTransitionV2 {\n`;
  output += `  readonly class: TransitionClass;\n`;
  output += `  readonly frames?: number;\n`;
  output += `  readonly accent?: string;\n`;
  output += `}\n\n`;
  output += `export interface RecipeFocusV2 {\n`;
  output += `  readonly x: number;\n`;
  output += `  readonly y: number;\n`;
  output += `}\n\n`;
  output += `export interface RecipeCameraV2 {\n`;
  output += `  readonly preset: CameraPreset;\n`;
  output += `  readonly intensity?: number;\n`;
  output += `  readonly focus?: RecipeFocusV2;\n`;
  output += `  readonly startScale?: number;\n`;
  output += `  readonly endScale?: number;\n`;
  output += `}\n\n`;
  output += `export interface RecipeTextCueV2 {\n`;
  output += `  readonly id: string;\n`;
  output += `  readonly type: TextCueType;\n`;
  output += `  readonly subject: string;\n`;
  output += `  readonly subjectId: string;\n`;
  output += `  readonly startFrame: number;\n`;
  output += `  readonly endFrame: number;\n`;
  output += `  readonly text?: string;\n`;
  output += `  readonly entry?: "none" | "fade" | "slide_up" | "slide_left" | "wipe" | "type_on" | "counter";\n`;
  output += `  readonly exit?: "none" | "fade" | "slide_down";\n`;
  output += `  readonly x?: number;\n`;
  output += `  readonly y?: number;\n`;
  output += `  readonly width?: number;\n`;
  output += `  readonly align?: "left" | "center" | "right";\n`;
  output += `  readonly fontSize?: number;\n`;
  output += `  readonly weight?: number;\n`;
  output += `  readonly color?: string;\n`;
  output += `  readonly accent?: string;\n`;
  output += `  readonly prefix?: string;\n`;
  output += `  readonly suffix?: string;\n`;
  output += `  readonly metricId?: string;\n`;
  output += `  readonly unit?: string;\n`;
  output += `  readonly period?: string;\n`;
  output += `  readonly from?: number;\n`;
  output += `  readonly to?: number;\n`;
  output += `  readonly decimals?: number;\n`;
  output += `  readonly label?: string;\n`;
  output += `}\n\n`;
  output += `export interface RecipeGraphicCueV2 {\n`;
  output += `  readonly id: string;\n`;
  output += `  readonly kind: GraphicKind;\n`;
  output += `  readonly subject: string;\n`;
  output += `  readonly subjectId: string;\n`;
  output += `  readonly startFrame: number;\n`;
  output += `  readonly endFrame: number;\n`;
  output += `  readonly x?: number;\n`;
  output += `  readonly y?: number;\n`;
  output += `  readonly width?: number;\n`;
  output += `  readonly height?: number;\n`;
  output += `  readonly color?: string;\n`;
  output += `  readonly secondaryColor?: string;\n`;
  output += `  readonly label?: string;\n`;
  output += `}\n\n`;
  output += `export interface RecipeShotV2 {\n`;
  output += `  readonly id: string;\n`;
  output += `  readonly durationInFrames: number;\n`;
  output += `  readonly background: RecipeAssetV2;\n`;
  output += `  readonly semanticRole: "hook" | "establishing" | "mechanism" | "comparison" | "reversal" | "crisis" | "resolution";\n`;
  output += `  readonly camera?: RecipeCameraV2;\n`;
  output += `  readonly transitionIn?: RecipeTransitionV2;\n`;
  output += `  readonly transitionOut?: RecipeTransitionV2;\n`;
  output += `  readonly texts?: readonly RecipeTextCueV2[];\n`;
  output += `  readonly graphics?: readonly RecipeGraphicCueV2[];\n`;
  output += `  readonly tint?: string;\n`;
  output += `  readonly grain?: number;\n`;
  output += `  readonly sourceLabel?: string;\n`;
  output += `}\n\n`;
  output += `export interface MagnatesRemotionRecipeV2 {\n`;
  output += `  readonly schemaVersion: typeof RECIPE_SCHEMA_VERSION;\n`;
  output += `  readonly durationInFrames: number;\n`;
  output += `  readonly fps: number;\n`;
  output += `  readonly title?: string;\n`;
  output += `  readonly shots: readonly RecipeShotV2[];\n`;
  output += `}\n\n`;
  output += `export interface EditorialErrorShape {\n`;
  output += `  readonly code: EditorialErrorCode;\n`;
  output += `  readonly category: EditorialErrorCategory;\n`;
  output += `  readonly message: string;\n`;
  output += `  readonly retryable: boolean;\n`;
  output += `  readonly stage: string;\n`;
  output += `  readonly details?: Readonly<Record<string, string>>;\n`;
  output += `}\n`;
  return output;
}

function buildOutputs() {
  const registry = readJson('contracts/schema-registry.json');
  const recipe = readJson('contracts/magnates-remotion-recipe-v2.schema.json');
  const request = readJson('contracts/adapter-request.schema.json');
  const capabilities = readJson('contracts/adapter-capabilities.schema.json');
  const errors = readJson('contracts/error-codes.json');

  const digestEntries = registry.schemas
    .map((entry) => {
      const bytes = readFileSync(join(root, 'contracts', entry.file));
      return [entry.id, sha256(bytes)];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const digests = Object.fromEntries(digestEntries);
  const vectorDigest = sha256(readFileSync(join(root, 'fixtures/json/rfc8785-vectors.json')));
  const digestManifest = {
    generatorVersion: GENERATOR_VERSION,
    schemas: digests,
    fixtures: {rfc8785VectorSet: vectorDigest},
  };

  return {
    'contracts.ts': renderTypes({registry, recipe, request, capabilities, errors, digests, vectorDigest}),
    'schema-digests.json': `${JSON.stringify(digestManifest, null, 2)}\n`,
  };
}

function parseArgs(argv) {
  const result = {check: false, outDir: join(root, 'generated')};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') {
      result.check = true;
    } else if (argv[index] === '--out-dir') {
      index += 1;
      if (!argv[index]) throw new Error('--out-dir requires a path');
      result.outDir = resolve(argv[index]);
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return result;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputs = buildOutputs();
  const stale = [];

  for (const [file, content] of Object.entries(outputs)) {
    const target = join(options.outDir, file);
    if (options.check) {
      if (!existsSync(target) || readFileSync(target, 'utf8') !== content) stale.push(file);
      continue;
    }
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content);
  }

  if (stale.length > 0) {
    process.stderr.write(`generated contracts are stale: ${stale.join(', ')}\n`);
    process.exitCode = 1;
  }
}

main();
