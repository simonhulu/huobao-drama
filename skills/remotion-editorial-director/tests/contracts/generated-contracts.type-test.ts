import type {
  RecipeGraphicCueV2,
  RecipeShotV2,
  RecipeTextCueV2,
} from '../../generated/contracts.js';

const textCue: RecipeTextCueV2 = {
  id: 'cue-001',
  type: 'text',
  subject: 'Market reversal',
  subjectId: 'claim-market-reversal',
  startFrame: 0,
  endFrame: 30,
  text: 'The evidence reversed the claim',
  entry: 'fade',
  exit: 'fade',
  x: 0.1,
  y: 0.1,
  width: 0.8,
  align: 'center',
  fontSize: 64,
  weight: 700,
  color: '#FFFFFF',
};

const graphicCue: RecipeGraphicCueV2 = {
  id: 'graphic-001',
  kind: 'divider',
  subject: 'Before and after',
  subjectId: 'claim-market-reversal',
  startFrame: 0,
  endFrame: 30,
  x: 0.5,
  y: 0.1,
  width: 0.01,
  height: 0.8,
  color: '#FFFFFF',
};

const shot: RecipeShotV2 = {
  id: 'shot-001',
  durationInFrames: 30,
  background: {assetId: 'asset-market-chart', fit: 'cover'},
  semanticRole: 'reversal',
  camera: {preset: 'hold'},
  transitionIn: {class: 'hard_cut', frames: 0},
  transitionOut: {class: 'dissolve', frames: 10},
  texts: [textCue],
  graphics: [graphicCue],
  tint: '#101820CC',
  grain: 0.1,
  sourceLabel: 'Fixture',
};

const unknownTextCue: RecipeTextCueV2 = {
  ...textCue,
  // @ts-expect-error recipe text cues are closed
  surprise: true,
};

const unknownGraphicCue: RecipeGraphicCueV2 = {
  ...graphicCue,
  // @ts-expect-error recipe graphic cues are closed
  surprise: true,
};

const unknownShot: RecipeShotV2 = {
  ...shot,
  // @ts-expect-error recipe shots are closed
  surprise: true,
};

void unknownTextCue;
void unknownGraphicCue;
void unknownShot;
