import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {SemanticShotOverlay} from './SemanticShotOverlay';
import {FINE_EDIT_INK, fineCameraAt, fineEffectState, validateFineEditProps, type FineEditProps, type FineEffect} from './fine-edit-core';
import type {SemanticEffect} from './semantic-overlay-core';

const DrawnMark: React.FC<{effect: FineEffect; props: FineEditProps; frame: number}> = ({effect, props, frame}) => {
  const state = fineEffectState(effect, frame, props.fps);
  if (!state.active) return null;
  const width = effect.width * props.width;
  const height = effect.height * props.height;
  const ring = effect.kind === 'ring';
  const pad = Math.min(width, height) * 0.09;
  const d = ring
    ? `M ${width * 0.80} ${height * 0.18} C ${width * 0.39} ${-height * 0.02} ${pad} ${height * 0.15} ${pad} ${height * 0.48} C ${pad} ${height * 0.86} ${width * 0.46} ${height * 0.97} ${width * 0.81} ${height * 0.79} C ${width * 1.04} ${height * 0.64} ${width * 0.96} ${height * 0.28} ${width * 0.72} ${height * 0.17}`
    : `M ${pad} ${height / 2} Q ${width * 0.48} ${height * 0.40} ${width - pad} ${height / 2}`;
  return <svg data-fine-effect={effect.id} width={width} height={height}
    style={{position: 'absolute', left: effect.x * props.width, top: effect.y * props.height, opacity: state.opacity}}
    viewBox={`0 0 ${width} ${height}`}>
    <path d={d} fill="none" stroke={effect.color ?? FINE_EDIT_INK} strokeWidth={Math.max(2, props.width / 640)}
      strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - state.draw} />
    {!ring ? <path d={`M ${width - pad - Math.min(height * 0.3, width * 0.12)} ${height * 0.25} L ${width - pad} ${height / 2} L ${width - pad - Math.min(height * 0.3, width * 0.12)} ${height * 0.75}`}
      fill="none" stroke={effect.color ?? FINE_EDIT_INK} strokeWidth={Math.max(2, props.width / 640)}
      strokeLinecap="round" strokeLinejoin="round" opacity={Math.max(0, (state.draw - 0.75) * 4)} /> : null}
  </svg>;
};

export const FineEditOverlay: React.FC<FineEditProps> = (props) => {
  const frame = useCurrentFrame();
  useMemo(() => validateFineEditProps(props), [props]);
  const camera = fineCameraAt(props.camera, frame + props.shotFrameOffset, props.shotDurationInFrames);
  return <AbsoluteFill style={{backgroundColor: 'transparent', overflow: 'hidden', pointerEvents: 'none'}}>
    {(['image', 'screen'] as const).map((space) => {
      const effects = props.effects.filter((effect) => effect.space === space);
      const semantic = effects.filter((effect) => effect.kind !== 'ring' && effect.kind !== 'connector')
        .map((effect) => ({...effect, color: effect.color ?? FINE_EDIT_INK})) as SemanticEffect[];
      return <AbsoluteFill key={space} style={{transformOrigin: '0 0', transform: space === 'image'
        ? `translate(${-props.width * (camera.zoom - 1) * camera.focusX}px, ${-props.height * (camera.zoom - 1) * camera.focusY}px) scale(${camera.zoom})` : undefined}}>
        <SemanticShotOverlay width={props.width} height={props.height} fps={props.fps} durationInFrames={props.durationInFrames} effects={semantic} />
        {effects.filter((effect) => effect.kind === 'ring' || effect.kind === 'connector')
          .map((effect) => <DrawnMark key={effect.id} effect={effect} props={props} frame={frame} />)}
      </AbsoluteFill>;
    })}
  </AbsoluteFill>;
};
