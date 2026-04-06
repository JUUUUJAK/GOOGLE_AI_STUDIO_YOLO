## Sprint Summary

### Sprint 2026-S02 (2026-02-10 ~ 2026-02-25)

### Goal
- VLM 검수 워크플로우 안정화
- 프로젝트 운영 정책 체계화(아카이브/복원 + 작업자 공개/비공개)
- UI 일관성 강화(대시보드/프로젝트/로그인 통합 톤)
- YOLO 작업 효율 개선(Undo/Redo 중심)

### KPI
- 빌드 실패 0건
- 린트 오류 0건 유지
- 작업자 화면에서 아카이브 프로젝트 노출 0건
- 프로젝트 공개 토글 기반 비노출 정책 적용 완료
- Undo/Redo 단축키 + 버튼 안정 동작

### In Scope
- VLM 검수 패널 UX 개선
- VLM JSON Export 고도화
- 프로젝트 노출 정책(Archived 비노출/공개 토글)
- 대시보드/로그인 UI 정리 및 불필요 탭 정리
- YOLO 캔버스 상호작용 개선(Undo/Redo, 선택 UX)

### Done
- [x] 검수자 권한에서도 VLM 검수 결과 확인/수정/반려 가능하도록 권한 분기 수정
- [x] GPT 응답 원본/수정 분리, `응답 복사` 버튼 추가
- [x] VLM Export: result 삽입 토글 + `original_response` 포함
- [x] VLM Export 진행률(파일 단위 순차 처리 + 진행바/퍼센트) 표시
- [x] 프로젝트 상세 폴더별 `검수 진행` 컬럼 추가
- [x] 프로젝트 아카이브(기록/통계 스냅샷) 기능 추가
- [x] 아카이브 전용 탭 및 복원(ARCHIVED -> ACTIVE) 기능 추가
- [x] 아카이브 프로젝트 작업자 화면 완전 비노출 처리
- [x] 프로젝트별 `작업자에게 공개(visibleToWorkers)` 토글 추가
- [x] 작업자 Work List/대시보드에 Archived/비공개 자동 필터 적용
- [x] YOLO Undo/Redo 추가(단축키 + 상단 아이콘 버튼)
- [x] 이미지 전환 시 Undo/Redo 메모리 초기화로 라벨 섞임 방지
- [x] `History` 탭 제거 및 관련 화면 정리(로그 데이터 로직 유지)
- [x] 로그인 아이콘을 대시보드 아이콘으로 통일(배경 제거/크기 조정)
- [x] 주요 변경사항 린트/빌드 검증 완료

### In Progress
- [ ] 아카이브 탭 검색/정렬 고도화
- [ ] 운영 가이드(아카이브 시점/복원 절차) 문서화
- [ ] 프로젝트 공개 토글 권한/운영 규칙 문서화

### Risk / Note
- YOLO 데이터는 sync 기반으로 수량 반영
- VLM 데이터는 import/export/아카이브 중심 운영이므로 별도 정리 절차 필요

### Carry-over (Next Sprint)
- 폴더명 규칙 파싱/표준화(복합/중첩 폴더 대응)
- 아카이브 정책(권한/보존기간/이력조회) 세부화

### Next Sprint Goal (추천)
- 프로젝트 운영 안정화: `아카이브/공개토글` 정책을 운영 기준으로 완결
- YOLO 작업 효율 고도화: Undo/Redo + 선택 UX 체감 품질 개선
- UI 품질 마감: 로그인/대시보드/작업화면의 시각 일관성 최종 정리
- 운영 리스크 축소: 릴리즈 전 회귀 점검 루틴 정착

### Next Sprint KPI (추천)
- 빌드 실패 0건 유지
- 린트 오류 0건 유지
- 작업자 화면에서 `ARCHIVED` 프로젝트 노출 0건 유지
- `visibleToWorkers=false` 프로젝트 노출 0건 유지
- Undo/Redo 단축키/버튼 동작 성공률 100% (체크리스트 기준)
- 이미지 전환 후 Undo/Redo 오작동 재현율 0%
- 핵심 화면(로그인/대시보드/작업화면) 신규 UI 이슈 0건
- 운영 문서(공개토글/아카이브 절차) 1건 완료

---

