export interface ElectronAPI {
  chooseFolder: () => Promise<string | null>;
  listImages: (folderPath: string) => Promise<string[]>;
  pathToFileUrl: (filePath: string) => Promise<string>;
  readLabel: (imagePath: string) => Promise<string>;
  writeLabel: (imagePath: string, content: string) => Promise<void>;
  listLabelFiles: (folderPath: string) => Promise<string[]>;
  readLabelFile: (filePath: string) => Promise<string>;
  deleteImage: (imagePath: string) => Promise<void>;
  openLabelFileDialog: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
