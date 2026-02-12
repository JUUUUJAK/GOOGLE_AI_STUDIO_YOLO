const Database = require('better-sqlite3');
const db = new Database('datasets.db');

console.log('--- Non-cache ImageURLs ---');
const items = db.prepare('SELECT id, folder, name, imageUrl FROM tasks WHERE folder != ? LIMIT 10').all('.cache');
console.log(items);
