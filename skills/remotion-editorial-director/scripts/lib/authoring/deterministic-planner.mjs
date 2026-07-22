const conservativeCameras = new Set(['hold']);
const conservativeTransitions = new Set(['hard_cut']);
const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});

const needsReview = (message, details = {}) => {
  throw codedError('DETERMINISTIC_PLAN_NEEDS_REVIEW', message, {
    details,
    status: 'needs_review',
  });
};

const traceFor = ({unit, rule, assetId, rationale, fallback}) => ({
  assetIds: [assetId],
  evidenceClaimIds: unit.evidenceClaimIds ?? [],
  fallback,
  grammarRuleIds: [rule.grammarRuleId],
  rationale,
  semanticUnitIds: [unit.semanticUnitId],
});

export const buildDeterministicAuthoringResult = ({semanticOutline, assetInventory, grammar}) => {
  const assets = new Set(assetInventory.assets.map(({assetId}) => assetId));
  const rules = new Map(grammar.rules.map((rule) => [rule.grammarRuleId, rule]));
  const shots = [];
  const traceByNodeId = {};
  let cursor = 0;

  for (const [index, unit] of semanticOutline.semanticUnits.entries()) {
    if (unit.startFrame !== cursor || !Number.isSafeInteger(unit.endFrame) || unit.endFrame <= unit.startFrame) {
      needsReview('Semantic units must form an exact positive timeline', {semanticUnitId: unit.semanticUnitId});
    }
    const ruleId = unit.grammarRuleIds?.[0];
    const rule = rules.get(ruleId);
    if (!rule) needsReview('Semantic unit has no resolved grammar rule', {semanticUnitId: unit.semanticUnitId});
    if (!assets.has(unit.assetId)) {
      needsReview('Semantic unit has no resolved staged asset', {semanticUnitId: unit.semanticUnitId});
    }
    const camera = rule.defaults?.camera;
    if (!conservativeCameras.has(camera) || !rule.allowedCameras?.includes(camera)) {
      needsReview('Grammar rule has no allowed conservative camera default', {grammarRuleId: ruleId});
    }
    const shotId = `shot:${unit.semanticUnitId}`;
    const shot = {
      background: {assetId: unit.assetId},
      camera: {preset: camera},
      durationInFrames: unit.endFrame - unit.startFrame,
      id: shotId,
      semanticRole: unit.narrativeRole,
    };
    const baseTrace = {
      assetId: unit.assetId,
      fallback: camera,
      rationale: `Use the declared conservative default for semantic unit ${unit.semanticUnitId}.`,
      rule,
      unit,
    };
    traceByNodeId[`shot:${shotId}:timing`] = traceFor(baseTrace);
    traceByNodeId[`shot:${shotId}:background`] = traceFor(baseTrace);
    traceByNodeId[`shot:${shotId}:camera`] = traceFor(baseTrace);

    if (index < semanticOutline.semanticUnits.length - 1) {
      const transition = rule.defaults?.transition;
      if (!conservativeTransitions.has(transition) || !rule.allowedTransitions?.includes(transition)) {
        needsReview('Grammar rule has no allowed conservative transition default', {grammarRuleId: ruleId});
      }
      shot.transitionOut = {class: transition};
      traceByNodeId[`shot:${shotId}:transitionOut`] = traceFor({...baseTrace, fallback: transition});
    }
    shots.push(shot);
    cursor = unit.endFrame;
  }
  if (cursor !== semanticOutline.durationInFrames || shots.length === 0) {
    needsReview('Semantic timeline does not conserve the declared duration');
  }
  return {
    recipeCandidate: {
      durationInFrames: semanticOutline.durationInFrames,
      fps: semanticOutline.fps,
      schemaVersion: 'magnates-remotion-recipe-v2',
      shots,
    },
    schemaVersion: 'editorial://schema/authoring-result/v1',
    traceByNodeId,
  };
};