2026-03-03 (화) 개발일지 — 태스크 부분 로드 · API read/write · 회귀 문서
1) 배경
- C: 로그인 직후 태스크 **초기 배치만** 동기화, 나머지는 백그라운드 `loadMoreTasks`로 보강 (`services/storage.ts`, `App.tsx`).
- D: `YOLO_API_STUDIO` 라우트에서 조회는 `getReadDb`, 쓰기·sync는 `getWriteDb` 분리; `DB_READ_PATH`는 `.env.example`에 설명 추가.
2) 이번에 한 일
- 수동 점검용 [`docs/regression-checklist.md`](docs/regression-checklist.md) 추가 (로그인·fullSync·작업자/VLM/매핑·이슈·read 경로 스모크).
- [`docs/task-cache-dependencies.md`](docs/task-cache-dependencies.md): `cachedTasks` / `getTasks` / `getTaskById` 의존 화면 정리(부분 로드 이후 리스크).
3) 다음 백로그(미착수)
- 대시보드 서버 페이지네이션·요약 API, 폴더/필터 단위 로드 확대, PG 마이그레이션 등.

2026-03-03 (대시보드 API 요약 1차) — 프로젝트 상세 VLM 작업자 행
- `YOLO_API_STUDIO` `buildProjectDetailPayload`: VLM `sourceFile` 기준 작업자별 `reviewPendingCount`, `firstSubmittedTaskId`, `firstApprovedTaskId`, `firstOpenTaskId`, `sampleTaskId` SQL 집계.
- `Dashboard` `ProjectDetailView`: VLM 프로젝트는 위 필드로 검수 건수·진입 태스크 선택 — 클라이언트 전체 `tasks` 스캔 제거(해당 테이블 행).
- `storage` `ProjectDetailPayload.workers` 타입 확장.

2026-03-03 (작업자 작업목록·홈 snapshot) — 부분 캐시 + 폴더 요약
- `Dashboard`: `AccountType.WORKER` 이고 `selectedFolder` 가 작업 목록 또는 대시보드 홈일 때 `fetchAndMergeWorkerTasks(username)` 후 `onRefresh` (시퀀스·로딩 동일 패턴).
- `folderOverviews` / 상단 `globalStats` 가 로그인 직후 drain 전에도 본인 기준으로 맞게 됨.

2026-03-03 (폴더 진입 hydrate) — 부분 캐시 + 폴더 화면
- `Dashboard`: 실제 폴더 경로 선택 시 `fetchAndMergeTasksByFolder` + `onRefresh` (시퀀스 가드). `onFolderPrepareLoading` 으로 대량 fetch 시 로딩 표시.
- 작업자/관리자 공통: 폴더 내 목록·`activeFolderDetails` 등이 drain 완료 전에도 정합.

2026-03-03 (대시보드 API 요약 2차) — 폴더 매핑 프로젝트(YOLO·분류·VLM 폴더형)
- `buildProjectDetailPayload` else 분기: 프로젝트 폴더 `IN (...)` 로 작업자별 동일 집계 enrich (`tasks` 또는 `vlm_tasks`).
- `ProjectDetailView`: `useServerReviewMeta = VLM 워크플로 || row.sampleTaskId` 로 서버 메타 통합 — 네이티브/분류도 상세 화면에서 `tasks` 스캔 생략(해당 표).

2026-03-03 (이어서) — 검수/작업 이전·다음 + 부분 캐시
- `App.tsx`: `findNextTaskWithFolderHydration` — 캐시에서 이전/다음을 못 찾으면 `fetchAndMergeTasksByFolder` 후 재시도 (제출·검수·VLM 이동·이슈 후 자동 다음·점프 인덱스 포함).
- `docs/task-cache-dependencies.md`에 폴더 보강 동작 반영.

2026-03-03 (todo 마무리) — 폴더 목록 서버 페이징·작업자 init·PG/레플리카 문서
- API: `GET /api/datasets/count`, `/api/datasets/folder-metrics`, `/api/datasets` 에 `sort`(updated|name|id).
- `Dashboard`: `folderPager` + 서버 metrics로 폴더 상단 통계·작업 목록 페이지·더 보기.
- `storage` + `initStorage`: 작업자는 초기 전역 페이징 생략 후 `fetchAndMergeWorkerTasks` 한 번; `App`은 관리자만 `startBackgroundTaskListDrain`.
- `YOLO_API_STUDIO`: 기동 시 `DB_READ_PATH`===`DB_PATH` 경고, `docs/postgresql-migration.md`, `read-replica-operations.md`.

