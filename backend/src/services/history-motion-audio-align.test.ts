import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {alignMotionShotEndTimes,buildMotionAlignedCaptions,coalesceUnmeasuredMotionCuts} from './history-motion-audio-align.js'

const shot=(shotId:string,narration:string)=>({shotId,narration,duration:1}) as any
const hasUconv=(process.env.HISTORY_ALIGNMENT_UCONV?[process.env.HISTORY_ALIGNMENT_UCONV]:[
  '/opt/homebrew/opt/icu4c/bin/uconv','/usr/local/opt/icu4c/bin/uconv','/usr/bin/uconv',
]).some(filename=>fs.existsSync(filename))

test('an isolated unreliable name-list cut merges with its neighbor and uses the measured later end',()=>{
  const shots=[shot('before','其中最有知名度的有四大家族。'),
    shot('names','他们分别是吴秉鉴的怡和行、潘启官的同文行、卢观恒的广利行和叶'),
    shot('next','上林的义成行。他们四大家族当时简直是呼风唤雨，'),shot('after','其中吴秉鉴的怡和行是发展得最好的。')]
  const ends=[{shotId:'before',endMs:3000,method:'whisper-segment-end' as const,confidence:.96,matchedText:'其中最有知名度的有四大家族'},
    {shotId:'next',endMs:16060,method:'whisper-segment-end' as const,confidence:.85,matchedText:'上林的异程型他们四大家族当时简直是呼风唤雨'}]
  const result=coalesceUnmeasuredMotionCuts(shots,ends,21000)
  assert.deepEqual(result.shots.map(shot=>shot.shotId),['before','names','after'])
  assert.equal(result.shots.map(shot=>shot.narration).join(''),shots.map(shot=>shot.narration).join(''))
  assert.equal(result.shotEndTimes.find(end=>end.shotId==='names')?.endMs,16060)
  assert.deepEqual(result.repairs[0].sourceShotIds,['names','next'])
  assert.match(result.shotEndTimes.find(end=>end.shotId==='names')?.warnings?.join('') || '',/合并/)
  assert.deepEqual(shots.map(shot=>shot.shotId),['before','names','next','after'],'repair must not mutate the saved input')
})

test('boundary repair refuses broad recognition failures and long unmeasured stretches',()=>{
  const shots=Array.from({length:6},(_,index)=>shot(`s${index}`,'固定正文。'))
  assert.equal(coalesceUnmeasuredMotionCuts(shots,[],30000).repairs.length,0)
  const ends=shots.slice(1,-1).map((s,index)=>({shotId:s.shotId,endMs:25000+index*1000,method:'whisper-offset-end' as const,confidence:1,matchedText:s.narration}))
  assert.equal(coalesceUnmeasuredMotionCuts(shots,ends,32000).repairs.length,0,'must not turn an unmeasured stretch into a long static shot')
})

test('whisper token ends align punctuation-split shots without using control tokens',()=>{
  const result=alignMotionShotEndTimes([
    shot('s1','朝廷军队不堪一击。其实，'),
    shot('s2','这场战争是朱棣带着一批千户、百户。'),
  ],{transcription:[{
    offsets:{from:0,to:2000},text:'朝廷军队不堪一击。其实，这场战争是朱棣带着一批千户、百户。',
    tokens:[
      {text:'朝廷军队不堪一击',offsets:{from:0,to:1500}},
      {text:'[_TT_10]',offsets:{from:1500,to:1500}},
      {text:'其实',offsets:{from:1600,to:1800}},
      {text:'这场战争是朱棣带着一批千户、百户',offsets:{from:1800,to:2000}},
    ],
  }]})
  assert.equal(result.length,1)
  assert.equal(result[0].endMs,1800)
  assert.equal(result[0].method,'whisper-offset-end')
  assert.ok(result[0].confidence>.9)
})

