/** 顔まわりの 2D/3D 計算で使う小さな型と関数（純粋関数のみ） */

export type Point2 = { x: number; y: number };
export type Point3 = { x: number; y: number; z: number };
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * 2D アフィン変換。Canvas の setTransform(a, b, c, d, e, f) と同じ並び。
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

export function applyAffine(m: Affine, p: Point2): Point2 {
  const [a, b, c, d, e, f] = m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

export function boundingRect(points: readonly Point2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function midpoint(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
