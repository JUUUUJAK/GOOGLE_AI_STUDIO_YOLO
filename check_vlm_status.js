const Database = require('better-sqlite3');
try {
    const db = new Database('datasets.db');
    const vlmCounts = db.prepare("SELECT status, COUNT(*) as count FROM vlm_tasks GROUP BY status").all();
    console.log('--- VLM STATUS COUNTS ---');
    console.log(JSON.stringify(vlmCounts, null, 2));

    const vlmPending = db.prepare("SELECT id, name, status FROM vlm_tasks WHERE status = 'ISSUE_PENDING' LIMIT 5").all();
    console.log('\n--- VLM ISSUE_PENDING (LIMIT 5) ---');
    console.log(JSON.stringify(vlmPending, null, 2));

    db.close();
} catch (e) {
    console.error('DB Error:', e.message);
}
