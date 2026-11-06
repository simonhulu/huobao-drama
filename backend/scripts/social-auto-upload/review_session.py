"""Human review of a bound SAU account without replacing its unfinished editor."""
from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import secrets
from urllib.parse import urlparse

from account_browser import connect_account_browser, connect_existing_account_browser
from upload_locks import account_lock_key, upload_locks


CONTENT_URL = "https://baijiahao.baidu.com/builder/rc/content"
ALLOWED_HOSTS = {"baijiahao.baidu.com", "passport.baidu.com", "wappass.baidu.com", "verify.baidu.com", "mbd.baidu.com"}
ALLOWED_KEYS = {"Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "ControlOrMeta+A"}
COMMAND_FIELDS = {
    "click": {"x", "y"}, "drag": {"x", "y", "toX", "toY"},
    "type": {"text"}, "key": {"key"}, "scroll": {"deltaY"}, "refresh": set(),
}


def allowed_url(raw):
    try:
        url = urlparse(raw)
        return (url.scheme == "https" and url.hostname in ALLOWED_HOSTS
                and not url.username and not url.password and url.port in (None, 443))
    except (TypeError, ValueError):
        return False


def validate_input(value):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("action") not in COMMAND_FIELDS:
        raise ValueError("核对窗口操作无效")
    action = value["action"]
    if set(value) != {"action", "targetId", *COMMAND_FIELDS[action]}:
        raise ValueError("核对窗口操作参数不完整或包含未知内容")
    if not isinstance(value["targetId"], str) or not re.fullmatch(r"[a-fA-F0-9]+", value["targetId"]):
        raise ValueError("核对窗口标识无效，请重新打开窗口")
    for key in COMMAND_FIELDS[action] - {"text", "key"}:
        number = value[key]
        if type(number) not in (int, float) or not math.isfinite(number):
            raise ValueError("核对窗口坐标无效")
        if key == "deltaY" and abs(number) > 2000:
            raise ValueError("单次滚动距离超出范围")
    if action == "type" and (not isinstance(value["text"], str) or not 1 <= len(value["text"]) <= 2000):
        raise ValueError("请输入 1 至 2000 字符")
    if action == "key" and value["key"] not in ALLOWED_KEYS:
        raise ValueError("核对窗口不支持此按键")
    return value


async def find_page(browser, target_id, bridge):
    matches = []
    for context in browser.contexts:
        for page in list(context.pages):
            if not page.is_closed() and await bridge.page_id(page) == target_id:
                matches.append(page)
    return matches[0] if len(matches) == 1 else None


async def viewport(page):
    size = page.viewport_size
    if not size:
        size = await page.evaluate("() => ({width: innerWidth, height: innerHeight})")
    if (not isinstance(size, dict) or any(type(size.get(key)) is not int or not 1 <= size[key] <= 8192
                                          for key in ("width", "height"))):
        raise RuntimeError("核对窗口尺寸无效，请重新打开")
    return size


async def apply_input(page, command, size):
    action = command["action"]
    for x, y in (("x", "y"), ("toX", "toY")):
        if x in command and not (0 <= command[x] < size["width"] and 0 <= command[y] < size["height"]):
            raise ValueError("操作位置超出核对窗口，请刷新画面")
    if action == "click":
        await page.mouse.click(command["x"], command["y"])
    elif action == "drag":
        await page.mouse.move(command["x"], command["y"])
        await page.mouse.down()
        try:
            await page.mouse.move(command["toX"], command["toY"], steps=18)
        finally:
            await page.mouse.up()
    elif action == "type":
        await page.keyboard.insert_text(command["text"])
    elif action == "key":
        await page.keyboard.press(command["key"])
    elif action == "scroll":
        await page.mouse.wheel(0, command["deltaY"])
    if action != "refresh":
        await asyncio.sleep(0.25)


async def review_session(request, bridge=None):
    if bridge is None:
        import bridge
    command = validate_input(request.get("input"))
    view = request.get("view", "original")
    if view not in ("original", "content"):
        raise ValueError("核对窗口视图无效")
    payload, config = request["payload"], request["config"]
    state_file = bridge.job_state_file(request)
    if payload.get("target") != "baijiahao-video" or not payload.get("accountName"):
        raise ValueError("核对窗口需要任务绑定的百家号账号")
    name = bridge.validate_named_target(payload)
    with upload_locks(config, [account_lock_key("baijiahao", name), f"job:{payload['jobId']}"]):
        state = json.loads(state_file.read_text()) if state_file.is_file() else {}
        expected_payload = bridge.payload_digest(payload)
        if state and state.get("payloadDigest") != expected_payload:
            raise RuntimeError("核对窗口与原上传任务不匹配，未操作平台")
        credential_digest = state.get("accountCredentialDigest")
        if credential_digest is not None and (not isinstance(credential_digest, str)
                                              or not re.fullmatch(r"[a-f0-9]{64}", credential_digest)):
            raise RuntimeError("原上传账号会话记录无效，请检查原任务")
        review_file = state_file.with_name("review.json")
        if review_file.is_symlink():
            raise ValueError("核对窗口记录无效")
        previous = json.loads(review_file.read_text()) if review_file.is_file() else {}
        if command and (previous.get("payloadDigest") != expected_payload or previous.get("accountName") != name
                        or previous.get("targetId") != command["targetId"]):
            raise RuntimeError("核对窗口已变化，请重新打开后再操作")
        _, _, async_playwright, _, _, _ = bridge.load_engine()
        async with async_playwright() as playwright:
            browser = None
            if credential_digest:
                browser = await connect_existing_account_browser(playwright, config, name, credential_digest)
            if browser is None:
                browser, _, credential_digest = await connect_account_browser(playwright, config, name, credential_digest)
            if credential_digest is None:
                credential_digest = browser._huobao_managed_session["credentialDigest"]
            if command and previous.get("credentialDigest") != credential_digest:
                raise RuntimeError("账号会话已变化，请重新打开核对窗口")
            original = False
            message = "正在查看原账号的内容管理，可核对草稿、审核中和已发表作品"
            page = None
            if command:
                page = await find_page(browser, command["targetId"], bridge)
                if page is None:
                    raise RuntimeError("核对页面已关闭，请重新打开；原任务未被替换")
                original = previous.get("originalEditor") is True
                if original:
                    await bridge.verify_document(page, payload, state)
            else:
                if view == "original" and state.get("targetId"):
                    candidate = await find_page(browser, state["targetId"], bridge)
                    if candidate and allowed_url(candidate.url):
                        try:
                            await bridge.verify_document(candidate, payload, state)
                            page, original = candidate, True
                        except RuntimeError:
                            pass
                if page is None:
                    if previous.get("accountName") == name and previous.get("credentialDigest") == credential_digest and not previous.get("originalEditor"):
                        candidate = await find_page(browser, previous.get("targetId"), bridge)
                        if candidate and allowed_url(candidate.url) and urlparse(candidate.url).path == "/builder/rc/content":
                            page = candidate
                    if page is None:
                        page = await browser.contexts[0].new_page()
                        try:
                            await page.set_viewport_size({"width": 1440, "height": 1000})
                            await page.goto(CONTENT_URL, wait_until="domcontentloaded", timeout=30000)
                        except Exception:
                            await page.close(run_before_unload=False)
                            raise
                    if view == "original":
                        message = "原编辑页已关闭或身份已变化，已打开同一账号的内容管理，请核对草稿和作品"
            if not allowed_url(page.url):
                raise RuntimeError("核对页面已离开百家号或百度验证页面，请重新打开窗口")
            size = await viewport(page)
            if command:
                await apply_input(page, command, size)
                if not allowed_url(page.url):
                    raise RuntimeError("页面已离开百家号核对范围，请重新打开窗口")
            target_id = await bridge.page_id(page)
            state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            bridge.write_state(review_file, {"accountName": name, "payloadDigest": expected_payload,
                "credentialDigest": credential_digest, "targetId": target_id, "originalEditor": original,
                "token": previous.get("token") if command else secrets.token_hex(24)})
            screenshot = await page.screenshot(type="jpeg", quality=65, full_page=False)
            if original:
                message = "正在查看本任务的原编辑页，可完成安全验证或核对文案"
            return {"jobId": payload["jobId"], "targetId": target_id, "url": page.url,
                "imageDataUrl": "data:image/jpeg;base64," + base64.b64encode(screenshot).decode(),
                "width": size["width"], "height": size["height"], "originalEditor": original, "message": message}
