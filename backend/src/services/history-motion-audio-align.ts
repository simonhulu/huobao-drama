import {textContent, type MotionShot} from './history-motion-production.js'
import fs from 'node:fs'
import {execFileSync} from 'node:child_process'

export type WhisperTokenEvidence = {text: string; offsets?: {from?: number; to?: number}}
export type WhisperSegmentEvidence = {
  text?: string
  offsets?: {from?: number; to?: number}
  tokens?: WhisperTokenEvidence[]
}
export type MotionShotEndEvidence = {
  shotId: string
  endMs: number
  method: 'whisper-offset-end' | 'whisper-segment-end'
  confidence: number
  matchedText: string
  warnings?: string[]
}
export type MotionAlignedCaption = {text: string; startFrame: number; endFrame: number}
export type MotionBoundaryRepair = {
  shotId:string;sourceShotIds:string[];sourceShots:MotionShot[];endMs:number;reason:string
}
type Recognition = {transcription?: WhisperSegmentEvidence[]}
type TimedUnit = {
  text: string; from: number; to: number; segmentEnd: number
  segmentTail: boolean; coarse: boolean; charEnd: number
}
type Alignment = {
  text: string; source: string[]; rawStarts: number[]; recognized: string[]; recognizedRaw: string[]; unitForChar: number[]
  units: TimedUnit[]; mapping: Int32Array; exact: Uint8Array; rejection?: string
}

type CharacterReading={simplified:string;syllable?:string}
const characterReadings=new Map<string,CharacterReading>()
let warnedMissingConverter=false

// ICU supplies the writing-system and Mandarin conversions. Batch unique Han
// characters so conversion never changes source offsets or adds a per-token process.
// Transform reference: https://unicode-org.github.io/icu/userguide/transforms/general/
function prepareCharacterReadings(text:string) {
  const characters=[...new Set([...text].filter(char=>/\p{Script=Han}/u.test(char) && !characterReadings.has(char)))]
  if(!characters.length)return
  const candidates=process.env.HISTORY_ALIGNMENT_UCONV?[process.env.HISTORY_ALIGNMENT_UCONV]:[
    '/opt/homebrew/opt/icu4c/bin/uconv','/usr/local/opt/icu4c/bin/uconv','/usr/bin/uconv',
  ]
  const executable=candidates.find(filename=>fs.existsSync(filename))
  const defaults=()=>characters.forEach(char=>characterReadings.set(char,{simplified:char}))
  if(!executable) {
    defaults()
    if(!warnedMissingConverter)console.warn('[history-motion-audio-align] ICU uconv 不可用，简繁与同音恢复未启用；可配置 HISTORY_ALIGNMENT_UCONV')
    warnedMissingConverter=true
    return
  }
  try {
    const input=characters.join('\n')+'\n'
    const convert=(transform:string)=>execFileSync(executable,['-x',transform],{input,encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024}).trimEnd().split('\n')
    const simplified=convert('Traditional-Simplified'),readings=convert('Han-Latin')
    if(simplified.length!==characters.length || readings.length!==characters.length)throw Error('ICU conversion changed the character count')
    characters.forEach((char,index)=>{
      const syllable=readings[index].normalize('NFD').replace(/[\u0300\u0301\u0304\u030c]/g,'').normalize('NFC').toLowerCase()
      characterReadings.set(char,{simplified:[...simplified[index]].length===1?simplified[index]:char,
        ...(/^[a-zü]+$/.test(syllable)?{syllable}:{})})
    })
  } catch(error) {
    defaults()
    console.warn('[history-motion-audio-align] ICU 字形/读音转换失败，保留严格文字匹配：'+(error as Error).message)
  }
}

function alignmentContent(value: string): string {
  // Speech has no letter case. Fold ASCII only so matching keeps one character
  // per source position; captions still take their text from the locked script.
  return [...textContent(value).replace(/[A-Z]/g, char=>char.toLowerCase())].map(char=>characterReadings.get(char)?.simplified || char).join('')
}
function clean(value: string): string {
  return alignmentContent(value.replace(/\[_[^\]]*\]/g, ''))
}
function finiteRange(value: any): value is {from: number; to: number} {
  return Number.isFinite(value?.from) && Number.isFinite(value?.to) && value.from >= 0 && value.to >= value.from
}

