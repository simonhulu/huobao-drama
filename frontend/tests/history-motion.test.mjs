import test from 'node:test'
import assert from 'node:assert/strict'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium} from 'playwright'
const base=process.env.HISTORY_UI_TEST_URL || 'http://127.0.0.1:3013'
const root='/api/v1/history-scripts', motion=`${root}/motion`, revision='a'.repeat(64)
const source={id:101,title:'长平之战',sourceUrl:'https://www.douyin.com/video/101',category:'historical_anecdote',status:'needs_review',rewrittenScript:'秦赵两军在长平交战。',revision,correctedTranscript:'史料。',rawTranscript:'转写。',metricsJson:'{}',mediaJson:'{}',reviewJson:'{}',selectionJson:'{}',artifactState:{transcript:'current',corrected:'current',rewritten:'current'}}
const fixture=()=>({id:'motion-1',scriptId:101,title:source.title,scriptRevision:revision,profile:'16:9',status:'needs_review',updatedAt:'2026-10-24T08:00:00Z',plan:null,requested:{shots:[{shotId:'shot-1',narration:source.rewrittenScript,duration:6,search:{query:'长平 秦赵'},reviewReason:'需要确认时代。'}]},candidates:{'shot-1':[{assetId:'asset-1',rank:1,description:'战国军队在山口驻守，远景',duration:8,width:1920,height:1080,fps:30}]}})
const completedFixture=()=>({...fixture(),status:'completed',stage:'rendered',plan:{
 shots:['video','map','image','graphic'].map((visualType,index)=>({shotId:`shot-${index+1}`,narration:['秦赵两军在长平交战。','赵军退路逐渐被切断。','粮道上的百姓避开战火。','断粮与包围共同改变了战局。'][index],duration:6,status:'ready',visualType,hasVideo:visualType==='video',hasImage:visualType==='image',fallbackReason:index===3?'生图服务超时，自动切换为因果关系动效。':undefined})),
 soundEffects:[{sourceName:'战场冲击'},{sourceName:'行军脚步'}],
 fallbacks:[{shotId:'shot-4',stage:'image',reason:'生图服务超时：/Users/private/generated/shot-4.png，已切换为信息动效。'}],
 deliveryAssociation:{status:'attached',videoUrl:`${root}/101/delivery/video`,message:'本次成片已关联。'},
}})
async function harness(t,jobs=[],options={}){
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
 const page=await browser.newPage({viewport:options.viewport || {width:1440,height:1000}});page.setDefaultTimeout(7000)
 if(options.clock)await page.clock.install()
 await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({contentType:'text/css',body:''}))
 const state={jobs,writes:[],errors:[],unexpected:[],motionReads:0,deliveryReads:0,pendingAssociation:null,associationStatuses:[...(options.associationStatuses || ['attached'])],deliveryVideoUrl:options.deliveryVideoUrl || null,deliveryVideos:options.deliveryVideos || []};page.on('pageerror',e=>state.errors.push(e.message))
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,send=data=>route.fulfill({json:{code:200,data}})
  if(path.startsWith(motion)){
   if(request.method()==='GET'){
    if(path.includes('/assets/') || path.endsWith('/video'))return route.fulfill({contentType:'video/mp4',body:''})
    state.motionReads++
    if(state.pendingAssociation){
     const job=state.jobs[0],status=state.pendingAssociation;state.pendingAssociation=null
     job.plan ||= {};job.plan.deliveryAssociation={status,videoUrl:status==='existing_preserved'?'/static/old-delivery.mp4':`${root}/101/delivery/video`,message:status==='failed'?'复制视频失败，请重试。':status==='existing_preserved'?'原有交付成片已保留。':'本次成片已关联。'}
     job.status=status==='failed'?'failed':'completed';job.stage='rendered';job.message=status==='failed'?'关联失败，成片已保留。':'关联完成。'
     if(status==='attached')state.deliveryVideoUrl=`${root}/101/delivery/video`
    }
    return send({jobs:state.jobs})
   }
   const body=request.postDataJSON();state.writes.push({path,body})
   if(path.endsWith('/produce')){const job=fixture();job.status='queued';job.message='等待制作';job.requested.shots[0].visualType='auto';if(options.unified)job.factory={episodeId:2001,projectId:3001};state.jobs=[job];return send(options.unified?{job,url:'/remotion/episode/2001'}:job)}
   const job=state.jobs[0]
   if(path.endsWith('/select')){Object.assign(job.requested.shots[0],{reviewReason:null,selection:body});return send(job)}
   if(path.endsWith('/search')){job.requested.shots[0].search.query=body.query;job.status='needs_review';return send(job)}
   if(path.endsWith('/retry')){
    job.plan={shots:[{...(job.requested.shots[0] || fixture().requested.shots[0]),status:'ready',visualType:'map',mapPackId:'changping',fallbackReason:'本地镜头不足，自动切换为地图推演。'}],soundEffects:[{sourceName:'战场冲击'}],fallbacks:[{shotId:'shot-1',stage:'video',reason:'本地镜头不足，自动切换为地图推演。'}]}
    job.status='completed';job.stage='rendered';job.plan.deliveryAssociation={status:'attached',videoUrl:`${root}/101/delivery/video`,message:'本次成片已关联。'};state.deliveryVideoUrl=`${root}/101/delivery/video`;return send(job)
   }
   if(path.endsWith('/deliver')){
    state.pendingAssociation=state.associationStatuses.shift() || 'attached'
    job.status='queued';job.stage='rendered';job.message='等待关联成片'
    return send(job)
   }
   state.unexpected.push(path);return route.fulfill({status:404,json:{code:404,message:'Unexpected write'}})
  }
  if(request.method()!=='GET'){state.unexpected.push(path);return route.fulfill({status:405,json:{code:405,message:'Unexpected write'}})}
  if(path==='/api/v1/remotion/episodes/2001/history-production')return send({episode:{id:2001,title:'长平之战',script:source.rewrittenScript,profile:'16:9',dramaId:1001,episodeNumber:1},job:state.jobs[0],shots:[],outputs:[],sourceId:101,links:{source:'/history-scripts?script=101',episode:'/drama/1001/episode/1'},url:'/remotion/episode/2001'})
  if(path===root)return send({items:[source],total:1})
  if(path===`${root}/101`)return send(source)
  if(path.endsWith('/browser-session'))return send({session:{status:'ready',canCollect:true,checks:[]}})
  if(path.endsWith('/huasheng'))return send({jobs:[],enabled:false,browser:{status:'ready'},productionChecking:false})
  if(path.endsWith('/huasheng/exports'))return send({jobs:[],enabled:false})
  if(path===`${root}/jobs`)return send({job:null,recent:[],total:0,hasMore:false})
  if(path.endsWith('/delivery')){state.deliveryReads++;return send({title:'',description:'',covers:{},coverStatus:'idle',designStatus:'idle',videoUrl:state.deliveryVideoUrl,videos:state.deliveryVideos})}
  if(path.endsWith('/delivery/video') || /\/delivery\/videos\/\d+$/.test(path))return route.fulfill({contentType:'video/mp4',body:''})
  if(path.endsWith('/article'))return send({status:'idle',canGenerate:false})
  return send({items:[],jobs:[],ready:true})
 })
 await page.goto(`${base}/history-scripts?script=101&view=library`,{waitUntil:'domcontentloaded'})
 await page.getByRole('textbox',{name:'编辑待审稿',exact:true}).waitFor()
 return {page,state}
}
const openDetail=page=>page.getByRole('tablist',{name:'稿件内容',exact:true}).getByRole('tab',{name:'精细化制作',exact:true}).click()
const panel=page=>page.getByRole('region',{name:'当前稿精细化制作',exact:true})
test('saved script starts the unified task and opens its Remotion detail',async t=>{
 const {page,state}=await harness(t,[],{unified:true});await openDetail(page)
 await panel(page).getByRole('button',{name:'制作当前稿',exact:true}).click()
 await page.waitForURL('**/remotion/episode/2001')
 await page.getByRole('heading',{name:'长平之战',exact:true}).waitFor()
 assert.deepEqual(state.writes,[{path:`${motion}/101/produce`,body:{scriptRevision:revision,profile:'16:9'}}])
 assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[])
})
test('old review task continues automatically, reports the visual pipeline and refreshes parent delivery',async t=>{
 const job=fixture();const {page,state}=await harness(t,[job]);await openDetail(page);const ui=panel(page)
 await ui.getByText('可继续自动制作',{exact:true}).waitFor()
 const beforeDelivery=state.deliveryReads
 await ui.getByRole('button',{name:'继续自动制作',exact:true}).click();await ui.getByText('制作完成',{exact:true}).waitFor()
 await ui.getByRole('button',{name:'查看分镜',exact:true}).click()
 await ui.getByText('地图推演',{exact:true}).waitFor();await ui.getByText('1 处音效',{exact:true}).waitFor();await ui.getByText('自动降级记录（1）',{exact:true}).waitFor()
 assert.deepEqual(state.writes.map(w=>w.path),[`${motion}/101/jobs/motion-1/retry`])
 assert.ok(state.deliveryReads>beforeDelivery,'automatic completion must refresh the parent delivery component')
 await page.waitForFunction(()=>document.querySelector('#history-delivery-101 video')?.getAttribute('src')==='/api/v1/history-scripts/101/delivery/video')
 assert.equal(await ui.getByRole('link',{name:'查看本次成片'}).getAttribute('href'),`${motion}/101/jobs/motion-1/video`)
 assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[])
})
test('Huasheng and refined editions remain independently previewable without replacing the saved manuscript',async t=>{
 const editions=[{id:1,producer:'huasheng',videoUrl:`${root}/101/delivery/videos/1`,videoName:'花生版.mp4'},{id:2,producer:'motion',videoUrl:`${root}/101/delivery/videos/2`,videoName:'精细化版.mp4'}]
 const {page,state}=await harness(t,[completedFixture()],{deliveryVideos:editions,deliveryVideoUrl:'/static/legacy.mp4'})
 await page.getByRole('textbox',{name:'编辑待审稿',exact:true}).fill('尚未保存的旁白修改。')
 const tabs=page.getByRole('tablist',{name:'稿件内容',exact:true});await tabs.getByRole('tab',{name:'成片与封面',exact:true}).click()
 const versions=page.getByRole('group',{name:'成片版本',exact:true})
 assert.equal(await versions.getByRole('button').count(),2)
 for(const edition of editions){
  const label=edition.producer==='huasheng'?'花生版':'精细化版'
  await versions.getByRole('button',{name:new RegExp(`^${label}`)}).click()
  assert.equal(await page.getByLabel(`${label}预览`,{exact:true}).getAttribute('src'),edition.videoUrl)
  assert.equal(await page.getByRole('link',{name:'下载此版本',exact:true}).getAttribute('href'),edition.videoUrl)
  assert.equal(await versions.getByRole('button',{name:new RegExp(`^${label}`)}).getAttribute('aria-pressed'),'true')
 }
 await tabs.getByRole('tab',{name:'文稿',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'编辑待审稿',exact:true}).inputValue(),'尚未保存的旁白修改。')
 assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[])
})
test('preserved existing delivery is explicit and never replaces the new movie link',async t=>{
 const job=fixture();job.stage='rendered'
 const {page,state}=await harness(t,[job],{clock:true,associationStatuses:['existing_preserved'],deliveryVideoUrl:'/static/old-delivery.mp4'})
 await openDetail(page);const ui=panel(page)
 await ui.getByRole('button',{name:'关联成片',exact:true}).click()
 await ui.getByText('等待关联',{exact:true}).waitFor();await page.clock.runFor(5100)
 await ui.getByText('已保留原有交付成片',{exact:true}).waitFor()
 await ui.getByText('“成片与封面”保留原有视频；本次输出请点击“查看本次成片”。',{exact:true}).waitFor()
 assert.equal(await ui.getByRole('link',{name:'查看本次成片',exact:true}).getAttribute('href'),`${motion}/101/jobs/motion-1/video`)
 assert.equal(await ui.locator('a[href="/static/old-delivery.mp4"]').count(),0)
 assert.equal(await ui.getByRole('button',{name:'关联成片',exact:true}).count(),0)
 assert.equal(state.deliveryVideoUrl,'/static/old-delivery.mp4')
 assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[])
})
test('association failure retains the rendered movie and retries delivery without rendering again',async t=>{
 const job=fixture();job.stage='rendered'
 const {page,state}=await harness(t,[job],{clock:true,associationStatuses:['failed','attached']});await openDetail(page);const ui=panel(page)
 await ui.getByRole('button',{name:'关联成片',exact:true}).click()
 await ui.getByText('等待关联',{exact:true}).waitFor();assert.equal(await ui.getByRole('button',{name:'关联中…',exact:true}).isDisabled(),true);await page.clock.runFor(5100)
 await ui.getByRole('status',{name:'成片交付状态',exact:true}).getByText('交付关联失败',{exact:true}).waitFor()
 assert.equal(await ui.getByText('制作完成',{exact:true}).count(),0)
 assert.equal(await ui.getByRole('link',{name:'查看本次成片',exact:true}).getAttribute('href'),`${motion}/101/jobs/motion-1/video`)
 await ui.getByRole('button',{name:'重试关联成片',exact:true}).click()
 await ui.getByText('等待关联',{exact:true}).waitFor();await ui.getByRole('status',{name:'成片交付状态',exact:true}).getByText('正在关联成片',{exact:true}).waitFor();await page.clock.runFor(5100)
 await ui.getByText('已关联成片与封面',{exact:true}).waitFor()
 assert.deepEqual(state.writes.map(write=>write.path),[`${motion}/101/jobs/motion-1/deliver`,`${motion}/101/jobs/motion-1/deliver`])
 assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[])
})
test('candidate query and source narration remain distinct from a missing visual description',async t=>{
 const job=fixture();Object.assign(job.candidates['shot-1'][0],{description:'',query:'1934年红军在瑞金街头行进',shotText:'红军随后离开瑞金。'})
 const {page,state}=await harness(t,[job]);await openDetail(page);const ui=panel(page)
 await ui.getByRole('button',{name:'查看分镜'}).click()
 await ui.getByText('手动调整素材（可选）',{exact:true}).click()
 const candidate=ui.locator('.candidate').first()
 await candidate.getByText('未提供画面描述',{exact:true}).waitFor()
 assert.equal(await candidate.locator('.candidate-description').count(),0)
 assert.equal(await candidate.locator('.candidate-annotation').textContent(),'原检索标注（非画面描述）：1934年红军在瑞金街头行进')
 assert.equal(await candidate.locator('.candidate-context').textContent(),'原分镜文稿（非画面描述）：红军随后离开瑞金。')
 assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[])
})
test('unsaved manuscript cannot start production',async t=>{
 const {page,state}=await harness(t);await page.getByRole('textbox',{name:'编辑待审稿',exact:true}).fill('尚未保存的修改。');await openDetail(page)
 await panel(page).getByText('请先保存文稿修改，再开始制作。').waitFor();assert.equal(await panel(page).getByRole('button',{name:'制作当前稿',exact:true}).isDisabled(),true);assert.deepEqual(state.writes,[])
})
test('channel switch retains Huasheng and lists local jobs',async t=>{
 const {page,state}=await harness(t,[fixture()]);await page.getByRole('tablist',{name:'历史脚本工作区',exact:true}).getByRole('tab',{name:/^视频制作/}).click()
 const channels=page.getByRole('group',{name:'视频创作渠道',exact:true});assert.equal(await channels.getByRole('button',{name:'花生制作',exact:true}).getAttribute('aria-pressed'),'true')
 await channels.getByRole('button',{name:/精细化制作/}).click();await page.getByRole('region',{name:'精细化制作队列',exact:true}).getByRole('button',{name:'长平之战',exact:true}).waitFor()
 assert.equal(new URL(page.url()).searchParams.get('channel'),'motion');await channels.getByRole('button',{name:'花生制作',exact:true}).click()
 assert.equal(await page.getByRole('region',{name:'花生自动制作',exact:true}).isVisible(),true);assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[])
})
test('optional candidate search does not block automatic production when no candidates are found',async t=>{
 const job=fixture();job.candidates['shot-1']=[];const {page,state}=await harness(t,[job]);await openDetail(page);const ui=panel(page)
 await ui.getByRole('button',{name:'查看分镜'}).click();await ui.getByText('手动调整素材（可选）',{exact:true}).click();await ui.getByLabel('重新检索素材',{exact:true}).fill('战国 远景');await ui.getByRole('button',{name:'检索',exact:true}).click()
 await ui.getByText('检索：战国 远景',{exact:true}).waitFor();assert.deepEqual(state.writes[0],{path:`${motion}/101/jobs/motion-1/search`,body:{shotId:'shot-1',query:'战国 远景'}})
 assert.equal(await ui.getByRole('button',{name:'继续自动制作',exact:true}).isDisabled(),false);assert.deepEqual(state.errors,[])
})