test('multi-character tokens end at the whole token and keep results monotonic',()=>{
  const result=alignMotionShotEndTimes([
    shot('s1','朱棣。'),shot('s2','继续。'),shot('s3','结束。'),
  ],{transcription:[
    {offsets:{from:0,to:1000},tokens:[{text:'朱棣',offsets:{from:100,to:500}},{text:'继续',offsets:{from:600,to:800}}]},
    {offsets:{from:1000,to:1500},tokens:[{text:'结束',offsets:{from:1100,to:1400}}]},
  ]})
  assert.ok(result[0].endMs>=500 && result[0].endMs<=600)
  assert.ok(result[1].endMs>=1000 && result[1].endMs<=1100)
})

test('unrelated recognition is rejected instead of becoming a false precise cut',()=>{
  const result=alignMotionShotEndTimes([shot('s1','红军行进。'),shot('s2','继续。')],{
    transcription:[{offsets:{from:0,to:5000},text:'完全不同的语音',tokens:[{text:'完全不同的语音',offsets:{from:0,to:5000}}]}],
  })
  assert.equal(result.length,0)
})

test('full-script matching keeps repeated phrases in order despite a name substitution',()=>{
  const shots=[shot('s1','朱允炆下令，继续推进。'),shot('s2','燕军下令，继续推进。'),shot('s3','停止推进。')]
  const recognition={transcription:[
    {offsets:{from:0,to:3000},tokens:[{text:'朱允文下令',offsets:{from:0,to:1500}},{text:'继续推进',offsets:{from:1600,to:2800}}]},
    {offsets:{from:3000,to:6000},tokens:[{text:'燕军下令',offsets:{from:3100,to:4400}},{text:'继续推进',offsets:{from:4500,to:5800}}]},
    {offsets:{from:6000,to:8000},tokens:[{text:'停止推进',offsets:{from:6100,to:7800}}]},
  ]}
  const result=alignMotionShotEndTimes(shots,recognition)
  assert.equal(result.length,2)
  assert.ok(result[0].endMs>=3000 && result[0].endMs<=3100)
  assert.ok(result[1].endMs>=6000 && result[1].endMs<=6100)
  assert.match(result[0].matchedText,/朱允文/)
  assert.ok(result[0].confidence<1)
})

test('a zero-length token and a sentence-ending token keep the segment tail',()=>{
  const result=alignMotionShotEndTimes([shot('s1','说完了。'),shot('s2','下一句。')],{transcription:[
    {offsets:{from:0,to:1420},tokens:[{text:'说完',offsets:{from:0,to:1000}},{text:'了',offsets:{from:1000,to:1000}},{text:'。',offsets:{from:1000,to:1420}}]},
    {offsets:{from:1500,to:3000},tokens:[{text:'下一句',offsets:{from:1500,to:2800}}]},
  ]})
  assert.equal(result.length,1)
  assert.ok(result[0].endMs>=1420)
  assert.equal(result[0].method,'whisper-segment-end')
})

test('coarse segments cannot fabricate internal token boundaries or collapse shots',()=>{
  const result=alignMotionShotEndTimes([shot('s1','第一句。'),shot('s2','第二句。'),shot('s3','第三句。')],{
    transcription:[{offsets:{from:0,to:6000},text:'第一句第二句第三句'}],
  })
  assert.equal(result.length,0)
})

test('a truncated transcript is rejected even when its opening matches perfectly',()=>{
  const shots=[shot('s1','第一队继续推进。'),shot('s2','第二队抵达渡口。'),shot('s3','最后全军撤回营地。')]
  const recognition={transcription:[{offsets:{from:0,to:3000},tokens:[{text:'第一队继续推进',offsets:{from:0,to:2900}}]}]}
  assert.deepEqual(alignMotionShotEndTimes(shots,recognition),[])
  assert.deepEqual(buildMotionAlignedCaptions(shots,recognition,9),[])
})

test('captions preserve the original text and use nonuniform spoken timing',()=>{
  const shots=[shot('s1','红军，出发。\n'),shot('s2','继续推进！')]
  const recognition={transcription:[
    {offsets:{from:0,to:4700},tokens:[{text:'红军',offsets:{from:100,to:4200}},{text:'出发',offsets:{from:4300,to:4600}}]},
    {offsets:{from:4800,to:6000},tokens:[{text:'继续',offsets:{from:4800,to:5200}},{text:'推进',offsets:{from:5300,to:5800}}]},
  ]}
  const captions=buildMotionAlignedCaptions(shots,recognition,6,3)
  assert.equal(captions.map(item=>item.text).join(''),shots.map(item=>item.narration).join(''))
  assert.ok(captions[0].text.includes('红军'))
  assert.ok(captions[0].endFrame>=126,'the first slow token must occupy at least 4.2 seconds')
  assert.equal(captions.at(-1)!.endFrame,180)
  assert.ok(captions.every((item,index)=>item.endFrame>item.startFrame && (!index || item.startFrame>=captions[index-1].endFrame)))
})