// Keep timestamps atomic. Neither multi-character tokens nor coarse segments
// provide evidence for a proportional division of their spoken duration.
function alignScript(shots: MotionShot[], recognition: Recognition): Alignment {
  const text=shots.map(shot=>shot.narration).join(''), source:string[]=[],rawStarts:number[]=[]
  prepareCharacterReadings(text+(recognition.transcription || []).map(segment=>segment.text || '').join('')
    +(recognition.transcription || []).flatMap(segment=>segment.tokens || []).map(token=>token.text).join(''))
  let rawOffset=0
  for(const glyph of text) {
    for(const char of alignmentContent(glyph)){source.push(char);rawStarts.push(rawOffset)}
    rawOffset+=glyph.length
  }
  const recognized:string[]=[],recognizedRaw:string[]=[],unitForChar:number[]=[],units:TimedUnit[]=[]
  for(const segment of recognition.transcription || []) {
    const segmentRange=finiteRange(segment.offsets)?segment.offsets:undefined
    const tokens=(segment.tokens || []).filter(token=>clean(String(token.text || '')))
    const entries=tokens.length?tokens:[{text:segment.text || '',offsets:segmentRange}]
    const first=units.length
    for(const token of entries) {
      const content=clean(String(token.text || '')),range=finiteRange(token.offsets)?token.offsets:segmentRange
      if(!content || !range)continue
      const unit=units.length
      for(const char of content){recognized.push(char);unitForChar.push(unit)}
      recognizedRaw.push(...textContent(String(token.text || '').replace(/\[_[^\]]*\]/g,'')))
      units.push({text:content,from:range.from,to:range.to,segmentEnd:segmentRange?.to ?? range.to,
        segmentTail:false,coarse:!tokens.length || !finiteRange(token.offsets),charEnd:recognized.length})
    }
    if(units.length>first)units.at(-1)!.segmentTail=true
  }
  const mapping=new Int32Array(source.length).fill(-1),exact=new Uint8Array(source.length)
  const aligned:Alignment={text,source,rawStarts,recognized,recognizedRaw,unitForChar,units,mapping,exact}
  const reject=(reason:string)=>({...aligned,rejection:reason})
  if(!source.length || !recognized.length)return reject('缺少正文或有效语音识别文字')
  const columns=recognized.length+1,cells=(source.length+1)*columns
  if(cells>64000000)return reject('文本超出本地对齐预算，请分段识别')
  const directions=new Uint8Array(cells)
  let previous=new Uint32Array(columns),current=new Uint32Array(columns)
  for(let j=1;j<columns;j++){previous[j]=j;directions[j]=3}
  for(let i=1;i<=source.length;i++) {
    current[0]=i;directions[i*columns]=2
    for(let j=1;j<columns;j++) {
      const diagonal=previous[j-1]+(source[i-1]===recognized[j-1]?0:1),deletion=previous[j]+1,insertion=current[j-1]+1
      const cost=Math.min(diagonal,deletion,insertion)
      current[j]=cost
      directions[i*columns+j]=cost===diagonal?1:cost===deletion?2:3
    }
    const swap=previous;previous=current;current=swap
  }
  if(previous[recognized.length]/Math.max(source.length,recognized.length)>.3)return reject('语音识别与锁定正文匹配不足')
  let i=source.length,j=recognized.length
  while(i || j) {
    const direction=directions[i*columns+j]
    if(direction===1){mapping[i-1]=j-1;exact[i-1]=source[i-1]===recognized[j-1]?1:0;i--;j--}
    else if(direction===2)i--
    else j--
  }
  let leading=0,trailing=0
  while(leading<source.length && mapping[leading]<0)leading++
  while(trailing<source.length && mapping[source.length-trailing-1]<0)trailing++
  if(leading>2 || trailing>2)return reject('语音识别未覆盖正文首尾，可能为截断音频')
  return aligned
}

