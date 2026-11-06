"""Managed headless Chrome sessions with persistent profiles for SAU accounts.

An unfinished editor keeps its process available for checkpoint recovery. Idle
history browsers exit while their profile and refreshed login remain on disk.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.request import urlopen


HISTORY_ACCOUNTS = {"history_baijiahao": "baijiahao", "history_tencent": "tencent"}

# Upload verification never needs audible playback. The launch flag covers all
# audio (including WebAudio); this guard also quiets pre-existing browsers that
# must keep unfinished editor tabs and therefore cannot yet be restarted.
SILENT_MEDIA_SCRIPT = """(() => {
  if (window.__huobaoSilentUpload) return;
  window.__huobaoSilentUpload = true;
  const quiet = media => {media.muted = true; media.defaultMuted = true; media.volume = 0;};
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {quiet(this); return play.apply(this, args);};
  document.addEventListener('play', event => {
    if (event.target instanceof HTMLMediaElement) quiet(event.target);
  }, true);
})();"""

SILENCE_EXISTING_MEDIA = """elements => elements.forEach(media => {
  const quiet = () => {media.muted = true; media.defaultMuted = true; media.volume = 0;};
  quiet();
  if (!media.__huobaoQuietPlayback) {
    media.__huobaoQuietPlayback = true;
    media.addEventListener('play', quiet);
  }
})"""


async def silence_account_browser(browser):
    for context in browser.contexts:
        try:
            await asyncio.wait_for(context.add_init_script(script=SILENT_MEDIA_SCRIPT), timeout=2)
        except Exception:
            pass
        for page in list(context.pages):
            try:
                await asyncio.wait_for(page.evaluate(SILENT_MEDIA_SCRIPT), timeout=2)
                # Playwright locators include media inside the platform's
                # shadow DOM, unlike document.querySelectorAll alone.
                await asyncio.wait_for(page.locator('video,audio').evaluate_all(SILENCE_EXISTING_MEDIA), timeout=2)
            except Exception:
                pass  # A closing tab must not interrupt the original upload.


class AccountBrowserConnectionError(RuntimeError):
    issue = "connection_failed"


async def cleanup_stale_baijiahao_pages(config, endpoint, *, account_name=None):
    request = {"endpoint": endpoint, "stateRoot": config["stateRoot"], "platform": "baijiahao"}
    if account_name is not None:
        request["accountName"] = account_name
    process = await asyncio.create_subprocess_exec(
        "node", str(Path(__file__).with_name("stale_pages.mjs")),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        output, _ = await asyncio.wait_for(process.communicate(json.dumps(request).encode()), timeout=12)
        if process.returncode != 0 or len(output) > 256 * 1024:
            raise ValueError("cleanup failed")
        result = json.loads(output)
        if not isinstance(result, dict) or not isinstance(result.get("closedTargetIds"), list):
            raise ValueError("invalid cleanup result")
        return result
    except (TimeoutError, ValueError) as error:
        raise AccountBrowserConnectionError("百家号旧页面清理未完成，请重试连接；原登录和上传检查点已保留") from error
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def connect_managed_cdp(playwright, endpoint, browser_path):
    # The verified DevToolsActivePort gives the exact websocket. Attaching also
    # initializes existing draft tabs; a healthy logged-in browser can need
    # more than 15 seconds under load. Retry only this read-only connection.
    websocket = endpoint.replace("http:", "ws:") + browser_path
    for attempt, timeout in enumerate((40000, 10000)):
        try:
            return await playwright.chromium.connect_over_cdp(websocket, timeout=timeout, is_local=True)
        except Exception as error:
            transient = isinstance(error, TimeoutError) or re.search(
                r"timeout|timed out|connection closed|websocket.*closed|target.*closed", str(error), re.I)
            if transient and attempt == 0:
                await asyncio.sleep(0.25)
                continue
            raise AccountBrowserConnectionError(
                "后台浏览器连接失败或响应超时，尚未检查登录状态；已保留原登录，请重试连接") from error


def history_storage_file(config, platform):
    if platform not in HISTORY_ACCOUNTS.values():
        raise ValueError("不支持的历史上传平台")
    root = Path(config["stateRoot"]).resolve()
    file = root / "history-sessions" / f"{platform}.json"
    if file.is_symlink() or file.resolve() != root / "history-sessions" / file.name:
        raise ValueError("历史后台登录文件路径无效，请检查 history-sessions 目录")
    return file


def validate_account_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", value):
        raise ValueError("百家号账号编号无效")
    return value


def account_storage(config, account_name):
    name = validate_account_name(account_name)
    platform = HISTORY_ACCOUNTS.get(name)
    if platform:
        file = history_storage_file(config, platform)
    else:
        root = Path(config["root"]).resolve()
        file = root / "cookies" / f"baijiahao_{name}.json"
        if file.is_symlink() or file.resolve() != root / "cookies" / file.name:
            raise ValueError("百家号登录文件路径无效")
    if not file.is_file():
        if platform:
            raise RuntimeError("历史后台尚未登录，请先在原专用 Chrome 登录，再同步登录到后台")
        raise RuntimeError("该百家号账号尚未登录，请在“百家号账号”中扫码登录")
    if platform:
        os.chmod(file.parent, 0o700)
        os.chmod(file, 0o600)
    invalid = "历史后台登录文件无效，请在原专用 Chrome 登录后重新同步" if platform else "百家号登录文件无效，请重新登录"
    if file.stat().st_size > 8 * 1024 * 1024:
        raise ValueError(invalid)
    content = file.read_bytes()
    try:
        storage = json.loads(content)
        if not isinstance(storage, dict) or not isinstance(storage.get("cookies"), list) or not isinstance(storage.get("origins", []), list):
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError(invalid) from None
    return storage, hashlib.sha256(content).hexdigest()


def write_private(file, value):
    fd, name = tempfile.mkstemp(prefix=f".{file.name}.", dir=file.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream)
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def alive(pid):
    if type(pid) is not int or pid < 2:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def endpoint_from_profile(profile):
    file = profile / "DevToolsActivePort"
    if file.is_symlink():
        raise RuntimeError("账号后台会话端口文件无效")
    lines = file.read_text().splitlines()
    if len(lines) != 2 or not lines[0].isdigit() or not 1024 <= int(lines[0]) <= 65535 or not re.fullmatch(r"/devtools/browser/[a-fA-F0-9-]+", lines[1]):
        raise RuntimeError("账号后台会话地址无效")
    return f"http://127.0.0.1:{lines[0]}", lines[1]


def endpoint_matches(endpoint, browser_path):
    try:
        with urlopen(endpoint + "/json/version", timeout=1) as response:
            value = json.load(response)
        return value.get("webSocketDebuggerUrl") == endpoint.replace("http:", "ws:") + browser_path
    except (OSError, ValueError):
        return False


def session_directory(config, name, digest):
    root = Path(config["stateRoot"]).resolve()
    directory = root / "account-browsers" / name / digest
    if directory.resolve() != root / "account-browsers" / name / digest:
        raise ValueError("百家号账号后台目录无效")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if name in HISTORY_ACCOUNTS:
        for path in (root, root / "account-browsers", directory.parent, directory):
            os.chmod(path, 0o700)
    return directory


async def connect_account_browser(playwright, config, account_name, expected_digest=None, *, candidate_storage=None):
    name = validate_account_name(account_name)
    if candidate_storage is None:
        storage, digest = account_storage(config, name)
    else:
        if name not in HISTORY_ACCOUNTS:
            raise ValueError("只有历史专用账号允许验证待同步的登录")
        storage = candidate_storage
        digest = hashlib.sha256(json.dumps(storage).encode()).hexdigest()
    if expected_digest and expected_digest != digest:
        raise RuntimeError("该账号已重新登录，原上传会话身份已变化；请核对原草稿，未重复上传")
    directory = session_directory(config, name, digest)
    profile = directory / "profile"
    profile.mkdir(mode=0o700, exist_ok=True)
    state_file = directory / "session.json"
    if state_file.is_symlink() or profile.is_symlink():
        raise RuntimeError("账号后台会话目录无效")
    if name in HISTORY_ACCOUNTS:
        os.chmod(profile, 0o700)
        if (directory / "session.lock").is_symlink():
            raise RuntimeError("历史账号后台会话锁路径无效")
    with (directory / "session.lock").open("a") as lock:
        if name in HISTORY_ACCOUNTS:
            os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("该账号后台正在连接，请稍后重试") from None
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        pid = state.get("pid")
        running = alive(pid)
        fresh = not running
        if not fresh and (state.get("accountName") != name or state.get("credentialDigest") != digest):
            raise RuntimeError("账号后台会话绑定无效，未操作平台")
        initialized = (state.get("accountName") == name and state.get("credentialDigest") == digest
                       and state.get("initialized") is True)
        startup_error = "端口未就绪"
        for startup_attempt in range(2):
            child = None
            if fresh:
                from conf import LOCAL_CHROME_PATH
                executable = LOCAL_CHROME_PATH or playwright.chromium.executable_path
                if not Path(executable).is_file():
                    raise RuntimeError("未找到 SAU 使用的 Chrome，请检查本地安装")
                active_port = profile / "DevToolsActivePort"
                if active_port.exists():
                    active_port.unlink()
                child_options = {"umask": 0o077} if name in HISTORY_ACCOUNTS else {}
                # Keep startup diagnostics privately; throwing stderr away made
                # an exited Chrome indistinguishable from an expired login.
                log_file = directory / "chrome-startup.log"
                if log_file.is_symlink():
                    raise RuntimeError("账号后台启动日志路径无效")
                with log_file.open("wb") as startup_log:
                    os.fchmod(startup_log.fileno(), 0o600)
                    child = subprocess.Popen([
                        executable, "--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
                        f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--disable-sync",
                        "--disable-background-timer-throttling", "--mute-audio", "--window-size=1440,1000", "about:blank",
                    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=startup_log,
                        start_new_session=True, close_fds=True, **child_options)
                pid = child.pid
                state = {"pid": pid, "accountName": name, "credentialDigest": digest, "initialized": initialized}
                write_private(state_file, state)
            deadline = time.monotonic() + 15
            connected = False
            exited = False
            while True:
                try:
                    endpoint, browser_path = endpoint_from_profile(profile)
                    if await asyncio.to_thread(endpoint_matches, endpoint, browser_path):
                        connected = True
                        break
                except (OSError, ValueError):
                    pass
                poll = getattr(child, "poll", None)
                exit_code = poll() if callable(poll) else None
                exited = type(exit_code) is int or not alive(pid)
                if time.monotonic() >= deadline or exited:
                    startup_error = f"Chrome 退出（{exit_code}）" if type(exit_code) is int else (
                        "Chrome 已退出" if exited else "Chrome 调试端口未就绪")
                    break
                await asyncio.sleep(0.2)
            if connected:
                break
            if startup_attempt == 0 and exited:
                # Retry startup only after the old process has actually exited.
                # No page or media exists yet; do not reset cookies or profile.
                fresh = True
                await asyncio.sleep(0.3)
                continue
            state["startupFailure"] = {"message": startup_error, "at": time.time()}
            write_private(state_file, state)
            raise RuntimeError(f"后台浏览器启动失败：{startup_error}；原登录资料已保留，请重新上传")
        if HISTORY_ACCOUNTS.get(name, "baijiahao") == "baijiahao":
            await cleanup_stale_baijiahao_pages(config, endpoint, account_name=name)
        browser = await connect_managed_cdp(playwright, endpoint, browser_path)
        if not browser.contexts:
            raise RuntimeError("历史账号后台会话未就绪，请重新检查" if name in HISTORY_ACCOUNTS
                               else "百家号账号后台会话未就绪，请重新检查")
        if fresh or not state.get("initialized"):
            context = browser.contexts[0]
            # The persistent profile retains refreshed login cookies. Reopening
            # an idle browser must not overwrite them with the old import.
            if not state.get("initialized"):
                await context.add_cookies(storage["cookies"])
            # Storage state from SAU may include localStorage as well as cookies.
            # The init script belongs to this live context and persists across
            # bridge disconnections; it is restored when Chrome is restarted.
            await context.add_init_script(script="""(() => {
              const origins = %s;
              for (const item of origins) if (location.origin === item.origin) {
                for (const entry of item.localStorage || []) {
                  if (localStorage.getItem(entry.name) === null) localStorage.setItem(entry.name, entry.value);
                }
              }
            })();""" % json.dumps(storage.get("origins", []), ensure_ascii=True))
            state["initialized"] = True
            write_private(state_file, state)
        browser._huobao_managed_session = {"directory": directory, "pid": pid, "accountName": name,
                                           "credentialDigest": digest, "endpoint": endpoint,
                                           "browserPath": browser_path}
        if name in HISTORY_ACCOUNTS:
            try:
                await asyncio.wait_for(silence_account_browser(browser), timeout=4)
            except TimeoutError:
                pass  # Muting retained tabs must not exhaust login-check time.
        return browser, endpoint, digest


async def close_idle_account_browser(browser):
    """Release any idle managed account Chrome, retaining its profile/login.

    Callers hold the existing account operation lock. Never close a visible
    browser or a managed browser with an editor/recovery page still open.
    Cleanup is best effort and cannot invalidate a confirmed draft/login.
    """
    owned = getattr(browser, "_huobao_managed_session", None)
    if not isinstance(owned, dict) or not isinstance(owned.get("accountName"), str):
        return False
    session = None
    try:
        directory = owned["directory"]
        state_file = directory / "session.json"
        lock_file = directory / "session.lock"
        if state_file.is_symlink() or lock_file.is_symlink():
            return False
        with lock_file.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = json.loads(state_file.read_text())
            if any(state.get(key) != owned[key] for key in ("pid", "accountName", "credentialDigest")):
                return False
            if endpoint_from_profile(directory / "profile") != (owned["endpoint"], owned["browserPath"]):
                return False
            session = await asyncio.wait_for(browser.new_browser_cdp_session(), timeout=2)
            targets = await asyncio.wait_for(session.send("Target.getTargets"), timeout=2)
            # Chrome also exposes its omnibox UI and extension background
            # pages as targets. They are not unfinished upload documents.
            background_types = {"browser", "service_worker", "shared_worker", "worker", "browser_ui", "background_page"}
            if any(target.get("type") not in background_types and not (
                    target.get("type") in ("page", "tab") and target.get("url") == "about:blank")
                   for target in targets["targetInfos"]):
                return False
            try:
                await asyncio.wait_for(session.send("Browser.close"), timeout=2)
            except Exception:
                pass  # Chrome can disconnect the socket before acknowledging.
            deadline = time.monotonic() + 2
            while True:
                try:
                    os.waitpid(owned["pid"], os.WNOHANG)
                except ChildProcessError:
                    pass
                if not alive(owned["pid"]):
                    state["closedAt"] = time.time()
                    write_private(state_file, state)
                    return True
                if time.monotonic() >= deadline:
                    return False
                await asyncio.sleep(0.1)
    except Exception:
        return False
    finally:
        if session is not None:
            try:
                await asyncio.wait_for(session.detach(), timeout=1)
            except Exception:
                pass


async def connect_existing_account_browser(playwright, config, account_name, digest):
    """Attach only to an existing owned process to close a failed attempt.

    An old attempt may use a previous credential generation. No credentials
    are imported here, and no browser is launched just for cleanup.
    """
    name = validate_account_name(account_name)
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        return None
    root = Path(config["stateRoot"]).resolve()
    directory = root / "account-browsers" / name / digest
    if directory.resolve() != directory or not directory.is_dir():
        return None
    file = directory / "session.json"
    if not file.is_file() or file.is_symlink() or (directory / "session.lock").is_symlink():
        return None
    with (directory / "session.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(file.read_text())
        if state.get("accountName") != name or state.get("credentialDigest") != digest or not alive(state.get("pid")):
            return None
        endpoint, browser_path = endpoint_from_profile(directory / "profile")
        if not await asyncio.to_thread(endpoint_matches, endpoint, browser_path):
            return None
        if HISTORY_ACCOUNTS.get(name, "baijiahao") == "baijiahao":
            await cleanup_stale_baijiahao_pages(config, endpoint, account_name=name)
        browser = await connect_managed_cdp(playwright, endpoint, browser_path)
        browser._huobao_managed_session = {"directory": directory, "pid": state["pid"], "accountName": name,
                                           "credentialDigest": digest, "endpoint": endpoint, "browserPath": browser_path}
        return browser