test('captions never divide a multi-character token into proportional intervals',()=>{
  const shots=[shot('s1','朱棣出发。继续。')]
  const recognition={transcription:[{offsets:{from:0,to:3000},tokens:[
    {text:'朱棣',offsets:{from:0,to:1400}},
    {text:'出发',offsets:{from:1500,to:2200}},
    {text:'继续',offsets:{from:2300,to:2900}},
  ]}]}
  const captions=buildMotionAlignedCaptions(shots,recognition,3,1)
  assert.equal(captions.map(item=>item.text).join(''),'朱棣出发。继续。')
  assert.equal(captions[0].text,'朱棣')
  assert.ok(captions[0].endFrame>=42)
  assert.ok(captions.every(item=>item.text!=='朱' && item.text!=='棣'))
})

test('captions end within each shot using the same spoken boundary as the picture',()=>{
  const shots=[shot('s1','第一队出发。'),shot('s2','第二队抵达。')]
  const recognition={transcription:[{offsets:{from:0,to:5000},tokens:[
    {text:'第一队',offsets:{from:100,to:1200}},
    {text:'出发',offsets:{from:1300,to:2400}},
    {text:'第二队',offsets:{from:2600,to:3500}},
    {text:'抵达',offsets:{from:3600,to:4800}},
  ]}]}
  const ends=alignMotionShotEndTimes(shots,recognition)
  const captions=buildMotionAlignedCaptions(shots,recognition,5)
  assert.equal(captions.length,2)
  assert.deepEqual(captions.map(item=>item.text),shots.map(item=>item.narration))
  assert.equal(captions[0].endFrame,Math.ceil(ends[0].endMs*30/1000))
  assert.ok(captions[1].startFrame>=captions[0].endFrame)
})

test('Latin casing does not discard a measured shot end or change the locked captions',()=>{
  const shots=[shot('s1','PEKING。'),shot('s2','下一处标注仍需档案核实再做判断。')]
  const recognition={transcription:[
    {offsets:{from:0,to:2100},tokens:[{text:'peking',offsets:{from:100,to:2000}}]},
    {offsets:{from:2200,to:6000},tokens:[{text:'下一处标注仍需档案核实再做判断',offsets:{from:2200,to:5800}}]},
  ]}
  const ends=alignMotionShotEndTimes(shots,recognition)
  assert.equal(ends.length,1)
  assert.equal(ends[0].endMs,2200)
  assert.equal(ends[0].confidence,1)
  const captions=buildMotionAlignedCaptions(shots,recognition,6)
  assert.equal(captions.map(caption=>caption.text).join(''),shots.map(item=>item.narration).join(''))
  assert.equal(captions[0].text,'PEKING。')
  assert.equal(captions[0].endFrame,Math.ceil(ends[0].endMs*30/1000))
})

function nameSubstitutionFixture() {
  const shots=[shot('before','表达托付之意。八月，朱由校去世。'),
    shot('name','朱由检即位，是为崇祯帝。\n\n'),
    shot('after','传位不是一道简单的有儿子就传儿子的选择题。')]
  const segment=(text:string,from:number)=>({offsets:{from,to:from+text.length*100+50},text,
    tokens:[...text].map((text,index)=>({text,offsets:{from:from+index*100,to:from+(index+1)*100}}))})
  return {shots,recognition:{transcription:[segment('表达托付之意8月猪油校去世',0),
    segment('猪油简即位是为重真地',2000),segment('传位不是一道简单的有儿子就传儿子的选择题',4000)]}}
}

