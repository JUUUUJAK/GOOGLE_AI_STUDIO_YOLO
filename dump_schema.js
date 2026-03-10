const Database = require('better-sqlite3');
const db = new Database('datasets.db');

const tables = db.prepare("SELECT name, sql FROM sqlite_master").all();
console.log('--- DATABASE SCHEMA ---');
tables.forEach(row => {
    console.log(`\n[${row.type}] ${row.name}:`);
    console.log(row.sql);
});

console.log('\n--- END OF SCHEMA ---');
db.close();
