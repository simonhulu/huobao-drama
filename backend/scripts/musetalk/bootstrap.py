"""Prepare a MuseTalk runtime by reusing the existing GPU Python packages."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


VAE_SHA256 = "a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815"
VAE_SIZE = 334643276
WEIGHTS = [
    ("AI-ModelScope/MuseTalk", "musetalkV15/musetalk.json", "musetalkV15/musetalk.json", 748,
     "5b6923aee04d71692e0e9846c471e0a4ea07a4f686d39545e472bd4ba17e1b47"),
    ("AI-ModelScope/MuseTalk", "musetalkV15/unet.pth", "musetalkV15/unet.pth", 3400074924,
     "7ebf6c98c181e20838e4c0054e96e944ac60d5d692cc01db42839fe11b787007"),
    ("openai-mirror/whisper-tiny", "config.json", "whisper/config.json", 1983,
     "ffdccec4f3211f4c63310f2b7098f309fe70f3952cedc5e4d11e43f5b2379b98"),
    ("openai-mirror/whisper-tiny", "preprocessor_config.json", "whisper/preprocessor_config.json", 184990,
     "9b5cd03a36fbb8a627c64d98a5b5b126ead95a77720723944487311f0110b666"),
    ("openai-mirror/whisper-tiny", "pytorch_model.bin", "whisper/pytorch_model.bin", 151095027,
     "9607f98a2b22d9e229ae43c52ecea79dcede9e0c5cfae67e8da6eda86d8aac1d"),
    ("xiaolaowx/UniAnimate-DiT", "dw-ll_ucoco_384.onnx", "dwpose/dw-ll_ucoco_384.onnx", 134399116,
     "724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843"),
    ("aile1997/face-parse-bisenet", "79999_iter.pth", "face-parse-bisent/79999_iter.pth", 53289463,
     "468e13ca13a9b43cc0881a9f99083a430e9c0a38abd935431d1c28ee94b26567"),
    ("aile1997/face-parse-bisenet", "resnet18-5c106cde.pth", "face-parse-bisent/resnet18-5c106cde.pth", 46827520,
     "5c106cde386e87d4033832f2996f5493238eda96ccf559d1d62760c4de0613f8"),
    ("HaveAnApplePie/s3fd-619a316812", "s3fd-619a316812.pth", ".torch/hub/checkpoints/s3fd-619a316812.pth", 89843225,
     "619a31681264d3f7f7fc7a16a42cbbe8b23f31a256f75a366e5a1bcd59b33543"),
]
PURE_PYTHON_PACKAGES = {
    "omegaconf": "omegaconf==2.3.0",
    "antlr4": "antlr4-python3-runtime==4.9.3",
    "einops": "einops==0.8.1",
    "ffmpeg": "ffmpeg-python==0.2.0",
    "future": "future==1.0.0",
    "requests": "requests==2.32.4",
    "filelock": "filelock==3.18.0",
    "tqdm": "tqdm==4.67.1",
    "packaging": "packaging==25.0",
    "typing_extensions": "typing_extensions==4.14.0",
    "imageio": "imageio==2.37.0",
}


def run(argv, **kwargs):
    print("RUN", " ".join(str(value) for value in argv), flush=True)
    return subprocess.run([str(value) for value in argv], check=True, **kwargs)


def digest(filename):
    sha = hashlib.sha256()
    with Path(filename).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def install(args):
    probe = run([args.source_python, "-c", (
        "import json, site, sys; from pathlib import Path; import torch; "
        "version = f'{sys.version_info.major}.{sys.version_info.minor}'; "
        "paths = site.getsitepackages() + [str(Path(sys.base_prefix) / 'lib' / ('python' + version) / 'site-packages')]; "
        "print(json.dumps({'version': version, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix, "
        "'site_packages': list(dict.fromkeys(p for p in paths if Path(p).is_dir())), "
        "'torch': torch.__version__, 'torch_path': torch.__file__}))"
    )], capture_output=True, text=True)
    source = json.loads(probe.stdout)
    if args.environment.resolve() in (Path(source["prefix"]).resolve(), Path(source["base_prefix"]).resolve()):
        raise RuntimeError("The MuseTalk runtime must be separate from the existing GPU environment")
    python = args.environment / "bin/python"
    if not python.exists():
        run([args.source_python, "-m", "venv", "--system-site-packages", args.environment])
    version = run([python, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
                  capture_output=True, text=True).stdout.strip()
    if version != source["version"]:
        raise RuntimeError("Existing MuseTalk runtime has a different Python ABI; choose a fresh runtime path")
    packages = args.environment / "lib" / f"python{version}" / "site-packages"
    packages.mkdir(parents=True, exist_ok=True)
    # A venv made from another venv does not inherit that venv's package directory.
    (packages / "musetalk-reused-packages.pth").write_text("\n".join(source["site_packages"]) + "\n")
    modules = json.dumps(list(PURE_PYTHON_PACKAGES))
    missing = json.loads(run([python, "-c", (
        "import importlib.util, json; "
        f"print(json.dumps([name for name in {modules} if importlib.util.find_spec(name) is None]))"
    )], capture_output=True, text=True).stdout)
    if missing:
        run([python, "-m", "pip", "--disable-pip-version-check", "install", "--no-deps",
             "--no-cache-dir", "--progress-bar", "off", *[PURE_PYTHON_PACKAGES[name] for name in missing]])
    (args.environment / "runtime-reuse.json").write_text(json.dumps({
        "source_python": str(args.source_python), "source": source,
        "installed_pure_python_packages": [PURE_PYTHON_PACKAGES[name] for name in missing],
    }, indent=2) + "\n")
    print("REUSE_OK", source["torch"], source["torch_path"], flush=True)


def verify_file(filename, expected_size, expected_sha256):
    filename = Path(filename)
    if not filename.is_file() or filename.stat().st_size != expected_size:
        raise RuntimeError(f"Missing or incomplete model file: {filename}")
    actual = digest(filename)
    if actual != expected_sha256:
        raise RuntimeError(f"Model SHA-256 mismatch: {filename}")
    return {"size": expected_size, "sha256": actual}


def download_weight(models, asset, aria2):
    repository, source_path, local_path, size, sha256 = asset
    filename = models / local_path
    url = f"https://modelscope.cn/models/{repository}/resolve/master/{source_path}"
    if filename.exists():
        try:
            verified = verify_file(filename, size, sha256)
            print("REUSE_WEIGHT", local_path, flush=True)
            return {**verified, "repository": repository, "source_url": url}
        except RuntimeError:
            print("REPLACE_INVALID_WEIGHT", local_path, flush=True)
    if not shutil.which(aria2):
        raise RuntimeError("aria2c is required to download missing model files")
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = filename.with_suffix(filename.suffix + ".partial")
    run([aria2, "--continue=true", "--allow-overwrite=true", "--auto-file-renaming=false",
         "--file-allocation=none", "--max-connection-per-server=16", "--split=16",
         "--min-split-size=1M", "--connect-timeout=15", "--timeout=60", "--max-tries=3",
         "--retry-wait=2", "--summary-interval=15", f"--checksum=sha-256={sha256}",
         f"--dir={filename.parent}", f"--out={temporary.name}", url])
    verified = verify_file(temporary, size, sha256)
    temporary.replace(filename)
    return {**verified, "repository": repository, "source_url": url}


def download_weights(args):
    models = args.root / "models"
    models.mkdir(parents=True, exist_ok=True)
    record = {"version": 1, "status": "preparing", "started_at": time.time(), "files": {}}
    manifest = models / "bootstrap-manifest.json"

    def save():
        temporary = manifest.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(manifest)

    save()
    for asset in WEIGHTS:
        record["files"][asset[2]] = download_weight(models, asset, args.aria2)
        save()

    vae = models / "sd-vae"
    shared = args.shared_vae.resolve()
    verified_vae = verify_file(shared / "diffusion_pytorch_model.safetensors", VAE_SIZE, VAE_SHA256)
    config = shared / "config.json"
    if json.loads(config.read_text()).get("_class_name") != "AutoencoderKL":
        raise RuntimeError("The shared VAE config is not an AutoencoderKL config")
    if not vae.exists() and not vae.is_symlink():
        vae.symlink_to(shared, target_is_directory=True)
    if vae.resolve() != shared:
        raise RuntimeError("The MuseTalk VAE path already points to a different model")
    record["files"]["sd-vae/diffusion_pytorch_model.safetensors"] = {
        **verified_vae, "source_path": str(shared / "diffusion_pytorch_model.safetensors"),
    }
    record["files"]["sd-vae/config.json"] = {
        "size": config.stat().st_size, "sha256": digest(config), "source_path": str(config),
    }
    converted = models / "face-parse-bisent/resnet18-state-dict.pth"
    if converted.is_file():
        record["files"]["face-parse-bisent/resnet18-state-dict.pth"] = {
            "size": converted.stat().st_size, "sha256": digest(converted),
            "derived_from": "face-parse-bisent/resnet18-5c106cde.pth",
        }
    record.update(status="completed", completed_at=time.time())
    save()


def check(args):
    os.chdir(args.root)
    os.environ["TORCH_HOME"] = str(args.root / "models/.torch")
    import torch
    import onnxruntime
    import numpy as np
    from diffusers import AutoencoderKL
    from transformers import WhisperModel

    print(json.dumps({"python": sys.version, "torch": torch.__version__, "cuda": torch.version.cuda,
                      "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                      "torch_path": torch.__file__, "onnxruntime": onnxruntime.__version__,
                      "onnx_providers": onnxruntime.get_available_providers()}), flush=True)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable in the isolated MuseTalk environment")
    sample = torch.ones((2, 2), device="cuda")
    if not torch.isfinite(sample @ sample).all().item():
        raise RuntimeError("Existing PyTorch CUDA operation produced invalid values")
    models = args.root / "models"
    for _, _, relative, size, sha256 in WEIGHTS:
        verify_file(models / relative, size, sha256)
    verify_file(models / "sd-vae/diffusion_pytorch_model.safetensors", VAE_SIZE, VAE_SHA256)
    vae = AutoencoderKL.from_pretrained(args.root / "models/sd-vae", local_files_only=True)
    whisper = WhisperModel.from_pretrained(args.root / "models/whisper", local_files_only=True)
    del vae, whisper
    for relative in ["musetalkV15/unet.pth", "face-parse-bisent/79999_iter.pth",
                     ".torch/hub/checkpoints/s3fd-619a316812.pth", "face-parse-bisent/resnet18-5c106cde.pth"]:
        # The fixed-hash official ResNet18 is a legacy tar checkpoint.
        trusted_legacy = relative == "face-parse-bisent/resnet18-5c106cde.pth"
        weights = torch.load(models / relative, map_location="cpu", weights_only=not trusted_legacy)
        if not isinstance(weights, dict) or not weights:
            raise RuntimeError(f"Model checkpoint is not a populated state dict: {relative}")
        del weights
    if "CPUExecutionProvider" not in onnxruntime.get_available_providers():
        raise RuntimeError("ONNX Runtime does not support the CPU execution provider")
    session_options = onnxruntime.SessionOptions()
    session_options.intra_op_num_threads = 4
    session_options.inter_op_num_threads = 1
    session = onnxruntime.InferenceSession(str(models / "dwpose/dw-ll_ucoco_384.onnx"),
                                          sess_options=session_options, providers=["CPUExecutionProvider"])
    outputs = session.run(None, {session.get_inputs()[0].name: np.zeros((1, 3, 384, 288), dtype=np.float32)})
    if not outputs or any(not np.isfinite(output).all() for output in outputs):
        raise RuntimeError("DWPose CPU ONNX inference produced invalid values")
    print("CHECK_OK all weights verified and loadable; reused PyTorch CUDA and DWPose CPU ONNX inference work", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/root/rivermind-data/MuseTalk"))
    parser.add_argument("--source-python", type=Path, default=Path("/root/rivermind-data/latentsync-venv/bin/python"))
    parser.add_argument("--environment", type=Path, default=Path("/root/rivermind-data/musetalk-runtime"))
    parser.add_argument("--shared-vae", type=Path, default=Path("/root/rivermind-data/models/sd-vae-ft-mse"))
    parser.add_argument("--aria2", default="aria2c", help="aria2c executable for the explicit weights phase")
    parser.add_argument("--phase", choices=("all", "environment", "weights", "check"), default="environment")
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error("--root must be an existing official MuseTalk checkout")
    if args.phase in ("all", "environment"):
        install(args)
    if args.phase in ("all", "weights", "check") and Path(sys.executable).absolute() != (args.environment / "bin/python").absolute():
        run([args.environment / "bin/python", Path(__file__).resolve(), *sys.argv[1:], "--phase",
             "weights" if args.phase == "all" else args.phase])
        if args.phase == "all":
            run([args.environment / "bin/python", Path(__file__).resolve(), *sys.argv[1:], "--phase", "check"])
        return
    if args.phase in ("all", "weights"):
        download_weights(args)
    if args.phase in ("all", "check"):
        check(args)


if __name__ == "__main__":
    main()
