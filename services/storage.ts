import { Task, TaskStatus, WorkLog, UserRole, BoundingBox } from '../types';
import JSZip from 'jszip';

const TASKS_KEY = 'yolo_tasks';
const LOGS_KEY = 'yolo_logs';

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
        isAutoLabel: false
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

// In-memory cache for tasks to avoid constant re-fetching of list
let cachedTasks: Task[] = [];
let isInitialized = false;

// 1. Initialize: Fetch file list from server
export const initStorage = async () => {
  try {
    const res = await fetch('/api/datasets');
    if (!res.ok) throw new Error('Failed to fetch datasets');
    const files = await res.json();

    // Merge with any local storage overrides (e.g. status) if needed, 
    // but for now, we prioritize file system truth for existence.
    // We can still use localStorage for 'status' management if we want to track 'DONE' state 
    // separate from file existence, but here we will try to be simple.

    const stored = localStorage.getItem(TASKS_KEY);
    const existingTasks: Task[] = stored ? JSON.parse(stored) : [];

    cachedTasks = files.map((f: any) => {
      const existing = existingTasks.find(t => t.name === f.name && t.folder === f.folder);

      // If we have a txtPath, it means a file potentially exists.
      // We don't read the content yet (lazy load).

      return {
        id: existing?.id || Math.random().toString(36).substr(2, 9),
        imageUrl: f.imageUrl,
        name: f.name,
        folder: f.folder,
        txtPath: f.txtPath, // Path to save to/read from
        // If existing status is something meaningful, keep it. 
        // Else, if persistence file exists, it's Draft/In Progress.
        // Server-side metadata takes precedence for persistence
        status: f.status || existing?.status || (f.txtPath ? TaskStatus.IN_PROGRESS : TaskStatus.TODO),
        annotations: existing?.annotations || [], // Will be loaded on demand
        lastUpdated: f.lastUpdated || existing?.lastUpdated || Date.now(),
        assignedWorker: f.assignedWorker || existing?.assignedWorker,
        reviewerNotes: f.reviewerNotes || existing?.reviewerNotes,
        isModified: f.isModified || existing?.isModified
      };
    });

    isInitialized = true;

    // Sync back to local storage for metadata that isn't in files (like status, assignedWorker)
    localStorage.setItem(TASKS_KEY, JSON.stringify(cachedTasks));

  } catch (e) {
    console.error("Storage Init Failed:", e);
  }
};


export const getTasks = (): Task[] => {
  if (!isInitialized) {
    // Return local storage backup if init hasn't finished (shouldn't happen often)
    const data = localStorage.getItem(TASKS_KEY);
    return data ? JSON.parse(data) : [];
  }
  return cachedTasks;
};

export const getTaskById = async (id: string): Promise<Task | undefined> => {
  const task = cachedTasks.find(t => t.id === id);
  if (!task) return undefined;

  // Lazy Load Annotations from File if needed
  if ((!task.annotations || task.annotations.length === 0) && task.txtPath) {
    try {
      // Construct path to potential txt file if we knew it, 
      // For now, we rely on the scanned 'txtPath' property.

      if (task.txtPath) {
        const res = await fetch(`/api/label?path=${encodeURIComponent(task.txtPath)}`);
        const text = await res.text();
        if (text) {
          task.annotations = parseYoloTxt(text);
          // Update cache
          updateTaskInCache(task);
        }
      }
    } catch (e) {
      console.error("Failed to load labels for task", task.id, e);
    }
  }
  return task;
};

const updateTaskInCache = (task: Task) => {
  const index = cachedTasks.findIndex(t => t.id === task.id);
  if (index !== -1) {
    cachedTasks[index] = task;
    localStorage.setItem(TASKS_KEY, JSON.stringify(cachedTasks));
  }
}

