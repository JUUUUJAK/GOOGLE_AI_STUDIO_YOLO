const Database = require('better-sqlite3');
const db = new Database('datasets.db');

console.log('Starting migration...');

db.exec(`
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
`);

console.log('Migration complete. Checking tables...');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Current Tables:', tables.map(t => t.name).join(', '));
