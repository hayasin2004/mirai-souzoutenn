import {
  FACE_CONFIG,
  type FaceConfig,
  type MaxThreshold,
  type MinThreshold,
  type QualityCheckKey,
  type RangeThreshold,
} from "./config";
import type { HeadPose } from "./pose";

export type QualityLevel = "pass" | "warn" | "fail";
/** skip は「前の項目が不合格で測れなかった」 */
export type CheckLevel = QualityLevel | "skip";

export const QUALITY_CHECK_IDS = [
  "faceCount",
  "yaw",
  "pitch",
  "roll",
  "faceSize",
  "eyesOpen",
  "mouthClosed",
  "brightness",
  "sharpness",
  "framing",
  "bustFraming",
  // 動画の時間の流れで判定する項目（capture/temporal.ts）
  "motion",
  "faceLost",
  "lightFlicker",
] as const;
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

// config.ts の QualityCheckKey（skipChecks に書ける項目）がここに含まれていることを型で確かめる
const _knownIds: QualityCheckKey extends QualityCheckId ? true : never = true;
void _knownIds;

export type QualityCheck = {
  id: QualityCheckId;
  label: string;
  level: CheckLevel;
  /** 測った値（表示用）。測れなかったときは null */
  value: number | null;
  unit: string;
  /** 合否の目安（表示用） */
  criterion: string;
  /** 注意・不合格のときの撮り直しのコツ */
  tip: string | null;
};

export type QualityReport = {
  status: QualityLevel;
  checks: QualityCheck[];
};

/** 品質チェックに渡す測定値。顔が 1 つでないときは顔ごとの値は null でよい */
export type QualityInput = {
  faceCount: number;
  pose: HeadPose | null;
  faceWidthPx: number | null;
  blendshapes: Readonly<Record<string, number>> | null;
  meanLuminance: number | null;
  laplacianVariance: number | null;
  cropOutsideRatio: number | null;
  /** 肩から上の切り出しのはみ出し割合。undefined なら判定しない（一覧にも出さない） */
  bustOutsideRatio?: number | null;
};

export function gradeMax(value: number, t: MaxThreshold): QualityLevel {
  if (value <= t.pass) return "pass";
  if (value <= t.fail) return "warn";
  return "fail";
}

export function gradeMin(value: number, t: MinThreshold): QualityLevel {
  if (value >= t.pass) return "pass";
  if (value >= t.fail) return "warn";
  return "fail";
}

export function gradeRange(value: number, t: RangeThreshold): QualityLevel {
  if (value >= t.passMin && value <= t.passMax) return "pass";
  if (value >= t.failMin && value <= t.failMax) return "warn";
  return "fail";
}

