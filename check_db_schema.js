const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'datasets.db');
const db = new Database(dbPath);

console.log('--- Table: tasks ---');
try {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  console.log(info.sql);
} catch (e) {
  console.error(e.message);
}

console.log('\n--- Table: deleted_tasks ---');
try {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deleted_tasks'").get();
  console.log(info.sql);
} catch (e) {
  console.error(e);
}

console.log('\n--- Checking for "native-yolo" usage in any SQL ---');
const allSql = db.prepare("SELECT name, sql FROM sqlite_master").all();
allSql.forEach(row => {
    if (row.sql && row.sql.includes('native-yolo')) {
        console.log(`Found in [${row.name}]: ${row.sql}`);
    }
});

db.close();
