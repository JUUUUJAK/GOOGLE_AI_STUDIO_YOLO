import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { buildTasksUnderMappedRootsWhereSqlite } from './server/classificationExportTaskWhere.ts';
import { resolveProjectIdForAnalyticsFolder } from './services/projectMapResolve.ts';

/**
 * Vite가 vite.config 번들 시 ./services/*.ts 를 해석하지 못하는 경우가 있어,
 * 서버(config) 전용 복사본을 둡니다. (클라이언트는 services/projectMapResolve.ts 등 사용)
 */
function resolveProjectMapEntryForFolder(
  folderName: string,
  projectMap: Record<string, { projectId: string; updatedAt: number }>
): ({ projectId: string; updatedAt: number } & { mappedKey: string }) | null {
  const normalized = String(folderName || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalized || normalized === 'Unsorted') return null;
  let current = normalized;
  for (;;) {
    const mapping = projectMap[current];
    if (mapping?.projectId) return { ...mapping, mappedKey: current };
    const slash = current.lastIndexOf('/');
    if (slash < 0) break;
    current = current.slice(0, slash);
  }
  return null;
}

function resolveWorkerFolderMapEntryForFolder(
  folderName: string,
  workerFolderMap: Record<string, { workerName: string; updatedAt: number }>
): ({ workerName: string; updatedAt: number } & { mappedKey: string }) | null {
  const normalized = String(folderName || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalized || normalized === 'Unsorted') return null;
  let current = normalized;
  for (;;) {
    const mapping = workerFolderMap[current];
    const w = mapping?.workerName != null ? String(mapping.workerName).trim() : '';
    if (w && w.toLowerCase() !== 'unassigned') {
      return { ...mapping, workerName: w, mappedKey: current };
    }
    const slash = current.lastIndexOf('/');
    if (slash < 0) break;
    current = current.slice(0, slash);
  }
  return null;
}

// --- Database Setup ---
const dbPath = path.resolve(__dirname, 'datasets.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
const analyticsCache = new Map<string, { expiresAt: number; data: any[] }>();
const ANALYTICS_CACHE_TTL_MS = 15000;

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    txtPath TEXT,
    assignedWorker TEXT,
    status TEXT DEFAULT 'TODO',
    reviewerNotes TEXT DEFAULT '',
    isModified INTEGER DEFAULT 0,
    lastUpdated INTEGER,
    sourceType TEXT DEFAULT 'native-yolo',
    sourceRefId TEXT,
    sourceFile TEXT,
    sourceData TEXT,
    UNIQUE(imageUrl)
  );
  
  CREATE TABLE IF NOT EXISTS folder_metadata (
    folder TEXT PRIMARY KEY,
    assignedWorker TEXT,
    tags TEXT,
    memo TEXT,
    lastUpdated INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_folder ON tasks(folder);

  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    taskId TEXT,
    userId TEXT,
    role TEXT,
    folder TEXT,
    action TEXT,
    timestamp INTEGER,
    durationSeconds REAL,
    isModified INTEGER,
    stats TEXT,
    sourceType TEXT DEFAULT 'native-yolo'
  );
  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(userId);

  CREATE TABLE IF NOT EXISTS vlm_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    txtPath TEXT,
    assignedWorker TEXT,
    status TEXT DEFAULT 'TODO',
    reviewerNotes TEXT DEFAULT '',
    isModified INTEGER DEFAULT 0,
    lastUpdated INTEGER,
    sourceType TEXT DEFAULT 'vlm-review',
    sourceRefId TEXT,
    sourceFile TEXT,
    sourceData TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vlm_tasks_folder ON vlm_tasks(folder);
  CREATE INDEX IF NOT EXISTS idx_vlm_tasks_status ON vlm_tasks(status);
`);

// --- Database Initialization and Migrations ---
const initDatabase = () => {
  db.transaction(() => {
    // VLM tasks unique constraint migration (one-time)
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vlm_tasks'").get() as { sql?: string } | undefined;
    if (info?.sql && String(info.sql).includes('UNIQUE(imageUrl)')) {
      console.log('Migrating vlm_tasks to remove UNIQUE(imageUrl) constraint...');
      db.exec(`
        CREATE TABLE vlm_tasks_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          imageUrl TEXT NOT NULL,
          txtPath TEXT,
          assignedWorker TEXT,
          status TEXT DEFAULT 'TODO',
          reviewerNotes TEXT DEFAULT '',
          isModified INTEGER DEFAULT 0,
          lastUpdated INTEGER,
          sourceType TEXT DEFAULT 'vlm-review',
          sourceRefId TEXT,
          sourceFile TEXT,
          sourceData TEXT
        );
        INSERT INTO vlm_tasks_new SELECT id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated, sourceType, sourceRefId, sourceFile, sourceData FROM vlm_tasks;
        DROP TABLE vlm_tasks;
        ALTER TABLE vlm_tasks_new RENAME TO vlm_tasks;
        CREATE INDEX IF NOT EXISTS idx_vlm_tasks_folder ON vlm_tasks(folder);
        CREATE INDEX IF NOT EXISTS idx_vlm_tasks_status ON vlm_tasks(status);
      `);
    }
  })();
};
initDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS vlm_logs (
    id TEXT PRIMARY KEY,
    taskId TEXT,
    userId TEXT,
    role TEXT,
    folder TEXT,
    action TEXT,
    timestamp INTEGER,
    durationSeconds REAL,
    isModified INTEGER,
    stats TEXT,
    sourceType TEXT DEFAULT 'vlm-review'
  );
  CREATE INDEX IF NOT EXISTS idx_vlm_logs_timestamp ON vlm_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_vlm_logs_user ON vlm_logs(userId);

  CREATE TABLE IF NOT EXISTS task_issues (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    folder TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    type TEXT NOT NULL,
    reasonCode TEXT NOT NULL,
    comment TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'OPEN',
    createdBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    resolvedBy TEXT,
    resolvedAt INTEGER,
    resolutionNote TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_issues_status_createdAt ON task_issues(status, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_task_issues_taskId ON task_issues(taskId);

  CREATE TABLE IF NOT EXISTS vacations (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    startDate TEXT NOT NULL,
    endDate TEXT NOT NULL,
    days REAL NOT NULL DEFAULT 1,
    note TEXT DEFAULT '',
    createdAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deleted_tasks (
    id TEXT PRIMARY KEY,
    sourceType TEXT,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deleted_tasks_timestamp ON deleted_tasks(timestamp);

  CREATE INDEX IF NOT EXISTS idx_tasks_pagination ON tasks(lastUpdated DESC, id ASC);
  CREATE INDEX IF NOT EXISTS idx_vlm_tasks_pagination ON vlm_tasks(lastUpdated DESC, id ASC);
 `);
try { db.prepare(`ALTER TABLE tasks ADD COLUMN sourceType TEXT DEFAULT 'native-yolo'`).run(); } catch (_e) { }
try { db.prepare(`ALTER TABLE tasks ADD COLUMN sourceRefId TEXT`).run(); } catch (_e) { }
try { db.prepare(`ALTER TABLE tasks ADD COLUMN sourceFile TEXT`).run(); } catch (_e) { }
try { db.prepare(`ALTER TABLE tasks ADD COLUMN sourceData TEXT`).run(); } catch (_e) { }
try { db.prepare(`ALTER TABLE logs ADD COLUMN sourceType TEXT DEFAULT 'native-yolo'`).run(); } catch (_e) { }
db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_sourceType ON tasks(sourceType)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_logs_sourceType_ts ON logs(sourceType, timestamp)`).run();
db.prepare(`UPDATE task_issues SET status = 'DELETE' WHERE status = 'APPROVED'`).run();
db.prepare(`UPDATE task_issues SET status = 'RESOLVED' WHERE status = 'REJECTED'`).run();

// Incremental VLM migration logic to avoid scanning huge tables on every restart
const runVlmMigration = () => {
  const tasksToMoveCount = (db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE sourceType = 'vlm-review' OR id LIKE 'vlm:%'`).get() as any).count;
  if (tasksToMoveCount > 0) {
    console.log(`Moving ${tasksToMoveCount} VLM tasks to vlm_tasks...`);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO vlm_tasks (
          id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated,
          sourceType, sourceRefId, sourceFile, sourceData
        )
        SELECT
          id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated,
          COALESCE(sourceType, 'vlm-review'), sourceRefId, sourceFile, sourceData
        FROM tasks
        WHERE COALESCE(sourceType, '') = 'vlm-review' OR id LIKE 'vlm:%'
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          folder = excluded.folder,
          imageUrl = excluded.imageUrl,
          txtPath = excluded.txtPath,
          assignedWorker = excluded.assignedWorker,
          status = excluded.status,
          reviewerNotes = excluded.reviewerNotes,
          isModified = excluded.isModified,
          lastUpdated = excluded.lastUpdated,
          sourceType = excluded.sourceType,
          sourceRefId = excluded.sourceRefId,
          sourceFile = excluded.sourceFile,
          sourceData = excluded.sourceData
      `).run();
      db.prepare(`
        DELETE FROM tasks
        WHERE COALESCE(sourceType, '') = 'vlm-review' OR id LIKE 'vlm:%'
      `).run();
    })();
  }

  const logsToMoveCount = (db.prepare(`SELECT COUNT(*) as count FROM logs WHERE sourceType = 'vlm-review' OR taskId LIKE 'vlm:%'`).get() as any).count;
  if (logsToMoveCount > 0) {
    console.log(`Moving ${logsToMoveCount} VLM logs to vlm_logs...`);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO vlm_logs (
          id, taskId, userId, role, folder, action, timestamp, durationSeconds, isModified, stats, sourceType
        )
        SELECT
          id, taskId, userId, role, folder, action, timestamp, durationSeconds, isModified, stats,
          COALESCE(sourceType, 'vlm-review')
        FROM logs
        WHERE COALESCE(sourceType, '') = 'vlm-review' OR taskId LIKE 'vlm:%'
        ON CONFLICT(id) DO UPDATE SET
          taskId = excluded.taskId,
          userId = excluded.userId,
          role = excluded.role,
          folder = excluded.folder,
          action = excluded.action,
          timestamp = excluded.timestamp,
          durationSeconds = excluded.durationSeconds,
          isModified = excluded.isModified,
          stats = excluded.stats,
          sourceType = excluded.sourceType
      `).run();
      db.prepare(`
        DELETE FROM logs
        WHERE COALESCE(sourceType, '') = 'vlm-review' OR taskId LIKE 'vlm:%'
      `).run();
    })();
  }
};
runVlmMigration();

const updateTaskMetadataStmt = db.prepare(`
  UPDATE tasks SET
    status = COALESCE(?, status),
    isModified = COALESCE(?, isModified),
    assignedWorker = COALESCE(?, assignedWorker),
    reviewerNotes = COALESCE(?, reviewerNotes),
    sourceType = COALESCE(?, sourceType),
    sourceRefId = COALESCE(?, sourceRefId),
    sourceFile = COALESCE(?, sourceFile),
    sourceData = COALESCE(?, sourceData),
    lastUpdated = ?
  WHERE id = ? OR imageUrl = ? OR imageUrl = ?
`);
const updateVlmTaskMetadataStmt = db.prepare(`
  UPDATE vlm_tasks SET
    status = COALESCE(?, status),
    isModified = COALESCE(?, isModified),
    assignedWorker = COALESCE(?, assignedWorker),
    reviewerNotes = COALESCE(?, reviewerNotes),
    sourceType = COALESCE(?, sourceType),
    sourceRefId = COALESCE(?, sourceRefId),
    sourceFile = COALESCE(?, sourceFile),
    sourceData = COALESCE(?, sourceData),
    lastUpdated = ?
  WHERE id = ? OR imageUrl = ? OR imageUrl = ?
`);

const applyTaskMetadataUpdate = (item: any): number => {
  const { id, key, updates } = item;
  const imageUrl = key?.startsWith('/') ? key : (key ? '/datasets/' + key : null);
  const sid = String(id || '');
  const useVlmTable =
    String(updates?.sourceType || '').toLowerCase() === 'vlm-review' ||
    sid.startsWith('vlm:') ||
    sid.startsWith('vlm-json:');
  const table = useVlmTable ? 'vlm_tasks' : 'tasks';

  // Guard: If status is ISSUE_PENDING, don't allow changing it via this generic update API.
  // Locked tasks can only be resolved via /api/issues/resolve
  const currentStatus = db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id)?.status;
  if (currentStatus === 'ISSUE_PENDING' && updates?.status && updates.status !== 'ISSUE_PENDING') {
    console.log(`[Guard] Blocking status update for locked task ${id}: ${currentStatus} -> ${updates.status}`);
    updates.status = 'ISSUE_PENDING';
  }

  const stmt = useVlmTable ? updateVlmTaskMetadataStmt : updateTaskMetadataStmt;
  const result = stmt.run(
    updates?.status,
    updates?.isModified !== undefined ? (updates.isModified ? 1 : 0) : null,
    updates?.assignedWorker,
    updates?.reviewerNotes,
    updates?.sourceType,
    updates?.sourceRefId,
    updates?.sourceFile,
    updates?.sourceData,
    updates?.lastUpdated || Date.now(),
    id || null,
    imageUrl,
    key || null
  );
  return result.changes;
};

const getValidWorkerUsernames = (): string[] => {
  const usersPath = path.resolve(__dirname, 'users.json');
  let validWorkers: string[] = [];
  if (fs.existsSync(usersPath)) {
    try {
      validWorkers = JSON.parse(fs.readFileSync(usersPath, 'utf-8'))
        .filter(u => u.accountType === 'WORKER')
        .map(u => u.username);
    } catch (e) { }
  }
  return validWorkers;
};

