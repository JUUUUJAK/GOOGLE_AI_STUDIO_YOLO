# 워크플로 어댑터 전환 전 백업 (2025-03-03)

## 복원 방법 (이전 환경으로 되돌리기)

아래 파일들을 프로젝트 루트의 해당 경로로 덮어쓰면 됩니다.

  types.ts              -> 프로젝트 루트\types.ts
  App.tsx               -> 프로젝트 루트\App.tsx
  vite.config.ts        -> 프로젝트 루트\vite.config.ts
  services\plugins\contracts.ts -> 프로젝트 루트\services\plugins\contracts.ts
  components\Dashboard.tsx      -> 프로젝트 루트\components\Dashboard.tsx

PowerShell 예시 (프로젝트 루트에서 실행):
  Copy-Item -Path "backup_workflow_adapters_20250303\types.ts" -Destination "." -Force
  Copy-Item -Path "backup_workflow_adapters_20250303\App.tsx" -Destination "." -Force
  Copy-Item -Path "backup_workflow_adapters_20250303\vite.config.ts" -Destination "." -Force
  Copy-Item -Path "backup_workflow_adapters_20250303\services\plugins\contracts.ts" -Destination "services\plugins\" -Force
  Copy-Item -Path "backup_workflow_adapters_20250303\components\Dashboard.tsx" -Destination "components\" -Force
