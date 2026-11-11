"""Stage the three approved Xiaolu intro/avatar pairs without deploying them."""

import argparse
import copy
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[3]
BODY = Path("outputs/presenter-videos/xiaolu-body-20261111")
INTROS = Path("outputs/presenter-videos/xiaolu-20261110")
ORIGINAL_REFERENCE = "/root/rivermind-data/musetalk-reference-halfbody-20261109/presenter-halfbody-720-25fps.mp4"
ORIGINAL_SHA256 = "24061ae64e50f01b699c127cefa84d5d1add887e30ea42f55b480becdccd8bd2"
ORIGINAL_DEFAULT_ID = "xiaolu-r4-399b54766505cd364b59ba7e"
TARGET_ROOT = "/Volumes/wd3/huobao-drama/data/science-presenter"
GPU_ROOT = "/root/rivermind-data/MuseTalk/science-presenter-20261111"
SETS = [
    {"id": "original", "intro": Path("data/science-pop/assets/xiaolu-intro.mp4"),
     "avatar": "xiaolu-original-approved-20261111"},
    {"id": "01", "intro": INTROS / "xiaolu-01-new-dialogue-review.mp4",
     "reference": BODY / "xiaolu-01-body-bank-corrected.mp4", "avatar": "xiaolu-01-body-approved-20261111"},
    {"id": "02", "intro": INTROS / "xiaolu-02-new-dialogue-review.mp4",
     "reference": BODY / "xiaolu-02-body-bank.mp4", "avatar": "xiaolu-02-body-approved-20261111"},
]


def digest(filename):
    with Path(filename).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def load(filename):
    return json.loads(Path(filename).read_text())


def probe(filename, *, intro):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(filename),
    ], check=True, capture_output=True, text=True, timeout=180)
    media = json.loads(result.stdout)
    videos = [stream for stream in media["streams"] if stream["codec_type"] == "video"]
    if len(videos) != 1:
        raise ValueError(f"Exactly one video stream required: {filename}")
    video = videos[0]
    duration = float(video.get("duration", media["format"]["duration"]))
    rotations = [item["rotation"] for item in video.get("side_data_list", []) if "rotation" in item]
    if not math.isfinite(duration) or duration <= 0 or any(float(value) % 360 for value in rotations):
        raise ValueError(f"A positive upright video is required: {filename}")
    audio = any(stream["codec_type"] == "audio" for stream in media["streams"])
    fps = Fraction(video["avg_frame_rate"])
    frames = int(video["nb_read_frames"])
    if intro:
        if video["width"] * 9 != video["height"] * 16 or not audio:
            raise ValueError(f"Ready intros must be 16:9 with audio: {filename}")
    elif (video["width"], video["height"], frames, fps, audio) != (480, 480, 1508, Fraction(25), False):
        raise ValueError(f"Gesture references must be 480 square, 1508 frames at 25 fps, without audio: {filename}")
    if not intro and (Fraction(video["r_frame_rate"]) != fps or abs(duration - 60.32) > .001):
        raise ValueError(f"Gesture-reference timing changed: {filename}")
    return {"width": video["width"], "height": video["height"], "frames": frames,
            "fps": str(fps), "duration_seconds": duration, "audio": audio}


def absolute_root(value):
    result = PurePosixPath(value)
    if not result.is_absolute() or ".." in result.parts or str(result) != value.rstrip("/"):
        raise ValueError("Deployment roots must be normalized absolute POSIX paths")
    return result


def merge_additions(existing, additions):
    """Return an additive registry; caller publishes it beside the existing registry."""
    for registry in (existing, additions):
        if not isinstance(registry, dict) or set(registry) != {"avatars"} or not isinstance(registry["avatars"], dict):
            raise ValueError("Avatar registries must contain only an avatars object")
    merged = copy.deepcopy(existing)
    for avatar, entry in additions["avatars"].items():
        if avatar in merged["avatars"] and merged["avatars"][avatar] != entry:
            raise ValueError(f"Existing avatar preserved; conflicting addition: {avatar}")
        merged["avatars"][avatar] = copy.deepcopy(entry)
    return merged


