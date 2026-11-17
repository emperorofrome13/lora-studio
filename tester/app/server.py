"""Flask server for LoRA Tester."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from . import __version__
from .checkpoint_meta import inspect_checkpoint
from .comfy import ComfyClient, ComfyError, discover_comfy_url
from .config import (
    APP_VERSION,
    DATA_DIR,
    DOWNLOAD_DIR,
    OUTPUT_DIR,
    STATIC_DIR,
    UPLOAD_DIR,
    ConfigStore,
    ensure_dirs,
    public_defaults,
)
from .detect import detect_loras_dir, invalidate_detection
from .jobs import JobManager
from .lora_zip import (
    IMPORT_DIR,
    LORA_EXTENSIONS,
    import_lora_file,
    import_zip,
    list_manifests,
    load_manifest,
    remove_import,
    remove_lora,
    resolve_import_file,
    resolve_lora,
)
from .prompts import DEFAULT_NEGATIVE, DEFAULT_PROMPTS, STRENGTHS

ALLOWED_STRENGTHS = STRENGTHS
MAX_PROMPTS = 20
MAX_PROMPT_CHARS = 50000
MAX_NEGATIVE_CHARS = 20000
MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
FALLBACK_SAMPLERS = [
    "euler",
    "euler_ancestral",
    "dpmpp_2m",
    "dpmpp_2m_sde",
    "dpmpp_sde",
    "ddim",
    "uni_pc",
    "lcm",
]
FALLBACK_SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"]

_STATUS_CACHE: dict[str, object] = {"stamp": 0.0, "key": "", "data": None}
_STATUS_LOCK = threading.Lock()


def _json_error(message: str, status: int = 400, detail: str = ""):
    payload = {"ok": False, "error": message}
    if detail:
        payload["detail"] = detail
    return jsonify(payload), status


def _invalidate_status() -> None:
    with _STATUS_LOCK:
        _STATUS_CACHE.update(stamp=0.0, key="", data=None)


def _shared_status(config: ConfigStore, refresh: bool = False) -> dict:
    cfg = config.get()
    key = f"{cfg.get('comfy_url')}|{cfg.get('loras_dir')}"
    with _STATUS_LOCK:
        if (
            not refresh
            and _STATUS_CACHE.get("data") is not None
            and _STATUS_CACHE.get("key") == key
            and time.time() - float(_STATUS_CACHE.get("stamp") or 0) < 4.0
        ):
            return _STATUS_CACHE["data"]  # type: ignore[return-value]

    url, online = discover_comfy_url(cfg.get("comfy_url") or "")
    if url != cfg.get("comfy_url"):
        config.set("comfy_url", url)

    checkpoints: list[str] = []
    samplers: list[str] = []
    schedulers: list[str] = []
    clip_files: list[str] = []
    vae_files: list[str] = []
    unet_files: list[str] = []
    gguf_files: list[str] = []
    lora_count = 0
    message = ""
    detail = ""
    if online:
        client = ComfyClient(url)
        try:
            checkpoints = client.checkpoints()
            samplers = client.samplers() or list(FALLBACK_SAMPLERS)
            schedulers = client.schedulers() or list(FALLBACK_SCHEDULERS)
            clip_files = client.clip_files()
            vae_files = client.vae_files()
            unet_files = client.unet_models()
            gguf_files = client.gguf_models()
            try:
                lora_count = len(client.loras())
            except ComfyError:
                lora_count = 0
            if not checkpoints and not unet_files and not gguf_files:
                message = (
                    "ComfyUI is online but reports no models. Put a checkpoint in "
                    "ComfyUI's models\\checkpoints folder, or a diffusion model in "
                    "models\\diffusion_models, and press Refresh."
                )
        except ComfyError as exc:
            online = False
            message = exc.message
            detail = exc.detail
    else:
        message = (
            f"ComfyUI is not responding at {url}. Start ComfyUI, then press Reconnect."
        )

    loras_dir = str(cfg.get("loras_dir") or "")
    if not loras_dir or not Path(loras_dir).is_dir():
        detected = detect_loras_dir(loras_dir, force=refresh)
        if detected:
            loras_dir = detected
            config.set("loras_dir", detected)
    loras_valid = bool(loras_dir and Path(loras_dir).is_dir())

    model_options: list[dict] = []
    for name in checkpoints:
        model_options.append(
            {"id": f"ckpt::{name}", "name": name, "loader": "checkpoint", "group": "Checkpoints"}
        )
    for name in unet_files:
        model_options.append(
            {
                "id": f"unet::{name}",
                "name": name,
                "loader": "unet",
                "group": "Diffusion models (UNET)",
            }
        )
    for name in gguf_files:
        model_options.append(
            {
                "id": f"gguf::{name}",
                "name": name,
                "loader": "gguf",
                "group": "Diffusion models (GGUF)",
            }
        )

    checkpoint_info: dict[str, dict] = {}
    if online:
        for option in model_options:
            plan = inspect_checkpoint(
                option["name"],
                loras_dir,
                clip_files=clip_files,
                vae_files=vae_files,
                samplers=samplers,
                schedulers=schedulers,
                loader=option["loader"],
            )
            plan["id"] = option["id"]
            plan["name"] = option["name"]
            plan["group"] = option["group"]
            checkpoint_info[option["id"]] = plan
            option["supported"] = bool(plan.get("supported", True))
            option["unsupported_reason"] = plan.get("unsupported_reason", "")
            option["unsupported_label"] = plan.get("unsupported_label", "")

    imports = [manifest for manifest in list_manifests() if not manifest.get("error")]
    data = {
        "ok": True,
        "version": APP_VERSION,
        "comfy": {
            "url": url,
            "online": online,
            "message": message,
            "detail": detail,
            "checkpoints": checkpoints,
            "unet_files": unet_files,
            "gguf_files": gguf_files,
            "model_options": model_options,
            "samplers": samplers or list(FALLBACK_SAMPLERS),
            "schedulers": schedulers or list(FALLBACK_SCHEDULERS),
            "clip_files": clip_files,
            "vae_files": vae_files,
            "checkpoint_info": checkpoint_info,
            "lora_count": lora_count,
        },
        "loras_dir": loras_dir,
        "loras_dir_valid": loras_valid,
        "output_dir": str(OUTPUT_DIR),
        "imports": imports,
        "defaults": public_defaults(),
    }
    with _STATUS_LOCK:
        _STATUS_CACHE.update(stamp=time.time(), key=key, data=data)
    return data


def _pick_folder_mac(description: str) -> str:
    script = [
        "on run argv",
        'tell application "System Events"',
        "activate",
        "set f to choose folder with prompt (item 1 of argv)",
        "end tell",
        "return POSIX path of f",
        "end run",
    ]
    args = ["osascript"] + [part for line in script for part in ("-e", line)] + [description]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=900)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError(f"Could not open the folder picker: {exc}") from exc
    if proc.returncode != 0:
        if "-128" in proc.stderr:  # cancelled
            return ""
        raise ValueError("Could not open the folder picker. Type the path instead.")
    path = proc.stdout.strip()
    return path[:-1] if len(path) > 1 and path.endswith("/") else path


def _pick_folder_linux(description: str) -> str:
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        raise ValueError("No desktop session for a folder window. Type the path instead.")
    for args in (
        ["zenity", "--file-selection", "--directory", f"--title={description}"],
        ["kdialog", "--getexistingdirectory", str(Path.home()), "--title", description],
    ):
        try:
            proc = subprocess.run(args, capture_output=True, text=True, timeout=900)
        except FileNotFoundError:
            continue
        except subprocess.SubprocessError as exc:
            raise ValueError(f"Could not open the folder picker: {exc}") from exc
        return proc.stdout.strip().splitlines()[-1].strip() if proc.returncode == 0 and proc.stdout.strip() else ""
    raise ValueError("Install zenity (or kdialog) for a folder window, or type the path instead.")


def _pick_folder(description: str) -> str:
    if sys.platform == "darwin":
        return _pick_folder_mac(description)
    if sys.platform != "win32":
        return _pick_folder_linux(description)
    script = (
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null; "
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
        f"$d.Description = '{description.replace(chr(39), chr(39) * 2)}'; "
        "$d.ShowNewFolderButton = $false; "
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError(f"Could not open the folder picker: {exc}") from exc
    path = proc.stdout.strip().splitlines()[-1].strip() if proc.stdout.strip() else ""
    if not path:
        return ""
    return path


def _open_folder(path: Path) -> None:
    if not path.is_dir():
        raise ValueError("That folder does not exist yet.")
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
        return
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        subprocess.Popen([opener, str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise ValueError(f"Could not open the folder ({opener} failed). It is at: {path}") from exc


def _clean_name(value: str) -> str:
    name = Path(str(value or "upload.zip").replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:180] or "upload.zip"


def _validate_prompt_text(value: str, label: str) -> str:
    text = "" if value is None else str(value).strip()
    if not text:
        raise ValueError(f"{label} is empty. Write a prompt or press Reset to defaults.")
    if len(text) > MAX_PROMPT_CHARS:
        raise ValueError(
            f"{label} is {len(text):,} characters; the limit is {MAX_PROMPT_CHARS:,}. "
            "Shorten it before starting."
        )
    return text


def _parse_int(value, name: str, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a whole number.") from exc
    if number < low or number > high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    return number


def _parse_float(value, name: str, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number.") from exc
    if number < low or number > high:
        raise ValueError(f"{name} must be between {low:g} and {high:g}.")
    return number


def _free_port(start: int) -> int:
    for offset in range(0, 30):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            # Exclusive bind: on Windows SO_REUSEADDR lets this probe "succeed" on a port another
            # LoRA Tester already uses, and both servers then share the port.
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"No free port found between {start} and {start + 29}.")


def create_app() -> Flask:
    ensure_dirs()
    config = ConfigStore()
    manager = JobManager(config)
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
    app.config["JSON_SORT_KEYS"] = False
    app.config["TEMPLATES_AUTO_RELOAD"] = True

    @app.before_request
    def local_only():
        if request.path.startswith("/output/") or request.path.startswith("/api/"):
            raw_host = (request.host or "").strip()
            if raw_host.startswith("["):
                host = raw_host.split("]")[0].strip("[]").lower()
            else:
                host = raw_host.split(":")[0].lower()
            if host not in ("127.0.0.1", "localhost", "::1"):
                return jsonify({"ok": False, "error": "This app only accepts local connections."}), 403
        return None

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
        )
        if request.path.startswith("/api/") or request.path == "/":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(_exc):
        return _json_error(
            "That upload is larger than the 8 GB safety limit. Upload one Civitai ZIP at a time.",
            413,
        )

    @app.errorhandler(Exception)
    def unhandled(exc):
        if isinstance(exc, HTTPException):
            return exc
        app.logger.error("Unhandled error: %s\n%s", exc, traceback.format_exc())
        if request.path.startswith("/api/"):
            return _json_error(
                "The app hit an unexpected error. The technical detail is in the server console.",
                500,
                str(exc)[:500],
            )
        return "The app hit an unexpected error. Check the server console.", 500

    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True, "version": APP_VERSION})

    @app.get("/api/status")
    def status():
        try:
            refresh = request.args.get("refresh") == "1"
            data = dict(_shared_status(config, refresh=refresh))
            data["active_job_id"] = manager.active_job_id()
            data["config"] = config.get()
            return jsonify(data)
        except Exception as exc:
            app.logger.error("Status error: %s\n%s", exc, traceback.format_exc())
            return _json_error("Could not read the app status. Check the server console.", 500, str(exc)[:500])

    @app.post("/api/config")
    def update_config():
        body = request.get_json(silent=True) or {}
        updates: dict = {}
        if "comfy_url" in body:
            url = str(body["comfy_url"] or "").strip().rstrip("/")
            if not re.match(r"^https?://[^\s]+$", url):
                return _json_error("The ComfyUI address must start with http:// or https://.")
            updates["comfy_url"] = url
            invalidate_detection()
        if "loras_dir" in body:
            raw = str(body["loras_dir"] or "").strip()
            if raw:
                path = Path(raw).expanduser()
                if not path.is_dir():
                    return _json_error(
                        f"That folder does not exist: {path}. Choose ComfyUI's models\\loras folder."
                    )
                updates["loras_dir"] = str(path.resolve())
            else:
                updates["loras_dir"] = ""
        if "cleanup_after_run" in body:
            updates["cleanup_after_run"] = bool(body["cleanup_after_run"])
        cfg = config.update(updates)
        invalidate_detection()
        _invalidate_status()
        return jsonify({"ok": True, "config": cfg})

    @app.post("/api/pick-folder")
    def pick_folder():
        try:
            path = _pick_folder("Select the ComfyUI models\\loras folder")
            return jsonify({"ok": True, "path": path})
        except ValueError as exc:
            return _json_error(str(exc))

    @app.post("/api/open-folder")
    def open_folder():
        body = request.get_json(silent=True) or {}
        kind = body.get("kind", "output")
        if kind == "output":
            path = OUTPUT_DIR
        elif kind == "loras":
            path = Path(config.get().get("loras_dir") or "")
        else:
            return _json_error("Unknown folder.")
        try:
            _open_folder(path)
            return jsonify({"ok": True})
        except ValueError as exc:
            return _json_error(str(exc))

    @app.get("/api/imports")
    def get_imports():
        manifests = [manifest for manifest in list_manifests() if not manifest.get("error")]
        return jsonify({"ok": True, "imports": manifests})

    @app.post("/api/import")
    def upload_import():
        files = request.files.getlist("files") + request.files.getlist("zips")
        files = [item for item in files if item and item.filename]
        if not files:
            return _json_error("Choose at least one Civitai ZIP or LoRA file.")
        imports: list[dict] = []
        errors: list[dict] = []
        for upload in files:
            original_name = _clean_name(upload.filename)
            suffix = Path(original_name).suffix.lower()
            if suffix != ".zip" and suffix not in LORA_EXTENSIONS:
                errors.append(
                    {
                        "file": original_name,
                        "error": "Use a .zip, or a .safetensors / .pt / .pth / .ckpt / .bin LoRA file.",
                    }
                )
                continue
            temp_path = ""
            try:
                fd, temp_path = tempfile.mkstemp(
                    dir=UPLOAD_DIR, prefix="upload_", suffix=suffix or ".bin"
                )
                with os.fdopen(fd, "wb") as handle:
                    shutil.copyfileobj(upload.stream, handle, 8 * 1024 * 1024)
                if Path(temp_path).stat().st_size == 0:
                    raise ValueError("That file is empty.")
                if suffix == ".zip":
                    manifest = import_zip(Path(temp_path), original_name)
                else:
                    manifest = import_lora_file(Path(temp_path), original_name)
                imports.append(manifest)
            except ValueError as exc:
                errors.append({"file": original_name, "error": str(exc)})
            except (OSError, zipfile.BadZipFile) as exc:
                errors.append({"file": original_name, "error": f"Could not read this file: {exc}"})
            finally:
                if temp_path:
                    try:
                        Path(temp_path).unlink(missing_ok=True)
                    except OSError:
                        pass
        if imports:
            _invalidate_status()
        status_code = 200 if imports else 400
        return jsonify({"ok": bool(imports), "imports": imports, "errors": errors}), status_code

    @app.get("/api/imports/<import_id>/file")
    def import_file(import_id: str):
        rel_path = request.args.get("path", "")
        target = resolve_import_file(import_id, rel_path)
        if target is None:
            return _json_error("That preview image is not available.", 404)
        if target.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            return _json_error("That file is not an image.", 404)
        return send_file(target, max_age=300)

    def _busy_lora_ids() -> set[str]:
        active = manager.active_job_id()
        job = manager.get_job(active) if active else None
        return {item.get("lora_id") for item in (job or {}).get("loras", [])}

    def _drop_comfy_copies(lora_id: str) -> None:
        """Delete the lt_<id8>_* copy this app placed in ComfyUI's LoRA folder."""
        value = str(config.get().get("loras_dir") or "").strip()
        folder = Path(value) if value else None
        if not folder or not folder.is_dir():
            return
        for item in folder.glob(f"lt_{lora_id[:8]}_*"):
            try:
                if item.is_file() and item.parent.resolve() == folder.resolve():
                    item.unlink()
            except OSError:
                pass

    @app.post("/api/imports/remove")
    def remove_imports():
        """Remove LoRAs from the import list. Test history and output images are kept."""
        payload = request.get_json(silent=True) or {}
        items = payload.get("items") or []
        if payload.get("import_id") and not items:
            manifest = load_manifest(str(payload["import_id"]))
            items = [
                {"import_id": manifest["import_id"], "lora_id": lora["lora_id"]}
                for lora in (manifest or {}).get("loras", [])
            ]
        if not items:
            return _json_error("Nothing to remove.")
        busy = _busy_lora_ids()
        removed = 0
        skipped = 0
        for item in items:
            lora_id = str(item.get("lora_id") or "")
            if lora_id in busy:
                skipped += 1
                continue
            if remove_lora(str(item.get("import_id") or ""), lora_id):
                _drop_comfy_copies(lora_id)
                removed += 1
        return jsonify({"ok": True, "removed": removed, "skipped_running": skipped})

    @app.get("/api/jobs")
    def get_jobs():
        return jsonify({"ok": True, "jobs": manager.list_jobs(), "active_job_id": manager.active_job_id()})

    @app.post("/api/jobs")
    def create_job():
        body = request.get_json(silent=True) or {}
        cfg = config.get()
        loras_dir = str(cfg.get("loras_dir") or "")
        if not loras_dir or not Path(loras_dir).is_dir():
            return _json_error(
                "Set ComfyUI's models\\loras folder in Settings before starting a test."
            )
        status_data = _shared_status(config)
        if not status_data["comfy"]["online"]:
            return _json_error(
                status_data["comfy"]["message"] or "ComfyUI is offline. Start ComfyUI and reconnect."
            )
        comfy = status_data["comfy"]
        raw_model = str(body.get("checkpoint") or "").strip()
        if not raw_model:
            return _json_error("Pick a checkpoint or diffusion model.")
        options = comfy.get("model_options") or []
        options_by_id = {option["id"]: option for option in options}
        option = options_by_id.get(raw_model)
        if option is None:
            # Accept a plain model name for older UI state / saved settings.
            if raw_model in (comfy.get("checkpoints") or []):
                option = {
                    "id": f"ckpt::{raw_model}",
                    "name": raw_model,
                    "loader": "checkpoint",
                    "group": "Checkpoints",
                }
            elif raw_model in (comfy.get("unet_files") or []):
                option = {
                    "id": f"unet::{raw_model}",
                    "name": raw_model,
                    "loader": "unet",
                    "group": "Diffusion models (UNET)",
                }
            elif raw_model in (comfy.get("gguf_files") or []):
                option = {
                    "id": f"gguf::{raw_model}",
                    "name": raw_model,
                    "loader": "gguf",
                    "group": "Diffusion models (GGUF)",
                }
        if option is None:
            return _json_error(
                "That model is not installed in ComfyUI. Press Refresh and pick one from the list."
            )
        if option.get("supported") is False:
            return _json_error(
                option.get("unsupported_reason")
                or "That diffusion model is not a supported Flux2, Z-Image or Krea2 model."
            )
        checkpoint = option["name"]
        model_loader = option["loader"]
        model_id = option["id"]

        pipeline = (comfy.get("checkpoint_info") or {}).get(model_id)
        if not pipeline:
            pipeline = inspect_checkpoint(
                checkpoint,
                loras_dir,
                clip_files=comfy.get("clip_files") or [],
                vae_files=comfy.get("vae_files") or [],
                samplers=comfy.get("samplers") or [],
                schedulers=comfy.get("schedulers") or [],
                loader=model_loader,
            )
        if pipeline.get("supported") is False:
            return _json_error(
                pipeline.get("unsupported_reason")
                or "That model is not supported. Pick a Flux2, Z-Image or Krea2 model, "
                "or a full SD/SDXL checkpoint."
            )
        if model_loader != "checkpoint" and pipeline.get("architecture") == "standard":
            return _json_error(
                "That diffusion model does not have a detected Flux2, Z-Image or Krea2 "
                "pipeline. Pick one of those diffusion models, or use a full SD/SDXL checkpoint."
            )
        if pipeline.get("architecture") != "standard":
            if not pipeline.get("clip_name") or pipeline["clip_name"] not in (comfy.get("clip_files") or []):
                return _json_error(
                    f"The text encoder for {pipeline.get('label', checkpoint)} is not installed in ComfyUI: "
                    f"“{pipeline.get('clip_name') or 'none'}”. Install it in ComfyUI's models\\text_encoders "
                    "folder and press Refresh."
                )
            if not pipeline.get("vae_name") or pipeline["vae_name"] not in (comfy.get("vae_files") or []):
                return _json_error(
                    f"The VAE for {pipeline.get('label', checkpoint)} is not installed in ComfyUI: "
                    f"“{pipeline.get('vae_name') or 'none'}”. Install it in ComfyUI's models\\vae "
                    "folder and press Refresh."
                )

        raw_loras = body.get("loras")
        if not isinstance(raw_loras, list) or not raw_loras:
            return _json_error("Select at least one LoRA from an imported ZIP.")
        selected_loras: list[dict] = []
        seen: set[str] = set()
        zip_names: list[str] = []
        for item in raw_loras:
            if not isinstance(item, dict):
                continue
            import_id = str(item.get("import_id") or "")
            lora_id = str(item.get("lora_id") or "")
            try:
                _source, entry, manifest = resolve_lora(import_id, lora_id)
            except ValueError as exc:
                return _json_error(str(exc))
            if lora_id in seen:
                continue
            seen.add(lora_id)
            trigger = str(item.get("trigger") or "").strip()[:200]
            use_trigger = bool(item.get("use_trigger")) and bool(trigger)
            selected_loras.append(
                {
                    "import_id": import_id,
                    "lora_id": lora_id,
                    "display_name": entry["display_name"],
                    "file_name": entry["file_name"],
                    "sha256": entry["sha256"],
                    "rel_path": entry["rel_path"],
                    "base_model": entry.get("base_model", ""),
                    "trigger": trigger,
                    "use_trigger": use_trigger,
                }
            )
            if manifest.get("zip_name") and manifest["zip_name"] not in zip_names:
                zip_names.append(manifest["zip_name"])
        if not selected_loras:
            return _json_error("Select at least one valid LoRA.")

        raw_prompts = body.get("prompts")
        if raw_prompts is None:
            prompts = [dict(item) for item in DEFAULT_PROMPTS]
        elif not isinstance(raw_prompts, list) or not raw_prompts:
            return _json_error("Keep at least one test prompt.")
        else:
            if len(raw_prompts) > MAX_PROMPTS:
                return _json_error(f"Use at most {MAX_PROMPTS} prompts in one job.")
            prompts = []
            used_ids: set[str] = set()
            for index, item in enumerate(raw_prompts, start=1):
                if not isinstance(item, dict):
                    return _json_error(f"Prompt {index} is invalid.")
                prompt_id = re.sub(r"[^a-z0-9_-]", "", str(item.get("id") or f"p{index}").lower())[:32] or f"p{index}"
                if prompt_id in used_ids:
                    prompt_id = f"{prompt_id}_{index}"
                used_ids.add(prompt_id)
                label = str(item.get("label") or f"Prompt {index}").strip()[:120]
                try:
                    text = _validate_prompt_text(item.get("text", ""), label)
                except ValueError as exc:
                    return _json_error(str(exc))
                prompts.append({"id": prompt_id, "label": label, "text": text})

        raw_negative = body.get("negative")
        negative = str(DEFAULT_NEGATIVE if raw_negative is None else raw_negative).strip()
        if not negative:
            return _json_error("The negative prompt is empty. Restore the default or write one.")
        if len(negative) > MAX_NEGATIVE_CHARS:
            return _json_error(f"The negative prompt is longer than {MAX_NEGATIVE_CHARS:,} characters.")

        raw_strengths = body.get("strengths", ALLOWED_STRENGTHS)
        if not isinstance(raw_strengths, list) or not raw_strengths:
            return _json_error("Select at least one strength.")
        strengths: list[float] = []
        for value in raw_strengths:
            try:
                strength = float(value)
            except (TypeError, ValueError):
                return _json_error("A strength value is not a number.")
            if not any(abs(strength - allowed) < 1e-6 for allowed in ALLOWED_STRENGTHS):
                allowed_text = ", ".join(f"{allowed:.2f}" for allowed in ALLOWED_STRENGTHS)
                return _json_error(f"Use these strengths only: {allowed_text}.")
            if not any(abs(strength - existing) < 1e-6 for existing in strengths):
                strengths.append(strength)
        strengths.sort()

        try:
            width = _parse_int(body.get("width", pipeline.get("width", 832)), "Width", 64, 4096)
            height = _parse_int(body.get("height", pipeline.get("height", 1216)), "Height", 64, 4096)
            if width % 8 or height % 8:
                raise ValueError("Width and height must be multiples of 8.")
            if pipeline.get("latent") == "sd3" and (width % 16 or height % 16):
                raise ValueError(
                    "Width and height must be multiples of 16 for Flux2 and Z-Image, "
                    "because they use the SD3 latent format."
                )
            steps = _parse_int(body.get("steps", pipeline.get("steps", 30)), "Steps", 1, 150)
            cfg_scale = _parse_float(body.get("cfg", pipeline.get("cfg", 7.0)), "CFG scale", 0.0, 30.0)
            seed = _parse_int(body.get("seed", 123456789), "Seed", -1, 4294967295)
        except ValueError as exc:
            return _json_error(str(exc))

        sampler = str(body.get("sampler") or pipeline.get("sampler") or "dpmpp_2m")
        scheduler = str(body.get("scheduler") or pipeline.get("scheduler") or "karras")
        if comfy["samplers"] and sampler not in comfy["samplers"]:
            return _json_error(f"The sampler “{sampler}” is not available in ComfyUI.")
        if comfy["schedulers"] and scheduler not in comfy["schedulers"]:
            return _json_error(f"The scheduler “{scheduler}” is not available in ComfyUI.")

        params = {
            "width": width,
            "height": height,
            "steps": steps,
            "cfg": cfg_scale,
            "sampler": sampler,
            "scheduler": scheduler,
            "seed": seed,
            "cleanup_after_run": bool(body.get("cleanup_after_run") or cfg.get("cleanup_after_run")),
            "pipeline": pipeline,
            "model_loader": model_loader,
            "model_id": model_id,
        }
        job = manager.create_job(
            checkpoint=checkpoint,
            model_loader=model_loader,
            model_id=model_id,
            loras=selected_loras,
            prompts=prompts,
            negative=negative,
            strengths=strengths,
            params=params,
            comfy_url=comfy["url"],
            zip_names=zip_names,
        )
        config.update(
            {
                "last_checkpoint": model_id,
                "last_steps": steps,
                "last_cfg": cfg_scale,
                "last_sampler": sampler,
                "last_scheduler": scheduler,
                "last_seed": seed,
            }
        )
        return jsonify({"ok": True, "job": job})

    @app.get("/api/jobs/<job_id>")
    def get_job(job_id: str):
        job = manager.get_job(job_id)
        if not job:
            return _json_error("That test was not found.", 404)
        return jsonify({"ok": True, "job": job, "active_job_id": manager.active_job_id()})

    @app.post("/api/jobs/<job_id>/cancel")
    def cancel_job(job_id: str):
        ok, message = manager.cancel(job_id)
        if not ok:
            return _json_error(message)
        return jsonify({"ok": True, "message": message})

    @app.get("/api/jobs/<job_id>/download")
    def download_job(job_id: str):
        job = manager.get_job(job_id)
        if not job:
            return _json_error("That test was not found.", 404)
        job_output = OUTPUT_DIR / job_id
        if not job_output.is_dir():
            return _json_error("This test has no output files yet.")
        zip_path = DOWNLOAD_DIR / f"lora_tester_{job_id}.zip"
        try:
            newest = max((path.stat().st_mtime for path in job_output.rglob("*") if path.is_file()), default=0)
            if not zip_path.exists() or zip_path.stat().st_mtime < newest:
                _build_download_zip(job, job_output, zip_path)
            return send_file(
                zip_path,
                as_attachment=True,
                download_name=f"lora_tester_{job_id}.zip",
                mimetype="application/zip",
            )
        except OSError as exc:
            return _json_error(f"Could not build the download ZIP: {exc}", 500)

    @app.get("/output/<path:filename>")
    def output_file(filename: str):
        return send_from_directory(OUTPUT_DIR, filename, max_age=3600)

    return app