2026-03-03 (관리자 리포트·안내) — drain과 집계 정합
- `Dashboard`: 관리자 + Reports/Weekly/Daily 뷰 선택 시 `resyncTasksFromServerFull` → `onRefresh` (시퀀스·`onFolderPrepareLoading` 동일 패턴).
- `App` → `Dashboard`에 `taskListBackgroundPending` 전달; 관리자·검수자 역할일 때 상단 카드에 백그라운드 로딩 안내.
- [`docs/performance-scale-sprint.md`](docs/performance-scale-sprint.md) 요약 추가, 회귀 §1.6·`task-cache-dependencies` 갱신.

2026-03-13 (금) 개발일지 — YOLO 로컬툴
1) 목표
yolo_localtool 빌드·실행 시 로고 표시, 이미지/라벨 로딩 깜빡임 제거, 상단/하단 UI 요소 위치 조정
2) 작업 내용
로고·아이콘
- 앱 내 로고: `import.meta.env.BASE_URL`로 상대 경로 사용해 빌드 후 file:// 환경에서도 logo.ico 정상 로딩
- exe 아이콘: package.json build.icon / win.icon에 public/logo.ico 지정, electron main에서 창 아이콘 경로(logo.ico) 설정 (256×256 이상 ico 필요)
이미지·라벨 동시 표시(깜빡임 방지)
- displayItem / displayAnnotations 상태 분리: 현재 인덱스의 라벨을 먼저 로드한 뒤, 완료 시점에만 이미지+라벨을 한 번에 갱신
- loadAnnotationsForIndex를 Promise<BoundingBox[]> 반환으로 변경, 이전 요청은 cancelled/index 불일치로 무시
- 폴더 변경 시 display 초기화, 라벨 로딩 중에는 "라벨 로딩 중..." 표시
UI 배치
- 헤더: 진행량+스크롤바 제거 → 현재 파일명(displayItem.name) 표시
- 푸터: 현재 파일명 제거 → 진행량 숫자 + 범위 스크롤바 배치 (이전/다음 버튼 우측)
3) 수정 파일
- `yolo_localtool/src/App.tsx` (displayItem/displayAnnotations, 로고 BASE_URL, 헤더/푸터 내용 교체)
- `yolo_localtool/package.json` (build.icon, win.icon)
- `yolo_localtool/electron/main.js` (getIconPath, BrowserWindow icon)
4) 검증
- npm run electron 후 빌드본에서 헤더 로고 노출 확인
- 이미지 전환 시 박스가 나중에 따로 그려지지 않고 이미지와 함께 한 번에 전환되는지 확인
- 상단에는 파일명, 하단에는 진행량+스크롤바가 보이는지 확인

---

2026-03-13 (금) 개발일지 — 이미지 분류(멀티라벨링) 개발
1) 목표
YOLO·VLM과 동일한 프로젝트/폴더 구조에서 이미지당 단일 클래스 선택 라벨링 워크플로우 추가
2) 작업 내용
워크플로우·타입
- `PluginSourceType`에 `image-classification` 추가, `ProjectDefinition`에 `classificationClasses`(프로젝트별 클래스 목록) 추가
- 프로젝트 생성·편집 시 워크플로우를 "이미지 분류"로 선택하고 클래스 목록 설정/수정 가능
- `WORKFLOW_CONFIG`·`imageClassificationContract`로 분류 워크플로우 어댑터 등록
작업 화면
- `ClassificationPanel`: 이미지 표시 + 클래스 라디오 선택, VLM과 유사하게 좌측 패널 단순화, 이미지 확대/축소·팬
- A/D·Ctrl+S 시 저장 후 다음/이전 이동, 1~9 키로 클래스 선택, 포커스 시에도 A/D 동작
- 작업 재진입 시 기존 선택 분류값 표시 (`getTaskById`에서 image-classification용 sourceData 로드)
데이터·매핑
- 폴더 매핑 시 `getSourceTypeForFolder`로 분류 프로젝트면 `sourceType`을 image-classification으로 설정
- 프로젝트 상세·폴더 카드에 분류 작업 수(`classificationTaskCount`) 표시
내보내기
- Data Import/Export(구 VLM Migration) 하단에 "분류 결과 내보내기" 추가: 프로젝트 단위, CSV/JSON
- 출력 경로 `datasets/classification_export` 고정, JSON은 pretty-print(들여쓰기·줄바꿈)
3) 수정·추가 파일
- `types.ts` (PluginSourceType, ProjectDefinition.classificationClasses, WORKFLOW_CONFIG 등)
- `services/plugins/contracts.ts` (imageClassificationContract)
- `services/storage.ts` (getTaskById 분류 sourceData, fetchAndMerge 시 분류 대응)
- `vite.config.ts` (프로젝트 CRUD·overview·detail에 classificationClasses, getSourceTypeForFolder, classification export API)
- `components/ClassificationPanel.tsx` (신규)
- `components/Dashboard.tsx` (분류 프로젝트 UI, 클래스 편집, 분류 내보내기 UI)
- `App.tsx` (분류 작업 분기, ClassificationPanel 연동, 1~9/A/D·Ctrl+S 분류 처리)
4) 검증
- 분류 프로젝트 생성·매핑 후 작업 목록 진입 시 분류 화면으로 열리는지 확인
- 클래스 선택·저장·재진입 시 선택값 유지 확인
- 분류 결과 CSV/JSON 내보내기 및 파일 경로·형식 확인

