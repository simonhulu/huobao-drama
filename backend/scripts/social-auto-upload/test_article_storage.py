"""Real browser tests; every request is fulfilled locally, never by Baijiahao."""

import json
import unittest

from playwright.async_api import async_playwright

from article_storage import install_article_storage_isolation


ORIGIN = "https://baijiahao.baidu.com"
EDITOR_URL = ORIGIN + "/builder/rc/edit?type=news"
CACHE_KEY = "edit-a401b43c-news"
OLD_CACHE = {
    "content": {
        "value": '<p>旧正文</p><img src="https://images.example.test/old.png">',
        "isBeautify": True,
        "format": {"fontSize": 18},
    },
    "task": "",
    "setting_new": {"cover": "three", "comment": True},
    "auto_mount_goods": 1,
}
OLD_RAW = json.dumps(OLD_CACHE, ensure_ascii=False, indent=2)
FIXTURE = """<!doctype html><meta charset="utf-8">
<div id="editor" contenteditable="true"></div>
<script>
const cacheKey = 'edit-a401b43c-news';
const raw = localStorage.getItem(cacheKey);
window.initialCache = raw === null ? null : JSON.parse(raw);
document.querySelector('#editor').innerHTML = window.initialCache?.content?.value || '';
window.saveArticle = html => {
    const draft = JSON.parse(localStorage.getItem(cacheKey)) || {content: {}};
    draft.content.value = html;
    localStorage.setItem(cacheKey, JSON.stringify(draft));
    document.querySelector('#editor').innerHTML = html;
};
</script>"""


class ArticleStorageTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.context = await self.browser.new_context(service_workers="block")
        self.errors = []

        async def local_route(route):
            if route.request.resource_type == "document":
                body = "<!doctype html>" if "/storage-fixture" in route.request.url else FIXTURE
                await route.fulfill(content_type="text/html; charset=utf-8", body=body)
            else:
                await route.fulfill(status=204, body="")

        await self.context.route("**/*", local_route)
        self.observer = await self.context.new_page()
        await self.observer.goto(ORIGIN + "/storage-fixture")
        await self.observer.evaluate("([key, value]) => localStorage.setItem(key, value)",
                                     [CACHE_KEY, OLD_RAW])

    async def asyncTearDown(self):
        self.assertEqual(self.errors, [], "Fixture scripts must run without browser errors")

    async def page(self, job_id="task-40", url=EDITOR_URL):
        page = await self.context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        await install_article_storage_isolation(page, job_id)
        await page.goto(url)
        return page

    async def read(self, page, key=CACHE_KEY):
        return await page.evaluate("key => localStorage.getItem(key)", key)

    async def test_bootstrap_clears_old_html_and_images_but_preserves_settings(self):
        # Without the hook, the real-shaped cache immediately restores the old image.
        control = await self.context.new_page()
        await control.goto(EDITOR_URL)
        self.assertEqual(await control.locator("#editor img").count(), 1)
        self.assertEqual(await control.locator("#editor").inner_html(), OLD_CACHE["content"]["value"])

        page = await self.page()
        self.assertEqual(await page.locator("#editor").inner_html(), "")
        self.assertEqual(await page.locator("#editor img").count(), 0)
        expected = json.loads(OLD_RAW)
        expected["content"]["value"] = ""
        self.assertEqual(await page.evaluate("window.initialCache"), expected)
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_two_jobs_are_isolated_even_with_copied_tab_session(self):
        first = await self.page("task-40")
        first_html = '<p>任务40</p><img src="https://images.example.test/40.png">'
        await first.evaluate("window.saveArticle", first_html)

        second = await self.page('task-43:"中文"', ORIGIN + "/storage-fixture")
        # An opened/duplicated tab can inherit sessionStorage from its opener.
        snapshot = await first.evaluate("Object.entries(sessionStorage)")
        self.assertTrue(snapshot, "Draft writes must actually reach sessionStorage")
        await second.evaluate("items => items.forEach(([k,v]) => sessionStorage.setItem(k,v))", snapshot)
        await second.goto(EDITOR_URL)
        self.assertEqual(await second.locator("#editor").inner_html(), "")
        second_html = "<p>任务43独立正文</p>"
        await second.evaluate("window.saveArticle", second_html)

        await first.reload()
        await second.reload()
        self.assertEqual(await first.locator("#editor").inner_html(), first_html)
        self.assertEqual(await second.locator("#editor").inner_html(), second_html)
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_reload_restores_current_article_without_reimporting_shared_cache(self):
        page = await self.page()
        html = '<p>当前稿件</p><img src="https://images.example.test/current.png">'
        await page.evaluate("window.saveArticle", html)
        current_raw = await self.read(page)
        await page.reload()
        self.assertEqual(await page.locator("#editor").inner_html(), html)
        self.assertEqual(await page.locator("#editor img").count(), 1)
        self.assertEqual(await self.read(page), current_raw)
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_same_job_in_separate_tabs_still_has_private_storage(self):
        first = await self.page("same-job")
        second = await self.page("same-job")
        await first.evaluate("window.saveArticle", "<p>只在第一个标签</p>")
        await second.reload()
        self.assertEqual(await second.locator("#editor").inner_html(), "")
        self.assertEqual(json.loads(await self.read(first))["content"]["value"], "<p>只在第一个标签</p>")

    async def test_remove_survives_reload_without_resurrecting_shared_html(self):
        page = await self.page()
        await page.evaluate("window.saveArticle", "<p>要删除的稿件</p>")
        await page.evaluate("key => localStorage.removeItem(key)", CACHE_KEY)
        self.assertIsNone(await self.read(page))
        await page.reload()
        self.assertIsNone(await self.read(page))
        self.assertEqual(await page.locator("#editor").inner_html(), "")
        self.assertEqual(await self.read(self.observer), OLD_RAW)
        await page.evaluate("window.saveArticle", "<p>删除后重新写入</p>")
        await page.reload()
        self.assertEqual(await page.locator("#editor").inner_html(), "<p>删除后重新写入</p>")

    async def test_existing_article_id_pages_keep_native_read_write_remove(self):
        for article_id in ("123456", ""):
            with self.subTest(article_id=article_id):
                page = await self.page(url=EDITOR_URL + "&article_id=" + article_id)
                self.assertEqual(await self.read(page), OLD_RAW)
                self.assertEqual(await page.locator("#editor img").count(), 1)
                await page.evaluate("window.saveArticle", "<p>原稿正常保存</p>")
                self.assertEqual(await self.read(page), await self.read(self.observer))
                await page.evaluate("key => localStorage.removeItem(key)", CACHE_KEY)
                self.assertIsNone(await self.read(self.observer))
                self.assertEqual(await page.evaluate("sessionStorage.length"), 0)
                await self.observer.evaluate("([k,v]) => localStorage.setItem(k,v)", [CACHE_KEY, OLD_RAW])

    async def test_history_change_to_existing_article_stops_interception(self):
        page = await self.page()
        await page.evaluate("window.saveArticle", "<p>任务缓存</p>")
        await page.evaluate("history.replaceState({}, '', '?type=news&article_id=123')")
        self.assertEqual(await self.read(page), OLD_RAW)
        await page.evaluate("window.saveArticle", "<p>已有原稿</p>")
        self.assertEqual(await self.read(page), await self.read(self.observer))
        await page.evaluate("history.replaceState({}, '', '?type=news')")
        self.assertEqual(json.loads(await self.read(page))["content"]["value"], "<p>任务缓存</p>")

    async def test_only_exact_new_article_url_is_intercepted(self):
        for url in (
            ORIGIN + "/builder/rc/edit?type=video",
            ORIGIN + "/builder/rc/edit",
            ORIGIN + "/builder/rc/other?type=news",
            "http://baijiahao.baidu.com/builder/rc/edit?type=news",
            "https://other.example.test/builder/rc/edit?type=news",
        ):
            with self.subTest(url=url):
                page = await self.page(url=url)
                await page.evaluate("([k,v]) => localStorage.setItem(k,v)", [CACHE_KEY, OLD_RAW])
                await page.reload()
                self.assertEqual(await self.read(page), OLD_RAW)
                self.assertEqual(await page.locator("#editor img").count(), 1)
                self.assertEqual(await page.evaluate("sessionStorage.length"), 0)

    async def test_other_keys_session_storage_and_credentials_are_untouched(self):
        await self.context.add_cookies([{"name": "fixture_auth", "value": "unchanged", "url": ORIGIN}])
        await self.observer.evaluate("localStorage.setItem('token', 'fixture-token')")
        page = await self.page()
        for key in ("theme", "edit-A123-news", "edit-abc-video", "edit-xyz-news", "edit-abc-news-extra"):
            with self.subTest(key=key):
                await page.evaluate("key => localStorage.setItem(key, 'setting')", key)
                self.assertEqual(await self.read(page, key), "setting")
                self.assertEqual(await self.read(self.observer, key), "setting")
                await page.evaluate("key => localStorage.removeItem(key)", key)
                self.assertIsNone(await self.read(self.observer, key))
        await page.evaluate("([k,v]) => sessionStorage.setItem(k,v)", [CACHE_KEY, OLD_RAW])
        self.assertEqual(await page.evaluate("key => sessionStorage.getItem(key)", CACHE_KEY), OLD_RAW)
        await page.evaluate("key => sessionStorage.removeItem(key)", CACHE_KEY)
        self.assertIsNone(await page.evaluate("key => sessionStorage.getItem(key)", CACHE_KEY))
        self.assertEqual(await self.read(self.observer, "token"), "fixture-token")
        self.assertEqual(await page.evaluate("document.cookie"), "fixture_auth=unchanged")
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_unread_keys_support_write_remove_and_invalid_legacy_cache(self):
        page = await self.page()
        key = "edit-deadbeef-news"
        for value in ("", "null", "not-json", '{"content":{"value":"新稿"}}'):
            with self.subTest(value=value):
                await page.evaluate("([k,v]) => localStorage.setItem(k,v)", [key, value])
                await page.reload()
                self.assertEqual(await self.read(page, key), value)
                self.assertIsNone(await self.read(self.observer, key))

        # Deleting an unread key must not fall back to the shared value either.
        key = "edit-bad0-news"
        await self.observer.evaluate("([k,v]) => localStorage.setItem(k,v)", [key, OLD_RAW])
        await page.evaluate("key => localStorage.removeItem(key)", key)
        await page.reload()
        self.assertIsNone(await self.read(page, key))
        self.assertEqual(await self.read(self.observer, key), OLD_RAW)

        for index, value in enumerate((None, "broken-json", "null", "[]", '{"setting_new":{"x":1}}')):
            with self.subTest(legacy=value):
                key = f"edit-f{index}-news"
                if value is not None:
                    await self.observer.evaluate("([k,v]) => localStorage.setItem(k,v)", [key, value])
                result = await self.read(page, key)
                if value and value.startswith('{'):
                    self.assertEqual(json.loads(result), {"setting_new": {"x": 1}, "content": {"value": ""}})
                else:
                    self.assertIsNone(result)
                await page.reload()
                self.assertEqual(await self.read(page, key), result)
                self.assertEqual(await self.read(self.observer, key), value)


if __name__ == "__main__":
    unittest.main()
