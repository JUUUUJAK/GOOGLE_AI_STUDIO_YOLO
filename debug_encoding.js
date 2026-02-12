const Database = require('better-sqlite3');
const db = new Database('datasets.db');

console.log('--- Worker Names from tasks table ---');
const tasksWorkers = db.prepare('SELECT DISTINCT assignedWorker FROM tasks').all();
console.log(tasksWorkers);

console.log('\n--- User IDs from logs table ---');
const logsUsers = db.prepare('SELECT DISTINCT userId FROM logs').all();
console.log(logsUsers);

console.log('\n--- Folders from tasks table ---');
const folders = db.prepare('SELECT DISTINCT folder FROM tasks').all();
console.log(folders);
