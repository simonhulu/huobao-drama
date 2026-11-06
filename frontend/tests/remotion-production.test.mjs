import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const base = process.env.REMOTION_UI_TEST_URL || 'http://127.0.0.1:3013'
const detail = () => ({ deletionSupported:true,episode: {id: 42, title: '长平之战：秦赵攻守如何逆转，四十万大军为什么被困在长平',script:'秦赵两国在长平相持。赵军出击后，秦军切断了退路。',profile:'16:9',dramaId:8,episodeNumber:3},job:null,shots:[],outputs:[],sourceId:7,links:{episode:'/drama/8/episode/3',source:'/history-scripts?sourceId=7'}})
const job = (status, extra={}) => ({id:'factory-job-42',status,stage:status === 'failed' ? 'rendered' : 'planning',message:status === 'failed' ? '成片已生成，但关联失败；可以重试关联，不会重新渲染' : '正在设计分镜与视觉表达',updatedAt:'2026-10-26T10:00:00Z',plan:{},...extra})
const edition = (state, extra={}) => ({key:'7:current:motion',scriptId:7,scriptSha256:'a'.repeat(64),producer:'motion',videoId:53,state,stage:'publication',message:'',error:null,action:'none',jobId:null,exportJobId:null,automatic:true,canPublish:false,videoAvailable:true,materialsReady:true,confirmedAt:null,...extra})
async function harness() {
 const browser = await chromium.launch({headless:true})
 const page = await browser.newPage({viewport:{width:1440,height:1000}})
 page.setDefaultTimeout(8000)
 page.setDefaultNavigationTimeout(30000)
 const state = { detail:detail(), deletionSupported:true, gets:0, posts:[], deletes:[], deleted:false, deleteError:'', fail:false, postError:'', errors:[], snapshots:[], uploadJobs:[], uploadQueue:{}, uploadFail:false, publicationReads:0, production:{scriptId:7,scriptSha256:'a'.repeat(64),productionMode:'dual',versions:[],complete:false,productionComplete:false} }
 page.on('pageerror',e => state.errors.push(e.message))
 await page.route('**/api/v1/**',async route => {
   const url = new URL(route.request().url()), method = route.request().method()
   let data = {items:[],total:0}
   if (url.pathname === `/api/v1/history-scripts/uploads/sources/${state.detail.sourceId}/state`) {
     assert.equal(method,'GET')
     state.publicationReads++
     if (state.uploadFail) return route.fulfill({status:503,json:{code:503,message:'上传状态暂不可用'}})
     data = {production:state.production,jobs:state.uploadJobs,queue:state.uploadQueue}
   }
   if (url.pathname === '/api/v1/remotion/history-productions') data = {deletionSupported:state.deletionSupported,items:state.deleted ? [] : [{episodeId:42,dramaId:8,episodeNumber:3,title:state.detail.episode.title,dramaTitle:'战国故事',accountName:'历史账号',status:state.detail.job?.status || 'draft',stage:state.detail.job?.stage || '',message:state.detail.job?.message,jobId:state.detail.job?.id,videoUrl:state.detail.outputs[0]?.url,shotCount:state.detail.shots.length,readyShotCount:state.detail.shots.length,updatedAt:'2026-10-26T10:00:00Z'}]}
   if (url.pathname === '/api/v1/remotion/episodes/42/history-production' && method === 'DELETE') {
      state.deletes.push(url.pathname)
      if (state.deleteError) return route.fulfill({status:409,json:{code:409,message:state.deleteError}})
      state.deleted=true
      return route.fulfill({json:{code:200,data:{episodeId:42,deleted:true}}})
   }
   if (url.pathname.startsWith('/api/v1/remotion/episodes/42/history-production')) {
      if (method === 'POST') {state.posts.push({path:url.pathname,body:route.request().postDataJSON()}); if (state.postError) return route.fulfill({status:400,json:{code:400,message:state.postError}}); state.detail.job = job('planning')}
      else {state.gets++; if (state.fail) return route.fulfill({status:503,json:{code:503,message:'制作服务暂时不可用'}})}
      data = state.detail
   }
   await route.fulfill({json:{code:200,data}})
 })
 return {browser,page,state}
}