test('a short name-heavy shot can use a measured segment tail verified by continuous context',()=>{
  const {shots,recognition}=nameSubstitutionFixture()
  const ends=alignMotionShotEndTimes(shots,recognition)
  const end=ends.find(item=>item.shotId==='name')
  assert.ok(end,'the name substitution must not stop the entire production')
  assert.equal(end.endMs,4000)
  assert.equal(end.method,'whisper-segment-end')
  assert.ok(end.confidence<.6,'retain the actual text confidence')
  assert.match(end.warnings?.join('') || '',/前后.*语音锚点/)
  const captions=buildMotionAlignedCaptions(shots,recognition,7)
  assert.equal(captions.map(item=>item.text).join(''),shots.map(item=>item.narration).join(''))
  assert.equal(captions.find(item=>item.text.includes('崇祯帝'))?.endFrame,120)
})

test('low text confidence cannot invent an internal cut inside a measured segment',()=>{
  const {shots,recognition}=nameSubstitutionFixture()
  const [,name,after]=recognition.transcription
  name.tokens.push(...after.tokens)
  name.offsets.to=after.offsets.to
  recognition.transcription.pop()
  assert.equal(alignMotionShotEndTimes(shots,recognition).some(item=>item.shotId==='name'),false)
})

test('segment-tail recovery requires continuous source coverage and exact internal speech anchors',()=>{
  for(const replacement of ['猪油简即位是为重真','猪油简继任成为重真地']) {
    const {shots,recognition}=nameSubstitutionFixture()
    const segment=recognition.transcription[1]
    segment.tokens=segment.tokens.slice(0,replacement.length).map((token,index)=>({...token,text:replacement[index]}))
    assert.equal(alignMotionShotEndTimes(shots,recognition).some(item=>item.shotId==='name'),false,replacement)
  }
})

test('segment-tail recovery cannot borrow weak or disconnected neighboring text',()=>{
  for(const change of ['weak-left','weak-right','insertion','deleted-shot']) {
    const {shots,recognition}=nameSubstitutionFixture()
    if(change==='weak-left')recognition.transcription[0].tokens.forEach(token=>{token.text='错'})
    if(change==='weak-right')recognition.transcription[2].tokens.slice(0,12).forEach(token=>{token.text='错'})
    if(change==='insertion')recognition.transcription[1].tokens.splice(4,0,{text:'额外',offsets:{from:2410,to:2490}})
    if(change==='deleted-shot')recognition.transcription.splice(1,1)
    assert.equal(alignMotionShotEndTimes(shots,recognition).some(item=>item.shotId==='name'),false,change)
  }
})

test('traditional ASR matches the simplified locked script without changing captions or raw evidence',{skip:!hasUconv},()=>{
  const shots=[shot('before','彭德怀主张继续打，刘伯承认为应当暂缓进攻。'),shot('after','关家垴战斗需要审慎判断。')]
  const recognition={transcription:[
    {offsets:{from:0,to:5000},tokens:[{text:'彭德懷主張繼續打劉伯承認為應當暫緩進攻',offsets:{from:0,to:4800}}]},
    {offsets:{from:5100,to:8000},tokens:[{text:'關家垴戰鬥需要審慎判斷',offsets:{from:5100,to:7900}}]},
  ]}
  const ends=alignMotionShotEndTimes(shots,recognition)
  assert.equal(ends.length,1)
  assert.equal(ends[0].endMs,5100)
  assert.equal(ends[0].confidence,1)
  assert.match(ends[0].matchedText,/彭德懷/)
  assert.match(ends[0].warnings?.join('') || '',/简繁/)
  assert.equal(buildMotionAlignedCaptions(shots,recognition,8).map(item=>item.text).join(''),shots.map(item=>item.narration).join(''))
})

