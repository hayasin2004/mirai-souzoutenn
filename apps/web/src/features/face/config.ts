/**
 * 顔の取り込みに関するしきい値と切り出しの設定。ここだけ直せば判定が変わる。
 *
 * 判定は 3 段階。各項目に「合格ライン(pass)」と「不合格ライン(fail)」があり、その間が「注意」。
 *   - max 型（小さいほど良い）: 値 <= pass → 合格 / 値 <= fail → 注意 / それ以外 → 不合格
 *   - min 型（大きいほど良い）: 値 >= pass → 合格 / 値 >= fail → 注意 / それ以外 → 不合格
 *   - range 型: [passMin, passMax] → 合格 / [failMin, failMax] → 注意 / それ以外 → 不合格
 * 注意の幅をなくしたいときは pass と fail を同じ値にする。
 */

export type MaxThreshold = { pass: number; fail: number };
export type MinThreshold = { pass: number; fail: number };
export type RangeThreshold = { passMin: number; passMax: number; failMin: number; failMax: number };

export type FaceConfig = {
  maxFacesToDetect: number;
  quality: {
    yawDeg: MaxThreshold;
    pitchDeg: MaxThreshold;
    rollDeg: MaxThreshold;
    faceWidthPx: MinThreshold;
    eyeBlink: MaxThreshold;
    jawOpen: MaxThreshold;
    luminance: RangeThreshold;
    sharpness: MinThreshold;
    cropOutside: MaxThreshold;
    bustOutside: MaxThreshold;
  };
  metrics: { size: number; inset: number };
  crop: { outputSize: number; scale: number; centerOffsetY: number; background: string };
  bust: BustConfig;
  capture: CaptureConfig;
};

/** 肩から上の画像（顔を動かす処理の元画像）の切り出し */
export type BustConfig = {
  outputWidth: number;
  outputHeight: number;
  /** 切り出しの高さ = 顔ランドマークの枠の高さ × この倍率。大きいほど肩・胸まで入る */
  heightScale: number;
  /** 顔の枠の上端から切り出しの上端までの余白（顔の高さに対する割合）。髪の分 */
  topMargin: number;
  /** はみ出した部分の色 */
  background: string;
  /** 背景の切り抜き。背景である確からしさを low〜high の間でなめらかに透明にする */
  matte: { backgroundLow: number; backgroundHigh: number };
  /** 切り抜いた人物が画像に占める割合がこれより小さいと「切り抜きに失敗」とみなす */
  minPersonCoverage: number;
};

/** 品質チェックの項目 ID（quality.ts の QUALITY_CHECK_IDS と同じ） */
export type QualityCheckKey =
  | "faceCount"
  | "yaw"
  | "pitch"
  | "roll"
  | "faceSize"
  | "eyesOpen"
  | "mouthClosed"
  | "brightness"
  | "sharpness"
  | "framing"
  | "bustFraming";

/** ブレンドシェイプの条件。names の平均が min 以上 */
export type BlendshapeTarget = { names: string[]; min: number };

/** 顔の向きの目標（度）。本人から見た向きで書く。left=本人の左を向く, up=上を向く */
export type PoseTarget = { direction: "left" | "right" | "up" | "down"; minDeg: number; maxDeg: number };

export type CaptureStep = {
  /** 保存フォルダ名にも使う（英数字と _ のみ） */
  id: string;
  label: string;
  /** 画面に大きく出す案内 */
  instruction: string;
  /** front=正面の基準（展示に使う顔）, pose=角度, expression=表情, free=自然な動き */
  kind: "front" | "pose" | "expression" | "free";
  /** 条件を満たした状態をこの秒数続けたら記録する（free は記録する長さ） */
  holdSec: number;
  pose?: PoseTarget;
  expression?: BlendshapeTarget;
  /** この秒数たっても条件を満たせないとき、コツと「今の最大値で記録」を出す */
  timeoutSec?: number;
  /** 省略できる段階 */
  optional?: boolean;
  /** この段階では判定しない品質チェック（角度を変える段階では yaw/pitch など） */
  skipChecks?: QualityCheckKey[];
};

