# -*- coding: utf-8 -*-
"""
YOLO Local Tool - standalone annotation app.
이전/다음 (+Save), 작업폴더 열기 (Ctrl+O), 작업 저장 (Ctrl+S), 라벨파일 열기 (Ctrl+L), 이미지 삭제.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QAction, QKeySequence, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QMainWindow,
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QPushButton,
    QLabel,
    QComboBox,
    QFileDialog,
    QMessageBox,
    QStatusBar,
    QFrame,
    QScrollArea,
    QToolButton,
    QSizePolicy,
)

# Allow running from project root or from localtool/
sys.path.insert(0, str(Path(__file__).resolve().parent))
from yolo_io import (
    list_images_in_folder,
    load_annotations_for_image,
    save_annotations_for_image,
    load_labels_from_txt,
    delete_image_and_label,
    BoundingBox,
    YoloClass,
)
from canvas import YoloCanvas


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("YOLO Local Tool")
        self.setMinimumSize(900, 600)
        self.resize(1200, 800)

        self._work_folder: str = ""
        self._image_paths: list[str] = []
        self._current_index: int = -1
        self._label_file: str = ""
        self._label_paths: list[str] = []  # for 라벨셋 dropdown
        self._classes: list[YoloClass] = []
        self._hidden_class_ids: set[int] = set()
        self._class_eye_buttons: dict[int, QToolButton] = {}

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout()
        central.setLayout(layout)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)

        # --- Toolbar row ---
        toolbar = QFrame()
        toolbar.setStyleSheet("QFrame { background-color: #1e293b; border-radius: 8px; padding: 6px; }")
        tlay = QHBoxLayout()
        toolbar.setLayout(tlay)
        tlay.setSpacing(12)

        self._btn_prev = QPushButton("이전 (+Save)")
        self._btn_prev.setMinimumWidth(120)
        self._btn_prev.clicked.connect(self._go_prev)
        tlay.addWidget(self._btn_prev)

        self._btn_next = QPushButton("다음 (+Save)")
        self._btn_next.setMinimumWidth(120)
        self._btn_next.clicked.connect(self._go_next)
        tlay.addWidget(self._btn_next)

        tlay.addSpacing(24)

        self._btn_open_folder = QPushButton("작업폴더 열기 (Ctrl+O)")
        self._btn_open_folder.setMinimumWidth(180)
        self._btn_open_folder.clicked.connect(self._open_work_folder)
        tlay.addWidget(self._btn_open_folder)

        self._btn_save = QPushButton("작업 저장 (Ctrl+S)")
        self._btn_save.setMinimumWidth(140)
        self._btn_save.clicked.connect(self._save_current)
        tlay.addWidget(self._btn_save)

        self._btn_open_labels = QPushButton("라벨파일 열기 (Ctrl+L)")
        self._btn_open_labels.setMinimumWidth(160)
        self._btn_open_labels.clicked.connect(self._open_label_file)
        tlay.addWidget(self._btn_open_labels)

        self._btn_delete_img = QPushButton("이미지 삭제")
        self._btn_delete_img.setMinimumWidth(100)
        self._btn_delete_img.clicked.connect(self._delete_current_image)
        self._btn_delete_img.setStyleSheet("QPushButton { background-color: #7f1d1d; color: #fecaca; } QPushButton:hover { background-color: #991b1b; }")
        tlay.addWidget(self._btn_delete_img)

        tlay.addStretch()

        self._class_combo = QComboBox()
        self._class_combo.setMinimumWidth(160)
        self._class_combo.currentIndexChanged.connect(self._on_class_changed)
        tlay.addWidget(QLabel("Active Class:"))
        tlay.addWidget(self._class_combo)

        layout.addWidget(toolbar)

        # --- Content: left sidebar + canvas ---
        content = QWidget()
        content_layout = QHBoxLayout()
        content.setLayout(content_layout)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(8)

        # --- Left sidebar: 라벨셋 + CLASSES ---
        sidebar = QFrame()
        sidebar.setFixedWidth(260)
        sidebar.setStyleSheet("QFrame { background-color: #1e293b; border-radius: 8px; padding: 8px; }")
        side_lay = QVBoxLayout()
        sidebar.setLayout(side_lay)
        side_lay.setSpacing(8)

        side_lay.addWidget(QLabel("라벨셋 (Label Set)"))
        self._label_combo = QComboBox()
        self._label_combo.setMinimumWidth(220)
        self._label_combo.currentIndexChanged.connect(self._on_label_set_changed)
        side_lay.addWidget(self._label_combo)

        side_lay.addWidget(QLabel("CLASSES"))
        self._classes_scroll = QScrollArea()
        self._classes_scroll.setWidgetResizable(True)
        self._classes_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._classes_scroll.setStyleSheet("QScrollArea { border: none; background: transparent; }")
        self._classes_container = QWidget()
        self._classes_layout = QVBoxLayout()
        self._classes_container.setLayout(self._classes_layout)
        self._classes_layout.setContentsMargins(0, 0, 0, 0)
        self._classes_layout.setSpacing(2)
        self._classes_scroll.setWidget(self._classes_container)
        side_lay.addWidget(self._classes_scroll, 1)

        content_layout.addWidget(sidebar)

        # --- Canvas in scroll ---
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setStyleSheet("QScrollArea { background-color: #0f172a; }")
        self._canvas = YoloCanvas(self)
        self._canvas.annotationsChanged.connect(self._on_annotations_changed)
        scroll.setWidget(self._canvas)
        content_layout.addWidget(scroll, 1)

        layout.addWidget(content, 1)

        self._status = QStatusBar()
        self.setStatusBar(self._status)
        self._status.showMessage("작업폴더를 열어 주세요. (Ctrl+O)")

        # Shortcuts
        open_folder = QAction(self)
        open_folder.setShortcut(QKeySequence("Ctrl+O"))
        open_folder.triggered.connect(self._open_work_folder)
        self.addAction(open_folder)

        save_act = QAction(self)
        save_act.setShortcut(QKeySequence("Ctrl+S"))
        save_act.triggered.connect(self._save_current)
        self.addAction(save_act)

        open_labels = QAction(self)
        open_labels.setShortcut(QKeySequence("Ctrl+L"))
        open_labels.triggered.connect(self._open_label_file)
        self.addAction(open_labels)

        # A / D: 이전 / 다음 이미지
        prev_act = QAction(self)
        prev_act.setShortcut(QKeySequence("A"))
        prev_act.triggered.connect(self._go_prev)
        self.addAction(prev_act)
        next_act = QAction(self)
        next_act.setShortcut(QKeySequence("D"))
        next_act.triggered.connect(self._go_next)
        self.addAction(next_act)

        self._update_buttons()

    def _open_work_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "작업 폴더 선택")
        if not folder:
            return
        self._work_folder = folder
        self._image_paths = list_images_in_folder(folder)
        self._current_index = 0 if self._image_paths else -1
        self._refresh_label_set_combo()
        self._status.showMessage(f"폴더: {folder} — 이미지 {len(self._image_paths)}장")
        self._update_buttons()
        self._load_current_image()

    def _refresh_label_set_combo(self) -> None:
        self._label_combo.blockSignals(True)
        self._label_combo.clear()
        self._label_paths = []
        if self._work_folder:
            labels_dir = Path(self._work_folder) / "labels"
            if labels_dir.is_dir():
                for p in sorted(labels_dir.glob("*.txt")):
                    self._label_paths.append(str(p.resolve()))
                    self._label_combo.addItem(p.name, str(p.resolve()))
            for p in sorted(Path(self._work_folder).glob("*.txt")):
                path_str = str(p.resolve())
                if path_str not in self._label_paths:
                    self._label_paths.append(path_str)
                    self._label_combo.addItem(p.name, path_str)
        if self._label_file and self._label_file not in self._label_paths:
            self._label_paths.insert(0, self._label_file)
            self._label_combo.insertItem(0, Path(self._label_file).name, self._label_file)
        self._label_combo.addItem("다른 파일 열기...", None)
        idx = self._label_paths.index(self._label_file) if self._label_file in self._label_paths else -1
        if idx >= 0:
            self._label_combo.setCurrentIndex(idx)
        self._label_combo.blockSignals(False)

    def _on_label_set_changed(self, index: int) -> None:
        path = self._label_combo.currentData()
        if path is None:
            self._label_combo.blockSignals(True)
            prev = self._label_paths.index(self._label_file) if self._label_file in self._label_paths else 0
            self._label_combo.setCurrentIndex(min(prev, self._label_combo.count() - 2))
            self._label_combo.blockSignals(False)
            self._open_label_file()
            return
        if not path:
            return
        self._label_file = path
        self._classes = load_labels_from_txt(path)
        self._rebuild_class_combo_and_sidebar()
        self._canvas.set_classes(self._classes)
        if self._classes:
            self._canvas.set_current_class(self._classes[0])
        self._canvas.set_hidden_class_ids(self._hidden_class_ids)
        self._status.showMessage(f"라벨: {Path(path).name} — 클래스 {len(self._classes)}개")
        self._load_current_image()

    def _rebuild_class_combo_and_sidebar(self) -> None:
        self._class_combo.clear()
        self._class_eye_buttons.clear()
        while self._classes_layout.count():
            item = self._classes_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for c in self._classes:
            self._class_combo.addItem(c.name, c)
            row = QWidget()
            row_lay = QHBoxLayout()
            row.setLayout(row_lay)
            row_lay.setContentsMargins(4, 2, 4, 2)
            dot = QLabel()
            dot.setFixedSize(12, 12)
            dot.setStyleSheet(f"background-color: {c.color}; border-radius: 6px;")
            row_lay.addWidget(dot)
            row_lay.addWidget(QLabel(f"{c.name} ({c.id + 1})"))
            row_lay.addStretch()
            eye_btn = QToolButton()
            eye_btn.setToolTip("클래스 표시 on/off")
            eye_btn.setCheckable(True)
            eye_btn.setChecked(c.id not in self._hidden_class_ids)
            eye_btn.setStyleSheet("QToolButton { font-size: 14px; } QToolButton:checked { color: #38bdf8; } QToolButton:!checked { color: #64748b; }")
            eye_btn.setText("\U0001f441")  # 👁
            eye_btn.clicked.connect(lambda checked=False, cls_id=c.id: self._toggle_class_visibility(cls_id))
            row_lay.addWidget(eye_btn)
            self._class_eye_buttons[c.id] = eye_btn
            self._classes_layout.addWidget(row)
        if self._classes:
            self._class_combo.setCurrentIndex(0)

    def _toggle_class_visibility(self, class_id: int) -> None:
        if class_id in self._hidden_class_ids:
            self._hidden_class_ids.discard(class_id)
        else:
            self._hidden_class_ids.add(class_id)
        self._canvas.set_hidden_class_ids(self._hidden_class_ids)
        if class_id in self._class_eye_buttons:
            self._class_eye_buttons[class_id].setChecked(class_id not in self._hidden_class_ids)

    def _open_label_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "라벨 파일 선택",
            self._work_folder or "",
            "Text (*.txt);;All (*)",
        )
        if not path:
            return
        self._label_file = path
        self._classes = load_labels_from_txt(path)
        self._refresh_label_set_combo()
        self._rebuild_class_combo_and_sidebar()
        if self._classes:
            self._canvas.set_classes(self._classes)
            self._canvas.set_current_class(self._classes[0])
        self._canvas.set_hidden_class_ids(self._hidden_class_ids)
        self._status.showMessage(f"라벨: {Path(path).name} — 클래스 {len(self._classes)}개")
        self._load_current_image()

    def _save_current(self) -> None:
        if self._current_index < 0 or self._current_index >= len(self._image_paths):
            return
        path = self._image_paths[self._current_index]
        boxes = self._canvas.get_annotations()
        save_annotations_for_image(path, boxes)
        self._status.showMessage("저장했습니다.")
        self._update_buttons()

    def _load_current_image(self) -> None:
        if self._current_index < 0 or self._current_index >= len(self._image_paths):
            self._canvas.set_image(QPixmap())
            self._canvas.set_annotations([])
            self._update_buttons()
            return
        path = self._image_paths[self._current_index]
        pixmap = QPixmap(path)
        if pixmap.isNull():
            self._status.showMessage(f"이미지를 열 수 없습니다: {path}")
            self._canvas.set_image(QPixmap())
            self._canvas.set_annotations([])
            return
        self._canvas.set_image(pixmap)
        boxes = load_annotations_for_image(path)
        self._canvas.set_annotations(boxes)
        self._canvas.set_classes(self._classes)
        if self._classes:
            self._canvas.set_current_class(self._class_combo.currentData() or self._classes[0])
        self._canvas.set_hidden_class_ids(self._hidden_class_ids)
        self._canvas.reset_undo_redo()
        idx = self._current_index + 1
        total = len(self._image_paths)
        self._status.showMessage(f"{Path(path).name} ({idx}/{total})")
        self._update_buttons()

    def _go_prev(self) -> None:
        self._save_current()
        if self._current_index <= 0:
            return
        self._current_index -= 1
        self._load_current_image()

    def _go_next(self) -> None:
        self._save_current()
        if self._current_index < 0 or self._current_index >= len(self._image_paths) - 1:
            return
        self._current_index += 1
        self._load_current_image()

    def _delete_current_image(self) -> None:
        if self._current_index < 0 or self._current_index >= len(self._image_paths):
            return
        path = self._image_paths[self._current_index]
        ok = QMessageBox.question(
            self,
            "이미지 삭제",
            f"다음 파일을 삭제할까요?\n{Path(path).name}\n(같은 이름의 라벨 .txt도 삭제됩니다.)",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if ok != QMessageBox.StandardButton.Yes:
            return
        delete_image_and_label(path)
        self._image_paths.pop(self._current_index)
        if self._current_index >= len(self._image_paths) and self._current_index > 0:
            self._current_index -= 1
        self._load_current_image()
        self._status.showMessage("이미지와 라벨을 삭제했습니다.")

    def _on_annotations_changed(self, boxes: list) -> None:
        pass  # could enable save button or show dirty state

    def _on_class_changed(self, index: int) -> None:
        c = self._class_combo.currentData()
        if c is not None:
            self._canvas.set_current_class(c)

    def _update_buttons(self) -> None:
        has_folder = bool(self._image_paths)
        has_current = 0 <= self._current_index < len(self._image_paths)
        self._btn_prev.setEnabled(has_current and self._current_index > 0)
        self._btn_next.setEnabled(has_current and self._current_index < len(self._image_paths) - 1)
        self._btn_save.setEnabled(has_current)
        self._btn_delete_img.setEnabled(has_current)


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
