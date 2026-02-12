import { Task, TaskStatus, WorkLog, UserRole, BoundingBox, TaskIssue, TaskIssueReasonCode, TaskIssueStatus, TaskIssueType, VacationRecord } from '../types';
import JSZip from 'jszip';
import localforage from 'localforage';

const TASKS_KEY = 'yolo_tasks';
const LOGS_KEY = 'yolo_logs';
const FOLDER_META_KEY = 'yolo_folder_meta';
const INITIAL_TASK_FETCH_LIMIT = 5000;
const TASK_PERSIST_DEBOUNCE_MS = 250;
const LOG_PULL_MIN_INTERVAL_MS = 15000;

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
let cachedLogs: WorkLog[] = [];
let cachedFolderMeta: Record<string, any> = {};
let isInitialized = false;
let pendingTaskPersistMap = new Map<string, any>();
let taskPersistTimer: ReturnType<typeof setTimeout> | null = null;
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

const toStorableTask = (task: Task) => {
  const { annotations, ...taskWithoutAnnotations } = task;
  return taskWithoutAnnotations;
};

const flushPendingTaskPersist = async () => {
  if (pendingTaskPersistMap.size === 0) return;

  const pendingUpdates = pendingTaskPersistMap;
  pendingTaskPersistMap = new Map();

  try {
    const storedTasks = await localforage.getItem<any[]>(TASKS_KEY) || [];
    const storedMap = new Map(storedTasks.map(t => [t.id, t]));
    pendingUpdates.forEach((value, key) => storedMap.set(key, value));
    await localforage.setItem(TASKS_KEY, Array.from(storedMap.values()));
  } catch (error) {
    console.error("Failed to persist local tasks:", error);
  }
};

const queueTaskPersist = (task: Task): void => {
  pendingTaskPersistMap.set(task.id, toStorableTask(task));
  if (taskPersistTimer) clearTimeout(taskPersistTimer);
  taskPersistTimer = setTimeout(async () => {
    taskPersistTimer = null;
    await flushPendingTaskPersist();
  }, TASK_PERSIST_DEBOUNCE_MS);
};

const persistCachedTasks = async () => {
  await localforage.setItem(TASKS_KEY, cachedTasks.map(toStorableTask));
};