function safeUnitEnd(alignment: Alignment, unitIndex: number): {endMs:number; segment:boolean} {
  const unit=alignment.units[unitIndex],next=alignment.units[unitIndex+1]
  let endMs=unit.to
  const segment=unit.segmentTail || unit.coarse
  if(segment)endMs=Math.max(endMs,unit.segmentEnd)
  // A following token onset is a conservative boundary, including when the
  // final token has a zero-length timestamp or its punctuation holds a pause.
  if(next && next.from>=endMs)endMs=next.from
  if(endMs<=unit.from)endMs=Math.max(endMs,unit.segmentEnd)
  return {endMs,segment}
}

function spanEvidence(alignment: Alignment, start: number, end: number) {
  let first=-1,last=-1,mapped=0,matches=0
  for(let index=start;index<end;index++) {
    if(alignment.mapping[index]>=0){first=first<0?alignment.mapping[index]:first;last=alignment.mapping[index];mapped++}
    matches+=alignment.exact[index]
  }
  const width=Math.max(1,end-start),span=last-first+1
  const local=matches/Math.max(width,span)
  const left=Math.max(0,start-8),right=Math.min(alignment.source.length,end+8)
  let context=0
  for(let index=left;index<right;index++)context+=alignment.exact[index]
  const confidence=Math.max(local,mapped/width>=.9?context/Math.max(1,right-left)*.9:0)
  return {first,last,mapped,local,confidence,width}
}

function reportRejection(alignment: Alignment) {
  if(alignment.rejection)console.warn('[history-motion-audio-align] '+alignment.rejection+'，未生成实测时间码')
  return Boolean(alignment.rejection)
}

function hasContextVerifiedSegmentEnd(alignment:Alignment,start:number,end:number,evidence:ReturnType<typeof spanEvidence>) {
  if(evidence.width>24 || evidence.local<.4 || evidence.mapped!==evidence.width)return false
  const contiguous=(from:number,to:number)=>{
    const first=alignment.mapping[from]
    if(first<0)return false
    for(let index=from;index<to;index++)if(alignment.mapping[index]!==first+index-from)return false
    return true
  }
  const left=Math.max(0,start-12),right=Math.min(alignment.source.length,end+12)
  if(start-left<8 || right-end<8 || !contiguous(left,right))return false
  const matches=(from:number,to:number)=>alignment.exact.slice(from,to).reduce((sum,value)=>sum+value,0)/(to-from)
  if(matches(left,start)<.75 || matches(end,right)<.75 || !alignment.exact[end])return false
  let run=0,longest=0
  for(let index=start;index<end;index++) {
    run=alignment.exact[index]?run+1:0;longest=Math.max(longest,run)
  }
  if(longest<4)return false
  const unitIndex=alignment.unitForChar[evidence.last],unit=alignment.units[unitIndex],next=alignment.units[unitIndex+1]
  return !unit.coarse && unit.segmentTail && evidence.last===unit.charEnd-1
    && Boolean(next && !next.coarse && next.from>=unit.segmentEnd)
}

function hasPhoneticallyVerifiedTokenEnd(alignment:Alignment,start:number,end:number,evidence:ReturnType<typeof spanEvidence>) {
  if(evidence.width>32 || evidence.width<6 || evidence.local<.4 || evidence.mapped!==evidence.width)return false
  const left=Math.max(0,start-8),right=Math.min(alignment.source.length,end+8)
  if(start-left<8 || right-end<8)return false
  const first=alignment.mapping[left]
  if(first<0)return false
  for(let index=left;index<right;index++)if(alignment.mapping[index]!==first+index-left)return false
  const ratio=(from:number,to:number)=>alignment.exact.slice(from,to).reduce((sum,value)=>sum+value,0)/(to-from)
  if(Math.max(ratio(left,start),ratio(end,right))<.8 || !alignment.exact[end-1] || !alignment.exact[end-2])return false
  let sameSound=0
  for(let index=start;index<right;index++) {
    const source=alignment.source[index],recognized=alignment.recognized[alignment.mapping[index]]
    const sound=characterReadings.get(source)?.syllable
    if(source===recognized || sound && sound===characterReadings.get(recognized)?.syllable)sameSound++
  }
  if(sameSound/(right-start)<.95)return false
  const unitIndex=alignment.unitForChar[evidence.last],unit=alignment.units[unitIndex],next=alignment.units[unitIndex+1]
  if(unit.coarse || evidence.last!==unit.charEnd-1 || !next || next.coarse)return false
  const gap=next.from-unit.to
  return gap>=100 && gap<=1500 && safeUnitEnd(alignment,unitIndex).endMs===next.from
}

