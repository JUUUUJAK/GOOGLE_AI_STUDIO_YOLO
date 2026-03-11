const Database = require('better-sqlite3');
const db = new Database('./datasets.db');

const rows = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE folder LIKE '%LH안산%' OR name LIKE '%LH안산%'").get();
console.log('tasks with LH안산:', rows.c);

const vlmRows = db.prepare("SELECT COUNT(*) as c FROM vlm_tasks WHERE folder LIKE '%LH안산%' OR name LIKE '%LH안산%'").get();
console.log('vlm_tasks with LH안산:', vlmRows.c);

db.close();
