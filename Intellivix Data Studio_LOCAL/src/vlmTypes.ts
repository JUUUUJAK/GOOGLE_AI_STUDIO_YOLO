/** 웹 Task와 호환되는 최소 필드 (오프라인 VLM) */
export type VlmOfflineTask = {
  id: string;
  name: string;
  sourceData: string;
  reviewerNotes?: string;
  /** 웹 TaskStatus.ISSUE_PENDING 등 — 로컬에서는 보통 비움 */
  status?: string;
  assignedWorker?: string;
  /** JSON 항목의 index 또는 목록 순번(표시용) */
  listItemIndex?: string;
  sourceRefId?: string;
  sourceFile?: string;
};

export const VLM_ISSUE_PENDING = 'ISSUE_PENDING';
