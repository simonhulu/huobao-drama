import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from playwright.async_api import async_playwright
import bridge


class TencentTitleTest(unittest.TestCase):
    def test_only_unsupported_symbols_are_removed_without_changing_source(self):
        source = "朱由校为何传位弟弟真相令人深思。"
        self.assertEqual(bridge.tencent_platform_title(source), "朱由校为何传位弟弟真相令人深思")
        self.assertEqual(bridge.tencent_platform_title("明朝，皇位！《史记》：为何？50%℃+"), "明朝 皇位《史记》：为何？50%℃+")
        self.assertTrue(source.endswith("。"))


class TencentRejectedSaveTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = Path(self.tmp.name) / "state.json"
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        self.payload = {"jobId": "32", "target": "tencent-video", "title": "朱由校为何传位弟弟真相令人深思。",
                        "description": "原始项目文案"}
        await self.page.set_content('''<main><div class="post-short-title-wrap">
          <input placeholder="填写短标题"><div class="error-title">标题包含特殊字符，符号仅支持书名号、引号、冒号、加号、问号、百分号、摄氏度</div>
          </div><div class="input-editor" contenteditable></div><button>保存草稿</button><button>发表</button></main>
          <script>
          window.name='huobao-sau-32';window.__huobaoSauDocumentToken='original-document';
          window.flags={draftObjectId:'',needCache:true,isCaching:false,isPosting:false,handleLeaveDialogShow:false};
          document.querySelector('main').__vue__={$options:{methods:{handleCache(){}}},
            draftStore:{get objectId(){return flags.draftObjectId}},
            get needCache(){return flags.needCache},get isCaching(){return flags.isCaching},
            get isPosting(){return flags.isPosting},get handleLeaveDialogShow(){return flags.handleLeaveDialogShow}};
          window.clicks=0;document.querySelectorAll('button').forEach(e=>e.onclick=()=>clicks++);
          document.querySelector('input').oninput=()=>document.querySelector('.error-title').style.display='none';
          </script>''')
        # Initial platform state is populated without triggering validation.
        await self.page.locator('input').evaluate('(e,value)=>e.value=value', self.payload['title'])
        await self.page.locator('[contenteditable]').evaluate('(e,value)=>e.textContent=value', self.payload['description'])
        self.state = {"phase": "save_requested", "targetId": await bridge.page_id(self.page), "documentToken": "original-document",
                      "payloadDigest": bridge.payload_digest(self.payload), "files": {},
                      "saveAttemptedAt": 1792755661.3044019, "saveClickedAt": 1792755661.328595,
                      "details": {"metadata": {"short_title": self.payload['title'], "description": self.payload['description']}},
                      "result": {"staged": True, "saved": False, "published": False}}
        await self.context.route('https://channels.weixin.qq.com/**', lambda route: route.fulfill(content_type='text/html; charset=utf-8', body='''
          <div class="post-draft-item"><div class="post-title">其他项目</div><div>2026年10月23日 19:41</div></div>'''))

    async def reconcile(self, enabled=False):
        with patch.object(bridge, 'local_files', return_value={}):
            return await bridge.reconcile_saved_draft(self.browser, self.payload, self.state, self.file,
                                                      (), repair_rejected_save=enabled)

    async def test_default_reconciliation_never_edits_or_saves_rejected_title(self):
        with patch.object(bridge, 'save_draft', new=AsyncMock()) as save:
            with self.assertRaisesRegex(RuntimeError, '没有找到本任务文案'):
                await self.reconcile()
        save.assert_not_awaited()
        self.assertEqual(await self.page.locator('input').input_value(), self.payload['title'])
        self.assertNotIn('saveRejections', self.state)

    async def test_opt_in_repairs_original_title_preserves_audit_and_uses_existing_save(self):
        # The live new-video editor uses null; older editors use an empty string.
        await self.page.evaluate('flags.draftObjectId=null')
        attempted, clicked = self.state['saveAttemptedAt'], self.state['saveClickedAt']
        digest = self.state['payloadDigest']
        async def save(page, payload, state, file, engine):
            self.assertIs(page, self.page)
            self.assertEqual(state['phase'], 'staged')
            self.assertNotIn('saveAttemptedAt', state)
            audit = json.loads(file.read_text())['saveRejections'][0]
            self.assertEqual(audit['saveAttemptedAt'], attempted)
            self.assertEqual(audit['saveClickedAt'], clicked)
            self.assertIn('标题包含特殊字符', audit['reason'])
            self.assertEqual(audit['draftCheck']['outcome'], 'not_found')
            self.assertEqual(await page.locator('input').input_value(), '朱由校为何传位弟弟真相令人深思')
            self.assertEqual(payload['title'], self.payload['title'])
            self.assertEqual(state['payloadDigest'], digest)
            self.assertEqual(state['documentToken'], 'original-document')
            return {**state['result'], 'saved': True}
        with patch.object(bridge, 'save_draft', new=AsyncMock(side_effect=save)) as saved:
            result = await self.reconcile(True)
        self.assertTrue(result['saved'])
        saved.assert_awaited_once()
        self.assertEqual(await self.page.evaluate('clicks'), 0)

    async def test_busy_saved_or_changed_pages_never_reenter_save(self):
        for change in ({'isCaching': True}, {'isPosting': True}, {'draftObjectId': 'existing'}, {'draftObjectId': 0},
                       {'needCache': False}, {'handleLeaveDialogShow': True}):
            with self.subTest(change=change):
                await self.page.evaluate('change=>Object.assign(flags,{draftObjectId:"",needCache:true,isCaching:false,isPosting:false,handleLeaveDialogShow:false},change)', change)
                with patch.object(bridge, 'save_draft', new=AsyncMock()) as save:
                    with self.assertRaisesRegex(RuntimeError, '没有找到本任务文案'):
                        await self.reconcile(True)
                save.assert_not_awaited()
                self.assertNotIn('saveRejections', self.state)
        await self.page.evaluate('window.__huobaoSauDocumentToken="changed"')
        with patch.object(bridge, 'save_draft', new=AsyncMock()) as save:
            with self.assertRaisesRegex(RuntimeError, '已重载或被替换'):
                await self.reconcile(True)
        save.assert_not_awaited()

    async def test_existing_draft_or_no_explicit_error_cannot_trigger_repair(self):
        await self.page.locator('.error-title').evaluate('e=>e.style.display="none"')
        with patch.object(bridge, 'save_draft', new=AsyncMock()) as save:
            with self.assertRaisesRegex(RuntimeError, '没有找到本任务文案'):
                await self.reconcile(True)
        save.assert_not_awaited()
        await self.context.unroute('https://channels.weixin.qq.com/**')
        await self.context.route('https://channels.weixin.qq.com/**', lambda route: route.fulfill(content_type='text/html; charset=utf-8', body='''
          <div class="post-draft-item"><div class="post-title">原始项目文案</div><div>2026年10月23日 17:41</div></div>'''))
        with patch.object(bridge, 'repair_tencent_rejected_title', new=AsyncMock()) as repair:
            with self.assertRaises(RuntimeError) as caught:
                await self.reconcile(True)
        self.assertEqual(caught.exception.diagnostic['outcome'], 'unmatched')
        self.assertTrue(caught.exception.diagnostic['complete'])
        self.assertEqual(self.state['draftCheck']['outcome'], 'unmatched')
        self.assertEqual(self.state['draftCheck']['matchingDescriptionCount'], 1)
        repair.assert_not_awaited()

    async def test_reopened_metadata_accepts_source_or_sanitized_title_only(self):
        for title in (self.payload['title'], bridge.tencent_platform_title(self.payload['title'])):
            await self.page.locator('input').fill(title)
            result = await bridge.verify_tencent_metadata(self.page, self.payload['title'], self.payload['description'])
            self.assertEqual(result['short_title'], title)
        await self.page.locator('input').fill('其他项目短标题')
        with self.assertRaisesRegex(RuntimeError, '短标题已变化'):
            await bridge.verify_tencent_metadata(self.page, self.payload['title'], self.payload['description'])

    async def test_interruption_after_title_fill_resumes_same_attempt_but_not_a_new_save(self):
        original_verify = bridge.verify_document
        async def interrupted(*args):
            await original_verify(*args)
            # ID recovery also verifies the document now. Interrupt at the
            # observable title change, not at a particular call count.
            if await self.page.locator('input').input_value() == bridge.tencent_platform_title(self.payload['title']):
                raise RuntimeError('模拟标题填写后中断')
        attempted = self.state['saveAttemptedAt']
        with patch.object(bridge, 'verify_document', new=interrupted):
            with self.assertRaisesRegex(RuntimeError, '模拟标题填写后中断'):
                await self.reconcile(True)
        self.state = json.loads(self.file.read_text())
        self.assertEqual(self.state['saveAttemptedAt'], attempted)
        self.assertEqual(len(self.state['saveRejections']), 1)
        self.assertEqual(await self.page.locator('input').input_value(), bridge.tencent_platform_title(self.payload['title']))
        self.state['saveAttemptedAt'] = attempted + 10
        with patch.object(bridge, 'save_draft', new=AsyncMock()) as save:
            with self.assertRaisesRegex(RuntimeError, '没有找到本任务文案'):
                await self.reconcile(True)
        save.assert_not_awaited()
        self.assertEqual(self.state['saveAttemptedAt'], attempted + 10)
        self.state['saveAttemptedAt'] = attempted
        with patch.object(bridge, 'save_draft', new=AsyncMock(return_value={'saved': True})) as save:
            result = await self.reconcile(True)
        self.assertTrue(result['saved'])
        save.assert_awaited_once()
        self.assertEqual(len(self.state['saveRejections']), 1)


if __name__ == '__main__':
    unittest.main()
