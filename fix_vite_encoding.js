const fs = require('fs');
let content = fs.readFileSync('vite.config.ts', 'utf8');

// Use regex to be agnostic of line endings and indentation
// Look for req.method === 'POST' then some lines later let body = '';
// Only if req.setEncoding isn't there yet.

const regex = /(else if \(req\.method === 'POST'\) \{)(\r?\n\s+)(let body = '';)/g;
content = content.replace(regex, (match, p1, p2, p3) => {
    return `${p1}${p2}req.setEncoding('utf8');${p2}${p3}`;
});

fs.writeFileSync('vite.config.ts', content, 'utf8');
console.log('Finished updating vite.config.ts with regex');
