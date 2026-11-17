"""Civitai ZIP import: safe extraction, LoRA detection, metadata, triggers."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath

from .config import IMPORT_DIR, LORA_DIR

IMPORT_VERSION = 1
LORA_EXTENSIONS = {".safetensors", ".pt", ".pth", ".ckpt", ".bin"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
TEXT_EXTENSIONS = {".txt", ".md", ".yaml", ".yml", ".json"}
MAX_ZIP_FILES = 50000
MAX_ZIP_UNCOMPRESSED = 16 * 1024 * 1024 * 1024
MAX_SAFETENSORS_HEADER = 64 * 1024 * 1024
MAX_LORA_FILE = 8 * 1024 * 1024 * 1024
MAX_TEXT_READ = 2 * 1024 * 1024
CHUNK = 8 * 1024 * 1024

TRIGGER_RE = re.compile(
    r"(?im)^\s*(?:trigger[\s_-]*(?:word|phrase)?|instance[\s_-]*prompt)\s*[:=]\s*"
    r"[\"']?([^\"'\r\n]{1,160})"
)
TRIGGER_KEYS = (
    "modelspec.trigger_phrase",
    "ss_trigger_word",
    "trigger_word",
    "trigger_phrase",
    "trigger",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(name: str) -> PurePosixPath | None:
    normalized = name.replace("\\", "/")
    if not normalized or normalized.startswith("/"):
        return None
    if re.match(r"^[A-Za-z]:", normalized):
        return None
    parts = PurePosixPath(normalized).parts
    if not parts or any(part in ("..", "") for part in parts):
        return None
    if parts[0] == "__MACOSX":
        return None
    if parts[-1] in (".DS_Store", "Thumbs.db"):
        return None
    return PurePosixPath(*parts)


def safe_extract(zip_path: Path, dest: Path) -> list[str]:
    dest.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest.resolve()
    extracted: list[str] = []
    with zipfile.ZipFile(zip_path) as archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > MAX_ZIP_FILES:
            raise ValueError(
                f"This ZIP has {len(infos):,} files; the safety limit is {MAX_ZIP_FILES:,} files."
            )
        total = sum(info.file_size for info in infos)
        if total > MAX_ZIP_UNCOMPRESSED:
            raise ValueError(
                "This ZIP expands to more than 16 GB, which is above the safety limit. "
                "Unzip it yourself and place the LoRA in ComfyUI instead."
            )
        for info in infos:
            rel = _safe_relative(info.filename)
            if rel is None:
                continue
            target = dest.joinpath(*rel.parts)
            try:
                target.resolve().relative_to(dest_resolved)
            except ValueError:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, CHUNK)
            extracted.append(str(rel))
    return extracted


def read_safetensors_header(path: Path) -> tuple[dict, dict[str, dict]] | None:
    try:
        with path.open("rb") as handle:
            raw_len = handle.read(8)
            if len(raw_len) != 8:
                return None
            header_len = int.from_bytes(raw_len, "little")
            if header_len <= 0 or header_len > MAX_SAFETENSORS_HEADER:
                return None
            raw = handle.read(header_len)
            if len(raw) != header_len:
                return None
            data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    metadata = data.pop("__metadata__", {})
    if not isinstance(metadata, dict):
        metadata = {}
    tensors = {key: value for key, value in data.items() if isinstance(value, dict)}
    return metadata, tensors


def _is_lora(tensors: dict[str, dict]) -> bool:
    for key in tensors:
        lowered = key.lower()
        if "lora" in lowered and any(
            token in lowered for token in ("lora_down", "lora_up", "lora_a", "lora_b", "lora_te", "lora_unet")
        ):
            return True
        if lowered.endswith(".alpha") and "lora" in lowered:
            return True
    return False


def _rank(tensors: dict[str, dict]) -> str:
    ranks: list[int] = []
    for key, info in tensors.items():
        lowered = key.lower()
        if "lora_down" in lowered or "lora_a" in lowered:
            shape = info.get("shape")
            if isinstance(shape, list) and shape and isinstance(shape[0], int):
                ranks.append(int(shape[0]))
    if not ranks:
        return ""
    unique = sorted(set(ranks))
    if len(unique) == 1:
        return str(unique[0])
    return f"{unique[0]}–{unique[-1]}"


def _first_metadata(metadata: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (list, tuple)) and value:
            return ", ".join(str(item) for item in value if str(item).strip())[:160]
    return ""


def _clean_trigger(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip().strip("\"'` ")
    value = value.rstrip(".,;:!?")
    return value[:160]


def _metadata_trigger(metadata: dict) -> tuple[str, str]:
    lowered = {str(key).lower(): value for key, value in metadata.items()}
    for key in TRIGGER_KEYS:
        value = lowered.get(key.lower())
        if isinstance(value, str) and value.strip():
            parsed = value.strip()
            if parsed.startswith("["):
                try:
                    data = json.loads(parsed)
                    if isinstance(data, list) and data:
                        return _clean_trigger(str(data[0])), f"metadata: {key}"
                except ValueError:
                    pass
            return _clean_trigger(parsed), f"metadata: {key}"
    for key, value in lowered.items():
        if "trigger" in key and isinstance(value, str) and value.strip():
            return _clean_trigger(value), f"metadata: {key}"
    return "", ""


def _text_trigger(text_files: list[Path]) -> tuple[str, str]:
    for path in text_files:
        try:
            if path.stat().st_size > MAX_TEXT_READ:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        match = TRIGGER_RE.search(text)
        if match:
            value = _clean_trigger(match.group(1))
            if value:
                return value, f"file: {path.name}"
    return "", ""


def _base_model(metadata: dict) -> str:
    return _first_metadata(
        metadata,
        (
            "ss_base_model_version",
            "modelspec.architecture",
            "ss_sd_model_name",
            "modelspec.implementation",
            "base_model",
        ),
    )


def _display_name(relative: PurePosixPath) -> str:
    return relative.stem


def _preview_for(relative: PurePosixPath, loras: list[PurePosixPath], images: list[PurePosixPath]) -> str:
    if not images:
        return ""
    stem = relative.stem.lower()[:20]
    for image in images:
        if stem and stem in image.stem.lower():
            return image.as_posix()
    for image in images:
        if image.parent == relative.parent:
            return image.as_posix()
    return images[0].as_posix()


def _clean_upload_name(name: str) -> str:
    base = Path(str(name or "lora.safetensors").replace("\\", "/")).name
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip()
    return base[:180] or "lora.safetensors"


def import_lora_file(source_path: Path, original_name: str) -> dict:
    """Import one LoRA file directly, without requiring a ZIP."""
    size = source_path.stat().st_size
    if size <= 0:
        raise ValueError("That file is empty.")
    if size > MAX_LORA_FILE:
        raise ValueError("That LoRA file is larger than 8 GB; it is probably a base model checkpoint.")
    file_hash = sha256_file(source_path)
    import_id = file_hash[:12]
    cached = load_manifest(import_id)
    if cached:
        if cached.get("error"):
            raise ValueError(cached["error"])
        return cached

    safe_name = _clean_upload_name(original_name)
    suffix = Path(safe_name).suffix.lower()
    if suffix not in LORA_EXTENSIONS:
        raise ValueError(
            "Use a .safetensors LoRA file, or one of .pt, .pth, .ckpt, .bin."
        )
    warning = ""
    base_model = ""
    rank = ""
    trigger = ""
    trigger_source = ""

    if suffix == ".safetensors":
        parsed = read_safetensors_header(source_path)
        if parsed is None:
            raise ValueError("This .safetensors file has an unreadable header.")
        metadata, tensors = parsed
        if not _is_lora(tensors):
            raise ValueError(
                "This file is not a LoRA: no LoRA tensors were found. "
                "Pick the LoRA .safetensors, not the base checkpoint."
            )
        base_model = _base_model(metadata)
        rank = _rank(tensors)
        trigger, trigger_source = _metadata_trigger(metadata)
    else:
        if "lora" not in safe_name.lower():
            raise ValueError(
                "This file does not look like a LoRA. Only .safetensors can be verified; "
                "older formats need “lora” in the filename."
            )
        warning = "This file uses an older format; LoRA tensors could not be verified."

    import_root = LORA_DIR / import_id
    if import_root.exists():
        shutil.rmtree(import_root, ignore_errors=True)
    import_root.mkdir(parents=True, exist_ok=True)
    destination = import_root / safe_name
    try:
        os.link(source_path, destination)
    except OSError:
        shutil.copy2(source_path, destination)

    entry = {
        "lora_id": file_hash[:16],
        "display_name": Path(safe_name).stem,
        "file_name": safe_name,
        "rel_path": safe_name,
        "size": size,
        "sha256": file_hash,
        "base_model": base_model,
        "rank": rank,
        "trigger": trigger,
        "trigger_source": trigger_source,
        "preview": "",
        "warning": warning,
    }
    manifest = {
        "import_version": IMPORT_VERSION,
        "import_id": import_id,
        "zip_name": safe_name,
        "zip_hash": file_hash,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "source_type": "file",
        "loras": [entry],
        "skipped": [],
        "error": "",
    }
    _write_manifest(manifest)
    return manifest


def load_manifest(import_id: str) -> dict | None:
    if not re.fullmatch(r"[a-f0-9]{12}", import_id or ""):
        return None
    path = IMPORT_DIR / f"{import_id}.json"
    if not path.exists():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if manifest.get("import_version") != IMPORT_VERSION:
        return None
    import_root = LORA_DIR / import_id
    if not import_root.is_dir():
        return None
    for lora in manifest.get("loras", []):
        relative = _safe_relative(str(lora.get("rel_path") or ""))
        if relative is None:
            return None
        if not import_root.joinpath(*relative.parts).is_file():
            return None
    return manifest


def list_manifests() -> list[dict]:
    manifests: list[dict] = []
    if not IMPORT_DIR.exists():
        return manifests
    for path in sorted(IMPORT_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        manifest = load_manifest(path.stem)
        if manifest:
            manifests.append(manifest)
    return manifests


def import_zip(zip_path: Path, original_name: str) -> dict:
    zip_hash = sha256_file(zip_path)
    import_id = zip_hash[:12]
    cached = load_manifest(import_id)
    if cached:
        if cached.get("error"):
            raise ValueError(cached["error"])
        return cached

    import_root = LORA_DIR / import_id
    if import_root.exists():
        shutil.rmtree(import_root, ignore_errors=True)
    import_root.mkdir(parents=True, exist_ok=True)

    try:
        safe_extract(zip_path, import_root)
    except zipfile.BadZipFile as exc:
        raise ValueError(
            "This file is not a readable ZIP. Download the Civitai training archive again."
        ) from exc

    all_files: list[Path] = [path for path in import_root.rglob("*") if path.is_file()]
    relative_by_path = {
        path: PurePosixPath(path.relative_to(import_root).as_posix()) for path in all_files
    }
    lora_paths = [
        path for path in all_files if path.suffix.lower() in LORA_EXTENSIONS
    ]
    image_paths = [
        path for path in all_files if path.suffix.lower() in IMAGE_EXTENSIONS
    ]
    text_paths = [
        path
        for path in all_files
        if path.suffix.lower() in TEXT_EXTENSIONS and path.stat().st_size <= MAX_TEXT_READ
    ]
    image_relatives = [relative_by_path[path] for path in sorted(image_paths, key=lambda p: p.stat().st_size, reverse=True)]

    loras: list[dict] = []
    skipped: list[dict] = []
    seen_hashes: set[str] = set()
    seen_names: set[str] = set()

    for path in sorted(lora_paths, key=lambda item: str(item).lower()):
        size = path.stat().st_size
        relative = relative_by_path[path]
        display = _display_name(relative)
        warning = ""
        base_model = ""
        rank = ""
        trigger = ""
        trigger_source = ""

        if size > MAX_LORA_FILE:
            skipped.append({"file": relative.as_posix(), "reason": "File is larger than 8 GB."})
            continue

        if path.suffix.lower() == ".safetensors":
            parsed = read_safetensors_header(path)
            if parsed is None:
                skipped.append(
                    {"file": relative.as_posix(), "reason": "Unreadable safetensors header."}
                )
                continue
            metadata, tensors = parsed
            if not _is_lora(tensors):
                skipped.append(
                    {
                        "file": relative.as_posix(),
                        "reason": "Not a LoRA: no LoRA tensors found in this safetensors file.",
                    }
                )
                continue
            base_model = _base_model(metadata)
            rank = _rank(tensors)
            trigger, trigger_source = _metadata_trigger(metadata)
        else:
            if "lora" not in path.name.lower():
                skipped.append(
                    {
                        "file": relative.as_posix(),
                        "reason": "Unverified model format without 'lora' in the filename.",
                    }
                )
                continue
            warning = "This file uses an older format; LoRA tensors could not be verified before import."

        file_hash = sha256_file(path)
        if file_hash in seen_hashes:
            skipped.append(
                {"file": relative.as_posix(), "reason": "Duplicate of another LoRA in this ZIP."}
            )
            continue
        seen_hashes.add(file_hash)

        if not trigger:
            candidates = [
                item
                for item in text_paths
                if item.parent == path.parent or item.parent == import_root
            ]
            trigger, trigger_source = _text_trigger(candidates)

        if display in seen_names:
            display = f"{relative.parent.name} / {display}" if relative.parent.name else display
        seen_names.add(display)

        loras.append(
            {
                "lora_id": file_hash[:16],
                "display_name": display,
                "file_name": path.name,
                "rel_path": relative.as_posix(),
                "size": size,
                "sha256": file_hash,
                "base_model": base_model,
                "rank": rank,
                "trigger": trigger,
                "trigger_source": trigger_source,
                "preview": _preview_for(relative, [relative_by_path[p] for p in lora_paths], image_relatives),
                "warning": warning,
            }
        )

    if not loras:
        detail = (
            "This ZIP contains no LoRA files. "
            f"Found {len(lora_paths)} model file(s) and {len(image_paths)} image(s)."
        )
        if skipped:
            detail += " Skipped: " + "; ".join(f"{item['file']} — {item['reason']}" for item in skipped[:4])
        manifest = {
            "import_version": IMPORT_VERSION,
            "import_id": import_id,
            "zip_name": original_name,
            "zip_hash": zip_hash,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "source_type": "zip",
            "loras": [],
            "skipped": skipped,
            "error": detail,
        }
        _write_manifest(manifest)
        raise ValueError(detail)

    manifest = {
        "import_version": IMPORT_VERSION,
        "import_id": import_id,
        "zip_name": original_name,
        "zip_hash": zip_hash,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "source_type": "zip",
        "loras": loras,
        "skipped": skipped,
        "error": "",
    }
    _write_manifest(manifest)
    return manifest


def _write_manifest(manifest: dict) -> None:
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = IMPORT_DIR / f"{manifest['import_id']}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    tmp.replace(path)


def resolve_lora(import_id: str, lora_id: str) -> tuple[Path, dict, dict]:
    manifest = load_manifest(import_id)
    if manifest is None:
        raise ValueError(
            "That import is missing or incomplete. Upload the ZIP or LoRA file again."
        )
    for entry in manifest.get("loras", []):
        if entry.get("lora_id") == lora_id:
            relative = _safe_relative(str(entry.get("rel_path") or ""))
            if relative is None:
                raise ValueError(
                    "That LoRA entry is invalid. Upload the ZIP or LoRA file again."
                )
            path = LORA_DIR / import_id / Path(*relative.parts)
            if not path.is_file():
                raise ValueError(f"The extracted LoRA file for {entry['display_name']} is missing. Upload the ZIP or LoRA file again.")
            return path, entry, manifest
    raise ValueError("That LoRA is not part of the selected import.")


def resolve_import_file(import_id: str, rel_path: str) -> Path | None:
    manifest = load_manifest(import_id)
    if manifest is None:
        return None
    relative = _safe_relative(rel_path)
    if relative is None:
        return None
    root = (LORA_DIR / import_id).resolve()
    target = root.joinpath(*relative.parts).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None
    return target if target.is_file() else None


def remove_lora(import_id: str, lora_id: str) -> bool:
    """Remove one LoRA from an import. Drops the whole import once it is empty.

    Test history (data/jobs, output/) is never touched; jobs keep their own LoRA info.
    Returns True when the LoRA was found.
    """
    manifest = load_manifest(import_id)
    if manifest is None:
        return False
    entries = manifest.get("loras", [])
    target = next((e for e in entries if e.get("lora_id") == lora_id), None)
    if target is None:
        return False
    remaining = [e for e in entries if e is not target]
    if not remaining:
        return remove_import(import_id)
    relative = _safe_relative(str(target.get("rel_path") or ""))
    if relative is not None:
        path = LORA_DIR / import_id / Path(*relative.parts)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    manifest["loras"] = remaining
    _write_manifest(manifest)
    return True


def remove_import(import_id: str) -> bool:
    if not re.fullmatch(r"[a-f0-9]{12}", import_id or ""):
        return False
    manifest_path = IMPORT_DIR / f"{import_id}.json"
    root = LORA_DIR / import_id
    found = manifest_path.exists() or root.exists()
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    try:
        manifest_path.unlink(missing_ok=True)
    except OSError:
        pass
    return found
