const backgroundFields = ['fit', 'position', 'filter'];
const textFields = [
  'subject', 'text', 'startFrame', 'endFrame', 'entry', 'exit', 'x', 'y', 'width',
  'align', 'fontSize', 'weight', 'color', 'accent', 'prefix', 'suffix', 'unit',
  'period', 'from', 'to', 'decimals', 'label',
];
const graphicFields = [
  'kind', 'subject', 'startFrame', 'endFrame', 'x', 'y', 'width', 'height',
  'color', 'secondaryColor', 'label',
];
const shotFields = [
  'camera', 'transitionIn', 'transitionOut', 'tint', 'grain', 'sourceLabel',
];

const copyFields = (source, fields) => Object.fromEntries(
  fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, structuredClone(source[field])]),
);

const singleBinding = (value) => typeof value === 'string' && value.length > 0 ? value : null;

export const migrateRecipeV1ToV2 = ({recipe, identityMap, sourceHash}) => {
  if (recipe.schemaVersion !== 'magnates-remotion-recipe-v1') {
    throw Object.assign(new Error('Migration accepts only immutable Recipe v1 input'), {
      code: 'MIGRATION_SOURCE_VERSION_INVALID',
    });
  }
  const diagnostics = [];
  const changes = [];
  const requireBinding = ({value, pointer, kind}) => {
    const binding = singleBinding(value);
    if (!binding) {
      diagnostics.push({code: 'MAPPING_REQUIRED', kind, pointer});
      return null;
    }
    return binding;
  };

  const shots = recipe.shots.map((sourceShot, shotIndex) => {
    const shotPointer = `/shots/${shotIndex}`;
    const assetId = requireBinding({
      kind: 'assetId',
      pointer: `${shotPointer}/background/src`,
      value: identityMap.assetsBySource?.[sourceShot.background.src],
    });
    const semanticRole = sourceShot.semanticRole ?? requireBinding({
      kind: 'semanticRole',
      pointer: `${shotPointer}/semanticRole`,
      value: identityMap.semanticRolesByShotId?.[sourceShot.id],
    });
    if (assetId) changes.push({
      from: `${shotPointer}/background/src`,
      newValue: assetId,
      oldValue: sourceShot.background.src,
      reasonCode: 'EXPLICIT_ASSET_IDENTITY_MAP',
      to: `${shotPointer}/background/assetId`,
    });
    if (!sourceShot.semanticRole && semanticRole) changes.push({
      from: null,
      newValue: semanticRole,
      oldValue: null,
      reasonCode: 'EXPLICIT_SEMANTIC_ROLE_MAP',
      to: `${shotPointer}/semanticRole`,
    });

    const texts = (sourceShot.texts ?? []).map((sourceCue, cueIndex) => {
      const pointer = `${shotPointer}/texts/${cueIndex}`;
      const subjectId = requireBinding({
        kind: 'subjectId',
        pointer: `${pointer}/subjectId`,
        value: identityMap.subjectsByPointer?.[pointer],
      });
      const type = sourceCue.type ?? (sourceCue.entry === 'counter' ? 'counter' : 'text');
      const cue = {
        ...copyFields(sourceCue, textFields),
        id: `${sourceShot.id}:text:${cueIndex}`,
        subjectId,
        type,
      };
      changes.push({
        from: pointer,
        newValue: cue.id,
        oldValue: null,
        reasonCode: 'DETERMINISTIC_CUE_ID',
        to: `${pointer}/id`,
      });
      if (type === 'counter') {
        const metricId = requireBinding({
          kind: 'metricId',
          pointer: `${pointer}/metricId`,
          value: identityMap.metricsByPointer?.[pointer]?.metricId,
        });
        cue.metricId = metricId;
      }
      return cue;
    });
    const graphics = (sourceShot.graphics ?? []).map((sourceCue, cueIndex) => {
      const pointer = `${shotPointer}/graphics/${cueIndex}`;
      const subjectId = requireBinding({
        kind: 'subjectId',
        pointer: `${pointer}/subjectId`,
        value: identityMap.subjectsByPointer?.[pointer],
      });
      const cue = {
        ...copyFields(sourceCue, graphicFields),
        id: `${sourceShot.id}:graphic:${cueIndex}`,
        subjectId,
      };
      changes.push({
        from: pointer,
        newValue: cue.id,
        oldValue: null,
        reasonCode: 'DETERMINISTIC_CUE_ID',
        to: `${pointer}/id`,
      });
      return cue;
    });
    return {
      ...copyFields(sourceShot, shotFields),
      background: {assetId, ...copyFields(sourceShot.background, backgroundFields)},
      durationInFrames: sourceShot.durationInFrames,
      ...(graphics.length > 0 ? {graphics} : {}),
      id: sourceShot.id,
      semanticRole,
      ...(texts.length > 0 ? {texts} : {}),
    };
  });

  if (diagnostics.length > 0) {
    return {
      diagnostics,
      recipeCandidate: null,
      report: null,
      status: 'needs_mapping',
    };
  }
  const recipeCandidate = {
    durationInFrames: recipe.durationInFrames,
    fps: recipe.fps,
    schemaVersion: 'magnates-remotion-recipe-v2',
    shots,
    ...(recipe.title === undefined ? {} : {title: recipe.title}),
  };
  return {
    diagnostics: [],
    recipeCandidate,
    report: {
      changes,
      migrationVersion: 'recipe-v1-to-v2/1.0.0',
      sourceHash,
      sourceVersion: 'magnates-remotion-recipe-v1',
      supersedes: sourceHash,
      targetVersion: 'magnates-remotion-recipe-v2',
    },
    status: 'migrated',
  };
};