test('completed work shows its own queued publication rather than the other version receipt',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{sourceDelivery:{videoId:53}}}})
   h.state.production.versions=[edition('published',{producer:'huasheng',videoId:56,jobId:'223'}),edition('queued',{jobId:'221'})]
   h.state.uploadJobs=[{id:'223',videoId:56,target:'baijiahao-video',mode:'publish',status:'published',result:{articleId:'other-version'}},{id:'221',videoId:53,target:'baijiahao-video',mode:'publish',status:'queued'}]
   h.state.uploadQueue={runningJobId:'218',paused:false}
   await h.page.goto(`${base}/remotion/episode/42`,{waitUntil:'domcontentloaded',timeout:30000})
   const status=h.page.locator('.publication-status')
   await status.getByText('等待自动上传',{exact:true}).waitFor()
   await status.getByText('前序作品正在上传，轮到本片会自动继续',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/已发表|other-version/)
   assert.equal(await status.getByRole('link',{name:'查看发表队列'}).getAttribute('href'),'/history-scripts?view=uploads&script=7&videoId=53')
   assert.ok(h.state.publicationReads>0)
   await fs.mkdir('.impeccable/review',{recursive:true})
   await h.page.screenshot({path:'.impeccable/review/remotion-publication-desktop.png',fullPage:true,timeout:30000})
   await h.page.setViewportSize({width:390,height:844})
   await status.scrollIntoViewIfNeeded()
   assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth))
   await h.page.screenshot({path:'.impeccable/review/remotion-publication-mobile.png',fullPage:true,timeout:30000})
   assert.deepEqual(h.state.posts,[])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('publication refresh distinguishes review from public success and retains the last receipt on failure',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:53}}})
   h.state.production.versions=[edition('uploading',{jobId:'221',message:'正在上传视频'})]
   h.state.uploadJobs=[{id:'221',videoId:53,target:'baijiahao-video',mode:'publish',status:'running',message:'正在上传视频'},{id:'999',videoId:53,target:'baijiahao-video',mode:'publish',status:'published',result:{articleId:'wrong-newer-job'}}]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('正在自动发表',{exact:true}).waitFor()
   h.state.uploadJobs[0]={...h.state.uploadJobs[0],status:'submitted',message:'已提交百家号，等待审核',result:{articleId:'receipt-123'}}
   h.state.production.versions=[edition('submitted',{jobId:'221',message:'已提交百家号，等待审核'})]
   await status.getByRole('button',{name:'刷新百家号发表状态'}).click()
   await status.getByText('已提交，等待审核',{exact:true}).waitFor()
   await status.getByText('作品 ID：receipt-123',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/wrong-newer-job/)
   assert.equal(await status.getByText('已发表',{exact:true}).count(),0)
   h.state.uploadFail=true
   await status.getByRole('button',{name:'刷新百家号发表状态'}).click()
   await status.getByText('刷新失败，保留上次发表状态',{exact:true}).waitFor()
   await status.getByText('已提交，等待审核',{exact:true}).waitFor()
   h.state.uploadFail=false
   h.state.uploadJobs[0].status='published'
   h.state.production.versions=[edition('published',{jobId:'221'})]
   await status.getByRole('button',{name:'刷新百家号发表状态'}).click()
   await status.getByText('已发表',{exact:true}).waitFor()
   assert.deepEqual(h.state.posts,[])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('publication errors link to the original task and never infer another version was uploaded',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:53}}})
   h.state.production.versions=[edition('packaging',{stage:'packaging',message:'正在准备本版标题和封面',materialsReady:false})]
   h.state.uploadJobs=[{id:'222',videoId:99,target:'baijiahao-video',mode:'publish',status:'published'}]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('发布材料准备中',{exact:true}).waitFor()
   await status.getByText('正在准备本版标题和封面',{exact:true}).waitFor()
   h.state.uploadJobs.push({id:'221',videoId:53,target:'baijiahao-video',mode:'publish',status:'uncertain',error:'平台回执尚未确认'})
   h.state.production.versions=[edition('uncertain',{jobId:'221',action:'reconcile',error:'平台回执尚未确认'})]
   await status.getByRole('button',{name:'刷新百家号发表状态'}).click()
   await status.getByText('发表结果待核对',{exact:true}).waitFor()
   await status.getByText('平台回执尚未确认',{exact:true}).waitFor()
   await status.getByRole('link',{name:'查看并继续原发表任务'}).waitFor()
   assert.deepEqual(h.state.posts,[])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('material failures are visible before an upload exists and link to the exact edition',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:53}}})
   h.state.production.versions=[edition('attention',{stage:'packaging',action:'retry_packaging',materialsReady:false,error:'横版封面生成失败，原视频已保留'})]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('发布材料需处理',{exact:true}).waitFor()
   await status.getByText('横版封面生成失败，原视频已保留',{exact:true}).waitFor()
   assert.equal(await status.getByRole('link',{name:'查看并继续发布准备'}).getAttribute('href'),'/history-scripts?view=uploads&script=7&videoId=53')
   assert.doesNotMatch(await status.innerText(),/尚无本版发表任务|自动发表/)
   for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
     await h.page.setViewportSize({width,height})
     await status.scrollIntoViewIfNeeded()
     assert.ok(await h.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth))
     await fs.mkdir('.impeccable/review',{recursive:true})
     await h.page.screenshot({path:`.impeccable/review/remotion-publication-material-failure-${name}.png`,fullPage:true})
   }
   assert.deepEqual(h.state.posts,[])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('an independent production reads its current stage without promising automatic publication',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('planning')
   h.state.production.productionMode=null
   h.state.production.versions=[edition('producing',{videoId:null,stage:'production',automatic:false,videoAvailable:false,materialsReady:false,message:'正在准备精细化镜头'})]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('制作中',{exact:true}).waitFor()
   await status.getByText('正在准备精细化镜头',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/自动发表|自动上传/)
   assert.equal(await status.getByRole('link',{name:'查看发表队列'}).getAttribute('href'),'/history-scripts?view=uploads&script=7')
   h.state.production.versions=[edition('queued',{automatic:false,jobId:'225',message:'本版已明确加入发表队列'})]
   await status.getByRole('button',{name:'刷新百家号发表状态'}).click()
   await status.getByText('等待提交',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/自动发表|自动上传/)
   assert.deepEqual(h.state.posts,[])
 }finally{await h.browser.close()}
})

