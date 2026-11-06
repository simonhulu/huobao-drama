import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import account_browser


class NamedAccountCleanupTest(unittest.IsolatedAsyncioTestCase):
    accounts = (
        "cba_" + "1" * 32,
        "science_" + "2" * 32,
        "mystery_" + "3" * 32,
        "history_baijiahao",
        "history_tencent",
    )

    def account_fixture(self, root, name):
        config = {"root": str(root / "sau"), "stateRoot": str(root / "state")}
        platform = account_browser.HISTORY_ACCOUNTS.get(name)
        storage = (account_browser.history_storage_file(config, platform) if platform else
                   root / "sau" / "cookies" / f"baijiahao_{name}.json")
        storage.parent.mkdir(parents=True, exist_ok=True)
        storage.write_text(json.dumps({"cookies": [], "origins": []}))
        _, digest = account_browser.account_storage(config, name)
        directory = account_browser.session_directory(config, name, digest)
        profile = directory / "profile"
        profile.mkdir()
        (profile / "DevToolsActivePort").write_text("19999\n/devtools/browser/abc-123\n")
        account_browser.write_private(directory / "session.json", {
            "pid": 12345, "accountName": name, "credentialDigest": digest, "initialized": True,
        })
        context = SimpleNamespace(pages=[], add_cookies=AsyncMock(), add_init_script=AsyncMock())
        browser = SimpleNamespace(contexts=[context])
        return config, digest, directory, browser

    async def assert_cleanup_before_connection(self, existing):
        for name in self.accounts:
            with self.subTest(account=name), tempfile.TemporaryDirectory() as temporary:
                config, digest, directory, browser = self.account_fixture(Path(temporary), name)
                cleanup = AsyncMock(return_value={
                    "closedTargetIds": ["completed-editor"], "preservedCount": 2,
                })

                async def connect(*args, **kwargs):
                    if name == "history_tencent":
                        cleanup.assert_not_awaited()
                    else:
                        cleanup.assert_awaited_once_with(
                            config, "http://127.0.0.1:19999", account_name=name)
                    self.assertEqual(args, ("ws://127.0.0.1:19999/devtools/browser/abc-123",))
                    return browser

                playwright = SimpleNamespace(chromium=SimpleNamespace(
                    connect_over_cdp=AsyncMock(side_effect=connect)))
                with patch.object(account_browser, "alive", return_value=True), \
                        patch.object(account_browser, "endpoint_matches", return_value=True), \
                        patch.object(account_browser, "cleanup_stale_baijiahao_pages", cleanup):
                    if existing:
                        result = await account_browser.connect_existing_account_browser(
                            playwright, config, name, digest)
                    else:
                        result, endpoint, returned_digest = await account_browser.connect_account_browser(
                            playwright, config, name)
                        self.assertEqual((endpoint, returned_digest), ("http://127.0.0.1:19999", digest))
                self.assertIs(result, browser)
                browser.contexts[0].add_cookies.assert_not_awaited()
                self.assertEqual(browser._huobao_managed_session["accountName"], name)
                self.assertTrue(json.loads((directory / "session.json").read_text())["initialized"])

    async def test_named_connections_clean_before_cdp_without_reimporting_login(self):
        await self.assert_cleanup_before_connection(existing=False)

    async def test_existing_named_connections_use_the_same_platform_cleanup(self):
        await self.assert_cleanup_before_connection(existing=True)

    async def test_rebound_session_cannot_trigger_cleanup_or_connect(self):
        for existing in (False, True):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                name = self.accounts[0]
                config, digest, directory, browser = self.account_fixture(Path(temporary), name)
                state_file = directory / "session.json"
                state = json.loads(state_file.read_text())
                state["accountName"] = self.accounts[1]
                account_browser.write_private(state_file, state)
                connect = AsyncMock(return_value=browser)
                playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
                with patch.object(account_browser, "alive", return_value=True), \
                        patch.object(account_browser, "cleanup_stale_baijiahao_pages", AsyncMock()) as cleanup:
                    if existing:
                        self.assertIsNone(await account_browser.connect_existing_account_browser(
                            playwright, config, name, digest))
                    else:
                        with self.assertRaisesRegex(RuntimeError, "绑定无效"):
                            await account_browser.connect_account_browser(playwright, config, name)
                cleanup.assert_not_awaited()
                connect.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
