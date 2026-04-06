export enum UserRole {
  WORKER = 'WORKER',
  REVIEWER = 'REVIEWER',
}

export enum AccountType {
  ADMIN = 'ADMIN',
  WORKER = 'WORKER'
}

export interface User {
  username: string;
  accountType: AccountType;
}

export enum TaskStatus {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  ISSUE_PENDING = 'ISSUE_PENDING',
}

export type PluginSourceType = 'native-yolo' | 'vlm-review' | 'image-classification';
export type VlmTaskStatus = 'assigned' | 'worked' | 'validated';

export interface PluginTaskAdapter {
  sourceType: PluginSourceType;
  toCommonStatus: (input: string | number) => TaskStatus;
  toSourceStatus?: (status: TaskStatus) => string;
}

export interface PluginReviewAdapter {
  sourceType: PluginSourceType;
  canReview: (task: Task) => boolean;
  normalizeReviewerNote: (note: string) => string;
}

export interface PluginReportAdapter {
  sourceType: PluginSourceType;
  includeInUnifiedReport: boolean;
}

/** 폴더가 어디서 오는지 (프론트/백엔드에서 매핑·집계 방식 구분용) */
export type FolderSourceHint = 'filesystem' | 'vlm_source_file';

export interface PluginContract {
  task: PluginTaskAdapter;
  review: PluginReviewAdapter;
  report: PluginReportAdapter;
  /** 폴더 출처: filesystem = _project_map + tasks 폴더, vlm_source_file = vlm_tasks의 sourceFile 기준 */
  folderSource?: FolderSourceHint;
}

/** 폴더별 집계 행 (백엔드 overview용). 워크플로 어댑터가 자신이 사용하는 테이블에서 채움 */
export interface FolderStatsRow {
  folder: string;
  sourceType: PluginSourceType;
  taskCount: number;
  allocatedCount: number;
  completedCount: number;
  lastUpdated: number;
  assignedWorker: string;
}

/** 프로젝트 상세용 폴더 행 */
export interface ProjectFolderRow {
  folder: string;
  taskCount: number;
  completedCount: number;
  submittedCount: number;
  approvedCount: number;
  rejectedCount: number;
  lastUpdated: number;
  assignedWorker: string;
}

/** 워크플로별 백엔드 어댑터 인터페이스. overview/detail에서 폴더 목록·집계·매핑 해석을 위임 */
export interface WorkflowAdapter {
  sourceType: PluginSourceType;
  /** 이 워크플로가 기여하는 projectMap 보정. rawMap + (VLM 등) DB 기반 보정을 합쳐 반환할 수 있음 */
  resolveProjectMap: (params: {
    projects: Record<string, { id: string; workflowSourceType?: string; vlmSourceFile?: string; vlmSourceFiles?: string[] }>;
    rawMap: Record<string, { projectId: string; updatedAt: number }>;
    existingFolders: Set<string>;
    getVlmFoldersBySourceFile?: (sourceFile: string) => string[];
  }) => Record<string, { projectId: string; updatedAt: number }>;
  /** 이 워크플로의 프로젝트 상세용 폴더 목록 + 작업자별 집계. detail API에서 사용 */
  getFolderListForProject?: (params: {
    projectId: string;
    project: { workflowSourceType?: string; vlmSourceFile?: string; vlmSourceFiles?: string[] };
    projectMap: Record<string, { projectId: string; updatedAt: number }>;
    getFolderRowsFromDb: (workflowSourceType: string) => ProjectFolderRow[];
    getWorkerRowsFromDb: (folder: string, workflowSourceType: string) => Array<{ assignedWorker: string; taskCount: number; completedCount: number }>;
  }) => { folders: ProjectFolderRow[]; workerMap: Map<string, { userId: string; allocated: number; completed: number; progress: number }> };
}

/** 워크플로별 UI 라벨 (뱃지, 폴더 행 등) */
export const WORKFLOW_LABELS: Record<PluginSourceType, string> = {
  'native-yolo': 'YOLO',
  'vlm-review': 'VLM',
  'image-classification': '분류'
};

/** 워크플로별 동작 설정 (패널/사이드바/키보드 분기용) */
export interface WorkflowUiConfig {
  /** YOLO 전용 사이드바(라벨셋·클래스 목록·하단 버튼) 표시 여부 */
  showYoloSidebar: boolean;
}

export const WORKFLOW_CONFIG: Record<PluginSourceType, WorkflowUiConfig> = {
  'native-yolo': { showYoloSidebar: true },
  'vlm-review': { showYoloSidebar: false },
  'image-classification': { showYoloSidebar: false }
};

export const TaskStatusLabels: Record<TaskStatus, string> = {
  [TaskStatus.TODO]: '대기',
  [TaskStatus.IN_PROGRESS]: '작업중',
  [TaskStatus.SUBMITTED]: '제출',
  [TaskStatus.APPROVED]: '완료',
  [TaskStatus.REJECTED]: '반려',
  [TaskStatus.ISSUE_PENDING]: '요청중',
};

export interface BoundingBox {
  id: string;
  classId: number;
  x: number; // Normalized 0-1 (Top Left)
  y: number; // Normalized 0-1 (Top Left)
  w: number; // Normalized 0-1
  h: number; // Normalized 0-1
  isAutoLabel?: boolean; // True if created by AI and untouched. False/Undefined if manual or edited.
}

export interface YoloClass {
  id: number;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  imageUrl: string;
  name: string;
  folder: string; // Grouping identifier (e.g., "Batch 1", "Validation")
  txtPath?: string; // Relative path to the .txt label file
  status: TaskStatus;
  annotations: BoundingBox[];
  assignedWorker?: string;
  reviewerNotes?: string;
  lastUpdated: number;
  isModified?: boolean; // True if annotations have been modified by a user
  sourceType?: PluginSourceType;
  sourceRefId?: string;
  sourceFile?: string;
  sourceData?: string;
}

export interface FolderMetadata {
  tags: string[];
  memo: string;
}

export interface WorkLog {
  id: string;
  taskId: string;
  folder: string; // Snapshotted at time of log
  userId: string;
  role: UserRole;
  action: 'START' | 'SAVE' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'AUTO_LABEL';
  timestamp: number;
  durationSeconds?: number; // For session tracking
  isModified?: boolean;
  stats?: {
    totalBoxCount: number;
    manualBoxCount: number; // Count of boxes where isAutoLabel is false/undefined
  };
  synced?: boolean; // True if confirmed saved to server
  sourceType?: PluginSourceType;
}

export interface DatasetStats {
  totalTasks: number;
  completedTasks: number;
  rejectedTasks: number;
  avgTimePerTask: number;
  annotationsPerClass: Record<string, number>;
}

export type TaskIssueType = 'REVIEW_REQUEST' | 'DELETE_REQUEST';
export type TaskIssueStatus = 'OPEN' | 'IN_REVIEW' | 'DELETE' | 'RESOLVED';
export type TaskIssueReasonCode = 'BLUR' | 'CORRUPT' | 'WRONG_CLASS' | 'DUPLICATE' | 'OTHER';

export interface TaskIssue {
  id: string;
  taskId: string;
  folder: string;
  imageUrl: string;
  type: TaskIssueType;
  reasonCode: TaskIssueReasonCode;
  status: TaskIssueStatus;
  createdBy: string;
  createdAt: number;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  resolutionNote?: string | null;
}

export interface VacationRecord {
  id: string;
  userId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  days: number; // supports 0.5 for half-day
  note?: string;
  createdAt: number;
}