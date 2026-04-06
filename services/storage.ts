import { Task, TaskStatus, WorkLog, UserRole, BoundingBox, TaskIssue, TaskIssueReasonCode, TaskIssueStatus, TaskIssueType, VacationRecord } from '../types';
import { apiUrl } from './apiBase';
import { resolveProjectMapEntryForFolder } from './projectMapResolve.js';
import JSZip from 'jszip';
import localforage from 'localforage';

export interface ClassificationClass {
  id: number;
  name: string;
}

export interface ProjectDefinition {
  id: string;
  name: string;
  targetTotal: number;
  workflowSourceType: 'native-yolo' | 'vlm-review' | 'image-classification';
  /** VLM: DB `vlm_tasks.sourceFile`에 대응하는 원본 JSON 파일명. 복수 연결 시 목록 */
  vlmSourceFiles?: string[];
  /** 하위 호환: `vlmSourceFiles`의 첫 항목과 동기화 */
  vlmSourceFile?: string;
  /** 이미지 분류 프로젝트 전용 클래스 목록. 생성 시 설정·상세에서 수정 가능 */
  classificationClasses?: ClassificationClass[];
  visibleToWorkers?: boolean;
  status?: 'ACTIVE' | 'ARCHIVED';
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectOverviewRow extends ProjectDefinition {
  allocated: number;
  completed: number;
  folderCount: number;
  progress: number;
}

/** GET /api/datasets/folder-metrics 응답 — 대시보드 폴더 상세 집계 */
export interface FolderMetricsPayload {
  total: number;
  completed: number;
  approved: number;
  rejected: number;
  submitted: number;
  todo: number;
  inProgress: number;
  modifiedCount: number;
}

export interface ProjectOverviewPayload {
  projects: ProjectOverviewRow[];
  projectMap: Record<string, { projectId: string; updatedAt: number }>;
  /** 폴더 접두 → 작업자 수동 매핑 (_worker_folder_map.json) */
  workerFolderMap?: Record<string, { workerName: string; updatedAt: number }>;
  unassigned: { folderCount: number; allocated: number; completed: number };
  folders: Array<{
    folder: string;
    taskCount: number;
    completedCount: number;
    lastUpdated: number;
    assignedWorker: string;
    projectId: string;
    nativeTaskCount?: number;
    vlmTaskCount?: number;
  }>;
  /** (folder, effective 작업자)별 집계 — Work List가 폴더 전체 한 줄과 섞이지 않도록 */
  workerFolderBreakdown?: Array<{
    folder: string;
    assignedWorker: string;
    taskCount: number;
    completedCount: number;
    lastUpdated: number;
    projectId?: string;
  }>;
}

export interface ProjectDetailPayload {
  project: {
    id: string;
    name: string;
    targetTotal: number;
    workflowSourceType: 'native-yolo' | 'vlm-review' | 'image-classification';
    vlmSourceFile?: string;
    vlmSourceFiles?: string[];
    classificationClasses?: Array<{ id: number; name: string }>;
    visibleToWorkers?: boolean;
    status?: 'ACTIVE' | 'ARCHIVED';
    allocated: number;
    completed: number;
    progress: number;
    folderCount: number;
    /** YOLO/분류: 행 단위 배정 풀 집계(프로젝트 매핑 폴더의 tasks) */
    nativeAssignPool?: { total: number; assigned: number; unassigned: number };
  };
  workers: Array<{
    userId: string;
    allocated: number;
    completed: number;
    progress: number;
    submissions?: number;
    totalTimeSeconds?: number;
    workTimeHours?: number;
    workingDays?: number;
    vacationDays?: number;
    foldersWorked?: string[];
    lastTimestamp?: number;
    isDummy?: boolean;
    /** VLM 프로젝트: 검수 대기(SUBMITTED) 건수 — UI가 전체 tasks 스캔 없이 표시 */
    reviewPendingCount?: number;
    firstSubmittedTaskId?: string;
    firstApprovedTaskId?: string;
    firstOpenTaskId?: string;
    sampleTaskId?: string;
  }>;
  folders: Array<{
    folder: string;
    taskCount: number;
    completedCount: number;
    submittedCount?: number;
    approvedCount?: number;
    rejectedCount?: number;
    lastUpdated: number;
    assignedWorker: string;
    unassignedTaskCount?: number;
    assignedTaskCount?: number;
  }>;
  trends: Array<{
    date: string;
    submissions: number;
    workTimeSeconds: number;
    workTimeHours: number;
    dummySubmissions?: number;
    dummyWorkTimeSeconds?: number;
    dummyWorkTimeHours?: number;
  }>;
  isArchived?: boolean;
  archivedAt?: number;
}

export interface PluginDescriptor {
  sourceType: 'native-yolo' | 'vlm-review' | 'image-classification';
  label: string;
  supportsWorkflow: boolean;
  supportsMigration: boolean;
}

export interface VlmMigrationDryRunResult {
  total: number;
  limit: number;
  offset: number;
  sampleCount: number;
  sample: Array<{
    taskId: string;
    sourceFile: string;
    sourceRefId: string;
    image: string | null;
    mappedFolder: string;
    mappedStatus: string;
    assignedWorker: string | null;
    completedAt: number;
    validatedAt: number;
  }>;
}

export interface VlmImportJsonFileInfo {
  fileName: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
  totalRows: number;
  parseError?: string;
  alreadyImportedCount?: number;
}

export interface VlmJsonImportResult {
  success: boolean;
  commit: boolean;
  total: number;
  assignedCount: number;
  unassignedCount: number;
  missingImages: number;
  sourceFiles: string[];
  skippedAlreadyAssigned?: number;
  assignedPreview: Array<{
    taskId: string;
    sourceRefId: string;
    assignedWorker: string | null;
    imageExists: boolean;
  }>;
}

export interface VlmExportJsonFileInfo {
  sourceFile: string;
  totalTasks: number;
  submittedTasks: number;
  lastUpdated: number;
}

export interface VlmExportJsonResult {
  success: boolean;
  onlySubmitted: boolean;
  savedFiles: Array<{
    sourceFile: string;
    outputPath: string;
    count: number;
  }>;
}

const LOGS_KEY = 'yolo_logs';
const FOLDER_META_KEY = 'yolo_folder_meta';
/** 한 번에 너무 많이 가져오면 API/DB가 길게 점유 → 작업자 저장·조회가 밀림 */
const TASK_LIST_PAGE_SIZE = 2000;
/** @deprecated TASK_LIST_PAGE_SIZE 사용 */
const INITIAL_TASK_FETCH_LIMIT = TASK_LIST_PAGE_SIZE;
/** 목록 페이징 배치 사이 휴지 — 이벤트 루프·동시 요청 처리 여지 */
const TASK_FETCH_BATCH_GAP_MS = 75;
/** 로그인 직후 빈 캐시일 때 즉시 가져올 페이지 수(이후 백그라운드로 나머지) */
const TASK_INITIAL_SYNC_BATCHES = Math.max(1, Number(import.meta.env.VITE_TASK_INITIAL_SYNC_BATCHES || 2));
/** 백그라운드로 나머지 태스크를 채울 때 배치 간격(ms) */
const TASK_BACKGROUND_DRAIN_GAP_MS = Math.max(0, Number(import.meta.env.VITE_TASK_BACKGROUND_DRAIN_GAP_MS || 120));
const LOG_PULL_MIN_INTERVAL_MS = 15000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type SyncTasksDeltaOptions = {
  /**
   * 빈 캐시일 때 초기 /api/datasets 페이징 최대 배치 수.
   * null 이면 한 번에 전부(명시적 전체 동기화).
   */
  maxInitialBatches?: number | null;
  /**
   * true면 캐시가 비어 있어도 since=0 델타를 호출(전량 JSON 한 방 — 대용량).
   * 기본은 false: 빈 캐시에서는 델타 생략 후 페이징/작업자 머지만 사용.
   */
  forceFullDeltaOnEmptyCache?: boolean;
};

let taskListNeedsBackgroundDrain = false;
let backgroundDrainAbort = false;
let backgroundDrainRunning = false;
let backgroundDrainPromise: Promise<void> | null = null;

/** 나머지 목록을 백그라운드에서 채우는 중인지(UI 표시용) */
export const isTaskListBackgroundDrainPending = (): boolean => taskListNeedsBackgroundDrain || backgroundDrainRunning;

export async function stopTaskListBackgroundDrain(): Promise<void> {
  backgroundDrainAbort = true;
  if (backgroundDrainPromise) {
    try {
      await backgroundDrainPromise;
    } catch {
      /* ignore */
    }
    backgroundDrainPromise = null;
  }
  backgroundDrainAbort = false;
}

/**
 * 명시적 "DB 새로고침" 등: 백그라운드 중단 후 델타 + 목록 끝까지 동기적으로 보충.
 */
export async function resyncTasksFromServerFull(): Promise<void> {
  await stopTaskListBackgroundDrain();
  taskListNeedsBackgroundDrain = false;
  cachedTasks = [];
  invalidateFolderNavIndex();
  await syncTasksDelta({ maxInitialBatches: null });
  while (true) {
    const chunk = await loadMoreTasks(0, TASK_LIST_PAGE_SIZE);
    if (chunk.length === 0) break;
    if (TASK_FETCH_BATCH_GAP_MS > 0) await sleep(TASK_FETCH_BATCH_GAP_MS);
  }
  taskListNeedsBackgroundDrain = false;
}

/**
 * 초기 부분 로드 후 나머지 태스크를 낮은 우선순위로 채움.
 */
export function startBackgroundTaskListDrain(onUpdate?: () => void): void {
  if (!taskListNeedsBackgroundDrain || backgroundDrainRunning) return;
  backgroundDrainAbort = false;
  backgroundDrainPromise = (async () => {
    backgroundDrainRunning = true;
    try {
      while (taskListNeedsBackgroundDrain && !backgroundDrainAbort) {
        await sleep(TASK_BACKGROUND_DRAIN_GAP_MS);
        const before = cachedTasks.length;
        const chunk = await loadMoreTasks(0, TASK_LIST_PAGE_SIZE);
        if (chunk.length === 0) {
          taskListNeedsBackgroundDrain = false;
          break;
        }
        if (cachedTasks.length === before) {
          taskListNeedsBackgroundDrain = false;
          break;
        }
        onUpdate?.();
      }
    } finally {
      backgroundDrainRunning = false;
      backgroundDrainPromise = null;
      // 마지막 청크가 비었거나 길이 변화 없을 때도 pending 해제가 UI에 반영되도록
      onUpdate?.();
    }
  })();
}

let _workerScope: string | null = null;

export const setWorkerScope = (worker: string | null) => {
  _workerScope = worker;
};

/** 로그인/계정 전환 시 호출. 캐시를 비우면 다음 initStorage에서 해당 계정 기준으로 전부 다시 불러옴 */
export const clearTaskCache = () => {
  backgroundDrainAbort = true;
  cachedTasks = [];
  invalidateFolderNavIndex();
  taskListNeedsBackgroundDrain = false;
  backgroundDrainRunning = false;
  backgroundDrainPromise = null;
};

const buildDatasetsUrl = (limit: number, offset: number, lastUpdated?: number, lastId?: string): string => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (lastUpdated != null && lastUpdated !== -1 && lastId) {
    params.set('lastUpdated', String(lastUpdated));
    params.set('lastId', lastId);
  } else {
    params.set('offset', String(offset));
  }
  if (_workerScope) params.set('worker', _workerScope);
  return apiUrl(`/api/datasets?${params.toString()}`);
};