function classicalHomophoneFixture(internal=false) {
  const texts=internal
    ? ['海上有郑和率领庞大舰队出海。','《明史·郑和传》提到：“成祖以惠帝亡海外，','欲踪迹之，命和及柴王景弘等通使西洋。”']
    : ['最后从火里拖出一具尸体。','实录还说：“上哭曰：‘果然若是痴儿也，吾来为弗意而为善，','尔竟不谅而惧至此乎？意思是建文帝已经失去踪迹。']
  const asr=internal
    ? ['海上有郑河率领庞大舰队出海','冥时郑河传提到成足以汇地往海外','欲宗既知命和吉柴网景红等通使西洋']
    : ['最后从火里脱出一具尸体','石路还说上枯约果然若是吃而野无来为服役而为善','耳镜不亮而聚至此乎意思是剑文帝已经失去踪迹']
  const establishedContext='这里的讲述继续依据原有记载保留叙事先后次序'
  texts[0]=establishedContext+texts[0]
  asr[0]=establishedContext+asr[0]
  let offset=0
  const segments=asr.map(text=>{
    const from=offset
    const tokens=[...text].map(text=>{const from=offset;offset+=100;return {text,offsets:{from,to:offset}}})
    const to=offset;offset+=200
    return {text,tokens,offsets:{from,to}}
  })
  if(internal) {
    segments[1].tokens.push(...segments[2].tokens)
    segments[1].offsets.to=segments[2].offsets.to
    segments.pop()
  }
  return {shots:texts.map((text,index)=>shot(`s${index+1}`,text)),recognition:{transcription:segments}}
}

test('classical homophones retain measured token cuts with exact context and a measured pause',{skip:!hasUconv},()=>{
  for(const internal of [false,true]) {
    const {shots,recognition}=classicalHomophoneFixture(internal)
    const ends=alignMotionShotEndTimes(shots,recognition),end=ends.find(item=>item.shotId==='s2')
    assert.ok(end,`the ${internal?'internal token':'segment'} boundary must recover without rewriting the quotation`)
    assert.ok(end.confidence<.6)
    assert.match(end.warnings?.join('') || '',/同音/)
    const allTokens=recognition.transcription.flatMap(segment=>segment.tokens)
    const last=allTokens.findIndex(token=>token.text===(internal?'外':'善'))
    assert.equal(end.endMs,allTokens[last+1].offsets.from)
    assert.equal(buildMotionAlignedCaptions(shots,recognition,20).map(item=>item.text).join(''),shots.map(item=>item.narration).join(''))
  }
})

test('phonetic recovery rejects semantic replacement, missing speech and an unmeasured cut',()=>{
  for(const mode of ['wrong-sound','deleted','no-gap','coarse','tail-mismatch','weak-context']) {
    const {shots,recognition}=classicalHomophoneFixture(true)
    const target=recognition.transcription[1],tail=target.tokens.findIndex(token=>token.text==='外')
    if(mode==='wrong-sound')target.tokens.slice(0,6).forEach(token=>{token.text='错'})
    if(mode==='deleted')target.tokens.splice(2,2)
    if(mode==='no-gap')target.tokens[tail+1].offsets.from=target.tokens[tail].offsets.to
    if(mode==='coarse')for(const token of target.tokens)delete (token as any).offsets
    if(mode==='tail-mismatch')target.tokens[tail].text='歪'
    if(mode==='weak-context')recognition.transcription[0].tokens.forEach(token=>{token.text='错'})
    assert.equal(alignMotionShotEndTimes(shots,recognition).some(item=>item.shotId==='s2'),false,mode)
  }
})

test('an unavailable optional ICU converter keeps strict matching and reports the missing capability',()=>{
  const moduleUrl=new URL('./history-motion-audio-align.ts',import.meta.url).href
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import {alignMotionShotEndTimes} from ${JSON.stringify(moduleUrl)};
    const shots=[{shotId:'s1',narration:'彭德怀主张继续打刘伯承认为应当暂缓进攻。'},{shotId:'s2',narration:'关家垴战斗需要审慎判断。'}];
    const recognition={transcription:[{offsets:{from:0,to:5000},text:'彭德懷主張繼續打劉伯承認為應當暫緩進攻關家垴戰鬥需要審慎判斷'}]};
    console.log(JSON.stringify(alignMotionShotEndTimes(shots,recognition)));
  `],{encoding:'utf8',env:{...process.env,HISTORY_ALIGNMENT_UCONV:'/missing/history-alignment-uconv'},timeout:10000})
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()),[])
  assert.match(result.stderr,/HISTORY_ALIGNMENT_UCONV/)
})
