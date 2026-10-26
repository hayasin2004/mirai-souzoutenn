"use client";

import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { type BustResult, renderBust, toBustRecord } from "./bust-render";
import { PhotoAnalysisError, canvas2d, toBlob } from "./canvas";
import { FACE_CONFIG, type FaceConfig } from "./config";
import { type CropResult, computeCrop, metricsTransform, normalizeToCrop, toPixelLandmarks } from "./crop";
import { readExifDateTime } from "./exif";
import { type Point3, type Rect, boundingRect } from "./geometry";
import { measureFaceRegion } from "./image-metrics";
import { getFaceLandmarker } from "./landmarker";
import { type HeadPose, poseFromTransformMatrix } from "./pose";
import { type EvaluateOptions, type QualityReport, evaluateQuality } from "./quality";
import type { FaceRecord } from "./schema";

export const ACCEPTED_TYPES = ["image/jpeg", "image/png"] as const;
type AcceptedType = (typeof ACCEPTED_TYPES)[number];

/** MediaPipe の結果から 1 人分だけ取り出したもの */
export type RawDetection = {
  /** 元画像に対する 0〜1 */
  landmarks: Point3[];
  /** 4x4 列優先 */
  transformMatrix: number[];
  blendshapes: Record<string, number>;
};

/** 1 人の顔が見つかったときの詳細 */
export type DetectedFace = {
  boundingBox: Rect;
  landmarks: Point3[];
  transformMatrix: number[];
  pose: HeadPose;
  blendshapes: Record<string, number>;
  crop: CropResult;
  metrics: { faceWidthPx: number; meanLuminance: number; laplacianVariance: number };
};

export type PhotoAnalysis = {
  width: number;
  height: number;
  mimeType: AcceptedType;
  faceCount: number;
  /** 顔がちょうど 1 つのときだけ */
  face: DetectedFace | null;
  quality: QualityReport;
  /** 向きを直した元写真（EXIF なしで再エンコード） */
  originalJpeg: Blob;
  /** 512x512 の切り出し（顔が 1 つのときだけ） */
  facePng: Blob | null;
  /** 肩から上の画像（顔が 1 つのときだけ） */
  bust: BustResult | null;
  capturedAt: FaceRecord["capturedAt"];
};

export { PhotoAnalysisError, canvas2d, toBlob };

/** MediaPipe の結果の index 番目の顔を取り出す */
export function rawFromResult(result: FaceLandmarkerResult, index = 0): RawDetection | null {
  const landmarks = result.faceLandmarks[index];
  const matrix = result.facialTransformationMatrixes[index];
  if (!landmarks || !matrix) return null;
  return {
    landmarks: landmarks.map(({ x, y, z }) => ({ x, y, z })),
    transformMatrix: [...matrix.data],
    blendshapes: Object.fromEntries(
      (result.faceBlendshapes[index]?.categories ?? []).map((c) => [c.categoryName, c.score] as const),
    ),
  };
}

/** 輝度・ぶれを測るための小さな Canvas（使い回す） */
export function createMetricsContext(config: FaceConfig = FACE_CONFIG): CanvasRenderingContext2D {
  return canvas2d(config.metrics.size, config.metrics.size)[1];
}

/** 傾きを補正した顔の内側を一定の大きさにそろえ、輝度とぶれを測る */
export function measureFace(
  source: CanvasImageSource,
  crop: CropResult,
  ctx: CanvasRenderingContext2D,
  config: FaceConfig = FACE_CONFIG,
) {
  const size = config.metrics.size;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.setTransform(...metricsTransform(crop, size, config.metrics.inset));
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0);
  return measureFaceRegion(ctx.getImageData(0, 0, size, size));
}

/** 顔 1 人分の詳細（切り出し・輝度・ぶれまで）を計算する */
export function buildDetectedFace(
  source: CanvasImageSource,
  width: number,
  height: number,
  raw: RawDetection,
  config: FaceConfig = FACE_CONFIG,
  metricsCtx: CanvasRenderingContext2D = createMetricsContext(config),
): DetectedFace {
  const landmarksPx = toPixelLandmarks(raw.landmarks, width, height);
  const crop = computeCrop(landmarksPx, width, height, config.crop);
  const region = measureFace(source, crop, metricsCtx, config);
  return {
    boundingBox: boundingRect(landmarksPx),
    landmarks: raw.landmarks,
    transformMatrix: raw.transformMatrix,
    pose: poseFromTransformMatrix(raw.transformMatrix),
    blendshapes: raw.blendshapes,
    crop,
    metrics: {
      faceWidthPx: crop.uprightFaceRect.width,
      meanLuminance: region.meanLuminance,
      laplacianVariance: region.laplacianVariance,
    },
  };
}