// Configure localforage
localforage.config({
  name: 'IntellivixStudio',
  storeName: 'app_data'
});

// --- YOLO Format Helper Functions ---

export const parseYoloTxt = (content: string): BoundingBox[] => {
  if (!content) return [];

  return content.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(' ');
      if (parts.length < 5) return null;

      const classId = parseInt(parts[0], 10);
      const cx = parseFloat(parts[1]);
      const cy = parseFloat(parts[2]);
      const w = parseFloat(parts[3]);
      const h = parseFloat(parts[4]);

      const x = cx - (w / 2);
      const y = cy - (h / 2);

      return {
        id: Math.random().toString(36).substr(2, 9),
        classId,
        x,
        y,
        w,
        h,
        isAutoLabel: true
      } as BoundingBox;
    })
    .filter((box): box is BoundingBox => box !== null);
};

export const generateYoloTxt = (annotations: BoundingBox[]): string => {
  return annotations.map(ann => {
    const cx = ann.x + (ann.w / 2);
    const cy = ann.y + (ann.h / 2);
    return `${ann.classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${ann.w.toFixed(6)} ${ann.h.toFixed(6)}`;
  }).join('\n');
};

// --- Storage Logic ---

// In-memory cache
let cachedFolders: any[] = [];
let cachedTasks: Task[] = [];
/** 폴더 → 그 폴더 태스크 배열 (참조는 cachedTasks 와 동기). bulk 교체 시 무효화, 단일 행 교체는 패치 */
let folderNavIndex: Map<string, Task[]> | null = null;

export function invalidateFolderNavIndex(): void {
  folderNavIndex = null;
}

function rebuildFolderNavIndex(): void {
  const m = new Map<string, Task[]>();
  for (let i = 0; i < cachedTasks.length; i++) {
    const t = cachedTasks[i];
    const f = t.folder;
    let arr = m.get(f);
    if (!arr) {
      arr = [];
      m.set(f, arr);
    }
    arr.push(t);
  }
  folderNavIndex = m;
}

function patchFolderNavIndexOnTaskReplace(oldTask: Task, newTask: Task): void {
  if (!folderNavIndex) return;
  if (oldTask.folder !== newTask.folder) {
    const from = folderNavIndex.get(oldTask.folder);
    if (from) {
      const fi = from.findIndex((x) => x.id === oldTask.id);
      if (fi !== -1) from.splice(fi, 1);
    }
    let to = folderNavIndex.get(newTask.folder);
    if (!to) {
      to = [];
      folderNavIndex.set(newTask.folder, to);
    }
    if (!to.some((x) => x.id === newTask.id)) {
      to.push(newTask);
    }
  } else {
    const arr = folderNavIndex.get(newTask.folder);
    if (arr) {
      const i = arr.findIndex((x) => x.id === newTask.id);
      if (i !== -1) {
        arr[i] = newTask;
      } else {
        arr.push(newTask);
      }
    }
  }
}

/**
 * 이전/다음·점프 네비용: 해당 `folder` 태스크만 (전역 캐시 N 전체 스캔 없음).
 * 작업자/검수 스코프 필터는 호출 측에서 적용.
 */
export function getCachedTasksInFolderForNav(folder: string): Task[] {
  if (!String(folder || '').trim()) return [];
  if (!folderNavIndex) {
    rebuildFolderNavIndex();
  }
  return folderNavIndex!.get(folder) ?? [];
}

let cachedLogs: WorkLog[] = [];
let cachedFolderMeta: Record<string, any> = {};
let isInitialized = false;
let lastCommittedTaskSignature = new Map<string, string>();
let lastLogPullAt = 0;

const normalizeServerTask = (serverTask: any, existing?: any): Task => {
  if (existing) {
    const useServer = serverTask.status !== 'TODO' || (serverTask.lastUpdated || 0) > (existing.lastUpdated || 0);
    if (useServer) {
      return {
        ...serverTask,
        isModified: serverTask.isModified === 1 || serverTask.isModified === true,
        annotations: existing.annotations && (existing.lastUpdated || 0) > (serverTask.lastUpdated || 0)
          ? existing.annotations
          : (serverTask.annotations || [])
      } as Task;
    }
    return {
      ...serverTask,
      status: existing.status,
      isModified: existing.isModified === 1 || existing.isModified === true,
      annotations: existing.annotations || serverTask.annotations || [],
      reviewerNotes: existing.reviewerNotes,
      assignedWorker: existing.assignedWorker || serverTask.assignedWorker,
      lastUpdated: existing.lastUpdated
    } as Task;
  }

  return {
    ...serverTask,
    isModified: serverTask.isModified === 1 || serverTask.isModified === true,
    annotations: serverTask.annotations || []
  } as Task;
};

const queueTaskPersist = (_task: Task): void => {
  // Intentionally no-op:
  // task data must not be persisted to local storage.
};

const persistCachedTasks = async () => {
  // Intentionally no-op:
  // task list/state must be sourced from server only.
};

const getTaskCommitSignature = (task: Task): string => {
  return JSON.stringify({
    id: task.id,
    status: task.status,
    isModified: task.isModified === true,
    assignedWorker: task.assignedWorker || '',
    reviewerNotes: task.reviewerNotes || '',
    lastUpdated: task.lastUpdated || 0,
    txtPath: task.txtPath || '',
    sourceType: task.sourceType || 'native-yolo',
    sourceData: task.sourceData ?? ''
  });
};

const markTaskAsCommitted = (task: Task) => {
  lastCommittedTaskSignature.set(task.id, getTaskCommitSignature(task));
};

const refreshCommittedTaskSignatures = () => {
  lastCommittedTaskSignature = new Map(cachedTasks.map(task => [task.id, getTaskCommitSignature(task)]));
};

// Helper to migrate from localStorage to localforage
const migrateFromLocalStorage = async () => {
  const logs = localStorage.getItem(LOGS_KEY);
  const meta = localStorage.getItem(FOLDER_META_KEY);

  if (logs) await localforage.setItem(LOGS_KEY, JSON.parse(logs));
  if (meta) await localforage.setItem(FOLDER_META_KEY, JSON.parse(meta));

  if (logs || meta) {
    console.log("Migration from localStorage to IndexedDB complete.");
    // We don't clear immediately to be safe, but we could.
    // localStorage.clear(); 
  }
};

export type InitStorageOptions = {
  /** true: DB 새로고침·동기화 버튼과 동일하게 목록 전량 재수집 */
  fullTaskSync?: boolean;
};

let initStorageInFlight: Promise<void> | null = null;

