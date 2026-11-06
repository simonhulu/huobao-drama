"""Custom posters unblock videoV2 readiness before the upload identity check."""

import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import bridge


class StagingCoverOrderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self.snapshots = []
        self.payload = {
            "title": "NBA news", "description": "Game report", "videoPath": "video.mp4",
            "landscapePath": "wide.png", "portraitPath": "tall.png",
        }
        self.metadata = {"description": {"status": "filled", "value": "Game report"}}
        self.media = {
            "status": "uploaded", "media_src": "blob:original-video",
            "verification": "blob_sha256", "video_fingerprint": "original-video-sha",
        }
        self.covers = {"layout": "videoV2", **{
            kind: {"status": "uploaded", "preview": f"https://preview/{kind}",
                   "fingerprint": digest, "source_sha256_verified": digest,
                   "verification": "source_and_preview", "confirmClicks": 1}
            for kind, digest in (("landscape", "wide-sha"), ("portrait", "tall-sha"))
        }}
        self.cover_ready = False
        self.app = SimpleNamespace(
            validate_upload_args=AsyncMock(side_effect=lambda: self.events.append("validate")),
            _select_video_file=AsyncMock(side_effect=lambda *args, **kwargs: self.events.append("select")),
        )
        self.app_factory = MagicMock(return_value=self.app)
        self.control = object()
        self.wait_editable = AsyncMock(side_effect=lambda **kwargs: self.events.append("editable"))
        self.page = SimpleNamespace(locator=MagicMock(return_value=SimpleNamespace(
            first=SimpleNamespace(wait_for=self.wait_editable))))
        self.helpers = SimpleNamespace(
            fill_metadata=AsyncMock(side_effect=self.fill_metadata),
            verify_upload=AsyncMock(side_effect=self.verify_upload),
            verify_page=AsyncMock(side_effect=lambda *args: self.events.append("verify_page")),
        )
        self.engine = (self.app_factory, None, None, self.helpers, None, None)
        self.ensure_fields = AsyncMock(side_effect=self.fill_fields)
        self.real_cover_helper = bridge.baijiahao_covers
        self.cover_helper = AsyncMock(side_effect=self.set_covers)
        for name, value in (
            ("baijiahao_video_input", AsyncMock(return_value=(self.control, "primary-input"))),
            ("baijiahao_covers", self.cover_helper),
            ("ensure_baijiahao_fields", self.ensure_fields),
            ("progress", MagicMock()),
            ("save_draft", AsyncMock()),
            ("publish_video", AsyncMock()),
        ):
            patcher = patch.object(bridge, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def fill_metadata(self, *args):
        self.events.append("metadata")
        return self.metadata

    async def fill_fields(self, *args):
        self.events.append("fields")
        return {"topic": "NBA"}

    async def verify_upload(self, *args):
        self.events.append("verify_upload")
        if not self.cover_ready:
            raise TimeoutError("No server-generated covers: videoV2 is not ready")
        return self.media

    async def set_covers(self, page, payload, helpers, *, checkpoint):
        self.events.append("covers")
        self.assertEqual(page, self.page)
        self.assertEqual(payload, self.payload)
        self.assertEqual(helpers, self.helpers)
        checkpoint({"layout": "videoV2", "landscape": self.covers["landscape"]})
        checkpoint(copy.deepcopy(self.covers))
        self.cover_ready = True
        return self.covers

    def checkpoint(self, details):
        self.snapshots.append(copy.deepcopy(details))

    async def stage(self):
        return await bridge.stage_baijiahao_video(
            self.page, self.payload, "http://127.0.0.1:9225", self.engine,
            checkpoint=self.checkpoint,
            before_select=lambda: self.events.append("before_select"),
        )

    def assert_no_publication(self):
        bridge.save_draft.assert_not_awaited()
        bridge.publish_video.assert_not_awaited()
        self.page.locator.assert_called_once_with('div[class*="contentEditable"]')

    async def test_custom_covers_make_video_ready_before_exact_blob_verification(self):
        result = await self.stage()
        self.assertEqual(self.events, [
            "validate", "before_select", "select", "editable", "metadata", "covers",
            "verify_upload", "verify_page", "fields",
        ])
        self.app._select_video_file.assert_awaited_once_with(
            self.page, self.control, selector="primary-input")
        self.helpers.verify_upload.assert_awaited_once_with(self.page, "video.mp4")
        self.helpers.verify_page.assert_awaited_once_with(self.page, self.metadata, self.covers)
        self.assertEqual(self.snapshots[0], {
            "metadata": self.metadata, "engine": "social-auto-upload/baijiahao-local-stage",
        })
        self.assertTrue(all("media" not in item for item in self.snapshots[:-1]))
        self.assertEqual(self.snapshots[-1]["media"], self.media)
        self.assertEqual(self.snapshots[-1]["covers"], self.covers)
        self.assertEqual(result["media"]["verification"], "blob_sha256")
        self.assertEqual(result["media"]["video_fingerprint"], "original-video-sha")
        self.assertEqual(result["settings"], {"topic": "NBA"})
        self.assertTrue(self.app_factory.call_args.kwargs["stage_only"])
        self.assert_no_publication()

    async def test_partial_cover_failure_preserves_source_proof_without_media_receipt(self):
        async def partial(page, payload, helpers, *, checkpoint):
            checkpoint({"layout": "videoV2", "landscape": self.covers["landscape"]})
            raise TimeoutError("Portrait crop still processing")
        self.cover_helper.side_effect = partial
        with self.assertRaisesRegex(TimeoutError, "Portrait crop"):
            await self.stage()
        self.assertTrue(self.snapshots)
        self.assertTrue(all("media" not in item for item in self.snapshots))
        self.assertEqual(self.snapshots[-1]["metadata"], self.metadata)
        self.assertEqual(self.snapshots[-1]["covers"], {
            "layout": "videoV2", "landscape": self.covers["landscape"],
        })
        self.helpers.verify_upload.assert_not_awaited()
        self.helpers.verify_page.assert_not_awaited()
        self.ensure_fields.assert_not_awaited()
        self.assert_no_publication()

    async def test_video_identity_failure_retains_covers_without_claiming_verified_media(self):
        self.helpers.verify_upload.side_effect = RuntimeError("Selected video SHA-256 mismatch")
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            await self.stage()
        self.assertEqual(self.snapshots[-1]["covers"], self.covers)
        self.assertTrue(all("media" not in item for item in self.snapshots))
        self.helpers.verify_page.assert_not_awaited()
        self.ensure_fields.assert_not_awaited()
        self.assert_no_publication()

    async def test_page_verification_failure_preserves_only_the_actual_verified_receipt(self):
        self.helpers.verify_page.side_effect = RuntimeError("Cover changed after upload")
        with self.assertRaisesRegex(RuntimeError, "Cover changed"):
            await self.stage()
        self.assertEqual(self.snapshots[-1]["media"], self.media)
        self.assertEqual(self.snapshots[-1]["covers"], self.covers)
        self.ensure_fields.assert_not_awaited()
        self.assert_no_publication()

    async def test_stage_recovers_late_crop_after_video_verification_without_reupload(self):
        self.helpers.verify_page.side_effect = [RuntimeError("百家号封面弹窗尚未确认，未保存"), None]
        self.helpers._file_digest = lambda path: {"wide.png": "wide-sha", "tall.png": "tall-sha"}[path]
        self.helpers._verify_metadata = AsyncMock()
        updated = copy.deepcopy(self.covers)
        updated["portrait"]["preview"] = "confirmed portrait"

        async def covers(page, payload, helpers, *, checkpoint, verified=None, confirm_only=False):
            if not confirm_only:
                return await self.set_covers(page, payload, helpers, checkpoint=checkpoint)
            self.assertEqual(verified, self.covers)
            checkpoint(updated)
            return updated

        self.cover_helper.side_effect = covers
        with patch.object(bridge, "baijiahao_cover_dialogs", AsyncMock(return_value=[{"text": "竖版封面预览"}])):
            result = await self.stage()
        self.assertEqual(result["covers"], updated)
        self.assertEqual(self.snapshots[-1]["covers"], updated)
        self.assertEqual(self.snapshots[-1]["media"], self.media)
        self.assertEqual(self.app._select_video_file.await_count, 1)
        self.assertEqual(self.helpers.verify_upload.await_count, 1)
        self.assertEqual(self.helpers.verify_page.await_count, 2)
        self.assert_no_publication()

    async def test_recorded_cover_proofs_are_reused_without_selecting_the_same_images(self):
        self.helpers.verify_upload.side_effect = RuntimeError("Video still processing")
        with self.assertRaisesRegex(RuntimeError, "Video still processing"):
            await self.stage()
        previous = self.snapshots[-1]["covers"]
        page = SimpleNamespace(locator=MagicMock(side_effect=AssertionError("Must reuse existing covers")))
        helpers = SimpleNamespace(
            _file_digest=lambda path: {"wide.png": "wide-sha", "tall.png": "tall-sha"}[path],
            _cover_slots=AsyncMock(return_value={
                kind: {"src": previous[kind]["preview"]} for kind in ("landscape", "portrait")
            }),
        )
        with patch.object(bridge, "baijiahao_cover_dialogs", AsyncMock(return_value=[])):
            reused = await self.real_cover_helper(page, self.payload, helpers, verified=previous)
        self.assertEqual(reused, previous)
        page.locator.assert_not_called()
        self.assert_no_publication()


class ResumePartialCoverTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.asset = self.root / "video.mp4"
        self.asset.write_bytes(b"original video")
        self.payload = {
            "jobId": "nba-partial", "target": "baijiahao-video", "title": "NBA report",
            "description": "Game report", "videoPath": str(self.asset),
            "landscapePath": str(self.asset), "portraitPath": str(self.asset),
        }
        self.request = {"config": {"stateRoot": str(self.root)}, "payload": self.payload}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        self.metadata = {"description": {"status": "filled", "value": "Game report"}}
        self.media = {"media_src": "blob:original", "verification": "blob_sha256", "video_fingerprint": "video-sha"}
        self.proofs = {"layout": "videoV2", **{
            kind: {"fingerprint": f"{kind}-sha", "source_sha256_verified": f"{kind}-sha",
                   "verification": "source_and_preview", "preview": f"https://preview/{kind}"}
            for kind in ("landscape", "portrait")
        }}
        self.state = {
            "phase": "uploading", "protocolVersion": 3, "targetId": "ORIGINAL", "documentToken": "bound",
            "payloadDigest": bridge.payload_digest(self.payload), "files": bridge.local_files(self.payload),
            "fileSelectionStartedAt": 1,
            "details": {"metadata": self.metadata, "covers": {
                "layout": "videoV2", "landscape": self.proofs["landscape"],
            }, "engine": "social-auto-upload/baijiahao-local-stage"},
        }
        self.live = {"video_v2_ready": False, "videos": [{"src": "blob:original", "selected_src": "blob:original"}]}
        self.cover_slots = {
            kind: {"src": self.proofs[kind]["preview"]} for kind in ("landscape", "portrait")
        }
        self.events = []
        self.ready = False
        self.page = SimpleNamespace(
            url=bridge.EDITORS["baijiahao-video"], bring_to_front=AsyncMock(), screenshot=AsyncMock(),
            evaluate=AsyncMock(side_effect=lambda script: copy.deepcopy(self.live) if script == "media" else []),
        )
        self.browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[self.page])])
        self.helpers = SimpleNamespace(
            _READ_MEDIA="media", _READ_METADATA="metadata",
            _classify_upload=lambda live: "failed" if live.get("video_upload_failed") else "unknown",
            _file_digest=lambda path: "video-sha", _browser_digest=AsyncMock(return_value="video-sha"),
            _cover_slots=AsyncMock(side_effect=lambda page: copy.deepcopy(self.cover_slots)),
            verify_upload=AsyncMock(side_effect=self.verify_upload), verify_page=AsyncMock(),
            _metadata_fields=lambda fields: ("videoV2", {"description": {"value": "Game report"}}),
        )
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=object())
        manager.__aexit__ = AsyncMock(return_value=False)
        self.engine = (None, None, lambda: manager, self.helpers, None, None)
        self.cover_helper = AsyncMock(side_effect=self.complete_covers)
        self.verify_document = AsyncMock()
        for name, value in (
            ("load_engine", MagicMock(return_value=self.engine)),
            ("connect_upload_browser", AsyncMock(return_value=(self.browser, "http://127.0.0.1:9225", None))),
            ("page_id", AsyncMock(return_value="ORIGINAL")), ("verify_document", self.verify_document),
            ("baijiahao_covers", self.cover_helper), ("resume_baijiahao_creation_dialog", AsyncMock()),
            ("ensure_baijiahao_fields", AsyncMock(return_value=None)), ("progress", MagicMock()),
            ("stage_baijiahao_video", AsyncMock(side_effect=AssertionError("Cannot reupload video"))),
            ("save_draft", AsyncMock(side_effect=AssertionError("Cannot save"))),
            ("publish_video", AsyncMock(side_effect=AssertionError("Cannot publish"))),
        ):
            patcher = patch.object(bridge, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def complete_covers(self, page, payload, helpers, verified, checkpoint):
        self.events.append("covers")
        self.assertEqual(verified, self.state["details"]["covers"])
        checkpoint(copy.deepcopy(self.proofs))
        self.ready = True
        return self.proofs

    async def verify_upload(self, *args, **kwargs):
        self.events.append("verify_upload")
        if not self.ready:
            raise TimeoutError("Missing portrait: videoV2 cannot be ready")
        return self.media

    async def resume(self):
        bridge.write_state(self.file, self.state)
        return await bridge.upload(self.request, "resume")

    async def test_resume_recovers_late_crop_and_persists_new_proof_without_reupload(self):
        for kind in ("landscape", "portrait"):
            self.proofs[kind].update(status="uploaded", fingerprint="video-sha", source_sha256_verified="video-sha")
        self.state["details"]["covers"] = copy.deepcopy(self.proofs)
        self.state["details"]["media"] = self.media
        self.ready = True
        self.helpers.verify_page.side_effect = [RuntimeError("百家号封面弹窗尚未确认，未保存"), None]
        self.helpers._verify_metadata = AsyncMock()
        updated = copy.deepcopy(self.proofs)
        updated["portrait"]["preview"] = "confirmed portrait"

        async def covers(page, payload, helpers, verified=None, checkpoint=None, *, confirm_only=False):
            if not confirm_only:
                return await self.complete_covers(page, payload, helpers, verified, checkpoint)
            self.assertEqual(verified, self.proofs)
            checkpoint(updated)
            return updated

        self.cover_helper.side_effect = covers
        with patch.object(bridge, "baijiahao_cover_dialogs", AsyncMock(return_value=[{"text": "竖版封面预览"}])):
            result = await self.resume()
        self.assertTrue(result["staged"])
        state = json.loads(self.file.read_text())
        self.assertEqual(state["details"]["covers"], updated)
        self.assertEqual(state["details"]["media"], self.media)
        self.assertEqual(self.helpers.verify_page.await_count, 2)
        bridge.stage_baijiahao_video.assert_not_awaited()
        bridge.save_draft.assert_not_awaited()
        bridge.publish_video.assert_not_awaited()

    def assert_no_reupload_or_publication(self):
        bridge.stage_baijiahao_video.assert_not_awaited()
        bridge.save_draft.assert_not_awaited()
        bridge.publish_video.assert_not_awaited()

    async def test_missing_portrait_reuses_landscape_before_waiting_for_video_readiness(self):
        result = await self.resume()
        self.assertEqual(self.events, ["covers", "verify_upload"])
        self.helpers._browser_digest.assert_awaited_once_with(self.page, "blob:original")
        self.cover_helper.assert_awaited_once()
        self.verify_document.assert_awaited_once()
        persisted = json.loads(self.file.read_text())
        self.assertEqual(persisted["details"]["media"], self.media)
        self.assertEqual(persisted["details"]["covers"], self.proofs)
        self.assertEqual(persisted["documentToken"], "bound")
        self.assertEqual(result["targetId"], "ORIGINAL")
        self.assertFalse(result["saved"])
        self.assert_no_reupload_or_publication()

    async def test_replaced_previous_video_stops_before_editing_covers(self):
        self.state["details"]["media"] = {**self.media, "media_src": "blob:old"}
        with self.assertRaisesRegex(RuntimeError, "已被替换"):
            await self.resume()
        self.cover_helper.assert_not_awaited()
        self.helpers.verify_upload.assert_not_awaited()
        self.assert_no_reupload_or_publication()

    async def test_unverified_or_failed_video_cannot_receive_covers(self):
        for failure in ("different-hash", "upload-failed"):
            with self.subTest(failure=failure):
                self.helpers._browser_digest.return_value = "different-sha" if failure == "different-hash" else "video-sha"
                self.live["video_upload_failed"] = failure == "upload-failed"
                with self.assertRaises(RuntimeError):
                    await self.resume()
                self.cover_helper.assert_not_awaited()
                self.helpers.verify_upload.assert_not_awaited()
        self.assert_no_reupload_or_publication()

    async def test_cover_interruption_keeps_partial_proof_without_fake_media(self):
        async def interrupted(page, payload, helpers, verified, checkpoint):
            checkpoint(verified)
            raise TimeoutError("Portrait processing")
        self.cover_helper.side_effect = interrupted
        with self.assertRaisesRegex(TimeoutError, "Portrait processing"):
            await self.resume()
        persisted = json.loads(self.file.read_text())
        self.assertEqual(persisted["details"]["covers"], self.state["details"]["covers"])
        self.assertNotIn("media", persisted["details"])
        self.helpers.verify_upload.assert_not_awaited()
        self.assert_no_reupload_or_publication()

    async def test_video_source_cannot_change_during_cover_recovery(self):
        self.media["media_src"] = "blob:replacement"
        with self.assertRaisesRegex(RuntimeError, "已被替换"):
            await self.resume()
        persisted = json.loads(self.file.read_text())
        self.assertEqual(persisted["details"]["covers"], self.proofs)
        self.assertNotIn("media", persisted["details"])
        self.helpers.verify_page.assert_not_awaited()
        self.assert_no_reupload_or_publication()

    async def test_complete_cover_proofs_keep_identity_verification_first(self):
        self.state["details"]["covers"] = copy.deepcopy(self.proofs)
        self.ready = True
        await self.resume()
        self.assertEqual(self.events, ["verify_upload", "covers"])
        self.helpers._browser_digest.assert_not_awaited()
        self.assert_no_reupload_or_publication()

    async def test_saved_proofs_with_missing_portrait_verify_source_then_repair_before_readiness(self):
        self.state["details"]["covers"] = copy.deepcopy(self.proofs)
        self.cover_slots["portrait"]["src"] = ""
        self.helpers._browser_digest.side_effect = lambda *args: self.events.append("digest") or "video-sha"
        await self.resume()
        self.assertEqual(self.events, ["digest", "covers", "verify_upload"])
        self.helpers._browser_digest.assert_awaited_once_with(self.page, "blob:original")
        self.cover_helper.assert_awaited_once()
        persisted = json.loads(self.file.read_text())
        self.assertEqual(persisted["details"]["media"], self.media)
        self.assertEqual(persisted["details"]["covers"], self.proofs)
        self.assert_no_reupload_or_publication()

    async def test_saved_proofs_with_missing_portrait_block_wrong_video_before_cover_writes(self):
        self.state["details"]["covers"] = copy.deepcopy(self.proofs)
        self.cover_slots["portrait"]["src"] = ""
        self.helpers._browser_digest.side_effect = lambda *args: self.events.append("digest") or "different-sha"
        with self.assertRaisesRegex(RuntimeError, "指纹不一致"):
            await self.resume()
        self.assertEqual(self.events, ["digest"])
        self.cover_helper.assert_not_awaited()
        self.helpers.verify_upload.assert_not_awaited()
        self.assert_no_reupload_or_publication()

    async def test_saved_proofs_with_changed_preview_verify_source_before_cover_recovery(self):
        self.state["details"]["covers"] = copy.deepcopy(self.proofs)
        self.cover_slots["portrait"]["src"] = "https://preview/replaced"
        self.helpers._browser_digest.side_effect = lambda *args: self.events.append("digest") or "video-sha"
        await self.resume()
        self.assertEqual(self.events, ["digest", "covers", "verify_upload"])
        self.assert_no_reupload_or_publication()


if __name__ == "__main__":
    unittest.main()