test('automatic completion detected by polling refreshes parent delivery exactly once',async t=>{
 const {page,state}=await harness(t,[],{clock:true});await openDetail(page);const ui=panel(page)
 await ui.getByRole('button',{name:'制作当前稿',exact:true}).click();await ui.locator('.status.queued').waitFor()
 await ui.getByRole('button',{name:'查看分镜',exact:true}).click();assert.equal(await ui.locator('[aria-label="实际画面类型"]').innerText(),'自动编排中')
 assert.deepEqual(state.writes,[{path:`${motion}/101/produce`,body:{scriptRevision:revision,profile:'16:9'}}])
 const beforeDelivery=state.deliveryReads,beforePoll=state.motionReads
 state.jobs=[completedFixture()];state.deliveryVideoUrl=`${root}/101/delivery/video`
 await page.clock.runFor(5100);await ui.getByText('制作完成',{exact:true}).waitFor()
 await page.waitForFunction(()=>document.querySelector('#history-delivery-101 video')?.getAttribute('src')==='/api/v1/history-scripts/101/delivery/video')
 assert.ok(state.motionReads>beforePoll,'completion must arrive through the status poll')
 assert.equal(state.deliveryReads,beforeDelivery+1,'completion must trigger one parent refresh')
 await page.clock.runFor(5100);await ui.getByRole('button',{name:'刷新精细化制作任务',exact:true}).click()
 assert.equal(state.deliveryReads,beforeDelivery+1,'repeated reads of the same completion must not refresh again')
 assert.equal(await ui.getByRole('button',{name:/确认|开始渲染/}).count(),0)
 assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[])
})

