"""Saved-tab cleanup: durable receipt, exact target/owner, then best-effort close.

Plan: lock down task ownership and failure preservation before wiring cleanup
into save/reconcile/recovery. All browser objects are fakes; no live accounts.
"""
import asyncio
import copy
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bridge


class SavedTabCleanupTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.file = self.root / "jobs/68/state.json"
        self.file.parent.mkdir(parents=True)
        self.payload = {"jobId": "68", "target": "tencent-video", "title": "原稿标题", "description": "原稿简介"}
        self.configure()
        self.identity = patch.object(bridge, "page_id", AsyncMock(side_effect=lambda page: page.target_id))
        self.identity.start()
        self.addCleanup(self.identity.stop)
        self.idle = patch("account_browser.close_idle_account_browser", new=AsyncMock(return_value=False), create=True)
        self.close_idle = self.idle.start()
        self.addCleanup(self.idle.stop)

    def configure(self, target="tencent-video"):
        self.payload["target"] = target
        draft_url = ("https://channels.weixin.qq.com/platform/post/draftListManager" if target == "tencent-video"
                     else "https://baijiahao.baidu.com/builder/rc/edit?type=" +
                     ("news" if target == "baijiahao-article" else "videoV2") + "&article_id=123")
        self.state = {"phase": "saved", "targetId": "ABC123", "documentToken": "task-document",
                      "payloadDigest": bridge.payload_digest(self.payload), "files": {}, "saveAttemptedAt": 100,
                      "expectedDraftId": "123", "details": {},
                      "result": {"staged": True, "saved": True, "published": False, "targetId": "ABC123",
                                 "engine": "test", "editorUrl": bridge.EDITORS[target], "draftUrl": draft_url}}
        self.store()
        self.original = self.page("ABC123", bridge.EDITORS[target], "huobao-sau-68", "task-document")
        self.manual = self.page("DEF456", bridge.EDITORS[target], "", None)
        self.context = SimpleNamespace(pages=[self.manual, self.original], close=AsyncMock())
        self.browser = SimpleNamespace(contexts=[self.context], close=AsyncMock())
        for page in self.context.pages:
            page.context = self.context
        self.context.browser = self.browser

    def store(self):
        bridge.write_state(self.file, self.state)

    def page(self, target, url, name="", token=None):
        page = MagicMock()
        page.target_id, page.url = target, url
        page.is_closed.return_value = False
        page.binding = {"name": name, "token": token, "href": url}
        page.evaluate = AsyncMock(side_effect=lambda *args: dict(page.binding))
        page.screenshot = AsyncMock()
        async def close(**kwargs):
            page.is_closed.return_value = True
        page.close = AsyncMock(side_effect=close)
        return page

    async def cleanup(self):
        return await bridge.cleanup_saved_upload_tab(self.browser, self.payload, self.state, self.file)

    async def test_only_confirmed_task_editor_closes_for_each_target(self):
        for target in bridge.EDITORS:
            with self.subTest(target=target):
                self.configure(target)
                before = self.file.read_bytes()
                result = await self.cleanup()
                self.assertTrue(result["closed"])
                self.original.close.assert_awaited_once_with(run_before_unload=False)
                self.manual.close.assert_not_awaited()
                self.browser.close.assert_not_awaited()
                self.context.close.assert_not_awaited()
                self.assertEqual(self.file.read_bytes(), before)
                self.close_idle.assert_awaited_with(self.browser)

    async def test_unsaved_uncertain_and_non_durable_states_keep_all_pages(self):
        original = copy.deepcopy(self.state)
        variants = [{"phase": phase} for phase in ("opening", "uploading", "staged", "save_requested")]
        variants += [{"result": {**original["result"], "saved": False}},
                     {"result": {**original["result"], "published": True}},
                     {"result": {**original["result"], "draftUrl": ""}},
                     {"documentToken": ""}, {"payloadDigest": "different"}]
        for changes in variants:
            with self.subTest(changes=changes):
                self.state = {**original, **changes}
                self.store()
                self.assertFalse((await self.cleanup())["closed"])
        self.state = original
        self.store()
        durable = {**original, "phase": "save_requested"}
        bridge.write_state(self.file, durable)
        self.assertFalse((await self.cleanup())["closed"])
        self.file.unlink()
        self.assertFalse((await self.cleanup())["closed"])
        self.original.close.assert_not_awaited()
        self.manual.close.assert_not_awaited()
        self.close_idle.assert_not_awaited()

    async def test_manual_replaced_or_unrelated_documents_are_kept(self):
        for changes in ({"name": "manual"}, {"token": "different"}, {"token": None},
                        {"href": "https://example.com/"},
                        {"href": "https://channels.weixin.qq.com/platform/account"}):
            with self.subTest(changes=changes):
                self.configure()
                self.original.binding.update(changes)
                self.original.url = self.original.binding["href"]
                self.assertFalse((await self.cleanup())["closed"])
                self.original.close.assert_not_awaited()
        self.configure("baijiahao-video")
        self.original.binding["href"] = self.original.url = self.state["result"]["draftUrl"].replace("123", "999")
        self.assertFalse((await self.cleanup())["closed"])
        self.original.close.assert_not_awaited()

    async def test_save_navigation_keeps_target_ownership_without_old_document_token(self):
        for target, landing in (("tencent-video", "https://channels.weixin.qq.com/platform/post/draftListManager"),
                                ("baijiahao-video", "https://baijiahao.baidu.com/builder/rc/content")):
            with self.subTest(target=target):
                self.configure(target)
                self.original.binding.update(token=None, href=landing)
                self.original.url = landing
                self.assertTrue((await self.cleanup())["closed"])
                self.original.close.assert_awaited_once()

    async def test_close_errors_do_not_change_saved_receipt_and_can_be_retried(self):
        self.original.close.side_effect = RuntimeError("CDP connection closed")
        before = self.file.read_bytes()
        self.assertFalse((await self.cleanup())["closed"])
        self.assertEqual(self.file.read_bytes(), before)
        self.original.close.side_effect = None
        self.assertTrue((await self.cleanup())["closed"])
        self.assertEqual(self.file.read_bytes(), before)

    async def test_checkpoint_change_during_ownership_check_preserves_page(self):
        async def changed(*args):
            bridge.write_state(self.file, {**self.state, "phase": "staged"})
            return self.original.binding
        self.original.evaluate.side_effect = changed
        self.assertFalse((await self.cleanup())["closed"])
        self.original.close.assert_not_awaited()

    async def test_already_closed_page_is_idempotent_and_idle_check_is_allowed(self):
        self.original.is_closed.return_value = True
        self.assertFalse((await self.cleanup())["closed"])
        self.original.close.assert_not_awaited()
        self.close_idle.assert_awaited_once_with(self.browser)

    async def test_hung_target_close_is_bounded_and_preserves_saved_result(self):
        async def hung_close(**kwargs):
            await asyncio.Future()
        wait_for = asyncio.wait_for
        async def short_wait(task, timeout):
            return await wait_for(task, timeout=0.01 if timeout == 8 else timeout)
        self.original.close.side_effect = hung_close
        with patch.object(bridge.asyncio, "wait_for", side_effect=short_wait):
            result = await self.cleanup()
        self.assertFalse(result["closed"])
        self.assertEqual(result["reason"], "cleanup_failed")
        self.assertTrue(json.loads(self.file.read_text())["result"]["saved"])

    async def test_unrelated_target_with_identical_owner_is_not_closed(self):
        self.manual.binding = dict(self.original.binding)
        self.assertTrue((await self.cleanup())["closed"])
        self.manual.close.assert_not_awaited()

    async def test_unrelated_closed_target_inspection_does_not_block_original_cleanup(self):
        async def identity(page):
            if page is self.manual:
                raise RuntimeError("Target closed")
            return page.target_id
        with patch.object(bridge, "page_id", AsyncMock(side_effect=identity)):
            self.assertTrue((await self.cleanup())["closed"])
        self.original.close.assert_awaited_once()

    async def test_already_saved_save_call_cleans_without_saving_again(self):
        result = await bridge.save_draft(self.original, self.payload, self.state, self.file, ())
        self.assertEqual(result, self.state["result"])
        self.original.close.assert_awaited_once()
        self.original.locator.assert_not_called()

    async def test_completed_recovery_option_uses_existing_browser_without_connecting(self):
        request = {"config": {"stateRoot": str(self.root)}, "payload": self.payload}
        with patch.object(bridge, "load_engine", side_effect=AssertionError("must not connect")), \
                patch.object(bridge, "local_files", side_effect=AssertionError("must not upload")):
            for action in ("save", "reconcile", "stage"):
                self.assertEqual(await bridge.upload(request, action), self.state["result"])
            self.original.close.assert_not_awaited()
            self.assertEqual(await bridge.upload(request, "save", cleanup_browser=self.browser), self.state["result"])
        self.original.close.assert_awaited_once()

    def reconciliation(self, target, *, failure=None, disposable_close_error=False):
        """Mock platform IO, preserving the actual save/checkpoint/finally path."""
        self.configure(target)
        self.state.update(phase="save_requested", saveAttemptedAt=100)
        self.state["result"]["saved"] = False
        self.store()
        listing = self.page("FFF111", self.state["result"]["draftUrl"])
        self.context.pages.append(listing)
        self.context.new_page = AsyncMock(return_value=listing)
        row = MagicMock()
        row.hover = AsyncMock()
        edit = row.locator.return_value.filter.return_value
        edit.count = AsyncMock(return_value=1)
        edit.click, edit.wait_for, row.wait_for = AsyncMock(), AsyncMock(), AsyncMock()
        listing.locator.return_value.wait_for = AsyncMock()
        candidate = {"id": "123", "time": "2026-10-26 09:30"}
        find = AsyncMock(return_value=(candidate, row, {"outcome": "found"}), side_effect=failure)
        stack = ExitStack()
        stack.enter_context(patch.object(bridge, "local_files", return_value={}))
        if target == "tencent-video":
            stack.enter_context(patch.object(bridge, "locate_tencent_draft", find))
            stack.enter_context(patch.object(bridge, "verify_tencent_metadata", AsyncMock()))
            stack.enter_context(patch.object(bridge, "tencent_save_flags", AsyncMock(return_value={"draftObjectId": "123"})))
            verification = listing
        else:
            verification = self.page("FFF222", self.state["result"]["draftUrl"])
            self.context.pages.append(verification)
            verification.wait_for_url = AsyncMock()
            async def popup_value():
                return verification
            class Popup:
                @property
                def value(self):
                    return popup_value()
                async def __aenter__(self):
                    return self
                async def __aexit__(self, *args):
                    return False
            listing.expect_popup.return_value = Popup()
            stack.enter_context(patch.object(bridge, "locate_baijiahao_draft", find))
            stack.enter_context(patch.object(bridge, "verify_saved_video", AsyncMock(return_value={"verified": True})))
            stack.enter_context(patch.object(bridge, "verify_saved_article", AsyncMock(return_value={"verified": True})))
        if disposable_close_error:
            listing.close.side_effect = RuntimeError("verification tab close failed")
        self.addCleanup(stack.close)
        return listing, verification

    async def test_reconcile_each_target_persists_success_then_closes_verification_and_original(self):
        for target in bridge.EDITORS:
            with self.subTest(target=target):
                listing, verification = self.reconciliation(target)
                async def assert_durable_close(**kwargs):
                    persisted = json.loads(self.file.read_text())
                    self.assertEqual(persisted["phase"], "saved")
                    self.assertTrue(persisted["result"]["saved"])
                    listing.close.assert_awaited()
                    verification.close.assert_awaited()
                    self.original.is_closed.return_value = True
                self.original.close.side_effect = assert_durable_close
                result = await bridge.reconcile_saved_draft(self.browser, self.payload, self.state, self.file,
                                                             (None, None, None, object()))
                self.assertTrue(result["saved"])
                self.original.close.assert_awaited_once()
                self.manual.close.assert_not_awaited()

    async def test_failed_reconciliation_keeps_original_and_disposal_error_does_not_mask_failure(self):
        for target in ("tencent-video", "baijiahao-video"):
            with self.subTest(target=target):
                listing, _ = self.reconciliation(target, failure=RuntimeError("draft not verified"),
                                                  disposable_close_error=True)
                with self.assertRaisesRegex(RuntimeError, "draft not verified"):
                    await bridge.reconcile_saved_draft(self.browser, self.payload, self.state, self.file,
                                                       (None, None, None, object()))
                self.original.close.assert_not_awaited()
                listing.close.assert_awaited_once()
                self.assertFalse(json.loads(self.file.read_text())["result"]["saved"])
        self.close_idle.assert_not_awaited()

    async def test_disposal_and_idle_shutdown_errors_do_not_erase_confirmed_save(self):
        for target in ("tencent-video", "baijiahao-video"):
            with self.subTest(target=target):
                self.reconciliation(target, disposable_close_error=True)
                self.close_idle.side_effect = RuntimeError("browser retirement unavailable")
                result = await bridge.reconcile_saved_draft(self.browser, self.payload, self.state, self.file,
                                                             (None, None, None, object()))
                self.assertTrue(result["saved"])
                self.original.close.assert_awaited_once()
                self.assertEqual(json.loads(self.file.read_text())["result"], result)

    async def test_save_reaches_cleanup_after_exactly_one_save_and_draft_readback(self):
        self.reconciliation("tencent-video")
        self.state["phase"] = "staged"
        self.state.pop("saveAttemptedAt")
        self.store()
        self.original.locator.return_value.all_text_contents = AsyncMock(return_value=[])
        self.original.locator.return_value.filter.return_value.count = AsyncMock(return_value=0)
        button = SimpleNamespace(click=AsyncMock())
        with patch.object(bridge, "verify_staged", AsyncMock()), \
                patch.object(bridge, "one_button", AsyncMock(return_value=button)):
            result = await bridge.save_draft(self.original, self.payload, self.state, self.file,
                                             (None, None, None, object()))
        self.assertTrue(result["saved"])
        button.click.assert_awaited_once()
        self.original.close.assert_awaited_once()

    async def test_cover_revision_already_saved_cleans_its_own_target(self):
        self.configure("baijiahao-article")
        revision_directory = self.file.parent / "cover-three-v1"
        revision_directory.mkdir()
        revision = {**self.state, "details": {}}
        revision["draftUrl"] = self.state["result"]["draftUrl"]
        bridge.write_state(revision_directory / "state.json", revision)
        with patch.object(bridge, "local_files", return_value={}):
            result = await bridge.update_saved_article_covers(self.browser, self.payload, self.state, self.file, ())
        self.assertTrue(result["saved"])
        self.original.close.assert_awaited_once()

    async def test_resume_keeps_staged_page_then_subsequent_save_cleans_same_target(self):
        self.reconciliation("tencent-video")
        self.state.update(phase="uploading", protocolVersion=2, fileSelectionStartedAt=10)
        self.state.pop("saveAttemptedAt")
        self.state.pop("result")
        self.store()
        self.original.bring_to_front = AsyncMock()
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=object())
        manager.__aexit__ = AsyncMock(return_value=False)
        engine = (None, None, lambda: manager, None, None, None)
        request = {"config": {"stateRoot": str(self.root)}, "payload": self.payload, "confirmSave": True}
        with patch.object(bridge, "load_engine", return_value=engine), \
                patch.object(bridge, "connect_upload_browser", AsyncMock(return_value=(self.browser, "endpoint", None))), \
                patch.object(bridge, "stage_tencent_video", AsyncMock(return_value={
                    "engine": "social-auto-upload/tencent-local-stage"})) as stage, \
                patch.object(bridge, "verify_document", AsyncMock()):
            staged = await bridge.upload(request, "resume")
            self.assertFalse(staged["saved"])
            self.original.close.assert_not_awaited()
            stage.assert_awaited_once()
            self.assertIs(stage.call_args.args[0], self.original)
            self.assertTrue(stage.call_args.args[5], "resume must reuse the existing upload")
            self.original.locator.return_value.all_text_contents = AsyncMock(return_value=[])
            self.original.locator.return_value.filter.return_value.count = AsyncMock(return_value=0)
            button = SimpleNamespace(click=AsyncMock())
            with patch.object(bridge, "verify_staged", AsyncMock()), \
                    patch.object(bridge, "one_button", AsyncMock(return_value=button)):
                saved = await bridge.upload(request, "save")
            self.assertTrue(saved["saved"])
            button.click.assert_awaited_once()
            stage.assert_awaited_once()
            self.original.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
