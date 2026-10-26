"use client";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { FACE_CONFIG } from "./config";

/** public/ に置いたローカルのファイル（scripts/setup-mediapipe.mjs で配置）。CDN は使わない */
const WASM_BASE = "/mediapipe/wasm";
const MODEL_PATH = "/mediapipe/face_landmarker.task";

/** IMAGE = 写真 1 枚, VIDEO = カメラ映像（detectForVideo） */
export type LandmarkerMode = "IMAGE" | "VIDEO";

const instances = new Map<LandmarkerMode, Promise<FaceLandmarker>>();

async function create(mode: LandmarkerMode, delegate: "GPU" | "CPU"): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: mode,
    numFaces: FACE_CONFIG.maxFacesToDetect,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

/** モードごとに 1 度だけ作って使い回す。GPU が使えなければ CPU で動かす */
export function getFaceLandmarker(mode: LandmarkerMode = "IMAGE"): Promise<FaceLandmarker> {
  let p = instances.get(mode);
  if (!p) {
    p = create(mode, "GPU").catch((err: unknown) => {
      console.warn("[face] GPU で初期化できなかったので CPU に切り替えます", err);
      return create(mode, "CPU");
    });
    p.catch(() => instances.delete(mode)); // 失敗したら次回やり直す
    instances.set(mode, p);
  }
  return p;
}
