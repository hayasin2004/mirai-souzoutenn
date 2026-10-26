import { describe, expect, it } from "vitest";
import { laplacianVariance, meanLuminance, measureFaceRegion, type RgbaImage, toGrayscale } from "./image-metrics";

function makeImage(width: number, height: number, fn: (x: number, y: number) => number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** 3x3 の平均フィルタ（ぼかし）を n 回かける */
function boxBlur(img: RgbaImage, times: number): RgbaImage {
  let cur = img;
  for (let t = 0; t < times; t++) {
    const { width: w, height: h } = cur;
    const src = cur.data;
    cur = makeImage(w, h, (x, y) => {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[(yy * w + xx) * 4] as number;
          n++;
        }
      return s / n;
    });
  }
  return cur;
}

describe("toGrayscale / meanLuminance", () => {
  it("BT.601 の重みで輝度を計算する", () => {
    const img: RgbaImage = { data: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], width: 3, height: 1 };
    const g = toGrayscale(img);
    expect(g.data[0]).toBeCloseTo(0.299 * 255, 3);
    expect(g.data[1]).toBeCloseTo(0.587 * 255, 3);
    expect(g.data[2]).toBeCloseTo(0.114 * 255, 3);
  });

  it("一様な画像の平均輝度はその値", () => {
    expect(meanLuminance(toGrayscale(makeImage(8, 8, () => 120)))).toBeCloseTo(120, 3);
  });

  it("画素が足りないとエラー", () => {
    expect(() => toGrayscale({ data: [0, 0, 0], width: 2, height: 2 })).toThrow();
  });
});

describe("laplacianVariance", () => {
  it("一様な画像は 0", () => {
    expect(laplacianVariance(toGrayscale(makeImage(16, 16, () => 90)))).toBe(0);
  });

  it("ぼかすほど小さくなる（ぶれの検出）", () => {
    const sharp = makeImage(64, 64, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 220 : 30));
    const v0 = measureFaceRegion(sharp).laplacianVariance;
    const v1 = measureFaceRegion(boxBlur(sharp, 1)).laplacianVariance;
    const v3 = measureFaceRegion(boxBlur(sharp, 3)).laplacianVariance;
    expect(v0).toBeGreaterThan(v1);
    expect(v1).toBeGreaterThan(v3);
    expect(v3).toBeLessThan(v0 / 10);
  });

  it("小さすぎる画像は 0", () => {
    expect(laplacianVariance(toGrayscale(makeImage(2, 2, (x) => x * 100)))).toBe(0);
  });
});
