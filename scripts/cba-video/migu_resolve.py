#!/usr/bin/env python3
"""Resolve public Migu pages through videodl without printing signed media URLs."""

import argparse
import atexit
import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.parse import urlsplit


class ResolutionError(ValueError):
    pass


class TemporaryResolutionError(ResolutionError):
    pass


_videodl_log_directory = None


def load_kedou_client():
    # videodl creates a FileHandler during import and later reopens that same
    # path even with disable_print=True. Retain the private directory until
    # process exit, across playlist/detail parsing and bounded retries.
    global _videodl_log_directory
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            import platformdirs
            if _videodl_log_directory is None:
                _videodl_log_directory = tempfile.TemporaryDirectory(prefix="cba-videodl-")
                atexit.register(_videodl_log_directory.cleanup)
            original = platformdirs.user_log_dir

            def task_log_dir(appname=None, *args, **kwargs):
                if appname == "videodl":
                    return _videodl_log_directory.name
                return original(appname, *args, **kwargs)

            platformdirs.user_log_dir = task_log_dir
            try:
                from videodl.modules.common.kedou import KedouVideoClient
            finally:
                platformdirs.user_log_dir = original
        except ImportError as exc:
            raise ResolutionError("当前 Python 环境无法导入 videodl，请使用已安装 videodl 的 Python") from exc
        except OSError as exc:
            raise ResolutionError("videodl 日志初始化失败，请检查任务临时目录权限") from exc
    return KedouVideoClient


def parse_page_url(url):
    match = re.fullmatch(r"https://www\.miguvideo\.com/p/(live|detail)/([0-9]+)", url or "")
    if not match:
        raise ResolutionError("仅支持公开的咪咕 /p/live/ 或 /p/detail/ 页面地址")
    return match.group(1), match.group(2)


def safe_title(value):
    return re.sub(r"https?://\S+", "[链接]", str(value or ""))[:300]


def select_response(raw_data, download_url, title, page_url, content_id=None):
    """Classify a parser response; downloadUrl is private and never CLI output."""
    page_type, _ = parse_page_url(page_url)
    if content_id is not None:
        if page_type != "live" or not re.fullmatch(r"[0-9]+", str(content_id)):
            raise ResolutionError("--content-id 仅适用于赛事页，且必须是该赛事的视频编号")
    data = raw_data.get("data") if isinstance(raw_data, dict) else None
    rows = data.get("videoListItemVoList") if isinstance(data, dict) else None
    if isinstance(rows, list):
        entries = []
        seen = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            url = row.get("playUrl")
            try:
                kind, _ = parse_page_url(url)
            except (ResolutionError, TypeError):
                continue
            if kind != "detail" or url in seen:
                continue
            seen.add(url)
            entries.append({"title": safe_title(row.get("title")), "url": url})
        if not entries:
            raise ResolutionError("咪咕赛事响应未包含有效的视频详情页")
        if content_id is None:
            return {"type": "playlist", "pageUrl": page_url, "entries": entries}
        for entry in entries:
            if parse_page_url(entry["url"])[1] == str(content_id):
                return {"type": "detail", "pageUrl": entry["url"], "title": entry["title"]}
        raise ResolutionError("指定视频编号不属于此赛事，未继续解析")
    if content_id is not None:
        raise ResolutionError("赛事响应没有视频列表，无法核验指定视频编号")
    if isinstance(download_url, str) and download_url:
        try:
            media = urlsplit(download_url)
            valid = media.scheme in ("http", "https") and bool(media.hostname)
            valid = valid and not media.username and not media.password
            valid = valid and not any(char.isspace() for char in download_url)
        except ValueError:
            valid = False
        if not valid:
            raise ResolutionError("解析服务返回的媒体地址无效")
        return {
            "type": "media", "pageUrl": page_url,
            "title": safe_title(title), "downloadUrl": download_url,
        }
    raise ResolutionError("咪咕解析服务未返回可下载媒体，请稍后重试")


def parse_once(page_url, content_id=None):
    # Import inside the capture: third-party imports and parsers can print URLs.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        KedouVideoClient = load_kedou_client()
        try:
            client = KedouVideoClient(max_retries=1, disable_print=True)
            infos = client.parsefromurl(page_url, request_overrides={"timeout": 35})
        except Exception as exc:
            raise TemporaryResolutionError("咪咕解析服务请求失败，请稍后重试") from exc
    # The installed parser preserves raw_data when a playlist causes KeyError.
    for info in infos or []:
        raw = getattr(info, "raw_data", {})
        data = raw.get("data") if isinstance(raw, dict) else None
        if (isinstance(data, dict) and isinstance(data.get("videoListItemVoList"), list)) or getattr(info, "download_url", ""):
            return select_response(raw, info.download_url, info.title, page_url, content_id)
    raise TemporaryResolutionError("咪咕解析服务未返回可下载媒体，请稍后重试")


def resolve_with_retry(page_url, content_id=None):
    # Two bounded requests absorb a temporary parser/network failure. Identity,
    # selection and malformed-response errors remain terminal.
    for attempt in range(2):
        try:
            return parse_once(page_url, content_id)
        except TemporaryResolutionError:
            if attempt:
                raise
            time.sleep(1)


def write_private_url(output, value):
    target = Path(output).absolute()
    target.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(value + "\n")
    return str(target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url")
    parser.add_argument("--output", help="媒体直链私有文件，权限 600；赛事列表不会写文件")
    parser.add_argument("--content-id", help="明确选择赛事列表中的一个视频编号")
    parser.add_argument("--check-runtime", action="store_true", help="仅检查 videodl 导入和临时日志，不发起网络请求")
    args = parser.parse_args(argv)
    if not args.check_runtime and (not args.url or not args.output):
        parser.error("必须提供 --url 和 --output，或使用 --check-runtime")
    try:
        if args.check_runtime:
            load_kedou_client()
            print(json.dumps({"ok": True, "runtime": "videodl", "temporaryLogs": True}))
            return 0
        kind, _ = parse_page_url(args.url)
        if args.content_id is not None and (kind != "live" or not re.fullmatch(r"[0-9]+", args.content_id)):
            raise ResolutionError("--content-id 仅适用于赛事页，且必须是该赛事的视频编号")
        result = resolve_with_retry(args.url, args.content_id)
        if result["type"] == "detail":
            selected_title = result["title"]
            result = resolve_with_retry(result["pageUrl"])
            if result["type"] != "media":
                raise ResolutionError("所选视频详情页未返回可下载媒体")
            result["selectedTitle"] = selected_title
        if result["type"] == "media":
            url_file = write_private_url(args.output, result.pop("downloadUrl"))
            result["urlFile"] = url_file
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ResolutionError as exc:
        print(str(exc), file=sys.stderr)
    except OSError:
        print("无法写入媒体直链私有文件，请检查输出路径和权限", file=sys.stderr)
    except Exception:
        print("咪咕解析失败，未输出媒体直链", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
