import { describe, expect, it } from "vitest";
import { FACE_CONFIG } from "./config";
import {
  EYE_CORNERS,
  computeCrop,
  eyeCenters,
  invertAffine,
  metricsTransform,
  normalizeToCrop,
  outsideRatio,
  toPixelLandmarks,
} from "./crop";
import { type Affine, DEG2RAD, type Point3, applyAffine } from "./geometry";

const CFG = { ...FACE_CONFIG.crop, centerOffsetY: 0 };

/**
 * 合成した顔ランドマーク。中心 (cx, cy)、幅 2*rx・高さ 2*ry の楕円上に点を並べ、
 * 目尻・目頭だけ目の位置に置く。angleDeg だけ中心まわりに回転する。
 */
function syntheticFace(cx: number, cy: number, rx: number, ry: number, angleDeg = 0): Point3[] {
  const pts: Point3[] = Array.from({ length: 478 }, (_, i) => {
    const t = (i / 478) * Math.PI * 2;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), z: 0.1 * i };
  });
  const eyeY = cy - ry * 0.25;
  pts[EYE_CORNERS.imageLeft[0]] = { x: cx - rx * 0.6, y: eyeY, z: 0 };
  pts[EYE_CORNERS.imageLeft[1]] = { x: cx - rx * 0.2, y: eyeY, z: 0 };
  pts[EYE_CORNERS.imageRight[0]] = { x: cx + rx * 0.2, y: eyeY, z: 0 };
  pts[EYE_CORNERS.imageRight[1]] = { x: cx + rx * 0.6, y: eyeY, z: 0 };
  if (angleDeg === 0) return pts;
  const c = Math.cos(angleDeg * DEG2RAD);
  const s = Math.sin(angleDeg * DEG2RAD);
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy, z: p.z };
  });
}

describe("toPixelLandmarks", () => {
  it("正規化座標をピクセルに直す（z は幅基準）", () => {
    expect(toPixelLandmarks([{ x: 0.5, y: 0.25, z: -0.1 }], 800, 600)).toEqual([{ x: 400, y: 150, z: -80 }]);
  });
});

describe("computeCrop", () => {
  it("傾いていない顔は回転せず、中央に来る", () => {
    const face = syntheticFace(1000, 800, 150, 200);
    const r = computeCrop(face, 2000, 1600, CFG);
    expect(r.rollDeg).toBeCloseTo(0, 6);
    expect(r.outputSize).toBe(512);
    // 顔の枠の中心が出力の中心
    expect(r.faceRect.x + r.faceRect.width / 2).toBeCloseTo(256, 3);
    expect(r.faceRect.y + r.faceRect.height / 2).toBeCloseTo(256, 3);
    // 長い方の辺（高さ 400px）が 512 / scale になる
    expect(r.faceRect.height).toBeCloseTo(512 / CFG.scale, 3);
    expect(r.uprightFaceRect.width).toBeCloseTo(300, 0);
    expect(r.outsideRatio).toBe(0);
  });

  it.each([15, -15, 28])("%d° 傾いた顔は目が水平になるよう補正される", (angle) => {
    const face = syntheticFace(900, 700, 150, 200, angle);
    const r = computeCrop(face, 1800, 1400, CFG);
    expect(r.rollDeg).toBeCloseTo(angle, 6);
    const eyes = eyeCenters(r.landmarks);
    expect(eyes.imageLeft.y).toBeCloseTo(eyes.imageRight.y, 6);
    expect(eyes.imageLeft.x).toBeLessThan(eyes.imageRight.x);
    // 補正後の大きさは傾いていないときと同じ
    expect(r.uprightFaceRect.width).toBeCloseTo(300, 0);
    expect(r.uprightFaceRect.height).toBeCloseTo(400, 0);
    expect(r.faceRect.x + r.faceRect.width / 2).toBeCloseTo(256, 3);
  });

  it("変換行列で元の座標を写すと、切り出し後のランドマークと一致する", () => {
    const face = syntheticFace(640, 480, 120, 160, 10);
    const r = computeCrop(face, 1280, 960, CFG);
    const i = 200;
    const q = applyAffine(r.transform, face[i]!);
    expect(q.x).toBeCloseTo(r.landmarks[i]!.x, 9);
    expect(q.y).toBeCloseTo(r.landmarks[i]!.y, 9);
  });

  it("z も同じ倍率で縮む", () => {
    const face = syntheticFace(1000, 800, 150, 200);
    const r = computeCrop(face, 2000, 1600, CFG);
    const side = Math.max(r.uprightFaceRect.width, r.uprightFaceRect.height) * CFG.scale;
    const k = 512 / side;
    expect(r.landmarks[100]!.z).toBeCloseTo(face[100]!.z * k, 9);
  });

  it("centerOffsetY で切り出しの中心が上下にずれる", () => {
    const face = syntheticFace(1000, 800, 150, 200);
    const down = computeCrop(face, 2000, 1600, { ...CFG, centerOffsetY: 0.1 });
    // 中心を下にずらす → 顔は出力の中で上に寄る
    expect(down.faceRect.y + down.faceRect.height / 2).toBeLessThan(256);
  });

  it("顔が画像の端にあるとはみ出し割合が大きくなる", () => {
    const face = syntheticFace(100, 120, 90, 120);
    const r = computeCrop(face, 1000, 1000, CFG);
    expect(r.outsideRatio).toBeGreaterThan(0.2);
    expect(r.outsideRatio).toBeLessThan(1);
  });

  it("ランドマークが足りないとエラー", () => {
    expect(() => computeCrop([{ x: 0, y: 0, z: 0 }], 100, 100, CFG)).toThrow();
  });
});