def _build_download_zip(job: dict, job_output: Path, zip_path: Path) -> None:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    temp = zip_path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        readme_lines = [
            "LoRA Tester results",
            "===================",
            f"Job: {job['id']}",
            f"Created: {job['created_at']}",
            f"Checkpoint: {job['checkpoint']}",
            f"Model loader: {job.get('model_loader', 'checkpoint')}",
            f"Status: {job['status']}",
            f"Images: {len(job.get('results', []))}",
            "",
            "LoRA files:",
        ]
        for lora in job.get("loras", []):
            readme_lines.append(
                f"- {lora['display_name']} ({lora['file_name']})"
                + (f" · trigger: {lora['trigger']}" if lora.get("trigger") else "")
            )
        readme_lines.append("")
        readme_lines.append("Prompts:")
        for prompt in job.get("prompts", []):
            readme_lines.append(f"[{prompt['id']}] {prompt['label']}")
            readme_lines.append(prompt["text"])
            readme_lines.append("")
        readme_lines.append("Negative prompt:")
        readme_lines.append(job.get("negative", ""))
        readme_lines.append("")
        readme_lines.append("Strengths: " + ", ".join(f"{value:g}" for value in job.get("strengths", [])))
        archive.writestr("README.txt", "\n".join(readme_lines))
        archive.writestr(
            "settings.json",
            json.dumps(
                {
                    "id": job["id"],
                    "checkpoint": job["checkpoint"],
                    "model_loader": job.get("model_loader", "checkpoint"),
                    "model_id": job.get("model_id", ""),
                    "params": job.get("params", {}),
                    "strengths": job.get("strengths", []),
                    "loras": job.get("loras", []),
                    "prompts": job.get("prompts", []),
                    "negative": job.get("negative", ""),
                    "results": job.get("results", []),
                    "contact_sheets": job.get("contact_sheets", []),
                },
                indent=2,
                ensure_ascii=False,
            ),
        )
        for path in sorted(job_output.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(job_output).as_posix())
    temp.replace(zip_path)


def _write_server_file(port: int, url: str) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "server.json").write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "port": port,
                "url": url,
                "started_at": datetime.now().isoformat(timespec="seconds"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _remove_server_file() -> None:
    path = DATA_DIR / "server.json"
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if int(data.get("pid", -1)) == os.getpid():
                path.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="LoRA Tester")
    parser.add_argument("--port", type=int, default=8795)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    port = _free_port(args.port)
    url = f"http://127.0.0.1:{port}"
    app = create_app()
    _write_server_file(port, url)
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print("")
    print("  LORA TESTER  v" + APP_VERSION)
    print("  " + url)
    print("  ComfyUI should be running before you start a test.")
    print("  Press Ctrl+C to stop.")
    print("")
    try:
        app.run(host="127.0.0.1", port=port, threaded=True, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        _remove_server_file()


if __name__ == "__main__":
    main()
