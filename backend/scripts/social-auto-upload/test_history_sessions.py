"""History login isolation and recovery; browser boundaries are simulated."""
import asyncio
import fcntl
import hashlib
import io
import json
import importlib
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import account_browser
import bridge
from playwright.async_api import TimeoutError as PlaywrightTimeoutError


class HistoryStorageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"root": str(self.root / "sau"), "stateRoot": str(self.root / "state"),
                       "baijiahao": "http://127.0.0.1:9225", "tencent": "http://127.0.0.1:9222"}

    def store(self, platform="baijiahao", value="history"):
        file = self.root / "state/history-sessions" / f"{platform}.json"
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({"cookies": [{"name": "fixture", "value": value,
                                               "domain": ".baidu.com" if platform == "baijiahao" else ".weixin.qq.com",
                                               "path": "/"}], "origins": []}))
        return file

    def test_reserved_names_read_only_history_storage_not_cba_cookies(self):
        cookies = self.root / "sau/cookies"
        cookies.mkdir(parents=True)
        for platform in ("baijiahao", "tencent"):
            with self.subTest(platform=platform):
                file = self.store(platform)
                (cookies / f"baijiahao_history_{platform}.json").write_text('{"cookies": [], "origins": []}')
                storage, digest = account_browser.account_storage(self.config, f"history_{platform}")
                self.assertEqual(storage["cookies"][0]["value"], "history")
                self.assertEqual(digest, hashlib.sha256(file.read_bytes()).hexdigest())
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(file.parent.stat().st_mode), 0o700)

    def test_missing_history_storage_requires_login_and_explicit_sync(self):
        with self.assertRaisesRegex(RuntimeError, "登录.*同步"):
            account_browser.account_storage(self.config, "history_tencent")

    def test_reserved_names_support_all_targets_and_reject_cross_platform_binding(self):
        for target in bridge.EDITORS:
            platform = "tencent" if target == "tencent-video" else "baijiahao"
            request = {"config": self.config, "payload": {"jobId": "history-1", "target": target,
                                                          "accountName": f"history_{platform}"}}
            with self.subTest(target=target):
                self.assertEqual(bridge.job_state_file(request).name, "state.json")
                request["payload"]["accountName"] = "history_baijiahao" if platform == "tencent" else "history_tencent"
                with self.assertRaises(ValueError):
                    bridge.job_state_file(request)

    def test_legacy_payload_stays_on_visible_cdp(self):
        for target in bridge.EDITORS:
            platform = "tencent" if target == "tencent-video" else "baijiahao"
            with patch.object(bridge, "connect_platform_browser", AsyncMock(return_value="legacy")) as visible, \
                    patch.object(bridge, "connect_account_browser", side_effect=AssertionError("cannot migrate old job")):
                result = asyncio.run(bridge.connect_upload_browser("pw", self.config, {"target": target}))
                self.assertEqual(result, ("legacy", self.config[platform], None))
                visible.assert_awaited_once_with("pw", self.config[platform], platform, config=self.config, cleanup_lock_held=True)

    def test_missing_history_credentials_make_checkpoint_manual(self):
        asset = self.root / "video.mp4"
        asset.write_bytes(b"fixture")
        payload = {"jobId": "history-1", "target": "baijiahao-video", "accountName": "history_baijiahao",
                   "videoPath": str(asset)}
        request = {"config": self.config, "payload": payload}
        file = bridge.job_state_file(request)
        file.parent.mkdir(parents=True)
        bridge.write_state(file, {"phase": "uploading", "protocolVersion": 3, "targetId": "ABC",
                                 "documentToken": "bound", "payloadDigest": bridge.payload_digest(payload),
                                 "files": bridge.local_files(payload), "accountCredentialDigest": "old"})
        result = bridge.inspect_checkpoint(request)
        self.assertEqual(result["action"], "manual")
        self.assertIn("同步", result["message"])

    def test_new_history_checkpoint_requires_its_own_login(self):
        asset = self.root / "video.mp4"
        asset.write_bytes(b"fixture")
        result = bridge.inspect_checkpoint({"config": self.config, "payload": {
            "jobId": "new", "target": "tencent-video", "accountName": "history_tencent", "videoPath": str(asset)}})
        self.assertEqual(result["action"], "manual")
        self.assertIn("同步", result["message"])

    def test_history_storage_rejects_symlinked_directory_or_file(self):
        file = self.store()
        outside = self.root / "outside.json"
        outside.write_bytes(file.read_bytes())
        file.unlink()
        file.symlink_to(outside)
        with self.assertRaises(ValueError):
            account_browser.account_storage(self.config, "history_baijiahao")
        file.unlink()
        file.parent.rmdir()
        file.parent.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            account_browser.account_storage(self.config, "history_baijiahao")


class HistorySessionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.sessions = importlib.import_module("history_sessions")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"root": str(self.root / "sau"), "stateRoot": str(self.root / "state"),
                       "baijiahao": "http://127.0.0.1:9225", "tencent": "http://127.0.0.1:9222"}
        self.storage = {"cookies": [dict(name=host, value="fixture", domain=host, path="/") for host in
                                  (".baidu.com", "baijiahao.baidu.com", "tieba.baidu.com", ".qq.com",
                                   ".weixin.qq.com", "channels.weixin.qq.com", "mail.qq.com", "evilbaidu.com")],
                        "origins": [{"origin": origin, "localStorage": [{"name": "token", "value": "fixture"}]} for origin in
                                    ("https://baijiahao.baidu.com", "https://channels.weixin.qq.com",
                                     "https://tieba.baidu.com", "https://mail.qq.com", "https://baijiahao.baidu.com.evil.test")]}
        self.visible_page = AsyncMock()
        self.visible_context = SimpleNamespace(storage_state=AsyncMock(return_value=self.storage),
                                               new_page=AsyncMock(), pages=[self.visible_page])
        self.visible = SimpleNamespace(contexts=[self.visible_context], close=AsyncMock())
        self.connect_visible = AsyncMock(return_value=self.visible)
        self.probe = AsyncMock()
        self.probe.url = "https://baijiahao.baidu.com/builder/rc/home"
        self.editor = AsyncMock()
        self.context = SimpleNamespace(new_page=AsyncMock(return_value=self.probe), pages=[self.editor])
        self.background = SimpleNamespace(contexts=[self.context], close=AsyncMock())
        self.named = AsyncMock(return_value=(self.background, "http://127.0.0.1:19999", "digest"))
        self.login = AsyncMock(return_value={"ready": True, "message": "已登录"})
        self.patch_named = patch.object(self.sessions, "connect_account_browser", self.named)
        self.patch_named.start()
        self.addCleanup(self.patch_named.stop)

    def file(self, platform="baijiahao"):
        return self.root / "state/history-sessions" / f"{platform}.json"

    def store(self, platform="baijiahao"):
        file = self.file(platform)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({"cookies": [], "origins": [], "old": True}))
        return file.read_bytes()

    async def inspect(self, platform="baijiahao"):
        return await self.sessions.inspect_platform("pw", self.config, platform,
                                                    connect_visible=self.connect_visible, login_state=self.login)

    async def sync(self, platform="baijiahao"):
        return await self.sessions.sync_platform("pw", self.config, platform,
                                                 connect_visible=self.connect_visible, login_state=self.login)

    def assert_visible_untouched(self):
        self.visible_context.new_page.assert_not_awaited()
        for operation in ("goto", "bring_to_front", "close"):
            getattr(self.visible_page, operation).assert_not_awaited()
            getattr(self.editor, operation).assert_not_awaited()
        self.visible.close.assert_not_awaited()
        self.background.close.assert_not_awaited()

    async def test_first_inspect_imports_only_platform_credentials_then_commits_after_validation(self):
        for platform, domains in (("baijiahao", {".baidu.com", "baijiahao.baidu.com"}),
                                  ("tencent", {".qq.com", ".weixin.qq.com", "channels.weixin.qq.com"})):
            async def verify(page, checked_platform):
                self.assertFalse(self.file(checked_platform).exists(), "credentials must not become active before verification")
                return {"ready": True, "message": "已登录"}
            self.login.side_effect = verify
            result = await self.inspect(platform)
            saved = json.loads(self.file(platform).read_text())
            self.assertEqual({cookie["domain"] for cookie in saved["cookies"]}, domains)
            self.assertEqual([item["origin"] for item in saved["origins"]],
                             ["https://channels.weixin.qq.com" if platform == "tencent" else "https://baijiahao.baidu.com"])
            self.assertTrue(result["ready"])
            self.assertEqual(result["sessionMode"], "background")
            self.assertEqual(result["accountName"], f"history_{platform}")
            self.assertEqual(self.named.call_args.kwargs["candidate_storage"], saved)
            self.assertEqual(stat.S_IMODE(self.file(platform).stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.file(platform).parent.stat().st_mode), 0o700)
        self.assert_visible_untouched()
        self.assertFalse((self.root / "sau").exists())

    async def test_existing_session_never_reads_or_reimports_visible_login(self):
        before = self.store()
        result = await self.inspect()
        self.assertTrue(result["ready"])
        self.assertEqual(self.file().read_bytes(), before)
        self.named.assert_awaited_once_with("pw", self.config, "history_baijiahao")
        self.connect_visible.assert_not_awaited()
        self.assert_visible_untouched()

    async def test_authenticated_baijiahao_list_avoids_loading_a_new_home_page(self):
        self.store()
        response = SimpleNamespace(status=200, text=AsyncMock(return_value=json.dumps(
            {"errno": 0, "data": {"list": [], "page": {"currentPage": 1}}})), dispose=AsyncMock())
        self.context.request = SimpleNamespace(get=AsyncMock(return_value=response))
        result = await self.inspect()
        self.assertTrue(result["ready"])
        self.context.request.get.assert_awaited_once_with(
            "https://baijiahao.baidu.com/pcui/article/lists?currentPage=1&pageSize=10&collection=",
            timeout=12000, max_redirects=0)
        response.dispose.assert_awaited_once()
        self.context.new_page.assert_not_awaited()
        self.login.assert_not_awaited()
        self.assert_visible_untouched()

    async def test_unconfirmed_list_responses_keep_the_existing_login_probe(self):
        self.store()
        for data in ({"errno": 0}, {"errno": False, "data": {"list": [], "page": {"currentPage": 1}}},
                     {"errno": 0, "data": {"list": [], "page": {"currentPage": True}}},
                     {"errno": 0, "data": {"list": [], "page": {"currentPage": 2}}}, "not-json"):
            with self.subTest(data=data):
                response = SimpleNamespace(status=200,
                    text=AsyncMock(return_value=data if isinstance(data, str) else json.dumps(data)), dispose=AsyncMock())
                self.context.request = SimpleNamespace(get=AsyncMock(return_value=response))
                self.context.new_page.reset_mock()
                result = await self.inspect()
                self.assertTrue(result["ready"])
                self.context.new_page.assert_awaited_once()
                response.dispose.assert_awaited_once()
        self.assert_visible_untouched()

    async def test_list_timeout_stays_within_the_existing_background_deadline(self):
        before = self.store()
        async def hang(*args, **kwargs):
            await asyncio.Event().wait()
        self.context.request = SimpleNamespace(get=AsyncMock(side_effect=hang))
        with patch.object(self.sessions, "BACKGROUND_CHECK_TIMEOUT", 0.01):
            result = await asyncio.wait_for(self.inspect(), 0.5)
        self.assertEqual(result["issue"], "connection_failed")
        self.assertEqual(self.file().read_bytes(), before)
        self.context.new_page.assert_not_awaited()
        self.assert_visible_untouched()

    async def test_background_connection_error_preserves_issue_and_active_credentials(self):
        before = self.store()
        self.named.side_effect = account_browser.AccountBrowserConnectionError('后台浏览器连接超时，请重试连接')
        result = await self.inspect()
        self.assertEqual(result['issue'], 'connection_failed')
        self.assertNotIn('同步', result['message'])
        self.assertEqual(self.file().read_bytes(), before)
        self.connect_visible.assert_not_awaited()
        self.assert_visible_untouched()

    async def test_browser_navigation_timeout_does_not_request_login_sync(self):
        before = self.store()
        self.probe.goto.side_effect = PlaywrightTimeoutError('Page.goto: Timeout 12000ms exceeded')
        result = await self.inspect()
        self.assertEqual(result['issue'], 'connection_failed')
        self.assertNotIn('同步', result['message'])
        self.assertEqual(self.file().read_bytes(), before)
        self.probe.close.assert_awaited_once()

    async def test_failed_bootstrap_rechecks_same_headless_candidate_without_reimport(self):
        self.login.return_value = {"ready": False, "issue": "login_required", "message": "登录失效"}
        self.assertFalse((await self.inspect())["ready"])
        first = self.named.await_args.kwargs["candidate_storage"]
        self.assertFalse(self.file().exists())
        with self.assertRaisesRegex(RuntimeError, "登录.*同步"):
            account_browser.account_storage(self.config, "history_baijiahao")
        self.login.return_value = {"ready": True, "message": "已登录"}
        self.assertTrue((await self.inspect())["ready"])
        self.connect_visible.assert_awaited_once()
        self.assertEqual(first, self.named.await_args.kwargs["candidate_storage"])
        self.assertEqual(json.loads(self.file().read_text()), first)
        self.assert_visible_untouched()

    async def test_corrupt_candidate_requires_explicit_sync_instead_of_silent_reimport(self):
        candidate = self.file().with_suffix(".candidate.json")
        candidate.parent.mkdir(parents=True)
        candidate.write_text("broken")
        result = await self.inspect()
        self.assertFalse(result["ready"])
        self.assertIn("同步", result["message"])
        self.connect_visible.assert_not_awaited()
        self.named.assert_not_awaited()
        self.assertTrue((await self.sync())["synced"])

    async def test_expired_background_requires_login_and_sync_without_visible_fallback(self):
        before = self.store()
        self.login.return_value = {"ready": False, "issue": "login_required", "message": "登录失效"}
        result = await self.inspect()
        self.assertFalse(result["ready"])
        self.assertEqual(result["issue"], "login_required")
        self.assertRegex(result["message"], "登录.*同步")
        self.assertEqual(self.file().read_bytes(), before)
        self.connect_visible.assert_not_awaited()

    async def test_failed_sync_keeps_old_login_bytes_and_never_touches_its_editor(self):
        before = self.store()
        self.login.return_value = {"ready": False, "issue": "verification_required", "message": "需要人工验证"}
        with self.assertRaisesRegex(RuntimeError, "验证.*同步"):
            await self.sync()
        self.assertEqual(self.file().read_bytes(), before)
        self.assert_visible_untouched()

    async def test_sync_uses_new_generation_even_when_visible_cookies_are_unchanged(self):
        result = await self.sync()
        before = self.file().read_bytes()
        self.assertEqual(result["synced"], True)
        self.assertEqual(result["platform"], "baijiahao")
        await self.sync()
        self.assertNotEqual(self.file().read_bytes(), before)
        self.assertEqual(self.named.await_count, 2)
        self.assert_visible_untouched()

    async def test_sync_blocks_its_account_and_visible_browser_but_allows_other_accounts(self):
        self.store()
        async def verify(page, platform):
            with patch.object(bridge, "upload", AsyncMock()) as upload:
                for account in ("history_baijiahao", None):
                    payload = {"jobId": "same-login", "target": "baijiahao-video"}
                    if account:
                        payload["accountName"] = account
                    with self.assertRaisesRegex(RuntimeError, "正在运行"):
                        await bridge.locked_action({"config": self.config, "payload": payload}, "stage")
                    upload.assert_not_awaited()
                for account, target in (("cba_first", "baijiahao-video"), ("history_tencent", "tencent-video")):
                    await bridge.locked_action({"config": self.config,
                                                "payload": {"jobId": account.replace("_", "-"), "target": target, "accountName": account}}, "stage")
                self.assertEqual(upload.await_count, 2)
            return {"ready": True, "message": "已登录"}
        self.login.side_effect = verify
        await self.sync()
        lock = self.root / "state/runtime.lock"
        self.assertEqual(stat.S_IMODE(lock.stat().st_mode), 0o600)

    async def test_upload_blocks_sync_only_for_its_own_account(self):
        self.store()
        entered, release = asyncio.Event(), asyncio.Event()

        async def upload(*_):
            entered.set()
            await release.wait()

        request = {"config": self.config, "payload": {"jobId": "active-upload", "target": "baijiahao-video",
                                                      "accountName": "history_baijiahao"}}
        with patch.object(bridge, "upload", side_effect=upload):
            task = asyncio.create_task(bridge.locked_action(request, "stage"))
            await asyncio.wait_for(entered.wait(), 2)
            try:
                with self.assertRaisesRegex(RuntimeError, "正在运行"):
                    await self.sync()
                self.connect_visible.assert_not_awaited()
                self.named.assert_not_awaited()
            finally:
                release.set()
                await task
        self.assertTrue((await self.sync())["synced"])

    async def test_busy_runtime_prevents_sync_before_reading_visible_credentials(self):
        self.store()
        with (self.root / "state/runtime.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, "正在运行"):
                await self.sync()
        self.connect_visible.assert_not_awaited()
        self.named.assert_not_awaited()

    async def test_cancelled_sync_preserves_previous_login_and_releases_lock(self):
        before = self.store()
        entered = asyncio.Event()
        async def hang(page, platform):
            entered.set()
            await asyncio.Event().wait()
        self.login.side_effect = hang
        task = asyncio.create_task(self.sync())
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.file().read_bytes(), before)
        self.login.side_effect = None
        self.assertTrue((await self.sync())["synced"])

    async def test_visible_connection_failure_does_not_launch_login_or_persist_credentials(self):
        self.connect_visible.side_effect = bridge.BrowserConnectionError("专用浏览器未启动", "browser_unavailable")
        result = await self.inspect()
        self.assertEqual(result["issue"], "browser_unavailable")
        self.assertRegex(result["message"], "登录.*同步")
        self.assertFalse(self.file().exists())
        self.named.assert_not_awaited()
        self.assert_visible_untouched()

    async def test_stalled_visible_editor_uses_bounded_readonly_storage_fallback(self):
        self.connect_visible.side_effect = PlaywrightTimeoutError("connect_over_cdp: Timeout exceeded")
        with patch.object(self.sessions, "read_visible_storage_snapshot", AsyncMock(return_value=self.storage)) as snapshot:
            result = await self.sync()
        self.assertTrue(result["synced"])
        snapshot.assert_awaited_once_with(self.config["baijiahao"], "baijiahao")
        self.assertEqual(len(json.loads(self.file().read_text())["cookies"]), 2)
        self.assert_visible_untouched()

    async def test_failed_visible_fallback_does_not_replace_active_login(self):
        before = self.store()
        self.connect_visible.side_effect = PlaywrightTimeoutError("connect_over_cdp: Timeout exceeded")
        with patch.object(self.sessions, "read_visible_storage_snapshot", AsyncMock(side_effect=RuntimeError("snapshot timeout"))):
            with self.assertRaisesRegex(RuntimeError, "无法读取"):
                await self.sync()
        self.assertEqual(self.file().read_bytes(), before)
        self.named.assert_not_awaited()
        self.assert_visible_untouched()

    async def test_expired_history_upload_reports_login_and_sync_without_opening_visible_browser(self):
        self.store()
        self.login.return_value = {"ready": False, "issue": "login_required", "message": "登录失效"}
        with patch.object(bridge, "connect_account_browser", self.named), \
                patch.object(bridge, "login_state", self.login), \
                patch.object(bridge, "connect_platform_browser", side_effect=AssertionError("no visible fallback")):
            with self.assertRaisesRegex(RuntimeError, "登录.*同步"):
                await bridge.connect_upload_browser("pw", self.config,
                    {"target": "baijiahao-video", "accountName": "history_baijiahao"})
        self.assert_visible_untouched()

    async def test_background_probe_waits_through_initial_blank_app_loading(self):
        self.store()
        self.login.side_effect = ([{"ready": False, "issue": "check_failed", "message": "页面未就绪"}] * 10
                                 + [{"ready": True, "message": "已登录"}])
        with patch.object(self.sessions.asyncio, "sleep", AsyncMock()):
            result = await self.inspect()
        self.assertTrue(result["ready"])
        self.assertEqual(self.login.await_count, 11)
        self.assert_visible_untouched()

    async def test_background_probe_deadline_closes_only_its_probe_and_releases_lock(self):
        before = self.store()
        async def hang(page, platform):
            await asyncio.Event().wait()
        self.login.side_effect = hang
        with patch.object(self.sessions, "BACKGROUND_CHECK_TIMEOUT", 0.01):
            result = await asyncio.wait_for(self.inspect(), 0.5)
        self.assertEqual(result["issue"], "connection_failed")
        self.assertFalse(result["ready"])
        self.assertEqual(self.file().read_bytes(), before)
        self.probe.close.assert_awaited_once()
        self.assert_visible_untouched()
        self.login.side_effect = None
        self.assertTrue((await self.inspect())["ready"])

    async def test_platform_bootstraps_run_concurrently_without_importing_twice(self):
        entered = set()
        both = asyncio.Event()
        async def verify(page, platform):
            entered.add(platform)
            if len(entered) == 2:
                both.set()
            await both.wait()
            return {"ready": True, "message": "已登录"}
        self.login.side_effect = verify
        states = await asyncio.wait_for(asyncio.gather(self.inspect("baijiahao"), self.inspect("tencent")), 1)
        self.assertTrue(all(state["ready"] for state in states))
        self.assertEqual(self.connect_visible.await_count, 2)
        self.connect_visible.reset_mock()
        await asyncio.gather(self.inspect("baijiahao"), self.inspect("tencent"))
        self.connect_visible.assert_not_awaited()


