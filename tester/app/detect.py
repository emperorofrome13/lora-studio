"""Locate ComfyUI's loras folder without scanning the whole drive.

Order:
1. Explicit setting in config.json.
2. COMFYUI_LORAS_DIR environment variable.
3. The running ComfyUI process command line (only ComfyUI processes are inspected).
4. extra_model_paths.yaml in the detected ComfyUI root.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

_CACHE: dict[str, object] = {"checked": False, "path": ""}


def _valid_loras_dir(path: str | os.PathLike) -> str:
    try:
        candidate = Path(path).expanduser().resolve()
    except (OSError, ValueError):
        return ""
    if candidate.is_dir() and candidate.name.lower() == "loras":
        return str(candidate)
    return ""


def _comfy_process_paths() -> list[Path]:
    """Return likely ComfyUI roots from running Python process command lines."""
    if sys.platform != "win32":
        return []
    command = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*ComfyUI*' } | "
        "Select-Object -First 8 -ExpandProperty CommandLine"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    roots: list[Path] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        for match in re.finditer(r'"?([A-Za-z]:[\\/][^"\r\n]*?[\\/]ComfyUI)[\\/]main\.py', line, re.I):
            roots.append(Path(match.group(1)))
        for match in re.finditer(r"--base-directory\s+[\"']?([^\"'\s]+)", line, re.I):
            roots.append(Path(match.group(1)))
    return roots


def _parse_extra_model_paths(config_path: Path) -> list[Path]:
    """Very small parser for the common 'loras: path' lines in ComfyUI's YAML."""
    found: list[Path] = []
    try:
        text = config_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return found
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^loras\s*:\s*(.+)$", stripped, re.I)
        if match:
            raw = match.group(1).strip().strip("\"'")
            if raw:
                found.append(Path(raw))
    return found


def detect_loras_dir(configured: str = "", force: bool = False) -> str:
    """Best-effort detection. Never walks the drive."""
    configured_path = _valid_loras_dir(configured)
    if configured_path:
        return configured_path

    if _CACHE["checked"] and not force:
        return str(_CACHE["path"] or "")

    env_dir = _valid_loras_dir(os.environ.get("COMFYUI_LORAS_DIR", ""))
    if env_dir:
        _CACHE.update(checked=True, path=env_dir)
        return env_dir

    for root in _comfy_process_paths():
        direct = _valid_loras_dir(root / "models" / "loras")
        if direct:
            _CACHE.update(checked=True, path=direct)
            return direct
        extra = root / "extra_model_paths.yaml"
        if extra.exists():
            for path in _parse_extra_model_paths(extra):
                resolved = _valid_loras_dir(path)
                if resolved:
                    _CACHE.update(checked=True, path=resolved)
                    return resolved

    _CACHE.update(checked=True, path="")
    return ""


def invalidate_detection() -> None:
    _CACHE.update(checked=False, path="")
