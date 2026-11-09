"""The current crop dialog must receive clicks, not merely occupy a rectangle."""

import base64
import hashlib
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import numpy as np

from playwright.async_api import async_playwright

import bridge


class CoverDialogStackTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        playwright = await async_playwright().start()
        self.addAsyncCleanup(playwright.stop)
        browser = await playwright.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(browser.close)
        self.page = await browser.new_page(viewport={"width": 1000, "height": 800})
        self.addAsyncCleanup(self.page.context.close)
        self.helpers = bridge.load_engine()[3]

    async def dialogs(self, *, landscape_z=10, portrait_z=20, portrait=True):
        await self.page.set_content(f"""<style>
          [role=dialog]{{position:fixed;left:100px;top:100px;width:600px;height:400px;
            background:white;pointer-events:none}}
          button{{pointer-events:auto;position:absolute;right:30px;bottom:30px;width:80px;height:30px}}
          </style>
          <div role="dialog" style="z-index:{landscape_z}">横版封面预览 (16:9)<button>确定</button></div>
          {f'<div role="dialog" style="z-index:{portrait_z}">竖版封面预览 (3:4)<button>确定</button></div>' if portrait else ''}
        """)

    async def test_only_topmost_portrait_dialog_is_returned_with_original_dom_index(self):
        await self.dialogs()
        visible = await bridge.baijiahao_cover_dialogs(self.page, self.helpers)
        self.assertEqual([dialog["index"] for dialog in visible], [1])
        self.assertIn("竖版封面预览", visible[0]["text"])

    async def test_stacking_order_wins_over_dom_order(self):
        await self.dialogs(landscape_z=30)
        visible = await bridge.baijiahao_cover_dialogs(self.page, self.helpers)
        self.assertEqual([dialog["index"] for dialog in visible], [0])
        self.assertIn("横版封面预览", visible[0]["text"])

    async def test_stale_noninteractive_dialog_is_not_an_open_crop(self):
        await self.dialogs(portrait=False)
        await self.page.locator("button").evaluate("node=>node.style.pointerEvents='none'")
        self.assertEqual(await bridge.baijiahao_cover_dialogs(self.page, self.helpers), [])

    async def test_final_verification_ignores_retained_noninteractive_crop_nodes(self):
        await self.dialogs()
        await self.page.locator("button").evaluate_all("nodes=>nodes.forEach(node=>node.style.pointerEvents='none')")
        self.assertEqual(len(await self.page.evaluate(self.helpers._READ_DIALOGS)), 2)
        pixels = np.zeros((64, 64, 3), dtype=np.uint8)
        covers = {kind: {"status": "uploaded", "fingerprint": kind, "source_sha256_verified": kind, "preview": kind,
                         "pixels_sha256": hashlib.sha256(pixels.tobytes()).hexdigest()}
                  for kind in ("landscape", "portrait")}
        slots = {kind: {"src": kind} for kind in covers}
        with patch.object(self.helpers.base, "_verify_metadata", AsyncMock()) as metadata, \
                patch.object(self.helpers.base, "_cover_pixels", AsyncMock(return_value=pixels)), \
                patch.object(self.helpers, "_cover_slots", AsyncMock(return_value=slots)):
            await self.helpers.verify_page(self.page, {"description": "bound copy"}, covers)
        metadata.assert_awaited_once()

    async def test_final_verification_still_blocks_an_interactive_crop(self):
        await self.dialogs()
        with patch.object(self.helpers.base, "_verify_metadata", AsyncMock()) as metadata:
            with self.assertRaisesRegex(RuntimeError, "封面弹窗尚未确认"):
                await self.helpers.verify_page(self.page, {}, {})
        metadata.assert_not_awaited()

    async def test_final_verification_still_blocks_unknown_topmost_modal(self):
        await self.dialogs()
        await self.page.evaluate("""() => document.body.insertAdjacentHTML('beforeend',
          '<div role="dialog" style="z-index:40;pointer-events:auto">账号安全验证</div>')""")
        with patch.object(self.helpers.base, "_verify_metadata", AsyncMock()) as metadata:
            with self.assertRaisesRegex(RuntimeError, "封面弹窗尚未确认"):
                await self.helpers.verify_page(self.page, {}, {})
        metadata.assert_not_awaited()

    async def test_unknown_topmost_modal_still_stops_cover_work(self):
        await self.dialogs()
        await self.page.evaluate("""() => document.body.insertAdjacentHTML('beforeend',
          '<div role="dialog" style="z-index:40;pointer-events:auto">账号安全验证</div>')""")
        with patch.object(bridge, "time", SimpleNamespace(monotonic=MagicMock(side_effect=[0, 11]))):
            with self.assertRaisesRegex(RuntimeError, "账号安全验证"):
                await bridge.baijiahao_cover_dialogs(self.page, self.helpers)

    async def test_two_independent_interactive_dialogs_are_not_silently_chosen(self):
        await self.dialogs()
        await self.page.locator('[role="dialog"]').nth(0).evaluate("node=>node.style.left='-300px'")
        await self.page.locator('[role="dialog"]').nth(1).evaluate("node=>node.style.left='350px'")
        with patch.object(bridge, "time", SimpleNamespace(monotonic=MagicMock(side_effect=[0, 11]))):
            with self.assertRaisesRegex(RuntimeError, "(?s)横版封面预览.*竖版封面预览"):
                await bridge.baijiahao_cover_dialogs(self.page, self.helpers)

    async def test_confirmed_portrait_is_recorded_before_finishing_revealed_landscape(self):
        await self.page.set_content("""<style>
          [role=dialog]{position:fixed;left:100px;top:100px;width:600px;height:400px;
            background:white;pointer-events:none}
          button{pointer-events:auto;position:absolute;right:30px;bottom:30px;width:80px;height:30px}
          .slot{width:160px;height:90px}.slot.tall{width:90px;height:120px}
          </style>
          <div class="form-cover">
            <section class="x-cover-container"><div data-testid="cover-preview" class="slot"><img id="landscape" width="160" height="90"></div><input type="file" accept="image/*"></section>
            <section class="x-cover-container"><div data-testid="cover-preview" class="slot tall"><img id="portrait" width="90" height="120"></div><input type="file" accept="image/*"></section>
          </div>
          <script>
          window.confirmed=[];
          function image(w,h,color){const c=document.createElement('canvas');c.width=w;c.height=h;
            c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,w,h);return c.toDataURL()}
          window.sources={landscape:image(160,90,'red'),portrait:image(90,120,'blue')};
          for(const [i,kind] of ['landscape','portrait'].entries()){
            document.getElementById(kind).src=image(kind==='landscape'?160:90,kind==='landscape'?90:120,'black');
            const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.style.zIndex=10+i;
            modal.innerHTML=`${kind==='landscape'?'横':'竖'}版封面预览
              <div class="x-sc-cover"><img src="${sources[kind]}"></div>
              <div id="drawCoverTab-preview"><img src="${sources[kind]}"></div><button>确定</button>`;
            modal.querySelector('button').onclick=()=>{confirmed.push(kind);
              document.getElementById(kind).src=sources[kind];modal.remove()};
            document.body.append(modal);
          }
          </script>""")
        await self.page.locator("img").evaluate_all("es=>Promise.all(es.map(e=>e.decode()))")
        sources = await self.page.evaluate("sources")
        slots = await self.helpers._cover_slots(self.page)
        previous = {"layout": "videoV2", "landscape": {
            "status": "uploaded", "fingerprint": "wide-sha", "source_sha256_verified": "wide-sha",
            "verification": "source_and_preview", "preview": slots["landscape"]["src"], "confirmClicks": 1,
        }}
        snapshots = []
        with patch.object(self.helpers.base, "_file_digest", side_effect=lambda path: {"wide": "wide-sha", "tall": "tall-sha"}[path]), \
                patch.object(bridge.Path, "read_bytes", autospec=True, side_effect=lambda file:
                    base64.b64decode(sources["landscape" if str(file) == "wide" else "portrait"].split(",")[1])), \
                patch.object(self.helpers.base, "_browser_digest", AsyncMock(side_effect=lambda page, url:
                    "wide-sha" if url == sources["landscape"] else "tall-sha")):
            result = await bridge.baijiahao_covers(self.page, {"landscapePath": "wide", "portraitPath": "tall"},
                                                  self.helpers, previous, snapshots.append, confirm_only=True)
        self.assertEqual(await self.page.evaluate("confirmed"), ["portrait", "landscape"])
        self.assertEqual(set(result), {"layout", "landscape", "portrait"})
        self.assertEqual(result["landscape"]["confirmClicks"], 2)
        self.assertEqual(result["portrait"]["confirmClicks"], 1)
        self.assertEqual(set(snapshots[0]), {"layout", "landscape", "portrait"})
        self.assertEqual(await self.page.locator('[role="dialog"]').count(), 0)
        self.assertFalse(await self.page.locator('input[type="file"]').evaluate_all("es=>es.some(e=>e.files.length)"))


if __name__ == "__main__":
    unittest.main()