def repair_evidence(root):
    corrected = root / BODY / "xiaolu-01-body-bank-corrected.mp4"
    receipt = load(f"{corrected}.repair.json")
    raw = root / BODY / "xiaolu-01-body-bank.mp4"
    plate = root / BODY / "xiaolu-01-clean-background-plate.png"
    if (receipt.get("version") != 2 or receipt.get("output_sha256") != digest(corrected)
            or receipt.get("input_sha256") != digest(raw) or receipt.get("reference_sha256") != digest(plate)
            or receipt.get("frames") != 1508 or receipt.get("fps") != "25"):
        raise ValueError("Corrected reference is not bound to its original bank and clean-background plate")
    return receipt


def publish(source, destination):
    if destination.exists():
        if digest(source) != digest(destination):
            raise FileExistsError(f"Existing different bundle file preserved: {destination}")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.link(source, destination)


def stage(root, output, target_root=TARGET_ROOT, gpu_root=GPU_ROOT, existing_registry=None):
    root, output = Path(root).resolve(), Path(output).resolve()
    target, gpu = absolute_root(target_root), absolute_root(gpu_root)
    corrected_receipt = repair_evidence(root)
    library = {"version": 1, "character": "science", "presenter": "xiaolu", "clips": []}
    additions = {"avatars": {}}
    files, inputs, pairs = [], [], []
    playback = {"mode": "shuffle-segments-v1", "segments": [
        {"start_frame": number * 377, "end_frame": (number + 1) * 377} for number in range(4)
    ]}
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".science-bundle-", dir=output) as temporary:
        temporary = Path(temporary)
        staged = []

        def add_file(relative, *, source=None, data=None, host=None, remote=None):
            filename = temporary / relative
            filename.parent.mkdir(parents=True, exist_ok=True)
            if source is not None:
                sha = digest(source)
                shutil.copyfile(source, filename)
                if digest(filename) != sha:
                    raise RuntimeError(f"Source changed while staging: {source}")
                inputs.append({"path": str(source), "sha256": sha})
            else:
                filename.write_bytes(data)
                sha = digest(filename)
            record = {"path": str(relative), "sha256": sha, "bytes": filename.stat().st_size}
            if host:
                record.update(deploy_host=host, deploy_path=str(remote))
            files.append(record)
            staged.append((filename, output / relative))
            return sha

        for item in SETS:
            intro = root / item["intro"]
            media = probe(intro, intro=True)
            intro_relative = Path("intros") / f"xiaolu-{item['id']}-intro.mp4"
            intro_target = target / intro_relative.as_posix()
            intro_sha = add_file(intro_relative, source=intro, host="107", remote=intro_target)
            if "reference" in item:
                reference = root / item["reference"]
                reference_media = probe(reference, intro=False)
                reference_relative = Path("gpu-references") / f"{item['avatar']}.mp4"
                reference_target = str(gpu / reference_relative.as_posix())
                reference_sha = add_file(reference_relative, source=reference, host="gpu", remote=reference_target)
                entry = {"reference": reference_target, "reference_sha256": reference_sha, "playback": playback}
            else:
                reference_media = {"fps": "25", "local_reference_copy": False, "deployment_hash_recheck_required": True}
                reference_target, reference_sha = ORIGINAL_REFERENCE, ORIGINAL_SHA256
                entry = {"reference": reference_target, "reference_sha256": reference_sha}
            additions["avatars"][item["avatar"]] = entry
            identity = {"version": 1, "character": "science", "presenter": "xiaolu", "setId": item["id"],
                        "videoSha256": intro_sha, "avatarId": item["avatar"], "referenceSha256": reference_sha,
                        **({"playback": playback} if "reference" in item else {})}
            fingerprint = hashlib.sha256(canonical(identity)).hexdigest()
            library["clips"].append({
                "character": "science", "presenter": "xiaolu", "status": "ready", "setId": item["id"],
                "fingerprint": fingerprint, "videoPath": str(intro_target), "videoSha256": intro_sha,
                "avatarId": item["avatar"], "referenceSha256": reference_sha,
            })
            pairs.append({"setId": item["id"], "intro_media": media, "reference_media": reference_media,
                          "avatar_id": item["avatar"], "reference": reference_target, "fingerprint": fingerprint})
        add_file(Path("ready-science-xiaolu.json"), data=canonical(library) + b"\n", host="107",
                 remote=target / "ready-science-xiaolu.json")
        add_file(Path("avatars.additions.json"), data=canonical(additions) + b"\n")
        if existing_registry:
            add_file(Path("avatars.merged.json"), data=canonical(merge_additions(load(existing_registry), additions)) + b"\n")
        add_file(Path("provenance/corrected-01-repair.json"), data=canonical(corrected_receipt) + b"\n")
        plate_provenance = root / BODY / "xiaolu-01-clean-background-plate.json"
        if plate_provenance.exists():
            add_file(Path("provenance/clean-background-plate.json"), source=plate_provenance)
        manifest = {
            "version": 1, "status": "staged-ready-for-deployment", "character": "science", "presenter": "xiaolu",
            "production_deployment_performed": False, "target_root": str(target), "gpu_target_root": str(gpu),
            "original_default_preserved": {"avatar_id": ORIGINAL_DEFAULT_ID, "reference": ORIGINAL_REFERENCE,
                                           "reference_sha256": ORIGINAL_SHA256, "deployment_hash_recheck_required": True},
            "registry_policy": "Add missing aliases only; refuse conflicting entries; preserve all existing avatars and default startup arguments",
            "pairs": pairs, "inputs": inputs, "files": files.copy(),
            "fingerprint": hashlib.sha256(canonical({"library": library, "additions": additions})).hexdigest(),
        }
        add_file(Path("manifest.json"), data=canonical(manifest) + b"\n")
        readme = (
            "# Approved Science Presenter Bundle\n\n"
            "Three ready matched sets: original, 01 and 02. This directory is staged, not deployed.\n\n"
            f"107 asset root: `{target}`\nGPU reference root: `{gpu}`\n\n"
            "Deploy files only to their manifest deploy_path. Recheck all uploaded SHA-256 hashes.\n"
            "Original reference stays on the GPU server; verify its recorded hash before admitting the library.\n"
            "Merge avatars.additions.json into the existing registry with add-only conflict checks. Do not replace\n"
            "the registry with the additions alone. Keep existing default startup reference and all user avatars.\n"
            "If using avatars.merged.json, install beside the old registry so its relative references retain meaning.\n"
            "The corrected 01 bank is the actual MuseTalk reference, before cache construction; no postprocess is needed.\n"
            "Both new banks retain 1508 frames, 25fps and four [0,377), [377,754), [754,1131), [1131,1508) shuffle segments.\n"
            "No GPU model was launched and no deployed registry or runtime was changed by this packer.\n\n"
            "Rebuild with backend/scripts/presenter-factory/prepare_science_library.py --output-dir THIS_DIRECTORY\n"
            "and the same --target-root / --gpu-target-root values. Reruns preserve differing existing files.\n"
        )
        add_file(Path("README.md"), data=readme.encode())
        for source, destination in staged:
            if destination.exists() and digest(source) != digest(destination):
                raise FileExistsError(f"Existing different bundle file preserved: {destination}")
        for source, destination in staged:
            publish(source, destination)
    return {"manifest": str(output / "manifest.json"), "library": str(output / "ready-science-xiaolu.json"),
            "registry_additions": str(output / "avatars.additions.json"), "fingerprint": manifest["fingerprint"],
            "files": files, "pairs": pairs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--target-root", default=TARGET_ROOT)
    parser.add_argument("--gpu-target-root", default=GPU_ROOT)
    parser.add_argument("--existing-avatar-registry", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(stage(arguments.repo_root, arguments.output_dir, arguments.target_root,
                           arguments.gpu_target_root, arguments.existing_avatar_registry), indent=2))


if __name__ == "__main__":
    main()
