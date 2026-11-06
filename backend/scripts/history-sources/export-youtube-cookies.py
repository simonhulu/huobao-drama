"""Export only YouTube cookies for a background yt-dlp service."""

import argparse
import json
import os
from pathlib import Path
import tempfile

from yt_dlp.cookies import YoutubeDLCookieJar, extract_cookies_from_browser


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--browser", default="chrome")
    parser.add_argument("--profile")
    args = parser.parse_args()
    source = extract_cookies_from_browser(args.browser, args.profile)
    target = YoutubeDLCookieJar()
    for cookie in source:
        domain = cookie.domain.lstrip(".").lower()
        if (domain == "youtube.com" or domain.endswith(".youtube.com")) and not cookie.is_expired():
            target.set_cookie(cookie)
    if not len(target):
        raise RuntimeError("No current YouTube cookies found; open YouTube in the selected browser first")
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(dir=args.output.parent, prefix="youtube-cookies-")
    os.close(descriptor)
    try:
        target.save(temporary)
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(json.dumps({"exported": len(target), "domain": "youtube.com", "mode": oct(args.output.stat().st_mode & 0o777)}))


if __name__ == "__main__":
    main()