// 1. Initialize: (가능하면) 페이징으로 채운 뒤 짧은 델타만 — since=0 전량 델타는 기본 비활성
export const initStorage = async (opts?: InitStorageOptions) => {
  if (initStorageInFlight) return initStorageInFlight;
  initStorageInFlight = (async () => {
    try {
      await migrateFromLocalStorage();
      cachedLogs = await localforage.getItem<WorkLog[]>(LOGS_KEY) || [];
      cachedFolderMeta = await localforage.getItem<Record<string, any>>(FOLDER_META_KEY) || {};

      await stopTaskListBackgroundDrain();
      if (opts?.fullTaskSync) {
        await resyncTasksFromServerFull();
      } else {
        /**
         * 작업자도 관리자와 동일: 초기에는 /api/datasets 페이징을 N배치만(buildDatasetsUrl에 worker 포함).
         * 전량 fetchAndMergeWorkerTasks 제거 — 로그인·DB 부하 완화. 폴더 상세는 서버 페이지네이션·overview.
         */
        await syncTasksDelta({ maxInitialBatches: TASK_INITIAL_SYNC_BATCHES });
      }

      isInitialized = true;
    } catch (e) {
      console.error("Storage Init Failed:", e);
    } finally {
      initStorageInFlight = null;
    }
  })();
  return initStorageInFlight;
};

/**
 * Sync Logs: Push local -> Server, then Pull Server -> Local
 */
// --- Log Sync: Optimized ---
let isSyncingLogs = false;

export const syncLogs = async (pullUpdates: boolean = true) => {
  if (isSyncingLogs) return;
  isSyncingLogs = true;

  try {
    let localLogs = await localforage.getItem<WorkLog[]>(LOGS_KEY) || [];

    // Ensure cached logs are populated from storage if empty
    if (cachedLogs.length === 0 && localLogs.length > 0) {
      cachedLogs = localLogs;
    }

    // 1. Push UNSYNCED logs to server
    // We treat logs without 'synced' property as UNSYNCED (safe default for migration)
    const unsyncedLogs = localLogs.filter(l => !l.synced);

    if (unsyncedLogs.length > 0) {
      try {
        const res = await fetch(apiUrl('/api/logs'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(unsyncedLogs)
        });

        if (res.ok) {
          // Mark as synced locally
          const syncedIds = new Set(unsyncedLogs.map(l => l.id));
          localLogs = localLogs.map(l => syncedIds.has(l.id) ? { ...l, synced: true } : l);

          cachedLogs = localLogs; // Update memory
          await localforage.setItem(LOGS_KEY, localLogs); // Update storage
        }
      } catch (e) {
        console.error("Failed to push unsynced logs:", e);
      }
    }

    const shouldPull = pullUpdates && (Date.now() - lastLogPullAt >= LOG_PULL_MIN_INTERVAL_MS);
    if (shouldPull) {
      // 2. Fetch NEW logs from server (Differential Sync)
      const maxTimestamp = localLogs.length > 0 ? Math.max(...localLogs.map(l => l.timestamp)) : 0;

      const res = await fetch(apiUrl(`/api/logs?since=${maxTimestamp}`));
      if (res.ok) {
        const newLogs = await res.json();
        if (newLogs.length > 0) {
          const existingIds = new Set(localLogs.map(l => l.id));
          const uniqueNewLogs = newLogs.filter((l: WorkLog) => !existingIds.has(l.id));

          if (uniqueNewLogs.length > 0) {
            const finalNewLogs = uniqueNewLogs.map((l: WorkLog) => ({ ...l, synced: true }));
            cachedLogs = [...localLogs, ...finalNewLogs].sort((a, b) => a.timestamp - b.timestamp);
            await localforage.setItem(LOGS_KEY, cachedLogs);
          }
        }
        lastLogPullAt = Date.now();
      }
    }
  } finally {
    isSyncingLogs = false;
  }
};

/**
 * Fetch Daily Statistics from Server (Aggregated)
 */
export const getDailyStats = async (date: Date) => {
  try {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const res = await fetch(apiUrl(`/api/analytics/daily?date=${dateStr}`));
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const responseText = await res.text();
        throw new Error(`Expected JSON response but got "${contentType || 'unknown'}": ${responseText.slice(0, 120)}`);
      }
      return await res.json();
    }
  } catch (e) {
    console.error("Failed to fetch daily stats:", e);
  }
  return [];
};

const formatDateToYmd = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getRangeStats = async (startDate: Date, endDate: Date) => {
  const startStr = formatDateToYmd(startDate);
  const endStr = formatDateToYmd(endDate);

  const res = await fetch(apiUrl(`/api/analytics/range?start=${startStr}&end=${endStr}`));
  if (!res.ok) throw new Error('Failed to fetch range analytics');

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const responseText = await res.text();
    throw new Error(`Expected JSON response but got "${contentType || 'unknown'}": ${responseText.slice(0, 120)}`);
  }

  return await res.json();
};

/**
 * Fetch Weekly Statistics (Aggregates 7 calls to daily stats)
 */
export const getWeeklyStats = async (startDate: Date) => {
  try {
    const weekStart = new Date(startDate);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    return await getRangeStats(weekStart, weekEnd);
  } catch (e) {
    console.error("Failed to fetch weekly stats:", e);
    return [];
  }
};

/**
 * Fetch Monthly Statistics (Aggregates calls to daily stats)
 */
export const getMonthlyStats = async (year: number, month: number) => {
  try {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0); // Last day of month
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    return await getRangeStats(startDate, endDate);

  } catch (e) {
    console.error("Failed to fetch monthly stats:", e);
    return [];
  }
};

/** 프로젝트별 기간 집계 (_project_map 기준, 작업자 구분 없음) */
export const getProjectRangeStats = async (startDate: Date, endDate: Date) => {
  const startStr = formatDateToYmd(startDate);
  const endStr = formatDateToYmd(endDate);
  const res = await fetch(apiUrl(`/api/analytics/range-by-project?start=${startStr}&end=${endStr}`));
  if (res.status === 404) {
    throw new Error(
      '서버에 GET /api/analytics/range-by-project 가 없습니다. YOLO_API_STUDIO를 최신 코드로 빌드한 뒤 API를 재시작하거나, 개발 시 VITE_DEV_API_SAME_ORIGIN=true 로 Vite 내장 API를 쓰는지 확인하세요.'
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 240);
    } catch {
      /* ignore */
    }
    throw new Error(
      `프로젝트 리포트 API 오류 (${res.status})${detail ? `: ${detail}` : ''}`
    );
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const responseText = await res.text();
    throw new Error(`Expected JSON response but got "${contentType || 'unknown'}": ${responseText.slice(0, 120)}`);
  }
  return await res.json();
};

export const getDailyProjectStats = async (date: Date) => getProjectRangeStats(date, date);

export const getWeeklyProjectStats = async (startDate: Date) => {
  const weekStart = new Date(startDate);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  return await getProjectRangeStats(weekStart, weekEnd);
};

export const getMonthlyProjectStats = async (year: number, month: number) => {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);
  return await getProjectRangeStats(startDate, endDate);
};

/**
 * Fetch Overall Project Summary from Server
 */
export const getProjectSummary = async () => {
  try {
    const res = await fetch(apiUrl('/api/analytics/summary'));
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error("Failed to fetch project summary:", e);
  }
  return null;
};

/**
 * Loads more tasks from the server (Pagination)
 */
