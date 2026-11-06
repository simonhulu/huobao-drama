import fs from 'node:fs'
import path from 'node:path'
import {assetHash,motionFileHash} from './history-motion-assets.js'

type PortraitForce={commander?:string;faction:string;portraitSrc?:string;portraitSha256?:string}
type PortraitResult={path:string;sha256:string}
type PortraitInput={
  context:string;directory:string
  generateImage:(input:{prompt:string;directory:string;shotId:string;profile:'16:9'})=>Promise<PortraitResult>
}

export async function prepareMapPortraits(map:{forces?:PortraitForce[]},input:PortraitInput) {
  const failures:string[]=[],resolved=new Map<string,PortraitResult | null>()
  fs.mkdirSync(input.directory,{recursive:true})
  for(const force of map.forces || []) {
    if(!force.commander || force.portraitSrc)continue
    const key=assetHash(JSON.stringify([input.context,force.commander,force.faction]))
    if(!resolved.has(key)) {
      const directory=path.join(input.directory,key),record=path.join(directory,'portrait.json')
      if(!fs.existsSync(directory) && fs.readdirSync(input.directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).length>=4) {
        resolved.set(key,null);continue
      }
      fs.mkdirSync(directory,{recursive:true})
      try {
        let image:PortraitResult | undefined
        if(fs.existsSync(record)) {
          const cached=JSON.parse(fs.readFileSync(record,'utf8'))
          // Failed requests remain checkpointed by the image service. Use the army
          // symbol on retries instead of blocking every map on the same portrait.
          if(cached.status==='unavailable'){resolved.set(key,null);continue}
          if(cached.path && fs.existsSync(cached.path) && await motionFileHash(cached.path)===cached.sha256)image=cached
        }
        if(!image)image=await input.generateImage({directory,shotId:`map-portrait-${key.slice(0,12)}`,profile:'16:9',
          prompt:`历史地图的武将头像素材。历史背景：${input.context}。人物：${force.commander}，所属${force.faction}。根据该人物及时代服饰制作可辨认的历史人物胸像，头部完整且居中，占画面中间三分之一，面向观众，神情沉着。统一精细手绘历史战略游戏立绘风格，柔和明暗，清楚面部轮廓和甲胄或冠帽，深灰纯色背景，不写姓名或任何文字，不画旗帜、地图、外框和其他人物。属于人物示意立绘，不是历史照片或声称精确复原。`})
        if(!fs.existsSync(image.path) || await motionFileHash(image.path)!==image.sha256)throw Error('头像文件缺失或指纹不匹配')
        fs.writeFileSync(record,JSON.stringify({...image,commander:force.commander,faction:force.faction,kind:'generated-illustrative-portrait'},null,2))
        resolved.set(key,image)
      } catch(error) {
        const reason=`${force.commander}头像不可用，保留军队与姓名：${(error as Error).message}`
        failures.push(reason);resolved.set(key,null)
        fs.writeFileSync(record,JSON.stringify({status:'unavailable',reason},null,2))
      }
    }
    const image=resolved.get(key)
    if(image){force.portraitSrc=image.path;force.portraitSha256=image.sha256}
  }
  return {failures}
}
