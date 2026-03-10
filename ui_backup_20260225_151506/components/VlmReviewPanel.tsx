import React, { useEffect, useMemo, useState } from 'react';
import { Task } from '../types';

type VlmReviewResult = 'NORMAL' | 'NEEDS_FIX_VP' | 'NEEDS_FIX_DETAIL';

export type VlmDraftPayload = {
  reviewResult: VlmReviewResult;
  inputPrompt: string;
  gptResponse: string;
  dueDate: string;
  note: string;
};

type VlmReviewPanelProps = {
  task: Task;
  readOnly?: boolean;
  workerName?: string;
  remainingCount?: number;
  isSaving?: boolean;
  onRefreshTask?: () => void;
  onSaveDraft?: (payload: VlmDraftPayload) => Promise<void> | void;
  onSubmitCurrent?: (payload: VlmDraftPayload) => Promise<void> | void;
  onSubmitAndNext?: (payload: VlmDraftPayload) => Promise<void> | void;
};

const safeParse = (raw?: string) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
};

const toIsoDate = (input: any): string => {
  if (!input) return '';
  const parsed = Date.parse(String(input));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
};

const getTodayYmd = (): string => new Date().toISOString().slice(0, 10);

const normalizeImageSrc = (input: string): string => {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')) return raw;
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^datasets\/images_vlm\//i, '')
    .replace(/^images_vlm\//i, '');
  return `/datasets/images_vlm/${cleaned}`;
};

const VlmReviewPanel: React.FC<VlmReviewPanelProps> = ({
  task,
  readOnly = false,
  workerName,
  remainingCount = 0,
  isSaving = false,
  onRefreshTask,
  onSaveDraft,
  onSubmitCurrent,
  onSubmitAndNext
}) => {
  const parsed = useMemo(() => safeParse(task.sourceData), [task.sourceData]);
  const rawData = parsed?.rawData || {};
  const rawResultData = parsed?.rawResultData || {};
  const conversations = Array.isArray(rawData?.conversations) ? rawData.conversations : [];
  const imagePath = String(parsed?.resolvedImagePath || rawData?.image || parsed?.legacyImage || '').trim();
  const imageSrc = normalizeImageSrc(imagePath);

  const firstPrompt = useMemo(() => {
    const candidate = conversations.find((item: any) => {
      const from = String(item?.from || '').toLowerCase();
      return from === 'human' || from === 'user';
    });
    return String(candidate?.value || '');
  }, [conversations]);

  const firstResponse = useMemo(() => {
    const candidate = conversations.find((item: any) => {
      const from = String(item?.from || '').toLowerCase();
      return from === 'gpt' || from === 'assistant' || from === 'model';
    });
    if (candidate?.value) return String(candidate.value);
    return String(rawResultData?.answer || rawResultData?.response || '');
  }, [conversations, rawResultData]);
  const originalResponse = useMemo(() => {
    return String(rawResultData?.originalAnswer || firstResponse || '');
  }, [rawResultData, firstResponse]);

  const initialResult = useMemo<VlmReviewResult>(() => {
    const value = String(parsed?.ui?.reviewResult || rawResultData?.reviewResult || '').toUpperCase();
    if (value === 'NEEDS_FIX_VP') return 'NEEDS_FIX_VP';
    if (value === 'NEEDS_FIX_DETAIL') return 'NEEDS_FIX_DETAIL';
    return 'NORMAL';
  }, [parsed, rawResultData]);

  const initialDueDate = useMemo(() => {
    return toIsoDate(parsed?.ui?.dueDate || rawResultData?.dueDate || rawResultData?.deadline) || getTodayYmd();
  }, [parsed, rawResultData]);

  const [reviewResult, setReviewResult] = useState<VlmReviewResult>(initialResult);
  const [inputPrompt, setInputPrompt] = useState<string>(firstPrompt);
  const [gptResponse, setGptResponse] = useState<string>(String(rawResultData?.editedAnswer || parsed?.ui?.editedGptResponse || ''));
  const [dueDate, setDueDate] = useState<string>(initialDueDate);
  const [note, setNote] = useState<string>(String(task.reviewerNotes || ''));

  useEffect(() => {
    setReviewResult(initialResult);
    setInputPrompt(firstPrompt);
    setGptResponse(String(rawResultData?.editedAnswer || parsed?.ui?.editedGptResponse || ''));
    setDueDate(initialDueDate);
    setNote(String(task.reviewerNotes || ''));
  }, [task.id, task.sourceData, task.reviewerNotes, initialResult, firstPrompt, rawResultData, parsed, initialDueDate]);

  const payload: VlmDraftPayload = {
    reviewResult,
    inputPrompt,
    gptResponse,
    dueDate: dueDate || getTodayYmd(),
    note
  };

  const canLoadImage = Boolean(imageSrc);
  const canEditResponse = !readOnly && reviewResult !== 'NORMAL';

  return (
    <div className="h-full overflow-auto bg-slate-950 p-5 space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-bold text-slate-200 mb-2">작업 정보</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-300">
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">작업자: {workerName || task.assignedWorker || '-'}</div>
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">작업 ID: {task.sourceRefId || task.id}</div>
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">소스 파일: {task.sourceFile || '-'}</div>
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">남은 작업: {Math.max(0, remainingCount)}건</div>
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-2">
          <button
            type="button"
            onClick={onRefreshTask}
            disabled={isSaving}
            className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm font-semibold disabled:opacity-50"
          >
            새로고침
          </button>
          <button
            type="button"
            onClick={() => onSaveDraft?.(payload)}
            disabled={readOnly || isSaving}
            className="w-full py-2 rounded-lg bg-cyan-900/40 hover:bg-cyan-900/60 border border-cyan-800 text-cyan-200 text-sm font-semibold disabled:opacity-50"
          >
            임시 저장
          </button>
          <button
            type="button"
            onClick={() => onSubmitCurrent?.(payload)}
            disabled={readOnly || isSaving}
            className="w-full py-2 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
          >
            작업 제출
          </button>
          <button
            type="button"
            onClick={() => onSubmitAndNext?.(payload)}
            disabled={readOnly || isSaving}
            className="w-full py-2 rounded-lg bg-lime-600 hover:bg-lime-500 text-white text-sm font-bold disabled:opacity-50"
          >
            다음 작업
          </button>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-bold text-slate-200">검수 결과</h3>
        <div className="flex flex-wrap gap-2">
          {[
            { key: 'NORMAL', label: '정상' },
            { key: 'NEEDS_FIX_VP', label: '수정필요(vp)' },
            { key: 'NEEDS_FIX_DETAIL', label: '수정필요(detail)' }
          ].map((option) => (
            <label key={option.key} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-200">
              <input
                type="radio"
                name="vlm-review-result"
                checked={reviewResult === option.key}
                onChange={() => setReviewResult(option.key as VlmReviewResult)}
                disabled={readOnly || isSaving}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 min-h-[280px] flex items-center justify-center">
          {canLoadImage ? (
            <img src={imageSrc} alt={task.name} className="max-h-[340px] w-auto rounded-lg border border-slate-700 object-contain" />
          ) : (
            <div className="text-xs text-slate-500 break-all p-3 bg-slate-950 border border-slate-800 rounded-md w-full">
              이미지 경로: {imagePath || '-'}
            </div>
          )}
        </div>
        <div className="space-y-3">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <label className="block text-xs text-slate-500 font-bold mb-2">입력 프롬프트</label>
            <textarea
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              readOnly={readOnly}
              className="w-full h-28 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <label className="block text-xs text-slate-500 font-bold mb-2">GPT 응답</label>
            <textarea
              value={originalResponse}
              readOnly
              className="w-full h-32 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <div className="inline-flex items-center gap-2 mb-2">
              <label className="text-xs text-slate-500 font-bold">GPT 응답 수정</label>
              <button
                type="button"
                onClick={() => setGptResponse(originalResponse)}
                disabled={isSaving}
                className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-slate-200 disabled:opacity-50"
              >
                응답 복사
              </button>
            </div>
            <textarea
              value={gptResponse}
              onChange={(e) => setGptResponse(e.target.value)}
              readOnly={!canEditResponse}
              className="w-full h-28 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
            />
            {!readOnly && reviewResult === 'NORMAL' && (
              <p className="text-[11px] text-slate-500 mt-1">`수정필요` 선택 시에만 입력할 수 있습니다.</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-3">
          <label className="block text-xs text-slate-500 font-bold mb-2">검수 메모</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            readOnly={readOnly}
            className="w-full h-24 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600"
          />
          <div>
            <label className="block text-[11px] text-slate-500 font-bold mb-1">작업 날짜</label>
            <input
              type="date"
              value={dueDate}
              readOnly
              disabled
              className="w-full max-w-[260px] bg-slate-950 border border-slate-800 rounded-md px-2.5 py-1.5 text-xs text-slate-300 outline-none"
            />
          </div>
        </div>
      </div>

      {readOnly && (
        <div className="text-xs text-slate-500">읽기 전용 모드입니다.</div>
      )}
    </div>
  );
};

export default VlmReviewPanel;
