"""Named SAU account login bridge. Emits only QR images and boolean readiness."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import sys


def account_file(root: str, name: str) -> Path:
    if not re.fullmatch(r"(?:cba|science|mystery)_[a-f0-9]{32}", name or ""):
        raise ValueError("Invalid account name")
    base = Path(root).resolve()
    cookies = base / "cookies"
    if cookies.is_symlink():
        raise ValueError("Symlink account directory")
    cookies.mkdir(mode=0o700, exist_ok=True)
    target = cookies / f"baijiahao_{name}.json"
    if target.is_symlink() or target.resolve().parent != cookies.resolve():
        raise ValueError("Invalid account path")
    return target


def qr_data(payload: dict, target: Path) -> str:
    image = Path(payload.get("image_path", ""))
    # SAU writes temporary QR images beside this account's storage state.
    if image.is_symlink() or image.resolve().parent != target.parent.resolve() or not image.name.startswith(target.stem + "_"):
        raise ValueError("Invalid QR path")
    data = image.read_bytes()
    if len(data) > 1_000_000 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Invalid QR image")
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


async def check_account(target: Path) -> bool:
    if not target.is_file():
        return False
    from uploader.baijiahao_uploader.main import async_playwright, _build_launch_kwargs, BAIJIAHAO_HOME_URL
    from bridge import login_state
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(**_build_launch_kwargs(headless=True))
        try:
            context = await browser.new_context(storage_state=str(target))
            page = await context.new_page()
            await page.goto(BAIJIAHAO_HOME_URL, timeout=60000, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)
            result = await login_state(page, "baijiahao")
            return result["ready"] is True
        finally:
            await browser.close()


async def run(action: str, value: dict, emit):
    target = account_file(value["root"], value["accountName"])
    if action == "check":
        return {"type": "result", "ready": await check_account(target)}
    if action != "login":
        raise ValueError("Unsupported action")
    from uploader.baijiahao_uploader.main import baijiahao_cookie_gen
    async def on_qr(payload):
        emit({"type": "qr", "qrDataUrl": qr_data(payload, target)})
    # Use SAU's real QR login, preserving its standard named-account file format.
    result = await baijiahao_cookie_gen(str(target), headless=True, qrcode_callback=on_qr, max_checks=100)
    ready = bool(result.get("success")) and await check_account(target)
    if target.exists():
        target.chmod(0o600)
    return {"type": "result", "ready": ready}


def main():
    os.umask(0o077)
    protocol = sys.stdout
    def emit(value):
        protocol.write("SAU_ACCOUNT " + json.dumps(value, ensure_ascii=False) + "\n")
        protocol.flush()
    try:
        value = json.load(sys.stdin)
        # SAU logs include QR contents and local paths. Keep them off the API stream.
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = asyncio.run(run(sys.argv[1], value, emit))
        emit(result)
    except Exception:
        emit({"type": "result", "ready": False})


if __name__ == "__main__":
    main()
