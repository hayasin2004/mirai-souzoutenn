import type { CaptureConfig, CaptureStep, FaceConfig, PoseTarget } from "../config";
import type { HeadPose } from "../pose";
import { type QualityReport, evaluateQuality } from "../quality";
import type { FrameSample } from "./types";

/** 主な向き以外の軸（左右を向く段階なら上下）のずれの許容（度） */
export const OFF_AXIS_MAX_DEG = 12;

/** 本人から見た向き（度）。left が正 = 本人の左を向いている, up が正 = 上を向いている */
export function subjectPose(pose: HeadPose, sign: CaptureConfig["poseSign"]): { left: number; up: number } {
  return { left: pose.yaw * sign.yawLeft, up: pose.pitch * sign.pitchUp };
}

/** 目標の向きにどれだけ向いているか（度）と、主な軸以外のずれ（度） */
export function poseTowards(target: PoseTarget, pose: HeadPose, sign: CaptureConfig["poseSign"]) {
  const s = subjectPose(pose, sign);
  switch (target.direction) {
    case "left":
      return { value: s.left, offAxis: Math.abs(s.up) };
    case "right":
      return { value: -s.left, offAxis: Math.abs(s.up) };
    case "up":
      return { value: s.up, offAxis: Math.abs(s.left) };
    case "down":
      return { value: -s.up, offAxis: Math.abs(s.left) };
  }
}

/** ブレンドシェイプの条件の値（names の平均） */
export function expressionValue(names: readonly string[], blendshapes: Readonly<Record<string, number>>): number {
  if (names.length === 0) return 0;
  return names.reduce((sum, n) => sum + (blendshapes[n] ?? 0), 0) / names.length;
}

export type TargetResult = {
  met: boolean;
  /** 目標に対する今の値（向き=度, 表情=0〜1）。front / free は null */
  value: number | null;
  /** 目標に近づくための一言 */
  hint: string | null;
};

const DIRECTION_LABEL: Record<PoseTarget["direction"], string> = { left: "左", right: "右", up: "上", down: "下" };

/** 段階の目標（向き・表情）を満たしているか */
export function evaluateTarget(step: CaptureStep, sample: FrameSample, config: CaptureConfig): TargetResult {
  if (sample.faceCount !== 1) {
    return { met: false, value: null, hint: sample.faceCount === 0 ? "顔が見えません" : "ほかの人が写っています" };
  }
  if (step.kind === "pose" && step.pose) {
    if (!sample.pose) return { met: false, value: null, hint: null };
    const { value, offAxis } = poseTowards(step.pose, sample.pose, config.poseSign);
    const dir = DIRECTION_LABEL[step.pose.direction];
    let hint: string | null = null;
    if (value < step.pose.minDeg) hint = `もう少し${dir}へ`;
    else if (value > step.pose.maxDeg) hint = "向きすぎです。少し戻してください";
    else if (offAxis > OFF_AXIS_MAX_DEG) hint = step.pose.direction === "left" || step.pose.direction === "right" ? "顔の高さをまっすぐに" : "左右はまっすぐに";
    return { met: hint === null, value, hint };
  }
  if (step.kind === "expression" && step.expression) {
    if (!sample.blendshapes) return { met: false, value: null, hint: null };
    const value = expressionValue(step.expression.names, sample.blendshapes);
    const met = value >= step.expression.min;
    return { met, value, hint: met ? null : "もう少し大きく" };
  }
  return { met: true, value: null, hint: null };
}

/** そのフレームの品質チェック（段階ごとに判定しない項目を除く） */
export function frameQuality(step: CaptureStep, sample: FrameSample, config: FaceConfig): QualityReport {
  return evaluateQuality(
    {
      faceCount: sample.faceCount,
      pose: sample.pose,
      faceWidthPx: sample.faceWidthPx,
      blendshapes: sample.blendshapes,
      meanLuminance: sample.meanLuminance,
      laplacianVariance: sample.laplacianVariance,
      cropOutsideRatio: sample.cropOutsideRatio,
      ...(sample.bustOutsideRatio !== undefined ? { bustOutsideRatio: sample.bustOutsideRatio } : {}),
    },
    config.quality,
    { skip: step.skipChecks ?? [] },
  );
}
