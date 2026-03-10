const Database = require('better-sqlite3');
try {
    const db = new Database('datasets.db');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('--- GLOBAL SEARCH ---');
    for (const table of tables) {
        try {
            const rows = db.prepare(`SELECT * FROM ${table.name} WHERE name LIKE '%0087_FL_FWW%00020%' OR id LIKE '%0087_FL_FWW%00020%'`).all();
            if (rows.length > 0) {
                console.log(`\nFound in [${table.name}]:`);
                console.log(JSON.stringify(rows, null, 2));
            }
        } catch (e) {
            // Some tables might not have 'name' or 'id' columns
        }
    }

    const issues = db.prepare("SELECT * FROM task_issues WHERE taskId LIKE '%0087_FL_FWW%00020%'").all();
    console.log('\n--- task_issues search ---');
    console.log(JSON.stringify(issues, null, 2));

    db.close();
} catch (e) {
    console.error('DB Error:', e.message);
}
