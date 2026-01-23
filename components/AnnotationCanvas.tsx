import React, { useRef, useState, useEffect, useCallback } from 'react';
import { BoundingBox, YoloClass } from '../types';

interface AnnotationCanvasProps {
  imageUrl: string;
  annotations: BoundingBox[];
  currentClass: YoloClass;
  classes: YoloClass[];
  readOnly?: boolean;
  onUpdateAnnotations: (newAnnotations: BoundingBox[]) => void;
}

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';
type ToolMode = 'SELECT' | 'PAN';

const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  imageUrl,
  annotations,
  currentClass,
  classes,
  readOnly = false,
  onUpdateAnnotations,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Transform State
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);

  // UI State
  const [activeTool, setActiveTool] = useState<ToolMode>('SELECT');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [dimBoxes, setDimBoxes] = useState(false);

  // Track space key state for temporary panning
  const isSpacePressedRef = useRef(false);

  // Drawing State
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStartPos, setDrawStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentMousePos, setCurrentMousePos] = useState<{ x: number; y: number } | null>(null);

  // Selection, Moving & Resizing State
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [draggingBoxSnapshot, setDraggingBoxSnapshot] = useState<BoundingBox | null>(null);
  const [resizingHandle, setResizingHandle] = useState<ResizeHandle | null>(null);

  // Undo/Redo & Clipboard
  const [undoStack, setUndoStack] = useState<BoundingBox[][]>([]);
  const clipboardRef = useRef<BoundingBox | null>(null);

  const saveHistory = useCallback(() => {
    setUndoStack(prev => [...prev, annotations]);
  }, [annotations]);

  const handleDelete = useCallback((id: string) => {
    if (readOnly) return;
    saveHistory(); // Save before delete
    onUpdateAnnotations(annotations.filter(a => a.id !== id));
    if (selectedBoxId === id) {
      setSelectedBoxId(null);
    }
  }, [annotations, onUpdateAnnotations, readOnly, selectedBoxId, saveHistory]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (readOnly) return;

      const key = e.key.toLowerCase();
      const isCtrl = e.ctrlKey || e.metaKey;

      if (isCtrl) {
        // Undo: Ctrl + Z
        if (key === 'z') {
          e.preventDefault();
          setUndoStack(prev => {
            if (prev.length === 0) return prev;
            const newStack = [...prev];
            const lastState = newStack.pop();
            if (lastState) {
              onUpdateAnnotations(lastState);
            }
            return newStack;
          });
          return;
        }

        // Copy: Ctrl + C
        if (key === 'c' && selectedBoxId) {
          e.preventDefault();
          const box = annotations.find(b => b.id === selectedBoxId);
          if (box) clipboardRef.current = box;
          return;
        }

        // Paste: Ctrl + V
        if (key === 'v') {
          e.preventDefault();
          if (clipboardRef.current) {
            saveHistory(); // Save before paste
            const newBox = {
              ...clipboardRef.current,
              id: Math.random().toString(36).substr(2, 9),
              x: Math.min(Math.max(0, clipboardRef.current.x + 0.02), 0.9), // Offset
              y: Math.min(Math.max(0, clipboardRef.current.y + 0.02), 0.9), // Offset
              isAutoLabel: false
            };
            onUpdateAnnotations([...annotations, newBox]);
            setSelectedBoxId(newBox.id);
          }
          return;
        }
      }

      // Delete shortcuts
      if (selectedBoxId && (e.key === 'Delete' || e.key === 'Backspace' || key === 'f')) {
        e.preventDefault();
        handleDelete(selectedBoxId);
      }

      // Change Class of selected box: 'e'
      if (selectedBoxId && key === 'e') {
        e.preventDefault();
        saveHistory(); // Save before modify
        const updated = annotations.map(box =>
          box.id === selectedBoxId ? { ...box, classId: currentClass.id, isAutoLabel: false } : box
        );
        onUpdateAnnotations(updated);
      }

      if (e.key === 'Escape') {
        if (isHelpOpen) {
          setIsHelpOpen(false);
          return;
        }
        setSelectedBoxId(null);
        setIsDrawing(false);
        setDrawStartPos(null);
        setDragStartPos(null);
        setDraggingBoxSnapshot(null);
        setResizingHandle(null);
        setActiveTool('SELECT'); // Revert to select on Escape
      }

      // Tool Shortcuts
      if (key === 'h') {
        setActiveTool('PAN');
      }

      // Box Visibility Shortcut
      if (key === 'b') {
        setDimBoxes(prev => !prev);
      }

      if (key === 'v') {
        setActiveTool(prev => prev === 'SELECT' ? 'PAN' : 'SELECT');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedBoxId, handleDelete, readOnly, currentClass, annotations, onUpdateAnnotations, isHelpOpen]);

  // --- Zoom Logic ---
  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    // Smooth zoom constant
    const ZOOM_SPEED = 0.001;
    const delta = -e.deltaY * ZOOM_SPEED;
    const newScale = Math.min(Math.max(0.1, scale + delta), 10);
    setScale(newScale);
  };

  // --- Coordinate Helper (Accounts for Zoom & Pan) ---
  const getNormalizedPos = (e: React.MouseEvent | MouseEvent) => {
    if (!containerRef.current) return { x: 0, y: 0 };

    // Get Mouse relative to the Viewport Container
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const x = (clientX - pan.x) / (rect.width * scale);
    const y = (clientY - pan.y) / (rect.height * scale);

    // Clamp
    return {
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1)
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // 1. Pan Checks (Middle Click, Spacebar, Shift, or Explicit Pan Tool)
    if (activeTool === 'PAN' || e.button === 1 || (e.button === 0 && isSpacePressedRef.current) || (e.button === 0 && e.shiftKey)) {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
      return;
    }

    if (readOnly) return;

    const target = e.target as HTMLElement;

    // 2. Check Resize Handle Click
    if (target.dataset.handle) {
      const handle = target.dataset.handle as ResizeHandle;
      const boxId = target.dataset.boxid;
      if (boxId) {
        setSelectedBoxId(boxId);
        const box = annotations.find(b => b.id === boxId);
        if (box) {
          setResizingHandle(handle);
          setDragStartPos(getNormalizedPos(e));
          setDraggingBoxSnapshot(box);
        }
        return;
      }
    }

    // 3. Check Box Click (Select / Move)
    // Use elementsFromPoint to handle overlapping boxes (Cycle Selection)
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    const boxElements = elements.filter(el => (el as HTMLElement).dataset?.boxid);

    if (boxElements.length > 0) {
      // Find all box IDs under the cursor
      const boxIds = boxElements.map(el => (el as HTMLElement).dataset.boxid as string);

      // Determine next box to select
      let nextBoxId = boxIds[0];
      if (selectedBoxId && boxIds.includes(selectedBoxId)) {
        const currentIndex = boxIds.indexOf(selectedBoxId);
        nextBoxId = boxIds[(currentIndex + 1) % boxIds.length];
      }

      setSelectedBoxId(nextBoxId);

      // Initialize Drag logic if it's the selected box
      const box = annotations.find(b => b.id === nextBoxId);
      if (box) {
        saveHistory(); // Save before drag/resize
        const pos = getNormalizedPos(e);
        setDragStartPos(pos);
        setDraggingBoxSnapshot(box);
      }
      return; // Stop drawing logic
    }

    // 4. Click Empty Space (Start Drawing)
    saveHistory(); // Save before drawing new box
    setSelectedBoxId(null);
    setDragStartPos(null);
    setDraggingBoxSnapshot(null);
    setResizingHandle(null);

    const pos = getNormalizedPos(e);
    setDrawStartPos(pos);
    setCurrentMousePos(pos);
    setIsDrawing(true);
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Panning
    if (isPanning && lastPanPos) {
      const dx = e.clientX - lastPanPos.x;
      const dy = e.clientY - lastPanPos.y;
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      setLastPanPos({ x: e.clientX, y: e.clientY });
      return;
    }

    const currentPos = getNormalizedPos(e);

    // 1. Resizing
    if (resizingHandle && draggingBoxSnapshot && dragStartPos && !readOnly) {
      const dx = currentPos.x - dragStartPos.x;
      const dy = currentPos.y - dragStartPos.y;

      let { x, y, w, h } = draggingBoxSnapshot;

      // Apply delta based on handle
      if (resizingHandle === 'br') {
        w = Math.max(0.01, w + dx);
        h = Math.max(0.01, h + dy);
      } else if (resizingHandle === 'bl') {
        const maxDX = w - 0.01;
        const actualDX = Math.min(maxDX, dx);
        x = x + actualDX;
        w = w - actualDX;
        h = Math.max(0.01, h + dy);
      } else if (resizingHandle === 'tr') {
        const maxDY = h - 0.01;
        const actualDY = Math.min(maxDY, dy);
        y = y + actualDY;
        h = h - actualDY;
        w = Math.max(0.01, w + dx);
      } else if (resizingHandle === 'tl') {
        const maxDX = w - 0.01;
        const actualDX = Math.min(maxDX, dx);
        const maxDY = h - 0.01;
        const actualDY = Math.min(maxDY, dy);

        x = x + actualDX;
        w = w - actualDX;
        y = y + actualDY;
        h = h - actualDY;
      }

      // Clamp to image bounds
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { h += y; y = 0; }
      if (x + w > 1) { w = 1 - x; }
      if (y + h > 1) { h = 1 - y; }

      const updatedAnnotations = annotations.map(a =>
        a.id === draggingBoxSnapshot.id
          ? { ...a, x, y, w, h, isAutoLabel: false } // Mark as modified
          : a
      );
      onUpdateAnnotations(updatedAnnotations);
      return;
    }

    // 2. Moving an existing box
    if (dragStartPos && draggingBoxSnapshot && !resizingHandle && !readOnly) {
      const dx = currentPos.x - dragStartPos.x;
      const dy = currentPos.y - dragStartPos.y;

      let newX = draggingBoxSnapshot.x + dx;
      let newY = draggingBoxSnapshot.y + dy;

      // Clamp to image bounds
      newX = Math.max(0, Math.min(newX, 1 - draggingBoxSnapshot.w));
      newY = Math.max(0, Math.min(newY, 1 - draggingBoxSnapshot.h));

      const updatedAnnotations = annotations.map(a =>
        a.id === draggingBoxSnapshot.id
          ? { ...a, x: newX, y: newY, isAutoLabel: false } // Mark as modified
          : a
      );
      onUpdateAnnotations(updatedAnnotations);
      return;
    }

    // 3. Drawing a new box
    if (isDrawing) {
      setCurrentMousePos(currentPos);
    }
  }, [isDrawing, dragStartPos, draggingBoxSnapshot, resizingHandle, annotations, onUpdateAnnotations, readOnly, isPanning, lastPanPos, scale, pan]);

  const handleMouseUp = useCallback(() => {
    // Finish Panning
    if (isPanning) {
      setIsPanning(false);
      setLastPanPos(null);
      return;
    }

    // Finish Resizing or Moving
    if (dragStartPos) {
      setDragStartPos(null);
      setDraggingBoxSnapshot(null);
      setResizingHandle(null);
      return;
    }

    // Finish Drawing
    if (!isDrawing || !drawStartPos || !currentMousePos) return;

    // Calculate box dimensions
    const x = Math.min(drawStartPos.x, currentMousePos.x);
    const y = Math.min(drawStartPos.y, currentMousePos.y);
    const w = Math.abs(currentMousePos.x - drawStartPos.x);
    const h = Math.abs(currentMousePos.y - drawStartPos.y);

    // Minimum size threshold
    if (w > 0.01 && h > 0.01) {
      const newBox: BoundingBox = {
        id: Math.random().toString(36).substr(2, 9),
        classId: currentClass.id,
        x,
        y,
        w,
        h,
        isAutoLabel: false // Manually drawn
      };
      onUpdateAnnotations([...annotations, newBox]);
      setSelectedBoxId(newBox.id); // Auto-select the newly created box
    }

    setIsDrawing(false);
    setDrawStartPos(null);
    setCurrentMousePos(null);
  }, [isDrawing, drawStartPos, currentMousePos, annotations, currentClass, onUpdateAnnotations, dragStartPos, isPanning]);

  // Spacebar to toggle pan cursor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = true;
        if (activeTool !== 'PAN') document.body.style.cursor = 'grab';
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false;
        if (activeTool !== 'PAN') document.body.style.cursor = 'default';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      document.body.style.cursor = 'default';
    }
  }, [activeTool]);

  useEffect(() => {
    // Global listeners for drag/draw outside the div
    if (isDrawing || dragStartPos || isPanning) {
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
  }, [isDrawing, dragStartPos, isPanning, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-gray-950 overflow-hidden select-none"
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
      style={{ cursor: activeTool === 'PAN' || isPanning ? 'grab' : (readOnly ? 'default' : 'crosshair') }}
    >
      {/* Transform Container */}
      <div
        className="relative origin-top-left transition-transform duration-75 ease-out w-fit h-fit"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
        }}
      >
        <img
          src={imageUrl}
          alt="Work Task"
          className="max-h-[90vh] block pointer-events-none select-none shadow-2xl"
          draggable={false}
        />

        {annotations.map((box) => {
          const cls = classes.find(c => c.id === box.classId);
          const isSelected = selectedBoxId === box.id;
          const color = cls?.color || '#fff';
          const borderStyle = box.isAutoLabel ? 'dashed' : 'solid';

          return (
            <div
              key={box.id}
              data-boxid={box.id}
              className={`absolute transition-colors ${isSelected ? 'z-50' : 'z-10 hover:z-40'}`}
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`,
                boxShadow: isSelected
                  ? `0 0 0 ${2 / scale}px ${color}, 0 0 0 ${4 / scale}px white`
                  : `inset 0 0 0 ${2 / scale}px ${color}`,
                border: `${1 / scale}px ${borderStyle} ${color}`,
                backgroundColor: isSelected ? `${color}33` : `${color}0D`,
                opacity: dimBoxes && !isSelected ? 0.15 : 1,
                cursor: readOnly || activeTool === 'PAN' ? 'inherit' : (isSelected ? 'move' : 'pointer')
              }}
            >
              {/* Label Tag (Conditional) */}
              {showLabels && (
                <span
                  className={`absolute left-0 px-2 py-0.5 font-bold text-white rounded-sm shadow-sm whitespace-nowrap pointer-events-none origin-bottom-left flex items-center justify-center`}
                  style={{
                    backgroundColor: color,
                    bottom: '100%',
                    fontSize: `${12 / scale}px`,
                    lineHeight: `${14 / scale}px`,
                    padding: `${2 / scale}px ${4 / scale}px`,
                    marginBottom: `${2 / scale}px`,
                  }}
                >
                  {cls?.name} {box.isAutoLabel && '(AI)'}
                </span>
              )}

              {/* Resize Handles */}
              {isSelected && !readOnly && activeTool !== 'PAN' && (
                <>
                  <div data-handle="tl" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-nw-resize z-50 hover:bg-blue-100"
                    style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, top: `-${5 / scale}px`, left: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                  <div data-handle="tr" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-ne-resize z-50 hover:bg-blue-100"
                    style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, top: `-${5 / scale}px`, right: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                  <div data-handle="bl" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-sw-resize z-50 hover:bg-blue-100"
                    style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, bottom: `-${5 / scale}px`, left: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                  <div data-handle="br" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-se-resize z-50 hover:bg-blue-100"
                    style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, bottom: `-${5 / scale}px`, right: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                </>
              )}

              {/* Trash Button */}
              {isSelected && !readOnly && activeTool !== 'PAN' && (
                <div className="absolute -right-2 animate-in fade-in zoom-in duration-150" style={{ top: `-${35 / scale}px` }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(box.id); }}
                    className="bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg flex items-center justify-center transition-colors hover:scale-105"
                    style={{ width: `${24 / scale}px`, height: `${24 / scale}px`, padding: `${4 / scale}px` }}
                    title="Delete Annotation (F)"
                  >
                    <svg className="w-full h-full" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Drawing Box Preview */}
        {isDrawing && drawStartPos && currentMousePos && (
          <div
            className="absolute border-dashed border-white bg-white/10 z-50 pointer-events-none"
            style={{
              left: `${Math.min(drawStartPos.x, currentMousePos.x) * 100}%`,
              top: `${Math.min(drawStartPos.y, currentMousePos.y) * 100}%`,
              width: `${Math.abs(currentMousePos.x - drawStartPos.x) * 100}%`,
              height: `${Math.abs(currentMousePos.y - drawStartPos.y) * 100}%`,
              borderWidth: `${2 / scale}px`
            }}
          />
        )}
      </div>

      {/* Floating Toolbar (Tools & Zoom) */}
      <div className="absolute top-4 left-4 flex flex-col gap-2 z-50">
        <button
          onClick={() => setActiveTool(activeTool === 'PAN' ? 'SELECT' : 'PAN')}
          className={`p-2.5 rounded-lg shadow-lg border transition-all ${activeTool === 'PAN'
            ? 'bg-blue-600 text-white border-blue-500'
            : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
            }`}
          title={activeTool === 'PAN' ? "Switch to Select (V)" : "Switch to Pan (H)"}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
          </svg>
        </button>
        <button
          onClick={() => setShowLabels(!showLabels)}
          className={`p-2.5 rounded-lg shadow-lg border transition-all ${showLabels
            ? 'bg-blue-600 text-white border-blue-500'
            : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
            }`}
          title="Toggle Labels"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
        </button>
        <button
          onClick={() => setDimBoxes(!dimBoxes)}
          className={`p-2.5 rounded-lg shadow-lg border transition-all ${dimBoxes
            ? 'bg-blue-600 text-white border-blue-500'
            : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
            }`}
          title="Dim Boxes (B)"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
        </button>
        <button
          onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}
          className="p-2.5 bg-gray-800 text-gray-300 rounded-lg shadow-lg border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors"
          title="Reset View"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
        </button>
        <button
          onClick={() => setIsHelpOpen(true)}
          className="p-2.5 bg-gray-800 text-gray-300 rounded-lg shadow-lg border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors font-bold font-mono"
          title="Shortcuts & Help"
        >
          ?
        </button>
      </div>

      {/* Help Modal */}
      {isHelpOpen && (
        <div
          className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
          onClick={() => setIsHelpOpen(false)}
        >
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-800 flex justify-between items-center">
              <h3 className="font-bold text-lg text-white">Controls & Shortcuts</h3>
              <button onClick={() => setIsHelpOpen(false)} className="text-gray-500 hover:text-white">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Zoom</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">Mouse Wheel</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Pan</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">Space + Drag / Middle Click</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Pan Tool</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">Hand Icon (Top Right)</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Draw Box</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">Click + Drag</span>
                </div>
              </div>
              <div className="h-px bg-gray-800 my-2"></div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Delete Box</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">Del / Backspace / F</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Change Class</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">E (Selected Box)</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Select Class</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">1 - 9</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Toggle BBox Dimming</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">B</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Submit/Next</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">D</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Submit/Prev</span>
                  <span className="text-white font-mono bg-gray-800 px-1.5 rounded">A</span>
                </div>
              </div>
            </div>
            <div className="p-4 bg-gray-950/50 border-t border-gray-800 text-center">
              <button onClick={() => setIsHelpOpen(false)} className="text-blue-500 hover:text-blue-400 text-sm font-bold">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnnotationCanvas;