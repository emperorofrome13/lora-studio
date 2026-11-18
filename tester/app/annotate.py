"""Burn the LoRA name onto every output and build contact sheets."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

ACCENT = (0, 229, 255)
WHITE = (245, 249, 252)
MUTED = (168, 184, 198)
BAR = (3, 6, 9, 226)
CANVAS = (7, 11, 16)


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    # Windows, then macOS, then common Linux fonts; Pillow's built-in font is the last resort.
    candidates = (
        [
            r"C:\Windows\Fonts\segoeuib.ttf",
            r"C:\Windows\Fonts\arialbd.ttf",
            r"C:\Windows\Fonts\bahnschrift.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
        if bold
        else [
            r"C:\Windows\Fonts\segoeui.ttf",
            r"C:\Windows\Fonts\arial.ttf",
            r"C:\Windows\Fonts\bahnschrift.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _measure(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def _wrap(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
    max_lines: int,
) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if _measure(draw, candidate, font)[0] <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and _measure(draw, last + "…", font)[0] > max_width:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    return lines


def _line_height(draw: ImageDraw.ImageDraw, font: ImageFont.FreeTypeFont) -> int:
    """Full height of one text line (ascent + descent). Measuring a glyph box alone misses the space
    above the glyphs, which grows with the font size and made big labels overlap the next line."""
    try:
        ascent, descent = font.getmetrics()
        return int(ascent + descent)
    except AttributeError:  # Pillow's old bitmap default font
        box = draw.textbbox((0, 0), "Ag", font=font)
        return box[3]


def _fit_font(
    draw: ImageDraw.ImageDraw,
    text: str,
    start_size: int,
    min_size: int,
    max_width: int,
    bold: bool,
) -> ImageFont.FreeTypeFont:
    size = start_size
    while size > min_size:
        font = _font(size, bold=bold)
        if _measure(draw, text, font)[0] <= max_width:
            return font
        size -= 1
    return _font(min_size, bold=bold)


def _format_strength(value: float) -> str:
    text = f"{float(value):g}"
    if "." not in text:
        text += ".0"
    return text


def annotate_image(
    source_path: Path,
    dest_path: Path,
    *,
    lora_name: str,
    prompt_label: str,
    strength: float,
    checkpoint: str,
    seed: int,
    trigger: str,
    positive: str,
    negative: str,
    settings: dict,
) -> Path:
    image = Image.open(source_path).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)
    pad = max(14, int(width * 0.020))
    name_start = max(22, int(width * 0.036))
    # Scales with the image (was capped at 22 px, unreadably small on 4 MP+ images).
    meta_size = max(14, min(64, int(width * 0.021)))
    meta_font = _font(meta_size)
    small_font = _font(max(12, int(meta_size * 0.82)))

    label_width = _measure(draw, "LORA", small_font)[0]
    name_x = pad + label_width + max(10, int(width * 0.012))
    name_width = width - name_x - pad
    name_font = _fit_font(draw, lora_name, name_start, 15, name_width, True)
    if _measure(draw, lora_name, name_font)[0] <= name_width:
        name_lines = [lora_name]
    else:
        name_font = _font(max(15, int(width * 0.024)), bold=True)
        name_lines = _wrap(draw, lora_name, name_font, name_width, 2)

    line_gap = max(4, int(meta_size * 0.25))
    name_line_height = _line_height(draw, name_font) + line_gap
    meta_line_height = _line_height(draw, meta_font) + line_gap
    trigger_line = f"TRIGGER · {trigger}" if trigger.strip() else ""
    name_block_height = name_line_height * len(name_lines)
    trigger_height = _line_height(draw, small_font) + line_gap if trigger_line else 0
    bar_height = pad + name_block_height + meta_line_height * 2 + trigger_height + pad

    overlay = Image.new("RGBA", (width, bar_height), BAR)
    image.paste(Image.alpha_composite(
        image.crop((0, height - bar_height, width, height)).convert("RGBA"),
        overlay,
    ).convert("RGB"), (0, height - bar_height))

    draw = ImageDraw.Draw(image)
    top = height - bar_height
    draw.rectangle([0, top, width, top + 2], fill=ACCENT)
    y = top + pad
    label_y = y + max(0, int((name_font.size - small_font.size) * 0.55))
    draw.text((pad, label_y), "LORA", font=small_font, fill=ACCENT)
    for line in name_lines:
        draw.text((name_x, y), line, font=name_font, fill=WHITE)
        y += name_line_height
    y = top + pad + name_block_height

    meta_line = f"{prompt_label}  ·  strength {_format_strength(strength)}  ·  seed {seed}"
    draw.text((pad, y), meta_line, font=meta_font, fill=WHITE)
    y += meta_line_height
    checkpoint_font = _fit_font(draw, checkpoint, meta_size, 12, width - pad * 2, False)
    draw.text((pad, y), checkpoint, font=checkpoint_font, fill=MUTED)
    y += meta_line_height
    if trigger_line:
        draw.text((pad, y), trigger_line, font=small_font, fill=MUTED)

    metadata = {
        "lora_tester": {
            "lora_name": lora_name,
            "prompt_label": prompt_label,
            "strength": float(strength),
            "checkpoint": checkpoint,
            "seed": int(seed),
            "trigger": trigger,
            **settings,
        }
    }
    pnginfo = PngImagePlugin.PngInfo()
    parameters = (
        f"{positive}\n"
        f"Negative prompt: {negative}\n"
        f"Steps: {settings.get('steps')}, Sampler: {settings.get('sampler')}, "
        f"CFG scale: {settings.get('cfg')}, Seed: {seed}, "
        f"Size: {width}x{height}, Model: {checkpoint}, "
        f"Lora: {lora_name}:{_format_strength(strength)}"
    )
    pnginfo.add_itxt("parameters", parameters)
    pnginfo.add_itxt("lora_tester", json.dumps(metadata, ensure_ascii=False))

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest_path, format="PNG", pnginfo=pnginfo, compress_level=6)
    return dest_path


def _short_strength(value: float) -> str:
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


def build_contact_sheet(
    rows: list[dict],
    strengths: list[float],
    out_path: Path,
    *,
    lora_name: str,
    checkpoint: str,
) -> Path | None:
    """rows: [{'prompt_label','prompt_id','images': {strength: path}}]"""
    usable = [
        row
        for row in rows
        if any(strength in row["images"] and Path(row["images"][strength]).exists() for strength in strengths)
    ]
    if not usable:
        return None

    with Image.open(usable[0]["images"][strengths[0]] if strengths[0] in usable[0]["images"] else next(iter(usable[0]["images"].values()))) as probe:
        aspect = probe.height / probe.width

    columns = len(strengths)
    thumb_w = 360
    thumb_h = int(thumb_w * aspect)
    gap = 14
    margin = 26
    label_h = 30
    header_h = 158
    width = margin * 2 + columns * thumb_w + (columns - 1) * gap
    height = header_h + margin + len(usable) * (label_h + thumb_h + gap) + margin
    if width > 12000 or height > 30000:
        thumb_w = 240
        thumb_h = int(thumb_w * aspect)
        width = margin * 2 + columns * thumb_w + (columns - 1) * gap
        height = header_h + margin + len(usable) * (label_h + thumb_h + gap) + margin

    canvas = Image.new("RGB", (width, height), CANVAS)
    draw = ImageDraw.Draw(canvas)
    label_font = _font(17, bold=True)
    small_font = _font(15)
    title_font = _fit_font(draw, lora_name, 34, 16, width - margin * 2, True)
    sub_font = _fit_font(draw, checkpoint, 18, 12, width - margin * 2, False)
    title_text = lora_name
    if _measure(draw, title_text, title_font)[0] > width - margin * 2:
        title_text = _wrap(draw, title_text, title_font, width - margin * 2, 1)[0]
    subtitle_text = checkpoint
    if _measure(draw, subtitle_text, sub_font)[0] > width - margin * 2:
        subtitle_text = _wrap(draw, subtitle_text, sub_font, width - margin * 2, 1)[0]

    draw.rectangle([0, 0, width, 2], fill=ACCENT)
    draw.text((margin, 22), "LORA STRENGTH CONTACT SHEET", font=small_font, fill=ACCENT)
    draw.text((margin, 44), title_text, font=title_font, fill=WHITE)
    draw.text((margin, 88), subtitle_text, font=sub_font, fill=MUTED)

    for index, strength in enumerate(strengths):
        x = margin + index * (thumb_w + gap)
        text = f"STRENGTH {_short_strength(strength)}"
        draw.text((x, 124), text, font=small_font, fill=ACCENT)

    y = header_h + margin
    for row in usable:
        draw.text((margin, y), row["prompt_label"], font=label_font, fill=WHITE)
        image_y = y + label_h
        for index, strength in enumerate(strengths):
            x = margin + index * (thumb_w + gap)
            source = row["images"].get(strength)
            if source and Path(source).exists():
                try:
                    with Image.open(source) as img:
                        img = img.convert("RGB")
                        img.thumbnail((thumb_w, thumb_h), Image.Resampling.LANCZOS)
                        offset_x = x + (thumb_w - img.width) // 2
                        offset_y = image_y + (thumb_h - img.height) // 2
                        canvas.paste(img, (offset_x, offset_y))
                except OSError:
                    draw.rectangle([x, image_y, x + thumb_w, image_y + thumb_h], outline=(60, 20, 30), width=1)
                    draw.text((x + 12, image_y + 12), "Image unreadable", font=small_font, fill=(255, 90, 110))
            else:
                draw.rectangle([x, image_y, x + thumb_w, image_y + thumb_h], outline=(40, 55, 68), width=1)
                draw.text((x + 12, image_y + 12), "Not generated", font=small_font, fill=MUTED)
            draw.rectangle([x, image_y, x + thumb_w, image_y + thumb_h], outline=(0, 229, 255, 60), width=1)
        y += label_h + thumb_h + gap

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format="JPEG", quality=92, subsampling=0)
    return out_path