---

2026-03-11 (수) 개발일지
1) 목표
VLM 배분·검수 가시성 확보, 프로젝트 삭제 시 배분 해제, 검수 플로우 정리, 작업 목록 정렬·네비게이션 통일
2) 작업 내용
VLM 배분 및 가시성
- VLM 배분 API가 배정된 taskIds 반환하도록 수정, 클라이언트에서 `GET /api/datasets?ids=` 로 해당 작업 병합 후 캐시 반영
- 프로젝트 삭제 시 해당 VLM 프로젝트의 vlm_tasks 배분 해제(assignedWorker·status 초기화), 삭제 후 `onRefreshTasksFromServer` 호출
- 로그인 시 `Storage.clearTaskCache()` 후 초기화해 계정별 작업 목록 정확히 로드
- 검수 버튼: 제출 건이 캐시에 없을 때 `Storage.fetchAndMergeWorkerTasks(workerName)` 호출 후 첫 SUBMITTED 작업 열기
VLM 검수·재배정 동작
- VLM 배분 해제(unassign) 시 status를 TODO로 초기화해 재배정 후 제출/대기 섞임 방지
- 작업자 화면에서 제출(SUBMITTED) 작업도 편집 가능하도록 변경(APPROVED만 읽기 전용)
정렬·네비게이션 통일
- VLM: 작업 ID 오름차순, YOLO: 파일명(name) 오름차순으로 목록·이동·Jump to·다음/이전 통일 (App.tsx, Dashboard.tsx)
- 작업자별 진행 현황에서 검수 시 "제일 처음" 작업: VLM은 ID 순, YOLO는 이름 순으로 정렬한 뒤 첫 SUBMITTED 선택 (orderedForRow 도입, fetchAndMerge 후에도 동일 정렬 적용)
UI
- 하단 네비게이션 스크롤바/넘침 방지 (overflow-hidden, min-w-0, shrink-0 등)
- Jump to 입력 시 정렬 기준을 VLM=id·YOLO=name에 맞춰 인덱스 일치하도록 수정
3) 수정 파일
- `vite.config.ts` (VLM assign 반환 taskIds, delete 시 vlm_tasks unassign, unassign 시 status=TODO)
- `services/storage.ts` (clearTaskCache, mergeTasksByIds, fetchAndMergeWorkerTasks, assignVlmTasks 시 taskIds 병합)
- `components/Dashboard.tsx` (검수 버튼·행 클릭 시 orderedForRow 사용, VLM/YOLO 정렬, targetTasks 필터)
- `App.tsx` (orderedCurrentFolderTasks·handleJumpToIndex·findNextTask 정렬 분기, readOnly 조건, 하단 네비 레이아웃)
- `components/VlmReviewPanel.tsx` (휠 확대 시 preventDefault로 페이지 스크롤 방지)
4) 검증
- VLM 배분 후 관리자/작업자 화면에서 해당 작업 노출 확인
- 프로젝트 삭제 시 해당 VLM 작업 배분 해제 확인
- 검수 클릭 시 해당 작업자 제출 건 중 정렬 기준 첫 건 열림 확인 (VLM=ID 순, YOLO=이름 순)
- YOLO 다음/이전·Jump to 시 이름 순, VLM 시 ID 순 일치 확인

