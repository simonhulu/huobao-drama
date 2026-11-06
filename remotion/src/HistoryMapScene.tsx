import React, {useMemo} from 'react';
import {AbsoluteFill, Img, staticFile, useVideoConfig} from 'remotion';
import {referenceRoutePoint} from './reference-editorial-core';
import {HistoryMapFlag, HistoryMapForces} from './HistoryMapForces';
import {mapCityControlAt, type HistoryMapForce} from './history-map-forces';
import {atlasLabelAt, atlasWaterwayPath, layoutAtlasLabels, type MapGeographicLabel, type MapWaterway, type MapWaterArea} from './history-map-labels';

export type HistoryMotionMap = {
  enabled: boolean; backgroundSrc: string; width: number; height: number; title?: string;
  provenance: {verified: boolean; source: string; license: string; projection: string; historyStatus: 'illustrative' | 'sourced'; attribution: string;
    bounds?: {minLon:number;maxLon:number;minLat:number;maxLat:number}};
  territories?: {name: string; points: [number, number][]; initialPoints?: [number, number][]; color: string; from?: number; to?: number}[];
  cities?: {name: string; x: number; y: number; role?:'primary'|'context'; kind?:'capital'|'city'|'pass'|'battlefield'; color?: string; highlightStart?: number; highlightDuration?: number}[];
  cartography?: {version: 1; style: 'relief-atlas'};
  geographicLabels?: MapGeographicLabel[];
  waterways?: MapWaterway[];
  waterAreas?: MapWaterArea[];
  routes?: {name?: string; points: [number, number][]; color: string; start?: number; end?: number}[];
  forces?: HistoryMapForce[];
  camera?:{keyframes:{t:number;focusX:number;focusY:number;zoom:number}[]};
  stages?:{start:number;end:number;label:string}[];
  legend?:{label:string;color:string;kind?:'line'|'area'|'point'}[];
  encirclement?:{center:[number,number];radiusX:number;radiusY:number;start:number;end:number;compressionStart?:number;compressionEnd?:number;innerScale?:number;color:string;fillColor:string;label:string};
};
const clamp=(n:number)=>Math.min(1,Math.max(0,n));
const smooth=(n:number)=>{const t=clamp(n);return t*t*(3-2*t)};
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
export function mapCameraAt(map:HistoryMotionMap,seconds:number){
  const keys=map.camera?.keyframes;
  if(!keys?.length)return {focusX:.5,focusY:.5,zoom:1};
  let index=keys.findIndex(k=>k.t>=seconds);
  if(index<0)return keys[keys.length-1];
  if(index===0)return keys[0];
  const a=keys[index-1],b=keys[index],t=smooth((seconds-a.t)/(b.t-a.t));
  return {focusX:mix(a.focusX,b.focusX,t),focusY:mix(a.focusY,b.focusY,t),zoom:mix(a.zoom,b.zoom,t)};
}
export function containedMapCamera(camera:{focusX:number;focusY:number;zoom:number}){
  const halfViewport=.5/camera.zoom;
  const keepInside=(focus:number)=>Math.max(halfViewport,Math.min(1-halfViewport,focus));
  return {...camera,focusX:keepInside(camera.focusX),focusY:keepInside(camera.focusY)};
}
export function encirclementState(layer:NonNullable<HistoryMotionMap['encirclement']>,seconds:number){
  const build=smooth((seconds-layer.start)/(layer.end-layer.start));
  const compression=layer.compressionStart===undefined?0:smooth((seconds-layer.compressionStart)/((layer.compressionEnd??layer.compressionStart+1)-layer.compressionStart));
  return {build,compression,scale:mix(1,layer.innerScale??.65,compression)};
}
function ellipsePoint(cx:number,cy:number,rx:number,ry:number,a:number){return {x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry}}
function arc(cx:number,cy:number,rx:number,ry:number,a:number,b:number){
  const first=ellipsePoint(cx,cy,rx,ry,a),last=ellipsePoint(cx,cy,rx,ry,b);
  return `M ${first.x} ${first.y} A ${rx} ${ry} 0 ${b-a>Math.PI?1:0} 1 ${last.x} ${last.y}`;
}
export function HistoryMapScene({map,seconds,duration}:{map:HistoryMotionMap;seconds:number;duration:number}){
  const output=useVideoConfig(),{width,height}=map;
  const portrait=output.width<output.height;
  const atlas=map.cartography?.style==='relief-atlas';
  const atlasLabels=useMemo(()=>atlas?layoutAtlasLabels(map,{width:output.width,height:output.height}):[],[atlas,map,output.width,output.height]);
  const fit=Math.min(output.width/width,output.height/height),unit=1/fit;
  const camera=containedMapCamera(mapCameraAt(map,seconds)),u=unit/camera.zoom;
  const cameraTransform=`translate(${width/2} ${height/2}) scale(${camera.zoom}) translate(${-camera.focusX*width} ${-camera.focusY*height})`;
  const stageIndex=map.stages?.findIndex(s=>seconds>=s.start&&seconds<s.end)??-1;
  const stage=stageIndex>=0?map.stages?.[stageIndex]:undefined;
  const enclosure=map.encirclement,encState=enclosure?encirclementState(enclosure,seconds):null;
  const bounds=map.provenance.bounds;
  const horizontalKm=bounds?(bounds.maxLon-bounds.minLon)*111.32*Math.cos((bounds.minLat+bounds.maxLat)/2*Math.PI/180):null;
  const scaleKm=horizontalKm?Math.pow(10,Math.floor(Math.log10(horizontalKm/7)))*([1,2,5].reverse().find(n=>n*Math.pow(10,Math.floor(Math.log10(horizontalKm/7)))<=horizontalKm/7)??1):null;
  return <AbsoluteFill style={{background:'#eeeade',overflow:'hidden',fontFamily:'HistoryMotionWenKai',color:'#24332c'}}>
    <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{position:'absolute',inset:0}}>
      <g transform={cameraTransform}>
        <foreignObject width={width} height={height}><Img src={staticFile(map.backgroundSrc)} style={{width:'100%',height:'100%'}}/></foreignObject>
        {atlas?map.waterAreas?.map(area=>{
          const d=area.rings.map(ring=>ring.map(([x,y],index)=>`${index?'L':'M'}${x*width} ${y*height}`).join(' ')+'Z').join(' ');
          return <path key={area.id} d={d} fill={area.kind==='ocean'?'#c4d9df':'#a9cbd7'} fillRule="evenodd" stroke={area.kind==='ocean'?'#8aaeb9':'#78a5b6'} strokeWidth={1.3*u} strokeLinejoin="round" opacity={.96}/>;
        }):null}
        {atlas?map.waterways?.map(waterway=>{
          const rank=Math.max(1,Math.min(3,waterway.rank??2));
          const d=atlasWaterwayPath(waterway.points,width,height,u);
          const strokeWidth=rank===1?3.8:rank===2?2.2:1.1;
          return <g key={waterway.id} data-map-waterway={waterway.id}>
            {rank===1?<path d={d} fill="none" stroke="#e6eff0" strokeWidth={(strokeWidth+2.6)*u} strokeLinecap="round" strokeLinejoin="round" opacity={.75}/>:null}
            <path d={d} fill="none" stroke={rank===1?'#397b93':'#5f91a0'} strokeWidth={strokeWidth*u} strokeLinecap="round" strokeLinejoin="round" opacity={rank===1?.9:rank===2?.67:.4}/>
          </g>;
        }):null}
        {map.territories?.map((territory,index)=>{
          const t=smooth((seconds-(territory.from??0))/Math.max(.001,(territory.to??Math.min(1,duration))-(territory.from??0)));
          const points=territory.points.map(([x,y],i)=>{const a=territory.initialPoints?.[i]??[x,y];return `${mix(a[0],x,t)*width},${mix(a[1],y,t)*height}`}).join(' ');
          return <polygon key={index} points={points} fill={territory.color} fillOpacity={.25} stroke={territory.color} strokeWidth={3*u} strokeDasharray={map.provenance.historyStatus==='illustrative'?`${8*u} ${6*u}`:undefined}/>;
        })}
        {enclosure&&encState?(()=>{
          const cx=enclosure.center[0]*width,cy=enclosure.center[1]*height,rx=enclosure.radiusX*width,ry=enclosure.radiusY*height;
          return <g data-map-action="encirclement">
            <ellipse cx={cx} cy={cy} rx={rx*.79*encState.scale} ry={ry*.79*encState.scale} fill={enclosure.fillColor} opacity={.22*encState.build}/>
            <ellipse cx={cx} cy={cy} rx={rx*.79*encState.scale} ry={ry*.79*encState.scale} fill="none" stroke={enclosure.fillColor} strokeWidth={3*u} strokeDasharray={`${7*u} ${8*u}`} opacity={encState.build*.8}/>
            {Array.from({length:6},(_,i)=>{
              const start=-Math.PI/2+i*Math.PI/3+.04,end=start+Math.PI/3-.13;
              const p=smooth((encState.build-i*.07)/.62),r=1-.22*encState.compression;
              const a=mix(start,end,p),head=ellipsePoint(cx,cy,rx*r,ry*r,a);
              const angle=Math.atan2(ry*Math.cos(a),-rx*Math.sin(a))*180/Math.PI;
              return <g key={i}>
                <path d={arc(cx,cy,rx,ry,start,end)} fill="none" stroke={enclosure.color} strokeWidth={2*u} strokeDasharray={`${5*u} ${8*u}`} opacity={.18}/>
                {p>0?<>
                  <path d={arc(cx,cy,rx*r,ry*r,start,a)} fill="none" stroke="#fff9e9" strokeWidth={12*u} opacity={.9}/>
                  <path d={arc(cx,cy,rx*r,ry*r,start,a)} fill="none" stroke={enclosure.color} strokeWidth={7*u} strokeLinecap="round"/>
                  <path d="M15 0 L-12 -9 L-6 0 L-12 9Z" fill={enclosure.color} stroke="#fff9e9" strokeWidth={1.5} transform={`translate(${head.x} ${head.y}) rotate(${angle}) scale(${u})`}/>
                </>:null}
                {encState.compression>0?(()=>{
                  const outer=ellipsePoint(cx,cy,rx*.93,ry*.93,start+.4),inner=ellipsePoint(cx,cy,rx*(.93-.38*encState.compression),ry*(.93-.38*encState.compression),start+.4);
                  return <g opacity={encState.compression}><path d={`M${outer.x} ${outer.y} L${inner.x} ${inner.y}`} stroke={enclosure.color} strokeWidth={4*u}/><path d="M13 0 L-10 -7 L-5 0 L-10 7Z" fill={enclosure.color} transform={`translate(${inner.x} ${inner.y}) rotate(${Math.atan2(inner.y-outer.y,inner.x-outer.x)*180/Math.PI}) scale(${u})`}/></g>;
                })():null}
              </g>;
            })}
          </g>;
        })():null}
        {map.routes?.map((route,index)=>{
          const p=smooth((seconds-(route.start??0))/Math.max(.001,(route.end??Math.min(1,duration))-(route.start??0)));
          const head=referenceRoutePoint(route.points,p,width,height),d=route.points.map(([x,y],i)=>`${i?'L':'M'}${x*width} ${y*height}`).join(' ');
          return <g key={index}>
            <path d={d} fill="none" stroke={route.color} strokeWidth={2*u} strokeDasharray={`${6*u} ${8*u}`} opacity={.25}/>
            <path d={d} fill="none" stroke="#fff9e8" strokeWidth={12*u} pathLength={1} strokeDasharray={1} strokeDashoffset={1-p}/>
            <path d={d} fill="none" stroke={route.color} strokeWidth={7*u} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1-p}/>
            {p>0?<path d="M15 0 L-12 -9 L-6 0 L-12 9Z" fill={route.color} stroke="#fff9e9" strokeWidth={1.5} transform={`translate(${head.x} ${head.y}) rotate(${head.angle}) scale(${u})`}/>:null}
          </g>;
        })}
        {map.cities?.map(city=>{
          const primary=city.role!=='context',entry=smooth(seconds/(primary ? .65 : 1.15)),x=city.x*width,y=city.y*height;
          const active=city.highlightStart!==undefined?clamp((seconds-city.highlightStart)/(city.highlightDuration??1.2)):1;
          const owner=mapCityControlAt(map,city.name,seconds),color=owner?.color||city.color||'#344d42';
          const occupation=owner?clamp((seconds-owner.end)/.85):1;
          return <g key={city.name} transform={`translate(${x} ${y}) scale(${u})`} opacity={entry}>
            {primary&&active>0&&active<1?<circle r={14+45*active} fill="none" stroke={city.color||'#ad4e3e'} strokeWidth={3} opacity={1-active}/>:null}
            {owner&&occupation<1?<circle r={17+32*occupation} fill="none" stroke={color} strokeWidth={3} opacity={1-occupation}/>:null}
            {owner?<circle r={primary?19:13} fill={color} opacity={.17}/>:null}
            {atlas?<>
              {primary?<circle r={city.kind==='capital'?14:11} fill="#faf4e6" stroke={color} strokeWidth={2}/>:null}
              {city.kind==='pass'?<path d="M-6 -6 V6 M6 -6 V6 M-6 -6 H6 M-6 6 H6" stroke={color} strokeWidth={3} fill="none"/>:
                city.kind==='battlefield'?<path d="M-6 -6 L6 6 M-6 6 L6 -6" stroke={color} strokeWidth={3} strokeLinecap="round"/>:
                <circle r={primary?5.5:3.7} fill={color} stroke="#fff8e8" strokeWidth={primary?1:1.7}/>}
              {city.kind==='capital'?<circle r={17} fill="none" stroke={color} strokeWidth={1.2} opacity={.65}/>:null}
            </>:<>
              <circle r={primary?10:5} fill={color} stroke="#fff8e8" strokeWidth={primary?4:2}/>
              <text x={primary?20:13} y={primary?-16:-12} textAnchor={city.x>.87?'end':'start'} fontSize={primary?42:27} fontWeight={primary?700:500} fill={owner?.color||city.color||'#253d32'} stroke="#fbf7e9" strokeWidth={primary?9:7} paintOrder="stroke">{city.name}</text>
            </>}
            {owner?<g transform={`translate(-28 ${-12-12*smooth(occupation/.4)}) scale(.68)`} opacity={smooth(occupation/.3)}><HistoryMapFlag text={owner.flagText} color={owner.color} seconds={seconds} planted/></g>:null}
            {primary&&enclosure&&!atlas?<text y={38} textAnchor="middle" fontSize={24} fill="#364b40" stroke="#fbf7e9" strokeWidth={6} paintOrder="stroke">中心地区</text>:null}
          </g>;
        })}
      </g>
    </svg>
    <HistoryMapForces map={map} seconds={seconds} camera={camera} width={output.width} height={output.height}/>
    {atlas?<svg width="100%" height="100%" viewBox={`0 0 ${output.width} ${output.height}`} style={{position:'absolute',inset:0,pointerEvents:'none'}} aria-label="山川与城池标注">
      {atlasLabels.filter(label=>!label.hidden).map(label=>{
        const {anchor,center,box}=atlasLabelAt(label,map,camera,output);
        const city=label.kind==='city'?map.cities?.find(item=>item.name===label.text):undefined;
        const owner=city?mapCityControlAt(map,city.name,seconds):undefined;
        const water=label.kind==='river'||label.kind==='lake';
        const color=city?(owner?.color||city.color||'#263d35'):water?'#366f84':label.kind==='mountain'?'#675a40':'#65715c';
        const target={x:Math.max(box.x,Math.min(box.x+box.width,anchor.x)),y:Math.max(box.y,Math.min(box.y+box.height,anchor.y))};
        const leader=city&&Math.hypot(target.x-anchor.x,target.y-anchor.y)>24;
        return <g key={label.id} opacity={smooth(seconds/(label.primary?.55:1))} data-map-label={label.id}>
          {leader?<>
            <path d={`M${anchor.x} ${anchor.y} L${target.x} ${target.y}`} stroke="#fbf6e8" strokeWidth={4.5}/>
            <path d={`M${anchor.x} ${anchor.y} L${target.x} ${target.y}`} stroke={color} strokeWidth={1.3} opacity={.75}/>
          </>:null}
          <text x={center.x} y={center.y} dominantBaseline="central" textAnchor="middle"
            transform={label.angle?`rotate(${label.angle} ${center.x} ${center.y})`:undefined}
            fontSize={label.fontSize} letterSpacing={label.letterSpacing} fontWeight={label.primary?700:label.kind==='city'?600:500}
            fill={color} stroke="#faf5e6" strokeWidth={label.primary?5:4} strokeLinejoin="round" paintOrder="stroke" opacity={label.kind==='region'?.74:label.kind==='mountain'?.87:1}>
            {label.text}
          </text>
        </g>;
      })}
    </svg>:null}
    <div style={{position:'absolute',left:'4%',top:'4%',maxWidth:portrait?'86%':'63%',padding:atlas?'10px 16px':'12px 20px',borderLeft:atlas?'3px solid #8f573b':'5px solid #a84d3a',background:atlas?'rgba(250,246,234,.90)':'rgba(249,246,232,.93)',boxShadow:atlas?'0 2px 10px rgba(45,47,33,.07)':undefined}}>
      <div style={{fontSize:atlas?36:portrait?40:42,lineHeight:1.2,fontWeight:600,letterSpacing:atlas?1:0}}>{map.title}</div>
    </div>
    <div style={{position:'absolute',left:'4%',right:'4%',bottom:'18%',display:'flex',gap:28,alignItems:'flex-end',justifyContent:'space-between'}}>
      {stage?<div style={{background:atlas?'rgba(250,246,234,.90)':'rgba(249,246,232,.94)',borderLeft:atlas?'3px solid #365b7b':'4px solid #365b7b',padding:atlas?'10px 16px':'13px 18px',fontSize:atlas?27:30,maxWidth:portrait?'80%':'55%'}}>
        {atlas?null:<span style={{fontSize:20,color:'#6c7569',marginRight:16}}>{String(stageIndex+1).padStart(2,'0')}</span>}{stage.label}
        {atlas?null:<div style={{height:3,background:'#d4d8ca',marginTop:10}}><div style={{height:3,background:'#365b7b',width:`${clamp(seconds/duration)*100}%`}}/></div>}
      </div>:null}
      {!portrait&&map.legend?.length?<div style={{display:'flex',flexDirection:atlas?'row':'column',gap:atlas?24:9,padding:atlas?'10px 16px':'13px 17px',background:'rgba(249,246,232,.9)',fontSize:atlas?21:23}}>{map.legend.map(item=><div key={item.label} style={{display:'flex',gap:12,alignItems:'center'}}><span style={{display:'block',width:atlas?17:24,height:item.kind==='line'?4:atlas?9:12,background:item.color,opacity:item.kind==='area'?.5:1,borderRadius:item.kind==='point'?10:0}}/>{item.label}</div>)}</div>:null}
    </div>
    {horizontalKm&&scaleKm?<div style={{position:'absolute',right:'4%',bottom:'13%',fontSize:17,color:'#45594b',textAlign:'center'}}><div style={{width:scaleKm/horizontalKm*width*fit*camera.zoom,borderBottom:'2px solid #45594b',borderLeft:'2px solid #45594b',borderRight:'2px solid #45594b',height:6}}/>{scaleKm} km</div>:null}
    <div style={{position:'absolute',right:'4%',top:'14%',fontSize:22,color:'#45594b',textAlign:'center'}}>N<br/>↑</div>
  </AbsoluteFill>;
}
