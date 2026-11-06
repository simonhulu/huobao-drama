import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'map-geography-data');
const root = path.resolve(directory, '../../..');
const cached = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1e6) / 1e6;
const pointKey = point => point.map(round).join(',');
const names = {Yangtze:'长江',Huang:'黄河',Fen:'汾河',Hudi:'滹沱河',Huai:'淮河',Sanggan:'桑干河',Yongding:'永定河',Hai:'海河',Luan:'滦河',Qin:'沁河',Zhang:'漳河',Wei:'渭河',Yi:'沂河',Ying:'颍河',Daling:'大凌河'};
const yellowRiver = 40417973; // Native MAIN_RIV; verified at modern lower Yellow River, see historical-notes.json.

function readDataset(filename, optional = false) {
  const file = path.join(directory, filename);
  if (!fs.existsSync(file) && optional) return null;
  const stat = fs.statSync(file), key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (cached.has(key)) return cached.get(key);
  const bytes = fs.readFileSync(file), source = JSON.parse(fs.readFileSync(`${file}.source.json`, 'utf8'));
  if (sha(bytes) !== source.sha256) throw Error(`地图地理缓存校验失败：${filename}`);
  const data = JSON.parse(filename.endsWith('.gz') ? gunzipSync(bytes).toString() : bytes.toString());
  const result = {data,source:{...source,localFile:file,attribution:filename.startsWith('hydrorivers')?'HydroRIVERS © HydroSHEDS; Lehner & Grill (2013)':source.license==='CC0'?'Wikidata (CC0)':'Made with Natural Earth'}};
  cached.set(key,result);
  return result;
}

const inside = ([x,y],b) => x>=b.minLon && x<=b.maxLon && y>=b.minLat && y<=b.maxLat;
const project = ([x,y],b) => [round((x-b.minLon)/(b.maxLon-b.minLon)),round((b.maxLat-y)/(b.maxLat-b.minLat))];
const covers = (extent,b) => extent && b.minLon>=extent[0] && b.maxLon<=extent[2] && b.minLat>=extent[1] && b.maxLat<=extent[3];

export function clipGeographicLine(points,bounds) {
  const lines=[];
  let current;
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1];
    let low=0,high=1,reject=false;
    const ps=[-dx,dx,-dy,dy],qs=[a[0]-bounds.minLon,bounds.maxLon-a[0],a[1]-bounds.minLat,bounds.maxLat-a[1]];
    for(let edge=0;edge<4;edge++) {
      if(ps[edge]===0){if(qs[edge]<0){reject=true;break;}continue;}
      const ratio=qs[edge]/ps[edge];
      if(ps[edge]<0)low=Math.max(low,ratio);else high=Math.min(high,ratio);
      if(low>high){reject=true;break;}
    }
    if(reject){current=undefined;continue;}
    const first=[a[0]+low*dx,a[1]+low*dy],last=[a[0]+high*dx,a[1]+high*dy];
    if(!current || pointKey(current.at(-1))!==pointKey(first)){current=[first,last];lines.push(current);}
    else current.push(last);
  }
  return lines;
}

export function clipGeographicRing(ring,bounds) {
  let points=ring.length && pointKey(ring[0])===pointKey(ring.at(-1))?ring.slice(0,-1):ring;
  for(const [axis,edge,sign] of [[0,bounds.minLon,1],[0,bounds.maxLon,-1],[1,bounds.minLat,1],[1,bounds.maxLat,-1]]) {
    const result=[];
    if(!points.length)break;
    let previous=points.at(-1),wasInside=(previous[axis]-edge)*sign>=0;
    for(const current of points){
      const isInside=(current[axis]-edge)*sign>=0;
      if(isInside!==wasInside){const t=(edge-previous[axis])/(current[axis]-previous[axis]);result.push(previous.map((v,i)=>v+t*(current[i]-v)));}
      if(isInside)result.push(current);
      previous=current;wasInside=isInside;
    }
    points=result;
  }
  return points.length>=3?[...points,points[0]]:[];
}