2026-02-25 (수) 개발일지 - 추가 업데이트
1) 목표
전반 UI 개편 안정화, YOLO 작업 편의성(Undo/Redo) 강화, 프로젝트 노출 정책 운영화
2) 작업 내용
UI 전면 개편/정리
- 대시보드/프로젝트/로그인 화면 스타일을 동일 톤으로 통일하고 시각 요소 정리
- 로그인 상단 아이콘을 대시보드 아이콘(`/logo.ico`)으로 통일
- 로그인 아이콘 배경 제거 + 크기 확대
- `History` 탭 및 분기 제거로 네비게이션 단순화
- `components/History.tsx` 삭제(로그 데이터 저장/집계 로직은 유지)
YOLO 편의 기능 강화
- Undo/Redo 기능 추가 (`Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`)
- 상단 UI에 Undo/Redo 아이콘 버튼 추가(Active Class 우측)
- 이미지/태스크 전환 시 Undo/Redo 메모리 초기화(이전 이미지 라벨 섞임 방지)
- 호버 객체 `X` 키 선택(다중 선택) 지원
- 선택 박스 흰색 외곽선 렌더링 보정(안쪽 표시 이슈 수정)
프로젝트 노출/아카이브 정책 반영
- 아카이브(`ARCHIVED`) 프로젝트를 작업자 화면에서 완전 비노출 처리
- 프로젝트별 `작업자에게 공개` 토글(`visibleToWorkers`) 추가
- 작업자 Work List/대시보드에서 `ARCHIVED` 또는 `비공개` 프로젝트 자동 필터링
- 기존 프로젝트 데이터는 `visibleToWorkers` 미존재 시 기본 `true`로 보정
3) 수정 파일
- `components/Dashboard.tsx`
- `services/storage.ts`
- `vite.config.ts`
- `App.tsx`
- `components/Login.tsx`
- `components/AnnotationCanvas.tsx`
- `components/History.tsx` (삭제)
4) 검증
- 변경 파일 기준 린트 오류 없음 확인

2026-02-24 (화) 개발일지
1) 목표
VLM 검수 툴 통합, JSON Export 운영 안정화 및 프로젝트 아카이브 운영 기능 추가
2) 작업 내용
VLM 검수 UX 통합
- 기존 활용하던 VLM 검수 프로그램 통합 및 리포트 제공
- 검수자(Reviewer) 권한에서도 검수 결과 확인/수정/반려 처리 가능하도록 권한 분기 수정
- GPT 응답 영역을 원본(읽기 전용) / 응답 수정(수정필요일 때만 편집)으로 분리
- `응답 복사` 버튼 추가: 원본 GPT 응답을 수정 입력칸으로 즉시 복사
- 작업 날짜 입력을 검수 메모 하단의 축소 UI로 정리
VLM Export 기능 고도화
- `datasets/vlm_export` 저장형 Export API/UI 구현 및 파일별 진행률 표시
- Export 옵션 추가: `result 필드 끼워넣기` 토글(ON/OFF 선택)
- result 삽입 시 원본 응답(`original_response`) 함께 포함
- result 라벨 매핑: 정상 / 수정필요(vp) / 수정필요(detail)
프로젝트 상세/운영 기능 강화
- 프로젝트 상세의 폴더 테이블에 `검수 진행` 컬럼 추가
  (승인+반려 / 제출+승인+반려, 진행바/퍼센트/상세 카운트 표시)
- 프로젝트 `아카이브` 기능 추가(데이터셋 압축 없음, 기록/통계 스냅샷만 보관)
- 아카이브 전용 탭 추가 및 복원(ARCHIVED -> ACTIVE) 기능 제공
- 아카이브 프로젝트는 스냅샷 기반 상세 조회 유지로 원본 데이터셋 정리 이후에도 이력 보존 가능
3) 검증
- 변경분 린트 오류 없음
- `npm run -s build` 기준 빌드 성공

2026-02-23 (월) 개발일지
 
1) 목표
통계 Dashboard 개선
2) 작업 내용
기존 그룹 방식 폐지
프로젝트형 Dashboard로 변경
프로젝트 전체 개요 및 통계 제공
프로젝트 목표, 현재 배분량, 작업 완료량 제공
기간별 작업량 및 작업 시간 제공
3) 이슈 및 대응
이슈: 라벨링 작업 정상 저장 여부 확인
대응: localcache 최소화, 강제 서버 저장으로 변경
결과: 정상 저장 확인 완료
4) 검증

