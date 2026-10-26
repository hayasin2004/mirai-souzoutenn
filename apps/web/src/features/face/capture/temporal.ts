/** 動画（フレームの並び）から動きを判定・集計する純粋関数 */
import type { CaptureConfig, CaptureStep, MaxThreshold } from "../config";
import { type QualityCheck, type QualityCheckId, type QualityLevel, gradeMax, overallStatus } from "../quality";
import { expressionValue, poseTowards } from "./step-eval";
import type { FrameSample } from "./types";

export type Stats = { mean: number; std: number; min: number; max: number; count: number };

export function stats(values: readonly number[]): Stats {
  const n = values.length;
  // JSON に保存するので NaN ではなく 0 を返す（count で空かどうか分かる）
  if (n === 0) return { mean: 0, std: 0, min: 0, max: 0, count: 0 };
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return { mean, std: Math.sqrt(sq / n), min, max, count: n };
}

/**
 * 各フレームの頭の回転の速さ（°/秒）。フレーム間の細かい揺れで大きく出ないよう、
 * spanMs 以上前のフレームとの差で測る。顔が無いフレームや前のフレームが無いときは null。
 */
export function angularSpeeds(samples: readonly FrameSample[], spanMs = 150): (number | null)[] {
  const out: (number | null)[] = [];
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i]!;
    while (j < i && cur.t - samples[j + 1]!.t >= spanMs) j++;
    const prev = samples[j]!;
    const dt = (cur.t - prev.t) / 1000;
    if (j === i || dt <= 0 || !cur.pose || !prev.pose) {
      out.push(null);
      continue;
    }
    const d = Math.max(
      Math.abs(cur.pose.yaw - prev.pose.yaw),
      Math.abs(cur.pose.pitch - prev.pose.pitch),
      Math.abs(cur.pose.roll - prev.pose.roll),
    );
    out.push(d / dt);
  }
  return out;
}

/** 条件を満たし続けている時間を数える。満たさないフレームが来たらリセット */
export type HoldState = { since: number | null };

export function updateHold(state: HoldState, ok: boolean, t: number): HoldState {
  if (!ok) return { since: null };
  return { since: state.since ?? t };
}

export function holdProgress(state: HoldState, t: number, holdSec: number): number {
  if (state.since === null) return 0;
  return Math.min(1, (t - state.since) / (holdSec * 1000));
}

/** まばたきの回数。目の閉じ具合が closeAbove を超え、openBelow を下回ったら 1 回 */
export function countBlinks(samples: readonly FrameSample[], blink: CaptureConfig["blink"]): number {
  let closed = false;
  let count = 0;
  for (const s of samples) {
    if (!s.blendshapes) continue;
    const v = Math.max(s.blendshapes["eyeBlinkLeft"] ?? 0, s.blendshapes["eyeBlinkRight"] ?? 0);
    if (!closed && v > blink.closeAbove) closed = true;
    else if (closed && v < blink.openBelow) {
      closed = false;
      count++;
    }
  }
  return count;
}

/**
 * キーフレームの候補としての点数（大きいほどよい）。
 * くっきりしていて、止まっていて、目が開いていて、目標に近いフレームを選ぶ。
 */
export function frameScore(
  step: CaptureStep,
  sample: FrameSample,
  angularSpeed: number | null,
  config: CaptureConfig,
): number {
  let score = Math.log1p(Math.max(0, sample.laplacianVariance ?? 0));
  score -= 0.03 * (angularSpeed ?? 0);
  const bs = sample.blendshapes;
  const blink = bs ? Math.max(bs["eyeBlinkLeft"] ?? 0, bs["eyeBlinkRight"] ?? 0) : 0;
  const skipsEyes = step.skipChecks?.includes("eyesOpen") ?? false;
  if (!skipsEyes) score -= 2 * blink;

  if (step.kind === "front" && sample.pose) {
    score -= 0.08 * (Math.abs(sample.pose.yaw) + Math.abs(sample.pose.pitch));
    if (bs) score -= 2 * (bs["jawOpen"] ?? 0);
  } else if (step.kind === "pose" && step.pose && sample.pose) {
    const { value, offAxis } = poseTowards(step.pose, sample.pose, config.poseSign);
    const center = (step.pose.minDeg + step.pose.maxDeg) / 2;
    score -= 0.05 * Math.abs(value - center) + 0.05 * offAxis;
  } else if (step.kind === "expression" && step.expression && bs) {
    score += 3 * expressionValue(step.expression.names, bs);
  }
  return score;
}

export type TemporalReport = {
  status: QualityLevel;
  checks: QualityCheck[];
  frames: number;
  durationMs: number;
  faceLostRatio: number;
  maxAngularSpeed: number | null;
  luminanceStd: number | null;
  blinkCount: number;
};

function check(
  id: QualityCheckId,
  label: string,
  value: number | null,
  unit: string,
  t: MaxThreshold,
  tip: string,
): QualityCheck {
  if (value === null || !Number.isFinite(value)) {
    return { id, label, level: "skip", value: null, unit, criterion: `${t.pass}${unit} 以下`, tip: null };
  }
  const level = gradeMax(value, t);
  return {
    id,
    label,
    level,
    value,
    unit,
    criterion: `${t.pass}${unit} 以下`,
    tip: level === "pass" ? null : tip,
  };
}

