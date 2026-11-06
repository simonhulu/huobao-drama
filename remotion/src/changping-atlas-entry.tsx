import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {ChangpingAtlasDemo} from './ChangpingAtlasDemo';
import {changpingMap} from './changping-data';

registerRoot(() => <Composition id="ChangpingAtlasDemo" component={ChangpingAtlasDemo}
  width={1920} height={1080} fps={30} durationInFrames={changpingMap.seconds * changpingMap.fps}/>);
