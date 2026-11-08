import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import account_browser


spec = importlib.util.spec_from_file_location("runtime_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class RuntimeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(patch.object(bridge, "cleanup_stale_baijiahao_pages", AsyncMock()))
        self.enterContext(patch.object(bridge, "upload_locks"))

    def browser_fixture(self):
        page = AsyncMock()
        context = SimpleNamespace(new_page=AsyncMock(return_value=page))
        browser = SimpleNamespace(contexts=[context])
        connect = AsyncMock(return_value=browser)
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
        return page, context, browser, connect, playwright

    async def test_logged_in_browser_taking_more_than_ten_seconds_is_not_blocked(self):
        page, context, browser, connect, playwright = self.browser_fixture()

        async def initialize(*args, timeout, **kwargs):
            if timeout < 12000:
                raise RuntimeError("BrowserType.connect_over_cdp: Timeout 10000ms exceeded; <ws connected>")
            return browser

        connect.side_effect = initialize
        with patch.object(bridge, "login_state", new=AsyncMock(return_value={"ready": True, "message": "已登录"})):
            result = await bridge.inspect_platform(playwright, {"baijiahao": "http://127.0.0.1:9225"}, "baijiahao")
        self.assertTrue(result["ready"])
        self.assertEqual(connect.call_args.kwargs["timeout"], 30000)
        context.new_page.assert_awaited_once()
        page.close.assert_awaited_once()

    async def test_transient_connection_failure_retries_before_opening_exactly_one_check_page(self):
        page, context, browser, connect, playwright = self.browser_fixture()
        connect.side_effect = [RuntimeError("Timeout 30000ms exceeded"), browser]
        with patch.object(bridge, "login_state", new=AsyncMock(return_value={"ready": True, "message": "已登录"})), \
                patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            result = await bridge.inspect_platform(playwright, {"baijiahao": "http://127.0.0.1:9225"}, "baijiahao")
        self.assertTrue(result["ready"])
        self.assertEqual([call.kwargs["timeout"] for call in connect.call_args_list], [30000, 10000])
        context.new_page.assert_awaited_once()
        page.close.assert_awaited_once()

    async def test_repeated_connection_timeout_is_bounded_and_never_claims_login_expired(self):
        page, context, browser, connect, playwright = self.browser_fixture()
        connect.side_effect = RuntimeError("BrowserType.connect_over_cdp: Timeout 30000ms exceeded. Call log: <ws connected>")
        with patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            result = await bridge.inspect_platform(playwright, {"baijiahao": "http://127.0.0.1:9225"}, "baijiahao")
        self.assertEqual(connect.await_count, 2)
        self.assertFalse(result["ready"])
        self.assertEqual(result["issue"], "connection_failed")
        self.assertIn("登录状态尚未确认", result["message"])
        self.assertNotIn("登录已过期", result["message"])
        self.assertNotIn("BrowserType", result["message"])
        context.new_page.assert_not_awaited()

    async def test_existing_platform_page_is_checked_without_opening_or_closing_a_tab(self):
        page, context, browser, connect, playwright = self.browser_fixture()
        page.url = "https://baijiahao.baidu.com/builder/rc/content"
        unrelated = SimpleNamespace(url="https://example.com/")
        context.pages = [page, unrelated]
        with patch.object(bridge, "login_state", new=AsyncMock(return_value={"ready": True, "message": "已登录"})) as check:
            result = await bridge.inspect_platform(playwright, {"baijiahao": "http://127.0.0.1:9225"}, "baijiahao")
        self.assertTrue(result["ready"])
        check.assert_awaited_once_with(page, "baijiahao")
        context.new_page.assert_not_awaited()
        page.goto.assert_not_awaited()
        page.close.assert_not_awaited()

    async def test_existing_platform_login_prompt_is_reported_without_opening_another_tab(self):
        page, context, browser, connect, playwright = self.browser_fixture()
        page.url = "https://channels.weixin.qq.com/platform"
        context.pages = [page]
        expired = {"ready": False, "issue": "login_required", "message": "请先在平台浏览器中人工登录"}
        with patch.object(bridge, "login_state", new=AsyncMock(return_value=expired)):
            result = await bridge.inspect_platform(playwright, {"tencent": "http://127.0.0.1:9222"}, "tencent")
        self.assertEqual(result, expired)
        context.new_page.assert_not_awaited()
        page.close.assert_not_awaited()

    async def test_unreadable_existing_page_falls_back_to_one_owned_check_page(self):
        page, context, browser, connect, playwright = self.browser_fixture()
        existing = AsyncMock()
        existing.url = "https://baijiahao.baidu.com/builder/rc/content"
        context.pages = [existing]
        with patch.object(bridge, "login_state", new=AsyncMock(side_effect=[TimeoutError(), {"ready": True, "message": "已登录"}])):
            result = await bridge.inspect_platform(playwright, {"baijiahao": "http://127.0.0.1:9225"}, "baijiahao")
        self.assertTrue(result["ready"])
        context.new_page.assert_awaited_once()
        page.close.assert_awaited_once()
        existing.goto.assert_not_awaited()
        existing.close.assert_not_awaited()

    def engine(self):
        manager = MagicMock()
        manager.start = AsyncMock(return_value=SimpleNamespace(stop=AsyncMock()))
        return (None, None, lambda: manager, None, None, None)

    async def named_account_check(self, page, *, api_response=None, **options):
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=object())
        manager.__aexit__ = AsyncMock(return_value=False)
        context = SimpleNamespace(new_page=AsyncMock(return_value=page))
        if api_response is not None:
            context.request = SimpleNamespace(get=AsyncMock(return_value=api_response))
        browser = SimpleNamespace(contexts=[context])
        with patch.object(bridge, "load_engine", return_value=(None, None, lambda: manager, None, None, None)), \
                patch.object(bridge, "connect_account_browser", AsyncMock(return_value=(browser, "http://127.0.0.1:9999", "digest"))), \
                patch.object(account_browser, "close_idle_account_browser", AsyncMock()) as close:
            result = await bridge.account_runtime({}, "science_fixture", **options)
        return result, browser, close

    async def test_authenticated_account_api_avoids_loading_the_dashboard(self):
        page = AsyncMock()
        response = SimpleNamespace(status=200, text=AsyncMock(return_value='{"errno":0,"data":{"list":[],"page":{"currentPage":1}}}'))
        result, browser, close = await self.named_account_check(page, api_response=response, keep_browser=True)
        self.assertTrue(result["ready"])
        page.goto.assert_not_awaited()
        browser.contexts[0].request.get.assert_awaited_once()
        self.assertIn("/pcui/article/lists?", browser.contexts[0].request.get.call_args.args[0])
        close.assert_not_awaited()

    async def test_invalid_or_logged_out_account_api_falls_back_to_page(self):
        for body in ('<html>login</html>', '{"errno":0}', '{"errno":1,"data":{}}',
                     '{"errno":false,"data":{"list":[],"page":{"currentPage":1}}}'):
            with self.subTest(body=body):
                page = AsyncMock()
                response = SimpleNamespace(status=200, text=AsyncMock(return_value=body))
                with patch.object(bridge, "login_state", AsyncMock(return_value={"ready": False, "issue": "login_required"})):
                    result, _, close = await self.named_account_check(page, api_response=response, keep_browser=True)
                self.assertFalse(result["ready"])
                self.assertEqual(result["issue"], "login_required")
                page.goto.assert_awaited_once()
                close.assert_awaited_once()

    async def test_upload_preflight_keeps_ready_account_browser_for_the_upload(self):
        page = AsyncMock()
        with patch.object(bridge, "login_state", AsyncMock(return_value={"ready": True, "message": "已登录"})):
            result, _, close = await self.named_account_check(page, keep_browser=True)
        self.assertTrue(result["ready"])
        page.close.assert_awaited_once()
        close.assert_not_awaited()

    async def test_named_account_check_does_not_wait_for_all_page_resources(self):
        page = AsyncMock()
        async def navigate(url, *, wait_until, timeout):
            if wait_until != "commit":
                await asyncio.Event().wait()
        page.goto.side_effect = navigate
        with patch.object(bridge, "login_state", AsyncMock(return_value={"ready": True, "message": "已登录"})):
            result, _, close = await asyncio.wait_for(self.named_account_check(page), 0.1)
        self.assertTrue(result["ready"])
        close.assert_awaited_once()

    async def test_named_account_check_retries_redirect_and_hung_probe(self):
        page = AsyncMock()
        states = [TimeoutError(), RuntimeError("Execution context was destroyed"), {"ready": True, "message": "已登录"}]
        with patch.object(bridge, "login_state", AsyncMock(side_effect=states)), \
                patch.object(bridge.asyncio, "sleep", AsyncMock()):
            result, _, _ = await self.named_account_check(page)
        self.assertTrue(result["ready"])

    async def test_hung_named_account_probe_is_cancelled_before_retrying(self):
        page = AsyncMock()
        calls = 0
        probe_limits = []
        wait_for = asyncio.wait_for

        async def probe(*args):
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.Event().wait()
            return {"ready": True, "message": "已登录"}

        async def bounded(awaitable, timeout):
            probe_limits.append(timeout)
            return await wait_for(awaitable, min(timeout, 0.02))

        with patch.object(bridge, "login_state", probe), \
                patch.object(bridge.asyncio, "sleep", AsyncMock()), \
                patch.object(bridge.asyncio, "wait_for", bounded):
            result, _, _ = await self.named_account_check(page)
        self.assertTrue(result["ready"])
        self.assertEqual(calls, 2)
        self.assertLessEqual(probe_limits[0], 4)

    async def test_named_account_cleanup_failure_cannot_discard_confirmed_login(self):
        page = AsyncMock()
        page.close.side_effect = RuntimeError("renderer disconnected")
        with patch.object(bridge, "login_state", AsyncMock(return_value={"ready": True, "message": "已登录"})):
            result, _, _ = await self.named_account_check(page)
        self.assertTrue(result["ready"])

    async def test_upload_preflight_still_cleans_up_an_expired_account(self):
        page = AsyncMock()
        with patch.object(bridge, "login_state", AsyncMock(return_value={"ready": False, "issue": "login_required"})):
            result, browser, close = await self.named_account_check(page, keep_browser=True)
        self.assertFalse(result["ready"])
        self.assertEqual(result["issue"], "login_required")
        close.assert_awaited_once_with(browser)

    async def test_platform_checks_run_independently_in_parallel(self):
        started = set()
        both_started = asyncio.Event()

        async def inspect(playwright, config, platform):
            started.add(platform)
            if len(started) == 2:
                both_started.set()
            await both_started.wait()
            return {"ready": True, "message": platform}

        with patch.object(bridge, "load_engine", return_value=self.engine()), \
                patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(stdout="test")), \
                patch.object(bridge, "inspect_platform", side_effect=inspect):
            result = await asyncio.wait_for(bridge.runtime({"root": "/unused"}), 0.5)
        self.assertTrue(all(state["ready"] for state in result["platforms"].values()))

    async def test_hung_platform_does_not_discard_other_platform_result(self):
        async def inspect(playwright, config, platform):
            if platform == "tencent":
                await asyncio.Event().wait()
            return {"ready": True, "message": "已登录"}

        with patch.object(bridge, "load_engine", return_value=self.engine()), \
                patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(stdout="test")), \
                patch.object(bridge, "PLATFORM_CHECK_TIMEOUT", 0.02, create=True), \
                patch.object(bridge, "inspect_platform", side_effect=inspect):
            result = await asyncio.wait_for(bridge.runtime({"root": "/unused"}), 0.5)
        self.assertTrue(result["installed"])
        self.assertTrue(result["platforms"]["baijiahao"]["ready"])
        self.assertFalse(result["platforms"]["tencent"]["ready"])
        self.assertIn("视频号", result["platforms"]["tencent"]["message"])
        self.assertIn("尚未开始上传", result["platforms"]["tencent"]["message"])

    async def test_login_check_retries_when_platform_redirects(self):
        page = AsyncMock()
        context = SimpleNamespace(new_page=AsyncMock(return_value=page))
        browser = SimpleNamespace(contexts=[context])
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        states = [TimeoutError("page is still initializing"),
                  RuntimeError("Execution context was destroyed, most likely because of a navigation"),
                  {"ready": True, "message": "平台浏览器已登录"}]
        with patch.object(bridge, "login_state", new=AsyncMock(side_effect=states)), \
                patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            result = await bridge.inspect_platform(playwright, {"tencent": "http://127.0.0.1:9222"}, "tencent")
        self.assertTrue(result["ready"])
        page.close.assert_awaited_once()

    async def test_login_marker_does_not_wait_for_all_page_resources(self):
        page = AsyncMock()
        async def navigate(url, *, wait_until, timeout):
            if wait_until != "commit":
                await asyncio.Event().wait()
        page.goto.side_effect = navigate
        browser = SimpleNamespace(contexts=[SimpleNamespace(new_page=AsyncMock(return_value=page))])
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
        with patch.object(bridge, "login_state", new=AsyncMock(return_value={"ready": True, "message": "已登录"})):
            result = await asyncio.wait_for(bridge.inspect_platform(playwright, {"baijiahao": "http://127.0.0.1:9225"}, "baijiahao"), 0.1)
        self.assertTrue(result["ready"])

    async def test_driver_cleanup_failure_preserves_login_results(self):
        engine = self.engine()
        engine[2]().start.return_value.stop.side_effect = RuntimeError("driver disconnected during cleanup")
        with patch.object(bridge, "load_engine", return_value=engine), \
                patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(stdout="test")), \
                patch.object(bridge, "inspect_platform", new=AsyncMock(return_value={"ready": True, "message": "已登录"})):
            result = await bridge.runtime({"root": "/unused"})
        self.assertTrue(all(state["ready"] for state in result["platforms"].values()))

    async def test_slow_browser_is_not_reported_as_not_running(self):
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(side_effect=RuntimeError("Timeout 10000ms exceeded"))))
        result = await bridge.inspect_platform(playwright, {"tencent": "http://127.0.0.1:9222"}, "tencent")
        self.assertFalse(result["ready"])
        self.assertIn("连接失败或响应超时", result["message"])
        self.assertNotIn("未启动", result["message"])

    async def test_closed_browser_has_actionable_login_message(self):
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(side_effect=RuntimeError("connect ECONNREFUSED 127.0.0.1:9222"))))
        result = await bridge.inspect_platform(playwright, {"tencent": "http://127.0.0.1:9222"}, "tencent")
        self.assertFalse(result["ready"])
        self.assertIn("打开登录窗口", result["message"])

    async def test_orphan_browser_session_points_to_explicit_login_recovery(self):
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(side_effect=RuntimeError(
            "Protocol error (Browser.setDownloadBehavior): Browser context management is not supported."))))
        result = await bridge.inspect_platform(playwright, {"tencent": "http://127.0.0.1:9222"}, "tencent")
        self.assertFalse(result["ready"])
        self.assertIn("会话已失效", result["message"])
        self.assertIn("登录视频号", result["message"])
        self.assertIn("尚未开始上传", result["message"])


if __name__ == "__main__":
    unittest.main()