const collectRequiredNodes = (recipe) => {
  const required = new Set();
  const identities = new Set();
  for (const shot of recipe.shots) {
    if (identities.has(shot.id)) throw codedError('AUTHORING_ID_DUPLICATE', `Duplicate node ID ${shot.id}`);
    identities.add(shot.id);
    required.add(`shot:${shot.id}:timing`);
    required.add(`shot:${shot.id}:background`);
    if (shot.camera) required.add(`shot:${shot.id}:camera`);
    if (shot.transitionIn) required.add(`shot:${shot.id}:transitionIn`);
    if (shot.transitionOut) required.add(`shot:${shot.id}:transitionOut`);
    for (const cue of [...(shot.texts ?? []), ...(shot.graphics ?? [])]) {
      if (identities.has(cue.id)) throw codedError('AUTHORING_ID_DUPLICATE', `Duplicate node ID ${cue.id}`);
      identities.add(cue.id);
      required.add(cue.id);
    }
  }
  return required;
};

export const validateAuthoringTrace = ({
  authoringResult,
  semanticOutline,
  assetInventory,
  grammar,
}) => {
  const recipe = authoringResult.recipeCandidate;
  const required = collectRequiredNodes(recipe);
  const traces = authoringResult.traceByNodeId;
  const missingNodeIds = [...required].filter((nodeId) => !Object.hasOwn(traces, nodeId)).sort();
  const unknownNodeIds = Object.keys(traces).filter((nodeId) => !required.has(nodeId)).sort();
  if (missingNodeIds.length > 0 || unknownNodeIds.length > 0) {
    throw codedError('AUTHORING_TRACE_INCOMPLETE', 'Authoring trace coverage is not exact', {
      missingNodeIds,
      unknownNodeIds,
    });
  }
  const semanticIds = new Set(semanticOutline.semanticUnits.map(({semanticUnitId}) => semanticUnitId));
  const assetIds = new Set(assetInventory.assets.map(({assetId}) => assetId));
  const grammarIds = new Set(grammar.rules.map(({grammarRuleId}) => grammarRuleId));
  for (const [nodeId, trace] of Object.entries(traces)) {
    if (
      !Array.isArray(trace.semanticUnitIds) || trace.semanticUnitIds.length === 0 ||
      trace.semanticUnitIds.some((id) => !semanticIds.has(id)) ||
      !Array.isArray(trace.grammarRuleIds) || trace.grammarRuleIds.length === 0 ||
      trace.grammarRuleIds.some((id) => !grammarIds.has(id)) ||
      !Array.isArray(trace.assetIds) || trace.assetIds.some((id) => !assetIds.has(id)) ||
      typeof trace.rationale !== 'string' || trace.rationale.length === 0 ||
      typeof trace.fallback !== 'string' || trace.fallback.length === 0
    ) {
      throw codedError('AUTHORING_TRACE_INVALID', `Trace identity or rationale is invalid for ${nodeId}`);
    }
  }
  let totalDuration = 0;
  for (const shot of recipe.shots) {
    if (!assetIds.has(shot.background.assetId)) {
      throw codedError('AUTHORING_ASSET_UNRESOLVED', `Unknown background asset ${shot.background.assetId}`);
    }
    totalDuration += shot.durationInFrames;
    for (const cue of [...(shot.texts ?? []), ...(shot.graphics ?? [])]) {
      if (cue.startFrame < 0 || cue.endFrame <= cue.startFrame || cue.endFrame > shot.durationInFrames) {
        throw codedError('AUTHORING_CUE_INTERVAL_INVALID', `Invalid half-open interval for ${cue.id}`);
      }
      if (cue.type === 'counter') {
        const trace = traces[cue.id];
        if (!cue.metricId || !cue.unit || !cue.period || !trace.sourceNote ||
          (trace.claimIds?.length ?? 0) + (trace.evidenceClaimIds?.length ?? 0) === 0) {
          throw codedError('AUTHORING_COUNTER_BINDING_INVALID', `Counter ${cue.id} is not evidence-bound`);
        }
      }
    }
  }
  if (totalDuration !== recipe.durationInFrames) {
    throw codedError('AUTHORING_DURATION_MISMATCH', 'Shot durations do not conserve recipe duration');
  }
  return {status: 'valid', tracedNodeCount: required.size};
};
