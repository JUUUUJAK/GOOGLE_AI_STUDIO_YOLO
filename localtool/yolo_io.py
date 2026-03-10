# -*- coding: utf-8 -*-
"""
YOLO format I/O and folder/label file helpers.
Matches logic from web app: parseYoloTxt, generateYoloTxt.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

# --- Data types (aligned with web types.ts) ---

@dataclass
class BoundingBox:
    id: str
    class_id: int
    x: float  # normalized 0-1, top-left
    y: float
    w: float  # normalized 0-1
    h: float
    is_auto_label: bool = False

@dataclass
class YoloClass:
    id: int
    name: str
    color: str  # hex e.g. "#3b82f6"


# Default palette (from constants.ts)
COLOR_PALETTE = [
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
    "#ec4899", "#06b6d4", "#84cc16", "#f43f5e", "#6366f1",
    "#14b8a6", "#d946ef", "#f97316", "#a855f7", "#0ea5e9",
]


def _new_id() -> str:
    return uuid.uuid4().hex[:9]


def parse_yolo_txt(content: str) -> List[BoundingBox]:
    """Parse YOLO format text (one line per box: classId cx cy w h)."""
    if not content or not content.strip():
        return []
    boxes = []
    for line in content.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            class_id = int(parts[0])
            cx = float(parts[1])
            cy = float(parts[2])
            w = float(parts[3])
            h = float(parts[4])
        except (ValueError, IndexError):
            continue
        x = cx - (w / 2)
        y = cy - (h / 2)
        boxes.append(BoundingBox(
            id=_new_id(),
            class_id=class_id,
            x=x, y=y, w=w, h=h,
            is_auto_label=True,
        ))
    return boxes


def generate_yolo_txt(boxes: List[BoundingBox]) -> str:
    """Generate YOLO format text from boxes."""
    lines = []
    for b in boxes:
        cx = b.x + (b.w / 2)
        cy = b.y + (b.h / 2)
        lines.append(f"{b.class_id} {cx:.6f} {cy:.6f} {b.w:.6f} {b.h:.6f}")
    return "\n".join(lines)


# Image extensions to scan in folder
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}


def list_images_in_folder(folder_path: str) -> List[str]:
    """Return list of full paths to image files in folder, sorted by name."""
    folder = Path(folder_path)
    if not folder.is_dir():
        return []
    paths = []
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
            paths.append(str(p.resolve()))
    return paths


def image_path_to_txt_path(image_path: str) -> str:
    """Same directory, same basename, .txt extension."""
    p = Path(image_path)
    return str(p.with_suffix(".txt"))


def load_labels_from_txt(label_file_path: str) -> List[YoloClass]:
    """
    Load class names from a text file (one name per line).
    Line index = class id. UTF-8.
    """
    path = Path(label_file_path)
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return []
    names = [line.strip() for line in text.strip().splitlines() if line.strip()]
    return [
        YoloClass(id=i, name=name, color=COLOR_PALETTE[i % len(COLOR_PALETTE)])
        for i, name in enumerate(names)
    ]


def load_annotations_for_image(image_path: str) -> List[BoundingBox]:
    """Load YOLO .txt for this image if it exists."""
    txt_path = image_path_to_txt_path(image_path)
    path = Path(txt_path)
    if not path.is_file():
        return []
    try:
        content = path.read_text(encoding="utf-8")
    except Exception:
        return []
    return parse_yolo_txt(content)


def save_annotations_for_image(image_path: str, boxes: List[BoundingBox]) -> None:
    """Write YOLO .txt next to image. UTF-8."""
    txt_path = image_path_to_txt_path(image_path)
    Path(txt_path).write_text(generate_yolo_txt(boxes), encoding="utf-8")


def delete_image_and_label(image_path: str) -> None:
    """Remove image file and its .txt label file if present."""
    p_img = Path(image_path)
    p_txt = p_img.with_suffix(".txt")
    if p_img.is_file():
        p_img.unlink()
    if p_txt.is_file():
        p_txt.unlink()
