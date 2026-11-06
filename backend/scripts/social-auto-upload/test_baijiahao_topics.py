"""Real DOM regression for optional first-result topic selection."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from playwright.async_api import async_playwright

import bridge
from baijiahao_topics import add_optional_topics, video_description

TAG = "#热爆趣创赛#"
HTML = r'''<div class="videov2-title-wrap"><div class="contentEditable" contenteditable="true" style="width:500px;min-height:60px"></div><span class="FeEditorApp-x-topicCount" hidden>0/10</span></div>
<div class="FeEditorApp-x-topicList"></div>
<script>
(() => {
const editor=document.querySelector('[contenteditable=true]'),list=document.querySelector('[class$=topicList]');
window.mode='results';window.delayMs=0;window.clicks=[];window.queries=[];window.changedBody=false;window.expectedBase='骆驼为什么被低估';
window.firstLabel='首条推荐话题';window.secondLabel='热爆趣创赛';window.firstId='987654321098765432';window.failedClick=false;
editor.addEventListener('input',()=>{
  if(!editor.textContent.startsWith(expectedBase))changedBody=true;
  const match=editor.textContent.match(/ #[^#]*$/);list.replaceChildren();
  if(!match)return;
  queries.push(match[0]);
  if(mode==='empty'){list.innerHTML='<div class="FeEditorApp-x-topicEmpty">暂无话题</div>';return}
  if(mode==='absent')return;
  list.innerHTML='<div class="FeEditorApp-x-topicLoading">加载中</div>';
  if(mode==='loading')return;
  const query=match[0];
  setTimeout(()=>{
    if(!editor.textContent.endsWith(query))return;
    list.replaceChildren();
    [firstLabel,secondLabel].forEach((label,index)=>{
      const item=document.createElement('div');item.className='FeEditorApp-x-topicItem';item.setAttribute('role','button');
      const name=document.createElement('div');name.className='FeEditorApp-x-topicName';name.textContent='# '+label+' #';item.append(name);
      item.onclick=()=>{
        clicks.push(index);list.replaceChildren();
        if(failedClick==='clear_query'){editor.textContent=expectedBase;return}
        if(failedClick)return;
        const base=editor.textContent.slice(0,-query.length);editor.replaceChildren(document.createTextNode(base+' '));
        const wrapper=document.createElement('span');wrapper.className='video-title-tag-wrapper';wrapper.contentEditable='false';
        const tag=document.createElement('span');tag.className='video-title-tag';tag.dataset.tagType='topic';tag.dataset.tagId=firstId;
        tag.textContent='#'+label+'#';wrapper.append(tag);editor.append(wrapper);document.querySelector('[class$=topicCount]').textContent='1/10';document.querySelector('[class$=topicCount]').hidden=false;
      };list.append(item);
    });
  },delayMs);
});
})();
</script>'''


class BaijiahaoTopicsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        await self.page.set_content(HTML)
        self.payload = {"target":"baijiahao-video", "title":"骆驼为什么被低估", "description":f"骆驼为什么被低估 {TAG}", "tags":[TAG]}
        self.helpers = bridge.load_engine()[3]
        self.metadata = await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
        await self.page.evaluate('changedBody=false')

    async def test_selects_first_candidate_even_when_name_and_id_differ(self):
        result=await add_optional_topics(self.page,self.payload,self.metadata,timeout=2)
        self.assertEqual(result['topicAttempt']['status'],'selected')
        self.assertEqual(result['topicAttempt']['selectedLabels'],['#首条推荐话题#'])
        self.assertEqual(await self.page.evaluate('clicks'),[0])
        self.assertFalse(await self.page.evaluate('changedBody'))
        await self.helpers._verify_metadata(self.page,result)
        self.assertEqual(video_description(self.payload,{'details':{'metadata':result}}),'骆驼为什么被低估 #首条推荐话题#')
        original=await self.page.locator('[contenteditable=true]').inner_html()
        self.assertEqual(await add_optional_topics(self.page,self.payload,result),result)
        self.assertEqual(await self.page.locator('[contenteditable=true]').inner_html(),original)
        self.assertEqual(await self.page.evaluate('clicks'),[0])

    async def test_delayed_results_are_selected_without_using_the_loading_row(self):
        await self.page.evaluate('delayMs=200')
        result=await add_optional_topics(self.page,self.payload,self.metadata,timeout=2)
        self.assertEqual(result['topicAttempt']['status'],'selected')
        self.assertEqual(await self.page.evaluate('clicks'),[0])

    async def test_required_topic_waits_for_current_query_after_a_stale_empty_result(self):
        self.payload.update(description=self.payload['title'] + ' #NBA#', tags=['#NBA#'], topicPolicy='required-exact')
        self.metadata = await self.helpers.fill_metadata(self.page, self.payload['title'], self.payload['description'])
        await self.page.evaluate('''() => {
          firstLabel='NBA';secondLabel='其他话题';delayMs=350;
          document.querySelector('[contenteditable=true]').addEventListener('input', event => {
            if (event.target.textContent.endsWith(' #NBA')) {
              document.querySelector('[class$=topicList]').innerHTML='<div class="FeEditorApp-x-topicEmpty">暂无话题</div>';
            }
          });
        }''')
        result = await add_optional_topics(self.page, self.payload, self.metadata, timeout=2)
        self.assertEqual(result['topicAttempt']['selectedLabels'], ['#NBA#'])
        self.assertEqual(await self.page.evaluate('clicks'), [0])
        await self.helpers._verify_metadata(self.page, result)

    async def test_required_exact_topic_chooses_nba_instead_of_related_first_suggestion(self):
        self.payload.update(description=self.payload['title']+' #NBA#', tags=['#NBA#'], topicPolicy='required-exact')
        await self.page.evaluate("firstLabel='NBA季后赛';secondLabel='NBA'")
        metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
        result=await add_optional_topics(self.page,self.payload,metadata,timeout=2)
        self.assertEqual(result['topicAttempt']['selectedLabels'],['#NBA#'])
        self.assertEqual(await self.page.evaluate('clicks'),[1])
        self.assertEqual(video_description(self.payload,{'details':{'metadata':result}}),self.payload['description'])
        self.assertEqual(await add_optional_topics(self.page,self.payload,result),result)
        self.assertEqual(await self.page.evaluate('clicks'),[1])

    async def test_required_exact_topic_cannot_skip_or_choose_a_related_label(self):
        self.payload.update(description=self.payload['title']+' #NBA#', tags=['#NBA#'], topicPolicy='required-exact')
        for mode in ('results','empty','loading'):
            with self.subTest(mode=mode):
                await self.page.set_content(HTML)
                await self.page.evaluate("mode=>{window.mode=mode;firstLabel='NBA季后赛';secondLabel='NBA篮球'}",mode)
                metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
                with self.assertRaisesRegex(RuntimeError,'精确话题'):
                    await add_optional_topics(self.page,self.payload,metadata,timeout=.4)
                self.assertEqual(await self.page.evaluate('clicks'),[])
                self.assertEqual(await self.page.locator('[contenteditable=true]').inner_text(),self.payload['title'])

    async def test_required_exact_topic_rejects_a_saved_skip_or_wrong_label(self):
        self.payload.update(description=self.payload['title']+' #NBA#', tags=['#NBA#'], topicPolicy='required-exact')
        for labels in ([],['#NBA季后赛#']):
            actual=self.payload['title']+(' '+labels[0] if labels else '')
            metadata={'description':{'value':actual},'topicAttempt':{
                'sourceDescription':self.payload['description'],'baseDescription':self.payload['title'],
                'description':actual,'selectedLabels':labels,'status':'selected' if labels else 'skipped'}}
            with self.subTest(labels=labels),self.assertRaisesRegex(RuntimeError,'精确话题'):
                await add_optional_topics(self.page,self.payload,metadata,timeout=.4)

    async def test_required_topic_timeout_records_current_copy_and_retries_same_editor(self):
        self.payload.update(description=self.payload['title']+' #NBA#', tags=['#NBA#'], topicPolicy='required-exact')
        metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
        state={'details':{'metadata':metadata}}
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'state.json'
            await self.page.evaluate("mode='empty'")
            with self.assertRaisesRegex(RuntimeError,'精确话题'):
                await bridge.prepare_publication_topics(self.page,self.payload,state,file)
            self.assertEqual(json.loads(file.read_text())['details']['metadata']['description']['value'],self.payload['title'])
            await self.page.evaluate("mode='results';firstLabel='NBA其他';secondLabel='NBA'")
            await bridge.prepare_publication_topics(self.page,self.payload,state,file)
            self.assertEqual(state['details']['metadata']['topicAttempt']['selectedLabels'],['#NBA#'])
            self.assertEqual(await self.page.evaluate('clicks'),[1])

    async def test_title_only_upload_adds_topic_without_deleting_the_last_character(self):
        self.payload.update(description=self.payload['title'],tags=['#热爆趣创赛'])
        metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
        await self.page.evaluate('changedBody=false;queries=[]')
        result=await add_optional_topics(self.page,self.payload,metadata,timeout=2)
        self.assertEqual(result['topicAttempt']['status'],'selected')
        self.assertFalse(await self.page.evaluate('changedBody'))
        self.assertIn(' #热爆趣创赛',await self.page.evaluate('queries'))
        self.assertEqual(await self.page.evaluate('clicks'),[0])
        await self.helpers._verify_metadata(self.page,result)
        self.assertEqual(video_description(self.payload,{'details':{'metadata':result}}),self.payload['title']+' #首条推荐话题#')

    async def test_title_only_timeout_or_disappearing_query_keeps_the_whole_description(self):
        self.payload.update(description=self.payload['title'],tags=['#热爆趣创赛'])
        for mode in ('absent','clear_query'):
            with self.subTest(mode=mode):
                await self.page.set_content(HTML)
                metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
                await self.page.evaluate("mode=>{changedBody=false;if(mode==='absent')window.mode=mode;else failedClick=mode}",mode)
                result=await add_optional_topics(self.page,self.payload,metadata,timeout=.4)
                self.assertEqual(result['topicAttempt']['status'],'skipped')
                self.assertEqual(result['description']['value'],self.payload['title'])
                self.assertFalse(await self.page.evaluate('changedBody'))
                self.assertEqual(await add_optional_topics(self.page,self.payload,result),result)

    async def test_editor_normalizing_programmatic_selection_cannot_delete_the_last_body_character(self):
        for title in ('荔枝好吃多吃可能致命，杨贵妃的荔枝来自岭南吗？',
                      '仙人掌为何生命力强，火龙果真是它结的吗？',
                      '大白菜为什么重要？它为什么适合冬天吃'):
            with self.subTest(title=title):
                await self.page.set_content(HTML)
                payload={**self.payload,'title':title,'description':f'{title} {TAG}'}
                await self.page.evaluate('(title)=>{expectedBase=title;mode="absent"}',title)
                metadata=await self.helpers.fill_metadata(self.page,title,payload['description'])
                # Rich editors can reapply their model selection after a raw
                # DOM range change. Native keyboard selection stays in sync.
                await self.page.evaluate('''() => {
                  const addRange=Selection.prototype.addRange;
                  Selection.prototype.addRange=function(range){
                    addRange.call(this,range);
                    queueMicrotask(()=>this.collapseToEnd());
                  };
                }''')
                result=await add_optional_topics(self.page,payload,metadata,timeout=.8)
                self.assertEqual(result['description']['value'],title)
                self.assertEqual(result['topicAttempt']['status'],'skipped')
                self.assertEqual(await self.page.locator('[contenteditable=true]').inner_text(),title)

    async def test_explicit_topic_damage_repair_restores_only_the_original_bound_body(self):
        for title in ('荔枝好吃多吃可能致命，杨贵妃的荔枝来自岭南吗？',
                      '仙人掌为何生命力强，火龙果真是它结的吗？',
                      '大白菜为什么重要？它为什么适合冬天吃'):
            with self.subTest(title=title),tempfile.TemporaryDirectory() as directory:
                payload={**self.payload,'jobId':'repair-topic-body','title':title,'description':f'{title} {TAG}','videoPath':'original.mp4'}
                await self.page.set_content(HTML)
                await self.page.evaluate('(title)=>{expectedBase=title;mode="absent";window.name="huobao-sau-repair-topic-body";window.__huobaoSauDocumentToken="bound-document"}',title)
                metadata=await self.helpers.fill_metadata(self.page,title,payload['description'])
                await self.page.locator('[contenteditable=true]').fill(title[:-1])
                media={'verification':'blob_sha256','media_src':'blob:original','video_fingerprint':'original-hash'}
                state={'phase':'staged','payloadDigest':bridge.payload_digest(payload),'files':{},'targetId':'abc123',
                       'documentToken':'bound-document','result':{'targetId':'abc123','saved':False,'published':False},
                       'details':{'metadata':metadata,'media':media,'covers':{}}}
                file=Path(directory)/'state.json'
                helpers=SimpleNamespace(verify_upload=AsyncMock(return_value=media),fill_metadata=self.helpers.fill_metadata,
                                        _verify_metadata=self.helpers._verify_metadata)
                with patch.object(bridge,'local_files',return_value={}),patch.object(bridge,'page_id',new=AsyncMock(return_value='abc123')), \
                        patch.object(bridge,'verify_saved_baijiahao_covers',new=AsyncMock()):
                    result=await bridge.repair_optional_topic_description(self.page,payload,state,file,(None,None,None,helpers),title[:-1])
                self.assertTrue(result['repaired'])
                self.assertEqual(await self.page.locator('[contenteditable=true]').inner_text(),payload['description'])
                self.assertEqual(state['phase'],'staged')
                self.assertEqual(state['payloadDigest'],bridge.payload_digest(payload))
                self.assertEqual(state['result'],{'targetId':'abc123','saved':False,'published':False})
                self.assertEqual(state['details']['metadata'],metadata)

    async def test_unselected_topic_query_cleanup_does_not_depend_on_the_editors_selection_model(self):
        await self.page.evaluate('''() => {
          mode='absent';
          document.addEventListener('keydown',event=>{
            if(event.shiftKey&&event.key==='ArrowLeft')queueMicrotask(()=>window.getSelection().collapseToEnd());
          });
        }''')
        result=await add_optional_topics(self.page,self.payload,self.metadata,timeout=.8)
        self.assertEqual(result['description']['value'],self.payload['title'])
        self.assertEqual(result['topicAttempt']['status'],'skipped')

    async def test_explicit_topic_repair_accepts_only_a_requested_plain_query_suffix(self):
        title=self.payload['title']
        payload={**self.payload,'jobId':'repair-topic-body','videoPath':'original.mp4'}
        await self.page.evaluate('()=>{window.name="huobao-sau-repair-topic-body";window.__huobaoSauDocumentToken="bound-document"}')
        media={'verification':'blob_sha256','media_src':'blob:original','video_fingerprint':'original-hash'}
        for suffix in (' #热',' #热爆趣',' #别的话题'):
            with self.subTest(suffix=suffix),tempfile.TemporaryDirectory() as directory:
                actual=title+suffix
                await self.page.locator('[contenteditable=true]').fill(actual)
                state={'phase':'staged','payloadDigest':bridge.payload_digest(payload),'files':{},'targetId':'abc123',
                       'documentToken':'bound-document','result':{'targetId':'abc123','saved':False,'published':False},
                       'details':{'metadata':deepcopy(self.metadata),'media':media,'covers':{}}}
                helpers=SimpleNamespace(verify_upload=AsyncMock(return_value=media),fill_metadata=self.helpers.fill_metadata,
                                        _verify_metadata=self.helpers._verify_metadata)
                with patch.object(bridge,'local_files',return_value={}),patch.object(bridge,'page_id',new=AsyncMock(return_value='abc123')), \
                        patch.object(bridge,'verify_saved_baijiahao_covers',new=AsyncMock()):
                    if suffix==' #别的话题':
                        with self.assertRaises(RuntimeError):
                            await bridge.repair_optional_topic_description(self.page,payload,state,Path(directory)/'state.json',
                                                                            (None,None,None,helpers),actual)
                        self.assertEqual(await self.page.locator('[contenteditable=true]').inner_text(),actual)
                    else:
                        result=await bridge.repair_optional_topic_description(self.page,payload,state,Path(directory)/'state.json',
                                                                             (None,None,None,helpers),actual)
                        self.assertTrue(result['repaired'])
                        self.assertEqual(await self.page.locator('[contenteditable=true]').inner_text(),payload['description'])

    async def test_topic_damage_repair_refuses_other_copy_or_unbound_or_submitted_work(self):
        title=self.payload['title']
        payload={**self.payload,'jobId':'repair-topic-body','videoPath':'original.mp4'}
        await self.page.evaluate('()=>{window.name="huobao-sau-repair-topic-body";window.__huobaoSauDocumentToken="bound-document"}')
        await self.page.locator('[contenteditable=true]').fill(title[:-1])
        media={'verification':'blob_sha256','media_src':'blob:original','video_fingerprint':'original-hash'}
        original={'phase':'staged','payloadDigest':bridge.payload_digest(payload),'files':{},'targetId':'abc123',
                  'documentToken':'bound-document','result':{'targetId':'abc123','saved':False,'published':False},
                  'details':{'metadata':self.metadata,'media':media,'covers':{}}}
        for scenario in ('wrong_expected','wrong_body','different_document','different_target','different_video','submitted','changed_source'):
            with self.subTest(scenario=scenario),tempfile.TemporaryDirectory() as directory:
                state=deepcopy(original)
                expected=title[:-1]
                actual_media=deepcopy(media)
                actual_payload=deepcopy(payload)
                await self.page.locator('[contenteditable=true]').fill(title[:-1])
                if scenario=='wrong_expected':expected='其他文案'
                if scenario=='wrong_body':await self.page.locator('[contenteditable=true]').fill('其他文案')
                if scenario=='different_document':state['documentToken']='another-document'
                if scenario=='different_video':actual_media['video_fingerprint']='another-hash'
                if scenario=='submitted':state['publishAttemptedAt']=1
                if scenario=='changed_source':actual_payload['description']='其他正文 '+TAG
                helpers=SimpleNamespace(verify_upload=AsyncMock(return_value=actual_media),fill_metadata=AsyncMock(),
                                        _verify_metadata=self.helpers._verify_metadata)
                with patch.object(bridge,'local_files',return_value={}), \
                        patch.object(bridge,'page_id',new=AsyncMock(return_value='another-target' if scenario=='different_target' else 'abc123')), \
                        patch.object(bridge,'verify_saved_baijiahao_covers',new=AsyncMock()):
                    with self.assertRaises(RuntimeError):
                        await bridge.repair_optional_topic_description(self.page,actual_payload,state,Path(directory)/'state.json',
                                                                        (None,None,None,helpers),expected)
                helpers.fill_metadata.assert_not_called()

    async def test_absent_empty_and_never_finished_lists_skip_without_blocking_publication(self):
        for mode in ('absent','empty','loading'):
            with self.subTest(mode=mode):
                await self.page.set_content(HTML)
                metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
                await self.page.evaluate('(mode)=>{window.mode=mode;changedBody=false}',mode)
                start=time.monotonic()
                result=await add_optional_topics(self.page,self.payload,metadata,timeout=.35)
                self.assertLess(time.monotonic()-start,2)
                self.assertEqual(result['topicAttempt']['status'],'skipped')
                self.assertEqual(await self.page.evaluate('clicks'),[])
                self.assertFalse(await self.page.evaluate('changedBody'))
                self.assertEqual(video_description(self.payload,{'details':{'metadata':result}}),self.payload['title'])
                await self.helpers._verify_metadata(self.page,result)
                self.assertTrue(await bridge.verify_baijiahao_fields(self.page,self.payload))
                self.assertEqual(await add_optional_topics(self.page,self.payload,result),result)

    async def test_click_without_selection_is_optional_and_query_is_removed(self):
        await self.page.evaluate('failedClick=true')
        result=await add_optional_topics(self.page,self.payload,self.metadata,timeout=.5)
        self.assertEqual(result['topicAttempt']['status'],'skipped')
        self.assertEqual(result['description']['value'],self.payload['title'])
        self.assertEqual(await self.page.evaluate('clicks'),[0])

    async def test_changed_main_description_is_never_accepted_as_an_optional_tag_change(self):
        result=await add_optional_topics(self.page,self.payload,self.metadata,timeout=2)
        corrupted=deepcopy(result);corrupted['description']['value']='其他正文 #首条推荐话题#'
        corrupted['topicAttempt']['description']=corrupted['description']['value']
        with self.assertRaisesRegex(RuntimeError,'文案'):
            video_description(self.payload,{'details':{'metadata':corrupted}})
        changed=deepcopy(self.payload);changed['description']='其他正文 '+TAG
        with self.assertRaisesRegex(RuntimeError,'文案'):
            video_description(changed,{'details':{'metadata':result}})

    async def test_plain_hashtag_can_proceed_but_is_not_reported_as_selected(self):
        await self.page.evaluate('mode="empty"')
        result=await add_optional_topics(self.page,self.payload,self.metadata,timeout=.5)
        self.assertEqual(result['topicAttempt']['selectedLabels'],[])
        self.assertEqual(result['topicAttempt']['status'],'skipped')
        self.assertTrue(await bridge.verify_baijiahao_fields(self.page,self.payload))

    async def test_draft_save_selects_or_skips_topic_before_saving_once(self):
        self.payload.update(description=self.payload['title'],tags=['#热爆趣创赛'])
        for mode in ('results','absent'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as directory:
                await self.page.set_content(HTML+'''<button onclick="saves++;savedCaption=document.querySelector('[contenteditable=true]').innerText;document.querySelector('.toast').textContent='保存成功'">存草稿</button><div class="toast"></div><script>window.saves=0;window.savedCaption=''</script>''')
                metadata=await self.helpers.fill_metadata(self.page,self.payload['title'],self.payload['description'])
                await self.page.evaluate('(mode)=>{window.mode=mode;changedBody=false}',mode)
                state={'phase':'staged','files':{},'payloadDigest':bridge.payload_digest(self.payload),'details':{'metadata':metadata}}
                file=Path(directory)/'state.json'
                expected=self.payload['title']+(' #首条推荐话题#' if mode=='results' else '')
                async def verify(_page,_payload,_state,_engine):
                    await self.helpers._verify_metadata(_page,_state['details']['metadata'])
                async def attempt(*args):
                    return await add_optional_topics(*args,timeout=2 if mode=='results' else .4)
                async def reconcile(_browser,_payload,actual,_file,_engine):
                    stored=json.loads(_file.read_text())
                    self.assertEqual(video_description(_payload,stored),expected)
                    self.assertEqual(stored['details']['metadata']['topicAttempt']['status'],'selected' if mode=='results' else 'skipped')
                    self.assertEqual(stored['payloadDigest'],bridge.payload_digest(_payload))
                    actual.update(phase='saved',result={'saved':True,'published':False})
                    bridge.write_state(_file,actual)
                    return actual['result']
                with patch.object(bridge,'verify_staged',new=verify),patch.object(bridge,'add_optional_topics',new=attempt), \
                        patch.object(bridge,'reconcile_saved_draft',new=reconcile),patch.object(bridge,'cleanup_saved_upload_tab',new=AsyncMock()):
                    result=await bridge.save_draft(self.page,self.payload,state,file,())
                    self.assertTrue(result['saved'])
                    self.assertEqual(await bridge.save_draft(self.page,self.payload,state,file,()),result)
                self.assertEqual(await self.page.evaluate('saves'),1)
                self.assertEqual(await self.page.evaluate('savedCaption'),expected)
                self.assertFalse(await self.page.evaluate('changedBody'))

if __name__=='__main__':
    unittest.main()
