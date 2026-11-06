"""Exercise login detection against rendered platform DOM, without credentials."""
import unittest

from playwright.async_api import async_playwright

from bridge import login_state


HOME = "https://baijiahao.baidu.com/builder/rc/home"
DASHBOARD = "<nav>首页<br>内容管理</nav>"
DAILY_TASK = "<section>登录百家号<br>已完成<br>成功发布一篇内容</section>"


class LoginStateTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        await self.context.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<body></body>"))
        self.page = await self.context.new_page()
        await self.page.goto(HOME)

    async def state(self, html, url=HOME, platform="baijiahao"):
        if self.page.url != url:
            await self.page.goto(url)
        await self.page.set_content(html)
        return await login_state(self.page, platform)

    async def test_completed_daily_login_task_does_not_invalidate_authenticated_dashboard(self):
        self.assertTrue((await self.state(DASHBOARD))["ready"])
        # The real homepage loads this reward task after the navigation shell.
        await self.page.locator("body").evaluate("(body, task) => body.insertAdjacentHTML('beforeend', task)", DAILY_TASK)
        self.assertTrue((await login_state(self.page, "baijiahao"))["ready"])

    async def test_task_text_and_generic_home_or_publish_labels_are_not_readiness_evidence(self):
        for html in (DAILY_TASK, "<nav>首页</nav><button>发布</button>", ""):
            with self.subTest(html=html):
                result = await self.state(html)
                self.assertFalse(result["ready"])
                self.assertEqual(result["issue"], "check_failed")

    async def test_visible_login_controls_override_dashboard_and_hidden_ones_do_not(self):
        for html in ('<button>登录百家号</button>', '<a href="/login">登录</a>', '<div role="button">登录/注册百家号</div>'):
            with self.subTest(html=html):
                self.assertEqual((await self.state(DASHBOARD + html))["issue"], "login_required")
        hidden = '<div hidden><button>登录百家号</button></div>'
        self.assertTrue((await self.state(DASHBOARD + hidden))["ready"])

    async def test_only_visible_passport_frame_blocks_authenticated_dashboard(self):
        iframe = '<iframe src="https://passport.baidu.com/v2/?login" {}></iframe>'
        self.assertTrue((await self.state(DASHBOARD + iframe.format('style="display:none"')))["ready"])
        self.assertEqual((await self.state(DASHBOARD + iframe.format("")))["issue"], "login_required")

    async def test_login_location_uses_host_and_path_not_query_text(self):
        for url in ("https://baijiahao.baidu.com/builder/theme/bjh/login", "https://passport.baidu.com/v2/"):
            with self.subTest(url=url):
                self.assertEqual((await self.state(DASHBOARD, url))["issue"], "login_required")
        self.assertTrue((await self.state(DASHBOARD, HOME + "?help=https://passport.baidu.com/login"))["ready"])
        for url in ("https://example.com/builder/rc/home", "https://baijiahao.baidu.com/builder/theme/about"):
            self.assertFalse((await self.state(DASHBOARD, url))["ready"])

    async def test_real_qr_login_and_security_challenge_remain_blocked(self):
        for text in ("扫码登录", "账号密码登录"):
            self.assertEqual((await self.state(DASHBOARD + f"<p>{text}</p>"))["issue"], "login_required")
        self.assertEqual((await self.state(DASHBOARD + "<div>安全验证，请完成验证</div>"))["issue"], "verification_required")

    async def test_tencent_detection_retains_login_precedence(self):
        url = "https://channels.weixin.qq.com/platform"
        self.assertTrue((await self.state("<p>视频号ID: fixture-id</p>", url, "tencent"))["ready"])
        self.assertEqual((await self.state("<p>视频号ID: fixture-id</p><div>微信扫码登录</div>", url, "tencent"))["issue"], "login_required")


if __name__ == "__main__":
    unittest.main()