export const loadMoreTasks = async (offset: number, limit: number = TASK_LIST_PAGE_SIZE) => {
  try {
    let url = '';
    if (cachedTasks.length > 0) {
      const last = cachedTasks[cachedTasks.length - 1];
      url = buildDatasetsUrl(limit, 0, last.lastUpdated, last.id);
    } else {
      url = buildDatasetsUrl(limit, offset);
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch more datasets');
    const files = await res.json();

    const existingIds = new Set(cachedTasks.map(t => t.id));
    const newTasks = files.filter((f: any) => !existingIds.has(f.id)).map((f: any) => normalizeServerTask(f));

    cachedTasks = [...cachedTasks, ...newTasks];
    invalidateFolderNavIndex();
    await persistCachedTasks();
    newTasks.forEach(task => markTaskAsCommitted(task as Task));
    return newTasks;
  } catch (e) {
    console.error("Load More Failed:", e);
    return [];
  }
};

/** 동시에 여러 곳에서 initStorage 호출 시 태스크 동기화를 한 번으로 합침 */
let syncTasksDeltaInFlight: Promise<number> | null = null;

async function syncTasksDeltaImpl(options?: SyncTasksDeltaOptions): Promise<number> {
  const maxInitialBatches = options?.maxInitialBatches;
  const forceFullDeltaOnEmptyCache = options?.forceFullDeltaOnEmptyCache === true;

  const maxTimestamp = cachedTasks.length > 0
    ? Math.max(...cachedTasks.map(t => t.lastUpdated || 0))
    : 0;

  /**
   * 캐시가 비어 있을 때 since=0 델타는 서버가 거의 전 테이블을 JSON으로 돌려줌(수백 MB).
   * 초기 적재는 /api/datasets 페이징(작업자는 worker 파라미터 동일 경로, 배치 상한)만 하고,
   * 델타는 캐시에 시계가 생긴 뒤(또는 이미 찬 뒤)에만 호출한다.
   */
  const skipHeavyDelta = cachedTasks.length === 0 && !forceFullDeltaOnEmptyCache;

  let updated: unknown[] = [];
  let deleted: string[] = [];

  if (!skipHeavyDelta) {
    const params = new URLSearchParams({ since: String(maxTimestamp) });
    if (_workerScope) params.set('worker', _workerScope);

    const res = await fetch(apiUrl(`/api/sync/delta?${params.toString()}`));
    if (!res.ok) throw new Error('Failed to fetch delta sync');
    const body = await res.json();
    updated = Array.isArray(body.updated) ? body.updated : [];
    deleted = Array.isArray(body.deleted) ? body.deleted : [];
  }

  const baseMap = new Map(cachedTasks.map(t => [t.id, t]));

  // 2. Handle Deletions
  if (deleted && deleted.length > 0) {
    const deletedSet = new Set(deleted);
    cachedTasks = cachedTasks.filter(t => !deletedSet.has(t.id));
    invalidateFolderNavIndex();
    deleted.forEach((id: string) => baseMap.delete(id));
  }

  // 3. Handle Updates/New Tasks
  if (updated && updated.length > 0) {
    updated.forEach((f: any) => {
      const existing = baseMap.get(f.id);
      baseMap.set(f.id, normalizeServerTask(f, existing));
    });
    cachedTasks = Array.from(baseMap.values())
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) || a.id.localeCompare(b.id));
    invalidateFolderNavIndex();
  }

  // 4. Initial Load if empty — 작업자도 worker 쿼리로 동일 페이징(배치 상한은 maxInitialBatches)
  if (cachedTasks.length === 0) {
    taskListNeedsBackgroundDrain = false;
    let offset = 0;
    let batchesFetched = 0;
    while (true) {
      if (maxInitialBatches != null && batchesFetched >= maxInitialBatches) {
        taskListNeedsBackgroundDrain = true;
        break;
      }
      if (batchesFetched > 0 && TASK_FETCH_BATCH_GAP_MS > 0) {
        await sleep(TASK_FETCH_BATCH_GAP_MS);
      }
      const batchRes = await fetch(buildDatasetsUrl(TASK_LIST_PAGE_SIZE, offset));
      if (!batchRes.ok) break;
      const batch = await batchRes.json();
      if (!batch || batch.length === 0) break;
      batch.forEach((f: any) => {
        if (!baseMap.has(f.id)) {
          baseMap.set(f.id, normalizeServerTask(f));
        }
      });
      offset += batch.length;
      batchesFetched += 1;
      if (batch.length < TASK_LIST_PAGE_SIZE) break;
    }
    cachedTasks = Array.from(baseMap.values())
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) || a.id.localeCompare(b.id));
    invalidateFolderNavIndex();
  }

  await persistCachedTasks();
  refreshCommittedTaskSignatures();
  return cachedTasks.length;
}

export const syncTasksDelta = async (options?: SyncTasksDeltaOptions): Promise<number> => {
  if (syncTasksDeltaInFlight) return syncTasksDeltaInFlight;
  syncTasksDeltaInFlight = (async () => {
    try {
      return await syncTasksDeltaImpl(options);
    } catch (e) {
      console.error("Delta task sync failed:", e);
      return cachedTasks.length;
    } finally {
      syncTasksDeltaInFlight = null;
    }
  })();
  return syncTasksDeltaInFlight;
};

export const syncAllTaskPages = async (_limit?: number) => {
  await resyncTasksFromServerFull();
  return cachedTasks.length;
};

/** 특정 작업자의 작업을 서버에서 불러와 캐시에 병합 (관리자 검수 시 해당 작업자 작업이 없을 때 사용) */
export const fetchAndMergeWorkerTasks = async (workerName: string): Promise<void> => {
  const prevScope = _workerScope;
  _workerScope = workerName;
  try {
    const baseMap = new Map(cachedTasks.map((t) => [t.id, t]));
    let offset = 0;
    let wBatch = 0;
    while (true) {
      if (wBatch > 0 && TASK_FETCH_BATCH_GAP_MS > 0) await sleep(TASK_FETCH_BATCH_GAP_MS);
      const res = await fetch(buildDatasetsUrl(TASK_LIST_PAGE_SIZE, offset));
      if (!res.ok) break;
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      batch.forEach((f: any) => {
        const existing = baseMap.get(f.id);
        baseMap.set(f.id, normalizeServerTask(f, existing));
      });
      offset += batch.length;
      wBatch += 1;
      if (batch.length < TASK_LIST_PAGE_SIZE) break;
    }
    cachedTasks = Array.from(baseMap.values())
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) || a.id.localeCompare(b.id));
    invalidateFolderNavIndex();
    await persistCachedTasks();
  } finally {
    _workerScope = prevScope;
  }
};

/**
 * 특정 작업자 + 지정 폴더 목록만 서버에서 페이지 머지(전체 작업자 풀 페이징보다 범위가 작을 때).
 * 검수 큐에서 프로젝트를 고른 뒤 해당 프로젝트에 매핑된 폴더들만 불러올 때 사용.
 */
export async function fetchAndMergeWorkerTasksForProjectFolders(
  workerName: string,
  folderPaths: string[]
): Promise<void> {
  const w = String(workerName || '').trim();
  const unique = [...new Set(folderPaths.map((f) => String(f || '').trim()).filter(Boolean))];
  if (!w || unique.length === 0) return;
  const prevScope = _workerScope;
  _workerScope = w;
  try {
    await stopTaskListBackgroundDrain();
    for (let i = 0; i < unique.length; i++) {
      if (i > 0 && TASK_FETCH_BATCH_GAP_MS > 0) await sleep(TASK_FETCH_BATCH_GAP_MS);
      const folder = unique[i];
      const totalHint = await getFolderTaskCountFromServer(folder);
      await fetchAllFolderPagesIntoCache(folder, 'name', totalHint);
    }
    await syncTasksDelta();
  } finally {
    _workerScope = prevScope;
  }
}

/** Fetch tasks by ID and merge into cache (e.g. after VLM assign so UI sees new assignments) */
export const mergeTasksByIds = async (taskIds: string[]): Promise<void> => {
  if (!taskIds || taskIds.length === 0) return;
  const baseMap = new Map(cachedTasks.map((t) => [t.id, t]));
  for (let i = 0; i < taskIds.length; i += MERGE_TASKS_BY_IDS_POST_BATCH) {
    const chunk = taskIds.slice(i, i + MERGE_TASKS_BY_IDS_POST_BATCH);
    try {
      const res = await fetch(apiUrl('/api/datasets/by-ids'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk })
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg =
          errBody && typeof (errBody as { error?: string }).error === 'string'
            ? (errBody as { error: string }).error
            : res.statusText;
        console.warn('mergeTasksByIds: batch failed', res.status, msg, { from: i, size: chunk.length });
        continue;
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) continue;
      batch.forEach((f: any) => {
        const existing = baseMap.get(f.id);
        baseMap.set(f.id, normalizeServerTask(f, existing));
      });
    } catch (e) {
      console.warn('mergeTasksByIds: fetch error', e, { from: i, size: chunk.length });
    }
  }
  cachedTasks = Array.from(baseMap.values())
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) || a.id.localeCompare(b.id));
  invalidateFolderNavIndex();
  await persistCachedTasks();
};

/** 폴더 작업 목록 UI 페이지 크기(서버 offset/limit) */
export const FOLDER_TASK_LIST_PAGE_SIZE = 1000;

/**
 * POST /api/datasets/by-ids 본문에 넣을 ID 개수 상한(한 청크).
 * VLM id가 매우 길어도 URL 길이 제한에 걸리지 않음.
 */
const MERGE_TASKS_BY_IDS_POST_BATCH = 5000;

export async function fetchFolderMetricsFromServer(folder: string): Promise<FolderMetricsPayload | null> {
  if (!folder?.trim()) return null;
  const params = new URLSearchParams({ folder: folder.trim() });
  if (_workerScope) params.set('worker', _workerScope);
  try {
    const res = await fetch(apiUrl(`/api/datasets/folder-metrics?${params}`));
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('fetchFolderMetricsFromServer failed', e);
    return null;
  }
}

export async function getFolderTaskCountFromServer(folder: string): Promise<number | null> {
  if (!folder?.trim()) return null;
  const params = new URLSearchParams({ folder: folder.trim() });
  if (_workerScope) params.set('worker', _workerScope);
  try {
    const res = await fetch(apiUrl(`/api/datasets/count?${params}`));
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j.count === 'number' ? j.count : null;
  } catch (e) {
    console.error('getFolderTaskCountFromServer failed', e);
    return null;
  }
}

/** 캐시 변경 없이 폴더 첫 행만 조회(정렬 방식 결정용) */
export async function peekFolderFirstTaskRemote(folder: string): Promise<Task | null> {
  if (!folder?.trim()) return null;
  const params = new URLSearchParams({
    folder: folder.trim(),
    limit: '1',
    offset: '0',
    sort: 'updated'
  });
  if (_workerScope) params.set('worker', _workerScope);
  try {
    const res = await fetch(apiUrl(`/api/datasets?${params}`));
    if (!res.ok) return null;
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) return null;
    return normalizeServerTask(batch[0]);
  } catch (e) {
    console.error('peekFolderFirstTaskRemote failed', e);
    return null;
  }
}