/**
 * 記録した区間（ホールド中のフレーム）の動きの判定。
 * free の段階は自由に動くので、回転の速さは判定しない。
 */
export function evaluateTemporal(step: CaptureStep, samples: readonly FrameSample[], config: CaptureConfig): TemporalReport {
  const frames = samples.length;
  const durationMs = frames > 1 ? samples[frames - 1]!.t - samples[0]!.t : 0;
  const lost = samples.filter((s) => s.faceCount !== 1).length;
  const faceLostRatio = frames > 0 ? lost / frames : 1;
  const speeds = angularSpeeds(samples).filter((v): v is number => v !== null);
  const maxAngularSpeed = speeds.length > 0 ? Math.max(...speeds) : null;
  const lum = samples.filter((s) => s.metricsMeasured && s.meanLuminance !== null).map((s) => s.meanLuminance!);
  const luminanceStd = lum.length >= 3 ? stats(lum).std : null;
  const m = config.motion;

  const checks: QualityCheck[] = [
    check("faceLost", "顔の見失い", faceLostRatio * 100, "%", { pass: m.faceLostRatio.pass * 100, fail: m.faceLostRatio.fail * 100 }, "顔がカメラから外れたり、手で隠れたりしています。画面の枠の中に顔を保ってください。"),
    check("lightFlicker", "明るさのゆらぎ", luminanceStd, "", m.luminanceStd, "明るさが変わっています。照明のちらつきや、窓からの光の変化がない場所で撮ってください。"),
  ];
  if (step.kind !== "free") {
    checks.unshift(
      check("motion", "動きの速さ", maxAngularSpeed, "°/s", m.angularSpeedDegPerSec, "動きが速すぎます。目標の向きでぴたっと止まってください。"),
    );
  }
  return {
    status: overallStatus(checks),
    checks,
    frames,
    durationMs,
    faceLostRatio,
    maxAngularSpeed,
    luminanceStd,
    blinkCount: countBlinks(samples, config.blink),
  };
}

/** ブレンドシェイプごとの統計（表情の癖を記録するため） */
export function blendshapeStats(samples: readonly FrameSample[]): Record<string, Stats> {
  const values = new Map<string, number[]>();
  for (const s of samples) {
    if (!s.blendshapes) continue;
    for (const [k, v] of Object.entries(s.blendshapes)) {
      let arr = values.get(k);
      if (!arr) values.set(k, (arr = []));
      arr.push(v);
    }
  }
  return Object.fromEntries([...values].map(([k, v]) => [k, stats(v)]));
}

export type MotionProfile = {
  durationSec: number;
  blinkPerMinute: number;
  /** 頭の向き（度）の統計 */
  yaw: Stats;
  pitch: Stats;
  roll: Stats;
  /** 頭の回転の速さ（°/秒） */
  angularSpeed: Stats;
  /** 顔の中心の移動（顔の幅に対する割合）の標準偏差 */
  swayX: number;
  swayY: number;
  blendshapes: Record<string, Stats>;
};

/** 自然に動いた区間から、その人の動きの特徴を集計する */
export function motionProfile(samples: readonly FrameSample[], config: CaptureConfig): MotionProfile {
  const withFace = samples.filter((s) => s.faceCount === 1 && s.pose);
  const durationSec = samples.length > 1 ? (samples[samples.length - 1]!.t - samples[0]!.t) / 1000 : 0;
  const widths = withFace.map((s) => s.faceWidthPx ?? 0).filter((w) => w > 0);
  const w = widths.length ? stats(widths).mean : 1;
  const cx = withFace.filter((s) => s.center).map((s) => s.center!.x / w);
  const cy = withFace.filter((s) => s.center).map((s) => s.center!.y / w);
  return {
    durationSec,
    blinkPerMinute: durationSec > 0 ? (countBlinks(samples, config.blink) / durationSec) * 60 : 0,
    yaw: stats(withFace.map((s) => s.pose!.yaw)),
    pitch: stats(withFace.map((s) => s.pose!.pitch)),
    roll: stats(withFace.map((s) => s.pose!.roll)),
    angularSpeed: stats(angularSpeeds(samples).filter((v): v is number => v !== null)),
    swayX: cx.length ? stats(cx).std : 0,
    swayY: cy.length ? stats(cy).std : 0,
    blendshapes: blendshapeStats(withFace),
  };
}

export type ExpressionRange = {
  /** 真顔（正面の段階）の平均。各表情はここからの差で見る */
  neutral: Record<string, number>;
  /** 表情の段階ごとの、各ブレンドシェイプの最大値 */
  peaks: Record<string, Record<string, number>>;
};

/** 真顔の基準と、表情ごとの最大値をまとめる */
export function expressionRange(
  neutralSamples: readonly FrameSample[],
  expressionSamples: Readonly<Record<string, readonly FrameSample[]>>,
): ExpressionRange {
  const neutral = Object.fromEntries(Object.entries(blendshapeStats(neutralSamples)).map(([k, s]) => [k, s.mean]));
  const peaks = Object.fromEntries(
    Object.entries(expressionSamples).map(([stepId, samples]) => [
      stepId,
      Object.fromEntries(Object.entries(blendshapeStats(samples)).map(([k, s]) => [k, s.max])),
    ]),
  );
  return { neutral, peaks };
}
