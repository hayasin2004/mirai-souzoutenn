"use client";

import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { canvas2d, toBlob } from "./canvas";
import { type BustCrop, applyBackgroundMatte, computeBustCrop, normalizeToBust } from "./bust";
import { FACE_CONFIG, type FaceConfig } from "./config";
import { toPixelLandmarks } from "./crop";
import type { Point3 } from "./geometry";
import type { FaceRecord } from "./schema";

const WASM_BASE = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/selfie_multiclass_256x256.tflite";

let segmenter: Promise<ImageSegmenter> | null = null;

async function createSegmenter(delegate: "GPU" | "CPU"): Promise<ImageSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "IMAGE",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

/** 人物の切り抜き（ローカルのモデル）。1 度だけ作って使い回す */
export function getSegmenter(): Promise<ImageSegmenter> {
  segmenter ??= createSegmenter("GPU").catch((err: unknown) => {
    console.warn("[face] 切り抜きを GPU で初期化できなかったので CPU に切り替えます", err);
    return createSegmenter("CPU");
  });
  segmenter.catch(() => {
    segmenter = null;
  });
  return segmenter;
}

export type BustResult = {
  crop: BustCrop;
  /** 肩から上（背景つき、RGB） */
  bustPng: Blob;
  /** 肩から上（背景を透明にした RGBA） */
  cutoutPng: Blob;
  /** 人物が画像に占める割合（0〜1） */
  personCoverage: number;
};

/**
 * 元画像から肩から上を切り出し、背景を切り抜く。
 * @param landmarks 元画像に対する 0〜1 のランドマーク
 */
export async function renderBust(
  source: CanvasImageSource,
  width: number,
  height: number,
  landmarks: readonly Point3[],
  config: FaceConfig = FACE_CONFIG,
): Promise<BustResult> {
  const cfg = config.bust;
  const crop = computeBustCrop(toPixelLandmarks(landmarks, width, height), width, height, cfg);

  const [canvas, ctx] = canvas2d(crop.width, crop.height);
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, crop.width, crop.height);
  ctx.setTransform(...crop.transform);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const bustPng = await toBlob(canvas, "image/png");

  // 背景の確からしさ（multiclass モデルの "background" クラス）で透明にする
  const seg = await getSegmenter();
  const result = seg.segment(canvas);
  try {
    const labels = seg.getLabels();
    const bgIndex = Math.max(0, labels.findIndex((l) => l.toLowerCase().includes("background")));
    const mask = result.confidenceMasks?.[bgIndex];
    if (!mask) throw new Error("切り抜きのマスクを取得できません");
    const image = ctx.getImageData(0, 0, crop.width, crop.height);
    const personCoverage = applyBackgroundMatte(
      image,
      { data: mask.getAsFloat32Array(), width: mask.width, height: mask.height },
      cfg.matte,
    );
    ctx.putImageData(image, 0, 0);
    const cutoutPng = await toBlob(canvas, "image/png");
    return { crop, bustPng, cutoutPng, personCoverage };
  } finally {
    result.close();
  }
}

/** landmarks.json に入れる肩から上の情報 */
export function toBustRecord(b: BustResult): NonNullable<FaceRecord["bust"]> {
  return {
    width: b.crop.width,
    height: b.crop.height,
    sourceRect: b.crop.sourceRect,
    transform: [...b.crop.transform],
    outsideRatio: b.crop.outsideRatio,
    personCoverage: b.personCoverage,
    landmarks: normalizeToBust(b.crop.landmarks, b.crop.width, b.crop.height).map((p) => [p.x, p.y, p.z]),
  };
}
