import asyncio
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import cv2
import numpy as np
from playwright.async_api import async_playwright
from article_cover_selection import prepare_article_cover_images


spec = importlib.util.spec_from_file_location("article_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


FIXTURE = """<!doctype html><meta charset="utf-8">
<div data-testid="news-title-input"><div contenteditable="true"></div></div>
<iframe id="article-body"></iframe>
<button id="choose-cover">选择封面</button>
<div class="article-cover" style="width:160px;height:120px"></div>
<div role="dialog" style="display:none">
  <div role="tab" aria-selected="true">正文/本地上传(1)</div>
  <div role="tabpanel">
    <div class="cheetah-upload-select"><input type="file" accept="image/*"><canvas width="160" height="120"></canvas></div>
    <div class="cheetah-upload-select"><input id="local-cover" type="file" accept="image/*"><span>本地上传</span></div>
    <div>封面预览 (4:3)</div>
    <div class="editor-coverItem" style="width:68px;height:51px"><img></div>
    <button id="confirm-cover">确定 (1)</button>
  </div>
</div>
<script>
window.selections = 0; window.confirmations = 0; window.contentWrites = 0;
const frame = document.querySelector('iframe');
const editor = {isReady:true,iframe:frame,body:frame.contentDocument.body,
  getContent:()=>editor.body.innerHTML,
  setContent:html=>{window.contentWrites++;editor.body.innerHTML=html},fireEvent:()=>{}};
window.UE_V2={instants:{editor}};
document.querySelector('#choose-cover').onclick=()=>document.querySelector('[role=dialog]').style.display='block';
document.querySelector('#local-cover').onchange=async e=>{
  window.selections++;
  const file=e.target.files[0], bitmap=await createImageBitmap(file);
  const canvas=document.querySelector('canvas');canvas.getContext('2d').drawImage(bitmap,0,0,160,120);
  document.querySelector('.editor-coverItem img').src=URL.createObjectURL(file);
  if(window.clearSelectedFile)e.target.value='';
};
document.querySelector('#confirm-cover').onclick=()=>{
  window.confirmations++;
  const src=document.querySelector('.editor-coverItem img').src;
  if(window.coverDelay)setTimeout(()=>document.querySelector('.article-cover').style.backgroundImage=`url("${src}")`,window.coverDelay);
  else document.querySelector('.article-cover').style.backgroundImage=`url("${src}")`;
  document.querySelector('[role=dialog]').style.display='none';
};
</script>"""


THREE_FIXTURE = """<!doctype html><meta charset="utf-8">
<style>.editor-hotArea{width:24px;height:24px;cursor:pointer}.editor-imgItem{display:inline-block}</style>
<div data-testid="news-title-input"><div contenteditable="true"></div></div><iframe></iframe>
<label><input type="radio" name="cover" value="one" checked>单图</label>
<label><input type="radio" name="cover" value="three">三图</label>
<div class="editor-list editor-three"></div>
<div role="dialog" style="display:none">
 <div role="tab" aria-selected="true">正文/本地上传</div>
 <div class="cheetah-upload-select"><input type="file" accept="image/*"><canvas></canvas></div>
 <div class="cheetah-upload-select"><input id="local-cover" type="file" accept="image/*"><span>本地上传</span></div>
 <div class="editor-imglist"></div>
 <div>封面预览 (4:3)</div><div id="previews"></div>
 <button id="confirm">确定 (0)</button>
</div>
<script>
window.selections=0;window.confirmations=0;window.contentWrites=0;window.chosen=[];window.covers=[null];
const frame=document.querySelector('iframe'),editor={isReady:true,iframe:frame,body:frame.contentDocument.body,
 getContent:()=>editor.body.innerHTML,setContent:html=>{window.contentWrites++;editor.body.innerHTML=html},fireEvent:()=>{}};
window.UE_V2={instants:{editor}};
function slots(){
 const root=document.querySelector('.editor-list');root.innerHTML='';
 window.covers.forEach((src,i)=>{
  const slot=document.createElement('div');slot.className='editor-item';slot.style='width:198px;height:148px';
  slot.innerHTML=src?`<div class="editor-coverWrapper"><img class="editor-coverImg" style="width:198px;height:148px" src="${src}"></div>`:'<div>选择封面</div>';
  slot.onclick=()=>{window.chosen=[];document.querySelector('[role=dialog]').style.display='block';render()};root.append(slot);
 });
}
function render(){
 const selected=window.chosen.map(i=>window.gallery[i].src),previews=window.covers.filter(Boolean).concat(selected);
 document.querySelector('#previews').innerHTML=[0,1,2].map(i=>`<div class="editor-coverItem" style="width:68px;height:51px">${previews[i]?`<img src="${previews[i]}">`:''}</div>`).join('');
 document.querySelector('#confirm').textContent=`确定 (${window.chosen.length})`;
 const root=document.querySelector('.editor-imglist');root.innerHTML='';
 window.gallery.forEach((image,i)=>{
  const n=document.createElement('div');n.className='editor-imgItem';n.innerHTML=`<div class="editor-imgWrapper"><img src="${image.src}"></div><div class="editor-hotArea"><div class="editor-checkbox${window.chosen.includes(i)?' editor-selected':''}">${window.chosen.includes(i)?`<span>${window.chosen.indexOf(i)+1}</span>`:''}</div></div>`;
  n.querySelector('.editor-hotArea').onclick=()=>{window.chosen=window.chosen.includes(i)?window.chosen.filter(v=>v!==i):window.chosen.concat(i);render()};root.append(n);
 });
}
window.gallery=[];window.setGallery=images=>{window.gallery=images.map(src=>({src}));render()};
document.querySelector('input[value=three]').onchange=()=>{window.covers=[...window.covers,null,null].slice(0,3);slots()};
document.querySelector('#local-cover').onchange=e=>{
 window.selections++;const src=URL.createObjectURL(e.target.files[0]);window.gallery.unshift({src});
 window.chosen=window.chosen.map(i=>i+1).concat(0);e.target.value='';render();
};
document.querySelector('#confirm').onclick=()=>{
 window.confirmations++;
 if(window.cropPending){window.cropPending--;const notice=document.createElement('div');notice.setAttribute('role','alert');notice.textContent='封面裁剪处理中，请稍后再点击“确定”';document.body.append(notice);return}
 const selected=window.chosen.map(i=>window.gallery[i].src);let cursor=0;
 window.covers=window.covers.map(src=>src||selected[cursor++]||null);slots();document.querySelector('[role=dialog]').style.display='none';
};slots();
</script>"""


class ArticleBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="huobao-article-test-")
        self.addCleanup(self.directory.cleanup)
        self.cover = Path(self.directory.name) / "cover.png"
        image = np.full((120, 160, 3), 220, dtype=np.uint8)
        image[15:90, 10:80] = (68, 85, 34)
        image[45:110, 90:150] = (68, 51, 191)
        self.cover.write_bytes(cv2.imencode(".png", image)[1].tobytes())
        self.playwright = await async_playwright().start()
        self.addAsyncCleanup(self.playwright.stop)
        self.browser = await self.playwright.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        self.addAsyncCleanup(self.page.context.close)
        await self.page.route("https://article-fixture.test/**", lambda route: route.fulfill(body=FIXTURE, content_type="text/html"))
        await self.page.goto("https://article-fixture.test/editor")
        root = str(Path.home() / ".local/share/social-auto-upload")
        if root not in sys.path:
            sys.path.insert(0, root)
        self.helpers = bridge.load_engine()[3]

    async def test_cover_uses_local_upload_among_two_inputs_and_numbered_confirm(self):
        result = await asyncio.wait_for(bridge.article_cover(self.page, str(self.cover), self.helpers), 8)
        self.assertTrue(result["preview"])
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)
        self.assertEqual(await self.page.locator('[role="dialog"]:visible').count(), 0)

    async def test_cover_reuses_original_open_dialog_without_uploading_again(self):
        await self.page.locator('#choose-cover').click()
        await self.page.locator('#local-cover').set_input_files(str(self.cover))
        result = await asyncio.wait_for(bridge.article_cover(self.page, str(self.cover), self.helpers), 8)
        self.assertTrue(result["preview"])
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_platform_clearing_file_input_keeps_verified_blob_without_reupload(self):
        await self.page.evaluate("window.clearSelectedFile=true")
        result = await asyncio.wait_for(bridge.article_cover(self.page, str(self.cover), self.helpers), 8)
        self.assertTrue(result["preview"])
        self.assertEqual(await self.page.locator('#local-cover').evaluate("e=>e.files.length"), 0)
        self.assertEqual(await self.page.evaluate("window.selections"), 1)

    async def test_confirm_waits_for_asynchronous_editor_cover_preview(self):
        await self.page.evaluate("window.coverDelay=200")
        result = await asyncio.wait_for(bridge.article_cover(self.page, str(self.cover), self.helpers), 8)
        self.assertTrue(result["preview"])
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_populated_article_resumes_cover_without_retyping_or_reupload(self):
        url = "https://test.bdstatic.com/body.png"
        await self.page.route(url, lambda route: route.fulfill(path=str(self.cover), content_type="image/png"))
        payload = {"title": "保留原来的标题", "articleHtml": '<p>保留原来的正文。</p><img src="local-image">',
                   "images": [{"url": "local-image", "path": str(self.cover)}], "landscapePath": str(self.cover)}
        await self.page.locator('[contenteditable]').fill(payload["title"])
        await self.page.evaluate("html=>window.UE_V2.instants.editor.setContent(html)", '<p>保留原来的正文。</p><img src="' + url + '">')
        await self.page.locator('#choose-cover').click()
        with patch('article_covers_v2.article_covers', new=AsyncMock(return_value={"mode": "three", "items": []})):
            result = await asyncio.wait_for(bridge.stage_article(self.page, payload, self.helpers, reuse_upload=True), 8)
        self.assertEqual(result["article"]["text"], "保留原来的正文。")
        self.assertEqual(await self.page.evaluate("window.contentWrites"), 1)
        self.assertEqual(await self.page.locator('[contenteditable]').inner_text(), payload["title"])
        self.assertEqual(await self.page.evaluate("window.selections"), 0)

    async def test_changed_article_cannot_resume_cover_or_overwrite_content(self):
        payload = {"title": "原来的标题", "articleHtml": '<p>原来的正文。</p>', "images": [], "landscapePath": str(self.cover)}
        await self.page.locator('[contenteditable]').fill("人工改过的标题")
        await self.page.evaluate("() => window.UE_V2.instants.editor.setContent('<p>人工改过的正文。</p>')")
        with self.assertRaises(RuntimeError):
            await bridge.stage_article(self.page, payload, self.helpers, reuse_upload=True)
        self.assertEqual(await self.page.evaluate("window.contentWrites"), 1)


class ThreeCoverBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await ArticleBrowserTest.asyncSetUp(self)
        await self.page.unroute("https://article-fixture.test/**")
        await self.page.route("https://article-fixture.test/**", lambda route: route.fulfill(body=THREE_FIXTURE, content_type="text/html"))
        await self.page.goto("https://article-fixture.test/three")
        self.page.set_default_timeout(2000)
        self.body_images = []
        self.urls = {}
        for index in (1, 2):
            filename = Path(self.directory.name) / f"body-{index}.png"
            image = np.random.default_rng(index).integers(20, 235, (120, 160, 3), dtype=np.uint8)
            filename.write_bytes(cv2.imencode(".png", image)[1].tobytes())
            url = f"https://test.bdstatic.com/body-{index}.png"
            await self.page.route(url, lambda route, request, filename=filename: route.fulfill(path=str(filename), content_type="image/png"))
            self.body_images.append({"url": f"local-{index}", "path": str(filename)})
            self.urls[f"local-{index}"] = url
        self.payload = {"title": "三图标题", "articleHtml": '<p>保留完整正文。</p><img src="local-1"><img src="local-2">',
                        "images": self.body_images, "landscapePath": str(self.cover)}
        prepare_article_cover_images(self.payload)
        await self.page.evaluate("window.setGallery", list(self.urls.values()))

    async def test_three_covers_use_project_cover_and_two_existing_body_images(self):
        result = await asyncio.wait_for(bridge.article_covers(self.page, self.payload, self.helpers, self.urls), 10)
        self.assertTrue(await self.page.locator('input[value=three]').is_checked())
        self.assertEqual(result["mode"], "three")
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual([item["path"] for item in result["items"]], [str(self.cover), *[image["path"] for image in self.body_images]])
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_existing_main_cover_is_retained_and_two_body_images_are_not_reuploaded(self):
        await self.page.route("https://test.bdstatic.com/main.png", lambda route: route.fulfill(path=str(self.cover), content_type="image/png"))
        await self.page.evaluate("window.covers=['https://test.bdstatic.com/main.png'];slots()")
        result = await asyncio.wait_for(bridge.article_covers(self.page, self.payload, self.helpers, self.urls), 10)
        self.assertEqual(result["items"][0]["preview"], "https://test.bdstatic.com/main.png")
        self.assertEqual(await self.page.evaluate("window.selections"), 0)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_three_covers_resume_without_another_upload_or_confirmation(self):
        result = await bridge.article_covers(self.page, self.payload, self.helpers, self.urls)
        repeated = await bridge.article_covers(self.page, self.payload, self.helpers, self.urls, previous=result)
        self.assertEqual([item["preview"] for item in result["items"]], [item["preview"] for item in repeated["items"]])
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_crop_processing_notice_retries_cover_confirmation_without_reupload(self):
        await self.page.evaluate("window.cropPending=1")
        result = await asyncio.wait_for(bridge.article_covers(self.page, self.payload, self.helpers, self.urls), 15)
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 2)
        self.assertEqual(await self.page.locator('[role="dialog"]:visible').count(), 0)

    async def test_platform_preselected_unused_body_image_is_replaced_with_planned_covers(self):
        url = "https://test.bdstatic.com/unused-body.png"
        unused = Path(self.directory.name) / "unused-body.png"
        unused.write_bytes(cv2.imencode(".png", np.full((120, 160, 3), 128, dtype=np.uint8))[1].tobytes())
        await self.page.route(url, lambda route: route.fulfill(path=str(unused), content_type="image/png"))
        self.payload["images"].insert(0, {"url": "local-unused", "path": str(unused)})
        self.payload["articleHtml"] = '<img src="local-unused">' + self.payload["articleHtml"]
        self.urls["local-unused"] = url
        await self.page.evaluate("window.setGallery", [url, self.urls["local-1"], self.urls["local-2"]])
        await self.page.locator('input[value=three]').check()
        await self.page.locator(bridge._ARTICLE_COVER_SLOTS).first.click()
        await self.page.evaluate("window.chosen=[0];render()")
        result = await asyncio.wait_for(bridge.article_covers(self.page, self.payload, self.helpers, self.urls), 10)
        self.assertEqual([item["path"] for item in result["items"]],
                         [str(self.cover), *[image["path"] for image in self.body_images[1:]]])
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_unknown_preselected_gallery_image_is_not_overwritten(self):
        url = "https://test.bdstatic.com/unknown.png"
        await self.page.route(url, lambda route: route.fulfill(path=self.body_images[0]["path"], content_type="image/png"))
        await self.page.evaluate("window.setGallery", [url, *self.urls.values()])
        await self.page.locator('input[value=three]').check()
        await self.page.locator(bridge._ARTICLE_COVER_SLOTS).first.click()
        await self.page.evaluate("window.chosen=[0];render()")
        with self.assertRaisesRegex(RuntimeError, "人工选择"):
            await bridge.article_covers(self.page, self.payload, self.helpers, self.urls)
        self.assertEqual(await self.page.evaluate("window.selections"), 0)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 0)

    async def test_three_cover_source_checkpoint_resumes_without_selecting_main_file_again(self):
        checkpoints = []
        def checkpoint(value):
            checkpoints.append(dict(value))
            if value.get("source_sha256_verified"):
                raise RuntimeError("interrupted after source verification")
        with self.assertRaisesRegex(RuntimeError, "interrupted"):
            await bridge.article_covers(self.page, self.payload, self.helpers, self.urls, checkpoint=checkpoint)
        covers = await bridge.article_covers(self.page, self.payload, self.helpers, self.urls, previous=checkpoints[-1])
        self.assertEqual(len(covers["items"]), 3)
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_reordered_three_covers_are_rejected_without_another_confirmation(self):
        covers = await bridge.article_covers(self.page, self.payload, self.helpers, self.urls)
        await self.page.evaluate("[window.covers[1],window.covers[2]]=[window.covers[2],window.covers[1]];slots()")
        with self.assertRaisesRegex(RuntimeError, "三图"):
            await bridge.verify_article_covers(self.page, covers, self.helpers)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_cleared_article_does_not_get_retyped_during_cover_resume(self):
        html = ''.join(f'<img src="{url}">' for url in self.urls.values())
        await self.page.evaluate("html=>window.UE_V2.instants.editor.setContent(html)", html)
        with self.assertRaises(RuntimeError):
            await bridge.stage_article(self.page, self.payload, self.helpers, reuse_upload=True,
                                       previous={"article": {"text": "被人工清空之前的正文", "images": list(self.urls.values())}})
        self.assertEqual(await self.page.locator('[contenteditable]').inner_text(), "")
        self.assertEqual(await self.page.evaluate("window.contentWrites"), 1)
        self.assertEqual(await self.page.evaluate("window.selections"), 0)

    async def test_cover_only_revision_cannot_initialize_an_empty_editor(self):
        with self.assertRaisesRegex(RuntimeError, "已被清空"):
            await bridge.stage_article(self.page, self.payload, self.helpers, reuse_upload=True, covers_only=True)
        self.assertEqual(await self.page.evaluate("window.contentWrites"), 0)
        self.assertEqual(await self.page.evaluate("window.selections"), 0)

    async def test_saved_three_cover_proof_checks_mode_count_and_order(self):
        await self.page.locator('[contenteditable]').fill(self.payload["title"])
        html = '<p>保留完整正文。</p>' + ''.join(f'<img src="{url}">' for url in self.urls.values())
        await self.page.evaluate("html=>window.UE_V2.instants.editor.setContent(html)", html)
        covers = await bridge.article_covers(self.page, self.payload, self.helpers, self.urls)
        evidence = await bridge.verify_saved_article(self.page, self.payload, self.helpers, covers=covers)
        self.assertEqual(evidence["coverMode"], "three")
        self.assertEqual(len(evidence["covers"]), 3)
        await self.page.evaluate("window.covers[2]=null;slots()")
        with self.assertRaisesRegex(RuntimeError, "三图"):
            await bridge.verify_article_covers(self.page, covers, self.helpers)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_another_project_cover_is_not_silently_replaced(self):
        await self.page.evaluate("url=>{window.covers=[url];slots()}", self.urls["local-1"])
        with self.assertRaisesRegex(RuntimeError, "封面"):
            await bridge.article_covers(self.page, self.payload, self.helpers, self.urls)
        self.assertEqual(await self.page.evaluate("window.selections"), 0)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 0)


class LegacyArticleBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await ArticleBrowserTest.asyncSetUp(self)

    async def test_cover_rejects_another_selected_file_without_replacing_it(self):
        other = Path(self.directory.name) / "other.png"
        other.write_bytes(cv2.imencode(".png", np.zeros((120, 160, 3), dtype=np.uint8))[1].tobytes())
        await self.page.locator('#choose-cover').click()
        await self.page.locator('#local-cover').set_input_files(str(other))
        with self.assertRaisesRegex(RuntimeError, "不是项目原封面"):
            await bridge.article_cover(self.page, str(self.cover), self.helpers)
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 0)

    async def test_cover_resumes_after_source_checkpoint_without_second_selection(self):
        checkpoints = []
        def checkpoint(value):
            checkpoints.append(dict(value))
            if value.get("source_sha256_verified"):
                raise RuntimeError("process interrupted after source verification")
        with self.assertRaisesRegex(RuntimeError, "process interrupted"):
            await bridge.article_cover(self.page, str(self.cover), self.helpers, checkpoint=checkpoint)
        result = await bridge.article_cover(self.page, str(self.cover), self.helpers, previous=checkpoints[-1])
        self.assertTrue(result["preview"])
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        self.assertEqual(await self.page.evaluate("window.confirmations"), 1)

    async def test_saved_article_proof_checks_persisted_body_images_and_cover_without_writes(self):
        url = "https://test.bdstatic.com/body.png"
        await self.page.route(url, lambda route: route.fulfill(path=str(self.cover), content_type="image/png"))
        payload = {"title": "草稿标题", "articleHtml": '<p>完整正文。</p><img src="local-image">',
                   "images": [{"url": "local-image", "path": str(self.cover)}], "landscapePath": str(self.cover)}
        await self.page.locator('[contenteditable]').fill(payload["title"])
        await self.page.evaluate("html=>window.UE_V2.instants.editor.setContent(html)", '<p>完整正文。</p><img src="' + url + '">')
        await bridge.article_cover(self.page, str(self.cover), self.helpers)
        evidence = await bridge.verify_saved_article(self.page, payload, self.helpers)
        self.assertEqual(evidence["verification"], "saved_title_body_images_cover")
        self.assertEqual(evidence["images"], 1)
        self.assertEqual(await self.page.evaluate("window.contentWrites"), 1)
        self.assertEqual(await self.page.evaluate("window.selections"), 1)
        await self.page.evaluate("() => window.UE_V2.instants.editor.body.querySelector('p').textContent='不一致的正文'")
        with self.assertRaisesRegex(RuntimeError, "不一致"):
            await bridge.verify_saved_article(self.page, payload, self.helpers)

    async def test_saved_article_accepts_platform_http_proxy_upgraded_to_https(self):
        url = "https://baijiahao.baidu.com/bjh/picproxy?image=1"
        await self.page.route(url, lambda route: route.fulfill(path=str(self.cover), content_type="image/png"))
        payload = {"title": "草稿标题", "articleHtml": '<p>正文。</p><img src="local-image">',
                   "images": [{"url": "local-image", "path": str(self.cover)}], "landscapePath": str(self.cover)}
        await self.page.locator('[contenteditable]').fill(payload["title"])
        await self.page.evaluate("html=>window.UE_V2.instants.editor.setContent(html)", '<p>正文。</p><img src="' + url.replace("https:", "http:") + '">')
        frame = await bridge.article_editor(self.page)
        await frame.wait_for_function("() => document.querySelector('img').complete && document.querySelector('img').naturalWidth > 0")
        await bridge.article_cover(self.page, str(self.cover), self.helpers)
        evidence = await bridge.verify_saved_article(self.page, payload, self.helpers)
        self.assertEqual(evidence["images"], 1)
        self.assertEqual(await self.page.evaluate("window.contentWrites"), 1)


if __name__ == "__main__":
    unittest.main()
