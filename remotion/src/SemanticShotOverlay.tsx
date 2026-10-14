import React, {useEffect, useMemo, useState} from 'react';
import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {
  activeSemanticEffects,
  resolveSemanticEffectFrame,
  semanticEffectBox,
  semanticScribblePath,
  semanticTextLayout,
  validateSemanticOverlayProps,
  type SemanticEffect,
  type SemanticOverlayProps,
} from './semantic-overlay-core';

export type {SemanticEffect, SemanticOverlayProps} from './semantic-overlay-core';

const INK = '#24201d';
const RED = '#b23a32';
const FONT = 'Semantic WenKai';
const clamped = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

function useSemanticFont(required: boolean): void {
  const [handle] = useState(() => required ? delayRender('semantic overlay local font') : null);
  useEffect(() => {
    if (handle === null) return;
    let cancelled = false;
    const face = new FontFace(FONT, `url(${staticFile('fonts/LXGWWenKaiScreen.ttf')})`, {weight: '400'});
    face.load().then((loaded) => {
      if (cancelled) return;
      document.fonts.add(loaded);
      continueRender(handle);
    }).catch((error: unknown) => {
      if (!cancelled) cancelRender(error instanceof Error ? error : new Error(String(error)));
    });
    return () => {cancelled = true;};
  }, [handle]);
}

function fade(localFrame: number, duration: number, fps: number): number {
  const ramp = Math.max(1, Math.min(Math.round(fps * 0.23), Math.floor(duration / 3)));
  return Math.min(
    interpolate(localFrame, [0, ramp], [0, 1], clamped),
    interpolate(localFrame, [duration - ramp, duration], [1, 0], clamped),
  );
}

const Thought: React.FC<{effect: SemanticEffect; width: number; height: number}> = ({effect, width, height}) => {
  const layout = semanticTextLayout(effect, width, height);
  return (
    <svg width={width} height={height} viewBox="0 0 200 140" aria-label={layout.lines[0].text}>
      <path
        d="M 37 83 C 10 89 10 48 28 42 C 21 19 56 11 70 24 C 79 2 118 5 127 21 C 151 8 183 25 177 46 C 200 58 187 91 162 89 C 151 111 123 109 108 98 C 81 114 53 105 46 89 Z"
        fill="#ffffff" stroke={effect.color ?? INK} strokeWidth="2.1" strokeLinejoin="round"
      />
      <ellipse cx="53" cy="117" rx="7.5" ry="6" fill="#ffffff" stroke={effect.color ?? INK} strokeWidth="1.8" />
      <ellipse cx="38" cy="132" rx="3.8" ry="3.3" fill="#ffffff" stroke={effect.color ?? INK} strokeWidth="1.5" />
      <text
        x="102" y="60" textAnchor="middle" dominantBaseline="middle"
        fill={effect.color ?? INK} fontFamily={FONT} fontSize={layout.fontSize * 200 / width}
        style={{letterSpacing: 0}}
      >{layout.lines[0].text}</text>
    </svg>
  );
};

const Scribble: React.FC<{effect: SemanticEffect; localFrame: number}> = ({effect, localFrame}) => (
  <svg width="100%" height="100%" viewBox="0 0 200 120">
    <path d={semanticScribblePath(localFrame)} fill="none" stroke={effect.color ?? INK}
      strokeWidth="2.35" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Underline: React.FC<{effect: SemanticEffect; localFrame: number; fps: number}> = ({effect, localFrame, fps}) => {
  const grow = interpolate(localFrame, [0, Math.max(1, Math.round(fps * 0.38))], [0, 1], clamped);
  return (
    <svg width="100%" height="100%" viewBox="0 0 1000 80" preserveAspectRatio="none">
      <path d="M 10 44 C 190 34 340 53 498 43 S 804 32 990 40"
        pathLength="1" strokeDasharray="1" strokeDashoffset={1 - grow}
        fill="none" stroke={effect.color ?? RED} strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
};

const Emphasis: React.FC<{
  effect: SemanticEffect; width: number; height: number; localFrame: number; fps: number;
}> = ({effect, width, height, localFrame, fps}) => {
  const layout = semanticTextLayout(effect, width, height);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {layout.lines.map((line, index) => {
        const entryDuration = Math.max(1, Math.round(fps * 0.28));
        const lineFrame = localFrame - line.delayFrames;
        const opacity = interpolate(lineFrame, [0, entryDuration], [0, 1], clamped);
        const rise = interpolate(lineFrame, [0, entryDuration], [8, 0], clamped);
        const grow = interpolate(lineFrame, [entryDuration * 0.35, entryDuration * 1.8], [0, 1], clamped);
        const baseline = layout.fontSize + index * layout.lineHeight + layout.inset;
        const lineWidth = Math.min(width - layout.inset * 2, Array.from(line.text).length * layout.fontSize);
        return (
          <g key={`${index}-${line.text}`} opacity={opacity} transform={`translate(0 ${rise})`}>
            <text x={layout.inset} y={baseline} fill={effect.color ?? INK}
              stroke="#ffffff" strokeWidth="1.6" paintOrder="stroke fill"
              fontFamily={FONT} fontSize={layout.fontSize} style={{letterSpacing: 0}}>
              {line.text}
            </text>
            <path
              d={`M ${layout.inset} ${baseline + layout.fontSize * 0.1} Q ${layout.inset + lineWidth * 0.43} ${baseline + layout.fontSize * 0.17} ${layout.inset + lineWidth} ${baseline + layout.fontSize * 0.1}`}
              pathLength="1" strokeDasharray="1" strokeDashoffset={1 - grow}
              fill="none" stroke={RED} strokeWidth="3" strokeLinecap="round"
            />
          </g>
        );
      })}
    </svg>
  );
};

export const SemanticShotOverlay: React.FC<SemanticOverlayProps> = (props) => {
  const frame = useCurrentFrame();
  useMemo(() => validateSemanticOverlayProps(props), [props]);
  useSemanticFont(props.effects.some((effect) => effect.kind === 'thought' || effect.kind === 'emphasis'));
  const effects = activeSemanticEffects(props, frame);
  return (
    <AbsoluteFill style={{backgroundColor: 'transparent', pointerEvents: 'none', overflow: 'hidden'}}>
      {effects.map((effect) => {
        const state = resolveSemanticEffectFrame(effect, frame);
        const box = semanticEffectBox(effect, props, frame);
        const opacity = fade(state.localFrame, effect.endFrame - effect.startFrame, props.fps);
        return (
          <div key={effect.id} data-semantic-effect={effect.id} style={{
            position: 'absolute', ...box, opacity, overflow: 'hidden',
          }}>
            {effect.kind === 'thought' ? <Thought effect={effect} width={box.width} height={box.height} /> : null}
            {effect.kind === 'scribble' ? <Scribble effect={effect} localFrame={state.localFrame} /> : null}
            {effect.kind === 'underline' ? <Underline effect={effect} localFrame={state.localFrame} fps={props.fps} /> : null}
            {effect.kind === 'emphasis' ? <Emphasis effect={effect} width={box.width} height={box.height} localFrame={state.localFrame} fps={props.fps} /> : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
