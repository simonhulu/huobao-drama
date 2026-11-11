import asyncio
import json
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch
from types import SimpleNamespace

import account_browser
import bridge
from playwright.async_api import TimeoutError as PlaywrightTimeoutError


class ManagedConnectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_timeout_retries_same_browser_before_any_page_or_login_change(self):
        browser = SimpleNamespace(contexts=[object()])
        connect = AsyncMock(side_effect=[PlaywrightTimeoutError('connect_over_cdp: Timeout'), browser])
        pw = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
        result = await account_browser.connect_managed_cdp(pw, 'http://127.0.0.1:19999', '/devtools/browser/abc-123')
        self.assertIs(result, browser)
        self.assertEqual(connect.await_count, 2)
        self.assertEqual([c.args[0] for c in connect.await_args_list], ['ws://127.0.0.1:19999/devtools/browser/abc-123'] * 2)
        self.assertEqual([c.kwargs['timeout'] for c in connect.await_args_list], [40000, 10000])

    async def test_exhausted_connection_is_not_misreported_as_expired_login(self):
        connect = AsyncMock(side_effect=PlaywrightTimeoutError('connect_over_cdp: Timeout'))
        pw = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
        with self.assertRaises(RuntimeError) as failure:
            await account_browser.connect_managed_cdp(pw, 'http://127.0.0.1:19999', '/devtools/browser/abc-123')
        self.assertEqual(failure.exception.issue, 'connection_failed')
        self.assertNotIn('同步', str(failure.exception))
        self.assertIn('连接', str(failure.exception))
        self.assertEqual(connect.await_count, 2)


class StalePageCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def test_preserved_task_targets_reach_node_cleanup_input(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(
            b'{"closedTargetIds":[],"preservedCount":2}', b'')), kill=Mock(), wait=AsyncMock())
        with patch.object(account_browser.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            await account_browser.cleanup_stale_baijiahao_pages({'stateRoot': '/state'}, 'http://127.0.0.1:12345',
                account_name='first', preserve_target_ids=['STAGED', 'ORIGINAL'])
        self.assertEqual(json.loads(process.communicate.await_args.args[0]), {
            'endpoint': 'http://127.0.0.1:12345', 'stateRoot': '/state', 'platform': 'baijiahao',
            'accountName': 'first', 'preserveTargetIds': ['STAGED', 'ORIGINAL'],
        })
        process.kill.assert_not_called()

    async def test_checkpoint_failure_reports_fixed_stage_without_diagnostic_details(self):
        process = SimpleNamespace(returncode=1, communicate=AsyncMock(return_value=(b'',
            b'{"phase":"checkpoint_scan","message":"private checkpoint path"}')), kill=Mock(), wait=AsyncMock())
        with patch.object(account_browser.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaises(account_browser.AccountBrowserConnectionError) as failure:
                await account_browser.cleanup_stale_baijiahao_pages({'stateRoot': '/state'}, 'http://127.0.0.1:12345')
        self.assertIn('上传检查点读取', str(failure.exception))
        self.assertIn('原登录和上传检查点已保留', str(failure.exception))
        self.assertNotIn('private', str(failure.exception))
        process.kill.assert_not_called()

    async def test_timeout_kills_only_its_own_cleanup_process(self):
        process = SimpleNamespace(returncode=None, communicate=AsyncMock(side_effect=TimeoutError()),
                                  kill=Mock(), wait=AsyncMock())
        with patch.object(account_browser.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaisesRegex(account_browser.AccountBrowserConnectionError, '子进程响应超时'):
                await account_browser.cleanup_stale_baijiahao_pages({'stateRoot': '/state'}, 'http://127.0.0.1:12345')
        process.kill.assert_called_once_with()
        process.wait.assert_awaited_once_with()

    async def test_unstructured_stderr_does_not_leak_into_connection_error(self):
        process = SimpleNamespace(returncode=1, communicate=AsyncMock(return_value=(b'', b'private cookie path')),
                                  kill=Mock(), wait=AsyncMock())
        with patch.object(account_browser.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)):
            with self.assertRaises(account_browser.AccountBrowserConnectionError) as failure:
                await account_browser.cleanup_stale_baijiahao_pages({'stateRoot': '/state'}, 'http://127.0.0.1:12345')
        self.assertIn('清理结果校验', str(failure.exception))
        self.assertNotIn('private', str(failure.exception))


class BackgroundStartupTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cleanup = self.enterContext(patch.object(account_browser, "cleanup_stale_baijiahao_pages", AsyncMock()))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.config = {"root": str(root / "sau"), "stateRoot": str(root / "state")}
        self.account = "history_baijiahao"
        storage_file = account_browser.history_storage_file(self.config, "baijiahao")
        storage_file.parent.mkdir(parents=True)
        account_browser.write_private(storage_file, {"cookies": [{"name": "login", "value": "old-import"}], "origins": []})
        _, self.digest = account_browser.account_storage(self.config, self.account)
        self.directory = account_browser.session_directory(self.config, self.account, self.digest)
        self.profile = self.directory / "profile"
        (self.profile / "Default").mkdir(parents=True)
        self.login_file = self.profile / "Default" / "Cookies"
        self.login_file.write_bytes(b"refreshed profile login")
        self.state_file = self.directory / "session.json"
        account_browser.write_private(self.state_file, {
            "pid": 90, "accountName": self.account, "credentialDigest": self.digest, "initialized": True,
        })
        (self.profile / "DevToolsActivePort").write_text("19998\n/devtools/browser/AAA-123\n")
        executable = root / "chrome"
        executable.touch()
        self.context = SimpleNamespace(pages=[], cookies=AsyncMock(return_value=[{"name": "login", "value": "refreshed"}]),
                                       add_cookies=AsyncMock(), add_init_script=AsyncMock())
        self.browser = SimpleNamespace(contexts=[self.context])
        self.connect = AsyncMock(return_value=self.browser)
        self.playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=self.connect))
        self.exit_codes = []
        self.children = []
        self.ready_pid = None
        self.now = 0

        async def advance(seconds):
            self.now += seconds

        self.enterContext(patch.dict("sys.modules", {"conf": SimpleNamespace(LOCAL_CHROME_PATH=str(executable))}))
        self.process = self.enterContext(patch.object(account_browser.subprocess, "Popen", side_effect=self.launch))
        # An exited but unreaped child can still satisfy kill(pid, 0).
        self.enterContext(patch.object(account_browser, "alive", side_effect=lambda pid: pid in (101, 102)))
        self.enterContext(patch.object(account_browser, "endpoint_matches", return_value=True))
        self.enterContext(patch.object(account_browser, "time", SimpleNamespace(
            monotonic=lambda: self.now, time=lambda: 1700000000 + self.now)))
        self.enterContext(patch.object(account_browser.asyncio, "sleep", new=AsyncMock(side_effect=advance)))

    def launch(self, args, **kwargs):
        self.assertIn(f"--user-data-dir={self.profile}", args)
        self.assertEqual(self.login_file.read_bytes(), b"refreshed profile login")
        port_file = self.profile / "DevToolsActivePort"
        self.assertFalse(port_file.exists(), "each launch must discard the stale endpoint")
        index = len(self.children)
        child = SimpleNamespace(pid=101 + index, poll=Mock(return_value=self.exit_codes[index]))
        self.children.append(child)
        if child.pid == self.ready_pid:
            port_file.write_text("19999\n/devtools/browser/ABC-123\n")
        return child

    def assert_login_preserved(self):
        self.assertEqual(self.login_file.read_bytes(), b"refreshed profile login")
        state = json.loads(self.state_file.read_text())
        self.assertEqual(state["accountName"], self.account)
        self.assertEqual(state["credentialDigest"], self.digest)
        self.assertTrue(state["initialized"])
        self.context.add_cookies.assert_not_awaited()
        return state

    async def test_exited_first_process_retries_same_profile_and_connects_second(self):
        self.exit_codes = [7, None]
        self.ready_pid = 102
        result = await account_browser.connect_account_browser(self.playwright, self.config, self.account)
        self.assertEqual(result, (self.browser, "http://127.0.0.1:19999", self.digest))
        self.assertEqual(self.process.call_count, 2)
        self.children[0].poll.assert_called()
        self.connect.assert_awaited_once_with("ws://127.0.0.1:19999/devtools/browser/ABC-123", timeout=40000, is_local=True)
        state = self.assert_login_preserved()
        self.assertEqual(state["pid"], 102)
        self.assertNotIn("startupFailure", state)
        self.assertEqual(self.browser._huobao_managed_session["pid"], 102)

    async def test_two_exited_processes_fail_explicitly_without_third_launch(self):
        self.exit_codes = [7, 9]
        with self.assertRaisesRegex(RuntimeError, "后台浏览器启动失败：Chrome 退出（9）.*原登录资料已保留"):
            await account_browser.connect_account_browser(self.playwright, self.config, self.account)
        self.assertEqual(self.process.call_count, 2)
        self.connect.assert_not_awaited()
        state = self.assert_login_preserved()
        self.assertEqual(state["pid"], 102)
        self.assertEqual(state["startupFailure"]["message"], "Chrome 退出（9）")
        self.assertGreater(state["startupFailure"]["at"], 0)

    async def test_restarted_history_session_restores_snapshot_when_profile_cookies_are_empty(self):
        self.exit_codes = [None]
        self.ready_pid = 101
        self.context.cookies.return_value = []
        storage, _ = account_browser.account_storage(self.config, self.account)
        await account_browser.connect_account_browser(self.playwright, self.config, self.account)
        self.context.add_cookies.assert_awaited_once_with(storage["cookies"])
        self.assertEqual(self.login_file.read_bytes(), b"refreshed profile login")

    async def test_live_history_session_is_not_replaced_when_its_cookie_store_is_empty(self):
        self.context.cookies.return_value = []
        with patch.object(account_browser, "alive", return_value=True):
            await account_browser.connect_account_browser(self.playwright, self.config, self.account)
        self.process.assert_not_called()
        self.context.cookies.assert_not_awaited()
        self.context.add_cookies.assert_not_awaited()

    async def test_live_process_with_unready_port_times_out_without_second_launch(self):
        self.exit_codes = [None]
        with self.assertRaisesRegex(RuntimeError, "后台浏览器启动失败：Chrome 调试端口未就绪.*原登录资料已保留"):
            await account_browser.connect_account_browser(self.playwright, self.config, self.account)
        self.process.assert_called_once()
        self.children[0].poll.assert_called()
        self.connect.assert_not_awaited()
        self.assertGreaterEqual(self.now, 15)
        state = self.assert_login_preserved()
        self.assertEqual(state["pid"], 101)
        self.assertEqual(state["startupFailure"]["message"], "Chrome 调试端口未就绪")


