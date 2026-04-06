# Intellivix Data Studio (Local)

> 이 폴더는 [`yolo_localtool`](../yolo_localtool/)에서 복사한 **개발용 사본**입니다.  
> 일상 사용은 기존 로컬툴을 유지하고, **YOLO/VLM 통합·모드 분리** 등은 여기서 진행합니다.  
> 처음 clone 후: `npm install` → `npm run electron:dev`

---

기존 서버 프로젝트와 **독립적으로** 동작하는 로컬 전용 도구입니다 (현재 본문은 YOLO 라벨링 중심).  
Electron으로 실행하며, 작업 폴더와 라벨(.txt) 클래스 파일만 있으면 서버 없이 사용할 수 있습니다.

## 실행 방법

- **개발 모드**: `npm run electron:dev` (Vite dev 서버 + Electron)
- **빌드 후 실행**: `npm run build` → `npm run electron`
- **설치용 패키지 생성**: `npm run electron:build` (release 폴더에 exe 등 생성)

## 빌드 시 "Cannot create symbolic link" 오류 (Windows)

Windows에서 `npm run electron:build` 시 심볼릭 링크 권한 오류가 나면 다음 중 하나를 적용하세요.

1. **개발자 모드 켜기** (권장): **설정** → **개인 정보 및 보안** → **개발자용** → **개발자 모드** 켜기. 이렇게 하면 관리자 없이도 심볼릭 링크 생성이 가능합니다.
2. **관리자 권한으로 빌드**: 터미널(또는 PowerShell)을 **관리자 권한으로 실행**한 뒤 `npm run electron:build` 실행.
3. **캐시 삭제 후 재시도**: `%LOCALAPPDATA%\electron-builder\Cache` 폴더를 삭제한 뒤 다시 `npm run electron:build` 실행.

## 다른 PC에서 복사 후 화면이 안 나올 때

- **폴더 전체 복사**: exe 하나만 복사하면 안 됩니다. `release/win-unpacked/` **폴더 전체**를 복사한 뒤, 그 안의 exe를 실행하세요.
- **빈 창만 나오는 경우**: GPU/드라이버 문제일 수 있습니다. 앱에 GPU 비활성화 옵션이 포함되어 있어 대부분의 PC에서 동작합니다. 그래도 안 되면 해당 PC에서 **Visual C++ Redistributable** 설치 여부를 확인하거나, exe를 **관리자 권한**으로 실행해 보세요.

## 사용 흐름

1. **작업폴더 열기 (Ctrl+O)**: 이미지가 들어 있는 폴더 선택. 같은 폴더에 `.txt` 라벨 파일이 있으면 자동으로 매칭됩니다.
2. **라벨파일 열기 (Ctrl+L)**: 클래스 목록이 한 줄에 하나씩 적힌 `.txt` 파일 선택 (예: `person`, `car`, `bicycle`).
3. 이미지마다 바운딩 박스를 그린 뒤 **저장 (Ctrl+S)** 또는 **다음/이전 (D/A)** 으로 이동 시 자동 저장.

## VLM 검수 모드

상단 탭에서 **VLM 검수**를 선택합니다.

1. **JSON 열기 (Ctrl+L)**: 검수할 작업 JSON을 선택합니다. **JSON 파일이 들어 있는 폴더**가 워크스페이스 루트가 되며, JSON 안 이미지 경로는 **`Event/…`로 시작하는 상대 경로**를 사용합니다 (JSON과 `Event` 폴더를 같은 상위에 두는 구조). 별도의 이미지 폴더 선택은 없습니다.
3. **임시 저장 / 작업 제출**: 웹 Data Studio와 동일한 규칙으로 `sourceData`에 `ui`·`rawResultData`를 병합해 **같은 JSON 파일**에 저장합니다.

**JSON 형식** (자동 인식)

- `{ "sourceData": "…문자열…", … }` — DB와 동일
- `{ "sourceData": { "rawData": … }, … }` — `sourceData`가 **객체**인 export
- `[ { …태스크… }, … ]` — 배열이면 **첫 항목**을 검수 (저장 시 배열 구조 유지)
- `{ "tasks": [ … ], … }` 등 — `tasks` / `items` / `data` / `records` / `results` / `vlm_tasks` 안의 첫 항목
- `[{ "index": "…", "image": "Event/…", "conversations": [ … ] }, …]` — **배열**(현재 `sample.json` 형식). **A / D** 또는 **← / →**로 항목 이동(이동 전 현재 항목 저장).
- `{ "0": { "image": "Event/…", "conversations": [ … ] }, "1": { … } }` — 숫자 문자열 키 맵. **A / D**로 항목 이동(저장 동일).

이미지 경로는 `resolvedImagePath`, `rawData.image`, `imagePath` 등 여러 키를 순서대로 시도합니다.

필요한 파일들은 기존 프로젝트에서 복사해 두었으며, 이 폴더만으로 별도 구동 가능합니다.