export function overallStatus(checks: readonly Pick<QualityCheck, "level">[]): QualityLevel {
  if (checks.some((c) => c.level === "fail")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

const fmt = (n: number, digits = 0) => n.toFixed(digits);

export type EvaluateOptions = {
  /** 判定しない項目（角度や表情を変える段階で使う）。結果の一覧からも外す */
  skip?: readonly QualityCheckId[];
};

/** 測定値をもとに、項目ごとの判定と撮り直しのコツを返す */
export function evaluateQuality(
  input: QualityInput,
  config: FaceConfig["quality"] = FACE_CONFIG.quality,
  options: EvaluateOptions = {},
): QualityReport {
  const all = evaluateAll(input, config);
  const skip = new Set(options.skip ?? []);
  const checks = all.filter((c) => !skip.has(c.id));
  return { status: overallStatus(checks), checks };
}

function evaluateAll(input: QualityInput, config: FaceConfig["quality"]): QualityCheck[] {
  const checks: QualityCheck[] = [];
  const add = (
    id: QualityCheckId,
    label: string,
    value: number | null,
    unit: string,
    criterion: string,
    grade: (v: number) => QualityLevel,
    tip: (v: number) => string,
  ) => {
    if (value === null || !Number.isFinite(value)) {
      checks.push({ id, label, level: "skip", value: null, unit, criterion, tip: null });
      return;
    }
    const level = grade(value);
    checks.push({ id, label, level, value, unit, criterion, tip: level === "pass" ? null : tip(value) });
  };

  // 1. 顔の数
  const faceLevel: QualityLevel = input.faceCount === 1 ? "pass" : "fail";
  checks.push({
    id: "faceCount",
    label: "写っている顔の数",
    level: faceLevel,
    value: input.faceCount,
    unit: "人",
    criterion: "ちょうど 1 人",
    tip:
      input.faceCount === 0
        ? "顔が見つかりませんでした。顔全体がはっきり写るように、正面から撮ってください。"
        : input.faceCount > 1
          ? "複数の顔が写っています。本人だけが写るように撮るか、ほかの人が写らないようにトリミングしてください。"
          : null,
  });

  const single = input.faceCount === 1;
  const pose = single ? input.pose : null;
  const bs = single ? input.blendshapes : null;
  const v = <T,>(x: T | null) => (single ? x : null);

  // 2. 顔の向き
  add(
    "yaw",
    "左右の向き",
    pose ? Math.abs(pose.yaw) : null,
    "°",
    `±${config.yawDeg.pass}° 以内`,
    (x) => gradeMax(x, config.yawDeg),
    () => "顔が横を向いています。カメラのレンズをまっすぐ見て、体ごと正面に向けてください。",
  );
  add(
    "pitch",
    "上下の向き",
    pose ? Math.abs(pose.pitch) : null,
    "°",
    `±${config.pitchDeg.pass}° 以内`,
    (x) => gradeMax(x, config.pitchDeg),
    () => "顔が上か下を向いています。カメラを目の高さに合わせ、あごを引きすぎないようにしてください。",
  );
  add(
    "roll",
    "顔の傾き",
    pose ? Math.abs(pose.roll) : null,
    "°",
    `±${config.rollDeg.pass}° 以内（自動で補正）`,
    (x) => gradeMax(x, config.rollDeg),
    () => "首が大きく傾いています。頭をまっすぐにして撮ってください。",
  );

  // 3. 顔の大きさ
  add(
    "faceSize",
    "顔の大きさ",
    v(input.faceWidthPx),
    "px",
    `幅 ${config.faceWidthPx.pass}px 以上`,
    (x) => gradeMin(x, config.faceWidthPx),
    () => "顔が小さく写っています。もう少し近づくか、解像度の高い設定で撮ってください（デジタルズームは使わない）。",
  );

  // 4. 目・口
  const blink = bs ? Math.max(bs["eyeBlinkLeft"] ?? 0, bs["eyeBlinkRight"] ?? 0) : null;
  add(
    "eyesOpen",
    "目の開き",
    blink,
    "",
    `閉じ度 ${config.eyeBlink.pass} 以下`,
    (x) => gradeMax(x, config.eyeBlink),
    () => "目が閉じているか、細くなっています。まばたきの直後を避け、目を自然に開いて撮ってください。",
  );
  add(
    "mouthClosed",
    "口の閉じ",
    bs ? (bs["jawOpen"] ?? 0) : null,
    "",
    `開き ${config.jawOpen.pass} 以下`,
    (x) => gradeMax(x, config.jawOpen),
    () => "口が開いています。口を軽く閉じた、自然な表情で撮ってください。",
  );

  // 5. 明るさ
  add(
    "brightness",
    "明るさ",
    v(input.meanLuminance),
    "",
    `${config.luminance.passMin}〜${config.luminance.passMax}`,
    (x) => gradeRange(x, config.luminance),
    (x) =>
      x < config.luminance.passMin
        ? "顔が暗く写っています。窓の方を向くか、正面から照明を当ててください。逆光は避けてください。"
        : "顔が明るすぎて白飛びしています。直射日光やフラッシュを避け、やわらかい光の場所で撮ってください。",
  );

  // 6. ぶれ
  add(
    "sharpness",
    "くっきりさ",
    v(input.laplacianVariance),
    "",
    `${config.sharpness.pass} 以上`,
    (x) => gradeMin(x, config.sharpness),
    () => "写真がぶれているか、ピントが合っていません。カメラを固定し、顔をタップしてピントを合わせてから撮ってください。",
  );

  // 7. 切り出し範囲
  add(
    "framing",
    "余白",
    v(input.cropOutsideRatio === null ? null : input.cropOutsideRatio * 100),
    "%",
    `はみ出し ${fmt(config.cropOutside.pass * 100)}% 以下`,
    (x) => gradeMax(x / 100, config.cropOutside),
    () => "顔が写真の端に寄っています。頭の上と首まで入るように、少し離れて顔を中央にして撮ってください。",
  );

  // 8. 肩から上の切り出し（顔を動かす処理の元画像）
  if (input.bustOutsideRatio !== undefined) {
    add(
      "bustFraming",
      "肩まで写っているか",
      v(input.bustOutsideRatio === null ? null : input.bustOutsideRatio * 100),
      "%",
      `はみ出し ${fmt(config.bustOutside.pass * 100)}% 以下`,
      (x) => gradeMax(x / 100, config.bustOutside),
      () => "肩が画面に入りきっていません。カメラから少し離れて、肩から上が画面の中央に入るようにしてください。",
    );
  }

  return checks;
}
