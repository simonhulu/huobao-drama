import { z } from 'zod'
import { REMOTION_SHOT_RHYTHM } from './remotion-segmentation.js'
import { validateStoryContract } from './story-contract.js'
import { validateDirectorPlan } from './director-plan.js'

export const REMOTION_STAGE_SCHEMA_VERSION = 1

const schemaVersion = z.literal(REMOTION_STAGE_SCHEMA_VERSION)
const legacyStageEnvelope = z.object({ schemaVersion }).passthrough()
const factoryStageEnvelope = z.object({
  schemaVersion,
  factoryStage: z.string().min(1),
  attempt: z.number().int().positive().optional(),
  artifacts: z.array(z.unknown()),
  checks: z.array(z.unknown()),
  risks: z.array(z.unknown()),
  gate: z.object({
    decision: z.enum(['candidate', 'passed', 'rework', 'blocked']),
    reviewer: z.string().min(1),
  }).passthrough().optional(),
}).passthrough()
const shotType = z.enum(['ai_plate', 'character', 'map', 'stock', 'graphic', 'hybrid'])

// A temporal grid is a single story sheet, not a collection of runtime
// character cards. Keep the sheet contract explicit so a renderer can crop
// the two consecutive story states deterministically.
const temporalPanel = z.object({
  index: z.number().int().min(0).max(1),
  semantic: z.string().min(1),
  visualProof: z.string().min(1),
  storyBeatId: z.string().min(1).optional(),
}).passthrough()
const temporalKeyframe = z.object({
  atMs: z.number().int().nonnegative(),
  panel: z.number().int().min(0).max(1),
}).passthrough()
const temporalGrid = z.object({
  schemaVersion: z.literal(1),
  sheetAssetKey: z.string().min(1),
  rows: z.literal(1),
  columns: z.literal(2),
  panels: z.array(temporalPanel).length(2),
  keyframes: z.array(temporalKeyframe).min(2),
}).passthrough()
const visualPlan = z.object({
  schemaVersion: z.number().int().positive(),
  visualSetupId: z.string().min(1),
  assetStrategy: z.enum(['static-layered-remotion', 'temporal-2grid-remotion']),
  visualMode: z.string().min(1).optional(),
  layers: z.array(z.unknown()),
  temporalGrid: temporalGrid.optional(),
  motion: z.object({
    camera: z.string().min(1),
    parallax: z.string().min(1),
    subject: z.string().min(1),
    text: z.string().min(1),
    transition: z.string().min(1),
  }).passthrough(),
  motionChannels: z.array(z.string().min(1)).min(2),
  audioCues: z.array(z.unknown()).min(1),
}).passthrough()
const assetType = z.enum(['ai_image', 'character', 'map', 'stock_video', 'graphic', 'audio', 'font'])
const shotPlan = z.object({
  shotNumber: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  shotType,
  visualSetupId: z.string().min(1),
  beatIds: z.array(z.string().min(1)).min(1),
  visualPlan,
}).passthrough()
const assetPlan = z.object({
  assetKey: z.string().min(1),
  assetType,
}).passthrough()
const assetProduction = z.object({
  assetKey: z.string().min(1),
  status: z.enum(['planned', 'queued', 'processing', 'completed', 'failed', 'canceled']),
}).passthrough()
const renderSummary = z.object({
  shotId: z.number().int().positive(),
  status: z.string().min(1),
  outputPath: z.string().min(1).optional(),
  outputUrl: z.string().min(1).optional(),
}).passthrough()
const positioningSnapshot = z.object({
  schemaVersion: z.number().int().positive(),
  account: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    positioning: z.record(z.string(), z.unknown()),
  }),
  project: z.record(z.string(), z.unknown()),
  episode: z.record(z.string(), z.unknown()),
}).passthrough()

const nativeStages = new Set([
  'source_snapshot',
  'historical_analysis',
  'narrative_beats',
  'storyboard',
  'asset_plan',
  'asset_production',
  'asset_qc',
  'shot_composition',
  'shot_qc',
  'episode_finish',
  'final_qa',
])

