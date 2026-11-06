import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {clipGeographicLine,clipGeographicRing,prepareMapGeography} from './map-geography.mjs';

const broad={minLon:110,maxLon:123,minLat:35.4,maxLat:41};
const dezhou={minLon:115.31,maxLon:117.98,minLat:36.46,maxLat:37.67};
const beijing={minLon:115.17,maxLon:116.99,minLat:39.76,maxLat:40.55};

test('line clipping preserves crossings with both original endpoints outside the viewport',()=>{
  assert.deepEqual(clipGeographicLine([[-2,.5],[2,.5]],{minLon:0,maxLon:1,minLat:0,maxLat:1}),[[[0,.5],[1,.5]]]);
  assert.deepEqual(clipGeographicLine([[-2,2],[2,2]],{minLon:0,maxLon:1,minLat:0,maxLat:1}),[]);
});

test('polygon clipping retains an enclosing ocean polygon even when no original vertex is in the viewport',()=>{
  const ring=clipGeographicRing([[-2,-2],[-2,2],[2,2],[2,-2],[-2,-2]],{minLon:0,maxLon:1,minLat:0,maxLat:1});
  assert.equal(ring.length,5);
  assert.deepEqual(ring[0],ring.at(-1));
  assert.ok(ring.every(([x,y])=>x>=0&&x<=1&&y>=0&&y<=1));
});

test('a regional production map has bounded detailed rivers, sourced mountain labels and true ocean polygons',()=>{
  const result=prepareMapGeography({bounds:broad,context:'明朝朱棣靖难之役'});
  assert.ok(result.waterways.length>100&&result.waterways.length<1200);
  assert.ok(result.sources.some(s=>s.title.startsWith('HydroRIVERS')));
  assert.ok(result.geographicLabels.some(l=>l.text==='太行山'));
  assert.ok(result.waterAreas.some(a=>a.kind==='ocean'));
  for(const line of result.waterways){assert.ok(line.points.length>=2&&line.points.length<=2048);assert.ok([1,2,3].includes(line.rank));}
  for(const point of [...result.waterways.flatMap(x=>x.points),...result.waterAreas.flatMap(a=>a.rings.flat())])
    assert.ok(point.every(v=>Number.isFinite(v)&&v>=0&&v<=1));
});

test('Bohai ocean geometry excludes Beijing and Jinan land',()=>{
  const result=prepareMapGeography({bounds:broad,context:'明朝'});
  function contains([lon,lat]){
    const point=[(lon-broad.minLon)/(broad.maxLon-broad.minLon),(broad.maxLat-lat)/(broad.maxLat-broad.minLat)];
    return result.waterAreas.filter(a=>a.kind==='ocean').some(a=>a.rings.reduce((inside,ring)=>{
      let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const x=ring[i],y=ring[j];if((x[1]>point[1])!==(y[1]>point[1])&&point[0]<(y[0]-x[0])*(point[1]-x[1])/(y[1]-x[1])+x[0])hit=!hit;
      }return hit?!inside:inside;
    },false));
  }
  assert.equal(contains([119.9,38.7]),true);
  assert.equal(contains([116.4,39.9]),false);
  assert.equal(contains([117.02,36.67]),false);
});

test('Ming narration removes post-1855 lower Yellow River without removing the rest of the drainage network',()=>{
  const modern=prepareMapGeography({bounds:dezhou,year:2026});
  const ming=prepareMapGeography({bounds:dezhou,context:'朱棣从济南撤回北平'});
  assert.equal(modern.decisions.modernLowerYellowRiverOmitted,0);
  assert.ok(ming.decisions.modernLowerYellowRiverOmitted>0);
  assert.ok(modern.waterways.reduce((n,x)=>n+x.points.length,0)>ming.waterways.reduce((n,x)=>n+x.points.length,0));
  assert.ok(ming.waterways.length>5);
  assert.ok(!ming.geographicLabels.some(l=>l.text==='黄河'||l.text==='漳河'));
});

