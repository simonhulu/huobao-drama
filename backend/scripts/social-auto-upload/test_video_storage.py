"""Real browser tests for new Baijiahao video-cache isolation."""

import json
import unittest

from playwright.async_api import async_playwright

from video_storage import install_video_storage_isolation


ORIGIN = "https://baijiahao.baidu.com"
EDITOR_URL = ORIGIN + "/builder/rc/edit?type=videoV2"
CACHE_KEY = "edit-a401b43c-videoV2"
OLD_CACHE = [
    {"video": "https://media.example.test/old.mp4", "title": "旧视频标题", "cover": "old.jpg"},
]
OLD_RAW = json.dumps(OLD_CACHE, ensure_ascii=False, separators=(",", ":"))
FIXTURE = f"""<!doctype html><meta charset="utf-8">
<div id="editor"></div>
<script>
const cacheKey = {CACHE_KEY!r};
const raw = localStorage.getItem(cacheKey);
window.initialCache = raw;
window.cache = raw === null ? [] : JSON.parse(raw);
document.querySelector('#editor').textContent = window.cache[0]?.title || '';
window.saveVideo = value => {{
    localStorage.setItem(cacheKey, JSON.stringify(value));
    window.cache = value;
    document.querySelector('#editor').textContent = value[0]?.title || '';
}};
</script>"""


