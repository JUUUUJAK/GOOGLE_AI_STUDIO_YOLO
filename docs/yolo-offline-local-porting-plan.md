# YOLO 작업 기능 로컬 포팅 — 서버 없이 빌드만 (YoloLabel 스타일)

## 1. 목표

- **YoloLabel처럼**: 실행 파일(또는 정적 빌드) 하나로, **별도 서버 구현·실행 없이** 로컬 폴더만 지정해서 사용.
- **포함**: 작업폴더 열기 → 이미지 목록 → **AnnotationCanvas**(2클릭 bbox) → 클래스 선택 → **.txt 저장** (같은 폴더에). 라벨 파일 열기(클래스 목록), 이전/다음(+저장), 작업 저장.
- **제외**: 로그인, 프로젝트/매핑, VLM, 분류, 공지, 이슈, 스케줄 등.

---

## 2. 서버 없이 동작하는 두 가지 방식

| 방식 | 설명 | 결과물 |
|------|------|--------|
| **A. Electron** | 앱 하나가 파일 I/O 담당. HTTP 서버 없음. Main에서 `fs`로 폴더 스캔·.txt 저장. | 단일 exe/app (YoloLabel과 유사) |
| **B. 브라우저 + File System Access API** | 순수 정적 빌드. "작업폴더 열기"로 디렉터리 선택 → API로 이미지·.txt 읽기/쓰기. | HTML/JS 빌드만 (Chrome/Edge) |

**권장**: YoloLabel과 가장 비슷한 건 **A. Electron**. 브라우저만 쓰고 싶다면 **B** 선택.

---

## 3. 방식 A — Electron (서버 없음, 단일 exe)

- **구조**: Main 프로세스에서 "작업폴더 열기"로 선택한 경로 기준으로 `ipcMain`으로 이미지 스캔·.txt 읽기/쓰기·라벨 파일 읽기. Renderer는 `window.electron.invoke(...)` IPC만 사용. **HTTP 서버 없음.**
- **빌드**: `electron-builder` 등으로 패키징 → exe(dmg) 하나.

---

## 4. 방식 B — 브라우저 + File System Access API

- **구조**: `showDirectoryPicker()`로 폴더 선택 후 `FileSystemFileHandle`로 이미지 목록·.txt read/write. **정적 빌드만 배포, API 서버 없음.**
- **제약**: Chrome/Edge 등. 폴더 허용 필요.

---

## 5. 공통 — 오프라인용 UI/진입점

- **진입점**: `src/AppOffline.tsx` + `src/main-offline.tsx`.
- **화면 (YoloLabel 참고)**: 상단 "작업폴더 열기 (Ctrl+O)", "라벨파일 열기 (Ctrl+L)", "작업 저장 (Ctrl+S)". 좌/하단 이미지 목록 또는 이전/다음. 중앙 **AnnotationCanvas**. 우측 클래스 목록. 데이터는 (A) Electron IPC 또는 (B) File System Access API만 사용.

---

## 6. 오프라인 리소스 (공통)

- **폰트**: CDN 제거, 로컬 폰트만 사용 (예: `fonts/NanumSquareNeo`).
- **Tailwind**: CDN 대신 빌드 시 Tailwind CSS 번들에 포함.

---

## 7. 실행 흐름 (서버 없음)

- **Electron**: exe 실행 → 작업폴더 열기 → 이미지 목록 표시 → 라벨링 → .txt는 같은 폴더에 저장.
- **브라우저**: 정적 빌드 열기 → 작업폴더 열기(디렉터리 허용) → 동일.

---

## 8. 구현 순서 제안

1. **오프라인 진입점**: `AppOffline.tsx` + `main-offline.tsx`. 로그인/대시보드 없이 "작업폴더 열기" + 이미지 목록 + `AnnotationCanvas`만.
2. **데이터 레이어 (택 1)**
   - **Electron**: main에서 폴더 선택·스캔·.txt read/write IPC 구현, preload 노출, renderer에서 IPC만 호출.
   - **File System Access API**: 폴더 선택 → 이미지 목록·라벨 읽기/쓰기 모듈 구현.
3. **AnnotationCanvas 연동**: 기존 컴포넌트 재사용. 데이터 소스만 IPC 또는 File API 결과로 교체.
4. **라벨 파일**: 작업폴더 또는 별도 .txt에서 클래스 목록 로드.
5. **빌드**: Electron이면 `electron-builder` 설정. 브라우저면 `vite build`만.

---

## 9. 파일 변경 요약

| 구분 | 내용 |
|------|------|
| **신규** | `src/AppOffline.tsx`, `src/main-offline.tsx`, (A) `electron-main.js`, `preload.js`, (B) File System Access API 레이어 |
| **수정** | `package.json` (scripts, Electron 또는 빌드 진입점), 오프라인용 HTML·Tailwind |
| **미사용** | **서버 구현 없음.** 별도 Node HTTP 서버·`offline-server` 불필요. |

이렇게 하면 **서버 구현 없이** 빌드만으로 YoloLabel처럼 로컬 폴더 기반 YOLO 라벨링 앱을 만들 수 있다.
