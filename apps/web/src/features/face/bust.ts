/**
 * 肩から上の画像（顔を動かす処理の元画像）の切り出しと、背景の切り抜き（純粋関数）。
 *
 * 顔を動かす処理（LivePortrait 系）は顔の周りだけを動かして元画像に貼り戻すので、
 * 元画像に肩まで入っていればそのまま「肩から上が動く映像」になる。
 * 肩は頭と一緒に傾かないので、512 の顔の切り出しと違い、ここでは回転させない。
 */
import type { BustConfig } from "./config";
import { outsideRatio } from "./crop";
import { type Affine, type Point3, type Rect, applyAffine, boundingRect } from "./geometry";

export type BustCrop = {
  width: number;
  height: number;
  /** 元画像の中で切り出す範囲（はみ出すこともある） */
  sourceRect: Rect;
  /** 元画像のピクセル → 切り出し画像のピクセル */
  transform: Affine;
  /** 切り出し画像の中のランドマーク（ピクセル。z も同じ倍率） */
  landmarks: Point3[];
  /** 切り出し範囲のうち元画像の外にはみ出した割合（0〜1） */
  outsideRatio: number;
};

/** @param landmarksPx 元画像のピクセル座標のランドマーク */
export function computeBustCrop(
  landmarksPx: readonly Point3[],
  imageWidth: number,
  imageHeight: number,
  config: BustConfig,
): BustCrop {
  const face = boundingRect(landmarksPx);
  if (!(face.height > 0)) throw new Error("顔の大きさを求められません");
  const h = face.height * config.heightScale;
  const w = h * (config.outputWidth / config.outputHeight);
  const sourceRect: Rect = {
    x: face.x + face.width / 2 - w / 2,
    y: face.y - face.height * config.topMargin,
    width: w,
    height: h,
  };
  const k = config.outputHeight / h;
  const transform: Affine = [k, 0, 0, k, -sourceRect.x * k, -sourceRect.y * k];
  const landmarks = landmarksPx.map((p) => {
    const q = applyAffine(transform, p);
    return { x: q.x, y: q.y, z: p.z * k };
  });
  return {
    width: config.outputWidth,
    height: config.outputHeight,
    sourceRect,
    transform,
    landmarks,
    outsideRatio: outsideRatio(transform, config.outputWidth, imageWidth, imageHeight, 64, config.outputHeight),
  };
}

/** 0〜1 の値を low〜high の間でなめらかに 0→1 にする */
export function smoothstep(low: number, high: number, x: number): number {
  if (high <= low) return x < low ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

export type Mask = { data: ArrayLike<number>; width: number; height: number };

/** マスクを (x, y)（出力画像のピクセル中心）で双線形補間して読む */
function sampleMask(mask: Mask, x: number, y: number, outW: number, outH: number): number {
  const mx = ((x + 0.5) / outW) * mask.width - 0.5;
  const my = ((y + 0.5) / outH) * mask.height - 0.5;
  const x0 = Math.max(0, Math.min(mask.width - 1, Math.floor(mx)));
  const y0 = Math.max(0, Math.min(mask.height - 1, Math.floor(my)));
  const x1 = Math.min(mask.width - 1, x0 + 1);
  const y1 = Math.min(mask.height - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, mx - x0));
  const fy = Math.min(1, Math.max(0, my - y0));
  const at = (xx: number, yy: number) => mask.data[yy * mask.width + xx] as number;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * 背景の確からしさのマスクから、人物だけを残した RGBA を作る（rgba の alpha を書き換える）。
 * マスクの大きさが画像と違っても補間して使う。
 * @returns 人物が画像に占める割合（alpha の平均, 0〜1）
 */
export function applyBackgroundMatte(
  rgba: { data: Uint8ClampedArray; width: number; height: number },
  backgroundConfidence: Mask,
  matte: BustConfig["matte"],
): number {
  const { width, height, data } = rgba;
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bg = sampleMask(backgroundConfidence, x, y, width, height);
      const alpha = 1 - smoothstep(matte.backgroundLow, matte.backgroundHigh, bg);
      const i = (y * width + x) * 4 + 3;
      data[i] = Math.round((data[i] as number) * alpha);
      sum += alpha;
    }
  }
  return sum / (width * height);
}

/** 切り出し後の座標を 0〜1 に正規化（保存用） */
export function normalizeToBust(points: readonly Point3[], width: number, height: number): Point3[] {
  return points.map((p) => ({ x: p.x / width, y: p.y / height, z: p.z / width }));
}
