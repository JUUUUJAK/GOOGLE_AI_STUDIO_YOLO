/// <reference types="vite/client" />
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { BoundingBox, YoloClass } from '../types';
import { COLOR_PALETTE } from '../constants';
import { parseYoloTxt, generateYoloTxt } from '../yoloFormat';
import AnnotationCanvas from '../components/AnnotationCanvas';

interface OfflineImageItem {
  name: string;
  imagePath: string;
  txtPath: string;
  imageUrl: string;
}

interface FolderStats {
  totalImages: number;
  imagesWithLabels: number;
  imagesWithoutLabels: number;
  totalBoxes: number;
  byClass: { classId: number; name: string; count: number }[];
}

/** 툴에 저장된 클래스 세트 (txt 내용 + 표시 이름) */
interface SavedClassSet {
  id: string;
  displayName: string;
  classNames: string[];
}

const SAVED_SETS_STORAGE_KEY = 'intellivixYolo.savedClassSetsV1';

function classNamesToYoloClasses(classNames: string[]): YoloClass[] {
  return classNames.map((name, index) => ({
    id: index,
    name,
    color: COLOR_PALETTE[index % COLOR_PALETTE.length],
  }));
}

const YoloWorkspace: React.FC = () => {
  const [workFolderPath, setWorkFolderPath] = useState<string | null>(null);
  const [imageList, setImageList] = useState<OfflineImageItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [classes, setClasses] = useState<YoloClass[]>([]);
  const [selectedClass, setSelectedClass] = useState<YoloClass | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [undoSignal, setUndoSignal] = useState(0);
  const [redoSignal, setRedoSignal] = useState(0);
  const [hiddenClassIds, setHiddenClassIds] = useState<number[]>([]);
  const [customClassColors, setCustomClassColors] = useState<Record<number, string>>({});
  const isElectron = typeof window !== 'undefined' && !!window.electron;

  const [savedClassSets, setSavedClassSets] = useState<SavedClassSet[]>([]);
  const [activeClassSetId, setActiveClassSetId] = useState<string | null>(null);
  const [storageRestored, setStorageRestored] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const labelMenuRef = useRef<HTMLDivElement>(null);
  const labelTriggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const [labelDropdownRect, setLabelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [gotoValue, setGotoValue] = useState('');

  // 화면에 실제로 그리는 항목
  const [displayItem, setDisplayItem] = useState<OfflineImageItem | null>(null);
  const [displayAnnotations, setDisplayAnnotations] = useState<BoundingBox[]>([]);

  const [showStatsModal, setShowStatsModal] = useState(false);
  const [folderStats, setFolderStats] = useState<FolderStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const classesRef = useRef(classes);
  const selectedClassRef = useRef(selectedClass);
  useEffect(() => {
    classesRef.current = classes;
    selectedClassRef.current = selectedClass;
  }, [classes, selectedClass]);

  /** 저장소에서 저장된 세트 목록만 복원 (시작 시에는 아무 클래스도 적용하지 않음) */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_SETS_STORAGE_KEY);
      if (!raw) {
        setStorageRestored(true);
        return;
      }
      const o = JSON.parse(raw) as {
        savedClassSets?: SavedClassSet[];
        customColors?: Record<string, string>;
      };
      const sets = Array.isArray(o.savedClassSets) ? o.savedClassSets.filter((s) => s?.id && s?.displayName && Array.isArray(s.classNames)) : [];
      setSavedClassSets(sets);
      if (o.customColors && typeof o.customColors === 'object') {
        const colors: Record<number, string> = {};
        for (const [k, v] of Object.entries(o.customColors)) {
          if (typeof v === 'string') colors[Number(k)] = v;
        }
        setCustomClassColors(colors);
      }
      setStorageRestored(true);
    } catch {
      setStorageRestored(true);
    }
  }, []);

  /** 세트 목록·선택·색상 변경 시 저장 (복원 완료 후에만) */
  const persistSavedSets = useCallback(() => {
    try {
      localStorage.setItem(
        SAVED_SETS_STORAGE_KEY,
        JSON.stringify({
          savedClassSets,
          activeClassSetId,
          customColors: customClassColors,
        })
      );
    } catch {
      /* ignore */
    }
  }, [savedClassSets, activeClassSetId, customClassColors]);

  useEffect(() => {
    if (!storageRestored) return;
    persistSavedSets();
  }, [storageRestored, persistSavedSets]);

  const currentItem = imageList[currentIndex] ?? null;

  /** 현재 이미지(캔버스) 기준 클래스별 박스 수 */
  const classBoxCounts = useMemo(() => {
    const m = new Map<number, number>();
    if (!displayAnnotations.length) return m;
    for (const b of displayAnnotations) {
      m.set(b.classId, (m.get(b.classId) ?? 0) + 1);
    }
    return m;
  }, [displayAnnotations]);

  const loadAnnotationsForIndex = useCallback(async (index: number): Promise<BoundingBox[]> => {
    if (!window.electron || index < 0 || index >= imageList.length) return [];
    const item = imageList[index];
    try {
      const content = await window.electron.readTxt(item.txtPath);
      return parseYoloTxt(content);
    } catch {
      return [];
    }
  }, [imageList]);

  // 폴더가 바뀌면 표시 초기화
  useEffect(() => {
    setDisplayItem(null);
    setDisplayAnnotations([]);
  }, [imageList]);

  // 현재 인덱스에 대해 라벨 로드 후, 이미지+라벨을 동시에 갱신
  useEffect(() => {
    if (!currentItem || !window.electron) return;
    const index = currentIndex;
    let cancelled = false;
    loadAnnotationsForIndex(index).then((loaded) => {
      if (cancelled || index !== currentIndex) return;
      setDisplayItem(currentItem);
      setDisplayAnnotations(loaded);
    });
    return () => { cancelled = true; };
  }, [currentIndex, currentItem, loadAnnotationsForIndex]);

  const handleOpenFolder = async () => {
    if (!window.electron) return;
    try {
      const path = await window.electron.openFolderDialog();
      if (!path) return;
      await window.electron.setWorkspaceRoot(path);
      const list = await window.electron.scanFolder(path);
      setWorkFolderPath(path);
      setImageList(list);
      setCurrentIndex(0);
      setStatusMessage(`폴더 열림: ${path} (${list.length}개 이미지)`);
    } catch (e) {
      setStatusMessage('폴더 열기 실패: ' + (e as Error).message);
    }
  };

  /** txt 파일을 불러와 새 클래스 세트로 저장하고 적용 */
  const handleLoadFileAndSave = async () => {
    if (!window.electron) return;
    setLabelMenuOpen(false);
    try {
      const path = await window.electron.openLabelFileDialog();
      if (!path) return;
      const content = await window.electron.readLabelFile(path);
      const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
      const displayName = path.replace(/^.*[/\\]/, '').replace(/\.txt$/i, '') || 'classes';
      const newSet: SavedClassSet = {
        id: crypto.randomUUID(),
        displayName,
        classNames: lines,
      };
      setSavedClassSets((prev) => [...prev, newSet]);
      setActiveClassSetId(newSet.id);
      const yolo = classNamesToYoloClasses(newSet.classNames);
      setClasses(yolo);
      setSelectedClass(yolo[0] ?? null);
      setStatusMessage(`저장됨: ${newSet.displayName} (${lines.length}개 클래스)`);
    } catch (e) {
      setStatusMessage('라벨 파일 열기 실패: ' + (e as Error).message);
    }
  };

  /** 저장된 세트 선택 시 적용 */
  const applySavedSet = useCallback((id: string) => {
    const set = savedClassSets.find((s) => s.id === id);
    if (!set) return;
    setLabelMenuOpen(false);
    setActiveClassSetId(id);
    const yolo = classNamesToYoloClasses(set.classNames);
    setClasses(yolo);
    setSelectedClass(yolo[0] ?? null);
    setStatusMessage(`적용: ${set.displayName}`);
  }, [savedClassSets]);

  /** 세트 표시 이름 변경 */
  const renameSavedSet = useCallback((id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSavedClassSets((prev) => prev.map((s) => (s.id === id ? { ...s, displayName: trimmed } : s)));
    setRenameId(null);
    setRenameValue('');
  }, []);

  /** 세트 삭제 */
  const removeSavedSet = useCallback((id: string) => {
    setSavedClassSets((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeClassSetId === id) {
        const first = next[0];
        if (first) {
          setActiveClassSetId(first.id);
          const yolo = classNamesToYoloClasses(first.classNames);
          setClasses(yolo);
          setSelectedClass(yolo[0] ?? null);
        } else {
          setActiveClassSetId(null);
          setClasses([]);
          setSelectedClass(null);
        }
      }
      return next;
    });
    setRenameId(null);
  }, [activeClassSetId]);

  useEffect(() => {
    if (!labelMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (labelMenuRef.current && !labelMenuRef.current.contains(e.target as Node)) setLabelMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [labelMenuOpen]);

  useEffect(() => {
    if (renameId) renameInputRef.current?.focus();
  }, [renameId]);

  /** Goto 입력값을 현재 인덱스와 동기화 */
  useEffect(() => {
    if (imageList.length > 0) setGotoValue(String(currentIndex + 1));
    else setGotoValue('');
  }, [currentIndex, imageList.length]);

  /** 드롭다운 열릴 때 트리거 위치 갱신 (portal 위치용) */
  useEffect(() => {
    if (!labelMenuOpen || !labelTriggerRef.current) {
      setLabelDropdownRect(null);
      return;
    }
    const update = () => {
      if (labelTriggerRef.current) {
        const rect = labelTriggerRef.current.getBoundingClientRect();
        setLabelDropdownRect({ top: rect.bottom, left: rect.left, width: rect.width });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [labelMenuOpen]);

  const loadFolderStats = useCallback(async () => {
    if (!window.electron || imageList.length === 0) return;
    setStatsLoading(true);
    setFolderStats(null);
    try {
      const byClassMap = new Map<number, number>();
      let totalBoxes = 0;
      let imagesWithLabels = 0;
      for (const item of imageList) {
        try {
          const content = await window.electron!.readTxt(item.txtPath);
          const boxes = parseYoloTxt(content);
          totalBoxes += boxes.length;
          if (boxes.length > 0) imagesWithLabels += 1;
          for (const b of boxes) {
            byClassMap.set(b.classId, (byClassMap.get(b.classId) ?? 0) + 1);
          }
        } catch {
          // no txt or read error
        }
      }
      const byClass = Array.from(byClassMap.entries())
        .map(([classId, count]) => ({
          classId,
          name: classes.find((c) => c.id === classId)?.name ?? `클래스 ID ${classId}`,
          count,
        }))
        .sort((a, b) => b.count - a.count);
      setFolderStats({
        totalImages: imageList.length,
        imagesWithLabels,
        imagesWithoutLabels: imageList.length - imagesWithLabels,
        totalBoxes,
        byClass,
      });
    } finally {
      setStatsLoading(false);
    }
  }, [imageList, classes]);

  useEffect(() => {
    if (showStatsModal && imageList.length > 0) loadFolderStats();
  }, [showStatsModal, imageList.length, loadFolderStats]);

  const handleUpdateAnnotations = useCallback(
    (newAnnotations: BoundingBox[]) => {
      setDisplayAnnotations(newAnnotations);
      if (!window.electron || !displayItem) return;
      const content = generateYoloTxt(newAnnotations);
      window.electron.writeTxt(displayItem.txtPath, content);
    },
    [displayItem]
  );

  const saveCurrent = useCallback(() => {
    if (!window.electron || !displayItem) return;
    window.electron.writeTxt(displayItem.txtPath, generateYoloTxt(displayAnnotations));
  }, [displayItem, displayAnnotations]);

  const goPrev = useCallback(() => {
    if (currentIndex <= 0) return;
    saveCurrent();
    setCurrentIndex((i) => i - 1);
  }, [currentIndex, saveCurrent]);

  const goNext = useCallback(() => {
    if (currentIndex >= imageList.length - 1) return;
    saveCurrent();
    setCurrentIndex((i) => i + 1);
  }, [currentIndex, imageList.length, saveCurrent]);

  const handleDeleteCurrentImage = useCallback(async () => {
    if (!window.electron || !displayItem) return;
    const msg = `현재 이미지와 해당 라벨 파일을 삭제할까요?\n이 작업은 되돌릴 수 없습니다.\n\n${displayItem.name}`;
    if (!window.confirm(msg)) return;
    const result = await window.electron.deleteImageAndTxt(displayItem.imagePath, displayItem.txtPath);
    if (!result.ok) {
      setStatusMessage('삭제 실패: ' + (result.error || '알 수 없음'));
      return;
    }
    const nextList = imageList.filter((item) => item.imagePath !== displayItem!.imagePath);
    setImageList(nextList);
    if (nextList.length === 0) {
      setDisplayItem(null);
      setDisplayAnnotations([]);
      setCurrentIndex(0);
      setStatusMessage('이미지와 라벨 파일이 삭제되었습니다.');
      return;
    }
    const nextIndex = currentIndex >= nextList.length ? nextList.length - 1 : currentIndex;
    setCurrentIndex(nextIndex);
    setStatusMessage(`삭제됨: ${displayItem.name}`);
  }, [displayItem, imageList, currentIndex]);

  const goPrevRef = useRef(goPrev);
  const goNextRef = useRef(goNext);
  const handleUpdateAnnotationsRef = useRef(handleUpdateAnnotations);
  const handleOpenFolderRef = useRef(handleOpenFolder);
  const handleLoadFileAndSaveRef = useRef(handleLoadFileAndSave);
  const currentItemRef = useRef<OfflineImageItem | null>(null);
  const annotationsRef = useRef<BoundingBox[]>([]);
  goPrevRef.current = goPrev;
  goNextRef.current = goNext;
  handleUpdateAnnotationsRef.current = handleUpdateAnnotations;
  handleOpenFolderRef.current = handleOpenFolder;
  handleLoadFileAndSaveRef.current = handleLoadFileAndSave;
  currentItemRef.current = displayItem;
  annotationsRef.current = displayAnnotations;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isCtrlS = e.ctrlKey && key === 's';
      if (isCtrlS) e.preventDefault();

      if (e.ctrlKey && key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        handleOpenFolderRef.current();
        return;
      }
      if (e.ctrlKey && key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        handleLoadFileAndSaveRef.current();
        return;
      }
      if (e.ctrlKey && key === 'g') {
        e.preventDefault();
        e.stopPropagation();
        gotoInputRef.current?.focus();
        gotoInputRef.current?.select();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (isCtrlS) {
        if (currentItemRef.current) handleUpdateAnnotationsRef.current(annotationsRef.current);
        return;
      }
      if (key === 'a' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        goPrevRef.current();
        return;
      }
      if (key === 'd' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        goNextRef.current();
        return;
      }

      const curClasses = classesRef.current;
      const curSelected = selectedClassRef.current;

      // 백틱: 모든 객체 표시/숨김 토글
      if (key === '`') {
        e.preventDefault();
        e.stopPropagation();
        setHiddenClassIds((prev) =>
          prev.length > 0 ? [] : curClasses.map((c) => c.id)
        );
        return;
      }
      // W / S: 활성 클래스 이전/다음
      if (curClasses.length > 0 && (key === 'w' || key === 's')) {
        e.preventDefault();
        e.stopPropagation();
        const idx = curClasses.findIndex((c) => c.id === curSelected?.id);
        if (key === 'w') {
          if (idx <= 0) setSelectedClass(curClasses[curClasses.length - 1]);
          else setSelectedClass(curClasses[idx - 1]);
        } else {
          if (idx < 0 || idx >= curClasses.length - 1) setSelectedClass(curClasses[0]);
          else setSelectedClass(curClasses[idx + 1]);
        }
        return;
      }
      // 1-9: 클래스 숫자 단축키
      if (key >= '1' && key <= '9') {
        const idx = parseInt(key, 10) - 1;
        if (idx < curClasses.length) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedClass(curClasses[idx]);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  if (!isElectron) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-400 p-8">
        <div className="w-14 h-14 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
          <svg className="w-7 h-7 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        </div>
        <p className="text-sm font-medium text-slate-300">Electron으로 실행해 주세요</p>
        <p className="text-xs text-slate-500 text-center max-w-sm">npm run electron:dev 또는 빌드 후 exe 실행</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ backgroundColor: 'var(--bg-deep)' }}>
      <header className="glass flex-shrink-0 border-b border-white/10 px-5 py-3 flex items-center gap-4 rounded-none overflow-visible">
        <div className="flex items-center gap-2">
          <button type="button" onClick={handleOpenFolder} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_20px_rgba(82,182,255,0.15)]" style={{ color: 'var(--accent-blue)' }}>폴더 (Ctrl+O)</button>
          <div className="relative" ref={labelMenuRef}>
            <button
              ref={labelTriggerRef}
              type="button"
              onClick={() => setLabelMenuOpen((o) => !o)}
              className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_20px_rgba(82,182,255,0.15)] inline-flex items-center gap-1.5"
              style={{ color: 'var(--accent-blue)' }}
              aria-expanded={labelMenuOpen}
              aria-haspopup="true"
              title="클래스 세트 선택"
            >
              {savedClassSets.find((s) => s.id === activeClassSetId)?.displayName ?? '클래스 세트'}
              <svg className={`w-4 h-4 transition-transform ${labelMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {labelMenuOpen &&
              labelDropdownRect &&
              createPortal(
                <div
                  className="fixed py-1 min-w-[240px] max-h-[320px] overflow-auto rounded-xl glass border border-white/10 shadow-2xl bg-slate-900/95 backdrop-blur-xl"
                  style={{
                    top: labelDropdownRect.top + 4,
                    left: labelDropdownRect.left,
                    zIndex: 99999,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">저장된 세트</div>
                  {savedClassSets.length === 0 ? (
                    <div className="px-4 py-2 text-sm text-slate-500">저장된 세트 없음</div>
                  ) : (
                    savedClassSets.map((set) => (
                      <div
                        key={set.id}
                        className={`flex items-center gap-1 px-2 py-1.5 rounded-lg group ${activeClassSetId === set.id ? 'bg-[var(--accent-purple)]/20' : 'hover:bg-white/10'}`}
                      >
                        {renameId === set.id ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => renameSavedSet(set.id, renameValue)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') renameSavedSet(set.id, renameValue);
                              if (e.key === 'Escape') { setRenameId(null); setRenameValue(''); }
                            }}
                            className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-slate-800 border border-white/20 rounded text-white"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => applySavedSet(set.id)}
                              className="flex-1 min-w-0 text-left text-sm text-slate-200 truncate py-0.5"
                            >
                              {set.displayName}
                              <span className="ml-1 text-slate-500 text-xs">({set.classNames.length})</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setRenameId(set.id); setRenameValue(set.displayName); }}
                              className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="이름 변경"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); removeSavedSet(set.id); }}
                              className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="삭제"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                          </>
                        )}
                      </div>
                    ))
                  )}
                  <div className="border-t border-white/10 mt-1 pt-1">
                    <button
                      type="button"
                      onClick={handleLoadFileAndSave}
                      className="w-full px-4 py-2.5 text-left text-sm text-[var(--accent-blue)] hover:bg-white/10 transition-colors rounded-lg flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                      파일에서 불러와 저장 (Ctrl+L)
                    </button>
                  </div>
                </div>,
                document.body
              )}
          </div>
          <button type="button" onClick={() => handleUpdateAnnotations(displayAnnotations)} className="px-3.5 py-2 rounded-xl text-sm font-medium transition-all border border-[var(--accent-lime)]/50 shadow-[0_0_20px_rgba(168,230,27,0.2)] hover:shadow-[0_0_24px_rgba(168,230,27,0.3)]" style={{ backgroundColor: 'var(--accent-lime)', color: '#1A1A2E' }}>저장 (Ctrl+S)</button>
          {displayItem && window.electron && (
            <>
              <button type="button" onClick={() => window.electron!.showItemInFolder(displayItem.imagePath)} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_20px_rgba(82,182,255,0.15)]" style={{ color: 'var(--accent-blue)' }} title="현재 이미지 폴더를 탐색기에서 열기">
                <span className="inline-flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2-2z" /></svg>
                  폴더 열기
                </span>
              </button>
              <button type="button" onClick={handleDeleteCurrentImage} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:bg-red-500/20 hover:border-red-400/50 hover:text-red-400" title="현재 이미지와 라벨 파일 삭제">
                <span className="inline-flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  이미지 삭제
                </span>
              </button>
            </>
          )}
          {imageList.length > 0 && (
            <button type="button" onClick={() => setShowStatsModal(true)} className="px-3.5 py-2 rounded-xl glass border border-white/10 text-sm font-medium transition-all hover:border-[var(--accent-purple)] hover:shadow-[0_0_20px_rgba(176,142,212,0.2)]" style={{ color: 'var(--accent-purple)' }} title="폴더 내 객체 통계">
              <span className="inline-flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                폴더 통계
              </span>
            </button>
          )}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-3 ml-2">
          {displayItem ? (
            <span className="text-base font-bold font-mono truncate max-w-md" style={{ color: 'var(--accent-lime)' }} title={displayItem.name}>{displayItem.name}</span>
          ) : (
            <span className="text-slate-400 text-sm truncate" title={statusMessage}>{statusMessage || '\u00A0'}</span>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <aside className="glass w-72 flex-shrink-0 border-r border-white/10 overflow-auto flex flex-col">
          <div className="p-3 pb-2">
            <div className="text-[10px] font-bold uppercase tracking-widest mb-3 text-slate-400">Classes (1-9)</div>
            {classes.length === 0 ? (
              <div className="glass-card p-4 text-center">
                <p className="text-slate-400 text-sm">라벨 파일을 열어</p>
                <p className="text-slate-400 text-sm mt-0.5">클래스를 불러오세요.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {classes.map((c, idx) => {
                  const displayColor = customClassColors[c.id] ?? c.color;
                  const isSelected = selectedClass?.id === c.id;
                  return (
                  <li key={c.id} className="group flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedClass(c)}
                      className={`flex-1 min-w-0 flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-left transition-all border ${isSelected ? 'bg-[rgba(176,142,212,0.35)] border-[var(--accent-purple)] border-2 shadow-[0_0_20px_rgba(176,142,212,0.4)] ring-2 ring-[var(--accent-purple)]/30' : 'border-transparent bg-transparent hover:bg-white/5 hover:border-white/10 text-slate-300'}`}
                      style={isSelected ? { color: '#fff' } : undefined}
                    >
                      <div className="relative shrink-0 flex items-center justify-center">
                        <input
                          type="color"
                          id={`class-color-${c.id}`}
                          value={displayColor}
                          onChange={(e) => setCustomClassColors((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          className="absolute w-4 h-4 opacity-0 cursor-pointer"
                          style={{ left: 0, top: 0 }}
                          tabIndex={-1}
                          aria-label={`${c.name} 색상 변경`}
                          title="색상 변경"
                        />
                        <span
                          role="button"
                          tabIndex={0}
                          className="block w-4 h-4 rounded-full border-2 border-white/30 shadow-inner cursor-pointer hover:scale-110 transition-transform hover:ring-2 hover:ring-white/50"
                          style={{ backgroundColor: displayColor }}
                          onClick={(e) => { e.stopPropagation(); document.getElementById(`class-color-${c.id}`)?.click(); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); document.getElementById(`class-color-${c.id}`)?.click(); } }}
                          title="색상 변경"
                        />
                      </div>
                      <div className="flex items-baseline gap-1.5 min-w-0 flex-1" title={`단축키 ${idx + 1}`}>
                        <span className={`truncate font-semibold min-w-0 ${hiddenClassIds.includes(c.id) ? 'text-slate-600 line-through' : ''} ${isSelected ? 'text-white' : 'text-slate-200'}`}>
                          {c.name}
                        </span>
                        <span className={`shrink-0 text-[10px] font-mono tabular-nums ${isSelected ? 'text-white/80' : 'text-slate-500'}`}>
                          {idx + 1}
                        </span>
                      </div>
                      <span
                        className={`shrink-0 tabular-nums text-xs font-bold leading-none rounded-full px-2 py-0.5 text-right border min-w-[1.35rem] ${(classBoxCounts.get(c.id) ?? 0) > 0 ? 'border-white/25 shadow-[0_0_10px_rgba(168,230,27,0.3)]' : 'text-slate-500 border-transparent'}`}
                        style={(classBoxCounts.get(c.id) ?? 0) > 0 ? { backgroundColor: 'var(--accent-lime)', color: '#1A1A2E' } : undefined}
                        title="현재 이미지 박스 수"
                      >
                        {classBoxCounts.get(c.id) ?? 0}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHiddenClassIds((prev) => (prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]))}
                      className={`shrink-0 p-1.5 rounded-xl transition-all border ${hiddenClassIds.includes(c.id) ? 'bg-red-500/20 border-red-400/40 text-red-400' : 'border-transparent bg-transparent text-slate-500 hover:bg-white/5 hover:text-slate-200 hover:border-white/10'}`}
                      title={hiddenClassIds.includes(c.id) ? '클래스 표시' : '클래스 숨김'}
                    >
                      {hiddenClassIds.includes(c.id) ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" /></svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      )}
                    </button>
                  </li>
                  );
                })}
              </ul>
            )}
          </div>
          {imageList.length > 0 && (
            <div className="mt-auto p-3 pt-2 border-t border-white/10">
              <div className="text-[10px] font-bold uppercase tracking-widest mb-1.5 text-slate-500">Goto (Ctrl+G)</div>
              <div className="flex items-center gap-2">
                <input
                  ref={gotoInputRef}
                  type="number"
                  min={1}
                  max={imageList.length}
                  value={gotoValue}
                  onChange={(e) => setGotoValue(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const num = Math.min(imageList.length, Math.max(1, parseInt(gotoValue, 10) || 1));
                      setGotoValue(String(num));
                      saveCurrent();
                      setCurrentIndex(num - 1);
                      gotoInputRef.current?.blur();
                    }
                  }}
                  onBlur={() => setGotoValue(String(currentIndex + 1))}
                  className="w-16 px-2 py-1.5 text-sm font-mono tabular-nums rounded-lg bg-slate-800 border border-white/10 text-white focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)] outline-none"
                  title="이미지 번호 입력 후 Enter"
                />
                <span className="text-slate-500 text-sm">/ {imageList.length}</span>
              </div>
            </div>
          )}
        </aside>

        <main className="flex-1 flex flex-col min-w-0" style={{ backgroundColor: 'var(--bg-deep)' }}>
          {!currentItem ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-20 h-20 rounded-2xl flex items-center justify-center">
                <svg className="w-10 h-10" style={{ color: 'var(--accent-blue)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14" /></svg>
              </div>
              <p className="text-sm font-medium text-slate-300">작업 폴더를 열어 이미지를 불러오세요</p>
              <p className="text-xs text-slate-500">Ctrl+O 또는 상단 [폴더] 버튼</p>
            </div>
          ) : !displayItem ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <div className="glass-card w-16 h-16 rounded-2xl flex items-center justify-center animate-pulse">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              </div>
              <p className="text-sm text-slate-400">라벨 로딩 중...</p>
            </div>
          ) : (
            <>
              <div className="flex-1 relative overflow-hidden bg-black">
                <AnnotationCanvas
                  imageUrl={displayItem.imageUrl}
                  annotations={displayAnnotations}
                  currentClass={selectedClass ?? { id: -1, name: 'None', color: '#666' }}
                  classes={classes}
                  readOnly={false}
                  onUpdateAnnotations={handleUpdateAnnotations}
                  hiddenClassIds={hiddenClassIds}
                  customClassColors={customClassColors}
                  undoSignal={undoSignal}
                  redoSignal={redoSignal}
                />
              </div>
              <footer className="glass flex-shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={goPrev} disabled={currentIndex <= 0} className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)] disabled:hover:border-white/10 disabled:hover:shadow-none" style={{ color: 'var(--accent-blue)' }}>이전 (A)</button>
                  <button type="button" onClick={goNext} disabled={currentIndex >= imageList.length - 1} className="px-4 py-2 rounded-xl glass border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-all hover:border-[var(--accent-blue)] hover:shadow-[0_0_16px_rgba(82,182,255,0.15)] disabled:hover:border-white/10 disabled:hover:shadow-none" style={{ color: 'var(--accent-blue)' }}>다음 (D)</button>
                </div>
                {imageList.length > 0 && (
                  <>
                    <span className="shrink-0 text-lg font-bold tabular-nums whitespace-nowrap" style={{ color: 'var(--accent-blue)' }}>
                      {currentIndex + 1} / {imageList.length}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, imageList.length - 1)}
                      value={currentIndex}
                      onChange={(e) => {
                        const next = parseInt(e.target.value, 10);
                        if (next !== currentIndex) {
                          saveCurrent();
                          setCurrentIndex(next);
                        }
                      }}
                      className="progress-slider flex-1 min-w-0 h-2 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:shadow-lg [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0"
                      style={{ background: 'rgba(255,255,255,0.1)' }}
                    />
                  </>
                )}
              </footer>
            </>
          )}
        </main>
      </div>

      {/* 폴더 통계 모달 */}
      {showStatsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowStatsModal(false)}>
          <div className="glass-card max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col border border-white/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <h2 className="text-lg font-bold text-white">폴더 통계</h2>
              <button type="button" onClick={() => setShowStatsModal(false)} className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors" aria-label="닫기">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 overflow-auto flex-1 min-h-0">
              {statsLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="w-10 h-10 border-2 border-[var(--accent-purple)] border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-slate-400">통계 계산 중...</p>
                </div>
              ) : folderStats ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">총 이미지</p>
                      <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--accent-blue)' }}>{folderStats.totalImages}</p>
                    </div>
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">총 객체 수</p>
                      <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--accent-lime)' }}>{folderStats.totalBoxes}</p>
                    </div>
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">라벨 있음</p>
                      <p className="text-xl font-bold tabular-nums text-emerald-300">{folderStats.imagesWithLabels}</p>
                    </div>
                    <div className="glass rounded-xl p-4 border border-white/10">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">라벨 없음</p>
                      <p className="text-xl font-bold tabular-nums text-amber-300">{folderStats.imagesWithoutLabels}</p>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">클래스별 객체 수</h3>
                    {folderStats.byClass.length === 0 ? (
                      <p className="text-sm text-slate-400">객체가 없습니다.</p>
                    ) : (
                      <div className="space-y-2.5">
                        {folderStats.byClass.map((row) => {
                          const pct = folderStats!.totalBoxes > 0 ? (row.count / folderStats!.totalBoxes) * 100 : 0;
                          return (
                            <div key={row.classId} className="flex items-center gap-3">
                              <span className="w-28 shrink-0 text-sm font-medium text-slate-200 truncate" title={row.name}>{row.name}</span>
                              <div className="flex-1 min-w-0 h-6 rounded-lg bg-slate-800/80 overflow-hidden">
                                <div
                                  className="h-full rounded-lg transition-all min-w-0"
                                  style={{ width: `${Math.max(2, pct)}%`, backgroundColor: 'var(--accent-purple)', opacity: 0.85 }}
                                />
                              </div>
                              <span className="w-12 shrink-0 text-right text-sm font-bold tabular-nums text-slate-300">{row.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default YoloWorkspace;
