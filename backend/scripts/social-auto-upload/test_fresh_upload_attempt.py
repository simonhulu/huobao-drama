"""A failed draft gets a fresh attempt; confirmed saved drafts never reupload."""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import account_browser
import bridge


class FreshAttemptTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = {'jobId':'71','target':'tencent-video','accountName':'history_tencent','title':'原标题'}
        self.request = {'config':{'stateRoot':str(self.root),'tencent':'http://127.0.0.1:9222'},'payload':self.payload}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        self.state = {'phase':'uploading','payloadDigest':bridge.payload_digest(self.payload),
            'targetId':'ABC123','documentToken':'original-token','accountCredentialDigest':'a'*64,
            'error':'portrait cover edit dialog did not open','fileSelectionStartedAt':1}
        self.store()
        self.page = SimpleNamespace(target='ABC123',is_closed=lambda:False,
            evaluate=AsyncMock(return_value={'name':'huobao-sau-71','token':'original-token',
                                            'href':bridge.EDITORS['tencent-video']}),close=AsyncMock())
        self.other = SimpleNamespace(target='FFF111',is_closed=lambda:False,close=AsyncMock())
        self.browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[self.other,self.page])])

        @asynccontextmanager
        async def playwright():
            yield object()
        self.patchers = [patch.object(bridge,'load_engine',return_value=(None,None,playwright,None,None,None)),
            patch.object(account_browser,'connect_existing_account_browser',AsyncMock(return_value=self.browser)),
            patch.object(account_browser,'close_idle_account_browser',AsyncMock(return_value=True)),
            patch.object(bridge,'page_id',AsyncMock(side_effect=lambda page:page.target))]
        for patcher in self.patchers:
            patcher.start();self.addCleanup(patcher.stop)

    def store(self):
        bridge.write_state(self.file,self.state)

    def publication(self):
        video = self.root / 'original.mp4'
        video.write_bytes(b'original video')
        self.payload.update(target='baijiahao-video', accountName='science_example', publicationMode='publish',
                            videoPath=str(video), fingerprint='original')
        self.request['config'].update(root=str(self.root), baijiahao='http://127.0.0.1:9225')
        self.state.update(phase='publish_requested', publishAttemptedAt=10, publishClickedAt=11,
                          payloadDigest=bridge.payload_digest(self.payload), files=bridge.local_files(self.payload),
                          result={'staged':True,'saved':False,'published':False,'accountName':'science_example',
                                  'targetId':'ABC123','editorUrl':bridge.EDITORS['baijiahao-video'],'engine':'fixture'},
                          publicationResponses=[], error='publish response timed out')
        self.page.evaluate.return_value['href'] = bridge.EDITORS['baijiahao-video']
        patcher = patch.object(bridge, 'account_storage', return_value=({}, 'a'*64))
        self.storage = patcher.start(); self.addCleanup(patcher.stop)
        self.store()

    async def test_failure_closes_owned_page_without_saving_or_archiving(self):
        result=await bridge.locked_action(self.request,'close-failed')
        self.assertTrue(result['closed'])
        self.page.close.assert_awaited_once_with(run_before_unload=False)
        self.other.close.assert_not_awaited()
        saved=json.loads(self.file.read_text())
        self.assertEqual(saved['phase'],'failed')
        self.assertEqual(saved['error'],self.state['error'])
        self.assertFalse((self.root/'failed-attempts').exists())

    async def test_failure_before_editor_creation_still_releases_the_idle_managed_browser(self):
        self.state.pop('targetId');self.state.pop('documentToken');self.state['phase']='opening';self.store()
        await bridge.locked_action(self.request,'close-failed')
        account_browser.close_idle_account_browser.assert_awaited_once_with(self.browser)
        self.page.close.assert_not_awaited()
        self.assertEqual(json.loads(self.file.read_text())['phase'],'failed')

    async def test_explicit_retry_archives_old_files_then_allows_a_fresh_checkpoint(self):
        (self.file.parent/'incomplete.png').write_bytes(b'old evidence')
        result=await bridge.locked_action(self.request,'reset-attempt')
        self.assertTrue(result['archived'])
        self.assertFalse(self.file.exists())
        archives=list((self.root/'failed-attempts/71').iterdir())
        self.assertEqual(len(archives),1)
        self.assertEqual((archives[0]/'incomplete.png').read_bytes(),b'old evidence')
        self.assertEqual(json.loads((archives[0]/'state.json').read_text())['phase'],'uploading')
        with patch.object(bridge,'account_storage',return_value=({},'a'*64)), \
             patch.object(bridge,'local_files',return_value={'video.mp4':'fixture-hash'}):
            self.assertEqual(bridge.inspect_checkpoint(self.request)['action'],'upload')
        # A second retry before dispatch does not create another archive.
        self.assertNotIn('archived',await bridge.locked_action(self.request,'reset-attempt'))
        self.assertEqual(len(list((self.root/'failed-attempts/71').iterdir())),1)

    async def test_save_click_without_confirmed_success_is_also_reuploaded_on_explicit_retry(self):
        self.state.update(phase='save_requested',saveAttemptedAt=10,saveClickedAt=11)
        self.store()
        with patch.object(bridge,'reconcile_saved_draft',AsyncMock(side_effect=AssertionError('no resume/reconcile'))):
            self.assertTrue((await bridge.locked_action(self.request,'reset-attempt'))['archived'])
        self.assertFalse(self.file.exists())

    async def test_confirmed_saved_receipt_is_returned_without_closing_or_reuploading(self):
        self.state.update(phase='saved',result={'staged':True,'saved':True,'published':False,
            'accountName':'history_tencent','targetId':'ABC123','engine':'fixture',
            'editorUrl':bridge.EDITORS['tencent-video'],
            'draftUrl':'https://channels.weixin.qq.com/platform/post/draftListManager'})
        self.store();before=self.file.read_bytes()
        with patch.object(bridge,'load_engine',side_effect=AssertionError('no browser for known success')):
            for action in ['close-failed','reset-attempt']:
                self.assertEqual((await bridge.locked_action(self.request,action))['result'],self.state['result'])
        self.assertEqual(self.file.read_bytes(),before)
        self.page.close.assert_not_awaited()

    async def test_reused_manual_page_is_kept_while_failed_checkpoint_is_archived(self):
        self.page.evaluate.return_value={'name':'manual','token':'different','href':'https://example.com'}
        result=await bridge.locked_action(self.request,'reset-attempt')
        self.assertFalse(result['closed']);self.assertTrue(result['archived'])
        self.page.close.assert_not_awaited()

    async def test_original_payload_is_required_before_retry_updates_material_snapshot(self):
        self.payload['title']='changed'
        with self.assertRaisesRegex(RuntimeError,'不匹配'):
            await bridge.locked_action(self.request,'reset-attempt')
        self.assertTrue(self.file.exists());self.page.close.assert_not_awaited()

    async def test_browser_cleanup_failure_does_not_prevent_an_explicit_fresh_attempt(self):
        account_browser.connect_existing_account_browser.side_effect=RuntimeError('Chrome closed')
        self.assertTrue((await bridge.locked_action(self.request,'reset-attempt'))['archived'])
        archive=next((self.root/'failed-attempts/71').iterdir())
        self.assertEqual(json.loads(next(archive.glob('attempt-close-*.json')).read_text())['cleanupError'],'Chrome closed')

    async def test_corrupt_checkpoint_can_be_archived_without_creating_a_browser(self):
        self.file.write_text('{incomplete')
        with patch.object(bridge,'load_engine',side_effect=AssertionError('no usable target')):
            self.assertTrue((await bridge.locked_action(self.request,'reset-attempt'))['archived'])
        self.assertFalse(self.file.exists())

    async def test_active_writer_lock_prevents_reset_or_close(self):
        entered,release=asyncio.Event(),asyncio.Event()
        async def uploading(*args):
            entered.set();await release.wait()
        with patch.object(bridge,'upload',side_effect=uploading):
            pending=asyncio.create_task(bridge.locked_action(self.request,'stage'))
            await entered.wait()
            try:
                before=self.file.read_bytes()
                for action in ['reset-attempt','close-failed']:
                    with self.assertRaisesRegex(RuntimeError,'正在运行'):
                        await bridge.locked_action(self.request,action)
                self.assertEqual(self.file.read_bytes(),before)
            finally:
                release.set();await pending

    async def test_duplicate_opt_in_archives_uncertain_publication_without_overwriting_its_evidence(self):
        self.publication(); self.request['allowDuplicateSubmission'] = True
        result = await bridge.locked_action(self.request, 'reset-attempt')
        self.assertTrue(result['archived']); self.assertTrue(result['closed'])
        self.assertFalse(self.file.exists())
        archive = next((self.root / 'failed-attempts/71').iterdir())
        evidence = json.loads((archive / 'state.json').read_text())
        for key in ('phase', 'publishAttemptedAt', 'publishClickedAt', 'publicationResponses', 'error', 'payloadDigest', 'files'):
            self.assertEqual(evidence[key], self.state[key])
        closed = json.loads(next(archive.glob('attempt-close-*.json')).read_text())
        self.assertIs(closed['allowDuplicateSubmission'], True)
        self.assertEqual(closed['reason'], 'explicit_duplicate_submission_retry')
        self.page.close.assert_awaited_once_with(run_before_unload=False)

    async def test_uncertain_publication_still_requires_exact_opt_in_and_reset_action(self):
        self.publication(); before = self.file.read_bytes()
        for flag in (None, False, 'true', 1):
            self.request['allowDuplicateSubmission'] = flag
            with self.assertRaisesRegex(RuntimeError, '禁止'):
                await bridge.locked_action(self.request, 'reset-attempt')
        self.request['allowDuplicateSubmission'] = True
        with self.assertRaisesRegex(RuntimeError, '禁止'):
            await bridge.locked_action(self.request, 'close-failed')
        self.assertEqual(self.file.read_bytes(), before); self.page.close.assert_not_awaited()

    async def test_duplicate_opt_in_keeps_confirmed_publication_receipts_without_closing(self):
        self.publication(); self.request['allowDuplicateSubmission'] = True
        for phase, published in [('submitted', False), ('published', True), ('publish_requested', False)]:
            self.state.update(phase=phase)
            self.state['result'].update(submitted=True, published=published,
                publicationStatus='published' if published else 'submitted', articleId='1880027026933416669',
                publishedUrl='https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669')
            self.store(); before = self.file.read_bytes()
            with patch.object(bridge, 'load_engine', side_effect=AssertionError('known success must not open a browser')):
                self.assertEqual((await bridge.locked_action(self.request, 'reset-attempt'))['result'], self.state['result'])
            self.assertEqual(self.file.read_bytes(), before)
        self.assertFalse((self.root / 'failed-attempts').exists()); self.page.close.assert_not_awaited()

    async def test_duplicate_opt_in_does_not_override_account_payload_file_or_credential_mismatches(self):
        self.publication(); self.request['allowDuplicateSubmission'] = True
        original = json.loads(self.file.read_text())
        for changed in ({'payloadDigest':'b'*64}, {'accountCredentialDigest':'b'*64},
                        {'files':{self.payload['videoPath']:'b'*64}},
                        {'result':{**self.state['result'], 'accountName':'science_other'}},
                        {'pendingCoverRevision':'b'*64}):
            self.state = {**original, **changed}; self.store(); before = self.file.read_bytes()
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, '不匹配|变化|封面|账号'):
                await bridge.locked_action(self.request, 'reset-attempt')
            self.assertEqual(self.file.read_bytes(), before)
        self.assertFalse((self.root / 'failed-attempts').exists()); self.page.close.assert_not_awaited()

    async def test_duplicate_opt_in_archives_corrupt_publication_bytes_with_a_separate_close_record(self):
        self.publication(); self.file.write_text('{incomplete publish checkpoint')
        before = self.file.read_bytes(); self.request['allowDuplicateSubmission'] = True
        with patch.object(bridge, 'load_engine', side_effect=AssertionError('corrupt records have no trusted page binding')):
            self.assertTrue((await bridge.locked_action(self.request, 'reset-attempt'))['archived'])
        archive = next((self.root / 'failed-attempts/71').iterdir())
        self.assertEqual((archive / 'state.json').read_bytes(), before)
        closed = json.loads(next(archive.glob('attempt-close-*.json')).read_text())
        self.assertIs(closed['allowDuplicateSubmission'], True)
        self.assertIn('checkpointIssue', closed)

    async def test_corrupt_publication_checkpoint_without_opt_in_still_cannot_be_reset(self):
        self.publication(); self.file.write_text('{incomplete publish checkpoint'); before = self.file.read_bytes()
        with self.assertRaisesRegex(RuntimeError, '禁止'):
            await bridge.locked_action(self.request, 'reset-attempt')
        self.assertEqual(self.file.read_bytes(), before)

    async def test_duplicate_opt_in_archives_damaged_structure_without_normalizing_original_bytes(self):
        self.publication(); self.request['allowDuplicateSubmission'] = True
        for state in (None, [], {}, {'phase':'unknown'}):
            self.file.parent.mkdir(parents=True, exist_ok=True)
            self.file.write_text(json.dumps(state)); before = self.file.read_bytes()
            with patch.object(bridge, 'load_engine', side_effect=AssertionError('no trusted page binding')):
                self.assertTrue((await bridge.locked_action(self.request, 'reset-attempt'))['archived'])
            archive = max((self.root / 'failed-attempts/71').iterdir(), key=lambda value:value.name)
            self.assertEqual((archive / 'state.json').read_bytes(), before)
            closed = json.loads(next(archive.glob('attempt-close-*.json')).read_text())
            self.assertEqual(closed['checkpointIssue'], 'invalid_checkpoint_structure')

    async def test_duplicate_opt_in_cannot_archive_a_running_writer(self):
        self.publication(); self.request['allowDuplicateSubmission'] = True
        entered, release = asyncio.Event(), asyncio.Event()
        async def uploading(*args):
            entered.set(); await release.wait()
        with patch.object(bridge, 'upload', side_effect=uploading):
            pending = asyncio.create_task(bridge.locked_action(self.request, 'stage')); await entered.wait()
            try:
                before = self.file.read_bytes()
                with self.assertRaisesRegex(RuntimeError, '正在运行'):
                    await bridge.locked_action(self.request, 'reset-attempt')
                self.assertEqual(self.file.read_bytes(), before)
            finally:
                release.set(); await pending


class ExistingBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def test_absent_old_browser_never_launches_or_imports_login(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(account_browser.subprocess,'Popen',side_effect=AssertionError('must not launch')):
                self.assertIsNone(await account_browser.connect_existing_account_browser(None,{'stateRoot':temporary},'history_tencent','a'*64))
                self.assertIsNone(await account_browser.connect_existing_account_browser(None,{'stateRoot':temporary},'history_tencent','../invalid'))


if __name__=='__main__':unittest.main()
