"""Background upload previews stay silent, including retained shadow-DOM media."""
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from playwright.async_api import async_playwright
import account_browser


class SilentUploadTest(unittest.IsolatedAsyncioTestCase):
    async def test_retained_shadow_media_and_future_previews_are_silent(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                                               headless=True, args=['--mute-audio'])
            try:
                context = await browser.new_context()
                page = await context.new_page()
                await page.set_content('<div id="shadow"></div><audio></audio>')
                await page.evaluate("""() => {
                    document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<video></video>';
                    for(const m of [document.querySelector('audio'),document.querySelector('#shadow').shadowRoot.querySelector('video')]) {
                        m.muted=false;m.volume=1;
                    }
                }""")
                await account_browser.silence_account_browser(browser)
                self.assertEqual(await page.locator('video,audio').evaluate_all('es=>es.map(e=>({muted:e.muted,volume:e.volume}))'),
                                 [{'muted':True,'volume':0},{'muted':True,'volume':0}])
                # The retained shadow-root element also guards native play events.
                self.assertTrue(await page.locator('video').evaluate("e=>{e.muted=false;e.volume=1;e.dispatchEvent(new Event('play'));return e.muted&&e.volume===0}"))
                # New documents receive the guard before the platform calls play.
                future = await context.new_page()
                self.assertTrue(await future.evaluate("""async () => {
                    const media=document.createElement('video');document.body.append(media);
                    void media.play().catch(() => {});
                    return media.muted && media.volume===0 && window.__huobaoSilentUpload;
                }"""))
            finally:
                await browser.close()

    async def test_closed_tab_does_not_block_muting_other_retained_pages(self):
        stale = SimpleNamespace(evaluate=AsyncMock(side_effect=RuntimeError('Target closed')))
        media = SimpleNamespace(evaluate_all=AsyncMock())
        live = SimpleNamespace(evaluate=AsyncMock(), locator=lambda _:media)
        context = SimpleNamespace(add_init_script=AsyncMock(),pages=[stale,live])
        await account_browser.silence_account_browser(SimpleNamespace(contexts=[context]))
        media.evaluate_all.assert_awaited_once_with(account_browser.SILENCE_EXISTING_MEDIA)


if __name__ == '__main__':
    unittest.main()
