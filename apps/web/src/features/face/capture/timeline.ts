import { z } from "zod";
import type { FrameSample } from "./types";

/**
 * フレームごとの記録（timeline.json）。全フレームの顔の向き・ブレンドシェイプなどを小さくまとめる。
 * ランドマーク全点は重いので、キーフレーム（landmarks.json）だけに残す。
 */
const finite = z.number().refine(Number.isFinite);
const nullableFinite = finite.nullable();

export const timelineSchema = z.object({
  version: z.literal(1),
  /** フレームの並びの blendshape の名前（frames[].b の順番） */
  blendshapeNames: z.array(z.string()),
  frames: z.array(
    z.object({
      /** 段階の開始からの ms */
      t: finite,
      /** 写っている顔の数 */
      n: z.number().int().nonnegative(),
      /** [yaw, pitch, roll]（度） */
      p: z.tuple([finite, finite, finite]).nullable(),
      /** 顔の中心 [x, y]（元映像のピクセル） */
      c: z.tuple([finite, finite]).nullable(),
      /** 顔の幅（px） */
      w: nullableFinite,
      /** blendshapeNames の順の値 */
      b: z.array(finite).nullable(),
      /** 平均輝度・ラプラシアン分散（測ったフレームだけ） */
      l: nullableFinite,
      s: nullableFinite,
      /** 切り出しのはみ出し割合 */
      o: nullableFinite,
    }),
  ),
});

export type Timeline = z.infer<typeof timelineSchema>;

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export function encodeTimeline(samples: readonly FrameSample[]): Timeline {
  const names = new Set<string>();
  for (const s of samples) if (s.blendshapes) for (const k of Object.keys(s.blendshapes)) names.add(k);
  const blendshapeNames = [...names];
  return {
    version: 1,
    blendshapeNames,
    frames: samples.map((s) => ({
      t: round(s.t, 1),
      n: s.faceCount,
      p: s.pose ? [round(s.pose.yaw, 2), round(s.pose.pitch, 2), round(s.pose.roll, 2)] : null,
      c: s.center ? [round(s.center.x, 1), round(s.center.y, 1)] : null,
      w: s.faceWidthPx === null ? null : round(s.faceWidthPx, 1),
      b: s.blendshapes ? blendshapeNames.map((k) => round(s.blendshapes![k] ?? 0, 4)) : null,
      l: s.metricsMeasured && s.meanLuminance !== null ? round(s.meanLuminance, 2) : null,
      s: s.metricsMeasured && s.laplacianVariance !== null ? round(s.laplacianVariance, 2) : null,
      o: s.cropOutsideRatio === null ? null : round(s.cropOutsideRatio, 4),
    })),
  };
}

/** timeline.json を FrameSample に戻す（輝度・ぶれは測っていないフレームに直前の値を引き継ぐ） */
export function decodeTimeline(tl: Timeline): FrameSample[] {
  let lum: number | null = null;
  let sharp: number | null = null;
  return tl.frames.map((f) => {
    const measured = f.l !== null || f.s !== null;
    if (f.l !== null) lum = f.l;
    if (f.s !== null) sharp = f.s;
    return {
      t: f.t,
      faceCount: f.n,
      pose: f.p ? { yaw: f.p[0], pitch: f.p[1], roll: f.p[2] } : null,
      blendshapes: f.b ? Object.fromEntries(tl.blendshapeNames.map((k, i) => [k, f.b![i] ?? 0])) : null,
      faceWidthPx: f.w,
      center: f.c ? { x: f.c[0], y: f.c[1] } : null,
      meanLuminance: lum,
      laplacianVariance: sharp,
      metricsMeasured: measured,
      cropOutsideRatio: f.o,
    };
  });
}

/** [fromT, toT] の区間のフレーム */
export function sliceByTime(samples: readonly FrameSample[], fromT: number, toT: number): FrameSample[] {
  return samples.filter((s) => s.t >= fromT && s.t <= toT);
}
