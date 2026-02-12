import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.resolve(process.cwd(), 'datasets.db');

export const db = new Database(dbPath);

// Initialize schema
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
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(assignedWorker);
`);

/**
 * Sync server-side JSON metadata into SQLite
 */
export const syncJsonToDb = (datasetsDir: string) => {
    const metadataPath = path.join(datasetsDir, '_metadata.json');
    const folderMetaPath = path.join(datasetsDir, '_folder_metadata.json');

    if (fs.existsSync(metadataPath)) {
        try {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            const insertTask = db.prepare(`
        INSERT INTO tasks (id, name, folder, imageUrl, txtPath, assignedWorker, status, reviewerNotes, isModified, lastUpdated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(imageUrl) DO UPDATE SET
          status = excluded.status,
          assignedWorker = excluded.assignedWorker,
          reviewerNotes = excluded.reviewerNotes,
          isModified = excluded.isModified,
          lastUpdated = excluded.lastUpdated
      `);

            const transaction = db.transaction((data) => {
                for (const [key, meta] of Object.entries(data)) {
                    // Key looks like worker1/folderA/image.jpg
                    // This sync is only for "updates" from legacy JSON
                    // Actual file discovery happens via indexer
                }
            });
            // Basic sync logic can be expanded here
        } catch (e) {
            console.error("Failed to sync JSON to DB", e);
        }
    }
};
