const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  openFolderDialog: () => ipcRenderer.invoke('openFolderDialog'),
  setWorkspaceRoot: (path) => ipcRenderer.invoke('setWorkspaceRoot', path),
  scanFolder: (path) => ipcRenderer.invoke('scanFolder', path),
  readTxt: (path) => ipcRenderer.invoke('readTxt', path),
  writeTxt: (path, content) => ipcRenderer.invoke('writeTxt', path, content),
  openLabelFileDialog: () => ipcRenderer.invoke('openLabelFileDialog'),
  readLabelFile: (path) => ipcRenderer.invoke('readLabelFile', path),
  showItemInFolder: (path) => ipcRenderer.invoke('showItemInFolder', path),
  deleteImageAndTxt: (imagePath, txtPath) => ipcRenderer.invoke('deleteImageAndTxt', imagePath, txtPath),
  openJsonFileDialog: () => ipcRenderer.invoke('openJsonFileDialog'),
  readJsonFile: (filePath) => ipcRenderer.invoke('readJsonFile', filePath),
  writeJsonFile: (filePath, content) => ipcRenderer.invoke('writeJsonFile', filePath, content),
});
