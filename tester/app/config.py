"""Application paths and persistent settings."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from .prompts import DEFAULT_NEGATIVE, DEFAULT_PROMPTS, RESOLUTION_PRESETS, STRENGTHS

APP_VERSION = "1.05"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
LORA_DIR = DATA_DIR / "loras"
IMPORT_DIR = DATA_DIR / "imports"
JOB_DIR = DATA_DIR / "jobs"
DOWNLOAD_DIR = DATA_DIR / "downloads"
OUTPUT_DIR = ROOT / "output"
STATIC_DIR = Path(__file__).resolve().parent / "static"
CONFIG_PATH = DATA_DIR / "config.json"

ALL_DIRS = [DATA_DIR, UPLOAD_DIR, LORA_DIR, IMPORT_DIR, JOB_DIR, DOWNLOAD_DIR, OUTPUT_DIR]

DEFAULT_CONFIG = {
    "comfy_url": "",
    "loras_dir": "",
    "cleanup_after_run": False,
    "last_checkpoint": "",
    "last_resolution": "sdxl_portrait",
    "last_steps": 30,
    "last_cfg": 7.0,
    "last_sampler": "dpmpp_2m",
    "last_scheduler": "karras",
    "last_seed": 123456789,
}


def ensure_dirs() -> None:
    for folder in ALL_DIRS:
        folder.mkdir(parents=True, exist_ok=True)


class ConfigStore:
    """Thread-safe JSON settings store."""

    def __init__(self, path: Path = CONFIG_PATH):
        self.path = path
        self._lock = threading.Lock()
        self._data = dict(DEFAULT_CONFIG)
        self.load()

    def load(self) -> dict:
        with self._lock:
            if self.path.exists():
                try:
                    loaded = json.loads(self.path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        for key, value in loaded.items():
                            if key in DEFAULT_CONFIG:
                                self._data[key] = value
                except (OSError, ValueError):
                    self._data = dict(DEFAULT_CONFIG)
            return dict(self._data)

    def get(self) -> dict:
        with self._lock:
            return dict(self._data)

    def update(self, values: dict) -> dict:
        with self._lock:
            for key, value in values.items():
                if key in DEFAULT_CONFIG:
                    self._data[key] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._data, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
            return dict(self._data)

    def set(self, key: str, value) -> dict:
        return self.update({key: value})


def public_defaults() -> dict:
    return {
        "prompts": DEFAULT_PROMPTS,
        "negative": DEFAULT_NEGATIVE,
        "strengths": STRENGTHS,
        "resolutions": RESOLUTION_PRESETS,
    }
