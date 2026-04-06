export interface OfflineImageItem {
  name: string;
  imagePath: string;
  txtPath: string;
  imageUrl: string;
}

export interface ReadJsonFileResult {
  ok: boolean;
  text?: string;
  error?: string;
}

declare global {
  interface Window {
    electron?: {
      openFolderDialog: () => Promise<string | null>;
      setWorkspaceRoot: (path: string | null) => Promise<boolean>;
      scanFolder: (path: string) => Promise<OfflineImageItem[]>;
      readTxt: (path: string) => Promise<string>;
      writeTxt: (path: string, content: string) => Promise<boolean>;
      openLabelFileDialog: () => Promise<string | null>;
      readLabelFile: (path: string) => Promise<string>;
      showItemInFolder: (path: string) => Promise<void>;
      deleteImageAndTxt: (imagePath: string, txtPath: string) => Promise<{ ok: boolean; error?: string }>;
      openJsonFileDialog: () => Promise<string | null>;
      readJsonFile: (path: string) => Promise<ReadJsonFileResult>;
      writeJsonFile: (path: string, content: string) => Promise<boolean>;
    };
  }
}

export {};
