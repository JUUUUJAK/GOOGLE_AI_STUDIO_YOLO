# YOLO / VLM / 분류 워크플로 진단 및 모듈화 검토

## 1. 현재 구조 요약

| 구분 | YOLO | VLM | 이미지 분류 |
|------|------|-----|-------------|
| **저장소** | `tasks` 테이블 | `vlm_tasks` 테이블 | `tasks` 테이블 |
| **sourceType** | `native-yolo` | `vlm-review` | `image-classification` |
| **폴더 정의** | 디스크 경로 기반 (sync 시 생성) | JSON import 시 `vlm_tasks.folder` | 디스크 경로 (YOLO와 동일) |
| **프로젝트 연결** | `_project_map.json` (folder → projectId) | 프로젝트의 `vlmSourceFile` → 해당 sourceFile의 모든 vlm_tasks | `_project_map.json` (YOLO와 동일) |
| **집계 단위** | 폴더별 (tasks) | sourceFile별 + 폴더별 (vlm_tasks) | 폴더별 (tasks) |
| **전용 API** | - | `/api/plugins/vlm/*` (import, assign, export 등) | `/api/export/classification` |

---

## 2. 폴더/매핑/집계 방식 차이 (진단)

### 2.1 폴더 구조

- **YOLO·분류**: `syncFilesToDb()`가 디스크를 스캔해 `tasks`에 넣고, `folder`는 `folderFromAbsoluteImagePath()`로 결정. `_project_map.json`에 없는 폴더는 “미분류”.
- **VLM**: 폴더가 디스크가 아니라 **데이터 기준**. JSON import 시 `vlm_tasks`에 행이 생기고 `folder`(예: `VLM_filename`)는 그때 정해짐. 프로젝트는 **폴더 매핑이 아니라 `vlmSourceFile` 하나로** 연결됨.

→ **문제**: “폴더”의 의미가 워크플로마다 다름. YOLO/분류는 “물리 폴더”, VLM은 “소스 파일/논리 그룹”. 새 모듈을 넣을 때 “폴더”를 물리/논리 중 뭘로 쓸지 매번 결정해야 함.

### 2.2 매핑 방식

- **YOLO·분류**: `POST /api/projects/map` → `_project_map.json` 갱신 + `tasks`의 해당 `folder`에 대해 `sourceType` 일괄 UPDATE.
- **VLM**: `_project_map.json`에 **자동 보정**이 있음. `buildProjectOverview()`에서 VLM 프로젝트마다 `vlm_tasks`의 `sourceFile`로 폴더 목록을 읽어 `projectMap`에 넣음. 즉 “매핑”이 DB 내용에서 역산됨.

→ **문제**: 매핑 저장 위치·형태가 다름 (폴더↔프로젝트 vs sourceFile↔프로젝트). 새 워크플로가 “파일 하나 = 프로젝트 하나” 같은 방식을 쓰면 또 다른 분기 필요.

### 2.3 집계 방식

- **buildProjectOverview**  
  - `tasks`와 `vlm_tasks`를 `UNION`한 뒤 `folder`+`sourceType`으로 GROUP.  
  - 그 다음 `projectMap`으로 각 폴더에 `projectId` 부여.  
  - **VLM만 예외**: `vlmSourceFile`이 있는 프로젝트는 `vlm_tasks`를 sourceFile 기준으로 다시 집계하고, `statsByProject`에 합산.

- **GET /api/projects/detail**  
  - **VLM**: `vlmSourceFile`로 `vlm_tasks`만 조회해 폴더 목록·작업자별 집계.  
  - **YOLO·분류**: `projectMap`에서 해당 `projectId`의 폴더 목록을 구한 뒤, `tasks`+`vlm_tasks` UNION에서 `sourceType = projectWorkflowSourceType`으로 필터해 집계.

→ **문제**: “폴더 목록을 어디서 가져오는가”, “어느 테이블을 집계하는가”가 워크플로별로 하드코딩됨. 워크플로가 늘어나면 `if (vlm) ... else if (classification) ...`가 계속 늘어남.

### 2.4 API 분포

- **공통**: `/api/datasets`, `/api/task`, `/api/metadata`, `/api/projects`, `/api/projects/overview`, `/api/projects/detail`, `/api/projects/map`, `/api/sync`, `/api/sync/delta` 등.
- **VLM 전용**: `/api/plugins/vlm/*` (dry-run, import-json, assign, unassign, export-json, migrate).
- **분류 전용**: `/api/export/classification`.

→ **문제**: “플러그인” 네이밍은 VLM에만 쓰이고, 분류는 일반 API에 섞여 있음. 새 모듈을 “플러그인”으로 넣을지, “일반 API”로 넣을지 기준이 불명확.

---

## 3. 모듈 추가 시 예상 문제

1. **테이블/소스 이원화**  
   - `tasks` vs `vlm_tasks` 때문에 “태스크 목록”을 가져오는 모든 API가 `UNION` + `sourceType` 분기.  
   - 새 워크플로가 별도 테이블을 쓰면 `UNION`과 분기가 한 번 더 늘어남.

2. **매핑/폴더 의미 불일치**  
   - “폴더”가 물리 경로인지, 논리 그룹인지, “한 프로젝트 = 한 소스 파일”인지가 워크플로마다 다름.  
   - 새 모듈이 “태그 기반”이나 “다른 키”로 프로젝트를 묶으면, `projectMap` 구조와 `buildProjectOverview` 로직을 또 확장해야 함.

