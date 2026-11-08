"""SAU adapter: legacy drafts and explicitly requested Baijiahao video publication."""
from __future__ import annotations

import asyncio
import base64
import errno
import fcntl
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import unicodedata
from datetime import datetime
from functools import partial
from zoneinfo import ZoneInfo
from urllib.parse import parse_qs, urlparse
from account_browser import HISTORY_ACCOUNTS, account_storage, cleanup_stale_baijiahao_pages, connect_account_browser, connect_existing_account_browser, validate_account_name
from upload_locks import UploadLockBusy, account_lock_key, browser_lock_key, upload_locks
import history_sessions
from draft_list_navigation import locate_tencent_draft
from baijiahao_draft_listing import BaijiahaoDraftListingError, locate_baijiahao_draft
from video_storage import install_video_storage_isolation
from editor_compat import BaijiahaoEditor, TencentCovers, baijiahao_dialogs, fill_tencent_metadata, tencent_metadata
from baijiahao_topics import RequiredTopicError, add_optional_topics, video_description, unselected_topic_suffix, _base as optional_topic_base


HOMES = {
    "baijiahao": "https://baijiahao.baidu.com/builder/rc/home",
    "tencent": "https://channels.weixin.qq.com/platform",
}
PLATFORM_CHECK_TIMEOUT = 45
HISTORY_PLATFORM_TIMEOUT = 62
EDITORS = {
    "baijiahao-video": "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&is_from_cms=1",
    "baijiahao-article": "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    "tencent-video": "https://channels.weixin.qq.com/platform/post/create",
}

# The blank editor supports batch uploads, but we supply exactly one file.
# Prefer its upload area when auxiliary video pickers are also mounted.
BAIJIAHAO_VIDEO_INPUT_SELECTOR = (
    'input[type="file"][accept*="video"],'
    'input[type="file"][accept*="mp4"]'
)
BAIJIAHAO_UPLOAD_AREA_SELECTOR = '[class$="-blankWrap"]'
BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR = (
    f'{BAIJIAHAO_UPLOAD_AREA_SELECTOR} [class$="-inputWrap"] '
    f':is({BAIJIAHAO_VIDEO_INPUT_SELECTOR})'
)


def emit(kind, value):
    print("SAU_" + kind + " " + json.dumps(value, ensure_ascii=False), flush=True)


def progress(message, step="working"):
    try:
        emit("PROGRESS", {"step": step, "message": message})
    except BrokenPipeError:
        pass
    except OSError as error:
        if error.errno != errno.EPIPE:
            raise


def write_state(file, state):
    temporary = file.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(state, stream, ensure_ascii=False)
    temporary.replace(file)


def checkpoint_progress(file, state, step, message):
    state["progress"] = {"step": step, "message": message}
    write_state(file, state)
    progress(message, step)


def checkpoint_details(file, state, details):
    state["details"] = details
    if details.get("covers"):
        step, message = "covers", "已记录当前封面步骤，继续完成封面"
    elif details.get("metadata") or details.get("article"):
        step, message = "metadata", "正文或视频文案已准备，正在完成封面"
    else:
        step, message = "media", "已记录素材上传进度"
    checkpoint_progress(file, state, step, message)