test('initial completed jobs establish a baseline without repeated parent delivery refreshes',async t=>{
 const {page,state}=await harness(t,[completedFixture()],{clock:true,deliveryVideoUrl:`${root}/101/delivery/video`})
 await page.waitForFunction(()=>document.querySelector('#history-delivery-101 video')?.getAttribute('src')==='/api/v1/history-scripts/101/delivery/video')
 const beforeDelivery=state.deliveryReads
 await openDetail(page);const ui=panel(page);await ui.getByText('制作完成',{exact:true}).waitFor()
 const completedButton=ui.getByRole('button',{name:'本稿已制作',exact:true});assert.equal(await completedButton.isDisabled(),true)
 assert.equal(await ui.getByRole('button',{name:'制作当前稿',exact:true}).count(),0)
 await ui.getByLabel('精细化视频画幅').selectOption('9:16')
 const alternateProfileButton=ui.getByRole('button',{name:'制作当前稿',exact:true});assert.equal(await alternateProfileButton.isDisabled(),false)
 assert.equal(state.deliveryReads,beforeDelivery,'initial task read must not emit delivery-change')
 await page.clock.runFor(10100);await ui.getByRole('button',{name:'刷新精细化制作任务',exact:true}).click()
 assert.equal(state.deliveryReads,beforeDelivery,'unchanged completed tasks must not repeatedly emit delivery-change')
 assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[])
})

