"""Resume an original video when the first metadata click was blocked by a tour."""
import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from playwright.async_api import async_playwright

import bridge


class BaijiahaoMetadataRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.payload = {"jobId": "metadata-tour", "target": "baijiahao-video", "publicationMode": "publish",
                        "title": "水豚冷知识", "description": "水豚冷知识 #科普#"}
        for key, name in (("videoPath", "original.mp4"), ("landscapePath", "landscape.png"),
                          ("portraitPath", "portrait.png")):
            file = root / name
            file.write_bytes(key.encode())
            self.payload[key] = str(file)
        self.request = {"config": {"stateRoot": str(root / "state")}, "payload": self.payload}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        playwright = await async_playwright().start()
        self.addAsyncCleanup(playwright.stop)
        self.browser = await playwright.chromium.launch(channel="chrome", headless=True)
        async def close_browser():
            close = asyncio.create_task(self.browser.close())
            try:
                await asyncio.wait_for(asyncio.shield(close), timeout=3)
            except TimeoutError:
                await playwright.stop()
                await asyncio.gather(close, return_exceptions=True)
        self.addAsyncCleanup(close_browser)
        self.page = await self.browser.new_page()
        await self.page.route("https://baijiahao.baidu.com/**", lambda route: route.fulfill(body="<main></main>"))
        await self.page.goto(bridge.EDITORS["baijiahao-video"])
        await self.page.set_content('''<div class="videov2-title-wrap">
          <div class="contentEditable" contenteditable="true" data-lexical-editor="true"
               style="width:500px;min-height:60px">original</div><span class="x-count">8/100</span></div>
          <input type="file" onchange="actions.uploads++"><button onclick="actions.publishes++">发布</button>
          <div role="tooltip" class="cheetah-popover-inner" style="position:fixed;inset:0;z-index:1000;background:white">
            <span class="cheetah-popconfirm-message-icon"><span class="l-icon-BjhBasicGuanbi"
              style="display:inline-block;width:24px;height:24px" onclick="actions.closes++;this.closest('[role=tooltip]').remove()">X</span></span>
            <div>新增智能文案，上传视频，AI为您生成优质文案，快来试试吧！</div>
            <button style="display:none">我知道了</button>
          </div><script>window.actions={uploads:0,publishes:0,closes:0};
            window.name='huobao-sau-metadata-tour';window.__huobaoSauDocumentToken='original-document';</script>''')
        self.state = {"phase": "uploading", "protocolVersion": 3,
                      "payloadDigest": bridge.payload_digest(self.payload), "files": bridge.local_files(self.payload),
                      "targetId": await bridge.page_id(self.page), "documentToken": "original-document",
                      "fileSelectionStartedAt": 123,
                      "error": "Locator.click: Timeout 30000ms exceeded. cheetah-popover-inner intercepts pointer events"}
        real = bridge.load_engine()[3]
        self.helpers = SimpleNamespace(_READ_METADATA=real._READ_METADATA, _READ_MEDIA=real._READ_MEDIA,
            _metadata_fields=real._metadata_fields,
            fill_metadata=AsyncMock(wraps=real.fill_metadata),
            verify_upload=AsyncMock(return_value={"status": "uploaded", "verification": "blob_sha256",
                "media_src": "blob:original", "video_fingerprint": hashlib.sha256(b"videoPath").hexdigest()}))

    async def resume(self):
        bridge.write_state(self.file, self.state)
        covers = {"landscape": {}, "portrait": {}}
        with patch.object(bridge, "load_engine", return_value=(None, None, async_playwright, self.helpers, None, None)), \
             patch.object(bridge, "connect_upload_browser", new=AsyncMock(return_value=(self.browser, "fixture", None))), \
             patch.object(bridge, "resume_baijiahao_creation_dialog", new=AsyncMock()), \
             patch.object(bridge, "baijiahao_covers", new=AsyncMock(return_value=covers)), \
             patch.object(bridge, "verify_baijiahao_page_after_covers", new=AsyncMock(return_value=covers)), \
             patch.object(bridge, "ensure_baijiahao_fields", new=AsyncMock(return_value={})):
            return await bridge.upload(self.request, "resume")

    async def test_original_resume_completes_first_metadata_fill_without_reupload_or_publish(self):
        result = await self.resume()
        saved = json.loads(self.file.read_text())
        self.assertTrue(result["staged"])
        self.assertFalse(result["published"])
        self.assertEqual(result["targetId"], self.state["targetId"])
        self.assertEqual(saved["documentToken"], "original-document")
        self.assertEqual(saved["fileSelectionStartedAt"], 123)
        self.assertEqual(saved["details"]["metadata"]["description"]["value"], self.payload["description"])
        self.assertEqual(saved["metadataRecovery"]["previousDescription"], "original")
        self.assertEqual(saved["metadataRecovery"]["originalError"], self.state["error"])
        self.helpers.fill_metadata.assert_awaited_once()
        self.assertEqual(await self.page.evaluate("actions"), {"uploads": 0, "publishes": 0, "closes": 1})
        self.assertNotIn("publishAttemptedAt", saved)
        self.assertNotIn("saveAttemptedAt", saved)

    async def test_changed_copy_or_missing_failure_evidence_is_never_overwritten(self):
        for change in ("copy", "error", "selection", "protocol", "document", "publish", "save", "server-preview"):
            with self.subTest(change=change):
                original = dict(self.state)
                if change == "copy":
                    await self.page.locator('[contenteditable]').evaluate("e=>e.textContent='人工文案'")
                elif change == "error":
                    self.state["error"] = "Other click timeout"
                elif change == "selection":
                    self.state.pop("fileSelectionStartedAt")
                elif change == "protocol":
                    self.state["protocolVersion"] = 2
                elif change == "document":
                    self.state["documentToken"] = "different-document"
                elif change in ("publish", "save"):
                    self.state[change + "AttemptedAt"] = 123
                else:
                    self.helpers.verify_upload.return_value["verification"] = "ready_server_preview"
                with self.assertRaises(RuntimeError):
                    await self.resume()
                self.helpers.fill_metadata.assert_not_awaited()
                self.assertEqual(await self.page.evaluate("actions"), {"uploads": 0, "publishes": 0, "closes": 0})
                self.state = original
                await self.page.locator('[contenteditable]').evaluate("e=>e.textContent='original'")


if __name__ == "__main__":
    unittest.main()
