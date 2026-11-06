"""Real editor DOM coverage for topic and description counter separation."""
import unittest

from playwright.async_api import async_playwright

import bridge


class BaijiahaoMetadataTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        playwright = await async_playwright().start()
        self.addAsyncCleanup(playwright.stop)
        browser = await playwright.chromium.launch(channel='chrome', headless=True)
        self.addAsyncCleanup(browser.close)
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


if __name__ == '__main__':
    unittest.main()
