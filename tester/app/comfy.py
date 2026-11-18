"""Minimal ComfyUI HTTP client and workflow builder."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

DEFAULT_PORTS = [8188, 8189, 8190]


class ComfyError(Exception):
    """A human-readable ComfyUI failure with optional technical detail."""

    def __init__(self, message: str, detail: str = ""):
        super().__init__(message)
        self.message = message
        self.detail = detail


class ComfyClient:
    def __init__(self, base_url: str, timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        # Never route localhost through a system proxy.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _request(
        self,
        path: str,
        payload: dict | None = None,
        method: str | None = None,
        timeout: float | None = None,
    ) -> bytes:
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            self._url(path), data=data, headers=headers, method=method or ("POST" if data else "GET")
        )
        try:
            with self._opener.open(req, timeout=timeout or self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise ComfyError(
                f"ComfyUI returned HTTP {exc.code} for {path}.",
                body[:4000],
            ) from exc
        except urllib.error.URLError as exc:
            raise ComfyError(
                f"Could not reach ComfyUI at {self.base_url}. Is it running?",
                str(exc.reason),
            ) from exc
        except TimeoutError as exc:
            raise ComfyError(
                f"ComfyUI did not answer {path} within {int(timeout or self.timeout)} seconds.",
                str(exc),
            ) from exc

    def _json(self, path: str, payload: dict | None = None, timeout: float | None = None) -> Any:
        raw = self._request(path, payload=payload, timeout=timeout)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError as exc:
            raise ComfyError(f"ComfyUI returned invalid JSON for {path}.", raw[:1000].decode("utf-8", "replace")) from exc

    def ping(self) -> bool:
        try:
            stats = self._json("/system_stats", timeout=4)
            return isinstance(stats, dict)
        except ComfyError:
            return False

    def node_info(self, node_class: str, timeout: float = 30.0) -> dict:
        data = self._json(f"/object_info/{urllib.parse.quote(node_class)}", timeout=timeout)
        if not isinstance(data, dict) or node_class not in data:
            raise ComfyError(
                f"ComfyUI does not expose the {node_class} node. Update ComfyUI or check the install.",
                str(data)[:1000],
            )
        return data[node_class]

    @staticmethod
    def _combo_options(info: dict, field: str) -> list[str]:
        try:
            options = info["input"]["required"][field][0]
        except (KeyError, IndexError, TypeError):
            return []
        if isinstance(options, list):
            return [str(item) for item in options]
        return []

    def checkpoints(self) -> list[str]:
        return self._combo_options(self.node_info("CheckpointLoaderSimple"), "ckpt_name")

    def loras(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("LoraLoader"), "lora_name")
        except ComfyError:
            return []

    def clip_files(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("CLIPLoader"), "clip_name")
        except ComfyError:
            return []

    def vae_files(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("VAELoader"), "vae_name")
        except ComfyError:
            return []

    def unet_models(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("UNETLoader"), "unet_name")
        except ComfyError:
            return []

    def gguf_models(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("UnetLoaderGGUF"), "unet_name")
        except ComfyError:
            return []

    def samplers(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("KSampler"), "sampler_name")
        except ComfyError:
            return []

    def schedulers(self) -> list[str]:
        try:
            return self._combo_options(self.node_info("KSampler"), "scheduler")
        except ComfyError:
            return []

    def gpu_name(self) -> str:
        """Name of ComfyUI's first GPU, e.g. "cuda:0 NVIDIA GeForce RTX 5070 Ti : cudaMallocAsync"."""
        try:
            stats = self._json("/system_stats")
            devices = stats.get("devices") or [] if isinstance(stats, dict) else []
            return str(devices[0].get("name") or "") if devices else ""
        except (ComfyError, AttributeError, IndexError, TypeError):
            return ""

    def submit(self, workflow: dict) -> str:
        client_id = uuid.uuid4().hex
        data = self._json("/prompt", {"prompt": workflow, "client_id": client_id}, timeout=60)
        if not isinstance(data, dict):
            raise ComfyError("ComfyUI gave an unexpected answer when queueing the prompt.", str(data)[:1000])
        if data.get("error"):
            raise ComfyError(_prompt_error_message(data), json.dumps(data)[:4000])
        prompt_id = data.get("prompt_id")
        if not prompt_id:
            raise ComfyError("ComfyUI accepted the request but returned no prompt id.", json.dumps(data)[:1000])
        return str(prompt_id)

    def history(self, prompt_id: str) -> dict | None:
        data = self._json(f"/history/{urllib.parse.quote(prompt_id)}", timeout=20)
        if isinstance(data, dict) and prompt_id in data:
            return data[prompt_id]
        return None

    def queue(self) -> dict:
        return self._json("/queue", timeout=10)

    def interrupt(self) -> None:
        try:
            self._json("/interrupt", {}, timeout=6)
        except ComfyError:
            pass

    def free_memory(self) -> None:
        """Ask ComfyUI to unload models so imported test LoRAs can be deleted."""
        try:
            self._json("/free", {"unload_models": True, "free_memory": True}, timeout=20)
        except ComfyError:
            pass

    def view_image(self, filename: str, subfolder: str = "", image_type: str = "output") -> bytes:
        query = urllib.parse.urlencode(
            {"filename": filename, "subfolder": subfolder, "type": image_type}
        )
        return self._request(f"/view?{query}", timeout=120)

    def wait_for_image(
        self,
        prompt_id: str,
        on_tick=None,
        timeout_seconds: float = 1800,
        cancel_check=None,
    ) -> list[dict]:
        """Wait for a prompt to finish and return its image descriptors."""
        started = time.time()
        last_error = ""
        while True:
            if cancel_check and cancel_check():
                self.interrupt()
                raise ComfyError("Cancelled by user.", "")
            entry = self.history(prompt_id)
            if entry is not None:
                status = entry.get("status") or {}
                status_str = status.get("status_str")
                if status_str == "error":
                    messages = status.get("messages") or []
                    last_error = json.dumps(messages)[-4000:]
                    raise ComfyError(
                        "ComfyUI failed while generating this image. The job log has the technical detail.",
                        last_error,
                    )
                outputs = entry.get("outputs") or {}
                images: list[dict] = []
                for node_output in outputs.values():
                    for image in node_output.get("images", []) or []:
                        if image.get("type") == "temp":
                            continue
                        images.append(image)
                if images:
                    return images
                if status.get("completed"):
                    raise ComfyError(
                        "ComfyUI finished the prompt but produced no image. Check the ComfyUI console.",
                        json.dumps(entry)[:4000],
                    )
            if on_tick:
                on_tick(int(time.time() - started))
            if time.time() - started > timeout_seconds:
                self.interrupt()
                raise ComfyError(
                    f"ComfyUI did not finish this image within {int(timeout_seconds / 60)} minutes.",
                    last_error,
                )
            time.sleep(0.8)


