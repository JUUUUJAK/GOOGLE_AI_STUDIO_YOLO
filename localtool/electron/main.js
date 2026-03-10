const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Use a fixed userData path under AppData to avoid "access denied" cache errors
// when the app is run from a restricted or locked directory (e.g. network drive).
const userDataPath = path.join(app.getPath('appData'), 'YOLO-Local-Tool');
app.setPath('userData', userDataPath);
app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataPath, 'Cache'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

function pathToFileUrl(filePath) {
  const normalized = path.normalize(filePath);
  const withSlashes = normalized.replace(/\\/g, '/');
  if (withSlashes.startsWith('/')) return 'file://' + withSlashes;
  return 'file:///' + withSlashes;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  if (isDev) {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!mainWindow) createWindow(); });

// --- API ---
ipcMain.handle('choose-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '작업 폴더 선택',
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);
ipcMain.handle('list-images', async (_, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map(e => path.join(folderPath, e.name))
    .sort();
  return files;
});

ipcMain.handle('path-to-file-url', (_, filePath) => pathToFileUrl(filePath));

function getTxtPath(imagePath) {
  return path.join(path.dirname(imagePath), path.basename(imagePath, path.extname(imagePath)) + '.txt');
}

ipcMain.handle('read-label', async (_, imagePath) => {
  const txtPath = getTxtPath(imagePath);
  if (!fs.existsSync(txtPath)) return '';
  return fs.readFileSync(txtPath, 'utf-8');
});

ipcMain.handle('write-label', async (_, imagePath, content) => {
  const txtPath = getTxtPath(imagePath);
  fs.writeFileSync(txtPath, content, 'utf-8');
});

ipcMain.handle('list-label-files', async (_, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const labelsDir = path.join(folderPath, 'labels');
  const dir = fs.existsSync(labelsDir) ? labelsDir : folderPath;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
    .map(e => path.join(dir, e.name))
    .sort();
});

ipcMain.handle('read-label-file', async (_, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('delete-image', async (_, imagePath) => {
  const txtPath = getTxtPath(imagePath);
  if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
  if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
});

ipcMain.handle('open-label-file-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: '라벨 파일 선택',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});