export type CaptureConfig = {
  /** カメラに求める解像度とフレームレート（実際の値はカメラ次第） */
  camera: { width: number; height: number; frameRate: number };
  /** 録画のビットレート（bps）。細部を残すため高め */
  videoBitsPerSecond: number;
  /** 輝度・ぶれの測定は重いので N フレームに 1 回 */
  metricsEveryNFrames: number;
  /**
   * MediaPipe の顔の向き（pose.ts）と本人から見た向きの対応。
   * yaw が正 = 本人の左を向く、pitch が負 = 上を向く。実機で逆だったらここの符号を反転する。
   */
  poseSign: { yawLeft: 1 | -1; pitchUp: 1 | -1 };
  /** 動きの判定 */
  motion: {
    /** 記録中の頭の回転の速さ（°/秒）。速すぎるとぶれる */
    angularSpeedDegPerSec: MaxThreshold;
    /** 記録中に顔を見失ったフレームの割合 */
    faceLostRatio: MaxThreshold;
    /** 記録中の明るさのゆらぎ（輝度の標準偏差） */
    luminanceStd: MaxThreshold;
  };
  /** まばたきの検出（eyeBlink の大きい方がこれを上回って下回ったら 1 回） */
  blink: { closeAbove: number; openBelow: number };
  steps: CaptureStep[];
};

