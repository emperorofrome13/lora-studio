"""Background job worker: one LoRA test matrix at a time."""

from __future__ import annotations

import copy
import json
import os
import queue
import random
import re
import secrets
import shutil
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

from .annotate import annotate_image, build_contact_sheet
from .comfy import ComfyClient, ComfyError, build_workflow_for_architecture
from .config import (
    APP_VERSION,
    DATA_DIR,
    DOWNLOAD_DIR,
    JOB_DIR,
    LORA_DIR,
    OUTPUT_DIR,
    ConfigStore,
)
from .lora_zip import resolve_lora

IMAGE_TIMEOUT_SECONDS = 1800
MAX_CONSECUTIVE_IMAGE_FAILURES = 3
TEMP_DIR = DATA_DIR / "tmp"


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _strength_text(value: float) -> str:
    return f"{float(value):g}"


def safe_slug(text: str, fallback: str = "lora", limit: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    if not slug:
        slug = fallback
    return slug[:limit].strip("-") or fallback


def _atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


class JobManager:
    def __init__(self, config: ConfigStore):
        self.config = config
        self._jobs: dict[str, dict] = {}
        self._lock = threading.RLock()
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._cancel_events: dict[str, threading.Event] = {}
        self._clients: dict[str, ComfyClient] = {}
        self._current_pids: dict[str, str] = {}
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        self._load()
        self._worker = threading.Thread(target=self._worker_loop, name="lora-worker", daemon=True)
        self._worker.start()

    # ------------------------------------------------------------------ load/save

    def _load(self) -> None:
        if not JOB_DIR.exists():
            return
        for path in JOB_DIR.glob("*.json"):
            try:
                job = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(job, dict) or not job.get("id"):
                continue
            if job.get("status") in ("queued", "running", "cancelling"):
                job["status"] = "interrupted"
                job["finished_at"] = _now()
                job.setdefault("error", "")
                job["error"] = (
                    "The app was closed while this job was running. Finished images are kept; "
                    "start a new test for the remaining combinations."
                )
                job.setdefault("log", []).append(
                    {"time": _now(), "level": "warning", "message": "Marked interrupted on app restart."}
                )
                _atomic_json(path, job)
            self._jobs[job["id"]] = job

    def _save(self, job: dict) -> None:
        _atomic_json(JOB_DIR / f"{job['id']}.json", job)

    def _log(self, job: dict, message: str, level: str = "info") -> None:
        with self._lock:
            job.setdefault("log", []).append({"time": _now(), "level": level, "message": message})

    def _update(self, job: dict) -> None:
        with self._lock:
            self._save(job)

    # ------------------------------------------------------------------ public API

    def list_jobs(self) -> list[dict]:
        with self._lock:
            jobs = [self._summary(job) for job in self._jobs.values()]
        return sorted(jobs, key=lambda item: item["created_at"], reverse=True)

    def get_job(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return copy.deepcopy(job) if job else None

    def active_job_id(self) -> str | None:
        with self._lock:
            for job in self._jobs.values():
                if job.get("status") in ("queued", "running", "cancelling"):
                    return job["id"]
        return None

    def create_job(
        self,
        *,
        checkpoint: str,
        loras: list[dict],
        prompts: list[dict],
        negative: str,
        strengths: list[float],
        params: dict,
        comfy_url: str,
        zip_names: list[str],
        model_loader: str = "checkpoint",
        model_id: str = "",
    ) -> dict:
        job_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"
        total = len(loras) * len(prompts) * len(strengths)
        job = {
            "id": job_id,
            "app_version": APP_VERSION,
            "created_at": _now(),
            "started_at": None,
            "finished_at": None,
            "status": "queued",
            "error": "",
            "detail": "",
            "zip_names": zip_names,
            "checkpoint": checkpoint,
            "model_loader": model_loader,
            "model_id": model_id,
            "comfy_url": comfy_url,
            "loras": loras,
            "prompts": prompts,
            "negative": negative,
            "strengths": strengths,
            "params": params,
            "progress": {
                "total": total,
                "done": 0,
                "failed": 0,
                "percent": 0,
                "eta_seconds": None,
                "current": None,
            },
            "results": [],
            "contact_sheets": [],
            "imported_loras": [],
            "image_errors": [],
            "log": [{"time": _now(), "level": "info", "message": f"Job created · {total} images queued."}],
        }
        with self._lock:
            self._jobs[job_id] = job
            self._cancel_events[job_id] = threading.Event()
            self._save(job)
        self._queue.put(job_id)
        return copy.deepcopy(job)

    def cancel(self, job_id: str) -> tuple[bool, str]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False, "Job not found."
            if job["status"] not in ("queued", "running", "cancelling"):
                return False, "This job is already finished."
            event = self._cancel_events.setdefault(job_id, threading.Event())
            event.set()
            job["status"] = "cancelled" if job["status"] == "queued" else "cancelling"
            self._log(job, "Cancel requested. Finishing the current ComfyUI step, then stopping.", "warning")
            self._save(job)
            client = self._clients.get(job_id)
            pid = self._current_pids.get(job_id)
        if client and pid:
            client.interrupt()
        return True, "Cancelling."

    # ------------------------------------------------------------------ worker

    def _worker_loop(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id is None:
                return
            try:
                self._run_job(job_id)
            except Exception as exc:  # keep the worker alive and show a human message
                self._fail_job(job_id, f"The test stopped unexpectedly: {exc}", str(exc))
            finally:
                self._queue.task_done()

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            if job["status"] == "cancelled":
                job["finished_at"] = _now()
                self._save(job)
                return
            job["status"] = "running"
            job["started_at"] = _now()
            event = self._cancel_events[job_id]
            loader_label = {"unet": "[UNET] ", "gguf": "[GGUF] "}.get(
                job.get("model_loader", "checkpoint"), ""
            )
            self._log(job, f"Starting with {loader_label}{job['checkpoint']}.")
            self._save(job)

        client = ComfyClient(job["comfy_url"])
        self._clients[job_id] = client
        model_loader = job.get("model_loader", "checkpoint")
        loras_dir_value = str(self.config.get().get("loras_dir") or "").strip()
        if not loras_dir_value:
            self._fail_job(
                job_id,
                "ComfyUI's LoRA folder is not set. Choose ComfyUI's models\\loras folder in "
                "step 01, then start the test again.",
            )
            return
        loras_dir = Path(loras_dir_value)
        if not loras_dir.is_dir():
            self._fail_job(
                job_id,
                f"ComfyUI's LoRA folder is missing: {loras_dir}. Choose the folder again in step 01.",
            )
            return

        try:
            if not client.ping():
                raise ComfyError(
                    f"ComfyUI is not responding at {job['comfy_url']}. Start ComfyUI, then start the test again."
                )
            if model_loader == "unet":
                installed_models = client.unet_models()
                model_kind = "diffusion model (UNETLoader)"
            elif model_loader == "gguf":
                installed_models = client.gguf_models()
                model_kind = "GGUF diffusion model"
            else:
                installed_models = client.checkpoints()
                model_kind = "checkpoint"
            if job["checkpoint"] not in installed_models:
                raise ComfyError(
                    f"The {model_kind} “{job['checkpoint']}” is not installed in ComfyUI anymore. "
                    "Pick another model and start again."
                )
            samplers = client.samplers()
            if samplers and job["params"]["sampler"] not in samplers:
                raise ComfyError(
                    f"The sampler “{job['params']['sampler']}” is not available in this ComfyUI. "
                    "Pick another sampler in Advanced settings."
                )
            schedulers = client.schedulers()
            if schedulers and job["params"]["scheduler"] not in schedulers:
                raise ComfyError(
                    f"The scheduler “{job['params']['scheduler']}” is not available in this ComfyUI. "
                    "Pick another scheduler in Advanced settings."
                )

            try:
                self._import_loras(job, client, loras_dir, event)
            except ValueError as exc:
                raise ComfyError(str(exc)) from exc
            if event.is_set():
                self._finish_cancelled(job)
                return

            total = job["progress"]["total"]
            lora_lookup = {item["lora_id"]: item for item in job["loras"]}
            seed_cache: dict[tuple[str, str], int] = {}
            slot = 0
            consecutive_failures = 0
            started_clock = time.time()

            for lora_index, lora in enumerate(job["loras"]):
                lora_entry = lora_lookup[lora["lora_id"]]
                comfy_name = next(
                    item["comfy_name"]
                    for item in job["imported_loras"]
                    if item["lora_id"] == lora["lora_id"]
                )
                lora_slug = f"{safe_slug(lora_entry['display_name'])}-{lora['lora_id'][:8]}"
                for prompt in job["prompts"]:
                    if event.is_set():
                        break
                    seed_key = (lora["lora_id"], prompt["id"])
                    if seed_key not in seed_cache:
                        if int(job["params"]["seed"]) >= 0:
                            seed_cache[seed_key] = int(job["params"]["seed"])
                        else:
                            seed_cache[seed_key] = random.SystemRandom().randint(0, 2**32 - 1)
                    seed = seed_cache[seed_key]
                    for strength in job["strengths"]:
                        if event.is_set():
                            break
                        slot += 1
                        positive = prompt["text"].strip()
                        trigger = (lora.get("trigger") or "").strip()
                        if lora.get("use_trigger") and trigger:
                            positive = f"{trigger}, {positive}"
                        current = {
                            "slot": slot,
                            "lora_id": lora["lora_id"],
                            "lora_name": lora_entry["display_name"],
                            "prompt_id": prompt["id"],
                            "prompt_label": prompt["label"],
                            "strength": float(strength),
                            "elapsed_seconds": 0,
                            "comfy_prompt_id": "",
                        }
                        with self._lock:
                            job["progress"]["current"] = current
                            if job["status"] == "cancelling":
                                event.set()
                            self._save(job)
                        if event.is_set():
                            break

                        pipeline = job["params"].get("pipeline") or {}
                        workflow = build_workflow_for_architecture(
                            architecture=pipeline.get("architecture", "standard"),
                            checkpoint=job["checkpoint"],
                            lora_name=comfy_name,
                            strength=float(strength),
                            positive=positive,
                            negative=job["negative"],
                            width=int(job["params"]["width"]),
                            height=int(job["params"]["height"]),
                            steps=int(job["params"]["steps"]),
                            cfg=float(job["params"]["cfg"]),
                            sampler=job["params"]["sampler"],
                            scheduler=job["params"]["scheduler"],
                            seed=seed,
                            filename_prefix=(
                                f"lora_tester_{job['id']}_{lora['lora_id'][:8]}_"
                                f"{prompt['id']}_s{_strength_text(strength)}"
                            ),
                            clip_name=pipeline.get("clip_name", ""),
                            clip_type=pipeline.get("clip_type", ""),
                            vae_name=pipeline.get("vae_name", ""),
                            clip_skip=pipeline.get("clip_skip"),
                            shift=pipeline.get("shift"),
                            latent=pipeline.get("latent", "standard"),
                            model_loader=model_loader,
                        )
                        image_started = time.time()
                        try:
                            prompt_id = client.submit(workflow)
                            with self._lock:
                                current["comfy_prompt_id"] = prompt_id
                                self._current_pids[job_id] = prompt_id
                                self._save(job)

                            def on_tick(elapsed: int, cur=current) -> None:
                                with self._lock:
                                    cur["elapsed_seconds"] = elapsed

                            images = client.wait_for_image(
                                prompt_id,
                                on_tick=on_tick,
                                timeout_seconds=IMAGE_TIMEOUT_SECONDS,
                                cancel_check=event.is_set,
                            )
                            descriptor = images[0]
                            raw = client.view_image(
                                descriptor.get("filename", ""),
                                descriptor.get("subfolder", ""),
                                descriptor.get("type", "output"),
                            )
                            if not raw:
                                raise ComfyError("ComfyUI returned an empty image file.")
                            temp_path = self._write_temp(raw)
                            try:
                                result_index = len(job["results"]) + 1
                                filename = (
                                    f"{result_index:03d}_{prompt['id']}_s{_strength_text(strength)}"
                                    f"_seed{seed}.png"
                                )
                                dest = OUTPUT_DIR / job["id"] / lora_slug / filename
                                settings = {
                                    "width": job["params"]["width"],
                                    "height": job["params"]["height"],
                                    "steps": job["params"]["steps"],
                                    "cfg": job["params"]["cfg"],
                                    "sampler": job["params"]["sampler"],
                                    "scheduler": job["params"]["scheduler"],
                                }
                                checkpoint_label = job["checkpoint"]
                                if job.get("model_loader") in ("unet", "gguf"):
                                    checkpoint_label = f"[{job['model_loader'].upper()}] {checkpoint_label}"
                                annotate_image(
                                    temp_path,
                                    dest,
                                    lora_name=lora_entry["display_name"],
                                    prompt_label=prompt["label"],
                                    strength=float(strength),
                                    checkpoint=checkpoint_label,
                                    seed=seed,
                                    trigger=trigger if lora.get("use_trigger") else "",
                                    positive=positive,
                                    negative=job["negative"],
                                    settings=settings,
                                )
                            finally:
                                try:
                                    temp_path.unlink(missing_ok=True)
                                except OSError:
                                    pass

                            sidecar = {
                                "lora_name": lora_entry["display_name"],
                                "lora_file": lora_entry["file_name"],
                                "lora_sha256": lora_entry["sha256"],
                                "prompt_id": prompt["id"],
                                "prompt_label": prompt["label"],
                                "positive": positive,
                                "negative": job["negative"],
                                "strength": float(strength),
                                "seed": seed,
                                "checkpoint": checkpoint_label,
                                "model_loader": job.get("model_loader", "checkpoint"),
                                "trigger": trigger if lora.get("use_trigger") else "",
                                "settings": job["params"],
                                "comfy_prompt_id": prompt_id,
                            }
                            sidecar_path = dest.with_suffix(".json")
                            sidecar_path.write_text(
                                json.dumps(sidecar, indent=2, ensure_ascii=False), encoding="utf-8"
                            )
                            dest.with_suffix(".txt").write_text(positive, encoding="utf-8")

                            duration = round(time.time() - image_started, 2)
                            rel_path = dest.relative_to(OUTPUT_DIR).as_posix()
                            output_dir_slug = dest.parent.relative_to(OUTPUT_DIR).as_posix()
                            result = {
                                "index": result_index,
                                "lora_id": lora["lora_id"],
                                "lora_name": lora_entry["display_name"],
                                "prompt_id": prompt["id"],
                                "prompt_label": prompt["label"],
                                "strength": float(strength),
                                "seed": seed,
                                "filename": filename,
                                "rel_path": rel_path,
                                "url": f"/output/{output_dir_slug}/{filename}",
                                "width": int(job["params"]["width"]),
                                "height": int(job["params"]["height"]),
                                "duration_seconds": duration,
                                "created_at": _now(),
                            }
                            with self._lock:
                                job["results"].append(result)
                                job["progress"]["done"] += 1
                                done = job["progress"]["done"]
                                failed = job["progress"]["failed"]
                                job["progress"]["percent"] = round(done / max(total, 1) * 100, 1)
                                durations = [
                                    item.get("duration_seconds", 0)
                                    for item in job["results"]
                                    if item.get("duration_seconds")
                                ]
                                if durations:
                                    average = sum(durations) / len(durations)
                                    remaining = max(total - done - failed, 0)
                                    job["progress"]["eta_seconds"] = int(average * remaining)
                                self._log(
                                    job,
                                    f"Image {done + failed}/{total} · {lora_entry['display_name']} · "
                                    f"{prompt['label']} · strength {_strength_text(strength)} · {duration}s",
                                )
                                self._save(job)
                            consecutive_failures = 0
                        except ComfyError as exc:
                            if exc.message == "Cancelled by user.":
                                event.set()
                                break
                            consecutive_failures += 1
                            with self._lock:
                                job["progress"]["failed"] += 1
                                job["image_errors"].append(
                                    {
                                        "time": _now(),
                                        "lora_name": lora_entry["display_name"],
                                        "prompt_label": prompt["label"],
                                        "strength": float(strength),
                                        "message": exc.message,
                                        "detail": exc.detail,
                                    }
                                )
                                job["progress"]["percent"] = round(
                                    (job["progress"]["done"] + job["progress"]["failed"])
                                    / max(total, 1)
                                    * 100,
                                    1,
                                )
                                self._log(
                                    job,
                                    f"Failed · {lora_entry['display_name']} · {prompt['label']} · "
                                    f"strength {_strength_text(strength)}: {exc.message}",
                                    "error",
                                )
                                self._save(job)
                            if consecutive_failures >= MAX_CONSECUTIVE_IMAGE_FAILURES:
                                raise ComfyError(
                                    f"{MAX_CONSECUTIVE_IMAGE_FAILURES} images failed in a row. "
                                    "Check the ComfyUI console, then start a new test. "
                                    f"Last error: {exc.message}",
                                    exc.detail,
                                )
                        finally:
                            with self._lock:
                                self._current_pids.pop(job_id, None)
                    if event.is_set():
                        break
                if event.is_set():
                    break

            if event.is_set():
                self._finish_cancelled(job)
            else:
                self._build_sheets(job)
                with self._lock:
                    job["status"] = "completed"
                    job["finished_at"] = _now()
                    job["progress"]["current"] = None
                    job["progress"]["eta_seconds"] = 0
                    job["progress"]["percent"] = 100.0
                    done = job["progress"]["done"]
                    failed = job["progress"]["failed"]
                    self._log(
                        job,
                        f"Finished · {done} image(s) saved"
                        + (f", {failed} failed" if failed else "")
                        + f" in {int(time.time() - started_clock)}s.",
                        "success" if not failed else "warning",
                    )
                    self._save(job)
        except ComfyError as exc:
            self._fail_job(job_id, exc.message, exc.detail)
        except Exception as exc:
            self._fail_job(job_id, f"The test stopped: {exc}", repr(exc))
        finally:
            self._cleanup_imported(job_id, self._clients.get(job_id))
            self._clients.pop(job_id, None)
            self._current_pids.pop(job_id, None)

    # ------------------------------------------------------------------ helpers

    def _import_loras(
        self,
        job: dict,
        client: ComfyClient,
        loras_dir: Path,
        event: threading.Event,
    ) -> None:
        comfy_loras = set(client.loras())
        imported: list[dict] = []
        for lora in job["loras"]:
            if event.is_set():
                return
            source, entry, _manifest = resolve_lora(lora["import_id"], lora["lora_id"])
            suffix = source.suffix.lower() or ".safetensors"
            target_name = f"lt_{lora['lora_id'][:8]}_{safe_slug(entry['display_name'], 'lora', 40)}{suffix}"
            target = loras_dir / target_name
            created = False
            if not target.exists() or target.stat().st_size != source.stat().st_size:
                try:
                    if target.exists():
                        target.unlink()
                    os.link(source, target)
                except OSError:
                    shutil.copy2(source, target)
                created = True
            imported.append(
                {
                    "lora_id": lora["lora_id"],
                    "comfy_name": target_name,
                    "created_file": created,
                }
            )
            with self._lock:
                job["imported_loras"] = imported
                self._log(job, f"Imported {entry['display_name']} → ComfyUI loras/{target_name}.")
                self._save(job)

        deadline = time.time() + 15
        while time.time() < deadline:
            comfy_loras = set(client.loras())
            missing = [item["comfy_name"] for item in imported if item["comfy_name"] not in comfy_loras]
            if not missing:
                return
            time.sleep(0.6)
        missing = [item["comfy_name"] for item in imported if item["comfy_name"] not in comfy_loras]
        raise ComfyError(
            "ComfyUI cannot see the imported LoRA file(s). The app copied them into "
            f"“{loras_dir}”, but ComfyUI did not list them. Pick ComfyUI's real models\\loras "
            "folder in Settings, then start the test again.",
            "Missing in ComfyUI: " + ", ".join(missing),
        )

    def _write_temp(self, raw: bytes) -> Path:
        fd, name = tempfile.mkstemp(dir=TEMP_DIR, prefix="lt_", suffix=".png")
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
        return Path(name)

    def _build_sheets(self, job: dict) -> None:
        by_lora: dict[str, list[dict]] = {}
        for result in job["results"]:
            by_lora.setdefault(result["lora_id"], []).append(result)
        for lora in job["loras"]:
            items = by_lora.get(lora["lora_id"], [])
            if not items:
                continue
            lora_entry = next((item for item in job["loras"] if item["lora_id"] == lora["lora_id"]), lora)
            display = next(
                (result["lora_name"] for result in items),
                lora.get("display_name", lora["lora_id"]),
            )
            rows: list[dict] = []
            for prompt in job["prompts"]:
                images = {
                    result["strength"]: str(OUTPUT_DIR / result["rel_path"])
                    for result in items
                    if result["prompt_id"] == prompt["id"]
                }
                if images:
                    rows.append(
                        {
                            "prompt_label": prompt["label"],
                            "prompt_id": prompt["id"],
                            "images": images,
                        }
                    )
            if not rows:
                continue
            slug = f"{safe_slug(display)}-{lora['lora_id'][:8]}"
            out_path = OUTPUT_DIR / job["id"] / slug / "contact_sheet.jpg"
            try:
                made = build_contact_sheet(
                    rows,
                    job["strengths"],
                    out_path,
                    lora_name=display,
                    checkpoint=job["checkpoint"],
                )
            except Exception as exc:
                with self._lock:
                    self._log(job, f"Could not build the contact sheet for {display}: {exc}", "warning")
                    self._save(job)
                continue
            if made:
                rel = made.relative_to(OUTPUT_DIR).as_posix()
                with self._lock:
                    job["contact_sheets"].append(
                        {
                            "lora_id": lora["lora_id"],
                            "lora_name": display,
                            "filename": made.name,
                            "rel_path": rel,
                            "url": f"/output/{rel}",
                        }
                    )
                    self._save(job)

    def _finish_cancelled(self, job: dict) -> None:
        self._build_sheets(job)
        with self._lock:
            job["status"] = "cancelled"
            job["finished_at"] = _now()
            job["progress"]["current"] = None
            job["progress"]["eta_seconds"] = None
            self._log(
                job,
                f"Cancelled · {job['progress']['done']} image(s) kept.",
                "warning",
            )
            self._save(job)

    def _fail_job(self, job_id: str, message: str, detail: str = "") -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job["status"] = "failed"
            job["finished_at"] = _now()
            job["progress"]["current"] = None
            job["progress"]["eta_seconds"] = None
            job["error"] = message
            job["detail"] = (detail or "")[:8000]
            self._log(job, message, "error")
            self._save(job)

    def _cleanup_imported(self, job_id: str, client: ComfyClient | None = None) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            cleanup = bool(job.get("params", {}).get("cleanup_after_run"))
            imported = list(job.get("imported_loras", []))
        if not cleanup:
            return
        targets: list[Path] = []
        loras_dir_value = str(self.config.get().get("loras_dir") or "").strip()
        loras_dir = Path(loras_dir_value) if loras_dir_value else Path("__not_set__")
        if loras_dir.is_dir():
            for item in imported:
                if not item.get("created_file"):
                    continue
                target = loras_dir / item["comfy_name"]
                try:
                    if target.parent.resolve() == loras_dir.resolve() and target.name.startswith("lt_"):
                        targets.append(target)
                except OSError:
                    continue
        if not targets:
            return
        if client is not None:
            with self._lock:
                self._log(
                    job,
                    "Unloading ComfyUI models so the imported test LoRA files can be removed…",
                )
                self._save(job)
            client.free_memory()
        removed: list[Path] = []
        last_errors: dict[str, str] = {}
        for attempt in range(14):
            remaining: list[Path] = []
            for target in targets:
                if not target.exists():
                    continue
                try:
                    target.unlink()
                    removed.append(target)
                except OSError as exc:
                    remaining.append(target)
                    last_errors[target.name] = str(exc)
            targets = remaining
            if not targets:
                break
            time.sleep(1.0)
        with self._lock:
            if removed:
                self._log(
                    job,
                    f"Removed {len(removed)} imported test LoRA file(s) from ComfyUI's loras folder.",
                )
            if targets:
                self._log(
                    job,
                    "Could not remove "
                    + ", ".join(target.name for target in targets)
                    + " — ComfyUI still has the file open. Restart ComfyUI and delete it manually, "
                    "or leave it in the loras folder.",
                    "warning",
                )
            if removed or targets:
                self._save(job)

    def _summary(self, job: dict) -> dict:
        return {
            "id": job["id"],
            "created_at": job["created_at"],
            "finished_at": job.get("finished_at"),
            "status": job["status"],
            "checkpoint": job["checkpoint"],
            "loras": [
                {"lora_id": item["lora_id"], "display_name": item["display_name"]}
                for item in job["loras"]
            ],
            "prompts": [{"id": item["id"], "label": item["label"]} for item in job["prompts"]],
            "strengths": job["strengths"],
            "progress": {
                "total": job["progress"]["total"],
                "done": job["progress"]["done"],
                "failed": job["progress"]["failed"],
                "percent": job["progress"]["percent"],
            },
            "error": job.get("error", ""),
            "result_count": len(job.get("results", [])),
            "contact_sheet_count": len(job.get("contact_sheets", [])),
            "zip_names": job.get("zip_names", []),
            "architecture": (job.get("params", {}).get("pipeline") or {}).get("architecture", "standard"),
            "pipeline_label": (job.get("params", {}).get("pipeline") or {}).get("label", ""),
            "model_loader": job.get("model_loader", "checkpoint"),
        }
