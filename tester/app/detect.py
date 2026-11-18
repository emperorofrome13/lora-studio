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
    # ExecutablePath too: the portable build starts as `python_embeded\python.exe -s ComfyUI\main.py`
    # with a *relative* path, so the root has to come from where its python.exe lives.
    command = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*main.py*' } | "
        "Select-Object -First 8 | ForEach-Object { $_.ExecutablePath + '|' + $_.CommandLine }"
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
    for raw in proc.stdout.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        exe, _, line = raw.partition("|")
        for match in re.finditer(r'"?([A-Za-z]:[\\/][^"\r\n]*?[\\/]ComfyUI)[\\/]main\.py', line, re.I):
            roots.append(Path(match.group(1)))
        for match in re.finditer(r"--base-directory\s+[\"']?([^\"'\s]+)", line, re.I):
            roots.append(Path(match.group(1)))
        if exe and re.search(r"(^|[\s\"\\/])(ComfyUI[\\/])?main\.py", line, re.I):
            # Portable layout: <root>\python_embeded\python.exe next to <root>\ComfyUI.
            exe_dir = Path(exe).parent
            for candidate in (exe_dir.parent / "ComfyUI", exe_dir.parent):
                if (candidate / "main.py").is_file() and candidate not in roots:
                    roots.append(candidate)
    return roots


def loras_match(loras_dir: str | os.PathLike, comfy_loras: list[str], sample: int = 40) -> bool:
    """True when `loras_dir` holds the LoRAs the running ComfyUI lists (it is that ComfyUI's folder).

    With no LoRAs listed there is nothing to compare, so any existing folder counts as a match.
    """
    folder = Path(loras_dir)
    if not folder.is_dir():
        return False
    names = [name for name in comfy_loras if name][:sample]
    if not names:
        return True
    found = sum(1 for name in names if (folder / name.replace("\\", "/")).is_file())
    return found * 2 >= len(names)


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


def detect_loras_dir(configured: str = "", force: bool = False, expect: list[str] | None = None) -> str:
    """Best-effort detection. Never walks the drive.

    expect: LoRA names the running ComfyUI reports; when given, only a folder holding them is accepted
    (so with two ComfyUI installs the one actually running is chosen).
    """
    ok = (lambda path: loras_match(path, expect)) if expect else (lambda path: True)
    configured_path = _valid_loras_dir(configured)
    if configured_path and ok(configured_path):
        return configured_path

    if _CACHE["checked"] and not force:
        cached = str(_CACHE["path"] or "")
        return cached if cached and ok(cached) else ""

    env_dir = _valid_loras_dir(os.environ.get("COMFYUI_LORAS_DIR", ""))
    if env_dir:
        _CACHE.update(checked=True, path=env_dir)
        return env_dir

    for root in _comfy_process_paths():
        direct = _valid_loras_dir(root / "models" / "loras")
        if direct and ok(direct):
            _CACHE.update(checked=True, path=direct)
            return direct
        extra = root / "extra_model_paths.yaml"
        if extra.exists():
            for path in _parse_extra_model_paths(extra):
                resolved = _valid_loras_dir(path)
                if resolved and ok(resolved):
                    _CACHE.update(checked=True, path=resolved)
                    return resolved

    _CACHE.update(checked=True, path="")
    return ""


def invalidate_detection() -> None:
    _CACHE.update(checked=False, path="")
