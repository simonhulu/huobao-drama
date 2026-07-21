export const OPERATION_STEPS = Object.freeze({
  'analyze-reference': Object.freeze([
    'INTAKE_LOCKED',
    Object.freeze(['BOUNDARIES_READY', 'SEMANTICS_READY']),
    'REVIEW_INPUT_READY',
    'TECHNIQUES_CLASSIFIED',
  ]),
  'plan-edit': Object.freeze([
    'INTAKE_LOCKED',
    'SEMANTICS_READY',
    'AUTHORING_INPUT_READY',
    'RECIPE_DRAFTED',
    'RECIPE_VALIDATED',
  ]),
  'render-recipe': Object.freeze([
    'INTAKE_LOCKED',
    'RECIPE_VALIDATED',
    'AUDIO_CONFORMED',
    'ADAPTER_READY',
    'PROPS_BUILT',
    'RENDERED',
    'INSPECTED',
    'QA_PASSED',
  ]),
  produce: Object.freeze([
    'INTAKE_LOCKED',
    'SEMANTICS_READY',
    'AUTHORING_INPUT_READY',
    'RECIPE_DRAFTED',
    'RECIPE_VALIDATED',
    'AUDIO_CONFORMED',
    'ADAPTER_READY',
    'PROPS_BUILT',
    'RENDERED',
    'INSPECTED',
    'QA_PASSED',
  ]),
});

export const STAGE_DEFINITIONS = Object.freeze([
  {id: 'INTAKE_LOCKED', prerequisites: [], outputs: ['input-manifest.lock.json']},
  {id: 'BOUNDARIES_READY', prerequisites: ['INTAKE_LOCKED'], outputs: ['boundary-samples.json']},
  {id: 'SEMANTICS_READY', prerequisites: ['INTAKE_LOCKED'], outputs: ['semantic-outline.json']},
  {
    id: 'REVIEW_INPUT_READY',
    prerequisites: ['BOUNDARIES_READY', 'SEMANTICS_READY'],
    outputs: ['review-request.json'],
  },
  {
    id: 'TECHNIQUES_CLASSIFIED',
    prerequisites: ['REVIEW_INPUT_READY'],
    outputs: ['technique-annotations.json'],
  },
  {
    id: 'AUTHORING_INPUT_READY',
    prerequisites: ['SEMANTICS_READY'],
    outputs: ['authoring-request.json'],
  },
  {
    id: 'RECIPE_DRAFTED',
    prerequisites: ['AUTHORING_INPUT_READY'],
    outputs: ['authoring-result.json', 'recipe.draft.json'],
  },
  {
    id: 'RECIPE_VALIDATED',
    prerequisites: ['INTAKE_LOCKED'],
    outputs: ['recipe.validation.json', 'recipe.lock.json'],
  },
  {id: 'AUDIO_CONFORMED', prerequisites: ['RECIPE_VALIDATED'], outputs: ['narration-conform.json']},
  {
    id: 'ADAPTER_READY',
    prerequisites: ['AUDIO_CONFORMED'],
    outputs: ['capabilities.json', 'renderer-environment.lock.json'],
  },
  {id: 'PROPS_BUILT', prerequisites: ['ADAPTER_READY'], outputs: ['remotion-props.json']},
  {id: 'RENDERED', prerequisites: ['PROPS_BUILT'], outputs: ['final.mp4', 'render-manifest.json']},
  {id: 'INSPECTED', prerequisites: ['RENDERED'], outputs: ['layout-telemetry.json']},
  {id: 'QA_PASSED', prerequisites: ['INSPECTED'], outputs: ['qa-report.json']},
]);

export const createWorkflowStages = (executors) => STAGE_DEFINITIONS.map((definition) => {
  const execute = executors[definition.id];
  if (typeof execute !== 'function') {
    throw Object.assign(new Error(`Missing executor for stage ${definition.id}`), {
      code: 'STAGE_EXECUTOR_MISSING',
    });
  }
  return {...definition, execute};
});
