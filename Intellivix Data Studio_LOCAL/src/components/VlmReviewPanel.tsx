import React, { useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { VlmOfflineTask } from '../vlmTypes';
import { VLM_ISSUE_PENDING } from '../vlmTypes';
import type { VlmDraftPayload, VlmReviewResult } from '../vlmMerge';

type VlmReviewPanelProps = {
  task: VlmOfflineTask;
  readOnly?: boolean;
  remainingCount?: number;
  isSaving?: boolean;
  showSubmitAndNext?: boolean;
  onRefreshTask?: () => void;
  onSaveDraft?: (payload: VlmDraftPayload) => Promise<void> | void;
  onSubmitCurrent?: (payload: VlmDraftPayload) => Promise<void> | void;
  onSubmitAndNext?: (payload: VlmDraftPayload) => Promise<void> | void;
  onDraftChange?: (payload: VlmDraftPayload) => void;
};

const safeParse = (raw?: string) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
};

const toIsoDate = (input: unknown): string => {
  if (!input) return '';
  const parsed = Date.parse(String(input));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
};

const getTodayYmd = (): string => new Date().toISOString().slice(0, 10);

/** 이미지 루트가 yolo://workspace 로 잡힌 경우 상대 경로를 프로토콜 URL로 변환 */
const normalizeImageSrc = (input: string): string => {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('yolo://') || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('file://')) return raw;
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^datasets\/images_vlm\//i, '')
    .replace(/^images_vlm\//i, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  return 'yolo://workspace/' + segments.map(encodeURIComponent).join('/');
};

const isBlocked = (task: VlmOfflineTask) => task.status === VLM_ISSUE_PENDING;

