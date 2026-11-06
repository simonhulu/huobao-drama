"""Saved records retain platform identity and the current media proof contract."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from contextlib import asynccontextmanager
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


spec = importlib.util.spec_from_file_location("saved_status_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class SavedVideoStatusTest(unittest.IsolatedAsyncioTestCase):
    async def check_record(self, platform, *, matching=True):
        attempted = bridge.datetime(2026, 10, 23, 15, 0, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        payload = {"jobId": "14", "target": platform, "title": "已保存的短标题", "description": "原任务作品描述",
                   "videoPath": "/no-longer-local/video.mp4", "landscapePath": "/no-longer-local/landscape.png",
                   "portraitPath": "/no-longer-local/portrait.png"}
        state = {"phase": "save_requested", "saveAttemptedAt": attempted, "saveClickedAt": attempted,
                 "files": {payload["videoPath"]: "original-sha"}, "details": {"metadata": {"description": payload["description"]}},
                 "result": {"staged": True, "saved": False, "published": False, "targetId": "ABCD",
                            "editorUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2"}}
        if platform == "baijiahao-video":
            # The current Baijiahao recovery requires original-media proof.
            # Detailed changed/missing-video cases live in test_baijiahao_saved_video.
            assets = tempfile.TemporaryDirectory()
            self.addCleanup(assets.cleanup)
            for key in ("videoPath", "landscapePath", "portraitPath"):
                asset = Path(assets.name).resolve() / Path(payload[key]).name
                asset.write_bytes(b"original-" + key.encode())
                payload[key] = str(asset)
            state["files"] = bridge.local_files(payload)
            state["details"]["media"] = {"status": "uploaded", "verification": "blob_sha256",
                                          "video_fingerprint": state["files"][payload["videoPath"]]}
        title = payload["description"] if matching else "别的任务"
        bai_rows = [{"title": title, "draft": True, "video": True, "time": "2026-10-23 15:00:01",
                     "url": "https://baijiahao.baidu.com/builder/preview/s?id=123456"}]
        tencent_rows = [{"title": title, "time": "2026年10月23日 15:00"}]
        listing, editor = MagicMock(), MagicMock()
        for page in (listing, editor):
            page.goto = AsyncMock()
            page.wait_for_url = AsyncMock()
            page.screenshot = AsyncMock()
            page.close = AsyncMock()
            page.is_closed.return_value = False
            locator = MagicMock()
            locator.first = locator
            locator.nth.return_value = locator
            locator.filter.return_value = locator
            locator.locator.return_value = locator
            locator.count = AsyncMock(return_value=1)
            locator.wait_for = AsyncMock()
            locator.hover = AsyncMock()
            locator.click = AsyncMock()
            locator.evaluate_all = AsyncMock(return_value=tencent_rows)
            page.locator.return_value = locator
        editor.url = "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123456"
        editor.evaluate = AsyncMock(return_value={"fields": [{"kind": "description", "value": payload["description"]}],
            "videos": [{"src": "https://media.example.test/saved.mp4", "ready": 1, "duration": 120.0}]})

        @asynccontextmanager
        async def popup(**kwargs):
            async def opened():
                return editor
            yield SimpleNamespace(value=opened())

        listing.expect_popup = popup
        async def locate_bai(page, **kwargs):
            candidate = kwargs["match"](bai_rows, kwargs["title"], kwargs["attempted_at"],
                                        target=kwargs["target"], expected_id=kwargs["expected_id"])
            return candidate, page.locator("row"), {"outcome": "found"}

        async def locate_tencent(page, **kwargs):
            if not matching:
                raise RuntimeError("没有找到本任务文案")
            candidate = kwargs["match"](tencent_rows, kwargs["description"], kwargs["attempted_at"],
                                        expected_id=kwargs["expected_id"])
            return candidate, page.locator("row"), {"outcome": "found"}

        browser = SimpleNamespace(contexts=[SimpleNamespace(new_page=AsyncMock(return_value=listing))])
        helpers = SimpleNamespace(_verify_metadata=AsyncMock())
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(bridge, "locate_baijiahao_draft", new=locate_bai), \
                patch.object(bridge, "locate_tencent_draft", new=locate_tencent), \
                patch.object(bridge, "verify_tencent_metadata", new=AsyncMock()), \
                patch.object(bridge, "local_files", wraps=bridge.local_files) as local_files, \
                patch.object(bridge, "local_video_duration", return_value=120.0), \
                patch.object(bridge.subprocess, "run", side_effect=AssertionError("No media transcoding or audio analysis")), \
                patch.object(bridge, "one_button", side_effect=AssertionError("Do not save or publish again")):
            file = Path(directory) / "state.json"
            if not matching:
                with self.assertRaisesRegex(RuntimeError, "没有找到本任务文案" if platform == "tencent-video" else "未找到唯一"):
                    await bridge.reconcile_saved_draft(browser, payload, state, file, (None, None, None, helpers))
                self.assertFalse(state["result"]["saved"])
                return
            result = await bridge.reconcile_saved_draft(browser, payload, state, file, (None, None, None, helpers))
            self.assertTrue(result["saved"])
            self.assertFalse(result["published"])
            self.assertEqual(result["targetId"], "ABCD")
            self.assertEqual(state["phase"], "saved")
            self.assertEqual(state["saveClickedAt"], attempted, "no second save")
            if platform == "baijiahao-video":
                local_files.assert_called_once_with(payload)
                self.assertEqual(state["saveEvidence"]["verification"], "platform_draft_record_metadata_video")
                self.assertEqual(state["saveEvidence"]["videoSha256"], state["files"][payload["videoPath"]])
            else:
                local_files.assert_not_called()
                self.assertEqual(state["saveEvidence"]["verification"], "platform_draft_record")
            self.assertTrue(file.exists(), "proof is durable before returning")

    async def test_baijiahao_saved_draft_retains_original_media_proof_without_saving_again(self):
        await self.check_record("baijiahao-video")

    async def test_tencent_saved_draft_succeeds_without_media_quality_checks(self):
        await self.check_record("tencent-video")

    async def test_baijiahao_different_project_is_not_marked_saved(self):
        await self.check_record("baijiahao-video", matching=False)

    async def test_tencent_different_project_is_not_marked_saved(self):
        await self.check_record("tencent-video", matching=False)


if __name__ == "__main__":
    unittest.main()