const getTaskCommitSignature = (task: Task): string => {
  return JSON.stringify({
    id: task.id,
    status: task.status,
    isModified: task.isModified === true,
    assignedWorker: task.assignedWorker || '',
    reviewerNotes: task.reviewerNotes || '',
    lastUpdated: task.lastUpdated || 0,
    txtPath: task.txtPath || ''
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
  const tasks = localStorage.getItem(TASKS_KEY);
  const logs = localStorage.getItem(LOGS_KEY);
  const meta = localStorage.getItem(FOLDER_META_KEY);

  if (tasks) await localforage.setItem(TASKS_KEY, JSON.parse(tasks));
  if (logs) await localforage.setItem(LOGS_KEY, JSON.parse(logs));
  if (meta) await localforage.setItem(FOLDER_META_KEY, JSON.parse(meta));

  if (tasks || logs || meta) {
    console.log("Migration from localStorage to IndexedDB complete.");
    // We don't clear immediately to be safe, but we could.
    // localStorage.clear(); 
  }
};

// 1. Initialize: Fetch first page of data from server
export const initStorage = async () => {
  try {
    // Initial fetch: first page only (additional pages can be loaded on demand)
    const res = await fetch(`/api/datasets?limit=${INITIAL_TASK_FETCH_LIMIT}&offset=0`);
    if (!res.ok) throw new Error('Failed to fetch datasets');
    const files = await res.json();

    // Try to get from localforage first
    let storedTasks = await localforage.getItem<any[]>(TASKS_KEY);

    // If empty, try migration
    if (!storedTasks) {
      await migrateFromLocalStorage();
      storedTasks = await localforage.getItem<any[]>(TASKS_KEY);
    }

    const existingTasks: any[] = storedTasks || [];
    cachedLogs = await localforage.getItem<WorkLog[]>(LOGS_KEY) || [];
    cachedFolderMeta = await localforage.getItem<Record<string, any>>(FOLDER_META_KEY) || {};

    // Keep previously cached items, then merge first page for fast startup.
    const taskMap = new Map(existingTasks.map(t => [t.id, { ...t, annotations: t.annotations || [] }]));
    files.forEach((f: any) => {
      const existing = taskMap.get(f.id);
      taskMap.set(f.id, normalizeServerTask(f, existing));
    });
    cachedTasks = Array.from(taskMap.values()) as Task[];
    await persistCachedTasks();
    refreshCommittedTaskSignatures();

    // Sync Logs
    await syncLogs();

    isInitialized = true;
  } catch (e) {
    console.error("Storage Init Failed:", e);
  }
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
        const res = await fetch('/api/logs', {
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

      const res = await fetch(`/api/logs?since=${maxTimestamp}`);
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

    const res = await fetch(`/api/analytics/daily?date=${dateStr}`);
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

  const res = await fetch(`/api/analytics/range?start=${startStr}&end=${endStr}`);
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

/**
 * Fetch Overall Project Summary from Server
 */
export const getProjectSummary = async () => {
  try {
    const res = await fetch('/api/analytics/summary');
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
export const loadMoreTasks = async (offset: number, limit: number = 5000) => {
  try {
    const res = await fetch(`/api/datasets?limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error('Failed to fetch more datasets');
    const files = await res.json();

    const existingIds = new Set(cachedTasks.map(t => t.id));
    const newTasks = files.filter((f: any) => !existingIds.has(f.id)).map((f: any) => normalizeServerTask(f));

    cachedTasks = [...cachedTasks, ...newTasks];
    await persistCachedTasks();
    newTasks.forEach(task => markTaskAsCommitted(task as Task));
    return newTasks;
  } catch (e) {
    console.error("Load More Failed:", e);
    return [];
  }
};

export const syncAllTaskPages = async (limit: number = INITIAL_TASK_FETCH_LIMIT) => {
  try {
    const baseMap = new Map(cachedTasks.map(t => [t.id, t]));
    const seenIds = new Set<string>();
    let offset = 0;

    while (true) {
      const res = await fetch(`/api/datasets?limit=${limit}&offset=${offset}`);
      if (!res.ok) throw new Error('Failed to fetch datasets');
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      batch.forEach((f: any) => {
        seenIds.add(f.id);
        const existing = baseMap.get(f.id);
        baseMap.set(f.id, normalizeServerTask(f, existing));
      });

      offset += batch.length;
      if (batch.length < limit) break;
    }

    // Full sync path: remove tasks that no longer exist on server.
    const merged = Array.from(baseMap.values()).filter((task: Task) => seenIds.has(task.id));
    cachedTasks = merged;
    await persistCachedTasks();
    refreshCommittedTaskSignatures();
    return cachedTasks.length;
  } catch (e) {
    console.error("Full task sync failed:", e);
    return cachedTasks.length;
  }
};

export const getTasks = (): Task[] => {
  return cachedTasks;
};

export const getTaskById = async (id: string): Promise<Task | undefined> => {
  const task = cachedTasks.find(t => t.id === id);
  if (!task) return undefined;

  // If annotations are still empty, try to load from labels
  if ((!task.annotations || task.annotations.length === 0) && task.txtPath) {
    try {
      const res = await fetch(`/api/label?path=${encodeURIComponent(task.txtPath)}`);
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

const updateTaskInCache = async (task: Task) => {
  const index = cachedTasks.findIndex(t => t.id === task.id);
  if (index !== -1) {
    cachedTasks[index] = task;
    queueTaskPersist(task);
  }
}

/**
 * Updates task in memory and IndexedDB only.
 * Sets isDirty flag to true for manual modifications.
 */
export const updateTaskLocally = async (taskId: string, updates: Partial<Task>): Promise<Task> => {
  const task = cachedTasks.find(t => t.id === taskId);
  if (!task) throw new Error('Task not found');

  const updatedTask = {
    ...task,
    ...updates,
    isModified: updates.annotations ? true : (updates.isModified ?? task.isModified),
    lastUpdated: Date.now()
  };

  await updateTaskInCache(updatedTask);
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
    const shouldPersistLabel = task.isModified || task.status === TaskStatus.SUBMITTED;
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

    const res = await fetch('/api/task-commit', {
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
            lastUpdated: task.lastUpdated
          }
        }
      })
    });
    if (!res.ok) throw new Error('Failed task commit');
    markTaskAsCommitted(task);
  } catch (e) {
    console.error("Failed to sync task commit", e);
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

  // Update IndexedDB WITHOUT annotations
  const storedTasks = await localforage.getItem<any[]>(TASKS_KEY);
  if (storedTasks) {
    const updatedTasks = storedTasks.map(t => {
      if (t.folder === folderName) {
        return { ...t, assignedWorker: workerName, lastUpdated: timestamp };
      }
      return t;
    });
    await localforage.setItem(TASKS_KEY, updatedTasks);
  }

  // 2. Persist to Server (Physical Move)
  try {
    await fetch('/api/assign-worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderName,
        workerName: workerName || 'Unassigned'
      })
    });

    await fetch('/api/folder-metadata', {
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
  let stats = undefined;
  if (task && (action === 'SUBMIT' || action === 'APPROVE' || action === 'SAVE')) {
    stats = {
      totalBoxCount: task.annotations.length,
      manualBoxCount: task.annotations.filter(a => !a.isAutoLabel).length
    };
  }

  const newLog: WorkLog = {
    id: Math.random().toString(36).substr(2, 9),
    taskId,
    userId: userId.trim(),
    role,
    folder: task?.folder || 'Unknown',
    action,
    timestamp: Date.now(),
    durationSeconds,
    isModified: isModifiedOverride !== undefined ? isModifiedOverride : task?.isModified,
    stats
  };

  cachedLogs.push(newLog);
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
    await fetch('/api/folder-metadata', {
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
    const res = await fetch('/api/convert-folder', {
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

    const res = await fetch('/api/issues', {
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
    return await res.json();
  } catch (e) {
    console.error("Failed to create task issue:", e);
    throw e;
  }
};

export const getOpenIssueCount = async (): Promise<number> => {
  try {
    const res = await fetch('/api/issues/count');
    if (!res.ok) throw new Error('Failed to fetch open issue count');
    const data = await res.json();
    return Number(data?.openCount || 0);
  } catch (e) {
    console.error("Failed to fetch open issue count:", e);
    return 0;
  }
};

export const getTaskIssues = async (status?: TaskIssueStatus): Promise<TaskIssue[]> => {
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetch(`/api/issues${query}`);
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
    const res = await fetch('/api/issues/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status, resolvedBy, resolutionNote })
    });
    if (!res.ok) throw new Error('Failed to update issue status');
    return await res.json();
  } catch (e) {
    console.error("Failed to update task issue status:", e);
    throw e;
  }
};

export const getVacations = async (startDate: string, endDate: string): Promise<VacationRecord[]> => {
  try {
    const query = `?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const res = await fetch(`/api/vacations${query}`);
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
    const res = await fetch('/api/vacations', {
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
    const res = await fetch(`/api/vacations?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
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
    const res = await fetch(`/api/schedule/board${query}`);
    if (!res.ok) throw new Error('Failed to fetch schedule board');
    return await res.json();
  } catch (e) {
    console.error("Failed to fetch schedule board:", e);
    return {};
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
