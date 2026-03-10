const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const dbPath = path.join(projectRoot, 'datasets.db');
const datasetsDir = path.join(projectRoot, 'datasets');
const projectsMapPath = path.join(datasetsDir, '_project_map.json');

const db = new Database(dbPath);

function readJsonSafe(targetPath, fallback) {
  try {
    if (!fs.existsSync(targetPath)) return fallback;
    const raw = fs.readFileSync(targetPath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

function writeJsonSafe(targetPath, value) {
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2), 'utf-8');
}

function getValidWorkerUsernames() {
  const usersPath = path.join(projectRoot, 'users.json');
  const users = readJsonSafe(usersPath, []);
  if (!Array.isArray(users)) return [];
  return users
    .filter((u) => String(u?.accountType || '').toUpperCase() === 'WORKER')
    .map((u) => String(u?.username || '').trim())
    .filter(Boolean);
}

function toNativeYoloFolderFromDatasetsRelativePath(datasetsRelativePath, validWorkers) {
  const normalized = String(datasetsRelativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return 'Unsorted';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return 'Unsorted';

  const workerSet = new Set(validWorkers.map((name) => String(name || '').trim()).filter(Boolean));
  const startsWithWorker = parts.length > 1 && workerSet.has(parts[0]);
  const withoutWorker = startsWithWorker ? parts.slice(1) : parts;
  if (withoutWorker.length <= 1) return 'Unsorted';

  const folderParts = withoutWorker.slice(0, -1);
  return folderParts.length > 0 ? folderParts.join('/') : 'Unsorted';
}

function folderFromTaskImageUrl(imageUrl, validWorkers) {
  const normalized = String(imageUrl || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const datasetsRelative = normalized.startsWith('datasets/') ? normalized.substring('datasets/'.length) : normalized;
  return toNativeYoloFolderFromDatasetsRelativePath(datasetsRelative, validWorkers);
}

function migrateTasksFolder(validWorkers) {
  const rows = db.prepare(`
    SELECT id, folder, imageUrl
    FROM tasks
    WHERE COALESCE(sourceType, 'native-yolo') = 'native-yolo'
  `).all();

  const updateStmt = db.prepare(`UPDATE tasks SET folder = ? WHERE id = ?`);
  let changed = 0;

  db.transaction(() => {
    rows.forEach((row) => {
      const current = String(row.folder || '').trim();
      const next = folderFromTaskImageUrl(row.imageUrl, validWorkers);
      if (next !== current) {
        updateStmt.run(next, row.id);
        changed += 1;
      }
    });
  })();

  return { total: rows.length, changed };
}

function listAllFolders() {
  return db.prepare(`
    SELECT DISTINCT folder FROM (
      SELECT folder FROM tasks
      UNION ALL
      SELECT folder FROM vlm_tasks
    )
  `).all()
    .map((r) => String(r.folder || '').trim())
    .filter(Boolean);
}

function migrateProjectMap(allFolders) {
  const rawMap = readJsonSafe(projectsMapPath, {});
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return { changed: false, expandedMappings: 0, totalMappings: 0 };
  }

  const migratedMap = {};
  let changed = false;
  let expandedMappings = 0;

  Object.entries(rawMap).forEach(([folder, mapping]) => {
    const oldFolder = String(folder || '').trim();
    if (!oldFolder || !mapping || !mapping.projectId) return;

    const matched = allFolders.filter((f) => f === oldFolder || f.startsWith(`${oldFolder}/`));
    if (matched.length === 0) {
      migratedMap[oldFolder] = {
        projectId: String(mapping.projectId),
        updatedAt: Number(mapping.updatedAt || 0)
      };
      return;
    }

    matched.forEach((f) => {
      migratedMap[f] = {
        projectId: String(mapping.projectId),
        updatedAt: Date.now()
      };
    });

    if (!(matched.length === 1 && matched[0] === oldFolder)) {
      changed = true;
      expandedMappings += (matched.length - 1);
    }
  });

  if (changed) {
    writeJsonSafe(projectsMapPath, migratedMap);
  }

  return {
    changed,
    expandedMappings,
    totalMappings: Object.keys(migratedMap).length
  };
}

function migrateFolderMetadata(allFolders) {
  const rows = db.prepare(`
    SELECT folder, assignedWorker, tags, memo, lastUpdated
    FROM folder_metadata
  `).all();

  const existingSet = new Set(rows.map((r) => String(r.folder || '').trim()).filter(Boolean));
  const insertStmt = db.prepare(`
    INSERT INTO folder_metadata (folder, assignedWorker, tags, memo, lastUpdated)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(folder) DO NOTHING
  `);

  let inserted = 0;

  db.transaction(() => {
    rows.forEach((row) => {
      const oldFolder = String(row.folder || '').trim();
      if (!oldFolder) return;
      const matched = allFolders.filter((f) => f === oldFolder || f.startsWith(`${oldFolder}/`));
      matched.forEach((f) => {
        if (existingSet.has(f)) return;
        insertStmt.run(
          f,
          row.assignedWorker || null,
          row.tags || null,
          row.memo || null,
          Number(row.lastUpdated || Date.now())
        );
        existingSet.add(f);
        inserted += 1;
      });
    });
  })();

  return { baseRows: rows.length, inserted };
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[ERROR] datasets.db not found: ${dbPath}`);
    process.exit(1);
  }

  const validWorkers = getValidWorkerUsernames();
  const taskResult = migrateTasksFolder(validWorkers);
  const allFolders = listAllFolders();
  const mapResult = migrateProjectMap(allFolders);
  const metadataResult = migrateFolderMetadata(allFolders);

  console.log('[DONE] Nested folder migration completed.');
  console.log(`- tasks(native-yolo): ${taskResult.changed} / ${taskResult.total} rows updated`);
  console.log(`- project_map: ${mapResult.changed ? 'updated' : 'no change'} (expanded +${mapResult.expandedMappings}, total ${mapResult.totalMappings})`);
  console.log(`- folder_metadata: ${metadataResult.inserted} rows inserted from ${metadataResult.baseRows} base rows`);
}

try {
  main();
} finally {
  db.close();
}
