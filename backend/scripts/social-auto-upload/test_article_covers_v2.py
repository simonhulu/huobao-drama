"""Isolated Chromium fixtures; never connect to or close a real browser session."""
import asyncio
from functools import wraps
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

import cv2
import numpy as np
from playwright.async_api import async_playwright

import article_covers_v2 as covers_v2
import bridge
from article_cover_selection import prepare_article_cover_images
from test_article_browser import THREE_FIXTURE


class LocalSourceHelpers:
    async def _browser_digest(self, page, src):
        return await page.evaluate("""async src => {
          const bytes = await (await fetch(src)).arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
        }""", src)

    async def _cover_pixels(self, *args):
        raise AssertionError("Remote pixels must never gate article covers")

    def _normalized_pixels(self, *args):
        raise AssertionError("Cover verification must not decode image pixels")

    def _pixel_difference(self, *args):
        raise AssertionError("Cover verification must not compare remote pixels")


def browser_test(method):
    @wraps(method)
    def run(self):
        return self.runner.run(asyncio.wait_for(method(self), 20))
    return run


class ArticleCoversV2Test(unittest.TestCase):
    """One owned browser/event loop per suite; a fresh context for each test."""
    browser_close_timeout = 5

    @classmethod
    def setUpClass(cls):
        cls.runner = asyncio.Runner()
        cls.addClassCleanup(cls.runner.close)
        cls.playwright = cls.runner.run(asyncio.wait_for(async_playwright().start(), 10))
        cls.addClassCleanup(cls.run_cleanup, cls.playwright.stop)
        cls.browser_marker = f"--huobao-article-covers-test={uuid.uuid4().hex}"
        cls.browser = cls.runner.run(cls.playwright.chromium.launch(
            channel="chrome", headless=True, timeout=10000, args=[cls.browser_marker]))
        cls.addClassCleanup(cls.run_cleanup, cls.close_owned_browser)

    @classmethod
    def run_cleanup(cls, close):
        cls.runner.run(asyncio.wait_for(close(), 20))

    @classmethod
    def owned_browser_pids(cls):
        # Never use pkill/browser names/profile globs: other suites and real
        # Chrome sessions can run concurrently. Require our exact random argv.
        processes = subprocess.check_output(
            ["ps", "-axo", "pid=,command="], text=True, timeout=2)
        return [int(pid) for line in processes.splitlines()
                for pid, command in [line.strip().split(maxsplit=1)]
                if cls.browser_marker in command.split()]

    @classmethod
    async def close_owned_browser(cls):
        for context in list(cls.browser.contexts):
            await asyncio.wait_for(context.close(), 5)
        closing = asyncio.create_task(cls.browser.close())
        try:
            await asyncio.wait_for(asyncio.shield(closing), cls.browser_close_timeout)
        except TimeoutError:
            pids = cls.owned_browser_pids()
            print(f"Chromium close timed out; terminating {len(pids)} owned test process(es)", file=sys.stderr)
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            for _ in range(20):
                if not cls.owned_browser_pids():
                    break
                await asyncio.sleep(0.1)
            # Recheck the random ownership token immediately before escalation.
            for pid in cls.owned_browser_pids():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            # Drain the original close task after exit instead of cancelling it
            # mid-protocol and leaking a TargetClosedError into the next test.
            await asyncio.wait_for(closing, 5)
        if cls.owned_browser_pids():
            raise RuntimeError("Owned test Chromium did not exit")

    def setUp(self):
        self.runner.run(asyncio.wait_for(self.asyncSetUp(), 15))

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="article-covers-v2-")
        self.addCleanup(self.directory.cleanup)
        self.context = await self.browser.new_context()
        # Per-test context cleanup precedes class-level browser/driver cleanup.
        self.addCleanup(self.run_cleanup, self.context.close)
        self.context.set_default_timeout(1500)
        self.context.set_default_navigation_timeout(3000)
        self.page = await self.context.new_page()
        await self.context.route("**/*", lambda route: route.abort())
        await self.page.route("https://article-fixture.test/**", lambda route: route.fulfill(
            body=THREE_FIXTURE, content_type="text/html"))
        self.files = []
        for index in range(3):
            path = Path(self.directory.name) / f"image-{index}.png"
            pixels = np.random.default_rng(index + 30).integers(20, 235, (120, 160, 3), dtype=np.uint8)
            path.write_bytes(cv2.imencode(".png", pixels)[1].tobytes())
            self.files.append(str(path))
        self.urls = {"local-1": "https://test.bdstatic.com/body-1.png",
                     "local-2": "https://test.bdstatic.com/body-2.png"}
        for index, url in enumerate(self.urls.values(), 1):
            await self.page.route(url, lambda route, request, path=self.files[index]: route.fulfill(
                path=path, content_type="image/png"))
        self.payload = {"landscapePath": self.files[0],
                        "articleHtml": '<p>正文</p><img src="local-1"><img src="local-2">',
                        "images": [{"url": f"local-{i}", "path": self.files[i]} for i in (1, 2)]}
        prepare_article_cover_images(self.payload)
        self.helpers = LocalSourceHelpers()
        await self.page.goto("https://article-fixture.test/three")
        await self.page.evaluate("window.setGallery", list(reversed(self.urls.values())))

    async def upload(self, **kwargs):
        return await asyncio.wait_for(covers_v2.article_covers(
            self.page, self.payload, self.helpers, self.urls, **kwargs), 10)

    async def verify(self, covers, **kwargs):
        return await asyncio.wait_for(covers_v2.verify_article_covers(
            self.page, covers, self.helpers, **kwargs), 3)

    @browser_test
    async def test_bridge_stages_sequential_body_uploads_and_verifies_three_covers_without_pixels(self):
        self.payload.update(title="完整图文", target="baijiahao-article", jobId="v2-fixture")
        await self.page.evaluate("""urls => {
          const insert=document.createElement('button');insert.className='edui-for-insertimage';
          insert.textContent='插入图片';document.body.append(insert);
          const modal=document.createElement('div');modal.role='dialog';modal.style.display='none';
          modal.innerHTML='<div>本地图片</div><input type="file" accept="image/*"><p></p><button>确认</button>';
          document.body.append(modal);window.bodyUploads=[];
          insert.onclick=()=>{modal.style.display='block';modal.querySelector('p').textContent=''};
          modal.querySelector('input').onchange=e=>{
            window.bodyUploads.push([...e.target.files].map(f=>f.name));
            modal.querySelector('p').textContent='1张上传成功';
          };
          modal.querySelector('button').onclick=()=>{
            const image=window.UE_V2.instants.editor.body.ownerDocument.createElement('img');
            image.src=urls[window.bodyUploads.length-1];window.UE_V2.instants.editor.body.append(image);
            modal.style.display='none';modal.querySelector('input').value='';
          };
          window.name='huobao-sau-v2-fixture';window.__huobaoSauDocumentToken='v2-fixture-token';
        }""", list(self.urls.values()))
        details = await asyncio.wait_for(bridge.stage_article(self.page, self.payload, self.helpers), 10)
        self.assertEqual(await self.page.evaluate("window.bodyUploads"), [["image-1.png"], ["image-2.png"]])
        self.assertEqual([item["path"] for item in details["covers"]["items"]], self.files)
        state = {"details": details, "documentToken": "v2-fixture-token"}
        await asyncio.wait_for(bridge.verify_staged(
            self.page, self.payload, state, (None, None, None, self.helpers, None, None)), 3)
        saved = await asyncio.wait_for(bridge.verify_saved_article(
            self.page, self.payload, self.helpers, covers=details["covers"]), 3)
        self.assertEqual(saved["coverMode"], "three")
        self.assertEqual(saved["images"], 2)
        self.assertEqual([item["sha256"] for item in saved["covers"]],
                         [hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in self.files])
        self.assertTrue(all(item["verification"] == "selected_source_and_preview" for item in saved["covers"]))

    @browser_test
    async def test_main_then_two_body_images_follow_body_order_not_gallery_order(self):
        checkpoints = []
        result = await self.upload(checkpoint=lambda value: checkpoints.append(dict(value)))
        self.assertEqual(result["mode"], "three")
        self.assertEqual([item["path"] for item in result["items"]], self.files)
        self.assertEqual([item["preview"] for item in result["items"]][1:], list(self.urls.values()))
        self.assertEqual(await self.helpers._browser_digest(self.page, result["items"][0]["preview"]),
                         hashlib.sha256(Path(self.files[0]).read_bytes()).hexdigest())
        self.assertEqual(await self.page.evaluate("[window.selections, window.confirmations]"), [1, 1])
        self.assertEqual(checkpoints[-1]["items"], result["items"])
        self.assertEqual(await self.verify(result, bound=True), result["items"])

    @browser_test
    async def test_controlled_radio_reverts_then_commits_and_renders_slots_later(self):
        await self.page.evaluate("""() => {
          const radio=document.querySelector('input[value=three]');
          window.radioClicks=0;
          radio.onchange=()=>{
            window.radioClicks++;
            document.querySelector('input[value=one]').checked=true;
            setTimeout(()=>{radio.checked=true}, 120);
            setTimeout(()=>{window.covers=[null,null,null];slots()}, 350);
          };
        }""")
        covers = await self.upload()
        self.assertEqual(len(covers["items"]), 3)
        self.assertEqual(await self.page.evaluate("window.radioClicks"), 1)
        self.assertTrue(await self.page.locator('input[value=three]').is_checked())

    @browser_test
    async def test_remote_compression_and_undecodable_pixels_do_not_block_covers(self):
        remote_main = "https://test.bdstatic.com/uploaded-main.jpg"
        # A compressed/marked platform derivative need not resemble the local
        # source pixel-for-pixel. The second remote image cannot be decoded.
        compressed = cv2.imencode(".jpg", np.full((60, 80, 3), 140, dtype=np.uint8),
                                 [cv2.IMWRITE_JPEG_QUALITY, 10])[1].tobytes()
        await self.page.route(remote_main, lambda route: route.fulfill(body=compressed, content_type="image/jpeg"))
        await self.page.route(self.urls["local-2"], lambda route: route.fulfill(
            body=b"platform preview cannot be decoded", content_type="image/webp"))
        await self.page.evaluate("""remote => {
          document.querySelector('#local-cover').onchange=e=>{
            window.selections++;e.target.value='';
            setTimeout(()=>{
              window.gallery.unshift({src:remote});
              window.chosen=window.chosen.map(i=>i+1).concat(0);render();
            }, 150);
          };
        }""", remote_main)
        covers = await self.upload()
        expected = [remote_main, self.urls["local-1"], self.urls["local-2"]]
        self.assertEqual([item["preview"] for item in covers["items"]], expected)
        self.assertEqual(covers["sources"], expected)
        self.assertEqual(await self.verify(covers), covers["items"])

    @browser_test
    async def test_local_blob_replaced_by_uploaded_url_waits_for_upload_completion(self):
        remote = "https://test.bdstatic.com/main-complete.webp"
        await self.page.route(remote, lambda route: route.fulfill(body=b"opaque preview", content_type="image/webp"))
        await self.page.evaluate("""remote => {
          const input=document.querySelector('#local-cover'), original=input.onchange;
          input.onchange=e=>{
            original(e);
            const notice=document.createElement('div');notice.textContent='上传中 50%';
            document.querySelector('[role=dialog]').append(notice);
            setTimeout(()=>{window.gallery[0].src=remote;notice.remove();render()},250);
          };
        }""", remote)
        covers = await self.upload()
        self.assertEqual(covers["items"][0]["preview"], remote)
        self.assertEqual(await self.page.evaluate("window.selections"), 1)

    @browser_test
    async def test_distinct_cropped_urls_and_delayed_final_previews_are_accepted(self):
        await self.page.evaluate("""() => {
          const originalRender=render;
          render=()=>{
            originalRender();
            document.querySelectorAll('#previews img').forEach((image,i)=>{
              image.src=`https://test.bdstatic.com/crop-${i}.webp`;
            });
          };
          const confirm=document.querySelector('#confirm'), original=confirm.onclick;
          confirm.onclick=()=>{
            original();window.covers=[null,null,null];slots();
            setTimeout(()=>{
              window.covers=[0,1,2].map(i=>`https://test.bdstatic.com/saved-${i}.webp`);slots();
            },200);
          };
        }""")
        covers = await self.upload()
        self.assertEqual([item["preview"] for item in covers["items"]],
                         [f"https://test.bdstatic.com/saved-{i}.webp" for i in range(3)])
        self.assertEqual(await self.verify(covers), covers["items"])

    @browser_test
    async def test_radio_that_never_commits_times_out_before_upload(self):
        await self.page.evaluate("""() => {
          document.querySelector('input[value=three]').onchange=()=>{
            document.querySelector('input[value=one]').checked=true;
          };
        }""")
        with patch.object(covers_v2, "_READY_TIMEOUT", 0.5):
            with self.assertRaisesRegex(TimeoutError, "控件未就绪"):
                await self.upload()
        self.assertEqual(await self.page.evaluate("[window.selections,window.confirmations]"), [0, 0])

    @browser_test
    async def test_reordered_previews_are_rejected_by_default_and_bound_verification(self):
        covers = await self.upload()
        await self.page.evaluate("""() => {
          [window.covers[1],window.covers[2]]=[window.covers[2],window.covers[1]];slots();
        }""")
        for bound in (False, True):
            with self.subTest(bound=bound), self.assertRaisesRegex(RuntimeError, "顺序|替换"):
                await self.verify(covers, bound=bound)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    @browser_test
    async def test_confirmation_cannot_silently_reorder_the_known_sources(self):
        await self.page.evaluate("""() => {
          const confirm=document.querySelector('#confirm'), original=confirm.onclick;
          confirm.onclick=()=>{original();window.covers.reverse();slots()};
        }""")
        with self.assertRaisesRegex(RuntimeError, "顺序"):
            await self.upload()

    @browser_test
    async def test_duplicate_or_missing_saved_slots_fail(self):
        covers = await self.upload()
        original = [item["preview"] for item in covers["items"]]
        for last, message in ((original[1], "重复"), (None, "不完整")):
            with self.subTest(last=last):
                await self.page.evaluate("urls=>{window.covers=urls;slots()}", [*original[:2], last])
                with self.assertRaisesRegex(RuntimeError, message):
                    await self.verify(covers)

    @browser_test
    async def test_duplicate_body_upload_mapping_fails_before_upload(self):
        self.urls["local-2"] = self.urls["local-1"]
        with self.assertRaisesRegex(RuntimeError, "重复"):
            await self.upload()
        self.assertEqual(await self.page.evaluate("[window.selections,window.confirmations]"), [0, 0])

    @browser_test
    async def test_missing_body_upload_mapping_fails_before_upload(self):
        del self.urls["local-2"]
        with self.assertRaisesRegex(RuntimeError, "映射"):
            await self.upload()
        self.assertEqual(await self.page.evaluate("[window.selections,window.confirmations]"), [0, 0])

    @browser_test
    async def test_missing_gallery_image_times_out_without_confirmation(self):
        await self.page.evaluate("window.setGallery", [self.urls["local-1"]])
        with patch.object(covers_v2, "_READY_TIMEOUT", 0.5):
            with self.assertRaisesRegex(TimeoutError, "图库缺少"):
                await self.upload()
        self.assertEqual(await self.page.evaluate("window.confirmations"), 0)

    @browser_test
    async def test_duplicate_gallery_image_fails_without_confirmation(self):
        await self.page.evaluate("window.setGallery", [*self.urls.values(), self.urls["local-1"]])
        with self.assertRaisesRegex(RuntimeError, "重复来源"):
            await self.upload()
        self.assertEqual(await self.page.evaluate("window.confirmations"), 0)

    @browser_test
    async def test_missing_preview_after_confirmation_times_out(self):
        await self.page.evaluate("""() => {
          const confirm=document.querySelector('#confirm'), original=confirm.onclick;
          confirm.onclick=()=>{original();window.covers[2]=null;slots()};
        }""")
        with patch.object(covers_v2, "_READY_TIMEOUT", 0.5):
            with self.assertRaisesRegex(TimeoutError, "确认后缺少"):
                await self.upload()
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    @browser_test
    async def test_crop_processing_notice_retries_without_reupload(self):
        await self.page.evaluate("window.cropPending=1")
        covers = await self.upload()
        self.assertEqual(len(covers["items"]), 3)
        self.assertEqual(await self.page.evaluate("[window.selections,window.confirmations]"), [1, 2])

    @browser_test
    async def test_completed_legacy_covers_can_be_verified_without_more_actions(self):
        covers = await self.upload()
        legacy = {"mode": "three", "plan": covers["plan"], "items": covers["items"]}
        repeated = await self.upload(previous=legacy)
        self.assertEqual(repeated["items"], covers["items"])
        self.assertEqual(await self.page.evaluate("[window.selections,window.confirmations]"), [1, 1])

    @browser_test
    async def test_changed_local_source_fails_verification(self):
        covers = await self.upload()
        Path(self.files[0]).write_bytes(Path(self.files[1]).read_bytes())
        with self.assertRaisesRegex(RuntimeError, "原文件已变化"):
            await self.verify(covers)

    @browser_test
    async def test_unknown_preselection_is_not_overwritten(self):
        await self.page.locator('label').filter(has_text="三图").click()
        await self.page.locator('text="选择封面"').first.click()
        await self.page.evaluate("""() => {
          window.gallery.push({src:'https://test.bdstatic.com/unknown.png'});
          window.chosen=[2];render();
        }""")
        with self.assertRaisesRegex(RuntimeError, "人工选择"):
            await self.upload()
        self.assertEqual(await self.page.evaluate("[window.selections,window.confirmations]"), [0, 0])


if __name__ == "__main__":
    unittest.main()
