export enum UserRole {
  WORKER = 'WORKER',
  REVIEWER = 'REVIEWER',
}

export enum AccountType {
  ADMIN = 'ADMIN',
  WORKER = 'WORKER'
}

export interface User {
  username: string;
  accountType: AccountType;
}

export enum TaskStatus {
  TODO = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export interface BoundingBox {
  id: string;
  classId: number;
  x: number; // Normalized 0-1 (Top Left)
  y: number; // Normalized 0-1 (Top Left)
  w: number; // Normalized 0-1
  h: number; // Normalized 0-1
  isAutoLabel?: boolean; // True if created by AI and untouched. False/Undefined if manual or edited.
}

export interface YoloClass {
  id: number;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  imageUrl: string;
  name: string;
  folder: string; // Grouping identifier (e.g., "Batch 1", "Validation")
  txtPath?: string; // Relative path to the .txt label file
  status: TaskStatus;
  annotations: BoundingBox[];
  assignedWorker?: string;
  reviewerNotes?: string;
  lastUpdated: number;
}

export interface FolderMetadata {
  tags: string[];
  memo: string;
}

export interface WorkLog {
  id: string;
  taskId: string;
  folder: string; // Snapshotted at time of log
  userId: string;
  role: UserRole;
  action: 'START' | 'SAVE' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'AUTO_LABEL';
  timestamp: number;
  durationSeconds?: number; // For session tracking
  stats?: {
    totalBoxCount: number;
    manualBoxCount: number; // Count of boxes where isAutoLabel is false/undefined
  };
}

export interface DatasetStats {
  totalTasks: number;
  completedTasks: number;
  rejectedTasks: number;
  avgTimePerTask: number;
  annotationsPerClass: Record<string, number>;
}