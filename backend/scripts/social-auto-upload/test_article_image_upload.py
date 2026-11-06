"""Bind source images by upload actions instead of remote pixel comparisons."""
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock
from types import SimpleNamespace

from playwright.async_api import async_playwright
import bridge


HTML = '''<meta charset="utf-8"><button class="edui-for-insertimage">配图</button><iframe></iframe>
<div role="dialog" style="display:none">本地图片<input type="file" accept="image/*" multiple>
<span id="status"></span><button id="confirm">确认</button></div>
<script>
const frame=document.querySelector('iframe'),modal=document.querySelector('[role=dialog]');
window.UE_V2={instants:{editor:{isReady:true,iframe:frame,body:frame.contentDocument.body}}};
window.selections=[];window.index=0;
document.querySelector('.edui-for-insertimage').onclick=()=>{
 document.querySelector('#status').textContent='';modal.style.display='block';};
document.querySelector('input').onchange=e=>{
 window.selections.push([...e.target.files].map(f=>f.name));
 document.querySelector('#status').textContent=e.target.files.length+'张上传成功';};
document.querySelector('#confirm').onclick=()=>{
 frame.contentDocument.body.insertAdjacentHTML('beforeend',`<img src="https://images.test/${index++}.svg">`);
 modal.style.display='none';};
</script>'''


class ArticleImageUploadTest(unittest.IsolatedAsyncioTestCase):
    async def test_each_source_is_bound_to_its_new_preview_without_pixel_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            images = []
            for name in ('first.png', 'second.png'):
                path = Path(directory) / name
                path.write_bytes(b'input-file-fixture')
                images.append({'path': str(path), 'url': 'local-' + name})
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(channel='chrome', headless=True)
                context = await browser.new_context()
                try:
                    page = await context.new_page()
                    await page.route('https://images.test/**', lambda route: route.fulfill(
                        content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="red"/></svg>'))
                    await page.set_content(HTML)
                    helpers = SimpleNamespace(_cover_pixels=AsyncMock(side_effect=RuntimeError('Cannot decode an 8-bit cover preview')))
                    result = await asyncio.wait_for(bridge.article_images(page, images, helpers), 10)
                    self.assertEqual(result, {'local-first.png': 'https://images.test/0.svg', 'local-second.png': 'https://images.test/1.svg'})
                    self.assertEqual(await page.evaluate('selections'), [['first.png'], ['second.png']])
                    helpers._cover_pixels.assert_not_awaited()
                finally:
                    await context.close()
                    await browser.close()


if __name__ == '__main__':
    unittest.main()
