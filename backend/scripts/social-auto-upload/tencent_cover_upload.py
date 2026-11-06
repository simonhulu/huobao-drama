"""Tencent cover orchestration with bounded UI actions and selected-source evidence.

The caller binds the page and immutable payload to its job before calling this
adapter. This module only edits covers: it never uploads videos, saves drafts or
publishes. Only local source selection and usable previews are required.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import inspect
import re
import time


_IMAGES = {
    "portrait": ".vertical-img-wrap,[class*='vertical'][class*='img'],[class*='portrait'][class*='img']",
    "landscape": ".horizon-img-wrap,.horizontal-img-wrap,[class*='horizon'][class*='img'],[class*='horizontal'][class*='img']",
}
_CROP_TITLE = "裁剪封面图"
_UPLOAD_TIMEOUT = 120


async def _dialog_state(page, helpers):
    kind = editor = crop = None
    for dialog in await helpers._visible_dialogs(page):
        title = await helpers._dialog_title(dialog)
        if title == _CROP_TITLE and crop is None:
            crop = dialog
        elif title in helpers._TITLES.values() and editor is None:
            kind = next(key for key, value in helpers._TITLES.items() if value == title)
            editor = dialog
        else:
            raise RuntimeError("Unexpected or ambiguous Tencent cover dialog")
    return kind, editor, crop


async def _recommendation(page, helpers):
    popups = page.locator(".ant-popover:visible")
    count = await popups.count()
    if not count:
        return None
    matching = popups.filter(has_text=re.compile(r"使用此素材作为封面[?？]"))
    if count != 1 or await matching.count() != 1:
        raise RuntimeError("Unexpected cover recommendation popup")
    return await matching.element_handle()


async def open_tencent_cover_dialog(page, kind, helpers, timeout=20):
    """Wait for the card, scroll into view, then open its cover-only editor."""
    if kind not in _IMAGES:
        raise ValueError(f"Unknown Tencent cover kind: {kind}")
    deadline = time.monotonic() + timeout
    clicks = 0
    next_click = 0
    material_clicked = False
    last_error = "封面卡片尚未加载"
    while time.monotonic() < deadline:
        current, editor, crop = await _dialog_state(page, helpers)
        popup = await _recommendation(page, helpers)
        if editor is not None or crop is not None:
            if current != kind or crop is not None:
                raise RuntimeError(f"Unexpected dialog while opening {kind} cover")
            if popup is not None:
                # The accepted recommendation fades after mounting the editor.
                # It is the same known popup, not an unrelated modal.
                await helpers._wait_hidden(popup, min(3, max(0, deadline - time.monotonic())),
                                           "封面素材提示")
            return editor
        if popup is not None:
            if not material_clicked:
                await (await helpers._one_button(popup, ("使用素材",))).click()
                material_clicked = True
        elif clicks < 3 and time.monotonic() >= next_click:
            try:
                slot = await helpers._slot(page, kind)
                image = slot.locator(_IMAGES[kind]).filter(visible=True)
                if not await image.count():
                    image = slot.locator("img").filter(visible=True).first.locator("..")
                if await image.count():
                    target = image.first
                    await target.scroll_into_view_if_needed(timeout=1500)
                    await target.click(timeout=1500)
                    clicks += 1
                    next_click = time.monotonic() + 3
            except Exception as error:
                last_error = str(error)
                clicks += 1
                next_click = time.monotonic() + 1
        await asyncio.sleep(0.15)
    label = "竖版" if kind == "portrait" else "横版"
    raise TimeoutError(f"{label}封面窗口未打开，请重新上传（{last_error[:120]}）")


async def _pending_kind(page, helpers, local):
    kind, editor, crop = await _dialog_state(page, helpers)
    if crop is not None and editor is None:
        # Some platform layouts hide the parent while cropping. Bind the crop
        # to an exact local source before confirming anything.
        matches = [key for key, source in local.items()
                   if await helpers._source_verified(page, crop, source)]
        if len(matches) != 1:
            raise RuntimeError("Open Tencent crop does not match one supplied cover")
        kind = matches[0]
    return kind


async def _upload_one(page, kind, local, helpers):
    deadline = time.monotonic() + _UPLOAD_TIMEOUT
    current, dialog, crop = await _dialog_state(page, helpers)
    if current is not None and current != kind:
        raise RuntimeError(f"Open cover editor does not belong to {kind}")
    if dialog is None and crop is None:
        dialog = await open_tencent_cover_dialog(page, kind, helpers)

    control = None
    source_verified = False
    if dialog is not None:
        controls = await dialog.query_selector_all('.single-cover-uploader-wrap input[type="file"]')
        if len(controls) != 1:
            raise RuntimeError("Expected one cover-only file input in the current dialog")
        control = controls[0]
        digest = await helpers._input_source_digest(control)
        if digest and digest != local["sha256"]:
            raise RuntimeError(f"{kind} cover input differs from the local file")
        source_verified = digest == local["sha256"]
    for root in (crop, dialog):
        if root is not None:
            source_verified = source_verified or await helpers._source_verified(page, root, local)
    if not source_verified:
        if crop is not None:
            raise RuntimeError("Open crop source does not match the supplied local cover")
        # A matching open editor with no selected file is the initial failure
        # checkpoint. Reuse that dialog; select the file exactly once.
        await helpers._capture_input_source(control)
        await helpers.set_local_input_file(page, control, local["path"])
        digest = await helpers._input_source_digest(control)
        if digest and digest != local["sha256"]:
            raise RuntimeError(f"{kind} cover input differs from the local file")
        source_verified = digest == local["sha256"]

    crop_confirmed = False
    while True:
        current, dialog, crop = await _dialog_state(page, helpers)
        if current is not None and current != kind:
            raise RuntimeError(f"Unexpected dialog while applying {kind} cover")
        if await page.locator(".ant-popover:visible").count():
            raise RuntimeError("Unexpected popup while applying cover image")
        root = crop if crop is not None else dialog
        if root is None:
            raise RuntimeError("Cover editor closed before verified confirmation")
        if crop is not None and crop_confirmed:
            raise RuntimeError("Cover crop dialog reopened after confirmation")
        await helpers._check_crop_geometry(root, kind)
        source_verified = source_verified or await helpers._source_verified(page, root, local)
        preview = await helpers._read_preview(page, root, kind, local["pixels"])
        if source_verified and preview:
            await (await helpers._one_button(root, ("确定", "确认"))).click()
            await helpers._wait_hidden(root, max(0, deadline - time.monotonic()), f"{kind} cover")
            if crop is None:
                break
            crop_confirmed = True
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{kind} source/crop preview was not verified; will not confirm")
        await asyncio.sleep(0.2)
    while True:
        if await helpers._visible_dialogs(page):
            raise RuntimeError("A dialog remains open after cover confirmation")
        preview = await helpers._read_preview(page, await helpers._slot(page, kind), kind, local["pixels"])
        if preview:
            return {"status": "uploaded", "source_sha256": local["sha256"],
                    "source_width": local["width"], "source_height": local["height"],
                    "crop_confirmed": crop_confirmed, **preview}
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{kind}封面确认后未显示，请重新上传")
        await asyncio.sleep(0.2)


async def upload_tencent_covers(page, payload, helpers, previous=None, checkpoint=None):
    """Set both covers on the bound editor and record completed actions."""
    previous = previous or {}
    if previous and previous.get("layout") != "tencent-dual-cover":
        raise RuntimeError("Unexpected Tencent cover checkpoint layout")
    local = {kind: await asyncio.to_thread(helpers._local_cover, payload[f"{kind}Path"], kind)
             for kind in ("portrait", "landscape")}
    pending = await _pending_kind(page, helpers, local)
    result = {"layout": "tencent-dual-cover"}
    for kind, source in local.items():
        record = previous.get(kind)
        if not record:
            continue
        if record.get("status") != "uploaded" or record.get("source_sha256") != source["sha256"]:
            raise RuntimeError(f"{kind} cover checkpoint differs from the local source")
        if pending == kind:
            raise RuntimeError(f"Completed {kind} cover has an unexpected open editor")
        preview = await helpers._read_preview(page, await helpers._slot(page, kind), kind, source["pixels"])
        if not preview:
            raise RuntimeError(f"Completed {kind} cover preview changed")
        result[kind] = {**record, **preview}
    kinds = [pending] if pending else []
    kinds += [kind for kind in local if kind != pending]
    for kind in kinds:
        if kind not in result:
            result[kind] = await _upload_one(page, kind, local[kind], helpers)
            if checkpoint is not None:
                saved = checkpoint(deepcopy(result))
                if inspect.isawaitable(saved):
                    await saved
    return await helpers.verify_covers(page, result)
