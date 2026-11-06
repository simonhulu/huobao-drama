"""Project-owned editor adapters for SAU. None of these helpers saves/publishes.

Platform previews are derived assets: compression, crop and CDN URLs can change.
Verify the selected source and the completed UI action, not pixel identity.
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
import re
import time
import unicodedata


def normalized_copy(value):
    value = unicodedata.normalize("NFC", str(value or ""))
    return re.sub(r"[\s\u200b-\u200f\ufeff]+", "", value)


async def tencent_metadata(page, title, description, expected_description=None, timeout=3):
    # Compare content, allowing editor formatting and explicit topic nodes only.
    # Never accept arbitrary text simply because it contains the expected copy.
    deadline = time.monotonic() + timeout
    while True:
        actual_title = await page.locator('input[placeholder*="短标题"]').input_value()
        editor = page.locator('div.input-editor[contenteditable]')
        actual = await editor.inner_text()
        allowed = set('《》〈〉“”‘’\"\'：:+＋?？%％℃')
        platform_title = " ".join("".join(" " if c in ",，" else c for c in title
            if c in ",，" or c in allowed or unicodedata.category(c)[0] not in "PS").split())
        title_ok = normalized_copy(actual_title) in {normalized_copy(title), normalized_copy(platform_title)}
        expected = expected_description if expected_description is not None else description
        body_ok = normalized_copy(actual) == normalized_copy(expected)
        if not body_ok:
            body = await editor.evaluate(r'''e=>{
              const copy=e.cloneNode(true),topics=[...copy.querySelectorAll('span[data-type="topic"]')];
              if(!topics.length||topics.some(e=>!/^#[^#\s]+$/.test(e.textContent.trim())))return null;
              topics.forEach(e=>e.remove());return copy.textContent;
            }''')
            body_ok = body is not None and normalized_copy(body) == normalized_copy(description)
        if title_ok and body_ok:
            return {"short_title": actual_title, "description": actual,
                    "source_description": description, "verified": True}
        if time.monotonic() >= deadline:
            if not title_ok:
                raise RuntimeError("视频号短标题已变化，未保存")
            raise RuntimeError("视频号文案在准备完成后发生变化，未保存" if expected_description is not None
                               else "视频号正文已变化或未完整填入，未保存")
        await asyncio.sleep(0.15)


async def fill_tencent_metadata(page, title, description):
    editor = page.locator('div.input-editor[contenteditable]')
    field = page.locator('input[placeholder*="短标题"]')
    if (await editor.inner_text()).strip() or await field.input_value():
        raise RuntimeError("新视频号编辑页已有文案，未覆盖")
    await editor.fill(description)
    await field.fill(title)
    await field.press("Tab")
    return await tencent_metadata(page, title, description)


async def baijiahao_dialogs(page, read_dialogs):
    dialogs = await page.evaluate(read_dialogs)
    if not dialogs:
        return []
    # videoV2 retains crop nodes beneath the current dialog, or after closing them.
    indexes = await page.locator('[role="dialog"]').evaluate_all("""nodes => nodes.flatMap((node,index) => {
      const button=[...node.querySelectorAll('button')].find(e=>e.textContent.trim()==='确定');
      const target=button||node, rect=target.getBoundingClientRect(), style=getComputedStyle(target);
      if(!rect.width||!rect.height||style.visibility==='hidden'||style.display==='none')return [];
      const left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right);
      const top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
      if(right<=left||bottom<=top)return [];
      const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);
      return hit?.closest('[role="dialog"]')===node?[index]:[];
    })""")
    return [dialog for dialog in dialogs if dialog.get("index") in indexes]


class BaijiahaoEditor:
    _READ_SLOTS = """() => [...document.querySelectorAll('.form-cover [class$="-cover-container"]')]
      .map((slot, index) => {
        const preview = slot.querySelector('[data-testid="cover-preview"]')
          || slot.querySelector('[data-testid="select-cover"]')?.closest('[class$="-default"]')
          || slot.querySelector('[data-testid="select-cover"]');
        let rect = preview?.getBoundingClientRect(), failed = false;
        if (!rect?.width || !rect?.height) {
          const errors = [...slot.querySelectorAll('[class$="-error"]')]
            .filter(element => element.innerText.trim() === '重选封面');
          if (errors.length === 1) {
            rect = errors[0].getBoundingClientRect();
            failed = true;
          }
        }
        if (!rect?.width || !rect?.height) return null;
        const inputs = [...slot.querySelectorAll('input[type="file"]')];
        const imageInputs = inputs.map((element, index) => /image/i.test(element.accept || '') ? index : -1)
          .filter(index => index >= 0);
        const images = [...slot.querySelectorAll('[data-testid="cover-preview"] img')];
        const image = images.length === 1 ? images[0] : null;
        return {index, kind: rect.width > rect.height ? 'landscape' : rect.height > rect.width ? 'portrait' : 'square',
          image_inputs: imageInputs, image_count: images.length,
          src: !failed && image?.complete && image.naturalWidth ? image.currentSrc || image.src : null};
      }).filter(Boolean)"""

    def __init__(self, base):
        self.base = base

    def __getattr__(self, name):
        return getattr(self.base, name)

    async def _cover_slots(self, page):
        slots = await page.evaluate(self._READ_SLOTS)
        if len(slots) != 2:
            raise RuntimeError('Expected exactly two visible cover slots')
        result = {}
        for slot in slots:
            kind = slot['kind']
            if kind not in ('landscape', 'portrait') or kind in result or len(slot['image_inputs']) != 1:
                raise RuntimeError('Ambiguous cover geometry or image file input')
            if slot['image_count'] > 1:
                raise RuntimeError('Ambiguous cover preview image')
            result[kind] = slot
        return result

    async def fill_metadata(self, page, title, description):
        layout, fields = self.base._metadata_fields(await page.evaluate(self.base._READ_METADATA))
        if layout != 'videoV2':
            return await self.base.fill_metadata(page, title, description)
        if not isinstance(title, str) or not isinstance(description, str):
            raise TypeError('Saved title and description must be strings')
        control = page.locator('input,textarea,[contenteditable="true"]').nth(fields['description']['index'])
        # videoV2 also shows a topic counter (1/10) beside the character counter.
        maximum = await control.evaluate(r'''element => {
          const limits = ['maxlength', 'data-maxlength', 'data-max-length']
            .map(key => element.getAttribute(key)).filter(value => /^\d+$/.test(value || '')).map(Number);
          const wrapper = element.closest('.videov2-title-wrap');
          for (const match of (wrapper?.innerText || '').matchAll(/(?:最多\s*(\d+)\s*(?:字|字符)|不超过\s*(\d+)\s*(?:字|字符))/g)) {
            limits.push(Number(match[1] || match[2]));
          }
          for (const counter of wrapper?.querySelectorAll('[class*="-count"]') || []) {
            if (![...counter.classList].some(name => name.endsWith('-count'))) continue;
            const match = counter.innerText.match(/^\s*\d+\s*\/\s*(\d+)\s*$/);
            if (match) limits.push(Number(match[1]));
          }
          return limits.length ? Math.min(...limits) : null;
        }''')
        if maximum is not None and len(description.encode('utf-16-le')) // 2 > maximum:
            raise ValueError(f'Saved description exceeds the editor limit ({maximum}); will not truncate')
        await control.click()
        await control.press('ControlOrMeta+A')
        await page.keyboard.press('Backspace')
        if description:
            await page.keyboard.insert_text(description)
        actual = await control.evaluate('(element) => element.isContentEditable ? element.innerText : element.value')
        if actual != description:
            raise RuntimeError('description did not retain the exact saved text')
        result = {'layout': layout, 'title': {'status': 'source_only', 'source_value': title},
                  'description': {'status': 'filled', 'value': actual}}
        await self.base._verify_metadata(page, result)
        return result

    async def verify_upload(self, page, video_path, timeout=1200):
        result = await self.base.verify_upload(page, video_path, timeout=timeout)
        # Baijiahao's first-run feature tour overlays the cover editor.
        # Dismiss only its explicit acknowledgement, never an arbitrary dialog.
        acknowledge = page.get_by_text("我知道了", exact=True).filter(visible=True)
        if await acknowledge.count() == 1:
            known = await acknowledge.evaluate(r"""e => {
              for(let node=e, i=0; node && i<5; node=node.parentElement, i++) {
                const text=node.innerText || '';
                if(text.length<500 && /视频新增[“”\"\s]*一键填/.test(text)) return true;
              }
              return false;
            }""")
            if known:
                await acknowledge.click(timeout=3000)
        return result

    async def verify_page(self, page, metadata, covers):
        if await baijiahao_dialogs(page, self.base._READ_DIALOGS):
            raise RuntimeError("百家号封面弹窗尚未确认，未保存")
        await self.base._verify_metadata(page, metadata)
        slots = await self._cover_slots(page)
        for kind in ("landscape", "portrait"):
            if covers.get(kind, {}).get("status") != "uploaded" or not slots[kind].get("src"):
                raise RuntimeError("百家号横竖封面未设置完成，未保存")


class TencentCovers:
    def __init__(self, base):
        self.base = base

    def __getattr__(self, name):
        return getattr(self.base, name)

    def _local_cover(self, path, kind):
        import cv2
        file = Path(path).resolve(strict=True)
        data = file.read_bytes()
        image = cv2.imread(str(file), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("本地封面图片无法读取")
        height, width = image.shape[:2]
        return {"path": str(file), "sha256": hashlib.sha256(data).hexdigest(),
                "width": width, "height": height, "pixels": None}

    async def _slot(self, page, kind):
        primary = page.locator(self.base._SLOTS[kind]).filter(visible=True)
        if await primary.count():
            return primary.first
        label = "个人主页" if kind == "portrait" else "分享卡片"
        candidates = page.locator('[class*="cover"]').filter(has_text=label).filter(visible=True)
        # Prefer the smallest labelled card containing an image, never a
        # page-wide ancestor holding both cards.
        for candidate in reversed(await candidates.all()):
            if await candidate.locator('img,[class*="img-wrap"]').count():
                return candidate
        raise RuntimeError("视频号封面卡片尚未加载")

    async def _read_preview(self, page, root, kind, expected=None):
        items = await root.evaluate(r'''async root=>{
          const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
          const result=[...root.querySelectorAll('img')].filter(e=>visible(e)&&e.complete&&e.naturalWidth)
            .map(e=>({src:e.currentSrc||e.src,width:e.naturalWidth,height:e.naturalHeight}));
          for(const e of [root,...root.querySelectorAll('*')]){
            if(!visible(e))continue;
            if(e.matches('canvas')&&e.width&&e.height){
              const crop=root.querySelector('.cr-viewport,.cropper-view-box,.cropper-crop-box');
              const r=crop?.getBoundingClientRect();
              if(r?.width&&r?.height)result.push({src:'canvas-preview',width:r.width,height:r.height});
            }
            const match=/^url\(["']?(.*?)["']?\)$/.exec(getComputedStyle(e).backgroundImage);
            if(match){const img=new Image();img.src=match[1];
              if(img.complete&&img.naturalWidth)result.push({src:img.src,width:img.naturalWidth,height:img.naturalHeight});}
          }
          return result;
        }''')
        # Crop dialogs may show a larger source image. The crop box supplies
        # the actual output geometry; final cards require a loaded preview.
        for item in items:
            if item['width'] < 32 or item['height'] < 32:
                continue
            if abs(item['width'] / item['height'] / self.base._RATIOS[kind] - 1) <= 0.04:
                return {"preview": item['src'], "preview_width": item['width'],
                        "preview_height": item['height'], "verification": "loaded_preview"}
        return None

    async def verify_covers(self, page, evidence):
        if await self.base._visible_dialogs(page):
            raise RuntimeError("视频号封面弹窗尚未确认，未保存")
        for kind in ("landscape", "portrait"):
            record = evidence.get(kind, {})
            if record.get("status") != "uploaded" or not record.get("source_sha256"):
                raise RuntimeError("视频号封面文件尚未选择，未保存")
            if not await self._read_preview(page, await self._slot(page, kind), kind):
                raise RuntimeError("视频号封面尚未显示，未保存")
        return evidence
