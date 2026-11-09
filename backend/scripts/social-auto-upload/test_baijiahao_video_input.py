"""Browser regressions for Baijiahao's batch-capable video entry point."""

import asyncio
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from playwright.async_api import async_playwright

import bridge
from editor_compat import BaijiahaoEditor


BATCH_INPUT = '<input type="file" multiple="" accept=".mp4, .mov, .mkv, .avi, .webm">'
BLANK_UPLOAD = f"""<div class="FeEditorApp-e844194154160364-blankWrap">
  <div class="FeEditorApp-_5eb0d99a7a8a2180-inputWrap">{BATCH_INPUT}</div>
  <button>Upload video</button>
</div>"""

LAZY_UPLOAD = """<div class="FeEditorApp-e844194154160364-blankWrap">
  <div class="FeEditorApp-_5eb0d99a7a8a2180-inputWrap"></div>
  <button>上传视频</button>
  <script>
    document.querySelector('button').onclick = () => {
      document.querySelector('[class$="-inputWrap"]').innerHTML =
        '<input type="file" accept="video/mp4">';
    };
  </script>
</div>"""


class BaijiahaoVideoInputTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        self.addAsyncCleanup(self.page.context.close)

    async def resolve(self):
        return await bridge.baijiahao_video_input(self.page, timeout=1000)

    async def test_live_batch_input_is_resolved_even_with_multiple_attribute(self):
        await self.page.set_content(BLANK_UPLOAD)
        control, selector = await self.resolve()
        self.assertTrue(await control.evaluate("e => e.multiple"))
        self.assertEqual(await self.page.locator(selector).count(), 1)

    async def test_main_upload_area_wins_over_an_auxiliary_video_input(self):
        await self.page.set_content('<aside><input type="file" accept="video/mp4"></aside>' + BLANK_UPLOAD)
        control, selector = await self.resolve()
        self.assertTrue(await control.evaluate('e => !!e.closest(\'[class$="-blankWrap"]\')'))
        self.assertEqual(await self.page.locator(selector).count(), 1)

    async def test_cdp_injects_one_file_into_exactly_the_resolved_input(self):
        await self.page.set_content('<aside><input id="auxiliary" type="file" accept="video/mp4"></aside>' + BLANK_UPLOAD)
        control, selector = await self.resolve()
        session = await self.page.context.new_cdp_session(self.page)
        try:
            document = await session.send("DOM.getDocument", {"depth": 0})
            nodes = await session.send("DOM.querySelectorAll", {"nodeId": document["root"]["nodeId"], "selector": selector})
            self.assertEqual(len(nodes["nodeIds"]), 1)
            with tempfile.TemporaryDirectory() as directory:
                video = Path(directory) / "one-video.mp4"
                video.write_bytes(b"local file selection fixture")
                await session.send("DOM.setFileInputFiles", {"nodeId": nodes["nodeIds"][0], "files": [str(video)]})
                self.assertEqual(await control.evaluate("e => [...e.files].map(f => f.name)"), [video.name])
                self.assertEqual(await self.page.locator("#auxiliary").evaluate("e => e.files.length"), 0)
        finally:
            await session.detach()

    async def test_legacy_unique_input_remains_supported(self):
        await self.page.set_content('<input type="file" accept="video/mp4">')
        control, selector = await self.resolve()
        self.assertFalse(await control.evaluate("e => e.multiple"))
        self.assertEqual(await self.page.locator(selector).count(), 1)

    async def test_known_feature_tour_is_acknowledged_before_cover_work(self):
        helper = BaijiahaoEditor(SimpleNamespace(_READ_MEDIA='()=>({videos:[{src:"https://preview.test/video"}]})',
            _classify_upload=lambda media: 'complete', _file_digest=lambda path: 'video-sha'))
        for heading, expected in [("视频新增“一键填”功能", True), ("账号安全验证", False)]:
            await self.page.set_content(f'<section>{heading}<button onclick="window.acked=true"><span>我知道了</span></button></section>')
            await self.page.evaluate("window.acked=false")
            self.assertEqual((await helper.verify_upload(self.page, "video.mp4"))["status"], "uploaded")
            self.assertEqual(await self.page.evaluate("window.acked"), expected)

    async def failed_cover_fixture(self):
        await self.page.set_content('''<div class="form-cover">
          <section class="x-cover-container">
            <div data-testid="cover-preview" style="width:160px;height:90px"><img width="160" height="90"></div>
            <input type="file" accept="image/*"></section>
          <section class="x-cover-container">
            <div class="FeEditorApp-d820b38cbcd0c526-error" style="width:93px;height:124px">重选封面</div>
            <input id="video" type="file" accept="video/mp4">
            <input id="portrait" type="file" accept="image/*"></section></div>''')
        await self.page.locator('img').evaluate('''async image => {
          const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
          image.src=canvas.toDataURL();await image.decode();
        }''')

    async def test_failed_portrait_placeholder_remains_a_distinct_recoverable_image_slot(self):
        await self.failed_cover_fixture()
        helpers = bridge.load_engine()[3]
        slots = await helpers._cover_slots(self.page)
        self.assertEqual(set(slots), {"landscape", "portrait"})
        self.assertTrue(slots["landscape"]["src"].startswith("data:image/"))
        self.assertFalse(slots["landscape"]["failed"])
        self.assertIsNone(slots["portrait"]["src"])
        self.assertTrue(slots["portrait"]["failed"])
        self.assertEqual(slots["portrait"]["index"], 1)
        self.assertEqual(slots["portrait"]["image_inputs"], [1])
        control = self.page.locator(helpers._SLOTS).nth(slots["portrait"]["index"]).locator(
            'input[type="file"]').nth(slots["portrait"]["image_inputs"][0])
        with tempfile.TemporaryDirectory() as directory:
            cover = Path(directory) / "portrait.png"
            cover.write_bytes(b"cover fixture")
            await control.set_input_files(str(cover))
            self.assertEqual(await self.page.locator('#portrait').evaluate('e=>e.files.length'), 1)
            self.assertEqual(await self.page.locator('#video').evaluate('e=>e.files.length'), 0)

    async def test_failed_cover_recovery_rejects_ambiguous_slots_or_image_inputs(self):
        helpers = bridge.load_engine()[3]
        for mutation, message in (
            ("document.querySelector('.form-cover').append(document.querySelectorAll('section')[1].cloneNode(true))", "exactly two"),
            ("document.querySelector('#portrait').insertAdjacentHTML('afterend','<input type=file accept=image/*>')", "Ambiguous cover geometry"),
            ("document.querySelector('[class$=\"-error\"]').style.width='150px'", "Ambiguous cover geometry"),
        ):
            with self.subTest(mutation=mutation):
                await self.failed_cover_fixture()
                await self.page.evaluate(mutation)
                with self.assertRaisesRegex(RuntimeError, message):
                    await helpers._cover_slots(self.page)

    async def test_error_placeholder_requires_the_known_reselect_label(self):
        await self.failed_cover_fixture()
        await self.page.locator('[class$="-error"]').evaluate('e=>e.textContent="其他错误"')
        with self.assertRaisesRegex(RuntimeError, "exactly two"):
            await bridge.load_engine()[3]._cover_slots(self.page)

    async def exercise_cover_confirmation(self, reject_confirmations=0, timeout=120, fail_processing=0, confirm_only=False,
                                         stale_after_recovery=False, resume_failed=False):
        import cv2
        import numpy as np
        # Source SHA-256 uses WebCrypto, as it does on Baijiahao's HTTPS editor.
        await self.page.route("https://cover-upload.test/", lambda route: route.fulfill(body="<html></html>", content_type="text/html"))
        await self.page.goto("https://cover-upload.test/")
        await self.page.set_content('''<div class="form-cover">
          <section class="x-cover-container" data-kind="landscape">
            <div data-testid="cover-preview" style="width:160px;height:90px"><img width="160" height="90"></div>
            <input type="file" accept="image/*"></section>
          <section class="x-cover-container" data-kind="portrait">
            <div data-testid="cover-preview" style="width:90px;height:120px"><img width="90" height="120"></div>
            <input type="file" accept="image/*"></section></div>
          <script>
          window.confirmed=[];window.coverClicks={landscape:0,portrait:0};window.rejectConfirmations=0;
          window.coverSelections={landscape:0,portrait:0};window.failProcessing=0;
          window.staleAfterRecovery=false;
          const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
          document.querySelectorAll('.form-cover img').forEach(e=>e.src=canvas.toDataURL());
          document.querySelectorAll('input').forEach(input=>input.onchange=()=>{
            if(!input.files.length)return;
            const slot=input.closest('section'), kind=slot.dataset.kind;
            coverSelections[kind]++;
            const src=URL.createObjectURL(input.files[0]);
            setTimeout(()=>{
              const modal=document.createElement('div');modal.setAttribute('role','dialog');
              modal.innerHTML=`${kind==='landscape'?'横':'竖'}版封面预览
                <div class="x-sc-cover"><img src="${src}"></div>
                <div id="drawCoverTab-preview"><img src="${src}"></div><button>确定</button>`;
              modal.querySelector('button').onclick=()=>{
                if(++coverClicks[kind]<=rejectConfirmations){
                  let notice=document.querySelector('[role="alert"]');
                  if(!notice){notice=document.createElement('div');notice.setAttribute('role','alert');document.body.append(notice)}
                  notice.textContent='裁剪处理中，请稍后再点击确定';return;
                }
                document.querySelector('[role="alert"]')?.remove();
                if(kind==='landscape'&&coverSelections[kind]<=failProcessing){
                  modal.remove();slot.querySelector('[data-testid="cover-preview"]').style.display='none';
                  let error=slot.querySelector('.x-error');
                  if(!error){error=document.createElement('div');error.className='x-error';slot.append(error)}
                  error.style='width:160px;height:90px';error.textContent='重选封面';return;
                }
                confirmed.push(kind);modal.remove();
                slot.querySelector('.x-error')?.remove();
                slot.querySelector('[data-testid="cover-preview"]').style.display='block';
                setTimeout(()=>slot.querySelector('img').src=staleAfterRecovery&&kind==='landscape'&&coverSelections[kind]>1
                  ?canvas.toDataURL():src,150);
              };
              document.body.append(modal);
            },200);
          });</script>''')
        await self.page.evaluate('n=>window.rejectConfirmations=n', reject_confirmations)
        await self.page.evaluate('n=>window.failProcessing=n', fail_processing)
        await self.page.evaluate('value=>window.staleAfterRecovery=value', stale_after_recovery)
        with tempfile.TemporaryDirectory() as directory:
            payload = {}
            for kind, (width, height) in {"landscape": (160, 90), "portrait": (90, 120)}.items():
                path = Path(directory) / f"{kind}.png"
                cv2.imwrite(str(path), np.full((height, width, 3), 120, dtype=np.uint8))
                payload[f"{kind}Path"] = str(path)
            if confirm_only:
                await self.page.locator('.form-cover input[type="file"]').first.set_input_files(payload['landscapePath'])
                await self.page.get_by_role('dialog').wait_for()
            if resume_failed:
                await self.page.locator('.form-cover input[type="file"]').first.set_input_files(payload['landscapePath'])
                await self.page.get_by_role('dialog').get_by_role('button', name='确定', exact=True).click()
                await self.page.get_by_text('重选封面', exact=True).wait_for()
            covers = await asyncio.wait_for(bridge.baijiahao_covers(self.page, payload, bridge.load_engine()[3],
                timeout=timeout, confirm_only=confirm_only), timeout=15)
            self.assertEqual(await self.page.evaluate("confirmed"), ["landscape", "portrait"])
            self.assertTrue(all(covers[k]["preview"].startswith("blob:") for k in ("landscape", "portrait")))
            return covers

    async def test_cover_upload_waits_for_crop_confirmation_and_replacement_preview(self):
        await self.exercise_cover_confirmation()

    async def test_processing_notice_can_require_more_than_two_confirm_attempts(self):
        await self.exercise_cover_confirmation(reject_confirmations=2)
        self.assertEqual(await self.page.evaluate('coverClicks'), {'landscape': 3, 'portrait': 3})

    async def test_failed_processing_after_confirm_reselects_only_the_same_cover_once(self):
        covers = await self.exercise_cover_confirmation(fail_processing=1, timeout=5)
        self.assertEqual(await self.page.evaluate('coverSelections'), {'landscape': 2, 'portrait': 1})
        self.assertEqual(covers['landscape']['confirmClicks'], 2)
        self.assertEqual(covers['landscape']['verification'], 'source_and_preview')
        self.assertLessEqual(covers['landscape']['pixel_difference']['mae'], 3)

    async def test_resume_reselects_a_preexisting_failed_slot_with_the_same_file_still_selected(self):
        covers = await self.exercise_cover_confirmation(fail_processing=1, timeout=3, resume_failed=True)
        self.assertEqual(await self.page.evaluate('coverSelections'), {'landscape': 2, 'portrait': 1})
        self.assertEqual(covers['landscape']['confirmClicks'], 1)
        self.assertEqual(covers['landscape']['verification'], 'source_and_preview')

    async def test_resume_of_a_failed_slot_does_not_grant_another_processing_retry(self):
        with self.assertRaisesRegex(RuntimeError, '横版封面.*再次失败'):
            await self.exercise_cover_confirmation(fail_processing=99, timeout=3, resume_failed=True)
        self.assertEqual(await self.page.evaluate('coverSelections'), {'landscape': 2, 'portrait': 0})

    async def test_repeated_processing_failure_stops_without_reselecting_forever(self):
        with self.assertRaisesRegex(RuntimeError, '横版封面.*再次失败'):
            await self.exercise_cover_confirmation(fail_processing=99, timeout=5)
        self.assertEqual(await self.page.evaluate('coverSelections'), {'landscape': 2, 'portrait': 0})
        self.assertEqual(await self.page.evaluate('confirmed'), [])

    async def test_confirm_only_never_reselects_a_failed_cover(self):
        with self.assertRaisesRegex(RuntimeError, '横版封面.*失败.*不能.*重新选择'):
            await self.exercise_cover_confirmation(fail_processing=1, timeout=2, confirm_only=True)
        self.assertEqual(await self.page.evaluate('coverSelections'), {'landscape': 1, 'portrait': 0})

    async def test_recovery_still_rejects_an_automatic_frame_in_the_final_preview(self):
        with self.assertRaisesRegex(TimeoutError, '当前仍为旧封面'):
            await self.exercise_cover_confirmation(fail_processing=1, timeout=4, stale_after_recovery=True)
        self.assertEqual(await self.page.evaluate('coverSelections'), {'landscape': 2, 'portrait': 0})

    async def test_permanent_processing_stops_with_cover_stage_and_click_count(self):
        with self.assertRaisesRegex(TimeoutError, r'横版封面确认超时：.*已点击确定 \d+ 次'):
            await self.exercise_cover_confirmation(reject_confirmations=99, timeout=1.5)
        self.assertEqual(await self.page.evaluate('confirmed'), [])

    async def test_lazy_input_is_mounted_after_clicking_upload_video(self):
        await self.page.set_content(LAZY_UPLOAD)
        control, selector = await self.resolve()
        self.assertEqual(await control.get_attribute("accept"), "video/mp4")
        self.assertEqual(await self.page.locator(selector).count(), 1)

    async def test_delayed_input_with_overlay_does_not_wait_on_obscured_button(self):
        await self.page.set_content('''<div class="FeEditorApp-blankWrap" style="position:relative">
          <button>上传视频</button><div class="FeEditorApp-inputWrap">
          <div data-testid="video-upload-btn" style="position:absolute;inset:0"></div></div>
          <script>setTimeout(() => document.querySelector('[class$="-inputWrap"]')
            .insertAdjacentHTML('beforeend', '<input type="file" multiple accept=".mp4">'), 150)</script>
        </div>''')
        control, selector = await self.resolve()
        self.assertTrue(await control.evaluate("e => e.multiple"))
        self.assertEqual(await self.page.locator(selector).count(), 1)

    async def test_actual_upload_overlay_can_mount_lazy_input(self):
        await self.page.set_content('''<div class="FeEditorApp-blankWrap" style="position:relative">
          <button>上传视频</button><div class="FeEditorApp-inputWrap">
          <div data-testid="video-upload-btn" style="position:absolute;inset:0"
            onclick="this.insertAdjacentHTML('afterend', '&lt;input type=file accept=video/mp4&gt;')"></div>
          </div></div>''')
        control, _ = await self.resolve()
        self.assertEqual(await control.get_attribute("accept"), "video/mp4")

    async def test_sau_selection_survives_editor_removing_input_after_change(self):
        await self.page.set_content(BLANK_UPLOAD + '''<script>
          document.querySelector('input').onchange = e => {
            window.selected = [...e.target.files].map(f => ({name:f.name,size:f.size}));
            document.querySelector('[class$="-blankWrap"]').remove();
            document.body.insertAdjacentHTML('beforeend', '<div contenteditable="true">上传中</div>');
          };
        </script>''')
        self.page.set_default_timeout(800)
        control, selector = await self.resolve()
        cls = bridge.load_engine()[0]
        app = cls.__new__(cls)
        app.cdp_url = "http://127.0.0.1:9225"
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "one-video.mp4"
            video.write_bytes(b"selected source")
            app.file_path = str(video)
            await app._select_video_file(self.page, control, selector=selector)
            self.assertEqual(await self.page.evaluate("window.selected"),
                             [{"name": video.name, "size": video.stat().st_size}])
            self.assertEqual(await self.page.locator(selector).count(), 0)

    async def test_lazy_primary_never_falls_back_to_an_existing_auxiliary_input(self):
        await self.page.set_content('<aside><input id="auxiliary" type="file" accept="video/mp4"></aside>' + LAZY_UPLOAD)
        control, selector = await self.resolve()
        self.assertTrue(await control.evaluate('e => !!e.closest(\'[class$="-blankWrap"]\')'))
        self.assertEqual(await self.page.locator(selector).count(), 1)
        self.assertEqual(await self.page.locator("#auxiliary").evaluate("e => e.files.length"), 0)

    async def test_ambiguous_or_disabled_inputs_never_select_a_file(self):
        for content in (BATCH_INPUT * 2, BLANK_UPLOAD * 2,
                        '<input type="file" disabled accept="video/mp4">'):
            with self.subTest(content=content):
                await self.page.set_content(content)
                with self.assertRaisesRegex(RuntimeError, "不唯一|不可用"):
                    await self.resolve()
                self.assertFalse(await self.page.locator('input[type="file"]').evaluate_all("es => es.some(e => e.files.length)"))


if __name__ == "__main__":
    unittest.main()
