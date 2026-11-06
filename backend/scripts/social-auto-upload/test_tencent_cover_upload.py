import asyncio
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import cv2
import numpy as np
from playwright.async_api import async_playwright

sys.path.insert(0, str(Path.home() / ".local/share/social-auto-upload"))
from uploader.tencent_uploader import stage as installed_helpers
from editor_compat import TencentCovers, fill_tencent_metadata
helpers = TencentCovers(installed_helpers)
import tencent_cover_upload as adapter
import bridge


FIXTURE = r'''<!doctype html><meta charset="utf-8">
<style>
 .vertical-cover-wrap,.horizon-cover-wrap{display:inline-block;width:190px;vertical-align:top}
 .vertical-img-wrap,.horizon-img-wrap{position:relative;width:160px;height:180px;cursor:pointer}
 .vertical-img-wrap img{width:120px;height:160px}.horizon-img-wrap img{width:160px;height:120px}
 .edit-btn{position:absolute;bottom:0;left:0}.hit-layer{position:absolute;inset:0;z-index:2}
 .weui-desktop-dialog{position:fixed;top:20px;left:20px;width:450px;padding:16px;background:white;z-index:10}
 .weui-desktop-dialog img{display:block;width:120px}
 .crop-dialog{z-index:20}.ant-popover{position:fixed;top:220px;left:20px;background:white;z-index:30}
</style><main></main>
<script>
 const root=document.querySelector('main').attachShadow({mode:'open'});
 root.innerHTML=`<style>${document.querySelector('style').textContent}</style>
  <div class="vertical-cover-wrap"><div class="vertical-img-wrap"><img><button class="edit-btn">编辑</button><div class="hit-layer"></div></div></div>
  <div class="horizon-cover-wrap"><div class="horizon-img-wrap"><img><button class="edit-btn">编辑</button><div class="hit-layer"></div></div></div>
  <button id="save">保存草稿</button><button id="publish">发表</button>`;
 window.actions={portrait:0,landscape:0,opened:0,crop:0,confirmed:0,recommended:0,save:0,publish:0};
 window.withCrop=true;
 const slot=kind=>root.querySelector(kind==='portrait'?'.vertical-cover-wrap':'.horizon-cover-wrap');
 const title=kind=>kind==='portrait'?'编辑个人主页卡片':'编辑分享卡片';
 window.showCover=kind=>{
  actions.opened++;
  const dialog=document.createElement('div');dialog.className='weui-desktop-dialog';
  dialog.innerHTML=`<h3 class="weui-desktop-dialog__title">${title(kind)}</h3><img>
   <div class="single-cover-uploader-wrap"><input type="file" accept="image/*"></div><button>确认</button>`;
  root.append(dialog);
  const input=dialog.querySelector('input');
  input.addEventListener('change',()=>{
   actions[kind]++;
   const src=URL.createObjectURL(input.files[0]);input.value='';
   const update=()=>{dialog.querySelector('img').src=src};
   if(!window.withCrop){update();return}
   const crop=document.createElement('div');crop.className='weui-desktop-dialog crop-dialog';
   const width=kind==='portrait'?90:120,height=kind==='portrait'?120:90;
   crop.innerHTML=`<h3 class="weui-desktop-dialog__title">裁剪封面图</h3><img src="${src}">
    <div class="cropper-crop-box" style="width:${width}px;height:${height}px"></div><button>确定</button>`;
   root.append(crop);
   crop.querySelector('button').onclick=()=>{actions.crop++;update();crop.remove()};
  });
  dialog.querySelector('button').onclick=()=>{
   actions.confirmed++;slot(kind).querySelector('img').src=dialog.querySelector('img').src;dialog.remove();
  };
 };
 function choose(kind){
  if(!window.materialPopup){showCover(kind);return}
  const popup=document.createElement('div');popup.className='ant-popover';
  popup.innerHTML='<span>使用此素材作为封面？</span><button>使用素材</button>';
  popup.querySelector('button').onclick=()=>{actions.recommended++;showCover(kind);
    if(window.popupFadeMs)setTimeout(()=>popup.remove(),window.popupFadeMs);else popup.remove()};
  root.append(popup);
 }
 for(const kind of ['portrait','landscape']){
  slot(kind).querySelector('.edit-btn').onclick=e=>e.stopPropagation();
  slot(kind).firstElementChild.onclick=()=>choose(kind);
 }
 root.querySelector('#save').onclick=()=>actions.save++;
 root.querySelector('#publish').onclick=()=>actions.publish++;
</script>'''


class TencentCoverBrowserTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="huobao-tencent-covers-")
        self.addCleanup(self.directory.cleanup)
        self.payload = {}
        for kind, (width, height) in {"portrait": (90, 120), "landscape": (120, 90)}.items():
            image = np.full((height, width, 3), (30, 80, 180), dtype=np.uint8)
            image[height // 4:height // 2, width // 4:width // 2] = (210, 160, 30)
            filename = Path(self.directory.name) / f"{kind}.png"
            filename.write_bytes(cv2.imencode(".png", image)[1].tobytes())
            self.payload[f"{kind}Path"] = str(filename)
        self.playwright = await async_playwright().start()
        self.addAsyncCleanup(self.playwright.stop)
        self.browser = await self.playwright.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        self.addAsyncCleanup(self.page.context.close)
        self.page.set_default_timeout(1500)
        await self.page.route("https://tencent-cover-fixture.test/**", lambda route: route.fulfill(body=FIXTURE, content_type="text/html"))
        await self.page.goto("https://tencent-cover-fixture.test/editor")

    async def test_outer_image_click_opens_cover_dialog(self):
        original = helpers._open_dialog
        with self.assertRaisesRegex(TimeoutError, "edit dialog did not open"):
            await original(self.page, "portrait", 0.2)
        dialog = await adapter.open_tencent_cover_dialog(self.page, "portrait", helpers, timeout=2)
        self.assertEqual(await helpers._dialog_title(dialog), "编辑个人主页卡片")
        self.assertIs(helpers._open_dialog, original)

    async def test_open_editor_is_reused_without_clicking_cover_again(self):
        await self.page.evaluate("showCover('portrait')")
        dialog = await adapter.open_tencent_cover_dialog(self.page, "portrait", helpers)
        self.assertEqual(await helpers._dialog_title(dialog), "编辑个人主页卡片")
        self.assertEqual(await self.page.evaluate("actions.opened"), 1)

    async def test_native_click_handles_known_material_recommendation(self):
        await self.page.evaluate("window.materialPopup=true")
        dialog = await adapter.open_tencent_cover_dialog(self.page, "landscape", helpers, timeout=2)
        self.assertEqual(await helpers._dialog_title(dialog), "编辑分享卡片")
        self.assertEqual(await self.page.evaluate("actions.recommended"), 1)

    async def test_recommendation_fade_overlapping_new_dialog_does_not_fail_upload(self):
        await self.page.evaluate("window.materialPopup=true;window.popupFadeMs=500")
        result = await asyncio.wait_for(adapter.upload_tencent_covers(self.page, self.payload, helpers), 10)
        self.assertEqual(result["landscape"]["status"], "uploaded")
        self.assertEqual(await self.page.evaluate("actions.recommended"), 2)
        self.assertEqual(await self.page.evaluate("actions.confirmed"), 2)

    async def test_wrong_editor_and_unknown_popup_are_not_confirmed(self):
        await self.page.evaluate("showCover('landscape')")
        with self.assertRaisesRegex(RuntimeError, "Unexpected dialog"):
            await adapter.open_tencent_cover_dialog(self.page, "portrait", helpers)
        await self.page.locator(".weui-desktop-dialog").evaluate("e=>e.remove()")
        await self.page.locator("main").evaluate('''e=>{
            const popup=document.createElement('div'); popup.className='ant-popover';
            popup.innerHTML='未知操作<button>确定</button>'; e.shadowRoot.append(popup);
        }''')
        with self.assertRaisesRegex(RuntimeError, "Unexpected cover recommendation"):
            await adapter.open_tencent_cover_dialog(self.page, "portrait", helpers)
        self.assertEqual(await self.page.evaluate("actions.confirmed"), 0)

    async def test_both_covers_keep_installed_digest_crop_and_final_verification(self):
        checkpoints = []
        result = await asyncio.wait_for(adapter.upload_tencent_covers(
            self.page, self.payload, helpers, checkpoint=checkpoints.append), 10)
        self.assertEqual(result["layout"], "tencent-dual-cover")
        self.assertEqual(set(checkpoints[0]), {"layout", "portrait"})
        self.assertEqual(set(checkpoints[1]), {"layout", "portrait", "landscape"})
        for kind in ("portrait", "landscape"):
            self.assertEqual(result[kind]["status"], "uploaded")
            self.assertTrue(result[kind]["crop_confirmed"])
            self.assertEqual(result[kind]["source_sha256"], helpers._local_cover(self.payload[f"{kind}Path"], kind)["sha256"])
        self.assertEqual(await self.page.evaluate("actions"), {
            "portrait": 1, "landscape": 1, "opened": 2, "crop": 2,
            "confirmed": 2, "recommended": 0, "save": 0, "publish": 0})

    async def test_existing_initial_portrait_editor_is_filled_without_reopening(self):
        await self.page.evaluate("showCover('portrait')")
        await asyncio.wait_for(adapter.upload_tencent_covers(self.page, self.payload, helpers), 10)
        self.assertEqual(await self.page.evaluate("actions.opened"), 2)
        self.assertEqual(await self.page.evaluate("actions.portrait"), 1)

    async def test_card_class_change_and_horizontal_scroll_still_open_editor(self):
        await self.page.locator('.vertical-img-wrap').evaluate('''e=>{
          e.className='new-card-photo';e.style='width:160px;height:180px;position:relative';
          e.querySelector('img').style='width:120px;height:160px';
          e.closest('.vertical-cover-wrap').style.marginLeft='1700px';
        }''')
        dialog = await adapter.open_tencent_cover_dialog(self.page, 'portrait', helpers, timeout=5)
        self.assertEqual(await helpers._dialog_title(dialog), '编辑个人主页卡片')

    async def test_recompressed_final_cover_does_not_block_completion(self):
        await self.page.evaluate('''()=>{
          const original=window.showCover;
          window.showCover=kind=>{
            original(kind);
            const root=document.querySelector('main').shadowRoot;
            const dialog=root.querySelector('.weui-desktop-dialog');
            dialog.querySelector('button').onclick=async()=>{
              actions.confirmed++;
              const canvas=document.createElement('canvas');
              canvas.width=kind==='portrait'?90:120;canvas.height=kind==='portrait'?120:90;
              const ctx=canvas.getContext('2d');ctx.drawImage(dialog.querySelector('img'),0,0,canvas.width,canvas.height);
              ctx.fillStyle='rgba(255,255,255,.1)';ctx.fillRect(0,0,canvas.width,canvas.height);
              root.querySelector(kind==='portrait'?'.vertical-img-wrap img':'.horizon-img-wrap img').src=canvas.toDataURL('image/jpeg',.6);
              dialog.remove();
            };
          };
        }''')
        result = await asyncio.wait_for(adapter.upload_tencent_covers(self.page, self.payload, helpers), 10)
        self.assertEqual(result['landscape']['status'], 'uploaded')
        self.assertEqual(await self.page.evaluate('actions.confirmed'), 2)

    async def test_browser_preview_does_not_require_remote_pixel_decoder(self):
        with patch.object(installed_helpers, '_image_bytes', new=AsyncMock(side_effect=RuntimeError('proxy denies refetch'))):
            result = await asyncio.wait_for(adapter.upload_tencent_covers(self.page, self.payload, helpers), 10)
        self.assertEqual(result['portrait']['status'], 'uploaded')

    async def test_copy_accepts_dom_whitespace_but_rejects_arbitrary_extra_text(self):
        await self.page.locator('main').evaluate('''e=>{
          const fields=document.createElement('section');
          fields.innerHTML='<input placeholder="短标题"><div class="input-editor" contenteditable></div>';
          e.shadowRoot.append(fields);
        }''')
        # Exercise the real bridge engine wiring, not just the helper in
        # isolation: SAU's old exact-equality writer must not be called.
        app = object.__new__(bridge.load_engine()[1])
        app.short_title, app.desc = '已经保存的短标题', '原有正文。第二段。'
        await app.prepare_video_for_publish(self.page)
        await self.page.locator('.input-editor').evaluate('e=>e.innerHTML="原有正文。<div>\\u200b第二段。</div><span data-type=topic>#历史</span>"')
        result = await bridge.verify_tencent_metadata(self.page, '已经保存的短标题', '原有正文。第二段。')
        self.assertTrue(result['verified'])
        await self.page.locator('.input-editor').evaluate('e=>e.textContent="原有正文。第二段。完全无关的内容"')
        with self.assertRaisesRegex(RuntimeError, '正文已变化'):
            await bridge.verify_tencent_metadata(self.page, '已经保存的短标题', '原有正文。第二段。')

    async def select_existing_cover(self, kind):
        await self.page.evaluate("showCover", kind)
        control = await self.page.locator('.single-cover-uploader-wrap input[type="file"]').element_handle()
        await helpers.set_local_input_file(self.page, control, self.payload[f"{kind}Path"])

    async def test_matching_crop_resumes_without_reselecting_file(self):
        # No checkpoint or JS capture marker: the exact blob source proves the
        # already-selected file even though the platform cleared its input.
        await self.select_existing_cover("landscape")
        checkpoints = []
        await asyncio.wait_for(adapter.upload_tencent_covers(
            self.page, self.payload, helpers, checkpoint=checkpoints.append), 10)
        self.assertEqual(set(checkpoints[0]), {"layout", "landscape"})
        self.assertEqual(await self.page.evaluate("actions.landscape"), 1)
        self.assertEqual(await self.page.evaluate("actions.crop"), 2)

    async def test_selected_edit_preview_resumes_without_reupload(self):
        await self.page.evaluate("window.withCrop=false")
        await self.select_existing_cover("portrait")
        await asyncio.wait_for(adapter.upload_tencent_covers(self.page, self.payload, helpers), 10)
        self.assertEqual(await self.page.evaluate("actions.portrait"), 1)
        self.assertEqual(await self.page.evaluate("actions.confirmed"), 2)

    async def test_unknown_modal_preserves_existing_editor_without_selection(self):
        await self.page.evaluate("showCover('portrait')")
        await self.page.locator(".weui-desktop-dialog__title").evaluate("e=>e.textContent='未知弹窗'")
        with self.assertRaisesRegex(RuntimeError, "Unexpected or ambiguous"):
            await adapter.upload_tencent_covers(self.page, self.payload, helpers)
        self.assertEqual(await self.page.evaluate("actions.portrait"), 0)
        self.assertEqual(await self.page.evaluate("actions.confirmed"), 0)

    async def test_mismatched_crop_is_not_replaced_or_confirmed(self):
        await self.select_existing_cover("portrait")
        image = np.full((120, 90, 3), 220, dtype=np.uint8)
        Path(self.payload["portraitPath"]).write_bytes(cv2.imencode(".png", image)[1].tobytes())
        with self.assertRaisesRegex(RuntimeError, "source does not match"):
            await adapter.upload_tencent_covers(self.page, self.payload, helpers)
        self.assertEqual(await self.page.evaluate("actions.portrait"), 1)
        self.assertEqual(await self.page.evaluate("actions.crop"), 0)

    async def test_structured_topics_are_retained_but_body_changes_still_stop_resume(self):
        await self.page.locator('main').evaluate('''e=>{
            const fields=document.createElement('section');
            fields.innerHTML='<input placeholder="短标题" value="已经保存的短标题"><div class="input-editor" contenteditable>原有正文。<span data-type="topic">#历史冷知识</span></div>';
            e.shadowRoot.append(fields);
        }''')
        result = await bridge.verify_tencent_metadata(self.page, '已经保存的短标题', '原有正文。')
        self.assertEqual(result['description'], '原有正文。#历史冷知识')
        await bridge.verify_tencent_metadata(self.page, '已经保存的短标题', '原有正文。', result['description'])
        editor = self.page.locator('.input-editor')
        await editor.evaluate('e=>e.firstChild.textContent="正文被改了。"')
        with self.assertRaisesRegex(RuntimeError, '正文已变化'):
            await bridge.verify_tencent_metadata(self.page, '已经保存的短标题', '原有正文。')
        with self.assertRaisesRegex(RuntimeError, '准备完成后发生变化'):
            await bridge.verify_tencent_metadata(self.page, '已经保存的短标题', '原有正文。', result['description'])


class TencentCoverRecoveryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.payload = {"portraitPath": "portrait.png", "landscapePath": "landscape.png"}
        self.records = {kind: {"status": "uploaded", "source_sha256": kind,
                              "pixels_sha256": f"pixels-{kind}", "preview": f"blob:{kind}"}
                        for kind in ("portrait", "landscape")}
        self.helpers = SimpleNamespace(
            _TITLES=helpers._TITLES,
            _local_cover=lambda path, kind: {"sha256": kind, "pixels": kind},
            _visible_dialogs=AsyncMock(return_value=[]),
            _slot=AsyncMock(side_effect=lambda page, kind: kind),
            _read_preview=AsyncMock(side_effect=lambda page, slot, kind, pixels: {
                "pixels_sha256": f"pixels-{kind}", "preview": f"blob:{kind}"}),
            verify_covers=AsyncMock(side_effect=lambda page, covers: covers),
        )
        self.page = object()

    async def test_completed_cover_is_reused_and_only_remaining_cover_is_uploaded(self):
        previous = {"layout": "tencent-dual-cover", "portrait": dict(self.records["portrait"])}
        checkpoints = []
        with patch.object(adapter, "_upload_one", new=AsyncMock(return_value=self.records["landscape"])) as upload:
            result = await adapter.upload_tencent_covers(self.page, self.payload, self.helpers, previous, checkpoints.append)
        self.assertEqual(upload.await_args.args[1], "landscape")
        upload.assert_awaited_once()
        self.assertEqual(result["portrait"], previous["portrait"])
        self.assertEqual(len(checkpoints), 1)
        self.assertEqual(set(previous), {"layout", "portrait"})
        self.helpers.verify_covers.assert_awaited_once_with(self.page, result)

    async def test_two_completed_covers_only_verify_no_upload_or_checkpoint(self):
        previous = {"layout": "tencent-dual-cover", **self.records}
        checkpoint = AsyncMock()
        with patch.object(adapter, "_upload_one", new=AsyncMock()) as upload:
            result = await adapter.upload_tencent_covers(self.page, self.payload, self.helpers, previous, checkpoint)
        upload.assert_not_awaited()
        checkpoint.assert_not_awaited()
        self.assertEqual(result, previous)

    async def test_first_checkpoint_survives_failure_of_second_cover(self):
        checkpoints = []
        with patch.object(adapter, "_upload_one", new=AsyncMock(side_effect=[self.records["portrait"], RuntimeError("second interrupted")])):
            with self.assertRaisesRegex(RuntimeError, "second interrupted"):
                await adapter.upload_tencent_covers(self.page, self.payload, self.helpers, checkpoint=checkpoints.append)
        self.assertEqual(checkpoints, [{"layout": "tencent-dual-cover", "portrait": self.records["portrait"]}])
        self.helpers.verify_covers.assert_not_awaited()

    async def test_changed_completed_source_stops_before_any_upload(self):
        for change in ({"source_sha256": "different"},):
            with self.subTest(change=change):
                previous = {"layout": "tencent-dual-cover", "portrait": {**self.records["portrait"], **change}}
                with patch.object(adapter, "_upload_one", new=AsyncMock()) as upload:
                    with self.assertRaises(RuntimeError):
                        await adapter.upload_tencent_covers(self.page, self.payload, self.helpers, previous)
                upload.assert_not_awaited()

    async def test_recompressed_completed_preview_is_accepted(self):
        previous = {"layout": "tencent-dual-cover", **self.records}
        previous["portrait"] = {**self.records["portrait"], "pixels_sha256": "old-pixels"}
        with patch.object(adapter, "_upload_one", new=AsyncMock()) as upload:
            result = await adapter.upload_tencent_covers(self.page, self.payload, self.helpers, previous)
        upload.assert_not_awaited()
        self.assertEqual(result["portrait"]["status"], "uploaded")


if __name__ == "__main__":
    unittest.main()
