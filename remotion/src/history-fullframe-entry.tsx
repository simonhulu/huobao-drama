import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {HistoryFullFrameDirect, type HistoryFullFrameProps} from './HistoryFullFrameDirect';

const defaults: HistoryFullFrameProps = {width: 1920, height: 1080, fps: 30, durationInFrames: 30,
  audioSrc: '', shots: [], captions: []};
registerRoot(() => <Composition id="HistoryFullFrameDirect" component={HistoryFullFrameDirect}
  width={1920} height={1080} fps={30} durationInFrames={30} defaultProps={defaults}
  calculateMetadata={({props}) => ({width: props.width, height: props.height, fps: props.fps,
    durationInFrames: props.durationInFrames})}/>);
