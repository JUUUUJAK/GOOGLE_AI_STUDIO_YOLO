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
    stats TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(userId);

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
db.prepare(`UPDATE task_issues SET status = 'DELETE' WHERE status = 'APPROVED'`).run();
db.prepare(`UPDATE task_issues SET status = 'RESOLVED' WHERE status = 'REJECTED'`).run();

const updateTaskMetadataStmt = db.prepare(`
  UPDATE tasks SET
    status = COALESCE(?, status),
    isModified = COALESCE(?, isModified),
    assignedWorker = COALESCE(?, assignedWorker),
    reviewerNotes = COALESCE(?, reviewerNotes),
    lastUpdated = ?
  WHERE id = ? OR imageUrl = ? OR imageUrl = ?
`);

const applyTaskMetadataUpdate = (item: any) => {
  const { id, key, updates } = item;
  const imageUrl = key?.startsWith('/') ? key : (key ? '/datasets/' + key : null);
  updateTaskMetadataStmt.run(
    updates?.status,
    updates?.isModified !== undefined ? (updates.isModified ? 1 : 0) : null,
    updates?.assignedWorker,
    updates?.reviewerNotes,
    updates?.lastUpdated || Date.now(),
    id || null,
    imageUrl,
    key || null
  );
};

const syncFilesToDb = (datasetsDir: string) => {
  const usersPath = path.resolve(__dirname, 'users.json');
  let validWorkers = [];
  if (fs.existsSync(usersPath)) {
    try {
      validWorkers = JSON.parse(fs.readFileSync(usersPath, 'utf-8'))
        .filter(u => u.accountType === 'WORKER')
        .map(u => u.username);
    } catch (e) { }
  }

  // Load existing metadata to prevent overwriting
  const metadataPath = path.join(datasetsDir, '_metadata.json');
  let legacyMetadata = {};
  if (fs.existsSync(metadataPath)) {
    try { legacyMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); } catch (e) { }
  }

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(imageUrl) DO UPDATE SET
      txtPath = excluded.txtPath,
      folder = excluded.folder
  `);

  db.exec('CREATE TEMPORARY TABLE IF NOT EXISTS temp_ids (id TEXT)');
  db.exec('DELETE FROM temp_ids'); // Clear for this scan
  const deleteMissing = db.prepare('DELETE FROM tasks WHERE id NOT IN (SELECT id FROM temp_ids)');

  // Prepare statement to check for existing record
  const getExistingStatus = db.prepare('SELECT status, assignedWorker FROM tasks WHERE id = ?');

  const scan = (dir: string, currentWorker?: string, currentProject?: string) => {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat && stat.isDirectory()) {
        let nextWorker = currentWorker;
        let nextProject = currentProject;

        if (!currentWorker && dir === datasetsDir && validWorkers.includes(file)) {
          nextWorker = file;
        } else if (!currentProject) {
          nextProject = file;
        }

        scan(filePath, nextWorker, nextProject);
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

        const folderName = currentProject || 'Unsorted';

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
          fileMeta.lastUpdated || Date.now()
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

    middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/api/')) {
        console.log(`[API] ${req.method} ${req.url}`);
      }
      const buildAnalyticsByRange = (startTs: number, endTs: number) => {
        const stats = db.prepare(`
          SELECT
            userId,
            role,
            COUNT(CASE WHEN UPPER(action) = 'SAVE' OR UPPER(action) = 'SUBMIT' THEN 1 END) as submissions,
            COUNT(CASE WHEN UPPER(action) = 'APPROVE' THEN 1 END) as approvals,
            COUNT(CASE WHEN UPPER(action) = 'REJECT' THEN 1 END) as rejections,
            SUM(durationSeconds) as workTime,
            MAX(timestamp) as lastActive
          FROM logs
          WHERE timestamp >= ? AND timestamp <= ?
          GROUP BY userId
        `).all(startTs, endTs);

        const folderRows = db.prepare(`
          SELECT userId, folder
          FROM logs
          WHERE timestamp >= ? AND timestamp <= ?
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
          SELECT userId, stats FROM logs
          WHERE timestamp >= ? AND timestamp <= ? AND stats IS NOT NULL
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

        return stats.map((s: any) => ({
          ...s,
          manualBoxCount: boxCounts[s.userId] || 0,
          folders: Array.from(foldersByUser[s.userId] || [])
        }));
      };
      if (req.url.startsWith('/api/datasets')) {
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const limit = parseInt(url.searchParams.get('limit') || '5000');
          const offset = parseInt(url.searchParams.get('offset') || '0');

          const tasks = db.prepare('SELECT * FROM tasks ORDER BY COALESCE(lastUpdated, 0) DESC, id ASC LIMIT ? OFFSET ?').all(limit, offset);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(tasks));
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
            FROM logs
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
            const logs = db.prepare('SELECT * FROM logs WHERE timestamp > ?').all(since);
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
              const insert = db.prepare(`
                INSERT INTO logs (id, taskId, userId, role, folder, action, timestamp, durationSeconds, isModified, stats)
                VALUES (@id, @taskId, @userId, @role, @folder, @action, @timestamp, @durationSeconds, @isModified, @stats)
                ON CONFLICT(id) DO NOTHING
              `);
              const insertMany = db.transaction((logs) => {
                for (const log of logs) {
                  insert.run({
                    id: log.id,
                    taskId: log.taskId || '',
                    userId: log.userId || 'Unknown',
                    role: log.role || 'WORKER',
                    folder: log.folder || 'Unsorted',
                    action: log.action || 'SAVE',
                    timestamp: log.timestamp || Date.now(),
                    durationSeconds: log.durationSeconds || 0,
                    isModified: log.isModified ? 1 : 0,
                    stats: log.stats ? JSON.stringify(log.stats) : null
                  });
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
              FROM tasks
            `).get();

            // Total Work Time (All Time)
            const timeStats = db.prepare(`
              SELECT SUM(durationSeconds) as totalWorkTime FROM logs
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
    open: true
  }
});