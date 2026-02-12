const crypto = require('crypto');
const path = require('path');

const __dirname = 'C:\\GOOGLE_AI_STUDIO_YOLO';

const filePath1 = 'C:\\GOOGLE_AI_STUDIO_YOLO\\datasets\\test1\\image.jpg';
const relativePath1 = path.relative(__dirname, filePath1).replace(/\\/g, '/');
const id1 = crypto.createHash('md5').update(relativePath1).digest('hex');

const filePath2 = 'C:\\GOOGLE_AI_STUDIO_YOLO\\datasets\\workerA\\test1\\image.jpg';
const relativePath2 = path.relative(__dirname, filePath2).replace(/\\/g, '/');
const id2 = crypto.createHash('md5').update(relativePath2).digest('hex');

console.log(`Path 1: ${relativePath1}, ID: ${id1}`);
console.log(`Path 2: ${relativePath2}, ID: ${id2}`);

if (id1 !== id2) {
    console.log('CONFIRMED: IDs change when folder is moved into worker subfolder.');
} else {
    console.log('IDs are the same.');
}
