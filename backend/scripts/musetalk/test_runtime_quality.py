"""Quality configuration and avatar cache regressions without CUDA dependencies."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from runtime import MuseTalkRuntime, add_quality_arguments, apply_audio_lookahead, reference_frame_count, validate_avatar, validate_reference_fps


class Conditions(list):
    @property
    def shape(self):
        return (len(self), 2)

    def __getitem__(self, index):
        if isinstance(index, list):
            return Conditions(super(Conditions, self).__getitem__(item) for item in index)
        return super().__getitem__(index)


class RuntimeQualityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.reference = self.root / "reference.mp4"
        self.reference.write_bytes(b"reference")
        self.preprocessing = self.root / "preprocessing.py"
        self.preprocessing.write_text("# preprocessing\n", encoding="ascii")
        self.addCleanup(self.directory.cleanup)

    def runtime(self, **kwargs):
        return MuseTalkRuntime(self.root, self.reference, preprocessing_module=self.preprocessing, **kwargs)

    def test_defaults_match_native_25fps_and_existing_v15_preparation(self):
        runtime = self.runtime()
        self.assertEqual(runtime.fps, 25)
        self.assertEqual(runtime.precision, "fp16")
        parser = argparse.ArgumentParser()
        add_quality_arguments(parser)
        self.assertEqual(vars(parser.parse_args([])), {
            "fps": 25, "precision": "fp16", "extra_margin": 10,
            "parsing_mode": "jaw", "left_cheek_width": 90, "right_cheek_width": 90,
            "audio_lookahead_frames": 0,
        })

    def test_cache_identity_changes_for_every_quality_input(self):
        original = self.runtime().identity
        self.assertEqual(self.runtime().identity, original)
        for changed in ({"fps": 15}, {"precision": "fp32"}, {"extra_margin": 20},
                        {"parsing_mode": "raw"}, {"parsing_mode": "neck"},
                        {"left_cheek_width": 80}, {"right_cheek_width": 80},
                        {"codec": "h264_nvenc"}, {"audio_lookahead_frames": 2}):
            with self.subTest(changed=changed):
                self.assertNotEqual(self.runtime(**changed).identity["avatar_id"], original["avatar_id"])
        self.reference.write_bytes(b"changed reference")
        changed_reference = self.runtime().identity
        self.assertNotEqual(changed_reference["avatar_id"], original["avatar_id"])
        self.preprocessing.write_text("# changed preprocessing\n", encoding="ascii")
        self.assertNotEqual(self.runtime().identity["avatar_id"], changed_reference["avatar_id"])
        self.assertRegex(original["avatar_id"], r"^[A-Za-z0-9_-]{1,160}$")
        self.assertEqual(set(original), {"model", "source_revision", "avatar_id", "reference_sha256", "fps"})

    def registry(self, entry=None):
        reference = self.root / "history.mp4"
        reference.write_bytes(b"history reference")
        registry = self.root / "avatars.json"
        registry.write_text(json.dumps({"avatars": {"xiaoba-history-01": entry or {
            "reference": reference.name, "reference_sha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        }}}), encoding="ascii")
        return registry, reference

    def test_registry_binds_real_reference_and_quality_without_changing_default_identity(self):
        registry, reference = self.registry()
        original = self.runtime()
        runtime = self.runtime(avatar_registry=registry)
        self.assertEqual(runtime.identity, original.identity)
        selected = runtime.identity_for("xiaoba-history-01")
        self.assertEqual(selected["avatar_id"], "xiaoba-history-01")
        self.assertEqual(selected["reference_sha256"], hashlib.sha256(reference.read_bytes()).hexdigest())
        self.assertRegex(selected["avatar_profile_sha256"], r"^[a-f0-9]{64}$")
        self.assertNotEqual(self.runtime(avatar_registry=registry, precision="fp32").identity_for("xiaoba-history-01"), selected)
        self.assertEqual(runtime.quality_for("xiaoba-history-01")["reference_sha256"], selected["reference_sha256"])
        with self.assertRaises(KeyError):
            runtime.identity_for("unknown")
        reference.write_bytes(b"changed after startup")
        with self.assertRaisesRegex(ValueError, "checksum changed"):
            runtime.identity_for("xiaoba-history-01")

    def test_registry_rejects_unpinned_or_missing_references_before_loading_models(self):
        for entry in ({"reference": "history.mp4", "reference_sha256": "0" * 64},
                      {"reference": "missing.mp4", "reference_sha256": "0" * 64},
                      {"reference": "history.mp4", "reference_sha256": "invalid"},
                      {"reference": "history.mp4"}, {"reference": "", "reference_sha256": "0" * 64}):
            with self.subTest(entry=entry):
                registry, _ = self.registry(entry)
                with self.assertRaises(ValueError):
                    self.runtime(avatar_registry=registry)

    def bank_registry(self, playback=None):
        registry, reference = self.registry()
        body = json.loads(registry.read_text())
        body["avatars"]["xiaoba-history-01"]["playback"] = playback if playback is not None else {
            "mode": "shuffle-segments-v1",
            "segments": [{"start_frame": 0, "end_frame": 1}, {"start_frame": 1, "end_frame": 2}],
        }
        registry.write_text(json.dumps(body))
        return registry, reference

    def test_playback_settings_change_profile_and_cache_identity_without_changing_default_avatar(self):
        registry, _ = self.registry()
        original = self.runtime(avatar_registry=registry)
        registry, _ = self.bank_registry()
        shuffled = self.runtime(avatar_registry=registry)
        self.assertEqual(original.identity, shuffled.identity)
        selected = "xiaoba-history-01"
        self.assertNotEqual(original.identity_for(selected), shuffled.identity_for(selected))
        self.assertNotEqual(original.avatar_profiles[selected]["cache_id"], shuffled.avatar_profiles[selected]["cache_id"])
        self.assertEqual(shuffled.quality_for(selected)["playback"]["mode"], "shuffle-segments-v1")
        registry, _ = self.bank_registry({"mode": "shuffle-segments-v1", "segments": [
            {"start_frame": 0, "end_frame": 1}, {"start_frame": 1, "end_frame": 3},
        ]})
        self.assertNotEqual(shuffled.identity_for(selected), self.runtime(avatar_registry=registry).identity_for(selected))

    def test_invalid_playback_is_rejected_before_loading_models(self):
        for playback in ({"mode": "reverse", "segments": []},
                         {"mode": "shuffle-segments-v1", "segments": [{"start_frame": 0, "end_frame": 2}]},
                         {"mode": "shuffle-segments-v1", "segments": [
                             {"start_frame": 0, "end_frame": 1}, {"start_frame": 2, "end_frame": 3}]}):
            with self.subTest(playback=playback):
                registry, _ = self.bank_registry(playback)
                with self.assertRaises(ValueError):
                    self.runtime(avatar_registry=registry)

    def test_playback_must_cover_decoded_forward_frames_and_match_upstream_cache_length(self):
        registry, _ = self.bank_registry()
        runtime = self.runtime(avatar_registry=registry)
        runtime.torch = SimpleNamespace(cuda=SimpleNamespace(synchronize=Mock(), empty_cache=Mock()))
        avatar = AvatarValidationTests().avatar()
        runtime.upstream = SimpleNamespace(Avatar=Mock(return_value=avatar))
        with patch("runtime.validate_reference_fps", return_value=25), patch("runtime.reference_frame_count", return_value=3):
            with self.assertRaisesRegex(RuntimeError, "do not cover the decoded"):
                runtime._load_avatar("xiaoba-history-01")
            runtime.upstream.Avatar.assert_not_called()
        with patch("runtime.validate_reference_fps", return_value=25), patch("runtime.reference_frame_count", return_value=2):
            with self.assertRaisesRegex(RuntimeError, "forward-and-reverse"):
                runtime._load_avatar("xiaoba-history-01")
            for name, values in vars(avatar).items():
                setattr(avatar, name, values + list(reversed(values)))
            runtime._load_avatar("xiaoba-history-01")
            self.assertIs(runtime.avatar, avatar)

    def test_avatar_switch_reuses_shared_models_and_only_keeps_one_resident_avatar(self):
        registry, _ = self.registry()
        runtime = self.runtime(avatar_registry=registry)
        runtime.torch = SimpleNamespace(cuda=SimpleNamespace(synchronize=Mock(), empty_cache=Mock()))
        upstream = SimpleNamespace(Avatar=Mock(side_effect=lambda *args: AvatarValidationTests().avatar()))
        runtime.upstream = upstream
        with patch("runtime.validate_reference_fps", return_value=25):
            runtime._load_avatar()
            default_avatar = runtime.avatar
            runtime._load_avatar("xiaoba-history-01")
            self.assertIsNot(runtime.avatar, default_avatar)
            history_avatar = runtime.avatar
            runtime._load_avatar("xiaoba-history-01")
            self.assertIs(runtime.avatar, history_avatar)
            runtime._load_avatar()
            runtime.load()
        self.assertIs(runtime.upstream, upstream)
        self.assertEqual(upstream.Avatar.call_count, 3)
        self.assertEqual(runtime.torch.cuda.empty_cache.call_count, 2)
        self.assertEqual(upstream.Avatar.call_args_list[0].args[0], runtime.identity["avatar_id"])
        self.assertTrue(upstream.Avatar.call_args_list[1].args[0].startswith("xiaoba-history-01-"))
        self.assertEqual(runtime.active_avatar_id, runtime.identity["avatar_id"])

    def test_invalid_quality_parameters_are_rejected_before_loading_models(self):
        for changed in ({"fps": 30}, {"precision": "bf16"}, {"parsing_mode": "unknown"},
                        {"extra_margin": -1}, {"extra_margin": 65}, {"extra_margin": 1.5},
                        {"left_cheek_width": -1}, {"left_cheek_width": 129},
                        {"right_cheek_width": -1}, {"right_cheek_width": 129},
                        {"audio_lookahead_frames": -1}, {"audio_lookahead_frames": 6},
                        {"audio_lookahead_frames": 1.5}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                self.runtime(**changed)

    def test_mismatched_reference_stops_before_model_or_cuda_setup(self):
        with patch("runtime.media_info", return_value={"streams": [
            {"codec_type": "video", "avg_frame_rate": "15/1"},
        ]}), patch("runtime.validate_source") as source, patch("runtime.os.chdir") as change_directory:
            with self.assertRaisesRegex(RuntimeError, "Resample the original reference to 25 FPS"):
                self.runtime().load()
            source.assert_not_called()
            change_directory.assert_not_called()

    def test_all_synthesis_modules_use_selected_precision(self):
        class Module:
            def to(self, *, device, dtype):
                self.dtype = dtype
                return self

            def eval(self):
                return self

            def requires_grad_(self, value):
                return self

        class FaceParsing:
            def __init__(self, **options):
                self.options = options

        conditions = Conditions([(index, index + 100) for index in range(5)])

        class AudioProcessor:
            def __init__(self, **options):
                pass

            def get_whisper_chunk(self, *args, **kwargs):
                return conditions

        for precision, lookahead in (("fp16", 0), ("fp32", 2)):
            with self.subTest(precision=precision):
                runtime = self.runtime(precision=precision, extra_margin=20, parsing_mode="raw",
                                       left_cheek_width=80, right_cheek_width=70,
                                       audio_lookahead_frames=lookahead)
                modules = [Module() for _ in range(4)]
                torch = SimpleNamespace(
                    cuda=SimpleNamespace(is_available=lambda: True, synchronize=lambda: None,
                                         get_device_name=lambda index: "fake GPU"),
                    backends=SimpleNamespace(cudnn=SimpleNamespace(), cuda=SimpleNamespace(matmul=SimpleNamespace())),
                    set_num_threads=Mock(), manual_seed=Mock(), device=lambda value: value,
                    tensor=Mock(), float16="fp16", float32="fp32", __version__="fake torch",
                )
                upstream = SimpleNamespace(
                    load_all_model=lambda **kwargs: (SimpleNamespace(vae=modules[0]),
                                                      SimpleNamespace(model=modules[1]), modules[2]),
                    AudioProcessor=AudioProcessor, FaceParsing=FaceParsing, Avatar=Mock(return_value=AvatarValidationTests().avatar()),
                )
                whisper = SimpleNamespace(from_pretrained=Mock(return_value=modules[3]))
                spec = SimpleNamespace(name="musetalk.utils.preprocessing", loader=SimpleNamespace(exec_module=Mock()))
                fake_modules = {"torch": torch, "onnxruntime": SimpleNamespace(SessionOptions=SimpleNamespace,
                                InferenceSession=Mock()), "transformers": SimpleNamespace(WhisperModel=whisper),
                                "scripts": SimpleNamespace(realtime_inference=upstream)}
                compatible = self.root / "models/face-parse-bisent/resnet18-state-dict.pth"
                compatible.parent.mkdir(parents=True, exist_ok=True)
                compatible.touch()
                original_directory = Path.cwd()
                try:
                    with patch.dict("sys.modules", fake_modules), patch("runtime.validate_source"), \
                         patch("runtime.media_info", return_value={"streams": [{"codec_type": "video", "avg_frame_rate": "25/1"}]}), \
                         patch("runtime.importlib.util.spec_from_file_location", return_value=spec), \
                         patch("runtime.importlib.util.module_from_spec", return_value=SimpleNamespace()), \
                         patch("runtime.file_hash", return_value="5c106cde386e87d4033832f2996f5493238eda96ccf559d1d62760c4de0613f8"), \
                         patch("runtime.sys.path", list(sys.path)), \
                         patch.dict(os.environ, {}, clear=False):
                        runtime.load()
                finally:
                    os.chdir(original_directory)
                self.assertEqual([module.dtype for module in modules], [precision] * 4)
                self.assertEqual(upstream.weight_dtype, precision)
                self.assertEqual(torch.backends.cuda.matmul.allow_tf32, precision == "fp16")
                self.assertEqual(torch.backends.cudnn.allow_tf32, precision == "fp16")
                self.assertEqual((upstream.args.extra_margin, upstream.args.parsing_mode), (20, "raw"))
                self.assertEqual(upstream.fp.options, {"left_cheek_width": 80, "right_cheek_width": 70})
                self.assertEqual(upstream.audio_processor.get_whisper_chunk(), apply_audio_lookahead(conditions, lookahead))
                self.assertIs(upstream.AudioProcessor, AudioProcessor)


class AudioLookaheadTests(unittest.TestCase):
    def test_zero_lookahead_reuses_original_tensor(self):
        conditions = Conditions([(index, index + 100) for index in range(5)])
        self.assertIs(apply_audio_lookahead(conditions, 0), conditions)

    def test_positive_lookahead_preserves_shape_and_clamps_tail(self):
        conditions = Conditions([(index, index + 100) for index in range(5)])
        result = apply_audio_lookahead(conditions, 2)
        self.assertEqual(result, [(2, 102), (3, 103), (4, 104), (4, 104), (4, 104)])
        self.assertEqual(result.shape, conditions.shape)
        self.assertEqual(conditions, [(index, index + 100) for index in range(5)])

    def test_short_sequence_never_wraps_to_start(self):
        self.assertEqual(apply_audio_lookahead(Conditions([(0, 100), (1, 101)]), 5), [(1, 101), (1, 101)])
        single = Conditions([(0, 100)])
        self.assertEqual(apply_audio_lookahead(single, 5), single)
        empty = Conditions()
        self.assertIs(apply_audio_lookahead(empty, 5), empty)


class ReferenceFrameRateTests(unittest.TestCase):
    def test_matching_25fps_and_15fps_references_and_rational_tolerance(self):
        for rate, fps in (("25/1", 25), ("15/1", 15), ("2501/100", 25), ("2499/100", 25)):
            with self.subTest(rate=rate, fps=fps), patch("runtime.media_info", return_value={
                "streams": [{"codec_type": "video", "avg_frame_rate": rate}],
            }):
                self.assertAlmostEqual(validate_reference_fps("reference.mp4", fps), fps, delta=.011)

    def test_mismatched_references_require_resampling_from_original(self):
        for rate, fps in (("15/1", 25), ("25/1", 15), ("25011/1000", 25)):
            with self.subTest(rate=rate, fps=fps), patch("runtime.media_info", return_value={
                "streams": [{"codec_type": "video", "avg_frame_rate": rate}],
            }):
                with self.assertRaisesRegex(RuntimeError, f"Resample the original reference to {fps} FPS"):
                    validate_reference_fps("reference.mp4", fps)

    def test_nominal_rate_is_used_when_average_rate_is_unavailable(self):
        with patch("runtime.media_info", return_value={"streams": [
            {"codec_type": "audio"},
            {"codec_type": "video", "avg_frame_rate": "0/0", "r_frame_rate": "25/1"},
        ]}):
            self.assertEqual(validate_reference_fps("reference.mp4", 25), 25)

    def test_invalid_metadata_is_rejected_with_recovery_guidance(self):
        for metadata in (None, {}, {"streams": None}, {"streams": [{"codec_type": "audio"}]},
                         {"streams": [{"codec_type": "video"}]},
                         {"streams": [{"codec_type": "video", "avg_frame_rate": "0/0", "r_frame_rate": "N/A"}]},
                         {"streams": [{"codec_type": "video", "avg_frame_rate": "-25/1"}]}):
            with self.subTest(metadata=metadata), patch("runtime.media_info", return_value=metadata):
                with self.assertRaisesRegex(RuntimeError, "Resample the original reference to 25 FPS"):
                    validate_reference_fps("reference.mp4", 25)


class ReferenceFrameCountTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_count_decodes_actual_reference_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                            "color=s=32x32:r=25:d=0.08", "-frames:v", "2", "-an", "-c:v", "libx264",
                            str(reference)], check=True, timeout=30)
            self.assertEqual(reference_frame_count(reference), 2)

    def test_missing_or_empty_count_is_rejected(self):
        for count in (None, "N/A", "0", "-1"):
            output = {"streams": [{"nb_read_frames": count}]}
            with self.subTest(count=count), patch("runtime.subprocess.run", return_value=SimpleNamespace(stdout=json.dumps(output))):
                with self.assertRaises(RuntimeError):
                    reference_frame_count("reference.mp4")


class AvatarValidationTests(unittest.TestCase):
    def avatar(self):
        return SimpleNamespace(
            input_latent_list_cycle=[object(), object()],
            frame_list_cycle=[SimpleNamespace(shape=(720, 720, 3)) for _ in range(2)],
            coord_list_cycle=[(100, 50, 300, 350), (110, 60, 310, 360)],
            mask_list_cycle=[object(), object()], mask_coords_list_cycle=[object(), object()],
        )

    def test_complete_halfbody_avatar_is_valid(self):
        validate_avatar(self.avatar())

    def test_missing_face_latent_and_empty_cycles_are_rejected(self):
        avatar = self.avatar()
        avatar.input_latent_list_cycle.pop()
        with self.assertRaisesRegex(RuntimeError, "cycle lengths"):
            validate_avatar(avatar)
        for name in vars(avatar):
            setattr(avatar, name, [])
        with self.assertRaisesRegex(RuntimeError, "non-empty"):
            validate_avatar(avatar)

    def test_invalid_bboxes_identify_the_bad_frame(self):
        for bbox in ((0, 0, 0, 0), (-1, 0, 100, 100), (0, 0, 721, 100),
                     (0, 0, 100, float("nan")), (0, 0, 100), (0, 0, 10.5, 100)):
            with self.subTest(bbox=bbox):
                avatar = self.avatar()
                avatar.coord_list_cycle[1] = bbox
                with self.assertRaisesRegex(RuntimeError, "bbox at frame 1"):
                    validate_avatar(avatar)


if __name__ == "__main__":
    unittest.main()
