import { describe, expect, it } from "vitest";
import { applyBackgroundMatte, computeBustCrop, normalizeToBust, smoothstep } from "./bust";
import { FACE_CONFIG } from "./config";
import { type Point3, applyAffine } from "./geometry";

const CFG = FACE_CONFIG.bust;

/** 顔ランドマークの枠が (x, y, w, h) になる点の集まり */
function faceBox(x: number, y: number, w: number, h: number): Point3[] {
  return [
    { x, y, z: 0 },
    { x: x + w, y, z: 0 },
    { x, y: y + h, z: 10 },
    { x: x + w, y: y + h, z: 0 },
    { x: x + w / 2, y: y + h / 2, z: -5 },
  ];
}

describe("computeBustCrop", () => {
  it("顔の高さ × heightScale の範囲を、顔を左右中央にして切り出す", () => {
    const r = computeBustCrop(faceBox(900, 300, 240, 300), 1920, 1080, CFG);
    expect(r.sourceRect.height).toBeCloseTo(300 * CFG.heightScale);
    expect(r.sourceRect.y).toBeCloseTo(300 - 300 * CFG.topMargin);
    expect(r.sourceRect.x + r.sourceRect.width / 2).toBeCloseTo(1020);
    expect([r.width, r.height]).toEqual([CFG.outputWidth, CFG.outputHeight]);
  });

  it("顔の中心は出力の左右中央、上寄りに来る", () => {
    const r = computeBustCrop(faceBox(900, 300, 240, 300), 1920, 1080, CFG);
    const center = r.landmarks[4]!;
    expect(center.x).toBeCloseTo(CFG.outputWidth / 2);
    expect(center.y).toBeLessThan(CFG.outputHeight / 2);
    // 変換行列で写した位置と一致する
    const q = applyAffine(r.transform, { x: 1020, y: 450 });
    expect(q.x).toBeCloseTo(center.x);
    expect(q.y).toBeCloseTo(center.y);
  });

  it("z も同じ倍率", () => {
    const r = computeBustCrop(faceBox(900, 300, 240, 300), 1920, 1080, CFG);
    expect(r.landmarks[2]!.z).toBeCloseTo(10 * (CFG.outputHeight / (300 * CFG.heightScale)));
  });

  it("肩まで入っていれば、はみ出しは小さい", () => {
    // 1080p で顔の高さ 250px、上の方にある → 下は 250*3.2*… 程度で収まる
    const r = computeBustCrop(faceBox(900, 250, 200, 250), 1920, 1080, CFG);
    expect(r.outsideRatio).toBeLessThan(0.05);
  });

  it("顔が大きく写りすぎると、はみ出しが大きくなる", () => {
    const r = computeBustCrop(faceBox(700, 200, 500, 650), 1920, 1080, CFG);
    expect(r.outsideRatio).toBeGreaterThan(0.3);
  });

  it("縦長の出力にもできる", () => {
    const r = computeBustCrop(faceBox(900, 250, 200, 250), 1920, 1080, { ...CFG, outputWidth: 768, outputHeight: 1024 });
    expect(r.sourceRect.width / r.sourceRect.height).toBeCloseTo(0.75);
    expect(r.outsideRatio).toBeGreaterThanOrEqual(0);
  });

  it("顔の高さが 0 だとエラー", () => {
    expect(() => computeBustCrop([{ x: 1, y: 1, z: 0 }], 100, 100, CFG)).toThrow();
  });
});

describe("smoothstep", () => {
  it("範囲の外は 0 / 1、中央は 0.5", () => {
    expect(smoothstep(0.3, 0.7, 0.1)).toBe(0);
    expect(smoothstep(0.3, 0.7, 0.9)).toBe(1);
    expect(smoothstep(0.3, 0.7, 0.5)).toBeCloseTo(0.5);
  });
});

describe("applyBackgroundMatte", () => {
  it("背景は透明、人物は不透明。人物の割合を返す", () => {
    const rgba = { data: new Uint8ClampedArray(4 * 4 * 4).fill(255), width: 4, height: 4 };
    // 左半分が背景（1）、右半分が人物（0）
    const mask = { data: [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0], width: 4, height: 4 };
    const coverage = applyBackgroundMatte(rgba, mask, CFG.matte);
    expect(rgba.data[3]).toBe(0);
    expect(rgba.data[(0 * 4 + 3) * 4 + 3]).toBe(255);
    expect(coverage).toBeCloseTo(0.5, 1);
  });

  it("マスクが小さくても補間して使える", () => {
    const rgba = { data: new Uint8ClampedArray(8 * 8 * 4).fill(255), width: 8, height: 8 };
    const coverage = applyBackgroundMatte(rgba, { data: [0, 0, 0, 0], width: 2, height: 2 }, CFG.matte);
    expect(coverage).toBe(1);
  });
});

describe("normalizeToBust", () => {
  it("幅・高さで割る（z は幅）", () => {
    expect(normalizeToBust([{ x: 512, y: 256, z: 102.4 }], 1024, 1024)).toEqual([{ x: 0.5, y: 0.25, z: 0.1 }]);
  });
});
