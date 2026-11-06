"""History-only background credentials, imported from the dedicated visible CDP.

Visible contexts are read only. A new credential generation is validated in its
own persistent headless Chrome before atomically becoming the active session.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
from urllib.parse import urlparse
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from account_browser import AccountBrowserConnectionError, close_idle_account_browser, connect_account_browser, history_storage_file, write_private
from upload_locks import UploadLockBusy, account_lock_key, browser_lock_key, upload_locks


HOMES = {"baijiahao": "https://baijiahao.baidu.com/builder/rc/home",
         "tencent": "https://channels.weixin.qq.com/platform"}
HOSTS = {"baijiahao": ("baijiahao.baidu.com", "passport.baidu.com"),
         "tencent": ("channels.weixin.qq.com", "open.weixin.qq.com")}
LABELS = {"baijiahao": "百家号", "tencent": "视频号"}
BACKGROUND_CHECK_TIMEOUT = 45


class HistorySessionError(RuntimeError):
    def __init__(self, message, issue="check_failed"):
        super().__init__(message)
        self.issue = issue


def platform_state(platform, *, ready=False, message, issue=None):
    result = {"ready": ready, "message": message, "sessionMode": "background", "accountName": f"history_{platform}"}
    if issue:
        result["issue"] = issue
    return result


@contextmanager
def session_lock(config, platform, *, sync=False):
    file = history_storage_file(config, platform)
    root = Path(config["stateRoot"]).resolve()
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    os.chmod(file.parent, 0o700)
    resources = [account_lock_key(platform, f"history_{platform}")]
    # Synchronization reads the visible login as well as replacing the named
    # account's credentials. Protect both sessions without locking other users.
    if sync or not file.exists():
        resources.append(browser_lock_key(config[platform]))
    try:
        with upload_locks(config, resources):
            fd = os.open(file.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "a") as lock:
                os.fchmod(lock.fileno(), 0o600)
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                yield file
    except (UploadLockBusy, BlockingIOError):
        raise HistorySessionError("该账号的上传或登录同步正在运行，请完成后重新检查或同步；本次未改变账号") from None


def filter_storage(storage, platform):
    hosts = HOSTS[platform]
    if not isinstance(storage, dict) or not isinstance(storage.get("cookies"), list) or not isinstance(storage.get("origins", []), list):
        raise HistorySessionError("专用 Chrome 登录数据无法读取，请登录后重新同步")
    cookies, origins = [], []
    for cookie in storage["cookies"]:
        domain = str(cookie.get("domain", "")).lstrip(".").lower() if isinstance(cookie, dict) else ""
        if domain and any(host == domain or host.endswith("." + domain) for host in hosts):
            cookies.append(cookie)
    for item in storage.get("origins", []):
        if not isinstance(item, dict):
            continue
        try:
            url = urlparse(item.get("origin", ""))
            if (url.scheme == "https" and url.hostname in hosts and not url.username and not url.password
                    and url.port in (None, 443) and url.path in ("", "/") and not url.query and not url.fragment):
                origins.append(item)
        except (TypeError, ValueError):
            continue
    # A fresh generation also isolates explicit sync when the visible cookies
    # happen to equal the old snapshot but its running Chrome has lost login.
    return {"cookies": cookies, "origins": origins, "historySessionId": secrets.token_hex(16)}


async def read_visible_storage_snapshot(endpoint, platform):
    process = await asyncio.create_subprocess_exec(
        "node", str(Path(__file__).with_name("visible_storage.mjs")), endpoint, platform,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=12)
        if process.returncode or len(output) > 8 * 1024 * 1024:
            raise RuntimeError("Visible browser login snapshot failed")
        return json.loads(output)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def read_visible_storage(playwright, config, platform, connect_visible):
    try:
        browser = await asyncio.wait_for(connect_visible(playwright, config[platform], platform), timeout=12)
        if len(browser.contexts) != 1:
            raise HistorySessionError("专用 Chrome 会话不唯一，请确认原账号登录后重新同步")
        storage = await asyncio.wait_for(browser.contexts[0].storage_state(), timeout=5)
        return filter_storage(storage, platform)
    except HistorySessionError:
        raise
    except Exception as error:
        issue = getattr(error, "issue", "connection_failed")
        if issue == "connection_failed":
            try:
                return filter_storage(await read_visible_storage_snapshot(config[platform], platform), platform)
            except Exception:
                pass
        raise HistorySessionError(f"无法读取原{LABELS[platform]}专用 Chrome 登录；请打开原专用 Chrome 完成登录后同步到后台", issue) from None


async def check_background_login(browser, platform, login_state):
    """Only create/close our headless probe; never touch an existing editor."""
    page = None
    try:
        async with asyncio.timeout(BACKGROUND_CHECK_TIMEOUT):
            page = await browser.contexts[0].new_page()
            await page.goto(HOMES[platform], wait_until="commit", timeout=12000)
            # Home apps may remain blank for 10+ seconds after HTTP commit.
            # Use the enclosing deadline rather than exhausting fast probes.
            while True:
                try:
                    state = await asyncio.wait_for(login_state(page, platform), timeout=3)
                except TimeoutError:
                    continue
                except Exception as error:
                    if not re.search(r"Execution context was destroyed|Cannot find context with specified id", str(error)):
                        raise
                    await asyncio.sleep(0.25)
                    continue
                if state["ready"]:
                    return platform_state(platform, ready=True, message=f"历史{LABELS[platform]}账号已登录，后台连接已就绪")
                issue = state.get("issue")
                if issue in ("login_required", "verification_required"):
                    instruction = "完成登录和安全验证" if issue == "verification_required" else "重新登录"
                    raise HistorySessionError(f"历史{LABELS[platform]}后台需要{instruction}；请在原专用 Chrome {instruction}后同步登录到后台", issue)
                await asyncio.sleep(0.5)
    except (TimeoutError, PlaywrightTimeoutError):
        raise HistorySessionError(f"历史{LABELS[platform]}后台连接或检查超时，请重试检查", "connection_failed") from None
    finally:
        if page is not None:
            try:
                await asyncio.wait_for(page.close(), timeout=2)
            except Exception:
                pass


async def import_session(playwright, config, platform, file, *, connect_visible, login_state, reuse_candidate=False):
    # A failed cold-page check must not create another Chrome on every inspect.
    # This private candidate is never read by account_storage or upload jobs.
    candidate = file.with_suffix(".candidate.json")
    if candidate.is_symlink():
        raise HistorySessionError("历史后台候选登录文件路径无效，请检查 history-sessions 目录后重新同步")
    if reuse_candidate and candidate.exists():
        try:
            if candidate.stat().st_size > 8 * 1024 * 1024:
                raise ValueError()
            os.chmod(candidate, 0o600)
            storage = json.loads(candidate.read_text())
            if (not isinstance(storage, dict) or not isinstance(storage.get("cookies"), list)
                    or not isinstance(storage.get("origins"), list)
                    or not isinstance(storage.get("historySessionId"), str)):
                raise ValueError()
        except (ValueError, TypeError):
            raise HistorySessionError("历史后台候选登录文件无效，请从原专用 Chrome 显式同步登录") from None
    else:
        storage = await read_visible_storage(playwright, config, platform, connect_visible)
        write_private(candidate, storage)
    browser, _, _ = await connect_account_browser(playwright, config, f"history_{platform}", candidate_storage=storage)
    try:
        result = await check_background_login(browser, platform, login_state)
        write_private(file, storage)
        try:
            candidate.unlink(missing_ok=True)
        except OSError:
            pass  # A verified active session takes precedence over a stale candidate.
        return result
    finally:
        await close_idle_account_browser(browser)


async def inspect_platform(playwright, config, platform, *, connect_visible, login_state):
    try:
        with session_lock(config, platform) as file:
            if not file.exists():
                return await import_session(playwright, config, platform, file, connect_visible=connect_visible,
                                            login_state=login_state, reuse_candidate=True)
            browser, _, _ = await connect_account_browser(playwright, config, f"history_{platform}")
            try:
                return await check_background_login(browser, platform, login_state)
            finally:
                await close_idle_account_browser(browser)
    except HistorySessionError as error:
        return platform_state(platform, message=str(error), issue=error.issue)
    except AccountBrowserConnectionError as error:
        return platform_state(platform, message=str(error), issue=error.issue)
    except (ValueError, RuntimeError) as error:
        return platform_state(platform, message=f"{str(error)[:300]}；请重试检查", issue="check_failed")
    except Exception:
        return platform_state(platform, message=f"历史{LABELS[platform]}后台检查暂未完成，请重试检查；尚不能判断登录失效，原登录已保留", issue="check_failed")


async def sync_platform(playwright, config, platform, *, connect_visible, login_state):
    with session_lock(config, platform, sync=True) as file:
        await import_session(playwright, config, platform, file, connect_visible=connect_visible, login_state=login_state)
    return {"synced": True, "platform": platform, "message": f"已同步原专用 Chrome 的{LABELS[platform]}登录，并验证后台登录成功"}
