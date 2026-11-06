import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {HistoryMapDemo, type HistoryMapScene} from './HistoryMapDemo';

const emptyScene: HistoryMapScene = {
  width: 1920, height: 1080,
  routes: {redMain: [{x: 0, y: 0}, {x: 1, y: 0}], redFlank: [{x: 0, y: 0}, {x: 1, y: 0}],
    blueAdvance: [{x: 0, y: 0}, {x: 1, y: 0}], blueRetreat: [{x: 0, y: 0}, {x: 1, y: 0}]},
  places: {pass: {x: 960, y: 540}, redCamp: {x: 400, y: 540}, blueCamp: {x: 1400, y: 540}, northRidge: {x: 800, y: 300}, river: {x: 1000, y: 700}},
};

registerRoot(() => <Composition id="HistoryMapDemo" component={HistoryMapDemo}
  width={1920} height={1080} fps={30} durationInFrames={720} defaultProps={{scene: emptyScene}}/>);
