"""Watermark proof uses the observed video_pick_type select, never unrelated checks."""
import unittest

from playwright.async_api import async_playwright

import bridge


HTML = """
<main>
  <input type="checkbox" checked><span class="selected">其他已选设置</span>
  <div class="cheetah-select">
    <div class="cheetah-select-selector" onclick="opens++;document.querySelector('.cheetah-select-dropdown').hidden=false">
      <span class="cheetah-select-selection-search">
        <input type="search" id="video_pick_type" role="combobox" readonly
               aria-expanded="false" aria-controls="video_pick_type_list" style="opacity:0">
      </span>
      <span class="cheetah-select-selection-item" title="添加水印">添加水印</span>
    </div>
  </div>
  <div class="cheetah-select-dropdown" hidden>
    <div id="video_pick_type_list" role="listbox" style="height:0;overflow:hidden">
      <div role="option">添加水印</div>
    </div>
    <div class="cheetah-select-item-option" title="添加水印" onclick="choose(this)">
      <div class="cheetah-select-item-option-content">添加水印</div>
    </div>
  </div>
</main>
<script>
  let opens=0, selections=0, keep=false;
  function choose(option) {
    selections++;
    if (!keep) {
      const selected=document.querySelector('.cheetah-select-selection-item');
      selected.textContent=option.title; selected.title=option.title;
    }
    document.querySelector('.cheetah-select-dropdown').hidden=true;
  }
</script>
"""


class BaijiahaoWatermarkTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.addAsyncCleanup(self.pw.stop)
        self.browser = await self.pw.chromium.launch(channel="chrome", headless=True)
        self.addAsyncCleanup(self.browser.close)
        self.page = await self.browser.new_page()
        await self.page.set_content(HTML)
        self.payload = {"watermark": "添加水印"}

    async def test_selected_watermark_ignores_duplicate_text_and_never_reopens_the_control(self):
        await self.page.evaluate("""() => {
          const other=document.createElement('span');other.textContent='添加水印';document.querySelector('main').appendChild(other);
          document.querySelector('.cheetah-select-dropdown').hidden=false;
        }""")
        result = await bridge.ensure_baijiahao_fields(self.page, self.payload)
        self.assertEqual(result["watermark"]["value"], "添加水印")
        self.assertTrue(result["watermark"]["verified"])
        await bridge.verify_baijiahao_fields(self.page, self.payload, result)
        self.assertEqual(await self.page.evaluate("[opens,selections]"), [0, 0])

    async def test_verification_is_read_only_and_rejects_another_selection_despite_unrelated_checked_nodes(self):
        await self.page.evaluate("""() => {
          const selected=document.querySelector('.cheetah-select-selection-item');selected.textContent='不添加水印';selected.title='不添加水印';
          const other=document.createElement('span');other.textContent='添加水印';document.querySelector('main').appendChild(other);
        }""")
        with self.assertRaisesRegex(RuntimeError, "水印"):
            await bridge.verify_baijiahao_fields(self.page, self.payload)
        self.assertEqual(await self.page.evaluate("[opens,selections]"), [0, 0])

    async def test_selects_only_the_linked_watermark_dropdown_and_checks_the_retained_value(self):
        await self.page.evaluate("""() => {
          const selected=document.querySelector('.cheetah-select-selection-item');selected.textContent='不添加水印';selected.title='不添加水印';
          const other=document.createElement('div');other.className='cheetah-select-dropdown';other.textContent='添加水印';document.body.appendChild(other);
        }""")
        result = await bridge.ensure_baijiahao_fields(self.page, self.payload)
        self.assertTrue(result["watermark"]["verified"])
        self.assertEqual(await self.page.evaluate("[opens,selections]"), [1, 1])
        await bridge.verify_baijiahao_fields(self.page, self.payload, result)

    async def test_missing_or_duplicate_watermark_controls_are_not_verified_from_global_text(self):
        for html in [HTML.replace('id="video_pick_type"', 'id="other_setting"'), HTML + HTML]:
            with self.subTest(duplicate=html == HTML + HTML):
                await self.page.set_content(html)
                with self.assertRaisesRegex(RuntimeError, "水印"):
                    await bridge.ensure_baijiahao_fields(self.page, self.payload)

    async def test_clicked_but_unretained_watermark_is_rejected(self):
        await self.page.evaluate("""() => {
          keep=true;
          const selected=document.querySelector('.cheetah-select-selection-item');selected.textContent='不添加水印';selected.title='不添加水印';
        }""")
        with self.assertRaisesRegex(RuntimeError, "水印"):
            await bridge.ensure_baijiahao_fields(self.page, self.payload)
        self.assertEqual(await self.page.evaluate("[opens,selections]"), [1, 1])


if __name__ == "__main__":
    unittest.main()
