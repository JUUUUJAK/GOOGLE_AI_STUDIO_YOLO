import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import type { BoundingBox, YoloClass } from '../../types';
import { parseYoloTxt, generateYoloTxt } from './yoloFormat';

const COLOR_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#84cc16', '#f43f5e', '#6366f1', '#14b8a6', '#d946ef',
  '#f97316', '#a855f7', '#0ea5e9',
];

const AnnotationCanvas = lazy(() => import('../../components/AnnotationCanvas'));

function loadClassesFromContent(content: string): YoloClass[] {
  const names = content
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return names.map((name, i) => ({
    id: i,
    name,
    color: COLOR_PALETTE[i % COLOR_PALETTE.length],
  }));
}

export default function App() {
  const [workFolder, setWorkFolder] = useState<string | null>(null);
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [imageUrl, setImageUrl] = useState('');
  const [annotations, setAnnotations] = useState<BoundingBox[]>([]);
  const [classes, setClasses] = useState<YoloClass[]>([]);
  const [currentClass, setCurrentClass] = useState<YoloClass | null>(null);
  const [labelFile, setLabelFile] = useState<string | null>(null);
  const [labelPaths, setLabelPaths] = useState<string[]>([]);
  const [hiddenClassIds, setHiddenClassIds] = useState<number[]>([]);

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const hasApi = !!api;

  const loadImageList = useCallback(async () => {
    if (!api || !workFolder) return;
    const list = await api.listImages(workFolder);
    setImagePaths(list);
    setCurrentIndex(list.length > 0 ? 0 : -1);
  }, [api, workFolder]);

  const loadLabelList = useCallback(async () => {
    if (!api || !workFolder) return;
    const list = await api.listLabelFiles(workFolder);
    setLabelPaths(list);
    if (list.length > 0 && !labelFile) {
      setLabelFile(list[0]);
    }
  }, [api, workFolder, labelFile]);

  useEffect(() => {
    if (!workFolder) return;
    loadImageList();
    loadLabelList();
  }, [workFolder, loadImageList, loadLabelList]);

  useEffect(() => {
    if (!api || !labelFile) return;
    api.readLabelFile(labelFile).then((content) => {
      setClasses(loadClassesFromContent(content));
      setCurrentClass((prev) => (prev === null ? loadClassesFromContent(content)[0] ?? null : prev));
    });
  }, [api, labelFile]);

  const currentImagePath = currentIndex >= 0 && currentIndex < imagePaths.length ? imagePaths[currentIndex] : null;

  useEffect(() => {
    if (!api || !currentImagePath) {
      setImageUrl('');
      setAnnotations([]);
      return;
    }
    api.pathToFileUrl(currentImagePath).then(setImageUrl);
    api.readLabel(currentImagePath).then((txt) => setAnnotations(parseYoloTxt(txt)));
  }, [api, currentImagePath]);

  const saveCurrent = useCallback(async () => {
    if (!api || !currentImagePath) return;
    const txt = generateYoloTxt(annotations);
    await api.writeLabel(currentImagePath, txt);
  }, [api, currentImagePath, annotations]);

  const goPrev = useCallback(async () => {
    await saveCurrent();
    if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
  }, [saveCurrent, currentIndex]);

  const goNext = useCallback(async () => {
    await saveCurrent();
    if (currentIndex < imagePaths.length - 1) setCurrentIndex(currentIndex + 1);
  }, [saveCurrent, currentIndex, imagePaths.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        goNext();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        chooseFolder();
      } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveCurrent();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        openLabelFile();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, saveCurrent, chooseFolder, openLabelFile]);

  const chooseFolder = async () => {
    if (!api) return;
    const folder = await api.chooseFolder();
    if (folder) setWorkFolder(folder);
  };

  const openLabelFile = async () => {
    if (!api) return;
    const path = await api.openLabelFileDialog();
    if (path) {
      setLabelFile(path);
      setLabelPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
    }
  };

  const deleteCurrentImage = async () => {
    if (!api || !currentImagePath) return;
    if (!confirm('이 이미지와 라벨 파일을 삭제할까요?')) return;
    await api.deleteImage(currentImagePath);
    const nextPaths = imagePaths.filter((_, i) => i !== currentIndex);
    setImagePaths(nextPaths);
    setCurrentIndex(Math.min(currentIndex, nextPaths.length - 1));
  };

  const toggleClassVisibility = (classId: number) => {
    setHiddenClassIds((prev) =>
      prev.includes(classId) ? prev.filter((id) => id !== classId) : [...prev, classId]
    );
  };

  if (!hasApi) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        Electron 환경에서 실행해 주세요.
      </div>
    );
  }

  const canPrev = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex < imagePaths.length - 1;

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-slate-900 border-b border-slate-800 flex-shrink-0">
        <button
          type="button"
          onClick={goPrev}
          disabled={!canPrev}
          className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold"
        >
          이전 (+Save)
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={!canNext}
          className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-bold"
        >
          다음 (+Save)
        </button>
        <span className="text-slate-500 mx-2">|</span>
        <button
          type="button"
          onClick={chooseFolder}
          className="px-3 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 text-sm font-bold"
        >
          작업폴더 열기 (Ctrl+O)
        </button>
        <button
          type="button"
          onClick={saveCurrent}
          disabled={!currentImagePath}
          className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm font-bold"
        >
          작업 저장 (Ctrl+S)
        </button>
        <button
          type="button"
          onClick={openLabelFile}
          className="px-3 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-sm font-bold"
        >
          라벨파일 열기 (Ctrl+L)
        </button>
        <button
          type="button"
          onClick={deleteCurrentImage}
          disabled={!currentImagePath}
          className="px-3 py-2 rounded-lg bg-red-900 hover:bg-red-800 disabled:opacity-40 text-sm font-bold"
        >
          이미지 삭제
        </button>
        <div className="flex-1" />
        <span className="text-slate-400 text-sm">
          {currentImagePath
            ? `${currentIndex + 1} / ${imagePaths.length}`
            : workFolder
              ? '이미지 없음'
              : '폴더를 선택하세요'}
        </span>
        {classes.length > 0 && (
          <select
            value={currentClass?.id ?? ''}
            onChange={(e) => {
              const c = classes.find((x) => x.id === Number(e.target.value));
              if (c) setCurrentClass(c);
            }}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm"
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar: 라벨셋 + CLASSES */}
        <div className="w-60 flex-shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col overflow-hidden">
          <div className="p-2 border-b border-slate-800">
            <div className="text-xs font-bold text-slate-400 mb-1">라벨셋</div>
            <select
              value={labelPaths.indexOf(labelFile ?? '')}
              onChange={(e) => {
                const i = Number(e.target.value);
                if (i >= 0 && i < labelPaths.length) setLabelFile(labelPaths[i]);
              }}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm"
            >
              {labelPaths.map((p, i) => (
                <option key={p} value={i}>
                  {p.split(/[/\\]/).pop()}
                </option>
              ))}
            </select>
          </div>
          <div className="p-2 flex-1 overflow-auto">
            <div className="text-xs font-bold text-slate-400 mb-1">CLASSES</div>
            <div className="space-y-1">
              {classes.map((c) => (
                <div key={c.id} className="flex items-center gap-2 py-0.5">
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="text-sm truncate flex-1">
                    {c.name} ({c.id + 1})
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleClassVisibility(c.id)}
                    className={`text-sm ${hiddenClassIds.includes(c.id) ? 'text-slate-500' : 'text-sky-400'}`}
                    title="표시 on/off"
                  >
                    👁
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-w-0 bg-slate-950">
          {imageUrl && currentClass ? (
            <Suspense fallback={<div className="h-full flex items-center justify-center text-slate-500">캔버스 로딩 중...</div>}>
              <AnnotationCanvas
              imageUrl={imageUrl}
              annotations={annotations}
              currentClass={currentClass}
              classes={classes}
              onUpdateAnnotations={setAnnotations}
              hiddenClassIds={hiddenClassIds}
              />
            </Suspense>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-500">
              {!workFolder
                ? '작업폴더 열기로 이미지 폴더를 선택하세요.'
                : imagePaths.length === 0
                  ? '이 폴더에 이미지가 없습니다.'
                  : '라벨파일을 열어 클래스를 불러오세요.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
