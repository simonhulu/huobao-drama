"""Deterministic forward-only segment scheduling for opt-in gesture banks."""

import hashlib
import json
import random
import re


MODE = "shuffle-segments-v1"


def validate_playback(value):
    if not isinstance(value, dict) or set(value) != {"mode", "segments"} or value["mode"] != MODE:
        raise ValueError("Playback requires shuffle-segments-v1 and segments")
    segments = value["segments"]
    if not isinstance(segments, list) or len(segments) < 2:
        raise ValueError("Shuffle playback requires at least two segments")
    normalized, end = [], 0
    for segment in segments:
        if not isinstance(segment, dict) or set(segment) != {"start_frame", "end_frame"}:
            raise ValueError("Each playback segment requires start_frame and end_frame")
        start, stop = segment["start_frame"], segment["end_frame"]
        if type(start) is not int or type(stop) is not int or start != end or stop <= start:
            raise ValueError("Playback segments must be nonempty contiguous integer ranges starting at zero")
        normalized.append({"start_frame": start, "end_frame": stop})
        end = stop
    return {"mode": MODE, "segments": normalized}


def plan_indices(playback, output_frames, audio_sha256, avatar_profile_sha256):
    playback = validate_playback(playback)
    if type(output_frames) is not int or output_frames < 0:
        raise ValueError("Playback output_frames must be a nonnegative integer")
    if not all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
               for value in (audio_sha256, avatar_profile_sha256)):
        raise ValueError("Playback requires narration and avatar profile SHA-256 hashes")
    seed = hashlib.sha256(json.dumps([MODE, audio_sha256, avatar_profile_sha256],
                                    separators=(",", ":")).encode("ascii")).digest()
    generator = random.Random(int.from_bytes(seed, "big"))
    segments, indices, previous = playback["segments"], [], None
    while len(indices) < output_frames:
        order = list(range(len(segments)))
        generator.shuffle(order)
        if order[0] == previous:
            order[0], order[1] = order[1], order[0]
        for selected in order:
            segment = segments[selected]
            stop = min(segment["end_frame"], segment["start_frame"] + output_frames - len(indices))
            indices.extend(range(segment["start_frame"], stop))
            previous = selected
            if len(indices) == output_frames:
                return tuple(indices)
    return tuple(indices)


class IndexedSequence:
    """Expose a planned cache order without copying any frames or latent tensors."""

    def __init__(self, source, indices):
        self.source = source
        self.indices = indices

    def __len__(self):
        return len(self.indices)

    def __getitem__(self, index):
        return self.source[self.indices[index]]
