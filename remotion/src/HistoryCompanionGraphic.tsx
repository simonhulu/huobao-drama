import React from 'react';
import type {HistoryMotionGraphic} from './HistoryMotionFactory';

// Timing adapted from video-shotcraft's DiagramCascadeBuild (Apache-2.0):
// connections lead their nodes by 8 frames; completed information stays still.
// Historical facts and relationships come only from the supplied graphic.
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
const out=(n:number)=>1-(1-clamp(n))**3;
const gold='#eebc89',ink='#fff8e7',muted='#e0e4dd';
// One em per character deliberately overestimates Latin text as well as CJK.
// Include values, explicit newlines and the title when reserving reading space.
const textHeight=(text:string,width:number,size:number,lineHeight:number)=>text.split('\n')
  .reduce((lines,line)=>lines+Math.max(1,Math.ceil([...line].length/Math.max(1,Math.floor(width/size)))),0)*size*lineHeight;

export function companionPageSize(graphic:HistoryMotionGraphic,width:number,height:number) {
  const layout=companionGraphicLayout(graphic.kind,width,height),inner=layout.width-60;
  const vertical=layout.portrait || graphic.kind==='timeline';
  const budget=layout.height-56-textHeight(graphic.title,inner-46,40,1.25)-28-27;
  const maximum=graphic.kind==='quote'?1:graphic.kind==='comparison'?2:graphic.kind==='timeline'?6:layout.portrait?2:3;
  for(let count=Math.min(maximum,graphic.items.length);count>1;count--) {
    const itemWidth=(vertical?inner:(inner-(count-1)*(graphic.kind==='comparison'?24:34))/count)
      -(graphic.kind==='timeline'?46:graphic.kind==='comparison'?44:0);
    const heights=graphic.items.map(item=>textHeight(item.label,itemWidth,38,1.3)
      +(item.value?textHeight(item.value,itemWidth,44,1.15)+10:0)
      +(item.detail?textHeight(item.detail,itemWidth,32,1.4)+12:0)
      +(graphic.kind==='comparison'?43:0));
    const needed=vertical?heights.sort((a,b)=>b-a).slice(0,count).reduce((sum,h)=>sum+h,0)+(count-1)*(graphic.kind==='comparison'?24:26):Math.max(...heights);
    if(needed<=budget)return count;
  }
  return 1;
}

export function companionGraphicLayout(kind:HistoryMotionGraphic['kind'],width:number,height:number) {
  const portrait=width<height;
  const fraction=kind==='timeline'?.48:kind==='quote'?.50:kind==='comparison'?.68:.74;
  return {portrait,x:width*.055,y:height*.085,width:width*(portrait?.88:fraction),height:height*(portrait?.60:.64)};
}

export function companionReveal(frame:number,frames:number,index:number,count:number) {
  const available=Math.max(1,Math.min(frames*.6,frames-Math.min(30,frames*.35)));
  const fade=Math.min(14,available/(count+1)),lead=Math.min(8,fade);
  const gap=count>1?Math.max(0,Math.min(20,(available-fade*1.45-lead)/(count-1))):0;
  const start=lead+index*gap;
  return {connector:out((frame-start+lead)/Math.max(1,16)),enter:out((frame-start)/Math.max(1,fade)),
    detail:out((frame-start-fade*.45)/Math.max(1,fade))};
}

