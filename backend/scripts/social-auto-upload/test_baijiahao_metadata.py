"""Real editor DOM coverage for topic and description counter separation."""
import asyncio
import unittest

from playwright.async_api import async_playwright

import bridge


class BaijiahaoMetadataTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        playwright = await async_playwright().start()
        self.addAsyncCleanup(playwright.stop)
        browser = await playwright.chromium.launch(channel='chrome', headless=True)
        async def close_browser():
            close = asyncio.create_task(browser.close())
            try:
                await asyncio.wait_for(asyncio.shield(close), timeout=3)
            except TimeoutError:
                await playwright.stop()
                await asyncio.gather(close, return_exceptions=True)
        self.addAsyncCleanup(close_browser)
        self.page = await browser.new_page()
        self.helpers = bridge.load_engine()[3]
        await self.page.set_content('''<div class="videov2-title-wrap">
          <div contenteditable="true" style="width:500px;min-height:60px">原作品描述</div>
          <span class="FeEditorApp-x-topicCount">1/10</span>
          <span class="FeEditorApp-x-count ">5/50</span></div>''')

    async def test_selected_topic_counter_does_not_reduce_description_limit_to_ten(self):
        description = '2026-11-02 NBA｜东契奇42分13助攻，湖人138-117热火 #NBA#'
        metadata = await self.helpers.fill_metadata(self.page, '东契奇42分', description)
        self.assertEqual(metadata['description']['value'], description)
        await self.helpers._verify_metadata(self.page, metadata)

    async def test_real_character_limit_blocks_before_changing_existing_copy(self):
        with self.assertRaisesRegex(ValueError, '50'):
            await self.helpers.fill_metadata(self.page, '中文标题', '球' * 49 + '🔥')
        self.assertEqual(await self.page.locator('[contenteditable]').inner_text(), '原作品描述')

    async def test_explicit_control_limit_takes_precedence_over_character_counter(self):
        await self.page.locator('[contenteditable]').evaluate('(element) => element.setAttribute("data-maxlength", "12")')
        with self.assertRaisesRegex(ValueError, '12'):
            await self.helpers.fill_metadata(self.page, '中文标题', '球' * 13)
        self.assertEqual(await self.page.locator('[contenteditable]').inner_text(), '原作品描述')

    async def test_separate_title_and_description_editors_keep_original_limit_checks(self):
        await self.page.set_content('<input placeholder="标题" maxlength="8"><textarea placeholder="作品描述" maxlength="100"></textarea>')
        metadata = await self.helpers.fill_metadata(self.page, '中文标题', '球' * 70)
        self.assertEqual(metadata['layout'], 'separate')
        with self.assertRaisesRegex(ValueError, '8'):
            await self.helpers.fill_metadata(self.page, '球' * 9, '作品描述')

    async def test_explicit_text_limit_is_enforced_without_a_character_counter(self):
        await self.page.locator('[class*="-count"]').evaluate('(element) => element.remove()')
        await self.page.locator('.videov2-title-wrap').evaluate('(element) => element.append("最多30字")')
        with self.assertRaisesRegex(ValueError, '30'):
            await self.helpers.fill_metadata(self.page, '中文标题', '球' * 31)
        self.assertEqual(await self.page.locator('[contenteditable]').inner_text(), '原作品描述')

    async def test_smart_copy_tour_is_closed_before_clicking_lexical_editor(self):
        self.page.set_default_timeout(700)
        await self.page.locator('[contenteditable]').evaluate('element => element.dataset.lexicalEditor = "true"')
        await self.page.evaluate('''() => {
          window.closedTours = 0;
          window.copyBeforeClose = null;
          document.body.insertAdjacentHTML('beforeend', `
            <div role="tooltip" class="cheetah-popover-inner"
                 style="position:fixed;inset:0;z-index:1000;background:white">
              <span class="cheetah-popconfirm-message-icon"><span class="l-icon l-icon-BjhBasicGuanbi"
                style="display:inline-block;width:24px;height:24px">X</span></span>
              <div>新增智能文案，上传视频，AI为您生成优质文案，快来试试吧！</div>
              <button style="display:none">我知道了</button>
            </div>`);
          document.querySelector('.l-icon-BjhBasicGuanbi').onclick = event => {
            window.copyBeforeClose = document.querySelector('[contenteditable]').innerText;
            window.closedTours++;
            event.target.closest('[role="tooltip"]').remove();
          };
        }''')
        description = '水豚为什么可以和那么多动物相处？'
        metadata = await self.helpers.fill_metadata(self.page, '水豚冷知识', description)
        self.assertEqual(await self.page.evaluate('window.closedTours'), 1)
        self.assertEqual(await self.page.evaluate('window.copyBeforeClose'), '原作品描述')
        self.assertEqual(metadata['description']['value'], description)
        await self.helpers._verify_metadata(self.page, metadata)

    async def test_unrelated_tooltip_close_icon_is_not_clicked(self):
        await self.page.evaluate('''() => {
          window.closedTours = 0;
          document.body.insertAdjacentHTML('beforeend', `
            <div role="tooltip" class="cheetah-popover-inner" style="position:fixed;right:0;bottom:0">
              <span class="cheetah-popconfirm-message-icon"><span class="l-icon l-icon-BjhBasicGuanbi">X</span></span>
              <div>其他提示</div>
            </div>`);
          document.querySelector('.l-icon-BjhBasicGuanbi').onclick = () => window.closedTours++;
        }''')
        metadata = await self.helpers.fill_metadata(self.page, '中文标题', '作品描述')
        self.assertEqual(await self.page.evaluate('window.closedTours'), 0)
        self.assertEqual(metadata['description']['value'], '作品描述')

    async def test_smart_copy_tour_with_zero_sized_close_uses_keyboard_focus(self):
        self.page.set_default_timeout(700)
        await self.page.evaluate('''() => {
          document.body.insertAdjacentHTML('beforeend', `
            <div role="tooltip" class="cheetah-popover-inner"
                 style="position:fixed;inset:0;z-index:1000;background:white">
              <span class="cheetah-popconfirm-message-icon"><span class="l-icon-BjhBasicGuanbi"
                style="display:inline-flex;width:0;height:0"></span></span>
              <div>新增智能文案，上传视频，AI为您生成优质文案，快来试试吧！</div>
              <button style="display:none">我知道了</button>
            </div>`);
        }''')
        metadata = await self.helpers.fill_metadata(self.page, '中文标题', '作品描述')
        self.assertEqual(metadata['description']['value'], '作品描述')
        self.assertEqual(await self.page.locator('[role="tooltip"]:visible').count(), 1)
        await self.helpers._verify_metadata(self.page, metadata)

    async def test_keyboard_focus_does_not_bypass_an_unknown_dialog_above_the_tour(self):
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError
        self.page.set_default_timeout(700)
        await self.page.evaluate('''() => {
          document.body.insertAdjacentHTML('beforeend', `
            <div role="tooltip" class="cheetah-popover-inner"
                 style="position:fixed;inset:0;z-index:1000;background:white">
              新增智能文案，上传视频，AI为您生成优质文案，快来试试吧！</div>
            <div role="dialog" style="position:fixed;inset:0;z-index:1001;background:white">人工确认</div>`);
        }''')
        with self.assertRaises(PlaywrightTimeoutError):
            await self.helpers.fill_metadata(self.page, '中文标题', '作品描述')
        self.assertEqual(await self.page.locator('[contenteditable]').inner_text(), '原作品描述')


if __name__ == '__main__':
    unittest.main()