test('legacy tasks without any planned shots can resume without a readiness gate',async t=>{
 const job=fixture();job.requested.shots=[];job.candidates={}
 const {page,state}=await harness(t,[job]);await openDetail(page);const resume=panel(page).getByRole('button',{name:'继续自动制作',exact:true})
 assert.equal(await resume.isDisabled(),false);await resume.click();await panel(page).getByText('制作完成',{exact:true}).waitFor()
 assert.deepEqual(state.writes,[{path:`${motion}/101/jobs/motion-1/retry`,body:{}}]);assert.deepEqual(state.errors,[])
})

test('failed task permits optional footage adjustment with an empty reason and valid trims',async t=>{
 const job=fixture();job.status='failed';job.error='素材文件不可用'
 const {page,state}=await harness(t,[job]);await openDetail(page);const ui=panel(page)
 await ui.getByRole('button',{name:'查看分镜',exact:true}).click();await ui.getByText('手动调整素材（可选）',{exact:true}).click();await ui.getByRole('button',{name:'使用此镜头',exact:true}).click()
 assert.equal(await ui.getByLabel('选择理由（可选）',{exact:true}).inputValue(),'')
 await ui.getByLabel('出点（秒）',{exact:true}).fill('99');const save=ui.getByRole('button',{name:'保存素材调整',exact:true});assert.equal(await save.isDisabled(),true)
 await ui.getByLabel('出点（秒）',{exact:true}).fill('6');assert.equal(await save.isDisabled(),false);await save.click()
 assert.deepEqual(state.writes,[{path:`${motion}/101/jobs/motion-1/select`,body:{shotId:'shot-1',assetId:'asset-1',inPoint:0,outPoint:6,crop:'center',reason:'',shortfallPolicy:'reject'}}])
 assert.deepEqual(state.unexpected,[]);assert.deepEqual(state.errors,[])
})

