import React, { useCallback, useEffect, useRef, useState } from 'react';
import VlmReviewPanel from '../components/VlmReviewPanel';
import type { VlmDraftPayload } from '../vlmMerge';
import { mergeVlmPayloadIntoSourceData } from '../vlmMerge';
import type { VlmOfflineTask } from '../vlmTypes';
import {
  buildVlmJsonFileContent,
  parseVlmJsonFile,
  vlmCurrentSlot,
  vlmEnvelopeAtSlot,
  vlmNavigableListCount,
  vlmSourceDataForSlot,
  vlmItemListIndex,
  type VlmFileEnvelope,
} from '../vlmFileIO';

/** JSON 파일이 있는 폴더 = 이미지 상대 경로(Event/Person/...)의 기준 루트 */
function dirnameOfFile(filePath: string): string {
  const trimmed = filePath.trim().replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i <= 0) {
    if (trimmed.length >= 2 && trimmed[1] === ':') return trimmed.slice(0, 2);
    return trimmed;
  }
  return trimmed.slice(0, i);
}

const VlmWorkspace: React.FC = () => {
  const [jsonPath, setJsonPath] = useState<string | null>(null);
  const [envelope, setEnvelope] = useState<VlmFileEnvelope | null>(null);
  const [task, setTask] = useState<VlmOfflineTask | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [gotoInput, setGotoInput] = useState('');
  const draftRef = useRef<VlmDraftPayload | null>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);

  const isElectron = typeof window !== 'undefined' && !!window.electron;

  const loadJsonFromPath = useCallback(async (filePath: string, preserveSlot?: number) => {
    if (!window.electron) return;
    const res = await window.electron.readJsonFile(filePath);
    if (!res.ok) {
      setStatusMessage('JSON 읽기 실패: ' + (res.error || ''));
      return;
    }
    const { sourceDataStr, reviewerNotes, envelope: env } = parseVlmJsonFile(res.text || '');
    const n = vlmNavigableListCount(env);
    const base = filePath.replace(/^.*[/\\]/, '') || 'task.json';
    const jsonDir = dirnameOfFile(filePath);
    await window.electron.setWorkspaceRoot(jsonDir);
    setJsonPath(filePath);

    if (n > 0) {
      let slot = preserveSlot ?? 0;
      slot = Math.max(0, Math.min(slot, n - 1));
      const env2 = vlmEnvelopeAtSlot(env, slot);
      const src = vlmSourceDataForSlot(env, slot) ?? sourceDataStr;
      setEnvelope(env2);
      setTask({
        id: `${filePath}#${slot}`,
        name: base,
        sourceData: src,
        reviewerNotes,
        listItemIndex: vlmItemListIndex(env, slot),
        sourceRefId: `${slot + 1} / ${n}`,
        sourceFile: filePath,
      });
      setStatusMessage(`항목 ${slot + 1}/${n} (A/D) · ${jsonDir}`);
    } else {
      setEnvelope(env);
      setTask({
        id: filePath,
        name: base,
        sourceData: sourceDataStr,
        reviewerNotes,
        listItemIndex: '',
        sourceRefId: base,
        sourceFile: filePath,
      });
      setStatusMessage(`JSON 열림 · 이미지는 JSON 폴더 기준 Event/… 경로 (${jsonDir})`);
    }
  }, []);

  const handleOpenJson = useCallback(async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openJsonFileDialog();
      if (!path) return;
      await loadJsonFromPath(path);
    } catch (e) {
      setStatusMessage('JSON 파일 열기 실패: ' + (e as Error).message);
    }
  }, [loadJsonFromPath]);

  const persistMerged = useCallback(
    async (payload: VlmDraftPayload) => {
      if (!window.electron || !jsonPath || !task) return false;
      const slotKeep = envelope ? vlmCurrentSlot(envelope) : 0;
      const mergedSource = mergeVlmPayloadIntoSourceData(task, payload);
      const body = buildVlmJsonFileContent(envelope, mergedSource, payload.note);
      const ok = await window.electron.writeJsonFile(jsonPath, body);
      if (!ok) {
        setStatusMessage('저장 실패 (디스크 쓰기)');
        return false;
      }
      await loadJsonFromPath(jsonPath, slotKeep);
      setStatusMessage(`저장됨: ${jsonPath}`);
      return true;
    },
    [jsonPath, task, envelope, loadJsonFromPath]
  );

  const handleSaveDraft = useCallback(
    async (payload: VlmDraftPayload) => {
      setIsSaving(true);
      try {
        await persistMerged(payload);
      } finally {
        setIsSaving(false);
      }
    },
    [persistMerged]
  );

  const handleSubmitCurrent = useCallback(
    async (payload: VlmDraftPayload) => {
      await handleSaveDraft(payload);
    },
    [handleSaveDraft]
  );

  const handleRefresh = useCallback(async () => {
    if (!jsonPath || !window.electron) return;
    const slot = envelope ? vlmCurrentSlot(envelope) : 0;
    await loadJsonFromPath(jsonPath, slot);
  }, [jsonPath, envelope, loadJsonFromPath]);

  const handleDraftChange = useCallback((p: VlmDraftPayload) => {
    draftRef.current = p;
  }, []);

  const persistMergedRef = useRef(persistMerged);
  persistMergedRef.current = persistMerged;
  const loadJsonFromPathRef = useRef(loadJsonFromPath);
  loadJsonFromPathRef.current = loadJsonFromPath;

  const goNext = useCallback(async () => {
    if (!jsonPath || !envelope || !task) return;
    const n = vlmNavigableListCount(envelope);
    if (n <= 1) return;
    const cur = vlmCurrentSlot(envelope);
    if (cur >= n - 1) {
      setStatusMessage('마지막 항목입니다.');
      return;
    }
    const draft = draftRef.current;
    if (draft) {
      setIsSaving(true);
      try {
        const ok = await persistMergedRef.current(draft);
        if (!ok) return;
      } finally {
        setIsSaving(false);
      }
    }
    await loadJsonFromPathRef.current(jsonPath, cur + 1);
  }, [jsonPath, envelope, task]);

  const goPrev = useCallback(async () => {
    if (!jsonPath || !envelope || !task) return;
    const n = vlmNavigableListCount(envelope);
    if (n <= 1) return;
    const cur = vlmCurrentSlot(envelope);
    if (cur <= 0) {
      setStatusMessage('첫 번째 항목입니다.');
      return;
    }
    const draft = draftRef.current;
    if (draft) {
      setIsSaving(true);
      try {
        const ok = await persistMergedRef.current(draft);
        if (!ok) return;
      } finally {
        setIsSaving(false);
      }
    }
    await loadJsonFromPathRef.current(jsonPath, cur - 1);
  }, [jsonPath, envelope, task]);

  /** 1-based 순번(화면의 N/M)으로 이동. 이동 전 현재 항목 저장 */
  const goToSlot = useCallback(
    async (targetOneBased: number) => {
      if (!jsonPath || !envelope || !task) return;
      const n = vlmNavigableListCount(envelope);
      if (n <= 1) return;
      if (!Number.isFinite(targetOneBased) || targetOneBased < 1 || targetOneBased > n) {
        setStatusMessage(`이동: 1~${n} 사이 번호를 입력하세요.`);
        return;
      }
      const targetSlot = targetOneBased - 1;
      const cur = vlmCurrentSlot(envelope);
      if (targetSlot === cur) {
        setStatusMessage(`이미 ${targetOneBased}번 항목입니다.`);
        return;
      }
      const draft = draftRef.current;
      if (draft) {
        setIsSaving(true);
        try {
          const ok = await persistMergedRef.current(draft);
          if (!ok) return;
        } finally {
          setIsSaving(false);
        }
      }
      await loadJsonFromPathRef.current(jsonPath, targetSlot);
    },
    [jsonPath, envelope, task]
  );

  const handleGotoSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const raw = gotoInput.trim();
      if (!raw) return;
      if (!/^\d+$/.test(raw)) {
        setStatusMessage('순번은 숫자만 입력하세요 (1~N).');
        return;
      }
      const num = parseInt(raw, 10);
      await goToSlot(num);
      setGotoInput('');
    },
    [gotoInput, goToSlot]
  );

  const goNextRef = useRef(goNext);
  const goPrevRef = useRef(goPrev);
  goNextRef.current = goNext;
  goPrevRef.current = goPrev;

  const openJsonRef = useRef(handleOpenJson);
  openJsonRef.current = handleOpenJson;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        openJsonRef.current();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      const key = e.key.toLowerCase();
      if (key === 'a' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        void goPrevRef.current();
        return;
      }
      if (key === 'd' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        void goNextRef.current();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const listCount = vlmNavigableListCount(envelope);
  const listSlot = envelope ? vlmCurrentSlot(envelope) : 0;

  if (!isElectron) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400 p-8">
        <p className="text-sm font-medium text-slate-300">Electron으로 실행해 주세요</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex flex-wrap items-center gap-3 rounded-none">
        <button
          type="button"
          onClick={handleOpenJson}
          className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-purple)]"
          style={{ color: 'var(--accent-purple)' }}
        >
          JSON 열기 (Ctrl+L)
        </button>
        {jsonPath && (
          <span className="text-xs text-slate-500 truncate max-w-[200px] sm:max-w-md" title={dirnameOfFile(jsonPath)}>
            기준 루트(JSON 폴더): {dirnameOfFile(jsonPath)}
          </span>
        )}
        {jsonPath && (
          <span className="text-xs text-slate-400 truncate max-w-[200px] sm:max-w-md font-mono" title={jsonPath}>
            JSON: {jsonPath.replace(/^.*[/\\]/, '')}
          </span>
        )}
        <div className="flex-1 min-w-[120px] text-sm text-slate-400 truncate">{statusMessage}</div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {!task ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-slate-300 text-sm font-medium">VLM 검수: JSON 파일을 열어 주세요 (Ctrl+L)</p>
            <p className="text-slate-500 text-xs max-w-md">
              JSON을 열면 <strong>그 파일이 들어 있는 폴더</strong>가 워크스페이스 루트가 됩니다. JSON 안 이미지 경로는{' '}
              <code className="text-slate-400">Event/Person/…</code>처럼 <strong>Event로 시작하는 상대 경로</strong>를 씁니다 (JSON과 <code className="text-slate-400">Event</code> 폴더를 같은 상위에 두는 구조).
            </p>
            <p className="text-slate-500 text-xs max-w-md">
              여러 항목이 있으면 <strong>A / D</strong> 또는 <strong>← / →</strong>로 이동하고, <strong>GOTO</strong>로 순번(1~N) 직접 이동할 수 있습니다 (이동 전 현재 항목 저장). <strong>Ctrl+G</strong>로 GOTO 입력에 포커스.
            </p>
          </div>
        ) : (
          <div className="h-full flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-hidden">
              <VlmReviewPanel
                task={task}
                isSaving={isSaving}
                remainingCount={0}
                showSubmitAndNext={false}
                onRefreshTask={handleRefresh}
                onSaveDraft={handleSaveDraft}
                onSubmitCurrent={handleSubmitCurrent}
                onDraftChange={handleDraftChange}
              />
            </div>
            {listCount > 1 && (
              <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex flex-wrap items-center justify-center gap-3 sm:gap-4">
                <button
                  type="button"
                  onClick={() => void goPrev()}
                  disabled={listSlot <= 0 || isSaving}
                  className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  이전 (A)
                </button>
                <span className="text-lg font-bold tabular-nums whitespace-nowrap" style={{ color: 'var(--accent-blue)' }}>
                  {listSlot + 1} / {listCount}
                </span>
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => void handleGotoSubmit(e)}
                >
                  <label htmlFor="vlm-goto-input" className="text-xs text-slate-500 whitespace-nowrap">
                    GOTO
                  </label>
                  <input
                    id="vlm-goto-input"
                    ref={gotoInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="순번"
                    value={gotoInput}
                    onChange={(e) => setGotoInput(e.target.value)}
                    disabled={isSaving}
                    className="w-20 sm:w-24 px-2 py-1.5 rounded-lg bg-slate-900/80 border border-white/15 text-sm text-slate-200 text-center tabular-nums outline-none focus:border-[var(--accent-purple)] disabled:opacity-50"
                    title="1부터 전체 개수까지 순번 (Ctrl+G)"
                  />
                  <button
                    type="submit"
                    disabled={isSaving || !gotoInput.trim()}
                    className="px-3 py-1.5 rounded-lg glass border border-white/10 disabled:opacity-40 text-xs font-semibold transition-all hover:border-[var(--accent-purple)]"
                    style={{ color: 'var(--accent-purple)' }}
                  >
                    이동
                  </button>
                </form>
                <button
                  type="button"
                  onClick={() => void goNext()}
                  disabled={listSlot >= listCount - 1 || isSaving}
                  className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 text-sm font-medium transition-all hover:border-[var(--accent-blue)]"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  다음 (D)
                </button>
              </footer>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default VlmWorkspace;
