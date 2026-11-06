"""The current Channels app resolves draft routes only after its shell loads."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from playwright.async_api import async_playwright
import bridge


class TencentDraftNavigationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context(viewport={"width": 800, "height": 600})
        self.page = await self.context.new_page()
        await self.context.route("https://channels.weixin.qq.com/**", lambda route: route.fulfill(
            content_type="text/html; charset=utf-8", body='''
            <script>history.replaceState({},'', '/platform')</script>
            <style>.submenu{display:none}li:hover .submenu{display:block}
            @media(max-width:1000px){.submenu{pointer-events:none}}</style>
            <li class="finder-ui-desktop-menu__item">内容管理
              <div class="submenu"><a onclick="openDrafts()">草稿箱</a></div>
            </li><main id="list"></main>
            <script>
            function openDrafts(){
              history.pushState({},'', '/platform/post/draftListManager');
              document.querySelector('#list').innerHTML=`<div class="post-draft-item">
                <div class="post-title">原项目简介</div><span>2026年10月25日 21:21</span>
                <button class="opr-item" onclick="openEditor()">编辑</button></div>`;
            }
            function openEditor(){document.querySelector('#list').innerHTML='<input placeholder="填写短标题">'}
            </script>'''))

    async def test_saved_draft_readback_survives_cold_route_redirect(self):
        payload = {"jobId": "41", "target": "tencent-video", "title": "项目短标题", "description": "原项目简介"}
        attempted = bridge.datetime(2026, 10, 25, 21, 21, tzinfo=bridge.ZoneInfo("Asia/Shanghai")).timestamp()
        state = {"phase": "save_requested", "saveAttemptedAt": attempted, "saveClickedAt": attempted,
                 "result": {"staged": True, "saved": False, "published": False, "targetId": "ABCD"}}
        # This reproduces the production failure: loading the deep link lands on home.
        await self.page.goto("https://channels.weixin.qq.com/platform/post/draftListManager")
        self.assertEqual(self.page.url, "https://channels.weixin.qq.com/platform")
        self.assertEqual(await self.page.locator(".post-draft-item").count(), 0)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(bridge, "verify_tencent_metadata", AsyncMock()), \
                patch.object(bridge, "one_button", side_effect=AssertionError("Must not save again")):
            result = await bridge.reconcile_tencent_draft(self.browser, payload, state, Path(directory) / "state.json", ())
        self.assertTrue(result["saved"])
        self.assertFalse(result["published"])
        self.assertEqual(state["saveClickedAt"], attempted)
        self.assertEqual(state["saveEvidence"]["verification"], "platform_draft_record")

    async def test_successful_empty_response_is_awaited_and_persisted(self):
        async def fixture(route):
            if route.request.url.endswith('/post/get_draft_list'):
                await asyncio.sleep(0.2)
                await route.fulfill(status=201, content_type='application/json',
                                    body=json.dumps({'errCode': 0, 'data': {'list': [], 'totalCount': 0}}))
                return
            await route.fulfill(content_type='text/html; charset=utf-8', body='''
              <li class="finder-ui-desktop-menu__item"><a onclick="openDrafts()">草稿箱</a></li>
              <main></main><script>
              function openDrafts() {
                document.querySelector('main').innerHTML = `<div class="post-list">
                  <div class="draft-list-wrapper"><div class="post-list-body"></div></div></div>`;
                fetch('/micro/content/cgi-bin/mmfinderassistant-bin/post/get_draft_list',
                  {method:'POST', body:JSON.stringify({currentPage:1, pageSize:20})});
              }
              </script>''')
        await self.context.route('https://channels.weixin.qq.com/**', fixture)
        payload = {'jobId': 'empty', 'target': 'tencent-video', 'title': '项目短标题', 'description': '原项目简介'}
        state = {'phase': 'save_requested', 'saveAttemptedAt': 1792938525,
                 'result': {'staged': True, 'saved': False, 'published': False}}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(bridge, 'save_draft', new=AsyncMock()) as save:
            file = Path(directory) / 'state.json'
            with self.assertRaises(RuntimeError) as caught:
                await bridge.reconcile_tencent_draft(self.browser, payload, state, file, ())
            persisted = json.loads(file.read_text())['draftCheck']
        diagnostic = caught.exception.diagnostic
        self.assertEqual(diagnostic['outcome'], 'not_found')
        self.assertTrue(diagnostic['complete'])
        self.assertEqual(diagnostic['pagesScanned'], [1])
        self.assertEqual(diagnostic['rowsScanned'], 0)
        self.assertEqual(diagnostic['matchingDescriptionCount'], 0)
        self.assertEqual(diagnostic['candidateTimes'], [])
        for key, value in diagnostic.items():
            self.assertEqual(persisted[key], value)
        save.assert_not_awaited()
        self.assertFalse(self.page.is_closed())


if __name__ == "__main__":
    unittest.main()