def _prompt_error_message(data: dict) -> str:
    error = data.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("type") or "ComfyUI rejected the prompt."
        details = error.get("details")
        if details:
            message = f"{message} {details}"
        return str(message)
    if isinstance(error, str):
        return error
    node_errors = data.get("node_errors")
    if node_errors:
        return f"ComfyUI rejected the prompt: {json.dumps(node_errors)[:400]}"
    return "ComfyUI rejected the prompt for an unknown reason."


def _model_loader_node(loader: str, model_name: str) -> dict:
    if loader == "unet":
        return {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": model_name, "weight_dtype": "default"},
        }
    if loader == "gguf":
        return {
            "class_type": "UnetLoaderGGUF",
            "inputs": {"unet_name": model_name},
        }
    return {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model_name}}


def build_workflow_for_architecture(
    *,
    architecture: str,
    checkpoint: str,
    lora_name: str,
    strength: float,
    positive: str,
    negative: str,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    sampler: str,
    scheduler: str,
    seed: int,
    filename_prefix: str,
    clip_name: str = "",
    clip_type: str = "",
    vae_name: str = "",
    clip_skip: int | None = None,
    shift: float | None = None,
    latent: str = "standard",
    model_loader: str = "checkpoint",
) -> dict:
    """Build the correct ComfyUI graph for the detected checkpoint family."""
    loader_node = _model_loader_node(model_loader, checkpoint)
    if architecture == "flux2":
        return {
            "1": loader_node,
            "2": {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {
                    "model": ["1", 0],
                    "lora_name": lora_name,
                    "strength_model": float(strength),
                },
            },
            "3": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": clip_name, "type": clip_type or "flux2", "device": "default"},
            },
            "4": {
                "class_type": "CLIPSetLastLayer",
                "inputs": {"clip": ["3", 0], "stop_at_clip_layer": int(clip_skip if clip_skip is not None else -1)},
            },
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 0]}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 0]}},
            "7": {
                "class_type": "EmptySD3LatentImage" if latent == "sd3" else "EmptyLatentImage",
                "inputs": {"width": int(width), "height": int(height), "batch_size": 1},
            },
            "8": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["5", 0],
                    "negative": ["6", 0],
                    "latent_image": ["7", 0],
                    "seed": int(seed),
                    "steps": int(steps),
                    "cfg": float(cfg),
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                },
            },
            "9": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
            "10": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["9", 0]}},
            "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": filename_prefix}},
        }

    if architecture == "zimage":
        return {
            "1": loader_node,
            "2": {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {
                    "model": ["1", 0],
                    "lora_name": lora_name,
                    "strength_model": float(strength),
                },
            },
            "3": {
                "class_type": "ModelSamplingAuraFlow",
                "inputs": {"model": ["2", 0], "shift": float(shift if shift is not None else 3.0)},
            },
            "4": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": clip_name, "type": clip_type or "lumina2", "device": "default"},
            },
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 0]}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 0]}},
            "7": {
                "class_type": "EmptySD3LatentImage" if latent == "sd3" else "EmptyLatentImage",
                "inputs": {"width": int(width), "height": int(height), "batch_size": 1},
            },
            "8": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["3", 0],
                    "positive": ["5", 0],
                    "negative": ["6", 0],
                    "latent_image": ["7", 0],
                    "seed": int(seed),
                    "steps": int(steps),
                    "cfg": float(cfg),
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                },
            },
            "9": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
            "10": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["9", 0]}},
            "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": filename_prefix}},
        }

    if architecture == "krea2":
        return {
            "1": loader_node,
            "2": {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {
                    "model": ["1", 0],
                    "lora_name": lora_name,
                    "strength_model": float(strength),
                },
            },
            "3": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": clip_name, "type": clip_type or "krea2", "device": "default"},
            },
            "4": {
                "class_type": "CLIPSetLastLayer",
                "inputs": {"clip": ["3", 0], "stop_at_clip_layer": int(clip_skip if clip_skip is not None else -2)},
            },
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 0]}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["4", 0]}},
            "7": {
                "class_type": "EmptySD3LatentImage" if latent == "sd3" else "EmptyLatentImage",
                "inputs": {"width": int(width), "height": int(height), "batch_size": 1},
            },
            "8": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["5", 0],
                    "negative": ["6", 0],
                    "latent_image": ["7", 0],
                    "seed": int(seed),
                    "steps": int(steps),
                    "cfg": float(cfg),
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                },
            },
            "9": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
            "10": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["9", 0]}},
            "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": filename_prefix}},
        }

    if architecture == "moss":
        # As ComfyUI's image_moss_image_t2i template, without its optional prompt enhancer,
        # so every LoRA and strength gets exactly the same prompt.
        return {
            "1": loader_node,
            "2": {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {"model": ["1", 0], "lora_name": lora_name, "strength_model": float(strength)},
            },
            "3": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": clip_name, "type": clip_type or "moss_image", "device": "default"},
            },
            "5": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["3", 0]}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["3", 0]}},
            "7": {
                "class_type": "EmptyFlux2LatentImage",
                "inputs": {"width": int(width), "height": int(height), "batch_size": 1},
            },
            "8": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["5", 0],
                    "negative": ["6", 0],
                    "latent_image": ["7", 0],
                    "seed": int(seed),
                    "steps": int(steps),
                    "cfg": float(cfg),
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                },
            },
            "9": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
            "10": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["9", 0]}},
            "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": filename_prefix}},
        }

    if architecture == "h3image":
        # As ComfyUI's image_minimax_h3_image_t2i template, without its optional prompt enhancer.
        # MiniMaxH3ImageConditioning returns the positive conditioning and the empty image latent;
        # the negative is that conditioning zeroed out (the model runs at CFG 1). The negative
        # prompt text is still recorded in the image metadata and sidecars.
        return {
            "1": loader_node,
            "2": {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {"model": ["1", 0], "lora_name": lora_name, "strength_model": float(strength)},
            },
            "3": {
                "class_type": "CLIPLoader",
                "inputs": {"clip_name": clip_name, "type": clip_type or "minimax", "device": "default"},
            },
            "9": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
            "5": {
                "class_type": "MiniMaxH3ImageConditioning",
                "inputs": {"clip": ["3", 0], "vae": ["9", 0], "prompt": positive, "width": int(width), "height": int(height)},
            },
            "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
            "8": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["5", 0],
                    "negative": ["6", 0],
                    "latent_image": ["5", 1],
                    "seed": int(seed),
                    "steps": int(steps),
                    "cfg": float(cfg),
                    "sampler_name": sampler,
                    "scheduler": scheduler,
                    "denoise": 1.0,
                },
            },
            "10": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["9", 0]}},
            "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": filename_prefix}},
        }

    if model_loader != "checkpoint":
        raise ComfyError(
            "This diffusion model does not have a detected Flux2, Z-Image, Krea2, MOSS-Image or "
            "MiniMax H3 Image pipeline. Use a full checkpoint for standard SD/SDXL models."
        )
    return build_workflow(
        checkpoint=checkpoint,
        lora_name=lora_name,
        strength=strength,
        positive=positive,
        negative=negative,
        width=width,
        height=height,
        steps=steps,
        cfg=cfg,
        sampler=sampler,
        scheduler=scheduler,
        seed=seed,
        filename_prefix=filename_prefix,
    )