test('actual visual types, sound count and fallback reasons are shown without exposing local paths',async t=>{
 const job=completedFixture();job.message='渲染输出 /Users/private/render/movie.mp4 已关联';job.error='音效降级：C:\\private\\sound.mp3'
 const {page,state}=await harness(t,[job]);await openDetail(page);const ui=panel(page)
 await ui.getByText('2 处音效',{exact:true}).waitFor();await ui.getByRole('button',{name:'查看分镜',exact:true}).click()
 const list=ui.getByRole('group',{name:'选择分镜',exact:true})
 for(const label of ['素材视频','地图推演','生成图片','信息动效']){
  const shot=list.getByRole('button').filter({hasText:label});await shot.click();assert.equal(await ui.locator('[aria-label="实际画面类型"]').innerText(),label)
 }
 await ui.getByText('自动降级：生图服务超时，自动切换为因果关系动效。',{exact:true}).waitFor()
 await ui.getByText('自动降级记录（1）',{exact:true}).click();await ui.getByText('分镜 04 · 图片生成',{exact:true}).waitFor()
 assert.equal((await ui.textContent()).includes('/Users/private'),false);assert.equal((await ui.textContent()).includes('C:\\private'),false)
 assert.equal(await ui.getByText('没有找到符合条件的已下载素材。请补充素材后重试制作。',{exact:true}).count(),0)
 assert.deepEqual(state.writes,[]);assert.deepEqual(state.errors,[])
})