class HistoryUploadTest(unittest.IsolatedAsyncioTestCase):
    async def test_three_named_targets_keep_persistent_editor_and_checkpoint_identity(self):
        for target in bridge.EDITORS:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                platform = "tencent" if target == "tencent-video" else "baijiahao"
                config = {"stateRoot": str(root / "state"), "root": str(root / "sau")}
                credentials = account_browser.history_storage_file(config, platform)
                credentials.parent.mkdir(parents=True)
                account_browser.write_private(credentials, {"cookies": [], "origins": []})
                digest = account_browser.account_storage(config, f"history_{platform}")[1]
                asset = root / "asset"
                asset.write_bytes(b"source")
                payload = {"jobId": "new", "target": target, "accountName": f"history_{platform}",
                           "title": "标题", "description": "正文", "videoPath": str(asset)}
                page = AsyncMock()
                page.url = bridge.EDITORS[target]
                context = SimpleNamespace(new_page=AsyncMock(return_value=page), pages=[page])
                browser = SimpleNamespace(contexts=[context], close=AsyncMock())
                manager = MagicMock()
                manager.__aenter__ = AsyncMock(return_value="pw")
                app = SimpleNamespace(open_upload_page=AsyncMock())
                engine = (None, MagicMock(return_value=app), lambda: manager, None, None, None)
                details = {"engine": {"baijiahao-video": "social-auto-upload/baijiahao-local-stage",
                                      "baijiahao-article": "huobao/baijiahao-article-extension",
                                      "tencent-video": "social-auto-upload/tencent-local-stage"}[target]}
                request = {"config": config, "payload": payload}
                with patch.object(bridge, "load_engine", return_value=engine), \
                        patch.object(bridge, "connect_account_browser", AsyncMock(return_value=(browser, "headless", digest))) as connect, \
                        patch.object(bridge.history_sessions, "check_background_login", AsyncMock()), \
                        patch.object(bridge, "page_id", AsyncMock(return_value="ABCD")), \
                        patch.object(bridge, "stage_baijiahao_video", AsyncMock(return_value=details)), \
                        patch.object(bridge, "stage_tencent_video", AsyncMock(return_value=details)), \
                        patch.object(bridge, "stage_article", AsyncMock(return_value=details)), \
                        patch.object(bridge, "save_draft", AsyncMock()) as save:
                    result = await bridge.locked_action(request, "stage")
                    self.assertEqual(result["accountName"], f"history_{platform}")
                    self.assertFalse(result["saved"])
                    connect.assert_awaited_once_with("pw", config, f"history_{platform}", None)
                    state = json.loads(bridge.job_state_file(request).read_text())
                    self.assertEqual(state["accountCredentialDigest"], digest)
                    self.assertEqual(bridge.inspect_checkpoint(request)["action"], "save")
                    self.assertEqual(await bridge.locked_action(request, "stage"), result, "stage retry cannot upload twice")
                    save.return_value = {**result, "saved": True}
                    await bridge.locked_action({**request, "confirmSave": True}, "save")
                    self.assertEqual(save.await_args.args[0], page, "save must use the same persistent editor")
                    self.assertEqual(connect.await_args.args[-1], digest)
                    page.bring_to_front.assert_not_awaited()
                    page.close.assert_not_awaited()
                    browser.close.assert_not_awaited()
                    account_browser.write_private(credentials, {"cookies": [], "origins": [], "newGeneration": True})
                    self.assertEqual(bridge.inspect_checkpoint(request)["action"], "manual")


