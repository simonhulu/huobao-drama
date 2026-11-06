"""Prepare article images once; upload consumes the saved selection without rescoring."""
from __future__ import annotations

from collections import Counter
import hashlib
from html.parser import HTMLParser
from itertools import combinations
import math
import json
from pathlib import Path
import sys

import cv2
import numpy as np


class _BodyImages(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls = {}
        self.hidden = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "template", "noscript"}:
            self.hidden.append(tag)
        if tag == "img" and not self.hidden:
            url = dict(attrs).get("src")
            if url and url not in self.urls:
                self.urls[url] = len(self.urls)

    def handle_endtag(self, tag):
        if self.hidden and self.hidden[-1] == tag:
            self.hidden.pop()


def _read_image(value):
    file = Path(value).resolve(strict=True)
    if not file.is_file():
        raise ValueError("图片不是本地文件")
    data = file.read_bytes()
    pixels = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if pixels is None or min(pixels.shape[:2]) < 32:
        raise ValueError("图片不可解码或尺寸过小")
    return file, hashlib.sha256(data).hexdigest(), pixels


def _scene_gray(pixels):
    height, width = pixels.shape[:2]
    # Ignore borders and the usual bottom subtitle band, without changing files.
    region = pixels[int(height * 0.10):int(height * 0.78),
                    int(width * 0.05):int(width * 0.95)]
    return cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)