const signedArea = ring => ring.slice(1).reduce((sum,p,i)=>sum+ring[i][0]*p[1]-p[0]*ring[i][1],0)/2;
const length = (points,width,height) => points.slice(1).reduce((sum,p,i)=>sum+Math.hypot((p[0]-points[i][0])*width,(p[1]-points[i][1])*height),0);
function simplify(points, width, height, tolerance=.55) {
  if(points.length<3)return points;
  const distance=(p,a,b)=>{
    const dx=(b[0]-a[0])*width,dy=(b[1]-a[1])*height;
    const t=Math.max(0,Math.min(1,((p[0]-a[0])*width*dx+(p[1]-a[1])*height*dy)/(dx*dx+dy*dy||1)));
    return Math.hypot((p[0]-a[0])*width-t*dx,(p[1]-a[1])*height-t*dy);
  };
  const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]];
  while(stack.length){const [a,b]=stack.pop();let index=-1,max=tolerance;
    for(let i=a+1;i<b;i++){const value=distance(points[i],points[a],points[b]);if(value>max){max=value;index=i;}}
    if(index>=0){keep.add(index);stack.push([a,index],[index,b]);}
  }
  return [...keep].sort((a,b)=>a-b).map(i=>points[i]);
}

function mergeWaterways(items) {
  const starts=new Map(),ends=new Map(),used=new Set(),result=[];
  const key=(item,point)=>`${item.rank}:${item.basin}:${pointKey(point)}`;
  for(const item of items){
    const a=key(item,item.points[0]),b=key(item,item.points.at(-1));
    starts.set(a,[...(starts.get(a)||[]),item]);ends.set(b,[...(ends.get(b)||[]),item]);
  }
  const predecessor=item=>{const k=key(item,item.points[0]);return ends.get(k)?.length===1&&starts.get(k)?.length===1?ends.get(k)[0]:null;};
  const ordered=[...items.filter(item=>!predecessor(item)),...items];
  for(const initial of ordered){
    if(used.has(initial))continue;
    const points=[...initial.points];let item=initial;used.add(item);
    while(true){const k=key(item,item.points.at(-1));if(starts.get(k)?.length!==1 || ends.get(k)?.length!==1)break;
      const next=starts.get(k)[0];if(used.has(next))break;points.push(...next.points.slice(1));used.add(next);item=next;
    }
    result.push({id:initial.id,rank:initial.rank,points});
  }
  return result;
}

function midpoint(points,width,height) {
  const full=length(points,width,height);let consumed=0;
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],segment=Math.hypot((b[0]-a[0])*width,(b[1]-a[1])*height);
    if(consumed+segment>=full*.5){const t=(full*.5-consumed)/(segment||1);let angle=Math.atan2((b[1]-a[1])*height,(b[0]-a[0])*width)*180/Math.PI;if(angle>90)angle-=180;if(angle< -90)angle+=180;
      return {x:a[0]+(b[0]-a[0])*t,y:a[1]+(b[1]-a[1])*t,angle:Math.max(-65,Math.min(65,angle))};}
    consumed+=segment;
  }
  return {x:points[0][0],y:points[0][1],angle:0};
}

function nearestWaterway(label,waterways,width,height) {
  let nearest;
  for(const way of waterways)for(let i=1;i<way.points.length;i++){
    const a=way.points[i-1],b=way.points[i],dx=(b[0]-a[0])*width,dy=(b[1]-a[1])*height;
    const t=Math.max(0,Math.min(1,((label.x-a[0])*width*dx+(label.y-a[1])*height*dy)/(dx*dx+dy*dy||1)));
    const point=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])],distance=Math.hypot((point[0]-label.x)*width,(point[1]-label.y)*height);
    if(!nearest||distance<nearest.distance)nearest={way,point,distance};
  }
  return nearest;
}