def payload_digest(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def publication_mode(payload):
    mode = payload.get("publicationMode", "draft")
    if mode not in ("draft", "publish") or (mode == "publish" and payload.get("target") != "baijiahao-video"):
        raise ValueError("直接发表仅支持百家号视频")
    return mode


def local_files(payload):
    paths = [payload[key] for key in ("videoPath", "landscapePath", "portraitPath") if payload.get(key)]
    paths.extend(image["path"] for image in payload.get("images", []))
    result = {}
    for value in paths:
        file = Path(value).resolve(strict=True)
        if not file.is_file() or file.stat().st_size <= 0:
            raise ValueError("上传素材不存在、为空或不可读取")
        with file.open("rb") as stream:
            result[str(file)] = hashlib.file_digest(stream, "sha256").hexdigest()
    return result


def validate_endpoint(value):
    endpoint = urlparse(value)
    if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port or endpoint.path not in ("", "/"):
        raise ValueError("平台浏览器仅支持本机 127.0.0.1 CDP 连接")
    return value


def load_engine():
    from uploader.baijiahao_uploader.main import BaiJiaHaoVideo, async_playwright
    from uploader.tencent_uploader.main import TencentVideo
    from uploader.baijiahao_uploader import stage as baijiahao_stage
    from uploader.tencent_uploader import staging_runtime as tencent_stage
    from uploader.tencent_uploader import stage as tencent_covers

    for cls in (BaiJiaHaoVideo, TencentVideo):
        if not {"stage_only", "cdp_url"}.issubset(inspect.signature(cls).parameters):
            raise RuntimeError("现有 SAU 缺少安全上传扩展；为防止直接发布，已停止")
    class BaijiahaoDraftVideo(BaiJiaHaoVideo):
        async def _select_video_file(self, page, file_input, *, selector=BAIJIAHAO_VIDEO_INPUT_SELECTOR):
            # videoV2 replaces the upload card synchronously on file change.
            # Keep the selected DOM node so SAU can inspect its FileList even
            # after unmount; resolving the old locator would time out.
            handle = await file_input.element_handle()
            if handle is None:
                raise RuntimeError("百家号视频上传控件已变化，尚未传入素材")
            try:
                await super()._select_video_file(page, handle, selector=selector)
            finally:
                await handle.dispose()

    class TencentDraftVideo(TencentVideo):
        async def open_upload_page(self, page):
            await page.set_viewport_size({"width": 1440, "height": 1000})
            await super().open_upload_page(page)

        async def prepare_video_for_publish(self, page):
            return await fill_tencent_metadata(page, self.short_title, self.desc)

    return (BaijiahaoDraftVideo, TencentDraftVideo, async_playwright, BaijiahaoEditor(baijiahao_stage),
            tencent_stage, TencentCovers(tencent_covers))


async def page_id(page):
    session = await page.context.new_cdp_session(page)
    try:
        return (await session.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
    finally:
        await session.detach()


def saved_upload_cleanup_confirmed(payload, state, file):
    """Do not dispose recovery pages on the strength of an in-memory receipt."""
    try:
        persisted = json.loads(file.read_text(encoding="utf-8"))
        for snapshot in (state, persisted):
            result = checkpoint_result(payload, snapshot)
            if (snapshot.get("phase") != "saved" or not result or result.get("saved") is not True
                    or not has_saved_draft_identity(payload, result)
                    or snapshot.get("payloadDigest") != payload_digest(payload)
                    or not snapshot.get("documentToken")):
                return False
        return all(persisted.get(key) == state.get(key) for key in
                   ("targetId", "documentToken", "result"))
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return False


def saved_upload_tab_owned(binding, payload, state):
    """A target alone is insufficient: a person may have reused that tab."""
    if not isinstance(binding, dict) or binding.get("name") != "huobao-sau-" + payload["jobId"]:
        return False
    token = binding.get("token")
    if token is not None and token != state["documentToken"]:
        return False
    try:
        url = urlparse(binding.get("href", ""))
        original = urlparse(EDITORS[payload["target"]])
        if (url.scheme != "https" or url.hostname != original.hostname
                or url.username or url.password or url.port not in (None, 443) or url.fragment):
            return False
        # Saving may navigate the original tab and clear its JS document token.
        # Only known list destinations may use the retained task window.name.
        landing = ("/platform/post/draftListManager", "/platform/post/list") if payload["target"] == "tencent-video" else ("/builder/rc/content",)
        if url.path in landing:
            return True
        if url.path != original.path or token != state["documentToken"]:
            return False
        query = parse_qs(url.query, keep_blank_values=True)
        if payload["target"] != "tencent-video":
            expected = parse_qs(urlparse(state["result"]["draftUrl"]).query)
            return (query.get("type") == expected.get("type")
                    and ("article_id" not in query or query["article_id"] == expected.get("article_id")))
        return all(key not in query or query[key] == [state.get("expectedDraftId")]
                   for key in ("id", "draftId", "objectId"))
    except (ValueError, TypeError, KeyError):
        return False


async def close_disposable_verification_page(page):
    """A failed close must never replace a save receipt or the original error."""
    if page is not None:
        try:
            await asyncio.wait_for(page.close(run_before_unload=False), timeout=2)
        except Exception:
            pass


async def cleanup_saved_upload_tab(browser, payload, state, file):
    """Best-effort cleanup using an existing connection, under the upload lock.

    Also usable for completed jobs: never connects, launches, saves or uploads.
    Uncertain/staged pages and tabs lacking this task's ownership are retained.
    """
    outcome = {"closed": False, "reason": "not_confirmed", "browserClosed": False}
    if not saved_upload_cleanup_confirmed(payload, state, file):
        return outcome

    async def cleanup():
        target = state["result"]["targetId"]
        pages = []
        for context in browser.contexts:
            for page in list(context.pages):
                try:
                    if not page.is_closed() and await page_id(page) == target:
                        pages.append(page)
                except Exception:
                    continue  # Another tab closing does not affect this task.
        if len(pages) != 1:
            outcome["reason"] = "not_found" if not pages else "ambiguous_target"
            return
        page = pages[0]
        binding = await page.evaluate("() => ({name:window.name, token:window.__huobaoSauDocumentToken, href:location.href})")
        if not saved_upload_tab_owned(binding, payload, state):
            outcome["reason"] = "ownership_changed"
            return
        if not saved_upload_cleanup_confirmed(payload, state, file):
            outcome["reason"] = "checkpoint_changed"
            return
        await page.close(run_before_unload=False)
        outcome.update(closed=True, reason="closed")

    try:
        await asyncio.wait_for(cleanup(), timeout=8)
    except Exception:
        outcome["reason"] = "cleanup_failed"
    # This helper independently refuses any live editor/unrelated tab and only
    # operates on verified managed sessions. It keeps profiles and credentials.
    try:
        from account_browser import close_idle_account_browser
        outcome["browserClosed"] = await close_idle_account_browser(browser)
    except Exception:
        pass
    return outcome


async def login_state(page, platform):
    text = "\n".join(await page.locator("body").all_inner_texts())
    location = urlparse(page.url)
    login_url = location.hostname == "passport.baidu.com" or re.search(r"/login(?:[./]|$)", location.path)
    login = re.search(r"扫码登录|微信扫码|账号密码登录", text)
    if platform == "baijiahao":
        # The authenticated homepage has a daily task: “登录百家号 / 已完成”.
        # Those generic words indicate logout only when they label a visible
        # login control, not when they occur anywhere in the dashboard body.
        login_controls = page.locator('button:visible, a:visible, [role="button"]:visible, [role="link"]:visible').filter(
            has_text=re.compile(r"^\s*(?:登录|登录百家号|注册百家号|注册/登录百家号|登录/注册百家号)\s*$"))
        passport_ui = page.locator(
            'iframe[src^="https://passport.baidu.com/"]:visible,'
            'iframe[src^="//passport.baidu.com/"]:visible,'
            'img[src^="https://passport.baidu.com/v2/api/qrcode"]:visible')
        login = login or await login_controls.count() or await passport_ui.count()
    else:
        login = login or re.search(r"注册/登录百家号|注册百家号|登录百家号", text)
    if login or login_url:
        return {"ready": False, "issue": "login_required", "message": "请先在平台浏览器中人工登录"}
    if re.search(r"安全验证|滑块验证|请完成验证", text):
        return {"ready": False, "issue": "verification_required", "message": "平台要求人工安全验证，完成后重新检查"}
    markers = r"内容管理|存草稿|作品描述" if platform == "baijiahao" else r"发表视频|内容管理|保存草稿|视频号助手|帐号管理|视频号\s*ID\s*[:：]"
    editor_inputs = await page.locator('input[placeholder*="短标题"],input[type="file"][accept*="video"]').count()
    platform_page = platform != "baijiahao" or (location.hostname == "baijiahao.baidu.com" and location.path.startswith("/builder/rc/"))
    if platform_page and (re.search(markers, text) or editor_inputs):
        return {"ready": True, "message": "平台浏览器已登录"}
    return {"ready": False, "issue": "check_failed", "message": "平台页面尚未就绪，登录状态未确认，请重新检查"}


class BrowserConnectionError(RuntimeError):
    def __init__(self, message, issue="connection_failed"):
        super().__init__(message)
        self.issue = issue


async def connect_platform_browser(playwright, endpoint, platform, *, config=None, cleanup_lock_held=False):
    endpoint = validate_endpoint(endpoint)
    label = "百家号" if platform == "baijiahao" else "视频号"
    if platform == "baijiahao" and config is not None:
        if cleanup_lock_held:
            await cleanup_stale_baijiahao_pages(config, endpoint)
        else:
            with upload_locks(config, [browser_lock_key(endpoint)]):
                await cleanup_stale_baijiahao_pages(config, endpoint)
    # CDP must initialize existing tabs after the WebSocket connects. Use the
    # SDK's normal 30s budget, with one bounded retry before any editor action.
    for attempt, timeout in enumerate((30000, 10000)):
        try:
            browser = await playwright.chromium.connect_over_cdp(endpoint, timeout=timeout)
            if not browser.contexts:
                raise RuntimeError("Browser context management is not supported")
            return browser
        except Exception as error:
            reason = str(error)
            if re.search(r"ECONNREFUSED|Connection refused", reason):
                raise BrowserConnectionError(f"{label}专用浏览器未启动，请打开登录窗口", "browser_unavailable") from error
            if "Browser context management is not supported" in reason:
                raise BrowserConnectionError(f"{label}浏览器会话已失效，请点击“登录{label}”恢复专用浏览器", "browser_unavailable") from error
            transient = isinstance(error, TimeoutError) or re.search(r"timeout|timed out|connection closed|websocket.*closed|target.*closed", reason, re.I)
            if transient and attempt == 0:
                progress(f"{label}本机浏览器连接较慢，正在重连（1/1）", "browser_connect")
                await asyncio.sleep(0.25)
                continue
            raise BrowserConnectionError(f"{label}本机浏览器连接失败或响应超时，登录状态尚未确认，请重试连接") from error


def validate_named_target(payload):
    name = validate_account_name(payload["accountName"])
    platform = HISTORY_ACCOUNTS.get(name)
    if platform:
        if payload.get("target") not in EDITORS or ("tencent" if payload["target"] == "tencent-video" else "baijiahao") != platform:
            raise ValueError("历史后台账号与上传平台不匹配")
    elif payload.get("target") != "baijiahao-video":
        raise ValueError("当前命名账号仅支持百家号视频")
    return name


async def connect_upload_browser(playwright, config, payload, state=None):
    """Named accounts never fall back to the shared legacy browser."""
    name = payload.get("accountName")
    if name is not None:
        validate_named_target(payload)
        result = await connect_account_browser(playwright, config, name, (state or {}).get("accountCredentialDigest"))
        if name in HISTORY_ACCOUNTS:
            try:
                await history_sessions.check_background_login(result[0], HISTORY_ACCOUNTS[name], login_state)
            except Exception:
                from account_browser import close_idle_account_browser
                await close_idle_account_browser(result[0])
                raise
        return result
    platform = "tencent" if payload["target"] == "tencent-video" else "baijiahao"
    endpoint = validate_endpoint(config[platform])
    return await connect_platform_browser(playwright, endpoint, platform, config=config, cleanup_lock_held=True), endpoint, None


async def account_runtime(config, account_name, *, keep_browser=False):
    validate_account_name(account_name)
    _, _, async_playwright, _, _, _ = load_engine()
    try:
        async with async_playwright() as playwright:
            progress("正在连接所选百家号账号的后台浏览器，尚未开始上传", "browser_connect")
            browser, _, _ = await connect_account_browser(playwright, config, account_name)
            page = await browser.contexts[0].new_page()
            result = {"ready": False, "issue": "check_failed", "message": "百家号页面尚未就绪，尚未开始上传，请重新检查账号"}
            try:
                progress("正在检查百家号登录状态，尚未开始上传", "account_check")
                try:
                    # The authenticated list avoids loading the dashboard app
                    # just to check the same account's session before upload.
                    response = await browser.contexts[0].request.get(
                        "https://baijiahao.baidu.com/pcui/article/lists?currentPage=1&pageSize=10&collection=", timeout=15000)
                    data = json.loads(await response.text()) if response.status == 200 else None
                    if (isinstance(data, dict) and type(data.get("errno")) is int and data["errno"] == 0
                            and isinstance(data.get("data"), dict) and isinstance(data["data"].get("list"), list)
                            and isinstance(data["data"].get("page"), dict) and data["data"]["page"].get("currentPage") == 1):
                        result = {"ready": True, "message": "百家号账号已登录，后台连接已就绪"}
                        return result
                except Exception:
                    pass  # Network/login challenges still use the visible page checks.
                await page.goto(HOMES["baijiahao"], wait_until="commit", timeout=15000)
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    try:
                        result = await asyncio.wait_for(login_state(page, "baijiahao"),
                                                        timeout=min(4, max(0.01, deadline - time.monotonic())))
                    except TimeoutError:
                        pass
                    except Exception as error:
                        if not re.search(r"Execution context was destroyed|Cannot find context with specified id", str(error)):
                            raise
                    if result["ready"] or result.get("issue") in ("login_required", "verification_required"):
                        break
                    await asyncio.sleep(0.5)
                if result["ready"]:
                    result["message"] = "百家号账号已登录，后台连接已就绪"
                elif result.get("issue") == "login_required":
                    result["message"] = "账号登录已失效，请在“百家号账号”中重新扫码"
                return result
            finally:
                try:
                    await asyncio.wait_for(page.close(), timeout=2)
                except Exception:
                    pass  # Cleanup cannot discard a confirmed login result.
                from account_browser import close_idle_account_browser
                # The upload immediately reuses this process; closing it here
                # races Chrome shutdown and forces another cold profile load.
                if not keep_browser or not result["ready"]:
                    try:
                        await asyncio.wait_for(close_idle_account_browser(browser), timeout=5)
                    except Exception:
                        pass
    except Exception as error:
        message = str(error)[:400] if isinstance(error, (ValueError, RuntimeError)) else "百家号账号后台连接或检查失败，请重新检查账号"
        return {"ready": False, "message": message, "issue": "check_failed"}


async def inspect_platform(playwright, config, platform):
    try:
        browser = await connect_platform_browser(playwright, config[platform], platform, config=config)
    except BrowserConnectionError as error:
        return {"ready": False, "issue": error.issue, "message": f"{error}；尚未开始上传"}
    context = browser.contexts[0]
    # Read an existing platform tab first. Checking the queue should not keep
    # opening pages or pay the cost of loading the whole publishing app again.
    host = urlparse(HOMES[platform]).hostname
    existing = [page for page in getattr(context, "pages", []) if urlparse(page.url).hostname == host]
    if existing:
        try:
            state = await asyncio.wait_for(login_state(existing[-1], platform), timeout=4)
            if state["ready"] or state.get("issue") in ("login_required", "verification_required"):
                return state
        except Exception:
            pass  # A closed, loading or unresponsive tab can use a fresh check.
    page = await context.new_page()
    try:
        await page.goto(EDITORS["tencent-video"] if platform == "tencent" else HOMES[platform],
                        wait_until="commit", timeout=15000)
        state = {"ready": False, "issue": "check_failed", "message": "平台页面仍在跳转，尚未开始上传，请重新检查"}
        for _ in range(12):
            try:
                state = await asyncio.wait_for(login_state(page, platform), timeout=4)
            except TimeoutError:
                await asyncio.sleep(0.5)
                continue
            except Exception as error:
                if not re.search(r"Execution context was destroyed|Cannot find context with specified id", str(error)):
                    raise
                await asyncio.sleep(0.5)
                continue
            if state["ready"] or "人工" in state["message"]:
                return state
            await asyncio.sleep(0.5)
        return state
    finally:
        try:
            await asyncio.wait_for(page.close(), timeout=2)
        except Exception:
            pass  # Cleanup must not discard a completed platform check.


async def runtime(config):
    _, _, async_playwright, _, _, _ = load_engine()
    version = subprocess.run(["git", "rev-parse", "HEAD"], cwd=config["root"], capture_output=True, text=True, check=False).stdout.strip()[:12]
    manager = async_playwright()
    playwright = await asyncio.wait_for(manager.start(), timeout=10)
    try:
        async def check(platform):
            label = "百家号" if platform == "baijiahao" else "视频号"
            try:
                return await asyncio.wait_for(inspect_platform(playwright, config, platform), timeout=PLATFORM_CHECK_TIMEOUT)
            except TimeoutError:
                return {"ready": False, "issue": "check_failed", "message": f"{label}连接或页面检查超时，登录状态未确认，尚未开始上传，请重试连接"}
            except Exception:
                return {"ready": False, "issue": "check_failed", "message": f"{label}页面检查失败，登录状态未确认，尚未开始上传，请重试连接"}
        states = dict(zip(HOMES, await asyncio.gather(*(check(platform) for platform in HOMES))))
    finally:
        try:
            await asyncio.wait_for(playwright.stop(), timeout=3)
        except Exception:
            pass  # Driver teardown must not erase the collected login results.
    return {"installed": True, "message": "复用现有 social-auto-upload（含本机安全上传扩展）",
            "version": version + "+local-stage", "platforms": states}


async def open_login(config, platform):
    if platform not in HOMES:
        raise ValueError("不支持的上传平台")
    _, _, async_playwright, _, _, _ = load_engine()
    async with async_playwright() as playwright:
        browser = await connect_platform_browser(playwright, config[platform], platform, config=config)
        page = await browser.contexts[0].new_page()
        await page.goto(HOMES[platform], wait_until="commit", timeout=15000)
        await page.bring_to_front()
    return {"opened": True, "message": "请在打开的浏览器内登录或完成验证，再重新检查"}


async def inspect_history(config):
    playwright = None
    version = None
    try:
        _, _, async_playwright, _, _, _ = load_engine()
        try:
            version = subprocess.run(["git", "rev-parse", "HEAD"], cwd=config["root"], capture_output=True,
                                     text=True, check=False, timeout=2).stdout.strip()[:12] + "+local-stage"
        except (OSError, subprocess.TimeoutExpired):
            pass
        playwright = await asyncio.wait_for(async_playwright().start(), timeout=8)
        async def check(platform):
            try:
                return await asyncio.wait_for(history_sessions.inspect_platform(
                    playwright, config, platform, connect_visible=partial(connect_platform_browser, config=config, cleanup_lock_held=True), login_state=login_state),
                    timeout=HISTORY_PLATFORM_TIMEOUT)
            except TimeoutError:
                return history_sessions.platform_state(platform, issue="connection_failed",
                    message=f"历史{history_sessions.LABELS[platform]}后台连接或检查超时，请重试检查；尚未开始上传")
            except Exception:
                return history_sessions.platform_state(platform, issue="check_failed",
                    message=f"历史{history_sessions.LABELS[platform]}后台检查暂未完成，请重试检查；尚不能判断登录失效，原登录已保留")
        states = dict(zip(HOMES, await asyncio.gather(*(check(platform) for platform in HOMES))))
        return {"installed": True, "version": version, "execution": "background", "platforms": states,
                "message": "复用 social-auto-upload 持久后台 Chrome；历史账号继承原专用 Chrome 登录"}
    except Exception:
        message = "历史后台运行环境未就绪，请检查 social-auto-upload 安装后重试"
        return {"installed": False, "version": version, "execution": "background", "message": message,
                "platforms": {platform: history_sessions.platform_state(platform, message=message, issue="check_failed") for platform in HOMES}}
    finally:
        if playwright is not None:
            try:
                await asyncio.wait_for(playwright.stop(), timeout=3)
            except Exception:
                pass


async def sync_history(config, platform):
    if platform not in HOMES:
        raise ValueError("不支持的历史上传平台")
    _, _, async_playwright, _, _, _ = load_engine()
    playwright = None
    try:
        playwright = await asyncio.wait_for(async_playwright().start(), timeout=8)
        return await asyncio.wait_for(history_sessions.sync_platform(
            playwright, config, platform, connect_visible=partial(connect_platform_browser, config=config, cleanup_lock_held=True), login_state=login_state),
            timeout=HISTORY_PLATFORM_TIMEOUT)
    except TimeoutError:
        raise RuntimeError("历史后台登录同步超时，旧登录未替换；请重试同步") from None
    except (history_sessions.HistorySessionError, ValueError):
        raise
    except Exception:
        raise RuntimeError("历史后台登录同步失败，旧登录未替换；请重新检查后台环境，或在原专用 Chrome 登录后重试同步") from None
    finally:
        if playwright is not None:
            try:
                await asyncio.wait_for(playwright.stop(), timeout=3)
            except Exception:
                pass


async def baijiahao_cover_dialogs(page, helpers):
    """Wait for the crop modal's asynchronous contents before classifying it."""
    deadline = time.monotonic() + 10
    while True:
        dialogs = await baijiahao_dialogs(page, helpers._READ_DIALOGS)
        if not dialogs or (len(dialogs) == 1 and re.search(r"[横竖]版封面预览", dialogs[0]["text"])):
            return dialogs
        if time.monotonic() >= deadline:
            descriptions = " / ".join(d.get("text", "")[:120] for d in dialogs)
            raise RuntimeError(f"封面窗口未加载完成或被其他弹窗遮挡：{descriptions}")
        await asyncio.sleep(0.2)


async def baijiahao_covers(page, payload, helpers, verified=None, checkpoint=None, *, timeout=120, confirm_only=False):
    result = {**(verified or {}), "layout": "videoV2"}
    steps = [("landscape", "landscapePath", "横版封面预览", 16 / 9), ("portrait", "portraitPath", "竖版封面预览", 3 / 4)]
    initial_dialogs = await baijiahao_cover_dialogs(page, helpers)
    if initial_dialogs:
        pending = [step for step in steps if step[2] in initial_dialogs[0]["text"]]
        if len(initial_dialogs) != 1 or len(pending) != 1:
            raise RuntimeError("出现非本任务封面弹窗，停止操作")
        steps = pending + [step for step in steps if step != pending[0]]
    for step_index, (kind, key, label, ratio) in enumerate(steps):
        filename = payload[key]
        digest = await asyncio.to_thread(helpers._file_digest, filename)
        previous = result.get(kind) or (verified or {}).get(kind, {})
        source_verified = previous.get("source_sha256_verified") == digest and previous.get("fingerprint") == digest
        dialogs = await baijiahao_cover_dialogs(page, helpers)
        slot = (await helpers._cover_slots(page))[kind]
        must_confirm = bool(dialogs) or not source_verified
        selected_now = False
        if not dialogs:
            if not slot["src"] or not source_verified:
                if confirm_only:
                    raise RuntimeError("原封面缺少上传证明，不能在确认裁剪时重新选择文件")
                control = page.locator(helpers._SLOTS).nth(slot["index"]).locator('input[type="file"]').nth(slot["image_inputs"][0])
                await control.set_input_files(filename)
                source_verified = True
                selected_now = must_confirm = True
        deadline = time.monotonic() + timeout
        clicks = 0
        last_click = 0
        waiting_for = "等待裁剪窗口打开"
        while time.monotonic() < deadline:
            dialogs = await baijiahao_cover_dialogs(page, helpers)
            # A confirmed crop can reveal an older crop while its own preview finishes applying.
            other_step = next((step for step in steps if len(dialogs) == 1 and step[2] != label
                               and step[2] in dialogs[0]["text"]), None)
            if not dialogs or (other_step and clicks > 0):
                current = (await helpers._cover_slots(page))[kind]["src"]
                waiting_for = "等待新封面预览加载" if clicks else "等待裁剪窗口打开"
                if (current and source_verified and (not must_confirm or clicks > 0)
                        and (not selected_now or current != slot["src"])):
                    result[kind] = {"status": "uploaded", "preview": current, "fingerprint": digest,
                                    "source_sha256_verified": digest, "verification": "source_and_preview",
                                    "confirmClicks": clicks + (previous.get("confirmClicks", 0) if not selected_now else 0)}
                    if checkpoint:
                        checkpoint(dict(result))
                    if other_step and other_step not in steps[step_index + 1:]:
                        if steps.count(other_step) >= 2:
                            raise RuntimeError("已确认的封面裁剪窗反复出现，保留原页和封面证明后停止")
                        steps.append(other_step)
                    break
                if other_step and clicks > 0:
                    await asyncio.sleep(0.5)
                    continue
            if dialogs:
                if len(dialogs) != 1 or label not in dialogs[0]["text"]:
                    raise RuntimeError("出现非本任务封面弹窗，停止操作")
                dialog = dialogs[0]
                waiting_for = "等待封面源图和裁剪预览加载"
                if dialog["source_count"] > 1 or dialog["preview_count"] > 1:
                    raise RuntimeError("封面来源或裁剪预览不唯一")
                if dialog["source"] and dialog["preview"]:
                    preview = dialog["preview"]
                    if abs(preview["width"] / preview["height"] / ratio - 1) > 0.02:
                        raise RuntimeError("封面裁剪比例不正确")
                    source_matches = await helpers._browser_digest(page, dialog["source"]) == digest
                    if confirm_only and not source_matches:
                        raise RuntimeError("当前裁剪源图与本任务封面不一致，不能确认")
                    if source_matches:
                        source_verified = True
                        # The source file is verified by SHA-256. The platform
                        # is allowed to crop/recompress the preview, so pixel
                        # equality is intentionally not a save prerequisite.
                        waiting_for = "等待裁剪确认生效、窗口关闭"
                        if time.monotonic() - last_click >= 2:
                            modal = page.locator('[role="dialog"]').nth(dialog["index"])
                            button = modal.get_by_role("button", name="确定", exact=True)
                            if await button.count() != 1 or not await button.is_visible():
                                raise RuntimeError("封面确认按钮不唯一或不可见")
                            loading = await button.evaluate("e=>e.disabled || /loading/.test(e.className) || e.getAttribute('aria-busy')==='true'")
                            if loading:
                                waiting_for = "平台仍在处理裁剪，确定按钮尚不可用"
                            else:
                                # Crop confirmation is editor-only and idempotent; never retry a draft save.
                                # The platform can reject early clicks with
                                # "裁剪处理中，请稍后再点击确定". A two-click cap
                                # left a ready dialog idle for the rest of 120s.
                                await button.click()
                                clicks += 1
                                last_click = time.monotonic()
                                progress(f"正在确认{label[:2]}封面（第 {clicks} 次），等待裁剪窗口关闭", "covers")
            await asyncio.sleep(0.5)
        else:
            raise TimeoutError(f"{label[:2]}封面确认超时：{waiting_for}（已点击确定 {clicks} 次）；请重新上传")
    return result


async def verify_baijiahao_page_after_covers(page, payload, helpers, metadata, covers, checkpoint=None):
    for attempt in range(3):
        try:
            await helpers.verify_page(page, metadata, covers)
            return covers
        except RuntimeError as error:
            if str(error) != "百家号封面弹窗尚未确认，未保存" or attempt == 2:
                raise
        # A crop may reappear while upload verification is waiting for videoV2 readiness.
        # Recover only the proven source on the bound page; never select another file here.
        dialogs = await baijiahao_cover_dialogs(page, helpers)
        if not dialogs:
            continue
        for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
            proof = covers.get(kind, {})
            digest = await asyncio.to_thread(helpers._file_digest, payload[key])
            if (proof.get("status") != "uploaded" or proof.get("fingerprint") != digest
                    or proof.get("source_sha256_verified") != digest):
                raise RuntimeError("原封面缺少完整源图上传证明，不能自动确认裁剪")
        await helpers._verify_metadata(page, metadata)
        progress("封面裁剪窗口延迟关闭，正在核对原图后继续确认", "covers")
        covers = await baijiahao_covers(page, payload, helpers, verified=covers,
                                       checkpoint=checkpoint, confirm_only=True)


async def require_empty_baijiahao_video(page, helpers):
    selected = await page.locator('input[type="file"]').evaluate_all("es=>es.some(e=>e.files.length)")
    media = await page.evaluate(helpers._READ_MEDIA)
    metadata = await page.evaluate(helpers._READ_METADATA)
    if selected or media.get("progressing") or media.get("video_v2_ready") or any(video.get("src") for video in media.get("videos", [])) or any(field.get("value", "").strip() for field in metadata):
        raise RuntimeError("原百家号编辑页已有视频或文案，未重新传入素材")


async def baijiahao_video_input(page, *, timeout=60000):
    """Open Baijiahao's upload area before resolving its lazy file input.

    Some editor versions mount the input only after activating the upload card.
    An existing primary area must never fall back to an auxiliary file picker.
    """
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    inputs = page.locator(BAIJIAHAO_VIDEO_INPUT_SELECTOR)
    primary = page.locator(BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR)
    areas = page.locator(BAIJIAHAO_UPLOAD_AREA_SELECTOR)
    selector = BAIJIAHAO_VIDEO_INPUT_SELECTOR
    started = time.monotonic()
    deadline = started + timeout / 1000
    clicked = False
    while time.monotonic() < deadline:
        area_count = await areas.count()
        if area_count > 1:
            raise RuntimeError("百家号视频上传入口不唯一，未上传")
        if area_count:
            inputs, selector = primary, BAIJIAHAO_PRIMARY_VIDEO_INPUT_SELECTOR
        count = await inputs.count()
        if count:
            if count != 1:
                raise RuntimeError("百家号视频上传控件不唯一，未上传")
            if not await inputs.first.is_enabled():
                raise RuntimeError("百家号视频上传控件不可用，未上传")
            return inputs.first, selector

        if not clicked and time.monotonic() - started >= 0.25:
            scope = areas.first if area_count else page
            # Current editor places an upload event overlay above its button.
            # Click that actual target; give mounted inputs priority each pass.
            controls = scope.locator('[data-testid="video-upload-btn"]')
            visible = [item for item in await controls.all() if await item.is_visible() and await item.is_enabled()]
            if not visible:
                buttons = scope.get_by_role("button", name=re.compile(r"^(?:上传视频|点击上传|上传)$"))
                visible = [button for button in await buttons.all() if await button.is_visible() and await button.is_enabled()]
            if not visible:
                visible = [item for item in await scope.get_by_text("上传视频", exact=True).all()
                           if await item.is_visible() and await item.is_enabled()]
            if len(visible) == 1:
                try:
                    await visible[0].click(timeout=min(500, max(1, (deadline - time.monotonic()) * 1000)))
                    clicked = True
                except PlaywrightTimeoutError:
                    # An input can mount while the obsolete button is waiting.
                    # Return to resolution instead of failing an available upload.
                    pass
            elif len(visible) > 1:
                raise RuntimeError("百家号视频上传入口不唯一，未上传")
        await asyncio.sleep(0.2)
    raise TimeoutError("百家号视频上传控件加载超时，尚未传入素材；请重新上传")


async def stage_baijiahao_video(page, payload, endpoint, engine, checkpoint=None, before_select=None):
    BaiJiaHaoVideo, _, _, helpers, _, _ = engine
    app = BaiJiaHaoVideo(title=payload["title"], desc=payload["description"], tags=payload.get("tags", []),
                        file_path=payload["videoPath"], thumbnail_path=payload["landscapePath"],
                        portrait_thumbnail_path=payload["portraitPath"], account_file="unused-live-context.json",
                        stage_only=True, cdp_url=endpoint, headless=False)
    await app.validate_upload_args()
    video_input, selector = await baijiahao_video_input(page)
    progress("正在使用 social-auto-upload 上传百家号视频", "media")
    if before_select:
        before_select()
    await app._select_video_file(page, video_input, selector=selector)
    await page.locator('div[class*="contentEditable"]').first.wait_for(state="visible", timeout=180000)
    metadata = await helpers.fill_metadata(page, payload["title"], payload["description"])
    details = {"metadata": metadata, "engine": "social-auto-upload/baijiahao-local-stage"}
    if checkpoint:
        checkpoint(details)
    # videoV2 readiness depends on covers, even when no automatic cover is generated.
    progress("正在上传并核对横竖封面", "covers")
    covers = await baijiahao_covers(page, payload, helpers, checkpoint=(lambda covers: checkpoint({**details, "covers": covers})) if checkpoint else None)
    progress("正在等待百家号完成上传和转码，并核对视频指纹", "media")
    media = await helpers.verify_upload(page, payload["videoPath"])
    details = {**details, "covers": covers, "media": media}
    if checkpoint:
        checkpoint(details)
    covers = await verify_baijiahao_page_after_covers(page, payload, helpers, metadata, covers,
        checkpoint=(lambda covers: checkpoint({**details, "covers": covers})) if checkpoint else None)
    settings = await ensure_baijiahao_fields(page, payload)
    return {**details, "covers": covers, **({"settings": settings} if settings else {})}


def tencent_platform_title(title):
    allowed = set('《》〈〉“”‘’\"\'：:+＋?？%％℃')
    return " ".join("".join(" " if char in ",，" else char for char in title
                            if char in ",，" or char in allowed or unicodedata.category(char)[0] not in "PS").split())


async def verify_tencent_metadata(page, title, description, expected_description=None):
    return await tencent_metadata(page, title, description, expected_description)


async def clear_failed_tencent_video(page):
    # Only remove the failed local upload, never an item from the draft list.
    failed = page.locator("div.media-status-content").filter(has=page.locator("div.status-msg.error:visible"))
    if await failed.count() != 1:
        raise RuntimeError("原编辑页上传失败提示已变化，未重传视频")
    await failed.locator("div.tag-inner").filter(has_text=re.compile(r"^删除$")).click()
    confirmation = failed.locator(".weui-desktop-popover:visible").filter(has_text="删除后需重新上传")
    await confirmation.wait_for(state="visible", timeout=5000)
    await (await one_button(confirmation, ("删除",))).click()
    await page.locator("div.status-msg.error:visible").wait_for(state="hidden", timeout=10000)


async def stage_tencent_video(page, payload, endpoint, engine, before_select=None,
                              reuse_upload=False, checkpoint=None, previous=None, *,
                              recovery_state=None, checkpoint_retry=None):
    from tencent_cover_upload import upload_tencent_covers
    _, TencentVideo, _, _, helpers, covers_helper = engine
    platform_title = tencent_platform_title(payload["title"])
    app = TencentVideo(title=platform_title, desc=payload["description"], short_title=platform_title,
                       file_path=payload["videoPath"], tags=[], publish_date=0, account_file="unused-live-context.json",
                       thumbnail_landscape_path=payload["landscapePath"], thumbnail_portrait_path=payload["portraitPath"],
                       stage_only=True, cdp_url=endpoint)
    helpers.validate_stage(app)
    await page.locator('div.input-editor[contenteditable]').first.wait_for(state="visible", timeout=60000)
    await page.locator('input[placeholder*="短标题"]').first.wait_for(state="visible", timeout=60000)
    before = (previous or {}).get("declarations", await helpers.declarations(page))
    if reuse_upload:
        progress("正在继续原视频号编辑页：核对已上传视频和文案，接着完成双封面", "media")
        selected = await helpers.verify_existing_video(page, payload["videoPath"])
        live = await helpers.snapshot(page) if recovery_state is not None else {}
        if live.get("errors"):
            if not can_resume_tencent_upload(payload, recovery_state) or recovery_state.get("saveAttemptedAt") is not None:
                raise RuntimeError("已尝试保存或缺少原上传检查点，不能重传视频")
            if live.get("progress") or len(live["errors"]) != 1 or not re.fullmatch(r"网络出错，请重新上传[。.!！]?", live["errors"][0].strip()):
                raise RuntimeError("未确认可重试的网络上传失败，保留原编辑页")
            if not checkpoint_retry:
                raise RuntimeError("缺少持久重试检查点，未重传视频")
            await verify_document(page, payload, recovery_state)
            # Preserve any user text. This failure occurred before metadata was
            # filled; a populated editor must use the ordinary resume path.
            if (await page.locator('input[placeholder*="短标题"]').input_value()
                    or (await page.locator('div.input-editor[contenteditable]').inner_text()).strip()):
                raise RuntimeError("上传失败后原页已有文案，未清除或覆盖，请核对原页")
            previous_retry = recovery_state.get("videoRetry") or {}
            attempts = previous_retry.get("attempts", 1 if previous_retry else 0) + 1
            checkpoint_retry({"attemptedAt": time.time(), "reason": live["errors"][0], "attempts": attempts})
            progress("网络上传明确失败，正在原编辑页重传同一视频（本次恢复 1/1）", "media")
            await clear_failed_tencent_video(page)
            selected = await app.upload_video_file(page, payload["videoPath"])
            media = await app.wait_for_upload_complete(page)
        else:
            media = await helpers.wait_for_video(page, timeout=30)
        if recovery_state is not None and not (previous or {}).get("metadata") and not (
                await page.locator('input[placeholder*="短标题"]').input_value()
                or (await page.locator('div.input-editor[contenteditable]').inner_text()).strip()):
            metadata = await app.prepare_video_for_publish(page)
        else:
            metadata = await verify_tencent_metadata(page, payload["title"], payload["description"],
                                                     (previous or {}).get("metadata", {}).get("description"))
    else:
        await helpers.require_empty_editor(page)
        progress("正在使用 social-auto-upload 上传视频号视频", "media")
        if before_select:
            before_select()
        selected = await app.upload_video_file(page, payload["videoPath"])
        media = await app.wait_for_upload_complete(page)
        progress("视频号视频已上传，正在填写文案和上传双封面", "metadata")
        metadata = await app.prepare_video_for_publish(page)
    details = {"video": {"selected": selected, "media": media}, "metadata": metadata,
               "declarations": before, "engine": "social-auto-upload/tencent-local-stage"}
    if previous and previous.get("covers"):
        details["covers"] = previous["covers"]
    if checkpoint:
        checkpoint(details)
    def checkpoint_covers(covers):
        details["covers"] = covers
        if checkpoint:
            checkpoint(details)
    covers = await upload_tencent_covers(page, payload, covers_helper, previous=details.get("covers"),
                                        checkpoint=checkpoint_covers)
    await verify_tencent_metadata(page, payload["title"], payload["description"], metadata["description"])
    await covers_helper.verify_covers(page, covers)
    if before != await helpers.declarations(page):
        raise RuntimeError("上传期间声明选项发生变化，已停止保存")
    return {**details, "covers": covers}


async def one_button(root, labels):
    buttons = root.get_by_role("button", name=re.compile("^(?:" + "|".join(re.escape(label) for label in labels) + ")$"))
    visible = [button for button in await buttons.all() if await button.is_visible()]
    if len(visible) != 1 or not await visible[0].is_enabled():
        raise RuntimeError("无法唯一确认可用按钮：" + "/".join(labels))
    return visible[0]


async def article_editor(page):
    await page.wait_for_function("() => Object.values(window.UE_V2?.instants || {}).filter(e=>e.isReady && e.body).length === 1", timeout=60000)
    iframe = await page.evaluate_handle("() => Object.values(window.UE_V2.instants).find(e=>e.isReady && e.body).iframe")
    element = iframe.as_element()
    if not element:
        raise RuntimeError("百家号正文编辑器 iframe 未就绪")
    for _ in range(50):
        frame = await element.content_frame()
        if frame:
            return frame
        await asyncio.sleep(0.1)
    raise RuntimeError("百家号正文编辑器尚未加载完成")


async def article_images(page, images, helpers, before_select=None, reuse_upload=False):
    if not images:
        raise ValueError("百家号图文缺少本地正文配图")
    if reuse_upload:
        # Compatibility for older CBA checkpoints; history retries always use
        # a fresh page. Finish an already-uploaded image dialog without another
        # file selection.
        modal = page.locator('[role="dialog"]:visible')
        if await modal.count():
            text = await modal.inner_text()
            if "本地图片" not in text or not re.search(str(len(images)) + r"\s*张上传成功", text):
                raise RuntimeError("原配图弹窗尚未完成上传，请重新上传")
            await (await one_button(modal, ("确认",))).click()
            await modal.wait_for(state="hidden", timeout=20000)
        return await verify_article_images(page, await article_editor(page), images, helpers)
    # Upload individually so the new DOM image has an explicit source binding.
    # Batch completion order and platform recompression are not reliable image
    # identifiers; this removes the old remote pixel matching gate entirely.
    result = {}
    frame = await article_editor(page)
    for index, image in enumerate(images):
        before = await frame.locator("img").evaluate_all("es=>es.map(e=>e.currentSrc||e.src)")
        await page.locator(".edui-for-insertimage").click()
        modal = page.locator('[role="dialog"]:visible')
        await modal.wait_for(state="visible", timeout=15000)
        if await modal.count() != 1 or "本地图片" not in await modal.inner_text():
            raise RuntimeError("图文配图弹窗不是本地图片，未继续")
        inputs = modal.locator('input[type="file"][accept*="image"]')
        if await inputs.count() != 1:
            raise RuntimeError("图文正文图片上传控件不唯一")
        if before_select and index == 0:
            before_select()
        await inputs.set_input_files(image["path"])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            text = await modal.inner_text()
            if re.search(r"上传失败|图片格式不支持|文件过大", text):
                raise RuntimeError("百家号正文配图上传失败，请重新上传")
            if not re.search(r"上传中|\d+%", text) and re.search(r"1\s*张上传成功", text):
                button = modal.get_by_role("button", name="确认", exact=True)
                if await button.count() == 1 and await button.is_enabled():
                    await button.click()
                    break
            await asyncio.sleep(0.4)
        else:
            raise TimeoutError("正文配图上传未完成，请重新上传")
        await modal.wait_for(state="hidden", timeout=20000)
        await frame.wait_for_function("n=>document.images.length===n && [...document.images].every(e=>e.complete&&e.naturalWidth)",
                                      arg=len(before)+1, timeout=30000)
        after = await frame.locator("img").evaluate_all("es=>es.map(e=>e.currentSrc||e.src)")
        new = list(after)
        for src in before:
            if src in new:
                new.remove(src)
        if len(new) != 1:
            raise RuntimeError("未能定位本次上传的正文配图，请重新上传")
        result[image["url"]] = canonical_article_image_url(new[0])
    return result


async def verify_article_images(page, frame, images, helpers):
    await frame.wait_for_function("n=>document.images.length===n && [...document.images].every(e=>e.complete&&e.naturalWidth)",
                                  arg=len(images), timeout=15000)
    urls = await frame.locator("img").evaluate_all("es=>es.map(e=>e.currentSrc||e.src)")
    if len(urls) != len(images):
        raise RuntimeError("正文配图数量不符，未保存")
    # New uploads are bound in selection order. For legacy drafts, full article
    # text + image count + the original saved snapshot identify the content.
    return {image["url"]: canonical_article_image_url(src) for image, src in zip(images, urls)}


async def article_snapshot(page):
    return await page.evaluate(r"""() => {
      const editor=Object.values(window.UE_V2.instants).find(e=>e.isReady&&e.body);
      const doc=new DOMParser().parseFromString(editor.getContent(),'text/html');
      for (const e of doc.querySelectorAll('.bjh-image-caption.ue_t')) {
        if (e.textContent.trim()==='请点击输入图片描述（最多18字）') e.remove();
      }
      return {text:doc.body.textContent.replace(/[\s\u200b-\u200f\ufeff]/g,''),images:[...doc.images].map(e=>{
        const url=new URL(e.src);
        if(url.protocol==='http:'&&url.hostname==='baijiahao.baidu.com'&&url.pathname==='/bjh/picproxy')url.protocol='https:';
        return url.href;
      })};
    }""")


async def prepare_article(page, payload, image_urls):
    return await page.evaluate(r"""({html, images}) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const e of doc.querySelectorAll('script,iframe,object,embed,link,style,form')) e.remove();
      for (const e of doc.body.querySelectorAll('*')) {
        for (const a of [...e.attributes]) if (/^on/i.test(a.name)) e.removeAttribute(a.name);
        if (e.tagName === 'IMG') {
          const src = images[e.getAttribute('src')];
          if (!src) throw new Error('Article contains an unbound image');
          e.setAttribute('src', src);
        }
      }
      return {html:doc.body.innerHTML,
        snapshot:{text:doc.body.textContent.replace(/[\s\u200b-\u200f\ufeff]/g,''),images:[...doc.images].map(e=>e.src)}};
    }""", {"html": payload["articleHtml"], "images": image_urls})


async def fill_article(page, payload, image_urls):
    title = page.locator('[data-testid="news-title-input"] [contenteditable="true"]')
    if await title.count() != 1:
        raise RuntimeError("百家号图文标题控件不唯一")
    prepared = await prepare_article(page, payload, image_urls)
    await title.click()
    await page.keyboard.insert_text(payload["title"])
    await page.evaluate("""html => {
      const editor=Object.values(window.UE_V2.instants).find(e=>e.isReady&&e.body);
      editor.setContent(html);editor.fireEvent('contentchange');
    }""", prepared["html"])
    actual = await article_snapshot(page)
    if actual != prepared["snapshot"] or (await title.inner_text()).strip() != payload["title"]:
        raise RuntimeError("百家号未完整保留图文标题、正文或配图，未保存")
    return prepared["snapshot"]


async def stage_article(page, payload, helpers, before_select=None, reuse_upload=False, checkpoint=None, previous=None, *, covers_only=False):
    from article_covers_v2 import article_covers
    title = page.locator('[data-testid="news-title-input"] [contenteditable="true"]')
    frame = await article_editor(page)
    if await title.count() != 1:
        raise RuntimeError("百家号图文标题控件不唯一")
    selected = await page.locator('input[type="file"]').evaluate_all("es=>es.some(e=>e.files.length)")
    image_count = await frame.locator("img").count()
    populated = (await title.inner_text()).strip() or (await article_snapshot(page))["text"]
    if await frame.locator("video,audio,iframe,object").count() or (not reuse_upload and (populated or selected or image_count)):
        raise RuntimeError("新图文编辑页已有内容，拒绝覆盖")
    if not populated and (covers_only or (previous and previous.get("article"))):
        raise RuntimeError("原图文标题和正文已被清空，不会回填旧内容或覆盖人工修改")
    if not reuse_upload:
        from article_cover_selection import prepared_article_cover_images
        prepared_article_cover_images(payload)
    if populated:
        progress("正在只读核对原图文标题、正文和配图，不会覆盖或重新上传", "metadata")
        image_urls = await verify_article_images(page, frame, payload["images"], helpers)
        content = (await prepare_article(page, payload, image_urls))["snapshot"]
        if (await title.inner_text()).strip() != payload["title"] or await article_snapshot(page) != content:
            raise RuntimeError("原图文内容已变化，不能恢复封面；不会覆盖人工修改")
    else:
        progress("正在上传百家号图文配图（本项目扩展）", "media")
        if image_count and reuse_upload:
            if await page.locator('[role="dialog"]:visible').count():
                raise RuntimeError("正文已有配图但弹窗仍打开，未继续")
            image_urls = await verify_article_images(page, frame, payload["images"], helpers)
        else:
            image_urls = await article_images(page, payload["images"], helpers, before_select, reuse_upload)
        content = await fill_article(page, payload, image_urls)
    if previous and previous.get("article") and previous["article"] != content:
        raise RuntimeError("原图文正文与检查点不一致，未继续")
    details = {"article": content, "engine": "huobao/baijiahao-article-extension"}
    if previous and previous.get("covers"):
        details["covers"] = previous["covers"]
    def checkpoint_cover(covers):
        details["covers"] = covers
        if checkpoint:
            checkpoint(details)
    if checkpoint:
        checkpoint(details)
    progress("正文与配图已核对，正在设置三图封面（项目封面与两张清晰正文配图）", "covers")
    details["covers"] = await article_covers(page, payload, helpers, image_urls, details.get("covers"), checkpoint_cover)
    return details


async def displayed_article_covers(page):
    return await page.locator('[class*="-cover"]').evaluate_all("""es=>{
      const visible = e => {
        if (e.closest('[role="dialog"],.ant-modal,.cheetah-modal')) return false;
        const r=e.getBoundingClientRect();
        return r.width>0 && r.height>0 && r.width/r.height>1.2 && r.width/r.height<1.5
          && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
      };
      const sources=[...new Set(es.flatMap(root=>[root,...root.querySelectorAll('*')]))]
        .filter(visible).flatMap(e=>[
          e.matches('img') && e.complete && e.naturalWidth ? e.currentSrc||e.src : null,
          /^url\\([\"']?(.*?)[\"']?\\)$/.exec(getComputedStyle(e).backgroundImage)?.[1]
        ].filter(Boolean));
      return [...new Set(sources)];
    }""")


async def article_cover_source(page, modal, inputs, expected_digest, helpers):
    selected = await inputs.evaluate("e=>({count:e.files.length,src:e.files.length===1?URL.createObjectURL(e.files[0]):null})")
    if selected["count"] > 1:
        raise RuntimeError("图文封面已选择多个文件，未继续")
    if selected["src"]:
        try:
            if await helpers._browser_digest(page, selected["src"]) != expected_digest:
                raise RuntimeError("图文封面选择的文件不是项目原封面，未继续")
            return True
        finally:
            await page.evaluate("src=>URL.revokeObjectURL(src)", selected["src"])
    # The live widget clears its file input after creating the local blob preview.
    sources = await modal.locator("img").evaluate_all("es=>[...new Set(es.map(e=>e.currentSrc||e.src).filter(src=>src.startsWith('blob:')))]")
    for source in sources:
        try:
            if await helpers._browser_digest(page, source) == expected_digest:
                return True
        except Exception:
            continue
    return False


async def article_cover(page, filename, helpers, previous=None, checkpoint=None):
    import base64
    expected_bytes = Path(filename).read_bytes()
    expected_digest = hashlib.sha256(expected_bytes).hexdigest()
    expected = helpers._normalized_pixels(base64.b64encode(expected_bytes).decode())
    modal = page.locator('[role="dialog"]:visible')
    if not await modal.count():
        if previous and previous.get("source_sha256_verified") == expected_digest:
            previews = await displayed_article_covers(page)
            if len(previews) == 1:
                difference = helpers._pixel_difference(expected, await helpers._cover_pixels(page, previews[0]))
                if difference["mae"] <= 3 and difference["rmse"] <= 5:
                    return {**previous, "preview": previews[0], "pixel_difference": difference}
        await page.get_by_text("选择封面", exact=True).click()
    await modal.wait_for(state="visible")
    if await modal.count() != 1 or not re.search(r"封面预览\s*[(（]4:3[)）]", await modal.inner_text()):
        raise RuntimeError("当前弹窗不是唯一的 4:3 图文封面编辑器，未继续")
    inputs = modal.locator('.cheetah-upload-select').filter(has_text=re.compile(r"^\s*本地上传\s*$")).locator('input[type="file"][accept*="image"]')
    if await inputs.count() != 1:
        raise RuntimeError("百家号图文“本地上传”控件不唯一，未选择文件")
    cover_state = dict(previous or {})
    source_verified = await article_cover_source(page, modal, inputs, expected_digest, helpers)
    if not source_verified and not cover_state.get("selectionStartedAt") and cover_state.get("source_sha256_verified") != expected_digest:
        cover_state = {"sha256": expected_digest, "selectionStartedAt": time.time()}
        if checkpoint:
            checkpoint(cover_state)
        await inputs.set_input_files(filename)
    deadline = time.monotonic() + 120
    confirmed_preview = None
    while time.monotonic() < deadline:
        if cover_state.get("source_sha256_verified") != expected_digest and (source_verified or await article_cover_source(page, modal, inputs, expected_digest, helpers)):
            cover_state.update({"sha256": expected_digest, "source_sha256_verified": expected_digest})
            if checkpoint:
                checkpoint(cover_state)
        if cover_state.get("source_sha256_verified") == expected_digest:
            previews = await modal.locator('[class*="-coverItem"] img').evaluate_all("es=>es.filter(e=>e.complete&&e.naturalWidth).map(e=>e.currentSrc||e.src)")
            for src in previews:
                try:
                    difference = helpers._pixel_difference(expected, await helpers._cover_pixels(page, src))
                except Exception:
                    continue
                if difference["mae"] <= 3 and difference["rmse"] <= 5:
                    confirmed_preview = src
                    break
        if confirmed_preview:
            await (await one_button(modal, ("确定", "确定 (1)", "确定（1）"))).click()
            break
        await asyncio.sleep(0.5)
    else:
        raise TimeoutError("图文封面来源或裁剪预览未核对通过，未保存")
    await modal.wait_for(state="hidden", timeout=20000)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        previews = await displayed_article_covers(page)
        if len(previews) == 1:
            try:
                difference = helpers._pixel_difference(expected, await helpers._cover_pixels(page, previews[0]))
            except Exception:
                difference = None
            if difference and difference["mae"] <= 3 and difference["rmse"] <= 5:
                result = {**cover_state, "preview": previews[0], "pixel_difference": difference}
                if checkpoint:
                    checkpoint(result)
                return result
        await asyncio.sleep(0.25)
    raise RuntimeError("图文封面确认后未能验证实际封面，未保存")


_ARTICLE_COVER_SLOTS = '[class*="-list"][class*="-three"]:visible > [class*="-item"]'
_ARTICLE_COVER_GALLERY = '[class*="-imglist"] [class*="-imgItem"]'


async def article_cover_slots(page):
    return await page.locator(_ARTICLE_COVER_SLOTS).evaluate_all("""es=>es.map(e=>{
      const images=[...e.querySelectorAll('[class*="-coverWrapper"] img')];
      if(images.length>1)throw new Error('Ambiguous cover slot');
      const image=images[0];return image ? image.currentSrc||image.src : null;
    })""")


async def article_cover_difference(page, item, src, helpers):
    import base64
    import cv2
    import numpy as np
    content = Path(item["path"]).read_bytes()
    if hashlib.sha256(content).hexdigest() != item["sha256"]:
        raise RuntimeError("三图封面原文件已变化，未继续")
    expected = [helpers._normalized_pixels(base64.b64encode(content).decode())]
    if item.get("url"):
        image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
        height, width = image.shape[:2]
        crop_width, crop_height = min(width, int(height * 4 / 3)), min(height, int(width * 3 / 4))
        left, top = (width - crop_width) // 2, (height - crop_height) // 2
        expected.append(cv2.resize(image[top:top + crop_height, left:left + crop_width], (64, 64), interpolation=cv2.INTER_AREA))
    actual = await helpers._cover_pixels(page, src)
    differences = [helpers._pixel_difference(candidate, actual) for candidate in expected]
    difference = min(differences, key=lambda value: value["mae"])
    if difference["mae"] > 4 or difference["rmse"] > 12:
        raise RuntimeError("三图封面的图片内容或顺序与项目素材不符，未保存")
    return difference


async def verify_article_covers(page, covers, helpers, bound=False):
    radio = page.locator('input[type="radio"][name="cover"][value="three"]')
    slots = await article_cover_slots(page)
    plan = covers.get("plan", [])
    if covers.get("mode") != "three" or len(plan) != 3 or await radio.count() != 1 or not await radio.is_checked() or len(slots) != 3 or not all(slots):
        raise RuntimeError("三图封面模式或三张图片不完整，未保存")
    if len(set(slots)) != 3:
        raise RuntimeError("三图封面存在重复图片，未保存")
    if bound and slots != [item["preview"] for item in covers.get("items", [])]:
        raise RuntimeError("三图封面在上传后已被替换，未保存")
    return [{**item, "preview": src, "pixel_difference": await article_cover_difference(page, item, src, helpers)}
            for item, src in zip(plan, slots)]


async def article_cover_gallery(modal):
    return await modal.locator(_ARTICLE_COVER_GALLERY).evaluate_all("""es=>es.map(e=>({
      src:e.querySelector('img')?.currentSrc||e.querySelector('img')?.src,
      selected:Number(e.querySelector('[class*="-checkbox"]')?.textContent.trim())||0
    }))""")


def canonical_article_image_url(value):
    url = urlparse(value)
    if url.scheme == "http" and url.hostname == "baijiahao.baidu.com" and url.path == "/bjh/picproxy":
        return url._replace(scheme="https").geturl()
    return value


async def article_covers(page, payload, helpers, image_urls, previous=None, checkpoint=None):
    from article_cover_selection import prepared_article_cover_images
    main = {"path": payload["landscapePath"], "sha256": hashlib.sha256(Path(payload["landscapePath"]).read_bytes()).hexdigest()}
    if previous and previous.get("mode") == "three":
        covers = dict(previous)
        plan = covers["plan"]
        if len(plan) != 3 or plan[0] != main or any(item.get("url") not in image_urls for item in plan[1:]):
            raise RuntimeError("三图封面检查点与当前文章不一致，未继续")
    else:
        covers = {"mode": "three", "plan": [main, *prepared_article_cover_images(payload)]}
        plan = covers["plan"]
    def record(**changes):
        covers.update(changes)
        if checkpoint:
            checkpoint(covers)
    record()
    radio = page.locator('input[type="radio"][name="cover"][value="three"]')
    if await radio.count() != 1:
        raise RuntimeError("百家号三图封面选项不唯一，未继续")
    if not await radio.is_checked():
        existing = await displayed_article_covers(page)
        if len(existing) > 1:
            raise RuntimeError("当前单图封面不唯一，未继续")
        if existing:
            await article_cover_difference(page, main, existing[0], helpers)
        await radio.check()
    slots = await article_cover_slots(page)
    if len(slots) != 3:
        raise RuntimeError("百家号三图封面控件未就绪，未继续")
    for item, src in zip(plan, slots):
        if src:
            await article_cover_difference(page, item, src, helpers)
    modal = page.locator('[role="dialog"]:visible')
    missing = [index for index, src in enumerate(slots) if not src]
    if not missing and not await modal.count():
        record(items=await verify_article_covers(page, covers, helpers))
        return covers
    if not await modal.count():
        await page.locator(_ARTICLE_COVER_SLOTS).nth(missing[0]).get_by_text("选择封面", exact=True).click()
    await modal.wait_for(state="visible")
    if await modal.count() != 1 or not re.search(r"封面预览\s*[(（]4:3[)）]", await modal.inner_text()):
        raise RuntimeError("当前弹窗不是唯一的三图 4:3 封面编辑器，未继续")
    inputs = modal.locator('.cheetah-upload-select').filter(has_text=re.compile(r"^\s*本地上传\s*$")).locator('input[type="file"][accept*="image"]')
    if await inputs.count() != 1:
        raise RuntimeError("百家号封面本地上传控件不唯一，未继续")
    gallery = await article_cover_gallery(modal)
    body_sources = {canonical_article_image_url(src) for src in image_urls.values() if src}
    for row in gallery:
        if not row["selected"]:
            continue
        # The platform can preselect any body image, not only our two choices.
        if row["src"] and canonical_article_image_url(row["src"]) in body_sources:
            continue
        try:
            await article_cover_difference(page, main, row["src"], helpers)
        except Exception as error:
            raise RuntimeError("封面弹窗选中了其他图片，未覆盖人工选择") from error
    main_selected = False
    for row in gallery:
        if row["src"] and row["src"].startswith("blob:") and await helpers._browser_digest(page, row["src"]) == main["sha256"]:
            main_selected = True
            break
    if 0 in missing and not main_selected:
        main_selected = await article_cover_source(page, modal, inputs, main["sha256"], helpers)
    if 0 in missing and not main_selected:
        if covers.get("selectionStartedAt"):
            raise RuntimeError("原封面已尝试选择但来源尚不能核对，未重复上传")
        record(selectionStartedAt=time.time())
        await inputs.set_input_files(main["path"])
        deadline = time.monotonic() + 30
        while not await article_cover_source(page, modal, inputs, main["sha256"], helpers):
            if time.monotonic() >= deadline:
                raise TimeoutError("项目主封面来源未就绪，未重复上传")
            await asyncio.sleep(0.25)
        record(source_sha256_verified=main["sha256"])
    gallery = await article_cover_gallery(modal)
    sources = {}
    for index, row in enumerate(gallery):
        if not row["src"]:
            continue
        for number, item in enumerate(plan):
            source = image_urls.get(item.get("url"))
            if source and canonical_article_image_url(row["src"]) == canonical_article_image_url(source):
                sources.setdefault(number, index)
            elif number == 0:
                try:
                    await article_cover_difference(page, item, row["src"], helpers)
                    sources.setdefault(number, index)
                except RuntimeError:
                    pass
    if any(number not in sources for number in missing):
        raise RuntimeError("正文图库尚未包含所需的三图封面图片，未保存")
    desired = [sources[number] for number in missing]
    selected = sorted([index for index, row in enumerate(gallery) if row["selected"]], key=lambda index: gallery[index]["selected"])
    if any(index not in sources.values() and canonical_article_image_url(gallery[index]["src"] or "") not in body_sources
           for index in selected):
        raise RuntimeError("封面弹窗选中了其他图片，未覆盖人工选择")
    if selected != desired:
        for index in selected:
            await modal.locator(_ARTICLE_COVER_GALLERY).nth(index).locator('[class*="-hotArea"]').click()
        for index in desired:
            await modal.locator(_ARTICLE_COVER_GALLERY).nth(index).locator('[class*="-hotArea"]').click()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        previews = await modal.locator('[class*="-coverItem"]').evaluate_all("es=>es.map(e=>{const i=e.querySelector('img');return i?.complete&&i.naturalWidth?i.currentSrc||i.src:null})")
        if len(previews) == 3 and all(previews):
            try:
                for item, src in zip(plan, previews):
                    await article_cover_difference(page, item, src, helpers)
                break
            except RuntimeError:
                pass
        await asyncio.sleep(0.25)
    else:
        raise TimeoutError("三张封面裁剪预览未齐备，未保存")
    selected = await article_cover_gallery(modal)
    if sorted((row["selected"], index) for index, row in enumerate(selected) if row["selected"]) != list(enumerate(desired, 1)):
        raise RuntimeError("三图封面选择数量或顺序发生变化，未保存")
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError
    crop_deadline = time.monotonic() + 60
    while True:
        record(confirmAttemptedAt=time.time())
        await (await one_button(modal, (f"确定 ({len(missing)})", f"确定（{len(missing)}）"))).click()
        try:
            await modal.wait_for(state="hidden", timeout=2000)
            break
        except PlaywrightTimeoutError:
            notices = "\n".join(await page.locator('[role="alert"],.cheetah-message-notice').all_inner_texts())
            if not re.search(r"封面裁剪处理中.*稍后再点击", notices):
                raise
            if time.monotonic() >= crop_deadline:
                raise TimeoutError("百家号封面裁剪仍在处理中，保留原弹窗待继续")
            progress("百家号正在裁剪封面，等待后继续确认三图", "covers")
            await asyncio.sleep(1)
            selected = await article_cover_gallery(modal)
            if sorted((row["selected"], index) for index, row in enumerate(selected) if row["selected"]) != list(enumerate(desired, 1)):
                raise RuntimeError("裁剪等待期间封面选择发生变化，未继续确认")
            previews = await modal.locator('[class*="-coverItem"] img').evaluate_all("es=>es.map(e=>e.currentSrc||e.src)")
            if len(previews) != 3:
                raise RuntimeError("裁剪等待期间三图预览不完整，未继续确认")
            for item, src in zip(plan, previews):
                await article_cover_difference(page, item, src, helpers)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        current = await article_cover_slots(page)
        if len(current) == 3 and all(current):
            try:
                items = await verify_article_covers(page, covers, helpers)
            except RuntimeError:
                items = None
            if items:
                record(items=items)
                return covers
        await asyncio.sleep(0.25)
    raise RuntimeError("三图封面确认后未能验证三张实际封面，未保存")


async def verify_document(page, payload, state):
    binding = await page.evaluate("() => ({name:window.name, token:window.__huobaoSauDocumentToken})")
    if not isinstance(binding, dict) or binding.get("name") != "huobao-sau-" + payload["jobId"] or not state.get("documentToken") or binding.get("token") != state["documentToken"]:
        raise RuntimeError("上传编辑页已重载或被替换，不能保存")


async def repair_optional_topic_description(page, payload, state, file, engine, expected_current):
    """Explicit repair for verified legacy topic cleanup damage or query residue."""
    metadata = state.get("details", {}).get("metadata", {})
    title = payload.get("title", "")
    if (payload.get("target") != "baijiahao-video" or not payload.get("tags") or len(title) < 2
            or state.get("phase") != "staged" or state.get("payloadDigest") != payload_digest(payload)
            or any(state.get(key) is not None for key in ("publishAttemptedAt", "saveAttemptedAt"))
            or state.get("result", {}).get("saved") or state.get("result", {}).get("submitted")
            or state.get("result", {}).get("published") or metadata.get("topicAttempt")
            or metadata.get("layout") != "videoV2" or optional_topic_base(payload) != title
            or metadata.get("title", {}).get("source_value") != title
            or metadata.get("description", {}).get("value") != payload.get("description")
            or not (expected_current == title[:-1] or unselected_topic_suffix(payload, expected_current))
            or local_files(payload) != state.get("files")):
        raise RuntimeError("只能显式修复原任务话题清理造成的末字缺失或已知查询残留；未修改文案")
    if await page_id(page) != state.get("targetId") or state.get("result", {}).get("targetId") != state.get("targetId"):
        raise RuntimeError("原任务编辑页身份不一致，未修复文案")
    await verify_document(page, payload, state)
    editor = page.locator('.videov2-title-wrap [contenteditable="true"]')
    if (await editor.count() != 1 or await editor.inner_text() != expected_current
            or await editor.locator('.video-title-tag[data-tag-type="topic"]').count()):
        raise RuntimeError("当前文案不符合已确认的话题清理结果，未修复")
    helpers = engine[3]
    media = await helpers.verify_upload(page, payload["videoPath"], timeout=5)
    previous = state.get("details", {}).get("media", {})
    if (media.get("verification") != "blob_sha256" or not previous.get("video_fingerprint")
            or media.get("video_fingerprint") != previous.get("video_fingerprint")
            or media.get("media_src") != previous.get("media_src")):
        raise RuntimeError("原任务视频指纹不一致，未修复文案")
    await verify_saved_baijiahao_covers(page, payload, helpers)
    restored = await helpers.fill_metadata(page, title, payload["description"])
    await helpers._verify_metadata(page, restored)
    state["details"]["metadata"] = restored
    state["topicDescriptionRepair"] = {"previousDescription": expected_current, "description": payload["description"],
                                       "targetId": state["targetId"], "repairedAt": time.time()}
    write_state(file, state)
    return {"repaired": True, "targetId": state["targetId"], "submitted": False}


async def verify_staged(page, payload, state, engine):
    from article_covers_v2 import verify_article_covers
    await verify_document(page, payload, state)
    _, _, _, bai_helpers, tencent_helpers, tencent_covers = engine
    details = state["details"]
    if payload["target"] == "baijiahao-video":
        current_media = await bai_helpers.verify_upload(page, payload["videoPath"], timeout=5)
        if current_media.get("media_src") != details["media"].get("media_src"):
            raise RuntimeError("百家号编辑页视频在上传后已被替换，未保存")
        await bai_helpers.verify_page(page, details["metadata"], details["covers"])
        await verify_baijiahao_fields(page, payload, details.get("settings"))
    elif payload["target"] == "tencent-video":
        await tencent_helpers.verify_existing_video(page, payload["videoPath"])
        await tencent_helpers.wait_for_video(page, timeout=5)
        await verify_tencent_metadata(page, payload["title"], payload["description"], details["metadata"]["description"])
        await tencent_covers.verify_covers(page, details["covers"])
    else:
        frame = await article_editor(page)
        actual = await article_snapshot(page)
        title = page.locator('[data-testid="news-title-input"] [contenteditable="true"]')
        if actual != details["article"] or (await title.inner_text()).strip() != payload["title"]:
            raise RuntimeError("图文内容在上传后已修改，未保存")
        if details.get("covers"):
            await verify_article_covers(page, details["covers"], bai_helpers, bound=True)
            return
        import base64
        if await displayed_article_covers(page) != [details["cover"]["preview"]]:
            raise RuntimeError("图文编辑页当前封面已被替换，未保存")
        expected = bai_helpers._normalized_pixels(base64.b64encode(Path(payload["landscapePath"]).read_bytes()).decode())
        actual_cover = await bai_helpers._cover_pixels(page, details["cover"]["preview"])
        difference = bai_helpers._pixel_difference(expected, actual_cover)
        if difference["mae"] > 3 or difference["rmse"] > 5:
            raise RuntimeError("图文封面在上传后已变化，未保存")


def draft_text(value):
    return re.sub(r"\s+", " ", re.sub(r"[\u200b-\u200f\ufeff]", "", unicodedata.normalize("NFC", str(value or "")))).strip()


def draft_text_candidate(actual, expected):
    actual, expected = draft_text(actual), draft_text(expected)
    if actual == expected:
        return True
    # List text may be explicitly truncated. This only locates a candidate;
    # the opened draft still has to match the full original metadata.
    prefix = re.sub(r"(?:…+|\.{3})$", "", actual).rstrip()
    return prefix != actual and len(prefix) >= 6 and expected.startswith(prefix)


def draft_timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value / 1000 if value > 10**12 else value
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y年%m月%d日 %H:%M:%S", "%Y年%m月%d日 %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()
        except ValueError:
            pass
    return None


def matching_saved_draft(rows, description, attempted_at, target="baijiahao-video", expected_id=None):
    if target not in ("baijiahao-video", "baijiahao-article"):
        raise RuntimeError("不支持核对该百家号内容形式")
    matches = {}
    for row in rows:
        if not row.get("draft") or bool(row.get("video")) != (target == "baijiahao-video"):
            continue
        try:
            url = urlparse(row["url"])
            draft_id = parse_qs(url.query).get("id", [""])[0]
            if url.scheme not in ("http", "https") or url.username or url.password or url.hostname != "baijiahao.baidu.com" or url.path not in ("/builder/preview/s", "/s") or not draft_id.isdigit():
                continue
            timestamp = draft_timestamp(row.get("timestamp", row.get("time")))
            matches_identity = draft_id == expected_id if expected_id is not None else (
                draft_text_candidate(row.get("title"), description) and timestamp is not None and abs(timestamp - attempted_at) <= 120)
            if matches_identity:
                matches[draft_id] = {"id": draft_id, "time": row.get("time", "")}
        except (KeyError, TypeError, ValueError):
            continue
    if len(matches) != 1:
        kind = "视频" if target == "baijiahao-video" else "图文"
        raise RuntimeError("未找到唯一匹配保存时间的百家号" + kind + "草稿；保持待核对，不会重新保存")
    return next(iter(matches.values()))


def matching_tencent_draft(rows, description, attempted_at, expected_id=None):
    matches = []
    seen_ids = set()
    for index, row in enumerate(rows):
        try:
            timestamp = draft_timestamp(row.get("timestamp", row.get("time")))
            identifier = row.get("id")
            identity_matches = identifier == expected_id if expected_id is not None else (
                draft_text_candidate(row.get("title"), description) and timestamp is not None and abs(timestamp - attempted_at) <= 120)
            if identity_matches and (not identifier or identifier not in seen_ids):
                matches.append({"index": index, "time": row.get("time", ""), **({"id": identifier} if identifier else {})})
                if identifier:
                    seen_ids.add(identifier)
        except (KeyError, TypeError, ValueError):
            continue
    if len(matches) != 1:
        raise RuntimeError("未找到唯一匹配保存时间的视频号草稿；保持待核对，不会重新保存")
    return matches[0]


async def tencent_save_flags(page):
    return await page.locator('div.input-editor[contenteditable]').evaluate("""e=>{
      for(let n=e;n;n=n.parentElement||n.getRootNode()?.host){
        const v=n.__vue__;
        if(v?.$options.methods?.handleCache)return {draftObjectId:v.draftStore?.objectId,
          needCache:v.needCache,isCaching:v.isCaching,isPosting:v.isPosting,
          handleLeaveDialogShow:v.handleLeaveDialogShow};
      }return null;
    }""")


async def remember_tencent_draft_id(page, payload, state, file):
    """Persist the platform ID from this bound editor, never from a title guess."""
    if state.get("expectedDraftId"):
        return state["expectedDraftId"]
    try:
        await verify_document(page, payload, state)
        flags = await asyncio.wait_for(tencent_save_flags(page), timeout=3)
    except Exception:
        return None  # Closed/changed editors can still be found in the draft box.
    identifier = flags.get("draftObjectId") if isinstance(flags, dict) else None
    if (not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 512
            or flags.get("needCache") is not False or flags.get("isCaching") is not False
            or flags.get("isPosting") is not False):
        return None
    state["expectedDraftId"] = identifier
    state["draftIdentitySource"] = "bound_editor_save_state"
    write_state(file, state)
    return identifier


async def restore_tencent_draft_id(browser, payload, state, file):
    if state.get("expectedDraftId") or not state.get("targetId") or not state.get("documentToken"):
        return state.get("expectedDraftId")
    for context in browser.contexts:
        for page in context.pages:
            try:
                if await page_id(page) == state["targetId"]:
                    return await remember_tencent_draft_id(page, payload, state, file)
            except Exception:
                continue  # An unrelated tab closing must not abort reconciliation.
    return None


async def repair_tencent_rejected_title(browser, payload, state, file, engine):
    """Only the worker's explicitly enabled repair may reach this write path."""
    pages = [page for context in browser.contexts for page in context.pages
             if await page_id(page) == state.get("targetId")]
    if len(pages) != 1:
        return None
    page = pages[0]
    await verify_document(page, payload, state)
    errors = page.locator(".post-short-title-wrap .error-title:visible").filter(has_text="标题包含特殊字符")
    source_title = payload["title"]
    title = page.locator('input[placeholder*="短标题"]')
    current_title = await title.input_value()
    platform_title = tencent_platform_title(source_title)
    rejections = state.get("saveRejections") or []
    previous = rejections[-1] if rejections else {}
    same_rejection = bool(previous and all(previous.get(key) == value for key, value in {
        "saveAttemptedAt": state["saveAttemptedAt"], "targetId": state["targetId"],
        "sourceTitle": source_title, "platformTitle": platform_title}.items()))
    fresh_rejection = await errors.count() == 1 and current_title == source_title
    resumed_repair = same_rejection and current_title == platform_title
    if not fresh_rejection and not resumed_repair:
        return None
    flags = await tencent_save_flags(page)
    expected = {"needCache": True, "isCaching": False,
                "isPosting": False, "handleLeaveDialogShow": False}
    if (not isinstance(flags, dict) or flags.get("draftObjectId", "unknown") not in (None, "")
            or any(flags.get(key) != value for key, value in expected.items())):
        return None
    if await page.locator('.weui-desktop-dialog:visible,.ant-modal:visible,[role="dialog"]:visible').count():
        return None
    if source_title == platform_title:
        return None
    if not 6 <= len(platform_title) <= 16:
        raise RuntimeError("清理符号后视频号短标题不符合平台 6–16 字限制，请修改项目短标题")
    if local_files(payload) != state["files"]:
        raise RuntimeError("原素材已变化，不能恢复原页保存")
    description = state["details"]["metadata"]["description"]
    await verify_tencent_metadata(page, source_title, payload["description"], description)
    if not same_rejection:
        rejection = {key: state[key] for key in ("saveAttemptedAt", "saveClickedAt", "saveResponse", "saveNotice", "error") if key in state}
        rejection.update({"reason": await errors.inner_text(), "rejectedAt": time.time(),
                          "sourceTitle": source_title, "platformTitle": platform_title,
                          "targetId": state["targetId"], "draftCheck": state.get("draftCheck")})
        state.setdefault("saveRejections", []).append(rejection)
        write_state(file, state)  # Preserve the rejected attempt before touching its title.
    if current_title != platform_title:
        await title.fill(platform_title)
        await title.press("Tab")
    await errors.wait_for(state="hidden", timeout=5000)
    await verify_document(page, payload, state)
    await verify_tencent_metadata(page, source_title, payload["description"], description)
    if await tencent_save_flags(page) != flags:
        raise RuntimeError("修复短标题期间保存状态发生变化，保留原保存记录")
    state["details"]["metadata"].update({"short_title": platform_title, "source_short_title": source_title})
    for key in ("saveAttemptedAt", "saveClickedAt", "saveResponse", "saveNotice", "error"):
        state.pop(key, None)
    state["phase"] = "staged"
    checkpoint_progress(file, state, "save", "平台明确拒绝短标题符号，已修正原页并保留拒绝记录，继续保存原草稿")
    return await save_draft(page, payload, state, file, engine)


async def open_tencent_draft_list(page):
    # A cold deep link currently redirects to home before the micro-app routes
    # register. Enter through the authenticated shell's real navigation instead.
    await page.goto(HOMES["tencent"], wait_until="domcontentloaded", timeout=60000)
    rows = page.locator(".post-draft-item")
    if await rows.count():
        return rows
    # Chrome's headless default is 800x600; Channels' folded popup then sits
    # beneath another micro-app's HTML layer and cannot receive pointer events.
    # Only resize this disposable readback page, never the original editor.
    await page.set_viewport_size({"width": 1440, "height": 1000})
    menu = page.locator("li.finder-ui-desktop-menu__item").filter(has=page.get_by_text("草稿箱", exact=True))
    try:
        await menu.first.wait_for(state="visible", timeout=15000)
        await menu.first.hover()
        await page.get_by_text("草稿箱", exact=True).filter(visible=True).first.click(timeout=15000)
    except Exception as error:
        status = await login_state(page, "tencent")
        if status.get("issue") in ("login_required", "verification_required"):
            raise history_sessions.HistorySessionError(status["message"], status["issue"]) from error
        text = "\n".join(await page.locator("body").all_inner_texts())
        if re.search(r"暂无草稿|没有草稿|草稿箱\s*[（(]0[）)]", text):
            return rows
        raise RuntimeError("视频号草稿箱未加载完成，请重试核对原任务；已尝试保存，不会重新上传或重复保存") from error
    return rows


async def reconcile_tencent_draft(browser, payload, state, file, engine, *, repair_rejected_save=False):
    if state.get("phase") != "save_requested" or not state.get("saveAttemptedAt") or not state.get("result"):
        raise RuntimeError("只能只读核对已尝试保存的视频号草稿")
    await restore_tencent_draft_id(browser, payload, state, file)
    page = await browser.contexts[0].new_page()
    try:
        checkpoint_progress(file, state, "reconcile", "正在核对视频号草稿箱；仅在平台明确拒绝时恢复原页保存" if repair_rejected_save
                            else "正在只读核对视频号草稿箱，不会重新上传或保存")
        description = state.get("details", {}).get("metadata", {}).get("description", payload["description"])
        try:
            candidate, row, diagnostic = await locate_tencent_draft(
                page, open_list=open_tencent_draft_list, match=matching_tencent_draft,
                description=description, attempted_at=state["saveAttemptedAt"],
                expected_id=state.get("expectedDraftId"))
        except RuntimeError as error:
            diagnostic = getattr(error, "diagnostic", {"outcome": "incomplete"})
            state["draftCheck"] = {**diagnostic, "checkedAt": time.time()}
            state["error"] = str(error)
            write_state(file, state)
            if (repair_rejected_save and diagnostic.get("outcome") == "not_found"
                    and diagnostic.get("complete") and not state.get("expectedDraftId")
                    and diagnostic.get("matchingDescriptionCount") == 0):
                repaired = await repair_tencent_rejected_title(browser, payload, state, file, engine)
                if repaired is not None:
                    return repaired
            raise
        state["draftCheck"] = {**diagnostic, "checkedAt": time.time()}
        if candidate.get("id"):
            state["expectedDraftId"] = candidate["id"]
            state.setdefault("draftIdentitySource", "unique_draft_record")
        write_state(file, state)
        await page.screenshot(path=str(file.parent / "saved-list.png"), full_page=True)
        await row.hover()
        edit = row.locator(".opr-item").filter(has_text=re.compile(r"^\s*编辑\s*$"))
        if await edit.count() != 1:
            raise RuntimeError("视频号草稿编辑入口不唯一，未继续核对")
        await edit.click()
        await page.locator('input[placeholder*="短标题"]').wait_for(state="visible", timeout=30000)
        await verify_tencent_metadata(page, payload["title"], payload["description"], description)
        flags = await tencent_save_flags(page) if candidate.get("id") else None
        if (isinstance(flags, dict) and flags.get("draftObjectId") and candidate.get("id")
                and flags["draftObjectId"] != candidate["id"]):
            raise RuntimeError("打开的视频号草稿 ID 与列表记录不同，请重试核对原任务")
        evidence = str(file.parent / "saved.png")
        await page.screenshot(path=evidence, full_page=True)
        state["phase"] = "saved"
        state["saveEvidence"] = {"verification": "platform_draft_record", "savedAt": candidate["time"],
                                 "title": payload["title"], "description": description,
                                 **({"draftId": candidate["id"]} if candidate.get("id") else {})}
        state.pop("error", None)
        state["result"] = {**state["result"], "saved": True,
                           "draftUrl": "https://channels.weixin.qq.com/platform/post/draftListManager", "evidencePath": evidence}
        checkpoint_progress(file, state, "complete", "已核实视频号草稿保存完成")
        return state["result"]
    except Exception as error:
        state["error"] = str(error)
        try:
            evidence = str(file.parent / "reconcile-incomplete.png")
            await page.screenshot(path=evidence, full_page=True)
            state["reconcileEvidence"] = {"checkedAt": time.time(), "evidencePath": evidence,
                                          "pagePath": urlparse(page.url).path}
        except Exception:
            pass
        write_state(file, state)
        raise
    finally:
        await close_disposable_verification_page(page)
        await cleanup_saved_upload_tab(browser, payload, state, file)


async def search_baijiahao_items(page, title):
    await page.goto("https://baijiahao.baidu.com/builder/rc/content", wait_until="domcontentloaded", timeout=60000)
    search = page.get_by_placeholder(re.compile(r"^输入标题关键[字词]$"))
    await search.wait_for(state="visible", timeout=30000)
    await search.fill(title)
    await search.press("Enter")
    await page.wait_for_function("title=>[...document.querySelectorAll('.client_pages_content_v2_components_articleItem .title a')].some(e=>e.textContent.trim()===title)",
                                 arg=title, timeout=30000)
    return await page.locator(".client_pages_content_v2_components_articleItem").evaluate_all("""es=>es.map(e=>({
      title:e.querySelector('.title a')?.textContent.trim(),url:e.querySelector('.title a')?.href,
      time:e.querySelector('.time')?.textContent.trim(),video:!!e.querySelector('.icon.video'),
      draft:[...e.querySelectorAll('[class*="articleTags"] *')].some(e=>e.textContent.trim()==='草稿')
    }))""")


_READ_SAVED_VIDEO = """() => {
  const visible = e => {const r=e.getBoundingClientRect();return !!(r.width&&r.height)};
  const fields=[...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
    .filter(e=>visible(e)&&!e.closest('[role="dialog"],.ant-modal-content,.cheetah-modal-content'))
    .map(e=>{
      const hint=[e.getAttribute('placeholder'),e.getAttribute('data-placeholder'),e.getAttribute('aria-label')].join(' ');
      const unified=!!e.closest('.videov2-title-wrap');
      if(!unified&&!/标题|简介|描述/.test(hint))return null;
      return {kind:unified?'description':/标题/.test(hint)?'title':'description',
        value:(e.isContentEditable?e.innerText:e.value).trim()};
    }).filter(Boolean);
  const videos=[...document.querySelectorAll('video')].filter(e=>
    !e.closest('[role="dialog"],.ant-modal-content,.cheetah-modal-content')&&
    (visible(e)||e.closest('[class$="-phonebg"]'))).map(e=>({
      src:e.currentSrc||e.src,ready:e.readyState,duration:Number.isFinite(e.duration)?e.duration:0}));
  return {fields,videos};
}"""


def local_video_duration(file):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", file],
                            capture_output=True, check=True, text=True, timeout=15)
    duration = float(json.loads(result.stdout)["format"]["duration"])
    if not 0 < duration < 24 * 60 * 60:
        raise RuntimeError("原视频时长无效，未确认草稿")
    return duration


async def verify_saved_video(page, payload, state, helpers, *, timeout=30, alternate_description=None):
    """Read the saved editor, retaining account/time and original-media proof.

    Saved drafts can use a description editor without the upload page's CSS
    wrapper. Wait for matching semantic metadata and the saved video instead
    of requiring that wrapper. This path never edits, saves, or publishes.
    """
    if local_files(payload) != state.get("files"):
        raise RuntimeError("原上传素材已变化，不能自动核对视频草稿")
    expected_description = video_description(payload, state)
    expected_descriptions = {draft_text(expected_description)}
    if alternate_description is not None:
        expected_descriptions.add(draft_text(alternate_description))
    video_file = str(Path(payload["videoPath"]).resolve(strict=True))
    video_digest = state["files"].get(video_file)
    staged_media = state.get("details", {}).get("media", {})
    if (staged_media.get("status") != "uploaded" or not video_digest
            or staged_media.get("video_fingerprint") != video_digest):
        raise RuntimeError("缺少原视频上传指纹，不能仅凭标题确认草稿")
    duration = await asyncio.to_thread(local_video_duration, video_file)
    deadline = time.monotonic() + timeout
    reload_at = time.monotonic() + min(10, timeout / 2)
    reloaded = False
    metadata = state["details"]["metadata"]
    last_reason = "已保存视频的文案或预览尚未就绪"
    while True:
        snapshot = await page.evaluate(_READ_SAVED_VIDEO)
        if not snapshot["fields"] and not snapshot["videos"]:
            # The saved editor occasionally boots into an empty app shell.
            # One read-only reload of this same draft is safe; never reupload
            # or click save again, and do not reload actual content mismatches.
            if not reloaded and time.monotonic() >= reload_at:
                reloaded = True
                await page.reload(wait_until="domcontentloaded", timeout=15000)
                continue
        try:
            await helpers._verify_metadata(page, metadata)
            metadata_matches = True
        except (RuntimeError, ValueError):
            fields = snapshot["fields"]
            descriptions = [field for field in fields if field["kind"] == "description"]
            titles = [field for field in fields if field["kind"] == "title"]
            metadata_matches = (len(descriptions) == 1 and len(titles) <= 1
                                and len(fields) == len(descriptions) + len(titles)
                                and draft_text(descriptions[0]["value"]) in expected_descriptions
                                and (not titles or titles[0]["value"] == payload["title"]))
        videos = snapshot["videos"]
        if metadata_matches and len(videos) == 1:
            video = videos[0]
            if video.get("src") and video.get("ready", 0) >= 1 and video.get("duration", 0) > 0:
                if abs(video["duration"] - duration) > 1:
                    raise RuntimeError("已保存草稿的视频时长与原视频不一致，保持待核对")
                return {"verification": "platform_draft_record_metadata_video", "title": expected_description,
                        "contentType": "video", "accountName": payload.get("accountName"),
                        "videoSha256": video_digest, "videoDuration": video["duration"],
                        "localVideoDuration": duration, "stagedVideoVerification": staged_media.get("verification"),
                        "savedMediaUrlSha256": hashlib.sha256(video["src"].encode()).hexdigest()}
        if not snapshot["fields"] and not snapshot["videos"]:
            last_reason = "已保存视频的编辑页未加载完成"
        elif not metadata_matches:
            last_reason = "已保存视频文案尚未与原任务匹配"
        elif len(videos) != 1:
            last_reason = "已保存草稿没有唯一的视频预览，不能仅凭标题确认"
        if time.monotonic() >= deadline:
            raise RuntimeError(last_reason + "，未能确认保存结果")
        await asyncio.sleep(min(0.5, max(0, deadline - time.monotonic())))


async def verify_baijiahao_video_record(payload, state, candidate):
    """Confirm a persisted video draft without loading the editor a second time.

    The live draft-list response supplies the saved record. Local staging and
    the recorded save click bind that record to this attempt. Older responses
    lacking video fields use the existing read-only editor fallback.
    """
    record = candidate.get("record")
    required = {"article_id", "status", "type", "title", "created_at", "rmb_duration", "file_name"}
    if not isinstance(record, dict) or not required.issubset(record) or not record.get("file_name"):
        return None
    identifier = candidate.get("id")
    if (not isinstance(identifier, str) or not identifier.isdigit()
            or str(record["article_id"]) != identifier
            or record["status"] != "draft" or record["type"] != "video"):
        raise RuntimeError("平台记录不是本次视频草稿，未确认保存")
    if not state.get("saveClickedAt") or not state.get("saveAttemptedAt"):
        raise RuntimeError("缺少本次点击存草稿的记录，未确认保存")
    if state.get("expectedDraftId") not in (None, identifier):
        raise RuntimeError("平台草稿 ID 与本次任务不一致，未确认保存")
    created = draft_timestamp(record["created_at"])
    if created is None or not int(state["saveAttemptedAt"]) <= created <= state["saveAttemptedAt"] + 120:
        raise RuntimeError("平台草稿不是本次保存创建的记录，未确认保存")
    expected_description = video_description(payload, state)
    if draft_text(record["title"]) != draft_text(expected_description):
        raise RuntimeError("平台草稿完整标题与本次文案不一致，未确认保存")
    if local_files(payload) != state.get("files"):
        raise RuntimeError("原上传素材已变化，未确认保存")
    video_path = str(Path(payload["videoPath"]).resolve(strict=True))
    digest = state["files"].get(video_path)
    staged = state.get("details", {})
    media = staged.get("media", {})
    if (not digest or media.get("status") != "uploaded" or media.get("video_fingerprint") != digest
            or draft_text(staged.get("metadata", {}).get("description", {}).get("value")) != draft_text(expected_description)):
        raise RuntimeError("缺少本次视频和文案的上传凭证，未确认保存")
    duration = await asyncio.to_thread(local_video_duration, video_path)
    try:
        remote_duration = float(record["rmb_duration"])
    except (TypeError, ValueError):
        return None
    if not 0 < remote_duration < 86400:
        return None
    if abs(remote_duration - duration) > 1:
        raise RuntimeError("平台草稿的视频时长与本次成片不一致，未确认保存")
    return {"verification": "platform_video_draft_record", "contentType": "video",
            "title": record["title"], "accountName": payload.get("accountName"),
            "videoSha256": digest, "videoDuration": remote_duration, "localVideoDuration": duration,
            "stagedVideoVerification": media.get("verification"), "platformRecord": record}


def publication_status(candidate):
    labels = candidate.get("statusLabels", [])
    record = candidate.get("record", {})
    if candidate.get("draft") or record.get("status") == "draft":
        raise RuntimeError("平台记录仍为草稿，不能作为发表回执")
    if record.get("status") == "publish" and "已发布" in labels:
        return "published"
    if (isinstance(record.get("status"), str) and record["status"]
            and record["status"] not in ("draft", "publish", "reject", "rejected", "withdraw", "deleted")
            and any(label in ("待发布", "审核中", "发布中", "待审核") for label in labels)):
        return "submitted"
    raise RuntimeError("平台作品尚无明确的提交审核或已发布状态，保持待核对")


def has_publication_identity(payload, result):
    if (publication_mode(payload) != "publish" or not isinstance(result, dict)
            or result.get("submitted") is not True or result.get("saved") is not False
            or result.get("publicationStatus") not in ("submitted", "published")
            or result.get("published") is not (result["publicationStatus"] == "published")
            or not isinstance(result.get("articleId"), str) or not result["articleId"].isdigit()):
        return False
    try:
        url = urlparse(result.get("publishedUrl", ""))
        return (url.scheme == "https" and url.hostname == "baijiahao.baidu.com" and not url.username
                and not url.password and url.port in (None, 443) and not url.fragment
                and url.path in ("/s", "/builder/preview/s")
                and parse_qs(url.query).get("id") == [result["articleId"]])
    except (TypeError, ValueError):
        return False


async def verify_public_baijiahao_preview(page, article_id, payload):
    """Confirm a previously saved article is already public, without account writes.

    A saved draft can be published from a different browser account than the
    one currently attached to the local session. The public preview is the
    only account-independent proof available in that case, so require the
    canonical public redirect plus the complete title. Optional topic text is
    an observation only, never proof of a bound platform topic.
    """
    if not isinstance(article_id, str) or not article_id.isdigit():
        raise RuntimeError("原草稿缺少有效百家号作品 ID")
    preview_url = f"https://baijiahao.baidu.com/builder/preview/s?id={article_id}"
    await page.goto(preview_url, wait_until="domcontentloaded", timeout=30000)
    for _ in range(10):
        current = urlparse(page.url)
        if current.hostname == "mbd.baidu.com" and current.path.startswith("/newspage/"):
            break
        await page.wait_for_timeout(500)
    current = urlparse(page.url)
    if current.scheme != "https" or current.hostname != "mbd.baidu.com" or not current.path.startswith("/newspage/"):
        raise RuntimeError("百家号公开预览尚未跳转到公开作品页")
    body = ""
    for _ in range(20):
        try:
            body = await page.locator("body").inner_text(timeout=1000)
        except Exception:
            body = ""
        if body.strip():
            break
        await page.wait_for_timeout(250)
    if not body.strip():
        raise RuntimeError("百家号公开作品页正文尚未加载")
    compact = re.sub(r"\s+", "", str(body or ""))
    expected_title = re.sub(r"\s+", "", draft_text(payload.get("title")))
    if not expected_title or expected_title not in compact:
        raise RuntimeError("百家号公开作品标题与原任务不一致")
    visible_topics = list(dict.fromkeys(re.findall(r"#[^#\s]{1,100}#", body)))
    return {"verification": "baijiahao_public_preview", "previewUrl": preview_url,
            "resolvedUrl": page.url, "articleId": article_id, "title": payload["title"],
            "visibleTopicTexts": visible_topics}


def matching_publication(rows, title, attempted_at, target="baijiahao-video", expected_id=None):
    matches = []
    for row in rows:
        identifier = row.get("id")
        if not isinstance(identifier, str) or not identifier.isdigit() or row.get("draft") or not row.get("video"):
            continue
        if expected_id is not None and identifier != expected_id:
            continue
        if draft_text(row.get("title")) != draft_text(title):
            continue
        record = row.get("record")
        if isinstance(record, dict) and (str(record.get("article_id")) != identifier or record.get("type") != "video"):
            continue
        # After moderation the visible card time becomes the public release
        # time. The server's creation time still identifies this submission.
        timestamp = draft_timestamp(record.get("created_at")) if isinstance(record, dict) and "created_at" in record else draft_timestamp(row.get("time"))
        if expected_id is None and (timestamp is None or not int(attempted_at) <= timestamp <= attempted_at + 120):
            continue
        if not any(label in ("已发布", "待发布", "审核中", "发布中", "待审核") for label in row.get("statusLabels", [])):
            continue
        matches.append(row)
    if len(matches) != 1:
        raise RuntimeError("没有唯一匹配的百家号发表记录，保持待核对，不会重复发表")
    return dict(matches[0])


def publication_observation(state):
    """Classify the single publish click from persisted browser evidence.

    This describes the transport/client observation only. It never proves that
    the platform created a work; that still requires the strict list record and
    media verification in ``verify_publication_record``. In particular, an
    outbound request without a response remains ``unknown`` and cannot unlock
    another click.
    """
    if not isinstance(state, dict):
        return {"classification": "unknown", "requestSent": None, "responseCount": 0,
                "noticeCount": 0}
    responses = state.get("publicationResponses")
    responses = responses if isinstance(responses, list) else []
    notices = state.get("publicationNotices")
    notices = notices if isinstance(notices, list) else []
    request_count = state.get("publicationRequestCount")
    if not isinstance(request_count, int) or isinstance(request_count, bool) or request_count < 0:
        request_count = None

    if request_count == 0 and not responses:
        if notices:
            return {"classification": "no_request_validation", "requestSent": False,
                    "responseCount": 0, "noticeCount": len(notices),
                    "notices": notices[:5]}
        return {"classification": "unknown", "requestSent": False,
                "responseCount": 0, "noticeCount": 0}
    if request_count is None and not responses:
        return {"classification": "unknown", "requestSent": None,
                "responseCount": 0, "noticeCount": len(notices)}

    def value_is_zero(value):
        return (type(value) is int and value == 0) or value == "0"

    accepted = False
    rejected = False
    for response in responses:
        if not isinstance(response, dict):
            continue
        status = response.get("httpStatus")
        http_ok = isinstance(status, int) and 200 <= status < 400
        for key in ("errno", "errNo", "error_code", "code"):
            if key in response:
                if value_is_zero(response[key]) and http_ok:
                    accepted = True
                elif not value_is_zero(response[key]):
                    rejected = True
                break
        if isinstance(status, int) and status >= 400:
            rejected = True
    if accepted and not rejected:
        classification = "accepted"
    elif rejected and not accepted:
        classification = "server_rejected"
    else:
        classification = "unknown"
    return {"classification": classification, "requestSent": bool(responses) or request_count is None or request_count > 0,
            "requestCount": request_count, "responseCount": len(responses),
            "noticeCount": len(notices)}


async def verify_publication_record(payload, state, candidate):
    status = publication_status(candidate)
    record = candidate.get("record", {})
    expected_description = video_description(payload, state)
    if (str(record.get("article_id")) != candidate.get("id") or record.get("type") != "video"
            or not record.get("file_name") or draft_text(record.get("title")) != draft_text(expected_description)):
        raise RuntimeError("发表记录与原视频或完整标题不匹配")
    attempted = state.get("publishAttemptedAt")
    if not isinstance(attempted, (int, float)) or attempted <= 0:
        raise RuntimeError("缺少本次发表意图记录，不能核对发表")
    created = draft_timestamp(record.get("created_at"))
    if created is None or not int(state.get("fileSelectionStartedAt", attempted)) <= created <= attempted + 120:
        raise RuntimeError("作品创建时间不属于本次上传，不能核对发表")
    if state.get("expectedPublicationId") not in (None, candidate["id"]):
        raise RuntimeError("作品 ID 与原发表任务不匹配")
    if local_files(payload) != state.get("files"):
        raise RuntimeError("原上传素材已变化，不能核对发表")
    source = str(Path(payload["videoPath"]).resolve(strict=True))
    digest = state["files"].get(source)
    details = state.get("details", {})
    media = details.get("media", {})
    if (not digest or media.get("status") != "uploaded" or media.get("video_fingerprint") != digest
            or draft_text(details.get("metadata", {}).get("description", {}).get("value")) != draft_text(expected_description)):
        raise RuntimeError("缺少原视频和文案的上传凭证，不能核对发表")
    duration = await asyncio.to_thread(local_video_duration, source)
    try:
        remote_duration = float(record["rmb_duration"])
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("平台未提供可核对的视频时长，保持待核对")
    if not 0 < remote_duration < 86400 or abs(remote_duration - duration) > 1:
        raise RuntimeError("平台作品时长与原成片不一致，不能核对发表")
    return {"verification": "platform_video_publication_record", "publicationStatus": status,
            "videoSha256": digest, "videoDuration": remote_duration, "localVideoDuration": duration,
            "accountName": payload.get("accountName"), "platformRecord": record,
            "statusLabels": candidate.get("statusLabels", [])}


async def publication_button(page):
    button = page.locator('[data-testid="publish-btn"]:visible')
    if await button.count() == 0:
        button = page.get_by_role("button", name=re.compile(r"^(发布|发表)$"))
    if await button.count() != 1 or not await button.is_visible() or not await button.is_enabled():
        raise RuntimeError("没有唯一可用的发表按钮；尚未点击发表")
    return button


async def finish_staged_baijiahao_cover(page, payload, state, file, engine):
    """Finish a delayed crop dialog for the bound poster, without selecting files."""
    helpers = engine[3]
    dialogs = await baijiahao_dialogs(page, helpers._READ_DIALOGS)
    if not dialogs:
        return
    if (state.get("phase") != "staged" or state.get("saveAttemptedAt") is not None
            or state.get("publishAttemptedAt") is not None or len(dialogs) != 1):
        raise RuntimeError("只能确认原任务尚未保存或发表的唯一封面裁剪窗")
    dialog = dialogs[0]
    kinds = [(kind, key) for kind, key, label in (("landscape", "landscapePath", "横版封面预览"),
             ("portrait", "portraitPath", "竖版封面预览")) if label in dialog.get("text", "")]
    if (len(kinds) != 1 or dialog.get("source_count") != 1 or dialog.get("preview_count") != 1
            or not dialog.get("source") or not dialog.get("preview")):
        raise RuntimeError("当前窗口不是已加载的本任务封面裁剪窗，未确认")
    if await helpers._browser_digest(page, dialog["source"]) != await asyncio.to_thread(helpers._file_digest, payload[kinds[0][1]]):
        raise RuntimeError("当前裁剪源图与本任务封面不一致，不能确认")
    await verify_document(page, payload, state)
    details = state["details"]
    media = await helpers.verify_upload(page, payload["videoPath"], timeout=5)
    if (media.get("media_src") != details["media"].get("media_src")
            or media.get("video_fingerprint") != details["media"].get("video_fingerprint")):
        raise RuntimeError("原视频已变化，不能确认封面")
    await helpers._verify_metadata(page, details["metadata"])
    slots = await helpers._cover_slots(page)
    for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
        proof = details.get("covers", {}).get(kind, {})
        digest = await asyncio.to_thread(helpers._file_digest, payload[key])
        if (proof.get("status") != "uploaded" or proof.get("fingerprint") != digest
                or proof.get("source_sha256_verified") != digest or not proof.get("preview")
                or slots[kind].get("src") != proof["preview"]):
            raise RuntimeError("原横竖封面与已绑定上传证明不一致，未确认")

    def checkpoint(covers):
        details["covers"] = {**details["covers"], **covers}
        write_state(file, state)

    covers = await baijiahao_covers(page, payload, helpers, verified=details["covers"],
                                  checkpoint=checkpoint, confirm_only=True)
    await helpers.verify_page(page, details["metadata"], covers)


async def prepare_publication_topics(page, payload, state, file):
    details = state.setdefault("details", {})
    try:
        details["metadata"] = await add_optional_topics(page, payload, details["metadata"])
    except RequiredTopicError as error:
        if error.metadata is not None:
            details["metadata"] = error.metadata
            write_state(file, state)
        raise
    write_state(file, state)
    topic = details["metadata"].get("topicAttempt")
    if topic:
        progress("已选择话题：" + "、".join(topic["selectedLabels"]) if topic["selectedLabels"]
                 else "本次未添加话题，继续发表", "metadata")


async def publication_preflight(page, payload, state, engine, *, prepare_file=None):
    if publication_mode(payload) != "publish" or state.get("phase") != "staged" or state.get("publishAttemptedAt"):
        raise RuntimeError("只能预检尚未发表的原视频编辑页")
    if local_files(payload) != state.get("files"):
        raise RuntimeError("原上传素材已变化，不能发表")
    if prepare_file is not None and payload.get("target") == "baijiahao-video":
        await finish_staged_baijiahao_cover(page, payload, state, prepare_file, engine)
    await verify_staged(page, payload, state, engine)
    # Baijiahao's video editor blocks the publish handler before creating any
    # network request when this mandatory declaration is empty. Fill it during
    # preflight so the subsequent click is deterministic. This is an editor
    # field update only; no save or publish request is made here.
    if prepare_file is not None and payload.get("target") == "baijiahao-video":
        # Topic lookup is optional. Persist its actual description so a skipped
        # tag or a differently named first result can still match the receipt.
        # The original video and copy were verified above; never refill them.
        await prepare_publication_topics(page, payload, state, prepare_file)
        settings = await ensure_baijiahao_fields(page, payload)
        if settings:
            details = state.setdefault("details", {})
            details["settings"] = settings
            # Keep the selected values directly on the checkpoint as well as
            # under settings for older readers and recovery diagnostics.
            details.update({key: value for key, value in settings.items() if key in ("creationDeclaration", "watermark")})
            write_state(prepare_file, state)
    await publication_button(page)
    return {"ready": True, "writes": bool(prepare_file and payload.get("target") == "baijiahao-video"),
            "targetId": state["result"]["targetId"]}


async def reconcile_publication(browser, payload, state, file):
    if publication_mode(payload) != "publish" or not state.get("publishAttemptedAt") or not state.get("result"):
        raise RuntimeError("只能只读核对已记录发表意图的任务")

    def record_check(diagnostic):
        state["publicationCheck"] = {key: diagnostic[key]
                                     for key in ("outcome", "pagesScanned", "rowsScanned") if key in diagnostic}
        state["publicationCheck"]["checkedAt"] = time.time()
        write_state(file, state)

    listing = await browser.contexts[0].new_page()
    try:
        checkpoint_progress(file, state, "reconcile", "正在只读核对百家号作品与审核状态，不会再次发表")
        started = time.monotonic()
        for attempt in range(2):
            try:
                candidate, _, diagnostic = await locate_baijiahao_draft(
                    listing, title=video_description(payload, state), attempted_at=state["publishAttemptedAt"],
                    target=payload["target"], expected_id=state.get("expectedPublicationId"),
                    match=matching_publication, collection="")
                record_check(diagnostic)
                break
            except BaijiahaoDraftListingError as error:
                record_check(error.diagnostic)
                # A successful POST may reach the list a few seconds later.
                # Retry the read once only after a complete, short no-match
                # scan. Ambiguous/failed scans and unknown POSTs stay blocked.
                can_retry = (attempt == 0 and time.monotonic() - started < 30
                             and publication_observation(state)["classification"] == "accepted"
                             and error.diagnostic.get("outcome") in ("not_found", "unmatched"))
                if not can_retry:
                    raise
                await asyncio.sleep(2)
        evidence = await verify_publication_record(payload, state, candidate)
        state["expectedPublicationId"] = candidate["id"]
        state["publicationEvidence"] = evidence
        state.pop("publicationError", None)
        evidence_path = str(file.parent / "publication.png")
        # The server record is durable evidence even if the screenshot fails.
        result = {**state["result"], "saved": False, "submitted": True,
                  "publicationStatus": evidence["publicationStatus"],
                  "published": evidence["publicationStatus"] == "published",
                  "articleId": candidate["id"], "publishedUrl": candidate["url"].replace("http://", "https://", 1)}
        result.pop("draftUrl", None)
        state["phase"] = evidence["publicationStatus"]
        state["result"] = result
        checkpoint_progress(file, state, state["phase"], "百家号已发布" if result["published"] else "已提交百家号，等待平台审核")
        try:
            await listing.screenshot(path=evidence_path, full_page=True)
            result["evidencePath"] = evidence_path
            write_state(file, state)
        except Exception:
            pass
        return result
    except Exception as error:
        state["publicationError"] = str(error)[:1000]
        write_state(file, state)
        raise RuntimeError("发表结果待核对；不会重传或再次发表：" + str(error).replace("草稿", "作品")) from error
    finally:
        await listing.close()


def publication_diagnostic_text(value):
    text = re.sub(r"https?://\S+", "[URL]", str(value))
    text = re.sub(r"(?i)\b(token|cookie|authorization|access_token|csrf_token)\s*[:=]\s*[^\s,;]+",
                  r"\1=[redacted]", text)
    return text.strip()[:300]


def missing_creation_declaration_rejection(payload, state):
    """Only the observed mandatory client validation can reopen an attempt.

    The editor's video bundle emits this exact notice and returns before its
    publish POST. An empty response list alone never authorizes another click.
    Older checkpoints without observed notices remain reconciliation-only.
    """
    return bool(state and payload.get("accountName") == "history_baijiahao"
                and payload.get("target") == "baijiahao-video" and publication_mode(payload) == "publish"
                and state.get("phase") == "publish_requested" and state.get("publishAttemptedAt")
                and state.get("publishClickedAt") and state.get("documentToken")
                and state.get("publicationResponses") == []
                and type(state.get("publicationRequestCount")) is int
                and state["publicationRequestCount"] == 0
                and publication_observation(state)["classification"] == "no_request_validation"
                and state.get("publicationNotices") == ["请选择创作声明类型"]
                and not state.get("expectedPublicationId") and not state.get("publicationEvidence")
                and not state.get("result", {}).get("submitted"))


async def _baijiahao_watermark_control(page):
    # Observed video editor: this combobox owns the watermark selection. Text
    # elsewhere (including its open popup) is not evidence of the chosen value.
    field = page.locator('#video_pick_type[role="combobox"]')
    if await field.count() != 1:
        raise RuntimeError("找不到唯一的百家号水印控件")
    control = page.locator(".cheetah-select").filter(has=field)
    if await control.count() != 1 or not await control.is_visible():
        raise RuntimeError("百家号水印控件不唯一或不可见")
    return field, control


async def _baijiahao_watermark_value(page):
    _, control = await _baijiahao_watermark_control(page)
    selected = control.locator(".cheetah-select-selection-item")
    count = await selected.count()
    if count > 1:
        raise RuntimeError("百家号水印控件的已选值不唯一")
    return (await selected.inner_text()).strip() if count else ""


async def _ensure_baijiahao_watermark(page, value):
    if await _baijiahao_watermark_value(page) != value:
        field, control = await _baijiahao_watermark_control(page)
        if await field.get_attribute("aria-controls") != "video_pick_type_list":
            raise RuntimeError("百家号水印选项与控件的关联无效")
        await control.locator(".cheetah-select-selector").click(timeout=10000)
        dropdown = page.locator(".cheetah-select-dropdown").filter(has=page.locator('[id="video_pick_type_list"]'))
        await dropdown.first.wait_for(state="visible", timeout=10000)
        if await dropdown.count() != 1:
            raise RuntimeError("找不到唯一的百家号水印选项列表")
        options = dropdown.locator(".cheetah-select-item-option").filter(has_text=re.compile(r"^\s*" + re.escape(value) + r"\s*$"))
        visible = [option for option in await options.all() if await option.is_visible()]
        if len(visible) != 1:
            raise RuntimeError(f"找不到唯一的百家号水印选项：{value}")
        await visible[0].click(timeout=10000)
        for _ in range(20):
            if await _baijiahao_watermark_value(page) == value:
                break
            await asyncio.sleep(0.1)
    if await _baijiahao_watermark_value(page) != value:
        raise RuntimeError(f"百家号水印选项未保留：{value}")
    return {"value": value, "control": "video_pick_type", "verified": True}


async def _ensure_baijiahao_creation_declaration(page, value):
    if not value:
        return None
    field = page.get_by_placeholder("请选择创作声明", exact=True)
    if await field.count() != 1:
        raise RuntimeError("找不到唯一的创作声明输入框；尚未点击发表")
    current = await field.input_value()
    if current and current != value:
        raise RuntimeError("原编辑页已有其他创作声明，请核对后继续；尚未点击发表")
    dialog = page.locator('[role="dialog"]:visible')
    if current != value or await dialog.count():
        if not await dialog.count():
            await field.click(timeout=10000)
            await dialog.first.wait_for(state="visible", timeout=10000)
        if await dialog.count() != 1:
            raise RuntimeError("创作声明弹窗不唯一；尚未点击发表")
        if not re.match(r"^\s*(?:创作声明\s+)?必选声明(?:\s|$)", await dialog.inner_text()):
            raise RuntimeError("当前弹窗不是已知创作声明，保持原页面；尚未点击发表")
        if await dialog.get_by_text(value, exact=True).count() != 1:
            raise RuntimeError("创作声明选项不唯一；尚未点击发表")
        await dialog.get_by_text(value, exact=True).click(timeout=10000)
        await dialog.get_by_role("button", name="确定", exact=True).click(timeout=10000)
        await dialog.wait_for(state="hidden", timeout=10000)
    if await field.input_value() != value:
        raise RuntimeError("创作声明未保留选择；尚未点击发表")
    return {"value": value, "verified": True}


async def resume_baijiahao_creation_dialog(page, payload, state, helpers):
    """Called only after the bound upload's current media and copy were verified."""
    dialogs = await baijiahao_dialogs(page, helpers._READ_DIALOGS)
    if not dialogs or len(dialogs) == 1 and re.search(r"[横竖]版封面预览", dialogs[0].get("text", "")):
        return
    value = payload.get("creationDeclaration") or ("含AI生成内容" if payload.get("accountName") == "history_baijiahao" else None)
    if (len(dialogs) != 1 or not value
            or not re.match(r"^\s*创作声明\s+必选声明(?:\s|$)", dialogs[0].get("text", ""))):
        raise RuntimeError("出现非本任务封面或创作声明弹窗，保持原页面；未重复上传或发表")
    if state.get("phase") != "uploading" or state.get("saveAttemptedAt") is not None or state.get("publishAttemptedAt") is not None:
        raise RuntimeError("只能恢复尚未保存或发表的原上传声明弹窗")
    details = state.get("details", {})
    media = details.get("media", {})
    if (media.get("verification") != "blob_sha256" or media.get("status") != "uploaded"
            or media.get("video_fingerprint") != state.get("files", {}).get(str(Path(payload["videoPath"]).resolve()))):
        raise RuntimeError("原视频缺少指纹证明，未修改创作声明")
    await verify_document(page, payload, state)
    slots = await helpers._cover_slots(page)
    for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
        proof = details.get("covers", {}).get(kind, {})
        digest = state.get("files", {}).get(str(Path(payload[key]).resolve()))
        if (not digest or proof.get("status") != "uploaded" or proof.get("fingerprint") != digest
                or proof.get("source_sha256_verified") != digest or not proof.get("preview")
                or slots[kind].get("src") != proof["preview"]):
            raise RuntimeError("原横竖封面与上传证明不一致，未修改创作声明")
    await _ensure_baijiahao_creation_declaration(page, value)


async def ensure_baijiahao_fields(page, payload):
    declaration_value = payload.get("creationDeclaration") or (
        "含AI生成内容" if payload.get("accountName") == "history_baijiahao" else None)
    declaration = await _ensure_baijiahao_creation_declaration(page, declaration_value)
    watermark = None
    if payload.get("watermark"):
        watermark = await _ensure_baijiahao_watermark(page, payload["watermark"])
    return {key: value for key, value in (("creationDeclaration", declaration), ("watermark", watermark)) if value}


async def verify_baijiahao_fields(page, payload, expected=None):
    expected = expected or {}
    declaration = payload.get("creationDeclaration")
    if declaration:
        field = page.get_by_placeholder("请选择创作声明", exact=True)
        if await field.count() != 1 or await field.input_value() != declaration:
            raise RuntimeError("百家号创作声明与任务要求不一致")
    watermark = payload.get("watermark")
    if watermark:
        observed = await _baijiahao_watermark_value(page)
        if observed != watermark or expected.get("watermark") and observed != expected["watermark"].get("value"):
            raise RuntimeError("百家号水印设置与任务要求不一致")
    return True


async def ensure_history_creation_declaration(page, payload, state, file):
    value = payload.get("creationDeclaration") or ("含AI生成内容" if payload.get("accountName") == "history_baijiahao" else None)
    declaration = await _ensure_baijiahao_creation_declaration(page, value)
    if declaration:
        state.setdefault("details", {})["creationDeclaration"] = declaration
        write_state(file, state)


async def repair_creation_declaration_rejection(page, payload, state, file, engine):
    if not missing_creation_declaration_rejection(payload, state):
        raise RuntimeError("缺少明确的前端创作声明拒绝证据，只能核对原发表结果")
    if local_files(payload) != state.get("files"):
        raise RuntimeError("原素材已变化，不能修复创作声明")
    # Verify the original document, video bytes, title and covers before any
    # editor change. No new tab, upload, or replacement task is permitted.
    await verify_staged(page, payload, state, engine)
    await ensure_history_creation_declaration(page, payload, state, file)
    keys = ("publishAttemptedAt", "publishClickedAt", "publicationRequestCount", "publicationResponses",
            "publicationNotices", "publicationObservation", "publicationClickError", "publicationError")
    attempt = {key: state[key] for key in keys if key in state}
    attempt.update(reason="client_validation_missing_creation_declaration", targetId=state["targetId"],
                   repairedAt=time.time())
    state.setdefault("publicationAttempts", []).append(attempt)
    for key in keys:
        state.pop(key, None)
    state["phase"] = "staged"
    checkpoint_progress(file, state, "staged", "已补全平台必填创作声明，继续原视频发表，不会重新上传")


async def publish_video(page, payload, state, file, engine, preflight=publication_preflight):
    await preflight(page, payload, state, engine, prepare_file=file)
    button = await publication_button(page)
    notices = page.locator('[role="alert"]:visible,.cheetah-message-error:visible,'
                          '.cheetah-message-warning:visible,.cheetah-message-success:visible')
    old_notices = set(await notices.all_text_contents())
    pending_responses = set()

    def persist_observation():
        state["publicationObservation"] = publication_observation(state)
        write_state(file, state)

    async def record_response(response):
        # Read the actual publication endpoint only. Never retain request data,
        # cookies, signed URLs, or the response's unrelated/private fields.
        evidence = {"path": "/pcui/article/publish", "httpStatus": response.status}
        try:
            body = await asyncio.wait_for(response.json(), timeout=3)
            if isinstance(body, dict):
                for key in ("errno", "errNo", "error_code", "code", "errmsg", "message", "msg", "error"):
                    value = body.get(key)
                    if isinstance(value, (str, int, float, bool)):
                        evidence[key] = publication_diagnostic_text(value) if isinstance(value, str) else value
        except Exception:
            pass
        if len(state["publicationResponses"]) < 5:
            state["publicationResponses"].append(evidence)
            persist_observation()

    def response_received(response):
        url = urlparse(response.url)
        if (response.request.method == "POST" and url.scheme == "https"
                and url.hostname == "baijiahao.baidu.com" and url.path == "/pcui/article/publish"):
            task = asyncio.create_task(record_response(response))
            pending_responses.add(task)
            task.add_done_callback(pending_responses.discard)

    def request_started(request):
        url = urlparse(request.url)
        if (request.method == "POST" and url.scheme == "https"
                and url.hostname == "baijiahao.baidu.com" and url.path == "/pcui/article/publish"):
            state["publicationRequestCount"] += 1
            persist_observation()

    async def record_notices():
        while True:
            try:
                current = await notices.all_text_contents()
                for text in current:
                    value = publication_diagnostic_text(text)
                    if (text not in old_notices and value and value not in state["publicationNotices"]
                            and len(state["publicationNotices"]) < 5):
                        state["publicationNotices"].append(value)
                        persist_observation()
            except Exception:
                pass  # Navigation can replace the document during observation.
            await asyncio.sleep(0.2)

    # Write intent before the irreversible click. A crash after this line can
    # only reconcile; even a click timeout must never lead to a second submit.
    state["publishAttemptedAt"] = time.time()
    state["phase"] = "publish_requested"
    state["publicationRequestCount"] = 0
    state["publicationResponses"] = []
    state["publicationNotices"] = []
    state["publicationObservation"] = publication_observation(state)
    checkpoint_progress(file, state, "publishing", "正在提交百家号发表，已记录防重复发表检查点")
    page.on("response", response_received)
    page.on("request", request_started)
    notice_task = asyncio.create_task(record_notices())
    try:
        await button.click(timeout=10000)
        state["publishClickedAt"] = time.time()
        write_state(file, state)
        await page.wait_for_url(re.compile(r"^https://baijiahao\.baidu\.com/builder/rc/(clue|content|home)(?:[/?#]|$)"), timeout=30000)
    except Exception as error:
        state["publicationClickError"] = str(error)[:500]
        write_state(file, state)
    finally:
        page.remove_listener("response", response_received)
        page.remove_listener("request", request_started)
        notice_task.cancel()
        await asyncio.gather(notice_task, *pending_responses, return_exceptions=True)
        persist_observation()
    return await reconcile_publication(page.context.browser, payload, state, file)


async def verify_saved_baijiahao_covers(page, payload, helpers):
    """Verify existing saved-editor covers without opening an upload picker."""
    slots = await helpers._cover_slots(page)
    for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
        src = slots[kind].get("src")
        if not src:
            raise RuntimeError(f"原百家号草稿缺少{kind}封面，未发表")
        expected = helpers._normalized_pixels(base64.b64encode(Path(payload[key]).read_bytes()).decode())
        try:
            actual = await helpers._cover_pixels(page, src)
        except Exception as error:
            if not re.search(r"Failed to fetch|NetworkError when attempting to fetch resource", str(error)):
                raise
            try:
                url = urlparse(src)
                official_image = (not re.search(r"[\x00-\x20\x7f\\]", src) and url.scheme == "https"
                                  and url.hostname == "pic.rmb.bdstatic.com" and not url.username and not url.password
                                  and url.port in (None, 443) and url.path.startswith("/bjh/") and not url.fragment)
            except (TypeError, ValueError):
                official_image = False
            if not official_image:
                raise RuntimeError("封面读取失败，不能通过请求上下文获取非官方或无效图片地址") from error
            loaded = await page.locator("img").evaluate_all("""(images, src) => images.some(image =>
                (image.currentSrc || image.src) === src && image.complete && image.naturalWidth > 0 &&
                image.naturalHeight > 0 && image.getClientRects().length > 0)""", src)
            if not loaded:
                raise RuntimeError("官方封面尚未在当前页面加载完成，未确认封面") from error
            # A displayed CDN image can load while page fetch is blocked by CORS.
            response = await page.context.request.get(src, timeout=15000, max_redirects=0)
            try:
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if (response.status != 200 or response.url != src
                        or not (content_type.startswith("image/") or content_type == "jpeg")):
                    raise RuntimeError("官方封面图片请求失败或返回了不同地址、非图片内容")
                actual = helpers._normalized_pixels(base64.b64encode(await response.body()).decode())
            finally:
                await response.dispose()
        difference = helpers._pixel_difference(expected, actual)
        if difference["mae"] > 3 or difference["rmse"] > 5:
            raise RuntimeError(f"原百家号草稿{kind}封面与本地封面不一致，未发表")


async def verify_saved_publication_covers(page, payload, legacy, revision, helpers):
    """Accept bound old/new slots and reuse only completed, unchanged new previews."""
    slots = await helpers._cover_slots(page)
    verified = {"layout": "videoV2"}
    for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
        src = slots[kind].get("src")
        if not src:
            raise RuntimeError("原草稿封面槽已变化，未继续替换")
        proof = revision.get("covers", {}).get(kind, {})
        digest = revision["files"][str(Path(payload[key]).resolve())]
        if (proof.get("preview") == src and proof.get("verification") == "source_and_preview"
                and proof.get("fingerprint") == digest and proof.get("source_sha256_verified") == digest):
            verified[kind] = proof
            continue
        actual = await helpers._cover_pixels(page, src)
        for candidate in (legacy[key], payload[key]):
            expected = helpers._normalized_pixels(base64.b64encode(Path(candidate).read_bytes()).decode())
            difference = helpers._pixel_difference(expected, actual)
            if difference["mae"] <= 3 and difference["rmse"] <= 5:
                break
        else:
            raise RuntimeError(f"原草稿{kind}封面既非原图也非绑定的新图，未覆盖当前封面")
    return verified


async def publication_preflight_saved(page, payload, state, engine, *, prepare_file=None):
    if state.get("phase") != "staged" or state.get("publishAttemptedAt"):
        raise RuntimeError("原草稿转发表前置状态无效，未点击发表")
    helpers = engine[3]
    await helpers._verify_metadata(page, state["details"]["metadata"])
    await verify_saved_baijiahao_covers(page, payload, helpers)
    await verify_baijiahao_fields(page, payload, state.get("details", {}).get("settings"))
    if prepare_file is not None:
        await prepare_publication_topics(page, payload, state, prepare_file)
    await publication_button(page)
    return {"ready": True, "writes": prepare_file is not None, "targetId": state["result"]["targetId"]}


def saved_publication_revision(payload, legacy, state):
    """Bind an in-place draft revision without changing its video identity."""
    if (not isinstance(legacy, dict) or publication_mode(payload) != "publish" or publication_mode(legacy) != "draft"
            or payload.get("target") != "baijiahao-video" or not payload.get("accountName")):
        raise RuntimeError("原草稿转发表身份无效，未执行平台写入")
    mutable = {"publicationMode", "description", "tags", "topicPolicy", "creationDeclaration", "watermark",
               "landscapePath", "portraitPath", "fingerprint"}
    if ({key: value for key, value in payload.items() if key not in mutable}
            != {key: value for key, value in legacy.items() if key not in mutable}):
        raise RuntimeError("原草稿转发表必须保留原视频、账号、标题和任务身份")
    previous_digest, revised_digest = payload_digest(legacy), payload_digest(payload)
    previous = state.get("savedPublication")
    original = previous.get("legacyState") if isinstance(previous, dict) else state
    if (not isinstance(original, dict) or original.get("phase") != "saved"
            or original.get("payloadDigest") != previous_digest
            or not has_saved_draft_identity(legacy, original.get("result", {}))
            or original.get("result", {}).get("saved") is not True
            or original.get("result", {}).get("published") is not False):
        raise RuntimeError("原草稿检查点不是已核验保存状态，未发表")
    identifier = parse_qs(urlparse(original["result"]["draftUrl"]).query)["article_id"][0]
    if previous:
        if (previous.get("legacyPayloadDigest") != previous_digest or previous.get("payloadDigest") != revised_digest
                or previous.get("articleId") != identifier or previous.get("legacyFiles") != original.get("files")
                or state.get("payloadDigest") not in (previous_digest, revised_digest)):
            raise RuntimeError("原草稿已绑定另一发表版本，不能更换任务身份")
        expected_files = previous.get("files") if state["payloadDigest"] == revised_digest else previous.get("legacyFiles")
        if state.get("files") != expected_files:
            raise RuntimeError("原草稿转发表素材快照不一致，未继续")
        # A publication intent can only be reconciled, even if local files disappear.
        if state.get("publishAttemptedAt") is not None or state.get("phase") in ("submitted", "published"):
            return previous
    if local_files(legacy) != original.get("files"):
        raise RuntimeError("原草稿素材已变化，未发表")
    files = local_files(payload)
    video = str(Path(payload["videoPath"]).resolve(strict=True))
    if files.get(video) != original["files"].get(video):
        raise RuntimeError("原视频素材已变化，不能借用原草稿发表")
    if previous:
        if previous.get("files") != files:
            raise RuntimeError("新封面素材与原发表版本不一致，未继续")
        return previous
    return {"legacyPayloadDigest": previous_digest, "payloadDigest": revised_digest, "articleId": identifier,
            "legacyFiles": original["files"], "files": files, "legacyState": json.loads(json.dumps(original))}


async def publish_saved_baijiahao_video(request):
    """Publish a previously saved video draft in place; never select the video again."""
    config = request["config"]
    payload = request["payload"]
    legacy = request.get("legacyPayload")
    file = job_state_file(request)
    if not file.exists():
        raise RuntimeError("原草稿上传检查点不存在，未发表")
    state = json.loads(file.read_text(encoding="utf-8"))
    revision = saved_publication_revision(payload, legacy, state)
    original = revision["legacyState"]
    identifier = revision["articleId"]
    revised = state.get("payloadDigest") == revision["payloadDigest"]
    if revised and state.get("phase") in ("submitted", "published"):
        result = checkpoint_result(payload, state)
        if not result or not has_publication_identity(payload, result) or result.get("articleId") != identifier:
            raise RuntimeError("原草稿发表回执身份不一致，未重复发表")
        return result
    state["savedPublication"] = revision
    write_state(file, state)
    result = original["result"]
    engine = load_engine()
    _, _, async_playwright, _, _, _ = engine
    async with async_playwright() as playwright:
        browser, _, account_digest = await connect_upload_browser(playwright, config, payload, state)
        listing = None
        page = None
        keep_open = True
        try:
            if revised and state.get("publishAttemptedAt") is not None:
                published = await reconcile_publication(browser, payload, state, file)
                if published.get("articleId") != identifier:
                    raise RuntimeError("发表回执与原草稿作品 ID 不一致")
                return published
            helpers = engine[3]
            if revised and state.get("phase") == "staged":
                pages = [item for context in browser.contexts for item in context.pages
                         if await page_id(item) == state.get("targetId")]
                if len(pages) == 1:
                    page = pages[0]
                    await verify_saved_video(page, payload, state, helpers)
                    await verify_saved_baijiahao_covers(page, payload, helpers)
                    published = await publish_video(page, payload, state, file, engine, preflight=publication_preflight_saved)
                    if published.get("articleId") != identifier:
                        raise RuntimeError("发表回执与原草稿作品 ID 不一致")
                    keep_open = False
                    return published
            verified_covers = None
            binding = revision.get("editor")
            if binding and not revised:
                pages = [item for context in browser.contexts for item in context.pages
                         if await page_id(item) == binding.get("targetId")]
                if len(pages) == 1:
                    page = pages[0]
                    if any(state.get(key) != binding.get(key) for key in ("targetId", "documentToken")):
                        raise RuntimeError("原草稿封面修订编辑页身份不一致")
                    await verify_document(page, legacy, state)
                    await verify_saved_video(page, legacy, original, helpers, alternate_description=payload["description"])
                    verified_covers = await verify_saved_publication_covers(page, payload, legacy, revision, helpers)
            if page is None:
                listing = await browser.contexts[0].new_page()
                try:
                    public_evidence = await verify_public_baijiahao_preview(listing, identifier, payload)
                    result = {**result, "saved": False, "submitted": True, "published": True,
                              "publicationStatus": "published", "articleId": identifier,
                              "publishedUrl": f"https://baijiahao.baidu.com/builder/preview/s?id={identifier}"}
                    result.pop("draftUrl", None)
                    state["expectedPublicationId"] = identifier
                    state["publicationEvidence"] = public_evidence
                    state.pop("publicationError", None)
                    state["payloadDigest"] = payload_digest(payload)
                    state["files"] = revision["files"]
                    state["phase"] = "published"
                    state["result"] = result
                    checkpoint_progress(file, state, "published", "已核验百家号公开作品，不会重复发表")
                    return result
                except Exception as public_error:
                    state["publicVerification"] = {"status": "unconfirmed", "message": str(public_error)[:500],
                                                     "checkedAt": time.time(), "articleId": identifier}
                    write_state(file, state)
                # Enter through the original draft row so the platform binds its video.
                candidate, row, diagnostic = await locate_baijiahao_draft(
                    listing, title=video_description(legacy, original), attempted_at=original.get("saveAttemptedAt", 0),
                    target="baijiahao-video", expected_id=identifier, match=matching_saved_draft)
                if candidate.get("id") != identifier:
                    raise RuntimeError("原草稿列表返回了不同的视频 ID，未发表")
                edit = row.locator(".article-action-btn:visible").filter(has_text=re.compile(r"^\s*修改\s*$"))
                await edit.wait_for(state="visible", timeout=30000)
                async with listing.expect_popup(timeout=15000) as popup:
                    await edit.click()
                page = await popup.value
                await page.wait_for_url(re.compile(r"/builder/rc/edit\?.*article_id=" + identifier + r"(?:&|$)"), timeout=30000)
                state["targetId"] = await page_id(page)
                state["documentToken"] = secrets.token_hex(24)
                await page.evaluate("binding=>{window.name=binding.name;window.__huobaoSauDocumentToken=binding.token}",
                                    {"name": "huobao-sau-" + payload["jobId"], "token": state["documentToken"]})
                await verify_saved_video(page, legacy, original, helpers)
                if binding:
                    verified_covers = await verify_saved_publication_covers(page, payload, legacy, revision, helpers)
                else:
                    await verify_saved_baijiahao_covers(page, legacy, helpers)
            revision["editor"] = {key: state[key] for key in ("targetId", "documentToken")}
            write_state(file, state)
            covers = original["details"]["covers"]
            if any(revision["files"].get(str(Path(payload[key]).resolve()))
                   != revision["legacyFiles"].get(str(Path(legacy[key]).resolve()))
                   for key in ("landscapePath", "portraitPath")):
                def record_covers(value):
                    revision["covers"] = value
                    write_state(file, state)
                covers = await baijiahao_covers(page, payload, helpers, verified=verified_covers, checkpoint=record_covers)
                await verify_saved_baijiahao_covers(page, payload, helpers)
            metadata = await helpers.fill_metadata(page, payload["title"], payload["description"])
            settings = await ensure_baijiahao_fields(page, payload)
            state["details"] = {**state.get("details", {}), "metadata": metadata, "covers": covers, **({"settings": settings} if settings else {}),
                                 **({key: value for key, value in settings.items() if key in ("creationDeclaration", "watermark")} if settings else {})}
            state["legacyPayloadDigest"] = revision["legacyPayloadDigest"]
            state["payloadDigest"] = payload_digest(payload)
            state["files"] = revision["files"]
            state["expectedPublicationId"] = identifier
            for key in ("saveAttemptedAt", "saveClickedAt", "expectedDraftId"):
                state.pop(key, None)
            state["phase"] = "staged"
            state["result"] = {**result, "saved": False, "published": False, "editorUrl": page.url,
                               "targetId": state["targetId"]}
            state["result"].pop("draftUrl", None)
            if account_digest:
                state["accountCredentialDigest"] = account_digest
            checkpoint_progress(file, state, "staged", "已核验原草稿并更新发布设置，等待发表")
            published = await publish_video(page, payload, state, file, engine, preflight=publication_preflight_saved)
            if published.get("articleId") != identifier:
                raise RuntimeError("发表回执与原草稿作品 ID 不一致")
            keep_open = False
            return published
        finally:
            if listing is not None:
                await close_disposable_verification_page(listing)
            if not keep_open and page is not None:
                await page.close()
                try:
                    from account_browser import close_idle_account_browser
                    await close_idle_account_browser(browser)
                except Exception:
                    pass


def submitted_publication_identity(request, state):
    """A durable, previously verified submission can outlive its local media."""
    payload, supplied = request["payload"], request.get("result")
    result = checkpoint_result(payload, state) if isinstance(state, dict) else None
    evidence = state.get("publicationEvidence", {}) if isinstance(state, dict) else {}
    record = evidence.get("platformRecord", {}) if isinstance(evidence, dict) else {}
    if (payload.get("target") != "baijiahao-video" or not payload.get("accountName")
            or not has_publication_identity(payload, supplied) or not result
            or not has_publication_identity(payload, result)
            or state.get("phase") not in ("submitted", "published")
            or state.get("payloadDigest") != payload_digest(payload)
            or not state.get("accountCredentialDigest")
            or any(supplied.get(key) != result.get(key) for key in ("articleId", "targetId", "accountName"))
            or state.get("expectedPublicationId") != result["articleId"]
            or evidence.get("verification") != "platform_video_publication_record"
            or evidence.get("accountName") != payload["accountName"]
            or not isinstance(record, dict) or str(record.get("article_id")) != result["articleId"]
            or not record.get("app_id") or not record.get("file_name") or record.get("type") != "video"
            or not state.get("publishAttemptedAt")):
        raise RuntimeError("缺少原账号、作品 ID 或已验证的提交证据，保留原提交回执")
    filename = str(Path(payload["videoPath"]).resolve())
    digest = evidence.get("videoSha256")
    if (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or state.get("files", {}).get(filename) != digest
            or state.get("details", {}).get("media", {}).get("video_fingerprint") != digest
            or draft_text(record.get("title")) != draft_text(video_description(payload, state))):
        raise RuntimeError("原作品的已验证视频或文案身份不一致，保留原提交回执")
    return result, record


def publication_record_mismatches(state, candidate):
    """Keep immutable work identity; allow evidenced platform transcoding only."""
    evidence = state["publicationEvidence"]
    original = evidence["platformRecord"]
    record = candidate.get("record", {})
    mismatches = [key for key in ("article_id", "app_id", "type", "created_at")
                  if str(record.get(key)) != str(original.get(key))]
    if candidate.get("id") != state["result"]["articleId"]:
        mismatches.append("articleId")
    if draft_text(record.get("title")) != draft_text(original.get("title")):
        mismatches.append("title")
    try:
        local_duration = float(evidence["localVideoDuration"])
        remote_duration = float(record["rmb_duration"])
        original_duration = float(original["rmb_duration"])
        duration_matches = (0 < local_duration < 86400 and 0 < remote_duration < 86400
                            and abs(remote_duration - local_duration) <= 1
                            and abs(original_duration - local_duration) <= 1)
    except (KeyError, TypeError, ValueError):
        duration_matches = False
    if not duration_matches:
        mismatches.append("rmb_duration")
    if record.get("file_name") != original.get("file_name"):
        # The list changes its processing file ID and rounds duration after
        # moderation. Never infer that transition from title/duration alone.
        try:
            fingerprint = json.loads(record["bjh_video_finger_printing"])
            source_duration = float(fingerprint["bjh"]["duration"])
            original_fingerprint = original.get("bjh_video_finger_printing")
            if original_fingerprint not in (None, ""):
                # The native list may round 587.947s to 588 while its original
                # media fingerprint truncates to 587. Compare that fingerprint
                # with its persisted original, never with the list's rounding.
                fingerprint_matches = (duration_matches and fingerprint == json.loads(original_fingerprint)
                    and 0 < source_duration < 86400 and abs(source_duration - local_duration) <= 1)
            else:
                # Legacy receipts without an original fingerprint retain the
                # stricter source/list duration identity used before this fix.
                fingerprint_matches = duration_matches and source_duration == original_duration
            unedited_transcode = (publication_status(candidate) == "published"
                and type(record.get("has_edited_times")) is int and record["has_edited_times"] == 0
                and record.get("source_trace") == "CMS_VIDEO_PUBLISH" and record.get("source_type") == "creation"
                and isinstance(record.get("file_name"), str) and bool(record["file_name"].strip())
                and duration_matches and fingerprint_matches and original_duration == float(evidence["videoDuration"]))
        except (KeyError, TypeError, ValueError, RuntimeError):
            unedited_transcode = False
        if not unedited_transcode:
            mismatches.append("file_name")
    return mismatches


async def refresh_publication(request):
    """Read only the exact submitted article; never enter upload/recovery code."""
    file = job_state_file(request)
    state = json.loads(file.read_text(encoding="utf-8"))
    result, original_record = submitted_publication_identity(request, state)
    if result["published"]:
        return result
    payload = request["payload"]
    _, _, async_playwright, _, _, _ = load_engine()
    async with async_playwright() as playwright:
        browser, _, _ = await connect_upload_browser(playwright, request["config"], payload, state)
        listing = await browser.contexts[0].new_page()
        try:
            async def read_only(route):
                if route.request.method not in ("GET", "HEAD"):
                    await route.abort()
                else:
                    await route.fallback()
            await listing.route("**/*", read_only)
            candidate, _, diagnostic = await locate_baijiahao_draft(
                listing, title=video_description(payload, state), attempted_at=state["publishAttemptedAt"],
                target=payload["target"], expected_id=result["articleId"], match=matching_publication, collection="")
            record = candidate.get("record", {})
            status = publication_status(candidate)
            mismatches = publication_record_mismatches(state, candidate)
            if mismatches:
                raise RuntimeError("平台审核记录与原账号或原视频不一致（" + ",".join(mismatches) + "），保留原提交回执")
            refreshed = {**result, "publicationStatus": status, "published": status == "published"}
            if not has_publication_identity(payload, refreshed):
                raise RuntimeError("审核状态回执无效，保留原提交回执")
            state["publicationStatusCheck"] = {"checkedAt": time.time(), "outcome": diagnostic["outcome"],
                                               "articleId": result["articleId"], "status": status,
                                               "statusLabels": candidate.get("statusLabels", []),
                                               "platformRecord": record,
                                               "mediaReferenceChanged": record.get("file_name") != original_record.get("file_name")}
            state["phase"], state["result"] = status, refreshed
            write_state(file, state)
            return refreshed
        finally:
            await close_disposable_verification_page(listing)


async def reconcile_saved_draft(browser, payload, state, file, engine, *, repair_rejected_save=False):
    if payload["target"] == "tencent-video":
        return await reconcile_tencent_draft(browser, payload, state, file, engine, repair_rejected_save=repair_rejected_save)
    if payload["target"] not in ("baijiahao-video", "baijiahao-article") or state.get("phase") != "save_requested" or not state.get("saveAttemptedAt") or not state.get("result"):
        raise RuntimeError("只能只读核对已尝试保存的百家号草稿")
    article = payload["target"] == "baijiahao-article"
    if article and local_files(payload) != state["files"]:
        raise RuntimeError("原上传素材已变化，不能自动核对草稿")
    helpers = engine[3]
    title = payload["title"] if article else video_description(payload, state)
    listing = await browser.contexts[0].new_page()
    editor = None
    try:
        checkpoint_progress(file, state, "reconcile", "正在只读核对百家号草稿箱，不会重新上传或保存")
        candidate, row, diagnostic = await locate_baijiahao_draft(
            listing, title=title, attempted_at=state["saveAttemptedAt"], target=payload["target"],
            expected_id=state.get("expectedDraftId"), match=matching_saved_draft)
        state["draftCheck"] = {**diagnostic, "checkedAt": time.time()}
        # A slow editor/preview must not lose the already located record. A later
        # retry can follow its ID even after the list text or update time changes.
        state["expectedDraftId"] = candidate["id"]
        state["draftIdentitySource"] = state.get("draftIdentitySource", "unique_draft_record")
        write_state(file, state)
        content_evidence = None if article else await verify_baijiahao_video_record(payload, state, candidate)
        if content_evidence is not None:
            # Saving already succeeded on the server. An empty editor shell
            # must not turn that success into a failure or a duplicate upload.
            evidence = str(file.parent / "saved-list.png")
            state["phase"] = "saved"
            state["saveEvidence"] = {"draftId": candidate["id"], "savedAt": candidate["time"], **content_evidence}
            state.pop("error", None)
            state["result"] = {**state["result"], "saved": True,
                "draftUrl": f'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id={candidate["id"]}'}
            state["result"].pop("evidencePath", None)
            # Persist the server proof before taking an optional screenshot.
            checkpoint_progress(file, state, "complete", "平台已确认视频草稿保存完成")
            try:
                await listing.screenshot(path=evidence, full_page=True, timeout=5000)
                state["result"]["evidencePath"] = evidence
                write_state(file, state)
            except Exception:
                pass
            return state["result"]
        # Search can replace the original list after matching_saved_draft has
        # read it. Wait for the selected record instead of treating zero rows
        # during that transition as ambiguous. Hidden responsive buttons are
        # not competing draft entries; genuinely duplicate rows still fail.
        await row.wait_for(state="visible", timeout=30000)
        edit = row.locator(".article-action-btn:visible").filter(has_text=re.compile(r"^\s*修改\s*$"))
        await edit.wait_for(state="visible", timeout=30000)
        await listing.screenshot(path=str(file.parent / "saved-list.png"), full_page=True)
        async with listing.expect_popup(timeout=15000) as popup:
            await edit.click()
        editor = await popup.value
        await editor.wait_for_url(re.compile(r"/builder/rc/edit\?.*article_id=" + candidate["id"] + r"(?:&|$)"), timeout=30000)
        if article:
            progress("正在只读核对已保存图文的标题、全文、配图与封面", "reconcile")
            content_evidence = {"article": await verify_saved_article(editor, payload, helpers, covers=state.get("details", {}).get("covers"))}
        else:
            content_evidence = await verify_saved_video(editor, payload, state, helpers)
        evidence = str(file.parent / "saved.png")
        await editor.screenshot(path=evidence, full_page=True)
        state["phase"] = "saved"
        state["saveEvidence"] = {"draftId": candidate["id"], "savedAt": candidate["time"], **content_evidence}
        state.pop("error", None)
        state["result"] = {**state["result"], "saved": True, "draftUrl": editor.url, "evidencePath": evidence}
        checkpoint_progress(file, state, "complete", "已核实百家号草稿保存完成")
        return state["result"]
    except Exception as error:
        state["error"] = str(error)
        if hasattr(error, "diagnostic"):
            state["draftCheck"] = {**error.diagnostic, "checkedAt": time.time()}
        observed = editor or listing
        evidence = str(file.parent / "reconcile-incomplete.png")
        try:
            await observed.screenshot(path=evidence, full_page=True)
            state["reconcileEvidence"] = {"checkedAt": time.time(), "evidencePath": evidence,
                                           "pagePath": urlparse(observed.url).path}
        except Exception:
            pass
        write_state(file, state)
        raise
    finally:
        await close_disposable_verification_page(editor)
        await close_disposable_verification_page(listing)
        await cleanup_saved_upload_tab(browser, payload, state, file)


async def verify_saved_article(page, payload, helpers, covers=None):
    from article_covers_v2 import verify_article_covers
    import base64
    frame = await article_editor(page)
    title = page.locator('[data-testid="news-title-input"] [contenteditable="true"]')
    await title.wait_for(state="visible", timeout=30000)
    image_urls = await verify_article_images(page, frame, payload["images"], helpers)
    expected = (await prepare_article(page, payload, image_urls))["snapshot"]
    actual = await article_snapshot(page)
    if (await title.inner_text()).strip() != payload["title"] or actual != expected:
        raise RuntimeError("已保存图文的标题、正文或配图与项目素材不一致，保持待核对")
    if covers:
        verified = await verify_article_covers(page, covers, helpers)
        return {"verification": "saved_title_body_images_three_covers", "images": len(image_urls),
                "textSha256": hashlib.sha256(actual["text"].encode()).hexdigest(), "coverMode": "three",
                "covers": [{"sha256": item["sha256"], "verification": "selected_source_and_preview"} for item in verified]}
    pixels = helpers._normalized_pixels(base64.b64encode(Path(payload["landscapePath"]).read_bytes()).decode())
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        covers = await displayed_article_covers(page)
        if len(covers) == 1:
            difference = helpers._pixel_difference(pixels, await helpers._cover_pixels(page, covers[0]))
            if difference["mae"] <= 3 and difference["rmse"] <= 5:
                return {"verification": "saved_title_body_images_cover", "images": len(image_urls),
                        "textSha256": hashlib.sha256(actual["text"].encode()).hexdigest(), "cover": difference}
        await asyncio.sleep(0.5)
    raise RuntimeError("已保存图文封面未能与项目原封面核对，保持待核对")


async def save_draft(page, payload, state, file, engine):
    if state.get("phase") == "saved":
        await cleanup_saved_upload_tab(page.context.browser, payload, state, file)
        return state["result"]
    if state.get("saveAttemptedAt") is not None:
        raise RuntimeError("之前已尝试保存但结果不明确，请人工核对草稿箱；禁止重复保存")
    if local_files(payload) != state["files"]:
        raise RuntimeError("上传后本地素材已变化，未保存")
    await verify_staged(page, payload, state, engine)
    if payload.get("target") == "baijiahao-video" and payload.get("tags"):
        metadata = await add_optional_topics(page, payload, state["details"]["metadata"])
        state["details"]["metadata"] = metadata
        write_state(file, state)
        topic = metadata.get("topicAttempt")
        if topic:
            progress("已选择话题：" + "、".join(topic["selectedLabels"]) if topic["selectedLabels"]
                     else "本次未添加话题，继续保存草稿", "metadata")
    notices = page.locator('[role="alert"],.cheetah-message-notice,.ant-message-notice,.toast,.message-success,.weui-desktop-toast')
    success = re.compile(r"草稿保存成功|保存草稿成功|已保存到草稿箱|保存成功|已保存")
    old = [text for text in await notices.all_text_contents() if success.search(text)]
    if old:
        raise RuntimeError("编辑页残留旧保存提示，请等待消失后再确认保存")
    button = await one_button(page, ("保存草稿", "存草稿"))
    checkpoint_progress(file, state, "save", "正在保存草稿，不会点击发布；结果不明确时不会重试")
    state["saveAttemptedAt"] = time.time()
    state["phase"] = "save_requested"
    write_state(file, state)
    await button.click()
    state["saveClickedAt"] = time.time()
    write_state(file, state)
    deadline = time.monotonic() + 40
    confirmed = False
    next_identity_check = 0
    while time.monotonic() < deadline:
        if payload["target"] == "tencent-video" and not confirmed:
            dialog = page.locator('.weui-desktop-dialog:visible').filter(has_text=re.compile(r"将此次编辑保留[?？]"))
            if await dialog.count() == 1:
                await (await one_button(dialog, ("保存",))).click()
                confirmed = True
        if payload["target"] == "tencent-video" and time.monotonic() >= next_identity_check:
            next_identity_check = time.monotonic() + 1
            if await remember_tencent_draft_id(page, payload, state, file):
                return await reconcile_saved_draft(page.context.browser, payload, state, file, engine)
        evidence = [text for text in await notices.all_text_contents() if success.search(text)]
        if evidence:
            # A toast is not the identity of the saved platform draft. Keep the
            # original save intent until its record has been verified read-only.
            state["saveNotice"] = evidence[0]
            write_state(file, state)
            return await reconcile_saved_draft(page.context.browser, payload, state, file, engine)
        await asyncio.sleep(0.25)
    if payload["target"] in EDITORS:
        checkpoint_progress(file, state, "reconcile", "未捕获保存提示，正在只读核对实际草稿；不会重复点击保存")
        return await reconcile_saved_draft(page.context.browser, payload, state, file, engine)
    raise RuntimeError("已尝试一次保存草稿，未获得明确成功提示；请人工核对，不会自动重试")


async def update_video_covers(request):
    """Replace only covers on the same unsubmitted video; never select video or save."""
    old, revised = request["payload"], request.get("revisedPayload")
    file = job_state_file(request)
    if (request.get("updateVideoCovers") is not True or not isinstance(revised, dict)
            or old.get("target") != "baijiahao-video" or not old.get("accountName") or not file.is_file()):
        raise RuntimeError("只能明确更新命名账号原视频编辑页的封面")
    mutable = {"landscapePath", "portraitPath", "fingerprint"}
    if ({k: v for k, v in old.items() if k not in mutable}
            != {k: v for k, v in revised.items() if k not in mutable}
            or not isinstance(revised.get("fingerprint"), str) or not revised["fingerprint"]):
        raise RuntimeError("更换封面不能改变原账号、视频、文案或发表设置")
    state = json.loads(file.read_text(encoding="utf-8"))
    if (not isinstance(state, dict) or state.get("phase") not in ("uploading", "staged")
            or any(state.get(key) is not None for key in ("saveAttemptedAt", "publishAttemptedAt"))
            or any((state.get("result") or {}).get(key) for key in ("saved", "published", "submitted"))
            or not isinstance(state.get("targetId"), str) or not re.fullmatch(r"[A-Fa-f0-9]+", state["targetId"])
            or not state.get("documentToken") or not re.fullmatch(r"[a-f0-9]{64}", state.get("accountCredentialDigest", ""))):
        raise RuntimeError("原视频已尝试保存或发表，或编辑页绑定不完整，不能更换封面")
    original_digest, revised_digest = payload_digest(old), payload_digest(revised)
    original_files, revised_files = local_files(old), local_files(revised)
    video_path = str(Path(old["videoPath"]).resolve(strict=True))
    new_paths = [str(Path(revised[key]).resolve(strict=True)) for key in ("landscapePath", "portraitPath")]
    if len(set(new_paths)) != 2 or any(value in original_files for value in new_paths):
        raise RuntimeError("新封面必须使用独立的版本文件，不能覆盖原视频或原封面")
    if state.get("pendingCoverRevision") not in (None, revised_digest):
        raise RuntimeError("原视频有另一版封面正在更新，请先完成原封面版本")
    directory = file.parent / "cover-revisions" / revised_digest
    revision_file = directory / "state.json"
    if directory.resolve() != file.parent.resolve() / "cover-revisions" / revised_digest or revision_file.is_symlink():
        raise RuntimeError("封面更新记录目录无效")
    revision = json.loads(revision_file.read_text(encoding="utf-8")) if revision_file.is_file() else None
    binding = {key: state[key] for key in ("targetId", "documentToken", "accountCredentialDigest")}
    if revision is not None and any(revision.get(key) != value for key, value in {
            "previousPayloadDigest": original_digest, "payloadDigest": revised_digest,
            "originalFiles": original_files, "files": revised_files, "binding": binding}.items()):
        raise RuntimeError("封面更新检查点与原任务或新图片不一致")
    if state.get("payloadDigest") == revised_digest:
        if (not revision or revision.get("phase") != "completed" or state.get("files") != revised_files
                or state.get("coverRevision", {}).get("revisionId") != revised_digest or not revision.get("receipt")):
            raise RuntimeError("新版封面缺少完整更新回执，不能重复替换")
        return revision["receipt"]
    if state.get("payloadDigest") != original_digest or state.get("files") != original_files:
        raise RuntimeError("原视频素材快照已变化，不能更换封面")
    details = state.get("details", {})
    original_media = details.get("media", {})
    metadata = details.get("metadata", {})
    video_digest = original_files[video_path]
    if (original_media.get("status") != "uploaded" or original_media.get("verification") != "blob_sha256"
            or original_media.get("video_fingerprint") != video_digest or not original_media.get("media_src")
            or draft_text(metadata.get("description", {}).get("value")) != draft_text(video_description(old, state))):
        raise RuntimeError("缺少原视频和完整文案的上传证据，不能更换封面")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if revision is None:
        revision = {"phase": "preparing", "previousPayloadDigest": original_digest, "payloadDigest": revised_digest,
                    "originalFiles": original_files, "files": revised_files, "binding": binding,
                    "originalState": json.loads(json.dumps(state)), "createdAt": time.time()}
        write_state(revision_file, revision)
    engine = load_engine()
    helpers, async_playwright = engine[3], engine[2]
    async with async_playwright() as playwright:
        browser = await connect_existing_account_browser(playwright, request["config"], old["accountName"], state["accountCredentialDigest"])
        if browser is None:
            raise RuntimeError("原视频账号浏览器已关闭，不能重新上传或更换封面")
        pages = [page for context in browser.contexts for page in context.pages if await page_id(page) == state["targetId"]]
        if len(pages) != 1:
            raise RuntimeError("找不到唯一的原视频编辑页，不能更换封面")
        page = pages[0]

        async def verify_video():
            await verify_document(page, old, state)
            media = await helpers.verify_upload(page, old["videoPath"], timeout=10)
            if (media.get("verification") != "blob_sha256" or media.get("video_fingerprint") != video_digest
                    or media.get("media_src") != original_media["media_src"]):
                raise RuntimeError("原编辑页视频已变化，不能更换封面")
            await helpers._verify_metadata(page, metadata)

        try:
            await verify_video()
            if revision.get("covers"):
                slots = await helpers._cover_slots(page)
                for kind in ("landscape", "portrait"):
                    previous = revision["covers"].get(kind, {})
                    if previous.get("status") == "uploaded" and slots[kind].get("src") != previous.get("preview"):
                        raise RuntimeError("已核验的新版封面预览发生变化，不能复用旧更新检查点")
            state["pendingCoverRevision"] = revised_digest
            write_state(file, state)  # Old resume/publish cannot restore old covers after an interruption.

            def checkpoint(covers):
                revision.update({"phase": "replacing", "covers": covers})
                write_state(revision_file, revision)

            covers = revision.get("covers") if revision.get("phase") == "completed" else await baijiahao_covers(
                page, revised, helpers, verified=revision.get("covers"), checkpoint=checkpoint)
            for kind, key in (("landscape", "landscapePath"), ("portrait", "portraitPath")):
                proof = (covers or {}).get(kind, {})
                digest = revised_files[str(Path(revised[key]).resolve(strict=True))]
                if (proof.get("status") != "uploaded" or proof.get("verification") != "source_and_preview"
                        or proof.get("fingerprint") != digest or proof.get("source_sha256_verified") != digest or not proof.get("preview")):
                    raise RuntimeError("新版横竖封面缺少源图及预览验证，尚未更新绑定")
            await helpers.verify_page(page, metadata, covers)
            slots = await helpers._cover_slots(page)
            if any(slots[kind].get("src") != covers[kind]["preview"] for kind in ("landscape", "portrait")):
                raise RuntimeError("当前封面预览与新版封面证据不一致，尚未更新绑定")
            await verify_video()
            await verify_baijiahao_fields(page, revised, details.get("settings"))
            if local_files(old) != original_files or local_files(revised) != revised_files:
                raise RuntimeError("更新过程中视频或封面文件发生变化，尚未更新绑定")
            result = {"staged": True, "saved": False, "published": False, "accountName": old["accountName"],
                      "editorUrl": page.url, "targetId": state["targetId"], "engine": "social-auto-upload/baijiahao-local-stage"}
            receipt = {"verification": "original_video_and_revised_covers", "revisionId": revised_digest,
                       "previousPayloadDigest": original_digest, "payloadDigest": revised_digest,
                       "videoSha256": video_digest, "landscapeSha256": revised_files[new_paths[0]],
                       "portraitSha256": revised_files[new_paths[1]], "targetId": state["targetId"], "result": result}
            revision.update({"phase": "completed", "covers": covers, "receipt": receipt, "completedAt": time.time()})
            revision.pop("error", None)
            write_state(revision_file, revision)
            updated = {**state, "phase": "staged", "payloadDigest": revised_digest, "files": revised_files,
                       "details": {**details, "covers": covers}, "result": result,
                       "coverRevision": {"revisionId": revised_digest, "previousPayloadDigest": original_digest,
                                         "completedAt": revision["completedAt"]}}
            updated.pop("pendingCoverRevision", None)
            updated.pop("error", None)
            checkpoint_progress(file, updated, "staged", "原视频已保留，新版横竖封面已核验，尚未保存或发表")
            return receipt
        except Exception as error:
            revision["error"] = str(error)[:1000]
            write_state(revision_file, revision)
            raise


def article_cover_revision_identity(payload, state):
    result = state.get("result", {}) if state else {}
    url = urlparse(result.get("draftUrl", ""))
    query = parse_qs(url.query)
    identifiers = query.get("article_id", [])
    if not state or payload.get("target") != "baijiahao-article" or state.get("phase") != "saved" or result.get("saved") is not True or result.get("published") is not False or url.scheme != "https" or url.hostname != "baijiahao.baidu.com" or url.path != "/builder/rc/edit" or url.username or url.password or query.get("type") != ["news"] or len(identifiers) != 1 or not identifiers[0].isdigit():
        raise RuntimeError("只能更新已核验保存的百家号图文原草稿封面，不会新建草稿")
    return identifiers[0]


def article_revision_draft_row(rows, title, draft_id):
    matches = []
    for row in rows:
        url = urlparse(row.get("url") or "")
        if url.scheme in ("http", "https") and url.hostname == "baijiahao.baidu.com" and not url.username and not url.password and url.path in ("/builder/preview/s", "/s") and parse_qs(url.query).get("id") == [draft_id]:
            matches.append(row)
    if len(matches) != 1:
        raise RuntimeError("平台未找到唯一原图文草稿，未更新封面或新建草稿")
    row = matches[0]
    if not row.get("draft"):
        raise RuntimeError("原图文已不是草稿（已发布或状态已变更），不会修改线上文章或另建重复草稿")
    if row.get("title") != title or row.get("video"):
        raise RuntimeError("平台原草稿与项目图文不一致，未更新封面")
    return row


async def verify_online_article_draft(browser, payload, draft_id):
    listing = await browser.contexts[0].new_page()
    try:
        return article_revision_draft_row(await search_baijiahao_items(listing, payload["title"]), payload["title"], draft_id)
    finally:
        await listing.close()


async def update_saved_article_covers(browser, payload, state, file, engine):
    draft_id = article_cover_revision_identity(payload, state)
    files = local_files(payload)
    if files != state["files"]:
        raise RuntimeError("原稿素材已变化，不能原地更新三图封面")
    directory = file.parent / "cover-three-v1"
    directory.mkdir(mode=0o700, exist_ok=True)
    revision_file = directory / "state.json"
    revision = json.loads(revision_file.read_text(encoding="utf-8")) if revision_file.exists() else {
        "phase": "preparing", "payloadDigest": payload_digest(payload), "files": files, "expectedDraftId": draft_id,
        "draftUrl": state["result"]["draftUrl"], "createdAt": time.time(),
        "originalSaveAttemptedAt": state.get("saveAttemptedAt"), "originalSaveEvidence": state.get("saveEvidence"),
    }
    if revision.get("payloadDigest") != payload_digest(payload) or revision.get("files") != files or revision.get("expectedDraftId") != draft_id:
        raise RuntimeError("三图封面更新记录与原草稿不一致，未继续")
    def finish(result):
        if revision.get("details", {}).get("covers"):
            state["details"]["covers"] = revision["details"]["covers"]
            state["coverRevision"] = {"mode": "three", "file": str(revision_file), "completedAt": time.time(), "saveEvidence": revision["saveEvidence"]}
            state["result"] = result
            write_state(file, state)
        return result
    if revision["phase"] == "saved":
        await cleanup_saved_upload_tab(browser, payload, revision, revision_file)
        return finish(revision["result"])
    write_state(revision_file, revision)
    try:
        await verify_online_article_draft(browser, payload, draft_id)
        if revision.get("saveAttemptedAt"):
            result = await reconcile_saved_draft(browser, payload, revision, revision_file, engine)
        else:
            targets = [page for context in browser.contexts for page in context.pages
                       if await page_id(page) == revision.get("targetId", state["result"]["targetId"])]
            if len(targets) > 1:
                raise RuntimeError("原草稿编辑页不唯一，未继续")
            if targets:
                page = targets[0]
                if parse_qs(urlparse(page.url).query).get("article_id") != [draft_id]:
                    raise RuntimeError("原编辑页已切换其他草稿，未覆盖")
            elif revision.get("documentToken"):
                raise RuntimeError("三图封面更新原页面已关闭，未重建或重复保存")
            else:
                page = await browser.contexts[0].new_page()
                await page.goto(revision["draftUrl"], wait_until="domcontentloaded", timeout=60000)
            if revision.get("documentToken"):
                await verify_document(page, payload, revision)
            else:
                revision["targetId"] = await page_id(page)
                revision["documentToken"] = secrets.token_hex(24)
                write_state(revision_file, revision)
                await page.evaluate("binding=>{window.name=binding.name;window.__huobaoSauDocumentToken=binding.token}",
                                    {"name": "huobao-sau-" + payload["jobId"], "token": revision["documentToken"]})
            if payload.get("accountName") not in HISTORY_ACCOUNTS:
                await page.bring_to_front()
            def checkpoint(details):
                checkpoint_details(revision_file, revision, details)
            details = await stage_article(page, payload, engine[3], reuse_upload=True, checkpoint=checkpoint, covers_only=True,
                                          previous=revision.get("details"))
            evidence = str(directory / "staged.png")
            await page.screenshot(path=evidence, full_page=True)
            revision.update({"phase": "staged", "details": details, "result": {
                **state["result"], "saved": False, "editorUrl": page.url, "targetId": revision["targetId"], "evidencePath": evidence}})
            write_state(revision_file, revision)
            await verify_online_article_draft(browser, payload, draft_id)
            result = await save_draft(page, payload, revision, revision_file, engine)
        return finish(result)
    except Exception as error:
        revision["error"] = str(error)
        write_state(revision_file, revision)
        raise


def can_resume_baijiahao_initialization(payload, state):
    return bool(state and payload["target"] == "baijiahao-video" and state.get("protocolVersion") == 3
                and state.get("phase") in ("initializing", "uploading")
                and not any(key in state for key in ("details", "result", "saveAttemptedAt", "fileSelectionStartedAt", "initializationReloadAttemptedAt")))


def baijiahao_initialization_timed_out(payload, state):
    error = str((state or {}).get("error", "")).replace("\\", "")
    return bool(can_resume_baijiahao_initialization(payload, state) and state.get("phase") == "initializing"
                and re.match(r"Locator\.wait_for: Timeout \d+ms exceeded\.", error)
                and 'input[type="file"][accept*="video"],input[type="file"][accept*="mp4"]' in error)


async def reload_baijiahao_initialization(page, payload, state, file, helpers):
    """A single reload is safe only before any file was selected, on our page."""
    if not baijiahao_initialization_timed_out(payload, state):
        raise RuntimeError("缺少未上传的初始化超时证明，不能重载编辑页")
    url = urlparse(page.url)
    if (url.scheme != "https" or url.hostname != "baijiahao.baidu.com" or url.path != "/builder/rc/edit"
            or url.username or url.password or parse_qs(url.query).get("type") != ["videoV2"]
            or "article_id" in parse_qs(url.query)):
        raise RuntimeError("原编辑页地址已变化，不能重载")
    if await page_id(page) != state.get("targetId"):
        raise RuntimeError("原编辑页编号已变化，不能重载")
    await verify_document(page, payload, state)
    await require_empty_baijiahao_video(page, helpers)
    state["initializationReloadAttemptedAt"] = time.time()
    checkpoint_progress(file, state, "opening", "已确认原编辑页未传入素材，正在单次重载上传控件")
    await page.reload(wait_until="domcontentloaded", timeout=60000)
    if await page_id(page) != state["targetId"]:
        raise RuntimeError("重载后编辑页编号已变化，未上传素材")
    state["documentToken"] = secrets.token_hex(24)
    await page.evaluate("binding=>{window.name=binding.name;window.__huobaoSauDocumentToken=binding.token}",
                       {"name": "huobao-sau-" + payload["jobId"], "token": state["documentToken"]})
    await verify_document(page, payload, state)
    await require_empty_baijiahao_video(page, helpers)
    checkpoint_progress(file, state, "opening", "原编辑页已重新绑定，继续首次传入素材")


def can_resume_tencent_initialization(payload, state):
    if not state or payload["target"] != "tencent-video":
        return False
    if any(state.get(key) for key in ("details", "result", "saveAttemptedAt", "fileSelectionStartedAt")):
        return False
    return (state.get("phase") == "initializing" and state.get("protocolVersion") == 2) or (
        state.get("phase") == "uploading" and state.get("error") == "Expected a unique initialized WeChat editor")


def can_resume_tencent_upload(payload, state):
    return bool(state and payload["target"] == "tencent-video" and state.get("phase") == "uploading"
                and state.get("protocolVersion") == 2 and state.get("fileSelectionStartedAt")
                and not any(state.get(key) for key in ("result", "saveAttemptedAt"))
                and (not state.get("details") or (isinstance(state["details"], dict)
                     and state["details"].get("engine") == "social-auto-upload/tencent-local-stage")))


def can_resume_article_initialization(payload, state):
    if not state or payload["target"] != "baijiahao-article":
        return False
    if any(state.get(key) for key in ("details", "result", "saveAttemptedAt", "fileSelectionStartedAt")):
        return False
    return (state.get("phase") == "initializing" and state.get("protocolVersion") == 3) or (
        state.get("phase") == "uploading" and state.get("protocolVersion") == 2 and state.get("error") == "coroutine raised StopIteration")


async def reload_blank_article_initialization(page, payload, state, file):
    """Recover a failed app load once, before this task has written any material."""
    if (not can_resume_article_initialization(payload, state) or not state.get("error")
            or state.get("articleInitializationReloadAttemptedAt")):
        return
    url = urlparse(page.url)
    if (url.scheme != "https" or url.hostname != "baijiahao.baidu.com" or url.path != "/builder/rc/edit"
            or parse_qs(url.query).get("type") != ["news"] or "article_id" in parse_qs(url.query)):
        return
    if await page_id(page) != state.get("targetId"):
        raise RuntimeError("原图文编辑页编号已变化，未重载")
    await verify_document(page, payload, state)
    blank = await page.evaluate("""() => !!document.body && !document.body.innerText.trim()
      && !document.querySelector('img,video,canvas')
      && ![...document.querySelectorAll('iframe')].some(e => e.getClientRects().length || e.getAttribute('src')
        || !e.contentDocument || e.contentDocument.body?.innerText.trim()
        || e.contentDocument.querySelector('input,textarea,[contenteditable],img,video,canvas,iframe'))
      && ![...document.querySelectorAll('input,textarea,[contenteditable]')].some(e=>e.value || e.textContent.trim())
      && !Object.values(window.UE_V2?.instants || {}).some(e=>e.isReady || e.body)""")
    if not blank:
        return
    state["articleInitializationReloadAttemptedAt"] = time.time()
    checkpoint_progress(file, state, "opening", "原图文编辑页加载空白且尚未写入素材，正在重新加载原页")
    await page.reload(wait_until="domcontentloaded", timeout=60000)
    if await page_id(page) != state["targetId"]:
        raise RuntimeError("重新加载后图文编辑页编号变化，未上传素材")
    state["documentToken"] = secrets.token_hex(24)
    await page.evaluate("binding=>{window.name=binding.name;window.__huobaoSauDocumentToken=binding.token}",
                       {"name": "huobao-sau-" + payload["jobId"], "token": state["documentToken"]})
    checkpoint_progress(file, state, "opening", "已重新加载原图文编辑页，继续首次上传素材")


async def has_foreign_article_cache(page, payload, state):
    """Identify images restored from shared cache before this job wrote anything."""
    if not can_resume_article_initialization(payload, state):
        return False
    url = urlparse(page.url)
    if (url.scheme != "https" or url.hostname != "baijiahao.baidu.com" or url.path != "/builder/rc/edit"
            or parse_qs(url.query).get("type") != ["news"] or "article_id" in parse_qs(url.query)):
        return False
    if await page_id(page) != state.get("targetId"):
        return False
    await verify_document(page, payload, state)
    title = page.locator('[data-testid="news-title-input"] [contenteditable="true"]')
    if await title.count() != 1 or (await title.inner_text()).strip():
        return False
    if not await page.evaluate("() => Object.values(window.UE_V2?.instants||{}).filter(e=>e.isReady&&e.body).length===1"):
        return False
    if await page.evaluate("() => !!Object.values(window.UE_V2.instants).find(e=>e.isReady&&e.body).body.querySelector('video,audio,iframe,object')"):
        return False
    current = await article_snapshot(page)
    if current["text"] or not current["images"]:
        return False
    return await page.evaluate(r"""images => {
      if([...document.querySelectorAll('input[type="file"]')].some(e=>e.files.length)) return false;
      for(const key of Object.keys(localStorage)) {
        if(!/^edit-[a-f0-9]+-news$/.test(key))continue;
        try {
          const cache=JSON.parse(localStorage.getItem(key));
          if(typeof cache?.content?.value!=='string')continue;
          const doc=new DOMParser().parseFromString(cache.content.value,'text/html');
          const cached=[...doc.images].map(e=>{
            const u=new URL(e.src);if(u.protocol==='http:'&&u.hostname==='baijiahao.baidu.com'&&u.pathname==='/bjh/picproxy')u.protocol='https:';
            return u.href;
          });
          if(cached.length===images.length&&cached.every((src,i)=>src===images[i]))return true;
        } catch {}
      }
      return false;
    }""", current["images"])


def can_resume_article_images(payload, state):
    return bool(state and payload["target"] == "baijiahao-article" and state.get("phase") == "uploading"
                and state.get("fileSelectionStartedAt") and not any(state.get(key) for key in ("result", "saveAttemptedAt"))
                and (not state.get("details") or (isinstance(state["details"], dict) and state["details"].get("article")
                     and state["details"].get("engine") == "huobao/baijiahao-article-extension")))


def can_restart_opening(payload, state):
    protocols = (2, 3) if payload["target"] == "baijiahao-video" else (3,) if payload["target"] == "baijiahao-article" else (2,)
    return bool(state and state.get("phase") == "opening"
                and (state.get("protocolVersion") in protocols or (state.get("protocolVersion") is None and state.get("error")))
                and not any(state.get(key) for key in ("details", "result", "saveAttemptedAt", "documentToken", "fileSelectionStartedAt")))


def job_state_file(request):
    payload = request["payload"]
    if not isinstance(payload, dict):
        raise ValueError("上传任务参数无效")
    job_id = payload.get("jobId")
    if payload.get("target") not in EDITORS or not isinstance(job_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", job_id):
        raise ValueError("上传任务编号或平台无效")
    if payload.get("accountName") is not None:
        validate_named_target(payload)
    root = Path(request["config"]["stateRoot"])
    directory = root / "jobs" / job_id
    if directory.resolve() != root.resolve() / "jobs" / job_id:
        raise ValueError("上传记录目录无效")
    file = directory / "state.json"
    if file.is_symlink():
        raise ValueError("上传记录不能是符号链接")
    return file


def checkpoint_result(payload, state):
    result = state.get("result")
    if not isinstance(result, dict) or result.get("staged") is not True or type(result.get("published")) is not bool or type(result.get("saved")) is not bool:
        return None
    if publication_mode(payload) == "publish":
        if result.get("submitted") is True:
            if not has_publication_identity(payload, result):
                return None
        elif result["published"] or result["saved"] or result.get("publicationStatus") or result.get("articleId"):
            return None
    elif result["published"] or result.get("submitted"):
        return None
    if payload.get("accountName") is not None and result.get("accountName") != payload["accountName"]:
        return None
    target = result.get("targetId")
    if not isinstance(target, str) or not re.fullmatch(r"[A-Fa-f0-9]+", target) or state.get("targetId", target) != target:
        return None
    if not isinstance(result.get("engine"), str) or not result["engine"]:
        return None
    try:
        url = urlparse(result["editorUrl"])
        host = "channels.weixin.qq.com" if payload["target"] == "tencent-video" else "baijiahao.baidu.com"
        if url.scheme != "https" or url.hostname != host or url.username or url.password or url.port not in (None, 443):
            return None
    except (KeyError, TypeError, ValueError):
        return None
    return result


def has_saved_draft_identity(payload, result):
    try:
        url = urlparse(result.get("draftUrl", ""))
        if url.scheme != "https" or url.username or url.password or url.port not in (None, 443) or url.fragment:
            return False
        if payload["target"] == "tencent-video":
            return url.hostname == "channels.weixin.qq.com" and url.path == "/platform/post/draftListManager" and not url.query
        query = parse_qs(url.query, keep_blank_values=True)
        ids = query.get("article_id", [])
        return (url.hostname == "baijiahao.baidu.com" and url.path == "/builder/rc/edit"
                and len(ids) == 1 and ids[0].isdigit()
                and (payload["target"] != "baijiahao-video" or query.get("type") == ["videoV2"]))
    except (ValueError, TypeError, AttributeError):
        return False


def inspect_checkpoint(request):
    """Recommend a next action from local evidence only; never alter the job."""
    phase, state = "unknown", None
    def response(action, message, result=None):
        value = {"action": action, "phase": phase, "message": message}
        if result is not None:
            value["result"] = result
        detail = state.get("progress") if isinstance(state, dict) else None
        if isinstance(detail, dict) and all(isinstance(detail.get(key), str) for key in ("step", "message")):
            value["progress"] = {key: detail[key] for key in ("step", "message")}
        return value
    try:
        file = job_state_file(request)
        payload = request["payload"]
        publishing = publication_mode(payload) == "publish"
        if not file.exists():
            if payload.get("accountName") in HISTORY_ACCOUNTS:
                account_storage(request["config"], payload["accountName"])
            if not local_files(payload):
                raise ValueError("上传素材尚未准备完成")
            phase = "new"
            return response("upload", "尚未开始上传，可以创建本任务的上传记录")
        state = json.loads(file.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            raise ValueError("上传记录格式无效")
        phase = state.get("phase") if isinstance(state.get("phase"), str) else "unknown"
        if state.get("payloadDigest") != payload_digest(payload) or not isinstance(state.get("files"), dict):
            raise ValueError("原任务内容或素材快照不一致，不能自动继续")
        if state.get("pendingCoverRevision"):
            return response("manual", "原视频正在更新封面，请继续同一封面版本；不会恢复旧封面或发表")
        protocols = (None, 2) if payload["target"] == "tencent-video" else (None, 2, 3)
        phases = ("opening", "initializing", "uploading", "staged", "publish_requested", "submitted", "published") if publishing else ("opening", "initializing", "uploading", "staged", "save_requested", "saved")
        if state.get("protocolVersion") not in protocols or phase not in phases:
            raise ValueError("上传记录阶段或协议无法识别")
        result = checkpoint_result(payload, state)
        if state.get("result") is not None and result is None:
            raise ValueError("原编辑页结果或绑定无效")
        if publishing and phase in ("submitted", "published"):
            if not result or not has_publication_identity(payload, result):
                raise ValueError("缺少可信的发表回执")
            return response("complete", "作品已提交百家号，无需重复发表", result)
        if phase == "saved":
            if not result or not result["saved"]:
                raise ValueError("缺少可信的草稿保存结果")
            if has_saved_draft_identity(payload, result):
                return response("complete", "草稿已保存，无需再次上传或保存", result)
            if not state.get("saveAttemptedAt"):
                raise ValueError("旧保存回执缺少草稿身份和保存时间，需要核对原任务")
            # Legacy saves sometimes recorded only a success toast. Continue
            # through the account and save-intent checks to obtain draft proof.
        if payload.get("accountName") is not None:
            _, digest = account_storage(request["config"], payload["accountName"])
            if state.get("accountCredentialDigest") and state["accountCredentialDigest"] != digest:
                raise ValueError("账号已重新登录，原上传会话身份已变化，请核对原草稿")
        if publishing and state.get("publishAttemptedAt") is not None:
            if type(state["publishAttemptedAt"]) not in (int, float) or state["publishAttemptedAt"] <= 0 or not result:
                raise ValueError("发表尝试记录无效，需要核对原任务")
            if missing_creation_declaration_rejection(payload, state):
                if local_files(payload) != state["files"]:
                    raise ValueError("原素材已变化，不能继续原编辑页")
                return response("save", "前次点击被创作声明校验阻止，补全声明后继续原视频，不会重新上传", result)
            return response("reconcile", "已记录发表意图，继续只读核对平台结果，不会重复发表", result)
        if state.get("saveAttemptedAt") is not None:
            if type(state["saveAttemptedAt"]) not in (int, float) or state["saveAttemptedAt"] <= 0:
                raise ValueError("保存尝试记录无效，需要人工核对")
            if not result:
                raise ValueError("已尝试保存，但原编辑页结果缺失，需要人工核对")
            return response("reconcile", "已尝试保存，继续只读核对草稿结果，不会重复保存", result)
        # Completion and read-only reconciliation use the original job snapshot.
        # Only a proposed editor write needs current local files to match here;
        # reconciliation checks the files its saved-media proof actually uses.
        if local_files(payload) != state["files"]:
            raise ValueError("原上传素材已变化，不能自动继续写入编辑页")
        details = state.get("details")
        expected_engine = {"baijiahao-video": "social-auto-upload/baijiahao-local-stage",
                           "tencent-video": "social-auto-upload/tencent-local-stage",
                           "baijiahao-article": "huobao/baijiahao-article-extension"}[payload["target"]]
        if details is not None and (not isinstance(details, dict) or (details and details.get("engine") != expected_engine)):
            raise ValueError("上传步骤记录无效，不能自动继续")
        bound = all(isinstance(state.get(key), str) and state[key] for key in ("targetId", "documentToken"))
        bound = bound and bool(re.fullmatch(r"[A-Fa-f0-9]+", state["targetId"]))
        if phase == "staged" and result and not result["saved"] and bound:
            return response("save", "内容已准备，继续发表原编辑页视频" if publishing else "内容已准备，继续保存原编辑页草稿", result)
        if can_restart_opening(payload, state):
            return response("resume", "尚未传入素材，继续原任务的编辑页初始化")
        if bound and not result and (can_resume_baijiahao_initialization(payload, state) or can_resume_tencent_initialization(payload, state)
                or can_resume_tencent_upload(payload, state) or can_resume_article_initialization(payload, state)
                or can_resume_article_images(payload, state)
                or (payload["target"] == "baijiahao-video" and phase == "uploading")):
            return response("resume", "继续原任务已记录的素材、文案或封面步骤")
        return response("manual", "当前检查点无法安全自动继续，请核对原编辑页")
    except (KeyError, TypeError, ValueError, OSError, RuntimeError) as error:
        return response("manual", f"上传检查点无法继续：{str(error)[:1000]}")


async def close_failed_upload_tab(browser, payload, state):
    result = state.get("result") if isinstance(state.get("result"), dict) else {}
    target = state.get("targetId") or result.get("targetId")
    if not target:
        return False
    for context in browser.contexts:
        for page in list(context.pages):
            if page.is_closed() or await page_id(page) != target:
                continue
            binding = await page.evaluate("() => ({name:window.name, token:window.__huobaoSauDocumentToken, href:location.href})")
            name = binding.get("name")
            initialized = bool(state.get("documentToken"))
            if name != "huobao-sau-" + payload["jobId"] and (name or initialized):
                return False
            if binding.get("token") is not None and binding["token"] != state.get("documentToken"):
                return False
            url = urlparse(binding.get("href", ""))
            expected = urlparse(EDITORS[payload["target"]])
            if binding.get("href") != "about:blank" and (url.scheme != "https" or url.hostname != expected.hostname):
                return False
            await page.close(run_before_unload=False)
            return True
    return False


def can_close_preselection_failure(state):
    """A page is disposable only before any material write or file selection."""
    return (isinstance(state, dict) and state.get("phase") in ("opening", "initializing")
            and not any(state.get(key) for key in ("fileSelectionStartedAt", "details", "result", "saveAttemptedAt", "publishAttemptedAt")))


async def close_preselection_failure(browser, payload, state, file):
    """Close a failed blank editor and idle its managed browser.

    Uploads that already selected a file or attempted a save keep their editor
    for checkpoint recovery. Closing those pages would turn a safe recovery
    into an unsafe duplicate upload.
    """
    if not can_close_preselection_failure(state):
        return False
    try:
        closed = await asyncio.wait_for(close_failed_upload_tab(browser, payload, state), timeout=4)
    except Exception:
        return False
    if not closed:
        return False
    state["editorClosedAt"] = time.time()
    state["progress"] = {"step": "opening", "message": "尚未传入素材；失败编辑页已关闭，继续时将重新打开空白页"}
    write_state(file, state)
    try:
        from account_browser import close_idle_account_browser
        await close_idle_account_browser(browser)
    except Exception:
        pass
    return True


async def finish_failed_attempt(request, *, reset=False):
    """Close a failed attempt; explicit retry archives it before a fresh upload.

    This runs under the original job/account locks, so a live writer cannot be
    discarded. It never resumes an editor, clicks save, or launches a browser.
    """
    config, payload = request["config"], request["payload"]
    file = job_state_file(request)
    publishing = publication_mode(payload) == "publish"
    allow_duplicate = reset and request.get("allowDuplicateSubmission") is True
    checkpoint_issue = None
    state = None
    if file.exists():
        try:
            state = json.loads(file.read_text())
        except (ValueError, TypeError):
            if publishing and not allow_duplicate:
                raise RuntimeError("发表记录无法读取，不能确认是否已提交；禁止自动重传")
            checkpoint_issue = "unreadable_checkpoint"
        if publishing and (not isinstance(state, dict) or state.get("phase") not in (
                "opening", "initializing", "uploading", "staged", "failed", "publish_requested", "submitted", "published")):
            if not allow_duplicate:
                raise RuntimeError("发表记录结构不完整，不能确认是否已提交；禁止自动重传")
            checkpoint_issue = checkpoint_issue or "invalid_checkpoint_structure"
    if isinstance(state, dict):
        if state.get("pendingCoverRevision"):
            raise RuntimeError("原视频封面更新尚未完成，禁止清理或重置原上传任务")
        if state.get("payloadDigest") and state["payloadDigest"] != payload_digest(payload):
            raise RuntimeError("上传记录与原任务不匹配，未清理；请重新读取任务后重试")
        result = checkpoint_result(payload, state)
        if publishing and result and has_publication_identity(payload, result):
            return {"result": result}
        if publishing and not allow_duplicate and (state.get("publishAttemptedAt")
                or state.get("phase") in ("publish_requested", "submitted", "published")):
            raise RuntimeError("本任务已尝试发表，结果尚待核对；禁止清理记录或重新上传，请继续只读核对")
        if state.get("phase") == "saved" and result and result.get("saved"):
            return {"result": result}
    if allow_duplicate and publishing and file.parent.exists():
        if payload.get("accountName"):
            raw_result = state.get("result") if isinstance(state, dict) else None
            if isinstance(raw_result, dict) and raw_result.get("accountName") not in (None, payload["accountName"]):
                raise RuntimeError("原上传结果与任务账号不匹配，不能重置上传记录")
            _, credential_digest = account_storage(config, payload["accountName"])
            if isinstance(state, dict) and state.get("accountCredentialDigest") not in (None, credential_digest):
                raise RuntimeError("账号凭据已变化，不能重置原上传记录")
        files = local_files(payload)
        if not files:
            raise RuntimeError("上传素材尚未准备完成，不能重置原上传记录")
        if isinstance(state, dict) and isinstance(state.get("files"), dict) and state["files"] != files:
            raise RuntimeError("原上传素材快照不匹配，不能重置上传记录")
    closed, cleanup_error = False, None
    raw_result = state.get("result") if isinstance(state, dict) else None
    if isinstance(state, dict) and (state.get("accountCredentialDigest") or state.get("targetId") or isinstance(raw_result, dict) and raw_result.get("targetId")):
        try:
            from account_browser import connect_existing_account_browser, close_idle_account_browser
            _, _, async_playwright, _, _, _ = load_engine()
            async with async_playwright() as playwright:
                if payload.get("accountName"):
                    browser = await connect_existing_account_browser(playwright, config, payload["accountName"], state.get("accountCredentialDigest"))
                else:
                    platform = "tencent" if payload["target"] == "tencent-video" else "baijiahao"
                    browser = await connect_platform_browser(playwright, config[platform], platform, config=config, cleanup_lock_held=True)
                if browser is not None:
                    try:
                        closed = await asyncio.wait_for(close_failed_upload_tab(browser, payload, state), timeout=8)
                    finally:
                        await close_idle_account_browser(browser)
        except Exception as error:
            cleanup_error = str(error)[:300]
    if isinstance(state, dict) and not reset:
        state["phase"] = "failed"
        state["attemptClosedAt"] = time.time()
        if cleanup_error:
            state["cleanupError"] = cleanup_error
        write_state(file, state)
    if reset and file.parent.exists():
        root = Path(config["stateRoot"]).resolve()
        history = root / "failed-attempts" / payload["jobId"]
        if history.resolve() != root / "failed-attempts" / payload["jobId"]:
            raise ValueError("失败上传记录目录无效")
        history.mkdir(parents=True, exist_ok=True, mode=0o700)
        archive = history / f"{time.time_ns()}-{secrets.token_hex(4)}"
        close_record = {"closedAt": time.time(), "closed": closed,
                        "reason": "explicit_duplicate_submission_retry" if allow_duplicate else "fresh_attempt_retry",
                        "allowDuplicateSubmission": allow_duplicate,
                        "originalPhase": state.get("phase") if isinstance(state, dict) else None,
                        "payloadDigest": payload_digest(payload)}
        if checkpoint_issue:
            close_record["checkpointIssue"] = checkpoint_issue
        if cleanup_error:
            close_record["cleanupError"] = cleanup_error
        write_state(file.parent / f"attempt-close-{secrets.token_hex(8)}.json", close_record)
        file.parent.rename(archive)
        return {"closed": closed, "archived": True}
    return {"closed": closed}


async def locked_action(request, action):
    try:
        job_state_file(request)
        config, payload = request["config"], request["payload"]
        publication_mode(payload)
        platform = "tencent" if payload["target"] == "tencent-video" else "baijiahao"
        account = payload.get("accountName")
        resources = [account_lock_key(platform, account)] if account is not None else []
        if account is None or account in HISTORY_ACCOUNTS:
            resources.append(browser_lock_key(config.get(platform, f"http://127.0.0.1:{9222 if platform == 'tencent' else 9225}")))
    except (KeyError, TypeError, ValueError, OSError) as error:
        if action == "checkpoint":
            return {"action": "manual", "phase": "invalid", "message": f"上传检查点无法继续：{str(error)[:1000]}"}
        raise
    try:
        with upload_locks(config, [*resources, f"job:{payload['jobId']}"]):
            if action == "checkpoint":
                return inspect_checkpoint(request)
            if action in ("close-failed", "reset-attempt"):
                return await finish_failed_attempt(request, reset=action == "reset-attempt")
            if action == "refresh-publication":
                return await refresh_publication(request)
            return await upload(request, action)
    except UploadLockBusy as error:
        if action == "checkpoint":
            return {"action": "busy", "phase": "busy", "message": str(error)}
        raise


async def upload(request, action, *, cleanup_browser=None):
    config = request["config"]
    payload = request["payload"]
    if action == "publish-saved":
        return await publish_saved_baijiahao_video(request)
    if action == "update-video-covers":
        return await update_video_covers(request)
    publishing = publication_mode(payload) == "publish"
    if (publishing and (action == "save" or request.get("saveDraft"))
            or not publishing and action in ("publish", "publish-preflight")):
        raise RuntimeError("发表与草稿任务模式不一致；未执行任何平台写入")
    file = job_state_file(request)
    directory = file.parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = json.loads(file.read_text(encoding="utf-8")) if file.exists() else None
    if state and state.get("pendingCoverRevision"):
        raise RuntimeError("原视频封面更新尚未完成，请继续同一封面版本；禁止恢复旧封面或发表")
    preserved_editor = None
    if state and state["payloadDigest"] != payload_digest(payload):
        raise RuntimeError("上传任务的素材快照已变化，不能复用旧记录")
    if publishing and state and state.get("phase") in ("submitted", "published"):
        result = checkpoint_result(payload, state)
        if not result or not has_publication_identity(payload, result):
            raise RuntimeError("已发表记录缺少可信回执，禁止重复发表")
        return result
    repair_declaration = action == "publish" and missing_creation_declaration_rejection(payload, state)
    if action == "repair-topic-description" and (not state or state.get("phase") != "staged"):
        raise RuntimeError("只能修复本任务尚未发表的原编辑页文案")
    if action in ("publish", "publish-preflight") and (not state or not repair_declaration and (state.get("phase") != "staged"
            or state.get("publishAttemptedAt") is not None) or (action == "publish" and request.get("confirmPublish") is not True)):
        raise RuntimeError("只能发表本任务已核验且尚未提交的原视频；已尝试发表时只能核对")
    if action == "resume" and state and state.get("publishAttemptedAt") is not None:
        raise RuntimeError("已尝试发表，只能只读核对；不会重传视频或重复发表")
    restart_opening = action == "resume" and can_restart_opening(payload, state)
    resume_baijiahao = action == "resume" and can_resume_baijiahao_initialization(payload, state)
    resume_tencent = action == "resume" and can_resume_tencent_initialization(payload, state)
    resume_tencent_upload = action == "resume" and can_resume_tencent_upload(payload, state)
    resume_article = action == "resume" and can_resume_article_initialization(payload, state)
    resume_article_images = action == "resume" and can_resume_article_images(payload, state)
    if action == "resume" and state and state.get("saveAttemptedAt") is not None:
        raise RuntimeError("已尝试保存，只能核对草稿结果；不会重传视频或重复保存")
    if action == "resume" and not restart_opening and not resume_baijiahao and not resume_tencent and not resume_tencent_upload and not resume_article and not resume_article_images and (not state or state.get("phase") != "uploading" or state.get("saveAttemptedAt") or payload["target"] != "baijiahao-video"):
        raise RuntimeError("只能继续尚未传入素材的失败页面，或已绑定的百家号视频封面；不会重传视频")
    if restart_opening and local_files(payload) != state["files"]:
        raise RuntimeError("原素材已变化，不能继续未开始的上传")
    if action == "update-article-covers":
        if request.get("updateSavedCovers") is not True:
            raise RuntimeError("未明确指定更新原草稿三图封面")
        article_cover_revision_identity(payload, state)
    if state and state.get("phase") == "saved" and action != "update-article-covers" and (action != "reconcile" or has_saved_draft_identity(payload, state.get("result", {}))):
        # Keep completed-job recovery local by default. Callers already holding
        # a connection may dispose the original tab without connecting again.
        if cleanup_browser is not None:
            await cleanup_saved_upload_tab(cleanup_browser, payload, state, file)
        return state["result"]
    if action == "stage" and state:
        if state.get("phase") == "staged" and not request.get("saveDraft"):
            return state["result"]
        raise RuntimeError("该任务已经尝试上传；请检查现有编辑页，禁止重复上传")
    if action == "save" and (not request.get("confirmSave") or not state or state.get("phase") != "staged"):
        raise RuntimeError("只能在明确确认后保存已核验的草稿")
    if action == "save" and state.get("saveAttemptedAt") is not None:
        raise RuntimeError("之前已尝试保存，请只读核对结果；禁止重复保存")
    if action == "reconcile" and (not state or not state.get("publishAttemptedAt" if publishing else "saveAttemptedAt") or not state.get("result")):
        raise RuntimeError("只有保存或发表结果不明的任务可以只读核对")
    if action in ("save", "resume", "publish", "publish-preflight", "repair-topic-description") and local_files(payload) != state["files"]:
        raise RuntimeError("原素材已变化，不能继续")
    if action == "reconcile":
        state["phase"] = "publish_requested" if publishing else "save_requested"
    if not state:
        state = {"phase": "opening", "protocolVersion": 2 if payload["target"] == "tencent-video" else 3,
                 "payloadDigest": payload_digest(payload), "files": local_files(payload)}
        checkpoint_progress(file, state, "opening", "已记录上传任务，正在连接平台编辑页")
    engine = load_engine()
    _, _, async_playwright, _, _, _ = engine
    platform = "tencent" if payload["target"] == "tencent-video" else "baijiahao"
    async with async_playwright() as playwright:
        browser, endpoint, account_digest = await connect_upload_browser(playwright, config, payload, state)
        if account_digest:
            state["accountCredentialDigest"] = account_digest
            write_state(file, state)
        if action == "update-article-covers":
            return await update_saved_article_covers(browser, payload, state, file, engine)
        if action == "reconcile":
            if publishing:
                return await reconcile_publication(browser, payload, state, file)
            return await reconcile_saved_draft(browser, payload, state, file, engine,
                                               repair_rejected_save=request.get("repairRejectedSave") is True)
        if resume_baijiahao or resume_article or resume_tencent:
            existing = [page for context in browser.contexts for page in context.pages
                        if await page_id(page) == state.get("targetId")]
            if len(existing) == 1 and resume_article and await has_foreign_article_cache(existing[0], payload, state):
                # This job has never selected a file or written content. Preserve
                # the cache-restored page; continue the same job in an isolated
                # new editor without clearing another draft or shared storage.
                backup = directory / "initialization-before-cache-isolation.json"
                write_state(backup, state)
                preserved_editor = {"targetId": state["targetId"], "checkpointPath": str(backup)}
                restart_opening = True
            if not existing:
                if (resume_baijiahao and baijiahao_initialization_timed_out(payload, state)
                        and not state.get("editorClosedAt")):
                    raise RuntimeError("初始化超时的原编辑页已关闭，不能核对原绑定；未新建草稿")
                # These checkpoints prove no file selection, content write or
                # save was attempted. A closed empty editor is safe to replace
                # within this same job; uploaded/staged pages never enter here.
                if local_files(payload) != state["files"]:
                    raise RuntimeError("原素材已变化，不能继续尚未开始的上传")
                checkpoint_progress(file, state, "opening", "原空白编辑页已关闭；确认尚未上传素材，正在为原任务重新打开编辑页")
                restart_opening = True
        if action in ("save", "resume", "publish", "publish-preflight", "repair-topic-description") and not restart_opening:
            target = state["result"]["targetId"] if action in ("save", "publish", "publish-preflight", "repair-topic-description") else state.get("targetId")
            pages = [page for context in browser.contexts for page in context.pages if await page_id(page) == target]
            if len(pages) != 1:
                raise RuntimeError("找不到本次上传的原编辑页，请人工核对；不会新建草稿")
            if payload.get("accountName") not in HISTORY_ACCOUNTS:
                await pages[0].bring_to_front()
            if action == "repair-topic-description":
                return await repair_optional_topic_description(pages[0], payload, state, file, engine,
                                                                request.get("expectedCurrentDescription"))
            if action == "save":
                return await save_draft(pages[0], payload, state, file, engine)
            if action == "publish-preflight":
                return await publication_preflight(pages[0], payload, state, engine)
            if action == "publish":
                if repair_declaration:
                    await repair_creation_declaration_rejection(pages[0], payload, state, file, engine)
                return await publish_video(pages[0], payload, state, file, engine)
            page = pages[0]
            await verify_document(page, payload, state)
            if local_files(payload) != state["files"]:
                raise RuntimeError("原素材已变化，不能继续")
            if resume_baijiahao or resume_tencent or resume_tencent_upload or resume_article or resume_article_images:
                def before_select():
                    state["phase"] = "uploading"
                    state["fileSelectionStartedAt"] = time.time()
                    checkpoint_progress(file, state, "media", "开始传入素材，已记录防重复上传检查点")
                def record_details(details):
                    checkpoint_details(file, state, details)
                def record_video_retry(retry):
                    state["videoRetry"] = retry
                    checkpoint_progress(file, state, "media", "明确网络失败，已记录原页同视频单次重传；尚未保存草稿")
                try:
                    if resume_baijiahao:
                        if baijiahao_initialization_timed_out(payload, state):
                            await reload_baijiahao_initialization(page, payload, state, file, engine[3])
                        else:
                            await require_empty_baijiahao_video(page, engine[3])
                        details = await stage_baijiahao_video(page, payload, endpoint, engine, record_details, before_select)
                    elif resume_tencent or resume_tencent_upload:
                        details = await stage_tencent_video(page, payload, endpoint, engine, before_select,
                                                           resume_tencent_upload, record_details, state.get("details"),
                                                           recovery_state=state, checkpoint_retry=record_video_retry)
                    else:
                        if resume_article:
                            await reload_blank_article_initialization(page, payload, state, file)
                        details = await stage_article(page, payload, engine[3], before_select, resume_article_images,
                                                      record_details, state.get("details"))
                except Exception as error:
                    state["error"] = str(error)
                    write_state(file, state)
                    try:
                        await page.screenshot(path=str(directory / "incomplete.png"), full_page=True)
                    except Exception:
                        pass
                    await close_preselection_failure(browser, payload, state, file)
                    raise
                evidence = str(directory / "staged.png")
                await page.screenshot(path=evidence, full_page=True)
                state["phase"] = "staged"
                state["details"] = details
                state.pop("error", None)
                state["result"] = {"staged": True, "saved": False, "published": False, "editorUrl": page.url,
                                   "targetId": target, "engine": details["engine"], "evidencePath": evidence}
                if payload.get("accountName") is not None:
                    state["result"]["accountName"] = payload["accountName"]
                checkpoint_progress(file, state, "staged", "内容与封面已准备完成，等待发表" if publishing else "内容与封面已准备完成，等待保存草稿")
                return state["result"]
            helpers = engine[3]
            previous = state.get("details", {}).get("media")
            recorded_covers = state.get("details", {}).get("covers") or {}
            covers = None
            source_before_covers = None
            def checkpoint_covers(covers):
                checkpoint_details(file, state, {**state.get("details", {}), "covers": covers})
            complete_cover_proofs = all(
                recorded_covers.get(kind, {}).get("source_sha256_verified")
                and recorded_covers[kind].get("fingerprint") == recorded_covers[kind]["source_sha256_verified"]
                for kind in ("landscape", "portrait"))
            if complete_cover_proofs:
                current_covers = await helpers._cover_slots(page)
                complete_cover_proofs = all(
                    current_covers.get(kind, {}).get("src")
                    and current_covers[kind]["src"] == recorded_covers[kind].get("preview")
                    for kind in ("landscape", "portrait"))
            if (state.get("details", {}).get("metadata") or recorded_covers) and not complete_cover_proofs:
                # Missing custom covers can prevent readiness; bind the original blob before changing them.
                live_media = await page.evaluate(helpers._READ_MEDIA)
                if helpers._classify_upload(live_media) == "failed":
                    raise RuntimeError("百家号提示视频上传或转码失败，不能继续封面步骤")
                videos = live_media.get("videos", [])
                if len(videos) != 1:
                    raise RuntimeError("原编辑页视频不唯一，不能继续封面步骤")
                source_before_covers = videos[0].get("src", "")
                if previous and source_before_covers != previous.get("media_src"):
                    raise RuntimeError("原编辑页视频已被替换，不能继续")
                if (not source_before_covers.startswith("blob:")
                        or videos[0].get("selected_src") not in (None, "", source_before_covers)):
                    raise RuntimeError("当前视频不能核对本地指纹，请人工检查；不会自动继续")
                local_digest = await asyncio.to_thread(helpers._file_digest, payload["videoPath"])
                if await helpers._browser_digest(page, source_before_covers) != local_digest:
                    raise RuntimeError("当前视频与本地文件指纹不一致，不能继续封面步骤")
                progress("原视频指纹已核对，正在继续缺失的横竖封面", "covers")
                covers = await baijiahao_covers(page, payload, helpers, recorded_covers, checkpoint_covers)
            checkpoint_progress(file, state, "media", "正在核对原编辑页视频指纹，不会重新上传视频")
            media = await helpers.verify_upload(page, payload["videoPath"], timeout=10)
            if media.get("verification") != "blob_sha256":
                raise RuntimeError("当前视频不能核对本地指纹，请人工检查；不会自动继续")
            if (previous and media["media_src"] != previous["media_src"]
                    or source_before_covers and media["media_src"] != source_before_covers):
                raise RuntimeError("原编辑页视频已被替换，不能继续")
            layout, fields = helpers._metadata_fields(await page.evaluate(helpers._READ_METADATA))
            metadata = {**state.get("details", {}).get("metadata", {}), "layout": layout}
            expected_description = video_description(payload, state)
            if layout == "videoV2":
                metadata["title"] = {"status": "source_only", "source_value": payload["title"]}
            for kind, field in fields.items():
                expected = expected_description if kind == "description" else payload[kind]
                matches = (draft_text(field["value"]) == draft_text(expected)
                           if kind == "description" and metadata.get("topicAttempt") else field["value"] == expected)
                if not matches:
                    raise RuntimeError("原编辑页文案已变化，不能继续")
                metadata[kind] = {"status": "filled", "value": field["value"]}
            checkpoint_details(file, state, {**state.get("details", {}), "media": media, "metadata": metadata,
                                              "engine": "social-auto-upload/baijiahao-local-stage"})
            await resume_baijiahao_creation_dialog(page, payload, state, helpers)
            progress("原视频与文案已核对，正在继续封面步骤", "covers")
            if covers is None:
                covers = await baijiahao_covers(page, payload, helpers, state.get("details", {}).get("covers"), checkpoint_covers)
            covers = await verify_baijiahao_page_after_covers(page, payload, helpers, metadata, covers,
                                                            checkpoint=checkpoint_covers)
            settings = await ensure_baijiahao_fields(page, payload)
            details = {"metadata": metadata, "media": media, "covers": covers, "engine": "social-auto-upload/baijiahao-local-stage",
                       **({"settings": settings} if settings else {})}
            evidence = str(directory / "staged.png")
            await page.screenshot(path=evidence, full_page=True)
            state["phase"] = "staged"
            state["details"] = details
            state["recoveredAt"] = time.time()
            state["result"] = {"staged": True, "saved": False, "published": False, "editorUrl": page.url,
                               "targetId": target, "engine": details["engine"], "evidencePath": evidence}
            if payload.get("accountName") is not None:
                state["result"]["accountName"] = payload["accountName"]
            checkpoint_progress(file, state, "staged", "内容与封面已准备完成，等待发表" if publishing else "内容与封面已准备完成，等待保存草稿")
            return state["result"]
        state = {"phase": "opening", "protocolVersion": 2 if payload["target"] == "tencent-video" else 3,
                 "payloadDigest": payload_digest(payload), "files": local_files(payload)}
        if preserved_editor:
            state["preservedEditor"] = preserved_editor
        if account_digest:
            state["accountCredentialDigest"] = account_digest
        checkpoint_progress(file, state, "opening", "正在打开独立编辑页，保留已有未保存内容")
        page = await browser.contexts[0].new_page()
        state["targetId"] = await page_id(page)
        write_state(file, state)
        try:
            progress("正在打开独立编辑页，保留已有未保存内容", "opening")
            if platform == "tencent":
                app = engine[1](title=payload["title"], file_path=payload["videoPath"], tags=[], publish_date=0,
                                account_file="unused-live-context.json", stage_only=True, cdp_url=endpoint)
                await app.open_upload_page(page)
            else:
                if payload["target"] == "baijiahao-article":
                    from article_storage import install_article_storage_isolation
                    await install_article_storage_isolation(page, payload["jobId"])
                elif payload["target"] == "baijiahao-video":
                    await install_video_storage_isolation(page, payload["jobId"])
                await page.goto(EDITORS[payload["target"]], wait_until="domcontentloaded", timeout=60000)
            state["documentToken"] = secrets.token_hex(24)
            await page.evaluate("binding=>{window.name=binding.name;window.__huobaoSauDocumentToken=binding.token}",
                                {"name": "huobao-sau-" + payload["jobId"], "token": state["documentToken"]})
            if payload.get("accountName") not in HISTORY_ACCOUNTS:
                await page.bring_to_front()
            state["phase"] = "initializing"
            state["protocolVersion"] = 2 if payload["target"] == "tencent-video" else 3
            checkpoint_progress(file, state, "opening", "原任务编辑页已绑定，正在初始化上传控件")
            def before_select():
                state["phase"] = "uploading"
                state["fileSelectionStartedAt"] = time.time()
                checkpoint_progress(file, state, "media", "开始传入素材，已记录防重复上传检查点")
            def record_details(details):
                checkpoint_details(file, state, details)
            if payload["target"] == "baijiahao-video":
                details = await stage_baijiahao_video(page, payload, endpoint, engine, record_details, before_select)
            elif payload["target"] == "tencent-video":
                details = await stage_tencent_video(page, payload, endpoint, engine, before_select,
                                                    checkpoint=record_details)
            else:
                details = await stage_article(page, payload, engine[3], before_select, checkpoint=record_details)
            state["details"] = details
            evidence = str(directory / "staged.png")
            await page.screenshot(path=evidence, full_page=True)
            state["phase"] = "staged"
            state["result"] = {"staged": True, "saved": False, "published": False, "editorUrl": page.url,
                               "targetId": state["targetId"], "engine": details["engine"], "evidencePath": evidence}
            if payload.get("accountName") is not None:
                state["result"]["accountName"] = payload["accountName"]
            checkpoint_progress(file, state, "staged", "内容与封面已准备完成，等待发表" if publishing else "内容与封面已准备完成，等待保存草稿")
            if request.get("saveDraft"):
                return await save_draft(page, payload, state, file, engine)
            return state["result"]
        except Exception as error:
            state["error"] = str(error)
            write_state(file, state)
            try:
                await page.screenshot(path=str(directory / "incomplete.png"), full_page=True)
            except Exception:
                pass
            await close_preselection_failure(browser, payload, state, file)
            raise
        # Uncertain/staged editors stay open; verified saves clean their own tab.


async def main():
    request = json.load(sys.stdin)
    action = sys.argv[1]
    if action == "inspect":
        result = await runtime(request["config"])
    elif action == "inspect-history":
        result = await inspect_history(request["config"])
    elif action == "sync-history":
        result = await sync_history(request["config"], request["platform"])
    elif action == "inspect-account":
        result = await account_runtime(request["config"], request["accountName"], keep_browser=request.get("keepBrowser") is True)
    elif action == "open":
        result = await open_login(request["config"], request["platform"])
    elif action == "review-session":
        from review_session import review_session
        result = await review_session(request, sys.modules[__name__])
    elif action == "focus":
        if request["payload"].get("accountName") is not None:
            raise ValueError("该账号使用后台上传，请通过草稿链接在对应平台查看结果")
        platform = "tencent" if request["payload"]["target"] == "tencent-video" else "baijiahao"
        _, _, async_playwright, _, _, _ = load_engine()
        async with async_playwright() as playwright:
            browser = await connect_platform_browser(playwright, request["config"][platform], platform, config=request["config"])
            result = request["result"]
            draft_url = result.get("draftUrl") or result.get("editorUrl", "")
            parsed = urlparse(draft_url)
            draft_ids = parse_qs(parsed.query).get("article_id", [])
            bai_draft = parsed.hostname == "baijiahao.baidu.com" and parsed.path == "/builder/rc/edit" and len(draft_ids) == 1 and draft_ids[0].isdigit()
            tencent_draft = parsed.hostname == "channels.weixin.qq.com" and parsed.path == "/platform/post/draftListManager" and not parsed.query
            if result.get("saved") and parsed.scheme == "https" and (bai_draft or tencent_draft) and not parsed.username and not parsed.password:
                page = await browser.contexts[0].new_page()
                await page.goto(draft_url, wait_until="domcontentloaded", timeout=30000)
                await page.bring_to_front()
                emit("RESULT", {"opened": True})
                return
            pages = [page for context in browser.contexts for page in context.pages if await page_id(page) == request["result"]["targetId"]]
            if len(pages) != 1:
                raise RuntimeError("原上传编辑页已关闭；请在平台后台核对草稿，不会重新上传")
            await pages[0].bring_to_front()
        result = {"opened": True}
    elif action in ("stage", "save", "publish", "publish-preflight", "publish-saved", "resume", "reconcile", "refresh-publication", "update-article-covers", "update-video-covers", "repair-topic-description", "checkpoint", "close-failed", "reset-attempt"):
        result = await locked_action(request, action)
    else:
        raise ValueError("不支持的上传操作")
    emit("RESULT", result)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        emit("ERROR", {"message": str(error)[:1200]})
        raise SystemExit(1)