/**
 * 폴더 단위 작업 목록 한 페이지를 가져와 캐시에 머지. 반환값은 해당 페이지 태스크(정렬 일치).
 */
export async function fetchFolderTaskPageIntoCache(
  folder: string,
  offset: number,
  limit: number,
  sort: 'name' | 'id' | 'updated'
): Promise<Task[]> {
  if (!folder?.trim()) return [];
  const params = new URLSearchParams({
    folder: folder.trim(),
    limit: String(limit),
    offset: String(offset),
    sort
  });
  if (_workerScope) params.set('worker', _workerScope);
  try {
    const res = await fetch(apiUrl(`/api/datasets?${params}`));
    if (!res.ok) return [];
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) return [];
    const baseMap = new Map(cachedTasks.map((t) => [t.id, t]));
    const out: Task[] = [];
    batch.forEach((f: any) => {
      const existing = baseMap.get(f.id);
      const t = normalizeServerTask(f, existing);
      baseMap.set(f.id, t);
      out.push(t);
    });
    cachedTasks = Array.from(baseMap.values())
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) || a.id.localeCompare(b.id));
    invalidateFolderNavIndex();
    await persistCachedTasks();
    refreshCommittedTaskSignatures();
    return out;
  } catch (e) {
    console.error('fetchFolderTaskPageIntoCache failed', e);
    return [];
  }
}

/**
 * 폴더 작업을 페이지 단위로 끝까지 받아 캐시에 머지(작업 이어하기 등 — 첫 페이지만 보던 문제 방지).
 * @param totalHint 서버 count(있으면 불필요한 요청 줄임); 없으면 빈 페이지까지 순회
 */
export async function fetchAllFolderPagesIntoCache(
  folder: string,
  sort: 'name' | 'id' | 'updated',
  totalHint?: number | null
): Promise<number> {
  const f = String(folder || '').trim();
  if (!f) return 0;
  const pageSize = FOLDER_TASK_LIST_PAGE_SIZE;
  let offset = 0;
  let loaded = 0;
  const cap =
    totalHint != null && Number.isFinite(totalHint) && totalHint > 0 ? Math.ceil(totalHint) : 0;
  for (;;) {
    const page = await fetchFolderTaskPageIntoCache(f, offset, pageSize, sort);
    if (page.length === 0) break;
    loaded += page.length;
    offset += page.length;
    if (page.length < pageSize) break;
    if (cap > 0 && offset >= cap) break;
  }
  return loaded;
}

/**
 * 부분 디스크 스캔(`/api/sync?folders=`) 직후. 캐시를 비우지 않고, 스캔한 폴더만
 * `datasets?folder=`로 페이지 머지한 뒤 델타로 삭제·기타 갱신을 반영한다.
 * `initStorage({ fullTaskSync })`처럼 전역 datasets 오프셋 루프를 돌지 않는다.
 */
export async function mergeTasksFromServerForFoldersAfterDiskSync(folders: string[]): Promise<void> {
  const unique = [...new Set(folders.map((f) => String(f || '').trim()).filter(Boolean))];
  if (unique.length === 0) return;
  await stopTaskListBackgroundDrain();
  for (let i = 0; i < unique.length; i += 1) {
    await fetchAllFolderPagesIntoCache(unique[i], 'name', null);
    if (i < unique.length - 1 && TASK_FETCH_BATCH_GAP_MS > 0) {
      await sleep(TASK_FETCH_BATCH_GAP_MS);
    }
  }
  await syncTasksDelta();
}

/** Fetch all tasks in a folder from server and merge into cache (e.g. so sourceType is correct for classification projects) */
export const fetchAndMergeTasksByFolder = async (folder: string): Promise<void> => {
  if (!folder || !folder.trim()) return;
  const url = apiUrl(`/api/datasets?folder=${encodeURIComponent(folder.trim())}&limit=10000`);
  const res = await fetch(url);
  if (!res.ok) return;
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) return;
  const baseMap = new Map(cachedTasks.map((t) => [t.id, t]));
  batch.forEach((f: any) => {
    const existing = baseMap.get(f.id);
    baseMap.set(f.id, normalizeServerTask(f, existing));
  });
  cachedTasks = Array.from(baseMap.values())
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0) || a.id.localeCompare(b.id));
  invalidateFolderNavIndex();
  await persistCachedTasks();
};

export const getTasks = (): Task[] => {
  return cachedTasks;
};

export const getTaskById = async (id: string): Promise<Task | undefined> => {
  let task = cachedTasks.find(t => t.id === id);
  if (!task) return undefined;

  // List API omits sourceData; 분류 프로젝트 폴더인데 DB에 native-yolo로 남은 행도 sourceData 필요
  const needFullRow =
    (task.sourceType === 'vlm-review' ||
      task.sourceType === 'image-classification' ||
      isFolderMappedToImageClassificationProject(task.folder)) &&
    task.sourceData == null;

  if (needFullRow) {
    try {
      const res = await fetch(apiUrl(`/api/task?id=${encodeURIComponent(id)}`));
      if (res.ok) {
        const full = await res.json();
        task = {
          ...task,
          ...full,
          annotations: task.annotations ?? full.annotations,
          isModified: full.isModified === 1 || full.isModified === true
        } as Task;
        const idx = cachedTasks.findIndex(t => t.id === id);
        if (idx !== -1) {
          const old = cachedTasks[idx];
          cachedTasks[idx] = task;
          patchFolderNavIndexOnTaskReplace(old, task);
        }
      }
    } catch (e) {
      console.error("Failed to load full task", id, e);
    }
  }

  // If annotations are still empty, try to load from labels
  if ((!task.annotations || task.annotations.length === 0) && task.txtPath) {
    try {
      const res = await fetch(apiUrl(`/api/label?path=${encodeURIComponent(task.txtPath)}`));
      const text = await res.text();
      if (text) {
        task.annotations = parseYoloTxt(text);
        await updateTaskInCache(task);
      }
    } catch (e) {
      console.error("Failed to load labels for task", task.id, e);
    }
  }
  return task;
};

const updateTaskInCache = async (task: Task, persistLocally: boolean = false) => {
  const index = cachedTasks.findIndex(t => t.id === task.id);
  if (index !== -1) {
    const old = cachedTasks[index];
    cachedTasks[index] = task;
    patchFolderNavIndexOnTaskReplace(old, task);
    if (persistLocally) {
      queueTaskPersist(task);
    }
  }
}

/**
 * Updates task in memory only.
 * Sets isDirty flag to true for manual modifications.
 */
export const updateTaskLocally = async (taskId: string, updates: Partial<Task>): Promise<Task> => {
  const task = cachedTasks.find(t => t.id === taskId);
  if (!task) throw new Error('Task not found');

  const merged: Partial<Task> = {};
  for (const [k, v] of Object.entries(updates) as [keyof Task, unknown][]) {
    if (v !== undefined) {
      (merged as Record<string, unknown>)[k as string] = v;
    }
  }

  const updatedTask = {
    ...task,
    ...merged,
    isModified: merged.annotations ? true : (merged.isModified ?? task.isModified),
    lastUpdated: Date.now()
  };

  await updateTaskInCache(updatedTask, false);
  return updatedTask;
};

/**
 * Syncs a specific task's state to the server (Physical Disk + DB)
 */
export const syncTaskToServer = async (taskId: string): Promise<void> => {
  const task = cachedTasks.find(t => t.id === taskId);
  if (!task) return;

  const commitSignature = getTaskCommitSignature(task);
  const previouslyCommitted = lastCommittedTaskSignature.get(task.id);
  if (previouslyCommitted && previouslyCommitted === commitSignature) {
    return;
  }

  try {
    const key = task.imageUrl.startsWith('/datasets/')
      ? task.imageUrl.substring('/datasets/'.length)
      : (task.folder === 'Unsorted' ? task.name : `${task.folder}/${task.name}`);
    const isVlmTask = task.sourceType === 'vlm-review';
    const isClassification =
      task.sourceType === 'image-classification' || isFolderMappedToImageClassificationProject(task.folder);
    /** 분류는 sourceData(DB)만 사용. YOLO .txt 쓰기 시도 시 ENOENT(폴더 없음 등) 발생 방지 */
    const shouldPersistLabel =
      !isVlmTask && !isClassification && (task.isModified || task.status === TaskStatus.SUBMITTED);
    const labelPayload = shouldPersistLabel
      ? (() => {
        if (!task.txtPath) {
          let relativeTxtPath = task.imageUrl.startsWith('/') ? task.imageUrl.substring(1) : task.imageUrl;
          relativeTxtPath = relativeTxtPath.substring(0, relativeTxtPath.lastIndexOf('.')) + '.txt';
          task.txtPath = relativeTxtPath;
        }
        return {
          path: task.txtPath,
          content: generateYoloTxt(task.annotations || [])
        };
      })()
      : null;

    const res = await fetch(apiUrl('/api/task-commit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: labelPayload,
        metadata: {
          id: task.id,
          key,
          updates: {
            status: task.status,
            isModified: task.isModified ? 1 : 0,
            assignedWorker: task.assignedWorker,
            reviewerNotes: task.reviewerNotes,
            sourceType: task.sourceType || 'native-yolo',
            sourceRefId: task.sourceRefId,
            sourceFile: task.sourceFile,
            sourceData: task.sourceData,
            lastUpdated: task.lastUpdated
          }
        }
      })
    });
    if (!res.ok) throw new Error('Failed task commit');
    markTaskAsCommitted(task);
  } catch (e) {
    console.error("Failed to sync task commit", e);
    throw e;
  }
};