def _grid_fraction(profile):
    mean = float(profile.mean())
    if mean < 0.1:
        return 0.0
    best = 0.0
    for period in range(4, min(65, len(profile) // 4)):
        length = len(profile) // period * period
        phases = profile[:length].reshape(-1, period).mean(axis=0)
        # Compression/softening can spread a block boundary over a few pixels.
        boundary = phases.copy()
        for offset in range(1, min(3, period // 4)):
            boundary += np.roll(phases, offset)
        best = max(best, float(boundary.max()) / max(float(phases.sum()), 1e-6))
    return best


def _measure(gray):
    native = gray.astype(np.float32)
    horizontal = np.abs(np.diff(native, axis=1))
    vertical = np.abs(np.diff(native, axis=0))
    # Coarse mosaic boundaries can score as sharp; require two-axis grid evidence
    # plus flat block interiors, not just strong architectural lines in one axis.
    blockiness = min(_grid_fraction(horizontal.mean(axis=0)), _grid_fraction(vertical.mean(axis=1)))
    flat_fraction = float(((horizontal[:-1] < 2) & (vertical[:, :-1] < 2)).mean())
    scale = min(1.0, 640 / max(gray.shape))
    if scale < 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    denoised = cv2.GaussianBlur(gray, (3, 3), 0.5)
    sharpness = []
    clear = []
    for row in np.array_split(denoised, 4, axis=0):
        for tile in np.array_split(row, 4, axis=1):
            laplacian = cv2.Laplacian(tile, cv2.CV_32F)
            detail = float(laplacian.var())
            support = float((np.abs(laplacian) > 8).mean())
            sharpness.append(detail)
            clear.append(detail >= 35 and support >= 0.025)
    coverage = float(np.mean(clear))
    # Portraits and cinematic shots often have a plain/defocused background.
    # Accept a substantial connected subject (six of sixteen scene tiles),
    # rather than requiring half the entire frame to contain fine texture.
    # Scattered edges, subtitles and a tiny sharp patch remain insufficient.
    _, components = cv2.connectedComponents(np.array(clear, dtype=np.uint8).reshape(4, 4), connectivity=4)
    focused_tiles = int(np.bincount(components.ravel())[1:].max(initial=0))
    median = float(np.median(sharpness))
    lower = float(np.percentile(sharpness, 25))
    brightness = float(gray.mean())
    score = coverage * (0.7 * math.log1p(median) + 0.3 * math.log1p(lower))
    quality = {"score": round(score, 6), "clearTileFraction": coverage,
               "focusedTileFraction": focused_tiles / 16,
               "medianSharpness": round(median, 4), "lowerQuartileSharpness": round(lower, 4),
               "blockiness": round(blockiness, 4), "luminance": round(brightness, 4)}
    if blockiness >= 0.65 and flat_fraction >= 0.55:
        return quality, "画面存在明显马赛克"
    if brightness < 25 or float(np.percentile(gray, 90)) < 50:
        return quality, "画面过暗"
    if coverage < 0.5 and focused_tiles < 6:
        return quality, "画面模糊或清晰区域不足"
    return quality, None


def _signature(gray):
    thumbnail = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    coefficients = cv2.dct(thumbnail)[:8, :8].flatten()[1:]
    fingerprint = coefficients > np.median(coefficients)
    centered = thumbnail.flatten() - thumbnail.mean()
    return fingerprint, centered, float(np.linalg.norm(centered))


def _same_scene(first, second):
    if first["file"] == second["file"] or first["sha256"] == second["sha256"]:
        return True
    a, b = first["signature"], second["signature"]
    correlation = float(np.dot(a[1], b[1]) / max(a[2] * b[2], 1e-6))
    return int(np.count_nonzero(a[0] != b[0])) <= 10 and correlation >= 0.90


def select_article_cover_images(payload):
    """Return exactly two {url,path,sha256,quality} entries in HTML body order.

    Raises ValueError on insufficient clear, distinct body images. It reads only
    local payload files and never uploads, edits images, or modifies the payload.
    """
    parser = _BodyImages()
    parser.feed(payload.get("articleHtml") or "")
    parser.close()
    cover = None
    if payload.get("landscapePath"):
        try:
            file, digest, pixels = _read_image(payload["landscapePath"])
        except (OSError, ValueError, TypeError, cv2.error) as error:
            raise ValueError("主封面不可读取，无法排除重复封面") from error
        cover = {"file": file, "sha256": digest, "signature": _signature(_scene_gray(pixels))}
    candidates = []
    rejected = Counter()
    for image in payload.get("images", []):
        url = image.get("url")
        if url not in parser.urls:
            rejected["未在正文引用"] += 1
            continue
        try:
            file, digest, pixels = _read_image(image.get("path"))
            gray = _scene_gray(pixels)
            candidate = {"url": url, "path": image["path"], "file": file,
                         "sha256": digest, "signature": _signature(gray), "order": parser.urls[url]}
            if cover and _same_scene(candidate, cover):
                rejected["与主封面重复"] += 1
                continue
            quality, reason = _measure(gray)
        except (OSError, ValueError, TypeError, cv2.error):
            rejected["图片不可读取"] += 1
            continue
        if reason:
            rejected[reason] += 1
            continue
        candidate["quality"] = quality
        candidates.append(candidate)
    candidates.sort(key=lambda item: item["order"])
    pairs = [(first, second) for first, second in combinations(candidates, 2)
             if first["url"] != second["url"] and not _same_scene(first, second)]
    if not pairs:
        available = min(1, len(candidates))
        if len(candidates) > 1:
            rejected["重复或近重复画面"] += len(candidates) - 1
        reasons = "；".join(f"{reason}：{count}" for reason, count in rejected.items())
        suffix = f"（{reasons}）" if reasons else ""
        raise ValueError(f"正文配图不足：需要 2 张，找到 {available} 张，缺少 {2 - available} 张{suffix}")
    selected = max(pairs, key=lambda pair: sum(item["quality"]["score"] for item in pair))
    return [{key: item[key] for key in ("url", "path", "sha256", "quality")}
            for item in sorted(selected, key=lambda item: item["order"])]


def selection_manifest_path(payload):
    directories = {Path(item["path"]).resolve(strict=True).parent for item in payload.get("images", [])}
    if len(directories) != 1:
        raise ValueError("文章配图目录不完整，请先完成文章配图准备")
    return directories.pop() / "body-cover-selection.json"


def prepare_article_cover_images(payload):
    """Article-production step, never called from an upload operation."""
    selected = select_article_cover_images(payload)
    manifest = {"version": 1, "images": [{key: item[key] for key in ("url", "sha256", "quality")}
                                        for item in selected]}
    file = selection_manifest_path(payload)
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    temporary.replace(file)
    return manifest


def prepared_article_cover_images(payload):
    """Read prepared choices; check presence/identity only, never image quality."""
    file = selection_manifest_path(payload)
    try:
        if file.is_symlink():
            raise ValueError("配图准备记录路径无效")
        manifest = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError("文章配图尚未准备完成，请先在文章生成阶段补齐；尚未开始上传") from error
    entries = manifest.get("images", [])
    if manifest.get("version") != 1 or len(entries) != 2:
        raise ValueError("文章配图准备记录不完整，需要两张已选正文图")
    parser = _BodyImages()
    parser.feed(payload.get("articleHtml") or "")
    parser.close()
    assets = {image["url"]: image["path"] for image in payload.get("images", [])}
    main_digest = hashlib.sha256(Path(payload["landscapePath"]).read_bytes()).hexdigest() if payload.get("landscapePath") else None
    selected = []
    seen = set()
    for item in entries:
        url = item.get("url")
        if url not in assets or url not in parser.urls:
            raise ValueError("已选配图不在当前文章正文中，请重新准备文章配图")
        digest = hashlib.sha256(Path(assets[url]).read_bytes()).hexdigest()
        if digest != item.get("sha256"):
            raise ValueError("文章配图文件已变化，请重新准备文章配图")
        if digest == main_digest or digest in seen:
            raise ValueError("已选正文配图与主封面或另一张配图重复")
        seen.add(digest)
        selected.append({**item, "path": assets[url]})
    return sorted(selected, key=lambda item: parser.urls[item["url"]])


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["prepare"]:
            raise ValueError("不支持的文章配图准备操作")
        print(json.dumps(prepare_article_cover_images(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