export const updateTask = async (taskId: string, updates: Partial<Task>, userId: string, role: UserRole): Promise<Task> => {
  const task = cachedTasks.find(t => t.id === taskId);
  if (!task) throw new Error('Task not found');

  const updatedTask = { ...task, ...updates, lastUpdated: Date.now() };

  // 1. Update In-Memory & LocalStorage (for fast UI)
  updateTaskInCache(updatedTask);

  // 2. Persist to Disk if annotations changed or status submitted
  if (updates.annotations || updates.status === TaskStatus.SUBMITTED) {
    if (!updatedTask.txtPath) {
      // We need to determine the save path if it wasn't scanned initially.
      // It should be adjacent to the image.
      // Since we don't have the absolute path easily for new files, 
      // we can rely on the server to handle this if we send the image path?
      // OR: We know the structure is datasets/[folder]/[image].
      // The API list gave us 'txtPath' if it existed.
      // If it didn't exist, we must construct it.

      // Hack: Construct relative txt path based on image url
      // imageUrl: /datasets/folder/image.jpg
      // expected txt: datasets/folder/image.txt
      // The imageUrl in vite starts with /, so remove it

      let relativeTxtPath = updatedTask.imageUrl.startsWith('/') ? updatedTask.imageUrl.substring(1) : updatedTask.imageUrl;
      relativeTxtPath = relativeTxtPath.substring(0, relativeTxtPath.lastIndexOf('.')) + '.txt';
      updatedTask.txtPath = relativeTxtPath;
    }

    const content = generateYoloTxt(updatedTask.annotations);

    try {
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: updatedTask.txtPath,
          content: content
        })
      });
    } catch (e) {
      console.error("Failed to save to disk", e);
      alert("Failed to save to disk! Check console.");
    }
  }


  // 3. Persist Metadata (status, isModified, assignedWorker, reviewerNotes)
  // We save this to _metadata.json via /api/metadata
  if (updates.status || updates.isModified !== undefined || updates.assignedWorker !== undefined || updates.reviewerNotes !== undefined) {
    try {
      // Construct key relative to datasets root: folder/filename
      const folderPart = updatedTask.folder === 'Unsorted' ? '' : updatedTask.folder;
      const key = folderPart ? `${folderPart}/${updatedTask.name}` : updatedTask.name;

      await fetch('/api/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          updates: {
            status: updatedTask.status,
            isModified: updatedTask.isModified,
            assignedWorker: updatedTask.assignedWorker,
            reviewerNotes: updatedTask.reviewerNotes,
            lastUpdated: updatedTask.lastUpdated
          }
        })
      });
    } catch (e) {
      console.error("Failed to save metadata", e);
    }
  }

  return updatedTask;
};

export const assignFolderToWorker = (folderName: string, workerName: string | undefined) => {
  cachedTasks = cachedTasks.map(t => {
    if (t.folder === folderName) {
      return { ...t, assignedWorker: workerName, lastUpdated: Date.now() };
    }
    return t;
  });
  localStorage.setItem(TASKS_KEY, JSON.stringify(cachedTasks));
};

export const logAction = (
  taskId: string,
  userId: string,
  role: UserRole,
  action: WorkLog['action'],
  durationSeconds: number = 0
) => {
  const logs: WorkLog[] = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');

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
    userId,
    role,
    folder: task?.folder || 'Unknown',
    action,
    timestamp: Date.now(),
    durationSeconds,
    isModified: task?.isModified,
    stats
  };
  logs.push(newLog);
  localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
};

export const getLogs = (): WorkLog[] => {
  return JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
};

export const getFolderMetadata = (folderName: string): any => {
  const allMeta = JSON.parse(localStorage.getItem('yolo_folder_meta') || '{}');
  return allMeta[folderName] || { tags: [], memo: '' };
};

export const saveFolderMetadata = (folderName: string, meta: any) => {
  const allMeta = JSON.parse(localStorage.getItem('yolo_folder_meta') || '{}');
  allMeta[folderName] = meta;
  localStorage.setItem('yolo_folder_meta', JSON.stringify(allMeta));
};

export const downloadFullDataset = async () => {
  const zip = new JSZip();
  const tasks = getTasks();

  // 1. Add Annotations (.txt) organized by folder
  // Note: Since we are now saving to disk, downloading zip might just serve the files.
  // But for convenience of "Export", we still zip them up from memory/cache or fetch them.
  // Here we use the latest memory state (which should match disk).

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