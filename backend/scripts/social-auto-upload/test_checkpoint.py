import asyncio
import errno
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


spec = importlib.util.spec_from_file_location("checkpoint_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.asset = self.root / "asset.bin"
        self.asset.write_bytes(b"original material")
        self.payload = {"jobId": "58", "target": "baijiahao-video", "title": "标题", "description": "正文",
                        "videoPath": str(self.asset), "landscapePath": str(self.asset), "portraitPath": str(self.asset)}
        self.request = {"config": {"stateRoot": str(self.root / "state"), "baijiahao": "http://127.0.0.1:9225"},
                        "payload": self.payload}
        self.file = self.root / "state/jobs/58/state.json"

    def state(self, **changes):
        return {"phase": "uploading", "protocolVersion": 2, "targetId": "ABC123", "documentToken": "bound-document",
                "payloadDigest": bridge.payload_digest(self.payload), "files": bridge.local_files(self.payload), **changes}

    def result(self, saved=False):
        result = {"staged": True, "saved": saved, "published": False, "targetId": "ABC123",
                  "editorUrl": bridge.EDITORS[self.payload["target"]], "engine": "project-extension"}
        if saved:
            result["draftUrl"] = ("https://channels.weixin.qq.com/platform/post/draftListManager"
                                  if self.payload["target"] == "tencent-video" else
                                  "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123")
        return result

    def store(self, state):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        bridge.write_state(self.file, state)

    def checkpoint(self):
        before = self.file.read_bytes() if self.file.exists() else None
        with patch.object(bridge, "load_engine", side_effect=AssertionError("checkpoint cannot access a browser")), \
                patch.object(bridge, "write_state", side_effect=AssertionError("checkpoint cannot change job state")), \
                patch.object(bridge, "upload", side_effect=AssertionError("checkpoint cannot upload")):
            result = asyncio.run(bridge.locked_action(self.request, "checkpoint"))
        self.assertEqual(self.file.read_bytes() if self.file.exists() else None, before)
        self.assertIsInstance(result["phase"], str)
        self.assertIsInstance(result["message"], str)
        return result

    def test_new_job_recommends_upload_without_creating_job_state(self):
        self.assertEqual(self.checkpoint()["action"], "upload")
        self.assertFalse(self.file.parent.exists())

    def test_staged_and_saved_results_recommend_save_and_complete(self):
        for phase, saved, action in (("staged", False, "save"), ("saved", True, "complete")):
            with self.subTest(phase=phase):
                state = self.state(phase=phase, result=self.result(saved))
                if saved:
                    state["saveAttemptedAt"] = 1
                self.store(state)
                actual = self.checkpoint()
                self.assertEqual(actual["action"], action)
                self.assertEqual(actual["result"], state["result"])

    def test_save_intent_always_reconciles_instead_of_repeating_a_write(self):
        for phase in ("staged", "uploading", "save_requested"):
            with self.subTest(phase=phase):
                self.store(self.state(phase=phase, result=self.result(), saveAttemptedAt=1))
                self.assertEqual(self.checkpoint()["action"], "reconcile")

    def test_complete_and_reconcile_use_original_snapshot_without_reading_current_materials(self):
        for phase, expected in (("saved", "complete"), ("save_requested", "reconcile")):
            with self.subTest(phase=phase):
                self.store(self.state(phase=phase, result=self.result(phase == "saved"), saveAttemptedAt=1))
                with patch.object(bridge, "local_files", side_effect=AssertionError("current project files are irrelevant to this checkpoint")):
                    self.assertEqual(self.checkpoint()["action"], expected)

    def test_current_protocol_interruptions_resume_without_error_text(self):
        for target, protocol, phase, selecting in (
            ("baijiahao-video", 2, "opening", False), ("baijiahao-video", 2, "uploading", True),
            ("tencent-video", 2, "initializing", False), ("tencent-video", 2, "uploading", True),
            ("baijiahao-article", 3, "initializing", False), ("baijiahao-article", 3, "uploading", True),
        ):
            with self.subTest(target=target, phase=phase):
                self.payload["target"] = target
                state = self.state(phase=phase, protocolVersion=protocol)
                if selecting:
                    state["fileSelectionStartedAt"] = 1
                if phase == "opening":
                    state.pop("documentToken")
                self.store(state)
                self.assertEqual(self.checkpoint()["action"], "resume")

    def test_legacy_initialization_still_requires_the_known_error(self):
        for target, protocol, error in (
            ("tencent-video", None, "Expected a unique initialized WeChat editor"),
            ("baijiahao-article", 2, "coroutine raised StopIteration"),
        ):
            self.payload["target"] = target
            for actual_error, expected in ((error, "resume"), ("other error", "manual"), (None, "manual")):
                with self.subTest(target=target, error=actual_error):
                    self.store(self.state(protocolVersion=protocol, error=actual_error))
                    self.assertEqual(self.checkpoint()["action"], expected)

    def test_unknown_unbound_or_bad_result_states_require_manual_review(self):
        for changes in (
            {"phase": "unknown"}, {"protocolVersion": 999}, {"documentToken": None}, {"targetId": None},
            {"targetId": "not-a-cdp-target"}, {"details": "corrupt"}, {"details": {"engine": "unknown"}},
            {"phase": "opening"}, {"phase": "staged"},
            {"phase": "saved", "result": self.result(False)},
            {"phase": "staged", "result": {**self.result(), "published": True}},
            {"phase": "staged", "result": {**self.result(), "targetId": "DEAD"}},
            {"phase": "staged", "result": {**self.result(), "editorUrl": "https://example.com/editor"}},
            {"phase": "staged", "result": {**self.result(), "editorUrl": "https://user@baijiahao.baidu.com/editor"}},
        ):
            with self.subTest(changes=changes):
                self.store(self.state(**changes))
                self.assertEqual(self.checkpoint()["action"], "manual")

    def test_invalid_id_digest_and_changed_or_missing_files_do_not_recommend_writes(self):
        self.store(self.state())
        self.payload["jobId"] = "../58"
        self.assertEqual(self.checkpoint()["action"], "manual")
        self.payload["jobId"] = "58"
        self.payload["title"] = "changed"
        self.assertEqual(self.checkpoint()["action"], "manual")
        self.payload["title"] = "标题"
        self.asset.write_bytes(b"replaced material")
        self.assertEqual(self.checkpoint()["action"], "manual")
        self.asset.unlink()
        self.assertEqual(self.checkpoint()["action"], "manual")

    def test_malformed_or_symlinked_state_is_manual(self):
        self.file.parent.mkdir(parents=True)
        for content in ("invalid", "[]", "null", "{}"):
            with self.subTest(content=content):
                self.file.write_text(content)
                self.assertEqual(self.checkpoint()["action"], "manual")
        self.file.unlink()
        other = self.root / "other.json"
        other.write_text(json.dumps(self.state()))
        self.file.symlink_to(other)
        self.assertEqual(self.checkpoint()["action"], "manual")

    def test_checkpoint_returns_busy_when_runtime_lock_is_held(self):
        root = Path(self.request["config"]["stateRoot"])
        root.mkdir()
        with (root / "runtime.lock").open("a") as lock:
            bridge.fcntl.flock(lock, bridge.fcntl.LOCK_EX | bridge.fcntl.LOCK_NB)
            with patch.object(bridge, "local_files", side_effect=AssertionError("busy must not inspect files")):
                self.assertEqual(self.checkpoint()["action"], "busy")
        self.assertEqual(self.checkpoint()["action"], "upload")

    def test_checkpoint_exposes_last_persisted_progress(self):
        value = {"step": "covers", "message": "横版封面已完成"}
        self.store(self.state(progress=value))
        self.assertEqual(self.checkpoint()["progress"], value)

    def test_real_cli_checkpoint_without_platform_config_and_while_lock_is_held(self):
        request = {"config": {"stateRoot": self.request["config"]["stateRoot"]}, "payload": self.payload}
        def cli():
            result = subprocess.run([sys.executable, str(Path(bridge.__file__)), "checkpoint"],
                                    input=json.dumps(request), capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            lines = result.stdout.splitlines()
            self.assertEqual(len(lines), 1, result.stdout)
            self.assertTrue(lines[0].startswith("SAU_RESULT "), result.stdout)
            return json.loads(lines[0][11:])
        self.assertEqual(cli()["action"], "upload")
        with (Path(request["config"]["stateRoot"]) / "runtime.lock").open("a") as lock:
            bridge.fcntl.flock(lock, bridge.fcntl.LOCK_EX | bridge.fcntl.LOCK_NB)
            self.assertEqual(cli()["action"], "busy")
        self.store(self.state(phase="saved", result=self.result(True), saveAttemptedAt=1))
        self.asset.unlink()
        self.assertEqual(cli()["action"], "complete")
        self.file.write_text("corrupt")
        self.assertEqual(cli()["action"], "manual")

    def test_no_error_upload_resume_reuses_bound_page_and_never_saves_or_restarts_upload(self):
        for target, protocol in (("tencent-video", 2), ("baijiahao-article", 3)):
            with self.subTest(target=target):
                self.payload["target"] = target
                self.request["config"]["tencent"] = "http://127.0.0.1:9222"
                self.store(self.state(protocolVersion=protocol, fileSelectionStartedAt=1))
                self.assertEqual(self.checkpoint()["action"], "resume")
                page = AsyncMock()
                page.url = bridge.EDITORS[target]
                context = SimpleNamespace(pages=[page], new_page=AsyncMock(side_effect=AssertionError("must reuse page")))
                playwright = AsyncMock()
                playwright.chromium.connect_over_cdp.return_value = SimpleNamespace(contexts=[context])
                manager = AsyncMock()
                manager.__aenter__.return_value = playwright
                engine = (None, None, lambda: manager, None, None, None)
                engine_name = "social-auto-upload/tencent-local-stage" if target == "tencent-video" else "huobao/baijiahao-article-extension"
                stage = AsyncMock(return_value={"engine": engine_name})
                method = "stage_tencent_video" if target == "tencent-video" else "stage_article"
                with patch.object(bridge, "load_engine", return_value=engine), \
                        patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                        patch.object(bridge, "verify_document", new=AsyncMock()), \
                        patch.object(bridge, method, new=stage), \
                        patch.object(bridge, "save_draft", new=AsyncMock(side_effect=AssertionError("resume cannot save"))):
                    result = asyncio.run(bridge.locked_action(self.request, "resume"))
                self.assertIs(stage.await_args.args[5 if target == "tencent-video" else 4], True)
                self.assertFalse(result["saved"])
                self.assertEqual(result["targetId"], "ABC123")
                self.assertEqual(json.loads(self.file.read_text())["fileSelectionStartedAt"], 1)
                self.assertEqual(self.checkpoint()["action"], "save")

    def test_failed_video_retry_checkpoint_survives_interruption_without_changing_page_proof(self):
        self.payload["target"] = "tencent-video"
        self.request["config"]["tencent"] = "http://127.0.0.1:9222"
        self.store(self.state(protocolVersion=2, fileSelectionStartedAt=1))
        page = AsyncMock()
        page.url = bridge.EDITORS["tencent-video"]
        context = SimpleNamespace(pages=[page], new_page=AsyncMock(side_effect=AssertionError("must reuse page")))
        playwright = AsyncMock()
        playwright.chromium.connect_over_cdp.return_value = SimpleNamespace(contexts=[context])
        manager = AsyncMock()
        manager.__aenter__.return_value = playwright
        async def interrupted(*args, recovery_state, checkpoint_retry):
            self.assertEqual(recovery_state["documentToken"], "bound-document")
            checkpoint_retry({"attemptedAt": 123, "reason": "网络出错，请重新上传。"})
            persisted = json.loads(self.file.read_text())
            self.assertEqual(persisted["videoRetry"]["attemptedAt"], 123)
            self.assertEqual(persisted["fileSelectionStartedAt"], 1)
            raise RuntimeError("模拟重传中断")
        with patch.object(bridge, "load_engine", return_value=(None, None, lambda: manager, None, None, None)), \
                patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                patch.object(bridge, "verify_document", new=AsyncMock()), \
                patch.object(bridge, "stage_tencent_video", new=interrupted), \
                patch.object(bridge, "save_draft", new=AsyncMock(side_effect=AssertionError("resume cannot save"))):
            with self.assertRaisesRegex(RuntimeError, "模拟重传中断"):
                asyncio.run(bridge.locked_action(self.request, "resume"))
        persisted = json.loads(self.file.read_text())
        self.assertEqual(persisted["videoRetry"]["attemptedAt"], 123)
        self.assertEqual(persisted["targetId"], "ABC123")
        self.assertEqual(persisted["documentToken"], "bound-document")
        self.assertNotIn("saveAttemptedAt", persisted)

    def test_new_stage_records_intent_before_engine_or_browser_access(self):
        def engine():
            state = json.loads(self.file.read_text())
            self.assertEqual(state["phase"], "opening")
            self.assertEqual(state["protocolVersion"], 3)
            self.assertEqual(state["payloadDigest"], bridge.payload_digest(self.payload))
            self.assertEqual(state["files"], bridge.local_files(self.payload))
            raise RuntimeError("interrupted before connecting")
        with patch.object(bridge, "load_engine", side_effect=engine):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                asyncio.run(bridge.locked_action(self.request, "stage"))
        self.assertEqual(self.checkpoint()["action"], "resume")
        with patch.object(bridge, "load_engine", side_effect=AssertionError("must not upload twice")):
            with self.assertRaisesRegex(RuntimeError, "禁止重复上传"):
                asyncio.run(bridge.locked_action(self.request, "stage"))

    def test_baijiahao_untouched_initialization_requires_current_marker_protocol(self):
        for phase in ("initializing", "uploading"):
            state = self.state(phase=phase, protocolVersion=3)
            self.assertTrue(bridge.can_resume_baijiahao_initialization(self.payload, state))
            self.store(state)
            self.assertEqual(self.checkpoint()["action"], "resume")
            self.assertFalse(bridge.can_resume_baijiahao_initialization(self.payload, {**state, "protocolVersion": 2}))
            for marker in ("fileSelectionStartedAt", "details", "result", "saveAttemptedAt"):
                with self.subTest(phase=phase, marker=marker):
                    self.assertFalse(bridge.can_resume_baijiahao_initialization(self.payload, {**state, marker: 1}))

    def test_baijiahao_initialization_reuses_or_reopens_only_provably_untouched_editor(self):
        for protocol, selected, closed in ((3, False, False), (3, False, True),
                                           (2, False, False), (2, False, True),
                                           (3, True, False), (3, True, True)):
            with self.subTest(protocol=protocol, selected=selected, closed=closed):
                state = self.state(protocolVersion=protocol)
                if selected:
                    state["fileSelectionStartedAt"] = 1
                self.store(state)
                self.assertEqual(self.checkpoint()["action"], "resume")
                page = AsyncMock()
                page.url = bridge.EDITORS["baijiahao-video"]
                context = SimpleNamespace(pages=[] if closed else [page], new_page=AsyncMock(return_value=page))
                playwright = AsyncMock()
                playwright.chromium.connect_over_cdp.return_value = SimpleNamespace(contexts=[context])
                manager = AsyncMock()
                manager.__aenter__.return_value = playwright
                helpers = SimpleNamespace(verify_upload=AsyncMock(side_effect=RuntimeError("verify existing video only")))
                engine = (None, None, lambda: manager, helpers, None, None)
                async def stage(page, payload, endpoint, engine, checkpoint, before_select):
                    before_select()
                    persisted = json.loads(self.file.read_text())
                    self.assertEqual(persisted["protocolVersion"], 3)
                    self.assertTrue(persisted["fileSelectionStartedAt"])
                    return {"engine": "social-auto-upload/baijiahao-local-stage"}
                with patch.object(bridge, "load_engine", return_value=engine), \
                        patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                        patch.object(bridge, "verify_document", new=AsyncMock()), \
                        patch.object(bridge, "require_empty_baijiahao_video", new=AsyncMock(), create=True) as empty, \
                        patch.object(bridge, "stage_baijiahao_video", new=AsyncMock(side_effect=stage)) as fresh, \
                        patch.object(bridge, "save_draft", new=AsyncMock(side_effect=AssertionError("resume cannot save"))):
                    if protocol == 3 and not selected:
                        result = asyncio.run(bridge.locked_action(self.request, "resume"))
                        self.assertFalse(result["saved"])
                        fresh.assert_awaited_once()
                        helpers.verify_upload.assert_not_awaited()
                        self.assertEqual(context.new_page.await_count, int(closed))
                        if not closed:
                            empty.assert_awaited_once()
                    else:
                        with self.assertRaisesRegex(RuntimeError, "找不到|verify existing video only"):
                            asyncio.run(bridge.locked_action(self.request, "resume"))
                        fresh.assert_not_awaited()
                        context.new_page.assert_not_awaited()
                        self.assertEqual(helpers.verify_upload.await_count, int(not closed))

    def test_baijiahao_untouched_resume_rejects_manually_populated_editor(self):
        for selected, media, metadata in (
            (True, {"videos": []}, []),
            (False, {"videos": [{"src": "blob:manual"}]}, []),
            (False, {"videos": [], "progressing": True}, []),
            (False, {"videos": []}, [{"value": "手动填写的内容"}]),
        ):
            with self.subTest(selected=selected, media=media, metadata=metadata):
                page = MagicMock()
                page.locator.return_value.evaluate_all = AsyncMock(return_value=selected)
                page.evaluate = AsyncMock(side_effect=[media, metadata])
                helpers = SimpleNamespace(_READ_MEDIA="media", _READ_METADATA="metadata")
                with self.assertRaisesRegex(RuntimeError, "已有"):
                    asyncio.run(bridge.require_empty_baijiahao_video(page, helpers))

    def video_input_timeout(self):
        return 'Locator.wait_for: Timeout 60000ms exceeded.\nCall log:\n  - waiting for locator("input[type=\\"file\\"][accept*=\\"video\\"],input[type=\\"file\\"][accept*=\\"mp4\\"]").first\n'

    def test_blank_baijiahao_initializer_reloads_only_the_bound_empty_page_once(self):
        state = self.state(phase="initializing", protocolVersion=3, error=self.video_input_timeout())
        self.store(state)
        page = AsyncMock()
        page.url = bridge.EDITORS["baijiahao-video"]
        context = SimpleNamespace(pages=[page], new_page=AsyncMock(side_effect=AssertionError("must retain original page")))
        manager = AsyncMock()
        engine = (None, None, lambda: manager, None, None, None)
        async def reload(**kwargs):
            persisted = json.loads(self.file.read_text())
            self.assertTrue(persisted["initializationReloadAttemptedAt"])
            self.assertNotIn("fileSelectionStartedAt", persisted)
            self.assertNotIn("saveAttemptedAt", persisted)
        page.reload.side_effect = reload
        async def stage(_page, _payload, _endpoint, _engine, _checkpoint, before_select):
            self.assertEqual(page.reload.await_count, 1)
            persisted = json.loads(self.file.read_text())
            self.assertEqual(persisted["targetId"], "ABC123")
            self.assertNotEqual(persisted["documentToken"], "bound-document")
            before_select()
            return {"engine": "social-auto-upload/baijiahao-local-stage"}
        with patch.object(bridge, "load_engine", return_value=engine), \
                patch.object(bridge, "connect_upload_browser", new=AsyncMock(return_value=(SimpleNamespace(contexts=[context]), "endpoint", None))), \
                patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                patch.object(bridge, "verify_document", new=AsyncMock()) as binding, \
                patch.object(bridge, "require_empty_baijiahao_video", new=AsyncMock()) as empty, \
                patch.object(bridge, "stage_baijiahao_video", new=AsyncMock(side_effect=stage)) as fresh, \
                patch.object(bridge, "save_draft", new=AsyncMock(side_effect=AssertionError("resume cannot save"))):
            result = asyncio.run(bridge.locked_action(self.request, "resume"))
        self.assertFalse(result["saved"])
        fresh.assert_awaited_once()
        self.assertGreaterEqual(binding.await_count, 2)
        self.assertGreaterEqual(empty.await_count, 2)
        context.new_page.assert_not_awaited()
        self.assertEqual(self.checkpoint()["action"], "save")

    def test_blank_initializer_does_not_reload_after_selection_rebinding_or_prior_reload(self):
        for reason in ("selected", "binding", "populated", "reloaded", "changed_url"):
            with self.subTest(reason=reason):
                state = self.state(phase="initializing", protocolVersion=3, error=self.video_input_timeout())
                if reason == "selected":
                    state["fileSelectionStartedAt"] = 1
                if reason == "reloaded":
                    state["initializationReloadAttemptedAt"] = 1
                self.store(state)
                page = AsyncMock()
                page.url = bridge.EDITORS["baijiahao-video"] if reason != "changed_url" else "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123"
                with patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                        patch.object(bridge, "verify_document", new=AsyncMock(side_effect=RuntimeError("binding changed") if reason == "binding" else None)), \
                        patch.object(bridge, "require_empty_baijiahao_video", new=AsyncMock(side_effect=RuntimeError("populated") if reason == "populated" else None)):
                    with self.assertRaises(RuntimeError):
                        asyncio.run(bridge.reload_baijiahao_initialization(page, self.payload, state, self.file, None))
                page.reload.assert_not_awaited()
                if reason == "reloaded":
                    self.assertEqual(self.checkpoint()["action"], "manual")

    def test_blank_initializer_reload_interruption_becomes_manual_without_selecting_file(self):
        state = self.state(phase="initializing", protocolVersion=3, error=self.video_input_timeout())
        self.store(state)
        page = AsyncMock()
        page.url = bridge.EDITORS["baijiahao-video"]
        page.reload.side_effect = RuntimeError("interrupted reload")
        with patch.object(bridge, "page_id", new=AsyncMock(return_value="ABC123")), \
                patch.object(bridge, "verify_document", new=AsyncMock()), \
                patch.object(bridge, "require_empty_baijiahao_video", new=AsyncMock()):
            with self.assertRaisesRegex(RuntimeError, "interrupted reload"):
                asyncio.run(bridge.reload_baijiahao_initialization(page, self.payload, state, self.file, None))
        persisted = json.loads(self.file.read_text())
        self.assertNotIn("fileSelectionStartedAt", persisted)
        self.assertNotIn("saveAttemptedAt", persisted)
        self.assertEqual(self.checkpoint()["action"], "manual")

    def test_closed_blank_initializer_cannot_create_a_replacement_page(self):
        self.store(self.state(phase="initializing", protocolVersion=3, error=self.video_input_timeout()))
        context = SimpleNamespace(pages=[], new_page=AsyncMock(side_effect=AssertionError("must not replace page")))
        manager = AsyncMock()
        with patch.object(bridge, "load_engine", return_value=(None, None, lambda: manager, None, None, None)), \
                patch.object(bridge, "connect_upload_browser", new=AsyncMock(return_value=(SimpleNamespace(contexts=[context]), "endpoint", None))):
            with self.assertRaisesRegex(RuntimeError, "原编辑页已关闭"):
                asyncio.run(bridge.locked_action(self.request, "resume"))
        context.new_page.assert_not_awaited()

    def test_automatically_closed_blank_initializer_reopens_within_the_original_job(self):
        self.store(self.state(phase="initializing", protocolVersion=3, error=self.video_input_timeout(), editorClosedAt=123))
        page = AsyncMock()
        page.url = bridge.EDITORS["baijiahao-video"]
        context = SimpleNamespace(pages=[], new_page=AsyncMock(return_value=page))
        manager = AsyncMock()
        engine = (None, None, lambda: manager, None, None, None)

        async def stage(_page, _payload, _endpoint, _engine, _checkpoint, before_select):
            persisted = json.loads(self.file.read_text())
            self.assertEqual(persisted["targetId"], "DEF456")
            self.assertNotIn("fileSelectionStartedAt", persisted)
            self.assertNotIn("saveAttemptedAt", persisted)
            before_select()
            return {"engine": "social-auto-upload/baijiahao-local-stage"}

        with patch.object(bridge, "load_engine", return_value=engine), \
                patch.object(bridge, "connect_upload_browser", new=AsyncMock(return_value=(SimpleNamespace(contexts=[context]), "endpoint", None))), \
                patch.object(bridge, "page_id", new=AsyncMock(return_value="DEF456")), \
                patch.object(bridge, "install_video_storage_isolation", new=AsyncMock()) as isolate, \
                patch.object(bridge, "stage_baijiahao_video", new=AsyncMock(side_effect=stage)) as upload, \
                patch.object(bridge, "save_draft", new=AsyncMock(side_effect=AssertionError("resume cannot save"))):
            result = asyncio.run(bridge.locked_action(self.request, "resume"))
        self.assertFalse(result["saved"])
        self.assertEqual(result["targetId"], "DEF456")
        context.new_page.assert_awaited_once()
        isolate.assert_awaited_once_with(page, self.payload["jobId"])
        upload.assert_awaited_once()
        self.assertEqual(self.checkpoint()["action"], "save")

    def test_other_initialization_errors_cannot_enable_blank_page_reload(self):
        for error in ("arbitrary timeout", "Locator.wait_for: Timeout 60000ms exceeded. waiting for cover input", ""):
            with self.subTest(error=error):
                self.assertFalse(bridge.baijiahao_initialization_timed_out(self.payload, self.state(phase="initializing", protocolVersion=3, error=error)))

    def test_save_intent_is_durable_before_click_and_interruption_only_reconciles(self):
        state = self.state(phase="staged", result=self.result())
        self.store(state)
        page = MagicMock()
        page.locator.return_value.all_text_contents = AsyncMock(return_value=[])
        def interrupted_click():
            persisted = json.loads(self.file.read_text())
            self.assertTrue(persisted["saveAttemptedAt"])
            self.assertEqual(persisted["phase"], "save_requested")
            self.assertEqual(persisted["progress"]["step"], "save")
            raise RuntimeError("connection lost during click")
        button = SimpleNamespace(click=AsyncMock(side_effect=interrupted_click))
        with patch.object(bridge, "verify_staged", new=AsyncMock()), \
                patch.object(bridge, "one_button", new=AsyncMock(return_value=button)):
            with self.assertRaisesRegex(RuntimeError, "connection lost"):
                asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
            self.assertEqual(self.checkpoint()["action"], "reconcile")
            with self.assertRaisesRegex(RuntimeError, "禁止重复保存"):
                asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
        button.click.assert_awaited_once()

    def test_broken_progress_pipe_still_saves_exactly_once(self):
        epipe = OSError("parent output closed")
        epipe.errno = errno.EPIPE
        for error in (BrokenPipeError("parent output closed"), epipe):
            with self.subTest(error=type(error).__name__):
                state = self.state(phase="staged", result=self.result())
                self.store(state)
                page = MagicMock()
                page.url = bridge.EDITORS[self.payload["target"]]
                page.locator.return_value.all_text_contents = AsyncMock(side_effect=[[], ["草稿保存成功"]])
                button = SimpleNamespace(click=AsyncMock())
                steps = []

                def closed_output(text):
                    value = json.loads(text.partition(" ")[2])
                    steps.append(value["step"])
                    if value["step"] == "save":
                        persisted = json.loads(self.file.read_text())
                        self.assertEqual(persisted["phase"], "staged")
                        self.assertNotIn("saveAttemptedAt", persisted)
                        button.click.assert_not_awaited()
                    raise error

                async def verified_draft(_browser, _payload, current, file, _engine):
                    self.assertEqual(current["phase"], "save_requested")
                    self.assertFalse(current["result"]["saved"])
                    current["phase"] = "saved"
                    current["result"] = self.result(True)
                    bridge.checkpoint_progress(file, current, "complete", "草稿已核验")
                    return current["result"]

                with patch.object(bridge, "verify_staged", new=AsyncMock()), \
                        patch.object(bridge, "one_button", new=AsyncMock(return_value=button)), \
                        patch.object(bridge, "reconcile_saved_draft", new=verified_draft), \
                        patch.object(bridge.sys, "stdout") as output:
                    output.write.side_effect = closed_output
                    result = asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
                    repeated = asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
                self.assertTrue(result["saved"])
                self.assertFalse(result["published"])
                self.assertEqual(repeated, result)
                self.assertEqual(steps, ["save", "complete"])
                persisted = json.loads(self.file.read_text())
                self.assertTrue(persisted["saveAttemptedAt"])
                self.assertTrue(persisted["saveClickedAt"])
                self.assertEqual(self.checkpoint()["action"], "complete")
                button.click.assert_awaited_once()

    def test_non_pipe_progress_errors_leave_save_unattempted(self):
        for error in (OSError(errno.EIO, "output failed"), RuntimeError("output failed")):
            with self.subTest(error=type(error).__name__):
                state = self.state(phase="staged", result=self.result())
                self.store(state)
                page = MagicMock()
                page.locator.return_value.all_text_contents = AsyncMock(return_value=[])
                button = SimpleNamespace(click=AsyncMock())
                with patch.object(bridge, "verify_staged", new=AsyncMock()), \
                        patch.object(bridge, "one_button", new=AsyncMock(return_value=button)), \
                        patch.object(bridge.sys, "stdout") as output:
                    output.write.side_effect = error
                    with self.assertRaisesRegex(type(error), "output failed"):
                        asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
                self.assertNotIn("saveAttemptedAt", json.loads(self.file.read_text()))
                self.assertEqual(self.checkpoint()["action"], "save")
                button.click.assert_not_awaited()

    def test_state_write_pipe_error_is_not_swallowed_or_followed_by_save_click(self):
        write = bridge.write_state
        for failure_phase in ("staged", "save_requested"):
            with self.subTest(failure_phase=failure_phase):
                state = self.state(phase="staged", result=self.result())
                self.store(state)
                page = MagicMock()
                page.locator.return_value.all_text_contents = AsyncMock(return_value=[])
                button = SimpleNamespace(click=AsyncMock())

                def fail_state_write(file, current):
                    if current["phase"] == failure_phase:
                        raise BrokenPipeError(errno.EPIPE, "state write failed")
                    write(file, current)

                with patch.object(bridge, "verify_staged", new=AsyncMock()), \
                        patch.object(bridge, "one_button", new=AsyncMock(return_value=button)), \
                        patch.object(bridge, "write_state", side_effect=fail_state_write):
                    with self.assertRaisesRegex(BrokenPipeError, "state write failed"):
                        asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
                self.assertNotIn("saveAttemptedAt", json.loads(self.file.read_text()))
                self.assertEqual(self.checkpoint()["action"], "save")
                button.click.assert_not_awaited()

    def test_interruption_after_save_click_reconciles_and_blocks_resume_before_browser(self):
        state = self.state(phase="staged", result=self.result())
        self.store(state)
        page = MagicMock()
        page.locator.return_value.all_text_contents = AsyncMock(side_effect=[[], RuntimeError("lost after click")])
        button = SimpleNamespace(click=AsyncMock())
        with patch.object(bridge, "verify_staged", new=AsyncMock()), \
                patch.object(bridge, "one_button", new=AsyncMock(return_value=button)):
            with self.assertRaisesRegex(RuntimeError, "lost after click"):
                asyncio.run(bridge.save_draft(page, self.payload, state, self.file, ()))
        self.assertTrue(json.loads(self.file.read_text())["saveClickedAt"])
        self.assertEqual(self.checkpoint()["action"], "reconcile")
        with patch.object(bridge, "load_engine", side_effect=AssertionError("must not access browser")):
            with self.assertRaisesRegex(RuntimeError, "只能核对"):
                asyncio.run(bridge.locked_action(self.request, "resume"))
        button.click.assert_awaited_once()

    def test_detail_checkpoints_emit_structured_durable_progress(self):
        state = self.state()
        self.store(state)
        for details, step in (({"media": {"verified": True}}, "media"),
                              ({"metadata": {"verified": True}}, "metadata"),
                              ({"covers": {"landscape": {"verified": True}}}, "covers")):
            with self.subTest(step=step), patch.object(bridge, "emit") as emit:
                bridge.checkpoint_details(self.file, state, details)
                persisted = json.loads(self.file.read_text())
                self.assertEqual(persisted["details"], details)
                self.assertEqual(persisted["progress"]["step"], step)
                emit.assert_called_once_with("PROGRESS", persisted["progress"])


if __name__ == "__main__":
    unittest.main()