class NamedAccountBrowserTest(unittest.TestCase):
    def setUp(self):
        self.cleanup = self.enterContext(patch.object(account_browser, "cleanup_stale_baijiahao_pages", AsyncMock()))
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = {"root": str(self.root / "sau"), "stateRoot": str(self.root / "state")}
        self.cookies = self.root / "sau/cookies"
        self.cookies.mkdir(parents=True)
        self.storage = {"cookies": [{"name": "fixture", "value": "test", "domain": ".baidu.com", "path": "/"}], "origins": []}
        self.save_account("first")
        self.save_account("second")

    def save_account(self, name):
        file = self.cookies / f"baijiahao_{name}.json"
        file.write_text(json.dumps(self.storage))
        return file

    def test_account_names_and_symlinks_cannot_select_other_cookie_files(self):
        for name in ("../first", "", "first/second", "x" * 81):
            with self.subTest(name=name), self.assertRaises(ValueError):
                account_browser.account_storage(self.config, name)
        self.save_account("first").unlink()
        (self.cookies / "baijiahao_first.json").symlink_to(self.cookies / "baijiahao_second.json")
        with self.assertRaises(ValueError):
            account_browser.account_storage(self.config, "first")

    def test_same_account_reuses_background_session_without_reapplying_cookies(self):
        executable = self.root / "chrome"
        executable.touch()
        browser = SimpleNamespace(contexts=[SimpleNamespace(pages=[], add_cookies=AsyncMock(), add_init_script=AsyncMock())])
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        running = set()
        launches = []
        def launch(args, **kwargs):
            self.assertIn("--headless=new", args)
            self.assertIn("--mute-audio", args)
            self.assertTrue(kwargs["start_new_session"])
            profile = Path(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--user-data-dir=")))
            pid = 100 + len(launches)
            port = 10000 + len(launches)
            (profile / "DevToolsActivePort").write_text(f"{port}\n/devtools/browser/ABC-123\n")
            launches.append(args)
            running.add(pid)
            return SimpleNamespace(pid=pid)
        async def scenario():
            first = await account_browser.connect_account_browser(playwright, self.config, "first")
            again = await account_browser.connect_account_browser(playwright, self.config, "first")
            other = await account_browser.connect_account_browser(playwright, self.config, "second")
            self.assertEqual(first[1:], again[1:])
            self.assertNotEqual(first[1], other[1])
        with patch.dict("sys.modules", {"conf": SimpleNamespace(LOCAL_CHROME_PATH=str(executable))}), \
             patch.object(account_browser.subprocess, "Popen", side_effect=launch), \
             patch.object(account_browser, "alive", side_effect=lambda pid: pid in running), \
             patch.object(account_browser, "endpoint_matches", return_value=True):
            asyncio.run(scenario())
        self.assertEqual(len(launches), 2, "one persistent Chrome per named account")
        self.assertEqual(browser.contexts[0].add_cookies.await_count, 2, "reconnecting must preserve live login state")
        self.assertEqual(playwright.chromium.connect_over_cdp.await_count, 3)

    def test_changed_login_blocks_old_checkpoint_before_starting_any_browser(self):
        with patch.object(account_browser.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(RuntimeError, "身份已变化"):
                asyncio.run(account_browser.connect_account_browser(None, self.config, "first", "old-digest"))
        launch.assert_not_called()

    def test_verified_history_candidate_reconnects_to_same_headless_profile_without_reimport(self):
        executable = self.root / "chrome"
        executable.touch()
        context = SimpleNamespace(pages=[], add_cookies=AsyncMock(), add_init_script=AsyncMock())
        browser = SimpleNamespace(contexts=[context])
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        running = set()
        def launch(args, **kwargs):
            self.assertIn("--headless=new", args)
            self.assertIn("--mute-audio", args)
            self.assertEqual(kwargs["umask"], 0o077, "Chrome-created private files must not inherit a public umask")
            profile = Path(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--user-data-dir=")))
            (profile / "DevToolsActivePort").write_text("19999\n/devtools/browser/ABC-123\n")
            running.add(100)
            return SimpleNamespace(pid=100)
        candidate = {**self.storage, "historySessionId": "new-generation"}
        async def scenario():
            first = await account_browser.connect_account_browser(playwright, self.config, "history_baijiahao", candidate_storage=candidate)
            file = account_browser.history_storage_file(self.config, "baijiahao")
            self.assertFalse(file.exists(), "candidate validation cannot switch the active account")
            file.parent.mkdir(mode=0o700)
            account_browser.write_private(file, candidate)
            again = await account_browser.connect_account_browser(playwright, self.config, "history_baijiahao", first[2])
            self.assertEqual(first, again)
            directory = account_browser.session_directory(self.config, "history_baijiahao", first[2])
            for path in (directory, directory.parent, directory.parent.parent, directory / "profile"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            for path in (directory / "session.json", directory / "session.lock", file):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with patch.dict("sys.modules", {"conf": SimpleNamespace(LOCAL_CHROME_PATH=str(executable))}), \
                patch.object(account_browser.subprocess, "Popen", side_effect=launch) as process, \
                patch.object(account_browser, "alive", side_effect=lambda pid: pid in running), \
                patch.object(account_browser, "endpoint_matches", return_value=True):
            asyncio.run(scenario())
        process.assert_called_once()
        context.add_cookies.assert_awaited_once_with(candidate["cookies"])
        self.assertEqual(sum(c.kwargs.get("script") != account_browser.SILENT_MEDIA_SCRIPT for c in context.add_init_script.await_args_list), 1)
        self.assertFalse((self.cookies / "baijiahao_history_baijiahao.json").exists())

    def test_named_payload_cannot_fall_back_to_shared_cdp(self):
        payload = {"target": "baijiahao-video", "accountName": "first"}
        with patch.object(bridge, "connect_account_browser", AsyncMock(return_value=("browser", "endpoint", "digest"))) as named, \
             patch.object(bridge, "connect_platform_browser", side_effect=AssertionError("shared browser must not be used")):
            self.assertEqual(asyncio.run(bridge.connect_upload_browser("playwright", self.config, payload, {"accountCredentialDigest": "old"})),
                             ("browser", "endpoint", "digest"))
            named.assert_awaited_once_with("playwright", self.config, "first", "old")

    def test_loaded_staged_targets_reach_original_named_session_cleanup(self):
        _, digest = account_browser.account_storage(self.config, 'first')
        directory = account_browser.session_directory(self.config, 'first', digest)
        profile = directory / 'profile'
        profile.mkdir()
        (profile / 'DevToolsActivePort').write_text('19999\n/devtools/browser/ABC-123\n')
        account_browser.write_private(directory / 'session.json', {
            'pid': 100, 'accountName': 'first', 'credentialDigest': digest, 'initialized': True,
        })
        context = SimpleNamespace(pages=[], add_cookies=AsyncMock(), add_init_script=AsyncMock())
        browser = SimpleNamespace(contexts=[context])
        connect = AsyncMock(return_value=browser)
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
        payload = {'target': 'baijiahao-video', 'accountName': 'first'}
        state = {'phase': 'staged', 'targetId': 'STAGED', 'accountCredentialDigest': digest,
                 'result': {'targetId': 'STAGED', 'saved': False, 'published': False},
                 'preservedEditor': {'targetId': 'ORIGINAL'}}
        before = json.dumps(state, sort_keys=True)
        with patch.object(account_browser, 'alive', return_value=True), \
                patch.object(account_browser, 'endpoint_matches', return_value=True), \
                patch.object(account_browser.subprocess, 'Popen') as launch, \
                patch.object(bridge, 'connect_platform_browser', side_effect=AssertionError('No shared browser')):
            result = asyncio.run(bridge.connect_upload_browser(playwright, self.config, payload, state))
        self.assertEqual(result, (browser, 'http://127.0.0.1:19999', digest))
        self.cleanup.assert_awaited_once_with(self.config, 'http://127.0.0.1:19999', account_name='first',
                                            preserve_target_ids=['STAGED', 'ORIGINAL'])
        connect.assert_awaited_once_with('ws://127.0.0.1:19999/devtools/browser/ABC-123', timeout=40000, is_local=True)
        launch.assert_not_called()
        context.add_cookies.assert_not_awaited()
        context.add_init_script.assert_not_awaited()
        self.assertEqual(json.dumps(state, sort_keys=True), before)

    def test_missing_or_unbound_state_keeps_original_named_connection_signature(self):
        payload = {'target': 'baijiahao-video', 'accountName': 'first'}
        for state in (None, {}, {'targetId': None, 'result': [], 'preservedEditor': {'targetId': ''}}):
            with self.subTest(state=state), patch.object(bridge, 'connect_account_browser',
                    AsyncMock(return_value=('browser', 'endpoint', 'digest'))) as named:
                asyncio.run(bridge.connect_upload_browser('pw', self.config, payload, state))
                named.assert_awaited_once_with('pw', self.config, 'first', None)

    def test_account_change_cannot_reuse_another_accounts_job_or_receipt(self):
        asset = self.root / "video.mp4"
        asset.write_bytes(b"fixture")
        payload = {"jobId": "job-1", "target": "baijiahao-video", "accountName": "first", "videoPath": str(asset)}
        request = {"config": self.config, "payload": payload}
        file = bridge.job_state_file(request)
        file.parent.mkdir(parents=True)
        state = {"phase": "uploading", "protocolVersion": 3, "payloadDigest": bridge.payload_digest(payload),
                 "files": bridge.local_files(payload), "targetId": "ABC", "documentToken": "token",
                 "accountCredentialDigest": account_browser.account_storage(self.config, "first")[1]}
        bridge.write_state(file, state)
        self.assertEqual(bridge.inspect_checkpoint(request)["action"], "resume")
        payload["accountName"] = "second"
        self.assertEqual(bridge.inspect_checkpoint(request)["action"], "manual")
        payload["accountName"] = "first"
        self.storage["cookies"][0]["value"] = "new-login"
        self.save_account("first")
        self.assertEqual(bridge.inspect_checkpoint(request)["action"], "manual")

    def test_saved_receipt_must_identify_the_same_account(self):
        payload = {"target": "baijiahao-video", "accountName": "first"}
        result = {"staged": True, "saved": True, "published": False, "targetId": "ABC", "engine": "fixture",
                  "editorUrl": "https://baijiahao.baidu.com/builder/rc/edit", "accountName": "second"}
        self.assertIsNone(bridge.checkpoint_result(payload, {"result": result}))
        result["accountName"] = "first"
        self.assertEqual(bridge.checkpoint_result(payload, {"result": result}), result)


if __name__ == "__main__":
    unittest.main()