export function HistoryCompanionGraphic({graphic,frame,frames,width,height}: {
  graphic:HistoryMotionGraphic;frame:number;frames:number;width:number;height:number;
}) {
  const layout=companionGraphicLayout(graphic.kind,width,height);
  const pageSize=companionPageSize(graphic,width,height);
  const pages=Math.ceil(graphic.items.length/pageSize),page=Math.min(pages-1,Math.floor(frame*pages/frames));
  const start=Math.ceil(page*frames/pages),end=Math.ceil((page+1)*frames/pages);
  const items=graphic.items.slice(page*pageSize,(page+1)*pageSize);
  const local=frame-start,pageFrames=end-start,vertical=layout.portrait || graphic.kind==='timeline';
  const denseQuote=graphic.kind==='quote' && (graphic.title.length>26 || items.some(item=>item.label.length>26 || (item.detail?.length || 0)>60 || (item.value?.length || 0)>16));
  const text=(item:HistoryMotionGraphic['items'][number],detail:number)=> <>
    {item.value?<div style={{fontSize:44,lineHeight:1.15,color:gold,marginBottom:10,fontWeight:600}}>{item.value}</div>:null}
    <div style={{fontSize:graphic.kind==='quote'?44:38,lineHeight:1.3,fontWeight:600}}>{item.label}</div>
    {item.detail?<div style={{fontSize:32,lineHeight:1.4,marginTop:denseQuote?8:12,color:muted,opacity:detail}}>{item.detail}</div>:null}
  </>;
  return <div data-companion-graphic={graphic.kind} data-explanation={graphic.kind} style={{position:'absolute',left:layout.x,top:layout.y,
    width:layout.width,maxHeight:layout.height,boxSizing:'border-box',padding:'26px 30px 30px',fontFamily:'HistoryMotionWenKai',
    color:ink,opacity:out(local/8),textShadow:'0 2px 5px #000',overflowWrap:'anywhere',
    background:'linear-gradient(105deg,rgba(12,18,17,.88),rgba(12,18,17,.68))',borderTop:`3px solid ${gold}`}}>
    <div style={{fontSize:40,lineHeight:1.25,fontWeight:600,marginBottom:denseQuote?16:28,display:'flex',alignItems:'center',gap:18}}>
      <span style={{display:'block',width:28,height:3,background:gold,flexShrink:0}}/>{graphic.title}
    </div>
    {graphic.kind==='quote'?<div style={{paddingLeft:24,borderLeft:`3px solid ${gold}`}}>
      {text(items[0],companionReveal(local,pageFrames,0,1).detail)}
    </div>:<div style={{display:'flex',flexDirection:vertical?'column':'row',gap:graphic.kind==='comparison'?24:0,alignItems:'stretch'}}>
      {items.map((item,index)=>{
        const state=companionReveal(local,pageFrames,index,items.length);
        const connected=['timeline','relationship'].includes(graphic.kind);
        return <React.Fragment key={`${page}-${index}`}>
          {index>0 && connected?<div aria-hidden style={{flexShrink:0,position:'relative',
            width:vertical?32:34,height:vertical?26:undefined,alignSelf:vertical?'auto':'center',marginLeft:vertical?14:0}}>
            <div style={{background:gold,width:vertical?2:34,height:vertical?26:2,transformOrigin:vertical?'top':'left',
              transform:vertical?`scaleY(${state.connector})`:`scaleX(${state.connector})`}}/>
          </div>:null}
          <div style={{flex:vertical?'0 0 auto':1,minWidth:0,display:'flex',gap:18,opacity:state.enter,
            transform:`translateY(${(1-state.enter)*10}px)`,
            ...(graphic.kind==='comparison'?{padding:'20px 22px',background:index===0?'rgba(238,188,137,.13)':'rgba(211,229,222,.10)',
              borderBottom:`3px solid ${index===0?gold:'#b6cfc5'}`}:{})}}>
            {graphic.kind==='timeline'?<span aria-hidden style={{marginTop:9,width:28,height:28,border:`2px solid ${gold}`,borderRadius:'50%',
              background:index===items.length-1?gold:'transparent',flexShrink:0,boxSizing:'border-box'}}/>:null}
            <div style={{minWidth:0,flex:1}}>{text(item,state.detail)}</div>
          </div>
        </React.Fragment>;
      })}
    </div>}
    {pages>1?<div aria-hidden style={{display:'flex',gap:8,marginTop:24}}>{Array.from({length:pages},(_,i)=>
      <span key={i} style={{width:i===page?26:8,height:3,background:i===page?gold:'rgba(238,188,137,.3)'}}/>)}</div>:null}
  </div>;
}
