"""Regression cases from batch jobs 21/23/32; never use the live account."""
import json
import hashlib
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bridge
from playwright.async_api import async_playwright


class TencentUploadRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_each_resume_can_retry_a_new_explicit_failure_once_but_success_never_reuploads(self):
        payload = {"jobId": "23", "target": "tencent-video", "title": "原任务短标题", "description": "原任务文案",
                   "videoPath": "original.mp4", "landscapePath": "4x3.png", "portraitPath": "3x4.png"}
        state = {"phase": "uploading", "protocolVersion": 2, "fileSelectionStartedAt": 1,
                 "targetId": "ABC123", "documentToken": "original-document"}
        page = MagicMock()
        page.locator.return_value.first.wait_for = AsyncMock()
        page.locator.return_value.input_value = AsyncMock(return_value="")
        page.locator.return_value.inner_text = AsyncMock(return_value="")
        page.locator.return_value.count = AsyncMock(return_value=0)
        app = SimpleNamespace(upload_video_file=AsyncMock(return_value={"sha256": "same-source"}),
                              wait_for_upload_complete=AsyncMock(return_value={"src": "blob:retried"}),
                              prepare_video_for_publish=AsyncMock(return_value={"description": payload["description"]}))
        helpers = SimpleNamespace(validate_stage=MagicMock(), declarations=AsyncMock(return_value={}),
            verify_existing_video=AsyncMock(return_value={"sha256": "same-source"}),
            snapshot=AsyncMock(return_value={"errors": ["网络出错，请重新上传。"], "progress": []}),
            wait_for_video=AsyncMock(side_effect=RuntimeError("WeChat upload failed; no automatic re-upload")))
        covers = SimpleNamespace(verify_covers=AsyncMock())
        engine = (None, MagicMock(return_value=app), None, None, helpers, covers)
        recorded = []
        def record_retry(details):
            state["videoRetry"] = details
            recorded.append(dict(details))
        with patch.dict("sys.modules", {"tencent_cover_upload": SimpleNamespace(upload_tencent_covers=AsyncMock(return_value={}))}), \
             patch.object(bridge, "verify_document", new=AsyncMock()), \
             patch.object(bridge, "clear_failed_tencent_video", new=AsyncMock(), create=True) as clear, \
             patch.object(bridge, "verify_tencent_metadata", new=AsyncMock(return_value={"description": payload["description"]})):
            result = await bridge.stage_tencent_video(page, payload, "http://127.0.0.1:9222", engine,
                reuse_upload=True, recovery_state=state, checkpoint_retry=record_retry)
            self.assertEqual(result["video"]["selected"]["sha256"], "same-source")
            self.assertEqual(len(recorded), 1)
            self.assertEqual(recorded[0]["attempts"], 1)
            self.assertEqual(state["fileSelectionStartedAt"], 1)
            self.assertEqual(state["documentToken"], "original-document")
            clear.assert_awaited_once()
            app.upload_video_file.assert_awaited_once_with(page, "original.mp4")
            app.prepare_video_for_publish.assert_awaited_once()
            # The next explicit resume has its own single attempt. The backend
            # owns the automatic retry budget; a past attempt is not a dead end.
            await bridge.stage_tencent_video(page, payload, "http://127.0.0.1:9222", engine,
                reuse_upload=True, recovery_state=state, checkpoint_retry=record_retry)
            self.assertEqual(app.upload_video_file.await_count, 2)
            self.assertEqual(clear.await_count, 2)
            self.assertEqual(recorded[-1]["attempts"], 2)
            helpers.snapshot.return_value = {"errors": [], "progress": []}
            helpers.wait_for_video.side_effect = None
            helpers.wait_for_video.return_value = {"src": "blob:retried"}
            await bridge.stage_tencent_video(page, payload, "http://127.0.0.1:9222", engine,
                reuse_upload=True, previous=result, recovery_state=state, checkpoint_retry=record_retry)
            self.assertEqual(app.upload_video_file.await_count, 2, "successful media must not be reselected")
            self.assertEqual(len(recorded), 2)

    async def test_save_attempt_or_changed_document_cannot_reselect_video(self):
        payload = {"jobId": "23", "target": "tencent-video", "title": "原任务短标题", "description": "原任务文案",
                   "videoPath": "original.mp4", "landscapePath": "4x3.png", "portraitPath": "3x4.png"}
        for marker in ({"saveAttemptedAt": 123}, {"result": {"saved": False}}, {"documentToken": "changed"}):
            with self.subTest(marker=marker):
                page = MagicMock()
                page.locator.return_value.first.wait_for = AsyncMock()
                page.locator.return_value.input_value = AsyncMock(return_value="")
                page.locator.return_value.inner_text = AsyncMock(return_value="")
                app = SimpleNamespace(upload_video_file=AsyncMock())
                helpers = SimpleNamespace(validate_stage=MagicMock(), declarations=AsyncMock(return_value={}),
                    verify_existing_video=AsyncMock(return_value={}),
                    snapshot=AsyncMock(return_value={"errors": ["网络出错，请重新上传。"], "progress": []}))
                state = {"phase": "uploading", "protocolVersion": 2, "fileSelectionStartedAt": 1,
                         "targetId": "ABC123", "documentToken": "bound", **marker}
                proof = AsyncMock(side_effect=RuntimeError("原编辑页绑定变化")) if marker.get("documentToken") else AsyncMock()
                with patch.object(bridge, "verify_document", new=proof), \
                     patch.object(bridge, "clear_failed_tencent_video", new=AsyncMock(), create=True) as clear:
                    with self.assertRaises(RuntimeError):
                        await bridge.stage_tencent_video(page, payload, "http://127.0.0.1:9222",
                            (None, MagicMock(return_value=app), None, None, helpers, None), reuse_upload=True,
                            recovery_state=state, checkpoint_retry=MagicMock())
                app.upload_video_file.assert_not_awaited()
                clear.assert_not_awaited()


class DraftRecoveryBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = Path(self.tmp.name) / "state.json"
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()

    async def creation_dialog_fixture(self, *, dialog_text="创作声明", video_changed=False, metadata_changed=False):
        root = Path(self.tmp.name)
        files = {key: root / name for key, name in (("videoPath", "original.mp4"),
                 ("landscapePath", "landscape.png"), ("portraitPath", "portrait.png"))}
        for key, path in files.items():
            path.write_bytes(key.encode())
        payload = {"jobId": "declaration-resume", "target": "baijiahao-video", "publicationMode": "publish",
                   "accountName": "history_baijiahao", "title": "原成片标题", "description": "原成片文案",
                   **{key: str(path) for key, path in files.items()}}
        request = {"config": {"stateRoot": str(root / "state")}, "payload": payload}
        file = bridge.job_state_file(request)
        file.parent.mkdir(parents=True, exist_ok=True)
        page = await self.context.new_page()
        await self.context.route("https://baijiahao.baidu.com/**", lambda route: route.fulfill(body="<main></main>"))
        await page.goto(bridge.EDITORS["baijiahao-video"])
        await page.set_content('''<input id="media" type="file" onchange="actions.uploads++">
          <input id="declaration" placeholder="请选择创作声明" readonly onclick="actions.fieldClicks++">
          <div id="description">原成片文案</div>
          <img id="landscape" src="data:image/png;base64,landscape">
          <img id="portrait" src="data:image/png;base64,portrait">
          <button onclick="actions.publishes++">发布</button>
          <div role="dialog" style="position:fixed;inset:0;background:white;z-index:10">
            <h2></h2><p>必选声明</p><span onclick="chosen='含AI生成内容'">含AI生成内容</span>
            <button onclick="actions.declarations++;document.querySelector('#declaration').value=chosen;this.parentElement.remove()">确定</button>
          </div><script>window.actions={uploads:0,fieldClicks:0,declarations:0,cropConfirms:0,publishes:0};let chosen='';</script>''')
        await page.locator("h2").evaluate("(e,text)=>e.textContent=text", dialog_text)
        await page.evaluate("() => {window.name='huobao-sau-declaration-resume';window.__huobaoSauDocumentToken='original-document'}")
        digest = lambda filename: hashlib.sha256(Path(filename).read_bytes()).hexdigest()
        media = {"status": "uploaded", "verification": "blob_sha256", "media_src": "blob:original",
                 "video_fingerprint": digest(payload["videoPath"])}
        covers = {"layout": "videoV2", **{kind: {"status": "uploaded", "preview": f"data:image/png;base64,{kind}",
                  "fingerprint": digest(payload[key]), "source_sha256_verified": digest(payload[key]),
                  "verification": "source_and_preview", "confirmClicks": 1}
                  for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath"))}}
        state = {"phase": "uploading", "protocolVersion": 3, "payloadDigest": bridge.payload_digest(payload),
                 "files": bridge.local_files(payload), "targetId": await bridge.page_id(page),
                 "documentToken": "original-document", "fileSelectionStartedAt": 1,
                 "details": {"media": media, "metadata": {"layout": "videoV2", "description": {"status": "filled", "value": payload["description"]}},
                             "covers": covers, "engine": "social-auto-upload/baijiahao-local-stage"}}
        bridge.write_state(file, state)
        async def slots(_page):
            return {kind: {"src": await page.locator(f"#{kind}").get_attribute("src"), "index": index, "image_inputs": [0]}
                    for index, kind in enumerate(("landscape", "portrait"))}
        helpers = SimpleNamespace(_READ_DIALOGS="() => [...document.querySelectorAll('[role=dialog]')].filter(e=>e.offsetHeight).map((e,index)=>({index,text:e.innerText}))",
            _READ_METADATA="() => document.querySelector('#description').innerText",
            _metadata_fields=lambda value: ("videoV2", {"description": {"value": value}}),
            _file_digest=digest, _cover_slots=slots, verify_page=AsyncMock(),
            verify_upload=AsyncMock(return_value={**media, **({"media_src": "blob:changed"} if video_changed else {})}))
        if metadata_changed:
            await page.locator("#description").evaluate("e=>e.textContent='另一任务文案'")
        return page, request, state, file, helpers

    async def resume_fixture(self, request, helpers):
        engine = (None, None, async_playwright, helpers, None, None)
        with patch.object(bridge, "load_engine", return_value=engine), \
                patch.object(bridge, "connect_upload_browser", new=AsyncMock(return_value=(self.browser, "fixture", None))):
            return await bridge.upload(request, "resume")

    async def test_resume_bound_video_finishes_existing_declaration_before_reusing_covers(self):
        page, request, original, file, helpers = await self.creation_dialog_fixture()
        result = await self.resume_fixture(request, helpers)
        self.assertTrue(result["staged"])
        self.assertFalse(result["published"])
        self.assertEqual(await page.evaluate("actions"), {"uploads": 0, "fieldClicks": 0, "declarations": 1, "cropConfirms": 0, "publishes": 0})
        saved = json.loads(file.read_text())
        self.assertEqual(saved["details"]["media"], original["details"]["media"])
        self.assertEqual(saved["details"]["settings"]["creationDeclaration"], {"value": "含AI生成内容", "verified": True})
        self.assertEqual(saved["details"]["covers"]["landscape"]["confirmClicks"], 1)
        self.assertEqual(saved["details"]["covers"]["portrait"]["confirmClicks"], 1)
        self.assertNotIn("publishAttemptedAt", saved)

    async def test_declaration_recovery_rejects_changed_video_or_copy_before_any_click(self):
        for change in ({"video_changed": True}, {"metadata_changed": True}):
            page, request, _, _, helpers = await self.creation_dialog_fixture(**change)
            with self.assertRaisesRegex(RuntimeError, "已被替换|文案已变化"):
                await self.resume_fixture(request, helpers)
            self.assertEqual((await page.evaluate("actions"))["declarations"], 0)
            await page.close()

    async def test_declaration_recovery_keeps_unknown_modal_changed_cover_and_prior_submission_untouched(self):
        for change in ("unknown-dialog", "second-dialog", "changed-cover", "changed-document", "prior-publish", "other-declaration"):
            with self.subTest(change=change):
                page, request, state, file, helpers = await self.creation_dialog_fixture()
                if change == "unknown-dialog":
                    await page.locator("h2").evaluate("e=>e.textContent='其他操作确认'")
                elif change == "second-dialog":
                    await page.evaluate("() => {const e=document.createElement('div');e.setAttribute('role','dialog');e.textContent='其他确认';document.body.appendChild(e)}")
                elif change == "changed-cover":
                    await page.locator("#portrait").evaluate("e=>e.src='data:image/png;base64,changed'")
                elif change == "changed-document":
                    await page.evaluate("() => window.__huobaoSauDocumentToken='different-document'")
                elif change == "prior-publish":
                    state["publishAttemptedAt"] = 123
                    bridge.write_state(file, state)
                else:
                    await page.locator("#declaration").evaluate("e=>e.value='内容为转载'")
                with self.assertRaises(RuntimeError):
                    await self.resume_fixture(request, helpers)
                self.assertEqual(await page.evaluate("actions"), {"uploads": 0, "fieldClicks": 0, "declarations": 0, "cropConfirms": 0, "publishes": 0})
                self.assertGreaterEqual(await page.locator('[role="dialog"]:visible').count(), 1)
                await page.close()

    async def test_failed_upload_reset_uses_only_its_inline_delete_confirmation(self):
        page = await self.context.new_page()
        await page.set_content('''<main></main><script>
          window.actions={deleted:0,saved:0,published:0};
          const root=document.querySelector('main').attachShadow({mode:'open'});
          root.innerHTML=`<div class="media-status-content">
            <div class="status-msg error">网络出错，请重新上传。</div>
            <div class="tag-inner">删除</div>
            <div class="weui-desktop-popover" style="display:none">
              删除后需重新上传<button>取消</button><button id="delete">删除</button>
            </div></div><button id="save">保存草稿</button><button id="publish">发表</button>`;
          root.querySelector('.tag-inner').onclick=()=>root.querySelector('.weui-desktop-popover').style.display='block';
          root.querySelector('#delete').onclick=()=>{actions.deleted++;root.querySelector('.media-status-content').remove()};
          root.querySelector('#save').onclick=()=>actions.saved++;
          root.querySelector('#publish').onclick=()=>actions.published++;
        </script>''')
        await bridge.clear_failed_tencent_video(page)
        self.assertEqual(await page.evaluate("window.actions"), {"deleted": 1, "saved": 0, "published": 0})

    async def test_baijiahao_waits_for_replaced_search_row_and_ignores_hidden_button(self):
        title = "第五次反围剿为何失利"
        row = {"title": title, "draft": True, "video": True, "time": "2026-10-23 19:17:12",
               "url": "https://baijiahao.baidu.com/builder/preview/s?id=1879839061486449024"}
        edit_url = "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=1879839061486449024"
        html = f'''<div class="client_pages_content_v2_components_articleItem">
          <div class="title"><a href="{row['url']}">{title}</a></div>
          <span class="article-action-btn" style="display:none">修改</span>
          <span class="article-action-btn" onclick="window.open('{edit_url}')">修改</span></div>'''
        async def search(page, **kwargs):
            await page.set_content("<main>正在查询</main>")
            await page.evaluate("html=>setTimeout(()=>document.body.innerHTML=html,150)", html)
            candidate = kwargs['match']([row], kwargs['title'], kwargs['attempted_at'], target=kwargs['target'])
            return candidate, page.locator('.client_pages_content_v2_components_articleItem'), {'outcome': 'found'}
        await self.context.route("https://baijiahao.baidu.com/**", lambda route: route.fulfill(
            body='<div class="videov2-title-wrap"><div contenteditable="true">文案</div></div>'))
        payload = {"target": "baijiahao-video", "description": title}
        state = {"phase": "save_requested", "saveAttemptedAt": 1792754231.348268,
                 "result": {"saved": False, "published": False, "targetId": "original"}, "details": {"metadata": {}}}
        helpers = SimpleNamespace(_verify_metadata=AsyncMock())
        proof = AsyncMock(return_value={"verification": "platform_draft_record_metadata_video"})
        with patch.object(bridge, "locate_baijiahao_draft", new=search), \
             patch.object(bridge, "verify_saved_video", new=proof):
            result = await bridge.reconcile_saved_draft(self.browser, payload, state, self.file, (None, None, None, helpers))
        self.assertTrue(result["saved"])
        self.assertEqual(state["saveEvidence"]["draftId"], "1879839061486449024")
        self.assertEqual(state["saveAttemptedAt"], 1792754231.348268)
        proof.assert_awaited_once()

    async def test_missing_tencent_record_reports_absence_not_a_save_time_mismatch(self):
        await self.context.route("https://channels.weixin.qq.com/**", lambda route: route.fulfill(body='''
            <div class="post-draft-item"><div class="post-title">另一个项目</div>
             <div class="post-time">2026年10月23日 19:41</div></div>'''))
        payload = {"target": "tencent-video", "title": "朱由校为何传位弟弟", "description": "朱由校原文案"}
        state = {"phase": "save_requested", "saveAttemptedAt": 1792755661.3044019,
                 "saveClickedAt": 1792755661.328595, "result": {"saved": False, "published": False},
                 "details": {"metadata": {"description": payload["description"]}}}
        with self.assertRaisesRegex(RuntimeError, "没有找到本任务文案"):
            await bridge.reconcile_tencent_draft(self.browser, payload, state, self.file, ())
        persisted = json.loads(self.file.read_text())
        self.assertEqual(persisted["draftCheck"]["outcome"], "not_found")
        self.assertFalse(persisted["result"]["saved"])
        self.assertEqual(persisted["saveClickedAt"], state["saveClickedAt"])
        self.assertTrue((self.file.parent / "reconcile-incomplete.png").exists())


if __name__ == "__main__":
    unittest.main()