for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
 test(`motion production controls fit ${viewport.width}px without horizontal overflow`,async t=>{
  const {page,state}=await harness(t,[completedFixture()],{viewport});await openDetail(page);const ui=panel(page)
  await ui.getByRole('button',{name:'查看分镜'}).click();await ui.getByRole('group',{name:'选择分镜',exact:true}).getByRole('button').last().click();await ui.getByText('自动降级记录（1）',{exact:true}).click()
  const dimensions=await ui.evaluate(element=>({documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,viewport:innerWidth,panelWidth:element.clientWidth,panelScroll:element.scrollWidth,detailWidth:element.querySelector('.shot-detail').clientWidth,detailScroll:element.querySelector('.shot-detail').scrollWidth}))
  assert.ok(dimensions.documentWidth<=dimensions.viewport+1,JSON.stringify(dimensions));assert.ok(dimensions.bodyWidth<=dimensions.viewport+1,JSON.stringify(dimensions));assert.ok(dimensions.panelScroll<=dimensions.panelWidth+1,JSON.stringify(dimensions));assert.ok(dimensions.detailScroll<=dimensions.detailWidth+1,JSON.stringify(dimensions))
  const screenshot=join(tmpdir(),`history-motion-${viewport.width}.png`)
  await page.screenshot({path:screenshot,fullPage:false,animations:'disabled'});t.diagnostic(screenshot)
  await ui.locator('.shot-detail').screenshot({path:join(tmpdir(),`history-motion-detail-${viewport.width}.png`),animations:'disabled'})
  assert.deepEqual(state.errors,[])
 })
}