const stageOutputSchemas: Record<string, z.ZodType> = {
  source_snapshot: factoryStageEnvelope.extend({
    sourceHash: z.string().min(1),
    sourceType: z.enum(['episode', 'script']),
    storyboardCount: z.number().int().nonnegative(),
    positioningSnapshot,
  }),
  historical_analysis: factoryStageEnvelope.extend({
    claims: z.array(z.unknown()),
    people: z.array(z.unknown()),
    locations: z.array(z.unknown()),
    routes: z.array(z.unknown()),
    beats: z.array(z.unknown()).optional(),
    informationBeats: z.array(z.unknown()).optional(),
  }),
  narrative_beats: factoryStageEnvelope.extend({
    durationMs: z.number().int().positive(),
    beats: z.array(z.object({
      id: z.string().min(1),
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
      narration: z.string().min(1),
    }).passthrough()).min(1),
  }),
  storyboard: factoryStageEnvelope.extend({
    storyFirst: z.boolean().optional(),
    directorPlan: z.record(z.string(), z.unknown()).optional(),
    shots: z.array(shotPlan),
  }),
  script_analysis: legacyStageEnvelope.extend({
    beats: z.array(z.unknown()).optional(),
    characters: z.array(z.unknown()).optional(),
    locations: z.array(z.unknown()).optional(),
    informationBeats: z.array(z.unknown()).optional(),
  }),
  shot_plan: legacyStageEnvelope.extend({
    shots: z.array(z.object({
      shotNumber: z.number().int().positive(),
      durationMs: z.number().int().positive(),
      shotType: z.enum(['ai_plate', 'character', 'map', 'stock', 'graphic', 'hybrid']),
      visualPlan: z.unknown(),
    }).passthrough()),
  }),
  asset_plan: factoryStageEnvelope.extend({
    assets: z.array(assetPlan),
  }),
  asset_production: factoryStageEnvelope.extend({
    assets: z.array(assetProduction),
  }),
  asset_qc: factoryStageEnvelope.extend({
    assets: z.array(z.object({
      assetKey: z.string().min(1),
      decision: z.enum(['approved', 'rework', 'rejected', 'fallback']),
    }).passthrough()),
  }),
  shot_composition: factoryStageEnvelope.extend({
    renders: z.array(renderSummary),
    staticGate: z.object({
      decision: z.literal('passed'),
      contactSheetPath: z.string().min(1),
      checks: z.array(z.string().min(1)).min(1),
    }).passthrough(),
  }),
  shot_qc: factoryStageEnvelope.extend({
    shots: z.array(z.object({
      shotId: z.number().int().positive(),
      decision: z.enum(['passed', 'rework', 'blocked']),
    }).passthrough()),
    renders: z.array(renderSummary),
  }),
  shot_render: legacyStageEnvelope.extend({
    renders: z.array(renderSummary),
  }),
  episode_finish: factoryStageEnvelope.extend({
    finalVideoUrl: z.string().min(1).optional(),
    outputPath: z.string().min(1).optional(),
    durationMs: z.number().int().positive(),
    renders: z.array(z.unknown()).optional(),
  }),
  episode_render: legacyStageEnvelope.extend({
    finalVideoUrl: z.string().min(1).optional(),
    outputPath: z.string().min(1).optional(),
    renders: z.array(z.unknown()).optional(),
  }),
  qa: legacyStageEnvelope.extend({
    passed: z.boolean(),
    checks: z.array(z.unknown()).default([]),
  }),
  final_qa: factoryStageEnvelope.extend({
    passed: z.boolean(),
    checks: z.array(z.unknown()).min(1),
    finalVideoUrl: z.string().min(1).optional(),
    outputPath: z.string().min(1).optional(),
  }),
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return Array.isArray(value) ? value.length > 0 : true
}

function nestedStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => nestedStrings(item, depth + 1))
  if (typeof value !== 'object') return []
  return Object.values(value as Record<string, unknown>)
    .flatMap((item) => nestedStrings(item, depth + 1))
}

