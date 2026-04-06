import type { VlmOfflineTask } from './vlmTypes';

/** UI는 정상 | 수정필요 2종만 사용 */
export type VlmReviewResult = 'NORMAL' | 'NEEDS_FIX';

export type VlmDraftPayload = {
  reviewResult: VlmReviewResult;
  inputPrompt: string;
  gptResponse: string;
  dueDate: string;
  note: string;
};

/** 웹/기존 JSON 호환: 저장 시 수정필요는 NEEDS_FIX_VP 로 통일 */
function toStoredReviewResult(r: VlmReviewResult): string {
  return r === 'NEEDS_FIX' ? 'NEEDS_FIX_VP' : 'NORMAL';
}

/** conversations에서 첫 gpt/assistant 텍스트 (원본 슬롯) */
function extractGptFromParsed(parsed: Record<string, unknown>): string {
  const rawData = parsed.rawData as Record<string, unknown> | undefined;
  const conv = rawData?.conversations;
  if (!Array.isArray(conv)) return '';
  for (const c of conv) {
    if (!c || typeof c !== 'object') continue;
    const from = String((c as Record<string, unknown>).from ?? '').toLowerCase();
    if (from === 'gpt' || from === 'assistant' || from === 'model') {
      return String((c as Record<string, unknown>).value ?? '');
    }
  }
  return '';
}

/**
 * 원본은 originalAnswer(및 대화 gpt value), 수정은 editedAnswer, 기한은 rawResultData.dueDate.
 * 출력 JSON 축소: ui 블록 없음, answer 는 쓰지 않음(읽기 시 레거시 answer 만 인식).
 */
export function mergeVlmPayloadIntoSourceData(task: Pick<VlmOfflineTask, 'sourceData'>, payload: VlmDraftPayload): string {
  let parsed: Record<string, unknown> = {};
  try {
    if (typeof task.sourceData === 'string' && task.sourceData) parsed = JSON.parse(task.sourceData);
    else if (task.sourceData && typeof task.sourceData === 'object') parsed = task.sourceData as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  const { ui: _omitUi, ...parsedRest } = parsed;
  const rawResultData = { ...(parsed.rawResultData as Record<string, unknown> | undefined || {}) };
  const { answer: _omitAnswer, ...rawRest } = rawResultData;
  const stored = toStoredReviewResult(payload.reviewResult);
  const fromConv = extractGptFromParsed(parsed).trim();
  const existingOrig = String(rawRest.originalAnswer ?? '').trim();
  const originalAnswer = existingOrig || fromConv;

  const nextRrd: Record<string, unknown> = {
    ...rawRest,
    originalAnswer,
    reviewResult: stored,
    dueDate: payload.dueDate,
  };
  const gpt = String(payload.gptResponse ?? '').trim();
  if (gpt.length > 0) nextRrd.editedAnswer = payload.gptResponse;
  else delete nextRrd.editedAnswer;

  return JSON.stringify({
    ...parsedRest,
    rawResultData: nextRrd,
  });
}
