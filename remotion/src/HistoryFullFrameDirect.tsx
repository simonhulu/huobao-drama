import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame} from 'remotion';
import {ReferenceEditorialOverlay} from './ReferenceEditorialOverlay';
import type {ReferenceEditorialProps} from './reference-editorial-core';
import {fineCameraAt, type FineCamera} from './fine-edit-core';

type Caption = {text: string; startFrame: number; endFrame: number};
type Shot = {storyboardNumber: number; startFrame: number; frames: number; imageSrc: string;
  camera: FineCamera; effects: ReferenceEditorialProps['effects']; page?: ReferenceEditorialProps['page']};
export type HistoryFullFrameProps = {width: number; height: number; fps: number; durationInFrames: number;
  audioSrc: string; shots: Shot[]; captions: Caption[]};
const media = (src: string) => /^(https?:|data:)/.test(src) ? src : staticFile(src);

const ShotScene: React.FC<{shot: Shot; props: HistoryFullFrameProps}> = ({shot, props}) => {
  const frame = useCurrentFrame();
  const camera = fineCameraAt(shot.camera, frame, shot.frames);
  return <AbsoluteFill style={{overflow: 'hidden'}}>
    <AbsoluteFill style={{transformOrigin: '0 0', transform: `translate(${-props.width * (camera.zoom - 1) * camera.focusX}px, ${-props.height * (camera.zoom - 1) * camera.focusY}px) scale(${camera.zoom})`}}>
      <Img src={media(shot.imageSrc)} style={{width: '100%', height: '100%', objectFit: 'cover'}}/>
    </AbsoluteFill>
    <ReferenceEditorialOverlay width={props.width} height={props.height} fps={props.fps}
      durationInFrames={shot.frames} shotDurationInFrames={shot.frames} shotFrameOffset={0}
      camera={shot.camera} effects={shot.effects} page={shot.page}/>
  </AbsoluteFill>;
};

export const HistoryFullFrameDirect: React.FC<HistoryFullFrameProps> = props => {
  const frame = useCurrentFrame();
  const caption = props.captions.find(c => frame >= c.startFrame && frame < c.endFrame);
  const text = caption?.text.replace(/\\N/g, '\n') ?? '';
  const lines = text.split('\n').flatMap(line => {
    const chars = [...line], result: string[] = [];
    while (chars.length) result.push(chars.splice(0, 32).join(''));
    return result;
  });
  const fontSize = lines.length > 2 ? 42 : 48;
  return <AbsoluteFill style={{backgroundColor: '#000'}}>
    <Audio src={media(props.audioSrc)}/>
    {props.shots.map(shot => <Sequence key={shot.storyboardNumber} from={shot.startFrame}
      durationInFrames={shot.frames} premountFor={2}><ShotScene shot={shot} props={props}/></Sequence>)}
    {text ? <div style={{position: 'absolute', left: 90, right: 90, bottom: 36, textAlign: 'center',
      fontFamily: 'PingFang SC, sans-serif', fontSize, lineHeight: 1.2, fontWeight: 600,
      color: '#fff', WebkitTextStroke: '5px #171717', paintOrder: 'stroke fill', whiteSpace: 'pre-wrap'}}>
      {lines.join('\n')}
    </div> : null}
  </AbsoluteFill>;
};
