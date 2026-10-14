import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {FineEditOverlay} from './FineEditOverlay';
import {validateFineEditProps, type FineEditProps} from './fine-edit-core';

const defaultProps: FineEditProps = {
  width: 1920, height: 1080, fps: 30, durationInFrames: 150,
  shotDurationInFrames: 150, shotFrameOffset: 0,
  camera: {mode: 'hold', focusX: 0.5, focusY: 0.5, amount: 0}, effects: [],
};
const Root: React.FC = () => <Composition id="FineEditOverlay" component={FineEditOverlay}
  width={defaultProps.width} height={defaultProps.height} fps={defaultProps.fps}
  durationInFrames={defaultProps.durationInFrames} defaultProps={defaultProps}
  calculateMetadata={({props}) => {
    validateFineEditProps(props);
    return {width: props.width, height: props.height, fps: props.fps, durationInFrames: props.durationInFrames};
  }} />;
registerRoot(Root);
