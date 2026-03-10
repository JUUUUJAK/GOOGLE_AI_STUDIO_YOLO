const Database = require('better-sqlite3');
try {
    const db = new Database('datasets.db');
    const rows = db.prepare("SELECT name, status FROM tasks LIMIT 5").all();
    console.log('--- ALL TASKS (LIMIT 5) ---');
    console.log(JSON.stringify(rows, null, 2));

    const total = db.prepare("SELECT COUNT(*) as count FROM tasks").get();
    console.log('\nTotal tasks:', total.count);

    const issues = db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();
    console.log('\n--- STATUS COUNTS ---');
    console.log(JSON.stringify(issues, null, 2));

    db.close();
} catch (e) {
    console.error('DB Error:', e.message);
}
