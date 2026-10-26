/**
 * 撮影セッション全体の判定と集計（純粋関数）。ブラウザの確認画面とサーバーの保存処理の両方で使う。
 * サーバーは受け取った timeline / landmarks からここで判定をやり直し、ブラウザの判定は信用しない。
 */
import type { CaptureStep, FaceConfig } from "../config";
import { type QualityInput, type QualityLevel, type QualityReport, evaluateQuality } from "../quality";
import type { FaceRecord } from "../schema";
import { type ExpressionRange, type MotionProfile, type TemporalReport, evaluateTemporal, expressionRange, motionProfile } from "./temporal";
import { sliceByTime } from "./timeline";
import type { FrameSample } from "./types";

export function qualityInputFromRecord(record: FaceRecord): QualityInput {
  return {
    faceCount: record.detection.faceCount,
    pose: record.detection.pose,
    faceWidthPx: record.metrics.faceWidthPx,
    blendshapes: record.detection.blendshapes,
    meanLuminance: record.metrics.meanLuminance,
    laplacianVariance: record.metrics.laplacianVariance,
    cropOutsideRatio: record.crop.outsideRatio,
    // 肩から上を作った記録（正面）だけ判定する
    ...(record.bust ? { bustOutsideRatio: record.bust.outsideRatio } : {}),
  };
}

export type RecordedStepData = {
  step: CaptureStep;
  record: FaceRecord;
  samples: readonly FrameSample[];
  hold: { fromT: number; toT: number };
  belowTarget: boolean;
};

export type StepEvaluation = {
  quality: QualityReport;
  temporal: TemporalReport;
  /** キーフレームの品質・動き・目標に届いたかをまとめた判定 */
  level: QualityLevel;
};

export function combineLevels(levels: readonly QualityLevel[]): QualityLevel {
  if (levels.includes("fail")) return "fail";
  if (levels.includes("warn")) return "warn";
  return "pass";
}

/** 段階 1 つの判定：キーフレームの品質＋記録した区間の動き＋目標に届いたか */
export function evaluateRecordedStep(data: RecordedStepData, config: FaceConfig): StepEvaluation {
  const quality = evaluateQuality(qualityInputFromRecord(data.record), config.quality, { skip: data.step.skipChecks ?? [] });
  const temporal = evaluateTemporal(data.step, sliceByTime(data.samples, data.hold.fromT, data.hold.toT), config.capture);
  const level = combineLevels([quality.status, temporal.status, data.belowTarget ? "warn" : "pass"]);
  return { quality, temporal, level };
}

/** 記録されていない必須の段階 */
export function missingRequiredSteps(steps: readonly CaptureStep[], recordedIds: ReadonlySet<string>): CaptureStep[] {
  return steps.filter((s) => !s.optional && !recordedIds.has(s.id));
}

/** 表情の幅と動きの特徴を集計する */
export function analyzeSession(
  recorded: readonly RecordedStepData[],
  config: FaceConfig,
): { expressionRange: ExpressionRange; motionProfile: MotionProfile | null } {
  const front = recorded.find((r) => r.step.kind === "front");
  const neutral = front ? sliceByTime(front.samples, front.hold.fromT, front.hold.toT) : [];
  const expressions = Object.fromEntries(
    recorded
      .filter((r) => r.step.kind === "expression")
      .map((r) => [r.step.id, sliceByTime(r.samples, r.hold.fromT, r.hold.toT)] as const),
  );
  const free = recorded.find((r) => r.step.kind === "free");
  return {
    expressionRange: expressionRange(neutral, expressions),
    motionProfile: free ? motionProfile(free.samples, config.capture) : null,
  };
}
