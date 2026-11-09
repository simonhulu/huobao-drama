"""A custom-cover receipt cannot authorize a different editor preview."""
import copy
import hashlib
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np

import bridge
from editor_compat import BaijiahaoEditor


class CoverUploadBindingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.covers = {kind: {"status": "uploaded", "fingerprint": digest,
                             "source_sha256_verified": digest, "preview": kind,
                             "verification": "source_and_preview"}
                       for kind, digest in (("landscape", "wide-sha"), ("portrait", "tall-sha"))}
        self.slots = {kind: {"src": kind, "index": index, "image_inputs": [0]}
                      for index, kind in enumerate(self.covers)}
        base = SimpleNamespace(_READ_DIALOGS="dialogs", _verify_metadata=AsyncMock())
        self.helpers = BaijiahaoEditor(base)
        self.helpers._cover_slots = AsyncMock(side_effect=lambda _: copy.deepcopy(self.slots))
        self.page = MagicMock()
        self.page.evaluate = AsyncMock(return_value=[])
        self.pixels = np.zeros((64, 64, 3), dtype=np.uint8)
        self.helpers._cover_pixels = AsyncMock(return_value=self.pixels)
        for proof in self.covers.values():
            proof["pixels_sha256"] = hashlib.sha256(self.pixels.tobytes()).hexdigest()
        self.payload = {"target": "baijiahao-video", "publicationMode": "publish",
                        "landscapePath": "wide", "portraitPath": "tall"}

    async def test_final_check_rejects_automatic_or_replaced_preview(self):
        for kind in self.covers:
            with self.subTest(kind=kind):
                original = self.slots[kind]["src"]
                self.slots[kind]["src"] = "automatic-video-frame"
                with self.assertRaisesRegex(RuntimeError, "封面.*不一致"):
                    await self.helpers.verify_page(self.page, {}, self.covers)
                self.slots[kind]["src"] = original

    async def test_final_check_rejects_missing_or_conflicting_source_proof(self):
        for field, value in (("fingerprint", "different"), ("source_sha256_verified", None), ("preview", None)):
            with self.subTest(field=field):
                covers = copy.deepcopy(self.covers)
                covers["landscape"][field] = value
                with self.assertRaisesRegex(RuntimeError, "封面.*不一致"):
                    await self.helpers.verify_page(self.page, {}, covers)

    async def test_final_check_accepts_both_bound_custom_previews(self):
        await self.helpers.verify_page(self.page, {}, self.covers)

    async def test_final_check_rejects_changed_image_content_at_the_same_url(self):
        self.helpers._cover_pixels.return_value = np.full_like(self.pixels, 255)
        with self.assertRaisesRegex(RuntimeError, "封面.*不一致"):
            await self.helpers.verify_page(self.page, {}, self.covers)

    async def test_recovery_selects_local_cover_again_when_previous_preview_is_replaced(self):
        self.slots["landscape"]["src"] = "automatic-video-frame"
        self.helpers._file_digest = lambda file: {"wide": "wide-sha", "tall": "tall-sha"}[file]
        self.helpers._normalized_pixels = lambda _: self.pixels
        self.helpers._SLOTS = "slots"
        control = self.page.locator.return_value.nth.return_value.locator.return_value.nth.return_value
        control.set_input_files = AsyncMock(side_effect=RuntimeError("selected intended custom cover"))
        with patch.object(bridge.Path, "read_bytes", return_value=b"image"), self.assertRaisesRegex(RuntimeError, "selected intended custom cover"):
            await bridge.baijiahao_covers(self.page, self.payload, self.helpers, self.covers)
        control.set_input_files.assert_awaited_once_with("wide")

    async def test_publication_rechecks_after_topic_and_required_field_updates(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "state.json"
            state = {"phase": "staged", "files": {}, "details": {"metadata": {}, "covers": self.covers},
                     "result": {"targetId": "bound"}}
            verify = AsyncMock(side_effect=[None, RuntimeError("封面预览已变化，尚未发表")])
            with patch.object(bridge, "local_files", return_value={}), \
                    patch.object(bridge, "finish_staged_baijiahao_cover", AsyncMock()), \
                    patch.object(bridge, "verify_staged", verify), \
                    patch.object(bridge, "prepare_publication_topics", AsyncMock()), \
                    patch.object(bridge, "ensure_baijiahao_fields", AsyncMock(return_value={})), \
                    patch.object(bridge, "publication_button", AsyncMock()) as button:
                with self.assertRaisesRegex(RuntimeError, "封面预览已变化"):
                    await bridge.publication_preflight(self.page, self.payload, state, (), prepare_file=file)
                button.assert_not_awaited()
            self.assertEqual(verify.await_count, 2)

    async def test_saved_publication_rechecks_covers_after_topic_updates(self):
        with tempfile.TemporaryDirectory() as root:
            state = {"phase": "staged", "details": {"metadata": {}}, "result": {"targetId": "bound"}}
            verify = AsyncMock(side_effect=[None, RuntimeError("封面与本地封面不一致")])
            with patch.object(bridge, "verify_saved_baijiahao_covers", verify), \
                    patch.object(bridge, "verify_baijiahao_fields", AsyncMock()), \
                    patch.object(bridge, "prepare_publication_topics", AsyncMock()), \
                    patch.object(bridge, "publication_button", AsyncMock()) as button:
                with self.assertRaisesRegex(RuntimeError, "封面与本地封面不一致"):
                    await bridge.publication_preflight_saved(self.page, self.payload, state,
                        (None, None, None, self.helpers), prepare_file=Path(root) / "state.json")
                button.assert_not_awaited()
            self.assertEqual(verify.await_count, 2)


class CoverPixelPipelineTest(unittest.IsolatedAsyncioTestCase):
    async def test_source_can_update_before_crop_and_server_slot_without_accepting_a_video_frame(self):
        expected = np.full((64, 64, 3), 40, dtype=np.uint8)
        stale = np.full_like(expected, 255)
        state = {"tick": 0, "kind": None, "open": False, "selectedAt": 0, "confirmedAt": 0}
        slots = {kind: {"src": f"server-{kind}", "index": index, "image_inputs": [0]}
                 for index, kind in enumerate(("landscape", "portrait"))}
        clicks = []
        async def select(filename):
            state.update(kind=filename, open=True, selectedAt=state["tick"])
        async def dialogs(*_):
            if not state["open"]:
                return []
            kind = state["kind"]
            return [{"index": 0, "text": "横版封面预览" if kind == "landscape" else "竖版封面预览",
                     "source_count": 1, "preview_count": 1, "source": kind,
                     "preview": {"src": f"crop-{kind}", "width": 1280 if kind == "landscape" else 810,
                                 "height": 720 if kind == "landscape" else 1080}}]
        async def pixels(_, src):
            if src.startswith("crop-"):
                return stale if state["tick"] - state["selectedAt"] < 2 else expected + 1
            if src.startswith("server-"):
                return stale if state["tick"] - state["confirmedAt"] < 2 else expected + 2
            return stale
        async def click():
            self.assertGreaterEqual(state["tick"] - state["selectedAt"], 2,
                                    "must not confirm while only source, but not crop, has updated")
            clicks.append(state["kind"])
            state.update(open=False, confirmedAt=state["tick"])
            slots[state["kind"]]["src"] = f"server-{state['kind']}"
        async def sleep(_):
            state["tick"] += 1
        button = SimpleNamespace(count=AsyncMock(return_value=1), is_visible=AsyncMock(return_value=True),
                                 evaluate=AsyncMock(return_value=False), click=AsyncMock(side_effect=click))
        page = MagicMock()
        page.locator.return_value.nth.return_value.get_by_role.return_value = button
        page.locator.return_value.nth.return_value.locator.return_value.nth.return_value.set_input_files = AsyncMock(side_effect=select)
        helpers = SimpleNamespace(_SLOTS="slots", _file_digest=lambda file: file,
            _cover_slots=AsyncMock(side_effect=lambda _: copy.deepcopy(slots)),
            _browser_digest=AsyncMock(side_effect=lambda _, src: src), _cover_pixels=AsyncMock(side_effect=pixels),
            _normalized_pixels=lambda _: expected,
            _pixel_difference=lambda a, b: {"mae": float(np.abs(a.astype(float)-b).mean()),
                                           "rmse": float(np.sqrt(np.square(a.astype(float)-b).mean()))})
        with patch.object(bridge, "baijiahao_cover_dialogs", AsyncMock(side_effect=dialogs)), \
                patch.object(bridge.Path, "read_bytes", return_value=b"image"), \
                patch.object(bridge.asyncio, "sleep", AsyncMock(side_effect=sleep)):
            result = await bridge.baijiahao_covers(page,
                {"landscapePath": "landscape", "portraitPath": "portrait"}, helpers)
        self.assertEqual(clicks, ["landscape", "portrait"])
        for kind in ("landscape", "portrait"):
            self.assertEqual(result[kind]["pixels_sha256"], hashlib.sha256((expected + 2).tobytes()).hexdigest())
            self.assertLessEqual(result[kind]["pixel_difference"]["mae"], 3)

if __name__ == "__main__":
    unittest.main()
