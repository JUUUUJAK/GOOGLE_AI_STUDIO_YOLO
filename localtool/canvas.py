# -*- coding: utf-8 -*-
"""
YOLO annotation canvas: draw, select, move, resize, pan, zoom, undo/redo, copy/paste.
Matches AnnotationCanvas.tsx behavior.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Set, Tuple

from PyQt6.QtCore import Qt, QPointF, QRectF, pyqtSignal
from PyQt6.QtGui import (
    QPainter,
    QColor,
    QPen,
    QBrush,
    QWheelEvent,
    QMouseEvent,
    QKeyEvent,
    QPixmap,
)
from PyQt6.QtWidgets import (
    QGraphicsView,
    QGraphicsScene,
    QGraphicsPixmapItem,
    QGraphicsRectItem,
    QGraphicsItem,
    QApplication,
)

from yolo_io import BoundingBox, YoloClass, _new_id

MIN_BOX_SIZE = 0.002
HANDLE_SIZE = 10
RESIZE_HANDLES = ("tl", "tr", "bl", "br")


@dataclass
class CanvasState:
    boxes: List[BoundingBox] = field(default_factory=list)
    selected_ids: Set[str] = field(default_factory=set)
    current_class: Optional[YoloClass] = None
    classes: List[YoloClass] = field(default_factory=list)


def _contrast_color(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return "black"
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    yiq = (r * 299 + g * 587 + b * 114) / 1000
    return "black" if yiq >= 128 else "white"


class BoxRectItem(QGraphicsRectItem):
    """Single box on canvas. Coords in scene (pixel) space."""
    def __init__(self, box: BoundingBox, class_info: Optional[YoloClass], img_w: float, img_h: float):
        self._box = box
        self._class_info = class_info
        self._img_w = max(img_w, 1)
        self._img_h = max(img_h, 1)
        x = box.x * self._img_w
        y = box.y * self._img_h
        w = box.w * self._img_w
        h = box.h * self._img_h
        super().__init__(0, 0, w, h)
        self.setPos(x, y)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, False)
        self.setZValue(10)
        self.setAcceptHoverEvents(True)
        self._selected = False
        self._hovered = False
        self._update_pen_brush()

    @property
    def box(self) -> BoundingBox:
        return self._box

    def set_box(self, box: BoundingBox, img_w: float, img_h: float) -> None:
        self._box = box
        self._img_w = max(img_w, 1)
        self._img_h = max(img_h, 1)
        self.setRect(0, 0, box.w * self._img_w, box.h * self._img_h)
        self.setPos(box.x * self._img_w, box.y * self._img_h)
        self._update_pen_brush()

    def set_selected(self, v: bool) -> None:
        if self._selected != v:
            self._selected = v
            self._update_pen_brush()

    def set_hovered(self, v: bool) -> None:
        if self._hovered != v:
            self._hovered = v
            self._update_pen_brush()

    def _update_pen_brush(self) -> None:
        color = self._class_info.color if self._class_info else "#888"
        qc = QColor(color)
        pen = QPen(qc, 2)
        if self._box.is_auto_label:
            pen.setStyle(Qt.PenStyle.DashLine)
        if self._selected:
            pen.setWidth(4)
        self.setPen(pen)
        a = 30 if self._selected else 20
        self.setBrush(QBrush(QColor(qc.red(), qc.green(), qc.blue(), a)))

    def paint(self, painter: QPainter, option, widget=None) -> None:
        super().paint(painter, option, widget)


class YoloCanvas(QGraphicsView):
    """Main canvas: image + boxes. Normalized coords 0-1 internally."""
    annotationsChanged = pyqtSignal(list)  # list[BoundingBox]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setScene(QGraphicsScene(self))
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setBackgroundBrush(QColor(30, 30, 35))

        self._pixmap_item: Optional[QGraphicsPixmapItem] = None
        self._img_size: Tuple[int, int] = (1, 1)

        self._boxes: List[BoundingBox] = []
        self._class_list: List[YoloClass] = []
        self._current_class: Optional[YoloClass] = None
        self._box_items: List[BoxRectItem] = []
        self._selected_ids: Set[str] = set()
        self._hidden_class_ids: Set[int] = set()

        self._undo_stack: List[List[BoundingBox]] = []
        self._redo_stack: List[List[BoundingBox]] = []
        self._clipboard: List[BoundingBox] = []

        self._tool_mode = "SELECT"  # SELECT | PAN
        self._mod_key_held = False  # N or F for move/resize
        self._space_held = False
        self._is_panning = False
        self._last_pan_pos: Optional[QPointF] = None

        self._is_drawing = False
        self._draw_start: Optional[Tuple[float, float]] = None
        self._draw_current: Optional[Tuple[float, float]] = None

        self._is_dragging = False
        self._drag_start_norm: Optional[Tuple[float, float]] = None
        self._drag_snapshot: List[BoundingBox] = []
        self._resize_handle: Optional[str] = None

        self._show_labels = True
        self._show_pixel_sizes = False
        self._dim_boxes = False
        self._fill_opacity = 20  # 0-100
        self._box_thickness = 2

    def set_image(self, pixmap: QPixmap) -> None:
        self.scene().clear()
        self._box_items.clear()
        if pixmap.isNull():
            self._pixmap_item = None
            self._img_size = (1, 1)
            return
        self._pixmap_item = QGraphicsPixmapItem(pixmap)
        self._pixmap_item.setZValue(0)
        self.scene().addItem(self._pixmap_item)
        w, h = pixmap.width(), pixmap.height()
        self._img_size = (w, h)
        self.scene().setSceneRect(0, 0, w, h)
        self.fitInView(self._pixmap_item, Qt.AspectRatioMode.KeepAspectRatio)
        self._rebuild_box_items()

    def set_annotations(self, boxes: List[BoundingBox]) -> None:
        self._boxes = [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in boxes]
        self._redo_stack.clear()
        self._rebuild_box_items()
        self._sync_selection_to_items()

    def get_annotations(self) -> List[BoundingBox]:
        return [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in self._boxes]

    def set_classes(self, classes: List[YoloClass]) -> None:
        self._class_list = list(classes)
        if classes and (not self._current_class or self._current_class.id >= len(classes)):
            self._current_class = classes[0]
        self._rebuild_box_items()

    def set_current_class(self, c: Optional[YoloClass]) -> None:
        self._current_class = c

    def set_hidden_class_ids(self, class_ids: Set[int]) -> None:
        self._hidden_class_ids = set(class_ids)
        for item in self._box_items:
            item.setVisible(item.box.class_id not in self._hidden_class_ids)

    def _class_for(self, class_id: int) -> Optional[YoloClass]:
        for c in self._class_list:
            if c.id == class_id:
                return c
        return None

    def _rebuild_box_items(self) -> None:
        for item in self._box_items:
            self.scene().removeItem(item)
        self._box_items.clear()
        for box in self._boxes:
            ci = self._class_for(box.class_id)
            item = BoxRectItem(box, ci, self._img_size[0], self._img_size[1])
            item.set_selected(box.id in self._selected_ids)
            item.setVisible(box.class_id not in self._hidden_class_ids)
            self.scene().addItem(item)
            self._box_items.append(item)

    def _sync_selection_to_items(self) -> None:
        for item in self._box_items:
            item.set_selected(item.box.id in self._selected_ids)

    def _scene_to_norm(self, scene_pos: QPointF) -> Tuple[float, float]:
        if not self._pixmap_item or self._img_size[0] <= 0 or self._img_size[1] <= 0:
            return (0.0, 0.0)
        r = self._pixmap_item.sceneBoundingRect()
        x = (scene_pos.x() - r.x()) / r.width() if r.width() > 0 else 0
        y = (scene_pos.y() - r.y()) / r.height() if r.height() > 0 else 0
        x = max(0.0, min(1.0, x))
        y = max(0.0, min(1.0, y))
        return (x, y)

    def _map_to_scene_norm(self, event: QMouseEvent) -> Tuple[float, float]:
        pos = self.mapToScene(event.pos())
        return self._scene_to_norm(pos)

    def _save_history(self) -> None:
        state = [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in self._boxes]
        self._undo_stack.append(state)
        self._redo_stack.clear()

    def _emit_annotations(self) -> None:
        self.annotationsChanged.emit(self.get_annotations())

    def _apply_undo(self) -> None:
        if not self._undo_stack:
            return
        prev = self._undo_stack.pop()
        self._redo_stack.append(self.get_annotations())
        self._boxes = [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in prev]
        self._rebuild_box_items()
        self._sync_selection_to_items()
        self._emit_annotations()

    def _apply_redo(self) -> None:
        if not self._redo_stack:
            return
        next_state = self._redo_stack.pop()
        self._undo_stack.append(self.get_annotations())
        self._boxes = [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in next_state]
        self._rebuild_box_items()
        self._sync_selection_to_items()
        self._emit_annotations()

    def _delete_selected(self) -> None:
        if not self._selected_ids:
            return
        self._save_history()
        self._boxes = [b for b in self._boxes if b.id not in self._selected_ids]
        self._selected_ids.clear()
        self._rebuild_box_items()
        self._emit_annotations()

    def _hit_test_handles(self, nx: float, ny: float) -> Optional[Tuple[str, BoundingBox]]:
        if self._img_size[0] <= 0 or self._img_size[1] <= 0:
            return None
        margin = 0.012  # normalized margin for handle hit
        for box in self._boxes:
            if box.id not in self._selected_ids:
                continue
            x, y, w, h = box.x, box.y, box.w, box.h
            if abs(nx - x) < margin and abs(ny - y) < margin:
                return ("tl", box)
            if abs(nx - (x + w)) < margin and abs(ny - y) < margin:
                return ("tr", box)
            if abs(nx - x) < margin and abs(ny - (y + h)) < margin:
                return ("bl", box)
            if abs(nx - (x + w)) < margin and abs(ny - (y + h)) < margin:
                return ("br", box)
        return None

    def _hit_test_boxes(self, nx: float, ny: float) -> List[BoundingBox]:
        hits = []
        for box in self._boxes:
            if box.x <= nx <= box.x + box.w and box.y <= ny <= box.y + box.h:
                hits.append(box)
        return hits

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.RightButton:
            norm = self._map_to_scene_norm(event)
            hits = self._hit_test_boxes(norm[0], norm[1])
            if hits:
                to_remove = hits[-1].id
                self._save_history()
                self._boxes = [b for b in self._boxes if b.id != to_remove]
                self._selected_ids.discard(to_remove)
                self._rebuild_box_items()
                self._sync_selection_to_items()
                self._emit_annotations()
            event.accept()
            return

        norm = self._map_to_scene_norm(event)

        if self._tool_mode == "PAN" or event.button() == Qt.MouseButton.MiddleButton or self._space_held:
            self._is_panning = True
            self._last_pan_pos = event.position()
            event.accept()
            return

        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return

        # Resize handle
        if self._mod_key_held:
            hit = self._hit_test_handles(norm[0], norm[1])
            if hit:
                handle, box = hit
                self._selected_ids = {box.id}
                self._resize_handle = handle
                self._drag_start_norm = norm
                self._drag_snapshot = [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in self._boxes if b.id == box.id]
                self._sync_selection_to_items()
                event.accept()
                return

        # Box click: select / start drag
        if self._mod_key_held:
            hits = self._hit_test_boxes(norm[0], norm[1])
            if hits:
                cycle = [b for b in self._boxes if b in hits]
                if self._selected_ids and len(cycle) > 1 and next((b for b in cycle if b.id in self._selected_ids), None):
                    idx = next(i for i, b in enumerate(cycle) if b.id in self._selected_ids)
                    next_box = cycle[(idx + 1) % len(cycle)]
                    self._selected_ids = {next_box.id}
                else:
                    self._selected_ids = {cycle[0].id}
                if event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                    self._selected_ids ^= {cycle[0].id} if cycle[0].id in self._selected_ids else set()
                    self._selected_ids.add(cycle[0].id)
                to_drag = [b for b in self._boxes if b.id in self._selected_ids]
                if to_drag:
                    self._save_history()
                    self._is_dragging = True
                    self._drag_start_norm = norm
                    self._drag_snapshot = [BoundingBox(id=b.id, class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=b.is_auto_label) for b in to_drag]
                self._sync_selection_to_items()
                event.accept()
                return

        # Start drawing
        self._save_history()
        self._selected_ids.clear()
        self._sync_selection_to_items()
        self._is_drawing = True
        self._draw_start = norm
        self._draw_current = norm
        event.accept()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        norm = self._map_to_scene_norm(event)

        if self._is_panning and self._last_pan_pos is not None:
            delta = event.position() - self._last_pan_pos
            self._last_pan_pos = event.position()
            self.horizontalScrollBar().setValue(self.horizontalScrollBar().value() - int(delta.x()))
            self.verticalScrollBar().setValue(self.verticalScrollBar().value() - int(delta.y()))
            event.accept()
            return

        if self._is_drawing:
            self._draw_current = norm
            self.viewport().update()
            event.accept()
            return

        if self._resize_handle and self._drag_snapshot and self._drag_start_norm:
            box = self._drag_snapshot[0]
            dx = norm[0] - self._drag_start_norm[0]
            dy = norm[1] - self._drag_start_norm[1]
            x, y, w, h = box.x, box.y, box.w, box.h
            if self._resize_handle == "br":
                w = max(MIN_BOX_SIZE, w + dx)
                h = max(MIN_BOX_SIZE, h + dy)
            elif self._resize_handle == "bl":
                w = max(MIN_BOX_SIZE, w - dx)
                x = box.x + dx
                h = max(MIN_BOX_SIZE, h + dy)
            elif self._resize_handle == "tr":
                h = max(MIN_BOX_SIZE, h - dy)
                y = box.y + dy
                w = max(MIN_BOX_SIZE, w + dx)
            elif self._resize_handle == "tl":
                w = max(MIN_BOX_SIZE, w - dx)
                x = box.x + dx
                h = max(MIN_BOX_SIZE, h - dy)
                y = box.y + dy
            x = max(0, min(x, 1 - w))
            y = max(0, min(y, 1 - h))
            w = min(w, 1 - x)
            h = min(h, 1 - y)
            for i, b in enumerate(self._boxes):
                if b.id == box.id:
                    self._boxes[i] = BoundingBox(id=b.id, class_id=b.class_id, x=x, y=y, w=w, h=h, is_auto_label=False)
                    break
            self._drag_start_norm = norm
            self._rebuild_box_items()
            self._sync_selection_to_items()
            event.accept()
            return

        if self._is_dragging and self._drag_snapshot and self._drag_start_norm:
            dx = norm[0] - self._drag_start_norm[0]
            dy = norm[1] - self._drag_start_norm[1]
            ids = {b.id for b in self._drag_snapshot}
            for i, b in enumerate(self._boxes):
                if b.id not in ids:
                    continue
                snap = next(s for s in self._drag_snapshot if s.id == b.id)
                nx = max(0, min(1 - snap.w, snap.x + dx))
                ny = max(0, min(1 - snap.h, snap.y + dy))
                self._boxes[i] = BoundingBox(id=b.id, class_id=b.class_id, x=nx, y=ny, w=snap.w, h=snap.h, is_auto_label=False)
            self._drag_start_norm = norm
            self._rebuild_box_items()
            self._sync_selection_to_items()
            event.accept()
            return

        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.RightButton:
            super().mouseReleaseEvent(event)
            return

        if event.button() == Qt.MouseButton.MiddleButton or self._space_held:
            self._is_panning = False
            self._last_pan_pos = None
            event.accept()
            return

        if event.button() == Qt.MouseButton.LeftButton:
            if self._is_panning:
                self._is_panning = False
                self._last_pan_pos = None
                event.accept()
                return

            if self._is_drawing and self._draw_start and self._draw_current:
                x = min(self._draw_start[0], self._draw_current[0])
                y = min(self._draw_start[1], self._draw_current[1])
                w = abs(self._draw_current[0] - self._draw_start[0])
                h = abs(self._draw_current[1] - self._draw_start[1])
                if w > MIN_BOX_SIZE and h > MIN_BOX_SIZE and self._current_class is not None:
                    new_box = BoundingBox(
                        id=_new_id(),
                        class_id=self._current_class.id,
                        x=x, y=y, w=w, h=h,
                        is_auto_label=False,
                    )
                    self._boxes.append(new_box)
                    self._selected_ids = {new_box.id}
                    self._rebuild_box_items()
                    self._sync_selection_to_items()
                    self._emit_annotations()
                self._is_drawing = False
                self._draw_start = None
                self._draw_current = None
                self.viewport().update()
                event.accept()
                return

            self._resize_handle = None
            self._is_dragging = False
            self._drag_start_norm = None
            self._drag_snapshot = []
        event.accept()
        super().mouseReleaseEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)
        event.accept()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        key = event.key()
        if key in (Qt.Key.Key_Control, Qt.Key.Key_Shift, Qt.Key.Key_Alt):
            super().keyPressEvent(event)
            return
        if key == Qt.Key.Key_N or key == Qt.Key.Key_F:
            self._mod_key_held = True
            event.accept()
            return
        if key == Qt.Key.Key_Space:
            self._space_held = True
            event.accept()
            return
        if key == Qt.Key.Key_Z and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            if event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                self._apply_redo()
            else:
                self._apply_undo()
            event.accept()
            return
        if key == Qt.Key.Key_Y and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._apply_redo()
            event.accept()
            return
        if key in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self._delete_selected()
            event.accept()
            return
        if key == Qt.Key.Key_C and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self._clipboard = [BoundingBox(id=_new_id(), class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=False) for b in self._boxes if b.id in self._selected_ids]
            event.accept()
            return
        if key == Qt.Key.Key_V and event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            if self._clipboard:
                self._save_history()
                new_boxes = [BoundingBox(id=_new_id(), class_id=b.class_id, x=b.x, y=b.y, w=b.w, h=b.h, is_auto_label=False) for b in self._clipboard]
                self._boxes.extend(new_boxes)
                self._selected_ids = {b.id for b in new_boxes}
                self._rebuild_box_items()
                self._sync_selection_to_items()
                self._emit_annotations()
            event.accept()
            return
        if key == Qt.Key.Key_Escape:
            self._selected_ids.clear()
            self._is_drawing = False
            self._draw_start = None
            self._draw_current = None
            self._is_dragging = False
            self._resize_handle = None
            self._tool_mode = "SELECT"
            self._sync_selection_to_items()
            self.viewport().update()
            event.accept()
            return
        if key == Qt.Key.Key_V and not event.modifiers():
            self._tool_mode = "PAN" if self._tool_mode == "SELECT" else "SELECT"
            event.accept()
            return
        super().keyPressEvent(event)

    def keyReleaseEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_N or event.key() == Qt.Key.Key_F:
            self._mod_key_held = False
            event.accept()
            return
        if event.key() == Qt.Key.Key_Space:
            self._space_held = False
            event.accept()
            return
        super().keyReleaseEvent(event)

    def paintEvent(self, event) -> None:
        super().paintEvent(event)
        if self._is_drawing and self._draw_start and self._draw_current and self._pixmap_item:
            from PyQt6.QtWidgets import QStyleOptionGraphicsItem
            from PyQt6.QtGui import QPainter
            painter = QPainter(self.viewport())
            r = self._pixmap_item.sceneBoundingRect()
            pt = self.mapFromScene(r.topLeft())
            scale_x = self.transform().m11()
            scale_y = self.transform().m22()
            x = pt.x() + self._draw_start[0] * r.width() * scale_x
            y = pt.y() + self._draw_start[1] * r.height() * scale_y
            w = (self._draw_current[0] - self._draw_start[0]) * r.width() * scale_x
            h = (self._draw_current[1] - self._draw_start[1]) * r.height() * scale_y
            if w < 0:
                x += w
                w = -w
            if h < 0:
                y += h
                h = -h
            painter.setPen(QPen(QColor(255, 255, 255), 2, Qt.PenStyle.DashLine))
            painter.setBrush(QBrush(QColor(255, 255, 255, 25)))
            painter.drawRect(int(x), int(y), int(w), int(h))
            painter.end()

    def reset_undo_redo(self) -> None:
        """Call when switching image."""
        self._undo_stack.clear()
        self._redo_stack.clear()
