# YOLO Local Tool

웹 Data Studio와 분리된 로컬 전용 YOLO 어노테이션 도구입니다.  
기존 웹 툴은 수정하지 않으며, 이 폴더만 별도 실행합니다.

**두 가지 실행 방식**: (1) **Electron + React** — 웹과 동일한 AnnotationCanvas UI. (2) **Python (PyQt6)** — 별도 데스크톱 UI.

---

## 방식 1: Electron + React (권장)

웹 툴의 **AnnotationCanvas.tsx** 를 그대로 사용합니다. UI/동작이 웹과 동일합니다.

### 실행

```bash
cd localtool
npm install
npm run build
npm start
```

- `npm start`: 한 번 빌드 후 Electron 창 실행.
- 개발 시: `npm run build -- --watch` 로 빌드 감시하고, 다른 터미널에서 `npx electron .` 실행.

### 기능

- 이전/다음 (+Save), **A** / **D** 로 이미지 이동
- 작업폴더 열기 (Ctrl+O), 작업 저장 (Ctrl+S), 라벨파일 열기 (Ctrl+L), 이미지 삭제
- 라벨셋 드롭다운, CLASSES 목록 + 눈 아이콘(표시 on/off)
- 캔버스: 웹과 동일 (그리기, 선택/이동/리사이즈, Undo/Redo, 복사/붙여넣기, Pan, 줌 등)

### exe 패키징

```bash
npm install --save-dev electron-builder
npx electron-builder --dir
```

---

## 방식 2: Python (PyQt6)

### 실행

```bash
# 프로젝트 루트에서
pip install -r localtool/requirements.txt
python localtool/main.py
```

또는 `localtool` 폴더에서:

```bash
cd localtool
pip install -r requirements.txt
python main.py
```

### exe 패키징 (선택)

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --name YOLO-LocalTool localtool/main.py
```

---

## 공통: YOLO 형식

- 이미지와 같은 이름의 `.txt` (예: `image.jpg` → `image.txt`)
- 한 줄에 한 객체: `classId cx cy w h` (정규화 0~1, cx/cy는 중심)
