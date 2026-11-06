"""Bound account review must retain original documents and avoid platform writes."""
import base64
from contextlib import asynccontextmanager
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import bridge
import review_session
from upload_locks import UploadLockBusy, account_lock_key, upload_locks


class Page:
    def __init__(self, target="ABC123", url=None):
        self.target = target
        self.url = url or bridge.EDITORS["baijiahao-video"]
        self.viewport_size = {"width": 1440, "height": 1000}
        self.mouse = SimpleNamespace(click=AsyncMock(), move=AsyncMock(), down=AsyncMock(), up=AsyncMock(), wheel=AsyncMock())
        self.keyboard = SimpleNamespace(insert_text=AsyncMock(), press=AsyncMock())
        self.goto = AsyncMock(side_effect=self.navigate)
        self.close = AsyncMock()
        self.set_viewport_size = AsyncMock()
        self.screenshot = AsyncMock(return_value=b"jpeg-fixture")

    async def navigate(self, url, **_):
        self.url = url

    def is_closed(self):
        return False


class ReviewSessionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = {"jobId": "science-task-baijiahao", "target": "baijiahao-video", "accountName": "science_account", "title": "原任务"}
        self.request = {"config": {"stateRoot": str(self.root)}, "payload": self.payload}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        self.digest = "a" * 64
        self.state = {"payloadDigest": bridge.payload_digest(self.payload), "accountCredentialDigest": self.digest,
                      "targetId": "ABC123", "documentToken": "bound", "phase": "uploading"}
        bridge.write_state(self.file, self.state)
        self.page = Page()
        self.other = Page("FFF111")
        self.content = Page("DDD222", review_session.CONTENT_URL)
        self.context = SimpleNamespace(pages=[self.other, self.page])
        self.context.new_page = AsyncMock(side_effect=self.new_page)
        self.browser = SimpleNamespace(contexts=[self.context], _huobao_managed_session={"credentialDigest": self.digest})

        @asynccontextmanager
        async def playwright():
            yield object()

        self.existing = AsyncMock(return_value=self.browser)
        self.connect = AsyncMock(return_value=(self.browser, "http://127.0.0.1:1234", self.digest))
        self.verify = AsyncMock()
        patchers = [patch.object(review_session, "connect_existing_account_browser", self.existing),
                    patch.object(review_session, "connect_account_browser", self.connect),
                    patch.object(bridge, "load_engine", return_value=(None, None, playwright, None, None, None)),
                    patch.object(bridge, "page_id", AsyncMock(side_effect=lambda page: page.target)),
                    patch.object(bridge, "verify_document", self.verify)]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    async def new_page(self):
        self.context.pages.append(self.content)
        return self.content

    async def review(self, **extra):
        return await review_session.review_session({**self.request, **extra}, bridge)

    async def test_original_editor_snapshot_preserves_checkpoint_and_never_navigates(self):
        before = self.file.read_bytes()
        result = await self.review()
        self.assertTrue(result["originalEditor"])
        self.assertEqual(result["targetId"], self.page.target)
        self.assertEqual(base64.b64decode(result["imageDataUrl"].split(",")[1]), b"jpeg-fixture")
        self.assertEqual(self.file.read_bytes(), before)
        self.verify.assert_awaited_once_with(self.page, self.payload, self.state)
        self.page.goto.assert_not_awaited()
        self.page.set_viewport_size.assert_not_awaited()
        self.context.new_page.assert_not_awaited()
        self.connect.assert_not_awaited()
        self.page.mouse.click.assert_not_awaited()

    async def test_missing_or_changed_original_opens_dedicated_same_account_content(self):
        self.verify.side_effect = RuntimeError("changed document")
        result = await self.review()
        self.assertFalse(result["originalEditor"])
        self.assertEqual(result["targetId"], self.content.target)
        self.assertIn("原编辑页已关闭或身份已变化", result["message"])
        self.content.goto.assert_awaited_once_with(review_session.CONTENT_URL, wait_until="domcontentloaded", timeout=30000)
        self.page.goto.assert_not_awaited()
        self.assertEqual(json.loads(self.file.read_text()), self.state)
        await self.review(view="content")
        self.assertEqual(self.context.new_page.await_count, 1)

    async def test_explicit_content_view_never_navigates_retained_original(self):
        result = await self.review(view="content")
        self.assertFalse(result["originalEditor"])
        self.verify.assert_not_awaited()
        self.page.goto.assert_not_awaited()

    async def test_changed_account_or_payload_is_rejected_before_connection(self):
        self.payload["accountName"] = "other_account"
        with self.assertRaisesRegex(RuntimeError, "原上传任务不匹配"):
            await self.review()
        self.existing.assert_not_awaited()
        self.connect.assert_not_awaited()

    async def test_input_is_strictly_bound_to_open_review_target(self):
        await self.review()
        self.existing.reset_mock()
        with self.assertRaisesRegex(RuntimeError, "核对窗口已变化"):
            await self.review(input={"targetId": self.other.target, "action": "click", "x": 30, "y": 40})
        self.existing.assert_not_awaited()
        self.other.mouse.click.assert_not_awaited()

    async def test_explicit_click_drag_and_text_operate_only_original_tab(self):
        await self.review()
        await self.review(input={"targetId": self.page.target, "action": "click", "x": 20, "y": 30})
        self.page.mouse.click.assert_awaited_once_with(20, 30)
        await self.review(input={"targetId": self.page.target, "action": "drag", "x": 30, "y": 40, "toX": 90, "toY": 40})
        self.page.mouse.down.assert_awaited_once()
        self.page.mouse.up.assert_awaited_once()
        self.assertEqual(self.page.mouse.move.await_args_list[-1].kwargs, {"steps": 18})
        await self.review(input={"targetId": self.page.target, "action": "type", "text": "核对文字"})
        self.page.keyboard.insert_text.assert_awaited_once_with("核对文字")
        self.page.goto.assert_not_awaited()
        self.other.mouse.click.assert_not_awaited()

    async def test_refresh_captures_without_reload_and_invalid_keys_are_rejected(self):
        await self.review()
        await self.review(input={"targetId": self.page.target, "action": "refresh"})
        self.page.goto.assert_not_awaited()
        self.page.mouse.click.assert_not_awaited()
        self.existing.reset_mock()
        for command in ({"action": "key", "key": "Control+R"}, {"action": "script", "text": "alert(1)"},
                        {"action": "click", "x": float("nan"), "y": 1}, {"action": "type", "text": ""}):
            with self.subTest(command=command), self.assertRaises(ValueError):
                await self.review(input={"targetId": self.page.target, **command})
        self.existing.assert_not_awaited()

    async def test_account_operation_lock_prevents_review(self):
        with upload_locks(self.request["config"], [account_lock_key("baijiahao", self.payload["accountName"])]):
            with self.assertRaises(UploadLockBusy):
                await self.review()
        self.existing.assert_not_awaited()

    async def test_review_with_missing_checkpoint_is_a_content_view_not_replacement_editor(self):
        self.file.unlink()
        result = await self.review()
        self.assertFalse(result["originalEditor"])
        self.connect.assert_awaited_once()
        self.assertFalse(self.file.exists())
        self.content.goto.assert_awaited_once()

    async def test_external_page_and_out_of_viewport_input_are_rejected(self):
        await self.review()
        with self.assertRaisesRegex(ValueError, "超出核对窗口"):
            await self.review(input={"targetId": self.page.target, "action": "click", "x": 1500, "y": 20})
        self.page.mouse.click.assert_not_awaited()
        self.page.url = "https://example.com/"
        with self.assertRaisesRegex(RuntimeError, "离开百家号"):
            await self.review(input={"targetId": self.page.target, "action": "refresh"})

    async def test_failed_content_navigation_closes_only_its_new_page(self):
        self.content.goto.side_effect = RuntimeError("temporary network failure")
        with self.assertRaisesRegex(RuntimeError, "network failure"):
            await self.review(view="content")
        self.content.close.assert_awaited_once_with(run_before_unload=False)
        self.page.close.assert_not_awaited()


class ReviewBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_snapshot_and_input_preserve_bound_document(self):
        from playwright.async_api import async_playwright
        with tempfile.TemporaryDirectory() as temporary:
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    context = await browser.new_context(viewport={"width": 800, "height": 600})
                    await context.route("https://baijiahao.baidu.com/**", lambda route: route.fulfill(body='''
                        <html><body style="background:#eee;color:#111;font-size:20px;padding:30px">
                        <h1>Original task</h1><input id="value" value="original" style="width:300px;height:40px">
                        <script>window.name='huobao-sau-science-browser';window.__huobaoSauDocumentToken='bound';</script>
                        </body></html>'''))
                    page = await context.new_page()
                    await page.goto(bridge.EDITORS["baijiahao-video"])
                    payload = {"jobId": "science-browser", "target": "baijiahao-video", "accountName": "science_account"}
                    request = {"config": {"stateRoot": temporary}, "payload": payload}
                    file = bridge.job_state_file(request)
                    file.parent.mkdir(parents=True)
                    state = {"payloadDigest": bridge.payload_digest(payload), "accountCredentialDigest": "a" * 64,
                             "targetId": await bridge.page_id(page), "documentToken": "bound", "phase": "uploading"}
                    bridge.write_state(file, state)
                    before = file.read_bytes()

                    @asynccontextmanager
                    async def attached():
                        yield object()

                    with patch.object(review_session, "connect_existing_account_browser", AsyncMock(return_value=browser)), \
                         patch.object(bridge, "load_engine", return_value=(None, None, attached, None, None, None)):
                        result = await review_session.review_session(request, bridge)
                        pixels = base64.b64decode(result["imageDataUrl"].split(",")[1])
                        self.assertTrue(pixels.startswith(b"\xff\xd8\xff"))
                        self.assertGreater(len(pixels), 4000)
                        self.assertEqual((result["width"], result["height"]), (800, 600))
                        bounds = await page.locator("#value").bounding_box()
                        await review_session.review_session({**request, "input": {"targetId": state["targetId"], "action": "click",
                            "x": bounds["x"] + 20, "y": bounds["y"] + 20}}, bridge)
                        await review_session.review_session({**request, "input": {"targetId": state["targetId"], "action": "key", "key": "ControlOrMeta+A"}}, bridge)
                        await review_session.review_session({**request, "input": {"targetId": state["targetId"], "action": "type", "text": "reviewed"}}, bridge)
                        self.assertEqual(await page.locator("#value").input_value(), "reviewed")
                        self.assertEqual(file.read_bytes(), before)
                        self.assertEqual(await page.evaluate("window.__huobaoSauDocumentToken"), "bound")
                finally:
                    await browser.close()


if __name__ == "__main__":
    unittest.main()