/** 512×512 の切り出しを PNG にする */
export function renderFacePng(source: CanvasImageSource, crop: CropResult, config: FaceConfig = FACE_CONFIG): Promise<Blob> {
  const out = config.crop.outputSize;
  const [canvas, ctx] = canvas2d(out, out);
  ctx.fillStyle = config.crop.background;
  ctx.fillRect(0, 0, out, out);
  ctx.setTransform(...crop.transform);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0);
  return toBlob(canvas, "image/png");
}

export function qualityOf(
  faceCount: number,
  face: DetectedFace | null,
  config: FaceConfig = FACE_CONFIG,
  options: EvaluateOptions = {},
  bust?: BustResult | null,
): QualityReport {
  return evaluateQuality(
    {
      faceCount,
      pose: face?.pose ?? null,
      faceWidthPx: face?.metrics.faceWidthPx ?? null,
      blendshapes: face?.blendshapes ?? null,
      meanLuminance: face?.metrics.meanLuminance ?? null,
      laplacianVariance: face?.metrics.laplacianVariance ?? null,
      cropOutsideRatio: face?.crop.outsideRatio ?? null,
      ...(bust ? { bustOutsideRatio: bust.crop.outsideRatio } : {}),
    },
    config.quality,
    options,
  );
}

async function readCapturedAt(file: File): Promise<FaceRecord["capturedAt"]> {
  if (file.type === "image/jpeg") {
    // EXIF は先頭 128KB 以内にある
    const exif = readExifDateTime(await file.slice(0, 128 * 1024).arrayBuffer());
    if (exif) return { value: exif, source: "exif" };
  }
  return file.lastModified ? { value: new Date(file.lastModified).toISOString(), source: "file" } : null;
}

/**
 * 写真を読み込み、顔の検出・品質チェック・切り出しまで行う（ブラウザで実行）。
 */
export async function analyzePhoto(file: File, config: FaceConfig = FACE_CONFIG): Promise<PhotoAnalysis> {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    throw new PhotoAnalysisError("JPEG または PNG の写真を選んでください");
  }
  const mimeType = file.type as AcceptedType;

  // スマホ写真の向き（EXIF Orientation）をここで直す
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoAnalysisError("写真を読み込めませんでした。ファイルが壊れていないか確認してください");
  }
  const { width, height } = bitmap;
  const [source, sourceCtx] = canvas2d(width, height);
  sourceCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const [landmarker, originalJpeg, capturedAt] = await Promise.all([
    getFaceLandmarker("IMAGE"),
    toBlob(source, "image/jpeg", 0.92),
    readCapturedAt(file),
  ]);
  const result = landmarker.detect(source);
  const faceCount = result.faceLandmarks.length;

  const raw = faceCount === 1 ? rawFromResult(result) : null;
  const face = raw ? buildDetectedFace(source, width, height, raw, config) : null;
  const [facePng, bust] = face
    ? await Promise.all([renderFacePng(source, face.crop, config), renderBust(source, width, height, face.landmarks, config)])
    : [null, null];
  const quality = qualityOf(faceCount, face, config, {}, bust);

  return { width, height, mimeType, faceCount, face, quality, originalJpeg, facePng, bust, capturedAt };
}

/** 保存用の landmarks.json を組み立てる（顔が 1 つのときだけ） */
export function toFaceRecord(
  a: Pick<PhotoAnalysis, "width" | "height" | "mimeType" | "faceCount" | "face" | "quality" | "capturedAt"> & {
    bust?: BustResult | null;
  },
  config: FaceConfig = FACE_CONFIG,
  capture?: FaceRecord["capture"],
): FaceRecord | null {
  const f = a.face;
  if (!f) return null;
  const tuple = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];
  return {
    version: 1,
    capturedAt: a.capturedAt,
    analyzedAt: new Date().toISOString(),
    source: { width: a.width, height: a.height, mimeType: a.mimeType },
    detection: {
      faceCount: a.faceCount,
      boundingBox: f.boundingBox,
      landmarks: f.landmarks.map(tuple),
      transformMatrix: f.transformMatrix,
      pose: f.pose,
      blendshapes: f.blendshapes,
    },
    metrics: f.metrics,
    crop: {
      size: f.crop.outputSize,
      rollDeg: f.crop.rollDeg,
      transform: [...f.crop.transform],
      outsideRatio: f.crop.outsideRatio,
      faceRect: f.crop.faceRect,
      landmarks: normalizeToCrop(f.crop.landmarks, f.crop.outputSize).map(tuple),
    },
    quality: a.quality,
    thresholds: config as unknown as Record<string, unknown>,
    ...(a.bust ? { bust: toBustRecord(a.bust) } : {}),
    ...(capture ? { capture } : {}),
  };
}
