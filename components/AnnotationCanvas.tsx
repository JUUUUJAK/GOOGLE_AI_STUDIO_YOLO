import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { BoundingBox, YoloClass } from '../types';

interface AnnotationCanvasProps {
  imageUrl: string;
  annotations: BoundingBox[];
  currentClass: YoloClass;
  classes: YoloClass[];
  readOnly?: boolean;
  onUpdateAnnotations: (newAnnotations: BoundingBox[]) => void;
  hiddenClassIds?: number[];
  customClassColors?: Record<number, string>;
  taskId?: string;
}

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';
type ToolMode = 'SELECT' | 'PAN';

const MIN_BOX_SIZE = 0.002; // Roughly 2-4 pixels on common image sizes, allows 11x11 easily.

const Tooltip = ({ text, children, position = 'right' }: { text: string; children: React.ReactNode; position?: 'right' | 'left' }) => (
  <div className="group relative flex items-center">
    <div className={`absolute ${position === 'right' ? 'left-full ml-3' : 'right-full mr-3'} px-2.5 py-1.5 bg-gray-900/95 backdrop-blur-md border border-gray-700 text-white text-[11px] font-bold rounded-lg shadow-2xl whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 ${position === 'right' ? '-translate-x-1' : 'translate-x-1'} group-hover:translate-x-0 transition-all duration-150 z-[100] flex items-center gap-1.5`}>
      {text}
      <div className={`absolute ${position === 'right' ? 'right-full' : 'left-full'} border-[5px] border-transparent ${position === 'right' ? 'border-r-gray-700' : 'border-l-gray-700'}`}></div>
      <div className={`absolute ${position === 'right' ? 'right-full mr-[-9px]' : 'left-full ml-[-9px]'} border-[4px] border-transparent ${position === 'right' ? 'border-r-gray-900/95' : 'border-l-gray-900/95'}`}></div>
    </div>
    {children}
  </div>
);

