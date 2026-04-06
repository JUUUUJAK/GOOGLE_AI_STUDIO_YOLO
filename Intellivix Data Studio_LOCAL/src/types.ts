export interface BoundingBox {
  id: string;
  classId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  isAutoLabel?: boolean;
}

export interface YoloClass {
  id: number;
  name: string;
  color: string;
}
