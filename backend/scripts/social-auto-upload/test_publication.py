"""Offline browser proof: publication is explicit, once-only and receipt-backed."""
import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright
import bridge
from test_baijiahao_draft_listing import HTML, FIRST_ID, SECOND_ID


class PublicationObservationTest(unittest.TestCase):
    def test_transcode_preserves_original_fingerprint_when_list_duration_rounds_587_to_588(self):
        fingerprint = '{"s2l":null,"s2game":null,"bjh":{"duration":587}}'
        original = {'article_id':'1880710335674588146', 'app_id':'1563481098833025',
                    'file_name':'original-processing-media', 'type':'video', 'created_at':'2026-11-02 10:06:05',
                    'title':'原成片标题', 'rmb_duration':588, 'bjh_video_finger_printing':fingerprint, 'status':'analyze'}
        state = {'result':{'articleId':original['article_id']},
                 'publicationEvidence':{'platformRecord':original, 'localVideoDuration':587.947, 'videoDuration':588}}
        record = {**original, 'file_name':'platform-transcoded-media', 'status':'publish',
                  'has_edited_times':0, 'source_trace':'CMS_VIDEO_PUBLISH', 'source_type':'creation'}
        candidate = {'id':original['article_id'], 'record':record, 'statusLabels':['已发布']}
        self.assertEqual(bridge.publication_record_mismatches(state,candidate),[])
        for field, value in [('bjh_video_finger_printing','{"bjh":{"duration":588}}'),
                             ('bjh_video_finger_printing',None), ('bjh_video_finger_printing','{}'),
                             ('rmb_duration',589), ('has_edited_times',1), ('app_id','other')]:
            with self.subTest(current_field=field,value=value):
                self.assertTrue(bridge.publication_record_mismatches(state,{**candidate,'record':{**record,field:value}}))
        for change in ({'bjh_video_finger_printing':None}, {'bjh_video_finger_printing':'{}'},
                       {'bjh_video_finger_printing':'{"bjh":{"duration":588}}'}, {'rmb_duration':589}):
            with self.subTest(original=change):
                changed = {**state, 'publicationEvidence':{**state['publicationEvidence'],'platformRecord':{**original,**change}}}
                self.assertTrue(bridge.publication_record_mismatches(changed,candidate))
        for change in ({'videoDuration':587}, {'localVideoDuration':586.9}, {'localVideoDuration':589.01}):
            with self.subTest(evidence=change):
                self.assertTrue(bridge.publication_record_mismatches({**state,
                    'publicationEvidence':{**state['publicationEvidence'],**change}},candidate))
        for duration in (586, 589):
            outside = json.dumps({'bjh':{'duration':duration}})
            changed = {**state, 'publicationEvidence':{**state['publicationEvidence'],
                'platformRecord':{**original,'bjh_video_finger_printing':outside}}}
            self.assertTrue(bridge.publication_record_mismatches(changed,
                {**candidate,'record':{**record,'bjh_video_finger_printing':outside}}),
                'even identical source fingerprints must agree with local duration within one second')
        missing_original = {key:value for key,value in original.items() if key != 'bjh_video_finger_printing'}
        self.assertTrue(bridge.publication_record_mismatches({**state,
            'publicationEvidence':{**state['publicationEvidence'],'platformRecord':missing_original}},candidate),
            'without original fingerprint, keep the strict legacy rule')

    def test_moderation_media_normalization_keeps_original_identity_and_requires_no_edit_proof(self):
        original = {'article_id':'1880702585364057145', 'app_id':'1563481098833025',
                    'file_name':'2e3df28257a805cd7edd5796750eb5ce', 'type':'video',
                    'created_at':'2026-11-02 08:02:32', 'title':'原作品', 'rmb_duration':456}
        state = {'result':{'articleId':original['article_id']},
                 'publicationEvidence':{'platformRecord':original, 'localVideoDuration':456.533333,'videoDuration':456.0}}
        record = {**original, 'file_name':'26f623dfc88b068948c7c3d8f9a545a7', 'rmb_duration':457,
                  'has_edited_times':0, 'source_trace':'CMS_VIDEO_PUBLISH', 'source_type':'creation',
                  'bjh_video_finger_printing':'{"s2l":null,"s2game":null,"bjh":{"duration":456}}',
                  'status':'publish'}
        candidate = {'id':original['article_id'], 'record':record, 'statusLabels':['已发布']}
        self.assertEqual(bridge.publication_record_mismatches(state,candidate),[])
        for field, value in [('article_id','1880702585364057146'),('app_id','other'),('created_at','2026-11-02 09:00:00'),
                             ('type','article'),('title','another video'),('rmb_duration',459),('has_edited_times',1),
                             ('has_edited_times',None),('has_edited_times',False),('source_trace','other'),
                             ('source_type','import'),('bjh_video_finger_printing','{}'),
                             ('bjh_video_finger_printing','{"bjh":{"duration":457}}')]:
            with self.subTest(field=field,value=value):
                self.assertTrue(bridge.publication_record_mismatches(state,{**candidate,'record':{**record,field:value}}))
        self.assertTrue(bridge.publication_record_mismatches(state,{**candidate,'id':'1880702585364057146'}))
        self.assertTrue(bridge.publication_record_mismatches(state,{**candidate,'record':{**record,'status':'review'},'statusLabels':['审核中']}))

    def test_transport_observation_never_infers_acceptance_from_http_alone(self):
        cases = [
            ({}, 'unknown'),
            ({'publicationNotices': ['请选择创作声明类型'], 'publicationResponses': []}, 'unknown'),
            ({'publicationRequestCount': False, 'publicationResponses': [],
              'publicationNotices': ['请选择创作声明类型']}, 'unknown'),
            ({'publicationRequestCount': 0, 'publicationResponses': [], 'publicationNotices': []}, 'unknown'),
            ({'publicationRequestCount': 0, 'publicationResponses': [],
              'publicationNotices': ['请选择创作声明类型']}, 'no_request_validation'),
            ({'publicationRequestCount': 1, 'publicationResponses': [],
              'publicationNotices': ['请选择创作声明类型']}, 'unknown'),
            ({'publicationRequestCount': 1, 'publicationResponses': [{'httpStatus': 200}]}, 'unknown'),
            ({'publicationRequestCount': 1, 'publicationResponses': [{'httpStatus': 200, 'errno': 0}]}, 'accepted'),
            ({'publicationRequestCount': 1, 'publicationResponses': [{'httpStatus': 200, 'errno': 602}]}, 'server_rejected'),
            ({'publicationRequestCount': 1, 'publicationResponses': [{'httpStatus': 500, 'errno': 0}]}, 'server_rejected'),
            ({'publicationRequestCount': 2, 'publicationResponses': [
                {'httpStatus': 200, 'errno': 0}, {'httpStatus': 200, 'errno': 1}]}, 'unknown'),
        ]
        for state, expected in cases:
            with self.subTest(state=state):
                self.assertEqual(bridge.publication_observation(state)['classification'], expected)


class PublicPreviewVerificationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel='chrome', headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        await self.page.route('**/*', self.route)

    async def route(self, route):
        request = route.request
        url = urlparse(request.url)
        if url.hostname == 'baijiahao.baidu.com' and url.path == '/builder/preview/s':
            return await route.fulfill(status=302, headers={
                'location': 'https://mbd.baidu.com/newspage/data/videolanding?nid=sv_fixture'})
        if url.hostname == 'mbd.baidu.com':
            return await route.fulfill(content_type='text/html; charset=utf-8', body='''
              <main><h1>松露种得出来，为何仍难稳定收成</h1><p>#热爆趣创赛#</p></main>''')
        return await route.abort()

    async def test_public_redirect_and_required_metadata_prove_existing_publication(self):
        original_goto = self.page.goto
        requested = []

        async def goto(url, **kwargs):
            requested.append(url)
            # Keep the fixture deterministic while preserving the helper's
            # canonical preview request and public-host validation.
            return await original_goto('https://mbd.baidu.com/newspage/data/videolanding?nid=sv_fixture', **kwargs)

        self.page.goto = goto
        evidence = await bridge.verify_public_baijiahao_preview(self.page, '1880355404767059404', {
            'title': '松露种得出来，为何仍难稳定收成', 'tags': ['#热爆趣创赛#']})
        self.assertEqual(requested, ['https://baijiahao.baidu.com/builder/preview/s?id=1880355404767059404'])
        self.assertEqual(evidence['verification'], 'baijiahao_public_preview')
        self.assertEqual(evidence['articleId'], '1880355404767059404')
        self.assertEqual(urlparse(evidence['resolvedUrl']).hostname, 'mbd.baidu.com')
        self.assertEqual(evidence['visibleTopicTexts'], ['#热爆趣创赛#'])
        self.assertNotIn('tags', evidence, 'visible text is not proof of a bound platform topic')

    async def test_publication_without_optional_topic_is_still_a_valid_public_receipt(self):
        await self.page.unroute('**/*', self.route)
        async def without_topic(route):
            return await route.fulfill(content_type='text/html; charset=utf-8',
                body='<main><h1>松露种得出来，为何仍难稳定收成</h1></main>')
        await self.page.route('**/*', without_topic)
        original_goto = self.page.goto
        async def goto(_url, **kwargs):
            return await original_goto('https://mbd.baidu.com/newspage/data/videolanding?nid=sv_fixture', **kwargs)
        self.page.goto = goto
        evidence = await bridge.verify_public_baijiahao_preview(self.page, '1880355404767059404', {
            'title': '松露种得出来，为何仍难稳定收成', 'tags': ['#热爆趣创赛#']})
        self.assertEqual(evidence['visibleTopicTexts'], [])
        self.assertNotIn('tags', evidence)

    async def test_non_public_preview_is_rejected(self):
        async def non_public(route):
            url = urlparse(route.request.url)
            if url.hostname == 'baijiahao.baidu.com' and url.path == '/builder/preview/s':
                return await route.fulfill(content_type='text/html', body='<main>草稿预览</main>')
            return await route.abort()
        await self.page.unroute('**/*', self.route)
        await self.page.route('**/*', non_public)
        with self.assertRaisesRegex(RuntimeError, '公开预览尚未跳转'):
            await bridge.verify_public_baijiahao_preview(self.page, '1880355404767059404', {
                'title': '松露种得出来，为何仍难稳定收成', 'tags': ['#热爆趣创赛#']})


