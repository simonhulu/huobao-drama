"""Offline gesture scheduling and synthesis/blending alignment regressions."""

import hashlib
from pathlib import Path
import queue
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from playback import IndexedSequence, plan_indices, validate_playback
from runtime import GenerationCancelled, pipe_inference


def settings(lengths=(3, 3, 3, 3)):
    segments, end = [], 0
    for length in lengths:
        segments.append({"start_frame": end, "end_frame": end + length})
        end += length
    return {"mode": "shuffle-segments-v1", "segments": segments}


class PlaybackTests(unittest.TestCase):
    def test_plan_is_forward_only_with_complete_shuffled_passes_and_no_adjacent_repeats(self):
        playback = settings()
        plan = plan_indices(playback, 7500, "a" * 64, "b" * 64)
        self.assertEqual(len(plan), 7500)
        self.assertTrue(all(0 <= index < 12 for index in plan))
        selected = []
        for start in range(0, len(plan), 3):
            segment = plan[start:start + 3]
            self.assertEqual(segment, tuple(range(segment[0], segment[0] + 3)))
            self.assertEqual(segment[0] % 3, 0)
            selected.append(segment[0] // 3)
        self.assertTrue(all(left != right for left, right in zip(selected, selected[1:])))
        for start in range(0, len(selected), 4):
            self.assertEqual(sorted(selected[start:start + 4]), list(range(4)))

    def test_narration_and_avatar_hashes_seed_reproducible_prefix_stable_plans(self):
        playback = settings()
        plan = plan_indices(playback, 120, "a" * 64, "b" * 64)
        self.assertEqual(plan, plan_indices(playback, 120, "a" * 64, "b" * 64))
        self.assertEqual(plan[:17], plan_indices(playback, 17, "a" * 64, "b" * 64))
        self.assertNotEqual(plan, plan_indices(playback, 120, "c" * 64, "b" * 64))
        self.assertNotEqual(plan, plan_indices(playback, 120, "a" * 64, "d" * 64))

    def test_variable_segment_lengths_preserve_forward_order_and_trim_only_the_last_segment(self):
        playback = settings((2, 4, 3))
        plan = plan_indices(playback, 103, "a" * 64, "b" * 64)
        cursor, previous = 0, None
        starts = {segment["start_frame"]: index for index, segment in enumerate(playback["segments"])}
        while cursor < len(plan):
            selected = starts[plan[cursor]]
            self.assertNotEqual(selected, previous)
            segment = playback["segments"][selected]
            count = min(segment["end_frame"] - segment["start_frame"], len(plan) - cursor)
            self.assertEqual(plan[cursor:cursor + count], tuple(range(segment["start_frame"], segment["start_frame"] + count)))
            cursor += count
            previous = selected
        self.assertEqual(plan_indices(playback, 0, "a" * 64, "b" * 64), ())

    def test_invalid_ranges_modes_and_hashes_fail_before_scheduling(self):
        invalid = [None, {}, {"mode": "ping-pong", "segments": []}, settings((2,)),
                   {"mode": "shuffle-segments-v1", "segments": [{"start_frame": 1, "end_frame": 2}, {"start_frame": 2, "end_frame": 3}]},
                   {"mode": "shuffle-segments-v1", "segments": [{"start_frame": 0, "end_frame": 2}, {"start_frame": 3, "end_frame": 4}]},
                   {"mode": "shuffle-segments-v1", "segments": [{"start_frame": 0, "end_frame": 2}, {"start_frame": 1, "end_frame": 4}]},
                   {"mode": "shuffle-segments-v1", "segments": [{"start_frame": False, "end_frame": 2}, {"start_frame": 2, "end_frame": 3}]},
                   {**settings(), "extra": 1}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_playback(value)
        for value in (-1, 1.2, True):
            with self.subTest(frames=value), self.assertRaises(ValueError):
                plan_indices(settings(), value, "a" * 64, "b" * 64)
        with self.assertRaises(ValueError):
            plan_indices(settings(), 4, "missing", "b" * 64)

    def test_indexed_sequence_reuses_objects_without_copying_the_cache(self):
        source = [object() for _ in range(24)]
        plan = plan_indices(settings(), 75, "a" * 64, "b" * 64)
        view = IndexedSequence(source, plan)
        self.assertIs(view.source, source)
        self.assertIs(view.indices, plan)
        self.assertEqual(len(view), 75)
        for index in range(len(view)):
            self.assertIs(view[index], source[plan[index]])


class Frame:
    shape = (480, 480, 3)

    def __init__(self, value):
        self.value = value

    def __getitem__(self, key):
        return self

    def tobytes(self):
        return b"x"


class Encoder:
    def __init__(self):
        self.stdin = tempfile.TemporaryFile()
        self.returncode = None

    def poll(self):
        if self.stdin.closed and self.returncode is None:
            self.returncode = 0
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return self.returncode

    def kill(self):
        self.returncode = -9


class PipePlaybackTests(unittest.TestCase):
    def run_pipe(self, cancelled=False, invalid_profile=False, delayed_consumer=False, output_frames=37):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "audio.wav"
            audio.write_bytes(b"actual narration bytes")
            cancel, blended, model_inputs = threading.Event(), [], []
            cycle = list(range(12)) + list(reversed(range(12)))
            avatar = SimpleNamespace(video_out_path=directory, idx=0,
                                     input_latent_list_cycle=[Frame(index) for index in cycle],
                                     frame_list_cycle=[Frame(index) for index in cycle],
                                     coord_list_cycle=[(index, 0, index + 1, 1) for index in cycle],
                                     mask_list_cycle=cycle[:], mask_coords_list_cycle=cycle[:],
                                     process_frames=lambda *args: None)
            original_cycles = {name: value for name, value in vars(avatar).items() if name.endswith("_cycle")}

            def datagen(conditions, latents, batch_size):
                for index in range(len(conditions)):
                    latent = latents[index % len(latents)]
                    model_inputs.append(latent.value)
                    yield latent

            def blend(frame, face, bbox, mask, mask_coords):
                self.assertEqual((frame.value, face.value, bbox[0], mask, mask_coords), (frame.value,) * 5)
                blended.append(frame.value)
                return frame

            upstream = SimpleNamespace(args=SimpleNamespace(skip_save_images=False), datagen=datagen,
                                       cv2=SimpleNamespace(resize=lambda frame, dimensions: frame),
                                       get_image_blending=blend)

            def inference(*args):
                frames = queue.Queue()
                consumer = avatar.process_frames

                def consume():
                    if delayed_consumer:
                        time.sleep(0.03)
                    consumer(frames, output_frames, True)

                avatar.consumer = threading.Thread(target=consume)
                avatar.consumer.start()
                for result in upstream.datagen(range(output_frames), avatar.input_latent_list_cycle, 3):
                    frames.put(result)
                    if cancelled:
                        cancel.set()
                avatar.consumer.join(timeout=2)

            avatar.inference = inference
            original_process = avatar.process_frames
            encoder = Encoder()
            with patch("runtime.subprocess.Popen", return_value=encoder):
                options = {"playback": settings(), "avatar_profile_sha256": "invalid" if invalid_profile else "b" * 64}
                if cancelled or invalid_profile:
                    with self.assertRaises(ValueError if invalid_profile else GenerationCancelled):
                        pipe_inference(avatar, upstream, audio, "out", 25, "libx264", cancel, **options)
                else:
                    pipe_inference(avatar, upstream, audio, "out", 25, "libx264", cancel, **options)
                    expected = plan_indices(settings(), output_frames, hashlib.sha256(audio.read_bytes()).hexdigest(), "b" * 64)
                    self.assertEqual(tuple(model_inputs), expected)
                    self.assertEqual(tuple(blended), expected)
                    self.assertEqual(avatar.idx, output_frames)
            self.assertFalse(avatar.consumer.is_alive())
            self.assertTrue(encoder.stdin.closed)
            self.assertIs(avatar.process_frames, original_process)
            self.assertIs(upstream.datagen, datagen)
            self.assertFalse(upstream.args.skip_save_images)
            for name, original in original_cycles.items():
                self.assertIs(getattr(avatar, name), original)

    def test_latents_and_all_blending_inputs_use_the_same_plan(self):
        self.run_pipe()

    def test_cancelled_generation_restores_shared_runtime_and_does_not_leave_a_consumer(self):
        self.run_pipe(cancelled=True)

    def test_plan_failure_before_model_batches_restores_runtime_and_stops_waiting_consumer(self):
        self.run_pipe(invalid_profile=True)

    def test_late_consumer_start_is_joined_after_plan_failure_and_cancellation(self):
        self.run_pipe(invalid_profile=True, delayed_consumer=True)
        self.run_pipe(cancelled=True, delayed_consumer=True)

    def test_empty_audio_features_publish_an_empty_plan_and_leave_no_waiting_consumer(self):
        self.run_pipe(output_frames=0, delayed_consumer=True)


if __name__ == "__main__":
    unittest.main()
