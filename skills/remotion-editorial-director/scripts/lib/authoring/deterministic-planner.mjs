const supportedCameras = new Set([
  'hold', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down',
]);
const supportedTransitions = new Set([
  'hard_cut', 'dissolve', 'blur_bridge', 'matte_transition', 'graphic_transition', 'distortion',
  'iris_reveal', 'film_burn', 'directional_blur', 'zoom_blur', 'ink_bleed',
]);
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

const cueWindow = (unit) => {
  const duration = unit.endFrame - unit.startFrame;
  const startFrame = Math.min(Math.max(4, Math.round(duration * 0.12)), Math.max(0, duration - 1));
  const endFrame = Math.max(startFrame + 1, Math.min(duration, Math.round(duration * 0.88)));
  return {startFrame, endFrame};
};

const normalizedText = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

const salientPhrase = (text, role) => {
  const source = normalizedText(text);
  const clean = (value) => String(value ?? '')
    .replace(/[，。！？；：、“”‘’《》（）()\s]/gu, '')
    .slice(0, 10);
  const historicalBeats = [
    /猎场上把他射死/u,
    /甘泉宫打猎/u,
    /李敢死了/u,
    /鹿撞死/u,
    /另一种说法/u,
    /射死李敢/u,
    /遮了过去/u,
    /为什么要杀李敢/u,
    /打伤了?卫青/u,
    /和卫青有关/u,
    /父亲李广的死/u,
    /一时愤怒/u,
    /动了手/u,
    /没有声张/u,
    /压了下来/u,
    /要了李敢的命/u,
    /这件事很奇怪/u,
    /亲舅舅/u,
    /同时担任大司马/u,
    /选择杀人/u,
    /性格为什么/u,
    /卫青小时候/u,
    /私生子/u,
    /不把他当兄弟/u,
    /出去放羊/u,
    /准备把他杀掉/u,
    /损失七千骑/u,
    /反而越谨慎/u,
    /军队几乎全军覆没/u,
    /劝卫青杀掉苏建/u,
    /杀人的权力/u,
    /八百人[^，。！？；]{0,14}最亮眼/u,
    /士兵挨饿/u,
    /历来有争议/u,
    /体察\s*远远不\s*如卫青/u,
    /不如卫青/u,
    /拔刀自杀/u,
    /没有公开追究/u,
    /不能简单说卫青软弱/u,
    /把事情压了下去/u,
    /未经审判的杀人案/u,
    /停了下来/u,
  ];
  for (const pattern of historicalBeats) {
    const match = source.match(pattern)?.[0];
    if (match) return clean(match);
  }
  const roleKeywords = {
    mechanism: /(?:借钱进货|卖出去|收回本钱|再投资|进货|回本|交易|生意|客户)/u,
    crisis: /(?:客户赖账|货物积压|卖不出去|现金断裂|亏损|风险|危机)/u,
    reversal: /(?:假名|保险柜|支票|突然|拒绝|失败|却|但是)/u,
    comparison: /(?:年薪|售价|成本|市值|估值|营收|收入|利润|美元|价格)/u,
  };
  const keyword = roleKeywords[role]?.exec(source)?.[0];
  const cleanedKeyword = clean(keyword);
  if (cleanedKeyword.length >= 2) return cleanedKeyword;
  const matches = [
    /(?:年薪|月薪|售价|价格|成本|市值|估值|营收|收入|利润|债务|欠款|支票|美元|美金|%)[^，。！？；]{0,18}/u,
    /(?:唯一不正常的是|根本不叫|假名|东躲西藏|赖账|积压|保险柜|打开|拒绝|失败|危机)[^，。！？；]{0,16}/u,
  ];
  for (const pattern of matches) {
    const match = source.match(pattern)?.[0]?.trim();
    if (match && match.length >= 2) return clean(match);
  }
  if (role === 'mechanism') return clean(source) || '关键现场';
  if (role === 'hook') return clean(source) || '关键现场';
  return clean(source) || (role === 'crisis' ? '危机扩大' : '关键转折');
};