const AnnotationCanvas: React.FC<AnnotationCanvasProps> = ({
  imageUrl,
  annotations,
  currentClass,
  classes,
  readOnly = false,
  onUpdateAnnotations,
  hiddenClassIds = [],
  customClassColors = {},
  taskId,
}) => {
  // Fix for special characters in filenames (e.g., #, [], spaces)
  // Fix for special characters in filenames (e.g., #, [], spaces)
  const displayUrl = useMemo(() => {
    let normalized = imageUrl;
    try {
      // 1. Try to decode first to prevent double encoding
      normalized = decodeURIComponent(imageUrl);
    } catch (e) {
      // Ignore error, assume raw
    }

    // 2. Normalize Windows backslashes
    normalized = normalized.replace(/\\/g, '/');

    // 3. Encode path segments
    return normalized.split('/').map(part => {
      // If the part looks like a protocol (http:), don't encode the colon
      if (part.endsWith(':')) return part;
      return encodeURIComponent(part);
    }).join('/');
  }, [imageUrl]);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Transform State
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState<{ x: number; y: number } | null>(null);

  // UI State
  const [activeTool, setActiveTool] = useState<ToolMode>('SELECT');
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showPixelSizes, setShowPixelSizes] = useState(false);
  const [dimBoxes, setDimBoxes] = useState(false);
  const [imageNaturalSize, setImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
  }, [imageUrl]);

  // Style Customization State
  const [boxThickness, setBoxThickness] = useState(2);
  const [showCrosshair, setShowCrosshair] = useState(false);
  const [crosshairThickness, setCrosshairThickness] = useState(1);
  const [fillOpacity, setFillOpacity] = useState(20); // 0-100 percentage
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{ x: number; y: number } | null>(null);
  const [isModActive, setIsModActive] = useState(false);
  const [interactionMode, setInteractionMode] = useState<'FAST' | 'CLASSIC'>('FAST');
  const [isDeleteAllConfirmOpen, setIsDeleteAllConfirmOpen] = useState(false);

  // Track key states for temporary modes
  const isSpacePressedRef = useRef(false);
  const isModActiveRef = useRef(false);

  // Drawing State
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStartPos, setDrawStartPos] = useState<{ x: number; y: number } | null>(null);
  const [currentMousePos, setCurrentMousePos] = useState<{ x: number; y: number } | null>(null);

  // Selection, Moving & Resizing State
  // Selection, Moving & Resizing State
  const [selectedBoxIds, setSelectedBoxIds] = useState<string[]>([]);
  const [dragStartPos, setDragStartPos] = useState<{ x: number; y: number } | null>(null);
  const [draggingBoxesSnapshot, setDraggingBoxesSnapshot] = useState<BoundingBox[]>([]);
  const [resizingHandle, setResizingHandle] = useState<ResizeHandle | null>(null);

  // Interaction State (Local)
  const [localAnnotations, setLocalAnnotations] = useState<BoundingBox[]>(annotations);
  const [recentlyPastedBoxIds, setRecentlyPastedBoxIds] = useState<string[]>([]);
  const [hoveredBoxId, setHoveredBoxId] = useState<string | null>(null);

  // Undo/Redo & Clipboard
  const [undoStack, setUndoStack] = useState<BoundingBox[][]>([]);
  const clipboardRef = useRef<BoundingBox[]>([]);

  const saveHistory = useCallback(() => {
    setUndoStack(prev => [...prev, localAnnotations]);
  }, [localAnnotations]);
  const handleDelete = useCallback((ids: string[]) => {
    if (readOnly || ids.length === 0) return;
    saveHistory(); // Save before delete
    const updated = localAnnotations.filter(a => !ids.includes(a.id));
    setLocalAnnotations(updated);
    onUpdateAnnotations(updated);
    setSelectedBoxIds(prev => prev.filter(id => !ids.includes(id)));
  }, [localAnnotations, onUpdateAnnotations, readOnly, saveHistory]);

  const handleDeleteAll = useCallback(() => {
    if (readOnly || localAnnotations.length === 0) return;
    saveHistory();
    setLocalAnnotations([]);
    onUpdateAnnotations([]);
    setSelectedBoxIds([]);
    setIsDeleteAllConfirmOpen(false);
  }, [localAnnotations, onUpdateAnnotations, readOnly, saveHistory]);

  // Sync prop changes into local state (e.g. when changing tasks or undoing)
  useEffect(() => {
    if (!isDrawing && !dragStartPos && !isPanning) {
      setLocalAnnotations(annotations);
    }
  }, [annotations, isDrawing, dragStartPos, isPanning]);

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
              setLocalAnnotations(lastState);
              onUpdateAnnotations(lastState);
            }
            return newStack;
          });
          return;
        }

        // Copy: Ctrl + C or Shift + Ctrl + C (for multi-selection as per user doc)
        if (key === 'c' && selectedBoxIds.length > 0) {
          e.preventDefault();
          const boxes = localAnnotations.filter(b => selectedBoxIds.includes(b.id));
          if (boxes.length > 0) clipboardRef.current = boxes;
          return;
        }

        // Paste: Ctrl + V
        if (key === 'v') {
          e.preventDefault();
          if (clipboardRef.current.length > 0) {
            saveHistory(); // Save before paste
            const newBoxes = clipboardRef.current.map(box => ({
              ...box,
              id: Math.random().toString(36).substr(2, 9),
              x: box.x,
              y: box.y,
              isAutoLabel: false
            }));
            const updated = [...localAnnotations, ...newBoxes];
            setLocalAnnotations(updated);
            onUpdateAnnotations(updated);
            setSelectedBoxIds(newBoxes.map(b => b.id));

            // Visual Flash Feedback
            const newIds = newBoxes.map(b => b.id);
            setRecentlyPastedBoxIds(newIds);
            setTimeout(() => {
              setRecentlyPastedBoxIds(prev => prev.filter(id => !newIds.includes(id)));
            }, 800);
          }
          return;
        }
      }

      // Delete shortcuts
      if (e.key === 'Delete' || e.key === 'Backspace' || key === 'r') {
        if (selectedBoxIds.length > 0) {
          e.preventDefault();
          handleDelete(selectedBoxIds);
        } else if (hoveredBoxId) {
          e.preventDefault();
          handleDelete([hoveredBoxId]);
          setHoveredBoxId(null);
        }
      }

      // Change Class of selected box or hovered box: 'e'
      if ((selectedBoxIds.length > 0 || hoveredBoxId) && key === 'e') {
        e.preventDefault();
        saveHistory(); // Save before modify
        const targetIds = selectedBoxIds.length > 0 ? selectedBoxIds : [hoveredBoxId!];
        const updated = localAnnotations.map(box =>
          targetIds.includes(box.id) ? { ...box, classId: currentClass.id, isAutoLabel: false } : box
        );
        setLocalAnnotations(updated);
        onUpdateAnnotations(updated);
      }

      if (e.key === 'Escape') {
        if (isHelpOpen) {
          setIsHelpOpen(false);
          return;
        }
        setSelectedBoxIds([]);
        setIsDrawing(false);
        setDrawStartPos(null);
        setDragStartPos(null);
        setDraggingBoxesSnapshot([]);
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
  }, [selectedBoxIds, hoveredBoxId, handleDelete, readOnly, currentClass, localAnnotations, onUpdateAnnotations, isHelpOpen, saveHistory]);

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
    if (!imgRef.current) return { x: 0, y: 0 };

    // Get Mouse relative to the Image itself
    // getBoundingClientRect() on a transformed element gives the actual screen coordinates and size
    const rect = imgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Clamp
    return {
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1)
    };
  };

  // Helper: Get contrast text color (Black or White)
  const getContrastColor = (hexColor: string) => {
    // Basic hex to rgb conversion
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 128 ? 'black' : 'white';
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only allow left click (0) and middle click (1) for interactions
    // Right click (2) is reserved for delete/context menu handled via onContextMenu
    if (e.button === 2) return;

    const target = e.target as HTMLElement;
    const isBoxClick = !!target.dataset.boxid || !!target.dataset.handle;
    const isModifying = isModActiveRef.current || (interactionMode === 'CLASSIC' && isBoxClick);

    // 1. Pan Checks (Middle Click, Spacebar, or Explicit Pan Tool)
    // Shift shortcut is now only for empty space to avoid multi-selection conflict
    const isExplicitPan = activeTool === 'PAN' || e.button === 1 || (e.button === 0 && isSpacePressedRef.current);
    const isShiftPanShortcut = e.button === 0 && e.shiftKey && !isBoxClick;

    if (isExplicitPan || isShiftPanShortcut) {
      setIsPanning(true);
      setLastPanPos({ x: e.clientX, y: e.clientY });
      e.preventDefault();
      return;
    }

    if (readOnly) return;

    // 2. Modification Logic (ONLY if 'N' is held)
    if (isModifying) {
      // Check Resize Handle Click
      if (target.dataset.handle) {
        const handle = target.dataset.handle as ResizeHandle;
        const boxId = target.dataset.boxid;
        if (boxId) {
          if (!selectedBoxIds.includes(boxId)) {
            setSelectedBoxIds([boxId]);
          }
          const box = localAnnotations.find(b => b.id === boxId);
          if (box) {
            setResizingHandle(handle);
            setDragStartPos(getNormalizedPos(e));
            setDraggingBoxesSnapshot([box]);
          }
          return;
        }
      }

      // Check Box Click (Select / Move)
      // Use elementsFromPoint to handle overlapping boxes (Cycle Selection)
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const boxElements = elements.filter(el => (el as HTMLElement).dataset?.boxid);

      if (boxElements.length > 0) {
        // Find all box IDs under the cursor
        const boxIds = boxElements.map(el => (el as HTMLElement).dataset.boxid as string);

        // Determine next box to select
        let nextBoxId = boxIds[0];
        if (selectedBoxIds.length === 1 && boxIds.includes(selectedBoxIds[0])) {
          const currentIndex = boxIds.indexOf(selectedBoxIds[0]);
          nextBoxId = boxIds[(currentIndex + 1) % boxIds.length];
        }

        if (e.shiftKey) {
          // Toggle selection
          setSelectedBoxIds(prev =>
            prev.includes(nextBoxId) ? prev.filter(id => id !== nextBoxId) : [...prev, nextBoxId]
          );
        } else {
          if (!selectedBoxIds.includes(nextBoxId)) {
            setSelectedBoxIds([nextBoxId]);
          }
        }

        // Determine which boxes to drag
        const finalSelectionIds = e.shiftKey
          ? (selectedBoxIds.includes(nextBoxId) ? selectedBoxIds : [...selectedBoxIds, nextBoxId])
          : (selectedBoxIds.includes(nextBoxId) ? selectedBoxIds : [nextBoxId]);

        const boxesToDrag = localAnnotations.filter(b => finalSelectionIds.includes(b.id));

        if (boxesToDrag.length > 0) {
          saveHistory(); // Save before drag/resize
          const pos = getNormalizedPos(e);
          setDragStartPos(pos);
          setDraggingBoxesSnapshot(boxesToDrag);
        }
        return; // Stop drawing logic
      }
    }

    // 3. Default: Click Empty Space or Over Box (if N not pressed) -> Start Drawing
    saveHistory(); // Save before drawing new box
    if (!e.shiftKey) setSelectedBoxIds([]);
    setDragStartPos(null);
    setDraggingBoxesSnapshot([]);
    setResizingHandle(null);

    const pos = getNormalizedPos(e);
    setDrawStartPos(pos);
    setCurrentMousePos(pos);
    setIsDrawing(true);
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    // Always update mouse position for crosshair
    const pos = getNormalizedPos(e);
    setMouseCanvasPos(pos);

    // Panning
    if (isPanning && lastPanPos) {
      const dx = e.clientX - lastPanPos.x;
      const dy = e.clientY - lastPanPos.y;
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      setLastPanPos({ x: e.clientX, y: e.clientY });
      return;
    }

    // 1. Resizing (Only supported for single box)
    if (resizingHandle && draggingBoxesSnapshot.length === 1 && dragStartPos && !readOnly) {
      const dx = pos.x - dragStartPos.x;
      const dy = pos.y - dragStartPos.y;

      const snapshot = draggingBoxesSnapshot[0];
      let { x, y, w, h } = snapshot;

      // Apply delta based on handle
      if (resizingHandle === 'br') {
        w = Math.max(MIN_BOX_SIZE, w + dx);
        h = Math.max(MIN_BOX_SIZE, h + dy);
      } else if (resizingHandle === 'bl') {
        const maxDX = w - MIN_BOX_SIZE;
        const actualDX = Math.min(maxDX, dx);
        x = x + actualDX;
        w = w - actualDX;
        h = Math.max(MIN_BOX_SIZE, h + dy);
      } else if (resizingHandle === 'tr') {
        const maxDY = h - MIN_BOX_SIZE;
        const actualDY = Math.min(maxDY, dy);
        y = y + actualDY;
        h = h - actualDY;
        w = Math.max(MIN_BOX_SIZE, w + dx);
      } else if (resizingHandle === 'tl') {
        const maxDX = w - MIN_BOX_SIZE;
        const actualDX = Math.min(maxDX, dx);
        const maxDY = h - MIN_BOX_SIZE;
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

      setLocalAnnotations(prev => prev.map(a =>
        a.id === snapshot.id
          ? { ...a, x, y, w, h, isAutoLabel: false } // Mark as modified
          : a
      ));
      return;
    }

    // 2. Moving selection (Single or Multiple)
    if (dragStartPos && draggingBoxesSnapshot.length > 0 && !resizingHandle && !readOnly) {
      const dx = pos.x - dragStartPos.x;
      const dy = pos.y - dragStartPos.y;

      const draggingIds = draggingBoxesSnapshot.map(b => b.id);

      setLocalAnnotations(prev => prev.map(a => {
        if (draggingIds.includes(a.id)) {
          const snapshot = draggingBoxesSnapshot.find(b => b.id === a.id)!;
          let newX = snapshot.x + dx;
          let newY = snapshot.y + dy;

          // Clamp to image bounds
          newX = Math.max(0, Math.min(newX, 1 - snapshot.w));
          newY = Math.max(0, Math.min(newY, 1 - snapshot.h));
          return { ...a, x: newX, y: newY, isAutoLabel: false };
        }
        return a;
      }));
      return;
    }

    // 3. Drawing a new box
    if (isDrawing) {
      setCurrentMousePos(pos);
    }
  }, [isDrawing, dragStartPos, draggingBoxesSnapshot, resizingHandle, readOnly, isPanning, lastPanPos, scale, pan]);

  const handleMouseUp = useCallback(() => {
    // Finish Panning
    if (isPanning) {
      setIsPanning(false);
      setLastPanPos(null);
      return;
    }

    // Finish Resizing or Moving
    if (dragStartPos) {
      onUpdateAnnotations(localAnnotations);
      setDragStartPos(null);
      setDraggingBoxesSnapshot([]);
      setResizingHandle(null);
      return;
    }

    // Finish Drawing
    if (!isDrawing || !drawStartPos || !currentMousePos) {
      if (isDrawing) {
        setIsDrawing(false);
        setDrawStartPos(null);
        setCurrentMousePos(null);
      }
      return;
    }

    // Calculate box dimensions
    const x = Math.min(drawStartPos.x, currentMousePos.x);
    const y = Math.min(drawStartPos.y, currentMousePos.y);
    const w = Math.abs(currentMousePos.x - drawStartPos.x);
    const h = Math.abs(currentMousePos.y - drawStartPos.y);

    // Minimum size threshold
    if (w > MIN_BOX_SIZE && h > MIN_BOX_SIZE) {
      const newBox: BoundingBox = {
        id: Math.random().toString(36).substr(2, 9),
        classId: currentClass.id,
        x,
        y,
        w,
        h,
        isAutoLabel: false // Manually drawn
      };
      const updated = [...localAnnotations, newBox];
      setLocalAnnotations(updated);
      onUpdateAnnotations(updated); // Commit to storage
      setSelectedBoxIds([newBox.id]); // Auto-select the newly created box
    }

    setIsDrawing(false);
    setDrawStartPos(null);
    setCurrentMousePos(null);
  }, [isDrawing, drawStartPos, currentMousePos, currentClass, onUpdateAnnotations, dragStartPos, isPanning, localAnnotations]);

  // Spacebar to toggle pan cursor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = true;
        if (activeTool !== 'PAN') document.body.style.cursor = 'grab';
      }
      if (e.key.toLowerCase() === 'f') {
        isModActiveRef.current = true;
        setIsModActive(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressedRef.current = false;
        if (activeTool !== 'PAN') document.body.style.cursor = 'default';
      }
      if (e.key.toLowerCase() === 'f') {
        isModActiveRef.current = false;
        setIsModActive(false);
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
    <>
      {/* Flash Animation Style */}
      <style>{`
        @keyframes box-flash {
          0% { filter: brightness(1); box-shadow: 0 0 0 0px rgba(255,255,255,0); }
          50% { filter: brightness(2); box-shadow: 0 0 20px 10px rgba(255,255,255,0.9); z-index: 100 !important; }
          100% { filter: brightness(1); box-shadow: 0 0 0 0px rgba(255,255,255,0); }
        }
        .animate-paste-flash {
          animation: box-flash 0.8s ease-out;
        }
      `}</style>

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
          className="relative origin-top-left w-fit h-fit"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: (isPanning || dragStartPos || isDrawing) ? 'none' : 'transform 0.075s ease-out'
          }}
        >
          {/* Loading State - Removed per user request */}

          {hasError && (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-gray-900/90 backdrop-blur-md">
              <svg className="w-16 h-16 text-red-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <p className="text-red-400 font-bold text-lg mb-2">Failed to load image</p>
              <button
                onClick={() => {
                  setHasError(false);
                  setIsLoading(true);
                  // Force retry by appending random param
                  const separator = displayUrl.includes('?') ? '&' : '?';
                  const retryUrl = `${displayUrl}${separator}retry=${Date.now()}`;
                  if (imgRef.current) imgRef.current.src = retryUrl;
                }}
                className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold transition-colors shadow-lg"
              >
                Retry
              </button>
            </div>
          )}

          <img
            ref={imgRef}
            src={displayUrl}
            alt="Work Task"
            className="max-h-[90vh] block pointer-events-none select-none shadow-2xl"
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setImageNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
              setIsLoading(false);
              setHasError(false);
            }}
            onError={() => {
              // Only error if even the fallback fails
              setIsLoading(false);
              setHasError(true);
            }}
          />

          {localAnnotations.map((box) => {
            // Visibility Check
            if (hiddenClassIds.includes(box.classId)) return null;

            const cls = classes.find(c => c.id === box.classId);
            const isSelected = selectedBoxIds.includes(box.id);
            const isRecentlyPasted = recentlyPastedBoxIds.includes(box.id);

            // Color Logic: Custom > Default > Fallback
            const color = customClassColors[box.classId] || cls?.color || '#fff';
            const borderStyle = box.isAutoLabel ? 'dashed' : 'solid';

            // Convert hex to rgba for fill
            const hex = color.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            const fillColor = `rgba(${r}, ${g}, ${b}, ${isSelected ? (fillOpacity / 100) + 0.15 : (fillOpacity / 100)})`;

            return (
              <div
                key={box.id}
                onMouseEnter={() => setHoveredBoxId(box.id)}
                onMouseLeave={() => setHoveredBoxId(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDelete([box.id]);
                }}
                data-boxid={box.id}
                className={`absolute ${isSelected ? 'z-50' : 'z-10 hover:z-40'} ${isRecentlyPasted ? 'animate-paste-flash' : ''}`}
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  boxShadow: isSelected
                    ? `0 0 0 ${(boxThickness) / scale}px ${color}, 0 0 0 ${(boxThickness + 2) / scale}px white`
                    : `inset 0 0 0 ${(boxThickness) / scale}px ${color}`,
                  border: `${(boxThickness / 2) / scale}px ${borderStyle} ${color}`,
                  backgroundColor: fillColor,
                  opacity: dimBoxes && !isSelected ? 0.15 : 1,
                  pointerEvents: 'auto', // Enabled for interior interaction
                  cursor: (isModActive || interactionMode === 'CLASSIC') ? 'move' : (activeTool === 'SELECT' ? 'crosshair' : 'inherit')
                }}
              >
                {/* Hit Areas (Borders only) */}
                {!isPanning && !isDrawing && (
                  <>
                    {/* Top Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute left-0 right-0"
                      style={{ height: `${8 / scale}px`, top: `-${4 / scale}px`, cursor: (isModActive || interactionMode === 'CLASSIC') ? 'move' : 'inherit', pointerEvents: (isModActive || interactionMode === 'CLASSIC') ? 'auto' : 'none' }}
                    />
                    {/* Bottom Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute left-0 right-0"
                      style={{ height: `${8 / scale}px`, bottom: `-${4 / scale}px`, cursor: (isModActive || interactionMode === 'CLASSIC') ? 'move' : 'inherit', pointerEvents: (isModActive || interactionMode === 'CLASSIC') ? 'auto' : 'none' }}
                    />
                    {/* Left Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute top-0 bottom-0"
                      style={{ width: `${8 / scale}px`, left: `-${4 / scale}px`, cursor: (isModActive || interactionMode === 'CLASSIC') ? 'move' : 'inherit', pointerEvents: (isModActive || interactionMode === 'CLASSIC') ? 'auto' : 'none' }}
                    />
                    {/* Right Edge */}
                    <div
                      data-boxid={box.id}
                      className="absolute top-0 bottom-0"
                      style={{ width: `${8 / scale}px`, right: `-${4 / scale}px`, cursor: (isModActive || interactionMode === 'CLASSIC') ? 'move' : 'inherit', pointerEvents: (isModActive || interactionMode === 'CLASSIC') ? 'auto' : 'none' }}
                    />
                  </>
                )}
                {/* Label Tag (Conditional) */}
                {showLabels && (
                  <span
                    className={`absolute left-0 px-2 py-0.5 font-bold rounded-sm shadow-sm whitespace-nowrap pointer-events-none origin-bottom-left flex items-center justify-center gap-1.5`}
                    style={{
                      backgroundColor: color,
                      color: getContrastColor(color),
                      bottom: '100%',
                      fontSize: `${12 / scale}px`,
                      lineHeight: `${14 / scale}px`,
                      padding: `${2 / scale}px ${4 / scale}px`,
                      marginBottom: `${2 / scale}px`,
                    }}
                  >
                    <span>{cls?.name}</span>
                    {box.isAutoLabel && <span>(AI)</span>}
                    {showPixelSizes && imageNaturalSize && (
                      <span
                        className="font-mono text-[0.9em] pl-1.5 ml-0.5"
                        style={{
                          borderLeft: `1px solid ${getContrastColor(color) === 'white' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'}`,
                          opacity: 0.9
                        }}
                      >
                        {Math.round(box.w * imageNaturalSize.width)}x{Math.round(box.h * imageNaturalSize.height)}
                      </span>
                    )}
                  </span>
                )}

                {/* Resize Handles (Only for single selection and only in mod mode/classic mode) */}
                {isSelected && selectedBoxIds.length === 1 && !readOnly && activeTool !== 'PAN' && (isModActive || interactionMode === 'CLASSIC') && (
                  <div style={{ pointerEvents: 'auto' }}>
                    <div data-handle="tl" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-nw-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, top: `-${5 / scale}px`, left: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                    <div data-handle="tr" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-ne-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, top: `-${5 / scale}px`, right: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                    <div data-handle="bl" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-sw-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, bottom: `-${5 / scale}px`, left: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                    <div data-handle="br" data-boxid={box.id} className="absolute bg-white border border-gray-500 rounded-full cursor-se-resize z-50 hover:bg-blue-100"
                      style={{ width: `${10 / scale}px`, height: `${10 / scale}px`, bottom: `-${5 / scale}px`, right: `-${5 / scale}px`, borderWidth: `${1 / scale}px` }} />
                  </div>
                )}

                {/* Trash Button (Only for single selection to avoid clutter) */}
                {isSelected && selectedBoxIds.length === 1 && !readOnly && activeTool !== 'PAN' && (
                  <div className="absolute -right-2 animate-in fade-in zoom-in duration-150" style={{ top: `-${35 / scale}px`, pointerEvents: 'auto' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete([box.id]); }}
                      className="bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg flex items-center justify-center transition-colors hover:scale-105"
                      style={{ width: `${24 / scale}px`, height: `${24 / scale}px`, padding: `${4 / scale}px` }}
                      title="Delete Annotation (Right Click)"
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
              className={`absolute border-dashed border-white bg-white/10 z-[60] pointer-events-none ${true ? 'animate-pulse' : ''}`}
              style={{
                left: `${Math.min(drawStartPos.x, currentMousePos.x) * 100}%`,
                top: `${Math.min(drawStartPos.y, currentMousePos.y) * 100}%`,
                width: `${Math.abs(currentMousePos.x - drawStartPos.x) * 100}%`,
                height: `${Math.abs(currentMousePos.y - drawStartPos.y) * 100}%`,
                borderWidth: `${2 / scale}px`
              }}
            />
          )}

          {/* Crosshair Overlay (Inside Transform Container for pixel alignment) */}
          {showCrosshair && mouseCanvasPos && (
            <div className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
              <div
                className="absolute bg-white/50"
                style={{
                  left: 0,
                  right: 0,
                  top: `${mouseCanvasPos.y * 100}%`,
                  height: `${crosshairThickness / scale}px`,
                  transform: `translateY(-50%)`
                }}
              />
              <div
                className="absolute bg-white/50"
                style={{
                  top: 0,
                  bottom: 0,
                  left: `${mouseCanvasPos.x * 100}%`,
                  width: `${crosshairThickness / scale}px`,
                  transform: `translateX(-50%)`
                }}
              />
            </div>
          )}
        </div>



        {/* Floating Toolbar (Tools & Zoom) */}
        <div className="absolute top-4 left-4 flex flex-col gap-2 z-50">
          <Tooltip text={activeTool === 'PAN' ? "이미지 조절 (V)" : "박스 생성 (V)"}>
            <button
              onClick={() => setActiveTool(activeTool === 'PAN' ? 'SELECT' : 'PAN')}
              className={`p-2.5 rounded-lg shadow-lg border transition-all ${activeTool === 'PAN'
                ? 'bg-blue-600 text-white border-blue-500'
                : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip text="레이블 표시 켜기/끄기">
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`p-2.5 rounded-lg shadow-lg border transition-all ${showLabels
                ? 'bg-blue-600 text-white border-blue-500'
                : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="객체 크기(px) 표시 켜기/끄기">
            <button
              onClick={() => setShowPixelSizes(!showPixelSizes)}
              className={`p-2.5 rounded-lg shadow-lg border transition-all ${showPixelSizes
                ? 'bg-blue-600 text-white border-blue-500'
                : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18a2 2 0 012 2v8a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6v4M10 6v3M14 6v4M18 6v3" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="박스 표시 켜기/끄기 (B)">
            <button
              onClick={() => setDimBoxes(!dimBoxes)}
              className={`p-2.5 rounded-lg shadow-lg border transition-all ${dimBoxes
                ? 'bg-blue-600 text-white border-blue-500'
                : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="이미지 크기 재조정">
            <button
              onClick={() => { setScale(1); setPan({ x: 0, y: 0 }); }}
              className="p-2.5 bg-gray-800 text-gray-300 rounded-lg shadow-lg border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="캔버스 설정">
            <button
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className={`p-2.5 rounded-lg shadow-lg border transition-all ${isSettingsOpen
                ? 'bg-blue-600 text-white border-blue-500'
                : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700 hover:text-white'
                }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="모든 박스 삭제">
            <button
              onClick={() => setIsDeleteAllConfirmOpen(true)}
              className="p-2.5 bg-gray-800 text-red-400 rounded-lg shadow-lg border border-gray-700 hover:bg-red-900/40 hover:text-red-300 hover:border-red-900/50 transition-all"
              disabled={localAnnotations.length === 0}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </Tooltip>

          <Tooltip text="단축키 & 안내">
            <button
              onClick={() => setIsHelpOpen(true)}
              className="p-2.5 bg-gray-800 text-gray-300 rounded-lg shadow-lg border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors font-bold font-mono"
            >
              ?
            </button>
          </Tooltip>
        </div>

        {/* Settings Overlay */}
        {isSettingsOpen && (
          <div className="absolute bottom-16 right-4 w-72 bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-xl shadow-2xl p-4 z-50 animate-in slide-in-from-bottom-2 duration-200">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-white font-bold flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                캔버스 시각 설정
              </h3>
              <button onClick={() => setIsSettingsOpen(false)} className="text-gray-500 hover:text-white transition-colors">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l18 18" /></svg>
              </button>
            </div>
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">박스 선 굵기</label>
                  <span className="text-blue-400 font-mono text-xs px-1.5 py-0.5 bg-blue-400/10 rounded">{boxThickness}px</span>
                </div>
                <input type="range" min="1" max="10" value={boxThickness} onChange={(e) => setBoxThickness(parseInt(e.target.value))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
              </div>
              <div className="h-px bg-gray-800" />
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">마우스 십자선</label>
                  <button onClick={() => setShowCrosshair(!showCrosshair)} className={`w-11 h-6 rounded-full transition-all relative ${showCrosshair ? 'bg-blue-600 shadow-[0_0_10px_rgba(37,99,235,0.4)]' : 'bg-gray-700'}`}><div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${showCrosshair ? 'left-6' : 'left-1'}`} /></button>
                </div>
                {showCrosshair && (
                  <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="flex justify-between items-center"><label className="text-gray-400 text-[10px] uppercase tracking-wider font-bold">십자선 굵기</label><span className="text-blue-400 font-mono text-xs px-1.5 py-0.5 bg-blue-400/10 rounded">{crosshairThickness}px</span></div>
                    <input type="range" min="1" max="5" value={crosshairThickness} onChange={(e) => setCrosshairThickness(parseInt(e.target.value))} className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                  </div>
                )}
              </div>
              <div className="h-px bg-gray-800" />
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold">박스 투명도 (Fill)</label>
                  <span className="text-blue-400 font-mono text-xs px-1.5 py-0.5 bg-blue-400/10 rounded">{fillOpacity}%</span>
                </div>
                <input type="range" min="0" max="80" value={fillOpacity} onChange={(e) => setFillOpacity(parseInt(e.target.value))} className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
              </div>
              <div className="h-px bg-gray-800" />
              <div className="space-y-3">
                <label className="text-gray-300 text-xs uppercase tracking-wider font-semibold block mb-2">작업 조작 방식</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setInteractionMode('FAST')}
                    className={`px-3 py-2 rounded-lg text-xs font-bold border transition-all ${interactionMode === 'FAST' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750'}`}
                  >
                    패스트 드로우
                  </button>
                  <button
                    onClick={() => setInteractionMode('CLASSIC')}
                    className={`px-3 py-2 rounded-lg text-xs font-bold border transition-all ${interactionMode === 'CLASSIC' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750'}`}
                  >
                    클래식
                  </button>
                </div>
                <p className="text-[10px] text-gray-500 mt-1 leading-relaxed">
                  {interactionMode === 'FAST'
                    ? '* 그리기가 기본이며 F키를 눌러 수정합니다.'
                    : '* 박스를 바로 클릭해서 이동/수정이 가능합니다.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Help Modal */}
        {isHelpOpen && (
          <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={() => setIsHelpOpen(false)}>
            <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl max-w-md w-full overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="p-5 border-b border-gray-800 flex justify-between items-center">
                <h3 className="font-bold text-lg text-white">단축키 안내</h3>
                <button onClick={() => setIsHelpOpen(false)} className="text-gray-500 hover:text-white"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
              <div className="p-5 space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-gray-400">확대</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">마우스 휠</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">이미지 이동</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">스페이스바 or 마우스 가운데 버튼 + 드래그</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">이미지 이동 토글</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">V or 손 아이콘(왼쪽 상단)</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">박스 생성</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">클릭 + 드래그</span></div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">박스 선택/이동/크기조절</span>
                    <div className="text-right">
                      <div className="text-white font-mono bg-blue-900/40 text-blue-300 px-1.5 rounded border border-blue-800/50 inline-block mb-1">F 키 (패스트 모드)</div>
                      <div className="text-gray-500 text-[10px] italic">클래식 모드에서는 바로 클릭/호버 가능</div>
                    </div>
                  </div>
                </div>
                <div className="h-px bg-gray-800 my-2"></div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-gray-400">박스 삭제 (우클릭 / R키 시 바로 삭제)</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">Del / Bksp / R / Right Click</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">클래스 변경</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">E (선택된 클래스로 변경)</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">클래스 선택</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">1 - 9</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">박스 표시 켜기/끄기</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">B</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">제출&다음 이미지</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">D</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">제출& 이전 이미지</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">A</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">되돌리기</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">Ctrl+Z</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-400">다중 선택 Box 복사/붙여넣기</span><span className="text-white font-mono bg-gray-800 px-1.5 rounded">Shift + Ctrl+C / Ctrl+V</span></div>
                </div>
              </div>
            </div>
          </div>
        )}
        {/* Delete All Confirmation Modal */}
        {isDeleteAllConfirmOpen && (
          <div className="absolute inset-0 z-[100] bg-black/70 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in zoom-in-95 duration-200" onClick={() => setIsDeleteAllConfirmOpen(false)}>
            <div className="bg-gray-900 border border-red-900/30 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="p-6 text-center">
                <div className="w-16 h-16 bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-900/30">
                  <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </div>
                <h3 className="text-xl font-bold text-white mb-2">모든 박스 삭제</h3>
                <p className="text-gray-400 text-sm leading-relaxed mb-6">
                  현재 이미지에 있는 모든 어노테이션 박스를 삭제하시겠습니까?<br />
                  <span className="text-red-400 font-medium">이 작업은 Ctrl+Z로 되돌릴 수 있습니다.</span>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setIsDeleteAllConfirmOpen(false)}
                    className="py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-colors border border-gray-700"
                  >
                    취소
                  </button>
                  <button
                    onClick={handleDeleteAll}
                    className="py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl shadow-lg shadow-red-900/20 transition-all active:scale-95"
                  >
                    모두 삭제
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div >
    </>
  );
};

export default AnnotationCanvas;