/**
 * Legacy updateTask (kept for compatibility, but now uses the new logic internally)
 * For features that still need immediate sync (like submitting)
 */
export const updateTask = async (taskId: string, updates: Partial<Task>, userId: string, role: UserRole): Promise<Task> => {
  const updated = await updateTaskLocally(taskId, updates);
  await syncTaskToServer(taskId);
  return updated;
};

export const assignFolderToWorker = async (folderName: string, workerName: string | undefined) => {
  const timestamp = Date.now();
  // Update In-Memory Cache
  cachedTasks = cachedTasks.map(t => {
    if (t.folder === folderName) {
      return { ...t, assignedWorker: workerName, lastUpdated: timestamp };
    }
    return t;
  });
  invalidateFolderNavIndex();

  // 2. Persist to Server (Physical Move)
  try {
    await fetch(apiUrl('/api/assign-worker'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderName,
        workerName: workerName || 'Unassigned'
      })
    });

    await fetch(apiUrl('/api/folder-metadata'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: folderName,
        updates: { assignedWorker: workerName, lastUpdated: timestamp }
      })
    });
  } catch (e) {
    console.error("Failed to sync physical folder assignment", e);
  }
};

export const logAction = async (
  taskId: string,
  userId: string,
  role: UserRole,
  action: WorkLog['action'],
  durationSeconds: number = 0,
  isModifiedOverride?: boolean
) => {
  const task = cachedTasks.find(t => t.id === taskId);
  const cappedDurationSeconds = Math.min(300, Math.max(0, Number(durationSeconds || 0)));
  let stats = undefined;
  if (task && (action === 'SUBMIT' || action === 'APPROVE' || action === 'SAVE')) {
    stats = {
      totalBoxCount: task.annotations.length,
      manualBoxCount: task.annotations.filter(a => !a.isAutoLabel).length
    };
  }

  const normalizedUserId = userId.trim();
  const deterministicSubmitId = `submit:${taskId}:${normalizedUserId}`;
  const logId = action === 'SUBMIT'
    ? deterministicSubmitId
    : Math.random().toString(36).substr(2, 9);

  const newLog: WorkLog = {
    id: logId,
    taskId,
    userId: normalizedUserId,
    role,
    folder: task?.folder || 'Unknown',
    action,
    timestamp: Date.now(),
    durationSeconds: cappedDurationSeconds,
    isModified: isModifiedOverride !== undefined ? isModifiedOverride : task?.isModified,
    stats,
    sourceType: task?.sourceType || 'native-yolo'
  };
  if (action === 'SUBMIT') {
    const existingIndex = cachedLogs.findIndex(l => l.id === logId);
    if (existingIndex >= 0) {
      const existing = cachedLogs[existingIndex];
      cachedLogs[existingIndex] = {
        ...existing,
        ...newLog,
        durationSeconds: cappedDurationSeconds
      };
    } else {
      cachedLogs.push(newLog);
    }
  } else {
    cachedLogs.push(newLog);
  }
  await localforage.setItem(LOGS_KEY, cachedLogs);

  // Push unsynced logs immediately, but avoid frequent pull requests while navigating.
  syncLogs(false);
};

export const getLogs = (): WorkLog[] => {
  return cachedLogs;
};

export const getFolderMetadata = (folderName: string): any => {
  const meta = cachedFolderMeta[folderName] || {};
  return {
    tags: [],
    memo: '',
    ...meta
  };
};

export const saveFolderMetadata = async (folderName: string, meta: any) => {
  cachedFolderMeta[folderName] = meta;
  await localforage.setItem(FOLDER_META_KEY, cachedFolderMeta);

  // Sync to Server
  try {
    await fetch(apiUrl('/api/folder-metadata'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: folderName,
        updates: meta
      })
    });
  } catch (e) {
    console.error("Failed to sync folder metadata to server", e);
  }
};

export const convertFolderToWebp = async (folderName: string, limit?: number, offset?: number) => {
  try {
    const res = await fetch(apiUrl('/api/convert-folder'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderName, limit, offset })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("Batch conversion trigger failed", e);
    return null;
  }
};

export const getAllFolderMetadata = (): Record<string, any> => {
  return cachedFolderMeta;
};

export const createTaskIssue = async (payload: {
  taskId: string;
  type: TaskIssueType;
  reasonCode: TaskIssueReasonCode;
  createdBy: string;
}) => {
  try {
    const task = cachedTasks.find(t => t.id === payload.taskId);
    if (!task) throw new Error('Task not found');

    const res = await fetch(apiUrl('/api/issues'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: payload.taskId,
        folder: task.folder,
        imageUrl: task.imageUrl,
        type: payload.type,
        reasonCode: payload.reasonCode,
        createdBy: payload.createdBy
      })
    });
    if (!res.ok) throw new Error('Failed to create issue');
    const data = await res.json();
    // Locallly update the task status to ISSUE_PENDING to lock it immediately
    await updateTaskLocally(payload.taskId, { status: TaskStatus.ISSUE_PENDING });
    invalidateOpenIssueCountCache();
    return data;
  } catch (e) {
    console.error("Failed to create task issue:", e);
    throw e;
  }
};

let issueCountCache: { value: number; fetchedAt: number } | null = null;
let issueCountInFlight: Promise<number> | null = null;
const ISSUE_COUNT_CLIENT_TTL_MS = 60 * 1000;

export const invalidateOpenIssueCountCache = () => {
  issueCountCache = null;
  issueCountInFlight = null;
};

/** 서버가 느릴 때 동시 다발 호출·15초 폴링이 쌓이지 않도록 짧게 캐시·in-flight 공유 */
export const getOpenIssueCount = async (forceRefresh: boolean = false): Promise<number> => {
  if (!forceRefresh && issueCountCache && Date.now() - issueCountCache.fetchedAt < ISSUE_COUNT_CLIENT_TTL_MS) {
    return issueCountCache.value;
  }
  if (!forceRefresh && issueCountInFlight) return issueCountInFlight;

  if (forceRefresh) {
    issueCountCache = null;
    issueCountInFlight = null;
  }

  const p = (async (): Promise<number> => {
    try {
      const res = await fetch(apiUrl('/api/issues/count'));
      if (!res.ok) throw new Error('Failed to fetch open issue count');
      const data = await res.json();
      const n = Number(data?.openCount || 0);
      issueCountCache = { value: n, fetchedAt: Date.now() };
      return n;
    } catch (e) {
      console.error("Failed to fetch open issue count:", e);
      return issueCountCache?.value ?? 0;
    } finally {
      issueCountInFlight = null;
    }
  })();

  issueCountInFlight = p;
  return p;
};

export const getTaskIssues = async (status?: TaskIssueStatus): Promise<TaskIssue[]> => {
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetch(apiUrl(`/api/issues${query}`));
    if (!res.ok) throw new Error('Failed to fetch issues');
    return await res.json();
  } catch (e) {
    console.error("Failed to fetch task issues:", e);
    return [];
  }
};

export const updateTaskIssueStatus = async (
  id: string,
  status: TaskIssueStatus,
  resolvedBy: string,
  resolutionNote: string = ''
) => {
  try {
    const res = await fetch(apiUrl('/api/issues/resolve'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status, resolvedBy, resolutionNote })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to update issue status');
    }
    return data;
  } catch (e) {
    console.error("Failed to update task issue status:", e);
    throw e;
  }
};

