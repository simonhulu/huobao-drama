import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from types import SimpleNamespace

import account_browser

spec = importlib.util.spec_from_file_location("social_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeSafetyTest(unittest.TestCase):
    def test_baijiahao_video_resolves_the_primary_input_when_auxiliary_picker_exists(self):
        control = SimpleNamespace(is_enabled=AsyncMock(return_value=True))
        inputs = SimpleNamespace(first=control, count=AsyncMock(return_value=1))
        all_inputs = SimpleNamespace(count=AsyncMock(return_value=2))
        areas = SimpleNamespace(count=AsyncMock(return_value=1))
        locators = {
            bridge.BAIJIAHAO_VIDEO_INPUT_SELECTOR: all_inputs,
            bridge.BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR: inputs,
            bridge.BAIJIAHAO_UPLOAD_AREA_SELECTOR: areas,
        }
        page = SimpleNamespace(locator=MagicMock(side_effect=locators.__getitem__))
        result = asyncio.run(bridge.baijiahao_video_input(page))
        self.assertEqual(result, (control, bridge.BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR))
        control.is_enabled.assert_awaited_once_with()
        all_inputs.count.assert_not_awaited()
        self.assertEqual([call.args[0] for call in page.locator.call_args_list],
                         [bridge.BAIJIAHAO_VIDEO_INPUT_SELECTOR, bridge.BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR,
                          bridge.BAIJIAHAO_UPLOAD_AREA_SELECTOR])

    def test_baijiahao_video_stage_passes_the_narrow_selector_to_cdp(self):
        created = []

        class App:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.validate_upload_args = AsyncMock()
                self._select_video_file = AsyncMock()
                created.append(self)

        control = object()
        selector = bridge.BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR
        resolve_input = AsyncMock(return_value=(control, selector))
        content = SimpleNamespace(first=SimpleNamespace(wait_for=AsyncMock()))
        page = SimpleNamespace(locator=MagicMock(return_value=content))
        helpers = SimpleNamespace(
            fill_metadata=AsyncMock(return_value={"description": {"value": "简介"}}),
            verify_upload=AsyncMock(return_value={"status": "uploaded"}),
            verify_page=AsyncMock(),
        )
        engine = (App, None, None, helpers, None, None)
        with patch.object(bridge, "baijiahao_video_input", new=resolve_input), \
                patch.object(bridge, "baijiahao_covers", new=AsyncMock(return_value={"landscape": {}, "portrait": {}})):
            result = asyncio.run(bridge.stage_baijiahao_video(
                page,
                {"title": "标题", "description": "简介", "videoPath": "video.mp4", "landscapePath": "cover.jpg", "portraitPath": "portrait.jpg"},
                "http://127.0.0.1:9225",
                engine,
            ))
        self.assertEqual(result["media"]["status"], "uploaded")
        app = created[0]
        resolve_input.assert_awaited_once_with(page)
        app._select_video_file.assert_awaited_once_with(page, control, selector=selector)

    def test_preselection_failure_is_disposable_but_uploaded_or_save_attempted_pages_are_not(self):
        blank = {"phase": "initializing"}
        self.assertTrue(bridge.can_close_preselection_failure(blank))
        for key in ("fileSelectionStartedAt", "details", "result", "saveAttemptedAt"):
            with self.subTest(key=key):
                self.assertFalse(bridge.can_close_preselection_failure({**blank, key: 1}))

    def test_preselection_failure_closes_owned_tab_and_idle_named_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "state.json"
            state = {"phase": "initializing", "targetId": "ABC123", "documentToken": "token"}
            payload = {"jobId": "job-1", "target": "baijiahao-video"}
            bridge.write_state(file, state)
            page = SimpleNamespace(
                is_closed=lambda: False,
                evaluate=AsyncMock(return_value={"name": "huobao-sau-job-1", "token": "token", "href": bridge.EDITORS[payload["target"]]}),
                close=AsyncMock(),
            )
            browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[page])])
            with patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                    patch.object(account_browser, "close_idle_account_browser", new=AsyncMock(return_value=True)) as idle:
                self.assertTrue(asyncio.run(bridge.close_preselection_failure(browser, payload, state, file)))
            page.close.assert_awaited_once_with(run_before_unload=False)
            idle.assert_awaited_once_with(browser)
            saved = json.loads(file.read_text())
            self.assertIn("editorClosedAt", saved)
            self.assertEqual(saved["phase"], "initializing")

    def test_only_local_cdp_endpoints_are_allowed(self):
        self.assertEqual(bridge.validate_endpoint("http://127.0.0.1:9225"), "http://127.0.0.1:9225")
        for endpoint in ("https://example.com:443", "http://localhost:9225", "file:///tmp/a", "http://127.0.0.1:9225/a"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                bridge.validate_endpoint(endpoint)

    def test_payload_identity_covers_text_and_project(self):
        payload = {"jobId": "test-one", "scriptId": 56, "title": "saved copy", "fingerprint": "a"}
        self.assertEqual(bridge.payload_digest(payload), bridge.payload_digest(dict(reversed(list(payload.items())))))
        for key, value in (("scriptId", 57), ("title", "other copy"), ("fingerprint", "b")):
            self.assertNotEqual(bridge.payload_digest(payload), bridge.payload_digest({**payload, key: value}))

    def test_local_files_hash_actual_bytes_and_reject_missing_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "video.mp4"
            file.write_bytes(b"first")
            before = bridge.local_files({"videoPath": str(file)})
            file.write_bytes(b"second")
            self.assertNotEqual(before, bridge.local_files({"videoPath": str(file)}))
            file.write_bytes(b"")
            with self.assertRaises(ValueError):
                bridge.local_files({"videoPath": str(file)})

    def test_save_attempt_is_not_repeated(self):
        page = AsyncMock()
        state = {"phase": "save_requested", "saveAttemptedAt": 1}
        with self.assertRaisesRegex(RuntimeError, "禁止重复保存"):
            asyncio.run(bridge.save_draft(page, {}, state, Path("unused.json"), ()))
        page.get_by_role.assert_not_called()

    def test_saved_result_is_idempotent_without_browser_access(self):
        page = AsyncMock()
        result = {"staged": True, "saved": True, "published": False}
        self.assertEqual(asyncio.run(bridge.save_draft(page, {}, {"phase": "saved", "result": result}, Path("unused"), ())), result)
        page.get_by_role.assert_not_called()

    def test_different_editor_binding_prevents_saving(self):
        page = AsyncMock()
        page.evaluate.return_value = "another-job"
        with self.assertRaisesRegex(RuntimeError, "编辑页已重载或被替换"):
            asyncio.run(bridge.verify_staged(page, {"jobId": "ours"}, {}, ()))

    def test_reloaded_document_with_same_window_name_cannot_save(self):
        page = AsyncMock()
        page.evaluate.return_value = {"name": "huobao-sau-ours", "token": None}
        with self.assertRaisesRegex(RuntimeError, "编辑页已重载或被替换"):
            asyncio.run(bridge.verify_staged(page, {"jobId": "ours"}, {"documentToken": "original"}, ()))

    def test_replaced_server_video_cannot_save_with_same_document_token(self):
        page = AsyncMock()
        page.evaluate.return_value = {"name": "huobao-sau-ours", "token": "original"}
        helpers = SimpleNamespace(verify_upload=AsyncMock(return_value={"media_src": "https://media/other.mp4"}), verify_page=AsyncMock())
        state = {"documentToken": "original", "details": {"media": {"media_src": "https://media/ours.mp4"}}}
        with self.assertRaisesRegex(RuntimeError, "视频在上传后已被替换"):
            asyncio.run(bridge.verify_staged(page, {"jobId": "ours", "target": "baijiahao-video", "videoPath": "ours.mp4"}, state,
                                             (None, None, None, helpers, None, None)))
        helpers.verify_page.assert_not_called()

    def test_existing_stage_never_reuploads_or_saves_implicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {"jobId": "test-stage", "target": "baijiahao-video"}
            job = Path(directory) / "jobs" / payload["jobId"]
            job.mkdir(parents=True)
            result = {"staged": True, "saved": False, "published": False}
            bridge.write_state(job / "state.json", {"phase": "staged", "payloadDigest": bridge.payload_digest(payload), "result": result})
            request = {"config": {"stateRoot": directory}, "payload": payload, "saveDraft": False}
            with patch.object(bridge, "load_engine", side_effect=AssertionError("No browser operation permitted")):
                self.assertEqual(asyncio.run(bridge.upload(request, "stage")), result)
                with self.assertRaisesRegex(RuntimeError, "禁止重复上传"):
                    asyncio.run(bridge.upload({**request, "saveDraft": True}, "stage"))

    def test_resume_rejects_unknown_or_save_attempted_phases_without_browser_access(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {"jobId": "test-resume", "target": "baijiahao-video"}
            job = Path(directory) / "jobs" / payload["jobId"]
            job.mkdir(parents=True)
            request = {"config": {"stateRoot": directory}, "payload": payload}
            for phase, attempted in (("opening", False), ("staged", False), ("saved", True), ("uploading", True)):
                with self.subTest(phase=phase, attempted=attempted):
                    bridge.write_state(job / "state.json", {"phase": phase, "saveAttemptedAt": attempted,
                                       "payloadDigest": bridge.payload_digest(payload)})
                    with patch.object(bridge, "load_engine", side_effect=AssertionError("No browser operation permitted")):
                        with self.assertRaisesRegex(RuntimeError, "不会重传视频"):
                            asyncio.run(bridge.upload(request, "resume"))

    def test_saved_draft_match_requires_unique_exact_title_type_and_attempt_time(self):
        attempted = bridge.datetime(2026, 10, 22, 15, 26, 47, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        row = {"title": "saved description", "draft": True, "video": True, "time": "2026-10-22 15:26:48",
               "url": "https://baijiahao.baidu.com/builder/preview/s?id=1879733969332047723"}
        expected = {"id": "1879733969332047723", "time": row["time"]}
        self.assertEqual(bridge.matching_saved_draft([row], row["title"], attempted), expected)
        for change in ({"title": "other"}, {"draft": False}, {"video": False}, {"time": "2026-10-22 15:20:00"},
                       {"url": "https://example.com/builder/preview/s?id=123"}, {"time": "invalid"}):
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, "未找到唯一"):
                bridge.matching_saved_draft([{**row, **change}], row["title"], attempted)
        with self.assertRaisesRegex(RuntimeError, "未找到唯一"):
            bridge.matching_saved_draft([row, {**row, "url": row["url"].replace("1879733969332047723", "1879733969332047724")}], row["title"], attempted)

    def test_read_only_reconciliation_rejects_unsaved_stages(self):
        browser = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, "只读核对已尝试保存"):
            asyncio.run(bridge.reconcile_saved_draft(browser, {"target": "baijiahao-video"}, {"phase": "staged"}, Path("unused"), ()))
        browser.assert_not_called()

    def test_article_draft_match_requires_article_type_exact_title_and_save_time(self):
        attempted = bridge.datetime(2026, 10, 22, 16, 30, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        row = {"title": "图文标题", "draft": True, "video": False, "time": "2026-10-22 16:30:01",
               "url": "https://baijiahao.baidu.com/builder/preview/s?id=1879733969332047724"}
        self.assertEqual(bridge.matching_saved_draft([row], row["title"], attempted, target="baijiahao-article"),
                         {"id": "1879733969332047724", "time": row["time"]})
        for change in ({"video": True}, {"title": "其他标题"}, {"draft": False}, {"time": "2026-10-22 16:20:00"}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                bridge.matching_saved_draft([{**row, **change}], row["title"], attempted, target="baijiahao-article")

    def test_article_cover_checkpoint_can_resume_but_save_attempt_cannot(self):
        payload = {"target": "baijiahao-article"}
        state = {"phase": "uploading", "fileSelectionStartedAt": 1,
                 "details": {"article": {"text": "正文", "images": []}, "engine": "huobao/baijiahao-article-extension"}}
        self.assertTrue(bridge.can_resume_article_images(payload, state))
        self.assertFalse(bridge.can_resume_article_images(payload, {**state, "saveAttemptedAt": 2}))
        self.assertFalse(bridge.can_resume_article_images(payload, {**state, "result": {"staged": True}}))

    def test_cover_revision_requires_saved_article_and_original_draft_identity(self):
        valid = {"phase": "saved", "result": {"saved": True, "published": False,
                 "draftUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=1234"}}
        self.assertEqual(bridge.article_cover_revision_identity({"target": "baijiahao-article"}, valid), "1234")
        for change in ({"phase": "staged"}, {"result": {**valid["result"], "saved": False}},
                       {"result": {**valid["result"], "published": True}},
                       {"result": {**valid["result"], "draftUrl": "https://example.com/builder/rc/edit?type=news&article_id=1234"}},
                       {"result": {**valid["result"], "draftUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=1234"}}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                bridge.article_cover_revision_identity({"target": "baijiahao-article"}, {**valid, **change})

    def test_cover_revision_reconciliation_accepts_only_the_original_draft_id(self):
        row = {"title": "图文标题", "draft": True, "video": False, "time": "2026-10-22 16:30:01",
               "url": "https://baijiahao.baidu.com/builder/preview/s?id=1234"}
        later = bridge.datetime(2026, 10, 22, 18, 30, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        other = {**row, "url": "https://baijiahao.baidu.com/builder/preview/s?id=9999"}
        proof = bridge.matching_saved_draft([other, row], row["title"], later, target="baijiahao-article", expected_id="1234")
        self.assertEqual(proof["id"], "1234")
        with self.assertRaisesRegex(RuntimeError, "未找到唯一"):
            bridge.matching_saved_draft([other], row["title"], later, target="baijiahao-article", expected_id="1234")
        with self.assertRaisesRegex(RuntimeError, "未找到唯一"):
            bridge.matching_saved_draft([row], row["title"], later, target="baijiahao-article")

    def test_cover_revision_rejects_a_manually_published_original_article(self):
        row = {"title": "原图文标题", "draft": True, "video": False,
               "url": "https://baijiahao.baidu.com/builder/preview/s?id=1234"}
        self.assertEqual(bridge.article_revision_draft_row([row], row["title"], "1234"), row)
        published = {**row, "draft": False, "url": "http://baijiahao.baidu.com/s?id=1234"}
        with self.assertRaisesRegex(RuntimeError, "已不是草稿"):
            bridge.article_revision_draft_row([published], row["title"], "1234")
        for rows in ([], [row, row], [{**row, "title": "人工改过的标题"}], [{**row, "video": True}],
                     [{**row, "url": "https://example.com/s?id=1234"}]):
            with self.subTest(rows=rows), self.assertRaises(RuntimeError):
                bridge.article_revision_draft_row(rows, row["title"], "1234")

    def test_completed_cover_revision_is_idempotent_without_platform_access(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {"target": "baijiahao-article", "jobId": "revision", "images": []}
            saved = {"phase": "saved", "files": {}, "result": {"staged": True, "saved": True, "published": False,
                     "draftUrl": "https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=1234"}}
            file = Path(directory) / "state.json"
            revision = {"phase": "saved", "payloadDigest": bridge.payload_digest(payload), "files": {}, "expectedDraftId": "1234", "result": saved["result"]}
            file.with_name("cover-three-v1").mkdir()
            bridge.write_state(file.with_name("cover-three-v1") / "state.json", revision)
            browser = MagicMock()
            self.assertEqual(asyncio.run(bridge.update_saved_article_covers(browser, payload, saved, file, ())), saved["result"])
            browser.assert_not_called()

    def test_tencent_draft_match_requires_unique_exact_description_and_save_time(self):
        attempted = bridge.datetime(2026, 10, 22, 16, 2, 14, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        row = {"title": "saved description", "time": "2026年10月22日 16:02"}
        self.assertEqual(bridge.matching_tencent_draft([row], row["title"], attempted), {"index": 0, "time": row["time"]})
        for rows in ([], [row, row], [{**row, "title": "other"}], [{**row, "time": "2026年10月22日 15:50"}],
                     [{**row, "time": "invalid"}]):
            with self.subTest(rows=rows), self.assertRaisesRegex(RuntimeError, "未找到唯一"):
                bridge.matching_tencent_draft(rows, row["title"], attempted)

    def test_tencent_reconciliation_requires_a_recorded_save_attempt_before_opening_page(self):
        browser = MagicMock()
        for state in ({"phase": "staged"}, {"phase": "save_requested", "saveAttemptedAt": 123}):
            with self.subTest(state=state), self.assertRaises(RuntimeError):
                asyncio.run(bridge.reconcile_saved_draft(browser, {"target": "tencent-video"}, state, Path("unused"), ()))
        browser.contexts.__getitem__.assert_not_called()

    def test_missing_save_notice_uses_read_only_proof_without_second_save_click(self):
        page = SimpleNamespace(locator=lambda _: SimpleNamespace(all_text_contents=AsyncMock(return_value=[])),
                               context=SimpleNamespace(browser="original-browser"))
        button = SimpleNamespace(click=AsyncMock())
        result = {"staged": True, "saved": True, "published": False}
        proof = AsyncMock(return_value=result)
        state = {"phase": "staged", "files": {}}
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, "local_files", return_value={}), \
                patch.object(bridge, "verify_staged", new=AsyncMock()), patch.object(bridge, "one_button", new=AsyncMock(return_value=button)), \
                patch.object(bridge, "time", SimpleNamespace(monotonic=iter([0, 41]).__next__, time=lambda: 123)), \
                patch.object(bridge, "reconcile_saved_draft", new=proof):
            saved = asyncio.run(bridge.save_draft(page, {"target": "baijiahao-video"}, state, Path(directory) / "state.json", ()))
        self.assertEqual(saved, result)
        button.click.assert_awaited_once()
        proof.assert_awaited_once()
        self.assertEqual(proof.call_args.args[0], "original-browser")
        self.assertEqual(state["phase"], "save_requested")

    def test_upstream_without_safety_extension_is_not_used(self):
        source = Path(bridge.__file__).read_text()
        self.assertIn('"stage_only", "cdp_url"', source)
        self.assertNotIn("await app.main(", source)
        self.assertNotIn("await app.submit_publish(", source)
        self.assertNotIn("await app._submit_publish(", source)

    def test_tencent_initialization_recovery_rejects_every_possible_write_checkpoint(self):
        state = {"phase": "initializing", "protocolVersion": 2, "error": "Initialization timed out"}
        payload = {"target": "tencent-video"}
        self.assertTrue(bridge.can_resume_tencent_initialization(payload, state))
        for key in ("details", "result", "saveAttemptedAt", "fileSelectionStartedAt"):
            with self.subTest(key=key):
                self.assertFalse(bridge.can_resume_tencent_initialization(payload, {**state, key: "present"}))
        self.assertFalse(bridge.can_resume_tencent_initialization(payload, {**state, "phase": "uploading"}))
        self.assertFalse(bridge.can_resume_tencent_initialization({"target": "baijiahao-article"}, state))
        self.assertTrue(bridge.can_resume_tencent_initialization(payload, {"phase": "uploading", "error": "Expected a unique initialized WeChat editor"}))

    def test_tencent_uploaded_video_recovery_rejects_saved_or_unbound_checkpoints(self):
        payload = {"target": "tencent-video"}
        state = {"phase": "uploading", "protocolVersion": 2, "error": "portrait cover edit dialog did not open",
                 "fileSelectionStartedAt": 1}
        self.assertTrue(bridge.can_resume_tencent_upload(payload, state))
        for change in ({"saveAttemptedAt": 1}, {"result": {"saved": False}}, {"phase": "staged"},
                       {"fileSelectionStartedAt": None}, {"details": {"engine": "other-uploader"}}):
            with self.subTest(change=change):
                self.assertFalse(bridge.can_resume_tencent_upload(payload, {**state, **change}))

    def test_tencent_cover_resume_preserves_uploaded_video_and_metadata(self):
        payload = {"title": "已经保存的短标题", "description": "原文案", "videoPath": "video.mp4",
                   "landscapePath": "4x3.png", "portraitPath": "3x4.png"}
        page = MagicMock()
        page.locator.return_value.first.wait_for = AsyncMock()
        app = SimpleNamespace(upload_video_file=AsyncMock(side_effect=AssertionError("Must not reupload")),
                              prepare_video_for_publish=AsyncMock(side_effect=AssertionError("Must not rewrite")))
        helpers = SimpleNamespace(validate_stage=MagicMock(), declarations=AsyncMock(return_value={"checkboxes": []}),
            require_empty_editor=AsyncMock(side_effect=AssertionError("Already uploaded")),
            verify_existing_video=AsyncMock(return_value={"sha256": "original", "resumed_without_reupload": True}),
            wait_for_video=AsyncMock(return_value={"src": "blob:original"}),
            verify_metadata=AsyncMock(return_value={"verified": True}))
        covers = {"layout": "tencent-dual-cover"}
        uploader = AsyncMock(return_value=covers)
        covers_helper = SimpleNamespace(verify_covers=AsyncMock(return_value=covers))
        engine = (None, MagicMock(return_value=app), None, None, helpers, covers_helper)
        checkpoints = []
        with patch.dict("sys.modules", {"tencent_cover_upload": SimpleNamespace(upload_tencent_covers=uploader)}), \
             patch.object(bridge, "verify_tencent_metadata", new=AsyncMock(return_value={"verified": True, "description": "原文案"})):
            result = asyncio.run(bridge.stage_tencent_video(page, payload, "http://127.0.0.1:9222", engine,
                                reuse_upload=True, checkpoint=lambda details: checkpoints.append(dict(details))))
        self.assertTrue(result["video"]["selected"]["resumed_without_reupload"])
        self.assertIn("video", checkpoints[0])
        self.assertEqual(checkpoints[0]["metadata"], {"verified": True, "description": "原文案"})
        app.upload_video_file.assert_not_awaited()
        app.prepare_video_for_publish.assert_not_awaited()
        uploader.assert_awaited_once()

    def test_tencent_resume_stops_before_cover_changes_when_video_or_metadata_differs(self):
        payload = {"title": "已经保存的短标题", "description": "原文案", "videoPath": "video.mp4",
                   "landscapePath": "4x3.png", "portraitPath": "3x4.png"}
        for failure in ("verify_existing_video", "verify_metadata"):
            with self.subTest(failure=failure):
                page = MagicMock()
                page.locator.return_value.first.wait_for = AsyncMock()
                helpers = SimpleNamespace(validate_stage=MagicMock(), declarations=AsyncMock(return_value={}),
                    verify_existing_video=AsyncMock(return_value={}), wait_for_video=AsyncMock(return_value={}),
                    verify_metadata=AsyncMock(return_value={}))
                getattr(helpers, failure).side_effect = RuntimeError("original content changed")
                uploader = AsyncMock()
                engine = (None, MagicMock(), None, None, helpers, MagicMock())
                with patch.dict("sys.modules", {"tencent_cover_upload": SimpleNamespace(upload_tencent_covers=uploader)}), \
                     patch.object(bridge, "verify_tencent_metadata", new=helpers.verify_metadata):
                    with self.assertRaisesRegex(RuntimeError, "original content changed"):
                        asyncio.run(bridge.stage_tencent_video(page, payload, "http://127.0.0.1:9222", engine, reuse_upload=True))
                uploader.assert_not_awaited()

    def test_article_editor_uses_the_actual_iframe_and_waits_for_attachment(self):
        frame = object()
        element = SimpleNamespace(content_frame=AsyncMock(side_effect=[None, frame]))
        page = SimpleNamespace(wait_for_function=AsyncMock(), evaluate_handle=AsyncMock(return_value=SimpleNamespace(as_element=lambda: element)))
        with patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            self.assertIs(asyncio.run(bridge.article_editor(page)), frame)
        self.assertEqual(element.content_frame.await_count, 2)

    def test_article_initialization_resume_cannot_replay_a_possible_material_write(self):
        payload = {"target": "baijiahao-article"}
        state = {"phase": "initializing", "protocolVersion": 3, "error": "iframe not attached"}
        self.assertTrue(bridge.can_resume_article_initialization(payload, state))
        self.assertTrue(bridge.can_resume_article_initialization(payload, {"phase": "uploading", "protocolVersion": 2, "error": "coroutine raised StopIteration"}))
        for key in ("details", "result", "saveAttemptedAt", "fileSelectionStartedAt"):
            with self.subTest(key=key):
                self.assertFalse(bridge.can_resume_article_initialization(payload, {**state, key: "present"}))
        self.assertFalse(bridge.can_resume_article_initialization(payload, {**state, "phase": "uploading"}))
        self.assertFalse(bridge.can_resume_article_initialization(payload, {"phase": "uploading", "protocolVersion": 2, "error": "other error"}))
        self.assertFalse(bridge.can_resume_article_initialization({"target": "baijiahao-video"}, state))

    def test_closed_article_editor_can_resume_only_before_any_material_write(self):
        for changed_files in (False, True):
            with self.subTest(changed_files=changed_files), tempfile.TemporaryDirectory() as directory:
                asset = Path(directory) / "cover.png"
                asset.write_bytes(b"original")
                payload = {"jobId": "same-job", "target": "baijiahao-article", "landscapePath": str(asset)}
                state = {"phase": "initializing", "protocolVersion": 3, "error": "配图不足",
                         "payloadDigest": bridge.payload_digest(payload), "files": bridge.local_files(payload),
                         "targetId": "closed-page", "documentToken": "old-document"}
                file = Path(directory) / "jobs" / "same-job" / "state.json"
                file.parent.mkdir(parents=True)
                bridge.write_state(file, state)
                if changed_files:
                    asset.write_bytes(b"changed")
                page = AsyncMock()
                page.url = bridge.EDITORS["baijiahao-article"]
                context = SimpleNamespace(pages=[], new_page=AsyncMock(return_value=page))
                browser = SimpleNamespace(contexts=[context])
                playwright = AsyncMock()
                playwright.chromium.connect_over_cdp.return_value = browser
                manager = AsyncMock()
                manager.__aenter__.return_value = playwright
                engine = (None, None, lambda: manager, None, None, None)
                request = {"config": {"stateRoot": directory, "baijiahao": "http://127.0.0.1:9225"}, "payload": payload}
                with patch.object(bridge, "load_engine", return_value=engine), \
                     patch.object(bridge, "page_id", new=AsyncMock(return_value="new-empty-page")), \
                     patch.object(bridge, "stage_article", new=AsyncMock(return_value={"engine": "article"})) as stage, \
                     patch.object(bridge, "save_draft", new=AsyncMock()) as save:
                    if changed_files:
                        with self.assertRaisesRegex(RuntimeError, "素材已变化"):
                            asyncio.run(bridge.upload(request, "resume"))
                        context.new_page.assert_not_awaited()
                        stage.assert_not_awaited()
                    else:
                        result = asyncio.run(bridge.upload(request, "resume"))
                        self.assertFalse(result["saved"])
                        self.assertEqual(result["targetId"], "new-empty-page")
                        context.new_page.assert_awaited_once()
                        stage.assert_awaited_once()
                        self.assertEqual(json.loads(file.read_text())["phase"], "staged")
                    save.assert_not_awaited()

    def test_article_image_recovery_never_reselects_files_and_accepts_background_previews(self):
        modal = MagicMock()
        modal.wait_for = AsyncMock()
        modal.count = AsyncMock(return_value=1)
        modal.inner_text = AsyncMock(return_value="本地图片 2张上传成功 取消 确认")
        modal.get_by_role.return_value.count = AsyncMock(return_value=1)
        modal.get_by_role.return_value.is_enabled = AsyncMock(return_value=True)
        page = SimpleNamespace(locator=MagicMock(return_value=modal))
        frame = MagicMock()
        frame.wait_for_function = AsyncMock()
        frame.locator.return_value.evaluate_all = AsyncMock(return_value=["https://a.bdstatic.com/1.jpg", "https://a.bdstatic.com/2.jpg"])
        button = SimpleNamespace(click=AsyncMock())
        images = [{"path": "one.jpg", "url": "original-1"}, {"path": "two.jpg", "url": "original-2"}]
        before_select = MagicMock()
        with patch.object(bridge, "article_editor", new=AsyncMock(return_value=frame)), \
                patch.object(bridge, "one_button", new=AsyncMock(return_value=button)), patch.object(bridge.Path, "read_bytes", return_value=b"image"):
            result = asyncio.run(bridge.article_images(page, images, self.cover_helpers(), before_select, reuse_upload=True))
        self.assertEqual(list(result), ["original-1", "original-2"])
        page.locator.assert_called_once_with('[role="dialog"]:visible')
        modal.locator.assert_not_called()
        before_select.assert_not_called()
        button.click.assert_awaited_once()

    def test_article_image_recovery_requires_an_unsaved_bound_material_checkpoint(self):
        payload = {"target": "baijiahao-article"}
        state = {"phase": "uploading", "fileSelectionStartedAt": 1}
        self.assertTrue(bridge.can_resume_article_images(payload, state))
        for key in ("details", "result", "saveAttemptedAt"):
            with self.subTest(key=key):
                self.assertFalse(bridge.can_resume_article_images(payload, {**state, key: "present"}))
        self.assertFalse(bridge.can_resume_article_images(payload, {**state, "phase": "staged"}))
        self.assertFalse(bridge.can_resume_article_images({"target": "tencent-video"}, state))

    def cover_helpers(self):
        import numpy as np
        pixels = np.zeros((64, 64, 3), dtype=np.uint8)
        slots = {kind: {"src": kind, "index": index, "image_inputs": [0]} for index, kind in enumerate(("landscape", "portrait"))}
        return SimpleNamespace(_READ_DIALOGS="dialogs", _SLOTS="slots", _file_digest=lambda _: "source-sha",
            _normalized_pixels=lambda _: pixels, _cover_slots=AsyncMock(return_value=slots),
            _cover_pixels=AsyncMock(return_value=pixels), _pixel_difference=lambda *args: {"mae": 0, "rmse": 0},
            _browser_digest=AsyncMock(return_value="source-sha"))

    def test_cover_dialog_classification_waits_for_lazy_preview_label(self):
        page = SimpleNamespace(evaluate=AsyncMock(side_effect=[
            [{"index": 0, "text": "封面截取 AI封面 确定"}],
            [{"index": 0, "text": "封面截取 横版封面预览 (16:9) 确定"}],
        ]), locator=MagicMock(return_value=SimpleNamespace(evaluate_all=AsyncMock(return_value=[0]))))
        with patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            result = asyncio.run(bridge.baijiahao_cover_dialogs(page, self.cover_helpers()))
        self.assertIn("横版封面预览", result[0]["text"])

    def test_matching_preview_without_source_sha_is_not_accepted_as_uploaded_cover(self):
        page = MagicMock()
        page.evaluate = AsyncMock(return_value=[])
        control = page.locator.return_value.nth.return_value.locator.return_value.nth.return_value
        control.set_input_files = AsyncMock(side_effect=RuntimeError("must select actual source"))
        with patch.object(bridge.Path, "read_bytes", return_value=b"image"), self.assertRaisesRegex(RuntimeError, "must select actual source"):
            asyncio.run(bridge.baijiahao_covers(page, {"landscapePath": "local", "portraitPath": "portrait"}, self.cover_helpers()))
        control.set_input_files.assert_awaited_once_with("local")

    def test_only_previously_source_verified_matching_covers_are_reused(self):
        page = MagicMock()
        page.evaluate = AsyncMock(return_value=[])
        verified = {kind: {"fingerprint": "source-sha", "source_sha256_verified": "source-sha"} for kind in ("landscape", "portrait")}
        with patch.object(bridge.Path, "read_bytes", return_value=b"image"):
            covers = asyncio.run(bridge.baijiahao_covers(page, {"landscapePath": "local", "portraitPath": "portrait"}, self.cover_helpers(), verified))
        page.locator.assert_not_called()
        self.assertEqual(covers["portrait"]["source_sha256_verified"], "source-sha")

    def test_portrait_crop_resumes_before_reusing_verified_landscape(self):
        page = MagicMock()
        clicked = False
        dialog = {"text": "竖版封面预览", "index": 0, "source_count": 1, "preview_count": 1,
                  "source": "source-blob", "preview": {"src": "crop", "width": 900, "height": 1200}}
        page.evaluate = AsyncMock(side_effect=lambda *args: [] if clicked else [dialog])
        button = MagicMock()
        button.count = AsyncMock(return_value=1)
        button.is_visible = AsyncMock(return_value=True)
        button.evaluate = AsyncMock(return_value=False)
        async def click():
            nonlocal clicked
            clicked = True
        button.click = AsyncMock(side_effect=click)
        page.locator.return_value.nth.return_value.get_by_role.return_value = button
        verified = {"landscape": {"fingerprint": "source-sha", "source_sha256_verified": "source-sha"}}
        checkpoints = []
        with patch.object(bridge.Path, "read_bytes", return_value=b"image"), patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            covers = asyncio.run(bridge.baijiahao_covers(page, {"landscapePath": "local", "portraitPath": "portrait"}, self.cover_helpers(), verified, checkpoints.append))
        button.click.assert_awaited_once()
        self.assertIn("portrait", checkpoints[0])
        self.assertNotIn("landscape", checkpoints[0])
        self.assertEqual(set(covers), {"layout", "portrait", "landscape"})


if __name__ == "__main__":
    unittest.main()
