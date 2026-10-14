export const SEMANTIC_SUBTITLE_SAFE_Y = 0.86;

export type SemanticEffect = {
  id: string;
  kind: 'thought' | 'scribble' | 'emphasis' | 'underline';
  startFrame: number;
  endFrame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  lines?: Array<{text: string; delayFrames: number}>;
  fontSize?: number;
  color?: string;
  trackTo?: {x: number; y: number};
  rationale?: string;
};

export type SemanticOverlayProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  effects: SemanticEffect[];
};

export type SemanticEffectFrame = {
  active: boolean;
  localFrame: number;
  progress: number;
  x: number;
  y: number;
};

export type SemanticTextLayout = {
  fontSize: number;
  lineHeight: number;
  inset: number;
  lines: Array<{text: string; delayFrames: number}>;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);

function assertPositive(value: number, name: string, integer = false): void {
  if (!finite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Semantic overlay: ${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
}

function assertBox(effect: SemanticEffect, x: number, y: number, suffix: string): void {
  if (!finite(x) || !finite(y) || x < 0 || y < 0 || x + effect.width > 1 + 1e-9) {
    throw new Error(`Semantic overlay ${effect.id}: ${suffix} box is outside the canvas`);
  }
  if (y + effect.height > SEMANTIC_SUBTITLE_SAFE_Y + 1e-9) {
    throw new Error(`Semantic overlay ${effect.id}: ${suffix} box enters the subtitle safe zone`);
  }
}

export function validateSemanticOverlayProps(props: SemanticOverlayProps): void {
  assertPositive(props.width, 'width', true);
  assertPositive(props.height, 'height', true);
  assertPositive(props.fps, 'fps');
  assertPositive(props.durationInFrames, 'durationInFrames', true);
  if (!Array.isArray(props.effects)) throw new Error('Semantic overlay: effects must be an array');
  const ids = new Set<string>();
  for (const effect of props.effects) {
    if (!effect || typeof effect.id !== 'string' || !effect.id.trim() || ids.has(effect.id)) {
      throw new Error('Semantic overlay: effect ids must be nonempty and unique');
    }
    ids.add(effect.id);
    if (!['thought', 'scribble', 'emphasis', 'underline'].includes(effect.kind)) {
      throw new Error(`Semantic overlay ${effect.id}: unsupported kind`);
    }
    if (!Number.isInteger(effect.startFrame) || !Number.isInteger(effect.endFrame)
      || effect.startFrame < 0 || effect.endFrame <= effect.startFrame
      || effect.endFrame > props.durationInFrames) {
      throw new Error(`Semantic overlay ${effect.id}: invalid frame window`);
    }
    assertPositive(effect.width, `${effect.id}.width`);
    assertPositive(effect.height, `${effect.id}.height`);
    assertBox(effect, effect.x, effect.y, 'initial');
    if (effect.trackTo) assertBox(effect, effect.trackTo.x, effect.trackTo.y, 'tracked');
    if (effect.fontSize !== undefined) assertPositive(effect.fontSize, `${effect.id}.fontSize`);
    if (effect.text !== undefined && typeof effect.text !== 'string') {
      throw new Error(`Semantic overlay ${effect.id}: text must be a string`);
    }
    if (effect.color !== undefined && !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(effect.color)) {
      throw new Error(`Semantic overlay ${effect.id}: color must be an RGB hex color`);
    }
    if (effect.lines !== undefined) {
      if (!Array.isArray(effect.lines) || !effect.lines.length) {
        throw new Error(`Semantic overlay ${effect.id}: lines must be a nonempty array`);
      }
      for (const line of effect.lines) {
        if (!line || typeof line.text !== 'string' || !line.text.trim() || /[\r\n]/.test(line.text)
          || !Number.isInteger(line.delayFrames) || line.delayFrames < 0
          || line.delayFrames >= effect.endFrame - effect.startFrame) {
          throw new Error(`Semantic overlay ${effect.id}: invalid text line or delay`);
        }
      }
    }
    if (effect.kind === 'thought' && effect.lines !== undefined) {
      throw new Error(`Semantic overlay ${effect.id}: thought uses a single short text, not lines`);
    }
    if (effect.kind === 'thought' && /[\r\n]/.test(effect.text ?? '')) {
      throw new Error(`Semantic overlay ${effect.id}: thought text must be a single line`);
    }
    if (effect.kind === 'emphasis' && !effect.lines && !effect.text?.trim()) {
      throw new Error(`Semantic overlay ${effect.id}: emphasis requires text`);
    }
    if (effect.kind === 'thought' || effect.kind === 'emphasis') {
      const layout = semanticTextLayout(effect, effect.width * props.width, effect.height * props.height);
      if (layout.lines.some((line) => !line.text.trim() || line.delayFrames >= effect.endFrame - effect.startFrame)) {
        throw new Error(`Semantic overlay ${effect.id}: text lines exceed the effect window`);
      }
    }
  }
}

export function resolveSemanticEffectFrame(effect: SemanticEffect, frame: number): SemanticEffectFrame {
  const duration = effect.endFrame - effect.startFrame;
  const localFrame = frame - effect.startFrame;
  const progress = clamp(localFrame / Math.max(1, duration - 1), 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  return {
    active: frame >= effect.startFrame && frame < effect.endFrame,
    localFrame,
    progress,
    x: effect.x + ((effect.trackTo?.x ?? effect.x) - effect.x) * eased,
    y: effect.y + ((effect.trackTo?.y ?? effect.y) - effect.y) * eased,
  };
}

export function activeSemanticEffects(props: SemanticOverlayProps, frame: number): SemanticEffect[] {
  return props.effects.filter((effect) => resolveSemanticEffectFrame(effect, frame).active);
}

export function semanticCanvasIsTransparent(props: SemanticOverlayProps, frame: number): boolean {
  return activeSemanticEffects(props, frame).length === 0;
}

export function semanticEffectBox(effect: SemanticEffect, props: SemanticOverlayProps, frame: number) {
  const state = resolveSemanticEffectFrame(effect, frame);
  return {
    left: state.x * props.width,
    top: state.y * props.height,
    width: effect.width * props.width,
    height: effect.height * props.height,
  };
}

// Conservative glyph bounds keep the layout safe before the local font is loaded.
export function semanticTextUnits(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + (/[\x00-\x7f]/.test(char) ? 0.75 : 1.08), 0);
}

export function semanticTextLayout(effect: SemanticEffect, boxWidth: number, boxHeight: number): SemanticTextLayout {
  const lines = effect.kind === 'thought'
    ? [{text: effect.text?.trim() || '\u2026', delayFrames: 0}]
    : effect.lines ?? (effect.text ?? '').split(/\r?\n/).map((text, index) => ({text, delayFrames: index * 5}));
  const inset = Math.min(boxWidth * 0.025, 12);
  const availableWidth = boxWidth * (effect.kind === 'thought' ? 0.7 : 1) - inset * 2;
  const availableHeight = boxHeight * (effect.kind === 'thought' ? 0.44 : 0.9);
  const maxUnits = Math.max(1, ...lines.map((line) => semanticTextUnits(line.text)));
  const requested = effect.fontSize ?? (effect.kind === 'thought' ? 40 : 72);
  const fontSize = Math.min(requested, availableWidth / maxUnits, availableHeight / (lines.length * 1.35));
  if (!finite(fontSize) || fontSize < 10) {
    throw new Error(`Semantic overlay ${effect.id}: text cannot fit legibly in its box`);
  }
  return {fontSize, lineHeight: fontSize * 1.35, inset, lines};
}

export function semanticScribblePath(frame: number): string {
  const phase = frame * Math.PI / 45;
  const points = Array.from({length: 90}, (_, index) => {
    const theta = index / 89 * Math.PI * 10;
    const x = 100 + Math.sin(theta * 1.21 + phase * 0.18) * 67 + Math.sin(theta * 3.2) * 9;
    const y = 57 + Math.cos(theta * 1.57 + phase * 0.15) * 32 + Math.sin(theta * 2.1) * 7;
    return {x, y};
  });
  const coordinate = (point: {x: number; y: number}) => `${point.x.toFixed(3)} ${point.y.toFixed(3)}`;
  const commands = [`M ${coordinate(points[0])}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    commands.push(`Q ${coordinate(point)} ${coordinate({x: (point.x + next.x) / 2, y: (point.y + next.y) / 2})}`);
  }
  commands.push(`Q ${coordinate(points[points.length - 1])} ${coordinate(points[points.length - 1])}`);
  return commands.join(' ');
}
