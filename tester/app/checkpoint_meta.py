"""Detect the checkpoint architecture and choose the right ComfyUI pipeline.

The installed models are not all SDXL. Flux2, Z-Image and Krea2 need external
text encoders / VAEs and different latent nodes. This module reads only the
safetensors header of the selected checkpoint (never the weights) and returns
a ready-to-use pipeline plan.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from .lora_zip import read_safetensors_header

_ARCH_CACHE: dict[str, str] = {}


def _checkpoint_path(name: str, loras_dir: str, loader: str = "checkpoint") -> Path | None:
    if not name:
        return None
    base = Path(loras_dir).parent
    relative = PurePosixPath(name.replace("\\", "/"))
    if relative.is_absolute() or ".." in relative.parts:
        return None
    if loader in ("unet", "gguf"):
        folders = [base / "diffusion_models", base / "unet", base / "checkpoints"]
    else:
        folders = [base / "checkpoints", base / "diffusion_models", base / "unet"]
    for folder in folders:
        candidate = folder.joinpath(*relative.parts)
        if candidate.is_file():
            return candidate
    return None


def _architecture_from_keys(keys: set[str]) -> str:
    if any(key.startswith("double_blocks") or key.startswith("single_blocks") for key in keys):
        return "flux2"
    if any("cap_embedder" in key or "context_refiner" in key for key in keys):
        return "zimage"
    if any(key.startswith("txtfusion") or key.startswith("txtmlp") for key in keys):
        return "krea2"
    return ""


def _architecture_from_name(name: str) -> str:
    lowered = name.lower()
    if any(token in lowered for token in ("flux1", "flux-1", "flux.1")):
        return "flux1"
    if "flux" in lowered:
        return "flux2"
    if any(token in lowered for token in ("zit", "z-image", "zimage", "intorealism")):
        return "zimage"
    if "krea" in lowered:
        return "krea2"
    return "standard"


def detect_architecture(name: str, loras_dir: str, loader: str = "checkpoint") -> str:
    lowered = name.lower()
    if any(token in lowered for token in ("flux1", "flux-1", "flux.1")):
        # Flux1 shares double_blocks/single_blocks tensor names with Flux2.
        return "flux1"
    path = _checkpoint_path(name, loras_dir, loader)
    if path:
        try:
            stat = path.stat()
            cache_key = f"{path}|{stat.st_mtime_ns}|{stat.st_size}"
            cached = _ARCH_CACHE.get(cache_key)
            if cached:
                return cached
            parsed = read_safetensors_header(path)
            if parsed is not None:
                _metadata, tensors = parsed
                architecture = _architecture_from_keys(set(tensors))
                if architecture:
                    _ARCH_CACHE[cache_key] = architecture
                    return architecture
        except OSError:
            pass
    return _architecture_from_name(name)


def _pick(available: list[str], preferred: list[str], token: str = "") -> tuple[str, bool]:
    lowered = {item.lower(): item for item in available}
    for candidate in preferred:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()], True
    if token:
        for item in available:
            if token in item.lower():
                return item, True
    for candidate in preferred:
        if candidate:
            return candidate, False
    return (available[0] if available else ""), False


def inspect_checkpoint(
    name: str,
    loras_dir: str,
    clip_files: list[str] | None = None,
    vae_files: list[str] | None = None,
    samplers: list[str] | None = None,
    schedulers: list[str] | None = None,
    loader: str = "checkpoint",
) -> dict:
    clip_files = clip_files or []
    vae_files = vae_files or []
    samplers = samplers or []
    schedulers = schedulers or []
    architecture = detect_architecture(name, loras_dir, loader)
    warnings: list[str] = []
    plan = {
        "architecture": architecture,
        "loader": loader,
        "supported": True,
        "unsupported_reason": "",
        "unsupported_label": "",
        "label": "Standard SD / SDXL",
        "clip_name": "",
        "clip_type": "",
        "vae_name": "",
        "clip_skip": None,
        "shift": None,
        "latent": "standard",
        "lora_mode": "model_clip",
        "steps": 30,
        "cfg": 7.0,
        "sampler": "dpmpp_2m",
        "scheduler": "karras",
        "width": 832,
        "height": 1216,
        "preset": "sdxl_portrait",
        "warnings": warnings,
    }
    if architecture == "flux1":
        plan["label"] = "Flux1 (unsupported)"

    if architecture == "flux2":
        clip_name, clip_ok = _pick(
            clip_files,
            ["qwen_3_8b_fp8mixed.safetensors", "mistral_3_small_flux2_bf16.safetensors"],
            "flux2",
        )
        vae_name, vae_ok = _pick(vae_files, ["flux2-vae.safetensors", "ae.safetensors"], "flux2")
        if not clip_ok:
            warnings.append(f"The Flux2 text encoder “{clip_name}” was not found in ComfyUI's CLIP list.")
        if not vae_ok:
            warnings.append(f"The Flux2 VAE “{vae_name}” was not found in ComfyUI's VAE list.")
        plan.update(
            {
                "label": "Flux2 / Klein",
                "clip_name": clip_name,
                "clip_type": "flux2",
                "vae_name": vae_name,
                "clip_skip": -1,
                "latent": "sd3",
                "lora_mode": "model",
                "steps": 12,
                "cfg": 1.0,
                "sampler": "euler",
                "scheduler": "simple",
                "width": 832,
                "height": 1216,
                "preset": "flux2_portrait",
            }
        )
    elif architecture == "zimage":
        clip_name, clip_ok = _pick(
            clip_files, ["qwen_3_4b.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"], "qwen_3_4b"
        )
        vae_name, vae_ok = _pick(
            vae_files, ["ae.safetensors", "ultrafluxVAEImproved_v10.safetensors"], "ae"
        )
        if not clip_ok:
            warnings.append(f"The Z-Image text encoder “{clip_name}” was not found in ComfyUI's CLIP list.")
        if not vae_ok:
            warnings.append(f"The Z-Image VAE “{vae_name}” was not found in ComfyUI's VAE list.")
        plan.update(
            {
                "label": "Z-Image / Lumina2",
                "clip_name": clip_name,
                "clip_type": "lumina2",
                "vae_name": vae_name,
                "clip_skip": None,
                "shift": 3.0,
                "latent": "sd3",
                "lora_mode": "model",
                "steps": 8,
                "cfg": 1.0,
                "sampler": "res_multistep",
                "scheduler": "simple",
                "width": 1024,
                "height": 1536,
                "preset": "zimage_portrait",
            }
        )
    elif architecture == "krea2":
        clip_name, clip_ok = _pick(
            clip_files,
            ["qwen3vl_4b_fp8_scaled.safetensors", "qwen3vl_4b_bf16.safetensors"],
            "qwen3vl",
        )
        vae_name, vae_ok = _pick(vae_files, ["qwen_image_vae.safetensors"], "qwen_image")
        if not clip_ok:
            warnings.append(f"The Krea2 text encoder “{clip_name}” was not found in ComfyUI's CLIP list.")
        if not vae_ok:
            warnings.append(f"The Krea2 VAE “{vae_name}” was not found in ComfyUI's VAE list.")
        turbo = "turbo" in name.lower()
        plan.update(
            {
                "label": "Krea2" + (" Turbo" if turbo else " Raw"),
                "clip_name": clip_name,
                "clip_type": "krea2",
                "vae_name": vae_name,
                "clip_skip": -2,
                "latent": "standard",
                "lora_mode": "model",
                "steps": 8 if turbo else 20,
                "cfg": 1.0 if turbo else 7.0,
                "sampler": "exp_heun_2_x0",
                "scheduler": "sgm_uniform",
                "width": 1024,
                "height": 1536,
                "preset": "krea2_portrait",
            }
        )

    if samplers and plan["sampler"] not in samplers:
        replacement = "euler" if "euler" in samplers else samplers[0]
        warnings.append(
            f"Sampler “{plan['sampler']}” is not available; “{replacement}” will be used."
        )
        plan["sampler"] = replacement
    if schedulers and plan["scheduler"] not in schedulers:
        replacement = "simple" if "simple" in schedulers else schedulers[0]
        warnings.append(
            f"Scheduler “{plan['scheduler']}” is not available; “{replacement}” will be used."
        )
        plan["scheduler"] = replacement
    if loader in ("unet", "gguf") and architecture not in ("flux2", "zimage", "krea2"):
        plan["supported"] = False
        if architecture == "flux1":
            reason = (
                "This is a Flux1 model. Flux1 shares tensor names with Flux2 but uses a "
                "different text encoder/pipeline; this app supports Flux2, Z-Image and Krea2 "
                "diffusion models."
            )
        else:
            reason = (
                "This diffusion model was not detected as Flux2, Z-Image or Krea2. "
                "This app auto-wires those diffusion-model families; use a full checkpoint "
                "for a standard SD/SDXL model."
            )
        plan["unsupported_reason"] = reason
        plan["unsupported_label"] = "Flux1 model" if architecture == "flux1" else "Unsupported diffusion model"
        warnings.append(reason)
    elif architecture not in ("flux2", "zimage", "krea2", "standard"):
        plan["supported"] = False
        plan["unsupported_reason"] = (
            f"{plan['label']} models are not supported by this app. Use a Flux2, Z-Image, "
            "Krea2 or standard SD/SDXL model."
        )
        plan["unsupported_label"] = f"{plan['label']} model"
        warnings.append(plan["unsupported_reason"])
    return plan