export function alignMotionShotEndTimes(shots: MotionShot[], recognition: Recognition): MotionShotEndEvidence[] {
  const alignment=alignScript(shots,recognition)
  if(reportRejection(alignment))return []
  const result:MotionShotEndEvidence[]=[]
  let start=0,previousEnd=-1
  for(let index=0;index<shots.length-1;index++) {
    const end=start+textContent(shots[index].narration).length,evidence=spanEvidence(alignment,start,end)
    // Names can be homophones in ASR. A short fully mapped phrase may still
    // use its measured sentence end when continuous context verifies both sides.
    const contextVerified=evidence.confidence<.6 && hasContextVerifiedSegmentEnd(alignment,start,end,evidence)
    const phoneticVerified=evidence.confidence<.6 && !contextVerified && hasPhoneticallyVerifiedTokenEnd(alignment,start,end,evidence)
    start=end
    if(evidence.last<0 || evidence.mapped/evidence.width<.75 || evidence.confidence<.6 && !contextVerified && !phoneticVerified)continue
    const unitIndex=alignment.unitForChar[evidence.last],unit=alignment.units[unitIndex]
    if(unit.coarse && evidence.last<unit.charEnd-1)continue
    const timing=safeUnitEnd(alignment,unitIndex),warnings:string[]=[]
    if(contextVerified)warnings.push('本镜文字匹配偏低；前后连续语音锚点已核对实测分句末尾，保留原稿')
    if(phoneticVerified)warnings.push('本镜文字匹配偏低；ICU 同音读音、连续上下文、精确镜尾和实测停顿已核对，保留原稿；并非音素级强制对齐')
    if(alignment.recognizedRaw.slice(evidence.first,evidence.last+1).some((char,index)=>char!==alignment.recognized[evidence.first+index] && /\p{Script=Han}/u.test(char)))
      warnings.push('简繁字形仅在匹配端归一；原稿、字幕与原始识别证据保持不变')
    if(evidence.local<.85)warnings.push('识别含替换或缺字，使用全稿上下文匹配；并非逐字强制对齐')
    if(alignment.mapping[end-1]<0) {
      const next=alignment.mapping.slice(end).find(value=>value>=0)
      if(next===undefined)continue
      timing.endMs=Math.max(timing.endMs,alignment.units[alignment.unitForChar[next]].from)
      warnings.push('镜尾字符未识别，保守延后到下一语音锚点')
    }
    if(alignment.mapping[end]>=0 && alignment.unitForChar[alignment.mapping[end]]===unitIndex)
      warnings.push('镜尾位于多字语音 token 内，保留整个 token 后切换')
    if(timing.endMs<=previousEnd)continue
    result.push({shotId:shots[index].shotId,endMs:timing.endMs,method:timing.segment?'whisper-segment-end':'whisper-offset-end',
      confidence:evidence.confidence,matchedText:alignment.recognizedRaw.slice(evidence.first,evidence.last+1).join(''),
      ...(warnings.length?{warnings}:{})})
    previousEnd=timing.endMs
  }
  return result
}

