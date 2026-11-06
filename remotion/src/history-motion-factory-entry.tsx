import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {HistoryMotionFactory, type HistoryMotionFactoryProps} from './HistoryMotionFactory';

const defaults: HistoryMotionFactoryProps = {width: 1920, height: 1080, fps: 30, durationInFrames: 30, shots: []};
registerRoot(() => <Composition id="HistoryMotionFactory" component={HistoryMotionFactory} width={defaults.width} height={defaults.height} fps={defaults.fps} durationInFrames={defaults.durationInFrames} defaultProps={defaults} calculateMetadata={({props}) => ({width: props.width, height: props.height, fps: props.fps, durationInFrames: props.durationInFrames})} />);