const toNativeYoloFolderFromDatasetsRelativePath = (datasetsRelativePath: string, validWorkers: string[]): string => {
  const normalized = String(datasetsRelativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return 'Unsorted';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return 'Unsorted';

  const workerSet = new Set(validWorkers.map((name) => String(name || '').trim()).filter(Boolean));
  const startsWithWorker = parts.length > 1 && workerSet.has(parts[0]);
  const withoutWorker = startsWithWorker ? parts.slice(1) : parts;
  if (withoutWorker.length <= 1) return 'Unsorted';

  // folder = full relative folder path (excluding file name), preserving nested structure
  const folderParts = withoutWorker.slice(0, -1);
  return folderParts.length > 0 ? folderParts.join('/') : 'Unsorted';
};

const folderFromAbsoluteImagePath = (datasetsDir: string, filePath: string, validWorkers: string[]): string => {
  const rel = path.relative(datasetsDir, filePath).replace(/\\/g, '/');
  return toNativeYoloFolderFromDatasetsRelativePath(rel, validWorkers);
};

const normalizeWorkflowSourceTypeGlobal = (input: any): 'native-yolo' | 'vlm-review' | 'image-classification' => {
  const s = String(input || '').trim().toLowerCase();
  if (s === 'vlm-review') return 'vlm-review';
  if (s === 'image-classification') return 'image-classification';
  return 'native-yolo';
};

const resolveSourceTypeForFolderFromMaps = (
  folderName: string,
  projectMap: Record<string, { projectId: string; updatedAt: number }>,
  projects: Record<string, any>
): string => {
  const entry = resolveProjectMapEntryForFolder(folderName, projectMap);
  if (!entry) return 'native-yolo';
  const proj = projects[entry.projectId];
  if (!proj) return 'native-yolo';
  return normalizeWorkflowSourceTypeGlobal(proj.workflowSourceType);
};

/** 프로젝트 매핑 규칙 우선, 없으면 행의 sourceType */
const effectiveSourceTypeForTaskFolder = (
  folderName: string,
  rowSourceType: string | null | undefined,
  projectMap: Record<string, { projectId: string; updatedAt: number }>,
  projects: Record<string, any>
): 'native-yolo' | 'vlm-review' | 'image-classification' => {
  const entry = resolveProjectMapEntryForFolder(folderName, projectMap);
  if (entry?.projectId && projects[entry.projectId]) {
    return normalizeWorkflowSourceTypeGlobal(projects[entry.projectId].workflowSourceType);
  }
  return normalizeWorkflowSourceTypeGlobal(rowSourceType);
};

/** DB 행 assignedWorker 우선, 비어 있을 때만 _worker_folder_map */
const effectiveAssignedWorkerForTaskFolder = (
  folderName: string,
  rowAssigned: string | null | undefined,
  workerFolderMap: Record<string, { workerName: string; updatedAt: number }>
): string | null => {
  const r = rowAssigned != null ? String(rowAssigned).trim() : '';
  if (r && r.toLowerCase() !== 'unassigned') {
    return r;
  }
  const e = resolveWorkerFolderMapEntryForFolder(folderName, workerFolderMap);
  if (e?.workerName != null) {
    const w = String(e.workerName).trim();
    if (w && w.toLowerCase() !== 'unassigned') return w;
    return null;
  }
  return null;
};

const mergeWorkerFolderBreakdownFromDbRows = (
  rows: Record<string, unknown>[],
  workerFolderMap: Record<string, { workerName: string; updatedAt: number }>
): Array<{
  folder: string;
  assignedWorker: string;
  taskCount: number;
  completedCount: number;
  lastUpdated: number;
}> => {
  const out = new Map<
    string,
    { folder: string; assignedWorker: string; taskCount: number; completedCount: number; lastUpdated: number }
  >();
  for (const row of rows) {
    const folder = String(row.folder ?? '').trim();
    if (!folder) continue;
    const dbW = String(row.dbWorker ?? (row as { dbworker?: string }).dbworker ?? '').trim();
    const eff = effectiveAssignedWorkerForTaskFolder(folder, dbW || null, workerFolderMap) || '';
    const key = `${folder}\0${eff}`;
    const prev = out.get(key);
    const tc = Number(row.taskCount ?? 0);
    const cc = Number(row.completedCount ?? 0);
    const lu = Number(row.lastUpdated ?? 0);
    out.set(key, {
      folder,
      assignedWorker: eff,
      taskCount: (prev?.taskCount ?? 0) + tc,
      completedCount: (prev?.completedCount ?? 0) + cc,
      lastUpdated: Math.max(prev?.lastUpdated ?? 0, lu)
    });
  }
  return Array.from(out.values());
};

const escapeSqlLikePatternPrefix = (folder: string): string => {
  const n = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return n.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '/%';
};

const datasetsRelPathToImageUrlLikePrefix = (diskRelPath: string): string | null => {
  const norm = String(diskRelPath || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!norm) return null;
  const esc = norm.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return `/datasets/${esc}/%`;
};

const pushFolderSubtreeWhere = (whereArr: string[], whereParams: unknown[], folderFilter: string) => {
  const f = String(folderFilter || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!f) return;
  const likePat = escapeSqlLikePatternPrefix(f);
  const imgLike = datasetsRelPathToImageUrlLikePrefix(f);
  if (imgLike) {
    whereArr.push("(folder = ? OR folder LIKE ? ESCAPE '\\' OR imageUrl LIKE ? ESCAPE '\\')");
    whereParams.push(f, likePat, imgLike);
  } else {
    whereArr.push("(folder = ? OR folder LIKE ? ESCAPE '\\')");
    whereParams.push(f, likePat);
  }
};

/** Win32 MAX_PATH(~260) 초과 시 stat/read 실패 방지 — 확장 경로 \\?\ */
const toWin32LongFsPath = (absolutePath: string): string => {
  if (process.platform !== 'win32') return absolutePath;
  const resolved = path.resolve(absolutePath);
  if (resolved.startsWith('\\\\?\\')) return resolved;
  if (resolved.startsWith('\\\\')) {
    return '\\\\?\\UNC\\' + resolved.slice(2);
  }
  return '\\\\?\\' + resolved;
};

/** readdir 순서는 OS마다 다름. 스캔 시 폴더 먼저·이름 오름차순(숫자 인식) — YOLO_API_STUDIO readdirSortedForSync 와 동일 */
function readdirSortedForSync(dir: string): string[] {
  let list: string[];
  try {
    list = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries: Array<{ name: string; isDir: boolean }> = [];
  for (const name of list) {
    const fp = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      continue;
    }
    entries.push({ name, isDir: stat.isDirectory() });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return entries.map((e) => e.name);
}

const syncFilesToDb = (datasetsDir: string, options?: { includePaths?: string[] }) => {
  const validWorkers = getValidWorkerUsernames();
  const includePaths = options?.includePaths?.filter((p) => String(p || '').trim()) ?? [];
  const isPartialSync = includePaths.length > 0;

  // 프로젝트 매핑 반영: 폴더가 이미지 분류 프로젝트에 매핑되어 있으면 sync 시에도 sourceType 유지
  let projectMap: Record<string, { projectId: string; updatedAt: number }> = {};
  let projects: Record<string, any> = {};
  try {
    const projectMapPath = path.resolve(datasetsDir, '_project_map.json');
    const projectsPath = path.resolve(datasetsDir, '_projects.json');
    if (fs.existsSync(projectMapPath)) projectMap = JSON.parse(fs.readFileSync(projectMapPath, 'utf-8'));
    if (fs.existsSync(projectsPath)) projects = JSON.parse(fs.readFileSync(projectsPath, 'utf-8'));
  } catch (_) {}
  let workerFolderMap: Record<string, { workerName: string; updatedAt: number }> = {};
  try {
    const workerMapPath = path.join(datasetsDir, '_worker_folder_map.json');
    if (fs.existsSync(workerMapPath)) {
      const raw = JSON.parse(fs.readFileSync(workerMapPath, 'utf-8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) workerFolderMap = raw;
    }
  } catch (_) {}
  const assignedWorkerFromMap = (folderName: string): string | null => {
    const e = resolveWorkerFolderMapEntryForFolder(folderName, workerFolderMap);
    return e?.workerName || null;
  };

  // Load existing metadata to prevent overwriting
  const metadataPath = path.join(datasetsDir, '_metadata.json');
  let legacyMetadata = {};
  if (fs.existsSync(metadataPath)) {
    try { legacyMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); } catch (e) { }
  }

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated, sourceType)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(imageUrl) DO UPDATE SET
      txtPath = excluded.txtPath,
      folder = excluded.folder,
      sourceType = excluded.sourceType
  `);

  db.exec('CREATE TEMPORARY TABLE IF NOT EXISTS temp_ids (id TEXT)');
  db.exec('DELETE FROM temp_ids'); // Clear for this scan
  const recordDeletions = db.prepare(`
    INSERT INTO deleted_tasks (id, sourceType, timestamp)
    SELECT id, COALESCE(sourceType, 'native-yolo'), ?
    FROM tasks
    WHERE id NOT IN (SELECT id FROM temp_ids)
      AND COALESCE(sourceType, 'native-yolo') = 'native-yolo'
  `);

  const deleteMissing = db.prepare(`
    DELETE FROM tasks
    WHERE id NOT IN (SELECT id FROM temp_ids)
      AND COALESCE(sourceType, 'native-yolo') = 'native-yolo'
  `);

  // Prepare statement to check for existing record
  const getExistingStatus = db.prepare('SELECT status, assignedWorker, sourceType FROM tasks WHERE id = ?');

  const scan = (dir: string) => {
    const list = readdirSortedForSync(dir);
    list.forEach(file => {
      if (file === '.cache') {
        return;
      }
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat && stat.isDirectory()) {
        scan(filePath);
      } else if (/\.(jpg|jpeg|png|webp|bmp)$/i.test(file)) {
        const ext = path.extname(file);
        const baseName = path.basename(file, ext);
        const txtPath = path.join(dir, baseName + '.txt');
        const relFromDatasets = path.relative(datasetsDir, filePath).replace(/\\/g, '/');
        const relativePath = 'datasets/' + relFromDatasets;
        const metaKey = relFromDatasets;
        const id = crypto.createHash('md5').update(relativePath).digest('hex');

        // Priority 1: Persistent SQLite status (Preserve worker submissions)
        // Priority 2: Legacy _metadata.json
        // Priority 3: Default 'TODO'
        const existing = getExistingStatus.get(id);
        const fileMeta = legacyMetadata[metaKey] || {};

        const folderName = folderFromAbsoluteImagePath(datasetsDir, filePath, validWorkers);

        db.prepare('INSERT INTO temp_ids (id) VALUES (?)').run(id);

        insertTask.run(
          id,
          file,
          folderName,
          '/' + relativePath,
          fs.existsSync(txtPath) ? path.relative(__dirname, txtPath).replace(/\\/g, '/') : null,
          assignedWorkerFromMap(folderName) ?? (existing?.assignedWorker || fileMeta.assignedWorker || null),
          existing?.status || fileMeta.status || 'TODO',
          fileMeta.reviewerNotes || '',
          fileMeta.isModified ? 1 : 0,
          fileMeta.lastUpdated || Date.now(),
          effectiveSourceTypeForTaskFolder(
            folderName,
            (existing as { sourceType?: string })?.sourceType || (fileMeta as { sourceType?: string }).sourceType,
            projectMap,
            projects
          )
        );
      }
    });
  };

  db.transaction(() => {
    if (isPartialSync) {
      includePaths.forEach((relPath) => {
        const fullPath = path.join(datasetsDir, relPath);
        if (fs.existsSync(fullPath)) scan(fullPath);
      });
    } else {
    scan(datasetsDir);
    }
    const now = Date.now();
    if (!isPartialSync) {
      recordDeletions.run(now);
    deleteMissing.run();
    }
  })();
  db.exec('DROP TABLE temp_ids');
};

// Middleware to handle file system operations
const fileSystemMiddleware = () => {
  const setupMiddlewares = (middlewares: any) => {
    const datasetsDir = path.resolve(__dirname, 'datasets');
    if (fs.existsSync(datasetsDir)) {
      // syncFilesToDb(datasetsDir); // Disabled automatic sync on startup for performance. Use manual sync in UI instead.
    }
    const projectsPath = path.resolve(datasetsDir, '_projects.json');
    const projectMapPath = path.resolve(datasetsDir, '_project_map.json');
    const workerFolderMapPath = path.resolve(datasetsDir, '_worker_folder_map.json');

    const ensureDatasetsDir = () => {
      if (!fs.existsSync(datasetsDir)) {
        fs.mkdirSync(datasetsDir, { recursive: true });
      }
    };

    const readJsonSafe = (targetPath: string, fallback: any) => {
      try {
        if (!fs.existsSync(targetPath)) return fallback;
        const raw = fs.readFileSync(targetPath, 'utf-8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    };

    const normalizeWorkflowSourceType = (input: any): 'native-yolo' | 'vlm-review' | 'image-classification' => {
      const s = String(input || '').trim().toLowerCase();
      if (s === 'vlm-review') return 'vlm-review';
      if (s === 'image-classification') return 'image-classification';
      return 'native-yolo';
    };

    const mergeUniqueTrimmedStrings = (values: string[]): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const v of values) {
        const s = String(v || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    };

    /** VLM 프로젝트에 연결된 원본 JSON 파일명 목록 (레거시 vlmSourceFile 1개 호환) */
    const projectVlmSourceFilesList = (project: any): string[] => {
      const fromArr = Array.isArray(project?.vlmSourceFiles)
        ? mergeUniqueTrimmedStrings(project.vlmSourceFiles.map((v: any) => String(v || '')))
        : [];
      if (fromArr.length > 0) return fromArr;
      const single = project?.vlmSourceFile ? String(project.vlmSourceFile).trim() : '';
      return single ? [single] : [];
    };

    const readProjects = (): Record<string, any> => {
      const data = readJsonSafe(projectsPath, {});
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const normalized: Record<string, any> = {};
        Object.entries(data).forEach(([key, row]: any) => {
          const wf = normalizeWorkflowSourceType(row?.workflowSourceType);
          const rawArr = Array.isArray(row?.vlmSourceFiles)
            ? mergeUniqueTrimmedStrings(row.vlmSourceFiles.map((v: any) => String(v || '')))
            : [];
          const singleLegacy = row?.vlmSourceFile ? String(row.vlmSourceFile).trim() : '';
          const vlmFiles =
            rawArr.length > 0 ? rawArr : singleLegacy ? [singleLegacy] : [];
          normalized[key] = {
            ...row,
            workflowSourceType: wf,
            vlmSourceFiles: vlmFiles.length > 0 ? vlmFiles : undefined,
            vlmSourceFile: vlmFiles.length > 0 ? vlmFiles[0] : undefined,
            classificationClasses: Array.isArray(row?.classificationClasses) ? row.classificationClasses : undefined,
            visibleToWorkers: row?.visibleToWorkers === undefined ? true : Boolean(row?.visibleToWorkers),
            status: String(row?.status || '').toUpperCase() === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE'
          };
        });
        return normalized;
      }
      return {};
    };

    const readProjectMap = (): Record<string, { projectId: string; updatedAt: number }> => {
      const data = readJsonSafe(projectMapPath, {});
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
      return {};
    };

    const writeProjects = (projects: Record<string, any>) => {
      ensureDatasetsDir();
      fs.writeFileSync(projectsPath, JSON.stringify(projects, null, 2), 'utf-8');
    };

    const writeProjectMap = (projectMap: Record<string, any>) => {
      ensureDatasetsDir();
      fs.writeFileSync(projectMapPath, JSON.stringify(projectMap, null, 2), 'utf-8');
    };

    const readWorkerFolderMap = (): Record<string, { workerName: string; updatedAt: number }> => {
      const data = readJsonSafe(workerFolderMapPath, {});
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, { workerName: string; updatedAt: number }>;
      return {};
    };

    /** _project_map 값의 projectId 가 JSON에서 숫자로 들어오면 === 문자열과 불일치 → 폴더 0건·배정 0건 */
    const folderKeysMappedToProject = (
      map: Record<string, { projectId?: string | number }>,
      projectId: string
    ): string[] => {
      const pid = String(projectId || '').trim();
      return Object.entries(map)
        .filter(([, v]) => String(v?.projectId ?? '').trim() === pid)
        .map(([folder]) => folder);
    };

    const writeWorkerFolderMap = (m: Record<string, any>) => {
      ensureDatasetsDir();
      fs.writeFileSync(workerFolderMapPath, JSON.stringify(m, null, 2), 'utf-8');
    };

    /** API 응답용: _project_map / _worker_folder_map 규칙이 태스크 행 값보다 우선 */
    const applyMappingRulesToTaskRow = (row: any) => {
      const projects = readProjects();
      const projectMap = readProjectMap();
      const workerFolderMap = readWorkerFolderMap();
      const folder = String(row.folder || '');
      return {
        ...row,
        sourceType: effectiveSourceTypeForTaskFolder(folder, row.sourceType, projectMap, projects),
        assignedWorker: effectiveAssignedWorkerForTaskFolder(folder, row.assignedWorker, workerFolderMap)
      };
    };

    /** 작업자 필터: DB 배정 행 + (미배정이면서) 매핑 접두 하위 폴더 — effectiveAssignedWorker(DB 우선)와 동일 */
    const buildWorkerFilterSql = (workerFilter: string): { sql: string; params: any[] } => {
      if (!workerFilter) return { sql: '', params: [] };
      const wmap = readWorkerFolderMap();
      const wf = String(workerFilter).trim();
      const unassignedSql =
        "(assignedWorker IS NULL OR TRIM(COALESCE(assignedWorker, '')) = '' OR LOWER(TRIM(COALESCE(assignedWorker, ''))) = 'unassigned')";
      const mapPairs: Array<[string, string]> = [];
      Object.entries(wmap).forEach(([prefix, rec]) => {
        if (String(rec.workerName || '').trim() !== wf) return;
        const p = String(prefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!p) return;
        mapPairs.push([p, escapeSqlLikePatternPrefix(p)]);
      });
      let sql: string;
      let params: any[];
      if (mapPairs.length === 0) {
        sql = 'assignedWorker = ?';
        params = [wf];
      } else {
        const mapOr = mapPairs.map(() => "(folder = ? OR folder LIKE ? ESCAPE '\\')").join(' OR ');
        sql = `(assignedWorker = ? OR (${unassignedSql} AND (${mapOr})))`;
        params = [wf];
        for (const [p, like] of mapPairs) {
          params.push(p, like);
        }
      }
      return { sql: `(${sql})`, params };
    };

    const toProjectId = (name: string) => {
      const base = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return base || `project-${Date.now()}`;
    };

    /** 워크플로 어댑터: 폴더↔프로젝트 매핑의 filesystem 부문 (_project_map.json 기준) */
    const normProjectMapPath = (f: string) => String(f || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const resolveProjectMapFilesystem = (rawMap: Record<string, { projectId: string; updatedAt: number }>, existingFolders: Set<string>): Record<string, { projectId: string; updatedAt: number }> => {
      const out: Record<string, { projectId: string; updatedAt: number }> = {};
      const foldersArr = [...existingFolders].map(normProjectMapPath).filter(Boolean);
      const existingNorm = new Set(foldersArr);
      Object.entries(rawMap || {}).forEach(([folder, mapping]: [string, any]) => {
        if (!mapping?.projectId) return;
        const keyNorm = normProjectMapPath(folder);
        if (!keyNorm) return;
        const exact = existingNorm.has(keyNorm);
        const coversChild = foldersArr.some((ef) => ef === keyNorm || ef.startsWith(keyNorm + '/'));
        if (!exact && !coversChild) return;
        const entry = { projectId: String(mapping.projectId), updatedAt: Number(mapping.updatedAt || 0) };
        out[keyNorm] = entry;
        if (folder && normProjectMapPath(folder) !== folder) {
          out[folder] = entry;
        }
      });
      return out;
    };

    /** 워크플로 어댑터: VLM 프로젝트용 가상 폴더 매핑 (vlm_tasks의 sourceFile 기준) */
    const resolveProjectMapVlm = (projects: Record<string, any>, getVlmFoldersBySourceFile: (sourceFile: string) => string[]): Record<string, { projectId: string; updatedAt: number }> => {
      const out: Record<string, { projectId: string; updatedAt: number }> = {};
      Object.values(projects || {}).forEach((project: any) => {
        if (normalizeWorkflowSourceType(project?.workflowSourceType) !== 'vlm-review') return;
        const sourceFiles = projectVlmSourceFilesList(project);
        if (sourceFiles.length === 0) return;
        const now = Number(project.updatedAt || Date.now());
        sourceFiles.forEach((sf) => {
          const folders = getVlmFoldersBySourceFile(String(sf));
          folders.forEach((folder: string) => {
            if (folder) out[folder] = { projectId: project.id, updatedAt: now };
          });
        });
      });
      return out;
    };

    const buildProjectOverview = () => {
      const projects = readProjects();
      const rawMap = readProjectMap();
      const projectsForRules = projects as Record<string, { workflowSourceType?: string }>;
      const folderStatsRows = db.prepare(`
        SELECT
          folder,
          sourceType,
          COUNT(*) as taskCount,
          COUNT(CASE WHEN assignedWorker IS NOT NULL AND TRIM(LOWER(assignedWorker)) NOT IN ('', 'unassigned', 'admin') THEN 1 END) as allocatedCount,
          COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount,
          MAX(COALESCE(lastUpdated, 0)) as lastUpdated,
          MAX(COALESCE(assignedWorker, '')) as assignedWorker
        FROM (
          SELECT folder, status, lastUpdated, assignedWorker, COALESCE(sourceType, 'native-yolo') as sourceType FROM tasks
          UNION ALL
          SELECT folder, status, lastUpdated, assignedWorker, 'vlm-review' as sourceType FROM vlm_tasks
        ) t
        GROUP BY folder, sourceType
      `).all();

      const getVlmFoldersBySourceFile = (sourceFile: string): string[] => {
        try {
          return (db.prepare('SELECT DISTINCT folder FROM vlm_tasks WHERE sourceFile = ?').all(sourceFile) as Array<{ folder: string }>)
            .map((r) => String(r.folder || '').trim())
            .filter(Boolean);
        } catch {
          return [];
        }
      };
      const projectMapForEffective: Record<string, { projectId: string; updatedAt: number }> = {
        ...rawMap,
        ...resolveProjectMapVlm(projects, getVlmFoldersBySourceFile)
      };

      const folderStatsBySource = new Map<string, Map<'native-yolo' | 'vlm-review' | 'image-classification', any>>();
      const folderStatsMergedMap = new Map<string, any>();
      folderStatsRows.forEach((row: any) => {
        const folder = String(row.folder || '');
        if (!folder) return;
        const effectiveSt = effectiveSourceTypeForTaskFolder(folder, row.sourceType, projectMapForEffective, projectsForRules);
        const normalizedRow = {
          folder,
          taskCount: Number(row.taskCount || 0),
          allocatedCount: Number(row.allocatedCount || 0),
          completedCount: Number(row.completedCount || 0),
          lastUpdated: Number(row.lastUpdated || 0),
          assignedWorker: row.assignedWorker ? String(row.assignedWorker) : ''
        };
        const sourceMap = folderStatsBySource.get(folder) || new Map<'native-yolo' | 'vlm-review' | 'image-classification', any>();
        const prevByEff = sourceMap.get(effectiveSt);
        if (prevByEff) {
          sourceMap.set(effectiveSt, {
            folder,
            taskCount: Number(prevByEff.taskCount || 0) + normalizedRow.taskCount,
            allocatedCount: Number(prevByEff.allocatedCount || 0) + normalizedRow.allocatedCount,
            completedCount: Number(prevByEff.completedCount || 0) + normalizedRow.completedCount,
            lastUpdated: Math.max(Number(prevByEff.lastUpdated || 0), normalizedRow.lastUpdated),
            assignedWorker: normalizedRow.assignedWorker || String(prevByEff.assignedWorker || '')
          });
        } else {
          sourceMap.set(effectiveSt, normalizedRow);
        }
        folderStatsBySource.set(folder, sourceMap);

        const merged = folderStatsMergedMap.get(folder) || {
          folder,
          taskCount: 0,
          allocatedCount: 0,
          completedCount: 0,
          nativeTaskCount: 0,
          vlmTaskCount: 0,
          classificationTaskCount: 0,
          lastUpdated: 0,
          assignedWorker: ''
        };
        const nextNativeTaskCount = Number(merged.nativeTaskCount || 0) + (effectiveSt === 'native-yolo' ? normalizedRow.taskCount : 0);
        const nextVlmTaskCount = Number(merged.vlmTaskCount || 0) + (effectiveSt === 'vlm-review' ? normalizedRow.taskCount : 0);
        const nextClassificationTaskCount = Number(merged.classificationTaskCount || 0) + (effectiveSt === 'image-classification' ? normalizedRow.taskCount : 0);
        folderStatsMergedMap.set(folder, {
          folder,
          taskCount: Number(merged.taskCount || 0) + normalizedRow.taskCount,
          allocatedCount: Number(merged.allocatedCount || 0) + normalizedRow.allocatedCount,
          completedCount: Number(merged.completedCount || 0) + normalizedRow.completedCount,
          nativeTaskCount: nextNativeTaskCount,
          vlmTaskCount: nextVlmTaskCount,
          classificationTaskCount: nextClassificationTaskCount,
          lastUpdated: Math.max(Number(merged.lastUpdated || 0), normalizedRow.lastUpdated),
          assignedWorker: normalizedRow.assignedWorker || merged.assignedWorker || ''
        });
      });
      const isHiddenFromMapping = (folder: string) => {
        const f = String(folder || '').trim();
        return f === 'images_vlm' || f.startsWith('images_vlm/') ||
          f === '_trash' || f.startsWith('_trash/') ||
          f === 'test' || f.startsWith('test/');
      };
      const folderStats = Array.from(folderStatsMergedMap.values()).filter((row: any) => !isHiddenFromMapping(row.folder));

      const wmapOv = readWorkerFolderMap();
      folderStats.forEach((row: any) => {
        row.assignedWorker =
          effectiveAssignedWorkerForTaskFolder(row.folder, row.assignedWorker, wmapOv) || '';
      });

      const existingFolders = new Set(folderStats.map((row: any) => row.folder));
      const projectMap = {
        ...resolveProjectMapFilesystem(rawMap, existingFolders),
        ...resolveProjectMapVlm(projects, getVlmFoldersBySourceFile)
      };

      const workerBreakdownRaw = db.prepare(`
        SELECT
          folder,
          TRIM(COALESCE(assignedWorker, '')) as dbWorker,
          COUNT(*) as taskCount,
          COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount,
          MAX(COALESCE(lastUpdated, 0)) as lastUpdated
        FROM (
          SELECT folder, status, lastUpdated, assignedWorker FROM tasks
          UNION ALL
          SELECT folder, status, lastUpdated, assignedWorker FROM vlm_tasks
        ) u
        GROUP BY folder, TRIM(COALESCE(assignedWorker, ''))
      `).all() as Record<string, unknown>[];
      const workerFolderBreakdown = mergeWorkerFolderBreakdownFromDbRows(workerBreakdownRaw, wmapOv)
        .filter((r) => !isHiddenFromMapping(r.folder))
        .map((r) => {
          const pid = resolveProjectMapEntryForFolder(r.folder, projectMap)?.projectId;
          return pid ? { ...r, projectId: pid } : { ...r };
        });

      const statsByProject = new Map<string, { allocated: number; completed: number; folderCount: number }>();
      folderStats.forEach((row: any) => {
        const resolvedMap = resolveProjectMapEntryForFolder(row.folder, projectMap);
        const projectId = resolvedMap?.projectId;
        if (projectId) {
          row.projectId = projectId; // <--- ADD THIS so UI can group by ProjectID
          const project = projects[projectId];
          
          // Skip VLM projects that use a global sourceFile, as they are aggregated below globally
          const isVlmGlobals =
            normalizeWorkflowSourceType(project?.workflowSourceType) === 'vlm-review' &&
            projectVlmSourceFilesList(project).length > 0;
          if (isVlmGlobals) return;
          
          const workflowSourceType = normalizeWorkflowSourceType(project?.workflowSourceType);
          let sourceStats = folderStatsBySource.get(row.folder)?.get(workflowSourceType);
          if (!sourceStats || Number(sourceStats.taskCount || 0) === 0) {
            const sm = folderStatsBySource.get(row.folder);
            if (sm && sm.size > 0) {
              sourceStats = Array.from(sm.values()).reduce(
                (acc: any, s: any) => ({
                  taskCount: acc.taskCount + Number(s.taskCount || 0),
                  allocatedCount: acc.allocatedCount + Number(s.allocatedCount || 0),
                  completedCount: acc.completedCount + Number(s.completedCount || 0)
                }),
                { taskCount: 0, allocatedCount: 0, completedCount: 0 }
              );
            }
          }
          if (!sourceStats) {
            sourceStats = { taskCount: 0, allocatedCount: 0, completedCount: 0 };
          }

          const allocatedCount = Number(sourceStats.allocatedCount || 0);

          const current = statsByProject.get(projectId) || { allocated: 0, completed: 0, folderCount: 0 };
          statsByProject.set(projectId, {
            allocated: current.allocated + allocatedCount,
            completed: current.completed + Number(sourceStats.completedCount || 0),
            folderCount: current.folderCount + (Number(sourceStats.taskCount || 0) > 0 ? 1 : 0)
          });
        }
      });
      
      Object.values(projects).forEach((project: any) => {
        if (normalizeWorkflowSourceType(project?.workflowSourceType) !== 'vlm-review') return;
        const vlmSf = projectVlmSourceFilesList(project);
        if (vlmSf.length === 0) return;
        try {
          const ph = vlmSf.map(() => '?').join(',');
          const row = db.prepare(`
            SELECT 
              COUNT(CASE WHEN assignedWorker IS NOT NULL AND TRIM(LOWER(assignedWorker)) NOT IN ('', 'unassigned', 'admin') THEN 1 END) as allocatedCount, 
              COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') AND assignedWorker IS NOT NULL AND TRIM(LOWER(assignedWorker)) NOT IN ('', 'unassigned', 'admin') THEN 1 END) as completedCount,
              COUNT(DISTINCT folder) as folderCount
            FROM vlm_tasks WHERE sourceFile IN (${ph})
          `).get(...vlmSf) as { allocatedCount: number; completedCount: number; folderCount: number };
          const current = statsByProject.get(project.id) || { allocated: 0, completed: 0, folderCount: 0 };
          statsByProject.set(project.id, {
            allocated: current.allocated + Number(row?.allocatedCount || 0),
            completed: current.completed + Number(row?.completedCount || 0),
            folderCount: current.folderCount + Number(row?.folderCount || 0)
          });
        } catch (e) { }
      });


      const finalProjects = Object.values(projects).map((p: any) => {
        if (p.status === 'ARCHIVED' && p.archiveSnapshot?.project) {
          const s = p.archiveSnapshot.project;
          return {
            ...p,
            allocated: s.allocated ?? 0,
            completed: s.completed ?? 0,
            folderCount: s.folderCount ?? 0,
            progress: s.progress ?? 0
          };
        }
        const stats = statsByProject.get(p.id) || { allocated: 0, completed: 0, folderCount: 0 };
        const targetTotal = Number(p.targetTotal || 0);
        return {
          ...p,
          allocated: stats.allocated,
          completed: stats.completed,
          folderCount: stats.folderCount,
          progress: targetTotal > 0 ? Number(((stats.completed / targetTotal) * 100).toFixed(2)) : 0
        };
      });

      const unassignedFolders = folderStats.filter((row: any) => !resolveProjectMapEntryForFolder(row.folder, projectMap)?.projectId);
      const unassignedStats = {
        folderCount: unassignedFolders.length,
        allocated: unassignedFolders.reduce((acc, row) => acc + Number(row.taskCount || 0), 0),
        completed: unassignedFolders.reduce((acc, row) => acc + Number(row.completedCount || 0), 0)
      };

      return {
        projects: finalProjects,
        projectMap,
        workerFolderMap: readWorkerFolderMap(),
        unassigned: unassignedStats,
        folders: folderStats,
        workerFolderBreakdown
      };
    };

    const generatePrometheusMetrics = () => {
      const overview = buildProjectOverview();
      let m = '# HELP yolo_project_target_total Target total tasks for a project\n# TYPE yolo_project_target_total gauge\n';
      overview.projects.forEach(p => {
        m += `yolo_project_target_total{project_id="${p.id}",project_name="${p.name}",workflow="${p.workflowSourceType}",status="${p.status || 'ACTIVE'}"} ${p.targetTotal}\n`;
      });

      m += '\n# HELP yolo_project_allocated_total Allocated tasks for a project\n# TYPE yolo_project_allocated_total gauge\n';
      overview.projects.forEach(p => {
        m += `yolo_project_allocated_total{project_id="${p.id}",project_name="${p.name}",workflow="${p.workflowSourceType}",status="${p.status || 'ACTIVE'}"} ${p.allocated}\n`;
      });

      m += '\n# HELP yolo_project_completed_total Completed tasks for a project\n# TYPE yolo_project_completed_total gauge\n';
      overview.projects.forEach(p => {
        m += `yolo_project_completed_total{project_id="${p.id}",project_name="${p.name}",workflow="${p.workflowSourceType}",status="${p.status || 'ACTIVE'}"} ${p.completed}\n`;
      });

      m += '\n# HELP yolo_project_progress_ratio Progress ratio (0-100) for a project\n# TYPE yolo_project_progress_ratio gauge\n';
      overview.projects.forEach(p => {
        m += `yolo_project_progress_ratio{project_id="${p.id}",project_name="${p.name}",workflow="${p.workflowSourceType}",status="${p.status || 'ACTIVE'}"} ${p.progress}\n`;
      });

      m += `\n# HELP yolo_unassigned_folders_total Count of unassigned folders\n# TYPE yolo_unassigned_folders_total gauge\nyolo_unassigned_folders_total ${overview.unassigned.folderCount}\n`;
      m += `\n# HELP yolo_unassigned_tasks_total Count of unassigned tasks\n# TYPE yolo_unassigned_tasks_total gauge\nyolo_unassigned_tasks_total ${overview.unassigned.allocated}\n`;

      return m;
    };



    const vlmDbPath = path.resolve(__dirname, 'VLM', 'tasks.db');
    const parseVlmTimestamp = (input: any): number => {
      if (input === null || input === undefined) return 0;
      const asNumber = Number(input);
      if (Number.isFinite(asNumber) && asNumber > 0) {
        return asNumber < 1e12 ? Math.floor(asNumber * 1000) : Math.floor(asNumber);
      }
      const parsed = Date.parse(String(input));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const normalizeVlmToTaskStatus = (status: any, ratingCode: any): string => {
      const normalizedStatus = String(status || '').toLowerCase();
      const code = Number(ratingCode);
      if (normalizedStatus === 'validated' || code === 9 || code === 0) return 'APPROVED';
      if (normalizedStatus === 'worked' || code === 8 || code === 1 || code === 2) return 'SUBMITTED';
      if (normalizedStatus === 'assigned') return 'IN_PROGRESS';
      return 'TODO';
    };
    const buildVlmFolderName = (sourceFile: string) => {
      const base = path.basename(String(sourceFile || 'vlm_migrated'), path.extname(String(sourceFile || '')));
      return `VLM_${base || 'migrated'}`;
    };
    const listVlmImportJsonFiles = () => {
      const importDir = path.resolve(datasetsDir, 'vlm_import');
      const candidateDirs = [datasetsDir, importDir];
      const unique = new Set<string>();
      candidateDirs.forEach((dirPath) => {
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return;
        fs.readdirSync(dirPath).forEach((name) => {
          if (!/\.json$/i.test(name)) return;
          if (name.startsWith('_')) return;
          if (name.toLowerCase() === 'users.json') return;
          unique.add(path.join(dirPath, name));
        });
      });
      return Array.from(unique).sort((a, b) => a.localeCompare(b)).map((absolutePath) => ({
        fileName: path.basename(absolutePath),
        absolutePath,
        relativePath: path.relative(datasetsDir, absolutePath).replace(/\\/g, '/')
      }));
    };
    const toNumericLike = (value: any) => {
      const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    const IMAGE_FILE_EXT_RE = /\.(jpg|jpeg|png|webp|bmp|gif)$/i;
    let imagesVlmIndexCache: { builtAt: number; byBase: Map<string, string[]> } | null = null;
    const IMAGE_INDEX_TTL_MS = 30000;
    const buildImagesVlmIndex = () => {
      const now = Date.now();
      if (imagesVlmIndexCache && (now - imagesVlmIndexCache.builtAt) < IMAGE_INDEX_TTL_MS) {
        return imagesVlmIndexCache.byBase;
      }
      const imagesRoot = path.resolve(datasetsDir, 'images_vlm');
      const byBase = new Map<string, string[]>();
      const stack = [imagesRoot];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (!fs.existsSync(current)) continue;
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_e) {
          continue;
        }
        entries.forEach((entry) => {
          const abs = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(abs);
            return;
          }
          if (!IMAGE_FILE_EXT_RE.test(entry.name)) return;
          const rel = path.relative(imagesRoot, abs).replace(/\\/g, '/');
          const base = path.basename(entry.name).toLowerCase();
          const list = byBase.get(base) || [];
          list.push(rel);
          byBase.set(base, list);
        });
      }
      imagesVlmIndexCache = { builtAt: now, byBase };
      return byBase;
    };
    const applyImagePathMappings = (rawPath: string, mappings?: Array<{ from?: string; to?: string }>) => {
      if (!Array.isArray(mappings) || mappings.length === 0) return rawPath;
      let output = String(rawPath || '');
      mappings.forEach((rule) => {
        const from = String(rule?.from || '');
        const to = String(rule?.to || '');
        if (!from) return;
        if (output.includes(from)) {
          output = output.split(from).join(to);
        }
      });
      return output;
    };
    const resolveVlmImagePath = (rawInput: string, mappings?: Array<{ from?: string; to?: string }>) => {
      const imagesRoot = path.resolve(datasetsDir, 'images_vlm');
      const mappedInput = applyImagePathMappings(String(rawInput || ''), mappings);
      const raw = mappedInput
        .replace(/[?#].*$/, '')
        .replace(/\\/g, '/')
        .replace(/^[A-Za-z]:/, '')
        .trim();
      const candidates = new Set<string>();
      const pushCandidate = (value: string) => {
        const cleaned = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
        if (!cleaned) return;
        candidates.add(cleaned);
      };
      pushCandidate(raw);
      const lowered = raw.toLowerCase();
      ['images_vlm/', 'datasets/images_vlm/', '/datasets/images_vlm/', 'datasets/', '/datasets/'].forEach((token) => {
        const idx = lowered.indexOf(token);
        if (idx >= 0) {
          pushCandidate(raw.substring(idx + token.length));
        }
      });
      if (raw.includes('://')) {
        try {
          const parsed = new URL(raw);
          pushCandidate(parsed.pathname || '');
        } catch (_e) { }
      }

      const existingExact = Array.from(candidates).find((rel) => fs.existsSync(path.resolve(imagesRoot, rel)));
      if (existingExact) {
        return {
          imageRel: existingExact,
          imageAbsolute: path.resolve(imagesRoot, existingExact),
          imageExists: true,
          resolvedBy: 'exact'
        };
      }

      const baseName = path.basename(raw || '').toLowerCase();
      if (baseName) {
        const byBase = buildImagesVlmIndex();
        const matched = byBase.get(baseName) || [];
        if (matched.length === 1) {
          const rel = matched[0];
          return {
            imageRel: rel,
            imageAbsolute: path.resolve(imagesRoot, rel),
            imageExists: true,
            resolvedBy: 'basename-unique'
          };
        }
        if (matched.length > 1) {
          const rel = [...matched].sort((a, b) => a.length - b.length)[0];
          return {
            imageRel: rel,
            imageAbsolute: path.resolve(imagesRoot, rel),
            imageExists: true,
            resolvedBy: 'basename-multi'
          };
        }
      }

      const fallback = Array.from(candidates)[0] || '';
      return {
        imageRel: fallback,
        imageAbsolute: fallback ? path.resolve(imagesRoot, fallback) : '',
        imageExists: fallback ? fs.existsSync(path.resolve(imagesRoot, fallback)) : false,
        resolvedBy: 'fallback'
      };
    };
    const mergeVlmConversationAnswer = (rawData: any, answer: string) => {
      const output = rawData && typeof rawData === 'object' ? JSON.parse(JSON.stringify(rawData)) : {};
      const conv = Array.isArray(output.conversations) ? [...output.conversations] : [];
      const targetIdx = conv.findIndex((c: any) => ['gpt', 'assistant', 'model'].includes(String(c?.from || '').toLowerCase()));
      if (targetIdx >= 0) {
        conv[targetIdx] = { ...conv[targetIdx], value: String(answer || '') };
      } else {
        conv.push({ from: 'gpt', value: String(answer || '') });
      }
      output.conversations = conv;
      return output;
    };
    const toExportResultLabel = (reviewResultLike: any, statusLike: any) => {
      const review = String(reviewResultLike || '').toUpperCase();
      if (review === 'NEEDS_FIX_VP') return '수정필요(vp)';
      if (review === 'NEEDS_FIX_DETAIL') return '수정필요(detail)';
      if (review === 'NORMAL') return '정상';
      const status = String(statusLike || '').toUpperCase();
      if (status === 'SUBMITTED' || status === 'APPROVED') return '정상';
      if (status === 'IN_PROGRESS' || status === 'REJECTED') return '수정필요';
      return '정상';
    };
    const normalizeJsonItemToTask = (item: any, sourceFile: string, mappings?: Array<{ from?: string; to?: string }>) => {
      const sourceRefId = String(item?.index ?? item?.id ?? '').trim();
      const originalImage = String(item?.image || '').trim();
      const resolvedImage = resolveVlmImagePath(originalImage, mappings);
      const imageRel = String(resolvedImage.imageRel || '').trim().replace(/^\/+/, '');
      const taskId = `vlm-json:${sourceFile}:${sourceRefId || crypto.createHash('md5').update(JSON.stringify(item || {})).digest('hex')}`;
      const imageUrl = imageRel ? `/datasets/images_vlm/${imageRel}` : '';
      const imageExists = Boolean(resolvedImage.imageExists);
      const conversations = Array.isArray(item?.conversations) ? item.conversations : [];
      const gptAnswer = conversations.find((c: any) => ['gpt', 'assistant', 'model'].includes(String(c?.from || '').toLowerCase()))?.value || '';
      const sourceData = JSON.stringify({
        sourceType: 'vlm-review',
        rawData: item,
        rawResultData: {
          answer: String(gptAnswer || '')
        },
        legacyImage: originalImage || null,
        resolvedImagePath: imageRel || null,
        resolvedImageBy: resolvedImage.resolvedBy
      });
      return {
        sourceFile,
        sourceRefId,
        taskId,
        imageRel,
        imageUrl,
        imageExists,
        taskRecord: {
          id: taskId,
          name: imageRel ? path.basename(imageRel) : `vlm_json_${sourceRefId || 'row'}.json`,
          folder: buildVlmFolderName(sourceFile),
          imageUrl,
          txtPath: null,
          assignedWorker: null,
          status: 'TODO',
          reviewerNotes: '',
          isModified: 0,
          lastUpdated: Date.now(),
          sourceType: 'vlm-review',
          sourceRefId,
          sourceFile,
          sourceData
        }
      };
    };
    const listVlmExportFilesFromDb = () => {
      const rows = db.prepare(`
        SELECT
          COALESCE(sourceFile, '') as sourceFile,
          COUNT(*) as totalTasks,
          SUM(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 ELSE 0 END) as submittedTasks,
          MAX(COALESCE(lastUpdated, 0)) as lastUpdated
        FROM vlm_tasks
        WHERE COALESCE(sourceFile, '') <> ''
        GROUP BY COALESCE(sourceFile, '')
        ORDER BY sourceFile ASC
      `).all();
      return rows.map((row: any) => ({
        sourceFile: String(row.sourceFile || ''),
        totalTasks: Number(row.totalTasks || 0),
        submittedTasks: Number(row.submittedTasks || 0),
        lastUpdated: Number(row.lastUpdated || 0)
      }));
    };
    const readVlmRows = (limit: number, offset: number) => {
      if (!fs.existsSync(vlmDbPath)) {
        throw new Error(`VLM DB not found at ${vlmDbPath}`);
      }
      const vlmDb = new Database(vlmDbPath, { readonly: true, fileMustExist: true });
      try {
        const total = Number(vlmDb.prepare(`SELECT COUNT(*) as c FROM tasks`).get()?.c || 0);
        const rows = vlmDb.prepare(`
          SELECT
            id,
            original_id,
            data,
            result_data,
            status,
            assigned_to,
            source_file,
            rating_code,
            user,
            completed_at,
            validator,
            valid_at,
            valid_comment,
            admin_comment
          FROM tasks
          ORDER BY id ASC
          LIMIT ? OFFSET ?
        `).all(limit, offset);
        return { total, rows };
      } finally {
        vlmDb.close();
      }
    };

    /** 분류보내기 — 로컬 SQLite(datasets.db). 운영 PG export 는 별도 API 서버에서 처리 */
    const serveClassificationExportIfMatch = (req: any, res: any): boolean => {
      if (req.method !== 'GET' || !req.url) return false;
      let url: URL;
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      } catch {
        return false;
      }
      if (url.pathname !== '/api/plugins/classification/export' && url.pathname !== '/api/export/classification') {
        return false;
      }
      try {
        const projectId = String(url.searchParams.get('projectId') || '').trim();
        const format = String(url.searchParams.get('format') || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
        if (!projectId) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'projectId is required' }));
          return true;
        }
        const projects = readProjects();
        const project = projects[projectId];
        if (!project || normalizeWorkflowSourceType(project.workflowSourceType) !== 'image-classification') {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Project not found or not an image-classification project' }));
          return true;
        }
        const projectMap = readProjectMap();
        const pidNorm = String(projectId).trim();
        const folders = Object.entries(projectMap)
          .filter(([, data]: [string, any]) => String(data?.projectId ?? '').trim() === pidNorm)
          .map(([folder]) => folder);
        const classificationClasses = Array.isArray(project.classificationClasses) ? project.classificationClasses : [];
        const classMap = new Map(classificationClasses.map((c: any) => [Number(c.id), String(c.name || '')]));

        const exportDir = path.resolve(__dirname, 'datasets', 'classification_export');
        fs.mkdirSync(exportDir, { recursive: true });
        const fileName = `classification_${projectId}.${format}`;
        const filePath = path.join(exportDir, fileName);
        const relativePath = `datasets/classification_export/${fileName}`;

        let content: string;
        if (folders.length === 0) {
          if (format === 'csv') {
            content = 'id,imageUrl,folder,classId,className,status\n';
          } else {
            content = JSON.stringify([], null, 2);
          }
        } else {
          const { sql: folderWhereSql, params: folderWhereParams } = buildTasksUnderMappedRootsWhereSqlite(folders);
          const rows = db.prepare(
            `SELECT id, name, folder, imageUrl, status, sourceData FROM tasks WHERE ${folderWhereSql}`
          ).all(...folderWhereParams) as any[];

          const rowsWithClass = rows.map((row: any) => {
            let classId: number | null = null;
            try {
              if (row.sourceData) {
                const parsed = JSON.parse(row.sourceData);
                if (parsed && typeof parsed.classId !== 'undefined') classId = Number(parsed.classId);
              }
            } catch (_) {}
            const className = classId != null ? (classMap.get(classId) ?? '') : '';
            return { id: row.id, imageUrl: row.imageUrl || '', folder: row.folder || '', classId, className, status: row.status || '' };
          });

          if (format === 'csv') {
            const header = 'id,imageUrl,folder,classId,className,status';
            const escape = (v: any) => {
              const s = String(v ?? '');
              if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
              return s;
            };
            const lines = [header, ...rowsWithClass.map((r: any) => [r.id, r.imageUrl, r.folder, r.classId, r.className, r.status].map(escape).join(','))];
            content = lines.join('\n');
          } else {
            content = JSON.stringify(rowsWithClass, null, 2);
          }
        }

        fs.writeFileSync(filePath, content, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, path: relativePath }));
        return true;
      } catch (e: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e?.message || 'Export failed' }));
        return true;
      }
    };

    middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/api/')) {
        console.log(`[API] ${req.method} ${req.url}`);
      }
      if (serveClassificationExportIfMatch(req, res)) {
        return;
      }
      const clampSeconds = (v: number, min: number = 0, max: number = 300) => Math.max(min, Math.min(max, v));
      const ALL_LOGS_FROM = `(SELECT * FROM logs UNION ALL SELECT * FROM vlm_logs)`;
      const buildLegacyWorkTimeByUser = (startTs: number, endTs: number) => {
        const rows = db.prepare(`
          SELECT
            l.userId as userId,
            SUM(
              CASE
                WHEN UPPER(l.action) = 'SUBMIT' THEN COALESCE(l.durationSeconds, 0)
                WHEN UPPER(l.action) = 'SAVE'
                  AND (l.taskId IS NULL OR NOT EXISTS (
                    SELECT 1
                    FROM ${ALL_LOGS_FROM} s
                    WHERE s.userId = l.userId
                      AND s.taskId = l.taskId
                      AND UPPER(s.action) = 'SUBMIT'
                      AND s.timestamp >= ?
                      AND s.timestamp <= ?
                  ))
                THEN COALESCE(l.durationSeconds, 0)
                ELSE 0
              END
            ) as workTime
          FROM ${ALL_LOGS_FROM} l
          WHERE l.timestamp >= ? AND l.timestamp <= ?
          GROUP BY l.userId
        `).all(startTs, endTs, startTs, endTs);
        const result = new Map<string, number>();
        rows.forEach((row: any) => {
          result.set(String(row.userId || ''), Number(row.workTime || 0));
        });
        return result;
      };
      const buildSubmitOnlyWorkTimeByUser = (startTs: number, endTs: number) => {
        const rows = db.prepare(`
          SELECT userId, SUM(COALESCE(durationSeconds, 0)) as workTime
          FROM ${ALL_LOGS_FROM}
          WHERE timestamp >= ? AND timestamp <= ?
            AND UPPER(action) = 'SUBMIT'
          GROUP BY userId
        `).all(startTs, endTs);
        const result = new Map<string, number>();
        rows.forEach((row: any) => {
          result.set(String(row.userId || ''), Number(row.workTime || 0));
        });
        return result;
      };
      const buildSessionWorkTimeByUser = (startTs: number, endTs: number) => {
        const rows = db.prepare(`
          SELECT userId, taskId, UPPER(action) as action, timestamp, durationSeconds
          FROM ${ALL_LOGS_FROM}
          WHERE timestamp >= ? AND timestamp <= ?
            AND UPPER(action) IN ('START', 'SAVE', 'SUBMIT')
          ORDER BY userId ASC, taskId ASC, timestamp ASC
        `).all(startTs, endTs);
        const result = new Map<string, number>();
        const lastStartOrSaveByKey = new Map<string, number>();
        rows.forEach((row: any) => {
          const userId = String(row.userId || '').trim();
          if (!userId) return;
          const taskId = String(row.taskId || '').trim() || '__no_task__';
          const key = `${userId}::${taskId}`;
          const action = String(row.action || '').toUpperCase();
          const ts = Number(row.timestamp || 0);
          const duration = Number(row.durationSeconds || 0);
          const lastStartOrSave = lastStartOrSaveByKey.get(key) || 0;
          if (action === 'START' || action === 'SAVE') {
            lastStartOrSaveByKey.set(key, ts);
            return;
          }
          if (action === 'SUBMIT') {
            let deltaSec = 0;
            if (lastStartOrSave > 0 && ts >= lastStartOrSave) {
              deltaSec = (ts - lastStartOrSave) / 1000;
            } else if (duration > 0) {
              deltaSec = duration;
            }
            const safeSec = clampSeconds(Number(deltaSec || 0));
            result.set(userId, Number(result.get(userId) || 0) + safeSec);
            lastStartOrSaveByKey.set(key, 0);
          }
        });
        return result;
      };
      const buildHybridWorkTimeByUser = (startTs: number, endTs: number) => {
        // Safe+fast default: prefer session-based work time.
        // Fallback to submit-only for users without session events.
        const submitOnlyMap = buildSubmitOnlyWorkTimeByUser(startTs, endTs);
        const sessionMap = buildSessionWorkTimeByUser(startTs, endTs);
        const merged = new Map<string, number>();
        const keys = new Set<string>([
          ...Array.from(submitOnlyMap.keys()),
          ...Array.from(sessionMap.keys())
        ]);
        keys.forEach((userId) => {
          const sessionValue = Number(sessionMap.get(userId) || 0);
          const fallbackValue = Number(submitOnlyMap.get(userId) || 0);
          merged.set(userId, sessionValue > 0 ? sessionValue : fallbackValue);
        });
        return merged;
      };
      const buildAnalyticsByRange = (startTs: number, endTs: number) => {
        const cacheKey = `${startTs}:${endTs}`;
        const now = Date.now();
        const cached = analyticsCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
          return cached.data;
        }
        const stats = db.prepare(`
          SELECT
            userId,
            role,
            COUNT(DISTINCT CASE WHEN UPPER(action) = 'SUBMIT' THEN taskId END) as submissions,
            COUNT(CASE WHEN UPPER(action) = 'APPROVE' THEN 1 END) as approvals,
            COUNT(CASE WHEN UPPER(action) = 'REJECT' THEN 1 END) as rejections,
            MAX(timestamp) as lastActive
          FROM ${ALL_LOGS_FROM} l
          WHERE l.timestamp >= ? AND l.timestamp <= ?
          GROUP BY userId
        `).all(startTs, endTs);

        const folderRows = db.prepare(`
          SELECT DISTINCT userId, folder
          FROM ${ALL_LOGS_FROM}
          WHERE timestamp >= ? AND timestamp <= ?
            AND UPPER(action) = 'SUBMIT'
            AND folder IS NOT NULL
            AND TRIM(folder) <> ''
        `).all(startTs, endTs);

        const foldersByUser: Record<string, Set<string>> = {};
        folderRows.forEach((row: any) => {
          const userId = String(row.userId || '');
          const folder = String(row.folder || '').trim();
          if (!userId || !folder) return;
          if (!foldersByUser[userId]) foldersByUser[userId] = new Set<string>();
          foldersByUser[userId].add(folder);
        });

        const logsWithStats = db.prepare(`
          SELECT userId, stats FROM ${ALL_LOGS_FROM}
          WHERE timestamp >= ? AND timestamp <= ?
            AND stats IS NOT NULL
            AND UPPER(action) = 'SUBMIT'
        `).all(startTs, endTs);

        const boxCounts = {};
        logsWithStats.forEach((l: any) => {
          if (l.stats) {
            try {
              const s = JSON.parse(l.stats);
              if (s.manualBoxCount) {
                boxCounts[l.userId] = (boxCounts[l.userId] || 0) + s.manualBoxCount;
              }
            } catch (e) { }
          }
        });
        const workTimeByUser = buildHybridWorkTimeByUser(startTs, endTs);

        const result = stats.map((s: any) => ({
          ...s,
          workTime: Number((workTimeByUser.get(String(s.userId || '')) || 0).toFixed(2)),
          manualBoxCount: boxCounts[s.userId] || 0,
          folders: Array.from(foldersByUser[s.userId] || [])
        }));
        analyticsCache.set(cacheKey, {
          expiresAt: now + ANALYTICS_CACHE_TTL_MS,
          data: result
        });
        return result;
      };

      const UNMAPPED_PROJECT_ID = '__unmapped__';
      const buildAnalyticsByRangeByProject = (startTs: number, endTs: number) => {
        const cacheKey = `proj:${startTs}:${endTs}`;
        const now = Date.now();
        const cached = analyticsCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
          return cached.data;
        }
        const projectMap = readProjectMap();
        const projects = readProjects();
        const effFolderExpr = `COALESCE(NULLIF(TRIM(l.folder), ''), 'Unsorted')`;
        const folderAgg = db
          .prepare(
            `
          SELECT
            ${effFolderExpr} as folder,
            COUNT(DISTINCT CASE
              WHEN UPPER(l.action) = 'SUBMIT' AND l.taskId IS NOT NULL AND TRIM(l.taskId) <> '' THEN l.taskId
            END) as submissions,
            COUNT(CASE WHEN UPPER(l.action) = 'APPROVE' THEN 1 END) as approvals,
            COUNT(CASE WHEN UPPER(l.action) = 'REJECT' THEN 1 END) as rejections,
            MAX(l.timestamp) as lastActive,
            SUM(CASE WHEN UPPER(l.action) = 'SUBMIT' THEN COALESCE(l.durationSeconds, 0) ELSE 0 END) as submitDurationSum
          FROM ${ALL_LOGS_FROM} l
          WHERE l.timestamp >= ? AND l.timestamp <= ?
          GROUP BY ${effFolderExpr}
        `
          )
          .all(startTs, endTs) as Array<{
          folder: string;
          submissions: number;
          approvals: number;
          rejections: number;
          lastActive: number;
          submitDurationSum: number;
        }>;

        const boxRows = db
          .prepare(
            `
          SELECT ${effFolderExpr} as folder, l.stats as stats
          FROM ${ALL_LOGS_FROM} l
          WHERE l.timestamp >= ? AND l.timestamp <= ?
            AND l.stats IS NOT NULL AND TRIM(l.stats) <> ''
            AND UPPER(l.action) = 'SUBMIT'
        `
          )
          .all(startTs, endTs) as Array<{ folder: string; stats: string }>;

        const manualByFolder: Record<string, number> = {};
        boxRows.forEach((r) => {
          const f = String(r.folder || '').trim();
          if (!f) return;
          try {
            const s = JSON.parse(r.stats) as { manualBoxCount?: number };
            if (s.manualBoxCount) {
              manualByFolder[f] = (manualByFolder[f] || 0) + Number(s.manualBoxCount);
            }
          } catch {
            /* ignore */
          }
        });

        const sessionRows = db
          .prepare(
            `
          SELECT l.userId as userId, l.taskId as taskId, l.folder as folder,
            UPPER(l.action) as action, l.timestamp as timestamp, l.durationSeconds as durationSeconds
          FROM ${ALL_LOGS_FROM} l
          WHERE l.timestamp >= ? AND l.timestamp <= ?
            AND UPPER(l.action) IN ('START', 'SAVE', 'SUBMIT')
          ORDER BY l.userId ASC, l.taskId ASC, l.timestamp ASC
        `
          )
          .all(startTs, endTs) as Array<{
          userId: string;
          taskId: string;
          folder: string;
          action: string;
          timestamp: number;
          durationSeconds: number;
        }>;

        const workSecByFolder = new Map<string, number>();
        const lastStartByKey = new Map<string, { ts: number; folder: string }>();
        const normFolder = (raw: string, prevFolder: string) => {
          const t = String(raw || '').trim();
          if (t) return t;
          const p = String(prevFolder || '').trim();
          if (p) return p;
          return 'Unsorted';
        };
        sessionRows.forEach((row) => {
          const userId = String(row.userId || '').trim();
          const taskId = String(row.taskId || '').trim() || '__no_task__';
          const key = `${userId}::${taskId}`;
          const action = String(row.action || '').toUpperCase();
          const ts = Number(row.timestamp || 0);
          const rawFolder = String(row.folder || '').trim();
          const duration = Number(row.durationSeconds || 0);
          if (action === 'START' || action === 'SAVE') {
            const prev = lastStartByKey.get(key);
            lastStartByKey.set(key, { ts, folder: normFolder(rawFolder, prev?.folder || '') });
            return;
          }
          if (action === 'SUBMIT') {
            const prev = lastStartByKey.get(key);
            const f = normFolder(rawFolder, prev?.folder || '');
            let deltaSec = 0;
            if (prev && prev.ts > 0 && ts >= prev.ts) {
              deltaSec = (ts - prev.ts) / 1000;
            } else if (duration > 0) {
              deltaSec = duration;
            }
            const safeSec = clampSeconds(Number(deltaSec || 0));
            workSecByFolder.set(f, (workSecByFolder.get(f) || 0) + safeSec);
            lastStartByKey.set(key, { ts: 0, folder: '' });
          }
        });

        const byProject = new Map<
          string,
          {
            submissions: number;
            approvals: number;
            rejections: number;
            workTime: number;
            manualBoxCount: number;
            folders: Set<string>;
            lastActive: number;
          }
        >();

        const ensure = (pid: string) => {
          if (!byProject.has(pid)) {
            byProject.set(pid, {
              submissions: 0,
              approvals: 0,
              rejections: 0,
              workTime: 0,
              manualBoxCount: 0,
              folders: new Set<string>(),
              lastActive: 0
            });
          }
          return byProject.get(pid)!;
        };

        folderAgg.forEach((row) => {
          const folder = String(row.folder || '').trim();
          if (!folder) return;
          const resolved = resolveProjectIdForAnalyticsFolder(folder, projectMap, projects);
          const pid = resolved?.projectId ? String(resolved.projectId) : UNMAPPED_PROJECT_ID;
          const cur = ensure(pid);
          const sessionWt = workSecByFolder.get(folder) || 0;
          const fallbackWt = Number(row.submitDurationSum || 0);
          const wt = sessionWt > 0 ? sessionWt : fallbackWt;
          cur.submissions += Number(row.submissions || 0);
          cur.approvals += Number(row.approvals || 0);
          cur.rejections += Number(row.rejections || 0);
          cur.workTime += wt;
          cur.manualBoxCount += manualByFolder[folder] || 0;
          cur.folders.add(folder);
          cur.lastActive = Math.max(cur.lastActive, Number(row.lastActive || 0));
        });

        const projectName = (id: string) => {
          if (id === UNMAPPED_PROJECT_ID) return '프로젝트 미매핑';
          const p = projects[id];
          const n = p && typeof p.name === 'string' ? p.name.trim() : '';
          return n || id;
        };

        const result = Array.from(byProject.entries())
          .map(([projectId, v]) => ({
            projectId,
            projectName: projectName(projectId),
            submissions: v.submissions,
            approvals: v.approvals,
            rejections: v.rejections,
            workTime: Number(v.workTime.toFixed(2)),
            manualBoxCount: v.manualBoxCount,
            folders: Array.from(v.folders).sort((a, b) =>
              a.localeCompare(b, undefined, { numeric: true })
            ),
            lastActive: v.lastActive
          }))
          .sort((a, b) =>
            a.projectName.localeCompare(b.projectName, undefined, {
              numeric: true,
              sensitivity: 'base'
            })
          );

        analyticsCache.set(cacheKey, {
          expiresAt: now + ANALYTICS_CACHE_TTL_MS,
          data: result
        });
        return result;
      };

      if (req.url.startsWith('/api/plugins') && req.method === 'GET') {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          if (url.pathname === '/api/plugins') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              plugins: [
                { sourceType: 'native-yolo', label: 'Native YOLO', supportsWorkflow: true, supportsMigration: false },
                { sourceType: 'vlm-review', label: 'VLM Review', supportsWorkflow: true, supportsMigration: true }
              ]
            }));
            return;
          }
          if (url.pathname === '/api/plugins/vlm/dry-run') {
            const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 100)));
            const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
            const { total, rows } = readVlmRows(limit, offset);
            const sample = rows.slice(0, 10).map((row: any) => {
              let parsedData: any = null;
              try { parsedData = row?.data ? JSON.parse(row.data) : null; } catch (_e) { }
              const sourceFile = String(row?.source_file || 'vlm_unknown.json');
              const sourceRefId = String(row?.original_id || row?.id || '');
              const taskId = `vlm:${sourceFile}:${sourceRefId}`;
              const imageValue = String(parsedData?.image || '').trim();
              const status = normalizeVlmToTaskStatus(row?.status, row?.rating_code);
              return {
                taskId,
                sourceFile,
                sourceRefId,
                image: imageValue || null,
                mappedFolder: buildVlmFolderName(sourceFile),
                mappedStatus: status,
                assignedWorker: String(row?.assigned_to || row?.user || '').trim() || null,
                completedAt: parseVlmTimestamp(row?.completed_at),
                validatedAt: parseVlmTimestamp(row?.valid_at)
              };
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              total,
              limit,
              offset,
              sampleCount: sample.length,
              sample
            }));
            return;
          }
          if (url.pathname === '/api/plugins/vlm/import-json/files') {
            const countBySource = new Map<string, number>();
            try {
              const rows = db.prepare(`
                SELECT sourceFile, COUNT(*) as cnt FROM vlm_tasks
                WHERE assignedWorker IS NOT NULL AND TRIM(assignedWorker) <> ''
                GROUP BY sourceFile
              `).all() as Array<{ sourceFile: string; cnt: number }>;
              rows.forEach((r: any) => countBySource.set(String(r.sourceFile || ''), Number(r.cnt || 0)));
            } catch (_) { }
            const files = listVlmImportJsonFiles().map((f) => {
              const stat = fs.statSync(f.absolutePath);
              let totalRows = 0;
              let parseError = '';
              try {
                const raw = fs.readFileSync(f.absolutePath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                  totalRows = parsed.length;
                } else {
                  parseError = 'JSON root must be an array';
                }
              } catch (e: any) {
                parseError = String(e?.message || 'Invalid JSON');
              }
              const alreadyImportedCount = countBySource.get(f.fileName) ?? 0;
              return {
                fileName: f.fileName,
                relativePath: f.relativePath,
                size: Number(stat.size || 0),
                modifiedAt: Number(stat.mtimeMs || 0),
                totalRows,
                parseError,
                alreadyImportedCount
              };
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ files }));
            return;
          }
          if (url.pathname === '/api/plugins/vlm/export-json/files') {
            const files = listVlmExportFilesFromDb();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ files }));
            return;
          }
          if (url.pathname === '/api/plugins/vlm/assign/source-files') {
            const projectId = String(url.searchParams.get('projectId') || '').trim();
            const projects = readProjects();
            const findProjectByRequestId = (pid: string): any | null => {
              if (!pid) return null;
              const rec =
                (projects as any)[pid] ||
                (projects as any)[String(pid)] ||
                Object.values(projects).find((p: any) => String(p?.id ?? '').trim() === pid);
              return rec || null;
            };
            const proj = findProjectByRequestId(projectId);
            const wf = proj ? normalizeWorkflowSourceType(proj.workflowSourceType) : null;
            const vlmScoped = Boolean(projectId && proj && wf === 'vlm-review');
            const vlmAllowed = vlmScoped ? projectVlmSourceFilesList(proj) : [];

            let list: Array<{ sourceFile: string; total: number; unassigned: number }>;

            if (vlmScoped) {
              if (vlmAllowed.length === 0) {
                list = [];
              } else {
                const ph = vlmAllowed.map(() => '?').join(',');
                const rows = db.prepare(`
                  SELECT sourceFile,
                    COUNT(*) as total,
                    COUNT(CASE WHEN assignedWorker IS NULL OR TRIM(COALESCE(assignedWorker, '')) = '' THEN 1 END) as unassigned
                  FROM vlm_tasks
                  WHERE sourceFile IN (${ph})
                  GROUP BY sourceFile
                `).all(...vlmAllowed) as Array<{ sourceFile: string; total: number; unassigned: number }>;
                const bySf = new Map(
                  rows.map((r: any) => [String(r.sourceFile || '').trim(), r] as const)
                );
                list = vlmAllowed.map((sf) => {
                  const r = bySf.get(sf);
                  return {
                    sourceFile: sf,
                    total: r ? Number(r.total || 0) : 0,
                    unassigned: r ? Number(r.unassigned || 0) : 0
                  };
                });
              }
            } else {
              const projectMap = readProjectMap();
              const folderList = projectId
                ? Object.entries(projectMap)
                  .filter(([, v]: [string, any]) => String(v?.projectId ?? '').trim() === projectId)
                  .map(([folder]) => folder)
                : [];
              const folderPlaceholders = folderList.length > 0 ? folderList.map(() => '?').join(',') : '';
              const folderFilter = folderList.length > 0 ? `AND folder IN (${folderPlaceholders})` : '';
              const rows = (folderList.length > 0
                ? db.prepare(`
                    SELECT sourceFile,
                      COUNT(*) as total,
                      COUNT(CASE WHEN assignedWorker IS NULL OR TRIM(COALESCE(assignedWorker, '')) = '' THEN 1 END) as unassigned
                    FROM vlm_tasks
                    WHERE 1=1 ${folderFilter}
                    GROUP BY sourceFile
                    ORDER BY sourceFile ASC
                  `).all(...folderList)
                : db.prepare(`
                    SELECT sourceFile,
                      COUNT(*) as total,
                      COUNT(CASE WHEN assignedWorker IS NULL OR TRIM(COALESCE(assignedWorker, '')) = '' THEN 1 END) as unassigned
                    FROM vlm_tasks
                    GROUP BY sourceFile
                    ORDER BY sourceFile ASC
                  `).all()) as Array<{ sourceFile: string; total: number; unassigned: number }>;
              list = rows.map((r: any) => ({
                sourceFile: String(r.sourceFile || ''),
                total: Number(r.total || 0),
                unassigned: Number(r.unassigned || 0)
              }));
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ sourceFiles: list }));
            return;
          }
          next();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/plugins/vlm/import-json') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const commit = Boolean(payload.commit === true);
            const sourceFiles = Array.isArray(payload.sourceFiles)
              ? payload.sourceFiles.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            if (sourceFiles.length === 0) {
              throw new Error('sourceFiles is required');
            }
            const imagePathMappings = Array.isArray(payload.imagePathMappings)
              ? payload.imagePathMappings.map((rule: any) => ({ from: String(rule?.from || ''), to: String(rule?.to || '') }))
              : [];
            const fileMap = new Map(listVlmImportJsonFiles().map((f) => [f.fileName, f.absolutePath]));
            const rows: any[] = [];
            const invalidFiles: string[] = [];
            sourceFiles.forEach((fileName: string) => {
              const absolutePath = fileMap.get(fileName);
              if (!absolutePath) {
                invalidFiles.push(fileName);
                return;
              }
              const raw = fs.readFileSync(absolutePath, 'utf-8');
              const parsed = JSON.parse(raw);
              if (!Array.isArray(parsed)) {
                invalidFiles.push(fileName);
                return;
              }
              parsed.forEach((item: any) => rows.push({ sourceFile: fileName, item }));
            });
            if (invalidFiles.length > 0) {
              throw new Error(`invalid files: ${invalidFiles.join(', ')}`);
            }

            const assignees = Array.isArray(payload.assignees)
              ? payload.assignees.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            const assignCount = Math.max(0, Math.floor(Number(payload.assignCount) || 0));
            const keepUnassigned = Boolean(payload.keepUnassigned === true);

            const transformed = rows
              .map((row: any) => normalizeJsonItemToTask(row.item, row.sourceFile, imagePathMappings))
              .sort((a: any, b: any) => {
                const sourceCmp = String(a.sourceFile || '').localeCompare(String(b.sourceFile || ''));
                if (sourceCmp !== 0) return sourceCmp;
                return toNumericLike(a.sourceRefId) - toNumericLike(b.sourceRefId);
              });
            const total = transformed.length;
            const missingImages = transformed.filter((row: any) => !row.imageExists).length;

            // Worker distribution logic
            const alreadyAssignedIds = new Set(
              (db.prepare("SELECT id FROM vlm_tasks WHERE assignedWorker IS NOT NULL AND TRIM(assignedWorker) <> ''").all() as any[])
                .map(r => r.id)
            );

            const unassignedInImport = transformed.filter(t => !alreadyAssignedIds.has(t.taskId));
            const skippedAlreadyAssigned = total - unassignedInImport.length;

            const toAssignLimit = (assignCount > 0) ? assignCount : unassignedInImport.length;
            const toAssign = unassignedInImport.slice(0, toAssignLimit);
            const remainUnassigned = unassignedInImport.slice(toAssignLimit);

            if (assignees.length > 0) {
              toAssign.forEach((item, idx) => {
                item.taskRecord.assignedWorker = assignees[idx % assignees.length];
              });
            }

            if (keepUnassigned) {
              remainUnassigned.forEach(item => {
                item.taskRecord.assignedWorker = null;
              });
            } else if (assignees.length > 0) {
              // If not keeping unassigned, wrap around or assign to first
              remainUnassigned.forEach((item, idx) => {
                item.taskRecord.assignedWorker = assignees[idx % assignees.length];
              });
            }

            if (commit) {
              const insertTask = db.prepare(`
                INSERT INTO vlm_tasks (
                  id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated,
                  sourceType, sourceRefId, sourceFile, sourceData
                ) VALUES (
                  @id, @name, @folder, @imageUrl, @txtPath, @assignedWorker, @status, @reviewerNotes, @isModified, @lastUpdated,
                  @sourceType, @sourceRefId, @sourceFile, @sourceData
                )
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name,
                  folder = excluded.folder,
                  imageUrl = excluded.imageUrl,
                  txtPath = excluded.txtPath,
                  assignedWorker = COALESCE(vlm_tasks.assignedWorker, excluded.assignedWorker),
                  status = excluded.status,
                  reviewerNotes = excluded.reviewerNotes,
                  isModified = excluded.isModified,
                  lastUpdated = excluded.lastUpdated,
                  sourceType = excluded.sourceType,
                  sourceRefId = excluded.sourceRefId,
                  sourceFile = excluded.sourceFile,
                  sourceData = excluded.sourceData
              `);
              db.transaction(() => {
                transformed.forEach((row: any) => insertTask.run(row.taskRecord));
              })();
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              commit,
              total,
              assignedCount: toAssign.length + (keepUnassigned ? 0 : remainUnassigned.length),
              unassignedCount: keepUnassigned ? remainUnassigned.length : 0,
              skippedAlreadyAssigned,
              missingImages,
              sourceFiles,
              assignedPreview: toAssign.slice(0, 50).map(t => ({
                taskId: t.taskId,
                sourceRefId: t.sourceRefId,
                assignedWorker: t.taskRecord.assignedWorker,
                imageExists: t.imageExists
              }))
            }));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/vlm/import-json') && req.method === 'DELETE') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const sourceFiles = Array.isArray(payload.sourceFiles)
              ? payload.sourceFiles.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            
            if (sourceFiles.length === 0) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'sourceFiles is required' }));
              return;
            }

            const placeholders = sourceFiles.map(() => '?').join(',');
            const result = db.prepare(`DELETE FROM vlm_tasks WHERE sourceFile IN (${placeholders})`).run(...sourceFiles);
            
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, deletedCount: result.changes }));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/vlm/assign') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const workerName = String(payload.workerName || '').trim();
            const count = Math.max(0, Math.floor(Number(payload.count) || 0));
            if (!workerName) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'workerName is required' }));
              return;
            }
            const projectId = payload.projectId ? String(payload.projectId).trim() : '';
            let sourceFilesFilter = Array.isArray(payload.sourceFiles)
              ? payload.sourceFiles.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            if (projectId && sourceFilesFilter.length === 0) {
              const projects = readProjects();
              const project = projects[projectId];
              const vlmSf = projectVlmSourceFilesList(project);
              if (vlmSf.length > 0) {
                sourceFilesFilter = vlmSf;
              }
            }
            let folderList: string[] = [];
            if (projectId && sourceFilesFilter.length === 0) {
              folderList = folderKeysMappedToProject(readProjectMap(), projectId);
            }
            const folderPlaceholders = folderList.length > 0 ? folderList.map(() => '?').join(',') : '';
            const folderClause = folderList.length > 0 ? `AND folder IN (${folderPlaceholders})` : '';
            const sourceFilePlaceholders = sourceFilesFilter.length > 0 ? sourceFilesFilter.map(() => '?').join(',') : '';
            const sourceFileClause = sourceFilesFilter.length > 0 ? `AND sourceFile IN (${sourceFilePlaceholders})` : '';
            const toAssign = db.prepare(`
              SELECT id FROM vlm_tasks
              WHERE (assignedWorker IS NULL OR TRIM(COALESCE(assignedWorker, '')) = '')
              ${folderClause}
              ${sourceFileClause}
              ORDER BY id ASC
              LIMIT ?
            `);
            const assignParams = [...(folderList.length > 0 ? folderList : []), ...(sourceFilesFilter.length > 0 ? sourceFilesFilter : []), count];
            const rows = toAssign.all(...assignParams) as Array<{ id: string }>;
            const ids = rows.map((r: any) => r.id);
            const now = Date.now();
            const updateStmt = db.prepare('UPDATE vlm_tasks SET assignedWorker = ?, lastUpdated = ? WHERE id = ?');
            db.transaction(() => {
              ids.forEach((id: string) => updateStmt.run(workerName, now, id));
            })();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ assigned: ids.length, taskIds: ids }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/vlm/unassign') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const workerName = String(payload.workerName || '').trim();
            const count = Math.max(0, Math.floor(Number(payload.count) || 0));
            if (!workerName) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'workerName is required' }));
              return;
            }
            const projectId = payload.projectId ? String(payload.projectId).trim() : '';
            let sourceFilesFilter = Array.isArray(payload.sourceFiles)
              ? payload.sourceFiles.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            if (projectId && sourceFilesFilter.length === 0) {
              const projects = readProjects();
              const project = projects[projectId];
              const vlmSf = projectVlmSourceFilesList(project);
              if (vlmSf.length > 0) {
                sourceFilesFilter = vlmSf;
              }
            }
            let folderList: string[] = [];
            if (projectId && sourceFilesFilter.length === 0) {
              folderList = folderKeysMappedToProject(readProjectMap(), projectId);
            }
            const folderPlaceholders = folderList.length > 0 ? folderList.map(() => '?').join(',') : '';
            const folderClause = folderList.length > 0 ? `AND folder IN (${folderPlaceholders})` : '';
            const sourceFilePlaceholders = sourceFilesFilter.length > 0 ? sourceFilesFilter.map(() => '?').join(',') : '';
            const sourceFileClause = sourceFilesFilter.length > 0 ? `AND sourceFile IN (${sourceFilePlaceholders})` : '';
            const toUnassign = db.prepare(`
              SELECT id FROM vlm_tasks
              WHERE assignedWorker = ?
              ${folderClause}
              ${sourceFileClause}
              ORDER BY lastUpdated ASC
              LIMIT ?
            `);
            const unassignParams = [workerName, ...(folderList.length > 0 ? folderList : []), ...(sourceFilesFilter.length > 0 ? sourceFilesFilter : []), count];
            const rows = toUnassign.all(...unassignParams) as Array<{ id: string }>;
            const ids = rows.map((r: any) => r.id);
            const now = Date.now();
            const updateStmt = db.prepare('UPDATE vlm_tasks SET assignedWorker = NULL, status = \'TODO\', lastUpdated = ? WHERE id = ?');
            db.transaction(() => {
              ids.forEach((id: string) => updateStmt.run(now, id));
            })();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ unassigned: ids.length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/native/assign') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const workerName = String(payload.workerName || '').trim();
            const count = Math.max(0, Math.floor(Number(payload.count) || 0));
            if (!workerName) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'workerName is required' }));
              return;
            }
            if (count < 1) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'count must be at least 1' }));
              return;
            }
            const projectId = String(payload.projectId || '').trim();
            if (!projectId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'projectId is required' }));
              return;
            }
            const projects = readProjects();
            const project =
              projects[projectId] ||
              projects[String(projectId)] ||
              Object.values(projects).find((p: any) => String(p?.id ?? '') === projectId);
            if (!project) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'Project not found' }));
              return;
            }
            const workflow = normalizeWorkflowSourceType(project.workflowSourceType);
            if (workflow === 'vlm-review') {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'vlm-review projects use /api/plugins/vlm/assign' }));
              return;
            }
            const projectMap = readProjectMap();
            const folderList = folderKeysMappedToProject(projectMap, projectId);
            /** 프로젝트 상세와 동일: 폴더 문자열을 위로 올라가며 매핑 조회(SQL LIKE 대신 JS — 환경별 LIKE/ESCAPE 이슈 제거) */
            const poolUnassignedSql = `(
              assignedWorker IS NULL
              OR TRIM(LOWER(COALESCE(assignedWorker, ''))) IN ('', 'unassigned', 'admin')
            )`;
            const typePreSqlAssign =
              workflow === 'image-classification'
                ? '1=1'
                : `COALESCE(sourceType, 'native-yolo') = 'native-yolo'`;
            let candidatesForAssign: Array<{ id: string; folder: string }> = [];
            const ids: string[] = [];
            if (folderList.length > 0) {
              candidatesForAssign = db
                .prepare(
                  `SELECT id, folder FROM tasks
                  WHERE ${poolUnassignedSql}
                  AND ${typePreSqlAssign}
                  ORDER BY name COLLATE NOCASE ASC, id ASC`
                )
                .all() as Array<{ id: string; folder: string }>;
              for (const row of candidatesForAssign) {
                const resolved = resolveProjectMapEntryForFolder(String(row.folder || '').trim(), projectMap);
                if (String(resolved?.projectId ?? '').trim() !== projectId) continue;
                ids.push(row.id);
                if (ids.length >= count) break;
              }
            }
            const now = Date.now();
            const updateStmt =
              workflow === 'image-classification'
                ? db.prepare(
                    'UPDATE tasks SET assignedWorker = ?, sourceType = \'image-classification\', lastUpdated = ? WHERE id = ?'
                  )
                : db.prepare('UPDATE tasks SET assignedWorker = ?, lastUpdated = ? WHERE id = ?');
            db.transaction(() => {
              ids.forEach((id: string) => updateStmt.run(workerName, now, id));
            })();
            res.setHeader('Content-Type', 'application/json');
            const assignBody: Record<string, unknown> = { assigned: ids.length, taskIds: ids };
            if (ids.length === 0) {
              assignBody.hint =
                folderList.length === 0
                  ? '_project_map.json 에 이 projectId 로 등록된 폴더 키가 없습니다.'
                  : '미배정 풀·워크플로 조건은 맞지만, 폴더→프로젝트 해석 결과가 이 프로젝트와 맞는 행이 없습니다. assignDebug 를 확인하세요.';
              const tasksTotal = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
              assignBody.assignDebug = {
                projectId,
                workflow,
                mapKeysForThisProject: folderList.length,
                mapKeysSample: folderList.slice(0, 5),
                poolAndTypeCandidateRows: candidatesForAssign.length,
                tasksTableRows: tasksTotal,
                folderSamples: candidatesForAssign.slice(0, 8).map((r) => ({
                  folder: r.folder,
                  resolvedToProjectId: resolveProjectMapEntryForFolder(String(r.folder || '').trim(), projectMap)?.projectId ?? null
                }))
              };
            }
            res.end(JSON.stringify(assignBody));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/native/unassign') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const workerName = String(payload.workerName || '').trim();
            const count = Math.max(0, Math.floor(Number(payload.count) || 0));
            if (!workerName) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'workerName is required' }));
              return;
            }
            if (count < 1) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'count must be at least 1' }));
              return;
            }
            const projectId = String(payload.projectId || '').trim();
            if (!projectId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'projectId is required' }));
              return;
            }
            const projects = readProjects();
            const project =
              projects[projectId] ||
              projects[String(projectId)] ||
              Object.values(projects).find((p: any) => String(p?.id ?? '') === projectId);
            if (!project) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'Project not found' }));
              return;
            }
            const workflow = normalizeWorkflowSourceType(project.workflowSourceType);
            if (workflow === 'vlm-review') {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'vlm-review projects use /api/plugins/vlm/unassign' }));
              return;
            }
            const projectMap = readProjectMap();
            const folderListUn = folderKeysMappedToProject(projectMap, projectId);
            const typePreSqlUnassign =
              workflow === 'image-classification'
                ? '1=1'
                : `COALESCE(sourceType, 'native-yolo') = 'native-yolo'`;
            const unassignCandidates = db
              .prepare(
                `SELECT id, folder FROM tasks
                WHERE assignedWorker = ?
                AND ${typePreSqlUnassign}
                AND status NOT IN ('SUBMITTED', 'APPROVED')
                ORDER BY lastUpdated ASC`
              )
              .all(workerName) as Array<{ id: string; folder: string }>;
            const ids: string[] = [];
            if (folderListUn.length > 0) {
              for (const row of unassignCandidates) {
                const resolved = resolveProjectMapEntryForFolder(String(row.folder || '').trim(), projectMap);
                if (String(resolved?.projectId ?? '').trim() !== projectId) continue;
                ids.push(row.id);
                if (ids.length >= count) break;
              }
            }
            const now = Date.now();
            const updateStmt = db.prepare(
              'UPDATE tasks SET assignedWorker = NULL, status = \'TODO\', lastUpdated = ? WHERE id = ?'
            );
            db.transaction(() => {
              ids.forEach((id: string) => updateStmt.run(now, id));
            })();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ unassigned: ids.length, taskIds: ids }));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message || String(e) }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/vlm/export-json') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const sourceFiles = Array.isArray(payload.sourceFiles)
              ? payload.sourceFiles.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            const onlySubmitted = payload.onlySubmitted !== false;
            const includeResult = payload.includeResult !== false;
            if (sourceFiles.length === 0) throw new Error('sourceFiles is required');

            const exportDir = path.resolve(datasetsDir, 'vlm_export');
            fs.mkdirSync(exportDir, { recursive: true });
            const savedFiles: Array<{ sourceFile: string; outputPath: string; count: number }> = [];

            sourceFiles.forEach((sourceFile: string) => {
              const rows = db.prepare(`
                SELECT sourceRefId, sourceData, status
                FROM vlm_tasks
                WHERE sourceFile = ?
                  ${onlySubmitted ? "AND status IN ('SUBMITTED', 'APPROVED')" : ''}
                ORDER BY
                  CASE WHEN CAST(sourceRefId AS INTEGER) IS NULL THEN 1 ELSE 0 END ASC,
                  CAST(sourceRefId AS INTEGER) ASC,
                  sourceRefId ASC
              `).all(sourceFile);

              const exported = rows.map((row: any) => {
                let parsed: any = {};
                try { parsed = row?.sourceData ? JSON.parse(row.sourceData) : {}; } catch (_e) { parsed = {}; }
                const rawData = parsed?.rawData && typeof parsed.rawData === 'object' ? parsed.rawData : {};
                const rawResultData = parsed?.rawResultData && typeof parsed.rawResultData === 'object' ? parsed.rawResultData : {};
                const fallbackAnswer = Array.isArray(rawData?.conversations)
                  ? (rawData.conversations.find((c: any) => ['gpt', 'assistant', 'model'].includes(String(c?.from || '').toLowerCase()))?.value || '')
                  : '';
                const editedAnswer = String(parsed?.ui?.editedGptResponse || rawResultData?.editedAnswer || '');
                const answer = editedAnswer || String(rawResultData.answer || fallbackAnswer || '');
                const originalAnswer = String(rawResultData.originalAnswer || fallbackAnswer || '');
                const merged = mergeVlmConversationAnswer(rawData, answer);
                const resultLabel = toExportResultLabel(
                  parsed?.ui?.reviewResult || rawResultData?.reviewResult,
                  row?.status
                );
                const indexValue = String(merged?.index || row?.sourceRefId || '');
                const imageValue = String(merged?.image || rawData?.image || '');
                if (!includeResult) {
                  return {
                    ...merged,
                    index: indexValue,
                    image: imageValue
                  };
                }
                return {
                  ...merged,
                  index: indexValue,
                  result: resultLabel,
                  original_response: originalAnswer,
                  image: imageValue
                };
              });

              const base = path.basename(sourceFile, path.extname(sourceFile));
              const suffix = onlySubmitted ? '__submitted' : '__all';
              const today = new Date();
              const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
              const outputName = `${base}${suffix}_${dateStr}.json`;
              const outputAbs = path.resolve(exportDir, outputName);
              fs.writeFileSync(outputAbs, JSON.stringify(exported, null, 2), 'utf-8');
              savedFiles.push({
                sourceFile,
                outputPath: path.relative(datasetsDir, outputAbs).replace(/\\/g, '/'),
                count: exported.length
              });
            });

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              onlySubmitted,
              includeResult,
              savedFiles
            }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/plugins/vlm/migrate') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const commit = Boolean(payload.commit === true);
            const limit = Math.max(1, Math.min(50000, Number(payload.limit || 10000)));
            const offset = Math.max(0, Number(payload.offset || 0));
            const { total, rows } = readVlmRows(limit, offset);
            const transformed = rows.map((row: any) => {
              let parsedData: any = null;
              let parsedResult: any = null;
              try { parsedData = row?.data ? JSON.parse(row.data) : null; } catch (_e) { }
              try { parsedResult = row?.result_data ? JSON.parse(row.result_data) : null; } catch (_e) { }
              const sourceFile = String(row?.source_file || 'vlm_unknown.json');
              const sourceRefId = String(row?.original_id || row?.id || '');
              const taskId = `vlm:${sourceFile}:${sourceRefId}`;
              const imageValue = String(parsedData?.image || '').trim();
              const syntheticImageKey = crypto.createHash('md5').update(taskId).digest('hex');
              const imageUrl = `/vlm/${syntheticImageKey}.json`;
              const mappedStatus = normalizeVlmToTaskStatus(row?.status, row?.rating_code);
              const assignedWorker = String(row?.assigned_to || row?.user || '').trim() || null;
              const reviewerNotes = [String(row?.valid_comment || '').trim(), String(row?.admin_comment || '').trim()]
                .filter(Boolean)
                .join('\n');
              const lastUpdated = Math.max(
                parseVlmTimestamp(row?.valid_at),
                parseVlmTimestamp(row?.completed_at),
                Date.now()
              );
              const sourceData = JSON.stringify({
                sourceType: 'vlm-review',
                rawData: parsedData,
                rawResultData: parsedResult,
                legacyStatus: row?.status || null,
                legacyRatingCode: row?.rating_code ?? null,
                legacyImage: imageValue || null
              });
              const taskRecord = {
                id: taskId,
                name: imageValue ? path.basename(imageValue) : `vlm_${sourceRefId || row?.id}.json`,
                folder: buildVlmFolderName(sourceFile),
                imageUrl,
                txtPath: null,
                assignedWorker,
                status: mappedStatus,
                reviewerNotes,
                isModified: 0,
                lastUpdated,
                sourceType: 'vlm-review',
                sourceRefId,
                sourceFile,
                sourceData
              };
              const submitTs = parseVlmTimestamp(row?.completed_at);
              const approveTs = parseVlmTimestamp(row?.valid_at);
              const submitLog = submitTs > 0 && String(row?.user || '').trim()
                ? {
                  id: `vlm-submit:${taskId}:${String(row.user).trim()}`,
                  taskId,
                  userId: String(row.user).trim(),
                  role: 'WORKER',
                  folder: taskRecord.folder,
                  action: 'SUBMIT',
                  timestamp: submitTs,
                  durationSeconds: 0,
                  isModified: 0,
                  stats: null,
                  sourceType: 'vlm-review'
                }
                : null;
              const approveLog = approveTs > 0 && String(row?.validator || '').trim()
                ? {
                  id: `vlm-approve:${taskId}:${String(row.validator).trim()}`,
                  taskId,
                  userId: String(row.validator).trim(),
                  role: 'REVIEWER',
                  folder: taskRecord.folder,
                  action: 'APPROVE',
                  timestamp: approveTs,
                  durationSeconds: 0,
                  isModified: 0,
                  stats: null,
                  sourceType: 'vlm-review'
                }
                : null;
              return { taskRecord, submitLog, approveLog };
            });
            if (commit) {
              const insertTask = db.prepare(`
                INSERT INTO vlm_tasks (
                  id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated,
                  sourceType, sourceRefId, sourceFile, sourceData
                ) VALUES (
                  @id, @name, @folder, @imageUrl, @txtPath, @assignedWorker, @status, @reviewerNotes, @isModified, @lastUpdated,
                  @sourceType, @sourceRefId, @sourceFile, @sourceData
                )
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name,
                  folder = excluded.folder,
                  assignedWorker = excluded.assignedWorker,
                  status = excluded.status,
                  reviewerNotes = excluded.reviewerNotes,
                  isModified = excluded.isModified,
                  lastUpdated = excluded.lastUpdated,
                  sourceType = excluded.sourceType,
                  sourceRefId = excluded.sourceRefId,
                  sourceFile = excluded.sourceFile,
                  sourceData = excluded.sourceData
              `);
              const insertLog = db.prepare(`
                INSERT INTO vlm_logs (id, taskId, userId, role, folder, action, timestamp, durationSeconds, isModified, stats, sourceType)
                VALUES (@id, @taskId, @userId, @role, @folder, @action, @timestamp, @durationSeconds, @isModified, @stats, @sourceType)
                ON CONFLICT(id) DO UPDATE SET
                  taskId = excluded.taskId,
                  userId = excluded.userId,
                  role = excluded.role,
                  folder = excluded.folder,
                  action = excluded.action,
                  timestamp = excluded.timestamp,
                  durationSeconds = excluded.durationSeconds,
                  isModified = excluded.isModified,
                  stats = excluded.stats,
                  sourceType = excluded.sourceType
              `);
              db.transaction(() => {
                transformed.forEach((item: any) => {
                  insertTask.run(item.taskRecord);
                  if (item.submitLog) insertLog.run(item.submitLog);
                  if (item.approveLog) insertLog.run(item.approveLog);
                });
              })();
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              commit,
              total,
              processed: transformed.length,
              insertedTasks: commit ? transformed.length : 0,
              estimatedLogs: transformed.reduce((acc: number, item: any) => acc + (item.submitLog ? 1 : 0) + (item.approveLog ? 1 : 0), 0)
            }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/datasets')) {
        if (req.method === 'GET' && (req.url || '').split('?')[0] === '/api/datasets/fs-children') {
          try {
            const datasetsDirFs = path.resolve(__dirname, 'datasets');
            const urlFs = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
            let pathParam = urlFs.searchParams.get('path') || '';
            pathParam = String(pathParam).replace(/\\/g, '/').trim();
            const segments = pathParam.split('/').filter((s) => s.length > 0);
            if (segments.some((s) => s === '..' || s === '.')) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ error: 'Invalid path' }));
            }
            const relFromRoot = segments.join('/');
            const targetDir = relFromRoot ? path.join(datasetsDirFs, ...segments) : datasetsDirFs;
            const resolvedTarget = path.resolve(targetDir);
            const resolvedRoot = path.resolve(datasetsDirFs);
            const relCheck = path.relative(resolvedRoot, resolvedTarget);
            if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ error: 'Path outside datasets root' }));
            }
            // 루트 datasets 폴더 없으면 생성(트리·동기화와 동일 기대 경로)
            if (!fs.existsSync(resolvedRoot)) {
              fs.mkdirSync(resolvedRoot, { recursive: true });
            }
            if (!fs.existsSync(resolvedTarget)) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ error: 'Not found' }));
            }
            if (!fs.statSync(resolvedTarget).isDirectory()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ error: 'Not a directory' }));
            }
            const entries = fs.readdirSync(resolvedTarget, { withFileTypes: true });
            const children = entries
              .filter((d) => d.isDirectory())
              .map((d) => {
                const name = d.name;
                const relPath = relFromRoot ? `${relFromRoot}/${name}` : name;
                return { name, relPath };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ children }));
          } catch (e: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: e?.message || String(e) }));
          }
        }
        if (req.method === 'POST' && (req.url || '').split('?')[0] === '/api/datasets/by-ids') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', (chunk) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const listCols =
                'id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated, sourceType, sourceRefId, sourceFile';
              const payload = body ? JSON.parse(body) : {};
              const raw = Array.isArray(payload.ids) ? payload.ids : [];
              const ids = raw.map((x: unknown) => String(x ?? '').trim()).filter(Boolean);
              const uniq = [...new Set(ids)];
              const MAX_IDS = 50000;
              if (uniq.length > MAX_IDS) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `Too many ids (max ${MAX_IDS} per request)` }));
                return;
              }
              if (uniq.length === 0) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify([]));
                return;
              }
              const placeholders = uniq.map(() => '?').join(',');
              const fromTasks = db
                .prepare(`SELECT ${listCols}, NULL as sourceData FROM tasks WHERE id IN (${placeholders})`)
                .all(...uniq) as any[];
              const fromVlm = db
                .prepare(`SELECT ${listCols}, NULL as sourceData FROM vlm_tasks WHERE id IN (${placeholders})`)
                .all(...uniq) as any[];
              const byId = new Map<string, any>();
              fromTasks.forEach((r: any) => byId.set(r.id, r));
              fromVlm.forEach((r: any) => byId.set(r.id, r));
              const tasksById = uniq
                .map((id: string) => byId.get(id))
                .filter(Boolean)
                .map(applyMappingRulesToTaskRow);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(tasksById));
            } catch (e: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: e?.message || String(e) }));
            }
          });
          return;
        }
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const idsParam = url.searchParams.get('ids') || '';
          const listCols = 'id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated, sourceType, sourceRefId, sourceFile';

          // Fetch by specific task IDs (e.g. after VLM assign so client can merge into cache)
          if (idsParam) {
            const ids = idsParam.split(',').map((s: string) => s.trim()).filter(Boolean);
            if (ids.length > 0) {
              const placeholders = ids.map(() => '?').join(',');
              const fromTasks = db.prepare(`SELECT ${listCols}, NULL as sourceData FROM tasks WHERE id IN (${placeholders})`).all(...ids) as any[];
              const fromVlm = db.prepare(`SELECT ${listCols}, NULL as sourceData FROM vlm_tasks WHERE id IN (${placeholders})`).all(...ids) as any[];
              const byId = new Map<string, any>();
              fromTasks.forEach((r: any) => byId.set(r.id, r));
              fromVlm.forEach((r: any) => byId.set(r.id, r));
              const tasksById = ids.map((id: string) => byId.get(id)).filter(Boolean).map(applyMappingRulesToTaskRow);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(tasksById));
              return;
            }
          }

          const limit = parseInt(url.searchParams.get('limit') || '5000');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const lastUpdated = parseInt(url.searchParams.get('lastUpdated') || '-1');
          const lastId = url.searchParams.get('lastId') || '';
          const workerFilter = url.searchParams.get('worker') || '';
          const folderFilter = url.searchParams.get('folder') || '';

          let tasks;
          let baseQuery = '';
          let params: any[] = [];

          let whereArr: string[] = [];
          let whereParams: any[] = [];
          if (workerFilter) {
            const wf = buildWorkerFilterSql(workerFilter);
            whereArr.push(wf.sql);
            whereParams.push(...wf.params);
          }
          if (folderFilter) pushFolderSubtreeWhere(whereArr, whereParams, folderFilter);

          const whereClause = whereArr.length > 0 ? `WHERE ${whereArr.join(" AND ")}` : "";
          const whereClauseVlm = whereArr.length > 0 ? `WHERE ${whereArr.join(" AND ")}` : "";

          if (lastUpdated !== -1 && lastId !== '') {
            // Use Keyset Pagination
            baseQuery = `
              SELECT merged_tasks.*, NULL as sourceData
              FROM (
                SELECT ${listCols} FROM tasks ${whereClause}
                UNION ALL
                SELECT ${listCols} FROM vlm_tasks ${whereClauseVlm}
              ) merged_tasks
              WHERE (merged_tasks.lastUpdated < ? OR (merged_tasks.lastUpdated = ? AND merged_tasks.id > ?))
              ORDER BY COALESCE(merged_tasks.lastUpdated, 0) DESC, merged_tasks.id ASC
              LIMIT ?
            `;
            params = [...whereParams, ...whereParams, lastUpdated, lastUpdated, lastId, limit];
          } else {
            // Fallback to Offset
            baseQuery = `
              SELECT merged_tasks.*, NULL as sourceData
              FROM (
                SELECT ${listCols} FROM tasks ${whereClause}
                UNION ALL
                SELECT ${listCols} FROM vlm_tasks ${whereClauseVlm}
              ) merged_tasks
              ORDER BY COALESCE(merged_tasks.lastUpdated, 0) DESC, merged_tasks.id ASC
              LIMIT ? OFFSET ?
            `;
            params = [...whereParams, ...whereParams, limit, offset];
          }

          tasks = (db.prepare(baseQuery).all(...params) as any[]).map(applyMappingRulesToTaskRow);
          if (workerFilter) {
            tasks = tasks.filter(
              (r: any) => String(r.assignedWorker || '').trim() === String(workerFilter).trim()
            );
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(tasks));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/task') && req.method === 'GET') {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const id = url.searchParams.get('id') || '';
          if (!id) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'id is required' }));
            return;
          }
          let row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
          if (!row) row = db.prepare('SELECT * FROM vlm_tasks WHERE id = ?').get(id);
          if (!row) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Task not found' }));
            return;
          }
          const mapped = applyMappingRulesToTaskRow(row);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(mapped));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/metadata') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);

            if (data.batch && Array.isArray(data.batch)) {
              db.transaction(() => data.batch.forEach(applyTaskMetadataUpdate))();
            } else {
              applyTaskMetadataUpdate(data);
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/folder-metadata')) {
        if (req.method === 'GET') {
          try {
            const data = db.prepare('SELECT * FROM folder_metadata').all();
            const result = {};
            data.forEach(row => {
              result[row.folder] = {
                assignedWorker: row.assignedWorker,
                tags: row.tags ? JSON.parse(row.tags) : [],
                memo: row.memo,
                lastUpdated: row.lastUpdated
              };
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { folder, updates } = JSON.parse(body);
              const existing = db.prepare('SELECT * FROM folder_metadata WHERE folder = ?').get(folder);
              const merged = { ...(existing || {}), ...updates };

              db.prepare(`
                INSERT INTO folder_metadata (folder, assignedWorker, tags, memo, lastUpdated)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(folder) DO UPDATE SET
                  assignedWorker = excluded.assignedWorker,
                  tags = excluded.tags,
                  memo = excluded.memo,
                  lastUpdated = excluded.lastUpdated
              `).run(
                folder,
                merged.assignedWorker,
                merged.tags ? JSON.stringify(merged.tags) : null,
                merged.memo,
                merged.lastUpdated || Date.now()
              );

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        }
      } else if (req.url.startsWith('/api/label-files')) {
        // GET /api/label-files: List .txt files in 'labels' folder
        try {
          const labelsDir = path.resolve(__dirname, 'labels');
          if (!fs.existsSync(labelsDir)) {
            fs.mkdirSync(labelsDir);
          }
          const files = fs.readdirSync(labelsDir).filter(f => f.endsWith('.txt'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/label') && req.method === 'GET') {
        // GET /api/label?path=...
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const labelPath = url.searchParams.get('path');
          if (!labelPath) throw new Error('Path required');

          const fullPath = path.resolve(__dirname, labelPath);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            res.setHeader('Content-Type', 'text/plain');
            res.end(content);
          } else {
            res.setHeader('Content-Type', 'text/plain');
            res.end('');
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(e.message);
        }
      } else if (req.url.startsWith('/api/assign-worker') && req.method === 'POST') {
        // POST /api/assign-worker (Body: { folderName: string, workerName: string | undefined })
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { folderName, workerName } = JSON.parse(body);
            const datasetsDir = path.resolve(__dirname, 'datasets');
            const assignee = (!workerName || workerName === 'Unassigned') ? null : String(workerName).trim();

            // Update DB for VLM tasks if applicable
            const vlmCount = db.prepare('SELECT COUNT(*) as c FROM vlm_tasks WHERE folder = ?').get(folderName) as { c: number };
            const nativeCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE folder = ?').get(folderName) as { c: number };
            const now = Date.now();

            if (Number(vlmCount?.c || 0) > 0) {
              db.prepare('UPDATE vlm_tasks SET assignedWorker = ?, lastUpdated = ? WHERE folder = ?').run(assignee, now, folderName);
            }
            if (Number(nativeCount?.c || 0) > 0) {
              db.prepare('UPDATE tasks SET assignedWorker = ?, lastUpdated = ? WHERE folder = ?').run(assignee, now, folderName);
            }

            db.prepare(`
              INSERT INTO folder_metadata (folder, assignedWorker, tags, memo, lastUpdated)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(folder) DO UPDATE SET assignedWorker = excluded.assignedWorker, lastUpdated = excluded.lastUpdated
            `).run(folderName, assignee, null, null, now);

            if (Number(vlmCount?.c || 0) > 0 && Number(nativeCount?.c || 0) === 0) {
              // VLM-only folders don't necessarily need disk moves if they are just virtual pointers,
              // but we should still handle the disk move if the folder actually exists.
            }

            let sourcePath = path.join(datasetsDir, folderName);
            if (!fs.existsSync(sourcePath)) {
              const workers = fs.readdirSync(datasetsDir).filter(f => fs.statSync(path.join(datasetsDir, f)).isDirectory());
              for (const w of workers) {
                const p = path.join(datasetsDir, w, folderName);
                if (fs.existsSync(p)) {
                  sourcePath = p;
                  break;
                }
              }
            }

            if (!fs.existsSync(sourcePath)) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'Folder not found' }));
              return;
            }

            let targetPath;
            if (!workerName || workerName === 'Unassigned') {
              targetPath = path.join(datasetsDir, folderName);
            } else {
              targetPath = path.join(datasetsDir, workerName, folderName);
              if (!fs.existsSync(path.join(datasetsDir, workerName))) {
                fs.mkdirSync(path.join(datasetsDir, workerName), { recursive: true });
              }
            }

            if (sourcePath !== targetPath) {
              if (fs.existsSync(targetPath)) {
                res.statusCode = 409;
                res.end(JSON.stringify({ error: 'Target folder already exists' }));
                return;
              }
              fs.renameSync(sourcePath, targetPath);
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/task-commit') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (!data?.metadata) {
              throw new Error('Metadata payload required');
            }

            db.transaction(() => {
              if (data?.label?.path) {
                const fullPath = path.resolve(__dirname, data.label.path);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                  fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(fullPath, data.label.content || '', 'utf-8');
              }
              const metaChanges = applyTaskMetadataUpdate(data.metadata);
              if (metaChanges === 0) {
                throw new Error(
                  'task-commit: DB에서 해당 작업 행을 찾지 못했습니다. UI의 API URL이 이 서버의 datasets.db를 쓰는지(id·imageUrl 일치) 확인하세요.'
                );
              }
            })();

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/save') && req.method === 'POST') {
        // POST /api/save (Body: { path: string, content: string })
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const fullPath = path.resolve(__dirname, data.path);

            // Ensure directory exists (optional, but safe)
            // fs.mkdirSync(path.dirname(fullPath), { recursive: true });

            fs.writeFileSync(fullPath, data.content, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/upload-image') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { fileName, content } = JSON.parse(body);
            if (!fileName || !content) throw new Error('fileName and content are required');

            const datasetsDir = path.resolve(__dirname, 'datasets');
            const noticeImagesDir = path.join(datasetsDir, '_notice_images');
            if (!fs.existsSync(noticeImagesDir)) {
              fs.mkdirSync(noticeImagesDir, { recursive: true });
            }

            // content is base64: "data:image/png;base64,iVBOR..."
            const base64Data = content.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');

            // Add timestamp to prevent name collisions
            const timestamp = Date.now();
            const safeFileName = `${timestamp}_${fileName.replace(/[^a-z0-9.]/gi, '_')}`;
            const filePath = path.join(noticeImagesDir, safeFileName);

            fs.writeFileSync(filePath, buffer);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              url: `/datasets/_notice_images/${safeFileName}`
            }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/users')) {
        const usersPath = path.resolve(__dirname, 'users.json');

        if (req.method === 'GET') {
          try {
            if (fs.existsSync(usersPath)) {
              const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(users));
            } else {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify([]));
            }
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              let users = [];
              if (fs.existsSync(usersPath)) {
                users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
              }

              // Check if update or create
              // If only username and password provided (and maybe accountType), check if exists
              const existingUserIndex = users.findIndex(u => u.username === data.username);

              if (existingUserIndex >= 0) {
                // Update existing user (e.g. password)
                // In a real app we would hash the password. here we just store plain text for now as per plan
                users[existingUserIndex].password = data.password;
                if (data.accountType) users[existingUserIndex].accountType = data.accountType;
              } else {
                // Create new user
                users.push({
                  username: data.username,
                  password: data.password, // Storing plain text as requested/planned due to no bcrypt
                  accountType: data.accountType || 'WORKER'
                });
              }

              fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        }
      } else if (req.url.startsWith('/api/issues/resolve') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { id, status, resolvedBy, resolutionNote } = JSON.parse(body);
            if (!id || !status || !resolvedBy) {
              throw new Error('id, status, resolvedBy are required');
            }
            const issue = db.prepare(`SELECT * FROM task_issues WHERE id = ?`).get(id);
            if (!issue) throw new Error('Issue not found');

            if (status === 'DELETE') {
              const datasetsDir = path.resolve(__dirname, 'datasets');
              const dateBucket = new Date().toISOString().slice(0, 10);
              const trashRoot = path.join(datasetsDir, '_trash', dateBucket);

              const moveToTrash = (absoluteSourcePath: string) => {
                if (!fs.existsSync(absoluteSourcePath)) return;
                const relative = path.relative(datasetsDir, absoluteSourcePath);
                if (relative.startsWith('..')) return;
                const targetPath = path.join(trashRoot, relative);
                fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                fs.renameSync(absoluteSourcePath, targetPath);
              };

              const imageRelative = String(issue.imageUrl || '').replace(/^\//, '');
              const imageAbsolute = path.resolve(__dirname, imageRelative);
              moveToTrash(imageAbsolute);

              const ext = path.extname(imageAbsolute);
              const labelAbsolute = imageAbsolute.substring(0, imageAbsolute.length - ext.length) + '.txt';
              moveToTrash(labelAbsolute);

              const now = Date.now();
              db.prepare("INSERT OR IGNORE INTO deleted_tasks (id, sourceType, timestamp) SELECT id, COALESCE(sourceType, 'native-yolo'), ? FROM tasks WHERE id = ? OR imageUrl = ?").run(now, issue.taskId, issue.imageUrl);
              db.prepare("INSERT OR IGNORE INTO deleted_tasks (id, sourceType, timestamp) SELECT id, COALESCE(sourceType, 'vlm-review'), ? FROM vlm_tasks WHERE id = ? OR imageUrl = ?").run(now, issue.taskId, issue.imageUrl);
              db.prepare(`DELETE FROM tasks WHERE id = ? OR imageUrl = ?`).run(issue.taskId, issue.imageUrl);
              db.prepare(`DELETE FROM vlm_tasks WHERE id = ? OR imageUrl = ?`).run(issue.taskId, issue.imageUrl);
            } else if (status === 'RESOLVED') {
              // Reset task status to TODO if the issue was resolved (i.e. rejected by admin or fixed)
              db.prepare(`UPDATE tasks SET status = 'TODO' WHERE (id = ? OR imageUrl = ?) AND status = 'ISSUE_PENDING'`).run(issue.taskId, issue.imageUrl);
              db.prepare(`UPDATE vlm_tasks SET status = 'TODO' WHERE (id = ? OR imageUrl = ?) AND status = 'ISSUE_PENDING'`).run(issue.taskId, issue.imageUrl);
            }

            db.prepare(`
              UPDATE task_issues
              SET status = ?, resolvedBy = ?, resolvedAt = ?, resolutionNote = ?
              WHERE id = ?
            `).run(status, resolvedBy, Date.now(), resolutionNote || '', id);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            console.error('Issue resolve failed:', e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message || 'Server error' }));
          }
        });
      } else if (req.url.startsWith('/api/issues/count') && req.method === 'GET') {
        try {
          const row = db.prepare(`
            SELECT COUNT(*) as openCount
            FROM task_issues
            WHERE status IN ('OPEN', 'IN_REVIEW')
          `).get();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ openCount: row?.openCount || 0 }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/issues')) {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const status = url.searchParams.get('status');
            let rows;
            if (status) {
              rows = db.prepare(`
                SELECT * FROM task_issues
                WHERE status = ?
                ORDER BY createdAt DESC
              `).all(status);
            } else {
              rows = db.prepare(`
                SELECT * FROM task_issues
                ORDER BY createdAt DESC
              `).all();
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(rows));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const {
                taskId,
                folder,
                imageUrl,
                type,
                reasonCode,
                createdBy
              } = JSON.parse(body);
              if (!taskId || !folder || !imageUrl || !type || !reasonCode || !createdBy) {
                throw new Error('taskId, folder, imageUrl, type, reasonCode, createdBy are required');
              }

              const existingOpen = db.prepare(`
                SELECT id FROM task_issues
                WHERE taskId = ? AND type = ? AND status IN ('OPEN', 'IN_REVIEW')
                LIMIT 1
              `).get(taskId, type);
              if (existingOpen) {
                res.statusCode = 409;
                res.end(JSON.stringify({ error: 'An open request already exists for this task and type.' }));
                return;
              }

              const id = crypto.randomUUID();
              db.prepare(`
                INSERT INTO task_issues (
                  id, taskId, folder, imageUrl, type, reasonCode, comment, status, createdBy, createdAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
              `).run(
                id,
                taskId,
                folder,
                imageUrl,
                type,
                reasonCode,
                '',
                createdBy,
                Date.now()
              );

              // Lock the task
              db.prepare(`UPDATE tasks SET status = 'ISSUE_PENDING' WHERE id = ?`).run(taskId);
              db.prepare(`UPDATE vlm_tasks SET status = 'ISSUE_PENDING' WHERE id = ?`).run(taskId);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, id }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        }
      } else if (req.url.startsWith('/api/vacations')) {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const start = url.searchParams.get('start');
            const end = url.searchParams.get('end');
            let rows;
            if (start && end) {
              rows = db.prepare(`
                SELECT * FROM vacations
                WHERE startDate <= ? AND endDate >= ?
                ORDER BY startDate ASC, userId ASC
              `).all(end, start);
            } else {
              rows = db.prepare(`
                SELECT * FROM vacations
                ORDER BY startDate ASC, userId ASC
              `).all();
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(rows));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { userId, startDate, endDate, days, note } = JSON.parse(body);
              if (!userId || !startDate || !endDate) {
                throw new Error('userId, startDate, endDate are required');
              }
              const parsedDays = Number(days || 1);
              if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
                throw new Error('days must be a positive number');
              }
              const id = crypto.randomUUID();
              db.prepare(`
                INSERT INTO vacations (id, userId, startDate, endDate, days, note, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).run(
                id,
                String(userId).trim(),
                String(startDate),
                String(endDate),
                parsedDays,
                note ? String(note) : '',
                Date.now()
              );
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, id }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        } else if (req.method === 'DELETE') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const id = url.searchParams.get('id');
            if (!id) throw new Error('id is required');
            db.prepare('DELETE FROM vacations WHERE id = ?').run(id);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        }
      } else if (req.url.startsWith('/api/schedule/board') && req.method === 'GET') {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const start = url.searchParams.get('start');
          const end = url.searchParams.get('end');
          if (!start || !end) throw new Error('start and end are required');

          const startTs = new Date(start).setHours(0, 0, 0, 0);
          const endTs = new Date(end).setHours(23, 59, 59, 999);
          if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
            throw new Error('Invalid date range');
          }

          const rows = db.prepare(`
            SELECT userId, folder, timestamp
            FROM (
              SELECT userId, folder, timestamp FROM logs
              UNION ALL
              SELECT userId, folder, timestamp FROM vlm_logs
            ) l
            WHERE timestamp >= ? AND timestamp <= ?
              AND folder IS NOT NULL
              AND TRIM(folder) <> ''
            ORDER BY timestamp ASC
          `).all(startTs, endTs);

          const toLocalYmd = (ts: number) => {
            const d = new Date(Number(ts));
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
          };

          const board: Record<string, Record<string, string[]>> = {};
          rows.forEach((row: any) => {
            const userId = String(row.userId || '').trim();
            const folder = String(row.folder || '').trim();
            if (!userId || !folder) return;
            const ymd = toLocalYmd(Number(row.timestamp));
            if (!board[userId]) board[userId] = {};
            if (!board[userId][ymd]) board[userId][ymd] = [];
            if (!board[userId][ymd].includes(folder)) board[userId][ymd].push(folder);
          });

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(board));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/projects/detail') && req.method === 'GET') {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const projectId = String(url.searchParams.get('projectId') || '').trim();
          const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') || 30)));
          if (!projectId) {
            throw new Error('projectId is required');
          }

          const projects = readProjects();
          const project = projects[projectId];
          if (!project) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Project not found' }));
            return;
          }
          const projectWorkflowSourceType = normalizeWorkflowSourceType(project.workflowSourceType);
          const projectStatus = String(project?.status || '').toUpperCase() === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
          if (projectStatus === 'ARCHIVED' && project?.archiveSnapshot) {
            const snapshot = project.archiveSnapshot;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ...snapshot,
              isArchived: true,
              archivedAt: Number(project.archivedAt || 0)
            }));
            return;
          }

          const projectMap = readProjectMap();
          const projectsForRules = projects as Record<string, { workflowSourceType?: string }>;
          const getVlmFoldersBySourceFileForDetail = (sourceFile: string): string[] => {
            try {
              return (
                db
                  .prepare('SELECT DISTINCT folder FROM vlm_tasks WHERE sourceFile = ?')
                  .all(sourceFile) as Array<{ folder: string }>
              )
                .map((r) => String(r.folder || '').trim())
                .filter(Boolean);
            } catch {
              return [];
            }
          };
          const projectMapForEffective = {
            ...projectMap,
            ...resolveProjectMapVlm(projects, getVlmFoldersBySourceFileForDetail)
          };
          const vlmDetailFiles = projectVlmSourceFilesList(project);
          const useVlmSourceFiles = projectWorkflowSourceType === 'vlm-review' && vlmDetailFiles.length > 0;

          let folders: Array<{ folder: string; taskCount: number; completedCount: number; submittedCount: number; approvedCount: number; rejectedCount: number; lastUpdated: number; assignedWorker: string }>;
          const workerMap = new Map<string, { userId: string; allocated: number; completed: number; progress: number }>();
          const wmapDetail = readWorkerFolderMap();

          if (useVlmSourceFiles) {
            const vlmPh = vlmDetailFiles.map(() => '?').join(',');
            const folderRows = db.prepare(`
              SELECT folder, COUNT(*) as taskCount,
                COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount,
                COUNT(CASE WHEN status = 'SUBMITTED' THEN 1 END) as submittedCount,
                COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approvedCount,
                COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejectedCount,
                MAX(COALESCE(lastUpdated, 0)) as lastUpdated,
                MAX(COALESCE(assignedWorker, '')) as assignedWorker
              FROM vlm_tasks WHERE sourceFile IN (${vlmPh})
              GROUP BY folder
            `).all(...vlmDetailFiles) as any[];
            folders = folderRows.map((row: any) => ({
              folder: String(row.folder || ''),
              taskCount: Number(row.taskCount || 0),
              completedCount: Number(row.completedCount || 0),
              submittedCount: Number(row.submittedCount || 0),
              approvedCount: Number(row.approvedCount || 0),
              rejectedCount: Number(row.rejectedCount || 0),
              lastUpdated: Number(row.lastUpdated || 0),
              assignedWorker: row.assignedWorker ? String(row.assignedWorker) : ''
            })).sort((a: any, b: any) => a.folder.localeCompare(b.folder));
            const vlmPerFolderStmt = db.prepare(`
              SELECT COALESCE(assignedWorker, '') as assignedWorker, COUNT(*) as taskCount,
                COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount
              FROM vlm_tasks WHERE sourceFile IN (${vlmPh}) AND folder = ?
              GROUP BY COALESCE(assignedWorker, '')
            `);
            folders.forEach((folderEntry: any) => {
              const f = String(folderEntry.folder || '').trim();
              if (!f) return;
              const perFolder = vlmPerFolderStmt.all(...vlmDetailFiles, f) as any[];
              perFolder.forEach((workerRow: any) => {
                const rawUserId = String(workerRow.assignedWorker || '').trim();
                const eff = effectiveAssignedWorkerForTaskFolder(f, rawUserId || null, wmapDetail) || '';
                const userId = eff.trim();
                if (!userId || userId.toLowerCase() === 'admin' || userId.toLowerCase() === 'unassigned') return;
                const addA = Number(workerRow.taskCount || 0);
                const addC = Number(workerRow.completedCount || 0);
                const cur = workerMap.get(userId) || { userId, allocated: 0, completed: 0, progress: 0 };
                cur.allocated += addA;
                cur.completed += addC;
                cur.progress = cur.allocated > 0 ? Number(((cur.completed / cur.allocated) * 100).toFixed(2)) : 0;
                workerMap.set(userId, cur);
              });
            });
          } else {
            const folderRowsRaw = db.prepare(`
              SELECT
                folder,
                sourceType,
                COUNT(*) as taskCount,
                COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount,
                COUNT(CASE WHEN status = 'SUBMITTED' THEN 1 END) as submittedCount,
                COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approvedCount,
                COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejectedCount,
                MAX(COALESCE(lastUpdated, 0)) as lastUpdated,
                MAX(COALESCE(assignedWorker, '')) as assignedWorker
              FROM (
                SELECT folder, status, lastUpdated, assignedWorker, COALESCE(sourceType, 'native-yolo') as sourceType FROM tasks
                UNION ALL
                SELECT folder, status, lastUpdated, assignedWorker, 'vlm-review' as sourceType FROM vlm_tasks
              ) t
              GROUP BY folder, sourceType
            `).all() as any[];
            const folderAgg = new Map<string, {
              folder: string;
              taskCount: number;
              completedCount: number;
              submittedCount: number;
              approvedCount: number;
              rejectedCount: number;
              lastUpdated: number;
              assignedWorker: string;
            }>();
            folderRowsRaw.forEach((row: any) => {
              const folder = String(row.folder || '').trim();
              if (!folder) return;
              if (resolveProjectMapEntryForFolder(folder, projectMap)?.projectId !== projectId) return;
              const effSt = effectiveSourceTypeForTaskFolder(
                folder,
                row.sourceType,
                projectMapForEffective,
                projectsForRules
              );
              if (effSt !== projectWorkflowSourceType) return;
              const lu = Number(row.lastUpdated || 0);
              const aw = row.assignedWorker ? String(row.assignedWorker) : '';
              const prev = folderAgg.get(folder);
              if (!prev) {
                folderAgg.set(folder, {
                  folder,
                  taskCount: Number(row.taskCount || 0),
                  completedCount: Number(row.completedCount || 0),
                  submittedCount: Number(row.submittedCount || 0),
                  approvedCount: Number(row.approvedCount || 0),
                  rejectedCount: Number(row.rejectedCount || 0),
                  lastUpdated: lu,
                  assignedWorker: aw
                });
              } else {
                prev.taskCount += Number(row.taskCount || 0);
                prev.completedCount += Number(row.completedCount || 0);
                prev.submittedCount += Number(row.submittedCount || 0);
                prev.approvedCount += Number(row.approvedCount || 0);
                prev.rejectedCount += Number(row.rejectedCount || 0);
                if (lu >= prev.lastUpdated) {
                  prev.lastUpdated = lu;
                  prev.assignedWorker = aw;
                }
              }
            });
            const fromDb = Array.from(folderAgg.values());
            const mappedFolderNames = Object.entries(projectMap || {})
              .filter(([, data]: [string, any]) => data?.projectId === projectId)
              .map(([folder]) => folder);
            const fromDbSet = new Set(fromDb.map((r: any) => r.folder));
            const emptyMapped = mappedFolderNames
              .filter((f) => !fromDbSet.has(f))
              .map((folder) => ({
                folder,
                taskCount: 0,
                completedCount: 0,
                submittedCount: 0,
                approvedCount: 0,
                rejectedCount: 0,
                lastUpdated: 0,
                assignedWorker: ''
              }));
            folders = [...fromDb, ...emptyMapped].sort((a: any, b: any) => a.folder.localeCompare(b.folder));

            if (projectWorkflowSourceType !== 'vlm-review') {
              const stCol =
                projectWorkflowSourceType === 'image-classification'
                  ? 'image-classification'
                  : 'native-yolo';
              const names = folders.map((f: any) => f.folder).filter((f: string) => f.length > 0);
              if (names.length > 0) {
                const ph = names.map(() => '?').join(',');
                const counts = db.prepare(
                  `SELECT folder,
                    COUNT(*) as cnt,
                    SUM(CASE WHEN assignedWorker IS NULL OR TRIM(LOWER(COALESCE(assignedWorker,''))) IN ('', 'unassigned', 'admin') THEN 1 ELSE 0 END) as unassignedCnt
                  FROM tasks
                  WHERE folder IN (${ph}) AND COALESCE(sourceType, 'native-yolo') = ?
                  GROUP BY folder`
                ).all(...names, stCol) as Array<{ folder: string; cnt: number; unassignedCnt: number }>;
                const cmap = new Map(counts.map((c) => [String(c.folder || ''), c]));
                folders.forEach((fr: any) => {
                  const c = cmap.get(fr.folder);
                  if (c) {
                    const cnt = Number(c.cnt || 0);
                    const un = Number(c.unassignedCnt || 0);
                    const u = cnt > 0 ? Math.min(fr.taskCount, Math.round((un * fr.taskCount) / cnt)) : fr.taskCount;
                    fr.unassignedTaskCount = u;
                    fr.assignedTaskCount = Math.max(0, fr.taskCount - u);
                  } else {
                    fr.unassignedTaskCount = fr.taskCount;
                    fr.assignedTaskCount = 0;
                  }
                });
              } else {
                folders.forEach((fr: any) => {
                  fr.unassignedTaskCount = fr.taskCount;
                  fr.assignedTaskCount = 0;
                });
              }
            }

            const allocationsByWorker = db.prepare(`
              SELECT
                COALESCE(assignedWorker, '') as assignedWorker,
                sourceType,
                COUNT(*) as taskCount,
                COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount
              FROM (
                SELECT folder, assignedWorker, status, COALESCE(sourceType, 'native-yolo') as sourceType FROM tasks
                UNION ALL
                SELECT folder, assignedWorker, status, 'vlm-review' as sourceType FROM vlm_tasks
              ) t
              WHERE folder = ?
              GROUP BY COALESCE(assignedWorker, ''), sourceType
            `);
            folders.forEach((folderRow: any) => {
              const rows = allocationsByWorker.all(folderRow.folder) as any[];
              rows.forEach((workerRow: any) => {
                const dbSt = workerRow.sourceType;
                const effSt = effectiveSourceTypeForTaskFolder(
                  folderRow.folder,
                  dbSt,
                  projectMapForEffective,
                  projectsForRules
                );
                if (effSt !== projectWorkflowSourceType) return;
                if (resolveProjectMapEntryForFolder(folderRow.folder, projectMap)?.projectId !== projectId) return;
                const rawUserId = String(workerRow.assignedWorker || '').trim();
                const eff = effectiveAssignedWorkerForTaskFolder(folderRow.folder, rawUserId || null, wmapDetail) || '';
                const userId = eff.trim();
                if (!userId || userId.toLowerCase() === 'admin' || userId.toLowerCase() === 'unassigned') return;
                const current = workerMap.get(userId) || { userId, allocated: 0, completed: 0, progress: 0 };
                current.allocated += Number(workerRow.taskCount || 0);
                current.completed += Number(workerRow.completedCount || 0);
                workerMap.set(userId, current);
              });
            });
          }

          const folderNames = folders.map((row: any) => row.folder);

          const projectTarget = Math.max(0, Number(project.targetTotal || 0));
          const allocated = Array.from(workerMap.values()).reduce((acc: number, w: any) => acc + Number(w.allocated || 0), 0);
          const completed = Array.from(workerMap.values()).reduce((acc: number, w: any) => acc + Number(w.completed || 0), 0);
          const progress = projectTarget > 0 ? Number(((completed / projectTarget) * 100).toFixed(2)) : 0;

          const endDate = new Date();
          endDate.setHours(23, 59, 59, 999);
          const startDate = new Date(endDate);
          startDate.setDate(endDate.getDate() - (days - 1));
          startDate.setHours(0, 0, 0, 0);
          const pad2 = (n: number) => String(n).padStart(2, '0');
          const toLocalYmdFromDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
          const parseYmdLocal = (ymd: string) => {
            const [y, m, d] = String(ymd || '').split('-').map((v) => Number(v));
            return new Date(y, Math.max(0, m - 1), d || 1);
          };
          const countWeekdaysInRange = (startYmd: string, endYmd: string) => {
            let count = 0;
            const cursor = parseYmdLocal(startYmd);
            const end = parseYmdLocal(endYmd);
            while (cursor.getTime() <= end.getTime()) {
              const day = cursor.getDay();
              if (day !== 0 && day !== 6) count += 1;
              cursor.setDate(cursor.getDate() + 1);
            }
            return count;
          };
          const countOverlapWeekdays = (vacStart: string, vacEnd: string, rangeStart: string, rangeEnd: string) => {
            const start = parseYmdLocal(vacStart);
            const end = parseYmdLocal(vacEnd);
            const rangeS = parseYmdLocal(rangeStart);
            const rangeE = parseYmdLocal(rangeEnd);
            const overlapStart = start.getTime() > rangeS.getTime() ? start : rangeS;
            const overlapEnd = end.getTime() < rangeE.getTime() ? end : rangeE;
            if (overlapStart.getTime() > overlapEnd.getTime()) return 0;
            return countWeekdaysInRange(toLocalYmdFromDate(overlapStart), toLocalYmdFromDate(overlapEnd));
          };
          const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
          const startYmd = toLocalYmdFromDate(startDate);
          const endYmd = toLocalYmdFromDate(endDate);

          const trendByDate = new Map<string, { date: string; submissions: number; workTimeSeconds: number }>();
          const perUserTrendMap = new Map<string, Map<string, { submissions: number; workTimeSeconds: number }>>();
          const userMetricsMap = new Map<string, {
            userId: string;
            submissions: number;
            totalTimeSeconds: number;
            lastTimestamp: number;
            workingDaySet: Set<string>;
            foldersWorkedSet: Set<string>;
          }>();
          for (let i = 0; i < days; i += 1) {
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i);
            const key = toLocalYmdFromDate(d);
            trendByDate.set(key, { date: key, submissions: 0, workTimeSeconds: 0 });
          }

          const trendRowsBySourceType = db.prepare(`
            SELECT
              date(timestamp / 1000, 'unixepoch', 'localtime') as ymd,
              COALESCE(userId, '') as userId,
              action,
              durationSeconds,
              timestamp,
              taskId
            FROM (
              SELECT timestamp, userId, action, durationSeconds, folder, taskId, COALESCE(sourceType, 'native-yolo') as sourceType FROM logs
              UNION ALL
              SELECT timestamp, userId, action, durationSeconds, folder, taskId, 'vlm-review' as sourceType FROM vlm_logs
            ) l
            WHERE timestamp >= ? AND timestamp <= ? AND folder = ? AND sourceType = ?
          `);
          const trendRowsAllSourceTypes = db.prepare(`
            SELECT
              date(timestamp / 1000, 'unixepoch', 'localtime') as ymd,
              COALESCE(userId, '') as userId,
              action,
              durationSeconds,
              timestamp,
              taskId,
              sourceType
            FROM (
              SELECT timestamp, userId, action, durationSeconds, folder, taskId, COALESCE(sourceType, 'native-yolo') as sourceType FROM logs
              UNION ALL
              SELECT timestamp, userId, action, durationSeconds, folder, taskId, 'vlm-review' as sourceType FROM vlm_logs
            ) l
            WHERE timestamp >= ? AND timestamp <= ? AND folder = ?
          `);
          const clampSeconds = (v: number, min: number = 0, max: number = 300) => Math.max(min, Math.min(max, v));
          folderNames.forEach((folderName: string) => {
            let rows: any[];
            if (useVlmSourceFiles) {
              rows = trendRowsBySourceType.all(
                startDate.getTime(),
                endDate.getTime(),
                folderName,
                projectWorkflowSourceType
              ) as any[];
            } else {
              rows = trendRowsAllSourceTypes.all(
                startDate.getTime(),
                endDate.getTime(),
                folderName
              ) as any[];
              rows = rows.filter((row: any) => {
                if (resolveProjectMapEntryForFolder(folderName, projectMap)?.projectId !== projectId) return false;
                const effLogSt = effectiveSourceTypeForTaskFolder(
                  folderName,
                  row.sourceType,
                  projectMapForEffective,
                  projectsForRules
                );
                return effLogSt === projectWorkflowSourceType;
              });
            }
            rows.sort((a: any, b: any) => {
              const u = String(a.userId || '').localeCompare(String(b.userId || ''));
              if (u !== 0) return u;
              const t = String(a.taskId || '').localeCompare(String(b.taskId || ''));
              if (t !== 0) return t;
              return Number(a.timestamp || 0) - Number(b.timestamp || 0);
            });
            const lastStartOrSaveByKey = new Map<string, number>();
            rows.forEach((row: any) => {
              const dateKey = String(row.ymd || '');
              const bucket = trendByDate.get(dateKey);
              const action = String(row.action || '').toUpperCase();
              const durationSeconds = Number(row.durationSeconds || 0);
              const userId = String(row.userId || '').trim() || 'Unknown';
              const taskId = String(row.taskId || '').trim() || '__no_task__';
              const timestamp = Number(row.timestamp || 0);
              const key = `${userId}::${taskId}`;
              const lastStartOrSave = lastStartOrSaveByKey.get(key) || 0;
              if (action === 'START' || action === 'SAVE') {
                lastStartOrSaveByKey.set(key, timestamp);
              }
              if (action === 'SUBMIT') {
                let workSec = 0;
                if (lastStartOrSave > 0 && timestamp >= lastStartOrSave) {
                  workSec = clampSeconds((timestamp - lastStartOrSave) / 1000);
                } else if (durationSeconds > 0) {
                  workSec = clampSeconds(durationSeconds);
                }
                if (bucket) {
                  bucket.submissions += 1;
                  bucket.workTimeSeconds += workSec;
                }
                let userTrend = perUserTrendMap.get(userId);
                if (!userTrend) {
                  userTrend = new Map<string, { submissions: number; workTimeSeconds: number }>();
                  perUserTrendMap.set(userId, userTrend);
                }
                const userBucket = userTrend.get(dateKey) || { submissions: 0, workTimeSeconds: 0 };
                userBucket.submissions += 1;
                userBucket.workTimeSeconds += workSec;
                userTrend.set(dateKey, userBucket);
                const metric = userMetricsMap.get(userId) || {
                  userId,
                  submissions: 0,
                  totalTimeSeconds: 0,
                  lastTimestamp: 0,
                  workingDaySet: new Set<string>(),
                  foldersWorkedSet: new Set<string>()
                };
                metric.submissions += 1;
                metric.totalTimeSeconds += workSec;
                if (timestamp > metric.lastTimestamp) {
                  metric.lastTimestamp = timestamp;
                }
                metric.workingDaySet.add(dateKey);
                metric.foldersWorkedSet.add(folderName);
                userMetricsMap.set(userId, metric);
                lastStartOrSaveByKey.set(key, 0);
              }
              const metric = userMetricsMap.get(userId) || {
                userId,
                submissions: 0,
                totalTimeSeconds: 0,
                lastTimestamp: 0,
                workingDaySet: new Set<string>(),
                foldersWorkedSet: new Set<string>()
              };
              if (timestamp > metric.lastTimestamp) {
                metric.lastTimestamp = timestamp;
              }
              if (folderName) metric.foldersWorkedSet.add(folderName);
              userMetricsMap.set(userId, metric);
            });
          });

          const vacationsInRange = db.prepare(`
            SELECT userId, startDate, endDate
            FROM vacations
            WHERE startDate <= ? AND endDate >= ?
          `).all(endYmd, startYmd);
          const vacationDaysByUser = new Map<string, number>();
          vacationsInRange.forEach((row: any) => {
            const userId = String(row.userId || '').trim();
            if (!userId) return;
            const overlapDays = countOverlapWeekdays(
              String(row.startDate || ''),
              String(row.endDate || ''),
              startYmd,
              endYmd
            );
            if (overlapDays <= 0) return;
            vacationDaysByUser.set(userId, Number((Number(vacationDaysByUser.get(userId) || 0) + overlapDays).toFixed(2)));
          });

          const detailsByUser = new Map<string, {
            userId: string;
            allocated: number;
            completed: number;
            progress: number;
            submissions: number;
            totalTimeSeconds: number;
            workingDays: number;
            vacationDays: number;
            foldersWorked: string[];
            lastTimestamp: number;
            isDummy?: boolean;
          }>();
          workerMap.forEach((row) => {
            detailsByUser.set(row.userId, {
              userId: row.userId,
              allocated: Number(row.allocated || 0),
              completed: Number(row.completed || 0),
              progress: row.allocated > 0 ? Number(((row.completed / row.allocated) * 100).toFixed(2)) : 0,
              submissions: 0,
              totalTimeSeconds: 0,
              workingDays: 0,
              vacationDays: Number(vacationDaysByUser.get(row.userId) || 0),
              foldersWorked: [],
              lastTimestamp: 0
            });
          });
          userMetricsMap.forEach((metric) => {
            const current = detailsByUser.get(metric.userId) || {
              userId: metric.userId,
              allocated: 0,
              completed: 0,
              progress: 0,
              submissions: 0,
              totalTimeSeconds: 0,
              workingDays: 0,
              vacationDays: 0,
              foldersWorked: [],
              lastTimestamp: 0
            };
            current.submissions = Number(metric.submissions || 0);
            current.totalTimeSeconds = Number(metric.totalTimeSeconds || 0);
            current.workingDays = Math.max(0, Number(metric.workingDaySet.size || 0));
            current.vacationDays = Number(vacationDaysByUser.get(metric.userId) || current.vacationDays || 0);
            current.foldersWorked = Array.from(metric.foldersWorkedSet).sort((a, b) => a.localeCompare(b));
            current.lastTimestamp = Number(metric.lastTimestamp || 0);
            detailsByUser.set(metric.userId, current);
          });

          const realRows = Array.from(detailsByUser.values()).filter((row) => row.userId !== '심아영');
          const activeSourceRows = realRows.filter((row) =>
            Number(row.submissions || 0) > 0 || Number(row.totalTimeSeconds || 0) > 0
          );
          const preferredSource = realRows.find((row) => row.userId === '김승희');
          const benchmarkSource = preferredSource || activeSourceRows[0] || realRows[0] || null;
          if (benchmarkSource) {
            const metricSourceRows = activeSourceRows.length > 0 ? activeSourceRows : [benchmarkSource];
            const totalSourceWorkingDays = metricSourceRows.reduce((acc, row) => acc + Math.max(0, Number(row.workingDays || 0)), 0);
            const totalSourceSubmitted = metricSourceRows.reduce((acc, row) => acc + Number(row.submissions || 0), 0);
            const totalSourceTime = metricSourceRows.reduce((acc, row) => acc + Number(row.totalTimeSeconds || 0), 0);
            const latestSourceTimestamp = metricSourceRows.reduce((maxTs, row) => Math.max(maxTs, Number(row.lastTimestamp || 0)), 0);
            const submittedPerWorkingDay = totalSourceWorkingDays > 0 ? totalSourceSubmitted / totalSourceWorkingDays : 0;
            const timePerWorkingDay = totalSourceWorkingDays > 0 ? totalSourceTime / totalSourceWorkingDays : 0;
            const benchmarkWorkingDays = Math.max(0, Number(benchmarkSource.workingDays || 0));
            const benchmarkVacationDays = Math.max(0, Number(benchmarkSource.vacationDays || 0));
            const benchmarkSubmitted = benchmarkWorkingDays > 0 ? Math.round(submittedPerWorkingDay * benchmarkWorkingDays) : 0;
            const benchmarkTime = benchmarkWorkingDays > 0 ? Number((timePerWorkingDay * benchmarkWorkingDays).toFixed(2)) : 0;
            const benchmarkLastTimestamp = latestSourceTimestamp > 0
              ? latestSourceTimestamp + (randomInt(-5, 5) * 60 * 1000)
              : 0;
            const dummyFolders = Array.from(benchmarkSource.foldersWorked || [])
              .map((folder) => String(folder).replace(/김승희/g, '심아영'));
            detailsByUser.set('심아영', {
              userId: '심아영',
              allocated: Number(benchmarkSource.allocated || 0),
              completed: Number(benchmarkSource.completed || 0),
              progress: Number(benchmarkSource.progress || 0),
              submissions: benchmarkSubmitted,
              totalTimeSeconds: benchmarkTime,
              workingDays: benchmarkWorkingDays,
              vacationDays: benchmarkVacationDays,
              foldersWorked: dummyFolders,
              lastTimestamp: benchmarkLastTimestamp,
              isDummy: true
            });
          }

          const dedupedWorkers = new Map<string, any>();
          Array.from(detailsByUser.values()).forEach((row) => {
            const existing = dedupedWorkers.get(row.userId);
            if (!existing) {
              dedupedWorkers.set(row.userId, { ...row });
              return;
            }
            const mergedFolders = new Set<string>([...(existing.foldersWorked || []), ...(row.foldersWorked || [])]);
            const mergedAllocated = Number(existing.allocated || 0) + Number(row.allocated || 0);
            const mergedCompleted = Number(existing.completed || 0) + Number(row.completed || 0);
            dedupedWorkers.set(row.userId, {
              ...existing,
              allocated: mergedAllocated,
              completed: mergedCompleted,
              progress: mergedAllocated > 0 ? Number(((mergedCompleted / mergedAllocated) * 100).toFixed(2)) : 0,
              submissions: Number(existing.submissions || 0) + Number(row.submissions || 0),
              totalTimeSeconds: Number(existing.totalTimeSeconds || 0) + Number(row.totalTimeSeconds || 0),
              workingDays: Math.max(Number(existing.workingDays || 0), Number(row.workingDays || 0)),
              vacationDays: Math.max(Number(existing.vacationDays || 0), Number(row.vacationDays || 0)),
              lastTimestamp: Math.max(Number(existing.lastTimestamp || 0), Number(row.lastTimestamp || 0)),
              foldersWorked: Array.from(mergedFolders).sort((a, b) => a.localeCompare(b)),
              isDummy: Boolean(existing.isDummy || row.isDummy)
            });
          });

          let workers = Array.from(dedupedWorkers.values())
            .sort((a, b) => {
              if (Boolean(a.isDummy) !== Boolean(b.isDummy)) return a.isDummy ? 1 : -1;
              return Number(b.completed || 0) - Number(a.completed || 0);
            })
            .map((row) => ({
              ...row,
              workTimeHours: Number((Number(row.totalTimeSeconds || 0) / 3600).toFixed(2))
            }));
          if (benchmarkSource && !workers.some((row: any) => row.userId === '심아영')) {
            workers = [
              ...workers,
              {
                userId: '심아영',
                allocated: Number(benchmarkSource.allocated || 0),
                completed: Number(benchmarkSource.completed || 0),
                progress: Number(benchmarkSource.progress || 0),
                submissions: 0,
                totalTimeSeconds: 0,
                workTimeHours: 0,
                workingDays: Math.max(0, Number(benchmarkSource.workingDays || 0)),
                vacationDays: Math.max(0, Number(benchmarkSource.vacationDays || 0)),
                foldersWorked: Array.from(benchmarkSource.foldersWorked || []).map((folder: string) => String(folder).replace(/김승희/g, '심아영')),
                lastTimestamp: Number(benchmarkSource.lastTimestamp || 0),
                isDummy: true
              }
            ];
          }

          for (const fr of folders) {
            if (projectWorkflowSourceType === 'vlm-review') {
              const eff = effectiveAssignedWorkerForTaskFolder(fr.folder, fr.assignedWorker, wmapDetail);
              fr.assignedWorker = eff || '';
            } else {
              fr.assignedWorker = '';
            }
          }

          let foldersForResponse = folders;
          if (benchmarkSource) {
            const sourceUserId = String(benchmarkSource.userId || '').trim();
            if (sourceUserId) {
              const clonedDummyFolders = folders
                .filter((row: any) => {
                  const assignedWorker = String(row.assignedWorker || '').trim();
                  return assignedWorker === sourceUserId || String(row.folder || '').includes(sourceUserId);
                })
                .map((row: any) => ({
                  ...row,
                  folder: String(row.folder || '').replace(new RegExp(sourceUserId, 'g'), '심아영'),
                  assignedWorker: '심아영'
                }));
              const folderKey = (row: any) => `${String(row.folder || '')}::${String(row.assignedWorker || '')}`;
              const dedupFolderMap = new Map<string, any>();
              [...folders, ...clonedDummyFolders].forEach((row: any) => {
                dedupFolderMap.set(folderKey(row), row);
              });
              foldersForResponse = Array.from(dedupFolderMap.values())
                .sort((a: any, b: any) => String(a.folder || '').localeCompare(String(b.folder || '')));
            }
          }

          const nativeAssignPool =
            projectWorkflowSourceType !== 'vlm-review'
              ? {
                  total: foldersForResponse.reduce((acc: number, f: any) => acc + Number(f.taskCount || 0), 0),
                  assigned: foldersForResponse.reduce((acc: number, f: any) => acc + Number(f.assignedTaskCount ?? 0), 0),
                  unassigned: foldersForResponse.reduce(
                    (acc: number, f: any) => acc + Number(f.unassignedTaskCount ?? f.taskCount ?? 0),
                    0
                  )
                }
              : undefined;

          const dummyTrendByDate = new Map<string, { submissions: number; workTimeSeconds: number }>();
          if (benchmarkSource) {
            const sourceUserTrend = perUserTrendMap.get(benchmarkSource.userId) || new Map<string, { submissions: number; workTimeSeconds: number }>();
            sourceUserTrend.forEach((value, dateKey) => {
              dummyTrendByDate.set(dateKey, {
                submissions: Number(value.submissions || 0),
                workTimeSeconds: Number(value.workTimeSeconds || 0)
              });
            });
          }

          const trends = Array.from(trendByDate.values()).map((row) => {
            const dummyValue = dummyTrendByDate.get(row.date) || { submissions: 0, workTimeSeconds: 0 };
            return {
              ...row,
              dummySubmissions: Number(dummyValue.submissions || 0),
              dummyWorkTimeSeconds: Number(dummyValue.workTimeSeconds || 0),
              dummyWorkTimeHours: Number((Number(dummyValue.workTimeSeconds || 0) / 3600).toFixed(2)),
              workTimeHours: Number((Number(row.workTimeSeconds || 0) / 3600).toFixed(2))
            };
          });

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            project: {
              id: project.id,
              name: project.name,
              targetTotal: projectTarget,
              workflowSourceType: projectWorkflowSourceType,
              vlmSourceFile: project?.vlmSourceFile || undefined,
              vlmSourceFiles:
                projectWorkflowSourceType === 'vlm-review' && vlmDetailFiles.length > 0 ? vlmDetailFiles : undefined,
              classificationClasses: Array.isArray(project?.classificationClasses) ? project.classificationClasses : undefined,
              visibleToWorkers: project?.visibleToWorkers === undefined ? true : Boolean(project?.visibleToWorkers),
              status: projectStatus,
              allocated,
              completed,
              progress,
              folderCount: folders.length,
              ...(nativeAssignPool ? { nativeAssignPool } : {})
            },
            workers,
            folders: foldersForResponse,
            trends
          }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === '/metrics') {
        try {
          const metrics = generatePrometheusMetrics();
          res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          res.end(metrics);
        } catch (e) {
          res.statusCode = 500;
          res.end(e.message);
        }
      } else if (req.url.startsWith('/api/projects/overview') && req.method === 'GET') {
        try {
          const payload = buildProjectOverview();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/projects/archive') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const projectId = String(payload.projectId || '').trim();
            if (!projectId) throw new Error('projectId is required');
            const projects = readProjects();
            const project = projects[projectId];
            if (!project) throw new Error('Project not found');
            const now = Date.now();
            const snapshot = payload?.snapshot && typeof payload.snapshot === 'object'
              ? payload.snapshot
              : {
                project: {
                  id: project.id,
                  name: project.name,
                  targetTotal: Number(project.targetTotal || 0),
                  workflowSourceType: normalizeWorkflowSourceType(project.workflowSourceType),
                  allocated: 0,
                  completed: 0,
                  progress: 0,
                  folderCount: 0
                },
                workers: [],
                folders: [],
                trends: []
              };
            if (!snapshot.project || typeof snapshot.project !== 'object') snapshot.project = {};
            snapshot.project = {
              ...snapshot.project,
              id: project.id,
              name: project.name,
              targetTotal: Number(project.targetTotal || 0),
              workflowSourceType: normalizeWorkflowSourceType(project.workflowSourceType),
              status: 'ARCHIVED'
            };
            projects[projectId] = {
              ...project,
              status: 'ARCHIVED',
              archivedAt: now,
              archiveSnapshot: snapshot,
              updatedAt: now
            };
            writeProjects(projects);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, project: projects[projectId] }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/projects/restore') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            const projectId = String(payload.projectId || '').trim();
            if (!projectId) throw new Error('projectId is required');
            const projects = readProjects();
            const project = projects[projectId];
            if (!project) throw new Error('Project not found');
            projects[projectId] = {
              ...project,
              status: 'ACTIVE',
              updatedAt: Date.now()
            };
            writeProjects(projects);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, project: projects[projectId] }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/projects/map')) {
        if (req.method === 'GET') {
          try {
            const rawMap = readProjectMap();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(rawMap));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { folder, projectId } = JSON.parse(body);
              if (!folder) {
                throw new Error('folder is required');
              }
              const map = readProjectMap();
              const now = Date.now();
              const folderNorm = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || folder;
              if (!projectId) {
                delete map[folderNorm];
                if (String(folder) !== folderNorm) delete map[folder];
              } else {
                map[folderNorm] = {
                  projectId: String(projectId),
                  updatedAt: now
                };
              }
              writeProjectMap(map);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        } else {
          next();
        }
      } else if (req.url.startsWith('/api/worker-folder-map')) {
        if (req.method === 'GET') {
          try {
            const raw = readWorkerFolderMap();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(raw));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { folder, workerName } = JSON.parse(body);
              if (!folder) throw new Error('folder is required');
              const folderNorm = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '') || String(folder);
              const map = readWorkerFolderMap();
              const now = Date.now();
              const assignee =
                workerName == null ||
                String(workerName).trim() === '' ||
                String(workerName).trim().toLowerCase() === 'unassigned'
                  ? null
                  : String(workerName).trim();
              if (!assignee) {
                delete map[folderNorm];
              } else {
                map[folderNorm] = { workerName: assignee, updatedAt: now };
              }
              writeWorkerFolderMap(map);

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: (e as Error).message }));
            }
          });
        } else {
          next();
        }
      } else if (req.url.startsWith('/api/projects')) {
        if (req.method === 'GET') {
          try {
            const projects = readProjects();
            const list = Object.values(projects)
              .map((row: any) => {
                const { archiveSnapshot, ...rest } = row || {};
                return rest;
              })
              .sort((a: any, b: any) => String(a.name || '').localeCompare(String(b.name || '')));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(list));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const {
                id,
                name,
                targetTotal,
                workflowSourceType,
                vlmSourceFile,
                vlmSourceFiles: vlmSourceFilesBody,
                classificationClasses,
                visibleToWorkers
              } = JSON.parse(body);
              if (!name || !String(name).trim()) {
                throw new Error('name is required');
              }
              const now = Date.now();
              const projects = readProjects();
              let projectId = id ? String(id) : toProjectId(String(name));
              while (!id && projects[projectId]) {
                projectId = `${projectId}-${Math.floor(Math.random() * 1000)}`;
              }
              const existing = projects[projectId];
              const wfType = normalizeWorkflowSourceType(workflowSourceType || existing?.workflowSourceType);
              const classes = wfType === 'image-classification' && classificationClasses != null
                ? (Array.isArray(classificationClasses) ? classificationClasses : [])
                : (existing?.classificationClasses || (wfType === 'image-classification' ? [] : undefined));
              const resolveNextVlmFiles = (): string[] => {
                if (Array.isArray(vlmSourceFilesBody)) {
                  const u = mergeUniqueTrimmedStrings(vlmSourceFilesBody.map((v: any) => String(v || '')));
                  if (u.length > 0) return u;
                }
                if (vlmSourceFile != null && String(vlmSourceFile).trim()) {
                  return [String(vlmSourceFile).trim()];
                }
                return projectVlmSourceFilesList(existing || {});
              };
              const nextVlmFiles = wfType === 'vlm-review' ? resolveNextVlmFiles() : [];
              projects[projectId] = {
                id: projectId,
                name: String(name).trim(),
                targetTotal: Math.max(0, Number(targetTotal || 0)),
                workflowSourceType: wfType,
                vlmSourceFiles: wfType === 'vlm-review' && nextVlmFiles.length > 0 ? nextVlmFiles : undefined,
                vlmSourceFile: wfType === 'vlm-review' && nextVlmFiles.length > 0 ? nextVlmFiles[0] : undefined,
                classificationClasses: wfType === 'image-classification' ? classes : undefined,
                visibleToWorkers: visibleToWorkers === undefined
                  ? (existing?.visibleToWorkers === undefined ? true : Boolean(existing?.visibleToWorkers))
                  : Boolean(visibleToWorkers),
                status: String(existing?.status || '').toUpperCase() === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
                archivedAt: Number(existing?.archivedAt || 0) || undefined,
                archiveSnapshot: existing?.archiveSnapshot,
                createdAt: Number(existing?.createdAt || now),
                updatedAt: now
              };
              writeProjects(projects);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, project: projects[projectId] }));
            } catch (e: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        } else if (req.method === 'DELETE') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { projectId } = JSON.parse(body);
              if (!projectId) {
                throw new Error('projectId is required');
              }
              const projects = readProjects();
              const project = projects[projectId];
              if (project) {
                const now = Date.now();
                const clearStmt = db.prepare('UPDATE vlm_tasks SET assignedWorker = NULL, lastUpdated = ? WHERE sourceFile = ?');
                projectVlmSourceFilesList(project).forEach((sf) => {
                  clearStmt.run(now, sf);
                });
                delete projects[projectId];
                writeProjects(projects);
              }
              const map = readProjectMap();
              let mapChanged = false;
              for (const [folder, data] of Object.entries(map)) {
                if (data.projectId === projectId) {
                  delete map[folder];
                  mapChanged = true;
                }
              }
              if (mapChanged) {
                writeProjectMap(map);
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e: any) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        } else {
          next();
        }
      } else if (req.url.startsWith('/api/groups')) {
        const groupsPath = path.resolve(__dirname, 'datasets', '_groups.json');

        if (req.method === 'GET') {
          try {
            if (fs.existsSync(groupsPath)) {
              const content = fs.readFileSync(groupsPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(content);
            } else {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({}));
            }
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { folder, groupName } = JSON.parse(body);
              let groups = {};
              if (fs.existsSync(groupsPath)) {
                groups = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
              }

              if (folder) {
                groups[folder] = { group: groupName };
                fs.writeFileSync(groupsPath, JSON.stringify(groups, null, 2), 'utf-8');
              }

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        }
      } else if (req.url?.startsWith('/api/sync') && req.method === 'POST') {
        try {
          const datasetsDir = path.resolve(__dirname, 'datasets');
          if (!fs.existsSync(datasetsDir)) {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true }));
          }
          const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
          const allowFull = url.searchParams.get('full') === '1';
          const projectId = url.searchParams.get('projectId')?.trim() || undefined;
          const foldersFromQuery = url.searchParams.getAll('folders').map((s) => s.trim()).filter(Boolean);
          const folderNames: string[] = [];
          if (projectId) {
            const projectMap = readProjectMap();
            Object.entries(projectMap).forEach(([folder, data]) => {
              if (data?.projectId === projectId) folderNames.push(folder);
            });
          }
          foldersFromQuery.forEach((f) => folderNames.push(f));
          const uniqueFolderNames = [...new Set(folderNames)];
          let includePaths: string[] = [];
          if (uniqueFolderNames.length > 0) {
            const validWorkers = getValidWorkerUsernames();
            const seen = new Set<string>();
            uniqueFolderNames.forEach((folderName) => {
              const candidates = [folderName, ...validWorkers.map((w) => `${w}/${folderName}`)];
              candidates.forEach((relPath) => {
                if (seen.has(relPath)) return;
                const fullPath = path.join(datasetsDir, relPath);
                if (fs.existsSync(fullPath)) {
                  seen.add(relPath);
                  includePaths.push(relPath);
                }
              });
            });
          }

          if (allowFull) {
            syncFilesToDb(datasetsDir);
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, partial: false, pathsCount: 0, full: true }));
          }
          if (uniqueFolderNames.length > 0) {
            if (includePaths.length === 0) {
              res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
              return res.end(
                JSON.stringify({
                  error: '지정한 프로젝트/폴더에 해당하는 경로가 datasets 아래에 없습니다.',
                  hint: '실제 디스크 경로를 확인하거나 full=1 로 전체 스캔(느림)을 사용하세요.'
                })
              );
            }
            syncFilesToDb(datasetsDir, { includePaths });
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ success: true, partial: true, pathsCount: includePaths.length }));
          }
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          return res.end(
            JSON.stringify({
              error: '디스크 스캔 범위가 없습니다. projectId 또는 folders 쿼리로 프로젝트(또는 폴더) 단위로 동기화하세요.',
              hint: '정말 datasets 전체를 스캔하려면 POST /api/sync?full=1 (시간이 오래 걸릴 수 있음)'
            })
          );
        } catch (e) {
          console.error(e);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/sync/delta') && req.method === 'GET') {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const since = parseInt(url.searchParams.get('since') || '0');
          const workerFilter = url.searchParams.get('worker') || '';
          const folderFilter = url.searchParams.get('folder') || '';

          const listCols = 'id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated, sourceType, sourceRefId, sourceFile';

          let whereArr = ["lastUpdated > ?"];
          let whereParams: any[] = [since];
          if (workerFilter) {
            const wf = buildWorkerFilterSql(workerFilter);
            whereArr.push(wf.sql);
            whereParams.push(...wf.params);
          }
          if (folderFilter) pushFolderSubtreeWhere(whereArr, whereParams, folderFilter);

          const whereClause = `WHERE ${whereArr.join(" AND ")}`;

          let updatedTasks = db.prepare(`
            SELECT merged_tasks.*, NULL as sourceData
            FROM (
              SELECT ${listCols} FROM tasks ${whereClause}
              UNION ALL
              SELECT ${listCols} FROM vlm_tasks ${whereClause}
            ) merged_tasks
            ORDER BY lastUpdated ASC
          `).all(...whereParams, ...whereParams) as any[];
          updatedTasks = updatedTasks.map(applyMappingRulesToTaskRow);
          if (workerFilter) {
            const wfTrim = String(workerFilter).trim();
            updatedTasks = updatedTasks.filter(
              (r: any) => String(r.assignedWorker || '').trim() === wfTrim
            );
          }

          const deletedTasks = db.prepare(`
            SELECT id FROM deleted_tasks WHERE timestamp > ?
          `).all(since).map((d: any) => d.id);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            updated: updatedTasks,
            deleted: deletedTasks,
            timestamp: Date.now()
          }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/logs')) {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const since = parseInt(url.searchParams.get('since') || '0');
            const logs = db.prepare(`
              SELECT * FROM logs WHERE timestamp > ?
              UNION ALL
              SELECT * FROM vlm_logs WHERE timestamp > ?
              ORDER BY timestamp ASC
            `).all(since, since);
            const formattedLogs = logs.map((l: any) => ({
              ...l,
              isModified: l.isModified === 1,
              stats: l.stats ? JSON.parse(l.stats) : undefined
            }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(formattedLogs));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === 'POST') {
          req.setEncoding('utf8');
          let body = '';
          req.on('data', chunk => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const incomingLogs = JSON.parse(body);
              const logsToInsert = Array.isArray(incomingLogs) ? incomingLogs : [incomingLogs];
              const insertNative = db.prepare(`
                INSERT INTO logs (id, taskId, userId, role, folder, action, timestamp, durationSeconds, isModified, stats, sourceType)
                VALUES (@id, @taskId, @userId, @role, @folder, @action, @timestamp, @durationSeconds, @isModified, @stats, @sourceType)
                ON CONFLICT(id) DO UPDATE SET
                  taskId = excluded.taskId,
                  userId = excluded.userId,
                  role = excluded.role,
                  folder = excluded.folder,
                  action = excluded.action,
                  timestamp = excluded.timestamp,
                  durationSeconds = CASE
                    WHEN UPPER(excluded.action) = 'SUBMIT'
                      THEN MIN(300, COALESCE(logs.durationSeconds, 0) + COALESCE(excluded.durationSeconds, 0))
                    ELSE MIN(300, COALESCE(excluded.durationSeconds, 0))
                  END,
                  isModified = excluded.isModified,
                  stats = excluded.stats,
                  sourceType = excluded.sourceType
              `);
              const insertVlm = db.prepare(`
                INSERT INTO vlm_logs (id, taskId, userId, role, folder, action, timestamp, durationSeconds, isModified, stats, sourceType)
                VALUES (@id, @taskId, @userId, @role, @folder, @action, @timestamp, @durationSeconds, @isModified, @stats, @sourceType)
                ON CONFLICT(id) DO UPDATE SET
                  taskId = excluded.taskId,
                  userId = excluded.userId,
                  role = excluded.role,
                  folder = excluded.folder,
                  action = excluded.action,
                  timestamp = excluded.timestamp,
                  durationSeconds = CASE
                    WHEN UPPER(excluded.action) = 'SUBMIT'
                      THEN MIN(300, COALESCE(vlm_logs.durationSeconds, 0) + COALESCE(excluded.durationSeconds, 0))
                    ELSE MIN(300, COALESCE(excluded.durationSeconds, 0))
                  END,
                  isModified = excluded.isModified,
                  stats = excluded.stats,
                  sourceType = excluded.sourceType
              `);
              const insertMany = db.transaction((logs) => {
                for (const log of logs) {
                  const normalizedSourceType = String(log.sourceType || 'native-yolo');
                  const payload = {
                    id: log.id,
                    taskId: log.taskId || '',
                    userId: log.userId || 'Unknown',
                    role: log.role || 'WORKER',
                    folder: log.folder || 'Unsorted',
                    action: log.action || 'SAVE',
                    timestamp: log.timestamp || Date.now(),
                    durationSeconds: Math.min(300, Math.max(0, Number(log.durationSeconds || 0))),
                    isModified: log.isModified ? 1 : 0,
                    stats: log.stats ? JSON.stringify(log.stats) : null,
                    sourceType: normalizedSourceType
                  };
                  if (normalizedSourceType === 'vlm-review') {
                    insertVlm.run(payload);
                  } else {
                    insertNative.run(payload);
                  }
                }
              });
              insertMany(logsToInsert);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true, count: logsToInsert.length }));
            } catch (e) {
              console.error("Log Sync Error:", e);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        }
      } else if (req.url.startsWith('/api/analytics/daily')) {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const dateStr = url.searchParams.get('date'); // YYYY-MM-DD
            if (!dateStr) throw new Error('Date required');

            // Calculate start/end of day timestamps
            const startOfDay = new Date(dateStr).setHours(0, 0, 0, 0);
            const endOfDay = new Date(dateStr).setHours(23, 59, 59, 999);
            const result = buildAnalyticsByRange(startOfDay, endOfDay);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        }
      } else if (req.url.startsWith('/api/analytics/range-by-project')) {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const start = url.searchParams.get('start');
            const end = url.searchParams.get('end');
            if (!start || !end) throw new Error('Start and end are required');

            const startTs = new Date(start).setHours(0, 0, 0, 0);
            const endTs = new Date(end).setHours(23, 59, 59, 999);
            if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
              throw new Error('Invalid date range');
            }

            const result = buildAnalyticsByRangeByProject(startTs, endTs);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e?.message || String(e) }));
          }
        }
      } else if (req.url.startsWith('/api/analytics/range')) {
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const start = url.searchParams.get('start');
            const end = url.searchParams.get('end');
            if (!start || !end) throw new Error('Start and end are required');

            const startTs = new Date(start).setHours(0, 0, 0, 0);
            const endTs = new Date(end).setHours(23, 59, 59, 999);
            if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
              throw new Error('Invalid date range');
            }

            const result = buildAnalyticsByRange(startTs, endTs);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        }
      } else if (req.url.startsWith('/api/analytics/summary')) {
        if (req.method === 'GET') {
          try {
            // Overall Project Stats
            const taskStats = db.prepare(`
              SELECT 
                COUNT(*) as totalTasks,
                COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as completedTasks,
                COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejectedTasks
              FROM (
                SELECT status FROM tasks
                UNION ALL
                SELECT status FROM vlm_tasks
              ) t
            `).get();

            // Total Work Time (All Time)
            const timeStats = db.prepare(`
              SELECT SUM(CASE WHEN UPPER(action) = 'SUBMIT' THEN COALESCE(durationSeconds, 0) ELSE 0 END) as totalWorkTime
              FROM (
                SELECT action, durationSeconds FROM logs
                UNION ALL
                SELECT action, durationSeconds FROM vlm_logs
              ) l
            `).get();

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              ...taskStats,
              totalWorkTime: timeStats.totalWorkTime || 0
            }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        }
      } else if (req.url.startsWith('/api/convert-folder') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const { folderName, limit, offset } = JSON.parse(body);
            const datasetsDir = path.resolve(__dirname, 'datasets');
            const cacheDir = path.join(datasetsDir, '.cache');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

            // 1. Find Folder
            let targetFolder = path.join(datasetsDir, folderName);
            if (!fs.existsSync(targetFolder)) {
              const workers = fs.readdirSync(datasetsDir).filter(f => fs.statSync(path.join(datasetsDir, f)).isDirectory());
              for (const w of workers) {
                const p = path.join(datasetsDir, w, folderName);
                if (fs.existsSync(p)) {
                  targetFolder = p;
                  break;
                }
              }
            }

            if (!fs.existsSync(targetFolder)) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'Folder not found' }));
              return;
            }

            // 2. Scan for Images
            const getImagesByDir = (dir: string): string[] => {
              let results: string[] = [];
              const list = fs.readdirSync(dir);
              list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                  results = results.concat(getImagesByDir(filePath));
                } else if (/\.(jpg|jpeg|png|bmp)$/i.test(file)) {
                  results.push(filePath);
                }
              });
              return results;
            }
            const allImages = getImagesByDir(targetFolder);

            // Apply Limit & Offset
            const start = offset || 0;
            const end = limit ? start + limit : allImages.length;
            const images = allImages.slice(start, end);

            // 3. Batch Convert (with parallel limit to avoid crashing)
            const concurrency = 5;
            for (let i = 0; i < images.length; i += concurrency) {
              const chunk = images.slice(i, i + concurrency);
              await Promise.all(chunk.map(async (filePath) => {
                const relativeToDatasets = path.relative(datasetsDir, filePath).replace(/\\/g, '/');
                const cacheKey = crypto.createHash('md5').update(relativeToDatasets).digest('hex') + '.webp';
                const cachePath = path.join(cacheDir, cacheKey);

                if (!fs.existsSync(cachePath)) {
                  try {
                    await sharp(filePath).webp({ quality: 80 }).toFile(cachePath);
                  } catch (e) {
                    console.error(`Conversion failed for ${filePath}:`, e);
                  }
                }
              }));
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              count: images.length,
              total: allImages.length,
              offset: start,
              limit: limit
            }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/login') && req.method === 'POST') {
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { username, password } = JSON.parse(body);
            const usersPath = path.resolve(__dirname, 'users.json');

            if (!fs.existsSync(usersPath)) {
              res.statusCode = 401;
              res.end(JSON.stringify({ error: 'Invalid credentials' }));
              return;
            }

            const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
            const user = users.find(u => u.username === username && u.password === password);

            if (user) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                username: user.username,
                accountType: user.accountType,
                token: 'mock-token-' + Date.now()
              }));
            } else {
              res.statusCode = 401;
              res.end(JSON.stringify({ error: 'Invalid credentials' }));
            }
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/datasets')) {
        // Fast static serving for datasets (no on-demand conversion)
        try {
          const urlObj = new URL(req.url, `http://${req.headers.host}`);
              const datasetsDir = path.resolve(__dirname, 'datasets');
          const relativePath = decodeURIComponent(urlObj.pathname.replace(/^\/datasets\/?/, ''));
          const normalizedRelativePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
          const filePath = path.resolve(datasetsDir, normalizedRelativePath);
          const relToRoot = path.relative(datasetsDir, filePath);
          if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
            res.statusCode = 403;
            res.end('Forbidden');
                return;
              }

          const fsPath = process.platform === 'win32' ? toWin32LongFsPath(filePath) : filePath;
          const stat = await fs.promises.stat(fsPath).catch(() => null);
          if (!stat || !stat.isFile()) {
            next();
                return;
            }

          const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.png': 'image/png',
              '.webp': 'image/webp',
              '.bmp': 'image/bmp',
              '.gif': 'image/gif'
            };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          fs.createReadStream(fsPath).pipe(res);
        } catch (e) {
          console.error("Static serve error:", e);
          next();
        }
      } else {
        next();
      }
    });
  };

  return {
    name: 'file-system-middleware',
    configureServer(server) {
      setupMiddlewares(server.middlewares);
    },
    configurePreviewServer(server) {
      setupMiddlewares(server.middlewares);
    }
  };
};

export default defineConfig({
  plugins: [react(), fileSystemMiddleware()],
  server: {
    port: 5174,
    host: true,
    open: true,
    watch: {
      // Prevent file-handle contention and heavy watcher churn on large dataset trees.
      ignored: ['**/datasets/**', '**/datasets.db']
    }
  }
});