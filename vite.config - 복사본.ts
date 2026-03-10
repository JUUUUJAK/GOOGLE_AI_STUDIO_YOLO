import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';
import Database from 'better-sqlite3';

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
    sourceData TEXT,
    UNIQUE(imageUrl)
  );
  CREATE INDEX IF NOT EXISTS idx_vlm_tasks_folder ON vlm_tasks(folder);
  CREATE INDEX IF NOT EXISTS idx_vlm_tasks_status ON vlm_tasks(status);

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
  CREATE INDEX IF NOT EXISTS idx_vacations_user_dates ON vacations(userId, startDate, endDate);
  CREATE INDEX IF NOT EXISTS idx_vacations_start_end ON vacations(startDate, endDate);
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

const applyTaskMetadataUpdate = (item: any) => {
  const { id, key, updates } = item;
  const imageUrl = key?.startsWith('/') ? key : (key ? '/datasets/' + key : null);
  const useVlmTable = String(updates?.sourceType || '').toLowerCase() === 'vlm-review' || String(id || '').startsWith('vlm:');
  const stmt = useVlmTable ? updateVlmTaskMetadataStmt : updateTaskMetadataStmt;
  stmt.run(
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

const syncFilesToDb = (datasetsDir: string) => {
  const validWorkers = getValidWorkerUsernames();

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
  const deleteMissing = db.prepare(`
    DELETE FROM tasks
    WHERE id NOT IN (SELECT id FROM temp_ids)
      AND COALESCE(sourceType, 'native-yolo') = 'native-yolo'
  `);

  // Prepare statement to check for existing record
  const getExistingStatus = db.prepare('SELECT status, assignedWorker FROM tasks WHERE id = ?');

  const scan = (dir: string, currentWorker?: string) => {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      if (file === '.cache') {
        return;
      }
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat && stat.isDirectory()) {
        let nextWorker = currentWorker;

        if (!currentWorker && dir === datasetsDir && validWorkers.includes(file)) {
          nextWorker = file;
        }

        scan(filePath, nextWorker);
      } else if (/\.(jpg|jpeg|png|webp|bmp)$/i.test(file)) {
        const ext = path.extname(file);
        const baseName = path.basename(file, ext);
        const txtPath = path.join(dir, baseName + '.txt');
        const relativePath = path.relative(__dirname, filePath).replace(/\\/g, '/');
        const metaKey = path.relative(datasetsDir, filePath).replace(/\\/g, '/');
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
          existing?.assignedWorker || currentWorker || fileMeta.assignedWorker || null,
          existing?.status || fileMeta.status || 'TODO',
          fileMeta.reviewerNotes || '',
          fileMeta.isModified ? 1 : 0,
          fileMeta.lastUpdated || Date.now(),
          'native-yolo'
        );
      }
    });
  };

  db.transaction(() => {
    scan(datasetsDir);
    deleteMissing.run();
  })();
  db.exec('DROP TABLE temp_ids');
};

