import type { Point2 } from "../geometry";
import type { HeadPose } from "../pose";

/** カメラ映像 1 フレーム分の解析結果 */
export type FrameSample = {
  /** 段階の開始からの経過時間（ms） */
  t: number;
  faceCount: number;
  pose: HeadPose | null;
  blendshapes: Readonly<Record<string, number>> | null;
  /** 傾きを補正した顔の幅（元映像のピクセル） */
  faceWidthPx: number | null;
  /** 顔の中心（元映像のピクセル） */
  center: Point2 | null;
  /** 輝度・ぶれは数フレームに 1 回だけ測る。測っていないフレームは直前の値を引き継ぐ */
  meanLuminance: number | null;
  laplacianVariance: number | null;
  /** そのフレームで実際に測ったか（ゆらぎの計算に使う） */
  metricsMeasured: boolean;
  cropOutsideRatio: number | null;
  /** 肩から上の切り出しのはみ出し割合（正面の段階だけ測る） */
  bustOutsideRatio?: number | null;
};