export const getVacations = async (startDate: string, endDate: string): Promise<VacationRecord[]> => {
  try {
    const query = `?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const res = await fetch(apiUrl(`/api/vacations${query}`));
    if (!res.ok) throw new Error('Failed to fetch vacations');
    return await res.json();
  } catch (e) {
    console.error("Failed to fetch vacations:", e);
    return [];
  }
};

export const createVacation = async (payload: {
  userId: string;
  startDate: string;
  endDate: string;
  days: number;
  note?: string;
}) => {
  try {
    const res = await fetch(apiUrl('/api/vacations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to create vacation');
    return await res.json();
  } catch (e) {
    console.error("Failed to create vacation:", e);
    throw e;
  }
};

export const deleteVacation = async (id: string) => {
  try {
    const res = await fetch(apiUrl(`/api/vacations?id=${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete vacation');
    return await res.json();
  } catch (e) {
    console.error("Failed to delete vacation:", e);
    throw e;
  }
};

export const getScheduleBoard = async (startDate: string, endDate: string): Promise<Record<string, Record<string, string[]>>> => {
  try {
    const query = `?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const res = await fetch(apiUrl(`/api/schedule/board${query}`));
    if (!res.ok) throw new Error('Failed to fetch schedule board');
    return await res.json();
  } catch (e) {
    console.error("Failed to fetch schedule board:", e);
    return {};
  }
};

export const getProjects = async (): Promise<ProjectDefinition[]> => {
  try {
    const res = await fetch(apiUrl('/api/projects'));
    if (!res.ok) throw new Error('Failed to fetch projects');
    return await res.json();
  } catch (e) {
    console.error("Failed to fetch projects:", e);
    return [];
  }
};

export const saveProject = async (payload: {
  id?: string;
  name: string;
  targetTotal: number;
  workflowSourceType?: 'native-yolo' | 'vlm-review' | 'image-classification';
  vlmSourceFile?: string;
  vlmSourceFiles?: string[];
  classificationClasses?: Array<{ id: number; name: string }>;
  visibleToWorkers?: boolean;
}) => {
  try {
    const res = await fetch(apiUrl('/api/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to save project');
    return await res.json();
  } catch (e) {
    console.error("Failed to save project:", e);
    throw e;
  }
};

export const deleteProject = async (projectId: string) => {
  try {
    const res = await fetch(apiUrl('/api/projects'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId })
    });
    if (!res.ok) throw new Error('Failed to delete project');
    return await res.json();
  } catch (e) {
    console.error('Failed to delete project:', e);
    throw e;
  }
};

export const archiveProject = async (payload: { projectId: string; snapshot?: ProjectDetailPayload | null }) => {
  try {
    const res = await fetch(apiUrl('/api/projects/archive'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to archive project');
    return await res.json();
  } catch (e) {
    console.error("Failed to archive project:", e);
    throw e;
  }
};

export const restoreProject = async (payload: { projectId: string }) => {
  try {
    const res = await fetch(apiUrl('/api/projects/restore'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to restore project');
    return await res.json();
  } catch (e) {
    console.error("Failed to restore project:", e);
    throw e;
  }
};

/** 서버 매핑 트랜잭션은 PG_MAP_LOCK_TIMEOUT_MS=0 일 때 락을 무제한 대기할 수 있어 20분까지 허용 */
const MAP_AND_WORKER_POST_TIMEOUT_MS = 1_200_000;

function isFetchAbortOrTimeout(e: unknown): boolean {
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true;
  if (e instanceof Error && e.name === 'TimeoutError') return true;
  return false;
}

export type PruneDatasetsScopePayload =
  | { kind: 'missing_folder_roots'; paths: string[]; dryRun?: boolean }
  | { kind: 'stale_files_under_folders'; folders: string[]; dryRun?: boolean }
  | { kind: 'delete_tasks_under_folders'; folders: string[]; dryRun?: boolean };

export type PruneDatasetsScopeResult = {
  success?: boolean;
  dryRun: boolean;
  deletedNative: number;
  deletedVlm: number;
  skippedPaths?: string[];
  skippedFolders?: string[];
  errors?: string[];
};

/**
 * DB에만 남은 작업 정리. dryRun이면 건수만 조회(서버 변경 없음).
 * 실제 삭제 후에는 프로젝트 개요 캐시를 무효화합니다.
 */
export const pruneDatasetsScope = async (payload: PruneDatasetsScopePayload): Promise<PruneDatasetsScopeResult> => {
  const dryRun = payload.dryRun === true;
  try {
    const res = await fetch(apiUrl('/api/datasets/prune'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, dryRun }),
      signal: AbortSignal.timeout(MAP_AND_WORKER_POST_TIMEOUT_MS)
    });
    const body = (await res.json().catch(() => null)) as (PruneDatasetsScopeResult & { error?: string }) | null;
    if (!res.ok) {
      throw new Error(body?.error || `prune 실패 (${res.status})`);
    }
    if (!dryRun) invalidateProjectOverviewCache();
    return {
      dryRun: Boolean(body?.dryRun),
      deletedNative: typeof body?.deletedNative === 'number' ? body.deletedNative : 0,
      deletedVlm: typeof body?.deletedVlm === 'number' ? body.deletedVlm : 0,
      skippedPaths: body?.skippedPaths,
      skippedFolders: body?.skippedFolders,
      errors: body?.errors
    };
  } catch (e) {
    console.error('pruneDatasetsScope:', e);
    if (isFetchAbortOrTimeout(e)) {
      throw new Error('서버 응답이 너무 오래 걸립니다. 대량 삭제·DB 락을 확인해 주세요.');
    }
    throw e;
  }
};

export const mapFolderToProject = async (folder: string, projectId: string | null) => {
  try {
    const res = await fetch(apiUrl('/api/projects/map'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, projectId }),
      signal: AbortSignal.timeout(MAP_AND_WORKER_POST_TIMEOUT_MS)
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `프로젝트 매핑 실패 (${res.status})`);
    }
    invalidateProjectOverviewCache();
    return await res.json();
  } catch (e) {
    console.error('Failed to map folder to project:', e);
    if (isFetchAbortOrTimeout(e)) {
      throw new Error('서버 응답이 너무 오래 걸립니다. DB 락·동기화 작업을 확인해 주세요.');
    }
    throw e;
  }
};

/** 폴더(접두) → 작업자 매핑 저장. _worker_folder_map.json 만 갱신(태스크 행 일괄 UPDATE 없음). API는 규칙 우선으로 해석 */
export const mapFolderToWorker = async (
  folder: string,
  workerName: string | null
): Promise<{ success?: boolean; tasksUpdated?: number; vlmUpdated?: number }> => {
  try {
    const res = await fetch(apiUrl('/api/worker-folder-map'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, workerName: workerName == null ? null : workerName }),
      signal: AbortSignal.timeout(MAP_AND_WORKER_POST_TIMEOUT_MS)
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `작업자 매핑 실패 (${res.status})`);
    }
    invalidateProjectOverviewCache();
    return (await res.json().catch(() => ({}))) as {
      success?: boolean;
      tasksUpdated?: number;
      vlmUpdated?: number;
    };
  } catch (e) {
    console.error('Failed to map folder to worker:', e);
    if (isFetchAbortOrTimeout(e)) {
      throw new Error('서버 응답이 너무 오래 걸립니다. DB 락·동기화 작업을 확인해 주세요.');
    }
    throw e;
  }
};

const EMPTY_PROJECT_OVERVIEW: ProjectOverviewPayload = {
  projects: [],
  projectMap: {},
  workerFolderMap: {},
  unassigned: { folderCount: 0, allocated: 0, completed: 0 },
  folders: [],
  workerFolderBreakdown: []
};

let projectOverviewCache: ProjectOverviewPayload | null = null;
let projectOverviewInFlight: Promise<ProjectOverviewPayload> | null = null;
let projectOverviewFetchedAt = 0;
/** 짧은 시간 안 반복 호출 시 네트워크 생략 (탭 이동·StrictMode 등으로 통계 API 폭주 방지) */
const PROJECT_OVERVIEW_TTL_MS = 15000;
/** force/무효화 이후 늦게 도착한 응답이 캐시를 덮어쓰지 않도록 */
let projectOverviewSeq = 0;

/** 분류 클래스 등 App 쪽이 overview 갱신을 알아채도록 브로드캐스트 */
export const PROJECT_OVERVIEW_INVALIDATE_EVENT = 'yolo-project-overview-invalidate';

/** 프로젝트 통계 API 캐시 무효화(삭제/아카이브 등 이후) */
export const invalidateProjectOverviewCache = () => {
  projectOverviewSeq += 1;
  projectOverviewCache = null;
  projectOverviewInFlight = null;
  projectOverviewFetchedAt = 0;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECT_OVERVIEW_INVALIDATE_EVENT));
  }
};

/** 검수 큐 등: 동기로 projectMap 조회(캐시 없으면 null — 필요 시 getProjectOverview 선호출) */
export const getProjectOverviewCacheSnapshot = (): ProjectOverviewPayload | null => projectOverviewCache;

/** 프로젝트 맵·overview 캐시 기준: 폴더가 이미지 분류 프로젝트에 속하는지 */
export function isFolderMappedToImageClassificationProject(folder: string): boolean {
  const snap = projectOverviewCache;
  if (!snap?.projects?.length) return false;
  const pid = resolveProjectMapEntryForFolder(folder, snap.projectMap || {})?.projectId;
  if (!pid) return false;
  const p = snap.projects.find((x) => String(x.id) === String(pid));
  return p?.workflowSourceType === 'image-classification';
}

/**
 * 전역 캐시 + 동시 호출 1회로 합침. forceRefresh=true 일 때만 네트워크 재요청.
 * (Dashboard 가 tasks.length 마다 호출하던 중복·대기열 폭주 완화)
 */
export const getProjectOverview = async (forceRefresh: boolean = false): Promise<ProjectOverviewPayload> => {
  if (
    !forceRefresh &&
    projectOverviewCache &&
    Date.now() - projectOverviewFetchedAt < PROJECT_OVERVIEW_TTL_MS
  ) {
    return projectOverviewCache;
  }
  if (!forceRefresh && projectOverviewInFlight) {
    return projectOverviewInFlight;
  }

  if (forceRefresh) {
    projectOverviewSeq += 1;
    projectOverviewCache = null;
    projectOverviewInFlight = null;
  }

  const mySeq = projectOverviewSeq;
  const p = (async (): Promise<ProjectOverviewPayload> => {
    try {
      const res = await fetch(apiUrl('/api/projects/overview'));
      if (!res.ok) throw new Error('Failed to fetch project overview');
      const data = await res.json();
      if (mySeq === projectOverviewSeq) {
        projectOverviewCache = data;
        projectOverviewFetchedAt = Date.now();
      }
      return data;
    } catch (e) {
      console.error("Failed to fetch project overview:", e);
      return projectOverviewCache ?? EMPTY_PROJECT_OVERVIEW;
    } finally {
      if (mySeq === projectOverviewSeq) {
        projectOverviewInFlight = null;
      }
    }
  })();

  projectOverviewInFlight = p;
  return p;
};

/** 동일 projectId+days 동시 호출 시 fetch 1회만 (Strict Mode 이중 effect·중복 대기 완화) */
const pendingProjectDetailFetches = new Map<string, Promise<ProjectDetailPayload | null>>();

export const getProjectDetail = async (projectId: string, days: number = 30): Promise<ProjectDetailPayload | null> => {
  const key = `${projectId}::${days}`;
  const existing = pendingProjectDetailFetches.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<ProjectDetailPayload | null> => {
    try {
      const query = `?projectId=${encodeURIComponent(projectId)}&days=${encodeURIComponent(String(days))}`;
      const res = await fetch(apiUrl(`/api/projects/detail${query}`));
      if (!res.ok) throw new Error('Failed to fetch project detail');
      return await res.json();
    } catch (e) {
      console.error("Failed to fetch project detail:", e);
      return null;
    } finally {
      pendingProjectDetailFetches.delete(key);
    }
  })();

  pendingProjectDetailFetches.set(key, promise);
  return promise;
};

export const listPlugins = async (): Promise<PluginDescriptor[]> => {
  try {
    const res = await fetch(apiUrl('/api/plugins'));
    if (!res.ok) throw new Error('Failed to fetch plugins');
    const payload = await res.json();
    return Array.isArray(payload?.plugins) ? payload.plugins : [];
  } catch (e) {
    console.error("Failed to fetch plugins:", e);
    return [];
  }
};

export const getVlmMigrationDryRun = async (limit: number = 100, offset: number = 0): Promise<VlmMigrationDryRunResult | null> => {
  try {
    const query = `?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
    const res = await fetch(apiUrl(`/api/plugins/vlm/dry-run${query}`));
    if (!res.ok) throw new Error('Failed to run VLM dry-run');
    return await res.json();
  } catch (e) {
    console.error("Failed to run VLM dry-run:", e);
    return null;
  }
};

export const migrateVlmData = async (payload?: { commit?: boolean; limit?: number; offset?: number }) => {
  try {
    const res = await fetch(apiUrl('/api/plugins/vlm/migrate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || { commit: false, limit: 10000, offset: 0 })
    });
    if (!res.ok) throw new Error('Failed to migrate VLM data');
    return await res.json();
  } catch (e) {
    console.error("Failed to migrate VLM data:", e);
    throw e;
  }
};

export const listVlmImportJsonFiles = async (): Promise<VlmImportJsonFileInfo[]> => {
  try {
    const res = await fetch(apiUrl('/api/plugins/vlm/import-json/files'));
    if (!res.ok) throw new Error('Failed to fetch VLM import json files');
    const payload = await res.json();
    return Array.isArray(payload?.files) ? payload.files : [];
  } catch (e) {
    console.error('Failed to fetch VLM import json files:', e);
    return [];
  }
};

export const importVlmJsonData = async (payload: {
  sourceFiles: string[];
  commit?: boolean;
  assignees?: string[];
  assignCount?: number;
  keepUnassigned?: boolean;
  imagePathMappings?: Array<{ from: string; to: string }>;
}): Promise<VlmJsonImportResult> => {
  try {
    const res = await fetch(apiUrl('/api/plugins/vlm/import-json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && typeof data.error === 'string') ? data.error : res.statusText || 'Failed to import VLM json data';
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    console.error('Failed to import VLM json data:', e);
    throw e;
  }
};

export const deleteVlmJsonData = async (payload: { sourceFiles: string[] }): Promise<{ success: boolean; deletedCount: number }> => {
  try {
    const res = await fetch(apiUrl('/api/plugins/vlm/import-json'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && typeof data.error === 'string') ? data.error : res.statusText || 'Failed to delete VLM json data';
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    console.error('Failed to delete VLM json data:', e);
    throw e;
  }
};

export interface VlmAssignSourceFileInfo {
  sourceFile: string;
  total: number;
  unassigned: number;
}

export const getVlmAssignSourceFiles = async (projectId: string): Promise<VlmAssignSourceFileInfo[]> => {
  const res = await fetch(apiUrl(`/api/plugins/vlm/assign/source-files?projectId=${encodeURIComponent(projectId)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return [];
  return Array.isArray(data?.sourceFiles) ? data.sourceFiles : [];
};

export const assignVlmTasks = async (payload: {
  workerName: string;
  count: number;
  projectId?: string;
  sourceFiles?: string[];
}): Promise<{ assigned: number; taskIds?: string[] }> => {
  const res = await fetch(apiUrl('/api/plugins/vlm/assign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string') ? data.error : res.statusText || 'Failed to assign VLM tasks';
    throw new Error(msg);
  }
  const taskIds = Array.isArray(data?.taskIds) ? data.taskIds : [];
  if (taskIds.length > 0) await mergeTasksByIds(taskIds);
  invalidateProjectOverviewCache();
  return data;
};

export const unassignVlmTasks = async (payload: {
  workerName: string;
  count: number;
  projectId?: string;
  sourceFiles?: string[];
}): Promise<{ unassigned: number }> => {
  const res = await fetch(apiUrl('/api/plugins/vlm/unassign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string') ? data.error : res.statusText || 'Failed to unassign VLM tasks';
    throw new Error(msg);
  }
  invalidateProjectOverviewCache();
  return data;
};

/** YOLO / 이미지 분류 — 프로젝트 폴더 매핑 기준 미배정 N건을 행 단위 배정 (VLM assign과 동일 패턴) */
export const assignNativeTasks = async (payload: {
  workerName: string;
  count: number;
  projectId: string;
}): Promise<{ assigned: number; taskIds?: string[]; hint?: string; assignDebug?: Record<string, unknown> }> => {
  const res = await fetch(apiUrl('/api/plugins/native/assign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data && typeof data.error === 'string' ? data.error : res.statusText || 'Failed to assign native tasks';
    throw new Error(msg);
  }
  const taskIds = Array.isArray(data?.taskIds) ? data.taskIds : [];
  if (taskIds.length > 0) await mergeTasksByIds(taskIds);
  invalidateProjectOverviewCache();
  return data;
};

/** 제출·승인 완료 건은 제외하고 배정만 해제 */
export const unassignNativeTasks = async (payload: {
  workerName: string;
  count: number;
  projectId: string;
}): Promise<{ unassigned: number; taskIds?: string[] }> => {
  const res = await fetch(apiUrl('/api/plugins/native/unassign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data && typeof data.error === 'string' ? data.error : res.statusText || 'Failed to unassign native tasks';
    throw new Error(msg);
  }
  const taskIds = Array.isArray(data?.taskIds) ? data.taskIds : [];
  if (taskIds.length > 0) await mergeTasksByIds(taskIds);
  invalidateProjectOverviewCache();
  return data;
};

export const listVlmExportJsonFiles = async (): Promise<VlmExportJsonFileInfo[]> => {
  try {
    const res = await fetch(apiUrl('/api/plugins/vlm/export-json/files'));
    if (!res.ok) throw new Error('Failed to fetch VLM export files');
    const payload = await res.json();
    return Array.isArray(payload?.files) ? payload.files : [];
  } catch (e) {
    console.error('Failed to fetch VLM export files:', e);
    return [];
  }
};

export const exportVlmJsonData = async (payload: { sourceFiles: string[]; onlySubmitted?: boolean; includeResult?: boolean }): Promise<VlmExportJsonResult> => {
  try {
    const res = await fetch(apiUrl('/api/plugins/vlm/export-json'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg =
        typeof data?.error === 'string' && data.error.trim()
          ? data.error
          : res.statusText || 'Failed to export VLM json data';
      throw new Error(msg);
    }
    return data as unknown as VlmExportJsonResult;
  } catch (e) {
    console.error('Failed to export VLM json data:', e);
    throw e;
  }
};

export const downloadFullDataset = async () => {
  const zip = new JSZip();
  const tasks = getTasks();

  tasks.forEach(task => {
    if (task.annotations.length > 0) {
      const txtContent = generateYoloTxt(task.annotations);
      const baseName = task.name.substring(0, task.name.lastIndexOf('.'));
      zip.file(`${task.folder}/${baseName}.txt`, txtContent);
    }
  });

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `yolo_dataset_export_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  window.URL.revokeObjectURL(url);
};