class PublicationCheckpointTest(unittest.IsolatedAsyncioTestCase):
    async def test_incomplete_publish_checkpoints_cannot_be_closed_or_archived(self):
        with tempfile.TemporaryDirectory() as root:
            request = {'config': {'stateRoot': root}, 'payload': {
                'jobId': 'publish-incomplete', 'target': 'baijiahao-video', 'publicationMode': 'publish'}}
            file = bridge.job_state_file(request)
            file.parent.mkdir(parents=True)
            states = [None, [], {}, {'phase': 'unknown'}]
            for phase in ('publish_requested', 'submitted', 'published'):
                states.extend(({'phase': phase}, {'phase': phase, 'publishAttemptedAt': 0}))
            for state in states:
                for reset in (False, True):
                    with self.subTest(state=state, reset=reset):
                        file.write_text(json.dumps(state))
                        before = file.read_bytes()
                        with patch.object(bridge, 'load_engine', side_effect=AssertionError('must not open browser')):
                            with self.assertRaisesRegex(RuntimeError, '禁止'):
                                await bridge.finish_failed_attempt(request, reset=reset)
                        self.assertEqual(file.read_bytes(), before)
                        self.assertFalse((Path(root) / 'failed-attempts').exists())


class PublicationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.video = self.root / 'original.mp4'
        self.video.write_bytes(b'original-local-video')
        self.payload = {'jobId': 'publish-1', 'scriptId': 1, 'target': 'baijiahao-video',
                        'publicationMode': 'publish', 'title': '朱元璋与1368年的应天',
                        'description': '朱元璋与1368年的应天', 'videoPath': str(self.video), 'fingerprint': 'fixture'}
        self.request = {'config': {'stateRoot': str(self.root / 'state')}, 'payload': self.payload}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        digest = hashlib.sha256(self.video.read_bytes()).hexdigest()
        self.state = {'phase': 'staged', 'protocolVersion': 3, 'payloadDigest': bridge.payload_digest(self.payload),
                      'files': {str(self.video): digest}, 'targetId': 'ABC123', 'documentToken': 'fixture',
                      'fileSelectionStartedAt': time.time() - 20,
                      'details': {'media': {'status': 'uploaded', 'verification': 'blob_sha256', 'video_fingerprint': digest},
                                  'metadata': {'description': {'value': self.payload['description']}}},
                      'result': {'staged': True, 'saved': False, 'published': False, 'targetId': 'ABC123',
                                 'editorUrl': bridge.EDITORS['baijiahao-video'], 'engine': 'fixture'}}
        bridge.write_state(self.file, self.state)
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel='chrome', headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        self.posts = 0
        self.seen_intent = None
        self.record_status = 'publish'
        self.record_title = None
        self.records = 1
        self.publish_error = None
        self.list_requests = []
        await self.context.route('**/*', self.route)
        await self.page.expose_function('checkIntent', self.check_intent)
        await self.page.goto(bridge.EDITORS['baijiahao-video'])

    def check_intent(self):
        self.seen_intent = json.loads(self.file.read_text())

    async def route(self, route):
        req = route.request
        path = urlparse(req.url).path
        if path == '/builder/rc/edit':
            return await route.fulfill(content_type='text/html; charset=utf-8', body='''
              <button data-testid="publish-btn" onclick="submit()">发布</button>
              <button onclick="throw Error('must not save')">存草稿</button>
              <input placeholder="请选择创作声明" readonly onclick="setTimeout(()=>document.querySelector('[role=dialog]').hidden=false,100)">
              <div role="dialog" hidden><p>必选声明</p>
                <span onclick="chosen='含AI生成内容'">含AI生成内容</span>
                <button onclick="document.querySelector('input').value=chosen;this.parentElement.hidden=true">确定</button>
              </div>
              <script>let chosen='';</script>
              <script>async function submit(){await checkIntent();const r=await (await fetch('/pcui/article/publish',{method:'POST'})).json();
                if(r.errno){const n=document.createElement('div');n.className='cheetah-message-error';n.textContent=r.errmsg;document.body.appendChild(n);setTimeout(()=>n.remove(),750);return}
                location.href='/builder/rc/clue'}</script>''')
        if path == '/pcui/article/publish':
            self.posts += 1
            return await route.fulfill(content_type='application/json', body=json.dumps(self.publish_error or {'errno': 0}))
        if path == '/builder/rc/content':
            body = HTML.replace("row.status==='draft'?'草稿':'已发布'", "row.status==='draft'?'草稿':row.status==='review'?'审核中':'已发布'")
            return await route.fulfill(content_type='text/html; charset=utf-8', body=body)
        if path == '/pcui/article/lists':
            q = parse_qs(urlparse(req.url).query, keep_blank_values=True)
            self.list_requests.append((req.method, q['collection'][0], q['search'][0]))
            stamp = bridge.datetime.fromtimestamp(time.time(), bridge.ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')
            stamp = getattr(self, 'record_created_at', stamp)
            if getattr(self, 'freeze_record_created_at', False):
                self.record_created_at = stamp
            rows = [{'id': identifier, 'title': self.record_title or self.payload['description'], 'time': stamp,
                     'type': 'video', 'status': self.record_status} for identifier in (FIRST_ID, SECOND_ID)[:self.records]]
            values = [{'article_id': int(row['id']), 'title': row['title'], 'status': row['status'],
                       'type': 'video', 'created_at': stamp, 'updated_at': stamp,
                       'rmb_duration': 42, 'file_name': 'server-media', 'app_id': 'account',
                       **getattr(self, 'record_updates', {})} for row in rows]
            return await route.fulfill(content_type='application/json', body=json.dumps({'errno': 0,
                'data': {'list': values, 'page': {'currentPage': 1, 'totalPage': 1 if rows else 0, 'totalCount': len(rows)}},
                'domRows': rows}))
        if path == '/builder/rc/clue':
            return await route.fulfill(content_type='text/html', body='<main>submitted</main>')
        return await route.abort()

    async def publish(self):
        with patch.object(bridge, 'verify_staged', new=AsyncMock()), \
                patch.object(bridge, 'finish_staged_baijiahao_cover', new=AsyncMock()), \
                patch.object(bridge, 'local_video_duration', return_value=getattr(self, 'local_duration', 42)):
            return await bridge.publish_video(self.page, self.payload, self.state, self.file, ())

    async def prepare_status_refresh(self):
        self.freeze_record_created_at = True
        self.payload['accountName'] = 'history_baijiahao'
        self.state['payloadDigest'] = bridge.payload_digest(self.payload)
        self.state['accountCredentialDigest'] = 'original-credential-generation'
        self.state['result']['accountName'] = self.payload['accountName']
        self.record_status = 'review'
        result = await self.publish()
        self.request['result'] = result
        self.video.unlink()
        return result

    async def refresh_status(self):
        with patch.object(bridge, 'load_engine', return_value=(None, None, async_playwright, None, None, None)), \
                patch.object(bridge, 'connect_upload_browser', new=AsyncMock(return_value=(self.browser, 'fixture', 'original-credential-generation'))) as connect, \
                patch.object(bridge, 'upload', new=AsyncMock(side_effect=AssertionError('never upload or confirm'))), \
                patch.object(bridge, 'local_files', side_effect=AssertionError('released files are not needed')):
            result = await bridge.locked_action(self.request, 'refresh-publication')
            self.assertEqual(connect.call_args.args[2]['accountName'], 'history_baijiahao')
            self.assertEqual(connect.call_args.args[3]['accountCredentialDigest'], 'original-credential-generation')
            return result

    async def test_submitted_status_refresh_reads_exact_article_after_video_release(self):
        original = await self.prepare_status_refresh()
        self.record_status = 'publish'
        result = await self.refresh_status()
        self.assertTrue(result['published'])
        self.assertEqual(result['articleId'], original['articleId'])
        self.assertEqual(result['targetId'], original['targetId'])
        self.assertEqual(self.posts, 1, 'refresh must not issue another publish request')
        self.assertTrue(all(method == 'GET' for method, _, _ in self.list_requests))
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['publicationEvidence'], self.state['publicationEvidence'])
        self.assertEqual(saved['publicationStatusCheck']['articleId'], original['articleId'])

    async def test_submitted_status_refresh_accepts_only_proven_platform_transcode(self):
        self.local_duration = 42.533333
        original = await self.prepare_status_refresh()
        self.record_status = 'publish'
        self.record_updates = {'file_name':'transcoded-server-media', 'rmb_duration':43,
            'has_edited_times':0, 'source_type':'creation', 'source_trace':'CMS_VIDEO_PUBLISH',
            'bjh_video_finger_printing':'{"bjh":{"duration":42}}'}
        result = await self.refresh_status()
        self.assertTrue(result['published'])
        self.assertEqual(result['articleId'],original['articleId'])
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['publicationEvidence'],self.state['publicationEvidence'])
        self.assertTrue(saved['publicationStatusCheck']['mediaReferenceChanged'])
        self.assertEqual(saved['publicationStatusCheck']['platformRecord']['has_edited_times'],0)
        self.assertEqual(self.posts,1)

    async def test_readonly_refresh_accepts_587_588_rounding_without_another_publication(self):
        fingerprint = '{"s2l":null,"s2game":null,"bjh":{"duration":587}}'
        self.local_duration = 587.947
        self.record_updates = {'rmb_duration':588, 'bjh_video_finger_printing':fingerprint}
        original = await self.prepare_status_refresh()
        self.record_status = 'publish'
        self.record_updates.update(file_name='transcoded-server-media', has_edited_times=0,
                                   source_type='creation', source_trace='CMS_VIDEO_PUBLISH')
        before = self.file.read_bytes()
        for changed in (None, '{"s2l":null,"s2game":null,"bjh":{"duration":588}}'):
            self.record_updates['bjh_video_finger_printing'] = changed
            with self.assertRaisesRegex(RuntimeError, '原账号或原视频'):
                await self.refresh_status()
            self.assertEqual(self.file.read_bytes(), before, 'mismatched fingerprint retains original submitted proof')
        self.record_updates['bjh_video_finger_printing'] = fingerprint
        result = await self.refresh_status()
        self.assertTrue(result['published'])
        self.assertEqual(result['articleId'],original['articleId'])
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['publicationEvidence'],self.state['publicationEvidence'])
        self.assertEqual(saved['publicationEvidence']['videoDuration'],588)
        self.assertTrue(saved['publicationStatusCheck']['mediaReferenceChanged'])
        self.assertEqual(saved['publicationRequestCount'],1)
        self.assertEqual(self.posts,1)
        self.assertTrue(all(method == 'GET' for method, _, _ in self.list_requests))

    async def test_submitted_status_refresh_preserves_pending_and_rejects_wrong_media_or_account(self):
        original = await self.prepare_status_refresh()
        self.assertFalse((await self.refresh_status())['published'])
        self.record_status = 'publish'
        for key in ('app_id', 'file_name', 'created_at', 'rmb_duration'):
            state = json.loads(self.file.read_text())
            state['publicationEvidence']['platformRecord'][key] = 'other'
            bridge.write_state(self.file, state)
            before = self.file.read_bytes()
            with self.assertRaisesRegex(RuntimeError, '原账号或原视频'):
                await self.refresh_status()
            self.assertEqual(self.file.read_bytes(), before)
            bridge.write_state(self.file, self.state)
        self.assertEqual(self.posts, 1)
        self.assertEqual(json.loads(self.file.read_text())['result'], original)

    async def test_submitted_status_refresh_without_verified_evidence_never_opens_browser(self):
        await self.prepare_status_refresh()
        for key in ('publicationEvidence', 'accountCredentialDigest', 'expectedPublicationId'):
            state = dict(self.state)
            state.pop(key, None)
            bridge.write_state(self.file, state)
            before = self.file.read_bytes()
            with patch.object(bridge, 'load_engine', side_effect=AssertionError('must not connect')):
                with self.assertRaisesRegex(RuntimeError, '已验证的提交证据'):
                    await bridge.locked_action(self.request, 'refresh-publication')
            self.assertEqual(self.file.read_bytes(), before)

    async def test_submitted_status_refresh_unknown_platform_status_keeps_original_receipt(self):
        await self.prepare_status_refresh()
        before = self.file.read_bytes()
        candidate = {'id': FIRST_ID, 'statusLabels': ['审核未通过'], 'record': {
            **self.state['publicationEvidence']['platformRecord'], 'status': 'reject'}}
        with patch.object(bridge, 'locate_baijiahao_draft', new=AsyncMock(return_value=(candidate, None, {'outcome':'matched'}))):
            with self.assertRaisesRegex(RuntimeError, '尚无明确'):
                await self.refresh_status()
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(self.posts, 1)

    async def test_publishes_once_with_intent_before_click_and_exact_platform_id(self):
        result = await self.publish()
        self.assertEqual(self.posts, 1)
        self.assertEqual(self.seen_intent['phase'], 'publish_requested')
        self.assertGreater(self.seen_intent['publishAttemptedAt'], 0)
        self.assertNotIn('publishClickedAt', self.seen_intent)
        self.assertEqual((result['saved'], result['submitted'], result['published']), (False, True, True))
        self.assertEqual(result['articleId'], FIRST_ID, '64-bit IDs must not be rounded')
        self.assertEqual(result['publicationStatus'], 'published')
        self.assertEqual(self.state['publicationResponses'], [
            {'path': '/pcui/article/publish', 'httpStatus': 200, 'errno': 0}])
        self.assertEqual(self.state['publicationObservation']['classification'], 'accepted')
        self.assertTrue(all(method == 'GET' and collection == '' for method, collection, _ in self.list_requests))
        self.assertEqual(self.state['publicationEvidence']['verification'], 'platform_video_publication_record')
        with patch.object(bridge, 'load_engine', side_effect=AssertionError('completed recovery is local')):
            self.assertEqual(await bridge.upload({**self.request, 'confirmPublish': True}, 'publish'), result)
            self.assertEqual(await bridge.finish_failed_attempt(self.request, reset=True), {'result': result})
        self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'complete')
        self.assertEqual(self.posts, 1)

    async def test_platform_review_is_submitted_without_claiming_published(self):
        self.record_status = 'review'
        result = await self.publish()
        self.assertTrue(result['submitted'])
        self.assertFalse(result['published'])
        self.assertFalse(result['saved'])
        self.assertEqual(result['publicationStatus'], 'submitted')
        self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'complete')

    def optional_topic_result(self, selected_label=None):
        source = self.payload['title'] + ' #热爆趣创赛#'
        actual = self.payload['title'] + (' ' + selected_label if selected_label else '')
        self.payload.update(description=source, tags=['#热爆趣创赛#'])
        self.state['payloadDigest'] = bridge.payload_digest(self.payload)
        self.state['details']['metadata']['description']['value'] = source
        self.record_title = actual
        return {'description': {'value': actual}, 'topicAttempt': {
            'sourceDescription': source, 'baseDescription': self.payload['title'],
            'description': actual, 'selectedLabels': [selected_label] if selected_label else [],
            'status': 'selected' if selected_label else 'skipped',
            **({} if selected_label else {'reason': 'timeout'})}}

    async def test_optional_topic_preflight_persists_actual_copy_without_changing_payload(self):
        metadata = self.optional_topic_result()
        digest = self.state['payloadDigest']
        with patch.object(bridge, 'verify_staged', new=AsyncMock()), \
                patch.object(bridge, 'finish_staged_baijiahao_cover', new=AsyncMock()), \
                patch.object(bridge, 'add_optional_topics', new=AsyncMock(return_value=metadata), create=True) as add:
            await bridge.publication_preflight(self.page, self.payload, self.state, (), prepare_file=self.file)
        add.assert_awaited_once()
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['details']['metadata'], metadata)
        self.assertEqual(saved['payloadDigest'], digest)
        self.assertEqual(self.posts, 0)

    async def test_optional_topic_timeout_still_publishes_and_matches_the_actual_description(self):
        metadata = self.optional_topic_result()
        with patch.object(bridge, 'add_optional_topics', new=AsyncMock(return_value=metadata), create=True) as add:
            result = await self.publish()
        add.assert_awaited_once()
        self.assertTrue(result['published'])
        self.assertEqual(self.posts, 1)
        self.assertEqual(self.seen_intent['details']['metadata'], metadata)
        self.assertEqual(self.state['publicationEvidence']['platformRecord']['title'], self.payload['title'])

    async def test_first_topic_candidate_may_differ_from_query_and_receipt_uses_selected_label(self):
        metadata = self.optional_topic_result('#热爆趣创赛秋季活动#')
        with patch.object(bridge, 'add_optional_topics', new=AsyncMock(return_value=metadata), create=True) as add:
            result = await self.publish()
        add.assert_awaited_once()
        self.assertTrue(result['published'])
        self.assertEqual(self.posts, 1)
        self.assertEqual(self.state['publicationEvidence']['platformRecord']['title'], self.record_title)

    async def test_saved_draft_preflight_adds_optional_topic_after_verifying_the_original_copy(self):
        metadata = self.optional_topic_result('#热爆趣创赛秋季活动#')
        original = self.state['details']['metadata']
        events = []
        async def verify(_page, actual):
            self.assertIs(actual, original); events.append('verified')
        async def add(_page, _payload, actual):
            self.assertIs(actual, original); events.append('topic'); return metadata
        helper = SimpleNamespace(_verify_metadata=verify)
        with patch.object(bridge, 'verify_saved_baijiahao_covers', new=AsyncMock()), \
                patch.object(bridge, 'add_optional_topics', new=add, create=True):
            await bridge.publication_preflight_saved(self.page, self.payload, self.state,
                                                     (None, None, None, helper), prepare_file=self.file)
        self.assertEqual(events, ['verified', 'topic'])
        self.assertEqual(json.loads(self.file.read_text())['details']['metadata'], metadata)
        self.assertEqual(self.posts, 0)

    async def test_rejected_publish_keeps_response_and_transient_notice_without_retry(self):
        self.publish_error = {'errno': 602, 'errmsg': '请确保视频已经上传完毕',
                              'token': 'private-token', 'data': {'cookie': 'private-cookie'}}
        async def navigation_timeout(*args, **kwargs):
            await asyncio.sleep(1)
            raise TimeoutError('fixture: publish did not navigate')
        with patch.object(self.page, 'wait_for_url', side_effect=navigation_timeout), \
                patch.object(bridge, 'reconcile_publication', new=AsyncMock(side_effect=RuntimeError('待核对'))):
            with self.assertRaisesRegex(RuntimeError, '待核对'):
                await self.publish()
        saved = json.loads(self.file.read_text())
        self.assertEqual(saved['publicationResponses'], [{'path': '/pcui/article/publish',
            'httpStatus': 200, 'errno': 602, 'errmsg': '请确保视频已经上传完毕'}])
        self.assertEqual(saved['publicationNotices'], ['请确保视频已经上传完毕'])
        self.assertNotIn('private-token', self.file.read_text())
        self.assertNotIn('private-cookie', self.file.read_text())
        self.assertEqual(saved['phase'], 'publish_requested')
        self.assertEqual(saved['publicationObservation']['classification'], 'server_rejected')
        self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'reconcile')
        self.assertEqual(self.posts, 1)

    async def test_client_validation_notice_does_not_authorize_a_second_click(self):
        await self.page.evaluate('''() => {
          document.querySelector('[data-testid="publish-btn"]').onclick = () => {
            const n=document.createElement('div');n.className='cheetah-message-warning';
            n.textContent='请确保视频已经上传完毕';document.body.appendChild(n);setTimeout(()=>n.remove(),750);
          };
        }''')
        async def navigation_timeout(*args, **kwargs):
            await asyncio.sleep(1)
            raise TimeoutError('fixture: client validation')
        with patch.object(self.page, 'wait_for_url', side_effect=navigation_timeout), \
                patch.object(bridge, 'reconcile_publication', new=AsyncMock(side_effect=RuntimeError('待核对'))):
            with self.assertRaisesRegex(RuntimeError, '待核对'):
                await self.publish()
        self.assertEqual(self.state['publicationResponses'], [])
        self.assertEqual(self.state['publicationNotices'], ['请确保视频已经上传完毕'])
        self.assertEqual(self.state['publicationObservation']['classification'], 'no_request_validation')
        self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'reconcile')
        self.assertEqual(self.posts, 0)

    def use_history_account(self):
        self.payload['accountName'] = 'history_baijiahao'
        self.state['result']['accountName'] = 'history_baijiahao'
        self.state['payloadDigest'] = bridge.payload_digest(self.payload)
        bridge.write_state(self.file, self.state)

    async def test_history_publication_fills_required_declaration_before_single_submit(self):
        self.use_history_account()
        result = await self.publish()
        self.assertTrue(result['published'])
        self.assertEqual(self.posts, 1)
        self.assertEqual(self.seen_intent['details']['creationDeclaration'],
                         {'value': '含AI生成内容', 'verified': True})
        self.assertEqual(self.state['publicationRequestCount'], 1)

    async def test_observed_declaration_rejection_repairs_original_editor_and_keeps_attempt_history(self):
        self.use_history_account()
        self.state.update(phase='publish_requested', publishAttemptedAt=time.time()-30,
                          publishClickedAt=time.time()-29, publicationRequestCount=0, publicationResponses=[],
                          publicationNotices=['请选择创作声明类型'])
        original_attempt = self.state['publishAttemptedAt']
        bridge.write_state(self.file, self.state)
        with patch.object(bridge, 'account_storage', return_value=({}, 'fixture')):
            self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'save')
        with patch.object(bridge, 'verify_staged', new=AsyncMock()) as verify, \
                patch.object(bridge, 'add_optional_topics', new=AsyncMock(side_effect=AssertionError('read-only')), create=True):
            await bridge.repair_creation_declaration_rejection(self.page, self.payload, self.state, self.file, ())
            verify.assert_awaited_once()
        self.assertEqual(await self.page.get_by_placeholder('请选择创作声明').input_value(), '含AI生成内容')
        self.assertEqual(self.state['targetId'], 'ABC123')
        self.assertEqual(self.state['publicationAttempts'][0]['publishAttemptedAt'], original_attempt)
        self.assertEqual(self.state['publicationAttempts'][0]['publicationNotices'], ['请选择创作声明类型'])
        self.assertNotIn('publishAttemptedAt', self.state)
        self.assertEqual(self.posts, 0)
        result = await self.publish()
        self.assertTrue(result['published'])
        self.assertEqual(self.posts, 1)
        self.assertEqual(len(self.state['publicationAttempts']), 1)

    async def test_unknown_or_sent_publication_cannot_use_declaration_repair(self):
        self.use_history_account()
        base = {**self.state, 'phase': 'publish_requested', 'publishAttemptedAt': time.time()-30,
                'publishClickedAt': time.time()-29, 'publicationRequestCount': 0, 'publicationResponses': [],
                'publicationNotices': ['请选择创作声明类型']}
        invalid_states = [{**base, **changed} for changed in (
            {'publicationNotices': []}, {'publicationResponses': None},
            {'publicationResponses': [{'errno': 1}]}, {'publicationRequestCount': 1},
            {'publicationRequestCount': None}, {'publicationRequestCount': False},
            {'publicationRequestCount': 0.0}, {'publicationNotices': ['未知错误']}, {'documentToken': None})]
        invalid_states.append({key: value for key, value in base.items() if key != 'publicationRequestCount'})
        for state in invalid_states:
            with self.subTest(state=state):
                self.assertFalse(bridge.missing_creation_declaration_rejection(self.payload, state))
                before = self.file.read_bytes()
                with self.assertRaisesRegex(RuntimeError, '只能核对'):
                    await bridge.repair_creation_declaration_rejection(self.page, self.payload, state, self.file, ())
                self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(self.posts, 0)

    async def test_draft_or_ambiguous_records_cannot_complete_or_be_reuploaded(self):
        for status, records in (('draft', 1), ('publish', 2)):
            with self.subTest(status=status, records=records):
                self.record_status, self.records = status, records
                self.state.update(phase='publish_requested', publishAttemptedAt=time.time())
                bridge.write_state(self.file, self.state)
                with patch.object(bridge, 'local_video_duration', return_value=42), self.assertRaisesRegex(RuntimeError, '待核对'):
                    await bridge.reconcile_publication(self.browser, self.payload, self.state, self.file)
                self.assertEqual(bridge.inspect_checkpoint(self.request)['action'], 'reconcile')
                for reset in (False, True):
                    with self.assertRaisesRegex(RuntimeError, '禁止清理'):
                        await bridge.finish_failed_attempt(self.request, reset=reset)
                with self.assertRaisesRegex(RuntimeError, '只能核对'):
                    await bridge.upload({**self.request, 'confirmPublish': True}, 'publish')
                self.assertEqual(self.posts, 0)

    async def test_preflight_is_read_only_and_draft_mode_cannot_publish(self):
        before = self.file.read_bytes()
        with patch.object(bridge, 'verify_staged', new=AsyncMock()) as verify:
            self.assertEqual(await bridge.publication_preflight(self.page, self.payload, self.state, ()),
                             {'ready': True, 'writes': False, 'targetId': 'ABC123'})
            verify.assert_awaited_once()
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(self.posts, 0)
        legacy = {**self.payload}
        legacy.pop('publicationMode')
        with self.assertRaisesRegex(RuntimeError, '模式不一致'):
            await bridge.upload({**self.request, 'payload': legacy, 'confirmPublish': True}, 'publish')
        with self.assertRaisesRegex(RuntimeError, '模式不一致'):
            await bridge.upload({**self.request, 'saveDraft': True}, 'stage')

    async def test_preparing_preflight_fills_declaration_without_a_publish_request(self):
        self.use_history_account()
        with patch.object(bridge, 'verify_staged', new=AsyncMock()), \
                patch.object(bridge, 'finish_staged_baijiahao_cover', new=AsyncMock()) as finish:
            result = await bridge.publication_preflight(self.page, self.payload, self.state, (), prepare_file=self.file)
            finish.assert_awaited_once_with(self.page, self.payload, self.state, self.file, ())
        self.assertEqual(result, {'ready': True, 'writes': True, 'targetId': 'ABC123'})
        self.assertEqual(await self.page.get_by_placeholder('请选择创作声明').input_value(), '含AI生成内容')
        self.assertNotIn('publishAttemptedAt', self.state)
        self.assertEqual(self.posts, 0)

    async def test_accepted_submission_rechecks_only_the_list_after_a_short_index_delay(self):
        self.state.update(phase='publish_requested', publishAttemptedAt=time.time(),
                          publicationRequestCount=1, publicationResponses=[{'httpStatus': 200, 'errno': 0}],
                          publicationError='old failed lookup')
        bridge.write_state(self.file, self.state)
        real_locate = bridge.locate_baijiahao_draft
        calls = 0
        async def delayed_list(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise bridge.BaijiahaoDraftListingError('fixture: not indexed yet',
                    {'outcome': 'not_found', 'pagesScanned': 1, 'rowsScanned': 0})
            return await real_locate(*args, **kwargs)
        with patch.object(bridge, 'locate_baijiahao_draft', side_effect=delayed_list), \
                patch.object(bridge, 'local_video_duration', return_value=42):
            result = await bridge.reconcile_publication(self.browser, self.payload, self.state, self.file)
        self.assertTrue(result['published'])
        self.assertEqual(calls, 2)
        self.assertEqual(self.posts, 0)
        saved = json.loads(self.file.read_text())
        self.assertNotIn('publicationError', saved)
        self.assertEqual(set(saved['publicationCheck']), {'outcome', 'pagesScanned', 'rowsScanned', 'checkedAt'})
        self.assertEqual(saved['publicationCheck']['outcome'], 'matched')

    async def test_unknown_submission_or_ambiguous_list_is_never_retried_or_reclicked(self):
        for responses, outcome in (([], 'not_found'), ([{'httpStatus': 200, 'errno': 0}], 'ambiguous')):
            self.state.update(phase='publish_requested', publishAttemptedAt=time.time(),
                              publicationRequestCount=1, publicationResponses=responses)
            lookup = AsyncMock(side_effect=bridge.BaijiahaoDraftListingError('fixture: unresolved',
                {'outcome': outcome, 'pagesScanned': 1, 'rowsScanned': 0,
                 'cookie': 'must-not-persist', 'candidateIds': ['private-id']}))
            with self.subTest(responses=responses, outcome=outcome), \
                    patch.object(bridge, 'locate_baijiahao_draft', lookup):
                with self.assertRaisesRegex(RuntimeError, '待核对'):
                    await bridge.reconcile_publication(self.browser, self.payload, self.state, self.file)
                self.assertEqual(lookup.await_count, 1)
                saved = json.loads(self.file.read_text())
                self.assertEqual(set(saved['publicationCheck']), {'outcome', 'pagesScanned', 'rowsScanned', 'checkedAt'})
                self.assertEqual(saved['publicationCheck']['outcome'], outcome)
                self.assertEqual(saved['publicationCheck']['pagesScanned'], 1)
                self.assertEqual(saved['publicationCheck']['rowsScanned'], 0)
                self.assertGreater(saved['publicationCheck']['checkedAt'], 0)
                self.assertNotIn('must-not-persist', self.file.read_text())
        self.assertEqual(self.posts, 0)

    async def test_wrong_media_or_duration_does_not_prove_publication(self):
        candidate = {'id': FIRST_ID, 'draft': False, 'statusLabels': ['已发布'], 'record': {
            'article_id': FIRST_ID, 'status': 'publish', 'type': 'video', 'file_name': 'server',
            'title': self.payload['description'], 'created_at': time.time(), 'rmb_duration': 9}}
        self.state['publishAttemptedAt'] = time.time()
        with patch.object(bridge, 'local_video_duration', return_value=42), self.assertRaisesRegex(RuntimeError, '时长'):
            await bridge.verify_publication_record(self.payload, self.state, candidate)
        candidate['record']['rmb_duration'] = 42
        self.state['details']['media']['video_fingerprint'] = 'different-video'
        with self.assertRaisesRegex(RuntimeError, '上传凭证'):
            await bridge.verify_publication_record(self.payload, self.state, candidate)

    async def test_moderation_release_time_uses_same_record_creation_time(self):
        attempted = time.time()
        row = {'id': FIRST_ID, 'title': self.payload['description'], 'video': True, 'draft': False,
               'time': attempted + 600, 'statusLabels': ['已发布'],
               'record': {'article_id': FIRST_ID, 'type': 'video', 'created_at': attempted + 1}}
        self.assertEqual(bridge.matching_publication([row], self.payload['description'], attempted)['id'], FIRST_ID)
        row['record']['created_at'] = attempted - 86400
        with self.assertRaisesRegex(RuntimeError, '没有唯一匹配'):
            bridge.matching_publication([row], self.payload['description'], attempted)

    async def test_corrupt_publication_checkpoint_is_never_archived_for_reupload(self):
        self.file.write_text('corrupt')
        with self.assertRaisesRegex(RuntimeError, '禁止自动重传'):
            await bridge.finish_failed_attempt(self.request, reset=True)
        self.assertTrue(self.file.exists())


if __name__ == '__main__':
    unittest.main()
