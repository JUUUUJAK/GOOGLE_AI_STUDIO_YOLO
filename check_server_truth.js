const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function checkServerTruth() {
    console.log('=== 서버 데이터 저장 상태 점검 ===\n');

    // 1. DB 점검
    try {
        const db = new Database('datasets.db');
        const stats = db.prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status').all();
        console.log('[1] SQLite 데이터베이스 상태:');
        if (stats.length === 0) {
            console.log(' -> (경고) 데이터베이스에 작업 정보가 하나도 없습니다.');
        } else {
            stats.forEach(s => console.log(` -> ${s.status}: ${s.count}개`));
        }

        const logCount = db.prepare('SELECT COUNT(*) as count FROM logs').get().count;
        console.log(`\n[2] 작업 로그(기록) 개수: ${logCount}개`);
    } catch (e) {
        console.log('[!] DB 접속 실패:', e.message);
    }

    // 2. 파일 점검
    try {
        console.log('\n[3] 최근 수정된 라벨 파일 (datasets 폴더):');
        const getRecentFiles = (dir) => {
            let results = [];
            if (!fs.existsSync(dir)) return results;
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    results = results.concat(getRecentFiles(filePath));
                } else if (file.endsWith('.txt')) {
                    results.push({ name: file, mtime: stat.mtime, path: filePath });
                }
            });
            return results;
        };

        const allTxt = getRecentFiles('datasets');
        allTxt.sort((a, b) => b.mtime - a.mtime);

        if (allTxt.length === 0) {
            console.log(' -> 라벨(.txt) 파일이 하나도 없습니다.');
        } else {
            allTxt.slice(0, 5).forEach(f => {
                console.log(` -> ${f.mtime.toLocaleString()} | ${f.path}`);
            });
        }
    } catch (e) {
        console.log('[!] 파일 점검 실패:', e.message);
    }

    console.log('\n================================');
    console.log('결론: 위 목록에 오늘 날짜의 기록이 없다면,');
    console.log('브라우저에서 "저장"을 눌러도 서버로 데이터가 전달되지 않고 있는 상황입니다.');
}

checkServerTruth();
