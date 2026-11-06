import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from playwright.async_api import async_playwright
import bridge


class ArticleInitializationRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        self.visits = 0
        async def document(route):
            self.visits += 1
            # The failed real app retains an empty, hidden bootstrap iframe.
            await route.fulfill(content_type="text/html", body='<body><iframe style="display:none"></iframe></body>' if self.visits == 1 else '<input placeholder="title">')
        await self.context.route("https://baijiahao.baidu.com/**", document)
        await self.page.goto("https://baijiahao.baidu.com/builder/rc/edit?type=news")
        await self.page.evaluate("window.name='huobao-sau-40';window.__huobaoSauDocumentToken='bound'")
        self.payload = {"jobId": "40", "target": "baijiahao-article", "title": "原稿标题"}
        self.request = {"config": {"stateRoot": self.tmp.name}, "payload": self.payload}
        self.file = bridge.job_state_file(self.request)
        self.file.parent.mkdir(parents=True)
        self.state = {"phase": "initializing", "protocolVersion": 3, "payloadDigest": bridge.payload_digest(self.payload),
                      "files": {}, "documentToken": "bound", "targetId": await bridge.page_id(self.page),
                      "error": "Page.wait_for_function: Timeout 60000ms exceeded."}
        bridge.write_state(self.file, self.state)

    async def test_resume_reloads_only_the_bound_untouched_blank_editor(self):
        async def stage(page, *args):
            self.assertEqual(await page.locator('input').count(), 1, "resume must recover the blank editor, not wait on it again")
            return {"engine": "huobao/baijiahao-article-extension"}
        with patch.object(bridge, "load_engine", return_value=(None, None, async_playwright, None, None, None)), \
                patch.object(bridge, "connect_upload_browser", AsyncMock(return_value=(self.browser, "cdp", None))), \
                patch.object(bridge, "stage_article", AsyncMock(side_effect=stage)), \
                patch.object(bridge, "save_draft", side_effect=AssertionError("resume must not replay save")):
            result = await bridge.upload(self.request, "resume")
        self.assertTrue(result["staged"])
        self.assertFalse(result["saved"])
        stored = json.loads(self.file.read_text())
        self.assertEqual(stored["targetId"], self.state["targetId"])
        self.assertNotEqual(stored["documentToken"], "bound")
        self.assertEqual(self.visits, 2)

    async def test_nonempty_or_previously_reloaded_page_is_not_reloaded(self):
        for html in ('<input value="user edit">', '<div contenteditable>user edit</div>', '<iframe></iframe>'):
            await self.page.set_content(html)
            await bridge.reload_blank_article_initialization(self.page, self.payload, self.state, self.file)
            self.assertEqual(self.visits, 1)
        await self.page.set_content('<body></body>')
        self.state["articleInitializationReloadAttemptedAt"] = 1
        await bridge.reload_blank_article_initialization(self.page, self.payload, self.state, self.file)
        self.assertEqual(self.visits, 1)

    async def cached_editor(self):
        await self.page.evaluate('''() => {
          document.body.innerHTML='<div data-testid="news-title-input"><div contenteditable="true"></div></div><iframe></iframe>';
          const iframe=document.querySelector('iframe');
          const html='<p><img src="https://baijiahao.baidu.com/bjh/picproxy?fixture=old"></p>';
          iframe.contentDocument.body.innerHTML=html;
          window.UE_V2={instants:{one:{isReady:1,body:iframe.contentDocument.body,iframe,
            getContent(){return this.body.innerHTML}}}};
          localStorage.setItem('edit-aabbcc-news',JSON.stringify({content:{value:html},setting_new:{keep:true}}));
        }''')

    async def test_cache_replacement_requires_unwritten_job_and_exact_shared_cache(self):
        await self.cached_editor()
        self.assertTrue(await bridge.has_foreign_article_cache(self.page, self.payload, self.state))
        for marker in ('fileSelectionStartedAt', 'details', 'result', 'saveAttemptedAt'):
            self.assertFalse(await bridge.has_foreign_article_cache(self.page, self.payload, {**self.state, marker: 1}))
        await self.page.locator('[contenteditable]').fill('人工修改的标题')
        self.assertFalse(await bridge.has_foreign_article_cache(self.page, self.payload, self.state))
        await self.page.locator('[contenteditable]').fill('')
        await self.page.evaluate("UE_V2.instants.one.body.append('人工正文')")
        self.assertFalse(await bridge.has_foreign_article_cache(self.page, self.payload, self.state))
        await self.cached_editor()
        await self.page.evaluate("localStorage.removeItem('edit-aabbcc-news')")
        self.assertFalse(await bridge.has_foreign_article_cache(self.page, self.payload, self.state))
        for tag in ('video', 'audio', 'iframe', 'object'):
            await self.cached_editor()
            await self.page.evaluate("tag=>UE_V2.instants.one.body.append(document.createElement(tag))", tag)
            self.assertFalse(await bridge.has_foreign_article_cache(self.page, self.payload, self.state), tag)

    async def test_resume_preserves_cached_page_and_uses_new_isolated_editor_for_same_job(self):
        await self.cached_editor()
        original_html = await self.page.evaluate('UE_V2.instants.one.body.innerHTML')
        async def stage(page, *args, **kwargs):
            self.assertIsNot(page, self.page)
            self.assertEqual(await page.locator('input').count(), 1)
            return {"engine": "huobao/baijiahao-article-extension"}
        with patch.object(bridge, "load_engine", return_value=(None, None, async_playwright, None, None, None)), \
                patch.object(bridge, "connect_upload_browser", AsyncMock(return_value=(self.browser, "cdp", None))), \
                patch.object(bridge, "stage_article", AsyncMock(side_effect=stage)):
            result = await bridge.upload(self.request, "resume")
        self.assertTrue(result['staged'])
        self.assertFalse(result['saved'])
        self.assertEqual(await self.page.evaluate('UE_V2.instants.one.body.innerHTML'), original_html)
        stored = json.loads(self.file.read_text())
        self.assertNotEqual(stored['targetId'], self.state['targetId'])
        self.assertEqual(stored['preservedEditor']['targetId'], self.state['targetId'])
        self.assertEqual(json.loads(Path(stored['preservedEditor']['checkpointPath']).read_text()), self.state)


if __name__ == "__main__":
    unittest.main()