test('a ready render revision requires explicit submission and never borrows its previous receipt',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:54}}})
   h.state.production.versions=[edition('ready',{videoId:54,automatic:false,canPublish:true,revisionOfVideoId:53,previousJobId:'221',message:'原成片已提交，本次修订成片需明确选择发表'})]
   h.state.uploadJobs=[{id:'221',videoId:53,target:'baijiahao-video',mode:'publish',status:'submitted',result:{articleId:'previous-receipt'}}]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('修订成片待提交',{exact:true}).waitFor()
   await status.getByText('原成片已提交，本次修订成片需明确选择发表',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/作品 ID|previous-receipt|自动发表|已提交，等待审核/)
   assert.equal(await status.getByRole('link',{name:'查看发表队列'}).getAttribute('href'),'/history-scripts?view=uploads&script=7&videoId=54')
   assert.deepEqual(h.state.posts,[])
 }finally{await h.browser.close()}
})

test('a historical video cannot display the current edition publication state',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:53}}})
   h.state.production.versions=[edition('published',{videoId:54,jobId:'224'})]
   h.state.uploadJobs=[{id:'224',videoId:54,target:'baijiahao-video',mode:'publish',status:'published',result:{articleId:'new-video-receipt'}}]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('历史成片',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/作品 ID|new-video-receipt|已发表/)
   assert.deepEqual(h.state.posts,[])
 }finally{await h.browser.close()}
})

