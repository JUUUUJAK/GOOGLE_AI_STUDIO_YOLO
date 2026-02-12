const Database = require('better-sqlite3');
const db = new Database('datasets.db');

const workers = db.prepare('SELECT DISTINCT assignedWorker FROM tasks WHERE assignedWorker IS NOT NULL').all();

workers.forEach(w => {
    const name = w.assignedWorker;
    const hex = Buffer.from(name, 'utf8').toString('hex');
    console.log(`Name: ${name}, Hex: ${hex}`);
});

console.log('\n--- Logs user IDs ---');
const logUsers = db.prepare('SELECT DISTINCT userId FROM logs').all();
logUsers.forEach(u => {
    const name = u.userId;
    const hex = Buffer.from(name, 'utf8').toString('hex');
    console.log(`Name: ${name}, Hex: ${hex}`);
});