function pointInRing(point,ring) {
  let result=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>point[1])!==(b[1]>point[1]) && point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
  }
  return result;
}

const pointInPolygon = (point,rings) => rings.reduce((inside,ring)=>pointInRing(point,ring)?!inside:inside,false);

function polygonAnchor(ring,accept=()=>true) {
  const xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]),xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  let best=null,bestScore=-1;
  for(let row=1;row<9;row++)for(let col=1;col<9;col++){
    const point=[xmin+(xmax-xmin)*col/9,ymin+(ymax-ymin)*row/9];if(!pointInRing(point,ring)||!accept(point))continue;
    const score=Math.min(...ring.map(p=>Math.hypot(point[0]-p[0],point[1]-p[1])));
    if(score>bestScore){best=point;bestScore=score;}
  }
  return best;
}

function globalNamedRivers() {
  for(const base of ['data/static/changping-demo-v2-20261024/map-source-data','data/storage/static/remotion/map-source-data']) {
    const file=path.join(root,base,'ne_10m_rivers_lake_centerlines.geojson');
    try {
      const bytes=fs.readFileSync(file),source=JSON.parse(fs.readFileSync(`${file}.source.json`,'utf8'));
      if(sha(bytes)!==source.sha256)continue;
      return {data:JSON.parse(bytes),source:{...source,title:'Natural Earth 1:10m rivers',license:'Public Domain',attribution:'Made with Natural Earth'}};
    }catch{}
  }
  return null;
}