const VlmReviewPanel: React.FC<VlmReviewPanelProps> = ({
  task,
  readOnly = false,
  remainingCount = 0,
  isSaving = false,
  showSubmitAndNext = false,
  onRefreshTask,
  onSaveDraft,
  onSubmitCurrent,
  onSubmitAndNext,
  onDraftChange,
}) => {
  /** 웹 export는 sourceData가 문자열이지만, JSON 파일은 { sourceData: { ... } } 로 한 겹 더 있을 수 있음 */
  const parsedRoot = useMemo(() => safeParse(task.sourceData), [task.sourceData]);
  const parsed = useMemo((): Record<string, unknown> | null => {
    if (parsedRoot == null || typeof parsedRoot !== 'object' || Array.isArray(parsedRoot)) return null;
    const pr = parsedRoot as Record<string, unknown>;
    if (pr.rawData || pr.rawResultData || pr.resolvedImagePath || pr.legacyImage) return pr;
    const sd = pr.sourceData;
    if (typeof sd === 'string') {
      try {
        const inner = JSON.parse(sd) as unknown;
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      return pr;
    }
    if (sd && typeof sd === 'object' && !Array.isArray(sd)) return sd as Record<string, unknown>;
    return pr;
  }, [parsedRoot]);

  const rawData = useMemo((): Record<string, unknown> => {
    const r = parsed?.rawData;
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return {};
  }, [parsed]);
  /** 빈 객체를 매 렌더 새로 만들면 useLayoutEffect가 매번 돌아 검수 결과 선택이 초기화됨 */
  const rawResultData = useMemo((): Record<string, unknown> => {
    const r = parsed?.rawResultData;
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return {};
  }, [parsed]);
  const rd = rawData;
  /** result + original_response 보내기 JSON: 읽기 전용은 긴 original_response, 수정란은 conversations gpt value */
  const dualGptLayout = rawResultData.dualGptLayout === true;
  const uiFlat = useMemo((): Record<string, unknown> => {
    const u = parsed?.ui;
    if (u && typeof u === 'object' && !Array.isArray(u)) return u as Record<string, unknown>;
    return {};
  }, [parsed]);
  const conversations = Array.isArray(rd?.conversations) ? rd.conversations : [];
  const pr = parsed || ({} as Record<string, unknown>);
  const imagePath = String(
    pr.resolvedImagePath ||
      pr.imagePath ||
      pr.image_path ||
      rd.image ||
      rd.image_path ||
      pr.legacyImage ||
      ''
  ).trim();
  const imageSrc = normalizeImageSrc(imagePath);

  const firstPrompt = useMemo(() => {
    const candidate = conversations.find((item: { from?: string; value?: string }) => {
      const from = String(item?.from || '').toLowerCase();
      return from === 'human' || from === 'user';
    });
    return String(candidate?.value || '');
  }, [conversations]);

  const firstResponse = useMemo(() => {
    const candidate = conversations.find((item: { from?: string; value?: string }) => {
      const from = String(item?.from || '').toLowerCase();
      return from === 'gpt' || from === 'assistant' || from === 'model';
    });
    if (candidate?.value) return String(candidate.value);
    return String(rawResultData?.answer || rawResultData?.response || '');
  }, [conversations, rawResultData]);
  /** 읽기 전용: 원본만. rawResultData.answer(레거시)는 편집본과 혼동될 수 있어 사용하지 않음 */
  const originalResponse = useMemo(() => {
    return String(rawResultData?.originalAnswer || firstResponse || '');
  }, [rawResultData, firstResponse]);

  const initialResult = useMemo<VlmReviewResult>(() => {
    const p = parsed;
    const ui = p?.ui && typeof p.ui === 'object' ? (p.ui as Record<string, unknown>) : null;
    const rrd = rawResultData;
    const rr = String(ui?.reviewResult ?? rrd?.reviewResult ?? '').toUpperCase();
    if (rr === 'NORMAL' || rr === '') return 'NORMAL';
    if (rr.startsWith('NEEDS_FIX')) return 'NEEDS_FIX';
    return 'NORMAL';
  }, [parsed, rawResultData]);

  const initialDueDate = useMemo(() => {
    return toIsoDate(uiFlat.dueDate || rawResultData.dueDate || rawResultData.deadline) || getTodayYmd();
  }, [uiFlat, rawResultData]);

  const [reviewResult, setReviewResult] = useState<VlmReviewResult>(initialResult);
  const [inputPrompt, setInputPrompt] = useState<string>(firstPrompt);
  const [gptResponse, setGptResponse] = useState<string>(() =>
    initialResult === 'NORMAL' ? '' : String(rawResultData.editedAnswer || uiFlat.editedGptResponse || '')
  );
  const [dueDate, setDueDate] = useState<string>(initialDueDate);
  const [note, setNote] = useState<string>(String(task.reviewerNotes || ''));

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = imageContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const ZOOM_SPEED = 0.001;
      const delta = -e.deltaY * ZOOM_SPEED;
      setScale((prev) => Math.min(Math.max(0.1, prev + delta), 10));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useLayoutEffect(() => {
    const gpt =
      initialResult === 'NORMAL' ? '' : String(rawResultData.editedAnswer || uiFlat.editedGptResponse || '');
    const due = initialDueDate || getTodayYmd();
    const n = String(task.reviewerNotes || '');
    setReviewResult(initialResult);
    setInputPrompt(firstPrompt);
    setGptResponse(gpt);
    setDueDate(initialDueDate);
    setNote(n);
    setIsPanning(false);
    setLastPanPos(null);
    onDraftChange?.({
      reviewResult: initialResult,
      inputPrompt: firstPrompt,
      gptResponse: gpt,
      dueDate: due,
      note: n,
    });
  }, [task.id, task.sourceData, task.reviewerNotes, initialResult, firstPrompt, firstResponse, initialDueDate, dualGptLayout, onDraftChange]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isPanning && lastPanPos) {
        const dx = e.clientX - lastPanPos.x;
        const dy = e.clientY - lastPanPos.y;
        setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
        setLastPanPos({ x: e.clientX, y: e.clientY });
      }
    },
    [isPanning, lastPanPos]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    setLastPanPos(null);
  }, []);

  useEffect(() => {
    if (isPanning) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isPanning, handleMouseMove, handleMouseUp]);

  const payload: VlmDraftPayload = {
    reviewResult,
    inputPrompt,
    gptResponse,
    dueDate: dueDate || getTodayYmd(),
    note,
  };

  useEffect(() => {
    onDraftChange?.(payload);
  }, [reviewResult, inputPrompt, gptResponse, dueDate, note, onDraftChange]);

  const canLoadImage = Boolean(imageSrc);
  const canEditResponse = !readOnly && reviewResult === 'NEEDS_FIX';
  const blocked = isBlocked(task);

  return (
    <div className="h-full overflow-auto bg-slate-950 p-5 space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-3">
          <h3 className="text-sm font-bold text-slate-200 mb-2">작업 정보</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-slate-300">
            <div className="bg-slate-950 border border-slate-800 rounded-md px-3 py-2">
              인덱스: {task.listItemIndex != null && task.listItemIndex !== '' ? task.listItemIndex : '-'}
            </div>
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
            disabled={readOnly || isSaving || blocked}
            className="w-full py-2 rounded-lg bg-cyan-900/40 hover:bg-cyan-900/60 border border-cyan-800 text-cyan-200 text-sm font-semibold disabled:opacity-50"
          >
            임시 저장
          </button>
          <button
            type="button"
            onClick={() => onSubmitCurrent?.(payload)}
            disabled={readOnly || isSaving || blocked}
            className="w-full py-2 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
          >
            작업 제출
          </button>
          {showSubmitAndNext && onSubmitAndNext && (
            <button
              type="button"
              onClick={() => onSubmitAndNext(payload)}
              disabled={readOnly || isSaving || blocked}
              className="w-full py-2 rounded-lg bg-lime-600 hover:bg-lime-500 text-white text-sm font-bold disabled:opacity-50"
            >
              다음 작업
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div
          ref={imageContainerRef}
          className="bg-slate-900 border border-slate-800 rounded-xl p-3 h-[55vh] min-h-[320px] flex items-center justify-center relative overflow-hidden"
          onMouseDown={handleMouseDown}
          onContextMenu={(e) => e.preventDefault()}
          style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        >
          {canLoadImage ? (
            <div
              className="relative origin-center h-full flex items-center justify-center"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                transition: isPanning ? 'none' : 'transform 0.075s ease-out',
              }}
            >
              <img src={imageSrc} alt={task.name} className="h-full max-w-full rounded-lg border border-slate-700 object-contain pointer-events-none select-none" draggable={false} />
            </div>
          ) : (
            <div className="text-xs text-slate-500 break-all p-3 bg-slate-950 border border-slate-800 rounded-md w-full">
              이미지 경로: {imagePath || '-'}
            </div>
          )}
          <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-2 pointer-events-none">
            <div className="flex gap-1 pointer-events-auto">
              {[
                { value: 1, label: '100%' },
                { value: 0.75, label: '75%' },
                { value: 0.5, label: '50%' },
                { value: 0.25, label: '25%' },
                { value: 0.15, label: '최소' },
              ].map(({ value, label }) => {
                const isActive = Math.abs(scale - value) < 0.02;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      setScale(value);
                      setPan({ x: 0, y: 0 });
                    }}
                    className={`px-2 py-1 rounded text-[11px] font-medium border transition-colors ${isActive ? 'bg-sky-600 border-sky-500 text-white' : 'bg-slate-900/90 border-slate-600 text-slate-300 hover:bg-slate-800 hover:border-slate-500'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="bg-slate-900/80 text-slate-400 text-[10px] px-2 py-1 rounded border border-slate-700 select-none">
              마우스 휠: 확대/축소, 드래그: 이동
            </span>
          </div>
        </div>
        <div className="space-y-3">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <label className="block text-xs text-slate-500 font-bold mb-2">입력 프롬프트</label>
            <textarea
              value={inputPrompt}
              readOnly
              className="w-full h-28 bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-sm text-slate-200 outline-none focus:border-cyan-600 cursor-default"
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
            <h3 className="text-xs font-bold text-slate-200 mb-2">검수 결과</h3>
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'NORMAL' as const, label: '정상', className: 'border-emerald-600/60 bg-emerald-950/50 text-emerald-200 hover:bg-emerald-900/40', activeClass: 'border-emerald-500 bg-emerald-900/50 text-emerald-100', ring: 'ring-emerald-500' },
                { key: 'NEEDS_FIX' as const, label: '수정필요', className: 'border-amber-600/60 bg-amber-950/50 text-amber-200 hover:bg-amber-900/40', activeClass: 'border-amber-500 bg-amber-900/50 text-amber-100', ring: 'ring-amber-500' },
              ].map((option) => {
                const isChecked = reviewResult === option.key;
                return (
                  <label
                    key={option.key}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all cursor-pointer ${isChecked ? option.activeClass : `${option.className} opacity-45 hover:opacity-70`} ${isChecked ? `ring-2 ring-offset-2 ring-offset-slate-900 ${option.ring}` : ''}`}
                  >
                    <input
                      type="radio"
                      name="vlm-review-result"
                      checked={isChecked}
                      onChange={() => setReviewResult(option.key)}
                      disabled={readOnly || isSaving || blocked}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <div className="inline-flex items-center gap-2 mb-2">
              <label className="text-xs text-slate-500 font-bold">GPT 응답 수정</label>
              <button
                type="button"
                onClick={() => setGptResponse(dualGptLayout ? firstResponse : originalResponse)}
                disabled={isSaving || blocked}
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
            {!readOnly && reviewResult === 'NORMAL' && <p className="text-[11px] text-slate-500 mt-1">`수정필요` 선택 시에만 입력할 수 있습니다.</p>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-3">
          <label className="block text-xs text-slate-500 font-bold mb-2">검수 메모</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            readOnly={readOnly || blocked}
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

      {readOnly && <div className="text-xs text-slate-500">읽기 전용 모드입니다.</div>}
    </div>
  );
};

export default VlmReviewPanel;
