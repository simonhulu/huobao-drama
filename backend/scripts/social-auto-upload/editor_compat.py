"""Project-owned editor adapters for SAU. None of these helpers saves/publishes.

Platform previews are derived assets: compression, crop and CDN URLs can change.
Verify the selected source and the completed UI action, not pixel identity.
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
import re
import secrets
import time
import unicodedata


VIDEO_READ_TIMEOUT_SECONDS = 60
COVER_READ_TIMEOUT_SECONDS = 30
MEDIA_READ_GRACE_SECONDS = 2

_READ_MEDIA_BYTES = """async ({url, operationId, timeoutMs, digest}) => {
  const reads=window.__huobaoSauMediaReads ||= new Map();
  const controller=new AbortController();
  let reader, timer, timedOut=false, rejectAbort;
  const cancelled=new Promise((resolve,reject)=>{rejectAbort=reject;});
  const abort=()=>{
    controller.abort();
    if(reader?.readyState===1)reader.abort();
    rejectAbort(new DOMException('Media read cancelled','AbortError'));
  };
  reads.set(operationId,abort);
  const deadline=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>{timedOut=true;abort();reject(new Error('HUOBAO_MEDIA_READ_TIMEOUT'));},timeoutMs);
  });
  const read=async()=>{
    const response=await fetch(url,{signal:controller.signal});
    if(!response.ok)throw new Error('Cannot read editor media for verification');
    if(digest){
      const value=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
      return [...new Uint8Array(value)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    }
    const blob=await response.blob();
    return await new Promise((resolve,reject)=>{
      reader=new FileReader();
      reader.onload=()=>resolve(reader.result.split(',')[1]);
      reader.onerror=()=>reject(new Error('Cannot read cover preview'));
      reader.onabort=()=>reject(new DOMException('Cover read cancelled','AbortError'));
      reader.readAsDataURL(blob);
    });
  };
  try{return {ok:true,value:await Promise.race([read(),cancelled,deadline])};}
  catch(error){return {ok:false,timedOut,error:String(error)};}
  finally{clearTimeout(timer);reads.delete(operationId);}
}"""


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
          image_inputs: imageInputs, image_count: images.length, failed,
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

    async def verify_upload(self, page, video_path, timeout=1200, *, verified_media=None):
        try:
            digest = await asyncio.wait_for(asyncio.to_thread(self.base._file_digest, video_path),
                                            timeout=VIDEO_READ_TIMEOUT_SECONDS)
        except TimeoutError as error:
            raise TimeoutError('原视频文件指纹读取超时，已保留原视频和上传检查点，未保存或发表') from error
        deadline = time.monotonic() + timeout
        while True:
            try:
                media = await asyncio.wait_for(page.evaluate(self.base._READ_MEDIA),
                                               timeout=max(0.01, min(10, deadline - time.monotonic())))
            except TimeoutError as error:
                raise TimeoutError('原视频预览读取超时，已保留原视频和上传检查点，未保存或发表') from error
            phase = self.base._classify_upload(media)
            if phase == 'failed':
                raise RuntimeError('Baijiahao reports a video upload or transcoding failure')
            if phase == 'complete':
                src = media['videos'][0]['src']
                # The caller verifies the original document before supplying proof.
                # An unchanged blob URL still refers to the same immutable bytes.
                reuse = (src.startswith('blob:') and isinstance(verified_media, dict)
                         and verified_media.get('status') == 'uploaded'
                         and verified_media.get('verification') == 'blob_sha256'
                         and verified_media.get('media_src') == src
                         and verified_media.get('video_fingerprint') == digest)
                if src.startswith('blob:') and not reuse and await self._browser_digest(page, src) != digest:
                    raise RuntimeError('Preview video SHA-256 differs from the local video')
                result = {'status': 'uploaded', 'media_src': src, 'video_fingerprint': digest,
                          'verification': 'blob_sha256' if src.startswith('blob:') else 'ready_server_preview'}
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f'Video upload did not complete ({phase}); will not retry or submit')
            await asyncio.sleep(min(1, remaining))
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

    async def _read_media_bytes(self, page, src, *, digest):
        operation_id = secrets.token_hex(16)
        timeout = VIDEO_READ_TIMEOUT_SECONDS if digest else COVER_READ_TIMEOUT_SECONDS
        operation = asyncio.create_task(page.evaluate(_READ_MEDIA_BYTES, {
            'url': src, 'operationId': operation_id, 'timeoutMs': timeout * 1000, 'digest': digest,
        }))
        try:
            result = await asyncio.wait_for(asyncio.shield(operation), timeout=timeout + MEDIA_READ_GRACE_SECONDS)
            if not result['ok']:
                if result['timedOut']:
                    raise TimeoutError()
                raise RuntimeError(result['error'])
            return result['value']
        except BaseException as error:
            # Cancelling a CDP await does not cancel its in-page fetch or FileReader.
            try:
                await asyncio.wait_for(page.evaluate("""id=>window.__huobaoSauMediaReads?.get(id)?.()""",
                                                      operation_id), timeout=MEDIA_READ_GRACE_SECONDS)
            except BaseException:
                pass
            operation.cancel()
            await asyncio.gather(operation, return_exceptions=True)
            if isinstance(error, TimeoutError):
                label = '原视频指纹' if digest else '封面预览'
                raise TimeoutError(f'{label}读取超时，已保留原视频、封面和上传检查点，未保存或发表') from error
            raise

    async def _browser_digest(self, page, src):
        return await self._read_media_bytes(page, src, digest=True)

    async def _cover_pixels(self, page, src):
        encoded = await self._read_media_bytes(page, src, digest=False)
        return self.base._normalized_pixels(encoded)

    async def verify_page(self, page, metadata, covers):
        if await baijiahao_dialogs(page, self.base._READ_DIALOGS):
            raise RuntimeError("百家号封面弹窗尚未确认，未保存")
        await self.base._verify_metadata(page, metadata)
        slots = await self._cover_slots(page)
        for kind in ("landscape", "portrait"):
            if covers.get(kind, {}).get("status") != "uploaded" or not slots[kind].get("src"):
                raise RuntimeError("百家号横竖封面未设置完成，未保存")
            proof = covers[kind]
            if (not proof.get("fingerprint") or proof.get("source_sha256_verified") != proof["fingerprint"]
                    or not proof.get("preview") or slots[kind]["src"] != proof["preview"]
                    or not proof.get("pixels_sha256")):
                raise RuntimeError("百家号封面与本次上传证明不一致，未保存或发表")
            pixels = await self._cover_pixels(page, slots[kind]["src"])
            if hashlib.sha256(pixels.tobytes()).hexdigest() != proof["pixels_sha256"]:
                raise RuntimeError("百家号封面与本次上传证明不一致，未保存或发表")


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