class VideoStorageTest(unittest.IsolatedAsyncioTestCase):
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
        self.observer.on("pageerror", lambda error: self.errors.append(str(error)))
        await self.observer.goto(ORIGIN + "/storage-fixture")
        await self.observer.evaluate("([key, value]) => localStorage.setItem(key, value)", [CACHE_KEY, OLD_RAW])

    async def asyncTearDown(self):
        self.assertEqual(self.errors, [], "Fixture scripts must run without browser errors")

    async def page(self, job_id="task-40", url=EDITOR_URL):
        page = await self.context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        await install_video_storage_isolation(page, job_id)
        await page.goto(url)
        return page

    async def read(self, page, key=CACHE_KEY):
        return await page.evaluate("key => localStorage.getItem(key)", key)

    async def test_without_hook_reproduces_previous_video_restore(self):
        control = await self.context.new_page()
        await control.goto(EDITOR_URL)
        self.assertEqual(await control.locator("#editor").text_content(), "旧视频标题")
        self.assertEqual(await control.evaluate("window.initialCache"), OLD_RAW)

    async def test_fresh_job_is_empty_and_shared_cache_is_unchanged(self):
        page = await self.page()
        self.assertEqual(await page.locator("#editor").text_content(), "")
        self.assertEqual(await page.evaluate("window.initialCache"), "[]")
        self.assertEqual(await self.read(page), "[]")
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_two_jobs_and_reloads_keep_private_video_values(self):
        first = await self.page("task-40")
        first_value = [{"video": "40.mp4", "title": "任务40"}]
        await first.evaluate("window.saveVideo", first_value)

        second = await self.page("task-43", ORIGIN + "/storage-fixture")
        # A duplicated tab can copy the first tab's sessionStorage. Job prefixes
        # must still keep the second task empty.
        snapshot = await first.evaluate("Object.entries(sessionStorage)")
        self.assertTrue(snapshot)
        await second.evaluate("items => items.forEach(([k,v]) => sessionStorage.setItem(k,v))", snapshot)
        await second.goto(EDITOR_URL)
        self.assertEqual(await second.locator("#editor").text_content(), "")
        second_value = [{"video": "43.mp4", "title": "任务43"}]
        await second.evaluate("window.saveVideo", second_value)

        await first.reload()
        await second.reload()
        self.assertEqual(await first.locator("#editor").text_content(), "任务40")
        self.assertEqual(await second.locator("#editor").text_content(), "任务43")
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_closing_first_tab_and_opening_next_starts_empty(self):
        first = await self.page("task-close")
        await first.evaluate("window.saveVideo", [{"video": "close.mp4", "title": "已关闭任务"}])
        await first.close()
        second = await self.page("task-next")
        self.assertEqual(await second.locator("#editor").text_content(), "")
        self.assertEqual(await self.read(second), "[]")
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_remove_keeps_empty_tombstone_without_reseeding(self):
        page = await self.page()
        await page.evaluate("window.saveVideo", [{"video": "remove.mp4", "title": "待删除"}])
        await page.evaluate("key => localStorage.removeItem(key)", CACHE_KEY)
        self.assertEqual(await self.read(page), "[]")
        await page.reload()
        self.assertEqual(await self.read(page), "[]")
        self.assertEqual(await page.locator("#editor").text_content(), "")
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_existing_video_drafts_and_articles_keep_native_storage(self):
        for url in (EDITOR_URL + "&article_id=123456", ORIGIN + "/builder/rc/edit?type=news"):
            with self.subTest(url=url):
                page = await self.page(url=url)
                self.assertEqual(await self.read(page), OLD_RAW)
                await page.evaluate("window.saveVideo", [{"video": "native.mp4", "title": "原稿"}])
                self.assertEqual(
                    await self.read(page),
                    json.dumps([{"video": "native.mp4", "title": "原稿"}], ensure_ascii=False, separators=(",", ":")),
                )
                await page.evaluate("key => localStorage.removeItem(key)", CACHE_KEY)
                self.assertIsNone(await self.read(page))
                await self.observer.evaluate("([key, value]) => localStorage.setItem(key, value)", [CACHE_KEY, OLD_RAW])

    async def test_only_exact_new_video_url_and_key_are_intercepted(self):
        for url in (
            ORIGIN + "/builder/rc/edit?type=news",
            ORIGIN + "/builder/rc/edit",
            ORIGIN + "/builder/rc/other?type=videoV2",
            "http://baijiahao.baidu.com/builder/rc/edit?type=videoV2",
            "https://other.example.test/builder/rc/edit?type=videoV2",
        ):
            with self.subTest(url=url):
                page = await self.page(url=url)
                await page.evaluate("([key, value]) => localStorage.setItem(key, value)", [CACHE_KEY, OLD_RAW])
                self.assertEqual(await self.read(page), OLD_RAW)

        page = await self.page()
        other_key = "edit-a401b43c-news"
        await page.evaluate("([key, value]) => localStorage.setItem(key, value)", [other_key, OLD_RAW])
        self.assertEqual(await self.read(page, other_key), OLD_RAW)
        self.assertEqual(await self.read(self.observer, other_key), OLD_RAW)

    async def test_account_storage_import_does_not_seed_new_video_cache(self):
        # This mirrors account_browser's login import: it only writes a shared
        # cache when a native read reports that it is absent. The isolation hook
        # must return [] either before or after that init script runs.
        script = f"""() => {{
          if (localStorage.getItem({CACHE_KEY!r}) === null)
            localStorage.setItem({CACHE_KEY!r}, {OLD_RAW!r});
        }}"""
        await self.context.add_init_script(script=script)
        page = await self.page("import-order")
        self.assertEqual(await page.evaluate("window.initialCache"), "[]")
        self.assertEqual(await self.read(page), "[]")
        self.assertEqual(await self.read(self.observer), OLD_RAW)

    async def test_unrelated_session_storage_and_credentials_are_untouched(self):
        await self.context.add_cookies([{"name": "fixture_auth", "value": "unchanged", "url": ORIGIN}])
        await self.observer.evaluate("localStorage.setItem('token', 'fixture-token')")
        page = await self.page()
        await page.evaluate("([k,v]) => sessionStorage.setItem(k,v)", ["native-session", "keep"])
        self.assertEqual(await page.evaluate("sessionStorage.getItem('native-session')"), "keep")
        self.assertEqual(await self.read(self.observer, "token"), "fixture-token")
        self.assertEqual(await page.evaluate("document.cookie"), "fixture_auth=unchanged")
        self.assertEqual(await self.read(self.observer), OLD_RAW)


if __name__ == "__main__":
    unittest.main()
