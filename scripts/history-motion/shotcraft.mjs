// Adapted movement grammar: Vincentwei1021/video-shotcraft (Apache-2.0),
// tension-camera-moves/SlowPushIn.tsx and PullBackIsolation.tsx.
// This is a history-footage adaptation, not a reproduction of its UI demos.
const close=(a,b)=>Math.abs(a-b)<.00001;
function automaticCamera(motion) {
  if(!motion)return true;
  const keys=motion.keyframes;
  return motion.kind==='kenburns' && (motion.durationScale??1)===1 && keys?.length===2
    && keys.every(k=>k.focusX===.5 && k.focusY===.5 && !k.easing)
    && keys[0].t===0 && keys[1].t===1 && close(keys[0].zoom,1) && close(keys[1].zoom,1.06);
}
const key=(t,zoom,focusX=.5,easing='ease-in-out')=>({t,zoom,focusX,focusY:.5,easing});

export function applyShotcraftDesign(input) {
  const plan=structuredClone(input);
  if(plan.shotcraft?.version===1)return plan;
  let imageIndex=0,pushUsed=false,revealUsed=false;
  plan.shots=plan.shots.map((shot,index)=>{
    const previous=plan.shots[index-1],seconds=shot.frames/plan.fps;
    const image=shot.visualType==='image' || !!shot.imagePath;
    const map=shot.visualType==='map' || shot.map?.enabled;
    const text=`${shot.purpose || ''} ${shot.narration || ''}`;
    const design={version:1,recipe:map?'map':image?'custom-camera':'footage',
      transition:previous?.shotcraft?.recipe==='slow-push-in' || !image&&!map?'cut':'dissolve',
      ...(shot.graphic?{graphicRecipe:shot.graphic.kind}:{})};
    if(image&&!map&&automaticCamera(shot.motion)) {
      const ordinal=imageIndex++,hold=Math.min(30,Math.max(15,Math.round(shot.frames*.16)));
      const durationScale=Math.max(.5,1-hold/Math.max(1,shot.frames-1));
      if(shot.graphic || seconds<2) {
        design.recipe='hold';shot.motion={kind:'static'};
      } else if(!pushUsed && seconds>=3 && /危机|逼近|绝境|突袭|决战|最后一搏|生死|紧逼/.test(text)) {
        pushUsed=true;design.recipe='slow-push-in';design.vignette=.5;
        // The source recipe's accelerating push and hard release are a pair.
        shot.motion={kind:'kenburns',durationScale:1,keyframes:[key(0,1),key(1,1.14,.5,'ease-in')]};
      } else if(!revealUsed && /城|疆|地形|山河|天下|全貌|辽阔|版图|都城/.test(text)) {
        revealUsed=true;design.recipe='establishing-reveal';
        // Limit crop to the existing picture; unlike the UI demo, never expose
        // empty canvas or invent a depth-separated subject from one image.
        shot.motion={kind:'kenburns',durationScale,keyframes:[key(0,1.14),key(1,1,.5,'ease-out')]};
      } else if(ordinal%3===2) {
        design.recipe='hold';shot.motion={kind:'static'};
      } else {
        const right=ordinal%2===0;design.recipe=right?'observe-right':'observe-left';
        shot.motion={kind:'pan',durationScale,keyframes:[key(0,1.1,right?.2:.8),key(1,1.1,right?.8:.2)]};
      }
    }
    shot.shotcraft=design;
    return shot;
  });
  // map() reads the original sequence until the assigned array is complete.
  for(let i=1;i<plan.shots.length;i++)if(plan.shots[i-1].shotcraft.recipe==='slow-push-in')plan.shots[i].shotcraft.transition='cut';
  plan.shotcraft={version:1,source:'video-shotcraft',adaptation:'history-editorial',
    recipes:['tension-camera-moves/slow-push-in','tension-camera-moves/pull-back-isolation','canvas-materialize-moves/diagram-cascade']};
  return plan;
}