export function coalesceUnmeasuredMotionCuts(shots:MotionShot[],evidence:MotionShotEndEvidence[],durationMs:number) {
  const unchanged=()=>({shots,shotEndTimes:evidence,repairs:[] as MotionBoundaryRepair[]})
  const ends=new Map(evidence.map(end=>[end.shotId,end]))
  const missing=shots.slice(0,-1).filter(shot=>!ends.has(shot.shotId)).length
  if(!missing || !evidence.length || missing>Math.max(1,Math.floor((shots.length-1)*.02)))return unchanged()
  const repaired:MotionShot[]=[],shotEndTimes:MotionShotEndEvidence[]=[],repairs:MotionBoundaryRepair[]=[]
  for(let index=0;index<shots.length;index++) {
    let last=index
    while(last<shots.length-1 && !ends.has(shots[last].shotId))last++
    const measured=ends.get(shots[last].shotId)
    if(last===index) {
      repaired.push(shots[index]);if(measured)shotEndTimes.push(measured)
      continue
    }
    // Remove a small number of unsafe cuts; never invent a timestamp or
    // compensate for widespread recognition failure by merging the whole film.
    const endMs=measured?.endMs ?? durationMs,fromMs=index?ends.get(shots[index-1].shotId)?.endMs:0
    if(fromMs===undefined || !Number.isFinite(endMs) || endMs<=fromMs || endMs-fromMs>20000 || last-index>=3)return unchanged()
    const group=shots.slice(index,last+1),shotId=group[0].shotId,sourceShotIds=group.map(shot=>shot.shotId)
    const reason=`无法可靠切开的相邻镜头 ${sourceShotIds.join('、')} 已合并，使用后一个实测镜尾；正文和配音保持原样`
    repaired.push({...group[0],narration:group.map(shot=>shot.narration).join(''),duration:group.reduce((sum,shot)=>sum+shot.duration,0)})
    repairs.push({shotId,sourceShotIds,sourceShots:group,endMs,reason})
    if(measured)shotEndTimes.push({...measured,shotId,warnings:[...(measured.warnings || []),reason]})
    index=last
  }
  return {shots:repaired,shotEndTimes,repairs}
}

export function buildMotionAlignedCaptions(shots: MotionShot[], recognition: Recognition, duration: number, captionLength=28): MotionAlignedCaption[] {
  const alignment=alignScript(shots,recognition)
  if(reportRejection(alignment) || !(duration>0) || !(captionLength>0))return []
  const sourceUnits=new Int32Array(alignment.source.length).fill(-1)
  let next=-1
  for(let index=sourceUnits.length-1;index>=0;index--) {
    if(alignment.mapping[index]>=0)next=alignment.unitForChar[alignment.mapping[index]]
    sourceUnits[index]=next
  }
  for(let index=1;index<sourceUnits.length;index++)if(sourceUnits[index]<0)sourceUnits[index]=sourceUnits[index-1]
  const shotRawEnds=new Map<number,number>()
  let sourceEnd=0,rawEnd=0
  for(const shot of shots) {
    sourceEnd+=textContent(shot.narration).length;rawEnd+=shot.narration.length
    shotRawEnds.set(sourceEnd,rawEnd)
  }
  const groups:{unit:number;rawEnd:number;shotEnd:boolean}[]=[]
  for(let index=0;index<sourceUnits.length;index++) {
    const shotEnd=shotRawEnds.has(index+1)
    if(!shotEnd && index<sourceUnits.length-1 && sourceUnits[index]===sourceUnits[index+1])continue
    groups.push({unit:sourceUnits[index],shotEnd,
      rawEnd:shotRawEnds.get(index+1) ?? (index+1<sourceUnits.length?alignment.rawStarts[index+1]:alignment.text.length)})
  }
  const captions:MotionAlignedCaption[]=[],totalFrames=Math.round(duration*30)
  let rawStart=0,firstUnit=-1,pending=''
  for(let index=0;index<groups.length;index++) {
    const group=groups[index]
    if(group.unit<0)return []
    if(firstUnit<0)firstUnit=group.unit
    pending+=alignment.text.slice(rawStart,group.rawEnd);rawStart=group.rawEnd
    const size=[...pending].length,natural=/[，。！？；：、,.!?;:\n\s]$/.test(pending)
    if(!group.shotEnd && index<groups.length-1 && size<captionLength && !(natural && size>=captionLength*.5))continue
    const end=safeUnitEnd(alignment,group.unit).endMs
    const startFrame=Math.max(captions.at(-1)?.endFrame || 0,Math.floor(alignment.units[firstUnit].from*30/1000))
    const endFrame=Math.min(totalFrames,Math.ceil(end*30/1000))
    if(endFrame<=startFrame) {
      if(!captions.length)return []
      captions.at(-1)!.text+=pending
    } else captions.push({text:pending,startFrame,endFrame})
    pending='';firstUnit=-1
  }
  if(!captions.length || captions.map(caption=>caption.text).join('')!==alignment.text)return []
  captions.at(-1)!.endFrame=totalFrames
  return captions
}

