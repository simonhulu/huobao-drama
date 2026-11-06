import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {ChangpingControlDemo} from './ChangpingControlDemo';
import {changpingMap} from './changping-data';

registerRoot(() => <Composition id="ChangpingControlDemo" component={ChangpingControlDemo}
  width={1920} height={1080} fps={30} durationInFrames={changpingMap.seconds * changpingMap.fps}/>);
