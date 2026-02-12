const Database = require('better-sqlite3');
const db = new Database('datasets.db');

// Detect corrupted strings (containing replacement character \ufffd)
const hasCorruption = (str) => str && (str.includes('\ufffd') || str.includes('ï¿½'));

console.log('--- Checking for corruption in tasks table ---');
const corruptedTasks = db.prepare('SELECT id, assignedWorker FROM tasks').all()
    .filter(t => hasCorruption(t.assignedWorker));

console.log(`Found ${corruptedTasks.length} corrupted task entries.`);
corruptedTasks.forEach(t => console.log(`ID: ${t.id}, Name: ${t.assignedWorker}`));

console.log('\n--- Checking for corruption in logs table ---');
const corruptedLogs = db.prepare('SELECT id, userId FROM logs').all()
    .filter(l => hasCorruption(l.userId));

console.log(`Found ${corruptedLogs.length} corrupted log entries.`);
corruptedLogs.forEach(l => console.log(`ID: ${l.id}, Name: ${l.userId}`));

// Suggestion for cleanup:
// If a corrupted name is a substring of a valid name from users.json, we could try to fix it.
// But better yet, just show the user what's broken first.
