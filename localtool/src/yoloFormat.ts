/**
 * YOLO format helpers (same logic as web services/storage).
 * Kept in localtool to avoid pulling web deps; do not modify web tool.
 */
export interface BoundingBox {
  id: string;
  classId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  isAutoLabel?: boolean;
}

export function parseYoloTxt(content: string): BoundingBox[] {
  if (!content || !content.trim()) return [];
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(' ');
      if (parts.length < 5) return null;
      const classId = parseInt(parts[0], 10);
      const cx = parseFloat(parts[1]);
      const cy = parseFloat(parts[2]);
      const w = parseFloat(parts[3]);
      const h = parseFloat(parts[4]);
      const x = cx - w / 2;
      const y = cy - h / 2;
      return {
        id: Math.random().toString(36).slice(2, 11),
        classId,
        x,
        y,
        w,
        h,
        isAutoLabel: true,
      } as BoundingBox;
    })
    .filter((b): b is BoundingBox => b !== null);
}

export function generateYoloTxt(annotations: BoundingBox[]): string {
  return annotations
    .map((a) => {
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      return `${a.classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${a.w.toFixed(6)} ${a.h.toFixed(6)}`;
    })
    .join('\n');
}
