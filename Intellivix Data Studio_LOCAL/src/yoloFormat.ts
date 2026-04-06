import type { BoundingBox } from './types';

export function parseYoloTxt(content: string): BoundingBox[] {
  if (!content) return [];
  return content.split('\n')
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
        id: Math.random().toString(36).substr(2, 9),
        classId,
        x,
        y,
        w,
        h,
        isAutoLabel: true,
      } as BoundingBox;
    })
    .filter((box): box is BoundingBox => box !== null);
}

export function generateYoloTxt(annotations: BoundingBox[]): string {
  return annotations
    .map((ann) => {
      const cx = ann.x + ann.w / 2;
      const cy = ann.y + ann.h / 2;
      return `${ann.classId} ${cx.toFixed(6)} ${cy.toFixed(6)} ${ann.w.toFixed(6)} ${ann.h.toFixed(6)}`;
    })
    .join('\n');
}
