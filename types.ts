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

export const TaskStatusLabels: Record<TaskStatus, string> = {
  [TaskStatus.TODO]: '대기',
  [TaskStatus.IN_PROGRESS]: '작업중',
  [TaskStatus.SUBMITTED]: '제출',
  [TaskStatus.APPROVED]: '완료',
  [TaskStatus.REJECTED]: '반려',
};

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
  isModified?: boolean; // True if annotations have been modified by a user
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
  isModified?: boolean;
  stats?: {
    totalBoxCount: number;
    manualBoxCount: number; // Count of boxes where isAutoLabel is false/undefined
  };
  synced?: boolean; // True if confirmed saved to server
}

export interface DatasetStats {
  totalTasks: number;
  completedTasks: number;
  rejectedTasks: number;
  avgTimePerTask: number;
  annotationsPerClass: Record<string, number>;
}

export type TaskIssueType = 'REVIEW_REQUEST' | 'DELETE_REQUEST';
export type TaskIssueStatus = 'OPEN' | 'IN_REVIEW' | 'DELETE' | 'RESOLVED';
export type TaskIssueReasonCode = 'BLUR' | 'CORRUPT' | 'WRONG_CLASS' | 'DUPLICATE' | 'OTHER';

export interface TaskIssue {
  id: string;
  taskId: string;
  folder: string;
  imageUrl: string;
  type: TaskIssueType;
  reasonCode: TaskIssueReasonCode;
  status: TaskIssueStatus;
  createdBy: string;
  createdAt: number;
  resolvedBy?: string | null;
  resolvedAt?: number | null;
  resolutionNote?: string | null;
}

export interface VacationRecord {
  id: string;
  userId: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  days: number; // supports 0.5 for half-day
  note?: string;
  createdAt: number;
}