function requireStrictStoryContract(
  shot: Record<string, unknown>,
  plan: Record<string, unknown>,
): void {
  try {
    validateStoryContract(plan.story, plan)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`shot ${String(shot.shotNumber)} story contract: ${message}`)
  }

  const story = objectRecord(plan.story)
  const actorIds = story.actorIds
  if (!Array.isArray(actorIds) || actorIds.length === 0 || actorIds.some((id) => !cleanString(id))) {
    throw new Error(`shot ${String(shot.shotNumber)} story contract requires actorIds`)
  }
  for (const field of ['action', 'target', 'beforeState', 'afterState']) {
    if (!cleanString(story[field])) {
      throw new Error(`shot ${String(shot.shotNumber)} story contract requires ${field}`)
    }
  }
  if (cleanString(story.beforeState) === cleanString(story.afterState)) {
    throw new Error(`shot ${String(shot.shotNumber)} story contract requires a beforeState/afterState change`)
  }
  const visualProof = story.visualProof
  if (!Array.isArray(visualProof) || visualProof.length === 0 || visualProof.some((proof) => !cleanString(proof))) {
    throw new Error(`shot ${String(shot.shotNumber)} story contract requires visualProof`)
  }
  // A final beat may explicitly terminate the chain with null.  Omitting the
  // field hides an incomplete storyboard edge and is therefore not allowed.
  if (!hasOwn(story, 'nextBeatId') || (story.nextBeatId !== null && !cleanString(story.nextBeatId))) {
    throw new Error(`shot ${String(shot.shotNumber)} story contract requires nextBeatId (string or null)`)
  }
}

