# 사용 여부 점검 결과 (GOOGLE_AI_STUDIO_YOLO 루트)

점검 일자: 2025 기준. `package.json` 스크립트·`vite.config`·`App.tsx` 등에서 import/참조 여부로 판단.

---

## 1. 앱에서 사용 중 (유지)

| 경로 | 용도 |
|------|------|
| `users.json` | 로그인 계정. `vite.config.ts`에서 읽음 |
| `constants.ts` | `COLOR_PALETTE` 등. `App.tsx`에서 import |
| `types.ts`, `vite.config.ts`, `App.tsx`, `index.html`, `index.tsx` | 앱 진입점·설정 |
| `components/`, `services/storage.ts`, `services/plugins/`, `services/geminiService.ts` | 런타임 코드 |
| `package.json`, `public/`, `devlog.md` | 빌드·문서 |

---

## 2. 사용처 없음 — 수동 실행용 스크립트 (정리 권장)

`package.json`이나 앱 코드에서 호출되지 않음. 필요 시 `node 스크립트명.js`로만 실행.

| 파일 | 추정 용도 |
|------|------------|
| `check_server_truth.js` | 서버/DB·파일 상태 점검 |
| `check_image_urls.js` | 이미지 URL 점검 |
| `check_db.js` | DB 테이블·로그 개수 확인 |
| `check_db_schema.js` | DB 스키마 확인 |
| `check_vlm_status.js` | VLM 상태 확인 |
| `check_status_debug.js` | 상태 디버깅 |
| `check_folder_stats.js` | 폴더 통계 |
| `check_encoding.js` | 인코딩 점검 |
| `detect_corruption.js` | 데이터 손상 탐지 |
| `dump_schema.js` | 스키마 덤프 |
| `global_search_task.js` | 작업 전역 검색 |
| `migrate_logs.js` | 로그 마이그레이션 |
| `inspect_hex.js` | hex 검사 |
| `fix_vite_encoding.js` | Vite 인코딩 수정 |
| `debug_encoding.js` | 인코딩 디버깅 |
| `test_id_stability.js` | ID 안정성 테스트 |
| `manage_vlm.js` | VLM 관리 |
| `backup_ui.py` | UI 백업 |
| `update_guide_ppt.py` | 가이드 PPT 업데이트 |

**권장:**  
- 계속 쓸 스크립트만 남기고 `scripts/` 아래로 모은 뒤, 나머지는 삭제하거나 `archive/` 등으로 이동.  
- `check_server_truth.js toxicology` 같은 이름의 파일은 중복/오타 가능성 있으니 확인 후 하나만 유지.

---

## 3. 백업/레거시 (삭제 또는 아카이브 후 제외)

| 경로 | 비고 |
|------|------|
| `backup_workflow_adapters_20250303/` | 워크플로 어댑터 백업. 복구용으로만 보관 시 `archive/` 등으로 이동 권장 |
| `ui_backup_20260225_151506/` | UI 백업. 위와 동일 |
| `tmp_orig_app.tsx` | 임시/원본 App. 참조 없음 → 삭제 또는 archive |
| `storage.ts.bak` | storage.ts 백업 |
| `vite.config.ts.bak` | vite.config 백업 |

`.bak`은 복구 끝났으면 삭제해도 됨.

---

## 4. 앱에서 참조 안 함 — dead code

| 경로 | 비고 |
|------|------|
| `services/db.ts` | better-sqlite3로 datasets.db 접근. **어디서도 import 안 함.** DB는 `vite.config.ts` 서버 쪽에서만 사용 → 삭제해도 앱 동작에는 영향 없음. |

---

## 5. 참조 없음 (용도 확인 후 처리)

| 경로 | 비고 |
|------|------|
| `tasks.json` | 코드에서 읽는 부분 없음. 샘플/레거시 데이터일 수 있음 |
| `temp.txt` | 임시 파일 가능성 |
| `guide_source/` | 가이드 소스(예: PPT). `update_guide_ppt.py`와 함께 쓰는지 확인 |
| `scripts/migrate-nested-yolo-folders.js` | 중첩 YOLO 폴더 마이그레이션. 필요 시에만 수동 실행 |

---

## 6. 정리 액션 제안

1. **스크립트 정리**  
   - 유지할 스크립트만 골라 `scripts/`로 이동 (예: `scripts/check_server_truth.js`).  
   - 더 이상 안 쓰는 `check_*.js`, `migrate_logs.js` 등은 삭제 또는 `archive/scripts/`로 이동.

2. **백업 폴더**  
   - `backup_workflow_adapters_20250303/`, `ui_backup_20260225_151506/`를 `archive/`로 옮기거나, 보관 기간 끝났으면 삭제.

3. **임시/백업 파일**  
   - `tmp_orig_app.tsx`, `*.bak` — 필요 없으면 삭제.

4. **Dead code**  
   - `services/db.ts` — 사용처 없으므로 삭제 권장 (필요 시 git history에서 복구 가능).

5. **기타**  
   - `tasks.json`, `temp.txt`, `guide_source/` — 용도 확인 후 유지 또는 삭제/이동.

원하면 위 액션 기준으로 실제로 삭제/이동할 파일 목록만 따로 정리해 줄 수 있음.
