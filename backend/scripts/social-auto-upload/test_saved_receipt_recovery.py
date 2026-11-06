"""Draft completion needs platform identity, including legacy toast-only saves."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bridge


class SavedReceiptRecoveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.payload = {"jobId": "original", "target": "baijiahao-video", "fingerprint": "original"}
        self.request = {"payload": self.payload, "config": {"stateRoot": str(self.root)}}
        self.file = self.root / "jobs/original/state.json"
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.receipt = {"staged": True, "saved": True, "published": False, "targetId": "ABC123", "engine": "test",
                        "editorUrl": bridge.EDITORS["baijiahao-video"]}
        self.state = {"phase": "saved", "payloadDigest": bridge.payload_digest(self.payload), "files": {},
                      "result": self.receipt, "saveAttemptedAt": 123, "saveClickedAt": 124}

    def store(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        bridge.write_state(self.file, self.state)

    async def test_old_saved_toast_without_draft_identity_recommends_read_only_reconciliation(self):
        self.store()
        before = self.file.read_bytes()
        checkpoint = bridge.inspect_checkpoint(self.request)
        self.assertEqual(checkpoint["action"], "reconcile")
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(checkpoint["result"], self.receipt)

    async def test_legacy_saved_receipt_reconciliation_reaches_proof_without_saving_again(self):
        self.store()
        saved = {**self.receipt, "draftUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123"}
        playwright = MagicMock()
        playwright.return_value.__aenter__ = AsyncMock(return_value=object())
        playwright.return_value.__aexit__ = AsyncMock(return_value=False)
        proof = AsyncMock(return_value=saved)
        with patch.object(bridge, "load_engine", return_value=(None, None, playwright, None, None, None)), \
                patch.object(bridge, "connect_upload_browser", new=AsyncMock(return_value=(object(), "endpoint", None))), \
                patch.object(bridge, "reconcile_saved_draft", new=proof), \
                patch.object(bridge, "save_draft", new=AsyncMock(side_effect=AssertionError("must not save"))), \
                patch.object(bridge, "local_files", side_effect=AssertionError("must not start new upload")):
            result = await bridge.upload(self.request, "reconcile")
        self.assertEqual(result, saved)
        proof.assert_awaited_once()
        self.assertEqual(proof.call_args.args[2]["phase"], "save_requested")
        self.assertEqual(proof.call_args.args[2]["saveAttemptedAt"], 123)
        self.assertFalse(proof.call_args.kwargs["repair_rejected_save"])

    async def test_success_toast_does_not_complete_video_without_draft_proof(self):
        for target in ("baijiahao-video", "tencent-video"):
            with self.subTest(target=target):
                payload = {**self.payload, "target": target}
                state = {"phase": "staged", "files": {}, "result": {**self.receipt, "saved": False}}
                page = MagicMock()
                page.url = bridge.EDITORS[target]
                page.locator.return_value.all_text_contents = AsyncMock(side_effect=[[], ["保存草稿成功"]])
                page.locator.return_value.filter.return_value.count = AsyncMock(return_value=0)
                button = SimpleNamespace(click=AsyncMock())
                proof = AsyncMock(side_effect=RuntimeError("platform proof unavailable"))
                with patch.object(bridge, "local_files", return_value={}), \
                        patch.object(bridge, "verify_staged", new=AsyncMock()), \
                        patch.object(bridge, "one_button", new=AsyncMock(return_value=button)), \
                        patch.object(bridge, "reconcile_saved_draft", new=proof):
                    with self.assertRaisesRegex(RuntimeError, "platform proof unavailable"):
                        await bridge.save_draft(page, payload, state, self.file, ())
                self.assertEqual(state["phase"], "save_requested")
                self.assertFalse(state["result"]["saved"])
                self.assertEqual(state["saveNotice"], "保存草稿成功")
                self.assertTrue(json.loads(self.file.read_text())["saveAttemptedAt"])
                button.click.assert_awaited_once()
                proof.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