test('an unresolved original submission stays actionable without displaying its receipt as the revision',async()=>{
 const h=await harness()
 try {
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:54}}})
   h.state.production.versions=[edition('attention',{videoId:54,automatic:false,revisionOfVideoId:53,previousJobId:'221',message:'原成片发表结果待核对，请先处理原任务'})]
   h.state.uploadJobs=[{id:'221',videoId:53,target:'baijiahao-video',mode:'publish',status:'uncertain',result:{articleId:'unconfirmed-original'}}]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('原发表任务需处理',{exact:true}).waitFor()
   await status.getByText('原成片发表结果待核对，请先处理原任务',{exact:true}).waitFor()
   await status.getByRole('link',{name:'查看原发表任务',exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/作品 ID|unconfirmed-original|自动发表|已提交，等待审核/)
   assert.deepEqual(h.state.posts,[])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('selecting an archived output does not retain the current video receipt',async()=>{
 const h=await harness()
 try {
   const current='/static/remotion/current.mp4', archived='/static/remotion/archived.mp4'
   h.state.detail.job=job('completed',{plan:{deliveryAssociation:{videoId:54,videoUrl:current}}})
   h.state.detail.outputs=[{id:'new',url:current,kind:'episode',filename:'current.mp4'},{id:'old',url:archived,kind:'episode',filename:'archived.mp4'}]
   h.state.production.versions=[edition('published',{videoId:54,jobId:'224'})]
   h.state.uploadJobs=[{id:'224',videoId:54,target:'baijiahao-video',mode:'publish',status:'published',result:{articleId:'new-video-receipt'}}]
   await h.page.goto(`${base}/remotion/episode/42`)
   const status=h.page.locator('.publication-status')
   await status.getByText('已发表',{exact:true}).waitFor()
   await h.page.getByRole('button',{name:'archived.mp4',exact:true}).click()
   await status.getByText('历史成片',{exact:true}).waitFor()
   assert.doesNotMatch(await status.innerText(),/作品 ID|new-video-receipt|已发表/)
   await h.page.getByRole('button',{name:'current.mp4',exact:true}).click()
   await status.getByText('已发表',{exact:true}).waitFor()
   assert.deepEqual(h.state.posts,[])
 }finally{await h.browser.close()}
})

test('list deletion confirms the Episode and removes only the selected production after backend acknowledgement',async()=>{
 const h=await harness()
 try {
   await h.page.goto(`${base}/remotion`)
   const remove=h.page.getByRole('button',{name:'删除制作任务 Episode 42',exact:true})
   await remove.waitFor()
   h.page.once('dialog',async dialog=>{assert.match(dialog.message(),/Episode 42/);assert.match(dialog.message(),/成片文件和发布记录保留/);await dialog.dismiss()})
   await remove.click()
   assert.deepEqual(h.state.deletes,[])
   h.page.once('dialog',dialog=>dialog.accept())
   await remove.click()
   await h.page.getByRole('heading',{name:'从一篇现成稿件开始',exact:true}).waitFor()
   assert.deepEqual(h.state.deletes,['/api/v1/remotion/episodes/42/history-production'])
   await h.page.getByRole('button',{name:'刷新',exact:true}).click()
   assert.equal(await h.page.getByRole('link',{name:'工作详情',exact:true}).count(),0)
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('a deletion rejected by the backend keeps the task and reports the reason',async()=>{
 const h=await harness()
 try {
   h.state.deleteError='制作正在进行或排队，暂不能删除此任务'
   await h.page.goto(`${base}/remotion`)
   h.page.once('dialog',dialog=>dialog.accept())
   await h.page.getByRole('button',{name:'删除制作任务 Episode 42',exact:true}).click()
   await h.page.getByRole('alert').getByText(h.state.deleteError,{exact:true}).waitFor()
   assert.equal(await h.page.getByRole('link',{name:'工作详情',exact:true}).count(),1)
   assert.deepEqual(h.state.deletes,['/api/v1/remotion/episodes/42/history-production'])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('queued and running productions cannot be deleted from the list',async()=>{
 const h=await harness()
 try {
   for(const status of ['queued','planning','selecting','rendering','validating']) {
     h.state.detail.job=job(status)
     await h.page.goto(`${base}/remotion`)
     assert.equal(await h.page.getByRole('button',{name:'删除制作任务 Episode 42',exact:true}).isDisabled(),true)
   }
   assert.deepEqual(h.state.deletes,[])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('a backend without the new delete endpoint keeps the delete action disabled',async()=>{
 const h=await harness()
 try {
   h.state.deletionSupported=false
   await h.page.goto(`${base}/remotion`)
   assert.equal(await h.page.getByRole('button',{name:'删除制作任务 Episode 42',exact:true}).isDisabled(),true)
   assert.deepEqual(h.state.deletes,[])
 }finally{await h.browser.close()}
})

test('detail deletion uses the same Episode endpoint and returns to the production list',async()=>{
 const h=await harness()
 try {
   await h.page.goto(`${base}/remotion/episode/42`)
   await h.page.getByRole('button',{name:'制作记录',exact:true}).click()
   await h.page.getByText('管理此生产记录',{exact:true}).click()
   await h.page.getByRole('button',{name:'删除生产记录…',exact:true}).click()
   await h.page.getByText('确定删除 Episode 42？',{exact:true}).waitFor()
   await h.page.getByRole('button',{name:'确认删除',exact:true}).click()
   await h.page.waitForURL(`${base}/remotion`)
   assert.deepEqual(h.state.deletes,['/api/v1/remotion/episodes/42/history-production'])
   assert.deepEqual(h.state.errors,[])
 }finally{await h.browser.close()}
})

test('list links to the real detail; start uses backend, locks duplicate execution, and refresh failure retains work',async () => {
 const h = await harness()
 try {
   await h.page.goto(`${base}/remotion`)
   await h.page.getByRole('link',{name:'工作详情'}).click()
   await h.page.getByRole('heading',{name:h.state.detail.episode.title}).waitFor()
   await h.page.getByRole('button',{name:'开始精细化制作',exact:true}).first().click()
   await h.page.getByRole('button',{name:'制作中',exact:true}).waitFor()
   assert.deepEqual(h.state.posts,[{path:'/api/v1/remotion/episodes/42/history-production/start',body:{profile:'16:9'}}])
   assert.equal(await h.page.getByRole('button',{name:'制作中',exact:true}).isDisabled(),true)
   h.state.fail = true
   await h.page.getByRole('button',{name:'刷新',exact:true}).click()
   await h.page.getByRole('alert').getByText(/制作服务暂时不可用/).waitFor()
   assert.equal(await h.page.getByRole('heading',{name:h.state.detail.episode.title}).count(),1)
   await h.page.getByRole('button',{name:'文稿与配音',exact:true}).click()
   await h.page.getByText(h.state.detail.episode.script,{exact:true}).waitFor()
   assert.deepEqual(h.state.errors,[])
 } finally {await h.browser.close()}
})

test('finished media survives delivery failure; retry targets association and reports evidence honestly',async () => {
 const h = await harness()
 try {
   h.state.detail.outputs = [{id:'preview',url:'/static/factory-preview.mp4',kind:'preview',filename:'preview.mp4'},{id:'new',url:'/static/factory-current.mp4',kind:'video',filename:'长平之战.mp4',createdAt:'2026-10-26T10:00:00Z'},{id:'old',url:'/static/factory-old.mp4',kind:'video',filename:'旧版.mp4'}]
   h.state.detail.job = job('failed',{profile:'9:16',error:'原稿交付记录暂时无法保存',plan:{deliveryAssociation:{status:'failed',videoUrl:'/static/factory-current.mp4',previewUrl:'/static/factory-preview.mp4'},delivery:{qa:{technical:'passed'}},automaticDelivery:{visualReview:'not_performed',listeningReview:'not_performed'},fallbacks:[{shotId:'shot-2',stage:'image',reason:'没有匹配的已下载视频，使用生成图片'}],shots:[{shotId:'shot-1',sourcePath:'/materials/战国远景.mp4',originalAnnotation:'古代军队行军',titles:[{text:'长平相持'}]}]}})
   h.state.detail.shots=[{shotId:'shot-1',narration:'秦赵两国在长平相持。',duration:6,purpose:'交代秦赵长期对峙',visualType:'video',status:'ready',sourceNote:'历史题材素材',selection:{assetId:'asset-1',inPoint:1.2,outPoint:7.2,crop:'cover',reason:'远景能交代阵营和规模'},candidatesCount:3},{shotId:'shot-2',narration:'赵军的退路被切断。',duration:4,purpose:'理解退路与包围关系',visualType:'map',status:'ready',sourceNote:'示意地图'}]
   await h.page.goto(`${base}/remotion/episode/42`)
   await h.page.getByRole('button',{name:'重试交付关联',exact:true}).waitFor()
   assert.equal(await h.page.getByRole('link',{name:'下载成片',exact:true}).getAttribute('href'),'/static/factory-current.mp4')
   await h.page.getByText('未记录人工视听回看',{exact:true}).waitFor()
   await h.page.getByText('技术检查通过',{exact:true}).waitFor()
   await h.page.getByRole('button',{name:'带声精选',exact:true}).waitFor()
   await h.page.getByRole('button',{name:'分镜与素材',exact:false}).click()
   await h.page.getByText('交代秦赵长期对峙',{exact:false}).waitFor()
   await h.page.locator('.shot-evidence summary').first().click()
   await h.page.getByText('古代军队行军',{exact:true}).waitFor()
   await h.page.getByText('尚无独立画面核验记录；素材标注不等同于已确认画面。',{exact:true}).waitFor()
   await h.page.getByRole('button',{name:'重试交付关联',exact:true}).click()
   assert.equal(h.state.posts[0].path,'/api/v1/remotion/episodes/42/history-production/retry')
   await h.page.getByRole('button',{name:/旧版.mp4/}).waitFor()
   assert.equal(h.state.posts[0].body.profile,'9:16')
   assert.deepEqual(h.state.errors,[])
 } finally {await h.browser.close()}
})

test('desktop and phone retain core controls without page overflow',async () => {
 const h=await harness()
 try {
   h.state.detail.job = job('planning')
   h.state.detail.shots = [{shotId:'shot-1',narration:'秦赵两国在长平相持。',purpose:'交代秦赵长期对峙',duration:6,visualType:'video',status:'ready'}]
   await fs.mkdir('.impeccable/review',{recursive:true})
   await h.page.goto(`${base}/remotion`)
   await h.page.getByRole('link',{name:'工作详情'}).waitFor()
   await h.page.screenshot({path:'.impeccable/review/remotion-list-desktop.png',fullPage:true})
   await h.page.getByRole('link',{name:'工作详情'}).click()
   await h.page.getByRole('heading',{name:h.state.detail.episode.title}).waitFor()
   await h.page.screenshot({path:'.impeccable/review/remotion-detail-desktop.png',fullPage:true})
   for(const width of [390,768]) {
     await h.page.setViewportSize({width,height:844})
     assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
     await h.page.getByRole('button',{name:'文稿与配音',exact:true}).click()
     await h.page.getByText(h.state.detail.episode.script,{exact:true}).waitFor()
     await h.page.getByRole('button',{name:'成片与交付',exact:true}).click()
     await h.page.screenshot({path:`.impeccable/review/remotion-detail-${width}.png`,fullPage:true})
   }
   await h.page.setViewportSize({width:390,height:844})
   await h.page.goto(`${base}/remotion`)
   await h.page.getByRole('link',{name:'工作详情'}).waitFor()
   assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
   await h.page.screenshot({path:'.impeccable/review/remotion-list-mobile.png',fullPage:true})
   assert.deepEqual(h.state.errors,[])
 } finally {await h.browser.close()}
})

test('visual evidence distinguishes manual samples, automated samples and unavailable review',async () => {
 const h=await harness()
 try {
   const records=[
     {shotId:'manual',sourceEvidence:{observed:{observedImageEvidence:'双手翻阅纸张，只有纸面和手部。',visualMethod:'首中尾拼图',sourceListening:'not_performed'}}},
     {shotId:'sampled',sourceEvidence:{visualEvidence:{status:'sampled',observation:{summary:'两人沿田边行走。',burnedCaptions:{present:false}},reason:'适合环境建立镜头',limitations:'最多两帧，不能证明整段无字幕。'}}},
     {shotId:'unavailable',sourceEvidence:{visualEvidence:{status:'unavailable',reason:'抽帧服务超时',limitations:'未完成画面检查'}}},
     {shotId:'manual-string',sourceEvidence:{observed:'灰制服队伍沿土路行进。',visualReview:'sampled_frames',sourceSubtitlePolicy:'避开底边残留',reviewLimit:'只查看抽帧，未连续播放、未听原声。'}},
   ]
   h.state.detail.job=job('completed',{plan:{shots:records}})
   h.state.detail.shots=records.map(s=>({shotId:s.shotId,narration:'行军与情报',duration:5,visualType:'video',status:'ready'}))
   await h.page.goto(`${base}/remotion/episode/42`)
   await h.page.getByRole('button',{name:'分镜与素材',exact:false}).click()
   for(const row of await h.page.locator('.shot-row').all()) await row.locator('summary').click()
   const texts=await h.page.locator('.shot-evidence').allInnerTexts()
   assert.match(texts[0],/人工抽帧记录（非连续观看）/)
   assert.match(texts[0],/双手翻阅纸张/)
   assert.match(texts[0],/未试听原素材声音/)
   assert.match(texts[1],/自动两帧抽检（非连续观看）/)
   assert.match(texts[1],/抽检帧未见/)
   assert.match(texts[2],/视觉抽检未完成/)
   assert.match(texts[2],/抽帧服务超时/)
   assert.doesNotMatch(texts[2],/已核验|检查通过|自动两帧抽检/)
   assert.match(texts[3],/人工抽帧记录（非连续观看）/)
   assert.match(texts[3],/灰制服队伍沿土路行进/)
   assert.match(texts[3],/只查看抽帧，未连续播放、未听原声/)
   assert.deepEqual(h.state.errors,[])
 } finally {await h.browser.close()}
})

test('completed work can be rebuilt from the current manuscript while retaining saved outputs',async () => {
 const h = await harness()
 try {
   h.state.detail.outputs = [{id:'old',url:'/static/old-final.mp4',kind:'episode',filename:'旧版成片.mp4'}]
   h.state.detail.job = job('completed',{profile:'9:16',message:'成片已关联',plan:{deliveryAssociation:{status:'attached',videoUrl:'/static/old-final.mp4'}}})
   await h.page.goto(`${base}/remotion/episode/42`)
   await h.page.getByRole('button',{name:'重新制作',exact:true}).waitFor()
   assert.equal(await h.page.getByRole('button',{name:'查看成片',exact:true}).count(),1)
   await h.page.getByText('重新制作会复用当前正文、配音和素材，保留旧版成片。',{exact:true}).waitFor()
   await h.page.getByRole('button',{name:'重新制作',exact:true}).click()
   await h.page.getByRole('button',{name:'制作中',exact:true}).waitFor()
   assert.deepEqual(h.state.posts,[{path:'/api/v1/remotion/episodes/42/history-production/rebuild',body:{}}])
   await h.page.getByRole('button',{name:/旧版成片\.mp4/}).waitFor()
   assert.deepEqual(h.state.errors,[])
 } finally { await h.browser.close() }
})


test('rebuild rejection explains the cause and preserves the completed work',async () => {
 const h = await harness()
 try {
   h.state.detail.outputs = [{id:'old',url:'/static/old-final.mp4',kind:'episode',filename:'旧版成片.mp4'}]
   h.state.detail.job = job('completed',{profile:'9:16',message:'成片已关联'})
   h.state.postError = '正文已更新，已保留旧成片；请先核对当前正文'
   await h.page.goto(`${base}/remotion/episode/42`)
   await h.page.getByRole('button',{name:'重新制作',exact:true}).click()
   await h.page.getByRole('alert').getByText(h.state.postError,{exact:true}).waitFor()
   assert.equal(await h.page.getByRole('button',{name:'重新制作',exact:true}).isEnabled(),true)
   assert.equal(await h.page.getByRole('link',{name:'下载成片',exact:true}).getAttribute('href'),'/static/old-final.mp4')
   assert.equal(h.state.posts.length,1)
   assert.deepEqual(h.state.errors,[])
 } finally { await h.browser.close() }
})
