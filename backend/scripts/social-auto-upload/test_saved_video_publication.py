"""Saved video publication keeps its article ID and never selects a video again."""
from contextlib import ExitStack
from copy import deepcopy
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from playwright.async_api import async_playwright
import bridge


ARTICLE_ID = "1880972395803279815"


def fixture(directory):
    paths = {}
    for name in ("video.mp4", "old-landscape.jpg", "old-portrait.jpg", "new-landscape.jpg", "new-portrait.jpg"):
        file = Path(directory) / name
        file.write_bytes(name.encode())
        paths[name] = str(file)
    legacy = {"jobId": "nba-existing-video", "scriptId": 123, "target": "baijiahao-video",
              "accountName": "nba-account", "publicationMode": "draft", "title": "湖人战胜热火",
              "description": "湖人战胜热火", "fingerprint": "a" * 64,
              "videoPath": paths["video.mp4"], "landscapePath": paths["old-landscape.jpg"],
              "portraitPath": paths["old-portrait.jpg"]}
    payload = {**legacy, "publicationMode": "publish", "description": "湖人战胜热火 #NBA#",
               "tags": ["#NBA#"], "topicPolicy": "required-exact", "fingerprint": "b" * 64,
               "landscapePath": paths["new-landscape.jpg"], "portraitPath": paths["new-portrait.jpg"]}
    result = {"staged": True, "saved": True, "published": False, "accountName": legacy["accountName"],
              "editorUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2",
              "draftUrl": f"https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id={ARTICLE_ID}",
              "targetId": "ABC123", "engine": "fixture"}
    files = bridge.local_files(legacy)
    state = {"protocolVersion": 3, "phase": "saved", "payloadDigest": bridge.payload_digest(legacy),
             "files": files, "result": result, "targetId": "ABC123", "documentToken": "original-document",
             "accountCredentialDigest": "fixture", "saveAttemptedAt": time.time()-120, "saveClickedAt": time.time()-119,
             "expectedDraftId": ARTICLE_ID,
             "details": {"metadata": {"description": {"value": legacy["description"]}},
                         "media": {"status": "uploaded", "verification": "blob_sha256",
                                   "video_fingerprint": files[str(Path(legacy["videoPath"]).resolve())], "media_src": "blob:original"},
                         "covers": {"landscape": {}, "portrait": {}}}}
    return legacy, payload, state


class SavedPublicationBindingTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.legacy, self.payload, self.state = fixture(directory.name)

    def test_cover_and_topic_revision_retains_original_video_and_article_identity(self):
        before = deepcopy(self.state)
        revision = bridge.saved_publication_revision(self.payload, self.legacy, self.state)
        self.assertEqual(revision["articleId"], ARTICLE_ID)
        self.assertEqual(revision["legacyPayloadDigest"], bridge.payload_digest(self.legacy))
        self.assertEqual(revision["payloadDigest"], bridge.payload_digest(self.payload))
        video = str(Path(self.payload["videoPath"]).resolve())
        self.assertEqual(revision["files"][video], revision["legacyFiles"][video])
        self.assertEqual(self.state, before)

    def test_only_declared_metadata_and_covers_may_change(self):
        for key, value in (("videoPath", self.payload["landscapePath"]), ("title", "另一个标题"),
                           ("scriptId", 456), ("accountName", "other"), ("jobId", "replacement")):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, "原视频|身份"):
                bridge.saved_publication_revision({**self.payload, key: value}, self.legacy, self.state)

    def test_changed_original_files_or_another_revision_cannot_bypass_binding(self):
        changed = {**self.state, "files": {**self.state["files"], self.legacy["videoPath"]: "changed"}}
        with self.assertRaisesRegex(RuntimeError, "素材"):
            bridge.saved_publication_revision(self.payload, self.legacy, changed)
        revision = bridge.saved_publication_revision(self.payload, self.legacy, self.state)
        changed = {**self.state, "savedPublication": revision}
        with self.assertRaisesRegex(RuntimeError, "版本|身份"):
            bridge.saved_publication_revision({**self.payload, "fingerprint": "c" * 64}, self.legacy, changed)


class PlaywrightContext:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *_):
        return None


class SavedCoverReadbackTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        _, self.payload, _ = fixture(directory.name)
        self.sources = {kind: f"https://pic.rmb.bdstatic.com/bjh/261105/beautify/{kind}.jpeg"
                        for kind in ("landscape", "portrait")}
        self.slots = {kind: {"src": src} for kind, src in self.sources.items()}
        self.responses = {
            src: SimpleNamespace(status=200, url=src, headers={"content-type": "image/jpeg"},
                                 body=AsyncMock(return_value=Path(self.payload[kind + "Path"]).read_bytes()),
                                 dispose=AsyncMock()) for kind, src in self.sources.items()}
        self.get = AsyncMock(side_effect=lambda src, **_: self.responses[src])
        self.loaded_images = AsyncMock(return_value=True)
        self.page = SimpleNamespace(locator=lambda _: SimpleNamespace(evaluate_all=self.loaded_images),
                                    context=SimpleNamespace(request=SimpleNamespace(get=self.get)))
        self.helpers = SimpleNamespace(
            _cover_slots=AsyncMock(side_effect=lambda _: self.slots),
            _cover_pixels=AsyncMock(side_effect=RuntimeError("Page.evaluate: TypeError: Failed to fetch")),
            _normalized_pixels=base64.b64decode,
            _pixel_difference=lambda a, b: {"mae": 0 if a == b else 100, "rmse": 0 if a == b else 100})

    async def verify(self):
        await bridge.verify_saved_baijiahao_covers(self.page, self.payload, self.helpers)

    async def test_loaded_official_cdn_covers_use_read_only_request_after_cors_failure(self):
        await self.verify()
        self.assertEqual(self.helpers._cover_pixels.await_count, 2)
        self.assertEqual(self.loaded_images.await_count, 2)
        self.assertEqual(self.get.await_count, 2)
        for src, response in self.responses.items():
            self.get.assert_any_await(src, timeout=15000, max_redirects=0)
            response.dispose.assert_awaited_once()

    async def test_official_cdn_bare_jpeg_content_type_still_checks_pixels(self):
        for response in self.responses.values():
            response.headers["content-type"] = "jpeg"
        await self.verify()
        self.responses[self.sources["landscape"]].body.return_value = b"different pixels"
        with self.assertRaisesRegex(RuntimeError, "封面与本地封面不一致"):
            await self.verify()

    async def test_successful_page_read_and_non_fetch_failure_do_not_use_request_fallback(self):
        self.helpers._cover_pixels.side_effect = lambda _, src: Path(
            self.payload[next(kind for kind, value in self.sources.items() if value == src) + "Path"]).read_bytes()
        await self.verify()
        self.get.assert_not_awaited()
        self.helpers._cover_pixels.side_effect = RuntimeError("Cannot decode an 8-bit cover preview")
        with self.assertRaisesRegex(RuntimeError, "decode"):
            await self.verify()
        self.get.assert_not_awaited()

    async def test_unofficial_or_invalid_urls_never_receive_a_request(self):
        for src in ("https://example.test/cover.jpeg", "https://pic.rmb.bdstatic.com.example.test/bjh/cover.jpeg",
                    "http://pic.rmb.bdstatic.com/bjh/cover.jpeg", "https://user@pic.rmb.bdstatic.com/bjh/cover.jpeg",
                    "https://pic.rmb.bdstatic.com:444/bjh/cover.jpeg", "https://pic.rmb.bdstatic.com:invalid/bjh/cover.jpeg",
                    "https://pic.rmb.bdstatic.com/other/cover.jpeg", "https://pic.rmb.bdstatic.com/bjh/cover.jpeg#fragment",
                    "https://pic.rmb.bdstatic.com/bjh/cover.jpeg\n"):
            with self.subTest(src=src), self.assertRaises(RuntimeError):
                self.slots["landscape"]["src"] = src
                await self.verify()
        self.get.assert_not_awaited()

    async def test_unloaded_image_is_not_fetched(self):
        self.loaded_images.return_value = False
        with self.assertRaisesRegex(RuntimeError, "加载"):
            await self.verify()
        self.get.assert_not_awaited()

    async def test_response_must_be_an_image_from_the_same_cdn_url(self):
        response = self.responses[self.sources["landscape"]]
        for changes in ({"status": 302}, {"url": "https://example.test/cover.jpeg"},
                        {"headers": {"content-type": "text/html"}},
                        {"headers": {"content-type": "application/json"}}):
            with self.subTest(changes=changes):
                before = {key: getattr(response, key) for key in changes}
                for key, value in changes.items():
                    setattr(response, key, value)
                with self.assertRaises(RuntimeError):
                    await self.verify()
                for key, value in before.items():
                    setattr(response, key, value)
        response.body.assert_not_awaited()
        self.assertEqual(response.dispose.await_count, 4)

    async def test_request_fallback_still_rejects_different_pixels(self):
        self.responses[self.sources["landscape"]].body.return_value = b"different pixels"
        with self.assertRaisesRegex(RuntimeError, "封面与本地封面不一致"):
            await self.verify()


class SavedCoverSlotRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.legacy, self.payload, self.state = fixture(directory.name)
        self.revision = bridge.saved_publication_revision(self.payload, self.legacy, self.state)
        digest = hashlib.sha256(Path(self.payload["landscapePath"]).read_bytes()).hexdigest()
        self.proof = {"preview": "new-landscape.jpg", "verification": "source_and_preview",
                      "fingerprint": digest, "source_sha256_verified": digest}
        self.revision["covers"] = {"landscape": self.proof}
        self.slots = {"landscape": {"src": "new-landscape.jpg"}, "portrait": {"src": "old-portrait.jpg"}}
        self.helpers = SimpleNamespace(
            _cover_slots=AsyncMock(side_effect=lambda _: self.slots),
            _cover_pixels=AsyncMock(side_effect=lambda _, src: src.encode()),
            _normalized_pixels=lambda value: bridge.base64.b64decode(value),
            _pixel_difference=lambda a, b: {"mae": 0 if a == b else 100, "rmse": 0 if a == b else 100})

    async def test_mixed_old_and_new_slots_only_reuse_bound_completed_new_preview(self):
        verified = await bridge.verify_saved_publication_covers(None, self.payload, self.legacy, self.revision, self.helpers)
        self.assertEqual(verified.get("landscape"), self.proof)
        self.assertNotIn("portrait", verified)
        self.slots["landscape"]["src"] = "old-landscape.jpg"
        verified = await bridge.verify_saved_publication_covers(None, self.payload, self.legacy, self.revision, self.helpers)
        self.assertNotIn("landscape", verified, "an old preview cannot borrow a completed new upload proof")

    async def test_an_unrelated_cover_is_never_overwritten(self):
        self.slots["portrait"]["src"] = "unrelated.jpg"
        with self.assertRaisesRegex(RuntimeError, "既非原图也非绑定的新图"):
            await bridge.verify_saved_publication_covers(None, self.payload, self.legacy, self.revision, self.helpers)


class SavedPublicationRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.legacy, self.payload, self.state = fixture(self.directory.name)
        self.file = Path(self.directory.name) / "state.json"
        bridge.write_state(self.file, self.state)
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        await self.context.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<main>Offline fixture</main>"))
        self.events = []
        self.publication_calls = 0
        self.fail_before_click = False
        self.unknown_after_click = False
        self.interrupt_after_cover = None
        self.cover_selections = []
        self.real_verify_saved_video = bridge.verify_saved_video
        helpers = SimpleNamespace(fill_metadata=AsyncMock(side_effect=self.metadata), _verify_metadata=AsyncMock())
        self.engine = (None, None, lambda: PlaywrightContext(), helpers, None, None)
        self.request = {"payload": self.payload, "legacyPayload": self.legacy, "result": self.state["result"], "config": {}}
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        replacements = {"job_state_file": lambda _: self.file, "load_engine": lambda: self.engine,
                        "connect_upload_browser": AsyncMock(return_value=(self.browser, None, "fixture")),
                        "verify_public_baijiahao_preview": AsyncMock(side_effect=RuntimeError("not yet public")),
                        "locate_baijiahao_draft": AsyncMock(side_effect=self.locate),
                        "verify_saved_video": AsyncMock(side_effect=self.verify_video),
                        "verify_saved_baijiahao_covers": AsyncMock(side_effect=self.verify_covers),
                        "verify_saved_publication_covers": AsyncMock(side_effect=lambda _page, _payload, _legacy, revision, _helpers: deepcopy(revision.get("covers", {}))),
                        "baijiahao_covers": AsyncMock(side_effect=self.replace_covers),
                        "ensure_baijiahao_fields": AsyncMock(return_value={}),
                        "verify_baijiahao_fields": AsyncMock(), "publication_button": AsyncMock(),
                        "add_optional_topics": AsyncMock(side_effect=self.topics),
                        "publish_video": AsyncMock(side_effect=self.publish),
                        "reconcile_publication": AsyncMock(side_effect=self.reconcile)}
        self.mocks = {name: self.patches.enter_context(patch.object(bridge, name, value)) for name, value in replacements.items()}

    async def locate(self, listing, **kwargs):
        self.assertEqual(kwargs["expected_id"], ARTICLE_ID)
        url = self.request["result"]["draftUrl"]
        await listing.set_content(f'<button class="article-action-btn" onclick="window.open(\'{url}\')">修改</button>')
        return {"id": ARTICLE_ID}, listing.locator("body"), {}

    async def verify_video(self, page, payload, state, helpers, **kwargs):
        self.assertEqual(payload["videoPath"], self.legacy["videoPath"])
        self.assertEqual(bridge.local_files(payload), state["files"])
        self.events.append("video")

    async def verify_covers(self, page, payload, helpers):
        self.events.append("old-covers" if payload["landscapePath"] == self.legacy["landscapePath"] else "new-covers")

    async def replace_covers(self, page, payload, helpers, **kwargs):
        self.events.append("replace-covers")
        covers = deepcopy(kwargs.get("verified") or {})
        for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
            if kind in covers:
                continue
            self.cover_selections.append(kind)
            covers[kind] = {"status": "uploaded", "verification": "source_and_preview", "preview": f"blob:{kind}",
                            "fingerprint": hashlib.sha256(Path(payload[key]).read_bytes()).hexdigest(),
                            "source_sha256_verified": hashlib.sha256(Path(payload[key]).read_bytes()).hexdigest()}
            if kwargs.get("checkpoint"):
                kwargs["checkpoint"](deepcopy(covers))
            if self.interrupt_after_cover == len([name for name in ("landscape", "portrait") if name in covers]):
                self.interrupt_after_cover = None
                raise RuntimeError("fixture: interrupted during cover revision")
        return covers

    async def metadata(self, page, title, description):
        self.events.append("metadata")
        return {"description": {"value": description}}

    async def topics(self, page, payload, metadata):
        self.events.append("topics")
        return {**metadata, "topicAttempt": {"selectedLabels": ["#NBA#"]}}

    def submission(self, state):
        result = {**state["result"], "saved": False, "submitted": True, "published": False,
                  "publicationStatus": "submitted", "articleId": ARTICLE_ID,
                  "publishedUrl": f"https://baijiahao.baidu.com/builder/preview/s?id={ARTICLE_ID}"}
        result.pop("draftUrl", None)
        state.update(phase="submitted", result=result)
        bridge.write_state(self.file, state)
        return result

    async def publish(self, page, payload, state, file, engine, *, preflight):
        if self.fail_before_click:
            self.fail_before_click = False
            raise RuntimeError("fixture: topic lookup interrupted before click")
        await preflight(page, payload, state, engine, prepare_file=file)
        self.publication_calls += 1
        self.events.append("publish")
        state.update(phase="publish_requested", publishAttemptedAt=time.time())
        bridge.write_state(file, state)
        if self.unknown_after_click:
            raise RuntimeError("fixture: response lost")
        return self.submission(state)

    async def reconcile(self, browser, payload, state, file):
        self.events.append("reconcile")
        return self.submission(state)

    async def test_existing_draft_gets_revised_covers_and_exact_topic_once(self):
        result = await bridge.publish_saved_baijiahao_video(self.request)
        self.assertEqual(result["articleId"], ARTICLE_ID)
        self.assertTrue(result["submitted"])
        self.assertFalse(result["saved"])
        self.assertLess(self.events.index("old-covers"), self.events.index("replace-covers"))
        self.assertLess(self.events.index("replace-covers"), self.events.index("topics"))
        stored = json.loads(self.file.read_text())
        self.assertEqual(stored["files"], bridge.local_files(self.payload))
        self.assertEqual(stored["payloadDigest"], bridge.payload_digest(self.payload))
        self.assertEqual(stored["expectedPublicationId"], ARTICLE_ID)
        again = await bridge.publish_saved_baijiahao_video(self.request)
        self.assertEqual(again, result)
        self.assertEqual(self.publication_calls, 1)
        self.assertEqual(self.mocks["baijiahao_covers"].await_count, 1)

    async def test_interruption_before_publication_reuses_the_same_ready_editor_and_covers(self):
        self.fail_before_click = True
        with self.assertRaisesRegex(RuntimeError, "before click"):
            await bridge.publish_saved_baijiahao_video(self.request)
        self.assertEqual(json.loads(self.file.read_text())["phase"], "staged")
        result = await bridge.publish_saved_baijiahao_video(self.request)
        self.assertEqual(result["articleId"], ARTICLE_ID)
        self.assertEqual(self.publication_calls, 1)
        self.assertEqual(self.mocks["baijiahao_covers"].await_count, 1)

    async def test_lost_publication_response_only_reconciles_original_article(self):
        self.unknown_after_click = True
        with self.assertRaisesRegex(RuntimeError, "response lost"):
            await bridge.publish_saved_baijiahao_video(self.request)
        result = await bridge.publish_saved_baijiahao_video(self.request)
        self.assertEqual(result["articleId"], ARTICLE_ID)
        self.assertEqual(self.publication_calls, 1)
        self.assertEqual(self.events[-1], "reconcile")
        self.assertEqual(self.mocks["baijiahao_covers"].await_count, 1)

    async def assert_partial_cover_resume(self, after):
        self.interrupt_after_cover = after
        with self.assertRaisesRegex(RuntimeError, "during cover revision"):
            await bridge.publish_saved_baijiahao_video(self.request)
        interrupted = json.loads(self.file.read_text())
        self.assertEqual(interrupted["phase"], "saved")
        editor = interrupted["savedPublication"]["editor"]
        result = await bridge.publish_saved_baijiahao_video(self.request)
        stored = json.loads(self.file.read_text())
        self.assertEqual(result["articleId"], ARTICLE_ID)
        self.assertEqual(stored["targetId"], editor["targetId"])
        self.assertEqual(stored["documentToken"], editor["documentToken"])
        self.assertEqual(self.mocks["locate_baijiahao_draft"].await_count, 1, "must resume the bound editor")
        self.assertEqual(self.cover_selections, ["landscape", "portrait"])
        self.assertEqual(self.publication_calls, 1)

    async def test_first_cover_complete_before_new_checkpoint_resumes_same_editor(self):
        await self.assert_partial_cover_resume(1)

    async def test_second_cover_complete_before_new_checkpoint_resumes_same_editor(self):
        await self.assert_partial_cover_resume(2)

    async def test_metadata_interruption_accepts_only_bound_old_or_new_copy_on_same_editor(self):
        async def write_metadata(page, title, description):
            await page.set_content('<div class="videov2-title-wrap"><div contenteditable="true"></div></div><video src="blob:original"></video>')
            await page.locator('[contenteditable="true"]').fill(description)
            await page.locator("video").evaluate("e=>Object.defineProperties(e,{readyState:{value:4},duration:{value:10}})")
            return await self.metadata(page, title, description)

        self.engine[3].fill_metadata.side_effect = write_metadata
        self.mocks["ensure_baijiahao_fields"].side_effect = RuntimeError("fixture: interrupted after metadata")
        with self.assertRaisesRegex(RuntimeError, "after metadata"):
            await bridge.publish_saved_baijiahao_video(self.request)
        interrupted = json.loads(self.file.read_text())
        self.assertEqual(interrupted["phase"], "saved")
        binding = interrupted["savedPublication"]["editor"]
        page = [page for page in self.context.pages if await bridge.page_id(page) == binding["targetId"]][0]
        self.mocks["ensure_baijiahao_fields"].side_effect = None

        async def verify_metadata(page, metadata):
            if await page.locator('[contenteditable="true"]').inner_text() != metadata["description"]["value"]:
                raise RuntimeError("description changed during staging")

        async def verify_video(page, payload, state, helpers, **kwargs):
            return await self.real_verify_saved_video(page, payload, state, helpers, timeout=0, **kwargs)

        self.engine[3]._verify_metadata.side_effect = verify_metadata
        self.mocks["verify_saved_video"].side_effect = verify_video
        with patch.object(bridge, "local_video_duration", return_value=10):
            await page.locator('[contenteditable="true"]').fill("第三方改稿")
            with self.assertRaisesRegex(RuntimeError, "文案尚未与原任务匹配"):
                await bridge.publish_saved_baijiahao_video(self.request)
            self.assertEqual(json.loads(self.file.read_text())["phase"], "saved")
            self.assertEqual(self.engine[3].fill_metadata.await_count, 1)

            await page.locator('[contenteditable="true"]').fill(self.legacy["description"])
            self.fail_before_click = True
            with self.assertRaisesRegex(RuntimeError, "before click"):
                await bridge.publish_saved_baijiahao_video(self.request)
            self.assertEqual(json.loads(self.file.read_text())["phase"], "staged")

            bridge.write_state(self.file, interrupted)
            result = await bridge.publish_saved_baijiahao_video(self.request)
        stored = json.loads(self.file.read_text())
        self.assertEqual(result["articleId"], ARTICLE_ID)
        self.assertEqual(stored["targetId"], binding["targetId"])
        self.assertEqual(stored["documentToken"], binding["documentToken"])
        self.assertEqual(self.mocks["locate_baijiahao_draft"].await_count, 1)
        self.assertEqual(self.cover_selections, ["landscape", "portrait"])
        self.assertEqual(self.publication_calls, 1)


if __name__ == "__main__":
    unittest.main()