describe("invertAffine / outsideRatio", () => {
  it("逆変換を合成すると元に戻る", () => {
    const m: Affine = [0.8, -0.3, 0.3, 0.8, 12, -40];
    const p = { x: 33, y: -7 };
    const q = applyAffine(invertAffine(m), applyAffine(m, p));
    expect(q.x).toBeCloseTo(p.x, 9);
    expect(q.y).toBeCloseTo(p.y, 9);
  });

  it("出力全体が元画像の外なら 1", () => {
    expect(outsideRatio([1, 0, 0, 1, 5000, 5000], 512, 100, 100)).toBe(1);
  });

  it("恒等変換で同じ大きさなら 0", () => {
    expect(outsideRatio([1, 0, 0, 1, 0, 0], 512, 512, 512)).toBe(0);
  });
});

describe("metricsTransform", () => {
  it("顔の枠の内側を測定用の正方形いっぱいに写す", () => {
    const face = syntheticFace(1000, 800, 150, 200, 12);
    const crop = computeCrop(face, 2000, 1600, CFG);
    const inset = 0.15;
    const m = metricsTransform(crop, 256, inset);
    const toCrop = invertAffine(crop.transform);
    const r = crop.faceRect;
    // 切り出し画像の中で内側の枠の左上・右下 → 測定用の (0,0)・(256,256)
    const tl = applyAffine(toCrop, { x: r.x + r.width * inset, y: r.y + r.height * inset });
    const br = applyAffine(toCrop, { x: r.x + r.width * (1 - inset), y: r.y + r.height * (1 - inset) });
    const a = applyAffine(m, tl);
    const b = applyAffine(m, br);
    expect(a.x).toBeCloseTo(0, 6);
    expect(a.y).toBeCloseTo(0, 6);
    expect(b.x).toBeCloseTo(256, 6);
    expect(b.y).toBeCloseTo(256, 6);
  });
});

describe("normalizeToCrop", () => {
  it("出力の大きさで割る", () => {
    expect(normalizeToCrop([{ x: 256, y: 128, z: -51.2 }], 512)).toEqual([{ x: 0.5, y: 0.25, z: -0.1 }]);
  });
});
