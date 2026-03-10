const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  listImages: (folderPath) => ipcRenderer.invoke('list-images', folderPath),
  pathToFileUrl: (filePath) => ipcRenderer.invoke('path-to-file-url', filePath),
  readLabel: (imagePath) => ipcRenderer.invoke('read-label', imagePath),
  writeLabel: (imagePath, content) => ipcRenderer.invoke('write-label', imagePath, content),
  listLabelFiles: (folderPath) => ipcRenderer.invoke('list-label-files', folderPath),
  readLabelFile: (filePath) => ipcRenderer.invoke('read-label-file', filePath),
  deleteImage: (imagePath) => ipcRenderer.invoke('delete-image', imagePath),
  openLabelFileDialog: () => ipcRenderer.invoke('open-label-file-dialog'),
});
