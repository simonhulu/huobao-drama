import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {compileFunction} from 'node:vm';
const requireRemotion=createRequire(new URL('../../remotion/package.json',import.meta.url));
const compiled=requireRemotion('esbuild').buildSync({entryPoints:[new URL('../../remotion/src/HistoryMapScene.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});
const module={exports:{}};
compileFunction(compiled.outputFiles[0].text,['require','module','exports'])(requireRemotion,module,module.exports);
const {encirclementState,mapCameraAt,containedMapCamera}=module.exports;

test('encirclement builds, then compresses the actual area and holds its result',()=>{
  const layer={start:2,end:4,compressionStart:5,compressionEnd:8,innerScale:.62};
  assert.deepEqual(encirclementState(layer,1),{build:0,compression:0,scale:1});
  assert.equal(encirclementState(layer,3).build,.5);
  assert.deepEqual(encirclementState(layer,4.5),{build:1,compression:0,scale:1});
  const middle=encirclementState(layer,6.5),end=encirclementState(layer,8);
  assert.ok(middle.scale<1&&middle.scale>end.scale);
  assert.ok(end.scale**2<.4,'visible activity area falls below 40% of its initial illustrative area');
  assert.deepEqual(end,encirclementState(layer,10));
  assert.equal(encirclementState({start:1,end:3},5).scale,1,'short construction shot does not invent compression');
});

test('camera uses seconds and holds after its final key',()=>{
  const map={camera:{keyframes:[{t:0,focusX:.5,focusY:.5,zoom:1},{t:8,focusX:.6,focusY:.4,zoom:1.1}]}};
  const camera=mapCameraAt(map,4);
  assert.equal(camera.zoom,1.05);assert.equal(camera.focusX,.55);
  assert.deepEqual(mapCameraAt(map,9),map.camera.keyframes[1]);
  assert.deepEqual(mapCameraAt({},9),{focusX:.5,focusY:.5,zoom:1});
});

test('map camera never exposes the canvas beyond the geographic background',()=>{
  for(const zoom of [1,1.04,1.1,2.2])for(const focusX of [0,.155,.5,1])for(const focusY of [0,.5,.684,1]){
    const c=containedMapCamera({zoom,focusX,focusY});
    for(const focus of [c.focusX,c.focusY]){
      const left=.5-zoom*focus,right=.5+zoom*(1-focus);
      assert.ok(left<=1e-10&&right>=1-1e-10,'the scaled map must cover both edges');
    }
  }
  assert.deepEqual(containedMapCamera({zoom:1.1,focusX:.5,focusY:.5}),{zoom:1.1,focusX:.5,focusY:.5});
});
