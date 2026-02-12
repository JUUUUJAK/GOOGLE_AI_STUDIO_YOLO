const Database = require('better-sqlite3');
const db = new Database('datasets.db');

console.log('--- Tasks for 20260203_이시안_AIHUB ---');
const items = db.prepare('SELECT id, folder, status, imageUrl FROM tasks WHERE folder = ? LIMIT 5').all('20260203_이시안_AIHUB');
console.log(items);

console.log('\n--- Count by status for this folder ---');
const stats = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE folder = ? GROUP BY status').all('20260203_이시안_AIHUB');
console.log(stats);