export const FACE_CONFIG: FaceConfig = {
  /** 検出する顔の最大数（2つ以上写っていることを検出するため 1 より大きくする） */
  maxFacesToDetect: 4,

  quality: {
    /** 顔の向き（度, 絶対値）。yaw=左右, pitch=上下, roll=傾き（roll は切り出しで補正するので緩め） */
    yawDeg: { pass: 10, fail: 15 },
    pitchDeg: { pass: 10, fail: 15 },
    rollDeg: { pass: 20, fail: 30 },

    /** 顔の幅（元画像のピクセル。傾きを補正した後のランドマークの幅） */
    faceWidthPx: { pass: 256, fail: 200 },

    /** 目の閉じ具合（eyeBlinkLeft / eyeBlinkRight の大きい方。0〜1） */
    eyeBlink: { pass: 0.35, fail: 0.55 },

    /** 口の開き（jawOpen。0〜1） */
    jawOpen: { pass: 0.15, fail: 0.3 },

    /** 顔領域の平均輝度（0〜255） */
    luminance: { passMin: 70, passMax: 190, failMin: 45, failMax: 220 },

    /** 顔領域のラプラシアン分散（顔を metricsSize 四方に縮めてから計算。大きいほどくっきり） */
    sharpness: { pass: 60, fail: 25 },

    /** 切り出し範囲のうち元画像の外にはみ出した割合（0〜1）。顔が端に寄りすぎていないか */
    cropOutside: { pass: 0.02, fail: 1 },

    /** 肩から上の切り出しのうち元画像の外にはみ出した割合（0〜1）。肩まで写っているか */
    bustOutside: { pass: 0.05, fail: 1 },
  },

  metrics: {
    /** 輝度・ぶれを測るとき、顔の領域をこの大きさの正方形に縮める */
    size: 256,
    /** 顔の枠の内側だけを測る（背景や髪を除くため）。枠の幅・高さに対する割合 */
    inset: 0.15,
  },

  crop: {
    /** 出力する正方形の一辺（px） */
    outputSize: 512,
    /** 正方形の一辺 = 顔ランドマークの枠（幅と高さの大きい方）× この倍率。大きいほど余白が増える */
    scale: 2.0,
    /** 切り出しの中心を顔の中心からずらす量（顔の高さに対する割合。負で上、正で下） */
    centerOffsetY: 0.02,
    /** はみ出した部分の塗りつぶし色 */
    background: "#000000",
  },

  bust: {
    outputWidth: 1024,
    outputHeight: 1024,
    heightScale: 3.2,
    topMargin: 0.6,
    background: "#000000",
    matte: { backgroundLow: 0.3, backgroundHigh: 0.7 },
    minPersonCoverage: 0.12,
  },

  capture: {
    camera: { width: 1920, height: 1080, frameRate: 30 },
    videoBitsPerSecond: 8_000_000,
    metricsEveryNFrames: 3,
    poseSign: { yawLeft: 1, pitchUp: -1 },
    motion: {
      angularSpeedDegPerSec: { pass: 25, fail: 60 },
      faceLostRatio: { pass: 0.05, fail: 0.3 },
      luminanceStd: { pass: 6, fail: 15 },
    },
    blink: { closeAbove: 0.5, openBelow: 0.3 },
    steps: [
      {
        id: "front",
        label: "正面・真顔",
        instruction: "カメラのレンズを見て、真顔のまま止まってください",
        kind: "front",
        holdSec: 2,
        timeoutSec: 20,
      },
      {
        id: "pose_left",
        label: "左を向く",
        instruction: "ゆっくり左を向いて、止まってください",
        kind: "pose",
        holdSec: 1,
        pose: { direction: "left", minDeg: 15, maxDeg: 30 },
        timeoutSec: 15,
        skipChecks: ["yaw", "framing"],
      },
      {
        id: "pose_right",
        label: "右を向く",
        instruction: "ゆっくり右を向いて、止まってください",
        kind: "pose",
        holdSec: 1,
        pose: { direction: "right", minDeg: 15, maxDeg: 30 },
        timeoutSec: 15,
        skipChecks: ["yaw", "framing"],
      },
      {
        id: "pose_up",
        label: "上を向く",
        instruction: "あごを少し上げて、止まってください",
        kind: "pose",
        holdSec: 1,
        pose: { direction: "up", minDeg: 10, maxDeg: 25 },
        timeoutSec: 15,
        skipChecks: ["pitch", "framing"],
      },
      {
        id: "pose_down",
        label: "下を向く",
        instruction: "あごを少し引いて、止まってください",
        kind: "pose",
        holdSec: 1,
        pose: { direction: "down", minDeg: 10, maxDeg: 25 },
        timeoutSec: 15,
        skipChecks: ["pitch", "eyesOpen", "framing"],
      },
      {
        id: "expr_smile",
        label: "笑顔",
        instruction: "にっこり笑ってください",
        kind: "expression",
        holdSec: 1,
        expression: { names: ["mouthSmileLeft", "mouthSmileRight"], min: 0.5 },
        timeoutSec: 12,
        skipChecks: ["eyesOpen", "mouthClosed"],
      },
      {
        id: "expr_a",
        label: "「あ」の口",
        instruction: "口を大きく「あー」と開けてください",
        kind: "expression",
        holdSec: 1,
        expression: { names: ["jawOpen"], min: 0.45 },
        timeoutSec: 12,
        skipChecks: ["mouthClosed"],
      },
      {
        id: "expr_u",
        label: "「う」の口",
        instruction: "口をすぼめて「うー」としてください",
        kind: "expression",
        holdSec: 1,
        expression: { names: ["mouthPucker"], min: 0.5 },
        timeoutSec: 12,
        skipChecks: ["mouthClosed"],
      },
      {
        id: "expr_brow",
        label: "眉を上げる",
        instruction: "眉をぐっと上げてください",
        kind: "expression",
        holdSec: 1,
        expression: { names: ["browInnerUp"], min: 0.5 },
        timeoutSec: 12,
        skipChecks: ["eyesOpen", "mouthClosed"],
      },
      {
        id: "free",
        label: "自然な動き",
        instruction: "話しかけるように、自然に 10 秒動いてください",
        kind: "free",
        holdSec: 10,
        optional: true,
        skipChecks: ["yaw", "pitch", "roll", "eyesOpen", "mouthClosed", "framing"],
      },
    ],
  },
};
