/** 画像の明るさ・ぶれを測る純粋関数。ImageData と同じ形（RGBA 8bit）を受け取る */

export type RgbaImage = { data: ArrayLike<number>; width: number; height: number };
export type GrayImage = { data: Float32Array; width: number; height: number };

/** RGBA → 輝度（ITU-R BT.601, 0〜255） */
export function toGrayscale(img: RgbaImage): GrayImage {
  const { width, height, data } = img;
  if (data.length < width * height * 4) throw new Error("画素データが足りません");
  const out = new Float32Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = 0.299 * (data[j] as number) + 0.587 * (data[j + 1] as number) + 0.114 * (data[j + 2] as number);
  }
  return { data: out, width, height };
}

/** 平均輝度（0〜255）。空なら NaN */
export function meanLuminance(gray: GrayImage): number {
  const n = gray.data.length;
  if (n === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray.data[i] as number;
  return sum / n;
}

/**
 * ラプラシアン分散（ぶれ・ピンぼけの指標）。4 近傍ラプラシアン
 *   [0  1  0]
 *   [1 -4  1]
 *   [0  1  0]
 * を内側の画素にかけ、その分散を返す。くっきりした画像ほど大きい。
 */
export function laplacianVariance(gray: GrayImage): number {
  const { width: w, height: h, data } = gray;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const v =
        (data[i - w] as number) +
        (data[i + w] as number) +
        (data[i - 1] as number) +
        (data[i + 1] as number) -
        4 * (data[i] as number);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export type FaceRegionMetrics = { meanLuminance: number; laplacianVariance: number };

export function measureFaceRegion(img: RgbaImage): FaceRegionMetrics {
  const gray = toGrayscale(img);
  return { meanLuminance: meanLuminance(gray), laplacianVariance: laplacianVariance(gray) };
}
