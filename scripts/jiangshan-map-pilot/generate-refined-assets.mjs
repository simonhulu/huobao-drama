#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=path.join(root,'outputs/jiangshan-map-refined-20261102/assets');
const require=createRequire(path.join(root,'backend/package.json'));
const sharp=require('sharp');
const sha256=data=>createHash('sha256').update(data).digest('hex');
const shared='制作一个精致的中国古代历史策略游戏素材，专业手绘半写实插画，精细有体积的明暗与金属甲片，克制的中国矿物颜料配色，轮廓清晰、适合缩小到地图图标，真实人体比例，绝非Q版、扁平卡通、emoji或摄影。不要文字、字母、印章、水印、UI、装饰边框、地图、场景。统一柔和左上方暖光，右侧柔和阴影。';
const specs=[
 {id:'portrait-guo',kind:'portrait',character:'郭子仪',prompt:shared+'人物是唐代郭子仪的示意立绘，并非精确肖像复原。约55岁沉稳威严的中国男性，方正脸、浓眉、稍长的整齐黑须带少量灰白，眼神坚定。深铁色唐代武将兜鍪，两侧护颊，顶部低矮朱红缨，深金属色明光甲与朱红披风，甲片和皮革带有精致细节但不堆满夸张黄金装饰。仅一个人物正面略侧身胸像，整个头盔、头顶、肩甲完整不截断，主体居中放在画面中央正方形内，头脸占中央正方形上部约一半，四周充分留白避免圆形头像裁切切到头。背景为纯净平整深暖灰，无风景无道具。'},
 {id:'portrait-li',kind:'portrait',character:'李光弼',prompt:shared+'人物是唐代李光弼的示意立绘，并非精确肖像复原。约50岁英武冷静的中国男性，修长而棱角分明的脸、高颧骨、浓眉、短而整齐的山羊胡及短上唇须，脸型明显不同于方脸长须郭子仪。铁灰色唐代武将兜鍪，银灰护颊与低矮青蓝缨，深蓝灰唐代甲胄、少量古铜扣件与青蓝披风，甲片和皮革精致。仅一个人物正面略侧身胸像，整个头盔、头顶、肩甲完整不截断，主体居中放在画面中央正方形内，头脸占中央正方形上部约一半，四周充分留白避免圆形头像裁切切到头。背景为纯净平整深冷灰，无风景无道具。'},
 {id:'cavalry',kind:'unit',prompt:shared+'仅一个独立唐代骑兵小队图标：三名唐代重装骑兵组成紧凑三角阵列，三个骑手各骑一匹深棕到黑色马，所有马头、马腿、马尾、骑手和长矛完整。三分之四俯视等距视角，朝画面右上方行进；马姿态稍有区别，有一匹前蹄抬起。黑铁甲、古铜甲扣、朱红披风与红缨长矛；人马比例自然，细致的鬃毛和甲片，像收藏级手绘战争棋子。小队紧凑，所有主体约占画面中间65%的宽度和75%的高度。背景必须为完全均匀纯白RGB255,255,255，无地面、无落影、无灰色阴影、无烟尘、无光晕、无边框，方便连通抠白。不要旗帜或额外人物。'},
 {id:'infantry',kind:'unit',prompt:shared+'仅一个独立唐代步兵小队图标：四名唐代持盾长矛步兵，两前两后紧凑四人小阵，所有人体、脚、盾牌、长矛矛尖完整。三分之四俯视等距视角，朝画面右上方行进，步态略有区别。蓝灰铁甲和青蓝布袍，古铜扣件，少量红缨，左手持深色圆盾，右手持长矛；真实比例，收藏级手绘战争棋子般精致。小队紧凑，所有主体约占画面中间60%的宽度和75%的高度。背景必须为完全均匀纯白RGB255,255,255，无地面、无落影、无灰色阴影、无烟尘、无光晕、无边框，方便连通抠白。不要旗帜、马或额外人物。'},
];
await fs.mkdir(base,{recursive:true});
for(const spec of specs){
 const dir=path.join(base,'originals',spec.id);await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'request.json'),JSON.stringify({directory:dir,profile:'16:9',prompt:spec.prompt},null,2)+'\n');
}
if(!process.argv.includes('--process')){
 let cursor=0;
 async function worker(){
  while(cursor<specs.length){
   const spec=specs[cursor++],dir=path.join(base,'originals',spec.id);
   let complete=false;try{const r=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));complete=sha256(await fs.readFile(r.path))===r.sha256;}catch{}
   if(complete){console.log(`${spec.id}: cached`);continue;}
   const log=await fs.open(path.join(dir,'generation.log'),'a');
   console.log(`${spec.id}: submitting existing image checkpoint worker`);
   const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'backend/run-tsx.mjs'),'scripts/history-motion-image.ts',path.join(dir,'request.json')],{cwd:root,env:{...process.env,TASK_WORKER_DISABLED:'1'},stdio:['ignore',log.fd,log.fd]});
    child.once('error',reject);child.once('exit',resolve);
   });await log.close();
   if(code!==0){console.log(`${spec.id}: worker failed; checkpoint preserved`);continue;}
   console.log(`${spec.id}: generated`);
  }
 }
 await Promise.all([worker(),worker()]);
}
const processed=[];
for(const spec of specs){
 const dir=path.join(base,'originals',spec.id);
 let record;try{record=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));}catch{processed.push({id:spec.id,status:'unavailable',request:path.join(dir,'request.json')});continue;}
 const original=await fs.readFile(record.path);
 if(sha256(original)!==record.sha256)throw Error(`Original checksum mismatch: ${spec.id}`);
 const output=path.join(base,`${spec.id}.png`);
 let metrics;
 if(spec.kind==='portrait'){
  await sharp(original).resize(768,768,{fit:'cover',position:'centre'}).png().toFile(output);
  metrics={width:768,height:768,processing:'Centered square crop; opaque portrait for framed rendering'};
 }else{
  const {data,info}=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const {width,height}=info,n=width*height,seen=new Uint8Array(n),queue=new Int32Array(n);let head=0,tail=0;
  let originalTransparent=0;
  for(let i=0;i<n;i++)if(data[i*4+3]===0)originalTransparent++;
  // Only remove near-white pixels connected to the exterior: white shields/metal inside remain intact.
  const eligible=i=>{const k=i*4,r=data[k],g=data[k+1],b=data[k+2];return Math.min(r,g,b)>=217&&Math.max(r,g,b)-Math.min(r,g,b)<=29;};
  const push=i=>{if(!seen[i]&&eligible(i)){seen[i]=1;queue[tail++]=i;}};
  for(let x=0;x<width;x++){push(x);push((height-1)*width+x);}for(let y=0;y<height;y++){push(y*width);push(y*width+width-1);}
  while(head<tail){const i=queue[head++],x=i%width,y=(i-x)/width;data[i*4+3]=0;if(x>0)push(i-1);if(x<width-1)push(i+1);if(y>0)push(i-width);if(y<height-1)push(i+width);}
  let minX=width,minY=height,maxX=0,maxY=0;
  for(let i=0;i<n;i++){if(data[i*4+3]>0){const x=i%width,y=(i-x)/width;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
  if(maxX<=minX||maxY<=minY)throw Error(`No foreground retained: ${spec.id}`);
  const padding=12;minX=Math.max(0,minX-padding);minY=Math.max(0,minY-padding);maxX=Math.min(width-1,maxX+padding);maxY=Math.min(height-1,maxY+padding);
  await sharp(data,{raw:{width,height,channels:4}}).extract({left:minX,top:minY,width:maxX-minX+1,height:maxY-minY+1}).resize(512,512,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toFile(output);
  const alpha=await sharp(output).extractChannel(3).raw().toBuffer();
  const transparentFraction=alpha.reduce((count,value)=>count+(value===0?1:0),0)/alpha.length;
  if(transparentFraction<.15)throw Error(`Unit background was not removed: ${spec.id}`);
  metrics={width:512,height:512,backgroundPixelsRemoved:tail,sourcePixels:n,sourceTransparentFraction:originalTransparent/n,transparentFraction,
   processing:originalTransparent>n*.1?'Preserved generated alpha; foreground crop, transparent 512px canvas':'Border-connected near-white flood removal, foreground crop, transparent 512px canvas'};
 }
 const image=await fs.readFile(output);
 processed.push({id:spec.id,kind:spec.kind,character:spec.character,status:'ready',path:output,sha256:sha256(image),originalPath:record.path,originalSha256:record.sha256,generationId:record.generationId,prompt:spec.prompt,...metrics});
}
await fs.writeFile(path.join(base,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),source:'Project configured image generation service via history-motion-image.ts',assetStatus:'AI-generated illustrative history game art; portraits are not authenticated likenesses',assets:processed},null,2)+'\n');
console.log(JSON.stringify(processed.map(({id,status,path})=>({id,status,path})),null,2));
if(processed.some(a=>a.status!=='ready'))process.exitCode=1;
