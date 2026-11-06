import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import account_browser
import bridge


class StalePageConnectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_visible_connection_cleans_before_playwright_initializes_pages(self):
        cleanup = AsyncMock(return_value={"closedTargetIds": ["old-editor"]})
        browser = SimpleNamespace(contexts=[object()])

        async def connect(*args, **kwargs):
            cleanup.assert_awaited_once_with(config, "http://127.0.0.1:9225")
            return browser

        config = {"stateRoot": "/fixture/state"}
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(side_effect=connect)))
        with patch.object(bridge, "cleanup_stale_baijiahao_pages", cleanup), patch.object(bridge, "upload_locks") as locks:
            result = await bridge.connect_platform_browser(playwright, "http://127.0.0.1:9225", "baijiahao", config=config)
        self.assertIs(result, browser)
        locks.assert_called_once_with(config, ["browser:http://127.0.0.1:9225"])

    async def test_busy_upload_lock_prevents_any_page_cleanup(self):
        cleanup = AsyncMock()
        with patch.object(bridge, "cleanup_stale_baijiahao_pages", cleanup), \
                patch.object(bridge, "upload_locks", side_effect=bridge.UploadLockBusy("busy")):
            with self.assertRaises(bridge.UploadLockBusy):
                await bridge.connect_platform_browser(None, "http://127.0.0.1:9225", "baijiahao", config={})
        cleanup.assert_not_awaited()

    async def test_already_locked_upload_does_not_reacquire_its_browser_lock(self):
        browser = SimpleNamespace(contexts=[object()])
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        with patch.object(bridge, "cleanup_stale_baijiahao_pages", AsyncMock()) as cleanup, \
                patch.object(bridge, "upload_locks") as locks:
            await bridge.connect_platform_browser(playwright, "http://127.0.0.1:9225", "baijiahao",
                                                  config={}, cleanup_lock_held=True)
        cleanup.assert_awaited_once()
        locks.assert_not_called()

    async def test_tencent_connection_does_not_run_baijiahao_cleanup(self):
        browser = SimpleNamespace(contexts=[object()])
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        with patch.object(bridge, "cleanup_stale_baijiahao_pages", AsyncMock()) as cleanup:
            await bridge.connect_platform_browser(playwright, "http://127.0.0.1:9222", "tencent", config={})
        cleanup.assert_not_awaited()

    async def test_managed_connection_cleans_existing_profile_without_reimporting_login(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = {"stateRoot": temporary}
            storage = account_browser.history_storage_file(config, "baijiahao")
            storage.parent.mkdir(parents=True)
            storage.write_text(json.dumps({"cookies": [], "origins": []}))
            _, digest = account_browser.account_storage(config, "history_baijiahao")
            directory = account_browser.session_directory(config, "history_baijiahao", digest)
            profile = directory / "profile"
            profile.mkdir()
            (profile / "DevToolsActivePort").write_text("19999\n/devtools/browser/abc-123\n")
            account_browser.write_private(directory / "session.json", {
                "pid": 12345, "accountName": "history_baijiahao", "credentialDigest": digest, "initialized": True,
            })
            context = SimpleNamespace(pages=[], add_cookies=AsyncMock(), add_init_script=AsyncMock())
            browser = SimpleNamespace(contexts=[context])
            cleanup = AsyncMock(return_value={"closedTargetIds": ["old-editor"]})

            async def connect(*args, **kwargs):
                cleanup.assert_awaited_once_with(config, "http://127.0.0.1:19999", account_name="history_baijiahao")
                return browser

            playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(side_effect=connect)))
            with patch.object(account_browser, "alive", return_value=True), \
                    patch.object(account_browser, "endpoint_matches", return_value=True), \
                    patch.object(account_browser, "cleanup_stale_baijiahao_pages", cleanup, create=True):
                result = await account_browser.connect_account_browser(playwright, config, "history_baijiahao")
            self.assertIs(result[0], browser)
            context.add_cookies.assert_not_awaited()

    async def test_cleanup_subprocess_receives_only_endpoint_and_checkpoint_directory(self):
        process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b'{"closedTargetIds":["old"]}', b"")))
        spawn = AsyncMock(return_value=process)
        with patch.object(account_browser.asyncio, "create_subprocess_exec", spawn):
            result = await account_browser.cleanup_stale_baijiahao_pages(
                {"stateRoot": "/fixture/state", "privateCredential": "never-send"},
                "http://127.0.0.1:9225", account_name="history_baijiahao")
        self.assertEqual(result["closedTargetIds"], ["old"])
        request = json.loads(process.communicate.await_args.args[0])
        self.assertEqual(request, {"endpoint": "http://127.0.0.1:9225", "stateRoot": "/fixture/state",
                                  "platform": "baijiahao", "accountName": "history_baijiahao"})
        self.assertEqual(Path(spawn.await_args.args[1]).name, "stale_pages.mjs")

    async def test_cleanup_timeout_terminates_only_its_helper_process(self):
        kill = Mock()
        process = SimpleNamespace(returncode=None, communicate=AsyncMock(side_effect=TimeoutError), kill=kill, wait=AsyncMock())
        with patch.object(account_browser.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
            with self.assertRaises(account_browser.AccountBrowserConnectionError):
                await account_browser.cleanup_stale_baijiahao_pages({"stateRoot": "/fixture"}, "http://127.0.0.1:9225")
        kill.assert_called_once()
        process.wait.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
