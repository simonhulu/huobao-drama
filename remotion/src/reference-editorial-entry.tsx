import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {ReferenceEditorialOverlay} from './ReferenceEditorialOverlay';
import {validateReferenceEditorialProps, type ReferenceEditorialProps} from './reference-editorial-core';

const defaults: ReferenceEditorialProps = {
  width:1920,height:1080,fps:30,durationInFrames:150,
  shotDurationInFrames:150,shotFrameOffset:0,
  camera:{mode:'hold',focusX:.5,focusY:.5,amount:0},effects:[],
};
registerRoot(() => <Composition id="ReferenceEditorialOverlay" component={ReferenceEditorialOverlay}
  width={1920} height={1080} fps={30} durationInFrames={150} defaultProps={defaults}
  calculateMetadata={({props}) => {
    validateReferenceEditorialProps(props);
    return {width:props.width,height:props.height,fps:props.fps,durationInFrames:props.durationInFrames};
  }}/>);