function validateTemporalShot(
  shot: Record<string, unknown>,
  plan: Record<string, unknown>,
  seenSheetAssetKeys: Set<string>,
): void {
  if (plan.visualMode !== 'temporal-2grid') {
    throw new Error(`shot ${String(shot.shotNumber)} temporal visualMode must be temporal-2grid`)
  }
  if (plan.assetStrategy !== 'temporal-2grid-remotion') {
    throw new Error(`shot ${String(shot.shotNumber)} temporal assetStrategy must be temporal-2grid-remotion`)
  }

  const runtimeForbiddenKeys = ['layers', 'characters', 'cards', 'runtimeCards', 'runtimeLayers', 'foregroundLayers']
  for (const key of runtimeForbiddenKeys) {
    if (hasContent(plan[key])) {
      throw new Error(`shot ${String(shot.shotNumber)} temporal contract forbids runtime ${key}`)
    }
  }

  if (shot.shotType === 'ai_plate') {
    throw new Error(`shot ${String(shot.shotNumber)} temporal contract cannot use ai_plate`)
  }

  const renderContract = objectRecord(plan.renderContract)
  if (renderContract.renderer !== 'remotion-temporal-grid') {
    throw new Error(`shot ${String(shot.shotNumber)} temporal contract requires remotion-temporal-grid renderer`)
  }
  if (renderContract.forbidRuntimeCards !== true || renderContract.forbidRuntimeLayers !== true) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal contract must forbid runtime cards and layers`)
  }

  const visualText = nestedStrings({
    visualMode: plan.visualMode,
    renderContract,
    fallback: plan.fallback,
  }).join(' ')
  if (/(?:concept[-_ ]?only|conceptual[-_ ]?only|概念化)/iu.test(visualText)) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal contract cannot be concept-only`)
  }
  if (/(?:ai[_ -]?plate|ai clean plate|clean plate)/iu.test(nestedStrings(plan.fallback).join(' '))) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal contract cannot fall back to ai_plate`)
  }

  const channels = Array.isArray(plan.motionChannels) ? plan.motionChannels.map(cleanString) : []
  if (!channels.some((channel) => /temporal|sheet[-_ ]?crop|grid[-_ ]?crop/iu.test(channel))) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal contract requires a temporal sheet-crop motion channel`)
  }

  const grid = objectRecord(plan.temporalGrid)
  const sheetAssetKey = cleanString(grid.sheetAssetKey)
  if (!sheetAssetKey) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal grid requires sheetAssetKey`)
  }
  if (seenSheetAssetKeys.has(sheetAssetKey)) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal grid must use an independent sheetAssetKey`)
  }
  seenSheetAssetKeys.add(sheetAssetKey)

  const panels = Array.isArray(grid.panels) ? grid.panels.map(objectRecord) : []
  const panelIndexes = panels.map((panel) => Number(panel.index))
  if (panelIndexes.length !== 2 || [...new Set(panelIndexes)].sort((a, b) => a - b).join(',') !== '0,1') {
    throw new Error(`shot ${String(shot.shotNumber)} temporal grid panels must cover indexes 0,1 exactly once`)
  }
  const semantics = panels.map((panel) => cleanString(panel.semantic).toLocaleLowerCase())
  if (semantics.some((semantic) => !semantic) || new Set(semantics).size !== 2) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal grid panels need two distinct semantics`)
  }
  if (panels.some((panel) => !cleanString(panel.visualProof))) {
    throw new Error(`shot ${String(shot.shotNumber)} temporal grid panels require visualProof`)
  }

  const keyframes = Array.isArray(grid.keyframes) ? grid.keyframes.map(objectRecord) : []
  const durationMs = Number(shot.durationMs)
  let previousAtMs = -1
  const keyframePanels = new Set<number>()
  for (const keyframe of keyframes) {
    const atMs = Number(keyframe.atMs)
    const panel = Number(keyframe.panel)
    if (!Number.isInteger(atMs) || atMs <= previousAtMs) {
      throw new Error(`shot ${String(shot.shotNumber)} temporal grid keyframes must be strictly ordered by atMs`)
    }
    if (atMs > durationMs) {
      throw new Error(`shot ${String(shot.shotNumber)} temporal grid keyframe exceeds shot duration`)
    }
    keyframePanels.add(panel)
    previousAtMs = atMs
  }
  if (keyframePanels.size !== 2 || [...keyframePanels].sort((a, b) => a - b).join(',') !== '0,1') {
    throw new Error(`shot ${String(shot.shotNumber)} temporal grid keyframes must cover panels 0,1`)
  }
}

export function validateRemotionStageOutput(stage: string, output: unknown): void {
  if (output === undefined || output === null) return
  const schema = stageOutputSchemas[stage]
  if (!schema) throw new Error(`No output schema registered for Remotion stage: ${stage}`)
  const parsed = schema.safeParse(output)
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || 'output'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid output for Remotion stage ${stage}: ${details}`)
  }
  if (nativeStages.has(stage) && (parsed.data as { factoryStage?: unknown }).factoryStage !== stage) {
    throw new Error(`Invalid output for Remotion stage ${stage}: factoryStage must be ${stage}`)
  }
  if (stage === 'storyboard') {
    const storyboardOutput = parsed.data as { shots: Array<Record<string, unknown>>; storyFirst?: boolean; directorPlan?: Record<string, unknown> }
    const shots = storyboardOutput.shots
    const requiresDirectorPlan = storyboardOutput.storyFirst === true || shots.some((shot) => {
      const plan = shot.visualPlan && typeof shot.visualPlan === 'object' && !Array.isArray(shot.visualPlan)
        ? shot.visualPlan as Record<string, unknown>
        : {}
      return plan.visualMode === 'temporal-2grid'
        || plan.assetStrategy === 'temporal-2grid-remotion'
        || plan.temporalGrid !== undefined
    })
    if (requiresDirectorPlan) {
      if (!storyboardOutput.directorPlan) {
        throw new Error('Invalid output for Remotion stage storyboard: directorPlan is required for story-first/temporal output')
      }
      try {
        validateDirectorPlan(storyboardOutput.directorPlan)
      } catch (error) {
        throw new Error(`Invalid output for Remotion stage storyboard: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const seenSheetAssetKeys = new Set<string>()
    for (const shot of shots) {
      const plan = shot.visualPlan && typeof shot.visualPlan === 'object' && !Array.isArray(shot.visualPlan)
        ? shot.visualPlan as Record<string, unknown>
        : {}
      const isTemporal = plan.visualMode === 'temporal-2grid'
        || plan.assetStrategy === 'temporal-2grid-remotion'
        || plan.temporalGrid !== undefined
      if (isTemporal) {
        try {
          validateTemporalShot(shot, plan, seenSheetAssetKeys)
          requireStrictStoryContract(shot, plan)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Invalid output for Remotion stage storyboard: ${message}`)
        }
      } else if (storyboardOutput.storyFirst === true) {
        try {
          requireStrictStoryContract(shot, plan)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`Invalid output for Remotion stage storyboard: ${message}`)
        }
      }
    }
    for (const shot of shots) {
      const durationMs = Number(shot.durationMs)
      if (durationMs > REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs) {
        throw new Error(`Invalid output for Remotion stage storyboard: shot ${shot.shotNumber} exceeds hard duration limit`)
      }
      if (durationMs > REMOTION_SHOT_RHYTHM.maxShotDurationMs) {
        const plan = shot.visualPlan && typeof shot.visualPlan === 'object' && !Array.isArray(shot.visualPlan)
          ? shot.visualPlan as Record<string, unknown>
          : {}
        const justification = typeof shot.longShotJustification === 'string'
          ? shot.longShotJustification.trim()
          : typeof plan.longShotJustification === 'string'
            ? plan.longShotJustification.trim()
            : ''
        if (!justification) {
          throw new Error(`Invalid output for Remotion stage storyboard: shot ${shot.shotNumber} needs longShotJustification above the default duration limit`)
        }
      }
    }
  }
  if (stage === 'source_snapshot') {
    const snapshot = (parsed.data as { positioningSnapshot: { account: { positioning: Record<string, unknown> } } }).positioningSnapshot
    if (!Object.keys(snapshot.account.positioning).length) {
      throw new Error('Invalid output for Remotion stage source_snapshot: account positioning must not be empty')
    }
  }
  if (stage === 'asset_plan') {
    const assets = (parsed.data as { assets: Array<Record<string, unknown>> }).assets
    const temporalShotNumbers = new Set<number>()
    for (const asset of assets) {
      const production = asset.production && typeof asset.production === 'object' && !Array.isArray(asset.production)
        ? asset.production as Record<string, unknown>
        : {}
      const providerText = [asset.provider, production.provider, production.mode]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase()
      if (/(^|[^a-z])(i2v|seedance|video-generation|video_generation)([^a-z]|$)/.test(providerText)) {
        throw new Error(`Invalid output for Remotion stage asset_plan: asset ${String(asset.assetKey)} uses a video-generation provider`)
      }

      const metadata = objectRecord(asset.metadata)
      const temporalGrid = objectRecord(asset.temporalGrid)
      const isTemporal = hasContent(asset.temporalGrid)
        || metadata.role === 'temporal-2grid-sheet'
        || /temporal[-_]2grid/iu.test(String(asset.assetKey))
      if (!isTemporal) continue
      if (asset.assetType !== 'ai_image') {
        throw new Error(`Invalid output for Remotion stage asset_plan: temporal sheet ${String(asset.assetKey)} must be ai_image`)
      }
      if (metadata.role !== 'temporal-2grid-sheet') {
        throw new Error(`Invalid output for Remotion stage asset_plan: temporal sheet ${String(asset.assetKey)} requires metadata.role temporal-2grid-sheet`)
      }
      const shotNumber = Number(metadata.shotNumber ?? asset.shotNumber)
      if (!Number.isInteger(shotNumber) || shotNumber <= 0) {
        throw new Error(`Invalid output for Remotion stage asset_plan: temporal sheet ${String(asset.assetKey)} requires a positive metadata.shotNumber`)
      }
      if (temporalShotNumbers.has(shotNumber)) {
        throw new Error(`Invalid output for Remotion stage asset_plan: shot ${shotNumber} has more than one temporal sheet`)
      }
      temporalShotNumbers.add(shotNumber)
      const declaredSheetKey = cleanString(temporalGrid.sheetAssetKey)
      if (declaredSheetKey && declaredSheetKey !== String(asset.assetKey)) {
        throw new Error(`Invalid output for Remotion stage asset_plan: temporal sheetAssetKey must match assetKey for shot ${shotNumber}`)
      }
    }
  }
}

export function getRemotionStageOutputSchema(stage: string) {
  return stageOutputSchemas[stage] || null
}
