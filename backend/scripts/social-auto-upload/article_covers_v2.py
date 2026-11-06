"""Baijiahao three covers: local provenance, gallery URL binding, UI confirmation.

Call on a fresh editor after body upload, passing its local-URL -> uploaded-URL
mapping. The caller owns page creation and browser lifetime. Integrate both
article_covers and verify_article_covers at the staging/verification call sites;
using the old verifier would reintroduce remote pixel comparisons.

Completed legacy covers dictionaries are accepted via previous. Partial upload
recovery is deliberately not implemented. No remote image bytes are inspected.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import re
import time

from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from article_cover_selection import prepared_article_cover_images
from bridge import (
    _ARTICLE_COVER_GALLERY,
    _ARTICLE_COVER_SLOTS,
    article_cover_gallery,
    article_cover_slots,
    article_cover_source,
    canonical_article_image_url,
    one_button,
)

_RADIO = 'input[type="radio"][name="cover"][value="three"]'
_READY_TIMEOUT = 30
_POLL = 0.1


def _url(value):
    return canonical_article_image_url(value or "")


def _validate_plan(plan):
    if len(plan) != 3:
        raise RuntimeError("三图封面需要主封面和两张正文配图")
    digests = []
    for item in plan:
        digest = hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest()
        if digest != item["sha256"]:
            raise RuntimeError("三图封面原文件已变化，未继续")
        digests.append(digest)
    if len(set(digests)) != 3:
        raise RuntimeError("三图封面存在重复本地图片，未继续")


async def verify_article_covers(page, covers, helpers, bound=False):
    """Verify mode, three distinct slots, and recorded order without pixel reads."""
    plan = covers.get("plan", [])
    _validate_plan(plan)
    radio = page.locator(_RADIO)
    slots = await article_cover_slots(page)
    if (covers.get("mode") != "three" or await radio.count() != 1
            or not await radio.is_checked() or len(slots) != 3 or not all(slots)):
        raise RuntimeError("三图封面模式或三张图片不完整，未保存")
    if len({_url(src) for src in slots}) != 3:
        raise RuntimeError("三图封面存在重复图片，未保存")
    items = covers.get("items", [])
    if len(items) != 3 or not all(item.get("preview") for item in items):
        raise RuntimeError("三图封面缺少确认后的预览记录，未保存")
    # The platform can replace blob/CDN URLs after cropping and persistence.
    # Reject a known swap, but do not require derived URLs to stay identical.
    _check_known_order(slots, [item["preview"] for item in items])
    return [{**item, "preview": src} for item, src in zip(plan, slots)]


async def _three_slots(page):
    radio = page.locator(_RADIO)
    if await radio.count() != 1:
        raise RuntimeError("百家号三图封面选项不唯一，未继续")
    if not await radio.is_checked():
        label = page.locator("label").filter(has=radio)
        if not await label.count():
            identifier = await radio.get_attribute("id")
            if identifier:
                label = page.locator(f'label[for={json.dumps(identifier)}]')
        if await label.count() != 1:
            raise RuntimeError("百家号三图封面标签不唯一，未继续")
        # Controlled radios may revert synchronously, then commit on a later
        # render. Locator.check() incorrectly treats that intermediate state as
        # failure. Click the associated label and wait for the actual UI state.
        await label.click(timeout=10000)
    deadline = time.monotonic() + _READY_TIMEOUT
    while time.monotonic() < deadline:
        slots = await article_cover_slots(page)
        if await radio.is_checked() and len(slots) == 3:
            return slots
        await asyncio.sleep(_POLL)
    raise TimeoutError("百家号三图封面控件未就绪，未继续")


def _selection(gallery):
    return sorted((row["selected"], index) for index, row in enumerate(gallery) if row["selected"])


def _check_known_order(previews, sources):
    positions = {_url(src): index for index, src in enumerate(sources)}
    if any(_url(src) in positions and positions[_url(src)] != index for index, src in enumerate(previews)):
        raise RuntimeError("三图封面预览与所选图片顺序不符，未保存")


async def _main_source(page, modal, inputs, main, helpers, record, body_sources):
    before = {_url(row["src"]) for row in await article_cover_gallery(modal) if row["src"]}
    record(selectionStartedAt=time.time())
    # This explicit selection binds the only upload to the checked local file.
    # The platform is allowed to clear the input and replace its blob with a
    # compressed remote URL before set_input_files returns.
    await inputs.set_input_files(main["path"], timeout=10000)
    await article_cover_source(page, modal, inputs, main["sha256"], helpers)
    record(source_sha256_verified=main["sha256"])
    deadline = time.monotonic() + _READY_TIMEOUT
    while time.monotonic() < deadline:
        text = await modal.inner_text()
        if re.search(r"上传失败|图片格式不支持|文件过大", text):
            raise RuntimeError("百家号主封面上传失败，未继续")
        added = [row["src"] for row in await article_cover_gallery(modal)
                 if row["src"] and _url(row["src"]) not in before | body_sources]
        if len(added) > 1:
            raise RuntimeError("主封面上传后的图库来源不唯一，未继续")
        if len(added) == 1 and not re.search(r"上传中|\d+%", text):
            src = added[0]
            if src.startswith("blob:") and await helpers._browser_digest(page, src) != main["sha256"]:
                raise RuntimeError("主封面本地来源与项目原封面不符，未继续")
            return src
        await asyncio.sleep(_POLL)
    raise TimeoutError("主封面上传后未出现在图库，未继续")


async def _gallery_indices(modal, sources):
    deadline = time.monotonic() + _READY_TIMEOUT
    while time.monotonic() < deadline:
        gallery = await article_cover_gallery(modal)
        matches = [[index for index, row in enumerate(gallery) if _url(row["src"]) == _url(src)]
                   for src in sources]
        if any(len(indices) > 1 for indices in matches):
            raise RuntimeError("三图封面图库存在重复来源，未继续")
        if all(matches):
            return gallery, [indices[0] for indices in matches]
        await asyncio.sleep(_POLL)
    raise TimeoutError("正文图库缺少所需的三图封面图片，未继续")


async def _ready_previews(modal, sources, desired):
    gallery = await article_cover_gallery(modal)
    if (_selection(gallery) != list(enumerate(desired, 1))
            or any(index >= len(gallery) or _url(gallery[index]["src"]) != _url(src)
                   for index, src in zip(desired, sources))):
        raise RuntimeError("三图封面选择数量、来源或顺序发生变化，未继续")
    # Cropped URLs can differ from gallery URLs. Identity was bound at selection;
    # only slot presence/uniqueness is required here, not remote decoding.
    previews = await modal.locator('[class*="-coverItem"]').evaluate_all("""es=>es.map(e=>{
      const images=e.querySelectorAll('img');
      return images.length===1 ? images[0].currentSrc||images[0].getAttribute('src') : null;
    })""")
    if len(previews) != 3 or not all(previews):
        return False
    if len({_url(src) for src in previews}) != 3:
        raise RuntimeError("三图封面裁剪预览存在重复图片，未继续")
    _check_known_order(previews, sources)
    return previews


async def article_covers(page, payload, helpers, image_urls, previous=None, checkpoint=None):
    """Select one local main cover + two prepared body images on a fresh page."""
    main = {"path": payload["landscapePath"],
            "sha256": hashlib.sha256(Path(payload["landscapePath"]).read_bytes()).hexdigest()}
    plan = [main, *prepared_article_cover_images(payload)]
    _validate_plan(plan)
    body_sources = [image_urls.get(item["url"]) for item in plan[1:]]
    if not all(body_sources):
        raise RuntimeError("三图封面缺少正文配图上传 URL 映射，未继续")
    if len({_url(src) for src in body_sources}) != 2:
        raise RuntimeError("三图封面正文配图上传 URL 重复，未继续")
    if previous:
        identity = lambda items: [(item.get("path"), item.get("sha256"), item.get("url")) for item in items]
        if previous.get("mode") != "three" or identity(previous.get("plan", [])) != identity(plan):
            raise RuntimeError("三图封面检查点与当前文章不一致，未继续")
        if not previous.get("items"):
            raise RuntimeError("三图封面检查点尚未完成，请使用新编辑页上传")
        return {**previous, "items": await verify_article_covers(page, previous, helpers, bound=True)}
    covers = {"mode": "three", "plan": plan}

    def record(**changes):
        covers.update(changes)
        if checkpoint:
            checkpoint(dict(covers))

    # Fresh uploads never adopt unidentified existing covers or redo an upload.
    if any(await article_cover_slots(page)):
        raise RuntimeError("当前页面已有封面，请使用新编辑页上传")
    slots = await _three_slots(page)
    if any(slots):
        raise RuntimeError("当前页面已有封面，请使用新编辑页上传")
    modal = page.locator('[role="dialog"]:visible')
    if not await modal.count():
        await page.locator(_ARTICLE_COVER_SLOTS).first.get_by_text("选择封面", exact=True).click(timeout=10000)
    await modal.wait_for(state="visible", timeout=10000)
    if await modal.count() != 1 or not re.search(r"封面预览\s*[(（]4:3[)）]", await modal.inner_text()):
        raise RuntimeError("当前弹窗不是唯一的三图 4:3 封面编辑器，未继续")
    inputs = modal.locator('.cheetah-upload-select').filter(
        has_text=re.compile(r"^\s*本地上传\s*$")).locator('input[type="file"][accept*="image"]')
    if await inputs.count() != 1:
        raise RuntimeError("百家号封面本地上传控件不唯一，未继续")
    if await inputs.evaluate("e=>e.files.length"):
        raise RuntimeError("封面弹窗已选择本地文件，请使用新编辑页上传")
    known_body = {_url(src) for src in image_urls.values() if src}
    gallery = await article_cover_gallery(modal)
    if any(row["selected"] and _url(row["src"]) not in known_body for row in gallery):
        raise RuntimeError("封面弹窗选中了其他图片，未覆盖人工选择")
    record()
    main_source = await _main_source(page, modal, inputs, main, helpers, record, known_body)
    sources = [main_source, *body_sources]
    if len({_url(src) for src in sources}) != 3:
        raise RuntimeError("三图封面图库来源重复，未继续")
    record(sources=sources)
    gallery, desired = await _gallery_indices(modal, sources)
    if _selection(gallery) != list(enumerate(desired, 1)):
        for _, index in _selection(gallery):
            await modal.locator(_ARTICLE_COVER_GALLERY).nth(index).locator('[class*="-hotArea"]').click(timeout=10000)
        for index in desired:
            await modal.locator(_ARTICLE_COVER_GALLERY).nth(index).locator('[class*="-hotArea"]').click(timeout=10000)
    deadline = time.monotonic() + _READY_TIMEOUT
    while not (previews := await _ready_previews(modal, sources, desired)):
        if time.monotonic() >= deadline:
            raise TimeoutError("三张封面裁剪预览未齐备，未继续")
        await asyncio.sleep(_POLL)
    deadline = time.monotonic() + 60
    while True:
        record(confirmAttemptedAt=time.time())
        await (await one_button(modal, ("确定 (3)", "确定（3）"))).click(timeout=10000)
        try:
            await modal.wait_for(state="hidden", timeout=2000)
            break
        except PlaywrightTimeoutError:
            notices = "\n".join(await page.locator('[role="alert"],.cheetah-message-notice').all_inner_texts())
            if not re.search(r"封面裁剪处理中.*稍后再点击", notices):
                raise
            if time.monotonic() >= deadline:
                raise TimeoutError("百家号封面裁剪仍在处理中，未继续")
            await asyncio.sleep(1)
            previews = await _ready_previews(modal, sources, desired)
            if not previews:
                raise RuntimeError("裁剪等待期间三图预览不完整，未继续确认")
    deadline = time.monotonic() + _READY_TIMEOUT
    while time.monotonic() < deadline:
        slots = await article_cover_slots(page)
        if len(slots) == 3 and all(slots):
            _check_known_order(slots, sources)
            _check_known_order(slots, previews)
            covers["items"] = [{**item, "preview": src} for item, src in zip(plan, slots)]
            record(items=await verify_article_covers(page, covers, helpers))
            return covers
        await asyncio.sleep(_POLL)
    raise TimeoutError("三图封面确认后缺少实际预览，未保存")