export function prepareMapGeography({bounds,width=1920,height=1080,context='',year}={}) {
  if(!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.maxLon<=bounds.minLon || bounds.maxLat<=bounds.minLat)throw Error('地图地理图层需要有效经纬范围');
  const span=bounds.maxLon-bounds.minLon;
  const ming=/明代|明朝|朱棣|靖难|建文|燕军|洪武|永乐/.test(String(context)) || Number.isFinite(year)&&year>=1368&&year<=1644;
  const pre1855=ming || Number.isFinite(year)&&year<1855;
  const hydro=readDataset('hydrorivers-east-china.geojson.gz');
  const regional=covers(hydro.data.bbox,bounds),sources=[],decisions={regionalHydroRivers:regional,mingContext:ming,modernLowerYellowRiverOmitted:0,reservoirsOmitted:0};
  const named=regional?readDataset('named-rivers-east-china.geojson'):globalNamedRivers();
  let waterways=[];
  if(regional){
    const minOrder=span>6?5:span>2?4:3,raw=[];
    for(const feature of hydro.data.features){
      const p=feature.properties;if(p.ORD_STRA<minOrder)continue;
      for(const sourceLine of feature.geometry.coordinates){
        // The modern lower Yellow River's northern route is post-1855. Omit,
        // rather than invent the medieval southern channel from present data.
        let lines=[sourceLine];
        if(pre1855&&p.MAIN_RIV===yellowRiver&&p.ORD_CLAS===1){
          if(sourceLine.some(([lon])=>lon>114.5)&&clipGeographicLine(sourceLine,bounds).length)decisions.modernLowerYellowRiverOmitted++;
          lines=clipGeographicLine(sourceLine,{minLon:-180,maxLon:114.5,minLat:-90,maxLat:90});
        }
        for(const line of lines)for(const clipped of clipGeographicLine(line,bounds)){
          const points=clipped.map(point=>project(point,bounds));if(length(points,width,height)<2)continue;
          raw.push({id:`hydro-${p.HYRIV_ID}-${raw.length}`,basin:p.MAIN_RIV,rank:p.ORD_STRA>=7?1:p.ORD_STRA>=5?2:3,points});
        }
      }
    }
    waterways=mergeWaterways(raw).map(item=>({...item,points:simplify(item.points,width,height)}));
    sources.push(hydro.source);
  }
  const geographicLabels=[],labelCandidates=[];
  for(const feature of named?.data.features || []){
    const p=feature.properties,rawName=p.name || p.NAME;
    let text=names[rawName] || p.name_zh || p.NAME_ZH;
    if(!text || pre1855&&rawName==='Huang')continue;
    if(ming&&rawName==='Yongding')text='卢沟河';
    const lines=feature.geometry.type==='MultiLineString'?feature.geometry.coordinates:[feature.geometry.coordinates];
    // Natural Earth's generalized river records can continue into differently
    // named downstream channels. Only label the documented named section.
    const nameBounds=rawName==='Zhang'?{...bounds,maxLon:Math.min(bounds.maxLon,115.4)}:rawName==='Hai'?{...bounds,minLon:Math.max(bounds.minLon,117.1)}:bounds;
    if(nameBounds.maxLon<=nameBounds.minLon)continue;
    for(const line of lines)for(const clipped of clipGeographicLine(line,nameBounds)){
      const points=clipped.map(point=>project(point,bounds)),pixels=length(points,width,height);
      if(!regional)waterways.push({id:`ne-${p.rivernum}-${waterways.length}`,name:text,rank:p.scalerank<=4?1:p.scalerank<=7?2:3,points:simplify(points,width,height)});
      if(pixels>90)labelCandidates.push({id:`river-${p.rivernum}`,text,kind:'river',...midpoint(points,width,height),pixels,priority:55});
    }
  }
  const seenNames=new Set();
  for(const label of labelCandidates.sort((a,b)=>b.pixels-a.pixels)){
    if(seenNames.has(label.text)||label.x<.04||label.x>.96||label.y<.10||label.y>.89)continue;
    const backbones=waterways.filter(w=>w.rank<3),nearby=nearestWaterway(label,backbones.length?backbones:waterways,width,height);
    if(!nearby||nearby.distance>=80)continue;
    label.x=nearby.point[0];label.y=nearby.point[1];label.waterwayId=nearby.way.id;
    const {pixels,...visible}=label;geographicLabels.push(visible);seenNames.add(label.text);
    if(seenNames.size>=7)break;
  }
  if(named&&(geographicLabels.length||!regional&&waterways.length))sources.push(named.source);
  const waterAreas=[];
  for(const kind of ['ocean','lakes']){
    const pack=readDataset(`${kind}-east-china.geojson`);
    if(!covers(pack.data.bbox,bounds))continue;
    let used=false;
    for(const feature of pack.data.features){
      const p=feature.properties;
      if(kind==='lakes' && (p.featurecla==='Reservoir'||!/\S/.test(p.name_zh||''))){
        if(p.featurecla==='Reservoir'&&feature.geometry.coordinates.some(polygon=>clipGeographicRing(polygon[0],bounds).length))decisions.reservoirsOmitted++;
        continue;
      }
      for(const [index,polygon] of feature.geometry.coordinates.entries()){
        const outer=clipGeographicRing(polygon[0],bounds);if(!outer.length)continue;
        const projected=outer.map(point=>project(point,bounds));
        if(Math.abs(signedArea(projected))*width*height<(kind==='ocean'?20:160))continue;
        const rings=[projected,...polygon.slice(1).map(ring=>clipGeographicRing(ring,bounds)).filter(ring=>ring.length).map(ring=>ring.map(point=>project(point,bounds)))].map(ring=>simplify(ring,width,height,.4));
        waterAreas.push({id:`${kind}-${feature.id}-${index}`,kind:kind==='ocean'?'ocean':'lake',...(p.name_zh?{name:p.name_zh}:{}),rings});used=true;
        if(kind==='lakes'){
          const anchor=polygonAnchor(projected);
          if(anchor)geographicLabels.push({id:`lake-${feature.id}`,text:p.name_zh,kind:'lake',x:anchor[0],y:anchor[1],priority:35});
        }
      }
    }
    if(used)sources.push(pack.source);
  }
  const regions=readDataset('regions-east-china.geojson');
  const oceans=waterAreas.filter(area=>area.kind==='ocean');
  let usedRegions=false;
  for(const feature of regions.data.features){
    const p=feature.properties,mountain=p.FEATURECLA==='Range/mtn';
    if(!p.NAME_ZH || !mountain && (!['Plain','Plateau','Pen/cape'].includes(p.FEATURECLA)||span<4))continue;
    const candidates=feature.geometry.coordinates.map(polygon=>{
      const outer=clipGeographicRing(polygon[0],bounds);if(!outer.length)return null;
      return [outer,...polygon.slice(1).map(ring=>clipGeographicRing(ring,bounds)).filter(ring=>ring.length)].map(ring=>ring.map(point=>project(point,bounds)));
    }).filter(Boolean).sort((a,b)=>Math.abs(signedArea(b[0]))-Math.abs(signedArea(a[0])));
    // Generalized region outlines may extend across the shoreline. Terrestrial
    // labels need a source-polygon anchor on actual land, including ocean holes.
    let anchor;
    for(const rings of candidates){
      if(Math.abs(signedArea(rings[0]))<.012)continue;
      anchor=polygonAnchor(rings[0],point=>pointInPolygon(point,rings)&&!oceans.some(area=>pointInPolygon(point,area.rings)));
      if(anchor)break;
    }
    if(!anchor)continue;
    geographicLabels.push({id:`region-${feature.id}`,text:p.NAME_ZH,kind:mountain?'mountain':'region',x:anchor[0],y:anchor[1],angle:mountain?-55:0,priority:mountain?60:20});usedRegions=true;
  }
  if(usedRegions)sources.push(regions.source);
  const landmarks=readDataset('landmarks-east-china.geojson',true);
  let usedLandmarks=false;
  for(const feature of landmarks?.data.features||[]){
    if(!inside(feature.geometry.coordinates,bounds))continue;
    const p=feature.properties,[x,y]=project(feature.geometry.coordinates,bounds);
    if(p.kind==='mountain'&&span>4)continue;
    geographicLabels.push({id:feature.id,text:p.name,kind:p.kind,x,y,angle:p.angle||0,priority:p.kind==='mountain'?65:25});usedLandmarks=true;
  }
  if(usedLandmarks)sources.push(landmarks.source);
  if(ming || decisions.modernLowerYellowRiverOmitted){
    const filename=path.join(directory,'historical-notes.json'),bytes=fs.readFileSync(filename),notes=JSON.parse(bytes);
    for(const note of notes.references.filter(note=>note.id==='yellow-river-1855'?decisions.modernLowerYellowRiverOmitted:ming))
      sources.push({...note,title:note.title,url:note.url,license:'Factual reference; no source artwork reproduced',sha256:sha(bytes),localFile:filename,attribution:note.publisher});
  }
  // Long rivers are split, preserving every retained vertex and the shared end.
  waterways=waterways.flatMap(item=>{
    const segments=[];for(let start=0;start<item.points.length-1;start+=2047)segments.push({...item,id:`${item.id}-${start}`,points:item.points.slice(start,start+2048)});return segments;
  });
  for(const label of geographicLabels.filter(label=>label.waterwayId)){
    const segments=waterways.filter(way=>way.id.startsWith(`${label.waterwayId}-`));
    const match=nearestWaterway(label,segments,width,height);
    if(match)label.waterwayId=match.way.id;
    else delete label.waterwayId;
  }
  const historicalLimit='Modern terrain, coast and river-network geometry provide geographic context; no reconstructed ancient river channels, exact historical coastlines or territorial boundaries. Historical names/known modern mismatches are handled only where explicitly documented.';
  return {waterways,waterAreas,geographicLabels:geographicLabels.slice(0,80),sources,decisions,historicalLimit};
}
