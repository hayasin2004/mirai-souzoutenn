import { z } from "zod";
import { QUALITY_CHECK_IDS } from "./quality";

/** MediaPipe Face Mesh（虹彩つき）の点の数 */
export const LANDMARK_COUNT = 478;

const finite = z.number().refine(Number.isFinite, "有限の数値が必要です");
const point3 = z.tuple([finite, finite, finite]);
const rect = z.object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() });
const level = z.enum(["pass", "warn", "fail"]);

export const qualityReportSchema = z.object({
  status: level,
  checks: z.array(
    z.object({
      id: z.enum(QUALITY_CHECK_IDS),
      label: z.string(),
      level: z.enum(["pass", "warn", "fail", "skip"]),
      value: finite.nullable(),
      unit: z.string(),
      criterion: z.string(),
      tip: z.string().nullable(),
    }),
  ),
});

/** 撮影日時など、タイムゾーンなしの現地時刻 */
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

/**
 * landmarks.json の中身。ブラウザで解析して送り、サーバーで検証して保存する。
 * 座標の [x, y, z] は、detection では元画像に対する 0〜1、crop では切り出し画像に対する 0〜1。
 */
export const faceRecordSchema = z.object({
  version: z.literal(1),
  /** 撮影日時。EXIF から読めた場合は exif、読めなければファイルの更新日時、カメラで撮ったときは camera */
  capturedAt: z
    .object({ value: localDateTime.or(z.iso.datetime()), source: z.enum(["exif", "file", "camera"]) })
    .nullable(),
  analyzedAt: z.iso.datetime(),
  source: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mimeType: z.enum(["image/jpeg", "image/png"]),
  }),
  detection: z.object({
    faceCount: z.number().int().nonnegative(),
    /** 元画像のピクセル座標の顔の枠（ランドマークの外接矩形） */
    boundingBox: rect,
    landmarks: z.array(point3).length(LANDMARK_COUNT),
    /** 4x4 列優先 */
    transformMatrix: z.array(finite).length(16),
    pose: z.object({ yaw: finite, pitch: finite, roll: finite }),
    blendshapes: z.record(z.string(), finite),
  }),
  metrics: z.object({
    faceWidthPx: finite,
    meanLuminance: finite,
    laplacianVariance: finite,
  }),
  crop: z.object({
    size: z.number().int().positive(),
    rollDeg: finite,
    /** 元画像のピクセル → 切り出し画像のピクセル（Canvas の setTransform と同じ並び） */
    transform: z.tuple([finite, finite, finite, finite, finite, finite]),
    outsideRatio: finite.min(0).max(1),
    /** 切り出し画像のピクセル座標の顔の枠 */
    faceRect: rect,
    landmarks: z.array(point3).length(LANDMARK_COUNT),
  }),
  quality: qualityReportSchema,
  /** 判定に使ったしきい値（config.ts のスナップショット） */
  thresholds: z.record(z.string(), z.unknown()),
  /**
   * 肩から上の画像（顔を動かす処理の元画像 bust.png / bust_cutout.png）。正面の顔だけ。
   * landmarks は肩から上の画像に対する 0〜1（z は幅基準）。
   */
  bust: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /** 元画像の中で切り出した範囲（ピクセル。はみ出すこともある） */
      sourceRect: z.object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() }),
      /** 元画像のピクセル → 肩から上の画像のピクセル */
      transform: z.tuple([finite, finite, finite, finite, finite, finite]),
      outsideRatio: finite.min(0).max(1),
      /** 切り抜いた人物が画像に占める割合 */
      personCoverage: finite.min(0).max(1),
      landmarks: z.array(point3).length(LANDMARK_COUNT),
    })
    .optional(),
  /** カメラで撮ったキーフレームのとき：どの段階の、段階開始から何 ms のフレームか */
  capture: z
    .object({
      stepId: z.string().regex(/^[A-Za-z0-9_]{1,32}$/),
      kind: z.enum(["front", "pose", "expression", "free"]),
      frameTimeMs: finite.nonnegative(),
    })
    .optional(),
});

export type FaceRecord = z.infer<typeof faceRecordSchema>;
