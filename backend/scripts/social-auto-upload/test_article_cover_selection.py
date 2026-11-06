import copy
import hashlib
from html import escape
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from article_cover_selection import select_article_cover_images, prepare_article_cover_images, prepared_article_cover_images


def scene(seed):
    rng = np.random.default_rng(seed)
    image = np.full((360, 640, 3), 165, dtype=np.uint8)
    for row in range(4):
        for column in range(6):
            left, top = column * 106, row * 90
            color = tuple(int(value) for value in rng.integers(45, 220, 3))
            cv2.rectangle(image, (left, top), (left + 105, top + 89), color, -1)
            for _ in range(14):
                x = left + int(rng.integers(4, 98))
                y = top + int(rng.integers(4, 82))
                radius = int(rng.integers(2, 9))
                shade = tuple(int(value) for value in rng.integers(15, 245, 3))
                cv2.circle(image, (x, y), radius, shade, int(rng.choice([-1, 1, 2])))
    return image


class ArticleCoverSelectionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="article-cover-selection-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.cover = self.image("main.png", scene(1001))

    def image(self, name, pixels, url=None):
        file = self.root / name
        ok, encoded = cv2.imencode(file.suffix, pixels)
        self.assertTrue(ok)
        file.write_bytes(encoded.tobytes())
        return {"url": url or f"/article/{name}", "path": str(file)}

    def payload(self, images, body_order=None):
        return {"landscapePath": self.cover["path"], "images": images,
                "articleHtml": "<p>正文</p>" + "".join(
                    f'<img src="{escape(image["url"], quote=True)}">'
                    for image in (images if body_order is None else body_order))}

    def test_selects_two_distributed_clear_scenes_in_html_order_without_writes(self):
        first = self.image("first.png", scene(1))
        second = self.image("second.png", scene(2))
        soft = self.image("soft.png", cv2.GaussianBlur(scene(3), (0, 0), 1.6))
        payload = self.payload([first, second, soft], [second, soft, first])
        original = copy.deepcopy(payload)
        hashes = {item["path"]: hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest()
                  for item in [self.cover, first, second, soft]}
        selected = select_article_cover_images(payload)
        self.assertEqual([item["url"] for item in selected], [second["url"], first["url"]])
        for item in selected:
            self.assertEqual(set(item), {"url", "path", "sha256", "quality"})
            self.assertEqual(item["sha256"], hashes[item["path"]])
            self.assertIsInstance(item["quality"], dict)
            self.assertGreater(item["quality"]["score"], 0)
        json.dumps(selected, allow_nan=False)
        self.assertEqual(payload, original)
        for file, digest in hashes.items():
            self.assertEqual(hashlib.sha256(Path(file).read_bytes()).hexdigest(), digest)

    def test_only_real_body_img_sources_are_eligible_and_entities_are_decoded(self):
        hidden = self.image("hidden.png", scene(4))
        first = self.image("first.png", scene(5), "/article/first.png?a=1&b=2")
        second = self.image("second.png", scene(6))
        payload = self.payload([first, hidden, second], [second, first])
        payload["articleHtml"] += (
            f'<!-- <img src="{hidden["url"]}"> -->'
            f'<script>const markup = \'<img src="{hidden["url"]}">\';</script>'
            f'<template><img src="{hidden["url"]}"></template>'
            f'<img data-src="{hidden["url"]}">')
        self.assertEqual([item["url"] for item in select_article_cover_images(payload)],
                         [second["url"], first["url"]])
        with self.assertRaisesRegex(ValueError, "缺少 1 张"):
            select_article_cover_images(self.payload([first, hidden], [first]))

    def test_main_cover_file_content_and_reencoded_scene_are_excluded(self):
        first = self.image("first.png", scene(7))
        second = self.image("second.png", scene(8))
        alias = {"url": "/article/main-alias", "path": self.cover["path"]}
        copied = self.root / "main-copy.png"
        copied.write_bytes(Path(self.cover["path"]).read_bytes())
        duplicate = {"url": "/article/main-copy", "path": str(copied)}
        encoded = self.image("main-encoded.jpg", scene(1001))
        for cover in [alias, duplicate, encoded]:
            with self.subTest(url=cover["url"]):
                selected = select_article_cover_images(self.payload([cover, first, second]))
                self.assertEqual([item["url"] for item in selected], [first["url"], second["url"]])

    def test_duplicate_files_and_near_duplicate_scenes_cannot_fill_two_slots(self):
        original = scene(9)
        first = self.image("first.png", original)
        same_path = {"url": "/article/same-path", "path": first["path"]}
        same_content = self.root / "same-content.png"
        same_content.write_bytes(Path(first["path"]).read_bytes())
        copy_image = {"url": "/article/copy", "path": str(same_content)}
        changed = cv2.convertScaleAbs(original, alpha=0.96, beta=7)
        cv2.putText(changed, "Different subtitles", (40, 330), cv2.FONT_HERSHEY_SIMPLEX,
                    1, (255, 255, 255), 2)
        reencoded = self.image("reencoded.jpg", changed)
        for duplicate in [same_path, copy_image, reencoded]:
            with self.subTest(url=duplicate["url"]), self.assertRaisesRegex(ValueError, "缺少 1 张"):
                select_article_cover_images(self.payload([first, duplicate]))

    def test_blur_mosaic_subtitle_edges_and_small_focus_cannot_stand_in_for_a_clear_scene(self):
        original = scene(10)
        blurred = cv2.GaussianBlur(original, (0, 0), 10)
        subtitle = blurred.copy()
        cv2.putText(subtitle, "SHARP OVERLAY", (40, 185), cv2.FONT_HERSHEY_SIMPLEX,
                    1.4, (255, 255, 255), 3)
        cv2.rectangle(subtitle, (0, 0), (639, 359), (255, 255, 255), 5)
        focused = blurred.copy()
        focused[80:145, 65:155] = original[80:145, 65:155]
        blocks = np.random.default_rng(15).integers(20, 235, (18, 32, 3), dtype=np.uint8)
        mosaic = cv2.resize(blocks, (640, 360), interpolation=cv2.INTER_NEAREST)
        dark = (original.astype(np.float32) * 0.025).astype(np.uint8)
        first = self.image("first.png", scene(11))
        for name, pixels in [("blur", blurred), ("subtitle", subtitle), ("focus", focused),
                             ("mosaic", mosaic), ("dark", dark)]:
            with self.subTest(kind=name):
                bad = self.image(f"{name}.png", pixels)
                with self.assertRaisesRegex(ValueError, "缺少 1 张"):
                    select_article_cover_images(self.payload([first, bad]))

    def test_no_usable_images_reports_missing_two_without_a_single_image_fallback(self):
        black = self.image("black.png", np.zeros((360, 640, 3), dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "缺少 2 张"):
            select_article_cover_images(self.payload([black]))
        with self.assertRaisesRegex(ValueError, "缺少 2 张"):
            select_article_cover_images(self.payload([]))

    def test_clear_subject_with_plain_background_is_not_rejected_as_blur(self):
        first = self.image("first.png", scene(21))
        # A focused subject fills six adjacent scene tiles; the surrounding wall
        # has no detail. Requiring half the image to be sharp rejects this shot.
        portrait = np.full((360, 640, 3), 90, dtype=np.uint8)
        portrait[98:280, 320:608] = scene(22)[98:280, 320:608]
        second = self.image("focused-subject.jpg", portrait)
        selected = select_article_cover_images(self.payload([first, second]))
        self.assertEqual([item["url"] for item in selected], [first["url"], second["url"]])
        self.assertLess(selected[1]["quality"]["clearTileFraction"], 0.5)

    def test_blurring_the_focused_subject_still_rejects_the_shot(self):
        first = self.image("first.png", scene(21))
        portrait = np.full((360, 640, 3), 90, dtype=np.uint8)
        portrait[98:280, 320:608] = scene(22)[98:280, 320:608]
        second = self.image("blurred-subject.jpg", cv2.GaussianBlur(portrait, (0, 0), 10))
        with self.assertRaisesRegex(ValueError, "缺少 1 张"):
            select_article_cover_images(self.payload([first, second]))

    def test_article_preparation_saves_selection_without_browser_or_job_state(self):
        first = self.image("first.png", scene(21))
        second = self.image("second.png", scene(22))
        for images, valid in [([first, second], True), ([first], False)]:
            with self.subTest(valid=valid):
                payload = self.payload(images)
                payload.pop("landscapePath")  # Articles can be made before the project cover.
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("article_cover_selection.py")),
                                         "prepare"], input=json.dumps(payload),
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0 if valid else 1, result.stdout + result.stderr)
                data = json.loads(result.stdout)
                if valid:
                    self.assertEqual(data["version"], 1)
                    self.assertEqual(json.loads((self.root / "body-cover-selection.json").read_text()), data)
                if not valid:
                    self.assertIn("缺少 1 张", data["error"])

    def test_upload_reuses_prepared_choices_without_decoding_or_rescoring_images(self):
        images = [self.image(f"scene-{i}.png", scene(i)) for i in (21, 22)]
        payload = self.payload(images)
        prepared = prepare_article_cover_images(payload)
        with patch("article_cover_selection._measure", side_effect=AssertionError("No upload-time quality review")), \
             patch("article_cover_selection._read_image", side_effect=AssertionError("No upload-time decoding")):
            selected = prepared_article_cover_images(payload)
        self.assertEqual([item["url"] for item in selected], [item["url"] for item in prepared["images"]])
        Path(images[0]["path"]).write_bytes(b"different image")
        with self.assertRaisesRegex(ValueError, "文件已变化"):
            prepared_article_cover_images(payload)

    def test_upload_reports_missing_preparation_without_guessing_new_images(self):
        images = [self.image(f"scene-{i}.png", scene(i)) for i in (21, 22)]
        with self.assertRaisesRegex(ValueError, "文章生成阶段补齐"):
            prepared_article_cover_images(self.payload(images))

    def test_small_high_detail_images_are_valid_distinct_candidates(self):
        images = [self.image(f"small-{seed}.png", np.random.default_rng(seed).integers(
            20, 235, (120, 160, 3), dtype=np.uint8)) for seed in (1, 2)]
        selected = select_article_cover_images(self.payload(list(reversed(images)), images))
        self.assertEqual([item["url"] for item in selected], [item["url"] for item in images])

    def test_compressed_and_softened_mosaic_boundaries_still_require_rejection(self):
        first = self.image("first.png", scene(13))
        blocks = np.random.default_rng(15).integers(20, 235, (18, 32, 3), dtype=np.uint8)
        mosaic = cv2.resize(blocks, (640, 360), interpolation=cv2.INTER_NEAREST)
        for sigma in (0, 0.7, 1):
            with self.subTest(sigma=sigma):
                pixels = cv2.GaussianBlur(mosaic, (0, 0), sigma) if sigma else mosaic
                bad = self.image(f"mosaic-{sigma}.jpg", pixels)
                with self.assertRaisesRegex(ValueError, "缺少 1 张.*马赛克"):
                    select_article_cover_images(self.payload([first, bad]))

    def test_unreadable_images_report_shortage_and_concrete_reason(self):
        first = self.image("first.png", scene(12))
        missing = {"url": "/article/missing.png", "path": str(self.root / "missing.png")}
        with self.assertRaisesRegex(ValueError, "缺少 1 张.*不可读取"):
            select_article_cover_images(self.payload([missing, first]))


if __name__ == "__main__":
    unittest.main()
