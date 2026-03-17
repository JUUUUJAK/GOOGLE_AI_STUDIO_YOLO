import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Task, TaskStatus } from '../types';
import type { YoloClass } from '../types';

type ClassificationPanelProps = {
  task: Task;
  classes: YoloClass[];
  selectedClassId?: number | null;
  onSelectedClassIdChange?: (classId: number | null) => void;
  readOnly?: boolean;
  remainingCount?: number;
  isSaving?: boolean;
  onSave?: (classId: number | null) => void;
  onSubmit?: () => void;
  onSubmitAndNext?: () => void;
  onDraftChange?: (classId: number | null) => void;
};

const safeParse = (raw?: string): { classId?: number } | null => {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (_e) {
    return null;
  }
};

const ClassificationPanel: React.FC<ClassificationPanelProps> = ({
  task,
  classes,
  readOnly = false,
  remainingCount = 0,
  isSaving = false,
  selectedClassId: controlledSelectedClassId,
  onSelectedClassIdChange,
  onSave,
  onSubmit,
  onSubmitAndNext,
  onDraftChange
}) => {
  const parsed = useMemo(() => safeParse(task.sourceData), [task.sourceData]);
  const initialClassId = parsed?.classId ?? null;
  const [internalSelected, setInternalSelected] = useState<number | null>(initialClassId);

  const isControlled = controlledSelectedClassId !== undefined;
  const selectedClassId = isControlled ? (controlledSelectedClassId ?? null) : internalSelected;
  const setSelectedClassId = useCallback((id: number | null) => {
    if (isControlled) onSelectedClassIdChange?.(id);
    else setInternalSelected(id);
  }, [isControlled, onSelectedClassIdChange]);

  useEffect(() => {
    onDraftChange?.(selectedClassId);
  }, [selectedClassId, onDraftChange]);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isControlled) setInternalSelected(initialClassId);
  }, [task.id, initialClassId, isControlled]);

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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isPanning && lastPanPos) {
      const dx = e.clientX - lastPanPos.x;
      const dy = e.clientY - lastPanPos.y;
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      setLastPanPos({ x: e.clientX, y: e.clientY });
    }
  }, [isPanning, lastPanPos]);

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

  const imageSrc = task.imageUrl?.startsWith('/') ? task.imageUrl : `/datasets/${task.imageUrl || ''}`;
  const canSubmit = !readOnly && task.status !== TaskStatus.ISSUE_PENDING;

  const scalePresets = [
    { value: 1, label: '100%' },
    { value: 0.75, label: '75%' },
    { value: 0.5, label: '50%' },
    { value: 0.25, label: '25%' },
    { value: 0.15, label: '최소' }
  ];

  return (
    <div className="h-full overflow-auto bg-slate-950 p-5 flex flex-col gap-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0">
        <div
          ref={imageContainerRef}
          className="bg-slate-900 border border-slate-800 rounded-xl p-3 h-[55vh] min-h-[320px] flex items-center justify-center relative overflow-hidden"
          onMouseDown={handleMouseDown}
          onContextMenu={(e) => e.preventDefault()}
          style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        >
          <div
            className="relative origin-center h-full flex items-center justify-center"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transition: isPanning ? 'none' : 'transform 0.075s ease-out'
            }}
          >
            <img
              src={imageSrc}
              alt={task.name}
              className="h-full max-w-full rounded-lg border border-slate-700 object-contain pointer-events-none select-none"
              draggable={false}
            />
          </div>
          <div className="absolute top-2 left-2 right-2 flex items-center justify-between gap-2 pointer-events-none">
            <div className="flex gap-1 pointer-events-auto">
              {scalePresets.map(({ value, label }) => {
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
        <div className="flex flex-col gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-bold text-slate-200 mb-3">분류 선택</h3>
            {classes.length === 0 ? (
              <p className="text-slate-500 text-sm">이 프로젝트에 클래스가 없습니다. 프로젝트 설정에서 클래스를 추가해주세요.</p>
            ) : (
              <div className="space-y-2">
                {classes.map((cls) => (
                  <label
                    key={cls.id}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                      selectedClassId === cls.id
                        ? 'border-sky-500 bg-sky-900/30 text-sky-100'
                        : 'border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-600'
                    } ${readOnly ? 'cursor-default' : ''}`}
                  >
                    <input
                      type="radio"
                      name="classification-class"
                      checked={selectedClassId === cls.id}
                      onChange={() => {
                        if (readOnly) return;
                        setSelectedClassId(cls.id);
                      }}
                      disabled={readOnly || isSaving || task.status === TaskStatus.ISSUE_PENDING}
                      className="sr-only"
                    />
                    <span
                      className="w-4 h-4 rounded-full border-2 flex-shrink-0"
                      style={{ borderColor: cls.color, backgroundColor: selectedClassId === cls.id ? cls.color : 'transparent' }}
                    />
                    <span className="font-medium">{cls.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {!readOnly && classes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onSave?.(selectedClassId)}
                disabled={isSaving || task.status === TaskStatus.ISSUE_PENDING}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 text-sm font-semibold disabled:opacity-50"
              >
                저장
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onSave?.(selectedClassId);
                  onSubmit?.();
                }}
                disabled={isSaving || task.status === TaskStatus.ISSUE_PENDING}
                className="px-4 py-2 rounded-lg bg-amber-600/80 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-50"
              >
                제출
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onSave?.(selectedClassId);
                  onSubmitAndNext?.();
                }}
                disabled={isSaving || task.status === TaskStatus.ISSUE_PENDING}
                className="px-4 py-2 rounded-lg bg-lime-600 hover:bg-lime-500 text-white text-sm font-bold disabled:opacity-50"
              >
                다음 작업
              </button>
            </div>
          )}
        </div>
      </div>
      {remainingCount >= 0 && (
        <p className="text-xs text-slate-500">남은 작업: {remainingCount}건</p>
      )}
    </div>
  );
};

export default ClassificationPanel;