const numberBinding = (text) => {
  const source = normalizedText(text);
  if (/(?:公元前|公元)?\s*[0-9]{1,4}\s*年/u.test(source)) return null;
  const match = source.match(/(?:\$\s*)?([0-9][0-9,.]*)(?:\s*(万|亿|千|B|M|K))?\s*(美元|美金|%|percent|亿|万|千|B|M|K)?/iu);
  if (!match) return null;
  const value = Number(match[1].replace(/,/gu, ''));
  if (!Number.isFinite(value)) return null;
  const suffix = match[2] ?? '';
  const unit = match[3] ?? (suffix ? suffix : '数量');
  // Four-digit years in dates are not metrics. Require a unit/currency or a
  // non-year-sized value before turning a narration number into animation.
  if (!suffix && !match[3] && value >= 1000 && value <= 2100) return null;
  const multiplier = {万: 10000, 亿: 100000000, 千: 1000, B: 1000000000, M: 1000000, K: 1000}[suffix] ?? 1;
  return {value: value * multiplier, unit, displaySuffix: suffix || unit};
};

const semanticCuesFor = (unit, duration) => {
  const text = normalizedText(unit.text);
  const {startFrame, endFrame} = cueWindow(unit);
  const cues = {texts: [], graphics: []};
  // The production adapter resolves cue subjects against staged asset IDs.
  // Keep the richer entity identity in the decision trace, but make the
  // render binding deterministic across inventories that expose both IDs.
  const subjectId = unit.assetId;
  const phrase = salientPhrase(text, unit.narrativeRole);
  const number = numberBinding(text);
  const hintedVariant = unit.editorialHint?.typographyVariant;
  const typographyVariant = hintedVariant ?? (
    unit.narrativeRole === 'mechanism'
      ? 'whisper'
      : unit.narrativeRole === 'establishing' || unit.narrativeRole === 'resolution'
        ? 'stamp'
        : 'impact'
  );
  if (number) {
    const id = `cue:${unit.semanticUnitId}:metric`;
    cues.texts.push({
      accent: '#F2B84B',
      decimals: 0,
      endFrame,
      entry: 'counter',
      from: 0,
      id,
      label: phrase,
      metricId: `${unit.semanticUnitId}:metric`,
      period: 'narrated beat',
      startFrame,
      subject: phrase,
      subjectId,
      suffix: number.displaySuffix,
      to: number.value,
      type: 'counter',
      unit: number.unit,
      x: 0.08,
      y: 0.62,
      width: 0.72,
      fontSize: 54,
      weight: 800,
      ...(text.includes('$') ? {prefix: '$'} : {}),
    });
    cues.graphics.push({
      color: '#F2B84B',
      endFrame,
      height: 0.006,
      id: `cue:${unit.semanticUnitId}:metric-bar`,
      kind: 'bar',
      label: phrase,
      startFrame,
      subject: `${phrase} metric bar`,
      subjectId,
      width: 0.34,
      x: 0.08,
      y: 0.76,
    });
  }
  if (unit.narrativeRole === 'hook') {
    cues.texts.push({
      accent: '#F2B84B',
      color: '#F4F0E9',
      endFrame,
      entry: 'kinetic',
      id: `cue:${unit.semanticUnitId}:hook-text`,
      label: '开场现场',
      startFrame,
      subject: phrase,
      subjectId,
      text: phrase,
      type: 'text',
      variant: typographyVariant,
      width: 0.78,
      x: 0.08,
      y: 0.68,
      fontSize: 44,
      weight: 800,
    });
  }
  if (unit.narrativeRole === 'crisis') {
    cues.texts.push({
      accent: '#E56B55',
      color: '#F4F0E9',
      endFrame,
      entry: 'kinetic',
      id: `cue:${unit.semanticUnitId}:crisis-text`,
      label: '危机',
      startFrame: Math.min(endFrame - 1, startFrame + Math.round(duration * 0.12)),
      subject: phrase,
      subjectId,
      text: phrase,
      type: 'text',
      variant: typographyVariant,
      x: 0.08,
      y: 0.78,
      width: 0.78,
      fontSize: 42,
      weight: 700,
    });
  }
  const mechanismEmphasis = unit.editorialHint?.emphasis ?? unit.emphasis ?? 0;
  if (unit.narrativeRole === 'mechanism' && mechanismEmphasis >= 0.72) {
    cues.texts.push({
      accent: '#64C7C0',
      color: '#F4F0E9',
      endFrame,
      entry: 'fade',
      id: `cue:${unit.semanticUnitId}:mechanism-text`,
      startFrame,
      subject: phrase,
      subjectId,
      text: phrase,
      type: 'text',
      variant: typographyVariant,
      width: 0.72,
      x: 0.08,
      y: 0.74,
      fontSize: 38,
      weight: 700,
    });
  }
  if (unit.narrativeRole === 'comparison') {
    cues.graphics.push({
      color: '#B89CFF',
      endFrame,
      height: 0.004,
      id: `cue:${unit.semanticUnitId}:comparison-divider`,
      kind: 'divider',
      label: phrase,
      startFrame,
      subject: `comparison: ${phrase}`,
      subjectId,
      width: 0.42,
      x: 0.5,
      y: 0.16,
    });
  }
  if (unit.narrativeRole === 'reversal') {
    cues.texts.push({
      accent: '#E56B55',
      color: '#E56B55',
      endFrame,
      entry: 'kinetic',
      id: `cue:${unit.semanticUnitId}:reversal-text`,
      label: '反转',
      startFrame,
      subject: phrase,
      subjectId,
      text: phrase,
      type: 'text',
      variant: typographyVariant,
      x: 0.08,
      y: 0.78,
      width: 0.82,
      fontSize: 34,
      weight: 800,
    });
  }
  return cues;
};

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
    const defaultCamera = typeof rule.defaults?.camera === 'string'
      ? {preset: rule.defaults.camera}
      : rule.defaults?.camera;
    const camera = defaultCamera && unit.editorialHint?.focus
      ? {...defaultCamera, focus: unit.editorialHint.focus}
      : defaultCamera;
    if (!camera || !supportedCameras.has(camera.preset) || !rule.allowedCameras?.includes(camera.preset)) {
      needsReview('Grammar rule has no supported allowed camera default', {grammarRuleId: ruleId});
    }
    const shotId = `shot:${unit.semanticUnitId}`;
    const shot = {
      background: {assetId: unit.assetId},
      camera,
      durationInFrames: unit.endFrame - unit.startFrame,
      id: shotId,
      semanticRole: unit.narrativeRole,
    };
    const cues = semanticCuesFor(unit, shot.durationInFrames);
    shot.texts = cues.texts;
    shot.graphics = cues.graphics;
    const baseTrace = {
      assetId: unit.assetId,
      fallback: camera.preset,
      rationale: `Use the declared conservative default for semantic unit ${unit.semanticUnitId}.`,
      rule,
      unit,
    };
    traceByNodeId[`shot:${shotId}:timing`] = traceFor(baseTrace);
    traceByNodeId[`shot:${shotId}:background`] = traceFor(baseTrace);
    traceByNodeId[`shot:${shotId}:camera`] = traceFor(baseTrace);
    for (const cue of [...shot.texts, ...shot.graphics]) {
      const cueTrace = {
        ...traceFor(baseTrace),
        claimIds: unit.claimIds ?? [],
        rationale: `Bind ${cue.type ?? cue.kind} cue to the narrated subject: ${cue.subject}.`,
      };
      if (cue.metricId) cueTrace.metricId = cue.metricId;
      if (cue.type === 'counter') cueTrace.sourceNote = `Counter value is extracted from the locked narration beat: ${unit.text}.`;
      traceByNodeId[cue.id] = cueTrace;
    }

    if (index < semanticOutline.semanticUnits.length - 1) {
      const transition = typeof rule.defaults?.transition === 'string'
        ? {class: rule.defaults.transition}
        : rule.defaults?.transition;
      if (!transition || !supportedTransitions.has(transition.class) || !rule.allowedTransitions?.includes(transition.class)) {
        needsReview('Grammar rule has no supported allowed transition default', {grammarRuleId: ruleId});
      }
      shot.transitionOut = transition;
      traceByNodeId[`shot:${shotId}:transitionOut`] = traceFor({...baseTrace, fallback: transition.class});
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