def build_workflow(
    *,
    checkpoint: str,
    lora_name: str,
    strength: float,
    positive: str,
    negative: str,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    sampler: str,
    scheduler: str,
    seed: int,
    filename_prefix: str,
) -> dict:
    """Standard all-in-one checkpoint workflow with one LoRA."""
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["1", 0],
                "clip": ["1", 1],
                "lora_name": lora_name,
                "strength_model": float(strength),
                "strength_clip": float(strength),
            },
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": positive, "clip": ["2", 1]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["2", 1]},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": int(width), "height": int(height), "batch_size": 1},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
                "seed": int(seed),
                "steps": int(steps),
                "cfg": float(cfg),
                "sampler_name": sampler,
                "scheduler": scheduler,
                "denoise": 1.0,
            },
        },
        "7": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["6", 0], "vae": ["1", 2]},
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {"images": ["7", 0], "filename_prefix": filename_prefix},
        },
    }


def discover_comfy_url(configured: str = "") -> tuple[str, bool]:
    """Return (url, online). Tries the configured URL, then standard local ports."""
    candidates: list[str] = []
    if configured:
        candidates.append(configured.rstrip("/"))
    for port in DEFAULT_PORTS:
        url = f"http://127.0.0.1:{port}"
        if url not in candidates:
            candidates.append(url)
    for url in candidates:
        if ComfyClient(url).ping():
            return url, True
    return (candidates[0] if candidates else "http://127.0.0.1:8188"), False