// Middleware to handle file system operations
const fileSystemMiddleware = () => {
  const setupMiddlewares = (middlewares: any) => {
    const datasetsDir = path.resolve(__dirname, 'datasets');
    if (fs.existsSync(datasetsDir)) {
      syncFilesToDb(datasetsDir);
    }
    const projectsPath = path.resolve(datasetsDir, '_projects.json');
    const projectMapPath = path.resolve(datasetsDir, '_project_map.json');

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

    const normalizeWorkflowSourceType = (input: any): 'native-yolo' | 'vlm-review' => {
      return String(input || '').trim().toLowerCase() === 'vlm-review' ? 'vlm-review' : 'native-yolo';
    };

    const readProjects = (): Record<string, {
      id: string;
      name: string;
      targetTotal: number;
      workflowSourceType: 'native-yolo' | 'vlm-review';
      visibleToWorkers?: boolean;
      status?: 'ACTIVE' | 'ARCHIVED';
      archivedAt?: number;
      archiveSnapshot?: any;
      createdAt: number;
      updatedAt: number;
    }> => {
      const data = readJsonSafe(projectsPath, {});
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const normalized: Record<string, any> = {};
        Object.entries(data).forEach(([key, row]: any) => {
          normalized[key] = {
            ...row,
            workflowSourceType: normalizeWorkflowSourceType(row?.workflowSourceType),
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

    const toProjectId = (name: string) => {
      const base = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9가-힣]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return base || `project-${Date.now()}`;
    };

    const buildProjectOverview = () => {
      const projects = readProjects();
      const rawMap = readProjectMap();
      const folderStatsRows = db.prepare(`
        SELECT
          folder,
          sourceType,
          COUNT(*) as taskCount,
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

      const folderStatsBySource = new Map<string, Map<'native-yolo' | 'vlm-review', any>>();
      const folderStatsMergedMap = new Map<string, any>();
      folderStatsRows.forEach((row: any) => {
        const folder = String(row.folder || '');
        if (!folder) return;
        const sourceType = normalizeWorkflowSourceType(row.sourceType);
        const normalizedRow = {
          folder,
          taskCount: Number(row.taskCount || 0),
          completedCount: Number(row.completedCount || 0),
          lastUpdated: Number(row.lastUpdated || 0),
          assignedWorker: row.assignedWorker ? String(row.assignedWorker) : ''
        };
        const sourceMap = folderStatsBySource.get(folder) || new Map<'native-yolo' | 'vlm-review', any>();
        sourceMap.set(sourceType, normalizedRow);
        folderStatsBySource.set(folder, sourceMap);

        const merged = folderStatsMergedMap.get(folder) || {
          folder,
          taskCount: 0,
          completedCount: 0,
          nativeTaskCount: 0,
          vlmTaskCount: 0,
          lastUpdated: 0,
          assignedWorker: ''
        };
        const nextNativeTaskCount = Number(merged.nativeTaskCount || 0) + (sourceType === 'native-yolo' ? normalizedRow.taskCount : 0);
        const nextVlmTaskCount = Number(merged.vlmTaskCount || 0) + (sourceType === 'vlm-review' ? normalizedRow.taskCount : 0);
        folderStatsMergedMap.set(folder, {
          folder,
          taskCount: Number(merged.taskCount || 0) + normalizedRow.taskCount,
          completedCount: Number(merged.completedCount || 0) + normalizedRow.completedCount,
          nativeTaskCount: nextNativeTaskCount,
          vlmTaskCount: nextVlmTaskCount,
          lastUpdated: Math.max(Number(merged.lastUpdated || 0), normalizedRow.lastUpdated),
          assignedWorker: normalizedRow.assignedWorker || merged.assignedWorker || ''
        });
      });
      const folderStats = Array.from(folderStatsMergedMap.values());

      const existingFolders = new Set(folderStats.map((row: any) => row.folder));
      const projectMap: Record<string, { projectId: string; updatedAt: number }> = {};
      Object.entries(rawMap || {}).forEach(([folder, mapping]: any) => {
        if (existingFolders.has(folder) && mapping?.projectId) {
          projectMap[folder] = {
            projectId: String(mapping.projectId),
            updatedAt: Number(mapping.updatedAt || 0)
          };
        }
      });

      const statsByProject = new Map<string, { allocated: number; completed: number; folderCount: number }>();
      folderStats.forEach((row: any) => {
        const projectId = projectMap[row.folder]?.projectId;
        if (!projectId) return;
        const project = projects[projectId];
        const workflowSourceType = normalizeWorkflowSourceType(project?.workflowSourceType);
        const sourceStats = folderStatsBySource.get(row.folder)?.get(workflowSourceType) || {
          taskCount: 0,
          completedCount: 0
        };
        const current = statsByProject.get(projectId) || { allocated: 0, completed: 0, folderCount: 0 };
        statsByProject.set(projectId, {
          allocated: current.allocated + Number(sourceStats.taskCount || 0),
          completed: current.completed + Number(sourceStats.completedCount || 0),
          folderCount: current.folderCount + (Number(sourceStats.taskCount || 0) > 0 ? 1 : 0)
        });
      });

      const projectList = Object.values(projects).map((project: any) => {
        const stat = statsByProject.get(project.id) || { allocated: 0, completed: 0, folderCount: 0 };
        const status = String(project?.status || '').toUpperCase() === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
        const archivedProject = project?.archiveSnapshot?.project || {};
        const targetTotal = Math.max(0, Number(project.targetTotal || 0));
        const allocated = status === 'ARCHIVED' ? Number(archivedProject.allocated || stat.allocated || 0) : Number(stat.allocated || 0);
        const completed = status === 'ARCHIVED' ? Number(archivedProject.completed || stat.completed || 0) : Number(stat.completed || 0);
        const folderCount = status === 'ARCHIVED' ? Number(archivedProject.folderCount || stat.folderCount || 0) : Number(stat.folderCount || 0);
        const progress = status === 'ARCHIVED'
          ? Number(archivedProject.progress || (targetTotal > 0 ? ((completed / targetTotal) * 100) : 0))
          : (targetTotal > 0 ? Number(((completed / targetTotal) * 100).toFixed(2)) : 0);
        return {
          ...project,
          workflowSourceType: normalizeWorkflowSourceType(project.workflowSourceType),
          visibleToWorkers: project?.visibleToWorkers === undefined ? true : Boolean(project?.visibleToWorkers),
          status,
          targetTotal,
          allocated,
          completed,
          folderCount,
          progress
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      const unassigned = folderStats.reduce((acc: any, row: any) => {
        if (projectMap[row.folder]?.projectId) return acc;
        return {
          folderCount: acc.folderCount + 1,
          allocated: acc.allocated + Number(row.taskCount || 0),
          completed: acc.completed + Number(row.completedCount || 0)
        };
      }, { folderCount: 0, allocated: 0, completed: 0 });

      const folders = folderStats
        .map((row: any) => ({
          ...row,
          projectId: projectMap[row.folder]?.projectId || ''
        }))
        .sort((a: any, b: any) => a.folder.localeCompare(b.folder));

      return {
        projects: projectList,
        projectMap,
        unassigned,
        folders
      };
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

    middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/api/')) {
        console.log(`[API] ${req.method} ${req.url}`);
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
              return {
                fileName: f.fileName,
                relativePath: f.relativePath,
                size: Number(stat.size || 0),
                modifiedAt: Number(stat.mtimeMs || 0),
                totalRows,
                parseError
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
            const assignees = Array.isArray(payload.assignees)
              ? payload.assignees.map((v: any) => String(v || '').trim()).filter(Boolean)
              : [];
            const imagePathMappings = Array.isArray(payload.imagePathMappings)
              ? payload.imagePathMappings.map((rule: any) => ({ from: String(rule?.from || ''), to: String(rule?.to || '') }))
              : [];
            const keepUnassigned = payload.keepUnassigned !== false;
            const assignCountRaw = Number(payload.assignCount);
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

            const transformed = rows
              .map((row: any) => normalizeJsonItemToTask(row.item, row.sourceFile, imagePathMappings))
              .sort((a: any, b: any) => {
                const sourceCmp = String(a.sourceFile || '').localeCompare(String(b.sourceFile || ''));
                if (sourceCmp !== 0) return sourceCmp;
                return toNumericLike(a.sourceRefId) - toNumericLike(b.sourceRefId);
              });
            const total = transformed.length;
            const missingImages = transformed.filter((row: any) => !row.imageExists).length;
            const assignCount = Math.max(0, Math.min(total, Number.isFinite(assignCountRaw) ? Math.floor(assignCountRaw) : total));
            const assignableCount = assignees.length > 0 ? assignCount : 0;
            if (assignableCount > 0) {
              let cursor = 0;
              let remaining = assignableCount;
              assignees.forEach((assignee: string, idx: number) => {
                const workersLeft = assignees.length - idx;
                const quota = workersLeft > 0 ? Math.ceil(remaining / workersLeft) : 0;
                for (let i = 0; i < quota && cursor < assignableCount; i += 1) {
                  transformed[cursor].taskRecord.assignedWorker = assignee;
                  cursor += 1;
                  remaining -= 1;
                }
              });
            }
            if (!keepUnassigned) {
              const fallbackAssignee = assignees[assignees.length - 1] || null;
              transformed.forEach((row: any) => {
                if (!row.taskRecord.assignedWorker) {
                  row.taskRecord.assignedWorker = fallbackAssignee;
                }
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
                  assignedWorker = COALESCE(excluded.assignedWorker, vlm_tasks.assignedWorker),
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
            const assignedPreview = transformed.slice(0, 20).map((row: any) => ({
              taskId: row.taskId,
              sourceRefId: row.sourceRefId,
              assignedWorker: row.taskRecord.assignedWorker || null,
              imageExists: row.imageExists
            }));
            const assignedCount = transformed.filter((row: any) => Boolean(row.taskRecord.assignedWorker)).length;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              success: true,
              commit,
              total,
              assignedCount,
              unassignedCount: total - assignedCount,
              missingImages,
              sourceFiles,
              assignedPreview
            }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
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
                const answer = String(rawResultData.answer || fallbackAnswer || '');
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
              const outputName = `${base}${suffix}.json`;
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
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const limit = parseInt(url.searchParams.get('limit') || '5000');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const workerFilter = url.searchParams.get('worker') || '';

          // Exclude sourceData from list to keep payload small; use GET /api/task?id= for full task
          const listCols = 'id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated, sourceType, sourceRefId, sourceFile';
          let tasks;
          if (workerFilter) {
            tasks = db.prepare(`
              SELECT merged_tasks.*, NULL as sourceData
              FROM (
                SELECT ${listCols} FROM tasks WHERE assignedWorker = ?
                UNION ALL
                SELECT ${listCols} FROM vlm_tasks WHERE assignedWorker = ?
              ) merged_tasks
              ORDER BY COALESCE(merged_tasks.lastUpdated, 0) DESC, merged_tasks.id ASC
              LIMIT ? OFFSET ?
            `).all(workerFilter, workerFilter, limit, offset);
          } else {
            tasks = db.prepare(`
              SELECT merged_tasks.*, NULL as sourceData
              FROM (
                SELECT ${listCols} FROM tasks
                UNION ALL
                SELECT ${listCols} FROM vlm_tasks
              ) merged_tasks
              ORDER BY COALESCE(merged_tasks.lastUpdated, 0) DESC, merged_tasks.id ASC
              LIMIT ? OFFSET ?
            `).all(limit, offset);
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
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(row));
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

            // 1. Find Current Location
            // We need to look in datasets root AND in every worker folder
            let sourcePath = path.join(datasetsDir, folderName);
            if (!fs.existsSync(sourcePath)) {
              // Check in worker subfolders
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

            // 2. Determine Target Location
            let targetPath;
            if (!workerName || workerName === 'Unassigned') {
              targetPath = path.join(datasetsDir, folderName);
            } else {
              targetPath = path.join(datasetsDir, workerName, folderName);
              if (!fs.existsSync(path.join(datasetsDir, workerName))) {
                fs.mkdirSync(path.join(datasetsDir, workerName), { recursive: true });
              }
            }

            // 3. Move
            if (sourcePath !== targetPath) {
              if (fs.existsSync(targetPath)) {
                // Handle collision? For now just overwrite or error
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
                fs.writeFileSync(fullPath, data.label.content || '', 'utf-8');
              }
              applyTaskMetadataUpdate(data.metadata);
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

              db.prepare(`DELETE FROM tasks WHERE id = ? OR imageUrl = ?`).run(issue.taskId, issue.imageUrl);
              db.prepare(`DELETE FROM vlm_tasks WHERE id = ? OR imageUrl = ?`).run(issue.taskId, issue.imageUrl);
            }

            db.prepare(`
              UPDATE task_issues
              SET status = ?, resolvedBy = ?, resolvedAt = ?, resolutionNote = ?
              WHERE id = ?
            `).run(status, resolvedBy, Date.now(), resolutionNote || '', id);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
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
          const folderRows = db.prepare(`
            SELECT
              folder,
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
            WHERE sourceType = ?
            GROUP BY folder
          `).all(projectWorkflowSourceType);
          const folders = folderRows
            .filter((row: any) => projectMap[row.folder]?.projectId === projectId)
            .map((row: any) => ({
              folder: String(row.folder || ''),
              taskCount: Number(row.taskCount || 0),
              completedCount: Number(row.completedCount || 0),
              submittedCount: Number(row.submittedCount || 0),
              approvedCount: Number(row.approvedCount || 0),
              rejectedCount: Number(row.rejectedCount || 0),
              lastUpdated: Number(row.lastUpdated || 0),
              assignedWorker: row.assignedWorker ? String(row.assignedWorker) : ''
            }))
            .sort((a: any, b: any) => a.folder.localeCompare(b.folder));

          const folderNames = folders.map((row: any) => row.folder);
          const allocationsByWorker = db.prepare(`
            SELECT
              COALESCE(assignedWorker, '') as assignedWorker,
              COUNT(*) as taskCount,
              COUNT(CASE WHEN status IN ('SUBMITTED', 'APPROVED') THEN 1 END) as completedCount
            FROM (
              SELECT folder, assignedWorker, status, COALESCE(sourceType, 'native-yolo') as sourceType FROM tasks
              UNION ALL
              SELECT folder, assignedWorker, status, 'vlm-review' as sourceType FROM vlm_tasks
            ) t
            WHERE folder = ? AND sourceType = ?
            GROUP BY COALESCE(assignedWorker, '')
          `);
          const workerMap = new Map<string, { userId: string; allocated: number; completed: number; progress: number }>();
          folders.forEach((folderRow: any) => {
            const rows = allocationsByWorker.all(folderRow.folder, projectWorkflowSourceType);
            rows.forEach((workerRow: any) => {
              const userId = String(workerRow.assignedWorker || '').trim() || 'Unassigned';
              const current = workerMap.get(userId) || { userId, allocated: 0, completed: 0, progress: 0 };
              current.allocated += Number(workerRow.taskCount || 0);
              current.completed += Number(workerRow.completedCount || 0);
              workerMap.set(userId, current);
            });
          });

          const projectTarget = Math.max(0, Number(project.targetTotal || 0));
          const allocated = folders.reduce((acc: number, row: any) => acc + Number(row.taskCount || 0), 0);
          const completed = folders.reduce((acc: number, row: any) => acc + Number(row.completedCount || 0), 0);
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

          const trendRows = db.prepare(`
            SELECT
              date(timestamp / 1000, 'unixepoch', 'localtime') as ymd,
              COALESCE(userId, '') as userId,
              action,
              durationSeconds,
              timestamp
            FROM (
              SELECT timestamp, userId, action, durationSeconds, folder, COALESCE(sourceType, 'native-yolo') as sourceType FROM logs
              UNION ALL
              SELECT timestamp, userId, action, durationSeconds, folder, 'vlm-review' as sourceType FROM vlm_logs
            ) l
            WHERE timestamp >= ? AND timestamp <= ? AND folder = ? AND sourceType = ?
          `);
          const clampSeconds = (v: number, min: number = 0, max: number = 300) => Math.max(min, Math.min(max, v));
          folderNames.forEach((folderName: string) => {
            const rows = trendRows.all(startDate.getTime(), endDate.getTime(), folderName, projectWorkflowSourceType);
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
              visibleToWorkers: project?.visibleToWorkers === undefined ? true : Boolean(project?.visibleToWorkers),
              status: projectStatus,
              allocated,
              completed,
              progress,
              folderCount: folders.length
            },
            workers,
            folders: foldersForResponse,
            trends
          }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
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
              if (!projectId) {
                delete map[folder];
              } else {
                map[folder] = {
                  projectId: String(projectId),
                  updatedAt: Date.now()
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
              const { id, name, targetTotal, workflowSourceType, visibleToWorkers } = JSON.parse(body);
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
              projects[projectId] = {
                id: projectId,
                name: String(name).trim(),
                targetTotal: Math.max(0, Number(targetTotal || 0)),
                workflowSourceType: normalizeWorkflowSourceType(workflowSourceType || existing?.workflowSourceType),
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
            } catch (e) {
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
      } else if (req.url === '/api/sync' && req.method === 'POST') {
        try {
          const datasetsDir = path.resolve(__dirname, 'datasets');
          if (fs.existsSync(datasetsDir)) {
            syncFilesToDb(datasetsDir);
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          console.error(e);
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
          if (!filePath.startsWith(datasetsDir)) {
            res.statusCode = 403;
            res.end('Forbidden');
                return;
              }

          const stat = await fs.promises.stat(filePath).catch(() => null);
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
            fs.createReadStream(filePath).pipe(res);
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