class HistoryRuntimeTest(unittest.IsolatedAsyncioTestCase):
    def engine(self):
        manager = MagicMock()
        manager.start = AsyncMock(return_value=SimpleNamespace(stop=AsyncMock()))
        return (None, None, lambda: manager, None, None, None)

    async def test_tencent_home_requires_authenticated_account_identity_not_product_title(self):
        page = MagicMock()
        page.url = "https://channels.weixin.qq.com/platform"
        page.locator.return_value.all_inner_texts = AsyncMock(return_value=["视频号 · 助手\n账号名称\n视频号ID:\nfixture-id\n视频181\n关注者477"])
        page.locator.return_value.count = AsyncMock(return_value=0)
        self.assertTrue((await bridge.login_state(page, "tencent"))["ready"])
        page.locator.return_value.all_inner_texts.return_value = ["视频号 · 助手"]
        self.assertFalse((await bridge.login_state(page, "tencent"))["ready"])
        page.locator.return_value.all_inner_texts.return_value = ["视频号ID: fixture-id\n微信扫码登录"]
        self.assertEqual((await bridge.login_state(page, "tencent"))["issue"], "login_required")

    async def test_platforms_are_independent_and_bounded_with_background_contract(self):
        sessions = importlib.import_module("history_sessions")
        async def inspect(pw, config, platform, **kwargs):
            if platform == "tencent":
                await asyncio.Event().wait()
            return {"ready": True, "message": "已登录", "accountName": "history_baijiahao", "sessionMode": "background"}
        with patch.object(bridge, "load_engine", return_value=self.engine()), \
                patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(stdout="test")), \
                patch.object(bridge, "HISTORY_PLATFORM_TIMEOUT", 0.02), \
                patch.object(sessions, "inspect_platform", side_effect=inspect):
            result = await asyncio.wait_for(bridge.inspect_history({"root": "/unused"}), 0.5)
        self.assertTrue(result["installed"])
        self.assertEqual(result["execution"], "background")
        self.assertTrue(result["platforms"]["baijiahao"]["ready"])
        failed = result["platforms"]["tencent"]
        self.assertFalse(failed["ready"])
        self.assertEqual(failed["sessionMode"], "background")
        self.assertEqual(failed["accountName"], "history_tencent")
        self.assertEqual(failed["issue"], "connection_failed")

    async def test_cli_history_focus_never_claims_to_open_a_window(self):
        request = {"config": {}, "payload": {"target": "tencent-video", "accountName": "history_tencent"}}
        with patch.object(bridge.sys, "argv", ["bridge.py", "focus"]), \
                patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request))), \
                patch.object(bridge, "load_engine", side_effect=AssertionError("no browser access")):
            with self.assertRaisesRegex(ValueError, "后台.*草稿链接"):
                await bridge.main()

    async def test_sync_failure_is_actionable_and_does_not_expose_transport_details(self):
        with patch.object(bridge, "load_engine", return_value=self.engine()), \
                patch.object(bridge.history_sessions, "sync_platform", AsyncMock(side_effect=Exception("private transport detail"))):
            with self.assertRaisesRegex(RuntimeError, "旧登录未替换.*同步") as failure:
                await bridge.sync_history({}, "tencent")
        self.assertNotIn("private transport", str(failure.exception))

    async def test_sync_timeout_is_bounded_and_driver_failure_does_not_mask_result(self):
        engine = self.engine()
        engine[2]().start.return_value.stop.side_effect = RuntimeError("driver disconnected")
        async def hang(*args, **kwargs):
            await asyncio.Event().wait()
        with patch.object(bridge, "load_engine", return_value=engine), \
                patch.object(bridge, "HISTORY_SYNC_TIMEOUT", 0.01), \
                patch.object(bridge.history_sessions, "sync_platform", side_effect=hang):
            with self.assertRaisesRegex(RuntimeError, "超时.*旧登录未替换"):
                await asyncio.wait_for(bridge.sync_history({}, "baijiahao"), 0.5)

    async def test_explicit_sync_can_finish_after_the_passive_inspection_budget(self):
        result = {"synced": True, "platform": "baijiahao", "message": "已验证"}
        async def sync(*args, **kwargs):
            await asyncio.sleep(0.02)
            return result
        with patch.object(bridge, "load_engine", return_value=self.engine()), \
                patch.object(bridge, "HISTORY_PLATFORM_TIMEOUT", 0.01), \
                patch.object(bridge, "HISTORY_SYNC_TIMEOUT", 0.1), \
                patch.object(bridge.history_sessions, "sync_platform", side_effect=sync):
            self.assertEqual(await bridge.sync_history({}, "baijiahao"), result)

    async def test_cli_dispatches_new_actions_and_keeps_wire_contract(self):
        for action, function, request, result in (
                ("inspect-history", "inspect_history", {"config": {}}, {"execution": "background"}),
                ("sync-history", "sync_history", {"config": {}, "platform": "tencent"},
                 {"synced": True, "platform": "tencent", "message": "已验证"})):
            with self.subTest(action=action), patch.object(bridge.sys, "argv", ["bridge.py", action]), \
                    patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(request))), \
                    patch.object(bridge, function, AsyncMock(return_value=result)) as handler, \
                    patch.object(bridge, "emit") as emit:
                await bridge.main()
                emit.assert_called_once_with("RESULT", result)
                self.assertEqual(handler.await_count, 1)


if __name__ == "__main__":
    unittest.main()
