const fs = require('fs');
const content = fs.readFileSync('types.ts', 'utf-8');
const lines = content.split('\n');
lines.forEach((line, i) => {
    if (line.includes('ISSUE_PENDING')) {
        console.log(`Line ${i + 1}: ${line}`);
        console.log('Bytes:', Buffer.from(line).toString('hex'));
    }
});
const labelsLine = lines.find(l => l.includes('요청중'));
if (labelsLine) {
    console.log('Found "요청중" line:', labelsLine);
    console.log('Bytes:', Buffer.from(labelsLine).toString('hex'));
} else {
    console.log('Could not find line with "요청중"');
}