test('Ming northern maps use the sourced old river name and omit modern reservoirs',()=>{
  const result=prepareMapGeography({bounds:beijing,context:'朱棣的燕军'});
  assert.ok(result.geographicLabels.some(l=>l.text==='卢沟河'));
  assert.ok(!result.geographicLabels.some(l=>l.text==='永定河'));
  assert.ok(result.geographicLabels.some(l=>l.text==='军都山'));
  assert.ok(result.decisions.reservoirsOmitted>0);
  assert.ok(!result.waterAreas.some(a=>/水库/.test(a.name||'')));
  assert.equal(result.decisions.modernLowerYellowRiverOmitted,0);
});

test('source-backed geography is deterministic without networking or provider calls',()=>{
  const first=prepareMapGeography({bounds:beijing,year:1400});
  assert.deepEqual(prepareMapGeography({bounds:beijing,year:1400}),first);
  assert.ok(first.sources.every(s=>s.sha256&&s.url&&s.license));
});

test('different historical reach names link to their actual drawn connected river without overwriting one another',()=>{
  const result=prepareMapGeography({bounds:beijing,year:1400});
  const riverLabels=result.geographicLabels.filter(label=>label.kind==='river');
  assert.ok(riverLabels.some(l=>l.text==='卢沟河'));
  assert.ok(riverLabels.some(l=>l.text==='桑干河'));
  for(const label of riverLabels){
    assert.ok(label.waterwayId);
    const river=result.waterways.find(w=>w.id===label.waterwayId);assert.ok(river);
    let nearest=Infinity;
    for(let i=1;i<river.points.length;i++){
      const a=river.points[i-1],b=river.points[i],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((label.x-a[0])*dx+(label.y-a[1])*dy)/(dx*dx+dy*dy||1)));
      nearest=Math.min(nearest,Math.hypot(label.x-a[0]-t*dx,label.y-a[1]-t*dy));
    }
    assert.ok(nearest<1e-6,'label anchor must lie on the supplied waterway');
  }
});

test('episode 1063 coastal-region labels stay inside their source regions and off the ocean',()=>{
  const bounds={minLon:110.9858353833926,maxLon:122.3072596166074,minLat:35.790110199999994,maxLat:40.78853779999999};
  const result=prepareMapGeography({bounds,context:'朱棣'});
  const regions=JSON.parse(fs.readFileSync(new URL('./map-geography-data/regions-east-china.geojson',import.meta.url)));
  function inRing([x,y],ring){
    let crossings=0;
    for(let i=0;i<ring.length-1;i++){
      const [ax,ay]=ring[i],[bx,by]=ring[i+1];
      if((ay>y)!==(by>y)&&x<ax+(bx-ax)*(y-ay)/(by-ay))crossings++;
    }
    return crossings%2===1;
  }
  const inPolygon=(point,rings)=>rings.filter(ring=>inRing(point,ring)).length%2===1;
  const inOcean=point=>result.waterAreas.filter(area=>area.kind==='ocean').some(area=>inPolygon(point,area.rings));
  const terrestrial=result.geographicLabels.filter(label=>label.id.startsWith('region-'));
  for(const text of ['山东半岛','辽东半岛','华北平原'])assert.ok(terrestrial.some(label=>label.text===text));
  for(const label of terrestrial){
    assert.equal(inOcean([label.x,label.y]),false,label.text);
    const source=regions.features.find(feature=>`region-${feature.id}`===label.id);
    const geographicPoint=[bounds.minLon+label.x*(bounds.maxLon-bounds.minLon),bounds.maxLat-label.y*(bounds.maxLat-bounds.minLat)];
    assert.ok(source.geometry.coordinates.some(polygon=>inPolygon(geographicPoint,polygon)),`${label.text} must remain inside its original region`);
  }
  const bohai=result.geographicLabels.find(label=>label.text==='渤海');
  assert.ok(bohai,'marine region names remain available');
  assert.equal(inOcean([bohai.x,bohai.y]),true);
});