리포트 수치 정상화 확인
더미데이터 증식 재발 없음 확인
DB 보정 결과 수치 확인 완료
린트 오류 없음 확인
5) 차주 예정

일정확인 보드 UI 디테일(표시 규칙/가독성) 고도화
보고용 출력 템플릿(리포트/JPG) 마무리 정리

 
2026-02-12 (목) 개발일지
1) 목표
submissions 과대집계 문제 해결 및 DB 정리
2) 작업 내용
중복 증식 방지(기간 전환 race 대응 포함)
workingDays == 1 표본 기반 더미 생성으로 기준 정교화
일정확인 보드에서도 동일 동기화 적용
차트/표 정합성 개선
동일 userId 중복 시 차트 데이터 병합
폴더 집계 누락 이슈(backend folders 응답 + frontend 누적 병합) 수정
로그 정책 개선
submissions 집계를 DISTINCT taskId (SUBMIT) 기준으로 전환
SUBMIT 로그 업서트 구조로 변경(동일 taskId+userId 1건 유지)
durationSeconds 누적 및 상한 300초 정책 적용
기존 DB 정리 수행
중복 SUBMIT 정리 및 누적시간 반영
결과: 중복 extra rows 40135 -> 0
durationSeconds > 300 일괄 보정 완료
3) 이슈 및 대응

이슈: DB 정리 중 락 발생
대응: 락 해제 후 백업 생성 후 재실행
결과: 정리 완료 및 백업 파일 보존
4) 검증

리포트 수치 정상화 확인
더미데이터 증식 재발 없음 확인
DB 보정 결과 수치 확인 완료
린트 오류 없음 확인
5) 차주 예정

일정확인 보드 UI 디테일(표시 규칙/가독성) 고도화
보고용 출력 템플릿(리포트/JPG) 마무리 정리


2026-02-11 (수) 개발일지
1) 목표

휴가 반영 통계 도입
일정관리 기능을 리포트와 분리
2) 작업 내용

휴가 데이터 모델 및 API 추가
vacations 테이블 생성
GET/POST/DELETE /api/vacations 구현
리포트 지표 확장
Vacation Days, Working Days, Sub / Workday 반영
주말 자동 제외 계산 적용
일정관리 페이지 분리
Schedule 메뉴를 Reports 하위 위치로 정리
관리(등록/삭제) + 일정확인(보드) 탭 구성
일정확인 보드 개선
월간 평일 기준 매트릭스 제공
날짜별 작업을 셀에 표시(긴 텍스트 대신 압축 표시)
3) 이슈 및 대응

이슈: 인쇄 결과가 환경별로 불안정
대응: Print 대체로 리포트 JPG 저장 기능 도입
이슈: 스크롤 하단 캡처 누락
대응: 캡처 시 스크롤 영역 확장 후 원복 로직 적용
4) 검증

일정 등록/삭제/조회 정상
리포트 및 일정확인 화면 동작 정상
린트 오류 없음 확인
5) 내일 작업

더미데이터/차트/표 동작 정밀 보정
로그 집계 과대 계산 원인 분석 및 정리
 
2026-02-10 (화) 개발일지
1) 목표

분리된 리포트(Daily/Weekly/Monthly) 통합
리포트 UI/UX 일관화 및 안정화
2) 작업 내용

리포트 진입점 통합
사이드바 리포트 메뉴를 단일 Reports로 정리
내부 토글(Daily/Weekly/Monthly) 방식으로 전환
공통 리포트 패널 구조 적용
카드/차트/테이블/CSV Export를 공통 컴포넌트로 통합
Last Activity 표시 포맷을 전 리포트 날짜+시간으로 통일
방어 로직 보강
숫자/문자 필드 null-safe 처리 유지
렌더링/집계 시 undefined 방지
3) 이슈 및 대응

이슈: 분리 뷰 간 UI 불일치 및 유지보수 포인트 과다
대응: UnifiedReportPanel 중심으로 구조 재편
결과: 3개 리포트 동작/표현 일관화 완료
4) 검증

리포트 탭 전환(Daily/Weekly/Monthly) 정상
린트 오류 없음 확인
5) 내일 작업

휴가/근무일 반영 통계 고도화
일정관리 분리 페이지 구성