3. **집계·상세 로직 분산**  
   - `buildProjectOverview`와 `GET /api/projects/detail` 안에 워크플로별 분기가 많음.  
   - 새 워크플로 추가 시 이 두 곳 + 필요 시 overview “가상 폴더” 보정 로직까지 수정해야 해서, 한 군데만 고치면 되는 구조가 아님.

4. **프론트 분기**  
   - `App.tsx`: `isVlmTask` / `isClassificationTask`로 패널·키보드 분기.  
   - `Dashboard.tsx`: `workflowSourceType`별 뱃지·폴더 행 표시·상세 뷰.  
   - 새 워크플로는 이 모든 분기에 한 번씩 추가해야 함.

5. **플러그인 계약 미완성**  
   - `services/plugins/contracts.ts`에 `native-yolo`, `vlm-review`만 있고 `image-classification`는 없음.  
   - “워크플로 타입 → 계약”이 통일되어 있지 않으면, 새 모듈을 “계약 기반”으로 붙이기 어렵다.

---

## 4. 모듈식으로 변경 가능한지 판단

### 4.1 결론: **가능하지만, 한 번에 하기보다 단계적 정리가 필요**

- **가능한 이유**  
  - 이미 `PluginSourceType`, `PluginContract`(타입), `getPluginContract()`가 있고, VLM은 `/api/plugins/vlm/*`로 구역이 나뉘어 있음.  
  - “태스크 소스(테이블/조회)”, “폴더·매핑 방식”, “집계 규칙”, “상세 API”를 워크플로별 어댑터로 추상화할 수 있는 구조는 부분적으로 존재함.

- **한계**  
  - **데이터 레이어**: `vlm_tasks`를 없애고 전부 `tasks`로 통합하는 건 스키마/마이그레이션 부담이 큼.  
  - **매핑 통일**: VLM의 “sourceFile = 프로젝트” 방식을 폴더 매핑으로 바꾸는 건 기존 데이터/UX 영향이 있음.  
  - 따라서 “완전한 단일 모델”보다는 **“워크플로 타입별 어댑터”**로 감싸서, 새 모듈만 같은 패턴으로 추가하는 쪽이 현실적임.

### 4.2 권장 방향 (모듈식에 가깝게 가는 방법)

1. **워크플로 어댑터 정의 (백엔드)**  
   - “이 워크플로의 폴더 목록 가져오기”, “이 워크플로의 폴더별/프로젝트별 집계”, “이 워크플로의 매핑 해석”을 함수/객체로 분리.  
   - 예: `getFolderList(projectId, workflowType)`, `getFolderStats(projectId, workflowType)`, `resolveProjectMap(workflowType, project, rawMap)`.  
   - `buildProjectOverview`와 `GET /api/projects/detail`은 “어댑터 호출”만 하도록 줄이고, 분기는 어댑터 내부로.

2. **테이블은 유지, 접근만 통일**  
   - `tasks`와 `vlm_tasks`를 그대로 두고, “워크플로별로 어느 테이블(들)을 어떻게 쿼리할지”만 어댑터에서 담당.  
   - 새 워크플로가 새 테이블을 쓰면, “그 테이블을 쓰는 어댑터”만 추가하면 되게.

3. **계약 확장**  
   - `PluginContract`에 `image-classification` 추가.  
   - 필요하면 “집계/매핑 힌트”(예: `folderSource: 'filesystem' | 'vlm_source_file'`)를 타입으로 두고, 프론트/백엔드가 그에 따라 동작하게.

4. **API 네이밍/위치 정리**  
   - “워크플로 전용 API”는 `/api/plugins/<workflow>/...` 패턴을 권장하고, 분류 export도 `/api/plugins/classification/export` 같은 식으로 옮기면, “새 모듈 = 새 플러그인 디렉터리” 규칙이 생김.

5. **프론트**  
   - `workflowSourceType` → “어떤 패널/키보드/집계 표시를 쓸지”를 맵 또는 설정 객체로 두고, `isVlmTask`/`isClassificationTask` 같은 분기를 “워크플로 설정 조회” 한 번으로 줄일 수 있음.

---

## 5. 요약

| 항목 | 현재 상태 | 모듈 추가 시 리스크 | 모듈화 가능성 |
|------|-----------|---------------------|----------------|
| 폴더 구조 | YOLO/분류=물리, VLM=논리 | 새 워크플로마다 “폴더” 의미 재정의 필요 | 어댑터로 “폴더 해석” 추상화 가능 |
| 매핑 | 폴더↔프로젝트 vs sourceFile↔프로젝트 혼재 | 매핑 방식 하나 더 늘어남 | 어댑터에서 “매핑 해석” 통일 가능 |
| 집계 | overview/detail 안에 워크플로별 if 다수 | 새 워크플로마다 두 곳 이상 수정 | “집계 어댑터”로 분리 가능 |
| API | VLM만 /api/plugins, 나머지 공통 API에 혼재 | 전용 API 위치·이름 불명확 | 플러그인 경로 규칙으로 정리 가능 |
| 프론트 | sourceType/워크플로별 분기 산발 | 새 워크플로마다 여러 파일 분기 추가 | 워크플로 설정/맵으로 한 곳에서 분기 가능 |
| 계약 | image-classification 미등록 | 계약 기반 확장 어려움 | contracts 확장으로 해소 가능 |

**정리**: 지금 구조 그대로 새 모듈을 추가하면 분기와 예외가 계속 늘어나서 유지보수 비용이 커짐. 다만 테이블/매핑을 통합하는 대신 **“워크플로별 어댑터 + 계약 확장 + API/프론트 규칙 정리”**로 가면, 새 모듈을 추가할 때 터치하는 범위를 줄이면서 점진적으로 모듈식에 가깝게 변경할 수 있다.
