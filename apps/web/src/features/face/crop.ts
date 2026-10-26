import type { FaceConfig } from "./config";
import { type Affine, type Point2, type Point3, type Rect, RAD2DEG, applyAffine, boundingRect, midpoint } from "./geometry";

/**
 * MediaPipe Face Mesh の目尻・目頭のインデックス。
 * 写真の左側に写る目（本人の右目）と右側に写る目（本人の左目）。
 */
export const EYE_CORNERS = {
  imageLeft: [33, 133],
  imageRight: [362, 263],
} as const;

export type CropConfig = FaceConfig["crop"];

export type CropResult = {
  /** 目の傾き（度）。写真の右側の目が下にあると正 */
  rollDeg: number;
  /** 元画像のピクセル座標 → 切り出し画像のピクセル座標 */
  transform: Affine;
  outputSize: number;
  /** 傾きを補正した状態での顔ランドマークの枠（元画像のピクセル単位） */
  uprightFaceRect: Rect;
  /** 切り出し画像の中でのランドマーク（ピクセル。z も同じ倍率） */
  landmarks: Point3[];
  /** 切り出し画像の中での顔の枠（ピクセル） */
  faceRect: Rect;
  /** 切り出し範囲のうち、元画像の外にはみ出した割合（0〜1） */
  outsideRatio: number;
};

/** MediaPipe の正規化座標（0〜1。z は幅基準）を元画像のピクセルに直す */
export function toPixelLandmarks(normalized: readonly Point3[], width: number, height: number): Point3[] {
  return normalized.map((p) => ({ x: p.x * width, y: p.y * height, z: p.z * width }));
}

function landmarkAt(points: readonly Point2[], index: number): Point2 {
  const p = points[index];
  if (!p) throw new Error(`ランドマーク ${index} がありません（${points.length} 点）`);
  return p;
}

/** 両目の中心（目頭と目尻の中点）を返す */
export function eyeCenters(points: readonly Point2[]): { imageLeft: Point2; imageRight: Point2 } {
  const [l0, l1] = EYE_CORNERS.imageLeft;
  const [r0, r1] = EYE_CORNERS.imageRight;
  return {
    imageLeft: midpoint(landmarkAt(points, l0), landmarkAt(points, l1)),
    imageRight: midpoint(landmarkAt(points, r0), landmarkAt(points, r1)),
  };
}

/** アフィン変換の逆変換 */
export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error("逆変換できない行列です");
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

/**
 * 切り出し範囲のうち元画像の外にはみ出す割合を、出力画像を格子状にサンプリングして求める。
 * 出力が正方形でないときは outputSize を幅、outputHeight を高さとして渡す。
 */
export function outsideRatio(
  transform: Affine,
  outputSize: number,
  imageWidth: number,
  imageHeight: number,
  grid = 64,
  outputHeight = outputSize,
): number {
  const inv = invertAffine(transform);
  const stepX = outputSize / grid;
  const stepY = outputHeight / grid;
  let outside = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const s = applyAffine(inv, { x: (gx + 0.5) * stepX, y: (gy + 0.5) * stepY });
      if (s.x < 0 || s.y < 0 || s.x >= imageWidth || s.y >= imageHeight) outside++;
    }
  }
  return outside / (grid * grid);
}

/**
 * 両目を水平にし、顔が中央に来るように正方形に切り出すための変換を求める。
 * @param landmarksPx 元画像のピクセル座標のランドマーク（478 点）
 */
export function computeCrop(
  landmarksPx: readonly Point3[],
  imageWidth: number,
  imageHeight: number,
  config: CropConfig,
): CropResult {
  const { imageLeft, imageRight } = eyeCenters(landmarksPx);
  const theta = Math.atan2(imageRight.y - imageLeft.y, imageRight.x - imageLeft.x);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const pivot = midpoint(imageLeft, imageRight);

  // -theta 回転して目を水平にする（pivot 中心）
  const rotate = (p: Point2): Point2 => {
    const dx = p.x - pivot.x;
    const dy = p.y - pivot.y;
    return { x: pivot.x + cos * dx + sin * dy, y: pivot.y - sin * dx + cos * dy };
  };
  const upright = landmarksPx.map(rotate);
  const uprightFaceRect = boundingRect(upright);

  const side = Math.max(uprightFaceRect.width, uprightFaceRect.height) * config.scale;
  if (!(side > 0)) throw new Error("顔の大きさを求められません");
  const center = {
    x: uprightFaceRect.x + uprightFaceRect.width / 2,
    y: uprightFaceRect.y + uprightFaceRect.height / 2 + config.centerOffsetY * uprightFaceRect.height,
  };
  const k = config.outputSize / side;
  const half = config.outputSize / 2;

  // out = k * (rotate(p) - center) + half
  //     = k * R p + k * (pivot - R pivot - center) + half
  const rPivot = { x: cos * pivot.x + sin * pivot.y, y: -sin * pivot.x + cos * pivot.y };
  const transform: Affine = [
    k * cos,
    -k * sin,
    k * sin,
    k * cos,
    k * (pivot.x - rPivot.x - center.x) + half,
    k * (pivot.y - rPivot.y - center.y) + half,
  ];

  const landmarks = landmarksPx.map((p) => {
    const q = applyAffine(transform, p);
    return { x: q.x, y: q.y, z: p.z * k };
  });

  return {
    rollDeg: theta * RAD2DEG,
    transform,
    outputSize: config.outputSize,
    uprightFaceRect,
    landmarks,
    faceRect: boundingRect(landmarks),
    outsideRatio: outsideRatio(transform, config.outputSize, imageWidth, imageHeight),
  };
}

/**
 * 輝度・ぶれを測る領域。傾き補正後の顔の枠を inset だけ内側に縮めた矩形を、
 * 元画像 → 測定用の正方形（size 四方）に写す変換を返す。
 */
export function metricsTransform(crop: CropResult, metricsSize: number, inset: number): Affine {
  // 切り出し画像の中の顔の枠（傾き補正済み）
  const r = crop.faceRect;
  const x0 = r.x + r.width * inset;
  const y0 = r.y + r.height * inset;
  const w = r.width * (1 - 2 * inset);
  const h = r.height * (1 - 2 * inset);
  const sx = metricsSize / w;
  const sy = metricsSize / h;
  // 元画像 → 切り出し画像 → 測定用（拡大縮小 + 平行移動）
  const [a, b, c, d, e, f] = crop.transform;
  return [a * sx, b * sy, c * sx, d * sy, (e - x0) * sx, (f - y0) * sy];
}

/** 切り出し後の座標を 0〜1 に正規化（保存用） */
export function normalizeToCrop(points: readonly Point3[], outputSize: number): Point3[] {
  return points.map((p) => ({ x: p.x / outputSize, y: p.y / outputSize, z: p.z / outputSize }));
}
